// Demo fixtures for the site-capacity feature, ported from the capacity block
// of backend/demo/generators/vcenter.js. Runs AFTER seedVcenter has laid down
// clusters/hosts/VMs: creates one site per cluster, scales memory demand to
// ~60% of total N+1 usable (with an allocation floor so used never exceeds
// allocated), then writes 90 days of capacity history at the density the
// hourly sampler would leave.

// Demo-only — the DASHBOARD_DEMO gate lives in poller.js.
const { randFloat, rngFor } = require('./demoRng');
const { clusterStats, rollupSite } = require('./capacity');

// Demo narrative (Doug, 2026-08-28): every cluster is its own site, named after
// the cluster, so the Capacity pages read per cluster.
const PALETTE = ['#0091DA', '#6CB33F', '#D4A24E', '#9B6CD4', '#4ED4B8', '#D46CB3', '#C75D5D', '#8FA3B0'];

function seedCapacityDemo(db, { now, vcenterIds }) {
  const inVcs = vcenterIds.length ? `(${vcenterIds.map(() => '?').join(',')})` : '(NULL)';

  // One site per fixture cluster, upserted by name so ids stay stable across reseeds.
  const upsertSite = db.prepare(`
    INSERT INTO vcenter_sites (name, color, sort_order) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET color = excluded.color, sort_order = excluded.sort_order
  `);
  const clusters = db.prepare(`SELECT vcenter_id, name FROM vcenter_clusters WHERE vcenter_id IN ${inVcs} ORDER BY name`).all(...vcenterIds);
  clusters.forEach((cl, idx) => upsertSite.run(cl.name, PALETTE[idx % PALETTE.length], idx));
  const siteIdByName = new Map(db.prepare('SELECT id, name FROM vcenter_sites').all().map((s) => [s.name, s.id]));

  // Membership for the fixture vCenters only (a real admin-added vCenter's mapping is untouched).
  db.prepare(`DELETE FROM vcenter_site_members WHERE vcenter_id IN ${inVcs}`).run(...vcenterIds);
  const insertMember = db.prepare(`
    INSERT INTO vcenter_site_members (site_id, vcenter_id, member_type, member_name, replicated) VALUES (?, ?, ?, ?, ?)
  `);
  for (const cl of clusters) insertMember.run(siteIdByName.get(cl.name), cl.vcenter_id, 'cluster', cl.name, 0);
  // Demo box only: drop sites left over from an earlier narrative that no longer hold a cluster.
  db.prepare('DELETE FROM vcenter_sites WHERE id NOT IN (SELECT DISTINCT site_id FROM vcenter_site_members)').run();

  // Scale memory demand so the estate runs at ~60% of its total N+1 usable —
  // busy enough that moving a few large VMs into one cluster tips it over.
  const stats = clusterStats(db);
  const totalUsable = rollupSite(stats).usableMemBytes;
  const totalUsed = stats.reduce((n, c) => n + c.memBytesUsed, 0);
  if (totalUsed > 0 && totalUsable > 0) {
    const f = (totalUsable * 0.6) / totalUsed;
    db.prepare(`UPDATE vcenter_clusters SET mem_bytes_used = CAST(mem_bytes_used * ? AS INTEGER) WHERE vcenter_id IN ${inVcs}`).run(f, ...vcenterIds);
    db.prepare(`UPDATE vcenter_hosts SET mem_bytes_used = MIN(mem_bytes_capacity, CAST(mem_bytes_used * ? AS INTEGER)) WHERE vcenter_id IN ${inVcs}`).run(f, ...vcenterIds);
    // Grow VM allocations with demand when scaling UP so used never exceeds
    // allocated (rounded to 512 MiB so sizes still look hand-picked).
    if (f > 1) {
      db.prepare(`UPDATE vcenter_vms SET memory_mb = CAST(ROUND(memory_mb * ? / 512.0) * 512 AS INTEGER) WHERE vcenter_id IN ${inVcs} AND memory_mb IS NOT NULL`).run(f, ...vcenterIds);
    }
    db.prepare(`UPDATE vcenter_vms SET mem_usage_mb = MIN(memory_mb, CAST(mem_usage_mb * ? AS INTEGER)) WHERE vcenter_id IN ${inVcs} AND mem_usage_mb IS NOT NULL`).run(f, ...vcenterIds);
  }
  // Per-cluster sanity: host memory in use can't exceed what powered-on VMs
  // were given. Where the base fixture breaks that, grow that cluster's VM
  // allocations so allocated >= 1.1 x used (allocated > used > 0 reads right).
  const bumpVm = db.prepare(`UPDATE vcenter_vms SET memory_mb = CAST(ROUND(memory_mb * ? / 512.0) * 512 AS INTEGER)
    WHERE vcenter_id = ? AND cluster_name = ? AND memory_mb IS NOT NULL`);
  for (const c of clusterStats(db).filter((c) => vcenterIds.includes(c.vcenterId))) {
    const usedMb = c.memBytesUsed / (1024 * 1024);
    if (c.vmemMbAllocated > 0 && c.vmemMbAllocated < usedMb * 1.1) bumpVm.run((usedMb * 1.1) / c.vmemMbAllocated, c.vcenterId, c.name);
  }

  // History: hourly for the last 7 days, 6-hourly back to 30 days, daily back to 90.
  db.prepare(`DELETE FROM vcenter_capacity_history WHERE vcenter_id IN ${inVcs}`).run(...vcenterIds);
  db.prepare(`DELETE FROM vcenter_vm_capacity_history WHERE vcenter_id IN ${inVcs}`).run(...vcenterIds);
  const sampleHours = [];
  for (let h = 90 * 24; h >= 0; h--) {
    const d = h / 24;
    if (d <= 7 || (d <= 30 && h % 6 === 0) || h % 24 === 0) sampleHours.push(h);
  }
  const insertCap = db.prepare(`
    INSERT INTO vcenter_capacity_history (vcenter_id, captured_at, cluster_name, host_count, hosts_connected, vm_count, vms_on,
      cpu_cores, cpu_mhz_capacity, cpu_mhz_used, mem_bytes_capacity, mem_bytes_used, vcpu_allocated, vmem_mb_allocated,
      largest_host_cpu_cores, largest_host_cpu_mhz, largest_host_mem_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const capRng = rngFor('vcenter-cap-history');
  let capRows = 0;
  for (const c of clusterStats(db).filter((c) => vcenterIds.includes(c.vcenterId))) {
    for (const hourOffset of sampleHours) {
      const dayOffset = hourOffset / 24;
      const t = new Date(now - hourOffset * 3600000);
      const trend = 1.0 - (dayOffset / 90) * 0.3;
      const sine = 0.85 + 0.15 * Math.cos(((t.getUTCHours() - 14) / 24) * 2 * Math.PI);
      const burst = dayOffset >= 40 && dayOffset <= 47 ? randFloat(capRng, 1.15, 1.35, 2) : 1.0;
      const memF = Math.max(0.3, trend * sine * burst);
      const cpuF = Math.max(0.2, trend * sine * 0.9 * burst);
      insertCap.run(c.vcenterId, t.toISOString(), c.name, c.hostCount, c.hostsConnected, c.vmCount,
        Math.round(c.vmsOn * (0.9 + 0.1 * trend)), c.cpuCores, c.cpuMhzCapacity, Math.round(c.cpuMhzUsed * cpuF),
        c.memBytesCapacity, Math.round(c.memBytesUsed * memF), Math.round(c.vcpuAllocated * (0.85 + 0.15 * trend)),
        Math.round(c.vmemMbAllocated * (0.85 + 0.15 * trend)), c.largestHostCpuCores, c.largestHostCpuMhz, c.largestHostMemBytes);
      capRows += 1;
    }
  }
  const insertVm = db.prepare(`
    INSERT INTO vcenter_vm_capacity_history (vcenter_id, captured_at, vm_name, cluster_name, power_state, cpu_count, memory_mb,
      cpu_usage_mhz, mem_usage_mb, storage_committed_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const vmRng = rngFor('vcenter-vm-history');
  let vmRows = 0;
  for (const vm of db.prepare(`SELECT vcenter_id, name, cluster_name, power_state, cpu_count, memory_mb, cpu_usage_mhz, mem_usage_mb, storage_committed_bytes
      FROM vcenter_vms WHERE vcenter_id IN ${inVcs} AND power_state = 'POWERED_ON'`).all(...vcenterIds)) {
    for (let d = 30; d >= 0; d--) {
      for (let hour = 0; hour < 24; hour += 6) {
        const t = new Date(now - d * 86400000 - (23 - hour) * 3600000);
        const business = t.getUTCHours() >= 9 && t.getUTCHours() <= 17;
        const f = business ? randFloat(vmRng, 0.7, 1.0, 2) : randFloat(vmRng, 0.25, 0.55, 2);
        insertVm.run(vm.vcenter_id, t.toISOString(), vm.name, vm.cluster_name, vm.power_state, vm.cpu_count, vm.memory_mb,
          Math.round((vm.cpu_usage_mhz || 0) * f), Math.round((vm.mem_usage_mb || 0) * f), vm.storage_committed_bytes);
        vmRows += 1;
      }
    }
  }
  return { sites: clusters.length, capacityHistory: capRows, vmCapacityHistory: vmRows };
}

module.exports = { seedCapacityDemo };
