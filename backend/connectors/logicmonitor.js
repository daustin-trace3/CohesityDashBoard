// LogicMonitor CONNECTOR (derived platforms, round 1). Host side, registered at boot by core whether LM
// runs as the built-in or as an installed pack (the pack adopts the same lm_* tables). It exposes the stored
// LogicMonitor rows as named read-only FEEDS: fn(db, params) -> rows. A derived platform such as F5 reads
// only through these feeds, never through lm_* SQL, which is the seam Splunk and Datadog plug into later.
// Nothing here writes. Every feed tolerates a missing table (an older tenant that never ran the LM
// migrations) by answering an empty value. Row shapes follow routes/logicmonitor.js.
// Feeds: devices, device, alerts, issues, issueHistory, configChanges, metrics, datasources, health, loadBalancers,
// loadBalancer, firewalls, firewall, wirelessOverview, wirelessControllers, wirelessController, wirelessAps,
// wirelessAp, wirelessRf, wirelessSsids, voice, voiceDevice, ise, iseNode, vendorCensus, sources, presence.
// The family feeds take { vendorKeys, q, siteKey, sourceId, state, kind, deviceId, controllerId, apKey }.
const { memoByDbState } = require('../core/dbMemo');
const lmLb = require('../services/logicmonitorLoadBalancers');
const lmVendors = require('../services/logicmonitorVendors');

const CONNECTOR_ID = 'logicmonitor';
const { DEVICE_SELECT, deviceOut, lookups, sqlIso, parseJson, likePat } = lmLb;

const lmFirewalls = () => require('../services/logicmonitorFirewalls');
const lmWireless = () => require('../services/logicmonitorWireless');
const lmVoice = () => require('../services/logicmonitorVoice');
const lmIse = () => require('../services/logicmonitorIse');
const lmGroups = () => require('../services/logicmonitorGroups');
const lmCatalog = () => require('../services/logicmonitorCatalog');
const lmRaw = () => require('../services/logicmonitorRaw');

const epochIso = (v) => {
  if (v == null || v === '' || !Number.isFinite(Number(v)) || Number(v) <= 0) return null;
  const n = Number(v);
  return new Date(n > 1e11 ? n : n * 1000).toISOString();
};
const asInt = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const guard = (fallback, fn) => (db, params) => {
  try { return fn(db, params || {}); } catch (err) {
    if (/no such (table|column)/i.test(String(err && err.message))) return typeof fallback === 'function' ? fallback() : fallback;
    throw err;
  }
};

// ---- Row shapes ----------------------------------------------------------------------------

function alertOut(a) {
  return {
    id: a.lm_alert_id,
    sourceId: a.source_id,
    internalId: a.internal_id,
    type: a.type,
    severity: a.severity,
    severityNorm: a.severity_norm,
    deviceId: a.lm_device_id,
    monitorObjectName: a.monitor_object_name,
    datasource: a.resource_template_name,
    instanceName: a.instance_name,
    dataPointName: a.data_point_name,
    alertValue: a.alert_value,
    threshold: a.threshold,
    startedAt: epochIso(a.start_epoch),
    endedAt: epochIso(a.end_epoch),
    acked: Number(a.acked) === 1,
    ackedBy: a.acked_by,
    ackComment: a.ack_comment,
    sdted: Number(a.sdted) === 1,
    suppressor: a.suppressor,
    cleared: Number(a.cleared) === 1,
    rule: a.rule,
    chain: a.chain,
    anomaly: Number(a.anomaly) === 1,
    conditionKey: a.condition_key,
    shadowedBy: parseJson(a.shadowed_by, null),
    duplicateOf: a.duplicate_of || null,
    ingest: a.ingest || null,
  };
}

/** The deviceOut shape plus ICC's vendor classification and the rolled up device state. */
function deviceRow(r, lk, states) {
  const st = states ? states.get(`${r.source_id}:${r.lm_device_id}`) : null;
  return {
    ...deviceOut(r, lk),
    vendorKey: r.vendor_key || null,
    vendorKind: r.vendor_kind || null,
    vendorReason: r.vendor_reason || null,
    state: st ? st.state : 'unknown',
    reasons: st ? st.reasons : [],
  };
}

const STATE_ALIAS = { critical: 'failed', warning: 'degraded' };

// ---- Feeds ---------------------------------------------------------------------------------

function devices(db, params) {
  const where = ['d.stale = 0'];
  const args = [];
  if (params.vendorKey) { where.push('d.vendor_key = ?'); args.push(String(params.vendorKey)); }
  if (params.vendorKind) { where.push('d.vendor_kind = ?'); args.push(String(params.vendorKind)); }
  if (params.sourceId != null && params.sourceId !== '') { where.push('d.source_id = ?'); args.push(Number(params.sourceId)); }
  if (params.siteKey) { where.push('d.site_key = ?'); args.push(String(params.siteKey)); }
  if (params.q) {
    where.push("(d.display_name LIKE ? ESCAPE '\\' OR d.name LIKE ? ESCAPE '\\' OR d.model LIKE ? ESCAPE '\\' OR d.ips_json LIKE ? ESCAPE '\\')");
    const p = likePat(params.q);
    args.push(p, p, p, p);
  }
  const rows = db.prepare(`${DEVICE_SELECT} WHERE ${where.join(' AND ')} ORDER BY d.display_name, d.source_id, d.lm_device_id`).all(...args);
  const lk = lookups(db);
  let states = null;
  try { states = lmGroups().deviceStates(db, { sourceId: params.sourceId != null && params.sourceId !== '' ? Number(params.sourceId) : null }); } catch { states = null; }
  let out = rows.map((r) => deviceRow(r, lk, states));
  if (params.state) {
    const want = STATE_ALIAS[params.state] || params.state;
    out = out.filter((d) => d.state === want);
  }
  return out;
}

function device(db, params) {
  const id = asInt(params.deviceId);
  if (id == null) return null;
  const args = [id];
  let extra = '';
  if (params.sourceId != null && params.sourceId !== '') { extra = ' AND d.source_id = ?'; args.push(Number(params.sourceId)); }
  const r = db.prepare(`${DEVICE_SELECT} WHERE d.lm_device_id = ?${extra} ORDER BY d.stale ASC, d.source_id ASC LIMIT 1`).get(...args);
  if (!r) return null;
  let states = null;
  try { states = lmGroups().deviceStates(db, { sourceId: r.source_id }); } catch { states = null; }
  return deviceRow(r, lookups(db), states);
}

const ALERT_CAP = 2000;

function alerts(db, params) {
  const where = ['a.cleared = ?'];
  const args = [params.open === false ? 1 : 0];
  // Same default as GET /alerts: alerts that relay a feed ICC polls directly stay out.
  where.push('a.duplicate_of IS NULL');
  if (params.vendorKey) { where.push('d.vendor_key = ?'); args.push(String(params.vendorKey)); }
  if (Array.isArray(params.deviceIds) && params.deviceIds.length) {
    const ids = params.deviceIds.map(Number).filter(Number.isFinite);
    if (!ids.length) return [];
    where.push(`a.lm_device_id IN (${ids.map(() => '?').join(',')})`);
    args.push(...ids);
  }
  if (params.sourceId != null && params.sourceId !== '') { where.push('a.source_id = ?'); args.push(Number(params.sourceId)); }
  const join = 'JOIN lm_devices d ON d.source_id = a.source_id AND d.lm_device_id = a.lm_device_id AND d.stale = 0';
  return db.prepare(`
    SELECT a.* FROM lm_alerts a ${join} WHERE ${where.join(' AND ')}
    ORDER BY a.start_epoch DESC NULLS LAST, a.id ASC LIMIT ${ALERT_CAP}
  `).all(...args).map(alertOut);
}

/** Name index of the non-stale devices of one vendor key (optionally limited to device ids) for target resolution. */
function vendorNameIndex(db, vendorKey, ids) {
  const where = ['stale = 0'];
  const args = [];
  if (vendorKey) { where.push('vendor_key = ?'); args.push(String(vendorKey)); }
  const devs = db.prepare(`SELECT name, display_name, lm_device_id FROM lm_devices WHERE ${where.join(' AND ')}`).all(...args)
    .filter((d) => !ids || ids.has(d.lm_device_id));
  const idx = { byName: new Map(), anyName: new Map() };
  for (const d of devs) {
    for (const n of [d.display_name, d.name]) {
      if (n && !idx.anyName.has(String(n).toLowerCase())) idx.anyName.set(String(n).toLowerCase(), 'hit');
    }
  }
  return idx;
}

/** { issues, asOf } (the GET /logicmonitor/issues shape): open rows whose device-scoped type lands on a device of the vendor. */
function issues(db, params) {
  const rows = lmLb.openIssues(db);
  let asOf = null;
  const open = db.prepare("SELECT MAX(last_seen) AS t FROM lm_issue_history WHERE status = 'open'").get();
  if (open && open.t) asOf = sqlIso(open.t);
  else {
    const res = db.prepare('SELECT MAX(resolved_at) AS t FROM lm_issue_history WHERE resolved_at IS NOT NULL').get();
    asOf = res && res.t ? sqlIso(res.t) : null;
  }
  const ids = Array.isArray(params.deviceIds) ? new Set(params.deviceIds.map(Number).filter(Number.isFinite)) : null;
  if (!params.vendorKey && !ids) return { issues: rows, asOf };
  const idx = vendorNameIndex(db, params.vendorKey, ids);
  const kept = rows.filter((i) => lmVendors.isDeviceScopedIssueType(i.type) && lmVendors.resolveTarget(idx, null, i.target));
  return { issues: kept, asOf };
}

/**
 * The GET /logicmonitor/issue-history rows (BARE ARRAY, raw snake_case columns plus camelCase twins, ISO times).
 * vendorKey keeps only device scoped rows whose target resolves to a device of that key. days (default 30,
 * max 90), type, severity and q filter; page and limit page the result when given.
 */
function issueHistory(db, params) {
  const days = Math.min(90, Math.max(1, asInt(params.days) || 30));
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const where = ["(status = 'open' OR datetime(last_seen) >= datetime(?))"];
  const args = [since];
  if (params.type) { where.push('type = ?'); args.push(String(params.type)); }
  if (params.severity) { where.push('severity = ?'); args.push(String(params.severity)); }
  if (params.q) {
    where.push("(target LIKE ? ESCAPE '\\' OR message LIKE ? ESCAPE '\\' OR type LIKE ? ESCAPE '\\')");
    const pat = likePat(params.q);
    args.push(pat, pat, pat);
  }
  let rows = db.prepare(`
    SELECT * FROM lm_issue_history WHERE ${where.join(' AND ')}
    ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, datetime(last_seen) DESC
  `).all(...args);
  if (params.vendorKey) {
    const idx = vendorNameIndex(db, params.vendorKey, null);
    rows = rows.filter((r) => lmVendors.isDeviceScopedIssueType(r.type) && lmVendors.resolveTarget(idx, null, r.target));
  }
  if (params.limit != null && params.limit !== '') {
    const lim = Math.max(1, Math.min(500, asInt(params.limit) || 50));
    const pg = Math.max(1, asInt(params.page) || 1);
    rows = rows.slice((pg - 1) * lim, pg * lim);
  }
  return rows.map((r) => {
    const firstSeen = sqlIso(r.first_seen);
    const lastSeen = sqlIso(r.last_seen);
    const resolvedAt = sqlIso(r.resolved_at);
    return { ...r, first_seen: firstSeen, last_seen: lastSeen, resolved_at: resolvedAt, issueKey: r.issue_key, firstSeen, lastSeen, resolvedAt };
  });
}

/**
 * config_changes rows (the config ledger, core table) whose item names a device with the vendor key: system is the
 * LM portal name, item is the device name or "device port". Newest first, cap 200, [] when the table is absent.
 */
function configChanges(db, params) {
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'config_changes'").get();
  if (!t) return [];
  const days = Math.min(365, Math.max(1, asInt(params.days) || 30));
  const portals = new Set(db.prepare('SELECT name FROM lm_sources').all().map((r) => r.name));
  const idx = params.vendorKey ? vendorNameIndex(db, params.vendorKey, null) : null;
  const rows = db.prepare('SELECT * FROM config_changes WHERE detected_at >= ? ORDER BY detected_at DESC LIMIT 5000')
    .all(new Date(Date.now() - days * 86400000).toISOString());
  const out = [];
  for (const r of rows) {
    if (!portals.has(r.system)) continue;
    if (idx && !lmVendors.resolveTarget(idx, null, r.item)) continue;
    out.push(r);
    if (out.length >= 200) break;
  }
  return out;
}

/** lookupMetrics rows for a device (newest value per instance and metric), capped at 200. */
function metrics(db, params) {
  const sourceId = asInt(params.sourceId);
  const deviceId = asInt(params.deviceId);
  if (deviceId == null) return [];
  const fams = Array.isArray(params.families) && params.families.length ? params.families.map(String).slice(0, 20) : null;
  const where = ['m.lm_device_id = ?', 'COALESCE(i.stale, 0) = 0'];
  const args = [deviceId];
  if (sourceId != null) { where.push('m.source_id = ?'); args.push(sourceId); }
  if (fams) { where.push(`m.family IN (${fams.map(() => '?').join(',')})`); args.push(...fams); }
  const rows = db.prepare(`
    SELECT m.datasource_name, m.family, m.instance_key, i.instance_name, m.metric, m.value, m.sampled_at_epoch
    FROM lm_ds_metrics m
    LEFT JOIN lm_ds_instances i ON i.source_id = m.source_id AND i.lm_device_id = m.lm_device_id
      AND i.hds_id = m.hds_id AND i.instance_key = m.instance_key
    WHERE ${where.join(' AND ')}
    ORDER BY m.family, m.datasource_name, m.instance_key, m.metric LIMIT 200
  `).all(...args);
  const cat = lmCatalog();
  return rows.map((r) => {
    const entry = cat.catalogFor(r.datasource_name);
    const def = entry && entry.metrics ? entry.metrics[r.metric] : null;
    return {
      datasource: r.datasource_name, datasourceLabel: entry ? entry.label : r.datasource_name, family: r.family,
      instanceKey: r.instance_key, instanceName: r.instance_name || r.instance_key,
      metric: r.metric, label: def ? def.label : r.metric, unit: def ? def.unit : '', kind: def ? def.kind : null,
      value: r.value, sampledAt: epochIso(r.sampled_at_epoch),
    };
  });
}

function datasources(db, params) {
  const deviceId = asInt(params.deviceId);
  if (deviceId == null) return [];
  let sourceId = asInt(params.sourceId);
  if (sourceId == null) {
    const r = db.prepare('SELECT source_id FROM lm_devices WHERE lm_device_id = ? ORDER BY stale ASC, source_id ASC LIMIT 1').get(deviceId);
    if (!r) return [];
    sourceId = r.source_id;
  }
  return lmRaw().deviceDatasources(db, lmCatalog(), sourceId, deviceId);
}

function health(db, params) {
  const deviceId = asInt(params.deviceId);
  if (deviceId == null) return null;
  const args = [deviceId];
  let extra = '';
  if (params.sourceId != null && params.sourceId !== '') { extra = ' AND d.source_id = ?'; args.push(Number(params.sourceId)); }
  const d = db.prepare(`
    SELECT d.*, c.is_down AS collector_down FROM lm_devices d
    LEFT JOIN lm_collectors c ON c.source_id = d.source_id AND c.collector_id = d.collector_id
    WHERE d.lm_device_id = ?${extra} ORDER BY d.stale ASC, d.source_id ASC LIMIT 1
  `).get(...args);
  if (!d) return null;
  const dead = d.host_status === 'dead' || d.host_status === 'dead-collector';
  return {
    hostStatus: d.host_status || null,
    deadSince: dead ? sqlIso(d.dead_since) : null,
    alertStatus: d.alert_status || null,
    collectorDown: Number(d.collector_down) === 1 || d.host_status === 'dead-collector',
    sdt: lmLb.inSdt(d.sdt_status),
  };
}

function sources(db) {
  return db.prepare(`
    SELECT s.id, s.name, s.company, s.last_poll_at, s.last_poll_status,
      (SELECT COUNT(*) FROM lm_devices d WHERE d.source_id = s.id AND d.stale = 0) AS devices
    FROM lm_sources s ORDER BY s.name
  `).all().map((s) => ({
    id: s.id, name: s.name, company: s.company, lastPollAt: sqlIso(s.last_poll_at), lastPollStatus: s.last_poll_status, devices: s.devices,
  }));
}

/** Non-stale devices holding a vendor key. Cheap COUNT, memoized per db state. */
function presence(db, params) {
  const key = params.vendorKey ? String(params.vendorKey) : '';
  return memoByDbState(db, `lmPresence|${key}`, () => {
    if (!key) return db.prepare('SELECT COUNT(*) n FROM lm_devices WHERE stale = 0 AND vendor_key IS NOT NULL').get().n;
    return db.prepare('SELECT COUNT(*) n FROM lm_devices WHERE stale = 0 AND vendor_key = ?').get(key).n;
  });
}

const registryOf = () => { try { return require('../core/registry'); } catch { return null; } };

function buildCensus(db) {
  const reg = registryOf();
  const platformFor = (key) => {
    if (!key) return null;
    let p = null;
    try { p = reg && typeof reg.derivedPlatformFor === 'function' ? reg.derivedPlatformFor(key) : null; } catch { p = null; }
    return p || 'logicmonitor';
  };
  const devs = db.prepare('SELECT source_id, lm_device_id, model, vendor_key, vendor_kind, vendor_reason FROM lm_devices WHERE stale = 0').all();
  const dsByDev = new Map();
  for (const r of db.prepare(`
    SELECT s.source_id, s.lm_device_id, s.datasource_name FROM lm_device_datasources s
    JOIN lm_devices d ON d.source_id = s.source_id AND d.lm_device_id = s.lm_device_id AND d.stale = 0
  `).all()) {
    const k = `${r.source_id}:${r.lm_device_id}`;
    let a = dsByDev.get(k);
    if (!a) { a = []; dsByDev.set(k, a); }
    a.push(r.datasource_name);
  }
  const alertCounts = new Map();
  for (const r of db.prepare(`
    SELECT d.source_id, d.lm_device_id, a.severity_norm sev, COUNT(*) n FROM lm_alerts a
    JOIN lm_devices d ON d.source_id = a.source_id AND d.lm_device_id = a.lm_device_id AND d.stale = 0
    WHERE a.cleared = 0 AND a.duplicate_of IS NULL AND a.severity_norm IN ('critical', 'warning')
    GROUP BY d.source_id, d.lm_device_id, a.severity_norm
  `).all()) alertCounts.set(`${r.source_id}:${r.lm_device_id}:${r.sev}`, r.n);

  const cat = lmCatalog();
  const groups = new Map(); // group id -> accumulator
  const unknownOid = (reason) => /^sysoid-unknown:/.test(String(reason || ''));
  for (const d of devs) {
    const gid = d.vendor_key ? d.vendor_key : (unknownOid(d.vendor_reason) ? d.vendor_reason : '');
    let g = groups.get(gid);
    if (!g) {
      g = {
        vendorKey: d.vendor_key || null, devices: 0, kinds: {}, reasons: {}, ds: new Set(), critical: 0, warning: 0, models: [],
        unknownReason: !d.vendor_key && unknownOid(d.vendor_reason) ? d.vendor_reason : null,
      };
      groups.set(gid, g);
    }
    g.devices += 1;
    if (d.vendor_kind) g.kinds[d.vendor_kind] = (g.kinds[d.vendor_kind] || 0) + 1;
    const reason = d.vendor_reason || 'none';
    g.reasons[reason] = (g.reasons[reason] || 0) + 1;
    const k = `${d.source_id}:${d.lm_device_id}`;
    for (const n of dsByDev.get(k) || []) g.ds.add(n);
    g.critical += alertCounts.get(`${k}:critical`) || 0;
    g.warning += alertCounts.get(`${k}:warning`) || 0;
    if (d.model && g.models.length < 3 && !g.models.includes(d.model)) g.models.push(d.model);
  }
  const rows = [];
  for (const g of groups.values()) {
    let matched = 0;
    for (const n of g.ds) { try { if (cat.catalogFor(n)) matched += 1; } catch { /* unmatched */ } }
    rows.push({
      vendorKey: g.vendorKey,
      label: g.vendorKey ? lmVendors.labelOf(g.vendorKey) : (g.unknownReason ? `Unknown enterprise ${g.unknownReason.split(':')[1]}` : 'Unclassified'),
      devices: g.devices,
      kinds: g.kinds,
      kindLabels: Object.fromEntries(Object.keys(g.kinds).map((k) => [k, lmVendors.kindLabelOf(k)])),
      dsNames: g.ds.size,
      dsMatched: matched,
      dsUnmatched: g.ds.size - matched,
      openAlerts: { critical: g.critical, warning: g.warning },
      platform: platformFor(g.vendorKey),
      reasons: g.reasons,
      ...(g.vendorKey ? {} : { reason: g.unknownReason, samples: g.models }),
    });
  }
  // Keyed vendors by size, then the unknown enterprise numbers, then the unclassified remainder.
  const rank = (r) => (r.vendorKey ? 0 : (r.reason ? 1 : 2));
  rows.sort((a, b) => rank(a) - rank(b) || b.devices - a.devices || String(a.label).localeCompare(String(b.label)));
  return rows;
}

const vendorCensus = (db) => memoByDbState(db, 'lmVendorCensus', () => buildCensus(db));

// ---- Family feeds (derived platforms, round 2) -----------------------------------------------

/**
 * Params for the family services: the whitelisted list filters plus the scope. A feed lists ONLY the vendor
 * keys it is asked for (vendorKeys array; a single vendorKey string is accepted; absent = every vendor) and
 * never applies the one-home-per-device exclusion, which belongs to the LogicMonitor routes.
 */
function familyParams(p) {
  const vk = Array.isArray(p.vendorKeys) ? p.vendorKeys.map(String) : (p.vendorKey ? [String(p.vendorKey)] : null);
  return {
    q: p.q, siteKey: p.siteKey, vendor: p.vendor, sourceId: p.sourceId, state: p.state, kind: p.kind,
    deviceId: p.deviceId, controllerId: p.controllerId, apKey: p.apKey,
    vendorKeys: vk, excludeOwned: false,
  };
}
const family = (fn) => (db, p) => fn(db, familyParams(p));

// ---- Registration ----------------------------------------------------------------------------

/**
 * Register every feed. `feeds` is handed in by core. Core's per-connector facade takes
 * registerFeed(feedName, fn); the module-level form takes registerFeed(connectorId, feedName, fn).
 * Both are accepted (told apart by arity) so this file works against either.
 */
function register(feeds) {
  const add = (name, fn) => {
    if (feeds.registerFeed.length >= 3) feeds.registerFeed(CONNECTOR_ID, name, fn);
    else feeds.registerFeed(name, fn);
  };
  add('devices', guard(() => [], devices));
  add('device', guard(null, device));
  add('alerts', guard(() => [], alerts));
  add('issues', guard(() => ({ issues: [], asOf: null }), issues));
  add('issueHistory', guard(() => [], issueHistory));
  add('configChanges', guard(() => [], configChanges));
  add('metrics', guard(() => [], metrics));
  add('datasources', guard(() => [], datasources));
  add('health', guard(null, health));
  add('loadBalancers', guard(() => [], (db, p) => lmLb.listLoadBalancers(db, {
    vendorKey: p.vendorKey || null, q: p.q, siteKey: p.siteKey, sourceId: p.sourceId, state: p.state,
  })));
  add('loadBalancer', guard(null, (db, p) => lmLb.loadBalancerDetail(db, {
    deviceId: p.deviceId, sourceId: p.sourceId, vendorKey: p.vendorKey || null, page: p.page, limit: p.limit,
  })));
  add('firewalls', guard(() => [], family((db, o) => lmFirewalls().listFirewalls(db, o))));
  add('firewall', guard(null, family((db, o) => lmFirewalls().firewallDetail(db, o))));
  add('wirelessOverview', guard(null, family((db, o) => lmWireless().wirelessOverview(db, o))));
  add('wirelessControllers', guard(() => [], family((db, o) => lmWireless().listControllers(db, o))));
  add('wirelessController', guard(null, family((db, o) => lmWireless().controllerDetail(db, o))));
  add('wirelessAps', guard(() => [], family((db, o) => lmWireless().listAps(db, o))));
  add('wirelessAp', guard(null, family((db, o) => { const out = lmWireless().apDetail(db, o); return out.missing ? null : out; })));
  add('wirelessRf', guard(null, family((db, o) => lmWireless().rfTable(db, o))));
  add('wirelessSsids', guard(null, family((db, o) => lmWireless().ssidTable(db, o))));
  add('voice', guard(() => [], family((db, o) => lmVoice().listVoice(db, o))));
  add('voiceDevice', guard(null, family((db, o) => lmVoice().voiceDetail(db, o))));
  add('ise', guard(() => [], family((db, o) => lmIse().listIse(db, o))));
  add('iseNode', guard(null, family((db, o) => lmIse().iseDetail(db, o))));
  add('vendorCensus', guard(() => [], (db) => vendorCensus(db)));
  add('sources', guard(() => [], sources));
  add('presence', guard(0, presence));
}

module.exports = {
  CONNECTOR_ID, register,
  // exported for the routes and tests
  vendorCensus, devices, device, alerts, issues, issueHistory, configChanges, metrics, datasources, health, sources, presence,
};
