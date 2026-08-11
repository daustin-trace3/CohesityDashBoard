// UniFi routes. Mounted by the plugin dispatcher at /api/unifi — paths are
// relative. Registration CRUD stores the API key AES-encrypted (keep-if-blank
// on PUT); data endpoints serve the polled unifi_* tables plus computed
// issues. Model: routes/nutanix.js (history, from git 78952ba^).
const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const db = require('../db/database');
const { encrypt } = require('../services/encryption');
const { setSetting } = require('../services/settings');
const unifiApi = require('../services/unifiApi');
const { unifiPoller } = require('../services/unifiPoller');
const {
  wanLatencyWarnMs, wanAvailWarnPct, portErrDeltaWarn, portFlapWarn,
  deviceCpuWarnPct, deviceMemWarnPct, tempWarnC, satisfactionWarn,
  computeIssues,
} = require('../services/unifiIssues');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid parameters', details: errors.array() });
  next();
};

// ── Public shapes (never leak encrypted_credentials/apiKey) ────────────────

const publicSource = (row) => ({
  id: row.id,
  name: row.name,
  host: row.host,
  port: row.port,
  sslVerify: !!row.ssl_verify,
  pollingIntervalMinutes: row.polling_interval_minutes,
  sites: row.sites_json ? JSON.parse(row.sites_json) : [],
  controllerVersion: row.controller_version,
  lastPollStatus: row.last_poll_status,
  lastPollError: row.last_poll_error,
  lastPollAt: row.last_poll_at,
  deviceCount: db.prepare('SELECT COUNT(*) n FROM unifi_devices WHERE source_id = ?').get(row.id).n,
});

// ── Source registration CRUD ────────────────────────────────────────────────

router.get('/sources', (req, res, next) => {
  try {
    res.json(db.prepare('SELECT * FROM unifi_sources ORDER BY name').all().map(publicSource));
  } catch (err) { next(err); }
});

router.post('/sources', [
  body('name').isString().trim().notEmpty().isLength({ max: 120 }),
  body('host').isString().trim().notEmpty().isLength({ max: 253 }),
  body('port').optional().isInt({ min: 1, max: 65535 }).toInt(),
  body('apiKey').isString().trim().notEmpty().isLength({ max: 512 }),
  body('sslVerify').optional().isBoolean(),
  body('pollingIntervalMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
], validate, (req, res, next) => {
  try {
    const { name, host, port, apiKey, sslVerify, pollingIntervalMinutes } = req.body;
    const dup = db.prepare('SELECT id FROM unifi_sources WHERE name = ?').get(name.trim());
    if (dup) return res.status(409).json({ error: 'A UniFi source with that name is already registered.' });
    const info = db.prepare(`
      INSERT INTO unifi_sources (name, host, port, encrypted_credentials, ssl_verify, polling_interval_minutes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name.trim(), host.trim(), port || 443, encrypt(JSON.stringify({ apiKey })),
      sslVerify ? 1 : 0, pollingIntervalMinutes || 10);
    const row = db.prepare('SELECT * FROM unifi_sources WHERE id = ?').get(info.lastInsertRowid);
    unifiPoller.schedule(row);
    unifiPoller.trigger(row).catch(() => {});
    res.status(201).json(publicSource(row));
  } catch (err) { next(err); }
});

router.put('/sources/:id', [
  param('id').isInt().toInt(),
  body('name').optional().isString().trim().notEmpty().isLength({ max: 120 }),
  body('host').optional().isString().trim().notEmpty().isLength({ max: 253 }),
  body('port').optional().isInt({ min: 1, max: 65535 }).toInt(),
  body('apiKey').optional({ checkFalsy: true }).isString().isLength({ max: 512 }),
  body('sslVerify').optional().isBoolean(),
  body('pollingIntervalMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM unifi_sources WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'UniFi source not found.' });
    const b = req.body;
    db.prepare(`
      UPDATE unifi_sources SET
        name = ?, host = ?, port = ?, encrypted_credentials = ?, ssl_verify = ?, polling_interval_minutes = ?
      WHERE id = ?
    `).run(
      b.name?.trim() || row.name, b.host?.trim() || row.host, b.port || row.port,
      b.apiKey ? encrypt(JSON.stringify({ apiKey: b.apiKey })) : row.encrypted_credentials,
      b.sslVerify !== undefined ? (b.sslVerify ? 1 : 0) : row.ssl_verify,
      b.pollingIntervalMinutes || row.polling_interval_minutes,
      row.id
    );
    const updated = db.prepare('SELECT * FROM unifi_sources WHERE id = ?').get(row.id);
    unifiPoller.schedule(updated);
    res.json(publicSource(updated));
  } catch (err) { next(err); }
});

router.delete('/sources/:id', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM unifi_sources WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'UniFi source not found.' });
    unifiPoller.cancel(row.id);
    db.prepare('DELETE FROM unifi_sources WHERE id = ?').run(row.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/sources/test', [
  body('host').optional().isString().trim().notEmpty(),
  body('apiKey').optional().isString(),
  body('id').optional().isInt().toInt(),
  body('port').optional().isInt({ min: 1, max: 65535 }).toInt(),
  body('sslVerify').optional().isBoolean(),
], validate, async (req, res) => {
  const { id, host, apiKey, port, sslVerify } = req.body;
  let candidate;
  if (id) {
    const row = db.prepare('SELECT * FROM unifi_sources WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'UniFi source not found.' });
    candidate = { ...row, ...(apiKey ? { apiKey } : {}) };
  } else {
    if (!host || !apiKey) {
      return res.status(400).json({ error: 'Invalid parameters', details: [{ msg: 'host and apiKey required' }] });
    }
    candidate = { host: host.trim(), apiKey, port: port || 443, ssl_verify: sslVerify ? 1 : 0 };
  }
  const result = await unifiApi.testConnection(candidate);
  res.status(result.ok ? 200 : 502).json(result);
});

router.post('/sources/:id/poll', [param('id').isInt().toInt()], validate, async (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM unifi_sources WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'UniFi source not found.' });
    unifiPoller.trigger(row).catch(() => {});
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Probe fetches run the same fetchers the poller uses, live against the
// source, reporting raw shapes — the mandatory live-debug loop.
router.get('/sources/:id/probe', [param('id').isInt().toInt()], validate, async (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM unifi_sources WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'UniFi source not found.' });

    const sections = {};
    const run = async (name, fn) => {
      try {
        const data = await fn();
        sections[name] = { ok: true, status: 200, sample: data };
      } catch (err) {
        sections[name] = { ok: false, status: err.response?.status || null, sample: null, error: unifiApi.errMsg(err) };
      }
    };

    await run('info', () => unifiApi.fetchInfo(row));
    let sites = [];
    await run('sites', async () => { sites = await unifiApi.fetchSites(row); return sites; });
    const site = sites[0]?.internalReference || 'default';

    await run('devicesFirst', async () => (await unifiApi.fetchDevices(row, site))[0] || null);
    await run('clientFirst', async () => (await unifiApi.fetchClients(row, site))[0] || null);
    await run('health', () => unifiApi.fetchHealth(row, site));
    await run('wlans', () => unifiApi.fetchWlans(row, site));
    await run('rogueCount', async () => (await unifiApi.fetchRogueAps(row, site)).length);
    await run('topologyCounts', async () => {
      const t = await unifiApi.fetchTopology(row, site);
      return { vertices: t.vertices.length, edges: t.edges.length };
    });
    await run('systemLogFirst', async () => (await unifiApi.fetchSystemLog(row, site))[0] || null);

    res.json({ sections });
  } catch (err) { next(err); }
});

// ── Data endpoints ───────────────────────────────────────────────────────────

router.get('/overview', (req, res, next) => {
  try {
    const sources = db.prepare('SELECT * FROM unifi_sources ORDER BY name').all();
    const deviceCounts = db.prepare(`
      SELECT COUNT(*) total, SUM(CASE WHEN state = 1 THEN 1 ELSE 0 END) online,
        SUM(CASE WHEN type = 'udm' THEN 1 ELSE 0 END) udm,
        SUM(CASE WHEN type = 'usw' THEN 1 ELSE 0 END) usw,
        SUM(CASE WHEN type = 'uap' THEN 1 ELSE 0 END) uap
      FROM unifi_devices
    `).get();
    const clientCounts = db.prepare(`
      SELECT COUNT(*) total, SUM(CASE WHEN is_wired = 1 THEN 1 ELSE 0 END) wired,
        SUM(CASE WHEN is_wired = 0 THEN 1 ELSE 0 END) wireless, SUM(CASE WHEN is_guest = 1 THEN 1 ELSE 0 END) guest
      FROM unifi_clients
    `).get();
    const wanRow = db.prepare('SELECT * FROM unifi_wan LIMIT 1').get();
    let health = [];
    for (const s of sources) {
      if (!s.health_json) continue;
      try {
        const parsed = JSON.parse(s.health_json)?.subsystems || [];
        for (const sub of parsed) health.push({ subsystem: sub.subsystem, status: sub.status, numSta: sub.num_sta ?? null });
      } catch { /* ignore */ }
    }
    const issues = computeIssues();
    const issueCounts = { critical: 0, warning: 0, info: 0 };
    for (const i of issues) issueCounts[i.severity] = (issueCounts[i.severity] || 0) + 1;
    const spark = db.prepare(`
      SELECT captured_at, clients_total, wan_latency_ms FROM unifi_metrics_history
      ORDER BY captured_at DESC LIMIT 48
    `).all().reverse().map((r) => ({ capturedAt: r.captured_at, clientsTotal: r.clients_total, wanLatencyMs: r.wan_latency_ms }));

    res.json({
      sources: sources.map((s) => ({ id: s.id, name: s.name, host: s.host, lastPollStatus: s.last_poll_status, lastPollAt: s.last_poll_at })),
      deviceCounts: { total: deviceCounts.total || 0, online: deviceCounts.online || 0, offline: (deviceCounts.total || 0) - (deviceCounts.online || 0), byType: { udm: deviceCounts.udm || 0, usw: deviceCounts.usw || 0, uap: deviceCounts.uap || 0 } },
      clientCounts: { total: clientCounts.total || 0, wired: clientCounts.wired || 0, wireless: clientCounts.wireless || 0, guest: clientCounts.guest || 0 },
      wan: wanRow ? {
        ispName: wanRow.isp_name, ispOrganization: wanRow.isp_organization, asn: wanRow.asn, wanIp: wanRow.wan_ip,
        latencyMs: wanRow.latency_ms, availabilityPct: wanRow.availability_pct, uptimeSec: wanRow.uptime_sec,
        xputDown: wanRow.xput_down, xputUp: wanRow.xput_up,
      } : null,
      health,
      issueCounts,
      spark,
    });
  } catch (err) { next(err); }
});

router.get('/devices', (req, res, next) => {
  try {
    res.json(db.prepare(`
      SELECT d.*, s.name AS source_name,
        COALESCE(p.ports_total, 0) AS ports_total, COALESCE(p.ports_up, 0) AS ports_up,
        COALESCE(p.ports_poe_active, 0) AS ports_poe_active, COALESCE(p.poe_watts_total, 0) AS poe_watts_total
      FROM unifi_devices d
      JOIN unifi_sources s ON s.id = d.source_id
      LEFT JOIN (
        SELECT source_id, device_mac,
          COUNT(*) ports_total,
          SUM(CASE WHEN up = 1 THEN 1 ELSE 0 END) ports_up,
          SUM(CASE WHEN poe_enable = 1 THEN 1 ELSE 0 END) ports_poe_active,
          SUM(COALESCE(poe_power, 0)) poe_watts_total
        FROM unifi_ports GROUP BY source_id, device_mac
      ) p ON p.source_id = d.source_id AND p.device_mac = d.mac
      ORDER BY s.name, d.name
    `).all());
  } catch (err) { next(err); }
});

router.get('/devices/:mac', [param('mac').isString().notEmpty()], validate, (req, res, next) => {
  try {
    const device = db.prepare(`
      SELECT d.*, s.name AS source_name FROM unifi_devices d JOIN unifi_sources s ON s.id = d.source_id WHERE d.mac = ?
    `).get(req.params.mac);
    if (!device) return res.status(404).json({ error: 'Device not found.' });
    const ports = db.prepare('SELECT * FROM unifi_ports WHERE source_id = ? AND device_mac = ? ORDER BY port_idx').all(device.source_id, device.mac);
    let radios = [];
    if (device.radios_json) {
      try { radios = JSON.parse(device.radios_json); } catch { radios = []; }
    }
    const clients = db.prepare(`
      SELECT * FROM unifi_clients WHERE source_id = ? AND (ap_mac = ? OR sw_mac = ?)
    `).all(device.source_id, device.mac, device.mac);
    res.json({ device, ports, radios, clients });
  } catch (err) { next(err); }
});

router.get('/devices/:mac/port-history', [
  param('mac').isString().notEmpty(),
  query('port').isInt({ min: 0, max: 1000 }).toInt(),
  query('hours').optional().isInt({ min: 1, max: 720 }).toInt(),
], validate, (req, res, next) => {
  try {
    const hours = req.query.hours || 168;
    res.json(db.prepare(`
      SELECT * FROM unifi_port_history
      WHERE device_mac = ? AND port_idx = ? AND captured_at >= datetime('now', ?)
      ORDER BY captured_at ASC
    `).all(req.params.mac, req.query.port, `-${hours} hours`));
  } catch (err) { next(err); }
});

router.get('/ports', (req, res, next) => {
  try {
    res.json(db.prepare(`
      SELECT p.*, d.name AS device_name, d.model AS device_model, d.type AS device_type, s.name AS source_name
      FROM unifi_ports p
      JOIN unifi_devices d ON d.source_id = p.source_id AND d.mac = p.device_mac
      JOIN unifi_sources s ON s.id = p.source_id
      ORDER BY s.name, d.name, p.port_idx
    `).all());
  } catch (err) { next(err); }
});

router.get('/clients', (req, res, next) => {
  try {
    res.json(db.prepare(`
      SELECT c.*, s.name AS source_name, ap.name AS ap_name, sw.name AS sw_name
      FROM unifi_clients c
      JOIN unifi_sources s ON s.id = c.source_id
      LEFT JOIN unifi_devices ap ON ap.source_id = c.source_id AND ap.mac = c.ap_mac
      LEFT JOIN unifi_devices sw ON sw.source_id = c.source_id AND sw.mac = c.sw_mac
      ORDER BY s.name, c.name
    `).all());
  } catch (err) { next(err); }
});

router.get('/wifi', (req, res, next) => {
  try {
    const wlans = db.prepare('SELECT w.*, s.name AS source_name FROM unifi_wlans w JOIN unifi_sources s ON s.id = w.source_id ORDER BY s.name, w.name').all();
    const radios = [];
    for (const d of db.prepare("SELECT source_id, mac, name, radios_json FROM unifi_devices WHERE radios_json IS NOT NULL").all()) {
      let list = [];
      try { list = JSON.parse(d.radios_json) || []; } catch { list = []; }
      for (const r of list) {
        radios.push({
          deviceMac: d.mac, deviceName: d.name, radio: r.radio ?? r.name ?? null,
          channel: r.channel ?? null, txPower: r.tx_power ?? null, maxTxPower: r.max_txpower ?? null,
          txPowerMode: r.tx_power_mode ?? null, width: r.ht ?? null, numSta: r.num_sta ?? null,
          satisfaction: r.satisfaction ?? null, utilization: r.cu_total ?? null,
        });
      }
    }
    const rogues = db.prepare('SELECT r.*, s.name AS source_name FROM unifi_rogue_aps r JOIN unifi_sources s ON s.id = r.source_id ORDER BY r.is_rogue DESC, r.signal DESC LIMIT 200').all();
    const bucketOf = (signal) => (signal >= -50 ? 'excellent' : signal >= -60 ? 'good' : signal >= -70 ? 'fair' : 'poor');
    const buckets = { excellent: 0, good: 0, fair: 0, poor: 0 };
    const byAp = new Map();
    const apNames = new Map(db.prepare('SELECT mac, name FROM unifi_devices').all().map((r) => [r.mac, r.name]));
    for (const c of db.prepare('SELECT ap_mac, signal FROM unifi_clients WHERE is_wired = 0 AND signal IS NOT NULL').all()) {
      buckets[bucketOf(c.signal)] += 1;
      const key = c.ap_mac || 'unknown';
      if (!byAp.has(key)) byAp.set(key, { apMac: key, apName: apNames.get(key) || key, buckets: { excellent: 0, good: 0, fair: 0, poor: 0 }, total: 0, signalSum: 0 });
      const a = byAp.get(key);
      a.buckets[bucketOf(c.signal)] += 1;
      a.total += 1;
      a.signalSum += c.signal;
    }
    const signalByAp = [...byAp.values()]
      .map(({ signalSum, ...a }) => ({ ...a, avgSignal: a.total ? Math.round(signalSum / a.total) : null }))
      .sort((x, y) => y.total - x.total);
    res.json({ wlans, radios, rogues, signalBuckets: buckets, signalByAp });
  } catch (err) { next(err); }
});

router.get('/security', (req, res, next) => {
  try {
    const sourceRow = db.prepare('SELECT health_json FROM unifi_sources ORDER BY id LIMIT 1').get();
    let ips = { enabled: false, categories: [], adBlocking: false, raw: null };
    if (sourceRow?.health_json) {
      try {
        const parsed = JSON.parse(sourceRow.health_json)?.ips;
        if (parsed) ips = parsed;
      } catch { /* ignore */ }
    }
    const rogueCounts = db.prepare('SELECT COUNT(*) total, SUM(CASE WHEN is_rogue = 1 THEN 1 ELSE 0 END) flagged FROM unifi_rogue_aps').get();
    const events = db.prepare(`
      SELECT * FROM unifi_events WHERE category = 'SECURITY' ORDER BY occurred_at DESC LIMIT 200
    `).all();
    res.json({ ips, rogueCounts: { total: rogueCounts.total || 0, flagged: rogueCounts.flagged || 0 }, events });
  } catch (err) { next(err); }
});

router.get('/events', [
  query('category').optional().isString().isLength({ max: 60 }),
  query('limit').optional().isInt({ min: 1, max: 500 }).toInt(),
], validate, (req, res, next) => {
  try {
    const limit = req.query.limit || 100;
    if (req.query.category) {
      res.json(db.prepare('SELECT * FROM unifi_events WHERE category = ? ORDER BY occurred_at DESC LIMIT ?').all(req.query.category, limit));
    } else {
      res.json(db.prepare('SELECT * FROM unifi_events ORDER BY occurred_at DESC LIMIT ?').all(limit));
    }
  } catch (err) { next(err); }
});

router.get('/topology', (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM unifi_topology ORDER BY source_id LIMIT 1').get();
    let vertices = [];
    let edges = [];
    if (row) {
      try { vertices = JSON.parse(row.vertices_json) || []; } catch { vertices = []; }
      try { edges = JSON.parse(row.edges_json) || []; } catch { edges = []; }
    }
    const deviceMeta = {};
    for (const d of db.prepare('SELECT mac, name, model, type, state, ip FROM unifi_devices').all()) {
      deviceMeta[d.mac] = { name: d.name, model: d.model, type: d.type, state: d.state, ip: d.ip };
    }
    const clientMeta = {};
    for (const c of db.prepare('SELECT mac, name, hostname, ip, is_wired, signal FROM unifi_clients').all()) {
      clientMeta[c.mac] = { name: c.name, hostname: c.hostname, ip: c.ip, is_wired: c.is_wired, signal: c.signal };
    }
    res.json({
      capturedAt: row?.captured_at || null,
      hasUnknownSwitch: !!row?.has_unknown_switch,
      vertices, edges, deviceMeta, clientMeta,
    });
  } catch (err) { next(err); }
});

router.get('/wan', (req, res, next) => {
  try {
    const wans = db.prepare('SELECT w.*, s.name AS source_name FROM unifi_wan w JOIN unifi_sources s ON s.id = w.source_id').all();
    const history = db.prepare(`
      SELECT source_id, captured_at, wan_latency_ms, wan_availability_pct, wan_tx_rate, wan_rx_rate
      FROM unifi_metrics_history WHERE captured_at >= datetime('now', '-7 days') ORDER BY captured_at ASC
    `).all().map((r) => ({ sourceId: r.source_id, capturedAt: r.captured_at, wanLatencyMs: r.wan_latency_ms, wanAvailabilityPct: r.wan_availability_pct, wanTxRate: r.wan_tx_rate, wanRxRate: r.wan_rx_rate }));
    res.json({ wans, history });
  } catch (err) { next(err); }
});

router.get('/trends', [query('days').optional().isInt({ min: 1, max: 90 }).toInt()], validate, (req, res, next) => {
  try {
    const days = req.query.days || 7;
    res.json(db.prepare(`
      SELECT m.*, s.name AS source_name FROM unifi_metrics_history m
      JOIN unifi_sources s ON s.id = m.source_id
      WHERE m.captured_at >= datetime('now', ?) ORDER BY m.captured_at ASC
    `).all(`-${days} days`));
  } catch (err) { next(err); }
});

router.get('/issues', (req, res, next) => {
  try {
    res.json({ issues: computeIssues() });
  } catch (err) { next(err); }
});

router.get('/issue-history', [query('days').optional().isInt({ min: 1, max: 90 }).toInt()], validate, (req, res, next) => {
  try {
    const days = req.query.days || 30;
    res.json(db.prepare(`
      SELECT * FROM unifi_issue_history
      WHERE status = 'open' OR last_seen >= datetime('now', ?)
      ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, last_seen DESC
    `).all(`-${days} days`));
  } catch (err) { next(err); }
});

router.get('/config', (req, res, next) => {
  try {
    res.json({
      thresholds: {
        unifiWanLatencyWarnMs: wanLatencyWarnMs(),
        unifiWanAvailWarnPct: wanAvailWarnPct(),
        unifiPortErrDeltaWarn: portErrDeltaWarn(),
        unifiPortFlapWarn: portFlapWarn(),
        unifiDeviceCpuWarnPct: deviceCpuWarnPct(),
        unifiDeviceMemWarnPct: deviceMemWarnPct(),
        unifiTempWarnC: tempWarnC(),
        unifiSatisfactionWarn: satisfactionWarn(),
      },
    });
  } catch (err) { next(err); }
});

router.put('/config', [
  body('unifiWanLatencyWarnMs').optional().isInt({ min: 1, max: 5000 }).toInt(),
  body('unifiWanAvailWarnPct').optional().isInt({ min: 0, max: 100 }).toInt(),
  body('unifiPortErrDeltaWarn').optional().isInt({ min: 1, max: 1000000 }).toInt(),
  body('unifiPortFlapWarn').optional().isInt({ min: 1, max: 100 }).toInt(),
  body('unifiDeviceCpuWarnPct').optional().isInt({ min: 1, max: 100 }).toInt(),
  body('unifiDeviceMemWarnPct').optional().isInt({ min: 1, max: 100 }).toInt(),
  body('unifiTempWarnC').optional().isInt({ min: 1, max: 200 }).toInt(),
  body('unifiSatisfactionWarn').optional().isInt({ min: 1, max: 100 }).toInt(),
], validate, (req, res, next) => {
  try {
    const map = {
      unifiWanLatencyWarnMs: 'unifi_wan_latency_warn_ms',
      unifiWanAvailWarnPct: 'unifi_wan_avail_warn_pct',
      unifiPortErrDeltaWarn: 'unifi_port_err_delta_warn',
      unifiPortFlapWarn: 'unifi_port_flap_warn',
      unifiDeviceCpuWarnPct: 'unifi_device_cpu_warn_pct',
      unifiDeviceMemWarnPct: 'unifi_device_mem_warn_pct',
      unifiTempWarnC: 'unifi_temp_warn_c',
      unifiSatisfactionWarn: 'unifi_satisfaction_warn',
    };
    for (const [k, settingKey] of Object.entries(map)) {
      if (req.body[k] !== undefined) setSetting(settingKey, String(req.body[k]));
    }
    res.json({
      thresholds: {
        unifiWanLatencyWarnMs: wanLatencyWarnMs(),
        unifiWanAvailWarnPct: wanAvailWarnPct(),
        unifiPortErrDeltaWarn: portErrDeltaWarn(),
        unifiPortFlapWarn: portFlapWarn(),
        unifiDeviceCpuWarnPct: deviceCpuWarnPct(),
        unifiDeviceMemWarnPct: deviceMemWarnPct(),
        unifiTempWarnC: tempWarnC(),
        unifiSatisfactionWarn: satisfactionWarn(),
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
