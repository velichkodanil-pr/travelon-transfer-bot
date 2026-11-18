// "Ask for the tourists' phone only where the booking has a Transfer module"
// (Iryna Honcharova, 15.11.2026: booking 74655, Spain, Hotel + Insurance only,
// was asked for a phone "for the transfer drivers").
// Fake browser clients only — no Playwright, no network.
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

let runCycle;
let config;
let store;
let TravelonClient;
let rowHasTransfer;
before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-only-'));
  process.env.DRY_RUN = 'false';
  process.env.REPORT_ENABLED = 'false';
  process.env.BG_ENABLED = 'false';
  process.env.BUSWARN_ENABLED = 'false';
  process.env.INSDOC_ENABLED = 'false';
  delete process.env.GENERIC_TRANSFER_ONLY_COUNTRIES;
  // These tests are about the transfer-module rule, written on Spain/Albania rows.
  // Since 17.11.2026 the default country list is Греція + Хорватія only.
  process.env.TARGET_COUNTRIES = 'Греція,Албанія,Хорватія,Іспанія';
  ({ runCycle } = await import('../src/runCycle.js'));
  store = await import('../src/store.js');
  ({ config } = await import('../src/config.js'));
  ({ TravelonClient, rowHasTransfer } = await import('../src/travelon.js'));
});
afterEach(() => {
  config.generic.transferOnlyCountries = ['*'];
});

// bookings: [{ id, country, transfer }]  (transfer: true / false / null)
function client(bookings) {
  const calls = { feed: [], openChat: [], sent: [] };
  let chatId = null;
  return {
    calls,
    async init() {},
    async login() {},
    async openRequests() {},
    async listUpcomingMatching() {
      return bookings.map((b) => ({ status: '', dateISO: '2026-11-13', ...b }));
    },
    async readChatTextFast(id) { calls.feed.push(id); return `Нова заявка ${id}`; },
    async openChat(id) { chatId = id; calls.openChat.push(id); },
    async chatPanelVisible() { return true; },
    async chatAlreadyRequested() { return false; },
    async readChatPanelText() { return ''; },
    async closeChat() {},
    async sendMessage() { calls.sent.push(chatId); },
    async screenshot() {},
    async close() {},
  };
}

test('rowHasTransfer: the row\'s "transfer" provider line decides', () => {
  // 74655: the line is rendered, but empty -> no Transfer module.
  assert.equal(rowHasTransfer({ text: '74655 Іспанія Hotel: HotelStone - TF1 Insurance: ЄТС - 1', transfer: '' }), false);
  assert.equal(rowHasTransfer({ text: '74596 Іспанія …', transfer: 'Transfer: Miro Tour Spain' }), true);
  assert.equal(rowHasTransfer({ text: '74000 Греція …', transfer: '   ' }), false);
  // "Transport:" is another module and must not pass for a transfer.
  assert.equal(rowHasTransfer({ text: '74001 Греція Transport: Itravel', transfer: '' }), false);
});

test('rowHasTransfer: no such line in the row -> the label, otherwise "cannot tell"', () => {
  assert.equal(rowHasTransfer({ text: '74002 Греція Hotel: Ambotis Greece Transfer: Itravel', transfer: null }), true);
  assert.equal(rowHasTransfer({ text: '74003 Греція Готель: Ambotis Трансфер: Itravel' }), true);
  assert.equal(rowHasTransfer({ text: '74004 Іспанія Hotel: HotelStone Transport: X', transfer: null }), null);
  assert.equal(rowHasTransfer({ text: '74005 Іспанія Hotel: HotelStone' }), null);
  assert.equal(rowHasTransfer(undefined), null);
});

test('listUpcomingMatching carries the transfer flag of each row', async () => {
  const rows = [
    { text: '74655 Іспанія Коста Адехе Hotel: HotelStone - TF1 Insurance: ЄТС - 1', status: null, checkin: '20.12.2026', bookingDate: '13.11.2026', departure: '', transfer: '' },
    { text: '74596 Іспанія Салоу Hotel: Miro Tour Spain Transfer: Miro Tour Spain', status: null, checkin: '20.06.2027', bookingDate: '12.11.2026', departure: '', transfer: 'Transfer: Miro Tour Spain' },
    { text: '74615 Греція Крит Hotel: Ambotis Greece', status: null, checkin: '01.07.2027', bookingDate: '13.11.2026', departure: '', transfer: null },
    { text: '74700 Єгипет Хургада Hotel: Funtrip Transfer: Funtrip', status: null, checkin: '01.12.2026', bookingDate: '13.11.2026', departure: '', transfer: 'Transfer: Funtrip' },
  ];
  let pageNo = 1;
  const fake = {
    async applyBusFilter() { pageNo = 1; },
    page: { async goto() { pageNo += 1; }, async waitForTimeout() {} },
    async scanRows() { return pageNo === 1 ? rows : []; },
  };
  const out = await TravelonClient.prototype.listUpcomingMatching.call(fake, {
    statusIds: ['2', '3'],
    checkinFromDays: 1,
    maxPages: 3,
    createdFromISO: '2026-08-30',
  });
  assert.deepEqual(
    out.map((b) => [b.id, b.country, b.transfer]),
    [
      ['74655', 'Іспанія', false],
      ['74596', 'Іспанія', true],
      ['74615', 'Греція', null],
    ]
  );
});

test('accommodation only -> not asked, chat untouched, nothing recorded; asked once a transfer appears', async () => {
  const c1 = client([
    { id: '77001', country: 'Іспанія', transfer: false },
    { id: '77002', country: 'Іспанія', transfer: true },
    { id: '77003', country: 'Греція', transfer: false },
  ]);
  const s1 = await runCycle({ makeClient: () => c1 });
  assert.deepEqual(s1.sent, ['77002']);
  assert.deepEqual(s1.skippedNoTransfer, ['77001', '77003']);
  assert.deepEqual(c1.calls.feed, ['77002'], 'the chat of a no-transfer booking is not even read');
  assert.deepEqual(c1.calls.openChat, ['77002']);
  assert.deepEqual(s1.errors, []);
  assert.equal(await store.getSent('77001'), null, 'not recorded as sent');

  // The manager adds a transfer to 77001 -> the next cycle asks.
  const c2 = client([
    { id: '77001', country: 'Іспанія', transfer: true },
    { id: '77002', country: 'Іспанія', transfer: true },
  ]);
  const s2 = await runCycle({ makeClient: () => c2 });
  assert.deepEqual(s2.sent, ['77001']);
  assert.deepEqual(s2.skippedStore, ['77002']);
});

test('a booking asked earlier that has no transfer is left alone (no second message)', async () => {
  await store.markSent('77011', { country: 'Іспанія' });
  const c = client([{ id: '77011', country: 'Іспанія', transfer: false }]);
  const s = await runCycle({ makeClient: () => c });
  assert.deepEqual(s.sent, []);
  assert.deepEqual(s.skippedNoTransfer, ['77011']);
  assert.deepEqual(c.calls.openChat, []);
});

test('module not readable from the list -> never asked blind, one error line names the bookings', async () => {
  const c = client([
    { id: '77021', country: 'Іспанія', transfer: null },
    { id: '77022', country: 'Албанія' },
    { id: '77023', country: 'Іспанія', transfer: true },
  ]);
  const s = await runCycle({ makeClient: () => c });
  assert.deepEqual(s.sent, ['77023']);
  assert.deepEqual(s.transferUnknown, ['77021', '77022']);
  assert.equal(s.errors.length, 1);
  assert.match(s.errors[0], /transfer module not readable.*77021, 77022/);
  assert.equal(await store.getSent('77021'), null);
});

test('GENERIC_TRANSFER_ONLY_COUNTRIES: a list limits the rule, empty switches it off', async () => {
  assert.deepEqual(config.generic.transferOnlyCountries, ['*'], 'default: every country of the flow');

  config.generic.transferOnlyCountries = ['Іспанія'];
  const c1 = client([
    { id: '77031', country: 'Іспанія', transfer: false },
    { id: '77032', country: 'Греція', transfer: false },
  ]);
  const s1 = await runCycle({ makeClient: () => c1 });
  assert.deepEqual(s1.sent, ['77032']);
  assert.deepEqual(s1.skippedNoTransfer, ['77031']);

  config.generic.transferOnlyCountries = [];
  const c2 = client([{ id: '77031', country: 'Іспанія', transfer: false }]);
  const s2 = await runCycle({ makeClient: () => c2 });
  assert.deepEqual(s2.sent, ['77031']);
  assert.deepEqual(s2.skippedNoTransfer, []);
});

test('the bus-carrier ask counts as asked: no second request from the generic flow', async () => {
  const { ALREADY_SENT_PATTERNS } = await import('../src/config.js');
  assert.ok(ALREADY_SENT_PATTERNS.some((re) => re.test(config.bulgaria.askText)), config.bulgaria.askText);
  const c = client([{ id: '77041', country: 'Греція', transfer: true }]);
  c.readChatTextFast = async (id) => {
    c.calls.feed.push(id);
    return `Повідомлення по заявці ${id}\n${config.bulgaria.askText}`;
  };
  const s = await runCycle({ makeClient: () => c });
  assert.deepEqual(s.sent, []);
  assert.deepEqual(s.skippedAlready, ['77041']);
  assert.deepEqual(c.calls.openChat, []);
});
