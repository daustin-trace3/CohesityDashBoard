const cron = require('node-cron');
const db = require('../db/database');
const {
  fetchArrayInfo, fetchAlerts, fetchVolumes, fetchHosts,
} = require('./pureApi');
const logger = require('../utils/logger');

// arrayId -> cron task
const scheduledTasks = new Map();

// Retention: prune Pure metrics older than 90 days, daily at 02:10.
cron.schedule('10 2 * * *', () => {
  try {
    const result = db.prepare(
      "DELETE FROM pure_metrics_history WHERE captured_at < datetime('now', '-90 days')"
    ).run();
    if (result.changes > 0) {
      logger.info(`[PurePoller] Pruned ${result.changes} old metrics row(s)`);
    }
  } catch (err) {
    logger.error('[PurePoller] Failed to prune pure_metrics_history:', err.message);
  }
});

function num(v) {
  return v === undefined || v === null ? null : Number(v);
}

/** Insert a capacity + performance sample. */
function upsertMetrics(array, info, performance, volumeCount) {
  const space = (info && info.space) || {};
  const perf = performance || {};

  db.prepare(`
    INSERT INTO pure_metrics_history
      (array_id, captured_at, capacity_bytes, used_bytes, data_reduction, total_reduction,
       shared_bytes, snapshots_bytes, system_bytes, volume_count,
       read_iops, write_iops, read_bw_bytes, write_bw_bytes,
       read_latency_us, write_latency_us, queue_depth, purity_version)
    VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    array.id,
    num(info && info.capacity),
    num(space.total_physical),
    num(space.data_reduction),
    num(space.total_reduction),
    num(space.shared),
    num(space.snapshots),
    num(space.system),
    volumeCount ?? null,
    num(perf.reads_per_sec),
    num(perf.writes_per_sec),
    num(perf.read_bytes_per_sec),
    num(perf.write_bytes_per_sec),
    num(perf.usec_per_read_op),
    num(perf.usec_per_write_op),
    num(perf.queue_depth),
    (info && (info.version || info.os)) || null
  );
}

/** Upsert open alerts, keyed on the array's own alert id. */
const upsertAlerts = db.transaction((array, alerts) => {
  const stmt = db.prepare(`
    INSERT INTO pure_alerts
      (array_id, pure_alert_id, severity, category, component_type, component_name,
       summary, state, flagged, created_at_ms, updated_at_ms, captured_at)
    VALUES (@array_id, @pure_alert_id, @severity, @category, @component_type, @component_name,
            @summary, @state, @flagged, @created_at_ms, @updated_at_ms, datetime('now'))
    ON CONFLICT(array_id, pure_alert_id) DO UPDATE SET
      severity       = excluded.severity,
      category       = excluded.category,
      component_type = excluded.component_type,
      component_name = excluded.component_name,
      summary        = excluded.summary,
      state          = excluded.state,
      flagged        = excluded.flagged,
      updated_at_ms  = excluded.updated_at_ms,
      captured_at    = datetime('now')
  `);

  const seen = [];
  for (const a of alerts) {
    const pureAlertId = String(a.id ?? a.name ?? '');
    if (!pureAlertId) continue;
    seen.push(pureAlertId);
    stmt.run({
      array_id: array.id,
      pure_alert_id: pureAlertId,
      severity: a.severity || null,
      category: a.category || null,
      component_type: a.component_type || null,
      component_name: a.component_name || null,
      summary: a.summary || null,
      state: a.state || null,
      flagged: a.flagged ? 1 : 0,
      created_at_ms: num(a.created),
      updated_at_ms: num(a.updated),
    });
  }

  // Anything no longer returned as "open" is cleared out.
  if (seen.length > 0) {
    const placeholders = seen.map(() => '?').join(',');
    db.prepare(
      `DELETE FROM pure_alerts WHERE array_id = ? AND pure_alert_id NOT IN (${placeholders})`
    ).run(array.id, ...seen);
  } else {
    db.prepare('DELETE FROM pure_alerts WHERE array_id = ?').run(array.id);
  }
});

const replaceVolumes = db.transaction((arrayId, volumes) => {
  db.prepare('DELETE FROM pure_volumes WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare(`
    INSERT INTO pure_volumes
      (array_id, name, provisioned_bytes, used_bytes, data_reduction, snapshots_bytes, destroyed)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const v of volumes) {
    const space = v.space || {};
    stmt.run(
      arrayId,
      v.name || null,
      num(v.provisioned),
      num(space.total_physical ?? space.unique),
      num(space.data_reduction),
      num(space.snapshots),
      v.destroyed ? 1 : 0
    );
  }
});

const replaceHosts = db.transaction((arrayId, hosts) => {
  db.prepare('DELETE FROM pure_hosts WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare(`
    INSERT INTO pure_hosts (array_id, name, connection_count, personality, protocol)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const h of hosts) {
    let protocol = null;
    if (Array.isArray(h.iqns) && h.iqns.length) protocol = 'iSCSI';
    else if (Array.isArray(h.nqns) && h.nqns.length) protocol = 'NVMe';
    else if (Array.isArray(h.wwns) && h.wwns.length) protocol = 'FC';
    stmt.run(
      arrayId,
      h.name || null,
      num(h.connection_count),
      h.personality || null,
      protocol
    );
  }
});

function safeErrorMessage(err) {
  if (err?.response) return `HTTP ${err.response.status} from array`;
  if (err?.code) return `Network error: ${err.code}`;
  return err?.message || 'Unknown error';
}

/** Poll a single Pure array: capacity, performance, alerts, volumes, hosts. */
async function pollArray(array) {
  try {
    const [infoResult, alertResult, volumeResult, hostResult] = await Promise.allSettled([
      fetchArrayInfo(array),
      fetchAlerts(array),
      fetchVolumes(array),
      fetchHosts(array),
    ]);

    let volumeCount = null;
    if (volumeResult.status === 'fulfilled') {
      volumeCount = volumeResult.value.length;
      try {
        replaceVolumes(array.id, volumeResult.value);
      } catch (err) {
        logger.error(`[PurePoller] Volume snapshot failed for array ${array.id}:`, err.message);
      }
    } else {
      logger.error(`[PurePoller] Volumes fetch failed for array ${array.id}:`, safeErrorMessage(volumeResult.reason));
    }

    if (infoResult.status === 'fulfilled') {
      try {
        upsertMetrics(array, infoResult.value.info, infoResult.value.performance, volumeCount);
      } catch (err) {
        logger.error(`[PurePoller] Metrics insert failed for array ${array.id}:`, err.message);
      }
    } else {
      logger.error(`[PurePoller] Array info fetch failed for array ${array.id}:`, safeErrorMessage(infoResult.reason));
    }

    if (alertResult.status === 'fulfilled') {
      try {
        upsertAlerts(array, alertResult.value);
      } catch (err) {
        logger.error(`[PurePoller] Alert upsert failed for array ${array.id}:`, err.message);
      }
    } else {
      logger.error(`[PurePoller] Alerts fetch failed for array ${array.id}:`, safeErrorMessage(alertResult.reason));
    }

    if (hostResult.status === 'fulfilled') {
      try {
        replaceHosts(array.id, hostResult.value);
      } catch (err) {
        logger.error(`[PurePoller] Host snapshot failed for array ${array.id}:`, err.message);
      }
    } else {
      logger.error(`[PurePoller] Hosts fetch failed for array ${array.id}:`, safeErrorMessage(hostResult.reason));
    }
  } catch (err) {
    logger.error(`[PurePoller] Unexpected error for array ${array.id}:`, safeErrorMessage(err));
  }
}

function buildCronExpression(intervalMinutes) {
  const interval = Math.max(5, intervalMinutes || 15);
  return `*/${interval} * * * *`;
}

function cancelArray(arrayId) {
  const existing = scheduledTasks.get(arrayId);
  if (existing) {
    existing.stop();
    scheduledTasks.delete(arrayId);
  }
}

function scheduleArray(array) {
  cancelArray(array.id);
  const task = cron.schedule(buildCronExpression(array.polling_interval_minutes), () => {
    pollArray(array);
  });
  scheduledTasks.set(array.id, task);
  logger.info(`[PurePoller] Scheduled array ${array.id} (${array.name}) every ${Math.max(5, array.polling_interval_minutes || 15)} min`);
}

function initPurePoller() {
  let arrays = [];
  try {
    arrays = db.prepare('SELECT * FROM pure_arrays').all();
  } catch (err) {
    logger.error('[PurePoller] Failed to load arrays:', err.message);
    return;
  }
  for (const array of arrays) {
    scheduleArray(array);
  }
  logger.info(`[PurePoller] Initialized ${arrays.length} Pure array(s)`);
}

async function triggerPoll(arrayId) {
  const array = db.prepare('SELECT * FROM pure_arrays WHERE id = ?').get(arrayId);
  if (!array) throw new Error(`Pure array ${arrayId} not found`);
  await pollArray(array);
}

module.exports = { initPurePoller, scheduleArray, cancelArray, pollArray, triggerPoll };
