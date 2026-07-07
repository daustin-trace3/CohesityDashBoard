const cron = require('node-cron');
const db = require('../db/database');
const {
  fetchCluster, fetchNodes, fetchAggregates, fetchVolumes, fetchSvms,
  fetchDisks, fetchClusterMetrics, fetchHealthAlerts, fetchEmsAlerts,
} = require('./netappApi');
const logger = require('../utils/logger');

const scheduledTasks = new Map(); // arrayId -> cron task

// Retention: prune NetApp metrics older than 90 days, daily at 02:20.
cron.schedule('20 2 * * *', () => {
  try {
    const r = db.prepare("DELETE FROM netapp_metrics_history WHERE captured_at < datetime('now', '-90 days')").run();
    if (r.changes > 0) logger.info(`[NetAppPoller] Pruned ${r.changes} old metrics row(s)`);
  } catch (err) {
    logger.error('[NetAppPoller] Failed to prune netapp_metrics_history:', err.message);
  }
});

function num(v) {
  return v === undefined || v === null ? null : Number(v);
}

function safeErrorMessage(err) {
  if (err?.response) return `HTTP ${err.response.status} from cluster`;
  if (err?.code) return `Network error: ${err.code}`;
  return err?.message || 'Unknown error';
}

function upsertMetrics(array, totals, metrics, counts, version) {
  db.prepare(`
    INSERT INTO netapp_metrics_history
      (array_id, captured_at, total_bytes, used_bytes, available_bytes, physical_used_bytes,
       logical_used_bytes, efficiency_ratio, volume_count, aggregate_count,
       read_iops, write_iops, read_throughput_bytes, write_throughput_bytes,
       read_latency_us, write_latency_us, ontap_version)
    VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    array.id,
    num(totals.total), num(totals.used), num(totals.available), num(totals.physicalUsed),
    num(totals.logicalUsed), num(totals.ratio), num(counts.volumes), num(counts.aggregates),
    num(metrics?.iops?.read), num(metrics?.iops?.write),
    num(metrics?.throughput?.read), num(metrics?.throughput?.write),
    num(metrics?.latency?.read), num(metrics?.latency?.write),
    version || null
  );
}

const replaceAggregates = db.transaction((arrayId, items) => {
  db.prepare('DELETE FROM netapp_aggregates WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare(`
    INSERT INTO netapp_aggregates
      (array_id, uuid, name, node_name, state, size_bytes, used_bytes, available_bytes,
       used_percent, physical_used_bytes, efficiency_ratio)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const a of items) {
    const bs = (a.space && a.space.block_storage) || {};
    const eff = (a.space && a.space.efficiency) || {};
    stmt.run(arrayId, a.uuid || null, a.name || null, a.node?.name || null, a.state || null,
      num(bs.size), num(bs.used), num(bs.available), num(bs.used_percent), num(bs.physical_used), num(eff.ratio));
  }
});

const replaceVolumes = db.transaction((arrayId, items) => {
  db.prepare('DELETE FROM netapp_volumes WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare(`
    INSERT INTO netapp_volumes
      (array_id, uuid, name, svm_name, aggregate_name, state, size_bytes, used_bytes,
       available_bytes, used_percent, physical_used_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const v of items) {
    const s = v.space || {};
    stmt.run(arrayId, v.uuid || null, v.name || null, v.svm?.name || null,
      v.aggregates?.[0]?.name || null, v.state || null,
      num(s.size), num(s.used), num(s.available), num(s.percent_used), num(s.physical_used));
  }
});

const replaceSvms = db.transaction((arrayId, items) => {
  db.prepare('DELETE FROM netapp_svms WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare('INSERT INTO netapp_svms (array_id, uuid, name, state) VALUES (?, ?, ?, ?)');
  for (const s of items) stmt.run(arrayId, s.uuid || null, s.name || null, s.state || null);
});

const replaceNodes = db.transaction((arrayId, items) => {
  db.prepare('DELETE FROM netapp_nodes WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare(`
    INSERT INTO netapp_nodes (array_id, uuid, name, model, serial_number, state, version)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const n of items) {
    stmt.run(arrayId, n.uuid || null, n.name || null, n.model || null, n.serial_number || null,
      n.state || null, (n.version && n.version.full) || null);
  }
});

const replaceDisks = db.transaction((arrayId, items) => {
  db.prepare('DELETE FROM netapp_disks WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare(`
    INSERT INTO netapp_disks (array_id, name, model, vendor, type, state, size_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const d of items) {
    stmt.run(arrayId, d.name || null, d.model || null, d.vendor || null, d.type || null,
      d.state || null, num(d.usable_size));
  }
});

const replaceAlerts = db.transaction((arrayId, healthAlerts, emsAlerts) => {
  db.prepare('DELETE FROM netapp_alerts WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare(`
    INSERT INTO netapp_alerts (array_id, alert_key, severity, node_name, source, message)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const h of healthAlerts) {
    stmt.run(arrayId, String(h.alert_id ?? h.index ?? ''), (h.severity || 'unknown'),
      h.node || null, 'health', h.probable_cause || h.alerting_resource || h.monitor || null);
  }
  for (const e of emsAlerts) {
    stmt.run(arrayId, String(e.index ?? ''), (e.message?.severity || 'error'),
      e.node?.name || null, 'ems', e.message?.name || null);
  }
});

/** Poll a single NetApp cluster: capacity, performance, inventory, alerts. */
async function pollArray(array) {
  try {
    const [
      clusterR, nodesR, aggR, volR, svmR, diskR, metricsR, healthR, emsR,
    ] = await Promise.allSettled([
      fetchCluster(array), fetchNodes(array), fetchAggregates(array), fetchVolumes(array),
      fetchSvms(array), fetchDisks(array), fetchClusterMetrics(array),
      fetchHealthAlerts(array), fetchEmsAlerts(array),
    ]);

    const aggregates = aggR.status === 'fulfilled' ? aggR.value : [];
    const volumes = volR.status === 'fulfilled' ? volR.value : [];

    // Cluster capacity totals derived from aggregates (physical tiers).
    const totals = { total: 0, used: 0, available: 0, physicalUsed: 0, logicalUsed: 0, ratio: null };
    for (const a of aggregates) {
      const bs = (a.space && a.space.block_storage) || {};
      const eff = (a.space && a.space.efficiency) || {};
      totals.total += bs.size || 0;
      totals.used += bs.used || 0;
      totals.available += bs.available || 0;
      totals.physicalUsed += bs.physical_used || 0;
      totals.logicalUsed += eff.logical_used || 0;
    }
    if (totals.physicalUsed > 0 && totals.logicalUsed > 0) {
      totals.ratio = totals.logicalUsed / totals.physicalUsed;
    }

    const version = clusterR.status === 'fulfilled'
      ? (clusterR.value.version && clusterR.value.version.full)
      : null;
    const metrics = metricsR.status === 'fulfilled' ? metricsR.value : null;

    try {
      upsertMetrics(array, totals, metrics, { volumes: volumes.length, aggregates: aggregates.length }, version);
    } catch (err) {
      logger.error(`[NetAppPoller] Metrics insert failed for array ${array.id}:`, err.message);
    }

    const stores = [
      [aggR, () => replaceAggregates(array.id, aggregates), 'aggregates'],
      [volR, () => replaceVolumes(array.id, volumes), 'volumes'],
      [svmR, () => replaceSvms(array.id, svmR.value || []), 'svms'],
      [nodesR, () => replaceNodes(array.id, nodesR.value || []), 'nodes'],
      [diskR, () => replaceDisks(array.id, diskR.value || []), 'disks'],
    ];
    for (const [result, store, label] of stores) {
      if (result.status === 'fulfilled') {
        try { store(); } catch (err) { logger.error(`[NetAppPoller] ${label} store failed for array ${array.id}:`, err.message); }
      } else {
        logger.error(`[NetAppPoller] ${label} fetch failed for array ${array.id}:`, safeErrorMessage(result.reason));
      }
    }

    try {
      replaceAlerts(array.id,
        healthR.status === 'fulfilled' ? healthR.value : [],
        emsR.status === 'fulfilled' ? emsR.value : []);
    } catch (err) {
      logger.error(`[NetAppPoller] Alerts store failed for array ${array.id}:`, err.message);
    }
  } catch (err) {
    logger.error(`[NetAppPoller] Unexpected error for array ${array.id}:`, safeErrorMessage(err));
  }
}

function buildCronExpression(intervalMinutes) {
  const interval = Math.max(5, intervalMinutes || 15);
  return `*/${interval} * * * *`;
}

function cancelArray(arrayId) {
  const existing = scheduledTasks.get(arrayId);
  if (existing) { existing.stop(); scheduledTasks.delete(arrayId); }
}

function scheduleArray(array) {
  cancelArray(array.id);
  const task = cron.schedule(buildCronExpression(array.polling_interval_minutes), () => pollArray(array));
  scheduledTasks.set(array.id, task);
  logger.info(`[NetAppPoller] Scheduled array ${array.id} (${array.name}) every ${Math.max(5, array.polling_interval_minutes || 15)} min`);
}

function initNetAppPoller() {
  let arrays = [];
  try {
    arrays = db.prepare('SELECT * FROM netapp_arrays').all();
  } catch (err) {
    logger.error('[NetAppPoller] Failed to load arrays:', err.message);
    return;
  }
  for (const array of arrays) scheduleArray(array);
  logger.info(`[NetAppPoller] Initialized ${arrays.length} NetApp cluster(s)`);
}

async function triggerPoll(arrayId) {
  const array = db.prepare('SELECT * FROM netapp_arrays WHERE id = ?').get(arrayId);
  if (!array) throw new Error(`NetApp array ${arrayId} not found`);
  await pollArray(array);
}

module.exports = { initNetAppPoller, scheduleArray, cancelArray, pollArray, triggerPoll };
