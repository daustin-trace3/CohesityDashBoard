// LogicMonitor long-term history readers (lm_ds_daily, lm_device_daily, lm_metrics_history).
// Pure of the db singleton: every function takes the database handle. Used by the routes,
// the incident evidence block and the AI Advisor gathers.

const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayAgo = (days) => dayOf(Date.now() - days * 86400000);

const tableExists = (dbh, name) => {
  try { return !!dbh.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name); } catch { return false; }
};

/** Day points of one catalog or raw metric for one instance. */
function metricDaySeries(dbh, sourceId, deviceId, hdsId, instanceKey, metric, days) {
  return dbh.prepare(`
    SELECT day, samples, min_value, sum_value, max_value, last_value
    FROM lm_ds_daily
    WHERE source_id = ? AND lm_device_id = ? AND hds_id = ? AND instance_key = ? AND metric = ? AND day >= ?
    ORDER BY day
  `).all(sourceId, deviceId, hdsId, instanceKey, metric, dayAgo(days)).map((r) => ({
    t: r.day,
    epoch: Math.floor(Date.parse(`${r.day}T00:00:00Z`) / 1000),
    value: r.samples ? r.sum_value / r.samples : null,
    min: r.min_value, max: r.max_value, last: r.last_value, samples: r.samples,
    granularity: 'day',
  }));
}

/** Per-day device state rows, ascending, with percentages (null when no samples). */
function deviceDailyRows(dbh, sourceId, deviceId, days) {
  const rows = dbh.prepare(`
    SELECT day, samples, dead_samples, dead_collector_samples, sdt_samples, worst_host_status,
      alerts_opened, alerts_critical, alerts_warning
    FROM lm_device_daily WHERE source_id = ? AND lm_device_id = ? AND day >= ? ORDER BY day
  `).all(sourceId, deviceId, dayAgo(days));
  const pct = (n, d) => (d ? round1((n * 100) / d) : null);
  const out = rows.map((r) => ({
    day: r.day, samples: r.samples,
    deadPct: pct(r.dead_samples, r.samples),
    deadCollectorPct: pct(r.dead_collector_samples, r.samples),
    sdtPct: pct(r.sdt_samples, r.samples),
    worstHostStatus: r.worst_host_status,
    alertsOpened: r.alerts_opened, alertsCritical: r.alerts_critical, alertsWarning: r.alerts_warning,
  }));
  let dead = 0; let deadC = 0; let sdt = 0; let opened = 0; let crit = 0; let samples = 0; let deadSamples = 0;
  rows.forEach((r) => {
    if (r.dead_samples > 0) dead += 1;
    if (r.dead_collector_samples > 0) deadC += 1;
    if (r.sdt_samples > 0) sdt += 1;
    opened += r.alerts_opened; crit += r.alerts_critical;
    samples += r.samples; deadSamples += r.dead_samples;
  });
  return {
    rows: out,
    summary: {
      days: out.length, daysDead: dead, daysDeadCollector: deadC, daysInSdt: sdt,
      alertsOpened: opened, alertsCritical: crit, deadPct: pct(deadSamples, samples),
    },
  };
}

/** Window aggregate per DataSource, instance and metric (capped 200). */
function deviceBaseline(dbh, sourceId, deviceId, days, kind = 'catalog') {
  const where = ['d.source_id = ?', 'd.lm_device_id = ?', 'd.day >= ?'];
  const params = [sourceId, deviceId, dayAgo(days)];
  if (kind === 'catalog' || kind === 'raw') { where.push('d.kind = ?'); params.push(kind); }
  const rows = dbh.prepare(`
    SELECT d.datasource_name, d.instance_key, d.metric, d.kind,
      SUM(d.samples) samples, SUM(d.sum_value) sum_value, MIN(d.min_value) min_value, MAX(d.max_value) max_value,
      COUNT(DISTINCT d.day) days,
      (SELECT x.last_value FROM lm_ds_daily x WHERE x.source_id = d.source_id AND x.lm_device_id = d.lm_device_id
         AND x.hds_id = d.hds_id AND x.instance_key = d.instance_key AND x.metric = d.metric ORDER BY x.day DESC LIMIT 1) last_value,
      (SELECT i.instance_name FROM lm_ds_instances i WHERE i.source_id = d.source_id AND i.lm_device_id = d.lm_device_id
         AND i.hds_id = d.hds_id AND i.instance_key = d.instance_key LIMIT 1) instance_name
    FROM lm_ds_daily d
    WHERE ${where.join(' AND ')}
    GROUP BY d.datasource_name, d.hds_id, d.instance_key, d.metric, d.kind
    ORDER BY d.datasource_name, d.instance_key, d.metric
    LIMIT 200
  `).all(...params);
  return rows.map((r) => ({
    datasourceName: r.datasource_name, instanceKey: r.instance_key, instanceName: r.instance_name || null,
    metric: r.metric, kind: r.kind,
    avg: r.samples ? r.sum_value / r.samples : null, min: r.min_value, max: r.max_value, last: r.last_value,
    samples: r.samples, days: r.days,
  }));
}

/** Estate device history block for the Trends page and the network brief: { range, topDead, topAlerting, alertsByDay }. */
function deviceDailyBlock(dbh, range = '30d') {
  const days = { '24h': 1, '7d': 7, '30d': 30, '90d': 90, '365d': 365 }[range] || 7;
  const empty = { range, topDead: [], topAlerting: [], alertsByDay: [] };
  if (!tableExists(dbh, 'lm_device_daily')) return empty;
  const since = dayAgo(days);
  const name = "COALESCE(dv.display_name, dv.name, 'device ' || x.lm_device_id)";
  const topDead = dbh.prepare(`
    SELECT x.lm_device_id id, ${name} name,
      SUM(CASE WHEN x.dead_samples > 0 THEN 1 ELSE 0 END) days_dead, SUM(x.dead_samples) dead_s, SUM(x.samples) s
    FROM lm_device_daily x LEFT JOIN lm_devices dv ON dv.source_id = x.source_id AND dv.lm_device_id = x.lm_device_id
    WHERE x.day >= ? GROUP BY x.source_id, x.lm_device_id HAVING days_dead > 0
    ORDER BY days_dead DESC, dead_s DESC, name LIMIT 10
  `).all(since).map((r) => ({
    deviceId: r.id, name: r.name, daysDead: r.days_dead, deadPct: r.s ? round1((r.dead_s * 100) / r.s) : null,
  }));
  const topAlerting = dbh.prepare(`
    SELECT x.lm_device_id id, ${name} name, SUM(x.alerts_opened) opened, SUM(x.alerts_critical) crit
    FROM lm_device_daily x LEFT JOIN lm_devices dv ON dv.source_id = x.source_id AND dv.lm_device_id = x.lm_device_id
    WHERE x.day >= ? GROUP BY x.source_id, x.lm_device_id HAVING opened > 0
    ORDER BY opened DESC, crit DESC, name LIMIT 10
  `).all(since).map((r) => ({ deviceId: r.id, name: r.name, alertsOpened: r.opened, alertsCritical: r.crit }));
  const alertsByDay = dbh.prepare(`
    SELECT day, SUM(alerts_opened) opened, SUM(alerts_critical) critical, SUM(alerts_warning) warning
    FROM lm_device_daily WHERE day >= ? GROUP BY day ORDER BY day
  `).all(since).map((r) => ({ day: r.day, opened: r.opened, critical: r.critical, warning: r.warning }));
  return { range, topDead, topAlerting, alertsByDay };
}

/**
 * N-day CPU and memory baseline of one device: per day the highest instance average, then
 * the mean of those days and the highest day max. null when no rows.
 */
function cpuMemBaseline(dbh, sourceId, deviceId, days = 30) {
  if (!tableExists(dbh, 'lm_ds_daily')) return null;
  const one = (metric) => {
    const r = dbh.prepare(`
      SELECT AVG(a) avg, MAX(m) max, COUNT(*) days FROM (
        SELECT day, MAX(sum_value * 1.0 / samples) a, MAX(max_value) m
        FROM lm_ds_daily WHERE source_id = ? AND lm_device_id = ? AND metric = ? AND kind = 'catalog' AND samples > 0 AND day >= ?
        GROUP BY day)
    `).get(sourceId, deviceId, metric, dayAgo(days));
    return r && r.days ? r : null;
  };
  const cpu = one('cpu_pct');
  const mem = one('mem_pct');
  if (!cpu && !mem) return null;
  return {
    cpuAvg: cpu ? cpu.avg : null, cpuMax: cpu ? cpu.max : null,
    memAvg: mem ? mem.avg : null, memMax: mem ? mem.max : null,
    days: Math.max(cpu ? cpu.days : 0, mem ? mem.days : 0),
  };
}

/** Top devices by 30-day CPU average with their memory avg and max (for hardware_health). */
function topCpuBaselines(dbh, days = 30, limit = 25) {
  if (!tableExists(dbh, 'lm_ds_daily')) return [];
  const since = dayAgo(days);
  const rows = dbh.prepare(`
    SELECT d.source_id, d.lm_device_id, COALESCE(dv.display_name, dv.name) name,
      SUM(d.sum_value) * 1.0 / SUM(d.samples) cpu_avg, MAX(d.max_value) cpu_max
    FROM lm_ds_daily d LEFT JOIN lm_devices dv ON dv.source_id = d.source_id AND dv.lm_device_id = d.lm_device_id
    WHERE d.metric = 'cpu_pct' AND d.kind = 'catalog' AND d.samples > 0 AND d.day >= ?
    GROUP BY d.source_id, d.lm_device_id ORDER BY cpu_avg DESC LIMIT ?
  `).all(since, limit);
  const mem = dbh.prepare(`
    SELECT SUM(sum_value) * 1.0 / SUM(samples) avg, MAX(max_value) max FROM lm_ds_daily
    WHERE source_id = ? AND lm_device_id = ? AND metric = 'mem_pct' AND kind = 'catalog' AND samples > 0 AND day >= ?
  `);
  return rows.map((r) => {
    const m = mem.get(r.source_id, r.lm_device_id, since) || {};
    return {
      deviceName: r.name, cpuAvgPct: round1(r.cpu_avg), cpuMaxPct: round1(r.cpu_max),
      memAvgPct: round1(m.avg), memMaxPct: round1(m.max),
    };
  });
}

/** One point per UTC day of lm_metrics_history: per-tick sums across portals, averaged over the day. */
function metricsHistoryByDay(dbh, days) {
  const rows = dbh.prepare(`
    SELECT day,
      AVG(dn) dn, AVG(dd) dd, AVG(ddc) ddc, AVG(iu) iu, AVG(idn) idn, AVG(ac) ac, AVG(aw) aw, AVG(cd) cd, AVG(chd) chd, AVG(chg) chg
    FROM (
      SELECT substr(datetime(captured_at), 1, 16) k, substr(datetime(captured_at), 1, 10) day,
        SUM(COALESCE(devices_normal, 0)) dn, SUM(COALESCE(devices_dead, 0)) dd, SUM(COALESCE(devices_dead_collector, 0)) ddc,
        SUM(COALESCE(interfaces_up, 0)) iu, SUM(COALESCE(interfaces_down, 0)) idn,
        SUM(COALESCE(alerts_critical, 0)) ac, SUM(COALESCE(alerts_warning, 0)) + SUM(COALESCE(alerts_error, 0)) aw,
        SUM(COALESCE(collectors_down, 0)) cd, SUM(COALESCE(checks_down, 0)) chd, SUM(COALESCE(checks_degraded, 0)) chg
      FROM lm_metrics_history WHERE datetime(captured_at) >= datetime(?)
      GROUP BY k
    ) GROUP BY day ORDER BY day
  `).all(new Date(Date.now() - days * 86400000).toISOString());
  const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
  return rows.map((r) => ({
    at: `${r.day}T12:00:00.000Z`,
    devicesNormal: r1(r.dn), devicesDead: r1(r.dd), devicesDeadCollector: r1(r.ddc),
    interfacesUp: r1(r.iu), interfacesDown: r1(r.idn), alertsCritical: r1(r.ac), alertsWarning: r1(r.aw), alertsInfo: null,
    collectorsDown: r1(r.cd), checksDown: r1(r.chd), checksDegraded: r1(r.chg),
  }));
}

module.exports = {
  metricDaySeries, deviceDailyRows, deviceBaseline, deviceDailyBlock, cpuMemBaseline, topCpuBaselines, metricsHistoryByDay,
};
