// vCenter routes. Mounted at /api/vcenter in server.js — paths
// are relative. Registration CRUD stores the password AES-encrypted; data
// endpoints serve the polled vcenter_* tables plus computed issues
// (fixed thresholds: datastore >80% used, cluster <20% headroom, cert <60d).
const express = require('express');
const { body, param, validationResult } = require('express-validator');
const db = require('../db/database');
const { encrypt } = require('../services/encryption');
const { getSetting, setSetting } = require('../services/settings');
const vcenterApi = require('../services/vcenterApi');
const { vcenterPoller } = require('../services/vcenterPoller');

const router = express.Router();

const DS_USED_WARN_PCT = 80;
const CLUSTER_FREE_WARN_PCT = 20;
// Cert warning window is operator-configurable (vCenter Settings page);
// critical stays at 14 days, clamped down if the warning window is shorter.
function certWarnDays() {
  const n = Number(getSetting('vcenter_cert_warn_days'));
  return Number.isFinite(n) && n >= 1 && n <= 365 ? Math.round(n) : 60;
}

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid parameters', details: errors.array() });
  next();
};

const publicVc = (row) => ({
  id: row.id, name: row.name, host: row.host, username: row.username,
  sslVerify: !!row.ssl_verify, pollingIntervalMinutes: row.polling_interval_minutes,
  lastPollStatus: row.last_poll_status, lastPollError: row.last_poll_error, lastPollAt: row.last_poll_at,
  version: row.version, build: row.build, productName: row.product_name,
});

/** GET /api/vcenter/vcenters — registered vCenters (never the credentials). */
router.get('/vcenters', (req, res, next) => {
  try {
    res.json(db.prepare('SELECT * FROM vcenter_vcenters ORDER BY name').all().map(publicVc));
  } catch (err) { next(err); }
});

/** POST /api/vcenter/vcenters — register a vCenter. */
router.post('/vcenters', [
  body('name').isString().trim().notEmpty().isLength({ max: 120 }),
  body('host').isString().trim().notEmpty().isLength({ max: 253 }),
  body('username').isString().trim().notEmpty().isLength({ max: 256 }),
  body('password').isString().notEmpty().isLength({ max: 512 }),
  body('sslVerify').optional().isBoolean(),
  body('pollingIntervalMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
], validate, (req, res, next) => {
  try {
    const { name, host, username, password, sslVerify, pollingIntervalMinutes } = req.body;
    const dup = db.prepare('SELECT id FROM vcenter_vcenters WHERE name = ? OR host = ?').get(name.trim(), host.trim());
    if (dup) return res.status(409).json({ error: 'A vCenter with that name or host is already registered.' });
    const info = db.prepare(`
      INSERT INTO vcenter_vcenters (name, host, username, encrypted_credentials, ssl_verify, polling_interval_minutes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name.trim(), host.trim(), username.trim(),
      encrypt(JSON.stringify({ password })), sslVerify ? 1 : 0, pollingIntervalMinutes || 15);
    const row = db.prepare('SELECT * FROM vcenter_vcenters WHERE id = ?').get(info.lastInsertRowid);
    vcenterPoller.schedule(row);
    vcenterPoller.trigger(row).catch(() => {});
    res.status(201).json(publicVc(row));
  } catch (err) { next(err); }
});

/** PUT /api/vcenter/vcenters/:id — update (password optional; blank keeps stored). */
router.put('/vcenters/:id', [
  param('id').isInt().toInt(),
  body('name').optional().isString().trim().notEmpty().isLength({ max: 120 }),
  body('host').optional().isString().trim().notEmpty().isLength({ max: 253 }),
  body('username').optional().isString().trim().notEmpty().isLength({ max: 256 }),
  body('password').optional().isString().isLength({ max: 512 }),
  body('sslVerify').optional().isBoolean(),
  body('pollingIntervalMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM vcenter_vcenters WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'vCenter not found.' });
    const b = req.body;
    db.prepare(`
      UPDATE vcenter_vcenters SET
        name = ?, host = ?, username = ?, encrypted_credentials = ?,
        ssl_verify = ?, polling_interval_minutes = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      b.name?.trim() || row.name, b.host?.trim() || row.host, b.username?.trim() || row.username,
      b.password ? encrypt(JSON.stringify({ password: b.password })) : row.encrypted_credentials,
      b.sslVerify !== undefined ? (b.sslVerify ? 1 : 0) : row.ssl_verify,
      b.pollingIntervalMinutes || row.polling_interval_minutes,
      row.id
    );
    vcenterApi.invalidateSession(row.id);
    const updated = db.prepare('SELECT * FROM vcenter_vcenters WHERE id = ?').get(row.id);
    vcenterPoller.schedule(updated);
    res.json(publicVc(updated));
  } catch (err) { next(err); }
});

/** DELETE /api/vcenter/vcenters/:id — unregister (CASCADE clears inventory). */
router.delete('/vcenters/:id', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM vcenter_vcenters WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'vCenter not found.' });
    vcenterPoller.cancel(row.id);
    vcenterApi.invalidateSession(row.id);
    db.prepare('DELETE FROM vcenter_vcenters WHERE id = ?').run(row.id);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

/** POST /api/vcenter/vcenters/test — validate saved or candidate credentials. */
router.post('/vcenters/test', [
  body('host').isString().trim().notEmpty(),
  body('username').isString().trim().notEmpty(),
  body('password').optional().isString(),
  body('id').optional().isInt().toInt(),
  body('sslVerify').optional().isBoolean(),
], validate, async (req, res) => {
  const { id, host, username, password, sslVerify } = req.body;
  let candidate = { host: host.trim(), username: username.trim(), password, ssl_verify: sslVerify ? 1 : 0 };
  if (!password && id) {
    const row = db.prepare('SELECT * FROM vcenter_vcenters WHERE id = ?').get(id);
    if (row) candidate = { ...row, host: candidate.host, username: candidate.username, ssl_verify: candidate.ssl_verify };
  }
  const result = await vcenterApi.testConnection(candidate);
  res.status(result.ok ? 200 : 502).json(result);
});

/** POST /api/vcenter/vcenters/:id/refresh — poll this vCenter now. */
router.post('/vcenters/:id/refresh', [param('id').isInt().toInt()], validate, async (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM vcenter_vcenters WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'vCenter not found.' });
    await vcenterPoller.trigger(row);
    res.json(publicVc(db.prepare('SELECT * FROM vcenter_vcenters WHERE id = ?').get(row.id)));
  } catch (err) { next(err); }
});

// ── Data endpoints ───────────────────────────────────────────────────────────

const dsUsedPct = (d) => (d.capacity_bytes > 0 ? (1 - d.free_bytes / d.capacity_bytes) * 100 : null);

function computeIssues() {
  const issues = [];
  for (const vc of db.prepare('SELECT * FROM vcenter_vcenters').all()) {
    if (vc.last_poll_status === 'error') {
      issues.push({ severity: 'critical', type: 'vcenter-unreachable', vcenter: vc.name,
        message: `vCenter ${vc.name} is unreachable: ${vc.last_poll_error || 'poll failed'}` });
    }
  }
  const hosts = db.prepare(`
    SELECT h.*, v.name AS vcenter_name FROM vcenter_hosts h JOIN vcenter_vcenters v ON v.id = h.vcenter_id
  `).all();
  for (const h of hosts) {
    if (h.connection_state && h.connection_state !== 'CONNECTED') {
      issues.push({ severity: 'critical', type: 'host-down', vcenter: h.vcenter_name,
        message: `Host ${h.name} is ${String(h.connection_state).toLowerCase().replace(/_/g, ' ')}` });
    } else if (h.in_maintenance === 1) {
      issues.push({ severity: 'info', type: 'host-maintenance', vcenter: h.vcenter_name,
        message: `Host ${h.name} is in maintenance mode` });
    }
  }
  const datastores = db.prepare(`
    SELECT d.*, v.name AS vcenter_name FROM vcenter_datastores d JOIN vcenter_vcenters v ON v.id = d.vcenter_id
  `).all();
  for (const d of datastores) {
    const used = dsUsedPct(d);
    if (used != null && used > DS_USED_WARN_PCT) {
      issues.push({ severity: used > 90 ? 'critical' : 'warning', type: 'datastore-usage', vcenter: d.vcenter_name,
        message: `Datastore ${d.name} is ${used.toFixed(1)}% full` });
    }
  }
  const clusters = db.prepare(`
    SELECT c.*, v.name AS vcenter_name FROM vcenter_clusters c JOIN vcenter_vcenters v ON v.id = c.vcenter_id
  `).all();
  for (const c of clusters) {
    for (const [label, cap, used] of [
      ['CPU', c.cpu_mhz_capacity, c.cpu_mhz_used],
      ['memory', c.mem_bytes_capacity, c.mem_bytes_used],
    ]) {
      if (cap > 0 && used != null) {
        const freePct = (1 - used / cap) * 100;
        if (freePct < CLUSTER_FREE_WARN_PCT) {
          issues.push({ severity: freePct < 10 ? 'critical' : 'warning', type: 'cluster-capacity', vcenter: c.vcenter_name,
            message: `Cluster ${c.name} has ${freePct.toFixed(1)}% ${label} headroom left` });
        }
      }
    }
  }
  const certWarn = certWarnDays();
  const certCrit = Math.min(14, certWarn);
  for (const cert of db.prepare(`
    SELECT c.*, v.name AS vcenter_name FROM vcenter_certs c JOIN vcenter_vcenters v ON v.id = c.vcenter_id
  `).all()) {
    if (!cert.valid_to) continue;
    const days = (new Date(cert.valid_to).getTime() - Date.now()) / 86400000;
    if (Number.isFinite(days) && days < certWarn) {
      issues.push({
        severity: days < certCrit ? 'critical' : 'warning', type: 'cert-expiry', vcenter: cert.vcenter_name,
        message: days < 0
          ? `vCenter ${cert.vcenter_name} TLS certificate EXPIRED ${Math.abs(Math.round(days))} day(s) ago`
          : `vCenter ${cert.vcenter_name} TLS certificate expires in ${Math.round(days)} day(s)`,
      });
    }
  }
  const order = { critical: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}

// VMware Tools upgrade-needed statuses (guest.toolsVersionStatus2 values).
const TOOLS_OUTDATED = ['guestToolsNeedUpgrade', 'guestToolsTooOld', 'guestToolsBlacklisted', 'guestToolsSupportedOld'];
const toolsOutdatedIn = `tools_version_status IN (${TOOLS_OUTDATED.map(() => '?').join(', ')})`;

/** GET /api/vcenter/overview — fleet rollup + computed issues. */
router.get('/overview', (req, res, next) => {
  try {
    const vcs = db.prepare('SELECT * FROM vcenter_vcenters ORDER BY name').all();
    const hostAgg = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN connection_state = 'CONNECTED' THEN 1 ELSE 0 END) AS connected,
        SUM(CASE WHEN in_maintenance = 1 THEN 1 ELSE 0 END) AS maintenance,
        SUM(COALESCE(vm_count, 0)) AS vms,
        SUM(cpu_cores) AS cpu_cores,
        SUM(mem_bytes_capacity) AS mem_bytes_total
      FROM vcenter_hosts
    `).get();
    const dsAgg = db.prepare(`
      SELECT COUNT(*) AS total, SUM(capacity_bytes) AS capacity, SUM(free_bytes) AS free
      FROM vcenter_datastores
    `).get();
    // Overcommit convention: allocations count powered-on VMs only.
    const vmAgg = db.prepare(`
      SELECT
        SUM(CASE WHEN power_state = 'POWERED_ON' THEN 1 ELSE 0 END) AS powered_on,
        SUM(CASE WHEN power_state = 'POWERED_OFF' THEN 1 ELSE 0 END) AS powered_off,
        SUM(CASE WHEN power_state = 'SUSPENDED' THEN 1 ELSE 0 END) AS suspended,
        SUM(CASE WHEN power_state = 'POWERED_ON' THEN COALESCE(cpu_count, 0) ELSE 0 END) AS vcpus_on,
        SUM(CASE WHEN power_state = 'POWERED_ON' THEN COALESCE(memory_mb, 0) ELSE 0 END) AS mem_mb_on
      FROM vcenter_vms
    `).get();
    const orphanAgg = db.prepare(
      'SELECT COUNT(*) AS count, SUM(size_bytes) AS bytes FROM vcenter_orphaned_vmdks'
    ).get();
    const toolsOutdated = db.prepare(
      `SELECT COUNT(*) AS n FROM vcenter_vms WHERE ${toolsOutdatedIn}`
    ).get(...TOOLS_OUTDATED).n;
    res.json({
      vcenters: vcs.map(publicVc),
      hosts: hostAgg,
      datastores: dsAgg,
      clusterCount: db.prepare('SELECT COUNT(*) AS n FROM vcenter_clusters').get().n,
      vmCount: db.prepare('SELECT COUNT(*) AS n FROM vcenter_vms').get().n,
      vmStats: { ...vmAgg, tools_outdated: toolsOutdated },
      capacity: {
        cpu_cores: hostAgg.cpu_cores,
        vcpus_allocated: vmAgg.vcpus_on,
        cpu_overcommit: hostAgg.cpu_cores > 0 ? vmAgg.vcpus_on / hostAgg.cpu_cores : null,
        mem_bytes_total: hostAgg.mem_bytes_total,
        vm_mem_bytes_allocated: (vmAgg.mem_mb_on || 0) * 1024 * 1024,
        mem_overcommit: hostAgg.mem_bytes_total > 0
          ? ((vmAgg.mem_mb_on || 0) * 1024 * 1024) / hostAgg.mem_bytes_total : null,
      },
      orphans: orphanAgg,
      density: db.prepare(`
        SELECT h.name, h.cluster_name, h.vm_count, v.name AS vcenter_name
        FROM vcenter_hosts h JOIN vcenter_vcenters v ON v.id = h.vcenter_id
        WHERE h.vm_count IS NOT NULL ORDER BY h.vm_count DESC
      `).all(),
      osBreakdown: db.prepare(`
        SELECT COALESCE(guest_os, 'Unknown') AS guest_os, COUNT(*) AS count
        FROM vcenter_vms GROUP BY COALESCE(guest_os, 'Unknown') ORDER BY count DESC
      `).all(),
      issues: computeIssues(),
      thresholds: { dsUsedWarnPct: DS_USED_WARN_PCT, clusterFreeWarnPct: CLUSTER_FREE_WARN_PCT, certWarnDays: certWarnDays() },
    });
  } catch (err) { next(err); }
});

/** GET /api/vcenter/config — platform-level settings (alert thresholds). */
router.get('/config', (req, res, next) => {
  try {
    res.json({ certWarnDays: certWarnDays() });
  } catch (err) { next(err); }
});

/** PUT /api/vcenter/config — save alert thresholds. */
router.put('/config', [
  body('certWarnDays').isInt({ min: 1, max: 365 }).toInt(),
], validate, (req, res, next) => {
  try {
    setSetting('vcenter_cert_warn_days', String(req.body.certWarnDays));
    res.json({ saved: true, certWarnDays: certWarnDays() });
  } catch (err) { next(err); }
});

/** GET /api/vcenter/network — physical + logical networking inventory. */
router.get('/network', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT n.*, v.name AS vcenter_name FROM vcenter_networks n
      JOIN vcenter_vcenters v ON v.id = n.vcenter_id ORDER BY v.name, n.host_name, n.name
    `).all().map(r => ({
      ...r,
      uplinks: r.uplinks ? JSON.parse(r.uplinks) : null,
      extra: r.extra ? JSON.parse(r.extra) : null,
    }));
    const byKind = (kind) => rows.filter(r => r.kind === kind);
    res.json({
      pnics: byKind('pnic'),
      vswitches: byKind('vswitch'),
      portgroups: byKind('portgroup'),
      vmkernels: byKind('vmkernel'),
      dvswitches: byKind('dvswitch'),
      dvportgroups: byKind('dvportgroup'),
    });
  } catch (err) { next(err); }
});

// Host config fields compared for drift; NTP/DNS lists compare order-insensitively.
const DRIFT_FIELDS = [
  { key: 'esx_build', label: 'ESX build', value: (h) => h.esx_build != null ? `${h.esx_version || ''} (${h.esx_build})` : null },
  { key: 'bios_version', label: 'BIOS version', value: (h) => h.bios_version },
  { key: 'ntp_servers', label: 'NTP servers', value: (h) => sortedList(h.ntp_servers) },
  { key: 'dns_servers', label: 'DNS servers', value: (h) => sortedList(h.dns_servers) },
  { key: 'ssh_enabled', label: 'SSH service', value: (h) => h.ssh_enabled == null ? null : (h.ssh_enabled ? 'enabled' : 'disabled') },
];

function sortedList(json) {
  if (!json) return null;
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) && arr.length ? [...arr].sort().join(', ') : null;
  } catch { return null; }
}

/**
 * Configuration drift: within each cluster (2+ hosts), the majority value per
 * field is the baseline; hosts that deviate are drift items. Fields without
 * SOAP data (all NULL) are skipped rather than reported.
 */
function computeDrift() {
  const hosts = db.prepare(`
    SELECT h.*, v.name AS vcenter_name FROM vcenter_hosts h
    JOIN vcenter_vcenters v ON v.id = h.vcenter_id
    WHERE h.cluster_name IS NOT NULL
  `).all();
  const byCluster = new Map();
  for (const h of hosts) {
    const key = `${h.vcenter_id}|${h.cluster_name}`;
    if (!byCluster.has(key)) byCluster.set(key, []);
    byCluster.get(key).push(h);
  }
  const drift = [];
  for (const members of byCluster.values()) {
    if (members.length < 2) continue;
    for (const field of DRIFT_FIELDS) {
      const values = members.map(h => ({ host: h, value: field.value(h) })).filter(x => x.value != null);
      if (values.length < 2) continue;
      const counts = new Map();
      for (const x of values) counts.set(x.value, (counts.get(x.value) || 0) + 1);
      if (counts.size < 2) continue;
      const [expected, expectedCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      for (const x of values) {
        if (x.value === expected) continue;
        drift.push({
          vcenter: x.host.vcenter_name, cluster: x.host.cluster_name, host: x.host.name,
          field: field.label, value: x.value, expected,
          baseline_hosts: expectedCount, cluster_hosts: members.length,
        });
      }
    }
  }
  return drift;
}

/** GET /api/vcenter/governance — config drift, outdated VMware Tools, orphaned VMDKs. */
router.get('/governance', (req, res, next) => {
  try {
    const outdatedTools = db.prepare(`
      SELECT m.name, m.host_name, m.cluster_name, m.power_state, m.guest_os,
             m.tools_version, m.tools_version_status, v.name AS vcenter_name
      FROM vcenter_vms m JOIN vcenter_vcenters v ON v.id = m.vcenter_id
      WHERE ${toolsOutdatedIn} ORDER BY v.name, m.name
    `).all(...TOOLS_OUTDATED);
    const orphans = db.prepare(`
      SELECT o.*, v.name AS vcenter_name FROM vcenter_orphaned_vmdks o
      JOIN vcenter_vcenters v ON v.id = o.vcenter_id ORDER BY o.size_bytes DESC
    `).all();
    res.json({
      drift: computeDrift(),
      outdatedTools,
      orphans,
      orphanBytes: orphans.reduce((n, o) => n + (o.size_bytes || 0), 0),
      // SOAP-sourced fields all NULL means the data isn't available (yet).
      driftDataAvailable: db.prepare(
        'SELECT COUNT(*) AS n FROM vcenter_hosts WHERE ntp_servers IS NOT NULL OR esx_build IS NOT NULL'
      ).get().n > 0,
    });
  } catch (err) { next(err); }
});

/** GET /api/vcenter/vms — VM guest inventory across all vCenters. */
router.get('/vms', (req, res, next) => {
  try {
    res.json(db.prepare(`
      SELECT m.*, v.name AS vcenter_name FROM vcenter_vms m
      JOIN vcenter_vcenters v ON v.id = m.vcenter_id ORDER BY v.name, m.name
    `).all());
  } catch (err) { next(err); }
});

/** GET /api/vcenter/hosts — ESX hosts across all vCenters. */
router.get('/hosts', (req, res, next) => {
  try {
    res.json(db.prepare(`
      SELECT h.*, v.name AS vcenter_name FROM vcenter_hosts h
      JOIN vcenter_vcenters v ON v.id = h.vcenter_id ORDER BY v.name, h.name
    `).all());
  } catch (err) { next(err); }
});

/** GET /api/vcenter/clusters — clusters with capacity rollups. */
router.get('/clusters', (req, res, next) => {
  try {
    res.json(db.prepare(`
      SELECT c.*, v.name AS vcenter_name FROM vcenter_clusters c
      JOIN vcenter_vcenters v ON v.id = c.vcenter_id ORDER BY v.name, c.name
    `).all());
  } catch (err) { next(err); }
});

/** GET /api/vcenter/datastores — datastores with usage. */
router.get('/datastores', (req, res, next) => {
  try {
    res.json(db.prepare(`
      SELECT d.*, v.name AS vcenter_name FROM vcenter_datastores d
      JOIN vcenter_vcenters v ON v.id = d.vcenter_id ORDER BY v.name, d.name
    `).all().map(d => ({ ...d, used_pct: dsUsedPct(d) })));
  } catch (err) { next(err); }
});

/** GET /api/vcenter/certs — collected certificates. */
router.get('/certs', (req, res, next) => {
  try {
    res.json(db.prepare(`
      SELECT c.*, v.name AS vcenter_name FROM vcenter_certs c
      JOIN vcenter_vcenters v ON v.id = c.vcenter_id ORDER BY v.name
    `).all());
  } catch (err) { next(err); }
});

/** GET /api/vcenter/trends — per-vCenter snapshot series (30d default). */
router.get('/trends', (req, res, next) => {
  try {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    res.json(db.prepare(`
      SELECT m.*, v.name AS vcenter_name FROM vcenter_metrics_history m
      JOIN vcenter_vcenters v ON v.id = m.vcenter_id
      WHERE m.captured_at >= datetime('now', ?)
      ORDER BY m.captured_at
    `).all(`-${days} days`));
  } catch (err) { next(err); }
});

module.exports = router;
