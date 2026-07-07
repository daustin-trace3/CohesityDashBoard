const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const db = require('../db/database');
const { encrypt } = require('../services/encryption');
const pureApi = require('../services/pureApi');
const { scheduleArray, cancelArray, triggerPoll } = require('../services/purePoller');
const cacheControl = require('../middleware/cache');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
}

// SSRF guard on the management host (strip scheme first).
function isBlockedHost(host) {
  const h = String(host || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').split(':')[0];
  const blocked = [
    /^127\./, /^0\.0\.0\.0$/, /^169\.254\./, /^::1$/,
    /^localhost$/i, /^metadata\.google\.internal$/i, /^169\.254\.169\.254$/,
  ];
  return blocked.some((p) => p.test(h));
}

const PEM_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----/;

function publicArray(row) {
  return {
    id: row.id,
    name: row.name,
    mgmt_host: row.mgmt_host,
    auth_method: row.auth_method || 'client',
    client_id: row.client_id,
    key_id: row.key_id,
    username: row.username,
    issuer: row.issuer,
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
  body('auth_method').optional().isIn(['client', 'token']).withMessage('auth_method must be client or token'),
  body('client_id').optional({ nullable: true }).trim(),
  body('key_id').optional({ nullable: true }).trim(),
  body('username').optional({ nullable: true }).trim(),
  body('issuer').optional({ nullable: true }).trim(),
  body('polling_interval_minutes').optional().isInt({ min: 5, max: 1440 })
    .withMessage('polling_interval_minutes must be 5-1440'),
  body('ssl_verify').optional().isBoolean().withMessage('ssl_verify must be boolean'),
];

// Method-specific credential checks that express-validator can't express cleanly.
// `requireSecret` is false on PUT (secrets may be left blank to keep existing).
function checkCredentials(body, { requireSecret }) {
  const method = body.auth_method === 'token' ? 'token' : 'client';
  if (method === 'client') {
    if (!body.client_id || !body.key_id || !body.username) {
      return 'client_id, key_id and username are required for API client auth';
    }
    if (requireSecret && !body.privateKey) {
      return 'privateKey is required for API client auth';
    }
    if (body.privateKey && !PEM_RE.test(body.privateKey)) {
      return 'privateKey must be a PEM-encoded RSA private key';
    }
  } else {
    if (requireSecret && !body.apiToken) {
      return 'apiToken is required for API token auth';
    }
    if (body.apiToken && String(body.apiToken).trim().length < 8) {
      return 'apiToken looks too short';
    }
  }
  return null;
}

// Build the encrypted credentials blob for whichever method is in use.
function buildCredentials(body) {
  if (body.auth_method === 'token') {
    return encrypt(JSON.stringify({ apiToken: String(body.apiToken).trim() }));
  }
  return encrypt(JSON.stringify({ privateKey: body.privateKey }));
}

/* ── Arrays CRUD ─────────────────────────────────────────────────────────── */

// GET /api/pure/arrays — list registered arrays (no secrets)
router.get('/arrays', cacheControl(15), (req, res, next) => {
  try {
    const rows = db.prepare('SELECT * FROM pure_arrays ORDER BY name ASC').all();
    res.json(rows.map(publicArray));
  } catch (err) {
    next(err);
  }
});

// GET /api/pure/defaults — non-secret defaults from env to prefill the Add form
router.get('/defaults', (req, res) => {
  res.json({
    client_id: process.env.PURE_ARRAY_CLIENT_ID || '',
    key_id: process.env.PURE_ARRAY_KEY_ID || '',
    username: process.env.PURE_ARRAY_USER || '',
  });
});

// POST /api/pure/arrays/test — validate credentials without persisting
router.post(
  '/arrays/test',
  [
    body('mgmt_host').trim().notEmpty().custom((v) => !isBlockedHost(v)).withMessage('mgmt_host is not allowed'),
    body('auth_method').optional().isIn(['client', 'token']),
    body('client_id').optional({ nullable: true }).trim(),
    body('key_id').optional({ nullable: true }).trim(),
    body('username').optional({ nullable: true }).trim(),
    body('issuer').optional({ nullable: true }).trim(),
    body('ssl_verify').optional().isBoolean(),
  ],
  validate,
  async (req, res) => {
    const credErr = checkCredentials(req.body, { requireSecret: true });
    if (credErr) return res.status(400).json({ ok: false, error: credErr });
    try {
      const result = await pureApi.testConnection({
        mgmt_host: req.body.mgmt_host,
        auth_method: req.body.auth_method === 'token' ? 'token' : 'client',
        client_id: req.body.client_id,
        key_id: req.body.key_id,
        username: req.body.username,
        issuer: req.body.issuer || null,
        ssl_verify: req.body.ssl_verify ? 1 : 0,
        privateKey: req.body.privateKey,
        apiToken: req.body.apiToken,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ ok: false, error: describeApiError(err) });
    }
  }
);

// POST /api/pure/arrays — register a new array
router.post(
  '/arrays',
  arrayValidators,
  validate,
  (req, res, next) => {
    const credErr = checkCredentials(req.body, { requireSecret: true });
    if (credErr) return res.status(400).json({ error: credErr });
    try {
      const method = req.body.auth_method === 'token' ? 'token' : 'client';
      const encrypted = buildCredentials(req.body);
      const info = db.prepare(`
        INSERT INTO pure_arrays
          (name, mgmt_host, auth_method, client_id, key_id, username, issuer,
           encrypted_credentials, polling_interval_minutes, ssl_verify)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.body.name,
        pureApi.normalizeHost(req.body.mgmt_host),
        method,
        req.body.client_id || '',
        req.body.key_id || '',
        req.body.username || '',
        req.body.issuer || null,
        encrypted,
        req.body.polling_interval_minutes || 15,
        req.body.ssl_verify ? 1 : 0
      );
      const row = db.prepare('SELECT * FROM pure_arrays WHERE id = ?').get(info.lastInsertRowid);
      scheduleArray(row);
      // Kick off an immediate first poll so data appears without waiting.
      triggerPoll(row.id).catch(() => {});
      res.status(201).json(publicArray(row));
    } catch (err) {
      if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(409).json({ error: 'An array with that name already exists' });
      }
      next(err);
    }
  }
);

// PUT /api/pure/arrays/:id — update an array (secret optional; kept if blank)
router.put(
  '/arrays/:id',
  [param('id').isInt(), ...arrayValidators],
  validate,
  (req, res, next) => {
    const credErr = checkCredentials(req.body, { requireSecret: false });
    if (credErr) return res.status(400).json({ error: credErr });
    try {
      const existing = db.prepare('SELECT * FROM pure_arrays WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Array not found' });

      const method = req.body.auth_method === 'token' ? 'token' : 'client';
      const hasNewSecret = method === 'token' ? !!req.body.apiToken : !!req.body.privateKey;
      const encrypted = hasNewSecret ? buildCredentials(req.body) : existing.encrypted_credentials;

      db.prepare(`
        UPDATE pure_arrays SET
          name = ?, mgmt_host = ?, auth_method = ?, client_id = ?, key_id = ?, username = ?, issuer = ?,
          encrypted_credentials = ?, polling_interval_minutes = ?, ssl_verify = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        req.body.name,
        pureApi.normalizeHost(req.body.mgmt_host),
        method,
        req.body.client_id || '',
        req.body.key_id || '',
        req.body.username || '',
        req.body.issuer || null,
        encrypted,
        req.body.polling_interval_minutes || existing.polling_interval_minutes,
        req.body.ssl_verify ? 1 : 0,
        req.params.id
      );

      const row = db.prepare('SELECT * FROM pure_arrays WHERE id = ?').get(req.params.id);
      pureApi.invalidate(row.id);
      scheduleArray(row);
      res.json(publicArray(row));
    } catch (err) {
      if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(409).json({ error: 'An array with that name already exists' });
      }
      next(err);
    }
  }
);

// DELETE /api/pure/arrays/:id
router.delete('/arrays/:id', [param('id').isInt()], validate, (req, res, next) => {
  try {
    const info = db.prepare('DELETE FROM pure_arrays WHERE id = ?').run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'Array not found' });
    cancelArray(Number(req.params.id));
    pureApi.invalidate(Number(req.params.id));
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/pure/arrays/:id/poll — trigger an immediate poll
router.post('/arrays/:id/poll', [param('id').isInt()], validate, async (req, res, next) => {
  try {
    const array = db.prepare('SELECT * FROM pure_arrays WHERE id = ?').get(req.params.id);
    if (!array) return res.status(404).json({ error: 'Array not found' });
    await triggerPoll(array.id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/* ── Telemetry reads ─────────────────────────────────────────────────────── */

// GET /api/pure/overview — latest sample + open alert count for every array
router.get('/overview', cacheControl(15), (req, res, next) => {
  try {
    const arrays = db.prepare('SELECT * FROM pure_arrays ORDER BY name ASC').all();
    const latestStmt = db.prepare(`
      SELECT * FROM pure_metrics_history
      WHERE array_id = ? ORDER BY captured_at DESC LIMIT 1
    `);
    const alertStmt = db.prepare(
      "SELECT COUNT(*) AS n FROM pure_alerts WHERE array_id = ? AND (state IS NULL OR state = 'open')"
    );
    const volStmt = db.prepare('SELECT COUNT(*) AS n FROM pure_volumes WHERE array_id = ?');
    const hostStmt = db.prepare('SELECT COUNT(*) AS n FROM pure_hosts WHERE array_id = ?');

    const payload = arrays.map((a) => ({
      ...publicArray(a),
      latest: latestStmt.get(a.id) || null,
      open_alerts: alertStmt.get(a.id).n,
      volume_count: volStmt.get(a.id).n,
      host_count: hostStmt.get(a.id).n,
    }));
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// GET /api/pure/alerts — open alerts across every array
router.get('/alerts', cacheControl(15), (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT pa.*, a.name AS array_name
      FROM pure_alerts pa
      JOIN pure_arrays a ON a.id = pa.array_id
      WHERE (pa.state IS NULL OR pa.state = 'open')
      ORDER BY CASE LOWER(pa.severity)
        WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 WHEN 'info' THEN 2 ELSE 3 END,
        pa.updated_at_ms DESC
    `).all();
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/pure/volumes — volumes across every array
router.get('/volumes', cacheControl(30), (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT pv.*, a.name AS array_name
      FROM pure_volumes pv
      JOIN pure_arrays a ON a.id = pv.array_id
      WHERE pv.destroyed = 0 OR pv.destroyed IS NULL
      ORDER BY pv.provisioned_bytes DESC
    `).all();
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/pure/arrays/:id/metrics/latest
router.get('/arrays/:id/metrics/latest', [param('id').isInt()], validate, cacheControl(15), (req, res, next) => {
  try {
    const row = db.prepare(`
      SELECT * FROM pure_metrics_history
      WHERE array_id = ? ORDER BY captured_at DESC LIMIT 1
    `).get(req.params.id);
    res.json(row || null);
  } catch (err) {
    next(err);
  }
});

// GET /api/pure/arrays/:id/metrics/history?days=7
router.get(
  '/arrays/:id/metrics/history',
  [param('id').isInt(), query('days').optional().isInt({ min: 1, max: 90 })],
  validate,
  cacheControl(30),
  (req, res, next) => {
    try {
      const days = Number(req.query.days) || 7;
      const rows = db.prepare(`
        SELECT * FROM pure_metrics_history
        WHERE array_id = ? AND captured_at >= datetime('now', ?)
        ORDER BY captured_at ASC
      `).all(req.params.id, `-${days} days`);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/pure/arrays/:id/alerts
router.get('/arrays/:id/alerts', [param('id').isInt()], validate, cacheControl(15), (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT * FROM pure_alerts WHERE array_id = ?
      ORDER BY CASE LOWER(severity)
        WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 WHEN 'info' THEN 2 ELSE 3 END,
        updated_at_ms DESC
    `).all(req.params.id);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/pure/arrays/:id/volumes
router.get('/arrays/:id/volumes', [param('id').isInt()], validate, cacheControl(30), (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT * FROM pure_volumes WHERE array_id = ?
      ORDER BY provisioned_bytes DESC
    `).all(req.params.id);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/pure/arrays/:id/hosts
router.get('/arrays/:id/hosts', [param('id').isInt()], validate, cacheControl(30), (req, res, next) => {
  try {
    const rows = db.prepare('SELECT * FROM pure_hosts WHERE array_id = ? ORDER BY name ASC').all(req.params.id);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

function describeApiError(err) {
  if (err?.response) {
    const status = err.response.status;
    const detail = err.response.data?.errors?.[0]?.message
      || err.response.data?.error_description
      || err.response.data?.error
      || '';
    if (status === 400 || status === 401) return `Authentication failed (HTTP ${status})${detail ? `: ${detail}` : ''}`;
    return `Array returned HTTP ${status}${detail ? `: ${detail}` : ''}`;
  }
  if (err?.code === 'PURE_NO_KEY') return 'No private key provided';
  if (err?.code === 'PURE_NO_TOKEN') return 'No API token provided';
  if (err?.code) return `Network error: ${err.code}`;
  return err?.message || 'Connection failed';
}

module.exports = router;
