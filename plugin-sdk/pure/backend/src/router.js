// Pure Storage routes, ported from backend/routes/pure.js (direct-connect
// arrays, mounted at /api/pure) + backend/routes/pure1.js (Pure1 SaaS fleet,
// mounted STATICALLY at /api/pure1 in the built-in — see backend/app.js's
// comment "Known seam: pure1 stays mounted statically... folds into this
// manifest properly once its frontend paths move under /pure in a later WP").
//
// DEVIATION FROM THE BUILT-IN (unavoidable — see the mount seam above): the
// plugin dispatcher only ever serves `/api/<pluginId>/*` (backend/core/
// registry.js's dispatch, mounted at `/api/:pluginId` in app.js) — a plugin
// manifest gets exactly ONE router at exactly ONE mount point. There is no
// mechanism for a second static /api/pure1 mount for an installed plugin.
// Pure1's entire route table is therefore folded into THIS SAME bare router,
// with every path prefixed `/pure1` (e.g. the built-in's GET /api/pure1/status
// becomes GET /api/pure/pure1/status here). The frontend package must call
// apiFetch('/pure/pure1/...') instead of '/api/pure1/...'.
//
// DEVIATION: bundled plugins cannot require the host's express/
// express-validator — createRouter must return a BARE (req, res, next)
// function (dell/zerto plugin-sdk router.js pattern). This file hand-matches
// req.method/req.path against a route table (compile.js) and re-implements
// the validation express-validator did inline (validate.js), preserving the
// same status codes (400 invalid params, 404 missing, 409 duplicate, 502
// upstream/test-connection failure, 503/429 advisor errors) and JSON
// response shapes exactly. cacheControl(seconds) middleware (host-only) is
// dropped, matching the dell/zerto plugin conversions (neither ported it).
const api = require('./api');
const pure1Api = require('./pure1Api');
const { getPoller, getPure1Poller } = require('./poller');
const { createPureAdvisor } = require('./advisor');
const { compile } = require('./compile');
const {
  badRequest, fail, parseIntStrict, isNonEmptyString, isBooleanish, toBool,
  requireIdParam, parseQueryInt,
} = require('./validate');

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
    // Credential identifiers are never returned — presence only.
    has_client_id: !!row.client_id,
    has_key_id: !!row.key_id,
    has_username: !!row.username,
    issuer: row.issuer,
    polling_interval_minutes: row.polling_interval_minutes,
    ssl_verify: row.ssl_verify,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Method-specific credential checks (express-validator's chained .custom()
// checks re-implemented by hand). `requireSecret` is false on PUT (secrets
// may be left blank to keep the existing one).
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

function buildCredentials(coreApi, body) {
  if (body.auth_method === 'token') {
    return coreApi.encryption.encrypt(JSON.stringify({ apiToken: String(body.apiToken).trim() }));
  }
  return coreApi.encryption.encrypt(JSON.stringify({ privateKey: body.privateKey }));
}

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

const arrayFieldErrors = (b) => {
  const errors = [];
  if (!isNonEmptyString(b.name, 253)) errors.push(fail('name'));
  if (!isNonEmptyString(b.mgmt_host, 253) || isBlockedHost(b.mgmt_host)) errors.push(fail('mgmt_host'));
  if (b.auth_method !== undefined && !['client', 'token'].includes(b.auth_method)) errors.push(fail('auth_method'));
  if (b.polling_interval_minutes !== undefined) {
    const n = parseIntStrict(b.polling_interval_minutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) errors.push(fail('polling_interval_minutes'));
  }
  if (b.ssl_verify !== undefined && !isBooleanish(b.ssl_verify)) errors.push(fail('ssl_verify'));
  return errors;
};

/* ── Direct-array arrays CRUD ────────────────────────────────────────────── */

function handleGetArrays(req, res, coreApi) {
  res.json(coreApi.db.prepare('SELECT * FROM pure_arrays ORDER BY name ASC').all().map(publicArray));
}

function handleGetDefaults(req, res) {
  res.json({
    has_client_id: !!process.env.PURE_ARRAY_CLIENT_ID,
    has_key_id: !!process.env.PURE_ARRAY_KEY_ID,
    has_username: !!process.env.PURE_ARRAY_USER,
  });
}

async function handlePostArraysTest(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  if (!isNonEmptyString(b.mgmt_host) || isBlockedHost(b.mgmt_host)) errors.push(fail('mgmt_host'));
  if (b.auth_method !== undefined && !['client', 'token'].includes(b.auth_method)) errors.push(fail('auth_method'));
  if (b.ssl_verify !== undefined && !isBooleanish(b.ssl_verify)) errors.push(fail('ssl_verify'));
  if (errors.length) return badRequest(res, errors);
  const credErr = checkCredentials(b, { requireSecret: true });
  if (credErr) return res.status(400).json({ ok: false, error: credErr });
  try {
    const result = await api.testConnection({
      mgmt_host: b.mgmt_host,
      auth_method: b.auth_method === 'token' ? 'token' : 'client',
      client_id: b.client_id,
      key_id: b.key_id,
      username: b.username,
      issuer: b.issuer || null,
      ssl_verify: b.ssl_verify ? 1 : 0,
      privateKey: b.privateKey,
      apiToken: b.apiToken,
    }, coreApi);
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: describeApiError(err) });
  }
}

function handlePostArrays(req, res, coreApi) {
  const b = req.body || {};
  const errors = arrayFieldErrors(b);
  if (errors.length) return badRequest(res, errors);
  const credErr = checkCredentials(b, { requireSecret: true });
  if (credErr) return res.status(400).json({ error: credErr });
  try {
    const method = b.auth_method === 'token' ? 'token' : 'client';
    const encrypted = buildCredentials(coreApi, b);
    const db = coreApi.db;
    const info = db.prepare(`
      INSERT INTO pure_arrays
        (name, mgmt_host, auth_method, client_id, key_id, username, issuer,
         encrypted_credentials, polling_interval_minutes, ssl_verify)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      b.name, api.normalizeHost(b.mgmt_host), method, b.client_id || '', b.key_id || '', b.username || '',
      b.issuer || null, encrypted, b.polling_interval_minutes || 15, b.ssl_verify ? 1 : 0
    );
    const row = db.prepare('SELECT * FROM pure_arrays WHERE id = ?').get(info.lastInsertRowid);
    const poller = getPoller(coreApi);
    poller.schedule(row);
    poller.trigger(row).catch(() => {});
    res.status(201).json(publicArray(row));
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'An array with that name already exists' });
    }
    throw err;
  }
}

function handlePutArray(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const b = req.body || {};
  const errors = arrayFieldErrors(b);
  if (errors.length) return badRequest(res, errors);
  const credErr = checkCredentials(b, { requireSecret: false });
  if (credErr) return res.status(400).json({ error: credErr });
  try {
    const db = coreApi.db;
    const existing = db.prepare('SELECT * FROM pure_arrays WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Array not found' });

    const method = b.auth_method === 'token' ? 'token' : 'client';
    const hasNewSecret = method === 'token' ? !!b.apiToken : !!b.privateKey;
    const encrypted = hasNewSecret ? buildCredentials(coreApi, b) : existing.encrypted_credentials;

    db.prepare(`
      UPDATE pure_arrays SET
        name = ?, mgmt_host = ?, auth_method = ?, client_id = ?, key_id = ?, username = ?, issuer = ?,
        encrypted_credentials = ?, polling_interval_minutes = ?, ssl_verify = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      b.name, api.normalizeHost(b.mgmt_host), method, b.client_id || '', b.key_id || '', b.username || '',
      b.issuer || null, encrypted, b.polling_interval_minutes || existing.polling_interval_minutes,
      b.ssl_verify ? 1 : 0, id
    );

    const row = db.prepare('SELECT * FROM pure_arrays WHERE id = ?').get(id);
    api.invalidate(row.id);
    getPoller(coreApi).schedule(row);
    res.json(publicArray(row));
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'An array with that name already exists' });
    }
    throw err;
  }
}

function handleDeleteArray(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const info = coreApi.db.prepare('DELETE FROM pure_arrays WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Array not found' });
  getPoller(coreApi).cancel(id);
  api.invalidate(id);
  res.json({ success: true });
}

async function handlePostArrayPoll(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const array = coreApi.db.prepare('SELECT * FROM pure_arrays WHERE id = ?').get(id);
  if (!array) return res.status(404).json({ error: 'Array not found' });
  await getPoller(coreApi).trigger(array);
  res.json({ success: true });
}

/* ── Telemetry reads ─────────────────────────────────────────────────────── */

function handleGetOverview(req, res, coreApi) {
  const db = coreApi.db;
  const arrays = db.prepare('SELECT * FROM pure_arrays ORDER BY name ASC').all();
  const latestStmt = db.prepare('SELECT * FROM pure_metrics_history WHERE array_id = ? ORDER BY captured_at DESC LIMIT 1');
  const alertStmt = db.prepare("SELECT COUNT(*) AS n FROM pure_alerts WHERE array_id = ? AND (state IS NULL OR state = 'open')");
  const volStmt = db.prepare('SELECT COUNT(*) AS n FROM pure_volumes WHERE array_id = ?');
  const hostStmt = db.prepare('SELECT COUNT(*) AS n FROM pure_hosts WHERE array_id = ?');
  res.json(arrays.map((a) => ({
    ...publicArray(a),
    latest: latestStmt.get(a.id) || null,
    open_alerts: alertStmt.get(a.id).n,
    volume_count: volStmt.get(a.id).n,
    host_count: hostStmt.get(a.id).n,
  })));
}

function handleGetAlerts(req, res, coreApi) {
  res.json(coreApi.db.prepare(`
    SELECT pa.*, a.name AS array_name
    FROM pure_alerts pa
    JOIN pure_arrays a ON a.id = pa.array_id
    WHERE (pa.state IS NULL OR pa.state = 'open')
    ORDER BY CASE LOWER(pa.severity)
      WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 WHEN 'info' THEN 2 ELSE 3 END,
      pa.updated_at_ms DESC
  `).all());
}

function handleGetVolumes(req, res, coreApi) {
  res.json(coreApi.db.prepare(`
    SELECT pv.*, a.name AS array_name
    FROM pure_volumes pv
    JOIN pure_arrays a ON a.id = pv.array_id
    WHERE pv.destroyed = 0 OR pv.destroyed IS NULL
    ORDER BY pv.provisioned_bytes DESC
  `).all());
}

function handleGetArrayMetricsLatest(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  res.json(coreApi.db.prepare('SELECT * FROM pure_metrics_history WHERE array_id = ? ORDER BY captured_at DESC LIMIT 1').get(id) || null);
}

function handleGetArrayMetricsHistory(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const daysQ = parseQueryInt(req.query.days, 1, 90);
  if (!daysQ.ok) return badRequest(res, [fail('days')]);
  const days = daysQ.value === undefined ? 7 : daysQ.value;
  res.json(coreApi.db.prepare(`
    SELECT * FROM pure_metrics_history WHERE array_id = ? AND captured_at >= datetime('now', ?) ORDER BY captured_at ASC
  `).all(id, `-${days} days`));
}

function handleGetArrayAlerts(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  res.json(coreApi.db.prepare(`
    SELECT * FROM pure_alerts WHERE array_id = ?
    ORDER BY CASE LOWER(severity)
      WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 WHEN 'info' THEN 2 ELSE 3 END,
      updated_at_ms DESC
  `).all(id));
}

function handleGetArrayVolumes(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  res.json(coreApi.db.prepare('SELECT * FROM pure_volumes WHERE array_id = ? ORDER BY provisioned_bytes DESC').all(id));
}

function handleGetArrayHosts(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  res.json(coreApi.db.prepare('SELECT * FROM pure_hosts WHERE array_id = ? ORDER BY name ASC').all(id));
}

/* ── Volume analytics ────────────────────────────────────────────────────── */

function handleGetVolumesPerformance(req, res, coreApi) {
  res.json(coreApi.db.prepare(`
    SELECT h.*, a.name AS array_name
    FROM pure_volume_history h
    JOIN pure_arrays a ON a.id = h.array_id
    JOIN (SELECT array_id, volume_name, MAX(captured_at) AS mx FROM pure_volume_history GROUP BY array_id, volume_name) latest
      ON latest.array_id = h.array_id AND latest.volume_name = h.volume_name AND latest.mx = h.captured_at
    ORDER BY h.used_bytes DESC
  `).all());
}

function handleGetArrayVolumesGrowth(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const daysQ = parseQueryInt(req.query.days, 1, 90);
  if (!daysQ.ok) return badRequest(res, [fail('days')]);
  const days = daysQ.value === undefined ? 30 : daysQ.value;
  res.json(coreApi.db.prepare(`
    WITH win AS (
      SELECT * FROM pure_volume_history WHERE array_id = ? AND captured_at >= datetime('now', ?)
    ),
    bounds AS (
      SELECT volume_name, MIN(captured_at) AS first_at, MAX(captured_at) AS last_at FROM win GROUP BY volume_name
    )
    SELECT b.volume_name,
           f.used_bytes AS first_used, l.used_bytes AS last_used,
           (l.used_bytes - f.used_bytes) AS growth_bytes,
           l.provisioned_bytes, l.data_reduction, b.first_at, b.last_at
    FROM bounds b
    JOIN win f ON f.volume_name = b.volume_name AND f.captured_at = b.first_at
    JOIN win l ON l.volume_name = b.volume_name AND l.captured_at = b.last_at
    ORDER BY growth_bytes DESC
  `).all(id, `-${days} days`));
}

/* ── Replication & data protection ───────────────────────────────────────── */

function handleGetReplication(req, res, coreApi) {
  res.json(coreApi.db.prepare(`
    SELECT c.*, a.name AS array_name
    FROM pure_array_connections c JOIN pure_arrays a ON a.id = c.array_id
    ORDER BY a.name, c.remote_name
  `).all());
}

function handleGetProtectionGroups(req, res, coreApi) {
  res.json(coreApi.db.prepare(`
    SELECT g.*, a.name AS array_name
    FROM pure_protection_groups g JOIN pure_arrays a ON a.id = g.array_id
    ORDER BY a.name, g.name
  `).all());
}

/* ── Hardware inventory & compliance ─────────────────────────────────────── */

function handleGetArrayHardware(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  res.json({
    hardware: db.prepare('SELECT * FROM pure_hardware WHERE array_id = ? ORDER BY name').all(id),
    drives: db.prepare('SELECT * FROM pure_drives WHERE array_id = ? ORDER BY name').all(id),
    controllers: db.prepare('SELECT * FROM pure_controllers WHERE array_id = ? ORDER BY name').all(id),
  });
}

function handleGetCompliance(req, res, coreApi) {
  const db = coreApi.db;
  const arrays = db.prepare('SELECT id, name FROM pure_arrays ORDER BY name').all();
  const certStmt = db.prepare('SELECT * FROM pure_certificates WHERE array_id = ? ORDER BY name');
  const ctrlStmt = db.prepare('SELECT DISTINCT version FROM pure_controllers WHERE array_id = ? AND version IS NOT NULL');
  res.json(arrays.map((a) => ({
    id: a.id, name: a.name,
    certificates: certStmt.all(a.id),
    versions: ctrlStmt.all(a.id).map((r) => r.version),
  })));
}

/* ── Connectivity & DR topology ──────────────────────────────────────────── */

function handleGetArrayNetwork(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  res.json({
    interfaces: db.prepare('SELECT * FROM pure_network_interfaces WHERE array_id = ? ORDER BY name').all(id),
    ports: db.prepare('SELECT * FROM pure_ports WHERE array_id = ? ORDER BY name').all(id),
  });
}

function handleGetArrayConnections(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  res.json(coreApi.db.prepare('SELECT * FROM pure_connections WHERE array_id = ? ORDER BY host_name, volume_name').all(id));
}

function handleGetPods(req, res, coreApi) {
  res.json(coreApi.db.prepare(`
    SELECT p.*, a.name AS array_name FROM pure_pods p JOIN pure_arrays a ON a.id = p.array_id ORDER BY a.name, p.name
  `).all());
}

/* ── AI Advisor ───────────────────────────────────────────────────────────── */

let advisorInstance = null;
function getAdvisor(coreApi) {
  if (!advisorInstance) advisorInstance = createPureAdvisor(coreApi);
  return advisorInstance;
}

function advisorReportKey(slug) {
  return String(slug).replace(/-/g, '_');
}

function handleGetAdvisorReport(req, res, coreApi) {
  if (!isNonEmptyString(req.params.report)) return badRequest(res, [fail('report')]);
  const pureAdvisor = getAdvisor(coreApi);
  const key = advisorReportKey(req.params.report);
  if (!pureAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
  res.json({ enabled: pureAdvisor.isConfigured(), report: pureAdvisor.getCachedReport(key) });
}

async function handlePostAdvisorReport(req, res, coreApi) {
  if (!isNonEmptyString(req.params.report)) return badRequest(res, [fail('report')]);
  const pureAdvisor = getAdvisor(coreApi);
  const key = advisorReportKey(req.params.report);
  if (!pureAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
  try {
    const result = await pureAdvisor.generateReport(key);
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

// ═══════════════════════════════════════════════════════════════════════════
// Pure1 SaaS routes (ported from backend/routes/pure1.js) — mounted here
// under /pure1/* (see module header deviation note).
// ═══════════════════════════════════════════════════════════════════════════

function isDemo() {
  return process.env.DASHBOARD_DEMO === '1';
}

function toEpoch(capturedAt) {
  if (!capturedAt) return null;
  const ms = new Date(capturedAt.endsWith('Z') ? capturedAt : `${capturedAt}Z`).getTime();
  return Number.isNaN(ms) ? null : ms;
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
  return { id: row.pure1_pod_id, name: row.name, mediator: row.mediator, arrays: row.arrays ? JSON.parse(row.arrays) : [] };
}

const dbOverview = (db) => db.prepare('SELECT * FROM pure1_arrays').all().map(rowToOverview).sort((a, b) => a.name.localeCompare(b.name));
const dbAlerts = (db) => db.prepare('SELECT * FROM pure1_alerts').all().map(rowToAlert);
function dbEnrichment(db) {
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
const dbPods = (db) => db.prepare('SELECT * FROM pure1_pods').all().map(rowToPod).sort((a, b) => a.name.localeCompare(b.name));

function handleGetPure1Status(req, res, coreApi) {
  const db = coreApi.db;
  const lastRow = db.prepare('SELECT MAX(captured_at) AS captured_at FROM pure1_metrics_history').get();
  const lastDataCapture = lastRow && lastRow.captured_at ? `${lastRow.captured_at}Z` : null;
  res.json({
    configured: pure1Api.isConfigured(coreApi),
    lastRefresh: pure1Api.lastRefresh(),
    lastDataCapture,
    pollIntervalMinutes: Number(coreApi.settings.getSetting('pure1_poll_interval_minutes')) || 15,
    ...pure1Api.getDisplayPrefs(coreApi),
  });
}

function handleGetPure1Settings(req, res, coreApi) {
  res.json(pure1Api.getConfig(coreApi));
}

function handlePutPure1Settings(req, res, coreApi) {
  try {
    const result = pure1Api.setConfig(coreApi, req.body || {});
    getPure1Poller(coreApi).schedule({ id: 0, name: 'account' });
    res.json(result);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    throw err;
  }
}

async function handlePostPure1Test(req, res, coreApi) {
  try {
    if (!pure1Api.isConfigured(coreApi)) return res.status(400).json({ error: 'Pure is not configured' });
    res.json(await pure1Api.testConnection(coreApi));
  } catch (err) {
    const status = (err.response && err.response.status) || 502;
    const detail = (err.response && err.response.data && (err.response.data.error_description || JSON.stringify(err.response.data))) || err.message;
    res.status(200).json({ ok: false, error: `${status}: ${detail}` });
  }
}

async function handleGetPure1Overview(req, res, coreApi) {
  if (isDemo()) return res.json(await pure1Api.getOverview(coreApi, { force: req.query.refresh === '1' }));
  if (!pure1Api.isConfigured(coreApi)) return res.json([]);
  if (req.query.refresh === '1') await getPure1Poller(coreApi).trigger({ id: 0, name: 'account' });
  res.json(dbOverview(coreApi.db));
}

async function handleGetPure1Alerts(req, res, coreApi) {
  if (isDemo()) return res.json(await pure1Api.getAlerts(coreApi, { force: req.query.refresh === '1' }));
  if (!pure1Api.isConfigured(coreApi)) return res.json([]);
  if (req.query.refresh === '1') await getPure1Poller(coreApi).trigger({ id: 0, name: 'account' });
  res.json(dbAlerts(coreApi.db));
}

async function handleGetPure1Enrichment(req, res, coreApi) {
  if (isDemo()) return res.json(await pure1Api.getEnrichment(coreApi, { force: req.query.refresh === '1' }));
  if (!pure1Api.isConfigured(coreApi)) return res.json({});
  res.json(dbEnrichment(coreApi.db));
}

function requireArrayId(req, res) {
  const id = String(req.query.arrayId || '').trim();
  if (!id) { res.status(400).json({ error: 'arrayId query param is required' }); return null; }
  return id;
}

async function handleGetPure1Volumes(req, res, coreApi) {
  if (!pure1Api.isConfigured(coreApi)) return res.json([]);
  const id = requireArrayId(req, res); if (!id) return undefined;
  res.json(await pure1Api.fetchVolumes(coreApi, id));
}

async function handleGetPure1Pods(req, res, coreApi) {
  if (isDemo()) return res.json(await pure1Api.fetchPods(coreApi));
  if (!pure1Api.isConfigured(coreApi)) return res.json([]);
  res.json(dbPods(coreApi.db));
}

async function handleGetPure1Hardware(req, res, coreApi) {
  if (!pure1Api.isConfigured(coreApi)) return res.json({ controllers: [], components: [], drives: [] });
  const id = requireArrayId(req, res); if (!id) return undefined;
  res.json(await pure1Api.fetchHardware(coreApi, id));
}

async function handleGetPure1Connectivity(req, res, coreApi) {
  if (!pure1Api.isConfigured(coreApi)) return res.json({ interfaces: [], ports: [] });
  const id = requireArrayId(req, res); if (!id) return undefined;
  res.json(await pure1Api.fetchConnectivity(coreApi, id));
}

async function handleGetPure1CapacityHistory(req, res, coreApi) {
  if (!pure1Api.isConfigured(coreApi)) return res.json({ series: {} });
  const id = requireArrayId(req, res); if (!id) return undefined;
  const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
  res.json(await pure1Api.fetchCapacityHistory(coreApi, id, days));
}

async function handleGetPure1PerformanceHistory(req, res, coreApi) {
  if (!pure1Api.isConfigured(coreApi)) return res.json({ series: {} });
  const id = requireArrayId(req, res); if (!id) return undefined;
  const days = Math.min(30, Math.max(1, Number(req.query.days) || 1));
  res.json(await pure1Api.fetchPerformanceHistory(coreApi, id, days));
}

// ── route table ──────────────────────────────────────────────────────────────

const ROUTES = [
  // Direct-connect arrays (backend/routes/pure.js, paths as mounted at /api/pure)
  { method: 'GET', ...compile('/arrays'), handler: handleGetArrays },
  { method: 'GET', ...compile('/defaults'), handler: handleGetDefaults },
  { method: 'POST', ...compile('/arrays/test'), handler: handlePostArraysTest },
  { method: 'POST', ...compile('/arrays'), handler: handlePostArrays },
  { method: 'PUT', ...compile('/arrays/:id'), handler: handlePutArray },
  { method: 'DELETE', ...compile('/arrays/:id'), handler: handleDeleteArray },
  { method: 'POST', ...compile('/arrays/:id/poll'), handler: handlePostArrayPoll },
  { method: 'GET', ...compile('/overview'), handler: handleGetOverview },
  { method: 'GET', ...compile('/alerts'), handler: handleGetAlerts },
  { method: 'GET', ...compile('/volumes'), handler: handleGetVolumes },
  { method: 'GET', ...compile('/arrays/:id/metrics/latest'), handler: handleGetArrayMetricsLatest },
  { method: 'GET', ...compile('/arrays/:id/metrics/history'), handler: handleGetArrayMetricsHistory },
  { method: 'GET', ...compile('/arrays/:id/alerts'), handler: handleGetArrayAlerts },
  { method: 'GET', ...compile('/arrays/:id/volumes'), handler: handleGetArrayVolumes },
  { method: 'GET', ...compile('/arrays/:id/hosts'), handler: handleGetArrayHosts },
  { method: 'GET', ...compile('/volumes/performance'), handler: handleGetVolumesPerformance },
  { method: 'GET', ...compile('/arrays/:id/volumes/growth'), handler: handleGetArrayVolumesGrowth },
  { method: 'GET', ...compile('/replication'), handler: handleGetReplication },
  { method: 'GET', ...compile('/protection-groups'), handler: handleGetProtectionGroups },
  { method: 'GET', ...compile('/arrays/:id/hardware'), handler: handleGetArrayHardware },
  { method: 'GET', ...compile('/compliance'), handler: handleGetCompliance },
  { method: 'GET', ...compile('/arrays/:id/network'), handler: handleGetArrayNetwork },
  { method: 'GET', ...compile('/arrays/:id/connections'), handler: handleGetArrayConnections },
  { method: 'GET', ...compile('/pods'), handler: handleGetPods },
  { method: 'GET', ...compile('/advisor/:report'), handler: handleGetAdvisorReport },
  { method: 'POST', ...compile('/advisor/:report'), handler: handlePostAdvisorReport },

  // Pure1 SaaS (backend/routes/pure1.js) — mounted under /pure1/* here (see
  // module header deviation note); path suffix matches the built-in exactly.
  { method: 'GET', ...compile('/pure1/status'), handler: handleGetPure1Status },
  { method: 'GET', ...compile('/pure1/settings'), handler: handleGetPure1Settings },
  { method: 'PUT', ...compile('/pure1/settings'), handler: handlePutPure1Settings },
  { method: 'POST', ...compile('/pure1/test'), handler: handlePostPure1Test },
  { method: 'GET', ...compile('/pure1/overview'), handler: handleGetPure1Overview },
  { method: 'GET', ...compile('/pure1/alerts'), handler: handleGetPure1Alerts },
  { method: 'GET', ...compile('/pure1/enrichment'), handler: handleGetPure1Enrichment },
  { method: 'GET', ...compile('/pure1/volumes'), handler: handleGetPure1Volumes },
  { method: 'GET', ...compile('/pure1/pods'), handler: handleGetPure1Pods },
  { method: 'GET', ...compile('/pure1/hardware'), handler: handleGetPure1Hardware },
  { method: 'GET', ...compile('/pure1/connectivity'), handler: handleGetPure1Connectivity },
  { method: 'GET', ...compile('/pure1/capacity/history'), handler: handleGetPure1CapacityHistory },
  { method: 'GET', ...compile('/pure1/performance/history'), handler: handleGetPure1PerformanceHistory },
];

// createRouter must return a BARE (req, res, next) function — installed
// plugins are loaded via require() on their own dist/backend/index.cjs and
// cannot require the host's copy of express, so express Router instances are
// off the table (dell/zerto plugin-sdk router.js pattern).
function createRouter(coreApi) {
  return function pureRouter(req, res, next) {
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
