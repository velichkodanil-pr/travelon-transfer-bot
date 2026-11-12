// Fast reads (chat feed + edit-page HTML), the "open the chat only to send" rule,
// manual manager asks, the per-cycle send cap and GHOST_RECHECK.
// Fake browser clients only — no Playwright, no network.
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

let runBulgaria;
let runCycle;
let stop;
let config;
let store;
let BG_ASK_PATTERNS;
let ALREADY_SENT_PATTERNS;
let TravelonClient;
before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-fast-'));
  process.env.DRY_RUN = 'false';
  process.env.REPORT_ENABLED = 'false';
  process.env.BUSWARN_ENABLED = 'false';
  process.env.INSDOC_ENABLED = 'false';
  process.env.ITRAVEL_EMAIL = 'test@example.com';
  process.env.ITRAVEL_PASSWORD = 'x';
  ({ runBulgaria } = await import('../src/bulgaria.js'));
  ({ runCycle } = await import('../src/runCycle.js'));
  stop = await import('../src/stop.js');
  store = await import('../src/store.js');
  ({ config, BG_ASK_PATTERNS, ALREADY_SENT_PATTERNS } = await import('../src/config.js'));
  ({ TravelonClient } = await import('../src/travelon.js'));
});
afterEach(() => {
  stop.resetStop();
  config.ghostRecheck = false;
  config.bulgaria.maxSendsPerRun = 25;
});

const ITRAVEL = '6572';

function dmy(daysFromToday) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromToday);
  const [y, m, dd] = d.toISOString().slice(0, 10).split('-');
  return `${dd}.${m}.${y}`;
}
const row = (id, supplierText = 'Itravel - 88001') => ({
  text: `${id} Болгарія Сонячний берег ${supplierText}`,
  status: '',
  checkin: dmy(10),
  bookingDate: dmy(-5),
  departure: dmy(9),
});

// A TravelON client that supports the fast reads. `feed[id] === null` makes the
// chat feed unreadable for that booking (-> drawer fallback).
function fastTravelon({ rows = [], comments = {}, feed = {}, panel = {} } = {}) {
  const calls = { openEdit: [], openChat: [], fastEdit: [], fastChat: [], sent: [] };
  let chatId = null;
  let pageNo = 1;
  return {
    calls,
    page: { async goto() { pageNo += 1; }, async waitForTimeout() {} },
    async applyBusFilter() { pageNo = 1; },
    async applyBulgariaSupplierFilter() { pageNo = 1; },
    async scanRows() { return pageNo === 1 ? rows : []; },
    async readEditFieldsFast(id) {
      calls.fastEdit.push(id);
      return { user: comments[id] || '', admin: '', telephone: '' };
    },
    async readChatTextFast(id) {
      calls.fastChat.push(id);
      return feed[id] === undefined ? '' : feed[id];
    },
    async openEdit(id) { calls.openEdit.push(id); },
    async readComments() { return { user: '', admin: '' }; },
    async readAgentPhone() { return ''; },
    async openChat(id) { chatId = id; calls.openChat.push(id); },
    async readChatPanelText() { return panel[chatId] || ''; },
    async closeChat() { chatId = null; },
    async appendPhonesToComments() { return { saved: true }; },
    async sendChatMessage({ text, bundleId }) {
      assert.equal(String(bundleId), String(chatId), 'sends only into the booking whose chat is open');
      calls.sent.push({ id: String(bundleId), text });
    },
    async screenshot() {},
  };
}
const noItravel = () => ({
  async init() {},
  async login() {},
  async sendPhones() { return { sent: true, verified: true, alreadyPresent: false, missing: [] }; },
  async close() {},
});

test('patterns: managers\' manual asks count as asked; an agent\'s reply with a number does not', () => {
  for (const t of [
    'Доброго дня, шановні колеги. Просимо надати контакти туристів для водія. Дякуємо.',
    'Шановні колеги, просимо також надати контакти туристів для водія. Дякуємо.',
    'Шановні колеги, прохання надіслати контакти туристів',
    'колеги, прошу прописати тел туристів для трансферу',
    'колеги, прохання вказати тел туристки для трансферу',
    'Шановні колеги, просимо надіслати номер телефону туристів для контакту з перевізниками. Дякуємо.',
  ]) {
    assert.ok(BG_ASK_PATTERNS.some((re) => re.test(t)), t);
  }
  assert.ok(!BG_ASK_PATTERNS.some((re) => re.test('колеги, контакт туристів 0974184193')));
  // \w does not match Cyrillic: "контакт\w*\s+турист" never matched "контакти туристів".
  assert.ok(ALREADY_SENT_PATTERNS.some((re) => re.test('Просимо надати контакти туристів для водія')));
});

test('BG waiting booking: read via the feed + page HTML, nothing opened', async () => {
  await store.setWatch('75001', { askedAt: new Date().toISOString() });
  const t = fastTravelon({ rows: [row('75001')], feed: { 75001: 'Нова заявка 75001' } });
  const s = await runBulgaria(t, { makeItravel: noItravel });
  assert.deepEqual(s.waiting, ['75001']);
  assert.deepEqual(t.calls.openEdit, []);
  assert.deepEqual(t.calls.openChat, []);
  assert.deepEqual(t.calls.sent, []);
  assert.deepEqual(t.calls.fastEdit, ['75001']);
  assert.deepEqual(s.errors, []);
});

test('BG new booking: the chat drawer is opened only to post the ask', async () => {
  const t = fastTravelon({ rows: [row('75002')], feed: { 75002: 'Нова заявка 75002' } });
  const s = await runBulgaria(t, { makeItravel: noItravel });
  assert.deepEqual(s.asked, ['75002']);
  assert.deepEqual(t.calls.openChat, ['75002']);
  assert.deepEqual(t.calls.sent, [{ id: '75002', text: config.bulgaria.askText }]);
  assert.deepEqual(t.calls.openEdit, []);
});

test('BG: a manager already asked by hand -> the bot does not ask again', async () => {
  const t = fastTravelon({
    rows: [row('75003')],
    feed: { 75003: 'Повідомлення по заявці 75003\nДоброго дня, шановні колеги. Просимо надати контакти туристів для водія. Дякуємо.' },
  });
  const s = await runBulgaria(t, { makeItravel: noItravel });
  assert.deepEqual(s.asked, []);
  assert.deepEqual(s.waiting, ['75003']);
  assert.deepEqual(t.calls.sent, []);
  assert.deepEqual(t.calls.openChat, []);
});

test('BG: the agent\'s number in the chat feed is found without opening the drawer', async () => {
  const t = fastTravelon({
    rows: [row('75004', 'Itravel')], // no Itravel order number -> waits for it
    feed: { 75004: 'Повідомлення по заявці 75004\nконтакт туристів +380 (97) 714 37 29 Олена' },
  });
  const s = await runBulgaria(t, { makeItravel: noItravel });
  assert.deepEqual(t.calls.openChat, []);
  assert.deepEqual(t.calls.openEdit, ['75004'], 'the edit page is opened only to write the phone');
  assert.deepEqual(s.comments, ['75004']);
  assert.deepEqual(s.asked, []);
});

test('BG: unreadable feed falls back to the drawer', async () => {
  const t = fastTravelon({ rows: [row('75005')], feed: { 75005: null }, panel: { 75005: '' } });
  const s = await runBulgaria(t, { makeItravel: noItravel });
  assert.deepEqual(t.calls.openChat, ['75005']);
  assert.deepEqual(s.asked, ['75005']);
});

test('BG: per-cycle send cap — the rest wait for the next cycle, unrecorded', async () => {
  config.bulgaria.maxSendsPerRun = 2;
  const ids = ['75011', '75012', '75013'];
  const t = fastTravelon({ rows: ids.map((id) => row(id)) });
  const s = await runBulgaria(t, { makeItravel: noItravel });
  assert.deepEqual(s.asked, ['75011', '75012']);
  assert.deepEqual(s.waiting, ['75013']);
  assert.equal((await store.getWatch('75013'))?.askedAt, undefined, 'not marked as asked');
});

test('GHOST_RECHECK: an ask recorded but missing from the chat is sent again; off = trusted', async () => {
  await store.setWatch('75021', { askedAt: '2026-11-01T10:00:00Z', remindedAt: '2026-11-02T10:00:00Z' });
  const off = fastTravelon({ rows: [row('75021')], feed: { 75021: 'Нова заявка 75021' } });
  const s1 = await runBulgaria(off, { makeItravel: noItravel });
  assert.deepEqual(s1.asked, []);
  assert.deepEqual(s1.waiting, ['75021']);

  config.ghostRecheck = true;
  const on = fastTravelon({ rows: [row('75021')], feed: { 75021: 'Нова заявка 75021' } });
  const s2 = await runBulgaria(on, { makeItravel: noItravel });
  assert.deepEqual(s2.ghosts, ['75021']);
  assert.deepEqual(s2.asked, ['75021']);
  assert.equal((await store.getWatch('75021')).remindedAt, null, 'reminder clock restarts');
});

test('GHOST_RECHECK never trusts the drawer fallback (an empty panel must not re-ask)', async () => {
  await store.setWatch('75022', { askedAt: '2026-11-01T10:00:00Z', remindedAt: '2026-11-02T10:00:00Z' });
  config.ghostRecheck = true;
  const t = fastTravelon({ rows: [row('75022')], feed: { 75022: null } });
  const s = await runBulgaria(t, { makeItravel: noItravel });
  assert.deepEqual(s.asked, []);
  assert.deepEqual(s.ghosts, []);
});

// --- generic 4-country flow -------------------------------------------------
function genericClient({ bookings, feed = {} }) {
  const calls = { openChat: [], sent: [] };
  let chatId = null;
  return {
    calls,
    async init() {},
    async login() {},
    async openRequests() {},
    async listUpcomingMatching() {
      return bookings.map((id) => ({ id, country: 'Греція', status: '', dateISO: '2026-11-01' }));
    },
    async readChatTextFast(id) { return feed[id] === undefined ? '' : feed[id]; },
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

test('generic: a manager\'s Cyrillic request in the feed is recognised, nothing opened', async () => {
  config.bulgaria.enabled = false;
  const c = genericClient({
    bookings: ['76001'],
    feed: { 76001: 'Повідомлення по заявці 76001\nПросимо надати контакти туристів для водія.' },
  });
  const s = await runCycle({ makeClient: () => c });
  assert.deepEqual(s.skippedAlready, ['76001']);
  assert.deepEqual(c.calls.openChat, []);
  assert.deepEqual(c.calls.sent, []);
});

test('generic: no request yet -> the drawer is opened to send; ghost recheck re-sends', async () => {
  config.bulgaria.enabled = false;
  const c1 = genericClient({ bookings: ['76002'], feed: { 76002: 'Нова заявка 76002' } });
  const s1 = await runCycle({ makeClient: () => c1 });
  assert.deepEqual(s1.sent, ['76002']);
  assert.deepEqual(c1.calls.openChat, ['76002']);

  // Recorded as sent, but (as before 11.2026) it never reached the chat.
  const c2 = genericClient({ bookings: ['76002'], feed: { 76002: 'Нова заявка 76002' } });
  const s2 = await runCycle({ makeClient: () => c2 });
  assert.deepEqual(s2.skippedStore, ['76002'], 'trusted while GHOST_RECHECK is off');

  config.ghostRecheck = true;
  const c3 = genericClient({ bookings: ['76002'], feed: { 76002: 'Нова заявка 76002' } });
  const s3 = await runCycle({ makeClient: () => c3 });
  assert.deepEqual(s3.sent, ['76002']);
});

// --- delivery check ------------------------------------------------------------
test('chatHasMessage matches through the site prefix, <br> and punctuation', async () => {
  const c = new TravelonClient();
  c.fetchChatNotifies = async () => [
    { text: 'Нова заявка 75100' },
    { text: "Повідомлення по заявці 75100\nШановні колеги, просимо надіслати телефон туристів для зв'язку з трансферменами. Дякуємо." },
  ];
  assert.equal(
    await c.chatHasMessage('75100', "Шановні колеги, просимо надіслати телефон туристів для зв'язку з трансферменами. Дякуємо."),
    true
  );
  assert.equal(await c.chatHasMessage('75100', 'Шановні колеги! Звертаємо вашу увагу'), false);
  c.fetchChatNotifies = async () => null;
  assert.equal(await c.chatHasMessage('75100', 'будь-що'), null);
});
