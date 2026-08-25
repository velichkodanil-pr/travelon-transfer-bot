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

  // Read the current per-passenger phone field values (non-empty, trimmed).
  // Used to detect a booking whose phone is ALREADY in the portal so we never
  // rewrite or re-ask for it.
  async readPassengerPhones() {
    const inputs = this.page.locator(sel.eline.passengerPhone);
    const count = await inputs.count().catch(() => 0);
    const out = [];
    for (let i = 0; i < count; i++) {
      const v = await inputs.nth(i).inputValue().catch(() => '');
      if (v && v.trim()) out.push(v.trim());
    }
    return out;
  }

  // Fill the per-passenger phone inputs, save, then RE-READ the form from the
  // server to prove the number actually persisted.
  // Returns { count, plan:[...], wrote, verified, present, error }.
  // `verified` is the only field callers may treat as "the supplier really has it":
  // fills and clicks can silently fail, so we never assume success.
  async writePassengerPhones(phones, { dryRun }) {
    const inputs = this.page.locator(sel.eline.passengerPhone);
    const count = await inputs.count().catch(() => 0);
    if (count === 0)
      return { count: 0, plan: [], wrote: false, verified: false, present: [], error: 'no phone inputs' };
    const plan = assignPhones(phones, count);
    if (dryRun) return { count, plan, wrote: false, verified: false, present: [] };
    for (let i = 0; i < count; i++) {
      await inputs.nth(i).fill(plan[i] ?? '').catch(() => {});
    }
    const save = this.page.locator(sel.eline.saveButton).filter({ hasText: /Зберегти|Save/i }).first();
    if ((await save.count().catch(() => 0)) === 0) {
      // No Save button -> nothing could have been persisted. Never claim success.
      return { count, plan, wrote: false, verified: false, present: [], error: 'save button not found' };
    }
    await save.click().catch(() => {});
    await this.page.waitForTimeout(2000);
    // Reload so we read what the SERVER stored, not the values we just typed in.
    await this.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await this.page.waitForTimeout(1500);
    const present = await this.readPassengerPhones();
    const tail = (v) => String(v || '').replace(/\D+/g, '').slice(-9);
    const want = plan.filter(Boolean).map(tail).filter((t) => t.length === 9);
    const got = present.map(tail);
    const verified = want.length > 0 && want.every((w) => got.includes(w));
    return { count, plan, wrote: true, verified, present };
  }
}
