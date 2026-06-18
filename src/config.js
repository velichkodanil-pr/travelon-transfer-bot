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
  loginUrl: process.env.TRAVELON_LOGIN_URL || 'https://travelon.to/site/login',
  requestsUrl: process.env.TRAVELON_REQUESTS_URL || 'https://travelon.to/book/bundle/index',

  // --- behaviour ---
  dryRun: bool(process.env.DRY_RUN, true),
  checkCron: process.env.CHECK_CRON || '*/30 * * * *',
  runOnce: bool(process.env.RUN_ONCE, false),
  tz: process.env.CRON_TZ || 'Europe/Kyiv',
  maxSendsPerRun: num(process.env.MAX_SENDS_PER_RUN, 25),

  // --- matching ---
  targetCountries: list(process.env.TARGET_COUNTRIES, [
    'Греція',
    'Болгарія',
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

// ----------------------------------------------------------------------------
//  SELECTORS — the brittle part. These are best-effort guesses based on the
//  observed UI (English field labels, Ukrainian/Russian content). Verify and
//  fix them against the live DOM with:  npm run codegen   (see README).
//  Prefer text/role/label locators over fragile CSS where possible.
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
      `:is(.dropdown, .multiselect, .filter)  :is(label,li,div):has-text("${label}")`,

    // Two "Interval of check in" date inputs (must be cleared so they don't filter).
    checkInInputs:
      'label:has-text("Interval of check in") ~ * input, [name*="checkin" i], [name*="check_in" i]',

    // Each result row. We then parse innerText for id/date/country in JS.
    resultRows: 'table tbody tr, .grid-view tbody tr, .items tbody tr',

    // Within a row: the element that opens the chat panel (the speech-bubble cell).
    chatIconInRow: 'td:has(.fa-comment), td:has(svg), .chat-icon, [data-toggle*="chat" i]',
  },

  chat: {
    // The open chat/notifications panel container.
    panel: '.chat-panel, .notifications-panel, [class*="notification" i][class*="panel" i]',
    // All rendered message bubbles' text inside the panel.
    messages: '.message, .chat-message, [class*="message" i]',
    // Composer fields.
    departmentSelect: 'select[name*="department" i], select#department, label:has-text("DEPARTMENT") ~ select, label:has-text("DEPARTMENT") ~ * select',
    subjectSelect: 'select[name*="subject" i], select[name*="theme" i], label:has-text("MESSAGE SUBJECT") ~ select, label:has-text("MESSAGE SUBJECT") ~ * select',
    textArea: 'textarea[placeholder*="Compose" i], textarea',
    toEveryoneButton: 'button:has-text("To everyone"), :is(button,label):has-text("To everyone")',
    toAdministratorsButton: 'button:has-text("Send to administrators")',
    sendButton: 'button:has-text("Send")',
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
