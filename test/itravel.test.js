// ItravelClient.login(): the site's login popup endpoint first, wp-login.php only
// as a fallback (wp-login.php is 403 for the bot's IP since 03.11.2026).
// A fake Playwright page — no browser, no network.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let ItravelClient;
before(async () => {
  process.env.ITRAVEL_EMAIL = 'agent@example.com';
  process.env.ITRAVEL_PASSWORD = 'secret';
  ({ ItravelClient } = await import('../src/itravel.js'));
});

// `popup` = what login_user.php answers; `wpLoginStatus` = HTTP status of wp-login.php.
function fakePage({ popup, wpLoginStatus = 403 }) {
  const visited = [];
  let authed = false;
  let current = '';
  const page = {
    visited,
    async goto(url) {
      current = url;
      visited.push(url.replace('https://www.i-travel.com.ua', ''));
      const status = url.includes('wp-login.php') ? wpLoginStatus : 200;
      return { status: () => status };
    },
    async waitForTimeout() {},
    async waitForLoadState() {},
    url: () => current,
    async title() {
      return current.includes('wp-login.php') && wpLoginStatus === 403 ? '403 Forbidden - nginx' : 'Itravel';
    },
    async evaluate(fn, arg) {
      if (arg && 'user' in arg) {
        assert.equal(arg.user, 'agent@example.com');
        assert.equal(arg.pass, 'secret');
        if (popup.status === '200') authed = true;
        return popup;
      }
      return null;
    },
    locator(selector) {
      const present =
        (selector === '#search_booking_number' && authed && current.includes('/client-profile/')) ||
        (selector === 'body');
      const loc = {
        count: async () => (present && selector !== 'body' ? 1 : 0),
        innerText: async () => (current.includes('wp-login.php') ? '403 Forbidden В доступі відмовлено' : ''),
      };
      return { ...loc, first: () => loc };
    },
  };
  return page;
}

function client(page) {
  const c = new ItravelClient();
  c.page = page;
  return c;
}

test('popup login succeeds -> wp-login.php is never requested', async () => {
  const page = fakePage({ popup: { http: 200, status: '200', txt: '' } });
  await client(page).login();
  assert.ok(!page.visited.some((u) => u.includes('wp-login.php')), page.visited.join(' '));
  assert.deepEqual(page.visited, ['/client-profile/', '/', '/client-profile/']);
});

test('popup refuses and wp-login.php is 403 -> one error naming both', async () => {
  const page = fakePage({ popup: { http: 200, status: null, txt: 'Невірний логін або пароль' } });
  await assert.rejects(client(page).login(), (err) => {
    assert.match(err.message, /popup: answer "Невірний логін або пароль"/);
    assert.match(err.message, /wp-login\.php: status=403/);
    assert.match(err.message, /403 Forbidden - nginx/);
    return true;
  });
});
