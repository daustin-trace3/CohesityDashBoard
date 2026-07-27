const db = require('../../db/database');
const { createPlatformAdvisor, linReg, parseUtcMs, fmtBytes } = require('../platformAdvisor');

function gatherCapacity() {
  const vcenters = db.prepare('SELECT id, name FROM vcenter_vcenters').all();
  const names = new Map(vcenters.map(v => [v.id, v.name]));

  const clusters = db.prepare(`
    SELECT vcenter_id, cluster_name,
           SUM(cpu_mhz_capacity) cpuCap, SUM(cpu_mhz_used) cpuUsed,
           SUM(mem_bytes_capacity) memCap, SUM(mem_bytes_used) memUsed,
           COUNT(*) hostCount
    FROM vcenter_hosts WHERE cluster_name IS NOT NULL
    GROUP BY vcenter_id, cluster_name
  `).all().map(c => ({
    vcenter: names.get(c.vcenter_id) || `vCenter ${c.vcenter_id}`,
    cluster: c.cluster_name,
    hostCount: c.hostCount,
    cpuUsedPct: c.cpuCap > 0 ? +((c.cpuUsed / c.cpuCap) * 100).toFixed(1) : null,
    memUsedPct: c.memCap > 0 ? +((c.memUsed / c.memCap) * 100).toFixed(1) : null,
    memUsed: fmtBytes(c.memUsed),
    memTotal: fmtBytes(c.memCap),
  })).sort((a, b) => (b.memUsedPct ?? -1) - (a.memUsedPct ?? -1));

  const datastores = db.prepare(`
    SELECT vcenter_id, name, capacity_bytes, free_bytes FROM vcenter_datastores WHERE capacity_bytes > 0
    ORDER BY (CAST(free_bytes AS REAL) / capacity_bytes) ASC LIMIT 20
  `).all().map(d => ({
    vcenter: names.get(d.vcenter_id) || `vCenter ${d.vcenter_id}`,
    datastore: d.name,
    freePct: +((d.free_bytes / d.capacity_bytes) * 100).toFixed(1),
    free: fmtBytes(d.free_bytes),
    total: fmtBytes(d.capacity_bytes),
  }));

  const history = db.prepare(`
    SELECT vcenter_id, captured_at, datastore_capacity_bytes, datastore_free_bytes
    FROM vcenter_metrics_history
    WHERE captured_at >= datetime('now', '-30 days') ORDER BY vcenter_id, captured_at ASC
  `).all().map(r => ({ ...r, used: r.datastore_capacity_bytes != null && r.datastore_free_bytes != null ? r.datastore_capacity_bytes - r.datastore_free_bytes : null }));
  const byVc = new Map();
  for (const r of history) {
    if (!byVc.has(r.vcenter_id)) byVc.set(r.vcenter_id, []);
    byVc.get(r.vcenter_id).push(r);
  }
  const trend = vcenters.map(v => {
    const series = byVc.get(v.id) || [];
    const pts = series.filter(r => r.used != null).map(r => ({ x: parseUtcMs(r.captured_at), y: r.used }));
    const reg = linReg(pts);
    const growthPerDay = reg ? reg.slope * 86400000 : 0;
    return { vcenter: v.name, growthPerDay: growthPerDay > 0 ? fmtBytes(growthPerDay) + '/day' : 'flat/declining', dataPoints: series.length };
  });

  const orphans = db.prepare(`
    SELECT vcenter_id, SUM(size_bytes) totalBytes, COUNT(*) count FROM vcenter_orphaned_vmdks GROUP BY vcenter_id
  `).all().map(o => ({ vcenter: names.get(o.vcenter_id) || `vCenter ${o.vcenter_id}`, count: o.count, reclaimable: fmtBytes(o.totalBytes) }));

  return {
    generatedAt: new Date().toISOString(),
    vcenters: vcenters.length,
    clusters,
    lowFreeDatastores: datastores,
    trend,
    orphanedVmdks: orphans,
    note: vcenters.length === 0 ? 'No vCenters registered.' : undefined,
  };
}

function gatherOperationsReview() {
  const vcenters = db.prepare('SELECT id, name FROM vcenter_vcenters').all();
  const names = new Map(vcenters.map(v => [v.id, v.name]));

  const openIssues = db.prepare(`
    SELECT vcenter, severity, type, target, message, first_seen FROM vcenter_issue_history
    WHERE status = 'open' ORDER BY (severity = 'error') DESC, first_seen ASC LIMIT 30
  `).all();

  const eventThemes = db.prepare(`
    SELECT vcenter_id, event_type, severity, COUNT(*) count, MAX(message) sampleMessage
    FROM vcenter_events
    WHERE severity IN ('error', 'warning') AND captured_at >= datetime('now', '-7 days')
    GROUP BY vcenter_id, event_type, severity ORDER BY count DESC LIMIT 20
  `).all().map(e => ({ vcenter: names.get(e.vcenter_id) || `vCenter ${e.vcenter_id}`, eventType: e.event_type, severity: e.severity, count: e.count, sampleMessage: e.sampleMessage }));

  const certsExpiring = db.prepare(`
    SELECT vcenter_id, cert_type, subject, valid_to FROM vcenter_certs
    WHERE valid_to IS NOT NULL AND valid_to <= datetime('now', '+60 days')
    ORDER BY valid_to ASC LIMIT 20
  `).all().map(c => ({ vcenter: names.get(c.vcenter_id) || `vCenter ${c.vcenter_id}`, certType: c.cert_type, subject: c.subject, validTo: c.valid_to }));

  const hostIssues = db.prepare(`
    SELECT vcenter_id, name, cluster_name, connection_state, in_maintenance FROM vcenter_hosts
    WHERE connection_state != 'connected' OR in_maintenance = 1
    LIMIT 30
  `).all().map(h => ({ vcenter: names.get(h.vcenter_id) || `vCenter ${h.vcenter_id}`, host: h.name, cluster: h.cluster_name, connectionState: h.connection_state, inMaintenance: !!h.in_maintenance }));

  return {
    generatedAt: new Date().toISOString(),
    openIssues,
    recentEventThemes: eventThemes,
    certsExpiringWithin60d: certsExpiring,
    hostsNeedingAttention: hostIssues,
    note: (openIssues.length + eventThemes.length + certsExpiring.length + hostIssues.length) === 0
      ? 'No open issues, recent error/warning events, expiring certs, or disconnected/maintenance hosts.' : undefined,
  };
}

function gatherEfficiency() {
  const vcenters = db.prepare('SELECT id, name FROM vcenter_vcenters').all();
  const names = new Map(vcenters.map(v => [v.id, v.name]));

  const vmCountPerHost = db.prepare(`
    SELECT vcenter_id, name, vm_count FROM vcenter_hosts ORDER BY vm_count DESC LIMIT 20
  `).all().map(h => ({ vcenter: names.get(h.vcenter_id) || `vCenter ${h.vcenter_id}`, host: h.name, vmCount: h.vm_count }));

  const poweredOff = db.prepare(`
    SELECT vcenter_id, COUNT(*) count FROM vcenter_vms WHERE power_state != 'poweredOn' GROUP BY vcenter_id
  `).all().map(p => ({ vcenter: names.get(p.vcenter_id) || `vCenter ${p.vcenter_id}`, poweredOffCount: p.count }));

  const outdatedTools = db.prepare(`
    SELECT vcenter_id, COUNT(*) count FROM vcenter_vms
    WHERE tools_status IS NOT NULL AND tools_status NOT IN ('toolsOk', 'toolsOld') AND tools_status != 'toolsNotInstalled'
    GROUP BY vcenter_id
  `).all();
  const outdatedToolsSimple = db.prepare(`
    SELECT vcenter_id, COUNT(*) count FROM vcenter_vms WHERE tools_status = 'toolsOld' GROUP BY vcenter_id
  `).all().map(t => ({ vcenter: names.get(t.vcenter_id) || `vCenter ${t.vcenter_id}`, outdatedToolsCount: t.count }));

  const totalVms = db.prepare('SELECT COUNT(*) n FROM vcenter_vms').get().n;

  return {
    generatedAt: new Date().toISOString(),
    totalVms,
    vmCountPerHost,
    poweredOffVms: poweredOff,
    outdatedTools: outdatedToolsSimple,
    note: totalVms === 0 ? 'No VM inventory collected yet (requires SOAP enrichment).' : undefined,
  };
}

module.exports = createPlatformAdvisor({
  platform: 'vcenter',
  feature: 'vCenter AI Advisor',
  table: 'vcenter_ai_reports',
  reports: {
    capacity: {
      system:
        'You are a VMware vSphere capacity planner. You are given per-cluster CPU/memory usage %, the datastores with ' +
        'the least free space %, modeled per-vCenter storage growth, and reclaimable orphaned VMDK space. Produce a ' +
        'capacity plan: identify clusters/datastores needing attention soonest, flag anomalous growth, and recommend ' +
        'reclaiming orphaned VMDKs where material. Do not invent data; if growth history is thin, say so. ' +
        'Markdown sections: **Summary**, **Needs attention (soonest first)**, **Reclaimable space**, ' +
        '**Recommended actions**. Keep under ~400 words.',
      gather: gatherCapacity,
      noun: 'capacity plan',
    },
    operations_review: {
      system:
        'You are a VMware vSphere operations engineer. You are given open computed issues, recent (7-day) error/warning ' +
        'vSphere event themes grouped by type, certificates expiring within 60 days, and hosts disconnected or in ' +
        'maintenance mode. Identify systemic themes vs isolated incidents and give a prioritized operations plan. Do not ' +
        'invent data. Markdown sections: **Summary**, **Systemic themes**, **Recommended actions**. Keep under ~400 words.',
      gather: gatherOperationsReview,
      noun: 'operations review',
    },
    efficiency: {
      system:
        'You are a VMware vSphere efficiency analyst. You are given VM count per host, powered-off VM counts per ' +
        'vCenter, and VMs with outdated VMware Tools. Identify consolidation/cleanup opportunities (stale powered-off ' +
        'VMs, imbalanced host placement) and Tools hygiene gaps. Do not invent data. Markdown sections: **Summary**, ' +
        '**Cleanup opportunities**, **Recommended actions**. Keep under ~300 words.',
      gather: gatherEfficiency,
      noun: 'efficiency review',
    },
  },
});
