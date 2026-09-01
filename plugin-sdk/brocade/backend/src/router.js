// Brocade SAN routes, ported from backend/routes/brocade.js. Mounted by the
// host dispatcher at /api/brocade — paths below are relative.
//
// DEVIATION FROM THE BUILT-IN: bundled plugins cannot require the host's
// express/express-validator — createRouter must return a BARE (req, res,
// next) function (plugin-sdk/dell/unifi router.js pattern). This file
// hand-matches req.method/req.path against a route table (compile.js) and
// re-implements the validation express-validator did inline (validate.js),
// preserving the same status codes (400 invalid params, 404 not_found, 409
// duplicate, 502/200-with-ok:false upstream test-connection failures) and
// JSON response shapes exactly (camelCase publicSource, keep-if-blank
// passwords on PUT for BOTH sannav + fosPassword, id-0 test with full
// creds). SQL string literals use '' NEVER "" (SQLite parses "" as an
// identifier).
const api = require('./api');
const fosApi = require('./fosApi');
const { getHandle, portStatsRetentionDays, resolveFosTarget } = require('./poller');
const {
  healthWarnScore, healthCritScore, certWarnDays, eventStormCount, eventRetentionDays,
  computeIssues, decodeMgmtState,
} = require('./issues');
const { compile } = require('./compile');
const {
  badRequest, fail, parseIntStrict, isNonEmptyString, isBooleanish, toBool,
  requireIdParam, parseQueryInt,
} = require('./validate');

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
  fosAllowHttp: !!row.fos_allow_http,
  portStatsIntervalMinutes: row.port_stats_interval_minutes,
  fosDirectEnabled: !!row.fos_direct_enabled,
  fosUsername: row.fos_username,
  fosPort: row.fos_port,
  hasFosPassword: !!row.fos_password_enc,
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

function handleGetSources(req, res, coreApi) {
  res.json({ sources: coreApi.db.prepare('SELECT * FROM brocade_sources ORDER BY name').all().map(publicSource) });
}

function handlePostSources(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  if (!isNonEmptyString(b.name, 120)) errors.push(fail('name'));
  if (!isNonEmptyString(b.host, 253)) errors.push(fail('host'));
  let port;
  if (b.port !== undefined) {
    port = parseIntStrict(b.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push(fail('port'));
  }
  if (!isNonEmptyString(b.username, 120)) errors.push(fail('username'));
  if (!isNonEmptyString(b.password, 512)) errors.push(fail('password'));
  if (b.verifySsl !== undefined && !isBooleanish(b.verifySsl)) errors.push(fail('verifySsl'));
  let pollingIntervalMinutes;
  if (b.pollingIntervalMinutes !== undefined) {
    pollingIntervalMinutes = parseIntStrict(b.pollingIntervalMinutes);
    if (!Number.isInteger(pollingIntervalMinutes) || pollingIntervalMinutes < 5 || pollingIntervalMinutes > 1440) errors.push(fail('pollingIntervalMinutes'));
  }
  let eventPollMinutes;
  if (b.eventPollMinutes !== undefined) {
    eventPollMinutes = parseIntStrict(b.eventPollMinutes);
    if (!Number.isInteger(eventPollMinutes) || eventPollMinutes < 1 || eventPollMinutes > 1440) errors.push(fail('eventPollMinutes'));
  }
  if (b.fosProxyEnabled !== undefined && !isBooleanish(b.fosProxyEnabled)) errors.push(fail('fosProxyEnabled'));
  if (b.fosDirectEnabled !== undefined && !isBooleanish(b.fosDirectEnabled)) errors.push(fail('fosDirectEnabled'));
  if (b.fosUsername && !isNonEmptyString(b.fosUsername, 120)) errors.push(fail('fosUsername'));
  if (b.fosPassword && !(typeof b.fosPassword === 'string' && b.fosPassword.length <= 512)) errors.push(fail('fosPassword'));
  let fosPort;
  if (b.fosPort !== undefined) {
    fosPort = parseIntStrict(b.fosPort);
    if (!Number.isInteger(fosPort) || fosPort < 1 || fosPort > 65535) errors.push(fail('fosPort'));
  }
  if (b.fosAllowHttp !== undefined && !isBooleanish(b.fosAllowHttp)) errors.push(fail('fosAllowHttp'));
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  const host = b.host.trim();
  const dup = db.prepare('SELECT id FROM brocade_sources WHERE host = ? AND port = ?').get(host, port || 443);
  if (dup) return res.status(409).json({ error: 'duplicate' });
  const info = db.prepare(`
    INSERT INTO brocade_sources (name, host, port, username, password_enc, verify_ssl,
      polling_interval_minutes, event_poll_minutes, fos_proxy_enabled,
      fos_direct_enabled, fos_username, fos_password_enc, fos_port, fos_allow_http)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(b.name.trim(), host, port || 443, b.username.trim(), coreApi.encryption.encrypt(b.password), toBool(b.verifySsl) ? 1 : 0,
    pollingIntervalMinutes || 60, eventPollMinutes || 5, b.fosProxyEnabled === false || b.fosProxyEnabled === 'false' ? 0 : 1,
    toBool(b.fosDirectEnabled) ? 1 : 0, b.fosUsername ? b.fosUsername.trim() : null,
    b.fosPassword ? coreApi.encryption.encrypt(b.fosPassword) : null, fosPort || 443, toBool(b.fosAllowHttp) ? 1 : 0);
  const row = db.prepare('SELECT * FROM brocade_sources WHERE id = ?').get(info.lastInsertRowid);
  const poller = getHandle(coreApi);
  poller.schedule(row);
  poller.trigger(row).catch(() => {});
  res.status(201).json({ source: publicSource(row) });
}

function handlePutSource(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const b = req.body || {};
  const errors = [];
  if (b.name !== undefined && !isNonEmptyString(b.name, 120)) errors.push(fail('name'));
  if (b.host !== undefined && !isNonEmptyString(b.host, 253)) errors.push(fail('host'));
  let port;
  if (b.port !== undefined) {
    port = parseIntStrict(b.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push(fail('port'));
  }
  if (b.username !== undefined && !isNonEmptyString(b.username, 120)) errors.push(fail('username'));
  if (b.password !== undefined && b.password !== '' && !(typeof b.password === 'string' && b.password.length <= 512)) errors.push(fail('password'));
  if (b.verifySsl !== undefined && !isBooleanish(b.verifySsl)) errors.push(fail('verifySsl'));
  if (b.enabled !== undefined && !isBooleanish(b.enabled)) errors.push(fail('enabled'));
  let pollingIntervalMinutes;
  if (b.pollingIntervalMinutes !== undefined) {
    pollingIntervalMinutes = parseIntStrict(b.pollingIntervalMinutes);
    if (!Number.isInteger(pollingIntervalMinutes) || pollingIntervalMinutes < 5 || pollingIntervalMinutes > 1440) errors.push(fail('pollingIntervalMinutes'));
  }
  let eventPollMinutes;
  if (b.eventPollMinutes !== undefined) {
    eventPollMinutes = parseIntStrict(b.eventPollMinutes);
    if (!Number.isInteger(eventPollMinutes) || eventPollMinutes < 1 || eventPollMinutes > 1440) errors.push(fail('eventPollMinutes'));
  }
  if (b.fosProxyEnabled !== undefined && !isBooleanish(b.fosProxyEnabled)) errors.push(fail('fosProxyEnabled'));
  let portStatsIntervalMinutes;
  if (b.portStatsIntervalMinutes !== undefined) {
    portStatsIntervalMinutes = parseIntStrict(b.portStatsIntervalMinutes);
    if (!Number.isInteger(portStatsIntervalMinutes) || portStatsIntervalMinutes < 5 || portStatsIntervalMinutes > 1440) errors.push(fail('portStatsIntervalMinutes'));
  }
  if (b.fosDirectEnabled !== undefined && !isBooleanish(b.fosDirectEnabled)) errors.push(fail('fosDirectEnabled'));
  if (b.fosUsername && !isNonEmptyString(b.fosUsername, 120)) errors.push(fail('fosUsername'));
  if (b.fosPassword && !(typeof b.fosPassword === 'string' && b.fosPassword.length <= 512)) errors.push(fail('fosPassword'));
  let fosPort;
  if (b.fosPort !== undefined) {
    fosPort = parseIntStrict(b.fosPort);
    if (!Number.isInteger(fosPort) || fosPort < 1 || fosPort > 65535) errors.push(fail('fosPort'));
  }
  if (b.fosAllowHttp !== undefined && !isBooleanish(b.fosAllowHttp)) errors.push(fail('fosAllowHttp'));
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM brocade_sources WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  db.prepare(`
    UPDATE brocade_sources SET
      name = ?, host = ?, port = ?, username = ?, password_enc = ?, verify_ssl = ?, enabled = ?,
      polling_interval_minutes = ?, event_poll_minutes = ?, fos_proxy_enabled = ?, port_stats_interval_minutes = ?,
      fos_direct_enabled = ?, fos_username = ?, fos_password_enc = ?, fos_port = ?, fos_allow_http = ?
    WHERE id = ?
  `).run(
    b.name?.trim() || row.name, b.host?.trim() || row.host, port || row.port,
    b.username?.trim() || row.username,
    b.password ? coreApi.encryption.encrypt(b.password) : row.password_enc,
    b.verifySsl !== undefined ? (toBool(b.verifySsl) ? 1 : 0) : row.verify_ssl,
    b.enabled !== undefined ? (toBool(b.enabled) ? 1 : 0) : row.enabled,
    pollingIntervalMinutes || row.polling_interval_minutes,
    eventPollMinutes || row.event_poll_minutes,
    b.fosProxyEnabled !== undefined ? (toBool(b.fosProxyEnabled) ? 1 : 0) : row.fos_proxy_enabled,
    portStatsIntervalMinutes || row.port_stats_interval_minutes,
    b.fosDirectEnabled !== undefined ? (toBool(b.fosDirectEnabled) ? 1 : 0) : row.fos_direct_enabled,
    b.fosUsername !== undefined ? (b.fosUsername ? b.fosUsername.trim() : null) : row.fos_username,
    b.fosPassword ? coreApi.encryption.encrypt(b.fosPassword) : row.fos_password_enc,
    fosPort || row.fos_port,
    b.fosAllowHttp !== undefined ? (toBool(b.fosAllowHttp) ? 1 : 0) : row.fos_allow_http,
    row.id
  );
  const updated = db.prepare('SELECT * FROM brocade_sources WHERE id = ?').get(row.id);
  getHandle(coreApi).schedule(updated);
  res.json({ source: publicSource(updated) });
}

function handleDeleteSource(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM brocade_sources WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  getHandle(coreApi).cancel(row.id);
  db.prepare('DELETE FROM brocade_sources WHERE id = ?').run(row.id);
  res.json({ ok: true });
}

async function handlePostSourceTest(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const b = req.body || {};
  const errors = [];
  if (b.host !== undefined && !isNonEmptyString(b.host)) errors.push(fail('host'));
  let port;
  if (b.port !== undefined) {
    port = parseIntStrict(b.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push(fail('port'));
  }
  if (b.username !== undefined && typeof b.username !== 'string') errors.push(fail('username'));
  if (b.password !== undefined && typeof b.password !== 'string') errors.push(fail('password'));
  if (errors.length) return badRequest(res, errors);

  const row = coreApi.db.prepare('SELECT * FROM brocade_sources WHERE id = ?').get(id);
  // Unsaved sources (the Settings "add" form) test with id 0 and full override
  // creds in the body — allow that; 404 only when there is neither a row nor creds.
  if (!row && !(b.host && b.username && b.password)) {
    return res.status(404).json({ error: 'not_found' });
  }
  const base = row || { verify_ssl: 0 };
  const candidate = {
    ...base,
    host: b.host?.trim() || base.host,
    port: port || base.port || 443,
    username: b.username?.trim() || base.username,
    password: b.password || undefined,
  };
  const result = await api.testConnection(candidate, coreApi);
  res.status(200).json(result);
}

function handlePostSourcePoll(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const row = coreApi.db.prepare('SELECT * FROM brocade_sources WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  getHandle(coreApi).trigger(row).catch(() => {});
  res.json({ ok: true });
}

function handlePostSourcePollEvents(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const row = coreApi.db.prepare('SELECT * FROM brocade_sources WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  getHandle(coreApi).triggerEvents(row).catch(() => {});
  res.json({ ok: true });
}

function handlePostSourcePollPortStats(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const row = coreApi.db.prepare('SELECT * FROM brocade_sources WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  getHandle(coreApi).triggerPortStats(row).catch(() => {});
  res.json({ ok: true });
}

// ── Direct-FOS per-switch overrides (addendum 2) ────────────────────────────

function handleGetFosOverrides(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const row = db.prepare('SELECT id FROM brocade_sources WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  const overrides = db.prepare('SELECT * FROM brocade_fos_overrides WHERE source_id = ? ORDER BY switch_wwn').all(row.id);
  res.json({
    overrides: overrides.map((o) => ({
      id: o.id, switchWwn: o.switch_wwn, ipAddress: o.ip_address, username: o.username,
      hasPassword: !!o.password_enc, port: o.port,
    })),
  });
}

function handlePostFosOverrides(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const b = req.body || {};
  const errors = [];
  if (!isNonEmptyString(b.switchWwn, 64)) errors.push(fail('switchWwn'));
  if (b.ipAddress && !isNonEmptyString(b.ipAddress, 100)) errors.push(fail('ipAddress'));
  if (b.username && !isNonEmptyString(b.username, 120)) errors.push(fail('username'));
  if (b.password && !(typeof b.password === 'string' && b.password.length <= 512)) errors.push(fail('password'));
  let port;
  if (b.port !== undefined) {
    port = parseIntStrict(b.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push(fail('port'));
  }
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  const row = db.prepare('SELECT id FROM brocade_sources WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  const wwn = b.switchWwn.trim();
  const existing = db.prepare('SELECT password_enc FROM brocade_fos_overrides WHERE source_id = ? AND switch_wwn = ?').get(row.id, wwn);
  const passwordEnc = b.password ? coreApi.encryption.encrypt(b.password) : (existing ? existing.password_enc : null);
  db.prepare(`
    INSERT INTO brocade_fos_overrides (source_id, switch_wwn, ip_address, username, password_enc, port)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id, switch_wwn) DO UPDATE SET
      ip_address = excluded.ip_address, username = excluded.username, password_enc = ?, port = excluded.port
  `).run(row.id, wwn, b.ipAddress?.trim() || null, b.username?.trim() || null, passwordEnc, port || null, passwordEnc);
  const saved = db.prepare('SELECT * FROM brocade_fos_overrides WHERE source_id = ? AND switch_wwn = ?').get(row.id, wwn);
  res.json({
    override: {
      id: saved.id, switchWwn: saved.switch_wwn, ipAddress: saved.ip_address, username: saved.username,
      hasPassword: !!saved.password_enc, port: saved.port,
    },
  });
}

function handleDeleteFosOverride(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const overrideId = requireIdParam(req, res, 'overrideId');
  if (overrideId === null) return;
  const db = coreApi.db;
  const row = db.prepare('SELECT id FROM brocade_fos_overrides WHERE id = ? AND source_id = ?').get(overrideId, id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM brocade_fos_overrides WHERE id = ?').run(row.id);
  res.json({ ok: true });
}

// Resolves the default direct-FOS test/probe target for a source: the
// switch row named (by wwn), else the first fabric's seed/principal switch.
function defaultFosSwitch(coreApi, sourceId, switchWwn) {
  const db = coreApi.db;
  if (switchWwn) {
    return db.prepare('SELECT * FROM brocade_switches WHERE source_id = ? AND wwn = ? COLLATE NOCASE').get(sourceId, switchWwn) || null;
  }
  const fabric = db.prepare('SELECT * FROM brocade_fabrics WHERE source_id = ? AND stale = 0 ORDER BY id LIMIT 1').get(sourceId);
  if (!fabric) return null;
  const wwn = fabric.seed_switch_wwn || fabric.principal_switch_wwn;
  if (wwn) {
    // Case-insensitive + physical-WWN fallback: SANnav fabric records don't
    // reliably carry the same WWN identity/case as the switch inventory rows.
    const sw = db.prepare(`
      SELECT * FROM brocade_switches WHERE source_id = ?
        AND (wwn = ? COLLATE NOCASE OR physical_switch_wwn = ? COLLATE NOCASE)
    `).get(sourceId, wwn, wwn);
    if (sw) return sw;
  }
  if (fabric.seed_switch_ip) {
    const ip = String(fabric.seed_switch_ip).trim();
    const byIp = db.prepare("SELECT * FROM brocade_switches WHERE source_id = ? AND TRIM(COALESCE(ip_address, '')) = ?").get(sourceId, ip);
    if (byIp) return byIp;
    return { wwn: wwn || null, ip_address: ip, virtual_fabric_id: fabric.virtual_fabric_id };
  }
  return null;
}

async function handlePostFosTest(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const b = req.body || {};
  if (b.switchWwn !== undefined && typeof b.switchWwn !== 'string') return badRequest(res, [fail('switchWwn')]);
  const row = coreApi.db.prepare('SELECT * FROM brocade_sources WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  const sw = defaultFosSwitch(coreApi, row.id, b.switchWwn ? b.switchWwn.trim() : undefined);
  if (!sw) return res.status(200).json({ ok: false, error: 'no target switch found (poll inventory first, or pass switchWwn)' });
  const target = resolveFosTarget(coreApi, row, sw);
  if (!target) {
    return res.status(200).json({
      ok: false,
      error: `no usable direct-FOS credentials/ip for target switch ${sw.name || sw.wwn || sw.ip_address || '?'} — needs an override matching its WWN/IP, or shared FOS credentials`,
      targetSwitch: { name: sw.name || null, wwn: sw.wwn || null, ipAddress: sw.ip_address || null },
    });
  }
  const result = await fosApi.testFos(target, coreApi);
  res.status(200).json(result);
}

const PROBE_SECTIONS = ['fabrics', 'switches', 'switchports', 'deviceports', 'enclosures', 'chassis', 'health', 'events', 'zoning', 'fcr', 'about', 'portstats', 'fos-direct'];

async function handleGetSourceProbe(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const section = req.query.section;
  if (!PROBE_SECTIONS.includes(section)) return badRequest(res, [fail('section')]);
  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM brocade_sources WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  let raw;
  try {
    switch (section) {
      case 'fabrics': raw = await api.fetchFabrics(row, coreApi, 30000); break;
      case 'switches': raw = await api.fetchSwitches(row, coreApi, 30000); break;
      case 'switchports': raw = await api.fetchSwitchPorts(row, coreApi, 30000); break;
      case 'deviceports': raw = await api.fetchDevicePorts(row, coreApi, 30000); break;
      case 'enclosures': raw = await api.fetchEnclosures(row, coreApi, 30000); break;
      case 'chassis': raw = await api.fetchChassis(row, coreApi, 30000); break;
      case 'health': raw = await api.fetchHealthSummary(row, coreApi, 'FABRIC', 30000); break;
      case 'events': {
        const now = Date.now();
        const page = await api.fetchEventsPage(row, coreApi, { startTime: now - 3600000, endTime: now, pageSize: 50, timeout: 30000 });
        raw = page.events;
        break;
      }
      case 'fcr': raw = await api.fetchFcrTopology(row, coreApi, 30000); break;
      case 'about': raw = [await api.fetchAbout(row, coreApi, 30000)]; break;
      case 'portstats': {
        const sw = db.prepare('SELECT * FROM brocade_switches WHERE source_id = ? AND stale = 0 AND ip_address IS NOT NULL LIMIT 1').get(row.id);
        if (!sw) { raw = []; break; }
        const vfId = sw.virtual_fabric_id != null && sw.virtual_fabric_id >= 0 ? sw.virtual_fabric_id : -1;
        raw = await api.fetchPortStats(row, coreApi, { switchIp: sw.ip_address, vfId, timeout: 30000 });
        break;
      }
      case 'zoning': {
        const fabric = db.prepare('SELECT * FROM brocade_fabrics WHERE source_id = ? AND stale = 0 LIMIT 1').get(row.id);
        if (!fabric || !fabric.seed_switch_ip) { raw = []; break; }
        const eff = await api.fetchEffectiveZoneConfig(row, coreApi, { switchIp: fabric.seed_switch_ip, vfId: fabric.virtual_fabric_id ?? -1, timeout: 30000 });
        raw = [eff];
        break;
      }
      case 'fos-direct': {
        const sw = defaultFosSwitch(coreApi, row.id, null);
        if (!sw) { raw = []; break; }
        const target = resolveFosTarget(coreApi, row, sw);
        if (!target) {
          raw = [{
            error: 'no usable direct-FOS credentials/ip — needs an override matching this switch WWN/IP, or shared FOS credentials',
            usedSwitchWwn: sw.wwn || null, usedSwitchName: sw.name || null, usedSwitchIp: sw.ip_address || null,
          }];
          break;
        }
        const zc = await fosApi.fetchZoneConfigs(target, coreApi, sw.virtual_fabric_id, 30000);
        const stats = await fosApi.fetchPortStats(target, coreApi, sw.virtual_fabric_id, 30000).catch(() => []);
        raw = [{
          targetIp: target.ip, targetPort: target.port, usedSwitchWwn: sw.wwn || null,
          effectiveCfgName: zc.effective.cfgName, effectiveZoneKeys: Object.keys(zc.effective),
          firstStat: stats[0] || null,
        }];
        break;
      }
      default: raw = [];
    }
  } catch (err) {
    return res.json({ section, count: 0, keys: [], first: null, error: api.errMsg(err) });
  }
  const arr = Array.isArray(raw) ? raw : [];
  res.json({ section, count: arr.length, keys: arr[0] ? Object.keys(arr[0]) : [], first: arr[0] || null });
}

// ── Data endpoints ───────────────────────────────────────────────────────────

function handleGetOverview(req, res, coreApi) {
  const db = coreApi.db;
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
  const issues = computeIssues(coreApi);
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
}

function handleGetFabrics(req, res, coreApi) {
  const db = coreApi.db;
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
}

function handleGetFabricById(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const f = db.prepare('SELECT f.*, s.name AS source_name FROM brocade_fabrics f JOIN brocade_sources s ON s.id = f.source_id WHERE f.id = ?').get(id);
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
}

function handleGetSwitches(req, res, coreApi) {
  const clauses = ['stale = 0'];
  const params = [];
  if (req.query.fabric) { clauses.push('fabric_name = ?'); params.push(req.query.fabric); }
  if (req.query.sourceId) {
    const n = parseIntStrict(req.query.sourceId);
    if (!Number.isInteger(n)) return badRequest(res, [fail('sourceId')]);
    clauses.push('source_id = ?'); params.push(n);
  }
  if (req.query.status) { clauses.push("UPPER(COALESCE(operational_status,'')) = ?"); params.push(String(req.query.status).toUpperCase()); }
  const rows = coreApi.db.prepare(`
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
}

function handleGetSwitchById(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const sw = db.prepare('SELECT sw.*, s.name AS source_name FROM brocade_switches sw JOIN brocade_sources s ON s.id = sw.source_id WHERE sw.id = ?').get(id);
  if (!sw) return res.status(404).json({ error: 'not_found' });
  const ports = db.prepare(`
    SELECT * FROM brocade_switch_ports WHERE source_id = ?
      AND (switch_wwn = ? COLLATE NOCASE OR switch_wwn = COALESCE(?, '') COLLATE NOCASE)
  `).all(sw.source_id, sw.wwn, sw.physical_switch_wwn);
  const health = db.prepare(`SELECT * FROM brocade_health_scores WHERE source_id = ? AND entity_type = 'SWITCH' AND entity_guid = ? AND stale = 0`).get(sw.source_id, sw.wwn);
  const chassis = db.prepare('SELECT * FROM brocade_chassis WHERE source_id = ? AND wwn = ?').get(sw.source_id, sw.physical_switch_wwn);
  res.json({
    switch: { ...sw, managementStateLabels: decodeMgmtState(sw.management_state) },
    ports,
    healthScore: health ? { score: health.score, status: health.status, contributors: parseJson(health.contributors_json, []) } : null,
    chassis: chassis || null,
  });
}

function handleGetSwitchPortmap(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const sw = db.prepare('SELECT sw.*, s.name AS source_name FROM brocade_switches sw JOIN brocade_sources s ON s.id = sw.source_id WHERE sw.id = ?').get(id);
  if (!sw) return res.status(404).json({ error: 'not_found' });

  const rows = db.prepare(`
    SELECT sp.*, ls.in_frames_per_sec, ls.out_frames_per_sec, ls.in_mb_per_sec, ls.out_mb_per_sec,
      ls.crc_errors_delta, ls.stats_ts,
      dp.wwn AS dp_wwn, dp.device_node_wwn AS dp_device_node_wwn, dp.symbolic_name AS dp_symbolic_name,
      dp.device_symbolic_name AS dp_device_symbolic_name, dp.vendor AS dp_vendor, dp.port_role AS dp_port_role,
      dp.fdmi_host_name AS dp_fdmi_host_name, dp.enclosure_name AS dp_enclosure_name,
      dp.enclosure_guid AS dp_enclosure_guid, dp.active_zones AS dp_active_zones,
      dp.active_zoneset_name AS dp_active_zoneset_name, dp.speed AS dp_speed,
      enc.type AS enc_type, enc.host_name AS enc_host_name
    FROM brocade_switch_ports sp
    LEFT JOIN (
      SELECT ps.port_wwn AS stat_port_wwn, ps.in_frames_per_sec, ps.out_frames_per_sec, ps.in_mb_per_sec,
        ps.out_mb_per_sec, ps.crc_errors_delta, ps.ts AS stats_ts
      FROM brocade_port_stats ps
      JOIN (SELECT port_wwn, MAX(ts) AS max_ts FROM brocade_port_stats GROUP BY port_wwn) latest
        ON latest.port_wwn = ps.port_wwn AND latest.max_ts = ps.ts
    ) ls ON ls.stat_port_wwn = sp.wwn COLLATE NOCASE
    LEFT JOIN (
      SELECT d.* FROM brocade_device_ports d
      JOIN (SELECT switch_port_wwn, MIN(id) AS min_id FROM brocade_device_ports WHERE stale = 0 GROUP BY switch_port_wwn) first
        ON first.switch_port_wwn = d.switch_port_wwn AND first.min_id = d.id
      WHERE d.stale = 0
    ) dp ON dp.switch_port_wwn = sp.wwn COLLATE NOCASE
    LEFT JOIN brocade_enclosures enc ON enc.guid = dp.enclosure_guid
    WHERE sp.source_id = ?
      AND (sp.switch_wwn = ? COLLATE NOCASE OR sp.switch_wwn = COALESCE(?, '') COLLATE NOCASE)
      AND sp.stale = 0
    ORDER BY sp.slot_number, sp.port_number
  `).all(sw.source_id, sw.wwn, sw.physical_switch_wwn);

  res.json({
    switch: {
      id: sw.id, wwn: sw.wwn, name: sw.name, model: sw.model_number || sw.model,
      fabricName: sw.fabric_name, ipAddress: sw.ip_address, maxPort: sw.max_port,
      discoveredPortCount: sw.discovered_port_count, operationalStatus: sw.operational_status,
      health: sw.health, firmwareVersion: sw.firmware_version,
    },
    ports: rows.map((p) => ({
      id: p.id, wwn: p.wwn, name: p.name, slotNumber: p.slot_number, portNumber: p.port_number,
      portIndex: p.port_index, portId: p.port_id, type: p.type, state: p.state, status: p.status,
      health: p.health, calculatedStatus: p.calculated_status, statusMessage: p.status_message,
      speed: p.speed, speedType: p.speed_type, maxPortSpeed: p.max_port_speed, trunked: !!p.trunked,
      trunkMaster: !!p.trunk_master, fenced: !!p.fenced, blocked: !!p.blocked,
      persistentDisable: !!p.persistent_disable, occupied: !!p.occupied, licensed: !!p.licensed,
      zoneAlias: p.zone_alias, activeZoneCount: p.active_zone_count, remoteDevice: p.remote_device,
      remotePortWwn: p.remote_port_wwn, remoteNodeWwn: p.remote_node_wwn,
      connectedDeviceType: p.connected_device_type,
      inFramesPerSec: p.in_frames_per_sec ?? null, outFramesPerSec: p.out_frames_per_sec ?? null,
      inMbPerSec: p.in_mb_per_sec ?? null, outMbPerSec: p.out_mb_per_sec ?? null,
      crcErrorsDelta: p.crc_errors_delta ?? null, statsTs: p.stats_ts ?? null,
      device: p.dp_wwn ? {
        wwn: p.dp_wwn, deviceNodeWwn: p.dp_device_node_wwn, symbolicName: p.dp_symbolic_name,
        deviceSymbolicName: p.dp_device_symbolic_name, vendor: p.dp_vendor, portRole: p.dp_port_role,
        fdmiHostName: p.dp_fdmi_host_name, enclosureName: p.dp_enclosure_name,
        enclosureGuid: p.dp_enclosure_guid, enclosureHostName: p.enc_host_name ?? null,
        enclosureType: p.enc_type ?? null, activeZones: parseJson(p.dp_active_zones, []),
        activeZonesetName: p.dp_active_zoneset_name, speed: p.dp_speed,
      } : null,
    })),
  });
}

function handleGetPorts(req, res, coreApi) {
  const clauses = ['sp.stale = 0'];
  const params = [];
  if (req.query.switch) { clauses.push('sp.switch_wwn = ?'); params.push(req.query.switch); }
  if (req.query.fabric) { clauses.push('sp.fabric_name = ?'); params.push(req.query.fabric); }
  if (req.query.state) { clauses.push("LOWER(COALESCE(sp.state,'')) = ?"); params.push(String(req.query.state).toLowerCase()); }
  if (req.query.health) { clauses.push('sp.health = ?'); params.push(req.query.health); }
  if (req.query.search) { clauses.push('(sp.name LIKE ? OR sp.wwn LIKE ?)'); params.push(`%${req.query.search}%`, `%${req.query.search}%`); }
  const limitQ = parseQueryInt(req.query.limit, 1, 5000);
  const offsetQ = parseQueryInt(req.query.offset, 0);
  if (!limitQ.ok || !offsetQ.ok) return badRequest(res, [fail('limit')]);
  const limit = Math.min(limitQ.value ?? 5000, 5000);
  const offset = offsetQ.value ?? 0;
  const rows = coreApi.db.prepare(`
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
}

function handleGetPortStats(req, res, coreApi) {
  if (!isNonEmptyString(req.query.wwns)) return badRequest(res, [fail('wwns')]);
  const hoursQ = parseQueryInt(req.query.hours, 1, 720);
  if (!hoursQ.ok) return badRequest(res, [fail('hours')]);
  const db = coreApi.db;
  const wwns = String(req.query.wwns).split(',').map((w) => w.trim()).filter(Boolean).slice(0, 8);
  if (!wwns.length) return res.status(400).json({ error: 'wwns required' });
  const hours = hoursQ.value ?? 24;
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
}

function handleGetDevicePorts(req, res, coreApi) {
  const clauses = ['stale = 0'];
  const params = [];
  if (req.query.type) { clauses.push("LOWER(COALESCE(port_role,'')) = ?"); params.push(String(req.query.type).toLowerCase()); }
  if (req.query.fabric) { clauses.push('fabric_name = ?'); params.push(req.query.fabric); }
  if (req.query.search) { clauses.push('(symbolic_name LIKE ? OR wwn LIKE ?)'); params.push(`%${req.query.search}%`, `%${req.query.search}%`); }
  const rows = coreApi.db.prepare(`SELECT * FROM brocade_device_ports WHERE ${clauses.join(' AND ')} ORDER BY switch_name, port_number`).all(...params);
  res.json({
    devicePorts: rows.map((p) => ({
      id: p.id, sourceId: p.source_id, wwn: p.wwn, deviceNodeWwn: p.device_node_wwn, symbolicName: p.symbolic_name,
      vendor: p.vendor, portRole: p.port_role, fabricName: p.fabric_name, switchName: p.switch_name,
      switchPortWwn: p.switch_port_wwn, switchPortName: p.switch_port_name, enclosureName: p.enclosure_name,
      enclosureGuid: p.enclosure_guid, fdmiHostName: p.fdmi_host_name, activeZones: parseJson(p.active_zones, []),
      activeZonesetName: p.active_zoneset_name, zoneAlias: p.zone_alias, speed: p.speed, isMissing: !!p.is_missing,
    })),
  });
}

function handleGetEnclosures(req, res, coreApi) {
  const db = coreApi.db;
  const clauses = ['stale = 0'];
  const params = [];
  if (req.query.type) { clauses.push("LOWER(COALESCE(type,'')) LIKE ?"); params.push(`%${String(req.query.type).toLowerCase()}%`); }
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
}

function handleGetChassis(req, res, coreApi) {
  const rows = coreApi.db.prepare('SELECT * FROM brocade_chassis WHERE stale = 0 ORDER BY name').all();
  res.json({
    chassis: rows.map((c) => ({
      id: c.id, sourceId: c.source_id, switchId: c.switch_id, wwn: c.wwn, name: c.name, ipAddress: c.ip_address,
      modelNumber: c.model_number, firmware: c.firmware, serialNumber: c.serial_number, partNumber: c.part_number,
      vendor: c.vendor, maxPort: c.max_port, numVirtualSwitches: c.num_virtual_switches,
      maxVirtualSwitches: c.max_virtual_switches, tlsCertExpiryMs: c.tls_cert_expiry_ms,
    })),
  });
}

function handleGetZoning(req, res, coreApi) {
  if (!isNonEmptyString(req.query.fabric)) return badRequest(res, [fail('fabric')]);
  const db = coreApi.db;
  const fabric = req.query.fabric;
  const configs = db.prepare('SELECT * FROM brocade_zone_configs WHERE fabric_name = ? AND stale = 0').all(fabric)
    .map((c) => ({ cfgName: c.cfg_name, isEffective: !!c.is_effective, memberZones: parseJson(c.member_zones, []), defaultZoneAccess: c.default_zone_access, checksum: c.checksum }));
  const zones = db.prepare('SELECT * FROM brocade_zones WHERE fabric_name = ? AND stale = 0').all(fabric)
    .map((z) => ({ zoneName: z.zone_name, zoneType: z.zone_type, zoneTypeString: z.zone_type_string, members: parseJson(z.members, []), inEffective: !!z.in_effective }));
  const aliases = db.prepare('SELECT * FROM brocade_zone_aliases WHERE fabric_name = ? AND stale = 0').all(fabric)
    .map((a) => ({ aliasName: a.alias_name, members: parseJson(a.members, []) }));
  res.json({ configs, zones, aliases });
}

function handleGetZoningFabrics(req, res, coreApi) {
  const db = coreApi.db;
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
}

function handleGetZoningChanges(req, res, coreApi) {
  const limitQ = parseQueryInt(req.query.limit, 1, 1000);
  if (!limitQ.ok) return badRequest(res, [fail('limit')]);
  const limit = limitQ.value ?? 200;
  const clauses = [];
  const params = [];
  if (req.query.fabric) { clauses.push('fabric_name = ?'); params.push(req.query.fabric); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = coreApi.db.prepare(`SELECT * FROM brocade_zone_changes ${where} ORDER BY detected_at DESC LIMIT ?`).all(...params, limit);
  res.json({
    changes: rows.map((c) => ({
      id: c.id, sourceId: c.source_id, fabricName: c.fabric_name, changeType: c.change_type, detail: c.detail,
      oldValue: c.old_value, newValue: c.new_value, detectedAt: c.detected_at,
    })),
  });
}

function handleGetEvents(req, res, coreApi) {
  const hoursQ = parseQueryInt(req.query.hours, 1, 720);
  const limitQ = parseQueryInt(req.query.limit, 1, 1000);
  const offsetQ = parseQueryInt(req.query.offset, 0);
  if (!hoursQ.ok || !limitQ.ok || !offsetQ.ok) return badRequest(res, [fail('hours')]);
  const db = coreApi.db;
  const hours = hoursQ.value ?? 24;
  const limit = limitQ.value ?? 100;
  const offset = offsetQ.value ?? 0;
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
}

async function handlePostEventsAck(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  const sourceId = parseIntStrict(b.sourceId);
  if (!Number.isInteger(sourceId)) errors.push(fail('sourceId'));
  if (!Array.isArray(b.eventIds) || !b.eventIds.length) errors.push(fail('eventIds'));
  if (b.notes !== undefined && typeof b.notes !== 'string') errors.push(fail('notes'));
  if (errors.length) return badRequest(res, errors);
  const row = coreApi.db.prepare('SELECT * FROM brocade_sources WHERE id = ?').get(sourceId);
  if (!row) return res.status(404).json({ error: 'not_found' });
  try {
    await api.ackEvents(row, coreApi, b.eventIds, b.notes);
    const ph = b.eventIds.map(() => '?').join(',');
    coreApi.db.prepare(`UPDATE brocade_events SET acknowledged = 1, ack_notes = ?, acked_time_ms = ? WHERE source_id = ? AND event_id IN (${ph})`)
      .run(b.notes || null, Date.now(), row.id, ...b.eventIds);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: api.errMsg(err) });
  }
}

async function handlePostEventsUnack(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  const sourceId = parseIntStrict(b.sourceId);
  if (!Number.isInteger(sourceId)) errors.push(fail('sourceId'));
  if (!Array.isArray(b.eventIds) || !b.eventIds.length) errors.push(fail('eventIds'));
  if (b.notes !== undefined && typeof b.notes !== 'string') errors.push(fail('notes'));
  if (errors.length) return badRequest(res, errors);
  const row = coreApi.db.prepare('SELECT * FROM brocade_sources WHERE id = ?').get(sourceId);
  if (!row) return res.status(404).json({ error: 'not_found' });
  try {
    await api.unackEvents(row, coreApi, b.eventIds, b.notes);
    const ph = b.eventIds.map(() => '?').join(',');
    coreApi.db.prepare(`UPDATE brocade_events SET acknowledged = 0 WHERE source_id = ? AND event_id IN (${ph})`)
      .run(row.id, ...b.eventIds);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: api.errMsg(err) });
  }
}

function handleGetHealthScores(req, res, coreApi) {
  const clauses = ['stale = 0'];
  const params = [];
  if (req.query.type) { clauses.push('entity_type = ?'); params.push(String(req.query.type).toUpperCase()); }
  const rows = coreApi.db.prepare(`SELECT * FROM brocade_health_scores WHERE ${clauses.join(' AND ')} ORDER BY score ASC`).all(...params);
  res.json({
    scores: rows.map((h) => ({
      entityType: h.entity_type, entityName: h.entity_name, entityGuid: h.entity_guid, fabricName: h.fabric_name,
      score: h.score, status: h.status, computationTime: h.computation_time, contributors: parseJson(h.contributors_json, []),
    })),
  });
}

function handleGetFcr(req, res, coreApi) {
  const rows = coreApi.db.prepare('SELECT * FROM brocade_fcr_routes WHERE stale = 0').all();
  res.json({
    routes: rows.map((r) => ({
      backboneFabricId: r.backbone_fabric_id, backboneWwn: r.backbone_wwn, backboneIp: r.backbone_ip,
      edgeFabrics: parseJson(r.edge_fabrics, []),
    })),
  });
}

function handleGetIssues(req, res, coreApi) {
  res.json({ issues: computeIssues(coreApi) });
}

function handleGetIssueHistory(req, res, coreApi) {
  const limitQ = parseQueryInt(req.query.limit, 1, 2000);
  if (!limitQ.ok) return badRequest(res, [fail('limit')]);
  const limit = limitQ.value ?? 500;
  const rows = coreApi.db.prepare(`
    SELECT * FROM brocade_issue_history ORDER BY CASE WHEN resolved_at IS NULL THEN 0 ELSE 1 END, last_seen DESC LIMIT ?
  `).all(limit);
  res.json(rows.map((r) => ({
    id: r.id, source: r.source, type: r.type, target: r.target, severity: r.severity, message: r.message,
    firstSeen: r.first_seen, lastSeen: r.last_seen, resolvedAt: r.resolved_at,
  })));
}

// Broadcom FOS release lifecycle (docs.broadcom.com/doc/Brocade-SW-Support-RM).
// eos = End of Support date; lsa = Legacy Support & Availability transition.
const FOS_LIFECYCLE = {
  '7.4': { eos: '2020-02-22' },
  '8.0': { eos: '2020-11-30' },
  '8.1': { eos: '2022-02-28' },
  '8.2': { lsa: '2023-07-28' },
  '9.0': { eos: '2025-04-30' },
  '9.1': { eos: '2025-12-30' },
  '9.2': {},
};

function fosTrain(firmwareVersion) {
  const m = String(firmwareVersion || '').match(/v?(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : null;
}

function handleGetGovernance(req, res, coreApi) {
  const db = coreApi.db;
  const firmware = [];
  const fabricNames = db.prepare('SELECT DISTINCT fabric_name FROM brocade_switches WHERE stale = 0 AND fabric_name IS NOT NULL').all().map((r) => r.fabric_name);
  for (const fabricName of fabricNames) {
    const versions = db.prepare(`
      SELECT firmware_version, COUNT(*) n, json_group_array(name) names
      FROM brocade_switches WHERE stale = 0 AND fabric_name = ?
      GROUP BY firmware_version ORDER BY n DESC
    `).all(fabricName);
    firmware.push({
      fabricName,
      versions: versions.map((v) => ({ version: v.firmware_version, count: v.n, switches: parseJson(v.names, []) })),
      drift: versions.length > 1,
    });
  }
  const eos = db.prepare('SELECT * FROM brocade_switches WHERE stale = 0 AND eos_status = 1').all();
  const nowMs = Date.now();
  const fosLifecycle = db.prepare('SELECT id, name, fabric_name, firmware_version, eos_status FROM brocade_switches WHERE stale = 0').all()
    .map((sw) => {
      const train = fosTrain(sw.firmware_version);
      const lc = train ? FOS_LIFECYCLE[train] : null;
      const eosMs = lc?.eos ? Date.parse(lc.eos) : null;
      const lsaMs = lc?.lsa ? Date.parse(lc.lsa) : null;
      let status = 'unknown';
      if (eosMs != null) status = eosMs <= nowMs ? 'eos' : (eosMs - nowMs) <= 365 * 86400000 ? 'nearing' : 'supported';
      else if (lsaMs != null) status = 'lsa';
      else if (lc) status = 'supported';
      if (status === 'supported' && sw.eos_status === 1) status = 'eos';
      return {
        id: sw.id, name: sw.name, fabricName: sw.fabric_name, firmware: sw.firmware_version,
        train, status, sannavEos: sw.eos_status === 1,
        eosDate: lc?.eos || null, lsaDate: lc?.lsa || null,
        eosDays: eosMs != null ? Math.round((eosMs - nowMs) / 86400000) : null,
      };
    });
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
    fosLifecycle,
    certs,
    zoneAccess,
    mapsCallhome,
    passwordPolicy: sourceRow ? parseJson(sourceRow.password_policy_json) : null,
    users: sourceRow ? parseJson(sourceRow.users_json, []) : [],
    roles: sourceRow ? parseJson(sourceRow.roles_json, []) : [],
    aors: sourceRow ? parseJson(sourceRow.aors_json, []) : [],
    recentZoneChanges,
  });
}

function handleGetTrends(req, res, coreApi) {
  const hoursQ = parseQueryInt(req.query.hours, 1, 4320);
  if (!hoursQ.ok) return badRequest(res, [fail('hours')]);
  const db = coreApi.db;
  const hours = hoursQ.value ?? 168;
  const clauses = [`ts >= datetime('now', ?)`];
  const params = [`-${hours} hours`];
  if (req.query.sourceId) {
    const n = parseIntStrict(req.query.sourceId);
    if (!Number.isInteger(n)) return badRequest(res, [fail('sourceId')]);
    clauses.push('source_id = ?'); params.push(n);
  }
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
}

function handleGetConfig(req, res, coreApi) {
  res.json({
    healthWarnScore: healthWarnScore(coreApi),
    healthCritScore: healthCritScore(coreApi),
    certWarnDays: certWarnDays(coreApi),
    eventStormCount: eventStormCount(coreApi),
    eventRetentionDays: eventRetentionDays(coreApi),
    portStatsRetentionDays: portStatsRetentionDays(coreApi),
  });
}

function handlePutConfig(req, res, coreApi) {
  const b = req.body || {};
  const map = {
    healthWarnScore: { key: 'brocade_health_warn_score', min: 1, max: 100 },
    healthCritScore: { key: 'brocade_health_crit_score', min: 1, max: 100 },
    certWarnDays: { key: 'brocade_cert_warn_days', min: 1, max: 365 },
    eventStormCount: { key: 'brocade_event_storm_count', min: 1, max: 1000 },
    eventRetentionDays: { key: 'brocade_event_retention_days', min: 1, max: 365 },
    portStatsRetentionDays: { key: 'brocade_port_stats_retention_days', min: 1, max: 90 },
  };
  const errors = [];
  for (const [k, spec] of Object.entries(map)) {
    if (b[k] === undefined) continue;
    const n = parseIntStrict(b[k]);
    if (!Number.isInteger(n) || n < spec.min || n > spec.max) errors.push(fail(k));
  }
  if (errors.length) return badRequest(res, errors);
  for (const [k, spec] of Object.entries(map)) {
    if (b[k] !== undefined) coreApi.settings.setSetting(spec.key, String(parseIntStrict(b[k])));
  }
  res.json({ ok: true });
}

// ── route table ──────────────────────────────────────────────────────────────

const ROUTES = [
  { method: 'GET', ...compile('/sources'), handler: handleGetSources },
  { method: 'POST', ...compile('/sources'), handler: handlePostSources },
  { method: 'PUT', ...compile('/sources/:id'), handler: handlePutSource },
  { method: 'DELETE', ...compile('/sources/:id'), handler: handleDeleteSource },
  { method: 'POST', ...compile('/sources/:id/test'), handler: handlePostSourceTest },
  { method: 'POST', ...compile('/sources/:id/poll'), handler: handlePostSourcePoll },
  { method: 'POST', ...compile('/sources/:id/poll-events'), handler: handlePostSourcePollEvents },
  { method: 'POST', ...compile('/sources/:id/poll-port-stats'), handler: handlePostSourcePollPortStats },
  { method: 'GET', ...compile('/sources/:id/fos-overrides'), handler: handleGetFosOverrides },
  { method: 'POST', ...compile('/sources/:id/fos-overrides'), handler: handlePostFosOverrides },
  { method: 'DELETE', ...compile('/sources/:id/fos-overrides/:overrideId'), handler: handleDeleteFosOverride },
  { method: 'POST', ...compile('/sources/:id/fos-test'), handler: handlePostFosTest },
  { method: 'GET', ...compile('/sources/:id/probe'), handler: handleGetSourceProbe },
  { method: 'GET', ...compile('/overview'), handler: handleGetOverview },
  { method: 'GET', ...compile('/fabrics'), handler: handleGetFabrics },
  { method: 'GET', ...compile('/fabrics/:id'), handler: handleGetFabricById },
  { method: 'GET', ...compile('/switches'), handler: handleGetSwitches },
  { method: 'GET', ...compile('/switches/:id'), handler: handleGetSwitchById },
  { method: 'GET', ...compile('/switches/:id/portmap'), handler: handleGetSwitchPortmap },
  { method: 'GET', ...compile('/ports'), handler: handleGetPorts },
  { method: 'GET', ...compile('/port-stats'), handler: handleGetPortStats },
  { method: 'GET', ...compile('/device-ports'), handler: handleGetDevicePorts },
  { method: 'GET', ...compile('/enclosures'), handler: handleGetEnclosures },
  { method: 'GET', ...compile('/chassis'), handler: handleGetChassis },
  { method: 'GET', ...compile('/zoning'), handler: handleGetZoning },
  { method: 'GET', ...compile('/zoning/fabrics'), handler: handleGetZoningFabrics },
  { method: 'GET', ...compile('/zoning/changes'), handler: handleGetZoningChanges },
  { method: 'GET', ...compile('/events'), handler: handleGetEvents },
  { method: 'POST', ...compile('/events/ack'), handler: handlePostEventsAck },
  { method: 'POST', ...compile('/events/unack'), handler: handlePostEventsUnack },
  { method: 'GET', ...compile('/health-scores'), handler: handleGetHealthScores },
  { method: 'GET', ...compile('/fcr'), handler: handleGetFcr },
  { method: 'GET', ...compile('/issues'), handler: handleGetIssues },
  { method: 'GET', ...compile('/issue-history'), handler: handleGetIssueHistory },
  { method: 'GET', ...compile('/governance'), handler: handleGetGovernance },
  { method: 'GET', ...compile('/trends'), handler: handleGetTrends },
  { method: 'GET', ...compile('/config'), handler: handleGetConfig },
  { method: 'PUT', ...compile('/config'), handler: handlePutConfig },
];

// createRouter must return a BARE (req, res, next) function — installed
// plugins are loaded via require() on their own dist/backend/index.cjs and
// cannot require the host's copy of express, so express Router instances are
// off the table. Matches req.method + req.path by hand against the table
// above; req.query/req.body are still parsed by the host's express pipeline
// before this middleware runs.
function createRouter(coreApi) {
  return function brocadeRouter(req, res, next) {
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
