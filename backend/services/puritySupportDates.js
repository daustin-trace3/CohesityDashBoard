// Purity//FA code end-of-life dates, matched to a version string. Data comes
// from puritySupportTable.json (Pure community GA announcements; the support KB
// schedule is login-gated, so the table says where its dates came from).
// A release line is end of life the day after its end-of-development date.
const table = require('./puritySupportTable.json');

const DAY_MS = 86400000;
const byLine = new Map(table.lines.map((l) => [l.line, l]));

// Accepts "6.7.9", "6.5.11", "Purity//FA 6.9.4". Only major.minor matters.
function parsePurityVersion(v) {
  if (!v) return null;
  const m = String(v).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), micro: m[3] != null ? Number(m[3]) : null };
}

function utcDay(d) {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function isoDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function unknown() {
  return { line: null, kind: null, end_of_development: null, days_to_eol: null, phase: 'unknown' };
}

/**
 * phase: 'eol' (today is past end_of_development), 'approaching' (within
 * warnDays), 'supported', or 'unknown' (no table row or unparseable).
 * days_to_eol counts days to the end-of-development date and goes negative
 * once it has passed.
 */
function lookup(version, now = new Date(), warnDays = 180) {
  const p = parsePurityVersion(version);
  if (!p) return unknown();
  const row = byLine.get(`${p.major}.${p.minor}`);
  if (!row) return unknown();
  const today = utcDay(now);
  const end = isoDay(row.end_of_development);
  const days = Math.round((end - today) / DAY_MS);
  let phase = 'supported';
  if (today > end) phase = 'eol';
  else if (days <= warnDays) phase = 'approaching';
  return {
    line: row.line,
    kind: row.kind,
    end_of_development: row.end_of_development,
    days_to_eol: days,
    phase,
  };
}

function tableInfo() {
  return { source: table.source, captured: table.captured, note: table.note, line_count: table.lines.length };
}

module.exports = { lookup, tableInfo, parsePurityVersion };
