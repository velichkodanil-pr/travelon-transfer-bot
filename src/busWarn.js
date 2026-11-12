// Bus-seating warning flow.
// For bookings whose TRANSPORT carrier is one of the configured bus operators
// (Itravel / E.Line Tour / RIKI - A (Bus)), with CHECK-IN today or later and any
// status EXCEPT Canceled: send a ONE-TIME chat message (Department "Бронювання",
// Subject "Попередження автобусній заявці") warning that specific bus seats are
// not guaranteed. Dedup: local state (data/busWarn.json) + in-chat scan.
// DRY_RUN: logs intended sends, sends nothing.
import { config, BUSWARN_TEXT, BUSWARN_PATTERNS } from './config.js';
import { log } from './logger.js';
import { getBusWarn, setBusWarn } from './store.js';
import { stopRequested } from './stop.js';

const DASH = '-';

function todayISO(tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
function todayDDMMYYYY(tz) {
  const [y, m, d] = todayISO(tz).split('-');
  return `${d}.${m}.${y}`;
}
function ddmmyyyyToISO(s) {
  const m = s && s.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
const BW_COUNTRIES = [
  'Болгарія', 'Туреччина', 'Греція', 'Албанія', 'Хорватія', 'Іспанія',
  'Чорногорія', 'Єгипет', 'Кіпр', 'Італія', 'Туніс', 'Грузія', 'Молдова',
];
function countryOf(text) {
  return BW_COUNTRIES.find((c) => new RegExp(c, 'i').test(text || '')) || '';
}

export async function runBusWarn(travelon) {
  const summary = {
    matched: [],
    warned: [],
    alreadyInChat: [],
    skippedDone: [],
    errors: [],
    rows: [], // per-booking rows for the Google Sheet "Автобусні попередження" tab
  };
  if (!config.busWarn.enabled) return summary;

  const tISO = todayISO(config.tz);
  const tDDMM = todayDDMMYYYY(config.tz);
  log.info(`[BusWarn] check-in >= ${tISO}; suppliers: ${config.busWarn.suppliers.map((s) => s.name).join(', ')}`);

  // 1) Scan each bus supplier (server-side: partner_id + statuses + check-in from today).
  const candidates = [];
  const seen = new Set();
  for (const sup of config.busWarn.suppliers) {
    if (stopRequested()) break;
    try {
      await travelon.applyBusFilter(sup.partnerId, config.busWarn.statusIds, tDDMM);
    } catch (err) {
      summary.errors.push(`filter ${sup.name}: ${err.message}`);
      log.error(`[BusWarn] filter ${sup.name} failed:`, err.message);
      continue;
    }
    let prevFirst = null;
    for (let page = 1; page <= config.busWarn.maxListPages; page++) {
      if (page > 1) {
        await travelon.page
          .goto(`${config.requestsUrl}?page=${page}`, { waitUntil: 'domcontentloaded' })
          .catch(() => {});
        await travelon.page.waitForTimeout(2000);
      }
      const rows = await travelon.scanRows();
      if (!rows.length) break;
      const firstId = (rows[0].text.match(/\b(\d{5})\b/) || [])[1] || null;
      if (firstId && firstId === prevFirst) break; // same page repeated -> no more pages
      prevFirst = firstId;
      for (const r of rows) {
        const idM = (r.text || '').match(/\b(\d{5})\b/);
        if (!idM) continue;
        if (r.status && /cancel/i.test(r.status)) continue; // exclude Canceled
        const ci = ddmmyyyyToISO(r.checkin);
        if (!ci || ci < tISO) continue; // check-in today or later
        const dep = ddmmyyyyToISO(r.departure);
        if (dep && dep <= tISO) continue; // виїзд сьогодні або раніше — не чіпаємо
        if (seen.has(idM[1])) continue;
        seen.add(idM[1]);
        candidates.push({ id: idM[1], country: countryOf(r.text), supplier: sup.name, checkin: r.checkin || '', checkinISO: ci });
      }
    }
  }
  summary.matched = candidates.map((c) => `${c.id}(${c.supplier})`);
  log.info(`[BusWarn] Candidates: ${summary.matched.join(', ') || DASH}`);

  // 2) Warn each candidate once (capped per cycle in LIVE mode).
  let sends = 0;
  const bwRow = (c, status, note = '') => ({
    bookingId: c.id,
    country: c.country || '',
    supplier: c.supplier,
    checkinDate: c.checkin || c.checkinISO || '',
    status,
    note,
  });
  for (const [idx, c] of candidates.entries()) {
    if (stopRequested()) {
      summary.interrupted = true;
      log.warn(`[BusWarn] stop requested — ${candidates.length - idx} booking(s) left for the next cycle.`);
      break;
    }
    try {
      const w = await getBusWarn(c.id);
      // Chat feed read once (~0.3 s, no navigation); null = unreadable.
      let feed;
      const readFeed = async () => {
        if (feed === undefined) feed = travelon.readChatTextFast ? await travelon.readChatTextFast(c.id) : null;
        return feed;
      };
      if (w?.warnedAt && !config.dryRun) {
        // GHOST_RECHECK: an earlier "send" may never have reached the chat.
        let ghost = false;
        if (config.ghostRecheck && w.source !== 'chat-existing') {
          const f = await readFeed();
          ghost = f !== null && !BUSWARN_PATTERNS.some((re) => re.test(f));
        }
        if (!ghost) {
          summary.skippedDone.push(c.id);
          summary.rows.push(bwRow(c, 'Надіслано раніше'));
          continue;
        }
        log.info(`[BusWarn] ${c.id}: recorded as sent, but the warning is not in the chat — sending again.`);
      }
      if (!config.dryRun && sends >= config.busWarn.maxSendsPerRun) {
        log.warn(`[BusWarn] reached maxSendsPerRun=${config.busWarn.maxSendsPerRun}; rest next cycle.`);
        break;
      }
      let chatOpen = false;
      let chatText = await readFeed();
      if (chatText === null) {
        await travelon.openChat(c.id);
        chatOpen = true;
        chatText = await travelon.readChatPanelText();
      }
      if (BUSWARN_PATTERNS.some((re) => re.test(chatText))) {
        summary.alreadyInChat.push(c.id);
        summary.rows.push(bwRow(c, 'Вже в чаті'));
        if (!config.dryRun) await setBusWarn(c.id, { warnedAt: new Date().toISOString(), source: 'chat-existing' });
        if (chatOpen) await travelon.closeChat(c.id).catch(() => {});
        continue;
      }
      if (config.dryRun) {
        summary.warned.push(`${c.id} (dry)`);
        log.info(`[BusWarn] ${c.id}: WOULD send bus warning (${c.supplier}).`);
        summary.rows.push(bwRow(c, 'DRY-RUN: надіслав би', 'DRY-RUN'));
      } else {
        if (!chatOpen) {
          await travelon.openChat(c.id);
          chatOpen = true;
        }
        await travelon.sendChatMessage({
          department: config.busWarn.department,
          subject: config.busWarn.subject,
          text: BUSWARN_TEXT,
          bundleId: c.id,
        });
        summary.warned.push(c.id);
        sends += 1;
        await setBusWarn(c.id, { warnedAt: new Date().toISOString(), source: 'sent' });
        log.info(`[BusWarn] ${c.id}: sent bus warning (${c.supplier}).`);
        summary.rows.push(bwRow(c, 'Надіслано'));
      }
      if (chatOpen) await travelon.closeChat(c.id).catch(() => {});
    } catch (err) {
      summary.errors.push(`${c.id}: ${err.message}`);
      log.error(`[BusWarn] ${c.id} failed:`, err.message);
      await travelon.screenshot(`buswarn-${c.id}-error`);
      summary.rows.push(bwRow(c, 'Помилка', err.message));
    }
  }

  const lines = [
    `BusWarn ${config.dryRun ? '[DRY-RUN]' : '[LIVE]'}`,
    `Matched: ${candidates.length} (${summary.matched.join(', ') || DASH})`,
    `Sent: ${summary.warned.join(', ') || DASH}`,
    `Already in chat: ${summary.alreadyInChat.join(', ') || DASH}`,
    `Already done: ${summary.skippedDone.join(', ') || DASH}`,
    `Errors: ${summary.errors.join(' | ') || DASH}`,
  ];
  log.info('[BusWarn] summary:\n' + lines.join('\n'));
  summary.report = lines.join('\n');
  return summary;
}
