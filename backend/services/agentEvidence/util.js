// Shared helpers for the Ops Agent platform evidence providers. Every query is
// read-only and guarded: a table or column may not exist on a branch, a
// pack-served install, or before a later migration ran, and evidence must never
// fail a triage.

const EVIDENCE_TZ = 'America/Los_Angeles';
const DAY_MS = 86400000;
const LINE_CHARS = 200;
let tzFmt = null;

function all(db, sql, ...args) {
  try { return db.prepare(sql).all(...args); } catch { return []; }
}
const one = (db, sql, ...args) => all(db, sql, ...args)[0] || null;

/** Column names of a table (empty set when the table is missing). */
function colsOf(db, table) {
  try { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)); } catch { return new Set(); }
}
const hasTable = (db, table) => colsOf(db, table).size > 0;

const lc = (s) => String(s == null ? '' : s).trim().toLowerCase();
/** Alert host strings sometimes carry a suffix ("web01 (vm)"): keep the name. */
const cleanHost = (s) => String(s || '').replace(/\s*\([^)]*\)\s*$/, '').split(/[\s,]/)[0].trim();
const clip = (s, n = LINE_CHARS) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 3)}...` : t;
};

function listOf(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String);
  const s = String(v).trim();
  if (s.startsWith('[')) { try { const j = JSON.parse(s); if (Array.isArray(j)) return j.map(String); } catch { /* fall through */ } }
  return s.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
}

/** Epoch ms from an epoch number, a zoneless SQLite stamp (UTC), or an ISO string. null when unreadable. */
function parseMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  if (/^\d{10,}$/.test(s)) return Number(s);
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) s = `${s.replace(' ', 'T')}Z`;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

/** Pacific wall clock like the incident emails: "9-27-2026 5:30am PDT". */
function fmtT(v) {
  const ms = parseMs(v);
  if (ms == null) return v == null || v === '' ? '-' : String(v);
  tzFmt ||= new Intl.DateTimeFormat('en-US', {
    timeZone: EVIDENCE_TZ, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
  });
  const p = {};
  for (const part of tzFmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  return `${p.month}-${p.day}-${p.year} ${p.hour}:${p.minute}${(p.dayPeriod || '').toLowerCase()} ${p.timeZoneName || ''}`.trim();
}

const zl = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const iso = (ms) => new Date(ms).toISOString();

/** "2 h 5 m" from minutes. */
function minutesText(min) {
  if (min == null || !Number.isFinite(Number(min))) return '-';
  const m = Math.max(0, Math.round(Number(min)));
  if (m < 60) return `${m} m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} m` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}
const secondsText = (s) => (s == null ? '-' : minutesText(Number(s) / 60));
function agoText(ms, now = Date.now()) {
  if (ms == null) return 'never';
  const h = Math.max(0, Math.round((now - ms) / 3600000));
  return h < 48 ? `${h} hours ago` : `${Math.round(h / 24)} days ago`;
}

const round1 = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 10) / 10);
const pctOf = (n, d) => (d ? round1((Number(n) / Number(d)) * 100) : null);
const pctText = (n) => (n == null ? '-' : `${Math.round(n)}%`);
/** Whole-number percent unless it is fractional below 10. */
const num = (n) => (n == null ? '-' : String(Math.round(Number(n) * 10) / 10));

/** Names the incident points at for one platform, in pick order: the incident's own host (ctx.subject),
 *  then the platform's evidence hosts, then its open alert hosts. Short names (before the first dot) come
 *  last so an FQDN subject still resolves against tables that store the short form. */
function subjectsFor(ctx, platform) {
  const out = [];
  const add = (s) => { const v = cleanHost(s); if (v && !out.some((x) => lc(x) === lc(v))) out.push(v); };
  if (ctx && ctx.subject) add(ctx.subject);
  for (const h of (ctx && ctx.hosts) || []) if (h && h.platform === platform) add(h.host);
  for (const a of (ctx && ctx.alerts) || []) if (a && a.platform === platform && !a.cleared_at) add(a.host);
  for (const n of [...out]) { const short = n.split('.')[0]; if (short && short !== n) add(short); }
  return out;
}
const alertsFor = (ctx, platform) => ((ctx && ctx.alerts) || []).filter((a) => a && a.platform === platform);

/** Window start: 24 h before the incident anchor (the first alert), never later than now. */
function windowStart(ctx, ms = DAY_MS) {
  const anchor = ctx && Number.isFinite(Number(ctx.anchorMs)) ? Number(ctx.anchorMs) : Date.now();
  return Math.min(anchor, Date.now()) - ms;
}

function emptyFacts() {
  return { state: null, since: null, openedTimes30d: null, meanMinutesOpen30d: null, metric: null, protection: null, replication: null };
}

function makeBlock(platform, subject, title, lines, facts) {
  const clean = (lines || []).filter(Boolean).map((l) => clip(l));
  if (!clean.length) return null;
  return { platform, subject, title, lines: clean, facts: { ...emptyFacts(), ...(facts || {}) } };
}

/** Opened-count and mean open minutes from issue-history style rows ({first_seen, resolved_at}). */
function issueStats(rows) {
  const list = rows || [];
  let sum = 0;
  let n = 0;
  for (const r of list) {
    const a = parseMs(r.first_seen);
    const b = parseMs(r.resolved_at);
    if (a != null && b != null && b >= a) { sum += (b - a) / 60000; n += 1; }
  }
  return { opened: list.length, meanMinutes: n ? Math.round(sum / n) : null, currentOpen: list.filter((r) => !r.resolved_at).length };
}

/** "Issue <type> on <subject> opened N times in 30 days, mean M minutes open", or null when it carries nothing new. */
function issueLine(type, subject, rows) {
  const st = issueStats(rows);
  if (st.opened === 0 || (st.opened === 1 && st.currentOpen === 1)) return { line: null, stats: st };
  const mean = st.meanMinutes != null ? `, mean ${st.meanMinutes} minutes open` : '';
  return { line: `Issue ${type || 'alert'} on ${subject} opened ${st.opened} times in 30 days${mean}`, stats: st };
}

module.exports = {
  DAY_MS, LINE_CHARS, all, one, colsOf, hasTable, lc, cleanHost, clip, listOf, parseMs, fmtT, zl, iso,
  minutesText, secondsText, agoText, round1, pctOf, pctText, num, subjectsFor, alertsFor, windowStart,
  emptyFacts, makeBlock, issueStats, issueLine,
};
