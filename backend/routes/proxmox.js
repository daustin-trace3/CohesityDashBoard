// Proxmox VE routes. Mounted by the plugin dispatcher at /api/proxmox — paths
// are relative. Registration CRUD stores tokenSecret AES-encrypted; all
// responses are camelCase.
const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const db = require('../db/database');
const { encrypt, decrypt } = require('../services/encryption');
const { setSetting } = require('../services/settings');
const proxmoxApi = require('../services/proxmoxApi');
const { proxmoxPoller } = require('../services/proxmoxPoller');
const {
  storageWarnPct, storageCritPct, backupStaleDays, certWarnDays, computeIssues,
} = require('../services/proxmoxIssues');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid parameters', details: errors.array() });
  next();
};

const publicServer = (row) => ({
  id: row.id, name: row.name, host: row.host, port: row.port,
  sslVerify: !!row.ssl_verify, pollingIntervalMinutes: row.polling_interval_minutes,
  lastPollStatus: row.last_poll_status, lastPollError: row.last_poll_error, lastPollAt: row.last_poll_at,
  tokenId: row.token_id, hasCredentials: !!row.encrypted_credentials,
});

// ── Servers CRUD ─────────────────────────────────────────────────────────────

/** GET /api/proxmox/servers — registered servers (never the secret). */
router.get('/servers', (req, res, next) => {
  try {
    res.json(db.prepare('SELECT * FROM proxmox_servers ORDER BY name').all().map(publicServer));
  } catch (err) { next(err); }
});

/** POST /api/proxmox/servers — register a server. */
router.post('/servers', [
  body('name').isString().trim().notEmpty().isLength({ max: 120 }),
  body('host').isString().trim().notEmpty().isLength({ max: 253 }),
  body('port').optional().isInt({ min: 1, max: 65535 }).toInt(),
  body('tokenId').isString().trim().notEmpty().isLength({ max: 256 }),
  body('tokenSecret').isString().notEmpty().isLength({ max: 256 }),
  body('sslVerify').optional().isBoolean(),
  body('pollingIntervalMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
], validate, (req, res, next) => {
  try {
    const { name, host, tokenId, tokenSecret, sslVerify, pollingIntervalMinutes } = req.body;
    const port = req.body.port || 8006;
    const dup = db.prepare('SELECT id FROM proxmox_servers WHERE name = ? OR (host = ? AND port = ?)')
      .get(name.trim(), host.trim(), port);
    if (dup) return res.status(409).json({ error: 'A Proxmox server with that name or host+port is already registered.' });
    const info = db.prepare(`
      INSERT INTO proxmox_servers (name, host, port, token_id, encrypted_credentials, ssl_verify, polling_interval_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(name.trim(), host.trim(), port, tokenId.trim(),
      encrypt(JSON.stringify({ tokenSecret })), sslVerify ? 1 : 0, pollingIntervalMinutes || 10);
    const row = db.prepare('SELECT * FROM proxmox_servers WHERE id = ?').get(info.lastInsertRowid);
    proxmoxPoller.schedule(row);
    proxmoxPoller.trigger(row).catch(() => {});
    res.status(201).json(publicServer(row));
  } catch (err) { next(err); }
});

/** PUT /api/proxmox/servers/:id — update (tokenSecret optional; blank keeps stored). */
router.put('/servers/:id', [
  param('id').isInt().toInt(),
  body('name').optional().isString().trim().notEmpty().isLength({ max: 120 }),
  body('host').optional().isString().trim().notEmpty().isLength({ max: 253 }),
  body('port').optional().isInt({ min: 1, max: 65535 }).toInt(),
  body('tokenId').optional().isString().trim().notEmpty().isLength({ max: 256 }),
  body('tokenSecret').optional().isString().isLength({ max: 256 }),
  body('sslVerify').optional().isBoolean(),
  body('pollingIntervalMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM proxmox_servers WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Proxmox server not found.' });
    const b = req.body;
    db.prepare(`
      UPDATE proxmox_servers SET
        name = ?, host = ?, port = ?, token_id = ?, encrypted_credentials = ?,
        ssl_verify = ?, polling_interval_minutes = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      b.name?.trim() || row.name, b.host?.trim() || row.host, b.port || row.port,
      b.tokenId?.trim() || row.token_id,
      b.tokenSecret ? encrypt(JSON.stringify({ tokenSecret: b.tokenSecret })) : row.encrypted_credentials,
      b.sslVerify !== undefined ? (b.sslVerify ? 1 : 0) : row.ssl_verify,
      b.pollingIntervalMinutes || row.polling_interval_minutes,
      row.id
    );
    const updated = db.prepare('SELECT * FROM proxmox_servers WHERE id = ?').get(row.id);
    proxmoxPoller.schedule(updated);
    res.json(publicServer(updated));
  } catch (err) { next(err); }
});

/** DELETE /api/proxmox/servers/:id — unregister (CASCADE clears inventory). */
router.delete('/servers/:id', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM proxmox_servers WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Proxmox server not found.' });
    proxmoxPoller.cancel(row.id);
    db.prepare('DELETE FROM proxmox_servers WHERE id = ?').run(row.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/** POST /api/proxmox/servers/test — validate saved or candidate credentials. */
router.post('/servers/test', [
  body('id').optional().isInt().toInt(),
  body('host').isString().trim().notEmpty(),
  body('port').optional().isInt({ min: 1, max: 65535 }).toInt(),
  body('tokenId').isString().trim().notEmpty(),
  body('tokenSecret').optional().isString(),
  body('sslVerify').optional().isBoolean(),
], validate, async (req, res) => {
  const { id, host, port, tokenId, tokenSecret, sslVerify } = req.body;
  let candidate = { host: host.trim(), port: port || 8006, tokenId: tokenId.trim(), tokenSecret, sslVerify: sslVerify ? 1 : 0 };
  if (!tokenSecret && id) {
    const row = db.prepare('SELECT * FROM proxmox_servers WHERE id = ?').get(id);
    if (row && row.encrypted_credentials) {
      const c = JSON.parse(decrypt(row.encrypted_credentials));
      candidate.tokenSecret = c.tokenSecret;
    }
  }
  const result = await proxmoxApi.testConnection(candidate);
  res.status(result.ok ? 200 : 502).json(result);
});

/** POST /api/proxmox/servers/:id/refresh — poll this server now. */
router.post('/servers/:id/refresh', [param('id').isInt().toInt()], validate, async (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM proxmox_servers WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Proxmox server not found.' });
    await proxmoxPoller.trigger(row);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Probe (blind-build fix loop) ─────────────────────────────────────────────

const PROBE_SECTIONS = [
  'version', 'nodes', 'resources', 'guests', 'storage', 'tasks', 'backup', 'cluster', 'certificates', 'subscription',
];

function truncateArr(raw) {
  if (Array.isArray(raw)) return { items: raw.slice(0, 3), count: raw.length };
  return raw;
}

/** GET /api/proxmox/servers/:id/probe?sections=version,nodes,... — raw-shape probe. */
router.get('/servers/:id/probe', [
  param('id').isInt().toInt(),
], validate, async (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM proxmox_servers WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Proxmox server not found.' });
    if (row.encrypted_credentials) {
      const c = JSON.parse(decrypt(row.encrypted_credentials));
      row.tokenSecret = c.tokenSecret;
    }
    row.tokenId = row.token_id;
    row.sslVerify = row.ssl_verify;

    const requested = req.query.sections
      ? String(req.query.sections).split(',').map((s) => s.trim()).filter(Boolean)
      : PROBE_SECTIONS;

    const nodes = await proxmoxApi.fetchNodes(row);
    const firstNode = nodes[0]?.node;
    const out = {};

    async function section(name, fn) {
      if (!requested.includes(name)) return;
      try {
        const data = await fn();
        out[name] = { status: 'ok', ...truncateArr(data) };
      } catch (err) {
        out[name] = { status: 'error', error: err.pveForbidden ? 'forbidden' : (err.message || String(err)) };
      }
    }

    await section('version', () => proxmoxApi.fetchVersion(row));
    await section('nodes', () => nodes);
    await section('resources', () => proxmoxApi.fetchClusterResources(row));
    if (firstNode) {
      await section('guests', async () => ({
        qemu: await proxmoxApi.fetchQemu(row, firstNode),
        lxc: await proxmoxApi.fetchLxc(row, firstNode),
      }));
      await section('storage', () => proxmoxApi.fetchNodeStorage(row, firstNode));
      await section('tasks', () => proxmoxApi.fetchTasks(row, firstNode, 10));
      await section('certificates', () => proxmoxApi.fetchCertificates(row, firstNode));
      await section('subscription', () => proxmoxApi.fetchSubscription(row, firstNode));
    }
    await section('backup', () => proxmoxApi.fetchClusterBackup(row));
    await section('cluster', () => proxmoxApi.fetchClusterStatus(row));

    res.json(out);
  } catch (err) { next(err); }
});

// ── Config ───────────────────────────────────────────────────────────────────

/** GET /api/proxmox/config — alert thresholds. */
router.get('/config', (req, res, next) => {
  try {
    res.json({
      storageWarnPct: storageWarnPct(), storageCritPct: storageCritPct(),
      backupStaleDays: backupStaleDays(), certWarnDays: certWarnDays(),
    });
  } catch (err) { next(err); }
});

/** PUT /api/proxmox/config — save alert thresholds. */
router.put('/config', [
  body('storageWarnPct').isInt({ min: 1, max: 100 }).toInt(),
  body('storageCritPct').isInt({ min: 1, max: 100 }).toInt(),
  body('backupStaleDays').isInt({ min: 1, max: 365 }).toInt(),
  body('certWarnDays').isInt({ min: 1, max: 365 }).toInt(),
], validate, (req, res, next) => {
  try {
    setSetting('proxmox_storage_warn_pct', String(req.body.storageWarnPct));
    setSetting('proxmox_storage_crit_pct', String(req.body.storageCritPct));
    setSetting('proxmox_backup_stale_days', String(req.body.backupStaleDays));
    setSetting('proxmox_cert_warn_days', String(req.body.certWarnDays));
    res.json({
      storageWarnPct: storageWarnPct(), storageCritPct: storageCritPct(),
      backupStaleDays: backupStaleDays(), certWarnDays: certWarnDays(),
    });
  } catch (err) { next(err); }
});

// ── Issues ───────────────────────────────────────────────────────────────────

/** GET /api/proxmox/issues — computed issues alone (Alerts page). */
router.get('/issues', (req, res, next) => {
  try {
    res.json(computeIssues());
  } catch (err) { next(err); }
});

/** GET /api/proxmox/issue-history?days= — bare array, issue lifecycle rows. */
router.get('/issue-history', (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    const rows = db.prepare(`
      SELECT * FROM proxmox_issue_history
      WHERE status = 'open' OR last_seen >= datetime('now', ?)
      ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, last_seen DESC
    `).all(`-${days} days`);
    res.json(rows.map((r) => ({
      id: r.id, issueKey: r.issue_key, source: r.source, sourceId: r.source_id,
      severity: r.severity, type: r.type, target: r.target, message: r.message, status: r.status,
      firstSeen: r.first_seen, lastSeen: r.last_seen, resolvedAt: r.resolved_at,
    })));
  } catch (err) { next(err); }
});

// ── Overview ─────────────────────────────────────────────────────────────────

/** GET /api/proxmox/overview — fleet rollup + computed issue counts. */
router.get('/overview', (req, res, next) => {
  try {
    const servers = db.prepare('SELECT * FROM proxmox_servers ORDER BY name').all();
    const nodeAgg = db.prepare(`
      SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) AS online
      FROM proxmox_nodes
    `).get();
    const guestAgg = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
        COUNT(*) AS total,
        SUM(CASE WHEN type = 'qemu' AND is_template = 0 THEN 1 ELSE 0 END) AS vms,
        SUM(CASE WHEN type = 'lxc' AND is_template = 0 THEN 1 ELSE 0 END) AS containers,
        SUM(CASE WHEN is_template = 1 THEN 1 ELSE 0 END) AS templates
      FROM proxmox_guests
    `).get();
    const storageAgg = db.prepare(`
      SELECT COUNT(*) AS pools, SUM(used_bytes) AS usedBytes, SUM(total_bytes) AS totalBytes
      FROM proxmox_storage
    `).get();
    const issues = computeIssues();
    res.json({
      servers: servers.map((s) => ({
        id: s.id, name: s.name, host: s.host, status: s.last_poll_status, lastPollAt: s.last_poll_at,
        pveVersion: db.prepare('SELECT pve_version FROM proxmox_nodes WHERE server_id = ? LIMIT 1').get(s.id)?.pve_version ?? null,
      })),
      totals: {
        nodes: nodeAgg.total || 0, nodesOnline: nodeAgg.online || 0,
        guests: guestAgg.total || 0, guestsRunning: guestAgg.running || 0,
        vms: guestAgg.vms || 0, containers: guestAgg.containers || 0, templates: guestAgg.templates || 0,
        storagePools: storageAgg.pools || 0,
        storageUsedBytes: storageAgg.usedBytes || 0, storageTotalBytes: storageAgg.totalBytes || 0,
        openIssues: issues.length, criticalIssues: issues.filter((i) => i.severity === 'critical').length,
      },
    });
  } catch (err) { next(err); }
});

// ── Data endpoints ───────────────────────────────────────────────────────────

/** GET /api/proxmox/nodes — nodes across all servers. */
router.get('/nodes', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT n.*, s.name AS server_name FROM proxmox_nodes n JOIN proxmox_servers s ON s.id = n.server_id
      ORDER BY s.name, n.name
    `).all();
    res.json(rows.map((r) => ({
      id: r.id, serverId: r.server_id, serverName: r.server_name, name: r.name, status: r.status,
      cpuUsage: r.cpu_usage, cpuTotal: r.cpu_total, memUsed: r.mem_used, memTotal: r.mem_total,
      diskUsed: r.disk_used, diskTotal: r.disk_total, uptimeSeconds: r.uptime_seconds, loadAvg: r.load_avg,
      pveVersion: r.pve_version, kernelVersion: r.kernel_version, certExpiresAt: r.cert_expires_at,
      subscriptionStatus: r.subscription_status, updatesAvailable: r.updates_available, updatedAt: r.updated_at,
    })));
  } catch (err) { next(err); }
});

/** GET /api/proxmox/guests?type=&status=&serverId= — merged VM/LXC inventory. */
router.get('/guests', [
  query('type').optional().isIn(['qemu', 'lxc']),
  query('status').optional().isString(),
  query('serverId').optional().isInt().toInt(),
], validate, (req, res, next) => {
  try {
    const clauses = [];
    const params = [];
    if (req.query.type) { clauses.push('g.type = ?'); params.push(req.query.type); }
    if (req.query.status) { clauses.push('g.status = ?'); params.push(req.query.status); }
    if (req.query.serverId) { clauses.push('g.server_id = ?'); params.push(req.query.serverId); }
    const rows = db.prepare(`
      SELECT g.*, s.name AS server_name FROM proxmox_guests g JOIN proxmox_servers s ON s.id = g.server_id
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY s.name, g.name
    `).all(...params);
    res.json(rows.map((r) => ({
      id: r.id, serverId: r.server_id, serverName: r.server_name, vmid: r.vmid, name: r.name, type: r.type,
      node: r.node, status: r.status, isTemplate: !!r.is_template, cpuCount: r.cpu_count, cpuUsage: r.cpu_usage,
      memUsed: r.mem_used, memTotal: r.mem_total, diskUsed: r.disk_used, diskTotal: r.disk_total,
      uptimeSeconds: r.uptime_seconds, netIn: r.net_in, netOut: r.net_out, pool: r.pool,
      tags: r.tags ? JSON.parse(r.tags) : null, lastBackupAt: r.last_backup_at, lastBackupStatus: r.last_backup_status,
      updatedAt: r.updated_at,
    })));
  } catch (err) { next(err); }
});

/** GET /api/proxmox/storage — storage pools across all servers. */
router.get('/storage', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT st.*, s.name AS server_name FROM proxmox_storage st JOIN proxmox_servers s ON s.id = st.server_id
      ORDER BY s.name, st.node, st.storage
    `).all();
    res.json(rows.map((r) => ({
      id: r.id, serverId: r.server_id, serverName: r.server_name, node: r.node, storage: r.storage,
      type: r.type, content: r.content, active: !!r.active, shared: !!r.shared,
      usedBytes: r.used_bytes, totalBytes: r.total_bytes, availBytes: r.avail_bytes, updatedAt: r.updated_at,
    })));
  } catch (err) { next(err); }
});

/** GET /api/proxmox/backups — backup jobs + recent vzdump task outcomes. */
router.get('/backups', (req, res, next) => {
  try {
    const jobs = db.prepare(`
      SELECT j.*, s.name AS server_name FROM proxmox_backup_jobs j JOIN proxmox_servers s ON s.id = j.server_id
      ORDER BY s.name, j.job_id
    `).all();
    const recentTasks = db.prepare(`
      SELECT t.*, s.name AS server_name FROM proxmox_tasks t JOIN proxmox_servers s ON s.id = t.server_id
      WHERE t.type = 'vzdump' ORDER BY t.started_at DESC LIMIT 100
    `).all();
    res.json({
      jobs: jobs.map((j) => ({
        id: j.id, serverId: j.server_id, serverName: j.server_name, jobId: j.job_id, enabled: !!j.enabled,
        schedule: j.schedule, storage: j.storage, mode: j.mode, compress: j.compress,
        selection: j.selection, nextRun: j.next_run,
      })),
      recentTasks: recentTasks.map((t) => ({
        id: t.id, serverId: t.server_id, serverName: t.server_name, upid: t.upid, node: t.node,
        target: t.target, status: t.status, startedAt: t.started_at, endedAt: t.ended_at,
      })),
    });
  } catch (err) { next(err); }
});

/** GET /api/proxmox/tasks?limit= — task rows, newest first. */
router.get('/tasks', [query('limit').optional().isInt({ min: 1, max: 1000 }).toInt()], validate, (req, res, next) => {
  try {
    const limit = req.query.limit || 200;
    const rows = db.prepare(`
      SELECT t.*, s.name AS server_name FROM proxmox_tasks t JOIN proxmox_servers s ON s.id = t.server_id
      ORDER BY t.started_at DESC LIMIT ?
    `).all(limit);
    res.json(rows.map((t) => ({
      id: t.id, serverId: t.server_id, serverName: t.server_name, upid: t.upid, node: t.node, type: t.type,
      target: t.target, user: t.user, status: t.status, startedAt: t.started_at, endedAt: t.ended_at,
    })));
  } catch (err) { next(err); }
});

/** GET /api/proxmox/metrics-history?serverId=&hours=24 */
router.get('/metrics-history', [
  query('serverId').optional().isInt().toInt(),
  query('hours').optional().isInt({ min: 1, max: 720 }).toInt(),
], validate, (req, res, next) => {
  try {
    const hours = req.query.hours || 24;
    const clauses = [`captured_at >= datetime('now', ?)`];
    const params = [`-${hours} hours`];
    if (req.query.serverId) { clauses.push('server_id = ?'); params.push(req.query.serverId); }
    const rows = db.prepare(`
      SELECT * FROM proxmox_metrics WHERE ${clauses.join(' AND ')} ORDER BY captured_at
    `).all(...params);
    res.json(rows.map((r) => ({
      node: r.node, capturedAt: r.captured_at, cpuUsage: r.cpu_usage, memUsed: r.mem_used, memTotal: r.mem_total,
      storageUsed: r.storage_used, storageTotal: r.storage_total,
    })));
  } catch (err) { next(err); }
});

module.exports = router;
