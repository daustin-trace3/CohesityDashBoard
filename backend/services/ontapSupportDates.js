// ONTAP software support dates, matched to a release string. Data comes from
// ontapSupportTable.json (NetApp KB "What are the ONTAP Software Version
// Support dates"). NetApp publishes no release dates and no phase definitions
// there, so this module reports only the last day of each phase.
const table = require('./ontapSupportTable.json');

const DAY_MS = 86400000;
const byLine = new Map(table.lines.map((l) => [l.line, l]));

// Accepts "9.13.1P8", "NetApp Release 9.8P3: Thu ...", "8.3". Patch level is
// parsed but irrelevant to support lookups.
function parseOntapVersion(v) {
  if (!v) return null;
  const m = String(v).replace(/^NetApp Release\s*/i, '').match(/(\d+(?:\.\d+){1,4})(?:P(\d+))?/);
  if (!m) return null;
  return { parts: m[1].split('.').map(Number), patch: m[2] != null ? Number(m[2]) : 0 };
}

function utcDay(d) {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function isoDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function unknown() {
  return {
    line: null,
    product: null,
    end_full_support: null,
    end_limited_support: null,
    end_self_service_support: null,
    phase: 'unknown',
    days_to_end_full_support: null,
    days_to_end_limited_support: null,
    next_milestone: { label: null, date: null, days: null },
  };
}

function lookup(release, now = new Date()) {
  const p = parseOntapVersion(release);
  if (!p) return unknown();
  let row = null;
  if (p.parts.length >= 3) row = byLine.get(p.parts.slice(0, 3).join('.'));
  if (!row && p.parts.length >= 2) row = byLine.get(p.parts.slice(0, 2).join('.'));
  if (!row) return unknown();

  const today = utcDay(now);
  const full = isoDay(row.end_full_support);
  const limited = isoDay(row.end_limited_support);
  const self = isoDay(row.end_self_service_support);
  const diff = (t) => Math.round((t - today) / DAY_MS);

  let phase;
  let milestone;
  if (today <= full) { phase = 'full'; milestone = { label: 'end of full support', date: row.end_full_support, days: diff(full) }; }
  else if (today <= limited) { phase = 'limited'; milestone = { label: 'end of limited support', date: row.end_limited_support, days: diff(limited) }; }
  else if (today <= self) { phase = 'self-service'; milestone = { label: 'end of self-service support', date: row.end_self_service_support, days: diff(self) }; }
  else { phase = 'unsupported'; milestone = { label: null, date: null, days: null }; }

  return {
    line: row.line,
    product: row.product,
    end_full_support: row.end_full_support,
    end_limited_support: row.end_limited_support,
    end_self_service_support: row.end_self_service_support,
    phase,
    days_to_end_full_support: diff(full),
    days_to_end_limited_support: diff(limited),
    next_milestone: milestone,
  };
}

function tableInfo() {
  return { source: table.source, captured: table.captured, line_count: table.lines.length };
}

module.exports = { lookup, tableInfo, parseOntapVersion };
