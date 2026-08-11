// NetBackup poller — TWO framework poller instances share this manifest
// entry point: one per registered `netbackup_sources` row (jobs/policies/
// storage/media servers/hosts/alerts/slps + workload + metrics rollups), and
// one per registered `netbackup_appliance_conns` row (52xx/53xx hardware
// health only). Ported from backend/services/netbackupPoller.js — db/logger
// now come from coreApi, and the framework's `createPoller` is
// coreApi.createPoller (backend/core/pollerFramework.js) rather than a direct
// host require, matching plugin-sdk/proxmox/backend/src/poller.js's pattern.
//
// Module-scoped singletons: createRouter() and manifest.createPoller() are
// both called by the host registry against the same coreApi, but createRouter
// runs first (per contract C4) and needs to reach the same poller instances
// for schedule/cancel/trigger on source/connection CRUD. getSourcePoller()/
// getAppliancePoller() lazily build them if not yet created.
const netbackupApi = require('./netbackupApi');
const netbackupApplianceApi = require('./netbackupApplianceApi');
const { reconcileIssueHistory } = require('./issues');

let sourcePollerInstance = null;
let appliancePollerInstance = null;

const safeMsg = (e) => (e?.response ? `HTTP ${e.response.status}` : (e?.message || String(e)));

async function collect(source, coreApi) {
  const [jobs, policies, storageUnits, diskPools, mediaServers, hosts, alerts, slps] = await Promise.all([
    netbackupApi.fetchJobs(source, coreApi, 7),
    netbackupApi.fetchPolicies(source, coreApi),
    netbackupApi.fetchStorageUnits(source, coreApi),
    netbackupApi.fetchDiskPools(source, coreApi),
    netbackupApi.fetchMediaServers(source, coreApi),
    netbackupApi.fetchHosts(source, coreApi),
    netbackupApi.fetchAlerts(source, coreApi),
    netbackupApi.fetchSlps(source, coreApi),
  ]);
  return { jobs, policies, storageUnits, diskPools, mediaServers, hosts, alerts, slps };
}

// Sections below are delete-then-insert per source. `null` from a fetcher means the
// fetch FAILED (see netbackupApi.tolerantList) — the section is skipped entirely so
// prior inventory is left intact. `[]` means the fetch SUCCEEDED and legitimately
// found nothing, so the delete still clears stale rows.
function buildStore(coreApi) {
  const db = coreApi.db;
  return db.transaction((sourceId, { jobs, policies, storageUnits, diskPools, mediaServers, hosts, alerts, slps }) => {
    if (jobs === null) {
      coreApi.logger.warn(`[NbPoller] jobs fetch failed for source ${sourceId}; skipping job upserts this cycle`);
    } else {
      const jobStmt = db.prepare(`
        INSERT INTO netbackup_jobs (source_id, job_id, parent_job_id, job_type, state, status_code,
          policy_name, policy_type, client_name, schedule_type, storage_unit, kilobytes, files_count,
          elapsed_seconds, throughput_kbps, started_at, ended_at, captured_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(source_id, job_id) DO UPDATE SET
          parent_job_id = excluded.parent_job_id, job_type = excluded.job_type, state = excluded.state,
          status_code = excluded.status_code, policy_name = excluded.policy_name, policy_type = excluded.policy_type,
          client_name = excluded.client_name, schedule_type = excluded.schedule_type, storage_unit = excluded.storage_unit,
          kilobytes = excluded.kilobytes, files_count = excluded.files_count, elapsed_seconds = excluded.elapsed_seconds,
          throughput_kbps = excluded.throughput_kbps, started_at = excluded.started_at, ended_at = excluded.ended_at,
          captured_at = datetime('now')
      `);
      for (const j of jobs) {
        if (j.jobId == null) continue;
        jobStmt.run(
          sourceId, j.jobId, j.parentJobId ?? null, j.jobType ?? null, j.state ?? null,
          j.statusCode ?? j.status ?? null, j.policyName ?? null, j.policyType ?? null, j.clientName ?? null,
          j.scheduleType ?? null, j.storageUnitName ?? null, j.kilobytesTransferred ?? null,
          j.filesTransferred ?? null, j.elapsedTime ?? null, j.transferRate ?? null,
          j.startTime ?? null, j.endTime ?? null
        );
      }
    }
    // Time-based retention prune, independent of this cycle's fetch outcome.
    db.prepare("DELETE FROM netbackup_jobs WHERE source_id = ? AND started_at IS NOT NULL AND started_at < datetime('now', '-30 days')").run(sourceId);

    if (policies === null) {
      coreApi.logger.warn(`[NbPoller] policies fetch failed for source ${sourceId}; keeping existing policy inventory`);
    } else {
      db.prepare('DELETE FROM netbackup_policies WHERE source_id = ?').run(sourceId);
      const polStmt = db.prepare(`
        INSERT INTO netbackup_policies (source_id, name, policy_type, active, client_count, schedule_count, selection_count, detail_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const p of policies) {
        polStmt.run(sourceId, p.policyName ?? null, p.policyType ?? null, p.active ? 1 : 0,
          p.clients?.length ?? null, p.schedules?.length ?? null, p.selections?.length ?? null,
          JSON.stringify({ clients: p.clients || [], schedules: p.schedules || [], selections: p.selections || [] }));
      }
    }

    if (storageUnits === null) {
      coreApi.logger.warn(`[NbPoller] storageUnits fetch failed for source ${sourceId}; keeping existing storage unit inventory`);
    } else {
      db.prepare('DELETE FROM netbackup_storage_units WHERE source_id = ?').run(sourceId);
      const suStmt = db.prepare(`
        INSERT INTO netbackup_storage_units (source_id, name, storage_unit_type, disk_pool, media_server,
          max_concurrent_jobs, capacity_bytes, free_bytes, used_bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const u of storageUnits) {
        suStmt.run(sourceId, u.name ?? null, u.storageUnitType ?? null, u.diskPool ?? null, u.mediaServerName ?? null,
          u.maxConcurrentJobs ?? null, u.capacityBytes ?? null, u.freeBytes ?? null, u.usedBytes ?? null);
      }
    }

    if (diskPools === null) {
      coreApi.logger.warn(`[NbPoller] diskPools fetch failed for source ${sourceId}; keeping existing disk pool inventory`);
    } else {
      db.prepare('DELETE FROM netbackup_disk_pools WHERE source_id = ?').run(sourceId);
      const dpStmt = db.prepare(`
        INSERT INTO netbackup_disk_pools (source_id, name, server_type, status,
          total_capacity_bytes, used_capacity_bytes, available_capacity_bytes, volume_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const d of diskPools) {
        dpStmt.run(sourceId, d.name ?? null, d.serverType ?? null, d.status ?? null,
          d.totalCapacityBytes ?? null, d.usedCapacityBytes ?? null, d.availableCapacityBytes ?? null, d.volumeCount ?? null);
      }
    }

    if (mediaServers === null) {
      coreApi.logger.warn(`[NbPoller] mediaServers fetch failed for source ${sourceId}; keeping existing media server inventory`);
    } else {
      db.prepare('DELETE FROM netbackup_media_servers WHERE source_id = ?').run(sourceId);
      const msStmt = db.prepare('INSERT INTO netbackup_media_servers (source_id, name, state, version) VALUES (?, ?, ?, ?)');
      for (const m of mediaServers) msStmt.run(sourceId, m.name ?? null, m.state ?? null, m.version ?? null);
    }

    if (hosts === null) {
      coreApi.logger.warn(`[NbPoller] hosts fetch failed for source ${sourceId}; keeping existing appliance inventory`);
    } else {
      db.prepare('DELETE FROM netbackup_appliances WHERE source_id = ?').run(sourceId);
      const applStmt = db.prepare(`
        INSERT INTO netbackup_appliances (source_id, name, host_type, appliance_type, model, serial_number,
          os_type, os_version, cpu_architecture, nbu_version, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const h of hosts) {
        applStmt.run(sourceId, h.name ?? null, h.hostType ?? null, h.applianceType ?? 'byo', h.model ?? null,
          h.serialNumber ?? null, h.osType ?? null, h.osVersion ?? null, h.cpuArchitecture ?? null, h.nbuVersion ?? null,
          h.raw ? JSON.stringify(h.raw) : null);
      }
    }

    if (alerts === null) {
      coreApi.logger.warn(`[NbPoller] alerts fetch failed for source ${sourceId}; keeping existing alert inventory`);
    } else {
      db.prepare('DELETE FROM netbackup_alerts WHERE source_id = ?').run(sourceId);
      const alStmt = db.prepare(`
        INSERT INTO netbackup_alerts (source_id, alert_id, severity, category, message, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, alert_id) DO UPDATE SET
          severity = excluded.severity, category = excluded.category, message = excluded.message,
          occurred_at = excluded.occurred_at, captured_at = datetime('now')
      `);
      for (const a of alerts) {
        if (!a.alertId) continue;
        alStmt.run(sourceId, a.alertId, a.severity ?? null, a.category ?? null, a.message ?? null, a.occurredAt ?? null);
      }
    }

    if (slps === null) {
      coreApi.logger.warn(`[NbPoller] slps fetch failed for source ${sourceId}; keeping existing SLP inventory`);
    } else {
      db.prepare('DELETE FROM netbackup_slps WHERE source_id = ?').run(sourceId);
      const slpStmt = db.prepare(`
        INSERT INTO netbackup_slps (source_id, name, version, data_classification, priority, operation_count, operations_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const s of slps) {
        slpStmt.run(sourceId, s.name, s.version ?? null, s.dataClassification ?? null, s.priority ?? null,
          s.operations?.length ?? 0, JSON.stringify(s.operations ?? []));
      }
    }

    // Metrics/workload rollups below use best-available data (empty when a fetch failed);
    // they append/prune history rows rather than replacing a scope's inventory.
    jobs = jobs || [];
    policies = policies || [];
    storageUnits = storageUnits || [];
    mediaServers = mediaServers || [];
    hosts = hosts || [];

    const workloadJobs = db.prepare(`
      SELECT COALESCE(policy_type, 'Other') AS workload, client_name, state, status_code, kilobytes
      FROM netbackup_jobs WHERE source_id = ? AND started_at >= datetime('now', '-1 day')
    `).all(sourceId);
    const byWorkload = new Map();
    for (const j of workloadJobs) {
      if (!byWorkload.has(j.workload)) {
        byWorkload.set(j.workload, { clients: new Set(), jobCount: 0, success: 0, failed: 0, bytes: 0 });
      }
      const w = byWorkload.get(j.workload);
      if (j.client_name) w.clients.add(j.client_name);
      w.jobCount += 1;
      const failed = j.state === 'FAILED' || (['EXITED', 'DONE'].includes(j.state) && Number(j.status_code || 0) > 0);
      if (failed) w.failed += 1; else w.success += 1;
      w.bytes += (j.kilobytes || 0) * 1024;
    }
    db.prepare("DELETE FROM netbackup_workload_history WHERE source_id = ? AND date(captured_at) = date('now')").run(sourceId);
    const whStmt = db.prepare(`
      INSERT INTO netbackup_workload_history
        (source_id, workload, protected_clients, job_count, success_count, failed_count, protected_bytes, captured_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    for (const [workload, w] of byWorkload) {
      whStmt.run(sourceId, workload, w.clients.size, w.jobCount, w.success, w.failed, w.bytes);
    }
    db.prepare("DELETE FROM netbackup_workload_history WHERE captured_at < datetime('now', '-400 days')").run();

    const jobs24h = jobs.filter((j) => j.startTime && (Date.now() - new Date(j.startTime).getTime()) < 86400000);
    const failed24h = jobs24h.filter(netbackupApi.isFailedState);
    const successRate = jobs24h.length ? ((jobs24h.length - failed24h.length) / jobs24h.length) * 100 : null;
    const activePolicies = policies.filter((p) => p.active).length;
    const protectedClients = new Set(jobs.map((j) => j.clientName).filter(Boolean)).size;
    const storageCapacity = storageUnits.reduce((n, u) => n + (u.capacityBytes || 0), 0);
    const storageUsed = storageUnits.reduce((n, u) => n + (u.usedBytes || 0), 0);

    db.prepare(`
      INSERT INTO netbackup_metrics_history (source_id, jobs_24h, failed_jobs_24h, success_rate, active_policies,
        protected_clients, storage_capacity_bytes, storage_used_bytes, media_server_count, appliance_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sourceId, jobs24h.length, failed24h.length, successRate, activePolicies, protectedClients,
      storageCapacity, storageUsed, mediaServers.length, hosts.length);
    db.prepare("DELETE FROM netbackup_metrics_history WHERE captured_at < datetime('now', '-365 days')").run();
  });
}

async function pollSource(source, coreApi) {
  const db = coreApi.db;
  const store = buildStore(coreApi);
  try {
    const data = await collect(source, coreApi);
    store(source.id, data);
    db.prepare(`
      UPDATE netbackup_sources SET last_poll_status = 'success', last_poll_error = NULL,
        last_poll_at = datetime('now') WHERE id = ?
    `).run(source.id);
    coreApi.logger.info(`[NbPoller] ${source.name}: ${(data.jobs || []).length} job(s), ${(data.policies || []).length} policy(ies), ${(data.hosts || []).length} host(s)`);
  } catch (err) {
    db.prepare(`
      UPDATE netbackup_sources SET last_poll_status = 'error', last_poll_error = ?,
        last_poll_at = datetime('now') WHERE id = ?
    `).run(safeMsg(err), source.id);
    throw err;
  } finally {
    try { reconcileIssueHistory(coreApi); } catch (err) {
      coreApi.logger.warn(`[NbPoller] issue-history reconcile failed: ${err.message}`);
    }
  }
}

function buildSourcePoller(coreApi) {
  return coreApi.createPoller({
    id: 'netbackup',
    loadSources: () => coreApi.db.prepare('SELECT * FROM netbackup_sources').all(),
    intervalMinutes: (s) => s.polling_interval_minutes,
    poll: (source) => pollSource(source, coreApi),
  });
}

/** Shared singleton source poller (schedule/cancel/trigger/init/stopAll). */
function getSourcePoller(coreApi) {
  if (!sourcePollerInstance) sourcePollerInstance = buildSourcePoller(coreApi);
  return sourcePollerInstance;
}

// Caller (pollApplianceConn) must never pass null here — a failed fetch is skipped
// before this is called so existing hardware inventory is never wiped by a fetch error.
function buildStoreApplianceHw(coreApi) {
  const db = coreApi.db;
  return db.transaction((connId, components) => {
    db.prepare('DELETE FROM netbackup_appliance_hw WHERE conn_id = ?').run(connId);
    const stmt = db.prepare(`
      INSERT INTO netbackup_appliance_hw (conn_id, component_type, component_name, status, state_raw, detail_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const c of components) {
      stmt.run(connId, c.componentType, c.componentName ?? null, c.status ?? 'unknown',
        c.stateRaw ?? null, c.detail ? JSON.stringify(c.detail) : null);
    }
  });
}

async function pollApplianceConn(conn, coreApi) {
  const db = coreApi.db;
  try {
    const components = await netbackupApplianceApi.fetchHardware(conn, coreApi);
    if (components === null) {
      // Fetch failed on every candidate path: skip the store so existing hardware
      // inventory isn't wiped, but still surface the failure on the connection.
      coreApi.logger.warn(`[NbAppliancePoller] hardware fetch failed for ${conn.name}; keeping existing inventory`);
      db.prepare(`
        UPDATE netbackup_appliance_conns SET last_poll_status = 'error',
          last_poll_error = 'Hardware fetch failed for all candidate paths', last_poll_at = datetime('now') WHERE id = ?
      `).run(conn.id);
      return;
    }
    buildStoreApplianceHw(coreApi)(conn.id, components);
    db.prepare(`
      UPDATE netbackup_appliance_conns SET last_poll_status = 'success', last_poll_error = NULL,
        last_poll_at = datetime('now') WHERE id = ?
    `).run(conn.id);
    coreApi.logger.info(`[NbAppliancePoller] ${conn.name}: ${components.length} hardware component(s)`);
  } catch (err) {
    db.prepare(`
      UPDATE netbackup_appliance_conns SET last_poll_status = 'error', last_poll_error = ?,
        last_poll_at = datetime('now') WHERE id = ?
    `).run(safeMsg(err), conn.id);
    throw err;
  } finally {
    try { reconcileIssueHistory(coreApi); } catch (err) {
      coreApi.logger.warn(`[NbAppliancePoller] issue-history reconcile failed: ${err.message}`);
    }
  }
}

function buildAppliancePoller(coreApi) {
  return coreApi.createPoller({
    id: 'netbackup-appliance',
    loadSources: () => coreApi.db.prepare('SELECT * FROM netbackup_appliance_conns').all(),
    intervalMinutes: (row) => row.polling_interval_minutes,
    poll: (conn) => pollApplianceConn(conn, coreApi),
  });
}

/** Shared singleton appliance poller (schedule/cancel/trigger/init/stopAll). */
function getAppliancePoller(coreApi) {
  if (!appliancePollerInstance) appliancePollerInstance = buildAppliancePoller(coreApi);
  return appliancePollerInstance;
}

/**
 * Manifest createPoller(coreApi) entry point. The registry only calls one
 * poller.init()/.stopAll() per plugin, so this wraps BOTH poller instances
 * (source + appliance) behind the single handle the manifest returns —
 * mirroring the built-in's backend/platforms/netbackup/index.js composition.
 * On a demo instance ONLY, this regenerates the fixture estate first (the
 * generator moved here from backend/demo/generators/netbackup.js when the
 * platform became a plugin), so demo timestamps stay relative to boot. Real
 * instances never seed.
 */
function createNetbackupPoller(coreApi) {
  if (process.env.DASHBOARD_DEMO === '1') {
    try {
      const { seedNetbackupDemo } = require('./demoSeed');
      const r = seedNetbackupDemo(coreApi);
      coreApi.logger.info(`[NbPoller] demo estate seeded: ${r.sources} sources, ${r.policies} policies, ${r.jobs} jobs`);
    } catch (err) {
      coreApi.logger.warn(`[NbPoller] demo seed failed: ${err.message}`);
    }
  }
  const sourcePoller = getSourcePoller(coreApi);
  const appliancePoller = getAppliancePoller(coreApi);
  return {
    ...sourcePoller,
    init: () => {
      const sources = sourcePoller.init();
      appliancePoller.init();
      return sources;
    },
    stopAll: () => {
      sourcePoller.stopAll();
      appliancePoller.stopAll();
    },
    trigger: (source) => sourcePoller.trigger(source),
  };
}

module.exports = {
  getSourcePoller, getAppliancePoller, createNetbackupPoller,
  pollSource, pollApplianceConn,
};
