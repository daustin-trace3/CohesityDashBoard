// Dell OME routes. Mounted at /api/dell in server.js — paths are
// relative. Registration CRUD stores the password AES-encrypted; data
// endpoints serve the polled ome_* tables plus computed issues (instance
// unreachable, critical/warning devices, failing components, warranty
// expiring within the configurable window, firmware drift).
const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const db = require('../db/database');
const { encrypt } = require('../services/encryption');
const { getSetting, setSetting } = require('../services/settings');
const dellOmeApi = require('../services/dellOmeApi');
const { dellPoller } = require('../services/dellPoller');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid parameters', details: errors.array() });
  next();
};

const publicOme = (row) => ({
  id: row.id, name: row.name, host: row.host, username: row.username,
  sslVerify: !!row.ssl_verify, pollingIntervalMinutes: row.polling_interval_minutes,
  lastPollStatus: row.last_poll_status, lastPollError: row.last_poll_error, lastPollAt: row.last_poll_at,
  version: row.version,
});

function warrantyWarnDays() {
  const n = parseInt(getSetting('dell_warranty_warn_days'), 10);
  return Number.isFinite(n) ? Math.min(365, Math.max(1, n)) : 90;
}

/** GET /api/dell/instances — registered OME appliances (never the credentials). */
router.get('/instances', (req, res, next) => {
  try {
    res.json(db.prepare('SELECT * FROM dell_ome_instances ORDER BY name').all().map(publicOme));
  } catch (err) { next(err); }
});

/** POST /api/dell/instances — register an OME appliance. */
router.post('/instances', [
  body('name').isString().trim().notEmpty().isLength({ max: 120 }),
  body('host').isString().trim().notEmpty().isLength({ max: 253 }),
  body('username').isString().trim().notEmpty().isLength({ max: 256 }),
  body('password').isString().notEmpty().isLength({ max: 512 }),
  body('sslVerify').optional().isBoolean(),
  body('pollingIntervalMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
], validate, (req, res, next) => {
  try {
    const { name, host, username, password, sslVerify, pollingIntervalMinutes } = req.body;
    const dup = db.prepare('SELECT id FROM dell_ome_instances WHERE name = ? OR host = ?').get(name.trim(), host.trim());
    if (dup) return res.status(409).json({ error: 'An OME instance with that name or host is already registered.' });
    const info = db.prepare(`
      INSERT INTO dell_ome_instances (name, host, username, encrypted_credentials, ssl_verify, polling_interval_minutes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name.trim(), host.trim(), username.trim(),
      encrypt(JSON.stringify({ password })), sslVerify ? 1 : 0, pollingIntervalMinutes || 15);
    const row = db.prepare('SELECT * FROM dell_ome_instances WHERE id = ?').get(info.lastInsertRowid);
    dellPoller.schedule(row);
    dellPoller.trigger(row).catch(() => {});
    res.status(201).json(publicOme(row));
  } catch (err) { next(err); }
});

/** PUT /api/dell/instances/:id — update (password optional; blank keeps stored). */
router.put('/instances/:id', [
  param('id').isInt().toInt(),
  body('name').optional().isString().trim().notEmpty().isLength({ max: 120 }),
  body('host').optional().isString().trim().notEmpty().isLength({ max: 253 }),
  body('username').optional().isString().trim().notEmpty().isLength({ max: 256 }),
  body('password').optional().isString().isLength({ max: 512 }),
  body('sslVerify').optional().isBoolean(),
  body('pollingIntervalMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM dell_ome_instances WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'OME instance not found.' });
    const b = req.body;
    db.prepare(`
      UPDATE dell_ome_instances SET
        name = ?, host = ?, username = ?, encrypted_credentials = ?,
        ssl_verify = ?, polling_interval_minutes = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      b.name?.trim() || row.name, b.host?.trim() || row.host, b.username?.trim() || row.username,
      b.password ? encrypt(JSON.stringify({ password: b.password })) : row.encrypted_credentials,
      b.sslVerify !== undefined ? (b.sslVerify ? 1 : 0) : row.ssl_verify,
      b.pollingIntervalMinutes || row.polling_interval_minutes,
      row.id
    );
    dellOmeApi.invalidateSession(row.id);
    const updated = db.prepare('SELECT * FROM dell_ome_instances WHERE id = ?').get(row.id);
    dellPoller.schedule(updated);
    res.json(publicOme(updated));
  } catch (err) { next(err); }
});

/** DELETE /api/dell/instances/:id — unregister (CASCADE clears inventory). */
router.delete('/instances/:id', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM dell_ome_instances WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'OME instance not found.' });
    dellPoller.cancel(row.id);
    dellOmeApi.invalidateSession(row.id);
    db.prepare('DELETE FROM dell_ome_instances WHERE id = ?').run(row.id);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

/** POST /api/dell/instances/test — validate saved or candidate credentials. */
router.post('/instances/test', [
  body('host').isString().trim().notEmpty(),
  body('username').isString().trim().notEmpty(),
  body('password').optional().isString(),
  body('id').optional().isInt().toInt(),
  body('sslVerify').optional().isBoolean(),
], validate, async (req, res) => {
  const { id, host, username, password, sslVerify } = req.body;
  let candidate = { host: host.trim(), username: username.trim(), password, ssl_verify: sslVerify ? 1 : 0 };
  if (!password && id) {
    const row = db.prepare('SELECT * FROM dell_ome_instances WHERE id = ?').get(id);
    if (row) candidate = { ...row, host: candidate.host, username: candidate.username, ssl_verify: candidate.ssl_verify };
  }
  const result = await dellOmeApi.testConnection(candidate);
  res.status(result.ok ? 200 : 502).json(result);
});

/** POST /api/dell/instances/:id/refresh — poll this instance now. */
router.post('/instances/:id/refresh', [param('id').isInt().toInt()], validate, async (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM dell_ome_instances WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'OME instance not found.' });
    await dellPoller.trigger(row);
    res.json(publicOme(db.prepare('SELECT * FROM dell_ome_instances WHERE id = ?').get(row.id)));
  } catch (err) { next(err); }
});

// ── Data endpoints ───────────────────────────────────────────────────────────

function computeIssues() {
  const issues = [];
  const warnDays = warrantyWarnDays();
  for (const o of db.prepare('SELECT * FROM dell_ome_instances').all()) {
    if (o.last_poll_status === 'error') {
      issues.push({ severity: 'critical', type: 'unreachable', ome: o.name, message: `OME unreachable: ${o.last_poll_error || 'poll failed'}` });
    }
  }
  const badDevices = db.prepare(`
    SELECT d.name, d.service_tag, d.health, o.name AS ome_name FROM dell_devices d
    JOIN dell_ome_instances o ON o.id = d.ome_id WHERE d.health IN ('critical', 'warning')
    ORDER BY CASE d.health WHEN 'critical' THEN 0 ELSE 1 END LIMIT 200
  `).all();
  for (const d of badDevices) {
    issues.push({ severity: d.health === 'critical' ? 'critical' : 'warning', type: 'device_health', ome: d.ome_name, message: `${d.name || d.service_tag} health is ${d.health}` });
  }
  const badComps = db.prepare(`
    SELECT c.kind, c.name, c.status, d.name AS device_name, o.name AS ome_name
    FROM dell_components c
    JOIN dell_devices d ON d.ome_id = c.ome_id AND d.device_id = c.device_id
    JOIN dell_ome_instances o ON o.id = c.ome_id
    WHERE c.status IN ('critical', 'warning') LIMIT 200
  `).all();
  for (const c of badComps) {
    issues.push({ severity: c.status === 'critical' ? 'critical' : 'warning', type: 'component', ome: c.ome_name, message: `${c.device_name}: ${c.kind} ${c.name || ''} is ${c.status}`.trim() });
  }
  const expiring = db.prepare(`
    SELECT w.service_tag, w.device_model, w.days_remaining, o.name AS ome_name
    FROM dell_warranties w JOIN dell_ome_instances o ON o.id = w.ome_id
    WHERE w.days_remaining IS NOT NULL AND w.days_remaining <= ? ORDER BY w.days_remaining LIMIT 200
  `).all(warnDays);
  for (const w of expiring) {
    issues.push({
      severity: w.days_remaining <= 0 ? 'critical' : 'warning', type: 'warranty', ome: w.ome_name,
      message: w.days_remaining <= 0
        ? `Warranty expired on ${w.device_model || ''} ${w.service_tag}`.trim()
        : `Warranty on ${w.device_model || ''} ${w.service_tag} expires in ${w.days_remaining}d`.trim(),
    });
  }
  const order = { critical: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
}

/** GET /api/dell/overview — fleet rollup + computed issues. */
router.get('/overview', (req, res, next) => {
  try {
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
    // Prior week's criticals, for the at-a-glance trend arrow.
    const alertPrev = db.prepare(`
      SELECT SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS critical
      FROM dell_alerts
      WHERE created_at >= datetime('now', '-14 days') AND created_at < datetime('now', '-7 days')
    `).get();
    // Power Manager fleet rollups — NULL columns simply drop out of the AVG/MAX.
    const utilization = db.prepare(`
      SELECT AVG(cpu_util_pct) AS cpu_avg, AVG(mem_util_pct) AS mem_avg,
        MAX(inlet_temp_c) AS temp_max, AVG(inlet_temp_c) AS temp_avg,
        COUNT(cpu_util_pct) AS metered
      FROM dell_devices
    `).get();
    // Ops charts: daily alert volume by severity, power trend per instance,
    // and the busiest metered servers.
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
    // Top candidates by most-constrained resource; the frontend re-sorts to
    // the visible metric(s) when the chart legend is toggled, so return more
    // than the 10 it displays.
    const topUtil = db.prepare(`
      SELECT name, cpu_util_pct, mem_util_pct FROM dell_devices
      WHERE cpu_util_pct IS NOT NULL OR mem_util_pct IS NOT NULL
      ORDER BY MAX(COALESCE(cpu_util_pct, 0), COALESCE(mem_util_pct, 0)) DESC LIMIT 30
    `).all();
    const warnDays = warrantyWarnDays();
    const warrantyAgg = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN days_remaining IS NOT NULL AND days_remaining <= 0 THEN 1 ELSE 0 END) AS expired,
        SUM(CASE WHEN days_remaining > 0 AND days_remaining <= ? THEN 1 ELSE 0 END) AS expiring
      FROM dell_warranties
    `).get(warnDays);
    const firmwareAgg = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'noncompliant' THEN 1 ELSE 0 END) AS noncompliant
      FROM dell_firmware_compliance
    `).get();
    const failingComponents = db.prepare(`
      SELECT COUNT(*) AS n FROM dell_components WHERE status IN ('critical', 'warning')
    `).get().n;
    res.json({
      instances: instances.map(publicOme),
      devices: devAgg,
      typeBreakdown, modelBreakdown, capacity, diskMedia,
      alerts7d: { ...alertAgg, critical_prev: alertPrev.critical || 0 },
      utilization,
      alertsByDay, powerTrend, topUtil,
      warranty: { ...warrantyAgg, warnDays },
      firmware: firmwareAgg,
      failingComponents,
      issues: computeIssues(),
    });
  } catch (err) { next(err); }
});

/** GET /api/dell/devices — inventory list (optional ?omeId=&type=&health=). */
router.get('/devices', [
  query('omeId').optional().isInt().toInt(),
  query('type').optional().isString().trim(),
  query('health').optional().isString().trim(),
], validate, (req, res, next) => {
  try {
    const clauses = [];
    const params = [];
    if (req.query.omeId) { clauses.push('d.ome_id = ?'); params.push(req.query.omeId); }
    if (req.query.type) { clauses.push('d.device_type = ?'); params.push(req.query.type); }
    if (req.query.health) { clauses.push('d.health = ?'); params.push(req.query.health); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    res.json(db.prepare(`
      SELECT d.*, o.name AS ome_name FROM dell_devices d
      JOIN dell_ome_instances o ON o.id = d.ome_id ${where} ORDER BY d.name
    `).all(...params));
  } catch (err) { next(err); }
});

/** GET /api/dell/devices/:id — one device + components + recent alerts. */
router.get('/devices/:id', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const dev = db.prepare(`
      SELECT d.*, o.name AS ome_name FROM dell_devices d
      JOIN dell_ome_instances o ON o.id = d.ome_id WHERE d.id = ?
    `).get(req.params.id);
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
    res.json({ ...dev, components, alerts, warranty, firmware });
  } catch (err) { next(err); }
});

/** GET /api/dell/alerts?days=7 — alert feed across instances. device_row_id
 *  resolves the alerting device to its inventory row for the detail modal. */
router.get('/alerts', [query('days').optional().isInt({ min: 1, max: 90 }).toInt()], validate, (req, res, next) => {
  try {
    const days = req.query.days || 7;
    res.json(db.prepare(`
      SELECT a.*, o.name AS ome_name, d.id AS device_row_id
      FROM dell_alerts a
      JOIN dell_ome_instances o ON o.id = a.ome_id
      LEFT JOIN dell_devices d ON d.ome_id = a.ome_id
        AND (d.service_tag = a.service_tag OR d.name = a.device_name)
      WHERE a.created_at >= datetime('now', ?)
      ORDER BY a.created_at DESC LIMIT 5000
    `).all(`-${days} days`));
  } catch (err) { next(err); }
});

/** GET /api/dell/export?include=cpu,memory,network&deviceId= — CSV inventory
 *  export. Base columns (always): device identity, IP, health and support
 *  contract; optional component groups summarized one row per device. */
router.get('/export', [
  query('include').optional().isString().trim(),
  query('deviceId').optional().isInt().toInt(),
], validate, (req, res, next) => {
  try {
    const include = new Set(String(req.query.include || '').split(',').map((s) => s.trim()).filter(Boolean));
    const devices = db.prepare(`
      SELECT d.*, o.name AS ome_name FROM dell_devices d
      JOIN dell_ome_instances o ON o.id = d.ome_id
      ${req.query.deviceId ? 'WHERE d.id = ?' : ''} ORDER BY d.name
    `).all(...(req.query.deviceId ? [req.query.deviceId] : []));
    if (req.query.deviceId && devices.length === 0) return res.status(404).json({ error: 'Device not found.' });

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
      // Keep the longest-running contract per service tag.
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
  } catch (err) { next(err); }
});

/** GET /api/dell/warranty — warranty rows across instances + the warn window. */
router.get('/warranty', (req, res, next) => {
  try {
    res.json({
      warnDays: warrantyWarnDays(),
      rows: db.prepare(`
        SELECT w.*, o.name AS ome_name FROM dell_warranties w
        JOIN dell_ome_instances o ON o.id = w.ome_id ORDER BY w.days_remaining
      `).all(),
    });
  } catch (err) { next(err); }
});

/** GET /api/dell/firmware — baseline compliance rows across instances. */
router.get('/firmware', (req, res, next) => {
  try {
    res.json(db.prepare(`
      SELECT f.*, o.name AS ome_name FROM dell_firmware_compliance f
      JOIN dell_ome_instances o ON o.id = f.ome_id
      ORDER BY CASE f.status WHEN 'noncompliant' THEN 0 WHEN 'unknown' THEN 1 ELSE 2 END, f.baseline_name
    `).all());
  } catch (err) { next(err); }
});

/** GET /api/dell/governance — failing components, warranty, firmware, unmanaged. */
router.get('/governance', (req, res, next) => {
  try {
    const failing = db.prepare(`
      SELECT c.*, d.name AS device_name, d.service_tag AS device_service_tag, o.name AS ome_name
      FROM dell_components c
      JOIN dell_devices d ON d.ome_id = c.ome_id AND d.device_id = c.device_id
      JOIN dell_ome_instances o ON o.id = c.ome_id
      WHERE c.status IN ('critical', 'warning')
      ORDER BY CASE c.status WHEN 'critical' THEN 0 ELSE 1 END, d.name
    `).all().map((c) => ({ ...c, extra: c.extra ? JSON.parse(c.extra) : null }));
    const warnDays = warrantyWarnDays();
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
  } catch (err) { next(err); }
});

/** GET /api/dell/trends?days=30 — per-instance metric snapshots. */
router.get('/trends', [query('days').optional().isInt({ min: 1, max: 365 }).toInt()], validate, (req, res, next) => {
  try {
    const days = req.query.days || 30;
    res.json(db.prepare(`
      SELECT m.*, o.name AS ome_name FROM dell_metrics_history m
      JOIN dell_ome_instances o ON o.id = m.ome_id
      WHERE m.captured_at >= datetime('now', ?)
      ORDER BY m.captured_at
    `).all(`-${days} days`));
  } catch (err) { next(err); }
});

/** GET/PUT /api/dell/config — alert thresholds (warranty warn window). */
router.get('/config', (req, res) => {
  res.json({ warrantyWarnDays: warrantyWarnDays() });
});
router.put('/config', [
  body('warrantyWarnDays').isInt({ min: 1, max: 365 }).toInt(),
], validate, (req, res, next) => {
  try {
    setSetting('dell_warranty_warn_days', String(req.body.warrantyWarnDays));
    res.json({ warrantyWarnDays: warrantyWarnDays() });
  } catch (err) { next(err); }
});

module.exports = router;
