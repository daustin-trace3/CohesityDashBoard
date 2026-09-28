const db = require('../../db/database');
const { createPlatformAdvisor, linReg, parseUtcMs, fmtBytes } = require('../platformAdvisor');
const { listFilesystems } = require('../vcenterGuestStorage');

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

function gatherGuestStorage() {
  const { summary, rows } = listFilesystems({ state: 'attention', sortBy: 'used_pct', sortDir: 'desc', pageSize: 40, page: 0 });
  const worst = rows.map(r => ({
    vm: r.vm_name, owner: r.owner || '(no owner tag)', mount: r.mount, fsType: r.fs_type,
    usedPct: r.used_pct, capacity: fmtBytes(r.capacity_bytes), free: fmtBytes(r.free_bytes),
    state: r.state, growthPerDay: r.growth_bytes_per_day > 0 ? fmtBytes(r.growth_bytes_per_day) + '/day' : null,
    daysToFull: r.days_to_full, cluster: r.cluster_name, vcenter: r.vcenter_name,
  }));
  const fillingFast = listFilesystems({ sortBy: 'days_to_full', sortDir: 'asc', pageSize: 15, page: 0 }).rows
    .filter(r => r.days_to_full != null && r.days_to_full <= 90)
    .map(r => ({
      vm: r.vm_name, owner: r.owner || '(no owner tag)', mount: r.mount, usedPct: r.used_pct,
      daysToFull: r.days_to_full, growthPerDay: fmtBytes(r.growth_bytes_per_day) + '/day', vcenter: r.vcenter_name,
    }));
  return {
    generatedAt: new Date().toISOString(),
    thresholds: summary.thresholds,
    summary: {
      volumesTracked: summary.volumes, vmsTracked: summary.vms,
      critical: summary.critical, warning: summary.warning,
      poweredOnVmsWithoutGuestData: summary.poweredOnWithoutData,
      poweredOnVmsToolsNotRunning: summary.poweredOnToolsNotRunning,
    },
    volumesOverThreshold: worst,
    fillingWithin90Days: fillingFast,
    volumesByOwner: (summary.owners || []).slice(0, 25),
    note: summary.volumes === 0 ? 'No guest filesystem data yet; it needs VMware Tools and a poll after the guest-storage feature.' : undefined,
  };
}

function gatherFailoverReadiness() {
  const sites = db.prepare('SELECT id, name FROM vcenter_sites ORDER BY sort_order, name').all();
  const members = db.prepare("SELECT site_id, vcenter_id, member_name FROM vcenter_site_members WHERE member_type = 'cluster'").all();
  const latest = db.prepare(`
    SELECT h.* FROM vcenter_capacity_history h
    WHERE h.captured_at = (
      SELECT MAX(h2.captured_at) FROM vcenter_capacity_history h2
      WHERE h2.vcenter_id = h.vcenter_id AND h2.cluster_name = h.cluster_name
    )
  `).all();
  const siteOf = new Map(members.map(m => [`${m.vcenter_id}|${m.member_name}`, m.site_id]));
  const rollup = new Map(sites.map(s => [s.id, { site: s.name, clusters: 0, hosts: 0, vms: 0, cpuCap: 0, cpuUsed: 0, memCap: 0, memUsed: 0 }]));
  for (const c of latest) {
    const sid = siteOf.get(`${c.vcenter_id}|${c.cluster_name}`);
    if (sid == null || !rollup.has(sid)) continue;
    const r = rollup.get(sid);
    r.clusters += 1; r.hosts += c.host_count || 0; r.vms += c.vms_on || 0;
    r.cpuCap += c.cpu_mhz_capacity || 0; r.cpuUsed += c.cpu_mhz_used || 0;
    r.memCap += c.mem_bytes_capacity || 0; r.memUsed += c.mem_bytes_used || 0;
  }
  const pct = (u, c) => (c > 0 ? +((u / c) * 100).toFixed(1) : null);
  const siteRows = [...rollup.entries()].map(([id, r]) => ({
    id, site: r.site, clusters: r.clusters, hosts: r.hosts, vmsOn: r.vms,
    cpuUsedPct: pct(r.cpuUsed, r.cpuCap), memUsedPct: pct(r.memUsed, r.memCap),
    memUsed: fmtBytes(r.memUsed), memCapacity: fmtBytes(r.memCap),
  }));
  const pairs = db.prepare('SELECT id, site_a_id, site_b_id FROM vcenter_site_pairs').all().map(p => {
    const a = rollup.get(p.site_a_id);
    const b = rollup.get(p.site_b_id);
    if (!a || !b) return null;
    const dir = (from, to) => ({
      survivingSite: to.site,
      cpuCombinedPct: pct(from.cpuUsed + to.cpuUsed, to.cpuCap),
      memCombinedPct: pct(from.memUsed + to.memUsed, to.memCap),
      fits: to.memCap > 0 && to.cpuCap > 0
        ? (from.memUsed + to.memUsed) <= to.memCap && (from.cpuUsed + to.cpuUsed) <= to.cpuCap : null,
    });
    return { pair: `${a.site} <-> ${b.site}`, ifAFails: dir(a, b), ifBFails: dir(b, a) };
  }).filter(Boolean);
  // 30-day memory-used growth per site, so headroom has a direction.
  const hist = db.prepare(`
    SELECT vcenter_id, cluster_name, captured_at, mem_bytes_used FROM vcenter_capacity_history
    WHERE captured_at >= datetime('now', '-30 days') ORDER BY captured_at ASC
  `).all();
  const seriesBySite = new Map();
  for (const r of hist) {
    const sid = siteOf.get(`${r.vcenter_id}|${r.cluster_name}`);
    if (sid == null) continue;
    if (!seriesBySite.has(sid)) seriesBySite.set(sid, new Map());
    const perT = seriesBySite.get(sid);
    const t = r.captured_at;
    perT.set(t, (perT.get(t) || 0) + (r.mem_bytes_used || 0));
  }
  const growth = [...seriesBySite.entries()].map(([sid, perT]) => {
    const pts = [...perT.entries()].map(([t, y]) => ({ x: parseUtcMs(t), y }));
    const reg = linReg(pts);
    const perDay = reg ? reg.slope * 86400000 : 0;
    return { site: rollup.get(sid)?.site, memGrowthPerDay: perDay > 0 ? fmtBytes(perDay) + '/day' : 'flat/declining', dataPoints: pts.length };
  });
  return {
    generatedAt: new Date().toISOString(),
    sites: siteRows,
    failoverPairs: pairs,
    memoryGrowthBySite: growth,
    note: sites.length === 0 ? 'No sites defined under vCenter Site Capacity.'
      : pairs.length === 0 ? 'No failover pairs configured; per-site figures only.' : undefined,
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
    guest_storage: {
      system:
        'You are a VMware guest-storage hygiene reviewer. You are given in-guest filesystems over the warning or ' +
        'critical threshold (worst first, with the owner team from vSphere tags), volumes projected to fill within ' +
        '90 days at their modeled growth, volume counts per owner, and how many powered-on VMs report no guest data ' +
        'or have VMware Tools not running (blind spots). Group findings by owner so each team sees its own disks, ' +
        'call out the volumes filling soonest, and treat the blind spots as a finding, not a footnote. Do not invent ' +
        'data. Markdown sections: **Summary**, **Filling soonest**, **By owner**, **Blind spots**, ' +
        '**Recommended actions**. Keep under ~400 words.',
      gather: gatherGuestStorage,
      noun: 'guest storage hygiene report',
    },
    failover_readiness: {
      system:
        'You are a DR capacity planner for a dual-datacenter VMware estate. You are given per-site CPU and memory ' +
        'utilization from the latest capacity samples, each configured failover pair with combined utilization in ' +
        'both directions (does the surviving site hold both sides today), and 30-day memory growth per site. State ' +
        'plainly for each pair whether a failover fits today in each direction, how much headroom remains, and how ' +
        'the growth trend moves the answer. If no pairs are configured, say what the per-site numbers alone support. ' +
        'Do not invent data. Markdown sections: **Readiness summary**, **Per-pair fit (both directions)**, ' +
        '**Trend and horizon**, **Recommended actions**. Keep under ~400 words.',
      gather: gatherFailoverReadiness,
      noun: 'failover readiness report',
    },
  },
});
