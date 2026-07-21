const db = require('../db/database');
const { getAuthenticatedClient, fetchProtectionJobs } = require('./cohesityApi');
const logger = require('../utils/logger');

/**
 * Per-workload (environment) protection stats for one cluster, merged from:
 *  - protectionSources/registrationInfo statsByEnv → protected/unprotected
 *    object counts + front-end protected bytes per environment
 *  - stats/consumers (kProtectionRuns) joined to the jobs list → per-job
 *    logical usage and physical (on-disk) consumption per environment
 * Returns [{ environment, protectedCount, unprotectedCount, protectedBytes,
 *            jobCount, logicalBytes, physicalBytes }].
 */
async function fetchWorkloads(cluster) {
  const client = await getAuthenticatedClient(cluster);
  const byEnv = new Map();
  const env = (e) => String(e || 'Unknown').replace(/^k/, '');
  const row = (key) => {
    if (!byEnv.has(key)) {
      byEnv.set(key, {
        environment: key,
        protectedCount: 0, unprotectedCount: 0, protectedBytes: 0,
        jobCount: 0, logicalBytes: 0, physicalBytes: 0,
      });
    }
    return byEnv.get(key);
  };

  const { data: reg } = await client.get(
    '/irisservices/api/v1/public/protectionSources/registrationInfo?allUnderHierarchy=true',
    { timeout: 120000 }
  );
  for (const node of (reg?.rootNodes || [])) {
    for (const s of (node.statsByEnv || [])) {
      const r = row(env(s.environment));
      r.protectedCount += s.protectedCount || 0;
      r.unprotectedCount += s.unprotectedCount || 0;
      r.protectedBytes += s.protectedSize || 0;
    }
  }

  // Per-job consumption; the consumers API has no environment field, so join
  // on job id via the jobs list. Jobs missing from the list (deleted jobs
  // still holding storage) land in 'Unknown'.
  const jobEnv = new Map();
  try {
    for (const j of await fetchProtectionJobs(cluster)) jobEnv.set(j.id, env(j.environment));
  } catch (err) {
    logger.warn(`[Workloads] Jobs list fetch failed for cluster ${cluster.id}: ${err.message}`);
  }
  let cookie = null;
  do {
    const url = '/irisservices/api/v1/public/stats/consumers?consumerType=kProtectionRuns&maxCount=1000' +
      (cookie ? `&paginationCookie=${encodeURIComponent(cookie)}` : '');
    const { data } = await client.get(url, { timeout: 60000 });
    for (const s of (data?.statsList || [])) {
      const r = row(jobEnv.get(s.id) || 'Unknown');
      r.jobCount += 1;
      r.logicalBytes += s.stats?.totalLogicalUsageBytes || 0;
      r.physicalBytes += s.stats?.storageConsumedBytes || 0;
    }
    cookie = data?.paginationCookie || null;
  } while (cookie);

  return [...byEnv.values()];
}

/**
 * Store one snapshot batch for a cluster. Polls run every few minutes but the
 * trend granularity is daily, so today's rows are replaced rather than
 * appended — the table holds one batch per cluster per day.
 */
const insertWorkloadSnapshot = db.transaction((clusterId, rows) => {
  db.prepare(`
    DELETE FROM workload_history
    WHERE cluster_id = ? AND date(captured_at) = date('now')
  `).run(clusterId);
  const stmt = db.prepare(`
    INSERT INTO workload_history
      (cluster_id, environment, protected_count, unprotected_count, protected_bytes,
       job_count, logical_bytes, physical_bytes, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  for (const r of rows) {
    stmt.run(clusterId, r.environment, r.protectedCount, r.unprotectedCount,
      r.protectedBytes, r.jobCount, r.logicalBytes, r.physicalBytes);
  }
});

async function refreshWorkloadsForCluster(cluster) {
  const rows = await fetchWorkloads(cluster);
  insertWorkloadSnapshot(cluster.id, rows);
  return rows.length;
}

/**
 * Latest snapshot per cluster: per-cluster × environment rows plus an
 * estate-wide rollup by environment.
 */
function getWorkloads() {
  const rows = db.prepare(`
    SELECT w.cluster_id, c.name AS cluster_name, w.environment,
           w.protected_count, w.unprotected_count, w.protected_bytes,
           w.job_count, w.logical_bytes, w.physical_bytes, w.captured_at
    FROM workload_history w
    JOIN clusters c ON c.id = w.cluster_id
    JOIN (
      SELECT cluster_id, MAX(captured_at) AS latest
      FROM workload_history GROUP BY cluster_id
    ) t ON t.cluster_id = w.cluster_id AND w.captured_at = t.latest
    ORDER BY c.name, w.environment
  `).all();

  const estate = new Map();
  for (const r of rows) {
    if (!estate.has(r.environment)) {
      estate.set(r.environment, {
        environment: r.environment, clusters: 0, protected_count: 0, unprotected_count: 0,
        protected_bytes: 0, job_count: 0, logical_bytes: 0, physical_bytes: 0,
      });
    }
    const e = estate.get(r.environment);
    e.clusters += 1;
    e.protected_count += r.protected_count || 0;
    e.unprotected_count += r.unprotected_count || 0;
    e.protected_bytes += r.protected_bytes || 0;
    e.job_count += r.job_count || 0;
    e.logical_bytes += r.logical_bytes || 0;
    e.physical_bytes += r.physical_bytes || 0;
  }
  return { rows, estate: [...estate.values()].sort((a, b) => b.protected_bytes - a.protected_bytes) };
}

/**
 * Daily trend series. Snapshots accumulate per poll, so per (day, cluster,
 * environment) only the day's LAST snapshot counts; days are then summed
 * across clusters (or a single cluster when clusterId is given).
 * Returns [{ day, environment, protected_count, protected_bytes,
 *            logical_bytes, physical_bytes }] — one row per day × environment.
 */
function getWorkloadTrends({ clusterId = null, environment = null, days = 90 } = {}) {
  return db.prepare(`
    WITH latest_per_day AS (
      SELECT date(captured_at) AS day, cluster_id, environment,
             protected_count, protected_bytes, logical_bytes, physical_bytes,
             ROW_NUMBER() OVER (
               PARTITION BY date(captured_at), cluster_id, environment
               ORDER BY captured_at DESC
             ) AS rn
      FROM workload_history
      WHERE captured_at >= datetime('now', ?)
        AND (? IS NULL OR cluster_id = ?)
        AND (? IS NULL OR environment = ?)
    )
    SELECT day, environment,
           SUM(protected_count) AS protected_count,
           SUM(protected_bytes) AS protected_bytes,
           SUM(logical_bytes)   AS logical_bytes,
           SUM(physical_bytes)  AS physical_bytes
    FROM latest_per_day WHERE rn = 1
    GROUP BY day, environment
    ORDER BY day, environment
  `).all(`-${days} days`, clusterId, clusterId, environment, environment);
}

/** Force-refresh every cluster, a few at a time. Returns per-cluster results. */
async function refreshAllWorkloads() {
  const clusters = db.prepare('SELECT * FROM clusters').all();
  const results = [];
  const CONCURRENCY = 5;
  for (let i = 0; i < clusters.length; i += CONCURRENCY) {
    const batch = clusters.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(c => refreshWorkloadsForCluster(c)));
    settled.forEach((s, j) => results.push({
      cluster: batch[j].name,
      ok: s.status === 'fulfilled',
      error: s.status === 'rejected' ? s.reason?.message : undefined,
    }));
  }
  return results;
}

module.exports = {
  fetchWorkloads, insertWorkloadSnapshot, refreshWorkloadsForCluster,
  getWorkloads, getWorkloadTrends, refreshAllWorkloads,
};
