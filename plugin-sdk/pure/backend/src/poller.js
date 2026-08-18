// Pure Storage poller — combines two independent pollers behind one manifest
// createPoller() entry point, mirroring backend/platforms/pure/index.js's
// combined handle:
//   1. Direct-connect arrays (pure_arrays): one framework poller task per
//      registered array (purePoller.js pattern).
//   2. Pure1 SaaS (account-wide, no per-source rows): a single fixed
//      { id: 0, name: 'account' } source fed through the same per-source
//      framework (zerto plugin-sdk poller.js pattern — coreApi only exposes
//      createPoller, not the built-in's createGlobalTask).
//
// Ported from backend/services/purePoller.js + backend/services/pure1Poller.js.
// db/logger/settings/encryption now come from coreApi rather than direct
// host requires; retention pruning (originally a standalone node-cron job in
// purePoller.js) is folded into the per-array poll pass below instead of a
// second always-on cron (a bundled plugin has no reason to run two crons for
// one concern, and the framework poller already runs on a schedule).
const api = require('./api');
const pure1Api = require('./pure1Api');

const ACCOUNT_SOURCE = { id: 0, name: 'account' };

let pollerInstance = null;
let pure1PollerInstance = null;

function num(v) {
  return v === undefined || v === null ? null : Number(v);
}

// ── Direct-array store helpers (one DB, threaded via coreApi.db) ──────────

function upsertMetrics(db, array, info, performance, volumeCount) {
  const space = (info && info.space) || {};
  const perf = performance || {};
  db.prepare(`
    INSERT INTO pure_metrics_history
      (array_id, captured_at, capacity_bytes, used_bytes, data_reduction, total_reduction,
       shared_bytes, snapshots_bytes, system_bytes, volume_count,
       read_iops, write_iops, read_bw_bytes, write_bw_bytes,
       read_latency_us, write_latency_us, queue_depth, purity_version)
    VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    array.id,
    num(info && info.capacity),
    num(space.total_physical),
    num(space.data_reduction),
    num(space.total_reduction),
    num(space.shared),
    num(space.snapshots),
    num(space.system),
    volumeCount ?? null,
    num(perf.reads_per_sec),
    num(perf.writes_per_sec),
    num(perf.read_bytes_per_sec),
    num(perf.write_bytes_per_sec),
    num(perf.usec_per_read_op),
    num(perf.usec_per_write_op),
    num(perf.queue_depth),
    (info && (info.version || info.os)) || null
  );
}

function upsertAlerts(db, array, alerts) {
  const stmt = db.prepare(`
    INSERT INTO pure_alerts
      (array_id, pure_alert_id, severity, category, component_type, component_name,
       summary, state, flagged, created_at_ms, updated_at_ms, captured_at)
    VALUES (@array_id, @pure_alert_id, @severity, @category, @component_type, @component_name,
            @summary, @state, @flagged, @created_at_ms, @updated_at_ms, datetime('now'))
    ON CONFLICT(array_id, pure_alert_id) DO UPDATE SET
      severity       = excluded.severity,
      category       = excluded.category,
      component_type = excluded.component_type,
      component_name = excluded.component_name,
      summary        = excluded.summary,
      state          = excluded.state,
      flagged        = excluded.flagged,
      updated_at_ms  = excluded.updated_at_ms,
      captured_at    = datetime('now')
  `);
  const seen = [];
  for (const a of alerts) {
    const pureAlertId = String(a.id ?? a.name ?? '');
    if (!pureAlertId) continue;
    seen.push(pureAlertId);
    stmt.run({
      array_id: array.id,
      pure_alert_id: pureAlertId,
      severity: a.severity || null,
      category: a.category || null,
      component_type: a.component_type || null,
      component_name: a.component_name || null,
      summary: a.summary || null,
      state: a.state || null,
      flagged: a.flagged ? 1 : 0,
      created_at_ms: num(a.created),
      updated_at_ms: num(a.updated),
    });
  }
  if (seen.length > 0) {
    const placeholders = seen.map(() => '?').join(',');
    db.prepare(`DELETE FROM pure_alerts WHERE array_id = ? AND pure_alert_id NOT IN (${placeholders})`).run(array.id, ...seen);
  } else {
    db.prepare('DELETE FROM pure_alerts WHERE array_id = ?').run(array.id);
  }
}

function replaceVolumes(db, arrayId, volumes) {
  db.prepare('DELETE FROM pure_volumes WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare(`
    INSERT INTO pure_volumes
      (array_id, name, provisioned_bytes, used_bytes, data_reduction, snapshots_bytes, destroyed)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const v of volumes) {
    const space = v.space || {};
    stmt.run(arrayId, v.name || null, num(v.provisioned), num(space.total_physical ?? space.unique),
      num(space.data_reduction), num(space.snapshots), v.destroyed ? 1 : 0);
  }
}

function replaceHosts(db, arrayId, hosts) {
  db.prepare('DELETE FROM pure_hosts WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare(`
    INSERT INTO pure_hosts (array_id, name, connection_count, personality, protocol)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const h of hosts) {
    let protocol = null;
    if (Array.isArray(h.iqns) && h.iqns.length) protocol = 'iSCSI';
    else if (Array.isArray(h.nqns) && h.nqns.length) protocol = 'NVMe';
    else if (Array.isArray(h.wwns) && h.wwns.length) protocol = 'FC';
    stmt.run(arrayId, h.name || null, num(h.connection_count), h.personality || null, protocol);
  }
}

function safeErrorMessage(err) {
  if (err?.response) return `HTTP ${err.response.status} from array`;
  if (err?.code) return `Network error: ${err.code}`;
  return err?.message || 'Unknown error';
}

function insertVolumeHistory(db, arrayId, volumes, perfByName) {
  const stmt = db.prepare(`
    INSERT INTO pure_volume_history
      (array_id, volume_name, captured_at, provisioned_bytes, used_bytes, data_reduction,
       snapshots_bytes, read_iops, write_iops, read_latency_us, write_latency_us,
       read_bw_bytes, write_bw_bytes)
    VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const v of volumes) {
    if (v.destroyed) continue;
    const space = v.space || {};
    const p = perfByName.get(v.name) || {};
    stmt.run(arrayId, v.name || 'unknown', num(v.provisioned), num(space.total_physical ?? space.unique),
      num(space.data_reduction), num(space.snapshots), num(p.reads_per_sec), num(p.writes_per_sec),
      num(p.usec_per_read_op), num(p.usec_per_write_op), num(p.read_bytes_per_sec), num(p.write_bytes_per_sec));
  }
}

function replaceArrayConnections(db, arrayId, connections) {
  db.prepare('DELETE FROM pure_array_connections WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare(`
    INSERT INTO pure_array_connections
      (array_id, remote_name, status, type, version, transport, mgmt_address, replication_addresses)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const c of connections) {
    stmt.run(arrayId, c.name || null, c.status || null, c.type || null, c.version || null,
      c.replication_transport || null, c.management_address || null,
      Array.isArray(c.replication_addresses) ? c.replication_addresses.join(', ') : null);
  }
}

function replaceProtectionGroups(db, arrayId, groups) {
  db.prepare('DELETE FROM pure_protection_groups WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare(`
    INSERT INTO pure_protection_groups
      (array_id, name, source_name, is_local, volume_count, host_count, target_count,
       snapshot_enabled, snapshot_frequency_ms, replication_enabled, replication_frequency_ms,
       source_retention_days, target_retention_days, snapshots_bytes, destroyed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const g of groups) {
    const snap = g.snapshot_schedule || {};
    const repl = g.replication_schedule || {};
    const srcRet = g.source_retention || {};
    const tgtRet = g.target_retention || {};
    const space = g.space || {};
    stmt.run(arrayId, g.name || 'unknown', (g.source && g.source.name) || null, g.is_local ? 1 : 0,
      num(g.volume_count), num(g.host_count), num(g.target_count), snap.enabled ? 1 : 0, num(snap.frequency),
      repl.enabled ? 1 : 0, num(repl.frequency), num(srcRet.days), num(tgtRet.days), num(space.snapshots),
      g.destroyed ? 1 : 0);
  }
}

function replaceHardware(db, arrayId, items) {
  db.prepare('DELETE FROM pure_hardware WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare(`
    INSERT INTO pure_hardware (array_id, name, type, model, status, serial, slot, speed, temperature, voltage)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const h of items) {
    stmt.run(arrayId, h.name || null, h.type || null, h.model || null, h.status || null, h.serial || null,
      num(h.slot), num(h.speed), num(h.temperature), num(h.voltage));
  }
}

function replaceDrives(db, arrayId, items) {
  db.prepare('DELETE FROM pure_drives WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare('INSERT INTO pure_drives (array_id, name, type, protocol, status, capacity_bytes) VALUES (?, ?, ?, ?, ?, ?)');
  for (const d of items) stmt.run(arrayId, d.name || null, d.type || null, d.protocol || null, d.status || null, num(d.capacity));
}

function replaceControllers(db, arrayId, items) {
  db.prepare('DELETE FROM pure_controllers WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare('INSERT INTO pure_controllers (array_id, name, model, status, mode, version) VALUES (?, ?, ?, ?, ?, ?)');
  for (const c of items) stmt.run(arrayId, c.name || null, c.model || null, c.status || null, c.mode || null, c.version || null);
}

function replaceCertificates(db, arrayId, items) {
  db.prepare('DELETE FROM pure_certificates WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare(`
    INSERT INTO pure_certificates
      (array_id, name, status, common_name, issued_to, issued_by, key_size, valid_from_ms, valid_to_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const c of items) {
    stmt.run(arrayId, c.name || null, c.status || null, c.common_name || null, c.issued_to || null,
      c.issued_by || null, num(c.key_size), num(c.valid_from), num(c.valid_to));
  }
}

function replaceNetworkInterfaces(db, arrayId, items) {
  db.prepare('DELETE FROM pure_network_interfaces WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare(`
    INSERT INTO pure_network_interfaces
      (array_id, name, interface_type, enabled, speed_bps, services, address, netmask, gateway, mac_address, vlan, wwn)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const n of items) {
    const eth = n.eth || {};
    const fc = n.fc || {};
    stmt.run(arrayId, n.name || null, n.interface_type || null, n.enabled ? 1 : 0, num(n.speed),
      Array.isArray(n.services) ? n.services.join(', ') : null,
      eth.address || null, eth.netmask || null, eth.gateway || null, eth.mac_address || null, num(eth.vlan), fc.wwn || null);
  }
}

function replacePorts(db, arrayId, items) {
  db.prepare('DELETE FROM pure_ports WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare('INSERT INTO pure_ports (array_id, name, wwn, iqn, nqn) VALUES (?, ?, ?, ?, ?)');
  for (const p of items) stmt.run(arrayId, p.name || null, p.wwn || null, p.iqn || null, p.nqn || null);
}

function replaceConnections(db, arrayId, items) {
  db.prepare('DELETE FROM pure_connections WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare('INSERT INTO pure_connections (array_id, host_name, host_group_name, volume_name, lun) VALUES (?, ?, ?, ?, ?)');
  for (const c of items) stmt.run(arrayId, c.host?.name || null, c.host_group?.name || null, c.volume?.name || null, num(c.lun));
}

function replacePods(db, arrayId, items) {
  db.prepare('DELETE FROM pure_pods WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare(`
    INSERT INTO pure_pods
      (array_id, name, promotion_status, mediator, array_count, link_source_count, link_target_count,
       member_arrays, total_physical_bytes, data_reduction)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const p of items) {
    const space = p.space || {};
    const members = Array.isArray(p.arrays) ? p.arrays.map((a) => `${a.name}(${a.status || '?'})`).join(', ') : null;
    stmt.run(arrayId, p.name || null, p.promotion_status || null, p.mediator || null,
      num(p.array_count), num(p.link_source_count), num(p.link_target_count),
      members, num(space.total_physical), num(space.data_reduction));
  }
}

/** Poll a single Pure array: capacity, performance, alerts, volumes, hosts,
 *  plus per-volume perf history, replication, protection, and hardware. */
async function doPollArray(array, coreApi) {
  const db = coreApi.db;
  const [
    infoResult, alertResult, volumeResult, hostResult, volPerfResult,
    connResult, pgResult, hwResult, driveResult, ctrlResult, certResult,
    netResult, portResult, connsResult, podResult,
  ] = await Promise.allSettled([
    api.fetchArrayInfo(array, coreApi),
    api.fetchAlerts(array, coreApi),
    api.fetchVolumes(array, coreApi),
    api.fetchHosts(array, coreApi),
    api.fetchVolumesPerformance(array, coreApi),
    api.fetchArrayConnections(array, coreApi),
    api.fetchProtectionGroups(array, coreApi),
    api.fetchHardware(array, coreApi),
    api.fetchDrives(array, coreApi),
    api.fetchControllers(array, coreApi),
    api.fetchCertificates(array, coreApi),
    api.fetchNetworkInterfaces(array, coreApi),
    api.fetchPorts(array, coreApi),
    api.fetchConnections(array, coreApi),
    api.fetchPods(array, coreApi),
  ]);

  let volumeCount = null;
  if (volumeResult.status === 'fulfilled') {
    volumeCount = volumeResult.value.length;
    try { replaceVolumes(db, array.id, volumeResult.value); } catch (err) {
      coreApi.logger.error(`[PurePoller] Volume snapshot failed for array ${array.id}:`, err.message);
    }
  } else {
    coreApi.logger.error(`[PurePoller] Volumes fetch failed for array ${array.id}:`, safeErrorMessage(volumeResult.reason));
  }

  if (infoResult.status === 'fulfilled') {
    try { upsertMetrics(db, array, infoResult.value.info, infoResult.value.performance, volumeCount); } catch (err) {
      coreApi.logger.error(`[PurePoller] Metrics insert failed for array ${array.id}:`, err.message);
    }
  } else {
    coreApi.logger.error(`[PurePoller] Array info fetch failed for array ${array.id}:`, safeErrorMessage(infoResult.reason));
  }

  if (alertResult.status === 'fulfilled') {
    try { upsertAlerts(db, array, alertResult.value); } catch (err) {
      coreApi.logger.error(`[PurePoller] Alert upsert failed for array ${array.id}:`, err.message);
    }
  } else {
    coreApi.logger.error(`[PurePoller] Alerts fetch failed for array ${array.id}:`, safeErrorMessage(alertResult.reason));
  }

  if (hostResult.status === 'fulfilled') {
    try { replaceHosts(db, array.id, hostResult.value); } catch (err) {
      coreApi.logger.error(`[PurePoller] Host snapshot failed for array ${array.id}:`, err.message);
    }
  } else {
    coreApi.logger.error(`[PurePoller] Hosts fetch failed for array ${array.id}:`, safeErrorMessage(hostResult.reason));
  }

  if (volumeResult.status === 'fulfilled') {
    const perfByName = new Map();
    if (volPerfResult.status === 'fulfilled') {
      for (const p of volPerfResult.value) perfByName.set(p.name, p);
    } else {
      coreApi.logger.error(`[PurePoller] Volume perf fetch failed for array ${array.id}:`, safeErrorMessage(volPerfResult.reason));
    }
    try { insertVolumeHistory(db, array.id, volumeResult.value, perfByName); } catch (err) {
      coreApi.logger.error(`[PurePoller] Volume history insert failed for array ${array.id}:`, err.message);
    }
  }

  const currentState = [
    [connResult, replaceArrayConnections, 'array-connections'],
    [pgResult, replaceProtectionGroups, 'protection-groups'],
    [hwResult, replaceHardware, 'hardware'],
    [driveResult, replaceDrives, 'drives'],
    [ctrlResult, replaceControllers, 'controllers'],
    [certResult, replaceCertificates, 'certificates'],
    [netResult, replaceNetworkInterfaces, 'network-interfaces'],
    [portResult, replacePorts, 'ports'],
    [connsResult, replaceConnections, 'connections'],
    [podResult, replacePods, 'pods'],
  ];
  for (const [result, store, label] of currentState) {
    if (result.status === 'fulfilled') {
      try { store(db, array.id, result.value); } catch (err) {
        coreApi.logger.error(`[PurePoller] ${label} store failed for array ${array.id}:`, err.message);
      }
    } else {
      coreApi.logger.error(`[PurePoller] ${label} fetch failed for array ${array.id}:`, safeErrorMessage(result.reason));
    }
  }

  // Retention prune (was a standalone daily node-cron in the built-in;
  // folded into the per-array poll pass here since the framework already
  // runs on its own schedule and one array's poll is enough to keep the
  // history tables trimmed).
  try {
    db.prepare("DELETE FROM pure_metrics_history WHERE captured_at < datetime('now', '-90 days')").run();
    db.prepare("DELETE FROM pure_volume_history WHERE captured_at < datetime('now', '-90 days')").run();
  } catch (err) {
    coreApi.logger.error('[PurePoller] Failed to prune Pure history:', err.message);
  }
}

function buildPoller(coreApi) {
  return coreApi.createPoller({
    id: 'pure',
    loadSources: () => coreApi.db.prepare('SELECT * FROM pure_arrays').all(),
    intervalMinutes: (array) => array.polling_interval_minutes,
    poll: (array) => doPollArray(array, coreApi),
  });
}

/** Shared singleton direct-array poller instance. */
function getPoller(coreApi) {
  if (!pollerInstance) pollerInstance = buildPoller(coreApi);
  return pollerInstance;
}

// ── Pure1 SaaS (global-account, single fixed source) ───────────────────────

const replaceArrays = (db) => db.transaction((rows, enrichment) => {
  db.prepare('DELETE FROM pure1_arrays').run();
  const stmt = db.prepare(`
    INSERT INTO pure1_arrays (pure1_id, name, fqdn, model, os, version,
      capacity_bytes, used_bytes, data_reduction, effective_used_bytes,
      volume_bytes, shared_bytes, snapshots_bytes, provisioned_bytes,
      health, health_detail, chassis_serial, controller_serials, tags, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  for (const r of rows) {
    if (!r.id) continue;
    const en = enrichment[r.id] || null;
    stmt.run(
      r.id, r.name || null, r.fqdn || null, r.model || null, r.os || null, r.version || null,
      r.total || null, r.used || null, r.dataReduction || null, r.effectiveUsed || null,
      r.volumeSpace || null, r.sharedSpace || null, r.snapshotSpace || null,
      en ? en.provisioned || null : null,
      en ? en.health || null : null,
      en ? JSON.stringify({ unhealthy: en.unhealthy }) : null,
      en ? en.chassisSerial || null : null,
      en ? JSON.stringify(en.controllerSerials || []) : null,
      JSON.stringify(r.tags || [])
    );
  }
});

const replaceAlerts1 = (db) => db.transaction((alerts) => {
  db.prepare('DELETE FROM pure1_alerts').run();
  const stmt = db.prepare(`
    INSERT INTO pure1_alerts (pure1_alert_id, array_name, array_fqdn, severity,
      category, component_type, component_name, summary, code, state,
      flagged, created_at_ms, updated_at_ms, knowledge_base_url, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, datetime('now'))
  `);
  for (const a of alerts) {
    if (!a.id) continue;
    stmt.run(a.id, a.arrayName || null, a.arrayFqdn || null, a.severity || null,
      a.category || null, a.componentType || null, a.component || null,
      a.summary || null, a.code ?? null, a.state || null, a.created ?? null, a.updated ?? null, a.knowledgeBaseUrl || null);
  }
});

const replacePods1 = (db) => db.transaction((pods) => {
  db.prepare('DELETE FROM pure1_pods').run();
  const stmt = db.prepare('INSERT INTO pure1_pods (pure1_pod_id, name, mediator, arrays, captured_at) VALUES (?, ?, ?, ?, datetime(\'now\'))');
  for (const p of pods) stmt.run(p.id || null, p.name || null, p.mediator || null, JSON.stringify(p.arrays || []));
});

function appendSnapshot(db, rows, alertCount) {
  const arraysWarn = rows.filter((r) => r._health === 'warn').length;
  const arraysCrit = rows.filter((r) => r._health === 'crit').length;
  db.prepare(`
    INSERT INTO pure1_metrics_history (array_count, arrays_warn, arrays_crit,
      total_capacity_bytes, total_used_bytes, open_alerts)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(rows.length, arraysWarn, arraysCrit,
    rows.reduce((s, r) => s + (r.total || 0), 0),
    rows.reduce((s, r) => s + (r.used || 0), 0),
    alertCount);
  db.prepare("DELETE FROM pure1_metrics_history WHERE captured_at < datetime('now', '-365 days')").run();
}

async function refreshPure1(coreApi) {
  const db = coreApi.db;
  if (!pure1Api.isConfigured(coreApi) || process.env.DASHBOARD_DEMO === '1') {
    coreApi.logger.debug('[Pure1Poller] Skipping poll — not configured or demo mode');
    return;
  }
  const rows = await pure1Api.getOverview(coreApi, { force: true });

  // Last-good capacity: a failed /metrics/history chunk leaves total/used
  // zeroed for its arrays, and replaceArrays() below would wipe the fleet's
  // capacity columns wholesale. Backfill from the previous poll instead.
  const priorCap = new Map(db.prepare(`
    SELECT pure1_id, capacity_bytes, used_bytes, data_reduction,
           effective_used_bytes, volume_bytes, shared_bytes, snapshots_bytes
    FROM pure1_arrays WHERE capacity_bytes IS NOT NULL
  `).all().map((r) => [r.pure1_id, r]));
  for (const r of rows) {
    const old = priorCap.get(r.id);
    if (!old || r.total) continue;
    r.total = old.capacity_bytes;
    r.used = r.used || old.used_bytes;
    r.dataReduction = r.dataReduction ?? old.data_reduction;
    r.effectiveUsed = r.effectiveUsed ?? old.effective_used_bytes;
    r.volumeSpace = r.volumeSpace || old.volume_bytes;
    r.sharedSpace = r.sharedSpace || old.shared_bytes;
    r.snapshotSpace = r.snapshotSpace || old.snapshots_bytes;
  }

  let enrichment = {};
  try {
    enrichment = await pure1Api.getEnrichment(coreApi, { force: true });
  } catch (err) {
    coreApi.logger.error('[Pure1Poller] Enrichment fetch failed, keeping last-good health:', err.message);
    for (const row of db.prepare('SELECT pure1_id, health, health_detail, chassis_serial, controller_serials, provisioned_bytes FROM pure1_arrays').all()) {
      enrichment[row.pure1_id] = {
        health: row.health,
        unhealthy: row.health_detail ? (JSON.parse(row.health_detail).unhealthy ?? 0) : 0,
        chassisSerial: row.chassis_serial,
        controllerSerials: row.controller_serials ? JSON.parse(row.controller_serials) : [],
        provisioned: row.provisioned_bytes,
      };
    }
  }

  let alerts = null;
  try {
    alerts = await pure1Api.getAlerts(coreApi, { force: true });
  } catch (err) {
    coreApi.logger.warn('[Pure1Poller] Alerts fetch failed; keeping existing alert inventory:', err.message);
  }

  try {
    const pods = await pure1Api.fetchPods(coreApi);
    replacePods1(db)(pods);
  } catch (err) {
    coreApi.logger.error('[Pure1Poller] Pods fetch failed, keeping last-good:', err.message);
  }

  const rowsForSnapshot = rows.map((r) => ({ ...r, _health: enrichment[r.id] ? enrichment[r.id].health : null }));
  const priorPerf = new Map(db.prepare(`
    SELECT pure1_id, read_iops, write_iops, read_latency_us, write_latency_us,
           read_bw_bytes, write_bw_bytes, perf_captured_at
    FROM pure1_arrays WHERE read_iops IS NOT NULL OR perf_captured_at IS NOT NULL
  `).all().map((r) => [r.pure1_id, r]));
  replaceArrays(db)(rows, enrichment);
  if (alerts !== null) replaceAlerts1(db)(alerts);
  const alertCountForSnapshot = alerts !== null ? alerts.length : db.prepare('SELECT COUNT(*) AS n FROM pure1_alerts').get().n;
  appendSnapshot(db, rowsForSnapshot, alertCountForSnapshot);

  const perfStmt = db.prepare(`
    UPDATE pure1_arrays SET read_iops = ?, write_iops = ?, read_latency_us = ?,
      write_latency_us = ?, read_bw_bytes = ?, write_bw_bytes = ?, perf_captured_at = ?
    WHERE pure1_id = ?
  `);
  let perf = new Map();
  try {
    perf = await pure1Api.fetchLatestPerformance(coreApi, rows.map((r) => r.id).filter(Boolean));
  } catch (err) {
    coreApi.logger.error('[Pure1Poller] Performance fetch failed, keeping last-good:', err.message);
  }
  for (const r of rows) {
    if (!r.id) continue;
    const p = perf.get(r.id);
    const old = priorPerf.get(r.id);
    const src = p || old;
    if (!src) continue;
    perfStmt.run(
      (p ? p.readIops : old.read_iops) ?? null, (p ? p.writeIops : old.write_iops) ?? null,
      (p ? p.readLatencyUs : old.read_latency_us) ?? null, (p ? p.writeLatencyUs : old.write_latency_us) ?? null,
      (p ? p.readBw : old.read_bw_bytes) ?? null, (p ? p.writeBw : old.write_bw_bytes) ?? null,
      p ? (p.capturedAt ? new Date(p.capturedAt).toISOString() : null) : old.perf_captured_at,
      r.id
    );
  }
  coreApi.logger.info(`[Pure1Poller] Refreshed ${rows.length} array(s), ${alertCountForSnapshot} alert(s)`);
}

function buildPure1Poller(coreApi) {
  return coreApi.createPoller({
    id: 'pure1',
    loadSources: () => [ACCOUNT_SOURCE],
    intervalMinutes: () => Number(coreApi.settings.getSetting('pure1_poll_interval_minutes')) || 15,
    poll: () => refreshPure1(coreApi),
  });
}

/** Shared singleton Pure1 (global-account) poller instance. */
function getPure1Poller(coreApi) {
  if (!pure1PollerInstance) pure1PollerInstance = buildPure1Poller(coreApi);
  return pure1PollerInstance;
}

// ── Manifest createPoller(coreApi) entry point ─────────────────────────────

/** Demo-only entry: On a demo instance ONLY, seeds/reseeds the fixture
 *  estate. Real instances never seed. Returns a handle mirroring the
 *  built-in's combined createPoller() shape. */
function createPurePoller(coreApi) {
  if (process.env.DASHBOARD_DEMO === '1') {
    const seedDemo = () => {
      try {
        const { seedPureDemo } = require('./demoSeed');
        const r = seedPureDemo(coreApi);
        coreApi.logger.info(`[PurePoller] demo estate seeded: ${r.arrays} direct array(s), ${r.pure1Arrays} Pure1 array(s), ${r.pure1Alerts} Pure1 alert(s)`);
        return r;
      } catch (err) {
        coreApi.logger.warn(`[PurePoller] demo seed failed: ${err.message}`);
        return null;
      }
    };
    seedDemo();
    // Demo instances seed fixtures but NEVER poll them (fictitious hosts /
    // no real Pure1 credentials): trigger() re-seeds instead, matching the
    // demo Refresh button semantics (dell/zerto plugin-sdk poller.js pattern).
    return {
      init: () => { coreApi.logger.info('[PurePoller] demo mode — polling disabled, fixtures only'); return []; },
      stopAll: () => {},
      trigger: () => { seedDemo(); return Promise.resolve(); },
      schedule: () => {},
      cancel: () => {},
      taskCount: () => 0,
    };
  }

  const pure = getPoller(coreApi);
  const pure1 = getPure1Poller(coreApi);

  return {
    // Combined handle mirroring the built-in (backend/platforms/pure/index.js):
    // init/stopAll drive both pollers; schedule/cancel/trigger/taskCount
    // delegate to the direct-array side only (Pure1 has no per-source rows
    // to schedule against — router.js reaches the Pure1 poller directly for
    // its settings-save reschedule and manual-refresh routes).
    init: () => {
      const sources = pure.init();
      pure1.init();
      coreApi.logger.info(`[PurePoller] Initialized ${sources.length} Pure array(s)`);
      return sources;
    },
    stopAll: () => { pure.stopAll(); pure1.stopAll(); },
    trigger: (arrayOrId) => {
      const array = typeof arrayOrId === 'object' ? arrayOrId : coreApi.db.prepare('SELECT * FROM pure_arrays WHERE id = ?').get(arrayOrId);
      return array ? pure.trigger(array) : Promise.resolve();
    },
    schedule: (array) => pure.schedule(array),
    cancel: (arrayId) => pure.cancel(arrayId),
    taskCount: () => pure.taskCount(),
  };
}

module.exports = { createPurePoller, getPoller, getPure1Poller, ACCOUNT_SOURCE };
