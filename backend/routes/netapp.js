const express = require('express');
const { param, query, validationResult } = require('express-validator');
const db = require('../db/database');
const { encrypt } = require('../services/encryption');
const { getSetting, setSetting } = require('../services/settings');
const netappApi = require('../services/netappApi');
const { syncAndPollAll, triggerPoll, reschedule } = require('../services/netappPoller');
const cacheControl = require('../middleware/cache');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

// SSRF guard on the management host.
function isBlockedHost(host) {
  const h = String(host || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').split(':')[0];
  const blocked = [
    /^127\./, /^0\.0\.0\.0$/, /^169\.254\./, /^::1$/,
    /^localhost$/i, /^metadata\.google\.internal$/i, /^169\.254\.169\.254$/,
  ];
  return blocked.some((p) => p.test(h));
}

// Read-only view of a discovered cluster.
function publicCluster(row) {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    management_ip: row.management_ip,
    cluster_uuid: row.cluster_uuid,
    source: row.source,
    polling_interval_minutes: row.polling_interval_minutes,
    updated_at: row.updated_at,
  };
}

/* ── AIQUM connection + discovered clusters ──────────────────────────────── */

// Clusters currently managed by AIQUM (populated by the poller's discovery).
router.get('/arrays', cacheControl(15), (req, res, next) => {
  try {
    res.json(db.prepare('SELECT * FROM netapp_arrays ORDER BY name ASC').all().map(publicCluster));
  } catch (err) { next(err); }
});

// AIQUM connection status + config (no secrets returned).
router.get('/aiqum', (req, res) => {
  const cfg = netappApi.getAiqumConfig();
  res.json({
    configured: netappApi.aiqumConfigured(),
    host: cfg.host || '',
    // Username and password values are never returned — presence only.
    hasUsername: !!cfg.username,
    hasPassword: !!cfg.password,
    hostSource: getSetting('netapp_aiqum_host') ? 'settings' : (process.env.NETAPP_AIQUM_HOST ? 'env' : 'none'),
    passSource: getSetting('netapp_aiqum_pass') ? 'settings' : (process.env.NETAPP_AIQUM_PW ? 'env' : 'none'),
    pollIntervalMin: Number(getSetting('netapp_poll_interval_min')) || 15,
    clusterCount: db.prepare("SELECT COUNT(*) AS n FROM netapp_arrays WHERE source = 'aiqum'").get().n,
  });
});

// Save AIQUM connection config (password encrypted at rest) + poll interval.
router.put('/aiqum', (req, res, next) => {
  try {
    const { host, username, password, pollIntervalMin } = req.body || {};
    if (host != null) {
      const h = String(host).trim();
      if (h && isBlockedHost(h)) return res.status(400).json({ error: 'host is not allowed' });
      setSetting('netapp_aiqum_host', h);
    }
    if (username != null) setSetting('netapp_aiqum_user', String(username).trim());
    if (password) setSetting('netapp_aiqum_pass', encrypt(String(password)));
    if (pollIntervalMin != null) {
      const n = Math.min(1440, Math.max(5, Number(pollIntervalMin) || 15));
      setSetting('netapp_poll_interval_min', String(n));
    }
    reschedule();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Validate AIQUM connectivity (uses posted creds, falling back to stored).
router.post('/aiqum/test', async (req, res) => {
  try {
    const cfg = netappApi.getAiqumConfig();
    const b = req.body || {};
    const override = {
      host: b.host || cfg.host,
      username: b.username || cfg.username,
      password: b.password || cfg.password,
    };
    res.json(await netappApi.testAiqum(override));
  } catch (err) {
    const status = err.response && err.response.status;
    res.status(200).json({ ok: false, error: status ? `HTTP ${status}` : (err.message || 'Connection failed') });
  }
});

// Trigger a discovery + poll of all clusters now.
router.post('/poll', async (req, res, next) => {
  try { await syncAndPollAll(); res.json({ success: true }); } catch (err) { next(err); }
});

// Poll a single already-discovered cluster now.
router.post('/arrays/:id/poll', [param('id').isInt()], validate, async (req, res, next) => {
  try {
    const array = db.prepare('SELECT * FROM netapp_arrays WHERE id = ?').get(req.params.id);
    if (!array) return res.status(404).json({ error: 'Cluster not found' });
    await triggerPoll(array.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

/* ── Telemetry reads ─────────────────────────────────────────────────────── */

// Latest sample + counts for every cluster.
router.get('/overview', cacheControl(15), (req, res, next) => {
  try {
    const arrays = db.prepare('SELECT * FROM netapp_arrays ORDER BY name ASC').all();
    const latestStmt = db.prepare('SELECT * FROM netapp_metrics_history WHERE array_id = ? ORDER BY captured_at DESC LIMIT 1');
    const alertStmt = db.prepare('SELECT COUNT(*) AS n FROM netapp_alerts WHERE array_id = ?');
    const volStmt = db.prepare('SELECT COUNT(*) AS n FROM netapp_volumes WHERE array_id = ?');
    const aggStmt = db.prepare('SELECT COUNT(*) AS n FROM netapp_aggregates WHERE array_id = ?');
    res.json(arrays.map((a) => ({
      ...publicCluster(a),
      latest: latestStmt.get(a.id) || null,
      open_alerts: alertStmt.get(a.id).n,
      volume_count: volStmt.get(a.id).n,
      aggregate_count: aggStmt.get(a.id).n,
    })));
  } catch (err) { next(err); }
});

router.get('/arrays/:id/metrics/history', [param('id').isInt(), query('days').optional().isInt({ min: 1, max: 90 })], validate, cacheControl(30), (req, res, next) => {
  try {
    const days = Number(req.query.days) || 7;
    const rows = db.prepare(`
      SELECT * FROM netapp_metrics_history WHERE array_id = ? AND captured_at >= datetime('now', ?)
      ORDER BY captured_at ASC
    `).all(req.params.id, `-${days} days`);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/aggregates', cacheControl(30), (req, res, next) => {
  try {
    res.json(db.prepare(`
      SELECT g.*, a.name AS array_name FROM netapp_aggregates g
      JOIN netapp_arrays a ON a.id = g.array_id ORDER BY a.name, g.name
    `).all());
  } catch (err) { next(err); }
});

router.get('/volumes', cacheControl(30), (req, res, next) => {
  try {
    res.json(db.prepare(`
      SELECT v.*, a.name AS array_name FROM netapp_volumes v
      JOIN netapp_arrays a ON a.id = v.array_id ORDER BY v.used_bytes DESC
    `).all());
  } catch (err) { next(err); }
});

router.get('/alerts', cacheControl(15), (req, res, next) => {
  try {
    res.json(db.prepare(`
      SELECT al.*, a.name AS array_name FROM netapp_alerts al
      JOIN netapp_arrays a ON a.id = al.array_id
      ORDER BY CASE LOWER(al.severity)
        WHEN 'emergency' THEN 0 WHEN 'alert' THEN 1 WHEN 'critical' THEN 2
        WHEN 'error' THEN 3 WHEN 'warning' THEN 4 ELSE 5 END, al.captured_at DESC
    `).all());
  } catch (err) { next(err); }
});

router.get('/arrays/:id/hardware', [param('id').isInt()], validate, cacheControl(60), (req, res, next) => {
  try {
    const id = req.params.id;
    res.json({
      nodes: db.prepare('SELECT * FROM netapp_nodes WHERE array_id = ? ORDER BY name').all(id),
      disks: db.prepare('SELECT * FROM netapp_disks WHERE array_id = ? ORDER BY name').all(id),
      svms: db.prepare('SELECT * FROM netapp_svms WHERE array_id = ? ORDER BY name').all(id),
    });
  } catch (err) { next(err); }
});

// SnapMirror relationships (DR replication) across all clusters.
router.get('/replication', cacheControl(30), (req, res, next) => {
  try {
    res.json(db.prepare(`
      SELECT s.*, a.name AS array_name FROM netapp_snapmirror s
      JOIN netapp_arrays a ON a.id = s.array_id
      ORDER BY s.healthy ASC, s.lag_seconds DESC
    `).all());
  } catch (err) { next(err); }
});

// Logical interfaces (LIFs) for one cluster.
router.get('/arrays/:id/network', [param('id').isInt()], validate, cacheControl(60), (req, res, next) => {
  try {
    res.json(db.prepare('SELECT * FROM netapp_lifs WHERE array_id = ? ORDER BY svm_name, name').all(req.params.id));
  } catch (err) { next(err); }
});

// Quota reports across all clusters.
router.get('/quotas', cacheControl(60), (req, res, next) => {
  try {
    res.json(db.prepare(`
      SELECT q.*, a.name AS array_name FROM netapp_quotas q
      JOIN netapp_arrays a ON a.id = q.array_id
      ORDER BY q.space_used_bytes DESC
    `).all());
  } catch (err) { next(err); }
});

// NFS connected clients + export-policy rules across all clusters.
router.get('/nfs', cacheControl(30), (req, res, next) => {
  try {
    res.json({
      clients: db.prepare(`
        SELECT c.*, a.name AS array_name FROM netapp_nfs_clients c
        JOIN netapp_arrays a ON a.id = c.array_id
        ORDER BY c.client_ip
      `).all(),
      exportRules: db.prepare(`
        SELECT r.*, a.name AS array_name FROM netapp_export_rules r
        JOIN netapp_arrays a ON a.id = r.array_id
        ORDER BY r.svm_name, r.policy_name, r.rule_index
      `).all(),
    });
  } catch (err) { next(err); }
});

router.get('/cifs', cacheControl(30), (req, res, next) => {
  try {
    res.json({
      sessions: db.prepare(`
        SELECT s.*, a.name AS array_name FROM netapp_cifs_sessions s
        JOIN netapp_arrays a ON a.id = s.array_id
        ORDER BY s.client_ip
      `).all(),
      shares: db.prepare(`
        SELECT sh.*, a.name AS array_name FROM netapp_cifs_shares sh
        JOIN netapp_arrays a ON a.id = sh.array_id
        ORDER BY sh.svm_name, sh.share_name
      `).all(),
    });
  } catch (err) { next(err); }
});

module.exports = router;
