// NetBackup AI Advisor, ported from backend/services/advisors/netbackupAdvisor.js.
//
// DEVIATION FROM THE BUILT-IN: the original requires '../platformAdvisor'
// (createPlatformAdvisor/linReg/parseUtcMs/fmtBytes) and '../db/database'
// directly — neither is requirable from a bundled plugin. coreApi exposes
// the exact same module as `coreApi.advisor` (see backend/core/coreApi.js:
// `get advisor() { return require('../services/platformAdvisor'); }`), so
// this ports byte-faithfully by building the advisor off coreApi.advisor and
// coreApi.db instead. gather* functions use coreApi.db in place of the
// host's `db` singleton require, and computeIssues/staleBackupHours come from
// this plugin's own ./issues module (also coreApi-parameterized).
const { computeIssues, staleBackupHours } = require('./issues');

const REPLICATION_TYPES = ['REPLICATION', 'REPLICA', 'DUPLICATE', 'DUPLICATION', 'IMPORT'];
const isFailedJob = (j) => j.state === 'FAILED'
  || (['EXITED', 'DONE'].includes(j.state) && Number(j.status_code || 0) > 0);

function gatherBackupHealth(coreApi) {
  const db = coreApi.db;
  const sourceCount = db.prepare('SELECT COUNT(*) n FROM netbackup_sources').get().n;

  const jobs7d = db.prepare(`
    SELECT j.policy_name, j.policy_type, j.state, j.status_code, s.name AS source_name
    FROM netbackup_jobs j JOIN netbackup_sources s ON s.id = j.source_id
    WHERE j.started_at >= datetime('now', '-7 days')
  `).all();

  const byPolicy = new Map();
  const byState = {};
  for (const j of jobs7d) {
    const state = j.state || 'UNKNOWN';
    byState[state] = (byState[state] || 0) + 1;
    if (!j.policy_name) continue;
    const key = `${j.source_name}|${j.policy_name}`;
    if (!byPolicy.has(key)) {
      byPolicy.set(key, { source: j.source_name, policy: j.policy_name, policyType: j.policy_type, total: 0, failed: 0 });
    }
    const p = byPolicy.get(key);
    p.total += 1;
    if (isFailedJob(j)) p.failed += 1;
  }
  const failingPolicies = [...byPolicy.values()]
    .filter((p) => p.failed > 0)
    .sort((a, b) => (b.failed / b.total) - (a.failed / a.total))
    .slice(0, 20);

  const issues = computeIssues(coreApi);
  const staleClients = issues.filter((i) => i.type === 'stale-backup').slice(0, 20)
    .map((i) => ({ source: i.source, client: i.target, message: i.message }));

  return {
    generatedAt: new Date().toISOString(),
    sourceCount,
    jobStateBreakdown7d: byState,
    failingPolicies,
    staleClients,
    staleBackupThresholdHours: staleBackupHours(coreApi),
    openIssues: issues.map((i) => ({ severity: i.severity, source: i.source, type: i.type, target: i.target, message: i.message })).slice(0, 30),
    note: jobs7d.length === 0 ? 'No jobs recorded in the last 7 days.' : undefined,
  };
}

function gatherCapacityPlanning(coreApi) {
  const db = coreApi.db;
  const { linReg, parseUtcMs, fmtBytes } = coreApi.advisor;
  const sources = db.prepare('SELECT id, name FROM netbackup_sources').all();

  const storageUnits = db.prepare(`
    SELECT u.*, s.name AS source_name FROM netbackup_storage_units u JOIN netbackup_sources s ON s.id = u.source_id
    WHERE u.capacity_bytes > 0
    ORDER BY (CAST(u.free_bytes AS REAL) / u.capacity_bytes) ASC LIMIT 20
  `).all().map((u) => ({
    source: u.source_name, name: u.name,
    freePct: u.free_bytes != null ? +((u.free_bytes / u.capacity_bytes) * 100).toFixed(1) : null,
    free: fmtBytes(u.free_bytes), total: fmtBytes(u.capacity_bytes),
  }));

  const diskPools = db.prepare(`
    SELECT p.*, s.name AS source_name FROM netbackup_disk_pools p JOIN netbackup_sources s ON s.id = p.source_id
    WHERE p.total_capacity_bytes > 0
    ORDER BY (CAST(p.available_capacity_bytes AS REAL) / p.total_capacity_bytes) ASC LIMIT 20
  `).all().map((p) => ({
    source: p.source_name, name: p.name,
    freePct: p.available_capacity_bytes != null ? +((p.available_capacity_bytes / p.total_capacity_bytes) * 100).toFixed(1) : null,
    free: fmtBytes(p.available_capacity_bytes), total: fmtBytes(p.total_capacity_bytes),
  }));

  const history = db.prepare(`
    SELECT source_id, captured_at, storage_used_bytes FROM netbackup_metrics_history
    WHERE captured_at >= datetime('now', '-60 days') AND storage_used_bytes IS NOT NULL
    ORDER BY source_id, captured_at ASC
  `).all();
  const bySource = new Map();
  for (const r of history) {
    if (!bySource.has(r.source_id)) bySource.set(r.source_id, []);
    bySource.get(r.source_id).push(r);
  }
  const trend = sources.map((s) => {
    const series = bySource.get(s.id) || [];
    const pts = series.map((r) => ({ x: parseUtcMs(r.captured_at), y: r.storage_used_bytes }));
    const reg = linReg(pts);
    const growthPerDay = reg ? reg.slope * 86400000 : 0;
    return { source: s.name, growthPerDay: growthPerDay > 0 ? `${fmtBytes(growthPerDay)}/day` : 'flat/declining', dataPoints: series.length };
  });

  const workloadRows = db.prepare(`
    SELECT w.source_id, w.workload, w.protected_bytes
    FROM netbackup_workload_history w
    JOIN (SELECT source_id, MAX(captured_at) AS latest FROM netbackup_workload_history GROUP BY source_id) t
      ON t.source_id = w.source_id AND w.captured_at = t.latest
  `).all();
  const byWorkload = new Map();
  for (const r of workloadRows) {
    byWorkload.set(r.workload, (byWorkload.get(r.workload) || 0) + (r.protected_bytes || 0));
  }
  const fetbByWorkload = [...byWorkload.entries()]
    .map(([workload, bytes]) => ({ workload, frontEndTb: +(bytes / 1e12).toFixed(2) }))
    .sort((a, b) => b.frontEndTb - a.frontEndTb);

  return {
    generatedAt: new Date().toISOString(),
    lowFreeStorageUnits: storageUnits,
    lowFreeDiskPools: diskPools,
    storageGrowthTrend: trend,
    frontEndBytesByWorkload: fetbByWorkload,
    note: sources.length === 0 ? 'No NetBackup sources registered.' : undefined,
  };
}

function gatherResilienceReview(coreApi) {
  const db = coreApi.db;
  const sources = db.prepare('SELECT id, name FROM netbackup_sources').all();

  const replicationJobs = db.prepare(`
    SELECT j.source_id, j.policy_name, j.state, j.status_code
    FROM netbackup_jobs j
    WHERE UPPER(j.job_type) IN (${REPLICATION_TYPES.map(() => '?').join(',')})
      AND j.started_at >= datetime('now', '-7 days')
  `).all(...REPLICATION_TYPES);
  let repOk = 0; let repFailed = 0;
  for (const j of replicationJobs) { if (isFailedJob(j)) repFailed += 1; else repOk += 1; }

  const catalogRow = db.prepare(`
    SELECT j.source_id, s.name AS source_name, MAX(j.started_at) AS last_success
    FROM netbackup_jobs j JOIN netbackup_sources s ON s.id = j.source_id
    WHERE j.policy_type = 'NBU-Catalog' AND j.state NOT IN ('FAILED')
      AND NOT (j.state IN ('EXITED', 'DONE') AND COALESCE(j.status_code, 0) > 0)
    GROUP BY j.source_id ORDER BY last_success DESC LIMIT 1
  `).get();
  const catalogBackup = catalogRow ? {
    source: catalogRow.source_name,
    lastSuccessAt: catalogRow.last_success,
    ageHours: +((Date.now() - new Date(catalogRow.last_success).getTime()) / 3600000).toFixed(1),
  } : null;

  const mediaServers = db.prepare(`
    SELECT m.name, m.state, m.version, s.name AS source_name FROM netbackup_media_servers m
    JOIN netbackup_sources s ON s.id = m.source_id
  `).all();
  const appliances = db.prepare(`
    SELECT a.name, a.nbu_version, s.name AS source_name FROM netbackup_appliances a
    JOIN netbackup_sources s ON s.id = a.source_id
  `).all();

  const policies = db.prepare(`
    SELECT p.source_id, p.name, s.name AS source_name FROM netbackup_policies p
    JOIN netbackup_sources s ON s.id = p.source_id WHERE p.active = 1
  `).all();
  const replicatedPolicySet = new Set(db.prepare(`
    SELECT DISTINCT source_id, policy_name FROM netbackup_jobs
    WHERE UPPER(job_type) IN (${REPLICATION_TYPES.map(() => '?').join(',')})
  `).all(...REPLICATION_TYPES).map((r) => `${r.source_id}|${r.policy_name}`));
  const singleCopyPolicies = policies
    .filter((p) => !replicatedPolicySet.has(`${p.source_id}|${p.name}`))
    .map((p) => ({ source: p.source_name, policy: p.name }))
    .slice(0, 30);

  return {
    generatedAt: new Date().toISOString(),
    replicationOutcomes7d: { ok: repOk, failed: repFailed },
    catalogBackup,
    mediaServers: mediaServers.map((m) => ({ source: m.source_name, name: m.name, state: m.state, version: m.version })),
    appliances: appliances.map((a) => ({ source: a.source_name, name: a.name, version: a.nbu_version })),
    singleCopyPolicies,
    note: sources.length === 0 ? 'No NetBackup sources registered.' : undefined,
  };
}

let cached = null;

/** Lazily builds (and caches) the platform advisor bound to this coreApi. */
function get(coreApi) {
  if (cached) return cached;
  cached = coreApi.advisor.createPlatformAdvisor({
    platform: 'netbackup',
    feature: 'NetBackup AI Advisor',
    table: 'netbackup_ai_reports',
    reports: {
      backup_health: {
        system:
          'You are a Veritas NetBackup operations engineer. You are given 7-day job state totals, the policies with the ' +
          'highest failure rates, stale clients with no recent successful backup, and open computed issues. Identify ' +
          'systemic themes vs isolated incidents and give a prioritized remediation plan. Do not invent data. Markdown ' +
          'sections: **Summary**, **Failing policies**, **Stale clients**, **Recommended actions**. Keep under ~400 words.',
        gather: () => gatherBackupHealth(coreApi),
        noun: 'backup health review',
      },
      capacity_planning: {
        system:
          'You are a Veritas NetBackup capacity planner. You are given storage units/disk pools with the least free ' +
          'space, modeled per-source storage growth from historical snapshots, and front-end protected TB by workload. ' +
          'Produce a capacity plan: identify storage needing attention soonest, flag anomalous growth, and note which ' +
          'workloads are driving the most front-end capacity. Do not invent data; if growth history is thin, say so. ' +
          'Markdown sections: **Summary**, **Needs attention (soonest first)**, **Workload capacity drivers**, ' +
          '**Recommended actions**. Keep under ~400 words.',
        gather: () => gatherCapacityPlanning(coreApi),
        noun: 'capacity plan',
      },
      resilience_review: {
        system:
          'You are a Veritas NetBackup resilience/DR reviewer. You are given 7-day SLP/replication job outcomes, the ' +
          'catalog backup age, media server and appliance states/versions, and active policies with no replication ' +
          'copy (single points of failure). Identify resilience gaps and give a prioritized plan. Do not invent data. ' +
          'Markdown sections: **Summary**, **Resilience gaps**, **Recommended actions**. Keep under ~350 words.',
        gather: () => gatherResilienceReview(coreApi),
        noun: 'resilience review',
      },
    },
  });
  return cached;
}

module.exports = { get };
