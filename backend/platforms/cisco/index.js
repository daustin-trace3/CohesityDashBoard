// Cisco platform manifest (ICC contract: DERIVED platform, round 2 of the derived-platforms work).
// Cisco has no sources, no poller and no tables. Every read goes through the LogicMonitor connector's
// feeds (core/feeds.js, coreApi.feeds.query('logicmonitor', <feed>, params)); the one exception is the
// search category below, whose SQL routes/search.js executes itself. The platform claims two vendor keys,
// 'cisco' and 'meraki' (Meraki devices appear under Cisco with their own kinds mx, ms, mr and a Family
// column). It is present (rail, Ops card, search, notifier) only while the connector holds at least one
// device ICC classified under either key; registry.isPresent() calls presence() below.
// Brand colour #049FD9 is the Cisco blue as remembered and UNVERIFIED.
const express = require('express');
const { query, param, validationResult } = require('express-validator');
const { sendCsv: sendCsvRows } = require('../../utils/csv');
const { createCiscoAdvisor, REPORT_KEYS } = require('../../services/advisors/ciscoAdvisor');

const BRAND = '#049FD9';
const VENDORS = ['cisco', 'meraki'];
const CONNECTOR = 'logicmonitor';
const SETTINGS_PATH = '/logicmonitor/settings?section=services';
const KINDS = ['switch', 'nexus', 'router', 'firewall', 'wireless', 'ap', 'ise', 'voice', 'ucs', 'esa', 'mx', 'ms', 'mr', 'mv', 'mg', 'other'];

const p = (port, label, expect) => ({ port, label, expect });

// Same object as the services/agentProfiles/defaults.js cisco entry (that entry is the one the agent
// reads; this copy is for packs later).
const agentProfile = {
  focus: 'Catalyst and Nexus faults are usually a part: name the failed fan, power supply, line card or stack member and its chassis before blaming the network. A switch port or uplink down takes its downstream hosts with it, so check the uplink first. A WLC down drops every AP it controls: count APs before radios. ISE certificate days left and a deployment node down are the hard deadlines. ASA and Meraki MX pairs: one Active and one Standby is healthy; a degraded pair or unsynced config is the incident. A Meraki device dead in LogicMonitor can be a path or API problem, not the device.',
  ports: { source: [p(443, 'HTTPS', true)], host: [p(22, 'SSH', false), p(443, 'HTTPS', false), p(161, 'SNMP', false)] },
  evidenceBudget: { alerts: 15, failedBackupJobs: 10, networkBlocks: 3 },
  relations: ['identity_links'],
};

// ---- feed helpers ----------------------------------------------------------------------------------

/** The feeds API: coreApi.feeds when the registry passed one, else the core module. */
function feedsOf(coreApi) {
  if (coreApi && coreApi.feeds) return coreApi.feeds;
  return require('../../core/feeds');
}
const feed = (coreApi, name, params) => feedsOf(coreApi).query(CONNECTOR, name, params || {});

/** Normalise a feed answer that may be a bare array or an object wrapping one. */
const rowsOf = (v, ...keys) => {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') for (const k of keys.concat(['items', 'rows'])) if (Array.isArray(v[k])) return v[k];
  return [];
};

/** One feed call per vendor key, rows concatenated (the connector's per-key feeds take a single vendorKey). */
const perKey = (coreApi, name, params, keys, ...wrapKeys) => (keys || VENDORS).flatMap((vendorKey) => rowsOf(feed(coreApi, name, { vendorKey, ...(params || {}) }), ...wrapKeys));

const devicesOf = (coreApi, params, keys) => perKey(coreApi, 'devices', params, keys);
const alertsOf = (coreApi, params) => perKey(coreApi, 'alerts', { open: true, ...(params || {}) });
function issuesAnswer(coreApi, params) {
  let asOf = null;
  const issues = VENDORS.flatMap((vendorKey) => {
    const v = feed(coreApi, 'issues', { vendorKey, ...(params || {}) });
    if (v && !Array.isArray(v) && v.asOf && (!asOf || v.asOf > asOf)) asOf = v.asOf;
    return rowsOf(v, 'issues');
  });
  return { issues, asOf };
}
const sourcesOf = (coreApi) => rowsOf(feed(coreApi, 'sources', {}));

/** Family feed (firewalls, wireless, voice, ise) over both vendor keys. */
const family = (coreApi, name, params) => feed(coreApi, name, { vendorKeys: VENDORS, ...(params || {}) });
/** Optional family feed for the overview: a missing or failing feed counts as nothing, never an error. */
function familyOr(coreApi, name, fallback, params) {
  try { return family(coreApi, name, params); } catch (err) {
    if (err && err.code === 'FEED_UNKNOWN') return fallback;
    throw err;
  }
}

/** Matched device count over both keys; 0 on any failure so a broken connector hides the platform instead of throwing. */
function presence(coreApi) {
  try {
    let total = 0;
    for (const vendorKey of VENDORS) {
      const n = Number(feed(coreApi, 'presence', { vendorKey }));
      if (Number.isFinite(n) && n > 0) total += n;
    }
    return total;
  } catch {
    return 0;
  }
}

const SEV_RANK = { critical: 0, warning: 1, info: 2 };
const sevRank = (s) => (SEV_RANK[s] == null ? 3 : SEV_RANK[s]);
const normState = (s) => (s === 'failed' || s === 'critical' ? 'failed' : s === 'degraded' || s === 'warning' ? 'degraded' : s === 'ok' ? 'ok' : 'unknown');
const STATE_RANK = { failed: 0, degraded: 1, unknown: 2, ok: 3 };
const nameOf = (r) => r.displayName || r.deviceName || r.name || '';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;
const isBad = (s) => s === 'critical' || s === 'warning' || s === 'failed' || s === 'degraded';

const issuesWorstFirst = (list) => list.slice().sort((a, b) => sevRank(a.severity) - sevRank(b.severity)
  || String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
const withFamily = (d) => ({ ...d, family: d.vendorKey === 'meraki' ? 'Meraki' : 'Cisco' });

// ---- overview ----------------------------------------------------------------------------------------

function buildOverview(coreApi) {
  const devs = devicesOf(coreApi);
  const { issues } = issuesAnswer(coreApi);
  const alerts = alertsOf(coreApi);

  const byKind = {};
  const byFamily = { cisco: 0, meraki: 0 };
  for (const d of devs) {
    const k = d.vendorKind || 'other';
    byKind[k] = (byKind[k] || 0) + 1;
    if (d.vendorKey === 'meraki') byFamily.meraki += 1; else byFamily.cisco += 1;
  }
  const states = devs.map((d) => normState(d.state));
  const fw = rowsOf(familyOr(coreApi, 'firewalls', []));
  const wl = familyOr(coreApi, 'wirelessOverview', null);
  const wt = (wl && wl.totals) || {};
  const ise = rowsOf(familyOr(coreApi, 'ise', []));
  const voice = rowsOf(familyOr(coreApi, 'voice', []));
  const issueCount = (sev) => issues.filter((i) => i.severity === sev).length;
  const alertCount = (sev) => alerts.filter((a) => a.severityNorm === sev && !a.duplicateOf).length;

  return {
    generatedAt: new Date().toISOString(),
    devices: {
      total: devs.length,
      byKind,
      byFamily,
      failed: states.filter((s) => s === 'failed').length,
      degraded: states.filter((s) => s === 'degraded').length,
      ok: states.filter((s) => s === 'ok').length,
    },
    firewalls: {
      total: fw.length,
      degraded: fw.filter((f) => isBad(f.state)).length,
      // haText is "<local> / <peer>" or "off"; any side that is not active/standby/primary/secondary/hot standby is a degraded pair.
      haDegraded: fw.filter((f) => f.haText && f.haText !== 'off' && /degraded|fail|fault|down|unknown|n\/a/i.test(f.haText)).length,
    },
    wireless: {
      controllers: wt.controllers || 0,
      aps: wt.aps || 0,
      apsDown: wt.apsDown || 0,
      clients: wt.clients == null ? null : wt.clients,
    },
    ise: { nodes: ise.length, degraded: ise.filter((n) => isBad(n.state)).length },
    voice: { devices: voice.length, degraded: voice.filter((v) => isBad(v.state)).length },
    alerts: { critical: alertCount('critical'), warning: alertCount('warning') },
    issues: { critical: issueCount('critical'), warning: issueCount('warning') },
    sources: sourcesOf(coreApi),
    topIssues: issuesWorstFirst(issues).slice(0, 6),
    devicesWorstFirst: devs.slice().sort((a, b) => (STATE_RANK[normState(a.state)] - STATE_RANK[normState(b.state)])
      || ((b.openAlerts || 0) - (a.openAlerts || 0)) || nameOf(a).localeCompare(nameOf(b))).slice(0, 8).map(withFamily),
  };
}

// ---- Ops Monitor card ---------------------------------------------------------------------------------

/** Rows and issues only (no per-device detail): this runs in the web process on every Ops load. */
function opsSummary(coreApi) {
  try {
    if (presence(coreApi) === 0) return null;
    const devs = devicesOf(coreApi);
    const { issues } = issuesAnswer(coreApi);
    const failed = devs.filter((d) => normState(d.state) === 'failed').length;
    const crit = issues.filter((i) => i.severity === 'critical').length;
    const warn = issues.filter((i) => i.severity === 'warning').length;
    const exceptions = [];
    if (failed) exceptions.push({ severity: 'critical', count: failed, text: `${plural(failed, 'Cisco device')} failed`, link: '/cisco/devices?state=failed' });
    if (crit) exceptions.push({ severity: 'critical', count: crit, text: `${plural(crit, 'critical Cisco issue')}`, link: '/cisco/issues' });
    if (warn) exceptions.push({ severity: 'warning', count: warn, text: `${plural(warn, 'Cisco warning')}`, link: '/cisco/issues' });
    const ok = devs.filter((d) => normState(d.state) === 'ok').length;
    return {
      objects: devs.length,
      headline: [
        { label: 'Devices', value: `${ok}/${devs.length}` },
        { label: 'Failed', value: failed },
        { label: 'Open Issues', value: crit + warn },
      ],
      exceptions,
      spark: null,
    };
  } catch {
    return null;
  }
}

// ---- notifier items ----------------------------------------------------------------------------------

// Same rules as platforms/f5/index.js and platforms/logicmonitor/index.js collectAlerts so a device keeps
// its notifier key when it moves platforms: issue sourceKey = issueKey, alert sourceKey = conditionKey,
// type = issue type or the DataSource name, host = the device name / issue target. Differences, stated:
// the "+N downstream shadowed" suffix is not added, lastSeen for alerts is the alert start, and the
// LM-only grouping hints (lm-location / lm-burst) do not apply.
const isShadowedIssue = (row) => !!(row && row.type === 'device-dead' && /\(shadowed by /.test(String(row.message || '')));

function collectAlerts(coreApi) {
  if (presence(coreApi) === 0) return [];
  const issues = issuesAnswer(coreApi).issues.filter((row) => !isShadowedIssue(row)).map((row) => ({
    sourceKey: row.issueKey,
    severity: row.severity,
    host: row.target || row.source,
    message: row.message,
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen,
    ...(row.type ? { type: row.type, typeLabel: row.type } : {}),
  }));
  const seen = new Map();
  for (const a of alertsOf(coreApi)) {
    if (a.cleared || a.sdted || Number(a.severity) < 3 || a.shadowedBy || a.duplicateOf) continue;
    const item = {
      sourceKey: a.conditionKey,
      severity: a.severityNorm,
      host: a.monitorObjectName,
      message: `${a.datasource || ''} ${a.instanceName || ''} ${a.dataPointName || ''} = ${a.alertValue ?? ''} (threshold ${a.threshold ?? ''})`.replace(/\s+/g, ' ').trim(),
      firstSeen: a.startedAt || null,
      lastSeen: a.startedAt || null,
      type: a.datasource || 'LogicMonitor alert',
      typeLabel: a.datasource || 'LogicMonitor alert',
    };
    const prev = seen.get(item.sourceKey);
    if (!prev || (item.severity === 'critical' && prev.severity !== 'critical')) seen.set(item.sourceKey, item);
  }
  return [...issues, ...seen.values()];
}

// ---- search (the one raw SQL in this platform; routes/search.js runs it) ------------------------------

const searchCategories = [
  {
    key: 'cisco-devices', label: 'Cisco devices', platform: 'cisco', perm: 'cisco:devices:view', base: '/cisco/devices',
    route: (i) => `/cisco/devices?q=${encodeURIComponent(i.title)}`,
    // Raw lm_* SQL is allowed here only because routes/search.js executes search SQL itself.
    sql: `SELECT d.display_name AS title, (COALESCE(d.vendor_key, '') || ' ' || COALESCE(d.vendor_kind, '') || ' ' || COALESCE(d.model, '') || ' ' || COALESCE(d.version, '')) AS subtitle FROM lm_devices d
          WHERE d.stale = 0 AND d.vendor_key IN ('cisco', 'meraki') AND (d.display_name LIKE ? ESCAPE '\\' OR d.name LIKE ? ESCAPE '\\') ORDER BY d.display_name LIMIT ?`,
    params: 2,
  },
];

// ---- incident evidence -----------------------------------------------------------------------------------

/** Evidence lines for an incident whose hosts resolve to Cisco or Meraki devices, or null. */
function incidentEvidence(coreApi, ctx) {
  try {
    const names = Array.from(ctx?.names || []).filter(Boolean).map((n) => String(n).toLowerCase());
    const ips = Array.from(ctx?.ips || []).filter(Boolean).map(String);
    if (!names.length && !ips.length) return null;
    const short = names.map((n) => n.split('.')[0]);
    const all = new Set([...names, ...short]);
    const devs = devicesOf(coreApi).filter((d) => [d.displayName, d.name].some((n) => n && all.has(String(n).toLowerCase()))
      || (ips.length && ips.some((ip) => String(d.name || '') === ip)));
    if (!devs.length) return null;
    const { issues } = issuesAnswer(coreApi);
    const lines = [];
    for (const d of devs.slice(0, 3)) {
      const name = nameOf(d);
      lines.push(`${d.vendorKey === 'meraki' ? 'Meraki' : 'Cisco'} ${name}: ${d.vendorKind || 'device'}, state ${normState(d.state)}${d.reasons && d.reasons.length ? ` (${d.reasons.slice(0, 2).join('; ')})` : ''}${d.model ? `, ${d.model}` : ''}${d.version ? ` ${d.version}` : ''}`);
      const lower = name.toLowerCase();
      const mine = issues.filter((i) => { const t = String(i.target || '').toLowerCase(); return t === lower || t.startsWith(`${lower} `); });
      for (const i of issuesWorstFirst(mine).slice(0, 4)) lines.push(`Open ${i.severity} ${i.type}: ${i.message}`);
    }
    return { title: 'Cisco', lines };
  } catch {
    return null;
  }
}

// ---- router ----------------------------------------------------------------------------------------------

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid parameters', details: errors.array() });
  return next();
};
const limitValidator = query('limit').optional().custom((v) => v === 'all' || (/^\d+$/.test(String(v)) && Number(v) >= 1 && Number(v) <= 500));
const pageArgs = (req) => {
  const limit = req.query.limit === 'all' ? 500 : (parseInt(req.query.limit, 10) || 50);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  return { limit, page, offset: (page - 1) * limit };
};
const listRules = [
  query('q').optional().isString().trim().isLength({ max: 200 }),
  query('siteKey').optional().matches(/^[a-z0-9-]{1,80}$/),
  query('sourceId').optional().isInt().toInt(),
  query('state').optional().isIn(['critical', 'warning', 'ok', 'unknown']),
];
const deviceParams = [param('deviceId').isInt().toInt(), query('sourceId').optional().isInt().toInt()];

const ALERT_SORTS = ['startedAt', 'severity', 'monitorObjectName', 'datasource', 'dataPointName', 'acked'];
const DEVICE_COLUMNS = ['displayName', 'family', 'vendorKind', 'state', 'reasons', 'siteName', 'model', 'version', 'openAlerts', 'sourceName'];
const FW_COLUMNS = ['deviceName', 'siteName', 'vendor', 'model', 'version', 'hostStatus', 'haText', 'sessionsActive', 'sessionsMax', 'sessionsUtilPct',
  'dataplaneCpuPct', 'mgmtCpuPct', 'memPct', 'tunnelsUp', 'tunnelsDown', 'gpUsers', 'configSynced', 'threatsPerHour', 'droppedPerMin', 'state', 'sampledAt'];
const WLC_COLUMNS = ['deviceName', 'siteName', 'platform', 'model', 'version', 'hostStatus', 'haText', 'cpuPct', 'memPct', 'apsTotal', 'apsUp', 'apsDown',
  'apsDisabled', 'apAvailablePct', 'radiosTotal', 'radiosUp', 'radiosDown', 'hotRadios', 'avgChannelUtilPct', 'clients', 'clientsMax', 'clientUsagePct',
  'ssids', 'radiusServers', 'radiusUnresponsive', 'mobility', 'state', 'sampledAt'];
const AP_COLUMNS = ['ap', 'controller', 'siteName', 'status', 'operText', 'adminText', 'radiosUp', 'radiosTotal', 'clients', 'util24', 'util5',
  'maxChannelUtilPct', 'uplinkState', 'uplinkRxBps', 'uplinkTxBps', 'uplinkErrors', 'sampledAt'];
const RADIO_COLUMNS = ['radio', 'ap', 'band', 'slot', 'controller', 'siteName', 'state', 'channelUtilPct', 'rxUtilPct', 'txUtilPct', 'clients',
  'txPowerLevel', 'loadProfile', 'noiseProfile', 'interferenceProfile', 'coverageProfile'];
const VOICE_COLUMNS = ['deviceName', 'kind', 'siteName', 'vendor', 'model', 'version', 'hostStatus', 'healthRaw', 'cpuPct', 'memPct', 'fans', 'fansBad', 'psus', 'psusBad',
  'tempMaxC', 'pools', 'poolUtilMaxPct', 'poolSessions', 'poolFailures', 'retransmissions', 'sipConnections', 'sipServerErrPerSec', 'sipClientErrPerSec', 'openIssues', 'state', 'sampledAt'];
const ISE_COLUMNS = ['deviceName', 'siteName', 'vendor', 'model', 'version', 'hostStatus', 'sessions', 'diskUsedMaxPct', 'cpuPct', 'memPct', 'appStateRaw', 'certDaysMin',
  'nodeStateRaw', 'nodes', 'nodesDown', 'openIssues', 'state', 'sampledAt'];

const csvOut = (res, name, columns, rows) => sendCsvRows(res, `cisco-${name}-${new Date().toISOString().slice(0, 10)}.csv`, columns,
  rows.map((r) => columns.map((c) => (Array.isArray(r[c]) ? r[c].join('; ') : r[c]))));

const REPORT_TABLE_DDL = 'CREATE TABLE IF NOT EXISTS cisco_ai_reports (report_key TEXT PRIMARY KEY, model TEXT, content TEXT, generated_at TEXT)';

/** The advisor over the feeds; the cache table is created on first use (a derived platform has no migrations). */
function makeAdvisor(coreApi) {
  const engine = createCiscoAdvisor({ feeds: feedsOf(coreApi), advisor: coreApi.advisor });
  const db = coreApi.db;
  const ensure = () => { if (db) db.exec(REPORT_TABLE_DDL); };
  return {
    ...engine,
    generateReport: async (...a) => { ensure(); return engine.generateReport(...a); },
    getCachedReport: (...a) => { ensure(); return engine.getCachedReport(...a); },
    emailRoute: (label) => { const h = engine.emailRoute(label); return (req, res, next) => { try { ensure(); } catch { /* the handler reports */ } return h(req, res, next); }; },
  };
}

function createRouter(coreApi) {
  const router = express.Router();
  let advisor = null;
  const adv = () => { if (!advisor) advisor = makeAdvisor(coreApi); return advisor; };
  // Feed failures surface as 503 so a missing connector is distinguishable from a code error.
  const h = (fn) => (req, res, next) => {
    try { return fn(req, res, next); } catch (err) {
      if (err && err.code === 'FEED_UNKNOWN') return res.status(503).json({ error: 'connector_unavailable', detail: err.message });
      return next(err);
    }
  };
  const notFound = (res, what) => res.status(404).json({ error: `${what} not found.` });
  const stateFilter = (rows, state) => (state ? rows.filter((r) => r.state === state) : rows);

  router.get('/overview', h((req, res) => res.json(buildOverview(coreApi))));

  // ---- devices ----
  const deviceList = (req) => {
    const { q, kind, family: fam, state, siteKey, sourceId } = req.query;
    const keys = fam ? [fam] : VENDORS;
    let rows = devicesOf(coreApi, { q, vendorKind: kind, state, siteKey, sourceId }, keys);
    if (kind) rows = rows.filter((r) => r.vendorKind === kind);
    if (state) rows = rows.filter((r) => normState(r.state) === normState(state));
    return rows.map(withFamily);
  };
  const devRules = [query('q').optional().isString().trim().isLength({ max: 200 }), query('siteKey').optional().matches(/^[a-z0-9-]{1,80}$/),
    query('sourceId').optional().isInt().toInt(), query('kind').optional().isIn(KINDS), query('family').optional().isIn(VENDORS),
    query('state').optional().isIn(['failed', 'degraded', 'ok', 'unknown', 'critical', 'warning'])];
  router.get('/devices.csv', devRules, validate, h((req, res) => csvOut(res, 'devices', DEVICE_COLUMNS, deviceList(req))));
  router.get('/devices', devRules, validate, h((req, res) => res.json(deviceList(req))));
  router.get('/devices/:deviceId', deviceParams, validate, h((req, res) => {
    const device = feed(coreApi, 'device', { deviceId: req.params.deviceId, sourceId: req.query.sourceId });
    if (!device || !VENDORS.includes(device.vendorKey)) return notFound(res, 'Cisco device');
    const sid = device.sourceId;
    const scoped = (rows) => rowsOf(rows).filter((a) => a.sourceId == null || a.sourceId === sid);
    return res.json({
      device: withFamily(device),
      health: feed(coreApi, 'health', { deviceId: device.id, sourceId: sid }),
      alerts: scoped(feed(coreApi, 'alerts', { vendorKey: device.vendorKey, deviceIds: [device.id], open: true })),
      metrics: rowsOf(feed(coreApi, 'metrics', { deviceId: device.id, sourceId: sid })),
      datasources: rowsOf(feed(coreApi, 'datasources', { deviceId: device.id, sourceId: sid })),
    });
  }));

  // ---- firewalls (ASA, Meraki MX) ----
  const fwList = (req) => stateFilter(rowsOf(family(coreApi, 'firewalls', { q: req.query.q, siteKey: req.query.siteKey, sourceId: req.query.sourceId, state: req.query.state })), req.query.state);
  router.get('/firewalls.csv', listRules, validate, h((req, res) => csvOut(res, 'firewalls', FW_COLUMNS, fwList(req))));
  router.get('/firewalls', listRules, validate, h((req, res) => res.json(fwList(req))));
  router.get('/firewalls/:deviceId', deviceParams, validate, h((req, res) => {
    const d = family(coreApi, 'firewall', { deviceId: req.params.deviceId, sourceId: req.query.sourceId });
    return d ? res.json(d) : notFound(res, 'Firewall');
  }));

  // ---- wireless ----
  const wlq = (req) => ({ q: req.query.q, siteKey: req.query.siteKey, sourceId: req.query.sourceId });
  router.get('/wireless/overview', listRules, validate, h((req, res) => res.json(family(coreApi, 'wirelessOverview', wlq(req)))));
  router.get('/wireless/controllers.csv', listRules, validate, h((req, res) => csvOut(res, 'wireless-controllers', WLC_COLUMNS, rowsOf(family(coreApi, 'wirelessControllers', wlq(req))))));
  router.get('/wireless/controllers', listRules, validate, h((req, res) => res.json(rowsOf(family(coreApi, 'wirelessControllers', wlq(req))))));
  router.get('/wireless/controllers/:deviceId', deviceParams, validate, h((req, res) => {
    const d = family(coreApi, 'wirelessController', { deviceId: req.params.deviceId, controllerId: req.params.deviceId, sourceId: req.query.sourceId });
    return d ? res.json(d) : notFound(res, 'Wireless controller');
  }));
  router.get('/wireless/aps.csv', listRules, validate, h((req, res) => csvOut(res, 'wireless-aps', AP_COLUMNS, rowsOf(family(coreApi, 'wirelessAps', wlq(req))))));
  router.get('/wireless/aps', listRules, validate, h((req, res) => res.json(rowsOf(family(coreApi, 'wirelessAps', wlq(req))))));
  // The singular route the LmAp360 page calls: the LM page sends the AP key as ?ap=, ?apKey= is accepted too.
  router.get('/wireless/ap', [
    query('controllerId').isInt().toInt(),
    query('sourceId').optional().isInt().toInt(),
    query('ap').optional().isString().isLength({ min: 1, max: 200 }),
    query('apKey').optional().isString().isLength({ min: 1, max: 200 }),
  ], validate, h((req, res) => {
    if (!req.query.ap && !req.query.apKey) return res.status(400).json({ error: 'Invalid parameters', details: [{ msg: 'ap is required', path: 'ap' }] });
    const d = family(coreApi, 'wirelessAp', { controllerId: req.query.controllerId, sourceId: req.query.sourceId, apKey: req.query.apKey || req.query.ap });
    return d ? res.json(d) : notFound(res, 'Access point');
  }));
  router.get('/wireless/rf.csv', listRules, validate, h((req, res) => csvOut(res, 'wireless-radios', RADIO_COLUMNS, rowsOf(family(coreApi, 'wirelessRf', wlq(req)), 'radios'))));
  router.get('/wireless/rf', listRules, validate, h((req, res) => res.json(family(coreApi, 'wirelessRf', wlq(req)))));
  router.get('/wireless/ssids', listRules, validate, h((req, res) => res.json(family(coreApi, 'wirelessSsids', wlq(req)))));

  // ---- voice and identity services ----
  const voiceList = (req) => {
    const rows = stateFilter(rowsOf(family(coreApi, 'voice', { q: req.query.q, siteKey: req.query.siteKey, sourceId: req.query.sourceId, state: req.query.state })), req.query.state);
    return req.query.kind ? rows.filter((r) => r.kind === req.query.kind) : rows;
  };
  const voiceRules = [...listRules, query('kind').optional().isIn(['sbc', 'cube', 'ganc'])];
  router.get('/voice.csv', voiceRules, validate, h((req, res) => csvOut(res, 'voice', VOICE_COLUMNS, voiceList(req))));
  router.get('/voice', voiceRules, validate, h((req, res) => res.json(voiceList(req))));
  router.get('/voice/:deviceId', deviceParams, validate, h((req, res) => {
    const d = family(coreApi, 'voiceDevice', { deviceId: req.params.deviceId, sourceId: req.query.sourceId });
    return d ? res.json(d) : notFound(res, 'Voice device');
  }));
  const iseList = (req) => stateFilter(rowsOf(family(coreApi, 'ise', { q: req.query.q, siteKey: req.query.siteKey, sourceId: req.query.sourceId, state: req.query.state })), req.query.state);
  router.get('/ise.csv', listRules, validate, h((req, res) => csvOut(res, 'ise', ISE_COLUMNS, iseList(req))));
  router.get('/ise', listRules, validate, h((req, res) => res.json(iseList(req))));
  router.get('/ise/:deviceId', deviceParams, validate, h((req, res) => {
    const d = family(coreApi, 'iseNode', { deviceId: req.params.deviceId, sourceId: req.query.sourceId });
    return d ? res.json(d) : notFound(res, 'ISE node');
  }));

  // Same query parameters and response shape as GET /api/logicmonitor/alerts. The connector feed returns
  // OPEN alerts only, so cleared=1 answers an empty list and cleared=all behaves like the default.
  router.get('/alerts', [
    query('severity').optional().isIn(['critical', 'warning', 'info']),
    query('cleared').optional().isIn(['0', '1', 'all']),
    query('acked').optional().isIn(['0', '1']),
    query('q').optional().isString().trim().isLength({ max: 200 }),
    query('datasource').optional().isString().trim().isLength({ max: 255 }),
    query('deviceId').optional().isInt(),
    query('sourceId').optional().isInt(),
    query('shadowed').optional().isIn(['0', '1']),
    query('duplicate').optional().isIn(['0', '1', 'all']),
    query('sort').optional().isIn(ALERT_SORTS),
    query('dir').optional().isIn(['asc', 'desc']),
    query('page').optional().isInt({ min: 1 }),
    limitValidator,
  ], validate, h((req, res) => {
    const q = req.query;
    const all = alertsOf(coreApi);
    const open = all.filter((a) => !a.cleared);
    const counts = { critical: 0, warning: 0, info: 0, acked: 0, sdted: 0 };
    for (const a of open.filter((x) => !x.duplicateOf)) {
      if (counts[a.severityNorm] != null) counts[a.severityNorm] += 1;
      if (a.acked) counts.acked += 1;
      if (a.sdted) counts.sdted += 1;
    }
    const dupRows = open.filter((a) => a.duplicateOf);
    const byPlatform = new Map();
    for (const a of dupRows) {
      const k = String(a.duplicateOf).replace(/^duplicate:/, '');
      byPlatform.set(k, (byPlatform.get(k) || 0) + 1);
    }
    const duplicates = { total: dupRows.length, byPlatform: [...byPlatform.entries()].map(([platform, n]) => ({ platform, count: n })) };

    let rows = q.cleared === '1' ? [] : open;
    if (q.severity) rows = rows.filter((a) => a.severityNorm === q.severity);
    if (q.acked) rows = rows.filter((a) => (a.acked ? 1 : 0) === Number(q.acked));
    if (q.datasource) rows = rows.filter((a) => a.datasource === q.datasource);
    if (q.deviceId != null && q.deviceId !== '') rows = rows.filter((a) => a.deviceId === Number(q.deviceId));
    if (q.sourceId) rows = rows.filter((a) => a.sourceId === Number(q.sourceId));
    if (q.shadowed === '1') rows = rows.filter((a) => a.shadowedBy);
    if (q.shadowed === '0') rows = rows.filter((a) => !a.shadowedBy);
    if (q.duplicate === '1') rows = rows.filter((a) => a.duplicateOf);
    else if (q.duplicate !== 'all') rows = rows.filter((a) => !a.duplicateOf);
    if (q.q) {
      const n = String(q.q).toLowerCase();
      rows = rows.filter((a) => [a.monitorObjectName, a.datasource, a.instanceName, a.dataPointName].some((v) => String(v || '').toLowerCase().includes(n)));
    }
    const key = ALERT_SORTS.includes(q.sort) ? q.sort : 'startedAt';
    const dir = q.sort ? (q.dir === 'desc' ? -1 : 1) : (q.dir === 'asc' ? 1 : -1);
    const val = (a) => (key === 'acked' ? (a.acked ? 1 : 0) : a[key]);
    rows = rows.slice().sort((a, b) => {
      const x = val(a); const y = val(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    });
    const { limit, page, offset } = pageArgs(req);
    return res.json({ items: rows.slice(offset, offset + limit), total: rows.length, page, limit, counts, duplicates });
  }));

  router.get('/issues', h((req, res) => res.json(issuesAnswer(coreApi))));

  // Same query params and bare-array answer as GET /api/logicmonitor/issue-history (open plus recently resolved).
  router.get('/issue-history', [query('days').optional().isInt({ min: 1, max: 90 }).toInt()], validate, h((req, res) => {
    const params = req.query.days ? { days: req.query.days } : {};
    return res.json(perKey(coreApi, 'issueHistory', params));
  }));

  // ---- AI Advisor (coreApi.advisor) ----
  const advisorKey = (slug) => String(slug).replace(/-/g, '_');
  router.get('/advisor/:report', [param('report').isString()], validate, h((req, res) => {
    const key = advisorKey(req.params.report);
    if (!REPORT_KEYS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
    const a = adv();
    return res.json({ enabled: a.isConfigured(), report: a.getCachedReport(key) });
  }));
  router.post('/advisor/:report', [param('report').isString()], validate, async (req, res, next) => {
    try {
      const key = advisorKey(req.params.report);
      if (!REPORT_KEYS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
      return res.json(await adv().generateReport(key));
    } catch (err) {
      if (err.code === 'LLM_NOT_CONFIGURED') {
        return res.status(503).json({ error: 'AI analysis is not configured. Add an OpenAI or GitHub Models token under Settings > Credentials.' });
      }
      if (err.code === 'LLM_RATE_LIMITED') {
        if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
        return res.status(429).json({ error: err.message, retryAfter: err.retryAfter });
      }
      if (err.code === 'LLM_REQUEST_FAILED' || err.code === 'LLM_EMPTY') return res.status(502).json({ error: err.message });
      if (err.code === 'FEED_UNKNOWN') return res.status(503).json({ error: 'connector_unavailable', detail: err.message });
      return next(err);
    }
  });
  router.post('/advisor/:report/email', (req, res, next) => adv().emailRoute('Cisco')(req, res, next));

  // Read-only: the Cisco platform has no sources of its own; thresholds live in LogicMonitor Rules > Services.
  router.get('/settings', h((req, res) => {
    const kinds = {};
    for (const d of devicesOf(coreApi)) { const k = d.vendorKind || 'other'; kinds[k] = (kinds[k] || 0) + 1; }
    return res.json({
      sources: sourcesOf(coreApi),
      matchedDevices: presence(coreApi),
      kinds,
      derivedFrom: CONNECTOR,
      logicmonitorSettingsPath: SETTINGS_PATH,
    });
  }));

  return router;
}

module.exports = {
  id: 'cisco',
  name: 'Cisco',
  apiVersion: 1,
  color: BRAND,
  version: '1.0.0',
  derivedFrom: CONNECTOR,
  vendorKeys: VENDORS.slice(),
  presence,
  createRouter,
  navSections: ['overview', 'alerts', 'issues', 'devices', 'firewalls', 'wireless', 'voice', 'ise', 'advisor', 'settings'],
  opsSummary,
  collectAlerts,
  searchCategories,
  agentProfile,
  incidentEvidence,
  // Exposed for tests only.
  _test: { buildOverview, normState, isShadowedIssue },
};
