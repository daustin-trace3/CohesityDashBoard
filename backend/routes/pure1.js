const express = require('express');
const pure1Api = require('../services/pure1Api');
const pure1Poller = require('../services/pure1Poller');
const cacheControl = require('../middleware/cache');

const router = express.Router();

// Whether Pure1 cloud is wired up (app id + private key present).
router.get('/status', (req, res) => {
  res.json({
    configured: pure1Api.isConfigured(),
    lastRefresh: pure1Api.lastRefresh(),
    lastPoll: pure1Poller.getLastPoll(),
    pollIntervalMin: pure1Api.getPollIntervalMin(),
    ...pure1Api.getDisplayPrefs(),
  });
});

// Trigger an immediate fleet poll (persist a fresh snapshot + capacity sample).
router.post('/poll', async (req, res, next) => {
  try {
    if (!pure1Api.isConfigured()) return res.status(400).json({ error: 'Pure is not configured' });
    const count = await pure1Poller.pollFleet();
    res.json({ ok: true, arrayCount: count, lastPoll: pure1Poller.getLastPoll() });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
});

// Full (non-secret) Pure configuration for the Settings page.
router.get('/settings', (req, res, next) => {
  try {
    res.json(pure1Api.getConfig());
  } catch (err) { next(err); }
});

// Update Pure configuration (app ID, private key, cache TTL, thresholds).
router.put('/settings', (req, res, next) => {
  try {
    const cfg = pure1Api.setConfig(req.body || {});
    // Re-arm the background poller if cadence or credentials changed.
    if (req.body && (req.body.pollIntervalMin != null || req.body.appId != null || req.body.privateKey != null)) {
      try { pure1Poller.reschedule(); } catch { /* poller idle if unconfigured */ }
    }
    res.json(cfg);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

// Validate connectivity with the current configuration.
router.post('/test', async (req, res, next) => {
  try {
    if (!pure1Api.isConfigured()) return res.status(400).json({ error: 'Pure is not configured' });
    res.json(await pure1Api.testConnection());
  } catch (err) {
    const status = (err.response && err.response.status) || 502;
    const detail = (err.response && err.response.data && (err.response.data.error_description || JSON.stringify(err.response.data))) || err.message;
    res.status(200).json({ ok: false, error: `${status}: ${detail}` });
  }
});

// Fleet overview: every array in the Pure1 account with latest capacity.
// Served from the stored snapshot by default (instant, no live Pure1 call);
// `?refresh=1` forces a live fetch AND re-persists the snapshot in the
// background so subsequent stored reads are current.
router.get('/overview', cacheControl(120), async (req, res, next) => {
  try {
    if (!pure1Api.isConfigured()) return res.json([]);
    const force = req.query.refresh === '1';
    if (!force && pure1Poller.hasStoredData()) {
      return res.json(pure1Poller.getStoredOverview());
    }
    const rows = await pure1Api.getOverview({ force });
    // Refresh the persisted copy so trending/dashboard stay in sync.
    pure1Poller.pollFleet().catch(() => {});
    res.json(rows);
  } catch (err) { next(err); }
});

// Open fleet alerts across all arrays.
router.get('/alerts', cacheControl(120), async (req, res, next) => {
  try {
    if (!pure1Api.isConfigured()) return res.json([]);
    const force = req.query.refresh === '1';
    res.json(await pure1Api.getAlerts({ force }));
  } catch (err) { next(err); }
});

// Fleet health rollup + provisioned totals (health dots, over-subscription).
router.get('/enrichment', cacheControl(120), async (req, res, next) => {
  try {
    if (!pure1Api.isConfigured()) return res.json({});
    const force = req.query.refresh === '1';
    res.json(await pure1Api.getEnrichment({ force }));
  } catch (err) { next(err); }
});

// ── Per-array drill-downs (arrayId is the Pure1 array UUID) ──────────────────

function requireArrayId(req, res) {
  const id = String(req.query.arrayId || '').trim();
  if (!id) { res.status(400).json({ error: 'arrayId query param is required' }); return null; }
  return id;
}

router.get('/volumes', cacheControl(120), async (req, res, next) => {
  try {
    if (!pure1Api.isConfigured()) return res.json([]);
    const id = requireArrayId(req, res); if (!id) return undefined;
    res.json(await pure1Api.fetchVolumes(id));
  } catch (err) { next(err); }
});

router.get('/pods', cacheControl(120), async (req, res, next) => {
  try {
    if (!pure1Api.isConfigured()) return res.json([]);
    res.json(await pure1Api.fetchPods());
  } catch (err) { next(err); }
});

router.get('/hardware', cacheControl(300), async (req, res, next) => {
  try {
    if (!pure1Api.isConfigured()) return res.json({ controllers: [], components: [], drives: [] });
    const id = requireArrayId(req, res); if (!id) return undefined;
    res.json(await pure1Api.fetchHardware(id));
  } catch (err) { next(err); }
});

router.get('/connectivity', cacheControl(300), async (req, res, next) => {
  try {
    if (!pure1Api.isConfigured()) return res.json({ interfaces: [], ports: [] });
    const id = requireArrayId(req, res); if (!id) return undefined;
    res.json(await pure1Api.fetchConnectivity(id));
  } catch (err) { next(err); }
});

router.get('/capacity/history', cacheControl(300), async (req, res, next) => {
  try {
    if (!pure1Api.isConfigured()) return res.json({ series: {} });
    const id = requireArrayId(req, res); if (!id) return undefined;
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
    const force = req.query.refresh === '1';
    // Prefer locally stored history (survives restarts, spans any window). Fall
    // back to a live Pure1 fetch until enough samples have accrued locally.
    if (!force) {
      const stored = pure1Poller.getStoredCapacityHistory(id, days);
      if (stored) return res.json(stored);
    }
    res.json(await pure1Api.fetchCapacityHistory(id, days));
  } catch (err) { next(err); }
});

router.get('/performance/history', cacheControl(120), async (req, res, next) => {
  try {
    if (!pure1Api.isConfigured()) return res.json({ series: {} });
    const id = requireArrayId(req, res); if (!id) return undefined;
    const days = Math.min(30, Math.max(1, Number(req.query.days) || 1));
    res.json(await pure1Api.fetchPerformanceHistory(id, days));
  } catch (err) { next(err); }
});

module.exports = router;
