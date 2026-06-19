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
    // `writeToEline`: push the phone into the Eline portal (E.Line only).
    // `messageItravel`: send the phone into the Itravel client cabinet (Itravel only).
    suppliers: [
      {
        name: process.env.BG_ITRAVEL_PROVIDER || 'Itravel',
        partnerId: process.env.BG_ITRAVEL_PARTNER_ID || '6572',
        writeToEline: false,
        messageItravel: true,
      },
      {
        name: process.env.BG_ELINE_PROVIDER || 'E.Line Tour',
        partnerId: process.env.BG_ELINE_PARTNER_ID || '1259',
        writeToEline: true,
      },
    ],
    statusIds: list(process.env.BG_STATUS_IDS, ['2', '3']),
    checkinFromDays: num(process.env.BG_CHECKIN_FROM_DAYS, 1),
    createdFromISO: process.env.BG_CREATED_FROM || '2026-01-01',
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
  // Itravel supplier CLIENT CABINET (i-travel.com.ua, WordPress). SEPARATE login.
  // Login is standard WordPress (wp-login.php, fields log/pwd). After login we verify
  // by loading the profile page. The bot opens /client-profile/?id=<orderNo>, clicks
  // the order's "Повідомлення" link and sends the tourist phone into the thread.
  itravel: {
    enabled: bool(process.env.BG_ITRAVEL_MESSAGE_ENABLED, true),
    email: process.env.ITRAVEL_EMAIL || '',
    password: process.env.ITRAVEL_PASSWORD || '',
    baseUrl: (process.env.ITRAVEL_BASE_URL || 'https://www.i-travel.com.ua').replace(/\/$/, ''),
    loginUrl: process.env.ITRAVEL_LOGIN_URL || 'https://www.i-travel.com.ua/wp-login.php',
    profilePath: process.env.ITRAVEL_PROFILE_PATH || '/client-profile/',
    messageText:
      process.env.ITRAVEL_MESSAGE_TEXT || 'Контакт туриста для водія трансферу: {phones}',
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
  report: {
    enabled: bool(process.env.REPORT_ENABLED, false),
    spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '',
    sheetName: process.env.GOOGLE_SHEETS_TAB || '',
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
    refreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN || '',
  },

  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
};

// Phrases that mean "a transfer / driver phone request was already sent".
export const ALREADY_SENT_PATTERNS = [
  /телефон\s+турист/i,
  /тел\.?\s+турист/i,
  /контакт\w*\s+турист/i,
  /трансфермен/i,
  /контакт\w*\s+воді/i,
  /надіслати\s+телефон/i,
  /телефон.*трансфер/i,
];

// Ukrainian phone formats. PHONE_RE matches a number WITHOUT separators (exact).
export const PHONE_RE = /(?<!\d)(?:380\d{9}|80\d{9}|0\d{9})(?!\d)/g;

// PHONE_CANDIDATE_RE finds phone-shaped tokens WITH human separators (parentheses,
// dashes, spaces, dots) which phone.js normalises via normalizeUaPhone(). The class
// excludes commas/slashes/colons/letters/newlines so it never fuses dates, times,
// seat lists or two numbers on separate lines.
export const PHONE_CANDIDATE_RE = /\+?\d[\d \t.() -]{6,20}\d/g;

export const BG_ASK_PATTERNS = [/перевізник/i, /контакт.*турист.*перевізник/i];
export const BG_REMINDER_PATTERNS = [/нагадуємо.*контакт/i, /нагадуємо.*воді/i];

// ----------------------------------------------------------------------------
// SELECTORS — verify/fix against the live DOM with: npm run codegen.
// ----------------------------------------------------------------------------
export const sel = {
  login: {
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
    loggedInMarker: ['text=REQUESTS', 'text=Partners and users', 'text=Транспортал'],
  },

  requests: {
    filterApplyButton: 'button:has-text("Filter"), a:has-text("Filter")',
    statusField:
      '#bundle-status, [data-filter="status"], .filter-status, label:has-text("Status") ~ * .multiselect, text=/^(In Work|Confirmed)/',
    statusOptionByLabel: (label) =>
      `:is(.dropdown, .multiselect, .filter) :is(label,li,div):has-text("${label}")`,
    checkInInputs:
      'label:has-text("Interval of check in") ~ * input, [name*="checkin" i], [name*="check_in" i]',
    resultRows: 'table tbody tr, .grid-view tbody tr, .items tbody tr',
    chatIconInRow: 'a[onclick*="chatbox:open"]',
  },

  chat: {
    panel: [
      'div.fixed.top-0.right-0:has(textarea)',
      '.tailwind-scope:has(textarea[placeholder*="Compose" i])',
      '.fixed.right-0.shadow-2xl',
    ],
    messages: '.message, .chat-message, [class*="message" i]',
    departmentSelect: [
      'div.flex.flex-col:has(> label:has-text("Department")) select',
      'div.fixed.top-0.right-0 select >> nth=0',
    ],
    subjectSelect: [
      'div.flex.flex-col:has(> label:has-text("Message subject")) select',
      'div.fixed.top-0.right-0 select >> nth=1',
    ],
    textArea: ['textarea[placeholder*="Compose" i]', 'div.fixed.top-0.right-0 textarea'],
    toEveryoneButton: ['button:has-text("To everyone")', ':is(button,label):has-text("To everyone")'],
    toAdministratorsButton: ['button:has-text("Send to administrators")'],
    sendButton: ['button:text-is("Send")', 'button:has-text("Send")'],
    closeButton: [
      'div.fixed.top-0.right-0 button[aria-label*="close" i]',
      'button[aria-label*="close" i]',
    ],
  },

  edit: {
    commentUser: 'textarea[name="bundle[comment]"]',
    commentAdmin: 'textarea[name="bundle[comment_admin]"]',
    saveButton: 'button[name="commit"]',
  },

  eline: {
    loginEmail: ['input[type="email"]', 'input[name*="email" i]', 'input[name="user[email]"]'],
    loginPassword: ['input[type="password"]', 'input[name="user[password]"]'],
    loginSubmit: ['button[type="submit"]', 'input[type="submit"]'],
    loggedInMarker: ['text=ЗАЯВКИ', 'text=Панель управління', 'text=Транспортал'],
    passengerPhone: 'input[name="passenger[][telephone]"]',
    saveButton: 'button[name="commit"]',
  },

  // Itravel CLIENT cabinet (i-travel.com.ua). Login is standard WordPress
  // (wp-login.php: name="log" / name="pwd" / #wp-submit). loggedInMarker is the
  // order-search input, present only in the authenticated cabinet. Order search is
  // via URL ?id=<orderNo>; per-order "Повідомлення" link calls openChat(order, token).
  itravel: {
    loginEmail: [
      'input[name="log"]',
      '#user_login',
      'input[type="email"]',
      'input[name*="email" i]',
      'input[name*="login" i]',
    ],
    loginPassword: ['input[name="pwd"]', '#user_pass', 'input[type="password"]'],
    loginSubmit: ['#wp-submit', 'input[name="wp-submit"]', 'button[type="submit"]', 'input[type="submit"]'],
    loggedInMarker: ['#search_booking_number', 'a:has-text("Вихід")'],
    messageButton: 'a[onclick^="openChat("]',
    chatPopup: '#chatPopup',
    chatMessages: '#chatMessages',
    chatInput: '#chatInput',
    sendButton: '#chatPopup button[onclick="sendMessage()"]',
    closeButton: '#chatPopup a.close, a.cmsmasters_button.close',
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
