// Aria Automation routes. Mounted by the plugin dispatcher at /api/aria —
// paths are relative. Registration CRUD stores the password AES-encrypted;
// data endpoints serve the polled aria_* tables plus computed issues. The
// probe route hits the live instance and returns untransformed raw
// responses — every upstream shape here is UNVERIFIED, so this is the tool
// for finding out what a real vRA actually sends back.
const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const db = require('../db/database');
const { encrypt } = require('../services/encryption');
const { setSetting } = require('../services/settings');
const ariaApi = require('../services/ariaApi');
const { ariaPoller } = require('../services/ariaPoller');
const {
  leaseWarnDays, certWarnDays, requestFailLookbackHours, computeIssues,
} = require('../services/ariaIssues');
const ariaAdvisor = require('../services/advisors/ariaAdvisor');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid parameters', details: errors.array() });
  next();
};

const publicInstance = (row) => ({
  id: row.id, name: row.name, host: row.host, username: row.username, domain: row.domain,
  sslVerify: !!row.ssl_verify, pollingIntervalMinutes: row.polling_interval_minutes,
  version: row.version, apiVersion: row.api_version, reachable: row.reachable == null ? null : !!row.reachable,
  certSubject: row.cert_subject, certIssuer: row.cert_issuer,
  certValidFrom: row.cert_valid_from, certValidTo: row.cert_valid_to,
  lastPollStatus: row.last_poll_status, lastPollError: row.last_poll_error, lastPollAt: row.last_poll_at,
});

// ── Instances CRUD ───────────────────────────────────────────────────────────

/** GET /api/aria/instances — registered instances (never the credentials). */
router.get('/instances', (req, res, next) => {
  try {
    res.json(db.prepare('SELECT * FROM aria_instances ORDER BY name').all().map(publicInstance));
  } catch (err) { next(err); }
});

/** POST /api/aria/instances — register an Aria instance. */
router.post('/instances', [
  body('name').isString().trim().notEmpty().isLength({ max: 120 }),
  body('host').isString().trim().notEmpty().isLength({ max: 253 }),
  body('username').isString().trim().notEmpty().isLength({ max: 256 }),
  body('password').isString().notEmpty().isLength({ max: 512 }),
  body('domain').optional().isString().trim().isLength({ max: 256 }),
  body('sslVerify').optional().isBoolean(),
  body('pollingIntervalMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
], validate, (req, res, next) => {
  try {
    const { name, host, username, password, domain, sslVerify, pollingIntervalMinutes } = req.body;
    const dup = db.prepare('SELECT id FROM aria_instances WHERE name = ? OR host = ?').get(name.trim(), host.trim());
    if (dup) return res.status(409).json({ error: 'An Aria Automation instance with that name or host is already registered.' });
    const info = db.prepare(`
      INSERT INTO aria_instances (name, host, username, domain, encrypted_credentials, ssl_verify, polling_interval_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(name.trim(), host.trim(), username.trim(), domain?.trim() || null,
      encrypt(JSON.stringify({ password })), sslVerify ? 1 : 0, pollingIntervalMinutes || 15);
    const row = db.prepare('SELECT * FROM aria_instances WHERE id = ?').get(info.lastInsertRowid);
    ariaPoller.schedule(row);
    ariaPoller.trigger(row).catch(() => {});
    res.status(201).json(publicInstance(row));
  } catch (err) { next(err); }
});

/** PUT /api/aria/instances/:id — update (password optional; blank keeps stored). */
router.put('/instances/:id', [
  param('id').isInt().toInt(),
  body('name').optional().isString().trim().notEmpty().isLength({ max: 120 }),
  body('host').optional().isString().trim().notEmpty().isLength({ max: 253 }),
  body('username').optional().isString().trim().notEmpty().isLength({ max: 256 }),
  body('password').optional().isString().isLength({ max: 512 }),
  body('domain').optional().isString().trim().isLength({ max: 256 }),
  body('sslVerify').optional().isBoolean(),
  body('pollingIntervalMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM aria_instances WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Aria instance not found.' });
    const b = req.body;
    db.prepare(`
      UPDATE aria_instances SET
        name = ?, host = ?, username = ?, domain = ?, encrypted_credentials = ?,
        ssl_verify = ?, polling_interval_minutes = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      b.name?.trim() || row.name, b.host?.trim() || row.host, b.username?.trim() || row.username,
      b.domain !== undefined ? (b.domain?.trim() || null) : row.domain,
      b.password ? encrypt(JSON.stringify({ password: b.password })) : row.encrypted_credentials,
      b.sslVerify !== undefined ? (b.sslVerify ? 1 : 0) : row.ssl_verify,
      b.pollingIntervalMinutes || row.polling_interval_minutes,
      row.id
    );
    ariaApi.invalidateSession(row.id);
    const updated = db.prepare('SELECT * FROM aria_instances WHERE id = ?').get(row.id);
    ariaPoller.schedule(updated);
    res.json(publicInstance(updated));
  } catch (err) { next(err); }
});

/** DELETE /api/aria/instances/:id — unregister (CASCADE clears inventory). */
router.delete('/instances/:id', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM aria_instances WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Aria instance not found.' });
    ariaPoller.cancel(row.id);
    ariaApi.invalidateSession(row.id);
    db.prepare('DELETE FROM aria_instances WHERE id = ?').run(row.id);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

/** POST /api/aria/instances/test — validate saved or candidate credentials. */
router.post('/instances/test', [
  body('host').isString().trim().notEmpty(),
  body('username').isString().trim().notEmpty(),
  body('password').optional().isString(),
  body('domain').optional().isString(),
  body('id').optional().isInt().toInt(),
  body('sslVerify').optional().isBoolean(),
], validate, async (req, res) => {
  const { id, host, username, password, domain, sslVerify } = req.body;
  let candidate = { host: host.trim(), username: username.trim(), password, domain, ssl_verify: sslVerify ? 1 : 0 };
  if (!password && id) {
    const row = db.prepare('SELECT * FROM aria_instances WHERE id = ?').get(id);
    if (row) candidate = { ...row, host: candidate.host, username: candidate.username, domain: candidate.domain ?? row.domain, ssl_verify: candidate.ssl_verify };
  }
  const result = await ariaApi.testConnection(candidate);
  res.status(result.ok ? 200 : 502).json(result);
});

/** POST /api/aria/instances/:id/refresh — poll this instance now. */
router.post('/instances/:id/refresh', [param('id').isInt().toInt()], validate, async (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM aria_instances WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Aria instance not found.' });
    await ariaPoller.trigger(row);
    res.json(publicInstance(db.prepare('SELECT * FROM aria_instances WHERE id = ?').get(row.id)));
  } catch (err) { next(err); }
});

// Each probe section runs the same fetcher the poller uses, live against the
// instance, and reports the RAW first item untransformed — this is the only
// place in the codebase that is meant to show an unmassaged upstream shape.
const PROBE_SECTIONS = [
  ['deployments', (row) => ariaApi.fetchDeployments(row)],
  ['deploymentResources', async (row) => ariaApi.fetchDeploymentResources(row, (await ariaApi.fetchDeployments(row)).slice(0, 3))],
  ['requests', (row) => ariaApi.fetchRequests(row)],
  ['cloudAccounts', (row) => ariaApi.fetchCloudAccounts(row)],
  ['integrations', (row) => ariaApi.fetchIntegrations(row)],
  ['projects', (row) => ariaApi.fetchProjects(row)],
  ['catalogSources', (row) => ariaApi.fetchCatalogSources(row)],
  ['fabricImages', (row) => ariaApi.fetchFabricImages(row)],
  ['imageProfiles', (row) => ariaApi.fetchImageProfiles(row)],
  ['flavorProfiles', (row) => ariaApi.fetchFlavorProfiles(row)],
  ['blueprints', (row) => ariaApi.fetchBlueprints(row)],
  ['abxRuns', (row) => ariaApi.fetchAbxRuns(row)],
  ['pipelineExecutions', (row) => ariaApi.fetchPipelineExecutions(row)],
  ['approvals', (row) => ariaApi.fetchApprovals(row)],
];

/** GET /api/aria/instances/:id/probe — raw-shape probe, read-only. */
router.get('/instances/:id/probe', [param('id').isInt().toInt()], validate, async (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM aria_instances WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Aria instance not found.' });
    const sections = {};
    for (const [name, fn] of PROBE_SECTIONS) {
      try {
        const items = await fn(row);
        sections[name] = { ok: true, count: Array.isArray(items) ? items.length : undefined, firstItem: Array.isArray(items) ? (items[0] ?? null) : items };
      } catch (err) {
        sections[name] = { ok: false, error: err.response?.data?.message || err.message };
      }
    }
    res.json({ sections });
  } catch (err) { next(err); }
});

// ── Data endpoints ───────────────────────────────────────────────────────────

/** GET /api/aria/overview — per-instance rollup + totals. */
router.get('/overview', (req, res, next) => {
  try {
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
    res.json({ instances: perInstance, totals });
  } catch (err) { next(err); }
});

/** GET /api/aria/deployments?instanceId? */
router.get('/deployments', [query('instanceId').optional().isInt().toInt()], validate, (req, res, next) => {
  try {
    const clauses = [];
    const params = [];
    if (req.query.instanceId) { clauses.push('d.instance_id = ?'); params.push(req.query.instanceId); }
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
  } catch (err) { next(err); }
});

/** GET /api/aria/deployments/:id — one deployment with resources + raw payload. */
router.get('/deployments/:id', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const d = db.prepare(`
      SELECT d.*, i.name AS instance_name FROM aria_deployments d
      JOIN aria_instances i ON i.id = d.instance_id WHERE d.id = ?
    `).get(req.params.id);
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
  } catch (err) { next(err); }
});

/** GET /api/aria/requests?instanceId?&limit=500 */
router.get('/requests', [
  query('instanceId').optional().isInt().toInt(),
  query('limit').optional().isInt({ min: 1, max: 5000 }).toInt(),
], validate, (req, res, next) => {
  try {
    const clauses = [];
    const params = [];
    if (req.query.instanceId) { clauses.push('r.instance_id = ?'); params.push(req.query.instanceId); }
    const limit = req.query.limit || 500;
    res.json(db.prepare(`
      SELECT r.*, i.name AS instance_name FROM aria_requests r
      JOIN aria_instances i ON i.id = r.instance_id
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY r.captured_at DESC LIMIT ?
    `).all(...params, limit));
  } catch (err) { next(err); }
});

/** GET /api/aria/endpoints?instanceId? */
router.get('/endpoints', [query('instanceId').optional().isInt().toInt()], validate, (req, res, next) => {
  try {
    const clauses = [];
    const params = [];
    if (req.query.instanceId) { clauses.push('e.instance_id = ?'); params.push(req.query.instanceId); }
    res.json(db.prepare(`
      SELECT e.*, i.name AS instance_name FROM aria_endpoints e
      JOIN aria_instances i ON i.id = e.instance_id
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY i.name, e.kind, e.name
    `).all(...params));
  } catch (err) { next(err); }
});

/**
 * GET /api/aria/appliances — appliance VM performance/health, sourced from the
 * vCenter platform's inventory (SOAP quickstats). Two sections: registered
 * aria_instances matched to their VM (guest hostname / VM name / IP), and
 * other Aria-suite appliance VMs found by name pattern.
 */
const SUITE_VM_PATTERNS = ['vra%', 'vrops%', 'vrli%', 'vrlcm%', 'vrslcm%', 'vrni%', '%vrealize%', '%aria-%'];

router.get('/appliances', (req, res, next) => {
  try {
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

    const matchStmt = db.prepare(`${vmSelect}
      WHERE lower(COALESCE(m.guest_hostname, '')) = lower(?)
         OR lower(COALESCE(m.name, '')) = lower(?)
         OR m.ip_address = ?
      LIMIT 1`);
    const instances = db.prepare('SELECT id, name, host FROM aria_instances ORDER BY name').all().map((inst) => {
      const short = String(inst.host || '').split('.')[0];
      const vm = matchStmt.get(inst.host || '', short, inst.host || '');
      return { ...inst, vm: vm ? withPct(vm) : null };
    });

    const matchedIds = new Set(instances.map((i) => i.vm && i.vm.vm_row_id).filter(Boolean));
    const suiteVms = db.prepare(`${vmSelect}
      WHERE ${SUITE_VM_PATTERNS.map(() => 'lower(m.name) LIKE ?').join(' OR ')}
      ORDER BY m.name`).all(...SUITE_VM_PATTERNS)
      .filter((r) => !matchedIds.has(r.vm_row_id))
      .map(withPct);

    res.json({
      instances,
      suiteVms,
      vcenterConfigured: db.prepare('SELECT COUNT(*) AS n FROM vcenter_vcenters').get().n > 0,
    });
  } catch (err) { next(err); }
});

/** GET /api/aria/projects?instanceId? */
router.get('/projects', [query('instanceId').optional().isInt().toInt()], validate, (req, res, next) => {
  try {
    const clauses = [];
    const params = [];
    if (req.query.instanceId) { clauses.push('p.instance_id = ?'); params.push(req.query.instanceId); }
    res.json(db.prepare(`
      SELECT p.*, i.name AS instance_name FROM aria_projects p
      JOIN aria_instances i ON i.id = p.instance_id
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY i.name, p.name
    `).all(...params));
  } catch (err) { next(err); }
});

/** GET /api/aria/catalog-sources?instanceId? */
router.get('/catalog-sources', [query('instanceId').optional().isInt().toInt()], validate, (req, res, next) => {
  try {
    const clauses = [];
    const params = [];
    if (req.query.instanceId) { clauses.push('c.instance_id = ?'); params.push(req.query.instanceId); }
    res.json(db.prepare(`
      SELECT c.*, i.name AS instance_name FROM aria_catalog_sources c
      JOIN aria_instances i ON i.id = c.instance_id
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY i.name, c.name
    `).all(...params));
  } catch (err) { next(err); }
});

/** GET /api/aria/images?instanceId? — fabric images (raw templates/AMIs). */
router.get('/images', [query('instanceId').optional().isInt().toInt()], validate, (req, res, next) => {
  try {
    const clauses = [];
    const params = [];
    if (req.query.instanceId) { clauses.push('img.instance_id = ?'); params.push(req.query.instanceId); }
    res.json(db.prepare(`
      SELECT img.*, i.name AS instance_name FROM aria_images img
      JOIN aria_instances i ON i.id = img.instance_id
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY i.name, img.region, img.name
    `).all(...params));
  } catch (err) { next(err); }
});

/** GET /api/aria/image-mappings?instanceId? — curated logical-name mappings. */
router.get('/image-mappings', [query('instanceId').optional().isInt().toInt()], validate, (req, res, next) => {
  try {
    const clauses = [];
    const params = [];
    if (req.query.instanceId) { clauses.push('m.instance_id = ?'); params.push(req.query.instanceId); }
    res.json(db.prepare(`
      SELECT m.*, i.name AS instance_name FROM aria_image_mappings m
      JOIN aria_instances i ON i.id = m.instance_id
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY i.name, m.region, m.mapping_name
    `).all(...params));
  } catch (err) { next(err); }
});

/** GET /api/aria/flavor-mappings?instanceId? */
router.get('/flavor-mappings', [query('instanceId').optional().isInt().toInt()], validate, (req, res, next) => {
  try {
    const clauses = [];
    const params = [];
    if (req.query.instanceId) { clauses.push('f.instance_id = ?'); params.push(req.query.instanceId); }
    res.json(db.prepare(`
      SELECT f.*, i.name AS instance_name FROM aria_flavor_mappings f
      JOIN aria_instances i ON i.id = f.instance_id
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY i.name, f.region, f.mapping_name
    `).all(...params));
  } catch (err) { next(err); }
});

/** GET /api/aria/blueprints?instanceId? */
router.get('/blueprints', [query('instanceId').optional().isInt().toInt()], validate, (req, res, next) => {
  try {
    const clauses = [];
    const params = [];
    if (req.query.instanceId) { clauses.push('b.instance_id = ?'); params.push(req.query.instanceId); }
    res.json(db.prepare(`
      SELECT b.*, i.name AS instance_name FROM aria_blueprints b
      JOIN aria_instances i ON i.id = b.instance_id
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY i.name, b.name
    `).all(...params));
  } catch (err) { next(err); }
});

/**
 * GET /api/aria/image-usage — per-instance usage tracing. Blueprints reference
 * image MAPPING names in their YAML; mappings point at fabric images. Returns:
 *   mappings:     [{instance_name, mapping_name, region, image_name, blueprints: [names]}]
 *   fabricImages: [{instance_name, name, region, mappings: [mapping names], blueprints: [names]}]
 * A blueprint ref that matches a fabric image NAME directly (hardcoded image)
 * also counts as usage of that image.
 */
router.get('/image-usage', (req, res, next) => {
  try {
    const blueprints = db.prepare(`
      SELECT b.instance_id, b.name, b.image_refs FROM aria_blueprints b
    `).all().map((b) => ({ ...b, refs: b.image_refs ? JSON.parse(b.image_refs) : [] }));
    const refsFor = (instanceId, value) =>
      blueprints.filter((b) => b.instance_id === instanceId && b.refs.includes(value)).map((b) => b.name);

    const mappings = db.prepare(`
      SELECT m.instance_id, i.name AS instance_name, m.mapping_name, m.region, m.image_name
      FROM aria_image_mappings m JOIN aria_instances i ON i.id = m.instance_id
    `).all().map((m) => ({ ...m, blueprints: refsFor(m.instance_id, m.mapping_name) }));

    const fabricImages = db.prepare(`
      SELECT img.instance_id, i.name AS instance_name, img.name, img.region, img.created_at_src
      FROM aria_images img JOIN aria_instances i ON i.id = img.instance_id
    `).all().map((img) => {
      const viaMappings = mappings.filter((m) => m.instance_id === img.instance_id && m.image_name === img.name);
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
  } catch (err) { next(err); }
});

/** GET /api/aria/runs?instanceId?&kind? */
router.get('/runs', [
  query('instanceId').optional().isInt().toInt(),
  query('kind').optional().isIn(['abx', 'pipeline']),
], validate, (req, res, next) => {
  try {
    const clauses = [];
    const params = [];
    if (req.query.instanceId) { clauses.push('r.instance_id = ?'); params.push(req.query.instanceId); }
    if (req.query.kind) { clauses.push('r.kind = ?'); params.push(req.query.kind); }
    res.json(db.prepare(`
      SELECT r.*, i.name AS instance_name FROM aria_runs r
      JOIN aria_instances i ON i.id = r.instance_id
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY r.captured_at DESC LIMIT 2000
    `).all(...params));
  } catch (err) { next(err); }
});

/** GET /api/aria/approvals?instanceId? */
router.get('/approvals', [query('instanceId').optional().isInt().toInt()], validate, (req, res, next) => {
  try {
    const clauses = [];
    const params = [];
    if (req.query.instanceId) { clauses.push('a.instance_id = ?'); params.push(req.query.instanceId); }
    res.json(db.prepare(`
      SELECT a.*, i.name AS instance_name FROM aria_approvals a
      JOIN aria_instances i ON i.id = a.instance_id
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY a.captured_at DESC
    `).all(...params));
  } catch (err) { next(err); }
});

/** GET /api/aria/metrics-history?instanceId&hours=168 */
router.get('/metrics-history', [
  query('instanceId').optional().isInt().toInt(),
  query('hours').optional().isInt({ min: 1, max: 8760 }).toInt(),
], validate, (req, res, next) => {
  try {
    const hours = req.query.hours || 168;
    const clauses = [`m.captured_at >= datetime('now', '-${hours} hours')`];
    const params = [];
    if (req.query.instanceId) { clauses.push('m.instance_id = ?'); params.push(req.query.instanceId); }
    res.json(db.prepare(`
      SELECT m.*, i.name AS instance_name FROM aria_metrics_history m
      JOIN aria_instances i ON i.id = m.instance_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY m.captured_at
    `).all(...params));
  } catch (err) { next(err); }
});

/** GET /api/aria/issues — computed attention items. */
router.get('/issues', (req, res, next) => {
  try {
    res.json(computeIssues());
  } catch (err) { next(err); }
});

/** GET /api/aria/config — alert thresholds. */
router.get('/config', (req, res, next) => {
  try {
    res.json({
      leaseWarnDays: leaseWarnDays(),
      certWarnDays: certWarnDays(),
      requestFailLookbackHours: requestFailLookbackHours(),
    });
  } catch (err) { next(err); }
});

/** PUT /api/aria/config — save alert thresholds. */
router.put('/config', [
  body('leaseWarnDays').isInt({ min: 1, max: 60 }).toInt(),
  body('certWarnDays').isInt({ min: 1, max: 365 }).toInt(),
  body('requestFailLookbackHours').isInt({ min: 1, max: 168 }).toInt(),
], validate, (req, res, next) => {
  try {
    setSetting('aria_lease_warn_days', String(req.body.leaseWarnDays));
    setSetting('aria_cert_warn_days', String(req.body.certWarnDays));
    setSetting('aria_request_fail_lookback_hours', String(req.body.requestFailLookbackHours));
    res.json({
      saved: true, leaseWarnDays: leaseWarnDays(), certWarnDays: certWarnDays(),
      requestFailLookbackHours: requestFailLookbackHours(),
    });
  } catch (err) { next(err); }
});

function advisorReportKey(slug) {
  return String(slug).replace(/-/g, '_');
}

/** GET /api/aria/advisor/:report — cached Aria AI Advisor report. */
router.get('/advisor/:report', [param('report').isString()], validate, (req, res, next) => {
  try {
    const key = advisorReportKey(req.params.report);
    if (!ariaAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
    res.json({ enabled: ariaAdvisor.isConfigured(), report: ariaAdvisor.getCachedReport(key) });
  } catch (err) { next(err); }
});

/** POST /api/aria/advisor/:report — (re)generate and cache an Aria AI Advisor report. */
router.post('/advisor/:report', [param('report').isString()], validate, async (req, res, next) => {
  try {
    const key = advisorReportKey(req.params.report);
    if (!ariaAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
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
    next(err);
  }
});

module.exports = router;
