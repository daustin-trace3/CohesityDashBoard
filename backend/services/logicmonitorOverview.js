'use strict';

/**
 * LogicMonitor Overview rollup (round 5, option B "site map"). Everything is
 * computed from stored rows; nothing calls LogicMonitor. Every section is
 * guarded, so an empty or half-migrated database returns the full shape with
 * empty arrays and a null score.
 *
 * The route-local helpers (buildSites, buildDataQuality, safeIssues, locState)
 * are passed in by the route so this module never requires the router at load
 * time; when they are omitted they are resolved lazily from the routes module.
 */

const lmChecks = () => require('./logicmonitorChecks');
const lmPath = () => require('./logicmonitorPath');

const HOUR = 3600000;
const SEV_ORDER = { critical: 0, warning: 1, info: 2 };
const SEV_RANK = { ok: 0, warning: 1, critical: 2 };
const FORMULA = '100 - (0.5 x critical alerts + 2 x dead devices + 0.5 x ports down + 1 x degraded links + 3 x saturated circuits), clamped to 0 through 100';
const DC_NAME = /\b(dc|data ?cent(er|re)|hq|core)\b/i;
const DEGRADE_TYPES = ['check-down', 'latency-anomaly', 'packet-loss-anomaly', 'circuit-saturated'];
const CHECK_ISSUE_TYPES = new Set(['check-down', 'check-location-down', 'latency-anomaly', 'packet-loss-anomaly']);
const COLLECTOR_ISSUE_TYPES = new Set(['collector-down', 'collector-build-behind']);
const NO_TARGET_TYPES = new Set(['source-unreachable', 'alert-storm']);

function guard(fn, fallback) {
  try { const v = fn(); return v === undefined ? fallback : v; } catch { return fallback; }
}

function sqlMs(val) {
  if (!val) return null;
  const s = String(val);
  const ms = Date.parse(/[TZ]/.test(s) || /[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? null : ms;
}
const sqlIso = (val) => { const ms = sqlMs(val); return ms == null ? null : new Date(ms).toISOString(); };
function epochMs(v) {
  if (v == null || v === '' || !Number.isFinite(Number(v)) || Number(v) <= 0) return null;
  const n = Number(v);
  return n > 1e11 ? n : n * 1000;
}
const epochSec = (v) => { const ms = epochMs(v); return ms == null ? null : ms / 1000; };
const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

function routeHelpers() {
  const r = require('../routes/logicmonitor');
  return { buildSites: r.buildSites, buildDataQuality: r.buildDataQuality, safeIssues: r.safeIssues, locState: r.locState };
}

/** Pad or trim to exactly n points, oldest first, null at the front when short. */
function series24(values) {
  const v = values.slice(-24);
  return [...Array(24 - v.length).fill(null), ...v];
}

function emptyOverview(nowMs) {
  const hours = [];
  const cur = Math.floor(nowMs / HOUR) * HOUR;
  for (let i = 0; i < 24; i += 1) hours.push(new Date(cur - (23 - i) * HOUR).toISOString());
  const zeros = () => Array(24).fill(0);
  return {
    generatedAt: new Date(nowMs).toISOString(),
    health: { score: null, formula: FORMULA },
    counters: {
      devicesDead: 0, devicesDeadCollector: 0, interfacesDown: 0, interfaces: 0, linksDegraded: 0, checksDown: 0, checksDegraded: 0,
      circuitsSaturated: 0, circuits: 0, collectors: 0, collectorsDown: 0, coverageScore: null, shadowed: 0,
      alertsCritical: 0, alertsWarning: 0, alertsInfo: 0, openIssues: 0,
    },
    map: { nodes: [], edges: [], circuits: [] },
    burning: [],
    trends: {
      hours,
      alertsBySeverity: { critical: zeros(), warning: zeros(), info: zeros() },
      degradation: { linksDegraded: zeros(), portsDown: Array(24).fill(null) },
    },
  };
}

function buildOverview(db, { nowMs = Date.now(), helpers = null } = {}) {
  const out = emptyOverview(nowMs);
  const h = helpers || guard(routeHelpers, {});
  const locState = h.locState || ((e) => {
    if (e.anomaly === 'down' || e.status === 'down') return { state: 'down', severity: 'critical' };
    if (e.anomaly) return { state: 'degraded', severity: e.severity === 'critical' ? 'critical' : 'warning' };
    return { state: 'ok', severity: 'ok' };
  });
  const all = (sql, ...args) => guard(() => db.prepare(sql).all(...args), []);
  const one = (sql, ...args) => guard(() => db.prepare(sql).get(...args), null);

  // ---- Shared inputs, each read once ---------------------------------------
  const sources = all('SELECT id, name FROM lm_sources');
  const srcIdByName = new Map(sources.map((s) => [s.name, s.id]));
  const issues = guard(() => (h.safeIssues ? h.safeIssues() : []), []);
  const sites = guard(() => (h.buildSites ? h.buildSites() : []), []);
  const evaluated = guard(() => lmChecks().evaluateLocations(db, { nowMs }) || [], []);
  const circuitRows = guard(() => lmPath().circuitRows(db, { nowMs }) || [], []);
  const devices = all('SELECT source_id, lm_device_id, name, display_name, site_key, host_status, collector_id FROM lm_devices WHERE stale = 0');
  const collectorRows = all('SELECT source_id, collector_id, hostname, description, is_down, site_key FROM lm_collectors WHERE stale = 0');
  const siteNameByKey = new Map(all('SELECT source_id, site_key, site_name FROM lm_sites').map((s) => [`${s.source_id}|${s.site_key}`, s.site_name]));
  const checkRows = all('SELECT source_id, check_id, name, site_key FROM lm_checks WHERE stale = 0');
  const locRows = all('SELECT source_id, check_id, checkpoint_id, label, collector_id, is_overall, site_key FROM lm_check_locations WHERE stale = 0');
  const collectorSite = new Map(collectorRows.map((c) => [`${c.source_id}|${c.collector_id}`, c.site_key]));
  const collectorName = new Map(collectorRows.map((c) => [`${c.source_id}|${c.collector_id}`, c.hostname || c.description || `collector ${c.collector_id}`]));

  // ---- Counters --------------------------------------------------------------
  const deadDevices = devices.filter((d) => d.host_status === 'dead').length;
  const deadCollectorDevices = devices.filter((d) => d.host_status === 'dead-collector').length;
  const ifs = one(`
    SELECT COUNT(*) total,
      COALESCE(SUM(CASE WHEN (status_text = 'down' OR (status_text IS NULL AND status = 2)) AND COALESCE(stop_monitoring, 0) = 0 THEN 1 ELSE 0 END), 0) down
    FROM lm_interfaces WHERE stale = 0
  `) || { total: 0, down: 0 };
  const al = one(`
    SELECT COALESCE(SUM(CASE WHEN severity_norm = 'critical' THEN 1 ELSE 0 END), 0) critical,
      COALESCE(SUM(CASE WHEN severity_norm = 'warning' THEN 1 ELSE 0 END), 0) warning,
      COALESCE(SUM(CASE WHEN severity_norm = 'info' THEN 1 ELSE 0 END), 0) info
    FROM lm_alerts WHERE cleared = 0 AND duplicate_of IS NULL
  `) || { critical: 0, warning: 0, info: 0 };
  const shadowed = (one('SELECT COUNT(*) n FROM lm_alerts WHERE cleared = 0 AND shadowed_by IS NOT NULL') || { n: 0 }).n;
  const wanCount = (one('SELECT COUNT(*) n FROM lm_interfaces WHERE is_wan = 1 AND stale = 0') || { n: 0 }).n;
  const saturated = circuitRows.filter((c) => c.satState !== 'ok').length;

  // Per check worst state (non-overall locations, or all when only Overall exists).
  const byCheck = new Map();
  for (const e of evaluated) {
    const k = `${e.sourceId}|${e.checkId}`;
    if (!byCheck.has(k)) byCheck.set(k, []);
    byCheck.get(k).push(e);
  }
  let checksDown = 0;
  let checksDegraded = 0;
  for (const locs of byCheck.values()) {
    const per = locs.filter((l) => !l.isOverall);
    const pool = per.length ? per : locs;
    const states = pool.map((l) => locState(l).state);
    if (states.includes('down')) checksDown += 1;
    else if (states.includes('degraded')) checksDegraded += 1;
  }
  const linksDegraded = checksDown + checksDegraded;
  const coverage = guard(() => (h.buildDataQuality ? h.buildDataQuality().coverageScore : null), null);

  const c = out.counters;
  c.devicesDead = deadDevices;
  c.devicesDeadCollector = deadCollectorDevices;
  c.interfacesDown = ifs.down;
  c.interfaces = ifs.total;
  c.linksDegraded = linksDegraded;
  c.checksDown = checksDown;
  c.checksDegraded = checksDegraded;
  c.circuitsSaturated = saturated;
  c.circuits = wanCount;
  c.collectors = collectorRows.length;
  c.collectorsDown = collectorRows.filter((x) => Number(x.is_down) === 1).length;
  c.coverageScore = coverage == null ? null : coverage;
  c.shadowed = shadowed;
  c.alertsCritical = al.critical;
  c.alertsWarning = al.warning;
  c.alertsInfo = al.info;
  c.openIssues = issues.length;
  out.health.score = devices.length
    ? Math.max(0, Math.min(100, Math.round(100 - (0.5 * al.critical + 2 * deadDevices + 0.5 * ifs.down + linksDegraded + 3 * saturated))))
    : null;

  // ---- Issue to site / device resolution (shared by nodes and burning) ------
  const devByName = new Map();
  for (const d of devices) {
    for (const n of [d.display_name, d.name]) {
      if (!n) continue;
      const k = `${d.source_id}|${String(n).toLowerCase()}`;
      if (!devByName.has(k)) devByName.set(k, d);
    }
  }
  const checkByName = new Map(checkRows.map((r) => [`${r.source_id}|${String(r.name || '').toLowerCase()}`, r]));
  const collectorByName = new Map();
  for (const col of collectorRows) {
    for (const n of [col.hostname, col.description]) if (n) collectorByName.set(`${col.source_id}|${String(n).toLowerCase()}`, col);
  }
  /** Longest leading run of words that names a device; rest is the port. */
  function resolveDevice(sourceId, target) {
    const words = String(target || '').split(' ').filter(Boolean);
    for (let n = words.length; n >= 1; n -= 1) {
      const d = devByName.get(`${sourceId}|${words.slice(0, n).join(' ').toLowerCase()}`);
      if (d) return { dev: d, rest: words.slice(n).join(' ') || null };
    }
    return null;
  }
  function resolveIssue(i) {
    const sid = srcIdByName.get(i.source);
    const res = { sourceId: sid == null ? null : sid, siteKey: null, device: null, port: null, check: null, checkpointLabel: null };
    if (sid == null || NO_TARGET_TYPES.has(i.type)) return res;
    if (CHECK_ISSUE_TYPES.has(i.type)) {
      const at = String(i.target).lastIndexOf(' @ ');
      const name = at >= 0 ? String(i.target).slice(0, at) : String(i.target);
      res.checkpointLabel = at >= 0 ? String(i.target).slice(at + 3) : null;
      const ck = checkByName.get(`${sid}|${name.toLowerCase()}`);
      if (ck) { res.check = ck; res.siteKey = ck.site_key || null; }
      return res;
    }
    if (COLLECTOR_ISSUE_TYPES.has(i.type)) {
      const col = collectorByName.get(`${sid}|${String(i.target).toLowerCase()}`);
      if (col) res.siteKey = col.site_key || null;
      return res;
    }
    const r = resolveDevice(sid, i.target);
    if (r) { res.device = r.dev; res.port = r.rest; res.siteKey = r.dev.site_key || null; return res; }
    const first = String(i.target || '').split(' ')[0].toLowerCase();
    const col = collectorByName.get(`${sid}|${String(i.target || '').toLowerCase()}`) || collectorByName.get(`${sid}|${first}`);
    if (col) res.siteKey = col.site_key || null;
    return res;
  }
  const resolved = issues.map((i) => ({ issue: i, res: guard(() => resolveIssue(i), { sourceId: null, siteKey: null, device: null, port: null, check: null, checkpointLabel: null }) }));
  const openIssuesBySite = new Map();
  for (const r of resolved) {
    if (!r.res.siteKey || r.res.sourceId == null) continue;
    const k = `${r.res.sourceId}|${r.res.siteKey}`;
    openIssuesBySite.set(k, (openIssuesBySite.get(k) || 0) + 1);
  }

  // ---- Map: nodes ------------------------------------------------------------
  guard(() => {
    const deadBySite = new Map();
    const collectorUse = new Map();
    for (const d of devices) {
      if (d.site_key) {
        const k = `${d.source_id}|${d.site_key}`;
        const e = deadBySite.get(k) || { dead: 0, deadCollector: 0 };
        if (d.host_status === 'dead-collector') e.deadCollector += 1;
        deadBySite.set(k, e);
        if (d.collector_id != null) {
          const u = collectorUse.get(k) || new Map();
          u.set(d.collector_id, (u.get(d.collector_id) || 0) + 1);
          collectorUse.set(k, u);
        }
      }
    }
    const satBySite = new Map();
    for (const cr of circuitRows) {
      if (cr.satState === 'ok' || !cr.siteKey) continue;
      const k = `${cr.sourceId}|${cr.siteKey}`;
      satBySite.set(k, (satBySite.get(k) || 0) + 1);
    }
    const byNetwork = [...sites].sort((a, b) => (b.networkCount || 0) - (a.networkCount || 0) || String(a.siteName).localeCompare(String(b.siteName)));
    const topCount = Math.max(1, Math.floor(sites.length / 4));
    const topKeys = new Set(byNetwork.slice(0, topCount).map((s) => `${s.sourceId}|${s.siteKey}`));
    // Inbound reachability per site: one grouped query over the 24 hour buckets,
    // plus the worst inbound check location (same pick buildSites makes).
    const winStartSec = (Math.floor(nowMs / HOUR) * HOUR - 23 * HOUR) / 1000;
    const winEndSec = winStartSec + 24 * 3600;
    const reachSeries = new Map();
    for (const r of all(`
      SELECT c.source_id AS sid, c.site_key AS site_key, CAST((h.sample_epoch - ?) / 3600 AS INTEGER) AS bucket, AVG(h.rtt_avg_ms) AS rtt
      FROM lm_check_history h
      JOIN lm_checks c ON c.source_id = h.source_id AND c.check_id = h.check_id
      JOIN lm_check_locations l ON l.source_id = h.source_id AND l.check_id = h.check_id AND l.checkpoint_id = h.checkpoint_id
      WHERE c.stale = 0 AND c.site_key IS NOT NULL AND COALESCE(l.is_overall, 0) = 0
        AND h.sample_epoch >= ? AND h.sample_epoch < ? AND h.rtt_avg_ms IS NOT NULL
      GROUP BY c.source_id, c.site_key, bucket
    `, winStartSec, winStartSec, winEndSec)) {
      const k = `${r.sid}|${r.site_key}`;
      if (!reachSeries.has(k)) reachSeries.set(k, Array(24).fill(null));
      if (r.bucket >= 0 && r.bucket < 24) reachSeries.get(k)[r.bucket] = Math.round(r.rtt * 100) / 100;
    }
    // Outbound fallback: locations hosted at the site (own site_key, else the collector's).
    const outSeries = new Map();
    for (const r of all(`
      SELECT l.source_id AS sid, COALESCE(l.site_key, col.site_key) AS site_key, CAST((h.sample_epoch - ?) / 3600 AS INTEGER) AS bucket, AVG(h.rtt_avg_ms) AS rtt
      FROM lm_check_history h
      JOIN lm_check_locations l ON l.source_id = h.source_id AND l.check_id = h.check_id AND l.checkpoint_id = h.checkpoint_id
      JOIN lm_checks c ON c.source_id = l.source_id AND c.check_id = l.check_id
      LEFT JOIN lm_collectors col ON col.source_id = l.source_id AND col.collector_id = l.collector_id
      WHERE c.stale = 0 AND l.stale = 0 AND COALESCE(l.is_overall, 0) = 0 AND COALESCE(l.site_key, col.site_key) IS NOT NULL
        AND h.sample_epoch >= ? AND h.sample_epoch < ? AND h.rtt_avg_ms IS NOT NULL
      GROUP BY l.source_id, COALESCE(l.site_key, col.site_key), bucket
    `, winStartSec, winStartSec, winEndSec)) {
      const k = `${r.sid}|${r.site_key}`;
      if (!outSeries.has(k)) outSeries.set(k, Array(24).fill(null));
      if (r.bucket >= 0 && r.bucket < 24) outSeries.get(k)[r.bucket] = Math.round(r.rtt * 100) / 100;
    }
    const hasInbound = new Set(checkRows.filter((r) => r.site_key).map((r) => `${r.source_id}|${r.site_key}`));
    const locSiteOf = new Map(locRows.map((l) => [`${l.source_id}|${l.check_id}|${l.checkpoint_id}`,
      l.site_key || (l.collector_id != null ? collectorSite.get(`${l.source_id}|${l.collector_id}`) : null) || null]));
    const outWorst = new Map();
    for (const e of evaluated) {
      if (e.isOverall) continue;
      const site = locSiteOf.get(`${e.sourceId}|${e.checkId}|${e.checkpointId}`);
      if (!site) continue;
      const ls = locState(e);
      const k = `${e.sourceId}|${site}`;
      const cur = outWorst.get(k);
      if (!cur || SEV_RANK[ls.severity] > SEV_RANK[cur.ls.severity]
        || (ls.severity === cur.ls.severity && (e.rttAvgMs || 0) > (cur.l.rttAvgMs || 0))) outWorst.set(k, { l: e, ls });
    }
    const checkSiteOf = new Map(checkRows.map((r) => [`${r.source_id}|${r.check_id}`, r.site_key]));
    const worstBySite = new Map();
    for (const [ck, locs] of byCheck) {
      const site = checkSiteOf.get(ck);
      if (!site) continue;
      const per = locs.filter((l) => !l.isOverall);
      for (const l of (per.length ? per : locs)) {
        const ls = locState(l);
        const k = `${l.sourceId}|${site}`;
        const cur = worstBySite.get(k);
        if (!cur || SEV_RANK[ls.severity] > SEV_RANK[cur.ls.severity]
          || (ls.severity === cur.ls.severity && (l.rttAvgMs || 0) > (cur.l.rttAvgMs || 0))) worstBySite.set(k, { l, ls });
      }
    }
    const countOf = (arr) => (arr ? arr.filter((v) => v != null).length : 0);
    const reach = (k) => {
      const inN = countOf(reachSeries.get(k));
      const outN = countOf(outSeries.get(k));
      let direction = null;
      if (inN || outN) direction = outN > inN ? 'out' : 'in';
      else if (hasInbound.has(k)) direction = 'in';
      else if (outWorst.has(k)) direction = 'out';
      const w = direction === 'in' ? worstBySite.get(k) : direction === 'out' ? outWorst.get(k) : null;
      const series = direction === 'in' ? reachSeries.get(k) : direction === 'out' ? outSeries.get(k) : null;
      return {
        label: 'RTT ms',
        direction,
        series: series || Array(24).fill(null),
        worst: w ? {
          checkName: w.l.checkName, fromLabel: w.l.label, state: w.ls.state,
          rttAvgMs: num(w.l.rttAvgMs), lossPct: num(w.l.lossPct), anomaly: w.l.anomaly || null,
        } : null,
      };
    };
    // Latency watch counts per site: ONE grouped query over the episode table.
    const watchBySite = new Map();
    try {
      const cut = new Date(nowMs - 7 * 86400000).toISOString();
      const rows = db.prepare(`SELECT source_id AS sid, site_key AS sk, state, outcome, COUNT(*) AS n FROM lm_latency_episodes
        WHERE site_key IS NOT NULL AND (opened_at >= ? OR state != 'closed') GROUP BY source_id, site_key, state, outcome`).all(cut);
      for (const r of rows) {
        const key = `${r.sid}|${r.sk}`;
        const w = watchBySite.get(key) || { degrading: 0, critical: 0, oneOff7d: 0 };
        if (r.state === 'degrading') w.degrading += r.n;
        else if (r.state === 'critical') w.critical += r.n;
        else if (r.state === 'closed' && r.outcome === 'one-off') w.oneOff7d += r.n;
        watchBySite.set(key, w);
      }
    } catch { /* episode table missing on an unmigrated database */ }
    out.map.nodes = sites.map((s) => {
      const k = `${s.sourceId}|${s.siteKey}`;
      let viaCollector = null;
      if (!s.collectors.length) {
        const use = collectorUse.get(k);
        if (use) {
          let best = null;
          for (const [cid, n] of use) if (!best || n > best.n) best = { cid, n };
          if (best) viaCollector = collectorName.get(`${s.sourceId}|${best.cid}`) || null;
        }
      }
      const dead = deadBySite.get(k) || { deadCollector: 0 };
      return {
        siteKey: s.siteKey, siteName: s.siteName, sourceId: s.sourceId, state: s.state,
        tier: DC_NAME.test(String(s.siteName)) || topKeys.has(k) ? 'dc' : 'site',
        deviceCount: s.deviceCount, networkCount: s.networkCount,
        devicesDead: s.devicesDead, devicesDeadCollector: dead.deadCollector, interfacesDown: s.interfacesDown,
        collectors: s.collectors.map((x) => ({ hostname: x.hostname, isDown: x.isDown })),
        viaCollector,
        circuitsSaturated: satBySite.get(k) || 0,
        openIssues: openIssuesBySite.get(k) || 0,
        reachability: reach(k),
        watch: watchBySite.get(k) || { degrading: 0, critical: 0, oneOff7d: 0 },
      };
    });
  }, null);

  // ---- Map: edges ------------------------------------------------------------
  guard(() => {
    const checkSite = new Map(checkRows.map((r) => [`${r.source_id}|${r.check_id}`, r.site_key]));
    const locSite = new Map(locRows.map((l) => [`${l.source_id}|${l.check_id}|${l.checkpoint_id}`,
      l.site_key || (l.collector_id != null ? collectorSite.get(`${l.source_id}|${l.collector_id}`) : null) || null]));
    // since: oldest open check issue for the check or the check at that location.
    const openHist = all("SELECT issue_key, source, type, target, first_seen FROM lm_issue_history WHERE status = 'open'");
    const sinceByTarget = new Map();
    for (const r of openHist) {
      if (!CHECK_ISSUE_TYPES.has(r.type)) continue;
      const k = `${r.source}|${String(r.target).toLowerCase()}`;
      const ms = sqlMs(r.first_seen);
      if (ms != null && (!sinceByTarget.has(k) || ms < sinceByTarget.get(k))) sinceByTarget.set(k, ms);
    }
    const pairs = new Map();
    for (const locs of byCheck.values()) {
      for (const l of locs) {
        if (l.isOverall) continue;
        const from = locSite.get(`${l.sourceId}|${l.checkId}|${l.checkpointId}`);
        const to = checkSite.get(`${l.sourceId}|${l.checkId}`);
        if (!from || !to || from === to) continue;
        const ls = locState(l);
        const key = `${from}>${to}`;
        if (!pairs.has(key)) pairs.set(key, { key, from, to, perCheck: new Map() });
        const p = pairs.get(key);
        const ck = `${l.sourceId}|${l.checkId}`;
        const cur = p.perCheck.get(ck);
        if (!cur || SEV_RANK[ls.severity] > SEV_RANK[cur.ls.severity]
          || (ls.severity === cur.ls.severity && (l.rttAvgMs || 0) > (cur.l.rttAvgMs || 0))) p.perCheck.set(ck, { l, ls });
      }
    }
    if (!pairs.size) return;
    let lastGood = new Map();
    const anyBad = [...pairs.values()].some((p) => [...p.perCheck.values()].some((x) => x.ls.state !== 'ok'));
    if (anyBad) {
      lastGood = new Map(all("SELECT source_id, check_id, checkpoint_id, MAX(sample_epoch) e FROM lm_check_history WHERE status = 'up' GROUP BY source_id, check_id, checkpoint_id")
        .map((r) => [`${r.source_id}|${r.check_id}|${r.checkpoint_id}`, r.e]));
    }
    let pctx = null;
    const rank = (x, y) => SEV_RANK[y.ls.severity] - SEV_RANK[x.ls.severity] || (y.l.rttAvgMs || 0) - (x.l.rttAvgMs || 0);
    out.map.edges = [...pairs.values()].map((p) => {
      const entries = [...p.perCheck.values()].sort(rank);
      const worst = entries[0];
      let blame = null;
      if (worst.ls.state !== 'ok') {
        try {
          pctx = pctx || lmPath().makeContext(db);
          const b = lmPath().blameForCheck(db, worst.l.checkId, worst.l.checkpointId, { ctx: pctx, sourceId: worst.l.sourceId });
          if (b) blame = { deviceName: b.deviceName, port: b.port || null, state: b.state || null, reason: b.reason || null };
        } catch { blame = null; }
      }
      return {
        key: p.key, from: p.from, to: p.to, state: worst.ls.state, severity: worst.ls.severity,
        rttAvgMs: num(worst.l.rttAvgMs), lossPct: num(worst.l.lossPct), anomaly: worst.l.anomaly || null,
        checks: entries.slice(0, 8).map(({ l, ls }) => {
          const lg = lastGood.get(`${l.sourceId}|${l.checkId}|${l.checkpointId}`);
          const sinceMs = ls.state === 'ok' ? null
            : (sinceByTarget.get(`${l.sourceName}|${`${l.checkName} @ ${l.label}`.toLowerCase()}`)
              ?? sinceByTarget.get(`${l.sourceName}|${String(l.checkName).toLowerCase()}`) ?? null);
          const goodMs = ls.state === 'ok' ? epochMs(l.sampleEpoch) : epochMs(lg);
          return {
            checkId: l.checkId, checkName: l.checkName, checkpointLabel: l.label, state: ls.state,
            rttAvgMs: num(l.rttAvgMs), lossPct: num(l.lossPct), anomaly: l.anomaly || null,
            baselineRttMs: num(l.baselineRttMs), lastGoodAt: goodMs == null ? null : new Date(goodMs).toISOString(),
            since: sinceMs == null ? null : new Date(sinceMs).toISOString(),
          };
        }),
        blame,
      };
    }).sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || (b.rttAvgMs || 0) - (a.rttAvgMs || 0) || a.key.localeCompare(b.key));
  }, null);

  // ---- Map: circuits ---------------------------------------------------------
  guard(() => {
    const bad = circuitRows.filter((r) => r.state !== 'ok');
    if (!bad.length) return;
    const descs = new Map(all('SELECT source_id, instance_id, description FROM lm_interfaces WHERE is_wan = 1 AND stale = 0')
      .map((r) => [`${r.source_id}|${r.instance_id}`, r.description || '']));
    const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tokens = [];
    for (const n of out.map.nodes) {
      for (const t of new Set([n.siteName, n.siteKey])) {
        if (t && String(t).length >= 2) tokens.push({ siteKey: n.siteKey, token: String(t), re: new RegExp(`(^|[^a-z0-9])${escRe(String(t).toLowerCase())}([^a-z0-9]|$)`) });
      }
    }
    tokens.sort((a, b) => b.token.length - a.token.length);
    out.map.circuits = bad.map((r) => {
      const hay = `${r.label || ''} ${descs.get(`${r.sourceId}|${r.instanceId}`) || ''}`.toLowerCase();
      const hit = tokens.find((t) => t.siteKey !== r.siteKey && t.re.test(hay));
      return {
        siteKey: r.siteKey, deviceName: r.deviceName, port: r.port, label: r.label, state: r.state,
        p95InPct: num(r.p95InPct), p95OutPct: num(r.p95OutPct), farSiteKey: hit ? hit.siteKey : null,
      };
    });
  }, null);

  // ---- Burning ---------------------------------------------------------------
  guard(() => {
    const openRows = all("SELECT issue_key, first_seen FROM lm_issue_history WHERE status = 'open' ORDER BY id");
    const sinceByKey = new Map();
    for (const r of openRows) {
      const ms = sqlMs(r.first_seen);
      if (ms != null && (!sinceByKey.has(r.issue_key) || ms < sinceByKey.get(r.issue_key))) sinceByKey.set(r.issue_key, ms);
    }
    const ranked = resolved.map((r) => {
      const key = `${r.issue.type}|${r.issue.source}|${r.issue.target}`;
      return { ...r, key, sinceMs: sinceByKey.has(key) ? sinceByKey.get(key) : null };
    }).sort((a, b) => (SEV_ORDER[a.issue.severity] ?? 3) - (SEV_ORDER[b.issue.severity] ?? 3)
      || (a.sinceMs == null) - (b.sinceMs == null) || (b.sinceMs || 0) - (a.sinceMs || 0)
      || a.key.localeCompare(b.key)).slice(0, 6);

    const ifStmt = guard(() => db.prepare('SELECT in_util_pct, out_util_pct, in_errors, out_errors FROM lm_interface_history WHERE source_id = ? AND instance_id = ? ORDER BY captured_at DESC, id DESC LIMIT 24'), null);
    const ifLookup = guard(() => db.prepare('SELECT instance_id FROM lm_interfaces WHERE source_id = ? AND lm_device_id = ? AND display_name = ? ORDER BY stale ASC LIMIT 1'), null);
    const locStmt = guard(() => db.prepare('SELECT checkpoint_id, is_overall, last_status FROM lm_check_locations WHERE source_id = ? AND check_id = ? AND stale = 0'), null);
    const ckStmt = guard(() => db.prepare('SELECT rtt_avg_ms, loss_pct FROM lm_check_history WHERE source_id = ? AND check_id = ? AND checkpoint_id = ? ORDER BY sample_epoch DESC, id DESC LIMIT 24'), null);

    const metricFor = (r) => {
      const { type } = r.issue;
      const { res } = r;
      if (/^interface-|^circuit-saturated$/.test(type) && res.device && res.port && ifStmt && ifLookup) {
        const inst = ifLookup.get(res.sourceId, res.device.lm_device_id, res.port);
        if (!inst) return null;
        const rows = ifStmt.all(res.sourceId, inst.instance_id).reverse();
        if (type === 'interface-error-anomaly' || type === 'interface-errors-growing') {
          return { label: 'errors', series: series24(rows.map((x) => ((x.in_errors || 0) + (x.out_errors || 0)))) };
        }
        return { label: 'util %', series: series24(rows.map((x) => (x.in_util_pct == null && x.out_util_pct == null ? null : Math.max(x.in_util_pct ?? 0, x.out_util_pct ?? 0)))) };
      }
      if (CHECK_ISSUE_TYPES.has(type) && res.check && locStmt && ckStmt) {
        const isLoss = type === 'packet-loss-anomaly';
        const col = isLoss ? 'loss_pct' : 'rtt_avg_ms';
        const eval_ = byCheck.get(`${res.sourceId}|${res.check.check_id}`) || [];
        const stateOf = new Map(eval_.map((e) => [e.checkpointId, SEV_RANK[locState(e).severity]]));
        const cands = locStmt.all(res.sourceId, res.check.check_id).map((l) => {
          const rows = ckStmt.all(res.sourceId, res.check.check_id, l.checkpoint_id).reverse();
          return { l, rows, samples: rows.filter((x) => num(x[col]) != null).length, sev: stateOf.get(l.checkpoint_id) || 0 };
        });
        const per = cands.filter((x) => !Number(x.l.is_overall) && x.samples > 0);
        const pool = per.length ? per : cands.filter((x) => Number(x.l.is_overall) && x.samples > 0);
        if (!pool.length) return null;
        pool.sort((a, b) => b.sev - a.sev || b.samples - a.samples);
        return { label: isLoss ? 'loss %' : 'RTT ms', series: series24(pool[0].rows.map((x) => num(x[col]))) };
      }
      return null;
    };
    const hopFor = (msg) => {
      const m = /Likely hop:\s*([^]*?)(?:\s+since\s+\d{4}-\d\d-\d\d[^]*)?$/.exec(String(msg || ''));
      if (!m) return null;
      const text = m[1].trim();
      if (!text) return null;
      const head = text.split(',')[0].trim();
      return { head, text };
    };

    // One path context for the whole pass (the expensive part), built lazily.
    let pctx = null;
    const ctxOf = () => { pctx = pctx || lmPath().makeContext(db); return pctx; };
    const worstCheckpoint = (res) => {
      const locs = byCheck.get(`${res.sourceId}|${res.check.check_id}`) || [];
      if (res.checkpointLabel != null) {
        const hit = locs.find((l) => l.label === res.checkpointLabel);
        if (hit) return hit.checkpointId;
      }
      const per = locs.filter((l) => !l.isOverall);
      const pool = per.length ? per : locs;
      const best = [...pool].sort((a, b) => SEV_RANK[locState(b).severity] - SEV_RANK[locState(a).severity])[0];
      return best ? best.checkpointId : null;
    };
    const hopOf = (r) => {
      const { issue, res } = r;
      const fromMessage = hopFor(issue.message);
      if (fromMessage) {
        const rd = resolveDevice(res.sourceId, fromMessage.head);
        return rd
          ? { deviceName: rd.dev.display_name || rd.dev.name, port: rd.rest, text: fromMessage.text }
          : { deviceName: fromMessage.head.split(' ')[0], port: fromMessage.head.split(' ').slice(1).join(' ') || null, text: fromMessage.text };
      }
      let b = null;
      let own = null;
      if (CHECK_ISSUE_TYPES.has(issue.type) && res.check) {
        b = lmPath().blameForCheck(db, res.check.check_id, worstCheckpoint(res), { ctx: ctxOf(), sourceId: res.sourceId });
      } else {
        let dev = res.device;
        if (!dev && COLLECTOR_ISSUE_TYPES.has(issue.type) && res.sourceId != null) {
          const rd = resolveDevice(res.sourceId, issue.target);
          dev = rd ? rd.dev : null;
        }
        if (dev) {
          own = dev.display_name || dev.name;
          const hops = lmPath().pathFor(db, { names: [own], ips: [] }, { ctx: ctxOf() });
          b = lmPath().blame(hops);
        }
      }
      if (!b || b.state === 'ok') return null;
      const port = b.port || null;
      const label = port ? `${b.deviceName} ${port}` : (own && b.deviceName === own ? `${b.deviceName} (itself)` : b.deviceName);
      return { deviceName: b.deviceName, port, text: `${label}${b.reason ? `, ${b.reason}` : ''}` };
    };

    out.burning = ranked.map((r) => {
      const { issue, res } = r;
      const likelyHop = guard(() => hopOf(r), null);
      return {
        issueKey: r.key, severity: issue.severity, type: issue.type, target: issue.target, message: issue.message,
        since: r.sinceMs == null ? null : new Date(r.sinceMs).toISOString(),
        siteKey: res.siteKey || null,
        siteName: res.siteKey ? (siteNameByKey.get(`${res.sourceId}|${res.siteKey}`) || res.siteKey) : null,
        likelyHop,
        metric: guard(() => metricFor(r), null),
      };
    });
  }, null);

  // ---- Trends ----------------------------------------------------------------
  const curHour = Math.floor(nowMs / HOUR) * HOUR;
  const bucketStarts = Array.from({ length: 24 }, (_, i) => curHour - (23 - i) * HOUR);
  const winStartMs = bucketStarts[0];
  const winEndMs = curHour + HOUR;
  guard(() => {
    const rows = all(`
      SELECT severity_norm, start_epoch, end_epoch, cleared FROM lm_alerts
      WHERE start_epoch IS NOT NULL AND start_epoch <= ?
        AND (cleared = 0 OR end_epoch IS NULL OR end_epoch >= ?)
    `, winEndMs / 1000, winStartMs / 1000);
    const t = out.trends.alertsBySeverity;
    for (const r of rows) {
      const sev = r.severity_norm;
      if (!t[sev]) continue;
      const startS = epochSec(r.start_epoch);
      const endS = epochSec(r.end_epoch);
      for (let i = 0; i < 24; i += 1) {
        const bucketEndS = (bucketStarts[i] + HOUR) / 1000;
        if (startS != null && startS <= bucketEndS && (Number(r.cleared) === 0 || endS == null || endS >= bucketEndS)) t[sev][i] += 1;
      }
    }
  }, null);
  guard(() => {
    const ph = DEGRADE_TYPES.map(() => '?').join(',');
    const winStart = new Date(winStartMs).toISOString().replace('T', ' ').slice(0, 19);
    const rows = all(`SELECT first_seen, resolved_at FROM lm_issue_history WHERE type IN (${ph}) AND (resolved_at IS NULL OR resolved_at >= ?)`, ...DEGRADE_TYPES, winStart);
    const arr = out.trends.degradation.linksDegraded;
    for (const r of rows) {
      const f = sqlMs(r.first_seen);
      const e = r.resolved_at ? sqlMs(r.resolved_at) : null;
      if (f == null) continue;
      for (let i = 0; i < 24; i += 1) {
        const bucketEnd = bucketStarts[i] + HOUR;
        if (f <= bucketEnd && (e == null || e >= bucketEnd)) arr[i] += 1;
      }
    }
  }, null);
  guard(() => {
    const from = new Date(winStartMs - 24 * HOUR).toISOString().replace('T', ' ').slice(0, 19);
    const rows = all('SELECT source_id, captured_at, interfaces_down FROM lm_metrics_history WHERE captured_at >= ? AND interfaces_down IS NOT NULL ORDER BY captured_at, id', from)
      .map((r) => ({ sid: r.source_id, ms: sqlMs(r.captured_at), v: r.interfaces_down })).filter((r) => r.ms != null);
    if (!rows.length) return;
    const cur = new Map();
    let idx = 0;
    const arr = out.trends.degradation.portsDown;
    for (let i = 0; i < 24; i += 1) {
      const bucketEnd = bucketStarts[i] + HOUR;
      while (idx < rows.length && rows[idx].ms < bucketEnd) { cur.set(rows[idx].sid, rows[idx].v); idx += 1; }
      arr[i] = cur.size ? [...cur.values()].reduce((a, b) => a + b, 0) : null;
    }
  }, null);

  return out;
}

module.exports = { buildOverview, FORMULA };
