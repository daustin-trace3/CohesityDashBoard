// Dell OME poller — one scheduled task per registered OME instance (framework
// per-source model, like vCenter). Each poll pulls the device list (required),
// then best-effort: per-device hardware inventory, alerts (incremental,
// deduped on alert id), warranties, firmware compliance, and Power Manager
// instant metrics (skipped for the whole poll on the first plugin-absent
// error). Inventory tables are replaced per instance; a metrics snapshot is
// appended per poll.
const db = require('../db/database');
const { createPoller } = require('../core/pollerFramework');
const {
  fetchApplianceInfo, fetchDeviceTypeMap, fetchDevices, fetchDeviceInventory,
  summarizeComponents, fetchAlerts, fetchWarranties, fetchFirmwareCompliance,
  fetchDeviceMetrics, fetchDevicePowerThermal, fetchConfigCompliance,
  fetchJobs, fetchConfigProfiles, fetchHardwareLogs,
} = require('./dellOmeApi');
const logger = require('../utils/logger');

const safeMsg = (e) => e?.response ? `HTTP ${e.response.status}${e.message && !/^Request failed/.test(e.message) ? ` — ${e.message}` : ''}` : (e?.message || String(e));

// Per-device sweeps are capped so a 5,000-device OME can't stall the poller.
const INVENTORY_DEVICE_CAP = 500;
const METRICS_DEVICE_CAP = 300;
const HWLOG_DEVICE_CAP = 300;

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

  // Configuration compliance (governance): baselines + per-device drift.
  let configCompliance = null; // null = sweep unavailable, keeps prior rows
  try { configCompliance = await fetchConfigCompliance(ome); } catch (err) {
    logger.debug(`[DellPoller] ${ome.name}: config compliance fetch failed: ${safeMsg(err)}`);
  }

  let jobs = null;
  try { jobs = await fetchJobs(ome); } catch (err) {
    logger.debug(`[DellPoller] ${ome.name}: jobs fetch failed: ${safeMsg(err)}`);
  }

  let profiles = null;
  try { profiles = await fetchConfigProfiles(ome); } catch (err) {
    logger.debug(`[DellPoller] ${ome.name}: profiles fetch failed: ${safeMsg(err)}`);
  }

  // Per-device iDRAC hardware (Lifecycle/SEL) logs — append incrementally,
  // so a failed sweep just means no new rows this poll. First hard failure
  // disables the sweep for the rest of the poll (endpoint unsupported).
  const hardwareLogs = [];
  let hwlogFailures = 0;
  for (const d of serverDevices.slice(0, HWLOG_DEVICE_CAP)) {
    try {
      hardwareLogs.push(...await fetchHardwareLogs(ome, d.deviceId));
    } catch (err) {
      hwlogFailures += 1;
      logger.debug(`[DellPoller] hardware logs failed for device ${d.deviceId} (${d.name}): ${safeMsg(err)}`);
      if (hwlogFailures >= 3 && hardwareLogs.length === 0) break;
    }
  }

  return { info, devices, components, alerts, warranties, firmware, configCompliance, jobs, profiles, hardwareLogs };
}

const store = db.transaction((omeId, { info, devices, components, alerts, warranties, firmware, configCompliance, jobs, profiles, hardwareLogs }) => {
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
      subcategory, message_id, message, device_name, service_tag, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const a of alerts || []) {
    alertStmt.run(omeId, a.alertId, a.severity, a.status, a.category,
      a.subcategory, a.messageId, a.message, a.deviceName, a.serviceTag, a.createdAt);
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

  if (configCompliance) {
    db.prepare('DELETE FROM dell_config_baselines WHERE ome_id = ?').run(omeId);
    const blStmt = db.prepare(`
      INSERT INTO dell_config_baselines (ome_id, baseline_id, name, description, template_id,
        template_name, last_run, compliance_status, n_critical, n_warning, n_normal,
        n_incomplete, task_id, percent_complete)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const b of configCompliance.baselines) {
      blStmt.run(omeId, b.baselineId, b.name, b.description, b.templateId, b.templateName,
        b.lastRun, b.complianceStatus, b.nCritical, b.nWarning, b.nNormal,
        b.nIncomplete, b.taskId, b.percentComplete);
    }
    db.prepare('DELETE FROM dell_config_compliance WHERE ome_id = ?').run(omeId);
    const ccStmt = db.prepare(`
      INSERT INTO dell_config_compliance (ome_id, baseline_id, baseline_name, device_id,
        device_name, service_tag, model, status, inventory_time, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of configCompliance.reports) {
      ccStmt.run(omeId, r.baselineId, r.baselineName, r.deviceId, r.deviceName,
        r.serviceTag, r.model, r.status, r.inventoryTime,
        r.detail ? JSON.stringify(r.detail) : null);
    }

    // Drift timeline reconciliation. OME carries no change timestamp, so
    // first_seen = when THIS poller first observed the drift. A key that
    // re-drifts after being resolved starts a new episode (first_seen resets).
    const driftUpsert = db.prepare(`
      INSERT INTO dell_config_drift_history (ome_id, baseline_id, device_id, service_tag,
        attr_group, attribute, expected, current, first_seen, last_seen, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), NULL)
      ON CONFLICT(ome_id, baseline_id, device_id, attr_group, attribute) DO UPDATE SET
        expected = excluded.expected, current = excluded.current,
        service_tag = excluded.service_tag,
        first_seen = CASE WHEN resolved_at IS NULL THEN first_seen ELSE excluded.first_seen END,
        last_seen = excluded.last_seen, resolved_at = NULL
    `);
    const seenKeys = new Set();
    for (const r of configCompliance.reports) {
      for (const d of r.detail || []) {
        const grp = d.group || '';
        const attr = d.attribute || '';
        seenKeys.add(`${r.baselineId}|${r.deviceId}|${grp}|${attr}`);
        driftUpsert.run(omeId, r.baselineId, r.deviceId, r.serviceTag, grp, attr,
          d.expected != null ? String(d.expected) : null,
          d.current != null ? String(d.current) : null);
      }
    }
    // Anything unresolved that no longer drifts (and whose device was actually
    // evaluated this poll) is closed out. Devices missing detail (over the
    // per-poll detail cap) keep their open episodes untouched.
    const evaluated = new Set(configCompliance.reports
      .filter((r) => r.status === 'compliant' || r.detail)
      .map((r) => `${r.baselineId}|${r.deviceId}`));
    const open = db.prepare(
      'SELECT id, baseline_id, device_id, attr_group, attribute FROM dell_config_drift_history WHERE ome_id = ? AND resolved_at IS NULL'
    ).all(omeId);
    const resolveStmt = db.prepare("UPDATE dell_config_drift_history SET resolved_at = datetime('now') WHERE id = ?");
    for (const row of open) {
      const devKey = `${row.baseline_id}|${row.device_id}`;
      if (!evaluated.has(devKey)) continue;
      if (!seenKeys.has(`${devKey}|${row.attr_group}|${row.attribute}`)) resolveStmt.run(row.id);
    }
  }

  if (jobs) {
    db.prepare('DELETE FROM dell_jobs WHERE ome_id = ?').run(omeId);
    const jobStmt = db.prepare(`
      INSERT INTO dell_jobs (ome_id, job_id, name, description, job_type, internal, state,
        builtin, visible, last_run_status_id, last_run_status, job_status, last_run,
        next_run, start_time, end_time, schedule, created_by, targets)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const j of jobs) {
      jobStmt.run(omeId, j.jobId, j.name, j.description, j.jobType, j.internal, j.state,
        j.builtin, j.visible, j.lastRunStatusId, j.lastRunStatus, j.jobStatus, j.lastRun,
        j.nextRun, j.startTime, j.endTime, j.schedule, j.createdBy, j.targets);
    }
  }

  if (profiles) {
    db.prepare('DELETE FROM dell_config_profiles WHERE ome_id = ?').run(omeId);
    const profStmt = db.prepare(`
      INSERT INTO dell_config_profiles (ome_id, profile_id, name, description, template_id,
        template_name, target_id, target_name, chassis_name, state, last_run_status_id,
        last_run_status, profile_modified, created_by, created_date, last_deploy_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const p of profiles) {
      profStmt.run(omeId, p.profileId, p.name, p.description, p.templateId, p.templateName,
        p.targetId, p.targetName, p.chassisName, p.state, p.lastRunStatusId,
        p.lastRunStatus, p.profileModified, p.createdBy, p.createdDate, p.lastDeployDate);
    }
  }

  const hwlogStmt = db.prepare(`
    INSERT OR IGNORE INTO dell_hardware_logs (ome_id, device_id, log_id, seq, severity,
      category, message_id, message, comment, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const l of hardwareLogs || []) {
    hwlogStmt.run(omeId, l.deviceId, l.logId, l.seq, l.severity, l.category,
      l.messageId, l.message, l.comment, l.createdAt);
  }
  db.prepare("DELETE FROM dell_hardware_logs WHERE created_at < datetime('now', '-365 days')").run();

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

const dellPoller = createPoller({
  id: 'dell',
  loadSources: () => db.prepare('SELECT * FROM dell_ome_instances').all(),
  intervalMinutes: (ome) => ome.polling_interval_minutes,
  poll: pollDell,
});

function initDellPoller() {
  const sources = dellPoller.init();
  logger.info(`[DellPoller] Initialized ${sources.length} OME instance(s)`);
  return dellPoller;
}

module.exports = { initDellPoller, dellPoller, pollDell };
