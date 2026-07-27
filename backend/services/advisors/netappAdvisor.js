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
  },
});
