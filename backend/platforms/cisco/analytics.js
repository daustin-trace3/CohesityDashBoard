// Cisco switching and routing analytics (derived platform: feeds only, no tables, no SQL).
// Every builder takes `call(name, params)`, a feed caller that already carries
// { vendorKey: 'cisco', includeMeraki: true }. A feed the connector does not have yet answers with
// the empty shape plus available: false, so the pages render an empty state instead of an error.
// Every forecast carries its basis text, and "insufficient data" when days is null (contract G9).
const { query, param, validationResult } = require('express-validator');
const { sendCsv } = require('../../utils/csv');

const CONNECTOR = 'logicmonitor';
const REASON_TEXT = {
  insufficient_points: 'too few daily points',
  weak_fit: 'weak linear fit',
  wrong_direction: 'trend is moving away from the threshold',
  already_past: 'already past the threshold',
};
const STATE_RANK = { failed: 0, degraded: 1, unknown: 2, ok: 3 };
const n2 = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const r2dp = (v) => (n2(v) == null ? null : Math.round(Number(v) * 100) / 100);
const arr = (v, ...keys) => {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') for (const k of keys.concat(['items', 'rows'])) if (Array.isArray(v[k])) return v[k];
  return [];
};

/** { days, text } from a trend finding (or a bare days number plus optional basis fields). */
function forecastOf(days, f) {
  const finding = f && typeof f === 'object' ? f : {};
  const b = finding.basis && typeof finding.basis === 'object' ? finding.basis : {};
  const d = n2(days);
  if (d == null) {
    const reason = b.reason && b.reason !== 'ok' ? (REASON_TEXT[b.reason] || b.reason) : null;
    return { days: null, text: `insufficient data${reason ? ` (${reason})` : ''}` };
  }
  const win = n2(b.windowDays) != null ? b.windowDays : n2(finding.n);
  const r2 = n2(finding.r2) != null ? finding.r2 : b.r2;
  const parts = [`estimate: linear fit${win != null ? ` over ${win} days` : ''}`];
  if (n2(r2) != null) parts.push(`R2 ${r2dp(r2)}`);
  return { days: d, text: parts.join(', ') };
}
/** A trends-feed row with its forecast attached. */
const withForecast = (row) => ({ ...row, forecast: forecastOf(row.daysToThreshold, row) });

const sevRank = (s) => (s === 'critical' ? 0 : s === 'warning' ? 1 : 2);
const normState = (s) => (s === 'failed' || s === 'critical' ? 'failed' : s === 'degraded' || s === 'warning' ? 'degraded' : s === 'ok' ? 'ok' : 'unknown');

function makeCaller(feedsApi, extra) {
  const raw = (name, params) => feedsApi.query(CONNECTOR, name, { vendorKey: 'cisco', includeMeraki: true, ...(extra || {}), ...(params || {}) });
  /** Feed answer or `fallback` (available false) when the connector lacks the feed. */
  const tryCall = (name, params, fallback) => {
    try { return { value: raw(name, params), available: true }; } catch (err) {
      if (err && err.code === 'FEED_UNKNOWN') return { value: fallback, available: false };
      throw err;
    }
  };
  return { raw, tryCall };
}

// ---- hardware ------------------------------------------------------------------------------------------

function whyOf(c) {
  const what = `${String(c.component || 'component').replace('_', ' ')}${c.instance ? ` ${c.instance}` : ''}`;
  if (c.component === 'temp' || c.component === 'sensor') {
    return `${what} ${c.state}${n2(c.value) != null ? ` (${r2dp(c.value)}${c.unit ? ` ${c.unit}` : ''})` : ''}`;
  }
  return `${what} ${c.state}`;
}

function buildHardware(call) {
  const { value, available } = call.tryCall('hardware', {}, { components: [], derived: {} });
  const comps = arr(value, 'components');
  const d = (value && value.derived) || {};
  const lost = arr(d.redundancyLost);
  const hot = arr(d.thermalOutliers);
  const switchovers = arr(d.switchovers30d);
  const hotKey = new Map(hot.map((h) => [`${h.device}|${h.sensor}`, h]));
  const lostByDevice = new Map();
  for (const l of lost) lostByDevice.set(l.device, l.reason);
  const components = comps.map((c) => {
    const state = normState(c.state);
    const outlier = hotKey.get(`${c.device}|${c.instance}`) || null;
    return {
      ...c, state, why: whyOf({ ...c, state }),
      outlier: !!outlier, siteHvacSuspected: !!(outlier && outlier.suspectedSiteHvac),
      redundancyNote: lostByDevice.get(c.device) || null,
    };
  }).sort((a, b) => (STATE_RANK[a.state] - STATE_RANK[b.state]) || (b.outlier - a.outlier)
    || String(a.device).localeCompare(String(b.device)) || String(a.instance).localeCompare(String(b.instance)));
  return {
    available,
    tiles: {
      componentsFailed: components.filter((c) => c.state === 'failed').length,
      redundancyLost: lost.length,
      hotSensors: hot.length,
      switchovers30d: switchovers.length,
    },
    components,
    redundancyLost: lost,
    thermalOutliers: hot.map((h) => ({ ...h, why: h.suspectedSiteHvac ? 'site HVAC suspected' : 'hotter than model or site peers' })),
    switchovers30d: switchovers.map(withForecast),
  };
}

// ---- interfaces ----------------------------------------------------------------------------------------

function buildInterfacesAnalytics(call, { tab, days, limit }) {
  const t = ['hot', 'flapping', 'errors'].includes(tab) ? tab : 'hot';
  const { value, available } = call.tryCall('interfacesAnalytics', { tab: t, days, limit }, []);
  const rows = arr(value).map((r) => {
    if (t !== 'hot') return r;
    const inF = forecastOf(r.daysTo80In, r);
    const outF = forecastOf(r.daysTo80Out, r);
    return { ...r, forecastIn: inF, forecastOut: outF };
  });
  return { available, tab: t, days, rows };
}

// ---- optics --------------------------------------------------------------------------------------------

/** Optics at risk: margin under 2 dB or a warning/critical margin trend. */
const opticAtRisk = (r) => (n2(r.marginDb) != null && Number(r.marginDb) < 2) || (r.trend && (r.trend.severity === 'warning' || r.trend.severity === 'critical'));

function buildOptics(call) {
  const { value, available } = call.tryCall('optics', {}, []);
  const rows = arr(value).map((r) => ({
    ...r,
    atRisk: !!opticAtRisk(r),
    forecast: r.trend ? forecastOf(r.trend.daysToThreshold, r.trend) : { days: null, text: 'insufficient data' },
  })).sort((a, b) => (b.atRisk - a.atRisk) || ((n2(a.marginDb) ?? 1e9) - (n2(b.marginDb) ?? 1e9)));
  return { available, tiles: { atRisk: rows.filter((r) => r.atRisk).length, total: rows.length }, rows };
}

// ---- PoE -----------------------------------------------------------------------------------------------

function buildPoe(call) {
  const { value, available } = call.tryCall('poe', {}, { rows: [], sites: [] });
  const rows = arr(value, 'rows').map((r) => ({ ...r, forecast: r.trend ? forecastOf(r.trend.daysToThreshold, r.trend) : { days: null, text: 'insufficient data' } }))
    .sort((a, b) => (n2(b.usedPct) ?? -1) - (n2(a.usedPct) ?? -1));
  return { available, rows, sites: arr(value && value.sites ? value.sites : value && value.siteRollup, 'sites') };
}

// ---- routing -------------------------------------------------------------------------------------------

function buildRouting(call) {
  const { value, available } = call.tryCall('routingPeers', {}, []);
  const rows = arr(value).map((r) => ({
    ...r,
    shadowed: !!r.shadowed,
    // A peer on a dead device is shadowed by the device-dead issue: never counted as a separate fault.
    notEstablished: !r.shadowed && !/established|full|up/i.test(String(r.state || '')),
  })).sort((a, b) => (b.notEstablished - a.notEstablished) || ((b.flaps7d || 0) - (a.flaps7d || 0)));
  const live = rows.filter((r) => !r.shadowed);
  return {
    available,
    tiles: { peers: rows.length, notEstablished: live.filter((r) => r.notEstablished).length, flapping: live.filter((r) => (r.flaps7d || 0) >= 3).length, shadowed: rows.length - live.length },
    note: 'Prefix counts not collected: LogicMonitor BGP- exposes no prefix datapoint on this portal, so prefix drift is not shown.',
    rows,
  };
}

// ---- resources -----------------------------------------------------------------------------------------

const asFinding = (x) => (x && typeof x === 'object' ? x : { daysToThreshold: x });

function normaliseResource(r) {
  const cpu = r.cpu || {};
  const mem = r.mem || {};
  const cpuF = asFinding(cpu.forecast);
  const creep = mem.creep && typeof mem.creep === 'object' ? mem.creep : null;
  const flash = arr(r.flash).map((f) => ({ ...f, forecast: forecastOf(f.daysTo95, asFinding(f.finding || f)) }));
  const flashMin = flash.map((f) => n2(f.daysTo95)).filter((v) => v != null);
  return {
    ...r,
    cpu: { ...cpu, daysTo80: n2(cpuF.daysToThreshold), forecast: forecastOf(cpuF.daysToThreshold, cpuF) },
    mem: { ...mem, creep, creepFlag: !!creep, creepText: creep ? 'possible leak, review IOS-XE version' : null },
    flash,
    flashMinDays: flashMin.length ? Math.min(...flashMin) : null,
  };
}

function buildResources(call, { days, deviceId, sourceId }) {
  const { value, available } = call.tryCall('deviceResources', { days, deviceId }, []);
  const rows = arr(value).map(normaliseResource).sort((a, b) => ((b.cpu.p95 ?? -1) - (a.cpu.p95 ?? -1)));
  const out = { available, days, rows, tiles: { creeping: rows.filter((r) => r.mem.creepFlag).length, flashRisk: rows.filter((r) => r.flashMinDays != null && r.flashMinDays <= 90).length } };
  if (deviceId != null) {
    const row = rows.find((r) => String(r.deviceId) === String(deviceId)) || rows[0] || null;
    const sid = sourceId != null ? sourceId : row && row.sourceId;
    const series = (metric) => arr(call.tryCall('trendSeries', { sourceId: sid, deviceId, metric, days, agg: 'max' }, []).value);
    out.device = row;
    out.series = row ? { cpu: series('cpu_pct'), mem: series('mem_pct') } : { cpu: [], mem: [] };
  }
  return out;
}

// ---- reachability --------------------------------------------------------------------------------------

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);

function buildReachability(call, { days, limit }) {
  const { value, available } = call.tryCall('reachability', { days }, { ping: [], ntp: [], ipsla: [] });
  const v = value || {};
  const siteOf = new Map();
  try {
    for (const d of arr(call.raw('devices', {}))) siteOf.set(d.displayName || d.name, d.siteName || d.siteKey || null);
  } catch { /* site column stays blank */ }
  const ping = arr(v.ping).map((r) => ({ ...r, site: r.site || siteOf.get(r.device) || null }))
    .sort((a, b) => ((n2(b.lossPct) ?? 0) - (n2(a.lossPct) ?? 0)) || ((n2(b.rttMs) ?? 0) - (n2(a.rttMs) ?? 0)));
  const bySite = new Map();
  for (const r of ping) {
    if (n2(r.rttMs) == null) continue;
    const k = r.site || 'Unassigned';
    if (!bySite.has(k)) bySite.set(k, []);
    bySite.get(k).push(Number(r.rttMs));
  }
  const siteRtt = [...bySite.entries()].map(([site, list]) => {
    const s = list.slice().sort((a, b) => a - b);
    return { site, devices: s.length, minMs: s[0], p50Ms: pct(s, 50), p95Ms: pct(s, 95), maxMs: s[s.length - 1] };
  }).sort((a, b) => (b.p95Ms || 0) - (a.p95Ms || 0));
  const ntp = arr(v.ntp).map((r) => ({ ...r, outlier: r.outlier != null ? !!r.outlier : (n2(r.offsetMs) != null && Math.abs(Number(r.offsetMs)) > 100) }));
  const strata = {};
  for (const r of ntp) { const k = r.stratum == null ? 'unknown' : String(r.stratum); strata[k] = (strata[k] || 0) + 1; }
  return {
    available,
    days,
    ping: ping.slice(0, limit || 20),
    pingTotal: ping.length,
    siteRtt,
    ntp: ntp.sort((a, b) => ((a.synced === false) === (b.synced === false) ? 0 : a.synced === false ? -1 : 1) || ((n2(b.offsetMs) ? Math.abs(b.offsetMs) : 0) - (n2(a.offsetMs) ? Math.abs(a.offsetMs) : 0))),
    ntpTiles: { unsynced: ntp.filter((r) => r.synced === false).length, outliers: ntp.filter((r) => r.outlier).length, strata },
    ipsla: arr(v.ipsla),
  };
}

// ---- wireless -------------------------------------------------------------------------------------------

function buildWirelessAnalytics(call, { days }) {
  const { value, available } = call.tryCall('wirelessAnalytics', { days }, {});
  const v = value || {};
  return {
    available,
    days,
    apLoadImbalance: arr(v.apLoadImbalance),
    channelUtilTrend: arr(v.channelUtilTrend),
    radiusFailureRatio: arr(v.radiusFailureRatio),
  };
}

// ---- trends and fleet ------------------------------------------------------------------------------------

function buildTrends(call, { kind, limit }) {
  const { value, available } = call.tryCall('trends', { kind, limit }, []);
  return { available, kind: kind || null, rows: arr(value).map(withForecast).sort((a, b) => (sevRank(a.severity) - sevRank(b.severity))) };
}

function buildFleet(call, { days }) {
  const versions = call.tryCall('fleetVersions', {}, []);
  const avail = call.tryCall('availability', { days }, { devices: [], sites: [] });
  const noise = call.tryCall('alertNoise', { days }, { byDataSource: [], byDevice: [], repeatOffenders: [] });
  const reboots = call.tryCall('trends', { kind: 'reboot' }, []);
  const vv = versions.value;
  return {
    available: versions.available || avail.available || noise.available,
    days,
    versions: arr(vv, 'versions'),
    outliers: arr(vv && vv.outliers),
    availability: { devices: arr(avail.value, 'devices'), sites: arr(avail.value && avail.value.sites) },
    alertNoise: {
      byDataSource: arr(noise.value && noise.value.byDataSource),
      byDevice: arr(noise.value && noise.value.byDevice),
      repeatOffenders: arr(noise.value && noise.value.repeatOffenders),
    },
    reboots: arr(reboots.value).map((r) => ({ device: r.device, site: r.site, count: n2(r.value), events: arr(r.detail && r.detail.events) })),
  };
}

// ---- overview tiles --------------------------------------------------------------------------------------

/** { redundancyLost, opticsAtRisk, ifForecast30d, peersFlapping, reboots7d }, null for a figure whose feed is missing. */
function buildTiles(call, now) {
  const today = (now || new Date()).toISOString().slice(0, 10);
  const cutoff = new Date((now || new Date()).getTime() - 7 * 86400000).toISOString().slice(0, 10);
  const hw = call.tryCall('hardware', {}, null);
  const op = call.tryCall('optics', {}, null);
  const tr = call.tryCall('trends', { kind: 'if_util_forecast' }, null);
  const rt = call.tryCall('routingPeers', {}, null);
  const rb = call.tryCall('trends', { kind: 'reboot' }, null);
  const ifRows = tr.available ? arr(tr.value) : null;
  let reboots = null;
  if (rb.available) {
    reboots = 0;
    for (const r of arr(rb.value)) {
      for (const e of arr(r.detail && r.detail.events)) {
        const day = String(e.day || e.at || '').slice(0, 10);
        if (day && day >= cutoff && day <= today) reboots += 1;
      }
    }
  }
  return {
    redundancyLost: hw.available ? arr(hw.value && hw.value.derived && hw.value.derived.redundancyLost).length : null,
    opticsAtRisk: op.available ? arr(op.value).filter(opticAtRisk).length : null,
    ifForecast30d: ifRows ? ifRows.filter((r) => r.severity === 'critical' || (n2(r.daysToThreshold) != null && Number(r.daysToThreshold) <= 30)).length : null,
    peersFlapping: rt.available ? arr(rt.value).filter((r) => !r.shadowed && (r.flaps7d || 0) >= 3).length : null,
    reboots7d: reboots,
  };
}

// ---- router mount ----------------------------------------------------------------------------------------

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid parameters', details: errors.array() });
  return next();
};
const daysRule = query('days').optional().isInt({ min: 1, max: 365 }).toInt();
const limitRule = query('limit').optional().isInt({ min: 1, max: 500 }).toInt();

const HW_COLUMNS = ['device', 'site', 'model', 'component', 'instance', 'state', 'why', 'value', 'unit', 'sampledAt'];
const IFC_COLUMNS = ['device', 'ifName', 'p95InUtil', 'maxInUtil', 'p95OutUtil', 'maxOutUtil', 'daysTo80In', 'daysTo80Out', 'flaps', 'downSamples', 'samples', 'errorsSum', 'discardsSum'];

function mount(router, { coreApi, wrap }) {
  const feedsOf = () => (coreApi && coreApi.feeds ? coreApi.feeds : require('../../core/feeds'));
  const caller = () => makeCaller(feedsOf());
  const csv = (res, name, columns, rows) => sendCsv(res, `cisco-${name}-${new Date().toISOString().slice(0, 10)}.csv`, columns,
    rows.map((r) => columns.map((c) => (Array.isArray(r[c]) ? r[c].join('; ') : r[c]))));

  router.get('/hardware.csv', wrap((req, res) => csv(res, 'hardware', HW_COLUMNS, buildHardware(caller()).components)));
  router.get('/hardware', wrap((req, res) => res.json(buildHardware(caller()))));

  const ifRules = [query('tab').optional().isIn(['hot', 'flapping', 'errors']), daysRule, limitRule];
  router.get('/interfaces-analytics.csv', ifRules, validate, wrap((req, res) => {
    const out = buildInterfacesAnalytics(caller(), { tab: req.query.tab, days: req.query.days || 7, limit: req.query.limit || 200 });
    csv(res, `interfaces-${out.tab}`, IFC_COLUMNS.filter((c) => out.rows.some((r) => r[c] != null)), out.rows);
  }));
  router.get('/interfaces-analytics', ifRules, validate, wrap((req, res) => res.json(buildInterfacesAnalytics(caller(), { tab: req.query.tab, days: req.query.days || 7, limit: req.query.limit || 50 }))));

  router.get('/optics', wrap((req, res) => res.json(buildOptics(caller()))));
  router.get('/poe', wrap((req, res) => res.json(buildPoe(caller()))));
  router.get('/routing', wrap((req, res) => res.json(buildRouting(caller()))));
  router.get('/resources', [query('deviceId').optional().isInt().toInt(), query('sourceId').optional().isInt().toInt(), daysRule], validate,
    wrap((req, res) => res.json(buildResources(caller(), { days: req.query.days || 90, deviceId: req.query.deviceId, sourceId: req.query.sourceId }))));
  router.get('/reachability', [daysRule, limitRule], validate, wrap((req, res) => res.json(buildReachability(caller(), { days: req.query.days || 30, limit: req.query.limit || 20 }))));
  router.get('/wireless-analytics', [daysRule], validate, wrap((req, res) => res.json(buildWirelessAnalytics(caller(), { days: req.query.days || 30 }))));
  router.get('/fleet', [daysRule], validate, wrap((req, res) => res.json(buildFleet(caller(), { days: req.query.days || 30 }))));
  router.get('/trends', [query('kind').optional().isString().matches(/^[a-z_]{1,40}$/), limitRule], validate,
    wrap((req, res) => res.json(buildTrends(caller(), { kind: req.query.kind, limit: req.query.limit || 200 }))));
  router.get('/trend-series', [
    query('sourceId').isInt().toInt(), query('deviceId').isInt().toInt(), query('metric').isString().matches(/^[A-Za-z0-9_]{1,60}$/),
    query('instanceKey').optional().isString().isLength({ max: 200 }), query('days').optional().isInt({ min: 1, max: 365 }).toInt(),
    query('agg').optional().isIn(['max', 'min', 'avg', 'last']),
  ], validate, wrap((req, res) => {
    const q = req.query;
    const { value, available } = caller().tryCall('trendSeries', { sourceId: q.sourceId, deviceId: q.deviceId, metric: q.metric, instanceKey: q.instanceKey, days: q.days || 90, agg: q.agg || 'max' }, []);
    return res.json({ available, points: arr(value) });
  }));

  // The LogicMonitor interface pages read these under apiBase: list, csv, compare, history, plus the sites filter.
  const IF_LIST_RULES = [
    query('q').optional().isString().trim().isLength({ max: 200 }), query('deviceId').optional().isInt(), query('sourceId').optional().isInt(),
    query('status').optional().isIn(['up', 'down', 'other', 'unknown']), query('speedClass').optional().isString().isLength({ max: 16 }),
    query('vendor').optional().isString().trim().isLength({ max: 64 }), query('siteKey').optional().matches(/^[a-z0-9-]{1,80}$/),
    query('wan').optional().isIn(['0', '1']), query('preset').optional().isIn(['down', 'hot', 'errors', 'flapping', 'unused']),
    query('sort').optional().isString().isLength({ max: 40 }), query('dir').optional().isIn(['asc', 'desc']),
    query('page').optional().isInt({ min: 1 }), query('limit').optional().custom((v) => v === 'all' || (/^\d+$/.test(String(v)) && Number(v) <= 500)),
  ];
  const listParams = (req) => ({ ...req.query, limit: req.query.limit === 'all' ? 500 : (parseInt(req.query.limit, 10) || 25), page: parseInt(req.query.page, 10) || 1 });
  router.get('/interfaces.csv', IF_LIST_RULES, validate, wrap((req, res) => {
    const { value } = caller().tryCall('interfaces', { ...listParams(req), page: 1, limit: 5000 }, { items: [], total: 0 });
    csv(res, 'interfaces', ['deviceName', 'displayName', 'description', 'statusText', 'speedBps', 'inMbps', 'outMbps', 'inUtilPct', 'outUtilPct', 'inErrors', 'outErrors', 'inDiscards', 'outDiscards', 'sampledAt', 'siteKey'], arr(value));
  }));
  router.get('/interfaces/compare', [query('ids').isString().matches(/^\d+(,\d+)*$/), query('hours').optional().isInt({ min: 1, max: 2160 }).toInt(), query('sourceId').optional().isInt().toInt()], validate, wrap((req, res) => {
    const ids = [...new Set(req.query.ids.split(',').map(Number))];
    if (ids.length < 2 || ids.length > 8) return res.status(400).json({ error: 'Compare takes 2 to 8 interfaces.' });
    const { value } = caller().tryCall('interfaceCompare', { ids, hours: req.query.hours || 24, sourceId: req.query.sourceId }, { series: [] });
    return res.json(value && value.series ? value : { series: arr(value) });
  }));
  router.get('/interfaces', IF_LIST_RULES, validate, wrap((req, res) => {
    const p = listParams(req);
    const { value } = caller().tryCall('interfaces', p, { items: [], total: 0 });
    const items = arr(value);
    return res.json({ items, total: value && value.total != null ? value.total : items.length, page: p.page, limit: p.limit });
  }));
  router.get('/devices/:deviceId/interfaces/:instanceId/history', [param('deviceId').isInt().toInt(), param('instanceId').isInt().toInt(),
    query('hours').optional().isInt({ min: 1, max: 2160 }).toInt(), query('sourceId').optional().isInt().toInt()], validate, wrap((req, res) => {
    const { value } = caller().tryCall('interfaceHistory', { deviceId: req.params.deviceId, instanceId: req.params.instanceId, hours: req.query.hours || 24, sourceId: req.query.sourceId }, { points: [], daily: [] });
    return res.json(value && typeof value === 'object' ? value : { points: [], daily: [] });
  }));
  router.get('/summary', wrap((req, res) => res.json({ byVendor: [{ vendor: 'Cisco' }, { vendor: 'Meraki' }] })));
  router.get('/sites', wrap((req, res) => {
    const seen = new Map();
    for (const vendorKey of ['cisco', 'meraki']) {
      for (const d of arr(feedsOf().query(CONNECTOR, 'devices', { vendorKey }))) if (d.siteKey) seen.set(d.siteKey, d.siteName || d.siteKey);
    }
    res.json([...seen.entries()].map(([siteKey, siteName]) => ({ siteKey, siteName })));
  }));
}

module.exports = {
  mount, makeCaller, forecastOf, withForecast, buildHardware, buildInterfacesAnalytics, buildOptics, buildPoe, buildRouting, buildResources,
  buildReachability, buildWirelessAnalytics, buildTrends, buildFleet, buildTiles, opticAtRisk,
};
