// LogicMonitor load balancer model (derived platforms, round 1). Moved out of routes/logicmonitor.js so the
// LogicMonitor routes (vendorKey null: role load-balancer, vendor F5 or loadbalancer metrics, as before) and
// the F5 platform (vendorKey 'f5', through the connector feed) assemble the same rows and the same 360 payload.
// Every function takes the db handle; nothing here writes. Also exports the shared device row shape
// (lookups, DEVICE_SELECT, deviceOut) that the connector feeds reuse.
const lmIssues = require('./logicmonitorIssues');

// ---- Shared device row shape (same as routes/logicmonitor.js deviceOut) ----------------------

const parseJson = (s, fallback) => {
  if (s == null || s === '') return fallback;
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch { return fallback; }
};
const parseArr = (s) => { const v = parseJson(s, []); return Array.isArray(v) ? v : []; };

/** SQLite zoneless "YYYY-MM-DD HH:MM:SS" is UTC; return ISO with a zone. */
function sqlIso(val) {
  if (!val) return null;
  const s = String(val);
  const d = new Date(/[TZ]/.test(s) || /[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
const likePat = (q) => `%${String(q).replace(/[%_\\]/g, '\\$&')}%`;
const nowSec = () => Math.floor(Date.now() / 1000);

// alertStatus "unconfirmed-critical-none": slot 1 ack, slot 2 severity.
function alertSlots(s) {
  const parts = String(s || 'none').toLowerCase().split('-');
  const sev = ['critical', 'error', 'warn'].includes(parts[1]) ? parts[1] : null;
  return { severity: sev, acked: sev ? parts[0] === 'confirmed' : false };
}
// sdtStatus "none-none-none": any non-none slot means in SDT.
function inSdt(s) {
  if (!s) return false;
  return String(s).toLowerCase().split('-').some((p) => p && p !== 'none');
}

function lookups(db) {
  const groups = new Map();
  for (const g of db.prepare('SELECT source_id, lm_group_id, full_path, name FROM lm_device_groups').all()) {
    groups.set(`${g.source_id}:${g.lm_group_id}`, g.full_path || g.name);
  }
  const collectors = new Map();
  for (const c of db.prepare('SELECT source_id, collector_id, hostname, description, is_down, build FROM lm_collectors').all()) {
    collectors.set(`${c.source_id}:${c.collector_id}`, c);
  }
  const sources = new Map(db.prepare('SELECT id, name, features_json FROM lm_sources').all().map((s) => [s.id, s]));
  return { groups, collectors, sources };
}

const DEVICE_SELECT = `
  SELECT d.*, s.name AS source_name,
    COALESCE(c.hostname, c.description, d.collector_description) AS collector_name,
    (SELECT COUNT(*) FROM lm_alerts a WHERE a.source_id = d.source_id AND a.lm_device_id = d.lm_device_id AND a.cleared = 0) AS open_alerts
  FROM lm_devices d
  JOIN lm_sources s ON s.id = d.source_id
  LEFT JOIN lm_collectors c ON c.source_id = d.source_id AND c.collector_id = d.collector_id
`;

function deviceOut(r, lk) {
  const slots = alertSlots(r.alert_status);
  return {
    id: r.lm_device_id,
    sourceId: r.source_id,
    sourceName: r.source_name,
    name: r.name,
    displayName: r.display_name,
    vendor: r.vendor,
    role: r.role,
    model: r.model,
    version: r.version,
    hostStatus: r.host_status,
    alertStatus: r.alert_status,
    alertSeverity: slots.severity,
    acked: slots.acked,
    inSdt: inSdt(r.sdt_status),
    collectorId: r.collector_id,
    collectorName: r.collector_name || null,
    groups: parseArr(r.group_ids_json).map((g) => lk.groups.get(`${r.source_id}:${g}`)).filter(Boolean),
    ifCount: r.if_count || 0,
    ifUp: r.if_up || 0,
    openAlerts: r.open_alerts || 0,
    uptimeSeconds: r.uptime_seconds,
    isNetwork: Number(r.is_network) === 1,
    firstSeen: sqlIso(r.first_seen),
    siteKey: r.site_key || null,
    siteName: r.site_name || null,
    tier: r.tier == null ? null : r.tier,
  };
}

const devBase = (r, lk) => {
  const o = deviceOut(r, lk);
  return {
    deviceId: o.id, sourceId: o.sourceId, deviceName: o.displayName || o.name, siteKey: o.siteKey, siteName: o.siteName,
    vendor: o.vendor, model: o.model, version: o.version, hostStatus: o.hostStatus,
  };
};

/** Open reconciled issues (the engine runs only in the poller), worst first. */
function openIssues(db) {
  return db.prepare(`
    SELECT issue_key, source, severity, type, target, message, first_seen, last_seen
    FROM lm_issue_history
    WHERE status = 'open'
    ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 WHEN 'info' THEN 2 ELSE 3 END,
             last_seen DESC
  `).all().map((r) => ({
    severity: r.severity, type: r.type, source: r.source, target: r.target, message: r.message,
    issueKey: r.issue_key, firstSeen: sqlIso(r.first_seen), lastSeen: sqlIso(r.last_seen),
  }));
}

// ---- Load balancer rows ---------------------------------------------------------------------

const LB_WHERE = `(d.role = 'load-balancer' OR d.vendor = 'F5' OR EXISTS (
  SELECT 1 FROM lm_ds_metrics m WHERE m.source_id = d.source_id AND m.lm_device_id = d.lm_device_id AND m.family = 'loadbalancer'))`;

const rnd1 = (v) => (v == null ? null : Math.round(Number(v) * 10) / 10);
const epochToIso = (e) => (e == null || !Number.isFinite(Number(e)) ? null : new Date(Number(e) * 1000).toISOString());
// Round 12: a percent outside 0..100 is a wrong catalog pick, never shown as a number.
const pctOnly = (v) => (v == null || !Number.isFinite(Number(v)) || v < 0 || v > 100 ? null : rnd1(v));
/** Raw numeric -> text for an enum with a name table; unknown values render as the number. */
const enumText = (table, v) => (v == null ? null : (table[Math.round(v)] != null ? table[Math.round(v)] : String(Math.round(v))));
// F5 sysCmSyncStatus (UNVERIFIED numbering).
const SYNC_TEXT = { 0: 'unknown', 1: 'syncing', 2: 'needs manual sync', 3: 'in sync', 4: 'changes pending', 5: 'standalone', 6: 'awaiting initial sync', 7: 'incompatible version', 8: 'partial sync' };
const availText = (v) => { const s = lmIssues.availState(v); return s === 'unknown' && v != null ? String(Math.round(v)) : s; };

/** Open computed issues that name this device (target is the device or starts with "<device> "). */
function issuesOnDevice(issues, name) {
  const n = String(name || '');
  return issues.filter((i) => {
    const t = String(i.target || '');
    return t === n || t.startsWith(`${n} `) || (t.includes(' + ') && t.split(' + ').includes(n));
  });
}
function stateFromIssues(devIssues, hasData) {
  if (devIssues.some((i) => i.severity === 'critical')) return 'critical';
  if (devIssues.some((i) => i.severity === 'warning')) return 'warning';
  return hasData ? 'ok' : 'unknown';
}
const maxEpoch = (dev) => {
  let best = null;
  for (const inst of dev.instances.values()) for (const m of Object.values(inst.m)) if (m.epoch != null && (best == null || m.epoch > best)) best = m.epoch;
  return best;
};

function memberName(key, pool) {
  const k = String(key || '').replace(/^\/+/, '').replace(/^Common\//i, '');
  return k.length > pool.length + 1 ? k.slice(pool.length + 1) : k;
}

function historySeries(db, sourceId, deviceId, hdsId, key, metric, hours) {
  const since = nowSec() - Math.max(1, Number(hours) || 24) * 3600;
  return db.prepare(`
    SELECT sampled_at_epoch epoch, value FROM lm_ds_metrics_history
    WHERE source_id = ? AND lm_device_id = ? AND hds_id = ? AND instance_key = ? AND metric = ? AND sampled_at_epoch >= ?
    ORDER BY sampled_at_epoch
  `).all(sourceId, deviceId, hdsId, key, metric, since);
}
/** History of the first instance of a device that carries the metric ([] when none). */
function deviceSeries(db, dev, metric, hours = 24) {
  const hit = lmIssues.devInstances(dev, metric)[0];
  return hit ? historySeries(db, dev.sourceId, dev.deviceId, hit.hds, hit.key, metric, hours) : [];
}

const rowsOf = (dev, metric) => (dev ? lmIssues.devInstances(dev, metric) : []);
const num = (inst, metric) => (inst.m[metric] ? inst.m[metric].value : null);

function lbRow(r, lk, dev, issues, certWarn) {
  const L = lmIssues;
  const dv = dev || { instances: new Map(), sourceId: r.source_id, deviceId: r.lm_device_id, name: r.display_name || r.name };
  const name = r.display_name || r.name;
  const foRaw = L.devVal(dv, 'failover_state');
  const syncRaw = L.devVal(dv, 'sync_state');
  const pools = new Map();
  for (const i of L.devInstances(dv, 'member_avail')) {
    const p = L.poolOf(i.key);
    const e = pools.get(p) || { total: 0, down: 0 };
    e.total += 1;
    if (L.availState(i.m.member_avail.value) === 'down') e.down += 1;
    pools.set(p, e);
  }
  const wide = L.devInstances(dv, 'wideip_avail');
  const vips = L.devInstances(dv, 'vip_avail');
  const down = (list, metric) => list.filter((i) => L.availState(i.m[metric].value) === 'down').length;
  const devIssues = issuesOnDevice(issues, name);
  const hasData = dv.instances.size > 0;
  return {
    ...devBase(r, lk),
    failoverState: foRaw == null ? null : Math.round(foRaw),
    failoverText: foRaw == null ? null : L.failoverText(foRaw),
    syncState: enumText(SYNC_TEXT, syncRaw),
    cpuPct: pctOnly(L.devVal(dv, 'cpu_pct')),
    memPct: pctOnly(L.devVal(dv, 'mem_pct') ?? L.devVal(dv, 'host_mem_pct')),
    clientConnections: L.devVal(dv, 'client_connections'),
    serverConnections: L.devVal(dv, 'server_connections'),
    pools: pools.size,
    poolsDegraded: [...pools.values()].filter((e) => e.down > 0).length,
    membersTotal: [...pools.values()].reduce((s, e) => s + e.total, 0),
    membersDown: [...pools.values()].reduce((s, e) => s + e.down, 0),
    wideIps: wide.length,
    wideIpsDown: down(wide, 'wideip_avail'),
    vips: vips.length,
    vipsDown: down(vips, 'vip_avail'),
    daemonsDown: L.devInstances(dv, 'daemon_state').filter((i) => Math.round(i.m.daemon_state.value) !== 1).length
      + L.devInstances(dv, 'daemon_exit').filter((i) => i.m.daemon_exit.value != null && Math.round(i.m.daemon_exit.value) !== 0).length,
    certsExpiring: L.devInstances(dv, 'cert_days_left').filter((i) => i.m.cert_days_left.value < certWarn).length,
    state: stateFromIssues(devIssues, hasData),
    sampledAt: epochToIso(maxEpoch(dv)),
  };
}

/** Device rows for the load balancer selector: vendorKey null = the LogicMonitor rule, else that vendor key. */
function lbDevices(db, { vendorKey, q, siteKey, sourceId } = {}) {
  const where = ['d.stale = 0'];
  const params = [];
  if (vendorKey) { where.push('d.vendor_key = ?'); params.push(String(vendorKey)); } else where.push(LB_WHERE);
  if (q) {
    where.push("(d.display_name LIKE ? ESCAPE '\\' OR d.name LIKE ? ESCAPE '\\' OR d.model LIKE ? ESCAPE '\\' OR d.ips_json LIKE ? ESCAPE '\\')");
    const p = likePat(q);
    params.push(p, p, p, p);
  }
  if (siteKey) { where.push('d.site_key = ?'); params.push(String(siteKey)); }
  if (sourceId) { where.push('d.source_id = ?'); params.push(Number(sourceId)); }
  return db.prepare(`${DEVICE_SELECT} WHERE ${where.join(' AND ')} ORDER BY d.display_name, d.source_id`).all(...params);
}

/** Load balancer rows (the GET /load-balancers shape). */
function listLoadBalancers(db, { vendorKey = null, q = null, siteKey = null, sourceId = null, state = null } = {}) {
  const lk = lookups(db);
  const devs = lbDevices(db, { vendorKey, q, siteKey, sourceId });
  const index = lmIssues.loadDsIndex(db, { families: ['loadbalancer', 'health'], devices: devs });
  const issues = openIssues(db);
  const certWarn = lmIssues.getThreshold('lm_cert_warn_days');
  let rows = devs.map((r) => lbRow(r, lk, index.get(`${r.source_id}:${r.lm_device_id}`), issues, certWarn));
  if (state) rows = rows.filter((r) => r.state === state);
  return rows;
}

/** The load balancer 360 payload (the GET /load-balancers/:deviceId shape), or null when the device is not one. */
function loadBalancerDetail(db, { deviceId, sourceId = null, vendorKey = null, page = 1, limit = 50 } = {}) {
  const args = [Number(deviceId)];
  let extra = '';
  if (sourceId) { extra = ' AND d.source_id = ?'; args.push(Number(sourceId)); }
  const sel = vendorKey ? 'd.vendor_key = ?' : LB_WHERE;
  if (vendorKey) args.splice(1, 0, String(vendorKey));
  const r = db.prepare(`${DEVICE_SELECT} WHERE d.lm_device_id = ? AND d.stale = 0 AND ${sel}${extra} ORDER BY d.source_id LIMIT 1`).get(...args) || null;
  if (!r) return null;
  const L = lmIssues;
  const lk = lookups(db);
  const idx = L.loadDsIndex(db, { sourceId: r.source_id, deviceId: r.lm_device_id });
  const dev = idx.get(`${r.source_id}:${r.lm_device_id}`) || { instances: new Map(), sourceId: r.source_id, deviceId: r.lm_device_id, name: r.display_name || r.name };
  const issues = openIssues(db);
  const certWarn = L.getThreshold('lm_cert_warn_days');
  const summary = lbRow(r, lk, dev, issues, certWarn);
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  const availOut = (i, metric) => ({ avail: availText(num(i, metric)), availRaw: num(i, metric) });

  // Pool = instance key text before the first '/' or ':' (an assumption, see poolOf).
  const poolMap = new Map();
  for (const i of rowsOf(dev, 'member_avail')) {
    const p = L.poolOf(i.key);
    if (!poolMap.has(p)) poolMap.set(p, { pool: p, members: [], up: 0, down: 0 });
    const e = poolMap.get(p);
    const st = L.availState(num(i, 'member_avail'));
    if (st === 'down') e.down += 1; else if (st === 'up' || st === 'warn') e.up += 1;
    e.members.push({
      member: memberName(i.key, p), key: i.key, ...availOut(i, 'member_avail'),
      enabled: i.m.member_enabled ? Math.round(i.m.member_enabled.value) === 1 : null, connections: num(i, 'member_connections'),
    });
  }
  const pools = [...poolMap.values()].map((e) => ({ ...e, members: e.members.sort((a, b) => a.member.localeCompare(b.member)) }))
    .sort((a, b) => (b.down - a.down) || a.pool.localeCompare(b.pool));

  const wideIps = rowsOf(dev, 'wideip_avail').map((i) => ({ name: i.name, ...availOut(i, 'wideip_avail'), requests: num(i, 'wideip_requests') })).sort(byName);
  const vipAll = rowsOf(dev, 'vip_avail').map((i) => ({
    name: i.name, ...availOut(i, 'vip_avail'), enabled: i.m.vip_enabled ? Math.round(i.m.vip_enabled.value) === 1 : null,
  })).sort(byName);
  const lim = limit === 'all' ? 500 : (parseInt(limit, 10) || 50);
  const pg = Math.max(1, parseInt(page, 10) || 1);
  const offset = (pg - 1) * lim;
  const gtmServers = rowsOf(dev, 'gtm_server_avail').map((i) => ({ name: i.name, ...availOut(i, 'gtm_server_avail') })).sort(byName);
  const datacenters = rowsOf(dev, 'dc_avail').map((i) => ({ name: i.name, ...availOut(i, 'dc_avail') })).sort(byName);
  const daemons = rowsOf(dev, 'daemon_state').map((i) => ({ name: i.name, state: Math.round(num(i, 'daemon_state')) === 1 ? 'running' : 'down', raw: num(i, 'daemon_state') }))
    .concat(rowsOf(dev, 'daemon_exit').map((i) => ({ name: i.name, state: num(i, 'daemon_exit') == null || Math.round(num(i, 'daemon_exit')) === 0 ? 'running' : 'down', raw: num(i, 'daemon_exit') })))
    .sort(byName);
  const certs = rowsOf(dev, 'cert_days_left').map((i) => ({ name: i.name, daysLeft: rnd1(num(i, 'cert_days_left')) })).sort((a, b) => a.daysLeft - b.daysLeft);
  const hardware = {
    fans: rowsOf(dev, 'fan_state').concat(rowsOf(dev, 'f5os_fan_state')).map((i) => ({ name: i.name, state: num(i, 'fan_state') ?? num(i, 'f5os_fan_state') })).sort(byName),
    psus: rowsOf(dev, 'psu_state').map((i) => ({ name: i.name, state: num(i, 'psu_state'), ok: !L.stateIsFault(num(i, 'psu_state')) })).sort(byName),
    temps: rowsOf(dev, 'temp_c').concat(rowsOf(dev, 'f5os_temp_c')).map((i) => ({ name: i.name, tempC: rnd1(num(i, 'temp_c') ?? num(i, 'f5os_temp_c')) })).sort(byName),
    filesystems: rowsOf(dev, 'fs_used_pct').map((i) => ({ name: i.name, usedPct: rnd1(num(i, 'fs_used_pct')) })).sort(byName),
    tmmMemPct: pctOnly(L.devVal(dev, 'tmm_mem_pct')),
    // F5_BigIP_Memory carries byte counts only (RealMemTotal, RealMemAvailable), so the host
    // percent is derived when the pick is absent.
    hostMemPct: pctOnly(L.devVal(dev, 'host_mem_pct') ?? (() => {
      const total = L.devVal(dev, 'mem_total_bytes');
      const avail = L.devVal(dev, 'mem_avail_bytes');
      return total > 0 && avail != null ? (100 * (1 - avail / total)) : null;
    })()),
  };
  // Round 12: F5_BigIP_Interfaces has no status datapoint and reports bytes per second; bps = bytes x 8.
  const bitsOf = (v) => (v == null ? null : Math.round(v * 8));
  const interfaces = [...new Map([...rowsOf(dev, 'if_status'), ...rowsOf(dev, 'if_in_bytes')].map((i) => [i.name, i])).values()]
    .map((i) => ({ name: i.name, status: num(i, 'if_status'), inBps: num(i, 'if_in_bps') ?? bitsOf(num(i, 'if_in_bytes')), outBps: num(i, 'if_out_bps') ?? bitsOf(num(i, 'if_out_bytes')) })).sort(byName);
  return {
    device: deviceOut(r, lk),
    summary,
    pools,
    wideIps,
    vips: { items: vipAll.slice(offset, offset + lim), total: vipAll.length, page: pg, limit: lim },
    gtmServers,
    datacenters,
    daemons,
    certs,
    hardware,
    interfaces,
    cpuHistory: deviceSeries(db, dev, 'cpu_pct', 24),
    connectionsHistory: { client: deviceSeries(db, dev, 'client_connections', 24), server: deviceSeries(db, dev, 'server_connections', 24) },
    issues: issuesOnDevice(issues, r.display_name || r.name),
  };
}

module.exports = {
  // load balancer model
  listLoadBalancers, loadBalancerDetail, lbRow, LB_WHERE,
  // shared device row shape for the connector feeds
  lookups, DEVICE_SELECT, deviceOut, openIssues, issuesOnDevice, stateFromIssues, sqlIso, alertSlots, inSdt, likePat, parseJson, parseArr,
};
