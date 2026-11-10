// ICC reporting on ICC (Global Settings > System Health): poll run records, the
// per process sample the heartbeat carries, the database snapshot and the poller
// sweep that keeps it fresh. Everything that runs inside the poller or the
// heartbeat is wrapped so a failure here never reaches the work it measures.
const fs = require('fs');
const { monitorEventLoopDelay } = require('perf_hooks');
const logger = require('../utils/logger');

const SNAPSHOT_KEY = 'icc_health_db_snapshot';
const REFRESH_KEY = 'icc_health_db_refresh_requested';
const SWEEP_FIRST_MS = 60000;
const SWEEP_TICK_MS = 30000;
const SNAPSHOT_EVERY_MS = 15 * 60000;
const PRUNE_EVERY_MS = 60 * 60000;
const RUN_KEEP_DAYS = 7;
/** The web route computes a missing snapshot inline only below this file size. */
const INLINE_MAX_BYTES = 256 * 1024 * 1024;

const mb = (n) => Math.round(n / 1048576);

// --- poll run records ---------------------------------------------------------

let warnedInsert = false;

/** Never throws. One debug line the first time an insert fails. */
function recordPollRun(rec) {
  try {
    const db = require('../db/database');
    db.prepare(`
      INSERT INTO icc_poll_runs (platform, source_id, source_name, kind, started_at, ended_at, duration_ms, status, error, rss_before_mb, rss_after_mb)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(rec.platform), Number(rec.sourceId) || 0, rec.sourceName == null ? null : String(rec.sourceName), rec.kind || 'poll',
      rec.startedAt, rec.endedAt, Math.max(0, Math.round(rec.durationMs)), rec.status === 'error' ? 'error' : 'success',
      rec.error ? String(rec.error).slice(0, 300) : null, rec.rssBeforeMb == null ? null : rec.rssBeforeMb, rec.rssAfterMb == null ? null : rec.rssAfterMb,
    );
  } catch (err) {
    if (!warnedInsert) { warnedInsert = true; logger.debug(`[health] could not record a poll run: ${err.message}`); }
  }
}

function pruneRuns(db, now = Date.now()) {
  const { pruneInBatches } = require('../core/dbPrune');
  const cutoff = new Date(now - RUN_KEEP_DAYS * 86400000).toISOString();
  return pruneInBatches(db, 'icc_poll_runs', 'started_at < ?', [cutoff]);
}

// --- event loop and process sample -------------------------------------------

let loopHist = null;
try { loopHist = monitorEventLoopDelay({ resolution: 20 }); loopHist.enable(); } catch { loopHist = null; }

function readLoopLagP99Ms({ reset = true } = {}) {
  if (!loopHist) return 0;
  const ms = Math.round((loopHist.percentile(99) / 1e6) * 10) / 10;
  if (reset) loopHist.reset();
  return Number.isFinite(ms) ? ms : 0;
}

// The web route asks on every page refresh; reading and resetting each time would
// shrink the window to nothing, so the value is refreshed at most every 25 s.
let webLag = { at: 0, value: 0 };
function webLoopLagP99Ms() {
  const now = Date.now();
  if (now - webLag.at >= 25000) webLag = { at: now, value: readLoopLagP99Ms() };
  return webLag.value;
}

function memSample() {
  const m = process.memoryUsage();
  return { rssMb: mb(m.rss), heapUsedMb: mb(m.heapUsed), heapTotalMb: mb(m.heapTotal), externalMb: mb(m.external) };
}

function logSummary(recentMax = 10, msgMax = 200) {
  const s = logger.stats();
  return {
    error: s.error, warn: s.warn,
    recent: s.recent.slice(-recentMax).map((r) => ({ at: r.at, level: r.level, msg: String(r.msg).slice(0, msgMax) })),
  };
}

function dbCounters() {
  try {
    const s = require('../core/dbTransactions').stats();
    return { slowTransactions: s.slowTransactions, busyRetries: s.busyRetries };
  } catch { return { slowTransactions: 0, busyRetries: 0 }; }
}

function pollingStats() {
  try {
    const s = require('../core/pollerFramework').stats();
    return { active: s.active, queued: s.queued };
  } catch { return { active: 0, queued: 0 }; }
}

/** What each heartbeat adds to its payload. Reads and resets the loop lag window. */
function processSample() {
  return {
    mem: memSample(),
    loopLagP99Ms: readLoopLagP99Ms(),
    nodeVersion: process.version,
    polling: pollingStats(),
    log: logSummary(),
    db: dbCounters(),
  };
}

// --- database snapshot --------------------------------------------------------

function fileBytes(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function dbSnapshot(db, dbPath) {
  const t0 = Date.now();
  const file = dbPath || db.name;
  const master = db.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('table', 'index')").all();
  const tableNames = new Set(master.filter((m) => m.type === 'table').map((m) => m.name));
  const indexOwner = new Map(master.filter((m) => m.type === 'index').map((m) => [m.name, m.tbl_name]));

  const bytes = new Map();
  const indexBytes = new Map();
  try {
    for (const r of db.prepare('SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name').all()) {
      if (tableNames.has(r.name)) bytes.set(r.name, (bytes.get(r.name) || 0) + r.bytes);
      else if (indexOwner.has(r.name)) {
        const owner = indexOwner.get(r.name);
        indexBytes.set(owner, (indexBytes.get(owner) || 0) + r.bytes);
      } else if (r.name === 'sqlite_master' || r.name === 'sqlite_schema') {
        bytes.set('sqlite_master', (bytes.get('sqlite_master') || 0) + r.bytes);
      }
    }
  } catch (err) {
    logger.debug(`[health] dbstat unavailable: ${err.message}`);
  }
  if (bytes.has('sqlite_master')) tableNames.add('sqlite_master');

  const tables = [];
  for (const name of tableNames) {
    let rows = 0;
    try { rows = db.prepare(`SELECT COUNT(*) AS c FROM "${name.replace(/"/g, '""')}"`).get().c; } catch { rows = 0; }
    tables.push({ name, rows, bytes: bytes.get(name) || 0, indexBytes: indexBytes.get(name) || 0 });
  }
  tables.sort((a, b) => (b.bytes + b.indexBytes) - (a.bytes + a.indexBytes) || a.name.localeCompare(b.name));

  const pragma = (p) => db.pragma(p, { simple: true });
  const totals = tables.reduce((t, r) => ({ tables: t.tables + 1, rows: t.rows + r.rows, bytes: t.bytes + r.bytes, indexBytes: t.indexBytes + r.indexBytes }), { tables: 0, rows: 0, bytes: 0, indexBytes: 0 });
  return {
    at: new Date().toISOString(), path: file,
    fileBytes: fileBytes(file), walBytes: fileBytes(`${file}-wal`),
    pageSize: pragma('page_size'), pageCount: pragma('page_count'), freelistPages: pragma('freelist_count'),
    journalMode: pragma('journal_mode'),
    tables, totals, computeMs: Date.now() - t0,
  };
}

function readSnapshot() {
  try {
    const raw = require('./settings').getSetting(SNAPSHOT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function storeSnapshot(snap) {
  require('./settings').setSetting(SNAPSHOT_KEY, JSON.stringify(snap));
}

// --- poller sweep -------------------------------------------------------------

/** Runs fn(db, tenantId) once per tenant database on feat, once for the single database elsewhere. */
function eachDb(fn) {
  let registry = null;
  try { registry = require('../core/tenantRegistry'); } catch { registry = null; }
  if (registry) {
    registry.forEachTenant((tenantId) => fn(registry.getHandle(tenantId), tenantId));
  } else {
    fn(require('../db/database'), null);
  }
}

let timer = null;
let first = null;
const lastSnapshotAt = new Map();
let lastPruneAt = 0;

function sweepTick() {
  const { getSetting, setSetting } = require('./settings');
  const now = Date.now();
  const prune = now - lastPruneAt >= PRUNE_EVERY_MS;
  if (prune) lastPruneAt = now;
  try {
    eachDb((db, tenantId) => {
      const key = tenantId || 'single';
      try {
        const requested = !!getSetting(REFRESH_KEY);
        if (requested || now - (lastSnapshotAt.get(key) || 0) >= SNAPSHOT_EVERY_MS) {
          lastSnapshotAt.set(key, now);
          const snap = dbSnapshot(db, db.name);
          storeSnapshot(snap);
          if (requested) setSetting(REFRESH_KEY, '');
          logger.debug(`[health] db snapshot ${tenantId || ''}: ${snap.totals.tables} tables, ${mb(snap.fileBytes)} MB, ${snap.computeMs} ms`);
        }
        if (prune) pruneRuns(db, now);
      } catch (err) {
        logger.debug(`[health] sweep failed${tenantId ? ` for tenant ${tenantId}` : ''}: ${err.message}`);
      }
    });
  } catch (err) {
    logger.debug(`[health] sweep failed: ${err.message}`);
  }
}

/** Poller process only. First snapshot 60 s after boot, then every 15 min or when a refresh is requested. */
function startSweep() {
  if (timer || first) return;
  first = setTimeout(() => {
    first = null;
    sweepTick();
    timer = setInterval(sweepTick, SWEEP_TICK_MS);
    if (timer.unref) timer.unref();
  }, SWEEP_FIRST_MS);
  if (first.unref) first.unref();
}

function stopSweep() {
  if (first) { clearTimeout(first); first = null; }
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  recordPollRun, pruneRuns, processSample, memSample, logSummary, dbCounters, pollingStats,
  readLoopLagP99Ms, webLoopLagP99Ms, dbSnapshot, readSnapshot, storeSnapshot, fileBytes,
  startSweep, stopSweep, sweepTick,
  SNAPSHOT_KEY, REFRESH_KEY, INLINE_MAX_BYTES,
};
