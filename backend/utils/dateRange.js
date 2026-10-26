'use strict';

// Shared range parameters for Backup History routes and their CSV exports.
// Query: days (1..maxDays) OR from + to (YYYY-MM-DD, inclusive), tz (minutes,
// the browser's getTimezoneOffset(): tz=420 is UTC-7). from/to win over days.

const DAY_MS = 86400000;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function bad(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function pad(n) { return String(n).padStart(2, '0'); }

function dayStartUtcMs(day) {
  const m = DAY_RE.exec(day);
  if (!m) return NaN;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  // Reject rollovers such as 2026-02-31.
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return NaN;
  return ms;
}

function isoDay(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function parseDateRange(query = {}, { defaultDays = 30, maxDays = 365 } = {}) {
  let tz = 0;
  if (query.tz !== undefined && query.tz !== '') {
    tz = Number(query.tz);
    if (!Number.isInteger(tz) || tz < -840 || tz > 840) throw bad('tz must be an integer between -840 and 840');
  }
  const hasCustom = (query.from !== undefined && query.from !== '') || (query.to !== undefined && query.to !== '');
  let fromDay;
  let toDay;
  let days;
  let mode;
  if (hasCustom) {
    fromDay = String(query.from || '');
    toDay = String(query.to || '');
    const f = dayStartUtcMs(fromDay);
    const t = dayStartUtcMs(toDay);
    if (Number.isNaN(f) || Number.isNaN(t)) throw bad('from and to must both be YYYY-MM-DD dates');
    if (f > t) throw bad('from must not be after to');
    days = Math.round((t - f) / DAY_MS) + 1;
    if (days > maxDays) throw bad(`range must not exceed ${maxDays} days`);
    mode = 'custom';
  } else {
    days = query.days === undefined || query.days === '' ? defaultDays : Number(query.days);
    if (!Number.isInteger(days) || days < 1 || days > maxDays) throw bad(`days must be an integer between 1 and ${maxDays}`);
    // "Today" in the browser's local calendar.
    const todayLocal = Math.floor((Date.now() - tz * 60000) / DAY_MS) * DAY_MS;
    toDay = isoDay(todayLocal);
    fromDay = isoDay(todayLocal - (days - 1) * DAY_MS);
    mode = 'days';
  }
  // Local midnight expressed in UTC ms: local = UTC - tz, so UTC = local + tz.
  const fromMs = dayStartUtcMs(fromDay) + tz * 60000;
  const toMs = dayStartUtcMs(toDay) + tz * 60000 + DAY_MS - 1;
  return {
    fromMs, toMs,
    fromIso: new Date(fromMs).toISOString(),
    toIso: new Date(toMs).toISOString(),
    fromDay, toDay, days, tz, mode,
  };
}

/** Local calendar day keys for the range, newest first. */
function rangeDayKeys(range) {
  const out = [];
  const last = dayStartUtcMs(range.toDay);
  for (let i = 0; i < range.days; i++) out.push(isoDay(last - i * DAY_MS));
  return out;
}

function rangeFilename(platform, range) {
  return `${platform}-backup-history-${range.fromDay}_${range.toDay}.csv`;
}

/** The response block every backup-history route adds. */
function rangeResponse(range, historyDays) {
  const truncated = historyDays != null && range.fromMs < Date.now() - historyDays * DAY_MS;
  return {
    range: { mode: range.mode, days: range.days, fromDay: range.fromDay, toDay: range.toDay, fromMs: range.fromMs, toMs: range.toMs, tz: range.tz },
    dayKeys: rangeDayKeys(range),
    historyDays: historyDays == null ? null : historyDays,
    truncated,
  };
}

module.exports = { parseDateRange, rangeDayKeys, rangeFilename, rangeResponse };
