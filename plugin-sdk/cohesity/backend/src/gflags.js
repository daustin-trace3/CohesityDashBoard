// Cohesity gflag audit, ported from backend/services/gflags.js. db/logger via
// coreApi; fetchGflags via ./api (this pack's cohesityApi.js port). node-cron
// replaced by a self-scheduled setInterval from initExtras(coreApi) — see
// licensing.js header for why (daily, not pinned to 03:30 wall-clock).
const api = require('./api');

const POLLER_TYPE = 'cohesity-gflags';

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

function applyGflagState(coreApi, clusterId, rows) {
  const db = coreApi.db;
  const tx = db.transaction((clusterId, rows) => {
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
  return tx(clusterId, rows);
}

async function refreshGflags(cluster, coreApi) {
  coreApi.pollerStatus.markStart(POLLER_TYPE, cluster.id);
  try {
    const data = await api.fetchGflags(cluster, coreApi);
    const rows = normalizeGflagResponse(data);
    const changes = applyGflagState(coreApi, cluster.id, rows);
    coreApi.pollerStatus.markEnd(POLLER_TYPE, cluster.id, 'success');
    if (changes > 0) {
      coreApi.logger.info(`[Gflags] Cluster ${cluster.name}: ${changes} gflag change(s) detected`);
    }
    return { flags: rows.length, changes };
  } catch (err) {
    coreApi.pollerStatus.markEnd(POLLER_TYPE, cluster.id, 'error');
    throw err;
  }
}

function gflagClusters(coreApi) {
  return coreApi.db.prepare('SELECT * FROM clusters').all();
}

async function refreshAllGflags(coreApi) {
  const results = [];
  for (const cluster of gflagClusters(coreApi)) {
    try {
      results.push({ clusterId: cluster.id, name: cluster.name, ...(await refreshGflags(cluster, coreApi)) });
    } catch (err) {
      coreApi.logger.error(`[Gflags] Refresh failed for cluster ${cluster.name}:`, err.message);
      results.push({ clusterId: cluster.id, name: cluster.name, error: err.message });
    }
  }
  return results;
}

function getGflags(coreApi) {
  const db = coreApi.db;
  const rows = db.prepare(`
    SELECT g.cluster_id AS clusterId, c.name AS clusterName, g.service_name AS serviceName,
           g.flag_name AS flagName, g.flag_value AS flagValue, g.reason,
           g.source_timestamp AS sourceTimestamp, g.captured_at AS capturedAt
    FROM cluster_gflags g JOIN clusters c ON c.id = g.cluster_id
    ORDER BY c.name, g.service_name, g.flag_name
  `).all();
  const clusters = gflagClusters(coreApi).map((c) => ({
    id: c.id,
    name: c.name,
    status: coreApi.pollerStatus.getState(POLLER_TYPE, c.id),
  }));
  return { clusters, gflags: rows };
}

function getGflagChanges(coreApi, { clusterId, flag, days } = {}) {
  const db = coreApi.db;
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

const DAY_MS = 24 * 60 * 60 * 1000;

/** Demo-inert: never scheduled under DASHBOARD_DEMO==='1'. */
function initGflags(coreApi) {
  if (process.env.DASHBOARD_DEMO === '1') return;
  setInterval(() => {
    refreshAllGflags(coreApi).catch((err) => coreApi.logger.error('[Gflags] Daily refresh failed:', err.message));
  }, DAY_MS);
  const unseeded = gflagClusters(coreApi).filter(
    (c) => !coreApi.db.prepare('SELECT 1 FROM cluster_gflags WHERE cluster_id = ? LIMIT 1').get(c.id)
  );
  if (unseeded.length > 0) {
    refreshAllGflags(coreApi).catch((err) => coreApi.logger.error('[Gflags] Initial refresh failed:', err.message));
  }
  coreApi.logger.info(`[Gflags] Daily gflag poll scheduled (${gflagClusters(coreApi).length} cluster(s))`);
}

module.exports = { refreshGflags, refreshAllGflags, getGflags, getGflagChanges, initGflags };
