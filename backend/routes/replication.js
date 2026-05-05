const express = require('express');
const { query, validationResult } = require('express-validator');
const db = require('../db/database');
const { listProtectionGroupsV2, getProtectionGroupRunsV2, getAuthenticatedClient } = require('../services/cohesityApi');

const router = express.Router();

const replicationCache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Read replication status cache from database by cache_key.
 * Returns parsed payload_json and metadata, or null if not found.
 */
function readCacheFromDb(cacheKey) {
  try {
    const row = db.prepare(
      'SELECT cache_key, cluster_name, status_filter, days, num_runs_per_group, payload_json, scanning, error, updated_at FROM replication_status_cache WHERE cache_key = ?'
    ).get(cacheKey);

    if (!row) return null;

    return {
      cacheKey: row.cache_key,
      clusterName: row.cluster_name,
      statusFilter: row.status_filter,
      days: row.days,
      numRunsPerGroup: row.num_runs_per_group,
      payload: JSON.parse(row.payload_json),
      scanning: row.scanning === 1,
      error: row.error,
      updatedAt: new Date(row.updated_at).getTime()
    };
  } catch (err) {
    console.error('Error reading cache from DB:', err.message);
    return null;
  }
}

/**
 * Upsert replication status cache to database.
 * payload should be the scan result object (sourceCluster, generatedAt, etc).
 */
function upsertCacheToDb(cacheKey, clusterName, statusFilter, days, numRunsPerGroup, payload, scanning, error) {
  try {
    const payloadJson = JSON.stringify(payload);
    db.prepare(
      `INSERT INTO replication_status_cache 
       (cache_key, cluster_name, status_filter, days, num_runs_per_group, payload_json, scanning, error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(cache_key) DO UPDATE SET
         payload_json = excluded.payload_json,
         scanning = excluded.scanning,
         error = excluded.error,
         updated_at = CURRENT_TIMESTAMP`
    ).run(cacheKey, clusterName, statusFilter, days, numRunsPerGroup, payloadJson, scanning ? 1 : 0, error || null);
  } catch (err) {
    console.error('Error upserting cache to DB:', err.message);
  }
}

async function runBackgroundScan(cluster, cacheKey, statusFilter, days, numRunsPerGroup) {
  try {
    let protectionGroups = [];
    try {
      protectionGroups = await listProtectionGroupsV2(cluster);
    } catch (err) {
      replicationCache.set(cacheKey, { ...replicationCache.get(cacheKey), scanning: false, error: err.message });
      // Persist early failure to DB, preserving existing payload if present
      const existing = readCacheFromDb(cacheKey);
      const existingPayload = existing?.payload || {};
      upsertCacheToDb(cacheKey, cluster.name, statusFilter, days, numRunsPerGroup, existingPayload, false, err.message);
      return;
    }

    const now = Date.now() * 1000;
    const startTimeUsecs = now - days * 86400 * 1e6;
    const endTimeUsecs = now;
    const BATCH_SIZE = 20;
    const replications = [];
    const totalGroupsScanned = protectionGroups.length;

    for (let i = 0; i < protectionGroups.length; i += BATCH_SIZE) {
      const batch = protectionGroups.slice(i, i + BATCH_SIZE);
      const promises = batch.map(group =>
        getProtectionGroupRunsV2(cluster, group.id, {
          startTimeUsecs,
          endTimeUsecs,
          numRuns: numRunsPerGroup
        }).catch(() => [])
      );

      const results = await Promise.allSettled(promises);

      results.forEach((result, idx) => {
        if (result.status === 'rejected') return;
        const runs = result.value || [];
        const group = batch[idx];

        runs.forEach(run => {
          if (!run.replicationInfo || !run.replicationInfo.replicationTargetResults) return;
          run.replicationInfo.replicationTargetResults.forEach(target => {
            if (statusFilter === 'active' && target.status !== 'Running') return;
            if (statusFilter === 'failed' && target.status !== 'Failed') return;

            let percentComplete = null;
            if (target.status === 'Succeeded') {
              percentComplete = 100;
            } else if (target.stats && target.stats.logicalSizeBytes && target.stats.logicalSizeBytes > 0) {
              const transferred = target.stats.logicalBytesTransferred || 0;
              percentComplete = Math.round((transferred / target.stats.logicalSizeBytes) * 10000) / 100;
            }

            replications.push({
              jobName: group.name,
              protectionGroupId: group.id,
              runId: run.id,
              runStartTimeUsecs: run.localBackupInfo?.startTimeUsecs,
              localBackupStatus: run.localBackupInfo?.status,
              targetCluster: target.clusterName,
              status: target.status,
              replicationStartTimeUsecs: target.startTimeUsecs,
              logicalSizeBytes: target.stats?.logicalSizeBytes,
              logicalBytesTransferred: target.stats?.logicalBytesTransferred,
              physicalBytesTransferred: target.stats?.physicalBytesTransferred,
              percentComplete
            });
          });
        });
      });
    }

    const groupsWithActiveReplication = new Set(replications.map(r => r.protectionGroupId)).size;
    replications.sort((a, b) => {
      const aPercent = a.percentComplete ?? -1;
      const bPercent = b.percentComplete ?? -1;
      if (aPercent !== bPercent) return bPercent - aPercent;
      return (b.replicationStartTimeUsecs || 0) - (a.replicationStartTimeUsecs || 0);
    });

    const scanResult = {
      sourceCluster: cluster.name,
      generatedAt: new Date().toISOString(),
      totalGroupsScanned,
      groupsWithActiveReplication,
      replications
    };

    replicationCache.set(cacheKey, { data: scanResult, timestamp: Date.now(), scanning: false, error: null });
    upsertCacheToDb(cacheKey, cluster.name, statusFilter, days, numRunsPerGroup, scanResult, false, null);
  } catch (err) {
    const current = replicationCache.get(cacheKey);
    replicationCache.set(cacheKey, { ...current, scanning: false, error: err.message });
    // Preserve existing payload from DB on failure; only use empty object if no prior payload exists
    const existing = readCacheFromDb(cacheKey);
    const existingPayload = existing?.payload || {};
    upsertCacheToDb(cacheKey, cluster.name, statusFilter, days, numRunsPerGroup, existingPayload, false, err.message);
  }
}

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

/**
 * GET /api/replication/status
 * Query params:
 *  - clusterName (required): source cluster name
 *  - statusFilter (optional, default 'all'): 'active' | 'failed' | 'all'
 *  - days (optional, default 7, max 90): days back to look
 *  - numRunsPerGroup (optional, default 20, max 200): runs per protection group
 */
router.get(
  '/status',
  [
    query('clusterName').trim().notEmpty().withMessage('clusterName is required'),
    query('statusFilter')
      .optional({ checkFalsy: true })
      .isIn(['active', 'failed', 'all'])
      .withMessage('statusFilter must be active, failed, or all'),
    query('days')
      .optional({ checkFalsy: true })
      .isInt({ min: 1, max: 90 })
      .withMessage('days must be 1-90'),
    query('numRunsPerGroup')
      .optional({ checkFalsy: true })
      .isInt({ min: 1, max: 200 })
      .withMessage('numRunsPerGroup must be 1-200')
  ],
  validate,
  async (req, res, next) => {
    const clusterName = req.query.clusterName;
    const statusFilter = req.query.statusFilter || 'all';
    const days = parseInt(req.query.days) || 7;
    const numRunsPerGroup = parseInt(req.query.numRunsPerGroup) || 20;

    const cluster = db.prepare(
      'SELECT * FROM clusters WHERE LOWER(name) = LOWER(?)'
    ).get(clusterName);

    if (!cluster) {
      return res.status(404).json({ error: 'Cluster not found', clusterName });
    }

    const cacheKey = `${clusterName}:${statusFilter}:${days}:${numRunsPerGroup}`;
    const now = Date.now();

    // Try to read from DB cache first (authoritative source)
    const dbCached = readCacheFromDb(cacheKey);
    
    // Determine if cache is expired
    const dbCacheExpired = !dbCached || (now - dbCached.updatedAt > CACHE_TTL_MS);
    
    // If DB cache is expired or missing, trigger background scan
    if (dbCacheExpired) {
      const memCached = replicationCache.get(cacheKey);
      replicationCache.set(cacheKey, { ...(memCached || {}), scanning: true });
      // Persist scanning state to DB, preserving existing payload if present
      const existingPayload = dbCached?.payload || {};
      upsertCacheToDb(cacheKey, clusterName, statusFilter, days, numRunsPerGroup, existingPayload, true, null);
      runBackgroundScan(cluster, cacheKey, statusFilter, days, numRunsPerGroup);
    }

    // Check in-memory cache for in-flight scan status (read after potential update above)
    const memCached = replicationCache.get(cacheKey);

    // Return cached data if available (prefer DB cache)
    if (dbCached && dbCached.payload && dbCached.payload.replications) {
      const age = Math.round((now - dbCached.updatedAt) / 1000);
      return res.json({ 
        ...dbCached.payload, 
        scanning: dbCached.scanning || (memCached && memCached.scanning) || false, 
        cacheAgeSeconds: age 
      });
    }

    // No cache yet, return empty response with scanning flag
    return res.json({
      sourceCluster: clusterName,
      generatedAt: new Date().toISOString(),
      totalGroupsScanned: 0,
      groupsWithActiveReplication: 0,
      replications: [],
      scanning: true,
      cacheAgeSeconds: null
    });
  }
);

module.exports = router;
