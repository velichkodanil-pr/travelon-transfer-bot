// Bulgaria + Eline workflow.
// For Confirmed/Confirmed Print Bulgaria bookings (created >= configured date)
// whose Transport provider is "E.Line Tour":
// 1. read the tourist phone from the two comment fields;
// 2. else from the booking chat (agent reply);
// 3. if found -> write it into BOTH comment fields (when taken from chat) and
//    into the Eline portal (one phone per passenger);
// 4. if nowhere -> ask the agent; next day at 12:00 (Kyiv) send ONE reminder;
//    keep re-checking until the phone arrives, then act and stop.
// DRY_RUN: detects + logs intended actions, writes/sends nothing.
import { config, BG_ASK_PATTERNS, BG_REMINDER_PATTERNS } from './config.js';
import { log } from './logger.js';
import { extractPhones } from './phone.js';
import { ElineClient } from './eline.js';
import { getWatch, setWatch } from './store.js';

const ELINE_REF_RE = /E\.?\s*Line\s*Tour\s*-\s*(\d+)/i;
const DASH = '-';

function ddmmyyyyToISO(d) {
  const m = d && d.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
// Earliest CHECK-IN date a Bulgaria booking may have to be in scope: today's date
// in `tz` plus `days` days (1 => tomorrow). Returns YYYY-MM-DD.
function checkinCutoffISO(tz, days = 1) {
  const todayYMD = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const base = new Date(`${todayYMD}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}
function ymdInTz(date, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
function hourInTz(date, tz) {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(date)
  );
}
// Reminder is due the day AFTER we asked, from 12:00 local time onward.
function shouldRemindNow(askedAtISO) {
  if (!askedAtISO) return false;
  const tz = config.tz;
  const today = ymdInTz(new Date(), tz);
  const askDay = ymdInTz(new Date(askedAtISO), tz);
  if (today <= askDay) return false;
  return hourInTz(new Date(), tz) >= 12;
}

// Parse a list row for a given transfer supplier. Keeps Bulgaria bookings of the
// target statuses whose CHECK-IN date (column 10) is on/after `checkinFrom`.
// Booking/creation date is intentionally ignored.
function parseBulgariaRow(row, supplier, checkinFrom) {
  const flat = row.text || '';
  const idM = flat.match(/\b(\d{5})\b/);
  if (!idM) return null;
  if (!new RegExp(config.bulgaria.country, 'i').test(flat)) return null;
  if (!row.status || !config.bulgaria.statuses.includes(row.status)) return null;
  const ci = ddmmyyyyToISO(row.checkin);
  if (!ci || ci < checkinFrom) return null;
  // E.Line bookings need their Eline reference (to update the portal); others don't.
  let elineNum = null;
  let supplierRef = null;
  if (supplier.writeToEline) {
    const m = flat.match(ELINE_REF_RE);
    if (!m) return null;
    elineNum = m[1];
    supplierRef = m[1];
  } else {
    const esc = supplier.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = flat.match(new RegExp(esc + '\\s*-\\s*(\\d+)', 'i'));
    supplierRef = m ? m[1] : null;
  }
  return {
    id: idM[1],
    supplier: supplier.name,
    writeToEline: supplier.writeToEline,
    elineNum,
    supplierRef,
    status: row.status,
    checkinISO: ci,
    bookingDateISO: ddmmyyyyToISO(row.bookingDate) || '',
  };
}

async function writeToEline(booking, phones, summary, ensureEline) {
  if (!config.eline.email || !config.eline.password) {
    summary.errors.push(`${booking.id}: ELINE creds missing, portal step skipped`);
    log.warn(`[BG] ${booking.id}: Eline creds not set; cannot write portal #${booking.elineNum}.`);
    return;
  }
  const eline = await ensureEline();
  await eline.openBooking(booking.elineNum);
  const res = await eline.writePassengerPhones(phones, { dryRun: config.dryRun });
  const verb = config.dryRun ? 'WOULD set' : 'set';
  log.info(
    `[BG] ${booking.id} Eline#${booking.elineNum}: ${verb} ${res.count} phone field(s) -> [${res.plan.join(', ')}]`
  );
  summary.eline.push(
    `${booking.id}->#${booking.elineNum}[${res.plan.join(',')}]${res.wrote ? '' : ' (dry)'}`
  );
}

export async function runBulgaria(travelon) {
  const summary = {
    dryRun: config.dryRun,
    matched: [],
    eline: [],
    comments: [],
    asked: [],
    reminded: [],
    waiting: [],
    skippedDone: [],
    errors: [],
    rows: [], // per-booking rows for the Google Sheet report
  };
  if (!config.bulgaria.enabled) return summary;

  // Builds a report row for a candidate, with sensible blank defaults.
  const mkRow = (c, o = {}) => ({
    bookingId: c.id,
    elineRef: c.supplierRef || c.elineNum || '',
    country: config.bulgaria.country,
    bookingDate: c.bookingDateISO || '',
    checkinDate: c.checkinISO || '',
    phonePresent: '',
    asked: '',
    agentNumber: '',
    writtenInBooking: '',
    writtenInEline: '',
    status: '',
    note: '',
    ...o,
  });
  const dryTag = config.dryRun ? 'DRY-RUN' : '';

  // 1) Scan per transfer supplier. For each, filter the TravelON list by supplier
  // (partner_id) + status server-side and CLEAR all date filters, then page the
  // (small) result set keeping Bulgaria bookings whose CHECK-IN is tomorrow or
  // later. Booking/creation date is intentionally NOT filtered.
  const checkinFrom = checkinCutoffISO(config.tz, config.bulgaria.checkinFromDays);
  log.info(`[BG] check-in cutoff (>= ${checkinFrom}); booking date: any`);
  const candidates = [];
  const seen = new Set();
  for (const supplier of config.bulgaria.suppliers) {
    await travelon.applyBulgariaSupplierFilter(supplier.partnerId, config.bulgaria.statusIds);
    let prevFirstId = null;
    let supCount = 0;
    for (let page = 1; page <= config.bulgaria.maxListPages; page++) {
      if (page > 1) {
        await travelon.page
          .goto(`${config.requestsUrl}?page=${page}`, { waitUntil: 'domcontentloaded' })
          .catch(() => {});
        await travelon.page.waitForTimeout(2000);
      }
      const rows = await travelon.scanRows();
      const ids = rows.map((r) => (r.text.match(/\b(\d{5})\b/) || [])[1]).filter(Boolean);
      if (page === 1) {
        const bgRows = rows.filter((r) =>
          new RegExp(config.bulgaria.country, 'i').test(r.text || '')
        );
        const sample = bgRows
          .slice(0, 4)
          .map((r) => `${(r.text.match(/\b(\d{5})\b/) || [])[1]}:${r.checkin || '?'}`);
        log.info(
          `[BG] ${supplier.name}: page1 idRows=${ids.length}, bulgaria=${bgRows.length} [${sample.join(
            ', '
          )}]`
        );
      }
      if (!ids.length) break;
      if (prevFirstId && ids[0] === prevFirstId) break; // same page repeated -> end
      prevFirstId = ids[0];
      for (const r of rows) {
        const c = parseBulgariaRow(r, supplier, checkinFrom);
        if (c && !seen.has(c.id)) {
          seen.add(c.id);
          candidates.push(c);
          supCount += 1;
        }
      }
    }
    log.info(`[BG] ${supplier.name}: ${supCount} candidate(s)`);
  }
  summary.matched = candidates.map(
    (c) => `${c.id}/${c.supplier}${c.elineNum ? `#${c.elineNum}` : ''}`
  );
  log.info(`[BG] Candidates: ${summary.matched.join(', ') || DASH}`);

  // 2) Process each candidate.
  let eline = null;
  const ensureEline = async () => {
    if (!eline) {
      eline = new ElineClient();
      await eline.init();
      await eline.login();
    }
    return eline;
  };
  // Only persist watch state in LIVE mode (so DRY-RUN never pre-marks anything).
  const persist = async (id, patch) => {
    if (!config.dryRun) await setWatch(id, patch);
  };

  try {
    for (const c of candidates) {
      try {
        const w = await getWatch(c.id);
        // In LIVE mode skip bookings we've already completed. In DRY-RUN ignore
        // the store entirely (re-evaluate every cycle, persist nothing).
        if (w?.doneAt && !config.dryRun) {
          summary.skippedDone.push(c.id);
          summary.rows.push(
            mkRow(c, {
              phonePresent: 'так',
              agentNumber: w.phones ? w.phones.join(' ') : '',
              writtenInBooking: 'так',
              writtenInEline: 'так',
              status: 'Зроблено (раніше)',
              note: 'Опрацьовано в попередньому циклі',
            })
          );
          continue;
        }

        // (a) phone already in the comment fields?
        await travelon.openEdit(c.id);
        const comments = await travelon.readComments();
        let phones = extractPhones(`${comments.user} ${comments.admin}`);
        if (phones.length) {
          if (c.writeToEline) await writeToEline(c, phones, summary, ensureEline);
          await persist(c.id, { doneAt: new Date().toISOString(), phones, source: 'comments' });
          summary.rows.push(
            mkRow(c, {
              phonePresent: 'так',
              agentNumber: phones.join(' '),
              writtenInBooking: 'так',
              writtenInEline: c.writeToEline
                ? config.dryRun
                  ? 'ні (вписав би)'
                  : 'так'
                : 'не потрібно',
              status: 'Зроблено',
              note: [dryTag, `телефон уже в коментарях заявки (${c.supplier})`]
                .filter(Boolean)
                .join(' · '),
            })
          );
          continue;
        }

        // (b) phone in the chat? Any number written by the agent in the chat panel
        // counts as the tourist's (per operator guidance — other numbers are not
        // posted there). Read the PANEL only, never the whole page.
        await travelon.openChat(c.id);
        const chatText = await travelon.readChatPanelText();
        phones = extractPhones(chatText);
        if (phones.length) {
          await travelon.closeChat(c.id).catch(() => {});
          await travelon.openEdit(c.id);
          const res = await travelon.appendPhonesToComments(phones, { dryRun: config.dryRun });
          summary.comments.push(`${c.id}${res.saved ? '' : ' (dry)'}`);
          log.info(
            `[BG] ${c.id}: ${config.dryRun ? 'WOULD write' : 'wrote'} phone(s) [${phones.join(
              ', '
            )}] to both comment fields`
          );
          if (c.writeToEline) await writeToEline(c, phones, summary, ensureEline);
          await persist(c.id, { doneAt: new Date().toISOString(), phones, source: 'chat' });
          summary.rows.push(
            mkRow(c, {
              phonePresent: 'так',
              agentNumber: phones.join(' '),
              writtenInBooking: config.dryRun ? 'ні (вписав би)' : 'так',
              writtenInEline: c.writeToEline
                ? config.dryRun
                  ? 'ні (вписав би)'
                  : 'так'
                : 'не потрібно',
              status: 'Зроблено',
              note: [dryTag, `номер із чату агента (${c.supplier})`].filter(Boolean).join(' · '),
            })
          );
          continue;
        }

        // (c) nowhere -> ask / remind
        const asked = BG_ASK_PATTERNS.some((re) => re.test(chatText)) || Boolean(w?.askedAt);
        const reminded =
          BG_REMINDER_PATTERNS.some((re) => re.test(chatText)) || Boolean(w?.remindedAt);

        if (!asked) {
          if (config.dryRun) {
            summary.asked.push(`${c.id} (dry)`);
            log.info(`[BG] ${c.id}: WOULD ask agent for tourist phone.`);
          } else {
            await travelon.sendChatMessage({
              department: config.bulgaria.department,
              subject: config.bulgaria.subject,
              text: config.bulgaria.askText,
            });
            summary.asked.push(c.id);
            log.info(`[BG] ${c.id}: asked agent for tourist phone.`);
          }
          await persist(c.id, { askedAt: new Date().toISOString() });
          summary.rows.push(
            mkRow(c, {
              phonePresent: 'ні',
              asked: config.dryRun ? 'ні (запитав би)' : 'так',
              status: 'Очікує — запит надіслано',
              note: dryTag,
            })
          );
        } else if (!reminded && shouldRemindNow(w?.askedAt)) {
          if (config.dryRun) {
            summary.reminded.push(`${c.id} (dry)`);
            log.info(`[BG] ${c.id}: WOULD send reminder.`);
          } else {
            await travelon.sendChatMessage({
              department: config.bulgaria.department,
              subject: config.bulgaria.subject,
              text: config.bulgaria.reminderText,
            });
            summary.reminded.push(c.id);
            log.info(`[BG] ${c.id}: sent reminder.`);
          }
          await persist(c.id, { remindedAt: new Date().toISOString() });
          summary.rows.push(
            mkRow(c, {
              phonePresent: 'ні',
              asked: config.dryRun ? 'повторно (нагадав би)' : 'повторно',
              status: 'Очікує — нагадування',
              note: dryTag,
            })
          );
        } else {
          summary.waiting.push(c.id);
          summary.rows.push(
            mkRow(c, {
              phonePresent: 'ні',
              asked: 'так',
              status: 'Очікує відповідь агента',
              note: dryTag,
            })
          );
        }
        await travelon.closeChat(c.id).catch(() => {});
      } catch (err) {
        summary.errors.push(`${c.id}: ${err.message}`);
        log.error(`[BG] booking ${c.id} failed:`, err.message);
        await travelon.screenshot(`bg-${c.id}-error`);
        summary.rows.push(mkRow(c, { status: 'Помилка', note: err.message }));
      }
    }
  } finally {
    await eline?.close();
  }

  const lines = [
    `Bulgaria/Eline ${config.dryRun ? '[DRY-RUN]' : '[LIVE]'}`,
    `Matched: ${summary.matched.length} (${summary.matched.join(', ') || DASH})`,
    `Eline writes: ${summary.eline.join(', ') || DASH}`,
    `Comment writes: ${summary.comments.join(', ') || DASH}`,
    `Asked: ${summary.asked.join(', ') || DASH}`,
    `Reminded: ${summary.reminded.join(', ') || DASH}`,
    `Waiting: ${summary.waiting.join(', ') || DASH}`,
    `Already done: ${summary.skippedDone.join(', ') || DASH}`,
    `Errors: ${summary.errors.join(' | ') || DASH}`,
  ];
  log.info('[BG] summary:\n' + lines.join('\n'));
  summary.report = lines.join('\n');
  return summary;
}
