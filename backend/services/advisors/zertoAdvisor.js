const db = require('../../db/database');
const { createPlatformAdvisor, linReg, parseUtcMs, fmtBytes } = require('../platformAdvisor');

function gatherDrReadiness() {
  const vpgs = db.prepare(`
    SELECT vpg_identifier, name, vms_count, protected_site, recovery_site, actual_rpo, configured_rpo,
           actual_journal_history, configured_journal_history, health, status, sub_status
    FROM zerto_vpgs ORDER BY (health != 'Healthy') DESC, actual_rpo DESC LIMIT 40
  `).all().map(v => ({
    vpg: v.name,
    vms: v.vms_count,
    protectedSite: v.protected_site,
    recoverySite: v.recovery_site,
    actualRpoSeconds: v.actual_rpo,
    configuredRpoSeconds: v.configured_rpo,
    rpoBreached: v.configured_rpo != null && v.actual_rpo != null ? v.actual_rpo > v.configured_rpo : null,
    actualJournalHistoryHours: v.actual_journal_history,
    configuredJournalHistoryHours: v.configured_journal_history,
    journalShort: v.configured_journal_history > 0 && v.actual_journal_history != null
      ? v.actual_journal_history < v.configured_journal_history : null,
    health: v.health,
    status: v.status,
    subStatus: v.sub_status,
  }));
  const vpgTotals = db.prepare(`
    SELECT COUNT(*) total, SUM(CASE WHEN health='Healthy' THEN 1 ELSE 0 END) healthy
    FROM zerto_vpgs
  `).get();
  const sites = db.prepare(`
    SELECT name, site_type, connection_status, last_connection_time, is_transmission_enabled
    FROM zerto_sites
  `).all().map(s => ({
    site: s.name,
    type: s.site_type,
    connectionStatus: s.connection_status,
    lastConnectionTime: s.last_connection_time,
    transmissionEnabled: !!s.is_transmission_enabled,
  }));
  const vras = db.prepare(`
    SELECT site_name, name, status, progress FROM zerto_vras ORDER BY (status != 'Installed') DESC LIMIT 30
  `).all().map(v => ({ site: v.site_name, vra: v.name, status: v.status, progress: v.progress }));
  return {
    generatedAt: new Date().toISOString(),
    vpgSummary: { total: vpgTotals.total || 0, healthy: vpgTotals.healthy || 0, unhealthy: (vpgTotals.total || 0) - (vpgTotals.healthy || 0) },
    vpgs,
    sites,
    vras,
    note: (vpgTotals.total || 0) === 0 ? 'No VPGs discovered.' : undefined,
  };
}

function gatherCapacityLicensing() {
  const vmTotals = db.prepare(`
    SELECT COUNT(*) count, SUM(provisioned_storage_mb) provisioned, SUM(used_storage_mb) used
    FROM zerto_vms
  `).get();
  const topVms = db.prepare(`
    SELECT name, provisioned_storage_mb, used_storage_mb, protected_site, recovery_site
    FROM zerto_vms ORDER BY used_storage_mb DESC LIMIT 20
  `).all().map(v => ({
    vm: v.name,
    provisioned: fmtBytes((v.provisioned_storage_mb || 0) * 1024 * 1024),
    used: fmtBytes((v.used_storage_mb || 0) * 1024 * 1024),
    protectedSite: v.protected_site,
    recoverySite: v.recovery_site,
  }));

  const history = db.prepare(`
    SELECT captured_at, used_storage_mb FROM zerto_metrics_history
    WHERE captured_at >= datetime('now', '-30 days') ORDER BY captured_at ASC
  `).all();
  const pts = history.filter(h => h.used_storage_mb != null).map(h => ({ x: parseUtcMs(h.captured_at), y: h.used_storage_mb }));
  const reg = linReg(pts);
  const growthMbPerDay = reg ? reg.slope * 86400000 : 0;

  const licenses = db.prepare(`
    SELECT license_package, available_vms, used_vms, expiration_date FROM zerto_licenses
  `).all().map(l => ({
    package: l.license_package,
    usedVms: l.used_vms,
    availableVms: l.available_vms,
    utilizationPct: l.available_vms > 0 ? +((l.used_vms / l.available_vms) * 100).toFixed(1) : null,
    expirationDate: l.expiration_date,
  }));

  return {
    generatedAt: new Date().toISOString(),
    protectedStorage: {
      vmCount: vmTotals.count || 0,
      provisioned: fmtBytes((vmTotals.provisioned || 0) * 1024 * 1024),
      used: fmtBytes((vmTotals.used || 0) * 1024 * 1024),
      growthPerDay: growthMbPerDay > 0 ? fmtBytes(growthMbPerDay * 1024 * 1024) + '/day' : 'flat/declining',
      dataPoints: history.length,
    },
    topVms,
    licenses,
    note: (vmTotals.count || 0) === 0 ? 'No protected VMs discovered.' : undefined,
  };
}

function gatherAlertTriage() {
  const totals = db.prepare(`
    SELECT COUNT(*) total, SUM(CASE WHEN severity='Error' THEN 1 ELSE 0 END) error, SUM(CASE WHEN severity='Warning' THEN 1 ELSE 0 END) warning
    FROM zerto_alerts
  `).get();
  const bySite = db.prepare(`
    SELECT site_name, severity, alert_type, description, COUNT(*) count
    FROM zerto_alerts GROUP BY site_name, severity, alert_type, description
    ORDER BY count DESC LIMIT 20
  `).all().map(r => ({ site: r.site_name, severity: r.severity, type: r.alert_type, description: r.description, count: r.count }));
  return {
    generatedAt: new Date().toISOString(),
    active: { total: totals.total || 0, error: totals.error || 0, warning: totals.warning || 0 },
    bySite,
    note: (totals.total || 0) === 0 ? 'No Zerto alerts recorded.' : undefined,
  };
}

function gatherStability() {
  const windowStart = new Date(Date.now() - 14 * 864e5).toISOString();
  const totals = db.prepare(`
    SELECT COUNT(*) total,
           SUM(CASE WHEN category = 'Alerts' THEN 1 ELSE 0 END) alertTransitions,
           SUM(CASE WHEN category = 'Events' THEN 1 ELSE 0 END) operational,
           SUM(CASE WHEN completed_successfully = 0 THEN 1 ELSE 0 END) failures
    FROM zerto_events WHERE occurred_on >= ?
  `).get(windowStart);
  // A flap is an alert code that keeps turning on and off on the same site.
  const flaps = db.prepare(`
    SELECT site_name, code,
           SUM(CASE WHEN event_type = 'AlertTurnedOn' THEN 1 ELSE 0 END) turnedOn,
           SUM(CASE WHEN event_type = 'AlertTurnedOff' THEN 1 ELSE 0 END) turnedOff,
           MIN(occurred_on) firstSeen, MAX(occurred_on) lastSeen, MAX(description) sample
    FROM zerto_events
    WHERE occurred_on >= ? AND category = 'Alerts'
    GROUP BY site_name, code
    HAVING turnedOn >= 3
    ORDER BY turnedOn DESC LIMIT 15
  `).all(windowStart).map(f => ({
    site: f.site_name, code: f.code, turnedOn: f.turnedOn, turnedOff: f.turnedOff,
    firstSeen: f.firstSeen, lastSeen: f.lastSeen,
    selfClearing: f.turnedOff >= f.turnedOn * 0.8,
    sampleDescription: String(f.sample || '').slice(0, 220),
  }));
  const failedOps = db.prepare(`
    SELECT event_type, code, site_name, description, occurred_on FROM zerto_events
    WHERE occurred_on >= ? AND completed_successfully = 0
    ORDER BY occurred_on DESC LIMIT 20
  `).all(windowStart).map(e => ({
    type: e.event_type, code: e.code, site: e.site_name,
    occurredOn: e.occurred_on, description: String(e.description || '').slice(0, 220),
  }));
  const opsByType = db.prepare(`
    SELECT event_type, COUNT(*) count FROM zerto_events
    WHERE occurred_on >= ? AND category = 'Events'
    GROUP BY event_type ORDER BY count DESC LIMIT 20
  `).all(windowStart).map(r => ({ type: r.event_type, count: r.count }));
  const bySite = db.prepare(`
    SELECT site_name, COUNT(*) count FROM zerto_events WHERE occurred_on >= ?
    GROUP BY site_name ORDER BY count DESC LIMIT 10
  `).all(windowStart).map(r => ({ site: r.site_name, count: r.count }));
  return {
    generatedAt: new Date().toISOString(),
    windowDays: 14,
    totals: {
      events: totals.total || 0,
      alertTransitions: totals.alertTransitions || 0,
      operationalEvents: totals.operational || 0,
      reportedFailures: totals.failures || 0,
    },
    flappingAlerts: flaps,
    failedOperations: failedOps,
    operationalEventsByType: opsByType,
    busiestSites: bySite,
    note: (totals.total || 0) === 0 ? 'No events collected yet; the event log fills from the next polls on.' : undefined,
  };
}

module.exports = createPlatformAdvisor({
  platform: 'zerto',
  feature: 'Zerto AI Advisor',
  table: 'zerto_ai_reports',
  reports: {
    dr_readiness: {
      system:
        'You are a DR/business-continuity engineer for a Zerto replication estate. You are given VPG health/status ' +
        '(actual vs configured RPO and journal history, worst first), site connection status, and VRA appliance status. ' +
        'Assess DR readiness: flag RPO breaches, journals shorter than configured (recovery-point depth is reduced), ' +
        'unhealthy VPGs, disconnected sites, and VRAs not installed/healthy. Be specific with VPG and ' +
        'site names. Do not invent data. Markdown sections: **DR readiness summary**, **Key gaps (prioritized)**, ' +
        '**Recommended actions**. Keep under ~400 words.',
      gather: gatherDrReadiness,
      noun: 'DR readiness report',
    },
    capacity_licensing: {
      system:
        'You are a Zerto capacity and licensing analyst. You are given protected-VM storage totals with modeled growth, ' +
        'the largest protected VMs by used storage, and license package utilization (used/available VM entitlements, ' +
        'expiration dates). Assess growth trajectory and license headroom; flag licenses nearing exhaustion or expiry. ' +
        'Do not invent data; if growth history is thin, say so. Markdown sections: **Summary**, **Growth outlook**, ' +
        '**License risk**, **Recommended actions**. Keep under ~350 words.',
      gather: gatherCapacityLicensing,
      noun: 'capacity and licensing review',
    },
    alert_triage: {
      system:
        'You are an operations lead triaging active alerts across a Zerto replication estate. You are given active ' +
        'alert totals by severity and the noisiest alert types grouped by site. Separate signal from noise and give a ' +
        'prioritized triage plan. Do not invent data. Markdown sections: **Summary**, **Systemic patterns**, ' +
        '**Recommended triage order**. Keep under ~350 words.',
      gather: gatherAlertTriage,
      noun: 'alert triage report',
    },
    stability: {
      system:
        'You are a reliability engineer reviewing 14 days of the Zerto event log. You are given totals (alert ' +
        'transitions vs operational events vs reported failures), alert codes that keep flapping on and off per site ' +
        '(with whether they self-clear), operational events that reported failure, operational event counts by type, ' +
        'and the busiest sites. A condition that keeps clearing itself is invisible one alert at a time; the ' +
        'repetition is the finding. Identify the flap patterns worth engineering time, failed operations to follow ' +
        'up, and what the event volume says about estate stability. Do not invent data. Markdown sections: ' +
        '**Stability summary**, **Flap patterns worth fixing**, **Failed operations**, **Recommended actions**. ' +
        'Keep under ~400 words.',
      gather: gatherStability,
      noun: 'stability and event-pattern report',
    },
  },
});
