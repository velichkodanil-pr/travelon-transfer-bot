// State files: atomic writes, remembered chat requests, unreadable-file safety.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

let store;
let dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-store-'));
  process.env.DATA_DIR = dir;
  store = await import('../src/store.js');
});

test('markSent / getSent keep the source of the decision', async () => {
  await store.markSent('70001', { country: 'Греція' });
  await store.markSent('70002', { country: 'Іспанія', source: 'chat-existing' });
  assert.equal((await store.getSent('70001')).country, 'Греція');
  assert.equal((await store.getSent('70002')).source, 'chat-existing');
  assert.equal(await store.getSent('79999'), null);
  assert.equal(await store.wasSent('70001'), true);
});

test('writes are atomic: no temp files are left behind and JSON stays valid', async () => {
  await Promise.all([1, 2, 3].map((i) => store.setWatch(`7100${i}`, { askedAt: 'x' })));
  const files = fs.readdirSync(dir);
  assert.ok(!files.some((f) => f.endsWith('.tmp')), files.join(','));
  JSON.parse(fs.readFileSync(path.join(dir, 'bulgaria.json'), 'utf8'));
});

test('an unreadable state file is kept aside instead of silently lost', async () => {
  fs.writeFileSync(path.join(dir, 'busWarn.json'), '{"72001": {"warnedAt": "2026-10-0');
  assert.deepEqual(await store.loadBusWarn(), {});
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('busWarn.json.corrupt-')));
  await store.setBusWarn('72002', { warnedAt: 'now' });
  assert.equal((await store.getBusWarn('72002')).warnedAt, 'now');
});
