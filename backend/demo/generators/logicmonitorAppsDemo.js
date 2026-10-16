// Demo scenarios for round 11 WP-X (application and appliance families), called from
// generators/logicmonitor.js:
//   appDevices()      device plan entries (appended last, so no earlier id moves)
//   appIdentity(d)    deviceIdentity() fields for the three appliance kinds
//   seedAppsViaLm()   lm_ds_* rows inside seedDsMetrics (reseed-safe: that function clears
//                     the source's lm_ds_* tables first)
//
// Scenarios:
//   phx-sql-01        SQL Server, healthy (existing demo Windows server)
//   phx-sql-02        SQL Server, service down (app-service-down)
//   phx-splunk-idx-01 Splunk indexer, license 62%, queue 35% (clean)
//   phx-emc-unity-01  EMC Unity at 88% (app-capacity-high)
//   phx-esa-01        IronPort / ESA, queue 120, quarantine 41% (clean)
// The DataSource and datapoint names are UNVERIFIED stand-ins for LogicMonitor's standard ones.

const APP_KINDS = {
  'phx-splunk-idx-01': 'app-splunk',
  'phx-emc-unity-01': 'app-emc',
  'phx-esa-01': 'app-ironport',
};

function appDevices() {
  return Object.entries(APP_KINDS).map(([name, kind]) => ({ name, site: 'phx', kind, r8: true }));
}

function appIdentity(d) {
  switch (d.kind) {
    case 'app-splunk':
      return { deviceType: 0, model: 'Splunk Enterprise 9.1', serial: null, sysinfo: `Linux ${d.name} 5.15.0-100-generic #1-Ubuntu SMP x86_64`, sysoid: '.1.3.6.1.4.1.8072.3.2.10', categories: 'snmp,NetSNMP,Linux,Splunk', ert: 'PhysicalServer' };
    case 'app-emc':
      return { deviceType: 0, model: 'Unity 480F', serial: 'APM00210000123', sysinfo: 'EMC Unity 5.3.0', sysoid: '.1.3.6.1.4.1.1139.103', categories: 'snmp,EMCUnity', ert: null };
    case 'app-ironport':
      return { deviceType: 0, model: 'C395', serial: '8A5C2F1D3E4B-1HLQ2Z3', sysinfo: 'Cisco IronPort C395 AsyncOS 14.2', sysoid: '.1.3.6.1.4.1.15497.1.1.1', categories: 'snmp,CiscoESA', ert: null };
    default:
      return null;
  }
}

function seedAppsViaLm(devices, { put, rng, r1, series }) {
  const byName = new Map(devices.map((d) => [d.name, d]));
  const live = (n) => { const d = byName.get(n); return d && d.hostStatus === 'normal' ? d : null; };

  const sql1 = live('phx-sql-01');
  if (sql1) {
    const conns = Math.round(120 + rng() * 60);
    const batch = Math.round(700 + rng() * 300);
    put(sql1, 'Microsoft_SQLServer_Service', 'Microsoft SQL Server Service', 'apps', 'MSSQLSERVER', { sql_state: 1 });
    put(sql1, 'Microsoft_SQLServer_Performance', 'Microsoft SQL Server Performance', 'apps', 'MSSQLSERVER', {
      sql_connections: conns, sql_batch_rate: batch, sql_buffer_hit_pct: r1(98.4 + rng()), sql_blocked: 0,
    }, { sql_connections: series(conns, { amp: 0.3, hi: 1e6 }), sql_batch_rate: series(batch, { amp: 0.35, hi: 1e6 }) });
    put(sql1, 'Microsoft_SQLServer_Databases', 'Microsoft SQL Server Databases', 'apps', 'orders', { sql_db_size: Math.round(86e9 + rng() * 4e9), sql_backup_age_h: 6 });
    put(sql1, 'Microsoft_SQLServer_Databases', 'Microsoft SQL Server Databases', 'apps', 'billing', { sql_db_size: Math.round(41e9 + rng() * 2e9), sql_backup_age_h: 6 });
  }
  const sql2 = live('phx-sql-02');
  if (sql2) {
    put(sql2, 'Microsoft_SQLServer_Service', 'Microsoft SQL Server Service', 'apps', 'MSSQLSERVER', { sql_state: 0 });
    put(sql2, 'Microsoft_SQLServer_Performance', 'Microsoft SQL Server Performance', 'apps', 'MSSQLSERVER', { sql_connections: 0, sql_batch_rate: 0 });
  }

  const splunk = live('phx-splunk-idx-01');
  if (splunk) {
    put(splunk, 'Splunk_Indexer_Throughput', 'Splunk Indexer Throughput', 'apps', 'indexer', { splunk_indexing_rate: Math.round(18000 + rng() * 4000), splunk_search_concurrency: 6 });
    put(splunk, 'Splunk_Queues', 'Splunk Queues', 'apps', 'indexqueue', { splunk_queue_fill_pct: r1(30 + rng() * 10) });
    put(splunk, 'Splunk_License', 'Splunk License', 'apps', 'enterprise', { splunk_license_used_pct: r1(60 + rng() * 4) });
  }

  const emc = live('phx-emc-unity-01');
  if (emc) {
    put(emc, 'EMC_Unity_StoragePools', 'EMC Unity Storage Pools', 'apps', 'Pool_1', { emc_health: 1, emc_cap_used_pct: 88 },
      { emc_cap_used_pct: Array.from({ length: 336 }, (_, i) => r1(86.5 + (i / 335) * 1.5)) });
    put(emc, 'EMC_Unity_Disks', 'EMC Unity Disks', 'apps', 'DAE_0', { emc_disk_faults: 0, emc_temp: r1(31 + rng() * 3) });
  }

  const esa = live('phx-esa-01');
  if (esa) {
    put(esa, 'Cisco_ESA_System', 'Cisco ESA System', 'apps', 'system', {
      esa_queue: Math.round(90 + rng() * 60), esa_cpu_pct: r1(14 + rng() * 10), esa_mem_pct: r1(41 + rng() * 6), esa_msgs_rate: r1(11 + rng() * 6), esa_quarantine_pct: 41,
    });
  }
}

module.exports = { appDevices, appIdentity, seedAppsViaLm, APP_KINDS };
