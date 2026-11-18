// «Телефон туриста» in the bus-tour basket (Інна Корнієнко, 17.11.2026):
// - the tourist's number in the field goes to the supplier, nobody is asked;
// - the AGENT's own number there (user card or booking Telephone) -> ONE message
//   «вкажіть вірний телефон туристів» into the booking chat;
// - no number anywhere -> the agent is NOT asked any more;
// - the transfer flow (generic) no longer covers Spain and Albania.
// Fake browser clients only — no Playwright, no network.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

let runBulgaria;
let config;
let phone;
before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-field-'));
  process.env.DRY_RUN = 'false';
  process.env.REPORT_ENABLED = 'false';
  process.env.ELINE_EMAIL = 'test@example.com';
  process.env.ELINE_PASSWORD = 'x';
  process.env.ITRAVEL_EMAIL = 'test@example.com';
  process.env.ITRAVEL_PASSWORD = 'x';
  delete process.env.BG_ASK_ENABLED;
  delete process.env.TARGET_COUNTRIES;
  ({ runBulgaria } = await import('../src/bulgaria.js'));
  ({ config } = await import('../src/config.js'));
  phone = await import('../src/phone.js');
});

const ITRAVEL = '6572';
const ELINE = '1259';
const CARD = 'Офис +380687892498: +380669196923'; // as printed on the user card

function dmy(daysFromToday) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromToday);
  const [y, m, dd] = d.toISOString().slice(0, 10).split('-');
  return `${dd}.${m}.${y}`;
}
function row(id, supplierText) {
  return { text: `${id} Болгарія Несебр ${supplierText}`, status: '', checkin: dmy(10), bookingDate: dmy(-1), departure: dmy(9) };
}

// edit[id] = { tourists: [...], telephone, card, comments }; feed[id] = chat text.
function fakeTravelon({ rows = {}, edit = {}, feed = {} } = {}) {
  const calls = { sent: [], openChat: [], appended: [] };
  let chatId = null;
  let list = [];
  let pageNo = 1;
  return {
    calls,
    edit,
    feed,
    page: { async goto() { pageNo += 1; }, async waitForTimeout() {} },
    async applyBusFilter(partnerId) { list = rows[partnerId] || []; pageNo = 1; },
    async applyBulgariaSupplierFilter(partnerId) { list = rows[partnerId] || []; pageNo = 1; },
    async scanRows() { return pageNo === 1 ? list : []; },
    async readEditFieldsFast(id) {
      const e = edit[id] || {};
      return { user: e.comments || '', admin: '', telephone: e.telephone || '', tourists: e.tourists || [], card: e.card ?? CARD };
    },
    async readChatTextFast(id) { return feed[id] || ''; },
    async openEdit() {},
    async readComments() { return { user: '', admin: '' }; },
    async readAgentPhone() { return ''; },
    async openChat(id) { chatId = id; calls.openChat.push(id); },
    async readChatPanelText() { return ''; },
    async closeChat() { chatId = null; },
    async appendPhonesToComments(phones) { calls.appended.push(phones); return { saved: true }; },
    async sendChatMessage({ text, bundleId, subject }) {
      assert.equal(String(bundleId), String(chatId), 'sends only into the booking whose chat is open');
      calls.sent.push({ id: String(bundleId), text, subject });
      feed[bundleId] = `${feed[bundleId] || ''}\n${text}`;
    },
    async screenshot() {},
  };
}
function fakeEline() {
  const written = [];
  return {
    written,
    make: () => ({
      async init() {}, async login() {}, async close() {},
      async openBooking(n) { this.n = n; },
      async readPassengerPhones() { return []; },
      async writePassengerPhones(phones) {
        written.push({ n: this.n, phones });
        return { count: phones.length, plan: phones, verified: true, present: phones };
      },
    }),
  };
}
function fakeItravel() {
  const sent = [];
  return {
    sent,
    make: () => ({
      async init() {}, async login() {}, async close() {},
      async sendPhones(orderNo, phones) {
        sent.push({ orderNo, phones });
        return { sent: true, verified: true, alreadyPresent: false, missing: phones };
      },
    }),
  };
}
const status = (s, id) => s.rows.find((r) => r.bookingId === id)?.status;

test('defaults: transfer flow = Греція + Хорватія; bus flow does not ask', () => {
  assert.deepEqual(config.targetCountries, ['Греція', 'Хорватія']);
  assert.equal(config.bulgaria.askEnabled, false);
  assert.match(config.bulgaria.wrongPhoneText, /вірний телефон туристів/);
});

test('phone helpers: the agent is known by the card and the booking Telephone', () => {
  const keys = phone.agentPhoneKeys(['0(984584866', 'Офис 0(96)387-93-41']);
  assert.deepEqual([...keys].sort(), ['963879341', '984584866']);
  const c = phone.classifyTouristPhones(['+380963879341', ''], keys);
  assert.equal(c.agentOnly, true);
  assert.deepEqual(phone.classifyTouristPhones(['', ''], keys), { own: [], foreign: [], agentOnly: false, empty: true });
  const mixed = phone.classifyTouristPhones(['096 387 93 41', '+380 67 915 42 00'], keys);
  assert.deepEqual(mixed.own, ['+380679154200']);
  assert.equal(mixed.agentOnly, false);
  assert.deepEqual(phone.classifyTouristPhones(['+373 69 123 456'], keys).foreign, ['+373 69 123 456']);
});

test("the tourist's number in the field goes to Eline; nobody is asked", async () => {
  const el = fakeEline();
  const t = fakeTravelon({
    rows: { [ELINE]: [row('75001', 'E.Line Tour - 214001')] },
    edit: { 75001: { tourists: ['+380679154200', '+380679154200', ''], telephone: '+380687892498' } },
  });
  const s = await runBulgaria(t, { makeEline: el.make, makeItravel: fakeItravel().make });
  assert.deepEqual(el.written, [{ n: '214001', phones: ['+380679154200'] }]);
  assert.deepEqual(t.calls.sent, []);
  assert.deepEqual(t.calls.appended, [], 'the number is already in the booking: comments untouched');
  assert.equal(status(s, '75001'), 'Зроблено');
});

test("the agent's own number in the field -> one message, then wait, then deliver once fixed", async () => {
  const it = fakeItravel();
  const t = fakeTravelon({
    rows: { [ITRAVEL]: [row('75002', 'Itravel - 99002')] },
    // the agent typed the number from their user card into both passenger rows
    edit: { 75002: { tourists: ['+380669196923', '0669196923'], telephone: '+380687892498' } },
  });
  const s1 = await runBulgaria(t, { makeEline: fakeEline().make, makeItravel: it.make });
  assert.equal(t.calls.sent.length, 1);
  assert.equal(t.calls.sent[0].text, config.bulgaria.wrongPhoneText);
  assert.equal(t.calls.sent[0].subject, config.bulgaria.subject);
  assert.deepEqual(s1.wrongPhone, ['75002']);
  assert.equal(it.sent.length, 0, "the agent's number never goes to the supplier");
  assert.equal(status(s1, '75002'), 'Телефон агента замість туриста — попросили вказати вірний');

  const s2 = await runBulgaria(t, { makeEline: fakeEline().make, makeItravel: it.make });
  assert.equal(t.calls.sent.length, 1, 'asked once only');
  assert.deepEqual(s2.wrongPhoneWaiting, ['75002']);
  assert.equal(status(s2, '75002'), 'Очікує вірний телефон туриста');

  t.edit['75002'].tourists = ['+380501112233', ''];
  const s3 = await runBulgaria(t, { makeEline: fakeEline().make, makeItravel: it.make });
  assert.deepEqual(it.sent, [{ orderNo: '99002', phones: ['+380501112233'] }]);
  assert.equal(status(s3, '75002'), 'Зроблено');
  assert.equal(t.calls.sent.length, 1);
});

test("the booking Telephone counts as the agent's number too; a message already in the chat is not repeated", async () => {
  const t = fakeTravelon({
    rows: { [ITRAVEL]: [row('75003', 'Itravel - 99003'), row('75004', 'Itravel - 99004')] },
    edit: {
      75003: { tourists: ['380 97 678 05 62'], telephone: '+380976780562', card: '' },
      75004: { tourists: ['+380976780562'], telephone: '+380976780562', card: '' },
    },
    feed: { 75004: 'Шановні колеги, прохання вказати вірний телефон туристів для зв`язку з водієм' },
  });
  const s = await runBulgaria(t, { makeEline: fakeEline().make, makeItravel: fakeItravel().make });
  assert.deepEqual(t.calls.sent.map((x) => x.id), ['75003']);
  assert.equal(status(s, '75004'), 'Очікує вірний телефон туриста');
});

test('one passenger with an own number is enough: no message about the other', async () => {
  const it = fakeItravel();
  const t = fakeTravelon({
    rows: { [ITRAVEL]: [row('75005', 'Itravel - 99005')] },
    edit: { 75005: { tourists: ['+380687892498', '+380631234567'], telephone: '+380687892498' } },
  });
  await runBulgaria(t, { makeEline: fakeEline().make, makeItravel: it.make });
  assert.deepEqual(t.calls.sent, []);
  assert.deepEqual(it.sent, [{ orderNo: '99005', phones: ['+380631234567'] }]);
});

test('no number anywhere -> the agent is not asked any more (and not reminded)', async () => {
  const t = fakeTravelon({
    rows: { [ITRAVEL]: [row('75006', 'Itravel - 99006')] },
    edit: { 75006: { tourists: ['', ''], telephone: '+380687892498' } },
  });
  const s = await runBulgaria(t, { makeEline: fakeEline().make, makeItravel: fakeItravel().make });
  assert.deepEqual(t.calls.sent, []);
  assert.deepEqual(t.calls.openChat, []);
  assert.deepEqual(s.noPhone, ['75006']);
  assert.equal(status(s, '75006'), 'Без телефону — не питаємо');
  assert.match(s.report, /No phone, not asked: 1 \(75006\)/);
});

test('an old booking with the phone in the comments still reaches the supplier', async () => {
  const it = fakeItravel();
  const t = fakeTravelon({
    rows: { [ITRAVEL]: [row('75007', 'Itravel - 99007')] },
    edit: { 75007: { tourists: [], comments: 'тел туриста 067 111 22 33', telephone: '+380687892498' } },
  });
  const s = await runBulgaria(t, { makeEline: fakeEline().make, makeItravel: it.make });
  assert.deepEqual(it.sent, [{ orderNo: '99007', phones: ['+380671112233'] }]);
  assert.equal(status(s, '75007'), 'Зроблено');
});

test('a non-UA tourist number is not guessed into the supplier fields and nobody is asked', async () => {
  const it = fakeItravel();
  const t = fakeTravelon({
    rows: { [ITRAVEL]: [row('75008', 'Itravel - 99008')] },
    edit: { 75008: { tourists: ['+373 69 123 456'], telephone: '+380687892498' } },
  });
  const s = await runBulgaria(t, { makeEline: fakeEline().make, makeItravel: it.make });
  assert.deepEqual(t.calls.sent, []);
  assert.equal(it.sent.length, 0);
  assert.deepEqual(s.foreignPhone, ['75008']);
});
