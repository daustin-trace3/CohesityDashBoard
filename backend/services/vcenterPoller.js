// vCenter poller — one scheduled task per registered vCenter (framework
// per-source model, like Pure). Each poll pulls clusters, hosts (with
// per-cluster membership and per-host VM counts), datastores and the vCenter
// TLS cert via REST, enriches hosts with maintenance mode + CPU/memory
// quickstats via SOAP (best-effort), replaces the inventory tables for that
// vCenter and appends a metrics snapshot.
const db = require('../db/database');
const cron = require('node-cron');
const pollerStatus = require('./pollerStatus');
const {
  fetchClusters, fetchHosts, fetchDatastores, fetchVmsForHost, fetchTlsCert,
  fetchInventorySoap,
} = require('./vcenterApi');
const logger = require('../utils/logger');

const safeMsg = (e) => e?.response ? `HTTP ${e.response.status}` : (e?.message || String(e));

async function collect(vc) {
  const clusters = await fetchClusters(vc);

  // Host list per cluster gives us cluster membership; a final unfiltered list
  // catches standalone hosts outside any cluster.
  const hostRows = new Map(); // host_id -> row
  for (const c of clusters) {
    for (const h of await fetchHosts(vc, c.cluster)) {
      hostRows.set(h.host, { ...h, clusterName: c.name, clusterId: c.cluster });
    }
  }
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
    for (const row of hostRows.values()) {
      try {
        const hostVms = await fetchVmsForHost(vc, row.host);
        row.vmCount = hostVms.length;
        vms = vms.concat(hostVms.map(v => ({
          vmId: v.vm, name: v.name, hostName: row.name,
          powerState: v.power_state ?? null, guestOs: null,
          cpuCount: v.cpu_count ?? null, memoryMb: v.memory_size_MiB ?? null,
          ipAddress: null, toolsStatus: null, hwVersion: null,
        })));
      } catch (err) {
        logger.debug(`[VcPoller] VM list failed for host ${row.name}: ${safeMsg(err)}`);
        row.vmCount = null;
      }
    }
  }

  for (const row of hostRows.values()) {
    const r = soap?.hostsByName.get(row.name);
    row.inMaintenance = r ? r.inMaintenance : null;
    row.cpuMhzCapacity = r?.cpuMhzCapacity ?? null;
    row.cpuMhzUsed = r?.cpuMhzUsed ?? null;
    row.memBytesCapacity = r?.memBytesCapacity ?? null;
    row.memBytesUsed = r?.memBytesUsed ?? null;
    row.esxVersion = r?.esxVersion ?? null;
    row.esxBuild = r?.esxBuild ?? null;
    row.biosVersion = r?.biosVersion ?? null;
    row.biosReleaseDate = r?.biosReleaseDate ?? null;
    row.vendor = r?.vendor ?? null;
    row.model = r?.model ?? null;
  }

  const datastores = await fetchDatastores(vc);

  let cert = null;
  try {
    cert = await fetchTlsCert(vc);
  } catch (err) {
    logger.debug(`[VcPoller] TLS cert fetch failed for ${vc.name} (needs cert-management privilege): ${safeMsg(err)}`);
  }

  return { clusters, hosts: [...hostRows.values()], datastores, cert, vms, about: soap?.about || null };
}

const store = db.transaction((vcId, { clusters, hosts, datastores, cert, vms, about }) => {
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
      bios_release_date, vendor, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const h of hosts) {
    hostStmt.run(vcId, h.host, h.name || null, h.clusterName, h.connection_state || null,
      h.power_state || null, h.inMaintenance, h.vmCount, h.cpuMhzCapacity, h.cpuMhzUsed,
      h.memBytesCapacity, h.memBytesUsed, h.esxVersion, h.esxBuild, h.biosVersion,
      h.biosReleaseDate, h.vendor, h.model);
  }

  db.prepare('DELETE FROM vcenter_vms WHERE vcenter_id = ?').run(vcId);
  const vmStmt = db.prepare(`
    INSERT INTO vcenter_vms (vcenter_id, vm_id, name, host_name, cluster_name, power_state,
      guest_os, cpu_count, memory_mb, ip_address, tools_status, hw_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const clusterByHost = new Map(hosts.map(h => [h.name, h.clusterName]));
  for (const v of (vms || [])) {
    vmStmt.run(vcId, v.vmId || null, v.name || null, v.hostName,
      clusterByHost.get(v.hostName) ?? null, v.powerState,
      v.guestOs, v.cpuCount, v.memoryMb, v.ipAddress, v.toolsStatus, v.hwVersion);
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
  db.prepare("DELETE FROM vcenter_metrics_history WHERE captured_at < datetime('now', '-365 days')").run();
});

async function pollVcenter(vc) {
  try {
    const data = await collect(vc);
    store(vc.id, data);
    db.prepare(`
      UPDATE vcenter_vcenters SET last_poll_status = 'success', last_poll_error = NULL,
        last_poll_at = datetime('now') WHERE id = ?
    `).run(vc.id);
    logger.info(`[VcPoller] ${vc.name}: ${data.hosts.length} host(s), ${data.clusters.length} cluster(s), ${data.datastores.length} datastore(s), ${(data.vms || []).length} VM(s)`);
  } catch (err) {
    db.prepare(`
      UPDATE vcenter_vcenters SET last_poll_status = 'error', last_poll_error = ?,
        last_poll_at = datetime('now') WHERE id = ?
    `).run(safeMsg(err), vc.id);
    throw err;
  }
}

// Per-vCenter scheduling, purePoller-style (this branch has no
// core/pollerFramework). Same surface as the icc-phase1 framework handle:
// schedule / cancel / trigger.
const scheduledTasks = new Map();

async function pollWrapped(vc) {
  pollerStatus.markStart('vcenter', vc.id);
  try {
    await pollVcenter(vc);
    pollerStatus.markEnd('vcenter', vc.id, 'success');
  } catch (err) {
    logger.error(`[VcPoller] Poll failed for ${vc.name}:`, err?.message || err);
    pollerStatus.markEnd('vcenter', vc.id, 'error');
  }
}

const vcenterPoller = {
  schedule(vc) {
    this.cancel(vc.id);
    const interval = Math.max(5, Number(vc.polling_interval_minutes) || 15);
    const task = cron.schedule(`*/${interval} * * * *`, () => { pollWrapped(vc); });
    scheduledTasks.set(vc.id, task);
  },
  cancel(vcId) {
    const task = scheduledTasks.get(vcId);
    if (task) { task.stop(); scheduledTasks.delete(vcId); }
  },
  trigger: (vc) => pollWrapped(vc),
};

function initVcenterPoller() {
  const sources = db.prepare('SELECT * FROM vcenter_vcenters').all();
  for (const vc of sources) vcenterPoller.schedule(vc);
  logger.info(`[VcPoller] Initialized ${sources.length} vCenter(s)`);
  return vcenterPoller;
}

module.exports = { initVcenterPoller, vcenterPoller, pollVcenter };
