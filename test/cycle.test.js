// Generic 4-country flow with a fake browser client (no Playwright, no network).
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

let runCycle;
let stop;
before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-cycle-'));
  process.env.DRY_RUN = 'false';
  process.env.REPORT_ENABLED = 'false';
  process.env.BG_ENABLED = 'false';
  process.env.BUSWARN_ENABLED = 'false';
  process.env.INSDOC_ENABLED = 'false';
  ({ runCycle } = await import('../src/runCycle.js'));
  stop = await import('../src/stop.js');
});
afterEach(() => stop.resetStop());

function fakeClient({ bookings, panel = {}, body = {}, onOpenChat } = {}) {
  const calls = { openChat: [], sent: [] };
  let chatId = null;
  return {
    calls,
    async init() {},
    async login() {},
    async openRequests() {},
    async listUpcomingMatching() {
      return bookings.map((id) => ({ id, country: 'Греція', status: '', dateISO: '2026-10-01' }));
    },
    async openChat(id) {
      chatId = id;
      calls.openChat.push(id);
      if (onOpenChat) onOpenChat(id);
    },
    async chatAlreadyRequested() {
      const t = `${panel[chatId] || ''} ${body[chatId] || ''}`;
      return /телефон\s+турист/i.test(t);
    },
    async readChatPanelText() {
      return panel[chatId] || '';
    },
    async closeChat() {},
    async sendMessage() {
      calls.sent.push(chatId);
    },
    async screenshot() {},
    async close() {},
  };
}

test('a request already in the chat is remembered: the chat is not reopened next hour', async () => {
  const c1 = fakeClient({ bookings: ['73001'], panel: { 73001: 'Просимо надіслати телефон туристів' } });
  const s1 = await runCycle({ makeClient: () => c1 });
  assert.deepEqual(s1.skippedAlready, ['73001']);
  assert.deepEqual(c1.calls.sent, []);

  const c2 = fakeClient({ bookings: ['73001'], panel: { 73001: 'Просимо надіслати телефон туристів' } });
  const s2 = await runCycle({ makeClient: () => c2 });
  assert.deepEqual(c2.calls.openChat, [], 'remembered — no chat opened');
  assert.deepEqual(s2.skippedAlready, ['73001']);
});

test('a match found only outside the chat panel is not made permanent', async () => {
  const c1 = fakeClient({ bookings: ['73002'], body: { 73002: 'телефон туриста' } });
  await runCycle({ makeClient: () => c1 });
  const c2 = fakeClient({ bookings: ['73002'], body: { 73002: 'телефон туриста' } });
  await runCycle({ makeClient: () => c2 });
  assert.deepEqual(c2.calls.openChat, ['73002'], 'checked again');
});

test('a new booking gets the request once', async () => {
  const c1 = fakeClient({ bookings: ['73003'] });
  const s1 = await runCycle({ makeClient: () => c1 });
  assert.deepEqual(s1.sent, ['73003']);
  const c2 = fakeClient({ bookings: ['73003'] });
  const s2 = await runCycle({ makeClient: () => c2 });
  assert.deepEqual(c2.calls.sent, []);
  assert.deepEqual(s2.skippedStore, ['73003']);
});

test('SIGTERM mid-cycle: the booking in progress is finished, the rest waits', async () => {
  const c = fakeClient({
    bookings: ['73011', '73012', '73013'],
    onOpenChat: () => stop.requestStop('SIGTERM'),
  });
  const s = await runCycle({ makeClient: () => c });
  assert.deepEqual(c.calls.sent, ['73011']);
  assert.deepEqual(c.calls.openChat, ['73011']);
  assert.equal(s.interrupted, 'SIGTERM');
});
