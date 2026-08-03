// Proxmox VE poller — one scheduled task per registered server (framework
// per-source model, like vCenter/AWS). Each poll walks version -> nodes ->
// per-node (status, qemu, lxc, storage, tasks, certificates, subscription,
// apt, services, network, disks/list) -> per-guest (config, snapshots, agent
// osinfo/interfaces when running) -> per-storage content -> cluster/resources,
// cluster/backup, cluster/status, cluster/log, replaces the inventory tables
// for that server and appends one metrics row per node. rrddata is NOT
// polled/stored — routes proxy it live from upstream.
const db = require('../db/database');
const { createPoller } = require('../core/pollerFramework');
const proxmoxApi = require('./proxmoxApi');
const { reconcileIssueHistory } = require('./proxmoxIssues');
const logger = require('../utils/logger');

const safeMsg = (e) => (e?.response ? `HTTP ${e.response.status}` : (e?.message || String(e)));

// config.agent may be "1", "0", or "1,fstrim_cloned_disks=1" — truthy iff the
// first csv segment is "1".
const agentEnabled = (config) => {
  const raw = config?.agent;
  if (raw == null) return false;
  return String(raw).split(',')[0].trim() === '1';
};

const STORAGE_CONTENT_TYPES = ['backup', 'iso', 'vztmpl'];

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
  const serviceRows = [];
  const networkRows = [];
  const diskRows = [];
  const storageContentRows = [];
  const snapshotRows = [];

  for (const n of nodes) {
    const nodeName = n.node;
    let status = null;
    try {
      status = await proxmoxApi.pveGet(server, `/nodes/${nodeName}/status`);
    } catch (err) {
      if (err?.pveForbidden) { forbidden.add('nodes/status'); }
    }

    const [qemu, lxc, storage, tasks, certs, subscription, services, network, disks] = await Promise.all([
      proxmoxApi.fetchQemu(server, nodeName),
      proxmoxApi.fetchLxc(server, nodeName),
      proxmoxApi.fetchNodeStorage(server, nodeName),
      proxmoxApi.fetchTasks(server, nodeName, 200),
      proxmoxApi.fetchCertificates(server, nodeName),
      proxmoxApi.fetchSubscription(server, nodeName),
      proxmoxApi.fetchNodeServices(server, nodeName),
      proxmoxApi.fetchNodeNetwork(server, nodeName),
      proxmoxApi.fetchDisksList(server, nodeName),
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

    for (const sv of services) {
      serviceRows.push({
        node: nodeName, name: sv.name, state: sv.state ?? null,
        activeState: sv['active-state'] ?? null, unitState: sv['unit-state'] ?? null,
        description: sv.desc ?? null,
      });
    }

    for (const nw of network) {
      networkRows.push({
        node: nodeName, iface: nw.iface, ifaceType: nw.type ?? null, method: nw.method ?? null,
        cidr: nw.cidr ?? null, vlanId: nw['vlan-id'] ?? null, vlanRawDevice: nw['vlan-raw-device'] ?? null,
        active: nw.active ? 1 : 0, autostart: nw.autostart ? 1 : 0, comments: nw.comments ?? null,
      });
    }

    for (const d of disks) {
      diskRows.push({
        node: nodeName, devpath: d.devpath, model: d.model ?? null, vendor: d.vendor ?? null,
        serial: d.serial ?? null, sizeBytes: d.size ?? null, health: d.health ?? null,
        wearout: d.wearout != null ? String(d.wearout) : null, diskType: d.type ?? null,
        usedAs: d.used ?? null,
      });
    }

    // Storage content (backup/iso/vztmpl only, per storage's own content types).
    for (const s of storage) {
      const types = String(s.content || '').split(',').map((c) => c.trim()).filter((c) => STORAGE_CONTENT_TYPES.includes(c));
      for (const contentType of types) {
        const items = await proxmoxApi.fetchStorageContent(server, nodeName, s.storage, contentType);
        for (const item of items || []) {
          storageContentRows.push({
            node: nodeName, storage: s.storage, volid: item.volid, content: item.content ?? contentType,
            format: item.format ?? null, sizeBytes: item.size ?? null, vmid: item.vmid != null ? Number(item.vmid) : null,
            createdAtSrc: item.ctime != null ? new Date(item.ctime * 1000).toISOString() : null,
            notes: item.notes ?? null,
          });
        }
      }
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

  // Per non-template guest: config, snapshots, and (if agent enabled +
  // running) OS info + IP addresses.
  for (const g of guestRows) {
    if (g.isTemplate || !g.node || g.vmid == null) continue;
    const [config, snaps] = await Promise.all([
      proxmoxApi.fetchGuestConfig(server, g.node, g.type, g.vmid),
      proxmoxApi.fetchGuestSnapshots(server, g.node, g.type, g.vmid),
    ]);

    g.configJson = config || null;
    g.cpuSockets = config?.sockets ?? null;
    g.agentRunning = 0;
    g.osName = null;
    g.ipAddresses = null;

    const realSnaps = (snaps || []).filter((s) => s.name !== 'current');
    g.snapshotCount = realSnaps.length;
    let oldest = null;
    for (const s of realSnaps) {
      if (s.snaptime == null) continue;
      const iso = new Date(s.snaptime * 1000).toISOString();
      snapshotRows.push({
        vmid: g.vmid, guestName: g.name, name: s.name, parent: s.parent ?? null,
        description: s.description ?? null, vmstate: s.vmstate ? 1 : 0, snapTime: iso,
      });
      if (!oldest || iso < oldest) oldest = iso;
    }
    g.oldestSnapshotAt = oldest;

    if (config && agentEnabled(config) && g.type === 'qemu' && g.status === 'running') {
      try {
        const osinfo = await proxmoxApi.fetchAgentOsInfo(server, g.node, g.vmid);
        g.osName = osinfo?.result?.['pretty-name'] ?? null;
        if (osinfo) g.agentRunning = 1;
      } catch { /* tolerate: non-running/no-agent 500s */ }
      try {
        const ifaces = await proxmoxApi.fetchAgentInterfaces(server, g.node, g.vmid);
        if (ifaces?.result) {
          const ips = [];
          for (const iface of ifaces.result) {
            if (/^(lo|loopback)/i.test(iface.name || '')) continue;
            for (const addr of iface['ip-addresses'] || []) {
              if (addr['ip-address-type'] !== 'ipv4') continue;
              if (addr['ip-address'] === '127.0.0.1') continue;
              ips.push(addr['ip-address']);
            }
          }
          g.ipAddresses = ips;
          g.agentRunning = 1;
        }
      } catch { /* tolerate: non-running/no-agent 500s */ }
    }
  }

  // null = fetch failed (skip the store, keep prior rows); [] = confirmed empty
  // (no permission, or genuinely zero backup jobs) and safe to store.
  let backupJobs = null;
  try {
    backupJobs = (await proxmoxApi.pveGet(server, '/cluster/backup')) || [];
  } catch (err) {
    if (err?.pveForbidden) {
      forbidden.add('cluster/backup');
      backupJobs = [];
    } else {
      logger.warn(`[ProxmoxPoller] ${server.name}: cluster/backup fetch failed: ${safeMsg(err)}`);
    }
  }

  let clusterStatus = [];
  try {
    clusterStatus = await proxmoxApi.fetchClusterStatus(server);
  } catch { /* tolerate; quorate stays as-is */ }

  const clusterRow = Array.isArray(clusterStatus) ? clusterStatus.find((r) => r.type === 'cluster') : null;
  const quorate = clusterRow ? (clusterRow.quorate ? 1 : 0) : null;

  const clusterLog = await proxmoxApi.fetchClusterLog(server, 200);
  const eventRows = (clusterLog || []).filter((e) => e.time != null).map((e) => ({
    eventKey: `${e.id || e.uid}:${e.time}`, node: e.node ?? null,
    eventTime: new Date(e.time * 1000).toISOString(), user: e.user ?? null,
    tag: e.tag ?? null, pri: e.pri ?? null, message: e.msg ?? null,
  }));

  return {
    nodes: nodeRows, guests: guestRows, storage: storageRows, tasks: taskRows,
    services: serviceRows, networks: networkRows, disks: diskRows,
    storageContent: storageContentRows, snapshots: snapshotRows, events: eventRows,
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
  const {
    nodes, guests, storage, tasks, backupJobs, quorate, forbiddenEndpoints,
    services, networks, disks, storageContent, snapshots, events,
  } = data;

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
      net_in, net_out, pool, tags, last_backup_at, last_backup_status,
      os_name, ip_addresses, agent_running, config_json, cpu_sockets, snapshot_count, oldest_snapshot_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      g.netIn, g.netOut, g.pool, g.tags ? JSON.stringify(g.tags) : null, lastBackupAt, lastBackupStatus,
      g.osName ?? null, g.ipAddresses ? JSON.stringify(g.ipAddresses) : null, g.agentRunning ?? 0,
      g.configJson ? JSON.stringify(g.configJson) : null, g.cpuSockets ?? null,
      g.snapshotCount ?? 0, g.oldestSnapshotAt ?? null);
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

  db.prepare('DELETE FROM proxmox_services WHERE server_id = ?').run(serverId);
  const serviceStmt = db.prepare(`
    INSERT INTO proxmox_services (server_id, node, name, state, active_state, unit_state, description)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const sv of services) {
    serviceStmt.run(serverId, sv.node, sv.name, sv.state, sv.activeState, sv.unitState, sv.description);
  }

  db.prepare('DELETE FROM proxmox_node_networks WHERE server_id = ?').run(serverId);
  const networkStmt = db.prepare(`
    INSERT INTO proxmox_node_networks (server_id, node, iface, iface_type, method, cidr,
      vlan_id, vlan_raw_device, active, autostart, comments)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const nw of networks) {
    networkStmt.run(serverId, nw.node, nw.iface, nw.ifaceType, nw.method, nw.cidr,
      nw.vlanId, nw.vlanRawDevice, nw.active, nw.autostart, nw.comments);
  }

  db.prepare('DELETE FROM proxmox_disks WHERE server_id = ?').run(serverId);
  const diskStmt = db.prepare(`
    INSERT INTO proxmox_disks (server_id, node, devpath, model, vendor, serial, size_bytes,
      health, wearout, disk_type, used_as)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const d of disks) {
    diskStmt.run(serverId, d.node, d.devpath, d.model, d.vendor, d.serial, d.sizeBytes,
      d.health, d.wearout, d.diskType, d.usedAs);
  }

  db.prepare('DELETE FROM proxmox_storage_content WHERE server_id = ?').run(serverId);
  const contentStmt = db.prepare(`
    INSERT INTO proxmox_storage_content (server_id, node, storage, volid, content, format,
      size_bytes, vmid, created_at_src, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const c of storageContent) {
    contentStmt.run(serverId, c.node, c.storage, c.volid, c.content, c.format,
      c.sizeBytes, c.vmid, c.createdAtSrc, c.notes);
  }

  db.prepare('DELETE FROM proxmox_snapshots WHERE server_id = ?').run(serverId);
  const snapStmt = db.prepare(`
    INSERT INTO proxmox_snapshots (server_id, vmid, guest_name, name, parent, description, vmstate, snap_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const sn of snapshots) {
    snapStmt.run(serverId, sn.vmid, sn.guestName, sn.name, sn.parent, sn.description, sn.vmstate, sn.snapTime);
  }

  const eventStmt = db.prepare(`
    INSERT INTO proxmox_events (server_id, event_key, node, event_time, user, tag, pri, message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(server_id, event_key) DO NOTHING
  `);
  for (const e of events) {
    eventStmt.run(serverId, e.eventKey, e.node, e.eventTime, e.user, e.tag, e.pri, e.message);
  }
  db.prepare("DELETE FROM proxmox_events WHERE server_id = ? AND event_time < datetime('now', '-14 days')").run(serverId);

  if (backupJobs === null) {
    logger.warn(`[ProxmoxPoller] backup jobs fetch failed for server ${serverId}; keeping existing backup job inventory`);
  } else {
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
