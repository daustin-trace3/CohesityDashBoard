// Zerto Analytics routes. Mounted at /api/zerto in server.js —
// all paths here are relative. Data is served from the polled zerto_* tables;
// /account manages the SaaS credential (encrypted in app_settings).
const express = require('express');
const { body, query, validationResult } = require('express-validator');
const db = require('../db/database');
const { getSetting, setSetting } = require('../services/settings');
const { encrypt } = require('../services/encryption');
const zertoApi = require('../services/zertoApi');
const { refreshAll, zertoTask } = require('../services/zertoPoller');

const router = express.Router();

function latestSnapshot() {
  return db.prepare('SELECT * FROM zerto_metrics_history ORDER BY captured_at DESC LIMIT 1').get() || null;
}

/** GET /api/zerto/overview — account rollup + latest snapshot. */
router.get('/overview', (req, res, next) => {
  try {
    const vpgHealth = db.prepare(`
      SELECT health, COUNT(*) AS count FROM zerto_vpgs GROUP BY health
    `).all();
    const alertSeverity = db.prepare(`
      SELECT severity, COUNT(*) AS count FROM zerto_alerts GROUP BY severity
    `).all();
    res.json({
      configured: zertoApi.zertoConfigured(),
      snapshot: latestSnapshot(),
      vpgHealth,
      alertSeverity,
      worstRpoVpgs: db.prepare(`
        SELECT name, actual_rpo, configured_rpo, protected_site, recovery_site, health
        FROM zerto_vpgs WHERE actual_rpo IS NOT NULL
        ORDER BY actual_rpo DESC LIMIT 10
      `).all(),
    });
  } catch (err) { next(err); }
});

/** GET /api/zerto/sites — discovered site inventory. */
router.get('/sites', (req, res, next) => {
  try {
    res.json(db.prepare('SELECT * FROM zerto_sites ORDER BY name').all());
  } catch (err) { next(err); }
});

/** GET /api/zerto/vpgs — VPGs with RPO/health/journal detail. */
router.get('/vpgs', (req, res, next) => {
  try {
    res.json(db.prepare('SELECT * FROM zerto_vpgs ORDER BY name').all());
  } catch (err) { next(err); }
});

/** GET /api/zerto/alerts — current alerts. */
router.get('/alerts', (req, res, next) => {
  try {
    res.json(db.prepare(`
      SELECT * FROM zerto_alerts
      ORDER BY CASE severity WHEN 'Error' THEN 0 WHEN 'Warning' THEN 1 ELSE 2 END, collection_time DESC
    `).all());
  } catch (err) { next(err); }
});

/** GET /api/zerto/vms — protected VMs. */
router.get('/vms', (req, res, next) => {
  try {
    res.json(db.prepare('SELECT * FROM zerto_vms ORDER BY name').all());
  } catch (err) { next(err); }
});

/** GET /api/zerto/trends?days= — account snapshot series. */
router.get('/trends', [
  query('days').optional().isInt({ min: 1, max: 365 }).toInt(),
], (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid parameters' });
  try {
    const days = req.query.days ?? 30;
    res.json(db.prepare(`
      SELECT * FROM zerto_metrics_history
      WHERE captured_at >= datetime('now', ?)
      ORDER BY captured_at
    `).all(`-${days} days`));
  } catch (err) { next(err); }
});

/** GET /api/zerto/account — credential/config status (never returns the password). */
router.get('/account', (req, res, next) => {
  try {
    const cfg = zertoApi.getZertoConfig();
    res.json({
      configured: zertoApi.zertoConfigured(),
      username: cfg.username,
      baseUrl: cfg.baseUrl,
      hasPassword: !!(getSetting('zerto_password') || process.env.ZERTO_PASSWORD),
      passSource: getSetting('zerto_password') ? 'settings' : (process.env.ZERTO_PASSWORD ? 'env' : 'none'),
      pollIntervalMinutes: Number(getSetting('zerto_poll_interval_minutes')) || 15,
      siteCount: db.prepare('SELECT COUNT(*) AS n FROM zerto_sites').get().n,
      lastCapture: (latestSnapshot() || {}).captured_at || null,
    });
  } catch (err) { next(err); }
});

/** PUT /api/zerto/account — save credentials (password encrypted at rest). */
router.put('/account', [
  body('username').optional().isString().trim().isLength({ max: 256 }),
  body('password').optional().isString().isLength({ max: 512 }),
  body('baseUrl').optional().isString().trim().isLength({ max: 512 }),
  body('pollIntervalMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
], (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid parameters' });
  try {
    const { username, password, baseUrl, pollIntervalMinutes } = req.body;
    if (username != null) setSetting('zerto_username', String(username).trim());
    if (password) setSetting('zerto_password', encrypt(String(password)));
    if (baseUrl != null) setSetting('zerto_base_url', String(baseUrl).trim().replace(/\/+$/, ''));
    if (pollIntervalMinutes != null) {
      setSetting('zerto_poll_interval_minutes', String(pollIntervalMinutes));
      zertoTask.reschedule();
    }
    zertoApi.invalidateToken();
    if (zertoApi.zertoConfigured() && !zertoTask.isRunning()) zertoTask.reschedule();
    res.json({ saved: true, configured: zertoApi.zertoConfigured() });
  } catch (err) { next(err); }
});

/** POST /api/zerto/account/test — validate saved or candidate credentials. */
router.post('/account/test', [
  body('username').optional().isString().trim(),
  body('password').optional().isString(),
  body('baseUrl').optional().isString().trim(),
], async (req, res) => {
  const result = await zertoApi.testConnection({
    username: req.body?.username, password: req.body?.password, baseUrl: req.body?.baseUrl,
  });
  res.status(result.ok ? 200 : 502).json(result);
});

/** POST /api/zerto/refresh — force a poll now. */
router.post('/refresh', async (req, res, next) => {
  try {
    if (!zertoApi.zertoConfigured()) {
      return res.status(503).json({ error: 'Zerto Analytics credentials are not configured (Zerto → Settings).' });
    }
    await refreshAll();
    res.json({ refreshed: true, snapshot: latestSnapshot() });
  } catch (err) { next(err); }
});

module.exports = router;
