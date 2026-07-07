const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const db = require('../db/database');
const { encrypt } = require('../services/encryption');
const netappApi = require('../services/netappApi');
const { scheduleArray, cancelArray, triggerPoll } = require('../services/netappPoller');
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

function publicArray(row) {
  return {
    id: row.id,
    name: row.name,
    mgmt_host: row.mgmt_host,
    username: row.username,
    polling_interval_minutes: row.polling_interval_minutes,
    ssl_verify: row.ssl_verify,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const arrayValidators = [
  body('name').trim().notEmpty().withMessage('name is required').isLength({ max: 253 }),
  body('mgmt_host').trim().notEmpty().withMessage('mgmt_host is required')
    .custom((v) => !isBlockedHost(v)).withMessage('mgmt_host is not allowed'),
  body('username').trim().notEmpty().withMessage('username is required'),
  body('polling_interval_minutes').optional().isInt({ min: 5, max: 1440 })
    .withMessage('polling_interval_minutes must be 5-1440'),
  body('ssl_verify').optional().isBoolean().withMessage('ssl_verify must be boolean'),
];

function buildCredentials(body) {
  return encrypt(JSON.stringify({ password: String(body.password) }));
}

function describeApiError(err) {
  if (err?.response) {
    const status = err.response.status;
    const detail = err.response.data?.error?.message || '';
    if (status === 401 || status === 403) return `Authentication failed (HTTP ${status})${detail ? `: ${detail}` : ''}`;
    return `Cluster returned HTTP ${status}${detail ? `: ${detail}` : ''}`;
  }
  if (err?.code === 'NETAPP_NO_PASSWORD') return 'No password provided';
  if (err?.code) return `Network error: ${err.code}`;
  return err?.message || 'Connection failed';
}

/* ── Arrays CRUD ─────────────────────────────────────────────────────────── */

router.get('/arrays', cacheControl(15), (req, res, next) => {
  try {
    res.json(db.prepare('SELECT * FROM netapp_arrays ORDER BY name ASC').all().map(publicArray));
  } catch (err) { next(err); }
});

// Non-secret defaults from env to prefill the Add form.
router.get('/defaults', (req, res) => {
  res.json({ username: process.env.NETAPP_USER_ACCOUNT || '' });
});

// Validate credentials without persisting.
router.post(
  '/arrays/test',
  [
    body('mgmt_host').trim().notEmpty().custom((v) => !isBlockedHost(v)).withMessage('mgmt_host is not allowed'),
    body('username').trim().notEmpty(),
    body('password').notEmpty().withMessage('password is required'),
    body('ssl_verify').optional().isBoolean(),
  ],
  validate,
  async (req, res) => {
    try {
      const result = await netappApi.testConnection({
        mgmt_host: req.body.mgmt_host,
        username: req.body.username,
        password: req.body.password,
        ssl_verify: req.body.ssl_verify ? 1 : 0,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ ok: false, error: describeApiError(err) });
    }
  }
);

// Register a new cluster.
router.post('/arrays', arrayValidators, validate, (req, res, next) => {
  if (!req.body.password) return res.status(400).json({ error: 'password is required' });
  try {
    const info = db.prepare(`
      INSERT INTO netapp_arrays (name, mgmt_host, username, encrypted_credentials, polling_interval_minutes, ssl_verify)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      req.body.name,
      netappApi.normalizeHost(req.body.mgmt_host),
      req.body.username,
      buildCredentials(req.body),
      req.body.polling_interval_minutes || 15,
      req.body.ssl_verify ? 1 : 0
    );
    const row = db.prepare('SELECT * FROM netapp_arrays WHERE id = ?').get(info.lastInsertRowid);
    scheduleArray(row);
    res.status(201).json(publicArray(row));
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'An array with that name already exists' });
    }
    next(err);
  }
});

// Update a cluster (password optional; kept if blank).
router.put('/arrays/:id', [param('id').isInt(), ...arrayValidators], validate, (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM netapp_arrays WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Array not found' });
    const encrypted = req.body.password ? buildCredentials(req.body) : existing.encrypted_credentials;
    db.prepare(`
      UPDATE netapp_arrays SET name = ?, mgmt_host = ?, username = ?, encrypted_credentials = ?,
        polling_interval_minutes = ?, ssl_verify = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      req.body.name,
      netappApi.normalizeHost(req.body.mgmt_host),
      req.body.username,
      encrypted,
      req.body.polling_interval_minutes || existing.polling_interval_minutes,
      req.body.ssl_verify ? 1 : 0,
      req.params.id
    );
    const row = db.prepare('SELECT * FROM netapp_arrays WHERE id = ?').get(req.params.id);
    scheduleArray(row);
    res.json(publicArray(row));
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'An array with that name already exists' });
    }
    next(err);
  }
});

router.delete('/arrays/:id', [param('id').isInt()], validate, (req, res, next) => {
  try {
    const info = db.prepare('DELETE FROM netapp_arrays WHERE id = ?').run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'Array not found' });
    cancelArray(Number(req.params.id));
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.post('/arrays/:id/poll', [param('id').isInt()], validate, async (req, res, next) => {
  try {
    const array = db.prepare('SELECT * FROM netapp_arrays WHERE id = ?').get(req.params.id);
    if (!array) return res.status(404).json({ error: 'Array not found' });
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
      ...publicArray(a),
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

module.exports = router;
