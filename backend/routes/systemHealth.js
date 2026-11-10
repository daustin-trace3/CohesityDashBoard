// System Health (Global Settings > System Health): both processes, the database
// file, poll durations per source, request latency per route, versions and
// migrations, plus one export the box agent can hand over. Mounted at
// /api/system/health in app.js; each route gates itself.
const os = require('os');
const path = require('path');
const express = require('express');
const db = require('../db/database');
const registry = require('../core/registry');
const pollerStatusRoute = require('./poller');
const requestStats = require('../services/requestStats');
const systemHealth = require('../services/systemHealth');
const { readHeartbeat } = require('../services/workerHeartbeat');
const { getSetting, setSetting } = require('../services/settings');
const { memoByTtl } = require('../core/dbMemo');
const { requirePermission } = require('../middleware/requirePermission');

const router = express.Router();

const MEMO_MS = 30000;
const REQUEST_CAP = 100;
const WAL_WARN_BYTES = 64 * 1048576;
const DB_LARGE_BYTES = 2 * 1024 * 1024 * 1024;

function parseJson(raw) {
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

// --- blocks -------------------------------------------------------------------

function tenantId() {
  return null; // single-tenant build
}

function appInfo() {
  let version = null;
  try { version = require(path.join(__dirname, '..', '..', 'package.json')).version; } catch { /* packaged tree without it */ }
  let sqliteVersion = null;
  try { sqliteVersion = db.prepare('select sqlite_version() v').get().v; } catch { /* unreadable */ }
  let betterSqlite3Version = null;
  try { betterSqlite3Version = require('better-sqlite3/package.json').version; } catch { /* not resolvable */ }
  return {
    version, nodeVersion: process.version, sqliteVersion, betterSqlite3Version,
    platform: process.platform, arch: process.arch, hostname: os.hostname(),
    demo: process.env.DASHBOARD_DEMO === '1', tenantId: tenantId(),
    pm2: { web: process.env.pm_id ?? null },
  };
}

function webProcess() {
  return {
    pid: process.pid,
    startedAt: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    mem: systemHealth.memSample(),
    loopLagP99Ms: systemHealth.webLoopLagP99Ms(),
    log: systemHealth.logSummary(),
    db: systemHealth.dbCounters(),
  };
}

function databaseBlock() {
  const file = db.name;
  const fileBytes = systemHealth.fileBytes(file);
  let snapshot = systemHealth.readSnapshot();
  // A fresh install or the demo has no poller sweep result yet; a small file is
  // cheap enough to measure here so the page is never empty there.
  if (!snapshot && fileBytes < systemHealth.INLINE_MAX_BYTES) {
    try { snapshot = systemHealth.dbSnapshot(db, file); systemHealth.storeSnapshot(snapshot); } catch { snapshot = null; }
  }
  return {
    path: file, fileBytes, walBytes: systemHealth.fileBytes(`${file}-wal`),
    lastCheckpoint: parseJson(getSetting('icc_wal_checkpoint_last')),
    snapshot,
    snapshotAgeSeconds: snapshot ? Math.max(0, Math.round((Date.now() - Date.parse(snapshot.at)) / 1000)) : null,
    refreshPending: !!getSetting(systemHealth.REFRESH_KEY),
  };
}

function buildPolling() {
  const now = Date.now();
  const sinceIso = new Date(now - 86400000).toISOString();

  // Entity facts (names, intervals, stale flags) come from the poller status route's own builder.
  let status = {};
  try { status = pollerStatusRoute.buildStatus() || {}; } catch { status = {}; }
  const entities = new Map();
  const sections = {};
  for (const [platform, sec] of Object.entries(status)) {
    if (!sec || sec.via) continue;
    sections[platform] = sec;
    for (const e of sec.entities || []) entities.set(`${platform}:${e.id}`, e);
  }

  let agg = [];
  let latest = [];
  let longestRow = null;
  try {
    agg = db.prepare(`
      SELECT platform, source_id, COUNT(*) AS runs, SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS failures,
             AVG(duration_ms) AS avg_ms, MAX(duration_ms) AS max_ms
      FROM icc_poll_runs WHERE started_at >= ? GROUP BY platform, source_id
    `).all(sinceIso);
    latest = db.prepare('SELECT * FROM icc_poll_runs WHERE id IN (SELECT MAX(id) FROM icc_poll_runs GROUP BY platform, source_id)').all();
    longestRow = db.prepare('SELECT platform, source_name, duration_ms, started_at FROM icc_poll_runs WHERE started_at >= ? ORDER BY duration_ms DESC LIMIT 1').get(sinceIso) || null;
  } catch { /* table missing on a database that has not migrated yet */ }

  const aggBy = new Map(agg.map((a) => [`${a.platform}:${a.source_id}`, a]));
  const latestBy = new Map(latest.map((l) => [`${l.platform}:${l.source_id}`, l]));
  const keys = new Set(entities.keys());
  for (const [k, l] of latestBy) if (l.started_at >= sinceIso || entities.has(k)) keys.add(k);

  const seriesStmt = (() => { try { return db.prepare('SELECT duration_ms FROM icc_poll_runs WHERE platform = ? AND source_id = ? ORDER BY started_at DESC LIMIT 20'); } catch { return null; } })();

  const sources = [];
  for (const key of keys) {
    const [platform, idText] = [key.slice(0, key.lastIndexOf(':')), key.slice(key.lastIndexOf(':') + 1)];
    const sourceId = Number(idText);
    const run = latestBy.get(key) || null;
    const a = aggBy.get(key) || null;
    const entity = entities.get(key) || null;
    const section = sections[platform] || null;
    // Global tasks (licensing, views, zerto) have a section but no entity list.
    const sectionLevel = !entity && section && !(section.entities && section.entities.length) ? section : null;
    let series = [];
    if (seriesStmt) { try { series = seriesStmt.all(platform, sourceId).map((r) => r.duration_ms).reverse(); } catch { series = []; } }
    sources.push({
      platform, sourceId,
      sourceName: (entity && entity.name) || (run && run.source_name) || platform,
      kind: run ? run.kind : 'poll',
      lastStatus: run ? run.status : (entity && entity.lastPollStatus) || null,
      lastError: (run && run.error) || (entity && entity.lastPollError) || null,
      lastStartedAt: run ? run.started_at : null,
      lastDurationMs: run ? run.duration_ms : null,
      avgDurationMs: a ? Math.round(a.avg_ms) : null,
      maxDurationMs: a ? a.max_ms : null,
      runs24h: a ? a.runs : 0,
      failures24h: a ? a.failures : 0,
      series,
      intervalMinutes: entity ? entity.intervalMinutes : null,
      isStale: !!((entity && entity.isStale) || (sectionLevel && sectionLevel.isStale)),
      staleAfterMinutes: (entity && entity.staleAfterMinutes) || (sectionLevel && sectionLevel.staleAfterMinutes) || null,
    });
  }

  const rank = (s) => (s.lastStatus === 'error' ? 0 : s.isStale ? 1 : 2);
  sources.sort((x, y) => rank(x) - rank(y) || (y.lastDurationMs || 0) - (x.lastDurationMs || 0));

  return {
    summary: {
      runs24h: sources.reduce((n, s) => n + s.runs24h, 0),
      failures24h: sources.reduce((n, s) => n + s.failures24h, 0),
      sources: sources.length,
      stale: sources.filter((s) => s.isStale).length,
      longest: longestRow ? { platform: longestRow.platform, sourceName: longestRow.source_name || longestRow.platform, durationMs: longestRow.duration_ms, startedAt: longestRow.started_at } : null,
    },
    sources,
  };
}

function buildMigrations() {
  try {
    return db.prepare('SELECT scope, MAX(version) AS version, MAX(applied_at) AS appliedAt FROM schema_migrations GROUP BY scope ORDER BY scope').all();
  } catch { return []; }
}

function platformsBlock() {
  let list = [];
  try { list = registry.listPlugins(); } catch { list = []; }
  const enabled = list.filter((p) => p.enabled && p.status === 'active').map((p) => p.id);
  try {
    if (registry.isBuiltinPresent('cohesity') && getSetting('platform_cohesity_enabled') !== '0' && !enabled.includes('cohesity')) enabled.push('cohesity');
  } catch { /* registry without the built-in set */ }
  enabled.sort();
  return {
    enabled,
    plugins: list.map((p) => ({ id: p.id, version: p.version, status: p.status, enabled: !!p.enabled })).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** Account counts. feat reads the global accounts database; a single-database build reads its own tables. */
function usersBlock() {
  try {
    return {
      count: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
      activeSessions: db.prepare('SELECT COUNT(*) AS c FROM auth_sessions WHERE expires_at > ?').get(new Date().toISOString()).c,
    };
  } catch { return { count: null, activeSessions: null }; }
}

function licenseBlock() {
  try {
    const s = require('../services/license').getLicenseStatus() || {};
    return { state: s.state || null, expiresAt: s.effectiveExpiry || s.trialEnds || null, customer: s.customer || null };
  } catch { return { state: null, expiresAt: null, customer: null }; }
}

// --- findings -----------------------------------------------------------------

function names(list, f, n = 3) {
  const out = list.slice(0, n).map(f).join(', ');
  return list.length > n ? `${out} and ${list.length - n} more` : out;
}

function buildFindings(p) {
  const out = [];
  const poller = p.processes.poller;
  if (!poller || !poller.alive) {
    out.push({
      id: 'poller-silent', severity: 'crit', tab: 'overview',
      text: poller ? `The poller process has not reported for ${Math.round(poller.ageSeconds / 60)} min (last pid ${poller.pid}). Nothing is polling.` : 'No poller heartbeat on record. The poller process is not running, or predates the heartbeat.',
    });
  }
  const walBytes = p.database.walBytes;
  if (walBytes > WAL_WARN_BYTES) {
    out.push({ id: 'wal-large', severity: 'warn', tab: 'database', text: `The write-ahead log is ${Math.round(walBytes / 1048576)} MB. Checkpoints may not be finishing.` });
  }
  if (poller && poller.mem && poller.mem.rssMb > 1024) {
    out.push({ id: 'poller-memory', severity: 'warn', tab: 'overview', text: `The poller process is using ${poller.mem.rssMb} MB of memory.` });
  }
  const lagging = [];
  if (p.processes.web.loopLagP99Ms > 200) lagging.push(`web ${p.processes.web.loopLagP99Ms} ms`);
  if (poller && poller.loopLagP99Ms > 200) lagging.push(`poller ${poller.loopLagP99Ms} ms`);
  if (lagging.length) out.push({ id: 'loop-lag', severity: 'warn', tab: 'overview', text: `Event loop delay p99 is high: ${lagging.join(', ')}.` });

  const stale = p.polling.sources.filter((s) => s.isStale);
  if (stale.length) {
    out.push({ id: 'sources-stale', severity: 'warn', tab: 'polling', text: `${stale.length} source${stale.length === 1 ? ' is' : 's are'} stale: ${names(stale, (s) => `${s.platform} ${s.sourceName}`)}.` });
  }
  const slow = p.requests.routes.filter((r) => r.p95 > 1500);
  if (slow.length) {
    out.push({ id: 'slow-routes', severity: 'warn', tab: 'requests', text: `${slow.length} route${slow.length === 1 ? ' has' : 's have'} a p95 over 1.5 s: ${names(slow, (r) => `${r.route} (${Math.round(r.p95)} ms)`)}.` });
  }
  const slowTx = (p.processes.web.db.slowTransactions || 0) + ((poller && poller.db && poller.db.slowTransactions) || 0);
  if (slowTx > 0) out.push({ id: 'slow-transactions', severity: 'info', tab: 'database', text: `${slowTx} database transaction${slowTx === 1 ? '' : 's'} ran over 2 s since the processes started.` });
  const errs = p.processes.web.log.error + ((poller && poller.log && poller.log.error) || 0);
  if (errs > 0) out.push({ id: 'log-errors', severity: 'info', tab: 'overview', text: `${errs} error line${errs === 1 ? '' : 's'} logged since the processes started (web ${p.processes.web.log.error}, poller ${(poller && poller.log && poller.log.error) || 0}).` });
  if (p.database.snapshotAgeSeconds != null && p.database.snapshotAgeSeconds > 3600) {
    out.push({ id: 'snapshot-stale', severity: 'info', tab: 'database', text: `The table size snapshot is ${Math.round(p.database.snapshotAgeSeconds / 3600)} h old.` });
  }
  if (p.database.fileBytes > DB_LARGE_BYTES) {
    out.push({ id: 'db-large', severity: 'info', tab: 'database', text: `The database file is ${(p.database.fileBytes / 1073741824).toFixed(1)} GB. Consider the retention windows.` });
  }
  return out;
}

// --- payload ------------------------------------------------------------------

function buildPayload({ full = false } = {}) {
  const polling = memoByTtl(db, 'system-health:polling', MEMO_MS, buildPolling);
  const migrations = memoByTtl(db, 'system-health:migrations', MEMO_MS, buildMigrations);
  const snap = requestStats.snapshot();
  const routes = snap.routes.sort((a, b) => b.p95 - a.p95 || b.count - a.count);
  const payload = {
    generatedAt: new Date().toISOString(),
    app: appInfo(),
    processes: { web: webProcess(), poller: readHeartbeat() },
    database: databaseBlock(),
    polling,
    requests: { since: snap.since, total: snap.total, routes: full ? routes : routes.slice(0, REQUEST_CAP) },
    migrations,
    platforms: platformsBlock(),
    users: usersBlock(),
    license: licenseBlock(),
  };
  payload.findings = buildFindings(payload);
  return payload;
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

// --- routes -------------------------------------------------------------------

router.get('/', requirePermission(() => 'admin:settings:view'), (req, res, next) => {
  try { res.json(buildPayload()); } catch (err) { next(err); }
});

router.get('/export.json', requirePermission(() => 'admin:settings:view'), (req, res, next) => {
  try {
    const payload = buildPayload({ full: true });
    let pollRuns = [];
    try { pollRuns = db.prepare('SELECT * FROM icc_poll_runs ORDER BY id DESC LIMIT 500').all(); } catch { pollRuns = []; }
    payload.pollRuns = pollRuns;
    res.set('Cache-Control', 'no-store');
    res.set('Content-Disposition', `attachment; filename="icc-health-${payload.app.hostname}-${stamp()}.json"`);
    res.type('application/json').send(JSON.stringify(payload, null, 2));
  } catch (err) { next(err); }
});

router.post('/db-refresh', requirePermission(() => 'admin:settings:manage'), (req, res, next) => {
  try {
    const file = db.name;
    if (systemHealth.fileBytes(file) < systemHealth.INLINE_MAX_BYTES) {
      const snapshot = systemHealth.dbSnapshot(db, file);
      systemHealth.storeSnapshot(snapshot);
      setSetting(systemHealth.REFRESH_KEY, '');
      return res.json({ requested: false, computedNow: true, snapshot });
    }
    setSetting(systemHealth.REFRESH_KEY, new Date().toISOString());
    res.json({ requested: true, computedNow: false });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.buildPayload = buildPayload;
module.exports.buildFindings = buildFindings;
