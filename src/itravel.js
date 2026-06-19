// ItravelClient — Playwright client for the Itravel supplier CLIENT cabinet
// (i-travel.com.ua, WordPress). SEPARATE login from TravelON.
// Login: standard WordPress wp-login.php (log/pwd). Auth is then verified by
// loading the profile page (wp-login redirects elsewhere after a successful login).
// Messaging: open /client-profile/?id=<orderNo> -> click the order's "Повідомлення"
// link (openChat, page supplies the token) -> read thread (dedup) -> type -> ВІДПРАВИТИ.
import { chromium } from 'playwright';
import { config, sel } from './config.js';
import { log } from './logger.js';
import { extractPhones, buildPhoneMessage } from './phone.js';

export class ItravelClient {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async init() {
    this.browser = await chromium.launch({
      headless: config.headless,
      slowMo: config.slowMo || undefined,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    this.context = await this.browser.newContext({
      locale: 'uk-UA',
      timezoneId: config.tz,
      viewport: { width: 1400, height: 1000 },
    });
    this.context.setDefaultTimeout(config.navTimeout);
    this.page = await this.context.newPage();
  }

  async close() {
    await this.browser?.close().catch(() => {});
  }

  async firstExisting(selectors, { timeout = 2500 } = {}) {
    const arr = Array.isArray(selectors) ? selectors : [selectors];
    const deadline = Date.now() + timeout;
    do {
      for (const s of arr) {
        const loc = this.page.locator(s).first();
        if ((await loc.count().catch(() => 0)) > 0) return loc;
      }
      await this.page.waitForTimeout(150);
    } while (Date.now() < deadline);
    return null;
  }

  profileUrl() {
    return `${config.itravel.baseUrl}${config.itravel.profilePath}`;
  }

  // Logged in == the order-search input is present on the profile page.
  async isLoggedIn() {
    return Boolean(await this.firstExisting(sel.itravel.loggedInMarker, { timeout: 1500 }));
  }

  async login() {
    if (!config.itravel.email || !config.itravel.password) {
      throw new Error('ITRAVEL_EMAIL / ITRAVEL_PASSWORD not set');
    }
    log.info('[Itravel] Logging in…');
    // 1) Maybe already authenticated (warm cookie) — check on the profile page.
    await this.page.goto(this.profileUrl(), { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(1200);
    if (await this.isLoggedIn()) {
      log.info('[Itravel] Already authenticated.');
      return;
    }
    // 2) Submit the WordPress login form (wp-login.php: log / pwd / wp-submit).
    await this.page.goto(config.itravel.loginUrl, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(1000);
    const e = await this.firstExisting(sel.itravel.loginEmail);
    const p = await this.firstExisting(sel.itravel.loginPassword);
    if (!e || !p) {
      throw new Error('[Itravel] Login form not found (check ITRAVEL_LOGIN_URL / sel.itravel.login*)');
    }
    await e.fill(config.itravel.email);
    await p.fill(config.itravel.password);
    const s = await this.firstExisting(sel.itravel.loginSubmit);
    if (s) await s.click();
    else await p.press('Enter');
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    await this.page.waitForTimeout(2500);
    // 3) Verify by loading the profile page (wp-login redirects elsewhere on success).
    await this.page.goto(this.profileUrl(), { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(1200);
    if (!(await this.isLoggedIn())) {
      throw new Error('[Itravel] Login failed (profile marker not found after submit)');
    }
    log.info('[Itravel] Login OK.');
  }

  // Open the "Повідомлення" modal for one order. Throws with a precise reason.
  async openBookingMessages(orderNo) {
    const url = `${this.profileUrl()}?id=${encodeURIComponent(orderNo)}`;
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(1500);
    const btn = await this.firstExisting(sel.itravel.messageButton, { timeout: 10000 });
    if (!btn) {
      const loggedIn = await this.isLoggedIn();
      if (!loggedIn) {
        throw new Error(
          `Itravel cabinet not logged in when opening order ${orderNo} (login failed — check ITRAVEL_LOGIN_URL / creds / sel.itravel.login*)`
        );
      }
      throw new Error(
        `order ${orderNo} not found in Itravel cabinet (logged in, but no "Повідомлення" button — wrong order number, or archived/past booking)`
      );
    }
    await btn.click({ timeout: 5000 }).catch(() => {});
    const input = await this.firstExisting(sel.itravel.chatInput, { timeout: 8000 });
    if (!input) throw new Error(`chat did not open for order ${orderNo}`);
    await this.page.waitForTimeout(500);
    return true;
  }

  async readThreadText() {
    const loc = this.page.locator(sel.itravel.chatMessages).first();
    if ((await loc.count().catch(() => 0)) > 0) return (await loc.innerText().catch(() => '')) || '';
    const pop = this.page.locator(sel.itravel.chatPopup).first();
    return (await pop.innerText().catch(() => '')) || '';
  }

  async closeChat() {
    const c = await this.firstExisting(sel.itravel.closeButton, { timeout: 1000 });
    if (c) await c.click({ timeout: 2000 }).catch(() => {});
    else await this.page.keyboard.press('Escape').catch(() => {});
    await this.page.waitForTimeout(300);
  }

  // Send the tourist phone(s) into the order's thread, skipping any already present.
  // Returns { sent, alreadyPresent, missing, text }. In dryRun, computes but sends nothing.
  async sendPhones(orderNo, phones, { dryRun }) {
    await this.openBookingMessages(orderNo);
    const thread = await this.readThreadText();
    const present = new Set(extractPhones(thread));
    const missing = (phones || []).filter((p) => !present.has(p));
    if (!missing.length) {
      await this.closeChat().catch(() => {});
      return { sent: false, alreadyPresent: true, missing: [], text: '' };
    }
    const text = buildPhoneMessage(config.itravel.messageText, missing);
    if (dryRun) {
      await this.closeChat().catch(() => {});
      return { sent: false, alreadyPresent: false, missing, text, dry: true };
    }
    const input = await this.firstExisting(sel.itravel.chatInput, { timeout: 4000 });
    if (!input) throw new Error(`chat input not found for order ${orderNo}`);
    await input.click().catch(() => {});
    await input.fill(text);
    const send = await this.firstExisting(sel.itravel.sendButton, { timeout: 4000 });
    if (!send) throw new Error(`send button not found for order ${orderNo}`);
    await send.click({ timeout: 5000 }).catch(async () => {
      await send.click({ timeout: 3000, force: true });
    });
    await this.page.waitForTimeout(1500);
    await this.closeChat().catch(() => {});
    return { sent: true, alreadyPresent: false, missing, text };
  }
}
