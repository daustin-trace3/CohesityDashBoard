const express = require('express');
const db = require('../db/database');
const registry = require('../core/registry');
const { getSetting } = require('../services/settings');

const router = express.Router();

// Cross-platform ops summary powering the Ops Monitor landing page. Every
// platform summarizer is independently fault-isolated: a broken table or
// query degrades that one card to health 'unknown' instead of failing the
// whole page.

const one = (sql, ...args) => db.prepare(sql).get(...args);
const all = (sql, ...args) => db.prepare(sql).all(...args);
const num = (v) => Number(v) || 0;
const count = (sql, ...args) => num(one(sql, ...args)?.c);
// Optional count — table may not exist on older DBs.
const countSafe = (sql, ...args) => { try { return count(sql, ...args); } catch { return 0; } };

const FAILED_RUN_STATUSES = "('kFailure','kFailed','kError','kCanceled','kCancelled')";

// Align [{d:'YYYY-MM-DD', c}] rows to a dense last-7-days array.
function spark7(rows) {
  const map = new Map(rows.map((r) => [r.d, num(r.c)]));
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    out.push(map.get(d) || 0);
  }
  return out;
}

const fnum = (v) => Number(v).toLocaleString('en-US');
const exception = (severity, cnt, text, link) => ({ severity, count: cnt, text, link });

function cohesitySummary() {
  const clusters = count('SELECT COUNT(*) c FROM clusters');
  if (!clusters) return null;
  const sev = {};
  for (const r of all('SELECT severity, COUNT(*) c FROM alerts WHERE resolved = 0 AND dismissed = 0 GROUP BY severity')) {
    sev[String(r.severity || '').toLowerCase()] = num(r.c);
  }
  const failed24 = count(
    `SELECT COUNT(*) c FROM protection_runs WHERE status IN ${FAILED_RUN_STATUSES} AND start_time >= datetime('now','-1 day')`
  );
  const jobs = count("SELECT COUNT(DISTINCT job_name) c FROM protection_runs WHERE start_time >= datetime('now','-7 days')");
  const exceptions = [];
  if (failed24) exceptions.push(exception('critical', failed24, `${fnum(failed24)} protection run${failed24 === 1 ? '' : 's'} failed (24h)`, '/data-protection'));
  if (sev.critical) exceptions.push(exception('critical', sev.critical, `${fnum(sev.critical)} critical alert${sev.critical === 1 ? '' : 's'}`, '/cohesity/alerts'));
  if (sev.warning) exceptions.push(exception('warning', sev.warning, `${fnum(sev.warning)} warning alert${sev.warning === 1 ? '' : 's'}`, '/cohesity/alerts'));
  const gflagChanges = countSafe("SELECT COUNT(*) c FROM gflag_changes WHERE detected_at >= datetime('now','-1 day')");
  if (gflagChanges) exceptions.push(exception('warning', gflagChanges, `${fnum(gflagChanges)} gflag change${gflagChanges === 1 ? '' : 's'} detected (24h)`, '/cohesity/gflags'));
  return {
    objects: clusters + jobs,
    headline: [
      { label: 'Clusters', value: clusters },
      { label: 'Protection jobs', value: jobs },
    ],
    exceptions,
    spark: spark7(all(
      `SELECT date(start_time) d, COUNT(*) c FROM protection_runs
       WHERE status IN ${FAILED_RUN_STATUSES} AND start_time >= datetime('now','-7 days') GROUP BY date(start_time)`
    )),
    sparkLabel: 'failed runs / day',
  };
}

async function pureSummary() {
  // The Pure platform's primary source is the Pure1 SaaS fleet (cached in
  // pure1Api per its TTL — no extra cloud calls per page load); the direct
  // pure_* tables only cover locally registered arrays and are the fallback.
  const pure1 = require('../services/pure1Api');
  const directArrays = count('SELECT COUNT(*) c FROM pure_arrays');
  const volumes = countSafe('SELECT COUNT(*) c FROM pure_volumes');
  const hosts = countSafe('SELECT COUNT(*) c FROM pure_hosts');
  const exceptions = [];
  let arrays = directArrays;
  let headline = null;
  if (pure1.isConfigured()) {
    try {
      const [fleet, alerts] = await Promise.all([pure1.getOverview(), pure1.getAlerts()]);
      arrays = Math.max(fleet.length, directArrays);
      const sev = { critical: 0, warning: 0 };
      for (const a of alerts || []) {
        const s = String(a.severity || '').toLowerCase();
        if (s === 'critical') sev.critical += 1;
        else if (s === 'warning') sev.warning += 1;
      }
      if (sev.critical) exceptions.push(exception('critical', sev.critical, `${fnum(sev.critical)} critical alert${sev.critical === 1 ? '' : 's'}`, '/pure/alerts'));
      if (sev.warning) exceptions.push(exception('warning', sev.warning, `${fnum(sev.warning)} open warning${sev.warning === 1 ? '' : 's'}`, '/pure/alerts'));
      const now = Date.now();
      const notReporting = fleet.filter((a) => !a.capturedAt || (now - a.capturedAt) > 3 * 86400000).length;
      if (notReporting) exceptions.push(exception('warning', notReporting, `${fnum(notReporting)} array${notReporting === 1 ? '' : 's'} not reporting to Pure1`, '/pure'));
      const nearFull = fleet.filter((a) => a.pctUsed != null && a.pctUsed >= 90).length;
      if (nearFull) exceptions.push(exception('warning', nearFull, `${fnum(nearFull)} array${nearFull === 1 ? '' : 's'} ≥ 90% used`, '/pure/capacity'));
      const total = fleet.reduce((s, a) => s + (a.total || 0), 0);
      const used = fleet.reduce((s, a) => s + (a.used || 0), 0);
      headline = [
        { label: 'Arrays', value: arrays },
        { label: 'Capacity Used', value: total > 0 ? `${Math.round((used / total) * 100)}%` : '—' },
      ];
    } catch { /* Pure1 unreachable — fall back to the direct tables below */ }
  }
  if (!headline) {
    const sev = {};
    for (const r of all("SELECT severity, COUNT(*) c FROM pure_alerts WHERE state IS NULL OR state = 'open' GROUP BY severity")) {
      sev[String(r.severity || '').toLowerCase()] = num(r.c);
    }
    if (sev.critical) exceptions.push(exception('critical', sev.critical, `${fnum(sev.critical)} critical alert${sev.critical === 1 ? '' : 's'}`, '/pure/alerts'));
    if (sev.warning) exceptions.push(exception('warning', sev.warning, `${fnum(sev.warning)} open warning${sev.warning === 1 ? '' : 's'}`, '/pure/alerts'));
    headline = [
      { label: 'Arrays', value: directArrays },
      { label: 'Volumes', value: volumes },
    ];
  }
  return {
    objects: arrays + volumes + hosts,
    headline,
    exceptions,
    spark: null,
  };
}

function netappSummary() {
  const arrays = count('SELECT COUNT(*) c FROM netapp_arrays');
  const volumes = countSafe('SELECT COUNT(*) c FROM netapp_volumes');
  const aggregates = countSafe('SELECT COUNT(*) c FROM netapp_aggregates');
  const sev = { crit: 0, warn: 0 };
  for (const r of all('SELECT severity, COUNT(*) c FROM netapp_alerts GROUP BY severity')) {
    const s = String(r.severity || '').toLowerCase();
    if (['emergency', 'alert', 'critical'].includes(s)) sev.crit += num(r.c);
    else if (['error', 'warning'].includes(s)) sev.warn += num(r.c);
  }
  const fullAggr = countSafe('SELECT COUNT(*) c FROM netapp_aggregates WHERE used_percent >= 90');
  const exceptions = [];
  if (sev.crit) exceptions.push(exception('critical', sev.crit, `${fnum(sev.crit)} critical alert${sev.crit === 1 ? '' : 's'}`, '/netapp/alerts'));
  if (sev.warn) exceptions.push(exception('warning', sev.warn, `${fnum(sev.warn)} warning alert${sev.warn === 1 ? '' : 's'}`, '/netapp/alerts'));
  if (fullAggr) exceptions.push(exception('warning', fullAggr, `${fnum(fullAggr)} aggregate${fullAggr === 1 ? '' : 's'} ≥ 90% used`, '/netapp/capacity'));
  return {
    objects: arrays + volumes + aggregates,
    headline: [
      { label: 'Clusters', value: arrays },
      { label: 'Volumes', value: volumes },
    ],
    exceptions,
    spark: null,
  };
}

function zertoSummary() {
  const vpgs = one('SELECT COUNT(*) c, COALESCE(SUM(vms_count), 0) vms FROM zerto_vpgs') || {};
  const sites = count('SELECT COUNT(*) c FROM zerto_sites');
  const disconnected = countSafe("SELECT COUNT(*) c FROM zerto_sites WHERE connection_status IS NOT NULL AND connection_status != 'Connected'");
  const health = {};
  for (const r of all('SELECT health, COUNT(*) c FROM zerto_vpgs GROUP BY health')) health[String(r.health || '')] = num(r.c);
  const rpoBreach = countSafe('SELECT COUNT(*) c FROM zerto_vpgs WHERE configured_rpo > 0 AND actual_rpo > configured_rpo');
  const errAlerts = countSafe("SELECT COUNT(*) c FROM zerto_alerts WHERE severity = 'Error'");
  const exceptions = [];
  if (disconnected) exceptions.push(exception('critical', disconnected, `${fnum(disconnected)} site${disconnected === 1 ? '' : 's'} disconnected`, '/zerto/sites'));
  if (health.Error) exceptions.push(exception('critical', health.Error, `${fnum(health.Error)} VPG${health.Error === 1 ? '' : 's'} in error`, '/zerto/vpgs'));
  if (health.Warning) exceptions.push(exception('warning', health.Warning, `${fnum(health.Warning)} VPG${health.Warning === 1 ? '' : 's'} warning`, '/zerto/vpgs'));
  if (rpoBreach) exceptions.push(exception('warning', rpoBreach, `${fnum(rpoBreach)} VPG${rpoBreach === 1 ? '' : 's'} over RPO target`, '/zerto/replication'));
  if (errAlerts) exceptions.push(exception('critical', errAlerts, `${fnum(errAlerts)} open error alert${errAlerts === 1 ? '' : 's'}`, '/zerto/alerts'));
  return {
    objects: num(vpgs.c) + num(vpgs.vms) + sites,
    headline: [
      { label: 'VPGs', value: num(vpgs.c) },
      { label: 'Protected VMs', value: num(vpgs.vms) },
    ],
    exceptions,
    spark: spark7(all(
      "SELECT date(captured_at) d, MAX(alerts_count) c FROM zerto_metrics_history WHERE captured_at >= datetime('now','-7 days') GROUP BY date(captured_at)"
    )),
    sparkLabel: 'open alerts / day',
  };
}

function vcenterSummary() {
  const vcs = count('SELECT COUNT(*) c FROM vcenter_vcenters');
  const vcErr = countSafe("SELECT COUNT(*) c FROM vcenter_vcenters WHERE last_poll_status = 'error'");
  const hosts = count('SELECT COUNT(*) c FROM vcenter_hosts');
  const hostsDisc = countSafe("SELECT COUNT(*) c FROM vcenter_hosts WHERE connection_state IS NOT NULL AND connection_state != 'CONNECTED'");
  const vms = count('SELECT COUNT(*) c FROM vcenter_vms');
  const datastores = countSafe('SELECT COUNT(*) c FROM vcenter_datastores');
  const dsDown = countSafe('SELECT COUNT(*) c FROM vcenter_datastores WHERE accessible = 0');
  const dsLow = countSafe('SELECT COUNT(*) c FROM vcenter_datastores WHERE accessible != 0 AND capacity_bytes > 0 AND CAST(free_bytes AS REAL) / capacity_bytes < 0.10');
  const exceptions = [];
  if (vcErr) exceptions.push(exception('critical', vcErr, `${fnum(vcErr)} vCenter${vcErr === 1 ? '' : 's'} unreachable`, '/vcenter'));
  if (hostsDisc) exceptions.push(exception('critical', hostsDisc, `${fnum(hostsDisc)} host${hostsDisc === 1 ? '' : 's'} disconnected`, '/vcenter/hosts'));
  if (dsDown) exceptions.push(exception('critical', dsDown, `${fnum(dsDown)} datastore${dsDown === 1 ? '' : 's'} inaccessible`, '/vcenter/datastores'));
  if (dsLow) exceptions.push(exception('warning', dsLow, `${fnum(dsLow)} datastore${dsLow === 1 ? '' : 's'} < 10% free`, '/vcenter/datastores'));
  return {
    objects: vcs + hosts + vms + datastores,
    headline: [
      { label: 'ESXi hosts', value: hosts },
      { label: 'VMs', value: vms },
    ],
    exceptions,
    spark: spark7(all(
      "SELECT date(created_at) d, COUNT(*) c FROM vcenter_events WHERE severity IN ('error','warning') AND created_at >= datetime('now','-7 days') GROUP BY date(created_at)"
    )),
    sparkLabel: 'error/warning events / day',
  };
}

function dellSummary() {
  const omes = count('SELECT COUNT(*) c FROM dell_ome_instances');
  const omesErr = countSafe("SELECT COUNT(*) c FROM dell_ome_instances WHERE last_poll_status = 'error'");
  const devices = count('SELECT COUNT(*) c FROM dell_devices');
  const components = countSafe('SELECT COUNT(*) c FROM dell_components');
  const health = {};
  for (const r of all('SELECT health, COUNT(*) c FROM dell_devices GROUP BY health')) health[String(r.health || '')] = num(r.c);
  const disconnected = countSafe('SELECT COUNT(*) c FROM dell_devices WHERE connection_state = 0');
  const warnDays = Math.min(365, Math.max(1, num(getSetting('dell_warranty_warn_days')) || 90));
  // A tag is judged by its best (most current) agreement.
  const expired = countSafe('SELECT COUNT(*) c FROM (SELECT MAX(days_remaining) best FROM dell_warranties GROUP BY ome_id, service_tag) WHERE best <= 0');
  const expiring = countSafe('SELECT COUNT(*) c FROM (SELECT MAX(days_remaining) best FROM dell_warranties GROUP BY ome_id, service_tag) WHERE best > 0 AND best <= ?', warnDays);
  const exceptions = [];
  if (omesErr) exceptions.push(exception('critical', omesErr, `${fnum(omesErr)} OME instance${omesErr === 1 ? '' : 's'} unreachable`, '/dell'));
  if (health.critical) exceptions.push(exception('critical', health.critical, `${fnum(health.critical)} device${health.critical === 1 ? '' : 's'} critical`, '/dell/hardware'));
  if (health.warning) exceptions.push(exception('warning', health.warning, `${fnum(health.warning)} device${health.warning === 1 ? '' : 's'} degraded`, '/dell/hardware'));
  if (disconnected) exceptions.push(exception('warning', disconnected, `${fnum(disconnected)} device${disconnected === 1 ? '' : 's'} disconnected`, '/dell/hardware'));
  if (expired) exceptions.push(exception('warning', expired, `${fnum(expired)} service tag${expired === 1 ? '' : 's'} out of support`, '/dell/support'));
  if (expiring) exceptions.push(exception('warning', expiring, `${fnum(expiring)} warrant${expiring === 1 ? 'y expires' : 'ies expire'} ≤ ${warnDays}d`, '/dell/support'));
  return {
    objects: omes + devices + components,
    headline: [
      { label: 'Servers', value: devices },
      { label: 'Components', value: components },
    ],
    exceptions,
    spark: spark7(all(
      "SELECT date(created_at) d, COUNT(*) c FROM dell_alerts WHERE severity IN ('critical','warning') AND created_at >= datetime('now','-7 days') GROUP BY date(created_at)"
    )),
    sparkLabel: 'crit/warn alerts / day',
  };
}

function ariaSummary() {
  const instances = count('SELECT COUNT(*) c FROM aria_instances');
  const instErr = countSafe("SELECT COUNT(*) c FROM aria_instances WHERE last_poll_status = 'error'");
  const deployments = countSafe('SELECT COUNT(*) c FROM aria_deployments');
  const deploymentsFail = countSafe("SELECT COUNT(*) c FROM aria_deployments WHERE status LIKE '%FAIL%'");
  const leaseExpiring = countSafe("SELECT COUNT(*) c FROM aria_deployments WHERE lease_expire_at IS NOT NULL AND julianday(lease_expire_at) - julianday('now') <= 7");
  const endpoints = countSafe('SELECT COUNT(*) c FROM aria_endpoints');
  const endpointsUnhealthy = countSafe(
    "SELECT COUNT(*) c FROM aria_endpoints WHERE health_state IS NOT NULL AND LOWER(health_state) NOT IN ('ok','up','healthy','connected','active','available')"
  );
  const requests24h = countSafe("SELECT COUNT(*) c FROM aria_requests WHERE captured_at >= datetime('now','-1 day')");
  const exceptions = [];
  if (instErr) exceptions.push(exception('critical', instErr, `${fnum(instErr)} instance${instErr === 1 ? '' : 's'} unreachable`, '/aria'));
  if (endpointsUnhealthy) exceptions.push(exception('critical', endpointsUnhealthy, `${fnum(endpointsUnhealthy)} endpoint${endpointsUnhealthy === 1 ? '' : 's'} unhealthy`, '/aria/infrastructure'));
  if (deploymentsFail) exceptions.push(exception('warning', deploymentsFail, `${fnum(deploymentsFail)} deployment${deploymentsFail === 1 ? '' : 's'} failed`, '/aria/deployments'));
  if (leaseExpiring) exceptions.push(exception('warning', leaseExpiring, `${fnum(leaseExpiring)} lease${leaseExpiring === 1 ? '' : 's'} expiring ≤ 7d`, '/aria/deployments'));
  return {
    objects: instances + deployments + endpoints,
    headline: [
      { label: 'Deployments', value: deployments },
      { label: 'Requests 24h', value: requests24h },
    ],
    exceptions,
    spark: spark7(all(
      "SELECT date(captured_at) d, COUNT(*) c FROM aria_requests WHERE status LIKE '%FAIL%' AND captured_at >= datetime('now','-7 days') GROUP BY date(captured_at)"
    )),
    sparkLabel: 'failed requests / day',
  };
}

function netbackupSummary() {
  const sources = count('SELECT COUNT(*) c FROM netbackup_sources');
  const policies = countSafe('SELECT COUNT(*) c FROM netbackup_policies');
  const storageUnits = countSafe('SELECT COUNT(*) c FROM netbackup_storage_units');
  const appliances = countSafe('SELECT COUNT(*) c FROM netbackup_appliances');
  const jobs24h = countSafe("SELECT COUNT(*) c FROM netbackup_jobs WHERE started_at >= datetime('now','-1 day')");
  const failed24h = countSafe(
    "SELECT COUNT(*) c FROM netbackup_jobs WHERE started_at >= datetime('now','-1 day') AND (status_code > 0 OR state = 'FAILED')"
  );
  const protectedClients = countSafe(
    "SELECT COUNT(DISTINCT client_name) c FROM netbackup_jobs WHERE started_at >= datetime('now','-7 days')"
  );
  const sev = { critical: 0, warning: 0 };
  for (const r of all("SELECT severity, COUNT(*) c FROM netbackup_issue_history WHERE status = 'open' GROUP BY severity")) {
    const s = String(r.severity || '').toLowerCase();
    if (s === 'critical') sev.critical += num(r.c);
    else if (s === 'warning') sev.warning += num(r.c);
  }
  const exceptions = [];
  if (sev.critical) exceptions.push(exception('critical', sev.critical, `${fnum(sev.critical)} critical issue${sev.critical === 1 ? '' : 's'}`, '/netbackup/alerts'));
  if (sev.warning) exceptions.push(exception('warning', sev.warning, `${fnum(sev.warning)} warning issue${sev.warning === 1 ? '' : 's'}`, '/netbackup/alerts'));
  return {
    objects: sources + policies + storageUnits + appliances,
    headline: [
      { label: 'Jobs 24h', value: jobs24h },
      { label: 'Failed 24h', value: failed24h },
      { label: 'Protected clients', value: protectedClients },
    ],
    exceptions,
    spark: spark7(all(
      "SELECT date(started_at) d, COUNT(*) c FROM netbackup_jobs WHERE (status_code > 0 OR state = 'FAILED') AND started_at >= datetime('now','-7 days') GROUP BY date(started_at)"
    )),
    sparkLabel: 'failed jobs / day',
  };
}

function awsSummary() {
  const accounts = count('SELECT COUNT(*) c FROM aws_accounts');
  if (!accounts) return null;
  const ec2Total = countSafe('SELECT COUNT(*) c FROM aws_ec2_instances');
  const ec2Running = countSafe("SELECT COUNT(*) c FROM aws_ec2_instances WHERE state = 'running'");
  const lightsailTotal = countSafe('SELECT COUNT(*) c FROM aws_lightsail_instances');
  const ecsServices = countSafe('SELECT COUNT(*) c FROM aws_ecs_services');
  const s3Buckets = countSafe('SELECT COUNT(*) c FROM aws_s3_buckets');
  const mtdRow = one("SELECT COALESCE(SUM(amount_usd), 0) c FROM aws_cost_daily WHERE day >= strftime('%Y-%m-01', 'now')");
  const mtd = num(mtdRow?.c);
  const sev = { critical: 0, warning: 0 };
  let costSpike = false;
  for (const r of all("SELECT type, severity, COUNT(*) c FROM aws_issue_history WHERE status = 'open' GROUP BY type, severity")) {
    const s = String(r.severity || '').toLowerCase();
    if (s === 'critical') sev.critical += num(r.c);
    else if (s === 'warning') sev.warning += num(r.c);
    if (r.type === 'cost-spike') costSpike = true;
  }
  const exceptions = [];
  if (sev.critical) exceptions.push(exception('critical', sev.critical, `${fnum(sev.critical)} critical issue${sev.critical === 1 ? '' : 's'}`, '/aws/alerts'));
  if (sev.warning) exceptions.push(exception('warning', sev.warning, `${fnum(sev.warning)} warning issue${sev.warning === 1 ? '' : 's'}${costSpike ? ' (cost spike)' : ''}`, '/aws/alerts'));
  return {
    objects: ec2Total + lightsailTotal + ecsServices + s3Buckets,
    headline: [
      { label: 'MTD Spend', value: `$${mtd.toFixed(2)}` },
      { label: 'EC2 Running', value: `${ec2Running}/${ec2Total}` },
    ],
    exceptions,
    spark: spark7(all(
      "SELECT date(captured_at) d, MAX(mtd_spend_usd) c FROM aws_metrics_history WHERE captured_at >= datetime('now','-7 days') GROUP BY date(captured_at)"
    )),
    sparkLabel: 'MTD spend 7d',
  };
}

function proxmoxSummary() {
  const servers = count('SELECT COUNT(*) c FROM proxmox_servers');
  if (!servers) return null;
  const nodes = countSafe('SELECT COUNT(*) c FROM proxmox_nodes');
  const nodesOffline = countSafe("SELECT COUNT(*) c FROM proxmox_nodes WHERE status != 'online'");
  const guests = countSafe('SELECT COUNT(*) c FROM proxmox_guests');
  const guestsRunning = countSafe("SELECT COUNT(*) c FROM proxmox_guests WHERE status = 'running'");
  const storagePools = countSafe('SELECT COUNT(*) c FROM proxmox_storage');
  const sev = { critical: 0, warning: 0 };
  for (const r of all("SELECT severity, COUNT(*) c FROM proxmox_issue_history WHERE status = 'open' GROUP BY severity")) {
    const s = String(r.severity || '').toLowerCase();
    if (s === 'critical') sev.critical += num(r.c);
    else if (s === 'warning') sev.warning += num(r.c);
  }
  const exceptions = [];
  if (nodesOffline) exceptions.push(exception('critical', nodesOffline, `${fnum(nodesOffline)} node${nodesOffline === 1 ? '' : 's'} offline`, '/proxmox/nodes'));
  if (sev.critical) exceptions.push(exception('critical', sev.critical, `${fnum(sev.critical)} critical issue${sev.critical === 1 ? '' : 's'}`, '/proxmox/alerts'));
  if (sev.warning) exceptions.push(exception('warning', sev.warning, `${fnum(sev.warning)} warning issue${sev.warning === 1 ? '' : 's'}`, '/proxmox/alerts'));
  return {
    objects: nodes + guests + storagePools,
    headline: [
      { label: 'Nodes', value: nodes },
      { label: 'Guests', value: `${guestsRunning}/${guests}` },
    ],
    exceptions,
    spark: spark7(all(
      "SELECT date(started_at) d, COUNT(*) c FROM proxmox_tasks WHERE status IS NOT NULL AND status != 'OK' AND started_at >= datetime('now','-7 days') GROUP BY date(started_at)"
    )),
    sparkLabel: 'failed tasks / day',
  };
}

function brocadeSummary() {
  const sourceCount = count('SELECT COUNT(*) c FROM brocade_sources');
  if (!sourceCount) return null;

  const fabricsTotal = countSafe('SELECT COUNT(*) c FROM brocade_fabrics WHERE stale = 0');
  const switchesTotal = countSafe('SELECT COUNT(*) c FROM brocade_switches WHERE stale = 0');
  const portsOnline = countSafe("SELECT COUNT(*) c FROM brocade_switch_ports WHERE stale = 0 AND LOWER(COALESCE(state,'')) = 'online'");

  const sev = { critical: 0, warning: 0 };
  for (const r of all("SELECT severity, COUNT(*) c FROM brocade_issue_history WHERE resolved_at IS NULL GROUP BY severity")) {
    const s = String(r.severity || '').toLowerCase();
    if (s === 'critical') sev.critical += num(r.c);
    else if (s === 'warning') sev.warning += num(r.c);
  }
  const exceptions = [];
  if (sev.critical) exceptions.push(exception('critical', sev.critical, `${fnum(sev.critical)} critical issue${sev.critical === 1 ? '' : 's'}`, '/brocade/issues'));
  if (sev.warning) exceptions.push(exception('warning', sev.warning, `${fnum(sev.warning)} warning${sev.warning === 1 ? '' : 's'}`, '/brocade/issues'));

  const spark = all('SELECT ports_online FROM brocade_metrics ORDER BY ts DESC LIMIT 24').reverse().map((r) => num(r.ports_online));

  return {
    objects: switchesTotal,
    headline: [
      { label: 'Fabrics', value: fabricsTotal },
      { label: 'Switches', value: switchesTotal },
      { label: 'Ports Online', value: portsOnline },
    ],
    exceptions,
    spark: spark.length ? spark : null,
    sparkLabel: 'ports online',
  };
}

const PLATFORMS = [
  { id: 'cohesity', label: 'Cohesity', color: '#6CB33F', route: '/cohesity', fn: cohesitySummary },
  { id: 'pure', label: 'Pure', color: '#FF6B00', route: '/pure', fn: pureSummary },
  { id: 'netapp', label: 'NetApp', color: '#0067C5', route: '/netapp', fn: netappSummary },
  { id: 'zerto', label: 'Zerto', color: '#EE3124', route: '/zerto', fn: zertoSummary },
  { id: 'vcenter', label: 'vCenter', color: '#0091DA', route: '/vcenter', fn: vcenterSummary },
  { id: 'dell', label: 'Dell', color: '#007DB8', route: '/dell', fn: dellSummary },
  { id: 'aria', label: 'Aria', color: '#00A2C7', route: '/aria', fn: ariaSummary },
  { id: 'netbackup', label: 'NetBackup', color: '#B1181E', route: '/netbackup', fn: netbackupSummary },
  { id: 'aws', label: 'AWS', color: '#FF9900', route: '/aws', fn: awsSummary },
  { id: 'proxmox', label: 'Proxmox VE', color: '#E57000', route: '/proxmox', fn: proxmoxSummary },
  { id: 'brocade', label: 'Brocade SAN', color: '#CC092F', route: '/brocade', fn: brocadeSummary },
];

const SEV_RANK = { critical: 0, warning: 1, info: 2 };

router.get('/summary', async (req, res) => {
  const cards = [];
  for (const p of PLATFORMS) {
    // Cohesity is always-on (enabled iff clusters exist — its summarizer
    // returns null when there are none); registry drives the rest.
    if (p.id !== 'cohesity' && registry.getPlugin(p.id)?.enabled !== true) continue;
    const base = { id: p.id, label: p.label, color: p.color, route: p.route };
    try {
      const s = await p.fn();
      if (!s) continue;
      // Zero objects with nothing wrong means no source is connected yet —
      // report 'unknown' (NO DATA) rather than a hollow green.
      const health = s.exceptions.some((e) => e.severity === 'critical') ? 'critical'
        : s.exceptions.some((e) => e.severity === 'warning') ? 'warning'
        : num(s.objects) === 0 ? 'unknown' : 'ok';
      cards.push({ ...base, ...s, health });
    } catch (err) {
      cards.push({ ...base, health: 'unknown', objects: 0, headline: [], exceptions: [], spark: null, error: true });
    }
  }
  const attention = cards
    .flatMap((c) => c.exceptions.map((e) => ({ ...e, platformId: c.id, platform: c.label, color: c.color })))
    .sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9) || b.count - a.count)
    .slice(0, 10);
  const totals = {
    platforms: cards.length,
    objects: cards.reduce((s, c) => s + num(c.objects), 0),
    critical: cards.flatMap((c) => c.exceptions).filter((e) => e.severity === 'critical').reduce((s, e) => s + num(e.count), 0),
    warning: cards.flatMap((c) => c.exceptions).filter((e) => e.severity === 'warning').reduce((s, e) => s + num(e.count), 0),
  };
  res.json({ generatedAt: new Date().toISOString(), platforms: cards, attention, totals });
});

module.exports = router;
