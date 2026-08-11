// Nutanix routes. Mounted by the plugin dispatcher at /api/nutanix — paths
// are relative. Registration CRUD stores passwords AES-encrypted; data
// endpoints serve the polled nutanix_* tables plus computed issues.
const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const db = require('../db/database');
const { encrypt } = require('../services/encryption');
const { setSetting } = require('../services/settings');
const nutanixApi = require('../services/nutanixApi');
const moveApi = require('../services/nutanixMoveApi');
const { nutanixPoller, nutanixMovePoller } = require('../services/nutanixPoller');
const {
  containerWarnPct, containerCritPct, clusterWarnPct, clusterCritPct, rpoGracePct, runwayWarnDays,
  computeIssues, computeRpoCompliance,
} = require('../services/nutanixIssues');
const nutanixAdvisor = require('../services/advisors/nutanixAdvisor');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid parameters', details: errors.array() });
  next();
};

// ── Public shapes (never leak encrypted_credentials/username/password) ─────

const publicSource = (row) => ({
  id: row.id, name: row.name, sourceType: row.source_type, host: row.host, port: row.port,
  sslVerify: !!row.ssl_verify, pollingIntervalMinutes: row.polling_interval_minutes,
  isCe: !!row.is_ce, apiFlavor: row.api_flavor, productVersion: row.product_version,
  lastPollStatus: row.last_poll_status, lastPollError: row.last_poll_error, lastPollAt: row.last_poll_at,
  clusterCount: db.prepare('SELECT COUNT(*) n FROM nutanix_clusters WHERE source_id = ?').get(row.id).n,
});

const publicMoveConn = (row) => ({
  id: row.id, name: row.name, host: row.host, sslVerify: !!row.ssl_verify,
  applianceVersion: row.appliance_version, lastPollStatus: row.last_poll_status,
  lastPollError: row.last_poll_error, lastPollAt: row.last_poll_at,
  planCount: db.prepare('SELECT COUNT(*) n FROM nutanix_move_plans WHERE conn_id = ?').get(row.id).n,
});

// ── Source registration CRUD ────────────────────────────────────────────────

router.get('/sources', (req, res, next) => {
  try {
    res.json({ sources: db.prepare('SELECT * FROM nutanix_sources ORDER BY name').all().map(publicSource) });
  } catch (err) { next(err); }
});

router.post('/sources', [
  body('name').isString().trim().notEmpty().isLength({ max: 120 }),
  body('sourceType').isIn(['prism_central', 'prism_element']),
  body('host').isString().trim().notEmpty().isLength({ max: 253 }),
  body('port').optional().isInt({ min: 1, max: 65535 }).toInt(),
  body('username').isString().trim().notEmpty().isLength({ max: 256 }),
  body('password').isString().notEmpty().isLength({ max: 512 }),
  body('sslVerify').optional().isBoolean(),
  body('pollingIntervalMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
], validate, (req, res, next) => {
  try {
    const { name, sourceType, host, port, username, password, sslVerify, pollingIntervalMinutes } = req.body;
    const dup = db.prepare('SELECT id FROM nutanix_sources WHERE name = ? OR (host = ? AND source_type = ?)')
      .get(name.trim(), host.trim(), sourceType);
    if (dup) return res.status(409).json({ error: 'A Nutanix source with that name or host+type is already registered.' });
    const info = db.prepare(`
      INSERT INTO nutanix_sources (name, source_type, host, port, username, encrypted_credentials,
        ssl_verify, polling_interval_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name.trim(), sourceType, host.trim(), port || 9440, username.trim(),
      encrypt(JSON.stringify({ password })), sslVerify ? 1 : 0, pollingIntervalMinutes || 15);
    const row = db.prepare('SELECT * FROM nutanix_sources WHERE id = ?').get(info.lastInsertRowid);
    nutanixPoller.schedule(row);
    nutanixPoller.trigger(row).catch(() => {});
    res.status(201).json({ source: publicSource(row) });
  } catch (err) { next(err); }
});

router.put('/sources/:id', [
  param('id').isInt().toInt(),
  body('name').optional().isString().trim().notEmpty().isLength({ max: 120 }),
  body('sourceType').optional().isIn(['prism_central', 'prism_element']),
  body('host').optional().isString().trim().notEmpty().isLength({ max: 253 }),
  body('port').optional().isInt({ min: 1, max: 65535 }).toInt(),
  body('username').optional().isString().trim().notEmpty().isLength({ max: 256 }),
  body('password').optional().isString().isLength({ max: 512 }),
  body('sslVerify').optional().isBoolean(),
  body('pollingIntervalMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM nutanix_sources WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Nutanix source not found.' });
    const b = req.body;
    db.prepare(`
      UPDATE nutanix_sources SET
        name = ?, source_type = ?, host = ?, port = ?, username = ?, encrypted_credentials = ?,
        ssl_verify = ?, polling_interval_minutes = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      b.name?.trim() || row.name, b.sourceType || row.source_type, b.host?.trim() || row.host,
      b.port || row.port, b.username?.trim() || row.username,
      b.password ? encrypt(JSON.stringify({ password: b.password })) : row.encrypted_credentials,
      b.sslVerify !== undefined ? (b.sslVerify ? 1 : 0) : row.ssl_verify,
      b.pollingIntervalMinutes || row.polling_interval_minutes,
      row.id
    );
    nutanixApi.invalidateSession(row.id);
    const updated = db.prepare('SELECT * FROM nutanix_sources WHERE id = ?').get(row.id);
    nutanixPoller.schedule(updated);
    res.json({ source: publicSource(updated) });
  } catch (err) { next(err); }
});

router.delete('/sources/:id', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM nutanix_sources WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Nutanix source not found.' });
    nutanixPoller.cancel(row.id);
    nutanixApi.invalidateSession(row.id);
    db.prepare('DELETE FROM nutanix_sources WHERE id = ?').run(row.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/sources/test', [
  body('host').optional().isString().trim().notEmpty(),
  body('sourceType').optional().isIn(['prism_central', 'prism_element']),
  body('username').optional().isString().trim().notEmpty(),
  body('password').optional().isString(),
  body('id').optional().isInt().toInt(),
  body('port').optional().isInt({ min: 1, max: 65535 }).toInt(),
  body('sslVerify').optional().isBoolean(),
], validate, async (req, res) => {
  const { id, host, sourceType, username, password, port, sslVerify } = req.body;
  let candidate;
  if (id) {
    const row = db.prepare('SELECT * FROM nutanix_sources WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Nutanix source not found.' });
    candidate = { ...row, ...(password ? { password } : {}) };
  } else {
    if (!host || !sourceType || !username || !password) {
      return res.status(400).json({ error: 'Invalid parameters', details: [{ msg: 'host, sourceType, username, password required' }] });
    }
    candidate = { host: host.trim(), source_type: sourceType, username: username.trim(), password, port: port || 9440, ssl_verify: sslVerify ? 1 : 0 };
  }
  const result = await nutanixApi.testConnection(candidate);
  res.status(result.ok ? 200 : 502).json(result);
});

router.post('/sources/:id/poll', [param('id').isInt().toInt()], validate, async (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM nutanix_sources WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Nutanix source not found.' });
    nutanixPoller.trigger(row).catch(() => {});
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Probe fetches run the same fetchers the poller uses, live against the
// source, and report the RAW first item untransformed (aria.js pattern) —
// the mandatory fix loop for a blind build.
const PROBE_SECTIONS_PE = [
  ['cluster', (row) => nutanixApi.fetchPECluster(row).then((c) => (c ? [c] : []))],
  ['hosts', (row) => nutanixApi.fetchPEHosts(row)],
  ['vms', (row) => nutanixApi.fetchPEVms(row)],
  ['containers', (row) => nutanixApi.fetchPEContainers(row)],
  ['disks', (row) => nutanixApi.fetchPEDisks(row)],
  ['alerts', (row) => nutanixApi.fetchPEAlerts(row)],
  ['pds', (row) => nutanixApi.fetchPEPds(row)],
  ['replications', (row) => nutanixApi.fetchPEReplications(row)],
  ['remote_sites', (row) => nutanixApi.fetchPERemoteSites(row)],
  ['fault_tolerance', async (row) => { const r = await nutanixApi.fetchFaultTolerance(row); return r ? [r] : []; }],
  ['ncc', async (row) => { const r = await nutanixApi.fetchNccSummary(row); return r ? [r] : []; }],
];
const PROBE_SECTIONS_PC = [
  ['clusters', (row) => nutanixApi.fetchPCClusters(row)],
  ['hosts', (row) => nutanixApi.fetchPCHosts(row)],
  ['vms', (row) => nutanixApi.fetchPCVms(row)],
  ['groups_cluster_stats', async (row) => [...(await nutanixApi.fetchGroupsClusterStats(row)).entries()].map(([uuid, v]) => ({ uuid, ...v }))],
  ['groups_vm_stats', async (row) => [...(await nutanixApi.fetchGroupsVmStats(row)).entries()].map(([uuid, v]) => ({ uuid, ...v }))],
  ['alerts', (row) => nutanixApi.fetchPCAlerts(row)],
  ['policies', (row) => nutanixApi.fetchPCPolicies(row)],
  ['recovery_points', (row) => nutanixApi.fetchPCRecoveryPoints(row)],
  ['v4_probe', (row) => nutanixApi.fetchV4Probe(row)],
];

router.get('/sources/:id/probe', [
  param('id').isInt().toInt(),
  query('sections').optional().isString().matches(/^[a-zA-Z_,]+$/),
], validate, async (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM nutanix_sources WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Nutanix source not found.' });
    const all = row.source_type === 'prism_central' ? PROBE_SECTIONS_PC : PROBE_SECTIONS_PE;
    const wanted = req.query.sections ? new Set(req.query.sections.split(',')) : null;
    const run = wanted ? all.filter(([n]) => wanted.has(n)) : all;
    const sections = {};
    for (const [name, fn] of run) {
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

router.get('/overview', (req, res, next) => {
  try {
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
    // Estate utilization: cluster ppm weighted by node count (per-cluster ppm is
    // already a cluster-wide figure, so node count is the sane weight).
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
    // 30-day estate trend: last history row per cluster per day, then rolled up.
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
      issues: computeIssues().slice(0, 10),
    });
  } catch (err) { next(err); }
});

router.get('/clusters', (req, res, next) => {
  try {
    res.json({
      clusters: db.prepare(`
        SELECT c.*, s.name AS source_name, s.is_ce AS source_is_ce,
          (CASE WHEN c.storage_capacity_bytes > 0 THEN (CAST(c.storage_usage_bytes AS REAL) / c.storage_capacity_bytes) * 100 ELSE NULL END) AS usage_pct
        FROM nutanix_clusters c JOIN nutanix_sources s ON s.id = c.source_id ORDER BY s.name, c.name
      `).all(),
    });
  } catch (err) { next(err); }
});

router.get('/hosts', (req, res, next) => {
  try {
    res.json({
      hosts: db.prepare(`
        SELECT h.*, c.name AS cluster_name, s.name AS source_name
        FROM nutanix_hosts h
        JOIN nutanix_sources s ON s.id = h.source_id
        LEFT JOIN nutanix_clusters c ON c.source_id = h.source_id AND c.uuid = h.cluster_uuid
        ORDER BY s.name, h.name
      `).all(),
    });
  } catch (err) { next(err); }
});

router.get('/vms', (req, res, next) => {
  try {
    res.json({
      vms: db.prepare(`
        SELECT v.*, s.name AS source_name FROM nutanix_vms v
        JOIN nutanix_sources s ON s.id = v.source_id ORDER BY s.name, v.name
      `).all(),
    });
  } catch (err) { next(err); }
});

router.get('/vms/:uuid', [param('uuid').isString().notEmpty()], validate, (req, res, next) => {
  try {
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
  } catch (err) { next(err); }
});

router.get('/storage', (req, res, next) => {
  try {
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
  } catch (err) { next(err); }
});

router.get('/protection', (req, res, next) => {
  try {
    res.json({
      pds: db.prepare(`SELECT p.*, s.name AS source_name FROM nutanix_pds p JOIN nutanix_sources s ON s.id = p.source_id ORDER BY s.name, p.name`).all(),
      replications: db.prepare(`SELECT r.*, s.name AS source_name FROM nutanix_replications r JOIN nutanix_sources s ON s.id = r.source_id`).all(),
      remoteSites: db.prepare(`SELECT rs.*, s.name AS source_name FROM nutanix_remote_sites rs JOIN nutanix_sources s ON s.id = rs.source_id`).all(),
      policies: db.prepare(`SELECT p.*, s.name AS source_name FROM nutanix_protection_policies p JOIN nutanix_sources s ON s.id = p.source_id`).all(),
      recoveryPoints: db.prepare(`
        SELECT rp.*, s.name AS source_name FROM nutanix_recovery_points rp
        JOIN nutanix_sources s ON s.id = rp.source_id ORDER BY rp.created_at_ts DESC LIMIT 200
      `).all(),
      rpoCompliance: computeRpoCompliance(),
    });
  } catch (err) { next(err); }
});

router.get('/alerts', (req, res, next) => {
  try {
    res.json({
      alerts: db.prepare(`
        SELECT a.*, s.name AS source_name FROM nutanix_alerts a
        JOIN nutanix_sources s ON s.id = a.source_id
        ORDER BY a.resolved ASC, a.created_at DESC LIMIT 500
      `).all(),
    });
  } catch (err) { next(err); }
});

router.get('/events', (req, res, next) => {
  try {
    res.json({
      events: db.prepare(`
        SELECT e.*, s.name AS source_name FROM nutanix_events e
        JOIN nutanix_sources s ON s.id = e.source_id
        ORDER BY e.created_at DESC LIMIT 300
      `).all(),
    });
  } catch (err) { next(err); }
});

router.get('/issues', (req, res, next) => {
  try {
    res.json({ issues: computeIssues() });
  } catch (err) { next(err); }
});

router.get('/issue-history', [query('days').optional().isInt({ min: 1, max: 90 }).toInt()], validate, (req, res, next) => {
  try {
    const days = req.query.days || 30;
    res.json(db.prepare(`
      SELECT * FROM nutanix_issue_history
      WHERE status = 'open' OR last_seen >= datetime('now', ?)
      ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, last_seen DESC
    `).all(`-${days} days`));
  } catch (err) { next(err); }
});

router.get('/trends', [
  query('clusterId').optional().isInt().toInt(),
  query('days').optional().isInt({ min: 1, max: 365 }).toInt(),
], validate, (req, res, next) => {
  try {
    const days = req.query.days || 30;
    const clauses = [`captured_at >= datetime('now', ?)`];
    const params = [`-${days} days`];
    if (req.query.clusterId) { clauses.push('cluster_id = ?'); params.push(req.query.clusterId); }
    res.json({
      points: db.prepare(`
        SELECT * FROM nutanix_metrics_history WHERE ${clauses.join(' AND ')} ORDER BY captured_at ASC
      `).all(...params),
    });
  } catch (err) { next(err); }
});

router.get('/config', (req, res, next) => {
  try {
    res.json({
      containerWarnPct: containerWarnPct(), containerCritPct: containerCritPct(),
      clusterWarnPct: clusterWarnPct(), clusterCritPct: clusterCritPct(),
      rpoGracePct: rpoGracePct(), runwayWarnDays: runwayWarnDays(),
    });
  } catch (err) { next(err); }
});

router.put('/config', [
  body('containerWarnPct').optional().isInt({ min: 1, max: 100 }).toInt(),
  body('containerCritPct').optional().isInt({ min: 1, max: 100 }).toInt(),
  body('clusterWarnPct').optional().isInt({ min: 1, max: 100 }).toInt(),
  body('clusterCritPct').optional().isInt({ min: 1, max: 100 }).toInt(),
  body('rpoGracePct').optional().isInt({ min: 0, max: 500 }).toInt(),
  body('runwayWarnDays').optional().isInt({ min: 1, max: 3650 }).toInt(),
], validate, (req, res, next) => {
  try {
    const map = {
      containerWarnPct: 'nutanix_container_warn_pct', containerCritPct: 'nutanix_container_crit_pct',
      clusterWarnPct: 'nutanix_cluster_warn_pct', clusterCritPct: 'nutanix_cluster_crit_pct',
      rpoGracePct: 'nutanix_rpo_grace_pct', runwayWarnDays: 'nutanix_runway_warn_days',
    };
    for (const [k, settingKey] of Object.entries(map)) {
      if (req.body[k] !== undefined) setSetting(settingKey, String(req.body[k]));
    }
    res.json({
      containerWarnPct: containerWarnPct(), containerCritPct: containerCritPct(),
      clusterWarnPct: clusterWarnPct(), clusterCritPct: clusterCritPct(),
      rpoGracePct: rpoGracePct(), runwayWarnDays: runwayWarnDays(),
    });
  } catch (err) { next(err); }
});

// ── Move connections ────────────────────────────────────────────────────────

router.get('/move/connections', (req, res, next) => {
  try {
    res.json({ connections: db.prepare('SELECT * FROM nutanix_move_conns ORDER BY name').all().map(publicMoveConn) });
  } catch (err) { next(err); }
});

router.post('/move/connections', [
  body('name').isString().trim().notEmpty().isLength({ max: 120 }),
  body('host').isString().trim().notEmpty().isLength({ max: 253 }),
  body('username').isString().trim().notEmpty().isLength({ max: 256 }),
  body('password').isString().notEmpty().isLength({ max: 512 }),
  body('sslVerify').optional().isBoolean(),
], validate, (req, res, next) => {
  try {
    const { name, host, username, password, sslVerify } = req.body;
    const dup = db.prepare('SELECT id FROM nutanix_move_conns WHERE name = ? OR host = ?').get(name.trim(), host.trim());
    if (dup) return res.status(409).json({ error: 'A Move connection with that name or host is already registered.' });
    const info = db.prepare(`
      INSERT INTO nutanix_move_conns (name, host, username, encrypted_credentials, ssl_verify)
      VALUES (?, ?, ?, ?, ?)
    `).run(name.trim(), host.trim(), username.trim(), encrypt(JSON.stringify({ password })), sslVerify ? 1 : 0);
    const row = db.prepare('SELECT * FROM nutanix_move_conns WHERE id = ?').get(info.lastInsertRowid);
    nutanixMovePoller.schedule(row);
    nutanixMovePoller.trigger(row).catch(() => {});
    res.status(201).json({ connection: publicMoveConn(row) });
  } catch (err) { next(err); }
});

router.put('/move/connections/:id', [
  param('id').isInt().toInt(),
  body('name').optional().isString().trim().notEmpty().isLength({ max: 120 }),
  body('host').optional().isString().trim().notEmpty().isLength({ max: 253 }),
  body('username').optional().isString().trim().notEmpty().isLength({ max: 256 }),
  body('password').optional().isString().isLength({ max: 512 }),
  body('sslVerify').optional().isBoolean(),
], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM nutanix_move_conns WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Move connection not found.' });
    const b = req.body;
    db.prepare(`
      UPDATE nutanix_move_conns SET name = ?, host = ?, username = ?, encrypted_credentials = ?,
        ssl_verify = ?, updated_at = datetime('now') WHERE id = ?
    `).run(
      b.name?.trim() || row.name, b.host?.trim() || row.host, b.username?.trim() || row.username,
      b.password ? encrypt(JSON.stringify({ password: b.password })) : row.encrypted_credentials,
      b.sslVerify !== undefined ? (b.sslVerify ? 1 : 0) : row.ssl_verify,
      row.id
    );
    moveApi.invalidateToken(row.id);
    const updated = db.prepare('SELECT * FROM nutanix_move_conns WHERE id = ?').get(row.id);
    nutanixMovePoller.schedule(updated);
    res.json({ connection: publicMoveConn(updated) });
  } catch (err) { next(err); }
});

router.delete('/move/connections/:id', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM nutanix_move_conns WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Move connection not found.' });
    nutanixMovePoller.cancel(row.id);
    moveApi.invalidateToken(row.id);
    db.prepare('DELETE FROM nutanix_move_conns WHERE id = ?').run(row.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/move/connections/test', [
  body('host').optional().isString().trim().notEmpty(),
  body('username').optional().isString().trim().notEmpty(),
  body('password').optional().isString(),
  body('id').optional().isInt().toInt(),
  body('sslVerify').optional().isBoolean(),
], validate, async (req, res) => {
  const { id, host, username, password, sslVerify } = req.body;
  let candidate;
  if (id) {
    const row = db.prepare('SELECT * FROM nutanix_move_conns WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Move connection not found.' });
    candidate = { ...row, ...(password ? { password } : {}) };
  } else {
    if (!host || !username || !password) return res.status(400).json({ error: 'Invalid parameters' });
    candidate = { host: host.trim(), username: username.trim(), password, ssl_verify: sslVerify ? 1 : 0 };
  }
  const result = await moveApi.testConnection(candidate);
  res.status(result.ok ? 200 : 502).json(result);
});

router.post('/move/connections/:id/poll', [param('id').isInt().toInt()], validate, async (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM nutanix_move_conns WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Move connection not found.' });
    nutanixMovePoller.trigger(row).catch(() => {});
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/move/summary', (req, res, next) => {
  try {
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
  } catch (err) { next(err); }
});

// ── AI Advisor ───────────────────────────────────────────────────────────────

function advisorReportKey(slug) {
  return String(slug).replace(/-/g, '_');
}

router.get('/advisor/:report', [param('report').isString()], validate, (req, res, next) => {
  try {
    const key = advisorReportKey(req.params.report);
    if (!nutanixAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
    res.json({ enabled: nutanixAdvisor.isConfigured(), report: nutanixAdvisor.getCachedReport(key) });
  } catch (err) { next(err); }
});

router.post('/advisor/:report', [param('report').isString()], validate, async (req, res, next) => {
  try {
    const key = advisorReportKey(req.params.report);
    if (!nutanixAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
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
    next(err);
  }
});

module.exports = router;
