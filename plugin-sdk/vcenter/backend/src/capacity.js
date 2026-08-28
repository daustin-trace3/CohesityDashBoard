// Site-capacity service, ported from backend/services/vcenterCapacity.js.
// DEVIATION: the host module requires ../db/database; a bundled plugin gets
// its handle from coreApi, so every DB-touching function takes `db` first.
// Pure math (n1Usable / rollupSite / failoverMatrix / bucketHistory /
// growthOf) is verbatim.
const SAMPLE_GAP_MINUTES = 55;
const CLUSTER_RETENTION_DAYS = 365;
const VM_RETENTION_DAYS = 90;

/** N+1 usable = cluster capacity minus its largest host (0 for single-host clusters). */
function n1Usable(cluster) {
  if ((cluster.hostCount || 0) <= 1) return { cpuMhz: 0, memBytes: 0, cpuCores: 0 };
  return {
    cpuMhz: Math.max(0, (cluster.cpuMhzCapacity || 0) - (cluster.largestHostCpuMhz || 0)),
    memBytes: Math.max(0, (cluster.memBytesCapacity || 0) - (cluster.largestHostMemBytes || 0)),
    cpuCores: Math.max(0, (cluster.cpuCores || 0) - (cluster.largestHostCpuCores || 0)),
  };
}

function rollupSite(clusters) {
  const sum = {
    hostCount: 0, hostsConnected: 0, vmCount: 0, vmsOn: 0,
    cpuMhzCapacity: 0, cpuMhzUsed: 0, cpuCores: 0,
    memBytesCapacity: 0, memBytesUsed: 0,
    vcpuAllocated: 0, vmemMbAllocated: 0,
    usableCpuMhz: 0, usableMemBytes: 0, usableCpuCores: 0,
  };
  for (const c of clusters) {
    sum.hostCount += c.hostCount || 0;
    sum.hostsConnected += c.hostsConnected || 0;
    sum.vmCount += c.vmCount || 0;
    sum.vmsOn += c.vmsOn || 0;
    sum.cpuMhzCapacity += c.cpuMhzCapacity || 0;
    sum.cpuMhzUsed += c.cpuMhzUsed || 0;
    sum.cpuCores += c.cpuCores || 0;
    sum.memBytesCapacity += c.memBytesCapacity || 0;
    sum.memBytesUsed += c.memBytesUsed || 0;
    sum.vcpuAllocated += c.vcpuAllocated || 0;
    sum.vmemMbAllocated += c.vmemMbAllocated || 0;
    const u = n1Usable(c);
    sum.usableCpuMhz += u.cpuMhz;
    sum.usableMemBytes += u.memBytes;
    sum.usableCpuCores += u.cpuCores;
  }
  return sum;
}

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

function failoverMatrix(sites) {
  const total = { cpuMhzUsed: 0, memBytesUsed: 0, vcpuAllocated: 0, vmemMbAllocated: 0 };
  for (const s of sites) {
    total.cpuMhzUsed += s.cpuMhzUsed || 0;
    total.memBytesUsed += s.memBytesUsed || 0;
    total.vcpuAllocated += s.vcpuAllocated || 0;
    total.vmemMbAllocated += s.vmemMbAllocated || 0;
  }
  return sites.map((t) => {
    const cpuUsedPct = pct(total.cpuMhzUsed, t.usableCpuMhz);
    const memUsedPct = pct(total.memBytesUsed, t.usableMemBytes);
    return {
      target: t.name,
      cpuUsedPct,
      memUsedPct,
      vcpuPerCore: t.usableCpuCores > 0 ? Math.round((total.vcpuAllocated / t.usableCpuCores) * 100) / 100 : null,
      memAllocPct: pct(total.vmemMbAllocated * 1024 * 1024, t.usableMemBytes),
      fits: cpuUsedPct != null && memUsedPct != null && cpuUsedPct <= 100 && memUsedPct <= 100,
    };
  });
}

function siteMap(db) {
  const clusters = new Map();
  for (const m of db.prepare('SELECT site_id, vcenter_id, member_type, member_name FROM vcenter_site_members').all()) {
    const key = `${m.vcenter_id}|${m.member_name}`;
    if (m.member_type === 'cluster') clusters.set(key, m.site_id);
  }
  return { clusters };
}

function clusterStats(db, vcId = null) {
  const where = vcId != null ? 'WHERE c.vcenter_id = ?' : '';
  const args = vcId != null ? [vcId] : [];
  const clusters = db.prepare(`
    SELECT c.vcenter_id, v.name AS vcenter_name, c.name, c.cpu_mhz_capacity, c.cpu_mhz_used,
      c.mem_bytes_capacity, c.mem_bytes_used
    FROM vcenter_clusters c JOIN vcenter_vcenters v ON v.id = c.vcenter_id ${where}
    ORDER BY v.name, c.name
  `).all(...args);
  const hostAgg = new Map();
  for (const h of db.prepare(`
    SELECT vcenter_id, cluster_name, COUNT(*) AS host_count,
      SUM(CASE WHEN connection_state = 'CONNECTED' THEN 1 ELSE 0 END) AS hosts_connected,
      SUM(COALESCE(cpu_cores, 0)) AS cpu_cores,
      MAX(COALESCE(cpu_cores, 0)) AS largest_cores,
      MAX(COALESCE(cpu_mhz_capacity, 0)) AS largest_mhz,
      MAX(COALESCE(mem_bytes_capacity, 0)) AS largest_mem
    FROM vcenter_hosts WHERE cluster_name IS NOT NULL GROUP BY vcenter_id, cluster_name
  `).all()) hostAgg.set(`${h.vcenter_id}|${h.cluster_name}`, h);
  const vmAgg = new Map();
  for (const r of db.prepare(`
    SELECT vcenter_id, cluster_name, COUNT(*) AS vm_count,
      SUM(CASE WHEN power_state = 'POWERED_ON' THEN 1 ELSE 0 END) AS vms_on,
      SUM(CASE WHEN power_state = 'POWERED_ON' THEN COALESCE(cpu_count, 0) ELSE 0 END) AS vcpu,
      SUM(CASE WHEN power_state = 'POWERED_ON' THEN COALESCE(memory_mb, 0) ELSE 0 END) AS vmem_mb
    FROM vcenter_vms WHERE cluster_name IS NOT NULL GROUP BY vcenter_id, cluster_name
  `).all()) vmAgg.set(`${r.vcenter_id}|${r.cluster_name}`, r);

  return clusters.map((c) => {
    const key = `${c.vcenter_id}|${c.name}`;
    const h = hostAgg.get(key) || {};
    const v = vmAgg.get(key) || {};
    return {
      vcenterId: c.vcenter_id, vcenterName: c.vcenter_name, name: c.name,
      hostCount: h.host_count || 0, hostsConnected: h.hosts_connected || 0,
      vmCount: v.vm_count || 0, vmsOn: v.vms_on || 0,
      cpuCores: h.cpu_cores || 0, cpuMhzCapacity: c.cpu_mhz_capacity || 0, cpuMhzUsed: c.cpu_mhz_used || 0,
      memBytesCapacity: c.mem_bytes_capacity || 0, memBytesUsed: c.mem_bytes_used || 0,
      vcpuAllocated: v.vcpu || 0, vmemMbAllocated: v.vmem_mb || 0,
      largestHostCpuCores: h.largest_cores || 0, largestHostCpuMhz: h.largest_mhz || 0, largestHostMemBytes: h.largest_mem || 0,
    };
  });
}

function writeCapacitySample(db, vcId, { force = false } = {}) {
  if (!force) {
    const latest = db.prepare('SELECT MAX(captured_at) AS t FROM vcenter_capacity_history WHERE vcenter_id = ?').get(vcId).t;
    if (latest) {
      const iso = String(latest).includes('T') ? latest : `${String(latest).replace(' ', 'T')}Z`;
      if ((Date.now() - new Date(iso).getTime()) / 60000 < SAMPLE_GAP_MINUTES) return { sampled: false };
    }
  }
  const run = db.transaction(() => {
    const clusters = clusterStats(db, vcId);
    const clusterStmt = db.prepare(`
      INSERT INTO vcenter_capacity_history (vcenter_id, cluster_name, host_count, hosts_connected, vm_count, vms_on,
        cpu_cores, cpu_mhz_capacity, cpu_mhz_used, mem_bytes_capacity, mem_bytes_used, vcpu_allocated, vmem_mb_allocated,
        largest_host_cpu_cores, largest_host_cpu_mhz, largest_host_mem_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const c of clusters) {
      clusterStmt.run(vcId, c.name, c.hostCount, c.hostsConnected, c.vmCount, c.vmsOn,
        c.cpuCores, c.cpuMhzCapacity, c.cpuMhzUsed, c.memBytesCapacity, c.memBytesUsed,
        c.vcpuAllocated, c.vmemMbAllocated, c.largestHostCpuCores, c.largestHostCpuMhz, c.largestHostMemBytes);
    }
    const vmInfo = db.prepare(`
      INSERT INTO vcenter_vm_capacity_history (vcenter_id, vm_name, cluster_name, power_state, cpu_count, memory_mb,
        cpu_usage_mhz, mem_usage_mb, storage_committed_bytes)
      SELECT vcenter_id, name, cluster_name, power_state, cpu_count, memory_mb, cpu_usage_mhz, mem_usage_mb, storage_committed_bytes
      FROM vcenter_vms WHERE vcenter_id = ? AND name IS NOT NULL
    `).run(vcId);
    db.prepare("DELETE FROM vcenter_capacity_history WHERE vcenter_id = ? AND captured_at < datetime('now', ?)").run(vcId, `-${CLUSTER_RETENTION_DAYS} days`);
    db.prepare("DELETE FROM vcenter_vm_capacity_history WHERE vcenter_id = ? AND captured_at < datetime('now', ?)").run(vcId, `-${VM_RETENTION_DAYS} days`);
    return { clusters: clusters.length, vms: vmInfo.changes };
  });
  return { sampled: true, ...run() };
}

function bucketHistory(rows, hourly) {
  const buckets = new Map();
  for (const r of rows) {
    const ts = String(r.captured_at).replace(' ', 'T');
    const key = hourly ? ts.slice(0, 13) : ts.slice(0, 10);
    if (!buckets.has(key)) buckets.set(key, new Map());
    const perCluster = buckets.get(key);
    const ck = `${r.vcenter_id}|${r.cluster_name}`;
    const cur = perCluster.get(ck) || { n: 0, cpuSum: 0, memSum: 0, cpuPeak: 0, memPeak: 0, latest: null };
    cur.n += 1;
    cur.cpuSum += r.cpu_mhz_used || 0;
    cur.memSum += r.mem_bytes_used || 0;
    cur.cpuPeak = Math.max(cur.cpuPeak, r.cpu_mhz_used || 0);
    cur.memPeak = Math.max(cur.memPeak, r.mem_bytes_used || 0);
    cur.latest = r;
    perCluster.set(ck, cur);
  }
  return [...buckets.keys()].sort().map((key) => {
    const p = { t: hourly ? `${key}:00:00Z` : key, cpuMhzUsedAvg: 0, cpuMhzUsedPeak: 0, memBytesUsedAvg: 0, memBytesUsedPeak: 0,
      cpuMhzCapacity: 0, cpuCores: 0, memBytesCapacity: 0, usableCpuMhz: 0, usableMemBytes: 0, vcpuAllocated: 0, vmemMbAllocated: 0, vmsOn: 0 };
    for (const c of buckets.get(key).values()) {
      const l = c.latest;
      p.cpuMhzUsedAvg += c.cpuSum / c.n;
      p.memBytesUsedAvg += c.memSum / c.n;
      p.cpuMhzUsedPeak += c.cpuPeak;
      p.memBytesUsedPeak += c.memPeak;
      p.cpuMhzCapacity += l.cpu_mhz_capacity || 0;
      p.cpuCores += l.cpu_cores || 0;
      p.memBytesCapacity += l.mem_bytes_capacity || 0;
      const u = n1Usable({
        hostCount: l.host_count, cpuMhzCapacity: l.cpu_mhz_capacity, memBytesCapacity: l.mem_bytes_capacity, cpuCores: l.cpu_cores,
        largestHostCpuMhz: l.largest_host_cpu_mhz, largestHostMemBytes: l.largest_host_mem_bytes, largestHostCpuCores: l.largest_host_cpu_cores,
      });
      p.usableCpuMhz += u.cpuMhz;
      p.usableMemBytes += u.memBytes;
      p.vcpuAllocated += l.vcpu_allocated || 0;
      p.vmemMbAllocated += l.vmem_mb_allocated || 0;
      p.vmsOn += l.vms_on || 0;
    }
    p.cpuMhzUsedAvg = Math.round(p.cpuMhzUsedAvg);
    p.memBytesUsedAvg = Math.round(p.memBytesUsedAvg);
    return p;
  });
}

function growthOf(points, field, usableField) {
  if (points.length < 3) return { perDay: null, months: null };
  const t0 = new Date(points[0].t).getTime();
  const xs = points.map((p) => (new Date(p.t).getTime() - t0) / 86400000);
  const ys = points.map((p) => p[field]);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  if (den === 0) return { perDay: null, months: null };
  const perDay = num / den;
  const last = points[points.length - 1];
  const headroom = (last[usableField] || 0) - (last[field] || 0);
  const months = perDay > 0 && headroom > 0 ? Math.round((headroom / perDay / 30.44) * 10) / 10 : null;
  return { perDay: Math.round(perDay), months };
}

module.exports = {
  SAMPLE_GAP_MINUTES, CLUSTER_RETENTION_DAYS, VM_RETENTION_DAYS,
  n1Usable, rollupSite, failoverMatrix, siteMap, clusterStats, writeCapacitySample, bucketHistory, growthOf,
};
