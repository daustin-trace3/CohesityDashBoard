const cron = require('node-cron');
const db = require('../db/database');
const { fetchClusterInfo, fetchAlerts, fetchProtectionRuns, fetchProtectionJobs } = require('./cohesityApi');
const logger = require('../utils/logger');

// Map of clusterId -> cron task
const scheduledTasks = new Map();

// Retention: delete metrics older than 90 days — runs daily at 02:00
cron.schedule('0 2 * * *', () => {
  try {
    const result = db.prepare(
      "DELETE FROM metrics_history WHERE captured_at < datetime('now', '-90 days')"
    ).run();
    if (result.changes > 0) {
      logger.info(`[Retention] Pruned ${result.changes} old metrics row(s)`);
    }
  } catch (err) {
    logger.error('[Retention] Failed to prune metrics_history:', err.message);
  }
});

/**
 * Insert or update metrics for a cluster.
 */
function upsertMetrics(cluster, clusterInfo) {
  const stats = clusterInfo.stats || {};
  const usagePerfStats = stats.usagePerfStats || {};

  const stmt = db.prepare(`
    INSERT INTO metrics_history
      (cluster_id, captured_at, total_capacity_bytes, used_bytes, logical_bytes,
       data_reduction_ratio, software_version, node_count)
    VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    cluster.id,
    usagePerfStats.physicalCapacityBytes ?? null,
    usagePerfStats.totalPhysicalUsageBytes ?? null,
    usagePerfStats.totalLogicalUsageBytes ?? null,
    (() => {
      // Primary source: deduplicationRatio from API
      const dedup = usagePerfStats.deduplicationRatio;
      if (dedup != null && dedup > 0) {
        return parseFloat((dedup).toFixed(2));
      }
      // Fallback to existing logic
      const dataReductionRatio = usagePerfStats.dataReductionRatio;
      if (dataReductionRatio != null) {
        return dataReductionRatio;
      }
      const logical = usagePerfStats.totalLogicalUsageBytes;
      const physical = usagePerfStats.totalPhysicalUsageBytes;
      const comp = usagePerfStats.compressionRatio;
      // Try compression * dedup
      if (comp > 0 && dedup > 0) return parseFloat((comp * dedup).toFixed(2));
      // Try logical/physical
      if (logical > 0 && physical > 0) return parseFloat((logical / physical).toFixed(2));
      return null;
    })(),
    clusterInfo.clusterSoftwareVersion || clusterInfo.softwareVersion || null,
    clusterInfo.nodeCount ?? null
  );
}

/**
 * Upsert alerts from a Cohesity alert list response.
 */
function upsertAlerts(cluster, alertList) {
  const alerts = Array.isArray(alertList) ? alertList : (alertList.alerts || []);

  const stmt = db.prepare(`
    INSERT INTO alerts
      (cluster_id, cohesity_alert_id, severity, alert_type, description,
       resolved, dismissed, first_seen, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, datetime('now'))
    ON CONFLICT(cluster_id, cohesity_alert_id) DO UPDATE SET
      severity = excluded.severity,
      alert_type = excluded.alert_type,
      description = excluded.description,
      resolved = excluded.resolved,
      last_updated = datetime('now')
  `);

  for (const alert of alerts) {
    const alertId = alert.id || alert.alertId || alert.alertDocumentId;
    if (!alertId) continue;

    const severity = (alert.severity || 'kInfo').replace(/^k/, '').toLowerCase();
    const resolved = alert.alertState === 'kResolved' ? 1 : 0;
    const firstSeen = alert.firstTimestampUsecs
      ? new Date(alert.firstTimestampUsecs / 1000).toISOString()
      : new Date().toISOString();

    stmt.run(
      cluster.id,
      String(alertId),
      severity,
      alert.alertType || null,
      alert.alertDocument?.alertDescription || alert.description || null,
      resolved,
      firstSeen
    );
  }
}

/**
 * Upsert protection runs and their replication copyRuns.
 */
function upsertProtectionRuns(cluster, runs) {
  const runStmt = db.prepare(`
    INSERT OR IGNORE INTO protection_runs
      (cluster_id, job_id, job_name, run_type, status, start_time, end_time,
       error_code, error_message, logical_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const replStmt = db.prepare(`
    INSERT OR IGNORE INTO replication_runs
      (protection_run_id, cluster_id, target_cluster_name, target_cluster_id,
       status, logical_bytes, start_time, end_time, lag_seconds)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const findRunStmt = db.prepare(
    'SELECT id FROM protection_runs WHERE cluster_id = ? AND job_id = ? AND start_time = ?'
  );

  const insertMany = db.transaction((runList) => {
    for (const run of runList) {
      const backupRun = run.backupRun || {};
      const stats = backupRun.stats || {};
      const status = typeof backupRun.status === 'string' ? backupRun.status : 'kUnknown';
      const startTime = stats.startTimeUsecs
        ? new Date(stats.startTimeUsecs / 1000).toISOString()
        : null;
      const endTime = stats.endTimeUsecs
        ? new Date(stats.endTimeUsecs / 1000).toISOString()
        : null;
      const errorMessage = null;
      const logicalBytes = stats.totalLogicalBackupSizeBytes ?? null;
      const runType = backupRun.runType || null;

      runStmt.run(
        cluster.id,
        run.jobId ?? null,
        run.jobName || null,
        runType,
        status,
        startTime,
        endTime,
        null,
        errorMessage,
        logicalBytes
      );

      const protRow = findRunStmt.get(cluster.id, run.jobId ?? null, startTime);
      if (!protRow) continue;

      const copyRuns = Array.isArray(run.copyRun) ? run.copyRun : [];
      for (const cr of copyRuns) {
        if (cr.target?.type !== 'kRemote') continue;
        const crStats = cr.stats || {};
        const crStart = crStats.startTimeUsecs
          ? new Date(crStats.startTimeUsecs / 1000).toISOString()
          : null;
        const crEnd = crStats.endTimeUsecs
          ? new Date(crStats.endTimeUsecs / 1000).toISOString()
          : null;
        const lagSeconds =
          crStats.startTimeUsecs && crStats.endTimeUsecs
            ? Math.round((crStats.endTimeUsecs - crStats.startTimeUsecs) / 1_000_000)
            : null;

        replStmt.run(
          protRow.id,
          cluster.id,
          cr.target?.replicationTarget?.clusterName || null,
          cr.target?.replicationTarget?.clusterId ?? null,
          cr.status || null,
          crStats.logicalBytesTransferred ?? null,
          crStart,
          crEnd,
          lagSeconds
        );
      }
    }
  });

  insertMany(runs);
}

/**
 * Poll a single cluster.
 */
function safeErrorMessage(err) {
  if (err?.response) {
    return `HTTP ${err.response.status} from cluster`;
  }
  if (err?.code) {
    return `Network error: ${err.code}`;
  }
  return 'Unknown error';
}

async function pollCluster(cluster) {
  try {
    const ninetyDaysAgo = (Date.now() - 90 * 24 * 60 * 60 * 1000) * 1000; // usecs
    const [clusterInfo, alertData, protectionData] = await Promise.allSettled([
      fetchClusterInfo(cluster),
      fetchAlerts(cluster),
      fetchProtectionRuns(cluster, 10000, ninetyDaysAgo)
    ]);

    if (clusterInfo.status === 'fulfilled') {
      upsertMetrics(cluster, clusterInfo.value);
    } else {
      logger.error(`[Poller] Metrics fetch failed for cluster ${cluster.id}:`, safeErrorMessage(clusterInfo.reason));
    }

    if (alertData.status === 'fulfilled') {
      upsertAlerts(cluster, alertData.value);
    } else {
      logger.error(`[Poller] Alerts fetch failed for cluster ${cluster.id}:`, safeErrorMessage(alertData.reason));
    }

    if (protectionData.status === 'fulfilled') {
      try {
        upsertProtectionRuns(cluster, protectionData.value);
      } catch (err) {
        logger.error(`[Poller] Protection runs upsert failed for cluster ${cluster.id}:`, err.message);
      }

      const seenJobIds = new Set(protectionData.value.map(r => r.jobId).filter(Boolean));

      let allJobs = [];
      try {
        allJobs = await fetchProtectionJobs(cluster);
      } catch (err) {
        logger.error(`[Poller] Phase 2 jobs list fetch failed for cluster ${cluster.id}:`, safeErrorMessage(err));
      }

      if (allJobs.length > 0) {
        const missedJobs = allJobs.filter(job => !seenJobIds.has(job.id)).slice(0, 200);
        if (missedJobs.length > 0) {
          logger.info(`[Poller] Phase 2: fetching ${missedJobs.length} missed job(s) for cluster ${cluster.id}`);
          for (const job of missedJobs) {
            let runs;
            try {
              runs = await fetchProtectionRuns(cluster, 100, ninetyDaysAgo, null, job.id);
            } catch (err) {
              logger.error(`[Poller] Phase 2 fetch failed for job ${job.id} on cluster ${cluster.id}:`, safeErrorMessage(err));
              continue;
            }
            if (runs && runs.length > 0) {
              try {
                upsertProtectionRuns(cluster, runs);
              } catch (err) {
                logger.error(`[Poller] Phase 2 upsert failed for job ${job.id} on cluster ${cluster.id}:`, err.message);
              }
            }
          }
        }
      }
    } else {
      logger.error(`[Poller] Protection runs fetch failed for cluster ${cluster.id}:`, safeErrorMessage(protectionData.reason));
    }
  } catch (err) {
    logger.error(`[Poller] Unexpected error for cluster ${cluster.id}:`, safeErrorMessage(err));
  }
}

/**
 * Build a cron expression from polling interval in minutes (minimum 5).
 */
function buildCronExpression(intervalMinutes) {
  const interval = Math.max(5, intervalMinutes);
  // Run every N minutes starting from minute 0
  return `*/${interval} * * * *`;
}

/**
 * Schedule a polling task for a cluster.
 */
function scheduleCluster(cluster) {
  // Cancel any existing task
  cancelCluster(cluster.id);

  const expression = buildCronExpression(cluster.polling_interval_minutes);
  const task = cron.schedule(expression, () => {
    pollCluster(cluster);
  });

  scheduledTasks.set(cluster.id, task);
  logger.info(`[Poller] Scheduled cluster ${cluster.id} (${cluster.name}) every ${cluster.polling_interval_minutes} min`);
}

/**
 * Cancel and remove a scheduled task for a cluster.
 */
function cancelCluster(clusterId) {
  const existing = scheduledTasks.get(clusterId);
  if (existing) {
    existing.stop();
    scheduledTasks.delete(clusterId);
  }
}

/**
 * Initialize all scheduled pollers from the database.
 */
function initPoller() {
  const clusters = db.prepare('SELECT * FROM clusters').all();
  for (const cluster of clusters) {
    scheduleCluster(cluster);
  }
  logger.info(`[Poller] Initialized ${clusters.length} cluster(s)`);
}

/**
 * Manually trigger a poll for a specific cluster.
 */
async function triggerPoll(clusterId) {
  const cluster = db.prepare('SELECT * FROM clusters WHERE id = ?').get(clusterId);
  if (!cluster) throw new Error(`Cluster ${clusterId} not found`);
  await pollCluster(cluster);
}

module.exports = { initPoller, scheduleCluster, cancelCluster, pollCluster, triggerPoll };
