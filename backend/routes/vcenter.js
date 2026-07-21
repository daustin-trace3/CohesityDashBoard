// vCenter routes. Mounted by the plugin dispatcher at /api/vcenter — paths
// are relative. Registration CRUD stores the password AES-encrypted; data
// endpoints serve the polled vcenter_* tables plus computed issues
// (fixed thresholds: datastore >80% used, cluster <20% headroom, cert <60d).
const express = require('express');
const { body, param, validationResult } = require('express-validator');
const db = require('../db/database');
const { encrypt } = require('../services/encryption');
const vcenterApi = require('../services/vcenterApi');
const { vcenterPoller } = require('../services/vcenterPoller');

const router = express.Router();

const DS_USED_WARN_PCT = 80;
const CLUSTER_FREE_WARN_PCT = 20;
const CERT_WARN_DAYS = 60;

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid parameters', details: errors.array() });
  next();
};

const publicVc = (row) => ({
  id: row.id, name: row.name, host: row.host, username: row.username,
  sslVerify: !!row.ssl_verify, pollingIntervalMinutes: row.polling_interval_minutes,
  lastPollStatus: row.last_poll_status, lastPollError: row.last_poll_error, lastPollAt: row.last_poll_at,
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
  for (const cert of db.prepare(`
    SELECT c.*, v.name AS vcenter_name FROM vcenter_certs c JOIN vcenter_vcenters v ON v.id = c.vcenter_id
  `).all()) {
    if (!cert.valid_to) continue;
    const days = (new Date(cert.valid_to).getTime() - Date.now()) / 86400000;
    if (Number.isFinite(days) && days < CERT_WARN_DAYS) {
      issues.push({
        severity: days < 14 ? 'critical' : 'warning', type: 'cert-expiry', vcenter: cert.vcenter_name,
        message: days < 0
          ? `vCenter ${cert.vcenter_name} TLS certificate EXPIRED ${Math.abs(Math.round(days))} day(s) ago`
          : `vCenter ${cert.vcenter_name} TLS certificate expires in ${Math.round(days)} day(s)`,
      });
    }
  }
  const order = { critical: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** GET /api/vcenter/overview — fleet rollup + computed issues. */
router.get('/overview', (req, res, next) => {
  try {
    const vcs = db.prepare('SELECT * FROM vcenter_vcenters ORDER BY name').all();
    const hostAgg = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN connection_state = 'CONNECTED' THEN 1 ELSE 0 END) AS connected,
        SUM(CASE WHEN in_maintenance = 1 THEN 1 ELSE 0 END) AS maintenance,
        SUM(COALESCE(vm_count, 0)) AS vms
      FROM vcenter_hosts
    `).get();
    const dsAgg = db.prepare(`
      SELECT COUNT(*) AS total, SUM(capacity_bytes) AS capacity, SUM(free_bytes) AS free
      FROM vcenter_datastores
    `).get();
    res.json({
      vcenters: vcs.map(publicVc),
      hosts: hostAgg,
      datastores: dsAgg,
      clusterCount: db.prepare('SELECT COUNT(*) AS n FROM vcenter_clusters').get().n,
      issues: computeIssues(),
      thresholds: { dsUsedWarnPct: DS_USED_WARN_PCT, clusterFreeWarnPct: CLUSTER_FREE_WARN_PCT, certWarnDays: CERT_WARN_DAYS },
    });
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
