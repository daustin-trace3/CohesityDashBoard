const db = require('../../db/database');
const { createPlatformAdvisor, linReg, parseUtcMs, fmtBytes } = require('../platformAdvisor');
const { vcenterHostUtilization, shortHost } = require('../dellVcenterUtil');

function gatherHardwareHealth() {
  const instances = db.prepare('SELECT id, name FROM dell_ome_instances').all();
  const names = new Map(instances.map(i => [i.id, i.name]));

  const devices = db.prepare(`
    SELECT ome_id, name, service_tag, model, health, power_state, inlet_temp_c, cpu_util_pct, mem_util_pct
    FROM dell_devices WHERE health != 'ok' ORDER BY (health = 'critical') DESC LIMIT 30
  `).all().map(d => ({
    instance: names.get(d.ome_id) || `OME ${d.ome_id}`,
    device: d.name, serviceTag: d.service_tag, model: d.model, health: d.health,
    powerState: d.power_state, inletTempC: d.inlet_temp_c, cpuUtilPct: d.cpu_util_pct, memUtilPct: d.mem_util_pct,
  }));

  const components = db.prepare(`
    SELECT c.ome_id, c.device_id, d.name AS device_name, c.kind, c.name, c.status
    FROM dell_components c LEFT JOIN dell_devices d ON d.ome_id = c.ome_id AND d.device_id = c.device_id
    WHERE c.status NOT IN ('ok') AND c.status IS NOT NULL
    ORDER BY (c.status = 'critical') DESC LIMIT 30
  `).all().map(c => ({
    instance: names.get(c.ome_id) || `OME ${c.ome_id}`,
    device: c.device_name || `Device ${c.device_id}`,
    kind: c.kind, component: c.name, status: c.status,
  }));

  const history = db.prepare(`
    SELECT ome_id, captured_at, devices_total, devices_ok, devices_warning, devices_critical, power_w_total
    FROM dell_metrics_history WHERE captured_at >= datetime('now', '-30 days') ORDER BY ome_id, captured_at ASC
  `).all();
  const byOme = new Map();
  for (const r of history) {
    if (!byOme.has(r.ome_id)) byOme.set(r.ome_id, []);
    byOme.get(r.ome_id).push(r);
  }
  const trend = instances.map(i => {
    const series = byOme.get(i.id) || [];
    const latest = series[series.length - 1];
    const pts = series.filter(r => r.power_w_total != null).map(r => ({ x: parseUtcMs(r.captured_at), y: r.power_w_total }));
    const reg = linReg(pts);
    return {
      instance: i.name,
      devicesTotal: latest?.devices_total ?? null,
      devicesOk: latest?.devices_ok ?? null,
      devicesWarning: latest?.devices_warning ?? null,
      devicesCritical: latest?.devices_critical ?? null,
      powerTrend: reg && reg.slope > 0 ? 'rising' : reg && reg.slope < 0 ? 'falling' : 'flat',
      dataPoints: series.length,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    unhealthyDevices: devices,
    nonOkComponents: components,
    trend,
    note: instances.length === 0 ? 'No Dell OME instances registered.' : undefined,
  };
}

function gatherLifecycleCompliance() {
  const instances = db.prepare('SELECT id, name FROM dell_ome_instances').all();
  const names = new Map(instances.map(i => [i.id, i.name]));

  const warranties = db.prepare(`
    SELECT ome_id, service_tag, device_model, end_date, days_remaining FROM dell_warranties
  `).all();
  const buckets = { expired: 0, within30d: 0, within90d: 0, within365d: 0, beyond: 0 };
  const expiringSoon = [];
  for (const w of warranties) {
    const d = w.days_remaining;
    if (d == null) continue;
    if (d < 0) buckets.expired += 1;
    else if (d <= 30) buckets.within30d += 1;
    else if (d <= 90) buckets.within90d += 1;
    else if (d <= 365) buckets.within365d += 1;
    else buckets.beyond += 1;
    if (d <= 90) {
      expiringSoon.push({
        instance: names.get(w.ome_id) || `OME ${w.ome_id}`,
        serviceTag: w.service_tag, model: w.device_model, endDate: w.end_date, daysRemaining: d,
      });
    }
  }
  expiringSoon.sort((a, b) => a.daysRemaining - b.daysRemaining);

  const firmware = db.prepare(`
    SELECT ome_id, baseline_name, service_tag, device_model, noncompliant_components
    FROM dell_firmware_compliance WHERE status = 'noncompliant' ORDER BY noncompliant_components DESC LIMIT 30
  `).all().map(f => ({
    instance: names.get(f.ome_id) || `OME ${f.ome_id}`,
    baseline: f.baseline_name, serviceTag: f.service_tag, model: f.device_model,
    noncompliantComponents: f.noncompliant_components,
  }));

  return {
    generatedAt: new Date().toISOString(),
    warrantyBuckets: buckets,
    warrantiesExpiringWithin90d: expiringSoon.slice(0, 30),
    firmwareNoncompliant: firmware,
    note: warranties.length === 0 && firmware.length === 0 ? 'No warranty or firmware compliance data collected yet.' : undefined,
  };
}

function gatherAlertTriage() {
  const instances = db.prepare('SELECT id, name FROM dell_ome_instances').all();
  const names = new Map(instances.map(i => [i.id, i.name]));
  const totals = db.prepare(`
    SELECT COUNT(*) total,
           SUM(CASE WHEN severity='critical' THEN 1 ELSE 0 END) critical,
           SUM(CASE WHEN severity='warning' THEN 1 ELSE 0 END) warning
    FROM dell_alerts WHERE status != 'acknowledged'
  `).get();
  const byCategory = db.prepare(`
    SELECT ome_id, category, subcategory, severity, message, COUNT(*) count
    FROM dell_alerts WHERE status != 'acknowledged'
    GROUP BY ome_id, category, subcategory, severity, message
    ORDER BY count DESC LIMIT 20
  `).all().map(r => ({
    instance: names.get(r.ome_id) || `OME ${r.ome_id}`,
    category: r.category, subcategory: r.subcategory, severity: r.severity, message: r.message, count: r.count,
  }));
  return {
    generatedAt: new Date().toISOString(),
    active: { total: totals.total || 0, critical: totals.critical || 0, warning: totals.warning || 0 },
    byCategory,
    note: (totals.total || 0) === 0 ? 'No unacknowledged Dell alerts.' : undefined,
  };
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

function gatherPowerThermal() {
  const instances = db.prepare('SELECT id, name FROM dell_ome_instances').all();
  const names = new Map(instances.map(i => [i.id, i.name]));

  const powerTrendByOme = db.prepare(`
    SELECT o.name AS ome_name, date(m.captured_at) AS day, MAX(m.power_w_total) AS power_w
    FROM dell_metrics_history m JOIN dell_ome_instances o ON o.id = m.ome_id
    WHERE m.captured_at >= datetime('now', '-30 days') AND m.power_w_total IS NOT NULL
    GROUP BY o.name, day ORDER BY day
  `).all();

  const temps = db.prepare(`
    SELECT inlet_temp_c FROM dell_devices WHERE inlet_temp_c IS NOT NULL ORDER BY inlet_temp_c
  `).all().map(r => r.inlet_temp_c);
  const inletTempP90C = percentile(temps, 90);
  const hotDevices = inletTempP90C == null ? [] : db.prepare(`
    SELECT ome_id, name, model, service_tag, inlet_temp_c FROM dell_devices
    WHERE inlet_temp_c IS NOT NULL AND inlet_temp_c >= ?
    ORDER BY inlet_temp_c DESC LIMIT 20
  `).all(inletTempP90C).map(d => ({
    instance: names.get(d.ome_id) || `OME ${d.ome_id}`,
    device: d.name, model: d.model, service_tag: d.service_tag, inlet_temp_c: d.inlet_temp_c,
  }));

  let utilizationSource = 'power_manager';
  let topUtilization = db.prepare(`
    SELECT name, model, cpu_util_pct, mem_util_pct FROM dell_devices
    WHERE cpu_util_pct IS NOT NULL OR mem_util_pct IS NOT NULL
    ORDER BY MAX(COALESCE(cpu_util_pct, 0), COALESCE(mem_util_pct, 0)) DESC LIMIT 15
  `).all();
  if (!topUtilization.length) {
    topUtilization = vcenterHostUtilization(db)
      .map(v => ({ name: v.name, model: null, cpu_util_pct: v.cpu_util_pct, mem_util_pct: v.mem_util_pct }))
      .sort((a, b) => Math.max(b.cpu_util_pct, b.mem_util_pct) - Math.max(a.cpu_util_pct, a.mem_util_pct))
      .slice(0, 15);
    utilizationSource = topUtilization.length ? 'vcenter_standin' : 'none';
  }

  const poweredOffDevices = db.prepare(`SELECT COUNT(*) AS n FROM dell_devices WHERE power_state = 'off'`).get().n;

  return {
    generatedAt: new Date().toISOString(),
    powerTrendByOme,
    inletTempP90C,
    hotDevices,
    utilizationSource,
    topUtilization,
    poweredOffDevices,
    note: (powerTrendByOme.length === 0 && temps.length === 0)
      ? 'No Power Manager metrics (power/thermal history) collected for this estate yet.' : undefined,
  };
}

function gatherConfigDrift() {
  const instances = db.prepare('SELECT id, name FROM dell_ome_instances').all();
  const names = new Map(instances.map(i => [i.id, i.name]));

  const baselines = db.prepare(`
    SELECT c.ome_id, c.baseline_id, c.baseline_name,
      SUM(CASE WHEN c.status = 'compliant' THEN 1 ELSE 0 END) AS compliant,
      SUM(CASE WHEN c.status = 'noncompliant' AND v.state IS NOT 'active' THEN 1 ELSE 0 END) AS noncompliant,
      SUM(CASE WHEN c.status = 'noncompliant' AND v.state = 'active' THEN 1 ELSE 0 END) AS accepted
    FROM dell_config_compliance c
    LEFT JOIN dell_config_variances v
      ON v.ome_id = c.ome_id AND v.baseline_id = c.baseline_id AND v.device_id = c.device_id
    GROUP BY c.ome_id, c.baseline_id, c.baseline_name
    ORDER BY noncompliant DESC LIMIT 30
  `).all().map(r => ({
    instance: names.get(r.ome_id) || `OME ${r.ome_id}`,
    baseline: r.baseline_name, compliant: r.compliant || 0, noncompliant: r.noncompliant || 0, accepted: r.accepted || 0,
  }));

  const staleVariances = db.prepare(`
    SELECT ome_id, device_name, service_tag, reason, accepted_by, stale_at, drift_count
    FROM dell_config_variances WHERE state = 'stale' ORDER BY stale_at DESC LIMIT 30
  `).all().map(v => ({
    instance: names.get(v.ome_id) || `OME ${v.ome_id}`,
    device: v.device_name, service_tag: v.service_tag, reason: v.reason,
    accepted_by: v.accepted_by, stale_at: v.stale_at, drift_count: v.drift_count,
  }));

  const driftTimeline30d = db.prepare(`
    SELECT date(first_seen) AS day, COUNT(*) AS count
    FROM dell_config_drift_history WHERE first_seen >= datetime('now', '-30 days')
    GROUP BY day ORDER BY day
  `).all();

  // Attribute drift is stored as a JSON array per compliance row; read a
  // bounded number of rows and tally in JS rather than a JSON aggregate query.
  const detailRows = db.prepare(`
    SELECT detail FROM dell_config_compliance WHERE status = 'noncompliant' AND detail IS NOT NULL LIMIT 500
  `).all();
  const attrCounts = new Map();
  for (const row of detailRows) {
    let parsed;
    try { parsed = JSON.parse(row.detail); } catch { continue; }
    if (!Array.isArray(parsed)) continue;
    for (const d of parsed) {
      const key = `${d.group || 'Unknown'} / ${d.attribute || 'unknown'}`;
      attrCounts.set(key, (attrCounts.get(key) || 0) + 1);
    }
  }
  const topDriftingAttributes = [...attrCounts.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([attribute, count]) => ({ attribute, count }));

  return {
    generatedAt: new Date().toISOString(),
    baselines,
    staleVariances,
    driftTimeline30d,
    topDriftingAttributes,
    note: baselines.length === 0 ? 'No configuration baselines with compliance data collected yet.' : undefined,
  };
}

function gatherJobHealth() {
  const instances = db.prepare('SELECT id, name FROM dell_ome_instances').all();
  const names = new Map(instances.map(i => [i.id, i.name]));

  const byTypeAndStatus = db.prepare(`
    SELECT ome_id, job_type, last_run_status, COUNT(*) AS count
    FROM dell_jobs WHERE last_run >= datetime('now', '-30 days')
    GROUP BY ome_id, job_type, last_run_status ORDER BY count DESC LIMIT 40
  `).all().map(r => ({
    instance: names.get(r.ome_id) || `OME ${r.ome_id}`,
    jobType: r.job_type, status: r.last_run_status, count: r.count,
  }));

  // 2070 = Failed (OME last_run_status_id), same code the fleet overview uses.
  const failedJobs = db.prepare(`
    SELECT ome_id, name, job_type, end_time, last_run_status FROM dell_jobs
    WHERE last_run_status_id = 2070 AND last_run >= datetime('now', '-30 days')
    ORDER BY last_run DESC LIMIT 20
  `).all().map(j => ({
    instance: names.get(j.ome_id) || `OME ${j.ome_id}`,
    name: j.name, jobType: j.job_type, ended: j.end_time, status: j.last_run_status,
  }));

  const longRunningJobs = db.prepare(`
    SELECT ome_id, name, job_type, start_time FROM dell_jobs
    WHERE start_time IS NOT NULL AND start_time <= datetime('now', '-1 day')
      AND (last_run_status LIKE '%Running%' OR job_status LIKE '%Running%')
  `).all().map(j => ({
    instance: names.get(j.ome_id) || `OME ${j.ome_id}`,
    name: j.name, jobType: j.job_type, startTime: j.start_time,
  }));

  const repeatedFailures = db.prepare(`
    SELECT ome_id, name, COUNT(*) AS failures FROM dell_jobs
    WHERE last_run_status_id = 2070 AND last_run >= datetime('now', '-30 days')
    GROUP BY ome_id, name HAVING COUNT(*) >= 2 ORDER BY failures DESC LIMIT 20
  `).all().map(r => ({ instance: names.get(r.ome_id) || `OME ${r.ome_id}`, name: r.name, failures: r.failures }));

  return {
    generatedAt: new Date().toISOString(),
    byTypeAndStatus,
    failedJobs,
    longRunningJobs,
    repeatedFailures,
    note: byTypeAndStatus.length === 0 ? 'No OME jobs recorded in the last 30 days.' : undefined,
  };
}

const PREFAIL_PATTERNS = [
  { label: 'DIMM correctable ECC', like: '%correct%' },
  { label: 'PSU / power supply', like: '%power supply%' },
  { label: 'Fan', like: '%fan%' },
  { label: 'Disk predictive failure', like: '%predictive%' },
  { label: 'Temperature / thermal', like: '%temperature%' },
];

function gatherHardwareLogForensics() {
  const instances = db.prepare('SELECT id, name FROM dell_ome_instances').all();
  const names = new Map(instances.map(i => [i.id, i.name]));

  const countsBySeverityAndCategory = db.prepare(`
    SELECT severity, category, COUNT(*) AS count FROM dell_hardware_logs
    WHERE created_at >= datetime('now', '-30 days')
    GROUP BY severity, category ORDER BY count DESC LIMIT 40
  `).all();

  const topDevicesByBadEntries = db.prepare(`
    SELECT l.ome_id, l.device_id, d.name AS device_name, d.service_tag,
      SUM(CASE WHEN l.severity = 'critical' THEN 1 ELSE 0 END) AS critical,
      SUM(CASE WHEN l.severity = 'warning' THEN 1 ELSE 0 END) AS warning
    FROM dell_hardware_logs l
    LEFT JOIN dell_devices d ON d.ome_id = l.ome_id AND d.device_id = l.device_id
    WHERE l.created_at >= datetime('now', '-30 days') AND l.severity IN ('critical', 'warning')
    GROUP BY l.ome_id, l.device_id ORDER BY (critical + warning) DESC LIMIT 20
  `).all().map(r => ({
    instance: names.get(r.ome_id) || `OME ${r.ome_id}`,
    device: r.device_name || `Device ${r.device_id}`, service_tag: r.service_tag,
    critical: r.critical || 0, warning: r.warning || 0,
  }));

  const topMessagePatterns = db.prepare(`
    SELECT l.message_id, COUNT(*) AS count, COUNT(DISTINCT l.device_id) AS device_count,
      (SELECT l2.message FROM dell_hardware_logs l2
        WHERE l2.message_id = l.message_id AND l2.created_at >= datetime('now', '-30 days') LIMIT 1) AS example
    FROM dell_hardware_logs l
    WHERE l.created_at >= datetime('now', '-30 days') AND l.message_id IS NOT NULL
    GROUP BY l.message_id ORDER BY count DESC LIMIT 20
  `).all().map(r => ({ messageId: r.message_id, count: r.count, deviceCount: r.device_count, example: r.example }));

  const preFailureClauses = PREFAIL_PATTERNS.map(() => 'l.message LIKE ?').join(' OR ');
  const preFailureParams = PREFAIL_PATTERNS.map(p => p.like);
  const preFailureSignals = db.prepare(`
    SELECT l.ome_id, l.device_id, d.name AS device_name, d.service_tag, COUNT(*) AS count
    FROM dell_hardware_logs l
    LEFT JOIN dell_devices d ON d.ome_id = l.ome_id AND d.device_id = l.device_id
    WHERE l.created_at >= datetime('now', '-30 days') AND (${preFailureClauses})
    GROUP BY l.ome_id, l.device_id ORDER BY count DESC LIMIT 20
  `).all(...preFailureParams).map(r => ({
    instance: names.get(r.ome_id) || `OME ${r.ome_id}`,
    device: r.device_name || `Device ${r.device_id}`, service_tag: r.service_tag, count: r.count,
  }));

  return {
    generatedAt: new Date().toISOString(),
    countsBySeverityAndCategory,
    topDevicesByBadEntries,
    topMessagePatterns,
    preFailureSignals,
    preFailurePatternsChecked: PREFAIL_PATTERNS.map(p => p.label),
    note: countsBySeverityAndCategory.length === 0 ? 'No hardware log entries in the last 30 days.' : undefined,
  };
}

function modelGeneration(model) {
  if (!model) return 'Unknown';
  const m = /[A-Z]{1,3}\d{3,4}[a-z]{0,3}/.exec(model);
  return m ? m[0] : model;
}

function gatherCapacityConsolidation() {
  const instances = db.prepare('SELECT id, name FROM dell_ome_instances').all();
  const names = new Map(instances.map(i => [i.id, i.name]));

  let utilizationSource = 'power_manager';
  let utilRows = db.prepare(`
    SELECT ome_id, name, model, cpu_util_pct, mem_util_pct FROM dell_devices
    WHERE cpu_util_pct IS NOT NULL OR mem_util_pct IS NOT NULL
  `).all();
  if (!utilRows.length) {
    utilizationSource = 'vcenter_standin';
    utilRows = vcenterHostUtilization(db).map(v => ({
      ome_id: null, name: v.name, model: null, cpu_util_pct: v.cpu_util_pct, mem_util_pct: v.mem_util_pct,
    }));
  }

  const idleDevices = utilRows
    .filter(r => (r.cpu_util_pct ?? 100) < 10 && (r.mem_util_pct ?? 100) < 30)
    .slice(0, 20)
    .map(r => ({ instance: r.ome_id ? (names.get(r.ome_id) || `OME ${r.ome_id}`) : null,
      device: r.name, model: r.model, cpu_util_pct: r.cpu_util_pct, mem_util_pct: r.mem_util_pct }));

  const hotDevices = utilRows
    .filter(r => (r.cpu_util_pct ?? 0) > 85 || (r.mem_util_pct ?? 0) > 85)
    .slice(0, 20)
    .map(r => ({ instance: r.ome_id ? (names.get(r.ome_id) || `OME ${r.ome_id}`) : null,
      device: r.name, model: r.model, cpu_util_pct: r.cpu_util_pct, mem_util_pct: r.mem_util_pct }));

  const poweredOffWithWarranty = db.prepare(`
    SELECT d.ome_id, d.name, d.model, d.service_tag,
      (SELECT MAX(w.days_remaining) FROM dell_warranties w
        WHERE w.ome_id = d.ome_id AND w.service_tag = d.service_tag) AS best_days_remaining
    FROM dell_devices d WHERE d.power_state = 'off'
    ORDER BY best_days_remaining DESC LIMIT 20
  `).all().map(d => ({
    instance: names.get(d.ome_id) || `OME ${d.ome_id}`,
    device: d.name, model: d.model, service_tag: d.service_tag, best_days_remaining: d.best_days_remaining,
  }));

  const modelDistribution = db.prepare(`
    SELECT model, COUNT(*) AS count, AVG(cpu_util_pct) AS avg_cpu_util_pct, AVG(mem_util_pct) AS avg_mem_util_pct
    FROM dell_devices WHERE model IS NOT NULL GROUP BY model ORDER BY count DESC LIMIT 20
  `).all();

  const genCounts = new Map();
  for (const r of modelDistribution) {
    const gen = modelGeneration(r.model);
    genCounts.set(gen, (genCounts.get(gen) || 0) + r.count);
  }
  const generationMix = [...genCounts.entries()]
    .map(([generation, count]) => ({ generation, count }))
    .sort((a, b) => b.count - a.count);

  return {
    generatedAt: new Date().toISOString(),
    utilizationSource,
    idleDevices,
    hotDevices,
    poweredOffWithWarranty,
    modelDistribution,
    generationMix,
    note: utilRows.length === 0
      ? 'No CPU/memory utilization data available (no Power Manager plugin and no matching vCenter hosts).' : undefined,
  };
}

function gatherSupportCasePrep() {
  const instances = db.prepare('SELECT id, name FROM dell_ome_instances').all();
  const names = new Map(instances.map(i => [i.id, i.name]));

  const critical = db.prepare(`
    SELECT id, ome_id, device_id, name, model, service_tag FROM dell_devices WHERE health = 'critical' LIMIT 15
  `).all();

  const criticalDevices = critical.map(d => {
    const openCriticalAlerts = db.prepare(`
      SELECT COUNT(*) AS n FROM dell_alerts
      WHERE ome_id = ? AND severity = 'critical' AND status != 'acknowledged'
        AND (service_tag = ? OR device_name = ?)
    `).get(d.ome_id, d.service_tag, d.name).n;
    const failingComponents = db.prepare(`
      SELECT kind, name, status FROM dell_components
      WHERE ome_id = ? AND device_id = ? AND status IN ('critical', 'warning')
    `).all(d.ome_id, d.device_id).map(c => ({ kind: c.kind, name: c.name, status: c.status }));
    const warranty = db.prepare(`
      SELECT MAX(days_remaining) AS best FROM dell_warranties WHERE ome_id = ? AND service_tag = ?
    `).get(d.ome_id, d.service_tag);
    const firmware = db.prepare(`
      SELECT status FROM dell_firmware_compliance WHERE ome_id = ? AND (service_tag = ? OR device_id = ?) LIMIT 1
    `).get(d.ome_id, d.service_tag, d.device_id);
    return {
      instance: names.get(d.ome_id) || `OME ${d.ome_id}`,
      device: d.name, model: d.model, service_tag: d.service_tag,
      open_critical_alerts: openCriticalAlerts,
      failingComponents,
      warranty_days_remaining: warranty?.best ?? null,
      firmwareStatus: firmware?.status || 'unknown',
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    criticalDevices,
    note: criticalDevices.length === 0 ? 'No devices currently in critical health.' : undefined,
  };
}

function norm(s) {
  return String(s || '').trim().toLowerCase();
}

/** Scoped report: everything ICC knows about ONE physical server, matched by
 *  service tag (case-insensitive). Two OME instances can independently
 *  report the same physical device (chassis + rack, or a re-registered
 *  appliance); when that happens every matched row is included and tagged
 *  with its OME instance name. */
function gatherDevice360({ scope } = {}) {
  const tag = String(scope || '').trim();
  if (!tag) return null;

  const devices = db.prepare(`
    SELECT d.*, o.name AS ome_name FROM dell_devices d
    JOIN dell_ome_instances o ON o.id = d.ome_id
    WHERE LOWER(d.service_tag) = LOWER(?)
  `).all(tag);
  if (!devices.length) return null;

  const pairClause = devices.map(() => '(ome_id = ? AND device_id = ?)').join(' OR ');
  const pairParams = devices.flatMap(d => [d.ome_id, d.device_id]);

  const components = db.prepare(`
    SELECT ome_id, device_id, kind, name, status, model, serial, slot FROM dell_components
    WHERE ${pairClause} ORDER BY kind, slot LIMIT 60
  `).all(...pairParams);

  const alertClause = devices.map(() => '(ome_id = ? AND (service_tag = ? OR device_name = ?))').join(' OR ');
  const alerts30d = db.prepare(`
    SELECT ome_id, severity, message, created_at FROM dell_alerts
    WHERE (${alertClause}) AND created_at >= datetime('now', '-30 days')
    ORDER BY created_at DESC LIMIT 30
  `).all(...devices.flatMap(d => [d.ome_id, d.service_tag, d.name]));

  const hardwareLogs30d = db.prepare(`
    SELECT ome_id, severity, message_id, message, created_at FROM dell_hardware_logs
    WHERE (${pairClause}) AND created_at >= datetime('now', '-30 days')
    ORDER BY created_at DESC LIMIT 40
  `).all(...pairParams);

  const warrantyClause = devices.map(() => '(ome_id = ? AND service_tag = ?)').join(' OR ');
  const warranty = db.prepare(`
    SELECT ome_id, service_level, start_date, end_date, days_remaining FROM dell_warranties
    WHERE ${warrantyClause}
  `).all(...devices.flatMap(d => [d.ome_id, d.service_tag]));

  const fwClause = devices.map(() => '(ome_id = ? AND (service_tag = ? OR device_id = ?))').join(' OR ');
  const firmwareCompliance = db.prepare(`
    SELECT ome_id, baseline_name, status, noncompliant_components FROM dell_firmware_compliance
    WHERE ${fwClause}
  `).all(...devices.flatMap(d => [d.ome_id, d.service_tag, d.device_id]));

  const pairClauseC = devices.map(() => '(c.ome_id = ? AND c.device_id = ?)').join(' OR ');
  const complianceRows = db.prepare(`
    SELECT c.ome_id, c.baseline_name, c.status, c.detail,
      v.state AS variance_state, v.reason AS variance_reason, v.accepted_by
    FROM dell_config_compliance c
    LEFT JOIN dell_config_variances v
      ON v.ome_id = c.ome_id AND v.baseline_id = c.baseline_id AND v.device_id = c.device_id
    WHERE ${pairClauseC}
  `).all(...pairParams);
  const configCompliance = complianceRows.map(r => {
    let driftDetail = [];
    if (r.detail) { try { driftDetail = JSON.parse(r.detail).slice(0, 40); } catch { driftDetail = []; } }
    return {
      baseline: r.baseline_name, status: r.status, driftDetail,
      variance_state: r.variance_state || null, variance_reason: r.variance_reason || null,
      accepted_by: r.accepted_by || null,
    };
  });

  // dell_jobs carries no device_id foreign key (only a comma-joined target
  // name string), so this is a best-effort text match, not a real link.
  const jobRows = [];
  for (const d of devices) {
    if (!d.name) continue;
    jobRows.push(...db.prepare(`
      SELECT name, job_type, last_run_status, last_run FROM dell_jobs
      WHERE ome_id = ? AND targets LIKE ? ORDER BY last_run DESC LIMIT 20
    `).all(d.ome_id, `%${d.name}%`));
  }

  // vCenter stand-in: match this device's reported OS hostname to a
  // vcenter_hosts row using the same exact/short-name rule as dellVcenterUtil.
  let vcenterStandIn = { note: 'No matching vCenter host found for this device.' };
  const osRow = db.prepare(`SELECT extra FROM dell_components WHERE (${pairClause}) AND kind = 'os' LIMIT 1`).get(...pairParams);
  let hostname = null;
  if (osRow?.extra) { try { hostname = JSON.parse(osRow.extra).hostname; } catch { hostname = null; } }
  if (hostname) {
    const vhost = db.prepare(`
      SELECT name, cluster_name, connection_state, in_maintenance, vm_count,
        cpu_mhz_used, cpu_mhz_capacity, mem_bytes_used, mem_bytes_capacity
      FROM vcenter_hosts WHERE name IS NOT NULL
    `).all().find(h => norm(h.name) === norm(hostname) || shortHost(h.name) === shortHost(hostname));
    if (vhost) {
      vcenterStandIn = {
        host: vhost.name, cluster_name: vhost.cluster_name, connection_state: vhost.connection_state,
        in_maintenance: !!vhost.in_maintenance, vm_count: vhost.vm_count,
        cpu_util_pct: vhost.cpu_mhz_capacity ? (vhost.cpu_mhz_used / vhost.cpu_mhz_capacity) * 100 : null,
        mem_util_pct: vhost.mem_bytes_capacity ? (vhost.mem_bytes_used / vhost.mem_bytes_capacity) * 100 : null,
      };
    }
  }

  const componentsByKind = {};
  for (const c of components) {
    (componentsByKind[c.kind] ||= []).push({ name: c.name, status: c.status, model: c.model, serial: c.serial, slot: c.slot });
  }

  return {
    generatedAt: new Date().toISOString(),
    matchedInstances: devices.map(d => d.ome_name),
    devices: devices.map(d => ({
      instance: d.ome_name, name: d.name, model: d.model, health: d.health,
      power_state: d.power_state, connection_state: d.connection_state,
      firmware_version: d.firmware_version, inlet_temp_c: d.inlet_temp_c,
      cpu_util_pct: d.cpu_util_pct, mem_util_pct: d.mem_util_pct, service_tag: d.service_tag,
    })),
    componentsByKind,
    alerts30d,
    hardwareLogs30d,
    warranty,
    firmwareCompliance,
    configCompliance,
    jobs: {
      rows: jobRows,
      note: 'dell_jobs has no device_id foreign key; matched by device name appearing in the job targets text.',
    },
    powerThermalHistory: {
      note: 'No per-device power/thermal time series is collected; only the latest snapshot on the device row (inlet_temp_c, cpu_util_pct, mem_util_pct) is available.',
    },
    vcenterStandIn,
  };
}

const REPORTS = {
    hardware_health: {
      system:
        'You are a Dell PowerEdge hardware engineer using OpenManage Enterprise data. You are given devices not in ' +
        'healthy state (power/thermal/utilization), non-ok components, and per-instance device-health trend. Identify ' +
        'which devices/components need attention soonest and likely causes (thermal, power, component failure). Do not ' +
        'invent data. Markdown sections: **Summary**, **Needs attention (prioritized)**, **Recommended actions**. ' +
        'Keep under ~400 words.',
      gather: gatherHardwareHealth,
      noun: 'hardware health report',
    },
    lifecycle_compliance: {
      system:
        'You are a Dell hardware lifecycle manager. You are given warranty expiry buckets and the devices expiring ' +
        'within 90 days, plus firmware-compliance baselines with noncompliant device counts. Produce a lifecycle plan: ' +
        'prioritize renewal/replacement by urgency and flag firmware drift needing remediation. Do not invent data. ' +
        'Markdown sections: **Warranty summary**, **Renewals needed (soonest first)**, **Firmware compliance**, ' +
        '**Recommended actions**. Keep under ~400 words.',
      gather: gatherLifecycleCompliance,
      noun: 'lifecycle and compliance report',
    },
    alert_triage: {
      system:
        'You are an operations lead triaging active alerts across a Dell PowerEdge/OME estate. You are given active ' +
        'alert totals by severity and the noisiest alert categories grouped by instance and device. Separate signal ' +
        'from noise and give a prioritized triage plan. Do not invent data. Markdown sections: **Summary**, ' +
        '**Systemic patterns**, **Recommended triage order**. Keep under ~350 words.',
      gather: gatherAlertTriage,
      noun: 'alert triage report',
    },
    power_thermal: {
      system:
        'You are a Dell PowerEdge power and thermal analyst using OpenManage Enterprise Power Manager data (or a ' +
        'vCenter utilization stand-in when Power Manager is absent). You are given the per-instance power trend, ' +
        'devices whose inlet temperature is in the top 10 percent of the fleet, top CPU/memory utilization, and the ' +
        'powered-off device count. Identify thermal or power risk and consolidation opportunity. Do not invent ' +
        'data. Markdown sections: **Summary**, **Thermal risk**, **Utilization outliers**, **Recommended actions**. ' +
        'Keep under ~400 words.',
      gather: gatherPowerThermal,
      noun: 'power and thermal report',
    },
    config_drift: {
      system:
        'You are a Dell configuration governance lead. You are given per-baseline compliance counts (compliant, ' +
        'noncompliant, accepted), accepted variances that have gone stale, a 30-day drift-detection timeline, and ' +
        'the most common drifting configuration attributes across the fleet. Identify systemic misconfiguration ' +
        'and stale acceptances needing re-review. Do not invent data. Markdown sections: **Summary**, **Stale ' +
        'variances needing re-review**, **Systemic drift patterns**, **Recommended actions**. Keep under ~400 words.',
      gather: gatherConfigDrift,
      noun: 'configuration drift report',
    },
    job_health: {
      system:
        'You are an OME job-reliability analyst. You are given 30 days of job counts by type and outcome, failed ' +
        'jobs, jobs still running more than 24 hours after they started, and job names with 2 or more repeated ' +
        'failures. Identify unreliable job types and jobs needing operator attention. Do not invent data. Markdown ' +
        'sections: **Summary**, **Jobs needing attention**, **Recommended actions**. Keep under ~350 words.',
      gather: gatherJobHealth,
      noun: 'job health report',
    },
    hardware_log_forensics: {
      system:
        'You are a Dell iDRAC/lifecycle log forensics analyst. You are given 30 days of hardware log counts by ' +
        'severity and category, the devices with the most critical/warning entries, the most common message-id ' +
        'patterns fleet-wide, and entries matching pre-failure signatures (DIMM correctable errors, PSU, fan, disk ' +
        'predictive failure, temperature). Identify devices trending toward hardware failure. Do not invent data. ' +
        'Markdown sections: **Summary**, **Pre-failure signals**, **Devices to inspect**, **Recommended actions**. ' +
        'Keep under ~400 words.',
      gather: gatherHardwareLogForensics,
      noun: 'hardware log forensics report',
    },
    capacity_consolidation: {
      system:
        'You are a Dell fleet capacity planner. You are given the utilization data source, idle devices (low CPU ' +
        'and memory), hot devices (high CPU or memory), powered-off devices with remaining warranty, model ' +
        'distribution with average utilization, and a generation mix by model. Identify consolidation and refresh ' +
        'candidates. Do not invent data. Markdown sections: **Summary**, **Consolidation candidates**, **Refresh ' +
        'candidates**, **Recommended actions**. Keep under ~400 words.',
      gather: gatherCapacityConsolidation,
      noun: 'capacity and consolidation report',
    },
    support_case_prep: {
      system:
        'You are preparing Dell support case summaries. You are given every device in critical health with its ' +
        'open critical alert count, failing components, warranty days remaining, and firmware compliance status. ' +
        'Write a case-ready summary per device the support team can paste into a ticket. Do not invent data. ' +
        'Markdown sections: a **Case summary** subsection per device, then **Recommended priority order**. Keep ' +
        'under ~450 words.',
      gather: gatherSupportCasePrep,
      noun: 'support case preparation report',
    },
    device_360: {
      system:
        'You are a Dell PowerEdge support engineer producing a per-server 360 analysis for the engineer who owns ' +
        'this server. You are given the device record, its components, recent alerts, hardware log entries, ' +
        'warranty, firmware compliance, configuration compliance and drift, any jobs that targeted it, and a ' +
        'vCenter utilization match when available. Do not invent data; call out any section that is empty or not ' +
        'linked. Markdown sections: **Health verdict**, **Root-cause hypotheses (ranked)**, **Do this week**, ' +
        '**Open a Dell case for**, **Data gaps**. Keep under ~450 words.',
      gather: gatherDevice360,
      noun: ({ scope }) => `device 360 analysis for service tag ${scope}`,
      scoped: true,
    },
};

module.exports = createPlatformAdvisor({
  platform: 'dell',
  feature: 'Dell AI Advisor',
  table: 'dell_ai_reports',
  reports: REPORTS,
});
// Exposed for rehearsal/testing so gather() can be exercised without an LLM call.
module.exports.reports = REPORTS;
