// Tests for the phone parser + supplier-message helpers.
// Run with: npm test   (Node's built-in runner, no extra deps).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUaPhone,
  extractPhones,
  extractTouristPhones,
  assignPhones,
  phonesMissingFromText,
  buildPhoneMessage,
} from '../src/phone.js';

test('normalizeUaPhone canonicalises every supported format', () => {
  assert.equal(normalizeUaPhone('380974915728'), '+380974915728');
  assert.equal(normalizeUaPhone('+380(97)491-57-28'), '+380974915728');
  assert.equal(normalizeUaPhone('+380 97 425 81 22'), '+380974258122');
  assert.equal(normalizeUaPhone('+380(67)594-18-21'), '+380675941821');
  assert.equal(normalizeUaPhone('0(67)594-18-21'), '+380675941821');
  assert.equal(normalizeUaPhone('80 67 594 18 21'), '+380675941821');
  assert.equal(normalizeUaPhone('00380675941821'), '+380675941821');
});

test('normalizeUaPhone rejects anything that is not a UA number', () => {
  for (const bad of ['', null, undefined, '54964', 'ТК2139', '1,2', '04.24.2026', '10:59', '30', '183338', '0975', '3805941821']) {
    assert.equal(normalizeUaPhone(bad), null, `should reject: ${bad}`);
  }
});

test('extractPhones reads numbers written with parentheses/dashes/spaces', () => {
  assert.deepEqual(extractPhones('+380(97)491-57-28'), ['+380974915728']);
  assert.deepEqual(extractPhones('телефон +380 97 425 81 22, дякую'), ['+380974258122']);
});

test('extractPhones pulls BOTH numbers from a real agent reply', () => {
  const msg = [
    'Доброго дня, колеги.',
    'Номер туристки - Ія Дьоміна.',
    '+380(67)594-18-21',
    'або +380(63)384-60-02.',
    '',
    'Колеги, ми бронювали перші місця з 1-по 16 місце. Місця 1,2?',
  ].join('\n');
  assert.deepEqual(extractPhones(msg), ['+380675941821', '+380633846002']);
});

test('extractPhones de-duplicates the same number across formats', () => {
  assert.deepEqual(extractPhones('+380(67)594-18-21 ... ще раз 380675941821'), ['+380675941821']);
});

test('extractPhones ignores dates, times, seats, ids and list numbers', () => {
  const noise = 'Заявка 54964 від 22.04.2026 10:59, місця 5-6, ТК2139, з 1 по 16, 30 євро, E.Line Tour - 183338';
  assert.deepEqual(extractPhones(noise), []);
});

test('extractTouristPhones keeps only numbers near the word "турист"', () => {
  const t = 'Диспетчер +380(50)111-22-33.' + ' '.repeat(90) + 'Телефон туриста +380(67)594-18-21.';
  assert.deepEqual(extractTouristPhones(t), ['+380675941821']);
});

test('assignPhones cycles one phone per passenger', () => {
  assert.deepEqual(assignPhones(['+380675941821'], 3), ['+380675941821', '+380675941821', '+380675941821']);
  assert.deepEqual(assignPhones(['A', 'B'], 3), ['A', 'B', 'A']);
  assert.deepEqual(assignPhones([], 2), []);
});

test('phonesMissingFromText returns only numbers not already in the thread', () => {
  const thread = 'Якийсь текст. контакт туристів +380 97 707 7689. дякуємо';
  assert.deepEqual(phonesMissingFromText(['+380977077689', '+380675941821'], thread), ['+380675941821']);
  assert.deepEqual(phonesMissingFromText(['+380977077689'], thread), []);
  assert.deepEqual(phonesMissingFromText(['+380675941821'], ''), ['+380675941821']);
});

test('phonesMissingFromText is format-agnostic (the #73993 duplicate bug)', () => {
  // Thread has the numbers WITH "+"; the bot holds them WITHOUT "+" (old store).
  const thread = '+380631706806 Наталія\n+380635673965 Анна';
  assert.deepEqual(phonesMissingFromText(['380631706806', '380635673965'], thread), []);
  // A genuinely new number is returned in canonical +380 form.
  assert.deepEqual(phonesMissingFromText(['380631706806', '0509998877'], thread), ['+380509998877']);
});

test('buildPhoneMessage fills the {phones} template', () => {
  assert.equal(
    buildPhoneMessage('Контакт туриста для водія трансферу: {phones}', ['+380675941821']),
    'Контакт туриста для водія трансферу: +380675941821'
  );
  assert.equal(buildPhoneMessage('Тел: {phones}', ['+380675941821', '+380633846002']), 'Тел: +380675941821, +380633846002');
});

// --- Dates read as phones (prod bug, audit 08.10.2026) ------------------------
import { isDateShaped, isPlausibleUaMobile, isUsablePhone, stripDates } from '../src/phone.js';

test('a date + hour is never read as a phone (the three numbers found in prod)', () => {
  // 72411: "07.07.2027 12:…" -> +380707202712; 70219: "09.09.2026 22:…" -> +380909202622;
  // 72129: "05.09.2026 22:…" -> +380509202622 (050 is a real Vodafone code!).
  assert.deepEqual(extractPhones('Виїзд 07.07.2027 12:30, автобус'), []);
  assert.deepEqual(extractPhones('Менеджер 09.09.2026 22:05\nДякуємо'), []);
  assert.deepEqual(extractPhones('Агент 05.09.2026 22:41 Добрий вечір'), []);
  assert.deepEqual(extractPhones('05.10.2026 09:15'), []); // reproduced in the audit
  assert.deepEqual(extractPhones('05.10.2026, о 09.15'), []);
});

test('the old (lenient) parse still sees the date as a number — kept only for dedup', () => {
  assert.deepEqual(extractPhones('05.10.2026 09:15', { strict: false }), ['+380510202609']);
});

test('a real phone next to a date or inside a chat transcript is still found', () => {
  assert.deepEqual(extractPhones('05.10.2026 0671234567'), ['+380671234567']);
  assert.deepEqual(extractPhones('05.10.2026 09:15 +380(67)594-18-21'), ['+380675941821']);
  const chat = [
    'Travelon Бронювання 03.10.2026 09:12',
    'Шановні колеги, просимо надіслати номер телефону туристів для контакту з перевізниками.',
    'Агенція Сонце 03.10.2026 10:47',
    'Добрий день! Номер туриста 097 425 81 22, другий +380 (63) 384-60-02',
  ].join('\n');
  assert.deepEqual(extractPhones(chat), ['+380974258122', '+380633846002']);
});

test('stripDates removes dates with times but leaves phone groups alone', () => {
  assert.equal(stripDates('067.594.18.21').trim(), '067.594.18.21');
  assert.equal(stripDates('050-123-45-67').trim(), '050-123-45-67');
  assert.equal(stripDates('097-77-07-689').trim(), '097-77-07-689');
  assert.equal(stripDates('до 05.10.2026 09:15:00!').replace(/\s+/g, ' ').trim(), 'до !');
});

test('isDateShaped flags the fakes and nothing real', () => {
  for (const fake of ['+380707202712', '+380909202622', '+380509202622', '0510202609'])
    assert.equal(isDateShaped(fake), true, fake);
  for (const real of ['+380675941821', '+380974258122', '+380633846002', '0501234567'])
    assert.equal(isDateShaped(real), false, real);
});

test('only Ukrainian MOBILE codes count as a tourist phone in free text', () => {
  for (const ok of ['0501112233', '0631112233', '0661112233', '0671112233', '0681112233', '0731112233',
    '0751112233', '0771112233', '0931112233', '0951112233', '0961112233', '0971112233', '0981112233', '0991112233'])
    assert.equal(isPlausibleUaMobile(ok), true, ok);
  for (const bad of ['0441112233', '0321112233', '0701112233', '0801112233', '0101112233'])
    assert.equal(isPlausibleUaMobile(bad), false, bad);
  assert.deepEqual(extractPhones('Офіс: 044 123 45 67, турист: 067 123 45 67'), ['+380671234567']);
});

test('isUsablePhone (stored / portal values) drops dates but not unusual codes', () => {
  assert.equal(isUsablePhone('+380509202622'), false);
  assert.equal(isUsablePhone('+380441234567'), true); // typed into a phone field on purpose
  assert.equal(isUsablePhone('2283019842534'), false);
});
