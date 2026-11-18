// Transfer flow (Греція / Хорватія) vs «Телефон туриста» — 74742, 18.11.2026:
// Греція + автобус Itravel, the tourist's number was in the booking, and the bot
// still posted «просимо надіслати телефон туристів для зв'язку з трансферменами».
// Fake browser clients only — no Playwright, no network.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

let runCycle;
let TravelonClient;
let rowBusCarrier;
before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-generic-phone-'));
  process.env.DRY_RUN = 'false';
  process.env.REPORT_ENABLED = 'false';
  process.env.BG_ENABLED = 'true'; // the bus flow is on, as in production
  process.env.BUSWARN_ENABLED = 'false';
  process.env.INSDOC_ENABLED = 'false';
  delete process.env.TARGET_COUNTRIES;
  delete process.env.GENERIC_TRANSFER_ONLY_COUNTRIES;
  ({ runCycle } = await import('../src/runCycle.js'));
  ({ TravelonClient, rowBusCarrier } = await import('../src/travelon.js'));
});

// bookings: [{ id, country, transfer, busCarrier }]; edit[id] = { tourists, telephone, card }
function client(bookings, edit = {}) {
  const calls = { feed: [], edit: [], sent: [] };
  let chatId = null;
  return {
    calls,
    async init() {},
    async login() {},
    async openRequests() {},
    async listUpcomingMatching() {
      return bookings.map((b) => ({ status: '', dateISO: '2026-11-17', transfer: true, busCarrier: '', ...b }));
    },
    async readEditFieldsFast(id) {
      calls.edit.push(id);
      const e = edit[id] || {};
      return { user: '', admin: '', telephone: e.telephone || '', tourists: e.tourists || [], card: e.card || '' };
    },
    async readChatTextFast(id) { calls.feed.push(id); return `Нова заявка ${id}`; },
    async openChat(id) { chatId = id; },
    async chatPanelVisible() { return true; },
    async chatAlreadyRequested() { return false; },
    async readChatPanelText() { return ''; },
    async closeChat() {},
    async sendMessage() { calls.sent.push(chatId); },
    // the bus flow runs after the transfer flow: nothing to find there
    page: { async goto() {}, async waitForTimeout() {} },
    async applyBusFilter() {},
    async scanRows() { return []; },
    async screenshot() {},
    async close() {},
  };
}

test('rowBusCarrier finds the bus carriers of the bus flow in a list row', () => {
  assert.equal(rowBusCarrier({ text: '74742 Греція Паралія Hotel: Bros Travel Transport: Itravel - 1234 Transfer: Itravel' }), 'Itravel');
  assert.equal(rowBusCarrier({ text: '74740 Туреччина Transport: E.Line Tour - 213837' }), 'E.Line Tour');
  assert.equal(rowBusCarrier({ text: '74800 Греція Transport: RIKI - A (Bus) - 55' }), 'RIKI - A (Bus)');
  assert.equal(rowBusCarrier({ text: '74801 Греція Hotel: Ambotis Greece Transfer: Ambotis Greece' }), '');
  assert.equal(rowBusCarrier({ text: '74802 Греція Hotel: Itravelling Ltd' }), '', 'whole words only');
});

test('listUpcomingMatching carries the bus carrier of each row', async () => {
  const rows = [
    { text: '74742 Греція Паралія Hotel: Bros Travel Transport: Itravel Transfer: Itravel', status: null, checkin: '20.06.2027', bookingDate: '17.11.2026', departure: '', transfer: 'Transfer: Itravel' },
    { text: '74615 Греція Крит Hotel: Ambotis Greece Transfer: Ambotis Greece', status: null, checkin: '01.07.2027', bookingDate: '13.11.2026', departure: '', transfer: 'Transfer: Ambotis Greece' },
  ];
  let pageNo = 1;
  const fake = {
    async applyBusFilter() { pageNo = 1; },
    page: { async goto() { pageNo += 1; }, async waitForTimeout() {} },
    async scanRows() { return pageNo === 1 ? rows : []; },
  };
  const out = await TravelonClient.prototype.listUpcomingMatching.call(fake, {
    statusIds: ['2', '3'], checkinFromDays: 1, maxPages: 2, createdFromISO: '2026-08-30',
  });
  assert.deepEqual(out.map((b) => [b.id, b.busCarrier]), [['74742', 'Itravel'], ['74615', '']]);
});

test('a bus booking is left to the bus flow: no transfer ask, its chat is not even read', async () => {
  const c = client([{ id: '74742', country: 'Греція', busCarrier: 'Itravel' }]);
  const s = await runCycle({ makeClient: () => c });
  assert.deepEqual(c.calls.sent, []);
  assert.deepEqual(c.calls.feed, []);
  assert.deepEqual(s.skippedBus, ['74742']);
});

test("the tourist's own number in «Телефон туриста» -> no ask", async () => {
  const c = client(
    [{ id: '76001', country: 'Греція' }],
    { 76001: { tourists: ['+380679154232', '+380679154232', ''], telephone: '380993387037', card: '380993387037' } }
  );
  const s = await runCycle({ makeClient: () => c });
  assert.deepEqual(c.calls.sent, []);
  assert.deepEqual(s.skippedTouristPhone, ['76001']);
});

test("only the agent's number in the field, or an empty field -> asked as before", async () => {
  const c = client(
    [{ id: '76002', country: 'Греція' }, { id: '76003', country: 'Хорватія' }],
    { 76002: { tourists: ['380993387037'], telephone: '+380 99 338 70 37' }, 76003: { tourists: [] } }
  );
  const s = await runCycle({ makeClient: () => c });
  assert.deepEqual(c.calls.sent, ['76002', '76003']);
  assert.deepEqual(s.skippedTouristPhone, []);
});
