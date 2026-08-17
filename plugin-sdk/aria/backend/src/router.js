// Aria Automation routes, ported from backend/routes/aria.js. Mounted by the
// host dispatcher at /api/aria — paths below are relative.
//
// DEVIATION FROM THE BUILT-IN: bundled plugins cannot require the host's
// express/express-validator — createRouter must return a BARE (req, res,
// next) function (plugin-sdk/dell/unifi router.js pattern). This file
// hand-matches req.method/req.path against a route table (compile.js) and
// re-implements the validation express-validator did inline (validate.js),
// preserving the same status codes (400 invalid params, 404 missing, 409
// duplicate, 502 upstream/test-connection failure, 503/429 advisor errors)
// and JSON response shapes exactly.
//
// DEVIATION on /appliances only: the built-in queried vcenter_vms/
// vcenter_hosts unconditionally (vCenter was always core-built-in). vCenter
// is now itself a plugin that may not be installed, so those queries are
// wrapped in try/catch (dell router.js's vCenter-fallback pattern) — absence
// degrades to "no VM match" instead of throwing.
const dns = require('dns');
const api = require('./api');
const { getPoller } = require('./poller');
const {
  leaseWarnDays, certWarnDays, requestFailLookbackHours, computeIssues,
} = require('./issues');
const { createAriaAdvisor } = require('./advisor');
const { compile } = require('./compile');
const {
  badRequest, fail, parseIntStrict, isNonEmptyString, isBooleanish, toBool,
  requireIdParam, parseQueryInt,
} = require('./validate');

const publicInstance = (row) => ({
  id: row.id, name: row.name, host: row.host, username: row.username, domain: row.domain,
  sslVerify: !!row.ssl_verify, pollingIntervalMinutes: row.polling_interval_minutes,
  version: row.version, apiVersion: row.api_version, reachable: row.reachable == null ? null : !!row.reachable,
  certSubject: row.cert_subject, certIssuer: row.cert_issuer,
  certValidFrom: row.cert_valid_from, certValidTo: row.cert_valid_to,
  lastPollStatus: row.last_poll_status, lastPollError: row.last_poll_error, lastPollAt: row.last_poll_at,
});

// ── Instances CRUD ───────────────────────────────────────────────────────────

/** GET /instances — registered instances (never the credentials). */
function handleGetInstances(req, res, coreApi) {
  res.json(coreApi.db.prepare('SELECT * FROM aria_instances ORDER BY name').all().map(publicInstance));
}

/** POST /instances — register an Aria instance. */
function handlePostInstances(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  if (!isNonEmptyString(b.name, 120)) errors.push(fail('name'));
  if (!isNonEmptyString(b.host, 253)) errors.push(fail('host'));
  if (!isNonEmptyString(b.username, 256)) errors.push(fail('username'));
  if (!isNonEmptyString(b.password, 512)) errors.push(fail('password'));
  if (b.domain !== undefined && b.domain !== null && !isNonEmptyString(String(b.domain), 256) && b.domain !== '') errors.push(fail('domain'));
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (b.pollingIntervalMinutes !== undefined) {
    const n = parseIntStrict(b.pollingIntervalMinutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) errors.push(fail('pollingIntervalMinutes'));
  }
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  const name = b.name.trim();
  const host = b.host.trim();
  const dup = db.prepare('SELECT id FROM aria_instances WHERE name = ? OR host = ?').get(name, host);
  if (dup) return res.status(409).json({ error: 'An Aria Automation instance with that name or host is already registered.' });
  const info = db.prepare(`
    INSERT INTO aria_instances (name, host, username, domain, encrypted_credentials, ssl_verify, polling_interval_minutes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, host, b.username.trim(), b.domain?.trim() || null,
    coreApi.encryption.encrypt(JSON.stringify({ password: b.password })),
    toBool(b.sslVerify) ? 1 : 0, b.pollingIntervalMinutes ? parseIntStrict(b.pollingIntervalMinutes) : 15);
  const row = db.prepare('SELECT * FROM aria_instances WHERE id = ?').get(info.lastInsertRowid);
  const poller = getPoller(coreApi);
  poller.schedule(row);
  poller.trigger(row).catch(() => {});
  res.status(201).json(publicInstance(row));
}

/** PUT /instances/:id — update (password optional; blank keeps stored). */
function handlePutInstance(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const b = req.body || {};
  const errors = [];
  if (b.name !== undefined && !isNonEmptyString(b.name, 120)) errors.push(fail('name'));
  if (b.host !== undefined && !isNonEmptyString(b.host, 253)) errors.push(fail('host'));
  if (b.username !== undefined && !isNonEmptyString(b.username, 256)) errors.push(fail('username'));
  if (b.password !== undefined && b.password !== '' && !(typeof b.password === 'string' && b.password.length <= 512)) errors.push(fail('password'));
  if (b.domain !== undefined && b.domain !== null && typeof b.domain !== 'string') errors.push(fail('domain'));
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (b.pollingIntervalMinutes !== undefined) {
    const n = parseIntStrict(b.pollingIntervalMinutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) errors.push(fail('pollingIntervalMinutes'));
  }
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM aria_instances WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Aria instance not found.' });
  db.prepare(`
    UPDATE aria_instances SET
      name = ?, host = ?, username = ?, domain = ?, encrypted_credentials = ?,
      ssl_verify = ?, polling_interval_minutes = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    b.name?.trim() || row.name, b.host?.trim() || row.host, b.username?.trim() || row.username,
    b.domain !== undefined ? (b.domain?.trim() || null) : row.domain,
    b.password ? coreApi.encryption.encrypt(JSON.stringify({ password: b.password })) : row.encrypted_credentials,
    b.sslVerify !== undefined ? (toBool(b.sslVerify) ? 1 : 0) : row.ssl_verify,
    b.pollingIntervalMinutes ? parseIntStrict(b.pollingIntervalMinutes) : row.polling_interval_minutes,
    row.id
  );
  api.invalidateSession(row.id);
  const updated = db.prepare('SELECT * FROM aria_instances WHERE id = ?').get(row.id);
  getPoller(coreApi).schedule(updated);
  res.json(publicInstance(updated));
}

/** DELETE /instances/:id — unregister (CASCADE clears inventory). */
function handleDeleteInstance(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM aria_instances WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Aria instance not found.' });
  getPoller(coreApi).cancel(row.id);
  api.invalidateSession(row.id);
  db.prepare('DELETE FROM aria_instances WHERE id = ?').run(row.id);
  res.json({ deleted: true });
}

/** POST /instances/test — validate saved or candidate credentials. */
async function handlePostInstancesTest(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  if (!isNonEmptyString(b.host)) errors.push(fail('host'));
  if (!isNonEmptyString(b.username)) errors.push(fail('username'));
  if (b.password !== undefined && typeof b.password !== 'string') errors.push(fail('password'));
  if (b.domain !== undefined && b.domain !== null && typeof b.domain !== 'string') errors.push(fail('domain'));
  if (b.id !== undefined && !Number.isInteger(parseIntStrict(b.id))) errors.push(fail('id'));
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (errors.length) return badRequest(res, errors);

  const { id, host, username, password, domain, sslVerify } = b;
  let candidate = { host: host.trim(), username: username.trim(), password, domain, ssl_verify: toBool(sslVerify) ? 1 : 0 };
  if (!password && id) {
    const row = coreApi.db.prepare('SELECT * FROM aria_instances WHERE id = ?').get(parseIntStrict(id));
    if (row) candidate = { ...row, host: candidate.host, username: candidate.username, domain: candidate.domain ?? row.domain, ssl_verify: candidate.ssl_verify };
  }
  const result = await api.testConnection(candidate, coreApi);
  res.status(result.ok ? 200 : 502).json(result);
}

/** POST /instances/:id/refresh — poll this instance now. */
async function handlePostInstanceRefresh(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM aria_instances WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Aria instance not found.' });
  await getPoller(coreApi).trigger(row);
  res.json(publicInstance(db.prepare('SELECT * FROM aria_instances WHERE id = ?').get(row.id)));
}

// Each probe section runs the same fetcher the poller uses, live against the
// instance, and reports the RAW first item untransformed — this is the only
// place in the codebase that is meant to show an unmassaged upstream shape.
// Probe fetches are CAPPED (first page / first few items) — the probe exists
// to reveal shapes, and full fetchers against a 2000-deployment estate blow
// past HTTP timeouts (seen live 2026-07-28).
const PROBE_SECTIONS = [
  ['deployments', (row, coreApi) => api.fetchDeployments(row, coreApi, 25)],
  ['deploymentResources', async (row, coreApi) => api.fetchDeploymentResources(row, coreApi, await api.fetchDeployments(row, coreApi, 3))],
  ['requests', async (row, coreApi) => api.fetchRequests(row, coreApi, await api.fetchDeployments(row, coreApi, 3))],
  ['cloudAccounts', (row, coreApi) => api.fetchCloudAccounts(row, coreApi)],
  ['integrations', (row, coreApi) => api.fetchIntegrations(row, coreApi)],
  ['projects', (row, coreApi) => api.fetchProjects(row, coreApi)],
  ['catalogSources', (row, coreApi) => api.fetchCatalogSources(row, coreApi)],
  ['fabricImages', (row, coreApi) => api.fetchFabricImages(row, coreApi, 200)],
  ['imageProfiles', (row, coreApi) => api.fetchImageProfiles(row, coreApi)],
  ['flavorProfiles', (row, coreApi) => api.fetchFlavorProfiles(row, coreApi)],
  ['blueprints', (row, coreApi) => api.fetchBlueprints(row, coreApi, 3)],
  ['abxRuns', (row, coreApi) => api.fetchAbxRuns(row, coreApi)],
  ['pipelineExecutions', (row, coreApi) => api.fetchPipelineExecutions(row, coreApi)],
  ['approvals', (row, coreApi) => api.fetchApprovals(row, coreApi)],
];

/** GET /instances/:id/probe?sections=a,b — raw-shape probe, read-only. */
async function handleGetInstanceProbe(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  if (req.query.sections !== undefined && !/^[a-zA-Z,]+$/.test(String(req.query.sections))) return badRequest(res, [fail('sections')]);
  const row = coreApi.db.prepare('SELECT * FROM aria_instances WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Aria instance not found.' });
  const wanted = req.query.sections ? new Set(String(req.query.sections).split(',')) : null;
  const run = wanted ? PROBE_SECTIONS.filter(([n]) => wanted.has(n)) : PROBE_SECTIONS;
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

// ── Data endpoints ───────────────────────────────────────────────────────────

/** GET /overview — per-instance rollup + totals. */
function handleGetOverview(req, res, coreApi) {
  const db = coreApi.db;
  const instances = db.prepare('SELECT * FROM aria_instances ORDER BY name').all();
  const countsFor = (id) => {
    const dep = db.prepare(`
      SELECT COUNT(*) AS total, SUM(CASE WHEN status LIKE '%FAIL%' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN lease_expire_at IS NOT NULL AND julianday(lease_expire_at) - julianday('now') <= 7 THEN 1 ELSE 0 END) AS lease7d
      FROM aria_deployments WHERE instance_id = ?
    `).get(id);
    const ep = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN health_state IS NOT NULL AND LOWER(health_state) NOT IN ('ok','up','healthy','connected','active','available') THEN 1 ELSE 0 END) AS unhealthy
      FROM aria_endpoints WHERE instance_id = ?
    `).get(id);
    const req24 = db.prepare(`
      SELECT COUNT(*) AS total, SUM(CASE WHEN status LIKE '%FAIL%' THEN 1 ELSE 0 END) AS failed
      FROM aria_requests WHERE instance_id = ? AND captured_at >= datetime('now', '-24 hours')
    `).get(id);
    const runs24 = db.prepare(`
      SELECT COUNT(*) AS n FROM aria_runs WHERE instance_id = ? AND status LIKE '%FAIL%' AND captured_at >= datetime('now', '-24 hours')
    `).get(id).n;
    const approvalsPending = db.prepare(`
      SELECT COUNT(*) AS n FROM aria_approvals WHERE instance_id = ? AND status LIKE '%PENDING%'
    `).get(id).n;
    const projectCount = db.prepare('SELECT COUNT(*) AS n FROM aria_projects WHERE instance_id = ?').get(id).n;
    return {
      deployments: dep.total || 0, deploymentsFailed: dep.failed || 0, leaseExpiring7d: dep.lease7d || 0,
      endpoints: ep.total || 0, endpointsUnhealthy: ep.unhealthy || 0,
      requests24h: req24.total || 0, requests24hFailed: req24.failed || 0,
      runs24hFailed: runs24 || 0, approvalsPending, projects: projectCount,
    };
  };
  const perInstance = instances.map((inst) => ({
    id: inst.id, name: inst.name, host: inst.host,
    reachable: inst.reachable == null ? null : !!inst.reachable,
    version: inst.version, lastPollAt: inst.last_poll_at, lastPollStatus: inst.last_poll_status,
    certValidTo: inst.cert_valid_to, counts: countsFor(inst.id),
  }));
  const totals = perInstance.reduce((acc, i) => {
    for (const key of Object.keys(i.counts)) acc[key] = (acc[key] || 0) + i.counts[key];
    return acc;
  }, {});

  // 10 most recent successful builds with their machine resource(s); the
  // owning vCenter comes from the vCenter platform inventory by VM name.
  let recentVms = [];
  try {
    recentVms = db.prepare(`
      SELECT r.name AS vm_name, r.ip_addresses,
        d.name AS deployment_name, d.created_by, d.created_at_src, d.lease_expire_at,
        i.name AS instance_name
      FROM aria_deployments d
      JOIN aria_instances i ON i.id = d.instance_id
      JOIN aria_deployment_resources r
        ON r.instance_id = d.instance_id AND r.deployment_id = d.deployment_id
      WHERE d.status = 'CREATE_SUCCESSFUL' AND LOWER(COALESCE(r.type, '')) LIKE '%machine%'
      ORDER BY d.created_at_src DESC LIMIT 10
    `).all().map((v) => {
      let vcenter = null;
      try {
        vcenter = db.prepare(`
          SELECT vc.name FROM vcenter_vms vm JOIN vcenter_vcenters vc ON vc.id = vm.vcenter_id
          WHERE LOWER(vm.name) = LOWER(?) OR LOWER(COALESCE(vm.guest_hostname, '')) = LOWER(?)
          LIMIT 1
        `).get(v.vm_name, v.vm_name)?.name ?? null;
      } catch { /* vcenter tables absent */ }
      return { ...v, ip_addresses: v.ip_addresses ? JSON.parse(v.ip_addresses) : [], vcenter };
    });
  } catch { /* aria_deployment_resources shouldn't be absent, but stay defensive */ }

  res.json({ instances: perInstance, totals, recentVms });
}

/** GET /deployments?instanceId? */
function handleGetDeployments(req, res, coreApi) {
  const instQ = parseQueryInt(req.query.instanceId);
  if (!instQ.ok) return badRequest(res, [fail('instanceId')]);
  const db = coreApi.db;
  const clauses = [];
  const params = [];
  if (instQ.value !== undefined) { clauses.push('d.instance_id = ?'); params.push(instQ.value); }
  const rows = db.prepare(`
    SELECT d.*, i.name AS instance_name, res.resource_names
    FROM aria_deployments d
    JOIN aria_instances i ON i.id = d.instance_id
    LEFT JOIN (
      -- Machine-typed resources only: the Resource column is about server
      -- names, and network/LB components would crowd them out.
      SELECT instance_id, deployment_id, GROUP_CONCAT(name, ', ') AS resource_names
      FROM aria_deployment_resources
      WHERE LOWER(COALESCE(type, '')) LIKE '%machine%'
      GROUP BY instance_id, deployment_id
    ) res ON res.instance_id = d.instance_id AND res.deployment_id = d.deployment_id
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY i.name, d.name
  `).all(...params);
  res.json(rows.map(({ raw_json, ...d }) => ({
    ...d,
    lease_days_left: d.lease_expire_at
      ? Math.round((new Date(d.lease_expire_at).getTime() - Date.now()) / 86400000)
      : null,
  })));
}

/** GET /deployments/:id — one deployment with resources + raw payload. */
function handleGetDeploymentById(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const d = db.prepare(`
    SELECT d.*, i.name AS instance_name FROM aria_deployments d
    JOIN aria_instances i ON i.id = d.instance_id WHERE d.id = ?
  `).get(id);
  if (!d) return res.status(404).json({ error: 'Deployment not found.' });
  const resources = db.prepare(`
    SELECT * FROM aria_deployment_resources WHERE instance_id = ? AND deployment_id = ?
    ORDER BY name
  `).all(d.instance_id, d.deployment_id).map((r) => ({
    ...r, ip_addresses: r.ip_addresses ? JSON.parse(r.ip_addresses) : [],
  }));
  let raw = null;
  try { raw = d.raw_json ? JSON.parse(d.raw_json) : null; } catch { /* keep null */ }
  const { raw_json, ...row } = d;
  res.json({
    ...row,
    lease_days_left: d.lease_expire_at
      ? Math.round((new Date(d.lease_expire_at).getTime() - Date.now()) / 86400000)
      : null,
    resources, raw,
  });
}

/** GET /requests?instanceId?&limit=500 */
function handleGetRequests(req, res, coreApi) {
  const instQ = parseQueryInt(req.query.instanceId);
  if (!instQ.ok) return badRequest(res, [fail('instanceId')]);
  const limitQ = parseQueryInt(req.query.limit, 1, 5000);
  if (!limitQ.ok) return badRequest(res, [fail('limit')]);
  const db = coreApi.db;
  const clauses = [];
  const params = [];
  if (instQ.value !== undefined) { clauses.push('r.instance_id = ?'); params.push(instQ.value); }
  const limit = limitQ.value || 500;
  res.json(db.prepare(`
    SELECT r.*, i.name AS instance_name FROM aria_requests r
    JOIN aria_instances i ON i.id = r.instance_id
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY r.captured_at DESC LIMIT ?
  `).all(...params, limit));
}

/** GET /endpoints?instanceId? */
function handleGetEndpoints(req, res, coreApi) {
  const instQ = parseQueryInt(req.query.instanceId);
  if (!instQ.ok) return badRequest(res, [fail('instanceId')]);
  const db = coreApi.db;
  const clauses = [];
  const params = [];
  if (instQ.value !== undefined) { clauses.push('e.instance_id = ?'); params.push(instQ.value); }
  res.json(db.prepare(`
    SELECT e.*, i.name AS instance_name FROM aria_endpoints e
    JOIN aria_instances i ON i.id = e.instance_id
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY i.name, e.kind, e.name
  `).all(...params));
}

/**
 * GET /appliances — appliance VM performance/health, sourced from the
 * vCenter platform's inventory (SOAP quickstats). Two sections: registered
 * aria_instances matched to their VM (guest hostname / VM name / IP), and
 * other Aria-suite appliance VMs found by name pattern. vCenter is now
 * itself a plugin that may not be installed — every vcenter_* query below is
 * try/catch-wrapped and degrades to "no match" / empty rather than throwing.
 */
const SUITE_VM_PATTERNS = ['vra%', 'vrops%', 'vrli%', 'vrlcm%', 'vrslcm%', 'vrni%', '%vrealize%', '%aria-%'];

// Registered hosts are often LB/DNS aliases, not the appliance VM's own name
// (prod, 2026-07-28) — resolve the alias to its IPs and match VMs by address.
const dnsCache = new Map(); // host -> { ips, at }
async function resolveHostIps(host) {
  if (!host || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host ? [host] : [];
  const cached = dnsCache.get(host);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.ips;
  let ips = [];
  try {
    ips = await Promise.race([
      dns.promises.resolve4(host),
      new Promise((_, rej) => setTimeout(() => rej(new Error('dns timeout')), 2000)),
    ]);
  } catch { /* unresolvable — fall back to name matching only */ }
  dnsCache.set(host, { ips, at: Date.now() });
  return ips;
}

async function handleGetAppliances(req, res, coreApi) {
  const db = coreApi.db;
  const vmSelect = `
    SELECT m.id AS vm_row_id, m.name AS vm_name, m.power_state, m.overall_status,
           m.cpu_count, m.memory_mb, m.cpu_usage_mhz, m.mem_usage_mb, m.uptime_seconds,
           m.guest_hostname, m.ip_address, m.host_name, m.guest_os, v.name AS vcenter_name,
           h.cpu_mhz_capacity AS host_cpu_mhz_capacity, h.cpu_cores AS host_cpu_cores
    FROM vcenter_vms m
    JOIN vcenter_vcenters v ON v.id = m.vcenter_id
    LEFT JOIN vcenter_hosts h ON h.vcenter_id = m.vcenter_id AND h.name = m.host_name`;
  const withPct = (r) => {
    const perCore = r.host_cpu_mhz_capacity && r.host_cpu_cores ? r.host_cpu_mhz_capacity / r.host_cpu_cores : null;
    const cap = perCore && r.cpu_count ? perCore * r.cpu_count : null;
    return {
      ...r,
      cpu_pct: r.cpu_usage_mhz != null && cap ? Math.round((r.cpu_usage_mhz / cap) * 1000) / 10 : null,
      mem_pct: r.mem_usage_mb != null && r.memory_mb ? Math.round((r.mem_usage_mb / r.memory_mb) * 1000) / 10 : null,
    };
  };

  let instances = [];
  let vcenterConfigured = false;
  try {
    const matchStmt = db.prepare(`${vmSelect}
      WHERE lower(COALESCE(m.guest_hostname, '')) = lower(?)
         OR lower(COALESCE(m.name, '')) = lower(?)
         OR m.ip_address = ?
      LIMIT 1`);
    const ipStmt = db.prepare(`${vmSelect}
      WHERE m.ip_address = ? OR COALESCE(m.guest_nics, '') LIKE ?
      LIMIT 1`);
    instances = await Promise.all(db.prepare('SELECT id, name, host FROM aria_instances ORDER BY name').all().map(async (inst) => {
      const short = String(inst.host || '').split('.')[0];
      let vm = matchStmt.get(inst.host || '', short, inst.host || '');
      if (!vm) {
        for (const ip of await resolveHostIps(inst.host)) {
          vm = ipStmt.get(ip, `%"${ip}"%`);
          if (vm) break;
        }
      }
      return { ...inst, vm: vm ? withPct(vm) : null };
    }));
    vcenterConfigured = db.prepare('SELECT COUNT(*) AS n FROM vcenter_vcenters').get().n > 0;
  } catch {
    instances = db.prepare('SELECT id, name, host FROM aria_instances ORDER BY name').all().map((inst) => ({ ...inst, vm: null }));
  }

  const matchedIds = new Set(instances.map((i) => i.vm && i.vm.vm_row_id).filter(Boolean));
  let suiteVms = [];
  try {
    suiteVms = db.prepare(`${vmSelect}
      WHERE ${SUITE_VM_PATTERNS.map(() => 'lower(m.name) LIKE ?').join(' OR ')}
      ORDER BY m.name`).all(...SUITE_VM_PATTERNS)
      .filter((r) => !matchedIds.has(r.vm_row_id))
      .map(withPct);
  } catch { /* vcenter tables absent */ }

  res.json({ instances, suiteVms, vcenterConfigured });
}

/** GET /projects?instanceId? */
function handleGetProjects(req, res, coreApi) {
  const instQ = parseQueryInt(req.query.instanceId);
  if (!instQ.ok) return badRequest(res, [fail('instanceId')]);
  const db = coreApi.db;
  const clauses = [];
  const params = [];
  if (instQ.value !== undefined) { clauses.push('p.instance_id = ?'); params.push(instQ.value); }
  res.json(db.prepare(`
    SELECT p.*, i.name AS instance_name FROM aria_projects p
    JOIN aria_instances i ON i.id = p.instance_id
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY i.name, p.name
  `).all(...params));
}

/** GET /catalog-sources?instanceId? */
function handleGetCatalogSources(req, res, coreApi) {
  const instQ = parseQueryInt(req.query.instanceId);
  if (!instQ.ok) return badRequest(res, [fail('instanceId')]);
  const db = coreApi.db;
  const clauses = [];
  const params = [];
  if (instQ.value !== undefined) { clauses.push('c.instance_id = ?'); params.push(instQ.value); }
  res.json(db.prepare(`
    SELECT c.*, i.name AS instance_name FROM aria_catalog_sources c
    JOIN aria_instances i ON i.id = c.instance_id
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY i.name, c.name
  `).all(...params));
}

/** GET /images?instanceId? — fabric images (raw templates/AMIs). */
function handleGetImages(req, res, coreApi) {
  const instQ = parseQueryInt(req.query.instanceId);
  if (!instQ.ok) return badRequest(res, [fail('instanceId')]);
  const db = coreApi.db;
  const clauses = [];
  const params = [];
  if (instQ.value !== undefined) { clauses.push('img.instance_id = ?'); params.push(instQ.value); }
  res.json(db.prepare(`
    SELECT img.*, i.name AS instance_name FROM aria_images img
    JOIN aria_instances i ON i.id = img.instance_id
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY i.name, img.region, img.name
  `).all(...params));
}

/** GET /image-mappings?instanceId? — curated logical-name mappings. */
function handleGetImageMappings(req, res, coreApi) {
  const instQ = parseQueryInt(req.query.instanceId);
  if (!instQ.ok) return badRequest(res, [fail('instanceId')]);
  const db = coreApi.db;
  const clauses = [];
  const params = [];
  if (instQ.value !== undefined) { clauses.push('m.instance_id = ?'); params.push(instQ.value); }
  res.json(db.prepare(`
    SELECT m.*, i.name AS instance_name FROM aria_image_mappings m
    JOIN aria_instances i ON i.id = m.instance_id
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY i.name, m.region, m.mapping_name
  `).all(...params));
}

/** GET /flavor-mappings?instanceId? */
function handleGetFlavorMappings(req, res, coreApi) {
  const instQ = parseQueryInt(req.query.instanceId);
  if (!instQ.ok) return badRequest(res, [fail('instanceId')]);
  const db = coreApi.db;
  const clauses = [];
  const params = [];
  if (instQ.value !== undefined) { clauses.push('f.instance_id = ?'); params.push(instQ.value); }
  res.json(db.prepare(`
    SELECT f.*, i.name AS instance_name FROM aria_flavor_mappings f
    JOIN aria_instances i ON i.id = f.instance_id
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY i.name, f.region, f.mapping_name
  `).all(...params));
}

/** GET /blueprints?instanceId? */
function handleGetBlueprints(req, res, coreApi) {
  const instQ = parseQueryInt(req.query.instanceId);
  if (!instQ.ok) return badRequest(res, [fail('instanceId')]);
  const db = coreApi.db;
  const clauses = [];
  const params = [];
  if (instQ.value !== undefined) { clauses.push('b.instance_id = ?'); params.push(instQ.value); }
  res.json(db.prepare(`
    SELECT b.*, i.name AS instance_name FROM aria_blueprints b
    JOIN aria_instances i ON i.id = b.instance_id
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY i.name, b.name
  `).all(...params));
}

/**
 * GET /image-usage — per-instance usage tracing. Blueprints reference
 * image MAPPING names in their YAML; mappings point at fabric images. Returns:
 *   mappings:     [{instance_name, mapping_name, region, image_name, blueprints: [names]}]
 *   fabricImages: [{instance_name, name, region, mappings: [mapping names], blueprints: [names]}]
 * A blueprint ref that matches a fabric image NAME directly (hardcoded image)
 * also counts as usage of that image.
 */
function handleGetImageUsage(req, res, coreApi) {
  const db = coreApi.db;
  const blueprints = db.prepare(`
    SELECT b.instance_id, b.name, b.image_refs FROM aria_blueprints b
  `).all().map((b) => ({ ...b, refs: b.image_refs ? JSON.parse(b.image_refs) : [] }));
  const refsFor = (instanceId, value) =>
    blueprints.filter((b) => b.instance_id === instanceId && b.refs.includes(value)).map((b) => b.name);

  const mappings = db.prepare(`
    SELECT m.instance_id, i.name AS instance_name, m.mapping_name, m.region, m.image_name, m.image_external_id
    FROM aria_image_mappings m JOIN aria_instances i ON i.id = m.instance_id
  `).all().map((m) => ({ ...m, blueprints: refsFor(m.instance_id, m.mapping_name) }));

  // Mapping targets arrive as "template-folder / image-name" while fabric
  // images use the bare name (verified live) — compare on the last segment,
  // and accept externalId matches (it sometimes carries the template name).
  const base = (s) => String(s || '').split('/').pop().trim();
  const mappingTargets = (m) => new Set([m.image_name, base(m.image_name), m.image_external_id, base(m.image_external_id)].filter(Boolean));

  const fabricImages = db.prepare(`
    SELECT img.instance_id, i.name AS instance_name, img.name, img.region, img.created_at_src
    FROM aria_images img JOIN aria_instances i ON i.id = img.instance_id
  `).all().map((img) => {
    const viaMappings = mappings.filter((m) => m.instance_id === img.instance_id && mappingTargets(m).has(img.name));
    const direct = refsFor(img.instance_id, img.name);
    const blueprintNames = [...new Set([...viaMappings.flatMap((m) => m.blueprints), ...direct])];
    return {
      instance_id: img.instance_id, instance_name: img.instance_name, name: img.name,
      region: img.region, created_at_src: img.created_at_src,
      mappings: [...new Set(viaMappings.map((m) => m.mapping_name))],
      blueprints: blueprintNames,
    };
  });

  res.json({ mappings, fabricImages, blueprintCount: blueprints.length });
}

/** GET /runs?instanceId?&kind? */
function handleGetRuns(req, res, coreApi) {
  const instQ = parseQueryInt(req.query.instanceId);
  if (!instQ.ok) return badRequest(res, [fail('instanceId')]);
  if (req.query.kind !== undefined && !['abx', 'pipeline'].includes(req.query.kind)) return badRequest(res, [fail('kind')]);
  const db = coreApi.db;
  const clauses = [];
  const params = [];
  if (instQ.value !== undefined) { clauses.push('r.instance_id = ?'); params.push(instQ.value); }
  if (req.query.kind) { clauses.push('r.kind = ?'); params.push(req.query.kind); }
  res.json(db.prepare(`
    SELECT r.*, i.name AS instance_name FROM aria_runs r
    JOIN aria_instances i ON i.id = r.instance_id
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY r.captured_at DESC LIMIT 2000
  `).all(...params));
}

/** GET /approvals?instanceId? */
function handleGetApprovals(req, res, coreApi) {
  const instQ = parseQueryInt(req.query.instanceId);
  if (!instQ.ok) return badRequest(res, [fail('instanceId')]);
  const db = coreApi.db;
  const clauses = [];
  const params = [];
  if (instQ.value !== undefined) { clauses.push('a.instance_id = ?'); params.push(instQ.value); }
  res.json(db.prepare(`
    SELECT a.*, i.name AS instance_name FROM aria_approvals a
    JOIN aria_instances i ON i.id = a.instance_id
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY a.captured_at DESC
  `).all(...params));
}

/** GET /metrics-history?instanceId&hours=168 */
function handleGetMetricsHistory(req, res, coreApi) {
  const instQ = parseQueryInt(req.query.instanceId);
  if (!instQ.ok) return badRequest(res, [fail('instanceId')]);
  const hoursQ = parseQueryInt(req.query.hours, 1, 8760);
  if (!hoursQ.ok) return badRequest(res, [fail('hours')]);
  const db = coreApi.db;
  const hours = hoursQ.value || 168;
  const clauses = [`m.captured_at >= datetime('now', '-${hours} hours')`];
  const params = [];
  if (instQ.value !== undefined) { clauses.push('m.instance_id = ?'); params.push(instQ.value); }
  res.json(db.prepare(`
    SELECT m.*, i.name AS instance_name FROM aria_metrics_history m
    JOIN aria_instances i ON i.id = m.instance_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY m.captured_at
  `).all(...params));
}

/** GET /issues — computed attention items. */
function handleGetIssues(req, res, coreApi) {
  res.json(computeIssues(coreApi));
}

/** GET /issue-history?days= — detected-issue lifecycle (open first). */
function handleGetIssueHistory(req, res, coreApi) {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
  res.json(coreApi.db.prepare(`
    SELECT * FROM aria_issue_history
    WHERE status = 'open' OR last_seen >= datetime('now', ?)
    ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, last_seen DESC
  `).all(`-${days} days`));
}

/** GET /config — alert thresholds. */
function handleGetConfig(req, res, coreApi) {
  res.json({
    leaseWarnDays: leaseWarnDays(coreApi),
    certWarnDays: certWarnDays(coreApi),
    requestFailLookbackHours: requestFailLookbackHours(coreApi),
  });
}

/** PUT /config — save alert thresholds. */
function handlePutConfig(req, res, coreApi) {
  const b = req.body || {};
  const lease = parseIntStrict(b.leaseWarnDays);
  const cert = parseIntStrict(b.certWarnDays);
  const lookback = parseIntStrict(b.requestFailLookbackHours);
  const errors = [];
  if (!Number.isInteger(lease) || lease < 1 || lease > 60) errors.push(fail('leaseWarnDays'));
  if (!Number.isInteger(cert) || cert < 1 || cert > 365) errors.push(fail('certWarnDays'));
  if (!Number.isInteger(lookback) || lookback < 1 || lookback > 168) errors.push(fail('requestFailLookbackHours'));
  if (errors.length) return badRequest(res, errors);

  coreApi.settings.setSetting('aria_lease_warn_days', String(lease));
  coreApi.settings.setSetting('aria_cert_warn_days', String(cert));
  coreApi.settings.setSetting('aria_request_fail_lookback_hours', String(lookback));
  res.json({
    saved: true, leaseWarnDays: leaseWarnDays(coreApi), certWarnDays: certWarnDays(coreApi),
    requestFailLookbackHours: requestFailLookbackHours(coreApi),
  });
}

// ── AI Advisor ───────────────────────────────────────────────────────────────

let advisorInstance = null;
function getAdvisor(coreApi) {
  if (!advisorInstance) advisorInstance = createAriaAdvisor(coreApi);
  return advisorInstance;
}

function advisorReportKey(slug) {
  return String(slug).replace(/-/g, '_');
}

/** GET /advisor/:report — cached Aria AI Advisor report. */
function handleGetAdvisorReport(req, res, coreApi) {
  if (!isNonEmptyString(req.params.report)) return badRequest(res, [fail('report')]);
  const ariaAdvisor = getAdvisor(coreApi);
  const key = advisorReportKey(req.params.report);
  if (!ariaAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
  res.json({ enabled: ariaAdvisor.isConfigured(), report: ariaAdvisor.getCachedReport(key) });
}

/** POST /advisor/:report — (re)generate and cache an Aria AI Advisor report. */
async function handlePostAdvisorReport(req, res, coreApi) {
  if (!isNonEmptyString(req.params.report)) return badRequest(res, [fail('report')]);
  const ariaAdvisor = getAdvisor(coreApi);
  const key = advisorReportKey(req.params.report);
  if (!ariaAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
  try {
    const result = await ariaAdvisor.generateReport(key);
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

const ROUTES = [
  { method: 'GET', ...compile('/instances'), handler: handleGetInstances },
  { method: 'POST', ...compile('/instances'), handler: handlePostInstances },
  { method: 'PUT', ...compile('/instances/:id'), handler: handlePutInstance },
  { method: 'DELETE', ...compile('/instances/:id'), handler: handleDeleteInstance },
  { method: 'POST', ...compile('/instances/test'), handler: handlePostInstancesTest },
  { method: 'POST', ...compile('/instances/:id/refresh'), handler: handlePostInstanceRefresh },
  { method: 'GET', ...compile('/instances/:id/probe'), handler: handleGetInstanceProbe },
  { method: 'GET', ...compile('/overview'), handler: handleGetOverview },
  { method: 'GET', ...compile('/deployments'), handler: handleGetDeployments },
  { method: 'GET', ...compile('/deployments/:id'), handler: handleGetDeploymentById },
  { method: 'GET', ...compile('/requests'), handler: handleGetRequests },
  { method: 'GET', ...compile('/endpoints'), handler: handleGetEndpoints },
  { method: 'GET', ...compile('/appliances'), handler: handleGetAppliances },
  { method: 'GET', ...compile('/projects'), handler: handleGetProjects },
  { method: 'GET', ...compile('/catalog-sources'), handler: handleGetCatalogSources },
  { method: 'GET', ...compile('/images'), handler: handleGetImages },
  { method: 'GET', ...compile('/image-mappings'), handler: handleGetImageMappings },
  { method: 'GET', ...compile('/flavor-mappings'), handler: handleGetFlavorMappings },
  { method: 'GET', ...compile('/blueprints'), handler: handleGetBlueprints },
  { method: 'GET', ...compile('/image-usage'), handler: handleGetImageUsage },
  { method: 'GET', ...compile('/runs'), handler: handleGetRuns },
  { method: 'GET', ...compile('/approvals'), handler: handleGetApprovals },
  { method: 'GET', ...compile('/metrics-history'), handler: handleGetMetricsHistory },
  { method: 'GET', ...compile('/issues'), handler: handleGetIssues },
  { method: 'GET', ...compile('/issue-history'), handler: handleGetIssueHistory },
  { method: 'GET', ...compile('/config'), handler: handleGetConfig },
  { method: 'PUT', ...compile('/config'), handler: handlePutConfig },
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
  return function ariaRouter(req, res, next) {
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
