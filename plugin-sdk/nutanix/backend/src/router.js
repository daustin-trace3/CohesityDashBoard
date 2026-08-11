// Nutanix routes, ported from backend/routes/nutanix.js. Mounted by the host
// dispatcher at /api/nutanix — paths below are relative.
//
// DEVIATION FROM THE BUILT-IN: bundled plugins cannot require the host's
// express/express-validator — createRouter must return a BARE (req, res,
// next) function. This file hand-matches req.method/req.path against a route
// table and re-implements the validation express-validator did inline,
// preserving the same status codes (400 invalid params, 404 missing, 409
// duplicate, 502 upstream/test-connection failure, 503/429 advisor errors)
// and JSON response shapes exactly.
const api = require('./api');
const moveApi = require('./moveApi');
const { getPoller, getMovePoller } = require('./poller');
const {
  containerWarnPct, containerCritPct, clusterWarnPct, clusterCritPct, rpoGracePct, runwayWarnDays,
  computeIssues, computeRpoCompliance,
} = require('./issues');
const { createNutanixAdvisor } = require('./advisor');

// ── hand-rolled validation helpers ──────────────────────────────────────────

function badRequest(res, details) {
  res.status(400).json({ error: 'Invalid parameters', details });
}

function fail(path, msg = 'Invalid value') {
  return { msg, path };
}

const INT_RE = /^-?\d+$/;

function parseIntStrict(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v !== 'string' || !INT_RE.test(v.trim())) return NaN;
  return parseInt(v, 10);
}

function isNonEmptyString(v, maxLen) {
  return typeof v === 'string' && v.trim().length > 0 && (maxLen == null || v.length <= maxLen);
}

function isBooleanish(v) {
  return typeof v === 'boolean' || v === 'true' || v === 'false' || v === 0 || v === 1 || v === '0' || v === '1';
}

function toBool(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

function requireIdParam(req, res) {
  const id = parseIntStrict(req.params.id);
  if (!Number.isInteger(id)) {
    badRequest(res, [fail('id')]);
    return null;
  }
  return id;
}

function parseQueryInt(v, min, max) {
  if (v === undefined) return { ok: true, value: undefined };
  const n = parseIntStrict(v);
  if (!Number.isInteger(n) || (min != null && n < min) || (max != null && n > max)) {
    return { ok: false };
  }
  return { ok: true, value: n };
}

const SOURCE_TYPES = ['prism_central', 'prism_element'];

// ── response shaping (unchanged from the built-in) ──────────────────────────

function publicSource(coreApi, row) {
  return {
    id: row.id, name: row.name, sourceType: row.source_type, host: row.host, port: row.port,
    sslVerify: !!row.ssl_verify, pollingIntervalMinutes: row.polling_interval_minutes,
    isCe: !!row.is_ce, apiFlavor: row.api_flavor, productVersion: row.product_version,
    lastPollStatus: row.last_poll_status, lastPollError: row.last_poll_error, lastPollAt: row.last_poll_at,
    clusterCount: coreApi.db.prepare('SELECT COUNT(*) n FROM nutanix_clusters WHERE source_id = ?').get(row.id).n,
  };
}

function publicMoveConn(coreApi, row) {
  return {
    id: row.id, name: row.name, host: row.host, sslVerify: !!row.ssl_verify,
    applianceVersion: row.appliance_version, lastPollStatus: row.last_poll_status,
    lastPollError: row.last_poll_error, lastPollAt: row.last_poll_at,
    planCount: coreApi.db.prepare('SELECT COUNT(*) n FROM nutanix_move_plans WHERE conn_id = ?').get(row.id).n,
  };
}

// ── source registration CRUD ────────────────────────────────────────────────

function handleGetSources(req, res, coreApi) {
  res.json({ sources: coreApi.db.prepare('SELECT * FROM nutanix_sources ORDER BY name').all().map((r) => publicSource(coreApi, r)) });
}

function handlePostSources(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  if (!isNonEmptyString(b.name, 120)) errors.push(fail('name'));
  if (!SOURCE_TYPES.includes(b.sourceType)) errors.push(fail('sourceType'));
  if (!isNonEmptyString(b.host, 253)) errors.push(fail('host'));
  if (b.port !== undefined) {
    const p = parseIntStrict(b.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) errors.push(fail('port'));
  }
  if (!isNonEmptyString(b.username, 256)) errors.push(fail('username'));
  if (!(typeof b.password === 'string' && b.password.length > 0 && b.password.length <= 512)) errors.push(fail('password'));
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (b.pollingIntervalMinutes !== undefined) {
    const n = parseIntStrict(b.pollingIntervalMinutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) errors.push(fail('pollingIntervalMinutes'));
  }
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  const name = b.name.trim();
  const host = b.host.trim();
  const dup = db.prepare('SELECT id FROM nutanix_sources WHERE name = ? OR (host = ? AND source_type = ?)')
    .get(name, host, b.sourceType);
  if (dup) return res.status(409).json({ error: 'A Nutanix source with that name or host+type is already registered.' });
  const info = db.prepare(`
    INSERT INTO nutanix_sources (name, source_type, host, port, username, encrypted_credentials,
      ssl_verify, polling_interval_minutes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, b.sourceType, host, b.port ? parseIntStrict(b.port) : 9440, b.username.trim(),
    coreApi.encryption.encrypt(JSON.stringify({ password: b.password })), toBool(b.sslVerify) ? 1 : 0,
    b.pollingIntervalMinutes ? parseIntStrict(b.pollingIntervalMinutes) : 15);
  const row = db.prepare('SELECT * FROM nutanix_sources WHERE id = ?').get(info.lastInsertRowid);
  const poller = getPoller(coreApi);
  poller.schedule(row);
  poller.trigger(row).catch(() => {});
  res.status(201).json({ source: publicSource(coreApi, row) });
}

function handlePutSource(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const b = req.body || {};
  const errors = [];
  if (b.name !== undefined && !isNonEmptyString(b.name, 120)) errors.push(fail('name'));
  if (b.sourceType !== undefined && !SOURCE_TYPES.includes(b.sourceType)) errors.push(fail('sourceType'));
  if (b.host !== undefined && !isNonEmptyString(b.host, 253)) errors.push(fail('host'));
  if (b.port !== undefined) {
    const p = parseIntStrict(b.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) errors.push(fail('port'));
  }
  if (b.username !== undefined && !isNonEmptyString(b.username, 256)) errors.push(fail('username'));
  if (b.password !== undefined && !(typeof b.password === 'string' && b.password.length <= 512)) errors.push(fail('password'));
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (b.pollingIntervalMinutes !== undefined) {
    const n = parseIntStrict(b.pollingIntervalMinutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) errors.push(fail('pollingIntervalMinutes'));
  }
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM nutanix_sources WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Nutanix source not found.' });
  db.prepare(`
    UPDATE nutanix_sources SET
      name = ?, source_type = ?, host = ?, port = ?, username = ?, encrypted_credentials = ?,
      ssl_verify = ?, polling_interval_minutes = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    b.name?.trim() || row.name, b.sourceType || row.source_type, b.host?.trim() || row.host,
    b.port ? parseIntStrict(b.port) : row.port, b.username?.trim() || row.username,
    b.password ? coreApi.encryption.encrypt(JSON.stringify({ password: b.password })) : row.encrypted_credentials,
    b.sslVerify !== undefined ? (toBool(b.sslVerify) ? 1 : 0) : row.ssl_verify,
    b.pollingIntervalMinutes ? parseIntStrict(b.pollingIntervalMinutes) : row.polling_interval_minutes,
    row.id
  );
  api.invalidateSession(row.id);
  const updated = db.prepare('SELECT * FROM nutanix_sources WHERE id = ?').get(row.id);
  getPoller(coreApi).schedule(updated);
  res.json({ source: publicSource(coreApi, updated) });
}

function handleDeleteSource(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM nutanix_sources WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Nutanix source not found.' });
  getPoller(coreApi).cancel(row.id);
  api.invalidateSession(row.id);
  db.prepare('DELETE FROM nutanix_sources WHERE id = ?').run(row.id);
  res.json({ ok: true });
}

async function handlePostSourcesTest(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  if (b.id !== undefined && !Number.isInteger(parseIntStrict(b.id))) errors.push(fail('id'));
  if (b.host !== undefined && !isNonEmptyString(b.host)) errors.push(fail('host'));
  if (b.sourceType !== undefined && !SOURCE_TYPES.includes(b.sourceType)) errors.push(fail('sourceType'));
  if (b.username !== undefined && !isNonEmptyString(b.username)) errors.push(fail('username'));
  if (b.port !== undefined) {
    const p = parseIntStrict(b.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) errors.push(fail('port'));
  }
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (errors.length) return badRequest(res, errors);

  const { id, host, sourceType, username, password, port, sslVerify } = b;
  let candidate;
  if (id) {
    const row = coreApi.db.prepare('SELECT * FROM nutanix_sources WHERE id = ?').get(parseIntStrict(id));
    if (!row) return res.status(404).json({ error: 'Nutanix source not found.' });
    candidate = { ...row, ...(password ? { password } : {}) };
  } else {
    if (!host || !sourceType || !username || !password) {
      return badRequest(res, [fail('host, sourceType, username, password required')]);
    }
    candidate = { host: host.trim(), source_type: sourceType, username: username.trim(), password, port: port ? parseIntStrict(port) : 9440, ssl_verify: toBool(sslVerify) ? 1 : 0 };
  }
  const result = await api.testConnection(candidate, coreApi);
  res.status(result.ok ? 200 : 502).json(result);
}

async function handlePostSourcePoll(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const row = coreApi.db.prepare('SELECT * FROM nutanix_sources WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Nutanix source not found.' });
  getPoller(coreApi).trigger(row).catch(() => {});
  res.json({ ok: true });
}

// Probe fetches run the same fetchers the poller uses, live against the
// source, and report the RAW first item untransformed — the fix-loop for a
// blind build.
function probeSectionsFor(sourceType) {
  if (sourceType === 'prism_central') {
    return [
      ['clusters', (row, coreApi) => api.fetchPCClusters(row, coreApi)],
      ['hosts', (row, coreApi) => api.fetchPCHosts(row, coreApi)],
      ['vms', (row, coreApi) => api.fetchPCVms(row, coreApi)],
      ['groups_cluster_stats', async (row, coreApi) => [...(await api.fetchGroupsClusterStats(row, coreApi)).entries()].map(([uuid, v]) => ({ uuid, ...v }))],
      ['groups_vm_stats', async (row, coreApi) => [...(await api.fetchGroupsVmStats(row, coreApi)).entries()].map(([uuid, v]) => ({ uuid, ...v }))],
      ['alerts', (row, coreApi) => api.fetchPCAlerts(row, coreApi)],
      ['policies', (row, coreApi) => api.fetchPCPolicies(row, coreApi)],
      ['recovery_points', (row, coreApi) => api.fetchPCRecoveryPoints(row, coreApi)],
      ['v4_probe', (row, coreApi) => api.fetchV4Probe(row, coreApi)],
    ];
  }
  return [
    ['cluster', (row, coreApi) => api.fetchPECluster(row, coreApi).then((c) => (c ? [c] : []))],
    ['hosts', (row, coreApi) => api.fetchPEHosts(row, coreApi)],
    ['vms', (row, coreApi) => api.fetchPEVms(row, coreApi)],
    ['containers', (row, coreApi) => api.fetchPEContainers(row, coreApi)],
    ['disks', (row, coreApi) => api.fetchPEDisks(row, coreApi)],
    ['alerts', (row, coreApi) => api.fetchPEAlerts(row, coreApi)],
    ['pds', (row, coreApi) => api.fetchPEPds(row, coreApi)],
    ['replications', (row, coreApi) => api.fetchPEReplications(row, coreApi)],
    ['remote_sites', (row, coreApi) => api.fetchPERemoteSites(row, coreApi)],
    ['fault_tolerance', async (row, coreApi) => { const r = await api.fetchFaultTolerance(row, coreApi); return r ? [r] : []; }],
    ['ncc', async (row, coreApi) => { const r = await api.fetchNccSummary(row, coreApi); return r ? [r] : []; }],
  ];
}

async function handleGetSourceProbe(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  if (req.query.sections !== undefined && !/^[a-zA-Z_,]+$/.test(String(req.query.sections))) {
    return badRequest(res, [fail('sections')]);
  }
  const row = coreApi.db.prepare('SELECT * FROM nutanix_sources WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Nutanix source not found.' });
  const all = probeSectionsFor(row.source_type);
  const wanted = req.query.sections ? new Set(String(req.query.sections).split(',')) : null;
  const run = wanted ? all.filter(([n]) => wanted.has(n)) : all;
  const sections = {};
  for (const [name, fn] of run) {
    try {
      const items = await fn(row, coreApi);
      sections[name] = { ok: true, count: Array.isArray(items) ? items.length : undefined, firstItem: Array.isArray(items) ? (items[0] ?? null) : items };
    } catch (err) {
      sections[name] = { ok: false, error: err.response?.data?.message || err.message };
    }
  }
  res.json({ sections });
}

// ── data endpoints ───────────────────────────────────────────────────────────

function handleGetOverview(req, res, coreApi) {
  const db = coreApi.db;
  const totals = {
    sources: db.prepare('SELECT COUNT(*) n FROM nutanix_sources').get().n,
    clusters: db.prepare('SELECT COUNT(*) n FROM nutanix_clusters').get().n,
    hosts: db.prepare('SELECT COUNT(*) n FROM nutanix_hosts').get().n,
    vms: db.prepare('SELECT COUNT(*) n FROM nutanix_vms').get().n,
    storageCapacityBytes: db.prepare('SELECT SUM(storage_capacity_bytes) s FROM nutanix_clusters').get().s || 0,
    storageUsageBytes: db.prepare('SELECT SUM(storage_usage_bytes) s FROM nutanix_clusters').get().s || 0,
    criticalAlerts: db.prepare("SELECT COUNT(*) n FROM nutanix_alerts WHERE severity = 'critical' AND resolved = 0").get().n,
    warningAlerts: db.prepare("SELECT COUNT(*) n FROM nutanix_alerts WHERE severity = 'warning' AND resolved = 0").get().n,
    unprotectedVms: db.prepare('SELECT SUM(unprotected_vm_count) s FROM nutanix_clusters').get().s || 0,
  };
  const clusters = db.prepare(`
    SELECT c.*, s.name AS source_name, s.is_ce AS source_is_ce,
      (CASE WHEN c.storage_capacity_bytes > 0 THEN (CAST(c.storage_usage_bytes AS REAL) / c.storage_capacity_bytes) * 100 ELSE NULL END) AS usage_pct
    FROM nutanix_clusters c JOIN nutanix_sources s ON s.id = c.source_id ORDER BY s.name, c.name
  `).all();
  const util = db.prepare(`
    SELECT SUM(cpu_usage_ppm * COALESCE(num_nodes, 1)) / NULLIF(SUM(CASE WHEN cpu_usage_ppm IS NOT NULL THEN COALESCE(num_nodes, 1) END), 0) AS cpu_ppm,
           SUM(memory_usage_ppm * COALESCE(num_nodes, 1)) / NULLIF(SUM(CASE WHEN memory_usage_ppm IS NOT NULL THEN COALESCE(num_nodes, 1) END), 0) AS mem_ppm
    FROM nutanix_clusters
  `).get();
  const provisioning = {
    vcpus: db.prepare('SELECT SUM(num_vcpus) v FROM nutanix_vms').get().v || 0,
    physicalCores: db.prepare('SELECT SUM(num_cpu_cores) c FROM nutanix_hosts').get().c || 0,
    vmemMb: db.prepare('SELECT SUM(memory_mb) m FROM nutanix_vms').get().m || 0,
    physicalMemBytes: db.prepare('SELECT SUM(memory_capacity_bytes) m FROM nutanix_hosts').get().m || 0,
  };
  const worstRunway = db.prepare(`
    SELECT name, runway_days FROM nutanix_clusters WHERE runway_days IS NOT NULL ORDER BY runway_days ASC LIMIT 1
  `).get() || null;
  const trend = db.prepare(`
    SELECT substr(m.captured_at, 1, 10) AS day,
           SUM(m.storage_capacity_bytes) AS storage_capacity_bytes,
           SUM(m.storage_usage_bytes) AS storage_usage_bytes,
           AVG(m.cpu_usage_ppm) AS cpu_usage_ppm,
           AVG(m.memory_usage_ppm) AS memory_usage_ppm,
           SUM(m.controller_iops) AS controller_iops,
           AVG(m.controller_latency_usecs) AS controller_latency_usecs
    FROM nutanix_metrics_history m
    JOIN (
      SELECT MAX(id) AS id FROM nutanix_metrics_history
      WHERE captured_at >= datetime('now', '-31 days')
      GROUP BY cluster_id, substr(captured_at, 1, 10)
    ) latest ON latest.id = m.id
    GROUP BY day ORDER BY day
  `).all();
  res.json({
    totals, clusters,
    utilization: { cpuPpm: util?.cpu_ppm ?? null, memPpm: util?.mem_ppm ?? null },
    provisioning, worstRunway, trend,
    moveConfigured: db.prepare('SELECT COUNT(*) n FROM nutanix_move_conns').get().n > 0,
    issues: computeIssues(coreApi).slice(0, 10),
  });
}

function handleGetClusters(req, res, coreApi) {
  res.json({
    clusters: coreApi.db.prepare(`
      SELECT c.*, s.name AS source_name, s.is_ce AS source_is_ce,
        (CASE WHEN c.storage_capacity_bytes > 0 THEN (CAST(c.storage_usage_bytes AS REAL) / c.storage_capacity_bytes) * 100 ELSE NULL END) AS usage_pct
      FROM nutanix_clusters c JOIN nutanix_sources s ON s.id = c.source_id ORDER BY s.name, c.name
    `).all(),
  });
}

function handleGetHosts(req, res, coreApi) {
  res.json({
    hosts: coreApi.db.prepare(`
      SELECT h.*, c.name AS cluster_name, s.name AS source_name
      FROM nutanix_hosts h
      JOIN nutanix_sources s ON s.id = h.source_id
      LEFT JOIN nutanix_clusters c ON c.source_id = h.source_id AND c.uuid = h.cluster_uuid
      ORDER BY s.name, h.name
    `).all(),
  });
}

function handleGetVms(req, res, coreApi) {
  res.json({
    vms: coreApi.db.prepare(`
      SELECT v.*, s.name AS source_name FROM nutanix_vms v
      JOIN nutanix_sources s ON s.id = v.source_id ORDER BY s.name, v.name
    `).all(),
  });
}

function handleGetVmByUuid(req, res, coreApi) {
  if (!isNonEmptyString(req.params.uuid)) return badRequest(res, [fail('uuid')]);
  const db = coreApi.db;
  const vm = db.prepare(`
    SELECT v.*, s.name AS source_name FROM nutanix_vms v
    JOIN nutanix_sources s ON s.id = v.source_id WHERE v.uuid = ?
  `).get(req.params.uuid);
  if (!vm) return res.status(404).json({ error: 'VM not found.' });
  const host = vm.host_uuid
    ? db.prepare('SELECT * FROM nutanix_hosts WHERE source_id = ? AND uuid = ?').get(vm.source_id, vm.host_uuid)
    : null;
  const recentEvents = db.prepare(`
    SELECT * FROM nutanix_events WHERE source_id = ? AND entity_name = ? ORDER BY created_at DESC LIMIT 50
  `).all(vm.source_id, vm.name);
  res.json({ vm, host: host || null, recentEvents });
}

function handleGetStorage(req, res, coreApi) {
  const db = coreApi.db;
  res.json({
    containers: db.prepare(`
      SELECT c.*, s.name AS source_name FROM nutanix_containers c
      JOIN nutanix_sources s ON s.id = c.source_id ORDER BY s.name, c.name
    `).all(),
    disks: db.prepare(`
      SELECT d.*, s.name AS source_name FROM nutanix_disks d
      JOIN nutanix_sources s ON s.id = d.source_id ORDER BY s.name, d.host_name
    `).all(),
  });
}

function handleGetProtection(req, res, coreApi) {
  const db = coreApi.db;
  res.json({
    pds: db.prepare(`SELECT p.*, s.name AS source_name FROM nutanix_pds p JOIN nutanix_sources s ON s.id = p.source_id ORDER BY s.name, p.name`).all(),
    replications: db.prepare(`SELECT r.*, s.name AS source_name FROM nutanix_replications r JOIN nutanix_sources s ON s.id = r.source_id`).all(),
    remoteSites: db.prepare(`SELECT rs.*, s.name AS source_name FROM nutanix_remote_sites rs JOIN nutanix_sources s ON s.id = rs.source_id`).all(),
    policies: db.prepare(`SELECT p.*, s.name AS source_name FROM nutanix_protection_policies p JOIN nutanix_sources s ON s.id = p.source_id`).all(),
    recoveryPoints: db.prepare(`
      SELECT rp.*, s.name AS source_name FROM nutanix_recovery_points rp
      JOIN nutanix_sources s ON s.id = rp.source_id ORDER BY rp.created_at_ts DESC LIMIT 200
    `).all(),
    rpoCompliance: computeRpoCompliance(coreApi),
  });
}

function handleGetAlerts(req, res, coreApi) {
  res.json({
    alerts: coreApi.db.prepare(`
      SELECT a.*, s.name AS source_name FROM nutanix_alerts a
      JOIN nutanix_sources s ON s.id = a.source_id
      ORDER BY a.resolved ASC, a.created_at DESC LIMIT 500
    `).all(),
  });
}

function handleGetEvents(req, res, coreApi) {
  res.json({
    events: coreApi.db.prepare(`
      SELECT e.*, s.name AS source_name FROM nutanix_events e
      JOIN nutanix_sources s ON s.id = e.source_id
      ORDER BY e.created_at DESC LIMIT 300
    `).all(),
  });
}

function handleGetIssues(req, res, coreApi) {
  res.json({ issues: computeIssues(coreApi) });
}

function handleGetIssueHistory(req, res, coreApi) {
  const q = parseQueryInt(req.query.days, 1, 90);
  if (!q.ok) return badRequest(res, [fail('days')]);
  const days = q.value || 30;
  res.json(coreApi.db.prepare(`
    SELECT * FROM nutanix_issue_history
    WHERE status = 'open' OR last_seen >= datetime('now', ?)
    ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, last_seen DESC
  `).all(`-${days} days`));
}

function handleGetTrends(req, res, coreApi) {
  const clusterIdQ = parseQueryInt(req.query.clusterId);
  const daysQ = parseQueryInt(req.query.days, 1, 365);
  if (!clusterIdQ.ok) return badRequest(res, [fail('clusterId')]);
  if (!daysQ.ok) return badRequest(res, [fail('days')]);
  const days = daysQ.value || 30;
  const clauses = [`captured_at >= datetime('now', ?)`];
  const params = [`-${days} days`];
  if (clusterIdQ.value !== undefined) { clauses.push('cluster_id = ?'); params.push(clusterIdQ.value); }
  res.json({
    points: coreApi.db.prepare(`
      SELECT * FROM nutanix_metrics_history WHERE ${clauses.join(' AND ')} ORDER BY captured_at ASC
    `).all(...params),
  });
}

function configPayload(coreApi) {
  return {
    containerWarnPct: containerWarnPct(coreApi), containerCritPct: containerCritPct(coreApi),
    clusterWarnPct: clusterWarnPct(coreApi), clusterCritPct: clusterCritPct(coreApi),
    rpoGracePct: rpoGracePct(coreApi), runwayWarnDays: runwayWarnDays(coreApi),
  };
}

function handleGetConfig(req, res, coreApi) {
  res.json(configPayload(coreApi));
}

function handlePutConfig(req, res, coreApi) {
  const b = req.body || {};
  const fields = [
    ['containerWarnPct', 1, 100], ['containerCritPct', 1, 100], ['clusterWarnPct', 1, 100],
    ['clusterCritPct', 1, 100], ['rpoGracePct', 0, 500], ['runwayWarnDays', 1, 3650],
  ];
  const errors = [];
  for (const [key, min, max] of fields) {
    if (b[key] === undefined) continue;
    const n = parseIntStrict(b[key]);
    if (!Number.isInteger(n) || n < min || n > max) errors.push(fail(key));
  }
  if (errors.length) return badRequest(res, errors);

  const map = {
    containerWarnPct: 'nutanix_container_warn_pct', containerCritPct: 'nutanix_container_crit_pct',
    clusterWarnPct: 'nutanix_cluster_warn_pct', clusterCritPct: 'nutanix_cluster_crit_pct',
    rpoGracePct: 'nutanix_rpo_grace_pct', runwayWarnDays: 'nutanix_runway_warn_days',
  };
  for (const [k, settingKey] of Object.entries(map)) {
    if (req.body[k] !== undefined) coreApi.settings.setSetting(settingKey, String(req.body[k]));
  }
  res.json(configPayload(coreApi));
}

// ── Move connections ────────────────────────────────────────────────────────

function handleGetMoveConnections(req, res, coreApi) {
  res.json({ connections: coreApi.db.prepare('SELECT * FROM nutanix_move_conns ORDER BY name').all().map((r) => publicMoveConn(coreApi, r)) });
}

function handlePostMoveConnections(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  if (!isNonEmptyString(b.name, 120)) errors.push(fail('name'));
  if (!isNonEmptyString(b.host, 253)) errors.push(fail('host'));
  if (!isNonEmptyString(b.username, 256)) errors.push(fail('username'));
  if (!(typeof b.password === 'string' && b.password.length > 0 && b.password.length <= 512)) errors.push(fail('password'));
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  const name = b.name.trim();
  const host = b.host.trim();
  const dup = db.prepare('SELECT id FROM nutanix_move_conns WHERE name = ? OR host = ?').get(name, host);
  if (dup) return res.status(409).json({ error: 'A Move connection with that name or host is already registered.' });
  const info = db.prepare(`
    INSERT INTO nutanix_move_conns (name, host, username, encrypted_credentials, ssl_verify)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, host, b.username.trim(), coreApi.encryption.encrypt(JSON.stringify({ password: b.password })), toBool(b.sslVerify) ? 1 : 0);
  const row = db.prepare('SELECT * FROM nutanix_move_conns WHERE id = ?').get(info.lastInsertRowid);
  const movePoller = getMovePoller(coreApi);
  movePoller.schedule(row);
  movePoller.trigger(row).catch(() => {});
  res.status(201).json({ connection: publicMoveConn(coreApi, row) });
}

function handlePutMoveConnection(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const b = req.body || {};
  const errors = [];
  if (b.name !== undefined && !isNonEmptyString(b.name, 120)) errors.push(fail('name'));
  if (b.host !== undefined && !isNonEmptyString(b.host, 253)) errors.push(fail('host'));
  if (b.username !== undefined && !isNonEmptyString(b.username, 256)) errors.push(fail('username'));
  if (b.password !== undefined && !(typeof b.password === 'string' && b.password.length <= 512)) errors.push(fail('password'));
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM nutanix_move_conns WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Move connection not found.' });
  db.prepare(`
    UPDATE nutanix_move_conns SET name = ?, host = ?, username = ?, encrypted_credentials = ?,
      ssl_verify = ?, updated_at = datetime('now') WHERE id = ?
  `).run(
    b.name?.trim() || row.name, b.host?.trim() || row.host, b.username?.trim() || row.username,
    b.password ? coreApi.encryption.encrypt(JSON.stringify({ password: b.password })) : row.encrypted_credentials,
    b.sslVerify !== undefined ? (toBool(b.sslVerify) ? 1 : 0) : row.ssl_verify,
    row.id
  );
  moveApi.invalidateToken(row.id);
  const updated = db.prepare('SELECT * FROM nutanix_move_conns WHERE id = ?').get(row.id);
  getMovePoller(coreApi).schedule(updated);
  res.json({ connection: publicMoveConn(coreApi, updated) });
}

function handleDeleteMoveConnection(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM nutanix_move_conns WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Move connection not found.' });
  getMovePoller(coreApi).cancel(row.id);
  moveApi.invalidateToken(row.id);
  db.prepare('DELETE FROM nutanix_move_conns WHERE id = ?').run(row.id);
  res.json({ ok: true });
}

async function handlePostMoveConnectionsTest(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  if (b.id !== undefined && !Number.isInteger(parseIntStrict(b.id))) errors.push(fail('id'));
  if (b.host !== undefined && !isNonEmptyString(b.host)) errors.push(fail('host'));
  if (b.username !== undefined && !isNonEmptyString(b.username)) errors.push(fail('username'));
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (errors.length) return badRequest(res, errors);

  const { id, host, username, password, sslVerify } = b;
  let candidate;
  if (id) {
    const row = coreApi.db.prepare('SELECT * FROM nutanix_move_conns WHERE id = ?').get(parseIntStrict(id));
    if (!row) return res.status(404).json({ error: 'Move connection not found.' });
    candidate = { ...row, ...(password ? { password } : {}) };
  } else {
    if (!host || !username || !password) return badRequest(res, [fail('host, username, password required')]);
    candidate = { host: host.trim(), username: username.trim(), password, ssl_verify: toBool(sslVerify) ? 1 : 0 };
  }
  const result = await moveApi.testConnection(candidate, coreApi);
  res.status(result.ok ? 200 : 502).json(result);
}

async function handlePostMoveConnectionPoll(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const row = coreApi.db.prepare('SELECT * FROM nutanix_move_conns WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Move connection not found.' });
  getMovePoller(coreApi).trigger(row).catch(() => {});
  res.json({ ok: true });
}

function handleGetMoveSummary(req, res, coreApi) {
  const db = coreApi.db;
  const configured = db.prepare('SELECT COUNT(*) n FROM nutanix_move_conns').get().n > 0;
  res.json({
    configured,
    plans: db.prepare(`SELECT p.*, c.name AS conn_name FROM nutanix_move_plans p JOIN nutanix_move_conns c ON c.id = p.conn_id`).all(),
    workloads: db.prepare(`SELECT w.*, c.name AS conn_name FROM nutanix_move_workloads w JOIN nutanix_move_conns c ON c.id = w.conn_id`).all(),
    events: db.prepare(`
      SELECT e.*, c.name AS conn_name FROM nutanix_move_events e JOIN nutanix_move_conns c ON c.id = e.conn_id
      ORDER BY e.created_at DESC LIMIT 100
    `).all(),
  });
}

// ── AI Advisor ───────────────────────────────────────────────────────────────

let advisorInstance = null;
function getAdvisor(coreApi) {
  if (!advisorInstance) advisorInstance = createNutanixAdvisor(coreApi);
  return advisorInstance;
}

function advisorReportKey(slug) {
  return String(slug).replace(/-/g, '_');
}

function handleGetAdvisorReport(req, res, coreApi) {
  if (!isNonEmptyString(req.params.report)) return badRequest(res, [fail('report')]);
  const nutanixAdvisor = getAdvisor(coreApi);
  const key = advisorReportKey(req.params.report);
  if (!nutanixAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
  res.json({ enabled: nutanixAdvisor.isConfigured(), report: nutanixAdvisor.getCachedReport(key) });
}

async function handlePostAdvisorReport(req, res, coreApi) {
  if (!isNonEmptyString(req.params.report)) return badRequest(res, [fail('report')]);
  const nutanixAdvisor = getAdvisor(coreApi);
  const key = advisorReportKey(req.params.report);
  if (!nutanixAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
  try {
    const result = await nutanixAdvisor.generateReport(key);
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

// ── route table ──────────────────────────────────────────────────────────────

function compile(template) {
  const names = [];
  const pattern = template
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) { names.push(seg.slice(1)); return '([^/]+)'; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${pattern}$`), names };
}

const ROUTES = [
  { method: 'GET', ...compile('/sources'), handler: handleGetSources },
  { method: 'POST', ...compile('/sources'), handler: handlePostSources },
  { method: 'PUT', ...compile('/sources/:id'), handler: handlePutSource },
  { method: 'DELETE', ...compile('/sources/:id'), handler: handleDeleteSource },
  { method: 'POST', ...compile('/sources/test'), handler: handlePostSourcesTest },
  { method: 'POST', ...compile('/sources/:id/poll'), handler: handlePostSourcePoll },
  { method: 'GET', ...compile('/sources/:id/probe'), handler: handleGetSourceProbe },
  { method: 'GET', ...compile('/overview'), handler: handleGetOverview },
  { method: 'GET', ...compile('/clusters'), handler: handleGetClusters },
  { method: 'GET', ...compile('/hosts'), handler: handleGetHosts },
  { method: 'GET', ...compile('/vms'), handler: handleGetVms },
  { method: 'GET', ...compile('/vms/:uuid'), handler: handleGetVmByUuid },
  { method: 'GET', ...compile('/storage'), handler: handleGetStorage },
  { method: 'GET', ...compile('/protection'), handler: handleGetProtection },
  { method: 'GET', ...compile('/alerts'), handler: handleGetAlerts },
  { method: 'GET', ...compile('/events'), handler: handleGetEvents },
  { method: 'GET', ...compile('/issues'), handler: handleGetIssues },
  { method: 'GET', ...compile('/issue-history'), handler: handleGetIssueHistory },
  { method: 'GET', ...compile('/trends'), handler: handleGetTrends },
  { method: 'GET', ...compile('/config'), handler: handleGetConfig },
  { method: 'PUT', ...compile('/config'), handler: handlePutConfig },
  { method: 'GET', ...compile('/move/connections'), handler: handleGetMoveConnections },
  { method: 'POST', ...compile('/move/connections'), handler: handlePostMoveConnections },
  { method: 'PUT', ...compile('/move/connections/:id'), handler: handlePutMoveConnection },
  { method: 'DELETE', ...compile('/move/connections/:id'), handler: handleDeleteMoveConnection },
  { method: 'POST', ...compile('/move/connections/test'), handler: handlePostMoveConnectionsTest },
  { method: 'POST', ...compile('/move/connections/:id/poll'), handler: handlePostMoveConnectionPoll },
  { method: 'GET', ...compile('/move/summary'), handler: handleGetMoveSummary },
  { method: 'GET', ...compile('/advisor/:report'), handler: handleGetAdvisorReport },
  { method: 'POST', ...compile('/advisor/:report'), handler: handlePostAdvisorReport },
];

// createRouter must return a BARE (req, res, next) function — installed
// plugins are loaded via require() on their own dist/backend/index.cjs and
// cannot require the host's copy of express, so express Router instances are
// off the table. Matches req.method + req.path by hand against the table
// above; req.query/req.body are still parsed by the host's express pipeline
// before this middleware runs.
function createRouter(coreApi) {
  return function nutanixRouter(req, res, next) {
    const path = req.path.length > 1 && req.path.endsWith('/') ? req.path.slice(0, -1) : req.path;
    for (const route of ROUTES) {
      if (route.method !== req.method) continue;
      const m = route.regex.exec(path);
      if (!m) continue;
      const params = {};
      route.names.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
      req.params = params;
      Promise.resolve(route.handler(req, res, coreApi)).catch(next);
      return;
    }
    next();
  };
}

module.exports = { createRouter };
