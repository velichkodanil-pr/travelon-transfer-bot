// Phone-number helpers for the Bulgaria/Eline workflow.
import { PHONE_CANDIDATE_RE } from './config.js';

// Canonicalise ONE raw phone token (which may contain spaces, dashes,
// parentheses, dots or a leading "+") to the form "+380XXXXXXXXX", or return
// null if it is not a recognised Ukrainian number. Accepts the three formats the
// bot has always supported, now regardless of separators:
//   380XXXXXXXXX (12 digits) / 80XXXXXXXXX (11) / 0XXXXXXXXX (10),
// plus an optional international "00" prefix (00380…).
export function normalizeUaPhone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D+/g, ''); // keep digits only
  if (d.startsWith('00')) d = d.slice(2); // 00380… -> 380…
  let local = null; // the 9 subscriber digits (operator code + number)
  if (d.length === 12 && d.startsWith('380')) local = d.slice(3);
  else if (d.length === 11 && d.startsWith('80')) local = d.slice(2);
  else if (d.length === 10 && d.startsWith('0')) local = d.slice(1);
  if (local === null) return null;
  return `+380${local}`;
}

// Ukrainian MOBILE operator codes (the two digits after +380): 039 Kyivstar
// (ex-Golden Telecom), 050/066/075/095/099 Vodafone, 063/073/093 lifecell,
// 067/068/077/096/097/098 Kyivstar, 089/094 Intertelecom, 091 3Mob,
// 092 PEOPLEnet. Comments and chats are full of other digit runs (dates,
// prices, IBANs, order numbers); a "number" with any other code is not a
// tourist's mobile, so it is never treated as one.
const UA_MOBILE_CODES = new Set([
  '39', '50', '63', '66', '67', '68', '73', '75', '77', '89',
  '91', '92', '93', '94', '95', '96', '97', '98', '99',
]);

// A date + hour fused into a "phone" by the separator-tolerant candidate regex:
// "05.10.2026 09:15" -> token "05.10.2026 09" -> 0510202609 -> +380510202609.
// The 9 local digits then read D MM 20YY HH. Real numbers practically never have
// this shape (needs 202x in the middle AND a valid month and hour around it).
// Seen in prod: +380707202712 (72411), +380909202622 (70219), +380509202622 (72129).
const DATE_SHAPED_LOCAL_RE = /^[1-9](0[1-9]|1[0-2])20[2-3]\d([01]\d|2[0-3])$/;

// Dates (optionally followed by a time) are cut out of free text BEFORE looking
// for phones, so a date can never be read as — or glued onto — a number.
// Day 1-31, month 1-12, year 2 or 4 digits; "о"/"в"/"at" allowed before the time.
const DATE_TIME_RE =
  /(?<!\d)(?:0?[1-9]|[12]\d|3[01])[./-](?:0?[1-9]|1[0-2])[./-](?:\d{4}|\d{2})(?!\d)(?:[ \t,]*(?:о|об|в|at)?[ \t]*(?:[01]?\d|2[0-3])[:.][0-5]\d(?::[0-5]\d)?(?!\d))?/giu;

export function stripDates(text) {
  return String(text || '').replace(DATE_TIME_RE, '\n');
}

// True for a UA number whose digits are really a date + hour (see above).
export function isDateShaped(phone) {
  const canon = normalizeUaPhone(phone);
  return Boolean(canon) && DATE_SHAPED_LOCAL_RE.test(canon.slice(4));
}

// A stored/portal value we may treat as a phone: a valid UA number that is not
// a date in disguise. (Operator codes are NOT checked here — the agent or the
// supplier typed it into a phone field, so it is meant as a phone.)
export function isUsablePhone(phone) {
  return Boolean(normalizeUaPhone(phone)) && !isDateShaped(phone);
}

// A number found in FREE TEXT that we may treat as the tourist's mobile.
export function isPlausibleUaMobile(phone) {
  const canon = normalizeUaPhone(phone);
  if (!canon || isDateShaped(canon)) return false;
  return UA_MOBILE_CODES.has(canon.slice(4, 6));
}

// Extract all recognised phone numbers from a text — canonicalised to
// "+380XXXXXXXXX" and de-duplicated, order kept. Tolerates the human formats
// agents type, e.g. "+380(67)594-18-21", "+380 97 425 81 22", "0(63)384-60-02".
//   strict (default): dates are cut out first and only plausible UA MOBILE
//     numbers are returned — use it to decide what the tourist's phone IS;
//   strict:false: the old structural parse — use it only to check whether a
//     number is already PRESENT in a thread (dedup / verify after sending).
export function extractPhones(text, { strict = true } = {}) {
  if (!text) return [];
  const src = strict ? stripDates(text) : String(text);
  const seen = new Set();
  const out = [];
  for (const m of src.match(PHONE_CANDIDATE_RE) || []) {
    const phone = normalizeUaPhone(m);
    if (!phone || seen.has(phone)) continue;
    if (strict && !isPlausibleUaMobile(phone)) continue;
    seen.add(phone);
    out.push(phone);
  }
  return out;
}

// Assign one phone per passenger, cycling the phone list so every passenger
// gets exactly one number (one phone -> all the same; N phones -> distributed,
// repeating by cycle if there are more passengers than phones).
export function assignPhones(phones, passengerCount) {
  if (!phones.length || passengerCount <= 0) return [];
  const out = [];
  for (let i = 0; i < passengerCount; i++) out.push(phones[i % phones.length]);
  return out;
}

// Extract phones from CHAT text ONLY when clearly the TOURIST's phone, i.e. the
// word "турист" appears within ~80 chars of the number. (Kept for callers that
// want the stricter proximity rule; the Bulgaria flow currently treats any
// number in the chat panel as the tourist's, per operator guidance.)
export function extractTouristPhones(rawText) {
  if (!rawText) return [];
  const text = stripDates(rawText); // the ~80-char window is measured on the date-free text
  const re = new RegExp(PHONE_CANDIDATE_RE.source, 'g');
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const phone = normalizeUaPhone(m[0]);
    if (!phone || !isPlausibleUaMobile(phone)) continue;
    const s = Math.max(0, m.index - 80);
    const e = Math.min(text.length, m.index + m[0].length + 80);
    if (/турист/i.test(text.slice(s, e)) && !seen.has(phone)) {
      seen.add(phone);
      out.push(phone);
    }
  }
  return out;
}

// --- Supplier-message helpers (Itravel cabinet) -------------------------------

// Return the phones NOT already present in `text`, in CANONICAL form, de-duplicated.
// Both sides are compared by canonical +380XXXXXXXXX, so a number written without
// "+" (e.g. an old stored value "380631706806") still matches the same number in
// the thread written as "+380631706806". This is the dedup that prevents resending.
export function phonesMissingFromText(phones, text) {
  // Lenient on purpose: anything number-shaped already in the thread counts as present.
  const present = new Set(extractPhones(text || '', { strict: false }));
  const out = [];
  const seen = new Set();
  for (const p of phones || []) {
    const canon = normalizeUaPhone(p) || p; // fall back to raw if unparseable
    if (!present.has(canon) && !seen.has(canon)) {
      seen.add(canon);
      out.push(canon);
    }
  }
  return out;
}

// Build a supplier message from a template, replacing `{phones}` with the
// comma-separated numbers.
export function buildPhoneMessage(template, phones) {
  return String(template).replace('{phones}', (phones || []).join(', '));
}
