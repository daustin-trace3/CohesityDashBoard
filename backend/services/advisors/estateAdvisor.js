// Estate AI Advisor: cross-platform reports built from what ICC already
// holds. Every table access is guarded, because a slim install may lack a
// platform's tables entirely.
const db = require('../../db/database');
const { createPlatformAdvisor, fmtBytes } = require('../platformAdvisor');
const { getSetting } = require('../settings');

// Global accounts exist only on the multi-tenant branch; on a single-tenant
// build the require fails and the per-tenant tables carry everything.
let globalAccounts = null;
try { globalAccounts = require('../../core/accounts'); } catch { /* single-tenant branch */ }

function tableExists(name) {
  try { return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name); }
  catch { return false; }
}

function rows(sql, ...params) {
  try { return db.prepare(sql).all(...params); } catch { return []; }
}

function one(sql, ...params) {
  try { return db.prepare(sql).get(...params) || {}; } catch { return {}; }
}

// ── 1. Daily brief ──────────────────────────────────────────────────────────

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

  const day = one(`
    SELECT COUNT(*) opened,
           SUM(CASE WHEN state = 'resolved' AND resolved_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) resolvedToday
    FROM ops_incidents WHERE opened_at >= datetime('now', '-1 day')
  `);
  const resolved24 = one("SELECT COUNT(*) n FROM ops_incidents WHERE state = 'resolved' AND resolved_at >= datetime('now', '-1 day')");
  const emailed24 = one("SELECT COUNT(*) n FROM ops_incidents WHERE notified_at >= datetime('now', '-1 day')");

  return {
    generatedAt: new Date().toISOString(),
    platformStatus: platforms,
    openIncidentsByImpact: incidents,
    appServicesNotOperational: apps,
    network,
    last24h: { incidentsOpened: day.opened || 0, incidentsResolved: resolved24.n || 0, analysesEmailed: emailed24.n || 0 },
    note: platforms.length === 0 && incidents.length === 0 ? 'Service Status and the Ops Agent have no data yet.' : undefined,
  };
}

// ── 2. Certificate audit ────────────────────────────────────────────────────

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
  out.sort((a, b) => a.daysLeft - b.daysLeft);
  const bucket = (lo, hi) => out.filter((c) => c.daysLeft >= lo && c.daysLeft < hi).length;
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      certificatesTracked: out.length,
      expired: out.filter((c) => c.daysLeft < 0).length,
      within30Days: bucket(0, 30), within60Days: bucket(30, 60), within90Days: bucket(60, 90),
    },
    expiringSoonest: out.slice(0, 60),
    coverage: 'Pure array certificates, vCenter certificates, Brocade switch and chassis TLS. Other platforms do not expose certificate expiry to ICC yet.',
    note: out.length === 0 ? 'No certificate data collected yet.' : undefined,
  };
}

// ── 3. Access review ────────────────────────────────────────────────────────

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
    WHERE at >= datetime('now', '-30 days') GROUP BY action ORDER BY count DESC LIMIT 20
  `).map((r) => ({ action: r.action, count: r.count }));

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
    reviewWindow: { dormantAfterDays: 90 },
    note: globalNote,
  };
}

// ── 4. Recovery readiness ───────────────────────────────────────────────────

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

  return {
    generatedAt: new Date().toISOString(),
    appServices: apps,
    cohesityBackup: backup,
    zertoReplication: zerto,
    netappSnapMirror: snapmirror,
    pureProtection: pure,
    note: apps.length === 0 ? 'No app services are on the watch list; per-application ratings need the App Services watch list filled.' : undefined,
  };
}

// ── 5. Change ledger ────────────────────────────────────────────────────────

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
    };
  } catch (err) {
    return { unavailable: true, reason: `AWS FinOps data could not be read: ${err.message}` };
  }
}

module.exports = createPlatformAdvisor({
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
        'a person today) and leave it out when it is quiet.',
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
        '**Verify first**. Keep under ~450 words.',
      gather: gatherNetworkDependency,
      noun: 'network dependency assessment',
    },
    certificate_audit: {
      system:
        'You are preparing a certificate expiry audit across an infrastructure estate. You are given every ' +
        'certificate ICC tracks (Pure arrays, vCenter, Brocade switch and chassis TLS) sorted by days remaining, ' +
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
        'never-logged-in accounts that still hold tokens, and API-only accounts with admin roles. Flag dormant accounts still active, wildcard holders, service accounts unused in 90 days, and ' +
        'direct grants that bypass groups. Recommend specific revocations or reviews by name. Do not invent data. ' +
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
        'disconnected sites, worst VPGs), NetApp SnapMirror health and lag, and Pure protection-group coverage. ' +
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
        'add, change and removal of security-relevant configuration (NFS export rules, CIFS shares, AD group ' +
        'membership), the change volume per system, and which config classes the ledger covers. Summarize what ' +
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
        'allocation tag. Say where the money is going, what changed, which budgets are at risk and which open ' +
        'recommendation is worth doing first. If the data says unavailable, say the AWS FinOps data is not ' +
        'present and stop. Do not invent data and do not praise any vendor. Markdown sections: **Spend and ' +
        'forecast**, **What moved**, **Budgets and anomalies**, **Savings worth doing first**. Keep under ~350 words.',
      gather: gatherCloudCostPosture,
      noun: 'cloud cost posture report',
    },
  },
});
