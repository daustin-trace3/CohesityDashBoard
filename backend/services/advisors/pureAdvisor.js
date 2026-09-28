const db = require('../../db/database');
const { createPlatformAdvisor, linReg, parseUtcMs, fmtBytes } = require('../platformAdvisor');

// ── capacity: pure1 fleet (SaaS) preferred, falls back to direct-connect ────
function gatherCapacity() {
  const pure1Arrays = db.prepare('SELECT * FROM pure1_arrays').all();
  if (pure1Arrays.length) {
    const hist = db.prepare(`
      SELECT captured_at, total_capacity_bytes, total_used_bytes
      FROM pure1_metrics_history
      WHERE captured_at >= datetime('now', '-30 days')
      ORDER BY captured_at ASC
    `).all();
    const pts = hist.filter(h => h.total_used_bytes != null).map(h => ({ x: parseUtcMs(h.captured_at), y: h.total_used_bytes }));
    const reg = linReg(pts);
    const growthPerDay = reg ? reg.slope * 86400000 : 0;
    const arrays = pure1Arrays.map(a => ({
      array: a.name,
      model: a.model,
      health: a.health,
      capacity: fmtBytes(a.capacity_bytes),
      used: fmtBytes(a.used_bytes),
      pctUsed: a.capacity_bytes > 0 ? +((a.used_bytes / a.capacity_bytes) * 100).toFixed(1) : null,
      dataReduction: a.data_reduction != null ? +a.data_reduction.toFixed(2) : null,
    })).sort((x, y) => (y.pctUsed ?? -1) - (x.pctUsed ?? -1));
    let fleetUsed = 0, fleetTotal = 0;
    for (const a of pure1Arrays) { fleetUsed += a.used_bytes || 0; fleetTotal += a.capacity_bytes || 0; }
    return {
      generatedAt: new Date().toISOString(),
      source: 'pure1',
      fleet: {
        arrays: pure1Arrays.length,
        usedPct: fleetTotal > 0 ? +((fleetUsed / fleetTotal) * 100).toFixed(1) : null,
        used: fmtBytes(fleetUsed),
        total: fmtBytes(fleetTotal),
        growthPerDay: growthPerDay > 0 ? fmtBytes(growthPerDay) + '/day' : 'flat/declining',
        dataPoints: hist.length,
      },
      arrays,
    };
  }

  const arrays = db.prepare('SELECT id, name FROM pure_arrays').all();
  const history = db.prepare(`
    SELECT array_id, captured_at, capacity_bytes, used_bytes, data_reduction
    FROM pure_metrics_history
    WHERE captured_at >= datetime('now', '-30 days')
    ORDER BY array_id, captured_at ASC
  `).all();
  const byArray = new Map();
  for (const r of history) {
    if (!byArray.has(r.array_id)) byArray.set(r.array_id, []);
    byArray.get(r.array_id).push(r);
  }
  let fleetUsed = 0, fleetTotal = 0;
  const out = arrays.map(a => {
    const series = byArray.get(a.id) || [];
    const latest = series[series.length - 1];
    const total = latest?.capacity_bytes || 0;
    const used = latest?.used_bytes || 0;
    if (total > 0) { fleetUsed += used; fleetTotal += total; }
    const pts = series.filter(r => r.used_bytes != null).map(r => ({ x: parseUtcMs(r.captured_at), y: r.used_bytes }));
    const reg = linReg(pts);
    const growthPerDay = reg ? reg.slope * 86400000 : 0;
    return {
      array: a.name,
      pctUsed: total > 0 ? +((used / total) * 100).toFixed(1) : null,
      used: fmtBytes(used),
      total: fmtBytes(total),
      growthPerDay: growthPerDay > 0 ? fmtBytes(growthPerDay) + '/day' : 'flat/declining',
      dataReduction: latest?.data_reduction != null ? +latest.data_reduction.toFixed(2) : null,
      dataPoints: series.length,
    };
  }).sort((x, y) => (y.pctUsed ?? -1) - (x.pctUsed ?? -1));
  return {
    generatedAt: new Date().toISOString(),
    source: 'direct',
    fleet: {
      arrays: arrays.length,
      usedPct: fleetTotal > 0 ? +((fleetUsed / fleetTotal) * 100).toFixed(1) : null,
      used: fmtBytes(fleetUsed),
      total: fmtBytes(fleetTotal),
    },
    arrays: out,
    note: arrays.length === 0 ? 'No Pure arrays registered (direct or Pure1 SaaS).' : undefined,
  };
}

// ── performance: latest per-array metrics + volume hotspots ────────────────
function gatherPerformance() {
  // Pure1 SaaS fleet perf (populated by the pure1 poller since pure migration
  // v7) is the primary source; direct-array history is the fallback/extra.
  const pure1Perf = db.prepare(`
    SELECT name, read_iops, write_iops, read_latency_us, write_latency_us,
           read_bw_bytes, write_bw_bytes, perf_captured_at
    FROM pure1_arrays
    WHERE read_iops IS NOT NULL OR write_iops IS NOT NULL OR read_latency_us IS NOT NULL
  `).all().map((r) => ({
    array: r.name,
    readIops: r.read_iops != null ? Math.round(r.read_iops) : null,
    writeIops: r.write_iops != null ? Math.round(r.write_iops) : null,
    readLatencyUs: r.read_latency_us != null ? Math.round(r.read_latency_us) : null,
    writeLatencyUs: r.write_latency_us != null ? Math.round(r.write_latency_us) : null,
    readBw: fmtBytes(r.read_bw_bytes) + '/s',
    writeBw: fmtBytes(r.write_bw_bytes) + '/s',
    capturedAt: r.perf_captured_at,
  }));

  const arrays = db.prepare('SELECT id, name FROM pure_arrays').all();
  if (!arrays.length && pure1Perf.length) {
    return { generatedAt: new Date().toISOString(), arrays: pure1Perf, hotspots: [], note: 'Array-level metrics from Pure1; volume-level hotspot history requires direct array connections.' };
  }
  if (!arrays.length) {
    return { generatedAt: new Date().toISOString(), note: 'No performance data captured yet — Pure1 poll has not run and no direct-connect arrays are registered.', arrays: [], hotspots: [] };
  }
  const latest = db.prepare(`
    SELECT m.array_id, m.captured_at, m.read_iops, m.write_iops, m.read_latency_us, m.write_latency_us, m.read_bw_bytes, m.write_bw_bytes
    FROM pure_metrics_history m
    JOIN (SELECT array_id, MAX(captured_at) mx FROM pure_metrics_history GROUP BY array_id) t
      ON t.array_id = m.array_id AND t.mx = m.captured_at
  `).all();
  const names = new Map(arrays.map(a => [a.id, a.name]));
  const arrayMetrics = latest.map(m => ({
    array: names.get(m.array_id) || `Array ${m.array_id}`,
    readIops: m.read_iops != null ? Math.round(m.read_iops) : null,
    writeIops: m.write_iops != null ? Math.round(m.write_iops) : null,
    readLatencyUs: m.read_latency_us != null ? Math.round(m.read_latency_us) : null,
    writeLatencyUs: m.write_latency_us != null ? Math.round(m.write_latency_us) : null,
    readBw: fmtBytes(m.read_bw_bytes) + '/s',
    writeBw: fmtBytes(m.write_bw_bytes) + '/s',
    capturedAt: m.captured_at,
  }));
  const hotspots = db.prepare(`
    SELECT v.array_id, v.volume_name, v.read_iops, v.write_iops, v.read_latency_us, v.write_latency_us
    FROM pure_volume_history v
    JOIN (SELECT array_id, volume_name, MAX(captured_at) mx FROM pure_volume_history GROUP BY array_id, volume_name) t
      ON t.array_id = v.array_id AND t.volume_name = v.volume_name AND t.mx = v.captured_at
    ORDER BY (COALESCE(v.read_latency_us,0) + COALESCE(v.write_latency_us,0)) DESC
    LIMIT 20
  `).all().map(v => ({
    array: names.get(v.array_id) || `Array ${v.array_id}`,
    volume: v.volume_name,
    readIops: v.read_iops != null ? Math.round(v.read_iops) : null,
    writeIops: v.write_iops != null ? Math.round(v.write_iops) : null,
    readLatencyUs: v.read_latency_us != null ? Math.round(v.read_latency_us) : null,
    writeLatencyUs: v.write_latency_us != null ? Math.round(v.write_latency_us) : null,
  }));
  // Merge: direct-array metrics win per array name; Pure1 fills the rest.
  const seen = new Set(arrayMetrics.map((a) => a.array));
  const merged = [...arrayMetrics, ...pure1Perf.filter((p) => !seen.has(p.array))];
  return {
    generatedAt: new Date().toISOString(),
    arrays: merged,
    hotspots,
    note: merged.length === 0 ? 'No performance metrics captured yet for these arrays.' : undefined,
  };
}

// ── alert_triage: open alerts across pure1 (SaaS) + direct arrays ──────────
function gatherAlertTriage() {
  const pure1Open = db.prepare(`
    SELECT severity, category, component_type, summary, array_name, COUNT(*) count
    FROM pure1_alerts WHERE state != 'closed'
    GROUP BY severity, category, component_type, summary, array_name
    ORDER BY count DESC LIMIT 20
  `).all();
  const pure1Totals = db.prepare(`
    SELECT COUNT(*) total, SUM(CASE WHEN severity='critical' THEN 1 ELSE 0 END) critical, SUM(CASE WHEN severity='warning' THEN 1 ELSE 0 END) warning
    FROM pure1_alerts WHERE state != 'closed'
  `).get();
  const directOpen = db.prepare(`
    SELECT a.severity, a.category, a.component_type, a.summary, ar.name AS array_name, COUNT(*) count
    FROM pure_alerts a JOIN pure_arrays ar ON ar.id = a.array_id
    WHERE a.state != 'closed'
    GROUP BY a.severity, a.category, a.component_type, a.summary, ar.name
    ORDER BY count DESC LIMIT 20
  `).all();
  const directTotals = db.prepare(`
    SELECT COUNT(*) total, SUM(CASE WHEN severity='critical' THEN 1 ELSE 0 END) critical, SUM(CASE WHEN severity='warning' THEN 1 ELSE 0 END) warning
    FROM pure_alerts WHERE state != 'closed'
  `).get();
  return {
    generatedAt: new Date().toISOString(),
    pure1: {
      active: { total: pure1Totals.total || 0, critical: pure1Totals.critical || 0, warning: pure1Totals.warning || 0 },
      topAlerts: pure1Open,
    },
    direct: {
      active: { total: directTotals.total || 0, critical: directTotals.critical || 0, warning: directTotals.warning || 0 },
      topAlerts: directOpen,
    },
  };
}

function pureNames() {
  const arrays = db.prepare('SELECT id, name FROM pure_arrays').all();
  return { arrays, names: new Map(arrays.map(a => [a.id, a.name])) };
}

function gatherProtectionPosture() {
  const { arrays, names } = pureNames();
  const fmtFreq = (ms) => (ms == null ? null : ms >= 86400000 ? `${(ms / 86400000).toFixed(1)}d` : ms >= 3600000 ? `${(ms / 3600000).toFixed(1)}h` : `${Math.round(ms / 60000)}m`);
  const groups = db.prepare(`
    SELECT array_id, name, is_local, volume_count, host_count, target_count, snapshot_enabled,
           snapshot_frequency_ms, replication_enabled, replication_frequency_ms,
           source_retention_days, target_retention_days, snapshots_bytes, destroyed
    FROM pure_protection_groups WHERE destroyed = 0
    ORDER BY (snapshot_enabled = 0 AND replication_enabled = 0) DESC, name LIMIT 60
  `).all().map(g => ({
    array: names.get(g.array_id) || `Array ${g.array_id}`,
    group: g.name, local: !!g.is_local,
    volumes: g.volume_count, hosts: g.host_count, replicationTargets: g.target_count,
    snapshots: g.snapshot_enabled ? `every ${fmtFreq(g.snapshot_frequency_ms)}` : 'OFF',
    replication: g.replication_enabled ? `every ${fmtFreq(g.replication_frequency_ms)}` : 'OFF',
    sourceRetentionDays: g.source_retention_days, targetRetentionDays: g.target_retention_days,
    snapshotFootprint: fmtBytes(g.snapshots_bytes),
    unprotected: !g.snapshot_enabled && !g.replication_enabled,
  }));
  const connections = db.prepare(`
    SELECT array_id, remote_name, status, type, transport FROM pure_array_connections
  `).all().map(c => ({
    array: names.get(c.array_id) || `Array ${c.array_id}`,
    remote: c.remote_name, status: c.status, type: c.type, transport: c.transport,
  }));
  const pods = db.prepare(`
    SELECT array_id, name, promotion_status, mediator, array_count, link_source_count, link_target_count, member_arrays
    FROM pure_pods
  `).all().map(p => ({
    array: names.get(p.array_id) || `Array ${p.array_id}`,
    pod: p.name, promotionStatus: p.promotion_status, mediator: p.mediator,
    memberArrays: p.array_count, linkSources: p.link_source_count, linkTargets: p.link_target_count,
  }));
  return {
    generatedAt: new Date().toISOString(),
    protectionGroups: groups,
    arrayConnections: connections,
    activeClusterPods: pods,
    note: arrays.length === 0 ? 'No direct FlashArray connections; protection detail needs direct connections.'
      : groups.length === 0 ? 'No protection groups discovered.' : undefined,
  };
}

function gatherHardwareLifecycle() {
  const { arrays, names } = pureNames();
  const controllers = db.prepare('SELECT array_id, name, model, status, mode, version FROM pure_controllers').all()
    .map(c => ({ array: names.get(c.array_id) || `Array ${c.array_id}`, controller: c.name, model: c.model, status: c.status, mode: c.mode, version: c.version }));
  const badDrives = db.prepare(`
    SELECT array_id, name, type, status, capacity_bytes FROM pure_drives
    WHERE status IS NOT NULL AND LOWER(status) NOT IN ('healthy', 'unused', 'empty') LIMIT 30
  `).all().map(d => ({ array: names.get(d.array_id) || `Array ${d.array_id}`, drive: d.name, type: d.type, status: d.status, capacity: fmtBytes(d.capacity_bytes) }));
  const badHardware = db.prepare(`
    SELECT array_id, name, type, status FROM pure_hardware
    WHERE status IS NOT NULL AND LOWER(status) NOT IN ('ok', 'healthy', 'not_installed', 'unused') LIMIT 30
  `).all().map(h => ({ array: names.get(h.array_id) || `Array ${h.array_id}`, component: h.name, type: h.type, status: h.status }));
  const soon = Date.now() + 90 * 86400000;
  const certs = db.prepare('SELECT array_id, name, common_name, issued_by, valid_to_ms, status FROM pure_certificates').all()
    .filter(c => c.valid_to_ms != null && c.valid_to_ms < soon)
    .map(c => ({
      array: names.get(c.array_id) || `Array ${c.array_id}`,
      certificate: c.name, commonName: c.common_name, issuedBy: c.issued_by, status: c.status,
      expires: new Date(c.valid_to_ms).toISOString().slice(0, 10),
      expired: c.valid_to_ms < Date.now(),
    }));
  return {
    generatedAt: new Date().toISOString(),
    controllers,
    drivesNeedingAttention: badDrives,
    hardwareNeedingAttention: badHardware,
    certificatesExpiringWithin90Days: certs,
    note: arrays.length === 0 ? 'No direct FlashArray connections; hardware detail needs direct connections.' : undefined,
  };
}

function gatherHostConnectivity() {
  const { arrays, names } = pureNames();
  const hosts = db.prepare('SELECT array_id, name, connection_count, personality, protocol FROM pure_hosts').all();
  const volsByHost = new Map();
  for (const c of db.prepare('SELECT array_id, host_name, COUNT(*) n FROM pure_connections GROUP BY array_id, host_name').all()) {
    volsByHost.set(`${c.array_id}|${c.host_name}`, c.n);
  }
  const shaped = hosts.map(h => ({
    array: names.get(h.array_id) || `Array ${h.array_id}`,
    host: h.name, personality: h.personality, protocol: h.protocol,
    connectionCount: h.connection_count,
    volumesMapped: volsByHost.get(`${h.array_id}|${h.name}`) || 0,
  }));
  const mappedVolumes = new Set(db.prepare("SELECT DISTINCT array_id || '|' || volume_name AS k FROM pure_connections").all().map(r => r.k));
  const unmapped = db.prepare('SELECT array_id, name, provisioned_bytes FROM pure_volumes LIMIT 2000').all()
    .filter(v => !mappedVolumes.has(`${v.array_id}|${v.name}`))
    .slice(0, 30)
    .map(v => ({ array: names.get(v.array_id) || `Array ${v.array_id}`, volume: v.name, provisioned: fmtBytes(v.provisioned_bytes) }));
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      hosts: shaped.length,
      hostsWithNoVolumes: shaped.filter(h => h.volumesMapped === 0).length,
      hostsWithSingleConnection: shaped.filter(h => h.connectionCount != null && h.connectionCount <= 1).length,
    },
    hostsNeedingAttention: shaped.filter(h => h.volumesMapped === 0 || (h.connectionCount != null && h.connectionCount <= 1)).slice(0, 40),
    unmappedVolumes: unmapped,
    note: arrays.length === 0 ? 'No direct FlashArray connections; host detail needs direct connections.' : undefined,
  };
}

module.exports = createPlatformAdvisor({
  platform: 'pure',
  feature: 'Pure AI Advisor',
  table: 'pure_ai_reports',
  reports: {
    capacity: {
      system:
        'You are a senior SAN/storage engineer for a Pure Storage fleet (Pure1 SaaS and/or directly connected FlashArrays). ' +
        'You are given fleet totals and per-array capacity: usage %, used/total, data-reduction ratio, and modeled daily ' +
        'growth where history exists. Produce a capacity plan: identify arrays needing expansion soonest, flag anomalous ' +
        'growth, and suggest reclamation or rebalancing actions. Do not invent data; if growth history is thin, say so. ' +
        'Markdown sections: **Fleet summary**, **Needs attention (soonest first)**, **Recommended actions**. ' +
        'Keep under ~400 words.',
      gather: gatherCapacity,
      noun: 'capacity plan',
    },
    performance: {
      system:
        'You are a senior SAN/storage performance engineer for a Pure Storage fleet. You are given the latest per-array ' +
        'IOPS/latency/bandwidth snapshot (from Pure1 fleet metrics and/or direct array connections) and the top ' +
        'volume-level latency hotspots (volume detail requires direct connections — say so if absent). Identify arrays or ' +
        'volumes with elevated latency or saturated IOPS, and suggest likely causes and remediation. Do not invent data. ' +
        'Markdown sections: **Summary**, **Hotspots**, **Recommended actions**. Keep under ~350 words.',
      gather: gatherPerformance,
      noun: 'performance review',
    },
    alert_triage: {
      system:
        'You are an operations lead triaging active alerts across a Pure Storage fleet (Pure1 SaaS and/or directly ' +
        'connected arrays). You are given active alert totals by severity for each source and the noisiest alert types ' +
        'grouped by array. Separate signal from noise and give a prioritized triage plan. Do not invent data. ' +
        'Markdown sections: **Summary**, **Systemic patterns**, **Recommended triage order**. Keep under ~350 words.',
      gather: gatherAlertTriage,
      noun: 'alert triage report',
    },
    protection_posture: {
      system:
        'You are a data-protection and DR reviewer for a Pure Storage FlashArray fleet. You are given protection ' +
        'groups (snapshot and replication schedules, retention, target counts, groups with both OFF first), ' +
        'array-to-array replication connections with status, and ActiveCluster pods (promotion status, mediator, ' +
        'link counts). Assess protection posture: groups with no snapshots or replication, thin retention, broken ' +
        'array connections, and pods without a healthy mediator or links. Ransomware planning assumes the attacker ' +
        'was resident before detection, so weigh retention depth accordingly. Do not invent data. Markdown sections: ' +
        '**Posture summary**, **Gaps (prioritized)**, **Recommended actions**. Keep under ~400 words.',
      gather: gatherProtectionPosture,
      noun: 'data-protection posture review',
    },
    hardware_lifecycle: {
      system:
        'You are a Pure Storage hardware and lifecycle engineer. You are given controllers (model, status, mode, ' +
        'Purity version), drives and hardware components not in a healthy state, and management certificates already ' +
        'expired or expiring within 90 days. Flag failed or degraded components, mismatched controller Purity ' +
        'versions, and certificate work needed. Do not invent data. Markdown sections: **Summary**, ' +
        '**Findings (prioritized)**, **Recommended actions**. Keep under ~350 words.',
      gather: gatherHardwareLifecycle,
      noun: 'hardware and lifecycle report',
    },
    host_connectivity: {
      system:
        'You are a SAN connectivity reviewer for a Pure Storage fleet. You are given per-host connection counts and ' +
        'mapped-volume counts, the hosts with no volumes or a single connection, and volumes mapped to no host. A ' +
        'single connection is a redundancy risk; a host with no volumes and volumes with no host are cleanup ' +
        'candidates, though a recently prepared host can be legitimate. Do not invent data. Markdown sections: ' +
        '**Summary**, **Redundancy risks**, **Cleanup candidates**, **Recommended actions**. Keep under ~350 words.',
      gather: gatherHostConnectivity,
      noun: 'host connectivity review',
    },
  },
});
