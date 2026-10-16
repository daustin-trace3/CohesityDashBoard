// LogicMonitor platform manifest (ICC contract). Manifest-hooks built-in, the
// EON model: opsSummary, collectAlerts, searchCategories, metricsHistory,
// server360 and topology are wired through backend/core/registry.js. LM is a
// SaaS portal: platform red means the portal API is unreachable, consistent
// with the 2026-09-17 Service Status rule. The router (routes/logicmonitor.js)
// carries sources, data, governance, config and the advisor routes. Brand
// colour is a placeholder until Doug supplies the logo.
const lmMigrations = require('../../db/migrations/logicmonitor');
const { createLogicmonitorPollerHandle } = require('../../services/logicmonitorPoller');
const { computeIssues, isShadowedIssue, shadowedAlertCounts } = require('../../services/logicmonitorIssues');
const lmPath = require('../../services/logicmonitorPath');
const lmSites = require('../../services/logicmonitorSites');
const lmEndpoints = require('../../services/logicmonitorEndpoints');

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
  const openAlerts = db.prepare('SELECT COUNT(*) n FROM lm_alerts WHERE cleared = 0').get().n;
  const collectorsDown = db.prepare('SELECT COUNT(*) n FROM lm_collectors WHERE stale = 0 AND is_down = 1').get().n;
  const latest = db.prepare(`
    SELECT COALESCE(SUM(checks_degraded), 0) + COALESCE(SUM(checks_down), 0) n FROM lm_metrics_history m
    WHERE m.id IN (SELECT MAX(id) FROM lm_metrics_history GROUP BY source_id)
  `).get().n;

  const issues = computeIssues();
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
    FROM lm_alerts WHERE cleared = 0 AND COALESCE(sdted, 0) = 0 AND severity >= 3 AND shadowed_by IS NULL
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
  return [...issues, ...seen.values()];
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
      const openAlerts = db.prepare('SELECT COUNT(*) n FROM lm_alerts WHERE source_id = ? AND lm_device_id = ? AND cleared = 0').get(d.source_id, d.lm_device_id).n;
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
    lines.push(`Site ${st.site_name || siteKey}: ${dev.normal}/${dev.total} devices normal, ${dev.dead} dead, ${ifd} interface(s) down`);
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
      const open = db.prepare(`
        SELECT severity_norm, resource_template_name, instance_name, data_point_name, alert_value, start_epoch, shadowed_by
        FROM lm_alerts WHERE source_id = ? AND lm_device_id = ? AND cleared = 0 ORDER BY severity DESC, start_epoch
      `).all(dev.source_id, dev.lm_device_id);
      const live = open.filter((a) => !a.shadowed_by);
      for (const a of live.slice(0, 8)) {
        lines.push(`LM alert ${a.severity_norm}: ${[a.resource_template_name, a.instance_name, a.data_point_name].filter(Boolean).join(' ')} = ${a.alert_value ?? '-'} since ${epochShort(a.start_epoch)}`);
      }
      if (live.length > 8) lines.push(`... and ${live.length - 8} more open LM alert(s) on this device`);
      if (open.length - live.length) lines.push(`${open.length - live.length} further LM alert(s) on this device are shadowed by an upstream failure`);
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
    const siteKey = ctx?.siteKey || (lmSites.siteOf(db, anchor) || {}).siteKey || null;
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
    try {
      const eps = require('../../services/logicmonitorWatch').watchLines(db, { names: [...names, dev && (dev.display_name || dev.name)].filter(Boolean), siteKey, days: 30, max: 6 });
      lines.push(...eps.lines);
    } catch { /* episode history is best effort */ }
    if (siteKey) lines.push(...siteLines(db, siteKey));
    return lines.length ? { title: 'LogicMonitor network', lines: lines.slice(0, 46) } : null;
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

// Capabilities for the Operations Agent. Database only: none of them touches
// the network or the LogicMonitor API. The agent registers pack capabilities
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
  navSections: ['overview', 'reachability', 'sites', 'alerts', 'issues', 'devices', 'interfaces', 'circuits', 'firewalls', 'load-balancers', 'metrics', 'collectors', 'governance', 'trends', 'advisor', 'privacy', 'settings'],
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
  topology,
  incidentEvidence,
  siteOf,
  agentCapabilities,
};
