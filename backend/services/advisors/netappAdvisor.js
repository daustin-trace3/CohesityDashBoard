const db = require('../../db/database');
const { createPlatformAdvisor, linReg, parseUtcMs, fmtBytes } = require('../platformAdvisor');

function gatherCapacity() {
  const arrays = db.prepare('SELECT id, name FROM netapp_arrays').all();
  const names = new Map(arrays.map(a => [a.id, a.name]));

  const aggregates = db.prepare(`
    SELECT array_id, name, node_name, size_bytes, used_bytes, used_percent, efficiency_ratio
    FROM netapp_aggregates ORDER BY used_percent DESC LIMIT 20
  `).all().map(a => ({
    array: names.get(a.array_id) || `Array ${a.array_id}`,
    aggregate: a.name,
    node: a.node_name,
    usedPct: a.used_percent != null ? +a.used_percent.toFixed(1) : null,
    used: fmtBytes(a.used_bytes),
    total: fmtBytes(a.size_bytes),
    efficiencyRatio: a.efficiency_ratio != null ? +a.efficiency_ratio.toFixed(2) : null,
  }));

  const topVolumes = db.prepare(`
    SELECT array_id, name, svm_name, aggregate_name, size_bytes, used_bytes, used_percent
    FROM netapp_volumes ORDER BY used_percent DESC LIMIT 20
  `).all().map(v => ({
    array: names.get(v.array_id) || `Array ${v.array_id}`,
    volume: v.name,
    svm: v.svm_name,
    aggregate: v.aggregate_name,
    usedPct: v.used_percent != null ? +v.used_percent.toFixed(1) : null,
    used: fmtBytes(v.used_bytes),
    total: fmtBytes(v.size_bytes),
  }));

  const history = db.prepare(`
    SELECT array_id, captured_at, used_bytes, total_bytes
    FROM netapp_metrics_history
    WHERE captured_at >= datetime('now', '-30 days')
    ORDER BY array_id, captured_at ASC
  `).all();
  const byArray = new Map();
  for (const r of history) {
    if (!byArray.has(r.array_id)) byArray.set(r.array_id, []);
    byArray.get(r.array_id).push(r);
  }
  let fleetUsed = 0, fleetTotal = 0;
  const trend = arrays.map(a => {
    const series = byArray.get(a.id) || [];
    const latest = series[series.length - 1];
    const total = latest?.total_bytes || 0;
    const used = latest?.used_bytes || 0;
    if (total > 0) { fleetUsed += used; fleetTotal += total; }
    const pts = series.filter(r => r.used_bytes != null).map(r => ({ x: parseUtcMs(r.captured_at), y: r.used_bytes }));
    const reg = linReg(pts);
    const growthPerDay = reg ? reg.slope * 86400000 : 0;
    return {
      array: a.name,
      usedPct: total > 0 ? +((used / total) * 100).toFixed(1) : null,
      growthPerDay: growthPerDay > 0 ? fmtBytes(growthPerDay) + '/day' : 'flat/declining',
      dataPoints: series.length,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    fleet: {
      arrays: arrays.length,
      usedPct: fleetTotal > 0 ? +((fleetUsed / fleetTotal) * 100).toFixed(1) : null,
      used: fmtBytes(fleetUsed),
      total: fmtBytes(fleetTotal),
    },
    aggregates,
    topVolumes,
    trend,
    note: arrays.length === 0 ? 'No NetApp clusters registered.' : undefined,
  };
}

function gatherReplicationHealth() {
  const arrays = db.prepare('SELECT id, name FROM netapp_arrays').all();
  const names = new Map(arrays.map(a => [a.id, a.name]));
  const totals = db.prepare(`
    SELECT COUNT(*) total, SUM(CASE WHEN healthy = 1 THEN 1 ELSE 0 END) healthy, AVG(lag_seconds) avgLag
    FROM netapp_snapmirror
  `).get();
  const relationships = db.prepare(`
    SELECT array_id, source_path, source_cluster, destination_path, destination_cluster, state, healthy, lag_seconds, transfer_state, last_transfer_end
    FROM netapp_snapmirror ORDER BY (healthy = 0) DESC, lag_seconds DESC LIMIT 40
  `).all().map(r => ({
    array: names.get(r.array_id) || `Array ${r.array_id}`,
    source: `${r.source_cluster || ''}:${r.source_path || ''}`,
    destination: `${r.destination_cluster || ''}:${r.destination_path || ''}`,
    state: r.state,
    healthy: !!r.healthy,
    lagSeconds: r.lag_seconds,
    transferState: r.transfer_state,
    lastTransferEnd: r.last_transfer_end,
  }));
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      total: totals.total || 0,
      healthy: totals.healthy || 0,
      unhealthy: (totals.total || 0) - (totals.healthy || 0),
      avgLagSeconds: totals.avgLag != null ? Math.round(totals.avgLag) : null,
    },
    relationships,
    note: (totals.total || 0) === 0 ? 'No SnapMirror relationships discovered.' : undefined,
  };
}

function gatherAlertTriage() {
  const arrays = db.prepare('SELECT id, name FROM netapp_arrays').all();
  const names = new Map(arrays.map(a => [a.id, a.name]));
  const totals = db.prepare(`
    SELECT COUNT(*) total,
           SUM(CASE WHEN severity='critical' THEN 1 ELSE 0 END) critical,
           SUM(CASE WHEN severity='warning' THEN 1 ELSE 0 END) warning
    FROM netapp_alerts
  `).get();
  const byNode = db.prepare(`
    SELECT array_id, node_name, severity, message, COUNT(*) count
    FROM netapp_alerts GROUP BY array_id, node_name, severity, message
    ORDER BY count DESC LIMIT 20
  `).all().map(r => ({
    array: names.get(r.array_id) || `Array ${r.array_id}`,
    node: r.node_name,
    severity: r.severity,
    message: r.message,
    count: r.count,
  }));
  return {
    generatedAt: new Date().toISOString(),
    active: { total: totals.total || 0, critical: totals.critical || 0, warning: totals.warning || 0 },
    byNode,
    note: (totals.total || 0) === 0 ? 'No NetApp alerts recorded.' : undefined,
  };
}

function gatherGovernance() {
  const arrays = db.prepare('SELECT id, name, version, source FROM netapp_arrays').all();
  const names = new Map(arrays.map(a => [a.id, a.name]));
  const nodes = db.prepare('SELECT array_id, name, model, state, version FROM netapp_nodes ORDER BY array_id, name').all();
  const versions = [...new Set(nodes.map(n => n.version).filter(Boolean))];
  const clusters = arrays.map(a => {
    const mine = nodes.filter(n => n.array_id === a.id);
    return {
      cluster: a.name,
      source: a.source,
      version: a.version || mine[0]?.version || null,
      nodeVersions: [...new Set(mine.map(n => n.version).filter(Boolean))],
      models: [...new Set(mine.map(n => n.model).filter(Boolean))],
      nodesNotUp: mine.filter(n => n.state && n.state !== 'up').map(n => ({ node: n.name, state: n.state })),
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    versionsInEstate: versions,
    clusters,
    note: arrays.length === 0 ? 'No NetApp clusters registered.' : undefined,
  };
}

function gatherSecurityReview() {
  const arrays = db.prepare('SELECT id, name FROM netapp_arrays').all();
  const names = new Map(arrays.map(a => [a.id, a.name]));
  const wideOpen = (c) => /^(0\.0\.0\.0\/0|0\.0\.0\.0|any|\*)$/i.test(String(c || '').trim());
  const exportRules = db.prepare(`
    SELECT array_id, policy_name, svm_name, rule_index, clients, protocols, ro_rule, rw_rule, superuser
    FROM netapp_export_rules LIMIT 500
  `).all().map(r => ({
    cluster: names.get(r.array_id) || `Array ${r.array_id}`,
    policy: r.policy_name, svm: r.svm_name, ruleIndex: r.rule_index,
    clients: r.clients, protocols: r.protocols, roRule: r.ro_rule, rwRule: r.rw_rule, superuser: r.superuser,
    openToAnyClient: wideOpen(r.clients),
    allowsSysAuth: /(^|,)\s*(sys|none|never)?sys/i.test(String(r.rw_rule || '')) || /(^|,)\s*any/i.test(String(r.rw_rule || '')),
    superuserAllowed: !!(r.superuser && !/none/i.test(r.superuser)),
  }));
  const sessions = db.prepare(`
    SELECT array_id, svm_name, smb_encryption, smb_signing, COUNT(*) count
    FROM netapp_cifs_sessions GROUP BY array_id, svm_name, smb_encryption, smb_signing
  `).all().map(r => ({
    cluster: names.get(r.array_id) || `Array ${r.array_id}`,
    svm: r.svm_name, encryption: r.smb_encryption, signing: !!r.smb_signing, sessions: r.count,
  }));
  const shares = db.prepare(`
    SELECT array_id, svm_name, COUNT(*) count FROM netapp_cifs_shares GROUP BY array_id, svm_name
  `).all().map(r => ({ cluster: names.get(r.array_id) || `Array ${r.array_id}`, svm: r.svm_name, shares: r.count }));
  const quotaBreaches = db.prepare(`
    SELECT array_id, svm_name, volume_name, qtree_name, space_used_bytes, space_hard_limit_bytes
    FROM netapp_quotas
    WHERE space_hard_limit_bytes > 0 AND space_used_bytes >= space_hard_limit_bytes * 0.9
    ORDER BY CAST(space_used_bytes AS REAL) / space_hard_limit_bytes DESC LIMIT 25
  `).all().map(q => ({
    cluster: names.get(q.array_id) || `Array ${q.array_id}`,
    svm: q.svm_name, volume: q.volume_name, qtree: q.qtree_name,
    used: fmtBytes(q.space_used_bytes), hardLimit: fmtBytes(q.space_hard_limit_bytes),
    usedPct: +((q.space_used_bytes / q.space_hard_limit_bytes) * 100).toFixed(1),
  }));
  const total = exportRules.length + sessions.length + shares.length + quotaBreaches.length;
  return {
    generatedAt: new Date().toISOString(),
    exportRules: {
      total: exportRules.length,
      flagged: exportRules.filter(r => r.openToAnyClient || r.superuserAllowed).slice(0, 40),
    },
    cifsSessionsByPosture: sessions,
    cifsSharesBySvm: shares,
    quotaBreaches,
    note: total === 0 ? 'No export rules, CIFS data or quotas collected yet.' : undefined,
  };
}

function gatherHardwareHealth() {
  const arrays = db.prepare('SELECT id, name FROM netapp_arrays').all();
  const names = new Map(arrays.map(a => [a.id, a.name]));
  const disks = db.prepare(`
    SELECT array_id, state, COUNT(*) count FROM netapp_disks GROUP BY array_id, state
  `).all().map(d => ({ cluster: names.get(d.array_id) || `Array ${d.array_id}`, state: d.state, disks: d.count }));
  const brokenDisks = db.prepare(`
    SELECT array_id, name, model, type, state FROM netapp_disks
    WHERE state IS NOT NULL AND state NOT IN ('present', 'spare', 'aggregate', 'zeroing') LIMIT 30
  `).all().map(d => ({ cluster: names.get(d.array_id) || `Array ${d.array_id}`, disk: d.name, model: d.model, type: d.type, state: d.state }));
  const lifs = db.prepare(`
    SELECT array_id, name, svm_name, state, enabled, is_home, node_name, port_name
    FROM netapp_lifs WHERE state != 'up' OR is_home = 0 LIMIT 40
  `).all().map(l => ({
    cluster: names.get(l.array_id) || `Array ${l.array_id}`,
    lif: l.name, svm: l.svm_name, state: l.state, enabled: !!l.enabled,
    isHome: !!l.is_home, node: l.node_name, port: l.port_name,
  }));
  const nodesNotUp = db.prepare(`
    SELECT array_id, name, model, state FROM netapp_nodes WHERE state IS NOT NULL AND state != 'up'
  `).all().map(n => ({ cluster: names.get(n.array_id) || `Array ${n.array_id}`, node: n.name, model: n.model, state: n.state }));
  return {
    generatedAt: new Date().toISOString(),
    diskStatesByCluster: disks,
    disksNeedingAttention: brokenDisks,
    lifsNotUpOrNotHome: lifs,
    nodesNotUp,
    note: arrays.length === 0 ? 'No NetApp clusters registered.' : undefined,
  };
}

module.exports = createPlatformAdvisor({
  platform: 'netapp',
  feature: 'NetApp AI Advisor',
  table: 'netapp_ai_reports',
  reports: {
    capacity: {
      system:
        'You are a senior NetApp ONTAP storage engineer. You are given fleet capacity totals, the top aggregates and ' +
        'volumes by usage %, storage efficiency ratios, and modeled daily growth per cluster where history exists. ' +
        'Produce a capacity plan: identify aggregates/volumes needing attention soonest, flag anomalous growth, and ' +
        'suggest efficiency or rebalancing actions. Do not invent data; if growth history is thin, say so. ' +
        'Markdown sections: **Fleet summary**, **Needs attention (soonest first)**, **Recommended actions**. ' +
        'Keep under ~400 words.',
      gather: gatherCapacity,
      noun: 'capacity plan',
    },
    replication_health: {
      system:
        'You are a NetApp SnapMirror / DR replication specialist. You are given the fleet-wide relationship health ' +
        'summary and the individual SnapMirror relationships (state, healthy flag, lag, transfer state), unhealthy and ' +
        'highest-lag first. Assess DR readiness, flag broken or lagging relationships, and give a prioritized remediation ' +
        'plan. Do not invent data. Markdown sections: **Replication summary**, **Key gaps (prioritized)**, ' +
        '**Recommended actions**. Keep under ~350 words.',
      gather: gatherReplicationHealth,
      noun: 'replication health report',
    },
    alert_triage: {
      system:
        'You are an operations lead triaging active alerts across a NetApp ONTAP fleet. You are given active alert ' +
        'totals by severity and the noisiest alert types grouped by cluster and node. Separate signal from noise and ' +
        'give a prioritized triage plan. Do not invent data. Markdown sections: **Summary**, **Systemic patterns**, ' +
        '**Recommended triage order**. Keep under ~350 words.',
      gather: gatherAlertTriage,
      noun: 'alert triage report',
    },
    governance: {
      system:
        'You are an ONTAP estate governance reviewer. You are given every cluster with its ONTAP version, the node ' +
        'versions inside it, hardware models, and nodes not in the up state, plus the set of versions present in the ' +
        'estate. Do NOT use vendor end-of-support dates; judge only relative currency inside this estate. Flag clusters ' +
        'behind the newest release seen, clusters with mixed node versions, and propose a sensible upgrade order that ' +
        'starts with the furthest behind. Do not invent data. Markdown sections: **Estate summary**, ' +
        '**Behind or inconsistent (prioritized)**, **Suggested upgrade order**. Keep under ~350 words.',
      gather: gatherGovernance,
      noun: 'estate governance report',
    },
    security_review: {
      system:
        'You are a storage security auditor reviewing data-access posture on a NetApp ONTAP fleet for a regulated ' +
        'financial-services environment. You are given NFS export rules flagged for wide-open client lists or ' +
        'superuser access, CIFS session counts grouped by encryption and signing posture, CIFS share counts per SVM, ' +
        'and quotas at or past 90% of their hard limit. Assess exposure, call out the riskiest rules by name, and give ' +
        'remediation steps ordered by risk. State clearly that this covers only what ICC collects (exports, CIFS ' +
        'posture, quotas), not a full security audit. Do not invent data. Markdown sections: **Posture summary**, ' +
        '**Highest-risk findings**, **Remediation order**. Keep under ~400 words.',
      gather: gatherSecurityReview,
      noun: 'data-access security review',
    },
    hardware_health: {
      system:
        'You are a NetApp hardware and availability engineer. You are given disk counts by state per cluster, disks in ' +
        'an unusual state, LIFs that are down or not on their home port, and nodes not in the up state. A LIF off its ' +
        'home port often means an unfinished failover or giveback. Assess hardware and failover risk and give a ' +
        'prioritized action list. Do not invent data. Markdown sections: **Health summary**, **Findings (prioritized)**, ' +
        '**Recommended actions**. Keep under ~350 words.',
      gather: gatherHardwareHealth,
      noun: 'hardware and failover health report',
    },
  },
});
