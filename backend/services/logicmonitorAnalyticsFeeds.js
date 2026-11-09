// Read-only analytics feeds for the derived platforms (Cisco, F5), built over lm_trend_findings, lm_ds_daily,
// lm_ds_metrics, lm_interface_daily and the hardware, fleet and trend modules. Each function is (dbh, params) -> value
// and answers an empty value when its tables are missing. Registered by connectors/logicmonitor.js.
// Params always accept { vendorKey, includeMeraki, sourceId, deviceId } (see logicmonitorFleet.vendorKeysOf).
const fleet = require('./logicmonitorFleet');
const hardware = require('./logicmonitorHardware');
const trends = require('./logicmonitorTrends');
const lmIssues = require('./logicmonitorIssues');

const DAY_MS = 86400000;
const dayOfMs = (ms) => new Date(ms).toISOString().slice(0, 10);
const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const clampDays = (v, def = 30) => Math.min(365, Math.max(1, parseInt(v, 10) || def));
const epochIso = (e) => (e ? new Date(Number(e) * 1000).toISOString() : null);
const jparse = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };
const has = (dbh, t) => fleet.tableExists(dbh, t);

function pctile(vals, p) {
  const a = vals.filter((v) => v != null && Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
}

/** Latest-value rows of the given metrics, grouped per instance: [{ sourceId, deviceId, hdsId, key, name, family, m: { metric: { value, datapoint, epoch } } }]. */
function latestByInstance(dbh, devs, metrics, families) {
  const rows = dbh.prepare(`
    SELECT m.source_id, m.lm_device_id, m.hds_id, m.instance_key, m.family, i.instance_name, m.metric, m.value, m.datapoint, m.sampled_at_epoch
    FROM lm_ds_metrics m
    LEFT JOIN lm_ds_instances i ON i.source_id = m.source_id AND i.lm_device_id = m.lm_device_id AND i.hds_id = m.hds_id AND i.instance_key = m.instance_key
    WHERE m.metric IN (${metrics.map(() => '?').join(',')}) ${families ? `AND m.family IN (${families.map(() => '?').join(',')})` : ''}
      AND COALESCE(i.stale, 0) = 0
  `).all(...metrics, ...(families || []));
  const out = new Map();
  for (const r of rows) {
    if (!devs.has(`${r.source_id}:${r.lm_device_id}`)) continue;
    const k = `${r.source_id}:${r.lm_device_id}|${r.hds_id}|${r.instance_key}`;
    let g = out.get(k);
    if (!g) { g = { sourceId: r.source_id, deviceId: r.lm_device_id, hdsId: r.hds_id, key: r.instance_key, name: r.instance_name || r.instance_key, family: r.family, m: {} }; out.set(k, g); }
    g.m[r.metric] = { value: r.value, datapoint: r.datapoint, epoch: r.sampled_at_epoch };
  }
  return [...out.values()];
}

// ---- trends ----------------------------------------------------------------------------------------------

const SEV_RANK = { critical: 0, warning: 1, info: 2 };
function findingOut(r, d) {
  return {
    sourceId: r.source_id, deviceId: r.lm_device_id, device: d ? d.device : null, site: d ? d.site : null, vendorKind: d ? d.vendorKind : null,
    kind: r.kind, subject: r.subject, metric: r.metric, value: r.value, threshold: r.threshold, daysToThreshold: r.days_to_threshold,
    slopePerDay: r.slope_per_day, r2: r.r2, n: r.n, severity: r.severity, basis: jparse(r.basis_json, {}), detail: jparse(r.detail_json, {}), computedAt: r.computed_at,
  };
}

/** { vendorKey, kind?, deviceId?, sourceId?, severity?, limit? } -> finding rows, worst first. */
function trendsFeed(dbh, p = {}) {
  if (!has(dbh, 'lm_trend_findings')) return [];
  const devs = fleet.loadDevices(dbh, p);
  const where = []; const args = [];
  if (p.kind) { where.push('kind = ?'); args.push(String(p.kind)); }
  if (p.severity) { where.push('severity = ?'); args.push(String(p.severity)); }
  const rows = dbh.prepare(`SELECT * FROM lm_trend_findings ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`).all(...args);
  const out = [];
  for (const r of rows) {
    const d = devs.get(`${r.source_id}:${r.lm_device_id}`);
    if (d) out.push(findingOut(r, d));
  }
  out.sort((a, b) => (SEV_RANK[a.severity] ?? 3) - (SEV_RANK[b.severity] ?? 3)
    || (a.daysToThreshold == null) - (b.daysToThreshold == null) || (a.daysToThreshold ?? 0) - (b.daysToThreshold ?? 0)
    || String(a.device).localeCompare(String(b.device)));
  const limit = Math.min(5000, Math.max(1, parseInt(p.limit, 10) || 500));
  return out.slice(0, limit);
}

/** Finding lookup keyed `${src}:${dev}|${kind}|${subject}`. */
function findingIndex(dbh, devs, kinds) {
  const idx = new Map();
  if (!has(dbh, 'lm_trend_findings')) return idx;
  for (const r of dbh.prepare(`SELECT * FROM lm_trend_findings WHERE kind IN (${kinds.map(() => '?').join(',')})`).all(...kinds)) {
    const d = devs.get(`${r.source_id}:${r.lm_device_id}`);
    if (!d) continue;
    const o = findingOut(r, d);
    const k = `${r.source_id}:${r.lm_device_id}|${r.kind}|${r.subject}`;
    idx.set(k, o);
    if (!idx.has(`${r.source_id}:${r.lm_device_id}|${r.kind}`)) idx.set(`${r.source_id}:${r.lm_device_id}|${r.kind}`, o);
  }
  return idx;
}

function trendSeries(dbh, p = {}) {
  if (!has(dbh, 'lm_ds_daily')) return [];
  const sourceId = Number(p.sourceId); const deviceId = Number(p.deviceId);
  if (!Number.isFinite(sourceId) || !Number.isFinite(deviceId) || !p.metric) return [];
  return trends.dailySeries(dbh, {
    sourceId, deviceId, hdsId: p.hdsId != null && p.hdsId !== '' ? Number(p.hdsId) : undefined,
    instanceKey: p.instanceKey != null && p.instanceKey !== '' ? String(p.instanceKey) : undefined,
    metric: String(p.metric), days: clampDays(p.days, 90), agg: p.agg || 'avg',
  });
}

/** { sourceId, deviceId, ifName | instanceId, days } -> lm_interface_daily rows (utilisation, errors, flaps). */
function interfaceSeries(dbh, p = {}) {
  if (!has(dbh, 'lm_interface_daily')) return [];
  const where = ['i.source_id = ?', 'i.lm_device_id = ?', 'd.day >= ?'];
  const args = [Number(p.sourceId), Number(p.deviceId), dayOfMs(Date.now() - clampDays(p.days, 30) * DAY_MS)];
  if (p.instanceId != null && p.instanceId !== '') { where.push('i.instance_id = ?'); args.push(Number(p.instanceId)); }
  else if (p.ifName) { where.push('(i.display_name = ? OR i.instance_name = ?)'); args.push(String(p.ifName), String(p.ifName)); }
  else return [];
  return dbh.prepare(`
    SELECT d.day, d.samples, d.down_samples, d.flaps, d.max_in_util_pct, d.max_out_util_pct, d.avg_in_util_pct, d.avg_out_util_pct, d.errors_sum, d.discards_sum
    FROM lm_interface_daily d JOIN lm_interfaces i ON i.source_id = d.source_id AND i.instance_id = d.instance_id
    WHERE ${where.join(' AND ')} ORDER BY d.day
  `).all(...args).map((r) => ({
    day: r.day, samples: r.samples, downSamples: r.down_samples, flaps: r.flaps, maxInUtilPct: r.max_in_util_pct, maxOutUtilPct: r.max_out_util_pct,
    avgInUtilPct: r.avg_in_util_pct, avgOutUtilPct: r.avg_out_util_pct, errorsSum: r.errors_sum, discardsSum: r.discards_sum,
  }));
}

// ---- interfaces: hot, flapping, errors -------------------------------------------------------------------

function interfacesAnalytics(dbh, p = {}) {
  if (!has(dbh, 'lm_interface_daily') || !has(dbh, 'lm_interfaces')) return [];
  const tab = ['hot', 'flapping', 'errors'].includes(p.tab) ? p.tab : 'hot';
  const days = clampDays(p.days, 7);
  const limit = Math.min(200, Math.max(1, parseInt(p.limit, 10) || 25));
  const since = dayOfMs(Date.now() - days * DAY_MS);
  const keys = fleet.vendorKeysOf(p);
  const vendorSql = keys ? `AND dv.vendor_key IN (${keys.map(() => '?').join(',')})` : '';
  const base = `
    FROM lm_interfaces i
    CROSS JOIN lm_devices dv ON dv.source_id = i.source_id AND dv.lm_device_id = i.lm_device_id AND dv.stale = 0
    CROSS JOIN lm_interface_daily d ON d.source_id = i.source_id AND d.instance_id = i.instance_id AND d.day >= ?
    WHERE i.stale = 0 ${vendorSql}
  `; // CROSS JOIN pins the join order: interfaces, then device, then the day rows by their unique index (the default order scanned every day row per device)
  const bargs = [since, ...(keys || [])];
  const ident = 'i.source_id sid, i.lm_device_id did, i.instance_id iid, COALESCE(i.display_name, i.instance_name) ifname, dv.display_name dname';

  if (tab === 'flapping') {
    return dbh.prepare(`
      SELECT ${ident}, SUM(COALESCE(d.flaps, 0)) flaps, SUM(COALESCE(d.down_samples, 0)) down, SUM(COALESCE(d.samples, 0)) samples
      ${base} GROUP BY d.source_id, d.instance_id HAVING flaps > 0 OR down > 0 ORDER BY flaps DESC, down DESC LIMIT ?
    `).all(...bargs, limit).map((r) => ({
      sourceId: r.sid, deviceId: r.did, instanceId: r.iid, device: r.dname, ifName: r.ifname, flaps: r.flaps, downSamples: r.down, samples: r.samples,
    }));
  }

  if (tab === 'errors') {
    const rows = dbh.prepare(`
      SELECT ${ident}, SUM(COALESCE(d.errors_sum, 0)) errs, SUM(COALESCE(d.discards_sum, 0)) disc, SUM(COALESCE(d.samples, 0)) samples,
        (SELECT x.errors_sum * 1.0 / NULLIF(x.samples, 0) FROM lm_interface_daily x WHERE x.source_id = d.source_id AND x.instance_id = d.instance_id ORDER BY x.day DESC LIMIT 1) recent
      ${base} GROUP BY d.source_id, d.instance_id HAVING errs > 0 OR disc > 0 ORDER BY errs + disc DESC LIMIT ?
    `).all(...bargs, limit);
    const bl = has(dbh, 'lm_interface_baseline')
      ? dbh.prepare('SELECT err_median, err_mad FROM lm_interface_baseline WHERE source_id = ? AND instance_id = ? AND err_median IS NOT NULL')
      : null;
    return rows.map((r) => {
      let med = null; let mad = null;
      if (bl) {
        const b = bl.all(r.sid, r.iid);
        med = fleet.median(b.map((x) => x.err_median));
        mad = fleet.median(b.map((x) => x.err_mad));
      }
      const recent = r.recent;
      const deviates = med != null && recent != null && recent > 0 && recent > med + 3 * Math.max(mad || 0, 0.1);
      return {
        sourceId: r.sid, deviceId: r.did, instanceId: r.iid, device: r.dname, ifName: r.ifname, errorsSum: r.errs, discardsSum: r.disc,
        baselineMedian: r2(med), baselineMad: r2(mad), deviates,
      };
    });
  }

  // hot: peak interfaces first, p95 over the daily maxima of the picked ones.
  const top = dbh.prepare(`
    SELECT ${ident}, MAX(d.max_in_util_pct) mi, MAX(d.max_out_util_pct) mo
    ${base} GROUP BY d.source_id, d.instance_id HAVING MAX(COALESCE(d.max_in_util_pct, 0), COALESCE(d.max_out_util_pct, 0)) > 0
    ORDER BY MAX(COALESCE(d.max_in_util_pct, 0), COALESCE(d.max_out_util_pct, 0)) DESC LIMIT ?
  `).all(...bargs, limit);
  const daily = dbh.prepare('SELECT max_in_util_pct i, max_out_util_pct o FROM lm_interface_daily WHERE source_id = ? AND instance_id = ? AND day >= ?');
  const find = new Map();
  if (has(dbh, 'lm_trend_findings')) {
    for (const f of dbh.prepare("SELECT lm_device_id, subject, metric, days_to_threshold, r2, n, basis_json, severity FROM lm_trend_findings WHERE kind = 'if_util_forecast'").all()) {
      find.set(`${f.lm_device_id}|${f.subject}|${f.metric}`, f);
    }
  }
  return top.map((r) => {
    const ds = daily.all(r.sid, r.iid, since);
    const fi = find.get(`${r.did}|${r.ifname}|max_in_util_pct`); const fo = find.get(`${r.did}|${r.ifname}|max_out_util_pct`);
    const worse = [fi, fo].filter(Boolean).sort((a, b) => (a.days_to_threshold ?? 1e9) - (b.days_to_threshold ?? 1e9))[0] || null;
    return {
      sourceId: r.sid, deviceId: r.did, instanceId: r.iid, device: r.dname, ifName: r.ifname,
      p95InUtil: r1(pctile(ds.map((x) => x.i), 95)), maxInUtil: r1(r.mi), p95OutUtil: r1(pctile(ds.map((x) => x.o), 95)), maxOutUtil: r1(r.mo),
      daysTo80In: fi ? fi.days_to_threshold : null, daysTo80Out: fo ? fo.days_to_threshold : null,
      ...(worse ? { r2: worse.r2, n: worse.n, basis: jparse(worse.basis_json, {}), severity: worse.severity } : {}),
    };
  });
}

// ---- optics -----------------------------------------------------------------------------------------------

const OPTIC_STATE = { 1: 'ok', 2: 'unknown', 3: 'failed' };

/**
 * Transceiver sensors. The daily table stores the sensor value as metric optic_value (hdsId and instanceKey are on every
 * row so a page can call trendSeries); the margin trend is the optic_margin finding. sensorKind comes from the instance
 * name (see trends.sensorKind: the live fixture has no instance names, so that parser is an assumption).
 */
function optics(dbh, p = {}) {
  const devs = fleet.loadDevices(dbh, p);
  if (!devs.size) return [];
  const rows = latestByInstance(dbh, devs, ['optic_value', 'optic_low_warn', 'optic_high_warn', 'optic_low_alarm', 'optic_state'], ['optics']);
  const idx = findingIndex(dbh, devs, ['optic_margin']);
  const out = [];
  for (const g of rows) {
    if (!g.m.optic_value) continue;
    const d = devs.get(`${g.sourceId}:${g.deviceId}`);
    const kind = trends.sensorKind(g.name);
    const v = g.m.optic_value.value;
    const lw = g.m.optic_low_warn ? g.m.optic_low_warn.value : null;
    const st = g.m.optic_state ? OPTIC_STATE[Math.round(g.m.optic_state.value)] || 'unknown' : 'unknown';
    out.push({
      sourceId: g.sourceId, deviceId: g.deviceId, hdsId: g.hdsId, instanceKey: g.key, instanceName: g.name, seriesMetric: 'optic_value',
      device: d.device, site: d.site, ifName: String(g.name).split(/\s+/)[0], sensorKind: kind, value: v,
      lowWarn: lw, highWarn: g.m.optic_high_warn ? g.m.optic_high_warn.value : null, lowAlarm: g.m.optic_low_alarm ? g.m.optic_low_alarm.value : null,
      marginDb: kind === 'rx_power' && lw != null && v != null ? r2(v - lw) : null, state: st,
      trend: idx.get(`${g.sourceId}:${g.deviceId}|optic_margin|${g.name}`) || null,
    });
  }
  out.sort((a, b) => (a.marginDb ?? 1e9) - (b.marginDb ?? 1e9) || String(a.device).localeCompare(String(b.device)));
  return out;
}

// ---- PoE ----------------------------------------------------------------------------------------------------

function poe(dbh, p = {}) {
  const devs = fleet.loadDevices(dbh, p);
  if (!devs.size) return { rows: [], sites: [] };
  const rows = latestByInstance(dbh, devs, ['poe_used_pct', 'poe_used_watts'], ['health']);
  const idx = findingIndex(dbh, devs, ['poe_forecast']);
  const out = [];
  for (const g of rows) {
    const d = devs.get(`${g.sourceId}:${g.deviceId}`);
    const pct = g.m.poe_used_pct ? g.m.poe_used_pct.value : null;
    const w = g.m.poe_used_watts ? g.m.poe_used_watts.value : null;
    const budget = pct != null && pct > 0 && w != null ? w / (pct / 100) : null;
    out.push({
      sourceId: g.sourceId, deviceId: g.deviceId, hdsId: g.hdsId, instanceKey: g.key, device: d.device, site: d.site, member: g.name,
      usedWatts: w, usedPct: pct, budgetWatts: budget != null ? Math.round(budget) : null,
      headroomWatts: budget != null && w != null ? Math.round(budget - w) : null,
      trend: idx.get(`${g.sourceId}:${g.deviceId}|poe_forecast|${g.name}`) || null,
    });
  }
  out.sort((a, b) => (b.usedPct ?? -1) - (a.usedPct ?? -1));
  const bySite = new Map();
  for (const r of out) {
    if (r.headroomWatts == null) continue;
    const k = r.site || 'Unassigned';
    const s = bySite.get(k) || { site: k, headroomWatts: 0, devices: new Set() };
    s.headroomWatts += r.headroomWatts; s.devices.add(r.deviceId); bySite.set(k, s);
  }
  return { rows: out, sites: [...bySite.values()].map((s) => ({ site: s.site, headroomWatts: s.headroomWatts, devices: s.devices.size })).sort((a, b) => a.headroomWatts - b.headroomWatts) };
}

// ---- routing peers --------------------------------------------------------------------------------------------

const BGP_STATE = { 1: 'idle', 2: 'connect', 3: 'active', 4: 'opensent', 5: 'openconfirm', 6: 'established' };
const OSPF_STATE = { 1: 'down', 2: 'attempt', 3: 'init', 4: 'twoWay', 5: 'exchangeStart', 6: 'exchange', 7: 'loading', 8: 'full' };

function routingPeers(dbh, p = {}) {
  const devs = fleet.loadDevices(dbh, p);
  if (!devs.size) return [];
  const rows = latestByInstance(dbh, devs, ['bgp_peer_state', 'bgp_established_s', 'ospf_nbr_state', 'eigrp_uptime_s'], ['routing']);
  const flaps = new Map();
  if (has(dbh, 'lm_trend_findings')) {
    for (const r of dbh.prepare("SELECT source_id, lm_device_id, subject, metric, detail_json FROM lm_trend_findings WHERE kind = 'peer_flap'").all()) {
      const dt = jparse(r.detail_json, {});
      flaps.set(`${r.source_id}:${r.lm_device_id}|${r.subject}|${r.metric.startsWith('bgp') ? 'bgp' : r.metric.startsWith('ospf') ? 'ospf' : 'eigrp'}`, dt);
    }
  }
  const out = [];
  for (const g of rows) {
    const d = devs.get(`${g.sourceId}:${g.deviceId}`);
    const protocol = g.m.bgp_peer_state || g.m.bgp_established_s ? 'bgp' : g.m.ospf_nbr_state ? 'ospf' : 'eigrp';
    let state = 'unknown'; let est = null;
    if (protocol === 'bgp') {
      if (g.m.bgp_peer_state) state = BGP_STATE[Math.round(g.m.bgp_peer_state.value)] || String(Math.round(g.m.bgp_peer_state.value));
      est = g.m.bgp_established_s ? g.m.bgp_established_s.value : null;
    } else if (protocol === 'ospf') {
      state = OSPF_STATE[Math.round(g.m.ospf_nbr_state.value)] || String(Math.round(g.m.ospf_nbr_state.value));
    } else {
      est = g.m.eigrp_uptime_s ? g.m.eigrp_uptime_s.value : null;
      state = est != null && est > 0 ? 'up' : 'down';
    }
    const f = flaps.get(`${g.sourceId}:${g.deviceId}|${g.name}|${protocol}`) || {};
    out.push({
      sourceId: g.sourceId, deviceId: g.deviceId, device: d.device, site: d.site, protocol, peer: g.name, state, establishedS: est,
      flaps7d: f.events7d || 0, flaps30d: f.events30d || 0, shadowed: d.hostStatus === 'dead' || d.hostStatus === 'dead-collector',
    });
  }
  out.sort((a, b) => String(a.device).localeCompare(String(b.device)) || String(a.peer).localeCompare(String(b.peer)));
  return out;
}

// ---- device resources ---------------------------------------------------------------------------------------------

function deviceResources(dbh, p = {}) {
  const devs = fleet.loadDevices(dbh, p);
  if (!devs.size || !has(dbh, 'lm_ds_daily')) return [];
  const days = clampDays(p.days, 30);
  const since = dayOfMs(Date.now() - days * DAY_MS);
  const perDay = new Map(); // `${src}:${dev}|${metric}` -> [max per day]
  const slope = new Map();
  for (const r of dbh.prepare(`
    SELECT source_id, lm_device_id, metric, day, MAX(max_value) mx FROM lm_ds_daily
    WHERE kind = 'catalog' AND day >= ? AND samples > 0 AND metric IN ('cpu_pct', 'mem_pct', 'client_connections', 'mem_avail_bytes')
    GROUP BY source_id, lm_device_id, metric, day
  `).iterate(since)) {
    const k = `${r.source_id}:${r.lm_device_id}|${r.metric}`;
    if (!devs.has(`${r.source_id}:${r.lm_device_id}`)) continue;
    if (!perDay.has(k)) perDay.set(k, []);
    perDay.get(k).push({ day: r.day, value: r.mx, samples: 1 });
  }
  for (const [k, pts] of perDay) slope.set(k, trends.linearFit(pts).slopePerDay);
  const now = new Map();
  const swap = new Map();
  for (const g of latestByInstance(dbh, devs, ['cpu_pct', 'mem_pct', 'client_connections', 'server_connections', 'swap_total_bytes', 'swap_avail_bytes'], null)) {
    const sk = `${g.sourceId}:${g.deviceId}`;
    if (g.m.swap_total_bytes || g.m.swap_avail_bytes) {
      const w = swap.get(sk) || {};
      if (g.m.swap_total_bytes) w.total = g.m.swap_total_bytes.value;
      if (g.m.swap_avail_bytes) w.avail = g.m.swap_avail_bytes.value;
      swap.set(sk, w);
    }
    for (const metric of ['cpu_pct', 'mem_pct', 'client_connections', 'server_connections']) {
      if (!g.m[metric]) continue;
      const k = `${g.sourceId}:${g.deviceId}|${metric}`;
      const cur = now.get(k);
      if (cur == null || g.m[metric].value > cur) now.set(k, g.m[metric].value);
    }
  }
  const find = findingIndex(dbh, devs, ['cpu_forecast', 'mem_creep', 'fs_forecast']);
  const fs = new Map();
  if (has(dbh, 'lm_trend_findings')) {
    for (const r of dbh.prepare("SELECT * FROM lm_trend_findings WHERE kind = 'fs_forecast'").all()) {
      const d = devs.get(`${r.source_id}:${r.lm_device_id}`);
      if (!d) continue;
      const k = `${r.source_id}:${r.lm_device_id}`;
      if (!fs.has(k)) fs.set(k, []);
      const o = findingOut(r, d);
      fs.get(k).push({ fs: r.subject, usedPct: r.value, daysTo95: r.days_to_threshold, threshold: r.threshold, finding: o });
    }
  }
  const out = [];
  for (const [dk, d] of devs) {
    const cpuK = `${dk}|cpu_pct`; const memK = `${dk}|mem_pct`; const connK = `${dk}|client_connections`;
    if (!perDay.has(cpuK) && !perDay.has(memK) && !perDay.has(connK) && !now.has(connK)) continue;
    const vals = (k) => (perDay.get(k) || []).map((x) => x.value);
    const row = {
      sourceId: d.sourceId, deviceId: d.deviceId, device: d.device, site: d.site,
      cpu: { now: r1(now.get(cpuK)), p95: r1(pctile(vals(cpuK), 95)), slope: slope.has(cpuK) ? r2(slope.get(cpuK)) : null, forecast: find.get(`${dk}|cpu_forecast`) || null },
      mem: { now: r1(now.get(memK)), p95: r1(pctile(vals(memK), 95)), slope: slope.has(memK) ? r2(slope.get(memK)) : null, creep: find.get(`${dk}|mem_creep`) || null },
      flash: (fs.get(dk) || []).sort((a, b) => (a.daysTo95 ?? 1e9) - (b.daysTo95 ?? 1e9)),
    };
    if (perDay.has(connK) || now.has(connK)) {
      const cNow = now.get(connK) ?? null; const sNow = now.get(`${dk}|server_connections`) ?? null;
      row.connections = {
        now: cNow, clientNow: cNow, serverNow: sNow, p95: r1(pctile(vals(connK), 95)), peak: vals(connK).length ? r1(Math.max(...vals(connK))) : null,
        ratio: cNow != null && sNow != null && sNow > 0 ? r2(cNow / sNow) : null,
      };
    }
    const sw = swap.get(dk);
    if (sw && sw.total != null && sw.avail != null) row.mem.swapUsedBytes = Math.max(0, Math.round(sw.total - sw.avail));
    if (perDay.has(`${dk}|mem_avail_bytes`)) row.mem.memAvailTrend = perDay.get(`${dk}|mem_avail_bytes`).map((x) => ({ day: x.day, value: x.value }));
    out.push(row);
  }
  out.sort((a, b) => (b.cpu.p95 ?? -1) - (a.cpu.p95 ?? -1));
  return out;
}

// ---- reachability ------------------------------------------------------------------------------------------------

function reachability(dbh, p = {}) {
  const devs = fleet.loadDevices(dbh, p);
  const out = { ping: [], ntp: [], ipsla: [] };
  if (!devs.size) return out;
  const days = clampDays(p.days, 30);
  const since = dayOfMs(Date.now() - days * DAY_MS);
  const rttDaily = new Map();
  if (has(dbh, 'lm_ds_daily')) {
    for (const r of dbh.prepare(`
      SELECT source_id, lm_device_id, day, SUM(sum_value) s, SUM(samples) n FROM lm_ds_daily
      WHERE kind = 'catalog' AND metric = 'ping_rtt_ms' AND day >= ? AND samples > 0 GROUP BY source_id, lm_device_id, day
    `).iterate(since)) {
      const k = `${r.source_id}:${r.lm_device_id}`;
      if (!devs.has(k)) continue;
      if (!rttDaily.has(k)) rttDaily.set(k, []);
      rttDaily.get(k).push({ day: r.day, value: r.s / r.n, samples: r.n });
    }
  }
  const health = latestByInstance(dbh, devs, ['ping_loss_pct', 'ping_rtt_ms', 'ntp_synced', 'ntp_stratum', 'ntp_offset_ms'], ['health']);
  const pingBy = new Map();
  for (const g of health) {
    const d = devs.get(`${g.sourceId}:${g.deviceId}`);
    if (g.m.ping_loss_pct || g.m.ping_rtt_ms) {
      const k = `${g.sourceId}:${g.deviceId}`;
      const cur = pingBy.get(k) || { sourceId: g.sourceId, deviceId: g.deviceId, device: d.device, site: d.site, lossPct: null, rttMs: null };
      if (g.m.ping_loss_pct) cur.lossPct = Math.max(cur.lossPct ?? 0, g.m.ping_loss_pct.value);
      if (g.m.ping_rtt_ms) cur.rttMs = Math.max(cur.rttMs ?? 0, g.m.ping_rtt_ms.value);
      pingBy.set(k, cur);
    }
    if (g.m.ntp_synced || g.m.ntp_offset_ms) {
      const off = g.m.ntp_offset_ms ? g.m.ntp_offset_ms.value : null;
      out.ntp.push({
        sourceId: g.sourceId, deviceId: g.deviceId, device: d.device, site: d.site, peer: g.name,
        synced: g.m.ntp_synced ? Math.round(g.m.ntp_synced.value) !== 0 : null, stratum: g.m.ntp_stratum ? g.m.ntp_stratum.value : null, offsetMs: off,
        outlier: off != null && Math.abs(off) > 100,
      });
    }
  }
  for (const [k, row] of pingBy) {
    const fit = trends.linearFit(rttDaily.get(k) || []);
    out.ping.push({
      ...row, trend: fit.n >= 3 ? { slopePerDay: r2(fit.slopePerDay), r2: r2(fit.r2), n: fit.n, windowDays: days } : null,
    });
  }
  out.ping.sort((a, b) => (b.lossPct ?? 0) - (a.lossPct ?? 0) || (b.rttMs ?? 0) - (a.rttMs ?? 0));

  // IP SLA: the probes of the vendor's devices with their hour-of-day baseline (reuses lm_ds_metric_baseline).
  const sla = latestByInstance(dbh, devs, ['rtt_ms', 'loss_pct', 'jitter_ms', 'mos'], ['ipsla']);
  const bl = has(dbh, 'lm_ds_metric_baseline')
    ? dbh.prepare("SELECT median, mad FROM lm_ds_metric_baseline WHERE source_id = ? AND lm_device_id = ? AND hds_id = ? AND instance_key = ? AND metric = 'rtt_ms' AND hour_of_day = ?")
    : null;
  for (const g of sla) {
    const d = devs.get(`${g.sourceId}:${g.deviceId}`);
    const rtt = g.m.rtt_ms ? g.m.rtt_ms.value : null;
    let med = null; let mad = null; let deviates = false;
    if (bl && g.m.rtt_ms && g.m.rtt_ms.epoch) {
      const b = bl.get(g.sourceId, g.deviceId, g.hdsId, g.key, new Date(g.m.rtt_ms.epoch * 1000).getUTCHours());
      if (b) { med = b.median; mad = b.mad; deviates = rtt != null && med != null && rtt > med + 3 * Math.max(mad || 0, 1); }
    }
    out.ipsla.push({
      sourceId: g.sourceId, deviceId: g.deviceId, device: d.device, site: d.site, probe: g.name, rttMs: rtt,
      lossPct: g.m.loss_pct ? g.m.loss_pct.value : null, jitterMs: g.m.jitter_ms ? g.m.jitter_ms.value : null, mos: g.m.mos ? g.m.mos.value : null,
      baselineMedian: med, baselineMad: mad, deviates,
    });
  }
  out.ipsla.sort((a, b) => (b.deviates - a.deviates) || (b.rttMs ?? 0) - (a.rttMs ?? 0));
  return out;
}

// ---- wireless analytics --------------------------------------------------------------------------------------------

function wirelessAnalytics(dbh, p = {}) {
  const out = { apLoadImbalance: [], channelUtilTrend: [], radiusFailureRatio: [] };
  if (!has(dbh, 'lm_ds_daily')) return out;
  const devs = fleet.loadDevices(dbh, p);
  if (!devs.size) return out;
  const days = clampDays(p.days, 30);
  const since = dayOfMs(Date.now() - days * DAY_MS);
  const since7 = dayOfMs(Date.now() - 7 * DAY_MS);
  const rows = dbh.prepare(`
    SELECT source_id, lm_device_id, instance_key, metric, day, SUM(sum_value) s, SUM(samples) n, MAX(max_value) mx
    FROM lm_ds_daily WHERE kind = 'catalog' AND day >= ? AND samples > 0
      AND metric IN ('radio_clients', 'radio_util_pct', 'radius_requests', 'radius_rejects', 'radius_timeouts')
    GROUP BY source_id, lm_device_id, instance_key, metric, day
  `).all(since);
  const names = new Map();
  for (const i of dbh.prepare("SELECT source_id, lm_device_id, instance_key, instance_name FROM lm_ds_instances WHERE family = 'wireless' AND datasource_name LIKE '%RADIUSAuth%'").all()) {
    names.set(`${i.source_id}:${i.lm_device_id}|${i.instance_key}`, i.instance_name || i.instance_key);
  }
  const band = new Map(); // band|day -> { s, n }
  const rad = new Map(); // server -> day -> { req, rej, to }
  // AP clients: per AP the busiest day's sum of radio maxima, and the week-long maximum for the zero-client rule.
  const apDay = new Map(); // ctrl -> apName -> day -> sum of radio maxima
  for (const r of rows) {
    if (r.metric !== 'radio_clients' || r.day < since7) continue;
    const dk = `${r.source_id}:${r.lm_device_id}`;
    if (!devs.has(dk)) continue;
    const apName = lmIssues.apOfRadio(r.instance_key);
    if (!apDay.has(dk)) apDay.set(dk, new Map());
    const byAp = apDay.get(dk);
    if (!byAp.has(apName)) byAp.set(apName, new Map());
    const byDay = byAp.get(apName);
    byDay.set(r.day, (byDay.get(r.day) || 0) + (r.mx || 0));
  }
  for (const [dk, byAp] of apDay) {
    const d = devs.get(dk);
    const peaks = []; const zero = [];
    for (const [apName, byDay] of byAp) {
      const vals = [...byDay.values()];
      const peak = Math.max(...vals);
      peaks.push(peak);
      if (peak === 0 && vals.length >= 3) zero.push(apName);
    }
    if (!peaks.length) continue;
    const mean = peaks.reduce((s, v) => s + v, 0) / peaks.length;
    const sd = Math.sqrt(peaks.reduce((s, v) => s + (v - mean) ** 2, 0) / peaks.length);
    out.apLoadImbalance.push({ sourceId: d.sourceId, deviceId: d.deviceId, controller: d.device, site: d.site, cv: mean > 0 ? r2(sd / mean) : null, apCount: peaks.length, zeroClientAps7d: zero.sort() });
  }
  out.apLoadImbalance.sort((a, b) => (b.cv ?? -1) - (a.cv ?? -1));

  for (const r of rows) {
    const dk = `${r.source_id}:${r.lm_device_id}`;
    if (!devs.has(dk)) continue;
    if (r.metric === 'radio_util_pct') {
      const slot = lmIssues.slotOfRadio(r.instance_key);
      const b = lmIssues.bandOfSlot(slot);
      const k = `${b}|${r.day}`;
      const x = band.get(k) || { s: 0, n: 0 };
      x.s += r.s; x.n += r.n; band.set(k, x);
    } else if (r.metric.startsWith('radius_')) {
      const server = names.get(`${dk}|${r.instance_key}`) || r.instance_key;
      const sk = `${devs.get(dk).device} ${server}`;
      if (!rad.has(sk)) rad.set(sk, new Map());
      const byDay = rad.get(sk);
      const x = byDay.get(r.day) || { req: 0, rej: 0, to: 0 };
      const avg = r.n ? r.s / r.n : 0;
      if (r.metric === 'radius_requests') x.req += avg; else if (r.metric === 'radius_rejects') x.rej += avg; else x.to += avg;
      byDay.set(r.day, x);
    }
  }
  const bandPts = new Map();
  for (const [k, x] of band) {
    const [b, day] = k.split('|');
    if (!bandPts.has(b)) bandPts.set(b, []);
    bandPts.get(b).push({ day, value: r1(x.s / x.n) });
  }
  out.channelUtilTrend = [...bandPts.entries()].map(([b, points]) => ({ band: b, points: points.sort((a, c) => (a.day < c.day ? -1 : 1)) }))
    .sort((a, b) => a.band.localeCompare(b.band));
  out.radiusFailureRatio = [...rad.entries()].map(([server, byDay]) => ({
    server,
    points: [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, x]) => ({ day, value: x.req > 0 ? r2((x.rej + x.to) / x.req) : null })),
  })).sort((a, b) => a.server.localeCompare(b.server));
  return out;
}

// ---- F5 feeds ------------------------------------------------------------------------------------------------------

function certificates(dbh, p = {}) {
  const devs = fleet.loadDevices(dbh, { ...p, vendorKey: p.vendorKey || 'f5' });
  if (!devs.size) return [];
  const out = [];
  for (const g of latestByInstance(dbh, devs, ['cert_days_left'], ['loadbalancer'])) {
    const d = devs.get(`${g.sourceId}:${g.deviceId}`);
    out.push({
      sourceId: g.sourceId, deviceId: g.deviceId, device: d.device, site: d.site, vip: g.name, instanceName: g.name,
      daysLeft: g.m.cert_days_left.value, sampledAt: epochIso(g.m.cert_days_left.epoch),
    });
  }
  return out.sort((a, b) => (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9) || String(a.device).localeCompare(String(b.device)));
}

/** Pool name is the instance name before the first / or : (an assumption, see lmIssues.poolOf). */
function poolMembers(dbh, p = {}) {
  const devs = fleet.loadDevices(dbh, { vendorKey: 'f5', deviceId: p.deviceId, sourceId: p.sourceId });
  if (!devs.size) return [];
  const out = [];
  for (const g of latestByInstance(dbh, devs, ['member_connections', 'member_bits_in', 'member_bits_out'], ['loadbalancer'])) {
    const d = devs.get(`${g.sourceId}:${g.deviceId}`);
    const bits = (m) => (m ? (/bytes/i.test(m.datapoint || '') ? m.value * 8 : m.value) : null);
    const pool = lmIssues.poolOf(g.key);
    const conn = g.m.member_connections ? g.m.member_connections.value : null;
    out.push({
      sourceId: g.sourceId, deviceId: g.deviceId, device: d.device, pool, member: String(g.name).replace(/^\/+/, '').replace(/^Common\//i, ''),
      connections: conn, bitsIn: bits(g.m.member_bits_in), bitsOut: bits(g.m.member_bits_out), sessions: conn,
    });
  }
  return out.sort((a, b) => String(a.device).localeCompare(String(b.device)) || String(a.pool).localeCompare(String(b.pool)) || String(a.member).localeCompare(String(b.member)));
}

/** Per-day deltas of a counter from its daily last values; a drop is a reset and counts the new value. */
function counterDeltas(rows) {
  const byDay = new Map();
  let prev = null;
  for (const r of rows) {
    let delta;
    if (prev == null) delta = Math.max(0, (r.max ?? 0) - (r.min ?? 0));
    else if (r.last >= prev) delta = r.last - prev;
    else delta = r.max ?? r.last ?? 0;
    byDay.set(r.day, (byDay.get(r.day) || 0) + delta);
    prev = r.last;
  }
  return byDay;
}

function gtm(dbh, p = {}) {
  const out = { requestsPerDay: [], resolutionsPerDay: [], ratio: [], wideIpAvailability: [], datacenterAvailability: [], perWideIp: [] };
  if (!has(dbh, 'lm_ds_daily')) return out;
  const devs = fleet.loadDevices(dbh, { vendorKey: 'f5', sourceId: p.sourceId });
  if (!devs.size) return out;
  const days = clampDays(p.days, 30);
  const since = dayOfMs(Date.now() - days * DAY_MS);
  const rows = dbh.prepare(`
    SELECT source_id, lm_device_id, hds_id, instance_key, metric, day, min_value, max_value, last_value FROM lm_ds_daily
    WHERE kind = 'catalog' AND day >= ? AND samples > 0 AND metric IN ('gtm_requests', 'gtm_resolutions', 'wideip_requests', 'wideip_resolutions', 'wideip_avail', 'dc_avail')
    ORDER BY source_id, lm_device_id, hds_id, instance_key, metric, day
  `).all(since).filter((r) => devs.has(`${r.source_id}:${r.lm_device_id}`));
  const series = new Map();
  for (const r of rows) {
    const k = `${r.source_id}:${r.lm_device_id}|${r.hds_id}|${r.instance_key}|${r.metric}`;
    if (!series.has(k)) series.set(k, { dk: `${r.source_id}:${r.lm_device_id}`, key: r.instance_key, metric: r.metric, rows: [] });
    series.get(k).rows.push({ day: r.day, min: r.min_value, max: r.max_value, last: r.last_value });
  }
  const sum = (metric) => {
    const acc = new Map();
    for (const s of series.values()) {
      if (s.metric !== metric) continue;
      for (const [day, v] of counterDeltas(s.rows)) acc.set(day, (acc.get(day) || 0) + v);
    }
    return [...acc.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(1).map(([day, value]) => ({ day, value: Math.round(value) }));
  };
  out.requestsPerDay = sum('gtm_requests');
  out.resolutionsPerDay = sum('gtm_resolutions');
  const rmap = new Map(out.resolutionsPerDay.map((x) => [x.day, x.value]));
  out.ratio = out.requestsPerDay.map((x) => ({ day: x.day, value: x.value > 0 && rmap.has(x.day) ? Math.round((rmap.get(x.day) / x.value) * 1000) / 1000 : null }));
  const nameOf = new Map();
  for (const i of dbh.prepare("SELECT source_id, lm_device_id, instance_key, instance_name FROM lm_ds_instances WHERE datasource_name LIKE 'F5_GTM_%'").all()) {
    nameOf.set(`${i.source_id}:${i.lm_device_id}|${i.instance_key}`, i.instance_name || i.instance_key);
  }
  const wide = new Map();
  for (const s of series.values()) {
    const nm = nameOf.get(`${s.dk}|${s.key}`) || s.key;
    if (s.metric === 'wideip_avail' || s.metric === 'dc_avail') {
      const lastOf = new Map(s.rows.map((r) => [r.day, r.last]));
      for (const e of trends.stateChanges(s.rows)) {
        (s.metric === 'wideip_avail' ? out.wideIpAvailability : out.datacenterAvailability)
          .push({ [s.metric === 'wideip_avail' ? 'wideIp' : 'datacenter']: nm, day: e.day, state: lastOf.get(e.day) ?? e.max, min: e.min, max: e.max });
      }
    } else if (s.metric === 'wideip_requests' || s.metric === 'wideip_resolutions') {
      const total = [...counterDeltas(s.rows).entries()].slice(1).reduce((a, [, v]) => a + v, 0);
      const w = wide.get(nm) || { wideIp: nm, requests: 0, resolutions: 0, device: devs.get(s.dk).device };
      if (s.metric === 'wideip_requests') w.requests += Math.round(total); else w.resolutions += Math.round(total);
      wide.set(nm, w);
    }
  }
  out.perWideIp = [...wide.values()].sort((a, b) => b.requests - a.requests).slice(0, 25);
  out.wideIpAvailability.sort((a, b) => (a.day < b.day ? 1 : -1));
  out.datacenterAvailability.sort((a, b) => (a.day < b.day ? 1 : -1));
  return out;
}

function daemonFlaps(dbh, p = {}) {
  if (!has(dbh, 'lm_ds_daily')) return [];
  const devs = fleet.loadDevices(dbh, { vendorKey: p.vendorKey || 'f5' });
  if (!devs.size) return [];
  const since = dayOfMs(Date.now() - clampDays(p.days, 30) * DAY_MS);
  const acc = new Map();
  for (const r of dbh.prepare(`
    SELECT source_id, lm_device_id, datasource_name, day, max_value FROM lm_ds_daily
    WHERE kind = 'catalog' AND metric = 'daemon_exit' AND day >= ? AND samples > 0 AND max_value > 0
  `).all(since)) {
    const d = devs.get(`${r.source_id}:${r.lm_device_id}`);
    if (!d) continue;
    const daemon = String(r.datasource_name || '').replace(/^f5_/i, '').replace(/_service_status$|_status$/i, '');
    const k = `${r.source_id}:${r.lm_device_id}|${daemon}`;
    const x = acc.get(k) || { sourceId: d.sourceId, deviceId: d.deviceId, device: d.device, site: d.site, daemon, nonZeroDays: 0, events: [] };
    x.nonZeroDays += 1; x.events.push({ day: r.day, exit: r.max_value });
    acc.set(k, x);
  }
  return [...acc.values()].sort((a, b) => b.nonZeroDays - a.nonZeroDays);
}

function haState(dbh, p = {}) {
  const devs = fleet.loadDevices(dbh, { vendorKey: p.vendorKey || 'f5', sourceId: p.sourceId });
  if (!devs.size) return [];
  const units = new Map();
  for (const g of latestByInstance(dbh, devs, ['failover_state', 'sync_state', 'cpu_pct', 'client_connections'], ['loadbalancer'])) {
    const dk = `${g.sourceId}:${g.deviceId}`;
    const u = units.get(dk) || { fo: null, sync: null, cpu: null, conn: null };
    if (g.m.failover_state) u.fo = g.m.failover_state.value;
    if (g.m.sync_state) u.sync = g.m.sync_state.value;
    if (g.m.cpu_pct) u.cpu = g.m.cpu_pct.value;
    if (g.m.client_connections) u.conn = g.m.client_connections.value;
    units.set(dk, u);
  }
  const since7 = dayOfMs(Date.now() - 7 * DAY_MS); const since30 = dayOfMs(Date.now() - 30 * DAY_MS);
  const cpu7 = new Map(); const cpu30 = new Map();
  if (has(dbh, 'lm_ds_daily')) {
    for (const r of dbh.prepare(`
      SELECT source_id, lm_device_id, day, MAX(max_value) mx, SUM(sum_value) s, SUM(samples) n FROM lm_ds_daily
      WHERE kind = 'catalog' AND metric = 'cpu_pct' AND day >= ? AND samples > 0 GROUP BY source_id, lm_device_id, day
    `).iterate(since30)) {
      const dk = `${r.source_id}:${r.lm_device_id}`;
      if (!devs.has(dk)) continue;
      if (!cpu30.has(dk)) cpu30.set(dk, []);
      cpu30.get(dk).push(r.s / r.n);
      if (r.day >= since7) { if (!cpu7.has(dk)) cpu7.set(dk, []); cpu7.get(dk).push(r.mx); }
    }
  }
  const fo = new Map();
  if (has(dbh, 'lm_trend_findings')) {
    for (const r of dbh.prepare("SELECT source_id, lm_device_id, detail_json FROM lm_trend_findings WHERE kind = 'state_change' AND metric = 'failover_state'").all()) {
      fo.set(`${r.source_id}:${r.lm_device_id}`, jparse(r.detail_json, {}));
    }
  }
  const out = [];
  for (const [dk, d] of devs) {
    if (d.vendorKind && d.vendorKind !== 'bigip') continue;
    const u = units.get(dk) || {};
    const f = fo.get(dk) || {};
    const c30 = cpu30.get(dk) || [];
    out.push({
      sourceId: d.sourceId, deviceId: d.deviceId, device: d.device, site: d.site, deviceGroup: null,
      failoverState: u.fo ?? null, failoverText: u.fo != null ? lmIssues.failoverText(u.fo) : null, syncState: u.sync ?? null,
      cpuP95_7d: r1(pctile(cpu7.get(dk) || [], 95)), cpuBaseline: c30.length ? r1(c30.reduce((s, v) => s + v, 0) / c30.length) : null,
      clientConnections: u.conn ?? null, lastFailoverDay: f.lastChangeDay || null, failovers90d: f.count90d || 0,
    });
  }
  return out;
}

/** Hour-of-week profile: median of the raw history samples per (day of week, hour) over `days` (default 14, the history window). */
function hourlyProfile(dbh, p = {}) {
  const metric = p.metric === 'cpu_pct' ? 'cpu_pct' : 'client_connections';
  const days = Math.min(30, Math.max(1, parseInt(p.days, 10) || 14));
  const out = { cells: [], basis: { windowDays: days, samples: 0, metric } };
  if (!has(dbh, 'lm_ds_metrics_history')) return out;
  const devs = fleet.loadDevices(dbh, { vendorKey: p.vendorKey || 'f5', deviceId: p.deviceId, sourceId: p.sourceId });
  if (!devs.size) return out;
  const cutoff = Math.floor((Date.now() - days * DAY_MS) / 1000);
  const where = ['metric = ?', 'sampled_at_epoch >= ?', 'value IS NOT NULL'];
  const args = [metric, cutoff];
  if (p.deviceId != null && p.deviceId !== '') { where.push('lm_device_id = ?'); args.push(Number(p.deviceId)); }
  if (p.sourceId != null && p.sourceId !== '') { where.push('source_id = ?'); args.push(Number(p.sourceId)); }
  const buckets = new Map();
  for (const r of dbh.prepare(`SELECT source_id, lm_device_id, sampled_at_epoch e, value FROM lm_ds_metrics_history WHERE ${where.join(' AND ')}`).iterate(...args)) {
    if (!devs.has(`${r.source_id}:${r.lm_device_id}`)) continue;
    const dt = new Date(r.e * 1000);
    const k = dt.getUTCDay() * 24 + dt.getUTCHours();
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r.value);
    out.basis.samples += 1;
  }
  out.cells = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([k, vals]) => ({ dow: Math.floor(k / 24), hour: k % 24, median: r1(fleet.median(vals)) }));
  return out;
}

module.exports = {
  hourlyProfile, trendsFeed, trendSeries, interfaceSeries, interfacesAnalytics, optics, poe, routingPeers, deviceResources, reachability,
  wirelessAnalytics, certificates, poolMembers, gtm, daemonFlaps, haState,
};
