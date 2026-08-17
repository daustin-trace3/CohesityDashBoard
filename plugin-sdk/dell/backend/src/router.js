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
const { computeIssues, warrantyWarnDays } = require('./issues');
const { createDellAdvisor } = require('./advisor');
const { compile } = require('./compile');
const { REPORT_ROUTES } = require('./reports');
const {
  badRequest, fail, parseIntStrict, isNonEmptyString, isBooleanish, toBool,
  requireIdParam, parseQueryInt,
} = require('./validate');

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
  // hostname OME reports, and their quickstats stand in for the plugin.
  if (!utilization.metered) {
    try {
      const vc = db.prepare(`
        SELECT AVG(v.cpu_pct) AS cpu_avg, AVG(v.mem_pct) AS mem_avg, COUNT(*) AS metered
        FROM (
          SELECT (CAST(h.cpu_mhz_used AS REAL) / h.cpu_mhz_capacity) * 100 AS cpu_pct,
                 (CAST(h.mem_bytes_used AS REAL) / h.mem_bytes_capacity) * 100 AS mem_pct
          FROM dell_components c
          JOIN vcenter_hosts h ON LOWER(h.name) = LOWER(json_extract(c.extra, '$.hostname'))
          WHERE c.kind = 'os'
            AND h.cpu_mhz_used IS NOT NULL AND h.cpu_mhz_capacity > 0
            AND h.mem_bytes_used IS NOT NULL AND h.mem_bytes_capacity > 0
        ) v
      `).get();
      if (vc?.metered) {
        utilization.cpu_avg = vc.cpu_avg;
        utilization.mem_avg = vc.mem_avg;
        utilization.metered = vc.metered;
        utilization.source = 'vcenter';
      }
    } catch { /* vCenter platform tables unavailable — keep PM-only view */ }
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
    try {
      topUtil = db.prepare(`
        SELECT * FROM (
          SELECT d.name,
            (CAST(h.cpu_mhz_used AS REAL) / h.cpu_mhz_capacity) * 100 AS cpu_util_pct,
            (CAST(h.mem_bytes_used AS REAL) / h.mem_bytes_capacity) * 100 AS mem_util_pct
          FROM dell_components c
          JOIN dell_devices d ON d.ome_id = c.ome_id AND d.device_id = c.device_id
          JOIN vcenter_hosts h ON LOWER(h.name) = LOWER(json_extract(c.extra, '$.hostname'))
          WHERE c.kind = 'os'
            AND h.cpu_mhz_used IS NOT NULL AND h.cpu_mhz_capacity > 0
            AND h.mem_bytes_used IS NOT NULL AND h.mem_bytes_capacity > 0
        ) ORDER BY MAX(COALESCE(cpu_util_pct, 0), COALESCE(mem_util_pct, 0)) DESC LIMIT 30
      `).all();
    } catch { /* vCenter tables unavailable */ }
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
      SUM(CASE WHEN status = 'noncompliant' THEN 1 ELSE 0 END) AS noncompliant
    FROM dell_config_compliance
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
      SELECT ome_id, device_id,
        CASE WHEN SUM(status = 'noncompliant') > 0 THEN 'noncompliant'
             WHEN SUM(status = 'compliant') > 0 THEN 'compliant'
             ELSE MIN(status) END AS compliance_status,
        SUM(CASE WHEN detail IS NULL THEN 0 ELSE json_array_length(detail) END) AS compliance_drift,
        MAX(CASE WHEN status = 'noncompliant' THEN id END) AS compliance_report_id
      FROM dell_config_compliance GROUP BY ome_id, device_id
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
    SELECT id, baseline_id, baseline_name, status, inventory_time,
      CASE WHEN detail IS NULL THEN 0 ELSE json_array_length(detail) END AS drift_count
    FROM dell_config_compliance WHERE ome_id = ? AND (device_id = ? OR service_tag = ?)
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
  `).all(`-${days} days`));
}

/** GET /export?include=cpu,memory,network&deviceId= — CSV inventory export. */
function handleGetExport(req, res, coreApi) {
  const deviceQ = parseQueryInt(req.query.deviceId);
  if (!deviceQ.ok) return badRequest(res, [fail('deviceId')]);
  const db = coreApi.db;
  const include = new Set(String(req.query.include || '').split(',').map((s) => s.trim()).filter(Boolean));
  const devices = db.prepare(`
    SELECT d.*, o.name AS ome_name FROM dell_devices d
    JOIN dell_ome_instances o ON o.id = d.ome_id
    ${deviceQ.value !== undefined ? 'WHERE d.id = ?' : ''} ORDER BY d.name
  `).all(...(deviceQ.value !== undefined ? [deviceQ.value] : []));
  if (deviceQ.value !== undefined && devices.length === 0) return res.status(404).json({ error: 'Device not found.' });

  const compRows = db.prepare('SELECT * FROM dell_components').all();
  const compsByDevice = new Map();
  for (const c of compRows) {
    const key = `${c.ome_id}|${c.device_id}`;
    if (!compsByDevice.has(key)) compsByDevice.set(key, []);
    compsByDevice.get(key).push(c);
  }
  const warRows = db.prepare('SELECT * FROM dell_warranties').all();
  const warByTag = new Map();
  for (const w of warRows) {
    const prev = warByTag.get(w.service_tag);
    if (!prev || (w.days_remaining ?? -1) > (prev.days_remaining ?? -1)) warByTag.set(w.service_tag, w);
  }

  const gb = (b) => (b != null ? (b / 1024 ** 3).toFixed(0) : '');
  const header = ['Device Name', 'Service Tag', 'Model', 'Type', 'IP Address', 'Health', 'Power State', 'OME Instance',
    'Support Level', 'Support End', 'Support Days Left'];
  if (include.has('cpu')) header.push('CPU Sockets', 'CPU Cores', 'CPU Models');
  if (include.has('memory')) header.push('Memory (GB)', 'DIMM Count', 'DIMM Detail');
  if (include.has('network')) header.push('NIC Count', 'NICs', 'MAC Addresses');

  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.map(esc).join(',')];
  for (const d of devices) {
    const comps = compsByDevice.get(`${d.ome_id}|${d.device_id}`) || [];
    const war = warByTag.get(d.service_tag);
    const row = [d.name, d.service_tag, d.model, d.device_type, d.ip_address, d.health, d.power_state, d.ome_name,
      war?.service_level ?? '', war?.end_date ? String(war.end_date).slice(0, 10) : '',
      war?.days_remaining ?? ''];
    if (include.has('cpu')) {
      const cpus = comps.filter((c) => c.kind === 'processor');
      row.push(d.cpu_count ?? (cpus.length || ''),
        d.core_count ?? '',
        [...new Set(cpus.map((c) => c.name).filter(Boolean))].join('; '));
    }
    if (include.has('memory')) {
      const dimms = comps.filter((c) => c.kind === 'memory');
      row.push(gb(d.memory_bytes), dimms.length || '',
        [...new Set(dimms.map((c) => `${gb(c.size_bytes)}GB ${c.speed || ''}`.trim()))].join('; '));
    }
    if (include.has('network')) {
      const nics = comps.filter((c) => c.kind === 'nic');
      const macs = [];
      for (const n of nics) {
        try {
          for (const p of (JSON.parse(n.extra || '{}').ports || [])) macs.push(...(p.macs || []));
        } catch { /* extra not JSON */ }
      }
      row.push(nics.length || '',
        [...new Set(nics.map((c) => c.description || c.name).filter(Boolean))].join('; '),
        macs.join('; '));
    }
    lines.push(row.map(esc).join(','));
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="dell-inventory-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(lines.join('\r\n'));
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
      o.name AS ome_name, d.id AS device_row_id
    FROM dell_config_compliance c
    JOIN dell_ome_instances o ON o.id = c.ome_id
    LEFT JOIN dell_devices d ON d.ome_id = c.ome_id AND d.device_id = c.device_id
    ORDER BY CASE c.status WHEN 'noncompliant' THEN 0 WHEN 'not_inventoried' THEN 1
      WHEN 'unknown' THEN 2 ELSE 3 END, c.device_name
  `).all();
  const summary = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'compliant' THEN 1 ELSE 0 END) AS compliant,
      SUM(CASE WHEN status = 'noncompliant' THEN 1 ELSE 0 END) AS noncompliant,
      SUM(CASE WHEN status = 'not_inventoried' THEN 1 ELSE 0 END) AS not_inventoried
    FROM dell_config_compliance
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
    SELECT c.*, o.name AS ome_name FROM dell_config_compliance c
    JOIN dell_ome_instances o ON o.id = c.ome_id WHERE c.id = ?
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

/** GET /advisor/:report — cached Dell AI Advisor report. */
function handleGetAdvisorReport(req, res, coreApi) {
  if (!isNonEmptyString(req.params.report)) return badRequest(res, [fail('report')]);
  const dellAdvisor = getAdvisor(coreApi);
  const key = advisorReportKey(req.params.report);
  if (!dellAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
  res.json({ enabled: dellAdvisor.isConfigured(), report: dellAdvisor.getCachedReport(key) });
}

/** POST /advisor/:report — (re)generate and cache a Dell AI Advisor report. */
async function handlePostAdvisorReport(req, res, coreApi) {
  if (!isNonEmptyString(req.params.report)) return badRequest(res, [fail('report')]);
  const dellAdvisor = getAdvisor(coreApi);
  const key = advisorReportKey(req.params.report);
  if (!dellAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
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
  { method: 'GET', ...compile('/warranty'), handler: handleGetWarranty },
  { method: 'GET', ...compile('/firmware'), handler: handleGetFirmware },
  { method: 'GET', ...compile('/governance'), handler: handleGetGovernance },
  { method: 'GET', ...compile('/compliance'), handler: handleGetCompliance },
  { method: 'GET', ...compile('/compliance/:id/detail'), handler: handleGetComplianceDetail },
  { method: 'GET', ...compile('/jobs'), handler: handleGetJobs },
  { method: 'GET', ...compile('/profiles'), handler: handleGetProfiles },
  { method: 'GET', ...compile('/hardware-logs'), handler: handleGetHardwareLogs },
  { method: 'GET', ...compile('/trends'), handler: handleGetTrends },
  { method: 'GET', ...compile('/config'), handler: handleGetConfig },
  { method: 'PUT', ...compile('/config'), handler: handlePutConfig },
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
