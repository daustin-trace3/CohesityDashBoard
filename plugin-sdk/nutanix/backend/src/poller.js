// Nutanix poller — two composed framework pollers: one per nutanix_sources
// row (Prism Central / Prism Element), one per nutanix_move_conns row. Every
// inventory section is fetched independently; a failed section SKIPS its
// DELETE+INSERT so a transient API error never wipes previously good rows.
//
// Ported from backend/services/nutanixPoller.js. db/logger/createPoller now
// come from coreApi; the framework's `createPoller` is coreApi.createPoller.
//
// Module-scoped singletons: createRouter() and manifest.createPoller() are
// both called by the host registry against the same coreApi, but createRouter
// runs first and needs to reach the same poller instances for
// schedule/cancel/trigger on source/conn CRUD. getPoller()/getMovePoller()
// lazily build them if not yet created, and createNutanixPoller() (the
// manifest.createPoller entry point) reuses them if router.js got there first.
const api = require('./api');
const moveApi = require('./moveApi');
const { reconcileIssueHistory } = require('./issues');

let pollerInstance = null;
let movePollerInstance = null;

const safeMsg = (e) => (e?.response ? `HTTP ${e.response.status}` : (e?.message || String(e)));

// Runs `fn()`; on failure logs+returns undefined ("keep existing rows")
// instead of throwing, unless `required` is set (then rethrows).
async function trySection(coreApi, label, fn, { required = false } = {}) {
  try {
    return await fn();
  } catch (err) {
    coreApi.logger.warn(`[NutanixPoller] ${label} failed: ${safeMsg(err)}`);
    if (required) throw err;
    return undefined;
  }
}

// ── Collect: Prism Element ──────────────────────────────────────────────────

async function collectPE(source, coreApi) {
  const cluster = await trySection(coreApi, 'PE cluster', () => api.fetchPECluster(source, coreApi), { required: true });
  const unprotected = await trySection(coreApi, 'PE unprotected VM count', () => api.fetchPEUnprotectedVmCount(source, coreApi));
  if (cluster && unprotected != null) cluster.unprotectedVmCount = unprotected;

  const hosts = await trySection(coreApi, 'PE hosts', () => api.fetchPEHosts(source, coreApi));
  const vms = await trySection(coreApi, 'PE vms', () => api.fetchPEVms(source, coreApi));
  if (vms) {
    const vmStats = await trySection(coreApi, 'PE vm stats', () => api.fetchPEVmStats(source, coreApi)) || new Map();
    const hostByUuid = new Map((hosts || []).map((h) => [h.uuid, h.name]));
    for (const v of vms) {
      v.hostName = hostByUuid.get(v.hostUuid) || null;
      const s = vmStats.get(v.uuid);
      if (s) Object.assign(v, s);
      v.clusterUuid = cluster?.uuid || null;
      v.clusterName = cluster?.name || null;
    }
  }
  if (hosts) for (const h of hosts) h.clusterUuid = cluster?.uuid || null;

  const containers = await trySection(coreApi, 'PE containers', () => api.fetchPEContainers(source, coreApi));
  if (containers) for (const c of containers) { c.clusterUuid = cluster?.uuid || null; c.clusterName = cluster?.name || null; }

  const disks = await trySection(coreApi, 'PE disks', () => api.fetchPEDisks(source, coreApi));
  if (disks) for (const d of disks) d.clusterUuid = cluster?.uuid || null;

  const alerts = await trySection(coreApi, 'PE alerts', () => api.fetchPEAlerts(source, coreApi));
  if (alerts) for (const a of alerts) { a.clusterUuid = cluster?.uuid || null; a.clusterName = cluster?.name || null; }

  const pds = await trySection(coreApi, 'PE protection domains', () => api.fetchPEPds(source, coreApi));
  const replications = await trySection(coreApi, 'PE replications', () => api.fetchPEReplications(source, coreApi));
  const remoteSites = await trySection(coreApi, 'PE remote sites', () => api.fetchPERemoteSites(source, coreApi));
  const snapshots = await trySection(coreApi, 'PE snapshots', () => api.fetchPESnapshots(source, coreApi));

  return {
    clusters: cluster ? [cluster] : undefined,
    hosts, vms, containers, disks, alerts,
    pds, replications, remoteSites,
    policies: [], // PE has no policy concept (classic PD/DR only)
    recoveryPoints: snapshots,
  };
}

// ── Collect: Prism Central ──────────────────────────────────────────────────

async function collectPC(source, coreApi) {
  const clusters = await trySection(coreApi, 'PC clusters', () => api.fetchPCClusters(source, coreApi), { required: true });

  const hosts = await trySection(coreApi, 'PC hosts', () => api.fetchPCHosts(source, coreApi));
  const vms = await trySection(coreApi, 'PC vms', () => api.fetchPCVms(source, coreApi));
  if (vms) {
    const vmStats = await trySection(coreApi, 'PC vm groups stats', () => api.fetchGroupsVmStats(source, coreApi)) || new Map();
    for (const v of vms) {
      const s = vmStats.get(v.uuid);
      if (s) Object.assign(v, s);
    }
  }

  const alerts = await trySection(coreApi, 'PC alerts', () => api.fetchPCAlerts(source, coreApi));
  const policies = await trySection(coreApi, 'PC protection policies', () => api.fetchPCPolicies(source, coreApi));
  const recoveryPoints = await trySection(coreApi, 'PC recovery points', () => api.fetchPCRecoveryPoints(source, coreApi));

  return {
    clusters, hosts, vms,
    containers: undefined, // no first-class v3 container endpoint — CE/PE-only for now
    disks: undefined,
    alerts, pds: undefined, replications: undefined, remoteSites: undefined,
    policies, recoveryPoints,
  };
}

// ── Store ────────────────────────────────────────────────────────────────────

function buildStore(coreApi) {
  const db = coreApi.db;
  return db.transaction((sourceId, data) => {
    if (data.clusters) {
      db.prepare('DELETE FROM nutanix_clusters WHERE source_id = ?').run(sourceId);
      const stmt = db.prepare(`
        INSERT INTO nutanix_clusters (source_id, uuid, name, aos_version, hypervisor_types, num_nodes,
          redundancy_factor, operation_mode, external_ip, storage_capacity_bytes, storage_usage_bytes,
          reduction_ratio_ppm, overall_reduction_ratio_ppm, cpu_usage_ppm, memory_usage_ppm,
          controller_iops, controller_latency_usecs, io_bandwidth_kbps, runway_days,
          ft_failures_tolerable, ft_details, ncc_pass, ncc_warn, ncc_fail, unprotected_vm_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const c of data.clusters) {
        if (!c || !c.uuid) continue;
        stmt.run(sourceId, c.uuid, c.name, c.aosVersion, c.hypervisorTypes, c.numNodes,
          c.redundancyFactor, c.operationMode, c.externalIp, c.storageCapacityBytes, c.storageUsageBytes,
          c.reductionRatioPpm, c.overallReductionRatioPpm, c.cpuUsagePpm, c.memoryUsagePpm,
          c.controllerIops, c.controllerLatencyUsecs, c.ioBandwidthKbps, c.runwayDays,
          c.ftFailuresTolerable, c.ftDetails, c.nccPass, c.nccWarn, c.nccFail, c.unprotectedVmCount);
      }
      // Metrics history: one append row per cluster this poll.
      const clusterRows = db.prepare('SELECT id, uuid FROM nutanix_clusters WHERE source_id = ?').all(sourceId);
      const idByUuid = new Map(clusterRows.map((r) => [r.uuid, r.id]));
      const histStmt = db.prepare(`
        INSERT INTO nutanix_metrics_history (cluster_id, storage_capacity_bytes, storage_usage_bytes,
          cpu_usage_ppm, memory_usage_ppm, controller_iops, controller_latency_usecs, replication_tx_kbps)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const c of data.clusters) {
        const clusterId = c && idByUuid.get(c.uuid);
        if (!clusterId) continue;
        histStmt.run(clusterId, c.storageCapacityBytes, c.storageUsageBytes, c.cpuUsagePpm, c.memoryUsagePpm,
          c.controllerIops, c.controllerLatencyUsecs, null);
      }
      db.prepare("DELETE FROM nutanix_metrics_history WHERE captured_at < datetime('now', '-90 days')").run();
    }

    if (data.hosts) {
      db.prepare('DELETE FROM nutanix_hosts WHERE source_id = ?').run(sourceId);
      const stmt = db.prepare(`
        INSERT INTO nutanix_hosts (source_id, cluster_uuid, uuid, name, serial, block_model, block_serial,
          position, cpu_model, num_cpu_sockets, num_cpu_cores, cpu_capacity_hz, memory_capacity_bytes,
          hypervisor_type, hypervisor_version, hypervisor_ip, cvm_ip, ipmi_ip, bios_version, bmc_version,
          num_vms, state, maintenance_mode, is_degraded, boot_time_usecs, cpu_usage_ppm, memory_usage_ppm, disks_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const h of data.hosts) {
        stmt.run(sourceId, h.clusterUuid ?? null, h.uuid, h.name, h.serial, h.blockModel, h.blockSerial,
          h.position, h.cpuModel, h.numCpuSockets, h.numCpuCores, h.cpuCapacityHz, h.memoryCapacityBytes,
          h.hypervisorType, h.hypervisorVersion, h.hypervisorIp, h.cvmIp, h.ipmiIp, h.biosVersion, h.bmcVersion,
          h.numVms, h.state, h.maintenanceMode ?? 0, h.isDegraded ?? 0, h.bootTimeUsecs, h.cpuUsagePpm, h.memoryUsagePpm, h.disksJson);
      }
    }

    if (data.vms) {
      db.prepare('DELETE FROM nutanix_vms WHERE source_id = ?').run(sourceId);
      const stmt = db.prepare(`
        INSERT INTO nutanix_vms (source_id, cluster_uuid, cluster_name, uuid, name, power_state, num_vcpus,
          memory_mb, host_uuid, host_name, ip_addresses, ngt_status, guest_os, disk_count, disk_bytes,
          categories, cpu_usage_ppm, memory_usage_ppm, controller_iops, latency_usecs)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const v of data.vms) {
        stmt.run(sourceId, v.clusterUuid ?? null, v.clusterName ?? null, v.uuid, v.name, v.powerState,
          v.numVcpus, v.memoryMb, v.hostUuid, v.hostName, v.ipAddresses, v.ngtStatus, v.guestOs,
          v.diskCount, v.diskBytes, v.categories, v.cpuUsagePpm ?? null, v.memoryUsagePpm ?? null,
          v.controllerIops ?? null, v.latencyUsecs ?? null);
      }
    }

    if (data.containers) {
      db.prepare('DELETE FROM nutanix_containers WHERE source_id = ?').run(sourceId);
      const stmt = db.prepare(`
        INSERT INTO nutanix_containers (source_id, cluster_uuid, cluster_name, uuid, name, replication_factor,
          compression_enabled, dedup_enabled, erasure_code, capacity_bytes, usage_bytes, free_bytes, reduction_ratio_ppm)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const c of data.containers) {
        stmt.run(sourceId, c.clusterUuid ?? null, c.clusterName ?? null, c.uuid, c.name, c.replicationFactor,
          c.compressionEnabled, c.dedupEnabled, c.erasureCode, c.capacityBytes, c.usageBytes, c.freeBytes, c.reductionRatioPpm);
      }
    }

    if (data.disks) {
      db.prepare('DELETE FROM nutanix_disks WHERE source_id = ?').run(sourceId);
      const stmt = db.prepare(`
        INSERT INTO nutanix_disks (source_id, cluster_uuid, disk_uuid, serial, model, vendor, tier, size_bytes,
          usage_bytes, online, status, bad, host_name, firmware)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const d of data.disks) {
        stmt.run(sourceId, d.clusterUuid ?? null, d.diskUuid, d.serial, d.model, d.vendor, d.tier, d.sizeBytes,
          d.usageBytes, d.online, d.status, d.bad, d.hostName, d.firmware);
      }
    }

    if (data.alerts) {
      db.prepare('DELETE FROM nutanix_alerts WHERE source_id = ?').run(sourceId);
      const stmt = db.prepare(`
        INSERT INTO nutanix_alerts (source_id, cluster_uuid, cluster_name, alert_uuid, severity, title, message,
          entity_type, entity_name, acknowledged, resolved, created_usecs, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const a of data.alerts) {
        stmt.run(sourceId, a.clusterUuid ?? null, a.clusterName ?? null, a.alertUuid, a.severity, a.title, a.message,
          a.entityType, a.entityName, a.acknowledged, a.resolved, a.createdUsecs, api.usecsToIso(a.createdUsecs));
      }
    }

    if (data.pds) {
      db.prepare('DELETE FROM nutanix_pds WHERE source_id = ?').run(sourceId);
      const stmt = db.prepare(`
        INSERT INTO nutanix_pds (source_id, name, active, vm_count, remote_sites, next_snapshot_usecs,
          pending_replications, ongoing_replications, tx_bandwidth_kbps, exclusive_snapshot_bytes, schedules_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const pd of data.pds) {
        stmt.run(sourceId, pd.name, pd.active, pd.vmCount, pd.remoteSites, pd.nextSnapshotUsecs,
          pd.pendingReplications, pd.ongoingReplications, pd.txBandwidthKbps, pd.exclusiveSnapshotBytes, pd.schedulesJson);
      }
    }

    if (data.replications) {
      db.prepare('DELETE FROM nutanix_replications WHERE source_id = ?').run(sourceId);
      const stmt = db.prepare(`
        INSERT INTO nutanix_replications (source_id, replication_id, pd_name, remote_site, snapshot_id,
          completed_percentage, completed_bytes, eta_secs, start_usecs, paused)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of data.replications) {
        stmt.run(sourceId, r.replicationId, r.pdName, r.remoteSite, r.snapshotId, r.completedPercentage,
          r.completedBytes, r.etaSecs, r.startUsecs, r.paused);
      }
    }

    if (data.remoteSites) {
      db.prepare('DELETE FROM nutanix_remote_sites WHERE source_id = ?').run(sourceId);
      const stmt = db.prepare(`
        INSERT INTO nutanix_remote_sites (source_id, name, status, latency_usecs, capabilities, tx_bandwidth_kbps)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const rs of data.remoteSites) {
        stmt.run(sourceId, rs.name, rs.status, rs.latencyUsecs, rs.capabilities, rs.txBandwidthKbps);
      }
    }

    if (data.policies) {
      db.prepare('DELETE FROM nutanix_protection_policies WHERE source_id = ?').run(sourceId);
      const stmt = db.prepare(`
        INSERT INTO nutanix_protection_policies (source_id, uuid, name, rpo_secs, remote_targets_json, categories_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const p of data.policies) {
        stmt.run(sourceId, p.uuid, p.name, p.rpoSecs, p.remoteTargetsJson, p.categoriesJson);
      }
    }

    if (data.recoveryPoints) {
      db.prepare('DELETE FROM nutanix_recovery_points WHERE source_id = ?').run(sourceId);
      const stmt = db.prepare(`
        INSERT INTO nutanix_recovery_points (source_id, kind, pd_name, vm_uuid, vm_name, created_at_ts,
          expires_at_ts, location, size_bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const rp of data.recoveryPoints) {
        stmt.run(sourceId, rp.kind, rp.pdName, rp.vmUuid, rp.vmName, rp.createdAtTs, rp.expiresAtTs, rp.location, rp.sizeBytes);
      }
    }
  });
}

function buildStoreEvents(coreApi) {
  const db = coreApi.db;
  return db.transaction((sourceId, events) => {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO nutanix_events (source_id, cluster_uuid, message, entity_type, entity_name, created_usecs, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    for (const e of events) {
      inserted += stmt.run(sourceId, e.clusterUuid ?? null, e.message, e.entityType, e.entityName,
        e.createdUsecs, api.usecsToIso(e.createdUsecs)).changes;
    }
    db.prepare("DELETE FROM nutanix_events WHERE created_at < datetime('now', '-30 days')").run();
    return inserted;
  });
}

async function collectEvents(source, coreApi) {
  try {
    const events = source.source_type === 'prism_central'
      ? await api.fetchPCEvents(source, coreApi)
      : await api.fetchPEEvents(source, coreApi, null);
    const storeEvents = buildStoreEvents(coreApi);
    const inserted = storeEvents(source.id, events || []);
    if (inserted) coreApi.logger.debug(`[NutanixPoller] ${source.name}: ${inserted} new event(s)`);
  } catch (err) {
    coreApi.logger.debug(`[NutanixPoller] event fetch failed for ${source.name}: ${safeMsg(err)}`);
  }
}

async function pollSource(source, coreApi) {
  const db = coreApi.db;
  const store = buildStore(coreApi);
  try {
    const data = source.source_type === 'prism_central' ? await collectPC(source, coreApi) : await collectPE(source, coreApi);
    store(source.id, data);
    db.prepare(`
      UPDATE nutanix_sources SET last_poll_status = 'success', last_poll_error = NULL,
        last_poll_at = datetime('now'), api_flavor = ?, product_version = ? WHERE id = ?
    `).run(
      source.source_type === 'prism_central' ? 'v3' : 'v2.0',
      data.clusters?.[0]?.aosVersion || null,
      source.id
    );
    await collectEvents(source, coreApi);
    coreApi.logger.info(`[NutanixPoller] ${source.name}: ${(data.clusters || []).length} cluster(s), ${(data.hosts || []).length} host(s), ${(data.vms || []).length} VM(s)`);
  } catch (err) {
    db.prepare(`
      UPDATE nutanix_sources SET last_poll_status = 'error', last_poll_error = ?,
        last_poll_at = datetime('now') WHERE id = ?
    `).run(safeMsg(err), source.id);
    throw err;
  } finally {
    try { reconcileIssueHistory(coreApi); } catch (err) {
      coreApi.logger.warn(`[NutanixPoller] issue-history reconcile failed: ${err.message}`);
    }
  }
}

async function pollMoveConn(conn, coreApi) {
  const db = coreApi.db;
  try {
    const [info, plans] = await Promise.all([moveApi.fetchAppInfo(conn, coreApi), moveApi.fetchPlans(conn, coreApi)]);
    const workloadLists = await Promise.all(plans.map((p) => moveApi.fetchWorkloads(conn, coreApi, p)));
    const events = await moveApi.fetchEvents(conn, coreApi).catch((err) => {
      coreApi.logger.debug(`[NutanixPoller] Move events fetch failed for ${conn.name}: ${safeMsg(err)}`);
      return [];
    });

    db.transaction(() => {
      db.prepare('DELETE FROM nutanix_move_plans WHERE conn_id = ?').run(conn.id);
      const planStmt = db.prepare(`
        INSERT INTO nutanix_move_plans (conn_id, plan_uuid, name, state, migration_status, progress,
          source_provider, target_provider, vm_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const p of plans) {
        planStmt.run(conn.id, p.planUuid, p.name, p.state, p.migrationStatus, p.progress, p.sourceProvider, p.targetProvider, p.vmCount);
      }

      db.prepare('DELETE FROM nutanix_move_workloads WHERE conn_id = ?').run(conn.id);
      const wlStmt = db.prepare(`
        INSERT INTO nutanix_move_workloads (conn_id, plan_uuid, plan_name, vm_uuid, vm_name, state_code, state_label, progress)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const list of workloadLists) {
        for (const w of list) wlStmt.run(conn.id, w.planUuid, w.planName, w.vmUuid, w.vmName, w.stateCode, w.stateLabel, w.progress);
      }

      const evStmt = db.prepare(`
        INSERT INTO nutanix_move_events (conn_id, event_id, event_name, vm_name, plan_name, status, failure_notes, created_usecs, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      db.prepare('DELETE FROM nutanix_move_events WHERE conn_id = ?').run(conn.id);
      for (const e of events) {
        evStmt.run(conn.id, e.eventId, e.eventName, e.vmName, e.planName, e.status, e.failureNotes, e.createdUsecs, api.usecsToIso(e.createdUsecs));
      }
    })();

    db.prepare(`
      UPDATE nutanix_move_conns SET last_poll_status = 'success', last_poll_error = NULL,
        last_poll_at = datetime('now'), appliance_version = ? WHERE id = ?
    `).run(info.version || null, conn.id);
  } catch (err) {
    db.prepare(`
      UPDATE nutanix_move_conns SET last_poll_status = 'error', last_poll_error = ?,
        last_poll_at = datetime('now') WHERE id = ?
    `).run(safeMsg(err), conn.id);
    throw err;
  } finally {
    try { reconcileIssueHistory(coreApi); } catch (err) {
      coreApi.logger.warn(`[NutanixPoller] issue-history reconcile (move) failed: ${err.message}`);
    }
  }
}

function buildPoller(coreApi) {
  return coreApi.createPoller({
    id: 'nutanix',
    loadSources: () => coreApi.db.prepare('SELECT * FROM nutanix_sources').all(),
    intervalMinutes: (s) => s.polling_interval_minutes,
    poll: (source) => pollSource(source, coreApi),
  });
}

function buildMovePoller(coreApi) {
  return coreApi.createPoller({
    id: 'nutanix-move',
    loadSources: () => coreApi.db.prepare('SELECT * FROM nutanix_move_conns').all(),
    poll: (conn) => pollMoveConn(conn, coreApi),
  });
}

/** Shared singleton source poller (schedule/cancel/trigger/init/stopAll),
 *  built lazily on first access regardless of whether createRouter or
 *  manifest.createPoller reaches it first. */
function getPoller(coreApi) {
  if (!pollerInstance) pollerInstance = buildPoller(coreApi);
  return pollerInstance;
}

/** Shared singleton Move-connection poller — same lazy-singleton reasoning. */
function getMovePoller(coreApi) {
  if (!movePollerInstance) movePollerInstance = buildMovePoller(coreApi);
  return movePollerInstance;
}

/** Manifest createPoller(coreApi) entry point. On a demo instance ONLY, this
 *  regenerates the fixture estate first (demoSeed.js), so demo timestamps
 *  stay relative to boot. Real instances never seed. Returns a combined
 *  handle mirroring the built-in's createNutanixPollerHandle() shape. */
function createNutanixPoller(coreApi) {
  if (process.env.DASHBOARD_DEMO === '1') {
    try {
      const { seedNutanixDemo } = require('./demoSeed');
      const r = seedNutanixDemo(coreApi);
      coreApi.logger.info(`[NutanixPoller] demo estate seeded: ${r.sources} sources, ${r.clusters} clusters, ${r.vms} VMs`);
    } catch (err) {
      coreApi.logger.warn(`[NutanixPoller] demo seed failed: ${err.message}`);
    }
  }

  const nutanixPoller = getPoller(coreApi);
  const nutanixMovePoller = getMovePoller(coreApi);

  return {
    init: () => {
      const sources = nutanixPoller.init();
      const moveConns = nutanixMovePoller.init();
      coreApi.logger.info(`[NutanixPoller] Initialized ${sources.length} source(s), ${moveConns.length} Move connection(s)`);
      return { sources, moveConns };
    },
    stopAll: () => { nutanixPoller.stopAll(); nutanixMovePoller.stopAll(); },
    trigger: (sourceOrId) => {
      const source = typeof sourceOrId === 'object' ? sourceOrId : coreApi.db.prepare('SELECT * FROM nutanix_sources WHERE id = ?').get(sourceOrId);
      return source ? nutanixPoller.trigger(source) : Promise.resolve();
    },
    triggerMove: (connOrId) => {
      const conn = typeof connOrId === 'object' ? connOrId : coreApi.db.prepare('SELECT * FROM nutanix_move_conns WHERE id = ?').get(connOrId);
      return conn ? nutanixMovePoller.trigger(conn) : Promise.resolve();
    },
    schedule: (source) => nutanixPoller.schedule(source),
    scheduleMove: (conn) => nutanixMovePoller.schedule(conn),
    cancel: (sourceId) => nutanixPoller.cancel(sourceId),
    cancelMove: (connId) => nutanixMovePoller.cancel(connId),
    taskCount: () => nutanixPoller.taskCount() + nutanixMovePoller.taskCount(),
  };
}

module.exports = { createNutanixPoller, getPoller, getMovePoller, pollSource, pollMoveConn };
