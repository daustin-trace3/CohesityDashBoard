const db = require('../db/database');
const { computeInsights, FAILURE_STATUSES } = require('./insights');
const logger = require('../utils/logger');

const SNAPSHOT_KEY = 'dashboard';

/**
 * Build the full dashboard payload the first paint needs, in one shot, from
 * the SQLite cache. This replaces the client-side per-cluster fan-out so the
 * dashboard renders the last poll instantly.
 */
function buildDashboardSnapshot() {
  const clusters = db.prepare(`
    SELECT id, name, connection_type, vip, polling_interval_minutes, tags
    FROM clusters ORDER BY name
  `).all();

  // 7-day metrics history per cluster (sparklines + latest + initial trend).
  const historyRows = db.prepare(`
    SELECT cluster_id,
           strftime('%Y-%m-%dT%H:%M:%SZ', captured_at) AS captured_at,
           total_capacity_bytes, used_bytes, logical_bytes,
           data_reduction_ratio, software_version, node_count
    FROM metrics_history
    WHERE captured_at >= datetime('now', '-7 days')
    ORDER BY cluster_id, captured_at ASC
  `).all();

  const metricsHistory = {};
  for (const r of historyRows) {
    if (!metricsHistory[r.cluster_id]) metricsHistory[r.cluster_id] = [];
    metricsHistory[r.cluster_id].push(r);
  }

  // Per-cluster active alert summary (replaces ClusterCard's per-card fetch).
  const alertRows = db.prepare(`
    SELECT cluster_id,
           COUNT(*) AS count,
           SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS criticals,
           SUM(CASE WHEN severity = 'warning' THEN 1 ELSE 0 END) AS warnings
    FROM alerts WHERE resolved = 0 AND dismissed = 0
    GROUP BY cluster_id
  `).all();

  const alertSummary = {};
  let activeAlertCount = 0;
  let criticalAlertCount = 0;
  for (const r of alertRows) {
    const level = r.criticals > 0 ? 'critical' : r.warnings > 0 ? 'warning' : r.count > 0 ? 'info' : 'none';
    alertSummary[r.cluster_id] = { count: r.count, level };
    activeAlertCount += r.count;
    criticalAlertCount += r.criticals;
  }

  // Recent critical alerts (Dashboard "Recent Critical Alerts" panel).
  const recentCriticalAlerts = db.prepare(`
    SELECT a.*, c.name AS cluster_name
    FROM alerts a JOIN clusters c ON a.cluster_id = c.id
    WHERE a.resolved = 0 AND a.dismissed = 0 AND a.severity = 'critical'
    ORDER BY a.last_updated DESC LIMIT 10
  `).all();

  // 7-day protection success summary (KPI strip).
  const failurePlaceholders = FAILURE_STATUSES.map(() => '?').join(',');
  const ps = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = 'kSuccess' THEN 1 ELSE 0 END) AS success,
           SUM(CASE WHEN status IN (${failurePlaceholders}) THEN 1 ELSE 0 END) AS failure,
           SUM(CASE WHEN status = 'kWarning' THEN 1 ELSE 0 END) AS warning
    FROM protection_runs
    WHERE start_time >= datetime('now', '-7 days')
  `).get(...FAILURE_STATUSES);

  const total = ps.total || 0;
  const failure = ps.failure || 0;
  const protectionSummary = {
    total,
    success: ps.success || 0,
    failure,
    warning: ps.warning || 0,
    successRate: total > 0 ? Math.round(((total - failure) / total) * 1000) / 10 : 0,
  };

  return {
    generatedAt: new Date().toISOString(),
    clusters,
    metricsHistory,
    alertSummary,
    activeAlertCount,
    criticalAlertCount,
    recentCriticalAlerts,
    protectionSummary,
    insights: computeInsights(),
  };
}

/** Build the snapshot and persist it to the cache table. */
function refreshDashboardSnapshot() {
  try {
    const payload = buildDashboardSnapshot();
    db.prepare(`
      INSERT INTO snapshot_cache (cache_key, payload_json, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(cache_key) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(SNAPSHOT_KEY, JSON.stringify(payload));
    return payload;
  } catch (err) {
    logger.error('[Snapshot] Failed to rebuild dashboard snapshot:', err.message);
    return null;
  }
}

/** Return the cached snapshot, building it on demand if absent. */
function getDashboardSnapshot() {
  const row = db.prepare(
    "SELECT payload_json, strftime('%Y-%m-%dT%H:%M:%SZ', updated_at) AS cachedAt FROM snapshot_cache WHERE cache_key = ?"
  ).get(SNAPSHOT_KEY);
  if (row) {
    const payload = JSON.parse(row.payload_json);
    payload.cachedAt = row.cachedAt;
    return payload;
  }
  return refreshDashboardSnapshot();
}

// Coalesce bursts of poll completions (clusters sharing a cron minute) into a
// single rebuild a few seconds after the last one finishes.
let refreshTimer = null;
function scheduleSnapshotRefresh(delayMs = 5000) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshDashboardSnapshot();
  }, delayMs);
  if (refreshTimer.unref) refreshTimer.unref();
}

module.exports = {
  buildDashboardSnapshot,
  refreshDashboardSnapshot,
  getDashboardSnapshot,
  scheduleSnapshotRefresh,
};
