// LogicMonitor AI Advisor presets. Every gather reads stored lm_* tables only
// (no live portal calls), returns plain JSON for the shared engine to
// anonymize, and uses single-quoted SQLite literals. Time cutoffs are built
// in JS and bound; captured_at style TEXT columns are compared through
// datetime() so ISO and SQLite formats both compare correctly.
const db = require('../../db/database');
const { createPlatformAdvisor } = require('../platformAdvisor');
const { getSetting } = require('../settings');

const nowSec = () => Math.floor(Date.now() / 1000);
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();
const DAY = 86400000;
const parseArr = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };

function sourceCount() {
  return db.prepare('SELECT COUNT(*) n FROM lm_sources').get().n;
}
const noteIfEmpty = () => (sourceCount() === 0 ? 'No LogicMonitor portals registered.' : undefined);

function utilWarn() {
  const n = parseInt(getSetting('lm_if_util_warn_pct'), 10);
  return Number.isFinite(n) ? Math.min(100, Math.max(50, n)) : 80;
}

function mgdBySource() {
  const out = new Map();
  for (const s of db.prepare('SELECT id, features_json FROM lm_sources').all()) {
    let f = {};
    try { f = JSON.parse(s.features_json || '{}') || {}; } catch { f = {}; }
    out.set(s.id, f.collectorMgd || null);
  }
  return out;
}
function buildBehind(build, mgd) {
  if (!build || !mgd) return false;
  const parts = (v) => String(v).split('.').slice(0, 2).map((p) => parseInt(p, 10) || 0);
  const [a1, a2 = 0] = parts(build);
  const [b1, b2 = 0] = parts(mgd);
  return a1 < b1 || (a1 === b1 && a2 < b2);
}
function cmpVersion(a, b) {
  const pa = String(a || '').match(/\d+|[a-z]+/gi) || [];
  const pb = String(b || '').match(/\d+|[a-z]+/gi) || [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i]; const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) { const d = Number(x) - Number(y); if (d) return d < 0 ? -1 : 1; } else {
      const c = String(x).localeCompare(String(y)); if (c) return c;
    }
  }
  return 0;
}
const ageHours = (sec) => (sec ? Math.round((nowSec() - Number(sec)) / 3600) : null);

function issueHistorySlice(types, sinceMs) {
  const ph = types.map(() => '?').join(',');
  return db.prepare(`
    SELECT type, severity, source, target, message, status, first_seen, resolved_at FROM lm_issue_history
    WHERE type IN (${ph}) AND datetime(first_seen) >= datetime(?)
    ORDER BY datetime(first_seen) DESC LIMIT 40
  `).all(...types, isoAgo(sinceMs));
}

// ---- network_health --------------------------------------------------------

function gatherNetworkHealth() {
  const statusByVendor = db.prepare(`
    SELECT COALESCE(vendor, 'Unknown') vendor, COALESCE(host_status, 'unknown') host_status, COUNT(*) n
    FROM lm_devices WHERE stale = 0 GROUP BY COALESCE(vendor, 'Unknown'), COALESCE(host_status, 'unknown') ORDER BY n DESC
  `).all();
  const groups = new Map(db.prepare('SELECT source_id, lm_group_id, full_path FROM lm_device_groups').all().map((g) => [`${g.source_id}:${g.lm_group_id}`, g.full_path]));
  const statusByGroup = {};
  for (const d of db.prepare('SELECT source_id, group_ids_json, host_status FROM lm_devices WHERE stale = 0').all()) {
    for (const g of parseArr(d.group_ids_json)) {
      const name = groups.get(`${d.source_id}:${g}`);
      if (!name) continue;
      if (!statusByGroup[name]) statusByGroup[name] = {};
      const k = d.host_status || 'unknown';
      statusByGroup[name][k] = (statusByGroup[name][k] || 0) + 1;
    }
  }
  const deadDevices = db.prepare(`
    SELECT d.display_name, d.host_status, d.vendor, d.role, d.is_network, d.updated_epoch,
      COALESCE(c.hostname, d.collector_description) collector
    FROM lm_devices d LEFT JOIN lm_collectors c ON c.source_id = d.source_id AND c.collector_id = d.collector_id
    WHERE d.stale = 0 AND d.host_status IN ('dead', 'dead-collector')
    ORDER BY CASE d.host_status WHEN 'dead' THEN 0 ELSE 1 END, d.is_network DESC LIMIT 40
  `).all().map((d) => ({
    device: d.display_name, hostStatus: d.host_status, vendor: d.vendor, role: d.role,
    network: d.is_network === 1, collector: d.collector,
  }));
  const interfacesDown = db.prepare(`
    SELECT d.display_name device, i.display_name iface, i.description
    FROM lm_interfaces i JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
    WHERE i.stale = 0 AND i.status_text = 'down' AND COALESCE(i.stop_monitoring, 0) = 0
    ORDER BY d.display_name LIMIT 40
  `).all();
  const alertsBySeverity = db.prepare(`
    SELECT severity_norm, COUNT(*) n FROM lm_alerts WHERE cleared = 0 GROUP BY severity_norm
  `).all();
  const alertsByDatasource = db.prepare(`
    SELECT COALESCE(resource_template_name, 'Unknown') datasource, severity_norm, COUNT(*) n FROM lm_alerts
    WHERE cleared = 0 GROUP BY COALESCE(resource_template_name, 'Unknown'), severity_norm ORDER BY n DESC LIMIT 25
  `).all();
  const collectorsDown = db.prepare(`
    SELECT hostname, group_name, number_of_hosts, in_sdt FROM lm_collectors WHERE stale = 0 AND is_down = 1
  `).all();
  return {
    generatedAt: new Date().toISOString(),
    deviceStatusByVendor: statusByVendor,
    deviceStatusByGroup: statusByGroup,
    deadAndDeadCollectorDevices: deadDevices,
    interfacesDown,
    openAlertsBySeverity: alertsBySeverity,
    openAlertsByDatasource: alertsByDatasource,
    collectorsDown,
    note: noteIfEmpty(),
  };
}

// ---- interface_capacity ----------------------------------------------------

function gatherInterfaceCapacity() {
  const warn = utilWarn();
  const topBy = (days) => db.prepare(`
    SELECT d.display_name device, i.display_name iface, i.speed_bps,
      MAX(MAX(COALESCE(x.max_in_util_pct, 0), COALESCE(x.max_out_util_pct, 0))) peak_pct,
      AVG(MAX(COALESCE(x.avg_in_util_pct, 0), COALESCE(x.avg_out_util_pct, 0))) avg_pct
    FROM lm_interface_daily x
    JOIN lm_interfaces i ON i.source_id = x.source_id AND i.instance_id = x.instance_id
    JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
    WHERE x.day >= ? GROUP BY x.source_id, x.instance_id ORDER BY peak_pct DESC LIMIT 25
  `).all(new Date(Date.now() - days * DAY).toISOString().slice(0, 10));
  const repeatedlyHot = db.prepare(`
    SELECT d.display_name device, i.display_name iface, COUNT(*) hot_days
    FROM lm_interface_daily x
    JOIN lm_interfaces i ON i.source_id = x.source_id AND i.instance_id = x.instance_id
    JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
    WHERE x.day >= ? AND MAX(COALESCE(x.max_in_util_pct, 0), COALESCE(x.max_out_util_pct, 0)) >= ?
    GROUP BY x.source_id, x.instance_id HAVING hot_days >= 3 ORDER BY hot_days DESC LIMIT 25
  `).all(new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10), warn);
  const speedClasses = db.prepare(`
    SELECT CASE WHEN speed_bps IS NULL OR speed_bps <= 0 THEN 'unknown'
      WHEN speed_bps <= 100000000 THEN '<=100M' WHEN speed_bps <= 1000000000 THEN '1G'
      WHEN speed_bps <= 10000000000 THEN '10G' ELSE '25G+' END speed_class, COUNT(*) n
    FROM lm_interfaces WHERE stale = 0 GROUP BY speed_class ORDER BY n DESC
  `).all();
  const neverUsed = db.prepare(`
    SELECT d.display_name device, COUNT(*) unused_ports FROM lm_interfaces i
    JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
    WHERE i.stale = 0 AND (SELECT COUNT(*) FROM lm_interface_daily x WHERE x.source_id = i.source_id
      AND x.instance_id = i.instance_id AND x.day >= ? AND MAX(COALESCE(x.max_in_util_pct, 0), COALESCE(x.max_out_util_pct, 0)) < 1) >= 30
    GROUP BY i.source_id, i.lm_device_id ORDER BY unused_ports DESC LIMIT 20
  `).all(new Date(Date.now() - 31 * DAY).toISOString().slice(0, 10));
  return {
    generatedAt: new Date().toISOString(),
    utilizationWarnPct: warn,
    top25ByPeak7d: topBy(7),
    top25ByPeak30d: topBy(30),
    repeatedlyOverWarn30d: repeatedlyHot,
    speedClasses,
    neverUsedPortsByDevice30d: neverUsed,
    note: noteIfEmpty(),
  };
}

// ---- alert_noise -----------------------------------------------------------

function gatherAlertNoise() {
  const since30 = nowSec() - 30 * 86400;
  const perDay = db.prepare(`
    SELECT date(start_epoch, 'unixepoch') day, severity_norm, COUNT(*) n FROM lm_alerts
    WHERE start_epoch >= ? GROUP BY day, severity_norm ORDER BY day ASC
  `).all(since30);
  const topConditions = db.prepare(`
    SELECT MAX(monitor_object_name) device, MAX(resource_template_name) datasource, MAX(instance_name) instance,
      MAX(data_point_name) datapoint, COUNT(*) fires, SUM(CASE WHEN cleared = 1 THEN 1 ELSE 0 END) cleared_count
    FROM lm_alerts WHERE start_epoch >= ? GROUP BY condition_key ORDER BY fires DESC LIMIT 15
  `).all(since30);
  const ackedOpen = db.prepare(`
    SELECT monitor_object_name device, resource_template_name datasource, data_point_name datapoint, severity_norm, start_epoch
    FROM lm_alerts WHERE cleared = 0 AND acked = 1 ORDER BY start_epoch ASC LIMIT 25
  `).all().map((a) => ({ device: a.device, datasource: a.datasource, datapoint: a.datapoint, severity: a.severity_norm, openHours: ageHours(a.start_epoch) }));
  const inSdt = db.prepare("SELECT COUNT(*) n FROM lm_alerts WHERE cleared = 0 AND sdted = 1").get().n;
  const unrouted = db.prepare("SELECT COUNT(*) n FROM lm_alerts WHERE cleared = 0 AND COALESCE(rule, '') = ''").get().n;
  const openBySeverity = db.prepare('SELECT severity_norm, COUNT(*) n FROM lm_alerts WHERE cleared = 0 GROUP BY severity_norm').all();
  return {
    generatedAt: new Date().toISOString(),
    alertsOpenedPerDay30d: perDay,
    top15ConditionsByRefire30d: topConditions,
    ackedButOpen: ackedOpen,
    openAlertsInSdt: inSdt,
    openAlertsWithoutRule: unrouted,
    openBySeverity,
    note: noteIfEmpty(),
  };
}

// ---- collector_health ------------------------------------------------------

function gatherCollectorHealth() {
  const mgd = mgdBySource();
  const collectors = db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM lm_devices d WHERE d.source_id = c.source_id AND d.collector_id = c.collector_id AND d.stale = 0) devices
    FROM lm_collectors c WHERE c.stale = 0 ORDER BY c.is_down DESC, devices DESC
  `).all().map((c) => ({
    collector: c.hostname || c.description, group: c.group_name, platform: c.platform, build: c.build,
    currentMgd: mgd.get(c.source_id) || null, behindMgd: buildBehind(c.build, mgd.get(c.source_id)),
    isDown: c.is_down === 1, inSdt: c.in_sdt === 1, devices: c.devices, instances: c.number_of_instances,
    uptimeHours: c.uptime_seconds != null ? Math.round(c.uptime_seconds / 3600) : null,
    hasBackupCollector: !!c.backup_collector_id,
  }));
  const counts = collectors.map((c) => c.devices).sort((a, b) => a - b);
  const distribution = counts.length ? {
    collectors: counts.length, min: counts[0], max: counts[counts.length - 1],
    median: counts[Math.floor(counts.length / 2)], total: counts.reduce((a, b) => a + b, 0),
  } : null;
  const deadCollectorByDay = db.prepare(`
    SELECT date(datetime(captured_at)) day, MAX(COALESCE(devices_dead_collector, 0)) max_dead_collector,
      MAX(COALESCE(collectors_down, 0)) max_collectors_down
    FROM lm_metrics_history WHERE datetime(captured_at) >= datetime(?)
    GROUP BY day HAVING max_dead_collector > 0 OR max_collectors_down > 0 ORDER BY day ASC
  `).all(isoAgo(30 * DAY));
  return {
    generatedAt: new Date().toISOString(),
    collectors,
    devicesPerCollector: distribution,
    deadCollectorDays30d: deadCollectorByDay,
    collectorIssues30d: issueHistorySlice(['collector-down', 'collector-build-behind'], 30 * DAY),
    note: noteIfEmpty(),
  };
}

// ---- device_lifecycle ------------------------------------------------------

function gatherDeviceLifecycle() {
  const levels = db.prepare(`
    SELECT COALESCE(vendor, 'Unknown') vendor, COALESCE(model, 'Unknown') model, version, COUNT(*) n
    FROM lm_devices WHERE stale = 0 AND version IS NOT NULL AND version != ''
    GROUP BY COALESCE(vendor, 'Unknown'), COALESCE(model, 'Unknown'), version
  `).all();
  const byModel = {};
  for (const l of levels) {
    const k = `${l.vendor} ${l.model}`;
    if (!byModel[k]) byModel[k] = { vendor: l.vendor, model: l.model, versions: [], newest: null, devicesBehind: 0, devices: 0 };
    byModel[k].versions.push({ version: l.version, count: l.n });
    byModel[k].devices += l.n;
    if (!byModel[k].newest || cmpVersion(l.version, byModel[k].newest) > 0) byModel[k].newest = l.version;
  }
  for (const m of Object.values(byModel)) {
    m.devicesBehind = m.versions.filter((v) => v.version !== m.newest).reduce((a, v) => a + v.count, 0);
    m.drift = m.versions.length > 1;
  }
  const singletons = db.prepare(`
    SELECT COALESCE(vendor, 'Unknown') vendor, model, COUNT(*) n FROM lm_devices
    WHERE stale = 0 AND is_network = 1 AND model IS NOT NULL GROUP BY COALESCE(vendor, 'Unknown'), model HAVING n = 1
  `).all();
  const unknownVersion = db.prepare(`
    SELECT COUNT(*) n FROM lm_devices WHERE stale = 0 AND is_network = 1 AND (version IS NULL OR version = '')
  `).get().n;
  const newDevices = db.prepare(`
    SELECT display_name device, vendor, model, role, first_seen FROM lm_devices
    WHERE stale = 0 AND datetime(first_seen) >= datetime(?) ORDER BY datetime(first_seen) DESC LIMIT 30
  `).all(isoAgo(30 * DAY));
  return {
    generatedAt: new Date().toISOString(),
    versionsByModel: Object.values(byModel).sort((a, b) => b.devicesBehind - a.devicesBehind),
    singleDeviceModels: singletons,
    networkDevicesWithoutVersion: unknownVersion,
    firstSeenLast30d: newDevices,
    note: noteIfEmpty(),
  };
}

// ---- site_reachability -----------------------------------------------------

function gatherSiteReachability() {
  const since7 = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10);
  const worstLinks = db.prepare(`
    SELECT c.name check_name, l.label location, AVG(x.rtt_avg) rtt_avg_ms, MAX(x.rtt_p95) rtt_p95_ms,
      AVG(x.loss_avg) loss_avg_pct, MAX(x.loss_max) loss_max_pct, SUM(COALESCE(x.down_samples, 0)) down_samples
    FROM lm_check_daily x
    JOIN lm_checks c ON c.source_id = x.source_id AND c.check_id = x.check_id
    LEFT JOIN lm_check_locations l ON l.source_id = x.source_id AND l.check_id = x.check_id AND l.checkpoint_id = x.checkpoint_id
    WHERE x.day >= ? GROUP BY x.source_id, x.check_id, x.checkpoint_id
    ORDER BY down_samples DESC, loss_max_pct DESC, rtt_p95_ms DESC LIMIT 20
  `).all(since7);
  const downEpisodes = db.prepare(`
    SELECT c.name check_name, l.label location, x.day, x.down_samples, x.samples
    FROM lm_check_daily x
    JOIN lm_checks c ON c.source_id = x.source_id AND c.check_id = x.check_id
    LEFT JOIN lm_check_locations l ON l.source_id = x.source_id AND l.check_id = x.check_id AND l.checkpoint_id = x.checkpoint_id
    WHERE x.day >= ? AND COALESCE(x.down_samples, 0) > 0 ORDER BY x.day DESC LIMIT 40
  `).all(since7);
  const hour = new Date().getUTCHours();
  const baselineVsNow = db.prepare(`
    SELECT c.name check_name, l.label location, l.last_status, l.last_rtt_ms, l.last_loss_pct,
      b.rtt_median, b.rtt_mad, b.loss_median, b.loss_mad, b.samples
    FROM lm_check_locations l
    JOIN lm_checks c ON c.source_id = l.source_id AND c.check_id = l.check_id
    LEFT JOIN lm_check_baseline b ON b.source_id = l.source_id AND b.check_id = l.check_id
      AND b.checkpoint_id = l.checkpoint_id AND b.hour_of_day = ?
    WHERE l.stale = 0 AND c.stale = 0 ORDER BY c.name, l.label LIMIT 80
  `).all(hour);
  const suggested = db.prepare(`
    SELECT c.name check_name, l.label location, MAX(b.rtt_median + 3 * MAX(COALESCE(b.rtt_mad, 0), 5)) rtt_warn_ms,
      MAX(b.loss_median + 3 * MAX(COALESCE(b.loss_mad, 0), 1)) loss_warn_pct
    FROM lm_check_baseline b
    JOIN lm_checks c ON c.source_id = b.source_id AND c.check_id = b.check_id
    LEFT JOIN lm_check_locations l ON l.source_id = b.source_id AND l.check_id = b.check_id AND l.checkpoint_id = b.checkpoint_id
    WHERE COALESCE(b.samples, 0) > 0 GROUP BY b.source_id, b.check_id, b.checkpoint_id ORDER BY c.name LIMIT 60
  `).all();
  return {
    generatedAt: new Date().toISOString(),
    worstLinks7d: worstLinks,
    anomaliesOpened7d: issueHistorySlice(['latency-anomaly', 'packet-loss-anomaly', 'location-degraded', 'check-down', 'check-location-down'], 7 * DAY),
    downEpisodes7d: downEpisodes,
    baselineVsNow: baselineVsNow,
    baselineHourUtc: hour,
    suggestedThresholds: suggested,
    note: noteIfEmpty(),
  };
}

// ---- availability_review ---------------------------------------------------

function gatherAvailabilityReview() {
  const deadByDay = db.prepare(`
    SELECT date(datetime(captured_at)) day, MAX(COALESCE(devices_dead, 0)) max_dead,
      MAX(COALESCE(devices_dead_collector, 0)) max_dead_collector, MAX(COALESCE(interfaces_down, 0)) max_interfaces_down,
      MAX(COALESCE(checks_down, 0)) max_checks_down
    FROM lm_metrics_history WHERE datetime(captured_at) >= datetime(?) GROUP BY day ORDER BY day ASC
  `).all(isoAgo(30 * DAY));
  const deadEpisodes = issueHistorySlice(['device-dead', 'collector-down', 'source-unreachable'], 30 * DAY);
  const hostStatusAlerts = db.prepare(`
    SELECT monitor_object_name device, COUNT(*) episodes FROM lm_alerts
    WHERE start_epoch >= ? AND (resource_template_name LIKE 'Host Status%' OR instance_name = 'HostStatus')
    GROUP BY lower(monitor_object_name) ORDER BY episodes DESC LIMIT 20
  `).all(nowSec() - 30 * 86400);
  const flaps = db.prepare(`
    SELECT d.display_name device, i.display_name iface, SUM(COALESCE(x.flaps, 0)) flaps, SUM(COALESCE(x.down_samples, 0)) down_samples
    FROM lm_interface_daily x
    JOIN lm_interfaces i ON i.source_id = x.source_id AND i.instance_id = x.instance_id
    JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
    WHERE x.day >= ? GROUP BY x.source_id, x.instance_id HAVING flaps > 0 ORDER BY flaps DESC LIMIT 20
  `).all(new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10));
  const checkDown = db.prepare(`
    SELECT c.name check_name, SUM(COALESCE(x.down_samples, 0)) down_samples, SUM(COALESCE(x.samples, 0)) samples
    FROM lm_check_daily x JOIN lm_checks c ON c.source_id = x.source_id AND c.check_id = x.check_id
    WHERE x.day >= ? GROUP BY x.source_id, x.check_id HAVING down_samples > 0 ORDER BY down_samples DESC LIMIT 20
  `).all(new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10));
  return {
    generatedAt: new Date().toISOString(),
    dailyAvailability30d: deadByDay,
    deadEpisodes30d: deadEpisodes,
    hostStatusAlertEpisodes30d: hostStatusAlerts,
    interfaceFlaps30d: flaps,
    checkDownSamples30d: checkDown,
    note: noteIfEmpty(),
  };
}

// ---- circuit_capacity (round 3) ------------------------------------------------

function gatherCircuitCapacity() {
  const lmPath = require('../logicmonitorPath');
  const rows = lmPath.circuitRows(db);
  return {
    generatedAt: new Date().toISOString(),
    circuits: rows.map((c) => ({
      site: c.siteName, device: c.deviceName, port: c.port, label: c.label, reason: c.wanReason, speedMbps: c.speedBps ? Math.round(c.speedBps / 1e6) : null,
      status: c.statusText, p95InPct: c.p95InPct, p95OutPct: c.p95OutPct, highestDailyPeakPct: c.maxDailyPct, headroomPct: c.headroomPct,
      errors24h: c.errors24h, flaps24h: c.flaps24h, busiestHourUtc: c.busiestHour, daysAtCriticalPeak: c.critDays, state: c.state,
    })),
    thresholds: { saturationP95Pct: db.prepare("SELECT value FROM app_settings WHERE key = 'lm_circuit_sat_pct'").get()?.value || '80',
      criticalDailyPeakPct: db.prepare("SELECT value FROM app_settings WHERE key = 'lm_circuit_crit_pct'").get()?.value || '95' },
    openCircuitIssues: issueHistorySlice(['circuit-saturated'], 30 * DAY),
    note: noteIfEmpty(),
  };
}

// ---- backup_network_impact (round 3) ---------------------------------------------

function gatherBackupNetworkImpact() {
  const lmEndpoints = require('../logicmonitorEndpoints');
  const rows = lmEndpoints.backupLoad(db, { days: 7 });
  const byPort = new Map();
  for (const w of rows) {
    const k = `${w.deviceName}|${w.port}`;
    const e = byPort.get(k) || { switch: w.deviceName, port: w.port, windows: 0, saturates: 0, elevated: 0, peakMeanUtilPct: 0, jobs: new Set() };
    e.windows += 1;
    if (w.finding) e[w.finding] += 1;
    e.peakMeanUtilPct = Math.max(e.peakMeanUtilPct, w.meanUtilPct);
    for (const r of w.runs) e.jobs.add(r.jobName);
    byPort.set(k, e);
  }
  return {
    generatedAt: new Date().toISOString(),
    windows7d: rows.slice(0, 60).map((w) => ({
      switch: w.deviceName, port: w.port, host: w.host, hostPlatform: w.hostPlatform, uplinkRule: w.uplinkRule,
      windowStart: w.windowStart, windowEnd: w.windowEnd, meanUtilPct: w.meanUtilPct, maxUtilPct: w.maxUtilPct,
      baselineUtilPct: w.baselineUtilPct, finding: w.finding || null,
      jobs: w.runs.map((r) => ({ job: r.jobName, object: r.objectName, status: r.status, sharePct: r.sharePct })),
    })),
    byPort: [...byPort.values()].map((e) => ({ ...e, jobs: [...e.jobs] })).sort((a, b) => (b.saturates - a.saturates) || (b.windows - a.windows)).slice(0, 20),
    note: noteIfEmpty(),
  };
}

// ---- replication_bandwidth (round 4) --------------------------------------------

function gatherReplicationBandwidth() {
  const lmPath = require('../logicmonitorPath');
  const corr = require('../logicmonitorCorrelation');
  const events = corr.replicationVsCircuits(db, { days: 7 });
  return {
    generatedAt: new Date().toISOString(),
    events7d: events.slice(0, 60).map((e) => ({
      kind: e.kind, subject: e.subject, detail: e.detail, at: e.at, until: e.until, site: e.siteKey,
      circuit: e.circuit, circuitUtilPct: e.circuitUtilPct, circuitP95Pct: e.circuitP95Pct, overlapMinutes: e.overlapMinutes, finding: e.finding || null,
    })),
    circuits: lmPath.circuitRows(db).map((c) => ({
      site: c.siteName, device: c.deviceName, port: c.port, label: c.label, p95InPct: c.p95InPct, p95OutPct: c.p95OutPct,
      highestDailyPeakPct: c.maxDailyPct, headroomPct: c.headroomPct, busiestHourUtc: c.busiestHour, state: c.state,
    })),
    note: noteIfEmpty(),
  };
}

// ---- Round 6 helpers ----------------------------------------------------------

const LIST_CAP = 25;
const safe = (fn, fallback) => { try { const v = fn(); return v === undefined ? fallback : v; } catch { return fallback; } };
const hasTable = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const lower = (s) => String(s == null ? '' : s).toLowerCase();
const sqlMs = (val) => {
  if (!val) return null;
  const s = String(val);
  const ms = Date.parse(/[TZ]/.test(s) || /[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? null : ms;
};
const sqlIso = (val) => { const ms = sqlMs(val); return ms == null ? null : new Date(ms).toISOString(); };
const dayStr = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 10);
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 100) / 100;
};
const percentile = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
};
const routesModule = () => require('../../routes/logicmonitor');
const openIssueRows = () => safe(() => db.prepare("SELECT severity, type, source, target, message, first_seen FROM lm_issue_history WHERE status = 'open' ORDER BY datetime(first_seen)").all(), []);
const issueOut = (r) => ({ severity: r.severity, type: r.type, target: r.target, message: r.message, firstSeen: sqlIso(r.first_seen) });
const hasSdtSlot = (s) => !!s && String(s).toLowerCase().split('-').some((p) => p && p !== 'none');

// ---- network_brief (round 6) -----------------------------------------------------

function seriesStat(series) {
  const v = (Array.isArray(series) ? series : []).filter((x) => x != null && Number.isFinite(Number(x))).map(Number);
  return v.length ? { min: Math.min(...v), max: Math.max(...v), last: v[v.length - 1] } : { min: null, max: null, last: null };
}

function gatherNetworkBrief() {
  const ov = require('../logicmonitorOverview').buildOverview(db);
  const lastN = (a, n) => (Array.isArray(a) ? a.slice(-n) : []);
  const nodes = (ov.map && ov.map.nodes) || [];
  const burning = ov.burning || [];
  const trends = ov.trends || {};
  const alertsBy = trends.alertsBySeverity || {};
  const degr = trends.degradation || {};
  const issuesOpened = safe(() => db.prepare(`
    SELECT severity, type, source, target, message, status, first_seen FROM lm_issue_history
    WHERE datetime(first_seen) >= datetime(?) ORDER BY datetime(first_seen) DESC LIMIT ${LIST_CAP}
  `).all(isoAgo(DAY)).map((r) => ({ ...issueOut(r), status: r.status })), []);
  const issuesOpened24hTotal = safe(() => db.prepare('SELECT COUNT(*) n FROM lm_issue_history WHERE datetime(first_seen) >= datetime(?)').get(isoAgo(DAY)).n, 0);
  const issuesResolved24h = safe(() => db.prepare('SELECT COUNT(*) n FROM lm_issue_history WHERE resolved_at IS NOT NULL AND datetime(resolved_at) >= datetime(?)').get(isoAgo(DAY)).n, 0);
  const configChanges24h = safe(() => {
    const byScope = {};
    for (const c of require('../configLedger').listChanges({ days: 1, platform: 'logicmonitor', limit: 1000 })) {
      if (sqlMs(c.detected_at) >= Date.now() - DAY) byScope[c.scope] = (byScope[c.scope] || 0) + 1;
    }
    return byScope;
  }, {});
  return {
    generatedAt: new Date().toISOString(),
    health: ov.health || { score: null },
    counters: ov.counters || {},
    nodesTotal: nodes.length,
    nodes: nodes.slice(0, LIST_CAP).map((n) => {
      const r = n.reachability || {};
      return {
        siteKey: n.siteKey, siteName: n.siteName, state: n.state, devicesDead: n.devicesDead, interfacesDown: n.interfacesDown,
        circuitsSaturated: n.circuitsSaturated, openIssues: n.openIssues,
        reachability: { direction: r.direction || null, worst: r.worst || null, lastSixHours: lastN(r.series, 6) },
      };
    }),
    burningTotal: burning.length,
    burning: burning.slice(0, LIST_CAP).map((b) => ({
      severity: b.severity, type: b.type, target: b.target, message: b.message, since: b.since, siteKey: b.siteKey, siteName: b.siteName,
      likelyHop: b.likelyHop || null,
      metric: b.metric ? { label: b.metric.label, direction: b.metric.direction || null, worst: b.metric.worst || null, ...seriesStat(b.metric.series) } : null,
    })),
    trendsLastSixHours: {
      hours: lastN(trends.hours, 6),
      alertsBySeverity: { critical: lastN(alertsBy.critical, 6), warning: lastN(alertsBy.warning, 6), info: lastN(alertsBy.info, 6) },
      degradation: { linksDegraded: lastN(degr.linksDegraded, 6), portsDown: lastN(degr.portsDown, 6) },
    },
    changedLast24h: { issuesOpenedTotal: issuesOpened24hTotal, issuesOpened, issuesResolved: issuesResolved24h, configChangesByScope: configChanges24h },
    note: noteIfEmpty(),
  };
}

// ---- chokepoints (round 6) -------------------------------------------------------

const CHRONIC_DAYS = 5;

function gatherChokepoints() {
  const bh = require('../logicmonitorCorrelation').blameHistory(db, { days: 30 });
  const top = bh.hops.slice(0, 10);
  const open = openIssueRows();
  const daysStmt = safe(() => db.prepare(`
    SELECT COUNT(DISTINCT date(datetime(at))) n FROM lm_blame_history
    WHERE datetime(at) >= datetime(?) AND lower(COALESCE(hop_device_name, '')) = ? AND lower(COALESCE(hop_port, '')) = ?
  `), null);
  const devStmt = safe(() => db.prepare('SELECT host_status, lm_device_id FROM lm_devices WHERE stale = 0 AND (lower(display_name) = ? OR lower(name) = ?) LIMIT 1'), null);
  const ifStmt = safe(() => db.prepare(`
    SELECT i.display_name, i.description, i.status_text, i.speed_bps, i.in_util_pct, i.out_util_pct,
      i.in_errors, i.out_errors, i.in_discards, i.out_discards
    FROM lm_interfaces i JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
    WHERE i.stale = 0 AND d.stale = 0 AND (lower(d.display_name) = ? OR lower(d.name) = ?)
      AND (lower(i.display_name) = ? OR lower(i.instance_name) = ?) LIMIT 1
  `), null);
  // Blame stores the port as the path code wrote it (Te1/0/3) while the interface row
  // may carry the long name (TenGigabitEthernet1/0/3): fall back to prefix letters + numeric tail.
  const ifLikeStmt = safe(() => db.prepare(`
    SELECT i.display_name, i.description, i.status_text, i.speed_bps, i.in_util_pct, i.out_util_pct,
      i.in_errors, i.out_errors, i.in_discards, i.out_discards
    FROM lm_interfaces i JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
    WHERE i.stale = 0 AND d.stale = 0 AND (lower(d.display_name) = ? OR lower(d.name) = ?) AND lower(i.display_name) LIKE ? LIMIT 200
  `), null);
  const looseIface = (dev, port) => {
    const m = /^([a-z]{2})[a-z-]*?(\d+(?:\/\d+)*)$/.exec(port.replace(/\s+/g, ''));
    if (!m || !ifLikeStmt) return null;
    return safe(() => ifLikeStmt.all(dev, dev, `${m[1]}%`).find((r) => {
      const n = lower(r.display_name).replace(/\s+/g, '');
      return n.endsWith(m[2]) && !/\d/.test(n.charAt(n.length - m[2].length - 1) || ' ');
    }) || null, null);
  };
  const since = isoAgo(30 * DAY);
  const hops = top.map((h) => {
    const dev = lower(h.deviceName);
    const port = lower(h.port);
    const distinctDays = daysStmt ? safe(() => daysStmt.get(since, dev, port).n, null) : null;
    const device = devStmt && dev ? safe(() => devStmt.get(dev, dev), null) : null;
    const iface = ifStmt && dev && port ? (safe(() => ifStmt.get(dev, dev, port, port), null) || looseIface(dev, port)) : null;
    const issues = open.filter((r) => {
      const t = lower(r.target);
      const tail = (/(\d+(?:\/\d+)+)$/.exec(port) || [])[1];
      return dev && (t === dev || t.startsWith(`${dev} `)) && (!port || t.includes(port) || (tail && t.endsWith(tail)));
    }).slice(0, 5).map(issueOut);
    return {
      device: h.deviceName, port: h.port, siteKey: h.siteKey, timesBlamed: h.count, distinctDaysBlamed: distinctDays,
      pattern: distinctDays == null ? null : distinctDays >= CHRONIC_DAYS ? 'chronic' : distinctDays <= 1 ? 'single-day burst' : 'recurring',
      firstAt: h.firstAt, lastAt: h.lastAt,
      subjects: h.subjects.slice(0, 5), appsAffected: h.appsAffected,
      currentDeviceStatus: device ? device.host_status : null,
      currentInterface: iface ? {
        port: iface.display_name, description: iface.description, status: iface.status_text, speedBps: iface.speed_bps,
        inUtilPct: iface.in_util_pct, outUtilPct: iface.out_util_pct, inErrors: iface.in_errors, outErrors: iface.out_errors,
        inDiscards: iface.in_discards, outDiscards: iface.out_discards,
      } : null,
      openIssues: issues,
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    windowDays: 30,
    chronicThresholdDays: CHRONIC_DAYS,
    hopsBlamedTotal: bh.hops.length,
    blamesTotal: bh.hops.reduce((a, h) => a + h.count, 0),
    topHops: hops,
    recentBlames: bh.recent.slice(0, 20),
    note: noteIfEmpty(),
  };
}

// ---- change_impact (round 6) -----------------------------------------------------

function gatherChangeImpact() {
  const rows = require('../logicmonitorCorrelation').changesThenIncidents(db, { days: 14 });
  const byChange = new Map();
  for (const r of rows) {
    let c = byChange.get(r.changeId);
    if (!c) {
      c = { changeId: r.changeId, changedAt: r.changedAt, device: r.device, system: r.system, scope: r.scope, item: r.item, changeType: r.changeType, oldValue: r.oldValue, newValue: r.newValue, siteKey: r.siteKey, incidents: [] };
      byChange.set(r.changeId, c);
    }
    c.incidents.push(r.incident);
  }
  const paired = [...byChange.values()].map((c) => ({
    ...c, incidentCount: c.incidents.length,
    firstIncidentMinutesAfter: Math.min(...c.incidents.map((i) => i.minutesAfter)),
    incidents: c.incidents.slice(0, 5),
  }));
  const changes = safe(() => require('../configLedger').listChanges({ days: 14, platform: 'logicmonitor', limit: 1000 }), []);
  const byScopeDay = new Map();
  const byScope = new Map();
  for (const c of changes) {
    const day = sqlIso(c.detected_at) ? sqlIso(c.detected_at).slice(0, 10) : 'unknown';
    byScopeDay.set(`${c.scope}|${day}`, (byScopeDay.get(`${c.scope}|${day}`) || 0) + 1);
    const s = byScope.get(c.scope) || { scope: c.scope, changes: 0, followedByIncident: 0, minutes: [] };
    s.changes += 1;
    const p = byChange.get(c.id);
    if (p) { s.followedByIncident += 1; s.minutes.push(Math.min(...p.incidents.map((i) => i.minutesAfter))); }
    byScope.set(c.scope, s);
  }
  return {
    generatedAt: new Date().toISOString(),
    windowDays: 14,
    changesTotal: changes.length,
    changesFollowedByIncident: paired.length,
    pairingRule: 'A change is paired with an incident when the incident opened within 24 hours after it and names the changed device or a hop blamed for it. A pairing is a lead, not proof.',
    pairedChanges: paired.slice(0, LIST_CAP),
    byScope: [...byScope.values()].map((s) => ({ scope: s.scope, changes: s.changes, followedByIncident: s.followedByIncident, medianMinutesToFirstIncident: median(s.minutes) }))
      .sort((a, b) => b.followedByIncident - a.followedByIncident || b.changes - a.changes).slice(0, LIST_CAP),
    changesPerScopePerDay: [...byScopeDay.entries()].map(([k, n]) => { const [scope, day] = k.split('|'); return { scope, day, changes: n }; })
      .sort((a, b) => b.day.localeCompare(a.day) || a.scope.localeCompare(b.scope)).slice(0, 100),
    newestChangesWithNoIncident: changes.filter((c) => !byChange.has(c.id)).slice(0, 20).map((c) => ({
      id: c.id, scope: c.scope, system: c.system, item: c.item, changeType: c.change_type, oldValue: c.old_value, newValue: c.new_value, detectedAt: sqlIso(c.detected_at),
    })),
    note: noteIfEmpty(),
  };
}

// ---- monitoring_coverage (round 6) -----------------------------------------------

function gatherMonitoringCoverage() {
  const q = routesModule().buildDataQuality();
  const cnt = (sql, ...args) => safe(() => db.prepare(sql).get(...args).n, 0);
  const noDescByDevice = new Map();
  for (const p of q.portsNoDescription) noDescByDevice.set(p.deviceName, (noDescByDevice.get(p.deviceName) || 0) + 1);
  const capped = (list) => ({ total: list.length, items: list.slice(0, LIST_CAP) });
  const webhookSince = isoAgo(7 * DAY);
  const webhookEvents = new Map(safe(() => db.prepare(`
    SELECT source_id, SUM(CASE WHEN accepted = 1 THEN 1 ELSE 0 END) accepted, SUM(CASE WHEN accepted = 1 THEN 0 ELSE 1 END) rejected
    FROM lm_webhook_events WHERE datetime(received_at) >= datetime(?) GROUP BY source_id
  `).all(webhookSince).map((r) => [r.source_id, r]), []));
  const webhooks = safe(() => db.prepare('SELECT id, name, webhook_enabled, webhook_last_at, webhook_count, webhook_last_error FROM lm_sources ORDER BY name').all().map((s) => {
    const ev = webhookEvents.get(s.id) || { accepted: 0, rejected: 0 };
    return {
      portal: s.name, enabled: Number(s.webhook_enabled) === 1, lastEventAt: sqlIso(s.webhook_last_at), totalAccepted: s.webhook_count || 0,
      lastError: s.webhook_last_error || null, accepted7d: ev.accepted || 0, rejected7d: ev.rejected || 0,
    };
  }), []);
  const populations = {
    networkDevices: cnt('SELECT COUNT(*) n FROM lm_devices WHERE stale = 0 AND is_network = 1'),
    switches: cnt("SELECT COUNT(*) n FROM lm_devices WHERE stale = 0 AND is_network = 1 AND role = 'switch'"),
    upPortsOnNetworkDevices: cnt("SELECT COUNT(*) n FROM lm_interfaces i JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id WHERE i.stale = 0 AND d.stale = 0 AND d.is_network = 1 AND i.status_text = 'up' AND COALESCE(i.stop_monitoring, 0) = 0"),
    checkLocations: cnt('SELECT COUNT(*) n FROM lm_check_locations l JOIN lm_checks c ON c.source_id = l.source_id AND c.check_id = l.check_id WHERE l.stale = 0 AND c.stale = 0 AND COALESCE(l.is_overall, 0) = 0'),
    topologyLinks: cnt('SELECT COUNT(*) n FROM lm_topology_links WHERE COALESCE(stale, 0) = 0'),
  };
  return {
    generatedAt: new Date().toISOString(),
    coverageScore: q.coverageScore,
    populations,
    gaps: {
      portsUpWithNoDescription: { ...capped(q.portsNoDescription), ofUpPorts: populations.upPortsOnNetworkDevices,
        worstDevices: [...noDescByDevice.entries()].map(([device, ports]) => ({ device, ports })).sort((a, b) => b.ports - a.ports).slice(0, 10) },
      switchesWithNoNeighborDatasource: { ...capped(q.switchesNoNeighbors), ofSwitches: populations.switches },
      networkDevicesWithNoSite: { ...capped(q.devicesNoSite), ofNetworkDevices: populations.networkDevices },
      checkLocationsWithNoBaseline: { ...capped(q.checksNoBaseline), ofLocations: populations.checkLocations },
      unresolvedLinkDescriptions: { total: q.unresolvedLinks, ofLinks: populations.topologyLinks },
    },
    counts: {
      devicesWithNoSite: cnt('SELECT COUNT(*) n FROM lm_devices WHERE stale = 0 AND site_key IS NULL'),
      interfacesWithNoDescription: cnt("SELECT COUNT(*) n FROM lm_interfaces WHERE stale = 0 AND (description IS NULL OR trim(description) = '')"),
      checkLocationsWithNoBaseline: q.checksNoBaseline.length,
      devicesPolledByDownCollector: cnt('SELECT COUNT(*) n FROM lm_devices d JOIN lm_collectors c ON c.source_id = d.source_id AND c.collector_id = d.collector_id WHERE d.stale = 0 AND c.stale = 0 AND c.is_down = 1'),
      devicesDeadCollector: cnt("SELECT COUNT(*) n FROM lm_devices WHERE stale = 0 AND host_status = 'dead-collector'"),
      openAlertsShadowed: cnt('SELECT COUNT(*) n FROM lm_alerts WHERE cleared = 0 AND shadowed_by IS NOT NULL'),
    },
    webhooksByPortal: webhooks,
    note: noteIfEmpty(),
  };
}

// ---- suppression_review (round 6) ------------------------------------------------

function gatherSuppressionReview() {
  const now = Date.now();
  const hoursSince = (sec) => (sec ? Math.round((now / 1000 - Number(sec)) / 3600) : null);
  const shadowedTotal = safe(() => db.prepare('SELECT COUNT(*) n FROM lm_alerts WHERE cleared = 0 AND shadowed_by IS NOT NULL').get().n, 0);
  const shadowedByUpstream = safe(() => db.prepare(`
    SELECT json_extract(shadowed_by, '$.deviceName') upstream, json_extract(shadowed_by, '$.port') port,
      json_extract(shadowed_by, '$.reason') reason, COUNT(*) alerts, COUNT(DISTINCT lm_device_id) downstream_devices,
      SUM(CASE WHEN severity_norm = 'critical' THEN 1 ELSE 0 END) critical_alerts
    FROM lm_alerts WHERE cleared = 0 AND shadowed_by IS NOT NULL AND json_valid(shadowed_by)
    GROUP BY upstream, port, reason ORDER BY alerts DESC LIMIT ${LIST_CAP}
  `).all(), []);
  const shadowedExamples = safe(() => db.prepare(`
    SELECT monitor_object_name device, resource_template_name datasource, data_point_name datapoint, severity_norm, start_epoch,
      json_extract(shadowed_by, '$.deviceName') upstream
    FROM lm_alerts WHERE cleared = 0 AND shadowed_by IS NOT NULL AND json_valid(shadowed_by) ORDER BY start_epoch DESC LIMIT 20
  `).all().map((a) => ({ device: a.device, datasource: a.datasource, datapoint: a.datapoint, severity: a.severity_norm, openHours: hoursSince(a.start_epoch), shadowedBy: a.upstream })), []);
  const alertsInSdt = safe(() => db.prepare("SELECT COUNT(*) n FROM lm_alerts WHERE cleared = 0 AND sdted = 1").get().n, 0);
  const alertsInSdtExamples = safe(() => db.prepare(`
    SELECT monitor_object_name device, resource_template_name datasource, severity_norm, start_epoch, suppressor
    FROM lm_alerts WHERE cleared = 0 AND sdted = 1 ORDER BY CASE severity_norm WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, start_epoch ASC LIMIT 20
  `).all().map((a) => ({ device: a.device, datasource: a.datasource, severity: a.severity_norm, openHours: hoursSince(a.start_epoch), suppressor: a.suppressor || null })), []);
  const sdtByDevice = new Map();
  for (const s of safe(() => db.prepare('SELECT * FROM lm_sdts WHERE stale = 0 AND is_effective = 1 AND lm_device_id IS NOT NULL ORDER BY start_ms').all(), [])) {
    sdtByDevice.set(`${s.source_id}:${s.lm_device_id}`, s);
  }
  const sdtAlerts = new Map(safe(() => db.prepare('SELECT source_id, lm_device_id, COUNT(*) n FROM lm_alerts WHERE cleared = 0 AND sdted = 1 GROUP BY source_id, lm_device_id').all()
    .map((r) => [`${r.source_id}:${r.lm_device_id}`, r.n]), []));
  const sdtDevicesAll = safe(() => db.prepare("SELECT source_id, lm_device_id, display_name, role, is_network, sdt_status FROM lm_devices WHERE stale = 0 AND sdt_status IS NOT NULL AND sdt_status != ''").all()
    .filter((d) => hasSdtSlot(d.sdt_status)), []);
  const sdtDevices = sdtDevicesAll.slice(0, LIST_CAP).map((d) => {
    const s = sdtByDevice.get(`${d.source_id}:${d.lm_device_id}`);
    return {
      device: d.display_name, role: d.role, network: Number(d.is_network) === 1, sdtSlots: d.sdt_status, openAlertsInSdt: sdtAlerts.get(`${d.source_id}:${d.lm_device_id}`) || 0,
      sdt: s ? {
        type: s.sdt_type, schedule: s.schedule_type, startedHoursAgo: s.start_ms ? Math.round((now - Number(s.start_ms)) / 3600000) : null,
        endsInHours: s.end_ms && Number(s.end_ms) > 0 ? Math.round((Number(s.end_ms) - now) / 3600000) : null, admin: s.admin, comment: s.comment,
      } : null,
    };
  });
  const cutoff7 = now - 7 * DAY;
  const longSdts = safe(() => db.prepare(`
    SELECT sdt_type, schedule_type, is_effective, start_ms, end_ms, admin, comment, device_display_name, group_full_path
    FROM lm_sdts WHERE stale = 0 AND ((is_effective = 1 AND start_ms < ?) OR end_ms IS NULL OR end_ms = 0)
    ORDER BY start_ms ASC LIMIT ${LIST_CAP}
  `).all(cutoff7).map((s) => ({
    type: s.sdt_type, schedule: s.schedule_type, effectiveNow: Number(s.is_effective) === 1, device: s.device_display_name || null, group: s.group_full_path || null,
    ageDays: s.start_ms ? Math.round((now - Number(s.start_ms)) / DAY) : null,
    endsInDays: s.end_ms && Number(s.end_ms) > 0 ? Math.round((Number(s.end_ms) - now) / DAY) : null, noEnd: !(s.end_ms && Number(s.end_ms) > 0),
    admin: s.admin, comment: s.comment,
  })), []);
  const openSdtIssues = openIssueRows().filter((r) => r.type === 'device-in-sdt');
  return {
    generatedAt: new Date().toISOString(),
    shadowedAlerts: { total: shadowedTotal, byUpstream: shadowedByUpstream, examples: shadowedExamples },
    devicesInSdt: { total: sdtDevicesAll.length, items: sdtDevices },
    openAlertsInSdt: { total: alertsInSdt, examples: alertsInSdtExamples },
    sdtsOlderThanSevenDaysOrWithNoEnd: longSdts,
    deviceInSdtIssues: { openTotal: openSdtIssues.length, items: openSdtIssues.slice(0, LIST_CAP).map(issueOut) },
    note: noteIfEmpty(),
  };
}

// ---- app_network_exposure (round 6) ----------------------------------------------

const APP_CAP = 25;
const APP_SERVER_CAP = 8;

function gatherAppNetworkExposure() {
  const base = { generatedAt: new Date().toISOString(), appsWatched: 0, apps: [], note: noteIfEmpty() };
  if (!hasTable('app_service_watch')) return base;
  const watched = safe(() => db.prepare('SELECT usage_id FROM app_service_watch ORDER BY usage_id').all().map((r) => r.usage_id), []);
  base.appsWatched = watched.length;
  if (!watched.length) return base;
  const appSvc = require('../appServiceStatus');
  const lp = require('../logicmonitorPath');
  const eps = require('../logicmonitorEndpoints');
  const ctx = safe(() => lp.makeContext(db), null);
  for (const usageId of watched.slice(0, APP_CAP)) {
    const ev = safe(() => appSvc.evaluate(usageId), null);
    if (!ev) continue;
    const perServer = [];
    const portServers = new Map();
    const switchServers = new Map();
    const blames = new Map();
    for (const s of (ev.servers || []).slice(0, APP_SERVER_CAP)) {
      const ref = { names: [s.name, s.guestHostname].filter(Boolean), ips: [s.ipAddress].filter(Boolean) };
      const sp = safe(() => eps.serverPath(db, ref), { switchPorts: [], checks: [] });
      const ports = (sp.switchPorts || []).map((p) => ({ device: p.deviceName, port: p.port, status: p.statusText || 'unknown', inUtilPct: p.inUtilPct, outUtilPct: p.outUtilPct }));
      perServer.push({ server: s.name, online: s.online, switchPorts: ports.slice(0, 6), reachabilityChecks: (sp.checks || []).length });
      for (const p of ports) {
        const pk = `${p.device}|${p.port}`;
        if (!portServers.has(pk)) portServers.set(pk, new Set());
        portServers.get(pk).add(s.name);
        if (!switchServers.has(p.device)) switchServers.set(p.device, new Set());
        switchServers.get(p.device).add(s.name);
      }
      if (ctx) {
        const b = safe(() => lp.blame(lp.pathFor(db, ref, { ctx })), null);
        if (b && b.state && b.state !== 'ok') blames.set(`${b.deviceName}|${b.port || ''}`, { server: s.name, device: b.deviceName, port: b.port || null, state: b.state, reason: b.reason || null });
      }
    }
    const withPorts = perServer.filter((s) => s.switchPorts.length).length;
    base.apps.push({
      usageId: ev.usageId, label: ev.label || ev.catalogName || ev.displayId, state: ev.state, serversChecked: perServer.length, serversTotal: (ev.servers || []).length,
      serversWithKnownSwitchPort: withPorts,
      networkPortsDown: ev.counts ? ev.counts.networkPortsDown : null, networkDegraded: ev.counts ? ev.counts.networkDegraded : null,
      distinctSwitches: switchServers.size, distinctSwitchPorts: portServers.size,
      singleSwitch: withPorts > 1 && switchServers.size === 1,
      switchesCarryingAllKnownServers: [...switchServers.entries()].filter(([, set]) => withPorts > 0 && set.size === withPorts).map(([d]) => d).slice(0, 5),
      portsByServerCount: [...portServers.entries()].map(([k, set]) => { const [device, port] = k.split('|'); return { device, port, servers: set.size }; })
        .sort((a, b) => b.servers - a.servers).slice(0, 8),
      networkComponent: (ev.network || []).slice(0, LIST_CAP),
      pathBlame: [...blames.values()].slice(0, 5),
      servers: perServer,
    });
  }
  return base;
}

// ---- interface_errors (round 6) --------------------------------------------------

const ERR_ISSUE_TYPES = ['interface-errors-growing', 'interface-error-anomaly', 'interface-flapping'];

function gatherInterfaceErrors() {
  const recentFrom = dayStr(2 * DAY);
  const sevenFrom = dayStr(6 * DAY);
  const hour = new Date().getUTCHours();
  const rows = safe(() => db.prepare(`
    SELECT d.display_name device, i.display_name iface, i.description, i.status_text, i.speed_bps,
      i.in_errors cur_in_err, i.out_errors cur_out_err, i.in_discards cur_in_disc, i.out_discards cur_out_disc,
      SUM(CASE WHEN x.day >= ? THEN COALESCE(x.errors_sum, 0) ELSE 0 END) recent_err,
      SUM(CASE WHEN x.day < ? THEN COALESCE(x.errors_sum, 0) ELSE 0 END) prior_err,
      SUM(CASE WHEN x.day >= ? THEN COALESCE(x.discards_sum, 0) ELSE 0 END) recent_disc,
      SUM(CASE WHEN x.day < ? THEN COALESCE(x.discards_sum, 0) ELSE 0 END) prior_disc,
      SUM(COALESCE(x.flaps, 0)) flaps7d, b.err_median, b.err_mad
    FROM lm_interface_daily x
    JOIN lm_interfaces i ON i.source_id = x.source_id AND i.instance_id = x.instance_id
    JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
    LEFT JOIN lm_interface_baseline b ON b.source_id = x.source_id AND b.instance_id = x.instance_id AND b.hour_of_day = ?
    WHERE x.day >= ? AND i.stale = 0 AND d.stale = 0
    GROUP BY x.source_id, x.instance_id
    HAVING recent_err + prior_err + recent_disc + prior_disc > 0
    ORDER BY recent_err + recent_disc DESC LIMIT 500
  `).all(recentFrom, recentFrom, recentFrom, recentFrom, hour, sevenFrom), []);
  const shaped = rows.map((r) => {
    const recentPerDay = (r.recent_err + r.recent_disc) / 3;
    const priorPerDay = (r.prior_err + r.prior_disc) / 4;
    return {
      device: r.device, port: r.iface, description: r.description, status: r.status_text, speedBps: r.speed_bps,
      errorsPerDayLast3d: Math.round((r.recent_err / 3) * 10) / 10, errorsPerDayPrior4d: Math.round((r.prior_err / 4) * 10) / 10,
      discardsPerDayLast3d: Math.round((r.recent_disc / 3) * 10) / 10, discardsPerDayPrior4d: Math.round((r.prior_disc / 4) * 10) / 10,
      flaps7d: r.flaps7d, currentSample: { inErrors: r.cur_in_err, outErrors: r.cur_out_err, inDiscards: r.cur_in_disc, outDiscards: r.cur_out_disc },
      baselineThisHour: r.err_median == null ? null : { errMedian: r.err_median, errMad: r.err_mad },
      growing: recentPerDay >= 1 && recentPerDay > priorPerDay * 1.5, recentPerDay,
    };
  });
  const growing = shaped.filter((r) => r.growing).sort((a, b) => b.recentPerDay - a.recentPerDay);
  const worst = growing.slice(0, 20).map(({ growing: g, recentPerDay, ...rest }) => rest);
  const byDevice = new Map();
  for (const p of worst) {
    if (!byDevice.has(p.device)) byDevice.set(p.device, []);
    byDevice.get(p.device).push(p);
  }
  const open = openIssueRows().filter((r) => ERR_ISSUE_TYPES.includes(r.type)).slice(0, LIST_CAP);
  const targets = open.map((r) => lower(r.target));
  const baselines = new Map();
  if (targets.length) {
    safe(() => {
      const ph = targets.map(() => '?').join(',');
      for (const b of db.prepare(`
        SELECT lower(COALESCE(d.display_name, d.name) || ' ' || COALESCE(i.display_name, i.instance_name)) target, b.err_median, b.err_mad, b.samples
        FROM lm_interfaces i JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
        LEFT JOIN lm_interface_baseline b ON b.source_id = i.source_id AND b.instance_id = i.instance_id AND b.hour_of_day = ?
        WHERE lower(COALESCE(d.display_name, d.name) || ' ' || COALESCE(i.display_name, i.instance_name)) IN (${ph})
      `).all(hour, ...targets)) baselines.set(b.target, b);
    }, null);
  }
  return {
    generatedAt: new Date().toISOString(),
    method: 'Daily rollups: average errors plus discards per day over the last 3 days against the 4 days before; growing means at least 1 per day and over 1.5 times the earlier rate. The daily rollup has no in/out split; the latest in/out sample is shown per port.',
    baselineHourUtc: hour,
    interfacesWithErrors7d: shaped.length,
    interfacesGrowing: growing.length,
    worstGrowingByDevice: [...byDevice.entries()].map(([device, ports]) => ({ device, ports })),
    openIssues: open.map((r) => {
      const b = baselines.get(lower(r.target));
      return { ...issueOut(r), baselineThisHour: b && b.err_median != null ? { errMedian: b.err_median, errMad: b.err_mad, samples: b.samples } : null };
    }),
    issuesOpened7d: issueHistorySlice(ERR_ISSUE_TYPES, 7 * DAY),
    note: noteIfEmpty(),
  };
}

// ---- alert_delivery (round 6) ----------------------------------------------------

const MATCH_EVENT = `((e.lm_alert_id IS NOT NULL AND (e.lm_alert_id = a.lm_alert_id OR e.lm_alert_id = a.internal_id))
  OR (e.internal_id IS NOT NULL AND (e.internal_id = a.internal_id OR e.internal_id = a.lm_alert_id)))`;

function gatherAlertDelivery() {
  const since24 = isoAgo(DAY);
  const sec24 = nowSec() - 86400;
  const sec7 = nowSec() - 7 * 86400;
  const sources = safe(() => db.prepare(`
    SELECT id, name, enabled, polling_interval_minutes, last_poll_at, last_poll_status, last_poll_error, rate_limit_json,
      webhook_enabled, webhook_last_at, webhook_count, webhook_last_error FROM lm_sources ORDER BY name
  `).all(), []);
  const portals = sources.map((s) => {
    const stamps = safe(() => db.prepare(`SELECT captured_at FROM lm_metrics_history WHERE source_id = ? AND datetime(captured_at) >= datetime(?) ORDER BY datetime(captured_at) LIMIT 2000`)
      .all(s.id, since24).map((r) => sqlMs(r.captured_at)).filter((v) => v != null), []);
    const gaps = [];
    for (let i = 1; i < stamps.length; i += 1) gaps.push((stamps[i] - stamps[i - 1]) / 60000);
    const outcome = safe(() => db.prepare(`
      SELECT COALESCE(status, 'unknown') status, accepted, COUNT(*) n FROM lm_webhook_events
      WHERE source_id = ? AND datetime(received_at) >= datetime(?) GROUP BY COALESCE(status, 'unknown'), accepted
    `).all(s.id, since24), []);
    const rejectReasons = safe(() => db.prepare(`
      SELECT COALESCE(error, 'none recorded') error, COUNT(*) n FROM lm_webhook_events
      WHERE source_id = ? AND accepted = 0 AND datetime(received_at) >= datetime(?) GROUP BY COALESCE(error, 'none recorded') ORDER BY n DESC LIMIT 5
    `).all(s.id, since24), []);
    const lagRows = safe(() => db.prepare(`
      SELECT a.id, a.start_epoch, MIN(CAST(strftime('%s', e.received_at) AS INTEGER)) first_rx
      FROM lm_alerts a JOIN lm_webhook_events e ON e.source_id = a.source_id AND e.accepted = 1 AND ${MATCH_EVENT}
      WHERE a.source_id = ? AND a.start_epoch >= ? GROUP BY a.id
    `).all(s.id, sec7), []);
    const lags = lagRows.filter((r) => r.first_rx != null && r.start_epoch != null).map((r) => r.first_rx - Number(r.start_epoch));
    const usable = lags.filter((l) => l >= 0);
    const alerts24 = safe(() => db.prepare('SELECT COUNT(*) n FROM lm_alerts WHERE source_id = ? AND start_epoch >= ?').get(s.id, sec24).n, 0);
    const pollOnly24 = safe(() => db.prepare(`
      SELECT COUNT(*) n FROM lm_alerts a WHERE a.source_id = ? AND a.start_epoch >= ?
        AND NOT EXISTS (SELECT 1 FROM lm_webhook_events e WHERE e.source_id = a.source_id AND e.accepted = 1 AND ${MATCH_EVENT})
    `).get(s.id, sec24).n, 0);
    const sum = (accepted) => outcome.filter((o) => Number(o.accepted) === accepted).reduce((a, o) => a + o.n, 0);
    let rate = null;
    try { rate = s.rate_limit_json ? JSON.parse(s.rate_limit_json) : null; } catch { rate = null; }
    return {
      portal: s.name, enabled: Number(s.enabled) === 1,
      polling: {
        configuredIntervalMinutes: s.polling_interval_minutes, lastPollAt: sqlIso(s.last_poll_at), lastPollStatus: s.last_poll_status, lastPollError: s.last_poll_error || null,
        samples24h: stamps.length, averageGapMinutes24h: gaps.length ? Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * 10) / 10 : null,
        longestGapMinutes24h: gaps.length ? Math.round(Math.max(...gaps) * 10) / 10 : null,
      },
      webhook: {
        enabled: Number(s.webhook_enabled) === 1, lastEventAt: sqlIso(s.webhook_last_at), lastError: s.webhook_last_error || null,
        events24h: { accepted: sum(1), rejected: sum(0) },
        byAlertStatus24h: outcome.reduce((m, o) => { m[o.status] = (m[o.status] || 0) + o.n; return m; }, {}),
        topRejectReasons24h: rejectReasons,
      },
      lagSecondsAlertStartToWebhook7d: {
        alertsSeenBothWays: usable.length, negativeLagExcluded: lags.length - usable.length, median: median(usable), p95: percentile(usable, 0.95), max: usable.length ? Math.max(...usable) : null,
      },
      alertsStarted24h: alerts24, alertsSeenOnlyByPolling24h: pollOnly24,
      rateLimit: rate,
    };
  });
  return { generatedAt: new Date().toISOString(), portals, note: noteIfEmpty() };
}

// ---- site_brief (round 6, scoped) ------------------------------------------------

function gatherSiteBrief(params) {
  const siteKey = String((params && params.scope) || '').trim();
  if (!siteKey || !/^[a-z0-9-]{1,80}$/.test(siteKey)) return null;
  const r = routesModule();
  const rows = r.buildSites({ siteKey });
  if (!rows.length) return null;
  const row = rows[0];
  const lk = r.lookups();
  const endpoints = safe(() => require('../logicmonitorEndpoints').endpointsAll(db), []);
  const devices = safe(() => r.reviewRows('AND d.site_key = ? AND d.source_id = ?', [row.siteKey, row.sourceId], endpoints, lk, r.newestByModel()), []);
  const devRank = (d) => (d.hostStatus === 'dead' ? 0 : d.hostStatus === 'dead-collector' ? 1 : 2);
  const devSorted = [...devices].sort((a, b) => devRank(a) - devRank(b) || String(a.displayName).localeCompare(String(b.displayName)));
  const downRows = safe(() => db.prepare(`
    SELECT i.*, d.display_name AS device_name FROM lm_interfaces i
    JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
    WHERE d.stale = 0 AND d.site_key = ? AND d.source_id = ? AND i.stale = 0 AND i.status_text = 'down' AND COALESCE(i.stop_monitoring, 0) = 0
    ORDER BY d.display_name, i.if_index LIMIT 500
  `).all(row.siteKey, row.sourceId).map(r.interfaceOut), []);
  const names = new Set();
  for (const d of devices) { if (d.displayName) names.add(lower(d.displayName)); if (d.name) names.add(lower(d.name)); }
  for (const c of row.collectors) if (c.hostname) names.add(lower(c.hostname));
  for (const c of safe(() => db.prepare('SELECT name FROM lm_checks WHERE source_id = ? AND site_key = ? AND stale = 0').all(row.sourceId, row.siteKey), [])) names.add(lower(c.name));
  const openIssues = safe(() => db.prepare("SELECT * FROM lm_issue_history WHERE status = 'open' AND source = ? ORDER BY first_seen").all(row.source), [])
    .filter((i) => { const t = lower(i.target); if (names.has(t)) return true; for (const n of names) if (n && t.startsWith(`${n} `)) return true; return false; });
  const recentChanges = safe(() => require('../configLedger').listChanges({ days: 7, platform: 'logicmonitor', limit: 1000 })
    .filter((c) => names.has(lower(c.item))).slice(0, LIST_CAP).map((c) => ({
      scope: c.scope, item: c.item, changeType: c.change_type, oldValue: c.old_value, newValue: c.new_value, detectedAt: sqlIso(c.detected_at),
    })), []);
  const corr = require('../logicmonitorCorrelation');
  const correlation = safe(() => corr.siteCounts(db, row.siteKey, row.sourceId), { backupLoad: 0, replication: 0, changes: 0, blames: 0 });
  const blameHops = safe(() => corr.blameHistory(db, { days: 30 }).hops.filter((h) => h.siteKey === row.siteKey).slice(0, 10).map((h) => ({
    device: h.deviceName, port: h.port, timesBlamed: h.count, lastAt: h.lastAt, subjects: h.subjects.slice(0, 3), appsAffected: h.appsAffected,
  })), []);
  const reachSeries = safe(() => {
    const node = require('../logicmonitorOverview').buildOverview(db).map.nodes.find((n) => n.siteKey === row.siteKey && n.sourceId === row.sourceId);
    return node && node.reachability ? { direction: node.reachability.direction || null, label: node.reachability.label || null, lastTwentyFourHours: (node.reachability.series || []).slice(-24) } : null;
  }, null);
  const cnt = (sql, ...a) => safe(() => db.prepare(sql).get(...a).n, 0);
  const unmonitored = {
    devicesWithNoInterfaceDatasource: safe(() => db.prepare(`
      SELECT d.display_name device FROM lm_devices d WHERE d.stale = 0 AND d.is_network = 1 AND d.site_key = ? AND d.source_id = ?
        AND NOT EXISTS (SELECT 1 FROM lm_device_datasources x WHERE x.source_id = d.source_id AND x.lm_device_id = d.lm_device_id AND x.is_interface = 1)
      ORDER BY d.display_name LIMIT ${LIST_CAP}
    `).all(row.siteKey, row.sourceId).map((d) => d.device), []),
    upPortsWithNoDescription: cnt(`
      SELECT COUNT(*) n FROM lm_interfaces i JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
      WHERE i.stale = 0 AND d.stale = 0 AND d.is_network = 1 AND d.site_key = ? AND d.source_id = ? AND i.status_text = 'up'
        AND COALESCE(i.stop_monitoring, 0) = 0 AND (i.description IS NULL OR trim(i.description) = '')`, row.siteKey, row.sourceId),
    checkLocationsWithNoBaseline: cnt(`
      SELECT COUNT(*) n FROM lm_check_locations l JOIN lm_checks c ON c.source_id = l.source_id AND c.check_id = l.check_id
      WHERE l.stale = 0 AND c.stale = 0 AND COALESCE(l.is_overall, 0) = 0 AND c.site_key = ? AND c.source_id = ?
        AND NOT EXISTS (SELECT 1 FROM lm_check_baseline b WHERE b.source_id = l.source_id AND b.check_id = l.check_id AND b.checkpoint_id = l.checkpoint_id)`, row.siteKey, row.sourceId),
    devicesInSdt: devices.filter((d) => safe(() => hasSdtSlot(db.prepare('SELECT sdt_status FROM lm_devices WHERE source_id = ? AND lm_device_id = ?').get(d.sourceId, d.id).sdt_status), false)).length,
  };
  return {
    generatedAt: new Date().toISOString(),
    site: {
      siteKey: row.siteKey, siteName: row.siteName, portal: row.source, state: row.state, deviceCount: row.deviceCount, networkCount: row.networkCount,
      devicesDead: row.devicesDead, interfacesDownCount: row.interfacesDown, servers: row.servers,
    },
    circuits: row.circuits, collectors: row.collectors,
    reachabilityIn: row.reachabilityIn.slice(0, LIST_CAP), reachabilityOut: row.reachabilityOut.slice(0, LIST_CAP),
    reachabilityRttSeriesInbound: reachSeries,
    devicesTotal: devices.length,
    devices: devSorted.slice(0, LIST_CAP).map((d) => ({
      device: d.displayName, vendor: d.vendor, model: d.model, version: d.version, role: d.role, hostStatus: d.hostStatus, collector: d.collectorName,
      interfaces: d.ifCount, interfacesUp: d.ifUp, uplinks: d.uplinks, endpoints: d.endpoints, behindNewestCode: d.behind,
    })),
    interfacesDownTotal: downRows.length,
    interfacesDown: downRows.slice(0, LIST_CAP).map((i) => ({ device: i.deviceName, port: i.displayName, description: i.description, speedBps: i.speedBps })),
    openIssuesTotal: openIssues.length,
    openIssues: openIssues.slice(0, LIST_CAP).map(issueOut),
    changesLast7d: recentChanges,
    correlationCounts: correlation,
    blamedHopsAtSite30d: blameHops,
    unmonitored,
    note: noteIfEmpty(),
  };
}

const RULES = 'Names in the data are anonymized tokens; keep them exactly as given, never guess the real name. '
  + 'Do not invent data. Respond in markdown with these headings: **Summary**, **Findings (severity-ordered)**, '
  + '**Recommended actions**, **Data gaps**.';

const REPORTS = {
  network_health: {
    system:
      'You are reviewing the health of a network estate monitored by LogicMonitor for an enterprise infrastructure '
      + 'team. You are given device status counts by vendor and by device group, dead and dead-collector devices '
      + '(dead-collector means the monitoring collector is down, not the device), interfaces that are down with '
      + 'their descriptions, open LogicMonitor alerts by severity and datasource, and collectors that are down. '
      + 'Lead with outages on network devices, then collector problems that blind monitoring. '
      + `${RULES} Keep it under ~400 words.`,
    gather: gatherNetworkHealth,
    noun: 'network health report',
  },
  interface_capacity: {
    system:
      'You are planning interface capacity for a network estate monitored by LogicMonitor. You are given the 25 '
      + 'interfaces with the highest peak utilisation over 7 and 30 days (daily rollups), interfaces repeatedly over '
      + 'the warning threshold, the count of interfaces by speed class, and devices with ports unused for 30 days. '
      + 'Separate sustained congestion from short peaks, and call out unused ports as reclaim candidates. '
      + `${RULES} Keep it under ~400 words.`,
    gather: gatherInterfaceCapacity,
    noun: 'interface capacity report',
  },
  alert_noise: {
    system:
      'You are reducing alert noise in a LogicMonitor portal for an enterprise operations team. You are given alerts '
      + 'opened per day over 30 days by severity, the 15 conditions (device, datasource, instance, datapoint) that '
      + 're-fired most, alerts acknowledged but still open with their age, open alerts inside SDT, and open alerts '
      + 'with no escalation rule. Suggest specific threshold, SDT or routing changes per noisy condition. '
      + `${RULES} Keep it under ~400 words.`,
    gather: gatherAlertNoise,
    noun: 'alert noise report',
  },
  collector_health: {
    system:
      'You are assessing LogicMonitor collector health for an enterprise infrastructure team. You are given each '
      + 'collector with its build against the current mandatory build, down and SDT state, device and instance '
      + 'load, uptime and whether a backup collector is set, the devices-per-collector distribution, days with '
      + 'dead-collector devices in the last 30 days, and collector issues. A down collector blinds every device it '
      + `polls. ${RULES} Keep it under ~350 words.`,
    gather: gatherCollectorHealth,
    noun: 'collector health report',
  },
  device_lifecycle: {
    system:
      'You are reviewing software lifecycle across a network estate monitored by LogicMonitor. You are given code '
      + 'versions per vendor and model with counts, the newest version seen in the estate for each model, how many '
      + 'devices run something older, models with a single device (spares risk), network devices with no parsed '
      + 'version, and devices first seen in the last 30 days. "Behind" is relative to the newest version seen in '
      + 'this estate; no vendor end-of-support dates are given, so do not assert any. '
      + `${RULES} Keep it under ~400 words.`,
    gather: gatherDeviceLifecycle,
    noun: 'device lifecycle report',
  },
  site_reachability: {
    system:
      'You are reviewing site-to-site reachability measured by LogicMonitor ping and web checks for an enterprise '
      + 'network team. You are given the worst links over 7 days (RTT, approximate p95, loss, down samples), '
      + 'latency, loss and down anomalies opened in 7 days, down episodes by day, each location now against its '
      + 'baseline for the current hour (median and MAD), and suggested warning thresholds derived from the '
      + 'baselines. Distinguish a single bad link from a location where several checks degrade together, which '
      + `points at the site or its collector. ${RULES} Keep it under ~400 words.`,
    gather: gatherSiteReachability,
    noun: 'site reachability report',
  },
  circuit_capacity: {
    system:
      'You are reviewing WAN circuit capacity for a network team, from LogicMonitor interface data. You are given '
      + 'each circuit with its p95 utilization, highest daily peak, headroom, errors and flaps in 24 hours, its busiest '
      + 'UTC hour and the days it ran at the critical peak. Rank circuits by risk, say which need more bandwidth or a '
      + 'traffic review, and call out circuits that are down or flapping. No contract or price data is given; do not '
      + `assert any. ${RULES} Keep it under ~400 words.`,
    gather: gatherCircuitCapacity,
    noun: 'circuit capacity report',
  },
  backup_network_impact: {
    system:
      'You are reviewing the effect of backup jobs on the network. You are given backup windows of the last 7 days: '
      + 'for each ESX host or server and switch port, the merged time window of the Cohesity runs that overlapped, the '
      + 'jobs in it with each job share of the bytes, the mean and maximum utilization of the port during the window, the '
      + 'baseline for those hours and a finding (saturates or elevated). The uplink rule says whether the port is behind the '
      + 'management vmkernel, one of all uplinks of the host, or a physical server port. Group by switch port, name the jobs '
      + 'that collide in one window, and suggest schedule or bandwidth changes. '
      + `${RULES} Keep it under ~400 words.`,
    gather: gatherBackupNetworkImpact,
    noun: 'backup network impact report',
  },
  replication_bandwidth: {
    system:
      'You are reviewing whether replication trouble lines up with WAN circuit saturation. You are given Zerto RPO '
      + 'breaches, Zerto RPO or journal alerts and Cohesity replication runs that failed or lagged, each with the circuit '
      + 'that carried the traffic, the circuit utilization and p95 during the event and a finding (coincident when the '
      + 'circuit was over the saturation line, possible when above 60 percent). Also given is the list of circuits with '
      + 'headroom. Say which events are explained by circuit load and which are not, name circuits that need more bandwidth '
      + `or traffic shaping, and do not assert any contract or price. ${RULES} Keep it under ~400 words.`,
    gather: gatherReplicationBandwidth,
    noun: 'replication vs circuits report',
  },
  availability_review: {
    system:
      'You are writing a 30 day availability review for a network estate monitored by LogicMonitor. You are given '
      + 'daily peaks of dead devices, dead-collector devices, interfaces down and checks down, device and collector '
      + 'outage episodes from the issue history, host status alert episodes per device, interfaces that flapped, '
      + `and checks with down samples. Rank repeat offenders first. ${RULES} Keep it under ~400 words.`,
    gather: gatherAvailabilityReview,
    noun: 'availability review',
  },
  network_brief: {
    system:
      'You are writing the morning network brief for the on-call engineer from LogicMonitor and ICC data. You are given '
      + 'the health score and counters, the site map nodes (state, dead devices, ports down, saturated circuits, inbound '
      + 'reachability with the last six hourly points), the issues that are burning with the likely hop and a short '
      + 'metric summary, the last six hourly points of alert and degradation trends, and what changed in the last 24 '
      + 'hours (issues opened and resolved, configuration changes). Lead with what changed in the last 24 hours, name the '
      + 'sites to look at first and why, then say how healthy the monitoring itself is (collectors, coverage score, '
      + `shadowed alerts). ${RULES} Keep it to about 350 words.`,
    gather: gatherNetworkBrief,
    noun: 'network brief',
  },
  chokepoints: {
    system:
      'You are finding the network chokepoints that ICC keeps blaming for incidents, from 30 days of blame history. You are '
      + 'given the top hops (device and port) with how many times each was blamed, on how many distinct days, the subjects '
      + 'it was blamed for, the application services whose servers sit behind it, its current status and interface counters, '
      + 'and the open issues that name it. Pattern chronic means blamed on five or more distinct days; single-day burst means '
      + 'one day only. Separate chronic hops from one burst, recommend what to check on each (port, circuit or device), and '
      + `say which application services depend on it. A blame is a lead, not proof. ${RULES} Keep it under ~400 words.`,
    gather: gatherChokepoints,
    noun: 'chokepoint report',
  },
  change_impact: {
    system:
      'You are reviewing the effect of network configuration changes on incidents. You are given the changes of the last 14 '
      + 'days that were followed by an incident within 24 hours (with the minutes to the first incident), counts by change '
      + 'scope with how many were followed by an incident, changes per scope per day, and the newest changes that no incident '
      + 'followed. Say which classes of change look risky in this estate and how soon trouble follows, and what to put under '
      + 'change control. Say plainly that a pairing is a lead, not proof of cause. '
      + `${RULES} Keep it under ~400 words.`,
    gather: gatherChangeImpact,
    noun: 'change impact report',
  },
  monitoring_coverage: {
    system:
      'You are assessing where monitoring of a network estate is blind or untrusted. You are given the coverage score and the '
      + 'gap lists (up ports with no description, switches with no LLDP or CDP datasource, network devices with no site, check '
      + 'locations with no baseline, unresolved link descriptions) with the population each is measured against, devices '
      + 'behind a down collector, shadowed alerts, and the webhook state of each portal. Rank the gaps by how much of the estate '
      + 'each one hides, and give concrete fixes in LogicMonitor (port descriptions, device groups, collectors, checks, webhook '
      + `setup). ${RULES} Keep it under ~400 words.`,
    gather: gatherMonitoringCoverage,
    noun: 'monitoring coverage report',
  },
  suppression_review: {
    system:
      'You are reviewing alert suppression in a LogicMonitor estate. You are given alerts ICC treats as shadowed by an upstream '
      + 'failure (count by upstream device and port, examples), devices in scheduled downtime with the window and how long it has '
      + 'run, open alerts inside downtime, downtime entries older than seven days or with no end, and open device-in-sdt issues. '
      + 'Say which suppressions could be hiding real problems, which downtime windows have outlived their change, and which '
      + `upstream failures mask many downstream alerts (fix the upstream first). ${RULES} Keep it under ~400 words.`,
    gather: gatherSuppressionReview,
    noun: 'suppression review',
  },
  app_network_exposure: {
    system:
      'You are reviewing how exposed application services are to single points of failure in the network. For each watched '
      + 'application service you are given its state, its servers with the switch ports behind them, how many distinct switches '
      + 'and ports carry them, whether one switch carries every server with a known port, the network component rows (port and '
      + 'reachability findings), and the path blame. Say which applications sit behind a single switch, port or circuit, which have '
      + 'a degraded network component now, and what redundancy is missing. Servers with no known switch port are a data gap, not '
      + `evidence of redundancy. ${RULES} Keep it under ~400 words.`,
    gather: gatherAppNetworkExposure,
    noun: 'application network exposure report',
  },
  interface_errors: {
    system:
      'You are finding physical-layer suspects on a network estate from LogicMonitor interface data. You are given interfaces '
      + 'whose error and discard rate grew over the last 7 days (rate over the last 3 days against the 4 days before), grouped by '
      + 'device, the latest in and out sample, flaps, the hourly error baseline (median and MAD), and open or recent issues of '
      + 'type interface-errors-growing, interface-error-anomaly and interface-flapping. Name likely causes (optics, cables, duplex '
      + 'or speed mismatch, a congested uplink for discards), say which ports to swap or clean first and which look like noise. '
      + `${RULES} Keep it under ~400 words.`,
    gather: gatherInterfaceErrors,
    noun: 'interface errors report',
  },
  alert_delivery: {
    system:
      'You are checking whether ICC hears about LogicMonitor alerts fast enough. For each portal you are given the poll cadence '
      + '(last poll, average and longest gap in 24 hours), the webhook state and the events accepted and rejected in 24 hours with '
      + 'reject reasons, the delay in seconds between an alert starting and the webhook arriving for alerts seen both ways '
      + '(median, p95, max), and how many alerts in 24 hours were seen only by polling. Say whether delivery is fast enough, which '
      + 'path is dropping alerts, and what to change in the LogicMonitor integration (webhook template, poll interval). '
      + `${RULES} Keep it under ~350 words.`,
    gather: gatherAlertDelivery,
    noun: 'alert delivery report',
  },
  site_brief: {
    system:
      'You are writing a one-site brief for the engineer who owns this site, from LogicMonitor and ICC data. You are given the '
      + 'site state, its devices (dead first), ports that are down, circuits, inbound and outbound reachability, open ICC issues '
      + 'at the site, configuration changes of the last 7 days, correlation counts, hops at the site that were blamed in 30 days, '
      + 'and what is unmonitored. Say what state the site is in and why, what is degrading, what changed, what to check first, and '
      + `what is not monitored. ${RULES} Keep it to about 350 words.`,
    gather: gatherSiteBrief,
    noun: ({ scope }) => `site brief for ${scope}`,
    scoped: true,
  },
};

module.exports = createPlatformAdvisor({
  platform: 'logicmonitor',
  feature: 'LogicMonitor AI Advisor',
  table: 'lm_ai_reports',
  reports: REPORTS,
});
// Exposed for rehearsal/contract tests (platformAdvisor's return has no gather accessor).
module.exports.reports = REPORTS;
