// Dell OME poller — one scheduled task per registered OME instance (framework
// per-source model, like vCenter). Each poll pulls the device list (required),
// then best-effort: per-device hardware inventory, alerts (incremental,
// deduped on alert id), warranties, firmware compliance, and Power Manager
// instant metrics (skipped for the whole poll on the first plugin-absent
// error). Inventory tables are replaced per instance; a metrics snapshot is
// appended per poll.
const db = require('../db/database');
const cron = require('node-cron');
const pollerStatus = require('./pollerStatus');
const {
  fetchApplianceInfo, fetchDeviceTypeMap, fetchDevices, fetchDeviceInventory,
  summarizeComponents, fetchAlerts, fetchWarranties, fetchFirmwareCompliance,
  fetchDeviceMetrics, fetchDevicePowerThermal,
} = require('./dellOmeApi');
const logger = require('../utils/logger');

const safeMsg = (e) => e?.response ? `HTTP ${e.response.status}${e.message && !/^Request failed/.test(e.message) ? ` — ${e.message}` : ''}` : (e?.message || String(e));

// Per-device sweeps are capped so a 5,000-device OME can't stall the poller.
const INVENTORY_DEVICE_CAP = 500;
const METRICS_DEVICE_CAP = 300;

async function collect(ome) {
  const [info, typeMap] = [await fetchApplianceInfo(ome), await fetchDeviceTypeMap(ome)];
  const devices = await fetchDevices(ome, typeMap);

  // Hardware inventory: one InventoryDetails call per device (all sections in
  // one response). Server-class devices only — switches/chassis IOMs have none.
  let components = null; // null = sweep unavailable, keeps prior rows
  const serverDevices = devices.filter((d) => /server/i.test(d.deviceType)).slice(0, INVENTORY_DEVICE_CAP);
  if (serverDevices.length) {
    components = [];
    let failures = 0;
    for (const d of serverDevices) {
      try {
        components.push(...await fetchDeviceInventory(ome, d.deviceId));
      } catch (err) {
        failures += 1;
        logger.debug(`[DellPoller] inventory failed for device ${d.deviceId} (${d.name}): ${safeMsg(err)}`);
        if (failures >= 5 && components.length === 0) {
          // Endpoint clearly not working — keep prior rows instead of wiping.
          components = null;
          break;
        }
      }
    }
  }
  if (components) {
    const summary = summarizeComponents(components);
    for (const d of devices) {
      const s = summary.get(d.deviceId);
      if (s) {
        d.cpuCount = s.cpuCount || null; d.coreCount = s.coreCount || null;
        d.memoryBytes = s.memoryBytes || null; d.diskBytes = s.diskBytes || null;
      }
    }
  }

  // Power Manager instant metrics — plugin-gated; first hard failure disables
  // the sweep for this poll and drops to the base-OME per-device Power /
  // Temperature endpoints (console Device > Server snapshot — no license
  // needed, but no CPU/memory utilization either).
  let metricsAvailable = true;
  let baseAvailable = true;
  for (const d of serverDevices.slice(0, METRICS_DEVICE_CAP)) {
    const dev = devices.find((x) => x.deviceId === d.deviceId);
    if (!dev) continue;
    if (metricsAvailable) {
      try {
        const m = await fetchDeviceMetrics(ome, d.deviceId);
        Object.assign(dev, { powerW: m.powerW, inletTempC: m.inletTempC, cpuUtilPct: m.cpuUtilPct, memUtilPct: m.memUtilPct });
        continue;
      } catch (err) {
        metricsAvailable = false;
        logger.debug(`[DellPoller] ${ome.name}: Power Manager metrics unavailable, falling back to device Power/Temperature (${safeMsg(err)})`);
      }
    }
    if (!baseAvailable) break;
    const pt = await fetchDevicePowerThermal(ome, d.deviceId);
    if (pt.powerW == null && pt.inletTempC == null && d === serverDevices[0]) {
      // Neither endpoint answered on the first device — assume unsupported.
      baseAvailable = false;
      break;
    }
    Object.assign(dev, { powerW: pt.powerW, inletTempC: pt.inletTempC });
  }

  let alerts = [];
  try { alerts = await fetchAlerts(ome); } catch (err) {
    logger.warn(`[DellPoller] ${ome.name}: alert fetch failed: ${safeMsg(err)}`);
  }

  let warranties = null;
  try { warranties = await fetchWarranties(ome); } catch (err) {
    logger.debug(`[DellPoller] ${ome.name}: warranty fetch failed: ${safeMsg(err)}`);
  }

  let firmware = null;
  try { firmware = await fetchFirmwareCompliance(ome); } catch (err) {
    logger.debug(`[DellPoller] ${ome.name}: firmware compliance fetch failed: ${safeMsg(err)}`);
  }

  return { info, devices, components, alerts, warranties, firmware };
}

const store = db.transaction((omeId, { info, devices, components, alerts, warranties, firmware }) => {
  if (info?.version) {
    db.prepare('UPDATE dell_ome_instances SET version = ? WHERE id = ?').run(info.version, omeId);
  }

  db.prepare('DELETE FROM dell_devices WHERE ome_id = ?').run(omeId);
  const devStmt = db.prepare(`
    INSERT INTO dell_devices (ome_id, device_id, service_tag, name, model, device_type,
      chassis_service_tag, health, health_raw, power_state, connection_state, managed_state,
      asset_tag, ip_address, firmware_version, cpu_count, core_count, memory_bytes,
      disk_bytes, power_w, inlet_temp_c, cpu_util_pct, mem_util_pct, last_inventory_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const d of devices) {
    devStmt.run(omeId, d.deviceId, d.serviceTag, d.name, d.model, d.deviceType,
      d.chassisServiceTag, d.health, d.healthRaw, d.powerState, d.connectionState, d.managedState,
      d.assetTag, d.ipAddress, d.firmwareVersion, d.cpuCount ?? null, d.coreCount ?? null,
      d.memoryBytes ?? null, d.diskBytes ?? null, d.powerW ?? null, d.inletTempC ?? null,
      d.cpuUtilPct ?? null, d.memUtilPct ?? null, d.lastInventoryTime);
  }

  if (components) {
    db.prepare('DELETE FROM dell_components WHERE ome_id = ?').run(omeId);
    const compStmt = db.prepare(`
      INSERT INTO dell_components (ome_id, device_id, kind, name, description, status,
        model, serial, slot, size_bytes, speed, extra)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const c of components) {
      compStmt.run(omeId, c.deviceId, c.kind, c.name, c.description, c.status,
        c.model, c.serial, c.slot, c.sizeBytes, c.speed,
        c.extra ? JSON.stringify(c.extra) : null);
    }
  }

  const alertStmt = db.prepare(`
    INSERT OR IGNORE INTO dell_alerts (ome_id, alert_id, severity, status, category,
      subcategory, message, device_name, service_tag, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const a of alerts || []) {
    alertStmt.run(omeId, a.alertId, a.severity, a.status, a.category,
      a.subcategory, a.message, a.deviceName, a.serviceTag, a.createdAt);
  }
  db.prepare("DELETE FROM dell_alerts WHERE created_at < datetime('now', '-90 days')").run();

  if (warranties) {
    db.prepare('DELETE FROM dell_warranties WHERE ome_id = ?').run(omeId);
    const warStmt = db.prepare(`
      INSERT INTO dell_warranties (ome_id, device_id, service_tag, device_model,
        device_type, service_level, start_date, end_date, days_remaining)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const w of warranties) {
      warStmt.run(omeId, w.deviceId, w.serviceTag, w.deviceModel, w.deviceType,
        w.serviceLevel, w.startDate, w.endDate, w.daysRemaining);
    }
  }

  if (firmware) {
    db.prepare('DELETE FROM dell_firmware_compliance WHERE ome_id = ?').run(omeId);
    const fwStmt = db.prepare(`
      INSERT INTO dell_firmware_compliance (ome_id, baseline_id, baseline_name,
        device_id, service_tag, device_model, status, noncompliant_components)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const f of firmware) {
      fwStmt.run(omeId, f.baselineId, f.baselineName, f.deviceId, f.serviceTag,
        f.deviceModel, f.status, f.noncompliantComponents);
    }
  }

  const isSrv = (d) => /server/i.test(d.deviceType);
  db.prepare(`
    INSERT INTO dell_metrics_history (ome_id, devices_total, devices_ok, devices_warning,
      devices_critical, devices_powered_on, servers_total, alerts_critical_7d, power_w_total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(omeId, devices.length,
    devices.filter((d) => d.health === 'ok').length,
    devices.filter((d) => d.health === 'warning').length,
    devices.filter((d) => d.health === 'critical').length,
    devices.filter((d) => d.powerState === 'on').length,
    devices.filter(isSrv).length,
    db.prepare("SELECT COUNT(*) AS n FROM dell_alerts WHERE ome_id = ? AND severity = 'critical' AND created_at >= datetime('now', '-7 days')").get(omeId).n,
    devices.reduce((n, d) => n + (d.powerW || 0), 0) || null);
  db.prepare("DELETE FROM dell_metrics_history WHERE captured_at < datetime('now', '-365 days')").run();
});

async function pollDell(ome) {
  try {
    const data = await collect(ome);
    store(ome.id, data);
    db.prepare(`
      UPDATE dell_ome_instances SET last_poll_status = 'success', last_poll_error = NULL,
        last_poll_at = datetime('now') WHERE id = ?
    `).run(ome.id);
    logger.info(`[DellPoller] ${ome.name}: ${data.devices.length} device(s), ${(data.components || []).length} component(s), ${(data.alerts || []).length} alert(s) seen`);
  } catch (err) {
    db.prepare(`
      UPDATE dell_ome_instances SET last_poll_status = 'error', last_poll_error = ?,
        last_poll_at = datetime('now') WHERE id = ?
    `).run(safeMsg(err), ome.id);
    throw err;
  }
}

// Per-instance scheduling, purePoller-style (this branch has no
// core/pollerFramework). Same surface as the icc-phase1 framework handle:
// schedule / cancel / trigger.
const scheduledTasks = new Map();

async function pollWrapped(ome) {
  pollerStatus.markStart('dell', ome.id);
  try {
    await pollDell(ome);
    pollerStatus.markEnd('dell', ome.id, 'success');
  } catch (err) {
    logger.error(`[DellPoller] Poll failed for ${ome.name}:`, err?.message || err);
    pollerStatus.markEnd('dell', ome.id, 'error');
  }
}

const dellPoller = {
  schedule(ome) {
    this.cancel(ome.id);
    const interval = Math.max(5, Number(ome.polling_interval_minutes) || 15);
    const task = cron.schedule(`*/${interval} * * * *`, () => { pollWrapped(ome); });
    scheduledTasks.set(ome.id, task);
  },
  cancel(omeId) {
    const task = scheduledTasks.get(omeId);
    if (task) { task.stop(); scheduledTasks.delete(omeId); }
  },
  trigger: (ome) => pollWrapped(ome),
};

function initDellPoller() {
  const sources = db.prepare('SELECT * FROM dell_ome_instances').all();
  for (const ome of sources) dellPoller.schedule(ome);
  logger.info(`[DellPoller] Initialized ${sources.length} OME instance(s)`);
  return dellPoller;
}

module.exports = { initDellPoller, dellPoller, pollDell };
