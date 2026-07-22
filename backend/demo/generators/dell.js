// Dell OpenManage Enterprise demo data: two OME appliances managing a
// PowerEdge fleet with realistic model mix, per-server component inventory
// (CPU/DIMM/disk/NIC/PSU/OS with a few failing parts), alerts, warranty
// runway (some expiring/expired), firmware baseline drift, Power Manager
// metrics on one site only (the other shows the "plugin not installed"
// experience), and 30 days of metrics history.
const { randInt, randFloat, pick, chance, rngFor } = require('./core');

const MODELS = [
  { model: 'PowerEdge R650', sockets: 2, coresPer: 24, memGb: 512, gen: 'current' },
  { model: 'PowerEdge R750', sockets: 2, coresPer: 28, memGb: 768, gen: 'current' },
  { model: 'PowerEdge R660', sockets: 2, coresPer: 32, memGb: 1024, gen: 'current' },
  { model: 'PowerEdge R640', sockets: 2, coresPer: 20, memGb: 384, gen: 'aging' },
  { model: 'PowerEdge R740xd', sockets: 2, coresPer: 22, memGb: 512, gen: 'aging' },
  { model: 'PowerEdge R630', sockets: 2, coresPer: 14, memGb: 256, gen: 'eol' },
];

const ALERT_TEMPLATES = [
  { severity: 'critical', category: 'System Health', subcategory: 'Storage', msg: (d, rng) => `Fault detected on physical disk in slot ${randInt(rng, 0, 11)} of ${d}` },
  { severity: 'critical', category: 'System Health', subcategory: 'Power', msg: (d) => `Power supply redundancy is lost on ${d}` },
  { severity: 'warning', category: 'System Health', subcategory: 'Temperature', msg: (d) => `System inlet temperature is above the warning threshold on ${d}` },
  { severity: 'warning', category: 'System Health', subcategory: 'Memory', msg: (d, rng) => `Correctable memory error rate exceeded on DIMM ${pick(rng, ['A1', 'A5', 'B2', 'B7'])} of ${d}` },
  { severity: 'warning', category: 'Configuration', subcategory: 'Firmware', msg: (d) => `Firmware on ${d} does not match the assigned baseline` },
  { severity: 'info', category: 'Audit', subcategory: 'Devices', msg: (d) => `Inventory refresh completed for ${d}` },
  { severity: 'info', category: 'Configuration', subcategory: 'Discovery', msg: (d) => `Discovery task found device ${d}` },
];

const SVC_LEVELS = ['ProSupport Plus with Next Business Day Onsite', 'ProSupport with Next Business Day Onsite', 'Basic Hardware Warranty'];

function seedDell(db, { now, encrypt }) {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES ('platform_dell_enabled', '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run();

  const nowIso = new Date(now).toISOString();
  const instances = [
    { name: 'DC1 OME', host: 'ome-dc1.demo.local', version: '4.2.0', servers: 64, powerManager: true, healthy: true },
    { name: 'DC2 OME', host: 'ome-dc2.demo.local', version: '4.1.1', servers: 38, powerManager: false, healthy: true },
  ];

  const instStmt = db.prepare(`
    INSERT INTO dell_ome_instances (name, host, username, encrypted_credentials, ssl_verify,
      polling_interval_minutes, version, last_poll_status, last_poll_error, last_poll_at)
    VALUES (?, ?, ?, ?, 0, 15, ?, ?, ?, datetime('now', ?))
  `);
  const devStmt = db.prepare(`
    INSERT INTO dell_devices (ome_id, device_id, service_tag, name, model, device_type,
      chassis_service_tag, health, health_raw, power_state, connection_state, managed_state,
      asset_tag, ip_address, firmware_version, cpu_count, core_count, memory_bytes,
      disk_bytes, power_w, inlet_temp_c, cpu_util_pct, mem_util_pct, last_inventory_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const compStmt = db.prepare(`
    INSERT INTO dell_components (ome_id, device_id, kind, name, description, status,
      model, serial, slot, size_bytes, speed, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const alertStmt = db.prepare(`
    INSERT OR IGNORE INTO dell_alerts (ome_id, alert_id, severity, status, category,
      subcategory, message, device_name, service_tag, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const warStmt = db.prepare(`
    INSERT INTO dell_warranties (ome_id, device_id, service_tag, device_model, device_type,
      service_level, start_date, end_date, days_remaining)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const fwStmt = db.prepare(`
    INSERT INTO dell_firmware_compliance (ome_id, baseline_id, baseline_name, device_id,
      service_tag, device_model, status, noncompliant_components)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const histStmt = db.prepare(`
    INSERT INTO dell_metrics_history (ome_id, captured_at, devices_total, devices_ok,
      devices_warning, devices_critical, devices_powered_on, servers_total,
      alerts_critical_7d, power_w_total)
    VALUES (?, datetime('now', ?), ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const svcTag = (rng) => Array.from({ length: 7 }, () => pick(rng, 'ABCDEFGHJKLMNPQRSTVWXYZ0123456789'.split(''))).join('');

  let totals = { instances: 0, devices: 0, components: 0, alerts: 0, warranties: 0, firmware: 0 };
  let deviceIdSeq = 10000;
  let alertIdSeq = 500000;

  for (const inst of instances) {
    const rng = rngFor(inst.name);
    const info = instStmt.run(inst.name, inst.host, 'demo-viewer',
      encrypt(JSON.stringify({ password: 'demo-not-real' })), inst.version,
      'success', null, `-${randInt(rng, 1, 12)} minutes`);
    const omeId = info.lastInsertRowid;
    totals.instances += 1;

    for (let i = 0; i < inst.servers; i++) {
      const m = pick(rng, MODELS);
      const deviceId = deviceIdSeq++;
      const tag = svcTag(rng);
      const name = `${inst.name.split(' ')[0].toLowerCase()}-esx-${String(i + 1).padStart(3, '0')}.demo.local`;
      // Health mix: mostly ok, a few warning/critical concentrated on aging gear
      const roll = randFloat(rng, 0, 1);
      const health = roll > 0.96 ? 'critical' : roll > 0.88 ? 'warning' : 'ok';
      const powerOff = chance(rng, 0.05);
      const disconnected = chance(rng, 0.02);
      const cores = m.sockets * m.coresPer;
      const memBytes = m.memGb * 1024 ** 3;
      const diskCount = randInt(rng, 4, 12);
      const diskEach = pick(rng, [960e9, 1.92e12, 3.84e12, 7.68e12]);
      // Base OME exposes power/thermal per device; CPU/memory utilization
      // additionally needs the Power Manager plugin (DC1 only).
      const metered = !powerOff && !disconnected;
      const hasPm = inst.powerManager && metered;

      devStmt.run(omeId, deviceId, tag, name, m.model, 'Server',
        null, health, health === 'ok' ? 1000 : health === 'warning' ? 3000 : 4000,
        powerOff ? 'off' : 'on', disconnected ? 0 : 1, 'Managed',
        chance(rng, 0.3) ? `AST-${randInt(rng, 1000, 9999)}` : null,
        `10.${inst.name.includes('DC1') ? 40 : 41}.${randInt(rng, 1, 8)}.${randInt(rng, 10, 250)}`,
        `iDRAC ${pick(rng, ['7.10.30.00', '7.00.60.00', '6.10.80.00'])}`,
        m.sockets, cores, memBytes, diskCount * diskEach,
        metered ? randInt(rng, 220, 640) : null,
        metered ? randFloat(rng, 18, 27) : null,
        hasPm ? randFloat(rng, 4, 78) : null,
        hasPm ? randFloat(rng, 20, 85) : null,
        nowIso);
      totals.devices += 1;

      // Components. Failing parts drive the Governance page: critical-health
      // devices get a failed disk or PSU; some warning devices a degraded DIMM.
      for (let s = 0; s < m.sockets; s++) {
        compStmt.run(omeId, deviceId, 'processor',
          `Intel Xeon Gold ${pick(rng, ['6338', '6342', '6430', '5318Y'])}`, 'CPU', 'ok',
          null, null, `CPU.Socket.${s + 1}`, null, `${pick(rng, ['2000', '2300', '2600'])} MHz`,
          JSON.stringify({ cores: m.coresPer }));
        totals.components += 1;
      }
      const dimmCount = m.memGb >= 768 ? 16 : 8;
      const dimmBytes = memBytes / dimmCount;
      const badDimm = health === 'warning' && chance(rng, 0.5) ? randInt(rng, 0, dimmCount - 1) : -1;
      for (let d = 0; d < dimmCount; d++) {
        compStmt.run(omeId, deviceId, 'memory', `DIMM ${String.fromCharCode(65 + (d % 2))}${Math.floor(d / 2) + 1}`,
          'DDR4 RDIMM', d === badDimm ? 'warning' : 'ok',
          `M393A${randInt(rng, 1, 9)}K40DB3`, `S${randInt(rng, 10000000, 99999999)}`,
          `DIMM.Socket.${d + 1}`, dimmBytes, '3200 MHz',
          JSON.stringify({ manufacturer: pick(rng, ['Samsung', 'Hynix', 'Micron']) }));
        totals.components += 1;
      }
      const badDisk = health === 'critical' && chance(rng, 0.7) ? randInt(rng, 0, diskCount - 1) : -1;
      for (let d = 0; d < diskCount; d++) {
        const media = pick(rng, ['SSD', 'SSD', 'SSD', 'HDD']);
        compStmt.run(omeId, deviceId, 'disk',
          media === 'SSD' ? `Dell Ent NVMe v2 AGN RI U.2 ${(diskEach / 1e12).toFixed(2)}TB` : `Seagate Exos ${(diskEach / 1e12).toFixed(0)}TB SAS`,
          null, d === badDisk ? 'critical' : 'ok',
          media === 'SSD' ? 'MZWLJ3T8HBLS' : 'ST8000NM014A', `D${randInt(rng, 10000000, 99999999)}`,
          String(d), diskEach, media === 'SSD' ? 'NVMe' : 'SAS',
          JSON.stringify({ mediaType: media, busType: media === 'SSD' ? 'NVMe' : 'SAS', predictiveFailure: d === badDisk ? 'Failure predicted' : null }));
        totals.components += 1;
      }
      // RAID controller + virtual disks (console Devices > Hardware view).
      compStmt.run(omeId, deviceId, 'raid', 'PERC H755 Front', 'PERC H755 Front', 'ok',
        'PERC H755', null, '3', null, null,
        JSON.stringify({ firmware: '52.26.0-5179', cacheMb: 8192 }));
      totals.components += 1;
      const vdData = diskCount * diskEach * (diskCount > 2 ? (diskCount - 1) / diskCount : 1);
      compStmt.run(omeId, deviceId, 'vdisk', 'Virtual Disk 0', diskCount > 2 ? 'RAID 5' : 'RAID 1', 'ok',
        null, null, '0', vdData, diskCount > 2 ? 'RAID 5' : 'RAID 1',
        JSON.stringify({ controller: 'PERC H755 Front', state: 'Online', writePolicy: 'Write Back' }));
      totals.components += 1;
      compStmt.run(omeId, deviceId, 'nic', `NIC.Integrated.1`, `Broadcom Adv. Dual 25Gb Ethernet`, 'ok',
        null, null, null, null, null,
        JSON.stringify({ vendor: 'Broadcom', ports: [{ portId: 'NIC.Integrated.1-1', linkStatus: 'Up', linkSpeed: '25 Gbps', macs: ['B4:96:91:AA:00:01'] }, { portId: 'NIC.Integrated.1-2', linkStatus: 'Up', linkSpeed: '25 Gbps', macs: ['B4:96:91:AA:00:02'] }] }));
      const badPsu = health === 'critical' && badDisk < 0;
      for (let p = 0; p < 2; p++) {
        compStmt.run(omeId, deviceId, 'psu', `PSU.Slot.${p + 1}`, 'Dell 1400W MM HLAC',
          badPsu && p === 1 ? 'critical' : 'ok', 'D1U54P-W-1400-12-HB4DC', `P${randInt(rng, 10000000, 99999999)}`,
          `PSU ${p + 1}`, null, '1400 W', JSON.stringify({ firmware: '00.1B.53' }));
        totals.components += 1;
      }
      compStmt.run(omeId, deviceId, 'os', pick(rng, ['VMware ESXi 8.0.2', 'VMware ESXi 8.0.1', 'Windows Server 2022', 'Ubuntu 22.04.4 LTS']),
        null, null, null, null, null, null, null, JSON.stringify({ hostname: name.split('.')[0] }));
      totals.components += 2; // nic + os

      // Warranty: current gen far out, aging inside the window, EOL expired.
      const daysLeft = m.gen === 'current' ? randInt(rng, 300, 1200) : m.gen === 'aging' ? randInt(rng, 5, 85) : randInt(rng, -200, -5);
      const end = new Date(Date.now() + daysLeft * 86400000);
      const start = new Date(end.getTime() - 5 * 365 * 86400000);
      warStmt.run(omeId, deviceId, tag, m.model, 'Server', pick(rng, SVC_LEVELS),
        start.toISOString().slice(0, 10), end.toISOString().slice(0, 10), daysLeft);
      totals.warranties += 1;

      // Multiple agreements: about half the expired/expiring tags carry an
      // ACTIVE ProSupport renewal on top of the lapsed base warranty — the tag
      // must classify by its best contract, not the worst.
      if (daysLeft <= 85 && chance(rng, 0.5)) {
        const renewDays = randInt(rng, 150, 700);
        const rEnd = new Date(Date.now() + renewDays * 86400000);
        const rStart = new Date(rEnd.getTime() - 2 * 365 * 86400000);
        warStmt.run(omeId, deviceId, tag, m.model, 'Server', 'ProSupport Plus Renewal',
          rStart.toISOString().slice(0, 10), rEnd.toISOString().slice(0, 10), renewDays);
        totals.warranties += 1;
      }

      // Firmware baseline: aging/EOL gear drifts more.
      const drifted = m.gen === 'current' ? chance(rng, 0.08) : chance(rng, 0.45);
      fwStmt.run(omeId, 1, `${inst.name} Production Baseline`, deviceId, tag, m.model,
        drifted ? 'noncompliant' : 'compliant', drifted ? randInt(rng, 1, 6) : 0);
      totals.firmware += 1;
    }

    // Chassis + switches round out the device-type mix.
    for (let c = 0; c < 2; c++) {
      const deviceId = deviceIdSeq++;
      devStmt.run(omeId, deviceId, svcTag(rng), `${inst.name.split(' ')[0].toLowerCase()}-mx7000-${c + 1}`, 'PowerEdge MX7000', 'Chassis',
        null, 'ok', 1000, 'on', 1, 'Managed', null,
        `10.${inst.name.includes('DC1') ? 40 : 41}.0.${20 + c}`, null,
        null, null, null, null, null, null, null, null, nowIso);
      totals.devices += 1;
    }

    // Alerts over the last 14 days, weighted info < warning < critical.
    const alertRng = rngFor(`${inst.name}-alerts`);
    const serverNames = db.prepare('SELECT name, service_tag FROM dell_devices WHERE ome_id = ? AND device_type = ?').all(omeId, 'Server');
    const alertCount = randInt(alertRng, 60, 110);
    for (let a = 0; a < alertCount; a++) {
      const t = pick(alertRng, ALERT_TEMPLATES.filter((x) => randFloat(alertRng, 0, 1) > (x.severity === 'critical' ? 0.55 : x.severity === 'warning' ? 0.3 : 0))) || ALERT_TEMPLATES[5];
      const dev = pick(alertRng, serverNames);
      const minutesAgo = randInt(alertRng, 5, 14 * 24 * 60);
      alertStmt.run(omeId, alertIdSeq++, t.severity, chance(alertRng, 0.35) ? 'acknowledged' : 'not-acknowledged',
        t.category, t.subcategory, t.msg(dev.name, alertRng), dev.name, dev.service_tag,
        new Date(Date.now() - minutesAgo * 60000).toISOString().replace('T', ' ').slice(0, 19));
      totals.alerts += 1;
    }

    // 30 days of daily snapshots trending slightly upward.
    const histRng = rngFor(`${inst.name}-history`);
    const devTotal = inst.servers + 2;
    for (let day = 30; day >= 0; day--) {
      const crit = randInt(histRng, 0, 3);
      const warn = randInt(histRng, 2, 7);
      histStmt.run(omeId, `-${day} days`, devTotal, devTotal - crit - warn, warn, crit,
        devTotal - randInt(histRng, 2, 5), inst.servers, randInt(histRng, 0, 6),
        inst.powerManager ? randInt(histRng, inst.servers * 250, inst.servers * 420) : null);
    }
  }

  return totals;
}

module.exports = { seedDell };
