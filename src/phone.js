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

// Extract all recognised phone numbers from a text — canonicalised to
// "+380XXXXXXXXX" and de-duplicated, order kept. Tolerates the human formats
// agents type, e.g. "+380(67)594-18-21", "+380 97 425 81 22", "0(63)384-60-02".
export function extractPhones(text) {
  if (!text) return [];
  const seen = new Set();
  const out = [];
  for (const m of String(text).match(PHONE_CANDIDATE_RE) || []) {
    const phone = normalizeUaPhone(m);
    if (phone && !seen.has(phone)) {
      seen.add(phone);
      out.push(phone);
    }
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
export function extractTouristPhones(text) {
  if (!text) return [];
  const re = new RegExp(PHONE_CANDIDATE_RE.source, 'g');
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const phone = normalizeUaPhone(m[0]);
    if (!phone) continue;
    const s = Math.max(0, m.index - 80);
    const e = Math.min(text.length, m.index + m[0].length + 80);
    if (/турист/i.test(text.slice(s, e)) && !seen.has(phone)) {
      seen.add(phone);
      out.push(phone);
    }
  }
  return out;
}
