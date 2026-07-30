// NetBackup routes. Mounted by the plugin dispatcher at /api/netbackup —
// paths are relative. Two source types share one CRUD surface: a `primary`
// server (password or apikey auth) or an `alta` SaaS tenant (apikey only,
// host = full base URL). publicSource() never returns encrypted_credentials.
const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const db = require('../db/database');
const { encrypt } = require('../services/encryption');
const { setSetting, getSetting } = require('../services/settings');
const netbackupApi = require('../services/netbackupApi');
const { isDemo } = require('../services/demoMode');
const { netbackupPoller } = require('../services/netbackupPoller');
const netbackupAdvisor = require('../services/advisors/netbackupAdvisor');
const {
  successWarnPct, storageWarnPct, staleBackupHours, computeIssues,
} = require('../services/netbackupIssues');

const REPLICATION_TYPES = ['REPLICATION', 'REPLICA', 'DUPLICATE', 'DUPLICATION', 'IMPORT'];

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid parameters', details: errors.array() });
  next();
};

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

// ── Sources CRUD ─────────────────────────────────────────────────────────────

/** GET /api/netbackup/sources — registered sources (never the credentials). */
router.get('/sources', (req, res, next) => {
  try {
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
  } catch (err) { next(err); }
});

/** POST /api/netbackup/sources — register a primary server or Alta tenant. */
router.post('/sources', [
  body('name').isString().trim().notEmpty().isLength({ max: 120 }),
  body('sourceType').optional().isIn(['primary', 'alta']),
  body('host').isString().trim().notEmpty().isLength({ max: 253 }),
  body('port').optional().isInt({ min: 1, max: 65535 }).toInt(),
  body('authMode').optional().isIn(['password', 'apikey']),
  body('username').optional({ nullable: true }).isString().trim().isLength({ max: 256 }),
  body('domainName').optional({ nullable: true }).isString().trim().isLength({ max: 256 }),
  body('domainType').optional({ nullable: true }).isString().trim().isLength({ max: 64 }),
  body('password').optional({ nullable: true }).isString().isLength({ max: 512 }),
  body('apiKey').optional({ nullable: true }).isString().isLength({ max: 512 }),
  body('sslVerify').optional().isBoolean(),
  body('pollingIntervalMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
], validate, (req, res, next) => {
  try {
    const { name, host } = req.body;
    const sourceType = req.body.sourceType || 'primary';
    const authMode = req.body.authMode || 'password';
    const port = req.body.port || 1556;
    if (authMode === 'password' && !req.body.password) {
      return res.status(400).json({ error: 'password is required for password auth mode.' });
    }
    if (authMode === 'apikey' && !req.body.apiKey) {
      return res.status(400).json({ error: 'apiKey is required for apikey auth mode.' });
    }
    const dup = db.prepare('SELECT id FROM netbackup_sources WHERE name = ? OR (host = ? AND port = ?)')
      .get(name.trim(), host.trim(), port);
    if (dup) return res.status(409).json({ error: 'A NetBackup source with that name or host/port is already registered.' });
    const encrypted = encrypt(JSON.stringify(
      authMode === 'apikey' ? { apiKey: req.body.apiKey } : { password: req.body.password }
    ));
    const info = db.prepare(`
      INSERT INTO netbackup_sources (name, source_type, host, port, auth_mode, username, domain_name, domain_type,
        encrypted_credentials, ssl_verify, polling_interval_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name.trim(), sourceType, host.trim(), port, authMode,
      req.body.username?.trim() || null, req.body.domainName?.trim() || null, req.body.domainType?.trim() || null,
      encrypted, req.body.sslVerify ? 1 : 0, req.body.pollingIntervalMinutes || 15);
    const row = db.prepare('SELECT * FROM netbackup_sources WHERE id = ?').get(info.lastInsertRowid);
    netbackupPoller.schedule(row);
    netbackupPoller.trigger(row).catch(() => {});
    res.status(201).json({ source: publicSource(row) });
  } catch (err) { next(err); }
});

/** PUT /api/netbackup/sources/:id — update (credentials optional; blank keeps stored). */
router.put('/sources/:id', [
  param('id').isInt().toInt(),
  body('name').optional().isString().trim().notEmpty().isLength({ max: 120 }),
  body('sourceType').optional().isIn(['primary', 'alta']),
  body('host').optional().isString().trim().notEmpty().isLength({ max: 253 }),
  body('port').optional().isInt({ min: 1, max: 65535 }).toInt(),
  body('authMode').optional().isIn(['password', 'apikey']),
  body('username').optional({ nullable: true }).isString().trim().isLength({ max: 256 }),
  body('domainName').optional({ nullable: true }).isString().trim().isLength({ max: 256 }),
  body('domainType').optional({ nullable: true }).isString().trim().isLength({ max: 64 }),
  body('password').optional({ nullable: true }).isString().isLength({ max: 512 }),
  body('apiKey').optional({ nullable: true }).isString().isLength({ max: 512 }),
  body('sslVerify').optional().isBoolean(),
  body('pollingIntervalMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM netbackup_sources WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'NetBackup source not found.' });
    const b = req.body;
    const authMode = b.authMode || row.auth_mode;
    let encryptedCreds = row.encrypted_credentials;
    if (authMode === 'apikey' && b.apiKey) encryptedCreds = encrypt(JSON.stringify({ apiKey: b.apiKey }));
    else if (authMode === 'password' && b.password) encryptedCreds = encrypt(JSON.stringify({ password: b.password }));
    db.prepare(`
      UPDATE netbackup_sources SET
        name = ?, source_type = ?, host = ?, port = ?, auth_mode = ?, username = ?, domain_name = ?, domain_type = ?,
        encrypted_credentials = ?, ssl_verify = ?, polling_interval_minutes = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      b.name?.trim() || row.name, b.sourceType || row.source_type, b.host?.trim() || row.host,
      b.port || row.port, authMode,
      b.username !== undefined ? (b.username?.trim() || null) : row.username,
      b.domainName !== undefined ? (b.domainName?.trim() || null) : row.domain_name,
      b.domainType !== undefined ? (b.domainType?.trim() || null) : row.domain_type,
      encryptedCreds,
      b.sslVerify !== undefined ? (b.sslVerify ? 1 : 0) : row.ssl_verify,
      b.pollingIntervalMinutes || row.polling_interval_minutes,
      row.id
    );
    netbackupApi.invalidateSession(row.id);
    const updated = db.prepare('SELECT * FROM netbackup_sources WHERE id = ?').get(row.id);
    netbackupPoller.schedule(updated);
    res.json({ source: publicSource(updated) });
  } catch (err) { next(err); }
});

/** DELETE /api/netbackup/sources/:id — unregister (CASCADE clears inventory). */
router.delete('/sources/:id', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM netbackup_sources WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'NetBackup source not found.' });
    netbackupPoller.cancel(row.id);
    netbackupApi.invalidateSession(row.id);
    db.prepare('DELETE FROM netbackup_sources WHERE id = ?').run(row.id);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

/** POST /api/netbackup/sources/test — validate a saved source ({id}) or a candidate. */
router.post('/sources/test', [
  body('id').optional().isInt().toInt(),
  body('sourceType').optional().isIn(['primary', 'alta']),
  body('host').optional().isString().trim(),
  body('port').optional().isInt({ min: 1, max: 65535 }).toInt(),
  body('authMode').optional().isIn(['password', 'apikey']),
  body('username').optional({ nullable: true }).isString(),
  body('domainName').optional({ nullable: true }).isString(),
  body('domainType').optional({ nullable: true }).isString(),
  body('password').optional({ nullable: true }).isString(),
  body('apiKey').optional({ nullable: true }).isString(),
  body('sslVerify').optional().isBoolean(),
], validate, async (req, res) => {
  const b = req.body;
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
  const result = await netbackupApi.testConnection(candidate);
  res.status(result.ok ? 200 : 502).json(result);
});

/** POST /api/netbackup/sources/:id/refresh — poll this source now. */
router.post('/sources/:id/refresh', [param('id').isInt().toInt()], validate, async (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM netbackup_sources WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'NetBackup source not found.' });
    await netbackupPoller.trigger(row);
    res.json({ triggered: true });
  } catch (err) { next(err); }
});

/** GET /api/netbackup/sources/:id/probe — raw-shape probe (the blind-build fix loop). */
router.get('/sources/:id/probe', [param('id').isInt().toInt()], validate, async (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM netbackup_sources WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'NetBackup source not found.' });
    res.json(await netbackupApi.fetchProbe(row));
  } catch (err) { next(err); }
});

// ── Data endpoints ───────────────────────────────────────────────────────────

/** GET /api/netbackup/overview — estate rollup + computed issues. */
router.get('/overview', (req, res, next) => {
  try {
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
        mediaServerCount, applianceCount, openIssues: computeIssues().length,
      },
      jobsByState, jobsByPolicyType, recentFailedJobs, catalog,
    });
  } catch (err) { next(err); }
});

/** GET /api/netbackup/jobs?days=7&state=&sourceId= */
router.get('/jobs', [
  query('days').optional().isInt({ min: 1, max: 30 }).toInt(),
  query('state').optional().isString(),
  query('sourceId').optional().isInt().toInt(),
], validate, (req, res, next) => {
  try {
    const days = req.query.days || 7;
    const clauses = ["j.started_at >= datetime('now', ?)"];
    const params = [`-${days} days`];
    if (req.query.state) { clauses.push('j.state = ?'); params.push(req.query.state); }
    if (req.query.sourceId) { clauses.push('j.source_id = ?'); params.push(req.query.sourceId); }
    const rows = db.prepare(`
      SELECT j.*, s.name AS source_name FROM netbackup_jobs j
      JOIN netbackup_sources s ON s.id = j.source_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY j.started_at DESC LIMIT 2000
    `).all(...params);
    res.json({ jobs: rows.map(mapJobRow) });
  } catch (err) { next(err); }
});

/** GET /api/netbackup/policies */
router.get('/policies', (req, res, next) => {
  try {
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
  } catch (err) { next(err); }
});

/** GET /api/netbackup/policies/:id — stored policy detail (clients/schedules/selections). */
router.get('/policies/:id', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const p = db.prepare(`
      SELECT p.*, s.name AS source_name FROM netbackup_policies p
      JOIN netbackup_sources s ON s.id = p.source_id WHERE p.id = ?
    `).get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Policy not found.' });
    let detail = { clients: [], schedules: [], selections: [] };
    try { detail = { ...detail, ...JSON.parse(p.detail_json || '{}') }; } catch { /* pre-v4 row */ }
    // Upstream shapes vary: clients/selections may be strings or objects,
    // schedules strings or {scheduleName, scheduleType, frequencySeconds}.
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
  } catch (err) { next(err); }
});

/** GET /api/netbackup/storage */
router.get('/storage', (req, res, next) => {
  try {
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
  } catch (err) { next(err); }
});

/** GET /api/netbackup/media-servers */
router.get('/media-servers', (req, res, next) => {
  try {
    res.json({
      mediaServers: db.prepare(`
        SELECT m.*, s.name AS source_name FROM netbackup_media_servers m
        JOIN netbackup_sources s ON s.id = m.source_id ORDER BY s.name, m.name
      `).all().map((m) => ({
        id: m.id, sourceId: m.source_id, sourceName: m.source_name,
        name: m.name, state: m.state, version: m.version,
      })),
    });
  } catch (err) { next(err); }
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

/** GET /api/netbackup/appliances */
router.get('/appliances', (req, res, next) => {
  try {
    res.json({
      appliances: db.prepare(`
        SELECT a.*, s.name AS source_name, o.model_override AS model_override
        FROM netbackup_appliances a
        JOIN netbackup_sources s ON s.id = a.source_id
        LEFT JOIN netbackup_appliance_overrides o ON o.source_id = a.source_id AND o.name = a.name
        ORDER BY s.name, a.name
      `).all().map(mapApplianceRow),
    });
  } catch (err) { next(err); }
});

/** PUT /api/netbackup/appliances/model — set/clear a per-appliance model override. */
router.put('/appliances/model', [
  body('sourceId').isInt().toInt(),
  body('name').isString().trim().notEmpty().isLength({ max: 200 }),
  body('model').optional({ nullable: true }).isString().isLength({ max: 120 }),
], validate, (req, res, next) => {
  try {
    const { sourceId, name } = req.body;
    const model = (req.body.model ?? '').trim();

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
  } catch (err) { next(err); }
});

/** GET /api/netbackup/issues — computed issues (live). */
router.get('/issues', (req, res, next) => {
  try {
    const sourceNames = new Map(db.prepare('SELECT id, name FROM netbackup_sources').all().map((s) => [s.id, s.name]));
    res.json({
      issues: computeIssues().map((i) => ({
        issueKey: i.issue_key, severity: i.severity, message: i.message, host: i.host,
        source: i.source, type: i.type, target: i.target,
        sourceId: i.source_id ?? null, sourceName: i.source_id != null ? (sourceNames.get(i.source_id) ?? null) : null,
      })),
    });
  } catch (err) { next(err); }
});

/** GET /api/netbackup/issue-history?days= — detected-issue lifecycle (open first). */
router.get('/issue-history', [query('days').optional().isInt({ min: 1, max: 90 }).toInt()], validate, (req, res, next) => {
  try {
    const days = req.query.days || 30;
    res.json(db.prepare(`
      SELECT * FROM netbackup_issue_history
      WHERE status = 'open' OR last_seen >= datetime('now', ?)
      ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, last_seen DESC
    `).all(`-${days} days`));
  } catch (err) { next(err); }
});

/** GET /api/netbackup/trends?days=30&sourceId= */
router.get('/trends', [
  query('days').optional().isInt({ min: 1, max: 365 }).toInt(),
  query('sourceId').optional().isInt().toInt(),
], validate, (req, res, next) => {
  try {
    const days = req.query.days || 30;
    const clauses = ["m.captured_at >= datetime('now', ?)"];
    const params = [`-${days} days`];
    if (req.query.sourceId) { clauses.push('m.source_id = ?'); params.push(req.query.sourceId); }
    const rows = db.prepare(`
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
  } catch (err) { next(err); }
});

function entitledTb() {
  return Number(getSetting('netbackup_entitled_tb')) || 0;
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

/** GET /api/netbackup/config — alert thresholds + licensing entitlement. */
router.get('/config', (req, res, next) => {
  try {
    res.json({
      successWarnPct: successWarnPct(), storageWarnPct: storageWarnPct(), staleBackupHours: staleBackupHours(),
      entitledTb: entitledTb(),
    });
  } catch (err) { next(err); }
});

/** PUT /api/netbackup/config — save alert thresholds + licensing entitlement. */
router.put('/config', [
  body('successWarnPct').isInt({ min: 50, max: 100 }).toInt(),
  body('storageWarnPct').isInt({ min: 5, max: 50 }).toInt(),
  body('staleBackupHours').isInt({ min: 12, max: 336 }).toInt(),
  body('entitledTb').optional().isFloat({ min: 0, max: 100000 }).toFloat(),
], validate, (req, res, next) => {
  try {
    setSetting('netbackup_success_warn_pct', String(req.body.successWarnPct));
    setSetting('netbackup_storage_warn_pct', String(req.body.storageWarnPct));
    setSetting('netbackup_stale_backup_hours', String(req.body.staleBackupHours));
    if (req.body.entitledTb !== undefined) setSetting('netbackup_entitled_tb', String(req.body.entitledTb));
    res.json({
      successWarnPct: successWarnPct(), storageWarnPct: storageWarnPct(), staleBackupHours: staleBackupHours(),
      entitledTb: entitledTb(),
    });
  } catch (err) { next(err); }
});

// ── SLP / Replication ────────────────────────────────────────────────────────

/** GET /api/netbackup/slps — SLP definitions + replication/duplication job stats. */
router.get('/slps', (req, res, next) => {
  try {
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
  } catch (err) { next(err); }
});

// ── Governance ───────────────────────────────────────────────────────────────

/** GET /api/netbackup/governance — inactive/idle policies, unprotected clients, catalog, version drift. */
router.get('/governance', (req, res, next) => {
  try {
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

    const staleHours = staleBackupHours();
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
  } catch (err) { next(err); }
});

// ── Workloads ────────────────────────────────────────────────────────────────

/** GET /api/netbackup/workloads — latest per-source-per-workload snapshot + estate/domain rollups. */
router.get('/workloads', (req, res, next) => {
  try {
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
  } catch (err) { next(err); }
});

/** GET /api/netbackup/workloads/trends?days=90&sourceId=&workload= */
router.get('/workloads/trends', [
  query('days').optional().isInt({ min: 7, max: 400 }).toInt(),
  query('sourceId').optional().isInt().toInt(),
  query('workload').optional().isString(),
], validate, (req, res, next) => {
  try {
    const days = req.query.days || 90;
    const sourceId = req.query.sourceId ?? null;
    const workload = req.query.workload ?? null;
    const rows = db.prepare(`
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
  } catch (err) { next(err); }
});

// ── Licensing ────────────────────────────────────────────────────────────────

/** GET /api/netbackup/licensing — computed FETB by workload/domain + entitlement + upstream (if reachable). */
router.get('/licensing', async (req, res, next) => {
  try {
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

    const entitled = entitledTb();

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
        try { raw = await netbackupApi.fetchLicensing(altaSource); } catch { raw = null; }
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
  } catch (err) { next(err); }
});

// ── Backup History ───────────────────────────────────────────────────────────

function mapRunStatus(state, statusCode) {
  if (state === 'ACTIVE' || state === 'QUEUED') return 'kRunning';
  const failed = state === 'FAILED' || (['EXITED', 'DONE'].includes(state) && Number(statusCode || 0) > 0);
  return failed ? 'kFailure' : 'kSuccess';
}

/** GET /api/netbackup/backup-history?q=&days= — per-client day-by-day bubble matrix data, all from netbackup_jobs. */
router.get('/backup-history', [
  query('q').optional().isString().trim().isLength({ max: 200 }),
  query('days').optional().isInt({ min: 1, max: 31 }).toInt(),
], validate, (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const days = Math.min(req.query.days || 30, 31);
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
  } catch (err) { next(err); }
});

// ── AI Advisor ───────────────────────────────────────────────────────────────

function advisorReportKey(slug) {
  return String(slug).replace(/-/g, '_');
}

/** GET /api/netbackup/advisor/:report — cached NetBackup AI Advisor report. */
router.get('/advisor/:report', [param('report').isString()], validate, (req, res, next) => {
  try {
    const key = advisorReportKey(req.params.report);
    if (!netbackupAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
    res.json({ enabled: netbackupAdvisor.isConfigured(), report: netbackupAdvisor.getCachedReport(key) });
  } catch (err) { next(err); }
});

/** POST /api/netbackup/advisor/:report — (re)generate and cache a NetBackup AI Advisor report. */
router.post('/advisor/:report', [param('report').isString()], validate, async (req, res, next) => {
  try {
    const key = advisorReportKey(req.params.report);
    if (!netbackupAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
    const result = await netbackupAdvisor.generateReport(key);
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
