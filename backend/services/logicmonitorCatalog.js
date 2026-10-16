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

const FAMILIES = ['firewall', 'loadbalancer', 'health', 'optics', 'routing', 'ipsla', 'voice', 'wireless'];

const FAMILY_LABELS = {
  firewall: 'Firewalls',
  loadbalancer: 'Load balancers',
  health: 'Device health',
  optics: 'Optics',
  routing: 'Routing',
  ipsla: 'IP SLA',
  voice: 'Voice',
  wireless: 'Wireless',
};

const DEFAULT_MAX_INSTANCES = 2500;

// Every metric regex is forced case-insensitive, string or RegExp alike.
const re = (x) => new RegExp(x instanceof RegExp ? x.source : x, 'i');
const m = (match, kind, unit, label) => ({ match: Array.isArray(match) ? match.map(re) : re(match), kind, unit: unit || '', label });
const gauge = (match, unit, label) => m(match, 'gauge', unit, label);
const state = (match, label) => m(match, 'state', '', label);
const counter = (match, unit, label) => m(match, 'counter', unit, label);
const pct = (match, label) => m(match, 'pct', '%', label);

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
  mgmt_cpu_pct: pct(['mgmt.*cpu', 'management.*cpu', 'cpu.*mgmt', '^cpu'], 'Management CPU'),
  mem_pct: pct(['mem.*(used|util|percent|pct)', '^mem(ory)?$'], 'Memory used'),
  swap_pct: pct(['swap'], 'Swap used'),
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

add('firewall', 'PaloAlto_FW_Power', 'PAN power supplies', {
  psu_state: state(['state', 'status', 'alarm'], 'PSU state'),
});

add('firewall', 'PaloAlto_FW_ChassisPower', 'PAN chassis power', {
  chassis_watts: gauge(['watt', 'power', 'consum'], 'W', 'Chassis power'),
});

add('firewall', 'PaloAlto_FW_Temperature', 'PAN temperature', {
  temp_c: gauge(['temp(erature)?(.?c)?$', 'celsius', 'temp'], 'C', 'Temperature'),
  temp_alarm: state(['alarm', 'status', 'state'], 'Temperature alarm'),
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
  cpu_pct: pct(['cpu.*(util|percent|pct|used|usage)', 'cpu'], 'CPU'),
  mem_pct: pct(['mem.*(util|percent|pct|used|usage)', 'mem'], 'Memory'),
  client_connections: gauge(['client.*conn', 'curr.*client', 'clientside'], 'conns', 'Client connections'),
  server_connections: gauge(['server.*conn', 'curr.*server', 'serverside'], 'conns', 'Server connections'),
  throughput_bps: gauge(['throughput', 'bits', 'bps'], 'bps', 'Throughput'),
}, { history: true });

add('loadbalancer', 'F5_BigIP_FailoverStatus', 'F5 failover', {
  // LM enum (UNVERIFIED): 0 unknown, 1 offline, 2 forced offline, 3 standby, 4 active.
  failover_state: state(['failover', 'unit.?state', 'state', 'status'], 'Failover state'),
  sync_state: state(['sync'], 'Sync state'),
});

add('loadbalancer', 'F5_BigIP_PoolMemberStats', 'F5 pool members', {
  member_avail: state(['avail', 'status', 'state'], 'Member available'),
  member_enabled: state(['enabled', 'enable'], 'Member enabled'),
  member_connections: gauge(['conn'], 'conns', 'Connections'),
  member_bits_in: gauge(['bits.?in', 'in.?bits', 'bytes.?in', 'in.?bytes'], 'bps', 'Bits in'),
  member_bits_out: gauge(['bits.?out', 'out.?bits', 'bytes.?out', 'out.?bytes'], 'bps', 'Bits out'),
}, { maxInstances: 5000 });

add('loadbalancer', 'F5_GTM_WideIP-', 'F5 GTM wide IPs', {
  wideip_avail: state(['avail', 'status', 'state'], 'Wide IP available'),
  wideip_requests: counter(['request'], 'req', 'Requests'),
}, { maxInstances: 5000 });

add('loadbalancer', 'F5_GTM_VIPs-', 'F5 GTM VIPs', {
  vip_avail: state(['avail', 'status', 'state'], 'VIP available'),
  vip_enabled: state(['enabled', 'enable'], 'VIP enabled'),
}, { maxInstances: 5000 });

add('loadbalancer', 'F5_GTM_Servers-', 'F5 GTM servers', {
  gtm_server_avail: state(['avail', 'status', 'state'], 'GTM server available'),
});

add('loadbalancer', 'F5_GTM_Datacenters-', 'F5 GTM datacenters', {
  dc_avail: state(['avail', 'status', 'state'], 'Datacenter available'),
});

add('loadbalancer', 'F5_GTM_Global', 'F5 GTM global', {
  gtm_requests: counter(['request'], 'req', 'Requests'),
  gtm_resolutions: counter(['resol'], 'res', 'Resolutions'),
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

add('loadbalancer', 'F5_BigIP_Memory', 'F5 memory', {
  tmm_mem_pct: pct(['tmm.*(percent|pct|util|used)', 'tmm'], 'TMM memory'),
  host_mem_pct: pct(['host.*(percent|pct|util|used)', 'host', 'other'], 'Host memory'),
}, { history: true });

add('loadbalancer', 'F5_BigIP_Filesystem', 'F5 filesystem', {
  fs_used_pct: pct(['used', 'percent', 'util'], 'Filesystem used'),
});

add('loadbalancer', 'F5_BigIP_Interfaces', 'F5 interfaces', {
  if_status: state(['status', 'state'], 'Interface status'),
  if_in_bps: gauge(['in.?(bps|bits|rate)', '^in$', 'bits.?in'], 'bps', 'In'),
  if_out_bps: gauge(['out.?(bps|bits|rate)', '^out$', 'bits.?out'], 'bps', 'Out'),
});

add('loadbalancer', 'F5_BigIP_Fans', 'F5 fans', { fan_state: state(['status', 'state'], 'Fan state') });
add('loadbalancer', 'F5_BigIP_Power', 'F5 power supplies', { psu_state: state(['status', 'state'], 'PSU state') });
add('loadbalancer', 'F5_BigIP_Temperature', 'F5 temperature', { temp_c: gauge(['temp'], 'C', 'Temperature') });

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
  cpu_pct: pct(['^cpu$', 'util', 'usage', 'idle', 'cpu'], 'CPU'),
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
  mem_pct: pct([/percent.?used|used.?percent|pct.?used|memory.?util|util/, /percent.?free|free.?percent|pct.?free/, /percent|usage/], 'Memory used'),
}, { history: true });

add('health', 'Cisco_FRU_Power', 'Cisco FRU power', { psu_state: state(['status', 'state', 'oper'], 'PSU state') }, { maxInstances: 5000 });
add('health', 'Cisco_Nexus_FRU_Power', 'Cisco Nexus FRU power', { psu_state: state(['status', 'state', 'oper'], 'PSU state') });
add('health', 'Cisco_System_PowerSupplies', 'Cisco power supplies', { psu_state: state(['status', 'state', 'oper'], 'PSU state') });
add('health', 'CiscoFan-', 'Cisco fans', { fan_state: state(['status', 'state', 'oper'], 'Fan state') });
add('health', 'Cisco_TemperatureSensors', 'Cisco temperature sensors', {
  temp_c: gauge(['temp(erature)?$', 'temp(erature)?.?c', 'celsius', 'value', 'temp'], 'C', 'Temperature'),
  temp_state: state(['state', 'status'], 'Temperature state'),
});
add('health', 'Cisco_Entity_Sensors', 'Cisco entity sensors', {
  sensor_value: gauge(['value', 'reading'], '', 'Sensor value'),
  sensor_state: state(['status', 'state', 'oper'], 'Sensor state'),
}, { maxInstances: 5000 });
add('health', 'Brocade Sensors-', 'Brocade sensors', { sensor_state: state(['status', 'state'], 'Sensor state') });
add('health', 'Cisco_Nexus_Line_Card_Status', 'Cisco Nexus line cards', { linecard_state: state(['status', 'state', 'oper'], 'Line card state') });
add('health', 'Cisco_Nexus_Supervisor_Status', 'Cisco Nexus supervisors', { sup_state: state(['status', 'state', 'oper'], 'Supervisor state') });
add('health', 'Cisco Switch Stack-', 'Cisco switch stack', { stack_member_state: state(['state', 'status', 'role'], 'Stack member state') });
add('health', 'Cisco Switch Stack Ports-', 'Cisco switch stack ports', { stack_port_state: state(['state', 'status', 'oper'], 'Stack port state') });
add('health', 'Cisco_PowerOverEthernet', 'Cisco PoE', {
  poe_used_pct: pct(['percent', 'pct', 'util'], 'PoE used'),
  poe_used_watts: gauge(['consum', 'used', 'watt', 'power'], 'W', 'PoE used'),
});
add('health', 'Cisco_Catalyst_PowerOverEthernet', 'Cisco Catalyst PoE', {
  poe_used_pct: pct(['percent', 'pct', 'util'], 'PoE used'),
  poe_used_watts: gauge(['consum', 'used', 'watt', 'power'], 'W', 'PoE used'),
});
add('health', 'SNMP_Filesystem_Usage', 'SNMP filesystem usage', { fs_used_pct: pct(['percent.?used', 'used.?percent', 'pct', 'percent', 'util'], 'Filesystem used') });
add('health', 'SNMP_Host_Uptime', 'SNMP host uptime', { uptime_s: gauge(['uptime'], 's', 'Uptime') });

// -- Optics ----------------------------------------------------------------------

add('optics', 'Cisco_Transceiver_Sensors', 'Cisco transceivers', {
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
  bgp_peer_state: state(['peer.?state', 'state', 'status'], 'BGP peer state'),
  bgp_established_s: gauge(['established', 'uptime', 'elapsed'], 's', 'Established time'),
  bgp_prefixes_in: gauge(['prefix', 'received', 'accepted'], 'prefixes', 'Prefixes in'),
});
add('routing', 'OSPF_Neighbors', 'OSPF neighbours', {
  // OSPF-MIB ospfNbrState: 8 = full.
  ospf_nbr_state: state(['state', 'status'], 'OSPF neighbour state'),
});
add('routing', 'Cisco_EIGRP_Peers', 'EIGRP peers', { eigrp_uptime_s: gauge(['uptime', 'up.?time'], 's', 'Peer uptime') });
add('routing', 'ntm_CX_BGP', 'Cisco CX BGP', { bgp_peer_state: state(['state', 'status'], 'BGP peer state') });
add('routing', 'ntm_CX_BGP_Peering', 'Cisco CX BGP peering', { bgp_peer_state: state(['state', 'status'], 'BGP peer state') });

// -- IP SLA ----------------------------------------------------------------------

add('ipsla', 'CiscoSLA_jitter-', 'Cisco IP SLA jitter', {
  rtt_ms: gauge(['rtt', 'latency', 'delay'], 'ms', 'RTT'),
  jitter_ms: gauge(['jitter'], 'ms', 'Jitter'),
  loss_pct: pct(['loss', 'drop'], 'Packet loss'),
  mos: gauge(['mos'], '', 'MOS'),
}, { history: true });
const slaMetrics = () => ({
  rtt_ms: gauge(['rtt', 'latency', 'delay', 'completion'], 'ms', 'RTT'),
  loss_pct: pct(['loss', 'drop'], 'Packet loss'),
  sla_state: state(['state', 'status', 'oper', 'timeout'], 'SLA state'),
});
add('ipsla', 'Cisco_IPSLA_Statistics', 'Cisco IP SLA', slaMetrics(), { history: true });
add('ipsla', 'Groovy_Cisco_IPSLA_Statistics', 'Cisco IP SLA (groovy)', slaMetrics(), { history: true });
add('ipsla', 'ntm_ipsla_svd', 'IP SLA SVD', slaMetrics(), { history: true });
add('ipsla', 'CiscoSLA_ICMPEcho-', 'Cisco IP SLA ICMP echo', slaMetrics(), { history: true });
add('ipsla', 'IPSLA_WAN', 'IP SLA WAN', slaMetrics(), { history: true });

// -- Voice -----------------------------------------------------------------------

// The nine Cisco_SIP_* DataSources: exact suffixes are not known, so one
// entry matches the prefix and maps datapoints by name. Each DataSource
// exposes one or two of these counters.
add('voice', /^Cisco_SIP_/i, 'Cisco SIP', {
  sip_connections: counter(['connection'], 'conns', 'Connections'),
  sip_client_errors: counter(['client.?err', '4xx'], 'req', 'Client errors'),
  sip_server_errors: counter(['server.?err', '5xx'], 'req', 'Server errors'),
  sip_successes: counter(['success', '2xx'], 'req', 'Successes'),
  sip_retries: counter(['retr'], 'req', 'Retries'),
  sip_redirects: counter(['redirect', '3xx'], 'req', 'Redirects'),
  sip_global_fail: counter(['global.?fail', 'fail'], 'req', 'Global failures'),
  sip_traffic_in: counter(['in(bound)?.?(traffic|bytes|msgs?|messages?)', 'traffic.?in', 'received'], 'msgs', 'Traffic in'),
  sip_traffic_out: counter(['out(bound)?.?(traffic|bytes|msgs?|messages?)', 'traffic.?out', 'sent'], 'msgs', 'Traffic out'),
});
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

const exact = (name) => `^${name}$`;

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

module.exports = { FAMILIES, FAMILY_LABELS, CATALOG, catalogFor, cleanInstanceKey, DEFAULT_MAX_INSTANCES };
