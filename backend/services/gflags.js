const cron = require('node-cron');
const db = require('../db/database');
const { fetchGflags } = require('./cohesityApi');
const pollerStatus = require('./pollerStatus');
const logger = require('../utils/logger');

const POLLER_TYPE = 'cohesity-gflags';

// The private v1 gflag endpoint has been seen returning either a bare array of
// service groups or an object wrapping one — normalize both into flat rows.
function normalizeGflagResponse(data) {
  const groups = Array.isArray(data)
    ? data
    : (data && (data.servicesVec || data.serviceVec || data.gflags)) || [];
  const rows = [];
  for (const group of groups) {
    const serviceName = group.serviceName || group.service || 'unknown';
    for (const flag of group.gflags || group.gflagVec || []) {
      rows.push({
        serviceName,
        flagName: flag.name,
        flagValue: flag.value != null ? String(flag.value) : null,
        reason: flag.reason || null,
        sourceTimestamp: flag.timestamp != null ? Number(flag.timestamp) : null,
      });
    }
  }
  return rows;
}

const applyGflagState = db.transaction((clusterId, rows) => {
  const current = db.prepare(
    'SELECT service_name, flag_name, flag_value FROM cluster_gflags WHERE cluster_id = ?'
  ).all(clusterId);
  const hadPriorState = current.length > 0;
  const keyOf = (service, flag) => `${service}\x00${flag}`;
  const oldMap = new Map(current.map((r) => [keyOf(r.service_name, r.flag_name), r]));
  const newMap = new Map(rows.map((r) => [keyOf(r.serviceName, r.flagName), r]));

  const insertChange = db.prepare(`
    INSERT INTO gflag_changes
      (cluster_id, service_name, flag_name, old_value, new_value, change_type, source_reason, source_timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let changes = 0;
  for (const [key, row] of newMap) {
    if (!oldMap.has(key)) {
      // First-ever poll for a cluster seeds current state silently — everything
      // would otherwise show up as "added" the day the feature ships.
      if (hadPriorState) {
        insertChange.run(clusterId, row.serviceName, row.flagName, null, row.flagValue,
          'added', row.reason, row.sourceTimestamp);
        changes++;
      }
    } else if (oldMap.get(key).flag_value !== row.flagValue) {
      insertChange.run(clusterId, row.serviceName, row.flagName, oldMap.get(key).flag_value, row.flagValue,
        'modified', row.reason, row.sourceTimestamp);
      changes++;
    }
  }
  for (const [key, old] of oldMap) {
    if (!newMap.has(key)) {
      insertChange.run(clusterId, old.service_name, old.flag_name, old.flag_value, null, 'removed', null, null);
      changes++;
    }
  }

  db.prepare('DELETE FROM cluster_gflags WHERE cluster_id = ?').run(clusterId);
  const insertState = db.prepare(`
    INSERT INTO cluster_gflags (cluster_id, service_name, flag_name, flag_value, reason, source_timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insertState.run(clusterId, row.serviceName, row.flagName, row.flagValue, row.reason, row.sourceTimestamp);
  }
  return changes;
});

async function refreshGflags(cluster) {
  pollerStatus.markStart(POLLER_TYPE, cluster.id);
  try {
    const data = await fetchGflags(cluster);
    const rows = normalizeGflagResponse(data);
    const changes = applyGflagState(cluster.id, rows);
    pollerStatus.markEnd(POLLER_TYPE, cluster.id, 'success');
    if (changes > 0) {
      logger.info(`[Gflags] Cluster ${cluster.name}: ${changes} gflag change(s) detected`);
    }
    return { flags: rows.length, changes };
  } catch (err) {
    pollerStatus.markEnd(POLLER_TYPE, cluster.id, 'error');
    throw err;
  }
}

// Works for direct connections AND Helios-connected clusters — Helios proxies
// the private v1 gflag endpoint via the accessClusterId header (verified live
// 2026-07-22 against asx1bkagcl-az).
function gflagClusters() {
  return db.prepare('SELECT * FROM clusters').all();
}

async function refreshAllGflags() {
  const results = [];
  for (const cluster of gflagClusters()) {
    try {
      results.push({ clusterId: cluster.id, name: cluster.name, ...(await refreshGflags(cluster)) });
    } catch (err) {
      logger.error(`[Gflags] Refresh failed for cluster ${cluster.name}:`, err.message);
      results.push({ clusterId: cluster.id, name: cluster.name, error: err.message });
    }
  }
  return results;
}

function getGflags() {
  const rows = db.prepare(`
    SELECT g.cluster_id AS clusterId, c.name AS clusterName, g.service_name AS serviceName,
           g.flag_name AS flagName, g.flag_value AS flagValue, g.reason,
           g.source_timestamp AS sourceTimestamp, g.captured_at AS capturedAt
    FROM cluster_gflags g JOIN clusters c ON c.id = g.cluster_id
    ORDER BY c.name, g.service_name, g.flag_name
  `).all();
  const clusters = gflagClusters().map((c) => ({
    id: c.id,
    name: c.name,
    status: pollerStatus.getState(POLLER_TYPE, c.id),
  }));
  return { clusters, gflags: rows };
}

function getGflagChanges({ clusterId, flag, days } = {}) {
  const where = [];
  const params = [];
  if (clusterId) { where.push('h.cluster_id = ?'); params.push(clusterId); }
  if (flag) { where.push('h.flag_name = ?'); params.push(flag); }
  if (days) { where.push("h.detected_at >= datetime('now', ?)"); params.push(`-${Number(days)} days`); }
  const rows = db.prepare(`
    SELECT h.id, h.cluster_id AS clusterId, c.name AS clusterName, h.service_name AS serviceName,
           h.flag_name AS flagName, h.old_value AS oldValue, h.new_value AS newValue,
           h.change_type AS changeType, h.source_reason AS sourceReason,
           h.source_timestamp AS sourceTimestamp, h.detected_at AS detectedAt
    FROM gflag_changes h JOIN clusters c ON c.id = h.cluster_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY h.detected_at DESC, h.id DESC
    LIMIT 5000
  `).all(...params);
  return rows;
}

function initGflags() {
  // Deliberately daily, not the regular poll cadence — gflags rarely change and
  // the panel has a manual refresh for support-case moments.
  cron.schedule('30 3 * * *', () => {
    refreshAllGflags().catch((err) => logger.error('[Gflags] Daily refresh failed:', err.message));
  });
  const unseeded = gflagClusters().filter(
    (c) => !db.prepare('SELECT 1 FROM cluster_gflags WHERE cluster_id = ? LIMIT 1').get(c.id)
  );
  if (unseeded.length > 0) {
    refreshAllGflags().catch((err) => logger.error('[Gflags] Initial refresh failed:', err.message));
  }
  logger.info(`[Gflags] Daily gflag poll scheduled (${gflagClusters().length} cluster(s))`);
}

module.exports = { refreshGflags, refreshAllGflags, getGflags, getGflagChanges, initGflags };
