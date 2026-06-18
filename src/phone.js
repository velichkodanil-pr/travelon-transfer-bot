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
