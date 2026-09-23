const express = require('express');
const { query, validationResult } = require('express-validator');
const db = require('../db/database');
const { listProtectionGroupsV2, getProtectionGroupRunsV2, getAuthenticatedClient } = require('../services/cohesityApi');
const { isDemo } = require('../services/demoMode');
const { tenantMap } = require('../core/tenantScoped');

const router = express.Router();

const replicationCache = tenantMap();
const CACHE_TTL_MS = 15 * 60 * 1000;

// One unfiltered scan per cluster/window is cached; status filters, search,
// sort and paging are applied when a page is read. A CG cluster holds 3,000+
// rows in one window, so the browser only ever receives one page.
const SCAN_FILTER = 'all';

// Rows needing attention sort above finished ones. Running first, then the
// runs that did not complete, then successes.
const STATUS_RANK = { Running: 0, Failed: 1, Canceled: 2, Skipped: 3, Succeeded: 4 };
const STATUS_FILTERS = ['all', 'active', 'running', 'failed', 'canceled', 'skipped', 'succeeded'];
const SORT_KEYS = ['default', 'jobName', 'targetCluster', 'status', 'startTime', 'queued', 'duration', 'dataToSend', 'dataSent', 'percentComplete'];
const PAGE_SIZE_MAX = 200;

function statusRank(status) {
  const r = STATUS_RANK[status];
  return r === undefined ? 5 : r;
}

// Seconds a replication took, or has been running so far.
function durationSeconds(rep, nowUsecs) {
  if (!rep.replicationStartTimeUsecs) return null;
  const end = rep.endTimeUsecs || (rep.status === 'Running' ? nowUsecs : null);
  if (!end) return null;
  return Math.max(0, Math.round((end - rep.replicationStartTimeUsecs) / 1e6));
}

// Seconds a task waited in the queue before it started moving data.
function queueSeconds(rep) {
  if (!rep.queuedTimeUsecs || !rep.replicationStartTimeUsecs) return null;
  return Math.max(0, Math.round((rep.replicationStartTimeUsecs - rep.queuedTimeUsecs) / 1e6));
}

function summarize(replications, nowUsecs) {
  const byStatus = {};
  const byTarget = {};
  let logical = 0;
  let physical = 0;
  let longest = null;
  for (const rep of replications) {
    byStatus[rep.status] = (byStatus[rep.status] || 0) + 1;
    logical += rep.logicalBytesTransferred || 0;
    physical += rep.physicalBytesTransferred || 0;
    const key = rep.targetCluster || 'unknown';
    if (!byTarget[key]) byTarget[key] = { targetCluster: key, total: 0, running: 0, failed: 0, succeeded: 0, logicalBytesTransferred: 0, physicalBytesTransferred: 0 };
    const t = byTarget[key];
    t.total++;
    if (rep.status === 'Running') t.running++;
    else if (rep.status === 'Succeeded') t.succeeded++;
    else t.failed++;
    t.logicalBytesTransferred += rep.logicalBytesTransferred || 0;
    t.physicalBytesTransferred += rep.physicalBytesTransferred || 0;
    if (rep.status === 'Running') {
      const secs = durationSeconds(rep, nowUsecs);
      if (secs != null && (!longest || secs > longest.seconds)) {
        longest = { seconds: secs, jobName: rep.jobName, targetCluster: rep.targetCluster, percentComplete: rep.percentComplete };
      }
    }
  }
  return {
    total: replications.length,
    running: byStatus.Running || 0,
    succeeded: byStatus.Succeeded || 0,
    failed: byStatus.Failed || 0,
    canceled: byStatus.Canceled || 0,
    skipped: byStatus.Skipped || 0,
    byStatus,
    logicalBytesTransferred: logical,
    physicalBytesTransferred: physical,
    groupsWithReplication: new Set(replications.map(r => r.protectionGroupId)).size,
    longestRunning: longest,
    byTarget: Object.values(byTarget).sort((a, b) => b.total - a.total)
  };
}

function applyFilter(replications, statusFilter, q) {
  let list = replications;
  const f = statusFilter === 'active' ? 'running' : statusFilter;
  if (f && f !== 'all') {
    const want = f.charAt(0).toUpperCase() + f.slice(1);
    list = list.filter(r => r.status === want);
  }
  if (q) {
    const needle = q.toLowerCase();
    list = list.filter(r =>
      String(r.jobName || '').toLowerCase().includes(needle) ||
      String(r.targetCluster || '').toLowerCase().includes(needle));
  }
  return list;
}

function sortList(replications, sortBy, sortDir, nowUsecs) {
  const dir = sortDir === 'asc' ? 1 : -1;
  const text = (v) => String(v || '').toLowerCase();
  const num = (v) => (v == null ? -1 : v);
  const byStart = (a, b) => (b.replicationStartTimeUsecs || 0) - (a.replicationStartTimeUsecs || 0);
  const cmp = {
    default: (a, b) => statusRank(a.status) - statusRank(b.status) || byStart(a, b),
    status: (a, b) => dir * (statusRank(a.status) - statusRank(b.status)) || byStart(a, b),
    jobName: (a, b) => dir * text(a.jobName).localeCompare(text(b.jobName)) || byStart(a, b),
    targetCluster: (a, b) => dir * text(a.targetCluster).localeCompare(text(b.targetCluster)) || byStart(a, b),
    startTime: (a, b) => dir * ((a.replicationStartTimeUsecs || 0) - (b.replicationStartTimeUsecs || 0)),
    queued: (a, b) => dir * (num(queueSeconds(a)) - num(queueSeconds(b))) || byStart(a, b),
    duration: (a, b) => dir * (num(durationSeconds(a, nowUsecs)) - num(durationSeconds(b, nowUsecs))) || byStart(a, b),
    dataToSend: (a, b) => dir * (num(a.logicalSizeBytes) - num(b.logicalSizeBytes)) || byStart(a, b),
    dataSent: (a, b) => dir * (num(a.logicalBytesTransferred) - num(b.logicalBytesTransferred)) || byStart(a, b),
    percentComplete: (a, b) => dir * (num(a.percentComplete) - num(b.percentComplete)) || byStart(a, b)
  };
  return [...replications].sort(cmp[sortBy] || cmp.default);
}

// Shape one response from a cached scan payload: summary over the whole
// window, then filter, sort and slice for the requested page.
function shapeResponse(payload, opts, scanning, cacheAgeSeconds) {
  const nowUsecs = Date.now() * 1000;
  const all = Array.isArray(payload.replications) ? payload.replications : [];
  const filtered = applyFilter(all, opts.statusFilter, opts.q);
  const sorted = sortList(filtered, opts.sortBy, opts.sortDir, nowUsecs);
  const totalPages = Math.max(1, Math.ceil(sorted.length / opts.pageSize));
  const page = Math.min(opts.page, totalPages - 1);
  const rows = sorted.slice(page * opts.pageSize, (page + 1) * opts.pageSize)
    .map(r => ({ ...r, durationSeconds: durationSeconds(r, nowUsecs), queueSeconds: queueSeconds(r) }));
  return {
    sourceCluster: payload.sourceCluster,
    generatedAt: payload.generatedAt,
    totalGroupsScanned: payload.totalGroupsScanned || 0,
    groupsWithActiveReplication: payload.groupsWithActiveReplication || 0,
    scanning,
    cacheAgeSeconds,
    summary: summarize(all, nowUsecs),
    page: { page, pageSize: opts.pageSize, total: sorted.length, totalPages },
    replications: rows
  };
}

function emptyPayload(clusterName) {
  return {
    sourceCluster: clusterName,
    generatedAt: new Date().toISOString(),
    totalGroupsScanned: 0,
    groupsWithActiveReplication: 0,
    replications: []
  };
}

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
function upsertCacheToDb(cacheKey, clusterName, days, numRunsPerGroup, payload, scanning, error) {
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
    ).run(cacheKey, clusterName, SCAN_FILTER, days, numRunsPerGroup, payloadJson, scanning ? 1 : 0, error || null);
  } catch (err) {
    console.error('Error upserting cache to DB:', err.message);
  }
}

async function runBackgroundScan(cluster, cacheKey, days, numRunsPerGroup) {
  try {
    let protectionGroups = [];
    try {
      protectionGroups = await listProtectionGroupsV2(cluster);
    } catch (err) {
      replicationCache.set(cacheKey, { ...replicationCache.get(cacheKey), scanning: false, error: err.message });
      // Persist early failure to DB, preserving existing payload if present
      const existing = readCacheFromDb(cacheKey);
      const existingPayload = existing?.payload || {};
      upsertCacheToDb(cacheKey, cluster.name, days, numRunsPerGroup, existingPayload, false, err.message);
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
              message: target.message || null,
              replicationStartTimeUsecs: target.startTimeUsecs,
              queuedTimeUsecs: target.queuedTimeUsecs || null,
              endTimeUsecs: target.endTimeUsecs || null,
              expiryTimeUsecs: target.expiryTimeUsecs || null,
              logicalSizeBytes: target.stats?.logicalSizeBytes,
              logicalBytesTransferred: target.stats?.logicalBytesTransferred,
              physicalBytesTransferred: target.stats?.physicalBytesTransferred,
              percentageCompleted: target.percentageCompleted ?? null,
              percentComplete
            });
          });
        });
      });
    }

    const groupsWithActiveReplication = new Set(replications.map(r => r.protectionGroupId)).size;

    const scanResult = {
      sourceCluster: cluster.name,
      generatedAt: new Date().toISOString(),
      totalGroupsScanned,
      groupsWithActiveReplication,
      replications
    };

    replicationCache.set(cacheKey, { data: scanResult, timestamp: Date.now(), scanning: false, error: null });
    upsertCacheToDb(cacheKey, cluster.name, days, numRunsPerGroup, scanResult, false, null);
  } catch (err) {
    const current = replicationCache.get(cacheKey);
    replicationCache.set(cacheKey, { ...current, scanning: false, error: err.message });
    // Preserve existing payload from DB on failure; only use empty object if no prior payload exists
    const existing = readCacheFromDb(cacheKey);
    const existingPayload = existing?.payload || {};
    upsertCacheToDb(cacheKey, cluster.name, days, numRunsPerGroup, existingPayload, false, err.message);
  }
}

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

/**
 * GET /api/cohesity/replication/status
 * Query params:
 *  - clusterName (required): source cluster name
 *  - statusFilter (optional, default 'all'): all | running | failed | canceled | skipped | succeeded
 *    ('active' is accepted as an alias of running)
 *  - q (optional): case-insensitive match on job name or target cluster
 *  - days (optional, default 7, max 90): days back to look
 *  - numRunsPerGroup (optional, default 20, max 200): runs per protection group
 *  - sortBy (optional, default 'default'): default | jobName | targetCluster | status | startTime |
 *    queued | duration | dataToSend | dataSent | percentComplete. 'default' is running, then failed,
 *    canceled, skipped, succeeded, newest first inside each.
 *  - sortDir (optional, default 'desc')
 *  - page (optional, default 0), pageSize (optional, default 50, max 200)
 * The summary covers the whole window; replications is one page.
 */
router.get(
  '/status',
  [
    query('clusterName').trim().notEmpty().withMessage('clusterName is required'),
    query('statusFilter')
      .optional({ checkFalsy: true })
      .isIn(STATUS_FILTERS)
      .withMessage(`statusFilter must be one of ${STATUS_FILTERS.join(', ')}`),
    query('q').optional({ checkFalsy: true }).isString().isLength({ max: 200 }).withMessage('q too long'),
    query('days')
      .optional({ checkFalsy: true })
      .isInt({ min: 1, max: 90 })
      .withMessage('days must be 1-90'),
    query('numRunsPerGroup')
      .optional({ checkFalsy: true })
      .isInt({ min: 1, max: 200 })
      .withMessage('numRunsPerGroup must be 1-200'),
    query('sortBy').optional({ checkFalsy: true }).isIn(SORT_KEYS).withMessage(`sortBy must be one of ${SORT_KEYS.join(', ')}`),
    query('sortDir').optional({ checkFalsy: true }).isIn(['asc', 'desc']).withMessage('sortDir must be asc or desc'),
    query('page').optional({ checkFalsy: true }).isInt({ min: 0 }).withMessage('page must be >= 0'),
    query('pageSize').optional({ checkFalsy: true }).isInt({ min: 1, max: PAGE_SIZE_MAX }).withMessage(`pageSize must be 1-${PAGE_SIZE_MAX}`)
  ],
  validate,
  async (req, res, next) => {
    const clusterName = req.query.clusterName;
    const days = parseInt(req.query.days) || 7;
    const numRunsPerGroup = parseInt(req.query.numRunsPerGroup) || 20;
    const opts = {
      statusFilter: req.query.statusFilter || 'all',
      q: String(req.query.q || '').trim(),
      sortBy: req.query.sortBy || 'default',
      sortDir: req.query.sortDir || 'desc',
      page: parseInt(req.query.page) || 0,
      pageSize: parseInt(req.query.pageSize) || 50
    };

    const cluster = db.prepare(
      'SELECT * FROM clusters WHERE LOWER(name) = LOWER(?)'
    ).get(clusterName);

    if (!cluster) {
      return res.status(404).json({ error: 'Cluster not found', clusterName });
    }

    const cacheKey = `${clusterName}:${SCAN_FILTER}:${days}:${numRunsPerGroup}`;
    const now = Date.now();

    // Try to read from DB cache first (authoritative source)
    const dbCached = readCacheFromDb(cacheKey);

    // Demo mode: serve whatever cache row exists (however stale) and never
    // kick off a live background scan.
    if (isDemo()) {
      if (dbCached && dbCached.payload && dbCached.payload.replications) {
        const age = Math.round((now - dbCached.updatedAt) / 1000);
        return res.json(shapeResponse(dbCached.payload, opts, false, age));
      }
      return res.json(shapeResponse(emptyPayload(clusterName), opts, false, null));
    }

    // Determine if cache is expired
    const dbCacheExpired = !dbCached || (now - dbCached.updatedAt > CACHE_TTL_MS);

    // If DB cache is expired or missing, trigger background scan
    if (dbCacheExpired) {
      const memCached = replicationCache.get(cacheKey);
      replicationCache.set(cacheKey, { ...(memCached || {}), scanning: true });
      // Persist scanning state to DB, preserving existing payload if present
      const existingPayload = dbCached?.payload || {};
      upsertCacheToDb(cacheKey, clusterName, days, numRunsPerGroup, existingPayload, true, null);
      runBackgroundScan(cluster, cacheKey, days, numRunsPerGroup);
    }

    // Check in-memory cache for in-flight scan status (read after potential update above)
    const memCached = replicationCache.get(cacheKey);

    // Return cached data if available (prefer DB cache)
    if (dbCached && dbCached.payload && dbCached.payload.replications) {
      const age = Math.round((now - dbCached.updatedAt) / 1000);
      const scanning = dbCached.scanning || (memCached && memCached.scanning) || false;
      return res.json(shapeResponse(dbCached.payload, opts, scanning, age));
    }

    // No cache yet, return empty response with scanning flag
    return res.json(shapeResponse(emptyPayload(clusterName), opts, true, null));
  }
);

module.exports = router;
