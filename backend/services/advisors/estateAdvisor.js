// Estate AI Advisor: cross-platform reports built from what ICC already
// holds. Every table access is guarded, because a slim install may lack a
// platform's tables entirely.
const db = require('../../db/database');
const { tableExistsAny } = require('../../db/adminSplit');
const { createPlatformAdvisor, fmtBytes } = require('../platformAdvisor');
const { getSetting } = require('../settings');

// Global accounts exist only on the multi-tenant branch; on a single-tenant
// build the require fails and the per-tenant tables carry everything.
let globalAccounts = null;
try { globalAccounts = require('../../core/accounts'); } catch { /* single-tenant branch */ }

function tableExists(name) {
  try { return tableExistsAny(db, name); }
  catch { return false; }
}

function rows(sql, ...params) {
  try { return db.prepare(sql).all(...params); } catch { return []; }
}

function one(sql, ...params) {
  try { return db.prepare(sql).get(...params) || {}; } catch { return {}; }
}

// -- 1. Daily brief ----------------------------------------------------------

// -- Shared time and block helpers ------------------------------------------------

const DAY_MS = 86400000;
/** ISO cutoff n ms ago. Bound as a parameter; never compare an ISO column to datetime('now'). */
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();
/** YYYY-MM-DD n days ago, for columns that store a bare day. */
const dayAgo = (days) => isoAgo(days * DAY_MS).slice(0, 10);
const parseJson = (s, fallback) => {
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch { return fallback; }
};
const iso = (ms) => (ms == null || Number.isNaN(Number(ms)) ? null : new Date(Number(ms)).toISOString().slice(0, 10));
// Columns written by SQLite defaults use "YYYY-MM-DD HH:MM:SS"; columns written by JS use ISO with a T.
// datetime() on both sides puts either shape on the same footing.
const GE = (col) => `datetime(${col}) >= datetime(?)`;
const LT = (col) => `datetime(${col}) < datetime(?)`;

/** LogicMonitor service groups (the admin-picked services) and what each did in the last 24 hours.
 *  Returns {} when LogicMonitor has no portal or no service is picked. */
function gatherLmServices() {
  if (!tableExists('lm_sources') || !one('SELECT 1 x FROM lm_sources LIMIT 1').x) return {};
  let list = [];
  try { list = require('../logicmonitorGroups').services(db) || []; } catch { list = []; }
  if (!list.length) return {};
  const out = {
    lmServices: list.slice(0, 20).map((s) => ({
      label: s.label, state: s.state,
      devices: (s.counts && s.counts.total) || 0, failed: (s.counts && s.counts.crit) || 0, degraded: (s.counts && s.counts.warn) || 0,
    })),
  };
  if (list.length > 20) out.lmServicesTotal = list.length;
  if (tableExists('service_group_status_timeline')) {
    const byService = new Map();
    for (const r of rows(`SELECT service_id, label, state FROM service_group_status_timeline WHERE ${GE('at')} ORDER BY at, id`, isoAgo(DAY_MS))) {
      const cur = byService.get(r.service_id) || { service: r.label || r.service_id, transitions: 0, lastState: null };
      cur.transitions += 1; cur.lastState = r.state;
      byService.set(r.service_id, cur);
    }
    out.serviceTimeline24h = [...byService.values()].sort((a, b) => b.transitions - a.transitions).slice(0, 20);
  }
  return out;
}

/** Sites whose WAN is not ok (down, degraded or flapping), worst first. */
function gatherSiteWan() {
  if (!tableExists('lm_sites')) return undefined;
  return rows(`
    SELECT site_name, site_key, wan_state, wan_total, wan_down FROM lm_sites
    WHERE wan_state IS NOT NULL AND wan_state != 'ok'
    ORDER BY (wan_state = 'down') DESC, wan_down DESC, site_name LIMIT 10
  `).map((r) => ({ site: r.site_name || r.site_key, wanState: r.wan_state, wanTotal: r.wan_total || 0, wanDown: r.wan_down || 0 }));
}

/** Ops Agent observations: counts by state and the subjects that are degrading or critical. */
function gatherObservationsBlock() {
  if (!tableExists('ops_observations')) return undefined;
  const counts = { watching: 0, degrading: 0, critical: 0 };
  for (const r of rows("SELECT state, COUNT(*) n FROM ops_observations WHERE state != 'closed' GROUP BY state")) {
    if (r.state in counts) counts[r.state] = r.n;
  }
  const open = rows(`
    SELECT subject_label, observer_id, state, last_value, peak_value, unit FROM ops_observations
    WHERE state IN ('degrading', 'critical') ORDER BY (state = 'critical') DESC, peak_value DESC LIMIT 10
  `).map((r) => ({ subject: r.subject_label, observer: r.observer_id, state: r.state, value: r.last_value, peak: r.peak_value, unit: r.unit || null }));
  return { counts, open };
}

/** Incidents that stay open until a person resolves them. */
function gatherHumanRequired() {
  if (!tableExists('ops_incidents')) return undefined;
  const where = "requires_human = 1 AND state != 'resolved'";
  return {
    total: countOf(`SELECT COUNT(*) n FROM ops_incidents WHERE ${where}`),
    items: rows(`
      SELECT id, title, host, opened_at, acknowledged_at, snoozed_until FROM ops_incidents WHERE ${where}
      ORDER BY opened_at LIMIT 10
    `).map((r) => ({
      id: r.id, title: r.title, host: r.host, openedAt: r.opened_at,
      acknowledged: !!r.acknowledged_at || undefined, snoozedUntil: r.snoozed_until || undefined,
    })),
  };
}

function gatherEonFindingsOpen() {
  if (!tableExists('eon_findings')) return undefined;
  const total = countOf("SELECT COUNT(*) n FROM eon_findings WHERE status = 'open'");
  if (!total) return { total: 0 };
  return {
    total,
    bySeverity: rows("SELECT severity, COUNT(*) count FROM eon_findings WHERE status = 'open' GROUP BY severity ORDER BY count DESC")
      .map((r) => ({ severity: r.severity || 'unknown', count: r.count })),
    top: rows("SELECT resource_name, detector, conclusion, confidence_pct FROM eon_findings WHERE status = 'open' ORDER BY confidence_pct DESC LIMIT 5")
      .map((r) => ({ resource: r.resource_name, type: r.detector || r.conclusion, confidencePct: r.confidence_pct })),
  };
}

function gatherAwsAnomaliesOpen() {
  if (!tableExists('aws_cost_anomalies')) return undefined;
  const where = "status = 'open' AND superseded_by IS NULL";
  const total = countOf(`SELECT COUNT(*) n FROM aws_cost_anomalies WHERE ${where}`);
  if (!total) return { total: 0 };
  return {
    total,
    top: rows(`SELECT scope_key, start_day, impact_usd, impact_pct FROM aws_cost_anomalies WHERE ${where} ORDER BY impact_usd DESC LIMIT 5`)
      .map((r) => ({ scope: r.scope_key, since: r.start_day, impactUsd: r.impact_usd, impactPct: r.impact_pct })),
  };
}

function gatherHypervBrief() {
  if (!tableExists('hyperv_hosts') || !one('SELECT 1 x FROM hyperv_hosts LIMIT 1').x) return undefined;
  return {
    hosts: countOf('SELECT COUNT(*) n FROM hyperv_hosts'),
    hostsDown: countOf("SELECT COUNT(*) n FROM hyperv_hosts WHERE state IN ('down', 'unreachable')"),
    vms: tableExists('hyperv_vms') ? countOf('SELECT COUNT(*) n FROM hyperv_vms') : 0,
    vmsOff: tableExists('hyperv_vms') ? countOf("SELECT COUNT(*) n FROM hyperv_vms WHERE state = 'off'") : 0,
    replicationUnhealthy: tableExists('hyperv_replication')
      ? countOf("SELECT COUNT(*) n FROM hyperv_replication WHERE health IN ('critical', 'warning')") : 0,
    failedJobs24h: tableExists('hyperv_jobs')
      ? countOf('SELECT COUNT(*) n FROM hyperv_jobs WHERE error_code IS NOT NULL AND error_code != 0 AND started_at >= ?', isoAgo(DAY_MS)) : 0,
  };
}

/** Circuit events from the last 7 days by kind, and the ten circuits with the most events. */
function gatherCircuitEvents7d() {
  if (!tableExists('lm_circuit_events')) return undefined;
  const since = isoAgo(7 * DAY_MS);
  const byKind = { down: 0, up: 0, 'flap-start': 0, 'flap-stop': 0, saturated: 0, cleared: 0 };
  for (const r of rows(`SELECT event, COUNT(*) n FROM lm_circuit_events WHERE ${GE('at')} GROUP BY event`, since)) byKind[r.event] = r.n;
  const top = rows(`
    SELECT e.device_name, e.port, COUNT(*) n,
      (SELECT COALESCE(i.description, i.display_name) FROM lm_interfaces i WHERE i.source_id = e.source_id AND i.instance_id = e.instance_id) label,
      COALESCE((SELECT s.site_name FROM lm_sites s WHERE s.source_id = e.source_id AND s.site_key = e.far_site_key), e.far_site_key) far_site
    FROM lm_circuit_events e WHERE ${GE('e.at')}
    GROUP BY e.source_id, e.instance_id, e.device_name, e.port ORDER BY n DESC LIMIT 10
  `, since).map((r) => ({ device: r.device_name, port: r.port, label: r.label || null, farSite: r.far_site || null, events: r.n }));
  return { byKind, topCircuits: top };
}

/** LogicMonitor devices that the derived F5 and Cisco platforms claim (Meraki counts under Cisco). */
function gatherDerivedPlatforms() {
  if (!tableExists('lm_devices')) return undefined;
  const by = new Map();
  for (const r of rows(`
    SELECT vendor_key, COUNT(*) devices, SUM(CASE WHEN host_status = 'dead' THEN 1 ELSE 0 END) dead
    FROM lm_devices WHERE stale = 0 AND vendor_key IN ('f5', 'cisco', 'meraki') GROUP BY vendor_key
  `)) {
    const id = r.vendor_key === 'meraki' ? 'cisco' : r.vendor_key;
    const cur = by.get(id) || { platform: id, devices: 0, dead: 0, meraki: 0 };
    cur.devices += r.devices; cur.dead += r.dead || 0;
    if (r.vendor_key === 'meraki') cur.meraki += r.devices;
    by.set(id, cur);
  }
  return [...by.values()];
}

// -- Additions to the existing reports ----------------------------------------------

/** Expiry (epoch ms) of the first certificate in a PEM or bare base64 blob; null when it does not parse. */
function certExpiryMs(pem) {
  try {
    const { X509Certificate } = require('node:crypto');
    let text = String(pem || '').trim();
    if (!text) return null;
    if (!text.includes('BEGIN CERTIFICATE')) {
      text = `-----BEGIN CERTIFICATE-----\n${text.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----`;
    }
    const ms = Date.parse(new X509Certificate(text).validTo);
    return Number.isNaN(ms) ? null : ms;
  } catch { return null; }
}

/** Certificate sources beyond the original four: ISE and F5 through LogicMonitor issues, Okta SAML
 *  signing certificates, Hyper-V WinRM TLS. push() takes the same arguments as the audit's own helper. */
function addExtraCertificates(out, push) {
  if (tableExists('lm_issue_history')) {
    for (const r of rows(`
      SELECT type, target, message, first_seen FROM lm_issue_history
      WHERE status = 'open' AND type IN ('ise-cert-expiring', 'lb-cert-expiring') ORDER BY first_seen LIMIT 30
    `)) {
      const m = /(-?\d+)\s*days?/i.exec(r.message || '');
      out.push({
        platform: r.type === 'ise-cert-expiring' ? 'ISE (LogicMonitor)' : 'F5 (LogicMonitor)',
        system: r.target, certificate: 'certificate', subject: r.target, expires: null,
        daysLeft: m ? Number(m[1]) : null, message: String(r.message || '').slice(0, 200), firstSeen: r.first_seen,
      });
    }
  }
  if (tableExists('idp_providers')) {
    for (const p of rows("SELECT name, idp_cert_pem FROM idp_providers WHERE type = 'saml' AND idp_cert_pem IS NOT NULL")) {
      push('okta', p.name, 'SAML signing certificate', p.name, certExpiryMs(p.idp_cert_pem));
    }
  }
  if (tableExists('hyperv_hosts')) {
    for (const h of rows('SELECT name, cert_valid_to FROM hyperv_hosts WHERE cert_valid_to IS NOT NULL')) {
      push('Hyper-V', h.name, 'WinRM TLS', h.name, Date.parse(h.cert_valid_to));
    }
  }
}

/** Sign-in sources, identity providers and directory sync runs for the access review. */
function gatherIdentityExtras(shapedUsers) {
  const out = {};
  const providers = {};
  for (const u of shapedUsers) providers[u.provider || 'local'] = (providers[u.provider || 'local'] || 0) + 1;
  out.ssoUsers = Object.entries(providers).map(([provider, users]) => ({ provider, users }));
  if (tableExists('idp_providers')) {
    out.idpProviders = rows('SELECT id, name, type, enabled, mgmt_kind, mgmt_last_sync_at, mgmt_last_status FROM idp_providers ORDER BY name').map((p) => {
      const last = tableExists('idp_sync_log')
        ? one('SELECT status, started_at, groups_synced, users_seen, users_deactivated FROM idp_sync_log WHERE provider_id = ? ORDER BY id DESC LIMIT 1', p.id) : {};
      return {
        name: p.name, protocol: p.type, enabled: !!p.enabled, oktaSync: p.mgmt_kind === 'okta',
        lastSync: p.mgmt_last_sync_at || last.started_at || null, lastSyncStatus: p.mgmt_last_status || last.status || null,
        lastSyncCounts: last.status ? { groups: last.groups_synced, users: last.users_seen, deactivated: last.users_deactivated } : undefined,
        groupsLinked: countOf('SELECT COUNT(*) n FROM groups WHERE idp_provider_id = ?', p.id),
      };
    });
  }
  if (tableExists('directory_sync_log')) {
    out.directorySync = rows(`
      SELECT started_at, trigger, status, groups_synced, users_seen, users_created, users_deactivated
      FROM directory_sync_log ORDER BY id DESC LIMIT 5
    `).map((r) => ({
      at: r.started_at, trigger: r.trigger, status: r.status, groups: r.groups_synced, users: r.users_seen,
      created: r.users_created, deactivated: r.users_deactivated,
    }));
  }
  return out;
}

/** Hyper-V replication and checkpoints, Cohesity runs, Zerto events and VRAs, EON vaults and restores. */
function gatherRecoveryExtras() {
  const out = {};
  if (tableExists('hyperv_replication') && one('SELECT 1 x FROM hyperv_replication LIMIT 1').x) {
    out.hypervReplication = {
      total: countOf('SELECT COUNT(*) n FROM hyperv_replication'),
      byHealth: rows('SELECT COALESCE(health, \'unknown\') health, COUNT(*) count FROM hyperv_replication GROUP BY health ORDER BY count DESC')
        .map((r) => ({ health: r.health, count: r.count })),
      worst: rows(`
        SELECT vm_name, health, state, last_replication_at FROM hyperv_replication
        WHERE health IN ('critical', 'warning') ORDER BY (health = 'critical') DESC, last_replication_at LIMIT 10
      `).map((r) => ({ vm: r.vm_name, health: r.health, state: r.state, lastReplicationAt: r.last_replication_at })),
    };
  }
  if (tableExists('hyperv_checkpoints')) {
    const cutoff = isoAgo(7 * DAY_MS);
    const total = countOf(`SELECT COUNT(*) n FROM hyperv_checkpoints WHERE ${LT('created_at')}`, cutoff);
    if (total) {
      out.hypervCheckpoints = {
        olderThan7Days: total,
        oldest: rows(`SELECT vm_name, name, created_at, size_bytes FROM hyperv_checkpoints WHERE ${LT('created_at')} ORDER BY created_at LIMIT 10`, cutoff)
          .map((r) => ({ vm: r.vm_name, checkpoint: r.name, createdAt: r.created_at, sizeBytes: r.size_bytes })),
      };
    }
  }
  if (tableExists('protection_runs')) {
    const since = isoAgo(7 * DAY_MS);
    const t = one(`
      SELECT COUNT(*) total,
        COALESCE(SUM(CASE WHEN status IN ('kFailure','kFailed','kError') THEN 1 ELSE 0 END), 0) failed,
        COALESCE(SUM(CASE WHEN status = 'kWarning' THEN 1 ELSE 0 END), 0) warning
      FROM protection_runs WHERE ${GE('start_time')}
    `, since);
    out.cohesityRuns7d = {
      total: t.total || 0, failed: t.failed || 0, warning: t.warning || 0,
      topFailingGroups: rows(`
        SELECT p.job_name, c.name cluster, COUNT(*) failed FROM protection_runs p JOIN clusters c ON c.id = p.cluster_id
        WHERE p.status IN ('kFailure','kFailed','kError') AND ${GE('p.start_time')}
        GROUP BY p.cluster_id, p.job_name ORDER BY failed DESC LIMIT 10
      `, since).map((r) => ({ protectionGroup: r.job_name, cluster: r.cluster, failedRuns: r.failed })),
    };
  }
  if (tableExists('zerto_events')) {
    const since = isoAgo(DAY_MS);
    out.zertoEvents24h = {
      byCategory: rows(`SELECT COALESCE(category, 'unknown') category, COUNT(*) count FROM zerto_events WHERE ${GE('occurred_on')} GROUP BY category ORDER BY count DESC`, since)
        .map((r) => ({ category: r.category, count: r.count })),
      top: rows(`
        SELECT event_type, code, MAX(description) description, COUNT(*) count FROM zerto_events WHERE ${GE('occurred_on')}
        GROUP BY event_type, code ORDER BY count DESC LIMIT 10
      `, since).map((r) => ({ type: r.event_type, code: r.code, description: r.description ? String(r.description).slice(0, 160) : null, count: r.count })),
    };
  }
  if (tableExists('zerto_vras')) {
    out.zertoVras = rows("SELECT COALESCE(status, 'unknown') status, COUNT(*) count FROM zerto_vras GROUP BY status ORDER BY count DESC")
      .map((r) => ({ status: r.status, count: r.count }));
  }
  if (tableExists('eon_vaults') && one('SELECT 1 x FROM eon_vaults LIMIT 1').x) {
    out.eonVaults = {
      total: countOf('SELECT COUNT(*) n FROM eon_vaults'),
      byRegion: rows("SELECT COALESCE(region, 'unknown') region, COUNT(*) count FROM eon_vaults GROUP BY region ORDER BY count DESC LIMIT 15")
        .map((r) => ({ region: r.region, count: r.count })),
    };
  }
  if (tableExists('eon_restore_jobs')) {
    const since = isoAgo(7 * DAY_MS);
    out.eonRestores7d = {
      total: countOf(`SELECT COUNT(*) n FROM eon_restore_jobs WHERE ${GE('created_time')}`, since),
      failed: countOf(`SELECT COUNT(*) n FROM eon_restore_jobs WHERE UPPER(status) LIKE '%FAIL%' AND ${GE('created_time')}`, since),
    };
  }
  return out;
}

/** Configuration scopes the ledger holds, and Aria deployments added or removed in 30 days. */
function gatherLedgerExtras() {
  const out = {
    scopes: rows('SELECT platform, scope, COUNT(*) items FROM config_state GROUP BY platform, scope ORDER BY platform, scope LIMIT 60')
      .map((r) => ({ platform: r.platform, scope: r.scope, itemsTracked: r.items })),
  };
  if (tableExists('aria_deployment_ledger')) {
    const since = isoAgo(30 * DAY_MS);
    const added = countOf(`SELECT COUNT(*) n FROM aria_deployment_ledger WHERE ${GE('first_seen_at')}`, since);
    const removed = countOf(`SELECT COUNT(*) n FROM aria_deployment_ledger WHERE removed_at IS NOT NULL AND ${GE('removed_at')}`, since);
    out.ariaLedger30d = {
      added, removed,
      newest: rows(`SELECT name, created_at_src, first_seen_at FROM aria_deployment_ledger WHERE ${GE('first_seen_at')} ORDER BY first_seen_at DESC LIMIT 10`, since)
        .map((r) => ({ deployment: r.name, createdAt: r.created_at_src || null, firstSeenAt: r.first_seen_at })),
      removedList: rows(`SELECT name, created_at_src, removed_at FROM aria_deployment_ledger WHERE removed_at IS NOT NULL AND ${GE('removed_at')} ORDER BY removed_at DESC LIMIT 10`, since)
        .map((r) => ({ deployment: r.name, createdAt: r.created_at_src || null, removedAt: r.removed_at })),
      note: 'first_seen_at is when ICC first saw the deployment; created_at_src is Aria\'s own create date and is the better age.',
    };
  }
  return out;
}

/** Savings plans, reserved instances, forecast, denied FinOps capabilities, EON cost and Lightsail counts. */
function gatherCostExtras() {
  const out = { present: [] };
  const latest = (table, cols) => {
    if (!tableExists(table)) return null;
    const r = one(`SELECT day, ${cols} FROM ${table} WHERE day = (SELECT MAX(day) FROM ${table})`);
    return r.day ? r : null;
  };
  if (tableExists('aws_savings_plans')) {
    const total = countOf('SELECT COUNT(*) n FROM aws_savings_plans');
    if (total) {
      out.present.push('savingsPlans');
      const util = latest('aws_sp_utilization_daily', 'AVG(utilization_pct) pct');
      const cov = latest('aws_sp_coverage_daily', 'AVG(coverage_pct) pct');
      out.savingsPlans = {
        count: total,
        endingWithin90Days: countOf(`SELECT COUNT(*) n FROM aws_savings_plans WHERE end_at IS NOT NULL AND datetime(end_at) >= datetime(?) AND datetime(end_at) <= datetime(?)`, isoAgo(0), isoAgo(-90 * DAY_MS)),
        utilizationPct: util ? { day: util.day, pct: util.pct } : null,
        coveragePct: cov ? { day: cov.day, pct: cov.pct } : null,
      };
    }
  }
  const ri = { util: latest('aws_ri_utilization_daily', 'AVG(utilization_pct) pct'), cov: latest('aws_ri_coverage_daily', 'AVG(coverage_pct) pct') };
  if (ri.util || ri.cov) {
    out.present.push('reservedInstances');
    out.reservedInstances = {
      utilizationPct: ri.util ? { day: ri.util.day, pct: ri.util.pct } : null,
      coveragePct: ri.cov ? { day: ri.cov.day, pct: ri.cov.pct } : null,
    };
  }
  if (tableExists('aws_cost_forecast')) {
    const fc = rows(`
      SELECT metric, period_start, period_end, mean_usd, lower_usd, upper_usd, source FROM aws_cost_forecast
      WHERE scope = 'total' AND generated_on = (SELECT MAX(generated_on) FROM aws_cost_forecast) ORDER BY period_start LIMIT 5
    `);
    if (fc.length) {
      out.present.push('forecast');
      out.forecast = fc.map((r) => ({ metric: r.metric, from: r.period_start, to: r.period_end, meanUsd: r.mean_usd, lowerUsd: r.lower_usd, upperUsd: r.upper_usd, source: r.source }));
    }
  }
  if (tableExists('aws_capability_status')) {
    const caps = rows("SELECT DISTINCT capability, status FROM aws_capability_status WHERE status IN ('denied', 'not_enabled') ORDER BY capability LIMIT 20");
    out.capabilitiesNotAvailable = caps.map((r) => ({ capability: r.capability, status: r.status }));
    out.present.push('capabilityStatus');
  }
  if (tableExists('eon_cost_daily') && one('SELECT 1 x FROM eon_cost_daily LIMIT 1').x) {
    out.present.push('eonCost');
    const a = dayAgo(30); const b = dayAgo(60);
    out.eonCost = rows(`
      SELECT s.name, COALESCE(SUM(CASE WHEN c.day >= ? THEN c.cost_cents END), 0) last30,
             COALESCE(SUM(CASE WHEN c.day >= ? AND c.day < ? THEN c.cost_cents END), 0) prior30
      FROM eon_cost_daily c LEFT JOIN eon_sources s ON s.id = c.source_id GROUP BY c.source_id ORDER BY last30 DESC LIMIT 10
    `, a, b, a).map((r) => ({ source: r.name, last30DaysUsd: Math.round(r.last30) / 100, prior30DaysUsd: Math.round(r.prior30) / 100 }));
  }
  const ls = {};
  for (const [key, table] of [['instances', 'aws_lightsail_instances'], ['databases', 'aws_lightsail_databases'], ['disks', 'aws_lightsail_disks'],
    ['buckets', 'aws_lightsail_buckets'], ['loadBalancers', 'aws_lightsail_load_balancers'], ['distributions', 'aws_lightsail_distributions'],
    ['domains', 'aws_lightsail_domains'], ['staticIps', 'aws_lightsail_static_ips']]) {
    if (tableExists(table)) ls[key] = countOf(`SELECT COUNT(*) n FROM ${table}`);
  }
  if (Object.values(ls).some((n) => n > 0)) { out.lightsail = ls; out.present.push('lightsail'); }
  return out;
}

// -- LogicMonitor network estate (shared by the daily brief and network_dependency) --

const countOf = (sql, ...params) => one(sql, ...params).n || 0;

/** Network health across the LogicMonitor portals, from the tables and services the LogicMonitor
 *  pages read. Null when LogicMonitor has no portal registered. */
function gatherNetworkEstate() {
  if (!tableExists('lm_sources')) return null;
  const portals = countOf('SELECT COUNT(*) n FROM lm_sources WHERE enabled = 1');
  if (!one('SELECT 1 x FROM lm_sources LIMIT 1').x) return null;

  let circuitRows = [];
  try { circuitRows = require('../logicmonitorPath').circuitRows(db); } catch { circuitRows = []; }
  const circuitsNotOk = circuitRows.filter((c) => c.state !== 'ok')
    .sort((a, b) => (b.state === 'critical') - (a.state === 'critical'))
    .slice(0, 10)
    .map((c) => ({ deviceName: c.deviceName, port: c.port, label: c.label, carrier: c.carrier || null, state: c.state }));

  const episodes = { watching: 0, degrading: 0, critical: 0 };
  if (tableExists('lm_latency_episodes')) {
    for (const r of rows("SELECT state, COUNT(*) n FROM lm_latency_episodes WHERE state != 'closed' GROUP BY state")) {
      if (r.state in episodes) episodes[r.state] = r.n;
    }
  }

  // Sites in trouble: a dead network device, a collector down, a critical WAN circuit or a
  // critical reachability episode at the site.
  const bad = new Set();
  for (const r of rows("SELECT DISTINCT source_id sid, site_key sk FROM lm_devices WHERE stale = 0 AND is_network = 1 AND host_status = 'dead' AND site_key IS NOT NULL")) bad.add(`${r.sid}|${r.sk}`);
  if (tableExists('lm_collectors')) {
    for (const r of rows('SELECT DISTINCT source_id sid, site_key sk FROM lm_collectors WHERE stale = 0 AND is_down = 1 AND site_key IS NOT NULL')) bad.add(`${r.sid}|${r.sk}`);
  }
  for (const c of circuitRows) if (c.state === 'critical' && c.siteKey) bad.add(`${c.sourceId}|${c.siteKey}`);
  if (tableExists('lm_latency_episodes')) {
    for (const r of rows("SELECT DISTINCT source_id sid, site_key sk FROM lm_latency_episodes WHERE state = 'critical' AND site_key IS NOT NULL")) bad.add(`${r.sid}|${r.sk}`);
  }
  const siteNames = new Map(rows('SELECT source_id sid, site_key sk, site_name nm FROM lm_sites').map((r) => [`${r.sid}|${r.sk}`, r.nm || r.sk]));
  const sitesCritical = [...bad].map((k) => siteNames.get(k) || k.split('|')[1]).sort().slice(0, 10);

  const alerts = one(`
    SELECT COALESCE(SUM(CASE WHEN severity_norm = 'critical' THEN 1 ELSE 0 END), 0) critical,
           COALESCE(SUM(CASE WHEN severity_norm = 'warning' THEN 1 ELSE 0 END), 0) warning,
           COALESCE(SUM(CASE WHEN severity_norm = 'info' THEN 1 ELSE 0 END), 0) info
    FROM lm_alerts WHERE cleared = 0 AND duplicate_of IS NULL
  `);

  return {
    portals,
    devicesDead: countOf("SELECT COUNT(*) n FROM lm_devices WHERE stale = 0 AND host_status = 'dead'"),
    networkDevicesDead: countOf("SELECT COUNT(*) n FROM lm_devices WHERE stale = 0 AND is_network = 1 AND host_status = 'dead'"),
    collectorsDown: tableExists('lm_collectors') ? countOf('SELECT COUNT(*) n FROM lm_collectors WHERE stale = 0 AND is_down = 1') : 0,
    circuitsNotOk,
    latencyEpisodesOpen: episodes,
    sitesCritical,
    unmonitoredNeighbours: tableExists('lm_unmonitored_neighbors') ? countOf('SELECT COUNT(*) n FROM lm_unmonitored_neighbors WHERE stale = 0') : 0,
    alertsOpenBySeverity: { critical: alerts.critical || 0, warning: alerts.warning || 0, info: alerts.info || 0 },
  };
}

function gatherDailyBrief() {
  // Required lazily: serviceStatus and opsAgent pull in large trees.
  const serviceStatus = require('../serviceStatus');
  const opsAgent = require('../opsAgent');
  const appServices = require('../appServiceStatus');

  let platforms = [];
  try {
    platforms = serviceStatus.getBoard({ days: 7 }).platforms.map((p) => ({
      platform: p.label || p.id,
      state: p.current?.state || 'unknown',
      since: p.current?.since || null,
      reason: p.current?.reason || null,
      openEvents: p.current?.openEvents ?? 0,
      sourcesPolled: p.current?.sourcesPolled ?? null,
      sourcesUnreachable: p.current?.sourcesUnreachable ?? 0,
    }));
  } catch { /* board unavailable */ }

  let incidents = [];
  try {
    incidents = opsAgent.listIncidents({ state: 'open', limit: 25 }).map((i) => ({
      id: i.id, title: i.title, host: i.host, severity: i.severity, state: i.state,
      platforms: i.platforms, classification: i.classification,
      humanRequired: i.humanRequired, openedAt: i.openedAt, alerts: i.eventCount,
      isRepeat: i.isPattern ? `${i.repeatCount}x` : null, summary: i.summary,
    }));
  } catch { /* agent tables absent */ }

  let apps = [];
  try {
    apps = appServices.getBoard().apps
      .filter((a) => a.state && a.state !== 'operational' && a.state !== 'unknown')
      .map((a) => ({ app: a.label || a.displayId, state: a.state, reason: a.reason, since: a.since, counts: a.counts }));
  } catch { /* app services absent */ }

  let network;
  try { network = gatherNetworkEstate() || undefined; } catch { network = undefined; }

  // ops_incidents stamps are JS ISO strings; the cutoff is built in JS and bound, never datetime('now').
  const since24 = isoAgo(DAY_MS);
  const last24h = {
    incidentsOpened: countOf('SELECT COUNT(*) n FROM ops_incidents WHERE opened_at >= ?', since24),
    incidentsResolved: countOf("SELECT COUNT(*) n FROM ops_incidents WHERE state = 'resolved' AND resolved_at >= ?", since24),
    analysesEmailed: countOf('SELECT COUNT(*) n FROM ops_incidents WHERE notified_at >= ?', since24),
  };
  if (tableExists('ops_capability_runs')) last24h.capabilityRuns = countOf('SELECT COUNT(*) n FROM ops_capability_runs WHERE ran_at >= ?', since24);
  if (tableExists('ops_incident_analyses')) last24h.analyses = countOf('SELECT COUNT(*) n FROM ops_incident_analyses WHERE at >= ?', since24);

  return {
    generatedAt: new Date().toISOString(),
    platformStatus: platforms,
    openIncidentsByImpact: incidents,
    appServicesNotOperational: apps,
    network,
    ...gatherLmServices(),
    siteWan: gatherSiteWan(),
    observations: gatherObservationsBlock(),
    humanRequired: gatherHumanRequired(),
    eonFindingsOpen: gatherEonFindingsOpen(),
    awsAnomaliesOpen: gatherAwsAnomaliesOpen(),
    hypervBrief: gatherHypervBrief(),
    last24h,
    note: platforms.length === 0 && incidents.length === 0 ? 'Service Status and the Ops Agent have no data yet.' : undefined,
  };
}

// -- 2. Certificate audit ----------------------------------------------------

// -- 1b. Network dependency --

const NET_DEP_APP_CAP = 25;

function gatherNetworkDependency() {
  const appServices = require('../appServiceStatus');
  let board = [];
  try { board = appServices.getBoard().apps; } catch { board = []; }

  const apps = [];
  for (const b of board.slice(0, NET_DEP_APP_CAP)) {
    let detail = null;
    try { detail = appServices.evaluate(b.usageId); } catch { detail = null; }
    const ns = (detail && detail.networkSummary) || b.networkSummary || { state: 'unknown' };
    apps.push({
      app: b.label || b.displayId,
      state: detail ? detail.state : b.state,
      servers: detail ? (detail.servers || []).length : (b.counts && b.counts.vms) || 0,
      networkSummary: ns.sites ? {
        ...ns,
        singleSwitchServers: (ns.singleSwitchServers || []).slice(0, 10),
        sites: ns.sites.map((st) => ({ ...st, circuits: (st.circuits || []).slice(0, 5).map((c) => ({ deviceName: c.deviceName, port: c.port, label: c.label, state: c.state })) })),
      } : ns,
    });
  }
  const rank = { critical: 3, degraded: 2, ok: 0, unknown: 1 };
  apps.sort((a, b) => (rank[b.networkSummary.state] || 0) - (rank[a.networkSummary.state] || 0));

  const estate = gatherNetworkEstate();
  let repeatingChecks = [];
  if (tableExists('lm_latency_episodes')) {
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
    repeatingChecks = rows(`
      SELECT subject_label label, site_key siteKey, COUNT(*) oneOff FROM lm_latency_episodes
      WHERE state = 'closed' AND outcome = 'one-off' AND opened_at >= ? GROUP BY source_id, subject_key HAVING COUNT(*) >= 3
      ORDER BY oneOff DESC LIMIT 10
    `, cutoff).map((r) => ({ check: r.label, siteKey: r.siteKey, oneOffsIn7Days: r.oneOff }));
  }
  return {
    generatedAt: new Date().toISOString(),
    appsRankedByNetworkState: apps,
    ...gatherLmServices(),
    siteWan: gatherSiteWan(),
    circuitEvents7d: gatherCircuitEvents7d(),
    derivedPlatforms: gatherDerivedPlatforms(),
    estate: estate ? {
      circuitsNotOk: estate.circuitsNotOk,
      sitesCritical: estate.sitesCritical,
      repeatingChecks,
      unmonitoredNeighbours: estate.unmonitoredNeighbours,
      collectorsDown: estate.collectorsDown,
      networkDevicesDead: estate.networkDevicesDead,
    } : undefined,
    note: apps.length === 0 ? 'No app services are on the watch list.' : (estate ? undefined : 'LogicMonitor has no portal registered, so site and circuit data are absent.'),
  };
}

function gatherCertificateAudit() {
  const out = [];
  const push = (platform, system, certificate, subject, expiresMs) => {
    if (expiresMs == null || Number.isNaN(expiresMs)) return;
    out.push({
      platform, system, certificate, subject,
      expires: new Date(expiresMs).toISOString().slice(0, 10),
      daysLeft: Math.floor((expiresMs - Date.now()) / 86400000),
    });
  };
  if (tableExists('pure_certificates')) {
    const names = new Map(rows('SELECT id, name FROM pure_arrays').map((a) => [a.id, a.name]));
    for (const c of rows('SELECT array_id, name, common_name, valid_to_ms FROM pure_certificates')) {
      push('Pure', names.get(c.array_id) || `Array ${c.array_id}`, c.name, c.common_name, c.valid_to_ms);
    }
  }
  if (tableExists('vcenter_certs')) {
    const names = new Map(rows('SELECT id, name FROM vcenter_vcenters').map((v) => [v.id, v.name]));
    for (const c of rows('SELECT vcenter_id, cert_type, subject, valid_to FROM vcenter_certs')) {
      push('vCenter', names.get(c.vcenter_id) || `vCenter ${c.vcenter_id}`, c.cert_type, c.subject, Date.parse(c.valid_to));
    }
  }
  if (tableExists('brocade_switches')) {
    for (const s of rows('SELECT name, tls_cert_expiry_ms FROM brocade_switches WHERE stale = 0 AND tls_cert_expiry_ms IS NOT NULL')) {
      push('Brocade', s.name, 'switch TLS', s.name, Number(s.tls_cert_expiry_ms));
    }
  }
  if (tableExists('brocade_chassis')) {
    for (const c of rows('SELECT name, tls_cert_expiry_ms FROM brocade_chassis WHERE tls_cert_expiry_ms IS NOT NULL')) {
      push('Brocade', c.name, 'chassis TLS', c.name, Number(c.tls_cert_expiry_ms));
    }
  }
  addExtraCertificates(out, push);
  // Entries whose days could not be read sort last and fall in no bucket.
  out.sort((a, b) => (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9));
  const bucket = (lo, hi) => out.filter((c) => c.daysLeft != null && c.daysLeft >= lo && c.daysLeft < hi).length;
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      certificatesTracked: out.length,
      expired: out.filter((c) => c.daysLeft != null && c.daysLeft < 0).length,
      within30Days: bucket(0, 30), within60Days: bucket(30, 60), within90Days: bucket(60, 90),
    },
    expiringSoonest: out.slice(0, 60),
    coverage: 'Pure array certificates, vCenter certificates, Brocade switch and chassis TLS, Hyper-V WinRM TLS, Okta SAML signing certificates, and ISE and F5 certificates that LogicMonitor flagged as expiring (days read from the issue text, null when it did not parse). Pure1, Dell, NetApp, Cohesity, Zerto and EON do not expose certificate expiry to ICC.',
    note: out.length === 0 ? 'No certificate data collected yet.' : undefined,
  };
}

// -- 3. Access review --------------------------------------------------------

function gatherAccessReview() {
  const dormantCutoff = new Date(Date.now() - 90 * 86400000).toISOString();
  let users = rows('SELECT id, username, display_name, auth_provider, is_active, last_login_at FROM users');
  let globalNote;
  if (globalAccounts) {
    // Multi-tenant build: the account lives in the global db, the per-tenant
    // row is a membership mirror without login times.
    try {
      const g = require('../../core/tenantRegistry').globalDb;
      const globals = new Map(g.prepare('SELECT id, username, auth_provider, is_active, is_global_admin, last_login_at FROM global_users').all()
        .map((u) => [u.username.toLowerCase(), u]));
      users = users.map((u) => {
        const gl = globals.get(String(u.username).toLowerCase());
        return gl ? { ...u, auth_provider: gl.auth_provider, is_active: gl.is_active, last_login_at: gl.last_login_at, is_global_admin: gl.is_global_admin } : u;
      });
      globalNote = 'Accounts are global; login times and active flags come from the global account record.';
    } catch { /* keep tenant rows */ }
  }
  const shapedUsers = users.map((u) => ({
    username: u.username, displayName: u.display_name, provider: u.auth_provider,
    active: !!u.is_active, globalAdmin: !!u.is_global_admin || undefined,
    lastLoginAt: u.last_login_at || null,
    dormant: !u.last_login_at || u.last_login_at < dormantCutoff,
  }));
  const groups = rows(`
    SELECT g.id, g.name, g.description, g.is_system,
           (SELECT COUNT(*) FROM user_groups ug WHERE ug.group_id = g.id) members
    FROM groups g ORDER BY g.name
  `).map((g) => ({
    group: g.name, description: g.description, system: !!g.is_system, members: g.members,
    permissions: rows("SELECT permission FROM role_grants WHERE subject_type = 'group' AND subject_id = ?", g.id).map((r) => r.permission),
  }));
  const membership = rows(`
    SELECT u.username, gr.name AS group_name FROM user_groups ug
    JOIN users u ON u.id = ug.user_id JOIN groups gr ON gr.id = ug.group_id
  `);
  const groupsByUser = new Map();
  for (const m of membership) {
    if (!groupsByUser.has(m.username)) groupsByUser.set(m.username, []);
    groupsByUser.get(m.username).push(m.group_name);
  }
  const directGrants = rows(`
    SELECT u.username, rg.permission FROM role_grants rg
    JOIN users u ON u.id = rg.subject_id WHERE rg.subject_type = 'user'
  `).map((r) => ({ username: r.username, permission: r.permission }));
  const wildcardHolders = [
    ...rows("SELECT 'group' kind, g.name FROM role_grants rg JOIN groups g ON g.id = rg.subject_id WHERE rg.subject_type = 'group' AND rg.permission = '*:*:*'"),
    ...rows("SELECT 'user' kind, u.username AS name FROM role_grants rg JOIN users u ON u.id = rg.subject_id WHERE rg.subject_type = 'user' AND rg.permission = '*:*:*'"),
  ].map((r) => ({ kind: r.kind, name: r.name }));
  const serviceAccounts = rows('SELECT name, permissions, is_active, created_at, last_used_at FROM service_accounts').map((s) => ({
    name: s.name, permissions: s.permissions, active: !!s.is_active,
    createdAt: s.created_at, lastUsedAt: s.last_used_at || null,
    dormant: !s.last_used_at || s.last_used_at < dormantCutoff,
  }));
  const auditSummary = rows(`
    SELECT action, COUNT(*) count FROM tenant_audit
    WHERE at >= ? GROUP BY action ORDER BY count DESC LIMIT 20
  `, isoAgo(30 * DAY_MS)).map((r) => ({ action: r.action, count: r.count }));

  // LogicMonitor portal accounts (lm_admins, refreshed daily by the poller).
  let lmAccounts;
  if (tableExists('lm_admins')) {
    const parse = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
    lmAccounts = rows(`
      SELECT s.name AS system, a.username, a.status, a.roles_json, a.last_login_epoch, a.two_fa, a.apionly, a.api_token_count
      FROM lm_admins a JOIN lm_sources s ON s.id = a.source_id
      WHERE COALESCE(a.stale, 0) = 0 ORDER BY s.name, a.username LIMIT 500
    `).map((a) => ({
      platform: 'logicmonitor',
      system: a.system,
      account: a.username,
      status: a.status,
      roles: parse(a.roles_json),
      lastLogin: a.last_login_epoch ? new Date(Number(a.last_login_epoch) * 1000).toISOString() : null,
      mfa: !!a.two_fa,
      serviceAccount: !!a.apionly,
      tokens: a.api_token_count || 0,
    }));
  }

  return {
    generatedAt: new Date().toISOString(),
    users: shapedUsers.map((u) => ({ ...u, groups: groupsByUser.get(u.username) || [] })),
    groups,
    directUserGrants: directGrants,
    fullAdminWildcardHolders: wildcardHolders,
    serviceAccounts,
    auditActionsLast30Days: auditSummary,
    logicmonitorAccounts: lmAccounts,
    ...gatherIdentityExtras(shapedUsers),
    reviewWindow: { dormantAfterDays: 90 },
    note: globalNote,
  };
}

// -- 4. Recovery readiness ---------------------------------------------------

function gatherRecoveryReadiness() {
  const appServices = require('../appServiceStatus');
  let apps = [];
  try {
    apps = appServices.getBoard().apps.map((a) => ({
      app: a.label || a.displayId, state: a.state, reason: a.state !== 'operational' ? a.reason : undefined,
      vms: a.counts.vms, vmsOffline: a.counts.vmsOffline, backupsStale: a.counts.backupsStale,
      pathsMissing: a.counts.pathsMissing, datastoresInaccessible: a.counts.datastoresInaccessible,
    }));
  } catch { /* app services absent */ }

  const staleHours = Math.min(720, Math.max(1, Number(getSetting('app_service_backup_stale_hours')) || 24));
  let backup = {};
  if (tableExists('cohesity_objects')) {
    const cutoffMs = Date.now() - staleHours * 3600000;
    backup = {
      staleThresholdHours: staleHours,
      protectedObjects: one('SELECT COUNT(*) n FROM cohesity_objects WHERE is_protected = 1').n || 0,
      unprotectedObjects: one('SELECT COUNT(*) n FROM cohesity_objects WHERE is_protected = 0 OR is_protected IS NULL').n || 0,
      protectedButStale: one('SELECT COUNT(*) n FROM cohesity_objects WHERE is_protected = 1 AND (last_backup_ms IS NULL OR last_backup_ms < ?)', cutoffMs).n || 0,
    };
  }

  let zerto = {};
  if (tableExists('zerto_vpgs')) {
    zerto = {
      vpgs: one('SELECT COUNT(*) n FROM zerto_vpgs').n || 0,
      unhealthy: one("SELECT COUNT(*) n FROM zerto_vpgs WHERE health != 'Healthy'").n || 0,
      rpoBreaches: one('SELECT COUNT(*) n FROM zerto_vpgs WHERE configured_rpo > 0 AND actual_rpo > configured_rpo').n || 0,
      journalShort: one('SELECT COUNT(*) n FROM zerto_vpgs WHERE configured_journal_history > 0 AND actual_journal_history < configured_journal_history').n || 0,
      sitesDisconnected: one("SELECT COUNT(*) n FROM zerto_sites WHERE connection_status != 'Connected'").n || 0,
      worstVpgs: rows(`
        SELECT name, health, actual_rpo, configured_rpo, protected_site, recovery_site FROM zerto_vpgs
        WHERE health != 'Healthy' OR (configured_rpo > 0 AND actual_rpo > configured_rpo)
        ORDER BY actual_rpo DESC LIMIT 10
      `).map((v) => ({ vpg: v.name, health: v.health, actualRpoSeconds: v.actual_rpo, configuredRpoSeconds: v.configured_rpo, from: v.protected_site, to: v.recovery_site })),
    };
  }

  let snapmirror = {};
  if (tableExists('netapp_snapmirror')) {
    snapmirror = {
      relationships: one('SELECT COUNT(*) n FROM netapp_snapmirror').n || 0,
      unhealthy: one('SELECT COUNT(*) n FROM netapp_snapmirror WHERE healthy = 0').n || 0,
      maxLagSeconds: one('SELECT MAX(lag_seconds) m FROM netapp_snapmirror').m ?? null,
    };
  }

  let pure = {};
  if (tableExists('pure_protection_groups')) {
    pure = {
      protectionGroups: one('SELECT COUNT(*) n FROM pure_protection_groups WHERE destroyed = 0').n || 0,
      withoutSnapshots: one('SELECT COUNT(*) n FROM pure_protection_groups WHERE destroyed = 0 AND (snapshot_enabled IS NULL OR snapshot_enabled = 0)').n || 0,
      withoutReplication: one('SELECT COUNT(*) n FROM pure_protection_groups WHERE destroyed = 0 AND (replication_enabled IS NULL OR replication_enabled = 0)').n || 0,
    };
  }

  // EON cloud backup posture (tables absent until the platform is installed).
  let eon = {};
  if (tableExists('eon_resources')) {
    eon = {
      resources: one('SELECT COUNT(*) n FROM eon_resources').n || 0,
      protected: one("SELECT COUNT(*) n FROM eon_resources WHERE backup_status = 'PROTECTED'").n || 0,
      notBackedUp: one("SELECT COUNT(*) n FROM eon_resources WHERE backup_status = 'NOT_BACKED_UP'").n || 0,
      unprotectedProd: one("SELECT COUNT(*) n FROM eon_resources WHERE backup_status = 'NOT_BACKED_UP' AND environment = 'PROD'").n || 0,
      violatingControls: one("SELECT COUNT(*) n FROM eon_resources WHERE backup_status = 'VIOLATIONS_DETECTED'").n || 0,
      jobsFailed24h: one('SELECT COUNT(*) n FROM eon_backup_jobs WHERE status = ? AND created_time >= ?',
        'JOB_FAILED', new Date(Date.now() - 86400000).toISOString()).n || 0,
      snapshotsOnHold: one('SELECT COUNT(*) n FROM eon_resource_snapshots WHERE on_hold = 1').n || 0,
      openThreatFindings: one("SELECT COUNT(*) n FROM eon_findings WHERE status = 'open'").n || 0,
      worstUnprotected: rows(`
        SELECT name, resource_type, environment, source_storage_bytes FROM eon_resources
        WHERE backup_status = 'NOT_BACKED_UP' ORDER BY (environment = 'PROD') DESC,
        COALESCE(source_storage_bytes, 0) DESC LIMIT 10
      `).map((r) => ({ name: r.name, type: r.resource_type, environment: r.environment, sourceBytes: r.source_storage_bytes })),
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    appServices: apps,
    cohesityBackup: backup,
    zertoReplication: zerto,
    netappSnapMirror: snapmirror,
    pureProtection: pure,
    eonCloudBackup: eon,
    ...gatherRecoveryExtras(),
    note: apps.length === 0 ? 'No app services are on the watch list; per-application ratings need the App Services watch list filled.' : undefined,
  };
}

// -- 5. Change ledger --------------------------------------------------------

function gatherChangeLedger() {
  const { listChanges } = require('../configLedger');
  const changes = listChanges({ days: 30, limit: 120 }).map((c) => ({
    detectedAt: c.detected_at, platform: c.platform, scope: c.scope, system: c.system,
    item: c.item, change: c.change_type,
    oldValue: c.old_value ? String(c.old_value).slice(0, 300) : null,
    newValue: c.new_value ? String(c.new_value).slice(0, 300) : null,
  }));
  const volume = rows(`
    SELECT platform, scope, system, COUNT(*) count FROM config_changes
    WHERE detected_at >= ? GROUP BY platform, scope, system ORDER BY count DESC LIMIT 20
  `, new Date(Date.now() - 30 * 86400000).toISOString())
    .map((r) => ({ platform: r.platform, scope: r.scope, system: r.system, changes: r.count }));
  const coverage = rows('SELECT DISTINCT platform, scope FROM config_state')
    .map((r) => `${r.platform}/${r.scope}`);
  return {
    generatedAt: new Date().toISOString(),
    windowDays: 30,
    changes,
    changeVolumeBySystem: volume,
    ledgerCoverage: coverage.length ? coverage : ['nothing snapshotted yet'],
    ...gatherLedgerExtras(),
    note: changes.length === 0
      ? 'No configuration changes recorded in the window. The first poll after this feature ships seeds the baseline silently; changes appear from the second poll on.'
      : undefined,
  };
}

// -- 7. Cloud cost posture ----------------------------------------------------

/** AWS FinOps rollup: the FinOps overview plus budgets, open anomalies and the top open recommendations.
 *  Returns { unavailable: true, reason } when the AWS tables or the FinOps service are missing. */
function gatherCloudCostPosture() {
  if (!tableExists('aws_accounts') || !tableExists('aws_budgets')) {
    return { unavailable: true, reason: 'AWS FinOps tables are not present on this instance.' };
  }
  try {
    const awsFinops = require('../awsFinops');
    const metric = getSetting('aws_finops_metric') === 'unblended' ? 'unblended' : 'amortized';
    const overview = awsFinops.buildFinopsOverview({ metric, accountId: null });
    const budgets = rows(`
      SELECT b.name, b.scope_type, b.scope_value, b.amount_usd, s.actual_usd, s.forecast_usd, s.pct_actual, s.state
      FROM aws_budgets b LEFT JOIN aws_budget_status s ON s.budget_id = b.id AND s.month = ?
      WHERE b.enabled = 1 ORDER BY s.pct_actual DESC LIMIT 15
    `, new Date().toISOString().slice(0, 7)).map((r) => ({
      name: r.name, scope: r.scope_type, scopeValue: r.scope_value || null, amountUsd: r.amount_usd,
      actualUsd: r.actual_usd, forecastUsd: r.forecast_usd, pctActual: r.pct_actual, state: r.state || 'unknown',
    }));
    const anomalies = rows(`
      SELECT source, scope_key, start_day, actual_usd, expected_usd, impact_usd, impact_pct
      FROM aws_cost_anomalies WHERE status = 'open' AND superseded_by IS NULL ORDER BY impact_usd DESC LIMIT 10
    `).map((r) => ({
      source: r.source, scope: r.scope_key, since: r.start_day, actualUsd: r.actual_usd,
      expectedUsd: r.expected_usd, impactUsd: r.impact_usd, impactPct: r.impact_pct,
    }));
    const recommendations = rows(`
      SELECT o.finding, o.resource_type, o.resource_id, o.resource_name, o.est_monthly_savings_usd, st.status
      FROM aws_optimizer_recommendations o
      LEFT JOIN aws_recommendation_state st ON st.account_id = o.account_id
        AND st.rec_key = o.source || '|' || o.finding || '|' || o.resource_id
      WHERE COALESCE(st.status, 'open') IN ('open', 'accepted') AND o.est_monthly_savings_usd > 0
      ORDER BY o.est_monthly_savings_usd DESC LIMIT 10
    `).map((r) => ({
      finding: r.finding, resourceType: r.resource_type, resource: r.resource_name || r.resource_id,
      estMonthlySavingsUsd: r.est_monthly_savings_usd, status: r.status || 'open',
    }));
    return {
      generatedAt: new Date().toISOString(),
      metric,
      kpis: overview.kpis,
      mix: overview.mix,
      topMovers: overview.topMovers,
      budgets,
      anomalies,
      recommendations,
      ...gatherCostExtras(),
    };
  } catch (err) {
    return { unavailable: true, reason: `AWS FinOps data could not be read: ${err.message}` };
  }
}

// -- 8. Lifecycle and support ------------------------------------------------

// General-knowledge vendor mainstream support ends, NOT ICC data. Matched against the classified guest OS label.
const PAST_MAINSTREAM = [
  { re: /(rhel|red hat)\D*6\b/i, name: 'RHEL 6' },
  { re: /(rhel|red hat)\D*7\b/i, name: 'RHEL 7' },
  { re: /centos\D*7\b/i, name: 'CentOS 7' },
  { re: /windows server\D*2008\s*r2/i, name: 'Windows Server 2008 R2' },
  { re: /windows server\D*2008/i, name: 'Windows Server 2008' },
  { re: /windows server\D*2012\s*r2/i, name: 'Windows Server 2012 R2' },
  { re: /windows server\D*2012/i, name: 'Windows Server 2012' },
  { re: /windows server\D*2016/i, name: 'Windows Server 2016' },
];

function cmpVersion(a, b) {
  const pa = String(a).split(/[.\-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(/[.\-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function lifecyclePure1() {
  if (!tableExists('pure1_arrays') || !one('SELECT 1 x FROM pure1_arrays LIMIT 1').x) return undefined;
  const ev = require('../pure1Lifecycle').evaluate(new Date());
  const rank = { crit: 0, warn: 1, ok: 2, unknown: 3 };
  const arrays = ev.arrays.slice().sort((a, b) => (rank[a.worst] - rank[b.worst])
    || ((a.hardware.daysToEol ?? 1e9) - (b.hardware.daysToEol ?? 1e9)));
  return {
    sourceTables: 'pure1_subscription_assets (hardware end of life), pure1_support_contracts, pure1_subscriptions, puritySupportTable.json (Purity code)',
    summary: ev.summary,
    purityTable: ev.purityTable,
    worstArrays: arrays.filter((a) => a.worst === 'crit' || a.worst === 'warn').slice(0, 20).map((a) => ({
      array: a.name, model: a.model, purityVersion: a.version, worst: a.worst,
      hardwareEol: iso(a.hardware.endOfLifeDate), daysToHardwareEol: a.hardware.daysToEol, hardwareState: a.hardware.state,
      contractEnd: iso(a.contract.endDate), contractDaysLeft: a.contract.daysLeft, contractState: a.contract.state,
      subscriptionEnd: a.subscription ? iso(a.subscription.expirationDate) : null,
      purityPhase: a.purity.phase, purityEndOfDevelopment: a.purity.end_of_development || null, purityDaysToEol: a.purity.days_to_eol,
    })),
    arraysTotal: ev.arrays.length,
  };
}

function lifecycleNetapp() {
  if (!tableExists('netapp_arrays') || !one('SELECT 1 x FROM netapp_arrays LIMIT 1').x) return undefined;
  const { lookup } = require('../ontapSupportDates');
  const clusters = rows(`
    SELECT COALESCE(NULLIF(a.version, ''), (SELECT n.version FROM netapp_nodes n WHERE n.array_id = a.id AND n.version != '' LIMIT 1)) v
    FROM netapp_arrays a
  `);
  const byVersion = new Map();
  for (const c of clusters) byVersion.set(c.v || '', (byVersion.get(c.v || '') || 0) + 1);
  const now = new Date();
  const versions = [...byVersion.entries()].map(([version, count]) => {
    const s = lookup(version, now);
    return {
      version: version || 'unknown', clusters: count, phase: s.phase, line: s.line,
      endFullSupport: s.end_full_support, endLimitedSupport: s.end_limited_support, endSelfService: s.end_self_service_support,
      daysToEndFullSupport: s.days_to_end_full_support,
    };
  }).sort((a, b) => (a.daysToEndFullSupport ?? 1e9) - (b.daysToEndFullSupport ?? 1e9)).slice(0, 20);
  const clustersByPhase = {};
  for (const v of versions) clustersByPhase[v.phase] = (clustersByPhase[v.phase] || 0) + v.clusters;
  return {
    sourceTables: 'netapp_arrays.version and netapp_nodes.version against ontapSupportTable.json (NetApp KB table, captured snapshot)',
    clusters: clusters.length, clustersByPhase, versions,
  };
}

function lifecycleDell() {
  if (!tableExists('dell_warranties') || !one('SELECT 1 x FROM dell_warranties LIMIT 1').x) return undefined;
  // Best-contract rule: a service tag is judged by its longest remaining contract.
  const best = rows(`
    SELECT w.service_tag, MAX(w.days_remaining) days, MAX(w.end_date) end_date,
      (SELECT d.model FROM dell_devices d WHERE d.service_tag = w.service_tag LIMIT 1) model
    FROM dell_warranties w WHERE w.service_tag IS NOT NULL AND w.days_remaining IS NOT NULL GROUP BY w.ome_id, w.service_tag
  `);
  return {
    sourceTables: 'dell_warranties (best contract per service tag)',
    tagsTracked: best.length,
    expired: best.filter((b) => b.days < 0).length,
    expiringWithin90Days: best.filter((b) => b.days >= 0 && b.days <= 90).length,
    soonest: best.sort((a, b) => a.days - b.days).slice(0, 15).map((b) => ({ model: b.model || null, endDate: b.end_date || null, daysRemaining: b.days })),
  };
}

function lifecycleGuestOs() {
  if (!tableExists('vcenter_vms') || !one('SELECT 1 x FROM vcenter_vms LIMIT 1').x) return undefined;
  const { classifyGuestOs } = require('../vcenterGuestOs');
  const counts = new Map();
  for (const r of rows('SELECT guest_os, guest_os_running, guest_id, guest_family, guest_detailed FROM vcenter_vms')) {
    const c = classifyGuestOs(r);
    const key = `${c.family}|${c.label}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const releases = [...counts.entries()].map(([k, vms]) => { const [family, label] = k.split('|'); return { family, release: label, vms }; })
    .sort((a, b) => b.vms - a.vms);
  const flagged = [];
  for (const r of releases) {
    const hit = PAST_MAINSTREAM.find((p) => p.re.test(r.release));
    if (hit) flagged.push({ release: r.release, vms: r.vms, matchedAs: hit.name });
  }
  return {
    sourceTables: 'vcenter_vms guest OS columns classified by vcenterGuestOs',
    vmsTotal: releases.reduce((n, r) => n + r.vms, 0),
    releases: releases.slice(0, 25),
    pastVendorMainstreamSupport: flagged,
    note: 'The flagged list is a fixed table of releases generally past vendor mainstream support. The dates are general knowledge, not ICC data; ICC holds no OS support dates.',
  };
}

function lifecycleLm() {
  if (!tableExists('lm_devices')) return undefined;
  const groups = new Map();
  for (const r of rows(`
    SELECT COALESCE(vendor_key, vendor, 'unknown') vendor, COALESCE(model, 'unknown') model, version, COUNT(*) n
    FROM lm_devices WHERE stale = 0 AND version IS NOT NULL AND version != '' GROUP BY 1, 2, 3
  `)) {
    const k = `${r.vendor}|${r.model}`;
    if (!groups.has(k)) groups.set(k, { vendor: r.vendor, model: r.model, versions: [] });
    groups.get(k).versions.push({ version: r.version, devices: r.n });
  }
  const out = [];
  for (const g of groups.values()) {
    g.versions.sort((a, b) => cmpVersion(b.version, a.version));
    const newest = g.versions[0].version;
    const behind = g.versions.filter((v) => cmpVersion(v.version, newest) < 0).reduce((n, v) => n + v.devices, 0);
    out.push({ vendor: g.vendor, model: g.model, newestLevel: newest, devicesBehindNewest: behind, levels: g.versions.slice(0, 5) });
  }
  out.sort((a, b) => b.devicesBehindNewest - a.devicesBehindNewest);
  return {
    sourceTables: 'lm_devices.version per vendor and model (the Model Review code level)',
    modelsTotal: out.length,
    devicesBehindNewest: out.reduce((n, g) => n + g.devicesBehindNewest, 0),
    behind: out.filter((g) => g.devicesBehindNewest > 0).slice(0, 20),
    note: 'Behind means older than the newest level seen for the same vendor and model in this estate. No vendor end-of-support dates are held for these devices.',
  };
}

function lifecycleCounts(sql, label) {
  const list = rows(sql).map((r) => ({ [label]: r.v || 'unknown', count: r.n }));
  return list.length ? list.slice(0, 20) : undefined;
}

function lifecycleCohesity() {
  if (!tableExists('metrics_history')) return undefined;
  return lifecycleCounts(`
    SELECT software_version v, COUNT(*) n FROM metrics_history
    WHERE id IN (SELECT MAX(id) FROM metrics_history GROUP BY cluster_id) GROUP BY software_version ORDER BY n DESC
  `, 'softwareVersion');
}

function lifecyclePureDirect() {
  if (!tableExists('pure_metrics_history')) return undefined;
  const { lookup } = require('../puritySupportDates');
  const list = rows(`
    SELECT purity_version v, COUNT(*) n FROM pure_metrics_history
    WHERE id IN (SELECT MAX(id) FROM pure_metrics_history GROUP BY array_id) GROUP BY purity_version ORDER BY n DESC
  `).map((r) => {
    const s = lookup(r.v, new Date());
    return { purityVersion: r.v || 'unknown', arrays: r.n, phase: s.phase, endOfDevelopment: s.end_of_development || null, daysToEol: s.days_to_eol };
  });
  return list.length ? list.slice(0, 20) : undefined;
}

function gatherLifecycleSupport() {
  const out = { generatedAt: new Date().toISOString(), warnWindowDays: 180 };
  const parts = {
    pure1: lifecyclePure1,
    netapp: lifecycleNetapp,
    dell: lifecycleDell,
    vcenterGuestOs: lifecycleGuestOs,
    lmCodeLevels: lifecycleLm,
    cohesityClusters: lifecycleCohesity,
    pureDirectArrays: lifecyclePureDirect,
    brocadeFirmware: () => (tableExists('brocade_switches')
      ? lifecycleCounts("SELECT firmware_version v, COUNT(*) n FROM brocade_switches WHERE stale = 0 GROUP BY firmware_version ORDER BY n DESC", 'firmwareVersion') : undefined),
    hyperv: () => (tableExists('hyperv_hosts')
      ? lifecycleCounts("SELECT COALESCE(os_caption, 'unknown') || ' build ' || COALESCE(os_build, '?') v, COUNT(*) n FROM hyperv_hosts GROUP BY os_caption, os_build ORDER BY n DESC", 'hostOs') : undefined),
  };
  for (const [key, fn] of Object.entries(parts)) {
    try { const v = fn(); if (v !== undefined) out[key] = v; } catch (err) { out[key] = { unavailable: true, reason: String(err.message).slice(0, 120) }; }
  }
  out.sourcesPresent = Object.keys(out).filter((k) => !['generatedAt', 'warnWindowDays'].includes(k));
  if (!out.sourcesPresent.length) out.note = 'No platform with lifecycle data has collected anything yet.';
  return out;
}

// -- 9. Capacity outlook -----------------------------------------------------

/** Rank stores by days to full from daily averages of used and capacity. The query returns k (grouping key),
 *  d (day), used, cap and any label columns; rows with no growth are listed but never extrapolated. */
function capacityTrend(sql, params, shape) {
  const byKey = new Map();
  for (const r of rows(sql, ...params)) {
    if (!byKey.has(r.k)) byKey.set(r.k, []);
    byKey.get(r.k).push(r);
  }
  const items = [];
  for (const pts of byKey.values()) {
    const a = pts[0]; const b = pts[pts.length - 1];
    const span = Math.max(0, Math.round((Date.parse(b.d) - Date.parse(a.d)) / DAY_MS));
    const growth = span > 0 ? (b.used - a.used) / span : null;
    let daysToFull = null;
    if (b.cap > 0 && b.used >= b.cap) daysToFull = 0;
    else if (growth != null && growth > 0 && b.cap > 0) daysToFull = Math.round((b.cap - b.used) / growth);
    items.push({
      ...shape(b),
      used: Math.round(b.used), capacity: Math.round(b.cap), usedPct: b.cap > 0 ? Math.round((b.used / b.cap) * 1000) / 10 : null,
      growthPerDay: growth == null ? null : Math.round(growth), daysToFull, historyDays: span,
      trend: growth == null ? 'not enough history' : (growth > 0 ? 'growing' : 'flat or shrinking'),
    });
  }
  items.sort((x, y) => (x.daysToFull ?? 1e9) - (y.daysToFull ?? 1e9) || (y.usedPct ?? 0) - (x.usedPct ?? 0));
  return { total: items.length, growing: items.filter((i) => i.trend === 'growing').length, ranked: items.slice(0, 15) };
}

function gatherCapacityOutlook() {
  const since = isoAgo(30 * DAY_MS);
  const out = { generatedAt: new Date().toISOString(), windowDays: 30, stores: {} };
  const put = (key, table, build) => {
    if (!tableExists(table)) return;
    try { const v = build(); if (v && v.total > 0) out.stores[key] = v; } catch { /* skip an unreadable store */ }
  };
  const vcNames = new Map(rows('SELECT id, name FROM vcenter_vcenters').map((v) => [v.id, v.name]));

  put('vcenterDatastores', 'vcenter_datastore_history', () => capacityTrend(`
    SELECT h.vcenter_id || '|' || h.datastore_name k, h.vcenter_id vc, h.datastore_name name, date(h.captured_at) d,
           AVG(h.capacity_bytes - h.free_bytes) used, MAX(h.capacity_bytes) cap
    FROM vcenter_datastore_history h WHERE ${GE('h.captured_at')} AND h.capacity_bytes > 0 AND h.free_bytes IS NOT NULL
    GROUP BY h.vcenter_id, h.datastore_name, date(h.captured_at) ORDER BY k, d
  `, [since], (r) => ({ name: r.name, vcenter: vcNames.get(r.vc) || null, unit: 'bytes' })));

  put('vcenterClusterCpu', 'vcenter_capacity_history', () => capacityTrend(`
    SELECT h.vcenter_id || '|' || h.cluster_name k, h.vcenter_id vc, h.cluster_name name, date(h.captured_at) d,
           AVG(h.cpu_mhz_used) used, MAX(h.cpu_mhz_capacity) cap
    FROM vcenter_capacity_history h WHERE ${GE('h.captured_at')} AND h.cpu_mhz_capacity > 0
    GROUP BY h.vcenter_id, h.cluster_name, date(h.captured_at) ORDER BY k, d
  `, [since], (r) => ({ name: r.name, vcenter: vcNames.get(r.vc) || null, unit: 'MHz' })));

  put('vcenterClusterMemory', 'vcenter_capacity_history', () => capacityTrend(`
    SELECT h.vcenter_id || '|' || h.cluster_name k, h.vcenter_id vc, h.cluster_name name, date(h.captured_at) d,
           AVG(h.mem_bytes_used) used, MAX(h.mem_bytes_capacity) cap
    FROM vcenter_capacity_history h WHERE ${GE('h.captured_at')} AND h.mem_bytes_capacity > 0
    GROUP BY h.vcenter_id, h.cluster_name, date(h.captured_at) ORDER BY k, d
  `, [since], (r) => ({ name: r.name, vcenter: vcNames.get(r.vc) || null, unit: 'bytes' })));

  put('hypervVolumes', 'hyperv_volume_history', () => capacityTrend(`
    SELECT h.source_id || '|' || COALESCE(h.host_name, '') || '|' || h.volume_name k, h.volume_name name, h.host_name host, date(h.captured_at) d,
           AVG(h.capacity_bytes - h.free_bytes) used, MAX(h.capacity_bytes) cap
    FROM hyperv_volume_history h WHERE ${GE('h.captured_at')} AND h.capacity_bytes > 0 AND h.free_bytes IS NOT NULL
    GROUP BY h.source_id, h.host_name, h.volume_name, date(h.captured_at) ORDER BY k, d
  `, [since], (r) => ({ name: r.name, host: r.host || null, unit: 'bytes' })));

  put('netappClusters', 'netapp_metrics_history', () => capacityTrend(`
    SELECT h.array_id k, a.name name, date(h.captured_at) d, AVG(h.used_bytes) used, MAX(h.total_bytes) cap
    FROM netapp_metrics_history h JOIN netapp_arrays a ON a.id = h.array_id
    WHERE ${GE('h.captured_at')} AND h.total_bytes > 0 AND h.used_bytes IS NOT NULL
    GROUP BY h.array_id, date(h.captured_at) ORDER BY k, d
  `, [since], (r) => ({ name: r.name, unit: 'bytes' })));

  put('pureArrays', 'pure_metrics_history', () => capacityTrend(`
    SELECT h.array_id k, a.name name, date(h.captured_at) d, AVG(h.used_bytes) used, MAX(h.capacity_bytes) cap
    FROM pure_metrics_history h JOIN pure_arrays a ON a.id = h.array_id
    WHERE ${GE('h.captured_at')} AND h.capacity_bytes > 0 AND h.used_bytes IS NOT NULL
    GROUP BY h.array_id, date(h.captured_at) ORDER BY k, d
  `, [since], (r) => ({ name: r.name, unit: 'bytes' })));

  put('cohesityClusters', 'metrics_history', () => capacityTrend(`
    SELECT h.cluster_id k, c.name name, date(h.captured_at) d, AVG(h.used_bytes) used, MAX(h.total_capacity_bytes) cap
    FROM metrics_history h JOIN clusters c ON c.id = h.cluster_id
    WHERE ${GE('h.captured_at')} AND h.total_capacity_bytes > 0 AND h.used_bytes IS NOT NULL
    GROUP BY h.cluster_id, date(h.captured_at) ORDER BY k, d
  `, [since], (r) => ({ name: r.name, unit: 'bytes' })));

  if (tableExists('netapp_aggregates')) {
    const aggs = rows(`
      SELECT g.name, a.name cluster, g.used_percent, g.size_bytes FROM netapp_aggregates g JOIN netapp_arrays a ON a.id = g.array_id
      WHERE g.used_percent IS NOT NULL ORDER BY g.used_percent DESC LIMIT 15
    `);
    if (aggs.length) {
      out.stores.netappAggregatesNow = {
        total: countOf('SELECT COUNT(*) n FROM netapp_aggregates'),
        note: 'Current state only; ICC keeps no per-aggregate history.',
        fullest: aggs.map((g) => ({ aggregate: g.name, cluster: g.cluster, usedPct: g.used_percent, sizeBytes: g.size_bytes })),
      };
    }
  }

  if (tableExists('aws_ec2_metrics_daily')) {
    const per = rows(`
      SELECT instance_id, AVG(cpu_avg) avg, MAX(cpu_max) max, COUNT(*) days FROM aws_ec2_metrics_daily
      WHERE day >= ? GROUP BY instance_id
    `, dayAgo(30));
    if (per.length) {
      out.stores.awsEc2Cpu = {
        instances: per.length,
        idleUnder5PctAvg: per.filter((p) => p.days >= 7 && p.avg < 5).length,
        busiest: per.sort((a, b) => b.avg - a.avg).slice(0, 10).map((p) => ({ instance: p.instance_id, avgCpuPct: Math.round(p.avg * 10) / 10, maxCpuPct: Math.round(p.max * 10) / 10, days: p.days })),
        note: 'CPU only; no capacity ceiling or days to full applies.',
      };
    }
  }

  if (tableExists('eon_storage_summary')) {
    const per = new Map();
    for (const r of rows('SELECT source_id, summary_day d, daily_storage_bytes b FROM eon_storage_summary WHERE summary_day >= ? ORDER BY source_id, summary_day', dayAgo(30))) {
      if (!per.has(r.source_id)) per.set(r.source_id, []);
      per.get(r.source_id).push(r);
    }
    const eon = [...per.values()].filter((p) => p.length).map((p) => {
      const a = p[0]; const b = p[p.length - 1];
      const span = Math.max(0, Math.round((Date.parse(b.d) - Date.parse(a.d)) / DAY_MS));
      return { storedBytes: b.b, growthBytesPerDay: span > 0 ? Math.round((b.b - a.b) / span) : null, historyDays: span };
    });
    if (eon.length) out.stores.eonBackupStorage = { sources: eon.length, items: eon.slice(0, 10), note: 'EON reports stored bytes with no capacity ceiling, so there is no days to full.' };
  }

  out.storesPresent = Object.keys(out.stores);
  if (!out.storesPresent.length) out.note = 'No store has 30 days of capacity history yet.';
  return out;
}

// -- 10. Operations agent review ---------------------------------------------

function resolutionKind(r) {
  if (r.resolved_by && r.resolved_by !== 'agent') return 'human';
  if (r.classification === 'self-healed') return 'self-healed';
  const text = String(r.resolution || '');
  if (/cleared before the hold window/i.test(text)) return 'self-cleared';
  if (/resolved by other means/i.test(text)) return 'evidence';
  if (/returned to normal/i.test(text) || /watching episodes no longer open/i.test(text)) return 'observation-closed';
  if (/closed this incident|every alert .*cleared/i.test(text)) return 'quiet';
  return 'other';
}

function gatherOpsAgentReview() {
  const since = isoAgo(30 * DAY_MS);
  const out = { generatedAt: new Date().toISOString(), windowDays: 30 };
  if (!tableExists('ops_incidents')) return { ...out, note: 'The Operations Agent has no data on this instance.' };

  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  const toList = (map, nameKey) => [...map.entries()].map(([k, n]) => ({ [nameKey]: k, count: n })).sort((a, b) => b.count - a.count);

  const resolved = rows(`
    SELECT opened_at, resolved_at, resolved_by, classification, resolution, platforms FROM ops_incidents
    WHERE baseline = 0 AND state = 'resolved' AND ${GE('resolved_at')}
  `, since);
  const kinds = new Map(); const mins = [];
  for (const r of resolved) {
    bump(kinds, resolutionKind(r));
    const m = (Date.parse(r.resolved_at) - Date.parse(r.opened_at)) / 60000;
    if (Number.isFinite(m) && m >= 0) mins.push(m);
  }
  mins.sort((a, b) => a - b);
  const byPlatform = new Map();
  for (const r of rows(`SELECT platforms FROM ops_incidents WHERE baseline = 0 AND ${GE('opened_at')}`, since)) {
    for (const p of parseJson(r.platforms, [])) bump(byPlatform, p);
  }
  out.incidents = {
    opened: countOf(`SELECT COUNT(*) n FROM ops_incidents WHERE baseline = 0 AND ${GE('opened_at')}`, since),
    resolved: resolved.length,
    openNow: countOf("SELECT COUNT(*) n FROM ops_incidents WHERE baseline = 0 AND state != 'resolved'"),
    baselineIncidentsExcluded: countOf('SELECT COUNT(*) n FROM ops_incidents WHERE baseline = 1'),
    resolvedBy: toList(kinds, 'kind'),
    byPlatform: toList(byPlatform, 'platform').slice(0, 15),
    byClassification: rows(`SELECT COALESCE(classification, 'not triaged') classification, COUNT(*) count FROM ops_incidents WHERE baseline = 0 AND ${GE('opened_at')} GROUP BY classification ORDER BY count DESC`, since)
      .map((r) => ({ classification: r.classification, count: r.count })),
    minutesOpenBeforeResolve: mins.length ? { mean: Math.round(mins.reduce((a, b) => a + b, 0) / mins.length), median: Math.round(mins[Math.floor(mins.length / 2)]), max: Math.round(mins[mins.length - 1]) } : null,
    triageErrors: countOf(`SELECT COUNT(*) n FROM ops_incidents WHERE baseline = 0 AND triage_error IS NOT NULL AND ${GE('opened_at')}`, since),
  };
  out.humanRequired = {
    openNow: countOf("SELECT COUNT(*) n FROM ops_incidents WHERE requires_human = 1 AND state != 'resolved'"),
    openAndAcknowledged: countOf("SELECT COUNT(*) n FROM ops_incidents WHERE requires_human = 1 AND state != 'resolved' AND acknowledged_at IS NOT NULL"),
    resolvedInWindow: countOf(`SELECT COUNT(*) n FROM ops_incidents WHERE requires_human = 1 AND state = 'resolved' AND ${GE('resolved_at')}`, since),
  };
  out.repeats = rows(`
    SELECT MAX(title) title, MAX(host) host, COUNT(*) n, MAX(opened_at) last_opened FROM ops_incidents
    WHERE baseline = 0 AND ${GE('opened_at')} GROUP BY incident_key HAVING COUNT(*) >= 3 ORDER BY n DESC LIMIT 10
  `, since).map((r) => ({ title: r.title, host: r.host, timesOpened: r.n, lastOpened: r.last_opened }));
  out.notifications = {
    emailed: countOf(`SELECT COUNT(*) n FROM ops_incidents WHERE notified_at IS NOT NULL AND ${GE('notified_at')}`, since),
    emailErrors: countOf(`SELECT COUNT(*) n FROM ops_incidents WHERE email_error IS NOT NULL AND ${GE('opened_at')}`, since),
    teamsPosted: countOf(`SELECT COUNT(*) n FROM ops_incidents WHERE teams_notified_at IS NOT NULL AND ${GE('teams_notified_at')}`, since),
    teamsErrors: countOf(`SELECT COUNT(*) n FROM ops_incidents WHERE teams_error IS NOT NULL AND ${GE('opened_at')}`, since),
  };
  if (tableExists('ops_incident_analyses')) {
    out.analyses = {
      total: countOf(`SELECT COUNT(*) n FROM ops_incident_analyses WHERE ${GE('at')}`, since),
      byTrigger: rows(`SELECT trigger, COUNT(*) count FROM ops_incident_analyses WHERE ${GE('at')} GROUP BY trigger ORDER BY count DESC`, since)
        .map((r) => ({ trigger: r.trigger, count: r.count })),
      models: rows(`SELECT COALESCE(model, 'rule-based') model, COUNT(*) count FROM ops_incident_analyses WHERE ${GE('at')} GROUP BY model ORDER BY count DESC LIMIT 10`, since)
        .map((r) => ({ model: r.model, count: r.count })),
      withError: countOf(`SELECT COUNT(*) n FROM ops_incident_analyses WHERE error IS NOT NULL AND ${GE('at')}`, since),
    };
  }
  if (tableExists('ops_capability_runs')) {
    out.capabilityRuns = {
      total: countOf(`SELECT COUNT(*) n FROM ops_capability_runs WHERE ${GE('ran_at')}`, since),
      byCapability: rows(`
        SELECT capability, COUNT(*) runs, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) failed FROM ops_capability_runs
        WHERE ${GE('ran_at')} GROUP BY capability ORDER BY runs DESC LIMIT 20
      `, since).map((r) => ({ capability: r.capability, runs: r.runs, failed: r.failed || 0 })),
      requestedBy: rows(`SELECT COALESCE(requested_by, 'playbook') who, COUNT(*) count FROM ops_capability_runs WHERE ${GE('ran_at')} GROUP BY who ORDER BY count DESC`, since)
        .map((r) => ({ requestedBy: r.who, count: r.count })),
    };
  }
  if (tableExists('ops_observations')) {
    out.observations = {
      openNow: countOf("SELECT COUNT(*) n FROM ops_observations WHERE state != 'closed'"),
      closedByOutcome: rows(`SELECT COALESCE(outcome, 'none') outcome, COUNT(*) count FROM ops_observations WHERE state = 'closed' AND ${GE('closed_at')} GROUP BY outcome ORDER BY count DESC`, since)
        .map((r) => ({ outcome: r.outcome, count: r.count })),
      mostEpisodes: rows(`
        SELECT subject_label, observer_id, COUNT(*) n FROM ops_observations WHERE ${GE('opened_at')}
        GROUP BY subject_key, observer_id ORDER BY n DESC LIMIT 10
      `, since).map((r) => ({ subject: r.subject_label, observer: r.observer_id, episodes: r.n })),
    };
  }
  try {
    const s = require('../settings').getOpsAgentSettings();
    out.settings = {
      enabled: s.enabled, grouping: s.grouping, minSeverity: s.minSeverity, holdMinutes: s.holdMinutes,
      renotifyMinutes: s.renotifyMinutes, autoResolveMinutes: s.autoResolveMinutes, patternMin: s.patternMin, patternDays: s.patternDays,
      stickyRepeats: s.stickyRepeats, reminderHours: s.reminderHours, capabilityMode: s.capabilityMode, deepPass: s.deepPass,
      analysesPerHour: s.analysesPerHour, evidenceResolve: s.evidenceResolve, emailEnabled: s.emailEnabled, teamsEnabled: s.teamsEnabled,
    };
  } catch { /* settings unreadable */ }
  if (!out.incidents.opened && !out.incidents.resolved) out.note = 'The Operations Agent opened no incidents in the window.';
  return out;
}

const advisor = createPlatformAdvisor({
  platform: 'estate',
  feature: 'Estate AI Advisor',
  table: 'estate_ai_reports',
  reports: {
    daily_brief: {
      system:
        'You are the overnight operations lead writing the morning handoff for an infrastructure estate. You are ' +
        'given per-platform service status (state, open events, unreachable sources), the open incidents ranked by ' +
        'impact (with classification and whether a human is required), application services not operational, and ' +
        'the last 24 hours of incident counts. Write the brief a day-shift engineer reads in two minutes: what needs ' +
        'a person today (in order), what changed overnight, and what is degraded but stable. Do not invent data and ' +
        'do not pad; a quiet estate deserves a short brief that says so. Markdown sections: **Needs a person today**, ' +
        '**Overnight changes**, **Degraded but stable**, **Estate at a glance**. Keep under ~400 words. ' +
        'When the data carries a network block it comes from LogicMonitor: dead devices, collectors down, WAN circuits that are ' +
        'not ok, open latency episodes (watching, degrading, critical), sites with a critical condition, neighbours ICC cannot ' +
        'see and open alerts by severity. Fold it into the brief where it matters (a critical site or circuit belongs under needs ' +
        'a person today) and leave it out when it is quiet. ' +
        'When present, lmServices lists the admin-picked LogicMonitor services (state, devices, failed, degraded) and ' +
        'serviceTimeline24h counts their state changes in the last 24 hours; siteWan lists sites whose WAN is not ok; ' +
        'observations counts the sustained-signal watches by state and lists subjects that are degrading or critical; ' +
        'humanRequired lists incidents that stay open until a person resolves them; eonFindingsOpen, awsAnomaliesOpen and ' +
        'hypervBrief summarise EON threat findings, open AWS cost anomalies and the Hyper-V estate; last24h also counts agent ' +
        'live checks and analysis passes. A key that is missing means that platform holds no data, not that it is healthy.',
      gather: gatherDailyBrief,
      noun: 'estate daily brief',
    },
    network_dependency: {
      system:
        'You are assessing how much each application service depends on the network under it. You are given the watched ' +
        'applications with their state and a network summary: the sites their servers sit in (with dead network devices, WAN ' +
        'circuits and their state, open latency episodes, collectors down), servers that depend on a single switch, servers ' +
        'with no switch path in LogicMonitor, port and reachability problems, plus estate-wide WAN circuits that are not ok, ' +
        'critical sites, checks whose one-off latency episodes keep repeating and neighbours ICC cannot monitor. Rank the ' +
        'applications by network risk (dead network device at a site, degraded WAN, open episodes, single-switch servers, ' +
        'unresolved servers), name the single points of failure, and say what to verify first. A site problem makes an app ' +
        'degraded, not down, because the app may not ride the failing link; do not claim an outage the data does not show. ' +
        'Write plain sentences; pipe tables are fine. Do not invent data and do not praise any vendor. ' +
        'Markdown sections: **Network risk ranking**, **Single points of failure**, **Estate network conditions**, ' +
        '**Verify first**. Keep under ~450 words. ' +
        'The data may also carry lmServices (admin-picked LogicMonitor services with state and device counts, plus their ' +
        'state changes in the last 24 hours), siteWan (sites whose WAN is down, degraded or flapping), circuitEvents7d ' +
        '(down, up, flap and saturation events by kind and the ten noisiest circuits) and derivedPlatforms (F5 and Cisco ' +
        'device counts with dead counts, Meraki under Cisco). Use them where they change the ranking.',
      gather: gatherNetworkDependency,
      noun: 'network dependency assessment',
    },
    certificate_audit: {
      system:
        'You are preparing a certificate expiry audit across an infrastructure estate. You are given every ' +
        'certificate ICC tracks (Pure arrays, vCenter, Brocade switch and chassis TLS, Hyper-V WinRM TLS, Okta SAML ' +
        'signing certificates, and ISE and F5 certificates flagged by LogicMonitor) sorted by days remaining, ' +
        'with expired counts and 30/60/90 day buckets, plus a statement of coverage. Give the renewal work list in ' +
        'date order, grouped where one system carries several certificates, and state the coverage limits plainly so ' +
        'nobody mistakes this for the whole estate. Do not invent data. Markdown sections: **Summary**, ' +
        '**Renewal work list (date order)**, **Coverage and gaps**. Keep under ~350 words.',
      gather: gatherCertificateAudit,
      noun: 'certificate expiry audit',
    },
    access_review: {
      system:
        'You are running a quarterly access review of the ICC monitoring platform itself, producing evidence an ' +
        'auditor can file. You are given every account (provider, active flag, last login, dormancy at 90 days, ' +
        'group membership), each group with its permissions and member count, direct user grants, holders of the ' +
        'full *:*:* wildcard, service accounts with their permissions and last use, and 30 days of audit-log action ' +
        'counts. When present, logicmonitorAccounts lists LogicMonitor portal accounts (status, ' +
        'roles, last login, MFA, API-only service accounts, API token count); flag ones without MFA, suspended or ' +
        'never-logged-in accounts that still hold tokens, and API-only accounts with admin roles. Flag dormant accounts still active, wildcard holders, service accounts unused in ' +
        '90 days, direct grants that bypass groups, and unguarded destructive backup operations. Recommend specific ' +
        'revocations or reviews by name. Do not invent data. ' +
        'When present, ssoUsers counts accounts by sign-in source, idpProviders lists the identity providers (protocol, enabled, ' +
        'Okta sync status, groups linked) and directorySync lists the last Active Directory sync runs; flag a provider whose ' +
        'sync failed or has not run, and accounts that sign in outside the provider that should own them. ' +
        'Markdown sections: **Access summary**, **Findings (prioritized)**, **Recommended recertification actions**. ' +
        'Keep under ~400 words.',
      gather: gatherAccessReview,
      noun: 'access review',
    },
    recovery_readiness: {
      system:
        'You are a ransomware-recovery and DR assessor. Recovery planning assumes the attacker was resident before ' +
        'detection. You are given per-application service state (VMs offline, stale backups, missing SAN paths, ' +
        'inaccessible datastores), estate-wide Cohesity backup posture (protected, unprotected, protected-but-stale ' +
        'against the configured threshold), Zerto replication (unhealthy VPGs, RPO breaches, short journals, ' +
        'disconnected sites, worst VPGs), NetApp SnapMirror health and lag, Pure protection-group coverage, and EON ' +
        'cloud backup posture (unprotected resources with PROD called out, failed jobs, snapshots under legal or ' +
        'security hold, open threat findings, worst unprotected resources). When present you also get Hyper-V replication ' +
        'health and checkpoints older than 7 days, Cohesity protection runs for 7 days with the failing groups, Zerto events ' +
        'for 24 hours and VRA status, EON vaults by region and EON restores for 7 days. A missing key means that platform holds ' +
        'no data. ' +
        'Rate estate recovery readiness, then rate each named application that has a weakness, always naming the ' +
        'weakest link (a stale backup, a breached RPO, a short journal). Say what one fix buys the most recovery ' +
        'confidence. Do not invent data. Markdown sections: **Readiness rating**, **Per-application findings**, ' +
        '**Estate-wide gaps**, **The one fix that buys the most**. Keep under ~450 words.',
      gather: gatherRecoveryReadiness,
      noun: 'recovery readiness scorecard',
    },
    change_ledger: {
      system:
        'You are a configuration change auditor. You are given 30 days of the estate change ledger: every recorded ' +
        'add, change and removal of configuration the ledger tracks, the change volume per system, and the scopes it ' +
        'covers (the scopes key lists every platform and scope with the items tracked; name only scopes that appear there). ' +
        'When present, ariaLedger30d lists Aria deployments added and removed in 30 days. Summarize what ' +
        'changed, single out changes that widened access (a new client on an export, a new member in a privileged ' +
        'group, a new share), and note systems changing unusually often. State the coverage limits plainly. Do not ' +
        'invent data and do not claim intent, only what changed and when. Markdown sections: **Change summary**, ' +
        '**Access-widening changes**, **Noisy systems**, **Coverage**. Keep under ~400 words.',
      gather: gatherChangeLedger,
      noun: 'configuration change audit',
    },
    cloud_cost_posture: {
      system:
        'You are a FinOps analyst summarizing cloud cost posture for an infrastructure team. You are given the AWS ' +
        'month-to-date spend, the end-of-month forecast with its source, month over month change, commitment ' +
        '(Savings Plan) coverage and utilization, the cost mix by service, the biggest movers against last month, ' +
        'budget status, open cost anomalies, the top open savings recommendations and the share of spend with no ' +
        'allocation tag. When present you also get Savings Plan and reserved instance utilization and coverage, the latest ' +
        'forecast rows, FinOps capabilities that are denied or not enabled, EON backup cost for 30 days against the prior ' +
        '30, and Lightsail inventory counts; the present key lists which of these exist, so cover only those. ' +
        'Say where the money is going, what changed, which budgets are at risk and which open ' +
        'recommendation is worth doing first. If the data says unavailable, say the AWS FinOps data is not ' +
        'present and stop. Do not invent data and do not praise any vendor. Markdown sections: **Spend and ' +
        'forecast**, **What moved**, **Budgets and anomalies**, **Savings worth doing first**. Keep under ~350 words.',
      gather: gatherCloudCostPosture,
      noun: 'cloud cost posture report',
    },
    lifecycle_support: {
      system:
        'You are preparing a hardware and software lifecycle review for an infrastructure estate. Flag anything past or ' +
        'within 180 days of end of support, state the source table for each date, and never invent a date the data does ' +
        'not carry. You are given, per platform that has data: Pure1 hardware end of life, support contract and subscription ' +
        'end dates and Purity code phase; NetApp ONTAP release support phases from a captured NetApp table; Dell warranty ' +
        '(best contract per service tag); vCenter guest OS releases with a list of releases generally past vendor mainstream ' +
        'support (general knowledge, not ICC data); LogicMonitor device code levels behind the newest level seen per model; ' +
        'and version counts for Cohesity, direct Pure arrays, Brocade firmware and Hyper-V hosts. Platforms with no ' +
        'vendor date source (Cohesity, Brocade, Hyper-V, LogicMonitor devices) show versions only; say so rather than ' +
        'judging them. The sourcesPresent key lists what exists. Markdown sections: **Past or inside 180 days**, ' +
        '**Version spread (no vendor dates held)**, **Coverage and gaps**. Keep under ~450 words.',
      gather: gatherLifecycleSupport,
      noun: 'estate lifecycle and support review',
    },
    capacity_outlook: {
      system:
        'You are a capacity planner. For each store state used, capacity, 30-day growth per day and days to full as given; ' +
        'rank by days to full; do not extrapolate where growth is zero or negative. The data covers vCenter datastores and ' +
        'cluster CPU and memory, Hyper-V volumes, NetApp clusters, direct Pure arrays and Cohesity clusters (daily averages ' +
        'over 30 days), the fullest NetApp aggregates right now (no history), AWS EC2 CPU, and EON stored bytes (no capacity ' +
        'ceiling, so growth only). Stores with fewer than two days of history show not enough history; do not rank them. ' +
        'The storesPresent key lists which stores have data. Markdown sections: **Fullest first (days to full)**, ' +
        '**Growing fast but not close**, **No usable history**, **Coverage**. Keep under ~400 words.',
      gather: gatherCapacityOutlook,
      noun: 'estate capacity outlook',
    },
    ops_agent_review: {
      system:
        'You are reviewing how the ICC Operations Agent performed over the last 30 days: what it opened, triaged, checked ' +
        'live, healed itself, escalated to a person, and what keeps repeating. You are given incident counts by resolution ' +
        'kind (human, self-healed, self-cleared, quiet, evidence, observation-closed), by platform and by classification; time ' +
        'open before resolve; incidents that need a person; repeating incidents; triage passes by trigger and model; live ' +
        'checks by capability and who requested them; observation outcomes; email and Teams counts; and the agent settings in ' +
        'force. Recommend threshold or profile changes only where the data shows noise or misses, and name the setting. ' +
        'A high self-cleared or observation-closed share means noise; a long-lived repeat means a person has not fixed a ' +
        'cause. Do not invent data. Markdown sections: **What the agent did**, **Noise**, **What keeps coming back**, ' +
        '**Recommended setting changes**. Keep under ~400 words.',
      gather: gatherOpsAgentReview,
      noun: 'operations agent review',
    },
  },
});

// Exposed for tests that exercise a block directly.
advisor._gathers = { gatherCostExtras };
module.exports = advisor;
