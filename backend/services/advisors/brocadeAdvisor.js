const db = require('../../db/database');
const { createPlatformAdvisor } = require('../platformAdvisor');
const {
  computeIssues, healthWarnScore, healthCritScore, certWarnDays, eventStormCount,
} = require('../brocadeIssues');
const { lifecycleFor } = require('../brocadeFosLifecycle');

function parseZoneCount(memberZones) {
  try {
    const arr = JSON.parse(memberZones || '[]');
    return Array.isArray(arr) ? arr.length : null;
  } catch { return null; }
}

function gatherFabricHealth() {
  const fabrics = db.prepare(`
    SELECT name, status, health, switch_count, active_zoneset_name
    FROM brocade_fabrics WHERE stale = 0 ORDER BY name
  `).all();

  const healthScoreByFabric = db.prepare(`
    SELECT fabric_name, MIN(score) minScore, AVG(score) avgScore, COUNT(*) n
    FROM brocade_health_scores WHERE stale = 0 AND score IS NOT NULL
    GROUP BY fabric_name ORDER BY fabric_name
  `).all().map((r) => ({
    fabric: r.fabric_name, minScore: r.minScore,
    avgScore: r.avgScore != null ? Math.round(r.avgScore) : null, count: r.n,
  }));

  const lowestSwitchScores = db.prepare(`
    SELECT entity_name AS switchName, fabric_name AS fabric, score, status
    FROM brocade_health_scores WHERE stale = 0 AND entity_type = 'SWITCH' AND score IS NOT NULL
    ORDER BY score ASC LIMIT 10
  `).all();

  const switchesByFabric = db.prepare(`
    SELECT fabric_name,
      COUNT(*) total,
      SUM(CASE WHEN UPPER(COALESCE(operational_status,'')) = 'HEALTHY' THEN 1 ELSE 0 END) healthy,
      SUM(CASE WHEN UPPER(COALESCE(operational_status,'')) = 'MARGINAL' THEN 1 ELSE 0 END) marginal,
      SUM(CASE WHEN UPPER(COALESCE(operational_status,'')) = 'CRITICAL' THEN 1 ELSE 0 END) critical,
      SUM(CASE WHEN is_missing = 1 THEN 1 ELSE 0 END) unreachable
    FROM brocade_switches WHERE stale = 0 GROUP BY fabric_name ORDER BY fabric_name
  `).all();

  const issues = computeIssues();
  const bySeverity = { critical: 0, warning: 0, info: 0 };
  const byType = {};
  for (const i of issues) {
    bySeverity[i.severity] = (bySeverity[i.severity] || 0) + 1;
    byType[i.type] = (byType[i.type] || 0) + 1;
  }
  const topIssues = issues.slice(0, 20).map((i) => ({
    type: i.type, severity: i.severity, source: i.source, target: i.target, message: i.message,
  }));

  return {
    generatedAt: new Date().toISOString(),
    fabrics,
    healthScoreByFabric,
    lowestSwitchScores,
    switchesByFabric,
    issues: {
      countsBySeverity: bySeverity,
      countsByType: byType,
      top: topIssues,
      thresholds: { healthWarnScore: healthWarnScore(), healthCritScore: healthCritScore() },
    },
    note: fabrics.length === 0 ? 'No Brocade fabrics discovered yet.' : undefined,
  };
}

function gatherSwitchLifecycle() {
  const firmwareByModel = db.prepare(`
    SELECT model, firmware_version, COUNT(*) n
    FROM brocade_switches WHERE stale = 0 AND model IS NOT NULL AND firmware_version IS NOT NULL
    GROUP BY model, firmware_version ORDER BY model, n DESC
  `).all();
  const modelVersions = new Map();
  for (const r of firmwareByModel) {
    if (!modelVersions.has(r.model)) modelVersions.set(r.model, new Set());
    modelVersions.get(r.model).add(r.firmware_version);
  }
  const modelDrift = [...modelVersions.entries()]
    .filter(([, versions]) => versions.size > 1)
    .map(([model, versions]) => ({ model, versions: [...versions] }));

  const firmwareByFabric = db.prepare(`
    SELECT fabric_name, firmware_version, COUNT(*) n
    FROM brocade_switches WHERE stale = 0 AND fabric_name IS NOT NULL AND firmware_version IS NOT NULL
    GROUP BY fabric_name, firmware_version ORDER BY fabric_name, n DESC
  `).all();
  const fabricVersions = new Map();
  for (const r of firmwareByFabric) {
    if (!fabricVersions.has(r.fabric_name)) fabricVersions.set(r.fabric_name, new Set());
    fabricVersions.get(r.fabric_name).add(r.firmware_version);
  }
  const fabricDrift = [...fabricVersions.entries()]
    .filter(([, versions]) => versions.size > 1)
    .map(([fabric, versions]) => ({ fabric, versions: [...versions] }));

  const STATUS_PRIORITY = { eos: 0, nearing: 1, lsa: 2, supported: 3, unknown: 4 };
  const switches = db.prepare(`
    SELECT name, wwn, model, firmware_version, serial_number, fabric_name, eos_status
    FROM brocade_switches WHERE stale = 0
  `).all();
  const switchLifecycle = switches
    .map((s) => {
      const lc = lifecycleFor(s.firmware_version, s.eos_status);
      return {
        switch: s.name || s.wwn, fabric: s.fabric_name, model: s.model,
        firmware: s.firmware_version, serial: s.serial_number,
        lifecycleStatus: lc.status, eosDate: lc.eosDate, eosDays: lc.eosDays,
      };
    })
    .filter((s) => s.lifecycleStatus !== 'supported')
    .sort((a, b) => (STATUS_PRIORITY[a.lifecycleStatus] ?? 9) - (STATUS_PRIORITY[b.lifecycleStatus] ?? 9))
    .slice(0, 30);

  const now = Date.now();
  const chassisCertsExpiringSoonest = db.prepare(`
    SELECT name, model_number, serial_number, tls_cert_expiry_ms
    FROM brocade_chassis WHERE stale = 0 AND tls_cert_expiry_ms IS NOT NULL
  `).all()
    .map((c) => ({
      chassis: c.name, model: c.model_number, serial: c.serial_number,
      daysRemaining: Math.round((c.tls_cert_expiry_ms - now) / 86400000),
    }))
    .sort((a, b) => a.daysRemaining - b.daysRemaining)
    .slice(0, 10);

  return {
    generatedAt: new Date().toISOString(),
    firmwareDriftByModel: modelDrift,
    firmwareDriftByFabric: fabricDrift,
    switchLifecycle,
    chassisCertsExpiringSoonest,
    note: switches.length === 0 ? 'No Brocade switches discovered yet.' : undefined,
  };
}

function gatherZoningReview() {
  const zoneConfigs = db.prepare(`
    SELECT fabric_name, cfg_name, is_effective, default_zone_access, member_zones
    FROM brocade_zone_configs WHERE stale = 0 ORDER BY fabric_name, cfg_name
  `).all().map((zc) => ({
    fabric: zc.fabric_name, cfgName: zc.cfg_name, isEffective: !!zc.is_effective,
    defaultZoneAccess: !!zc.default_zone_access, memberZoneCount: parseZoneCount(zc.member_zones),
  }));

  const zonesByFabric = db.prepare(`
    SELECT fabric_name, COUNT(*) total, SUM(CASE WHEN in_effective = 1 THEN 1 ELSE 0 END) inEffective
    FROM brocade_zones WHERE stale = 0 GROUP BY fabric_name ORDER BY fabric_name
  `).all();

  const unzonedDevicePorts = db.prepare(`
    SELECT port_role AS role, vendor, symbolic_name AS symbolicName, switch_name AS switchName, fabric_name AS fabric
    FROM brocade_device_ports
    WHERE stale = 0 AND (active_zone_count = 0 OR active_zone_count IS NULL)
    ORDER BY fabric_name LIMIT 30
  `).all();

  const issues = computeIssues().filter((i) => i.type === 'zone_default_access' || i.type === 'zone_drift')
    .map((i) => ({ type: i.type, severity: i.severity, source: i.source, target: i.target, message: i.message }));

  return {
    generatedAt: new Date().toISOString(),
    zoneConfigs,
    zonesByFabric,
    unzonedDevicePorts,
    zoningIssues: issues,
    note: zoneConfigs.length === 0 && zonesByFabric.length === 0 ? 'No Brocade zoning data collected yet.' : undefined,
  };
}

function gatherPortHealth() {
  const portsBySwitch = db.prepare(`
    SELECT switch_name AS switchName,
      COUNT(*) total,
      SUM(CASE WHEN LOWER(COALESCE(state,'')) = 'online' THEN 1 ELSE 0 END) online,
      SUM(CASE WHEN LOWER(COALESCE(state,'')) = 'offline' THEN 1 ELSE 0 END) offline,
      SUM(CASE WHEN fenced = 1 THEN 1 ELSE 0 END) fenced,
      SUM(CASE WHEN blocked = 1 THEN 1 ELSE 0 END) blocked,
      SUM(CASE WHEN health = 'Error' THEN 1 ELSE 0 END) errorHealth
    FROM brocade_switch_ports WHERE stale = 0
    GROUP BY switch_name ORDER BY (fenced + blocked + errorHealth) DESC, switch_name LIMIT 40
  `).all();

  const topCrcErrorPorts = db.prepare(`
    SELECT ps.port_wwn AS portWwn, sw.name AS switchName, MAX(ps.crc_errors) maxCrcErrors
    FROM brocade_port_stats ps
    LEFT JOIN brocade_switches sw ON sw.wwn = ps.switch_wwn AND sw.source_id = ps.source_id
    WHERE ps.ts >= datetime('now', '-1 day') AND ps.crc_errors IS NOT NULL
    GROUP BY ps.port_wwn ORDER BY maxCrcErrors DESC LIMIT 20
  `).all();

  const cutoffMs = Date.now() - 86400000;
  const eventsBySeverityCategory = db.prepare(`
    SELECT severity_norm AS severity, event_category AS category, COUNT(*) n
    FROM brocade_events WHERE last_occurred_ms >= ?
    GROUP BY severity_norm, event_category ORDER BY n DESC
  `).all(cutoffMs);

  const topEventDescriptions = db.prepare(`
    SELECT description, severity_norm AS severity, event_category AS category, SUM(event_count) totalCount
    FROM brocade_events WHERE last_occurred_ms >= ?
    GROUP BY description, severity_norm, event_category ORDER BY totalCount DESC LIMIT 15
  `).all(cutoffMs);

  const unacknowledgedCritical = db.prepare(`
    SELECT COUNT(*) n FROM brocade_events WHERE acknowledged = 0 AND severity_norm IN ('critical', 'alert')
  `).get().n;

  return {
    generatedAt: new Date().toISOString(),
    portsBySwitch,
    topCrcErrorPorts,
    eventsLast24h: { bySeverityCategory: eventsBySeverityCategory, topDescriptions: topEventDescriptions },
    unacknowledgedCriticalEvents: unacknowledgedCritical,
    note: portsBySwitch.length === 0 ? 'No Brocade port data collected yet.' : undefined,
  };
}

function gatherChangeAudit() {
  const windowStart = new Date(Date.now() - 30 * 864e5).toISOString();
  const changes = db.prepare(`
    SELECT fabric_name, change_type, detail, old_value, new_value, detected_at
    FROM brocade_zone_changes WHERE detected_at >= ?
    ORDER BY detected_at DESC LIMIT 60
  `).all(windowStart).map(c => ({
    fabric: c.fabric_name, type: c.change_type, detail: c.detail,
    oldValue: c.old_value, newValue: c.new_value, detectedAt: c.detected_at,
  }));
  const changeVolume = db.prepare(`
    SELECT fabric_name, change_type, COUNT(*) count FROM brocade_zone_changes
    WHERE detected_at >= ? GROUP BY fabric_name, change_type ORDER BY count DESC LIMIT 20
  `).all(windowStart).map(r => ({ fabric: r.fabric_name, type: r.change_type, count: r.count }));
  const newIssues = db.prepare(`
    SELECT type, severity, target, message, first_seen, resolved_at
    FROM brocade_issue_history WHERE first_seen >= ?
    ORDER BY first_seen DESC LIMIT 40
  `).all(windowStart).map(i => ({
    type: i.type, severity: i.severity, target: i.target,
    message: String(i.message || '').slice(0, 180), firstSeen: i.first_seen, resolved: !!i.resolved_at,
  }));
  const eventsPerDay = db.prepare(`
    SELECT date(last_occurred_ms / 1000, 'unixepoch') day,
           SUM(CASE WHEN UPPER(COALESCE(severity_norm, severity, '')) = 'CRITICAL' THEN 1 ELSE 0 END) critical,
           SUM(CASE WHEN UPPER(COALESCE(severity_norm, severity, '')) = 'WARNING' THEN 1 ELSE 0 END) warning
    FROM brocade_events WHERE last_occurred_ms >= ? GROUP BY day ORDER BY day
  `).all(Date.now() - 30 * 864e5);
  return {
    generatedAt: new Date().toISOString(),
    windowDays: 30,
    zoneChanges: changes,
    changeVolumeByFabric: changeVolume,
    issuesOpenedInWindow: newIssues,
    eventsPerDay,
    note: changes.length === 0 && newIssues.length === 0 ? 'No zoning changes or new issues recorded in the window.' : undefined,
  };
}

function gatherPathRedundancy() {
  // One row per host login (device port). Hosts group by enclosure when SANnav
  // knows it, else by the FDMI host name, else by WWN (a host we cannot group).
  const rows = db.prepare(`
    SELECT wwn, COALESCE(NULLIF(enclosure_name, ''), NULLIF(fdmi_host_name, ''), wwn) AS host,
           fabric_name, switch_name, switch_port_name, port_id
    FROM brocade_device_ports
    WHERE stale = 0 AND is_missing = 0 AND UPPER(COALESCE(port_role, type, '')) LIKE '%HOST%'
  `).all();
  const byHost = new Map();
  for (const r of rows) {
    if (!byHost.has(r.host)) byHost.set(r.host, { logins: 0, switches: new Set(), fabrics: new Set(), ports: [] });
    const h = byHost.get(r.host);
    h.logins += 1;
    if (r.switch_name) h.switches.add(r.switch_name);
    if (r.fabric_name) h.fabrics.add(r.fabric_name);
    if (h.ports.length < 6) h.ports.push(`${r.switch_name || '?'}:${r.switch_port_name || r.port_id || '?'}`);
  }
  const hosts = [...byHost.entries()].map(([host, h]) => ({
    host, logins: h.logins, switches: h.switches.size, fabrics: h.fabrics.size,
    onSwitches: [...h.switches].slice(0, 4), samplePorts: h.ports,
  }));
  const atRisk = hosts
    .filter(h => h.logins <= 1 || h.switches <= 1 || h.fabrics <= 1)
    .sort((a, b) => (a.switches - b.switches) || (a.logins - b.logins))
    .slice(0, 40);
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      hosts: hosts.length,
      singleLogin: hosts.filter(h => h.logins <= 1).length,
      singleSwitch: hosts.filter(h => h.switches <= 1).length,
      singleFabric: hosts.filter(h => h.fabrics <= 1).length,
    },
    hostsAtRisk: atRisk,
    note: hosts.length === 0 ? 'No host device ports discovered (or none carry a host port role).' : undefined,
  };
}

module.exports = createPlatformAdvisor({
  platform: 'brocade',
  feature: 'Brocade SAN AI Advisor',
  table: 'brocade_ai_reports',
  reports: {
    fabric_health: {
      system:
        'You are a SAN infrastructure engineer reviewing Brocade fabric health data from SANnav for an enterprise ' +
        'infrastructure team. You are given fabric status/health/zoning summary, per-fabric health-score aggregates, ' +
        'the 10 lowest-scoring switches, switch counts by health and operational status per fabric, and a summary of ' +
        'computed issues (counts by severity and type, top messages) with their thresholds. Identify which fabrics ' +
        'and switches need attention soonest and why. Names in the data are anonymized tokens; keep them exactly as ' +
        'given. Do not invent data. Markdown sections: **Summary**, **Findings** (severity-ordered), ' +
        '**Recommended actions**, **Data gaps**. Keep under ~400 words.',
      gather: gatherFabricHealth,
      noun: 'fabric health report',
    },
    switch_lifecycle: {
      system:
        'You are a SAN lifecycle manager reviewing Brocade switch firmware and certificate data for an enterprise ' +
        'infrastructure team. You are given firmware-version drift per model and per fabric (drift = more than one ' +
        'version among switches sharing the same model or fabric), per-switch lifecycle status (End of Support, ' +
        'nearing EOS, Legacy Support, or supported) derived from the Broadcom FOS support table, and the 10 chassis ' +
        'TLS certificates expiring soonest. Identify firmware standardization and certificate-renewal priorities. ' +
        'Names in the data are anonymized tokens; keep them exactly as given. Do not invent data. Markdown sections: ' +
        '**Summary**, **Findings** (severity-ordered), **Recommended actions**, **Data gaps**. Keep under ~400 words.',
      gather: gatherSwitchLifecycle,
      noun: 'switch lifecycle report',
    },
    zoning_review: {
      system:
        'You are a SAN zoning administrator reviewing Brocade zoning configuration for an enterprise infrastructure ' +
        'team. You are given each fabric\'s zone configs (effective config, default-zone-access flag, member-zone ' +
        'counts), zone and effective-zone counts per fabric, device ports with zero active zones (unzoned, top 30), ' +
        'and computed zone_default_access / zone_drift issues. Flag risky configurations (default all-access) and ' +
        'zoning hygiene gaps. Names in the data are anonymized tokens; keep them exactly as given. Do not invent ' +
        'data. Markdown sections: **Summary**, **Findings** (severity-ordered), **Recommended actions**, ' +
        '**Data gaps**. Keep under ~350 words.',
      gather: gatherZoningReview,
      noun: 'zoning review report',
    },
    port_health: {
      system:
        'You are a SAN operations engineer reviewing Brocade port health and event data for an enterprise ' +
        'infrastructure team. You are given per-switch port counts (online/offline/fenced/blocked/error-health), ' +
        'the 20 ports with the highest CRC error counts in the last 24 hours, event counts by severity and category ' +
        'in the last 24 hours with the top 15 descriptions, and the count of unacknowledged critical events. ' +
        'Identify signal-carrying problems versus noise and give a prioritized triage order. Names in the data are ' +
        'anonymized tokens; keep them exactly as given. Do not invent data. Markdown sections: **Summary**, ' +
        '**Findings** (severity-ordered), **Recommended actions**, **Data gaps**. Keep under ~350 words.',
      gather: gatherPortHealth,
      noun: 'port health report',
    },
    change_audit: {
      system:
        'You are a SAN change auditor reviewing 30 days of Brocade fabric changes for an enterprise infrastructure ' +
        'team. You are given zoning changes (type, fabric, what changed, when), issues that opened in the same ' +
        'window with their first-seen times, and critical/warning event counts per day. Correlate by time: a change ' +
        'shortly before an issue first appears deserves a hard look. Summarize change volume by fabric, name the ' +
        'changes nearest in time to new issues, and note fabrics changing with no recorded issues (healthy churn). ' +
        'Names in the data are anonymized tokens; keep them exactly as given. Do not invent data or claim causation, ' +
        'only proximity. Markdown sections: **Change summary**, **Changes near new issues**, **Recommended follow-ups**. ' +
        'Keep under ~400 words.',
      gather: gatherChangeAudit,
      noun: 'change and drift audit',
    },
    path_redundancy: {
      system:
        'You are a SAN availability engineer reviewing host path redundancy on Brocade fabrics. You are given, per ' +
        'host (enclosure), how many device-port logins it has, how many distinct switches and fabrics those logins ' +
        'land on, and the hosts with a single login or every login on one switch. A host with all paths through one ' +
        'switch loses storage when that switch reboots, and firmware upgrades reboot switches. Prioritize by blast ' +
        'radius and name the switch each single-switch host depends on. Names in the data are anonymized tokens; ' +
        'keep them exactly as given. Do not invent data. Markdown sections: **Summary**, ' +
        '**Single points of failure (prioritized)**, **Recommended actions**. Keep under ~400 words.',
      gather: gatherPathRedundancy,
      noun: 'path redundancy report',
    },
  },
});
