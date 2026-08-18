// NetApp ONTAP routes, ported from backend/routes/netapp.js. Mounted by the
// host dispatcher at /api/netapp — paths below are relative.
//
// DEVIATION FROM THE BUILT-IN: bundled plugins cannot require the host's
// express/express-validator — createRouter must return a BARE (req, res,
// next) function (dell/unifi/nutanix router.js pattern). This file
// hand-matches req.method/req.path against a route table (compile.js) and
// re-implements the validation express-validator did inline (validate.js),
// preserving the same status codes (400 invalid params, 404 missing, 409
// duplicate, 403 AIQUM-managed read-only) and JSON response shapes exactly.
// services/ipIdentity.buildIpIndex is reimplemented inline (ipIdentity.js is
// pure db-driven, no other host module dependency — see /mounts, /nfs, /cifs).
const api = require('./api');
const { getPollers } = require('./poller');
const { createNetappAdvisor } = require('./advisor');
const { compile } = require('./compile');
const {
  badRequest, fail, parseIntStrict, isNonEmptyString, isBooleanish, toBool,
  requireIdParam, parseQueryInt,
} = require('./validate');

// SSRF guard on the management host.
function isBlockedHost(host) {
  const h = String(host || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').split(':')[0];
  const blocked = [
    /^127\./, /^0\.0\.0\.0$/, /^169\.254\./, /^::1$/,
    /^localhost$/i, /^metadata\.google\.internal$/i, /^169\.254\.169\.254$/,
  ];
  return blocked.some((p) => p.test(h));
}

// Read-only view of a cluster (AIQUM-managed or direct). Credential values —
// including usernames — are never returned; presence only.
function publicCluster(row) {
  return {
    id: row.id,
    name: row.name,
    mgmt_host: row.mgmt_host,
    has_username: !!row.username,
    version: row.version,
    management_ip: row.management_ip,
    cluster_uuid: row.cluster_uuid,
    source: row.source,
    aiqum_instance_id: row.aiqum_instance_id ?? null,
    ssl_verify: row.ssl_verify,
    polling_interval_minutes: row.polling_interval_minutes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function publicAiqumInstance(db, row) {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    hasUsername: !!row.username,
    hasPassword: !!row.encrypted_credentials,
    pollIntervalMin: row.poll_interval_minutes,
    clusterCount: db.prepare("SELECT COUNT(*) AS n FROM netapp_arrays WHERE source = 'aiqum' AND aiqum_instance_id = ?").get(row.id).n,
    created_at: row.created_at,
  };
}

function buildDirectCredentials(reqBody, coreApi) {
  return coreApi.encryption.encrypt(JSON.stringify({ password: String(reqBody.password) }));
}

function describeApiError(err) {
  if (err?.response) {
    const status = err.response.status;
    const detail = err.response.data?.error?.message || '';
    if (status === 401 || status === 403) return `Authentication failed (HTTP ${status})${detail ? `: ${detail}` : ''}`;
    return `Cluster returned HTTP ${status}${detail ? `: ${detail}` : ''}`;
  }
  if (err?.code === 'NETAPP_NO_PASSWORD') return 'No password provided';
  if (err?.code) return `Network error: ${err.code}`;
  return err?.message || 'Connection failed';
}

// IP -> known machine name, from inventory the dashboard already polls
// (vCenter VMs then Aria deployment resources). Reimplemented inline —
// services/ipIdentity.js is pure db-driven with no other host dependency.
function buildIpIndex(db) {
  const map = new Map();
  const claim = (ip, name, source) => {
    if (ip && name && !map.has(ip)) map.set(ip, { name, source });
  };
  try {
    for (const vm of db.prepare('SELECT name, ip_address, guest_nics FROM vcenter_vms').all()) {
      claim(vm.ip_address, vm.name, 'vcenter');
      try {
        for (const nic of JSON.parse(vm.guest_nics || '[]')) {
          for (const ip of (nic.ips || [])) claim(ip, vm.name, 'vcenter');
        }
      } catch { /* malformed nic json */ }
    }
  } catch { /* vcenter tables absent */ }
  try {
    for (const r of db.prepare('SELECT name, ip_addresses FROM aria_deployment_resources WHERE ip_addresses IS NOT NULL').all()) {
      try {
        for (const ip of JSON.parse(r.ip_addresses)) claim(ip, r.name, 'aria');
      } catch { /* malformed */ }
    }
  } catch { /* aria tables absent */ }
  return map;
}

/* ── AIQUM connection + discovered clusters ──────────────────────────────── */

function handleGetArrays(req, res, coreApi) {
  res.json(coreApi.db.prepare('SELECT * FROM netapp_arrays ORDER BY name ASC').all().map(publicCluster));
}

function handleGetAiqum(req, res, coreApi) {
  const db = coreApi.db;
  const instances = db.prepare('SELECT * FROM netapp_aiqum_instances ORDER BY id').all();
  res.json({
    configured: instances.length > 0,
    instances: instances.map((r) => publicAiqumInstance(db, r)),
    clusterCount: db.prepare("SELECT COUNT(*) AS n FROM netapp_arrays WHERE source = 'aiqum'").get().n,
  });
}

function validateAiqumInstanceBody(b) {
  const errors = [];
  if (b.name !== undefined && b.name !== null && (typeof b.name !== 'string' || b.name.length > 120)) errors.push(fail('name'));
  if (!isNonEmptyString(b.host, 512)) errors.push(fail('host'));
  if (b.username !== undefined && b.username !== null && (typeof b.username !== 'string' || b.username.length > 256)) errors.push(fail('username'));
  if (b.password !== undefined && b.password !== null && (typeof b.password !== 'string' || b.password.length > 1024)) errors.push(fail('password'));
  if (b.pollIntervalMin !== undefined) {
    const n = parseIntStrict(b.pollIntervalMin);
    if (!Number.isInteger(n) || n < 5 || n > 1440) errors.push(fail('pollIntervalMin'));
  }
  return errors;
}

function handlePostAiqumInstances(req, res, coreApi) {
  const b = req.body || {};
  const errors = validateAiqumInstanceBody(b);
  if (errors.length) return badRequest(res, errors);
  const db = coreApi.db;
  const { name, host, username, password } = b;
  const pollIntervalMin = b.pollIntervalMin !== undefined ? parseIntStrict(b.pollIntervalMin) : undefined;
  const h = String(host).trim();
  if (isBlockedHost(h)) return res.status(400).json({ error: 'host is not allowed' });
  if (!username || !password) return res.status(400).json({ error: 'username and password are required' });
  if (db.prepare('SELECT id FROM netapp_aiqum_instances WHERE LOWER(host) = LOWER(?)').get(h)) {
    return res.status(409).json({ error: 'A gateway with that host already exists' });
  }
  const r = db.prepare(`
    INSERT INTO netapp_aiqum_instances (name, host, username, encrypted_credentials, poll_interval_minutes)
    VALUES (?, ?, ?, ?, ?)
  `).run(name?.trim() || h, h, username.trim(), coreApi.encryption.encrypt(password), pollIntervalMin || 15);
  getPollers(coreApi).reschedule();
  res.status(201).json(publicAiqumInstance(db, db.prepare('SELECT * FROM netapp_aiqum_instances WHERE id = ?').get(r.lastInsertRowid)));
}

function handlePutAiqumInstance(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const b = req.body || {};
  const errors = validateAiqumInstanceBody(b);
  if (errors.length) return badRequest(res, errors);
  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM netapp_aiqum_instances WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Gateway not found' });
  const { name, host, username, password } = b;
  const pollIntervalMin = b.pollIntervalMin !== undefined ? parseIntStrict(b.pollIntervalMin) : undefined;
  const h = String(host).trim();
  if (isBlockedHost(h)) return res.status(400).json({ error: 'host is not allowed' });
  const dup = db.prepare('SELECT id FROM netapp_aiqum_instances WHERE LOWER(host) = LOWER(?) AND id != ?').get(h, row.id);
  if (dup) return res.status(409).json({ error: 'A gateway with that host already exists' });
  db.prepare(`
    UPDATE netapp_aiqum_instances SET name = ?, host = ?, username = ?, encrypted_credentials = ?,
      poll_interval_minutes = ?, updated_at = datetime('now') WHERE id = ?
  `).run(
    name?.trim() || row.name, h,
    username?.trim() || row.username,
    password ? coreApi.encryption.encrypt(password) : row.encrypted_credentials,
    pollIntervalMin || row.poll_interval_minutes, row.id
  );
  getPollers(coreApi).reschedule();
  res.json(publicAiqumInstance(db, db.prepare('SELECT * FROM netapp_aiqum_instances WHERE id = ?').get(row.id)));
}

function handleDeleteAiqumInstance(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM netapp_aiqum_instances WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Gateway not found' });
  db.transaction(() => {
    db.prepare("DELETE FROM netapp_arrays WHERE source = 'aiqum' AND aiqum_instance_id = ?").run(row.id);
    db.prepare('DELETE FROM netapp_aiqum_instances WHERE id = ?').run(row.id);
  })();
  getPollers(coreApi).reschedule();
  res.json({ deleted: true });
}

async function handlePostAiqumInstancePoll(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const row = coreApi.db.prepare('SELECT * FROM netapp_aiqum_instances WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Gateway not found' });
  await getPollers(coreApi).syncAndPollInstance(row);
  res.json({ success: true });
}

async function handlePostAiqumTest(req, res, coreApi) {
  try {
    const b = req.body || {};
    let stored = { host: '', username: '', password: '' };
    if (b.id) {
      const row = coreApi.db.prepare('SELECT * FROM netapp_aiqum_instances WHERE id = ?').get(Number(b.id));
      if (row) stored = api.instanceConfig(row, coreApi);
    } else {
      stored = api.getAiqumConfig(coreApi);
    }
    const override = {
      host: b.host || stored.host,
      username: b.username || stored.username,
      password: b.password || stored.password,
    };
    res.json(await api.testAiqum(override, coreApi));
  } catch (err) {
    const status = err.response && err.response.status;
    res.status(200).json({ ok: false, error: status ? `HTTP ${status}` : (err.message || 'Connection failed') });
  }
}

/* ── Direct clusters CRUD (coexist with AIQUM-managed rows) ─────────────── */

async function handlePostArraysTest(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  if (!isNonEmptyString(b.mgmt_host)) errors.push(fail('mgmt_host'));
  else if (isBlockedHost(b.mgmt_host)) errors.push(fail('mgmt_host', 'mgmt_host is not allowed'));
  if (b.username !== undefined && b.username !== null && typeof b.username !== 'string') errors.push(fail('username'));
  if (b.ssl_verify !== undefined && !isBooleanish(b.ssl_verify)) errors.push(fail('ssl_verify'));
  if (b.id !== undefined && !Number.isInteger(parseIntStrict(b.id))) errors.push(fail('id'));
  if (errors.length) return badRequest(res, errors);
  try {
    let stored = null;
    if (b.id) {
      stored = coreApi.db.prepare("SELECT * FROM netapp_arrays WHERE id = ? AND source = 'direct'").get(b.id);
      if (!stored && (!b.password || !b.username)) {
        return res.status(200).json({ ok: false, error: 'Cluster not found' });
      }
    }
    const username = (b.username || '').trim() || stored?.username;
    if (!username) return res.status(200).json({ ok: false, error: 'No username provided' });
    if (!b.password && !stored) {
      return res.status(200).json({ ok: false, error: 'No password provided' });
    }
    const result = await api.testDirectConnection({
      mgmt_host: b.mgmt_host,
      username,
      password: b.password || undefined,
      encrypted_credentials: b.password ? undefined : stored?.encrypted_credentials,
      ssl_verify: b.ssl_verify ? 1 : 0,
    }, coreApi);
    res.json(result);
  } catch (err) {
    res.status(200).json({ ok: false, error: describeApiError(err) });
  }
}

function validateDirectArrayBody(b, { forUpdate = false } = {}) {
  const errors = [];
  if (!isNonEmptyString(b.name, 253)) errors.push(fail('name'));
  if (!isNonEmptyString(b.mgmt_host)) errors.push(fail('mgmt_host'));
  else if (isBlockedHost(b.mgmt_host)) errors.push(fail('mgmt_host', 'mgmt_host is not allowed'));
  if (forUpdate) {
    if (b.username !== undefined && b.username !== null && typeof b.username !== 'string') errors.push(fail('username'));
  } else if (!isNonEmptyString(b.username)) errors.push(fail('username'));
  if (b.polling_interval_minutes !== undefined) {
    const n = parseIntStrict(b.polling_interval_minutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) errors.push(fail('polling_interval_minutes'));
  }
  if (b.ssl_verify !== undefined && !isBooleanish(b.ssl_verify)) errors.push(fail('ssl_verify'));
  return errors;
}

function handlePostArrays(req, res, coreApi) {
  const b = req.body || {};
  const errors = validateDirectArrayBody(b);
  if (errors.length) return badRequest(res, errors);
  if (!b.password) return res.status(400).json({ error: 'password is required' });
  try {
    const db = coreApi.db;
    const info = db.prepare(`
      INSERT INTO netapp_arrays (name, mgmt_host, username, encrypted_credentials, polling_interval_minutes, ssl_verify, source)
      VALUES (?, ?, ?, ?, ?, ?, 'direct')
    `).run(
      b.name,
      api.normalizeHost(b.mgmt_host),
      b.username,
      buildDirectCredentials(b, coreApi),
      b.polling_interval_minutes ? parseIntStrict(b.polling_interval_minutes) : 15,
      toBool(b.ssl_verify) ? 1 : 0
    );
    const row = db.prepare('SELECT * FROM netapp_arrays WHERE id = ?').get(info.lastInsertRowid);
    const p = getPollers(coreApi);
    p.scheduleArray(row);
    p.triggerPoll(row.id).catch(() => {});
    res.status(201).json(publicCluster(row));
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A cluster with that name already exists' });
    }
    throw err;
  }
}

function handlePutArray(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const b = req.body || {};
  const errors = validateDirectArrayBody(b, { forUpdate: true });
  if (errors.length) return badRequest(res, errors);
  try {
    const db = coreApi.db;
    const existing = db.prepare('SELECT * FROM netapp_arrays WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Cluster not found' });
    if (existing.source === 'aiqum') {
      return res.status(403).json({ error: 'AIQUM-managed clusters are updated automatically' });
    }
    const encrypted = b.password ? buildDirectCredentials(b, coreApi) : existing.encrypted_credentials;
    db.prepare(`
      UPDATE netapp_arrays SET name = ?, mgmt_host = ?, username = ?, encrypted_credentials = ?,
        polling_interval_minutes = ?, ssl_verify = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      b.name,
      api.normalizeHost(b.mgmt_host),
      (b.username || '').trim() || existing.username,
      encrypted,
      b.polling_interval_minutes ? parseIntStrict(b.polling_interval_minutes) : existing.polling_interval_minutes,
      toBool(b.ssl_verify) ? 1 : 0,
      id
    );
    const row = db.prepare('SELECT * FROM netapp_arrays WHERE id = ?').get(id);
    getPollers(coreApi).scheduleArray(row);
    res.json(publicCluster(row));
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A cluster with that name already exists' });
    }
    throw err;
  }
}

function handleDeleteArray(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const existing = db.prepare('SELECT * FROM netapp_arrays WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Cluster not found' });
  if (existing.source === 'aiqum') {
    return res.status(403).json({ error: 'AIQUM-managed clusters cannot be deleted here' });
  }
  db.prepare('DELETE FROM netapp_arrays WHERE id = ?').run(id);
  getPollers(coreApi).cancelArray(id);
  res.json({ success: true });
}

async function handlePostPoll(req, res, coreApi) {
  await getPollers(coreApi).syncAndPollAll();
  res.json({ success: true });
}

async function handlePostArrayPoll(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const array = coreApi.db.prepare('SELECT * FROM netapp_arrays WHERE id = ?').get(id);
  if (!array) return res.status(404).json({ error: 'Cluster not found' });
  await getPollers(coreApi).triggerPoll(array.id);
  res.json({ success: true });
}

/* ── Telemetry reads ─────────────────────────────────────────────────────── */

function handleGetOverview(req, res, coreApi) {
  const db = coreApi.db;
  const arrays = db.prepare('SELECT * FROM netapp_arrays ORDER BY name ASC').all();
  const latestStmt = db.prepare('SELECT * FROM netapp_metrics_history WHERE array_id = ? ORDER BY captured_at DESC LIMIT 1');
  const alertStmt = db.prepare('SELECT COUNT(*) AS n FROM netapp_alerts WHERE array_id = ?');
  const volStmt = db.prepare('SELECT COUNT(*) AS n FROM netapp_volumes WHERE array_id = ?');
  const aggStmt = db.prepare('SELECT COUNT(*) AS n FROM netapp_aggregates WHERE array_id = ?');
  res.json(arrays.map((a) => ({
    ...publicCluster(a),
    latest: latestStmt.get(a.id) || null,
    open_alerts: alertStmt.get(a.id).n,
    volume_count: volStmt.get(a.id).n,
    aggregate_count: aggStmt.get(a.id).n,
  })));
}

function handleGetArrayMetricsHistory(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const daysQ = parseQueryInt(req.query.days, 1, 90);
  if (!daysQ.ok) return badRequest(res, [fail('days')]);
  const days = daysQ.value === undefined ? 7 : daysQ.value;
  const rows = coreApi.db.prepare(`
    SELECT * FROM netapp_metrics_history WHERE array_id = ? AND captured_at >= datetime('now', ?)
    ORDER BY captured_at ASC
  `).all(id, `-${days} days`);
  res.json(rows);
}

function handleGetAggregates(req, res, coreApi) {
  res.json(coreApi.db.prepare(`
    SELECT g.*, a.name AS array_name FROM netapp_aggregates g
    JOIN netapp_arrays a ON a.id = g.array_id ORDER BY a.name, g.name
  `).all());
}

function handleGetVolumes(req, res, coreApi) {
  res.json(coreApi.db.prepare(`
    SELECT v.*, a.name AS array_name FROM netapp_volumes v
    JOIN netapp_arrays a ON a.id = v.array_id ORDER BY v.used_bytes DESC
  `).all());
}

function handleGetAlerts(req, res, coreApi) {
  res.json(coreApi.db.prepare(`
    SELECT al.*, a.name AS array_name FROM netapp_alerts al
    JOIN netapp_arrays a ON a.id = al.array_id
    ORDER BY CASE LOWER(al.severity)
      WHEN 'emergency' THEN 0 WHEN 'alert' THEN 1 WHEN 'critical' THEN 2
      WHEN 'error' THEN 3 WHEN 'warning' THEN 4 ELSE 5 END, al.captured_at DESC
  `).all());
}

function handleGetArrayHardware(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  res.json({
    nodes: db.prepare('SELECT * FROM netapp_nodes WHERE array_id = ? ORDER BY name').all(id),
    disks: db.prepare('SELECT * FROM netapp_disks WHERE array_id = ? ORDER BY name').all(id),
    svms: db.prepare('SELECT * FROM netapp_svms WHERE array_id = ? ORDER BY name').all(id),
  });
}

function handleGetReplication(req, res, coreApi) {
  res.json(coreApi.db.prepare(`
    SELECT s.*, a.name AS array_name FROM netapp_snapmirror s
    JOIN netapp_arrays a ON a.id = s.array_id
    ORDER BY s.healthy ASC, s.lag_seconds DESC
  `).all());
}

function handleGetArrayNetwork(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  res.json(coreApi.db.prepare('SELECT * FROM netapp_lifs WHERE array_id = ? ORDER BY svm_name, name').all(id));
}

function handleGetQuotas(req, res, coreApi) {
  res.json(coreApi.db.prepare(`
    SELECT q.*, a.name AS array_name FROM netapp_quotas q
    JOIN netapp_arrays a ON a.id = q.array_id
    ORDER BY q.space_used_bytes DESC
  `).all());
}

function handleGetMounts(req, res, coreApi) {
  const db = coreApi.db;
  const ipIndex = buildIpIndex(db);
  const rows = db.prepare(`
    SELECT m.mount_type, m.client_ip, m.protocols, m.smb_users,
           m.svm_name, m.volume_name, a.name AS array_name,
           v.aggregate_name, v.type, v.style, v.junction_path,
           v.size_bytes, v.used_bytes, v.used_percent, v.state
    FROM (
      SELECT array_id, 'NFS' AS mount_type, client_ip, svm_name, volume_name,
             GROUP_CONCAT(DISTINCT protocol) AS protocols, NULL AS smb_users
      FROM netapp_nfs_clients
      GROUP BY array_id, client_ip, svm_name, volume_name
      UNION ALL
      SELECT array_id, 'SMB', client_ip, svm_name, volume_name,
             GROUP_CONCAT(DISTINCT protocol), GROUP_CONCAT(DISTINCT smb_user)
      FROM netapp_cifs_sessions
      GROUP BY array_id, client_ip, svm_name, volume_name
    ) m
    JOIN netapp_arrays a ON a.id = m.array_id
    LEFT JOIN netapp_volumes v
      ON v.array_id = m.array_id AND v.svm_name = m.svm_name AND v.name = m.volume_name
    ORDER BY m.client_ip, m.volume_name
  `).all().map((r) => ({ ...r, client_name: ipIndex.get(r.client_ip)?.name ?? null }));
  res.json(rows);
}

function handleGetNfs(req, res, coreApi) {
  const db = coreApi.db;
  const ipIndex = buildIpIndex(db);
  res.json({
    clients: db.prepare(`
      SELECT c.*, a.name AS array_name FROM netapp_nfs_clients c
      JOIN netapp_arrays a ON a.id = c.array_id
      ORDER BY c.client_ip
    `).all().map((c) => ({ ...c, client_name: ipIndex.get(c.client_ip)?.name ?? null })),
    exportRules: db.prepare(`
      SELECT r.*, a.name AS array_name FROM netapp_export_rules r
      JOIN netapp_arrays a ON a.id = r.array_id
      ORDER BY r.svm_name, r.policy_name, r.rule_index
    `).all(),
  });
}

function handleGetCifs(req, res, coreApi) {
  const db = coreApi.db;
  const ipIndex = buildIpIndex(db);
  res.json({
    sessions: db.prepare(`
      SELECT s.*, a.name AS array_name FROM netapp_cifs_sessions s
      JOIN netapp_arrays a ON a.id = s.array_id
      ORDER BY s.client_ip
    `).all().map((s) => ({ ...s, client_name: ipIndex.get(s.client_ip)?.name ?? null })),
    shares: db.prepare(`
      SELECT sh.*, a.name AS array_name FROM netapp_cifs_shares sh
      JOIN netapp_arrays a ON a.id = sh.array_id
      ORDER BY sh.svm_name, sh.share_name
    `).all(),
  });
}

// ── AI Advisor ───────────────────────────────────────────────────────────────

let advisorInstance = null;
function getAdvisor(coreApi) {
  if (!advisorInstance) advisorInstance = createNetappAdvisor(coreApi);
  return advisorInstance;
}

function advisorReportKey(slug) {
  return String(slug).replace(/-/g, '_');
}

function handleGetAdvisorReport(req, res, coreApi) {
  if (!isNonEmptyString(req.params.report)) return badRequest(res, [fail('report')]);
  const netappAdvisor = getAdvisor(coreApi);
  const key = advisorReportKey(req.params.report);
  if (!netappAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
  res.json({ enabled: netappAdvisor.isConfigured(), report: netappAdvisor.getCachedReport(key) });
}

async function handlePostAdvisorReport(req, res, coreApi) {
  if (!isNonEmptyString(req.params.report)) return badRequest(res, [fail('report')]);
  const netappAdvisor = getAdvisor(coreApi);
  const key = advisorReportKey(req.params.report);
  if (!netappAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
  try {
    const result = await netappAdvisor.generateReport(key);
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
  { method: 'GET', ...compile('/arrays'), handler: handleGetArrays },
  { method: 'GET', ...compile('/aiqum'), handler: handleGetAiqum },
  { method: 'POST', ...compile('/aiqum/instances'), handler: handlePostAiqumInstances },
  { method: 'PUT', ...compile('/aiqum/instances/:id'), handler: handlePutAiqumInstance },
  { method: 'DELETE', ...compile('/aiqum/instances/:id'), handler: handleDeleteAiqumInstance },
  { method: 'POST', ...compile('/aiqum/instances/:id/poll'), handler: handlePostAiqumInstancePoll },
  { method: 'POST', ...compile('/aiqum/test'), handler: handlePostAiqumTest },
  { method: 'POST', ...compile('/arrays/test'), handler: handlePostArraysTest },
  { method: 'POST', ...compile('/arrays'), handler: handlePostArrays },
  { method: 'PUT', ...compile('/arrays/:id'), handler: handlePutArray },
  { method: 'DELETE', ...compile('/arrays/:id'), handler: handleDeleteArray },
  { method: 'POST', ...compile('/poll'), handler: handlePostPoll },
  { method: 'POST', ...compile('/arrays/:id/poll'), handler: handlePostArrayPoll },
  { method: 'GET', ...compile('/overview'), handler: handleGetOverview },
  { method: 'GET', ...compile('/arrays/:id/metrics/history'), handler: handleGetArrayMetricsHistory },
  { method: 'GET', ...compile('/aggregates'), handler: handleGetAggregates },
  { method: 'GET', ...compile('/volumes'), handler: handleGetVolumes },
  { method: 'GET', ...compile('/alerts'), handler: handleGetAlerts },
  { method: 'GET', ...compile('/arrays/:id/hardware'), handler: handleGetArrayHardware },
  { method: 'GET', ...compile('/replication'), handler: handleGetReplication },
  { method: 'GET', ...compile('/arrays/:id/network'), handler: handleGetArrayNetwork },
  { method: 'GET', ...compile('/quotas'), handler: handleGetQuotas },
  { method: 'GET', ...compile('/mounts'), handler: handleGetMounts },
  { method: 'GET', ...compile('/nfs'), handler: handleGetNfs },
  { method: 'GET', ...compile('/cifs'), handler: handleGetCifs },
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
  return function netappRouter(req, res, next) {
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
