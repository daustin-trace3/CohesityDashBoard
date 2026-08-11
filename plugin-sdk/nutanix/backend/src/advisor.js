// Nutanix AI Advisor: capacity/replication/hotspots/resiliency reports.
// Ported from backend/services/advisors/nutanixAdvisor.js. The original
// module eagerly required the host's db + services/platformAdvisor at
// require-time; a bundled plugin has neither available until coreApi is
// handed to it, so this exports a FACTORY — createNutanixAdvisor(coreApi) —
// built lazily by router.js once coreApi is known. Per the plugin contract,
// coreApi.advisor is the host's services/platformAdvisor module
// (createPlatformAdvisor/linReg/parseUtcMs/fmtBytes), never required
// directly.
const { computeRpoCompliance } = require('./issues');

function createNutanixAdvisor(coreApi) {
  const db = coreApi.db;
  const { createPlatformAdvisor, linReg, parseUtcMs, fmtBytes } = coreApi.advisor;

  function gatherCapacity() {
    const sources = db.prepare('SELECT id, name FROM nutanix_sources').all();
    const names = new Map(sources.map((s) => [s.id, s.name]));

    const clusters = db.prepare('SELECT * FROM nutanix_clusters').all().map((c) => ({
      source: names.get(c.source_id) || `source ${c.source_id}`,
      cluster: c.name,
      numNodes: c.num_nodes,
      usedPct: c.storage_capacity_bytes > 0 ? +((c.storage_usage_bytes / c.storage_capacity_bytes) * 100).toFixed(1) : null,
      used: fmtBytes(c.storage_usage_bytes),
      total: fmtBytes(c.storage_capacity_bytes),
      runwayDays: c.runway_days,
    })).sort((a, b) => (b.usedPct ?? -1) - (a.usedPct ?? -1));

    const containers = db.prepare(`
      SELECT * FROM nutanix_containers WHERE capacity_bytes > 0 ORDER BY (CAST(usage_bytes AS REAL) / capacity_bytes) DESC LIMIT 20
    `).all().map((c) => ({
      source: names.get(c.source_id) || `source ${c.source_id}`,
      container: c.name,
      usedPct: +((c.usage_bytes / c.capacity_bytes) * 100).toFixed(1),
      used: fmtBytes(c.usage_bytes),
      total: fmtBytes(c.capacity_bytes),
    }));

    const history = db.prepare(`
      SELECT cluster_id, captured_at, storage_capacity_bytes, storage_usage_bytes
      FROM nutanix_metrics_history WHERE captured_at >= datetime('now', '-30 days') ORDER BY cluster_id, captured_at ASC
    `).all();
    const byCluster = new Map();
    for (const r of history) {
      if (!byCluster.has(r.cluster_id)) byCluster.set(r.cluster_id, []);
      byCluster.get(r.cluster_id).push(r);
    }
    const clusterRows = db.prepare('SELECT id, name, source_id FROM nutanix_clusters').all();
    const trend = clusterRows.map((c) => {
      const series = byCluster.get(c.id) || [];
      const pts = series.filter((r) => r.storage_usage_bytes != null).map((r) => ({ x: parseUtcMs(r.captured_at), y: r.storage_usage_bytes }));
      const reg = linReg(pts);
      const growthPerDay = reg ? reg.slope * 86400000 : 0;
      return {
        source: names.get(c.source_id) || `source ${c.source_id}`,
        cluster: c.name,
        growthPerDay: growthPerDay > 0 ? `${fmtBytes(growthPerDay)}/day` : 'flat/declining',
        dataPoints: series.length,
      };
    });

    return {
      generatedAt: new Date().toISOString(),
      sources: sources.length,
      clusters,
      lowFreeContainers: containers,
      trend,
      note: sources.length === 0 ? 'No Nutanix sources registered.' : undefined,
    };
  }

  function gatherReplication() {
    const sources = db.prepare('SELECT id, name FROM nutanix_sources').all();
    const names = new Map(sources.map((s) => [s.id, s.name]));

    const pds = db.prepare('SELECT * FROM nutanix_pds').all().map((pd) => ({
      source: names.get(pd.source_id) || `source ${pd.source_id}`,
      pd: pd.name,
      active: !!pd.active,
      vmCount: pd.vm_count,
      pendingReplications: pd.pending_replications,
      ongoingReplications: pd.ongoing_replications,
    }));

    const inFlight = db.prepare('SELECT * FROM nutanix_replications').all().map((r) => ({
      source: names.get(r.source_id) || `source ${r.source_id}`,
      pd: r.pd_name,
      remoteSite: r.remote_site,
      completedPct: r.completed_percentage,
      etaSecs: r.eta_secs,
      paused: !!r.paused,
    }));

    const remoteSites = db.prepare('SELECT * FROM nutanix_remote_sites').all().map((rs) => ({
      source: names.get(rs.source_id) || `source ${rs.source_id}`,
      site: rs.name,
      status: rs.status,
      latencyUsecs: rs.latency_usecs,
    }));

    const policies = db.prepare('SELECT * FROM nutanix_protection_policies WHERE rpo_secs IS NOT NULL').all().map((p) => ({
      source: names.get(p.source_id) || `source ${p.source_id}`,
      policy: p.name,
      rpoMinutes: p.rpo_secs != null ? Math.round(p.rpo_secs / 60) : null,
    }));

    const rpoViolations = computeRpoCompliance(coreApi, 50).filter((r) => r.compliant === false);

    return {
      generatedAt: new Date().toISOString(),
      protectionDomains: pds,
      inFlightReplications: inFlight,
      remoteSites,
      policies,
      rpoViolations,
      note: (pds.length + inFlight.length + policies.length) === 0 ? 'No DR/replication configuration collected yet.' : undefined,
    };
  }

  function gatherHotspots() {
    const sources = db.prepare('SELECT id, name FROM nutanix_sources').all();
    const names = new Map(sources.map((s) => [s.id, s.name]));

    const hotHosts = db.prepare(`
      SELECT * FROM nutanix_hosts WHERE cpu_usage_ppm IS NOT NULL OR memory_usage_ppm IS NOT NULL
      ORDER BY COALESCE(cpu_usage_ppm, 0) + COALESCE(memory_usage_ppm, 0) DESC LIMIT 20
    `).all().map((h) => ({
      source: names.get(h.source_id) || `source ${h.source_id}`,
      host: h.name,
      cpuPct: h.cpu_usage_ppm != null ? +(h.cpu_usage_ppm / 10000).toFixed(1) : null,
      memPct: h.memory_usage_ppm != null ? +(h.memory_usage_ppm / 10000).toFixed(1) : null,
      numVms: h.num_vms,
    }));

    const hotVms = db.prepare(`
      SELECT * FROM nutanix_vms WHERE controller_iops IS NOT NULL OR latency_usecs IS NOT NULL
      ORDER BY COALESCE(controller_iops, 0) DESC LIMIT 20
    `).all().map((v) => ({
      source: names.get(v.source_id) || `source ${v.source_id}`,
      vm: v.name,
      cluster: v.cluster_name,
      iops: v.controller_iops,
      latencyUsecs: v.latency_usecs,
      cpuPct: v.cpu_usage_ppm != null ? +(v.cpu_usage_ppm / 10000).toFixed(1) : null,
    }));

    const vmDensity = db.prepare(`
      SELECT source_id, name, num_vms FROM nutanix_hosts WHERE num_vms IS NOT NULL ORDER BY num_vms DESC LIMIT 20
    `).all().map((h) => ({ source: names.get(h.source_id) || `source ${h.source_id}`, host: h.name, vmCount: h.num_vms }));

    return {
      generatedAt: new Date().toISOString(),
      hotHosts,
      hotVms,
      vmDensity,
      note: (hotHosts.length + hotVms.length) === 0 ? 'No per-host/per-VM performance stats collected yet.' : undefined,
    };
  }

  function gatherResiliency() {
    const sources = db.prepare('SELECT id, name FROM nutanix_sources').all();
    const names = new Map(sources.map((s) => [s.id, s.name]));

    const clusters = db.prepare('SELECT * FROM nutanix_clusters').all().map((c) => ({
      source: names.get(c.source_id) || `source ${c.source_id}`,
      cluster: c.name,
      numNodes: c.num_nodes,
      redundancyFactor: c.redundancy_factor,
      ftFailuresTolerable: c.ft_failures_tolerable,
      nccPass: c.ncc_pass,
      nccWarn: c.ncc_warn,
      nccFail: c.ncc_fail,
    }));

    const degradedHosts = db.prepare('SELECT * FROM nutanix_hosts WHERE is_degraded = 1 OR maintenance_mode = 1').all().map((h) => ({
      source: names.get(h.source_id) || `source ${h.source_id}`,
      host: h.name,
      degraded: !!h.is_degraded,
      maintenance: !!h.maintenance_mode,
    }));

    const badDisks = db.prepare('SELECT * FROM nutanix_disks WHERE bad = 1 OR online = 0').all().map((d) => ({
      source: names.get(d.source_id) || `source ${d.source_id}`,
      disk: d.serial || d.disk_uuid,
      host: d.host_name,
      online: !!d.online,
      bad: !!d.bad,
    }));

    const openIssues = db.prepare(`
      SELECT source, severity, type, target, message, first_seen FROM nutanix_issue_history
      WHERE status = 'open' AND type IN ('resiliency', 'host-degraded', 'source-unreachable') ORDER BY first_seen ASC LIMIT 30
    `).all();

    return {
      generatedAt: new Date().toISOString(),
      clusters,
      degradedHosts,
      badDisks,
      openIssues,
      note: (clusters.length === 0) ? 'No cluster inventory collected yet.' : undefined,
    };
  }

  return createPlatformAdvisor({
    platform: 'nutanix',
    feature: 'Nutanix AI Advisor',
    table: 'nutanix_ai_reports',
    reports: {
      capacity: {
        system:
          'You are a Nutanix AHV capacity planner. You are given per-cluster storage usage % and runway days, the ' +
          'storage containers with the least free space %, and modeled per-cluster storage growth. Produce a capacity ' +
          'plan: identify clusters/containers needing attention soonest and flag anomalous growth. Do not invent data; ' +
          'if growth history is thin, say so. Markdown sections: **Summary**, **Needs attention (soonest first)**, ' +
          '**Recommended actions**. Keep under ~400 words.',
        gather: gatherCapacity,
        noun: 'capacity plan',
      },
      replication: {
        system:
          'You are a Nutanix Leap/PD-DR replication analyst. You are given protection domains, in-flight replications, ' +
          'remote site connectivity, configured RPO policies, and per-VM RPO compliance violations. Identify systemic DR ' +
          'risk (stalled replications, unreachable remote sites, chronic RPO misses) vs isolated incidents. Do not ' +
          'invent data. Markdown sections: **Summary**, **DR risks**, **Recommended actions**. Keep under ~400 words.',
        gather: gatherReplication,
        noun: 'replication review',
      },
      hotspots: {
        system:
          'You are a Nutanix AHV performance analyst. You are given the busiest hosts by CPU/memory %, the busiest VMs ' +
          'by controller IOPS/latency, and VM density per host. Identify hosts or VMs at risk of contention and note ' +
          'placement imbalance. Do not invent data. Markdown sections: **Summary**, **Hotspots**, **Recommended actions**. ' +
          'Keep under ~300 words.',
        gather: gatherHotspots,
        noun: 'hotspot review',
      },
      resiliency: {
        system:
          'You are a Nutanix cluster resiliency engineer. You are given per-cluster fault-tolerance/NCC health data, ' +
          'degraded or maintenance-mode hosts, unhealthy disks, and open resiliency-related issues. Identify clusters ' +
          'that cannot tolerate another failure and hardware needing attention. Do not invent data; single-node ' +
          '(Community Edition) clusters have no meaningful fault tolerance — note this rather than flag it as a defect. ' +
          'Markdown sections: **Summary**, **At-risk clusters**, **Recommended actions**. Keep under ~350 words.',
        gather: gatherResiliency,
        noun: 'resiliency review',
      },
    },
  });
}

module.exports = { createNutanixAdvisor };
