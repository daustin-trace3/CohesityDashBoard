// Demo scenarios for round 11 WP-V (voice, Zscaler, ISE), called from generators/logicmonitor.js:
//   serviceDevices()      device plan entries (appended last, so no earlier id moves)
//   serviceIdentity(d)    deviceIdentity() fields for the service kinds
//   zsdcChecks()          eight ZSDC_ uptime ping checks, pushed onto the checks plan
//   seedServicesViaLm()   lm_ds_* rows inside seedDsMetrics (reseed-safe: that function clears
//                         the source's lm_ds_* tables first)
//
// Scenarios:
//   phx-sbc-01 healthy, dal-sbc-01 with one fan reading a fault (voice-sbc-degraded)
//   phx-cube-01 quiet SIP, dal-cube-01 with SIP errors above 1 per second (voice-sip-errors)
//   phx-ganc-01 healthy GANC checks (no SSID or RADIUS rows: those DataSources would also
//     make the GANC a wireless controller and change the wireless demo counts)
//   aws-zpa-1 / phx-zpa-1 connectors up (aws at 86% ports), dal-zpa-1 down (zpa-connector-down)
//   phx-zsclr-nss-01, dal-zsclr-nss-01 NSS appliances (CPU, memory, filesystems)
//   phx-ipsn-1, dal-ipsn-1, phx-ipsn-2 ISE nodes, the dal Admin certificate at 12 days (ise-cert-expiring)
//   ZSDC checks across four cities, SIN3 slow from dal (latency anomaly)
// The DataSource and datapoint names are UNVERIFIED stand-ins for the live portal's ntm_* ones.

const KINDS = {
  'phx-sbc-01': ['svc-sbc', 'phx'],
  'dal-sbc-01': ['svc-sbc', 'dal'],
  'phx-cube-01': ['svc-cube', 'phx'],
  'dal-cube-01': ['svc-cube', 'dal'],
  'phx-ganc-01': ['svc-ganc', 'phx'],
  'aws-zpa-1': ['svc-zpa', 'aws'],
  'phx-zpa-1': ['svc-zpa', 'phx'],
  'dal-zpa-1': ['svc-zpa', 'dal'],
  'phx-zsclr-nss-01': ['svc-nss', 'phx'],
  'dal-zsclr-nss-01': ['svc-nss', 'dal'],
  'phx-ipsn-1': ['svc-ise', 'phx'],
  'dal-ipsn-1': ['svc-ise', 'dal'],
  'phx-ipsn-2': ['svc-ise', 'phx'],
};

function serviceDevices() {
  return Object.entries(KINDS).map(([name, [kind, site]]) => ({ name, site, kind, r8: true }));
}

function serviceIdentity(d, rng) {
  const n = Math.floor((typeof rng === 'function' ? rng() : 0.5) * 9000) + 1000;
  const linux = (extra) => ({
    deviceType: 0, model: 'VMware Virtual Platform', serial: null,
    sysinfo: `Linux ${d.name} 5.15.0-100-generic #1-Ubuntu SMP x86_64${extra || ''}`, sysoid: '.1.3.6.1.4.1.8072.3.2.10',
    categories: 'snmp,NetSNMP,Linux', ert: 'VirtualMachine',
  });
  switch (d.kind) {
    case 'svc-sbc':
      return {
        deviceType: 0, model: 'Oracle Acme Packet 4600', serial: `ACME${n}`,
        sysinfo: 'Oracle Communications Session Border Controller 4600 SCZ9.1.0', sysoid: '.1.3.6.1.4.1.9148.1.2', categories: 'snmp,AcmePacket', ert: null,
      };
    case 'svc-cube':
      return {
        deviceType: 0, model: 'ISR4451-X/K9', serial: `FOC${n}CUBE`,
        sysinfo: 'Cisco IOS Software [Cupertino], ISR Software (X86_64_LINUX_IOSD-UNIVERSALK9-M), Version 17.9.4a, RELEASE SOFTWARE (fc3)',
        sysoid: '.1.3.6.1.4.1.9.1.1861', categories: 'snmp,Cisco,CiscoCPU,CiscoCUBE', ert: 'Router',
      };
    case 'svc-ganc':
      return { ...linux(''), model: 'Cisco GANC', categories: 'snmp,NetSNMP,Linux,GANC' };
    case 'svc-zpa':
      return { ...linux(' zpa-connector'), model: 'Zscaler ZPA App Connector' };
    case 'svc-nss':
      return { ...linux(' ZscalerOS 6.2'), model: 'Zscaler NSS' };
    case 'svc-ise':
      return {
        deviceType: 0, model: 'Cisco ISE-VM-K9', serial: null,
        sysinfo: `Linux ${d.name} Cisco Identity Services Engine 3.2 x86_64`, sysoid: '.1.3.6.1.4.1.8072.3.2.10', categories: 'snmp,NetSNMP,Linux', ert: 'VirtualMachine',
      };
    default:
      return null;
  }
}

/** ZSDC_ uptime ping checks. wid 130..137 do not collide with the main plan (101..118). */
function zsdcChecks() {
  const CITY = [
    [130, 'SJC1', 'San Jose', 'sjc1', { phx: 34, dal: 46 }],
    [131, 'SJC3', 'San Jose', 'sjc3', { phx: 36, dal: 47 }],
    [132, 'AMS3', 'Amsterdam', 'ams3', { phx: 108, dal: 96 }],
    [133, 'AMS2', 'Amsterdam', 'ams2', { phx: 110, dal: 98 }],
    [134, 'LHR4', 'London', 'lhr4', { phx: 118, dal: 104 }],
    [135, 'LHR2', 'London', 'lhr2', { phx: 120, dal: 106 }],
    [136, 'SIN2', 'Singapore', 'sin2', { phx: 176, dal: 190 }],
    [137, 'SIN3', 'Singapore', 'sin3', { phx: 178, dal: 192 }],
  ];
  return CITY.map(([wid, code, city, host, base]) => ({
    wid, kind: 'ping', name: `ZSDC_${code}-${city}-uptime`, target: `${host}.sme.zscaler.net`, locs: ['phx', 'dal'],
    days: code === 'SIN3' ? 30 : 2, base,
    ...(code === 'SIN3' ? { latencyAt: 'dal' } : {}),
  }));
}

function prng(seed) {
  let a = 0;
  for (let i = 0; i < seed.length; i += 1) a = (a * 31 + seed.charCodeAt(i)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedServicesViaLm(devices, { put, r1, series, steps = 336, stepSec = 1800 }) {
  const rng = prng('logicmonitor-services-r11');
  const byName = new Map(devices.map((d) => [d.name, d]));
  const live = (n) => { const d = byName.get(n); return d && d.hostStatus === 'normal' ? d : null; };
  // Monotonic counter ending near cur, growing about `per` each step.
  const counter = (cur, per) => {
    const out = new Array(steps);
    let v = cur;
    for (let i = steps - 1; i >= 0; i -= 1) {
      out[i] = Math.max(0, Math.round(v));
      v -= per * (0.85 + 0.3 * rng());
    }
    return out;
  };

  // ---- Oracle SBCs -------------------------------------------------------------------------
  for (const name of ['phx-sbc-01', 'dal-sbc-01']) {
    const d = live(name);
    if (!d) continue;
    const cpu = r1(22 + rng() * 14);
    const mem = r1(41 + rng() * 10);
    put(d, 'ntm_sbc_system_health', 'SBC system health', 'voice', 'system', { sbc_health_state: 1 });
    put(d, 'ntm_sbc_cpu_utilization', 'SBC CPU utilization', 'voice', 'cpu', { sbc_cpu_pct: cpu }, { sbc_cpu_pct: series(cpu, { amp: 0.25 }) });
    put(d, 'ntm_sbc_memory_utilization', 'SBC memory utilization', 'voice', 'memory', { sbc_mem_pct: mem }, { sbc_mem_pct: series(mem, { amp: 0.04, jitter: 0.01 }) });
    for (let f = 1; f <= 4; f += 1) {
      const bad = name === 'dal-sbc-01' && f === 3;
      put(d, 'ntm_sbc_fan_state', 'SBC fan state', 'voice', `fan${f}`, { sbc_fan_state: bad ? 5 : 2 }, null, `Fan ${f}`);
    }
    for (let p = 1; p <= 2; p += 1) put(d, 'ntm_sbc_power_supply_state', 'SBC power supply state', 'voice', `psu${p}`, { sbc_psu_state: 2 }, null, `Power supply ${p}`);
    for (let t = 1; t <= 6; t += 1) put(d, 'ntm_sbc_temperature', 'SBC temperature', 'voice', `sensor${t}`, { sbc_temp_c: r1(34 + t * 2 + rng() * 3) }, null, `Sensor ${t}`);
    ['trunk-carrier-a', 'trunk-carrier-b', 'trunk-internal'].forEach((pool, i) => put(d, 'ntm_sbc_steering_pool_performance', 'SBC steering pool performance', 'voice', pool, {
      sbc_pool_util_pct: r1(28 + i * 14 + rng() * 6), sbc_pool_sessions: Math.round(120 + i * 90 + rng() * 40), sbc_pool_failures: Math.round(400 + rng() * 300),
    }));
    put(d, 'ntm_sbc_retransmissions_check', 'SBC retransmissions', 'voice', 'sip', { sbc_retransmissions: Math.round(900 + rng() * 400) });
    put(d, 'ntm_sbc_local_connection', 'SBC local connection', 'voice', 'peer', { sbc_local_connection_state: 1 });
  }

  // ---- CUBE routers --------------------------------------------------------------------------
  const cubeCfg = { 'phx-cube-01': { server: 0.04, client: 0.12 }, 'dal-cube-01': { server: 2.2, client: 0.4 } };
  for (const [name, cfg] of Object.entries(cubeCfg)) {
    const d = live(name);
    if (!d) continue;
    put(d, 'Cisco_SIP_Connections', 'Cisco SIP connections', 'voice', 'sip', { sip_active_tcp: Math.round(14 + rng() * 8), sip_active_udp: Math.round(60 + rng() * 25) });
    const sPer = Math.round(cfg.server * stepSec / 3);
    put(d, 'Cisco_SIP_Server_Errors', 'Cisco SIP server errors', 'voice', 'sip', {
      sip_server_int_error: 410000, sip_server_unavailable: 232000, sip_server_gw_timeout: 91000,
    }, {
      sip_server_int_error: counter(410000, sPer), sip_server_unavailable: counter(232000, sPer), sip_server_gw_timeout: counter(91000, sPer),
    });
    const cPer = Math.round(cfg.client * stepSec / 3);
    put(d, 'Cisco_SIP_Client_Errors', 'Cisco SIP client errors', 'voice', 'sip', {
      sip_client_bad_request: 52000, sip_client_unauthorized: 118000, sip_client_not_found: 74000,
    }, {
      sip_client_bad_request: counter(52000, cPer), sip_client_unauthorized: counter(118000, cPer), sip_client_not_found: counter(74000, cPer),
    });
    put(d, 'Cisco_SIP_Retries', 'Cisco SIP retries', 'voice', 'sip', { sip_retry_invites: Math.round(8000 + rng() * 2000), sip_retry_registers: Math.round(3000 + rng() * 800) });
    if (name === 'phx-cube-01') put(d, 'ISDN_Channels', 'ISDN channels', 'voice', 'PRI 0/1/0', { isdn_busy: 6 });
  }

  // ---- GANC ------------------------------------------------------------------------------------
  const ganc = live('phx-ganc-01');
  if (ganc) {
    put(ganc, 'ntm_ganc_mobility_domain_check', 'GANC mobility domain', 'voice', 'domain', { ganc_mobility_state: 0 });
    put(ganc, 'ntm_ganc_ise_radius_check', 'GANC ISE RADIUS check', 'voice', 'radius', { ganc_radius_state: 0 });
  }

  // ---- Zscaler ZPA connectors and NSS ----------------------------------------------------------
  const zpa = { 'aws-zpa-1': { state: 1, ports: 86 }, 'phx-zpa-1': { state: 1, ports: 34 }, 'dal-zpa-1': { state: 0, ports: 12 } };
  for (const [name, cfg] of Object.entries(zpa)) {
    const d = live(name);
    if (!d) continue;
    put(d, 'ntm_zpa_app_connector', 'ZPA app connector', 'security', 'connector', { connector_state: cfg.state });
    put(d, 'Zscaler ZPA Port Exhaustion', 'Zscaler ZPA Port Exhaustion', 'security', 'ports', { port_used_pct: cfg.ports });
    put(d, 'ntm_zpa_ntp_time_sync', 'ZPA NTP time sync', 'security', 'ntp', { ntp_offset: r1((rng() - 0.5) * 0.04), ntp_state: 1 });
    const cpu = r1(8 + rng() * 18);
    put(d, 'NetSNMPCPUwithCores', 'NetSNMP CPU with cores', 'health', 'cpu', { cpu_pct: cpu });
    put(d, 'NetSNMP_Memory_Usage', 'NetSNMP memory usage', 'health', 'memory', { mem_pct: r1(36 + rng() * 14) });
  }
  for (const name of ['phx-zsclr-nss-01', 'dal-zsclr-nss-01']) {
    const d = live(name);
    if (!d) continue;
    const cpu = r1(24 + rng() * 20);
    put(d, 'NetSNMPCPUwithCores', 'NetSNMP CPU with cores', 'health', 'cpu', { cpu_pct: cpu }, { cpu_pct: series(cpu, { amp: 0.2 }) });
    put(d, 'NetSNMP_Memory_Usage', 'NetSNMP memory usage', 'health', 'memory', { mem_pct: r1(52 + rng() * 16) });
    for (const [fs, base] of [['/', 41], ['/var', 63], ['/nss/logs', 71]]) {
      put(d, 'SNMP_Filesystem_Usage', 'SNMP filesystem usage', 'os', fs, { fs_used_pct: r1(base + rng() * 4) });
    }
  }

  // ---- Cisco ISE ---------------------------------------------------------------------------------
  for (const name of ['phx-ipsn-1', 'dal-ipsn-1', 'phx-ipsn-2']) {
    const d = live(name);
    if (!d) continue;
    const sessions = Math.round(900 + rng() * 2400);
    const cpu = r1(16 + rng() * 18);
    const mem = r1(58 + rng() * 14);
    put(d, 'Cisco_ISE_ServerSessions', 'Cisco ISE server sessions', 'security', 'sessions', { sessions }, { sessions: series(sessions, { amp: 0.35, hi: 1e6 }).map((v) => Math.round(v)) });
    for (const [disk, base] of [['/', 33], ['/opt', 47], ['/localdisk', 58]]) {
      put(d, 'Cisco_ISE_Disk', 'Cisco ISE disk', 'security', disk, { disk_used_pct: r1(base + rng() * 5) });
    }
    put(d, 'ntm_ise_application_and_certificate_status', 'ISE application and certificate status', 'security', 'application', { app_state: 1 }, null, 'ISE application');
    put(d, 'ntm_ise_application_and_certificate_status', 'ISE application and certificate status', 'security', 'admin-cert', { cert_days: name === 'dal-ipsn-1' ? 12 : 180 + Math.round(rng() * 120) }, null, 'Admin certificate');
    put(d, 'ntm_cisco_ise_eap_certificate', 'ISE EAP certificate', 'security', 'eap-cert', { eap_cert_days: 300 + Math.round(rng() * 60) }, null, 'EAP authentication certificate');
    put(d, 'ntm_deployment_nodes_status', 'ISE deployment nodes', 'security', name, { node_state: 1 }, null, name);
    put(d, 'ntm_cisco_ise_memory_cpu', 'ISE memory and CPU', 'security', 'system', { cpu_pct: cpu, mem_pct: mem }, { cpu_pct: series(cpu, { amp: 0.25 }), mem_pct: series(mem, { amp: 0.04, jitter: 0.01 }) });
  }
}

module.exports = { serviceDevices, serviceIdentity, zsdcChecks, seedServicesViaLm };
