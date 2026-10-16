// Demo scenarios for round 11 WP-S (servers via LogicMonitor), called from
// generators/logicmonitor.js:
//   serverDevices(db)  device plan entries: six Linux and six Windows guests picked from the demo's
//                      own vCenter VMs (so Server 360, the VM popup and App Services resolve them
//                      by name and address). Appended last, so no earlier device id moves.
//   seedServersViaLm() lm_ds_* rows inside seedDsMetrics (reseed-safe: that function clears the
//                      source's lm_ds_* tables first).
//
// Scenarios (by position in each list of six):
//   linux 1  /data at 89 percent                    server-filesystem-full warning
//   linux 2  /var at 97 percent                     server-filesystem-full critical
//   linux 4  NFS mount /mnt/backup down             server-nfs-mount-down
//   linux 1  also carries /dev/shm at 100 percent   proves the pseudo filesystem skip
//   windows 1 C: at 88 percent                      server-filesystem-full warning
//   windows 3 service W32Time stopped               server-service-stopped
// The DataSource and datapoint names are UNVERIFIED stand-ins for LogicMonitor's standard ones.

function serverDevices(db) {
  let rows = [];
  try {
    // Usage-id tagged VMs first (so an App Services board can show the LogicMonitor hint), then
    // highest names first, so the picks rarely collide with another scenario that takes the first VMs.
    rows = db.prepare(`
      SELECT name, ip_address, guest_os, tags FROM vcenter_vms
      WHERE power_state = 'POWERED_ON' AND ip_address IS NOT NULL AND guest_os IS NOT NULL
      ORDER BY (CASE WHEN tags LIKE '%usage-id%' THEN 0 ELSE 1 END), name DESC
    `).all();
  } catch { rows = []; }
  const win = rows.filter((r) => /windows/i.test(r.guest_os)).slice(0, 6);
  const lin = rows.filter((r) => !/windows/i.test(r.guest_os)).slice(0, 6);
  const mk = (r, kind) => ({ name: r.name, site: 'phx', kind, r8: true, collectorId: 11, fixedIp: r.ip_address });
  return [...lin.map((r) => mk(r, 'linux-vm')), ...win.map((r) => mk(r, 'win-vm'))];
}

function seedServersViaLm(devices, { put, rng, r1, series }) {
  const lin = devices.filter((d) => d.kind === 'linux-vm' && d.hostStatus === 'normal');
  const win = devices.filter((d) => d.kind === 'win-vm' && d.hostStatus === 'normal');
  const GB = 1024 ** 3;
  const flat = (v) => series(v, { amp: 0.01, jitter: 0.004 });

  lin.forEach((d, n) => {
    const cpu = r1(8 + rng() * 30);
    const mem = r1(40 + rng() * 35);
    put(d, 'NetSNMPCPUwithCores', 'Net-SNMP CPU with Cores', 'health', 'cpu', { cpu_pct: cpu }, { cpu_pct: series(cpu, { amp: 0.3 }) });
    put(d, 'NetSNMP_Memory_Usage', 'Net-SNMP Memory Usage', 'health', 'memory', { mem_pct: mem }, { mem_pct: series(mem, { amp: 0.05, jitter: 0.01 }) });
    put(d, 'SNMP_Host_Uptime', 'SNMP Host Uptime', 'health', 'uptime', { uptime_s: Math.round(86400 * (6 + rng() * 140)) });
    put(d, 'HostStatus', 'Host Status', 'os', 'HostStatus', { host_status: 1 });
    const fs = [
      ['/', r1(30 + rng() * 25), 60],
      ['/var', n === 1 ? 97 : r1(35 + rng() * 25), 100],
      ['/data', n === 0 ? 89 : r1(40 + rng() * 25), 500],
    ];
    if (n === 0) fs.push(['/dev/shm', 100, 8]);
    for (const [mount, usedPct, totalGb] of fs) {
      const total = totalGb * GB;
      const used = Math.round(total * (usedPct / 100));
      put(d, 'SNMP_Filesystem_Usage', 'SNMP Filesystem Usage', 'health', mount, {
        fs_used_pct: usedPct, fs_used_bytes: used, fs_total_bytes: total, fs_free_bytes: total - used,
      }, mount === '/dev/shm' ? null : { fs_used_pct: flat(usedPct) });
      put(d, 'SNMP_Filesystem_Status', 'SNMP Filesystem Status', 'os', mount, { fs_status: 1 });
    }
    put(d, 'NetSNMPdiskIO-', 'Net-SNMP Disk I/O', 'os', 'sda', {
      disk_read_bps: Math.round(2e5 + rng() * 4e6), disk_write_bps: Math.round(5e5 + rng() * 9e6), disk_busy_pct: r1(2 + rng() * 14),
    });
    if (n <= 3) put(d, 'snmpHR_NFSMount-', 'NFS Mounts', 'os', '/mnt/backup', { nfs_mount_state: n === 3 ? 0 : 1 });
  });

  win.forEach((d, n) => {
    const cpu = r1(10 + rng() * 35);
    const mem = r1(45 + rng() * 35);
    put(d, 'WinCPU', 'Windows CPU', 'os', 'cpu', { cpu_pct: cpu }, { cpu_pct: series(cpu, { amp: 0.3 }) });
    put(d, 'WinMemory', 'Windows Memory', 'os', 'memory', { mem_pct: mem }, { mem_pct: series(mem, { amp: 0.05, jitter: 0.01 }) });
    put(d, 'WinSystemUptime', 'Windows System Uptime', 'os', 'uptime', { uptime_s: Math.round(86400 * (3 + rng() * 60)) });
    for (const [vol, usedPct, totalGb] of [['C:\\', n === 0 ? 88 : r1(42 + rng() * 25), 120], ['D:\\', r1(30 + rng() * 40), 500]]) {
      put(d, 'WinVolumeUsage-', 'Windows Volume Usage', 'os', vol, {
        vol_used_pct: usedPct, vol_free_bytes: Math.round(totalGb * GB * (1 - usedPct / 100)),
      }, { vol_used_pct: flat(usedPct) });
    }
    for (const svc of ['W3SVC', 'Spooler', 'W32Time', 'WinRM']) {
      put(d, 'WinServices-', 'Windows Services', 'os', svc, { svc_state: svc === 'W32Time' && n === 2 ? 1 : 4 });
    }
    put(d, 'WinProcessStats-', 'Windows Process Stats', 'os', 'svchost', { proc_count: Math.round(14 + rng() * 6) });
    put(d, 'WinEventLog-', 'Windows Event Log', 'os', 'System', { events: Math.round(rng() * 12) });
  });
}

module.exports = { serverDevices, seedServersViaLm };
