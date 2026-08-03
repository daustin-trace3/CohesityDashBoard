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
  storageWarnPct, storageCritPct, backupStaleDays, certWarnDays, snapshotAgeDays, computeIssues,
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
      snapshotAgeDays: snapshotAgeDays(),
    });
  } catch (err) { next(err); }
});

/** PUT /api/proxmox/config — save alert thresholds. */
router.put('/config', [
  body('storageWarnPct').isInt({ min: 1, max: 100 }).toInt(),
  body('storageCritPct').isInt({ min: 1, max: 100 }).toInt(),
  body('backupStaleDays').isInt({ min: 1, max: 365 }).toInt(),
  body('certWarnDays').isInt({ min: 1, max: 365 }).toInt(),
  body('snapshotAgeDays').isInt({ min: 1, max: 365 }).toInt(),
], validate, (req, res, next) => {
  try {
    setSetting('proxmox_storage_warn_pct', String(req.body.storageWarnPct));
    setSetting('proxmox_storage_crit_pct', String(req.body.storageCritPct));
    setSetting('proxmox_backup_stale_days', String(req.body.backupStaleDays));
    setSetting('proxmox_cert_warn_days', String(req.body.certWarnDays));
    setSetting('proxmox_snapshot_age_days', String(req.body.snapshotAgeDays));
    res.json({
      storageWarnPct: storageWarnPct(), storageCritPct: storageCritPct(),
      backupStaleDays: backupStaleDays(), certWarnDays: certWarnDays(),
      snapshotAgeDays: snapshotAgeDays(),
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
      osName: r.os_name, ipAddresses: r.ip_addresses ? JSON.parse(r.ip_addresses) : [],
      agentRunning: !!r.agent_running, snapshotCount: r.snapshot_count || 0, oldestSnapshotAt: r.oldest_snapshot_at,
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

// ── v2: Guest 360, rrd live proxies, node detail, network/disks/storage-content/events/snapshots ──

const RRD_TIMEFRAMES = ['hour', 'day', 'week', 'month', 'year'];
const DEVICE_KEY_RE = /^(scsi|sata|ide|virtio|efidisk|tpmstate)\d+$/;
const NET_KEY_RE = /^net\d+$/;

function parseKeyValueList(parts) {
  const opts = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > -1) opts[p.slice(0, eq)] = p.slice(eq + 1);
    else if (p) opts[p] = true;
  }
  return opts;
}

/** GET /api/proxmox/guests/:id/detail — Guest 360: config, parsed disks/nics, snapshots. */
router.get('/guests/:id/detail', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const g = db.prepare(`
      SELECT g.*, s.name AS server_name FROM proxmox_guests g JOIN proxmox_servers s ON s.id = g.server_id
      WHERE g.id = ?
    `).get(req.params.id);
    if (!g) return res.status(404).json({ error: 'Guest not found.' });

    let config = {};
    if (g.config_json) {
      try { config = JSON.parse(g.config_json) || {}; } catch { config = {}; }
    }

    const disks = [];
    const nics = [];
    for (const [key, val] of Object.entries(config)) {
      if (typeof val !== 'string') continue;
      if (DEVICE_KEY_RE.test(key)) {
        const [storageVol, ...rest] = val.split(',');
        const opts = parseKeyValueList(rest);
        disks.push({ key, storage: storageVol, size: opts.size || null, raw: val });
      } else if (NET_KEY_RE.test(key)) {
        const [modelMac, ...rest] = val.split(',');
        const eqIdx = modelMac.indexOf('=');
        const model = eqIdx > -1 ? modelMac.slice(0, eqIdx) : null;
        const mac = eqIdx > -1 ? modelMac.slice(eqIdx + 1) : null;
        const opts = parseKeyValueList(rest);
        nics.push({ key, model, mac, bridge: opts.bridge || null, tag: opts.tag || null, raw: val });
      }
    }

    const snapshots = db.prepare(`
      SELECT * FROM proxmox_snapshots WHERE server_id = ? AND vmid = ? AND name != 'current' ORDER BY snap_time
    `).all(g.server_id, g.vmid).map((sn) => ({
      name: sn.name, parent: sn.parent, description: sn.description,
      vmstate: !!sn.vmstate, snapTime: sn.snap_time,
    }));

    res.json({
      guest: {
        id: g.id, serverId: g.server_id, serverName: g.server_name, vmid: g.vmid, name: g.name, type: g.type,
        node: g.node, status: g.status, isTemplate: !!g.is_template, cpuCount: g.cpu_count, cpuSockets: g.cpu_sockets,
        cpuUsage: g.cpu_usage, memUsed: g.mem_used, memTotal: g.mem_total, diskUsed: g.disk_used, diskTotal: g.disk_total,
        uptimeSeconds: g.uptime_seconds, netIn: g.net_in, netOut: g.net_out, pool: g.pool,
        tags: g.tags ? JSON.parse(g.tags) : null, lastBackupAt: g.last_backup_at, lastBackupStatus: g.last_backup_status,
        osName: g.os_name, ipAddresses: g.ip_addresses ? JSON.parse(g.ip_addresses) : [],
        agentRunning: !!g.agent_running, snapshotCount: g.snapshot_count || 0, oldestSnapshotAt: g.oldest_snapshot_at,
        updatedAt: g.updated_at,
      },
      config,
      disks,
      nics,
      snapshots,
    });
  } catch (err) { next(err); }
});

/** GET /api/proxmox/guests/:id/rrd?timeframe= — live proxy to guest rrddata (not stored). */
router.get('/guests/:id/rrd', [
  param('id').isInt().toInt(),
  query('timeframe').optional().isString(),
], validate, async (req, res, next) => {
  try {
    const g = db.prepare(`
      SELECT g.*, s.host, s.port, s.token_id, s.encrypted_credentials, s.ssl_verify
      FROM proxmox_guests g JOIN proxmox_servers s ON s.id = g.server_id WHERE g.id = ?
    `).get(req.params.id);
    if (!g) return res.status(404).json({ error: 'Guest not found.' });
    const timeframe = RRD_TIMEFRAMES.includes(req.query.timeframe) ? req.query.timeframe : 'hour';
    try {
      const rows = await proxmoxApi.pveGet(g, `/nodes/${g.node}/${g.type}/${g.vmid}/rrddata`, { timeframe, cf: 'AVERAGE' });
      res.json(rows || []);
    } catch (err) {
      res.status(502).json({ error: err.message || 'Upstream rrddata request failed' });
    }
  } catch (err) { next(err); }
});

/** GET /api/proxmox/nodes/:id/rrd?timeframe= — live proxy to node rrddata (not stored). */
router.get('/nodes/:id/rrd', [
  param('id').isInt().toInt(),
  query('timeframe').optional().isString(),
], validate, async (req, res, next) => {
  try {
    const n = db.prepare(`
      SELECT n.*, s.host, s.port, s.token_id, s.encrypted_credentials, s.ssl_verify
      FROM proxmox_nodes n JOIN proxmox_servers s ON s.id = n.server_id WHERE n.id = ?
    `).get(req.params.id);
    if (!n) return res.status(404).json({ error: 'Node not found.' });
    const timeframe = RRD_TIMEFRAMES.includes(req.query.timeframe) ? req.query.timeframe : 'hour';
    try {
      const rows = await proxmoxApi.pveGet(n, `/nodes/${n.name}/rrddata`, { timeframe, cf: 'AVERAGE' });
      res.json(rows || []);
    } catch (err) {
      res.status(502).json({ error: err.message || 'Upstream rrddata request failed' });
    }
  } catch (err) { next(err); }
});

/** GET /api/proxmox/nodes/:id/detail — services, disks, networks for one node (WPC consumes). */
router.get('/nodes/:id/detail', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const n = db.prepare('SELECT * FROM proxmox_nodes WHERE id = ?').get(req.params.id);
    if (!n) return res.status(404).json({ error: 'Node not found.' });
    const services = db.prepare(`
      SELECT * FROM proxmox_services WHERE server_id = ? AND node = ? ORDER BY name
    `).all(n.server_id, n.name).map((sv) => ({
      id: sv.id, node: sv.node, name: sv.name, state: sv.state, activeState: sv.active_state,
      unitState: sv.unit_state, description: sv.description, updatedAt: sv.updated_at,
    }));
    const disks = db.prepare(`
      SELECT * FROM proxmox_disks WHERE server_id = ? AND node = ? ORDER BY devpath
    `).all(n.server_id, n.name).map((d) => ({
      id: d.id, node: d.node, devpath: d.devpath, model: d.model, vendor: d.vendor, serial: d.serial,
      sizeBytes: d.size_bytes, health: d.health, wearout: d.wearout, diskType: d.disk_type, usedAs: d.used_as,
      updatedAt: d.updated_at,
    }));
    const networks = db.prepare(`
      SELECT * FROM proxmox_node_networks WHERE server_id = ? AND node = ? ORDER BY iface
    `).all(n.server_id, n.name).map((nw) => ({
      id: nw.id, node: nw.node, iface: nw.iface, ifaceType: nw.iface_type, method: nw.method, cidr: nw.cidr,
      vlanId: nw.vlan_id, vlanRawDevice: nw.vlan_raw_device, active: !!nw.active, autostart: !!nw.autostart,
      comments: nw.comments, updatedAt: nw.updated_at,
    }));
    res.json({ services, disks, networks });
  } catch (err) { next(err); }
});

/** GET /api/proxmox/network — node network interfaces across all servers. */
router.get('/network', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT nw.*, s.name AS server_name FROM proxmox_node_networks nw JOIN proxmox_servers s ON s.id = nw.server_id
      ORDER BY s.name, nw.node, nw.iface
    `).all();
    res.json(rows.map((r) => ({
      id: r.id, serverId: r.server_id, serverName: r.server_name, node: r.node, iface: r.iface,
      ifaceType: r.iface_type, method: r.method, cidr: r.cidr, vlanId: r.vlan_id, vlanRawDevice: r.vlan_raw_device,
      active: !!r.active, autostart: !!r.autostart, comments: r.comments,
    })));
  } catch (err) { next(err); }
});

/** GET /api/proxmox/disks — physical disks across all servers. */
router.get('/disks', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT d.*, s.name AS server_name FROM proxmox_disks d JOIN proxmox_servers s ON s.id = d.server_id
      ORDER BY s.name, d.node, d.devpath
    `).all();
    res.json(rows.map((r) => ({
      id: r.id, serverId: r.server_id, serverName: r.server_name, node: r.node, devpath: r.devpath,
      model: r.model, vendor: r.vendor, serial: r.serial, sizeBytes: r.size_bytes, health: r.health,
      wearout: r.wearout, diskType: r.disk_type, usedAs: r.used_as,
    })));
  } catch (err) { next(err); }
});

/** GET /api/proxmox/storage-content?content=&storage= — vzdump/iso/vztmpl listing. */
router.get('/storage-content', [
  query('content').optional().isString(),
  query('storage').optional().isString(),
], validate, (req, res, next) => {
  try {
    const clauses = [];
    const params = [];
    if (req.query.content) { clauses.push('sc.content = ?'); params.push(req.query.content); }
    if (req.query.storage) { clauses.push('sc.storage = ?'); params.push(req.query.storage); }
    const rows = db.prepare(`
      SELECT sc.*, s.name AS server_name FROM proxmox_storage_content sc JOIN proxmox_servers s ON s.id = sc.server_id
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY s.name, sc.node, sc.storage, sc.volid
    `).all(...params);
    res.json(rows.map((r) => ({
      id: r.id, serverId: r.server_id, serverName: r.server_name, node: r.node, storage: r.storage,
      volid: r.volid, content: r.content, format: r.format, sizeBytes: r.size_bytes, vmid: r.vmid,
      createdAt: r.created_at_src, notes: r.notes,
    })));
  } catch (err) { next(err); }
});

/** GET /api/proxmox/events?limit=200 — cluster log, newest first. */
router.get('/events', [query('limit').optional().isInt({ min: 1, max: 1000 }).toInt()], validate, (req, res, next) => {
  try {
    const limit = req.query.limit || 200;
    const rows = db.prepare(`
      SELECT e.*, s.name AS server_name FROM proxmox_events e JOIN proxmox_servers s ON s.id = e.server_id
      ORDER BY e.event_time DESC LIMIT ?
    `).all(limit);
    res.json(rows.map((r) => ({
      id: r.id, serverId: r.server_id, serverName: r.server_name, node: r.node, eventTime: r.event_time,
      user: r.user, tag: r.tag, pri: r.pri, message: r.message,
    })));
  } catch (err) { next(err); }
});

/** GET /api/proxmox/snapshots — all guest snapshots across all servers. */
router.get('/snapshots', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT sn.*, s.name AS server_name FROM proxmox_snapshots sn JOIN proxmox_servers s ON s.id = sn.server_id
      ORDER BY s.name, sn.vmid, sn.snap_time
    `).all();
    res.json(rows.map((r) => ({
      id: r.id, serverId: r.server_id, serverName: r.server_name, vmid: r.vmid, guestName: r.guest_name,
      name: r.name, parent: r.parent, description: r.description, vmstate: !!r.vmstate, snapTime: r.snap_time,
    })));
  } catch (err) { next(err); }
});

module.exports = router;
