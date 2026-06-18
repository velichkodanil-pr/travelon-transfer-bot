// ElineClient — Playwright client for the Eline supplier portal
// (eline-tour.com.ua, same software as TravelON). Separate login.
import { chromium } from 'playwright';
import { config, sel } from './config.js';
import { log } from './logger.js';
import { assignPhones } from './phone.js';

export class ElineClient {
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

  async isLoggedIn() {
    return Boolean(await this.firstExisting(sel.eline.loggedInMarker, { timeout: 1500 }));
  }

  async login() {
    if (!config.eline.email || !config.eline.password) {
      throw new Error('ELINE_EMAIL / ELINE_PASSWORD not set');
    }
    log.info('[Eline] Logging in…');
    await this.page.goto(config.eline.loginUrl, { waitUntil: 'domcontentloaded' });
    if (await this.isLoggedIn()) {
      log.info('[Eline] Already authenticated.');
      return;
    }
    const e = await this.firstExisting(sel.eline.loginEmail);
    const p = await this.firstExisting(sel.eline.loginPassword);
    if (!e || !p) throw new Error('[Eline] Login form not found (check ELINE_LOGIN_URL / selectors)');
    await e.fill(config.eline.email);
    await p.fill(config.eline.password);
    const s = await this.firstExisting(sel.eline.loginSubmit);
    if (s) await s.click();
    else await p.press('Enter');
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    await this.page.waitForTimeout(2000);
    if (!(await this.isLoggedIn())) throw new Error('[Eline] Login failed');
    log.info('[Eline] Login OK.');
  }

  async openBooking(elineNum) {
    const url = `${config.eline.baseUrl}/book/bundle/edit/${elineNum}`;
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(2500);
  }

  // Fill the per-passenger phone inputs. In dryRun, computes the plan but writes
  // nothing. Returns { count, plan:[...], wrote }.
  async writePassengerPhones(phones, { dryRun }) {
    const inputs = this.page.locator(sel.eline.passengerPhone);
    const count = await inputs.count().catch(() => 0);
    if (count === 0) return { count: 0, plan: [], wrote: false };
    const plan = assignPhones(phones, count);
    if (dryRun) return { count, plan, wrote: false };
    for (let i = 0; i < count; i++) {
      await inputs.nth(i).fill(plan[i] ?? '').catch(() => {});
    }
    const save = this.page.locator(sel.eline.saveButton).filter({ hasText: /Зберегти|Save/i }).first();
    if ((await save.count().catch(() => 0)) > 0) await save.click().catch(() => {});
    await this.page.waitForTimeout(1500);
    return { count, plan, wrote: true };
  }
}
