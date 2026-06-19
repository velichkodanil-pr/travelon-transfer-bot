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
