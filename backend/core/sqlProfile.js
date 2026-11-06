// Opt-in SQL profiler for a running instance (ICC_SQL_PROFILE=1 in .env, then
// restart). Wraps better-sqlite3 statement execution, aggregates time and call
// counts by statement text, and writes the top statements to the log once a
// minute while anything ran. The request timing middleware reads the same
// counters to attribute a slow request to its heaviest statements. Costs a
// few microseconds per statement, so it stays off unless asked for.
const AGG = new Map();
let installed = false;
let totalMs = 0;
let totalCalls = 0;

function enabled() {
  const v = String(process.env.ICC_SQL_PROFILE || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function keyOf(sql) {
  return String(sql).replace(/\s+/g, ' ').trim().slice(0, 200);
}

function record(key, ms) {
  const e = AGG.get(key) || { n: 0, ms: 0, max: 0 };
  e.n += 1; e.ms += ms; if (ms > e.max) e.max = ms;
  AGG.set(key, e);
  totalMs += ms; totalCalls += 1;
}

/** Patch better-sqlite3 once. Safe to call when the module is absent. */
function install(logger) {
  if (installed || !enabled()) return false;
  let Database;
  try { Database = require('better-sqlite3'); } catch { return false; }
  const prepare = Database.prototype.prepare;
  Database.prototype.prepare = function patchedPrepare(sql) {
    const stmt = prepare.call(this, sql);
    const key = keyOf(sql);
    for (const m of ['all', 'get', 'run']) {
      const f = stmt[m];
      if (typeof f !== 'function') continue;
      stmt[m] = function timed(...args) {
        const t0 = process.hrtime.bigint();
        try { return f.apply(this, args); } finally { record(key, Number(process.hrtime.bigint() - t0) / 1e6); }
      };
    }
    return stmt;
  };
  installed = true;
  if (logger) {
    logger.warn('[sqlprof] SQL profiler on (ICC_SQL_PROFILE=1): top statements logged every 60 s, slow requests carry their heaviest statements');
    const timer = setInterval(() => {
      const lines = top(10);
      if (!lines.length) return;
      logger.info(`[sqlprof] last minute: ${totalCalls} statements, ${totalMs.toFixed(0)} ms\n${lines.join('\n')}`);
      AGG.clear(); totalMs = 0; totalCalls = 0;
    }, 60000);
    timer.unref();
  }
  return true;
}

/** Top N statements since the last minute dump, formatted. */
function top(n = 10) {
  return [...AGG.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, n)
    .map(([k, v]) => `  ${v.ms.toFixed(0).padStart(7)} ms ${String(v.n).padStart(6)} x  max ${v.max.toFixed(0)} ms  ${k}`);
}

/** Snapshot of the counters: { ms, calls, entries: Map copy }. */
function snapshot() {
  return { ms: totalMs, calls: totalCalls, entries: new Map([...AGG.entries()].map(([k, v]) => [k, { ...v }])) };
}

/** Top statements that ran between two snapshots (approximate: requests interleave across awaits). */
function diffTop(before, after, n = 3) {
  const rows = [];
  for (const [k, v] of after.entries) {
    const b = before.entries.get(k);
    const ms = v.ms - (b ? b.ms : 0);
    const calls = v.n - (b ? b.n : 0);
    if (calls > 0 && ms > 0) rows.push({ k, ms, calls });
  }
  return rows.sort((a, b) => b.ms - a.ms).slice(0, n);
}

module.exports = { install, enabled, isInstalled: () => installed, snapshot, diffTop, top };
