// Proxmox VE routes, ported from backend/routes/proxmox.js. Mounted by the
// plugin dispatcher at /api/proxmox — paths below are relative. Registration
// CRUD stores tokenSecret AES-encrypted; all responses are camelCase.
//
// DEVIATION FROM THE BUILT-IN: bundled plugins cannot require the host's
// express/express-validator (contract C4/README "Router note") — createRouter
// must return a BARE (req, res, next) function. This file hand-matches
// req.method/req.path against a small route table and re-implements the
// validation express-validator did inline, preserving the same status codes
// (400 invalid params, 404 missing, 409 duplicate, 502 upstream rrd failure)
// and JSON response shapes exactly.
const proxmoxApi = require('./proxmoxApi');
const { getPoller } = require('./poller');
const {
  storageWarnPct, storageCritPct, backupStaleDays, certWarnDays, snapshotAgeDays, computeIssues,
} = require('./issues');

// ── hand-rolled validation helpers ──────────────────────────────────────────

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

function isBooleanish(v) {
  return typeof v === 'boolean' || v === 'true' || v === 'false' || v === 0 || v === 1 || v === '0' || v === '1';
}

function toBool(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

/** Validates :id is a positive integer. Returns the number, or null after
 *  writing a 400 response. */
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

const publicServer = (row) => ({
  id: row.id, name: row.name, host: row.host, port: row.port,
  sslVerify: !!row.ssl_verify, pollingIntervalMinutes: row.polling_interval_minutes,
  lastPollStatus: row.last_poll_status, lastPollError: row.last_poll_error, lastPollAt: row.last_poll_at,
  tokenId: row.token_id, hasCredentials: !!row.encrypted_credentials,
});

const RRD_TIMEFRAMES = ['hour', 'day', 'week', 'month', 'year'];
const DEVICE_KEY_RE = /^(scsi|sata|ide|virtio|efidisk|tpmstate)\d+$/;
const NET_KEY_RE = /^net\d+$/;
const STORAGE_DEVICE_KEY_RE = /^(?:(?:scsi|sata|ide|virtio|efidisk|tpmstate|mp)\d+|rootfs)$/;
const PROBE_SECTIONS = [
  'version', 'nodes', 'resources', 'guests', 'storage', 'tasks', 'backup', 'cluster', 'certificates', 'subscription',
];

function truncateArr(raw) {
  if (Array.isArray(raw)) return { items: raw.slice(0, 3), count: raw.length };
  return raw;
}

function parseKeyValueList(parts) {
  const opts = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > -1) opts[p.slice(0, eq)] = p.slice(eq + 1);
    else if (p) opts[p] = true;
  }
  return opts;
}

// ── route handlers ──────────────────────────────────────────────────────────

function handleGetServers(req, res, coreApi) {
  res.json(coreApi.db.prepare('SELECT * FROM proxmox_servers ORDER BY name').all().map(publicServer));
}

function handlePostServers(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  if (!isNonEmptyString(b.name, 120)) errors.push(fail('name'));
  if (!isNonEmptyString(b.host, 253)) errors.push(fail('host'));
  if (b.port !== undefined) {
    const p = parseIntStrict(b.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) errors.push(fail('port'));
  }
  if (!isNonEmptyString(b.tokenId, 256)) errors.push(fail('tokenId'));
  if (!(typeof b.tokenSecret === 'string' && b.tokenSecret.length > 0 && b.tokenSecret.length <= 256)) errors.push(fail('tokenSecret'));
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (b.pollingIntervalMinutes !== undefined) {
    const n = parseIntStrict(b.pollingIntervalMinutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) errors.push(fail('pollingIntervalMinutes'));
  }
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  const name = b.name.trim();
  const host = b.host.trim();
  const port = b.port ? parseIntStrict(b.port) : 8006;
  const dup = db.prepare('SELECT id FROM proxmox_servers WHERE name = ? OR (host = ? AND port = ?)')
    .get(name, host, port);
  if (dup) return res.status(409).json({ error: 'A Proxmox server with that name or host+port is already registered.' });
  const info = db.prepare(`
    INSERT INTO proxmox_servers (name, host, port, token_id, encrypted_credentials, ssl_verify, polling_interval_minutes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, host, port, b.tokenId.trim(),
    coreApi.encryption.encrypt(JSON.stringify({ tokenSecret: b.tokenSecret })), toBool(b.sslVerify) ? 1 : 0,
    b.pollingIntervalMinutes ? parseIntStrict(b.pollingIntervalMinutes) : 10);
  const row = db.prepare('SELECT * FROM proxmox_servers WHERE id = ?').get(info.lastInsertRowid);
  const poller = getPoller(coreApi);
  poller.schedule(row);
  poller.trigger(row).catch(() => {});
  res.status(201).json(publicServer(row));
}

function handlePutServer(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const b = req.body || {};
  const errors = [];
  if (b.name !== undefined && !isNonEmptyString(b.name, 120)) errors.push(fail('name'));
  if (b.host !== undefined && !isNonEmptyString(b.host, 253)) errors.push(fail('host'));
  if (b.port !== undefined) {
    const p = parseIntStrict(b.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) errors.push(fail('port'));
  }
  if (b.tokenId !== undefined && !isNonEmptyString(b.tokenId, 256)) errors.push(fail('tokenId'));
  if (b.tokenSecret !== undefined && !(typeof b.tokenSecret === 'string' && b.tokenSecret.length <= 256)) errors.push(fail('tokenSecret'));
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (b.pollingIntervalMinutes !== undefined) {
    const n = parseIntStrict(b.pollingIntervalMinutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) errors.push(fail('pollingIntervalMinutes'));
  }
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM proxmox_servers WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Proxmox server not found.' });
  db.prepare(`
    UPDATE proxmox_servers SET
      name = ?, host = ?, port = ?, token_id = ?, encrypted_credentials = ?,
      ssl_verify = ?, polling_interval_minutes = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    b.name?.trim() || row.name, b.host?.trim() || row.host, b.port ? parseIntStrict(b.port) : row.port,
    b.tokenId?.trim() || row.token_id,
    b.tokenSecret ? coreApi.encryption.encrypt(JSON.stringify({ tokenSecret: b.tokenSecret })) : row.encrypted_credentials,
    b.sslVerify !== undefined ? (toBool(b.sslVerify) ? 1 : 0) : row.ssl_verify,
    b.pollingIntervalMinutes ? parseIntStrict(b.pollingIntervalMinutes) : row.polling_interval_minutes,
    row.id
  );
  const updated = db.prepare('SELECT * FROM proxmox_servers WHERE id = ?').get(row.id);
  getPoller(coreApi).schedule(updated);
  res.json(publicServer(updated));
}

function handleDeleteServer(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM proxmox_servers WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Proxmox server not found.' });
  getPoller(coreApi).cancel(row.id);
  db.prepare('DELETE FROM proxmox_servers WHERE id = ?').run(row.id);
  res.json({ ok: true });
}

async function handlePostServersTest(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  if (b.id !== undefined && !Number.isInteger(parseIntStrict(b.id))) errors.push(fail('id'));
  if (!isNonEmptyString(b.host)) errors.push(fail('host'));
  if (b.port !== undefined) {
    const p = parseIntStrict(b.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) errors.push(fail('port'));
  }
  if (!isNonEmptyString(b.tokenId)) errors.push(fail('tokenId'));
  if (b.tokenSecret !== undefined && typeof b.tokenSecret !== 'string') errors.push(fail('tokenSecret'));
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (errors.length) return badRequest(res, errors);

  const { id, host, port, tokenId, tokenSecret, sslVerify } = b;
  const candidate = { host: host.trim(), port: port ? parseIntStrict(port) : 8006, tokenId: tokenId.trim(), tokenSecret, sslVerify: toBool(sslVerify) ? 1 : 0 };
  if (!tokenSecret && id) {
    const row = coreApi.db.prepare('SELECT * FROM proxmox_servers WHERE id = ?').get(parseIntStrict(id));
    if (row && row.encrypted_credentials) {
      const c = JSON.parse(coreApi.encryption.decrypt(row.encrypted_credentials));
      candidate.tokenSecret = c.tokenSecret;
    }
  }
  const result = await proxmoxApi.testConnection(candidate, coreApi);
  res.status(result.ok ? 200 : 502).json(result);
}

async function handlePostServerRefresh(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const row = coreApi.db.prepare('SELECT * FROM proxmox_servers WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Proxmox server not found.' });
  await getPoller(coreApi).trigger(row);
  res.json({ ok: true });
}

async function handleGetServerProbe(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM proxmox_servers WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Proxmox server not found.' });
  if (row.encrypted_credentials) {
    const c = JSON.parse(coreApi.encryption.decrypt(row.encrypted_credentials));
    row.tokenSecret = c.tokenSecret;
  }
  row.tokenId = row.token_id;
  row.sslVerify = row.ssl_verify;

  const requested = req.query.sections
    ? String(req.query.sections).split(',').map((s) => s.trim()).filter(Boolean)
    : PROBE_SECTIONS;

  const nodes = await proxmoxApi.fetchNodes(row, coreApi);
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

  await section('version', () => proxmoxApi.fetchVersion(row, coreApi));
  await section('nodes', () => nodes);
  await section('resources', () => proxmoxApi.fetchClusterResources(row, coreApi));
  if (firstNode) {
    await section('guests', async () => ({
      qemu: await proxmoxApi.fetchQemu(row, coreApi, firstNode),
      lxc: await proxmoxApi.fetchLxc(row, coreApi, firstNode),
    }));
    await section('storage', () => proxmoxApi.fetchNodeStorage(row, coreApi, firstNode));
    await section('tasks', () => proxmoxApi.fetchTasks(row, coreApi, firstNode, 10));
    await section('certificates', () => proxmoxApi.fetchCertificates(row, coreApi, firstNode));
    await section('subscription', () => proxmoxApi.fetchSubscription(row, coreApi, firstNode));
  }
  await section('backup', () => proxmoxApi.fetchClusterBackup(row, coreApi));
  await section('cluster', () => proxmoxApi.fetchClusterStatus(row, coreApi));

  res.json(out);
}

function handleGetConfig(req, res, coreApi) {
  res.json({
    storageWarnPct: storageWarnPct(coreApi), storageCritPct: storageCritPct(coreApi),
    backupStaleDays: backupStaleDays(coreApi), certWarnDays: certWarnDays(coreApi),
    snapshotAgeDays: snapshotAgeDays(coreApi),
  });
}

function handlePutConfig(req, res, coreApi) {
  const b = req.body || {};
  const fields = [
    ['storageWarnPct', 1, 100], ['storageCritPct', 1, 100], ['backupStaleDays', 1, 365],
    ['certWarnDays', 1, 365], ['snapshotAgeDays', 1, 365],
  ];
  const errors = [];
  for (const [key, min, max] of fields) {
    const n = parseIntStrict(b[key]);
    if (!Number.isInteger(n) || n < min || n > max) errors.push(fail(key));
  }
  if (errors.length) return badRequest(res, errors);

  coreApi.settings.setSetting('proxmox_storage_warn_pct', String(parseIntStrict(b.storageWarnPct)));
  coreApi.settings.setSetting('proxmox_storage_crit_pct', String(parseIntStrict(b.storageCritPct)));
  coreApi.settings.setSetting('proxmox_backup_stale_days', String(parseIntStrict(b.backupStaleDays)));
  coreApi.settings.setSetting('proxmox_cert_warn_days', String(parseIntStrict(b.certWarnDays)));
  coreApi.settings.setSetting('proxmox_snapshot_age_days', String(parseIntStrict(b.snapshotAgeDays)));
  res.json({
    storageWarnPct: storageWarnPct(coreApi), storageCritPct: storageCritPct(coreApi),
    backupStaleDays: backupStaleDays(coreApi), certWarnDays: certWarnDays(coreApi),
    snapshotAgeDays: snapshotAgeDays(coreApi),
  });
}

function handleGetIssues(req, res, coreApi) {
  res.json(computeIssues(coreApi));
}

function handleGetIssueHistory(req, res, coreApi) {
  const q = parseQueryInt(req.query.days, 1, 90);
  if (!q.ok) return badRequest(res, [fail('days')]);
  const days = Math.min(90, Math.max(1, q.value || 30));
  const rows = coreApi.db.prepare(`
    SELECT * FROM proxmox_issue_history
    WHERE status = 'open' OR last_seen >= datetime('now', ?)
    ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, last_seen DESC
  `).all(`-${days} days`);
  res.json(rows.map((r) => ({
    id: r.id, issueKey: r.issue_key, source: r.source, sourceId: r.source_id,
    severity: r.severity, type: r.type, target: r.target, message: r.message, status: r.status,
    firstSeen: r.first_seen, lastSeen: r.last_seen, resolvedAt: r.resolved_at,
  })));
}

function handleGetOverview(req, res, coreApi) {
  const db = coreApi.db;
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
  const issues = computeIssues(coreApi);
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
}

function handleGetNodes(req, res, coreApi) {
  const rows = coreApi.db.prepare(`
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
}

function handleGetGuests(req, res, coreApi) {
  const q = req.query || {};
  if (q.type !== undefined && q.type !== 'qemu' && q.type !== 'lxc') return badRequest(res, [fail('type')]);
  const serverIdQ = parseQueryInt(q.serverId);
  if (!serverIdQ.ok) return badRequest(res, [fail('serverId')]);

  const clauses = [];
  const params = [];
  if (q.type) { clauses.push('g.type = ?'); params.push(q.type); }
  if (q.status) { clauses.push('g.status = ?'); params.push(q.status); }
  if (serverIdQ.value !== undefined) { clauses.push('g.server_id = ?'); params.push(serverIdQ.value); }
  const rows = coreApi.db.prepare(`
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
}

function handleGetStorage(req, res, coreApi) {
  const rows = coreApi.db.prepare(`
    SELECT st.*, s.name AS server_name FROM proxmox_storage st JOIN proxmox_servers s ON s.id = st.server_id
    ORDER BY s.name, st.node, st.storage
  `).all();
  res.json(rows.map((r) => ({
    id: r.id, serverId: r.server_id, serverName: r.server_name, node: r.node, storage: r.storage,
    type: r.type, content: r.content, active: !!r.active, shared: !!r.shared,
    usedBytes: r.used_bytes, totalBytes: r.total_bytes, availBytes: r.avail_bytes, updatedAt: r.updated_at,
  })));
}

function handleGetStorageGuests(req, res, coreApi) {
  const db = coreApi.db;
  const st = db.prepare(`
    SELECT st.*, s.name AS server_name FROM proxmox_storage st JOIN proxmox_servers s ON s.id = st.server_id
    WHERE st.id = ?
  `).get(Number(req.params.id));
  if (!st) return res.status(404).json({ error: 'Storage not found' });

  const guests = db.prepare('SELECT * FROM proxmox_guests WHERE server_id = ?').all(st.server_id);
  const prefix = `${st.storage}:`;
  const out = [];
  for (const g of guests) {
    if (!g.config_json) continue;
    let config = {};
    try { config = JSON.parse(g.config_json) || {}; } catch { continue; }
    const devices = [];
    for (const [key, val] of Object.entries(config)) {
      if (typeof val !== 'string' || !STORAGE_DEVICE_KEY_RE.test(key)) continue;
      const [volume, ...rest] = val.split(',');
      if (!volume.startsWith(prefix)) continue;
      const opts = parseKeyValueList(rest);
      devices.push({ key, volume, size: opts.size || null, cdrom: opts.media === 'cdrom' });
    }
    if (devices.length) {
      out.push({
        id: g.id, vmid: g.vmid, name: g.name, type: g.type, node: g.node, status: g.status,
        isTemplate: !!g.is_template, devices,
      });
    }
  }
  out.sort((a, b) => a.vmid - b.vmid);
  res.json(out);
}

function handleGetBackups(req, res, coreApi) {
  const db = coreApi.db;
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
}

function handleGetTasks(req, res, coreApi) {
  const q = parseQueryInt(req.query.limit, 1, 1000);
  if (!q.ok) return badRequest(res, [fail('limit')]);
  const limit = q.value || 200;
  const rows = coreApi.db.prepare(`
    SELECT t.*, s.name AS server_name FROM proxmox_tasks t JOIN proxmox_servers s ON s.id = t.server_id
    ORDER BY t.started_at DESC LIMIT ?
  `).all(limit);
  res.json(rows.map((t) => ({
    id: t.id, serverId: t.server_id, serverName: t.server_name, upid: t.upid, node: t.node, type: t.type,
    target: t.target, user: t.user, status: t.status, startedAt: t.started_at, endedAt: t.ended_at,
  })));
}

function handleGetMetricsHistory(req, res, coreApi) {
  const serverIdQ = parseQueryInt(req.query.serverId);
  const hoursQ = parseQueryInt(req.query.hours, 1, 720);
  if (!serverIdQ.ok) return badRequest(res, [fail('serverId')]);
  if (!hoursQ.ok) return badRequest(res, [fail('hours')]);
  const hours = hoursQ.value || 24;
  const clauses = [`captured_at >= datetime('now', ?)`];
  const params = [`-${hours} hours`];
  if (serverIdQ.value !== undefined) { clauses.push('server_id = ?'); params.push(serverIdQ.value); }
  const rows = coreApi.db.prepare(`
    SELECT * FROM proxmox_metrics WHERE ${clauses.join(' AND ')} ORDER BY captured_at
  `).all(...params);
  res.json(rows.map((r) => ({
    node: r.node, capturedAt: r.captured_at, cpuUsage: r.cpu_usage, memUsed: r.mem_used, memTotal: r.mem_total,
    storageUsed: r.storage_used, storageTotal: r.storage_total,
  })));
}

function handleGetGuestDetail(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const g = db.prepare(`
    SELECT g.*, s.name AS server_name FROM proxmox_guests g JOIN proxmox_servers s ON s.id = g.server_id
    WHERE g.id = ?
  `).get(id);
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
}

async function handleGetGuestRrd(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const g = coreApi.db.prepare(`
    SELECT g.*, s.host, s.port, s.token_id, s.encrypted_credentials, s.ssl_verify
    FROM proxmox_guests g JOIN proxmox_servers s ON s.id = g.server_id WHERE g.id = ?
  `).get(id);
  if (!g) return res.status(404).json({ error: 'Guest not found.' });
  const timeframe = RRD_TIMEFRAMES.includes(req.query.timeframe) ? req.query.timeframe : 'hour';
  try {
    const rows = await proxmoxApi.pveGet(g, coreApi, `/nodes/${g.node}/${g.type}/${g.vmid}/rrddata`, { timeframe, cf: 'AVERAGE' });
    res.json(rows || []);
  } catch (err) {
    res.status(502).json({ error: err.message || 'Upstream rrddata request failed' });
  }
}

async function handleGetNodeRrd(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const n = coreApi.db.prepare(`
    SELECT n.*, s.host, s.port, s.token_id, s.encrypted_credentials, s.ssl_verify
    FROM proxmox_nodes n JOIN proxmox_servers s ON s.id = n.server_id WHERE n.id = ?
  `).get(id);
  if (!n) return res.status(404).json({ error: 'Node not found.' });
  const timeframe = RRD_TIMEFRAMES.includes(req.query.timeframe) ? req.query.timeframe : 'hour';
  try {
    const rows = await proxmoxApi.pveGet(n, coreApi, `/nodes/${n.name}/rrddata`, { timeframe, cf: 'AVERAGE' });
    res.json(rows || []);
  } catch (err) {
    res.status(502).json({ error: err.message || 'Upstream rrddata request failed' });
  }
}

function handleGetNodeDetail(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const n = db.prepare('SELECT * FROM proxmox_nodes WHERE id = ?').get(id);
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
}

function handleGetNetwork(req, res, coreApi) {
  const rows = coreApi.db.prepare(`
    SELECT nw.*, s.name AS server_name FROM proxmox_node_networks nw JOIN proxmox_servers s ON s.id = nw.server_id
    ORDER BY s.name, nw.node, nw.iface
  `).all();
  res.json(rows.map((r) => ({
    id: r.id, serverId: r.server_id, serverName: r.server_name, node: r.node, iface: r.iface,
    ifaceType: r.iface_type, method: r.method, cidr: r.cidr, vlanId: r.vlan_id, vlanRawDevice: r.vlan_raw_device,
    active: !!r.active, autostart: !!r.autostart, comments: r.comments,
  })));
}

function handleGetDisks(req, res, coreApi) {
  const rows = coreApi.db.prepare(`
    SELECT d.*, s.name AS server_name FROM proxmox_disks d JOIN proxmox_servers s ON s.id = d.server_id
    ORDER BY s.name, d.node, d.devpath
  `).all();
  res.json(rows.map((r) => ({
    id: r.id, serverId: r.server_id, serverName: r.server_name, node: r.node, devpath: r.devpath,
    model: r.model, vendor: r.vendor, serial: r.serial, sizeBytes: r.size_bytes, health: r.health,
    wearout: r.wearout, diskType: r.disk_type, usedAs: r.used_as,
  })));
}

function handleGetStorageContent(req, res, coreApi) {
  const clauses = [];
  const params = [];
  if (req.query.content) { clauses.push('sc.content = ?'); params.push(req.query.content); }
  if (req.query.storage) { clauses.push('sc.storage = ?'); params.push(req.query.storage); }
  const rows = coreApi.db.prepare(`
    SELECT sc.*, s.name AS server_name FROM proxmox_storage_content sc JOIN proxmox_servers s ON s.id = sc.server_id
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY s.name, sc.node, sc.storage, sc.volid
  `).all(...params);
  res.json(rows.map((r) => ({
    id: r.id, serverId: r.server_id, serverName: r.server_name, node: r.node, storage: r.storage,
    volid: r.volid, content: r.content, format: r.format, sizeBytes: r.size_bytes, vmid: r.vmid,
    createdAt: r.created_at_src, notes: r.notes,
  })));
}

function handleGetEvents(req, res, coreApi) {
  const q = parseQueryInt(req.query.limit, 1, 1000);
  if (!q.ok) return badRequest(res, [fail('limit')]);
  const limit = q.value || 200;
  const rows = coreApi.db.prepare(`
    SELECT e.*, s.name AS server_name FROM proxmox_events e JOIN proxmox_servers s ON s.id = e.server_id
    ORDER BY e.event_time DESC LIMIT ?
  `).all(limit);
  res.json(rows.map((r) => ({
    id: r.id, serverId: r.server_id, serverName: r.server_name, node: r.node, eventTime: r.event_time,
    user: r.user, tag: r.tag, pri: r.pri, message: r.message,
  })));
}

function handleGetSnapshots(req, res, coreApi) {
  const rows = coreApi.db.prepare(`
    SELECT sn.*, s.name AS server_name FROM proxmox_snapshots sn JOIN proxmox_servers s ON s.id = sn.server_id
    ORDER BY s.name, sn.vmid, sn.snap_time
  `).all();
  res.json(rows.map((r) => ({
    id: r.id, serverId: r.server_id, serverName: r.server_name, vmid: r.vmid, guestName: r.guest_name,
    name: r.name, parent: r.parent, description: r.description, vmstate: !!r.vmstate, snapTime: r.snap_time,
  })));
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
  { method: 'GET', ...compile('/servers'), handler: handleGetServers },
  { method: 'POST', ...compile('/servers'), handler: handlePostServers },
  { method: 'PUT', ...compile('/servers/:id'), handler: handlePutServer },
  { method: 'DELETE', ...compile('/servers/:id'), handler: handleDeleteServer },
  { method: 'POST', ...compile('/servers/test'), handler: handlePostServersTest },
  { method: 'POST', ...compile('/servers/:id/refresh'), handler: handlePostServerRefresh },
  { method: 'GET', ...compile('/servers/:id/probe'), handler: handleGetServerProbe },
  { method: 'GET', ...compile('/config'), handler: handleGetConfig },
  { method: 'PUT', ...compile('/config'), handler: handlePutConfig },
  { method: 'GET', ...compile('/issues'), handler: handleGetIssues },
  { method: 'GET', ...compile('/issue-history'), handler: handleGetIssueHistory },
  { method: 'GET', ...compile('/overview'), handler: handleGetOverview },
  { method: 'GET', ...compile('/nodes'), handler: handleGetNodes },
  { method: 'GET', ...compile('/guests'), handler: handleGetGuests },
  { method: 'GET', ...compile('/storage'), handler: handleGetStorage },
  { method: 'GET', ...compile('/storage/:id/guests'), handler: handleGetStorageGuests },
  { method: 'GET', ...compile('/backups'), handler: handleGetBackups },
  { method: 'GET', ...compile('/tasks'), handler: handleGetTasks },
  { method: 'GET', ...compile('/metrics-history'), handler: handleGetMetricsHistory },
  { method: 'GET', ...compile('/guests/:id/detail'), handler: handleGetGuestDetail },
  { method: 'GET', ...compile('/guests/:id/rrd'), handler: handleGetGuestRrd },
  { method: 'GET', ...compile('/nodes/:id/rrd'), handler: handleGetNodeRrd },
  { method: 'GET', ...compile('/nodes/:id/detail'), handler: handleGetNodeDetail },
  { method: 'GET', ...compile('/network'), handler: handleGetNetwork },
  { method: 'GET', ...compile('/disks'), handler: handleGetDisks },
  { method: 'GET', ...compile('/storage-content'), handler: handleGetStorageContent },
  { method: 'GET', ...compile('/events'), handler: handleGetEvents },
  { method: 'GET', ...compile('/snapshots'), handler: handleGetSnapshots },
];

// createRouter must return a BARE (req, res, next) function — installed
// plugins are loaded via require() on their own dist/backend/index.cjs and
// cannot require the host's copy of express, so express Router instances
// are off the table. Matches req.method + req.path by hand against the
// table above; req.query/req.body are still parsed by the host's express
// pipeline before this middleware runs.
function createRouter(coreApi) {
  return function proxmoxRouter(req, res, next) {
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
