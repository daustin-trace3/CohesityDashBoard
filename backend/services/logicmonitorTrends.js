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


// ---- Trend findings (LogicMonitor-derived analytics for the Cisco and F5 platforms) --------------------------
// Pure of the db singleton: every function takes the database handle. computeTrendFindings runs once an hour
// per source in the poller and rebuilds lm_trend_findings from the daily history tables (lm_ds_daily,
// lm_interface_daily); the connector feeds only read that table. A forecast is an ESTIMATE: it always carries
// its basis (window, points, R2, slope) and answers null (reason insufficient_points / weak_fit /
// wrong_direction) instead of extrapolating from too little data.

const DAY_MS = 86400000;
const dayOfMs = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayIndex = (day) => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const r4 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10000) / 10000);
const finite = (v) => v != null && Number.isFinite(Number(v));

const TREND_DEFAULTS = {
  lm_trend_min_points: 7, lm_trend_min_r2: 0.5, lm_optic_margin_warn_db: 2, lm_poe_warn_pct: 90,
  lm_if_forecast_pct: 80, lm_trend_window_days: 90,
};

/** Series points normalised to { day, value, samples }, ascending, finite only. */
function cleanPoints(points) {
  return (points || [])
    .filter((p) => p && p.day && finite(p.value))
    .map((p) => ({ day: p.day, value: Number(p.value), samples: p.samples > 0 ? Number(p.samples) : 1 }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/**
 * Weighted least squares over the day index (real gaps honoured, weights = samples per day).
 * Returns { slopePerDay, intercept, r2, n, firstDay, lastDay, x0 } where intercept is the fitted value on firstDay.
 */
function linearFit(points) {
  const pts = cleanPoints(points);
  const n = pts.length;
  if (n === 0) return { slopePerDay: 0, intercept: null, r2: 0, n: 0, firstDay: null, lastDay: null, x0: null };
  const x0 = dayIndex(pts[0].day);
  if (n === 1) return { slopePerDay: 0, intercept: pts[0].value, r2: 0, n, firstDay: pts[0].day, lastDay: pts[0].day, x0 };
  let sw = 0; let swx = 0; let swy = 0; let swxx = 0; let swxy = 0; let swyy = 0;
  for (const p of pts) {
    const x = dayIndex(p.day) - x0; const w = p.samples;
    sw += w; swx += w * x; swy += w * p.value; swxx += w * x * x; swxy += w * x * p.value; swyy += w * p.value * p.value;
  }
  const denom = sw * swxx - swx * swx;
  const slope = denom > 1e-12 ? (sw * swxy - swx * swy) / denom : 0;
  const intercept = (swy - slope * swx) / sw;
  let ssRes = 0;
  for (const p of pts) {
    const x = dayIndex(p.day) - x0;
    const e = p.value - (intercept + slope * x);
    ssRes += p.samples * e * e;
  }
  const ssTot = swyy - (swy * swy) / sw;
  const r2 = ssTot > 1e-9 ? Math.max(0, Math.min(1, 1 - ssRes / ssTot)) : 0;
  return { slopePerDay: slope, intercept, r2, n, firstDay: pts[0].day, lastDay: pts[n - 1].day, x0 };
}

/**
 * Estimated days until the series crosses `threshold` along its linear trend.
 * opts: minPoints (7), minR2 (0.5), direction 'up' | 'down'.
 * Returns { days: number | null, basis: { windowDays, n, r2, slopePerDay, reason } } with reason one of
 * insufficient_points | weak_fit | wrong_direction | already_past | ok. already_past answers days 0.
 */
function daysUntil(points, threshold, opts = {}) {
  const minPoints = opts.minPoints != null ? opts.minPoints : TREND_DEFAULTS.lm_trend_min_points;
  const minR2 = opts.minR2 != null ? opts.minR2 : TREND_DEFAULTS.lm_trend_min_r2;
  const up = (opts.direction || 'up') !== 'down';
  const pts = cleanPoints(points);
  const basis = {
    windowDays: pts.length ? dayIndex(pts[pts.length - 1].day) - dayIndex(pts[0].day) + 1 : 0,
    n: pts.length, r2: null, slopePerDay: null, reason: 'insufficient_points',
  };
  if (pts.length < minPoints) return { days: null, basis };
  const fit = linearFit(pts);
  basis.r2 = r4(fit.r2); basis.slopePerDay = r4(fit.slopePerDay);
  const latest = pts[pts.length - 1].value;
  if (up ? latest >= threshold : latest <= threshold) { basis.reason = 'already_past'; return { days: 0, basis }; }
  if (fit.r2 < minR2) { basis.reason = 'weak_fit'; return { days: null, basis }; }
  if (up ? fit.slopePerDay <= 0 : fit.slopePerDay >= 0) { basis.reason = 'wrong_direction'; return { days: null, basis }; }
  const xLast = dayIndex(fit.lastDay) - fit.x0;
  const fitLast = fit.intercept + fit.slopePerDay * xLast;
  const remaining = up ? threshold - fitLast : fitLast - threshold;
  basis.reason = 'ok';
  return { days: r1(Math.max(0, remaining / Math.abs(fit.slopePerDay))), basis };
}

/**
 * Resets of a monotonic counter (uptime, BGP established time). points: { day, value, min?, last? } ascending.
 * A reset is a day whose lowest value is below the previous day's last value, so a reboot that regrows inside
 * the day is still seen. Returns [{ day, from, to }].
 */
function resetEvents(points) {
  const pts = (points || []).filter((p) => p && p.day && finite(p.value)).sort((a, b) => (a.day < b.day ? -1 : 1));
  const out = [];
  for (let i = 1; i < pts.length; i += 1) {
    const prev = pts[i - 1]; const cur = pts[i];
    const prevEnd = finite(prev.last) ? Number(prev.last) : Number(prev.value);
    const lo = finite(cur.min) ? Number(cur.min) : Number(cur.value);
    if (lo < prevEnd - 1) out.push({ day: cur.day, from: prevEnd, to: lo });
  }
  return out;
}

/**
 * Days on which a state metric changed. rows: { day, min, max, last? } ascending. A day counts when its min and
 * max differ, or when it holds one value that differs from the previous day's last value.
 */
function stateChanges(rows) {
  const rs = (rows || []).filter((r) => r && r.day && finite(r.min) && finite(r.max)).sort((a, b) => (a.day < b.day ? -1 : 1));
  const out = [];
  for (let i = 0; i < rs.length; i += 1) {
    const r = rs[i];
    const prev = i ? rs[i - 1] : null;
    const prevEnd = prev ? (finite(prev.last) ? Number(prev.last) : Number(prev.max)) : null;
    if (r.min !== r.max || (prevEnd != null && prevEnd !== r.min)) out.push({ day: r.day, min: r.min, max: r.max });
  }
  return out;
}

const AGG_KEYS = { max: 'max', min: 'min', avg: 'avg', last: 'last' };

/**
 * Daily points of one catalog metric from lm_ds_daily: [{ day, value, samples }]. Without hdsId / instanceKey the
 * instances of the device are combined per day (avg = sum / samples, max and min across instances, last = highest
 * last value). days is the look-back window.
 */
function dailySeries(dbh, { sourceId, deviceId, hdsId, instanceKey, metric, days = 90, agg = 'avg', nowMs } = {}) {
  const a = AGG_KEYS[agg] || 'avg';
  const where = ["kind = 'catalog'", 'source_id = ?', 'lm_device_id = ?', 'metric = ?', 'day >= ?', 'samples > 0'];
  const args = [sourceId, deviceId, metric, dayOfMs((nowMs || Date.now()) - days * DAY_MS)];
  if (hdsId != null) { where.push('hds_id = ?'); args.push(hdsId); }
  if (instanceKey != null) { where.push('instance_key = ?'); args.push(instanceKey); }
  const rows = dbh.prepare(`
    SELECT day, SUM(samples) samples, SUM(sum_value) s, MIN(min_value) mn, MAX(max_value) mx, MAX(last_value) lv
    FROM lm_ds_daily WHERE ${where.join(' AND ')} GROUP BY day ORDER BY day
  `).all(...args);
  return rows.map((r) => ({
    day: r.day, samples: r.samples,
    value: a === 'max' ? r.mx : a === 'min' ? r.mn : a === 'last' ? r.lv : (r.samples ? r.s / r.samples : null),
  }));
}

/** Daily points of lm_interface_daily for one interface: column util_in|util_out|errors|discards|flaps|down_samples. */
function interfaceDailySeries(dbh, { sourceId, deviceId, ifIndex, ifName, column = 'util_in', days = 90, nowMs } = {}) {
  const col = {
    util_in: 'max_in_util_pct', util_out: 'max_out_util_pct', avg_util_in: 'avg_in_util_pct', avg_util_out: 'avg_out_util_pct',
    errors: 'errors_sum', discards: 'discards_sum', flaps: 'flaps', down_samples: 'down_samples',
  }[column] || 'max_in_util_pct';
  const where = ['i.source_id = ?', 'i.lm_device_id = ?', 'd.day >= ?'];
  const args = [sourceId, deviceId, dayOfMs((nowMs || Date.now()) - days * DAY_MS)];
  if (ifIndex != null) { where.push('i.if_index = ?'); args.push(ifIndex); }
  if (ifName != null) { where.push('(i.display_name = ? OR i.instance_name = ?)'); args.push(ifName, ifName); }
  return dbh.prepare(`
    SELECT d.day day, d.samples samples, MAX(d.${col}) value
    FROM lm_interface_daily d JOIN lm_interfaces i ON i.source_id = d.source_id AND i.instance_id = d.instance_id
    WHERE ${where.join(' AND ')} GROUP BY d.day ORDER BY d.day
  `).all(...args).filter((r) => r.value != null);
}

// ---- Optic sensor kind from the instance name --------------------------------------------------------------
// Cisco_Transceiver_Sensors is a generic sensor table: the kind is in the instance name. The live fixture has
// datapoint names only, NOT instance names, so these patterns are ASSUMED from Cisco ENTITY-SENSOR naming and
// need the box to confirm them. Examples handled: "Ethernet1/1 Transceiver Rx Power Sensor", "Te1/0/1 Receive
// Power", "Gi1/0/2 Tx Power", "Ethernet1/1 Module Temperature Sensor", "Ethernet1/1 Bias Current",
// "Ethernet1/1 Supply Voltage". Anything else is unknown.
function sensorKind(name) {
  const s = String(name || '');
  if (/\b(rx|receive[dr]?)\b/i.test(s)) return 'rx_power';
  if (/\b(tx|transmit(ter)?)\b/i.test(s)) return 'tx_power';
  if (/temp/i.test(s)) return 'temperature';
  if (/bias|current/i.test(s)) return 'bias';
  if (/volt/i.test(s)) return 'voltage';
  return 'unknown';
}

// ---- Severity rule shared by the forecast kinds ----------------------------------------------------------------
const sevFromDays = (days) => (days == null ? 'info' : days <= 7 ? 'critical' : days <= 30 ? 'warning' : 'info');

const KINDS = [
  'if_util_forecast', 'cpu_forecast', 'mem_creep', 'fs_forecast', 'optic_margin', 'poe_forecast', 'thermal_trend',
  'reboot', 'peer_flap', 'state_change', 'conn_anomaly',
];

const STATE_CHANGE_METRICS = ['stack_role', 'sup_state', 'sup1_state', 'sup2_state', 'stack_member_state', 'failover_state', 'sync_state', 'daemon_exit', 'wideip_avail'];
const FLAP_COUNTER_METRICS = ['bgp_established_s', 'eigrp_uptime_s'];
const FLAP_STATE_METRICS = ['bgp_peer_state', 'ospf_nbr_state'];

/** Every lm_ds_daily series of the given metrics since sinceDay: [{ dev, hds, key, ds, metric, rows: [{day,samples,min,max,last,avg}] }]. */
function loadSeries(dbh, sourceId, metrics, sinceDay) {
  const stmt = dbh.prepare(`
    SELECT lm_device_id, hds_id, instance_key, datasource_name, metric, day, samples, min_value, sum_value, max_value, last_value
    FROM lm_ds_daily WHERE source_id = ? AND kind = 'catalog' AND day >= ? AND samples > 0 AND metric IN (${metrics.map(() => '?').join(',')})
    ORDER BY lm_device_id, hds_id, instance_key, metric, day
  `);
  const out = [];
  let cur = null;
  for (const r of stmt.iterate(sourceId, sinceDay, ...metrics)) {
    if (!cur || cur.dev !== r.lm_device_id || cur.hds !== r.hds_id || cur.key !== r.instance_key || cur.metric !== r.metric) {
      cur = { dev: r.lm_device_id, hds: r.hds_id, key: r.instance_key, ds: r.datasource_name, metric: r.metric, rows: [] };
      out.push(cur);
    }
    cur.rows.push({ day: r.day, samples: r.samples, min: r.min_value, max: r.max_value, last: r.last_value, avg: r.sum_value / r.samples });
  }
  return out;
}

/**
 * Rebuild lm_trend_findings for one source. opts: { nowMs, thresholds }. thresholds defaults to the stored
 * settings (lm_trend_* keys). Computes before it opens the write transaction. Returns
 * { written, deleted, ms, byKind }.
 */
function computeTrendFindings(dbh, { sourceId, now, nowMs, thresholds } = {}) {
  const started = Date.now();
  const clock = nowMs != null ? nowMs : (now instanceof Date ? now.getTime() : (typeof now === 'number' ? now : Date.now()));
  if (!tableExists(dbh, 'lm_trend_findings') || !tableExists(dbh, 'lm_ds_daily')) return { written: 0, deleted: 0, ms: 0, byKind: {} };
  let t = thresholds;
  if (!t) { try { t = require('./logicmonitorIssues').getThresholds(); } catch { t = {}; } }
  t = { ...TREND_DEFAULTS, ...t };
  const windowDays = Math.max(14, Number(t.lm_trend_window_days) || 90);
  const sinceDay = dayOfMs(clock - windowDays * DAY_MS);
  const dayCut = (days) => dayOfMs(clock - days * DAY_MS);
  const stamp = new Date(clock).toISOString();

  const devs = new Map();
  for (const d of dbh.prepare('SELECT lm_device_id, vendor_key, vendor_kind, display_name, name FROM lm_devices WHERE source_id = ? AND stale = 0').all(sourceId)) {
    devs.set(d.lm_device_id, { vendorKey: d.vendor_key || null, vendorKind: d.vendor_kind || null, name: d.display_name || d.name });
  }
  const inst = new Map();
  for (const i of dbh.prepare('SELECT lm_device_id, hds_id, instance_key, instance_name, stale FROM lm_ds_instances WHERE source_id = ?').all(sourceId)) {
    inst.set(`${i.lm_device_id}|${i.hds_id}|${i.instance_key}`, { name: i.instance_name || i.instance_key, stale: i.stale === 1 });
  }
  const subjectOf = (s) => { const i = inst.get(`${s.dev}|${s.hds}|${s.key}`); return i ? i.name : s.key; };
  const staleInst = (s) => { const i = inst.get(`${s.dev}|${s.hds}|${s.key}`); return !!(i && i.stale); };

  const rows = [];
  const byKind = {};
  const add = (kind, devId, subject, metric, o) => {
    const dv = devs.get(devId);
    if (!dv) return;
    rows.push({
      source_id: sourceId, lm_device_id: devId, vendor_key: dv.vendorKey, kind, subject: String(subject).slice(0, 200), metric,
      value: finite(o.value) ? Number(o.value) : null, threshold: finite(o.threshold) ? Number(o.threshold) : null,
      days_to_threshold: finite(o.days) ? Number(o.days) : null, slope_per_day: finite(o.slope) ? r4(o.slope) : null,
      r2: finite(o.r2) ? r4(o.r2) : null, n: o.n != null ? o.n : null, severity: o.severity || 'info',
      basis_json: JSON.stringify(o.basis || {}), detail_json: JSON.stringify(o.detail || {}), computed_at: stamp,
    });
    byKind[kind] = (byKind[kind] || 0) + 1;
  };
  const ptsOf = (rowsIn, field) => rowsIn.map((r) => ({ day: r.day, value: r[field], samples: r.samples }));
  const basisOf = (res, pts, agg, extra) => ({
    windowDays: res.basis.windowDays, n: res.basis.n, r2: res.basis.r2, slopePerDay: res.basis.slopePerDay,
    agg, firstDay: pts.length ? pts[0].day : null, lastDay: pts.length ? pts[pts.length - 1].day : null, note: res.basis.reason, ...(extra || {}),
  });
  const forecastOpts = { minPoints: t.lm_trend_min_points, minR2: t.lm_trend_min_r2 };

  // Per-device aggregate series (highest instance per day) for cpu and memory.
  const deviceDaily = (list) => {
    const byDev = new Map();
    for (const s of list) {
      if (!devs.has(s.dev) || staleInst(s)) continue;
      let m = byDev.get(s.dev);
      if (!m) { m = new Map(); byDev.set(s.dev, m); }
      for (const r of s.rows) {
        const prev = m.get(r.day);
        if (!prev || r.avg > prev.value) m.set(r.day, { value: r.avg, samples: r.samples });
      }
    }
    const out = new Map();
    for (const [dev, m] of byDev) out.set(dev, [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, v]) => ({ day, value: v.value, samples: v.samples })));
    return out;
  };

  // reboot: resets of the uptime counter (also feeds mem_creep).
  const rebootDays = new Map();
  {
    const series = loadSeries(dbh, sourceId, ['uptime_s'], dayCut(Math.max(windowDays, 90)));
    const perDev = new Map();
    for (const s of series) {
      if (!devs.has(s.dev) || staleInst(s)) continue;
      const ev = resetEvents(s.rows.map((r) => ({ day: r.day, value: r.max, min: r.min, last: r.last })));
      if (!ev.length) continue;
      const a = perDev.get(s.dev) || [];
      a.push(...ev);
      perDev.set(s.dev, a);
    }
    for (const [dev, ev] of perDev) {
      ev.sort((a, b) => (a.day < b.day ? -1 : 1));
      rebootDays.set(dev, ev.map((e) => e.day));
      const d7 = dayCut(7);
      add('reboot', dev, 'device', 'uptime_s', {
        value: ev.length, severity: 'info', n: ev.length,
        basis: { windowDays: Math.max(windowDays, 90), agg: 'min', firstDay: ev[0].day, lastDay: ev[ev.length - 1].day, note: 'counter reset' },
        detail: { events: ev.map((e) => ({ day: e.day, from: e.from, to: e.to })), events7d: ev.filter((e) => e.day >= d7).length },
      });
    }
  }

  // cpu_forecast, mem_creep: device level (highest instance per day).
  {
    const series = loadSeries(dbh, sourceId, ['cpu_pct', 'mem_pct'], sinceDay);
    const cpu = deviceDaily(series.filter((s) => s.metric === 'cpu_pct'));
    const mem = deviceDaily(series.filter((s) => s.metric === 'mem_pct'));
    for (const [dev, pts] of cpu) {
      if (pts.length < 2) continue;
      const res = daysUntil(pts, 80, { ...forecastOpts, direction: 'up' });
      add('cpu_forecast', dev, 'device', 'cpu_pct', {
        value: pts[pts.length - 1].value, threshold: 80, days: res.days, slope: res.basis.slopePerDay, r2: res.basis.r2, n: res.basis.n,
        severity: sevFromDays(res.days), basis: basisOf(res, pts, 'avg (highest instance per day)'),
      });
    }
    for (const [dev, pts] of mem) {
      if (pts.length < 14) continue;
      const fit = linearFit(pts);
      if (fit.r2 <= 0.7 || fit.slopePerDay < 0.05) continue;
      const resets = (rebootDays.get(dev) || []).filter((d) => d >= fit.firstDay);
      if (resets.length) continue;
      const res = daysUntil(pts, 95, { minPoints: 14, minR2: 0.7, direction: 'up' });
      add('mem_creep', dev, 'device', 'mem_pct', {
        value: pts[pts.length - 1].value, threshold: 95, days: res.days, slope: fit.slopePerDay, r2: fit.r2, n: pts.length, severity: 'warning',
        basis: basisOf(res, pts, 'avg (highest instance per day)', { note: 'memory rising with no reboot in the window, possible leak' }),
        detail: { rebootsInWindow: 0, firstValue: pts[0].value },
      });
    }
  }

  // fs_forecast: per filesystem instance, 95 on Cisco flash, 90 elsewhere.
  {
    const series = loadSeries(dbh, sourceId, ['fs_used_pct'], sinceDay);
    for (const s of series) {
      const dv = devs.get(s.dev);
      if (!dv || staleInst(s)) continue;
      const pts = ptsOf(s.rows, 'avg');
      if (pts.length < 2) continue;
      const cisco = dv.vendorKey === 'cisco' || dv.vendorKey === 'meraki';
      const keep = cisco || dv.vendorKey === 'f5';
      const thr = cisco ? 95 : 90;
      const res = daysUntil(pts, thr, { ...forecastOpts, direction: 'up' });
      if (!keep && res.days == null) continue;
      add('fs_forecast', s.dev, subjectOf(s), 'fs_used_pct', {
        value: pts[pts.length - 1].value, threshold: thr, days: res.days, slope: res.basis.slopePerDay, r2: res.basis.r2, n: res.basis.n,
        severity: sevFromDays(res.days), basis: basisOf(res, pts, 'avg'),
      });
    }
  }

  // poe_forecast: poe_used_pct per switch or stack member.
  {
    const series = loadSeries(dbh, sourceId, ['poe_used_pct'], sinceDay);
    for (const s of series) {
      if (!devs.has(s.dev) || staleInst(s)) continue;
      const pts = ptsOf(s.rows, 'avg');
      if (pts.length < 2) continue;
      const thr = t.lm_poe_warn_pct;
      const res = daysUntil(pts, thr, { ...forecastOpts, direction: 'up' });
      add('poe_forecast', s.dev, subjectOf(s) || 'device', 'poe_used_pct', {
        value: pts[pts.length - 1].value, threshold: thr, days: res.days, slope: res.basis.slopePerDay, r2: res.basis.r2, n: res.basis.n,
        severity: sevFromDays(res.days), basis: basisOf(res, pts, 'avg'),
      });
    }
  }

  // thermal_trend: daily maximum temperature; only sensors that rose 3 C or more over the last 30 days.
  {
    const series = loadSeries(dbh, sourceId, ['temp_c'], sinceDay);
    for (const s of series) {
      if (!devs.has(s.dev) || staleInst(s)) continue;
      const pts = ptsOf(s.rows, 'max');
      if (pts.length < t.lm_trend_min_points) continue;
      const fit = linearFit(pts);
      const cut = dayCut(30);
      const recent = pts.filter((p) => p.day >= cut);
      if (recent.length < 2) continue;
      const delta = recent[recent.length - 1].value - recent[0].value;
      if (delta < 3 || fit.slopePerDay <= 0) continue;
      add('thermal_trend', s.dev, subjectOf(s), 'temp_c', {
        value: pts[pts.length - 1].value, slope: fit.slopePerDay, r2: fit.r2, n: pts.length, severity: 'info',
        basis: { windowDays: dayIndex(fit.lastDay) - dayIndex(fit.firstDay) + 1, n: pts.length, r2: r4(fit.r2), slopePerDay: r4(fit.slopePerDay), agg: 'max', firstDay: fit.firstDay, lastDay: fit.lastDay, note: 'daily maximum' },
        detail: { delta30d: r1(delta), from: r1(recent[0].value), to: r1(recent[recent.length - 1].value) },
      });
    }
  }

  // optic_margin: receive power above its low warning, daily minimum per Rx instance.
  {
    const series = loadSeries(dbh, sourceId, ['optic_value', 'optic_low_warn'], sinceDay);
    const low = new Map();
    for (const s of series) if (s.metric === 'optic_low_warn') low.set(`${s.dev}|${s.hds}|${s.key}`, new Map(s.rows.map((r) => [r.day, r.last != null ? r.last : r.avg])));
    for (const s of series) {
      if (s.metric !== 'optic_value' || !devs.has(s.dev) || staleInst(s)) continue;
      const subject = subjectOf(s);
      if (sensorKind(subject) !== 'rx_power') continue;
      const lw = low.get(`${s.dev}|${s.hds}|${s.key}`);
      if (!lw) continue;
      const pts = [];
      for (const r of s.rows) {
        const l = lw.get(r.day);
        if (l != null && r.min != null) pts.push({ day: r.day, value: r.min - l, samples: r.samples });
      }
      if (pts.length < 2) continue;
      const res = daysUntil(pts, 0, { ...forecastOpts, direction: 'down' });
      const margin = pts[pts.length - 1].value;
      const slope = res.basis.slopePerDay;
      const fitOk = res.basis.reason === 'ok' || res.basis.reason === 'already_past';
      const falling = fitOk && slope != null && slope < -0.1;
      let sev = 'info';
      if (margin <= 0 || (res.days != null && res.days <= 14)) sev = 'critical';
      else if (margin < t.lm_optic_margin_warn_db || falling) sev = 'warning';
      if (sev === 'info' && res.days == null) continue;
      add('optic_margin', s.dev, subject, 'rx_margin_db', {
        value: margin, threshold: 0, days: res.days, slope, r2: res.basis.r2, n: res.basis.n, severity: sev,
        basis: basisOf(res, pts, 'min'), detail: { sensorKind: 'rx_power', lowWarn: lw.get(pts[pts.length - 1].day) },
      });
    }
  }

  // peer_flap: counter resets (BGP established time, EIGRP uptime) and state changes (BGP, OSPF) per peer.
  {
    const series = loadSeries(dbh, sourceId, [...FLAP_COUNTER_METRICS, ...FLAP_STATE_METRICS], dayCut(Math.min(windowDays, 90)));
    const d7 = dayCut(7); const d30 = dayCut(30);
    for (const s of series) {
      if (!devs.has(s.dev) || staleInst(s)) continue;
      const counter = FLAP_COUNTER_METRICS.includes(s.metric);
      const ev = counter
        ? resetEvents(s.rows.map((r) => ({ day: r.day, value: r.max, min: r.min, last: r.last })))
        : stateChanges(s.rows.map((r) => ({ day: r.day, min: r.min, max: r.max, last: r.last })));
      const n30 = ev.filter((e) => e.day >= d30).length;
      if (!n30) continue;
      const n7 = ev.filter((e) => e.day >= d7).length;
      add('peer_flap', s.dev, subjectOf(s), s.metric, {
        value: n7, n: ev.length, severity: n7 >= 3 ? 'warning' : 'info',
        basis: { windowDays: Math.min(windowDays, 90), agg: counter ? 'min' : 'min/max', firstDay: ev[0].day, lastDay: ev[ev.length - 1].day, note: 'reset or state-change days' },
        detail: { events: ev, events7d: n7, events30d: n30 },
      });
    }
  }

  // state_change: days with a state transition over 90 days.
  {
    const series = loadSeries(dbh, sourceId, STATE_CHANGE_METRICS, dayCut(Math.min(windowDays, 90)));
    const d30 = dayCut(30);
    for (const s of series) {
      if (!devs.has(s.dev) || staleInst(s)) continue;
      const ev = stateChanges(s.rows.map((r) => ({ day: r.day, min: r.min, max: r.max, last: r.last })));
      if (!ev.length) continue;
      add('state_change', s.dev, subjectOf(s), s.metric, {
        value: ev.filter((e) => e.day >= d30).length, n: ev.length, severity: 'info',
        basis: { windowDays: Math.min(windowDays, 90), agg: 'min/max', firstDay: ev[0].day, lastDay: ev[ev.length - 1].day, note: 'days with a state change' },
        detail: { events: ev, days: ev.map((e) => e.day), lastChangeDay: ev[ev.length - 1].day, count90d: ev.length },
      });
    }
  }

  // if_util_forecast: interface peak utilisation from lm_interface_daily.
  if (tableExists(dbh, 'lm_interface_daily') && tableExists(dbh, 'lm_interfaces')) {
    const names = new Map();
    for (const i of dbh.prepare('SELECT instance_id, lm_device_id, COALESCE(display_name, instance_name) nm, stale FROM lm_interfaces WHERE source_id = ?').all(sourceId)) {
      if (i.stale !== 1 && devs.has(i.lm_device_id)) names.set(i.instance_id, { dev: i.lm_device_id, name: i.nm });
    }
    const thr = t.lm_if_forecast_pct;
    const flush = (instId, inPts, outPts) => {
      const meta = names.get(instId);
      if (!meta) return;
      for (const [metric, pts] of [['max_in_util_pct', inPts], ['max_out_util_pct', outPts]]) {
        if (pts.length < 2) continue;
        const res = daysUntil(pts, thr, { ...forecastOpts, direction: 'up' });
        if (res.days == null || res.days > 180) continue;
        add('if_util_forecast', meta.dev, meta.name || String(instId), metric, {
          value: pts[pts.length - 1].value, threshold: thr, days: res.days, slope: res.basis.slopePerDay, r2: res.basis.r2, n: res.basis.n,
          severity: sevFromDays(res.days), basis: basisOf(res, pts, 'max'),
        });
      }
    };
    let cur = null; let inPts = []; let outPts = [];
    for (const r of dbh.prepare(`
      SELECT instance_id, day, samples, max_in_util_pct, max_out_util_pct FROM lm_interface_daily
      WHERE source_id = ? AND day >= ? ORDER BY instance_id, day
    `).iterate(sourceId, sinceDay)) {
      if (cur !== r.instance_id) { if (cur != null) flush(cur, inPts, outPts); cur = r.instance_id; inPts = []; outPts = []; }
      const w = r.samples || 1;
      if (r.max_in_util_pct != null) inPts.push({ day: r.day, value: r.max_in_util_pct, samples: w });
      if (r.max_out_util_pct != null) outPts.push({ day: r.day, value: r.max_out_util_pct, samples: w });
    }
    if (cur != null) flush(cur, inPts, outPts);
  }

  // conn_anomaly (F5): current client connections against the hour-of-day median and MAD.
  if (tableExists(dbh, 'lm_ds_metric_baseline') && tableExists(dbh, 'lm_ds_metrics')) {
    const cur = dbh.prepare("SELECT lm_device_id, hds_id, instance_key, value, sampled_at_epoch FROM lm_ds_metrics WHERE source_id = ? AND metric = 'client_connections' AND value IS NOT NULL").all(sourceId);
    const base = dbh.prepare("SELECT median, mad, samples FROM lm_ds_metric_baseline WHERE source_id = ? AND lm_device_id = ? AND hds_id = ? AND instance_key = ? AND metric = 'client_connections' AND hour_of_day = ?");
    for (const c of cur) {
      const dv = devs.get(c.lm_device_id);
      if (!dv || !c.sampled_at_epoch) continue;
      if (clock / 1000 - c.sampled_at_epoch > 7200) continue;
      const hour = new Date(c.sampled_at_epoch * 1000).getUTCHours();
      const b = base.get(sourceId, c.lm_device_id, c.hds_id, c.instance_key, hour);
      if (!b || b.median == null) continue;
      const scale = 1.4826 * Math.max(b.mad || 0, Math.abs(b.median) * 0.05, 1);
      const z = (c.value - b.median) / scale;
      if (Math.abs(z) <= 3) continue;
      add('conn_anomaly', c.lm_device_id, 'device', 'client_connections', {
        value: c.value, threshold: b.median, n: b.samples, severity: 'warning',
        basis: { windowDays: 7, agg: 'hour-of-day median', note: `z ${r1(z)} against the ${String(hour).padStart(2, '0')}:00 UTC baseline` },
        detail: { direction: z > 0 ? 'spike' : 'drop', z: r1(z), median: b.median, mad: b.mad, hour, sampledAt: new Date(c.sampled_at_epoch * 1000).toISOString() },
      });
    }
  }

  // Write: one short transaction, after all the compute.
  let deleted = 0;
  const ins = dbh.prepare(`
    INSERT OR REPLACE INTO lm_trend_findings (source_id, lm_device_id, vendor_key, kind, subject, metric, value, threshold, days_to_threshold,
      slope_per_day, r2, n, severity, basis_json, detail_json, computed_at)
    VALUES (@source_id, @lm_device_id, @vendor_key, @kind, @subject, @metric, @value, @threshold, @days_to_threshold,
      @slope_per_day, @r2, @n, @severity, @basis_json, @detail_json, @computed_at)
  `);
  dbh.transaction(() => {
    deleted = dbh.prepare('DELETE FROM lm_trend_findings WHERE source_id = ?').run(sourceId).changes;
    for (const r of rows) ins.run(r);
  })();
  return { written: rows.length, deleted, ms: Date.now() - started, byKind };
}

module.exports = {
  RANGE_HOURS, bucketKeys, buildDaily, buildMovers, getTrends,
  KINDS, TREND_DEFAULTS, linearFit, daysUntil, resetEvents, stateChanges, dailySeries, interfaceDailySeries, sensorKind, sevFromDays, computeTrendFindings,
};
