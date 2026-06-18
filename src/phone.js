// Phone-number helpers for the Bulgaria/Eline workflow.
import { PHONE_RE } from './config.js';

// Extract all recognised phone numbers from a text, de-duplicated, order kept.
// Accepts formats 380XXXXXXXXX / 80XXXXXXXXX / 0XXXXXXXXX (as the user specified).
export function extractPhones(text) {
  if (!text) return [];
  const matches = String(text).match(PHONE_RE) || [];
  const seen = new Set();
  const out = [];
  for (const m of matches) {
    if (!seen.has(m)) {
      seen.add(m);
      out.push(m);
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
// word "турист" appears within ~80 chars of the number. This prevents grabbing
// the agent's own contact number (shown in the chat UI / profile).
export function extractTouristPhones(text) {
  if (!text) return [];
  const re = new RegExp(PHONE_RE.source, 'g');
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    const s = Math.max(0, m.index - 80);
    const e = Math.min(text.length, m.index + m[0].length + 80);
    if (/турист/i.test(text.slice(s, e))) {
      if (!seen.has(m[0])) {
        seen.add(m[0]);
        out.push(m[0]);
      }
    }
  }
  return out;
}
