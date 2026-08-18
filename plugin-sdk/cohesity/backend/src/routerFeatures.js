// Cohesity FEATURES-PLANE route table (bare-router, compile.js format — same
// shape as WP-A's routerData.js; index.js appends these after the data-plane
// routes). Ports, with IDENTICAL paths/status codes/JSON shapes (mounted at
// /api/cohesity/* in the built-in per backend/app.js:192-203):
//   backend/routes/licensing.js, views.js, workloads.js, backupHistory.js,
//   cohesityObject360.js, gflags.js, governance.js, insights.js, advisor.js
const { compile } = require('./compile');
const {
  parseIntStrict, isNonEmptyString, isBooleanish, toBool, parseQueryInt,
} = require('./validate');

const licensing = require('./licensing');
const views = require('./views');
const workloads = require('./workloads');
const gflags = require('./gflags');
const { computeInsights } = require('./insights');
const { createCohesityAdvisor } = require('./advisor');

function badReq(res, items) {
  res.status(400).json({ errors: items });
}
function vfail(path, msg = 'Invalid value') {
  return { msg, path };
}
function reqIntParam(req, res, name = 'id') {
  const v = parseIntStrict(req.params[name]);
  if (!Number.isInteger(v) || v < 1) {
    badReq(res, [vfail(name)]);
    return null;
  }
  return v;
}

// ── licensing ────────────────────────────────────────────────────────────

function handleGetLicensing(req, res, coreApi) {
  res.json(licensing.getLicensing(coreApi));
}

function handleGetLicensingViews(req, res, coreApi) {
  const systemId = req.params.systemId;
  if (typeof systemId !== 'string' || systemId.length > 64) {
    return badReq(res, [vfail('systemId')]);
  }
  res.json(licensing.getViewDetail(systemId, coreApi));
}

async function handlePostLicensingRefresh(req, res, coreApi) {
  const result = await licensing.refreshLicensing(coreApi);
  if (!result.ok) {
    const error = result.reason === 'no_key'
      ? 'Licensing data is unavailable — the Helios API key is not configured (Settings → Credentials).'
      : 'Licensing refresh failed — Helios returned no data. Previous figures kept.';
    return res.status(503).json({ error });
  }
  res.json({ ...licensing.getLicensing(coreApi), refreshFailedSources: result.failed || [] });
}

// ── views ────────────────────────────────────────────────────────────────

function handleGetViews(req, res, coreApi) {
  res.json(views.getViews(coreApi));
}

async function handlePostViewsRefresh(req, res, coreApi) {
  const result = await views.refreshViews(coreApi);
  if (!result.ok) {
    const error = result.reason === 'no_key'
      ? 'Views data is unavailable — the Helios API key is not configured (Settings → Credentials).'
      : 'Views refresh failed — Helios returned no data. Previous inventory kept.';
    return res.status(503).json({ error });
  }
  res.json(views.getViews(coreApi));
}

// ── workloads ────────────────────────────────────────────────────────────

function handleGetWorkloads(req, res, coreApi) {
  res.json(workloads.getWorkloads(coreApi));
}

function handleGetWorkloadTrends(req, res, coreApi) {
  const errors = [];
  let clusterId, environment, days;
  if (req.query.clusterId !== undefined) {
    const r = parseQueryInt(req.query.clusterId, 1);
    if (!r.ok) errors.push(vfail('clusterId'));
    else clusterId = r.value;
  }
  if (req.query.environment !== undefined) {
    if (!isNonEmptyString(req.query.environment, 64)) errors.push(vfail('environment'));
    else environment = req.query.environment;
  }
  if (req.query.days !== undefined) {
    const r = parseQueryInt(req.query.days, 7, 730);
    if (!r.ok) errors.push(vfail('days'));
    else days = r.value;
  }
  if (errors.length) return res.status(400).json({ error: 'Invalid parameters', details: errors });
  res.json(workloads.getWorkloadTrends(coreApi, {
    clusterId: clusterId ?? null,
    environment: environment || null,
    days: days ?? 90,
  }));
}

function handleGetWorkloadSources(req, res, coreApi) {
  const db = coreApi.db;
  const objects = db.prepare(`
    SELECT o.*, c.name AS cluster_name
    FROM cohesity_objects o
    JOIN clusters c ON c.id = o.cluster_id
    ORDER BY c.name, o.name
  `).all().map((o) => ({
    ...o,
    protection_groups: o.protection_groups ? JSON.parse(o.protection_groups) : [],
    policy_names: o.policy_names ? JSON.parse(o.policy_names) : [],
  }));
  const byEnv = {};
  for (const o of objects) {
    const e = (byEnv[o.environment] ||= { environment: o.environment, total: 0, protected: 0, logicalBytes: 0 });
    e.total += 1;
    if (o.is_protected) e.protected += 1;
    e.logicalBytes += o.logical_bytes || 0;
  }
  res.json({
    objects,
    environments: Object.values(byEnv).sort((a, b) => b.total - a.total),
    capturedAt: objects[0]?.captured_at || null,
  });
}

async function handlePostWorkloadsRefresh(req, res, coreApi) {
  const results = await workloads.refreshAllWorkloads(coreApi);
  res.json({ results, ...workloads.getWorkloads(coreApi) });
}

// ── backup history (backend/routes/backupHistory.js port) ─────────────────

const startEpoch = "CAST(CASE WHEN pr.start_time LIKE '20%' THEN strftime('%s', pr.start_time) ELSE pr.start_time END AS INTEGER)";
const endEpoch = "CAST(CASE WHEN pr.end_time LIKE '20%' THEN strftime('%s', pr.end_time) ELSE pr.end_time END AS INTEGER)";

function handleGetBackupHistory(req, res, coreApi) {
  const db = coreApi.db;
  if (req.query.q !== undefined && !isNonEmptyString(req.query.q, 200) && req.query.q !== '') {
    return badReq(res, [vfail('q')]);
  }
  let days = 30;
  if (req.query.days !== undefined) {
    const r = parseQueryInt(req.query.days, 1, 31);
    if (!r.ok) return badReq(res, [vfail('days')]);
    days = Math.min(r.value, 31);
  }
  const q = String(req.query.q || '').trim();
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;

  const objectCols = `
    SELECT o.id, o.name, o.environment, o.object_type, o.os_type, o.source_name,
           o.is_protected, o.protection_groups, o.policy_names,
           o.last_backup_status, o.sla_violated, o.logical_bytes,
           o.cluster_id, c.name AS cluster_name
    FROM cohesity_objects o
    JOIN clusters c ON c.id = o.cluster_id`;

  let objects;
  if (q.length >= 2) {
    const pattern = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    objects = db.prepare(`
      ${objectCols}
      WHERE o.name LIKE ? ESCAPE '\\'
      ORDER BY o.name, c.name
      LIMIT 50
    `).all(pattern);
  } else {
    const names = db.prepare(`
      SELECT DISTINCT name FROM cohesity_objects
      WHERE is_protected = 1 AND protection_groups IS NOT NULL
      ORDER BY name COLLATE NOCASE LIMIT 25
    `).all().map((r) => r.name);
    objects = names.length ? db.prepare(`
      ${objectCols}
      WHERE o.name IN (${names.map(() => '?').join(',')})
      ORDER BY o.name, c.name
    `).all(...names) : [];
  }

  const repStmt = db.prepare(`
    SELECT target_cluster_name, status, logical_bytes, lag_seconds
    FROM replication_runs WHERE protection_run_id = ?
  `);

  const byName = new Map();
  for (const o of objects) {
    let groups = [];
    try { groups = JSON.parse(o.protection_groups || '[]'); } catch { /* malformed */ }
    let policies = [];
    try { policies = JSON.parse(o.policy_names || '[]'); } catch { /* malformed */ }
    const key = o.name.toLowerCase();
    if (!byName.has(key)) {
      byName.set(key, {
        name: o.name,
        clusters: new Set(),
        groupClusters: new Map(),
        clusterNames: new Map(),
        environment: o.environment,
        objectType: o.object_type,
        osType: o.os_type,
        sourceName: o.source_name,
        isProtected: false,
        policies: new Set(),
        lastBackupStatus: o.last_backup_status,
        slaViolated: o.sla_violated == null ? null : !!o.sla_violated,
        logicalBytes: o.logical_bytes,
      });
    }
    const s = byName.get(key);
    s.clusters.add(o.cluster_name);
    s.clusterNames.set(o.cluster_id, o.cluster_name);
    s.isProtected = s.isProtected || !!o.is_protected;
    s.environment = s.environment || o.environment;
    s.osType = s.osType || o.os_type;
    for (const g of groups) {
      if (!s.groupClusters.has(g)) s.groupClusters.set(g, new Set());
      s.groupClusters.get(g).add(o.cluster_id);
    }
    for (const p of policies) s.policies.add(p);
  }

  const servers = [...byName.values()].map((s) => {
    const runs = [];
    for (const [group, clusterIds] of s.groupClusters) {
      const ids = [...clusterIds];
      const rows = db.prepare(`
        SELECT pr.id, pr.cluster_id, pr.run_type, pr.status,
               ${startEpoch} AS start_epoch, ${endEpoch} AS end_epoch,
               pr.error_code, pr.error_message, pr.logical_bytes
        FROM protection_runs pr
        WHERE pr.cluster_id IN (${ids.map(() => '?').join(',')})
          AND pr.job_name IN (?, ?) AND ${startEpoch} >= ?
        ORDER BY start_epoch ASC
      `).all(...ids, group, `vc${group}`, cutoff);
      for (const r of rows) {
        runs.push({
          id: r.id,
          group,
          clusterName: s.clusterNames.get(r.cluster_id) || null,
          runType: r.run_type,
          status: r.status,
          startMs: r.start_epoch ? r.start_epoch * 1000 : null,
          endMs: r.end_epoch ? r.end_epoch * 1000 : null,
          logicalBytes: r.logical_bytes,
          errorCode: r.error_code,
          errorMessage: r.error_message,
          replication: repStmt.all(r.id).map((x) => ({
            targetCluster: x.target_cluster_name,
            status: x.status,
            logicalBytes: x.logical_bytes,
            lagSeconds: x.lag_seconds,
          })),
        });
      }
    }
    runs.sort((a, b) => (a.startMs || 0) - (b.startMs || 0));
    return {
      name: s.name,
      clusters: [...s.clusters],
      sourceName: s.sourceName,
      environment: s.environment,
      objectType: s.objectType,
      osType: s.osType,
      isProtected: s.isProtected,
      groups: [...s.groupClusters.keys()],
      policies: [...s.policies],
      lastBackupStatus: s.lastBackupStatus,
      slaViolated: s.slaViolated,
      logicalBytes: s.logicalBytes,
      runs,
    };
  }).sort(q.length >= 2
    ? (a, b) => (b.runs.length - a.runs.length) || a.name.localeCompare(b.name)
    : (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  res.json({ query: q, days, browse: q.length < 2, servers });
}

async function handleGetBackupHistoryRunDetail(req, res, coreApi) {
  const id = reqIntParam(req, res);
  if (id === null) return;
  if (req.query.server !== undefined && !isNonEmptyString(req.query.server, 300) && req.query.server !== '') {
    return badReq(res, [vfail('server')]);
  }
  const db = coreApi.db;
  if (process.env.DASHBOARD_DEMO === '1') {
    return res.json({ demo: true, warnings: [], error: null, thisServer: null, objects: [] });
  }
  const run = db.prepare('SELECT * FROM protection_runs WHERE id = ?').get(id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const cluster = db.prepare('SELECT * FROM clusters WHERE id = ?').get(run.cluster_id);
  if (!cluster) return res.status(404).json({ error: 'Cluster not found' });

  const api = require('./api');
  const startSec = String(run.start_time).startsWith('20')
    ? Math.floor(Date.parse(run.start_time) / 1000)
    : Number(run.start_time);
  const startUsecs = startSec * 1e6;
  const batch = await api.fetchProtectionRuns(cluster, coreApi, 10, startUsecs - 120 * 1e6, startUsecs + 120 * 1e6, run.job_id);
  const live = (batch || []).find((r) => {
    const s = r.backupRun?.stats?.startTimeUsecs;
    return s && Math.abs(s - startUsecs) < 5 * 1e6;
  });
  if (!live) return res.json({ warnings: [], error: null, thisServer: null, objects: [], notFound: true });

  const br = live.backupRun || {};
  const toMsg = (x) => (typeof x === 'string' ? x : (x?.message || JSON.stringify(x)));
  const warnings = (Array.isArray(br.warnings) ? br.warnings : []).map(toMsg);
  const error = br.error ? toMsg(br.error) : null;

  const wanted = String(req.query.server || '').trim().toLowerCase();
  const short = wanted.split('.')[0];
  const objects = (Array.isArray(br.sourceBackupStatus) ? br.sourceBackupStatus : []).map((s) => {
    const snap = s.currentSnapshotInfo || {};
    return {
      name: s.source?.name || null,
      status: s.status || null,
      numRestarts: s.numRestarts ?? null,
      bytesRead: snap.totalBytesReadFromSource ?? null,
      error: s.error ? toMsg(s.error) : null,
      warnings: (Array.isArray(s.warnings) ? s.warnings : []).map(toMsg),
    };
  });
  const thisServer = wanted
    ? objects.find((o) => {
        const n = String(o.name || '').toLowerCase();
        return n === wanted || n.split('.')[0] === short;
      }) || null
    : null;
  const summary = {};
  for (const o of objects) summary[o.status || 'unknown'] = (summary[o.status || 'unknown'] || 0) + 1;

  res.json({ warnings, error, slaViolated: br.slaViolated ?? null, thisServer, objectSummary: summary, objectCount: objects.length });
}

// ── object 360 (backend/routes/cohesityObject360.js port) ─────────────────

function handleGetObject360Suggest(req, res, coreApi) {
  if (!isNonEmptyString(req.query.q, 200)) return badReq(res, [vfail('q')]);
  const q = String(req.query.q).trim();
  const pattern = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const rows = coreApi.db.prepare(`
    SELECT DISTINCT name FROM cohesity_objects
    WHERE name LIKE ? ESCAPE '\\'
    ORDER BY name COLLATE NOCASE
    LIMIT 10
  `).all(pattern);
  res.json({ names: rows.map((r) => r.name) });
}

function handleGetObject360(req, res, coreApi) {
  if (!isNonEmptyString(req.query.name, 300)) return badReq(res, [vfail('name')]);
  const db = coreApi.db;
  const name = String(req.query.name).trim();

  const rows = db.prepare(`
    SELECT o.id, o.name, o.environment, o.object_type, o.os_type, o.source_name,
           o.is_protected, o.protection_groups, o.policy_names,
           o.last_backup_status, o.last_backup_ms, o.sla_violated, o.logical_bytes,
           o.cluster_id, c.name AS cluster_name
    FROM cohesity_objects o
    JOIN clusters c ON c.id = o.cluster_id
    WHERE lower(o.name) = lower(?)
    ORDER BY o.name, c.name
  `).all(name);

  if (rows.length === 0) {
    return res.json({ query: name, found: false, objects: [], runs14d: [], replication: [], agents: [], alerts: [] });
  }

  const objects = rows.map((o) => {
    let protectionGroups = [];
    try { protectionGroups = JSON.parse(o.protection_groups || '[]'); } catch { /* malformed */ }
    let policyNames = [];
    try { policyNames = JSON.parse(o.policy_names || '[]'); } catch { /* malformed */ }
    return {
      id: o.id,
      name: o.name,
      environment: o.environment,
      objectType: o.object_type,
      osType: o.os_type,
      isProtected: !!o.is_protected,
      clusterName: o.cluster_name,
      protectionGroups,
      policyNames,
      lastBackupStatus: o.last_backup_status,
      lastBackupMs: o.last_backup_ms,
      slaViolated: o.sla_violated == null ? null : !!o.sla_violated,
      logicalBytes: o.logical_bytes,
      sourceName: o.source_name,
    };
  });

  const groupClusters = new Map();
  const clusterNames = new Map();
  const clusterIds = new Set();
  for (const o of rows) {
    clusterIds.add(o.cluster_id);
    clusterNames.set(o.cluster_id, o.cluster_name);
    let groups = [];
    try { groups = JSON.parse(o.protection_groups || '[]'); } catch { /* malformed */ }
    for (const g of groups) {
      if (!groupClusters.has(g)) groupClusters.set(g, new Set());
      groupClusters.get(g).add(o.cluster_id);
    }
  }

  const cutoff = Math.floor(Date.now() / 1000) - 14 * 86400;
  const repStmt = db.prepare(`
    SELECT target_cluster_name, status, logical_bytes, lag_seconds
    FROM replication_runs WHERE protection_run_id = ?
  `);

  const runs14d = [];
  const replication = [];
  for (const [group, ids] of groupClusters) {
    const idList = [...ids];
    const runRows = db.prepare(`
      SELECT pr.id, pr.cluster_id, pr.run_type, pr.status,
             ${startEpoch} AS start_epoch, ${endEpoch} AS end_epoch,
             pr.error_message, pr.logical_bytes
      FROM protection_runs pr
      WHERE pr.cluster_id IN (${idList.map(() => '?').join(',')})
        AND pr.job_name IN (?, ?) AND ${startEpoch} >= ?
      ORDER BY start_epoch ASC
    `).all(...idList, group, `vc${group}`, cutoff);
    for (const r of runRows) {
      runs14d.push({
        id: r.id,
        group,
        clusterName: clusterNames.get(r.cluster_id) || null,
        runType: r.run_type,
        status: r.status,
        startMs: r.start_epoch ? r.start_epoch * 1000 : null,
        endMs: r.end_epoch ? r.end_epoch * 1000 : null,
        logicalBytes: r.logical_bytes,
        errorMessage: r.error_message,
      });
      for (const leg of repStmt.all(r.id)) {
        replication.push({
          group,
          targetCluster: leg.target_cluster_name,
          status: leg.status,
          logicalBytes: leg.logical_bytes,
          lagSeconds: leg.lag_seconds,
          startMs: r.start_epoch ? r.start_epoch * 1000 : null,
        });
      }
    }
  }
  runs14d.sort((a, b) => (a.startMs || 0) - (b.startMs || 0));

  const idList = [...clusterIds];
  const agents = idList.length ? db.prepare(`
    SELECT agent_version, agent_status, upgradability, cluster_id
    FROM cohesity_agents
    WHERE cluster_id IN (${idList.map(() => '?').join(',')}) AND lower(name) = lower(?)
  `).all(...idList, name).map((a) => ({
    agentVersion: a.agent_version,
    agentStatus: a.agent_status,
    upgradability: a.upgradability,
    clusterName: clusterNames.get(a.cluster_id) || null,
  })) : [];

  const alerts = idList.length ? db.prepare(`
    SELECT id, severity, alert_type, description, cluster_id, first_seen
    FROM alerts
    WHERE cluster_id IN (${idList.map(() => '?').join(',')}) AND resolved = 0 AND dismissed = 0
    ORDER BY first_seen DESC
    LIMIT 10
  `).all(...idList).map((a) => ({
    id: a.id,
    severity: a.severity,
    alertType: a.alert_type,
    message: a.description,
    clusterName: clusterNames.get(a.cluster_id) || null,
    firstSeen: a.first_seen,
  })) : [];

  res.json({ query: name, found: true, objects, runs14d, replication, agents, alerts });
}

// ── gflags ───────────────────────────────────────────────────────────────

function handleGetGflags(req, res, coreApi) {
  res.json(gflags.getGflags(coreApi));
}

function handleGetGflagChanges(req, res, coreApi) {
  const errors = [];
  let clusterId, flag, days;
  if (req.query.clusterId !== undefined) {
    const r = parseQueryInt(req.query.clusterId);
    if (!r.ok) errors.push(vfail('clusterId'));
    else clusterId = r.value;
  }
  if (req.query.flag !== undefined) flag = String(req.query.flag).trim();
  if (req.query.days !== undefined) {
    const r = parseQueryInt(req.query.days, 1, 3650);
    if (!r.ok) errors.push(vfail('days'));
    else days = r.value;
  }
  if (errors.length) return res.status(400).json({ error: errors[0].msg || 'Invalid parameters' });
  res.json({ changes: gflags.getGflagChanges(coreApi, { clusterId, flag, days }) });
}

async function handlePostGflagsRefresh(req, res, coreApi) {
  let clusterId;
  if (req.query.clusterId !== undefined) {
    const r = parseQueryInt(req.query.clusterId);
    if (!r.ok) return res.status(400).json({ error: 'Invalid parameters' });
    clusterId = r.value;
  }
  const db = coreApi.db;
  if (process.env.DASHBOARD_DEMO === '1') {
    const clusters = clusterId
      ? db.prepare('SELECT id, name FROM clusters WHERE id = ?').all(clusterId)
      : db.prepare('SELECT id, name FROM clusters ORDER BY name').all();
    if (clusterId && clusters.length === 0) {
      return res.status(404).json({ error: 'Cluster not found.' });
    }
    const countFlags = db.prepare('SELECT COUNT(*) AS n FROM cluster_gflags WHERE cluster_id = ?');
    return res.json({
      results: clusters.map((c) => ({ clusterId: c.id, name: c.name, flags: countFlags.get(c.id).n, changes: 0 })),
    });
  }
  if (clusterId) {
    const cluster = db.prepare('SELECT * FROM clusters WHERE id = ?').get(clusterId);
    if (!cluster) return res.status(404).json({ error: 'Cluster not found.' });
    const result = await gflags.refreshGflags(cluster, coreApi);
    return res.json({ results: [{ clusterId: cluster.id, name: cluster.name, ...result }] });
  }
  res.json({ results: await gflags.refreshAllGflags(coreApi) });
}

function handleGetGflagsExport(req, res, coreApi) {
  const r = parseQueryInt(req.query.clusterId);
  if (!r.ok || r.value === undefined) return res.status(400).json({ error: 'clusterId is required' });
  if (req.query.format !== undefined && !['csv', 'json'].includes(req.query.format)) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }
  const db = coreApi.db;
  const cluster = db.prepare('SELECT id, name FROM clusters WHERE id = ?').get(r.value);
  if (!cluster) return res.status(404).json({ error: 'Cluster not found.' });
  const rows = db.prepare(`
    SELECT service_name, flag_name, flag_value, reason, source_timestamp, captured_at
    FROM cluster_gflags WHERE cluster_id = ? ORDER BY service_name, flag_name
  `).all(cluster.id);

  const safeName = String(cluster.name).replace(/[^A-Za-z0-9._-]/g, '_');
  const date = new Date().toISOString().slice(0, 10);

  if (req.query.format === 'json') {
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}-gflags-${date}.json"`);
    return res.json({ cluster: cluster.name, exportedAt: new Date().toISOString(), gflags: rows });
  }

  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['Service', 'Flag Name', 'Value', 'Reason', 'Set Timestamp', 'Captured At'];
  const lines = [header.map(esc).join(',')];
  for (const r2 of rows) {
    lines.push([r2.service_name, r2.flag_name, r2.flag_value, r2.reason,
      r2.source_timestamp ?? '', r2.captured_at].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}-gflags-${date}.csv"`);
  res.send(lines.join('\r\n'));
}

// ── governance (backend/routes/governance.js port) ─────────────────────────

function parseJsonArray(s) {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function handleGetGovernance(req, res, coreApi) {
  const db = coreApi.db;
  const policyRows = db.prepare(`
    SELECT p.*, c.name AS cluster_name
    FROM policies p
    JOIN clusters c ON p.cluster_id = c.id
    ORDER BY p.name, c.name
  `).all();

  const policies = policyRows.map(p => {
    const replicationTargets = parseJsonArray(p.replication_targets);
    const archivalTargets = parseJsonArray(p.archival_targets);
    return {
      clusterId: p.cluster_id,
      clusterName: p.cluster_name,
      policyId: p.policy_id,
      name: p.name,
      retentionDays: p.retention_days,
      replicationTargets,
      archivalTargets,
      dataLock: !!p.datalock,
      noOffsiteCopy: replicationTargets.length === 0 && archivalTargets.length === 0,
      capturedAt: p.captured_at,
    };
  });

  const BUILTIN_POLICY_NAMES = new Set(['protect once']);
  const byName = new Map();
  for (const p of policies) {
    if (!p.name) continue;
    if (BUILTIN_POLICY_NAMES.has(p.name.trim().toLowerCase())) continue;
    if (!byName.has(p.name)) byName.set(p.name, []);
    byName.get(p.name).push(p);
  }
  const retentionDrift = [];
  for (const [name, group] of byName) {
    const retentions = [...new Set(group.map(p => p.retentionDays).filter(v => v != null))];
    if (group.length > 1 && retentions.length > 1) {
      retentionDrift.push({
        name,
        variants: group.map(p => ({ clusterName: p.clusterName, retentionDays: p.retentionDays })),
      });
    }
  }

  const sources = db.prepare(`
    SELECT s.*, c.name AS cluster_name
    FROM source_registrations s
    JOIN clusters c ON s.cluster_id = c.id
    ORDER BY s.unprotected_count DESC, c.name
  `).all().map(s => ({
    clusterId: s.cluster_id,
    clusterName: s.cluster_name,
    sourceId: s.source_id,
    sourceName: s.source_name,
    environment: s.environment,
    protectedCount: s.protected_count,
    unprotectedCount: s.unprotected_count,
    protectedBytes: s.protected_bytes,
    unprotectedBytes: s.unprotected_bytes,
    capturedAt: s.captured_at,
  }));

  const totalUnprotected = sources.reduce((sum, s) => sum + (s.unprotectedCount || 0), 0);
  const totalProtected = sources.reduce((sum, s) => sum + (s.protectedCount || 0), 0);

  const versionRows = db.prepare(`
    SELECT c.id AS cluster_id, c.name AS cluster_name, m.software_version
    FROM clusters c
    LEFT JOIN metrics_history m ON m.id = (
      SELECT id FROM metrics_history
      WHERE cluster_id = c.id AND software_version IS NOT NULL
      ORDER BY captured_at DESC LIMIT 1
    )
    ORDER BY c.name
  `).all();

  const versionCounts = new Map();
  for (const r of versionRows) {
    if (!r.software_version) continue;
    versionCounts.set(r.software_version, (versionCounts.get(r.software_version) || 0) + 1);
  }
  let dominantVersion = null;
  let dominantCount = 0;
  for (const [v, count] of versionCounts) {
    if (count > dominantCount) { dominantVersion = v; dominantCount = count; }
  }

  const versions = versionRows.map(r => ({
    clusterId: r.cluster_id,
    clusterName: r.cluster_name,
    softwareVersion: r.software_version,
    isOutlier: !!(r.software_version && dominantVersion && r.software_version !== dominantVersion),
  }));

  const auditViews = db.prepare(`
    SELECT system_id AS systemId, system_name AS systemName, name, category,
           protocols, protected, replicated_out AS replicatedOut,
           datalock_mode AS datalockMode, consumed_bytes AS consumedBytes,
           created_ms AS createdMs, captured_at AS capturedAt
    FROM cohesity_views
    WHERE is_read_only = 0
    ORDER BY system_name, name
  `).all().map(v => ({
    ...v,
    noBackup: !v.protected,
    noReplication: !v.replicatedOut,
    noDatalock: !v.datalockMode,
  }));
  const viewsAudit = {
    totalWritable: auditViews.length,
    noBackupCount: auditViews.filter(v => v.noBackup).length,
    noReplicationCount: auditViews.filter(v => v.noReplication).length,
    noDatalockCount: auditViews.filter(v => v.noDatalock).length,
    views: auditViews.filter(v => v.noBackup || v.noReplication || v.noDatalock),
  };

  const agentRows = db.prepare(`
    SELECT a.*, c.name AS cluster_name
    FROM cohesity_agents a JOIN clusters c ON c.id = a.cluster_id
    ORDER BY c.name, a.name
  `).all();
  const versionKey = (v) => {
    const m = String(v || '').match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:_u(\d+))?/);
    const d = String(v || '').match(/release-(\d{8})/);
    return [m ? +m[1] : 0, m ? +m[2] : 0, m?.[3] ? +m[3] : 0, m?.[4] ? +m[4] : 0, d ? +d[1] : 0];
  };
  let latestAgentVersion = null;
  for (const r of agentRows) {
    if (!r.agent_version) continue;
    if (!latestAgentVersion) { latestAgentVersion = r.agent_version; continue; }
    const a = versionKey(r.agent_version), b = versionKey(latestAgentVersion);
    for (let i = 0; i < a.length; i++) {
      if (a[i] > b[i]) { latestAgentVersion = r.agent_version; break; }
      if (a[i] < b[i]) break;
    }
  }
  const agents = agentRows.map(r => ({
    clusterName: r.cluster_name,
    sourceId: r.source_id,
    name: r.name,
    hostType: r.host_type,
    osName: r.os_name,
    agentVersion: r.agent_version,
    agentStatus: r.agent_status,
    upgradability: r.upgradability,
    isCurrent: !!(r.agent_version && latestAgentVersion && r.agent_version === latestAgentVersion),
  }));

  res.json({
    generatedAt: new Date().toISOString(),
    summary: {
      policyCount: policies.length,
      noOffsiteCopyCount: policies.filter(p => p.noOffsiteCopy).length,
      retentionDriftCount: retentionDrift.length,
      totalUnprotected,
      totalProtected,
      versionSpread: versionCounts.size,
      dominantVersion,
    },
    policies,
    retentionDrift,
    sources,
    versions,
    viewsAudit,
    agentsAudit: {
      latestVersion: latestAgentVersion,
      total: agents.length,
      outdated: agents.filter(a => !a.isCurrent).length,
      agents,
    },
  });
}

// ── insights (backend/routes/insights.js port) ──────────────────────────

function handleGetInsights(req, res, coreApi) {
  res.json(computeInsights(coreApi));
}

function handleGetInsightsAiConfig(req, res, coreApi) {
  res.json({ enabled: createCohesityAdvisor(coreApi).isConfigured() });
}

function resolveMode(req) {
  const m = req.query.mode;
  return ['alerts', 'system'].includes(m) ? m : 'system';
}

function handleGetInsightsAiCluster(req, res, coreApi) {
  const id = reqIntParam(req, res, 'clusterId');
  if (id === null) return;
  if (req.query.mode !== undefined && !['alerts', 'system'].includes(req.query.mode)) {
    return badReq(res, [vfail('mode')]);
  }
  const advisor = createCohesityAdvisor(coreApi);
  const cached = advisor.getCachedClusterAnalysis(id, resolveMode(req));
  res.json({ enabled: advisor.isConfigured(), analysis: cached });
}

async function handlePostInsightsAiCluster(req, res, coreApi) {
  const id = reqIntParam(req, res, 'clusterId');
  if (id === null) return;
  if (req.query.mode !== undefined && !['alerts', 'system'].includes(req.query.mode)) {
    return badReq(res, [vfail('mode')]);
  }
  const cluster = coreApi.db.prepare('SELECT id FROM clusters WHERE id = ?').get(id);
  if (!cluster) return res.status(404).json({ error: 'Cluster not found.' });
  const advisor = createCohesityAdvisor(coreApi);
  try {
    const result = await advisor.generateClusterAnalysis(id, resolveMode(req));
    res.json(result);
  } catch (err) {
    if (err.code === 'LLM_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'AI analysis is not configured. Add an OpenAI or GitHub Models token under Settings → Credentials.' });
    }
    if (err.code === 'LLM_RATE_LIMITED') {
      if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
      return res.status(429).json({ error: err.message, retryAfter: err.retryAfter });
    }
    if (err.code === 'CLUSTER_NOT_FOUND') {
      return res.status(404).json({ error: 'Cluster not found.' });
    }
    if (err.code === 'LLM_REQUEST_FAILED' || err.code === 'LLM_EMPTY') {
      return res.status(502).json({ error: err.message });
    }
    throw err;
  }
}

// ── advisor (backend/routes/advisor.js port) ────────────────────────────

function reportKeyFromSlug(slug) {
  return String(slug).replace(/-/g, '_');
}

function handleGetAdvisorReport(req, res, coreApi) {
  const advisor = createCohesityAdvisor(coreApi);
  const key = reportKeyFromSlug(req.params.report);
  if (!advisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
  res.json({ enabled: advisor.isConfigured(), report: advisor.getCachedReport(key) });
}

async function handlePostAdvisorReport(req, res, coreApi) {
  const advisor = createCohesityAdvisor(coreApi);
  const key = reportKeyFromSlug(req.params.report);
  if (!advisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
  try {
    const result = await advisor.generateReport(key);
    res.json(result);
  } catch (err) {
    if (err.code === 'LLM_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'AI analysis is not configured. Add an OpenAI or GitHub Models token under Settings → Credentials.' });
    }
    if (err.code === 'LLM_RATE_LIMITED') {
      if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
      return res.status(429).json({ error: err.message, retryAfter: err.retryAfter });
    }
    if (err.code === 'LLM_REQUEST_FAILED' || err.code === 'LLM_EMPTY') {
      return res.status(502).json({ error: err.message });
    }
    throw err;
  }
}

// ── route table ──────────────────────────────────────────────────────────

const ROUTES = [
  // licensing
  { method: 'GET', ...compile('/licensing'), handler: handleGetLicensing },
  { method: 'GET', ...compile('/licensing/views/:systemId'), handler: handleGetLicensingViews },
  { method: 'POST', ...compile('/licensing/refresh'), handler: handlePostLicensingRefresh },
  // views
  { method: 'GET', ...compile('/views'), handler: handleGetViews },
  { method: 'POST', ...compile('/views/refresh'), handler: handlePostViewsRefresh },
  // workloads
  { method: 'GET', ...compile('/workloads'), handler: handleGetWorkloads },
  { method: 'GET', ...compile('/workloads/trends'), handler: handleGetWorkloadTrends },
  { method: 'GET', ...compile('/workloads/sources'), handler: handleGetWorkloadSources },
  { method: 'POST', ...compile('/workloads/refresh'), handler: handlePostWorkloadsRefresh },
  // backup history
  { method: 'GET', ...compile('/backup-history'), handler: handleGetBackupHistory },
  { method: 'GET', ...compile('/backup-history/run/:id/detail'), handler: handleGetBackupHistoryRunDetail },
  // object 360
  { method: 'GET', ...compile('/object-360/suggest'), handler: handleGetObject360Suggest },
  { method: 'GET', ...compile('/object-360'), handler: handleGetObject360 },
  // gflags
  { method: 'GET', ...compile('/gflags'), handler: handleGetGflags },
  { method: 'GET', ...compile('/gflags/changes'), handler: handleGetGflagChanges },
  { method: 'POST', ...compile('/gflags/refresh'), handler: handlePostGflagsRefresh },
  { method: 'GET', ...compile('/gflags/export'), handler: handleGetGflagsExport },
  // governance
  { method: 'GET', ...compile('/governance'), handler: handleGetGovernance },
  // insights (GET /ai/config kept here too — legacy path; core also serves
  // /api/settings/ai-config as the WP0-relocated duplicate)
  { method: 'GET', ...compile('/insights'), handler: handleGetInsights },
  { method: 'GET', ...compile('/insights/ai/config'), handler: handleGetInsightsAiConfig },
  { method: 'GET', ...compile('/insights/ai/:clusterId'), handler: handleGetInsightsAiCluster },
  { method: 'POST', ...compile('/insights/ai/:clusterId'), handler: handlePostInsightsAiCluster },
  // advisor
  { method: 'GET', ...compile('/advisor/:report'), handler: handleGetAdvisorReport },
  { method: 'POST', ...compile('/advisor/:report'), handler: handlePostAdvisorReport },
];

module.exports = { ROUTES };
