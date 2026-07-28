const cron = require('node-cron');
const db = require('../db/database');
const {
  fetchClusterInfo, fetchAlerts, fetchProtectionRuns, fetchProtectionJobs,
  fetchProtectionPolicies, fetchSourceRegistrations, fetchSearchObjects,
  fetchProtectedObjectTimes, fetchPhysicalAgents,
} = require('./cohesityApi');
const { scheduleSnapshotRefresh, refreshDashboardSnapshot } = require('./snapshot');
const { fetchWorkloads, insertWorkloadSnapshot } = require('./workloads');
const logger = require('../utils/logger');
const { createPoller } = require('../core/pollerFramework');

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
  // Workload trend snapshots keep 2 years of daily history.
  try {
    const result = db.prepare(
      "DELETE FROM workload_history WHERE captured_at < datetime('now', '-730 days')"
    ).run();
    if (result.changes > 0) {
      logger.info(`[Retention] Pruned ${result.changes} old workload row(s)`);
    }
  } catch (err) {
    logger.error('[Retention] Failed to prune workload_history:', err.message);
  }
});

/**
 * Insert or update metrics for a cluster.
 */
function upsertMetrics(cluster, clusterInfo) {
  const stats = clusterInfo.stats || {};
  const usagePerfStats = stats.usagePerfStats || {};
  const dataUsageStats = stats.dataUsageStats || {};
  const logicalStats = stats.logicalStats || {};

  const logicalBytes =
    dataUsageStats.totalLogicalUsageBytes ??
    logicalStats.totalLogicalUsageBytes ??
    usagePerfStats.totalLogicalUsageBytes ??
    null;

  const dataReductionRatio = (() => {
    // Primary: top-level stats.dataReductionRatio (most accurate — Cohesity-computed)
    const topLevel = stats.dataReductionRatio;
    if (topLevel != null && topLevel > 0) return parseFloat(topLevel.toFixed(2));

    // Fallback: deduplicationRatio inside usagePerfStats
    const dedup = usagePerfStats.deduplicationRatio;
    if (dedup != null && dedup > 0) return parseFloat(dedup.toFixed(2));

    // Fallback: dataReductionRatio inside usagePerfStats
    const usageRatio = usagePerfStats.dataReductionRatio;
    if (usageRatio != null && usageRatio > 0) return parseFloat(usageRatio.toFixed(2));

    // Fallback: compute from raw ingestion bytes (dataInBytes / dataInBytesAfterReduction)
    const dataIn = usagePerfStats.dataInBytes ?? dataUsageStats.dataInBytes;
    const dataInAfterReduction = usagePerfStats.dataInBytesAfterReduction ?? dataUsageStats.dataInBytesAfterReduction;
    if (dataIn > 0 && dataInAfterReduction > 0) return parseFloat((dataIn / dataInAfterReduction).toFixed(2));

    // Fallback: compute from logical / physical
    const physical = usagePerfStats.totalPhysicalUsageBytes;
    if (logicalBytes > 0 && physical > 0) return parseFloat((logicalBytes / physical).toFixed(2));

    return null;
  })();

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
    logicalBytes,
    dataReductionRatio,
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
  // Keyed on (cluster_id, job_id, start_time): re-polling the same run from
  // Helios never duplicates it. Runs still in flight (kRunning/kAccepted) are
  // updated in place so their final status and stats land in the local DB.
  const runStmt = db.prepare(`
    INSERT INTO protection_runs
      (cluster_id, job_id, job_name, run_type, status, start_time, end_time,
       error_code, error_message, logical_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cluster_id, job_id, start_time) DO UPDATE SET
      status = excluded.status,
      end_time = excluded.end_time,
      error_code = excluded.error_code,
      error_message = excluded.error_message,
      logical_bytes = excluded.logical_bytes
    WHERE protection_runs.status IN ('kRunning', 'kAccepted')
  `);

  const replStmt = db.prepare(`
    INSERT INTO replication_runs
      (protection_run_id, cluster_id, target_cluster_name, target_cluster_id,
       status, logical_bytes, start_time, end_time, lag_seconds)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(protection_run_id, IFNULL(target_cluster_id, -1), IFNULL(target_cluster_name, ''), IFNULL(start_time, '')) DO UPDATE SET
      status = excluded.status,
      logical_bytes = excluded.logical_bytes,
      end_time = excluded.end_time,
      lag_seconds = excluded.lag_seconds
    WHERE replication_runs.status IN ('kRunning', 'kAccepted')
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
 * Replace the governance snapshot (policies + source registrations) for a
 * cluster. Current-state data, so old rows are dropped rather than kept.
 */
const replacePolicies = db.transaction((clusterId, policies) => {
  db.prepare('DELETE FROM policies WHERE cluster_id = ?').run(clusterId);
  const stmt = db.prepare(`
    INSERT INTO policies
      (cluster_id, policy_id, name, retention_days, replication_targets, archival_targets, datalock)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const p of policies) {
    stmt.run(
      clusterId,
      p.policyId,
      p.name,
      p.retentionDays,
      JSON.stringify(p.replicationTargets || []),
      JSON.stringify(p.archivalTargets || []),
      p.dataLock ? 1 : 0
    );
  }
});

const replaceSourceRegistrations = db.transaction((clusterId, sources) => {
  db.prepare('DELETE FROM source_registrations WHERE cluster_id = ?').run(clusterId);
  const stmt = db.prepare(`
    INSERT INTO source_registrations
      (cluster_id, source_id, source_name, environment,
       protected_count, unprotected_count, protected_bytes, unprotected_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const s of sources) {
    stmt.run(
      clusterId,
      s.sourceId,
      s.sourceName,
      s.environment,
      s.protectedCount,
      s.unprotectedCount,
      s.protectedBytes,
      s.unprotectedBytes
    );
  }
});

// Per-object inventory from the v2 object search. A protection info entry
// counts only when it belongs to THIS cluster's search response and is not
// deleted; group/policy detail comes from the first live entry.
const replaceObjects = db.transaction((clusterId, objects, backupTimes) => {
  db.prepare('DELETE FROM cohesity_objects WHERE cluster_id = ?').run(clusterId);
  const stmt = db.prepare(`
    INSERT INTO cohesity_objects
      (cluster_id, object_id, global_id, name, source_name, environment, object_type,
       os_type, protection_type, logical_bytes, is_protected, protection_groups,
       policy_names, last_backup_status, sla_violated, last_backup_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const env = (e) => String(e || 'Unknown').replace(/^k/, '');
  for (const o of objects) {
    const infos = (o.objectProtectionInfos || []).filter((i) => i && !i.isDeleted && (i.protectionGroups || []).length);
    const groups = infos.flatMap((i) => i.protectionGroups || []);
    stmt.run(
      clusterId,
      infos[0]?.objectId ?? null,
      o.globalId || null,
      o.name || null,
      o.sourceInfo?.name || null,
      env(o.environment),
      String(o.objectType || '').replace(/^k/, '') || null,
      String(o.osType || '').replace(/^k/, '') || null,
      String(o.protectionType || '').replace(/^k/, '') || null,
      o.logicalSizeBytes ?? null,
      groups.length ? 1 : 0,
      groups.length ? JSON.stringify(groups.map((g) => g.name).filter(Boolean)) : null,
      groups.length ? JSON.stringify([...new Set(groups.map((g) => g.policyName).filter(Boolean))]) : null,
      groups[0]?.lastBackupRunStatus || null,
      groups.length ? (groups.some((g) => g.lastRunSlaViolated) ? 1 : 0) : null,
      (infos[0]?.objectId != null && backupTimes?.get(infos[0].objectId)) || null
    );
  }
});

const replaceAgents = db.transaction((clusterId, agents) => {
  db.prepare('DELETE FROM cohesity_agents WHERE cluster_id = ?').run(clusterId);
  const stmt = db.prepare(`
    INSERT INTO cohesity_agents
      (cluster_id, source_id, name, host_type, os_name, agent_version,
       agent_status, upgradability, upgrade_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const a of agents) {
    stmt.run(clusterId, a.sourceId, a.name, a.hostType, a.osName,
      a.version, a.status, a.upgradability, a.upgradeStatus);
  }
});

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

// Protection-run fetch sizing. The first poll of a cluster backfills 90 days;
// after that, each poll only asks for runs since the last stored run (with an
// overlap), so requests stay small instead of re-pulling the whole window.
const BACKFILL_DAYS = 90;
const NUM_RUNS_BACKFILL = 2000;
const NUM_RUNS_INCREMENTAL = 500;
const INCREMENTAL_OVERLAP_MS = 6 * 60 * 60 * 1000; // re-fetch recent runs whose status may have changed
// A run stuck in kRunning/kAccepted (e.g. from a period when the cluster was
// erroring) must not pin the fetch window in the past forever — stop chasing
// its final status after this long.
const OPEN_RUN_MAX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
// Some clusters 500 on any runs query wider than ~a week (server-side timeout
// on their end). When the normal fetch fails, retry once at this window and
// remember the cluster so later polls skip the failing large query. In-memory:
// a restart re-attempts the full window in case the cluster was fixed.
const FALLBACK_WINDOW_DAYS = 7;
const smallWindowClusters = new Set();

/**
 * Fetch window for a cluster's protection runs: from the newest stored run
 * minus an overlap — pushed back to the oldest run still in flight so its
 * final status is always picked up. Empty table → full 90-day backfill.
 */
function runsFetchWindow(clusterId) {
  if (smallWindowClusters.has(clusterId)) {
    return {
      sinceUsecs: (Date.now() - FALLBACK_WINDOW_DAYS * 24 * 60 * 60 * 1000) * 1000,
      numRuns: NUM_RUNS_INCREMENTAL,
      incremental: true,
    };
  }
  const backfillMs = Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000;
  const row = db.prepare(`
    SELECT MAX(start_time) AS newest,
           MIN(CASE WHEN status IN ('kRunning', 'kAccepted') THEN start_time END) AS oldestOpen
    FROM protection_runs WHERE cluster_id = ?
  `).get(clusterId);
  if (!row?.newest) {
    return { sinceUsecs: backfillMs * 1000, numRuns: NUM_RUNS_BACKFILL, incremental: false };
  }
  let sinceMs = new Date(row.newest).getTime() - INCREMENTAL_OVERLAP_MS;
  if (row.oldestOpen) {
    let openMs = new Date(row.oldestOpen).getTime() - 60 * 1000;
    const openFloor = Date.now() - OPEN_RUN_MAX_LOOKBACK_MS;
    if (openMs < openFloor) openMs = openFloor;
    if (openMs < sinceMs) sinceMs = openMs;
  }
  if (sinceMs < backfillMs) sinceMs = backfillMs;
  return { sinceUsecs: Math.floor(sinceMs) * 1000, numRuns: NUM_RUNS_INCREMENTAL, incremental: true };
}

async function doPollCluster(cluster) {
  try {
    const window = runsFetchWindow(cluster.id);
    const [clusterInfo, alertData, protectionData, policyData, sourceData, workloadData, objectData, agentData] = await Promise.allSettled([
      fetchClusterInfo(cluster),
      fetchAlerts(cluster),
      fetchProtectionRuns(cluster, window.numRuns, window.sinceUsecs),
      fetchProtectionPolicies(cluster),
      fetchSourceRegistrations(cluster),
      fetchWorkloads(cluster),
      fetchSearchObjects(cluster),
      fetchPhysicalAgents(cluster)
    ]);
    // Timestamps come from a second search endpoint; a failure here should
    // not sink the object snapshot — objects just land without dates.
    const backupTimes = await fetchProtectedObjectTimes(cluster)
      .catch((err) => {
        logger.error(`[Poller] Protected-object times fetch failed for cluster ${cluster.id}:`, safeErrorMessage(err));
        return new Map();
      });

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

    if (policyData.status === 'fulfilled') {
      try {
        replacePolicies(cluster.id, policyData.value);
      } catch (err) {
        logger.error(`[Poller] Policy snapshot failed for cluster ${cluster.id}:`, err.message);
      }
    } else {
      logger.error(`[Poller] Policies fetch failed for cluster ${cluster.id}:`, safeErrorMessage(policyData.reason));
    }

    if (sourceData.status === 'fulfilled') {
      try {
        replaceSourceRegistrations(cluster.id, sourceData.value);
      } catch (err) {
        logger.error(`[Poller] Source registration snapshot failed for cluster ${cluster.id}:`, err.message);
      }
    } else {
      logger.error(`[Poller] Source registrations fetch failed for cluster ${cluster.id}:`, safeErrorMessage(sourceData.reason));
    }

    if (workloadData.status === 'fulfilled') {
      try {
        insertWorkloadSnapshot(cluster.id, workloadData.value);
      } catch (err) {
        logger.error(`[Poller] Workload snapshot failed for cluster ${cluster.id}:`, err.message);
      }
    } else {
      logger.error(`[Poller] Workload fetch failed for cluster ${cluster.id}:`, safeErrorMessage(workloadData.reason));
    }

    if (objectData.status === 'fulfilled') {
      try {
        replaceObjects(cluster.id, objectData.value, backupTimes);
      } catch (err) {
        logger.error(`[Poller] Object inventory snapshot failed for cluster ${cluster.id}:`, err.message);
      }
    } else {
      logger.error(`[Poller] Object search fetch failed for cluster ${cluster.id}:`, safeErrorMessage(objectData.reason));
    }

    if (agentData.status === 'fulfilled') {
      try {
        replaceAgents(cluster.id, agentData.value);
      } catch (err) {
        logger.error(`[Poller] Agent snapshot failed for cluster ${cluster.id}:`, err.message);
      }
    } else {
      logger.error(`[Poller] Agent fetch failed for cluster ${cluster.id}:`, safeErrorMessage(agentData.reason));
    }

    // If the normal fetch failed (some clusters 500 on wide windows), retry
    // once with a small window and pin this cluster to it for future polls.
    let protRuns = protectionData.status === 'fulfilled' ? protectionData.value : null;
    let usedFallback = false;
    if (protRuns === null && !smallWindowClusters.has(cluster.id)) {
      logger.warn(`[Poller] Protection runs fetch failed for cluster ${cluster.id} (${safeErrorMessage(protectionData.reason)}) — retrying with ${FALLBACK_WINDOW_DAYS}-day window`);
      try {
        protRuns = await fetchProtectionRuns(cluster, NUM_RUNS_INCREMENTAL, (Date.now() - FALLBACK_WINDOW_DAYS * 24 * 60 * 60 * 1000) * 1000);
        smallWindowClusters.add(cluster.id);
        usedFallback = true;
        logger.info(`[Poller] Cluster ${cluster.id} pinned to ${FALLBACK_WINDOW_DAYS}-day runs window (wide queries return HTTP 500 on this cluster)`);
      } catch (err) {
        logger.error(`[Poller] Fallback runs fetch also failed for cluster ${cluster.id}:`, safeErrorMessage(err));
      }
    }

    if (protRuns !== null) {
      try {
        upsertProtectionRuns(cluster, protRuns);
      } catch (err) {
        logger.error(`[Poller] Protection runs upsert failed for cluster ${cluster.id}:`, err.message);
      }

      // Phase 2 (per-job catch-up) only matters on the initial backfill, where
      // the run-count cap can hide low-frequency jobs. On incremental polls a
      // job's new runs always fall inside the fetch window, and its history is
      // already in the DB — re-sweeping every idle job would just hammer the
      // cluster with the exact large queries the incremental window avoids.
      if (!window.incremental && !usedFallback) {
        const seenJobIds = new Set(protRuns.map(r => r.jobId).filter(Boolean));

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
                runs = await fetchProtectionRuns(cluster, 100, window.sinceUsecs, null, job.id);
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
      }
    } else if (protectionData.status !== 'fulfilled' && smallWindowClusters.has(cluster.id)) {
      // Pinned cluster failed even at the small window — already at minimum.
      logger.error(`[Poller] Protection runs fetch failed for cluster ${cluster.id}:`, safeErrorMessage(protectionData.reason));
    }
  } finally {
    // Rebuild the cached dashboard payload so the next page load is instant.
    scheduleSnapshotRefresh();
  }
}

const cohesityPoller = createPoller({
  id: 'cohesity',
  loadSources: () => db.prepare('SELECT * FROM clusters').all(),
  intervalMinutes: (cluster) => cluster.polling_interval_minutes,
  poll: doPollCluster,
});

/**
 * Schedule a polling task for a cluster.
 */
function scheduleCluster(cluster) {
  cohesityPoller.schedule(cluster);
}

/**
 * Cancel and remove a scheduled task for a cluster.
 */
function cancelCluster(clusterId) {
  cohesityPoller.cancel(clusterId);
}

/**
 * Poll a single cluster (markStart/markEnd + error isolation via the
 * shared poller framework).
 */
async function pollCluster(cluster) {
  await cohesityPoller.trigger(cluster);
}

/**
 * Initialize all scheduled pollers from the database.
 */
function initPoller() {
  const clusters = cohesityPoller.init();
  logger.info(`[Poller] Initialized ${clusters.length} cluster(s)`);
  // Build the dashboard snapshot from existing cached data on startup so the
  // first page load is instant even before the next poll cycle runs.
  refreshDashboardSnapshot();
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
