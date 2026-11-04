// Bulgaria/Eline/Itravel flow with fake browser clients (no Playwright, no network).
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

let runBulgaria;
let stop;
let config;
before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-bg-'));
  process.env.DRY_RUN = 'false';
  process.env.REPORT_ENABLED = 'false';
  process.env.ELINE_EMAIL = 'test@example.com';
  process.env.ELINE_PASSWORD = 'x';
  process.env.ITRAVEL_EMAIL = 'test@example.com';
  process.env.ITRAVEL_PASSWORD = 'x';
  process.env.ELINE_OP_TIMEOUT_SEC = '0.3';
  ({ runBulgaria } = await import('../src/bulgaria.js'));
  stop = await import('../src/stop.js');
  ({ config } = await import('../src/config.js'));
});
afterEach(() => stop.resetStop());

const ITRAVEL = '6572';
const ELINE = '1259';

function dmy(daysFromToday) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromToday);
  const iso = d.toISOString().slice(0, 10);
  const [y, m, dd] = iso.split('-');
  return `${dd}.${m}.${y}`;
}

// A list row the way scanRows() returns it.
function row(id, supplierText) {
  return {
    text: `${id} Болгарія Сонячний берег ${supplierText}`,
    status: '',
    checkin: dmy(10),
    bookingDate: dmy(-5),
    departure: dmy(9),
  };
}

function fakeTravelon({ rows = {}, comments = {}, chats = {}, onOpenChat } = {}) {
  const calls = { filters: [], openEdit: [], openChat: [], appended: [], asked: [] };
  let list = [];
  let pageNo = 1;
  let editId = null;
  let chatId = null;
  return {
    calls,
    page: {
      async goto() {
        pageNo += 1;
      },
      async waitForTimeout() {},
    },
    async applyBusFilter(partnerId, statusIds, from) {
      calls.filters.push({ partnerId, from });
      list = rows[partnerId] || [];
      pageNo = 1;
    },
    async applyBulgariaSupplierFilter(partnerId) {
      calls.filters.push({ partnerId, from: null });
      list = rows[partnerId] || [];
      pageNo = 1;
    },
    async scanRows() {
      return pageNo === 1 ? list : [];
    },
    async openEdit(id) {
      editId = id;
      calls.openEdit.push(id);
    },
    async readComments() {
      return { user: comments[editId] || '', admin: '' };
    },
    async readAgentPhone() {
      return '';
    },
    async openChat(id) {
      chatId = id;
      calls.openChat.push(id);
      if (onOpenChat) onOpenChat(id);
    },
    async readChatPanelText() {
      return chats[chatId] || '';
    },
    async closeChat() {},
    async appendPhonesToComments(phones) {
      calls.appended.push({ id: editId, phones });
      comments[editId] = `${comments[editId] || ''} ${phones.join(' ')}`.trim();
      return { saved: true };
    },
    async sendChatMessage({ text }) {
      calls.asked.push({ id: chatId, text });
    },
    async screenshot() {},
  };
}

function fakeEline({ hangOn = null, portal = {} } = {}) {
  const made = [];
  const make = () => {
    let current = null;
    const client = {
      closed: false,
      opened: [],
      written: [],
      async init() {},
      async login() {},
      async openBooking(n) {
        current = n;
        client.opened.push(n);
        if (n === hangOn && made.indexOf(client) === 0) return new Promise(() => {}); // hangs forever
      },
      async readPassengerPhones() {
        return portal[current] || [];
      },
      async writePassengerPhones(phones) {
        client.written.push({ n: current, phones });
        return { count: 1, plan: phones, wrote: true, verified: true, present: phones };
      },
      async close() {
        client.closed = true;
      },
    };
    made.push(client);
    return client;
  };
  return { make, made };
}

function fakeItravel({ failLogin = null } = {}) {
  const sent = [];
  const made = [];
  return {
    sent,
    made,
    make: () => {
      const client = {
        closed: false,
        async init() {},
        async login() {
          if (failLogin) throw new Error(failLogin);
        },
        async sendPhones(orderNo, phones) {
          sent.push({ orderNo, phones });
          return { sent: true, verified: true, alreadyPresent: false, missing: phones, text: '' };
        },
        async close() {
          client.closed = true;
        },
      };
      made.push(client);
      return client;
    },
  };
}

test('a date in the comments/chat is not a phone: the agent is asked instead (72411 case)', async () => {
  const t = fakeTravelon({
    rows: { [ITRAVEL]: [row('72411', 'Itravel')] },
    comments: { 72411: 'Телефон +380707202712' }, // fake written by the old parser
    chats: { 72411: 'Travelon Бронювання 07.07.2027 12:30\nВиїзд автобуса 07.07.2027 12:30' },
  });
  const s = await runBulgaria(t, { makeEline: fakeEline().make, makeItravel: fakeItravel().make });
  assert.deepEqual(t.calls.appended, []);
  assert.deepEqual(s.asked, ['72411']);
  assert.equal(t.calls.asked[0].text, config.bulgaria.askText);
  assert.deepEqual(s.errors, []);
});

test('Itravel without an order number waits quietly and is not reopened every cycle', async () => {
  const t = fakeTravelon({
    rows: { [ITRAVEL]: [row('72500', 'Itravel')] },
    comments: { 72500: 'контакт туриста 067 123 45 67' },
  });
  const it = fakeItravel();
  const s1 = await runBulgaria(t, { makeEline: fakeEline().make, makeItravel: it.make });
  assert.deepEqual(s1.errors, []);
  assert.deepEqual(s1.waitingRef, ['72500']);
  assert.equal(s1.rows[0].status, 'Очікує № замовлення Itravel');
  assert.equal(it.sent.length, 0);

  const s2 = await runBulgaria(t, { makeEline: fakeEline().make, makeItravel: it.make });
  assert.equal(t.calls.openEdit.filter((x) => x === '72500').length, 1, 'opened only in the first cycle');
  assert.equal(s2.rows[0].status, 'Очікує № замовлення Itravel');
  assert.equal(s2.rows[0].agentNumber, '+380671234567');

  // The order number appears in the list -> the supplier gets the phone.
  t.calls.openEdit.length = 0;
  const t3 = fakeTravelon({
    rows: { [ITRAVEL]: [row('72500', 'Itravel - 88123')] },
    comments: { 72500: 'контакт туриста 067 123 45 67' },
  });
  const s3 = await runBulgaria(t3, { makeEline: fakeEline().make, makeItravel: it.make });
  assert.deepEqual(it.sent, [{ orderNo: '88123', phones: ['+380671234567'] }]);
  assert.equal(s3.rows[0].status, 'Зроблено');
});

test('a phone in the chat next to message timestamps: only the real number is written', async () => {
  const el = fakeEline();
  const t = fakeTravelon({
    rows: { [ELINE]: [row('72600', 'E.Line Tour - 209999')] },
    chats: {
      72600: 'Travelon Бронювання 05.10.2026 09:15\nПросимо номер\nАгент 06.10.2026 08:02\nТурист 0971510451',
    },
  });
  const s = await runBulgaria(t, { makeEline: el.make, makeItravel: fakeItravel().make });
  assert.deepEqual(t.calls.appended, [{ id: '72600', phones: ['+380971510451'] }]);
  assert.deepEqual(el.made[0].written, [{ n: '209999', phones: ['+380971510451'] }]);
  assert.equal(s.rows[0].status, 'Зроблено');
});

test('a hung Eline call costs one booking, not the whole cycle', async () => {
  const el = fakeEline({ hangOn: '201001' });
  const t = fakeTravelon({
    rows: { [ELINE]: [row('72701', 'E.Line Tour - 201001'), row('72702', 'E.Line Tour - 201002')] },
    comments: { 72701: 'тел 0501112233', 72702: 'тел 0661112233' },
  });
  const s = await runBulgaria(t, { makeEline: el.make, makeItravel: fakeItravel().make });
  assert.ok(s.errors.some((e) => /72701: Eline: Eline write did not finish/.test(e)), s.errors.join(' | '));
  assert.equal(el.made[0].closed, true, 'the hung browser is closed');
  assert.equal(el.made.length, 2, 'a fresh portal browser for the next booking');
  assert.deepEqual(el.made[1].written, [{ n: '201002', phones: ['+380661112233'] }]);
  const byId = Object.fromEntries(s.rows.map((r) => [r.bookingId, r.status]));
  assert.equal(byId['72701'], 'Помилка — постачальник не отримав');
  assert.equal(byId['72702'], 'Зроблено');
});

test('the server-side check-in filter is used instead of the whole history', async () => {
  const t = fakeTravelon({ rows: {} });
  await runBulgaria(t, { makeEline: fakeEline().make, makeItravel: fakeItravel().make });
  assert.equal(t.calls.filters.length, config.bulgaria.suppliers.length);
  assert.ok(t.calls.filters.every((f) => /^\d{2}\.\d{2}\.\d{4}$/.test(f.from)), JSON.stringify(t.calls.filters));
});

test('a stop request finishes the current booking and leaves the rest', async () => {
  const t = fakeTravelon({
    rows: { [ITRAVEL]: [row('72801', 'Itravel'), row('72802', 'Itravel')] },
    onOpenChat: () => stop.requestStop('SIGTERM'),
  });
  const s = await runBulgaria(t, { makeEline: fakeEline().make, makeItravel: fakeItravel().make });
  assert.deepEqual(s.asked, ['72801'], 'the booking in progress still gets its message');
  assert.ok(!t.calls.openEdit.includes('72802'));
  assert.equal(s.interrupted, true);
});

test('a cabinet that will not let us in costs one booking, not the whole cycle', async () => {
  // 03-04.11.2026: login failed once and the bot then opened all 86 Itravel bookings
  // one by one (~18 s each) to hear "cabinet not logged in" — the cycle died on the
  // 45-min watchdog seven times. The cabinet now drops out after the first failure.
  const it = fakeItravel({ failLogin: '[Itravel] Login form not found (check ITRAVEL_LOGIN_URL / sel.itravel.login*)' });
  const t = fakeTravelon({
    rows: {
      [ITRAVEL]: [row('72901', 'Itravel - 88001'), row('72902', 'Itravel - 88002'), row('72903', 'Itravel - 88003')],
    },
    comments: { 72901: 'тел 0501112233', 72902: 'тел 0661112233', 72903: 'тел 0671112233' },
  });
  const s = await runBulgaria(t, { makeEline: fakeEline().make, makeItravel: it.make });

  assert.equal(it.made.length, 1, 'the cabinet is tried once, not once per booking');
  assert.equal(it.made[0].closed, true, 'the half-open browser is closed');
  assert.equal(it.sent.length, 0);
  assert.match(s.itravelDown, /Login form not found/);
  assert.deepEqual(s.itravelSkipped, ['72902', '72903'], 'the rest are skipped, not retried one by one');
  assert.equal(s.errors.length, 1, 'one error for the failed login, not one per booking');
  assert.match(s.errors[0], /^72901: Itravel message failed/);
  assert.match(s.report, /Itravel: ❌ вхід у кабінет не вдався/);
  assert.match(s.report, /без повідомлення 2 заявок: 72902, 72903/);

  // The phone is in the booking comments, but the supplier has not got it: the
  // bookings stay open for the next cycle.
  const byId = Object.fromEntries(s.rows.map((r) => [r.bookingId, r.status]));
  assert.equal(byId['72902'], 'Помилка — постачальник не отримав');

  // Cabinet back up -> the same bookings go through on the next cycle.
  const ok = fakeItravel();
  const s2 = await runBulgaria(t, { makeEline: fakeEline().make, makeItravel: ok.make });
  assert.equal(s2.itravelDown, null);
  assert.deepEqual(
    ok.sent.map((x) => x.orderNo),
    ['88001', '88002', '88003']
  );
  assert.deepEqual(s2.errors, []);
});

test('a long skip list stays inside one Telegram message', async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `730${String(i).padStart(2, '0')}`);
  const it = fakeItravel({ failLogin: 'Login form not found' });
  const t = fakeTravelon({
    rows: { [ITRAVEL]: ids.map((id, i) => row(id, `Itravel - 89${String(i).padStart(3, '0')}`)) },
    comments: Object.fromEntries(ids.map((id) => [id, 'тел 0501112233'])),
  });
  const s = await runBulgaria(t, { makeEline: fakeEline().make, makeItravel: it.make });
  assert.equal(s.itravelSkipped.length, 19, 'the first booking carries the error, the rest are skipped');
  assert.match(s.report, / … \+4/, 'the id list is clipped');
});
