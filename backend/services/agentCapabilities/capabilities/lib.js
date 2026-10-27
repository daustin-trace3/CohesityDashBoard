// Shared helpers for the platform-api capabilities. Not a capability itself
// (index.js loads capabilities from an explicit list). Everything here is
// read-only: row lookups in ICC's own tables, output shaping and a window
// start. Vendor calls always go through the platform API module with the
// stored row; nothing in this folder decrypts or logs a credential.
const db = require('../../../db/database');

const MAX_LINES = 8;
const MAX_LINE_CHARS = 200;
const MAX_BYTES = 2048;
const HOUR = 3600000;

/** First row of a query or null; never throws (a missing table is "no row"). */
function sq(sql, ...args) {
  try { return db.prepare(sql).get(...args) || null; } catch { return null; }
}
function sqAll(sql, ...args) {
  try { return db.prepare(sql).all(...args); } catch { return []; }
}

/** Platform API module by file name, resolved when used so a test can swap a function on it. */
const api = (name) => require(`../../${name}`);

/** Epoch ms from an ISO string or a zoneless SQLite 'YYYY-MM-DD HH:MM:SS' (UTC). */
function toMs(v) {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) return Date.parse(`${s.replace(' ', 'T')}Z`);
  return Date.parse(s);
}

/** Incident onset: earliest first_seen of the open alerts, else the incident's opened_at, else now. */
function onsetMs(ctx) {
  const times = [];
  for (const a of (ctx && ctx.alerts) || []) { const t = toMs(a.first_seen); if (Number.isFinite(t)) times.push(t); }
  if (times.length) return Math.min(...times);
  const t = toMs(ctx && ctx.incident && ctx.incident.opened_at);
  return Number.isFinite(t) ? t : Date.now();
}
const isoAt = (ms) => new Date(ms).toISOString();
/** SQLite-style UTC stamp for comparing against DATETIME columns. */
const sqliteStamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const isoOfSqlite = (s) => { const t = toMs(s); return Number.isFinite(t) ? new Date(t).toISOString() : String(s); };

/** Lower-case name forms a target answers to: its name, the short form, the identity label. */
function nameForms(target) {
  const out = new Set();
  const add = (v) => {
    const s = String(v || '').trim().toLowerCase();
    if (!s) return;
    out.add(s);
    const short = s.split('.')[0];
    if (short && !/^\d+$/.test(short)) out.add(short);
  };
  add(target && target.name);
  const ref = target && target.identity && target.identity.ref;
  if (ref) { add(ref.label); for (const n of ref.names || []) add(n); }
  return [...out];
}

/** Does the target's identity or source resolve to this platform? */
function targetPlatforms(target) {
  const set = new Set();
  const id = target && target.identity;
  if (id) { for (const p of id.platforms || []) set.add(p); if (id.ref && id.ref.platform) set.add(id.ref.platform); }
  if (target && target.source && target.source.platform) set.add(target.source.platform);
  return set;
}

/** Cap lines to 8 x 200 chars and 2 KB in all. */
function boundLines(lines) {
  const out = [];
  let bytes = 0;
  for (const l of lines || []) {
    if (out.length >= MAX_LINES) break;
    let s = String(l == null ? '' : l).replace(/[\r\n]+/g, ' ').trim();
    if (!s) continue;
    if (s.length > MAX_LINE_CHARS) s = `${s.slice(0, MAX_LINE_CHARS - 3)}...`;
    if (bytes + s.length > MAX_BYTES) break;
    bytes += s.length;
    out.push(s);
  }
  return out;
}

const fmtMs = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`; };

module.exports = {
  db, sq, sqAll, api, toMs, onsetMs, isoAt, sqliteStamp, isoOfSqlite, nameForms, targetPlatforms,
  boundLines, fmtMs, MAX_LINES, MAX_LINE_CHARS, MAX_BYTES, HOUR,
};
