// Zerto Analytics routes, ported from backend/routes/zerto.js. Mounted by
// the host dispatcher at /api/zerto — paths below are relative. Data is
// served from the polled zerto_* tables; /account manages the SaaS
// credential (encrypted in app_settings).
//
// DEVIATION FROM THE BUILT-IN: bundled plugins cannot require the host's
// express/express-validator — createRouter must return a BARE (req, res,
// next) function (dell/unifi/nutanix router.js pattern). This file
// hand-matches req.method/req.path against a route table (compile.js) and
// re-implements the validation express-validator did inline (validate.js),
// preserving the same status codes (400 invalid params, 404 unknown alert
// type/report, 502 upstream/test-connection failure, 503 not configured,
// 429 advisor rate-limited) and JSON response shapes exactly.
const api = require('./api');
const { getPoller, refreshAll } = require('./poller');
const { createZertoAdvisor } = require('./advisor');
const { compile } = require('./compile');
const { badRequest, fail, isNonEmptyString, isBooleanish, parseQueryInt } = require('./validate');

function latestSnapshot(coreApi) {
  return coreApi.db.prepare('SELECT * FROM zerto_metrics_history ORDER BY captured_at DESC LIMIT 1').get() || null;
}

/** GET /overview — account rollup + latest snapshot. */
function handleGetOverview(req, res, coreApi) {
  const db = coreApi.db;
  const vpgHealth = db.prepare('SELECT health, COUNT(*) AS count FROM zerto_vpgs GROUP BY health').all();
  const alertSeverity = db.prepare('SELECT severity, COUNT(*) AS count FROM zerto_alerts GROUP BY severity').all();
  res.json({
    configured: api.zertoConfigured(coreApi),
    snapshot: latestSnapshot(coreApi),
    vpgHealth,
    alertSeverity,
    vraCount: db.prepare('SELECT COUNT(*) AS n FROM zerto_vras').get().n,
    zorgCount: db.prepare("SELECT COUNT(DISTINCT zorg_name) AS n FROM zerto_vpgs WHERE zorg_name IS NOT NULL AND zorg_name != ''").get().n,
    rpoBreaches: db.prepare('SELECT COUNT(*) AS n FROM zerto_vpgs WHERE configured_rpo > 0 AND actual_rpo > configured_rpo').get().n,
    journalBreaches: db.prepare('SELECT COUNT(*) AS n FROM zerto_vpgs WHERE configured_journal_history > 0 AND actual_journal_history < configured_journal_history').get().n,
    worstRpoVpgs: db.prepare(`
      SELECT name, actual_rpo, configured_rpo, protected_site, recovery_site, health
      FROM zerto_vpgs WHERE actual_rpo IS NOT NULL
      ORDER BY actual_rpo DESC LIMIT 10
    `).all(),
  });
}

/** GET /sites — discovered site inventory. */
function handleGetSites(req, res, coreApi) {
  res.json(coreApi.db.prepare('SELECT * FROM zerto_sites ORDER BY name').all());
}

/** GET /vpgs — VPGs with RPO/health/journal detail. */
function handleGetVpgs(req, res, coreApi) {
  res.json(coreApi.db.prepare('SELECT * FROM zerto_vpgs ORDER BY name').all());
}

/** GET /alerts — current alerts. */
function handleGetAlerts(req, res, coreApi) {
  res.json(coreApi.db.prepare(`
    SELECT * FROM zerto_alerts
    ORDER BY CASE severity WHEN 'Error' THEN 0 WHEN 'Warning' THEN 1 ELSE 2 END, collection_time DESC
  `).all());
}

/** GET /alert-types — the per-type notification catalog: every known Zerto
 *  alert code (official reference + codes seen live) with its SMTP enabled
 *  flag and how many alerts of that type are currently active. */
function handleGetAlertTypes(req, res, coreApi) {
  res.json(coreApi.db.prepare(`
    SELECT c.alert_type AS code, c.entity, c.severity, c.description,
           c.enabled, c.first_seen AS firstSeen, c.last_seen AS lastSeen,
           (SELECT COUNT(*) FROM zerto_alerts z WHERE z.alert_type = c.alert_type) AS activeCount
    FROM zerto_alert_catalog c
    ORDER BY c.alert_type
  `).all().map((r) => ({ ...r, enabled: !!r.enabled })));
}

/** PUT /alert-types/:code — enable/disable SMTP notifications for one alert
 *  type. Disabled codes are skipped by the alert notifier entirely. */
function handlePutAlertType(req, res, coreApi) {
  const code = req.params.code;
  const errors = [];
  if (!isNonEmptyString(code, 32)) errors.push(fail('code'));
  if (!isBooleanish(req.body?.enabled)) errors.push(fail('enabled'));
  if (errors.length) return badRequest(res, errors);
  const enabled = req.body.enabled === true || req.body.enabled === 'true' || req.body.enabled === 1 || req.body.enabled === '1';
  const info = coreApi.db.prepare('UPDATE zerto_alert_catalog SET enabled = ? WHERE alert_type = ?')
    .run(enabled ? 1 : 0, code);
  if (info.changes === 0) return res.status(404).json({ error: 'Unknown alert type' });
  res.json({ ok: true, code, enabled });
}

/** GET /licenses — license entitlement/consumption from /v3/licenses, with
 *  the per-site usage breakdown parsed out of the stored JSON. */
function handleGetLicenses(req, res, coreApi) {
  const rows = coreApi.db.prepare('SELECT * FROM zerto_licenses ORDER BY license_key').all();
  res.json(rows.map((r) => ({
    licenseKey: r.license_key,
    licensePackage: r.license_package,
    availableVms: r.available_vms,
    usedVms: r.used_vms,
    isShared: !!r.is_shared,
    expirationDate: r.expiration_date,
    alerts: JSON.parse(r.alerts || '[]'),
    siteUsage: JSON.parse(r.site_usage || '[]'),
    updatedAt: r.updated_at,
  })));
}

/** GET /vras — VRA appliances per site (from the topology feed). */
function handleGetVras(req, res, coreApi) {
  res.json(coreApi.db.prepare('SELECT * FROM zerto_vras ORDER BY site_name, name').all());
}

/**
 * GET /replication — replication flows between site pairs, derived from the
 * stored VPGs: one flow per (protected_site → recovery_site) with a health
 * rollup and its VPG list, ready for the flow-map visualization.
 */
function handleGetReplication(req, res, coreApi) {
  const vpgs = coreApi.db.prepare('SELECT * FROM zerto_vpgs ORDER BY name').all();
  const flows = new Map();
  for (const v of vpgs) {
    const from = v.protected_site || '(unknown)';
    const to = v.recovery_site || '(unknown)';
    const key = `${from}|${to}`;
    if (!flows.has(key)) {
      flows.set(key, {
        from, to,
        fromType: v.protected_site_type, toType: v.recovery_site_type,
        vpgCount: 0, vmCount: 0, healthy: 0, warning: 0, error: 0,
        worstRpo: null, vpgs: [],
      });
    }
    const f = flows.get(key);
    f.vpgCount += 1;
    f.vmCount += v.vms_count || 0;
    if (v.health === 'Healthy') f.healthy += 1;
    else if (v.health === 'Error') f.error += 1;
    else f.warning += 1;
    if (v.actual_rpo != null && (f.worstRpo == null || v.actual_rpo > f.worstRpo)) f.worstRpo = v.actual_rpo;
    f.vpgs.push({
      name: v.name, health: v.health, status: v.status,
      actual_rpo: v.actual_rpo, configured_rpo: v.configured_rpo, vms_count: v.vms_count,
    });
  }
  res.json([...flows.values()].sort((a, b) => b.vpgCount - a.vpgCount));
}

/** GET /vms — protected VMs. */
function handleGetVms(req, res, coreApi) {
  res.json(coreApi.db.prepare('SELECT * FROM zerto_vms ORDER BY name').all());
}

/** GET /trends?days= — account snapshot series. */
function handleGetTrends(req, res, coreApi) {
  const daysQ = parseQueryInt(req.query.days, 1, 365);
  if (!daysQ.ok) return badRequest(res, [fail('days')]);
  const days = daysQ.value === undefined ? 30 : daysQ.value;
  res.json(coreApi.db.prepare(`
    SELECT * FROM zerto_metrics_history
    WHERE captured_at >= datetime('now', ?)
    ORDER BY captured_at
  `).all(`-${days} days`));
}

/** GET /account — credential/config status (never returns the password). */
function handleGetAccount(req, res, coreApi) {
  const cfg = api.getZertoConfig(coreApi);
  res.json({
    configured: api.zertoConfigured(coreApi),
    username: cfg.username,
    baseUrl: cfg.baseUrl,
    hasPassword: !!(coreApi.settings.getSetting('zerto_password') || process.env.ZERTO_PASSWORD),
    passSource: coreApi.settings.getSetting('zerto_password') ? 'settings' : (process.env.ZERTO_PASSWORD ? 'env' : 'none'),
    pollIntervalMinutes: Number(coreApi.settings.getSetting('zerto_poll_interval_minutes')) || 15,
    siteCount: coreApi.db.prepare('SELECT COUNT(*) AS n FROM zerto_sites').get().n,
    lastCapture: (latestSnapshot(coreApi) || {}).captured_at || null,
  });
}

/** PUT /account — save credentials (password encrypted at rest). */
function handlePutAccount(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  if (b.username !== undefined && !(typeof b.username === 'string' && b.username.length <= 256)) errors.push(fail('username'));
  if (b.password !== undefined && !(typeof b.password === 'string' && b.password.length <= 512)) errors.push(fail('password'));
  if (b.baseUrl !== undefined && !(typeof b.baseUrl === 'string' && b.baseUrl.length <= 512)) errors.push(fail('baseUrl'));
  if (b.pollIntervalMinutes !== undefined) {
    const n = Number(b.pollIntervalMinutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) errors.push(fail('pollIntervalMinutes'));
  }
  if (errors.length) return badRequest(res, errors);

  const settings = coreApi.settings;
  if (b.username != null) settings.setSetting('zerto_username', String(b.username).trim());
  if (b.password) settings.setSetting('zerto_password', coreApi.encryption.encrypt(String(b.password)));
  if (b.baseUrl != null) settings.setSetting('zerto_base_url', String(b.baseUrl).trim().replace(/\/+$/, ''));
  if (b.pollIntervalMinutes != null) {
    settings.setSetting('zerto_poll_interval_minutes', String(b.pollIntervalMinutes));
    getPoller(coreApi).schedule({ id: 0, name: 'account' });
  }
  api.invalidateToken();
  if (api.zertoConfigured(coreApi) && getPoller(coreApi).taskCount() === 0) getPoller(coreApi).schedule({ id: 0, name: 'account' });
  res.json({ saved: true, configured: api.zertoConfigured(coreApi) });
}

/** POST /account/test — validate saved or candidate credentials. */
async function handlePostAccountTest(req, res, coreApi) {
  const b = req.body || {};
  const result = await api.testConnection(coreApi, {
    username: typeof b.username === 'string' ? b.username.trim() : undefined,
    password: typeof b.password === 'string' ? b.password : undefined,
    baseUrl: typeof b.baseUrl === 'string' ? b.baseUrl.trim() : undefined,
  });
  res.status(result.ok ? 200 : 502).json(result);
}

/** POST /refresh — force a poll now. */
async function handlePostRefresh(req, res, coreApi) {
  if (!api.zertoConfigured(coreApi)) {
    return res.status(503).json({ error: 'Zerto Analytics credentials are not configured (Zerto → Settings).' });
  }
  await refreshAll(coreApi);
  res.json({ refreshed: true, snapshot: latestSnapshot(coreApi) });
}

// ── AI Advisor ───────────────────────────────────────────────────────────────

let advisorInstance = null;
function getAdvisor(coreApi) {
  if (!advisorInstance) advisorInstance = createZertoAdvisor(coreApi);
  return advisorInstance;
}

function advisorReportKey(slug) {
  return String(slug).replace(/-/g, '_');
}

/** GET /advisor/:report — cached Zerto AI Advisor report. */
function handleGetAdvisorReport(req, res, coreApi) {
  if (!isNonEmptyString(req.params.report)) return badRequest(res, [fail('report')]);
  const zertoAdvisor = getAdvisor(coreApi);
  const key = advisorReportKey(req.params.report);
  if (!zertoAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
  res.json({ enabled: zertoAdvisor.isConfigured(), report: zertoAdvisor.getCachedReport(key) });
}

/** POST /advisor/:report — (re)generate and cache a Zerto AI Advisor report. */
async function handlePostAdvisorReport(req, res, coreApi) {
  if (!isNonEmptyString(req.params.report)) return badRequest(res, [fail('report')]);
  const zertoAdvisor = getAdvisor(coreApi);
  const key = advisorReportKey(req.params.report);
  if (!zertoAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
  try {
    const result = await zertoAdvisor.generateReport(key);
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
    throw err;
  }
}

// ── route table ──────────────────────────────────────────────────────────────

const ROUTES = [
  { method: 'GET', ...compile('/overview'), handler: handleGetOverview },
  { method: 'GET', ...compile('/sites'), handler: handleGetSites },
  { method: 'GET', ...compile('/vpgs'), handler: handleGetVpgs },
  { method: 'GET', ...compile('/alerts'), handler: handleGetAlerts },
  { method: 'GET', ...compile('/alert-types'), handler: handleGetAlertTypes },
  { method: 'PUT', ...compile('/alert-types/:code'), handler: handlePutAlertType },
  { method: 'GET', ...compile('/licenses'), handler: handleGetLicenses },
  { method: 'GET', ...compile('/vras'), handler: handleGetVras },
  { method: 'GET', ...compile('/replication'), handler: handleGetReplication },
  { method: 'GET', ...compile('/vms'), handler: handleGetVms },
  { method: 'GET', ...compile('/trends'), handler: handleGetTrends },
  { method: 'GET', ...compile('/account'), handler: handleGetAccount },
  { method: 'PUT', ...compile('/account'), handler: handlePutAccount },
  { method: 'POST', ...compile('/account/test'), handler: handlePostAccountTest },
  { method: 'POST', ...compile('/refresh'), handler: handlePostRefresh },
  { method: 'GET', ...compile('/advisor/:report'), handler: handleGetAdvisorReport },
  { method: 'POST', ...compile('/advisor/:report'), handler: handlePostAdvisorReport },
];

// createRouter must return a BARE (req, res, next) function — installed
// plugins are loaded via require() on their own dist/backend/index.cjs and
// cannot require the host's copy of express, so express Router instances are
// off the table. Matches req.method + req.path by hand against the table
// above; req.query/req.body are still parsed by the host's express pipeline
// before this middleware runs.
function createRouter(coreApi) {
  return function zertoRouter(req, res, next) {
    const path = req.path.length > 1 && req.path.endsWith('/') ? req.path.slice(0, -1) : req.path;
    for (const route of ROUTES) {
      if (route.method !== req.method) continue;
      const m = route.regex.exec(path);
      if (!m) continue;
      const params = {};
      route.names.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
      req.params = params;
      Promise.resolve(route.handler(req, res, coreApi)).catch(next);
      return;
    }
    next();
  };
}

module.exports = { createRouter };
