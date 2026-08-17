// Aria Operations routes, ported from backend/routes/ariaops.js. Mounted by
// the host dispatcher at /api/ariaops — paths below are relative.
//
// DEVIATION FROM THE BUILT-IN: bundled plugins cannot require the host's
// express/express-validator — createRouter must return a BARE (req, res,
// next) function (plugin-sdk/dell/backend/src/router.js pattern). This file
// hand-matches req.method/req.path against a route table (compile.js) and
// re-implements the validation express-validator did inline (validate.js),
// preserving the same status codes (400 invalid params, 404 missing, 409
// duplicate, 502 upstream/test-connection failure) and JSON response shapes
// exactly.
const api = require('./api');
const { getPoller } = require('./poller');
const { compile } = require('./compile');
const {
  badRequest, fail, parseIntStrict, isNonEmptyString, isBooleanish, toBool,
  requireIdParam, parseQueryInt,
} = require('./validate');

const publicInstance = (row) => ({
  id: row.id, name: row.name, host: row.host, username: row.username, authSource: row.auth_source,
  sslVerify: !!row.ssl_verify, pollingIntervalMinutes: row.polling_interval_minutes,
  version: row.version,
  lastPollStatus: row.last_poll_status, lastPollError: row.last_poll_error, lastPollAt: row.last_poll_at,
});

// ── Instances CRUD ───────────────────────────────────────────────────────────

/** GET /instances — registered instances (never the credentials). */
function handleGetInstances(req, res, coreApi) {
  res.json(coreApi.db.prepare('SELECT * FROM ariaops_instances ORDER BY name').all().map(publicInstance));
}

/** POST /instances — register an Aria Operations instance. */
function handlePostInstances(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  if (!isNonEmptyString(b.name, 120)) errors.push(fail('name'));
  if (!isNonEmptyString(b.host, 253)) errors.push(fail('host'));
  if (!isNonEmptyString(b.username, 256)) errors.push(fail('username'));
  if (!isNonEmptyString(b.password, 512)) errors.push(fail('password'));
  if (b.authSource !== undefined && !(typeof b.authSource === 'string' && b.authSource.length <= 256)) errors.push(fail('authSource'));
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (b.pollingIntervalMinutes !== undefined) {
    const n = parseIntStrict(b.pollingIntervalMinutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) errors.push(fail('pollingIntervalMinutes'));
  }
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  const name = b.name.trim();
  const host = b.host.trim();
  const dup = db.prepare('SELECT id FROM ariaops_instances WHERE name = ? OR host = ?').get(name, host);
  if (dup) return res.status(409).json({ error: 'An Aria Operations instance with that name or host is already registered.' });
  const info = db.prepare(`
    INSERT INTO ariaops_instances (name, host, username, auth_source, encrypted_credentials, ssl_verify, polling_interval_minutes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, host, b.username.trim(), b.authSource?.trim() || null,
    coreApi.encryption.encrypt(JSON.stringify({ password: b.password })),
    toBool(b.sslVerify) ? 1 : 0, b.pollingIntervalMinutes ? parseIntStrict(b.pollingIntervalMinutes) : 15);
  const row = db.prepare('SELECT * FROM ariaops_instances WHERE id = ?').get(info.lastInsertRowid);
  const poller = getPoller(coreApi);
  poller.schedule(row);
  poller.trigger(row).catch(() => {});
  res.status(201).json(publicInstance(row));
}

/** PUT /instances/:id — update (password optional; blank keeps stored). */
function handlePutInstance(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const b = req.body || {};
  const errors = [];
  if (b.name !== undefined && !isNonEmptyString(b.name, 120)) errors.push(fail('name'));
  if (b.host !== undefined && !isNonEmptyString(b.host, 253)) errors.push(fail('host'));
  if (b.username !== undefined && !isNonEmptyString(b.username, 256)) errors.push(fail('username'));
  if (b.password !== undefined && b.password !== '' && !(typeof b.password === 'string' && b.password.length <= 512)) errors.push(fail('password'));
  if (b.authSource !== undefined && b.authSource !== null && !(typeof b.authSource === 'string' && b.authSource.length <= 256)) errors.push(fail('authSource'));
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (b.pollingIntervalMinutes !== undefined) {
    const n = parseIntStrict(b.pollingIntervalMinutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) errors.push(fail('pollingIntervalMinutes'));
  }
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM ariaops_instances WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Aria Operations instance not found.' });
  db.prepare(`
    UPDATE ariaops_instances SET
      name = ?, host = ?, username = ?, auth_source = ?, encrypted_credentials = ?,
      ssl_verify = ?, polling_interval_minutes = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    b.name?.trim() || row.name, b.host?.trim() || row.host, b.username?.trim() || row.username,
    b.authSource !== undefined ? (b.authSource?.trim() || null) : row.auth_source,
    b.password ? coreApi.encryption.encrypt(JSON.stringify({ password: b.password })) : row.encrypted_credentials,
    b.sslVerify !== undefined ? (toBool(b.sslVerify) ? 1 : 0) : row.ssl_verify,
    b.pollingIntervalMinutes ? parseIntStrict(b.pollingIntervalMinutes) : row.polling_interval_minutes,
    row.id
  );
  api.invalidateSession(row.id);
  const updated = db.prepare('SELECT * FROM ariaops_instances WHERE id = ?').get(row.id);
  getPoller(coreApi).schedule(updated);
  res.json(publicInstance(updated));
}

/** DELETE /instances/:id — unregister (CASCADE clears inventory). */
function handleDeleteInstance(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM ariaops_instances WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Aria Operations instance not found.' });
  getPoller(coreApi).cancel(row.id);
  api.invalidateSession(row.id);
  db.prepare('DELETE FROM ariaops_instances WHERE id = ?').run(row.id);
  res.json({ deleted: true });
}

/** POST /instances/test — validate saved or candidate credentials. */
async function handlePostInstancesTest(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  if (!isNonEmptyString(b.host)) errors.push(fail('host'));
  if (!isNonEmptyString(b.username)) errors.push(fail('username'));
  if (b.password !== undefined && typeof b.password !== 'string') errors.push(fail('password'));
  if (b.authSource !== undefined && b.authSource !== null && typeof b.authSource !== 'string') errors.push(fail('authSource'));
  if (b.id !== undefined && !Number.isInteger(parseIntStrict(b.id))) errors.push(fail('id'));
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (errors.length) return badRequest(res, errors);

  const { id, host, username, password, authSource, sslVerify } = b;
  let candidate = { host: host.trim(), username: username.trim(), password, auth_source: authSource, ssl_verify: toBool(sslVerify) ? 1 : 0 };
  if (!password && id) {
    const row = coreApi.db.prepare('SELECT * FROM ariaops_instances WHERE id = ?').get(parseIntStrict(id));
    if (row) candidate = { ...row, host: candidate.host, username: candidate.username, auth_source: candidate.auth_source ?? row.auth_source, ssl_verify: candidate.ssl_verify };
  }
  const result = await api.testConnection(candidate, coreApi);
  res.status(result.ok ? 200 : 502).json(result);
}

/** POST /instances/:id/refresh — poll this instance now. */
async function handlePostInstanceRefresh(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM ariaops_instances WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Aria Operations instance not found.' });
  await getPoller(coreApi).trigger(row);
  res.json(publicInstance(db.prepare('SELECT * FROM ariaops_instances WHERE id = ?').get(row.id)));
}

// Each probe section runs the same fetcher the poller uses, live against the
// instance, and reports the RAW first item untransformed — this is the only
// place in the codebase that is meant to show an unmassaged upstream shape.
const PROBE_SECTIONS = [
  ['version', (row, coreApi) => api.fetchVersion(row, coreApi)],
  ['nodeStatus', (row, coreApi) => api.fetchNodeStatus(row, coreApi)],
  ['resources', (row, coreApi) => api.fetchResourcesByKind(row, coreApi, 'VirtualMachine')],
  ['alerts', (row, coreApi) => api.fetchAlerts(row, coreApi)],
  ['latestStats', async (row, coreApi) => {
    const vms = await api.fetchResourcesByKind(row, coreApi, 'VirtualMachine');
    const ids = vms.slice(0, 5).map((r) => r?.identifier).filter(Boolean);
    if (!ids.length) return [];
    const stats = await api.fetchLatestStats(row, coreApi, ids);
    return [...stats.entries()].map(([resourceId, s]) => ({ resourceId, ...s }));
  }],
];

/** GET /instances/:id/probe — raw-shape probe, read-only. */
async function handleGetInstanceProbe(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const row = coreApi.db.prepare('SELECT * FROM ariaops_instances WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Aria Operations instance not found.' });
  const sections = {};
  for (const [name, fn] of PROBE_SECTIONS) {
    try {
      const items = await fn(row, coreApi);
      sections[name] = { ok: true, count: Array.isArray(items) ? items.length : undefined, firstItem: Array.isArray(items) ? (items[0] ?? null) : items };
    } catch (err) {
      sections[name] = { ok: false, error: err.response?.data?.message || err.message };
    }
  }
  res.json({ sections });
}

// ── Data endpoints ───────────────────────────────────────────────────────────

/** GET /overview — per-instance rollup + totals. */
function handleGetOverview(req, res, coreApi) {
  const db = coreApi.db;
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
}

/** GET /resources?instanceId=&kind= */
function handleGetResources(req, res, coreApi) {
  const instanceQ = parseQueryInt(req.query.instanceId);
  if (!instanceQ.ok) return badRequest(res, [fail('instanceId')]);
  const VALID_KINDS = new Set(['VirtualMachine', 'HostSystem', 'Datastore']);
  if (req.query.kind !== undefined && !VALID_KINDS.has(req.query.kind)) return badRequest(res, [fail('kind')]);
  const clauses = [];
  const params = [];
  if (instanceQ.value !== undefined) { clauses.push('r.instance_id = ?'); params.push(instanceQ.value); }
  if (req.query.kind) { clauses.push('r.kind = ?'); params.push(req.query.kind); }
  res.json(coreApi.db.prepare(`
    SELECT r.*, i.name AS instance_name FROM ariaops_resources r
    JOIN ariaops_instances i ON i.id = r.instance_id
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY i.name, r.kind, r.name
  `).all(...params));
}

/** GET /alerts?instanceId= */
function handleGetAlerts(req, res, coreApi) {
  const instanceQ = parseQueryInt(req.query.instanceId);
  if (!instanceQ.ok) return badRequest(res, [fail('instanceId')]);
  const clauses = [];
  const params = [];
  if (instanceQ.value !== undefined) { clauses.push('a.instance_id = ?'); params.push(instanceQ.value); }
  res.json(coreApi.db.prepare(`
    SELECT a.*, i.name AS instance_name FROM ariaops_alerts a
    JOIN ariaops_instances i ON i.id = a.instance_id
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY a.started_at_ms DESC
  `).all(...params));
}

/** GET /metrics-history?instanceId=&hours=168 */
function handleGetMetricsHistory(req, res, coreApi) {
  const instanceQ = parseQueryInt(req.query.instanceId);
  if (!instanceQ.ok) return badRequest(res, [fail('instanceId')]);
  const hoursQ = parseQueryInt(req.query.hours, 1, 8760);
  if (!hoursQ.ok) return badRequest(res, [fail('hours')]);
  const hours = hoursQ.value === undefined ? 168 : hoursQ.value;
  const clauses = [`m.captured_at >= datetime('now', '-${hours} hours')`];
  const params = [];
  if (instanceQ.value !== undefined) { clauses.push('m.instance_id = ?'); params.push(instanceQ.value); }
  res.json(coreApi.db.prepare(`
    SELECT m.*, i.name AS instance_name FROM ariaops_metrics_history m
    JOIN ariaops_instances i ON i.id = m.instance_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY m.captured_at
  `).all(...params));
}

// ── route table ──────────────────────────────────────────────────────────────

const ROUTES = [
  { method: 'GET', ...compile('/instances'), handler: handleGetInstances },
  { method: 'POST', ...compile('/instances'), handler: handlePostInstances },
  { method: 'PUT', ...compile('/instances/:id'), handler: handlePutInstance },
  { method: 'DELETE', ...compile('/instances/:id'), handler: handleDeleteInstance },
  { method: 'POST', ...compile('/instances/test'), handler: handlePostInstancesTest },
  { method: 'POST', ...compile('/instances/:id/refresh'), handler: handlePostInstanceRefresh },
  { method: 'GET', ...compile('/instances/:id/probe'), handler: handleGetInstanceProbe },
  { method: 'GET', ...compile('/overview'), handler: handleGetOverview },
  { method: 'GET', ...compile('/resources'), handler: handleGetResources },
  { method: 'GET', ...compile('/alerts'), handler: handleGetAlerts },
  { method: 'GET', ...compile('/metrics-history'), handler: handleGetMetricsHistory },
];

// createRouter must return a BARE (req, res, next) function — installed
// plugins are loaded via require() on their own dist/backend/index.cjs and
// cannot require the host's copy of express, so express Router instances are
// off the table. Matches req.method + req.path by hand against the table
// above; req.query/req.body are still parsed by the host's express pipeline
// before this middleware runs.
function createRouter(coreApi) {
  return function ariaopsRouter(req, res, next) {
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
