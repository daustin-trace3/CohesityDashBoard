// Aria Operations routes. Mounted by the plugin dispatcher at /api/ariaops —
// paths are relative. Registration CRUD stores the password AES-encrypted;
// data endpoints serve the polled ariaops_* tables. The probe route hits the
// live instance and returns untransformed raw responses — every upstream
// shape here is UNVERIFIED, so this is the tool for finding out what a real
// vROps actually sends back.
const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const db = require('../db/database');
const { encrypt, decrypt } = require('../services/encryption');
const ariaopsApi = require('../services/ariaopsApi');
const { ariaopsPoller } = require('../services/ariaopsPoller');
const ariaopsAdvisor = require('../services/advisors/ariaopsAdvisor');
const { testTarget, assertSecretOnTargetChange, notBlockedHost } = require('../utils/connectionGuard');

const router = express.Router();

// The host is glued into https://<host>, so "name@127.0.0.1" or "name/path"
// would dial somewhere other than the name the blocked-host check looked at.
const HOST_RE = /^[A-Za-z0-9._:[\]-]+$/;

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid parameters', details: errors.array() });
  next();
};

const publicInstance = (row) => ({
  id: row.id, name: row.name, host: row.host, username: row.username, authSource: row.auth_source,
  sslVerify: !!row.ssl_verify, pollingIntervalMinutes: row.polling_interval_minutes,
  version: row.version,
  lastPollStatus: row.last_poll_status, lastPollError: row.last_poll_error, lastPollAt: row.last_poll_at,
});

// ── Instances CRUD ───────────────────────────────────────────────────────────

/** GET /api/ariaops/instances — registered instances (never the credentials). */
router.get('/instances', (req, res, next) => {
  try {
    res.json(db.prepare('SELECT * FROM ariaops_instances ORDER BY name').all().map(publicInstance));
  } catch (err) { next(err); }
});

/** POST /api/ariaops/instances — register an Aria Operations instance. */
router.post('/instances', [
  body('name').isString().trim().notEmpty().isLength({ max: 120 }),
  body('host').isString().trim().notEmpty().isLength({ max: 253 }).matches(HOST_RE).custom(notBlockedHost),
  body('username').isString().trim().notEmpty().isLength({ max: 256 }),
  body('password').isString().notEmpty().isLength({ max: 512 }),
  body('authSource').optional().isString().trim().isLength({ max: 256 }),
  body('sslVerify').optional().isBoolean(),
  body('pollingIntervalMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
], validate, (req, res, next) => {
  try {
    const { name, host, username, password, authSource, sslVerify, pollingIntervalMinutes } = req.body;
    const dup = db.prepare('SELECT id FROM ariaops_instances WHERE name = ? OR host = ?').get(name.trim(), host.trim());
    if (dup) return res.status(409).json({ error: 'An Aria Operations instance with that name or host is already registered.' });
    const info = db.prepare(`
      INSERT INTO ariaops_instances (name, host, username, auth_source, encrypted_credentials, ssl_verify, polling_interval_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(name.trim(), host.trim(), username.trim(), authSource?.trim() || null,
      encrypt(JSON.stringify({ password })), sslVerify ? 1 : 0, pollingIntervalMinutes || 15);
    const row = db.prepare('SELECT * FROM ariaops_instances WHERE id = ?').get(info.lastInsertRowid);
    ariaopsPoller.schedule(row);
    ariaopsPoller.trigger(row).catch(() => {});
    res.status(201).json(publicInstance(row));
  } catch (err) { next(err); }
});

/** PUT /api/ariaops/instances/:id — update (password optional; blank keeps stored). */
router.put('/instances/:id', [
  param('id').isInt().toInt(),
  body('name').optional().isString().trim().notEmpty().isLength({ max: 120 }),
  body('host').optional().isString().trim().notEmpty().isLength({ max: 253 }).matches(HOST_RE).custom(notBlockedHost),
  body('username').optional().isString().trim().notEmpty().isLength({ max: 256 }),
  body('password').optional().isString().isLength({ max: 512 }),
  body('authSource').optional().isString().trim().isLength({ max: 256 }),
  body('sslVerify').optional().isBoolean(),
  body('pollingIntervalMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM ariaops_instances WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Aria Operations instance not found.' });
    const b = req.body;
    const secretSupplied = !!(b.password && String(b.password).trim());
    try {
      assertSecretOnTargetChange({ stored: row, incoming: b, fields: ['host'], secretSupplied });
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }
    db.prepare(`
      UPDATE ariaops_instances SET
        name = ?, host = ?, username = ?, auth_source = ?, encrypted_credentials = ?,
        ssl_verify = ?, polling_interval_minutes = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      b.name?.trim() || row.name, b.host?.trim() || row.host, b.username?.trim() || row.username,
      b.authSource !== undefined ? (b.authSource?.trim() || null) : row.auth_source,
      b.password ? encrypt(JSON.stringify({ password: b.password })) : row.encrypted_credentials,
      b.sslVerify !== undefined ? (b.sslVerify ? 1 : 0) : row.ssl_verify,
      b.pollingIntervalMinutes || row.polling_interval_minutes,
      row.id
    );
    ariaopsApi.invalidateSession(row.id);
    const updated = db.prepare('SELECT * FROM ariaops_instances WHERE id = ?').get(row.id);
    ariaopsPoller.schedule(updated);
    res.json(publicInstance(updated));
  } catch (err) { next(err); }
});

/** DELETE /api/ariaops/instances/:id — unregister (CASCADE clears inventory). */
router.delete('/instances/:id', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM ariaops_instances WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Aria Operations instance not found.' });
    ariaopsPoller.cancel(row.id);
    ariaopsApi.invalidateSession(row.id);
    db.prepare('DELETE FROM ariaops_instances WHERE id = ?').run(row.id);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

/** POST /api/ariaops/instances/test — validate saved or candidate credentials. */
router.post('/instances/test', [
  body('host').isString().trim().notEmpty().isLength({ max: 253 }).matches(HOST_RE).custom(notBlockedHost),
  body('username').isString().trim().notEmpty(),
  body('password').optional().isString(),
  body('authSource').optional().isString(),
  body('id').optional().isInt().toInt(),
  body('sslVerify').optional().isBoolean(),
], validate, async (req, res) => {
  const { id, password } = req.body;
  const secretSupplied = !!(password && String(password).trim());
  const saved = id ? db.prepare('SELECT * FROM ariaops_instances WHERE id = ?').get(id) : null;
  if (!secretSupplied && !saved) {
    return res.status(400).json({ error: 'Enter the password to test a connection that is not saved yet.' });
  }
  let storedPassword = null;
  if (!secretSupplied) {
    try { storedPassword = JSON.parse(decrypt(saved.encrypted_credentials)).password; } catch { storedPassword = null; }
    if (!storedPassword) return res.status(400).json({ error: 'The saved password could not be read. Enter it again.' });
  }
  // With no typed password the saved one is used, and then every value that
  // decides where and how it is sent comes from the saved row, not the body.
  const target = testTarget({
    stored: saved,
    incoming: req.body,
    fields: { host: 'host', username: 'username', authSource: 'auth_source', sslVerify: 'ssl_verify' },
    secretSupplied,
  });
  const candidate = {
    host: target.host,
    username: target.username,
    password: secretSupplied ? password : storedPassword,
    auth_source: target.authSource,
    ssl_verify: [true, 1, 'true', '1'].includes(target.sslVerify) ? 1 : 0,
  };
  const result = await ariaopsApi.testConnection(candidate);
  res.status(result.ok ? 200 : 502).json(result);
});

/** POST /api/ariaops/instances/:id/refresh — poll this instance now. */
router.post('/instances/:id/refresh', [param('id').isInt().toInt()], validate, async (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM ariaops_instances WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Aria Operations instance not found.' });
    await ariaopsPoller.trigger(row);
    res.json(publicInstance(db.prepare('SELECT * FROM ariaops_instances WHERE id = ?').get(row.id)));
  } catch (err) {
    // A raw axios error carries the request config (login body, token
    // header). It never goes to next(); the poller already recorded the cause.
    if (err && (err.isAxiosError || err.config || err.response)) {
      return res.status(502).json({ error: 'The platform did not answer as expected.' });
    }
    next(err);
  }
});

// Each probe section runs the same fetcher the poller uses, live against the
// instance, and reports the RAW first item untransformed — this is the only
// place in the codebase that is meant to show an unmassaged upstream shape.
const PROBE_SECTIONS = [
  ['version', (row) => ariaopsApi.fetchVersion(row)],
  ['nodeStatus', (row) => ariaopsApi.fetchNodeStatus(row)],
  ['resources', (row) => ariaopsApi.fetchResourcesByKind(row, 'VirtualMachine')],
  ['alerts', (row) => ariaopsApi.fetchAlerts(row)],
  ['latestStats', async (row) => {
    const vms = await ariaopsApi.fetchResourcesByKind(row, 'VirtualMachine');
    const ids = vms.slice(0, 5).map((r) => r?.identifier).filter(Boolean);
    if (!ids.length) return [];
    const stats = await ariaopsApi.fetchLatestStats(row, ids);
    return [...stats.entries()].map(([resourceId, s]) => ({ resourceId, ...s }));
  }],
];

/** GET /api/ariaops/instances/:id/probe — raw-shape probe, read-only. */
router.get('/instances/:id/probe', [param('id').isInt().toInt()], validate, async (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM ariaops_instances WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Aria Operations instance not found.' });
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

/** GET /api/ariaops/overview — per-instance rollup + totals. */
router.get('/overview', (req, res, next) => {
  try {
    const instances = db.prepare('SELECT * FROM ariaops_instances ORDER BY name').all();
    const countsFor = (id) => {
      const res1 = db.prepare(`
        SELECT COUNT(*) AS total,
          SUM(CASE WHEN kind = 'VirtualMachine' THEN 1 ELSE 0 END) AS vms,
          SUM(CASE WHEN health = 'RED' THEN 1 ELSE 0 END) AS red,
          SUM(CASE WHEN health = 'YELLOW' THEN 1 ELSE 0 END) AS yellow,
          SUM(CASE WHEN health = 'GREEN' THEN 1 ELSE 0 END) AS green
        FROM ariaops_resources WHERE instance_id = ?
      `).get(id);
      const alertAgg = db.prepare(`
        SELECT COUNT(*) AS total, SUM(CASE WHEN level = 'CRITICAL' THEN 1 ELSE 0 END) AS crit,
          SUM(CASE WHEN level = 'IMMEDIATE' THEN 1 ELSE 0 END) AS immediate,
          SUM(CASE WHEN level = 'WARNING' THEN 1 ELSE 0 END) AS warning
        FROM ariaops_alerts WHERE instance_id = ?
      `).get(id);
      return {
        resources: res1.total || 0, vms: res1.vms || 0, resourcesRed: res1.red || 0,
        resourcesYellow: res1.yellow || 0, resourcesGreen: res1.green || 0,
        alerts: alertAgg.total || 0, alertsCritical: alertAgg.crit || 0,
        alertsImmediate: alertAgg.immediate || 0, alertsWarning: alertAgg.warning || 0,
      };
    };
    const perInstance = instances.map((inst) => ({
      id: inst.id, name: inst.name, host: inst.host, version: inst.version,
      lastPollAt: inst.last_poll_at, lastPollStatus: inst.last_poll_status,
      lastPollError: inst.last_poll_error, counts: countsFor(inst.id),
    }));
    const totals = perInstance.reduce((acc, i) => {
      for (const key of Object.keys(i.counts)) acc[key] = (acc[key] || 0) + i.counts[key];
      return acc;
    }, {});
    res.json({ instances: perInstance, totals });
  } catch (err) { next(err); }
});

/** GET /api/ariaops/resources?instanceId?&kind? */
router.get('/resources', [
  query('instanceId').optional().isInt().toInt(),
  query('kind').optional().isIn(['VirtualMachine', 'HostSystem', 'Datastore']),
], validate, (req, res, next) => {
  try {
    const clauses = [];
    const params = [];
    if (req.query.instanceId) { clauses.push('r.instance_id = ?'); params.push(req.query.instanceId); }
    if (req.query.kind) { clauses.push('r.kind = ?'); params.push(req.query.kind); }
    res.json(db.prepare(`
      SELECT r.*, i.name AS instance_name FROM ariaops_resources r
      JOIN ariaops_instances i ON i.id = r.instance_id
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY i.name, r.kind, r.name
    `).all(...params));
  } catch (err) { next(err); }
});

/** GET /api/ariaops/alerts?instanceId? */
router.get('/alerts', [query('instanceId').optional().isInt().toInt()], validate, (req, res, next) => {
  try {
    const clauses = [];
    const params = [];
    if (req.query.instanceId) { clauses.push('a.instance_id = ?'); params.push(req.query.instanceId); }
    res.json(db.prepare(`
      SELECT a.*, i.name AS instance_name FROM ariaops_alerts a
      JOIN ariaops_instances i ON i.id = a.instance_id
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY a.started_at_ms DESC
    `).all(...params));
  } catch (err) { next(err); }
});

/** GET /api/ariaops/metrics-history?instanceId&hours=168 */
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
      SELECT m.*, i.name AS instance_name FROM ariaops_metrics_history m
      JOIN ariaops_instances i ON i.id = m.instance_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY m.captured_at
    `).all(...params));
  } catch (err) { next(err); }
});

function advisorReportKey(slug) {
  return String(slug).replace(/-/g, '_');
}

/** GET /api/ariaops/advisor/:report — cached Aria Operations AI Advisor report. */
router.get('/advisor/:report', [param('report').isString()], validate, (req, res, next) => {
  try {
    const key = advisorReportKey(req.params.report);
    if (!ariaopsAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
    res.json({ enabled: ariaopsAdvisor.isConfigured(), report: ariaopsAdvisor.getCachedReport(key) });
  } catch (err) { next(err); }
});

/** POST /api/ariaops/advisor/:report — (re)generate and cache an Aria Operations AI Advisor report. */
router.post('/advisor/:report', [param('report').isString()], validate, async (req, res, next) => {
  try {
    const key = advisorReportKey(req.params.report);
    if (!ariaopsAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
    const result = await ariaopsAdvisor.generateReport(key);
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
