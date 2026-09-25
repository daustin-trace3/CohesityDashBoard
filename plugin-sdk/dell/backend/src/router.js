// Dell OME routes, ported from backend/routes/dell.js + backend/routes/
// dellReports.js. Mounted by the host dispatcher at /api/dell — paths below
// are relative.
//
// DEVIATION FROM THE BUILT-IN: bundled plugins cannot require the host's
// express/express-validator — createRouter must return a BARE (req, res,
// next) function (plugin-sdk/unifi/nutanix router.js pattern). This file
// hand-matches req.method/req.path against a route table (compile.js) and
// re-implements the validation express-validator did inline (validate.js),
// preserving the same status codes (400 invalid params, 404 missing, 409
// duplicate, 502 upstream/test-connection failure, 503/429 advisor errors)
// and JSON response shapes exactly. The reports sub-router
// (backend/routes/dellReports.js, mounted at /reports on the built-in) is
// merged into the same flat route table here (reports.js's REPORT_ROUTES,
// paths already prefixed with /reports/...).
const api = require('./api');
const { getPoller } = require('./poller');
const { computeIssues, warrantyWarnDays, warrantyAlertFilter } = require('./issues');
const { createDellAdvisor } = require('./advisor');
const { compile } = require('./compile');
const { fingerprint: varianceFingerprint } = require('./variance');
const { vcenterHostUtilization } = require('./vcenterUtil');
const { REPORT_ROUTES } = require('./reports');
const {
  badRequest, fail, parseIntStrict, isNonEmptyString, isBooleanish, toBool,
  requireIdParam, parseQueryInt,
} = require('./validate');

// Accepted-variance join used by every compliance read. A variance is keyed
// on (ome, baseline, device); only state 'active' hides a device from the
// not-compliant views. 'stale' means the drift changed after acceptance.
const VARIANCE_JOIN = `LEFT JOIN dell_config_variances v
  ON v.ome_id = c.ome_id AND v.baseline_id = c.baseline_id AND v.device_id = c.device_id`;
const EFFECTIVE_STATUS = `CASE WHEN c.status = 'noncompliant' AND v.state = 'active' THEN 'accepted' ELSE c.status END AS effective_status`;
const VARIANCE_COLS = `v.id AS variance_id, v.state AS variance_state, v.reason AS variance_reason,
  v.accepted_by AS variance_by, v.accepted_at AS variance_at, v.stale_at AS variance_stale_at,
  v.drift_count AS variance_drift_count`;

const publicOme = (row) => ({
  id: row.id, name: row.name, host: row.host, username: row.username,
  sslVerify: !!row.ssl_verify, pollingIntervalMinutes: row.polling_interval_minutes,
  lastPollStatus: row.last_poll_status, lastPollError: row.last_poll_error, lastPollAt: row.last_poll_at,
  version: row.version,
});

// ── instance registration CRUD ──────────────────────────────────────────────

/** GET /instances — registered OME appliances (never the credentials). */
function handleGetInstances(req, res, coreApi) {
  res.json(coreApi.db.prepare('SELECT * FROM dell_ome_instances ORDER BY name').all().map(publicOme));
}

/** POST /instances — register an OME appliance. */
function handlePostInstances(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  if (!isNonEmptyString(b.name, 120)) errors.push(fail('name'));
  if (!isNonEmptyString(b.host, 253)) errors.push(fail('host'));
  if (!isNonEmptyString(b.username, 256)) errors.push(fail('username'));
  if (!isNonEmptyString(b.password, 512)) errors.push(fail('password'));
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (b.pollingIntervalMinutes !== undefined) {
    const n = parseIntStrict(b.pollingIntervalMinutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) errors.push(fail('pollingIntervalMinutes'));
  }
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  const name = b.name.trim();
  const host = b.host.trim();
  const dup = db.prepare('SELECT id FROM dell_ome_instances WHERE name = ? OR host = ?').get(name, host);
  if (dup) return res.status(409).json({ error: 'An OME instance with that name or host is already registered.' });
  const info = db.prepare(`
    INSERT INTO dell_ome_instances (name, host, username, encrypted_credentials, ssl_verify, polling_interval_minutes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, host, b.username.trim(),
    coreApi.encryption.encrypt(JSON.stringify({ password: b.password })),
    toBool(b.sslVerify) ? 1 : 0, b.pollingIntervalMinutes ? parseIntStrict(b.pollingIntervalMinutes) : 15);
  const row = db.prepare('SELECT * FROM dell_ome_instances WHERE id = ?').get(info.lastInsertRowid);
  const poller = getPoller(coreApi);
  poller.schedule(row);
  poller.trigger(row).catch(() => {});
  res.status(201).json(publicOme(row));
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
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (b.pollingIntervalMinutes !== undefined) {
    const n = parseIntStrict(b.pollingIntervalMinutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) errors.push(fail('pollingIntervalMinutes'));
  }
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM dell_ome_instances WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'OME instance not found.' });
  db.prepare(`
    UPDATE dell_ome_instances SET
      name = ?, host = ?, username = ?, encrypted_credentials = ?,
      ssl_verify = ?, polling_interval_minutes = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    b.name?.trim() || row.name, b.host?.trim() || row.host, b.username?.trim() || row.username,
    b.password ? coreApi.encryption.encrypt(JSON.stringify({ password: b.password })) : row.encrypted_credentials,
    b.sslVerify !== undefined ? (toBool(b.sslVerify) ? 1 : 0) : row.ssl_verify,
    b.pollingIntervalMinutes ? parseIntStrict(b.pollingIntervalMinutes) : row.polling_interval_minutes,
    row.id
  );
  api.invalidateSession(row.id);
  const updated = db.prepare('SELECT * FROM dell_ome_instances WHERE id = ?').get(row.id);
  getPoller(coreApi).schedule(updated);
  res.json(publicOme(updated));
}

/** DELETE /instances/:id — unregister (CASCADE clears inventory). */
function handleDeleteInstance(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM dell_ome_instances WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'OME instance not found.' });
  getPoller(coreApi).cancel(row.id);
  api.invalidateSession(row.id);
  db.prepare('DELETE FROM dell_ome_instances WHERE id = ?').run(row.id);
  res.json({ deleted: true });
}

/** POST /instances/test — validate saved or candidate credentials. */
async function handlePostInstancesTest(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  if (!isNonEmptyString(b.host)) errors.push(fail('host'));
  if (!isNonEmptyString(b.username)) errors.push(fail('username'));
  if (b.password !== undefined && typeof b.password !== 'string') errors.push(fail('password'));
  if (b.id !== undefined && !Number.isInteger(parseIntStrict(b.id))) errors.push(fail('id'));
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (errors.length) return badRequest(res, errors);

  const { id, host, username, password, sslVerify } = b;
  let candidate = { host: host.trim(), username: username.trim(), password, ssl_verify: toBool(sslVerify) ? 1 : 0 };
  if (!password && id) {
    const row = coreApi.db.prepare('SELECT * FROM dell_ome_instances WHERE id = ?').get(parseIntStrict(id));
    if (row) candidate = { ...row, host: candidate.host, username: candidate.username, ssl_verify: candidate.ssl_verify };
  }
  if (!candidate.password && !candidate.encrypted_credentials) {
    return res.status(400).json({ ok: false, message: 'Enter the password to test this connection.' });
  }
  const result = await api.testConnection(candidate, coreApi);
  res.status(result.ok ? 200 : 502).json(result);
}

/** POST /instances/:id/refresh — poll this instance now. */
async function handlePostInstanceRefresh(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM dell_ome_instances WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'OME instance not found.' });
  await getPoller(coreApi).trigger(row);
  res.json(publicOme(db.prepare('SELECT * FROM dell_ome_instances WHERE id = ?').get(row.id)));
}

/** GET /instances/:id/inventory-probe?deviceId= — raw inventory layout for
 *  one device (live-shape debugging: section names, counts, first item
 *  each). Read-only against the appliance. */
async function handleGetInventoryProbe(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const deviceQ = parseQueryInt(req.query.deviceId);
  if (!deviceQ.ok || deviceQ.value === undefined) return badRequest(res, [fail('deviceId')]);
  const row = coreApi.db.prepare('SELECT * FROM dell_ome_instances WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'OME instance not found.' });
  res.json(await api.probeInventory(row, coreApi, deviceQ.value));
}

/** GET /instances/:id/audit-probe?deviceId= — raw first items from the
 *  compliance/jobs/profiles/hardware-log listings (live-shape debugging for
 *  the governance features, same role as inventory-probe). */
async function handleGetAuditProbe(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const deviceQ = parseQueryInt(req.query.deviceId);
  if (!deviceQ.ok) return badRequest(res, [fail('deviceId')]);
  const row = coreApi.db.prepare('SELECT * FROM dell_ome_instances WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'OME instance not found.' });
  res.json(await api.probeAudit(row, coreApi, deviceQ.value ?? null));
}

// ── Data endpoints ───────────────────────────────────────────────────────────

/** GET /overview — fleet rollup + computed issues. */
function handleGetOverview(req, res, coreApi) {
  const db = coreApi.db;
  const instances = db.prepare('SELECT * FROM dell_ome_instances ORDER BY name').all();
  const devAgg = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN health = 'ok' THEN 1 ELSE 0 END) AS ok,
      SUM(CASE WHEN health = 'warning' THEN 1 ELSE 0 END) AS warning,
      SUM(CASE WHEN health = 'critical' THEN 1 ELSE 0 END) AS critical,
      SUM(CASE WHEN health NOT IN ('ok','warning','critical') THEN 1 ELSE 0 END) AS unknown,
      SUM(CASE WHEN power_state = 'on' THEN 1 ELSE 0 END) AS powered_on,
      SUM(CASE WHEN power_state = 'off' THEN 1 ELSE 0 END) AS powered_off,
      SUM(CASE WHEN connection_state = 0 THEN 1 ELSE 0 END) AS disconnected
    FROM dell_devices
  `).get();
  const typeBreakdown = db.prepare(`
    SELECT device_type, COUNT(*) AS count FROM dell_devices GROUP BY device_type ORDER BY count DESC
  `).all();
  const modelBreakdown = db.prepare(`
    SELECT model, COUNT(*) AS count FROM dell_devices WHERE model IS NOT NULL
    GROUP BY model ORDER BY count DESC LIMIT 12
  `).all();
  const capacity = db.prepare(`
    SELECT SUM(cpu_count) AS sockets, SUM(core_count) AS cores,
      SUM(memory_bytes) AS memory_bytes, SUM(disk_bytes) AS disk_bytes,
      SUM(power_w) AS power_w
    FROM dell_devices
  `).get();
  const diskMedia = db.prepare(`
    SELECT COALESCE(json_extract(extra, '$.mediaType'), 'Unknown') AS media,
      COUNT(*) AS count, SUM(size_bytes) AS bytes
    FROM dell_components WHERE kind = 'disk' GROUP BY media ORDER BY count DESC
  `).all();
  const alertAgg = db.prepare(`
    SELECT
      SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS critical,
      SUM(CASE WHEN severity = 'warning' THEN 1 ELSE 0 END) AS warning
    FROM dell_alerts WHERE created_at >= datetime('now', '-7 days')
  `).get();
  const alertPrev = db.prepare(`
    SELECT SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS critical
    FROM dell_alerts
    WHERE created_at >= datetime('now', '-14 days') AND created_at < datetime('now', '-7 days')
  `).get();
  const utilization = db.prepare(`
    SELECT AVG(cpu_util_pct) AS cpu_avg, AVG(mem_util_pct) AS mem_avg,
      MAX(inlet_temp_c) AS temp_max, AVG(inlet_temp_c) AS temp_avg,
      COUNT(cpu_util_pct) AS metered
    FROM dell_devices
  `).get();
  // No Power Manager anywhere? Derive CPU/memory utilization from vCenter:
  // Dell servers running ESXi are matched to vcenter_hosts via the OS
  // hostname OME reports (exact, then short-name fallback — see
  // vcenterUtil.js), and their quickstats stand in for the plugin.
  let vcUtil = null;
  const vcenterUtil = () => {
    if (vcUtil === null) {
      try { vcUtil = vcenterHostUtilization(db); } catch { vcUtil = []; /* vCenter tables unavailable */ }
    }
    return vcUtil;
  };
  if (!utilization.metered) {
    const vc = vcenterUtil();
    if (vc.length) {
      utilization.cpu_avg = vc.reduce((s, r) => s + r.cpu_util_pct, 0) / vc.length;
      utilization.mem_avg = vc.reduce((s, r) => s + r.mem_util_pct, 0) / vc.length;
      utilization.metered = vc.length;
      utilization.source = 'vcenter';
    }
  }
  const alertsByDay = db.prepare(`
    SELECT date(created_at) AS day,
      SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS critical,
      SUM(CASE WHEN severity = 'warning' THEN 1 ELSE 0 END) AS warning,
      SUM(CASE WHEN severity NOT IN ('critical', 'warning') THEN 1 ELSE 0 END) AS info
    FROM dell_alerts WHERE created_at >= datetime('now', '-14 days')
    GROUP BY day ORDER BY day
  `).all();
  const powerTrend = db.prepare(`
    SELECT o.name AS ome_name, date(m.captured_at) AS day, MAX(m.power_w_total) AS power_w
    FROM dell_metrics_history m JOIN dell_ome_instances o ON o.id = m.ome_id
    WHERE m.captured_at >= datetime('now', '-30 days') AND m.power_w_total IS NOT NULL
    GROUP BY o.name, day ORDER BY day
  `).all();
  let topUtil = db.prepare(`
    SELECT name, cpu_util_pct, mem_util_pct FROM dell_devices
    WHERE cpu_util_pct IS NOT NULL OR mem_util_pct IS NOT NULL
    ORDER BY MAX(COALESCE(cpu_util_pct, 0), COALESCE(mem_util_pct, 0)) DESC LIMIT 30
  `).all();
  if (!topUtil.length) {
    topUtil = vcenterUtil()
      .map(({ name, cpu_util_pct, mem_util_pct }) => ({ name, cpu_util_pct, mem_util_pct }))
      .sort((a, b) => Math.max(b.cpu_util_pct, b.mem_util_pct) - Math.max(a.cpu_util_pct, a.mem_util_pct))
      .slice(0, 30);
  }
  const warnDays = warrantyWarnDays(coreApi);
  const warrantyAgg = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN best IS NOT NULL AND best <= 0 THEN 1 ELSE 0 END) AS expired,
      SUM(CASE WHEN best > 0 AND best <= ? THEN 1 ELSE 0 END) AS expiring
    FROM (SELECT MAX(days_remaining) AS best FROM dell_warranties GROUP BY ome_id, service_tag)
  `).get(warnDays);
  const firmwareAgg = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'noncompliant' THEN 1 ELSE 0 END) AS noncompliant
    FROM dell_firmware_compliance
  `).get();
  const failingComponents = db.prepare(`
    SELECT COUNT(*) AS n FROM dell_components WHERE status IN ('critical', 'warning')
  `).get().n;
  const configCompliance = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN c.status = 'noncompliant' AND v.state IS NOT 'active' THEN 1 ELSE 0 END) AS noncompliant,
      SUM(CASE WHEN c.status = 'noncompliant' AND v.state = 'active' THEN 1 ELSE 0 END) AS accepted
    FROM dell_config_compliance c ${VARIANCE_JOIN}
  `).get();
  const jobs24h = db.prepare(`
    SELECT SUM(CASE WHEN last_run_status_id = 2070 THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN last_run_status_id = 2090 THEN 1 ELSE 0 END) AS warning
    FROM dell_jobs WHERE last_run >= datetime('now', '-1 day')
  `).get();
  res.json({
    instances: instances.map(publicOme),
    devices: devAgg,
    typeBreakdown, modelBreakdown, capacity, diskMedia,
    alerts7d: { ...alertAgg, critical_prev: alertPrev.critical || 0 },
    utilization,
    alertsByDay, powerTrend, topUtil,
    warranty: { ...warrantyAgg, warnDays },
    firmware: firmwareAgg,
    configCompliance,
    jobs24h,
    failingComponents,
    issues: computeIssues(coreApi),
  });
}

/** GET /devices — inventory list (optional ?omeId=&type=&health=). */
function handleGetDevices(req, res, coreApi) {
  const omeQ = parseQueryInt(req.query.omeId);
  if (!omeQ.ok) return badRequest(res, [fail('omeId')]);
  const clauses = [];
  const params = [];
  if (omeQ.value !== undefined) { clauses.push('d.ome_id = ?'); params.push(omeQ.value); }
  if (req.query.type) { clauses.push('d.device_type = ?'); params.push(String(req.query.type).trim()); }
  if (req.query.health) { clauses.push('d.health = ?'); params.push(String(req.query.health).trim()); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  res.json(coreApi.db.prepare(`
    SELECT d.*, o.name AS ome_name,
      cc.compliance_status, cc.compliance_drift, cc.compliance_report_id
    FROM dell_devices d
    JOIN dell_ome_instances o ON o.id = d.ome_id
    LEFT JOIN (
      SELECT c.ome_id, c.device_id,
        CASE WHEN SUM(c.status = 'noncompliant' AND v.state IS NOT 'active') > 0 THEN 'noncompliant'
             WHEN SUM(c.status = 'noncompliant' AND v.state = 'active') > 0 THEN 'accepted'
             WHEN SUM(c.status = 'compliant') > 0 THEN 'compliant'
             ELSE MIN(c.status) END AS compliance_status,
        SUM(CASE WHEN c.detail IS NULL THEN 0 ELSE json_array_length(c.detail) END) AS compliance_drift,
        MAX(CASE WHEN c.status = 'noncompliant' THEN c.id END) AS compliance_report_id
      FROM dell_config_compliance c ${VARIANCE_JOIN} GROUP BY c.ome_id, c.device_id
    ) cc ON cc.ome_id = d.ome_id AND cc.device_id = d.device_id
    ${where} ORDER BY d.name
  `).all(...params));
}

/** GET /devices/:id — one device + components + recent alerts. */
function handleGetDeviceById(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const dev = db.prepare(`
    SELECT d.*, o.name AS ome_name FROM dell_devices d
    JOIN dell_ome_instances o ON o.id = d.ome_id WHERE d.id = ?
  `).get(id);
  if (!dev) return res.status(404).json({ error: 'Device not found.' });
  const components = db.prepare(`
    SELECT * FROM dell_components WHERE ome_id = ? AND device_id = ? ORDER BY kind, slot, name
  `).all(dev.ome_id, dev.device_id).map((c) => ({ ...c, extra: c.extra ? JSON.parse(c.extra) : null }));
  const alerts = db.prepare(`
    SELECT * FROM dell_alerts WHERE ome_id = ? AND (service_tag = ? OR device_name = ?)
    ORDER BY created_at DESC LIMIT 50
  `).all(dev.ome_id, dev.service_tag, dev.name);
  const warranty = db.prepare(`
    SELECT * FROM dell_warranties WHERE ome_id = ? AND service_tag = ? ORDER BY days_remaining DESC
  `).all(dev.ome_id, dev.service_tag);
  const firmware = db.prepare(`
    SELECT * FROM dell_firmware_compliance WHERE ome_id = ? AND (service_tag = ? OR device_id = ?)
  `).all(dev.ome_id, dev.service_tag, dev.device_id);
  const configCompliance = db.prepare(`
    SELECT c.id, c.baseline_id, c.baseline_name, c.status, c.inventory_time,
      CASE WHEN c.detail IS NULL THEN 0 ELSE json_array_length(c.detail) END AS drift_count,
      ${EFFECTIVE_STATUS}, ${VARIANCE_COLS}
    FROM dell_config_compliance c ${VARIANCE_JOIN}
    WHERE c.ome_id = ? AND (c.device_id = ? OR c.service_tag = ?)
  `).all(dev.ome_id, dev.device_id, dev.service_tag);
  const hardwareLogs = db.prepare(`
    SELECT * FROM dell_hardware_logs WHERE ome_id = ? AND device_id = ?
    ORDER BY created_at DESC LIMIT 25
  `).all(dev.ome_id, dev.device_id);
  res.json({ ...dev, components, alerts, warranty, firmware, configCompliance, hardwareLogs });
}

/** GET /alerts?days=7 — alert feed across instances. device_row_id resolves
 *  the alerting device to its inventory row for the detail modal. */
function handleGetAlerts(req, res, coreApi) {
  const daysQ = parseQueryInt(req.query.days, 1, 90);
  if (!daysQ.ok) return badRequest(res, [fail('days')]);
  const days = daysQ.value === undefined ? 7 : daysQ.value;
  res.json(coreApi.db.prepare(`
    SELECT a.*, o.name AS ome_name, d.id AS device_row_id
    FROM dell_alerts a
    JOIN dell_ome_instances o ON o.id = a.ome_id
    LEFT JOIN dell_devices d ON d.ome_id = a.ome_id
      AND (d.service_tag = a.service_tag OR d.name = a.device_name)
    WHERE a.created_at >= datetime('now', ?)
    ORDER BY a.created_at DESC LIMIT 5000
  `).all(`-${days} days`).filter(warrantyAlertFilter(coreApi)));
}

/* Shared CSV export builder. `db` is the tenant handle. Returns
 * { csv, filename } or null when a requested device row does not exist.
 *   ids      - array of dell_devices.id to export (null = every device)
 *   include  - Set of group keys (see EXPORT_GROUPS)
 *   layout   - 'devices' (one row per device, summary columns per group) or
 *              'components' (one row per component of the chosen groups) */
const EXPORT_GROUPS = {
  cpu: { kind: 'processor', label: 'Processor' },
  memory: { kind: 'memory', label: 'Memory' },
  network: { kind: 'nic', label: 'NIC' },
  raid: { kind: 'raid', label: 'RAID Controller' },
  vdisk: { kind: 'vdisk', label: 'Virtual Disk' },
  disk: { kind: 'disk', label: 'Physical Disk' },
  fc: { kind: 'fc', label: 'FC Card' },
  psu: { kind: 'psu', label: 'Power Supply' },
  os: { kind: 'os', label: 'Operating System' },
};

function parseExportInclude(raw) {
  const keys = Array.isArray(raw) ? raw : String(raw || '').split(',');
  return new Set(keys.map((s) => String(s).trim()).filter((k) => EXPORT_GROUPS[k]));
}

function buildDellExport(db, { ids = null, include, layout = 'devices' }) {
  let devices = db.prepare(`
    SELECT d.*, o.name AS ome_name FROM dell_devices d
    JOIN dell_ome_instances o ON o.id = d.ome_id
    ORDER BY d.name
  `).all();
  if (ids) {
    const want = new Set(ids);
    devices = devices.filter((d) => want.has(d.id));
    if (devices.length === 0) return null;
  }

  const compsByDevice = new Map();
  for (const c of db.prepare('SELECT * FROM dell_components').all()) {
    const key = `${c.ome_id}|${c.device_id}`;
    if (!compsByDevice.has(key)) compsByDevice.set(key, []);
    compsByDevice.get(key).push(c);
  }
  const warByTag = new Map();
  for (const w of db.prepare('SELECT * FROM dell_warranties').all()) {
    // Keep the longest-running contract per service tag.
    const prev = warByTag.get(w.service_tag);
    if (!prev || (w.days_remaining ?? -1) > (prev.days_remaining ?? -1)) warByTag.set(w.service_tag, w);
  }

  const gb = (b) => (b != null ? (b / 1024 ** 3).toFixed(0) : '');
  const extraOf = (c) => { try { return JSON.parse(c.extra || '{}') || {}; } catch { return {}; } };
  const join = (parts) => parts.filter(Boolean).join(' ');
  const list = (items) => items.filter(Boolean).join('; ');
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const stamp = new Date().toISOString().slice(0, 10);
  const kinds = [...include].map((k) => EXPORT_GROUPS[k].kind);
  const lines = [];

  if (layout === 'components') {
    lines.push(['Device Name', 'Service Tag', 'Device Model', 'Device Type', 'IP Address', 'OME Instance',
      'Component', 'Name', 'Description', 'Slot', 'Component Model', 'Serial', 'Size (GB)', 'Speed', 'Status', 'Details']
      .map(esc).join(','));
    const labelOf = {};
    for (const g of Object.values(EXPORT_GROUPS)) labelOf[g.kind] = g.label;
    for (const d of devices) {
      const comps = (compsByDevice.get(`${d.ome_id}|${d.device_id}`) || []).filter((c) => kinds.includes(c.kind));
      for (const c of comps) {
        const x = extraOf(c);
        let details;
        if (c.kind === 'nic') {
          details = list((x.ports || []).map((p) => join([p.portId != null ? `port ${p.portId}` : null, p.linkStatus,
            p.linkSpeed, (p.macs || []).length ? `MAC ${(p.macs || []).join(' ')}` : null])));
          if (x.vendor) details = list([`vendor ${x.vendor}`, details]);
        } else {
          details = list(Object.entries(x).map(([k, v]) => {
            if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) return null;
            return `${k} ${Array.isArray(v) ? v.join(' ') : v}`;
          }));
        }
        lines.push([d.name, d.service_tag, d.model, d.device_type, d.ip_address, d.ome_name,
          labelOf[c.kind] || c.kind, c.name, c.description, c.slot, c.model, c.serial,
          c.size_bytes != null ? gb(c.size_bytes) : '', c.speed, c.status, details].map(esc).join(','));
      }
    }
    return { csv: lines.join('\r\n'), filename: `dell-components-${stamp}.csv` };
  }

  const header = ['Device Name', 'Service Tag', 'Model', 'Type', 'IP Address', 'Health', 'Power State', 'OME Instance',
    'Support Level', 'Support End', 'Support Days Left'];
  if (include.has('cpu')) header.push('CPU Sockets', 'CPU Cores', 'CPU Models');
  if (include.has('memory')) header.push('Memory (GB)', 'DIMM Count', 'DIMM Detail');
  if (include.has('network')) header.push('NIC Count', 'NICs', 'MAC Addresses');
  if (include.has('raid')) header.push('RAID Controllers', 'RAID Controller Detail');
  if (include.has('vdisk')) header.push('Virtual Disks', 'Virtual Disk Detail');
  if (include.has('disk')) header.push('Physical Disks', 'Raw Disk (GB)', 'Physical Disk Detail', 'Physical Disk Serials');
  if (include.has('fc')) header.push('FC Ports', 'FC Detail', 'WWPNs');
  if (include.has('psu')) header.push('PSU Count', 'PSU Detail', 'PSU Serials');
  if (include.has('os')) header.push('OS', 'OS Version', 'OS Hostname');
  lines.push(header.map(esc).join(','));

  for (const d of devices) {
    const comps = compsByDevice.get(`${d.ome_id}|${d.device_id}`) || [];
    const ofKind = (k) => comps.filter((c) => c.kind === k);
    const war = warByTag.get(d.service_tag);
    const row = [d.name, d.service_tag, d.model, d.device_type, d.ip_address, d.health, d.power_state, d.ome_name,
      war?.service_level ?? '', war?.end_date ? String(war.end_date).slice(0, 10) : '',
      war?.days_remaining ?? ''];
    if (include.has('cpu')) {
      const cpus = ofKind('processor');
      row.push(d.cpu_count ?? (cpus.length || ''), d.core_count ?? '',
        [...new Set(cpus.map((c) => c.name).filter(Boolean))].join('; '));
    }
    if (include.has('memory')) {
      const dimms = ofKind('memory');
      row.push(gb(d.memory_bytes), dimms.length || '',
        [...new Set(dimms.map((c) => `${gb(c.size_bytes)}GB ${c.speed || ''}`.trim()))].join('; '));
    }
    if (include.has('network')) {
      const nics = ofKind('nic');
      const macs = [];
      for (const n of nics) for (const p of (extraOf(n).ports || [])) macs.push(...(p.macs || []));
      row.push(nics.length || '', [...new Set(nics.map((c) => c.description || c.name).filter(Boolean))].join('; '),
        macs.join('; '));
    }
    if (include.has('raid')) {
      const ctrls = ofKind('raid');
      row.push(ctrls.length || '', list(ctrls.map((c) => {
        const x = extraOf(c);
        return join([c.name || c.description, c.slot ? `slot ${c.slot}` : null, x.firmware ? `fw ${x.firmware}` : null,
          x.cacheMb ? `${x.cacheMb}MB cache` : null, c.status]);
      })));
    }
    if (include.has('vdisk')) {
      const vds = ofKind('vdisk');
      row.push(vds.length || '', list(vds.map((c) => {
        const x = extraOf(c);
        return join([c.name, c.speed || c.description, c.size_bytes ? `${gb(c.size_bytes)}GB` : null,
          x.controller ? `on ${x.controller}` : null, c.status]);
      })));
    }
    if (include.has('disk')) {
      const disks = ofKind('disk');
      const raw = disks.reduce((s, c) => s + (c.size_bytes || 0), 0);
      row.push(disks.length || '', gb(d.disk_bytes ?? (raw || null)), list(disks.map((c) => {
        const x = extraOf(c);
        return join([c.slot != null ? `slot ${c.slot}` : null, c.model || c.name, c.size_bytes ? `${gb(c.size_bytes)}GB` : null,
          x.mediaType, x.busType, x.raidStatus, x.endurance != null ? `${x.endurance}% endurance` : null, c.status]);
      })), list(disks.map((c) => c.serial)));
    }
    if (include.has('fc')) {
      const fcs = ofKind('fc');
      row.push(fcs.length || '', list(fcs.map((c) => {
        const x = extraOf(c);
        return join([c.name || c.description, c.slot, c.speed, x.linkStatus ? `link ${x.linkStatus}` : null]);
      })), list(fcs.map((c) => extraOf(c).wwpn || c.serial)));
    }
    if (include.has('psu')) {
      const psus = ofKind('psu');
      row.push(psus.length || '', list(psus.map((c) => {
        const x = extraOf(c);
        return join([c.name, c.model, c.slot, c.speed, x.firmware ? `fw ${x.firmware}` : null, c.status]);
      })), list(psus.map((c) => c.serial)));
    }
    if (include.has('os')) {
      const os = ofKind('os')[0];
      row.push(os?.name ?? '', os?.description ?? '', os ? (extraOf(os).hostname ?? '') : '');
    }
    lines.push(row.map(esc).join(','));
  }
  return { csv: lines.join('\r\n'), filename: `dell-inventory-${stamp}.csv` };
}

/** GET /export?include=...&deviceId=&layout= and POST /export { ids, include, layout }
 *  - CSV inventory export. The POST form carries the device ids the Devices
 *  page currently shows (search and dropdown filters applied). */
const EXPORT_LAYOUTS = ['devices', 'components'];
function sendExport(res, db, { ids, include, layout }) {
  const out = buildDellExport(db, {
    ids, include: parseExportInclude(include), layout: EXPORT_LAYOUTS.includes(layout) ? layout : 'devices',
  });
  if (!out) return res.status(404).json({ error: 'Device not found.' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.send(out.csv);
}
function handleGetExport(req, res, coreApi) {
  const deviceQ = parseQueryInt(req.query.deviceId);
  if (!deviceQ.ok) return badRequest(res, [fail('deviceId')]);
  if (req.query.layout !== undefined && !EXPORT_LAYOUTS.includes(req.query.layout)) return badRequest(res, [fail('layout')]);
  sendExport(res, coreApi.db, {
    ids: deviceQ.value !== undefined ? [deviceQ.value] : null, include: req.query.include, layout: req.query.layout,
  });
}
function handlePostExport(req, res, coreApi) {
  const b = req.body || {};
  let ids = null;
  if (b.ids != null) {
    if (!Array.isArray(b.ids) || b.ids.length > 50000) return badRequest(res, [fail('ids')]);
    ids = b.ids.map((v) => parseIntStrict(v));
    if (ids.some((n) => !Number.isInteger(n))) return badRequest(res, [fail('ids')]);
  }
  if (b.include !== undefined && typeof b.include !== 'string' && !Array.isArray(b.include)) return badRequest(res, [fail('include')]);
  if (b.layout !== undefined && !EXPORT_LAYOUTS.includes(b.layout)) return badRequest(res, [fail('layout')]);
  sendExport(res, coreApi.db, { ids, include: b.include, layout: b.layout });
}

/** GET /warranty — warranty rows across instances + the warn window.
 *  best_days_remaining is the tag's best agreement, so an expired contract
 *  under an active renewal classifies as covered, not expired. */
function handleGetWarranty(req, res, coreApi) {
  res.json({
    warnDays: warrantyWarnDays(coreApi),
    rows: coreApi.db.prepare(`
      SELECT w.*, o.name AS ome_name, d.name AS device_name,
        (SELECT MAX(w2.days_remaining) FROM dell_warranties w2
         WHERE w2.ome_id = w.ome_id AND w2.service_tag = w.service_tag) AS best_days_remaining
      FROM dell_warranties w
      JOIN dell_ome_instances o ON o.id = w.ome_id
      LEFT JOIN dell_devices d ON d.ome_id = w.ome_id AND d.service_tag = w.service_tag
      ORDER BY w.days_remaining
    `).all(),
  });
}

/** GET /firmware — baseline compliance rows across instances. */
function handleGetFirmware(req, res, coreApi) {
  res.json(coreApi.db.prepare(`
    SELECT f.*, o.name AS ome_name FROM dell_firmware_compliance f
    JOIN dell_ome_instances o ON o.id = f.ome_id
    ORDER BY CASE f.status WHEN 'noncompliant' THEN 0 WHEN 'unknown' THEN 1 ELSE 2 END, f.baseline_name
  `).all());
}

/** GET /governance — failing components, warranty, firmware, unmanaged. */
function handleGetGovernance(req, res, coreApi) {
  const db = coreApi.db;
  const failing = db.prepare(`
    SELECT c.*, d.name AS device_name, d.service_tag AS device_service_tag, o.name AS ome_name
    FROM dell_components c
    JOIN dell_devices d ON d.ome_id = c.ome_id AND d.device_id = c.device_id
    JOIN dell_ome_instances o ON o.id = c.ome_id
    WHERE c.status IN ('critical', 'warning')
    ORDER BY CASE c.status WHEN 'critical' THEN 0 ELSE 1 END, d.name
  `).all().map((c) => ({ ...c, extra: c.extra ? JSON.parse(c.extra) : null }));
  const warnDays = warrantyWarnDays(coreApi);
  const warranty = db.prepare(`
    SELECT w.*, o.name AS ome_name FROM dell_warranties w
    JOIN dell_ome_instances o ON o.id = w.ome_id
    WHERE w.days_remaining IS NOT NULL AND w.days_remaining <= ?
    ORDER BY w.days_remaining
  `).all(warnDays);
  const firmware = db.prepare(`
    SELECT f.*, o.name AS ome_name FROM dell_firmware_compliance f
    JOIN dell_ome_instances o ON o.id = f.ome_id WHERE f.status = 'noncompliant'
    ORDER BY f.noncompliant_components DESC
  `).all();
  const disconnected = db.prepare(`
    SELECT d.name, d.service_tag, d.model, d.device_type, o.name AS ome_name
    FROM dell_devices d JOIN dell_ome_instances o ON o.id = d.ome_id
    WHERE d.connection_state = 0 ORDER BY d.name
  `).all();
  res.json({ failing, warranty, warrantyWarnDays: warnDays, firmware, disconnected });
}

/** GET /compliance — configuration governance: baselines with their rollups
 *  + per-device compliance rows (detail excluded; fetch per device). */
function handleGetCompliance(req, res, coreApi) {
  const db = coreApi.db;
  const baselines = db.prepare(`
    SELECT b.*, o.name AS ome_name FROM dell_config_baselines b
    JOIN dell_ome_instances o ON o.id = b.ome_id
    ORDER BY CASE b.compliance_status WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, b.name
  `).all();
  const reports = db.prepare(`
    SELECT c.id, c.ome_id, c.baseline_id, c.baseline_name, c.device_id, c.device_name,
      c.service_tag, c.model, c.status, c.inventory_time, c.captured_at,
      (c.detail IS NOT NULL) AS has_detail,
      CASE WHEN c.detail IS NULL THEN 0 ELSE json_array_length(c.detail) END AS drift_count,
      o.name AS ome_name, d.id AS device_row_id,
      ${EFFECTIVE_STATUS}, ${VARIANCE_COLS}
    FROM dell_config_compliance c
    JOIN dell_ome_instances o ON o.id = c.ome_id
    LEFT JOIN dell_devices d ON d.ome_id = c.ome_id AND d.device_id = c.device_id
    ${VARIANCE_JOIN}
    ORDER BY CASE WHEN c.status = 'noncompliant' AND v.state = 'active' THEN 3
      WHEN c.status = 'noncompliant' THEN 0 WHEN c.status = 'not_inventoried' THEN 1
      WHEN c.status = 'unknown' THEN 2 ELSE 4 END, c.device_name
  `).all();
  const summary = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN c.status = 'compliant' THEN 1 ELSE 0 END) AS compliant,
      SUM(CASE WHEN c.status = 'noncompliant' AND v.state IS NOT 'active' THEN 1 ELSE 0 END) AS noncompliant,
      SUM(CASE WHEN c.status = 'noncompliant' AND v.state = 'active' THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN c.status = 'not_inventoried' THEN 1 ELSE 0 END) AS not_inventoried
    FROM dell_config_compliance c ${VARIANCE_JOIN}
  `).get();
  res.json({ baselines, reports, summary });
}

/** GET /compliance/:id/detail — attribute-level drift for one stored device
 *  compliance row (which components differ from the template and why). */
function handleGetComplianceDetail(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const row = db.prepare(`
    SELECT c.*, o.name AS ome_name, ${EFFECTIVE_STATUS}, ${VARIANCE_COLS}
    FROM dell_config_compliance c
    JOIN dell_ome_instances o ON o.id = c.ome_id ${VARIANCE_JOIN} WHERE c.id = ?
  `).get(id);
  if (!row) return res.status(404).json({ error: 'Compliance report not found.' });
  const history = db.prepare(`
    SELECT attr_group, attribute, first_seen, last_seen FROM dell_config_drift_history
    WHERE ome_id = ? AND baseline_id = ? AND device_id = ? AND resolved_at IS NULL
  `).all(row.ome_id, row.baseline_id, row.device_id);
  const byKey = new Map(history.map((h) => [`${h.attr_group || ''}|${h.attribute || ''}`, h]));
  const detail = (row.detail ? JSON.parse(row.detail) : []).map((d) => {
    const h = byKey.get(`${d.group || ''}|${d.attribute || ''}`);
    return { ...d, detectedAt: h?.first_seen || null, lastSeen: h?.last_seen || null };
  });
  res.json({ ...row, detail });
}

/** Shared body validation for the variance endpoints: reportIds = 1..1000
 *  ints; returns the deduped list or null after answering 400. */
function readReportIds(req, res) {
  const ids = req.body?.reportIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 1000) { badRequest(res, [fail('reportIds')]); return null; }
  const out = [];
  for (const v of ids) {
    const n = parseIntStrict(v);
    if (n === null) { badRequest(res, [fail('reportIds')]); return null; }
    out.push(n);
  }
  return [...new Set(out)];
}

/** POST /compliance/variances — accept one or many non-compliant device
 *  reports as an approved variance. Body: { reportIds: [..], reason }.
 *  Re-accepting an existing (or stale) variance re-pins it to the current
 *  drift and replaces the reason. Rows without stored detail cannot be
 *  fingerprinted and are skipped. */
function handlePostVariances(req, res, coreApi) {
  const ids = readReportIds(req, res);
  if (ids === null) return;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (reason.length < 3 || reason.length > 1000) return badRequest(res, [fail('reason')]);
  const db = coreApi.db;
  const by = req.auth?.user?.username || req.user?.username || 'unknown';
  const get = db.prepare('SELECT * FROM dell_config_compliance WHERE id = ?');
  const upsert = db.prepare(`
    INSERT INTO dell_config_variances (ome_id, baseline_id, device_id, service_tag, device_name,
      reason, accepted_by, accepted_at, fingerprint, drift_count, state, stale_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, 'active', NULL)
    ON CONFLICT(ome_id, baseline_id, device_id) DO UPDATE SET
      service_tag = excluded.service_tag, device_name = excluded.device_name,
      reason = excluded.reason, accepted_by = excluded.accepted_by, accepted_at = excluded.accepted_at,
      fingerprint = excluded.fingerprint, drift_count = excluded.drift_count,
      state = 'active', stale_at = NULL
  `);
  const skipped = [];
  let accepted = 0;
  db.transaction(() => {
    for (const id of ids) {
      const row = get.get(id);
      if (!row) { skipped.push({ id, why: 'report not found' }); continue; }
      if (row.status !== 'noncompliant') { skipped.push({ id, why: 'device is not non-compliant' }); continue; }
      if (!row.detail) { skipped.push({ id, why: 'no drift detail stored yet (over the per-poll detail cap); wait for a later poll' }); continue; }
      const detail = JSON.parse(row.detail);
      upsert.run(row.ome_id, row.baseline_id, row.device_id, row.service_tag, row.device_name,
        reason, by, varianceFingerprint(detail), detail.length);
      accepted += 1;
    }
  })();
  res.json({ accepted, skipped });
}

/** POST /compliance/variances/revoke — remove accepted variances for the
 *  given compliance report ids; the devices return to the not-compliant
 *  report on the next read. */
function handlePostVariancesRevoke(req, res, coreApi) {
  const ids = readReportIds(req, res);
  if (ids === null) return;
  const db = coreApi.db;
  const del = db.prepare(`
    DELETE FROM dell_config_variances WHERE id IN (
      SELECT v.id FROM dell_config_variances v
      JOIN dell_config_compliance c ON c.ome_id = v.ome_id AND c.baseline_id = v.baseline_id AND c.device_id = v.device_id
      WHERE c.id = ?)
  `);
  let revoked = 0;
  db.transaction(() => { for (const id of ids) revoked += del.run(id).changes; })();
  res.json({ revoked });
}

/** GET /jobs — OME job inventory (console Monitor > Jobs). */
function handleGetJobs(req, res, coreApi) {
  res.json(coreApi.db.prepare(`
    SELECT j.*, o.name AS ome_name FROM dell_jobs j
    JOIN dell_ome_instances o ON o.id = j.ome_id
    ORDER BY j.last_run DESC
  `).all());
}

/** GET /profiles — server configuration profiles (Configuration > Profiles). */
function handleGetProfiles(req, res, coreApi) {
  res.json(coreApi.db.prepare(`
    SELECT p.*, o.name AS ome_name FROM dell_config_profiles p
    JOIN dell_ome_instances o ON o.id = p.ome_id
    ORDER BY p.name
  `).all());
}

/** GET /hardware-logs?search=&days=&severity=&deviceId=&omeId= — per-device
 *  iDRAC Lifecycle/SEL log feed, filtered server-side. */
function handleGetHardwareLogs(req, res, coreApi) {
  const daysQ = parseQueryInt(req.query.days, 1, 365);
  if (!daysQ.ok) return badRequest(res, [fail('days')]);
  const deviceQ = parseQueryInt(req.query.deviceId);
  if (!deviceQ.ok) return badRequest(res, [fail('deviceId')]);
  const omeQ = parseQueryInt(req.query.omeId);
  if (!omeQ.ok) return badRequest(res, [fail('omeId')]);
  if (req.query.search !== undefined && !isNonEmptyString(req.query.search, 200) && req.query.search !== '') {
    return badRequest(res, [fail('search')]);
  }
  const db = coreApi.db;
  const clauses = [];
  const params = [];
  if (daysQ.value !== undefined) { clauses.push("l.created_at >= datetime('now', ?)"); params.push(`-${daysQ.value} days`); }
  if (req.query.severity) { clauses.push('l.severity = ?'); params.push(String(req.query.severity).toLowerCase()); }
  if (deviceQ.value !== undefined) { clauses.push('l.device_id = ?'); params.push(deviceQ.value); }
  if (omeQ.value !== undefined) { clauses.push('l.ome_id = ?'); params.push(omeQ.value); }
  if (req.query.search) {
    clauses.push('(d.name LIKE ? OR d.service_tag LIKE ? OR l.message LIKE ? OR l.message_id LIKE ? OR l.category LIKE ?)');
    const like = `%${req.query.search}%`;
    params.push(like, like, like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT l.*, o.name AS ome_name, d.name AS device_name, d.service_tag AS device_service_tag,
      d.id AS device_row_id
    FROM dell_hardware_logs l
    JOIN dell_ome_instances o ON o.id = l.ome_id
    LEFT JOIN dell_devices d ON d.ome_id = l.ome_id AND d.device_id = l.device_id
    ${where}
    ORDER BY l.created_at DESC LIMIT 5000
  `).all(...params);
  const total = db.prepare('SELECT COUNT(*) AS n FROM dell_hardware_logs').get().n;
  res.json({ rows, total });
}

/** GET /trends?days=30 — per-instance metric snapshots. */
function handleGetTrends(req, res, coreApi) {
  const daysQ = parseQueryInt(req.query.days, 1, 365);
  if (!daysQ.ok) return badRequest(res, [fail('days')]);
  const days = daysQ.value === undefined ? 30 : daysQ.value;
  res.json(coreApi.db.prepare(`
    SELECT m.*, o.name AS ome_name FROM dell_metrics_history m
    JOIN dell_ome_instances o ON o.id = m.ome_id
    WHERE m.captured_at >= datetime('now', ?)
    ORDER BY m.captured_at
  `).all(`-${days} days`));
}

/** GET/PUT /config — alert thresholds (warranty warn window). */
function handleGetConfig(req, res, coreApi) {
  res.json({ warrantyWarnDays: warrantyWarnDays(coreApi) });
}

function handlePutConfig(req, res, coreApi) {
  const b = req.body || {};
  const n = parseIntStrict(b.warrantyWarnDays);
  if (!Number.isInteger(n) || n < 1 || n > 365) return badRequest(res, [fail('warrantyWarnDays')]);
  coreApi.settings.setSetting('dell_warranty_warn_days', String(n));
  res.json({ warrantyWarnDays: warrantyWarnDays(coreApi) });
}

// ── AI Advisor ───────────────────────────────────────────────────────────────

let advisorInstance = null;
function getAdvisor(coreApi) {
  if (!advisorInstance) advisorInstance = createDellAdvisor(coreApi);
  return advisorInstance;
}

function advisorReportKey(slug) {
  return String(slug).replace(/-/g, '_');
}

const SCOPE_NEEDED_ERROR = { error: 'This report needs a device scope. Use /advisor/device-360/:serviceTag.' };

// isScoped is only present on a host whose coreApi.advisor engine supports
// scoped reports; an older host's createPlatformAdvisor predates it.
function isServiceTag(v) {
  return typeof v === 'string' && v.length >= 3 && v.length <= 64;
}

/** GET /advisor/device-360/:serviceTag — cached per-device 360 AI Advisor report. */
function handleGetAdvisorDevice360(req, res, coreApi) {
  if (!isServiceTag(req.params.serviceTag)) return badRequest(res, [fail('serviceTag')]);
  const dellAdvisor = getAdvisor(coreApi);
  if (typeof dellAdvisor.isScoped !== 'function') {
    return res.status(501).json({ error: 'This ICC host does not support per-device analysis yet. Upgrade the host.' });
  }
  const scope = req.params.serviceTag;
  res.json({ enabled: dellAdvisor.isConfigured(), report: dellAdvisor.getCachedReport('device_360', { scope }) });
}

/** POST /advisor/device-360/:serviceTag — (re)generate the per-device 360 report. */
async function handlePostAdvisorDevice360(req, res, coreApi) {
  if (!isServiceTag(req.params.serviceTag)) return badRequest(res, [fail('serviceTag')]);
  const dellAdvisor = getAdvisor(coreApi);
  if (typeof dellAdvisor.isScoped !== 'function') {
    return res.status(501).json({ error: 'This ICC host does not support per-device analysis yet. Upgrade the host.' });
  }
  const scope = req.params.serviceTag;
  try {
    const result = await dellAdvisor.generateReport('device_360', { scope });
    res.json(result);
  } catch (err) {
    if (err.code === 'LLM_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'AI analysis is not configured. Add an OpenAI or GitHub Models token under Settings → Credentials.' });
    }
    if (err.code === 'SCOPE_NOT_FOUND') {
      return res.status(404).json({ error: 'No device with that service tag.' });
    }
    if (err.code === 'BAD_SCOPE') {
      return res.status(400).json({ error: err.message });
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

/** GET /advisor/:report — cached Dell AI Advisor report. */
function handleGetAdvisorReport(req, res, coreApi) {
  if (!isNonEmptyString(req.params.report)) return badRequest(res, [fail('report')]);
  const dellAdvisor = getAdvisor(coreApi);
  const key = advisorReportKey(req.params.report);
  if (!dellAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
  if (typeof dellAdvisor.isScoped === 'function' && dellAdvisor.isScoped(key)) return res.status(400).json(SCOPE_NEEDED_ERROR);
  res.json({ enabled: dellAdvisor.isConfigured(), report: dellAdvisor.getCachedReport(key) });
}

/** POST /advisor/:report — (re)generate and cache a Dell AI Advisor report. */
async function handlePostAdvisorReport(req, res, coreApi) {
  if (!isNonEmptyString(req.params.report)) return badRequest(res, [fail('report')]);
  const dellAdvisor = getAdvisor(coreApi);
  const key = advisorReportKey(req.params.report);
  if (!dellAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
  if (typeof dellAdvisor.isScoped === 'function' && dellAdvisor.isScoped(key)) return res.status(400).json(SCOPE_NEEDED_ERROR);
  try {
    const result = await dellAdvisor.generateReport(key);
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
  { method: 'GET', ...compile('/instances'), handler: handleGetInstances },
  { method: 'POST', ...compile('/instances'), handler: handlePostInstances },
  { method: 'PUT', ...compile('/instances/:id'), handler: handlePutInstance },
  { method: 'DELETE', ...compile('/instances/:id'), handler: handleDeleteInstance },
  { method: 'POST', ...compile('/instances/test'), handler: handlePostInstancesTest },
  { method: 'POST', ...compile('/instances/:id/refresh'), handler: handlePostInstanceRefresh },
  { method: 'GET', ...compile('/instances/:id/inventory-probe'), handler: handleGetInventoryProbe },
  { method: 'GET', ...compile('/instances/:id/audit-probe'), handler: handleGetAuditProbe },
  { method: 'GET', ...compile('/overview'), handler: handleGetOverview },
  { method: 'GET', ...compile('/devices'), handler: handleGetDevices },
  { method: 'GET', ...compile('/devices/:id'), handler: handleGetDeviceById },
  { method: 'GET', ...compile('/alerts'), handler: handleGetAlerts },
  { method: 'GET', ...compile('/export'), handler: handleGetExport },
  { method: 'POST', ...compile('/export'), handler: handlePostExport },
  { method: 'GET', ...compile('/warranty'), handler: handleGetWarranty },
  { method: 'GET', ...compile('/firmware'), handler: handleGetFirmware },
  { method: 'GET', ...compile('/governance'), handler: handleGetGovernance },
  { method: 'GET', ...compile('/compliance'), handler: handleGetCompliance },
  { method: 'GET', ...compile('/compliance/:id/detail'), handler: handleGetComplianceDetail },
  { method: 'POST', ...compile('/compliance/variances'), handler: handlePostVariances },
  { method: 'POST', ...compile('/compliance/variances/revoke'), handler: handlePostVariancesRevoke },
  { method: 'GET', ...compile('/jobs'), handler: handleGetJobs },
  { method: 'GET', ...compile('/profiles'), handler: handleGetProfiles },
  { method: 'GET', ...compile('/hardware-logs'), handler: handleGetHardwareLogs },
  { method: 'GET', ...compile('/trends'), handler: handleGetTrends },
  { method: 'GET', ...compile('/config'), handler: handleGetConfig },
  { method: 'PUT', ...compile('/config'), handler: handlePutConfig },
  { method: 'GET', ...compile('/advisor/device-360/:serviceTag'), handler: handleGetAdvisorDevice360 },
  { method: 'POST', ...compile('/advisor/device-360/:serviceTag'), handler: handlePostAdvisorDevice360 },
  { method: 'GET', ...compile('/advisor/:report'), handler: handleGetAdvisorReport },
  { method: 'POST', ...compile('/advisor/:report'), handler: handlePostAdvisorReport },
  ...REPORT_ROUTES,
];

// createRouter must return a BARE (req, res, next) function — installed
// plugins are loaded via require() on their own dist/backend/index.cjs and
// cannot require the host's copy of express, so express Router instances are
// off the table. Matches req.method + req.path by hand against the table
// above; req.query/req.body are still parsed by the host's express pipeline
// before this middleware runs.
function createRouter(coreApi) {
  return function dellRouter(req, res, next) {
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
