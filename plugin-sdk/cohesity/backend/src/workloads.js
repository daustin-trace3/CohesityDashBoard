// Cohesity per-workload protection stats, ported from backend/services/
// workloads.js. Contract file for poller.js's optional './workloads' require
// (see poller.js header) — exports fetchWorkloads(cluster, coreApi) and
// insertWorkloadSnapshot(clusterId, rows, coreApi) with those exact
// signatures so the per-cluster poller picks this up automatically.
const api = require('./api');

async function fetchWorkloads(cluster, coreApi) {
  const client = await api.getAuthenticatedClient(cluster, coreApi);
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

  const jobEnv = new Map();
  try {
    for (const j of await api.fetchProtectionJobs(cluster, coreApi)) jobEnv.set(j.id, env(j.environment));
  } catch (err) {
    coreApi.logger.warn(`[Workloads] Jobs list fetch failed for cluster ${cluster.id}: ${err.message}`);
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

function insertWorkloadSnapshot(clusterId, rows, coreApi) {
  const db = coreApi.db;
  const tx = db.transaction((clusterId, rows) => {
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
    const v = db.prepare(`
      SELECT COUNT(*) AS total,
             COALESCE(SUM(v.protected), 0) AS prot,
             COALESCE(SUM(CASE WHEN v.protected = 1 THEN v.logical_bytes END), 0) AS prot_logical,
             COALESCE(SUM(v.logical_bytes), 0) AS logical,
             COALESCE(SUM(v.consumed_bytes), 0) AS physical
      FROM cohesity_views v
      JOIN clusters c ON c.name = v.system_name
      WHERE c.id = ?
    `).get(clusterId);
    if (v.total > 0) {
      stmt.run(clusterId, 'Views', v.prot, v.total - v.prot, v.prot_logical, null, v.logical, v.physical);
    }
  });
  tx(clusterId, rows);
}

async function refreshWorkloadsForCluster(cluster, coreApi) {
  const rows = await fetchWorkloads(cluster, coreApi);
  insertWorkloadSnapshot(cluster.id, rows, coreApi);
  return rows.length;
}

function getWorkloads(coreApi) {
  const db = coreApi.db;
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

function getWorkloadTrends(coreApi, { clusterId = null, environment = null, days = 90 } = {}) {
  return coreApi.db.prepare(`
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

async function refreshAllWorkloads(coreApi) {
  const clusters = coreApi.db.prepare('SELECT * FROM clusters').all();
  const results = [];
  const CONCURRENCY = 5;
  for (let i = 0; i < clusters.length; i += CONCURRENCY) {
    const batch = clusters.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(c => refreshWorkloadsForCluster(c, coreApi)));
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
