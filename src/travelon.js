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
    const today = todayISOInTz(config.tz);

    // Pull each row's flat text + its STATUS label in one pass. The status is the
    // text just before "Room status" in the row's status cell (e.g. the cell reads
    // "Confirmed Room status : New" -> status = "Confirmed"). Reading it straight
    // from the row makes status filtering reliable and independent of the fragile
    // Status filter dropdown.
    const rowsData = await this.page
      .locator(sel.requests.resultRows)
      .evaluateAll((trs) =>
        trs.map((tr) => {
          const text = (tr.innerText || '').replace(/\s+/g, ' ').trim();
          const statusCell = Array.from(tr.querySelectorAll('td')).find((td) =>
            /Room status/i.test(td.innerText)
          );
          const status = statusCell
            ? statusCell.innerText.split(/Room status/i)[0].replace(/\s+/g, ' ').trim()
            : null;
          return { text, status };
        })
      )
      .catch(() => []);

    log.info(`Scanning ${rowsData.length} result row(s)…`);
    const out = [];

    for (const row of rowsData) {
      const flat = row.text;
      if (!flat) continue;

      const idMatch = flat.match(/\b(\d{5})\b/); // booking id badge (5 digits)
      const dateMatch = flat.match(/(\d{2}\.\d{2}\.\d{4})/); // first = creation (request) date
      if (!idMatch || !dateMatch) continue;

      // Country (from the "State" column text).
      const country = COUNTRY_RE.find((c) => c.re.test(flat));
      if (!country) continue;

      // Creation date must be today or later (when ONLY_TODAY=true).
      const iso = ddmmyyyyToISO(dateMatch[1]);
      if (config.onlyToday && (!iso || iso < today)) continue;

      // Status must EXACTLY match one of the target statuses (e.g. "Confirmed",
      // "Confirmed Print"). This excludes "In Work", "Not Confirmed", etc.
      if (!row.status || !config.targetStatuses.includes(row.status)) continue;

      out.push({
        id: idMatch[1],
        country: country.name,
        status: row.status,
        dateISO: iso,
        dateRaw: dateMatch[1],
      });
    }

    log.info(
      `Matched ${out.length} booking(s): ${
        out.map((b) => `${b.id}[${b.status}]`).join(', ') || '—'
      }`
    );
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
    // The chat is a JS modal opened by emitting 'modal:chatbox:open' (the row's
    // a[onclick*="chatbox:open"] link does exactly this). It only renders on a page
    // where the chat bundle + window.EventBus are loaded — the requests LIST. The
    // Bulgaria flow visits the booking EDIT page first (openEdit -> page.goto), so
    // we must return to the list before opening; otherwise the composer never
    // renders and sendChatMessage throws "composer fields not found". (This — not
    // the CSS selectors — was the real cause of the Bulgaria failures.)
    const onList = async () =>
      /\/book\/bundle\/index/.test(this.page.url()) &&
      (await this.page
        .evaluate(() => !!(window.EventBus && typeof window.EventBus.emit === 'function'))
        .catch(() => false));

    if (!(await onList())) {
      await this.page.goto(config.requestsUrl, { waitUntil: 'domcontentloaded' });
      await this.page.waitForTimeout(1200);
    }

    // Close any previous chat drawer first (it would shadow this booking's id).
    if (await this.chatPanelVisible()) {
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.page.waitForTimeout(400);
    }

    // Preferred: open by emitting the event with the bundle id. Works regardless
    // of which list page the row is on (no pagination dependency).
    let opened = await this.page
      .evaluate((bundleId) => {
        if (window.EventBus && typeof window.EventBus.emit === 'function') {
          window.EventBus.emit('modal:chatbox:open', {
            locale: (window.I18n && window.I18n.locale) || 'uk',
            bundleId,
          });
          return true;
        }
        return false;
      }, Number(id))
      .catch(() => false);

    // Fallback: click the row's chat link if the event bus was unavailable.
    if (!opened) {
      const row = this.rowLocatorById(id);
      const icon = row.locator(sel.requests.chatIconInRow).first();
      if ((await icon.count().catch(() => 0)) > 0) {
        await icon.click({ timeout: 4000 }).catch(() => {});
      }
    }

    // Wait for the drawer that mentions this booking id, then for the composer
    // textarea so the caller can compose immediately.
    await this.page
      .getByText(new RegExp(`request\\s*${id}`, 'i'))
      .first()
      .waitFor({ timeout: 8000 })
      .catch(() => {});
    await this.firstExisting(sel.chat.textArea, { timeout: 4000 });
    await this.page.waitForTimeout(500);
  }

  async closeChat(/* id */) {
    // The chat is a modal — close via its close button or Escape. Do NOT click the
    // row icon again: that re-emits 'chatbox:open' and would just re-open the modal.
    const close = await this.firstExisting(sel.chat.closeButton, { timeout: 1000 });
    if (close) {
      await close.click({ timeout: 2000 }).catch(() => {});
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

  // Panel-only chat text (NEVER the whole page) — used for phone extraction so we
  // don't grab numbers from the request grid / page chrome.
  async readChatPanelText() {
    const panel = await this.firstExisting(sel.chat.panel, { timeout: 1500 });
    return panel ? (await panel.innerText().catch(() => '')) || '' : '';
  }

  async chatAlreadyRequested() {
    const text = await this.readChatText();
    return ALREADY_SENT_PATTERNS.some((re) => re.test(text));
  }

  // Compose and send a message in the currently-open chat modal. Returns true on success.
  // The composer is a JS modal: the department <select> is present first; the SUBJECT
  // <select> renders only AFTER a department is chosen; Send enables once department +
  // subject + text are all set. "To everyone" is the default recipient.
  async sendChatMessage({ department, subject, text, audience = 'everyone' }) {
    const dept = await this.firstExisting(sel.chat.departmentSelect, { timeout: 6000 });
    const area = await this.firstExisting(sel.chat.textArea, { timeout: 3000 });
    if (!dept || !area) {
      await this.screenshot('composer-not-found');
      throw new Error('Chat composer fields not found — verify sel.chat.* selectors.');
    }

    // 1) Choose the department — this causes the subject <select> to render.
    await dept.selectOption({ label: department }).catch(async () => {
      await dept.selectOption({ label: new RegExp(department, 'i') });
    });

    // 2) Wait for the subject <select> to appear, then choose the subject.
    const subj = await this.firstExisting(sel.chat.subjectSelect, { timeout: 6000 });
    if (!subj) {
      await this.screenshot('composer-subject-not-found');
      throw new Error(
        'Subject select did not appear after choosing department — verify sel.chat.subjectSelect.'
      );
    }
    await subj.selectOption({ label: subject }).catch(async () => {
      await subj.selectOption({ label: new RegExp(subject, 'i') });
    });
    await this.page.waitForTimeout(500); // subject may auto-fill a template

    // 3) Write our exact text, replacing any auto-filled template.
    await area.click().catch(() => {});
    await area.fill('');
    await area.fill(text);

    // 4) Recipient. "To everyone" is selected by default, so only act when we need
    //    administrators (clicking the already-active toggle could clear it).
    if (audience === 'administrators') {
      const admins = await this.firstExisting(sel.chat.toAdministratorsButton, { timeout: 1500 });
      if (admins) await admins.click().catch(() => {});
    }

    // 5) Send — the button enables once department + subject + text are all set.
    const send = await this.firstExisting(sel.chat.sendButton, { timeout: 5000 });
    if (!send) {
      await this.screenshot('composer-send-not-found');
      throw new Error('Send button not found — verify sel.chat.sendButton.');
    }
    await send.scrollIntoViewIfNeeded().catch(() => {});
    await send.click({ timeout: 6000 }).catch(async () => {
      await send.click({ timeout: 3000, force: true });
    });
    await this.page.waitForTimeout(1500);
    return true;
  }

  // Generic transfer-phone message (existing 4-country workflow).
  async sendMessage() {
    return this.sendChatMessage({
      department: config.message.department,
      subject: config.message.subject,
      text: config.message.text,
      audience: config.message.audience,
    });
  }

  // ---- Booking edit page: comment fields ----

  editUrl(id) {
    return `${config.baseUrl}/book/bundle/edit/${id}`;
  }

  async openEdit(id) {
    await this.page.goto(this.editUrl(id), { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(2500);
  }

  async readComments() {
    const get = async (s) => {
      const loc = this.page.locator(s).first();
      if ((await loc.count().catch(() => 0)) === 0) return '';
      return (await loc.inputValue().catch(() => '')) || '';
    };
    return { user: await get(sel.edit.commentUser), admin: await get(sel.edit.commentAdmin) };
  }

  // The booking "Telephone" field holds the TRAVEL AGENT's number, never the
  // tourist's — callers EXCLUDE it from any phone they use.
  async readAgentPhone() {
    const loc = this.page.locator('input[name="bundle[telephone]"]').first();
    if ((await loc.count().catch(() => 0)) === 0) return '';
    return (await loc.inputValue().catch(() => '')) || '';
  }

  // Append the phone string to BOTH comment fields (if absent), then save.
  async appendPhonesToComments(phones, { dryRun }) {
    const phoneStr = phones.join(' ');
    const cur = await this.readComments();
    const merge = (e) => (e && e.includes(phoneStr) ? e : e ? `${e} ${phoneStr}` : phoneStr);
    const next = { user: merge(cur.user), admin: merge(cur.admin) };
    if (dryRun) return { ...next, saved: false };
    const fill = async (s, v) => {
      const loc = this.page.locator(s).first();
      if ((await loc.count().catch(() => 0)) > 0) await loc.fill(v).catch(() => {});
    };
    await fill(sel.edit.commentUser, next.user);
    await fill(sel.edit.commentAdmin, next.admin);
    const save = this.page
      .locator(sel.edit.saveButton)
      .filter({ hasText: /Save|Зберегти/i })
      .first();
    if ((await save.count().catch(() => 0)) > 0) await save.click().catch(() => {});
    await this.page.waitForTimeout(1500);
    return { ...next, saved: true };
  }

  // ---- List scanning / pagination (Bulgaria workflow) ----

  // Apply the TravelON list filter for ONE Bulgaria transfer supplier: filter by
  // supplier (partner_id) + status, and CLEAR every date filter (booking date is
  // irrelevant — we filter CHECK-IN client-side). The filter is a POST form whose
  // state persists in the session, so subsequent ?page=N GETs stay filtered.
  async applyBulgariaSupplierFilter(partnerId, statusIds) {
    await this.page.goto(config.requestsUrl, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(1500);
    // Submit the POST filter form and WAIT for the resulting navigation, so the
    // next scanRows() reads the FILTERED list (not the pre-submit page).
    await Promise.all([
      this.page
        .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 })
        .catch(() => {}),
      this.page.evaluate(
        ({ partnerId, statusIds }) => {
          const form =
            document.querySelector('form[action="/book/bundle/index"]') ||
            document.querySelector('form');
          if (!form) return;
          const partner = form.querySelector('select[name="filter[partner_id]"]');
          if (partner) partner.value = partnerId;
          const st = form.querySelector('select[name="filter[status_ids][]"]');
          if (st)
            Array.from(st.options).forEach((o) => (o.selected = statusIds.includes(o.value)));
          const mkt = form.querySelector('select[name="filter[market_state_ids][]"]');
          if (mkt) Array.from(mkt.options).forEach((o) => (o.selected = false));
          const sv = form.querySelector('[name="filter[search]"]');
          if (sv) sv.value = '';
          [
            'filter[from_order]',
            'filter[to_order]',
            'filter[from_entry]',
            'filter[to_entry]',
            'filter[from_exit]',
            'filter[to_exit]',
          ].forEach((n) => {
            const el = form.querySelector(`[name="${n}"]`);
            if (el) el.value = '';
          });
          form.submit();
        },
        { partnerId, statusIds }
      ),
    ]);
    await this.page.waitForTimeout(2500);
  }

  async scanRows() {
    return await this.page
      .locator(sel.requests.resultRows)
      .evaluateAll((trs) =>
        trs.map((tr) => {
          const norm = (x) => (x || '').replace(/\s+/g, ' ').trim();
          const text = norm(tr.innerText);
          const statusCell = Array.from(tr.querySelectorAll('td')).find((td) =>
            /Room status/i.test(td.innerText)
          );
          const status = statusCell
            ? statusCell.innerText.split(/Room status/i)[0].replace(/\s+/g, ' ').trim()
            : null;
          // "Date of check in" (date of entry) is column index 10 among the row's
          // DIRECT cells. Nested sub-rows have fewer cells -> checkin stays ''.
          const cells = Array.from(tr.children);
          const cm = cells[10] ? norm(cells[10].innerText).match(/\d{2}\.\d{2}\.\d{4}/) : null;
          const checkin = cm ? cm[0] : '';
          // "Date of request" (booking date) is column index 6.
          const bm = cells[6] ? norm(cells[6].innerText).match(/\d{2}\.\d{2}\.\d{4}/) : null;
          const bookingDate = bm ? bm[0] : '';
          return { text, status, checkin, bookingDate };
        })
      )
      .catch(() => []);
  }

  async goToNextPage() {
    const next = this.page
      .locator(
        'a[rel="next"], li.next:not(.disabled) a, .pagination a:has-text("›"), .pagination a:has-text("»"), a:has-text("Next")'
      )
      .first();
    if ((await next.count().catch(() => 0)) === 0) return false;
    await next.click().catch(() => {});
    await this.page.waitForTimeout(2000);
    return true;
  }
}
