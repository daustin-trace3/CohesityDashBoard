// LogicMonitor platform manifest (ICC contract). Manifest-hooks built-in, the
// EON model: opsSummary, collectAlerts, searchCategories, metricsHistory,
// server360 and topology are wired through backend/core/registry.js. LM is a
// SaaS portal: platform red means the portal API is unreachable, consistent
// with the 2026-09-17 Service Status rule. The router (routes/logicmonitor.js)
// carries sources, data, governance, config and the advisor routes. Brand
// colour is a placeholder until Doug supplies the logo.
const lmMigrations = require('../../db/migrations/logicmonitor');
const { createLogicmonitorPollerHandle } = require('../../services/logicmonitorPoller');
const { isShadowedIssue, shadowedAlertCounts } = require('../../services/logicmonitorIssues');
const lmPath = require('../../services/logicmonitorPath');
const lmSites = require('../../services/logicmonitorSites');
const lmEndpoints = require('../../services/logicmonitorEndpoints');
const lmServers = require('../../services/logicmonitorServers');

const BRAND = '#1A73E8';

const toIso = (sqliteOrEpoch) => {
  if (sqliteOrEpoch == null || sqliteOrEpoch === '') return null;
  if (typeof sqliteOrEpoch === 'number') return new Date(sqliteOrEpoch * 1000).toISOString();
  const s = String(sqliteOrEpoch);
  const ms = Date.parse(s.includes('T') || /Z|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

function opsSummary(coreApi) {
  const db = coreApi?.db || require('../../db/database');
  const sourceCount = db.prepare('SELECT COUNT(*) n FROM lm_sources').get().n;
  if (!sourceCount) return null;

  const d = db.prepare(`
    SELECT COUNT(*) total, SUM(CASE WHEN host_status = 'normal' THEN 1 ELSE 0 END) normal,
      SUM(CASE WHEN is_network = 1 THEN 1 ELSE 0 END) network
    FROM lm_devices WHERE stale = 0
  `).get();
  const i = db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN status_text = 'up' THEN 1 ELSE 0 END) up FROM lm_interfaces WHERE stale = 0").get();
  const openAlerts = db.prepare('SELECT COUNT(*) n FROM lm_alerts WHERE cleared = 0 AND duplicate_of IS NULL').get().n;
  const collectorsDown = db.prepare('SELECT COUNT(*) n FROM lm_collectors WHERE stale = 0 AND is_down = 1').get().n;
  const latest = db.prepare(`
    SELECT COALESCE(SUM(checks_degraded), 0) + COALESCE(SUM(checks_down), 0) n FROM lm_metrics_history m
    WHERE m.id IN (SELECT MAX(id) FROM lm_metrics_history GROUP BY source_id)
  `).get().n;

  // computeIssues() loads every lm_ds_metrics row (~300 MB); the poller keeps lm_issue_history current.
  const issues = db.prepare("SELECT severity, type FROM lm_issue_history WHERE status = 'open'").all();
  const bySeverity = { critical: 0, warning: 0, info: 0 };
  for (const x of issues) bySeverity[x.severity] = (bySeverity[x.severity] || 0) + 1;
  const exceptions = [];
  if (bySeverity.critical) exceptions.push({ severity: 'critical', count: bySeverity.critical, text: `${bySeverity.critical} critical issue${bySeverity.critical === 1 ? '' : 's'}`, link: '/logicmonitor/issues' });
  if (bySeverity.warning) exceptions.push({ severity: 'warning', count: bySeverity.warning, text: `${bySeverity.warning} warning${bySeverity.warning === 1 ? '' : 's'}`, link: '/logicmonitor/issues' });
  if (bySeverity.info) exceptions.push({ severity: 'info', count: Math.min(bySeverity.info, 3), text: `${bySeverity.info} info notice${bySeverity.info === 1 ? '' : 's'}`, link: '/logicmonitor/issues' });
  const saturated = issues.filter((x) => x.type === 'circuit-saturated');
  if (saturated.length) {
    exceptions.push({ severity: saturated.some((x) => x.severity === 'critical') ? 'critical' : 'warning', count: saturated.length, text: `${saturated.length} WAN circuit${saturated.length === 1 ? '' : 's'} saturated`, link: '/logicmonitor/circuits' });
  }
  const shadowedN = db.prepare('SELECT COUNT(*) n FROM lm_alerts WHERE cleared = 0 AND shadowed_by IS NOT NULL').get().n;
  if (shadowedN) exceptions.push({ severity: 'info', count: shadowedN, text: `${shadowedN} alert${shadowedN === 1 ? '' : 's'} shadowed by an upstream failure`, link: '/logicmonitor/governance?section=shadowedAlerts' });
  const siteCount = db.prepare('SELECT COUNT(*) n FROM lm_sites').get().n;

  // alerts_critical summed across portals per capture slot, newest 24 rows.
  const spark = db.prepare(`
    SELECT SUM(alerts_critical) v FROM lm_metrics_history GROUP BY substr(captured_at, 1, 16) ORDER BY substr(captured_at, 1, 16) DESC LIMIT 24
  `).all().reverse().map((r) => r.v || 0);

  return {
    objects: d.network || 0,
    headline: [
      { label: 'Devices', value: `${d.normal || 0}/${d.total || 0}` },
      { label: 'Interfaces Up', value: `${i.up || 0}/${i.total || 0}` },
      { label: 'Open Alerts', value: openAlerts },
      { label: 'Collectors Down', value: collectorsDown },
      { label: 'Checks Degraded', value: latest || 0 },
      { label: 'Sites', value: siteCount },
    ],
    exceptions,
    spark: spark.length ? spark : null,
    sparkLabel: 'critical LogicMonitor alerts',
  };
}

/**
 * Union of ICC-computed issues (open lm_issue_history rows) and LM's own
 * alerts that are open, not SDTed and at LM severity 3 or 4. Acked alerts
 * stay in (they are still open conditions). sourceKey for LM alerts is the
 * content-stable condition_key, never the LM alert id.
 */
function collectAlerts(coreApi) {
  const db = coreApi?.db || require('../../db/database');
  const issues = db.prepare(`
    SELECT issue_key, severity, source, type, target, message, first_seen, last_seen
    FROM lm_issue_history WHERE status = 'open'
  `).all().filter((row) => !isShadowedIssue(row)).map((row) => ({
    sourceKey: row.issue_key,
    severity: row.severity,
    host: row.target || row.source,
    message: row.message,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    ...(row.type ? { type: row.type, typeLabel: row.type } : {}),
  }));
  const alerts = db.prepare(`
    SELECT condition_key, severity_norm, severity, source_id, lm_device_id, monitor_object_name, resource_template_name,
      instance_name, data_point_name, alert_value, threshold, start_epoch, captured_at
    FROM lm_alerts WHERE cleared = 0 AND COALESCE(sdted, 0) = 0 AND severity >= 3 AND shadowed_by IS NULL AND duplicate_of IS NULL
  `).all();
  // The upstream alert reads "+N downstream shadowed": on the culprit device's
  // most severe alerts, N = alerts hidden beneath it.
  const behind = shadowedAlertCounts(db);
  const topSeverity = new Map();
  for (const a of alerts) {
    const k = `${a.source_id}:${a.lm_device_id}`;
    if (!topSeverity.has(k) || a.severity > topSeverity.get(k)) topSeverity.set(k, a.severity);
  }
  const downstreamSuffix = (a) => {
    const k = `${a.source_id}:${a.lm_device_id}`;
    const n = behind.get(k) || 0;
    return n && a.severity === topSeverity.get(k) ? ` +${n} downstream shadowed` : '';
  };
  // One item per condition (a re-fired occurrence keeps the same key).
  const seen = new Map();
  for (const a of alerts) {
    const startIso = toIso(a.start_epoch);
    const capIso = toIso(a.captured_at);
    const lastSeen = [startIso, capIso].filter(Boolean).sort().pop() || null;
    const item = {
      sourceKey: a.condition_key,
      severity: a.severity_norm,
      host: a.monitor_object_name,
      message: `${`${a.resource_template_name || ''} ${a.instance_name || ''} ${a.data_point_name || ''} = ${a.alert_value ?? ''} (threshold ${a.threshold ?? ''})`.replace(/\s+/g, ' ').trim()}${downstreamSuffix(a)}`,
      firstSeen: startIso,
      lastSeen,
      type: a.resource_template_name || 'LogicMonitor alert',
      typeLabel: a.resource_template_name || 'LogicMonitor alert',
    };
    const prev = seen.get(item.sourceKey);
    if (!prev || (item.severity === 'critical' && prev.severity !== 'critical')) seen.set(item.sourceKey, item);
  }
  const alertItems = [...seen.values()];
  try { annotateGroups(db, issues, alertItems); } catch { /* grouping hints are best effort */ }
  return [...issues, ...alertItems];
}

const slugOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const LOCATION_FOLD_TYPES = (type) => /^latency-/.test(type) || type === 'loss-degrading' || type === 'check-location-down' || type === 'packet-loss-anomaly';
const CHECK_ISSUE_TYPES = (type) => /^latency-/.test(type) || /^loss-/.test(type) || type === 'check-down' || type === 'check-location-down' || type === 'packet-loss-anomaly' || type === 'location-latency';
const IF_DATASOURCE = /^(SNMP_)?Network[ _]Interfaces/i;

/**
 * Deterministic grouping hints for the Ops Agent (item.groupKey, honoured by
 * its incident keying in platform and site modes). Check issues from a probe
 * location with an open location-latency issue fold under lm-location:<slug>;
 * interface items on the devices of an open link-burst fold under
 * lm-burst:<target>. Check issues also carry checkName and location. The
 * host stays "<check> @ <location>" so the agent's host key can keep the check.
 */
function annotateGroups(db, issueItems, alertItems) {
  const locations = new Set(issueItems.filter((i) => i.type === 'location-latency').map((i) => slugOf(i.host)));
  for (const it of issueItems) {
    if (!CHECK_ISSUE_TYPES(it.type || '')) continue;
    const target = String(it.host || '');
    const at = target.lastIndexOf(' @ ');
    if (at >= 0) { it.checkName = target.slice(0, at); it.location = target.slice(at + 3); }
    else if (it.type === 'location-latency') it.location = target;
    else it.checkName = target;
    if (it.location && locations.has(slugOf(it.location)) && (it.type === 'location-latency' || LOCATION_FOLD_TYPES(it.type))) {
      it.groupKey = `lm-location:${slugOf(it.location)}`;
    }
  }
  const links = require('../../services/logicmonitorLinks');
  if (!links.hasOpenBurst(db)) return;
  const bursts = links.currentBursts(db);
  const burstFor = (deviceLower) => bursts.find((b) => b.deviceNames.has(deviceLower));
  for (const it of issueItems) {
    if (it.type === 'link-burst') { it.groupKey = `lm-burst:${it.host}`; continue; }
    if (!/^interface-/.test(it.type || '')) continue;
    const t = String(it.host || '').toLowerCase();
    for (const b of bursts) {
      for (const n of b.deviceNames) {
        if (t.startsWith(`${n} `)) { it.groupKey = `lm-burst:${b.target}`; break; }
      }
      if (it.groupKey) break;
    }
  }
  for (const it of alertItems) {
    if (!IF_DATASOURCE.test(String(it.type || ''))) continue;
    const b = burstFor(String(it.host || '').toLowerCase());
    if (b) it.groupKey = `lm-burst:${b.target}`;
  }
}

function matchDevices(db, names, ips, limit = 6) {
  const list = Array.from(new Set([...(names || []), ...(ips || [])].map((n) => String(n).toLowerCase()).filter(Boolean)));
  if (!list.length) return [];
  const ph = list.map(() => '?').join(',');
  const ipClauses = list.map(() => 'lower(d.ips_json) LIKE ?').join(' OR ');
  return db.prepare(`
    SELECT d.*, c.hostname AS collector_hostname, c.description AS collector_desc, c.is_down AS collector_down
    FROM lm_devices d
    LEFT JOIN lm_collectors c ON c.source_id = d.source_id AND c.collector_id = d.collector_id
    WHERE d.stale = 0 AND (lower(d.display_name) IN (${ph}) OR lower(d.name) IN (${ph}) OR lower(d.sysname) IN (${ph})
      OR lower(d.hostname) IN (${ph}) OR ${ipClauses})
    LIMIT ${Number(limit)}
  `).all(...list, ...list, ...list, ...list, ...list.map((n) => `%"${n.replace(/[%_"]/g, '')}"%`));
}

const fmtPct = (v) => (v == null || !Number.isFinite(Number(v)) ? '-' : `${Math.round(Number(v) * 10) / 10}%`);
const fmtNum = (v, unit) => (v == null || !Number.isFinite(Number(v)) ? '-' : `${Math.round(Number(v) * 10) / 10}${unit}`);
const TONE_TO_FACT = { crit: 'crit', warn: 'warn', ok: 'ok' };

/** Server 360 network path group (round 2): switch ports and reachability
 *  checks for the server, or null when ICC knows neither. Lines are plain
 *  strings (the Server 360 page renders them as text); the tone rides on a
 *  fact per port and per check. */
function networkPathGroup(path) {
  if (!path || (!path.switchPorts.length && !path.checks.length)) return null;
  const facts = [];
  const lines = [];
  for (const p of path.switchPorts) {
    const status = p.statusText || 'unknown';
    facts.push({ label: `Switch Port${p.nic ? ` (${p.nic})` : ''}`, value: `${p.deviceName || '?'} ${p.port || '?'}`, tone: TONE_TO_FACT[p.tone] });
    lines.push(`Switch port: ${p.deviceName || '?'} ${p.port || '?'} (${status}, in ${fmtPct(p.inUtilPct)} out ${fmtPct(p.outUtilPct)})`);
    for (const i of p.issues || []) lines.push(`Issue on ${p.deviceName || '?'} ${p.port || '?'}: ${i.message}`);
  }
  for (const c of path.checks) {
    const w = lmEndpoints.worstLocation(c);
    const tone = lmEndpoints.checkTone(w);
    facts.push({ label: 'Reachability', value: c.name, tone: TONE_TO_FACT[tone] });
    if (w) lines.push(`Reachability: ${c.name} from ${w.label} ${fmtNum(w.rttAvgMs, ' ms')}, ${fmtNum(w.lossPct, '%')} loss (${w.anomaly || 'ok'})`);
    else lines.push(`Reachability: ${c.name} (no locations reported)`);
  }
  const first = path.switchPorts[0];
  return {
    facts,
    lines,
    link: first
      ? { label: `Open ${first.deviceName || 'switch'} in LogicMonitor`, href: `/logicmonitor/devices?device=${first.deviceId}` }
      : { label: 'Open Site Reachability', href: '/logicmonitor/reachability' },
  };
}

/** Open, non-duplicate lm_alerts of one LM device, newest 20 first. */
function openAlertsOf(db, d, limit = 20) {
  return db.prepare(`
    SELECT severity, severity_norm, resource_template_name, instance_name, data_point_name, alert_value, threshold, start_epoch, acked, sdted
    FROM lm_alerts WHERE source_id = ? AND lm_device_id = ? AND cleared = 0 AND duplicate_of IS NULL
    ORDER BY severity DESC, start_epoch DESC LIMIT ${Number(limit)}
  `).all(d.source_id, d.lm_device_id);
}

/** Server 360 "LogicMonitor alerts" group for one matched LM device, or null. */
function alertsGroup(db, d) {
  try {
    const alerts = openAlertsOf(db, d, 8);
    if (!alerts.length) return null;
    const total = db.prepare('SELECT COUNT(*) n FROM lm_alerts WHERE source_id = ? AND lm_device_id = ? AND cleared = 0 AND duplicate_of IS NULL').get(d.source_id, d.lm_device_id).n;
    const sevTone = (s) => (s === 'critical' ? 'crit' : s === 'warning' ? 'warn' : undefined);
    return {
      facts: alerts.map((a) => ({
        label: 'LogicMonitor Alert',
        value: `${a.severity_norm}: ${[a.resource_template_name, a.instance_name].filter(Boolean).join(' ')}`.slice(0, 80),
        tone: sevTone(a.severity_norm),
      })),
      lines: [
        ...alerts.map((a) => `LogicMonitor alert ${a.severity_norm}: ${[a.resource_template_name, a.instance_name, a.data_point_name].filter(Boolean).join(' / ')} = ${a.alert_value ?? '-'} since ${epochShort(a.start_epoch) || '-'}`),
        ...(total > alerts.length ? [`... and ${total - alerts.length} more open LogicMonitor alert(s) on this device`] : []),
      ],
      link: { label: 'Open alerts in LogicMonitor', href: `/logicmonitor/alerts?deviceId=${d.lm_device_id}` },
    };
  } catch { return null; }
}

const fmtUptime = (sec) => {
  const n = Number(sec);
  if (!Number.isFinite(n) || n < 0) return null;
  const days = Math.floor(n / 86400);
  return days >= 1 ? `${days}d ${Math.floor((n % 86400) / 3600)}h` : `${Math.floor(n / 3600)}h ${Math.floor((n % 3600) / 60)}m`;
};

/**
 * Server 360 "LogicMonitor OS" group (round 11): CPU, memory, filesystems over the warning line,
 * stopped services and uptime from the 'os' and 'health' DataSource metrics of one matched LM
 * device, or null when the device has none. Datapoint names behind it are UNVERIFIED.
 */
function osGroup(db, d) {
  try {
    const issuesMod = require('../../services/logicmonitorIssues');
    const index = issuesMod.loadDsIndex(db, { families: ['os', 'health'], sourceId: d.source_id, deviceId: d.lm_device_id });
    const dev = [...index.values()][0];
    if (!dev) return null;
    const cpu = issuesMod.devMax(dev, 'cpu_pct');
    const mem = issuesMod.devMax(dev, 'mem_pct');
    const warn = issuesMod.getThreshold('lm_fs_warn_pct');
    const crit = issuesMod.getThreshold('lm_fs_crit_pct');
    const cpuWarn = issuesMod.getThreshold('lm_cpu_warn_pct');
    const memWarn = issuesMod.getThreshold('lm_mem_warn_pct');
    const fsAll = lmServers.filesystemsOf(dev);
    const fsOver = fsAll.filter((f) => f.pct >= warn).sort((a, b) => b.pct - a.pct);
    const stopped = issuesMod.devInstances(dev, 'svc_state').filter((i) => lmServers.serviceIsStopped(i.m.svc_state.value));
    const nfsDown = issuesMod.devInstances(dev, 'nfs_mount_state').filter((i) => lmServers.mountIsDown(i.m.nfs_mount_state.value));
    const up = issuesMod.devVal(dev, 'uptime_s');
    if (!cpu && !mem && !fsAll.length && !stopped.length && up == null) return null;
    const facts = [];
    const lines = [];
    if (cpu) {
      facts.push({ label: 'CPU', value: fmtPct(cpu.value), tone: cpu.value >= cpuWarn ? 'warn' : 'ok' });
      lines.push(`CPU ${fmtPct(cpu.value)}`);
    }
    if (mem) {
      facts.push({ label: 'Memory', value: fmtPct(mem.value), tone: mem.value >= memWarn ? 'warn' : 'ok' });
      lines.push(`Memory ${fmtPct(mem.value)}`);
    }
    if (fsAll.length) {
      facts.push({ label: 'Filesystems Over Warning', value: `${fsOver.length}/${fsAll.length}`, tone: fsOver.some((f) => f.pct >= crit) ? 'crit' : fsOver.length ? 'warn' : 'ok' });
    }
    for (const f of fsOver.slice(0, 6)) lines.push(`Filesystem ${f.name} ${fmtPct(f.pct)} full (${f.pct >= crit ? 'critical' : 'warning'} at ${f.pct >= crit ? crit : warn}%)`);
    if (fsOver.length > 6) lines.push(`... and ${fsOver.length - 6} more filesystem(s) over ${warn}%`);
    if (stopped.length) {
      facts.push({ label: 'Services Stopped', value: String(stopped.length), tone: 'warn' });
      for (const i of stopped.slice(0, 6)) lines.push(`Service stopped: ${i.name} (state ${i.m.svc_state.value})`);
    }
    for (const i of nfsDown.slice(0, 4)) lines.push(`NFS mount down: ${i.name} (state ${i.m.nfs_mount_state.value})`);
    const upText = fmtUptime(up);
    if (upText) {
      facts.push({ label: 'Uptime', value: upText });
      lines.push(`Uptime ${upText}`);
    }
    return { facts, lines, link: { label: 'Open OS metrics in LogicMonitor', href: `/logicmonitor/devices?device=${d.lm_device_id}` } };
  } catch { return null; }
}

/**
 * Server 360 contribution: LM devices matching the queried server by display
 * name, name, sysname, hostname or any system IP, plus (round 2) the switch
 * ports and reachability checks of the server path. Display-ready per the
 * registry provider contract; never throws.
 */
function server360(coreApi, ctx) {
  try {
    const db = coreApi.db;
    const rows = matchDevices(db, Array.from(ctx?.names || []), Array.from(ctx?.ips || []));
    let pathGroup = null;
    try {
      pathGroup = networkPathGroup(lmEndpoints.serverPath(db, { names: Array.from(ctx?.names || []), ips: Array.from(ctx?.ips || []) }));
    } catch { pathGroup = null; }
    if (!rows.length && !pathGroup) return null;
    if (!rows.length) {
      return {
        title: 'LogicMonitor',
        chip: { label: 'LogicMonitor', color: BRAND },
        groups: [pathGroup],
        link: pathGroup.link,
      };
    }
    const tone = (s) => (s === 'normal' ? 'ok' : s === 'dead' ? 'crit' : s === 'dead-collector' ? 'warn' : undefined);
    const groups = rows.map((d) => {
      const openAlerts = db.prepare('SELECT COUNT(*) n FROM lm_alerts WHERE source_id = ? AND lm_device_id = ? AND cleared = 0 AND duplicate_of IS NULL').get(d.source_id, d.lm_device_id).n;
      const lines = [];
      if (d.sysinfo) lines.push(String(d.sysinfo).slice(0, 160));
      if (d.collector_down) lines.push('Its LogicMonitor collector is down');
      return {
        facts: [
          { label: 'Host Status', value: d.host_status || '-', tone: tone(d.host_status) },
          { label: 'Vendor / Model', value: [d.vendor, d.model].filter(Boolean).join(' ') || '-' },
          { label: 'Version', value: d.version || '-' },
          { label: 'Collector', value: d.collector_hostname || d.collector_desc || (d.collector_id != null ? String(d.collector_id) : '-'), tone: d.collector_down ? 'crit' : undefined },
          { label: 'Open Alerts', value: String(openAlerts), tone: openAlerts ? 'warn' : 'ok' },
          { label: 'Interfaces Up', value: d.if_count ? `${d.if_up || 0}/${d.if_count}` : '-' },
        ],
        lines,
        link: { label: d.display_name || d.name, href: `/logicmonitor/devices?device=${d.lm_device_id}` },
      };
    });
    // Round 9: the device's open, non-duplicate LM alerts as their own group.
    for (const d of rows) {
      const g = alertsGroup(db, d);
      if (g) groups.push(g);
    }
    // Round 11: OS lines (CPU, memory, filesystems, services, uptime) from the os and health families.
    for (const d of rows) {
      const g = osGroup(db, d);
      if (g) groups.push(g);
    }
    if (pathGroup) groups.push(pathGroup);
    return {
      title: 'LogicMonitor',
      chip: { label: 'LogicMonitor', color: BRAND },
      groups,
      link: { label: 'View in LogicMonitor', href: `/logicmonitor/devices?device=${rows[0].lm_device_id}` },
    };
  } catch {
    return null;
  }
}

function server360Suggest(coreApi, q) {
  try {
    const pattern = `%${String(q || '').replace(/[%_]/g, '\\$&')}%`;
    return coreApi.db.prepare(`
      SELECT DISTINCT display_name FROM lm_devices WHERE stale = 0 AND (display_name LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')
      ORDER BY display_name LIMIT 8
    `).all(pattern, pattern).map((r) => r.display_name).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Topology contribution: when the anchor is an LM device, its collector
 * ('monitored-by') and up to 8 neighbour devices from lm_topology_links
 * ('link', labelled "<src_port> - <dst_port>", red when the local interface
 * is down). Network neighbours use type 'switch' and tier 'san' so the
 * existing rank table places them; no frontend edit is needed.
 */
function topology(coreApi, ctx) {
  try {
    const db = coreApi.db;
    const anchorId = ctx?.anchorId;
    if (!anchorId) return null;
    const nodes = [];
    const edges = [];
    const [dev] = matchDevices(db, Array.from(ctx?.names || []), Array.from(ctx?.ips || []), 1);
    if (dev) lmDeviceTopology(db, dev, anchorId, nodes, edges);
    try { serverPathTopology(db, ctx, anchorId, nodes, edges); } catch { /* path is best effort */ }
    return nodes.length ? { nodes, edges } : null;
  } catch {
    return null;
  }
}

/** v1 behaviour: the anchor is an LM device; its collector and neighbours. */
function lmDeviceTopology(db, dev, anchorId, nodes, edges) {
  {
    if (dev.collector_id != null) {
      const id = `lm-collector:${dev.source_id}:${dev.collector_id}`;
      nodes.push({
        id, type: 'collector', tier: 'compute',
        label: dev.collector_hostname || dev.collector_desc || `Collector ${dev.collector_id}`,
        sublabel: 'LogicMonitor collector', route: '/logicmonitor/collectors',
        status: dev.collector_down ? 'crit' : 'ok',
      });
      edges.push({ from: anchorId, to: id, kind: 'monitored-by', label: '', ...(dev.collector_down ? { issue: 'LogicMonitor collector is down', status: 'crit' } : {}) });
    }
    const links = db.prepare(`
      SELECT l.*, i.status_text AS src_status,
        sd.display_name AS src_name, sd.role AS src_role, sd.host_status AS src_host,
        dd.display_name AS dst_display, dd.role AS dst_role, dd.host_status AS dst_host
      FROM lm_topology_links l
      LEFT JOIN lm_interfaces i ON i.source_id = l.source_id AND i.instance_id = l.src_instance_id
      LEFT JOIN lm_devices sd ON sd.source_id = l.source_id AND sd.lm_device_id = l.src_device_id
      LEFT JOIN lm_devices dd ON dd.source_id = l.source_id AND dd.lm_device_id = l.dst_device_id
      WHERE l.source_id = ? AND l.dst_device_id IS NOT NULL AND l.stale = 0 AND (l.src_device_id = ? OR l.dst_device_id = ?)
      LIMIT 8
    `).all(dev.source_id, dev.lm_device_id, dev.lm_device_id);
    const hostTone = (h) => (h === 'normal' ? 'ok' : h === 'dead' ? 'crit' : h ? 'warn' : 'unknown');
    for (const l of links) {
      const outbound = l.src_device_id === dev.lm_device_id;
      const otherId = outbound ? l.dst_device_id : l.src_device_id;
      const otherName = outbound ? (l.dst_display || l.dst_name) : l.src_name;
      const otherRole = outbound ? l.dst_role : l.src_role;
      const otherHost = outbound ? l.dst_host : l.src_host;
      const nodeId = `lm-device:${dev.source_id}:${otherId}`;
      if (!nodes.some((n) => n.id === nodeId)) {
        nodes.push({
          id: nodeId, type: 'switch', tier: 'san',
          label: otherName || `device ${otherId}`, sublabel: otherRole || '',
          route: `/logicmonitor/devices?device=${otherId}`, status: hostTone(otherHost),
        });
      }
      const down = l.src_status === 'down';
      edges.push({
        from: anchorId, to: nodeId, kind: 'link',
        label: [outbound ? l.src_port : l.dst_port, outbound ? l.dst_port : l.src_port].map((p) => p || '?').join(' - '),
        ...(down ? { issue: `Interface ${l.src_port || ''} is down`.trim(), status: 'crit' } : {}),
      });
    }
  }
}

function portEdgeProblem(deviceName, port, statusText, issues, tone) {
  const where = `${deviceName || ''} ${port || ''}`.replace(/\s+/g, ' ').trim();
  if (tone === 'crit') return { status: 'crit', issue: `Switch port ${where} is ${statusText || 'down'}` };
  if (tone === 'warn') {
    const msg = (issues || []).map((i) => i.message).filter(Boolean).join('; ');
    return { status: 'warn', issue: msg || `Switch port ${where} has an open interface issue` };
  }
  return {};
}

/**
 * Round 2 server-object path on the map: each switch port the anchor (a VM
 * through its ESX host) is plugged into becomes an 'uplink' edge to the
 * switch, one hop of switch-to-switch 'link' edges follows, and every check
 * aimed at the anchor is a 'reachability' edge. Red when a port is down,
 * amber on an open utilization, errors or flapping issue; check edges follow
 * the anomaly rule.
 */
function serverPathTopology(db, ctx, anchorId, nodes, edges) {
  const path = lmEndpoints.serverPath(db, { names: Array.from(ctx?.names || []), ips: Array.from(ctx?.ips || []) });
  if (!path.switchPorts.length && !path.checks.length) return;
  const hasNode = (id) => nodes.some((n) => n.id === id);
  const hostStatus = db.prepare('SELECT host_status, role FROM lm_devices WHERE source_id = ? AND lm_device_id = ? ORDER BY stale ASC LIMIT 1');
  const hostTone = (h) => (h === 'normal' ? 'ok' : h === 'dead' ? 'crit' : h ? 'warn' : 'unknown');
  const addSwitch = (sourceId, deviceId, label, sublabel) => {
    const id = `lm-device:${sourceId}:${deviceId}`;
    if (!hasNode(id)) {
      const d = hostStatus.get(sourceId, deviceId) || {};
      nodes.push({
        id, type: 'switch', tier: 'san', label: label || `device ${deviceId}`, sublabel: sublabel || d.role || '',
        route: `/logicmonitor/devices?device=${deviceId}`, status: hostTone(d.host_status),
      });
    }
    return id;
  };
  const from = path.anchor.kind === 'vm' && path.anchor.hostName ? `host:${path.anchor.hostName}` : anchorId;
  for (const p of path.switchPorts) {
    const id = addSwitch(p.sourceId, p.deviceId, p.deviceName, `${p.port || '?'} ${p.statusText || 'unknown'}`);
    edges.push({
      from, to: id, kind: 'uplink',
      label: `${p.nic || '?'} - ${p.port || '?'}`,
      ...portEdgeProblem(p.deviceName, p.port, p.statusText, p.issues, p.tone),
    });
  }
  for (const u of path.uplinks) {
    const fromId = `lm-device:${u.sourceId}:${u.from.deviceId}`;
    const toId = addSwitch(u.sourceId, u.to.deviceId, u.to.deviceName, '');
    const label = `${u.from.port || '?'} - ${u.to.port || '?'}`;
    if (edges.some((e) => e.kind === 'link' && e.label === label && ((e.from === fromId && e.to === toId) || (e.from === toId && e.to === fromId)))) continue;
    edges.push({
      from: fromId, to: toId, kind: 'link', label,
      ...portEdgeProblem(u.from.deviceName, u.from.port, u.statusText, u.issues, u.tone),
    });
  }
  for (const c of path.checks) {
    const id = `lm-check:${c.sourceId}:${c.checkId}`;
    const w = lmEndpoints.worstLocation(c);
    const tone = lmEndpoints.checkTone(w);
    if (!hasNode(id)) {
      nodes.push({
        id, type: 'check', tier: 'compute', label: c.name,
        sublabel: w ? `${w.label} ${fmtNum(w.rttAvgMs, ' ms')} ${fmtNum(w.lossPct, '%')}` : '',
        route: '/logicmonitor/reachability', status: tone,
      });
    }
    let problem = {};
    if (w && (tone === 'crit' || tone === 'warn')) {
      let what;
      if (w.anomaly === 'down' || w.lastStatus === 'down') what = 'down';
      else if (w.anomaly === 'loss') what = `${fmtNum(w.lossPct, '%')} packet loss`;
      else what = `RTT ${fmtNum(w.rttAvgMs, ' ms')}${w.baselineRttMs != null ? ` (baseline ${fmtNum(w.baselineRttMs, ' ms')})` : ''}`;
      problem = { status: tone, issue: `${c.name} from ${w.label}: ${what}` };
    }
    edges.push({ from: anchorId, to: id, kind: 'reachability', label: w ? w.label : '', ...problem });
  }
}

// ---- Ops Agent seams (round 3) --------------------------------------------------

const isoShort = (v) => (v ? new Date(v).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '');
const epochShort = (sec) => (sec ? isoShort(Number(sec) * 1000) : '');

/** Site rollup lines straight from the tables (devices, interfaces, circuits, collectors). */
function siteLines(db, siteKey) {
  const lines = [];
  const rows = db.prepare('SELECT source_id, site_name FROM lm_sites WHERE site_key = ?').all(siteKey);
  for (const st of rows) {
    const dev = db.prepare(`
      SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN host_status = 'normal' THEN 1 ELSE 0 END), 0) normal,
        COALESCE(SUM(CASE WHEN host_status = 'dead' THEN 1 ELSE 0 END), 0) dead
      FROM lm_devices WHERE source_id = ? AND site_key = ? AND stale = 0
    `).get(st.source_id, siteKey);
    const ifd = db.prepare(`
      SELECT COUNT(*) n FROM lm_interfaces i JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
      WHERE d.source_id = ? AND d.site_key = ? AND d.stale = 0 AND i.stale = 0 AND i.status_text = 'down' AND COALESCE(i.stop_monitoring, 0) = 0
    `).get(st.source_id, siteKey).n;
    lines.push(`Site ${st.site_name || siteKey}: ${dev.normal}/${dev.total} devices normal, ${dev.dead} dead, ${ifd} interface(s) down, ${require('../../services/logicmonitorLinks').siteInterfaceAlertCount(db, st.source_id, siteKey)} open LM interface alerts`);
    for (const c of lmPath.circuitRows(db, { sourceId: st.source_id, siteKey })) {
      lines.push(`Circuit ${c.deviceName} ${c.port}: ${c.state}, ${c.statusText}, p95 in ${c.p95InPct ?? '-'}% out ${c.p95OutPct ?? '-'}%`);
    }
    for (const c of db.prepare('SELECT hostname, description, is_down FROM lm_collectors WHERE source_id = ? AND site_key = ? AND stale = 0').all(st.source_id, siteKey)) {
      lines.push(`Collector ${c.hostname || c.description}: ${Number(c.is_down) === 1 ? 'DOWN' : 'up'}`);
    }
  }
  return lines;
}

/**
 * "Probe location <loc>: N of M checks elevated (K critical), median 1.3x" for each open
 * location-latency issue that touches the incident: the location is the incident's host, one of
 * the incident's checks is elevated from it, or the location is probed by a collector at the site.
 */
function probeLocationLines(db, names, siteKey) {
  const open = db.prepare("SELECT target, message FROM lm_issue_history WHERE status = 'open' AND type = 'location-latency'").all();
  if (!open.length) return [];
  // A check host label is "<check> @ <location>"; the check part is what the episodes are matched on.
  const lowNames = names.map((n) => String(n).toLowerCase()).map((n) => (n.includes(' @ ') ? n.slice(0, n.lastIndexOf(' @ ')) : n));
  const epStmt = db.prepare("SELECT 1 FROM lm_latency_episodes WHERE subject_kind = 'check' AND state IN ('watching', 'degrading', 'critical') AND instr(lower(subject_label), ?) > 0 LIMIT 1");
  const collStmt = db.prepare(`
    SELECT 1 FROM lm_check_locations l JOIN lm_collectors c ON c.source_id = l.source_id AND c.collector_id = l.collector_id
    WHERE l.label = ? AND l.stale = 0 AND c.site_key = ? LIMIT 1
  `);
  const out = [];
  for (const o of open) {
    const loc = String(o.target || '');
    let touches = lowNames.includes(loc.toLowerCase());
    if (!touches) {
      for (const n of lowNames) {
        if (epStmt.get(`${n} @ ${loc.toLowerCase()}`)) { touches = true; break; }
      }
    }
    if (!touches && siteKey) { try { touches = !!collStmt.get(loc, siteKey); } catch { /* no collectors */ } }
    if (!touches) continue;
    const m = /^(\d+) of (\d+) checks probed from .* are elevated now \((\d+) critical(?:, median peak ([\d.]+)x)?\)/.exec(String(o.message || ''));
    out.push(m
      ? `Probe location ${loc}: ${m[1]} of ${m[2]} checks elevated (${m[3]} critical)${m[4] ? `, median ${m[4]}x` : ''}`
      : `Probe location ${loc}: several checks elevated`);
  }
  return out.slice(0, 4);
}

/**
 * Network evidence for one incident (the Ops Agent seam): the likely hop
 * first, then the device, its open LM alerts (shadowed ones counted), switch
 * ports and path hops, reachability checks, scheduled downtime, config
 * changes in the last 24 h and the site rollup. {title, lines[]} or null.
 * Never throws; every line is derived from stored rows.
 */
function incidentEvidence(coreApi, ctx) {
  try {
    const db = coreApi.db;
    const names = Array.from(ctx?.names || []).filter(Boolean);
    const ips = Array.from(ctx?.ips || []).filter(Boolean);
    const anchor = { names, ips };
    const pctx = lmPath.makeContext(db);
    const lines = [];
    const path = lmPath.pathFor(db, anchor, { ctx: pctx });
    const b = lmPath.blame(path);
    if (b) lines.push(`Likely hop:${lmPath.likelyHopText(b).replace(/^ Likely hop:/, '')}`);
    if (b && b.state !== 'ok') {
      // Blame history (round 4): one row per server subject and hop per hour, same rule as GET /server-path.
      try {
        const subject = names[0] || ips[0] || null;
        require('../../services/logicmonitorCorrelation').recordBlame(db, {
          sourceId: b.sourceId, kind: 'server', subject, subjectKey: subject ? String(subject).toLowerCase() : null,
          blame: b, siteKey: b.siteKey || null, dedupeSince: new Date(Date.now() - 3600000).toISOString().replace('T', ' ').slice(0, 19),
        });
      } catch (e) { /* evidence must never fail on history */ }
    }

    const [dev] = matchDevices(db, names, ips, 1);
    if (dev) {
      lines.push(`Device ${dev.display_name || dev.name}: host status ${dev.host_status || 'unknown'}${dev.collector_hostname || dev.collector_desc ? `, collector ${dev.collector_hostname || dev.collector_desc}${dev.collector_down ? ' (DOWN)' : ''}` : ''}${dev.site_name ? `, site ${dev.site_name}` : ''}`);
      lines.push(...require('../../services/logicmonitorLinks').deviceInterfaceLines(db, dev));
    }
    const siteKey = ctx?.siteKey || (lmSites.siteOf(db, anchor) || {}).siteKey || null;
    // Agent signals: estate-wide link burst and the probe locations that touch this incident.
    try {
      const burst = require('../../services/logicmonitorLinks').estateBurstLine(db);
      if (burst) lines.push(burst);
      lines.push(...probeLocationLines(db, names, siteKey));
    } catch { /* signals are best effort */ }
    if (dev) {
      const open = db.prepare(`
        SELECT severity_norm, resource_template_name, instance_name, data_point_name, alert_value, start_epoch, shadowed_by
        FROM lm_alerts WHERE source_id = ? AND lm_device_id = ? AND cleared = 0 AND duplicate_of IS NULL ORDER BY severity DESC, start_epoch
      `).all(dev.source_id, dev.lm_device_id);
      const live = open.filter((a) => !a.shadowed_by);
      for (const a of live.slice(0, 8)) {
        lines.push(`LM alert ${a.severity_norm}: ${[a.resource_template_name, a.instance_name, a.data_point_name].filter(Boolean).join(' ')} = ${a.alert_value ?? '-'} since ${epochShort(a.start_epoch)}`);
      }
      if (live.length > 8) lines.push(`... and ${live.length - 8} more open LM alert(s) on this device`);
      if (open.length - live.length) lines.push(`${open.length - live.length} further LM alert(s) on this device are shadowed by an upstream failure`);
      // Long-term history (decision 7): two lines, each omitted when its table has no rows for the device.
      try {
        const hist = require('../../services/logicmonitorHistory');
        const base = hist.cpuMemBaseline(db, dev.source_id, dev.lm_device_id, 30);
        if (base) {
          const pc = (v) => (v == null ? '-' : `${Math.round(v)}%`);
          lines.push(`30-day baseline: CPU avg ${pc(base.cpuAvg)} max ${pc(base.cpuMax)}, memory avg ${pc(base.memAvg)} max ${pc(base.memMax)} (${base.days} days)`);
        }
        const dd = hist.deviceDailyRows(db, dev.source_id, dev.lm_device_id, 30);
        if (dd.rows.length) {
          const sm = dd.summary;
          lines.push(`Last 30 days: dead on ${sm.daysDead} days, in SDT on ${sm.daysInSdt} days, ${sm.alertsOpened} alerts opened (${sm.alertsCritical} critical)`);
        }
      } catch (e) { /* evidence must never fail on history */ }
    }
    const sp = require('../../services/logicmonitorEndpoints').serverPath(db, anchor, { endpoints: pctx.endpoints() });
    for (const p of sp.switchPorts.slice(0, 6)) {
      lines.push(`Switch port ${p.deviceName} ${p.port}: ${p.statusText}, in ${p.inUtilPct ?? '-'}% out ${p.outUtilPct ?? '-'}%${p.nic ? ` (${p.nic})` : ''}`);
    }
    for (const h of path.slice(0, 12)) {
      if (h.health.state !== 'ok') lines.push(`Path hop ${h.hopIndex + 1} ${h.deviceName}: ${h.health.state}, ${h.health.reason}`);
    }
    for (const c of sp.checks.slice(0, 6)) {
      const w = require('../../services/logicmonitorEndpoints').worstLocation(c);
      lines.push(w
        ? `Reachability ${c.name} from ${w.label}: ${fmtNum(w.rttAvgMs, ' ms')}, ${fmtNum(w.lossPct, '%')} loss (${w.anomaly || 'ok'})`
        : `Reachability ${c.name}: no locations reported`);
    }
    for (const d of lmPath.sdtLookup(db, anchor, { siteKey, ctx: pctx }).slice(0, 6)) {
      lines.push(`Scheduled downtime (${d.scope}) ${d.name}${d.until ? ` until ${isoShort(d.until)}` : ''}${d.comment ? `: ${d.comment}` : ''}`);
    }
    try {
      const target = dev ? (dev.display_name || dev.name) : names[0];
      if (target) {
        const changes = require('../../services/configLedger').listChanges({ days: 1, platform: 'logicmonitor', q: target, limit: 5 });
        for (const c of changes) lines.push(`Config change ${isoShort(c.detected_at)} ${c.scope} ${c.item}: ${String(c.old_value ?? '-').slice(0, 80)} -> ${String(c.new_value ?? '-').slice(0, 80)}`);
      }
    } catch { /* ledger unavailable */ }
    if (siteKey) lines.push(...siteLines(db, siteKey));
    // Round 13: WAN picture of the site (a site with one WAN up is degraded, not down).
    if (siteKey) lines.push(...require('../../services/logicmonitorCircuits').siteCircuitEvidence(db, siteKey));
    try {
      const eps = require('../../services/logicmonitorWatch').watchLines(db, { names: [...names, dev && (dev.display_name || dev.name)].filter(Boolean), siteKey, days: 30, max: 6 });
      lines.push(...eps.lines);
    } catch { /* episode history is best effort */ }
    let title = 'LogicMonitor network';
    if (!names.length && siteKey) {
      // Site-only context: a distinct title so the agent's dedup keeps it beside a host block.
      let siteName = null;
      try { siteName = (db.prepare('SELECT site_name FROM lm_sites WHERE site_key = ? LIMIT 1').get(siteKey) || {}).site_name || null; } catch { /* no sites table */ }
      title = `LogicMonitor site ${siteName || siteKey}`;
    }
    return lines.length ? { title, lines: lines.slice(0, 60) } : null;
  } catch {
    return null;
  }
}

/** Site of any host name or ip, for the Ops Agent's site grouping. */
function siteOf(coreApi, ctx) {
  try {
    const r = lmSites.siteOf(coreApi.db, { names: Array.from(ctx?.names || []), ips: Array.from(ctx?.ips || []) });
    return r ? { siteKey: r.siteKey, siteName: r.siteName, sourceId: r.sourceId } : null;
  } catch {
    return null;
  }
}

// Capabilities for the Operations Agent. The first four are database only;
// lm_ds_data is the one deep-pass platform-API read. The agent registers pack capabilities
// as <pack id>:<id> and runs them against incident targets of this platform.
const lmDb = () => require('../../db/database');
const targetAnchor = (target) => ({ names: [target && target.name].filter(Boolean), ips: [target && target.address].filter((a) => a && /^\d{1,3}(\.\d{1,3}){3}$/.test(a)) });

const agentCapabilities = [
  {
    id: 'lm_port_history',
    label: 'Port history (last hour)',
    description: 'Reads ICC\'s stored LogicMonitor samples for the switch ports the host is plugged into: the last 60 minutes of status, utilization and errors, with the baseline for this hour. Database only, no network call.',
    platform: '*',
    risk: 'read-only',
    defaultEnabled: true,
    run(target) {
      const r = lmPath.portHistoryText(lmDb(), targetAnchor(target));
      return { ok: r.ports > 0, summary: r.text, data: { ports: r.ports } };
    },
  },
  {
    id: 'lm_sdt_lookup',
    label: 'Scheduled downtime lookup',
    description: 'Checks the stored LogicMonitor scheduled downtime for the device, the switches it uses and its site. Database only.',
    platform: '*',
    risk: 'read-only',
    defaultEnabled: true,
    run(target) {
      const db = lmDb();
      const anchor = targetAnchor(target);
      const site = lmSites.siteOf(db, anchor);
      const found = lmPath.sdtLookup(db, anchor, { siteKey: site ? site.siteKey : null });
      if (!found.length) return { ok: true, summary: 'no scheduled downtime', data: { effective: 0 } };
      const text = found.slice(0, 5).map((d) => `${d.scope} ${d.name}: in maintenance until ${d.until ? isoShort(d.until) : 'further notice'} (${d.comment || 'no comment'})`).join('; ');
      return { ok: true, summary: text, data: { effective: found.length } };
    },
  },
  {
    id: 'lm_path_blame',
    label: 'Network path and likely hop',
    description: 'Builds the network path from the host to the WAN edge from stored LogicMonitor topology and names the first unhealthy hop. Database only.',
    platform: '*',
    risk: 'read-only',
    defaultEnabled: true,
    run(target) {
      const path = lmPath.pathFor(lmDb(), targetAnchor(target));
      return { ok: path.length > 0, summary: lmPath.pathText(path), data: { hops: path.length, blame: lmPath.blame(path) } };
    },
  },
  {
    id: 'lm_latency_watch',
    label: 'Latency episode history',
    description: 'Reads ICC\'s stored latency watch episodes (30 days) for the check, host or site of the incident: how many spikes, how they ended, how long they ran and which hop was blamed. Database only, no network call.',
    platform: '*',
    risk: 'read-only',
    defaultEnabled: true,
    run(target) {
      const db = lmDb();
      const anchor = targetAnchor(target);
      const site = target && target.siteKey ? { siteKey: target.siteKey } : lmSites.siteOf(db, anchor);
      const found = require('../../services/logicmonitorWatch').watchLines(db, {
        names: [target && target.name].filter(Boolean), siteKey: site ? site.siteKey : null, days: 30, max: 6,
      });
      if (!found.lines.length) return { ok: true, summary: 'no latency episodes in the last 30 days', data: { episodes: 0 } };
      return { ok: true, summary: found.lines.join('; '), data: { episodes: found.lines.length, scope: found.scope } };
    },
  },
  {
    id: 'lm_ds_data',
    label: 'LogicMonitor datasource data (live)',
    description: 'Asks LogicMonitor for the last hour of raw datapoints of the datasource that is alerting on the host, using the stored portal connection. One read call, deep pass only.',
    platform: '*',
    risk: 'platform-api',
    defaultEnabled: false,
    timeoutMs: 8000,
    deepOnly: true,
    async run(target, ctx) {
      const db = lmDb();
      const names = [target && target.name, target && target.address].filter(Boolean).map((n) => String(n).toLowerCase());
      if (!names.length) return { ok: false, summary: 'no LogicMonitor device matches the target', data: null };
      const marks = names.map(() => '?').join(', ');
      const dev = db.prepare(`SELECT source_id, lm_device_id, display_name FROM lm_devices WHERE stale = 0 AND (LOWER(name) IN (${marks}) OR LOWER(display_name) IN (${marks})) ORDER BY id LIMIT 1`).get(...names, ...names);
      if (!dev) return { ok: false, summary: 'no LogicMonitor device matches the target', data: null };
      const source = db.prepare('SELECT * FROM lm_sources WHERE id = ?').get(dev.source_id);
      if (!source) return { ok: false, summary: 'the LogicMonitor portal row is gone', data: null };
      // lm_alerts carries no hds_id. The join to lm_device_datasources is by
      // NAME: alert resource_template_name = datasource_name (inferred from the
      // LM data model, not verified against a live portal).
      const open = db.prepare('SELECT resource_template_name AS name FROM lm_alerts WHERE source_id = ? AND lm_device_id = ? AND cleared = 0 AND resource_template_name IS NOT NULL ORDER BY start_epoch DESC').all(dev.source_id, dev.lm_device_id);
      let hds = null;
      for (const a of open) {
        hds = db.prepare('SELECT hds_id, datasource_name FROM lm_device_datasources WHERE source_id = ? AND lm_device_id = ? AND datasource_name = ? LIMIT 1').get(dev.source_id, dev.lm_device_id, a.name);
        if (hds) break;
      }
      if (!hds) hds = db.prepare("SELECT hds_id, datasource_name FROM lm_device_datasources WHERE source_id = ? AND lm_device_id = ? AND LOWER(datasource_name) LIKE '%cpu%' ORDER BY hds_id LIMIT 1").get(dev.source_id, dev.lm_device_id);
      if (!hds) return { ok: false, summary: `no datasource row for ${dev.display_name}`, data: null };

      const nowSec = Math.floor(Date.now() / 1000);
      const firsts = ((ctx && ctx.alerts) || []).map((a) => Date.parse(String(a.first_seen || '').replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(a.first_seen || '')) ? '' : 'Z'))).filter(Number.isFinite);
      const onsetSec = firsts.length ? Math.floor(Math.min(...firsts) / 1000) : nowSec;
      const start = Math.min(onsetSec, nowSec) - 3600;
      const body = await require('../../services/logicmonitorApi').fetchDsData(source, dev.lm_device_id, hds.hds_id, { start, end: nowSec });

      const d = body && typeof body === 'object' && body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : body;
      const points = d && Array.isArray(d.dataPoints) ? d.dataPoints : null;
      let rows = null;
      if (d && Array.isArray(d.values)) rows = d.values;
      else if (d && d.values && typeof d.values === 'object') rows = [].concat(...Object.values(d.values).filter(Array.isArray));
      if (!points || !rows) {
        const keys = d && typeof d === 'object' ? Object.keys(d).slice(0, 12).join(', ') : typeof d;
        return { ok: false, summary: `LogicMonitor answered in a shape ICC does not read (top-level keys: ${keys})`, data: { keys } };
      }
      const lines = [];
      for (let k = 0; k < points.length && lines.length < 8; k += 1) {
        const vals = rows.map((r) => (Array.isArray(r) ? Number(r[k]) : NaN)).filter((v) => Number.isFinite(v));
        if (!vals.length) continue;
        const f = (v) => Math.round(v * 100) / 100;
        lines.push(`${String(points[k]).slice(0, 60)}: last ${f(vals[vals.length - 1])}, min ${f(Math.min(...vals))}, max ${f(Math.max(...vals))} over the window`);
      }
      if (!lines.length) return { ok: false, summary: `${hds.datasource_name} returned no numeric samples in the last hour`, data: { lines: [] } };
      return { ok: true, summary: `${hds.datasource_name} on ${dev.display_name}: ${lines.length} datapoint(s) read`, data: { datasource: hds.datasource_name, lines } };
    },
  },
];

const searchCategories = [
  {
    key: 'lm-devices', label: 'LogicMonitor Devices', platform: 'logicmonitor', perm: 'logicmonitor:devices:view', base: '/logicmonitor',
    sql: `SELECT d.display_name AS title, (COALESCE(d.vendor, '') || ' ' || COALESCE(d.role, '') || ' ' || COALESCE(d.host_status, '')) AS subtitle FROM lm_devices d
          WHERE d.stale = 0 AND (d.display_name LIKE ? ESCAPE '\\' OR d.name LIKE ? ESCAPE '\\') ORDER BY d.display_name LIMIT ?`,
    params: 2,
  },
  {
    key: 'lm-interfaces', label: 'LogicMonitor Interfaces', platform: 'logicmonitor', perm: 'logicmonitor:interfaces:view', base: '/logicmonitor',
    sql: `SELECT (COALESCE(d.display_name, '') || ' ' || COALESCE(i.display_name, '')) AS title, (COALESCE(i.description, '') || ' ' || COALESCE(i.status_text, '')) AS subtitle
          FROM lm_interfaces i LEFT JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
          WHERE i.stale = 0 AND (i.display_name LIKE ? ESCAPE '\\' OR i.description LIKE ? ESCAPE '\\') ORDER BY title LIMIT ?`,
    params: 2,
  },
  {
    key: 'lm-firewalls', label: 'LogicMonitor Firewalls', platform: 'logicmonitor', perm: 'logicmonitor:firewalls:view', base: '/logicmonitor',
    sql: `SELECT d.display_name AS title, (COALESCE(d.vendor, '') || ' ' || COALESCE(d.model, '') || ' ' || COALESCE(d.version, '')) AS subtitle FROM lm_devices d
          WHERE d.stale = 0 AND (d.role = 'firewall' OR d.vendor LIKE 'Palo Alto%') AND (d.display_name LIKE ? ESCAPE '\\' OR d.model LIKE ? ESCAPE '\\') ORDER BY d.display_name LIMIT ?`,
    params: 2,
  },
  {
    key: 'lm-load-balancers', label: 'LogicMonitor Load Balancers', platform: 'logicmonitor', perm: 'logicmonitor:load-balancers:view', base: '/logicmonitor',
    sql: `SELECT d.display_name AS title, (COALESCE(d.vendor, '') || ' ' || COALESCE(d.model, '') || ' ' || COALESCE(d.version, '')) AS subtitle FROM lm_devices d
          WHERE d.stale = 0 AND (d.role = 'load-balancer' OR d.vendor = 'F5') AND (d.display_name LIKE ? ESCAPE '\\' OR d.model LIKE ? ESCAPE '\\') ORDER BY d.display_name LIMIT ?`,
    params: 2,
  },
  {
    key: 'lm-collectors', label: 'LogicMonitor Collectors', platform: 'logicmonitor', perm: 'logicmonitor:collectors:view', base: '/logicmonitor',
    sql: `SELECT c.hostname AS title, (COALESCE(c.description, '') || ' build ' || COALESCE(c.build, '')) AS subtitle FROM lm_collectors c
          WHERE c.stale = 0 AND (c.hostname LIKE ? ESCAPE '\\' OR c.description LIKE ? ESCAPE '\\') ORDER BY c.hostname LIMIT ?`,
    params: 2,
  },
  {
    key: 'lm-checks', label: 'LogicMonitor Checks', platform: 'logicmonitor', perm: 'logicmonitor:reachability:view', base: '/logicmonitor',
    sql: `SELECT c.name AS title, (COALESCE(c.kind, '') || ' ' || COALESCE(c.target, '')) AS subtitle FROM lm_checks c
          WHERE c.stale = 0 AND (c.name LIKE ? ESCAPE '\\' OR c.target LIKE ? ESCAPE '\\') ORDER BY c.name LIMIT ?`,
    params: 2,
  },
];

module.exports = {
  id: 'logicmonitor',
  name: 'LogicMonitor',
  apiVersion: 1,
  color: BRAND,
  migrations: lmMigrations,
  createRouter() {
    return require('../../routes/logicmonitor');
  },
  createPoller() {
    return createLogicmonitorPollerHandle();
  },
  statusTables: ['lm_sources'],
  settingsFields: [],
  navSections: ['overview', 'reachability', 'sites', 'alerts', 'issues', 'devices', 'interfaces', 'circuits', 'firewalls', 'load-balancers', 'voice', 'zscaler', 'ise', 'applications', 'metrics', 'collectors', 'governance', 'trends', 'advisor', 'privacy', 'settings'],
  // Dataset tables are views named logicmonitor_* (migration v1): the dataset
  // catalog requires the '<platform id>_' prefix, the data lives in lm_*.
  datasets: [
    {
      id: 'logicmonitor.devices',
      label: 'LogicMonitor Devices',
      table: 'logicmonitor_devices',
      section: 'devices',
      defaultSort: 'display_name',
      columns: [
        { key: 'display_name', label: 'Device', type: 'string', filterable: true },
        { key: 'vendor', label: 'Vendor', type: 'enum', filterable: true },
        { key: 'role', label: 'Role', type: 'enum', filterable: true },
        { key: 'model', label: 'Model', type: 'enum', filterable: true },
        { key: 'version', label: 'Version', type: 'enum', filterable: true },
        { key: 'host_status', label: 'Host Status', type: 'enum', filterable: true },
        { key: 'if_count', label: 'Interfaces', type: 'number', aggregatable: true },
        { key: 'if_up', label: 'Interfaces Up', type: 'number', aggregatable: true },
        { key: 'first_seen', label: 'First Seen', type: 'datetime' },
      ],
    },
    {
      id: 'logicmonitor.interfaces',
      label: 'LogicMonitor Interfaces',
      table: 'logicmonitor_interfaces',
      section: 'interfaces',
      defaultSort: 'device_name',
      columns: [
        { key: 'device_name', label: 'Device', type: 'string', filterable: true },
        { key: 'display_name', label: 'Interface', type: 'string', filterable: true },
        { key: 'description', label: 'Description', type: 'string', filterable: true },
        { key: 'status_text', label: 'Status', type: 'enum', filterable: true },
        { key: 'speed_bps', label: 'Speed (bps)', type: 'number', aggregatable: true },
        { key: 'in_mbps', label: 'In (Mbps)', type: 'number', aggregatable: true },
        { key: 'out_mbps', label: 'Out (Mbps)', type: 'number', aggregatable: true },
        { key: 'in_util_pct', label: 'In Util (%)', type: 'number', aggregatable: true },
        { key: 'out_util_pct', label: 'Out Util (%)', type: 'number', aggregatable: true },
        { key: 'in_errors', label: 'In Errors', type: 'number', aggregatable: true },
        { key: 'out_errors', label: 'Out Errors', type: 'number', aggregatable: true },
      ],
    },
    {
      id: 'logicmonitor.alerts',
      label: 'LogicMonitor Alerts',
      table: 'logicmonitor_alerts',
      section: 'alerts',
      defaultSort: 'start_epoch',
      columns: [
        { key: 'monitor_object_name', label: 'Object', type: 'string', filterable: true },
        { key: 'severity_norm', label: 'Severity', type: 'enum', filterable: true },
        { key: 'resource_template_name', label: 'DataSource', type: 'enum', filterable: true },
        { key: 'instance_name', label: 'Instance', type: 'string', filterable: true },
        { key: 'data_point_name', label: 'Datapoint', type: 'enum', filterable: true },
        { key: 'alert_value', label: 'Value', type: 'string' },
        { key: 'start_epoch', label: 'Started (epoch s)', type: 'number' },
        { key: 'acked', label: 'Acked', type: 'number', filterable: true },
        { key: 'cleared', label: 'Cleared', type: 'number', filterable: true },
      ],
    },
    {
      id: 'logicmonitor.checks',
      label: 'LogicMonitor Site Reachability',
      table: 'logicmonitor_checks',
      section: 'reachability',
      defaultSort: 'check_name',
      columns: [
        { key: 'check_name', label: 'Check', type: 'string', filterable: true },
        { key: 'kind', label: 'Kind', type: 'enum', filterable: true },
        { key: 'target', label: 'Target', type: 'string', filterable: true },
        { key: 'label', label: 'Location', type: 'string', filterable: true },
        { key: 'last_status', label: 'Status', type: 'enum', filterable: true },
        { key: 'last_rtt_ms', label: 'RTT (ms)', type: 'number', aggregatable: true },
        { key: 'last_loss_pct', label: 'Loss (%)', type: 'number', aggregatable: true },
        { key: 'last_response_ms', label: 'Response (ms)', type: 'number', aggregatable: true },
      ],
    },
  ],
  opsSummary,
  collectAlerts,
  searchCategories,
  metricsHistory: { arraysTable: 'lm_sources', metricsTable: 'lm_metrics_history', arrayIdColumn: 'source_id' },
  server360,
  server360Suggest,
  matchDevices,
  openAlertsOf,
  topology,
  incidentEvidence,
  siteOf,
  agentCapabilities,
};
