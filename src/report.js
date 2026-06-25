// Веде Google-таблицю "трекер надання контактів": один рядок на заявку,
// upsert по № заявки (стовпець A). Авторизація — OAuth2 user-token
// (client id/secret + refresh token); діє від імені Google-акаунта, що володіє
// таблицею. Працює лише коли REPORT_ENABLED=true і задані всі креди.
// НІКОЛИ не кидає виняток у викликача — збій звіту не має ламати роботу бота
// (тому googleapis імпортується динамічно, а виклик обгорнутий try/catch).
import { config } from './config.js';
import { log } from './logger.js';

// Порядок стовпців фіксований — має збігатися з шапкою у таблиці.
export const HEADER = [
  '№ заявки',
  'ID запиту',
  'Країна',
  'Дата бронювання',
  'Дата заїзду',
  'Наявність телефона',
  'Запитано в агента',
  'Номер надано агентом',
  'Номер у заявці',
  'Номер у заявці Елайн',
  'Статус',
  'Останнє оновлення',
  'Примітки',
];

export function reportEnabled() {
  const r = config.report;
  return Boolean(
    r.enabled && r.spreadsheetId && r.clientId && r.clientSecret && r.refreshToken
  );
}

// "YYYY-MM-DD HH:mm" у часовому поясі бота.
function nowInTz() {
  const d = new Date();
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
  return `${date} ${time}`;
}

// Поточні складові часу в часовому поясі ТАБЛИЦІ (щоб NOW()-heartbeat був точний).
function dateParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const p = {};
  for (const part of f.formatToParts(date)) if (part.type !== 'literal') p[part.type] = part.value;
  const h = p.hour === '24' ? '00' : p.hour;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +h, mi: +p.minute, s: +p.second };
}

// Об'єкт рядка -> масив значень у фіксованому порядку стовпців.
function rowToValues(r, updatedAt) {
  return [
    r.bookingId ?? '',
    r.elineRef ?? '',
    r.country ?? '',
    r.bookingDate ?? '',
    r.checkinDate ?? '',
    r.phonePresent ?? '',
    r.asked ?? '',
    r.agentNumber ?? '',
    r.writtenInBooking ?? '',
    r.writtenInEline ?? '',
    r.status ?? '',
    updatedAt,
    r.note ?? '',
  ];
}

async function getSheets() {
  // Динамічний імпорт: якщо пакет не встановлено, впаде лише крок звіту.
  const { google } = await import('googleapis');
  const r = config.report;
  const auth = new google.auth.OAuth2(r.clientId, r.clientSecret);
  auth.setCredentials({ refresh_token: r.refreshToken });
  return google.sheets({ version: 'v4', auth });
}

// Якщо назву вкладки не задано — беремо першу вкладку таблиці.
async function resolveTab(sheets) {
  if (config.report.sheetName) return config.report.sheetName;
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: config.report.spreadsheetId,
  });
  return meta.data.sheets?.[0]?.properties?.title || 'Sheet1';
}

// Upsert рядків по № заявки (стовпець A). Повертає { updated, appended }.
export async function upsertRows(rows) {
  if (!rows || !rows.length) return { updated: 0, appended: 0 };
  const r = config.report;
  const sheets = await getSheets();
  const tab = await resolveTab(sheets);
  const updatedAt = nowInTz();

  // 1) Зчитуємо наявні № заявок (стовпець A), щоб знати, що оновлювати.
  const getRes = await sheets.spreadsheets.values.get({
    spreadsheetId: r.spreadsheetId,
    range: `${tab}!A1:A100000`,
  });
  const colA = (getRes.data.values || []).map((x) => (x[0] ?? '').toString().trim());

  const data = []; // пакет оновлень (шапка + оновлення наявних рядків)
  const headerPresent = colA.length > 0 && colA[0] === HEADER[0];
  if (!headerPresent) data.push({ range: `${tab}!A1`, values: [HEADER] });

  // Карта № заявки -> номер рядка (1-based).
  const idToRow = new Map();
  for (let i = 0; i < colA.length; i++) {
    if (i === 0 && headerPresent) continue; // пропускаємо шапку
    const id = colA[i];
    if (id) idToRow.set(id, i + 1);
  }

  const appends = [];
  const willAppend = new Set();
  let updated = 0;
  for (const row of rows) {
    const id = (row.bookingId ?? '').toString().trim();
    if (!id) continue;
    const values = rowToValues(row, updatedAt);
    const existing = idToRow.get(id);
    if (existing) {
      data.push({ range: `${tab}!A${existing}:M${existing}`, values: [values] });
      updated += 1;
    } else if (!willAppend.has(id)) {
      appends.push(values);
      willAppend.add(id);
    }
  }

  if (data.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: r.spreadsheetId,
      requestBody: { valueInputOption: 'USER_ENTERED', data },
    });
  }
  if (appends.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: r.spreadsheetId,
      range: `${tab}!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: appends },
    });
  }

  log.info(`[report] Google Sheet: ${updated} оновлено, ${appends.length} додано.`);
  return { updated, appended: appends.length };
}

// Пише «пульс» бота + бейдж статусу праворуч угорі звіту (комірки O1:R1):
//   O1 = підпис, P1 = бейдж 🟢/🔴 (формула на NOW()), Q1 = людський час,
//   R1 = технічний час останнього запуску (вхід для формули).
// Бейдж САМ перемикається на «НЕ АКТИВНИЙ», якщо бот не оновлював > 90 хв.
// Best-effort: ніколи не кидає виняток.
export async function writeBotStatus() {
  if (!reportEnabled()) return;
  try {
    const r = config.report;
    const sheets = await getSheets();
    const tab = await resolveTab(sheets);
    let tz = config.tz;
    try {
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: r.spreadsheetId,
        fields: 'properties.timeZone',
      });
      tz = meta.data.properties?.timeZone || config.tz;
    } catch {
      /* лишаємо config.tz */
    }
    const p = dateParts(new Date(), tz);
    const pad = (n) => String(n).padStart(2, '0');
    const readable = `оновлено ${pad(p.d)}.${pad(p.mo)}.${p.y} ${pad(p.h)}:${pad(p.mi)}`;
    const heartbeat = `=DATE(${p.y},${p.mo},${p.d})+TIME(${p.h},${p.mi},${p.s})`;
    const badge = '=IF((NOW()-$R$1)*1440<=90,"🟢 БОТ АКТИВНИЙ","🔴 БОТ НЕ АКТИВНИЙ")';
    await sheets.spreadsheets.values.update({
      spreadsheetId: r.spreadsheetId,
      range: `${tab}!O1:R1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['Статус бота', badge, readable, heartbeat]] },
    });
    log.info('[report] bot-status badge updated.');
  } catch (e) {
    log.warn('[report] bot-status write failed: ' + e.message);
  }
}
