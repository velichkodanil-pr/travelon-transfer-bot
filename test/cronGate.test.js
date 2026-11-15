// Hour gate for Railway Cron (UTC schedule, Kyiv CHECK_CRON, winter/summer offsets).
import test from 'node:test';
import assert from 'node:assert/strict';
import { hourInTz, parseHourField, cronHourMatches } from '../src/cronGate.js';

const TZ = 'Europe/Kyiv';
const at = (iso) => new Date(iso);
const sorted = (set) => [...set].sort((a, b) => a - b);
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

test('hourInTz: Kyiv is UTC+2 in winter, UTC+3 in summer, midnight is 0', () => {
  assert.equal(hourInTz(at('2026-11-15T05:00:00Z'), TZ), 7);
  assert.equal(hourInTz(at('2027-07-01T04:00:00Z'), TZ), 7);
  assert.equal(hourInTz(at('2026-11-15T22:00:00Z'), TZ), 0);
  // DST switch day (28.03.2027, 03:00 -> 04:00 local at 01:00 UTC).
  assert.equal(hourInTz(at('2027-03-28T00:30:00Z'), TZ), 2);
  assert.equal(hourInTz(at('2027-03-28T01:30:00Z'), TZ), 4);
});

test('parseHourField: ranges, lists, steps', () => {
  assert.deepEqual(sorted(parseHourField('7-23')), range(7, 23));
  assert.deepEqual(sorted(parseHourField('6,15')), [6, 15]);
  assert.deepEqual(sorted(parseHourField('*')), range(0, 23));
  assert.deepEqual(sorted(parseHourField('*/3')), [0, 3, 6, 9, 12, 15, 18, 21]);
  assert.deepEqual(sorted(parseHourField('8-20/4')), [8, 12, 16, 20]);
  assert.deepEqual(sorted(parseHourField('5/4')), [5, 9, 13, 17, 21]);
  assert.deepEqual(sorted(parseHourField('0,7-9')), [0, 7, 8, 9]);
});

test('parseHourField: anything not understood -> null', () => {
  for (const bad of ['', 'abc', '25', '7-25', '9-7', '*/0', 'MON', '7-23/x']) {
    assert.equal(parseHourField(bad), null, bad);
  }
});

test('cronHourMatches: unknown expressions never block a run', () => {
  assert.equal(cronHourMatches('@hourly', at('2026-11-15T04:00:00Z'), TZ), true);
  assert.equal(cronHourMatches('0 x * * *', at('2026-11-15T04:00:00Z'), TZ), true);
  assert.equal(cronHourMatches('', at('2026-11-15T04:00:00Z'), TZ), true);
});

test('cronHourMatches: 6-field node-cron expression (seconds first)', () => {
  assert.equal(cronHourMatches('0 0 7-23 * * *', at('2026-11-15T05:00:00Z'), TZ), true);
  assert.equal(cronHourMatches('0 0 7-23 * * *', at('2026-11-15T04:00:00Z'), TZ), false);
});

// The Railway schedule lists the UTC hours of both offsets; over a whole winter
// day and a whole summer day the gate must pass exactly CHECK_CRON's Kyiv hours,
// each exactly once.
function passedKyivHours(checkCron, railwayUtcHours, dayIso) {
  const out = [];
  for (const h of railwayUtcHours) {
    const d = at(`${dayIso}T${String(h).padStart(2, '0')}:00:20Z`);
    if (cronHourMatches(checkCron, d, TZ)) out.push(hourInTz(d, TZ));
  }
  return out.sort((a, b) => a - b);
}

test('transfer schedule: Railway "0 4-21 * * *" UTC = 07..23 Kyiv all year', () => {
  const utc = range(4, 21);
  assert.deepEqual(passedKyivHours('0 7-23 * * *', utc, '2026-11-16'), range(7, 23));
  assert.deepEqual(passedKyivHours('0 7-23 * * *', utc, '2027-07-01'), range(7, 23));
  assert.deepEqual(passedKyivHours('0 7-23 * * *', utc, '2027-03-28'), range(7, 23));
});
