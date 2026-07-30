// NetBackup routes. Mounted by the plugin dispatcher at /api/netbackup —
// paths are relative. Two source types share one CRUD surface: a `primary`
// server (password or apikey auth) or an `alta` SaaS tenant (apikey only,
// host = full base URL). publicSource() never returns encrypted_credentials.
const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const db = require('../db/database');
const { encrypt } = require('../services/encryption');
const { setSetting } = require('../services/settings');
const netbackupApi = require('../services/netbackupApi');
const { netbackupPoller } = require('../services/netbackupPoller');
const {
  successWarnPct, storageWarnPct, staleBackupHours, computeIssues,
} = require('../services/netbackupIssues');

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
      jobsByState, jobsByPolicyType, recentFailedJobs,
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

/** GET /api/netbackup/appliances */
router.get('/appliances', (req, res, next) => {
  try {
    res.json({
      appliances: db.prepare(`
        SELECT a.*, s.name AS source_name FROM netbackup_appliances a
        JOIN netbackup_sources s ON s.id = a.source_id ORDER BY s.name, a.name
      `).all().map((a) => ({
        id: a.id, sourceId: a.source_id, sourceName: a.source_name, name: a.name,
        hostType: a.host_type, applianceType: a.appliance_type, model: a.model,
        serialNumber: a.serial_number, osType: a.os_type, osVersion: a.os_version,
        cpuArchitecture: a.cpu_architecture, nbuVersion: a.nbu_version,
      })),
    });
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

/** GET /api/netbackup/config — alert thresholds. */
router.get('/config', (req, res, next) => {
  try {
    res.json({ successWarnPct: successWarnPct(), storageWarnPct: storageWarnPct(), staleBackupHours: staleBackupHours() });
  } catch (err) { next(err); }
});

/** PUT /api/netbackup/config — save alert thresholds. */
router.put('/config', [
  body('successWarnPct').isInt({ min: 50, max: 100 }).toInt(),
  body('storageWarnPct').isInt({ min: 5, max: 50 }).toInt(),
  body('staleBackupHours').isInt({ min: 12, max: 336 }).toInt(),
], validate, (req, res, next) => {
  try {
    setSetting('netbackup_success_warn_pct', String(req.body.successWarnPct));
    setSetting('netbackup_storage_warn_pct', String(req.body.storageWarnPct));
    setSetting('netbackup_stale_backup_hours', String(req.body.staleBackupHours));
    res.json({ successWarnPct: successWarnPct(), storageWarnPct: storageWarnPct(), staleBackupHours: staleBackupHours() });
  } catch (err) { next(err); }
});

module.exports = router;
