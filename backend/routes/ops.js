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

function pureSummary() {
  const arrays = count('SELECT COUNT(*) c FROM pure_arrays');
  const volumes = countSafe('SELECT COUNT(*) c FROM pure_volumes');
  const hosts = countSafe('SELECT COUNT(*) c FROM pure_hosts');
  const sev = {};
  for (const r of all("SELECT severity, COUNT(*) c FROM pure_alerts WHERE state IS NULL OR state = 'open' GROUP BY severity")) {
    sev[String(r.severity || '').toLowerCase()] = num(r.c);
  }
  const exceptions = [];
  if (sev.critical) exceptions.push(exception('critical', sev.critical, `${fnum(sev.critical)} critical alert${sev.critical === 1 ? '' : 's'}`, '/pure/alerts'));
  if (sev.warning) exceptions.push(exception('warning', sev.warning, `${fnum(sev.warning)} open warning${sev.warning === 1 ? '' : 's'}`, '/pure/alerts'));
  return {
    objects: arrays + volumes + hosts,
    headline: [
      { label: 'Arrays', value: arrays },
      { label: 'Volumes', value: volumes },
    ],
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

const PLATFORMS = [
  { id: 'cohesity', label: 'Cohesity', color: '#6CB33F', route: '/cohesity', fn: cohesitySummary },
  { id: 'pure', label: 'Pure', color: '#FF6B00', route: '/pure', fn: pureSummary },
  { id: 'netapp', label: 'NetApp', color: '#0067C5', route: '/netapp', fn: netappSummary },
  { id: 'zerto', label: 'Zerto', color: '#EE3124', route: '/zerto', fn: zertoSummary },
  { id: 'vcenter', label: 'vCenter', color: '#0091DA', route: '/vcenter', fn: vcenterSummary },
  { id: 'dell', label: 'Dell', color: '#007DB8', route: '/dell', fn: dellSummary },
];

const SEV_RANK = { critical: 0, warning: 1, info: 2 };

router.get('/summary', (req, res) => {
  const cards = [];
  for (const p of PLATFORMS) {
    // Cohesity is always-on (enabled iff clusters exist — its summarizer
    // returns null when there are none); registry drives the rest.
    if (p.id !== 'cohesity' && registry.getPlugin(p.id)?.enabled !== true) continue;
    const base = { id: p.id, label: p.label, color: p.color, route: p.route };
    try {
      const s = p.fn();
      if (!s) continue;
      const health = s.exceptions.some((e) => e.severity === 'critical') ? 'critical'
        : s.exceptions.some((e) => e.severity === 'warning') ? 'warning' : 'ok';
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
