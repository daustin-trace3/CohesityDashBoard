const express = require('express');
const db = require('../db/database');
const pure1Api = require('../services/pure1Api');
const { pure1Task } = require('../services/pure1Poller');
const { isDemo } = require('../services/demoMode');
const { getSetting } = require('../services/settings');
const cacheControl = require('../middleware/cache');

const router = express.Router();

function toEpoch(capturedAt) {
  if (!capturedAt) return null;
  const ms = new Date(capturedAt.endsWith('Z') ? capturedAt : `${capturedAt}Z`).getTime();
  return isNaN(ms) ? null : ms;
}

function rowToOverview(row) {
  const total = row.capacity_bytes || 0;
  const used = row.used_bytes || 0;
  return {
    id: row.pure1_id,
    name: row.name,
    fqdn: row.fqdn,
    model: row.model,
    os: row.os,
    version: row.version,
    total,
    used,
    pctUsed: total > 0 ? (used / total) * 100 : null,
    dataReduction: row.data_reduction || null,
    effectiveUsed: row.effective_used_bytes || null,
    volumeSpace: row.volume_bytes || 0,
    snapshotSpace: row.snapshots_bytes || 0,
    sharedSpace: row.shared_bytes || 0,
    capturedAt: toEpoch(row.captured_at),
    tags: row.tags ? JSON.parse(row.tags) : [],
  };
}

function rowToAlert(row) {
  return {
    id: row.pure1_alert_id,
    arrayName: row.array_name,
    arrayFqdn: row.array_fqdn,
    severity: row.severity,
    category: row.category,
    component: row.component_name,
    componentType: row.component_type,
    summary: row.summary,
    code: row.code,
    state: row.state,
    created: row.created_at_ms,
    updated: row.updated_at_ms,
    knowledgeBaseUrl: row.knowledge_base_url,
  };
}

function rowToPod(row) {
  return {
    id: row.pure1_pod_id,
    name: row.name,
    mediator: row.mediator,
    arrays: row.arrays ? JSON.parse(row.arrays) : [],
  };
}

function dbOverview() {
  return db.prepare('SELECT * FROM pure1_arrays').all().map(rowToOverview).sort((a, b) => a.name.localeCompare(b.name));
}

function dbAlerts() {
  return db.prepare('SELECT * FROM pure1_alerts').all().map(rowToAlert);
}

function dbEnrichment() {
  const out = {};
  for (const row of db.prepare('SELECT * FROM pure1_arrays').all()) {
    out[row.pure1_id] = {
      health: row.health,
      unhealthy: row.health_detail ? (JSON.parse(row.health_detail).unhealthy || 0) : 0,
      provisioned: row.provisioned_bytes || 0,
      chassisSerial: row.chassis_serial,
      controllerSerials: row.controller_serials ? JSON.parse(row.controller_serials) : [],
    };
  }
  return out;
}

function dbPods() {
  return db.prepare('SELECT * FROM pure1_pods').all().map(rowToPod).sort((a, b) => a.name.localeCompare(b.name));
}

// Whether Pure1 cloud is wired up (app id + private key present).
router.get('/status', (req, res) => {
  const lastRow = db.prepare('SELECT MAX(captured_at) AS captured_at FROM pure1_metrics_history').get();
  const lastDataCapture = lastRow && lastRow.captured_at ? `${lastRow.captured_at}Z` : null;
  res.json({
    configured: pure1Api.isConfigured(),
    lastRefresh: pure1Api.lastRefresh(),
    lastDataCapture,
    pollIntervalMinutes: Number(getSetting('pure1_poll_interval_minutes')) || 15,
    ...pure1Api.getDisplayPrefs(),
  });
});

// Full (non-secret) Pure configuration for the Settings page.
router.get('/settings', (req, res, next) => {
  try {
    res.json(pure1Api.getConfig());
  } catch (err) { next(err); }
});

// Update Pure configuration (app ID, private key, cache TTL, thresholds, poll interval).
router.put('/settings', (req, res, next) => {
  try {
    const result = pure1Api.setConfig(req.body || {});
    pure1Task.reschedule();
    res.json(result);
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
// DB-backed (poller-populated) outside demo mode; ?refresh=1 triggers an
// immediate poll before reading. Demo mode keeps the original live-fixture path.
router.get('/overview', cacheControl(120), async (req, res, next) => {
  try {
    if (isDemo()) return res.json(await pure1Api.getOverview({ force: req.query.refresh === '1' }));
    if (!pure1Api.isConfigured()) return res.json([]);
    if (req.query.refresh === '1') await pure1Task.trigger();
    res.json(dbOverview());
  } catch (err) { next(err); }
});

// Open fleet alerts across all arrays.
router.get('/alerts', cacheControl(120), async (req, res, next) => {
  try {
    if (isDemo()) return res.json(await pure1Api.getAlerts({ force: req.query.refresh === '1' }));
    if (!pure1Api.isConfigured()) return res.json([]);
    if (req.query.refresh === '1') await pure1Task.trigger();
    res.json(dbAlerts());
  } catch (err) { next(err); }
});

// Fleet health rollup + provisioned totals (health dots, over-subscription).
router.get('/enrichment', cacheControl(120), async (req, res, next) => {
  try {
    if (isDemo()) return res.json(await pure1Api.getEnrichment({ force: req.query.refresh === '1' }));
    if (!pure1Api.isConfigured()) return res.json({});
    res.json(dbEnrichment());
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
    if (isDemo()) return res.json(await pure1Api.fetchPods());
    if (!pure1Api.isConfigured()) return res.json([]);
    res.json(dbPods());
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
