// TravelonClient — wraps a Playwright browser to reproduce the manual workflow:
//   login -> open requests -> clear check-in dates -> set status filter ->
//   apply -> list today's confirmed bookings in target countries ->
//   per booking: open chat, check for an existing transfer-phone request,
//   send the message (unless dry-run / already requested).
//
// NOTE: selectors live in config.js (`sel`). The site UI is complex; expect to
// fine-tune a few selectors against the live DOM (see README "Tuning").
import path from 'node:path';
import { chromium } from 'playwright';
import { config, sel, ALREADY_SENT_PATTERNS } from './config.js';
import { log } from './logger.js';

const COUNTRY_RE = config.targetCountries.map((c) => ({ name: c, re: new RegExp(c, 'i') }));

function todayISOInTz(tz) {
  // Returns YYYY-MM-DD for "now" in the given timezone.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return parts; // en-CA gives YYYY-MM-DD
}

// "17.06.2026 15:20:23" or "17.06.2026" -> "2026-06-17"
function ddmmyyyyToISO(d) {
  const m = d.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

export class TravelonClient {
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

  // --- helpers --------------------------------------------------------------

  async firstExisting(selectors, { scope = this.page, timeout = 2500 } = {}) {
    const arr = Array.isArray(selectors) ? selectors : [selectors];
    const deadline = Date.now() + timeout;
    do {
      for (const s of arr) {
        const loc = scope.locator(s).first();
        if ((await loc.count().catch(() => 0)) > 0) return loc;
      }
      await this.page.waitForTimeout(150);
    } while (Date.now() < deadline);
    return null;
  }

  async screenshot(name) {
    if (!config.screenshotOnError) return;
    try {
      const file = path.join(config.dataDir, `${name}-${Date.now()}.png`);
      await this.page.screenshot({ path: file, fullPage: true });
      log.info('Saved screenshot:', file);
    } catch {
      /* ignore */
    }
  }

  // --- login ----------------------------------------------------------------

  async isLoggedIn() {
    const marker = await this.firstExisting(sel.login.loggedInMarker, { timeout: 1500 });
    return Boolean(marker);
  }

  async login() {
    log.info('Logging in…');
    await this.page.goto(config.loginUrl, { waitUntil: 'domcontentloaded' });

    // Already logged in (session cookie still valid / redirected to dashboard)?
    if (await this.isLoggedIn()) {
      log.info('Already authenticated.');
      return;
    }

    const emailLoc = await this.firstExisting(sel.login.email);
    const passLoc = await this.firstExisting(sel.login.password);
    if (!emailLoc || !passLoc) {
      await this.screenshot('login-form-not-found');
      throw new Error(
        'Login form not found. Set TRAVELON_LOGIN_URL and fix sel.login.* (see README "Tuning").'
      );
    }
    await emailLoc.fill(config.email);
    await passLoc.fill(config.password);

    const submit = await this.firstExisting(sel.login.submit);
    if (submit) await submit.click();
    else await passLoc.press('Enter');

    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    await this.page.waitForTimeout(2000);

    if (!(await this.isLoggedIn())) {
      await this.screenshot('login-failed');
      throw new Error('Login appears to have failed (logged-in marker not found).');
    }
    log.info('Login OK.');
  }

  // --- requests page + filters ---------------------------------------------

  async openRequests() {
    log.info('Opening requests page…');
    await this.page.goto(config.requestsUrl, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(2500); // grid loads via AJAX
  }

  async clearCheckInDates() {
    // The "Interval of check in" inputs default to a near date and WOULD filter
    // results. Clear both so they don't restrict by check-in.
    try {
      const inputs = this.page.locator(sel.requests.checkInInputs);
      const n = await inputs.count();
      for (let i = 0; i < n; i++) {
        const inp = inputs.nth(i);
        await inp.click({ timeout: 2000 }).catch(() => {});
        await inp.fill('').catch(() => {});
        await this.page.keyboard.press('Escape').catch(() => {});
      }
      log.debug(`Cleared ${n} check-in input(s).`);
    } catch (err) {
      log.warn('Could not clear check-in dates (continuing):', err.message);
    }
  }

  async setStatusFilter() {
    // Open the Status dropdown, ensure only the target statuses are checked.
    // We explicitly uncheck "In Work" (the default extra) and ensure each
    // target status is checked. This mirrors the manual workflow.
    try {
      const field = await this.firstExisting(sel.requests.statusField);
      if (field) await field.click({ timeout: 3000 }).catch(() => {});
      await this.page.waitForTimeout(500);

      await this.setOptionChecked('In Work', false);
      for (const status of config.targetStatuses) {
        await this.setOptionChecked(status, true);
      }
      await this.page.keyboard.press('Escape').catch(() => {});
    } catch (err) {
      log.warn('setStatusFilter had trouble (continuing, verify selectors):', err.message);
    }
  }

  // Toggle a checkbox option (located by EXACT label text) to the desired state.
  async setOptionChecked(label, desired) {
    const option = this.page.getByText(label, { exact: true }).first();
    if ((await option.count().catch(() => 0)) === 0) return; // option not present
    // Find an associated checkbox to read state; fall back to clicking the label.
    const box = option.locator('xpath=ancestor-or-self::*[1]//input[@type="checkbox"]').first();
    let current = null;
    try {
      if ((await box.count()) > 0) current = await box.isChecked();
    } catch {
      current = null;
    }
    if (current === desired) return;
    await option.click({ timeout: 2000 }).catch(() => {});
    log.debug(`Status option "${label}" -> ${desired ? 'checked' : 'unchecked'}`);
  }

  async applyFilter() {
    const apply = await this.firstExisting(sel.requests.filterApplyButton);
    if (!apply) {
      log.warn('Filter apply button not found — relying on default view.');
      return;
    }
    await apply.click();
    await this.page.waitForTimeout(2500);
  }

  // --- listing --------------------------------------------------------------

  async listMatchingBookings() {
    const rows = this.page.locator(sel.requests.resultRows);
    const count = await rows.count().catch(() => 0);
    log.info(`Scanning ${count} result row(s)…`);

    const today = todayISOInTz(config.tz);
    const out = [];

    for (let i = 0; i < count; i++) {
      const text = (await rows.nth(i).innerText().catch(() => '')) || '';
      const flat = text.replace(/\s+/g, ' ').trim();
      if (!flat) continue;

      const idMatch = flat.match(/\b(\d{5})\b/); // booking id badge (5 digits)
      const dateMatch = flat.match(/(\d{2}\.\d{2}\.\d{4})/); // first = creation date
      if (!idMatch || !dateMatch) continue;

      const country = COUNTRY_RE.find((c) => c.re.test(flat));
      if (!country) continue;

      const iso = ddmmyyyyToISO(dateMatch[1]);
      if (config.onlyToday && (!iso || iso < today)) {
        // Rows are sorted newest-first, so once we drop below today we can stop.
        if (iso && iso < today) break;
        continue;
      }

      out.push({
        id: idMatch[1],
        country: country.name,
        dateISO: iso,
        dateRaw: dateMatch[1],
        rowIndex: i,
      });
    }

    log.info(`Matched ${out.length} booking(s): ${out.map((b) => b.id).join(', ') || '—'}`);
    return out;
  }

  // --- chat -----------------------------------------------------------------

  rowLocatorById(id) {
    return this.page.locator(sel.requests.resultRows).filter({ hasText: id }).first();
  }

  async chatPanelVisible() {
    const panel = await this.firstExisting(sel.chat.panel, { timeout: 800 });
    return panel ? panel.isVisible().catch(() => false) : false;
  }

  async openChat(id) {
    // Clicking a chat icon toggles the panel; make sure it's closed first.
    if (await this.chatPanelVisible()) {
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.page.waitForTimeout(400);
    }
    const row = this.rowLocatorById(id);
    const icon = row.locator(sel.requests.chatIconInRow).first();
    if ((await icon.count().catch(() => 0)) > 0) {
      await icon.click({ timeout: 4000 }).catch(() => {});
    } else {
      // Fallback: click the row itself.
      await row.click({ timeout: 4000 }).catch(() => {});
    }
    // Wait for the panel that mentions this booking id.
    await this.page
      .getByText(new RegExp(`request\\s*${id}`, 'i'))
      .first()
      .waitFor({ timeout: 6000 })
      .catch(() => {});
    await this.page.waitForTimeout(800);
  }

  async closeChat(id) {
    const row = this.rowLocatorById(id);
    const icon = row.locator(sel.requests.chatIconInRow).first();
    if ((await icon.count().catch(() => 0)) > 0) {
      await icon.click({ timeout: 2000 }).catch(() => {});
    } else {
      await this.page.keyboard.press('Escape').catch(() => {});
    }
    await this.page.waitForTimeout(400);
  }

  async readChatText() {
    const panel = await this.firstExisting(sel.chat.panel, { timeout: 1500 });
    if (panel) return (await panel.innerText().catch(() => '')) || '';
    // Fallback: whole document (the request grid does not contain the Ukrainian
    // transfer phrases, so pattern-matching the body is acceptable here).
    return (await this.page.locator('body').innerText().catch(() => '')) || '';
  }

  async chatAlreadyRequested() {
    const text = await this.readChatText();
    return ALREADY_SENT_PATTERNS.some((re) => re.test(text));
  }

  // Compose and send the message in the currently-open chat. Returns true on success.
  async sendMessage() {
    const dept = await this.firstExisting(sel.chat.departmentSelect);
    const subj = await this.firstExisting(sel.chat.subjectSelect);
    const area = await this.firstExisting(sel.chat.textArea);
    const send = await this.firstExisting(sel.chat.sendButton);

    if (!dept || !subj || !area || !send) {
      await this.screenshot('composer-not-found');
      throw new Error('Chat composer fields not found — verify sel.chat.* selectors.');
    }

    // Native <select> elements: choose by visible label.
    await dept.selectOption({ label: config.message.department }).catch(async () => {
      await dept.selectOption({ label: new RegExp(config.message.department, 'i') });
    });
    await this.page.waitForTimeout(300);
    await subj.selectOption({ label: config.message.subject }).catch(async () => {
      await subj.selectOption({ label: new RegExp(config.message.subject, 'i') });
    });
    await this.page.waitForTimeout(500); // subject may auto-fill a template

    // Replace any auto-filled template with our exact text.
    await area.click().catch(() => {});
    await area.fill(config.message.text);

    // Audience: ensure "To everyone" (so the agent sees it), unless overridden.
    if (config.message.audience === 'everyone') {
      const everyone = await this.firstExisting(sel.chat.toEveryoneButton, { timeout: 1200 });
      if (everyone) await everyone.click().catch(() => {});
    }

    await send.click({ timeout: 5000 });
    await this.page.waitForTimeout(1500);
    return true;
  }
}
