// BlueCat routes. Mounted by the plugin dispatcher at /api/bluecat — paths
// are relative. Registration CRUD stores credentials AES-encrypted
// (keep-if-blank on PUT); data endpoints serve the polled bluecat_* tables
// plus computed issues. Model: routes/unifi.js.
const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const db = require('../db/database');
const { encrypt } = require('../services/encryption');
const bluecatApi = require('../services/bluecatApi');
const { bluecatPollerHandle } = require('../services/bluecatPoller');
const { lowFreeWarn, lowFreePct, computeIssues } = require('../services/bluecatIssues');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid parameters', details: errors.array() });
  next();
};

// ── Public shapes (never leak encrypted_credentials/password) ──────────────

const publicSource = (row) => ({
  id: row.id,
  name: row.name,
  host: row.host,
  port: row.port,
  sslVerify: !!row.ssl_verify,
  pollingIntervalMinutes: row.polling_interval_minutes,
  enumerateIntervalMinutes: row.enumerate_interval_minutes,
  bamVersion: row.bam_version,
  lastPollStatus: row.last_poll_status,
  lastPollError: row.last_poll_error,
  lastPollAt: row.last_poll_at,
  lastEnumerateAt: row.last_enumerate_at,
  lastEnumerateError: row.last_enumerate_error,
  createdAt: row.created_at,
});

function currentUsername(req) {
  return req.auth?.user?.username || req.user?.username || 'unknown';
}

// ── Source registration CRUD ────────────────────────────────────────────────

router.get('/sources', (req, res, next) => {
  try {
    res.json(db.prepare('SELECT * FROM bluecat_sources ORDER BY name').all().map(publicSource));
  } catch (err) { next(err); }
});

router.post('/sources', [
  body('name').isString().trim().notEmpty().isLength({ max: 120 }),
  body('host').isString().trim().notEmpty().isLength({ max: 253 }),
  body('port').optional().isInt({ min: 1, max: 65535 }).toInt(),
  body('username').isString().trim().notEmpty().isLength({ max: 255 }),
  body('password').isString().notEmpty().isLength({ max: 512 }),
  body('sslVerify').optional().isBoolean(),
  body('pollingIntervalMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
  body('enumerateIntervalMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
], validate, (req, res, next) => {
  try {
    const { name, host, port, username, password, sslVerify, pollingIntervalMinutes, enumerateIntervalMinutes } = req.body;
    const dup = db.prepare('SELECT id FROM bluecat_sources WHERE name = ? OR host = ?').get(name.trim(), host.trim());
    if (dup) return res.status(409).json({ error: 'A BlueCat source with that name or host is already registered.' });
    const info = db.prepare(`
      INSERT INTO bluecat_sources (name, host, port, encrypted_credentials, ssl_verify, polling_interval_minutes, enumerate_interval_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(name.trim(), host.trim(), port || 443, encrypt(JSON.stringify({ username, password })),
      sslVerify ? 1 : 0, pollingIntervalMinutes || 30, enumerateIntervalMinutes || 60);
    const row = db.prepare('SELECT * FROM bluecat_sources WHERE id = ?').get(info.lastInsertRowid);
    bluecatPollerHandle.schedule(row);
    bluecatPollerHandle.trigger(row).catch(() => {});
    res.status(201).json(publicSource(row));
  } catch (err) { next(err); }
});

router.put('/sources/:id', [
  param('id').isInt().toInt(),
  body('name').optional().isString().trim().notEmpty().isLength({ max: 120 }),
  body('host').optional().isString().trim().notEmpty().isLength({ max: 253 }),
  body('port').optional().isInt({ min: 1, max: 65535 }).toInt(),
  body('username').optional().isString().trim().notEmpty().isLength({ max: 255 }),
  body('password').optional({ checkFalsy: true }).isString().isLength({ max: 512 }),
  body('sslVerify').optional().isBoolean(),
  body('pollingIntervalMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
  body('enumerateIntervalMinutes').optional().isInt({ min: 5, max: 1440 }).toInt(),
], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM bluecat_sources WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'BlueCat source not found.' });
    const b = req.body;
    let encryptedCredentials = row.encrypted_credentials;
    if (b.password) {
      let existingUsername = b.username;
      if (!existingUsername) {
        try { existingUsername = JSON.parse(require('../services/encryption').decrypt(row.encrypted_credentials)).username; } catch { existingUsername = null; }
      }
      encryptedCredentials = encrypt(JSON.stringify({ username: existingUsername, password: b.password }));
    } else if (b.username) {
      let existingPassword = null;
      try { existingPassword = JSON.parse(require('../services/encryption').decrypt(row.encrypted_credentials)).password; } catch { existingPassword = null; }
      if (existingPassword) encryptedCredentials = encrypt(JSON.stringify({ username: b.username, password: existingPassword }));
    }
    db.prepare(`
      UPDATE bluecat_sources SET
        name = ?, host = ?, port = ?, encrypted_credentials = ?, ssl_verify = ?,
        polling_interval_minutes = ?, enumerate_interval_minutes = ?
      WHERE id = ?
    `).run(
      b.name?.trim() || row.name, b.host?.trim() || row.host, b.port || row.port,
      encryptedCredentials,
      b.sslVerify !== undefined ? (b.sslVerify ? 1 : 0) : row.ssl_verify,
      b.pollingIntervalMinutes || row.polling_interval_minutes,
      b.enumerateIntervalMinutes || row.enumerate_interval_minutes,
      row.id
    );
    const updated = db.prepare('SELECT * FROM bluecat_sources WHERE id = ?').get(row.id);
    bluecatPollerHandle.schedule(updated);
    res.json(publicSource(updated));
  } catch (err) { next(err); }
});

router.delete('/sources/:id', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM bluecat_sources WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'BlueCat source not found.' });
    bluecatPollerHandle.cancel(row.id);
    db.prepare('DELETE FROM bluecat_sources WHERE id = ?').run(row.id);
    res.status(204).end();
  } catch (err) { next(err); }
});

// Literal /sources/test must be registered before the /sources/:id/test
// param sibling.
router.post('/sources/test', [
  body('id').optional().isInt().toInt(),
  body('host').optional().isString().trim().notEmpty(),
  body('username').optional().isString(),
  body('password').optional().isString(),
  body('port').optional().isInt({ min: 1, max: 65535 }).toInt(),
  body('sslVerify').optional().isBoolean(),
], validate, async (req, res) => {
  const { id, host, username, password, port, sslVerify } = req.body;
  let candidate;
  if (id) {
    const row = db.prepare('SELECT * FROM bluecat_sources WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'BlueCat source not found.' });
    candidate = { ...row, ...(username ? { username } : {}), ...(password ? { password } : {}) };
  } else {
    if (!host || !username || !password) {
      return res.status(400).json({ error: 'Invalid parameters', details: [{ msg: 'host, username, and password required' }] });
    }
    candidate = { host: host.trim(), username, password, port: port || 443, ssl_verify: sslVerify ? 1 : 0 };
  }
  const result = await bluecatApi.testConnection(candidate);
  res.status(result.ok ? 200 : 502).json(result);
});

// POST /sources/:id/test — body may carry full creds even when :id does not
// exist yet (the UI posts /sources/0/test for a new registration form).
router.post('/sources/:id/test', [
  param('id').isInt().toInt(),
  body('username').optional().isString(),
  body('password').optional().isString(),
  body('host').optional().isString().trim(),
  body('port').optional().isInt({ min: 1, max: 65535 }).toInt(),
  body('sslVerify').optional().isBoolean(),
], validate, async (req, res) => {
  const { username, password, host, port, sslVerify } = req.body;
  const row = db.prepare('SELECT * FROM bluecat_sources WHERE id = ?').get(req.params.id);
  let candidate;
  if (username && password) {
    candidate = {
      id: row ? row.id : req.params.id,
      host: host?.trim() || row?.host,
      username, password,
      port: port || row?.port || 443,
      ssl_verify: sslVerify !== undefined ? (sslVerify ? 1 : 0) : (row ? row.ssl_verify : 0),
    };
    if (!candidate.host) return res.status(400).json({ error: 'Invalid parameters', details: [{ msg: 'host required' }] });
  } else {
    if (!row) return res.status(404).json({ error: 'BlueCat source not found.' });
    candidate = row;
  }
  const result = await bluecatApi.testConnection(candidate);
  res.status(result.ok ? 200 : 502).json(result);
});

router.post('/sources/:id/poll', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM bluecat_sources WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'BlueCat source not found.' });
    bluecatPollerHandle.trigger(row).catch(() => {});
    res.status(202).json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/sources/:id/enumerate', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM bluecat_sources WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'BlueCat source not found.' });
    bluecatPollerHandle.triggerEnumerate(row).catch(() => {});
    res.status(202).json({ ok: true });
  } catch (err) { next(err); }
});

// Probe fetches run the same fetchers the poller uses, live against the
// source, reporting raw shapes — the mandatory live-debug loop (contract
// section 2).
router.get('/sources/:id/probe', [param('id').isInt().toInt()], validate, async (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM bluecat_sources WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'BlueCat source not found.' });

    const sections = {};
    const run = async (name, fn) => {
      try {
        const data = await fn();
        sections[name] = { ok: true, status: 200, sample: data, error: null };
      } catch (err) {
        sections[name] = { ok: false, status: err.response?.status || null, sample: null, error: bluecatApi.errMsg(err) };
      }
    };
    const filterProbe = (path) => run(`filterField:${path}`, async () => {
      try {
        await bluecatApi.apiGet(row, path, { params: { filter: 'zzz:eq(1)' } });
        return null;
      } catch (err) {
        return { status: err.response?.status || null, message: bluecatApi.errMsg(err) };
      }
    });

    await run('settingsVersion', () => bluecatApi.fetchVersion(row));
    let configurations = [];
    await run('configurations', async () => { configurations = await bluecatApi.fetchConfigurations(row); return configurations; });
    const configId = configurations[0]?.id;

    let views = [];
    if (configId != null) await run('view', async () => { views = await bluecatApi.fetchViews(row, configId); return views[0] || null; });

    let zones = [];
    await run('zone', async () => { zones = await bluecatApi.fetchZones(row); return zones[0] || null; });

    await run('resourceRecordsPage', () => bluecatApi.apiGet(row, '/resourceRecords', { params: { limit: 3 } }));
    await run('resourceRecordsFilterTest', () => bluecatApi.apiGet(row, '/resourceRecords', { params: { filter: "absoluteName:contains('a')", limit: 3 } }));

    let blocks = [];
    await run('block', async () => { blocks = await bluecatApi.fetchBlocks(row); return blocks[0] || null; });

    let networks = [];
    await run('network', async () => { networks = await bluecatApi.fetchNetworks(row); return networks[0] || null; });

    const smallestIpv4 = networks.filter((n) => n.ipVersion === 4).sort((a, b) => (b.prefix || 0) - (a.prefix || 0))[0];
    if (smallestIpv4) {
      await run('networkRanges', () => bluecatApi.fetchRanges(row, smallestIpv4.id));
      await run('networkAddressesSample', () => bluecatApi.apiGet(row, `/networks/${smallestIpv4.id}/addresses`, { params: { limit: 50 } }));
    }
    const largestIpv4 = networks.filter((n) => n.ipVersion === 4).sort((a, b) => (a.prefix || 0) - (b.prefix || 0))[0];
    if (largestIpv4) {
      await run('networkAddressStatesDistinct', async () => {
        const d = await bluecatApi.apiGet(row, `/networks/${largestIpv4.id}/addresses`, { params: { limit: 1000 } });
        const states = new Set((d?.data || []).map((a) => a.state).filter(Boolean));
        return [...states];
      });
    }

    if (configId != null) {
      await run('deviceWithAddresses', async () => {
        const rows = await bluecatApi.fetchDevices(row, configId);
        return rows[0] || null;
      });
    }

    let servers = [];
    await run('serverWithInterfaces', async () => { servers = await bluecatApi.fetchServers(row); return servers[0] || null; });
    if (servers[0]) {
      await run('serverDeployment', () => bluecatApi.fetchLatestDeployment(row, servers[0].id));
    }
    await run('deploymentRoles', async () => (await bluecatApi.fetchDeploymentRoles(row)).slice(0, 3));

    await Promise.all(['zones', 'resourceRecords', 'networks', 'addresses', 'ranges', 'devices', 'servers'].map((p) => filterProbe(`/${p}`)));

    res.json({ sections });
  } catch (err) { next(err); }
});

// ── Data endpoints ───────────────────────────────────────────────────────────

router.get('/overview', (req, res, next) => {
  try {
    const sources = db.prepare('SELECT * FROM bluecat_sources ORDER BY name').all();
    const counts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM bluecat_views) views,
        (SELECT COUNT(*) FROM bluecat_zones) zones,
        (SELECT COUNT(*) FROM bluecat_records) records,
        (SELECT COUNT(*) FROM bluecat_networks) networks,
        (SELECT COUNT(*) FROM bluecat_devices) devices,
        (SELECT COUNT(*) FROM bluecat_servers) servers,
        (SELECT COUNT(*) FROM bluecat_servers WHERE connected = 0) serversDown,
        (SELECT COUNT(*) FROM bluecat_sources WHERE last_poll_status = 'error') sourcesUnreachable
    `).get();
    const warn = lowFreeWarn();
    const networksLowSpace = db.prepare(`
      SELECT COUNT(*) n FROM bluecat_networks nw
      LEFT JOIN bluecat_network_overrides o ON o.source_id = nw.source_id AND o.network_id = nw.network_id
      WHERE nw.ip_version = 4 AND nw.free_static IS NOT NULL AND nw.free_static < ? AND COALESCE(o.exclude_low_space, 0) = 0
    `).get(warn).n;
    const rangesLowSpace = db.prepare('SELECT COUNT(*) n FROM bluecat_ranges WHERE free_dhcp IS NOT NULL AND free_dhcp < ?').get(warn).n;

    const issues = computeIssues();
    const issueCounts = { critical: 0, warning: 0, info: 0 };
    for (const i of issues) issueCounts[i.severity] = (issueCounts[i.severity] || 0) + 1;

    const lowSpace = db.prepare(`
      SELECT nw.id, nw.source_id, src.name AS source_name, nw.range, nw.name, nw.free_static, nw.capacity, nw.free_pct
      FROM bluecat_networks nw
      JOIN bluecat_sources src ON src.id = nw.source_id
      LEFT JOIN bluecat_network_overrides o ON o.source_id = nw.source_id AND o.network_id = nw.network_id
      WHERE nw.ip_version = 4 AND nw.counts_source IS NOT NULL AND nw.free_static IS NOT NULL
        AND COALESCE(o.exclude_low_space, 0) = 0
      ORDER BY nw.free_static ASC LIMIT 10
    `).all().map((r) => ({ id: r.id, sourceName: r.source_name, range: r.range, name: r.name, freeStatic: r.free_static, capacity: r.capacity, freePct: r.free_pct }));

    const trends = db.prepare('SELECT * FROM bluecat_metrics_history ORDER BY captured_at DESC LIMIT 24').all()
      .reverse().map((r) => ({
        id: r.id, sourceId: r.source_id, capturedAt: r.captured_at, views: r.views, zones: r.zones, records: r.records,
        networks: r.networks, networksLowSpace: r.networks_low_space, rangesLowSpace: r.ranges_low_space,
        devices: r.devices, servers: r.servers, serversDown: r.servers_down,
      }));

    res.json({
      sources: sources.map(publicSource),
      counts: {
        views: counts.views || 0, zones: counts.zones || 0, records: counts.records || 0, networks: counts.networks || 0,
        networksLowSpace, rangesLowSpace, devices: counts.devices || 0, servers: counts.servers || 0,
        serversDown: counts.serversDown || 0, sourcesUnreachable: counts.sourcesUnreachable || 0,
      },
      issues: issueCounts,
      lowSpace,
      trends,
      features: {},
    });
  } catch (err) { next(err); }
});

router.get('/views', (req, res, next) => {
  try {
    res.json(db.prepare(`
      SELECT v.*, s.name AS source_name FROM bluecat_views v JOIN bluecat_sources s ON s.id = v.source_id
      ORDER BY s.name, v.name
    `).all().map((v) => ({
      id: v.id, sourceId: v.source_id, sourceName: v.source_name, viewId: v.view_id,
      configurationName: v.configuration_name, name: v.name, zoneCount: v.zone_count, recordCount: v.record_count,
    })));
  } catch (err) { next(err); }
});

router.get('/zones', [
  query('viewId').optional().isInt().toInt(),
  query('q').optional().isString().isLength({ max: 200 }),
], validate, (req, res, next) => {
  try {
    const clauses = [];
    const params = [];
    if (req.query.viewId != null) { clauses.push('z.view_id = ?'); params.push(req.query.viewId); }
    if (req.query.q) { clauses.push("(z.name LIKE ? ESCAPE '\\' OR z.absolute_name LIKE ? ESCAPE '\\')"); const like = `%${req.query.q.replace(/[%_]/g, '\\$&')}%`; params.push(like, like); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT z.*, s.name AS source_name, v.name AS view_name FROM bluecat_zones z
      JOIN bluecat_sources s ON s.id = z.source_id
      LEFT JOIN bluecat_views v ON v.source_id = z.source_id AND v.view_id = z.view_id
      ${where} ORDER BY s.name, z.absolute_name
    `).all(...params);
    res.json(rows.map((z) => ({
      id: z.id, sourceId: z.source_id, sourceName: z.source_name, zoneId: z.zone_id, viewId: z.view_id,
      viewName: z.view_name, parentZoneId: z.parent_zone_id, name: z.name, absoluteName: z.absolute_name,
      zoneType: z.zone_type, deploymentEnabled: !!z.deployment_enabled, dynamicUpdateEnabled: !!z.dynamic_update_enabled,
      signed: !!z.signed, recordCount: z.record_count,
    })));
  } catch (err) { next(err); }
});

router.get('/records', [
  query('q').optional().isString().isLength({ max: 200 }),
  query('rrType').optional().isString().isLength({ max: 30 }),
  query('viewId').optional().isInt().toInt(),
  query('zoneId').optional().isInt().toInt(),
  query('limit').optional().isInt({ min: 1, max: 1000 }).toInt(),
], validate, (req, res, next) => {
  try {
    const limit = Math.min(req.query.limit || 200, 1000);
    const clauses = [];
    const params = [];
    if (req.query.rrType) { clauses.push('r.rr_type = ?'); params.push(req.query.rrType); }
    if (req.query.viewId != null) { clauses.push('r.view_id = ?'); params.push(req.query.viewId); }
    if (req.query.zoneId != null) { clauses.push('r.zone_id = ?'); params.push(req.query.zoneId); }
    if (req.query.q) {
      const raw = req.query.q;
      const like = `%${raw.replace(/[%_]/g, '\\$&')}%`;
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) {
        clauses.push("(r.name LIKE ? ESCAPE '\\' OR r.absolute_name LIKE ? ESCAPE '\\' OR r.rdata LIKE ? ESCAPE '\\' OR r.rdata = ? OR r.addresses_json LIKE ?)");
        params.push(like, like, like, raw, `%"${raw}"%`);
      } else {
        clauses.push("(r.name LIKE ? ESCAPE '\\' OR r.absolute_name LIKE ? ESCAPE '\\' OR r.rdata LIKE ? ESCAPE '\\')");
        params.push(like, like, like);
      }
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) n FROM bluecat_records r ${where}`).get(...params).n;
    const rows = db.prepare(`
      SELECT r.*, s.name AS source_name, z.name AS zone_name, v.name AS view_name
      FROM bluecat_records r
      JOIN bluecat_sources s ON s.id = r.source_id
      LEFT JOIN bluecat_zones z ON z.source_id = r.source_id AND z.zone_id = r.zone_id
      LEFT JOIN bluecat_views v ON v.source_id = r.source_id AND v.view_id = r.view_id
      ${where} ORDER BY r.absolute_name LIMIT ?
    `).all(...params, limit);
    res.json({
      records: rows.map((r) => ({
        id: r.id, sourceId: r.source_id, sourceName: r.source_name, recordId: r.record_id, zoneId: r.zone_id,
        zoneName: r.zone_name, viewId: r.view_id, viewName: r.view_name, name: r.name, absoluteName: r.absolute_name,
        recordType: r.record_type, rrType: r.rr_type, rdata: r.rdata, ttl: r.ttl,
        addresses: r.addresses_json ? JSON.parse(r.addresses_json) : [], comment: r.comment,
      })),
      total,
      limited: rows.length >= limit,
    });
  } catch (err) { next(err); }
});

router.get('/records/lookup', [
  query('q').isString().trim().notEmpty().isLength({ max: 200 }),
  query('sourceId').optional().isInt().toInt(),
], validate, async (req, res, next) => {
  try {
    let row = null;
    if (req.query.sourceId) row = db.prepare('SELECT * FROM bluecat_sources WHERE id = ?').get(req.query.sourceId);
    else row = db.prepare('SELECT * FROM bluecat_sources ORDER BY id LIMIT 1').get();
    if (!row) return res.json({ ok: false, method: null, results: [], error: 'no BlueCat source registered' });
    const result = await bluecatApi.searchRecords(row, req.query.q);
    const trimmed = (result.results || []).map((r) => ({
      id: r.id, type: r.type, name: r.name, absoluteName: r.absoluteName, rdata: r.rdata, recordType: r.recordType,
    }));
    res.json({ ok: result.ok, method: result.method || null, results: trimmed, error: result.error || null });
  } catch (err) { next(err); }
});

router.get('/blocks', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT b.*, s.name AS source_name,
        (SELECT COUNT(*) FROM bluecat_networks n WHERE n.source_id = b.source_id AND n.block_id = b.block_id) network_count
      FROM bluecat_blocks b JOIN bluecat_sources s ON s.id = b.source_id ORDER BY s.name, b.range
    `).all();
    const warn = lowFreeWarn();
    // Roll network counts up the block tree so a parent block shows the total
    // beneath it, matching what /networks?blockId= lists for that block.
    const lowByBlock = new Map();
    for (const r of db.prepare(`
      SELECT source_id, block_id, COUNT(*) n FROM bluecat_networks
      WHERE free_static IS NOT NULL AND free_static < ? GROUP BY source_id, block_id
    `).all(warn)) lowByBlock.set(`${r.source_id}:${r.block_id}`, r.n);
    const children = new Map();
    for (const b of rows) {
      const key = `${b.source_id}:${b.parent_block_id}`;
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(b);
    }
    const totals = new Map();
    const rollup = (b) => {
      const key = `${b.source_id}:${b.block_id}`;
      if (totals.has(key)) return totals.get(key);
      let networks = b.network_count || 0;
      let low = lowByBlock.get(key) || 0;
      for (const c of children.get(key) || []) {
        const t = rollup(c);
        networks += t.networks;
        low += t.low;
      }
      const t = { networks, low };
      totals.set(key, t);
      return t;
    };
    res.json(rows.map((b) => {
      const t = rollup(b);
      return {
        id: b.id, sourceId: b.source_id, sourceName: b.source_name, blockId: b.block_id, parentBlockId: b.parent_block_id,
        configurationId: b.configuration_id, name: b.name, range: b.range, prefix: b.prefix, ipVersion: b.ip_version,
        locationName: b.location_name, networkCount: t.networks, directNetworkCount: b.network_count, lowSpaceCount: t.low,
      };
    }));
  } catch (err) { next(err); }
});

router.get('/networks', [
  query('blockId').optional().isInt().toInt(),
  query('sourceId').optional().isInt().toInt(),
  query('q').optional().isString().isLength({ max: 200 }),
  query('lowSpace').optional().isIn(['0', '1']),
  query('ipVersion').optional().isInt({ min: 4, max: 6 }).toInt(),
], validate, (req, res, next) => {
  try {
    const clauses = [];
    const params = [];
    // A block selected in the tree must list the networks of every block
    // beneath it, not only its direct children (networks usually live two or
    // three block levels down from the top).
    let cte = '';
    if (req.query.blockId != null) {
      cte = `WITH RECURSIVE sub(block_id) AS (
        SELECT ? UNION ALL
        SELECT b.block_id FROM bluecat_blocks b JOIN sub ON b.parent_block_id = sub.block_id
      ) `;
      params.push(req.query.blockId);
      clauses.push('nw.block_id IN (SELECT block_id FROM sub)');
    }
    if (req.query.sourceId != null) { clauses.push('nw.source_id = ?'); params.push(req.query.sourceId); }
    if (req.query.ipVersion != null) { clauses.push('nw.ip_version = ?'); params.push(req.query.ipVersion); }
    if (req.query.q) { clauses.push("(nw.range LIKE ? ESCAPE '\\' OR nw.name LIKE ? ESCAPE '\\')"); const like = `%${req.query.q.replace(/[%_]/g, '\\$&')}%`; params.push(like, like); }
    const warn = lowFreeWarn();
    if (req.query.lowSpace === '1') {
      clauses.push(`(
        (nw.free_static IS NOT NULL AND nw.free_static < ?)
        OR EXISTS (SELECT 1 FROM bluecat_ranges rg WHERE rg.source_id = nw.source_id AND rg.network_id = nw.network_id AND rg.free_dhcp IS NOT NULL AND rg.free_dhcp < ?)
      ) AND COALESCE(o.exclude_low_space, 0) = 0`);
      params.push(warn, warn);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`
      ${cte}SELECT nw.*, s.name AS source_name,
        (SELECT COUNT(*) FROM bluecat_ranges rg WHERE rg.source_id = nw.source_id AND rg.network_id = nw.network_id) range_count,
        o.gateway AS o_gateway, o.exclude_low_space AS o_exclude, o.note AS o_note, o.updated_by AS o_updated_by, o.updated_at AS o_updated_at
      FROM bluecat_networks nw
      JOIN bluecat_sources s ON s.id = nw.source_id
      LEFT JOIN bluecat_network_overrides o ON o.source_id = nw.source_id AND o.network_id = nw.network_id
      ${where} ORDER BY nw.range
    `).all(...params);
    res.json(rows.map((n) => ({
      id: n.id, sourceId: n.source_id, sourceName: n.source_name, networkId: n.network_id, blockId: n.block_id,
      configurationId: n.configuration_id, name: n.name, range: n.range, prefix: n.prefix, ipVersion: n.ip_version,
      capacity: n.capacity, gateway: n.gateway, gatewaySource: n.gateway_source, locationName: n.location_name,
      usedStatic: n.used_static, dhcpPool: n.dhcp_pool, dhcpUsed: n.dhcp_used, freeStatic: n.free_static, freePct: n.free_pct,
      countsSource: n.counts_source, enumeratedAt: n.enumerated_at, rangeCount: n.range_count,
      excludeLowSpace: !!n.o_exclude,
      override: n.o_gateway != null || n.o_exclude != null || n.o_note != null
        ? { gateway: n.o_gateway, excludeLowSpace: !!n.o_exclude, note: n.o_note, updatedBy: n.o_updated_by, updatedAt: n.o_updated_at }
        : null,
      lowWaterMark: n.low_water_mark, highWaterMark: n.high_water_mark,
    })));
  } catch (err) { next(err); }
});

router.get('/networks/:id', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const n = db.prepare(`
      SELECT nw.*, s.name AS source_name,
        o.gateway AS o_gateway, o.exclude_low_space AS o_exclude, o.note AS o_note, o.updated_by AS o_updated_by, o.updated_at AS o_updated_at
      FROM bluecat_networks nw
      JOIN bluecat_sources s ON s.id = nw.source_id
      LEFT JOIN bluecat_network_overrides o ON o.source_id = nw.source_id AND o.network_id = nw.network_id
      WHERE nw.id = ?
    `).get(req.params.id);
    if (!n) return res.status(404).json({ error: 'Network not found.' });
    const ranges = db.prepare('SELECT * FROM bluecat_ranges WHERE source_id = ? AND network_id = ? ORDER BY start_ip').all(n.source_id, n.network_id);
    const addresses = db.prepare(`
      SELECT * FROM bluecat_addresses WHERE source_id = ? AND network_id = ?
      ORDER BY (
        CAST(substr(address, 1, instr(address, '.') - 1) AS INTEGER) * 16777216
      ) LIMIT 2000
    `).all(n.source_id, n.network_id);
    const records = db.prepare(`
      SELECT DISTINCT r.* FROM bluecat_records r
      WHERE r.source_id = ? AND (
        r.rdata IN (SELECT address FROM bluecat_addresses WHERE source_id = ? AND network_id = ?)
        OR r.addresses_json LIKE '%"' || (SELECT address FROM bluecat_addresses WHERE source_id = ? AND network_id = ? LIMIT 1) || '"%'
      )
      LIMIT 200
    `).all(n.source_id, n.source_id, n.network_id, n.source_id, n.network_id);
    res.json({
      network: {
        id: n.id, sourceId: n.source_id, sourceName: n.source_name, networkId: n.network_id, blockId: n.block_id,
        configurationId: n.configuration_id, name: n.name, range: n.range, prefix: n.prefix, ipVersion: n.ip_version,
        capacity: n.capacity, gateway: n.gateway, gatewaySource: n.gateway_source, locationName: n.location_name,
        usedStatic: n.used_static, dhcpPool: n.dhcp_pool, dhcpUsed: n.dhcp_used, freeStatic: n.free_static, freePct: n.free_pct,
        countsSource: n.counts_source, enumeratedAt: n.enumerated_at,
        excludeLowSpace: !!n.o_exclude,
        override: n.o_gateway != null || n.o_exclude != null || n.o_note != null
          ? { gateway: n.o_gateway, excludeLowSpace: !!n.o_exclude, note: n.o_note, updatedBy: n.o_updated_by, updatedAt: n.o_updated_at }
          : null,
        lowWaterMark: n.low_water_mark, highWaterMark: n.high_water_mark,
      },
      ranges: ranges.map((r) => ({ id: r.id, rangeId: r.range_id, name: r.name, startIp: r.start_ip, endIp: r.end_ip, size: r.size, dhcpUsed: r.dhcp_used, freeDhcp: r.free_dhcp })),
      addresses: addresses.map((a) => ({ id: a.id, addressId: a.address_id, address: a.address, state: a.state, name: a.name, mac: a.mac, inRangeId: a.in_range_id, deviceId: a.device_id })),
      records: records.map((r) => ({ id: r.id, recordId: r.record_id, name: r.name, absoluteName: r.absolute_name, rrType: r.rr_type, rdata: r.rdata, ttl: r.ttl })),
    });
  } catch (err) { next(err); }
});

function ipInNetwork(ip, range) {
  if (!ip || !range) return false;
  const m = String(range).match(/^([\d.]+)\/(\d{1,2})$/);
  if (!m) return true; // non-CIDR range (v6 or unparsed) — do not block
  const toInt = (s) => {
    const parts = s.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    return parts.reduce((n, p) => n * 256 + p, 0) >>> 0;
  };
  const base = toInt(m[1]);
  const ipInt = toInt(ip);
  if (base == null || ipInt == null) return false;
  const prefix = Number(m[2]);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (base & mask) === (ipInt & mask);
}

router.put('/networks/:id/override', [
  param('id').isInt().toInt(),
  body('gateway').optional({ nullable: true }).isString(),
  body('excludeLowSpace').optional().isBoolean(),
  body('note').optional({ nullable: true }).isString().isLength({ max: 500 }),
], validate, (req, res, next) => {
  try {
    const n = db.prepare('SELECT * FROM bluecat_networks WHERE id = ?').get(req.params.id);
    if (!n) return res.status(404).json({ error: 'Network not found.' });
    const { gateway, excludeLowSpace, note } = req.body;
    if (gateway && !ipInNetwork(gateway, n.range)) {
      return res.status(400).json({ error: 'Gateway is not inside the network range.' });
    }
    db.prepare(`
      INSERT INTO bluecat_network_overrides (source_id, network_id, gateway, exclude_low_space, note, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(source_id, network_id) DO UPDATE SET
        gateway = excluded.gateway, exclude_low_space = excluded.exclude_low_space, note = excluded.note,
        updated_by = excluded.updated_by, updated_at = datetime('now')
    `).run(n.source_id, n.network_id, gateway || null, excludeLowSpace ? 1 : 0, note || null, currentUsername(req));

    const newGateway = gateway || n.gateway_bam || n.gateway;
    const newSource = gateway ? 'override' : (n.gateway_source === 'override' ? 'bam' : n.gateway_source);
    db.prepare('UPDATE bluecat_networks SET gateway = ?, gateway_source = ? WHERE id = ?').run(gateway || n.gateway, gateway ? 'override' : n.gateway_source, n.id);

    res.json(networkPublic(db.prepare('SELECT * FROM bluecat_networks WHERE id = ?').get(n.id)));
  } catch (err) { next(err); }
});

router.delete('/networks/:id/override', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const n = db.prepare('SELECT * FROM bluecat_networks WHERE id = ?').get(req.params.id);
    if (!n) return res.status(404).json({ error: 'Network not found.' });
    db.prepare('DELETE FROM bluecat_network_overrides WHERE source_id = ? AND network_id = ?').run(n.source_id, n.network_id);

    const addrRow = db.prepare(`SELECT address FROM bluecat_addresses WHERE source_id = ? AND network_id = ? AND state = 'GATEWAY' LIMIT 1`).get(n.source_id, n.network_id);
    let gateway = null;
    let gatewaySource = null;
    if (addrRow) { gateway = addrRow.address; gatewaySource = 'address'; }
    db.prepare('UPDATE bluecat_networks SET gateway = ?, gateway_source = ? WHERE id = ?').run(gateway, gatewaySource, n.id);

    res.json(networkPublic(db.prepare('SELECT * FROM bluecat_networks WHERE id = ?').get(n.id)));
  } catch (err) { next(err); }
});

function networkPublic(n) {
  const o = db.prepare('SELECT * FROM bluecat_network_overrides WHERE source_id = ? AND network_id = ?').get(n.source_id, n.network_id);
  const source = db.prepare('SELECT name FROM bluecat_sources WHERE id = ?').get(n.source_id);
  return {
    id: n.id, sourceId: n.source_id, sourceName: source?.name, networkId: n.network_id, blockId: n.block_id,
    configurationId: n.configuration_id, name: n.name, range: n.range, prefix: n.prefix, ipVersion: n.ip_version,
    capacity: n.capacity, gateway: n.gateway, gatewaySource: n.gateway_source, locationName: n.location_name,
    usedStatic: n.used_static, dhcpPool: n.dhcp_pool, dhcpUsed: n.dhcp_used, freeStatic: n.free_static, freePct: n.free_pct,
    countsSource: n.counts_source, enumeratedAt: n.enumerated_at,
    excludeLowSpace: !!(o && o.exclude_low_space),
    override: o ? { gateway: o.gateway, excludeLowSpace: !!o.exclude_low_space, note: o.note, updatedBy: o.updated_by, updatedAt: o.updated_at } : null,
    lowWaterMark: n.low_water_mark, highWaterMark: n.high_water_mark,
  };
}

router.get('/ranges', [query('lowSpace').optional().isIn(['0', '1'])], validate, (req, res, next) => {
  try {
    const warn = lowFreeWarn();
    const where = req.query.lowSpace === '1' ? 'WHERE rg.free_dhcp IS NOT NULL AND rg.free_dhcp < ?' : '';
    const params = req.query.lowSpace === '1' ? [warn] : [];
    const rows = db.prepare(`
      SELECT rg.*, s.name AS source_name, nw.range AS network_range, nw.name AS network_name
      FROM bluecat_ranges rg
      JOIN bluecat_sources s ON s.id = rg.source_id
      LEFT JOIN bluecat_networks nw ON nw.source_id = rg.source_id AND nw.network_id = rg.network_id
      ${where} ORDER BY s.name, nw.range
    `).all(...params);
    res.json(rows.map((r) => ({
      id: r.id, sourceId: r.source_id, sourceName: r.source_name, rangeId: r.range_id, networkId: r.network_id,
      networkRange: r.network_range, networkName: r.network_name, name: r.name, startIp: r.start_ip, endIp: r.end_ip,
      size: r.size, dhcpUsed: r.dhcp_used, freeDhcp: r.free_dhcp,
    })));
  } catch (err) { next(err); }
});

router.get('/addresses', [
  query('q').optional().isString().isLength({ max: 200 }),
  query('limit').optional().isInt({ min: 1, max: 1000 }).toInt(),
], validate, (req, res, next) => {
  try {
    const limit = req.query.limit || 200;
    const clauses = [];
    const params = [];
    if (req.query.q) {
      clauses.push("(a.address LIKE ? ESCAPE '\\' OR a.name LIKE ? ESCAPE '\\')");
      const like = `${req.query.q.replace(/[%_]/g, '\\$&')}%`;
      const nameLike = `%${req.query.q.replace(/[%_]/g, '\\$&')}%`;
      params.push(like, nameLike);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT a.*, s.name AS source_name, nw.range AS network_range
      FROM bluecat_addresses a
      JOIN bluecat_sources s ON s.id = a.source_id
      LEFT JOIN bluecat_networks nw ON nw.source_id = a.source_id AND nw.network_id = a.network_id
      ${where} ORDER BY a.address LIMIT ?
    `).all(...params, limit);
    res.json(rows.map((a) => ({
      id: a.id, sourceId: a.source_id, sourceName: a.source_name, address: a.address, state: a.state, name: a.name,
      mac: a.mac, networkId: a.network_id, networkRange: a.network_range, inRangeId: a.in_range_id,
    })));
  } catch (err) { next(err); }
});

router.get('/devices', [query('q').optional().isString().isLength({ max: 200 })], validate, (req, res, next) => {
  try {
    const clauses = [];
    const params = [];
    if (req.query.q) { clauses.push("d.name LIKE ? ESCAPE '\\'"); params.push(`%${req.query.q.replace(/[%_]/g, '\\$&')}%`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT d.*, s.name AS source_name FROM bluecat_devices d JOIN bluecat_sources s ON s.id = d.source_id
      ${where} ORDER BY s.name, d.name
    `).all(...params);
    res.json(rows.map((d) => ({
      id: d.id, sourceId: d.source_id, sourceName: d.source_name, deviceId: d.device_id, name: d.name,
      deviceType: d.device_type, deviceSubtype: d.device_subtype, description: d.description,
      addresses: d.addresses_json ? JSON.parse(d.addresses_json) : [],
    })));
  } catch (err) { next(err); }
});

router.get('/servers', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT sv.*, s.name AS source_name FROM bluecat_servers sv JOIN bluecat_sources s ON s.id = sv.source_id
      ORDER BY s.name, sv.name
    `).all();
    res.json(rows.map((sv) => ({
      id: sv.id, sourceId: sv.source_id, sourceName: sv.source_name, serverId: sv.server_id, name: sv.name,
      address: sv.address, profile: sv.profile, version: sv.version,
      connected: sv.connected === 1 ? true : sv.connected === 0 ? false : null,
      state: sv.state,
      interfaces: sv.interfaces_json ? JSON.parse(sv.interfaces_json) : [],
      roles: sv.roles_json ? JSON.parse(sv.roles_json) : [],
      lastDeployStatus: sv.last_deploy_status, lastDeployAt: sv.last_deploy_at,
    })));
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
      SELECT * FROM bluecat_issue_history
      WHERE status = 'open' OR last_seen >= datetime('now', ?)
      ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, last_seen DESC
    `).all(`-${days} days`));
  } catch (err) { next(err); }
});

router.get('/trends', [query('days').optional().isInt({ min: 1, max: 90 }).toInt()], validate, (req, res, next) => {
  try {
    const days = req.query.days || 7;
    res.json(db.prepare(`
      SELECT m.*, s.name AS source_name FROM bluecat_metrics_history m
      JOIN bluecat_sources s ON s.id = m.source_id
      WHERE m.captured_at >= datetime('now', ?) ORDER BY m.captured_at ASC
    `).all(`-${days} days`).map((r) => ({
      id: r.id, sourceId: r.source_id, sourceName: r.source_name, capturedAt: r.captured_at, views: r.views,
      zones: r.zones, records: r.records, networks: r.networks, networksLowSpace: r.networks_low_space,
      rangesLowSpace: r.ranges_low_space, devices: r.devices, servers: r.servers, serversDown: r.servers_down,
    })));
  } catch (err) { next(err); }
});

router.get('/config', (req, res, next) => {
  try {
    res.json({ lowFreeWarn: lowFreeWarn(), lowFreePct: lowFreePct() });
  } catch (err) { next(err); }
});

router.put('/config', [
  body('lowFreeWarn').optional().isInt({ min: 1, max: 10000 }).toInt(),
  body('lowFreePct').optional().isInt({ min: 1, max: 90 }).toInt(),
], validate, (req, res, next) => {
  try {
    const { setSetting } = require('../services/settings');
    if (req.body.lowFreeWarn !== undefined) setSetting('bluecat_low_free_warn', String(req.body.lowFreeWarn));
    if (req.body.lowFreePct !== undefined) setSetting('bluecat_low_free_pct', String(req.body.lowFreePct));
    res.json({ lowFreeWarn: lowFreeWarn(), lowFreePct: lowFreePct() });
  } catch (err) { next(err); }
});

module.exports = router;
