// Proxmox VE AI Advisor: cluster-health/backup-posture/capacity-pressure
// reports. Pack-native factory - createProxmoxAdvisor(coreApi) - built lazily
// by routes.js once coreApi is known (dell/nutanix pack pattern). coreApi.db
// is the same underlying sqlite connection the host uses, and
// coreApi.advisor is the host's services/platformAdvisor module
// (createPlatformAdvisor/linReg/parseUtcMs/fmtBytes), never required
// directly. Feeds computeIssues() (this pack's issues.js) into cluster_health
// and capacity_pressure so the reports agree with the Issues page.
const { computeIssues, storageWarnPct, storageCritPct, backupStaleDays, certWarnDays, snapshotAgeDays } = require('./issues');

function daysRemaining(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return null;
  return Math.round(ms / 86400000);
}

function pct(used, total) {
  if (!total || total <= 0 || used == null) return null;
  return Math.round((used / total) * 1000) / 10;
}

function gb(bytes) {
  if (bytes == null) return null;
  return Math.round((bytes / (1024 ** 3)) * 10) / 10;
}

function issueSummary(issues) {
  const byType = {};
  const bySeverity = { critical: 0, warning: 0, info: 0 };
  for (const i of issues) {
    byType[i.type] = (byType[i.type] || 0) + 1;
    bySeverity[i.severity] = (bySeverity[i.severity] || 0) + 1;
  }
  return { total: issues.length, bySeverity, byType };
}

function createProxmoxAdvisor(coreApi) {
  const db = coreApi.db;

  function gatherClusterHealth() {
    const servers = db.prepare(`
      SELECT id, name, host, quorate, last_poll_status, last_poll_error, last_poll_at FROM proxmox_servers ORDER BY name
    `).all();
    const serverNames = new Map(servers.map((s) => [s.id, s.name]));

    const nodeRows = db.prepare(`
      SELECT n.*, s.name AS server_name FROM proxmox_nodes n JOIN proxmox_servers s ON s.id = n.server_id ORDER BY s.name, n.name
    `).all();
    const nodes = nodeRows.map((n) => ({
      server: n.server_name,
      node: n.name,
      status: n.status,
      cpuPct: n.cpu_usage != null ? Math.round(n.cpu_usage * 1000) / 10 : null,
      memPct: pct(n.mem_used, n.mem_total),
      diskPct: pct(n.disk_used, n.disk_total),
      uptimeDays: n.uptime_seconds != null ? Math.round(n.uptime_seconds / 86400) : null,
      pveVersion: n.pve_version,
      subscriptionStatus: n.subscription_status,
      updatesAvailable: !!n.updates_available,
      certDaysRemaining: daysRemaining(n.cert_expires_at),
    }));

    const versionCounts = new Map();
    for (const n of nodes) {
      if (!n.pveVersion) continue;
      versionCounts.set(n.pveVersion, (versionCounts.get(n.pveVersion) || 0) + 1);
    }
    let majorityVersion = null, majorityCount = -1;
    for (const [v, c] of versionCounts) if (c > majorityCount) { majorityVersion = v; majorityCount = c; }
    const versionDrift = nodes
      .filter((n) => n.pveVersion && n.pveVersion !== majorityVersion)
      .map((n) => ({ server: n.server, node: n.node, pveVersion: n.pveVersion }));

    const servicesDown = db.prepare(`
      SELECT sv.node, sv.name, sv.state, sv.unit_state, s.name AS server_name
      FROM proxmox_services sv JOIN proxmox_servers s ON s.id = sv.server_id
      WHERE sv.unit_state = 'enabled' AND sv.state != 'running'
      ORDER BY sv.node, sv.name LIMIT 30
    `).all().map((r) => ({ server: r.server_name, node: r.node, service: r.name, state: r.state }));

    const disksAtRisk = db.prepare(`
      SELECT d.node, d.devpath, d.serial, d.health, d.wearout, s.name AS server_name
      FROM proxmox_disks d JOIN proxmox_servers s ON s.id = d.server_id
      WHERE (d.health IS NOT NULL AND d.health NOT IN ('PASSED','OK','UNKNOWN',''))
         OR (d.wearout IS NOT NULL AND CAST(d.wearout AS REAL) > 80)
      ORDER BY (d.health NOT IN ('PASSED','OK','UNKNOWN','')) DESC LIMIT 30
    `).all().map((r) => ({
      server: r.server_name, node: r.node, devpath: r.devpath, serial: r.serial,
      health: r.health, wearoutPct: r.wearout != null ? Number(r.wearout) : null,
    }));

    // Quorum lives on proxmox_servers.quorate (set only when a cluster row
    // was seen), NOT on proxmox_metrics (that table has no quorum column) -
    // deviation from the preset wording, noted in the build report.
    const quorum = servers
      .filter((s) => s.quorate != null)
      .map((s) => ({ server: s.name, quorate: !!s.quorate }));

    const issues = computeIssues(coreApi);

    return {
      generatedAt: new Date().toISOString(),
      servers: servers.map((s) => ({
        server: s.name, host: s.host, quorate: s.quorate == null ? null : !!s.quorate,
        lastPollStatus: s.last_poll_status, lastPollError: s.last_poll_error, lastPollAt: s.last_poll_at,
      })),
      nodes,
      pveVersionDrift: { majorityVersion, nodesOffMajority: versionDrift },
      servicesNotRunning: servicesDown,
      disksAtRisk,
      quorum,
      issues: issueSummary(issues),
      topIssues: issues.slice(0, 20).map((i) => ({ severity: i.severity, type: i.type, source: i.source, target: i.target, message: i.message })),
      thresholds: {
        storageWarnPct: storageWarnPct(coreApi), storageCritPct: storageCritPct(coreApi),
        backupStaleDays: backupStaleDays(coreApi), certWarnDays: certWarnDays(coreApi), snapshotAgeDays: snapshotAgeDays(coreApi),
      },
      note: servers.length === 0 ? 'No Proxmox servers registered.' : undefined,
    };
  }

  function gatherBackupPosture() {
    const statusCounts = db.prepare(`
      SELECT COALESCE(last_backup_status, 'never') AS status, COUNT(*) AS count
      FROM proxmox_guests WHERE is_template = 0 GROUP BY status ORDER BY count DESC
    `).all();

    const staleDays = backupStaleDays(coreApi);
    const staleCutoff = db.prepare("SELECT datetime('now', ?) AS d").get(`-${staleDays} days`).d;
    const staleGuests = db.prepare(`
      SELECT g.name, g.vmid, g.node, g.type, g.last_backup_at, g.last_backup_status, s.name AS server_name
      FROM proxmox_guests g JOIN proxmox_servers s ON s.id = g.server_id
      WHERE g.is_template = 0 AND (g.last_backup_at IS NULL OR g.last_backup_status != 'OK' OR g.last_backup_at < ?)
      ORDER BY g.last_backup_at IS NULL DESC, g.last_backup_at ASC LIMIT 30
    `).all(staleCutoff).map((r) => ({
      server: r.server_name, guest: r.name, vmid: r.vmid, node: r.node, type: r.type,
      lastBackupAt: r.last_backup_at, lastBackupStatus: r.last_backup_status,
    }));

    const jobsCols = db.prepare("PRAGMA table_info('proxmox_backup_jobs')").all().map((c) => c.name);
    let backupJobs = [];
    if (jobsCols.length) {
      backupJobs = db.prepare(`
        SELECT j.schedule, j.enabled, j.storage, j.mode, s.name AS server_name
        FROM proxmox_backup_jobs j JOIN proxmox_servers s ON s.id = j.server_id
        ORDER BY s.name LIMIT 30
      `).all().map((r) => ({ server: r.server_name, schedule: r.schedule, enabled: !!r.enabled, storage: r.storage, mode: r.mode }));
    }

    const failedTasks = db.prepare(`
      SELECT t.node, t.target, t.status, t.started_at, t.ended_at, s.name AS server_name
      FROM proxmox_tasks t JOIN proxmox_servers s ON s.id = t.server_id
      WHERE t.type = 'vzdump' AND t.ended_at IS NOT NULL AND t.status IS NOT NULL AND t.status != 'OK'
        AND t.ended_at >= datetime('now', '-7 days')
      ORDER BY t.ended_at DESC LIMIT 20
    `).all().map((r) => ({
      server: r.server_name, node: r.node, target: r.target, error: r.status, startedAt: r.started_at, endedAt: r.ended_at,
    }));

    const snapAgeDays = snapshotAgeDays(coreApi);
    const oldestSnapshots = db.prepare(`
      SELECT sn.guest_name, sn.vmid, sn.name, sn.snap_time, s.name AS server_name
      FROM proxmox_snapshots sn JOIN proxmox_servers s ON s.id = sn.server_id
      WHERE sn.name != 'current' AND sn.snap_time IS NOT NULL
      ORDER BY sn.snap_time ASC LIMIT 20
    `).all().map((r) => ({
      server: r.server_name, guest: r.guest_name || String(r.vmid), snapshot: r.name,
      ageDays: Math.floor((Date.now() - new Date(r.snap_time).getTime()) / 86400000),
    }));

    const snapshotHeavyGuests = db.prepare(`
      SELECT g.name, g.vmid, g.snapshot_count, s.name AS server_name
      FROM proxmox_guests g JOIN proxmox_servers s ON s.id = g.server_id
      WHERE g.snapshot_count > 3 ORDER BY g.snapshot_count DESC LIMIT 20
    `).all().map((r) => ({ server: r.server_name, guest: r.name, vmid: r.vmid, snapshotCount: r.snapshot_count }));

    return {
      generatedAt: new Date().toISOString(),
      backupStatusCounts: statusCounts,
      staleGuests, staleDaysThreshold: staleDays,
      backupJobs,
      failedVzdumpTasks7d: failedTasks,
      snapshotAgeDaysThreshold: snapAgeDays,
      oldestSnapshots,
      snapshotHeavyGuests,
      note: statusCounts.length === 0 ? 'No non-template guests found.' : undefined,
    };
  }

  function gatherCapacityPressure() {
    const storagePools = db.prepare(`
      SELECT st.node, st.storage, st.type, st.shared, st.used_bytes, st.total_bytes, s.name AS server_name
      FROM proxmox_storage st JOIN proxmox_servers s ON s.id = st.server_id
      WHERE st.total_bytes IS NOT NULL AND st.total_bytes > 0
      ORDER BY (CAST(st.used_bytes AS REAL) / st.total_bytes) DESC LIMIT 20
    `).all().map((r) => ({
      server: r.server_name, node: r.node, storage: r.storage, type: r.type, shared: !!r.shared,
      usedGb: gb(r.used_bytes), totalGb: gb(r.total_bytes), usedPct: pct(r.used_bytes, r.total_bytes),
    }));

    const nodeTotals = db.prepare(`
      SELECT COUNT(*) AS nodeCount,
             SUM(mem_used) AS memUsed, SUM(mem_total) AS memTotal,
             SUM(disk_used) AS diskUsed, SUM(disk_total) AS diskTotal,
             AVG(cpu_usage) AS avgCpuUsage
      FROM proxmox_nodes
    `).get();

    const topMemGuests = db.prepare(`
      SELECT g.name, g.vmid, g.node, g.type, g.status, g.mem_used, g.mem_total, s.name AS server_name
      FROM proxmox_guests g JOIN proxmox_servers s ON s.id = g.server_id
      WHERE g.is_template = 0 AND g.mem_used IS NOT NULL
      ORDER BY g.mem_used DESC LIMIT 20
    `).all().map((r) => ({
      server: r.server_name, guest: r.name, vmid: r.vmid, node: r.node, type: r.type, status: r.status,
      memUsedGb: gb(r.mem_used), memPct: pct(r.mem_used, r.mem_total),
    }));

    const topCpuGuests = db.prepare(`
      SELECT g.name, g.vmid, g.node, g.type, g.status, g.cpu_usage, s.name AS server_name
      FROM proxmox_guests g JOIN proxmox_servers s ON s.id = g.server_id
      WHERE g.is_template = 0 AND g.cpu_usage IS NOT NULL
      ORDER BY g.cpu_usage DESC LIMIT 20
    `).all().map((r) => ({
      server: r.server_name, guest: r.name, vmid: r.vmid, node: r.node, type: r.type, status: r.status,
      cpuPct: r.cpu_usage != null ? Math.round(r.cpu_usage * 1000) / 10 : null,
    }));

    const stoppedConsumingDisk = db.prepare(`
      SELECT g.name, g.vmid, g.node, g.type, g.status, g.disk_used, s.name AS server_name
      FROM proxmox_guests g JOIN proxmox_servers s ON s.id = g.server_id
      WHERE g.is_template = 0 AND g.status != 'running' AND g.disk_used IS NOT NULL AND g.disk_used > 0
      ORDER BY g.disk_used DESC LIMIT 20
    `).all().map((r) => ({
      server: r.server_name, guest: r.name, vmid: r.vmid, node: r.node, type: r.type, status: r.status, diskUsedGb: gb(r.disk_used),
    }));

    const issues = computeIssues(coreApi).filter((i) => i.type.startsWith('storage-'));

    return {
      generatedAt: new Date().toISOString(),
      storagePools,
      nodeTotals: {
        nodeCount: nodeTotals.nodeCount || 0,
        memUsedGb: gb(nodeTotals.memUsed), memTotalGb: gb(nodeTotals.memTotal), memPct: pct(nodeTotals.memUsed, nodeTotals.memTotal),
        diskUsedGb: gb(nodeTotals.diskUsed), diskTotalGb: gb(nodeTotals.diskTotal), diskPct: pct(nodeTotals.diskUsed, nodeTotals.diskTotal),
        avgCpuPct: nodeTotals.avgCpuUsage != null ? Math.round(nodeTotals.avgCpuUsage * 1000) / 10 : null,
      },
      topMemGuests, topCpuGuests, stoppedConsumingDisk,
      storageIssues: issues.map((i) => ({ severity: i.severity, source: i.source, target: i.target, message: i.message })),
      note: storagePools.length === 0 ? 'No storage pools recorded.' : undefined,
    };
  }

  return coreApi.advisor.createPlatformAdvisor({
    platform: 'proxmox',
    feature: 'Proxmox VE AI Advisor',
    table: 'proxmox_ai_reports',
    reports: {
      cluster_health: {
        system:
          'You are a Proxmox VE cluster administrator. You are given per-node health (CPU/memory/disk, PVE version, ' +
          'subscription, cert expiry), PVE version drift across nodes, services enabled but not running, disks with ' +
          'failing SMART health or high wearout, cluster quorum state, and a computed-issues summary with the ' +
          'thresholds behind it. Identify which nodes/services/disks need attention soonest and likely causes. Do not ' +
          'invent data. Names are anonymized tokens; keep them as-is. Markdown sections: **Summary**, **Findings ' +
          '(severity-ordered)**, **Recommended actions**, **Data gaps**. Keep under ~400 words.',
        gather: gatherClusterHealth,
        noun: 'cluster health report',
      },
      backup_posture: {
        system:
          'You are a Proxmox VE backup administrator reviewing vzdump coverage. You are given guest backup-status ' +
          'counts, guests stale beyond the configured threshold, configured backup jobs, vzdump tasks that failed in ' +
          'the last 7 days, the oldest snapshots past the age threshold, and guests carrying more than 3 snapshots. ' +
          'Identify coverage gaps and snapshot buildup risk, and give a prioritized remediation order. Do not invent ' +
          'data. Names are anonymized tokens; keep them as-is. Markdown sections: **Summary**, **Findings ' +
          '(severity-ordered)**, **Recommended actions**, **Data gaps**. Keep under ~400 words.',
        gather: gatherBackupPosture,
        noun: 'backup posture report',
      },
      capacity_pressure: {
        system:
          'You are a Proxmox VE capacity planner. You are given storage pools ranked by used percent, aggregate node ' +
          'CPU/memory/disk totals, the top guests by memory and CPU consumption, stopped guests still holding disk ' +
          'space, and active storage-capacity issues. Identify where the estate is closest to running out of headroom ' +
          'and what to reclaim or expand first. Do not invent data. Names are anonymized tokens; keep them as-is. ' +
          'Markdown sections: **Summary**, **Findings (severity-ordered)**, **Recommended actions**, **Data gaps**. ' +
          'Keep under ~400 words.',
        gather: gatherCapacityPressure,
        noun: 'capacity pressure report',
      },
    },
  });
}

module.exports = { createProxmoxAdvisor };
