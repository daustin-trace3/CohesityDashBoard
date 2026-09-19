// BlueCat routes, ported from backend/routes/bluecat.js. Mounted by the
// host dispatcher at /api/bluecat - paths below are relative.
//
// DEVIATION FROM THE BUILT-IN: bundled plugins cannot require the host's
// express/express-validator - createRouter must return a BARE (req, res,
// next) function (unifi/nutanix/brocade/dell router.js pattern). This file
// hand-matches req.method/req.path against a route table (compile.js) and
// re-implements the validation express-validator did inline (validate.js),
// preserving the same status codes (400 invalid params, 404 missing, 409
// duplicate, 502 upstream/test-connection failure, 503/429/502 advisor
// errors) and JSON response shapes exactly. Registration CRUD stores
// credentials AES-encrypted via coreApi.encryption (keep-if-blank on PUT);
// data endpoints serve the polled bluecat_* tables plus computed issues.
// req.auth?.user?.username is used for attributing network-override edits.
const api = require('./api');
const { getHandle, ipToInt } = require('./poller');
const { computeIssues, lowFreeWarn, lowFreePct } = require('./issues');
const { createBluecatAdvisor } = require('./advisor');
const { compile } = require('./compile');
const {
  badRequest, fail, parseIntStrict, isNonEmptyString, isBooleanish, toBool, parseQueryInt,
} = require('./validate');

// -- Public shapes (never leak encrypted_credentials/password) --------------

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

// -- Source registration CRUD ------------------------------------------------

// -- Saved credential rule (mirrors backend/utils/connectionGuard.js) --------
// A saved secret only ever travels to the address it was saved for. A pack
// cannot require host files and must also run on hosts that predate
// coreApi.net, so the test-route and PUT rules are inline here; coreApi.net is
// only used to refuse loopback / link-local / metadata addresses.
const TARGET_CHANGE_MESSAGE = 'Enter the password or token again when changing the address. A saved credential is only ever sent to the address it was saved for.';
const normTarget = (v) => String(v === undefined || v === null ? '' : v).trim().toLowerCase().replace(/\/+$/, '');
const targetChanged = (stored, incoming) => incoming !== undefined && normTarget(incoming) !== normTarget(stored);
function hostBlocked(coreApi, host) {
  const net = coreApi.net || null;
  return !!(net && host && net.isBlockedHost(host));
}

// Test candidate for a SAVED source. No typed password: the saved credentials
// are used, so the saved host, port, username and TLS flag go with them and
// the body's are ignored. A typed password is a "try new settings" test: the
// body's target with the typed password, the saved blob left out. The
// temporary id comes AFTER the spread so the test never touches the live
// session cache entry of the real source.
function testCandidate(coreApi, row, b) {
  const tempId = `test-${row.id}-${Date.now()}`;
  if (!b.password) return { ...row, id: tempId };
  let username = b.username;
  if (!username) {
    try { username = JSON.parse(coreApi.encryption.decrypt(row.encrypted_credentials)).username; } catch { username = null; }
  }
  return {
    id: tempId,
    host: (typeof b.host === 'string' && b.host.trim()) || row.host,
    port: b.port ? parseIntStrict(b.port) : (row.port || 443),
    username,
    password: b.password,
    ssl_verify: b.sslVerify !== undefined ? (toBool(b.sslVerify) ? 1 : 0) : row.ssl_verify,
  };
}

function handleGetSources(req, res, coreApi) {
  res.json(coreApi.db.prepare('SELECT * FROM bluecat_sources ORDER BY name').all().map(publicSource));
}

function handlePostSources(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  if (!isNonEmptyString(b.name, 120)) errors.push(fail('name'));
  if (!isNonEmptyString(b.host, 253)) errors.push(fail('host'));
  if (b.port !== undefined) {
    const p = parseIntStrict(b.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) errors.push(fail('port'));
  }
  if (!isNonEmptyString(b.username, 255)) errors.push(fail('username'));
  if (!isNonEmptyString(b.password, 512)) errors.push(fail('password'));
  if (hostBlocked(coreApi, b.host)) errors.push(fail('host', 'that address is not allowed'));
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (b.pollingIntervalMinutes !== undefined) {
    const n = parseIntStrict(b.pollingIntervalMinutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) errors.push(fail('pollingIntervalMinutes'));
  }
  if (b.enumerateIntervalMinutes !== undefined) {
    const n = parseIntStrict(b.enumerateIntervalMinutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) errors.push(fail('enumerateIntervalMinutes'));
  }
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  const name = b.name.trim();
  const host = b.host.trim();
  const dup = db.prepare('SELECT id FROM bluecat_sources WHERE name = ? OR host = ?').get(name, host);
  if (dup) return res.status(409).json({ error: 'A BlueCat source with that name or host is already registered.' });
  const info = db.prepare(`
    INSERT INTO bluecat_sources (name, host, port, encrypted_credentials, ssl_verify, polling_interval_minutes, enumerate_interval_minutes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, host, b.port ? parseIntStrict(b.port) : 443,
    coreApi.encryption.encrypt(JSON.stringify({ username: b.username, password: b.password })),
    toBool(b.sslVerify) ? 1 : 0,
    b.pollingIntervalMinutes ? parseIntStrict(b.pollingIntervalMinutes) : 30,
    b.enumerateIntervalMinutes ? parseIntStrict(b.enumerateIntervalMinutes) : 60);
  const row = db.prepare('SELECT * FROM bluecat_sources WHERE id = ?').get(info.lastInsertRowid);
  const handle = getHandle(coreApi);
  handle.schedule(row);
  handle.trigger(row).catch(() => {});
  res.status(201).json(publicSource(row));
}

function handlePutSource(req, res, coreApi) {
  const id = parseIntStrict(req.params.id);
  if (!Number.isInteger(id)) return badRequest(res, [fail('id')]);
  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM bluecat_sources WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'BlueCat source not found.' });
  const b = req.body || {};
  const errors = [];
  if (b.name !== undefined && !isNonEmptyString(b.name, 120)) errors.push(fail('name'));
  if (b.host !== undefined && !isNonEmptyString(b.host, 253)) errors.push(fail('host'));
  if (b.port !== undefined) {
    const p = parseIntStrict(b.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) errors.push(fail('port'));
  }
  if (b.username !== undefined && !isNonEmptyString(b.username, 255)) errors.push(fail('username'));
  if (b.password !== undefined && b.password !== '' && (typeof b.password !== 'string' || b.password.length > 512)) errors.push(fail('password'));
  if (b.host !== undefined && hostBlocked(coreApi, b.host)) errors.push(fail('host', 'that address is not allowed'));
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (b.pollingIntervalMinutes !== undefined) {
    const n = parseIntStrict(b.pollingIntervalMinutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) errors.push(fail('pollingIntervalMinutes'));
  }
  if (b.enumerateIntervalMinutes !== undefined) {
    const n = parseIntStrict(b.enumerateIntervalMinutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) errors.push(fail('enumerateIntervalMinutes'));
  }
  if (errors.length) return badRequest(res, errors);

  if (!b.password && (targetChanged(row.host, b.host) || targetChanged(row.port, b.port))) {
    return res.status(400).json({ error: TARGET_CHANGE_MESSAGE });
  }

  let encryptedCredentials = row.encrypted_credentials;
  if (b.password) {
    let existingUsername = b.username;
    if (!existingUsername) {
      try { existingUsername = JSON.parse(coreApi.encryption.decrypt(row.encrypted_credentials)).username; } catch { existingUsername = null; }
    }
    encryptedCredentials = coreApi.encryption.encrypt(JSON.stringify({ username: existingUsername, password: b.password }));
  } else if (b.username) {
    let existingPassword = null;
    try { existingPassword = JSON.parse(coreApi.encryption.decrypt(row.encrypted_credentials)).password; } catch { existingPassword = null; }
    if (existingPassword) encryptedCredentials = coreApi.encryption.encrypt(JSON.stringify({ username: b.username, password: existingPassword }));
  }
  db.prepare(`
    UPDATE bluecat_sources SET
      name = ?, host = ?, port = ?, encrypted_credentials = ?, ssl_verify = ?,
      polling_interval_minutes = ?, enumerate_interval_minutes = ?
    WHERE id = ?
  `).run(
    b.name?.trim() || row.name, b.host?.trim() || row.host, b.port ? parseIntStrict(b.port) : row.port,
    encryptedCredentials,
    b.sslVerify !== undefined ? (toBool(b.sslVerify) ? 1 : 0) : row.ssl_verify,
    b.pollingIntervalMinutes ? parseIntStrict(b.pollingIntervalMinutes) : row.polling_interval_minutes,
    b.enumerateIntervalMinutes ? parseIntStrict(b.enumerateIntervalMinutes) : row.enumerate_interval_minutes,
    row.id
  );
  const updated = db.prepare('SELECT * FROM bluecat_sources WHERE id = ?').get(row.id);
  getHandle(coreApi).schedule(updated);
  // Drop the cached BAM session. Log out against the OLD row: the cached
  // token belongs to the old address and must not be sent to a new one.
  api.logout(row, coreApi).catch(() => {});
  res.json(publicSource(updated));
}

function handleDeleteSource(req, res, coreApi) {
  const id = parseIntStrict(req.params.id);
  if (!Number.isInteger(id)) return badRequest(res, [fail('id')]);
  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM bluecat_sources WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'BlueCat source not found.' });
  getHandle(coreApi).cancel(row.id);
  db.prepare('DELETE FROM bluecat_sources WHERE id = ?').run(row.id);
  res.status(204).end();
}

// Literal /sources/test must be checked before the /sources/:id/test param
// sibling (segment counts differ so the route table itself never collides,
// but the two handlers are kept in the same relative order as the built-in
// for fidelity).
async function handlePostSourcesTest(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  if (b.id !== undefined && !Number.isInteger(parseIntStrict(b.id))) errors.push(fail('id'));
  if (b.host !== undefined && !isNonEmptyString(b.host)) errors.push(fail('host'));
  if (b.port !== undefined) {
    const p = parseIntStrict(b.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) errors.push(fail('port'));
  }
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (b.host !== undefined && hostBlocked(coreApi, b.host)) errors.push(fail('host', 'that address is not allowed'));
  if (errors.length) return badRequest(res, errors);

  const { id, host, username, password, port, sslVerify } = b;
  const db = coreApi.db;
  let candidate;
  if (id) {
    const row = db.prepare('SELECT * FROM bluecat_sources WHERE id = ?').get(parseIntStrict(id));
    if (!row) return res.status(404).json({ error: 'BlueCat source not found.' });
    candidate = testCandidate(coreApi, row, b);
  } else {
    if (!host || !username || !password) {
      return res.status(400).json({ error: 'Invalid parameters', details: [{ msg: 'host, username, and password required' }] });
    }
    candidate = { host: host.trim(), username, password, port: port ? parseIntStrict(port) : 443, ssl_verify: toBool(sslVerify) ? 1 : 0 };
  }
  const result = await api.testConnection(candidate, coreApi);
  res.status(result.ok ? 200 : 502).json(result);
}

// POST /sources/:id/test - body may carry full creds even when :id does not
// exist yet (the UI posts /sources/0/test for a new registration form).
async function handlePostSourceTest(req, res, coreApi) {
  const id = parseIntStrict(req.params.id);
  if (!Number.isInteger(id)) return badRequest(res, [fail('id')]);
  const b = req.body || {};
  if (b.port !== undefined) {
    const p = parseIntStrict(b.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return badRequest(res, [fail('port')]);
  }
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) return badRequest(res, [fail('sslVerify')]);
  if (b.host !== undefined && typeof b.host !== 'string') return badRequest(res, [fail('host')]);
  if (hostBlocked(coreApi, b.host)) return badRequest(res, [fail('host', 'that address is not allowed')]);

  const { username, password, host, port, sslVerify } = b;
  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM bluecat_sources WHERE id = ?').get(id);
  let candidate;
  if (row) {
    candidate = testCandidate(coreApi, row, b);
  } else {
    if (!username || !password) return res.status(404).json({ error: 'BlueCat source not found.' });
    if (!host || !host.trim()) return res.status(400).json({ error: 'Invalid parameters', details: [{ msg: 'host required' }] });
    candidate = { host: host.trim(), username, password, port: port ? parseIntStrict(port) : 443, ssl_verify: toBool(sslVerify) ? 1 : 0 };
  }
  const result = await api.testConnection(candidate, coreApi);
  res.status(result.ok ? 200 : 502).json(result);
}

function handlePostSourcePoll(req, res, coreApi) {
  const id = parseIntStrict(req.params.id);
  if (!Number.isInteger(id)) return badRequest(res, [fail('id')]);
  const row = coreApi.db.prepare('SELECT * FROM bluecat_sources WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'BlueCat source not found.' });
  getHandle(coreApi).trigger(row).catch(() => {});
  res.status(202).json({ ok: true });
}

function handlePostSourceEnumerate(req, res, coreApi) {
  const id = parseIntStrict(req.params.id);
  if (!Number.isInteger(id)) return badRequest(res, [fail('id')]);
  const row = coreApi.db.prepare('SELECT * FROM bluecat_sources WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'BlueCat source not found.' });
  getHandle(coreApi).triggerEnumerate(row).catch(() => {});
  res.status(202).json({ ok: true });
}

// Probe fetches run the same fetchers the poller uses, live against the
// source, reporting raw shapes - the mandatory live-debug loop.
async function handleGetSourceProbe(req, res, coreApi) {
  const id = parseIntStrict(req.params.id);
  if (!Number.isInteger(id)) return badRequest(res, [fail('id')]);
  const row = coreApi.db.prepare('SELECT * FROM bluecat_sources WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'BlueCat source not found.' });

  const sections = {};
  const run = async (name, fn) => {
    try {
      const data = await fn();
      sections[name] = { ok: true, status: 200, sample: data, error: null };
    } catch (err) {
      sections[name] = { ok: false, status: err.response?.status || null, sample: null, error: api.errMsg(err) };
    }
  };
  const filterProbe = (path) => run(`filterField:${path}`, async () => {
    try {
      await api.apiGet(row, coreApi, path, { params: { filter: 'zzz:eq(1)' } });
      return null;
    } catch (err) {
      return { status: err.response?.status || null, message: api.errMsg(err) };
    }
  });

  await run('settingsVersion', () => api.fetchVersion(row, coreApi));
  let configurations = [];
  await run('configurations', async () => { configurations = await api.fetchConfigurations(row, coreApi); return configurations; });
  const configId = configurations[0]?.id;

  let views = [];
  if (configId != null) await run('view', async () => { views = await api.fetchViews(row, coreApi, configId); return views[0] || null; });

  let zones = [];
  await run('zone', async () => { zones = await api.fetchZones(row, coreApi); return zones[0] || null; });

  await run('resourceRecordsPage', () => api.apiGet(row, coreApi, '/resourceRecords', { params: { limit: 3 } }));
  await run('resourceRecordsFilterTest', () => api.apiGet(row, coreApi, '/resourceRecords', { params: { filter: "absoluteName:contains('a')", limit: 3 } }));

  let blocks = [];
  await run('block', async () => { blocks = await api.fetchBlocks(row, coreApi); return blocks[0] || null; });

  let networks = [];
  await run('network', async () => { networks = await api.fetchNetworks(row, coreApi); return networks[0] || null; });

  const smallestIpv4 = networks.filter((n) => n.ipVersion === 4).sort((a, b) => (b.prefix || 0) - (a.prefix || 0))[0];
  if (smallestIpv4) {
    await run('networkRanges', () => api.fetchRanges(row, coreApi, smallestIpv4.id));
    await run('networkAddressesSample', () => api.apiGet(row, coreApi, `/networks/${smallestIpv4.id}/addresses`, { params: { limit: 50 } }));
  }
  const largestIpv4 = networks.filter((n) => n.ipVersion === 4).sort((a, b) => (a.prefix || 0) - (b.prefix || 0))[0];
  if (largestIpv4) {
    await run('networkAddressStatesDistinct', async () => {
      const d = await api.apiGet(row, coreApi, `/networks/${largestIpv4.id}/addresses`, { params: { limit: 1000 } });
      const states = new Set((d?.data || []).map((a) => a.state).filter(Boolean));
      return [...states];
    });
  }

  if (configId != null) {
    await run('deviceWithAddresses', async () => {
      const rows = await api.fetchDevices(row, coreApi, configId);
      return rows[0] || null;
    });
  }

  let servers = [];
  await run('serverWithInterfaces', async () => { servers = await api.fetchServers(row, coreApi); return servers[0] || null; });
  if (servers[0]) {
    await run('serverDeployment', () => api.fetchLatestDeployment(row, coreApi, servers[0].id));
  }
  await run('deploymentRoles', async () => (await api.fetchDeploymentRoles(row, coreApi)).slice(0, 3));

  await Promise.all(['zones', 'resourceRecords', 'networks', 'addresses', 'ranges', 'devices', 'servers'].map((p) => filterProbe(`/${p}`)));

  res.json({ sections });
}

// -- Data endpoints -------------------------------------------------------------

function handleGetOverview(req, res, coreApi) {
  const db = coreApi.db;
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
  const warn = lowFreeWarn(coreApi);
  const networksLowSpace = db.prepare(`
    SELECT COUNT(*) n FROM bluecat_networks nw
    LEFT JOIN bluecat_network_overrides o ON o.source_id = nw.source_id AND o.network_id = nw.network_id
    WHERE nw.ip_version = 4 AND nw.free_static IS NOT NULL AND nw.free_static < ? AND COALESCE(o.exclude_low_space, 0) = 0
  `).get(warn).n;
  const rangesLowSpace = db.prepare('SELECT COUNT(*) n FROM bluecat_ranges WHERE free_dhcp IS NOT NULL AND free_dhcp < ?').get(warn).n;

  const issues = computeIssues(coreApi);
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
}

function handleGetViews(req, res, coreApi) {
  res.json(coreApi.db.prepare(`
    SELECT v.*, s.name AS source_name FROM bluecat_views v JOIN bluecat_sources s ON s.id = v.source_id
    ORDER BY s.name, v.name
  `).all().map((v) => ({
    id: v.id, sourceId: v.source_id, sourceName: v.source_name, viewId: v.view_id,
    configurationName: v.configuration_name, name: v.name, zoneCount: v.zone_count, recordCount: v.record_count,
  })));
}

function handleGetZones(req, res, coreApi) {
  const errors = [];
  if (req.query.viewId !== undefined && !Number.isInteger(parseIntStrict(req.query.viewId))) errors.push(fail('viewId'));
  if (req.query.q !== undefined && (typeof req.query.q !== 'string' || req.query.q.length > 200)) errors.push(fail('q'));
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  const clauses = [];
  const params = [];
  if (req.query.viewId !== undefined) { clauses.push('z.view_id = ?'); params.push(parseIntStrict(req.query.viewId)); }
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
}

// IPv4 networks of a source as sorted integer bounds, for IP -> network
// lookups (cache per request).
function cidrBounds(range) {
  const m = String(range || '').match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!m) return null;
  const base = ipToInt(m[1]);
  const prefix = Number(m[2]);
  if (base == null || prefix > 32) return null;
  const size = Math.pow(2, 32 - prefix);
  const start = Math.floor(base / size) * size;
  return { start, end: start + size - 1 };
}

function networkIndex(coreApi, sourceId) {
  const rows = coreApi.db.prepare(`
    SELECT n.id, n.network_id, n.range, n.name, n.prefix, b.name AS block_name, b.range AS block_range
    FROM bluecat_networks n LEFT JOIN bluecat_blocks b ON b.source_id = n.source_id AND b.block_id = n.block_id
    WHERE n.source_id = ? AND n.ip_version = 4
  `).all(sourceId);
  const idx = [];
  for (const n of rows) {
    const bnd = cidrBounds(n.range);
    if (bnd) idx.push({ ...n, start: bnd.start, end: bnd.end });
  }
  // Longest prefix first so the most specific network wins.
  idx.sort((a, b) => (b.prefix || 0) - (a.prefix || 0));
  return idx;
}

function findNetwork(idx, ipInt) {
  for (const n of idx) if (ipInt >= n.start && ipInt <= n.end) return n;
  return null;
}

/** IPs a record resolves to: rdata tokens, then addresses_json, then (host
 *  records whose poll did not inline addresses) the address table by name. */
function recordIps(coreApi, r, addrByName) {
  const ips = [];
  for (const part of String(r.rdata || '').split(/[,\s]+/)) { if (ipToInt(part) != null) ips.push(part); }
  if (r.addresses_json) {
    try { for (const a of JSON.parse(r.addresses_json)) { const v = typeof a === 'string' ? a : a?.address; if (ipToInt(v) != null && !ips.includes(v)) ips.push(v); } } catch { /* ignore */ }
  }
  let source = ips.length ? 'record' : null;
  // Alias (CNAME) and MX/SRV style records point at a name: follow one hop to
  // the target host record so the alias shows the IP it resolves to.
  if (!ips.length && r.rdata && !ipToInt(r.rdata) && /^[a-z0-9.-]+$/i.test(String(r.rdata).replace(/\.$/, ''))) {
    const target = coreApi.db.prepare(`
      SELECT rdata, addresses_json, record_type, name, absolute_name FROM bluecat_records
      WHERE source_id = ? AND LOWER(absolute_name) = LOWER(?) AND (rr_type = 'A' OR record_type = 'HostRecord') LIMIT 1
    `).get(r.source_id, String(r.rdata).replace(/\.$/, ''));
    if (target) {
      const t = recordIps(coreApi, { ...target, source_id: r.source_id }, addrByName);
      if (t.ips.length) { ips.push(...t.ips); source = 'alias-target'; }
    }
  }
  if (!ips.length && r.record_type === 'HostRecord' && addrByName) {
    const hit = addrByName.get(String(r.name || '').toLowerCase()) || addrByName.get(String(r.absolute_name || '').toLowerCase());
    if (hit) { ips.push(hit); source = 'address-table'; }
  }
  return { ips, source };
}

function recordsInNetwork(coreApi, sourceId, range, ipVersion, limit = 200) {
  if (ipVersion !== 4) return [];
  const b = cidrBounds(range);
  if (!b) return [];
  const out = [];
  const seen = new Set();
  const rows = coreApi.db.prepare(`
    SELECT * FROM bluecat_records WHERE source_id = ? AND (rr_type = 'A' OR record_type = 'HostRecord' OR rdata LIKE '%.%.%.%')
  `).all(sourceId);
  for (const r of rows) {
    const ips = [];
    for (const part of String(r.rdata || '').split(/[,\s]+/)) { const v = ipToInt(part); if (v != null) ips.push(v); }
    if (r.addresses_json) {
      try { for (const a of JSON.parse(r.addresses_json)) { const v = ipToInt(typeof a === 'string' ? a : a?.address); if (v != null) ips.push(v); } } catch { /* ignore */ }
    }
    if (ips.some((v) => v >= b.start && v <= b.end) && !seen.has(r.id)) {
      seen.add(r.id);
      out.push(r);
      if (out.length >= limit) break;
    }
  }
  return out;
}

function handleGetRecords(req, res, coreApi) {
  const errors = [];
  if (req.query.q !== undefined && (typeof req.query.q !== 'string' || req.query.q.length > 200)) errors.push(fail('q'));
  if (req.query.rrType !== undefined && (typeof req.query.rrType !== 'string' || req.query.rrType.length > 30)) errors.push(fail('rrType'));
  if (req.query.viewId !== undefined && !Number.isInteger(parseIntStrict(req.query.viewId))) errors.push(fail('viewId'));
  if (req.query.zoneId !== undefined && !Number.isInteger(parseIntStrict(req.query.zoneId))) errors.push(fail('zoneId'));
  let limitVal;
  if (req.query.limit !== undefined) {
    const r = parseQueryInt(req.query.limit, 1, 1000);
    if (!r.ok) errors.push(fail('limit')); else limitVal = r.value;
  }
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  const limit = Math.min(limitVal || 200, 1000);
  const clauses = [];
  const params = [];
  if (req.query.rrType) { clauses.push('r.rr_type = ?'); params.push(req.query.rrType); }
  if (req.query.viewId !== undefined) { clauses.push('r.view_id = ?'); params.push(parseIntStrict(req.query.viewId)); }
  if (req.query.zoneId !== undefined) { clauses.push('r.zone_id = ?'); params.push(parseIntStrict(req.query.zoneId)); }
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
  // Resolve IP + containing IP space per record (per source, cached per request).
  const idxBySource = new Map();
  const addrBySource = new Map();
  const indexFor = (sid) => { if (!idxBySource.has(sid)) idxBySource.set(sid, networkIndex(coreApi, sid)); return idxBySource.get(sid); };
  const addrMapFor = (sid) => {
    if (!addrBySource.has(sid)) {
      const m = new Map();
      for (const a of db.prepare('SELECT address, name FROM bluecat_addresses WHERE source_id = ? AND name IS NOT NULL').all(sid)) {
        const k = String(a.name).toLowerCase();
        if (!m.has(k)) m.set(k, a.address);
      }
      addrBySource.set(sid, m);
    }
    return addrBySource.get(sid);
  };
  res.json({
    records: rows.map((r) => {
      const { ips, source: ipSource } = recordIps(coreApi, r, addrMapFor(r.source_id));
      const first = ips[0] || null;
      const net = first ? findNetwork(indexFor(r.source_id), ipToInt(first)) : null;
      return {
        id: r.id, sourceId: r.source_id, sourceName: r.source_name, recordId: r.record_id, zoneId: r.zone_id,
        zoneName: r.zone_name, viewId: r.view_id, viewName: r.view_name, name: r.name, absoluteName: r.absolute_name,
        recordType: r.record_type, rrType: r.rr_type, rdata: r.rdata, ttl: r.ttl,
        addresses: r.addresses_json ? JSON.parse(r.addresses_json) : [], comment: r.comment,
        ip: first, ips, ipSource,
        network: net ? { id: net.id, networkId: net.network_id, range: net.range, name: net.name, blockName: net.block_name, blockRange: net.block_range } : null,
      };
    }),
    total,
    limited: rows.length >= limit,
  });
}

async function handleGetRecordsLookup(req, res, coreApi) {
  const errors = [];
  if (!isNonEmptyString(req.query.q, 200)) errors.push(fail('q'));
  if (req.query.sourceId !== undefined && !Number.isInteger(parseIntStrict(req.query.sourceId))) errors.push(fail('sourceId'));
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  let row = null;
  if (req.query.sourceId) row = db.prepare('SELECT * FROM bluecat_sources WHERE id = ?').get(parseIntStrict(req.query.sourceId));
  else row = db.prepare('SELECT * FROM bluecat_sources ORDER BY id LIMIT 1').get();
  if (!row) return res.json({ ok: false, method: null, results: [], error: 'no BlueCat source registered' });
  const result = await api.searchRecords(row, coreApi, req.query.q.trim());
  const trimmed = (result.results || []).map((r) => ({
    id: r.id, type: r.type, name: r.name, absoluteName: r.absoluteName, rdata: r.rdata, recordType: r.recordType,
  }));
  res.json({ ok: result.ok, method: result.method || null, results: trimmed, error: result.error || null });
}

function handleGetBlocks(req, res, coreApi) {
  const db = coreApi.db;
  const rows = db.prepare(`
    SELECT b.*, s.name AS source_name,
      (SELECT COUNT(*) FROM bluecat_networks n WHERE n.source_id = b.source_id AND n.block_id = b.block_id) network_count
    FROM bluecat_blocks b JOIN bluecat_sources s ON s.id = b.source_id ORDER BY s.name, b.range
  `).all();
  const warn = lowFreeWarn(coreApi);
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
}

function handleGetNetworks(req, res, coreApi) {
  const errors = [];
  if (req.query.blockId !== undefined && !Number.isInteger(parseIntStrict(req.query.blockId))) errors.push(fail('blockId'));
  if (req.query.sourceId !== undefined && !Number.isInteger(parseIntStrict(req.query.sourceId))) errors.push(fail('sourceId'));
  if (req.query.q !== undefined && (typeof req.query.q !== 'string' || req.query.q.length > 200)) errors.push(fail('q'));
  if (req.query.lowSpace !== undefined && req.query.lowSpace !== '0' && req.query.lowSpace !== '1') errors.push(fail('lowSpace'));
  if (req.query.ipVersion !== undefined) {
    const r = parseQueryInt(req.query.ipVersion, 4, 6);
    if (!r.ok) errors.push(fail('ipVersion'));
  }
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  const clauses = [];
  const params = [];
  // A block selected in the tree must list the networks of every block
  // beneath it, not only its direct children (networks usually live two or
  // three block levels down from the top).
  let cte = '';
  if (req.query.blockId !== undefined) {
    cte = `WITH RECURSIVE sub(block_id) AS (
      SELECT ? UNION ALL
      SELECT b.block_id FROM bluecat_blocks b JOIN sub ON b.parent_block_id = sub.block_id
    ) `;
    params.push(parseIntStrict(req.query.blockId));
    clauses.push('nw.block_id IN (SELECT block_id FROM sub)');
  }
  if (req.query.sourceId !== undefined) { clauses.push('nw.source_id = ?'); params.push(parseIntStrict(req.query.sourceId)); }
  if (req.query.ipVersion !== undefined) { clauses.push('nw.ip_version = ?'); params.push(parseIntStrict(req.query.ipVersion)); }
  if (req.query.q) { clauses.push("(nw.range LIKE ? ESCAPE '\\' OR nw.name LIKE ? ESCAPE '\\')"); const like = `%${req.query.q.replace(/[%_]/g, '\\$&')}%`; params.push(like, like); }
  const warn = lowFreeWarn(coreApi);
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
}

function handleGetNetworkById(req, res, coreApi) {
  const id = parseIntStrict(req.params.id);
  if (!Number.isInteger(id)) return badRequest(res, [fail('id')]);
  const db = coreApi.db;
  const n = db.prepare(`
    SELECT nw.*, s.name AS source_name,
      o.gateway AS o_gateway, o.exclude_low_space AS o_exclude, o.note AS o_note, o.updated_by AS o_updated_by, o.updated_at AS o_updated_at
    FROM bluecat_networks nw
    JOIN bluecat_sources s ON s.id = nw.source_id
    LEFT JOIN bluecat_network_overrides o ON o.source_id = nw.source_id AND o.network_id = nw.network_id
    WHERE nw.id = ?
  `).get(id);
  if (!n) return res.status(404).json({ error: 'Network not found.' });
  const ranges = db.prepare('SELECT * FROM bluecat_ranges WHERE source_id = ? AND network_id = ? ORDER BY start_ip').all(n.source_id, n.network_id);
  const addresses = db.prepare(`
    SELECT * FROM bluecat_addresses WHERE source_id = ? AND network_id = ?
    ORDER BY (
      CAST(substr(address, 1, instr(address, '.') - 1) AS INTEGER) * 16777216
    ) LIMIT 2000
  `).all(n.source_id, n.network_id);
  // Records "in" a network = A/host records whose address falls inside the
  // network CIDR. Computed from the record data itself, so it works before
  // the address enumeration has run.
  const records = recordsInNetwork(coreApi, n.source_id, n.range, n.ip_version);
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
}

function ipInNetwork(ip, range) {
  if (!ip || !range) return false;
  const m = String(range).match(/^([\d.]+)\/(\d{1,2})$/);
  if (!m) return true; // non-CIDR range (v6 or unparsed) - do not block
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

function networkPublic(coreApi, n) {
  const db = coreApi.db;
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

function handlePutNetworkOverride(req, res, coreApi) {
  const id = parseIntStrict(req.params.id);
  if (!Number.isInteger(id)) return badRequest(res, [fail('id')]);
  const b = req.body || {};
  const errors = [];
  if (b.gateway !== undefined && b.gateway !== null && typeof b.gateway !== 'string') errors.push(fail('gateway'));
  if (b.excludeLowSpace !== undefined && !isBooleanish(b.excludeLowSpace)) errors.push(fail('excludeLowSpace'));
  if (b.note !== undefined && b.note !== null && (typeof b.note !== 'string' || b.note.length > 500)) errors.push(fail('note'));
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  const n = db.prepare('SELECT * FROM bluecat_networks WHERE id = ?').get(id);
  if (!n) return res.status(404).json({ error: 'Network not found.' });
  const { gateway, excludeLowSpace, note } = b;
  if (gateway && !ipInNetwork(gateway, n.range)) {
    return res.status(400).json({ error: 'Gateway is not inside the network range.' });
  }
  db.prepare(`
    INSERT INTO bluecat_network_overrides (source_id, network_id, gateway, exclude_low_space, note, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(source_id, network_id) DO UPDATE SET
      gateway = excluded.gateway, exclude_low_space = excluded.exclude_low_space, note = excluded.note,
      updated_by = excluded.updated_by, updated_at = datetime('now')
  `).run(n.source_id, n.network_id, gateway || null, toBool(excludeLowSpace) ? 1 : 0, note || null, currentUsername(req));

  db.prepare('UPDATE bluecat_networks SET gateway = ?, gateway_source = ? WHERE id = ?').run(gateway || n.gateway, gateway ? 'override' : n.gateway_source, n.id);

  res.json(networkPublic(coreApi, db.prepare('SELECT * FROM bluecat_networks WHERE id = ?').get(n.id)));
}

function handleDeleteNetworkOverride(req, res, coreApi) {
  const id = parseIntStrict(req.params.id);
  if (!Number.isInteger(id)) return badRequest(res, [fail('id')]);
  const db = coreApi.db;
  const n = db.prepare('SELECT * FROM bluecat_networks WHERE id = ?').get(id);
  if (!n) return res.status(404).json({ error: 'Network not found.' });
  db.prepare('DELETE FROM bluecat_network_overrides WHERE source_id = ? AND network_id = ?').run(n.source_id, n.network_id);

  const addrRow = db.prepare(`SELECT address FROM bluecat_addresses WHERE source_id = ? AND network_id = ? AND state = 'GATEWAY' LIMIT 1`).get(n.source_id, n.network_id);
  let gateway = null;
  let gatewaySource = null;
  if (addrRow) { gateway = addrRow.address; gatewaySource = 'address'; }
  db.prepare('UPDATE bluecat_networks SET gateway = ?, gateway_source = ? WHERE id = ?').run(gateway, gatewaySource, n.id);

  res.json(networkPublic(coreApi, db.prepare('SELECT * FROM bluecat_networks WHERE id = ?').get(n.id)));
}

function handleGetRanges(req, res, coreApi) {
  if (req.query.lowSpace !== undefined && req.query.lowSpace !== '0' && req.query.lowSpace !== '1') return badRequest(res, [fail('lowSpace')]);
  const db = coreApi.db;
  const warn = lowFreeWarn(coreApi);
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
}

function handleGetAddresses(req, res, coreApi) {
  const errors = [];
  if (req.query.q !== undefined && (typeof req.query.q !== 'string' || req.query.q.length > 200)) errors.push(fail('q'));
  let limitVal;
  if (req.query.limit !== undefined) {
    const r = parseQueryInt(req.query.limit, 1, 1000);
    if (!r.ok) errors.push(fail('limit')); else limitVal = r.value;
  }
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  const limit = limitVal || 200;
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
}

function handleGetDevices(req, res, coreApi) {
  if (req.query.q !== undefined && (typeof req.query.q !== 'string' || req.query.q.length > 200)) return badRequest(res, [fail('q')]);
  const db = coreApi.db;
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
}

function handleGetServers(req, res, coreApi) {
  const rows = coreApi.db.prepare(`
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
}

function handleGetIssues(req, res, coreApi) {
  res.json({ issues: computeIssues(coreApi) });
}

function handleGetIssueHistory(req, res, coreApi) {
  let daysVal;
  if (req.query.days !== undefined) {
    const r = parseQueryInt(req.query.days, 1, 90);
    if (!r.ok) return badRequest(res, [fail('days')]);
    daysVal = r.value;
  }
  const days = daysVal || 30;
  res.json(coreApi.db.prepare(`
    SELECT * FROM bluecat_issue_history
    WHERE status = 'open' OR last_seen >= datetime('now', ?)
    ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, last_seen DESC
  `).all(`-${days} days`));
}

function handleGetTrends(req, res, coreApi) {
  let daysVal;
  if (req.query.days !== undefined) {
    const r = parseQueryInt(req.query.days, 1, 90);
    if (!r.ok) return badRequest(res, [fail('days')]);
    daysVal = r.value;
  }
  const days = daysVal || 7;
  res.json(coreApi.db.prepare(`
    SELECT m.*, s.name AS source_name FROM bluecat_metrics_history m
    JOIN bluecat_sources s ON s.id = m.source_id
    WHERE m.captured_at >= datetime('now', ?) ORDER BY m.captured_at ASC
  `).all(`-${days} days`).map((r) => ({
    id: r.id, sourceId: r.source_id, sourceName: r.source_name, capturedAt: r.captured_at, views: r.views,
    zones: r.zones, records: r.records, networks: r.networks, networksLowSpace: r.networks_low_space,
    rangesLowSpace: r.ranges_low_space, devices: r.devices, servers: r.servers, serversDown: r.servers_down,
  })));
}

function handleGetConfig(req, res, coreApi) {
  res.json({ lowFreeWarn: lowFreeWarn(coreApi), lowFreePct: lowFreePct(coreApi) });
}

function handlePutConfig(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  if (b.lowFreeWarn !== undefined) {
    const n = parseIntStrict(b.lowFreeWarn);
    if (!Number.isInteger(n) || n < 1 || n > 10000) errors.push(fail('lowFreeWarn'));
  }
  if (b.lowFreePct !== undefined) {
    const n = parseIntStrict(b.lowFreePct);
    if (!Number.isInteger(n) || n < 1 || n > 90) errors.push(fail('lowFreePct'));
  }
  if (errors.length) return badRequest(res, errors);

  if (b.lowFreeWarn !== undefined) coreApi.settings.setSetting('bluecat_low_free_warn', String(parseIntStrict(b.lowFreeWarn)));
  if (b.lowFreePct !== undefined) coreApi.settings.setSetting('bluecat_low_free_pct', String(parseIntStrict(b.lowFreePct)));
  res.json({ lowFreeWarn: lowFreeWarn(coreApi), lowFreePct: lowFreePct(coreApi) });
}

// -- AI Advisor ---------------------------------------------------------------

let advisorInstance = null;
function getAdvisor(coreApi) {
  if (!advisorInstance) advisorInstance = createBluecatAdvisor(coreApi);
  return advisorInstance;
}

function advisorReportKey(slug) {
  return String(slug).replace(/-/g, '_');
}

// The built-in's 503 message contains a literal U+2192 RIGHTWARDS ARROW
// ("Settings -> Credentials"). This source file must stay pure ASCII, so
// the codepoint is built at runtime with String.fromCharCode - the emitted
// JSON string still matches the built-in byte-for-byte.
const ARROW = String.fromCharCode(8594);
const LLM_NOT_CONFIGURED_MSG = `AI analysis is not configured. Add an OpenAI or GitHub Models token under Settings ${ARROW} Credentials.`;

/** GET /advisor/:report - cached BlueCat AI Advisor report. */
function handleGetAdvisorReport(req, res, coreApi) {
  if (!isNonEmptyString(req.params.report)) return badRequest(res, [fail('report')]);
  const advisor = getAdvisor(coreApi);
  const key = advisorReportKey(req.params.report);
  if (!advisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
  res.json({ enabled: advisor.isConfigured(), report: advisor.getCachedReport(key) });
}

/** POST /advisor/:report - (re)generate and cache a BlueCat AI Advisor report. */
async function handlePostAdvisorReport(req, res, coreApi) {
  if (!isNonEmptyString(req.params.report)) return badRequest(res, [fail('report')]);
  const advisor = getAdvisor(coreApi);
  const key = advisorReportKey(req.params.report);
  if (!advisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
  try {
    const result = await advisor.generateReport(key);
    res.json(result);
  } catch (err) {
    if (err.code === 'LLM_NOT_CONFIGURED') {
      return res.status(503).json({ error: LLM_NOT_CONFIGURED_MSG });
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

// -- route table ----------------------------------------------------------------

const ROUTES = [
  { method: 'GET', ...compile('/sources'), handler: handleGetSources },
  { method: 'POST', ...compile('/sources'), handler: handlePostSources },
  { method: 'PUT', ...compile('/sources/:id'), handler: handlePutSource },
  { method: 'DELETE', ...compile('/sources/:id'), handler: handleDeleteSource },
  { method: 'POST', ...compile('/sources/test'), handler: handlePostSourcesTest },
  { method: 'POST', ...compile('/sources/:id/test'), handler: handlePostSourceTest },
  { method: 'POST', ...compile('/sources/:id/poll'), handler: handlePostSourcePoll },
  { method: 'POST', ...compile('/sources/:id/enumerate'), handler: handlePostSourceEnumerate },
  { method: 'GET', ...compile('/sources/:id/probe'), handler: handleGetSourceProbe },
  { method: 'GET', ...compile('/overview'), handler: handleGetOverview },
  { method: 'GET', ...compile('/views'), handler: handleGetViews },
  { method: 'GET', ...compile('/zones'), handler: handleGetZones },
  { method: 'GET', ...compile('/records'), handler: handleGetRecords },
  { method: 'GET', ...compile('/records/lookup'), handler: handleGetRecordsLookup },
  { method: 'GET', ...compile('/blocks'), handler: handleGetBlocks },
  { method: 'GET', ...compile('/networks'), handler: handleGetNetworks },
  { method: 'GET', ...compile('/networks/:id'), handler: handleGetNetworkById },
  { method: 'PUT', ...compile('/networks/:id/override'), handler: handlePutNetworkOverride },
  { method: 'DELETE', ...compile('/networks/:id/override'), handler: handleDeleteNetworkOverride },
  { method: 'GET', ...compile('/ranges'), handler: handleGetRanges },
  { method: 'GET', ...compile('/addresses'), handler: handleGetAddresses },
  { method: 'GET', ...compile('/devices'), handler: handleGetDevices },
  { method: 'GET', ...compile('/servers'), handler: handleGetServers },
  { method: 'GET', ...compile('/issues'), handler: handleGetIssues },
  { method: 'GET', ...compile('/issue-history'), handler: handleGetIssueHistory },
  { method: 'GET', ...compile('/trends'), handler: handleGetTrends },
  { method: 'GET', ...compile('/config'), handler: handleGetConfig },
  { method: 'PUT', ...compile('/config'), handler: handlePutConfig },
  { method: 'GET', ...compile('/advisor/:report'), handler: handleGetAdvisorReport },
  { method: 'POST', ...compile('/advisor/:report'), handler: handlePostAdvisorReport },
];

// createRouter must return a BARE (req, res, next) function - installed
// plugins are loaded via require() on their own dist/backend/index.cjs and
// cannot require the host's copy of express, so express Router instances are
// off the table. Matches req.method + req.path by hand against the table
// above; req.query/req.body are still parsed by the host's express pipeline
// before this middleware runs.
function createRouter(coreApi) {
  return function bluecatRouter(req, res, next) {
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
