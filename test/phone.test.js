// Tests for the phone parser (the Bulgaria/Eline "Waiting" bug fix).
// Run with: npm test   (Node's built-in runner, no extra deps).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUaPhone,
  extractPhones,
  extractTouristPhones,
  assignPhones,
} from '../src/phone.js';

test('normalizeUaPhone canonicalises every supported format', () => {
  assert.equal(normalizeUaPhone('380974915728'), '+380974915728'); // plain 12-digit
  assert.equal(normalizeUaPhone('+380(97)491-57-28'), '+380974915728'); // parens + dashes
  assert.equal(normalizeUaPhone('+380 97 425 81 22'), '+380974258122'); // spaces
  assert.equal(normalizeUaPhone('+380(67)594-18-21'), '+380675941821');
  assert.equal(normalizeUaPhone('0(67)594-18-21'), '+380675941821'); // 0XXXXXXXXX
  assert.equal(normalizeUaPhone('80 67 594 18 21'), '+380675941821'); // 80XXXXXXXXX
  assert.equal(normalizeUaPhone('00380675941821'), '+380675941821'); // 00 intl prefix
});

test('normalizeUaPhone rejects anything that is not a UA number', () => {
  for (const bad of [
    '',
    null,
    undefined,
    '54964', // booking id
    'ТК2139', // route code
    '1,2', // seat list
    '04.24.2026', // date
    '10:59', // time
    '30', // "30 євро"
    '183338', // Eline ref
    '0975', // too short
    '3805941821', // 10 digits but starts 380 (invalid)
  ]) {
    assert.equal(normalizeUaPhone(bad), null, `should reject: ${bad}`);
  }
});

test('extractPhones reads numbers written with parentheses/dashes/spaces', () => {
  assert.deepEqual(extractPhones('+380(97)491-57-28'), ['+380974915728']);
  assert.deepEqual(extractPhones("телефон +380 97 425 81 22, дякую"), ['+380974258122']);
});

test('extractPhones pulls BOTH numbers from a real agent reply', () => {
  // Real chat reply from booking #54964 (the one stuck in "Waiting").
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
  assert.deepEqual(
    extractPhones('+380(67)594-18-21 ... ще раз 380675941821'),
    ['+380675941821']
  );
});

test('extractPhones ignores dates, times, seats, ids and list numbers', () => {
  const noise =
    'Заявка 54964 від 22.04.2026 10:59, місця 5-6, ТК2139, з 1 по 16, 30 євро, E.Line Tour - 183338';
  assert.deepEqual(extractPhones(noise), []);
});

test('extractTouristPhones keeps only numbers near the word "турист"', () => {
  const t =
    'Диспетчер +380(50)111-22-33.' + ' '.repeat(90) + 'Телефон туриста +380(67)594-18-21.';
  assert.deepEqual(extractTouristPhones(t), ['+380675941821']);
});

test('assignPhones cycles one phone per passenger', () => {
  assert.deepEqual(assignPhones(['+380675941821'], 3), [
    '+380675941821',
    '+380675941821',
    '+380675941821',
  ]);
  assert.deepEqual(assignPhones(['A', 'B'], 3), ['A', 'B', 'A']);
  assert.deepEqual(assignPhones([], 2), []);
});
