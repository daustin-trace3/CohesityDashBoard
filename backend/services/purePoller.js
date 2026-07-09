const cron = require('node-cron');
const db = require('../db/database');
const {
  fetchArrayInfo, fetchAlerts, fetchVolumes, fetchHosts,
  fetchVolumesPerformance, fetchArrayConnections, fetchProtectionGroups,
  fetchHardware, fetchDrives, fetchControllers, fetchCertificates,
  fetchNetworkInterfaces, fetchPorts, fetchConnections, fetchPods,
} = require('./pureApi');
const logger = require('../utils/logger');
const { createPoller } = require('../core/pollerFramework');

// Retention: prune Pure metrics older than 90 days, daily at 02:10.
cron.schedule('10 2 * * *', () => {
  try {
    const result = db.prepare(
      "DELETE FROM pure_metrics_history WHERE captured_at < datetime('now', '-90 days')"
    ).run();
    if (result.changes > 0) {
      logger.info(`[PurePoller] Pruned ${result.changes} old metrics row(s)`);
    }
    const volResult = db.prepare(
      "DELETE FROM pure_volume_history WHERE captured_at < datetime('now', '-90 days')"
    ).run();
    if (volResult.changes > 0) {
      logger.info(`[PurePoller] Pruned ${volResult.changes} old volume-history row(s)`);
    }
  } catch (err) {
    logger.error('[PurePoller] Failed to prune Pure history:', err.message);
  }
});

function num(v) {
  return v === undefined || v === null ? null : Number(v);
}

/** Insert a capacity + performance sample. */
function upsertMetrics(array, info, performance, volumeCount) {
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

/** Upsert open alerts, keyed on the array's own alert id. */
const upsertAlerts = db.transaction((array, alerts) => {
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

  // Anything no longer returned as "open" is cleared out.
  if (seen.length > 0) {
    const placeholders = seen.map(() => '?').join(',');
    db.prepare(
      `DELETE FROM pure_alerts WHERE array_id = ? AND pure_alert_id NOT IN (${placeholders})`
    ).run(array.id, ...seen);
  } else {
    db.prepare('DELETE FROM pure_alerts WHERE array_id = ?').run(array.id);
  }
});

const replaceVolumes = db.transaction((arrayId, volumes) => {
  db.prepare('DELETE FROM pure_volumes WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare(`
    INSERT INTO pure_volumes
      (array_id, name, provisioned_bytes, used_bytes, data_reduction, snapshots_bytes, destroyed)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const v of volumes) {
    const space = v.space || {};
    stmt.run(
      arrayId,
      v.name || null,
      num(v.provisioned),
      num(space.total_physical ?? space.unique),
      num(space.data_reduction),
      num(space.snapshots),
      v.destroyed ? 1 : 0
    );
  }
});

const replaceHosts = db.transaction((arrayId, hosts) => {
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
    stmt.run(
      arrayId,
      h.name || null,
      num(h.connection_count),
      h.personality || null,
      protocol
    );
  }
});

function safeErrorMessage(err) {
  if (err?.response) return `HTTP ${err.response.status} from array`;
  if (err?.code) return `Network error: ${err.code}`;
  return err?.message || 'Unknown error';
}

/** Append a per-volume time-series sample merging space + performance. */
const insertVolumeHistory = db.transaction((arrayId, volumes, perfByName) => {
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
    stmt.run(
      arrayId,
      v.name || 'unknown',
      num(v.provisioned),
      num(space.total_physical ?? space.unique),
      num(space.data_reduction),
      num(space.snapshots),
      num(p.reads_per_sec),
      num(p.writes_per_sec),
      num(p.usec_per_read_op),
      num(p.usec_per_write_op),
      num(p.read_bytes_per_sec),
      num(p.write_bytes_per_sec)
    );
  }
});

const replaceArrayConnections = db.transaction((arrayId, connections) => {
  db.prepare('DELETE FROM pure_array_connections WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare(`
    INSERT INTO pure_array_connections
      (array_id, remote_name, status, type, version, transport, mgmt_address, replication_addresses)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const c of connections) {
    stmt.run(
      arrayId,
      c.name || null,
      c.status || null,
      c.type || null,
      c.version || null,
      c.replication_transport || null,
      c.management_address || null,
      Array.isArray(c.replication_addresses) ? c.replication_addresses.join(', ') : null
    );
  }
});

const replaceProtectionGroups = db.transaction((arrayId, groups) => {
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
    stmt.run(
      arrayId,
      g.name || 'unknown',
      (g.source && g.source.name) || null,
      g.is_local ? 1 : 0,
      num(g.volume_count),
      num(g.host_count),
      num(g.target_count),
      snap.enabled ? 1 : 0,
      num(snap.frequency),
      repl.enabled ? 1 : 0,
      num(repl.frequency),
      num(srcRet.days),
      num(tgtRet.days),
      num(space.snapshots),
      g.destroyed ? 1 : 0
    );
  }
});

const replaceHardware = db.transaction((arrayId, items) => {
  db.prepare('DELETE FROM pure_hardware WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare(`
    INSERT INTO pure_hardware
      (array_id, name, type, model, status, serial, slot, speed, temperature, voltage)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const h of items) {
    stmt.run(
      arrayId,
      h.name || null,
      h.type || null,
      h.model || null,
      h.status || null,
      h.serial || null,
      num(h.slot),
      num(h.speed),
      num(h.temperature),
      num(h.voltage)
    );
  }
});

const replaceDrives = db.transaction((arrayId, items) => {
  db.prepare('DELETE FROM pure_drives WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare(`
    INSERT INTO pure_drives (array_id, name, type, protocol, status, capacity_bytes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const d of items) {
    stmt.run(arrayId, d.name || null, d.type || null, d.protocol || null, d.status || null, num(d.capacity));
  }
});

const replaceControllers = db.transaction((arrayId, items) => {
  db.prepare('DELETE FROM pure_controllers WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare(`
    INSERT INTO pure_controllers (array_id, name, model, status, mode, version)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const c of items) {
    stmt.run(arrayId, c.name || null, c.model || null, c.status || null, c.mode || null, c.version || null);
  }
});

const replaceCertificates = db.transaction((arrayId, items) => {
  db.prepare('DELETE FROM pure_certificates WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare(`
    INSERT INTO pure_certificates
      (array_id, name, status, common_name, issued_to, issued_by, key_size, valid_from_ms, valid_to_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const c of items) {
    stmt.run(
      arrayId,
      c.name || null,
      c.status || null,
      c.common_name || null,
      c.issued_to || null,
      c.issued_by || null,
      num(c.key_size),
      num(c.valid_from),
      num(c.valid_to)
    );
  }
});

const replaceNetworkInterfaces = db.transaction((arrayId, items) => {
  db.prepare('DELETE FROM pure_network_interfaces WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare(`
    INSERT INTO pure_network_interfaces
      (array_id, name, interface_type, enabled, speed_bps, services, address, netmask, gateway, mac_address, vlan, wwn)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const n of items) {
    const eth = n.eth || {};
    const fc = n.fc || {};
    stmt.run(
      arrayId, n.name || null, n.interface_type || null, n.enabled ? 1 : 0, num(n.speed),
      Array.isArray(n.services) ? n.services.join(', ') : null,
      eth.address || null, eth.netmask || null, eth.gateway || null, eth.mac_address || null, num(eth.vlan), fc.wwn || null
    );
  }
});

const replacePorts = db.transaction((arrayId, items) => {
  db.prepare('DELETE FROM pure_ports WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare('INSERT INTO pure_ports (array_id, name, wwn, iqn, nqn) VALUES (?, ?, ?, ?, ?)');
  for (const p of items) stmt.run(arrayId, p.name || null, p.wwn || null, p.iqn || null, p.nqn || null);
});

const replaceConnections = db.transaction((arrayId, items) => {
  db.prepare('DELETE FROM pure_connections WHERE array_id = ?').run(arrayId);
  const stmt = db.prepare(`
    INSERT INTO pure_connections (array_id, host_name, host_group_name, volume_name, lun)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const c of items) {
    stmt.run(arrayId, c.host?.name || null, c.host_group?.name || null, c.volume?.name || null, num(c.lun));
  }
});

const replacePods = db.transaction((arrayId, items) => {
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
    stmt.run(
      arrayId, p.name || null, p.promotion_status || null, p.mediator || null,
      num(p.array_count), num(p.link_source_count), num(p.link_target_count),
      members, num(space.total_physical), num(space.data_reduction)
    );
  }
});

/** Poll a single Pure array: capacity, performance, alerts, volumes, hosts,
 *  plus per-volume perf history, replication, protection, and hardware. */
async function doPollArray(array) {
  const [
      infoResult, alertResult, volumeResult, hostResult, volPerfResult,
      connResult, pgResult, hwResult, driveResult, ctrlResult, certResult,
      netResult, portResult, connsResult, podResult,
    ] = await Promise.allSettled([
      fetchArrayInfo(array),
      fetchAlerts(array),
      fetchVolumes(array),
      fetchHosts(array),
      fetchVolumesPerformance(array),
      fetchArrayConnections(array),
      fetchProtectionGroups(array),
      fetchHardware(array),
      fetchDrives(array),
      fetchControllers(array),
      fetchCertificates(array),
      fetchNetworkInterfaces(array),
      fetchPorts(array),
      fetchConnections(array),
      fetchPods(array),
    ]);

    let volumeCount = null;
    if (volumeResult.status === 'fulfilled') {
      volumeCount = volumeResult.value.length;
      try {
        replaceVolumes(array.id, volumeResult.value);
      } catch (err) {
        logger.error(`[PurePoller] Volume snapshot failed for array ${array.id}:`, err.message);
      }
    } else {
      logger.error(`[PurePoller] Volumes fetch failed for array ${array.id}:`, safeErrorMessage(volumeResult.reason));
    }

    if (infoResult.status === 'fulfilled') {
      try {
        upsertMetrics(array, infoResult.value.info, infoResult.value.performance, volumeCount);
      } catch (err) {
        logger.error(`[PurePoller] Metrics insert failed for array ${array.id}:`, err.message);
      }
    } else {
      logger.error(`[PurePoller] Array info fetch failed for array ${array.id}:`, safeErrorMessage(infoResult.reason));
    }

    if (alertResult.status === 'fulfilled') {
      try {
        upsertAlerts(array, alertResult.value);
      } catch (err) {
        logger.error(`[PurePoller] Alert upsert failed for array ${array.id}:`, err.message);
      }
    } else {
      logger.error(`[PurePoller] Alerts fetch failed for array ${array.id}:`, safeErrorMessage(alertResult.reason));
    }

    if (hostResult.status === 'fulfilled') {
      try {
        replaceHosts(array.id, hostResult.value);
      } catch (err) {
        logger.error(`[PurePoller] Host snapshot failed for array ${array.id}:`, err.message);
      }
    } else {
      logger.error(`[PurePoller] Hosts fetch failed for array ${array.id}:`, safeErrorMessage(hostResult.reason));
    }

    // Per-volume perf history (needs both the volume list and its performance).
    if (volumeResult.status === 'fulfilled') {
      const perfByName = new Map();
      if (volPerfResult.status === 'fulfilled') {
        for (const p of volPerfResult.value) perfByName.set(p.name, p);
      } else {
        logger.error(`[PurePoller] Volume perf fetch failed for array ${array.id}:`, safeErrorMessage(volPerfResult.reason));
      }
      try {
        insertVolumeHistory(array.id, volumeResult.value, perfByName);
      } catch (err) {
        logger.error(`[PurePoller] Volume history insert failed for array ${array.id}:`, err.message);
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
        try {
          store(array.id, result.value);
        } catch (err) {
          logger.error(`[PurePoller] ${label} store failed for array ${array.id}:`, err.message);
        }
      } else {
        logger.error(`[PurePoller] ${label} fetch failed for array ${array.id}:`, safeErrorMessage(result.reason));
      }
    }
}

const purePollerHandle = createPoller({
  id: 'pure',
  loadSources: () => db.prepare('SELECT * FROM pure_arrays').all(),
  intervalMinutes: (array) => array.polling_interval_minutes,
  poll: doPollArray,
});

/**
 * Poll a single Pure array (markStart/markEnd + error isolation via the
 * shared poller framework).
 */
async function pollArray(array) {
  await purePollerHandle.trigger(array);
}

function cancelArray(arrayId) {
  purePollerHandle.cancel(arrayId);
}

function scheduleArray(array) {
  purePollerHandle.schedule(array);
}

function initPurePoller() {
  const arrays = purePollerHandle.init();
  logger.info(`[PurePoller] Initialized ${arrays.length} Pure array(s)`);
}

async function triggerPoll(arrayId) {
  const array = db.prepare('SELECT * FROM pure_arrays WHERE id = ?').get(arrayId);
  if (!array) throw new Error(`Pure array ${arrayId} not found`);
  await pollArray(array);
}

function stopAll() {
  purePollerHandle.stopAll();
}

module.exports = { initPurePoller, scheduleArray, cancelArray, pollArray, triggerPoll, stopAll, purePollerHandle };
