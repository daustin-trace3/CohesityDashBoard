// vCenter poller — one scheduled task per registered vCenter (framework
// per-source model, like Pure). Each poll pulls clusters, hosts (with
// per-cluster membership and per-host VM counts), datastores and the vCenter
// TLS cert via REST, enriches hosts with maintenance mode + CPU/memory
// quickstats via SOAP (best-effort), replaces the inventory tables for that
// vCenter and appends a metrics snapshot.
const db = require('../db/database');
const { createPoller } = require('../core/pollerFramework');
const {
  fetchClusters, fetchHosts, fetchDatastores, fetchVmsForHost, fetchTlsCert,
  fetchHostRuntimeSoap,
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

  // Per-host VM counts (one filtered /vm call per host).
  for (const row of hostRows.values()) {
    try {
      row.vmCount = (await fetchVmsForHost(vc, row.host)).length;
    } catch (err) {
      logger.debug(`[VcPoller] VM count failed for host ${row.name}: ${safeMsg(err)}`);
      row.vmCount = null;
    }
  }

  // SOAP enrichment: maintenance mode + quickstats, joined by host name.
  let runtime = new Map();
  try {
    runtime = await fetchHostRuntimeSoap(vc);
  } catch (err) {
    logger.warn(`[VcPoller] SOAP enrichment failed for ${vc.name} (maintenance/usage columns stay empty): ${safeMsg(err)}`);
  }
  for (const row of hostRows.values()) {
    const r = runtime.get(row.name);
    row.inMaintenance = r ? r.inMaintenance : null;
    row.cpuMhzCapacity = r?.cpuMhzCapacity ?? null;
    row.cpuMhzUsed = r?.cpuMhzUsed ?? null;
    row.memBytesCapacity = r?.memBytesCapacity ?? null;
    row.memBytesUsed = r?.memBytesUsed ?? null;
  }

  const datastores = await fetchDatastores(vc);

  let cert = null;
  try {
    cert = await fetchTlsCert(vc);
  } catch (err) {
    logger.debug(`[VcPoller] TLS cert fetch failed for ${vc.name} (needs cert-management privilege): ${safeMsg(err)}`);
  }

  return { clusters, hosts: [...hostRows.values()], datastores, cert };
}

const store = db.transaction((vcId, { clusters, hosts, datastores, cert }) => {
  db.prepare('DELETE FROM vcenter_hosts WHERE vcenter_id = ?').run(vcId);
  const hostStmt = db.prepare(`
    INSERT INTO vcenter_hosts (vcenter_id, host_id, name, cluster_name, connection_state,
      power_state, in_maintenance, vm_count, cpu_mhz_capacity, cpu_mhz_used,
      mem_bytes_capacity, mem_bytes_used)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const h of hosts) {
    hostStmt.run(vcId, h.host, h.name || null, h.clusterName, h.connection_state || null,
      h.power_state || null, h.inMaintenance, h.vmCount, h.cpuMhzCapacity, h.cpuMhzUsed,
      h.memBytesCapacity, h.memBytesUsed);
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
    logger.info(`[VcPoller] ${vc.name}: ${data.hosts.length} host(s), ${data.clusters.length} cluster(s), ${data.datastores.length} datastore(s)`);
  } catch (err) {
    db.prepare(`
      UPDATE vcenter_vcenters SET last_poll_status = 'error', last_poll_error = ?,
        last_poll_at = datetime('now') WHERE id = ?
    `).run(safeMsg(err), vc.id);
    throw err;
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

module.exports = { initVcenterPoller, vcenterPoller, pollVcenter };
