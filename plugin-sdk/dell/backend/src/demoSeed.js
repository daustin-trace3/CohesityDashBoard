// Dell OpenManage Enterprise demo data: two OME appliances managing a
// PowerEdge fleet with realistic model mix, per-server component inventory
// (CPU/DIMM/disk/NIC/PSU/OS with a few failing parts), alerts, warranty
// runway (some expiring/expired), firmware baseline drift, configuration
// governance (baselines/compliance/drift history), OME jobs, configuration
// profiles, per-device iDRAC hardware logs, Power Manager metrics on one
// site only (the other shows the "plugin not installed" experience), and 30
// days of metrics history.
//
// Ported from backend/demo/generators/dell.js. ALL inserts here run ONLY
// behind the DASHBOARD_DEMO==='1' gate — see seedDellDemo() below, called
// from poller.js's manifest createPoller(coreApi) entry point on every boot
// in demo mode. Only the seeded-random helpers were copied from the host's
// demo/generators/core.js (./demoRng.js) — no seedCore/encryption requires.
// Credential encryption uses coreApi.encryption.encrypt (nutanix/unifi
// plugin demoSeed.js precedent) instead of requiring the host's encryption
// service directly.
//
// DEVIATION FROM THE BUILT-IN's wipe strategy: dell_ome_instances itself is
// NEVER wiped/deleted (it is the user-facing connection table — an admin
// could register a real OME appliance on a demo instance and that must
// survive a reseed). Instead the two fixture instances are upserted by name
// so their id stays stable across boots, and only THEIR dependent rows
// (dell_devices/components/alerts/... scoped by ome_id) are wiped before
// reseeding, children before parents — any independently-registered real
// instance's data is untouched.
const { randInt, randFloat, pick, chance, rngFor } = require('./demoRng');

const MODELS = [
  { model: 'PowerEdge R650', sockets: 2, coresPer: 24, memGb: 512, gen: 'current' },
  { model: 'PowerEdge R750', sockets: 2, coresPer: 28, memGb: 768, gen: 'current' },
  { model: 'PowerEdge R660', sockets: 2, coresPer: 32, memGb: 1024, gen: 'current' },
  { model: 'PowerEdge R640', sockets: 2, coresPer: 20, memGb: 384, gen: 'aging' },
  { model: 'PowerEdge R740xd', sockets: 2, coresPer: 22, memGb: 512, gen: 'aging' },
  { model: 'PowerEdge R630', sockets: 2, coresPer: 14, memGb: 256, gen: 'eol' },
];

const ALERT_TEMPLATES = [
  { severity: 'critical', category: 'System Health', subcategory: 'Storage', msgId: 'PDR16', msg: (d, rng) => `Fault detected on physical disk in slot ${randInt(rng, 0, 11)} of ${d}` },
  { severity: 'critical', category: 'System Health', subcategory: 'Power', msgId: 'PSU0076', msg: (d) => `Power supply redundancy is lost on ${d}` },
  { severity: 'warning', category: 'System Health', subcategory: 'Temperature', msgId: 'TMP0120', msg: (d) => `System inlet temperature is above the warning threshold on ${d}` },
  { severity: 'warning', category: 'System Health', subcategory: 'Memory', msgId: 'MEM0701', msg: (d, rng) => `Correctable memory error rate exceeded on DIMM ${pick(rng, ['A1', 'A5', 'B2', 'B7'])} of ${d}` },
  { severity: 'warning', category: 'Configuration', subcategory: 'Firmware', msgId: 'CDEV4004', msg: (d) => `Firmware on ${d} does not match the assigned baseline` },
  { severity: 'info', category: 'Audit', subcategory: 'Devices', msgId: 'CDEV6130', msg: (d) => `Inventory refresh completed for ${d}` },
  { severity: 'info', category: 'Configuration', subcategory: 'Discovery', msgId: 'CDIS0002', msg: (d) => `Discovery task found device ${d}` },
];

const SVC_LEVELS = ['ProSupport Plus with Next Business Day Onsite', 'ProSupport with Next Business Day Onsite', 'Basic Hardware Warranty'];

// Attribute drift shapes for non-compliant config devices (BIOS/iDRAC settings
// that commonly drift from a golden template).
const DRIFT_TEMPLATES = [
  { group: 'BIOS > System Profile Settings', attribute: 'SysProfile', expected: 'PerfOptimized', currents: ['PerfPerWattOptimizedDapc', 'Custom'] },
  { group: 'BIOS > System Security', attribute: 'AcPwrRcvry', expected: 'Last', currents: ['On', 'Off'] },
  { group: 'BIOS > Integrated Devices', attribute: 'SriovGlobalEnable', expected: 'Enabled', currents: ['Disabled'] },
  { group: 'iDRAC > NIC Information', attribute: 'NIC.1#DNSRacName', expected: null, currents: ['idrac-old-name'] },
  { group: 'iDRAC > Users > User 2', attribute: 'Users.2#IpmiLanPrivilege', expected: 'Administrator', currents: ['Operator', 'No Access'] },
  { group: 'iDRAC > Web Server', attribute: 'WebServer.1#SSLEncryptionBitLength', expected: '256-Bit or higher', currents: ['128-Bit or higher'] },
  { group: 'BIOS > Boot Settings', attribute: 'BootMode', expected: 'Uefi', currents: ['Bios'] },
  { group: 'BIOS > Processor Settings', attribute: 'LogicalProc', expected: 'Enabled', currents: ['Disabled'] },
];

// iDRAC Lifecycle-log style entries for the Hardware Logs feed.
const HWLOG_TEMPLATES = [
  { severity: 'info', category: 'Audit', msgId: 'USR0030', msg: (d, rng) => `Successfully logged in using root, from 10.${randInt(rng, 30, 45)}.${randInt(rng, 1, 8)}.${randInt(rng, 10, 250)} and REDFISH.` },
  { severity: 'info', category: 'Audit', msgId: 'USR0032', msg: () => 'The session for root from 10.40.2.15 using GUI is logged off.' },
  { severity: 'info', category: 'Configuration', msgId: 'RAC0703', msg: () => 'Requested system hardware inventory update.' },
  { severity: 'info', category: 'Updates', msgId: 'JCP027', msg: () => 'The (installed version: 7.00.60.00, available version: 7.10.30.00) iDRAC firmware update job is scheduled.' },
  { severity: 'warning', category: 'System Health', msgId: 'TMP0120', msg: () => 'The system inlet temperature is greater than the upper warning threshold.' },
  { severity: 'warning', category: 'Storage', msgId: 'PDR63', msg: (d, rng) => `Predictive failure reported for Disk ${randInt(rng, 0, 11)} in Backplane 1 of Integrated RAID Controller 1.` },
  { severity: 'warning', category: 'System Health', msgId: 'MEM0701', msg: (d, rng) => `Correctable memory error rate exceeded for DIMM_${pick(rng, ['A1', 'A5', 'B2', 'B7'])}.` },
  { severity: 'critical', category: 'Storage', msgId: 'PDR16', msg: (d, rng) => `Drive ${randInt(rng, 0, 11)} in Backplane 1 of Integrated RAID Controller 1 has failed.` },
  { severity: 'critical', category: 'System Health', msgId: 'PSU0076', msg: (d, rng) => `Power supply redundancy is lost: PSU ${randInt(rng, 1, 2)} failed.` },
  { severity: 'critical', category: 'System Health', msgId: 'VLT0304', msg: () => 'The system board 3.3V PG voltage is outside of range.' },
];

const JOB_TEMPLATES = [
  { name: 'Default Inventory Task', type: 'Inventory_Task', schedule: '0 0/30 * 1/1 * ? *', builtin: 1 },
  { name: 'Global Health Task', type: 'Health_Task', schedule: '0 0 0/1 1/1 * ? *', builtin: 1 },
  { name: 'Default Console Update Execution Task', type: 'ConsoleUpdateExecution_Task', schedule: '0 0 22 ? * sun *', builtin: 1 },
  { name: 'Discovery-2024-Server-Range', type: 'Discovery_Task', schedule: '0 0 6 1/1 * ? *', builtin: 0 },
  { name: 'Firmware Update — Prod Baseline wave 2', type: 'Update_Task', schedule: 'startnow', builtin: 0 },
  { name: 'Deploy Template: ESXi Golden Config', type: 'Device_Config_Task', schedule: 'startnow', builtin: 0 },
  { name: 'Warranty Refresh', type: 'Warranty_Task', schedule: '0 0 5 1/1 * ? *', builtin: 1 },
  { name: 'Monthly Compliance Re-check', type: 'Device_Config_Task', schedule: '0 0 4 1 1/1 ? *', builtin: 0 },
];

const FIXTURE_INSTANCES = [
  { name: 'DC1 OME', host: 'ome-dc1.demo.local', version: '4.2.0', servers: 64, powerManager: true },
  { name: 'DC2 OME', host: 'ome-dc2.demo.local', version: '4.1.1', servers: 38, powerManager: false },
];

// Children->parents, scoped by ome_id — dell_ome_instances itself is NEVER
// wiped (see module header).
const DEMO_CHILD_TABLES = [
  'dell_config_drift_history', 'dell_hardware_logs', 'dell_config_profiles', 'dell_jobs',
  'dell_config_compliance', 'dell_config_baselines', 'dell_metrics_history',
  'dell_firmware_compliance', 'dell_warranties', 'dell_alerts', 'dell_components', 'dell_devices',
];

function seedDell(db, { now, encrypt }) {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES ('platform_dell_enabled', '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run();

  const nowIso = new Date(now).toISOString();

  // Upsert the two fixture instances by name so their id stays stable across
  // reseeds (dell_ome_instances is never deleted — see module header).
  const upsertInstance = db.prepare(`
    INSERT INTO dell_ome_instances (name, host, username, encrypted_credentials, ssl_verify,
      polling_interval_minutes, version, last_poll_status, last_poll_error, last_poll_at)
    VALUES (?, ?, ?, ?, 0, 15, ?, ?, ?, datetime('now', ?))
    ON CONFLICT(name) DO UPDATE SET
      host = excluded.host, encrypted_credentials = excluded.encrypted_credentials,
      version = excluded.version, last_poll_status = excluded.last_poll_status,
      last_poll_error = excluded.last_poll_error, last_poll_at = excluded.last_poll_at,
      updated_at = datetime('now')
  `);
  const getInstanceId = db.prepare('SELECT id FROM dell_ome_instances WHERE name = ?');

  const instances = FIXTURE_INSTANCES.map((inst) => {
    const rng = rngFor(inst.name);
    upsertInstance.run(inst.name, inst.host, 'demo-viewer',
      encrypt(JSON.stringify({ password: 'demo-not-real' })), inst.version,
      'success', null, `-${randInt(rng, 1, 12)} minutes`);
    const omeId = getInstanceId.get(inst.name).id;
    return { ...inst, omeId };
  });

  // Wipe THIS fixture's dependent rows only, children before parents — any
  // independently-registered real instance's data is untouched.
  const fixtureIds = instances.map((i) => i.omeId);
  const placeholders = fixtureIds.map(() => '?').join(',');
  for (const table of DEMO_CHILD_TABLES) {
    db.prepare(`DELETE FROM ${table} WHERE ome_id IN (${placeholders})`).run(...fixtureIds);
  }

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
      subcategory, message_id, message, device_name, service_tag, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  const cfgBaselineStmt = db.prepare(`
    INSERT INTO dell_config_baselines (ome_id, baseline_id, name, description, template_id,
      template_name, last_run, compliance_status, n_critical, n_warning, n_normal,
      n_incomplete, task_id, percent_complete)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const cfgComplianceStmt = db.prepare(`
    INSERT INTO dell_config_compliance (ome_id, baseline_id, baseline_name, device_id,
      device_name, service_tag, model, status, inventory_time, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const jobStmt = db.prepare(`
    INSERT INTO dell_jobs (ome_id, job_id, name, description, job_type, internal, state,
      builtin, visible, last_run_status_id, last_run_status, job_status, last_run,
      next_run, start_time, end_time, schedule, created_by, targets)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const profStmt = db.prepare(`
    INSERT INTO dell_config_profiles (ome_id, profile_id, name, description, template_id,
      template_name, target_id, target_name, chassis_name, state, last_run_status_id,
      last_run_status, profile_modified, created_by, created_date, last_deploy_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const hwlogStmt = db.prepare(`
    INSERT OR IGNORE INTO dell_hardware_logs (ome_id, device_id, log_id, seq, severity,
      category, message_id, message, comment, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const driftHistStmt = db.prepare(`
    INSERT INTO dell_config_drift_history (ome_id, baseline_id, device_id, service_tag,
      attr_group, attribute, expected, current, first_seen, last_seen, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL)
  `);
  const driftResolvedStmt = db.prepare(`
    INSERT INTO dell_config_drift_history (ome_id, baseline_id, device_id, service_tag,
      attr_group, attribute, expected, current, first_seen, last_seen, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const svcTag = (rng) => Array.from({ length: 7 }, () => pick(rng, 'ABCDEFGHJKLMNPQRSTVWXYZ0123456789'.split(''))).join('');

  const totals = { instances: 0, devices: 0, components: 0, alerts: 0, warranties: 0, firmware: 0, compliance: 0, jobs: 0, profiles: 0, hwlogs: 0 };
  let deviceIdSeq = 10000;
  let alertIdSeq = 500000;
  let jobIdSeq = 10000;
  let profileIdSeq = 70000;
  let hwlogSeq = 280000;

  for (const inst of instances) {
    const rng = rngFor(inst.name);
    const omeId = inst.omeId;
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
          JSON.stringify({
            mediaType: media, busType: media === 'SSD' ? 'NVMe' : 'SAS',
            predictiveFailure: d === badDisk ? 'Failure predicted' : null,
            // SSD wear feeds the predictive watchlist report — aging gear runs lower.
            endurance: media === 'SSD' ? (m.gen === 'current' ? randInt(rng, 70, 99) : randInt(rng, 8, 75)) : null,
          }));
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
      compStmt.run(omeId, deviceId, 'nic', 'NIC.Integrated.1', 'Broadcom Adv. Dual 25Gb Ethernet', 'ok',
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
        t.category, t.subcategory, t.msgId, t.msg(dev.name, alertRng), dev.name, dev.service_tag,
        new Date(Date.now() - minutesAgo * 60000).toISOString().replace('T', ' ').slice(0, 19));
      totals.alerts += 1;
    }

    // Configuration compliance: one golden-config baseline per instance,
    // every server evaluated, drift concentrated on aging gear (mirrors the
    // console's Configuration > Configuration Compliance page).
    const cfgRng = rngFor(`${inst.name}-compliance`);
    const servers = db.prepare(
      "SELECT device_id, name, service_tag, model FROM dell_devices WHERE ome_id = ? AND device_type = 'Server' ORDER BY device_id"
    ).all(omeId);
    const baselineId = 1;
    const baselineName = `${inst.name.split(' ')[0]} Golden Config`;
    let nBad = 0; let nOk = 0; let nMissing = 0;
    for (const s of servers) {
      const roll = randFloat(cfgRng, 0, 1);
      const status = roll > 0.97 ? 'not_inventoried' : roll > 0.84 ? 'noncompliant' : 'compliant';
      let detail = null;
      if (status === 'noncompliant') {
        nBad += 1;
        const n = randInt(cfgRng, 1, 4);
        const picked = new Set();
        detail = [];
        for (let i = 0; i < n; i++) {
          const t = pick(cfgRng, DRIFT_TEMPLATES);
          if (picked.has(t.attribute)) continue;
          picked.add(t.attribute);
          const current = pick(cfgRng, t.currents);
          detail.push({
            group: t.group, attribute: t.attribute,
            expected: t.expected, current,
            reason: 'Attribute has different value from template',
          });
          // Matching drift-timeline row: "first detected" 1-45 days ago.
          driftHistStmt.run(omeId, baselineId, s.device_id, s.service_tag,
            t.group, t.attribute, t.expected != null ? String(t.expected) : null, String(current),
            new Date(now - randInt(cfgRng, 1, 45) * 86400000 - randInt(cfgRng, 0, 1439) * 60000)
              .toISOString().replace('T', ' ').slice(0, 19));
        }
      } else if (status === 'not_inventoried') { nMissing += 1; } else {
        nOk += 1;
        // Some compliant boxes carry a RESOLVED drift episode — feeds the
        // remediation report's MTTR and open-vs-resolved history.
        if (chance(cfgRng, 0.25)) {
          const t = pick(cfgRng, DRIFT_TEMPLATES);
          const firstMs = now - randInt(cfgRng, 20, 70) * 86400000;
          const resolvedMs = firstMs + randInt(cfgRng, 1, 21) * 86400000;
          const iso = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
          driftResolvedStmt.run(omeId, baselineId, s.device_id, s.service_tag,
            t.group, t.attribute, t.expected != null ? String(t.expected) : null,
            String(pick(cfgRng, t.currents)), iso(firstMs), iso(resolvedMs), iso(resolvedMs));
        }
      }
      cfgComplianceStmt.run(omeId, baselineId, baselineName, s.device_id, s.name,
        s.service_tag, s.model, status,
        status === 'not_inventoried' ? null : new Date(now - randInt(cfgRng, 10, 600) * 60000).toISOString().replace('T', ' ').slice(0, 19),
        detail ? JSON.stringify(detail) : null);
      totals.compliance += 1;
    }
    cfgBaselineStmt.run(omeId, baselineId, baselineName, 'Golden configuration for production PowerEdge fleet',
      12, 'PowerEdge Production Template', new Date(now - randInt(cfgRng, 10, 120) * 60000).toISOString().replace('T', ' ').slice(0, 19),
      nBad > 0 ? 'CRITICAL' : 'OK', nBad, 0, nOk, nMissing, 33764, '100');

    // OME jobs (console Monitor > Jobs). One disabled + one stalled schedule
    // per estate feed the job-health report's problem sections.
    const jobRng = rngFor(`${inst.name}-jobs`);
    JOB_TEMPLATES.forEach((t, ji) => {
      const failed = chance(jobRng, 0.12);
      const disabled = inst.powerManager && ji === 6; // DC1's warranty refresh is switched off
      const stalled = inst.powerManager && ji === 3;  // DC1's discovery has a silently passed next_run
      const lastRunMin = randInt(jobRng, 10, 7 * 24 * 60);
      const lastRun = new Date(now - lastRunMin * 60000).toISOString().replace('T', ' ').slice(0, 19);
      jobStmt.run(omeId, jobIdSeq++, t.name, t.name, t.type, 0, disabled ? 'Disabled' : 'Enabled', t.builtin, 1,
        failed ? 2070 : 2060, failed ? 'Failed' : 'Completed', t.schedule === 'startnow' ? 'Completed' : 'Scheduled',
        lastRun,
        t.schedule === 'startnow' ? null
          : stalled ? new Date(now - randInt(jobRng, 2, 5) * 86400000).toISOString().replace('T', ' ').slice(0, 19)
            : new Date(now + randInt(jobRng, 20, 24 * 60) * 60000).toISOString().replace('T', ' ').slice(0, 19),
        lastRun, new Date(now - (lastRunMin - randInt(jobRng, 1, 8)) * 60000).toISOString().replace('T', ' ').slice(0, 19),
        t.schedule, t.builtin ? 'system' : 'admin',
        t.builtin ? 'All-Devices' : pick(jobRng, ['Prod-Servers', 'DC-Rack-14', 'ESXi-Hosts']));
      totals.jobs += 1;
    });

    // Configuration profiles — DC1 runs template-deployed ESXi hosts; DC2 has none
    // (shows the empty-state experience).
    if (inst.powerManager) {
      const profRng = rngFor(`${inst.name}-profiles`);
      const targets = servers.slice(0, 8);
      for (let p = 0; p < 10; p++) {
        const target = targets[p] || null;
        const created = new Date(now - randInt(profRng, 30, 400) * 86400000).toISOString().replace('T', ' ').slice(0, 19);
        profStmt.run(omeId, profileIdSeq++, `Profile ${String(p + 1).padStart(5, '0')}`,
          'from source template: (ESXi Golden Config)', 8, 'ESXi Golden Config',
          target ? target.device_id : 0, target ? target.name : null, null,
          target ? 'deployed' : 'unassigned',
          target ? 2060 : 2200, target ? 'Completed' : 'NotRun',
          target && chance(profRng, 0.2) ? 1 : 0, 'admin', created,
          target ? new Date(now - randInt(profRng, 1, 30) * 86400000).toISOString().replace('T', ' ').slice(0, 19) : null);
        totals.profiles += 1;
      }
    }

    // Per-server iDRAC hardware (Lifecycle/SEL) logs over the last 90 days —
    // mostly audit/config noise, hardware events on unhealthy gear.
    const hwRng = rngFor(`${inst.name}-hwlogs`);
    for (const s of servers) {
      const entries = randInt(hwRng, 12, 40);
      for (let e = 0; e < entries; e++) {
        const t = pick(hwRng, HWLOG_TEMPLATES.filter((x) =>
          x.severity === 'info' ? true : x.severity === 'warning' ? chance(hwRng, 0.35) : chance(hwRng, 0.12))) || HWLOG_TEMPLATES[0];
        const seq = hwlogSeq++;
        const minutesAgo = randInt(hwRng, 5, 90 * 24 * 60);
        hwlogStmt.run(omeId, s.device_id, `DCIM:LifeCycleLog:${seq}`, seq, t.severity,
          t.category, t.msgId, t.msg(s.name, hwRng), null,
          new Date(now - minutesAgo * 60000).toISOString().replace('T', ' ').slice(0, 19));
        totals.hwlogs += 1;
      }
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

/** Demo-only entry point. Upserts the two fixture instances (id stable
 *  across boots), wipes their dependent rows, and regenerates them with
 *  fresh relative timestamps, so a demo box refreshes on every boot instead
 *  of aging into a stale-looking estate. NEVER runs outside demo mode — see
 *  the DASHBOARD_DEMO gate in poller.js. */
function seedDellDemo(coreApi) {
  const db = coreApi.db;
  return db.transaction(() => seedDell(db, { now: Date.now(), encrypt: coreApi.encryption.encrypt }))();
}

module.exports = { seedDell, seedDellDemo };
