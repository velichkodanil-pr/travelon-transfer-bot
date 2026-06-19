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
    // Transfer suppliers handled for Bulgaria. We filter the TravelON list by the
    // supplier (partner_id) so the BOOKING date is irrelevant — what matters is the
    // CHECK-IN date (see runBulgaria). `writeToEline`: also push the phone into the
    // Eline supplier portal (true only for E.Line Tour). `messageItravel`: send the
    // phone into the Itravel client cabinet booking thread (true only for Itravel).
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
    // TravelON status ids for the server-side status filter (Confirmed=2,
    // Confirmed Print=3). Used together with the supplier filter.
    statusIds: list(process.env.BG_STATUS_IDS, ['2', '3']),
    // Only act on bookings whose CHECK-IN (date of entry) is this many days from
    // today or later. 1 = tomorrow onward. Booking/creation date is NOT filtered.
    checkinFromDays: num(process.env.BG_CHECKIN_FROM_DAYS, 1),
    // (kept for reference; no longer used to filter — booking date can be anything)
    createdFromISO: process.env.BG_CREATED_FROM || '2026-01-01',
    // How many list pages to page through per supplier when scanning (safety cap).
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
  // The bot opens /client-profile/?id=<orderNo>, clicks the order's "Повідомлення"
  // link and sends the tourist phone into the booking thread. orderNo = the
  // "Itravel - NNNN" supplier reference captured from the TravelON list.
  itravel: {
    enabled: bool(process.env.BG_ITRAVEL_MESSAGE_ENABLED, true),
    email: process.env.ITRAVEL_EMAIL || '',
    password: process.env.ITRAVEL_PASSWORD || '',
    baseUrl: (process.env.ITRAVEL_BASE_URL || 'https://www.i-travel.com.ua').replace(/\/$/, ''),
    loginUrl: process.env.ITRAVEL_LOGIN_URL || 'https://www.i-travel.com.ua/client-profile/',
    profilePath: process.env.ITRAVEL_PROFILE_PATH || '/client-profile/',
    // {phones} is replaced with the comma-separated canonical numbers.
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

// Phrases that mean "a transfer / driver phone request was already sent in this
// chat" — used to avoid sending a duplicate. Case-insensitive, accent-tolerant.
export const ALREADY_SENT_PATTERNS = [
  /телефон\s+турист/i,
  /тел\.?\s+турист/i,
  /контакт\w*\s+турист/i,
  /трансфермен/i,
  /контакт\w*\s+воді/i,
  /надіслати\s+телефон/i,
  /телефон.*трансфер/i,
];

// Ukrainian phone formats to recognise in comment fields / chat.
// Canonical (digits only): 380XXXXXXXXX (12), 80XXXXXXXXX (11), 0XXXXXXXXX (10).
// PHONE_RE matches a number written WITHOUT separators (kept for reference /
// exact digit matching). Boundaries prevent matching inside a longer digit run.
export const PHONE_RE = /(?<!\d)(?:380\d{9}|80\d{9}|0\d{9})(?!\d)/g;

// Agents almost always type numbers the "human" way, WITH separators —
// "+380(67)594-18-21", "+380 97 425 81 22", "0(63)384-60-02". PHONE_CANDIDATE_RE
// finds such phone-shaped tokens; phone.js then strips each to digits and
// validates/canonicalises it via normalizeUaPhone(). The character class allows
// only digits, spaces/tabs, dots, dashes, parentheses and nbsp (plus an optional
// leading "+") — it deliberately EXCLUDES commas, slashes, colons, letters and
// newlines, so it never fuses list items ("місця 1,2"), dates ("04/24/2026"),
// times ("10:59"), route/seat codes ("ТК2139") or two numbers on separate lines.
export const PHONE_CANDIDATE_RE = /\+?\d[\d \t.() -]{6,20}\d/g;

// Detect that WE already asked / reminded in a Bulgaria chat (dedup).
export const BG_ASK_PATTERNS = [/перевізник/i, /контакт.*турист.*перевізник/i];
export const BG_REMINDER_PATTERNS = [/нагадуємо.*контакт/i, /нагадуємо.*воді/i];

// ----------------------------------------------------------------------------
// SELECTORS — the brittle part. Best-effort guesses based on the observed UI.
// Verify/fix against the live DOM with: npm run codegen (see README).
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

  // Itravel CLIENT cabinet (i-travel.com.ua). Order search is via URL ?id=<orderNo>;
  // the per-order "Повідомлення" link calls openChat(order, token, date) — we click
  // it so the page supplies the token. Login selectors are best-effort (WordPress) —
  // verify with codegen against the login page and set ITRAVEL_LOGIN_URL if different.
  itravel: {
    loginEmail: [
      'input[type="email"]',
      'input[name*="email" i]',
      'input[name*="login" i]',
      'input[name="log"]',
      '#user_login',
    ],
    loginPassword: ['input[type="password"]', 'input[name*="pass" i]', 'input[name="pwd"]', '#user_pass'],
    loginSubmit: [
      'button[type="submit"]',
      'input[type="submit"]',
      '#wp-submit',
      'button:has-text("Увійти")',
      'button:has-text("Вхід")',
    ],
    loggedInMarker: ['text=Особистий кабінет', 'a:has-text("Вихід")', 'text=Замовлення'],
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
