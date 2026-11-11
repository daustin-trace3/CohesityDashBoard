// ICC reporting on ICC (Global Settings > System Health): poll run records, the
// per process sample the heartbeat carries, the database snapshot and the poller
// sweep that keeps it fresh. Everything that runs inside the poller or the
// heartbeat is wrapped so a failure here never reaches the work it measures.
const fs = require('fs');
const { monitorEventLoopDelay } = require('perf_hooks');
const { Worker } = require('worker_threads');
const logger = require('../utils/logger');

const SNAPSHOT_KEY = 'icc_health_db_snapshot';
const REFRESH_KEY = 'icc_health_db_refresh_requested';
const SWEEP_FIRST_MS = 10 * 60000;
const SWEEP_TICK_MS = 30000;
const SNAPSHOT_EVERY_MS = 6 * 3600000;
const PRUNE_EVERY_MS = 60 * 60000;
/** A snapshot never starts while the data file's write-ahead log is larger than this. */
const SNAPSHOT_WAL_MAX_BYTES = 256 * 1024 * 1024;
const SNAPSHOT_SWITCH_KEY = 'icc_health_snapshot_enabled';
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

// The snapshot reads every page of the file (dbstat) and counts every row of
// every table. On a 4.8 GB database that took eight minutes and, run on the
// poller's thread, blocked every poll and the heartbeat for all of it (CG box,
// 2026-11-10). It therefore runs in a worker thread with its own read-only
// connection; the main thread only stores the result. The worker receives the
// function as source text because the compiled build cannot read a function's
// source at runtime, so the main-thread copy is built from the same text.
//
// It reads one b-tree per statement, never the whole file in one statement.
// A single "SELECT ... FROM dbstat GROUP BY name" is one read transaction that
// lasts as long as the walk, and while any reader holds a transaction SQLite
// cannot recycle the write-ahead log: on the 12.7 GB production file that walk
// ran for the better part of an hour and the -wal file grew past 6 GB
// (2026-11-11). One statement per table or index releases the read lock between
// b-trees, so the checkpoint task can reset the log in the gaps.
const SNAPSHOT_SRC = `function dbSnapshot(db, dbPath, fs) {
  const t0 = Date.now();
  const file = dbPath || db.name;
  const fileBytes = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
  const master = db.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('table', 'index')").all();
  const tableNames = new Set(master.filter((m) => m.type === 'table').map((m) => m.name));
  const indexOwner = new Map(master.filter((m) => m.type === 'index').map((m) => [m.name, m.tbl_name]));

  const bytes = new Map();
  const indexBytes = new Map();
  let dbstatError = null;
  // One short statement per b-tree. The aggregate form (SQLite 3.30+) sums the
  // pages inside dbstat; older builds fall back to SUM over the per-page rows.
  let sizeStmt = null;
  try {
    sizeStmt = db.prepare('SELECT pgsize AS bytes FROM dbstat WHERE name = ? AND aggregate = 1');
    sizeStmt.get('sqlite_master');
  } catch (err) {
    try { sizeStmt = db.prepare('SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name = ?'); } catch (err2) { sizeStmt = null; dbstatError = err2.message; }
  }
  if (sizeStmt) {
    try {
      const sizeOf = (name) => { const r = sizeStmt.get(name); return r && r.bytes ? Number(r.bytes) : 0; };
      for (const m of master) {
        if (m.type === 'table') bytes.set(m.name, (bytes.get(m.name) || 0) + sizeOf(m.name));
        else indexBytes.set(m.tbl_name, (indexBytes.get(m.tbl_name) || 0) + sizeOf(m.name));
      }
      const schemaBytes = sizeOf('sqlite_master') || sizeOf('sqlite_schema');
      if (schemaBytes) bytes.set('sqlite_master', schemaBytes);
    } catch (err) {
      dbstatError = err.message;
    }
  }
  if (bytes.has('sqlite_master')) tableNames.add('sqlite_master');

  const tables = [];
  for (const name of tableNames) {
    let rows = 0;
    try { rows = db.prepare('SELECT COUNT(*) AS c FROM "' + name.replace(/"/g, '""') + '"').get().c; } catch { rows = 0; }
    tables.push({ name, rows, bytes: bytes.get(name) || 0, indexBytes: indexBytes.get(name) || 0 });
  }
  tables.sort((a, b) => (b.bytes + b.indexBytes) - (a.bytes + a.indexBytes) || a.name.localeCompare(b.name));

  const pragma = (p) => db.pragma(p, { simple: true });
  const totals = tables.reduce((t, r) => ({ tables: t.tables + 1, rows: t.rows + r.rows, bytes: t.bytes + r.bytes, indexBytes: t.indexBytes + r.indexBytes }), { tables: 0, rows: 0, bytes: 0, indexBytes: 0 });
  return {
    at: new Date().toISOString(), path: file,
    fileBytes: fileBytes(file), walBytes: fileBytes(file + '-wal'),
    pageSize: pragma('page_size'), pageCount: pragma('page_count'), freelistPages: pragma('freelist_count'),
    journalMode: pragma('journal_mode'),
    tables, totals, computeMs: Date.now() - t0, dbstatError,
  };
}`;

// eslint-disable-next-line no-eval
const snapshotImpl = (0, eval)(`(${SNAPSHOT_SRC})`);

/** Path of the attached admin file (db/adminSplit.js), or null on a single-file handle. */
function adminFileOf(db) {
  try {
    const row = db.pragma('database_list').find((d) => d.name === 'admin');
    return row && row.file ? row.file : null;
  } catch { return null; }
}

function fileRow(role, s) {
  return { role, path: s.path, fileBytes: s.fileBytes, walBytes: s.walBytes, pageCount: s.pageCount, freelist: s.freelistPages };
}

/** One snapshot over both files: legacy top-level fields describe the data file,
 *  files[] lists both, every table row carries the file it lives in. */
function mergeSnapshots(data, admin) {
  const tag = (s, file) => s.tables.map((t) => ({ ...t, file }));
  const out = { ...data, tables: tag(data, 'data'), files: [fileRow('data', data)] };
  if (admin) {
    out.files.push(fileRow('admin', admin));
    out.tables = out.tables.concat(tag(admin, 'admin'))
      .sort((a, b) => (b.bytes + b.indexBytes) - (a.bytes + a.indexBytes) || a.name.localeCompare(b.name));
    out.totals = {
      tables: data.totals.tables + admin.totals.tables, rows: data.totals.rows + admin.totals.rows,
      bytes: data.totals.bytes + admin.totals.bytes, indexBytes: data.totals.indexBytes + admin.totals.indexBytes,
    };
    out.computeMs = data.computeMs + admin.computeMs;
  }
  return out;
}

/** Main-thread snapshot (tests, and the inline path for small files). */
function dbSnapshot(db, dbPath) {
  const data = snapshotImpl(db, dbPath, fs);
  if (data.dbstatError) logger.debug(`[health] dbstat unavailable: ${data.dbstatError}`);
  const adminFile = adminFileOf(db);
  let admin = null;
  if (adminFile && db.adminHandle) {
    try { admin = snapshotImpl(db.adminHandle, adminFile, fs); } catch (err) { logger.debug(`[health] admin snapshot failed: ${err.message}`); }
  }
  return mergeSnapshots(data, admin);
}

const WORKER_SRC = `
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const Database = require(workerData.sqlitePath);
const snapshot = (${SNAPSHOT_SRC});
let db = null;
try {
  db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 15000');
  parentPort.postMessage({ ok: true, snap: snapshot(db, workerData.dbPath, fs) });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String((err && err.message) || err) });
} finally {
  try { if (db) db.close(); } catch {}
}
`;

/** Snapshot the database file on a worker thread; resolves with the snapshot. */
function snapshotInWorker(dbPath) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(WORKER_SRC, { eval: true, workerData: { dbPath, sqlitePath: require.resolve('better-sqlite3') } });
    } catch (err) { reject(err); return; }
    let done = false;
    worker.once('message', (m) => { done = true; if (m && m.ok) resolve(m.snap); else reject(new Error((m && m.error) || 'snapshot failed')); });
    worker.once('error', (err) => { if (!done) { done = true; reject(err); } });
    worker.once('exit', (code) => { if (!done) { done = true; reject(new Error(`snapshot worker exited with code ${code}`)); } });
  });
}

/** Snapshot one file: worker thread for a real file, inline for an in-memory one. */
async function snapshotFile(handle, file) {
  if (!file || file === ':memory:' || !fs.existsSync(file)) return snapshotImpl(handle, file, fs);
  try {
    const snap = await snapshotInWorker(file);
    if (snap.dbstatError) logger.debug(`[health] dbstat unavailable: ${snap.dbstatError}`);
    return snap;
  } catch (err) {
    if (fileBytes(file) < INLINE_MAX_BYTES) {
      logger.debug(`[health] snapshot worker failed (${err.message}); computing inline`);
      return snapshotImpl(handle, file, fs);
    }
    throw err;
  }
}

/** Snapshot the data file and, when one is attached, the admin file. */
async function snapshotDb(db, file) {
  const data = await snapshotFile(db, file);
  const adminFile = adminFileOf(db);
  let admin = null;
  if (adminFile) {
    try { admin = await snapshotFile(db.adminHandle || db, adminFile); } catch (err) { logger.debug(`[health] admin snapshot failed: ${err.message}`); }
  }
  return mergeSnapshots(data, admin);
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
const inflight = new Map();
let lastPruneAt = 0;
const deferredLogAt = new Map();

/** Why a snapshot of this database must not start now, or null when it may.
 *  Even one statement per b-tree pins the log for the largest table, so a
 *  snapshot waits for a quiet moment: no poll in flight, a small write-ahead
 *  log, and the switch on (setting icc_health_snapshot_enabled, or the
 *  environment variable ICC_HEALTH_SNAPSHOT=0 for a box with no UI access). */
function snapshotHold(db, opts = {}) {
  const { getSetting } = require('./settings');
  if (process.env.ICC_HEALTH_SNAPSHOT === '0') return 'switched off by ICC_HEALTH_SNAPSHOT=0';
  try { if (String(getSetting(SNAPSHOT_SWITCH_KEY) || '') === '0') return `switched off (${SNAPSHOT_SWITCH_KEY})`; } catch { /* no settings table yet */ }
  const polling = opts.polling || pollingStats();
  if (polling.active > 0) return `${polling.active} poll${polling.active === 1 ? '' : 's'} in flight`;
  const walMax = opts.walMaxBytes != null ? opts.walMaxBytes : SNAPSHOT_WAL_MAX_BYTES;
  const file = db && db.name;
  if (file && file !== ':memory:') {
    const wal = fileBytes(`${file}-wal`);
    if (wal > walMax) return `write-ahead log is ${mb(wal)} MB`;
  }
  return null;
}

function snapshotFor(db, key, requested, tenantId) {
  const { setSetting } = require('./settings');
  const file = db.name;
  const job = (async () => {
    const snap = await snapshotDb(db, file);
    storeSnapshot(snap);
    if (requested) setSetting(REFRESH_KEY, '');
    logger.debug(`[health] db snapshot ${tenantId || ''}: ${snap.totals.tables} tables, ${mb(snap.fileBytes)} MB, ${snap.computeMs} ms`);
  })().catch((err) => {
    logger.warn(`[health] db snapshot failed${tenantId ? ` for tenant ${tenantId}` : ''}: ${err.message}`);
  }).finally(() => { inflight.delete(key); });
  inflight.set(key, job);
  return job;
}

/** One tick: start a snapshot where one is due or requested (never two for the same database), prune old runs. Resolves when the started snapshots are stored. */
function sweepTick() {
  const { getSetting } = require('./settings');
  const now = Date.now();
  const prune = now - lastPruneAt >= PRUNE_EVERY_MS;
  if (prune) lastPruneAt = now;
  const jobs = [];
  try {
    eachDb((db, tenantId) => {
      const key = tenantId || 'single';
      try {
        const requested = !!getSetting(REFRESH_KEY);
        if ((requested || now - (lastSnapshotAt.get(key) || 0) >= SNAPSHOT_EVERY_MS) && !inflight.has(key)) {
          const hold = snapshotHold(db);
          if (hold) {
            // Try again next tick; say so once an hour per database.
            if (now - (deferredLogAt.get(key) || 0) >= 3600000) {
              deferredLogAt.set(key, now);
              logger.info(`[health] db snapshot${tenantId ? ` for tenant ${tenantId}` : ''} deferred: ${hold}`);
            }
            return;
          }
          lastSnapshotAt.set(key, now);
          jobs.push(snapshotFor(db, key, requested, tenantId));
        }
        if (prune) pruneRuns(db, now);
      } catch (err) {
        logger.debug(`[health] sweep failed${tenantId ? ` for tenant ${tenantId}` : ''}: ${err.message}`);
      }
    });
  } catch (err) {
    logger.debug(`[health] sweep failed: ${err.message}`);
  }
  return Promise.all(jobs).then(() => undefined);
}

/** Poller process only. First snapshot 10 min after boot, then every 6 h or when a refresh is requested. */
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
  readLoopLagP99Ms, webLoopLagP99Ms, dbSnapshot, adminFileOf, readSnapshot, storeSnapshot, fileBytes,
  startSweep, stopSweep, sweepTick, snapshotHold,
  SNAPSHOT_KEY, REFRESH_KEY, INLINE_MAX_BYTES, SNAPSHOT_WAL_MAX_BYTES, SNAPSHOT_SWITCH_KEY,
};
