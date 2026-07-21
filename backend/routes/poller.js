const express = require('express');
const db = require('../db/database');
const { pollCluster } = require('../services/poller');
const { listProtectionGroupsV2, getProtectionGroupRunsV2 } = require('../services/cohesityApi');
const pollerStatus = require('../services/pollerStatus');
const registry = require('../core/registry');
const { getSetting } = require('../services/settings');
const router = express.Router();

// Per-plugin metrics-history table + array-key column, for the lastCapture
// lookup in each entity's status row. Pure/NetApp today; any future platform
// plugin with a metrics_history table + statusTables[0] as its arrays table
// can add an entry here.
const PLATFORM_METRICS_HISTORY = {
  pure: { arraysTable: 'pure_arrays', metricsTable: 'pure_metrics_history', arrayIdColumn: 'array_id' },
  netapp: { arraysTable: 'netapp_arrays', metricsTable: 'netapp_metrics_history', arrayIdColumn: 'array_id' },
  vcenter: { arraysTable: 'vcenter_vcenters', metricsTable: 'vcenter_metrics_history', arrayIdColumn: 'vcenter_id' },
};

router.post('/trigger/:clusterId', (req, res, next) => {
  try {
    const { clusterId } = req.params;
    const cluster = db.prepare('SELECT * FROM clusters WHERE id = ?').get(Number(clusterId));
    if (!cluster) return res.status(404).json({ error: 'Cluster not found.' });
    pollCluster(cluster).catch(() => {}); // fire and forget
    res.json({ message: 'Poll triggered.' });
  } catch (err) {
    next(err);
  }
});

router.get('/status', (req, res, next) => {
  try {
    const now = Date.now();

    // Helper: compute ageMinutes from a captured_at UTC string (no timezone suffix).
    function ageMinutes(capturedAt) {
      if (!capturedAt) return null;
      const ms = new Date(capturedAt + 'Z').getTime();
      if (isNaN(ms)) return null;
      return Math.round((now - ms) / 60000);
    }

    // Helper: build entity array from a table.
    function buildEntities(rows, metricsQuery, type) {
      return rows.map(row => {
        const metricsRow = db.prepare(metricsQuery).get(row.id);
        const lastDataCapture = metricsRow
          ? strftime(metricsRow.captured_at)
          : null;
        const age = ageMinutes(metricsRow ? metricsRow.captured_at : null);
        const interval = Math.max(5, row.polling_interval_minutes || 15);
        const state = pollerStatus.getState(type, row.id);
        return {
          id: row.id,
          name: row.name,
          intervalMinutes: interval,
          isSyncing: state.isSyncing,
          lastPollStart: state.lastPollStart,
          lastPollEnd: state.lastPollEnd,
          lastPollStatus: state.lastPollStatus,
          lastDataCapture,
          ageMinutes: age,
          isStale: age !== null ? age > interval * 2 + 5 : false,
        };
      });
    }

    // Attach Z suffix to bare UTC strings from SQLite.
    function strftime(val) {
      if (!val) return null;
      return val.endsWith('Z') ? val : val + 'Z';
    }

    // Cohesity clusters
    const clusters = db.prepare('SELECT id, name, polling_interval_minutes FROM clusters').all();
    const cohesityEntities = buildEntities(
      clusters,
      'SELECT captured_at FROM metrics_history WHERE cluster_id = ? ORDER BY captured_at DESC LIMIT 1',
      'cohesity'
    );

    // Registry-driven platform plugins (pure, netapp): entities + enabled
    // state derive from the registry; the metrics-history table for the
    // lastCapture lookup comes from PLATFORM_METRICS_HISTORY above.
    const platformSections = {};
    for (const [pluginId, cfg] of Object.entries(PLATFORM_METRICS_HISTORY)) {
      const plugin = registry.getPlugin(pluginId);
      const arrays = db.prepare(`SELECT id, name, polling_interval_minutes FROM ${cfg.arraysTable}`).all();
      const entities = buildEntities(
        arrays,
        `SELECT captured_at FROM ${cfg.metricsTable} WHERE ${cfg.arrayIdColumn} = ? ORDER BY captured_at DESC LIMIT 1`,
        pluginId
      );
      platformSections[pluginId] = {
        enabled: plugin ? plugin.enabled : false,
        entities,
      };
    }

    // Licensing (global, no per-entity structure)
    const licenseRow = db.prepare('SELECT MAX(captured_at) AS captured_at FROM license_usage').get();
    const licenseCapture = licenseRow ? licenseRow.captured_at : null;
    const licenseAge = ageMinutes(licenseCapture);
    const licensingState = pollerStatus.getState('licensing', 0);
    // Licensing interval is 60 min (hardcoded in initLicensing hourly cron).
    const licensingInterval = 60;

    // Views inventory (global, hourly cron in initViews)
    const viewsRow = db.prepare('SELECT MAX(captured_at) AS captured_at FROM cohesity_views').get();
    const viewsCapture = viewsRow ? viewsRow.captured_at : null;
    const viewsAge = ageMinutes(viewsCapture);
    const viewsState = pollerStatus.getState('views', 0);

    // Zerto (account-global SaaS task — no per-entity structure)
    const zertoPlugin = registry.getPlugin('zerto');
    const zertoRow = db.prepare('SELECT MAX(captured_at) AS captured_at FROM zerto_metrics_history').get();
    const zertoCapture = zertoRow ? zertoRow.captured_at : null;
    const zertoAge = ageMinutes(zertoCapture);
    const zertoState = pollerStatus.getState('zerto', 0);
    const zertoInterval = Number(getSetting('zerto_poll_interval_minutes')) || 15;

    res.json({
      cohesity: {
        enabled: clusters.length > 0,
        entities: cohesityEntities,
      },
      pure: platformSections.pure,
      netapp: platformSections.netapp,
      vcenter: platformSections.vcenter,
      licensing: {
        enabled: true,
        isSyncing: licensingState.isSyncing,
        lastRefreshEnd: licensingState.lastPollEnd,
        lastDataCapture: strftime(licenseCapture),
        ageMinutes: licenseAge,
        isStale: licenseAge !== null ? licenseAge > licensingInterval * 2 + 5 : false,
        failedSources: [],
      },
      views: {
        enabled: true,
        isSyncing: viewsState.isSyncing,
        lastRefreshEnd: viewsState.lastPollEnd,
        lastDataCapture: strftime(viewsCapture),
        ageMinutes: viewsAge,
        isStale: viewsAge !== null ? viewsAge > licensingInterval * 2 + 5 : false,
      },
      zerto: {
        enabled: zertoPlugin ? zertoPlugin.enabled : false,
        isSyncing: zertoState.isSyncing,
        lastRefreshEnd: zertoState.lastPollEnd,
        lastDataCapture: strftime(zertoCapture),
        ageMinutes: zertoAge,
        isStale: zertoAge !== null ? zertoAge > zertoInterval * 2 + 5 : false,
        failedSources: [],
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/v2/protection-group-runs-test', async (req, res, next) => {
  try {
    const { clusterName, jobId, entityName, numRuns = '50', scanMode, jobName, sourceClusterName, targetClusterName, startDate, endDate, debugRaw } = req.query;

    if (!clusterName) {
      return res.status(400).json({ error: 'clusterName query parameter is required.' });
    }

    const numRunsInt = Math.min(Math.max(parseInt(numRuns, 10) || 50, 1), 500);
    const isScanMode = scanMode === 'true';

    const cluster = db.prepare('SELECT * FROM clusters WHERE LOWER(name) = LOWER(?)').get(clusterName);
    if (!cluster) {
      return res.status(404).json({ error: `Cluster '${clusterName}' not found.` });
    }

    // Helper: Extract replication target results from a run
    // Cohesity v2 stores these in replicationInfo.replicationTargetResults[]
    const extractReplicationTargets = (run) => {
      if (run.replicationInfo && Array.isArray(run.replicationInfo.replicationTargetResults)) {
        return run.replicationInfo.replicationTargetResults;
      }
      if (Array.isArray(run.replicationRuns)) {
        return run.replicationRuns;
      }
      return [];
    };

    const extractReplicationStatuses = (run) => {
      const targets = extractReplicationTargets(run);
      if (targets.length > 0) return targets.map(t => t.status).filter(Boolean);
      if (run.isReplicationRun && run.status) return [run.status];
      return [];
    };

    // Helper: Check if run has replication signals
    const hasReplicationSignals = (run) => {
      if (run.replicationInfo && Array.isArray(run.replicationInfo.replicationTargetResults) && run.replicationInfo.replicationTargetResults.length > 0) return true;
      if (Array.isArray(run.replicationRuns) && run.replicationRuns.length > 0) return true;
      if (run.isReplicationRun) return true;
      return false;
    };

    // Helper: Check if target cluster name matches any replication target
    const matchesTargetCluster = (run, targetCluster) => {
      const targetLower = targetCluster.toLowerCase();
      const targets = extractReplicationTargets(run);
      if (targets.some(t => (t.clusterName || '').toLowerCase().includes(targetLower))) return true;
      if (run.replicationInfo) {
        if (JSON.stringify(run.replicationInfo).toLowerCase().includes(targetLower)) return true;
      }
      return false;
    };

    // Helper: Convert YYYY-MM-DD to usecs
    const dateToUsecs = (dateStr) => {
      if (!dateStr) return null;
      const d = new Date(dateStr + 'T00:00:00Z');
      if (isNaN(d.getTime())) return null;
      return d.getTime() * 1000;
    };

    // Helper: Match jobId by exact string/number or suffix (composite ID)
    const matchesJobId = (fieldValue, jobId) => {
      if (!jobId || fieldValue == null) return false;
      const jobIdStr = String(jobId);
      const fieldStr = String(fieldValue);
      // Exact match
      if (fieldStr === jobIdStr) return true;
      // Number match
      const jobIdNum = parseInt(jobId, 10);
      if (!isNaN(jobIdNum) && Number(fieldValue) === jobIdNum) return true;
      // Suffix match for composite IDs (e.g., "6984:1631:1209390" ends with ":1209390")
      if (fieldStr.endsWith(':' + jobIdStr)) return true;
      return false;
    };

    // Scan mode: list all protection groups, filter by jobId/jobName, fetch runs for each
    if (isScanMode) {
      let protectionGroups = [];
      try {
        protectionGroups = await listProtectionGroupsV2(cluster);
      } catch (err) {
        console.error('Failed to list protection groups:', err.message);
        return res.status(502).json({ error: 'Failed to fetch protection groups from cluster.' });
      }

      if (protectionGroups.length === 0) {
        return res.status(404).json({ error: 'No protection groups found on cluster.' });
      }

      const notes = [];
      const startUsecs = dateToUsecs(startDate);
      const endUsecs = dateToUsecs(endDate);

      // Filter candidates by jobId and/or jobName
      const candidates = protectionGroups.filter(g => {
        let matches = true;
        if (jobId) {
          const idMatch = matchesJobId(g.id, jobId) ||
                          matchesJobId(g.protectionGroupId, jobId) ||
                          matchesJobId(g.legacyId, jobId) ||
                          matchesJobId(g.oldId, jobId);
          matches = matches && idMatch;
        }
        if (jobName) {
          const jobNameLower = jobName.toLowerCase();
          const nameMatch = (g.name && g.name.toLowerCase().includes(jobNameLower)) ||
                            (g.protectionGroupName && g.protectionGroupName.toLowerCase().includes(jobNameLower)) ||
                            JSON.stringify(g).toLowerCase().includes(jobNameLower);
          matches = matches && nameMatch;
        }
        return matches;
      });

      const matchedGroups = [];
      const groupReplicationStats = {};
      let totalGroupsWithRuns = 0;
      let totalGroupsWithReplication = 0;
      let totalGroupsMatchingTarget = 0;

      // Fetch and analyze runs for each candidate group
      for (const group of candidates) {
        try {
          const runOptions = { numRuns: numRunsInt, includeObjectDetails: true };
          if (startUsecs) runOptions.startTimeUsecs = startUsecs;
          if (endUsecs) runOptions.endTimeUsecs = endUsecs;

          const runs = await getProtectionGroupRunsV2(cluster, group.id, runOptions);
          const runsArray = Array.isArray(runs) ? runs : [];

          if (runsArray.length === 0) continue;

          totalGroupsWithRuns++;

          const hasReplicationInGroup = runsArray.some(run => hasReplicationSignals(run));
          if (hasReplicationInGroup) totalGroupsWithReplication++;

          let matchesTarget = false;
          const replicationStatusSummary = {};
          if (targetClusterName) {
            matchesTarget = runsArray.some(run => matchesTargetCluster(run, targetClusterName));
            if (matchesTarget) totalGroupsMatchingTarget++;
          }

          // Aggregate replication statuses from this group
          runsArray.forEach(run => {
            const statuses = extractReplicationStatuses(run);
            statuses.forEach(status => {
              const key = status || 'Unknown';
              replicationStatusSummary[key] = (replicationStatusSummary[key] || 0) + 1;
            });
          });

          if (matchedGroups.length < 20) {
            const entry = {
              id: group.id,
              name: group.name,
              runCount: runsArray.length,
              replicationStatusSummary,
              matchedTarget: matchesTarget ? targetClusterName : null,
              replicationTargetDetails: runsArray.flatMap(run => extractReplicationTargets(run).map(t => ({
                runId: run.id,
                clusterName: t.clusterName,
                status: t.status,
                startTimeUsecs: t.startTimeUsecs,
                logicalBytesTransferred: t.stats && t.stats.logicalBytesTransferred,
                physicalBytesTransferred: t.stats && t.stats.physicalBytesTransferred,
                logicalSizeBytes: t.stats && t.stats.logicalSizeBytes,
                percentComplete: (t.stats && t.stats.logicalSizeBytes > 0)
                  ? parseFloat(((t.stats.logicalBytesTransferred / t.stats.logicalSizeBytes) * 100).toFixed(2))
                  : null
              })))
            };
            if (debugRaw === 'true') {
              entry.rawRunSlices = runsArray.slice(0, 5).map(run => ({
                id: run.id,
                status: run.status,
                isReplicationRun: run.isReplicationRun,
                localBackupInfo: run.localBackupInfo,
                replicationInfo: run.replicationInfo,
                replicationRuns: run.replicationRuns,
                archivalInfo: run.archivalInfo,
                cloudSpinInfo: run.cloudSpinInfo,
                originClusterIdentifier: run.originClusterIdentifier,
                allKeys: Object.keys(run)
              }));
            }
            matchedGroups.push(entry);
          }

          // Update global stats
          Object.entries(replicationStatusSummary).forEach(([status, count]) => {
            groupReplicationStats[status] = (groupReplicationStats[status] || 0) + count;
          });
        } catch (err) {
          console.error(`Failed to fetch runs for group ${group.id}:`, err.message);
          notes.push(`Partial data: Could not fetch runs for group ${group.id}`);
        }
      }

      res.json({
        scanMode: true,
        totalGroupsScanned: candidates.length,
        groupsWithRuns: totalGroupsWithRuns,
        groupsWithReplicationSignals: totalGroupsWithReplication,
        groupsMatchingTarget: targetClusterName ? totalGroupsMatchingTarget : null,
        matchedGroups,
        globalReplicationSummary: groupReplicationStats,
        filtersApplied: {
          clusterName,
          jobId: jobId || null,
          jobName: jobName || null,
          sourceClusterName: sourceClusterName || null,
          targetClusterName: targetClusterName || null,
          startDate: startDate || null,
          endDate: endDate || null,
          startDateUsecs: startUsecs,
          endDateUsecs: endUsecs,
          numRuns: numRunsInt
        },
        notes
      });
      return;
    }

    // Single-group mode (legacy): backward compatible
    let protectionGroups = [];
    try {
      protectionGroups = await listProtectionGroupsV2(cluster);
    } catch (err) {
      console.error('Failed to list protection groups:', err.message);
      return res.status(502).json({ error: 'Failed to fetch protection groups from cluster.' });
    }

    if (protectionGroups.length === 0) {
      return res.status(404).json({ error: 'No protection groups found on cluster.' });
    }

    let selectedGroup = null;
    let selectionMethod = 'fallback';

    if (jobId) {
      selectedGroup = protectionGroups.find(g => {
        return matchesJobId(g.id, jobId) ||
               matchesJobId(g.protectionGroupId, jobId) ||
               matchesJobId(g.legacyId, jobId) ||
               matchesJobId(g.oldId, jobId);
      });
      if (selectedGroup) selectionMethod = 'jobId';
    }

    if (!selectedGroup && entityName) {
      const entityLower = entityName.toLowerCase();
      selectedGroup = protectionGroups.find(g => {
        if (g.name && g.name.toLowerCase().includes(entityLower)) return true;
        if (g.protectionGroupName && g.protectionGroupName.toLowerCase().includes(entityLower)) return true;
        const groupJson = JSON.stringify(g).toLowerCase();
        if (groupJson.includes(entityLower)) return true;
        return false;
      });
      if (selectedGroup) selectionMethod = 'entityName';
    }

    if (!selectedGroup) {
      selectedGroup = protectionGroups[0];
      selectionMethod = 'fallback';
    }

    if (!selectedGroup.id) {
      return res.status(502).json({ error: 'Selected protection group has no valid ID.' });
    }

    let runs = [];
    try {
      runs = await getProtectionGroupRunsV2(cluster, selectedGroup.id, {
        numRuns: numRunsInt,
        includeObjectDetails: true
      });
    } catch (err) {
      console.error('Failed to fetch protection group runs:', err.message);
      return res.status(502).json({ error: 'Failed to fetch protection group runs from cluster.' });
    }

    const totalRunsReturned = Array.isArray(runs) ? runs.length : 0;

    const replicationSummary = {};
    if (Array.isArray(runs)) {
      runs.forEach(run => {
        const statuses = extractReplicationStatuses(run);
        statuses.forEach(status => {
          const key = status || 'Unknown';
          replicationSummary[key] = (replicationSummary[key] || 0) + 1;
        });
      });
    }

    const sampleRuns = (Array.isArray(runs) ? runs.slice(0, 10) : []).map(run => {
      const replicationStatuses = extractReplicationStatuses(run);
      const replicationTargets = extractReplicationTargets(run).map(t => ({
        clusterName: t.clusterName,
        status: t.status,
        startTimeUsecs: t.startTimeUsecs,
        stats: t.stats
      }));
      return {
        id: run.id,
        protectionGroupId: run.protectionGroupId,
        protectionGroupName: run.protectionGroupName,
        isReplicationRun: run.isReplicationRun,
        startTimeUsecs: run.startTimeUsecs,
        endTimeUsecs: run.endTimeUsecs,
        status: run.status,
        replicationStatuses,
        replicationTargets
      };
    });

    const rawFieldHints = [];
    if (totalRunsReturned > 0) {
      const firstRun = Array.isArray(runs) ? runs[0] : null;
      if (firstRun) {
        rawFieldHints.push(...Object.keys(firstRun).filter(k => !k.startsWith('_')).slice(0, 15));
      }
    }

    const candidateGroupsSample = selectionMethod === 'fallback' 
      ? protectionGroups.slice(0, 10).map(g => ({ id: g.id, name: g.name }))
      : undefined;

    res.json({
      selectedGroup: {
        id: selectedGroup.id,
        name: selectedGroup.name,
        legacyId: selectedGroup.legacyId || undefined,
        oldId: selectedGroup.oldId || undefined
      },
      selectionMethod,
      fallbackUsed: selectionMethod === 'fallback',
      totalRunsReturned,
      replicationSummary,
      sampleRuns,
      rawFieldHints,
      candidateGroupsSample,
      filtersApplied: {
        clusterName,
        jobId: jobId || null,
        entityName: entityName || null,
        numRuns: numRunsInt
      }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
