// vCenter poller — one scheduled task per registered vCenter (framework
// per-source model, like Pure). Each poll pulls clusters, hosts (with
// per-cluster membership and per-host VM counts), datastores and the vCenter
// TLS cert via REST, enriches hosts with maintenance mode + CPU/memory
// quickstats via SOAP (best-effort), replaces the inventory tables for that
// vCenter and appends a metrics snapshot.
const { pruneInBatches } = require('../core/dbPrune');
const db = require('../db/database');
const { createPoller } = require('../core/pollerFramework');
const { mapLimit, valuesOrThrow, callsInFlight } = require('../core/concurrency');
const {
  fetchClusters, fetchHosts, fetchDatastores, fetchVmsForHost, fetchTlsCert,
  fetchInventorySoap, fetchEvents, fetchVmTags,
} = require('./vcenterApi');
const { reconcileIssueHistory } = require('./vcenterIssues');
const { writeCapacitySample, ensureDefaultSites, retentionDays } = require('./vcenterCapacity');
const logger = require('../utils/logger');

const safeMsg = (e) => e?.response ? `HTTP ${e.response.status}` : (e?.message || String(e));

async function collect(vc) {
  const clusters = await fetchClusters(vc);

  // Host list per cluster gives us cluster membership; a final unfiltered list
  // catches standalone hosts outside any cluster.
  const hostRows = new Map(); // host_id -> row
  const perCluster = valuesOrThrow(await mapLimit(clusters, callsInFlight('vcenter'), (c) => fetchHosts(vc, c.cluster)));
  clusters.forEach((c, i) => {
    for (const h of perCluster[i]) hostRows.set(h.host, { ...h, clusterName: c.name, clusterId: c.cluster });
  });
  for (const h of await fetchHosts(vc)) {
    if (!hostRows.has(h.host)) hostRows.set(h.host, { ...h, clusterName: null, clusterId: null });
  }

  // SOAP inventory sweep: vCenter about, host runtime/version/BIOS, VM guests.
  // When it works it also supplies VM counts, so the per-host REST /vm calls
  // are only the fallback path.
  let soap = null;
  try {
    soap = await fetchInventorySoap(vc);
  } catch (err) {
    logger.warn(`[VcPoller] SOAP inventory failed for ${vc.name} (maintenance/usage/BIOS/VM-guest detail unavailable): ${safeMsg(err)}`);
  }

  let vms = soap ? soap.vms : [];
  if (soap) {
    const vmCountByHost = new Map();
    for (const v of soap.vms) {
      if (v.hostName) vmCountByHost.set(v.hostName, (vmCountByHost.get(v.hostName) || 0) + 1);
    }
    for (const row of hostRows.values()) row.vmCount = vmCountByHost.get(row.name) ?? 0;
  } else {
    // REST fallback: per-host VM lists (basic fields only).
    const fetched = await mapLimit([...hostRows.values()], callsInFlight('vcenter'), async (row) => {
      try {
        return await fetchVmsForHost(vc, row.host);
      } catch (err) {
        logger.debug(`[VcPoller] VM list failed for host ${row.name}: ${safeMsg(err)}`);
        return null;
      }
    });
    [...hostRows.values()].forEach((row, i) => {
      const hostVms = fetched[i].value;
      if (hostVms == null) { row.vmCount = null; return; }
      row.vmCount = hostVms.length;
      vms = vms.concat(hostVms.map(v => ({
        vmId: v.vm, name: v.name, hostName: row.name,
        powerState: v.power_state ?? null, guestOs: null,
        cpuCount: v.cpu_count ?? null, memoryMb: v.memory_size_MiB ?? null,
        ipAddress: null, toolsStatus: null, hwVersion: null,
      })));
    });
  }

  for (const row of hostRows.values()) {
    const r = soap?.hostsByName.get(row.name);
    row.inMaintenance = r ? r.inMaintenance : null;
    row.cpuMhzCapacity = r?.cpuMhzCapacity ?? null;
    row.cpuCores = r?.cpuCores ?? null;
    row.cpuMhzUsed = r?.cpuMhzUsed ?? null;
    row.memBytesCapacity = r?.memBytesCapacity ?? null;
    row.memBytesUsed = r?.memBytesUsed ?? null;
    row.uptimeSeconds = r?.uptimeSeconds ?? null;
    row.esxVersion = r?.esxVersion ?? null;
    row.esxBuild = r?.esxBuild ?? null;
    row.biosVersion = r?.biosVersion ?? null;
    row.biosReleaseDate = r?.biosReleaseDate ?? null;
    row.vendor = r?.vendor ?? null;
    row.model = r?.model ?? null;
    row.ntpServers = r?.ntpServers ?? null;
    row.dnsServers = r?.dnsServers ?? null;
    row.sshEnabled = r?.sshEnabled ?? null;
    row.serial = r?.serial ?? null;
    row.serviceTag = r?.serviceTag ?? null;
    row.uuid = r?.uuid ?? null;
  }

  // vSphere Tags (REST batch) — best-effort; works with or without SOAP since
  // both paths populate vmId.
  if (vms.length) {
    try {
      const tagMap = await fetchVmTags(vc, vms.map(v => v.vmId).filter(Boolean));
      for (const v of vms) v.tags = tagMap.get(v.vmId) || [];
    } catch (err) {
      logger.debug(`[VcPoller] tag fetch failed for ${vc.name}: ${safeMsg(err)}`);
    }
  }

  const datastores = await fetchDatastores(vc);

  let cert = null;
  try {
    cert = await fetchTlsCert(vc);
  } catch (err) {
    logger.debug(`[VcPoller] TLS cert fetch failed for ${vc.name} (needs cert-management privilege): ${safeMsg(err)}`);
  }

  return {
    clusters, hosts: [...hostRows.values()], datastores, cert, vms,
    about: soap?.about || null,
    networks: soap?.networks || null,
    orphans: soap?.orphans ?? null, // null = sweep unavailable, [] = swept clean
    nicNeighbors: soap?.nicNeighbors ?? null, // null = hint pass unavailable
    nicNeighborHosts: soap?.nicNeighborHosts ?? null,
  };
}

const store = db.transaction((vcId, { clusters, hosts, datastores, cert, vms, about, networks, orphans, nicNeighbors, nicNeighborHosts }) => {
  if (about) {
    db.prepare(`
      UPDATE vcenter_vcenters SET version = ?, build = ?, product_name = ? WHERE id = ?
    `).run(about.version || null, about.build || null, about.fullName || null, vcId);
  }

  db.prepare('DELETE FROM vcenter_hosts WHERE vcenter_id = ?').run(vcId);
  const hostStmt = db.prepare(`
    INSERT INTO vcenter_hosts (vcenter_id, host_id, name, cluster_name, connection_state,
      power_state, in_maintenance, vm_count, cpu_mhz_capacity, cpu_mhz_used,
      mem_bytes_capacity, mem_bytes_used, esx_version, esx_build, bios_version,
      bios_release_date, vendor, model, cpu_cores, ntp_servers, dns_servers,
      ssh_enabled, uptime_seconds, serial, service_tag, uuid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const h of hosts) {
    hostStmt.run(vcId, h.host, h.name || null, h.clusterName, h.connection_state || null,
      h.power_state || null, h.inMaintenance, h.vmCount, h.cpuMhzCapacity, h.cpuMhzUsed,
      h.memBytesCapacity, h.memBytesUsed, h.esxVersion, h.esxBuild, h.biosVersion,
      h.biosReleaseDate, h.vendor, h.model, h.cpuCores,
      h.ntpServers ? JSON.stringify(h.ntpServers) : null,
      h.dnsServers ? JSON.stringify(h.dnsServers) : null,
      h.sshEnabled, h.uptimeSeconds, h.serial ?? null, h.serviceTag ?? null, h.uuid ?? null);
  }

  db.prepare('DELETE FROM vcenter_vms WHERE vcenter_id = ?').run(vcId);
  const vmStmt = db.prepare(`
    INSERT INTO vcenter_vms (vcenter_id, vm_id, name, host_name, cluster_name, power_state,
      guest_os, cpu_count, memory_mb, ip_address, tools_status, hw_version,
      tools_version, tools_version_status, networks, datastores, tags, guest_nics,
      uptime_seconds, storage_committed_bytes, annotation,
      cpu_usage_mhz, mem_usage_mb, overall_status, guest_hostname, created_at_src,
      guest_id, guest_os_running, guest_family, guest_detailed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const clusterByHost = new Map(hosts.map(h => [h.name, h.clusterName]));
  for (const v of (vms || [])) {
    vmStmt.run(vcId, v.vmId || null, v.name || null, v.hostName,
      clusterByHost.get(v.hostName) ?? null, v.powerState,
      v.guestOs, v.cpuCount, v.memoryMb, v.ipAddress, v.toolsStatus, v.hwVersion,
      v.toolsVersion ?? null, v.toolsVersionStatus ?? null,
      v.networks?.length ? JSON.stringify(v.networks) : null,
      v.datastores?.length ? JSON.stringify(v.datastores) : null,
      v.tags?.length ? JSON.stringify(v.tags) : null,
      v.guestNics?.length ? JSON.stringify(v.guestNics) : null,
      v.uptimeSeconds ?? null, v.storageCommittedBytes ?? null, v.annotation ?? null,
      v.cpuUsageMhz ?? null, v.memUsageMb ?? null, v.overallStatus ?? null, v.guestHostname ?? null,
      v.createdAt ?? null,
      v.guestId ?? null, v.guestOsRunning ?? null, v.guestFamily ?? null, v.guestDetailed ?? null);
  }

  // Guest storage rows are replaced only when the storage retrieval worked
  // (null lists mean it did not); a VM with Tools stopped simply has no
  // filesystem rows, which the page reports as "no guest data".
  if ((vms || []).some(v => v.guestDisks != null || v.virtualDisks != null)) {
    db.prepare('DELETE FROM vcenter_vm_disks WHERE vcenter_id = ?').run(vcId);
    db.prepare('DELETE FROM vcenter_vm_filesystems WHERE vcenter_id = ?').run(vcId);
    const diskStmt = db.prepare(`
      INSERT INTO vcenter_vm_disks (vcenter_id, vm_id, vm_name, disk_key, label, capacity_bytes, used_bytes, thin, datastore, file_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const fsStmt = db.prepare(`
      INSERT INTO vcenter_vm_filesystems (vcenter_id, vm_id, vm_name, mount, fs_type, capacity_bytes, free_bytes, used_pct)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const histStmt = db.prepare(`
      INSERT INTO vcenter_vm_filesystem_history (vcenter_id, vm_id, mount, day, capacity_bytes, free_bytes)
      VALUES (?, ?, ?, date('now'), ?, ?)
      ON CONFLICT(vcenter_id, vm_id, mount, day) DO UPDATE SET
        capacity_bytes = excluded.capacity_bytes, free_bytes = excluded.free_bytes
    `);
    for (const v of vms) {
      if (!v.vmId) continue;
      for (const d of (v.virtualDisks || [])) {
        diskStmt.run(vcId, v.vmId, v.name || null, d.key ?? null, d.label ?? null,
          d.capacityBytes ?? null, d.usedBytes ?? null, d.thin ?? null, d.datastore ?? null, d.fileName ?? null);
      }
      for (const g of (v.guestDisks || [])) {
        const usedPct = g.capacityBytes > 0 && g.freeBytes != null
          ? Math.round((1 - g.freeBytes / g.capacityBytes) * 1000) / 10 : null;
        fsStmt.run(vcId, v.vmId, v.name || null, g.mount, g.fsType ?? null,
          g.capacityBytes ?? null, g.freeBytes ?? null, usedPct);
        if (g.capacityBytes != null) histStmt.run(vcId, v.vmId, g.mount, g.capacityBytes, g.freeBytes ?? null);
      }
    }
    // Two years of daily rows is plenty for growth; older ones go.
  }

  // Networking rows are wholesale-replaced only when SOAP produced them —
  // a SOAP outage keeps the last good inventory instead of blanking the page.
  if (networks) {
    db.prepare('DELETE FROM vcenter_networks WHERE vcenter_id = ?').run(vcId);
    const netStmt = db.prepare(`
      INSERT INTO vcenter_networks (vcenter_id, host_name, kind, name, switch_name,
        vlan_id, speed_mbps, mac, ip_address, netmask, mtu, uplinks, port_count, extra)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const n of networks) {
      netStmt.run(vcId, n.hostName ?? null, n.kind, n.name ?? null, n.switchName ?? null,
        n.vlanId ?? null, n.speedMbps ?? null, n.mac ?? null, n.ipAddress ?? null,
        n.netmask ?? null, n.mtu ?? null,
        n.uplinks ? JSON.stringify(n.uplinks) : null, n.portCount ?? null,
        n.extra ? JSON.stringify(n.extra) : null);
    }
  }

  // NIC neighbour hints: null = the hint pass did not run, keep what is stored.
  // Otherwise the hosts the pass covered are replaced (a covered host with no
  // hints loses its rows) and rows for hosts gone from the inventory are
  // dropped; hosts skipped by the 200-host round-robin cap or a per-host fault
  // keep their last rows. When every host is covered this is the plain
  // per-vCenter DELETE then INSERT.
  if (Array.isArray(nicNeighbors)) {
    const covered = new Set(Array.isArray(nicNeighborHosts) ? nicNeighborHosts : nicNeighbors.map(n => n.hostName));
    const delHost = db.prepare('DELETE FROM vcenter_host_nic_neighbors WHERE vcenter_id = ? AND host_name = ?');
    for (const name of covered) delHost.run(vcId, name);
    db.prepare(`
      DELETE FROM vcenter_host_nic_neighbors WHERE vcenter_id = ?
        AND host_name NOT IN (SELECT name FROM vcenter_hosts WHERE vcenter_id = ? AND name IS NOT NULL)
    `).run(vcId, vcId);
    const nbStmt = db.prepare(`
      INSERT OR REPLACE INTO vcenter_host_nic_neighbors (vcenter_id, host_name, nic, mac, protocol,
        switch_name, switch_port, switch_address, switch_platform, vlan, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const n of nicNeighbors) {
      if (!n.hostName || !n.nic || !n.protocol) continue;
      nbStmt.run(vcId, n.hostName, n.nic, n.mac ?? null, n.protocol,
        n.switchName ?? null, n.switchPort ?? null, n.switchAddress ?? null,
        n.switchPlatform ?? null, n.vlan ?? null, n.raw ? JSON.stringify(n.raw) : null);
    }
  }

  // orphans === null means the sweep couldn't run (privilege/SOAP) — keep the
  // previous results; an empty array is a real "no orphans" and clears them.
  if (orphans) {
    db.prepare('DELETE FROM vcenter_orphaned_vmdks WHERE vcenter_id = ?').run(vcId);
    const orphanStmt = db.prepare(`
      INSERT INTO vcenter_orphaned_vmdks (vcenter_id, datastore_name, path, size_bytes, modified_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const o of orphans) {
      orphanStmt.run(vcId, o.datastoreName ?? null, o.path, o.sizeBytes ?? null, o.modifiedAt ?? null);
    }
  }

  db.prepare('DELETE FROM vcenter_clusters WHERE vcenter_id = ?').run(vcId);
  const clusterStmt = db.prepare(`
    INSERT INTO vcenter_clusters (vcenter_id, cluster_id, name, drs_enabled, ha_enabled,
      host_count, vm_count, cpu_mhz_capacity, cpu_mhz_used, mem_bytes_capacity, mem_bytes_used)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const c of clusters) {
    const members = hosts.filter(h => h.clusterId === c.cluster);
    const sum = (k) => members.some(h => h[k] != null) ? members.reduce((n, h) => n + (h[k] || 0), 0) : null;
    clusterStmt.run(vcId, c.cluster, c.name || null,
      c.drs_enabled ? 1 : 0, c.ha_enabled ? 1 : 0,
      members.length,
      members.some(h => h.vmCount != null) ? members.reduce((n, h) => n + (h.vmCount || 0), 0) : null,
      sum('cpuMhzCapacity'), sum('cpuMhzUsed'), sum('memBytesCapacity'), sum('memBytesUsed'));
  }

  db.prepare('DELETE FROM vcenter_datastores WHERE vcenter_id = ?').run(vcId);
  const dsStmt = db.prepare(`
    INSERT INTO vcenter_datastores (vcenter_id, datastore_id, name, ds_type, capacity_bytes, free_bytes, accessible)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const d of datastores) {
    dsStmt.run(vcId, d.datastore, d.name || null, d.type || null,
      d.capacity ?? null, d.free_space ?? null, 1);
  }

  db.prepare('DELETE FROM vcenter_certs WHERE vcenter_id = ?').run(vcId);
  if (cert) {
    db.prepare(`
      INSERT INTO vcenter_certs (vcenter_id, cert_type, subject, issuer, valid_from, valid_to)
      VALUES (?, 'vcenter-tls', ?, ?, ?, ?)
    `).run(vcId, cert.subject_dn || null, cert.issuer_dn || null,
      cert.valid_from || null, cert.valid_to || null);
  }

  db.prepare(`
    INSERT INTO vcenter_metrics_history (vcenter_id, hosts_total, hosts_connected,
      hosts_maintenance, vms_total, datastore_capacity_bytes, datastore_free_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(vcId, hosts.length,
    hosts.filter(h => h.connection_state === 'CONNECTED').length,
    hosts.filter(h => h.inMaintenance === 1).length,
    hosts.some(h => h.vmCount != null) ? hosts.reduce((n, h) => n + (h.vmCount || 0), 0) : null,
    datastores.reduce((n, d) => n + (d.capacity || 0), 0),
    datastores.reduce((n, d) => n + (d.free_space || 0), 0));
});

// Native vSphere events, appended incrementally: query from the newest stored
// event (small overlap; the unique (vcenter_id, event_key) index dedupes) or
// 48h back on the first pull. Best-effort — an events failure never fails the poll.
const storeEvents = db.transaction((vcId, events) => {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO vcenter_events (vcenter_id, event_key, event_type, severity, message, username, entity_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let inserted = 0;
  for (const e of events) {
    inserted += stmt.run(vcId, e.eventKey, e.eventType, e.severity, e.message, e.username, e.entityName, e.createdAt).changes;
  }
  return inserted;
});

async function collectEvents(vc) {
  try {
    const latest = db.prepare('SELECT MAX(created_at) AS t FROM vcenter_events WHERE vcenter_id = ?').get(vc.id).t;
    const since = latest
      ? new Date(new Date(latest).getTime() - 5 * 60000).toISOString()
      : new Date(Date.now() - 48 * 3600000).toISOString();
    const inserted = storeEvents(vc.id, await fetchEvents(vc, since));
    pruneInBatches(db, 'vcenter_events', "created_at < datetime('now', ?)", [`-${retentionDays().eventRetentionDays} days`]);
    if (inserted) logger.debug(`[VcPoller] ${vc.name}: ${inserted} new event(s)`);
  } catch (err) {
    logger.debug(`[VcPoller] event fetch failed for ${vc.name}: ${safeMsg(err)}`);
  }
}

async function pollVcenter(vc) {
  try {
    const data = await collect(vc);
    store(vc.id, data);
    pruneInBatches(db, 'vcenter_vm_filesystem_history', "vcenter_id = ? AND day < date('now', '-730 days')", [vc.id]);
    pruneInBatches(db, 'vcenter_metrics_history', "captured_at < datetime('now', '-365 days')");
    db.prepare(`
      UPDATE vcenter_vcenters SET last_poll_status = 'success', last_poll_error = NULL,
        last_poll_at = datetime('now') WHERE id = ?
    `).run(vc.id);
    await collectEvents(vc);
    try {
      writeCapacitySample(vc.id);
      const auto = ensureDefaultSites();
      if (auto.created) logger.info(`[VcPoller] created ${auto.created} default site(s) — one per cluster`);
    } catch (err) {
      logger.warn(`[VcPoller] capacity sample failed for ${vc.name}: ${err.message}`);
    }
    logger.info(`[VcPoller] ${vc.name}: ${data.hosts.length} host(s), ${data.clusters.length} cluster(s), ${data.datastores.length} datastore(s), ${(data.vms || []).length} VM(s)`);
  } catch (err) {
    db.prepare(`
      UPDATE vcenter_vcenters SET last_poll_status = 'error', last_poll_error = ?,
        last_poll_at = datetime('now') WHERE id = ?
    `).run(safeMsg(err), vc.id);
    throw err;
  } finally {
    // Runs on success AND failure so "vCenter unreachable" opens/resolves in
    // the issue timeline as soon as the poll outcome is recorded.
    try { reconcileIssueHistory(); } catch (err) {
      logger.warn(`[VcPoller] issue-history reconcile failed: ${err.message}`);
    }
  }
}

const vcenterPoller = createPoller({
  id: 'vcenter',
  loadSources: () => db.prepare('SELECT * FROM vcenter_vcenters').all(),
  intervalMinutes: (vc) => vc.polling_interval_minutes,
  poll: pollVcenter,
});

function initVcenterPoller() {
  const sources = vcenterPoller.init();
  logger.info(`[VcPoller] Initialized ${sources.length} vCenter(s)`);
  return vcenterPoller;
}

module.exports = { initVcenterPoller, vcenterPoller, pollVcenter, store };
