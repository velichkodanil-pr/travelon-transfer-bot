// Central configuration: reads environment variables (with sensible defaults)
// and keeps ALL CSS/text selectors in one place so the site can be re-tuned
// without touching the logic. See README "Tuning selectors".
import 'dotenv/config';

const bool = (v, def = false) =>
  v === undefined ? def : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

const num = (v, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

const list = (v, def = []) =>
  v === undefined || v === ''
    ? def
    : String(v)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

export const config = {
  // --- credentials & urls ---
  email: process.env.TRAVELON_EMAIL || '',
  password: process.env.TRAVELON_PASSWORD || '',
  baseUrl: (process.env.TRAVELON_BASE_URL || 'https://travelon.to').replace(/\/$/, ''),
  loginUrl: process.env.TRAVELON_LOGIN_URL || 'https://travelon.to/admin/users/sign_in',
  requestsUrl: process.env.TRAVELON_REQUESTS_URL || 'https://travelon.to/book/bundle/index',

  // --- behaviour ---
  dryRun: bool(process.env.DRY_RUN, true),
  checkCron: process.env.CHECK_CRON || '*/30 * * * *',
  runOnce: bool(process.env.RUN_ONCE, false),
  tz: process.env.CRON_TZ || 'Europe/Kyiv',
  maxSendsPerRun: num(process.env.MAX_SENDS_PER_RUN, 25),

  // --- matching ---
  // Generic "transfer drivers" message countries. Болгарія is intentionally
  // NOT here — Bulgaria is handled by the dedicated Eline workflow below.
  targetCountries: list(process.env.TARGET_COUNTRIES, [
    'Греція',
    'Албанія',
    'Хорватія',
    'Іспанія',
  ]),
  targetStatuses: list(process.env.TARGET_STATUSES, ['Confirmed', 'Confirmed Print']),
  onlyToday: bool(process.env.ONLY_TODAY, true),

  // --- message ---
  message: {
    department: process.env.MESSAGE_DEPARTMENT || 'Бронювання',
    subject: process.env.MESSAGE_SUBJECT || 'Надання контактів водію автобуса',
    text:
      process.env.MESSAGE_TEXT ||
      "Шановні колеги, просимо надіслати телефон туристів для зв'язку з трансферменами. Дякуємо.",
    audience: (process.env.MESSAGE_AUDIENCE || 'everyone').toLowerCase(), // everyone | administrators
  },

  // --- Bulgaria + Eline supplier workflow ---
  bulgaria: {
    enabled: bool(process.env.BG_ENABLED, true),
    country: process.env.BG_COUNTRY || 'Болгарія',
    statuses: list(process.env.BG_STATUSES, ['Confirmed', 'Confirmed Print']),
    elineProviderName: process.env.BG_ELINE_PROVIDER || 'E.Line Tour',
    // Only act on bookings created on/after this date (creation date).
    createdFromISO: process.env.BG_CREATED_FROM || '2026-01-01',
    // How many list pages to page through when scanning (safety cap).
    maxListPages: num(process.env.BG_MAX_LIST_PAGES, 20),
    department: process.env.BG_DEPARTMENT || 'Бронювання',
    subject: process.env.BG_SUBJECT || 'Надання контактів водію автобуса',
    askText:
      process.env.BG_ASK_TEXT ||
      'Шановні колеги, просимо надіслати номер телефону туристів для контакту з перевізниками. Дякуємо.',
    reminderText:
      process.env.BG_REMINDER_TEXT ||
      'Шановні колеги, доброго дня! Нагадуємо, що потрібно надати контакти туристів для водія. Дякуємо.',
  },
  // Eline supplier portal (same software as TravelON). SEPARATE login.
  eline: {
    email: process.env.ELINE_EMAIL || '',
    password: process.env.ELINE_PASSWORD || '',
    baseUrl: (process.env.ELINE_BASE_URL || 'https://eline-tour.com.ua').replace(/\/$/, ''),
    loginUrl: process.env.ELINE_LOGIN_URL || 'https://eline-tour.com.ua/admin/users/sign_in',
  },

  // --- browser ---
  headless: bool(process.env.HEADLESS, true),
  slowMo: num(process.env.SLOWMO_MS, 0),
  navTimeout: num(process.env.NAV_TIMEOUT_MS, 45000),

  // --- data / debug ---
  dataDir: process.env.DATA_DIR || './data',
  screenshotOnError: bool(process.env.SCREENSHOT_ON_ERROR, true),

  // --- telegram (optional) ---
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },

  // --- google sheets report (optional) ---
  // Веде трекер заявок у Google Таблиці. Вмикається лише коли REPORT_ENABLED=true
  // і задані OAuth-креди. Авторизація — OAuth user-token (діє від акаунта,
  // що володіє таблицею). Деталі — у src/report.js.
  report: {
    enabled: bool(process.env.REPORT_ENABLED, false),
    spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '',
    sheetName: process.env.GOOGLE_SHEETS_TAB || '', // порожньо = перша вкладка
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
    refreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN || '',
  },

  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
};

// Phrases that mean "a transfer / driver phone request was already sent in this
// chat" — used to avoid sending a duplicate. Case-insensitive, accent-tolerant.
// Add more variants here if agents/operators phrase it differently.
export const ALREADY_SENT_PATTERNS = [
  /телефон\s+турист/i, // "телефон туристів ..."
  /тел\.?\s+турист/i, // "тел туристів для трансферу"
  /контакт\w*\s+турист/i, // "контакти туристів для водія"
  /трансфермен/i, // "...для зв'язку з трансферменами"
  /контакт\w*\s+воді/i, // "надання контактів водію"
  /надіслати\s+телефон/i,
  /телефон.*трансфер/i,
];

// Ukrainian phone formats to recognise in comment fields / chat:
// 380XXXXXXXXX (12), 80XXXXXXXXX (11), 0XXXXXXXXX (10).
// Boundaries prevent matching inside a longer digit run.
export const PHONE_RE = /(?<!\d)(?:380\d{9}|80\d{9}|0\d{9})(?!\d)/g;

// Detect that WE already asked / reminded in a Bulgaria chat (dedup).
export const BG_ASK_PATTERNS = [/перевізник/i, /контакт.*турист.*перевізник/i];
export const BG_REMINDER_PATTERNS = [/нагадуємо.*контакт/i, /нагадуємо.*воді/i];

// ----------------------------------------------------------------------------
// SELECTORS — the brittle part. These are best-effort guesses based on the
// observed UI (English field labels, Ukrainian/Russian content). Verify and
// fix them against the live DOM with: npm run codegen (see README).
// Prefer text/role/label locators over fragile CSS where possible.
// ----------------------------------------------------------------------------
export const sel = {
  login: {
    // Try several common input shapes; the client picks the first that exists.
    email: [
      'input[type="email"]',
      'input[name*="email" i]',
      'input[name*="login" i]',
      'input[name*="user" i]',
      '#loginform-username',
    ],
    password: ['input[type="password"]', 'input[name*="pass" i]', '#loginform-password'],
    submit: [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Login")',
      'button:has-text("Увійти")',
      'button:has-text("Вход")',
    ],
    // An element that is only present AFTER a successful login (used to confirm).
    loggedInMarker: ['text=REQUESTS', 'text=Partners and users', 'text=Транспортал'],
  },

  requests: {
    // The red "Filter" (apply) button in the toolbar.
    filterApplyButton: 'button:has-text("Filter"), a:has-text("Filter")',

    // Status multiselect (the field showing e.g. "Confirmed, Confirmed Print").
    statusField:
      '#bundle-status, [data-filter="status"], .filter-status, label:has-text("Status") ~ * .multiselect, text=/^(In Work|Confirmed)/',
    // A checkbox option inside the open Status dropdown, located by its label text.
    statusOptionByLabel: (label) =>
      `:is(.dropdown, .multiselect, .filter) :is(label,li,div):has-text("${label}")`,

    // Two "Interval of check in" date inputs (must be cleared so they don't filter).
    checkInInputs:
      'label:has-text("Interval of check in") ~ * input, [name*="checkin" i], [name*="check_in" i]',

    // Each result row. We then parse innerText for id/date/country in JS.
    resultRows: 'table tbody tr, .grid-view tbody tr, .items tbody tr',

    // Within a row: the link that opens the chat modal (emits 'modal:chatbox:open').
    chatIconInRow: 'a[onclick*="chatbox:open"]',
  },

  chat: {
    // The open chat modal container.
    panel: '.modal-v2, .chatbox, [class*="chat" i][class*="modal" i], .chat-panel, .notifications-panel',
    // All rendered message bubbles' text inside the panel.
    messages: '.message, .chat-message, [class*="message" i]',
    // Composer fields. The chat is a JS modal (opened via the row's
    // a[onclick*="chatbox:open"] link). Its <select>s have NO name/id, and the
    // SUBJECT <select> renders only AFTER a department is chosen — so we match by
    // the visible label, falling back to the exact option text. firstExisting()
    // accepts arrays and tries each entry in order.
    departmentSelect: [
      'div.flex.flex-col:has(> label:has-text("Department")) select',
      'select:has(option:text-is("Бронювання"))',
      'select[name*="department" i]',
    ],
    subjectSelect: [
      'div.flex.flex-col:has(> label:has-text("Message subject")) select',
      'select:has(option:text-is("Надання контактів водію автобуса"))',
      'select[name*="subject" i], select[name*="theme" i]',
    ],
    textArea: ['textarea[placeholder*="Compose" i]', 'textarea'],
    toEveryoneButton: ['button:has-text("To everyone")', ':is(button,label):has-text("To everyone")'],
    toAdministratorsButton: ['button:has-text("Send to administrators")'],
    sendButton: ['button:text-is("Send")', 'button:has-text("Send")'],
    // Close the chat modal (do NOT re-click the row icon — that re-opens it).
    closeButton: ['button.modal-v2_close', 'button[aria-label*="close" i]', '[data-dismiss="modal"]'],
  },

  // TravelON booking edit page (/book/bundle/edit/{id}) — comment fields.
  edit: {
    commentUser: 'textarea[name="bundle[comment]"]', // "Comments for user"
    commentAdmin: 'textarea[name="bundle[comment_admin]"]', // "Commentary for the administration"
    saveButton: 'button[name="commit"]', // "Save"
  },

  // Eline supplier portal booking edit page — per-passenger phone inputs.
  eline: {
    loginEmail: ['input[type="email"]', 'input[name*="email" i]', 'input[name="user[email]"]'],
    loginPassword: ['input[type="password"]', 'input[name="user[password]"]'],
    loginSubmit: ['button[type="submit"]', 'input[type="submit"]'],
    loggedInMarker: ['text=ЗАЯВКИ', 'text=Панель управління', 'text=Транспортал'],
    passengerPhone: 'input[name="passenger[][telephone]"]',
    saveButton: 'button[name="commit"]', // "Зберегти"
  },
};

export function validateConfig() {
  const problems = [];
  if (!config.email) problems.push('TRAVELON_EMAIL is not set');
  if (!config.password) problems.push('TRAVELON_PASSWORD is not set');
  if (!config.targetCountries.length) problems.push('TARGET_COUNTRIES is empty');
  if (!config.message.text) problems.push('MESSAGE_TEXT is empty');
  return problems;
}
