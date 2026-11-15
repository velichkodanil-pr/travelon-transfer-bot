// Hour gate for Railway Cron.
//
// Railway Cron fires in UTC, while CHECK_CRON is written in CRON_TZ (Kyiv), and
// Kyiv is UTC+2 in winter but UTC+3 in summer. So the Railway schedule lists the
// UTC hours for BOTH offsets, and every RUN_ONCE start asks this gate whether the
// current hour in CRON_TZ is one of CHECK_CRON's hours. If not, the run exits at
// once (a few seconds of container time, once or twice a day) — the bot keeps
// firing at the same Kyiv hours all year without anyone editing the schedule.
//
// Only the HOUR field is checked: a cron container can start a few seconds or
// minutes after the tick, so a minute match would be unreliable. An hour field
// this parser does not understand lets the run through (never blocks a cycle).

// Hour 0-23 of `date` in time zone `tz`.
export function hourInTz(date, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const h = Number((parts.find((p) => p.type === 'hour') || {}).value);
  return h === 24 ? 0 : h;
}

// "7-23" | "6,15" | "*" | "*/3" | "8-20/2" | "5/4" -> Set of hours, or null when
// the field is not understood.
export function parseHourField(field) {
  const out = new Set();
  const s = String(field || '').trim();
  if (!s) return null;
  for (const part of s.split(',')) {
    const m = part.trim().match(/^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/);
    if (!m) return null;
    let from;
    let to;
    if (m[1] === '*') {
      from = 0;
      to = 23;
    } else if (m[1].includes('-')) {
      [from, to] = m[1].split('-').map(Number);
    } else {
      from = Number(m[1]);
      to = m[2] ? 23 : from; // "5/4" = from 5 to the end, every 4
    }
    const step = m[2] ? Number(m[2]) : 1;
    if (!(from >= 0 && to <= 23 && from <= to && step >= 1)) return null;
    for (let h = from; h <= to; h += step) out.add(h);
  }
  return out.size ? out : null;
}

// Does the hour of `date` in `tz` match the hour field of `expr`? 5-field and
// 6-field (with seconds, as node-cron allows) expressions are supported.
export function cronHourMatches(expr, date = new Date(), tz = 'Europe/Kyiv') {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return true;
  const hours = parseHourField(fields.length === 6 ? fields[2] : fields[1]);
  if (!hours) return true;
  return hours.has(hourInTz(date, tz));
}
