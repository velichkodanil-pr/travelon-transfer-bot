// Bulgaria + Eline + Itravel workflow.
// For Confirmed/Confirmed Print Bulgaria bookings (check-in tomorrow+) of the
// configured transfer suppliers:
// 1. read the tourist phone from the two comment fields;
// 2. else from the booking chat (agent reply);
// 3. if found -> write it into BOTH comment fields (when taken from chat);
//    for E.Line -> also into the Eline portal; for Itravel -> also send it into
//    the Itravel client-cabinet booking thread (one message, deduped);
// 4. if nowhere -> ask the agent; next day at 12:00 (Kyiv) send ONE reminder;
//    keep re-checking until the phone arrives, then act and stop.
// DRY_RUN: detects + logs intended actions, writes/sends nothing.
import { config, BG_ASK_PATTERNS, BG_REMINDER_PATTERNS } from './config.js';
import { log } from './logger.js';
import { extractPhones, normalizeUaPhone, isUsablePhone } from './phone.js';
import { ElineClient } from './eline.js';
import { ItravelClient } from './itravel.js';
import { getWatch, setWatch } from './store.js';
import { stopRequested } from './stop.js';

const ELINE_REF_RE = /E\.?\s*Line\s*Tour\s*-\s*(\d+)/i;
const DASH = '-';
// A field value counts as a real phone if it has >= 9 digits (robust to any
// portal formatting like "+380 (67) 594-18-21").
// A field value counts as a phone ONLY if it is a valid UA number (380/80/0
// formats). Prevents non-phones (e.g. a wrong 13-digit value in the Eline
// portal field) from being mistaken for a tourist phone.
// A date read as a number ("05.09.2026 22:…" -> +380509202622) is not a phone either.
const looksLikePhone = (v) => isUsablePhone(v);
// Санітайзер для ЗБЕРЕЖЕНИХ номерів: у стані бота можуть лишатися сміттєві
// значення, записані ще до суворої валідації (напр. 2283019842534) або дати,
// прочитані як номер (напр. +380707202712 у 72411). Ніколи не показуємо їх у
// звіті і не шлемо постачальнику.
const validPhones = (arr) => (arr || []).filter((p) => isUsablePhone(p));

// Shown in the report while an Itravel booking has the tourist phone but its row
// in TravelON does not carry the Itravel order number yet (we need it to open
// the order in the Itravel cabinet). Not an error: nothing to do until it appears.
const WAIT_REF_STATUS = 'Очікує № замовлення Itravel';
const WAIT_REF_NOTE =
  'телефон є; постачальнику напишемо, щойно в заявці з’явиться номер замовлення Itravel';

class ElineTimeout extends Error {}

function ddmmyyyyToISO(d) {
  const m = d && d.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
function addDaysISO(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function isoToDDMMYYYY(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
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
// Країни лише для МІТКИ у звіті (не фільтр). Розширений список поширених
// напрямків; якщо не знайдено — мітка порожня, заявку все одно обробляємо.
const ALL_CONTACT_COUNTRIES = [
  'Болгарія', 'Туреччина', 'Греція', 'Албанія', 'Хорватія', 'Іспанія',
  'Чорногорія', 'Єгипет', 'Кіпр', 'Італія', 'Туніс', 'Грузія', 'Молдова',
  'Румунія', 'Сербія', 'Північна Македонія',
];

function parseBulgariaRow(row, supplier, checkinFrom) {
  const flat = row.text || '';
  const idM = flat.match(/\b(\d{5})\b/);
  if (!idM) return null;
  // Країну визначаємо ЛИШЕ як мітку для звіту — за нею НЕ фільтруємо: контакт
  // збираємо для автобусних заявок цих перевізників у БУДЬ-ЯКІЙ країні (як попередження).
  const country = ALL_CONTACT_COUNTRIES.find((c) => new RegExp(c, 'i').test(flat)) || '';
  // Звірка статусу рядка — стійка до регістру/зайвих пробілів ("In Work"/"In work").
  const _st = (row.status || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const _allowed = config.bulgaria.statuses.map((x) => x.toLowerCase().replace(/\s+/g, ' ').trim());
  // The list STOPPED rendering the status label (site change, ~28.08.2026) — it is
  // empty for every row. Requiring it here silently dropped every booking and
  // killed the whole contact flow. Enforce the label only when it is actually
  // present; otherwise trust the server-side status filter (statusIds 2,3,6,1).
  if (_st && !_allowed.includes(_st)) return null;
  const ci = ddmmyyyyToISO(row.checkin);
  if (!ci || ci < checkinFrom) return null;
  // Не чіпаємо заявку, якщо день ВИЇЗДУ (початок туру) = сьогодні або вже минув.
  const dep = ddmmyyyyToISO(row.departure);
  if (dep && dep <= checkinCutoffISO(config.tz, 0)) return null;
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
    country,
    supplier: supplier.name,
    writeToEline: supplier.writeToEline,
    messageItravel: supplier.messageItravel || false,
    elineNum,
    supplierRef,
    status: row.status,
    checkinISO: ci,
    bookingDateISO: ddmmyyyyToISO(row.bookingDate) || '',
  };
}

// Returns TRUE only when the phone is provably in the Eline portal (already
// present, or written AND verified by re-reading the saved form). Callers must
// not mark a booking done on a false result — it will be retried next cycle.
async function writeToEline(booking, phones, summary, ensureEline, agentPhone) {
  if (!config.eline.email || !config.eline.password) {
    summary.errors.push(`${booking.id}: ELINE creds missing, portal step skipped`);
    log.warn(`[BG] ${booking.id}: Eline creds not set; cannot write portal #${booking.elineNum}.`);
    return false;
  }
  const eline = await ensureEline();
  await eline.openBooking(booking.elineNum);
  // Already filled in the portal? Leave it — never overwrite an existing number.
  const existing = (await eline.readPassengerPhones())
    .filter(looksLikePhone)
    .filter((p) => normalizeUaPhone(p) !== agentPhone);
  if (existing.length) {
    log.info(
      `[BG] ${booking.id} Eline#${booking.elineNum}: phone already in portal [${existing.join(
        ', '
      )}] — not rewriting.`
    );
    summary.eline.push(`${booking.id}->#${booking.elineNum} already-present`);
    return true;
  }
  const res = await eline.writePassengerPhones(phones, { dryRun: config.dryRun });
  if (config.dryRun) {
    log.info(
      `[BG] ${booking.id} Eline#${booking.elineNum}: WOULD set ${res.count} phone field(s) -> [${res.plan.join(', ')}]`
    );
    summary.eline.push(`${booking.id}->#${booking.elineNum}[${res.plan.join(',')}] (dry)`);
    return false; // nothing actually written in dry-run
  }
  if (!res.verified) {
    const why = res.error || `after save the portal shows [${(res.present || []).join(', ') || '—'}]`;
    log.error(
      `[BG] ${booking.id} Eline#${booking.elineNum}: WRITE NOT CONFIRMED (${why}) — will retry next cycle.`
    );
    summary.errors.push(`${booking.id}: Eline write NOT confirmed (${why})`);
    summary.eline.push(`${booking.id}->#${booking.elineNum} FAILED`);
    return false;
  }
  log.info(
    `[BG] ${booking.id} Eline#${booking.elineNum}: set ${res.count} phone field(s) -> [${res.plan.join(', ')}] — verified in portal.`
  );
  summary.eline.push(`${booking.id}->#${booking.elineNum}[${res.plan.join(',')}] ok`);
  return true;
}

// deps are injectable for tests (fake portal clients); production uses the defaults.
// Telegram caps a message at 4096 chars, and a dead cabinet can hold 90+ bookings:
// keep the head of the list and count the rest.
function idList(ids, max = 15) {
  return ids.length <= max ? ids.join(', ') : `${ids.slice(0, max).join(', ')} … +${ids.length - max}`;
}

export async function runBulgaria(
  travelon,
  { makeEline = () => new ElineClient(), makeItravel = () => new ItravelClient() } = {}
) {
  const summary = {
    dryRun: config.dryRun,
    matched: [],
    eline: [],
    itravel: [],
    comments: [],
    asked: [],
    reminded: [],
    waiting: [],
    waitingRef: [], // Itravel: phone known, order number not in the booking yet
    itravelSkipped: [], // Itravel cabinet down this cycle -> booking left for the next one
    itravelDown: null, // why the cabinet was skipped (login failure message)
    skippedDone: [],
    ghosts: [], // stored as asked, but the ask is not in the chat (GHOST_RECHECK)
    errors: [],
    interrupted: false,
    rows: [], // per-booking rows for the Google Sheet report
  };
  if (!config.bulgaria.enabled) return summary;

  // Builds a report row for a candidate, with sensible blank defaults.
  const mkRow = (c, o = {}) => ({
    bookingId: c.id,
    elineRef: c.supplierRef || c.elineNum || '',
    country: c.country || '',
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

  // 1) Scan per transfer supplier (filter the TravelON list by partner_id + status
  // server-side, clear date filters, page the result keeping Bulgaria bookings whose
  // CHECK-IN is tomorrow or later).
  const checkinFrom = checkinCutoffISO(config.tz, config.bulgaria.checkinFromDays);
  // Server-side check-in floor (a few days of margin; the exact cutoff is applied
  // per row below) — instead of paging through each supplier's whole history.
  const serverFrom = config.bulgaria.serverDateFilter
    ? isoToDDMMYYYY(addDaysISO(checkinFrom, -Math.abs(config.bulgaria.serverDateMarginDays)))
    : null;
  log.info(
    `[BG] check-in cutoff (>= ${checkinFrom}); booking date: any; list filter: ${
      serverFrom ? `check-in >= ${serverFrom}` : 'all dates'
    }`
  );
  const candidates = [];
  const seen = new Set();
  for (const supplier of config.bulgaria.suppliers) {
    if (stopRequested()) {
      summary.interrupted = true;
      break;
    }
    if (serverFrom) {
      await travelon.applyBusFilter(supplier.partnerId, config.bulgaria.statusIds, serverFrom);
    } else {
      await travelon.applyBulgariaSupplierFilter(supplier.partnerId, config.bulgaria.statusIds);
    }
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
          config.bulgaria.countries.some((c) => new RegExp(c, 'i').test(r.text || ''))
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
  // The client is captured locally: a call abandoned by the deadline below must
  // keep using ITS (closed) browser, never the fresh one created after it.
  const ensureEline = async () => {
    if (eline) return eline;
    const client = makeEline();
    eline = client;
    await client.init();
    await client.login();
    return client;
  };
  // One booking's Eline work with a deadline. A hung portal call cannot be
  // cancelled, so on timeout the Eline browser is closed (the hung call then
  // fails) and a new one is started on next use. After maxTimeoutsPerCycle
  // timeouts the portal is skipped for the rest of this cycle.
  let elineTimeouts = 0;
  const elineDown = () => elineTimeouts >= config.eline.maxTimeoutsPerCycle;
  const withElineDeadline = async (id, what, fn) => {
    if (elineDown()) {
      throw new Error(`Eline portal skipped for the rest of this cycle (${elineTimeouts} timeout(s))`);
    }
    const secs = Math.round(config.eline.opTimeoutMs / 1000);
    let timer = null;
    const work = Promise.resolve().then(fn);
    work.catch(() => {}); // an abandoned call may still reject later — ignore it
    try {
      return await Promise.race([
        work,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new ElineTimeout(`Eline ${what} did not finish in ${secs}s`)),
            config.eline.opTimeoutMs
          );
        }),
      ]);
    } catch (err) {
      if (err instanceof ElineTimeout) {
        elineTimeouts += 1;
        log.error(
          `[BG] ${id}: ${err.message} — closing the portal browser${
            elineDown() ? '; Eline skipped for the rest of this cycle' : ''
          }.`
        );
        const stale = eline;
        eline = null;
        if (stale) {
          await Promise.race([
            stale.close().catch(() => {}),
            new Promise((r) => setTimeout(r, 15000)),
          ]);
        }
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
  // Eline write for a booking whose phone we have. Never throws: a failed or
  // timed-out portal step just leaves the booking open for the next cycle.
  const elineWrite = async (c, phones, agentPhone) => {
    try {
      return await withElineDeadline(c.id, 'write', () =>
        writeToEline(c, phones, summary, ensureEline, agentPhone)
      );
    } catch (err) {
      summary.errors.push(`${c.id}: Eline: ${err.message}`);
      summary.eline.push(`${c.id}->#${c.elineNum} FAILED`);
      log.error(`[BG] ${c.id} Eline#${c.elineNum}: ${err.message} — will retry next cycle.`);
      return false;
    }
  };
  let itravel = null;
  // Why the cabinet is out for the rest of this cycle (login failure). Without this
  // every later booking kept paying ~18 s for a doomed "cabinet not logged in".
  let itravelDown = null;
  const itravelSkipped = new Set();
  const ensureItravel = async () => {
    if (itravelDown) throw new Error(itravelDown);
    if (itravel) return itravel;
    const client = makeItravel();
    try {
      await client.init();
      await client.login();
    } catch (err) {
      // Half-open browser: close it instead of carrying it through the cycle.
      await client.close?.().catch(() => {});
      if (config.itravel.skipCycleOnLoginFail) {
        itravelDown = `Itravel: вхід у кабінет не вдався (${err.message})`;
        summary.itravelDown = err.message;
        log.error(`[Itravel] вхід не вдався: ${err.message} — кабінет пропущено до кінця цього циклу.`);
      }
      throw err;
    }
    itravel = client;
    return client;
  };
  const waitingRef = new Set();
  // Only persist watch state in LIVE mode (so DRY-RUN never pre-marks anything).
  const persist = async (id, patch) => {
    // Ніколи не зберігаємо невалідні номери — інакше вони житимуть у стані вічно.
    const clean = patch && patch.phones ? { ...patch, phones: validPhones(patch.phones) } : patch;
    if (!config.dryRun) await setWatch(id, clean);
  };
  // Send the tourist phone(s) into the Itravel cabinet booking thread (dedup via the
  // thread itself + the watch store). Returns true once the booking is considered
  // messaged (sent now, or the number was already in the thread). Logs to summary.
  const messageItravelFor = async (c, phones, w) => {
    if (!config.itravel.enabled || !c.messageItravel || !phones?.length) return false;
    if (w?.itravelMsgAt) return true; // already messaged in a previous cycle
    if (!config.itravel.email || !config.itravel.password) {
      log.warn(`[Itravel] ${c.id}: ITRAVEL creds not set; cabinet message skipped.`);
      return false;
    }
    if (!c.supplierRef) {
      // Not an error: the Itravel order number simply is not in the booking yet.
      if (!waitingRef.has(c.id)) {
        waitingRef.add(c.id);
        summary.waitingRef.push(c.id);
        log.info(`[Itravel] ${c.id}: no Itravel order number in the booking yet — will message once it appears.`);
      }
      return false;
    }
    if (itravelDown) {
      // Not an error per booking: one cabinet line in the summary covers them all.
      if (!itravelSkipped.has(c.id)) {
        itravelSkipped.add(c.id);
        summary.itravelSkipped.push(c.id);
      }
      return false;
    }
    const client = await ensureItravel();
    const res = await client.sendPhones(c.supplierRef, phones, { dryRun: config.dryRun });
    if (res.alreadyPresent) {
      log.info(`[Itravel] ${c.id} (order ${c.supplierRef}): phone already in thread.`);
      summary.itravel.push(`${c.id}=present`);
      return true;
    }
    if (!config.dryRun && !res.verified) {
      log.error(
        `[Itravel] ${c.id} (order ${c.supplierRef}): MESSAGE NOT CONFIRMED in thread — will retry next cycle.`
      );
      summary.errors.push(`${c.id}: Itravel message NOT confirmed in cabinet thread`);
      summary.itravel.push(`${c.id}->order${c.supplierRef} FAILED`);
      return false;
    }
    const verb = config.dryRun ? 'WOULD message' : 'messaged';
    log.info(`[Itravel] ${c.id} (order ${c.supplierRef}): ${verb} [${res.missing.join(', ')}]`);
    summary.itravel.push(
      `${c.id}->order${c.supplierRef}[${res.missing.join(',')}]${res.sent ? '' : ' (dry)'}`
    );
    return res.sent; // dry-run -> not yet messaged
  };

  let sends = 0; // asks + reminders actually posted this cycle
  let capWarned = false;
  try {
    for (const [idx, c] of candidates.entries()) {
      if (stopRequested()) {
        summary.interrupted = true;
        log.warn(`[BG] stop requested — ${candidates.length - idx} booking(s) left for the next cycle.`);
        break;
      }
      try {
        const w = await getWatch(c.id);
        // In LIVE mode skip bookings we've already completed. In DRY-RUN ignore
        // the store entirely (re-evaluate every cycle, persist nothing).
        if (w?.doneAt && !config.dryRun) {
          // Backfill: this booking was completed before the Itravel-cabinet step
          // existed (or messaging failed earlier) — message the supplier now.
          const storedPhones = validPhones(w?.phones);
          if (c.messageItravel && !w?.itravelMsgAt && storedPhones.length) {
            try {
              if (await messageItravelFor(c, storedPhones, w)) {
                await persist(c.id, { itravelMsgAt: new Date().toISOString() });
              }
            } catch (err) {
              summary.errors.push(`${c.id}: Itravel message failed: ${err.message}`);
              log.error(`[Itravel] ${c.id} message failed:`, err.message);
            }
          }
          summary.skippedDone.push(c.id);
          summary.rows.push(
            mkRow(c, {
              phonePresent: 'так',
              agentNumber: validPhones(w.phones).join(' '),
              writtenInBooking: 'так',
              writtenInEline: 'так',
              status: 'Зроблено (раніше)',
              note: 'Опрацьовано в попередньому циклі',
            })
          );
          continue;
        }

        // Itravel booking whose phone we already have; only the Itravel order
        // number (read from the list row) is missing. Nothing can be done until it
        // appears — don't reopen the booking and its chat every hour.
        const knownPhones = validPhones(w?.phones);
        if (
          !config.dryRun &&
          config.itravel.enabled &&
          c.messageItravel &&
          !c.writeToEline &&
          !c.supplierRef &&
          knownPhones.length
        ) {
          if (!waitingRef.has(c.id)) {
            waitingRef.add(c.id);
            summary.waitingRef.push(c.id);
          }
          summary.rows.push(
            mkRow(c, {
              phonePresent: 'так',
              agentNumber: knownPhones.join(' '),
              writtenInBooking: 'так',
              writtenInEline: 'не потрібно',
              status: WAIT_REF_STATUS,
              note: WAIT_REF_NOTE,
            })
          );
          continue;
        }

        // (a) phone already in the comment fields? Read them from the page HTML
        // (~1 s) and open the page only when that fails (~8 s).
        const fastEdit = travelon.readEditFieldsFast ? await travelon.readEditFieldsFast(c.id) : null;
        let comments;
        let agentRaw;
        if (fastEdit) {
          comments = { user: fastEdit.user, admin: fastEdit.admin };
          agentRaw = fastEdit.telephone;
        } else {
          await travelon.openEdit(c.id);
          comments = await travelon.readComments();
          agentRaw = await travelon.readAgentPhone();
        }
        // The booking Telephone field is the AGENT's number — never the tourist's.
        const agentPhone = normalizeUaPhone(agentRaw);
        let phones = extractPhones(`${comments.user} ${comments.admin}`).filter(
          (p) => p !== agentPhone
        );
        if (phones.length) {
          const elineOk = c.writeToEline ? await elineWrite(c, phones, agentPhone) : true;
          let itravelMsgAt = null;
          if (c.messageItravel) {
            try {
              if (await messageItravelFor(c, phones, w)) itravelMsgAt = new Date().toISOString();
            } catch (err) {
              summary.errors.push(`${c.id}: Itravel message failed: ${err.message}`);
              log.error(`[Itravel] ${c.id} message failed:`, err.message);
            }
          }
          // Only close the booking once the SUPPLIER provably has the phone.
          const supplierOk =
            config.dryRun || (elineOk && (!c.messageItravel || Boolean(itravelMsgAt)));
          await persist(c.id, {
            ...(supplierOk ? { doneAt: new Date().toISOString() } : {}),
            phones,
            source: 'comments',
            ...(itravelMsgAt ? { itravelMsgAt } : {}),
          });
          summary.rows.push(
            mkRow(c, {
              phonePresent: 'так',
              agentNumber: phones.join(' '),
              writtenInBooking: 'так',
              writtenInEline: c.writeToEline
                ? config.dryRun
                  ? 'ні (вписав би)'
                  : elineOk
                    ? 'так'
                    : 'НІ — не підтверджено'
                : 'не потрібно',
              status: supplierOk
                ? 'Зроблено'
                : waitingRef.has(c.id) && elineOk
                  ? WAIT_REF_STATUS
                  : 'Помилка — постачальник не отримав',
              note: [
                dryTag,
                `телефон уже в коментарях заявки (${c.supplier})`,
                supplierOk
                  ? ''
                  : waitingRef.has(c.id) && elineOk
                    ? WAIT_REF_NOTE
                    : 'запис постачальнику не підтверджено — повтор наступного циклу',
              ]
                .filter(Boolean)
                .join(' · '),
            })
          );
          continue;
        }

        // (b) phone in the chat? Any number written by the agent in the chat panel
        // counts as the tourist's (per operator guidance). Read the chat MESSAGES
        // only: from the chat feed (~0.3 s) or, if that fails, from the drawer.
        // The drawer is opened only when something has to be sent.
        let chatOpen = false;
        const openChatIfNeeded = async () => {
          if (chatOpen) return;
          await travelon.openChat(c.id);
          chatOpen = true;
        };
        const closeChatIfOpen = async () => {
          if (!chatOpen) return;
          chatOpen = false;
          await travelon.closeChat(c.id).catch(() => {});
        };
        let chatText = travelon.readChatTextFast ? await travelon.readChatTextFast(c.id) : null;
        const chatFromFeed = chatText !== null;
        if (!chatFromFeed) {
          await openChatIfNeeded();
          chatText = await travelon.readChatPanelText();
        }
        phones = extractPhones(chatText).filter((p) => p !== agentPhone);
        if (phones.length) {
          await closeChatIfOpen();
          await travelon.openEdit(c.id);
          const res = await travelon.appendPhonesToComments(phones, { dryRun: config.dryRun });
          summary.comments.push(`${c.id}${res.saved ? '' : ' (dry)'}`);
          log.info(
            `[BG] ${c.id}: ${config.dryRun ? 'WOULD write' : 'wrote'} phone(s) [${phones.join(
              ', '
            )}] to both comment fields`
          );
          const elineOk = c.writeToEline ? await elineWrite(c, phones, agentPhone) : true;
          let itravelMsgAt = null;
          if (c.messageItravel) {
            try {
              if (await messageItravelFor(c, phones, w)) itravelMsgAt = new Date().toISOString();
            } catch (err) {
              summary.errors.push(`${c.id}: Itravel message failed: ${err.message}`);
              log.error(`[Itravel] ${c.id} message failed:`, err.message);
            }
          }
          // Only close the booking once the SUPPLIER provably has the phone.
          const supplierOk =
            config.dryRun || (elineOk && (!c.messageItravel || Boolean(itravelMsgAt)));
          await persist(c.id, {
            ...(supplierOk ? { doneAt: new Date().toISOString() } : {}),
            phones,
            source: 'chat',
            ...(itravelMsgAt ? { itravelMsgAt } : {}),
          });
          summary.rows.push(
            mkRow(c, {
              phonePresent: 'так',
              agentNumber: phones.join(' '),
              writtenInBooking: config.dryRun ? 'ні (вписав би)' : 'так',
              writtenInEline: c.writeToEline
                ? config.dryRun
                  ? 'ні (вписав би)'
                  : elineOk
                    ? 'так'
                    : 'НІ — не підтверджено'
                : 'не потрібно',
              status: supplierOk
                ? 'Зроблено'
                : waitingRef.has(c.id) && elineOk
                  ? WAIT_REF_STATUS
                  : 'Помилка — постачальник не отримав',
              note: [
                dryTag,
                `номер із чату агента (${c.supplier})`,
                supplierOk
                  ? ''
                  : waitingRef.has(c.id) && elineOk
                    ? WAIT_REF_NOTE
                    : 'запис постачальнику не підтверджено — повтор наступного циклу',
              ]
                .filter(Boolean)
                .join(' · '),
            })
          );
          continue;
        }

        // (b.5) E.Line: phone ALREADY in the Eline portal (e.g. the agent filled
        // it directly)? Treat as done — don't ask, don't write anything.
        if (c.writeToEline && config.eline.email && config.eline.password) {
          let elinePhones = [];
          try {
            elinePhones = await withElineDeadline(c.id, 'precheck', async () => {
              const el = await ensureEline();
              await el.openBooking(c.elineNum);
              return (await el.readPassengerPhones())
                .filter(looksLikePhone)
                .filter((p) => normalizeUaPhone(p) !== agentPhone);
            });
          } catch (err) {
            summary.errors.push(`${c.id}: Eline precheck failed: ${err.message}`);
            log.error(`[BG] ${c.id}: Eline precheck failed:`, err.message);
          }
          if (elinePhones.length) {
            log.info(
              `[BG] ${c.id} Eline#${c.elineNum}: phone already in portal [${elinePhones.join(
                ', '
              )}] — marking done, no ask.`
            );
            await closeChatIfOpen();
            await persist(c.id, {
              doneAt: new Date().toISOString(),
              phones: elinePhones,
              source: 'eline-prefilled',
            });
            summary.skippedDone.push(`${c.id} (eline)`);
            summary.rows.push(
              mkRow(c, {
                phonePresent: 'так',
                agentNumber: elinePhones.join(' '),
                writtenInEline: 'так',
                status: 'Зроблено',
                note: [dryTag, 'номер уже в Eline-порталі'].filter(Boolean).join(' · '),
              })
            );
            continue;
          }
        }

        // (c) nowhere -> ask / remind
        const askInChat = BG_ASK_PATTERNS.some((re) => re.test(chatText));
        const remindInChat = BG_REMINDER_PATTERNS.some((re) => re.test(chatText));
        // A stored ask the chat feed does not hold was never delivered (until 11.2026
        // every send was a silent no-op). Only trusted on a complete feed read.
        const ghost =
          config.ghostRecheck &&
          !config.dryRun &&
          chatFromFeed &&
          Boolean(w?.askedAt) &&
          !askInChat &&
          !remindInChat;
        if (ghost) summary.ghosts.push(c.id);
        const asked = askInChat || (Boolean(w?.askedAt) && !ghost);
        const reminded = remindInChat || (Boolean(w?.remindedAt) && !ghost);
        const wantsSend = !asked || (!reminded && shouldRemindNow(w?.askedAt));
        const capped = wantsSend && !config.dryRun && sends >= config.bulgaria.maxSendsPerRun;
        if (capped && !capWarned) {
          capWarned = true;
          log.warn(`[BG] reached BG_MAX_SENDS_PER_RUN=${config.bulgaria.maxSendsPerRun}; the rest next cycle.`);
        }

        if (capped) {
          summary.waiting.push(c.id);
          summary.rows.push(
            mkRow(c, {
              phonePresent: 'ні',
              asked: asked ? 'так' : 'ні',
              status: 'Очікує — ліміт надсилань циклу',
              note: 'запит/нагадування піде наступного циклу',
            })
          );
        } else if (!asked) {
          if (config.dryRun) {
            summary.asked.push(`${c.id} (dry)`);
            log.info(`[BG] ${c.id}: WOULD ask agent for tourist phone.`);
          } else {
            await openChatIfNeeded();
            await travelon.sendChatMessage({
              department: config.bulgaria.department,
              subject: config.bulgaria.subject,
              text: config.bulgaria.askText,
              bundleId: c.id,
            });
            sends += 1;
            summary.asked.push(c.id);
            log.info(
              `[BG] ${c.id}: asked agent for tourist phone${ghost ? ' (the earlier ask never reached the chat)' : ''}.`
            );
          }
          await persist(c.id, { askedAt: new Date().toISOString(), ...(ghost ? { remindedAt: null } : {}) });
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
            await openChatIfNeeded();
            await travelon.sendChatMessage({
              department: config.bulgaria.department,
              subject: config.bulgaria.subject,
              text: config.bulgaria.reminderText,
              bundleId: c.id,
            });
            sends += 1;
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
        await closeChatIfOpen();
      } catch (err) {
        summary.errors.push(`${c.id}: ${err.message}`);
        log.error(`[BG] booking ${c.id} failed:`, err.message);
        await travelon.screenshot(`bg-${c.id}-error`);
        summary.rows.push(mkRow(c, { status: 'Помилка', note: err.message }));
      }
    }
  } finally {
    await eline?.close();
    await itravel?.close();
  }

  const lines = [
    `Bulgaria/Eline ${config.dryRun ? '[DRY-RUN]' : '[LIVE]'}`,
    `Matched: ${summary.matched.length} (${summary.matched.join(', ') || DASH})`,
    `Eline writes: ${summary.eline.join(', ') || DASH}`,
    `Itravel msgs: ${summary.itravel.join(', ') || DASH}`,
    ...(summary.itravelDown
      ? [
          `Itravel: ❌ вхід у кабінет не вдався (${summary.itravelDown}) — кабінет пропущено до кінця циклу; без повідомлення ${summary.itravelSkipped.length} заявок${
            summary.itravelSkipped.length ? `: ${idList(summary.itravelSkipped)}` : ''
          }`,
        ]
      : []),
    `Waiting Itravel order №: ${summary.waitingRef.join(', ') || DASH}`,
    `Comment writes: ${summary.comments.join(', ') || DASH}`,
    `Asked: ${summary.asked.join(', ') || DASH}`,
    `Reminded: ${summary.reminded.join(', ') || DASH}`,
    `Waiting: ${summary.waiting.join(', ') || DASH}`,
    ...(summary.ghosts.length ? [`Re-asked (earlier ask never delivered): ${idList(summary.ghosts)}`] : []),
    `Already done: ${summary.skippedDone.join(', ') || DASH}`,
    `Errors: ${summary.errors.join(' | ') || DASH}`,
  ];
  if (summary.interrupted) lines.push('Interrupted: stop requested (rest next cycle)');
  log.info('[BG] summary:\n' + lines.join('\n'));
  summary.report = lines.join('\n');
  return summary;
}
