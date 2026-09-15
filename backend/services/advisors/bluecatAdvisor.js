const db = require('../../db/database');
const { createPlatformAdvisor } = require('../platformAdvisor');
const { lowFreeWarn, lowFreePct, computeIssues } = require('../bluecatIssues');

function issueSlice(types) {
  const all = computeIssues();
  const relevant = all.filter((i) => types.some((t) => (t.endsWith('-') ? i.type.startsWith(t) : i.type === t)));
  const counts = {};
  for (const i of relevant) counts[i.type] = (counts[i.type] || 0) + 1;
  return {
    counts,
    top20: relevant.slice(0, 20).map((i) => ({
      severity: i.severity, type: i.type, source: i.source, target: i.target, message: i.message,
    })),
  };
}

function gatherIpCapacity() {
  const sourceCount = db.prepare('SELECT COUNT(*) n FROM bluecat_sources').get().n;

  const byIpVersion = db.prepare(
    'SELECT ip_version, COUNT(*) n FROM bluecat_networks GROUP BY ip_version'
  ).all();

  const buckets = db.prepare(`
    SELECT
      SUM(CASE WHEN free_pct < 10 THEN 1 ELSE 0 END) AS b0_10,
      SUM(CASE WHEN free_pct >= 10 AND free_pct < 25 THEN 1 ELSE 0 END) AS b10_25,
      SUM(CASE WHEN free_pct >= 25 AND free_pct < 50 THEN 1 ELSE 0 END) AS b25_50,
      SUM(CASE WHEN free_pct >= 50 THEN 1 ELSE 0 END) AS b50plus
    FROM bluecat_networks WHERE free_pct IS NOT NULL
  `).get();

  const fullestNetworks = db.prepare(`
    SELECT nw.name, nw.range, nw.capacity, nw.used_static, nw.dhcp_used, nw.free_static, nw.free_pct, nw.gateway,
           s.name AS source_name
    FROM bluecat_networks nw JOIN bluecat_sources s ON s.id = nw.source_id
    WHERE nw.ip_version = 4 AND nw.free_pct IS NOT NULL
    ORDER BY nw.free_pct ASC LIMIT 20
  `).all().map((n) => ({
    source: n.source_name, name: n.name, range: n.range, capacity: n.capacity, usedStatic: n.used_static,
    dhcpUsed: n.dhcp_used, freeStatic: n.free_static, freePct: n.free_pct, gatewayUnknown: n.gateway == null,
  }));

  const lowSpaceRanges = db.prepare(`
    SELECT rg.name, rg.range_type, rg.start_ip, rg.end_ip, rg.size, rg.dhcp_used, rg.free_dhcp,
           nw.range AS network_range, s.name AS source_name
    FROM bluecat_ranges rg
    JOIN bluecat_networks nw ON nw.source_id = rg.source_id AND nw.network_id = rg.network_id
    JOIN bluecat_sources s ON s.id = rg.source_id
    WHERE rg.size IS NOT NULL AND rg.size > 0 AND rg.free_dhcp IS NOT NULL AND rg.free_dhcp < (rg.size * 0.1)
    ORDER BY (CAST(rg.free_dhcp AS REAL) / rg.size) ASC LIMIT 20
  `).all().map((r) => ({
    source: r.source_name, name: r.name, rangeType: r.range_type, startIp: r.start_ip, endIp: r.end_ip,
    size: r.size, dhcpUsed: r.dhcp_used, freeDhcp: r.free_dhcp, networkRange: r.network_range,
  }));

  const blocksTotal = db.prepare('SELECT COUNT(*) n FROM bluecat_blocks').get().n;
  const blocksByLocation = db.prepare(`
    SELECT COALESCE(location_name, 'Unknown') AS location, COUNT(*) n FROM bluecat_blocks GROUP BY location ORDER BY n DESC LIMIT 30
  `).all();

  const issues = issueSlice(['gateway-unknown', 'network-']);

  return {
    generatedAt: new Date().toISOString(),
    networksByIpVersion: byIpVersion,
    networksByFreePctBucket: {
      '0-10': buckets.b0_10 || 0, '10-25': buckets.b10_25 || 0, '25-50': buckets.b25_50 || 0, '50+': buckets.b50plus || 0,
    },
    fullestIpv4Networks: fullestNetworks,
    dhcpRangesLowSpace: lowSpaceRanges,
    blocks: { total: blocksTotal, byLocation: blocksByLocation },
    issues,
    thresholds: { lowFreeWarn: lowFreeWarn(), lowFreePct: lowFreePct() },
    note: sourceCount === 0 ? 'No BlueCat sources registered.' : undefined,
  };
}

function gatherDnsHygiene() {
  const sourceCount = db.prepare('SELECT COUNT(*) n FROM bluecat_sources').get().n;

  const views = db.prepare(`
    SELECT s.name AS source_name, v.configuration_name, v.name, v.zone_count, v.record_count
    FROM bluecat_views v JOIN bluecat_sources s ON s.id = v.source_id
    ORDER BY v.zone_count DESC LIMIT 30
  `).all().map((v) => ({
    source: v.source_name, configuration: v.configuration_name, view: v.name, zoneCount: v.zone_count, recordCount: v.record_count,
  }));

  const zonesByType = db.prepare('SELECT zone_type, COUNT(*) n FROM bluecat_zones GROUP BY zone_type ORDER BY n DESC').all();

  function zoneFlag(clause) {
    const count = db.prepare(`SELECT COUNT(*) n FROM bluecat_zones z WHERE ${clause}`).get().n;
    const examples = db.prepare(`
      SELECT z.absolute_name, s.name AS source_name FROM bluecat_zones z JOIN bluecat_sources s ON s.id = z.source_id
      WHERE ${clause} ORDER BY z.absolute_name LIMIT 15
    `).all().map((r) => ({ source: r.source_name, absoluteName: r.absolute_name }));
    return { count, examples };
  }

  const notDeployed = zoneFlag('z.deployment_enabled = 0');
  const unsigned = zoneFlag('z.signed = 0');
  const empty = zoneFlag('z.record_count = 0');

  const recordTypeDistribution = db.prepare(
    'SELECT record_type, COUNT(*) n FROM bluecat_records GROUP BY record_type ORDER BY n DESC LIMIT 20'
  ).all();

  const ttlBuckets = db.prepare(`
    SELECT
      SUM(CASE WHEN ttl < 300 THEN 1 ELSE 0 END) AS under5m,
      SUM(CASE WHEN ttl >= 300 AND ttl < 3600 THEN 1 ELSE 0 END) AS m5to1h,
      SUM(CASE WHEN ttl >= 3600 AND ttl < 86400 THEN 1 ELSE 0 END) AS h1to1d,
      SUM(CASE WHEN ttl >= 86400 THEN 1 ELSE 0 END) AS over1d
    FROM bluecat_records WHERE ttl IS NOT NULL
  `).get();

  const lowestTtlRecords = db.prepare(`
    SELECT r.absolute_name, r.rr_type, r.ttl, s.name AS source_name FROM bluecat_records r
    JOIN bluecat_sources s ON s.id = r.source_id
    WHERE r.ttl IS NOT NULL ORDER BY r.ttl ASC LIMIT 10
  `).all().map((r) => ({ source: r.source_name, absoluteName: r.absolute_name, rrType: r.rr_type, ttl: r.ttl }));

  const duplicateNames = db.prepare(`
    SELECT absolute_name, COUNT(DISTINCT view_id) AS viewCount FROM bluecat_records
    WHERE absolute_name IS NOT NULL
    GROUP BY absolute_name HAVING COUNT(DISTINCT view_id) > 1
    ORDER BY viewCount DESC LIMIT 10
  `).all();
  const duplicateNameTotal = db.prepare(`
    SELECT COUNT(*) n FROM (
      SELECT absolute_name FROM bluecat_records WHERE absolute_name IS NOT NULL
      GROUP BY absolute_name HAVING COUNT(DISTINCT view_id) > 1
    )
  `).get().n;

  return {
    generatedAt: new Date().toISOString(),
    views,
    zonesByType,
    zonesNotDeployed: notDeployed,
    zonesUnsigned: unsigned,
    zonesEmpty: empty,
    recordTypeDistribution,
    ttlBuckets: {
      under5m: ttlBuckets.under5m || 0, m5to1h: ttlBuckets.m5to1h || 0, h1to1d: ttlBuckets.h1to1d || 0, over1d: ttlBuckets.over1d || 0,
    },
    lowestTtlRecords,
    duplicateAbsoluteNames: { total: duplicateNameTotal, examples: duplicateNames.map((d) => ({ absoluteName: d.absolute_name, viewCount: d.viewCount })) },
    note: sourceCount === 0 ? 'No BlueCat sources registered.' : undefined,
  };
}

function gatherServerHealth() {
  const sourceCount = db.prepare('SELECT COUNT(*) n FROM bluecat_sources').get().n;

  const servers = db.prepare(`
    SELECT sv.name, sv.profile, sv.version, sv.connected, sv.state, sv.last_deploy_status, sv.roles_json,
           s.name AS source_name
    FROM bluecat_servers sv JOIN bluecat_sources s ON s.id = sv.source_id
    ORDER BY (sv.connected = 0) DESC, s.name, sv.name LIMIT 30
  `).all().map((sv) => {
    let roles = [];
    try { roles = sv.roles_json ? JSON.parse(sv.roles_json) : []; } catch { /* malformed roles JSON */ }
    return {
      source: sv.source_name, name: sv.name, profile: sv.profile, version: sv.version,
      connected: sv.connected === 1 ? true : sv.connected === 0 ? false : null,
      state: sv.state, lastDeployStatus: sv.last_deploy_status, roles,
    };
  });

  const disconnectedOrFailed = servers.filter((sv) => sv.connected === false || (sv.lastDeployStatus && /FAIL|INVALID/i.test(sv.lastDeployStatus)));

  const versionDistribution = db.prepare(
    "SELECT COALESCE(version, 'unknown') AS version, COUNT(*) n FROM bluecat_servers GROUP BY version ORDER BY n DESC LIMIT 20"
  ).all();

  const sourcePollStatus = db.prepare(
    'SELECT name, host, bam_version, last_poll_status, last_poll_at FROM bluecat_sources ORDER BY name LIMIT 30'
  ).all().map((s) => ({ name: s.name, host: s.host, bamVersion: s.bam_version, lastPollStatus: s.last_poll_status, lastPollAt: s.last_poll_at }));

  const issues = issueSlice(['server-', 'source-unreachable']);

  return {
    generatedAt: new Date().toISOString(),
    servers,
    disconnectedOrFailed,
    versionDistribution,
    sourcePollStatus,
    issues,
    note: sourceCount === 0 ? 'No BlueCat sources registered.' : undefined,
  };
}

const REPORTS = {
  ip_capacity: {
    system:
      'You are reviewing BlueCat Address Manager (BAM) IP space capacity for an enterprise infrastructure team. ' +
      'You are given networks grouped by IP version and free-space bucket, the fullest IPv4 networks, DHCP ranges ' +
      'running low on free addresses, a block inventory by location, and computed capacity/gateway issues with ' +
      'their configured thresholds. Names in the data are anonymized tokens; keep them exactly as given, never ' +
      'guess the real name. Do not invent data. Respond in markdown with these headings: **Summary**, ' +
      '**Findings (severity-ordered)**, **Recommended actions**, **Data gaps**. Keep it under ~400 words.',
    gather: gatherIpCapacity,
    noun: 'IP capacity report',
  },
  dns_hygiene: {
    system:
      'You are auditing DNS hygiene across BlueCat Address Manager (BAM) views and zones for an enterprise ' +
      'infrastructure team. You are given per-view zone/record counts, zone-type distribution, zones with ' +
      'deployment disabled, unsigned, or empty, record-type distribution, TTL distribution and the lowest-TTL ' +
      'records, and a count of names duplicated across views. Names in the data are anonymized tokens; keep them ' +
      'exactly as given, never guess the real name. Do not invent data. Respond in markdown with these headings: ' +
      '**Summary**, **Findings (severity-ordered)**, **Recommended actions**, **Data gaps**. Keep it under ~400 words.',
    gather: gatherDnsHygiene,
    noun: 'DNS hygiene report',
  },
  server_health: {
    system:
      'You are assessing BlueCat Address Manager (BAM) DNS/DHCP server health for an enterprise infrastructure ' +
      'team. You are given each server\'s connection/deploy state and role, a version distribution, disconnected ' +
      'or deploy-failed servers, source poll status per BAM, and computed server/source issues. Names in the data ' +
      'are anonymized tokens; keep them exactly as given, never guess the real name. Do not invent data. Respond ' +
      'in markdown with these headings: **Summary**, **Findings (severity-ordered)**, **Recommended actions**, ' +
      '**Data gaps**. Keep it under ~350 words.',
    gather: gatherServerHealth,
    noun: 'server health report',
  },
};

module.exports = createPlatformAdvisor({
  platform: 'bluecat',
  feature: 'BlueCat AI Advisor',
  table: 'bluecat_ai_reports',
  reports: REPORTS,
});
// Exposed for the rehearsal script only (platformAdvisor.js's return has no gather accessor).
module.exports.reports = REPORTS;
