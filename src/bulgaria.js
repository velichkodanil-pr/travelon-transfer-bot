// Bulgaria + Eline workflow.
// For Confirmed/Confirmed Print Bulgaria bookings (created >= configured date)
// whose Transport provider is "E.Line Tour":
//   1. read the tourist phone from the two comment fields;
//   2. else from the booking chat (agent reply);
//   3. if found -> write it into BOTH comment fields (when taken from chat) and
//      into the Eline portal (one phone per passenger);
//   4. if nowhere -> ask the agent; next day at 12:00 (Kyiv) send ONE reminder;
//      keep re-checking until the phone arrives, then act and stop.
// DRY_RUN: detects + logs intended actions, writes/sends nothing.
import { config, BG_ASK_PATTERNS, BG_REMINDER_PATTERNS } from './config.js';
import { log } from './logger.js';
import { extractPhones, extractTouristPhones } from './phone.js';
import { ElineClient } from './eline.js';
import { getWatch, setWatch } from './store.js';

const ELINE_REF_RE = /E\.?\s*Line\s*Tour\s*-\s*(\d+)/i;
const DASH = '-';

function ddmmyyyyToISO(d) {
  const m = d && d.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
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

function parseBulgariaRow(row) {
  const flat = row.text || '';
  const idM = flat.match(/\b(\d{5})\b/);
  const dateM = flat.match(/(\d{2}\.\d{2}\.\d{4})/);
  if (!idM || !dateM) return null;
  if (!new RegExp(config.bulgaria.country, 'i').test(flat)) return null;
  const elineM = flat.match(ELINE_REF_RE);
  if (!elineM) return null;
  if (!row.status || !config.bulgaria.statuses.includes(row.status)) return null;
  const iso = ddmmyyyyToISO(dateM[1]);
  if (!iso || iso < config.bulgaria.createdFromISO) return null;
  return { id: idM[1], elineNum: elineM[1], status: row.status, dateISO: iso };
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
  };
  if (!config.bulgaria.enabled) return summary;

  // 1) Scan the list for Bulgaria + Eline + Confirmed candidates created >= cutoff.
  await travelon.openRequests();
  await travelon.clearCheckInDates().catch(() => {});
  await travelon.applyFilter().catch(() => {});

  const candidates = [];
  const seen = new Set();
  for (let page = 0; page < config.bulgaria.maxListPages; page++) {
    const rows = await travelon.scanRows();
    if (!rows.length) break;
    for (const r of rows) {
      const c = parseBulgariaRow(r);
      if (c && !seen.has(c.id)) {
        seen.add(c.id);
        candidates.push(c);
      }
    }
    // Rows are newest-first; stop once the page's oldest row predates the cutoff.
    const isoDates = rows
      .map((r) => {
        const m = (r.text || '').match(/(\d{2}\.\d{2}\.\d{4})/);
        return m ? ddmmyyyyToISO(m[1]) : null;
      })
      .filter(Boolean);
    const oldest = isoDates.length ? isoDates[isoDates.length - 1] : null;
    if (oldest && oldest < config.bulgaria.createdFromISO) break;
    if (!(await travelon.goToNextPage())) break;
  }
  summary.matched = candidates.map((c) => `${c.id}/#${c.elineNum}`);
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
          continue;
        }

        // (a) phone already in the comment fields?
        await travelon.openEdit(c.id);
        const comments = await travelon.readComments();
        let phones = extractPhones(`${comments.user} ${comments.admin}`);
        if (phones.length) {
          await writeToEline(c, phones, summary, ensureEline);
          await persist(c.id, { doneAt: new Date().toISOString(), phones, source: 'comments' });
          continue;
        }

        // (b) phone in the chat (agent reply)?
        await travelon.openChat(c.id);
        const chatText = await travelon.readChatText();
        phones = extractTouristPhones(chatText);
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
          await writeToEline(c, phones, summary, ensureEline);
          await persist(c.id, { doneAt: new Date().toISOString(), phones, source: 'chat' });
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
        } else {
          summary.waiting.push(c.id);
        }
        await travelon.closeChat(c.id).catch(() => {});
      } catch (err) {
        summary.errors.push(`${c.id}: ${err.message}`);
        log.error(`[BG] booking ${c.id} failed:`, err.message);
        await travelon.screenshot(`bg-${c.id}-error`);
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
