const db = require('../../db/database');
const { createPlatformAdvisor, linReg, parseUtcMs, fmtBytes } = require('../platformAdvisor');

function gatherDrReadiness() {
  const vpgs = db.prepare(`
    SELECT vpg_identifier, name, vms_count, protected_site, recovery_site, actual_rpo, configured_rpo, health, status, sub_status
    FROM zerto_vpgs ORDER BY (health != 'Healthy') DESC, actual_rpo DESC LIMIT 40
  `).all().map(v => ({
    vpg: v.name,
    vms: v.vms_count,
    protectedSite: v.protected_site,
    recoverySite: v.recovery_site,
    actualRpoSeconds: v.actual_rpo,
    configuredRpoSeconds: v.configured_rpo,
    rpoBreached: v.configured_rpo != null && v.actual_rpo != null ? v.actual_rpo > v.configured_rpo : null,
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

module.exports = createPlatformAdvisor({
  platform: 'zerto',
  feature: 'Zerto AI Advisor',
  table: 'zerto_ai_reports',
  reports: {
    dr_readiness: {
      system:
        'You are a DR/business-continuity engineer for a Zerto replication estate. You are given VPG health/status ' +
        '(actual vs configured RPO, worst first), site connection status, and VRA appliance status. Assess DR readiness: ' +
        'flag RPO breaches, unhealthy VPGs, disconnected sites, and VRAs not installed/healthy. Be specific with VPG and ' +
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
  },
});
