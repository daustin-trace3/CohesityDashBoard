// LogicMonitor DataSource catalog (round 8). One entry per DataSource (or
// family of DataSources) the metrics collector knows how to read. Datapoint
// names are NOT verified against a live portal: every metric `match` is a
// case-insensitive regex with alternatives (or an array of regexes in priority
// order), the collector records which raw datapoint matched, and the pages
// read by canonical metric key only. First live poll is the fix loop; the
// unmatched datapoint names are kept in features.dsUnmatched for Settings.
//
// Entry shape:
//   { family, match: <string exact | string ending in '-' = prefix | RegExp>,
//     label, history: bool, maxInstances (default 2500),
//     metrics: { <metricKey>: { match: RegExp | RegExp[], kind, unit, label } } }
// kind: 'gauge' | 'state' | 'counter' | 'pct'. State values keep the raw
// number; routes map enums and render unknown values as the number.

const FAMILIES = ['firewall', 'loadbalancer', 'health', 'optics', 'routing', 'ipsla', 'voice', 'wireless', 'cloud', 'cohesity', 'apps', 'security', 'os'];

// Round 9: devices the inventory refresh must also read DataSources for even
// though they are not network devices (AWS Direct Connect, Azure ExpressRoute).
// They arrive as device_type 2 (AWS) or 4 (Azure) with an external resource
// type (ERT) in this family. UNVERIFIED against a live portal.
const CLOUD_ERT_RE = /^(AWS\/DirectConnect|AWS\/DirectConnectVirtualInterface|Azure\/ExpressRouteCircuit)/i;

const FAMILY_LABELS = {
  firewall: 'Firewalls',
  loadbalancer: 'Load balancers',
  health: 'Device health',
  optics: 'Optics',
  routing: 'Routing',
  ipsla: 'IP SLA',
  voice: 'Voice',
  wireless: 'Wireless',
  cloud: 'Cloud circuits',
  cohesity: 'Cohesity (via LogicMonitor)',
  os: 'Server OS (via LogicMonitor)',
  apps: 'Applications and appliances (via LogicMonitor)',
  security: 'Security appliances (via LogicMonitor)',
};

const DEFAULT_MAX_INSTANCES = 2500;

// Every metric regex is forced case-insensitive, string or RegExp alike.
const re = (x) => new RegExp(x instanceof RegExp ? x.source : x, 'i');
const m = (match, kind, unit, label) => ({ match: Array.isArray(match) ? match.map(re) : re(match), kind, unit: unit || '', label });
const gauge = (match, unit, label) => m(match, 'gauge', unit, label);
const state = (match, label) => m(match, 'state', '', label);
const counter = (match, unit, label) => m(match, 'counter', unit, label);
const pct = (match, label) => m(match, 'pct', '%', label);
// exact('a') is one anchored regex; exact(['a', 'b']) is a priority list (first name present wins).
const exact = (name) => (Array.isArray(name) ? name.map((n) => `^${n}$`) : `^${name}$`);

// Bump whenever a regex below changes. pollMetrics drops every learned
// dsColumns/dsUnmatched map when a source's stored catalogVersion differs, so
// the next poll relearns with the corrected matchers.
const CATALOG_VERSION = 5; // 5: round 12 exact Palo Alto picks (cpu_pct_used, mem_pct_used, cur_temp, alarms), Ping, Cisco_NTP, F5 memory and interfaces; 4: F5_BigIP_System memory percent is MemoryUsage (MemoryUsed is bytes); 3: round 11 families

const CATALOG = [];
const add = (family, match, label, metrics, opts = {}) => {
  CATALOG.push({
    family, match, label, history: !!opts.history, maxInstances: opts.maxInstances || DEFAULT_MAX_INSTANCES, metrics,
    // instanceNames: instance descriptions carry the readable name (SSID for a WLAN).
    ...(opts.instanceNames ? { instanceNames: true } : {}),
  });
};

// -- Firewalls: Palo Alto --------------------------------------------------------

add('firewall', 'PaloAlto_FW_GlobalSessions', 'PAN global sessions', {
  sessions_active: gauge(['^(active.?)?sessions?(.?active)?$', 'active.?sess', 'sessions?.?count', 'session.?count'], 'sessions', 'Active sessions'),
  sessions_max: gauge(['max.?sess', 'session.?max', 'sessions?.?limit', 'session.?capacity'], 'sessions', 'Max sessions'),
  sessions_util_pct: pct(['sess.*util', 'util.*sess', 'session.*percent', 'session.*pct'], 'Session utilization'),
  sessions_tcp: gauge(/tcp/, 'sessions', 'TCP sessions'),
  sessions_udp: gauge(/udp/, 'sessions', 'UDP sessions'),
  sessions_icmp: gauge(/icmp/, 'sessions', 'ICMP sessions'),
}, { history: true });

add('firewall', 'PaloAlto_FW_GlobalPerformance', 'PAN global performance', {
  pkt_rate: gauge(['packet.?rate', 'pkt.?rate', 'pps', 'packets?.?per'], 'pps', 'Packet rate'),
  throughput_kbps: gauge(['throughput', 'kbps', 'bps', 'bandwidth'], 'kbps', 'Throughput'),
  session_rate: gauge(['(new.?)?session.?rate', 'cps', 'connections?.?per'], '/s', 'Session rate'),
}, { history: true });

add('firewall', 'PaloAlto_FW_SystemResources', 'PAN system resources', {
  // Round 12: verified on the live portal. The old regexes picked cpu_nice (always 0) and mem_used (bytes).
  mgmt_cpu_pct: pct(exact('cpu_pct_used'), 'Management CPU'),
  mem_pct: pct(exact('mem_pct_used'), 'Memory used'),
  swap_pct: pct(exact(['swap_pct_used', 'memory_swap_pct_used']), 'Swap used'),
  mem_used_bytes: gauge(exact('mem_used'), 'bytes', 'Memory used'),
  mem_total_bytes: gauge(exact('mem_total'), 'bytes', 'Memory total'),
}, { history: true });

add('firewall', 'PaloAlto_FW_DataplaneCores', 'PAN dataplane cores', {
  core_cpu_pct: pct(['cpu', 'util', 'load', 'usage'], 'Core CPU'),
}, { history: true });

add('firewall', 'PaloAlto_FW_DroppedPackets', 'PAN dropped packets', {
  dropped: counter(['drop', 'discard'], 'pkts', 'Dropped packets'),
}, { history: true });

add('firewall', 'PaloAlto_FW_HA_Status', 'PAN HA status', {
  ha_enabled: state(['ha.?enabled', 'enabled'], 'HA enabled'),
  ha_local_state: state(['local.?state', 'local'], 'Local state'),
  ha_peer_state: state(['peer.?state', 'peer'], 'Peer state'),
  ha_mode: state(['^mode$', 'ha.?mode', 'mode'], 'HA mode'),
});

add('firewall', 'PaloAlto_FW_HA_Interface', 'PAN HA interfaces', {
  ha_if_state: state(['state', 'status', 'link'], 'HA link state'),
});

add('firewall', 'PaloAlto_FW_IPSecTunnelOverview', 'PAN IPSec tunnel overview', {
  tunnels_up: gauge(['up', 'active'], 'tunnels', 'Tunnels up'),
  tunnels_down: gauge(['down', 'inactive'], 'tunnels', 'Tunnels down'),
  tunnels_total: gauge(['total', 'count'], 'tunnels', 'Tunnels total'),
}, { history: true });

add('firewall', 'PaloAlto_FW_IPSecTunnelStats', 'PAN IPSec tunnel stats', {
  tunnel_state: state(['state', 'status'], 'Tunnel state'),
  tunnel_in_bps: gauge(['in.?(bps|bits|rate|octets|bytes)', '^in$', 'rx', 'receive'], 'bps', 'In'),
  tunnel_out_bps: gauge(['out.?(bps|bits|rate|octets|bytes)', '^out$', 'tx', 'transmit'], 'bps', 'Out'),
}, { maxInstances: 1000 });

add('firewall', 'PaloAlto_GlobalProtect_Gateway', 'PAN GlobalProtect gateway', {
  gp_users_active: gauge(['active.?(users?|tunnels?)', 'current.?users?', 'users?'], 'users', 'Active users'),
  gp_users_max: gauge(['max'], 'users', 'Max users'),
  gp_tunnels: gauge(['tunnels?'], 'tunnels', 'Tunnels'),
}, { history: true });

add('firewall', 'PaloAlto_FW_Config_Synced', 'PAN config sync', {
  config_synced: state(['sync(ed)?', 'running.?config'], 'Config synced'),
  config_pending: state(['pending'], 'Config pending'),
});

add('firewall', 'PaloAlto_FW_ThreatAnalysis', 'PAN threat analysis', {
  threats_total: counter(['total'], 'threats', 'Threats total'),
  threats_critical: counter(['critical'], 'threats', 'Critical'),
  threats_high: counter(['high'], 'threats', 'High'),
  threats_medium: counter(['medium'], 'threats', 'Medium'),
  threats_low: counter(['low'], 'threats', 'Low'),
  threats_informational: counter(['info'], 'threats', 'Informational'),
}, { history: true });

add('firewall', 'PaloAlto_FW_Zones', 'PAN zones', {
  zone_in_bps: gauge(['in.?(bps|bits|rate|bytes)', '^in$', 'rx'], 'bps', 'Zone in'),
  zone_out_bps: gauge(['out.?(bps|bits|rate|bytes)', '^out$', 'tx'], 'bps', 'Zone out'),
  zone_sessions: gauge(['sessions?'], 'sessions', 'Zone sessions'),
});

add('firewall', 'PaloAlto_FW_vSys', 'PAN virtual systems', {
  vsys_sessions: gauge(['(active.?)?sessions?$', 'active.?sess'], 'sessions', 'vsys sessions'),
  vsys_util_pct: pct(['util', 'percent', 'pct'], 'vsys session utilization'),
});

add('firewall', 'PaloAlto_FW_LogForwarding', 'PAN log forwarding', {
  log_forwarded: counter(['forward', 'sent', 'success'], 'logs', 'Forwarded'),
  log_dropped: counter(['drop', 'fail', 'error'], 'logs', 'Dropped'),
});

add('firewall', 'PaloAlto_FW_Disk', 'PAN disks', {
  disk_used_pct: pct(['used.?(pct|percent)?', 'util', 'percent', 'usage'], 'Disk used'),
});

// Round 12: the DataSource reports alarm flags (0 = fine, 1 = alarm) and a voltage, no state enum.
add('firewall', 'PaloAlto_FW_Power', 'PAN power supplies', {
  psu_low_alarm: gauge(exact('low_alarm'), '', 'PSU low alarm'),
  psu_high_alarm: gauge(exact('high_alarm'), '', 'PSU high alarm'),
  cur_voltage: gauge(exact('cur_voltage'), 'V', 'Voltage'),
});

add('firewall', 'PaloAlto_FW_ChassisPower', 'PAN chassis power', {
  chassis_watts: gauge(['watt', 'power', 'consum'], 'W', 'Chassis power'),
});

add('firewall', 'PaloAlto_FW_Temperature', 'PAN temperature', {
  temp_c: gauge(exact('cur_temp'), 'C', 'Temperature'),
  temp_alarm: gauge(exact('temp_alarm'), '', 'Temperature alarm'),
});

add('firewall', 'PaloAlto_FW_BGP', 'PAN BGP', {
  bgp_peer_state: state(['peer.?state', 'state', 'status'], 'BGP peer state'),
  bgp_prefixes: gauge(['prefix', 'route'], 'prefixes', 'Prefixes'),
});

add('firewall', 'PaloAlto_FW_OSPF', 'PAN OSPF', {
  ospf_nbr_state: state(['nbr.?state', 'neighbor', 'state', 'status'], 'OSPF neighbour state'),
});

add('firewall', 'PaloAlto_FW_SDWAN_Tunnel', 'PAN SD-WAN tunnels', {
  sdwan_state: state(['state', 'status'], 'SD-WAN tunnel state'),
});

add('firewall', 'CiscoASA', 'Cisco ASA', {
  asa_connections: gauge(['conn'], 'conns', 'Connections'),
  asa_cpu_pct: pct(['cpu'], 'CPU'),
  asa_mem_pct: pct(['mem.*(used|util|percent|pct)', 'mem'], 'Memory'),
}, { history: true });

add('firewall', 'Cisco_ASA_Failover', 'Cisco ASA failover', {
  asa_failover_state: state(['state', 'status', 'failover', 'unit'], 'Failover state'),
});

add('firewall', 'ntm_asa_license_authorization', 'Cisco ASA license', {
  asa_license_valid: state(['valid', 'authorization', 'status', 'state'], 'License valid'),
});

add('firewall', 'ntm_meraki_mx_device_utilization', 'Meraki MX utilization', {
  mx_util_pct: pct(['util', 'usage', 'percent'], 'MX utilization'),
});

// -- Load balancers: F5 ----------------------------------------------------------

add('loadbalancer', 'F5_BigIP_System', 'F5 system', {
  // Live names and values (CGSandBox raw store): CPUUtilization 3 to 12 (percent),
  // MemoryUsage 2.35 (percent) while MemoryUsed is bytes (283919056) and MemoryTotal
  // bytes; the current-connection gauges (LM spells the server one
  // ServerCurrentConncections).
  cpu_pct: pct(exact('CPUUtilization'), 'CPU'),
  mem_pct: pct(exact('MemoryUsage'), 'Memory'),
  mem_used_bytes: gauge(exact('MemoryUsed'), 'B', 'Memory used'),
  mem_total_bytes: gauge(exact('MemoryTotal'), 'B', 'Memory total'),
  client_connections: gauge(exact('ClientCurrentConnections'), 'conns', 'Client connections'),
  server_connections: gauge([exact('ServerCurrentConncections'), exact('ServerCurrentConnections')], 'conns', 'Server connections'),
  throughput_bps: gauge(['throughput', 'bits', 'bps'], 'bps', 'Throughput'),
}, { history: true });

add('loadbalancer', 'F5_BigIP_FailoverStatus', 'F5 failover', {
  // LM enum (UNVERIFIED): 0 unknown, 1 offline, 2 forced offline, 3 standby, 4 active.
  // Live names: FailoverStatus (the number), FailoverColor and FailoverColorAlert are display helpers.
  failover_state: state(exact('FailoverStatus'), 'Failover state'),
  sync_state: state(['sync'], 'Sync state'),
});

add('loadbalancer', 'F5_BigIP_PoolMemberStats', 'F5 pool members', {
  member_avail: state(['avail', 'status', 'state'], 'Member available'),
  member_enabled: state(['enabled', 'enable'], 'Member enabled'),
  // Live names (no availability datapoint exists on this DataSource, so member_avail stays loose and unmatched).
  member_connections: gauge([exact('currentSessions'), exact('pvaCurrentConnections')], 'conns', 'Connections'),
  member_bits_in: gauge([exact('serverBytesIn'), exact('pvaBytesIn')], 'bps', 'Bits in'),
  member_bits_out: gauge([exact('serverBytesOut'), exact('pvaBytesOut')], 'bps', 'Bits out'),
}, { maxInstances: 5000 });

add('loadbalancer', 'F5_GTM_WideIP-', 'F5 GTM wide IPs', {
  wideip_avail: state(exact('AvailStatus'), 'Wide IP available'),
  wideip_requests: counter(exact('RequestsTotal'), 'req', 'Requests'),
}, { maxInstances: 5000 });

add('loadbalancer', 'F5_GTM_VIPs-', 'F5 GTM VIPs', {
  vip_avail: state(exact('AvailStatus'), 'VIP available'),
  vip_enabled: state(['enabled', 'enable'], 'VIP enabled'),
}, { maxInstances: 5000 });

add('loadbalancer', 'F5_GTM_Servers-', 'F5 GTM servers', {
  gtm_server_avail: state(exact('AvailStatus'), 'GTM server available'),
});

add('loadbalancer', 'F5_GTM_Datacenters-', 'F5 GTM datacenters', {
  dc_avail: state(exact('AvailStatus'), 'Datacenter available'),
});

add('loadbalancer', 'F5_GTM_Global', 'F5 GTM global', {
  gtm_requests: counter(exact('RequestsTotal'), 'req', 'Requests'),
  gtm_resolutions: counter(exact('Resolutions'), 'res', 'Resolutions'),
});

for (const d of ['f5_big3d_service_status', 'f5_mcpd_service_status', 'f5_tmm_service_status',
  'f5_tmrouted_service_status', 'f5_gtmd_service_status', 'f5_gtm_gslb_status']) {
  add('loadbalancer', d, `F5 daemon ${d.replace(/^f5_/, '').replace(/_service_status$|_status$/, '')}`, {
    daemon_state: state(['status', 'state', 'running', 'service'], 'Daemon state'),
  });
}

add('loadbalancer', 'F5_BigIP_SSL_VIP_Certs', 'F5 SSL certificates', {
  cert_days_left: gauge(['days', 'expir', 'remaining'], 'days', 'Days to expiry'),
});

// Round 12: verified on the live portal. The DataSource has byte counts only, no percent datapoint.
add('loadbalancer', 'F5_BigIP_Memory', 'F5 memory', {
  mem_total_bytes: gauge(exact('RealMemTotal'), 'bytes', 'Memory total'),
  mem_avail_bytes: gauge(exact('RealMemAvailable'), 'bytes', 'Memory available'),
  mem_free_bytes: gauge(exact('TotalMemFree'), 'bytes', 'Memory free'),
  swap_total_bytes: gauge(exact('SwapTotal'), 'bytes', 'Swap total'),
  swap_avail_bytes: gauge(exact('SwapAvailable'), 'bytes', 'Swap available'),
}, { history: true });

add('loadbalancer', 'F5_BigIP_Filesystem', 'F5 filesystem', {
  fs_used_pct: pct(exact('BlockUtilization'), 'Filesystem used'),
  fs_inode_pct: pct(exact('NodeUtilization'), 'Inodes used'),
});

// Round 12: verified on the live portal. BytesIn/BytesOut are per second rates (bytes), there is no status datapoint.
add('loadbalancer', 'F5_BigIP_Interfaces', 'F5 interfaces', {
  if_in_bytes: gauge(exact('BytesIn'), 'B/s', 'In'),
  if_out_bytes: gauge(exact('BytesOut'), 'B/s', 'Out'),
  if_errors_in: gauge(exact('ErrorsIn'), '/s', 'Errors in'),
  if_errors_out: gauge(exact('ErrorsOut'), '/s', 'Errors out'),
  if_drops_in: gauge(exact('DropsIn'), '/s', 'Drops in'),
  if_drops_out: gauge(exact('DropsOut'), '/s', 'Drops out'),
});

add('loadbalancer', 'F5_BigIP_Fans', 'F5 fans', { fan_state: state(exact('FanStatus'), 'Fan state') });
add('loadbalancer', 'F5_BigIP_Power', 'F5 power supplies', { psu_state: state(exact('Status'), 'PSU state') });
add('loadbalancer', 'F5_BigIP_Temperature', 'F5 temperature', { temp_c: gauge(exact('Temp'), 'C', 'Temperature') });

// F5OS (rSeries / VELOS): exact names unknown, matched by pattern.
add('loadbalancer', /^f5-?os[_ -]?disk/i, 'F5OS disk', { f5os_disk_pct: pct(['used', 'percent', 'util', 'usage'], 'Disk used') });
add('loadbalancer', /^f5-?os[_ -]?fan/i, 'F5OS fans', { f5os_fan_state: state(['status', 'state', 'health'], 'Fan state') });
add('loadbalancer', /^f5-?os[_ -]?memory/i, 'F5OS memory', { f5os_mem_pct: pct(['used', 'percent', 'util', 'usage'], 'Memory used') });
add('loadbalancer', /^f5-?os[_ -]?temperature/i, 'F5OS temperature', { f5os_temp_c: gauge(['temp', 'current'], 'C', 'Temperature') });
add('loadbalancer', /^f5-?os[_ -]?cpu/i, 'F5OS CPU', { f5os_cpu_pct: pct(['util', 'percent', 'usage', 'cpu'], 'CPU') }, { history: true });

// -- Device health (any vendor) --------------------------------------------------

add('health', 'Cisco_CPU_SNMP', 'Cisco CPU', {
  cpu_pct: pct([/5.?min/, /cpu.?5/, /five/, /busy/, /cpu/, /1.?min/], 'CPU'),
}, { history: true });
add('health', 'NetSNMPCPUwithCores', 'Net-SNMP CPU', {
  // CpuRawIdle is a raw tick counter; CPUBusyPercent is the percentage.
  cpu_pct: pct(exact('CPUBusyPercent'), 'CPU'),
}, { history: true });
add('health', 'Brocade Corp CPU and Memory', 'Brocade CPU and memory', {
  cpu_pct: pct(['cpu'], 'CPU'),
  mem_pct: pct(['mem'], 'Memory'),
}, { history: true });

add('health', 'Cisco_MemoryPools_SNMP', 'Cisco memory pools', {
  // Percent used. If LM only exposes PercentFree the collector stores 100 - free
  // and records "100-PercentFree" as the datapoint (see parseDsBody).
  mem_pct: pct([/percent.?used/, /used.?percent/, /percent.?free|free.?percent|pct.?free/, /percent|util|usage/], 'Memory used'),
}, { history: true });
add('health', 'NetSNMP_Memory_Usage', 'Net-SNMP memory', {
  // PercentSwapUsed is swap, not memory; ActiveMemoryPercent is the live memory figure.
  mem_pct: pct(exact('ActiveMemoryPercent'), 'Memory used'),
}, { history: true });

add('health', 'Cisco_FRU_Power', 'Cisco FRU power', { psu_state: state(exact('OperatingStatus'), 'PSU state') }, { maxInstances: 5000 });
add('health', 'Cisco_Nexus_FRU_Power', 'Cisco Nexus FRU power', { psu_state: state(['status', 'state', 'oper'], 'PSU state') });
add('health', 'Cisco_System_PowerSupplies', 'Cisco power supplies', { psu_state: state(['status', 'state', 'oper'], 'PSU state') });
add('health', 'CiscoFan-', 'Cisco fans', { fan_state: state(['status', 'state', 'oper'], 'Fan state') });
add('health', 'Cisco_TemperatureSensors', 'Cisco temperature sensors', {
  temp_c: gauge(['temp(erature)?$', 'temp(erature)?.?c', 'celsius', 'value', 'temp'], 'C', 'Temperature'),
  temp_state: state(['state', 'status'], 'Temperature state'),
});
add('health', 'Cisco_Entity_Sensors', 'Cisco entity sensors', {
  sensor_value: gauge(exact('sensor_value'), '', 'Sensor value'),
  sensor_state: state(exact('sensor_status'), 'Sensor state'),
}, { maxInstances: 5000 });
add('health', 'Brocade Sensors-', 'Brocade sensors', { sensor_state: state(['status', 'state'], 'Sensor state') });
add('health', 'Cisco_Nexus_Line_Card_Status', 'Cisco Nexus line cards', {
  linecard_state: state(exact('StatusLineCard'), 'Line card state'),
  sup1_state: state(exact('StatusSup1'), 'Supervisor 1 state'),
  sup2_state: state(exact('StatusSup2'), 'Supervisor 2 state'),
});
add('health', 'Cisco_Nexus_Supervisor_Status', 'Cisco Nexus supervisors', { sup_state: state(exact('cRFStatusUnitState'), 'Supervisor state') });
add('health', 'Cisco Switch Stack-', 'Cisco switch stack', {
  stack_member_state: state(exact('StackState'), 'Stack member state'),
  stack_role: gauge(exact('SwitchRole'), '', 'Stack role'),
});
// Round 12: verified on the live portal (Ping 217 devices, Cisco_NTP 54).
add('health', 'Ping', 'Ping', {
  ping_loss_pct: pct(exact('PingLossPercent'), 'Ping loss'),
  ping_rtt_ms: gauge(exact('average'), 'ms', 'Ping RTT'),
  ping_rtt_max_ms: gauge(exact('maxrtt'), 'ms', 'Ping max RTT'),
});
add('health', 'Cisco_NTP', 'Cisco NTP', {
  ntp_synced: state(exact('synced'), 'NTP synchronised'),
  ntp_stratum: gauge(exact('Stratum'), '', 'NTP stratum'),
  ntp_offset_ms: gauge(exact('Offset'), 'ms', 'NTP offset'),
});
add('health', 'Cisco Switch Stack Ports-', 'Cisco switch stack ports', { stack_port_state: state(['state', 'status', 'oper'], 'Stack port state') });
add('health', 'Cisco_PowerOverEthernet', 'Cisco PoE', {
  poe_used_pct: pct(['percent', 'pct', 'util'], 'PoE used'),
  poe_used_watts: gauge(['consum', 'used', 'watt', 'power'], 'W', 'PoE used'),
});
add('health', 'Cisco_Catalyst_PowerOverEthernet', 'Cisco Catalyst PoE', {
  poe_used_pct: pct(['percent', 'pct', 'util'], 'PoE used'),
  poe_used_watts: gauge(['consum', 'used', 'watt', 'power'], 'W', 'PoE used'),
});
add('health', 'SNMP_Filesystem_Usage', 'SNMP filesystem usage', {
  fs_used_pct: pct(['percent.?used', 'used.?percent', 'pct', 'percent', 'util'], 'Filesystem used'),
  // Round 11 (lm11-servers), UNVERIFIED datapoint names.
  fs_used_bytes: gauge(['used.?(bytes|space|size|kb|mb|gb)', '^used$'], 'bytes', 'Used'),
  fs_total_bytes: gauge(['total', 'size', 'capacity'], 'bytes', 'Total'),
  fs_free_bytes: gauge(['free', 'avail'], 'bytes', 'Free'),
}, { history: true, maxInstances: 400 });
add('health', 'SNMP_Host_Uptime', 'SNMP host uptime', { uptime_s: gauge(exact('Uptime'), 's', 'Uptime') });

// -- Optics ----------------------------------------------------------------------

add('optics', 'Cisco_Transceiver_Sensors', 'Cisco transceivers', {
  // This portal's DataSource is a generic sensor table: the sensor kind (Rx power,
  // Tx power, temperature, ...) is in the instance name, the thresholds are
  // datapoints of the same row. These claim first; the per-metric names below
  // stay for portals whose DataSource has one datapoint per measurement.
  optic_value: gauge(exact('sensor_value'), '', 'Sensor value'),
  optic_low_warn: gauge(exact('low_warning'), '', 'Low warning'),
  optic_high_warn: gauge(exact('high_warning'), '', 'High warning'),
  optic_low_alarm: gauge(exact('low_alarm'), '', 'Low alarm'),
  optic_state: state(exact('sensor_status'), 'Sensor status'),
  optic_if_state: state(exact('sensor_parent_interface_status'), 'Parent interface status'),
  rx_power_dbm: gauge(['rx.?power', 'receive.*power', 'rx', 'receive'], 'dBm', 'Rx power'),
  tx_power_dbm: gauge(['tx.?power', 'transmit.*power', 'tx', 'transmit'], 'dBm', 'Tx power'),
  temp_c: gauge(['temp(erature)?$', 'temp'], 'C', 'Temperature'),
  current_ma: gauge(['current', 'bias'], 'mA', 'Bias current'),
  voltage_v: gauge(['volt'], 'V', 'Voltage'),
  rx_low_warn: gauge(['rx.*low.*warn', 'rx.*warn.*low'], 'dBm', 'Rx low warn'),
  rx_low_alarm: gauge(['rx.*low.*alarm', 'rx.*alarm.*low'], 'dBm', 'Rx low alarm'),
  tx_low_warn: gauge(['tx.*low.*warn', 'tx.*warn.*low'], 'dBm', 'Tx low warn'),
}, { maxInstances: 5000 });

// -- Routing ---------------------------------------------------------------------

add('routing', 'BGP-', 'BGP peers', {
  // RFC 4273 bgpPeerState: 6 = established.
  bgp_peer_state: state(exact('PeerState'), 'BGP peer state'),
  bgp_established_s: gauge(exact('EstablishedTime'), 's', 'Established time'),
  bgp_prefixes_in: gauge(['prefix', 'received', 'accepted'], 'prefixes', 'Prefixes in'),
});
add('routing', 'OSPF_Neighbors', 'OSPF neighbours', {
  // OSPF-MIB ospfNbrState: 8 = full.
  ospf_nbr_state: state(exact('peerState'), 'OSPF neighbour state'),
});
add('routing', 'Cisco_EIGRP_Peers', 'EIGRP peers', { eigrp_uptime_s: gauge(['uptime', 'up.?time'], 's', 'Peer uptime') });
add('routing', 'ntm_CX_BGP', 'Cisco CX BGP', { bgp_peer_state: state(['state', 'status'], 'BGP peer state') });
add('routing', 'ntm_CX_BGP_Peering', 'Cisco CX BGP peering', { bgp_peer_state: state(['state', 'status'], 'BGP peer state') });

// -- IP SLA ----------------------------------------------------------------------

add('ipsla', 'CiscoSLA_jitter-', 'Cisco IP SLA jitter', {
  // The live jitter DataSource has no average RTT and no total loss datapoint
  // (only SumRTT/NumRTT and the directional SDLoss/DSLoss), so rtt_ms and
  // loss_pct are deliberately not mapped here.
  mos: gauge(exact('MOS'), '', 'MOS'),
  icpif: gauge(exact('ICPIF'), '', 'ICPIF'),
  jitter_sd_pos: gauge(exact('SumPositiveSD'), 'ms', 'Positive jitter source to destination'),
  jitter_ds_pos: gauge(exact('SumPositiveDS'), 'ms', 'Positive jitter destination to source'),
}, { history: true });
// An RTT name must not start with Sum/Num (SumRTT, Sum2RTT, NumRTT are
// accumulators, not a round trip time).
const slaMetrics = () => ({
  rtt_ms: gauge(['^(?!sum|num)(.*rtt|.*latency|.*delay|.*completion)'], 'ms', 'RTT'),
  loss_pct: pct(['loss', 'drop'], 'Packet loss'),
  sla_state: state(['state', 'status', 'oper', 'timeout'], 'SLA state'),
});
add('ipsla', 'Cisco_IPSLA_Statistics', 'Cisco IP SLA', slaMetrics(), { history: true });
add('ipsla', 'Groovy_Cisco_IPSLA_Statistics', 'Cisco IP SLA (groovy)', slaMetrics(), { history: true });
add('ipsla', 'ntm_ipsla_svd', 'IP SLA SVD', slaMetrics(), { history: true });
add('ipsla', 'CiscoSLA_ICMPEcho-', 'Cisco IP SLA ICMP echo', slaMetrics(), { history: true });
add('ipsla', 'IPSLA_WAN', 'IP SLA WAN', slaMetrics(), { history: true });

// -- Voice -----------------------------------------------------------------------

// The Cisco_SIP_* DataSources seen on the live portal each carry dozens of
// cSipStats counters (every one with a ...Raw twin). Each gets its own entry
// with exact names; the Raw twins are never claimed. Exact entries win over
// the loose prefix entry at the bottom, which only serves SIP DataSources
// not seen live.
add('voice', 'Cisco_SIP_Connections', 'Cisco SIP connections', {
  sip_active_tcp: gauge(exact('cSipStatsActiveTCPConnections'), 'conns', 'Active TCP connections'),
  sip_active_udp: gauge(exact('cSipStatsActiveUDPConnections'), 'conns', 'Active UDP connections'),
});
add('voice', 'Cisco_SIP_Successes', 'Cisco SIP successes', {
  sip_successes_in: counter(exact('cSipStatsSuccessOkIns'), 'req', '200 OK in'),
  sip_successes_out: counter(exact('cSipStatsSuccessOkOuts'), 'req', '200 OK out'),
});
add('voice', 'Cisco_SIP_GlobalFail', 'Cisco SIP global failures', {
  sip_global_busy: counter(exact('cSipStatsGlobalBusyEverywhereIns'), 'req', 'Busy everywhere in'),
  sip_global_decline: counter(exact('cSipStatsGlobalDeclineIns'), 'req', 'Decline in'),
});
add('voice', 'Cisco_SIP_Client_Errors', 'Cisco SIP client errors', {
  sip_client_bad_request: counter(exact('cSipStatsClientBadRequestIns'), 'req', 'Bad request in'),
  sip_client_unauthorized: counter(exact('cSipStatsClientUnauthorizedIns'), 'req', 'Unauthorized in'),
  sip_client_not_found: counter(exact('cSipStatsClientNotFoundIns'), 'req', 'Not found in'),
}, { history: true });
add('voice', 'Cisco_SIP_Server_Errors', 'Cisco SIP server errors', {
  sip_server_int_error: counter(exact('cSipStatsServerIntErrorIns'), 'req', 'Internal error in'),
  sip_server_unavailable: counter(exact('cSipStatsServerServiceUnavailIns'), 'req', 'Service unavailable in'),
  sip_server_gw_timeout: counter(exact('cSipStatsServerGatewayTimeoutIns'), 'req', 'Gateway timeout in'),
}, { history: true });
add('voice', 'Cisco_SIP_Retries', 'Cisco SIP retries', {
  sip_retry_invites: counter(exact('cSipStatsRetryInvites'), 'req', 'Invite retries'),
  sip_retry_registers: counter(exact('cSipStatsRetryRegisters'), 'req', 'Register retries'),
});
add('voice', 'Cisco_SIP_Redirect', 'Cisco SIP redirects', {
  sip_redirect_temp: counter(exact('cSipStatsRedirMovedTempsIns'), 'req', 'Moved temporarily in'),
  sip_redirect_perm: counter(exact('cSipStatsRedirMovedPerms'), 'req', 'Moved permanently'),
});
add('voice', 'Cisco_SIP_Traffic', 'Cisco SIP traffic', {
  sip_traffic_in: counter(exact('cSipStatsTrafficInviteIns'), 'msgs', 'Invites in'),
  sip_traffic_out: counter(exact('cSipStatsTrafficInviteOuts'), 'msgs', 'Invites out'),
});
add('voice', 'Cisco_SIP_Overview', 'Cisco SIP overview', {
  sip_trying_in: counter(exact('cSipStatsInfoTryingIns'), 'msgs', 'Trying in'),
  sip_ringing_in: counter(exact('cSipStatsInfoRingingIns'), 'msgs', 'Ringing in'),
});
// Loose fallback for SIP DataSources not seen live. Never claims a ...Raw name.
const noRaw = (alts) => `^(?!.*raw$).*(?:${alts})`;
add('voice', /^Cisco_SIP_/i, 'Cisco SIP', {
  sip_connections: counter([noRaw('connection')], 'conns', 'Connections'),
  sip_client_errors: counter([noRaw('client.?err|4xx')], 'req', 'Client errors'),
  sip_server_errors: counter([noRaw('server.?err|5xx')], 'req', 'Server errors'),
  sip_successes: counter([noRaw('success|2xx')], 'req', 'Successes'),
  sip_retries: counter([noRaw('retr')], 'req', 'Retries'),
  sip_redirects: counter([noRaw('redirect|3xx')], 'req', 'Redirects'),
  sip_global_fail: counter([noRaw('global.?fail|fail')], 'req', 'Global failures'),
  sip_traffic_in: counter([noRaw('in(bound)?.?(traffic|bytes|msgs?|messages?)|traffic.?in|received')], 'msgs', 'Traffic in'),
  sip_traffic_out: counter([noRaw('out(bound)?.?(traffic|bytes|msgs?|messages?)|traffic.?out|sent')], 'msgs', 'Traffic out'),
}, { history: true });
add('voice', /^ntm_sbc_/i, 'SBC', {
  sbc_cpu_pct: pct(['cpu'], 'CPU'),
  sbc_mem_pct: pct(['mem'], 'Memory'),
  sbc_fan_state: state(['fan'], 'Fan state'),
  sbc_psu_state: state(['psu', 'power'], 'PSU state'),
  sbc_temp_c: gauge(['temp'], 'C', 'Temperature'),
  sbc_health_state: state(['health'], 'Health state'),
  sbc_retransmissions: counter(['retrans'], 'pkts', 'Retransmissions'),
  sbc_local_connection_state: state(['local.?conn', 'connection.?state'], 'Local connection state'),
});
add('voice', 'ISDN_Channels', 'ISDN channels', { isdn_busy: gauge(['busy', 'active', 'in.?use'], 'channels', 'Busy channels') });

// -- Wireless --------------------------------------------------------------------
// Datapoint names and enums verified against a live portal (AireOS 5508/3504 and
// Catalyst 9800). Rate datapoints arrive from LM already per second.

add('wireless', 'Cisco_Wireless_AP', 'Cisco wireless APs', {
  // bsnAPAdminStatus: 1 enabled, 2 disabled.
  ap_admin: state(exact('bsnAPAdminStatus'), 'Admin status'),
  // bsnAPOperationStatus: 1 associated, 2 disassociating, 3 downloading.
  ap_oper: state(exact('bsnAPOperationStatus'), 'Operation status'),
}, { maxInstances: 5000 });
add('wireless', 'Cisco_Wireless_AccessPointRadio', 'Cisco AP radios', {
  // bsnAPIfAdminStatus: 1 enabled, 2 disabled. bsnAPIfOperStatus: 1 down, 2 up.
  radio_admin: state(exact('bsnAPIfAdminStatus'), 'Admin status'),
  radio_oper: state(exact('bsnAPIfOperStatus'), 'Oper status'),
  radio_util_pct: pct(exact('bsnAPIfLoadChannelUtilization'), 'Channel utilization'),
  radio_rx_util_pct: pct(exact('bsnAPIfLoadRxUtilization'), 'Rx utilization'),
  radio_tx_util_pct: pct(exact('bsnAPIfLoadTxUtilization'), 'Tx utilization'),
  radio_clients: gauge(exact('bsnAPIfLoadNumOfClients'), 'clients', 'Clients'),
  radio_users: gauge(exact('bsnApIfNoOfUsers'), 'users', 'Users'),
  radio_tx_power: gauge(exact('bsnAPIfPhyTxPowerLevel'), 'level', 'Tx power level'),
  // RRM profile states: 1 pass, 2 fail.
  radio_load_profile: state(exact('bsnAPIfLoadProfileState'), 'Load profile'),
  radio_noise_profile: state(exact('bsnAPIfNoiseProfileState'), 'Noise profile'),
  radio_interference_profile: state(exact('bsnAPIfInterferenceProfileState'), 'Interference profile'),
  radio_coverage_profile: state(exact('bsnAPIfCoverageProfileState'), 'Coverage profile'),
}, { maxInstances: 5000 });
add('wireless', 'Cisco_Wireless_AccessPointInterfaces', 'Cisco AP ethernet', {
  // cLApEthernetIfOperStatus: 1 up, 2 down.
  apif_oper: state(exact('cLApEthernetIfOperStatus'), 'Oper status'),
  apif_admin: state(exact('cLApEthernetIfAdminStatus'), 'Admin status'),
  apif_in_errors: gauge(exact('cLApEthernetIfInputErrors'), '/s', 'Input errors'),
  apif_out_errors: gauge(exact('cLApEthernetIfOutputErrors'), '/s', 'Output errors'),
  apif_in_drops: gauge(exact('cLApEthernetIfInputDrops'), '/s', 'Input drops'),
  apif_out_drops: gauge(exact('cLApEthernetIfOutputTotalDrops'), '/s', 'Output drops'),
  apif_rx_bytes: gauge(exact('cLApEthernetIfRxTotalBytes'), 'B/s', 'Rx bytes'),
  apif_tx_bytes: gauge(exact('cLApEthernetIfTxTotalBytes'), 'B/s', 'Tx bytes'),
}, { maxInstances: 5000 });
add('wireless', 'Cisco_Wireless_ESS', 'Cisco WLANs (SSIDs)', {
  ess_admin: state(exact('adminStatus'), 'Admin status'),
  ess_broadcast: state(exact('broadcastSSID'), 'Broadcast SSID'),
  ess_clients: gauge(exact('numberOfMobileStations'), 'clients', 'Clients'),
}, { history: true, instanceNames: true });
add('wireless', 'Cisco_Wireless_GlobalPerformance', 'Cisco WLC performance', {
  cpu_pct: pct(exact('cpuUtilization'), 'CPU'),
  mem_pct: pct(exact('memoryUtilization'), 'Memory used'),
  temp_c: gauge(exact('temperatureCurrent'), 'C', 'Temperature'),
}, { history: true });
add('wireless', 'Cisco_Wireless_ConnectionStatistics', 'Cisco WLC connections', {
  wlc_clients: gauge(exact('numberOfClients'), 'clients', 'Clients'),
  wlc_clients_max: gauge(exact('sysMaxClients'), 'clients', 'Max clients'),
  wlc_client_usage_pct: pct(exact('sysMaxClientUsage'), 'Client capacity used'),
  wlc_aps_joined: gauge(exact('sysApConnectCount'), 'APs', 'APs joined'),
  wlc_ap_assoc_failed: gauge(exact('apAssocFailed'), '/s', 'AP association failures'),
  wlc_abnormal_offline: gauge(exact('sysAbnormalOfflineRate'), '', 'Abnormal client offline rate'),
}, { history: true });
add('wireless', 'Cisco_Wireless_DHCPStatistics', 'Cisco WLC DHCP proxy', {
  dhcp_proxy: state(exact('proxyState'), 'DHCP proxy'),
  dhcp_discover: gauge(exact('discoverPackets'), '/s', 'Discovers'),
  dhcp_offer: gauge(exact('offerPackets'), '/s', 'Offers'),
  dhcp_ack: gauge(exact('ackPackets'), '/s', 'Acks'),
  dhcp_nak: gauge(exact('nakPackets'), '/s', 'Naks'),
  dhcp_tx_failures: gauge(exact('txFailures'), '/s', 'Tx failures'),
});
add('wireless', 'Cisco_Wireless_MobilityStats', 'Cisco WLC mobility', {
  mob_handoffs: gauge(exact('handoffs'), '/s', 'Handoffs'),
  mob_handoff_requests: gauge(exact('handoffRequests'), '/s', 'Handoff requests'),
  mob_handoff_errors: gauge(exact('handoffErrors'), '/s', 'Handoff errors'),
  mob_handoff_denied: gauge(exact('handoffRequestsDenied'), '/s', 'Handoffs denied'),
  mob_handoff_dropped: gauge(exact('handoffRequestsDropped'), '/s', 'Handoffs dropped'),
});
add('wireless', 'Cisco_Wireless_RADIUSAuthServers', 'Cisco WLC RADIUS auth', {
  // status: 0 disabled, 1 enabled.
  radius_status: state(exact('status'), 'Enabled'),
  radius_network_user: state(exact('networkUserConfig'), 'Network users'),
  radius_requests: gauge(exact('clientAccessRequests'), '/s', 'Requests'),
  radius_accepts: gauge(exact('clientAccessAccepts'), '/s', 'Accepts'),
  radius_rejects: gauge(exact('clientAccessRejects'), '/s', 'Rejects'),
  radius_challenges: gauge(exact('clientAccessChallenges'), '/s', 'Challenges'),
  radius_timeouts: gauge(exact('clientAccessTimeouts'), '/s', 'Timeouts'),
  radius_retransmissions: gauge(exact('clientAccessRetransmissions'), '/s', 'Retransmissions'),
  radius_pending: gauge(exact('clientAccessPendingRequests'), 'req', 'Pending'),
});
add('wireless', 'Cisco_Wireless_RADIUSAccountingServers', 'Cisco WLC RADIUS accounting', {
  acct_status: state(exact('status'), 'Enabled'),
  acct_requests: gauge(exact('requests'), '/s', 'Requests'),
  acct_responses: gauge(exact('responses'), '/s', 'Responses'),
  acct_timeouts: gauge(exact('timeouts'), '/s', 'Timeouts'),
});
// cLHaPrimaryUnit on AireOS: 1 primary, 2 secondary. HAPeerState on 9800: 1 healthy, 0 degraded.
add('wireless', 'Cisco_Wireless_HighAvailability', 'Cisco WLC HA', { wlc_primary_unit: state(exact('primaryUnit'), 'Primary unit') });
add('wireless', 'Cisco_C9800_HA_Peer_State', 'Cisco C9800 HA peer', { wlc_ha_peer_ok: state(exact('HAPeerState'), 'HA peer healthy') });
// Available: percent of APs joined; -1 is a script error.
add('wireless', 'ntm_wlc_ap_status_check', 'WLC AP availability', { wlc_ap_available_pct: pct(exact('Available'), 'APs available') });
// Status: 0 ok, 1 mobility tunnels down, 2 script error.
add('wireless', 'ntm_wlc_mobility_domain_check', 'WLC mobility domain', { wlc_mobility_status: state(exact('Status'), 'Mobility tunnels') });

// -- Cohesity via LogicMonitor (round 10) -------------------------------------------

// ALL UNVERIFIED: the Cohesity_DataPlatform_* and ntm_cohesity_* DataSources exist on
// the live portal (instance counts known) but no datapoint name has been read. The
// regexes are loose; the first poll records the matched names and the unmatched ones
// (Settings > Data Export). Order inside an entry matters, because a datapoint is
// claimed by the first metric that matches it (used percent before used bytes, total
// before available). State enums are unknown: logicmonitorCohesity.js prints the raw
// value in every message. Issues are NOT raised from ProtectionJobs; ICC has the
// direct Cohesity feed for backups.
add('cohesity', 'Cohesity_DataPlatform_ClusterStatus', 'Cohesity cluster status', {
  cluster_health: state(['health', 'status', 'state'], 'Cluster health'),
  cluster_nodes: gauge(['node.?count', 'nodes'], 'nodes', 'Nodes'),
}, { history: true });
add('cohesity', 'Cohesity_DataPlatform_BasicStorage', 'Cohesity cluster storage', {
  cap_used_pct: pct(['used.?pct', 'percent.?used', 'utilization', 'usage.?pct'], 'Capacity used'),
  cap_used_bytes: gauge(['used.?bytes', 'used'], 'bytes', 'Used'),
  cap_total_bytes: gauge(['total', 'capacity'], 'bytes', 'Total'),
  cap_avail_bytes: gauge(['avail', 'free'], 'bytes', 'Available'),
  dedupe_ratio: gauge(['dedup', 'reduction', 'ratio'], 'x', 'Data reduction'),
}, { history: true });
add('cohesity', 'Cohesity_DataPlatform_NodeStatus', 'Cohesity node status', {
  node_status: state(['status', 'state', 'health'], 'Node status'),
  node_cpu_pct: pct(['cpu'], 'Node CPU'),
  node_mem_pct: pct(['mem'], 'Node memory'),
  node_uptime: gauge(['uptime'], 's', 'Node uptime'),
}, { history: true });
add('cohesity', 'Cohesity_DataPlatform_Fans', 'Cohesity fans', {
  fan_state: state(['status', 'state'], 'Fan state'),
  fan_rpm: gauge(['rpm', 'speed'], 'rpm', 'Fan speed'),
});
add('cohesity', 'Cohesity_DataPlatform_PowerSupplies', 'Cohesity power supplies', {
  psu_state: state(['status', 'state'], 'PSU state'),
});
add('cohesity', 'ntm_cohesity_node_services', 'Cohesity node services', {
  service_state: state(['status', 'state', 'running', 'up'], 'Service state'),
}, { maxInstances: 500 });
add('cohesity', 'Cohesity_DataPlatform_ProtectionJobs', 'Cohesity protection jobs', {
  job_status: state(['status', 'state', 'result'], 'Job status'),
  job_last_run: gauge(['last.?run', 'age', 'since'], 's', 'Since last run'),
});
add('cohesity', 'ntm_cohesity_alerts', 'Cohesity alerts', {
  alert_count: gauge(['count', 'alerts'], 'alerts', 'Alerts'),
});
add('cohesity', 'Cohesity_DataPlatform_Troubleshooter', 'Cohesity troubleshooter', {
  trouble_state: state(['status', 'state'], 'Troubleshooter state'),
});

// -- Cloud circuits (round 9) -------------------------------------------------------

// ALL UNVERIFIED: no AWS Direct Connect / Azure ExpressRoute DataSource has been
// read from a live portal. Names are case-insensitive regex alternatives; the
// first live poll records the matched datapoints and the unmatched ones.
// connectionState / BGP enums are unknown, so states keep the raw number and
// logicmonitorCloud.js treats /down|unavailable|0/ as down. The virtual
// interface entry comes before the connection entry because a VIF DataSource
// name also contains "DirectConnect".
add('cloud', /VirtualInterface/i, 'AWS Direct Connect virtual interface', {
  vif_state: state(['vifState', 'virtualInterfaceState', 'state'], 'Virtual interface state'),
  vif_bps_in: gauge(['VirtualInterfaceBpsIngress', 'BitsIn', 'bpsIn', 'ingress'], 'bps', 'In'),
  vif_bps_out: gauge(['VirtualInterfaceBpsEgress', 'BitsOut', 'bpsOut', 'egress'], 'bps', 'Out'),
  vif_bgp: state(['bgp'], 'BGP'),
}, { history: true });
add('cloud', /DirectConnect/i, 'AWS Direct Connect', {
  dx_state: state(['connectionState', 'state'], 'Connection state'),
  dx_bps_in: gauge(['BitsIn', 'bpsIn', 'ConnectionBpsIngress'], 'bps', 'In'),
  dx_bps_out: gauge(['BitsOut', 'bpsOut', 'ConnectionBpsEgress'], 'bps', 'Out'),
  dx_light_in: gauge(['LightLevelRx'], 'dBm', 'Light level Rx'),
  dx_light_out: gauge(['LightLevelTx'], 'dBm', 'Light level Tx'),
  dx_errors: gauge(['ConnectionErrorCount', 'CRC'], 'errors', 'Errors'),
}, { history: true });
add('cloud', /ExpressRoute/i, 'Azure ExpressRoute', {
  er_bps_in: gauge(['BitsInPerSecond', 'BitsIn'], 'bps', 'In'),
  er_bps_out: gauge(['BitsOutPerSecond', 'BitsOut'], 'bps', 'Out'),
  // UNVERIFIED datapoint names: the Peering DataSource (Microsoft_Azure_ExpressRouteCircuitPeering)
  // also lands here by regex; round 10 widened the BGP and ARP matchers.
  er_bgp: state(['bgp', 'availability', 'state'], 'BGP availability'),
  er_arp: state(['arp'], 'ARP availability'),
}, { history: true });
// Round 10: the Azure ECX connection utilisation DataSource (seen on the first live portal, 1 instance
// per circuit). ALL datapoint names UNVERIFIED; loose matchers learn on the first poll.
add('cloud', /ntm_cloud_connectivity_azure_ecx/i, 'Azure ECX connection utilization', {
  ecx_util_pct: pct(['util', 'utilization', 'percent'], 'Utilization'),
  ecx_bps_in: gauge(['^in$', 'bits?.?in', 'in.?bps', 'ingress', 'inbound', 'rx'], 'bps', 'In'),
  ecx_bps_out: gauge(['^out$', 'bits?.?out', 'out.?bps', 'egress', 'outbound', 'tx'], 'bps', 'Out'),
}, { history: true });

// -- Applications and appliances (lm11-apps) -------------------------------------------

// Round 11 WP-X. ALL UNVERIFIED and BLIND: none of these DataSources exists on the first live
// portal (SQL Server and Splunk devices exist but have no instances; Hyper-V, XenServer, IronPort
// and EMC are absent). The DataSource names are LogicMonitor's standard names as remembered, matched
// loosely by regex; every datapoint regex is a loose alternative list and the first live poll
// records the matched and unmatched names (Settings > Data Export). Order inside an entry
// matters: a datapoint is claimed by the first metric that matches it. State enums are unknown,
// so logicmonitorApps.js prints the raw value in every message.
add('apps', /^Microsoft_SQLServer|^MSSQL|SQLServer/i, 'Microsoft SQL Server', {
  sql_state: state(['status', 'state', 'running'], 'Service state'),
  sql_connections: gauge(['connections', 'users'], 'connections', 'Connections'),
  sql_batch_rate: gauge(['batch', 'request'], '/s', 'Batch requests'),
  sql_buffer_hit_pct: pct(['buffer', 'cache.?hit'], 'Buffer cache hit'),
  sql_blocked: gauge(['blocked', 'deadlock'], 'processes', 'Blocked processes'),
  sql_db_size: gauge(['size', 'space'], 'bytes', 'Database size'),
  sql_backup_age_h: gauge(['last.?backup', 'backup'], 'h', 'Hours since backup'),
}, { history: true, maxInstances: 500 });
add('apps', /splunk/i, 'Splunk', {
  splunk_indexing_rate: gauge(['index', 'ingest', 'kb'], 'KB/s', 'Indexing rate'),
  splunk_queue_fill_pct: pct(['queue', 'fill'], 'Queue fill'),
  splunk_search_concurrency: gauge(['search', 'concurr'], 'searches', 'Search concurrency'),
  splunk_license_used_pct: pct(['license', 'quota'], 'License used'),
}, { maxInstances: 500 });
add('apps', /hyper-?v/i, 'Hyper-V', {
  hv_vm_state: state(['state', 'status'], 'VM state'),
  hv_cpu_pct: pct(['cpu'], 'CPU'),
  hv_mem_pct: pct(['mem'], 'Memory'),
}, { maxInstances: 1000 });
add('apps', /xen/i, 'XenServer', {
  xen_host_state: state(['status', 'state', 'enabled'], 'Host state'),
  xen_cpu_pct: pct(['cpu'], 'CPU'),
  xen_mem_pct: pct(['mem'], 'Memory'),
  xen_vm_count: gauge(['vm', 'guest'], 'VMs', 'VMs'),
}, { maxInstances: 500 });
add('apps', /ironport|cisco_esa|email.?security/i, 'Cisco IronPort / ESA', {
  esa_queue: gauge(['queue', 'workqueue'], 'messages', 'Work queue'),
  esa_cpu_pct: pct(['cpu'], 'CPU'),
  esa_mem_pct: pct(['mem'], 'Memory'),
  esa_msgs_rate: gauge(['message', 'msg'], '/s', 'Message rate'),
  esa_quarantine_pct: pct(['quarantine'], 'Quarantine used'),
}, { maxInstances: 200 });
// The Cisco guard keeps Cisco Unity Connection DataSources out of the EMC Unity entry.
add('apps', /^emc|^(?!cisco).*(unity|vnx|isilon|powerstore|data.?domain)/i, 'EMC / Dell storage', {
  emc_health: state(['health', 'status', 'state'], 'Health'),
  emc_cap_used_pct: pct(['percent', 'used', 'util', 'capacity'], 'Capacity used'),
  emc_disk_faults: gauge(['fault', 'fail', 'degrad'], 'disks', 'Disk faults'),
  emc_temp: gauge(['temp'], 'C', 'Temperature'),
}, { maxInstances: 500 });

// -- Voice, Zscaler, ISE (lm11-sections) -----------------------------------------------

// Round 11 WP-V. Every datapoint regex below is UNVERIFIED: the datapoint names of the ntm_*
// DataSources are unknown until the first poll, so each matcher is a loose alternative list and
// the raw store (lm_ds_values) keeps whatever it does not claim. State enums are unknown, so
// logicmonitorAppliances.js prints the raw value in every message.

// Oracle SBC steering pools: the loose ntm_sbc_ entry in the voice block has no pool metrics. An
// exact entry wins over that pattern entry.
add('voice', 'ntm_sbc_steering_pool_performance', 'SBC steering pool performance', {
  sbc_pool_util_pct: pct(['util', 'percent', 'usage'], 'Pool utilization'),
  sbc_pool_sessions: gauge(['session', 'call', 'active'], 'sessions', 'Pool sessions'),
  sbc_pool_failures: counter(['fail', 'error', 'reject'], 'req', 'Pool failures'),
});
// GANC checks (UNVERIFIED names). The WLC RADIUS servers of a GANC are already in the wireless block.
add('voice', 'ntm_ganc_mobility_domain_check', 'GANC mobility domain', {
  ganc_mobility_state: state(['status', 'state', 'mobility', 'tunnel'], 'Mobility domain'),
});
add('voice', 'ntm_ganc_ise_radius_check', 'GANC ISE RADIUS check', {
  ganc_radius_state: state(['status', 'state', 'result', 'radius', 'auth'], 'ISE RADIUS check'),
});

add('security', 'Cisco_ISE_ServerSessions', 'Cisco ISE sessions', {
  sessions: gauge(['session', 'active'], 'sessions', 'Active sessions'),
}, { history: true });
add('security', 'Cisco_ISE_Disk', 'Cisco ISE disk', {
  disk_used_pct: pct(['percent', 'used', 'util'], 'Disk used'),
}, { maxInstances: 400 });
add('security', 'ntm_ise_application_and_certificate_status', 'ISE application and certificates', {
  app_state: state(['app', 'status'], 'Application state'),
  cert_days: gauge(['days', 'expir'], 'days', 'Certificate days left'),
});
add('security', 'ntm_cisco_ise_eap_certificate', 'ISE EAP certificate', {
  eap_cert_days: gauge(['days', 'expir'], 'days', 'EAP certificate days left'),
});
add('security', 'ntm_deployment_nodes_status', 'ISE deployment nodes', {
  node_state: state(['status', 'state'], 'Deployment node state'),
});
add('security', 'ntm_cisco_ise_memory_cpu', 'ISE memory and CPU', {
  cpu_pct: pct(['cpu'], 'CPU'),
  mem_pct: pct(['mem'], 'Memory'),
}, { history: true });
add('security', 'ntm_zpa_app_connector', 'Zscaler ZPA app connector', {
  connector_state: state(['status', 'state', 'health'], 'Connector state'),
});
add('security', 'Zscaler ZPA Port Exhaustion', 'Zscaler ZPA port exhaustion', {
  port_used_pct: pct(['percent', 'used', 'exhaust'], 'Ports used'),
}, { history: true });
add('security', 'ntm_zpa_ntp_time_sync', 'Zscaler ZPA NTP sync', {
  ntp_offset: gauge(['offset', 'drift'], 's', 'NTP offset'),
  ntp_state: state(['status', 'sync'], 'NTP state'),
});
add('security', 'ntm_asa_license_authorization', 'ASA license authorization', {
  asa_license_state: state(['status', 'state', 'auth'], 'License authorization'),
});

// -- Servers (lm11-servers) ------------------------------------------------------

// Round 11. Linux servers under Net-SNMP are verified at the DataSource level on the live
// sandbox (names and instance counts) but NO datapoint name has been read; the Windows
// entries are built blind from LM's standard DataSource names (the sandbox returned zero
// instances on every Windows device). EVERY regex below is UNVERIFIED. Existing health
// entries are reused, not duplicated: NetSNMPCPUwithCores (cpu_pct), NetSNMP_Memory_Usage
// (mem_pct), SNMP_Host_Uptime (uptime_s) and SNMP_Filesystem_Usage (fs_used_pct plus the
// byte metrics, which stay in the health family so the existing DataSource lists hold).
// State enums are unknown: logicmonitorServers.js prints the raw value in every message.
add('os', 'SNMP_Filesystem_Status', 'SNMP filesystem status', {
  fs_not_accessible: state(exact('StorageNotAccessible'), 'Filesystem not accessible'),
  fs_status: state(['status', 'state'], 'Filesystem status'),
}, { maxInstances: 400 });
add('os', 'NetSNMPdiskIO-', 'Net-SNMP disk I/O', {
  disk_read_bps: gauge(['read'], 'B/s', 'Disk read'),
  disk_write_bps: gauge(['write'], 'B/s', 'Disk write'),
  disk_busy_pct: pct(['busy', 'util'], 'Disk busy'),
}, { maxInstances: 400 });
add('os', 'Linux_Sensors_Temperature', 'Linux temperature sensors', {
  temp_c: gauge(['temp'], 'C', 'Temperature'),
}, { maxInstances: 400 });
add('os', 'snmpHR_NFSMount-', 'NFS mounts', {
  nfs_mount_state: state(['status', 'state', 'mounted'], 'NFS mount state'),
}, { maxInstances: 400 });
// LM HostStatus is a ping-based idle check: the datapoint name is a guess.
add('os', 'HostStatus', 'Host status', {
  host_status: state(['status', 'state'], 'Host status'),
});
// Windows (blind, standard LM names).
add('os', 'WinCPU', 'Windows CPU', {
  cpu_pct: pct(['CPUBusyPercent', 'cpu'], 'CPU'),
}, { history: true });
add('os', 'WinMemory', 'Windows memory', {
  mem_pct: pct(['MemoryUtilization', 'percent', 'used'], 'Memory used'),
}, { history: true });
add('os', 'WinVolumeUsage-', 'Windows volumes', {
  vol_used_pct: pct(['PercentUsed', 'percent', 'used'], 'Volume used'),
  vol_free_bytes: gauge(['FreeSpace', 'free'], 'bytes', 'Free space'),
}, { history: true, maxInstances: 400 });
add('os', 'WinServices-', 'Windows services', {
  svc_state: state(['State', 'status'], 'Service state'),
}, { maxInstances: 1000 });
add('os', 'WinSystemUptime', 'Windows uptime', {
  uptime_s: gauge(['Uptime'], 's', 'Uptime'),
});
add('os', 'WinProcessStats-', 'Windows processes', {
  proc_count: gauge(['ProcessCount', 'count'], 'processes', 'Processes'),
}, { maxInstances: 400 });
add('os', 'WinEventLog-', 'Windows event log', {
  events: gauge(['EventCount', 'count'], 'events', 'Events'),
}, { maxInstances: 400 });

// -- Lookup ----------------------------------------------------------------------

const EXACT = new Map();
const PREFIX = [];
const PATTERN = [];
for (const e of CATALOG) {
  if (e.match instanceof RegExp) PATTERN.push(e);
  else if (String(e.match).endsWith('-')) PREFIX.push(e);
  else EXACT.set(String(e.match).toLowerCase(), e);
}
PREFIX.sort((a, b) => String(b.match).length - String(a.match).length);

/** Catalog entry for a DataSource name, or null. Exact match first, then the
 *  longest '-' prefix entry, then regex entries in declaration order. */
function catalogFor(datasourceName) {
  if (datasourceName == null) return null;
  const name = String(datasourceName).trim();
  if (!name) return null;
  const lower = name.toLowerCase();
  const hit = EXACT.get(lower);
  if (hit) return hit;
  for (const e of PREFIX) if (lower.startsWith(String(e.match).toLowerCase())) return e;
  // A prefix entry also matches the bare name without its trailing dash.
  for (const e of PREFIX) if (lower === String(e.match).toLowerCase().slice(0, -1)) return e;
  for (const e of PATTERN) if (e.match.test(name)) return e;
  return null;
}

/** Instance key from a data response key: strip the "<DataSource>-" prefix
 *  (case-insensitive) and a trailing " [ID:n]" suffix. */
function cleanInstanceKey(rawKey, dsName) {
  let k = String(rawKey == null ? '' : rawKey);
  k = k.replace(/\s*\[ID:\s*\d+\]\s*$/, '');
  const ds = dsName == null ? '' : String(dsName);
  if (ds) {
    for (const p of [`${ds}-`, ds.endsWith('-') ? ds : null]) {
      if (p && k.toLowerCase().startsWith(p.toLowerCase())) { k = k.slice(p.length); break; }
    }
  }
  return k;
}

module.exports = { CATALOG_VERSION, FAMILIES, FAMILY_LABELS, CLOUD_ERT_RE, CATALOG, catalogFor, cleanInstanceKey, DEFAULT_MAX_INSTANCES };
