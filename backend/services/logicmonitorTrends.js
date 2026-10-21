// Round 12: real trending data for the LogicMonitor Trends page. GET /trends
// keeps its estate `points` and gains `range`, `daily` (alerts raised, issues
// opened and latency episodes per time bucket) and `movers` (what got worse
// across the range: interfaces, WAN circuits, checks, devices, error counters).
//
// Each history table is read once with the cutoff bound and aggregated in JS.
// The result is cached for 60 s per range and tenant.
// icc-phase1: single tenant, one plain Map for the install.
const tenantMap = () => new Map();

const RANGE_HOURS = { '24h': 24, '7d': 168, '30d': 720, '90d': 2160, '365d': 8760 };
const CACHE_MS = 60 * 1000;
const cache = tenantMap(); // range -> { at, value }

const TOP_N = 10;

/** SQLite zoneless "YYYY-MM-DD HH:MM:SS" (UTC) from epoch ms. */
const sqlTs = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const parseTs = (v) => {
  if (v == null || v === '') return null;
  const s = String(v);
  const ms = Date.parse(/[TZ]/.test(s) || /[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
};
const tableExists = (dbh, name) => {
  try { return !!dbh.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name); } catch { return false; }
};

// ---- Buckets --------------------------------------------------------------------

/** Complete bucket list for a range: hourly for 24h, daily for 7d and 30d, ending with the bucket of now. */
function bucketKeys(range, nowMs) {
  const hourly = range === '24h';
  const n = hourly ? 24 : ({ '30d': 30, '90d': 90, '365d': 365 }[range] || 7);
  const step = hourly ? 3600000 : 86400000;
  const endBucket = Math.floor(nowMs / step) * step;
  const keys = [];
  for (let i = n - 1; i >= 0; i -= 1) keys.push(bucketOf(endBucket - i * step, hourly));
  return keys;
}
const bucketOf = (ms, hourly) => {
  const iso = new Date(ms).toISOString();
  return hourly ? iso.slice(0, 13) : iso.slice(0, 10);
};

const alertBucket = (sev) => (sev === 'critical' ? 'critical' : (sev === 'info' ? 'info' : 'warning'));

/** Alerts raised, issues opened, episodes opened per bucket. Zero filled. */
function buildDaily(dbh, range, nowMs = Date.now()) {
  const hourly = range === '24h';
  const buckets = bucketKeys(range, nowMs);
  const idx = new Map(buckets.map((k, i) => [k, i]));
  const zeros = () => buckets.map(() => 0);
  const startMs = Date.parse(hourly ? `${buckets[0]}:00:00Z` : `${buckets[0]}T00:00:00Z`);

  const alerts = { critical: zeros(), warning: zeros(), info: zeros() };
  if (tableExists(dbh, 'lm_alerts')) {
    const rows = dbh.prepare('SELECT start_epoch, severity_norm FROM lm_alerts WHERE start_epoch >= ?').all(Math.floor(startMs / 1000));
    for (const r of rows) {
      const i = idx.get(bucketOf(r.start_epoch * 1000, hourly));
      if (i != null) alerts[alertBucket(r.severity_norm)][i] += 1;
    }
  }

  const byType = new Map(); // type -> counts[]
  if (tableExists(dbh, 'lm_issue_history')) {
    const rows = dbh.prepare('SELECT type, first_seen FROM lm_issue_history WHERE first_seen >= ?').all(sqlTs(startMs));
    for (const r of rows) {
      const ms = parseTs(r.first_seen);
      const i = ms == null ? null : idx.get(bucketOf(ms, hourly));
      if (i == null) continue;
      const t = r.type || 'other';
      if (!byType.has(t)) byType.set(t, zeros());
      byType.get(t)[i] += 1;
    }
  }
  const ranked = [...byType.entries()].map(([t, arr]) => [t, arr, arr.reduce((a, b) => a + b, 0)]).sort((a, b) => b[2] - a[2] || a[0].localeCompare(b[0]));
  const types = ranked.slice(0, 6).map((r) => r[0]);
  const series = {};
  for (const [t, arr] of ranked.slice(0, 6)) series[t] = arr;
  const rest = ranked.slice(6);
  if (rest.length) {
    types.push('other');
    series.other = zeros();
    for (const [, arr] of rest) arr.forEach((v, i) => { series.other[i] += v; });
  }

  const episodes = { 'one-off': zeros(), sustained: zeros(), escalated: zeros(), open: zeros() };
  if (tableExists(dbh, 'lm_latency_episodes')) {
    const rows = dbh.prepare('SELECT opened_at, state, outcome FROM lm_latency_episodes').all();
    for (const r of rows) {
      const ms = parseTs(r.opened_at);
      const i = ms == null ? null : idx.get(bucketOf(ms, hourly));
      if (i == null) continue;
      const key = r.state === 'closed' ? (episodes[r.outcome] ? r.outcome : null) : 'open';
      if (key) episodes[key][i] += 1;
    }
  }

  return { bucket: hourly ? 'hour' : 'day', buckets, alerts, issues: { types, series }, episodes };
}

// ---- Movers ---------------------------------------------------------------------

/** Accumulates a before/after mean pair; the split is a timestamp comparison made by the caller. */
function acc(map, key, isAfter, v) {
  let e = map.get(key);
  if (!e) { e = { bs: 0, bn: 0, as: 0, an: 0 }; map.set(key, e); }
  if (isAfter) { e.as += v; e.an += 1; } else { e.bs += v; e.bn += 1; }
}
/** { before, after, delta } for an accumulator, or null when either half has too few samples. */
function halves(e, minSamples) {
  if (!e || e.bn < minSamples || e.an < minSamples) return null;
  const before = e.bs / e.bn;
  const after = e.as / e.an;
  return { before, after, delta: after - before };
}

function buildMovers(dbh, range, nowMs = Date.now()) {
  const hours = RANGE_HOURS[range];
  const minSamples = range === '24h' ? 3 : 6;
  const startMs = nowMs - hours * 3600000;
  const midMs = nowMs - (hours * 3600000) / 2;
  const startSql = sqlTs(startMs);
  const midSql = sqlTs(midMs);
  const out = { interfaces: [], circuits: [], checks: [], devices: [], errors: [] };

  const devName = new Map();
  try {
    for (const d of dbh.prepare('SELECT source_id, lm_device_id, display_name, name FROM lm_devices').all()) devName.set(`${d.source_id}:${d.lm_device_id}`, d.display_name || d.name);
  } catch { /* no devices */ }

  // Interfaces, WAN circuits and error counters: one pass over lm_interface_history.
  if (tableExists(dbh, 'lm_interface_history')) {
    const util = new Map();
    const errs = new Map();
    const it = dbh.prepare('SELECT source_id, instance_id, captured_at, in_util_pct, out_util_pct, in_errors, out_errors FROM lm_interface_history WHERE captured_at >= ?').iterate(startSql);
    for (const r of it) {
      const key = `${r.source_id}:${r.instance_id}`;
      const after = r.captured_at >= midSql;
      if (r.in_util_pct != null || r.out_util_pct != null) acc(util, key, after, Math.max(r.in_util_pct == null ? -1 : r.in_util_pct, r.out_util_pct == null ? -1 : r.out_util_pct));
      if (r.in_errors != null || r.out_errors != null) acc(errs, key, after, (r.in_errors || 0) + (r.out_errors || 0));
    }
    const meta = new Map();
    try {
      for (const r of dbh.prepare('SELECT source_id, instance_id, lm_device_id, display_name, description, is_wan FROM lm_interfaces WHERE stale = 0').all()) {
        meta.set(`${r.source_id}:${r.instance_id}`, r);
      }
    } catch { /* no interfaces */ }
    const shape = (key, h) => {
      const m = meta.get(key);
      if (!m) return null;
      return {
        sourceId: m.source_id, deviceId: m.lm_device_id, deviceName: devName.get(`${m.source_id}:${m.lm_device_id}`) || null,
        port: m.display_name, description: m.description || null, isWan: Number(m.is_wan) === 1,
        before: round1(h.before), after: round1(h.after), delta: round1(h.delta),
      };
    };
    const ifaceRows = [];
    const circuitRows = [];
    for (const [key, e] of util) {
      const h = halves(e, minSamples);
      if (!h) continue;
      const row = shape(key, h);
      if (!row) continue;
      if (row.isWan) circuitRows.push(row);
      if (h.delta >= 5) ifaceRows.push(row);
    }
    out.interfaces = ifaceRows.sort((a, b) => b.delta - a.delta).slice(0, TOP_N);
    out.circuits = circuitRows.sort((a, b) => b.delta - a.delta).slice(0, TOP_N);
    const errRows = [];
    for (const [key, e] of errs) {
      const h = halves(e, minSamples);
      if (!h || h.delta <= 0) continue;
      const row = shape(key, h);
      if (row) errRows.push(row);
    }
    out.errors = errRows.sort((a, b) => b.delta - a.delta).slice(0, TOP_N);
  }

  // Checks: round trip per check location.
  if (tableExists(dbh, 'lm_check_history')) {
    const lat = new Map();
    const it = dbh.prepare('SELECT source_id, check_id, checkpoint_id, captured_at, rtt_avg_ms FROM lm_check_history WHERE captured_at >= ? AND rtt_avg_ms IS NOT NULL').iterate(startSql);
    for (const r of it) acc(lat, `${r.source_id}|${r.check_id}|${r.checkpoint_id}`, r.captured_at >= midSql, r.rtt_avg_ms);
    const names = new Map();
    const labels = new Map();
    try {
      for (const c of dbh.prepare('SELECT source_id, check_id, name FROM lm_checks WHERE stale = 0').all()) names.set(`${c.source_id}|${c.check_id}`, c.name);
      for (const l of dbh.prepare('SELECT source_id, check_id, checkpoint_id, label, is_overall FROM lm_check_locations').all()) labels.set(`${l.source_id}|${l.check_id}|${l.checkpoint_id}`, l);
    } catch { /* no checks */ }
    const isOverall = (src, chk, cp) => cp === 'overall' || Number(labels.get(`${src}|${chk}|${cp}`)?.is_overall) === 1;
    const perLocation = new Set(); // checks with per-location history
    for (const key of lat.keys()) {
      const [src, chk, cp] = key.split('|');
      if (!isOverall(src, chk, cp)) perLocation.add(`${src}|${chk}`);
    }
    const rows = [];
    for (const [key, e] of lat) {
      const [src, chk, cp] = key.split('|');
      const overall = isOverall(src, chk, cp);
      if (overall && perLocation.has(`${src}|${chk}`)) continue;
      const h = halves(e, minSamples);
      if (!h) continue;
      const deltaMs = h.delta;
      const deltaPct = h.before > 0 ? (deltaMs / h.before) * 100 : null;
      if (deltaMs < 5 || deltaPct == null || deltaPct < 20) continue;
      const nm = names.get(`${src}|${chk}`);
      if (nm === undefined) continue;
      rows.push({
        sourceId: Number(src), checkId: chk, checkName: nm, label: overall ? 'Overall' : (labels.get(key)?.label || cp),
        beforeMs: round1(h.before), afterMs: round1(h.after), deltaMs: round1(deltaMs), deltaPct: round1(deltaPct),
      });
    }
    out.checks = rows.sort((a, b) => b.deltaMs - a.deltaMs).slice(0, TOP_N);
  }

  // Devices: CPU and memory, max across instances per device per sample.
  if (tableExists(dbh, 'lm_ds_metrics_history')) {
    const perSample = new Map(); // dev|metric|epoch -> max
    const it = dbh.prepare("SELECT source_id, lm_device_id, metric, value, sampled_at_epoch FROM lm_ds_metrics_history WHERE metric IN ('cpu_pct', 'mem_pct') AND sampled_at_epoch >= ? AND value IS NOT NULL").iterate(Math.floor(startMs / 1000));
    for (const r of it) {
      if (r.value < 0 || r.value > 100) continue;
      const k = `${r.source_id}:${r.lm_device_id}|${r.metric}|${r.sampled_at_epoch}`;
      const prev = perSample.get(k);
      if (prev === undefined || r.value > prev) perSample.set(k, r.value);
    }
    const midEpoch = Math.floor(midMs / 1000);
    const dev = new Map();
    for (const [k, v] of perSample) {
      const [dk, metric, epoch] = k.split('|');
      acc(dev, `${dk}|${metric}`, Number(epoch) >= midEpoch, v);
    }
    const rows = [];
    for (const [key, e] of dev) {
      const h = halves(e, minSamples);
      if (!h || h.delta < 5) continue;
      const [dk, metric] = key.split('|');
      const [src, id] = dk.split(':');
      rows.push({
        sourceId: Number(src), deviceId: Number(id), deviceName: devName.get(dk) || null, metric,
        before: round1(h.before), after: round1(h.after), delta: round1(h.delta),
      });
    }
    out.devices = rows.sort((a, b) => b.delta - a.delta).slice(0, TOP_N);
  }
  return out;
}

/** { range, daily, movers }, cached 60 s per range and tenant. opts.noCache skips the cache. */
function getTrends(dbh, range = '7d', opts = {}) {
  const r = RANGE_HOURS[range] ? range : '7d';
  const nowMs = opts.nowMs || Date.now();
  if (!opts.noCache) {
    const hit = cache.get(r);
    if (hit && nowMs - hit.at < CACHE_MS) return hit.value;
  }
  const value = { range: r, daily: buildDaily(dbh, r, nowMs), movers: buildMovers(dbh, r, nowMs) };
  if (!opts.noCache) cache.set(r, { at: nowMs, value });
  return value;
}

module.exports = { RANGE_HOURS, bucketKeys, buildDaily, buildMovers, getTrends };
