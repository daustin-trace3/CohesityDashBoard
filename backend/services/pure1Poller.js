const cron = require('node-cron');
const db = require('../db/database');
const pure1Api = require('./pure1Api');
const logger = require('../utils/logger');

// Pure1 cloud (SaaS) poller. The Pure1 API is fleet-wide and read-only, so
// unlike the per-array pollers there is a single global schedule. Each run
// captures a full fleet snapshot into pure1_arrays (latest state, upserted) and
// appends a capacity sample per array into pure1_capacity_history (deduped on
// the Pure1 datapoint timestamp) so long-term trending + the dashboard read
// from the DB instead of hitting Pure1 live on every request.

const HISTORY_RETENTION_DAYS = 400;

let globalTask = null;
let lastPoll = null; // { at, arrayCount, ok, error }

function num(v) {
  return v === undefined || v === null ? null : Number(v);
}

// Retention: prune Pure1 capacity history older than the retention window,
// daily at 02:30.
cron.schedule('30 2 * * *', () => {
  try {
    const cutoff = Date.now() - HISTORY_RETENTION_DAYS * 24 * 3600 * 1000;
    const r = db.prepare('DELETE FROM pure1_capacity_history WHERE captured_at_ms < ?').run(cutoff);
    if (r.changes > 0) logger.info(`[Pure1Poller] Pruned ${r.changes} old capacity-history row(s)`);
  } catch (err) {
    logger.error('[Pure1Poller] Failed to prune pure1_capacity_history:', err.message);
  }
});

const upsertArray = db.prepare(`
  INSERT INTO pure1_arrays
    (array_uuid, name, fqdn, model, os, version, total_bytes, used_bytes,
     volume_space, shared_space, snapshot_space, system_space, replication_space,
     data_reduction, tags_json, captured_at_ms, updated_at)
  VALUES (@array_uuid, @name, @fqdn, @model, @os, @version, @total_bytes, @used_bytes,
          @volume_space, @shared_space, @snapshot_space, @system_space, @replication_space,
          @data_reduction, @tags_json, @captured_at_ms, datetime('now'))
  ON CONFLICT(array_uuid) DO UPDATE SET
    name              = excluded.name,
    fqdn              = excluded.fqdn,
    model             = excluded.model,
    os                = excluded.os,
    version           = excluded.version,
    total_bytes       = excluded.total_bytes,
    used_bytes        = excluded.used_bytes,
    volume_space      = excluded.volume_space,
    shared_space      = excluded.shared_space,
    snapshot_space    = excluded.snapshot_space,
    system_space      = excluded.system_space,
    replication_space = excluded.replication_space,
    data_reduction    = excluded.data_reduction,
    tags_json         = excluded.tags_json,
    captured_at_ms    = excluded.captured_at_ms,
    updated_at        = datetime('now')
`);

// Append a capacity sample; ignore if we already have this exact datapoint
// (same array + Pure1 timestamp) so re-polls between daily datapoints don't
// duplicate history.
const insertHistory = db.prepare(`
  INSERT OR IGNORE INTO pure1_capacity_history
    (array_uuid, captured_at_ms, captured_at, total_bytes, used_bytes,
     volume_space, shared_space, snapshot_space, system_space, replication_space, data_reduction)
  VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?)
`);

const persistSnapshot = db.transaction((fleet) => {
  const keep = [];
  for (const a of fleet) {
    if (!a.id) continue;
    keep.push(a.id);
    upsertArray.run({
      array_uuid: a.id,
      name: a.name || null,
      fqdn: a.fqdn || null,
      model: a.model || null,
      os: a.os || null,
      version: a.version || null,
      total_bytes: num(a.total),
      used_bytes: num(a.used),
      volume_space: num(a.volumeSpace),
      shared_space: num(a.sharedSpace),
      snapshot_space: num(a.snapshotSpace),
      system_space: num(a.systemSpace),
      replication_space: num(a.replicationSpace),
      data_reduction: num(a.dataReduction),
      tags_json: JSON.stringify(a.tags || []),
      captured_at_ms: num(a.capturedAt),
    });
    // Only record history when Pure1 gave us a datapoint timestamp (else we
    // can't dedupe and would spam rows every poll).
    if (a.capturedAt) {
      insertHistory.run(
        a.id, a.capturedAt, num(a.total), num(a.used),
        num(a.volumeSpace), num(a.sharedSpace), num(a.snapshotSpace),
        num(a.systemSpace), num(a.replicationSpace), num(a.dataReduction)
      );
    }
  }
  // Drop arrays no longer present in the Pure1 fleet.
  if (keep.length > 0) {
    const placeholders = keep.map(() => '?').join(',');
    db.prepare(`DELETE FROM pure1_arrays WHERE array_uuid NOT IN (${placeholders})`).run(...keep);
  } else {
    db.prepare('DELETE FROM pure1_arrays').run();
  }
});

/** Capture a full Pure1 fleet snapshot and persist it. Returns the array count. */
async function pollFleet() {
  if (!pure1Api.isConfigured()) {
    logger.info('[Pure1Poller] Skipped — Pure1 not configured');
    return 0;
  }
  const fleet = await pure1Api.getFleetSnapshot();
  persistSnapshot(fleet);
  lastPoll = { at: Date.now(), arrayCount: fleet.length, ok: true, error: null };
  logger.info(`[Pure1Poller] Stored snapshot for ${fleet.length} array(s)`);
  return fleet.length;
}

/** (Re)schedule the single global fleet poll at the configured interval. */
function reschedule() {
  if (globalTask) { globalTask.stop(); globalTask = null; }
  if (!pure1Api.isConfigured()) {
    logger.info('[Pure1Poller] Not configured — poller idle');
    return;
  }
  const min = pure1Api.getPollIntervalMin();
  globalTask = cron.schedule(`*/${min} * * * *`, () => {
    pollFleet().catch((err) => {
      lastPoll = { at: Date.now(), arrayCount: 0, ok: false, error: err.message };
      logger.error('[Pure1Poller] Scheduled poll failed:', err.message);
    });
  });
  logger.info(`[Pure1Poller] Scheduled fleet poll every ${min} min`);
}

function initPure1Poller() {
  if (!pure1Api.isConfigured()) {
    logger.info('[Pure1Poller] Pure1 not configured — poller idle');
    return;
  }
  reschedule();
  // Kick off an initial snapshot shortly after startup (non-blocking).
  setTimeout(() => {
    pollFleet().catch((err) => {
      lastPoll = { at: Date.now(), arrayCount: 0, ok: false, error: err.message };
      logger.error('[Pure1Poller] Initial poll failed:', err.message);
    });
  }, 6000);
}

function getLastPoll() {
  return lastPoll;
}

// ── DB-backed reads (used by routes to serve stored data) ────────────────────

/** True once at least one array snapshot has been persisted. */
function hasStoredData() {
  try {
    return db.prepare('SELECT 1 FROM pure1_arrays LIMIT 1').get() != null;
  } catch {
    return false;
  }
}

/** Rebuild the overview row shape from the stored snapshot. */
function getStoredOverview() {
  const rows = db.prepare('SELECT * FROM pure1_arrays').all();
  return rows.map((r) => {
    const total = r.total_bytes || 0;
    const used = r.used_bytes || 0;
    let tags = [];
    try { tags = JSON.parse(r.tags_json || '[]'); } catch { tags = []; }
    return {
      id: r.array_uuid,
      name: r.name,
      fqdn: r.fqdn,
      model: r.model,
      os: r.os,
      version: r.version,
      total,
      used,
      pctUsed: total > 0 ? (used / total) * 100 : null,
      dataReduction: r.data_reduction || null,
      effectiveUsed: r.data_reduction ? used * r.data_reduction : null,
      volumeSpace: r.volume_space || 0,
      snapshotSpace: r.snapshot_space || 0,
      sharedSpace: r.shared_space || 0,
      capturedAt: r.captured_at_ms || null,
      tags,
    };
  }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/**
 * Stored capacity history for one array in the metric-series shape the frontend
 * expects: { start, end, resolution, series: { <metric>: [[ts, value], ...] } }.
 * Returns null when there aren't at least 2 stored points (caller falls back to
 * live Pure1 so early on, before history accrues, charts still work).
 */
function getStoredCapacityHistory(arrayUuid, days = 30) {
  const end = Date.now();
  const start = end - days * 24 * 3600 * 1000;
  const rows = db.prepare(
    `SELECT * FROM pure1_capacity_history
       WHERE array_uuid = ? AND captured_at_ms >= ?
       ORDER BY captured_at_ms ASC`
  ).all(arrayUuid, start);
  if (rows.length < 2) return null;
  const series = {
    array_total_capacity: rows.map((r) => [r.captured_at_ms, r.total_bytes]),
    array_volume_space: rows.map((r) => [r.captured_at_ms, r.volume_space]),
    array_shared_space: rows.map((r) => [r.captured_at_ms, r.shared_space]),
    array_snapshot_space: rows.map((r) => [r.captured_at_ms, r.snapshot_space]),
    array_system_space: rows.map((r) => [r.captured_at_ms, r.system_space]),
    array_replication_space: rows.map((r) => [r.captured_at_ms, r.replication_space]),
    array_data_reduction: rows.map((r) => [r.captured_at_ms, r.data_reduction]),
  };
  return { start, end, resolution: 86400000, series };
}

module.exports = {
  initPure1Poller,
  reschedule,
  pollFleet,
  getLastPoll,
  hasStoredData,
  getStoredOverview,
  getStoredCapacityHistory,
};
