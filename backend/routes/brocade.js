// Brocade SAN routes. Mounted by the plugin dispatcher at /api/brocade —
// paths are relative. Model: routes/unifi.js (registration CRUD, keep-if-
// blank password, probe endpoint, computed issues).
const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const db = require('../db/database');
const { encrypt } = require('../services/encryption');
const brocadeApi = require('../services/brocadeApi');
const { brocadePollerHandle: brocadePoller } = require('../services/brocadePoller');
const {
  healthWarnScore, healthCritScore, certWarnDays, eventStormCount, eventRetentionDays,
  computeIssues,
} = require('../services/brocadeIssues');
const { portStatsRetentionDays } = require('../services/brocadePoller');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid parameters', details: errors.array() });
  next();
};

const parseJson = (s, fallback = null) => {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

// ── Public shapes (never leak password_enc) ─────────────────────────────────

const publicSource = (row) => ({
  id: row.id,
  name: row.name,
  host: row.host,
  port: row.port,
  username: row.username,
  verifySsl: !!row.verify_ssl,
  enabled: !!row.enabled,
  pollingIntervalMinutes: row.polling_interval_minutes,
  eventPollMinutes: row.event_poll_minutes,
  fosProxyEnabled: !!row.fos_proxy_enabled,
  portStatsIntervalMinutes: row.port_stats_interval_minutes,
  sannavVersion: row.sannav_version,
  oemName: row.oem_name,
  lastPollAt: row.last_poll_at,
  lastPollStatus: row.last_poll_status,
  lastPollError: row.last_poll_error,
  lastEventPollAt: row.last_event_poll_at,
  sectionErrors: parseJson(row.section_errors),
  createdAt: row.created_at,
});

const statusLabel = (status) => ({
  0: 'Unknown', 1: 'Healthy', 2: 'Marginal', 3: 'Down', 5: 'Reachable', 6: 'Unreachable', 7: 'Degraded link',
}[status] ?? 'Unknown');

// ── Source registration CRUD ────────────────────────────────────────────────

router.get('/sources', (req, res, next) => {
  try {
    res.json({ sources: db.prepare('SELECT * FROM brocade_sources ORDER BY name').all().map(publicSource) });
  } catch (err) { next(err); }
});

router.post('/sources', [
  body('name').isString().trim().notEmpty().isLength({ max: 120 }),
  body('host').isString().trim().notEmpty().isLength({ max: 253 }),
  body('port').optional().isInt({ min: 1, max: 65535 }).toInt(),
  body('username').isString().trim().notEmpty().isLength({ max: 120 }),
  body('password').isString().notEmpty().isLength({ max: 512 }),
  body('verifySsl').optional().isBoolean(),
  body('pollingIntervalMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
  body('eventPollMinutes').optional().isInt({ min: 1, max: 1440 }).toInt(),
  body('fosProxyEnabled').optional().isBoolean(),
], validate, (req, res, next) => {
  try {
    const { name, host, port, username, password, verifySsl, pollingIntervalMinutes, eventPollMinutes, fosProxyEnabled } = req.body;
    const dup = db.prepare('SELECT id FROM brocade_sources WHERE host = ? AND port = ?').get(host.trim(), port || 443);
    if (dup) return res.status(409).json({ error: 'duplicate' });
    const info = db.prepare(`
      INSERT INTO brocade_sources (name, host, port, username, password_enc, verify_ssl,
        polling_interval_minutes, event_poll_minutes, fos_proxy_enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name.trim(), host.trim(), port || 443, username.trim(), encrypt(password), verifySsl ? 1 : 0,
      pollingIntervalMinutes || 60, eventPollMinutes || 5, fosProxyEnabled === false ? 0 : 1);
    const row = db.prepare('SELECT * FROM brocade_sources WHERE id = ?').get(info.lastInsertRowid);
    brocadePoller.schedule(row);
    brocadePoller.trigger(row).catch(() => {});
    res.status(201).json({ source: publicSource(row) });
  } catch (err) { next(err); }
});

router.put('/sources/:id', [
  param('id').isInt().toInt(),
  body('name').optional().isString().trim().notEmpty().isLength({ max: 120 }),
  body('host').optional().isString().trim().notEmpty().isLength({ max: 253 }),
  body('port').optional().isInt({ min: 1, max: 65535 }).toInt(),
  body('username').optional().isString().trim().notEmpty().isLength({ max: 120 }),
  body('password').optional({ checkFalsy: true }).isString().isLength({ max: 512 }),
  body('verifySsl').optional().isBoolean(),
  body('enabled').optional().isBoolean(),
  body('pollingIntervalMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
  body('eventPollMinutes').optional().isInt({ min: 1, max: 1440 }).toInt(),
  body('fosProxyEnabled').optional().isBoolean(),
  body('portStatsIntervalMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM brocade_sources WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    const b = req.body;
    db.prepare(`
      UPDATE brocade_sources SET
        name = ?, host = ?, port = ?, username = ?, password_enc = ?, verify_ssl = ?, enabled = ?,
        polling_interval_minutes = ?, event_poll_minutes = ?, fos_proxy_enabled = ?, port_stats_interval_minutes = ?
      WHERE id = ?
    `).run(
      b.name?.trim() || row.name, b.host?.trim() || row.host, b.port || row.port,
      b.username?.trim() || row.username,
      b.password ? encrypt(b.password) : row.password_enc,
      b.verifySsl !== undefined ? (b.verifySsl ? 1 : 0) : row.verify_ssl,
      b.enabled !== undefined ? (b.enabled ? 1 : 0) : row.enabled,
      b.pollingIntervalMinutes || row.polling_interval_minutes,
      b.eventPollMinutes || row.event_poll_minutes,
      b.fosProxyEnabled !== undefined ? (b.fosProxyEnabled ? 1 : 0) : row.fos_proxy_enabled,
      b.portStatsIntervalMinutes || row.port_stats_interval_minutes,
      row.id
    );
    const updated = db.prepare('SELECT * FROM brocade_sources WHERE id = ?').get(row.id);
    brocadePoller.schedule(updated);
    res.json({ source: publicSource(updated) });
  } catch (err) { next(err); }
});

router.delete('/sources/:id', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM brocade_sources WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    brocadePoller.cancel(row.id);
    db.prepare('DELETE FROM brocade_sources WHERE id = ?').run(row.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/sources/:id/test', [
  param('id').isInt().toInt(),
  body('host').optional().isString().trim().notEmpty(),
  body('port').optional().isInt({ min: 1, max: 65535 }).toInt(),
  body('username').optional().isString(),
  body('password').optional().isString(),
], validate, async (req, res) => {
  const row = db.prepare('SELECT * FROM brocade_sources WHERE id = ?').get(req.params.id);
  // Unsaved sources (the Settings "add" form) test with id 0 and full override
  // creds in the body — allow that; 404 only when there is neither a row nor creds.
  if (!row && !(req.body.host && req.body.username && req.body.password)) {
    return res.status(404).json({ error: 'not_found' });
  }
  const base = row || { verify_ssl: 0 };
  const candidate = {
    ...base,
    host: req.body.host?.trim() || base.host,
    port: req.body.port || base.port || 443,
    username: req.body.username?.trim() || base.username,
    password: req.body.password || undefined,
  };
  const result = await brocadeApi.testConnection(candidate);
  res.status(200).json(result);
});

router.post('/sources/:id/poll', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM brocade_sources WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    brocadePoller.trigger(row).catch(() => {});
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/sources/:id/poll-events', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM brocade_sources WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    brocadePoller.triggerEvents(row).catch(() => {});
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/sources/:id/poll-port-stats', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM brocade_sources WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    brocadePoller.triggerPortStats(row).catch(() => {});
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/sources/:id/probe', [
  param('id').isInt().toInt(),
  query('section').isIn(['fabrics', 'switches', 'switchports', 'deviceports', 'enclosures', 'chassis', 'health', 'events', 'zoning', 'fcr', 'about', 'portstats']),
], validate, async (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM brocade_sources WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    const section = req.query.section;
    let raw;
    try {
      switch (section) {
        case 'fabrics': raw = await brocadeApi.fetchFabrics(row, 30000); break;
        case 'switches': raw = await brocadeApi.fetchSwitches(row, 30000); break;
        case 'switchports': raw = await brocadeApi.fetchSwitchPorts(row, 30000); break;
        case 'deviceports': raw = await brocadeApi.fetchDevicePorts(row, 30000); break;
        case 'enclosures': raw = await brocadeApi.fetchEnclosures(row, 30000); break;
        case 'chassis': raw = await brocadeApi.fetchChassis(row, 30000); break;
        case 'health': raw = await brocadeApi.fetchHealthSummary(row, 'FABRIC', 30000); break;
        case 'events': {
          const now = Date.now();
          const page = await brocadeApi.fetchEventsPage(row, { startTime: now - 3600000, endTime: now, pageSize: 50, timeout: 30000 });
          raw = page.events;
          break;
        }
        case 'fcr': raw = await brocadeApi.fetchFcrTopology(row, 30000); break;
        case 'about': raw = [await brocadeApi.fetchAbout(row, 30000)]; break;
        case 'portstats': {
          const sw = db.prepare('SELECT * FROM brocade_switches WHERE source_id = ? AND stale = 0 AND ip_address IS NOT NULL LIMIT 1').get(row.id);
          if (!sw) { raw = []; break; }
          const vfId = sw.virtual_fabric_id != null && sw.virtual_fabric_id >= 0 ? sw.virtual_fabric_id : -1;
          raw = await brocadeApi.fetchPortStats(row, { switchIp: sw.ip_address, vfId, timeout: 30000 });
          break;
        }
        case 'zoning': {
          const fabric = db.prepare('SELECT * FROM brocade_fabrics WHERE source_id = ? AND stale = 0 LIMIT 1').get(row.id);
          if (!fabric || !fabric.seed_switch_ip) { raw = []; break; }
          const eff = await brocadeApi.fetchEffectiveZoneConfig(row, { switchIp: fabric.seed_switch_ip, vfId: fabric.virtual_fabric_id ?? -1, timeout: 30000 });
          raw = [eff];
          break;
        }
        default: raw = [];
      }
    } catch (err) {
      return res.json({ section, count: 0, keys: [], first: null, error: brocadeApi.errMsg(err) });
    }
    const arr = Array.isArray(raw) ? raw : [];
    res.json({ section, count: arr.length, keys: arr[0] ? Object.keys(arr[0]) : [], first: arr[0] || null });
  } catch (err) { next(err); }
});

// ── Data endpoints ───────────────────────────────────────────────────────────

router.get('/overview', (req, res, next) => {
  try {
    const srcTotals = db.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN last_poll_status = 'error' THEN 1 ELSE 0 END) errored FROM brocade_sources`).get();
    const fabricTotals = db.prepare(`
      SELECT COUNT(*) total, SUM(CASE WHEN status IN (1,5) THEN 1 ELSE 0 END) healthy,
        SUM(CASE WHEN status IN (2,7) THEN 1 ELSE 0 END) degraded
      FROM brocade_fabrics WHERE stale = 0
    `).get();
    const swTotals = db.prepare(`
      SELECT COUNT(*) total,
        SUM(CASE WHEN UPPER(COALESCE(operational_status,'')) = 'HEALTHY' THEN 1 ELSE 0 END) healthy,
        SUM(CASE WHEN UPPER(COALESCE(operational_status,'')) = 'MARGINAL' THEN 1 ELSE 0 END) marginal,
        SUM(CASE WHEN UPPER(COALESCE(operational_status,'')) = 'CRITICAL' THEN 1 ELSE 0 END) critical,
        SUM(CASE WHEN is_missing = 1 THEN 1 ELSE 0 END) unreachable
      FROM brocade_switches WHERE stale = 0
    `).get();
    const portTotals = db.prepare(`
      SELECT COUNT(*) total,
        SUM(CASE WHEN LOWER(COALESCE(state,'')) = 'online' THEN 1 ELSE 0 END) online,
        SUM(CASE WHEN LOWER(COALESCE(state,'')) = 'offline' THEN 1 ELSE 0 END) offline,
        SUM(CASE WHEN health = 'Error' THEN 1 ELSE 0 END) error,
        SUM(CASE WHEN occupied = 1 THEN 1 ELSE 0 END) occupied
      FROM brocade_switch_ports WHERE stale = 0
    `).get();
    const devicePortTotals = db.prepare(`
      SELECT COUNT(*) total,
        SUM(CASE WHEN LOWER(COALESCE(port_role,'')) = 'initiator' THEN 1 ELSE 0 END) hosts,
        SUM(CASE WHEN LOWER(COALESCE(port_role,'')) = 'target' THEN 1 ELSE 0 END) storage
      FROM brocade_device_ports WHERE stale = 0
    `).get();
    const enclosureTotals = db.prepare(`
      SELECT COUNT(*) total,
        SUM(CASE WHEN LOWER(COALESCE(type,'')) LIKE '%host%' THEN 1 ELSE 0 END) hosts,
        SUM(CASE WHEN LOWER(COALESCE(type,'')) LIKE '%storage%' THEN 1 ELSE 0 END) storage
      FROM brocade_enclosures WHERE stale = 0
    `).get();
    const zonesTotal = db.prepare('SELECT COUNT(*) n FROM brocade_zones WHERE stale = 0').get().n;
    const aliasesTotal = db.prepare('SELECT COUNT(*) n FROM brocade_zone_aliases WHERE stale = 0').get().n;
    const configsTotal = db.prepare('SELECT COUNT(*) n FROM brocade_zone_configs WHERE stale = 0').get().n;
    const recentChanges = db.prepare(`SELECT COUNT(*) n FROM brocade_zone_changes WHERE detected_at >= datetime('now', '-1 day')`).get().n;
    const eventTotals = db.prepare(`
      SELECT
        SUM(CASE WHEN severity_norm IN ('critical','alert') AND last_occurred_ms >= ? THEN 1 ELSE 0 END) critical,
        SUM(CASE WHEN severity_norm = 'warning' AND last_occurred_ms >= ? THEN 1 ELSE 0 END) warning,
        SUM(CASE WHEN severity_norm = 'info' AND last_occurred_ms >= ? THEN 1 ELSE 0 END) info
      FROM brocade_events
    `).get(Date.now() - 86400000, Date.now() - 86400000, Date.now() - 86400000);
    const healthAgg = db.prepare(`SELECT AVG(score) avg, MIN(score) min FROM brocade_health_scores WHERE stale = 0 AND entity_type = 'FABRIC'`).get();
    const issues = computeIssues();
    const issueCounts = { critical: 0, warning: 0, info: 0 };
    for (const i of issues) issueCounts[i.severity] = (issueCounts[i.severity] || 0) + 1;

    res.json({
      sources: { total: srcTotals.total || 0, ok: (srcTotals.total || 0) - (srcTotals.errored || 0), error: srcTotals.errored || 0 },
      fabrics: { total: fabricTotals.total || 0, healthy: fabricTotals.healthy || 0, degraded: fabricTotals.degraded || 0 },
      switches: { total: swTotals.total || 0, healthy: swTotals.healthy || 0, marginal: swTotals.marginal || 0, critical: swTotals.critical || 0, unreachable: swTotals.unreachable || 0 },
      ports: { total: portTotals.total || 0, online: portTotals.online || 0, offline: portTotals.offline || 0, error: portTotals.error || 0, occupied: portTotals.occupied || 0 },
      devicePorts: { total: devicePortTotals.total || 0, hosts: devicePortTotals.hosts || 0, storage: devicePortTotals.storage || 0 },
      enclosures: { total: enclosureTotals.total || 0, hosts: enclosureTotals.hosts || 0, storage: enclosureTotals.storage || 0 },
      zoning: { zones: zonesTotal, aliases: aliasesTotal, configs: configsTotal, recentChanges24h: recentChanges },
      events: { critical24h: eventTotals.critical || 0, warning24h: eventTotals.warning || 0, info24h: eventTotals.info || 0 },
      health: { avgFabricScore: healthAgg.avg != null ? Math.round(healthAgg.avg) : null, minFabricScore: healthAgg.min ?? null },
      issues: issueCounts,
    });
  } catch (err) { next(err); }
});

router.get('/fabrics', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT f.*, s.name AS source_name,
        h.score AS health_score
      FROM brocade_fabrics f
      JOIN brocade_sources s ON s.id = f.source_id
      LEFT JOIN brocade_health_scores h ON h.source_id = f.source_id AND h.entity_type = 'FABRIC' AND h.entity_guid = COALESCE(f.guid, f.name) AND h.stale = 0
      WHERE f.stale = 0 ORDER BY s.name, f.name
    `).all();
    res.json({
      fabrics: rows.map((f) => ({
        id: f.id, sourceId: f.source_id, sourceName: f.source_name, name: f.name,
        principalSwitchWwn: f.principal_switch_wwn, seedSwitchIp: f.seed_switch_ip, seedSwitchName: f.seed_switch_name,
        status: f.status, statusLabel: statusLabel(f.status), health: f.health, switchCount: f.switch_count,
        activeZonesetName: f.active_zoneset_name, virtualFabricId: f.virtual_fabric_id, score: f.health_score ?? null,
        managed: !!f.managed,
      })),
    });
  } catch (err) { next(err); }
});

router.get('/fabrics/:id', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const f = db.prepare('SELECT f.*, s.name AS source_name FROM brocade_fabrics f JOIN brocade_sources s ON s.id = f.source_id WHERE f.id = ?').get(req.params.id);
    if (!f) return res.status(404).json({ error: 'not_found' });
    const switches = db.prepare('SELECT * FROM brocade_switches WHERE source_id = ? AND fabric_name = ? AND stale = 0').all(f.source_id, f.name);
    const health = db.prepare(`SELECT * FROM brocade_health_scores WHERE source_id = ? AND entity_type = 'FABRIC' AND entity_guid = ? AND stale = 0`).get(f.source_id, f.guid || f.name);
    const zoneConfig = db.prepare('SELECT * FROM brocade_zone_configs WHERE source_id = ? AND fabric_name = ? AND is_effective = 1 AND stale = 0').get(f.source_id, f.name);
    res.json({
      fabric: {
        id: f.id, sourceId: f.source_id, sourceName: f.source_name, name: f.name,
        principalSwitchWwn: f.principal_switch_wwn, seedSwitchIp: f.seed_switch_ip, seedSwitchName: f.seed_switch_name,
        status: f.status, statusLabel: statusLabel(f.status), health: f.health, switchCount: f.switch_count,
        activeZonesetName: f.active_zoneset_name, virtualFabricId: f.virtual_fabric_id, managed: !!f.managed,
        managementState: f.management_state, lastFabricChanged: f.last_fabric_changed,
      },
      switches,
      healthScore: health ? { score: health.score, status: health.status, contributors: parseJson(health.contributors_json, []) } : null,
      zoneConfig: zoneConfig ? { cfgName: zoneConfig.cfg_name, defaultZoneAccess: zoneConfig.default_zone_access, checksum: zoneConfig.checksum, zoneCount: parseJson(zoneConfig.member_zones, []).length } : null,
    });
  } catch (err) { next(err); }
});

router.get('/switches', [
  query('fabric').optional().isString(),
  query('sourceId').optional().isInt().toInt(),
  query('status').optional().isString(),
], validate, (req, res, next) => {
  try {
    const clauses = ['stale = 0'];
    const params = [];
    if (req.query.fabric) { clauses.push('fabric_name = ?'); params.push(req.query.fabric); }
    if (req.query.sourceId) { clauses.push('source_id = ?'); params.push(req.query.sourceId); }
    if (req.query.status) { clauses.push('UPPER(COALESCE(operational_status,"")) = ?'); params.push(String(req.query.status).toUpperCase()); }
    const rows = db.prepare(`
      SELECT sw.*, s.name AS source_name FROM brocade_switches sw JOIN brocade_sources s ON s.id = sw.source_id
      WHERE ${clauses.join(' AND ')} ORDER BY s.name, sw.name
    `).all(...params);
    res.json({
      switches: rows.map((sw) => ({
        id: sw.id, sourceId: sw.source_id, sourceName: sw.source_name, wwn: sw.wwn, name: sw.name,
        ipAddress: sw.ip_address, model: sw.model, modelNumber: sw.model_number, firmwareVersion: sw.firmware_version,
        serialNumber: sw.serial_number, fabricName: sw.fabric_name, role: sw.role, state: sw.state, status: sw.status,
        operationalStatus: sw.operational_status, health: sw.health, statusReason: sw.status_reason,
        portCount: sw.discovered_port_count, maxPort: sw.max_port, eosStatus: sw.eos_status,
        maintenanceMode: !!sw.maintenance_mode, tlsCertExpiryMs: sw.tls_cert_expiry_ms,
        managementState: sw.management_state, isMissing: !!sw.is_missing, stale: !!sw.stale,
      })),
    });
  } catch (err) { next(err); }
});

router.get('/switches/:id', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const sw = db.prepare('SELECT sw.*, s.name AS source_name FROM brocade_switches sw JOIN brocade_sources s ON s.id = sw.source_id WHERE sw.id = ?').get(req.params.id);
    if (!sw) return res.status(404).json({ error: 'not_found' });
    const ports = db.prepare('SELECT * FROM brocade_switch_ports WHERE source_id = ? AND switch_wwn = ?').all(sw.source_id, sw.wwn);
    const health = db.prepare(`SELECT * FROM brocade_health_scores WHERE source_id = ? AND entity_type = 'SWITCH' AND entity_guid = ? AND stale = 0`).get(sw.source_id, sw.wwn);
    const chassis = db.prepare('SELECT * FROM brocade_chassis WHERE source_id = ? AND wwn = ?').get(sw.source_id, sw.physical_switch_wwn);
    const { decodeMgmtState } = require('../services/brocadeIssues');
    res.json({
      switch: { ...sw, managementStateLabels: decodeMgmtState(sw.management_state) },
      ports,
      healthScore: health ? { score: health.score, status: health.status, contributors: parseJson(health.contributors_json, []) } : null,
      chassis: chassis || null,
    });
  } catch (err) { next(err); }
});

router.get('/ports', [
  query('switch').optional().isString(),
  query('fabric').optional().isString(),
  query('state').optional().isString(),
  query('health').optional().isString(),
  query('search').optional().isString(),
  query('limit').optional().isInt({ min: 1, max: 5000 }).toInt(),
  query('offset').optional().isInt({ min: 0 }).toInt(),
], validate, (req, res, next) => {
  try {
    const clauses = ['sp.stale = 0'];
    const params = [];
    if (req.query.switch) { clauses.push('sp.switch_wwn = ?'); params.push(req.query.switch); }
    if (req.query.fabric) { clauses.push('sp.fabric_name = ?'); params.push(req.query.fabric); }
    if (req.query.state) { clauses.push('LOWER(COALESCE(sp.state,"")) = ?'); params.push(String(req.query.state).toLowerCase()); }
    if (req.query.health) { clauses.push('sp.health = ?'); params.push(req.query.health); }
    if (req.query.search) { clauses.push('(sp.name LIKE ? OR sp.wwn LIKE ?)'); params.push(`%${req.query.search}%`, `%${req.query.search}%`); }
    const limit = Math.min(req.query.limit || 5000, 5000);
    const offset = req.query.offset || 0;
    const rows = db.prepare(`
      SELECT sp.*, ls.in_frames_per_sec, ls.out_frames_per_sec, ls.in_mb_per_sec, ls.out_mb_per_sec,
        ls.crc_errors_delta, ls.stats_ts
      FROM brocade_switch_ports sp
      LEFT JOIN (
        SELECT ps.port_wwn AS stat_port_wwn, ps.in_frames_per_sec, ps.out_frames_per_sec, ps.in_mb_per_sec,
          ps.out_mb_per_sec, ps.crc_errors_delta, ps.ts AS stats_ts
        FROM brocade_port_stats ps
        JOIN (SELECT port_wwn, MAX(ts) AS max_ts FROM brocade_port_stats GROUP BY port_wwn) latest
          ON latest.port_wwn = ps.port_wwn AND latest.max_ts = ps.ts
      ) ls ON ls.stat_port_wwn = sp.wwn
      WHERE ${clauses.join(' AND ')} ORDER BY sp.switch_name, sp.port_number LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    res.json({
      ports: rows.map((p) => ({
        id: p.id, sourceId: p.source_id, wwn: p.wwn, switchWwn: p.switch_wwn, switchName: p.switch_name,
        name: p.name, slotNumber: p.slot_number, portNumber: p.port_number, portIndex: p.port_index,
        portId: p.port_id, type: p.type, state: p.state, status: p.status, health: p.health,
        calculatedStatus: p.calculated_status, statusMessage: p.status_message, speed: p.speed,
        maxPortSpeed: p.max_port_speed, remoteDevice: p.remote_device, remotePortWwn: p.remote_port_wwn,
        connectedDeviceType: p.connected_device_type, trunked: !!p.trunked, fenced: !!p.fenced, blocked: !!p.blocked,
        zoneAlias: p.zone_alias, activeZoneCount: p.active_zone_count, fabricName: p.fabric_name,
        lastUpdateMs: p.last_update_ms,
        inFramesPerSec: p.in_frames_per_sec ?? null, outFramesPerSec: p.out_frames_per_sec ?? null,
        inMbPerSec: p.in_mb_per_sec ?? null, outMbPerSec: p.out_mb_per_sec ?? null,
        crcErrorsDelta: p.crc_errors_delta ?? null, statsTs: p.stats_ts ?? null,
      })),
    });
  } catch (err) { next(err); }
});

router.get('/port-stats', [
  query('wwns').isString().notEmpty(),
  query('hours').optional().isInt({ min: 1, max: 720 }).toInt(),
], validate, (req, res, next) => {
  try {
    const wwns = String(req.query.wwns).split(',').map((w) => w.trim()).filter(Boolean).slice(0, 8);
    if (!wwns.length) return res.status(400).json({ error: 'wwns required' });
    const hours = req.query.hours || 24;
    const series = {};
    const ports = {};
    const portStmt = db.prepare('SELECT * FROM brocade_switch_ports WHERE wwn = ?');
    const seriesStmt = db.prepare(`
      SELECT ts, in_frames_per_sec, out_frames_per_sec, in_mb_per_sec, out_mb_per_sec, crc_errors_delta
      FROM brocade_port_stats WHERE port_wwn = ? AND ts >= datetime('now', ?) ORDER BY ts ASC
    `);
    for (const w of wwns) {
      series[w] = seriesStmt.all(w, `-${hours} hours`).map((r) => ({
        ts: r.ts, inFramesPerSec: r.in_frames_per_sec, outFramesPerSec: r.out_frames_per_sec,
        inMbPerSec: r.in_mb_per_sec, outMbPerSec: r.out_mb_per_sec, crcErrorsDelta: r.crc_errors_delta,
      }));
      const p = portStmt.get(w);
      ports[w] = p ? {
        name: p.name, switchName: p.switch_name, slotNumber: p.slot_number, portNumber: p.port_number,
        remoteDevice: p.remote_device,
      } : null;
    }
    res.json({ series, ports });
  } catch (err) { next(err); }
});

router.get('/device-ports', [
  query('type').optional().isString(),
  query('fabric').optional().isString(),
  query('search').optional().isString(),
], validate, (req, res, next) => {
  try {
    const clauses = ['stale = 0'];
    const params = [];
    if (req.query.type) { clauses.push('LOWER(COALESCE(port_role,"")) = ?'); params.push(String(req.query.type).toLowerCase()); }
    if (req.query.fabric) { clauses.push('fabric_name = ?'); params.push(req.query.fabric); }
    if (req.query.search) { clauses.push('(symbolic_name LIKE ? OR wwn LIKE ?)'); params.push(`%${req.query.search}%`, `%${req.query.search}%`); }
    const rows = db.prepare(`SELECT * FROM brocade_device_ports WHERE ${clauses.join(' AND ')} ORDER BY switch_name, port_number`).all(...params);
    res.json({
      devicePorts: rows.map((p) => ({
        id: p.id, sourceId: p.source_id, wwn: p.wwn, deviceNodeWwn: p.device_node_wwn, symbolicName: p.symbolic_name,
        vendor: p.vendor, portRole: p.port_role, fabricName: p.fabric_name, switchName: p.switch_name,
        switchPortWwn: p.switch_port_wwn, switchPortName: p.switch_port_name, enclosureName: p.enclosure_name,
        enclosureGuid: p.enclosure_guid, fdmiHostName: p.fdmi_host_name, activeZones: parseJson(p.active_zones, []),
        activeZonesetName: p.active_zoneset_name, zoneAlias: p.zone_alias, speed: p.speed, isMissing: !!p.is_missing,
      })),
    });
  } catch (err) { next(err); }
});

router.get('/enclosures', [
  query('type').optional().isString(),
  query('search').optional().isString(),
], validate, (req, res, next) => {
  try {
    const clauses = ['stale = 0'];
    const params = [];
    if (req.query.type) { clauses.push('LOWER(COALESCE(type,"")) LIKE ?'); params.push(`%${String(req.query.type).toLowerCase()}%`); }
    if (req.query.search) { clauses.push('(name LIKE ? OR host_name LIKE ?)'); params.push(`%${req.query.search}%`, `%${req.query.search}%`); }
    const rows = db.prepare(`SELECT * FROM brocade_enclosures WHERE ${clauses.join(' AND ')} ORDER BY name`).all(...params);
    const portCount = db.prepare('SELECT COUNT(*) n FROM brocade_device_ports WHERE enclosure_guid = ? AND stale = 0');
    res.json({
      enclosures: rows.map((e) => ({
        id: e.id, sourceId: e.source_id, guid: e.guid, name: e.name, type: e.type, hostName: e.host_name,
        ipAddress: e.ip_address, vendor: e.vendor, model: e.model, health: e.health, location: e.location,
        tags: e.tags, portCount: portCount.get(e.guid).n,
      })),
    });
  } catch (err) { next(err); }
});

router.get('/chassis', (req, res, next) => {
  try {
    const rows = db.prepare('SELECT * FROM brocade_chassis WHERE stale = 0 ORDER BY name').all();
    res.json({
      chassis: rows.map((c) => ({
        id: c.id, sourceId: c.source_id, switchId: c.switch_id, wwn: c.wwn, name: c.name, ipAddress: c.ip_address,
        modelNumber: c.model_number, firmware: c.firmware, serialNumber: c.serial_number, partNumber: c.part_number,
        vendor: c.vendor, maxPort: c.max_port, numVirtualSwitches: c.num_virtual_switches,
        maxVirtualSwitches: c.max_virtual_switches, tlsCertExpiryMs: c.tls_cert_expiry_ms,
      })),
    });
  } catch (err) { next(err); }
});

router.get('/zoning', [query('fabric').notEmpty()], validate, (req, res, next) => {
  try {
    const fabric = req.query.fabric;
    const configs = db.prepare('SELECT * FROM brocade_zone_configs WHERE fabric_name = ? AND stale = 0').all(fabric)
      .map((c) => ({ cfgName: c.cfg_name, isEffective: !!c.is_effective, memberZones: parseJson(c.member_zones, []), defaultZoneAccess: c.default_zone_access, checksum: c.checksum }));
    const zones = db.prepare('SELECT * FROM brocade_zones WHERE fabric_name = ? AND stale = 0').all(fabric)
      .map((z) => ({ zoneName: z.zone_name, zoneType: z.zone_type, zoneTypeString: z.zone_type_string, members: parseJson(z.members, []), inEffective: !!z.in_effective }));
    const aliases = db.prepare('SELECT * FROM brocade_zone_aliases WHERE fabric_name = ? AND stale = 0').all(fabric)
      .map((a) => ({ aliasName: a.alias_name, members: parseJson(a.members, []) }));
    res.json({ configs, zones, aliases });
  } catch (err) { next(err); }
});

router.get('/zoning/fabrics', (req, res, next) => {
  try {
    const fabrics = db.prepare('SELECT f.*, s.name AS source_name FROM brocade_fabrics f JOIN brocade_sources s ON s.id = f.source_id WHERE f.stale = 0').all();
    res.json({
      fabrics: fabrics.map((f) => {
        const zoneCount = db.prepare('SELECT COUNT(*) n FROM brocade_zones WHERE source_id = ? AND fabric_name = ? AND stale = 0').get(f.source_id, f.name).n;
        const aliasCount = db.prepare('SELECT COUNT(*) n FROM brocade_zone_aliases WHERE source_id = ? AND fabric_name = ? AND stale = 0').get(f.source_id, f.name).n;
        const eff = db.prepare('SELECT cfg_name FROM brocade_zone_configs WHERE source_id = ? AND fabric_name = ? AND is_effective = 1 AND stale = 0').get(f.source_id, f.name);
        const lastChange = db.prepare('SELECT MAX(detected_at) t FROM brocade_zone_changes WHERE source_id = ? AND fabric_name = ?').get(f.source_id, f.name);
        return { fabricName: f.name, sourceId: f.source_id, sourceName: f.source_name, zoneCount, aliasCount, effectiveCfg: eff?.cfg_name || null, lastChangeAt: lastChange?.t || null };
      }),
    });
  } catch (err) { next(err); }
});

router.get('/zoning/changes', [
  query('fabric').optional().isString(),
  query('limit').optional().isInt({ min: 1, max: 1000 }).toInt(),
], validate, (req, res, next) => {
  try {
    const limit = req.query.limit || 200;
    const clauses = [];
    const params = [];
    if (req.query.fabric) { clauses.push('fabric_name = ?'); params.push(req.query.fabric); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM brocade_zone_changes ${where} ORDER BY detected_at DESC LIMIT ?`).all(...params, limit);
    res.json({
      changes: rows.map((c) => ({
        id: c.id, sourceId: c.source_id, fabricName: c.fabric_name, changeType: c.change_type, detail: c.detail,
        oldValue: c.old_value, newValue: c.new_value, detectedAt: c.detected_at,
      })),
    });
  } catch (err) { next(err); }
});

router.get('/events', [
  query('severity').optional().isString(),
  query('category').optional().isString(),
  query('acknowledged').optional().isString(),
  query('search').optional().isString(),
  query('hours').optional().isInt({ min: 1, max: 720 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 1000 }).toInt(),
  query('offset').optional().isInt({ min: 0 }).toInt(),
], validate, (req, res, next) => {
  try {
    const hours = req.query.hours || 24;
    const limit = req.query.limit || 100;
    const offset = req.query.offset || 0;
    const clauses = ['e.last_occurred_ms >= ?'];
    const params = [Date.now() - hours * 3600000];
    if (req.query.severity) { clauses.push('e.severity_norm = ?'); params.push(String(req.query.severity).toLowerCase()); }
    if (req.query.category) { clauses.push('e.event_category = ?'); params.push(req.query.category); }
    if (req.query.acknowledged !== undefined) { clauses.push('e.acknowledged = ?'); params.push(req.query.acknowledged === 'true' || req.query.acknowledged === '1' ? 1 : 0); }
    if (req.query.search) { clauses.push('(e.description LIKE ? OR e.source_name LIKE ?)'); params.push(`%${req.query.search}%`, `%${req.query.search}%`); }
    const total = db.prepare(`SELECT COUNT(*) n FROM brocade_events e WHERE ${clauses.join(' AND ')}`).get(...params).n;
    const rows = db.prepare(`
      SELECT e.*, s.name AS source_label FROM brocade_events e JOIN brocade_sources s ON s.id = e.source_id
      WHERE ${clauses.join(' AND ')} ORDER BY e.last_occurred_ms DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    res.json({
      events: rows.map((e) => ({
        id: e.id, sourceId: e.source_id, sourceLabel: e.source_label, eventId: e.event_id, severity: e.severity,
        severityNorm: e.severity_norm, eventCategory: e.event_category, sourceName: e.source_name,
        sourceAddress: e.source_address, sourceType: e.source_type, fabricName: e.fabric_name,
        messageId: e.message_id, origin: e.origin, description: e.description, eventCount: e.event_count,
        firstOccurredMs: e.first_occurred_ms, lastOccurredMs: e.last_occurred_ms, acknowledged: !!e.acknowledged,
        ackBy: e.ack_by, ackNotes: e.ack_notes,
      })),
      total,
    });
  } catch (err) { next(err); }
});

router.post('/events/ack', [
  body('sourceId').isInt().toInt(),
  body('eventIds').isArray({ min: 1 }),
  body('notes').optional().isString(),
], validate, async (req, res) => {
  const row = db.prepare('SELECT * FROM brocade_sources WHERE id = ?').get(req.body.sourceId);
  if (!row) return res.status(404).json({ error: 'not_found' });
  try {
    await brocadeApi.ackEvents(row, req.body.eventIds, req.body.notes);
    const ph = req.body.eventIds.map(() => '?').join(',');
    db.prepare(`UPDATE brocade_events SET acknowledged = 1, ack_notes = ?, acked_time_ms = ? WHERE source_id = ? AND event_id IN (${ph})`)
      .run(req.body.notes || null, Date.now(), row.id, ...req.body.eventIds);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: brocadeApi.errMsg(err) });
  }
});

router.post('/events/unack', [
  body('sourceId').isInt().toInt(),
  body('eventIds').isArray({ min: 1 }),
  body('notes').optional().isString(),
], validate, async (req, res) => {
  const row = db.prepare('SELECT * FROM brocade_sources WHERE id = ?').get(req.body.sourceId);
  if (!row) return res.status(404).json({ error: 'not_found' });
  try {
    await brocadeApi.unackEvents(row, req.body.eventIds, req.body.notes);
    const ph = req.body.eventIds.map(() => '?').join(',');
    db.prepare(`UPDATE brocade_events SET acknowledged = 0 WHERE source_id = ? AND event_id IN (${ph})`)
      .run(row.id, ...req.body.eventIds);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: brocadeApi.errMsg(err) });
  }
});

router.get('/health-scores', [query('type').optional().isString()], validate, (req, res, next) => {
  try {
    const clauses = ['stale = 0'];
    const params = [];
    if (req.query.type) { clauses.push('entity_type = ?'); params.push(String(req.query.type).toUpperCase()); }
    const rows = db.prepare(`SELECT * FROM brocade_health_scores WHERE ${clauses.join(' AND ')} ORDER BY score ASC`).all(...params);
    res.json({
      scores: rows.map((h) => ({
        entityType: h.entity_type, entityName: h.entity_name, entityGuid: h.entity_guid, fabricName: h.fabric_name,
        score: h.score, status: h.status, computationTime: h.computation_time, contributors: parseJson(h.contributors_json, []),
      })),
    });
  } catch (err) { next(err); }
});

router.get('/fcr', (req, res, next) => {
  try {
    const rows = db.prepare('SELECT * FROM brocade_fcr_routes WHERE stale = 0').all();
    res.json({
      routes: rows.map((r) => ({
        backboneFabricId: r.backbone_fabric_id, backboneWwn: r.backbone_wwn, backboneIp: r.backbone_ip,
        edgeFabrics: parseJson(r.edge_fabrics, []),
      })),
    });
  } catch (err) { next(err); }
});

router.get('/issues', (req, res, next) => {
  try {
    res.json({ issues: computeIssues() });
  } catch (err) { next(err); }
});

router.get('/issue-history', [query('limit').optional().isInt({ min: 1, max: 2000 }).toInt()], validate, (req, res, next) => {
  try {
    const limit = req.query.limit || 500;
    const rows = db.prepare(`
      SELECT * FROM brocade_issue_history ORDER BY CASE WHEN resolved_at IS NULL THEN 0 ELSE 1 END, last_seen DESC LIMIT ?
    `).all(limit);
    res.json(rows.map((r) => ({
      id: r.id, source: r.source, type: r.type, target: r.target, severity: r.severity, message: r.message,
      firstSeen: r.first_seen, lastSeen: r.last_seen, resolvedAt: r.resolved_at,
    })));
  } catch (err) { next(err); }
});

router.get('/governance', (req, res, next) => {
  try {
    const firmware = [];
    const fabricNames = db.prepare('SELECT DISTINCT fabric_name FROM brocade_switches WHERE stale = 0 AND fabric_name IS NOT NULL').all().map((r) => r.fabric_name);
    for (const fabricName of fabricNames) {
      const versions = db.prepare('SELECT firmware_version, COUNT(*) n FROM brocade_switches WHERE stale = 0 AND fabric_name = ? GROUP BY firmware_version').all(fabricName);
      firmware.push({ fabricName, versions: versions.map((v) => ({ version: v.firmware_version, count: v.n })), drift: versions.length > 1 });
    }
    const eos = db.prepare('SELECT * FROM brocade_switches WHERE stale = 0 AND eos_status = 1').all();
    const now = Date.now();
    const certs = [];
    for (const sw of db.prepare('SELECT * FROM brocade_switches WHERE stale = 0 AND tls_cert_expiry_ms IS NOT NULL').all()) {
      certs.push({ name: sw.name, type: 'switch', expiresMs: sw.tls_cert_expiry_ms, daysLeft: Math.round((sw.tls_cert_expiry_ms - now) / 86400000) });
    }
    for (const c of db.prepare('SELECT * FROM brocade_chassis WHERE stale = 0 AND tls_cert_expiry_ms IS NOT NULL').all()) {
      certs.push({ name: c.name, type: 'chassis', expiresMs: c.tls_cert_expiry_ms, daysLeft: Math.round((c.tls_cert_expiry_ms - now) / 86400000) });
    }
    const zoneAccess = db.prepare(`SELECT fabric_name, cfg_name, default_zone_access FROM brocade_zone_configs WHERE stale = 0 AND is_effective = 1`).all()
      .map((z) => ({ fabricName: z.fabric_name, cfgName: z.cfg_name, defaultZoneAccess: z.default_zone_access }));
    const mapsCallhome = [];
    for (const sw of db.prepare('SELECT name, raw_json FROM brocade_switches WHERE stale = 0').all()) {
      let raw = null;
      try { raw = JSON.parse(sw.raw_json || '{}'); } catch { raw = {}; }
      const add = raw?.additionalAttributes || null;
      mapsCallhome.push({
        name: sw.name,
        mapsEnabled: add ? !!add.mapsEnabled : null,
        callhomeEnabled: add ? !!add.callhomeEnabled : null,
        snmpRegistered: add ? !!add.snmpRegistered : null,
        syslogRegistered: add ? !!add.syslogRegistered : null,
      });
    }
    const sourceRow = db.prepare('SELECT * FROM brocade_sources ORDER BY id LIMIT 1').get();
    const recentZoneChanges = db.prepare('SELECT * FROM brocade_zone_changes ORDER BY detected_at DESC LIMIT 50').all()
      .map((c) => ({ id: c.id, sourceId: c.source_id, fabricName: c.fabric_name, changeType: c.change_type, detail: c.detail, oldValue: c.old_value, newValue: c.new_value, detectedAt: c.detected_at }));

    res.json({
      firmware,
      eos: eos.map((sw) => ({ id: sw.id, name: sw.name, wwn: sw.wwn, fabricName: sw.fabric_name, eosStatus: sw.eos_status })),
      certs,
      zoneAccess,
      mapsCallhome,
      passwordPolicy: sourceRow ? parseJson(sourceRow.password_policy_json) : null,
      users: sourceRow ? parseJson(sourceRow.users_json, []) : [],
      roles: sourceRow ? parseJson(sourceRow.roles_json, []) : [],
      aors: sourceRow ? parseJson(sourceRow.aors_json, []) : [],
      recentZoneChanges,
    });
  } catch (err) { next(err); }
});

router.get('/trends', [
  query('sourceId').optional().isInt().toInt(),
  query('hours').optional().isInt({ min: 1, max: 4320 }).toInt(),
], validate, (req, res, next) => {
  try {
    const hours = req.query.hours || 168;
    const clauses = [`ts >= datetime('now', ?)`];
    const params = [`-${hours} hours`];
    if (req.query.sourceId) { clauses.push('source_id = ?'); params.push(req.query.sourceId); }
    const rows = db.prepare(`SELECT * FROM brocade_metrics WHERE ${clauses.join(' AND ')} ORDER BY ts ASC`).all(...params);
    res.json({
      metrics: rows.map((m) => ({
        id: m.id, sourceId: m.source_id, fabricsTotal: m.fabrics_total, fabricsHealthy: m.fabrics_healthy,
        switchesTotal: m.switches_total, switchesHealthy: m.switches_healthy, switchesMarginal: m.switches_marginal,
        switchesCritical: m.switches_critical, switchesUnreachable: m.switches_unreachable, portsTotal: m.ports_total,
        portsOnline: m.ports_online, portsOffline: m.ports_offline, portsError: m.ports_error,
        portsOccupied: m.ports_occupied, deviceportsTotal: m.device_ports_total, enclosuresTotal: m.enclosures_total,
        hostsTotal: m.hosts_total, storageTotal: m.storage_total, zonesTotal: m.zones_total,
        aliasesTotal: m.aliases_total, avgFabricHealth: m.avg_fabric_health, minFabricHealth: m.min_fabric_health,
        eventsCritical24h: m.events_critical_24h, eventsWarning24h: m.events_warning_24h, ts: m.ts,
      })),
    });
  } catch (err) { next(err); }
});

router.get('/config', (req, res, next) => {
  try {
    res.json({
      healthWarnScore: healthWarnScore(),
      healthCritScore: healthCritScore(),
      certWarnDays: certWarnDays(),
      eventStormCount: eventStormCount(),
      eventRetentionDays: eventRetentionDays(),
      portStatsRetentionDays: portStatsRetentionDays(),
    });
  } catch (err) { next(err); }
});

router.put('/config', [
  body('healthWarnScore').optional().isInt({ min: 1, max: 100 }).toInt(),
  body('healthCritScore').optional().isInt({ min: 1, max: 100 }).toInt(),
  body('certWarnDays').optional().isInt({ min: 1, max: 365 }).toInt(),
  body('eventStormCount').optional().isInt({ min: 1, max: 1000 }).toInt(),
  body('eventRetentionDays').optional().isInt({ min: 1, max: 365 }).toInt(),
  body('portStatsRetentionDays').optional().isInt({ min: 1, max: 90 }).toInt(),
], validate, (req, res, next) => {
  try {
    const { setSetting } = require('../services/settings');
    const map = {
      healthWarnScore: 'brocade_health_warn_score',
      healthCritScore: 'brocade_health_crit_score',
      certWarnDays: 'brocade_cert_warn_days',
      eventStormCount: 'brocade_event_storm_count',
      eventRetentionDays: 'brocade_event_retention_days',
      portStatsRetentionDays: 'brocade_port_stats_retention_days',
    };
    for (const [k, settingKey] of Object.entries(map)) {
      if (req.body[k] !== undefined) setSetting(settingKey, String(req.body[k]));
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
