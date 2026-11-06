// F5 platform manifest (ICC contract: DERIVED platform, round 1 of the derived-platforms work).
// F5 has no sources, no poller and no tables. Every read goes through the LogicMonitor connector's
// feeds (core/feeds.js, coreApi.feeds.query('logicmonitor', <feed>, params)); the one exception is
// the search category below, whose SQL routes/search.js executes itself. The platform is present
// (rail, Ops card, search, notifier) only while the connector holds at least one device that ICC
// classified as vendor_key 'f5'; registry.isPresent() calls presence() below.
// Brand colour #E4002B is the F5 red as remembered and UNVERIFIED.
const express = require('express');
const { query, param, validationResult } = require('express-validator');
const { sendCsv: sendCsvRows } = require('../../utils/csv');
const { createF5Advisor, REPORT_KEYS } = require('../../services/advisors/f5Advisor');

const BRAND = '#E4002B';
const VENDOR = 'f5';
const CONNECTOR = 'logicmonitor';
const SETTINGS_PATH = '/logicmonitor/settings?section=services';
const CERT_DETAIL_CAP = 40;

const p = (port, label, expect) => ({ port, label, expect });

// Same object as the services/agentProfiles/defaults.js f5 entry (that entry is the one the agent
// reads; this copy is for packs later).
const agentProfile = {
  focus: 'BIG-IP pairs: one unit Active and one Standby is healthy; both Active or a unit Offline is the incident, and a failover moves load, so check which unit now carries traffic. A pool degraded names members down: check the member and its monitor before the F5. VIP certificate days left are the earliest hard deadline. A daemon state of 0 on mcpd or tmm is an exit code (0 = running), so non-zero means the daemon is down. GTM wide IPs down follow their pool or datacenter. F5OS (rSeries) alerts are about the tenant platform, not the BIG-IP guest.',
  ports: { source: [p(443, 'HTTPS', true)], host: [p(443, 'HTTPS', true), p(22, 'SSH', false)] },
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

const devicesOf = (coreApi, params) => rowsOf(feed(coreApi, 'devices', { vendorKey: VENDOR, ...(params || {}) }));
const lbRowsOf = (coreApi, params) => rowsOf(feed(coreApi, 'loadBalancers', { vendorKey: VENDOR, ...(params || {}) }));
const alertsOf = (coreApi, params) => rowsOf(feed(coreApi, 'alerts', { vendorKey: VENDOR, open: true, ...(params || {}) }));
function issuesAnswer(coreApi, params) {
  const v = feed(coreApi, 'issues', { vendorKey: VENDOR, ...(params || {}) });
  return { issues: rowsOf(v, 'issues'), asOf: (v && !Array.isArray(v) && v.asOf) || null };
}
const sourcesOf = (coreApi) => rowsOf(feed(coreApi, 'sources', {}));

/** Matched device count; 0 on any failure so a broken connector hides the platform instead of throwing. */
function presence(coreApi) {
  try {
    const n = Number(feed(coreApi, 'presence', { vendorKey: VENDOR }));
    return Number.isFinite(n) && n > 0 ? n : 0;
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

const issuesWorstFirst = (list) => list.slice().sort((a, b) => sevRank(a.severity) - sevRank(b.severity)
  || String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));

// ---- overview ----------------------------------------------------------------------------------------

/** Certificates expiring inside 30 and 90 days (90 includes the 30). Uses the 360 detail of each
 *  BIG-IP / GTM device; a device whose detail fails falls back to its list-row certsExpiring. */
function certCounts(coreApi, lbs, devs) {
  // Load balancer rows carry no vendorKind, so F5OS (no SSL profiles) is skipped through the device list.
  const f5os = new Set(devs.filter((d) => d.vendorKind === 'f5os').map((d) => `${d.sourceId}:${d.id}`));
  let expiring30 = 0;
  let expiring90 = 0;
  for (const r of lbs.filter((x) => !f5os.has(`${x.sourceId}:${x.deviceId ?? x.id}`)).slice(0, CERT_DETAIL_CAP)) {
    try {
      const d = feed(coreApi, 'loadBalancer', { vendorKey: VENDOR, deviceId: r.deviceId ?? r.id, sourceId: r.sourceId });
      for (const c of rowsOf(d && d.certs)) {
        const days = Number(c.daysLeft);
        if (!Number.isFinite(days)) continue;
        if (days < 30) expiring30 += 1;
        if (days < 90) expiring90 += 1;
      }
    } catch {
      expiring30 += r.certsExpiring || 0;
      expiring90 += r.certsExpiring || 0;
    }
  }
  return { expiring30, expiring90 };
}

function buildOverview(coreApi) {
  const devs = devicesOf(coreApi);
  const lbs = lbRowsOf(coreApi);
  const { issues } = issuesAnswer(coreApi);
  const alerts = alertsOf(coreApi);

  const count = (fn) => devs.filter(fn).length;
  const states = devs.map((d) => normState(d.state));
  const failover = { active: 0, standby: 0, degraded: 0 };
  for (const r of lbs) {
    const t = r.failoverText;
    if (t == null) continue;
    if (t === 'active') failover.active += 1; else if (t === 'standby') failover.standby += 1; else failover.degraded += 1;
  }
  const issueCount = (sev) => issues.filter((i) => i.severity === sev).length;
  const alertCount = (sev) => alerts.filter((a) => a.severityNorm === sev && !a.duplicateOf).length;

  return {
    generatedAt: new Date().toISOString(),
    devices: {
      total: devs.length,
      bigip: count((d) => d.vendorKind === 'bigip'),
      gtm: count((d) => d.vendorKind === 'gtm'),
      f5os: count((d) => d.vendorKind === 'f5os'),
      failed: states.filter((s) => s === 'failed').length,
      degraded: states.filter((s) => s === 'degraded').length,
      ok: states.filter((s) => s === 'ok').length,
    },
    pools: { total: lbs.reduce((n, r) => n + (r.pools || 0), 0), degraded: lbs.reduce((n, r) => n + (r.poolsDegraded || 0), 0) },
    certs: certCounts(coreApi, lbs, devs),
    failover,
    daemons: { down: lbs.reduce((n, r) => n + (r.daemonsDown || 0), 0) },
    alerts: { critical: alertCount('critical'), warning: alertCount('warning') },
    issues: { critical: issueCount('critical'), warning: issueCount('warning') },
    sources: sourcesOf(coreApi),
    topIssues: issuesWorstFirst(issues).slice(0, 6),
    devicesWorstFirst: devs.slice().sort((a, b) => (STATE_RANK[normState(a.state)] - STATE_RANK[normState(b.state)])
      || ((b.openAlerts || 0) - (a.openAlerts || 0)) || nameOf(a).localeCompare(nameOf(b))).slice(0, 8),
  };
}

// ---- Ops Monitor card ---------------------------------------------------------------------------------

/** Rows and issues only (no per-device detail): this runs in the web process on every Ops load. */
function opsSummary(coreApi) {
  try {
    if (presence(coreApi) === 0) return null;
    const devs = devicesOf(coreApi);
    const lbs = lbRowsOf(coreApi);
    const { issues } = issuesAnswer(coreApi);
    const failed = devs.filter((d) => normState(d.state) === 'failed').length;
    const poolsDegraded = lbs.reduce((n, r) => n + (r.poolsDegraded || 0), 0);
    const crit = issues.filter((i) => i.severity === 'critical').length;
    const warn = issues.filter((i) => i.severity === 'warning').length;
    const exceptions = [];
    if (failed) exceptions.push({ severity: 'critical', count: failed, text: `${plural(failed, 'F5 device')} failed`, link: '/f5/devices?state=failed' });
    if (crit) exceptions.push({ severity: 'critical', count: crit, text: `${plural(crit, 'critical F5 issue')}`, link: '/f5/issues' });
    if (warn) exceptions.push({ severity: 'warning', count: warn, text: `${plural(warn, 'F5 warning')}`, link: '/f5/issues' });
    if (poolsDegraded) exceptions.push({ severity: 'warning', count: poolsDegraded, text: `${plural(poolsDegraded, 'pool')} degraded`, link: '/f5/load-balancers' });
    const ok = devs.filter((d) => normState(d.state) === 'ok').length;
    return {
      objects: devs.length,
      headline: [
        { label: 'Devices', value: `${ok}/${devs.length}` },
        { label: 'Pools Degraded', value: poolsDegraded },
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

// Same rules as platforms/logicmonitor/index.js collectAlerts so a device keeps its notifier key when
// it moves platforms: issue sourceKey = issue_key (issueKey in the issues feed), alert sourceKey =
// condition_key (conditionKey in the alerts feed), type = issue type or the DataSource name, host =
// the device name / issue target. Copied rule, not imported (that file reads lm_* tables).
// Differences, stated: the "+N downstream shadowed" message suffix is not added (it needs lm_alerts
// counts), lastSeen for alerts is the alert start (the feed rows carry no capture time), and the
// LM-only grouping hints (annotateGroups: lm-location / lm-burst) do not apply because those issue
// types are network-structure items that stay with LogicMonitor.
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
    key: 'f5-devices', label: 'F5 devices', platform: 'f5', perm: 'f5:devices:view', base: '/f5/devices',
    route: (i) => `/f5/devices?q=${encodeURIComponent(i.title)}`,
    // Raw lm_* SQL is allowed here only because routes/search.js executes search SQL itself.
    sql: `SELECT d.display_name AS title, (COALESCE(d.vendor_kind, '') || ' ' || COALESCE(d.model, '') || ' ' || COALESCE(d.version, '')) AS subtitle FROM lm_devices d
          WHERE d.stale = 0 AND d.vendor_key = 'f5' AND (d.display_name LIKE ? ESCAPE '\\' OR d.name LIKE ? ESCAPE '\\') ORDER BY d.display_name LIMIT ?`,
    params: 2,
  },
];

// ---- incident evidence -----------------------------------------------------------------------------------

/** Evidence lines for an incident whose hosts resolve to F5 devices, or null. */
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
    const lbs = lbRowsOf(coreApi);
    const { issues } = issuesAnswer(coreApi);
    const lines = [];
    for (const d of devs.slice(0, 3)) {
      const name = nameOf(d);
      lines.push(`F5 ${name}: ${d.vendorKind || 'device'}, state ${normState(d.state)}${d.reasons && d.reasons.length ? ` (${d.reasons.slice(0, 2).join('; ')})` : ''}${d.model ? `, ${d.model}` : ''}${d.version ? ` ${d.version}` : ''}`);
      const lb = lbs.find((r) => (r.deviceId ?? r.id) === d.id && r.sourceId === d.sourceId);
      if (lb) {
        lines.push(`Failover ${lb.failoverText || 'unknown'}${lb.syncState ? `, sync ${lb.syncState}` : ''}; pools degraded ${lb.poolsDegraded ?? 0} of ${lb.pools ?? 0}, members down ${lb.membersDown ?? 0}; daemons down ${lb.daemonsDown ?? 0}; certificates expiring ${lb.certsExpiring ?? 0}`);
      }
      const lower = name.toLowerCase();
      const mine = issues.filter((i) => { const t = String(i.target || '').toLowerCase(); return t === lower || t.startsWith(`${lower} `); });
      for (const i of issuesWorstFirst(mine).slice(0, 4)) lines.push(`Open ${i.severity} ${i.type}: ${i.message}`);
    }
    return { title: 'F5', lines };
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
];
const deviceParams = [param('deviceId').isInt().toInt(), query('sourceId').optional().isInt().toInt()];

const ALERT_SORTS = ['startedAt', 'severity', 'monitorObjectName', 'datasource', 'dataPointName', 'acked'];
const LB_COLUMNS = ['deviceName', 'siteName', 'vendor', 'model', 'version', 'hostStatus', 'failoverText', 'syncState', 'cpuPct', 'memPct', 'clientConnections',
  'serverConnections', 'pools', 'poolsDegraded', 'membersTotal', 'membersDown', 'wideIps', 'wideIpsDown', 'vips', 'vipsDown', 'daemonsDown', 'certsExpiring', 'state', 'sampledAt'];
const DEVICE_COLUMNS = ['displayName', 'vendorKind', 'state', 'reasons', 'siteName', 'model', 'version', 'openAlerts', 'sourceName'];

const csvOut = (res, name, columns, rows) => sendCsvRows(res, `f5-${name}-${new Date().toISOString().slice(0, 10)}.csv`, columns,
  rows.map((r) => columns.map((c) => (Array.isArray(r[c]) ? r[c].join('; ') : r[c]))));

const REPORT_TABLE_DDL = 'CREATE TABLE IF NOT EXISTS f5_ai_reports (report_key TEXT PRIMARY KEY, model TEXT, content TEXT, generated_at TEXT)';

/** The advisor over the feeds; the cache table is created on first use (a derived platform has no migrations). */
function makeAdvisor(coreApi) {
  const engine = createF5Advisor({ feeds: feedsOf(coreApi), advisor: coreApi.advisor });
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

  router.get('/overview', h((req, res) => res.json(buildOverview(coreApi))));

  const deviceList = (req) => {
    const { q, kind, state, siteKey, sourceId } = req.query;
    let rows = devicesOf(coreApi, { q, vendorKind: kind, state, siteKey, sourceId });
    if (kind) rows = rows.filter((r) => r.vendorKind === kind);
    if (state) rows = rows.filter((r) => normState(r.state) === normState(state));
    return rows;
  };
  const devRules = [...listRules, query('kind').optional().isIn(['bigip', 'gtm', 'f5os']),
    query('state').optional().isIn(['failed', 'degraded', 'ok', 'unknown', 'critical', 'warning'])];
  router.get('/devices.csv', devRules, validate, h((req, res) => csvOut(res, 'devices', DEVICE_COLUMNS, deviceList(req))));
  router.get('/devices', devRules, validate, h((req, res) => res.json(deviceList(req))));
  router.get('/devices/:deviceId', deviceParams, validate, h((req, res) => {
    const params = { deviceId: req.params.deviceId, sourceId: req.query.sourceId };
    const device = feed(coreApi, 'device', params);
    if (!device || device.vendorKey !== VENDOR) return res.status(404).json({ error: 'F5 device not found.' });
    const sid = device.sourceId;
    const scoped = (rows) => rowsOf(rows).filter((a) => a.sourceId == null || a.sourceId === sid);
    return res.json({
      device,
      health: feed(coreApi, 'health', { deviceId: device.id, sourceId: sid }),
      alerts: scoped(feed(coreApi, 'alerts', { vendorKey: VENDOR, deviceIds: [device.id], open: true })),
      metrics: rowsOf(feed(coreApi, 'metrics', { deviceId: device.id, sourceId: sid })),
      datasources: rowsOf(feed(coreApi, 'datasources', { deviceId: device.id, sourceId: sid })),
    });
  }));

  const lbRules = [...listRules, query('state').optional().isIn(['critical', 'warning', 'ok', 'unknown'])];
  const lbList = (req) => {
    const { q, siteKey, sourceId, state } = req.query;
    let rows = lbRowsOf(coreApi, { q, siteKey, sourceId, state });
    if (state) rows = rows.filter((r) => r.state === state);
    return rows;
  };
  router.get('/load-balancers.csv', lbRules, validate, h((req, res) => csvOut(res, 'load-balancers', LB_COLUMNS, lbList(req))));
  router.get('/load-balancers', lbRules, validate, h((req, res) => res.json(lbList(req))));
  router.get('/load-balancers/:deviceId', [...deviceParams, query('page').optional().isInt({ min: 1 }), limitValidator], validate, h((req, res) => {
    const d = feed(coreApi, 'loadBalancer', { vendorKey: VENDOR, deviceId: req.params.deviceId, sourceId: req.query.sourceId, page: req.query.page, limit: req.query.limit });
    if (!d) return res.status(404).json({ error: 'Load balancer not found.' });
    return res.json(d);
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
    const params = { vendorKey: VENDOR };
    if (req.query.days) params.days = req.query.days;
    return res.json(rowsOf(feed(coreApi, 'issueHistory', params)));
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
  router.post('/advisor/:report/email', (req, res, next) => adv().emailRoute('F5')(req, res, next));

  // Read-only: the F5 platform has no sources of its own; thresholds live in LogicMonitor Rules > Services.
  router.get('/settings', h((req, res) => res.json({
    sources: sourcesOf(coreApi),
    matchedDevices: presence(coreApi),
    derivedFrom: CONNECTOR,
    logicmonitorSettingsPath: SETTINGS_PATH,
  })));

  return router;
}

module.exports = {
  id: 'f5',
  name: 'F5',
  apiVersion: 1,
  color: BRAND,
  version: '1.0.0',
  derivedFrom: CONNECTOR,
  vendorKeys: [VENDOR],
  presence,
  createRouter,
  navSections: ['overview', 'alerts', 'issues', 'devices', 'load-balancers', 'advisor', 'settings'],
  opsSummary,
  collectAlerts,
  searchCategories,
  agentProfile,
  incidentEvidence,
  // Exposed for tests only.
  _test: { buildOverview, normState, isShadowedIssue },
};
