// Proxmox VE poller — one scheduled task per registered server (framework
// per-source model, like vCenter/AWS). Each poll walks version -> nodes ->
// per-node (status, qemu, lxc, storage, tasks, certificates, subscription,
// apt) -> cluster/resources, cluster/backup, cluster/status, replaces the
// inventory tables for that server and appends one metrics row per node.
const db = require('../db/database');
const { createPoller } = require('../core/pollerFramework');
const proxmoxApi = require('./proxmoxApi');
const { reconcileIssueHistory } = require('./proxmoxIssues');
const logger = require('../utils/logger');

const safeMsg = (e) => (e?.response ? `HTTP ${e.response.status}` : (e?.message || String(e)));

async function collect(server) {
  const forbidden = new Set();

  await proxmoxApi.fetchVersion(server); // also the connectivity check; throws on failure

  const nodes = await proxmoxApi.fetchNodes(server);

  let clusterResources = [];
  try {
    clusterResources = await proxmoxApi.pveGet(server, '/cluster/resources');
  } catch (err) {
    if (err?.pveForbidden) forbidden.add('cluster/resources');
  }
  clusterResources = clusterResources || [];
  const resourceGuests = new Map(); // `${type}/${vmid}` -> row
  for (const r of clusterResources) {
    if (r.type === 'qemu' || r.type === 'lxc') resourceGuests.set(`${r.type}/${r.vmid}`, r);
  }

  const nodeRows = [];
  const guestRows = [];
  const storageRows = [];
  const taskRows = [];

  for (const n of nodes) {
    const nodeName = n.node;
    let status = null;
    try {
      status = await proxmoxApi.pveGet(server, `/nodes/${nodeName}/status`);
    } catch (err) {
      if (err?.pveForbidden) { forbidden.add('nodes/status'); }
    }

    const [qemu, lxc, storage, tasks, certs, subscription] = await Promise.all([
      proxmoxApi.fetchQemu(server, nodeName),
      proxmoxApi.fetchLxc(server, nodeName),
      proxmoxApi.fetchNodeStorage(server, nodeName),
      proxmoxApi.fetchTasks(server, nodeName, 200),
      proxmoxApi.fetchCertificates(server, nodeName),
      proxmoxApi.fetchSubscription(server, nodeName),
    ]);

    const pveSslCert = Array.isArray(certs) ? certs.find((c) => c.filename === 'pve-ssl.pem') : null;

    nodeRows.push({
      name: nodeName,
      status: n.status || null,
      cpuUsage: status?.cpu ?? n.cpu ?? null,
      cpuTotal: status?.cpuinfo?.cpus ?? n.maxcpu ?? null,
      memUsed: status?.memory?.used ?? n.mem ?? null,
      memTotal: status?.memory?.total ?? n.maxmem ?? null,
      diskUsed: status?.rootfs?.used ?? n.disk ?? null,
      diskTotal: status?.rootfs?.total ?? n.maxdisk ?? null,
      uptimeSeconds: status?.uptime ?? n.uptime ?? null,
      loadAvg: Array.isArray(status?.loadavg) ? status.loadavg.join(', ') : null,
      pveVersion: status?.pveversion ?? null,
      kernelVersion: status?.kversion ?? null,
      certExpiresAt: pveSslCert?.notafter != null ? new Date(pveSslCert.notafter * 1000).toISOString() : null,
      subscriptionStatus: subscription?.status ?? null,
      updatesAvailable: null, // set below once apt/update is fetched
    });

    // apt updates count (fetched separately; tolerate 403).
    let aptUpdates = [];
    try {
      aptUpdates = await proxmoxApi.fetchAptUpdates(server, nodeName);
    } catch { /* tolerate */ }
    nodeRows[nodeRows.length - 1].updatesAvailable = Array.isArray(aptUpdates) ? aptUpdates.length : null;

    for (const g of qemu) {
      const cr = resourceGuests.get(`qemu/${g.vmid}`);
      guestRows.push(toGuestRow(g, 'qemu', nodeName, cr));
    }
    for (const g of lxc) {
      const cr = resourceGuests.get(`lxc/${g.vmid}`);
      guestRows.push(toGuestRow(g, 'lxc', nodeName, cr));
    }

    for (const s of storage) {
      storageRows.push({
        node: nodeName, storage: s.storage, type: s.type, content: s.content,
        active: s.active ? 1 : 0, shared: s.shared ? 1 : 0,
        usedBytes: s.used ?? null, totalBytes: s.total ?? null, availBytes: s.avail ?? null,
      });
    }

    for (const t of tasks) {
      taskRows.push({
        upid: t.upid, node: nodeName, type: t.type, target: t.id ?? null, user: t.user ?? null,
        status: t.endtime != null ? (t.status || 'unknown') : 'running',
        startedAt: t.starttime != null ? new Date(t.starttime * 1000).toISOString() : null,
        endedAt: t.endtime != null ? new Date(t.endtime * 1000).toISOString() : null,
      });
    }
  }

  // Any guest present only via cluster/resources (not per-node lists) — fallback coverage.
  for (const [key, r] of resourceGuests) {
    const [type, vmidStr] = key.split('/');
    const vmid = Number(vmidStr);
    if (!guestRows.some((g) => g.type === type && g.vmid === vmid)) {
      guestRows.push({
        vmid, name: r.name || null, type, node: r.node || null, status: r.status || null,
        isTemplate: r.template ? 1 : 0, cpuCount: r.maxcpu ?? null, cpuUsage: r.cpu ?? null,
        memUsed: r.mem ?? null, memTotal: r.maxmem ?? null, diskUsed: r.disk ?? null, diskTotal: r.maxdisk ?? null,
        uptimeSeconds: r.uptime ?? null, netIn: r.netin ?? null, netOut: r.netout ?? null,
        pool: r.pool ?? null, tags: r.tags ?? null,
      });
    }
  }

  let backupJobs = [];
  try {
    backupJobs = (await proxmoxApi.pveGet(server, '/cluster/backup')) || [];
  } catch (err) {
    if (err?.pveForbidden) { forbidden.add('cluster/backup'); }
  }

  let clusterStatus = [];
  try {
    clusterStatus = await proxmoxApi.fetchClusterStatus(server);
  } catch { /* tolerate; quorate stays as-is */ }

  const clusterRow = Array.isArray(clusterStatus) ? clusterStatus.find((r) => r.type === 'cluster') : null;
  const quorate = clusterRow ? (clusterRow.quorate ? 1 : 0) : null;

  return {
    nodes: nodeRows, guests: guestRows, storage: storageRows, tasks: taskRows,
    backupJobs, quorate,
    forbiddenEndpoints: [...forbidden],
  };
}

function toGuestRow(g, type, nodeName, cr) {
  return {
    vmid: Number(g.vmid),
    name: g.name ?? cr?.name ?? null,
    type,
    node: nodeName,
    status: g.status ?? cr?.status ?? null,
    isTemplate: g.template ? 1 : 0,
    cpuCount: g.cpus ?? cr?.maxcpu ?? null,
    cpuUsage: g.cpu ?? cr?.cpu ?? null,
    memUsed: g.mem ?? cr?.mem ?? null,
    memTotal: g.maxmem ?? cr?.maxmem ?? null,
    diskUsed: g.disk ?? cr?.disk ?? null,
    diskTotal: g.maxdisk ?? cr?.maxdisk ?? null,
    uptimeSeconds: g.uptime ?? cr?.uptime ?? null,
    netIn: g.netin ?? cr?.netin ?? null,
    netOut: g.netout ?? cr?.netout ?? null,
    pool: cr?.pool ?? null,
    tags: g.tags ?? cr?.tags ?? null,
  };
}

const store = db.transaction((serverId, data) => {
  const { nodes, guests, storage, tasks, backupJobs, quorate, forbiddenEndpoints } = data;

  db.prepare('DELETE FROM proxmox_nodes WHERE server_id = ?').run(serverId);
  const nodeStmt = db.prepare(`
    INSERT INTO proxmox_nodes (server_id, name, status, cpu_usage, cpu_total, mem_used, mem_total,
      disk_used, disk_total, uptime_seconds, load_avg, pve_version, kernel_version,
      cert_expires_at, subscription_status, updates_available)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const n of nodes) {
    nodeStmt.run(serverId, n.name, n.status, n.cpuUsage, n.cpuTotal, n.memUsed, n.memTotal,
      n.diskUsed, n.diskTotal, n.uptimeSeconds, n.loadAvg, n.pveVersion, n.kernelVersion,
      n.certExpiresAt, n.subscriptionStatus, n.updatesAvailable);
  }

  db.prepare('DELETE FROM proxmox_guests WHERE server_id = ?').run(serverId);
  const guestStmt = db.prepare(`
    INSERT INTO proxmox_guests (server_id, vmid, name, type, node, status, is_template,
      cpu_count, cpu_usage, mem_used, mem_total, disk_used, disk_total, uptime_seconds,
      net_in, net_out, pool, tags, last_backup_at, last_backup_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Preserve last_backup_at/status across polls (derived below from tasks),
  // seeded from the previous row so a guest not seen in this poll's tasks
  // doesn't regress to NULL.
  const prevBackup = new Map(
    db.prepare('SELECT vmid, last_backup_at, last_backup_status FROM proxmox_guests WHERE server_id = ?')
      .all(serverId).map((r) => [r.vmid, { at: r.last_backup_at, status: r.last_backup_status }])
  );
  // Newest vzdump task per vmid from this poll's task set.
  const latestVzdump = new Map();
  for (const t of tasks) {
    if (t.type !== 'vzdump' || !t.target) continue;
    const vmid = Number(t.target);
    if (!Number.isFinite(vmid)) continue;
    const at = t.endedAt || t.startedAt;
    const existing = latestVzdump.get(vmid);
    if (!existing || (at && at > existing.at)) latestVzdump.set(vmid, { at, status: t.status });
  }
  for (const g of guests) {
    const latest = latestVzdump.get(g.vmid);
    const prev = prevBackup.get(g.vmid);
    const lastBackupAt = latest?.at ?? prev?.at ?? null;
    const lastBackupStatus = latest?.status ?? prev?.status ?? null;
    guestStmt.run(serverId, g.vmid, g.name, g.type, g.node, g.status, g.isTemplate,
      g.cpuCount, g.cpuUsage, g.memUsed, g.memTotal, g.diskUsed, g.diskTotal, g.uptimeSeconds,
      g.netIn, g.netOut, g.pool, g.tags ? JSON.stringify(g.tags) : null, lastBackupAt, lastBackupStatus);
  }

  db.prepare('DELETE FROM proxmox_storage WHERE server_id = ?').run(serverId);
  const storageStmt = db.prepare(`
    INSERT INTO proxmox_storage (server_id, node, storage, type, content, active, shared,
      used_bytes, total_bytes, avail_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const s of storage) {
    storageStmt.run(serverId, s.node, s.storage, s.type, s.content, s.active, s.shared,
      s.usedBytes, s.totalBytes, s.availBytes);
  }

  db.prepare('DELETE FROM proxmox_backup_jobs WHERE server_id = ?').run(serverId);
  const jobStmt = db.prepare(`
    INSERT INTO proxmox_backup_jobs (server_id, job_id, enabled, schedule, storage, mode, compress, selection, next_run)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const j of backupJobs) {
    const selection = j.all === 1 || j.all === '1' ? 'all' : (j.vmid ?? null);
    jobStmt.run(serverId, j.id, j.enabled ? 1 : 0, j.schedule ?? null, j.storage ?? null,
      j.mode ?? null, j.compress ?? null, selection,
      j['next-run'] != null ? new Date(Number(j['next-run']) * 1000).toISOString() : null);
  }

  // Tasks: upsert (keep the rolling 14-day window; don't wholesale-replace so
  // the ended_at based history isn't lost between polls).
  const taskStmt = db.prepare(`
    INSERT INTO proxmox_tasks (server_id, upid, node, type, target, user, status, started_at, ended_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(server_id, upid) DO UPDATE SET
      status = excluded.status, ended_at = excluded.ended_at, updated_at = datetime('now')
  `);
  for (const t of tasks) {
    taskStmt.run(serverId, t.upid, t.node, t.type, t.target, t.user, t.status, t.startedAt, t.endedAt);
  }
  db.prepare("DELETE FROM proxmox_tasks WHERE server_id = ? AND started_at < datetime('now', '-14 days')").run(serverId);

  // One metrics row per node per poll.
  const metricsStmt = db.prepare(`
    INSERT INTO proxmox_metrics (server_id, node, cpu_usage, mem_used, mem_total, storage_used, storage_total)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const storageByNode = new Map();
  for (const s of storage) {
    if (!storageByNode.has(s.node)) storageByNode.set(s.node, { used: 0, total: 0, seen: new Set() });
    const acc = storageByNode.get(s.node);
    // Dedup shared storage counted once per name across nodes it's shared on.
    const dedupKey = s.shared ? `shared:${s.storage}` : `${s.node}:${s.storage}`;
    if (acc.seen.has(dedupKey)) continue;
    acc.seen.add(dedupKey);
    acc.used += s.usedBytes || 0;
    acc.total += s.totalBytes || 0;
  }
  for (const n of nodes) {
    const st = storageByNode.get(n.name);
    metricsStmt.run(serverId, n.name, n.cpuUsage, n.memUsed, n.memTotal, st?.used ?? null, st?.total ?? null);
  }

  db.prepare(`
    UPDATE proxmox_servers SET quorate = ?, forbidden_endpoints = ? WHERE id = ?
  `).run(quorate, forbiddenEndpoints.length ? JSON.stringify(forbiddenEndpoints) : null, serverId);
});

async function pollProxmox(server) {
  try {
    const data = await collect(server);
    store(server.id, data);
    db.prepare(`
      UPDATE proxmox_servers SET last_poll_status = 'success', last_poll_error = NULL,
        last_poll_at = datetime('now') WHERE id = ?
    `).run(server.id);
    logger.info(`[ProxmoxPoller] ${server.name}: ${data.nodes.length} node(s), ${data.guests.length} guest(s), ${data.storage.length} storage(s)`);
  } catch (err) {
    db.prepare(`
      UPDATE proxmox_servers SET last_poll_status = 'error', last_poll_error = ?,
        last_poll_at = datetime('now') WHERE id = ?
    `).run(safeMsg(err), server.id);
    throw err;
  } finally {
    try { reconcileIssueHistory(); } catch (err) {
      logger.warn(`[ProxmoxPoller] issue-history reconcile failed: ${err.message}`);
    }
  }
}

const proxmoxPoller = createPoller({
  id: 'proxmox',
  loadSources: () => db.prepare('SELECT * FROM proxmox_servers').all(),
  intervalMinutes: (s) => s.polling_interval_minutes,
  poll: pollProxmox,
});

function initProxmoxPoller() {
  const sources = proxmoxPoller.init();
  logger.info(`[ProxmoxPoller] Initialized ${sources.length} Proxmox server(s)`);
  return proxmoxPoller;
}

module.exports = { initProxmoxPoller, proxmoxPoller, pollProxmox };
