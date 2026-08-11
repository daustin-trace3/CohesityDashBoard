// NetBackup routes, ported from backend/routes/netbackup.js. Mounted by the
// plugin dispatcher at /api/netbackup — paths below are relative. Two source
// types share one CRUD surface: a `primary` server (password or apikey auth)
// or an `alta` SaaS tenant (apikey only, host = full base URL). publicSource()
// never returns encrypted_credentials.
//
// DEVIATION FROM THE BUILT-IN: bundled plugins cannot require the host's
// express/express-validator (contract C4/README "Router note") — createRouter
// must return a BARE (req, res, next) function. This file hand-matches
// req.method/req.path against a small route table (plugin-sdk/proxmox's
// routes.js pattern) and re-implements the validation express-validator did
// inline, preserving the same status codes (400 invalid params, 404 missing,
// 409 duplicate, 502 upstream) and JSON response shapes exactly.
const netbackupApi = require('./netbackupApi');
const netbackupApplianceApi = require('./netbackupApplianceApi');
const { getSourcePoller, getAppliancePoller } = require('./poller');
const {
  successWarnPct, storageWarnPct, staleBackupHours, computeIssues,
} = require('./issues');
const netbackupAdvisor = require('./advisor');

const REPLICATION_TYPES = ['REPLICATION', 'REPLICA', 'DUPLICATE', 'DUPLICATION', 'IMPORT'];
const isDemo = () => process.env.DASHBOARD_DEMO === '1';

// ── hand-rolled validation helpers (plugin-sdk/proxmox/backend/src/routes.js pattern) ──

function badRequest(res, details) {
  res.status(400).json({ error: 'Invalid parameters', details });
}

function fail(path, msg = 'Invalid value') {
  return { msg, path };
}

const INT_RE = /^-?\d+$/;

function parseIntStrict(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v !== 'string' || !INT_RE.test(v.trim())) return NaN;
  return parseInt(v, 10);
}

function isNonEmptyString(v, maxLen) {
  return typeof v === 'string' && v.trim().length > 0 && (maxLen == null || v.length <= maxLen);
}

function isOptionalString(v, maxLen) {
  return v === undefined || v === null || (typeof v === 'string' && (maxLen == null || v.length <= maxLen));
}

function isBooleanish(v) {
  return typeof v === 'boolean' || v === 'true' || v === 'false' || v === 0 || v === 1 || v === '0' || v === '1';
}

function toBool(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

function isInEnum(v, allowed) {
  return v === undefined || allowed.includes(v);
}

function requireIdParam(req, res) {
  const id = parseIntStrict(req.params.id);
  if (!Number.isInteger(id)) {
    badRequest(res, [fail('id')]);
    return null;
  }
  return id;
}

function parseQueryInt(v, min, max) {
  if (v === undefined) return { ok: true, value: undefined };
  const n = parseIntStrict(v);
  if (!Number.isInteger(n) || (min != null && n < min) || (max != null && n > max)) {
    return { ok: false };
  }
  return { ok: true, value: n };
}

// ── response shaping (unchanged from the built-in) ──────────────────────────

const publicSource = (row) => ({
  id: row.id, name: row.name, sourceType: row.source_type, host: row.host, port: row.port,
  authMode: row.auth_mode, username: row.username, domainName: row.domain_name, domainType: row.domain_type,
  sslVerify: !!row.ssl_verify, pollingIntervalMinutes: row.polling_interval_minutes,
  lastPollStatus: row.last_poll_status, lastPollError: row.last_poll_error, lastPollAt: row.last_poll_at,
});

const isFailedJob = (j) => j.state === 'FAILED'
  || (['EXITED', 'DONE'].includes(j.state) && Number(j.status_code || 0) > 0);

function mapJobRow(j) {
  return {
    id: j.id, sourceId: j.source_id, sourceName: j.source_name, jobId: j.job_id, jobType: j.job_type,
    state: j.state, statusCode: j.status_code, policyName: j.policy_name, policyType: j.policy_type,
    clientName: j.client_name, scheduleType: j.schedule_type, storageUnit: j.storage_unit,
    kilobytes: j.kilobytes, filesCount: j.files_count, elapsedSeconds: j.elapsed_seconds,
    startedAt: j.started_at, endedAt: j.ended_at,
  };
}

const publicConn = (row) => ({
  id: row.id, name: row.name, host: row.host, port: row.port, username: row.username,
  sslVerify: !!row.ssl_verify, pollingIntervalMinutes: row.polling_interval_minutes,
  lastPollStatus: row.last_poll_status, lastPollError: row.last_poll_error, lastPollAt: row.last_poll_at,
});

/** Normalizes reported models like "NB5250" / "NB-5250" -> "NetBackup 5250". */
function normalizeModel(reported) {
  if (!reported) return null;
  const m = /^NB\s?-?(\d{4})$/i.exec(String(reported).trim());
  return m ? `NetBackup ${m[1]}` : reported;
}

function mapApplianceRow(a) {
  const override = a.model_override ?? null;
  return {
    id: a.id, sourceId: a.source_id, sourceName: a.source_name, name: a.name,
    hostType: a.host_type, applianceType: a.appliance_type,
    modelRaw: a.model,
    model: override || normalizeModel(a.model),
    modelSource: override ? 'override' : (a.model ? 'reported' : null),
    serialNumber: a.serial_number, osType: a.os_type, osVersion: a.os_version,
    cpuArchitecture: a.cpu_architecture, nbuVersion: a.nbu_version,
  };
}

// ── Sources CRUD ─────────────────────────────────────────────────────────────

/** GET /sources — registered sources (never the credentials). */
function handleGetSources(req, res, coreApi) {
  const db = coreApi.db;
  const rows = db.prepare('SELECT * FROM netbackup_sources ORDER BY name').all();
  const applianceCounts = new Map(
    db.prepare('SELECT source_id, COUNT(*) AS n FROM netbackup_appliances GROUP BY source_id').all()
      .map((r) => [r.source_id, r.n])
  );
  const jobCounts = new Map(
    db.prepare("SELECT source_id, COUNT(*) AS n FROM netbackup_jobs WHERE started_at >= datetime('now', '-1 day') GROUP BY source_id").all()
      .map((r) => [r.source_id, r.n])
  );
  res.json({
    sources: rows.map((r) => ({
      ...publicSource(r),
      applianceCount: applianceCounts.get(r.id) || 0,
      jobCount24h: jobCounts.get(r.id) || 0,
    })),
  });
}

/** POST /sources — register a primary server or Alta tenant. */
function handlePostSources(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  if (!isNonEmptyString(b.name, 120)) errors.push(fail('name'));
  if (!isInEnum(b.sourceType, ['primary', 'alta'])) errors.push(fail('sourceType'));
  if (!isNonEmptyString(b.host, 253)) errors.push(fail('host'));
  if (b.port !== undefined) {
    const p = parseIntStrict(b.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) errors.push(fail('port'));
  }
  if (!isInEnum(b.authMode, ['password', 'apikey'])) errors.push(fail('authMode'));
  if (!isOptionalString(b.username, 256)) errors.push(fail('username'));
  if (!isOptionalString(b.domainName, 256)) errors.push(fail('domainName'));
  if (!isOptionalString(b.domainType, 64)) errors.push(fail('domainType'));
  if (b.password !== undefined && b.password !== null && !(typeof b.password === 'string' && b.password.length <= 512)) errors.push(fail('password'));
  if (b.apiKey !== undefined && b.apiKey !== null && !(typeof b.apiKey === 'string' && b.apiKey.length <= 512)) errors.push(fail('apiKey'));
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (b.pollingIntervalMinutes !== undefined) {
    const n = parseIntStrict(b.pollingIntervalMinutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) errors.push(fail('pollingIntervalMinutes'));
  }
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  const name = b.name;
  const host = b.host;
  const sourceType = b.sourceType || 'primary';
  const authMode = b.authMode || 'password';
  const port = b.port ? parseIntStrict(b.port) : 1556;
  if (authMode === 'password' && !b.password) {
    return res.status(400).json({ error: 'password is required for password auth mode.' });
  }
  if (authMode === 'apikey' && !b.apiKey) {
    return res.status(400).json({ error: 'apiKey is required for apikey auth mode.' });
  }
  const dup = db.prepare('SELECT id FROM netbackup_sources WHERE name = ? OR (host = ? AND port = ?)')
    .get(name.trim(), host.trim(), port);
  if (dup) return res.status(409).json({ error: 'A NetBackup source with that name or host/port is already registered.' });
  const encrypted = coreApi.encryption.encrypt(JSON.stringify(
    authMode === 'apikey' ? { apiKey: b.apiKey } : { password: b.password }
  ));
  const info = db.prepare(`
    INSERT INTO netbackup_sources (name, source_type, host, port, auth_mode, username, domain_name, domain_type,
      encrypted_credentials, ssl_verify, polling_interval_minutes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name.trim(), sourceType, host.trim(), port, authMode,
    b.username?.trim() || null, b.domainName?.trim() || null, b.domainType?.trim() || null,
    encrypted, b.sslVerify ? 1 : 0, b.pollingIntervalMinutes ? parseIntStrict(b.pollingIntervalMinutes) : 15);
  const row = db.prepare('SELECT * FROM netbackup_sources WHERE id = ?').get(info.lastInsertRowid);
  const poller = getSourcePoller(coreApi);
  poller.schedule(row);
  poller.trigger(row).catch(() => {});
  res.status(201).json({ source: publicSource(row) });
}

/** PUT /sources/:id — update (credentials optional; blank keeps stored). */
function handlePutSource(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM netbackup_sources WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'NetBackup source not found.' });

  const b = req.body || {};
  const errors = [];
  if (b.name !== undefined && !isNonEmptyString(b.name, 120)) errors.push(fail('name'));
  if (!isInEnum(b.sourceType, ['primary', 'alta'])) errors.push(fail('sourceType'));
  if (b.host !== undefined && !isNonEmptyString(b.host, 253)) errors.push(fail('host'));
  if (b.port !== undefined) {
    const p = parseIntStrict(b.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) errors.push(fail('port'));
  }
  if (!isInEnum(b.authMode, ['password', 'apikey'])) errors.push(fail('authMode'));
  if (!isOptionalString(b.username, 256)) errors.push(fail('username'));
  if (!isOptionalString(b.domainName, 256)) errors.push(fail('domainName'));
  if (!isOptionalString(b.domainType, 64)) errors.push(fail('domainType'));
  if (b.password !== undefined && b.password !== null && !(typeof b.password === 'string' && b.password.length <= 512)) errors.push(fail('password'));
  if (b.apiKey !== undefined && b.apiKey !== null && !(typeof b.apiKey === 'string' && b.apiKey.length <= 512)) errors.push(fail('apiKey'));
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (b.pollingIntervalMinutes !== undefined) {
    const n = parseIntStrict(b.pollingIntervalMinutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) errors.push(fail('pollingIntervalMinutes'));
  }
  if (errors.length) return badRequest(res, errors);

  const authMode = b.authMode || row.auth_mode;
  let encryptedCreds = row.encrypted_credentials;
  if (authMode === 'apikey' && b.apiKey) encryptedCreds = coreApi.encryption.encrypt(JSON.stringify({ apiKey: b.apiKey }));
  else if (authMode === 'password' && b.password) encryptedCreds = coreApi.encryption.encrypt(JSON.stringify({ password: b.password }));
  db.prepare(`
    UPDATE netbackup_sources SET
      name = ?, source_type = ?, host = ?, port = ?, auth_mode = ?, username = ?, domain_name = ?, domain_type = ?,
      encrypted_credentials = ?, ssl_verify = ?, polling_interval_minutes = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    b.name?.trim() || row.name, b.sourceType || row.source_type, b.host?.trim() || row.host,
    b.port ? parseIntStrict(b.port) : row.port, authMode,
    b.username !== undefined ? (b.username?.trim() || null) : row.username,
    b.domainName !== undefined ? (b.domainName?.trim() || null) : row.domain_name,
    b.domainType !== undefined ? (b.domainType?.trim() || null) : row.domain_type,
    encryptedCreds,
    b.sslVerify !== undefined ? (toBool(b.sslVerify) ? 1 : 0) : row.ssl_verify,
    b.pollingIntervalMinutes ? parseIntStrict(b.pollingIntervalMinutes) : row.polling_interval_minutes,
    row.id
  );
  netbackupApi.invalidateSession(row.id);
  const updated = db.prepare('SELECT * FROM netbackup_sources WHERE id = ?').get(row.id);
  getSourcePoller(coreApi).schedule(updated);
  res.json({ source: publicSource(updated) });
}

/** DELETE /sources/:id — unregister (CASCADE clears inventory). */
function handleDeleteSource(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM netbackup_sources WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'NetBackup source not found.' });
  getSourcePoller(coreApi).cancel(row.id);
  netbackupApi.invalidateSession(row.id);
  db.prepare('DELETE FROM netbackup_sources WHERE id = ?').run(row.id);
  res.json({ deleted: true });
}

/** POST /sources/test — validate a saved source ({id}) or a candidate. */
async function handlePostSourcesTest(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  if (b.id !== undefined && !Number.isInteger(parseIntStrict(b.id))) errors.push(fail('id'));
  if (!isInEnum(b.sourceType, ['primary', 'alta'])) errors.push(fail('sourceType'));
  if (b.host !== undefined && typeof b.host !== 'string') errors.push(fail('host'));
  if (b.port !== undefined) {
    const p = parseIntStrict(b.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) errors.push(fail('port'));
  }
  if (!isInEnum(b.authMode, ['password', 'apikey'])) errors.push(fail('authMode'));
  if (b.username !== undefined && b.username !== null && typeof b.username !== 'string') errors.push(fail('username'));
  if (b.domainName !== undefined && b.domainName !== null && typeof b.domainName !== 'string') errors.push(fail('domainName'));
  if (b.domainType !== undefined && b.domainType !== null && typeof b.domainType !== 'string') errors.push(fail('domainType'));
  if (b.password !== undefined && b.password !== null && typeof b.password !== 'string') errors.push(fail('password'));
  if (b.apiKey !== undefined && b.apiKey !== null && typeof b.apiKey !== 'string') errors.push(fail('apiKey'));
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  let candidate;
  if (b.id) {
    const row = db.prepare('SELECT * FROM netbackup_sources WHERE id = ?').get(b.id);
    if (!row) return res.status(404).json({ error: 'NetBackup source not found.' });
    candidate = { ...row };
    if (b.host) candidate.host = b.host.trim();
    if (b.port) candidate.port = b.port;
    if (b.sslVerify !== undefined) candidate.ssl_verify = b.sslVerify ? 1 : 0;
    if (b.password) candidate.password = b.password;
    if (b.apiKey) candidate.apiKey = b.apiKey;
  } else {
    if (!b.host) return res.status(400).json({ error: 'host is required.' });
    candidate = {
      sourceType: b.sourceType || 'primary', host: b.host.trim(), port: b.port || 1556,
      authMode: b.authMode || 'password', username: b.username, domainName: b.domainName, domainType: b.domainType,
      password: b.password, apiKey: b.apiKey, sslVerify: b.sslVerify ? 1 : 0,
    };
  }
  const result = await netbackupApi.testConnection(candidate, coreApi);
  res.status(result.ok ? 200 : 502).json(result);
}

/** POST /sources/:id/refresh — poll this source now. */
async function handlePostSourceRefresh(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const row = coreApi.db.prepare('SELECT * FROM netbackup_sources WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'NetBackup source not found.' });
  await getSourcePoller(coreApi).trigger(row);
  res.json({ triggered: true });
}

/** GET /sources/:id/probe — raw-shape probe (the blind-build fix loop). */
async function handleGetSourceProbe(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const row = coreApi.db.prepare('SELECT * FROM netbackup_sources WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'NetBackup source not found.' });
  res.json(await netbackupApi.fetchProbe(row, coreApi));
}

// ── Appliance Connections CRUD (52xx/53xx hardware monitoring; BYO not supported) ──

/** GET /appliance-connections — registered appliance connections (never credentials). */
function handleGetApplianceConnections(req, res, coreApi) {
  const rows = coreApi.db.prepare('SELECT * FROM netbackup_appliance_conns ORDER BY name').all();
  res.json({ connections: rows.map(publicConn) });
}

/** POST /appliance-connections — register a 52xx/53xx appliance. */
function handlePostApplianceConnections(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  if (!isNonEmptyString(b.name, 120)) errors.push(fail('name'));
  if (!isNonEmptyString(b.host, 253)) errors.push(fail('host'));
  if (b.port !== undefined) {
    const p = parseIntStrict(b.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) errors.push(fail('port'));
  }
  if (!isOptionalString(b.username, 256)) errors.push(fail('username'));
  if (!isNonEmptyString(b.password, 512)) errors.push(fail('password'));
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (b.pollingIntervalMinutes !== undefined) {
    const n = parseIntStrict(b.pollingIntervalMinutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) errors.push(fail('pollingIntervalMinutes'));
  }
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  const name = b.name;
  const host = b.host;
  const port = b.port ? parseIntStrict(b.port) : 443;
  const dup = db.prepare('SELECT id FROM netbackup_appliance_conns WHERE name = ? OR (host = ? AND port = ?)')
    .get(name.trim(), host.trim(), port);
  if (dup) return res.status(409).json({ error: 'A NetBackup appliance connection with that name or host/port is already registered.' });
  const encrypted = coreApi.encryption.encrypt(JSON.stringify({ password: b.password }));
  const info = db.prepare(`
    INSERT INTO netbackup_appliance_conns (name, host, port, username, encrypted_credentials, ssl_verify, polling_interval_minutes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name.trim(), host.trim(), port, b.username?.trim() || null,
    encrypted, b.sslVerify ? 1 : 0, b.pollingIntervalMinutes ? parseIntStrict(b.pollingIntervalMinutes) : 30);
  const row = db.prepare('SELECT * FROM netbackup_appliance_conns WHERE id = ?').get(info.lastInsertRowid);
  const poller = getAppliancePoller(coreApi);
  poller.schedule(row);
  poller.trigger(row).catch(() => {});
  res.status(201).json({ connection: publicConn(row) });
}

/** PUT /appliance-connections/:id — update (password optional; blank keeps stored). */
function handlePutApplianceConnection(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM netbackup_appliance_conns WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'NetBackup appliance connection not found.' });

  const b = req.body || {};
  const errors = [];
  if (b.name !== undefined && !isNonEmptyString(b.name, 120)) errors.push(fail('name'));
  if (b.host !== undefined && !isNonEmptyString(b.host, 253)) errors.push(fail('host'));
  if (b.port !== undefined) {
    const p = parseIntStrict(b.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) errors.push(fail('port'));
  }
  if (!isOptionalString(b.username, 256)) errors.push(fail('username'));
  if (b.password !== undefined && b.password !== null && !(typeof b.password === 'string' && b.password.length <= 512)) errors.push(fail('password'));
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (b.pollingIntervalMinutes !== undefined) {
    const n = parseIntStrict(b.pollingIntervalMinutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) errors.push(fail('pollingIntervalMinutes'));
  }
  if (errors.length) return badRequest(res, errors);

  const encryptedCreds = b.password ? coreApi.encryption.encrypt(JSON.stringify({ password: b.password })) : row.encrypted_credentials;
  db.prepare(`
    UPDATE netbackup_appliance_conns SET
      name = ?, host = ?, port = ?, username = ?, encrypted_credentials = ?,
      ssl_verify = ?, polling_interval_minutes = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    b.name?.trim() || row.name, b.host?.trim() || row.host, b.port ? parseIntStrict(b.port) : row.port,
    b.username !== undefined ? (b.username?.trim() || null) : row.username,
    encryptedCreds,
    b.sslVerify !== undefined ? (toBool(b.sslVerify) ? 1 : 0) : row.ssl_verify,
    b.pollingIntervalMinutes ? parseIntStrict(b.pollingIntervalMinutes) : row.polling_interval_minutes,
    row.id
  );
  netbackupApplianceApi.invalidateSession(row.id);
  const updated = db.prepare('SELECT * FROM netbackup_appliance_conns WHERE id = ?').get(row.id);
  getAppliancePoller(coreApi).schedule(updated);
  res.json({ connection: publicConn(updated) });
}

/** DELETE /appliance-connections/:id — unregister (CASCADE clears hardware rows). */
function handleDeleteApplianceConnection(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM netbackup_appliance_conns WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'NetBackup appliance connection not found.' });
  getAppliancePoller(coreApi).cancel(row.id);
  netbackupApplianceApi.invalidateSession(row.id);
  db.prepare('DELETE FROM netbackup_appliance_conns WHERE id = ?').run(row.id);
  res.json({ deleted: true });
}

/** POST /appliance-connections/test — validate a saved conn ({id}) or a candidate. */
async function handlePostApplianceConnectionsTest(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  if (b.id !== undefined && !Number.isInteger(parseIntStrict(b.id))) errors.push(fail('id'));
  if (b.host !== undefined && typeof b.host !== 'string') errors.push(fail('host'));
  if (b.port !== undefined) {
    const p = parseIntStrict(b.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) errors.push(fail('port'));
  }
  if (b.username !== undefined && b.username !== null && typeof b.username !== 'string') errors.push(fail('username'));
  if (b.password !== undefined && b.password !== null && typeof b.password !== 'string') errors.push(fail('password'));
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  let candidate;
  if (b.id) {
    const row = db.prepare('SELECT * FROM netbackup_appliance_conns WHERE id = ?').get(b.id);
    if (!row) return res.status(404).json({ error: 'NetBackup appliance connection not found.' });
    candidate = { ...row };
    if (b.host) candidate.host = b.host.trim();
    if (b.port) candidate.port = b.port;
    if (b.username !== undefined) candidate.username = b.username;
    if (b.sslVerify !== undefined) candidate.ssl_verify = b.sslVerify ? 1 : 0;
    if (b.password) candidate.password = b.password;
  } else {
    if (!b.host) return res.status(400).json({ error: 'host is required.' });
    candidate = {
      host: b.host.trim(), port: b.port || 443, username: b.username,
      password: b.password, sslVerify: b.sslVerify ? 1 : 0,
    };
  }
  const result = await netbackupApplianceApi.testConnection(candidate, coreApi);
  res.status(result.ok ? 200 : 502).json(result);
}

/** POST /appliance-connections/:id/refresh — poll this connection now. */
async function handlePostApplianceConnectionRefresh(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const row = coreApi.db.prepare('SELECT * FROM netbackup_appliance_conns WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'NetBackup appliance connection not found.' });
  await getAppliancePoller(coreApi).trigger(row);
  res.json({ triggered: true });
}

/** GET /appliance-connections/:id/probe — raw-shape probe (blind-build fix loop). */
async function handleGetApplianceConnectionProbe(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const row = coreApi.db.prepare('SELECT * FROM netbackup_appliance_conns WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'NetBackup appliance connection not found.' });
  res.json(await netbackupApplianceApi.fetchProbe(row, coreApi));
}

/** GET /appliance-hardware — stored hardware inventory + per-connection summary. */
function handleGetApplianceHardware(req, res, coreApi) {
  const db = coreApi.db;
  const conns = db.prepare('SELECT * FROM netbackup_appliance_conns ORDER BY name').all();
  const hwRows = db.prepare(`
    SELECT h.*, c.name AS conn_name FROM netbackup_appliance_hw h
    JOIN netbackup_appliance_conns c ON c.id = h.conn_id
    ORDER BY c.name, h.component_type, h.component_name
  `).all();

  const summaries = new Map();
  for (const c of conns) summaries.set(c.id, { ok: 0, warning: 0, critical: 0, unknown: 0 });
  for (const h of hwRows) {
    const s = summaries.get(h.conn_id);
    if (s && s[h.status] !== undefined) s[h.status] += 1;
  }

  res.json({
    connections: conns.map((c) => ({
      id: c.id, name: c.name, host: c.host,
      lastPollStatus: c.last_poll_status, lastPollError: c.last_poll_error, lastPollAt: c.last_poll_at,
      summary: summaries.get(c.id) || { ok: 0, warning: 0, critical: 0, unknown: 0 },
    })),
    components: hwRows.map((h) => {
      let detail = null;
      try { detail = h.detail_json ? JSON.parse(h.detail_json) : null; } catch { detail = null; }
      return {
        connId: h.conn_id, connName: h.conn_name, componentType: h.component_type,
        componentName: h.component_name, status: h.status, stateRaw: h.state_raw, detail,
      };
    }),
  });
}

// ── Data endpoints ───────────────────────────────────────────────────────────

/** GET /overview — estate rollup + computed issues. */
function handleGetOverview(req, res, coreApi) {
  const db = coreApi.db;
  const sources = db.prepare('SELECT * FROM netbackup_sources ORDER BY name').all();
  const jobs24h = db.prepare(`
    SELECT j.*, s.name AS source_name FROM netbackup_jobs j
    JOIN netbackup_sources s ON s.id = j.source_id
    WHERE j.started_at >= datetime('now', '-1 day')
  `).all();
  const failed24h = jobs24h.filter(isFailedJob);
  const successRate = jobs24h.length ? ((jobs24h.length - failed24h.length) / jobs24h.length) * 100 : null;
  const activePolicies = db.prepare('SELECT COUNT(*) AS n FROM netbackup_policies WHERE active = 1').get().n;
  const protectedClients = new Set(jobs24h.map((j) => j.client_name).filter(Boolean)).size;
  const storageAgg = db.prepare('SELECT SUM(capacity_bytes) AS cap, SUM(used_bytes) AS used FROM netbackup_storage_units').get();
  const mediaServerCount = db.prepare('SELECT COUNT(*) AS n FROM netbackup_media_servers').get().n;
  const applianceCount = db.prepare('SELECT COUNT(*) AS n FROM netbackup_appliances').get().n;

  const jobsByState = {};
  const jobsByPolicyType = {};
  for (const j of jobs24h) {
    const state = j.state || 'UNKNOWN';
    jobsByState[state] = (jobsByState[state] || 0) + 1;
    const type = j.policy_type || 'UNKNOWN';
    jobsByPolicyType[type] = (jobsByPolicyType[type] || 0) + 1;
  }

  const recentFailedJobs = failed24h
    .sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''))
    .slice(0, 25)
    .map(mapJobRow);

  const catalog = sources.map((s) => {
    const row = db.prepare(`
      SELECT kilobytes, started_at FROM netbackup_jobs
      WHERE source_id = ? AND policy_type = 'NBU-Catalog'
        AND state != 'FAILED' AND NOT (state IN ('EXITED', 'DONE') AND COALESCE(status_code, 0) > 0)
      ORDER BY started_at DESC LIMIT 1
    `).get(s.id);
    if (!row) return null;
    return {
      sourceId: s.id, sourceName: s.name,
      catalogBytes: (row.kilobytes || 0) * 1024, lastRunAt: row.started_at,
    };
  }).filter(Boolean);

  res.json({
    sources: sources.map((s) => ({
      id: s.id, name: s.name, sourceType: s.source_type,
      lastPollStatus: s.last_poll_status, lastPollAt: s.last_poll_at,
    })),
    stats: {
      sourceCount: sources.length, jobs24h: jobs24h.length, failed24h: failed24h.length,
      successRate, activePolicies, protectedClients,
      storageCapacityBytes: storageAgg.cap || 0, storageUsedBytes: storageAgg.used || 0,
      mediaServerCount, applianceCount, openIssues: computeIssues(coreApi).length,
    },
    jobsByState, jobsByPolicyType, recentFailedJobs, catalog,
  });
}

/** GET /jobs?days=7&state=&sourceId= */
function handleGetJobs(req, res, coreApi) {
  const daysQ = parseQueryInt(req.query.days, 1, 30);
  const sourceIdQ = parseQueryInt(req.query.sourceId);
  if (!daysQ.ok) return badRequest(res, [fail('days')]);
  if (req.query.state !== undefined && typeof req.query.state !== 'string') return badRequest(res, [fail('state')]);
  if (!sourceIdQ.ok) return badRequest(res, [fail('sourceId')]);
  const days = daysQ.value || 7;
  const clauses = ["j.started_at >= datetime('now', ?)"];
  const params = [`-${days} days`];
  if (req.query.state) { clauses.push('j.state = ?'); params.push(req.query.state); }
  if (sourceIdQ.value !== undefined) { clauses.push('j.source_id = ?'); params.push(sourceIdQ.value); }
  const rows = coreApi.db.prepare(`
    SELECT j.*, s.name AS source_name FROM netbackup_jobs j
    JOIN netbackup_sources s ON s.id = j.source_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY j.started_at DESC LIMIT 2000
  `).all(...params);
  res.json({ jobs: rows.map(mapJobRow) });
}

/** GET /policies */
function handleGetPolicies(req, res, coreApi) {
  const db = coreApi.db;
  const rows = db.prepare(`
    SELECT p.*, s.name AS source_name FROM netbackup_policies p
    JOIN netbackup_sources s ON s.id = p.source_id ORDER BY s.name, p.name
  `).all();
  const failedCounts = new Map(db.prepare(`
    SELECT source_id, policy_name, COUNT(*) AS n FROM netbackup_jobs
    WHERE started_at >= datetime('now', '-1 day')
      AND (state = 'FAILED' OR (state IN ('EXITED', 'DONE') AND status_code > 0))
    GROUP BY source_id, policy_name
  `).all().map((r) => [`${r.source_id}|${r.policy_name}`, r.n]));
  res.json({
    policies: rows.map((p) => ({
      id: p.id, sourceId: p.source_id, sourceName: p.source_name, name: p.name, policyType: p.policy_type,
      active: !!p.active, clientCount: p.client_count, scheduleCount: p.schedule_count, selectionCount: p.selection_count,
      failed24h: failedCounts.get(`${p.source_id}|${p.name}`) || 0,
    })),
  });
}

/** GET /policies/:id — stored policy detail (clients/schedules/selections). */
function handleGetPolicyDetail(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const p = coreApi.db.prepare(`
    SELECT p.*, s.name AS source_name FROM netbackup_policies p
    JOIN netbackup_sources s ON s.id = p.source_id WHERE p.id = ?
  `).get(id);
  if (!p) return res.status(404).json({ error: 'Policy not found.' });
  let detail = { clients: [], schedules: [], selections: [] };
  try { detail = { ...detail, ...JSON.parse(p.detail_json || '{}') }; } catch { /* pre-v4 row */ }
  const asName = (c) => (typeof c === 'string' ? c : (c?.hostName ?? c?.clientName ?? c?.name ?? null));
  res.json({
    id: p.id, sourceId: p.source_id, sourceName: p.source_name, name: p.name,
    policyType: p.policy_type, active: !!p.active, capturedAt: p.captured_at,
    clients: (detail.clients || []).map(asName).filter(Boolean),
    schedules: (detail.schedules || []).map((s) => (typeof s === 'string'
      ? { name: s, type: null, frequencySeconds: null, retentionLevel: null }
      : {
        name: s?.scheduleName ?? s?.name ?? null,
        type: s?.scheduleType ?? s?.type ?? null,
        frequencySeconds: s?.frequencySeconds ?? s?.frequency ?? null,
        retentionLevel: s?.retentionLevel ?? null,
      })).filter((s) => s.name || s.type),
    selections: (detail.selections || []).map((sel) => (typeof sel === 'string' ? sel : (sel?.path ?? JSON.stringify(sel)))).filter(Boolean),
    hasDetail: !!p.detail_json,
  });
}

/** GET /storage */
function handleGetStorage(req, res, coreApi) {
  const db = coreApi.db;
  res.json({
    storageUnits: db.prepare(`
      SELECT u.*, s.name AS source_name FROM netbackup_storage_units u
      JOIN netbackup_sources s ON s.id = u.source_id ORDER BY s.name, u.name
    `).all().map((u) => ({
      id: u.id, sourceId: u.source_id, sourceName: u.source_name, name: u.name,
      storageUnitType: u.storage_unit_type, diskPool: u.disk_pool, mediaServer: u.media_server,
      maxConcurrentJobs: u.max_concurrent_jobs, capacityBytes: u.capacity_bytes,
      freeBytes: u.free_bytes, usedBytes: u.used_bytes,
    })),
    diskPools: db.prepare(`
      SELECT p.*, s.name AS source_name FROM netbackup_disk_pools p
      JOIN netbackup_sources s ON s.id = p.source_id ORDER BY s.name, p.name
    `).all().map((p) => ({
      id: p.id, sourceId: p.source_id, sourceName: p.source_name, name: p.name,
      serverType: p.server_type, status: p.status, totalCapacityBytes: p.total_capacity_bytes,
      usedCapacityBytes: p.used_capacity_bytes, availableCapacityBytes: p.available_capacity_bytes,
      volumeCount: p.volume_count,
    })),
  });
}

/** GET /media-servers */
function handleGetMediaServers(req, res, coreApi) {
  res.json({
    mediaServers: coreApi.db.prepare(`
      SELECT m.*, s.name AS source_name FROM netbackup_media_servers m
      JOIN netbackup_sources s ON s.id = m.source_id ORDER BY s.name, m.name
    `).all().map((m) => ({
      id: m.id, sourceId: m.source_id, sourceName: m.source_name,
      name: m.name, state: m.state, version: m.version,
    })),
  });
}

/** GET /appliances */
function handleGetAppliances(req, res, coreApi) {
  res.json({
    appliances: coreApi.db.prepare(`
      SELECT a.*, s.name AS source_name, o.model_override AS model_override
      FROM netbackup_appliances a
      JOIN netbackup_sources s ON s.id = a.source_id
      LEFT JOIN netbackup_appliance_overrides o ON o.source_id = a.source_id AND o.name = a.name
      ORDER BY s.name, a.name
    `).all().map(mapApplianceRow),
  });
}

/** PUT /appliances/model — set/clear a per-appliance model override. */
function handlePutApplianceModel(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  if (!Number.isInteger(parseIntStrict(b.sourceId))) errors.push(fail('sourceId'));
  if (!isNonEmptyString(b.name, 200)) errors.push(fail('name'));
  if (b.model !== undefined && b.model !== null && !(typeof b.model === 'string' && b.model.length <= 120)) errors.push(fail('model'));
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  const sourceId = parseIntStrict(b.sourceId);
  const name = b.name;
  const model = (b.model ?? '').trim();

  const appliance = db.prepare('SELECT a.*, s.name AS source_name FROM netbackup_appliances a JOIN netbackup_sources s ON s.id = a.source_id WHERE a.source_id = ? AND a.name = ?')
    .get(sourceId, name);
  if (!appliance) return res.status(404).json({ error: 'No matching NetBackup appliance found for that source/name.' });

  if (model) {
    db.prepare(`
      INSERT INTO netbackup_appliance_overrides (source_id, name, model_override, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(source_id, name) DO UPDATE SET model_override = excluded.model_override, updated_at = datetime('now')
    `).run(sourceId, name, model);
  } else {
    db.prepare('DELETE FROM netbackup_appliance_overrides WHERE source_id = ? AND name = ?').run(sourceId, name);
  }

  const override = db.prepare('SELECT model_override FROM netbackup_appliance_overrides WHERE source_id = ? AND name = ?')
    .get(sourceId, name);
  res.json({ appliance: mapApplianceRow({ ...appliance, model_override: override?.model_override ?? null }) });
}

/** GET /issues — computed issues (live). */
function handleGetIssues(req, res, coreApi) {
  const sourceNames = new Map(coreApi.db.prepare('SELECT id, name FROM netbackup_sources').all().map((s) => [s.id, s.name]));
  res.json({
    issues: computeIssues(coreApi).map((i) => ({
      issueKey: i.issue_key, severity: i.severity, message: i.message, host: i.host,
      source: i.source, type: i.type, target: i.target,
      sourceId: i.source_id ?? null, sourceName: i.source_id != null ? (sourceNames.get(i.source_id) ?? null) : null,
    })),
  });
}

/** GET /issue-history?days= — detected-issue lifecycle (open first). */
function handleGetIssueHistory(req, res, coreApi) {
  const q = parseQueryInt(req.query.days, 1, 90);
  if (!q.ok) return badRequest(res, [fail('days')]);
  const days = q.value || 30;
  res.json(coreApi.db.prepare(`
    SELECT * FROM netbackup_issue_history
    WHERE status = 'open' OR last_seen >= datetime('now', ?)
    ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, last_seen DESC
  `).all(`-${days} days`));
}

/** GET /trends?days=30&sourceId= */
function handleGetTrends(req, res, coreApi) {
  const daysQ = parseQueryInt(req.query.days, 1, 365);
  const sourceIdQ = parseQueryInt(req.query.sourceId);
  if (!daysQ.ok) return badRequest(res, [fail('days')]);
  if (!sourceIdQ.ok) return badRequest(res, [fail('sourceId')]);
  const days = daysQ.value || 30;
  const clauses = ["m.captured_at >= datetime('now', ?)"];
  const params = [`-${days} days`];
  if (sourceIdQ.value !== undefined) { clauses.push('m.source_id = ?'); params.push(sourceIdQ.value); }
  const rows = coreApi.db.prepare(`
    SELECT m.*, s.name AS source_name FROM netbackup_metrics_history m
    JOIN netbackup_sources s ON s.id = m.source_id
    WHERE ${clauses.join(' AND ')} ORDER BY m.source_id, m.captured_at
  `).all(...params);
  const bySource = new Map();
  for (const r of rows) {
    if (!bySource.has(r.source_id)) bySource.set(r.source_id, { sourceId: r.source_id, sourceName: r.source_name, points: [] });
    bySource.get(r.source_id).points.push({
      capturedAt: r.captured_at, jobs24h: r.jobs_24h, failedJobs24h: r.failed_jobs_24h,
      successRate: r.success_rate, storageUsedBytes: r.storage_used_bytes, storageCapacityBytes: r.storage_capacity_bytes,
    });
  }
  res.json({ trends: [...bySource.values()] });
}

function entitledTb(coreApi) {
  return Number(coreApi.settings.getSetting('netbackup_entitled_tb')) || 0;
}

/** Tolerantly normalizes whatever shape fetchLicensing() returned into a stable render-ready object. */
function normalizeUpstreamLicensing(raw, fallbackEntitledTb) {
  if (!raw || typeof raw !== 'object') return null;
  const num = (v) => (v === undefined || v === null || Number.isNaN(Number(v)) ? null : Number(v));
  const reportedTb = num(
    raw.frontEndTerabytes ?? raw.frontEndTb ?? raw.reportedTb ?? raw.usedTb
      ?? raw.consumedTb ?? raw.capacityTb ?? (raw.capacity != null ? Number(raw.capacity) / 1e12 : null)
      ?? (raw.usedBytes != null ? Number(raw.usedBytes) / 1e12 : null)
      ?? (raw.frontEndBytes != null ? Number(raw.frontEndBytes) / 1e12 : null)
  );
  const entitledTbUpstream = num(raw.entitledTb ?? raw.licensedTb ?? raw.entitlementTb);
  return {
    meter: raw.meter ?? raw.meterName ?? raw.licenseMeter ?? 'Capacity (FETB)',
    reportedTb,
    entitledTb: entitledTbUpstream != null ? entitledTbUpstream : fallbackEntitledTb,
    asOf: raw.asOf ?? raw.reportedAt ?? raw.capturedAt ?? raw.timestamp ?? new Date().toISOString(),
    raw,
  };
}

/** GET /config — alert thresholds + licensing entitlement. */
function handleGetConfig(req, res, coreApi) {
  res.json({
    successWarnPct: successWarnPct(coreApi), storageWarnPct: storageWarnPct(coreApi), staleBackupHours: staleBackupHours(coreApi),
    entitledTb: entitledTb(coreApi),
  });
}

/** PUT /config — save alert thresholds + licensing entitlement. */
function handlePutConfig(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  const sw = parseIntStrict(b.successWarnPct);
  if (!Number.isInteger(sw) || sw < 50 || sw > 100) errors.push(fail('successWarnPct'));
  const stw = parseIntStrict(b.storageWarnPct);
  if (!Number.isInteger(stw) || stw < 5 || stw > 50) errors.push(fail('storageWarnPct'));
  const sbh = parseIntStrict(b.staleBackupHours);
  if (!Number.isInteger(sbh) || sbh < 12 || sbh > 336) errors.push(fail('staleBackupHours'));
  if (b.entitledTb !== undefined) {
    const et = Number(b.entitledTb);
    if (!Number.isFinite(et) || et < 0 || et > 100000) errors.push(fail('entitledTb'));
  }
  if (errors.length) return badRequest(res, errors);

  coreApi.settings.setSetting('netbackup_success_warn_pct', String(sw));
  coreApi.settings.setSetting('netbackup_storage_warn_pct', String(stw));
  coreApi.settings.setSetting('netbackup_stale_backup_hours', String(sbh));
  if (b.entitledTb !== undefined) coreApi.settings.setSetting('netbackup_entitled_tb', String(Number(b.entitledTb)));
  res.json({
    successWarnPct: successWarnPct(coreApi), storageWarnPct: storageWarnPct(coreApi), staleBackupHours: staleBackupHours(coreApi),
    entitledTb: entitledTb(coreApi),
  });
}

// ── SLP / Replication ────────────────────────────────────────────────────────

/** GET /slps — SLP definitions + replication/duplication job stats. */
function handleGetSlps(req, res, coreApi) {
  const db = coreApi.db;
  const slps = db.prepare(`
    SELECT sl.*, s.name AS source_name FROM netbackup_slps sl
    JOIN netbackup_sources s ON s.id = sl.source_id ORDER BY s.name, sl.name
  `).all().map((r) => ({
    id: r.id, sourceId: r.source_id, sourceName: r.source_name, name: r.name, version: r.version,
    dataClassification: r.data_classification, priority: r.priority, operationCount: r.operation_count,
    operations: r.operations_json ? JSON.parse(r.operations_json) : [],
  }));

  const placeholders = REPLICATION_TYPES.map(() => '?').join(',');
  const jobs24h = db.prepare(`
    SELECT j.*, s.name AS source_name FROM netbackup_jobs j JOIN netbackup_sources s ON s.id = j.source_id
    WHERE UPPER(j.job_type) IN (${placeholders}) AND j.started_at >= datetime('now', '-1 day')
  `).all(...REPLICATION_TYPES);
  const jobs7d = db.prepare(`
    SELECT j.*, s.name AS source_name FROM netbackup_jobs j JOIN netbackup_sources s ON s.id = j.source_id
    WHERE UPPER(j.job_type) IN (${placeholders}) AND j.started_at >= datetime('now', '-7 days')
  `).all(...REPLICATION_TYPES);

  const failed24h = jobs24h.filter(isFailedJob);
  const failed7d = jobs7d.filter(isFailedJob);

  const byPolicy = new Map();
  for (const j of jobs7d) {
    if (!j.policy_name) continue;
    const key = `${j.source_id}|${j.policy_name}`;
    if (!byPolicy.has(key)) {
      byPolicy.set(key, {
        sourceId: j.source_id, sourceName: j.source_name, policyName: j.policy_name,
        total7d: 0, failed7d: 0, lastStatus: null, lastRunAt: null, kilobytes7d: 0,
      });
    }
    const p = byPolicy.get(key);
    p.total7d += 1;
    if (isFailedJob(j)) p.failed7d += 1;
    p.kilobytes7d += j.kilobytes || 0;
    if (!p.lastRunAt || (j.started_at && j.started_at > p.lastRunAt)) {
      p.lastRunAt = j.started_at;
      p.lastStatus = isFailedJob(j) ? 'FAILED' : 'SUCCESS';
    }
  }

  res.json({
    slps,
    replication: {
      jobs24h: jobs24h.length, failed24h: failed24h.length,
      jobs7d: jobs7d.length, failed7d: failed7d.length,
      byPolicy: [...byPolicy.values()],
    },
  });
}

// ── Governance ───────────────────────────────────────────────────────────────

/** GET /governance — inactive/idle policies, unprotected clients, catalog, version drift. */
function handleGetGovernance(req, res, coreApi) {
  const db = coreApi.db;
  const inactivePolicies = db.prepare(`
    SELECT p.source_id, s.name AS source_name, p.name, p.policy_type FROM netbackup_policies p
    JOIN netbackup_sources s ON s.id = p.source_id WHERE p.active = 0 ORDER BY s.name, p.name
  `).all().map((r) => ({ sourceId: r.source_id, sourceName: r.source_name, name: r.name, policyType: r.policy_type }));

  const activePolicies = db.prepare(`
    SELECT p.source_id, s.name AS source_name, p.name, p.policy_type FROM netbackup_policies p
    JOIN netbackup_sources s ON s.id = p.source_id WHERE p.active = 1
  `).all();
  const lastRunByPolicy = new Map(db.prepare(`
    SELECT source_id, policy_name, MAX(started_at) AS last_run FROM netbackup_jobs GROUP BY source_id, policy_name
  `).all().map((r) => [`${r.source_id}|${r.policy_name}`, r.last_run]));
  const idlePolicies = activePolicies.filter((p) => {
    const lastRun = lastRunByPolicy.get(`${p.source_id}|${p.name}`);
    return !lastRun || (Date.now() - new Date(lastRun).getTime()) / 3600000 > 168;
  }).map((p) => ({
    sourceId: p.source_id, sourceName: p.source_name, name: p.name, policyType: p.policy_type,
    lastRunAt: lastRunByPolicy.get(`${p.source_id}|${p.name}`) || null,
  }));

  const staleHours = staleBackupHours(coreApi);
  const clientRows = db.prepare(`
    SELECT j.source_id, s.name AS source_name, j.client_name,
      MAX(CASE WHEN j.state != 'FAILED' AND NOT (j.state IN ('EXITED', 'DONE') AND COALESCE(j.status_code, 0) > 0)
                THEN j.started_at END) AS last_success
    FROM netbackup_jobs j JOIN netbackup_sources s ON s.id = j.source_id
    WHERE j.client_name IS NOT NULL
    GROUP BY j.source_id, j.client_name
  `).all();
  const unprotectedClients = clientRows.filter((c) => {
    if (!c.last_success) return true;
    return (Date.now() - new Date(c.last_success).getTime()) / 3600000 > staleHours;
  }).map((c) => ({ sourceName: c.source_name, clientName: c.client_name, lastSuccessAt: c.last_success }));

  const catalogRow = db.prepare(`
    SELECT j.policy_name, MAX(j.started_at) AS last_success FROM netbackup_jobs j
    WHERE j.policy_type = 'NBU-Catalog' AND j.state != 'FAILED'
      AND NOT (j.state IN ('EXITED', 'DONE') AND COALESCE(j.status_code, 0) > 0)
    GROUP BY j.policy_name ORDER BY last_success DESC LIMIT 1
  `).get();
  let catalogBackup = null;
  if (catalogRow) {
    const ageHours = (Date.now() - new Date(catalogRow.last_success).getTime()) / 3600000;
    catalogBackup = {
      policyName: catalogRow.policy_name, lastSuccessAt: catalogRow.last_success,
      ageHours: +ageHours.toFixed(1), ok: ageHours <= staleHours,
    };
  }

  const versionRows = [
    ...db.prepare(`
      SELECT s.name AS source_name, m.name, m.version FROM netbackup_media_servers m
      JOIN netbackup_sources s ON s.id = m.source_id WHERE m.version IS NOT NULL
    `).all().map((r) => ({ sourceName: r.source_name, name: r.name, kind: 'media-server', version: r.version })),
    ...db.prepare(`
      SELECT s.name AS source_name, a.name, a.nbu_version AS version FROM netbackup_appliances a
      JOIN netbackup_sources s ON s.id = a.source_id WHERE a.nbu_version IS NOT NULL
    `).all().map((r) => ({ sourceName: r.source_name, name: r.name, kind: 'appliance', version: r.version })),
  ];
  const versionCounts = new Map();
  for (const r of versionRows) versionCounts.set(r.version, (versionCounts.get(r.version) || 0) + 1);
  let dominant = null; let dominantCount = -1;
  for (const [v, c] of versionCounts) { if (c > dominantCount) { dominant = v; dominantCount = c; } }
  const versionDrift = {
    dominant,
    rows: versionRows.map((r) => ({ ...r, isOutlier: dominant != null && r.version !== dominant })),
  };

  res.json({
    generatedAt: new Date().toISOString(),
    inactivePolicies, idlePolicies, unprotectedClients, catalogBackup, versionDrift,
    summary: {
      inactiveCount: inactivePolicies.length, idleCount: idlePolicies.length,
      unprotectedCount: unprotectedClients.length,
      catalogOk: catalogBackup ? catalogBackup.ok : null,
      outlierCount: versionDrift.rows.filter((r) => r.isOutlier).length,
    },
  });
}

// ── Workloads ────────────────────────────────────────────────────────────────

/** GET /workloads — latest per-source-per-workload snapshot + estate/domain rollups. */
function handleGetWorkloads(req, res, coreApi) {
  const db = coreApi.db;
  const sourceTypes = new Map(db.prepare('SELECT id, source_type FROM netbackup_sources').all().map((s) => [s.id, s.source_type]));
  const rows = db.prepare(`
    SELECT w.source_id, s.name AS source_name, w.workload, w.protected_clients, w.job_count,
           w.success_count, w.failed_count, w.protected_bytes, w.captured_at
    FROM netbackup_workload_history w
    JOIN netbackup_sources s ON s.id = w.source_id
    JOIN (SELECT source_id, MAX(captured_at) AS latest FROM netbackup_workload_history GROUP BY source_id) t
      ON t.source_id = w.source_id AND w.captured_at = t.latest
    ORDER BY s.name, w.workload
  `).all();

  const estateMap = new Map();
  const domainsMap = new Map();
  for (const r of rows) {
    if (!estateMap.has(r.workload)) {
      estateMap.set(r.workload, {
        workload: r.workload, sources: 0, protectedClients: 0, jobCount: 0,
        successCount: 0, failedCount: 0, protectedBytes: 0,
      });
    }
    const e = estateMap.get(r.workload);
    e.sources += 1;
    e.protectedClients += r.protected_clients || 0;
    e.jobCount += r.job_count || 0;
    e.successCount += r.success_count || 0;
    e.failedCount += r.failed_count || 0;
    e.protectedBytes += r.protected_bytes || 0;

    if (!domainsMap.has(r.source_id)) {
      domainsMap.set(r.source_id, {
        sourceId: r.source_id, sourceName: r.source_name, sourceType: sourceTypes.get(r.source_id) || null,
        protectedClients: 0, jobCount: 0, failedCount: 0, protectedBytes: 0, workloads: {},
      });
    }
    const d = domainsMap.get(r.source_id);
    d.protectedClients += r.protected_clients || 0;
    d.jobCount += r.job_count || 0;
    d.failedCount += r.failed_count || 0;
    d.protectedBytes += r.protected_bytes || 0;
    d.workloads[r.workload] = r.protected_bytes || 0;
  }

  res.json({
    rows: rows.map((r) => ({
      sourceId: r.source_id, sourceName: r.source_name, workload: r.workload,
      protectedClients: r.protected_clients, jobCount: r.job_count, successCount: r.success_count,
      failedCount: r.failed_count, protectedBytes: r.protected_bytes, capturedAt: r.captured_at,
    })),
    estate: [...estateMap.values()].sort((a, b) => b.protectedBytes - a.protectedBytes),
    domains: [...domainsMap.values()],
  });
}

/** GET /workloads/trends?days=90&sourceId=&workload= */
function handleGetWorkloadsTrends(req, res, coreApi) {
  const daysQ = parseQueryInt(req.query.days, 7, 400);
  const sourceIdQ = parseQueryInt(req.query.sourceId);
  if (!daysQ.ok) return badRequest(res, [fail('days')]);
  if (!sourceIdQ.ok) return badRequest(res, [fail('sourceId')]);
  if (req.query.workload !== undefined && typeof req.query.workload !== 'string') return badRequest(res, [fail('workload')]);
  const days = daysQ.value || 90;
  const sourceId = sourceIdQ.value ?? null;
  const workload = req.query.workload ?? null;
  const rows = coreApi.db.prepare(`
    WITH latest_per_day AS (
      SELECT date(captured_at) AS day, source_id, workload,
             protected_clients, job_count, failed_count, protected_bytes,
             ROW_NUMBER() OVER (
               PARTITION BY date(captured_at), source_id, workload
               ORDER BY captured_at DESC
             ) AS rn
      FROM netbackup_workload_history
      WHERE captured_at >= datetime('now', ?)
        AND (? IS NULL OR source_id = ?)
        AND (? IS NULL OR workload = ?)
    )
    SELECT day, workload,
           SUM(protected_clients) AS protected_clients,
           SUM(job_count) AS job_count,
           SUM(failed_count) AS failed_count,
           SUM(protected_bytes) AS protected_bytes
    FROM latest_per_day WHERE rn = 1
    GROUP BY day, workload
    ORDER BY day, workload
  `).all(`-${days} days`, sourceId, sourceId, workload, workload);
  res.json({
    trends: rows.map((r) => ({
      day: r.day, workload: r.workload, protectedClients: r.protected_clients,
      jobCount: r.job_count, failedCount: r.failed_count, protectedBytes: r.protected_bytes,
    })),
  });
}

// ── Licensing ────────────────────────────────────────────────────────────────

/** GET /licensing — computed FETB by workload/domain + entitlement + upstream (if reachable). */
async function handleGetLicensing(req, res, coreApi) {
  const db = coreApi.db;
  const sources = db.prepare('SELECT * FROM netbackup_sources').all();
  const sourceById = new Map(sources.map((s) => [s.id, s]));

  const rowsRaw = db.prepare(`
    SELECT source_id, COALESCE(policy_type, 'Other') AS workload, client_name, MAX(kilobytes) AS max_kb
    FROM netbackup_jobs
    WHERE started_at >= datetime('now', '-30 days') AND client_name IS NOT NULL
      AND state != 'FAILED' AND NOT (state IN ('EXITED', 'DONE') AND COALESCE(status_code, 0) > 0)
      AND UPPER(COALESCE(job_type, '')) NOT IN (${REPLICATION_TYPES.map(() => '?').join(',')})
    GROUP BY source_id, workload, client_name
  `).all(...REPLICATION_TYPES);

  let totalBytes = 0;
  const clientsSet = new Set();
  const sourcesSet = new Set();
  const byWorkloadMap = new Map();
  const byDomainMap = new Map();
  for (const r of rowsRaw) {
    const bytes = (r.max_kb || 0) * 1024;
    totalBytes += bytes;
    clientsSet.add(`${r.source_id}|${r.client_name}`);
    sourcesSet.add(r.source_id);
    if (!byWorkloadMap.has(r.workload)) byWorkloadMap.set(r.workload, { workload: r.workload, clients: new Set(), frontEndBytes: 0 });
    const w = byWorkloadMap.get(r.workload);
    w.clients.add(`${r.source_id}|${r.client_name}`);
    w.frontEndBytes += bytes;

    if (!byDomainMap.has(r.source_id)) {
      const src = sourceById.get(r.source_id);
      byDomainMap.set(r.source_id, {
        sourceId: r.source_id, sourceName: src?.name || null, sourceType: src?.source_type || null,
        clients: new Set(), frontEndBytes: 0,
      });
    }
    const d = byDomainMap.get(r.source_id);
    d.clients.add(r.client_name);
    d.frontEndBytes += bytes;
  }

  const entitled = entitledTb(coreApi);

  let upstream;
  if (isDemo()) {
    const reportedTb = +((totalBytes / 1e12) * 0.97).toFixed(2);
    upstream = {
      meter: 'Capacity (FETB)', reportedTb, entitledTb: entitled,
      asOf: new Date().toISOString(), raw: null,
    };
  } else {
    const altaSource = sources.find((s) => s.source_type === 'alta') || sources[0] || null;
    let raw = null;
    if (altaSource) {
      try { raw = await netbackupApi.fetchLicensing(altaSource, coreApi); } catch { raw = null; }
    }
    upstream = normalizeUpstreamLicensing(raw, entitled);
  }

  res.json({
    capturedAt: new Date().toISOString(),
    basis: 'computed-fetb',
    entitledTb: entitled,
    upstream,
    totals: { frontEndBytes: totalBytes, clients: clientsSet.size, sources: sourcesSet.size },
    byWorkload: [...byWorkloadMap.values()]
      .map((w) => ({ workload: w.workload, clients: w.clients.size, frontEndBytes: w.frontEndBytes }))
      .sort((a, b) => b.frontEndBytes - a.frontEndBytes),
    byDomain: [...byDomainMap.values()]
      .map((d) => ({
        sourceId: d.sourceId, sourceName: d.sourceName, sourceType: d.sourceType,
        clients: d.clients.size, frontEndBytes: d.frontEndBytes,
        usagePercent: entitled > 0 ? +(((d.frontEndBytes / 1e12) / entitled) * 100).toFixed(1) : null,
      }))
      .sort((a, b) => b.frontEndBytes - a.frontEndBytes),
  });
}

// ── Backup History ───────────────────────────────────────────────────────────

function mapRunStatus(state, statusCode) {
  if (state === 'ACTIVE' || state === 'QUEUED') return 'kRunning';
  const failed = state === 'FAILED' || (['EXITED', 'DONE'].includes(state) && Number(statusCode || 0) > 0);
  return failed ? 'kFailure' : 'kSuccess';
}

/** GET /backup-history?q=&days= — per-client day-by-day bubble matrix data, all from netbackup_jobs. */
function handleGetBackupHistory(req, res, coreApi) {
  if (req.query.q !== undefined && (typeof req.query.q !== 'string' || req.query.q.length > 200)) return badRequest(res, [fail('q')]);
  const daysQ = parseQueryInt(req.query.days, 1, 31);
  if (!daysQ.ok) return badRequest(res, [fail('days')]);

  const db = coreApi.db;
  const q = String(req.query.q || '').trim();
  const days = Math.min(daysQ.value || 30, 31);
  const browse = q.length < 2;

  let clientNames;
  if (browse) {
    clientNames = db.prepare(`
      SELECT DISTINCT client_name FROM netbackup_jobs
      WHERE client_name IS NOT NULL
      ORDER BY client_name COLLATE NOCASE LIMIT 25
    `).all().map((r) => r.client_name);
  } else {
    const pattern = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    clientNames = db.prepare(`
      SELECT client_name, COUNT(*) AS n FROM netbackup_jobs
      WHERE client_name LIKE ? ESCAPE '\\'
      GROUP BY client_name ORDER BY n DESC LIMIT 50
    `).all(pattern).map((r) => r.client_name);
  }

  const cutoff = `-${days} days`;
  const runStmt = db.prepare(`
    SELECT j.id, j.policy_name, j.schedule_type, j.job_type, j.state, j.status_code,
           j.kilobytes, j.started_at, j.ended_at, s.name AS source_name
    FROM netbackup_jobs j JOIN netbackup_sources s ON s.id = j.source_id
    WHERE j.client_name = ? AND j.started_at >= datetime('now', ?)
    ORDER BY j.started_at ASC
  `);

  const servers = clientNames.map((name) => {
    const rows = runStmt.all(name, cutoff);
    const sourceNames = [...new Set(rows.map((r) => r.source_name))];
    const policies = [...new Set(rows.map((r) => r.policy_name).filter(Boolean))];
    const runs = rows.map((r) => ({
      id: r.id,
      group: r.policy_name,
      clusterName: r.source_name,
      runType: r.schedule_type || r.job_type,
      status: mapRunStatus(r.state, r.status_code),
      startMs: r.started_at ? Date.parse(r.started_at) : null,
      endMs: r.ended_at ? Date.parse(r.ended_at) : null,
      logicalBytes: r.kilobytes != null ? r.kilobytes * 1024 : null,
      errorCode: r.status_code > 0 ? r.status_code : null,
      errorMessage: null,
    }));
    const last = runs[runs.length - 1];
    return {
      name, sourceNames, policies,
      lastBackupStatus: last ? last.status : null,
      runs,
    };
  });

  res.json({ query: q, days, browse, servers });
}

// ── Object 360 ───────────────────────────────────────────────────────────────

/** GET /object-360/suggest?q= — client-name typeahead for the picker. */
function handleGetObject360Suggest(req, res, coreApi) {
  if (req.query.q !== undefined && typeof req.query.q !== 'string') return badRequest(res, [fail('q')]);
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ names: [] });
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = coreApi.db.prepare(`
    SELECT DISTINCT client_name AS name FROM netbackup_jobs
    WHERE client_name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 10
  `).all(pattern);
  res.json({ names: rows.map((r) => r.name) });
}

/** GET /object-360?name= — everything NetBackup knows about one client. */
function handleGetObject360(req, res, coreApi) {
  if (req.query.name !== undefined && typeof req.query.name !== 'string') return badRequest(res, [fail('name')]);
  const db = coreApi.db;
  const q = String(req.query.name || '').trim();
  if (!q) return res.status(400).json({ error: 'name required' });

  const jobs30 = db.prepare(`
    SELECT j.*, s.name AS source_name FROM netbackup_jobs j
    JOIN netbackup_sources s ON s.id = j.source_id
    WHERE j.client_name = ? AND j.started_at >= datetime('now', '-30 days')
    ORDER BY j.started_at DESC
  `).all(q);

  if (!jobs30.length) {
    return res.json({ query: q, found: false, client: null, runs14d: [], policies: [], issues: [] });
  }

  const cutoff7Ms = Date.now() - 7 * 86400000;
  const policiesSet = new Set();
  const sourceNames = new Set();
  let jobs7d = 0, failed7d = 0, jobs30d = 0, failed30d = 0;
  let lastStatus = null, lastRunAt = null, lastSuccessAt = null, logicalBytes = null;
  for (const j of jobs30) {
    if (j.policy_name) policiesSet.add(j.policy_name);
    if (j.source_name) sourceNames.add(j.source_name);
    jobs30d += 1;
    const failed = isFailedJob(j);
    const succeeded = !failed && ['EXITED', 'DONE'].includes(j.state);
    const startedMs = j.started_at ? Date.parse(j.started_at) : null;
    if (startedMs != null && startedMs >= cutoff7Ms) {
      jobs7d += 1;
      if (failed) failed7d += 1;
    }
    if (failed) failed30d += 1;
    const runAt = j.ended_at || j.started_at;
    if (runAt && (!lastRunAt || runAt > lastRunAt)) {
      lastRunAt = runAt;
      lastStatus = failed ? 'failed' : succeeded ? 'success' : (j.state || null);
    }
    if (succeeded && runAt && (!lastSuccessAt || runAt > lastSuccessAt)) {
      lastSuccessAt = runAt;
      logicalBytes = j.kilobytes != null ? j.kilobytes * 1024 : null;
    }
  }

  const client = {
    clientName: q, sourceName: [...sourceNames].join(', ') || null, policies: [...policiesSet],
    jobs7d, failed7d, jobs30d, failed30d, lastStatus, lastRunAt, lastSuccessAt, logicalBytes,
  };

  const cutoff14Ms = Date.now() - 14 * 86400000;
  const runs14d = jobs30
    .filter((j) => j.started_at && Date.parse(j.started_at) >= cutoff14Ms)
    .slice(0, 100)
    .map((j) => ({
      id: j.id, policyName: j.policy_name, jobType: j.job_type, scheduleType: j.schedule_type,
      state: j.state, statusCode: j.status_code, startedAt: j.started_at, endedAt: j.ended_at,
      elapsedSeconds: j.elapsed_seconds, kilobytes: j.kilobytes, clientName: j.client_name, sourceName: j.source_name,
    }));

  const byPolicy = new Map();
  for (const j of jobs30) {
    if (!j.policy_name) continue;
    let p = byPolicy.get(j.policy_name);
    if (!p) {
      p = { policyName: j.policy_name, jobCount30d: 0, failed30d: 0, lastRunAt: null, lastStatus: null };
      byPolicy.set(j.policy_name, p);
    }
    p.jobCount30d += 1;
    const failed = isFailedJob(j);
    if (failed) p.failed30d += 1;
    const runAt = j.ended_at || j.started_at;
    if (runAt && (!p.lastRunAt || runAt > p.lastRunAt)) {
      p.lastRunAt = runAt;
      p.lastStatus = failed ? 'failed' : (['EXITED', 'DONE'].includes(j.state) ? 'success' : (j.state || null));
    }
  }
  const policies = [...byPolicy.values()];

  const issues = db.prepare(`
    SELECT * FROM netbackup_issue_history WHERE target = ? AND status = 'open' ORDER BY last_seen DESC LIMIT 10
  `).all(q).map((i) => ({ type: i.type, severity: i.severity, message: i.message, target: i.target, createdAt: i.first_seen }));

  // Replication traceability: SLP-driven replication/duplication jobs run
  // under the SLP name in policy_name — surface them with start dates so
  // users can track a replica back to its job/SLP.
  const replication = jobs30
    .filter((j) => ['REPLICATION', 'DUPLICATION', 'REPLICA'].includes(String(j.job_type || '').toUpperCase()))
    .slice(0, 25)
    .map((j) => ({
      slpOrPolicy: j.policy_name, jobType: j.job_type, state: j.state, statusCode: j.status_code,
      startedAt: j.started_at, kilobytes: j.kilobytes, storageUnit: j.storage_unit, sourceName: j.source_name,
    }));

  res.json({ query: q, found: true, client, runs14d, policies, issues, replication });
}

// ── AI Advisor ───────────────────────────────────────────────────────────────

function advisorReportKey(slug) {
  return String(slug).replace(/-/g, '_');
}

/** GET /advisor/:report — cached NetBackup AI Advisor report. */
function handleGetAdvisor(req, res, coreApi) {
  const key = advisorReportKey(req.params.report);
  const advisor = netbackupAdvisor.get(coreApi);
  if (!advisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
  res.json({ enabled: advisor.isConfigured(), report: advisor.getCachedReport(key) });
}

/** POST /advisor/:report — (re)generate and cache a NetBackup AI Advisor report. */
async function handlePostAdvisor(req, res, coreApi) {
  const key = advisorReportKey(req.params.report);
  const advisor = netbackupAdvisor.get(coreApi);
  if (!advisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
  try {
    const result = await advisor.generateReport(key);
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

function compile(template) {
  const names = [];
  const pattern = template
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) { names.push(seg.slice(1)); return '([^/]+)'; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${pattern}$`), names };
}

const ROUTES = [
  { method: 'GET', ...compile('/sources'), handler: handleGetSources },
  { method: 'POST', ...compile('/sources'), handler: handlePostSources },
  { method: 'PUT', ...compile('/sources/:id'), handler: handlePutSource },
  { method: 'DELETE', ...compile('/sources/:id'), handler: handleDeleteSource },
  { method: 'POST', ...compile('/sources/test'), handler: handlePostSourcesTest },
  { method: 'POST', ...compile('/sources/:id/refresh'), handler: handlePostSourceRefresh },
  { method: 'GET', ...compile('/sources/:id/probe'), handler: handleGetSourceProbe },

  { method: 'GET', ...compile('/appliance-connections'), handler: handleGetApplianceConnections },
  { method: 'POST', ...compile('/appliance-connections'), handler: handlePostApplianceConnections },
  { method: 'PUT', ...compile('/appliance-connections/:id'), handler: handlePutApplianceConnection },
  { method: 'DELETE', ...compile('/appliance-connections/:id'), handler: handleDeleteApplianceConnection },
  { method: 'POST', ...compile('/appliance-connections/test'), handler: handlePostApplianceConnectionsTest },
  { method: 'POST', ...compile('/appliance-connections/:id/refresh'), handler: handlePostApplianceConnectionRefresh },
  { method: 'GET', ...compile('/appliance-connections/:id/probe'), handler: handleGetApplianceConnectionProbe },
  { method: 'GET', ...compile('/appliance-hardware'), handler: handleGetApplianceHardware },

  { method: 'GET', ...compile('/overview'), handler: handleGetOverview },
  { method: 'GET', ...compile('/jobs'), handler: handleGetJobs },
  { method: 'GET', ...compile('/policies'), handler: handleGetPolicies },
  { method: 'GET', ...compile('/policies/:id'), handler: handleGetPolicyDetail },
  { method: 'GET', ...compile('/storage'), handler: handleGetStorage },
  { method: 'GET', ...compile('/media-servers'), handler: handleGetMediaServers },
  { method: 'GET', ...compile('/appliances'), handler: handleGetAppliances },
  { method: 'PUT', ...compile('/appliances/model'), handler: handlePutApplianceModel },
  { method: 'GET', ...compile('/issues'), handler: handleGetIssues },
  { method: 'GET', ...compile('/issue-history'), handler: handleGetIssueHistory },
  { method: 'GET', ...compile('/trends'), handler: handleGetTrends },
  { method: 'GET', ...compile('/config'), handler: handleGetConfig },
  { method: 'PUT', ...compile('/config'), handler: handlePutConfig },

  { method: 'GET', ...compile('/slps'), handler: handleGetSlps },
  { method: 'GET', ...compile('/governance'), handler: handleGetGovernance },
  { method: 'GET', ...compile('/workloads'), handler: handleGetWorkloads },
  { method: 'GET', ...compile('/workloads/trends'), handler: handleGetWorkloadsTrends },
  { method: 'GET', ...compile('/licensing'), handler: handleGetLicensing },
  { method: 'GET', ...compile('/backup-history'), handler: handleGetBackupHistory },
  { method: 'GET', ...compile('/object-360/suggest'), handler: handleGetObject360Suggest },
  { method: 'GET', ...compile('/object-360'), handler: handleGetObject360 },
  { method: 'GET', ...compile('/advisor/:report'), handler: handleGetAdvisor },
  { method: 'POST', ...compile('/advisor/:report'), handler: handlePostAdvisor },
];

// createRouter must return a BARE (req, res, next) function — installed
// plugins are loaded via require() on their own dist/backend/index.cjs and
// cannot require the host's copy of express, so express Router instances
// are off the table. Matches req.method + req.path by hand against the
// table above; req.query/req.body are still parsed by the host's express
// pipeline before this middleware runs.
function createRouter(coreApi) {
  return function netbackupRouter(req, res, next) {
    const path = req.path.length > 1 && req.path.endsWith('/') ? req.path.slice(0, -1) : req.path;
    for (const route of ROUTES) {
      if (route.method !== req.method) continue;
      const m = route.regex.exec(path);
      if (!m) continue;
      const params = {};
      route.names.forEach((name, i) => { params[name] = m[i + 1]; });
      req.params = params;
      Promise.resolve(route.handler(req, res, coreApi)).catch(next);
      return;
    }
    next();
  };
}

module.exports = { createRouter };
