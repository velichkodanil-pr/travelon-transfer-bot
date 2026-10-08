// Insurance + RU/BY-citizen document request.
// For bookings that HAVE insurance (the list row shows an insurance marker) with any
// status EXCEPT Canceled, created within the lookback window, and where at least ONE
// passenger's Nationality is RUSSIA or BELARUS: post a ONE-TIME chat message
// (Department "Бронювання", Subject "Запит документів для громадянина рф/рб" — the
// subject's TEMPLATE auto-fills the body, so we send with an empty text and let the
// template populate). Nationality is only visible on the booking CARD, so we
// pre-filter the list to insurance rows and open only those cards.
// Dedup: local state (data/insDoc.json). Has its OWN dry-run flag
// (config.insuranceRuby.dryRun) so it can observe-only while the rest of the bot is LIVE.
import { config, INSDOC_ASKED_PATTERNS } from './config.js';
import { log } from './logger.js';
import { getInsDoc, setInsDoc } from './store.js';
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
function dateMinusDaysISO(tz, days) {
  const d = new Date(todayISO(tz) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (Number(days) || 0));
  return d.toISOString().slice(0, 10);
}
function ddmmyyyyToISO(s) {
  const m = s && s.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function finish(summary, dry) {
  const lines = [
    `InsDoc ${dry ? '[DRY-RUN]' : '[LIVE]'}`,
    `Insurance candidates: ${summary.matched.length} (${summary.matched.join(', ') || DASH})`,
    `${dry ? 'Would send' : 'Sent'}: ${summary.sent.join(', ') || DASH}`,
    `Already asked in chat: ${(summary.alreadyAsked || []).join(', ') || DASH}`,
    `No RU/BY: ${summary.noRuby.join(', ') || DASH}`,
    `Already checked: ${summary.skippedDone.join(', ') || DASH}`,
    `Errors: ${summary.errors.join(' | ') || DASH}`,
  ];
  summary.report = lines.join('\n');
  log.info('[InsDoc] summary:\n' + summary.report);
  return summary;
}

export async function runInsuranceDoc(travelon) {
  const summary = {
    matched: [],
    sent: [],
    skippedDone: [],
    alreadyAsked: [],
    noRuby: [],
    errors: [],
    rows: [],
  };
  const cfg = config.insuranceRuby;
  if (!cfg.enabled) return summary;

  const dry = cfg.dryRun;
  // The absolute floor (INSDOC_CREATED_FROM) wins over the rolling lookback window.
  const cutoff = /^\d{4}-\d{2}-\d{2}$/.test(cfg.createdFromISO || '')
    ? cfg.createdFromISO
    : dateMinusDaysISO(config.tz, cfg.lookbackDays);
  const insRe = new RegExp(cfg.insuranceRe, 'i');
  const wantNat = cfg.nationalities.map((x) => x.toUpperCase());
  const askedPatterns = cfg.askedRe ? [new RegExp(cfg.askedRe, 'i')] : INSDOC_ASKED_PATTERNS;
  const wantStatuses = (cfg.statuses || []).map((x) =>
    x.toLowerCase().replace(/\s+/g, ' ').trim()
  );
  log.info(
    `[InsDoc] ${dry ? '[DRY-RUN]' : '[LIVE]'} created >= ${cutoff}; nationalities: ${wantNat.join('/')}`
  );

  // 1) Recent bookings, ALL suppliers (partner=''), status != Canceled.
  try {
    await travelon.applyBulgariaSupplierFilter('', cfg.statusIds);
  } catch (err) {
    summary.errors.push(`filter: ${err.message}`);
    log.error('[InsDoc] filter failed:', err.message);
    return finish(summary, dry);
  }

  const seen = new Set();
  const candidates = [];
  // TEMP DIAGNOSTICS: three cycles in a row found 0 candidates — record what the list
  // actually returns and which filter drops the rows, so we can tell "no data yet"
  // from "status labels no longer match".
  const diag = {
    rows: 0,
    noId: 0,
    badStatus: 0,
    older: 0,
    noIns: 0,
    statuses: new Map(),
    dates: new Set(),
  };
  for (let page = 1; page <= cfg.maxListPages; page++) {
    if (stopRequested()) break;
    if (page > 1) {
      await travelon.page
        .goto(`${config.requestsUrl}?page=${page}`, { waitUntil: 'domcontentloaded' })
        .catch(() => {});
      await travelon.page.waitForTimeout(2000);
    }
    const rows = await travelon.scanRows();
    if (!rows.length) break;
    diag.rows += rows.length;
    let older = 0;
    for (const r of rows) {
      const idM = (r.text || '').match(/\b(\d{5})\b/);
      if (!idM) {
        diag.noId += 1;
        continue;
      }
      const id = idM[1];
      // Status guard on top of the server-side filter: ONLY Confirmed / Confirmed Print
      // (Danylo 2026-08-30). Falls back to "anything but Canceled" if the list is empty.
      const st = (r.status || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const stKey = st || '(порожній)';
      diag.statuses.set(stKey, (diag.statuses.get(stKey) || 0) + 1);
      if (r.bookingDate) diag.dates.add(r.bookingDate);
      // The list no longer exposes the status text (scan diag 2026-08-31: status is
      // empty for all 300 rows — scanRows() looks for a "Room status" cell that the site
      // apparently stopped rendering). So enforce the label ONLY when we actually have
      // one; with no text we trust the server-side filter, which already restricts the
      // list to INSDOC_STATUS_IDS = 2,3 (Confirmed / Confirmed Print).
      if (st && (wantStatuses.length ? !wantStatuses.includes(st) : /cancel/i.test(st))) {
        diag.badStatus += 1;
        continue;
      }
      const created = ddmmyyyyToISO(r.bookingDate);
      if (created && created < cutoff) {
        older += 1;
        diag.older += 1;
        continue;
      }
      if (!insRe.test(r.text || '')) {
        diag.noIns += 1;
        continue; // must have insurance
      }
      if (seen.has(id)) continue;
      seen.add(id);
      candidates.push({ id, created: created || '' });
    }
    // List is newest-first: if a whole page predates the cutoff, stop paging.
    if (older >= rows.length) break;
  }
  const topStatuses = [...diag.statuses.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, v]) => `"${k}"×${v}`)
    .join(', ');
  const topDates = [...diag.dates]
    .sort((a, b) => (ddmmyyyyToISO(b) || '').localeCompare(ddmmyyyyToISO(a) || ''))
    .slice(0, 5)
    .join(', ');
  log.info(
    `[InsDoc] scan diag: rows=${diag.rows}, dropped: status=${diag.badStatus}, older=${diag.older}, no-ins=${diag.noIns}, no-id=${diag.noId}; statuses: ${topStatuses || '-'}; newest booking dates: ${topDates || '-'}`
  );

  summary.matched = candidates.map((c) => c.id);
  log.info(
    `[InsDoc] candidates (created >= ${cutoff}, ${wantStatuses.join('/') || 'any status'}): ${
      summary.matched.join(', ') || DASH
    }`
  );

  // 2) Open each candidate's card, check nationality, message if RU/BY present.
  let sends = 0;
  let checks = 0;
  const mkRow = (id, status, nat = '', note = '') => ({
    bookingId: id,
    nationality: nat,
    status,
    note,
  });
  for (const [idx, c] of candidates.entries()) {
    if (stopRequested()) {
      log.warn(`[InsDoc] stop requested — ${candidates.length - idx} booking(s) left for the next cycle.`);
      break;
    }
    try {
      const st = await getInsDoc(c.id);
      if (st && st.checkedAt) {
        summary.skippedDone.push(c.id);
        continue;
      }
      if (checks >= cfg.maxChecksPerRun) {
        log.warn(`[InsDoc] reached maxChecksPerRun=${cfg.maxChecksPerRun}; rest next cycle.`);
        break;
      }
      await travelon.openEdit(c.id);
      checks += 1;
      const nats = await travelon.readNationalities();
      const hit = nats.find((n) => wantNat.includes((n || '').toUpperCase()));
      if (!hit) {
        summary.noRuby.push(c.id);
        if (!dry) await setInsDoc(c.id, { checkedAt: new Date().toISOString(), ruby: false });
        continue;
      }
      // A RU/BY tourist is present. Never ask twice: skip when the chat already holds a
      // documents request (ІПН, посвідка про постійне проживання тощо).
      await travelon.openChat(c.id);
      const chatText = await travelon.readChatPanelText();
      if (askedPatterns.some((re) => re.test(chatText))) {
        summary.alreadyAsked.push(c.id);
        summary.rows.push(mkRow(c.id, 'Вже запитано в чаті', hit));
        log.info(`[InsDoc] ${c.id}: documents already requested in chat — skip.`);
        if (!dry) {
          await setInsDoc(c.id, {
            checkedAt: new Date().toISOString(),
            ruby: true,
            nationality: hit,
            source: 'chat-existing',
          });
        }
        await travelon.closeChat(c.id).catch(() => {});
        continue;
      }
      if (dry) {
        summary.sent.push(`${c.id}(${hit})`);
        summary.rows.push(mkRow(c.id, 'DRY-RUN: надіслав би', hit, 'DRY-RUN'));
        log.info(`[InsDoc] ${c.id}: WOULD send doc-request (nationality ${hit}). [${nats.join(',')}]`);
        await travelon.closeChat(c.id).catch(() => {});
        continue; // do NOT persist in dry-run, so LIVE can pick it up later
      }
      if (sends >= cfg.maxSendsPerRun) {
        log.warn(`[InsDoc] reached maxSendsPerRun=${cfg.maxSendsPerRun}; rest next cycle.`);
        await travelon.closeChat(c.id).catch(() => {});
        break;
      }
      // Subject "Запит документів для громадянина рф/рб" auto-fills its template body,
      // so we pass an empty text and let sendChatMessage send the template.
      await travelon.sendChatMessage({ department: cfg.department, subject: cfg.subject, text: '' });
      await travelon.closeChat(c.id).catch(() => {});
      await setInsDoc(c.id, {
        checkedAt: new Date().toISOString(),
        sentAt: new Date().toISOString(),
        ruby: true,
        nationality: hit,
      });
      sends += 1;
      summary.sent.push(c.id);
      summary.rows.push(mkRow(c.id, 'Надіслано', hit));
      log.info(`[InsDoc] ${c.id}: sent doc-request (nationality ${hit}).`);
    } catch (err) {
      summary.errors.push(`${c.id}: ${err.message}`);
      log.error(`[InsDoc] ${c.id} failed:`, err.message);
      await travelon.screenshot(`insdoc-${c.id}-error`).catch(() => {});
      summary.rows.push(mkRow(c.id, 'Помилка', '', err.message));
    }
  }
  return finish(summary, dry);
}
