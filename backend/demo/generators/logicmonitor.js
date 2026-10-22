// LogicMonitor scope demo data (contract section 13). One portal "Acme Network
// Ops" (company acmeops) with 6 collectors, 12 device groups and 140 monitored
// devices plus the 2 LM Uptime ping-check devices; a second portal "Acme Lab"
// whose last poll failed, so source-unreachable has a real trigger. Everything
// is deterministic (rngFor) and safe to re-run after the seedDemo wipe.
//
// Deliberate trouble, one item per issue rule in services/logicmonitorIssues.js
// and services/logicmonitorChecks.js:
//   source-unreachable        Acme Lab last_poll_status 'error'
//   collector-down            tus-col01 is_down = 1, its 14 devices dead-collector
//   collector-build-behind    slc-col01 on 39.005 while MGD is 41.000
//   device-dead               den-acc-02 (3 days), phx-acc-07 (5 h), slc-ap-01 (40 min);
//                             phx-batch-02 is a dead server (warning)
//   device-in-sdt             5 devices in a ResourceSDT
//   device-new                den-acc-03 and phx-k8s-node-07 first seen 1-2 days ago
//   interface-utilization-high phx-core-01 Te1/0/46 out 91%, dal-dist-01 Te1/0/47 in 87%
//   interface-errors-growing  phx-acc-05 Te1/1/1, slc-acc-01 Te1/1/1, dal-acc-02 Gi1/0/9
//   interface-flapping        phx-acc-03 Gi1/0/17, abq-acc-01 Gi1/0/18
//   alert-storm               55 InDiscards alerts on the DAL access layer in the last 15 min
//   check-down                "DAL file services" Overall down + 2 open websiteAlerts
//   check-location-down       "PHX ERP VIP" fails from abq-col01 while Overall is up
//   latency-anomaly           "DAL DR replication link" 3x baseline for the last 2 hours
//   packet-loss-anomaly       "PHX VoIP gateway" 15% loss from slc-col01 for 2 hours
//   location-degraded         3 checks from den-col01 slow at once (fold)
//   location-latency          6 checks from den-col01 elevated now (agent signals: the probe location is the story)
//   link-burst                6 interfaces on dal-acc-01..03 went down inside the last 20 minutes (agent signals)
// Round 9 latency watch (generators/logicmonitorWatchDemo.js): latency-degrading "NYC ... reachability @ phx-col01"
//   (1.85x for 41 min, open episode), latency-pattern "DAL core reachability @ abq-col01" (four one-off spikes in
//   6 days), latency-drift "PHX core reachability @ abq-col01" (35% above the earlier weeks for 7 days).
// Round 9 WP7 (generators/logicmonitorIpslaCloudDemo.js): IP SLA probe on slc-rtr-01 at 1.9x its baseline for 2 hours
//   (open latency-degrading episode, den-rtr-01 probe clean); AWS Direct Connect dx-phx-prod-1/2 and dx-dal-prod-1
//   (device_type 2; dal reads state 0 = cloud-circuit-down, phx-2 at 87% of 1 Gbps = cloud-circuit-saturated) and
//   Azure ExpressRoute er-phx-azure-east / er-dal-azure-south (device_type 4), each with 7 days of throughput history.
// Round 8 (DataSource metrics): five Palo Alto firewalls (phx-fw-01/02, dal-fw-01/02, den-fw-01) and
//   lm_ds_* rows for firewalls, the four F5s, Cisco device health, core and distribution optics, BGP and
//   OSPF, with 7 days of history on the history metrics. Issues: fw-ha-degraded phx-fw-02 (peer),
//   fw-session-high phx-fw-01 87%, fw-tunnel-down dal-fw-01 (3 of 24), fw-config-unsynced den-fw-01,
//   lb-pool-degraded dal-f5-01 (app-payments all down, web-portal 1 of 6), lb-cert-expiring phx-f5-01,
//   hardware-fault dal-dist-02 PS2, bgp-peer-down dal-wan-rtr-02, device-cpu-high phx-core-01.
// Round 3 (sites, dependency suppression, circuits, baselines, webhook):
//   abq-dist-01 + abq-acc-03..05 dead for 25 min with 4 Host Status and 20 interface
//   Status alerts (computeShadows collapses them under abq-dist-01); WAN circuits on
//   the phx/dal routers (phx-wan-rtr-01 Gi0/0/0 saturated, den-rtr-01 Gi0/0/0
//   unresolved); phx-acc-06 Gi1/0/20 util anomaly and phx-acc-08 Gi1/0/25 error
//   anomaly; two backup windows on nyc-esx-0101 / lon-esx-0101 ports; webhook source
//   (token demo-webhook-token); config_changes rows; data quality gaps (3 devices in
//   no site group, 2 switches without LLDP/CDP, 2 checks with too few samples).
// History: interface history at 15 min for 40 interfaces x 30 days plus 60
// interfaces x 24 h plus 7 WAN circuits x 30 days and 6 ports x 8 days (about 146k
// rows); check history at 5 min for 16 locations x 30 days plus the rest for
// 2 days (about 172k rows).
const crypto = require('crypto');
const { rngFor, randInt, randFloat, pick, chance } = require('./core');

const SOURCE_NAME = 'Acme Network Ops';
const LAB_NAME = 'Acme Lab';
const MGD = '41.000';
const IF_STEP_MIN = 15;
const CHECK_STEP_MIN = 5;
const IF_COLUMNS = [
  'InOctets', 'OutOctets', 'InMbps', 'OutMbps', 'InErrors', 'OutErrors', 'InDiscards', 'OutDiscards',
  'InUtilizationPercent', 'OutUtilizationPercent', 'Status', 'InInterfaceSpeed', 'OutInterfaceSpeed',
];
const CHECK_COLUMNS = {
  ping: { rtt_avg_ms: 'avgRTT', rtt_min_ms: 'minRTT', rtt_max_ms: 'maxRTT', sent: 'sendPkts', received: 'recdPkts', status: 'status' },
  web: { response_ms: 'responseTime', status: 'status' },
};

// Missing WP1 modules are tolerated (the six packages build in parallel);
// each is reported once so the seed still completes.
const warned = new Set();
function optionalModule(rel) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(rel);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(rel.split('/').pop())) {
      if (!warned.has(rel)) {
        warned.add(rel);
        console.warn(`[seedDemo] logicmonitor: ${rel} not present yet, skipping that step`);
      }
      return null;
    }
    throw err;
  }
}

const lmApi = optionalModule('../../services/logicmonitorApi');

const SITES = {
  phx: { label: 'Phoenix DC', net: '10.10', collectorId: 11 },
  dal: { label: 'Dallas DC', net: '10.20', collectorId: 12 },
  den: { label: 'Denver', net: '10.31', collectorId: 21, group: 'Network/Branch/Denver' },
  slc: { label: 'Salt Lake City', net: '10.32', collectorId: 22, group: 'Network/Branch/SaltLake' },
  abq: { label: 'Albuquerque', net: '10.33', collectorId: 23, group: 'Network/Branch/Albuquerque' },
  tus: { label: 'Tucson', net: '10.34', collectorId: 24, group: 'Network/Branch/Tucson' },
  // The vCenter demo's nyc and lon data centres (generators/vcenter.js); their
  // access switches carry the ESXi and Dell server ports. Collected by the
  // PHX and DAL collectors. acc-01/02 IPs (.12/.13) are mirrored in vcenter.js.
  nyc: { label: 'New York DC', net: '10.51', collectorId: 11 },
  lon: { label: 'London DC', net: '10.52', collectorId: 12 },
};
// Sites added in round 2; they draw from their own PRNG streams and stay out
// of the v1 random pools so every v1 row is generated exactly as before.
const DC2_SITES = new Set(['nyc', 'lon']);

const COLLECTORS = [
  { id: 11, host: 'phx-col01', site: 'phx', groupId: 1, build: '41.200', backup: 12, platform: 'linux' },
  { id: 12, host: 'dal-col01', site: 'dal', groupId: 1, build: MGD, backup: 11, platform: 'linux' },
  { id: 21, host: 'den-col01', site: 'den', groupId: 2, build: MGD, platform: 'windows' },
  { id: 22, host: 'slc-col01', site: 'slc', groupId: 2, build: '39.005', platform: 'windows' },
  { id: 23, host: 'abq-col01', site: 'abq', groupId: 2, build: MGD, platform: 'linux' },
  { id: 24, host: 'tus-col01', site: 'tus', groupId: 2, build: MGD, platform: 'linux', down: true },
];
const COLLECTOR_GROUPS = { 1: 'Data Center Collectors', 2: 'Branch Collectors' };
const COLLECTOR_BY_SITE = Object.fromEntries(COLLECTORS.map((c) => [c.site, c]));

const GROUPS = [
  [2, 'Network/Core'], [3, 'Network/Distribution'], [4, 'Network/Branch/Denver'],
  [5, 'Network/Branch/SaltLake'], [6, 'Network/Branch/Albuquerque'], [7, 'Network/Branch/Tucson'],
  [8, 'Network/Firewalls'], [9, 'Network/LoadBalancers'], [10, 'Network/Wireless'],
  [11, 'Servers/Windows'], [12, 'Servers/Linux'], [13, 'Cloud/AWS'],
  [14, 'Network/Sites/Phoenix DC'], [15, 'Network/Sites/Dallas DC'],
  [16, 'Network/Sites/New York DC'], [17, 'Network/Sites/London DC'],
];
const DC_SITE_GROUP = { phx: 14, dal: 15, nyc: 16, lon: 17 };
const GROUP_ID = Object.fromEntries(GROUPS.map(([id, path]) => [path, id]));

// Dead and trouble devices (display names).
const DEAD = {
  'den-acc-02': '-3 days', 'phx-acc-07': '-5 hours', 'slc-ap-01': '-40 minutes', 'phx-batch-02': '-2 days',
  'abq-dist-01': '-25 minutes', 'abq-acc-03': '-25 minutes', 'abq-acc-04': '-25 minutes', 'abq-acc-05': '-25 minutes',
};
const DEAD_MIN = {
  'den-acc-02': 4320, 'phx-acc-07': 300, 'slc-ap-01': 40, 'phx-batch-02': 2880,
  'abq-dist-01': 25, 'abq-acc-03': 25, 'abq-acc-04': 25, 'abq-acc-05': 25,
};
// Round 3 dependency scenario: abq-dist-01 dies and takes its three access switches' reports with it.
const ABQ_DOWNSTREAM = ['abq-acc-03', 'abq-acc-04', 'abq-acc-05'];
// Network devices left out of every group and every site rule (data quality list).
const NO_SITE = ['unassigned-sw-01', 'unassigned-sw-02', 'unassigned-sw-03'];
// Switches the demo leaves without LLDP/CDP datasource rows (data quality list).
const NO_NEIGHBOR_DS = new Set(['den-acc-03', 'slc-acc-03']);
const SDT_DEVICES = ['abq-acc-02', 'dal-f5-02', 'phx-sql-03', 'phx-app-07', 'dal-web-02'];
const NEW_DEVICES = { 'den-acc-03': 1, 'phx-k8s-node-07': 2 };
const BEHIND_SWITCHES = new Set(['abq-acc-01', 'abq-acc-02', 'slc-acc-03', 'dal-acc-04']);
const COLLECTOR_DOWN_MIN = 360;

const abbr = (full) => full.replace('TenGigabitEthernet', 'Te').replace('GigabitEthernet', 'Gi');
const pad2 = (n) => String(n).padStart(2, '0');

// -- Device plan --------------------------------------------------------------

function buildDevicePlan(db) {
  const devices = [];
  const add = (d) => { devices.push(d); return d; };
  for (const s of ['phx', 'dal']) {
    for (let i = 1; i <= 2; i += 1) add({ name: `${s}-core-${pad2(i)}`, site: s, kind: 'core' });
    for (let i = 1; i <= 4; i += 1) add({ name: `${s}-dist-${pad2(i)}`, site: s, kind: 'dist' });
  }
  for (let i = 1; i <= 8; i += 1) add({ name: `phx-acc-${pad2(i)}`, site: 'phx', kind: 'access' });
  for (let i = 1; i <= 4; i += 1) add({ name: `dal-acc-${pad2(i)}`, site: 'dal', kind: 'access' });
  for (const [s, n] of [['den', 3], ['slc', 3], ['abq', 2], ['tus', 4]]) {
    for (let i = 1; i <= n; i += 1) add({ name: `${s}-acc-${pad2(i)}`, site: s, kind: 'branch-access' });
  }
  for (const s of ['phx', 'dal']) for (let i = 1; i <= 2; i += 1) add({ name: `${s}-wan-rtr-${pad2(i)}`, site: s, kind: 'wan-rtr' });
  for (const s of ['den', 'slc', 'abq', 'tus']) add({ name: `${s}-rtr-01`, site: s, kind: 'branch-rtr' });
  for (const n of ['phx-asa-01', 'phx-asa-02', 'dal-asa-01', 'dal-asa-02', 'den-asa-01', 'tus-asa-01']) add({ name: n, site: n.slice(0, 3), kind: 'asa' });
  for (const n of ['phx-f5-01', 'phx-f5-02', 'dal-f5-01', 'dal-f5-02']) add({ name: n, site: n.slice(0, 3), kind: 'f5' });
  for (const n of ['den-ap-01', 'slc-ap-01', 'abq-ap-01', 'tus-ap-01', 'phx-ap-lobby-01', 'dal-ap-lobby-01']) add({ name: n, site: n.slice(0, 3), kind: 'ap' });

  const win = [
    ...['sql-01', 'sql-02', 'sql-03', 'sql-04', 'file-01', 'file-02', 'dc-01', 'dc-02', 'exch-01', 'exch-02', 'rds-01', 'rds-02', 'lab-01'].map((n) => `phx-${n}`),
    'dal-sql-01', 'dal-sql-02', 'dal-dc-01', 'dal-file-01', 'dal-web-01', 'dal-web-02', 'dal-web-03',
    'den-dc-01', 'den-print-01', 'slc-dc-01', 'tus-dc-01', 'tus-file-01',
  ];
  const linux = [
    ...Array.from({ length: 12 }, (_, i) => `phx-app-${pad2(i + 1)}`), 'phx-batch-01', 'phx-batch-02',
    ...Array.from({ length: 7 }, (_, i) => `phx-k8s-node-${pad2(i + 1)}`),
    ...Array.from({ length: 6 }, (_, i) => `dal-app-${pad2(i + 1)}`), 'dal-repl-01', 'dal-repl-02', 'dal-repl-03',
    ...Array.from({ length: 5 }, (_, i) => `tus-pos-${pad2(i + 1)}`),
  ];
  for (const n of win) add({ name: n, site: n.slice(0, 3), kind: 'win' });
  for (const n of linux) add({ name: n, site: n.slice(0, 3), kind: 'linux' });

  // AWS (deviceType 2): reuse the demo's own EC2 names when the aws generator ran.
  let ec2 = [];
  try { ec2 = db.prepare('SELECT instance_id, name FROM aws_ec2_instances ORDER BY instance_id LIMIT 12').all(); } catch { ec2 = []; }
  for (let i = 0; i < 12; i += 1) {
    const row = ec2[i];
    const iid = row ? row.instance_id : `i-0${(0x5a1b3c00 + i * 977).toString(16)}e2f9d1a`;
    const nm = row && row.name ? row.name : `aws-app-${pad2(i + 1)}`;
    add({ name: `${nm} (${iid})`, site: 'aws', kind: 'aws-ec2', awsId: iid });
  }
  for (const n of ['orders-db', 'billing-db', 'reporting-db', 'auth-db']) add({ name: `rds-${n}`, site: 'aws', kind: 'aws-rds' });
  for (const n of ['web-public', 'api-public', 'internal-svc', 'partner-gw']) add({ name: `elb-${n}`, site: 'aws', kind: 'aws-elb' });
  // LM Uptime ping checks are devices too (deviceType 19).
  add({ name: 'PHX DNS anycast', site: 'uptime', kind: 'uptime', target: '10.10.0.53' });
  add({ name: 'DAL DNS anycast', site: 'uptime', kind: 'uptime', target: '10.20.0.53' });
  // Appended last so the v1 device ids do not move.
  for (const s of DC2_SITES) {
    add({ name: `${s}-dist-01`, site: s, kind: 'dist' });
    for (let i = 1; i <= 2; i += 1) add({ name: `${s}-acc-${pad2(i)}`, site: s, kind: 'access' });
  }
  // Round 3, appended after everything else so no earlier device id moves.
  add({ name: 'abq-dist-01', site: 'abq', kind: 'dist', r3: true });
  for (const n of ABQ_DOWNSTREAM) add({ name: n, site: 'abq', kind: 'branch-access', r3: true });
  for (const n of NO_SITE) add({ name: n, site: 'unassigned', kind: 'branch-access', r3: true, collectorId: 11 });
  // Round 8: the Palo Alto estate, appended last for the same reason.
  for (const n of ['phx-fw-01', 'phx-fw-02', 'dal-fw-01', 'dal-fw-02', 'den-fw-01']) add({ name: n, site: n.slice(0, 3), kind: 'paloalto', r8: true });
  // Round 9: one AireOS (5520) and one Catalyst 9800 wireless controller, appended last.
  for (const n of ['phx-wlc-01', 'dal-wlc-01']) add({ name: n, site: n.slice(0, 3), kind: 'wlc', r8: true });
  // Round 9 WP7: AWS Direct Connect (device_type 2) and Azure ExpressRoute (device_type 4), appended last.
  for (const c of require('./logicmonitorIpslaCloudDemo').cloudDevices()) add({ ...c, r8: true });
  // Round 10 WP-B: the two Cohesity demo clusters (generators/cohesity.js names) as LogicMonitor
  // devices, named exactly like clusters.name so the identity index resolves them.
  for (const n of COHESITY_LM_CLUSTERS) add({ name: n, site: n.slice(0, 3), kind: 'cohesity', r8: true });
  // Round 11 WP-X: a Splunk indexer, an EMC Unity and an IronPort (generators/logicmonitorAppsDemo.js).
  for (const c of require('./logicmonitorAppsDemo').appDevices()) add(c);
  // Round 11 WP-V: SBCs, CUBEs, a GANC, ZPA connectors, NSS appliances and ISE nodes (generators/logicmonitorServicesDemo.js).
  for (const c of require('./logicmonitorServicesDemo').serviceDevices()) add(c);

  // Round 11 WP-S: six Linux and six Windows guests of the demo's own vCenter VMs (generators/logicmonitorServersDemo.js).
  for (const c of require('./logicmonitorServersDemo').serverDevices(db)) add(c);

  let id = 101;
  const counters = {};
  for (const d of devices) {
    d.id = id;
    id += 1;
    counters[d.site] = (counters[d.site] || 0) + 1;
    const net = SITES[d.site] ? SITES[d.site].net : null;
    if (net) {
      const third = ['core', 'dist', 'access', 'branch-access', 'wan-rtr', 'branch-rtr', 'asa', 'f5', 'ap', 'paloalto', 'wlc'].includes(d.kind) ? 1 : 40;
      d.ip = `${net}.${third}.${counters[d.site] + 10}`;
    } else if (d.kind === 'uptime') {
      d.ip = d.target;
    } else {
      d.ip = `172.31.${Math.floor(d.id / 200) + 10}.${(d.id % 200) + 20}`;
    }
    if (d.fixedIp) d.ip = d.fixedIp; // round 11: a server device keeps its vCenter VM address
  }
  return devices;
}

function deviceIdentity(d, rng) {
  const serial = () => `FOC${randInt(rng, 2200, 2899)}${String.fromCharCode(65 + randInt(rng, 0, 25))}${randInt(rng, 100, 999)}${String.fromCharCode(65 + randInt(rng, 0, 25))}`;
  const behind = BEHIND_SWITCHES.has(d.name);
  const iosVer = behind ? '17.6.5' : '17.9.4a';
  const train = behind ? 'Bengaluru' : 'Cupertino';
  switch (d.kind === 'win-vm' ? 'win' : d.kind === 'linux-vm' ? 'linux' : d.kind) {
    case 'core':
    case 'dist':
    case 'access':
    case 'branch-access': {
      const model = d.kind === 'core' ? 'C9500-48Y4C' : d.kind === 'dist' ? 'C9300-48UXM' : d.kind === 'access' ? 'C9300-48P' : 'C9200-24P';
      return {
        deviceType: 0, model, serial: serial(),
        sysinfo: `Cisco IOS Software [${train}], Catalyst L3 Switch Software (CAT9K_IOSXE), Version ${iosVer}, RELEASE SOFTWARE (fc3)`,
        sysoid: d.kind === 'core' ? '.1.3.6.1.4.1.9.1.2494' : '.1.3.6.1.4.1.9.1.2593',
        categories: 'snmp,Cisco,CiscoCPU,TopoSwitch,LLDP,CDP', ert: 'Switch',
      };
    }
    case 'wan-rtr':
    case 'branch-rtr':
      return {
        deviceType: 0, model: d.kind === 'wan-rtr' ? 'ISR4451-X/K9' : 'ISR4331/K9', serial: serial(),
        sysinfo: 'Cisco IOS Software [Cupertino], ISR Software (X86_64_LINUX_IOSD-UNIVERSALK9-M), Version 17.9.4a, RELEASE SOFTWARE (fc3)',
        sysoid: '.1.3.6.1.4.1.9.1.1861', categories: 'snmp,Cisco,CiscoCPU,TopoRouter,LLDP,CDP', ert: 'Router',
      };
    case 'asa': {
      const ver = d.name === 'tus-asa-01' ? '9.16(4)' : '9.18(3)';
      return {
        deviceType: 0, model: 'ASA5525', serial: serial(),
        sysinfo: `Cisco Adaptive Security Appliance Version ${ver}`,
        sysoid: '.1.3.6.1.4.1.9.1.2115', categories: 'snmp,Cisco,CiscoASA', ert: 'Firewall',
      };
    }
    case 'paloalto': {
      const model = d.name.startsWith('phx') ? 'PA-5220' : d.name.startsWith('dal') ? 'PA-3260' : 'PA-440';
      return {
        deviceType: 0, model, serial: `0159${randInt(rng, 10000000, 99999999)}`,
        sysinfo: `Palo Alto Networks ${model} PAN-OS 10.2.9`, sysoid: '.1.3.6.1.4.1.25461.2.3.38',
        categories: 'snmp,PaloAlto', ert: 'Firewall',
      };
    }
    case 'wlc':
      // phx is the AireOS 5520 (ERT WLC); dal is the Catalyst 9800 (ERT Wireless).
      if (d.name.startsWith('phx')) {
        return {
          deviceType: 0, model: 'AIR-CT5520-K9', serial: serial(),
          sysinfo: 'Cisco Controller', sysoid: '.1.3.6.1.4.1.9.1.1615', categories: 'snmp,Cisco,CiscoWLC', ert: 'WLC',
        };
      }
      return {
        deviceType: 0, model: 'C9800-40-K9', serial: serial(),
        sysinfo: 'Cisco IOS Software [Cupertino], C9800 Software (C9800_IOSXE-K9), Version 17.9.4a, RELEASE SOFTWARE (fc3)',
        sysoid: '.1.3.6.1.4.1.9.1.2530', categories: 'snmp,Cisco,CiscoCatalystWLC', ert: 'Wireless',
      };
    case 'cohesity':
      // Virtual Edition clusters as the live sandbox shows them: Net-SNMP, ERT VirtualMachineResource.
      return {
        deviceType: 0, model: 'Cohesity Virtual Edition', serial: null,
        sysinfo: 'Linux cohesity-ve 5.4.0 #1 SMP x86_64', sysoid: '.1.3.6.1.4.1.8072.3.2.10',
        categories: 'snmp,NetSNMP,Linux', ert: 'VirtualMachineResource',
      };
    case 'f5':
      return {
        deviceType: 0, model: 'BIG-IP i5800', serial: `f5-${randInt(rng, 1000, 9999)}-${randInt(rng, 1000, 9999)}`,
        sysinfo: 'BIG-IP 17.1.1', sysoid: '.1.3.6.1.4.1.3375.2.1.3.4.43', categories: 'snmp,F5,F5Active', ert: null,
      };
    case 'ap':
      return {
        deviceType: 0, model: 'MR46', serial: `Q3AB-${randInt(rng, 1000, 9999)}-${randInt(rng, 1000, 9999)}`,
        sysinfo: 'Meraki MR46 Cloud Managed AP', sysoid: '.1.3.6.1.4.1.29671.2.123', categories: 'CiscoMerakiAP,snmp', ert: null,
      };
    case 'win':
      return {
        deviceType: 0, model: pick(rng, ['PowerEdge R650', 'PowerEdge R750', 'VMware Virtual Platform']), serial: null,
        sysinfo: 'Microsoft Windows Server 2022 Datacenter 10.0.20348', sysoid: '.1.3.6.1.4.1.311.1.1.3.1.3',
        categories: 'Windows,WMI,MicrosoftWindowsServer', ert: chance(rng, 0.6) ? 'VirtualMachine' : 'PhysicalServer',
      };
    case 'linux':
      return {
        deviceType: 0, model: pick(rng, ['VMware Virtual Platform', 'PowerEdge R650']), serial: null,
        sysinfo: `Linux ${d.name} 5.15.0-${randInt(rng, 88, 105)}-generic #1-Ubuntu SMP x86_64`, sysoid: '.1.3.6.1.4.1.8072.3.2.10',
        categories: 'Linux,LinuxSSH,snmp', ert: 'VirtualMachine',
      };
    case 'app-splunk':
    case 'app-emc':
    case 'app-ironport':
      return require('./logicmonitorAppsDemo').appIdentity(d);
    case 'svc-sbc':
    case 'svc-cube':
    case 'svc-ganc':
    case 'svc-zpa':
    case 'svc-nss':
    case 'svc-ise':
      return require('./logicmonitorServicesDemo').serviceIdentity(d, rng);
    case 'aws-ec2':
      return { deviceType: 2, model: pick(rng, ['m6i.large', 't3.medium', 'c6i.xlarge']), serial: null, sysinfo: null, sysoid: null, categories: 'AWS/EC2', ert: 'VirtualMachine' };
    case 'aws-rds':
      return { deviceType: 2, model: 'db.r6g.large', serial: null, sysinfo: null, sysoid: null, categories: 'AWS/RDS', ert: null };
    case 'aws-elb':
      return { deviceType: 2, model: 'application', serial: null, sysinfo: null, sysoid: null, categories: 'AWS/ApplicationELB', ert: null };
    case 'aws-dx':
      return { deviceType: 2, model: null, serial: null, sysinfo: null, sysoid: null, categories: 'AWS/DirectConnect', ert: 'AWS/DirectConnect' };
    case 'azure-er':
      return { deviceType: 4, model: null, serial: null, sysinfo: null, sysoid: null, categories: 'Azure/ExpressRoute', ert: 'Azure/ExpressRouteCircuit' };
    case 'uptime':
    default:
      return { deviceType: 19, model: null, serial: null, sysinfo: null, sysoid: null, categories: 'LMUptime', ert: null };
  }
}

function classify(d, ident) {
  if (lmApi && lmApi.classifyVendor) {
    const vendor = lmApi.classifyVendor({ sysoid: ident.sysoid, categories: ident.categories, sysinfo: ident.sysinfo });
    const role = lmApi.classifyRole({ ert: ident.ert, categories: ident.categories, vendor });
    return {
      vendor, role,
      isNetwork: lmApi.isNetworkDevice({ deviceType: ident.deviceType, role }) ? 1 : 0,
      version: lmApi.parseVersion(ident.sysinfo),
    };
  }
  const roleByKind = {
    core: 'switch', dist: 'switch', access: 'switch', 'branch-access': 'switch', 'wan-rtr': 'router', 'branch-rtr': 'router',
    asa: 'firewall', f5: 'load-balancer', ap: 'wireless', wlc: 'wireless', win: 'server', linux: 'server', cohesity: 'server', 'aws-ec2': 'server',
  };
  const vendorByKind = { f5: 'F5', ap: 'Meraki', win: 'Microsoft', linux: 'Net-SNMP', cohesity: 'Net-SNMP' };
  const role = roleByKind[d.kind] || 'other';
  const vendor = ident.sysoid ? (vendorByKind[d.kind] || 'Cisco') : null;
  const m = String(ident.sysinfo || '').match(/(?:Version|BIG-IP)\s+([\w.()]+)/);
  return { vendor, role, isNetwork: ident.deviceType === 0 && ['switch', 'router', 'firewall', 'load-balancer', 'wireless'].includes(role) ? 1 : 0, version: m ? m[1] : null };
}

function groupsFor(d) {
  const g = [];
  if (d.kind === 'core' || d.kind === 'wan-rtr') g.push(GROUP_ID['Network/Core']);
  if (d.kind === 'dist' || d.kind === 'access') g.push(GROUP_ID['Network/Distribution']);
  if (d.kind === 'asa' || d.kind === 'paloalto') g.push(GROUP_ID['Network/Firewalls']);
  if (d.kind === 'f5') g.push(GROUP_ID['Network/LoadBalancers']);
  if (d.kind === 'ap' || d.kind === 'wlc') g.push(GROUP_ID['Network/Wireless']);
  if (d.kind === 'win' || d.kind === 'win-vm') g.push(GROUP_ID['Servers/Windows']);
  if (d.kind === 'linux' || d.kind === 'linux-vm') g.push(GROUP_ID['Servers/Linux']);
  if (d.kind.startsWith('aws')) g.push(GROUP_ID['Cloud/AWS']);
  const site = SITES[d.site];
  if (site && site.group && ['branch-access', 'branch-rtr', 'asa', 'paloalto', 'ap', 'dist'].includes(d.kind)) g.push(GROUP_ID[site.group]);
  if (DC_SITE_GROUP[d.site] && ['core', 'dist', 'access', 'wan-rtr', 'asa', 'paloalto', 'f5', 'ap', 'wlc'].includes(d.kind)) g.push(DC_SITE_GROUP[d.site]);
  return g;
}

// -- Interface plan -----------------------------------------------------------

function portsFor(d) {
  const te = (n, prefix = 'TenGigabitEthernet1/0/') => Array.from({ length: n }, (_, i) => ({ full: `${prefix}${i + 1}`, speed: 1e10 }));
  const gi = (n, prefix = 'GigabitEthernet1/0/') => Array.from({ length: n }, (_, i) => ({ full: `${prefix}${i + 1}`, speed: 1e9 }));
  switch (d.kind) {
    case 'core':
    case 'dist': return te(48);
    case 'access': return [...gi(44), ...te(4, 'TenGigabitEthernet1/1/')];
    case 'branch-access': return [...gi(20), ...te(4, 'TenGigabitEthernet1/1/')];
    case 'wan-rtr':
    case 'branch-rtr':
      return [0, 1, 2, 3].map((i) => ({ full: `GigabitEthernet0/0/${i}`, speed: 1e9 }))
        .concat([0, 1].map((i) => ({ full: `TenGigabitEthernet0/1/${i}`, speed: 1e10 })));
    case 'asa': return [0, 1, 2, 3, 4, 5].map((i) => ({ full: `GigabitEthernet0/${i}`, speed: 1e9 }));
    case 'f5': return ['1.1', '1.2', '1.3', '1.4'].map((p) => ({ full: p, speed: 1e10 })).concat([{ full: 'mgmt', speed: 1e9 }]);
    default: return [];
  }
}

// Round 10: chassis MAC the demo gives a device (also written into eri_json), and the port MACs
// that share its first five octets, as on Cisco gear.
const demoDeviceMac = (id) => `00:1e:${(id >> 8).toString(16).padStart(2, '0')}:${(id & 255).toString(16).padStart(2, '0')}:4c:${pad2(id % 90)}`;
const demoPortMac = (id, ifIndex) => `00:1e:${(id >> 8).toString(16).padStart(2, '0')}:${(id & 255).toString(16).padStart(2, '0')}:4c:${((ifIndex + 0x40) & 255).toString(16).padStart(2, '0')}`;
// Neighbours CDP sees that nothing monitors: switch -> the device name (first non-uplink port of that switch).
const UNMONITORED_CDP = { 'phx-acc-01': 'phx-ups-01', 'phx-acc-02': 'phx-ups-01', 'dal-acc-01': 'dal-badge-ctl-1', 'nyc-acc-01': 'nyc-cam-nvr-2' };

// 80 uplink descriptions in "to <device> <port>" form.
function uplinkDescriptions() {
  const links = [];
  const L = (src, srcPort, dst, dstPort) => links.push({ src, srcPort, dst, dstPort });
  for (let k = 1; k <= 8; k += 1) {
    const [a, b] = k <= 4 ? [1, 2] : [3, 4];
    L(`phx-acc-${pad2(k)}`, 'Te1/1/1', `phx-dist-${pad2(a)}`, `Te1/0/${k}`);
    L(`phx-acc-${pad2(k)}`, 'Te1/1/2', `phx-dist-${pad2(b)}`, `Te1/0/${k}`);
  }
  for (let k = 1; k <= 4; k += 1) {
    L(`dal-acc-${pad2(k)}`, 'Te1/1/1', 'dal-dist-01', `Te1/0/${k}`);
    L(`dal-acc-${pad2(k)}`, 'Te1/1/2', 'dal-dist-02', `Te1/0/${k}`);
  }
  for (const [s, n] of [['den', 3], ['slc', 3], ['abq', 2], ['tus', 4]]) {
    for (let k = 1; k <= n; k += 1) L(`${s}-acc-${pad2(k)}`, 'Te1/1/1', `${s}-rtr-01`, k <= 3 ? `Gi0/0/${k}` : 'Te0/1/1');
  }
  for (const s of ['phx', 'dal']) {
    for (let d = 1; d <= 4; d += 1) {
      L(`${s}-dist-${pad2(d)}`, 'Te1/0/47', `${s}-core-01`, `Te1/0/${d}`);
      L(`${s}-dist-${pad2(d)}`, 'Te1/0/48', `${s}-core-02`, `Te1/0/${d}`);
      L(`${s}-core-01`, `Te1/0/${d}`, `${s}-dist-${pad2(d)}`, 'Te1/0/47');
      L(`${s}-core-02`, `Te1/0/${d}`, `${s}-dist-${pad2(d)}`, 'Te1/0/48');
    }
    L(`${s}-core-01`, 'Te1/0/45', `${s}-core-02`, 'Te1/0/45');
    L(`${s}-core-02`, 'Te1/0/45', `${s}-core-01`, 'Te1/0/45');
    L(`${s}-core-01`, 'Te1/0/46', `${s}-wan-rtr-01`, 'Te0/1/0');
    L(`${s}-core-01`, 'Te1/0/44', `${s}-wan-rtr-02`, 'Te0/1/0');
    L(`${s}-core-02`, 'Te1/0/46', `${s}-wan-rtr-02`, 'Te0/1/1');
    L(`${s}-core-02`, 'Te1/0/44', `${s}-wan-rtr-01`, 'Te0/1/1');
  }
  for (const s of DC2_SITES) {
    for (let k = 1; k <= 2; k += 1) {
      L(`${s}-acc-${pad2(k)}`, 'Te1/1/1', `${s}-dist-01`, `Te1/0/${k}`);
      L(`${s}-dist-01`, `Te1/0/${k}`, `${s}-acc-${pad2(k)}`, 'Te1/1/1');
    }
  }
  // Round 3: abq-dist-01 sits between the abq router and three new access switches.
  ABQ_DOWNSTREAM.forEach((acc, i) => {
    L(acc, 'Te1/1/1', 'abq-dist-01', `Te1/0/${i + 1}`);
    L('abq-dist-01', `Te1/0/${i + 1}`, acc, 'Te1/1/1');
  });
  L('abq-dist-01', 'Te1/0/48', 'abq-rtr-01', 'Gi0/0/3');
  L('abq-rtr-01', 'Gi0/0/3', 'abq-dist-01', 'Te1/0/48');
  return links;
}

// Server-facing ports on the nyc/lon access switches, named the way a network
// team writes them: the first 6 ESXi hosts per site (by name, the same order
// generators/vcenter.js uses for its CDP hints) on Gi1/0/<n>, vmnic0 on acc-01
// and vmnic1 on acc-02, plus two dual-homed Dell servers on Gi1/0/41. Names
// come from the vCenter and Dell rows already seeded; fallbacks keep the seed
// working when those generators did not run.
function dc2ServerPorts(db) {
  const desc = new Map();
  const hosts = {};
  const tryAll = (sql, ...args) => { try { return db.prepare(sql).all(...args); } catch { return []; } };
  for (const s of DC2_SITES) {
    let names = tryAll('SELECT name FROM vcenter_hosts WHERE name LIKE ? ORDER BY name LIMIT 6', `${s}-esx-%`).map((r) => r.name);
    if (!names.length) names = Array.from({ length: 6 }, (_, i) => `${s}-esx-01${pad2(i + 1)}.icc.demo`);
    hosts[s] = names;
    names.forEach((full, i) => {
      const short = full.split('.')[0];
      desc.set(`${s}-acc-01|Gi1/0/${i + 1}`, `to ${short} vmnic0`);
      desc.set(`${s}-acc-02|Gi1/0/${i + 1}`, `to ${short} vmnic1`);
    });
  }
  // Two Dell servers, one per OME instance; dc1-esx-002 is skipped because
  // scenarios/sanBootPathDown.js renames it to nyc-esx-0102.
  const dell = [];
  for (const [prefix, site] of [['dc1-', 'nyc'], ['dc2-', 'lon']]) {
    const row = tryAll(
      "SELECT name FROM dell_devices WHERE device_type = 'Server' AND name LIKE ? AND name != 'dc1-esx-002.demo.local' ORDER BY device_id LIMIT 1 OFFSET 4",
      `${prefix}%`,
    )[0];
    if (!row) continue;
    const short = row.name.split('.')[0];
    dell.push({ name: row.name, site });
    desc.set(`${site}-acc-01|Gi1/0/41`, `to ${short} NIC.Integrated.1-1`);
    desc.set(`${site}-acc-02|Gi1/0/41`, `to ${short} NIC.Integrated.1-2`);
  }
  return { desc, hosts, dell };
}

// A powered-on VM on one of the first 6 hosts of a site, the target of that
// site's ping check. Falls back to the address vcenter.js would give the first
// VM of the site's first host.
function dc2CheckTarget(db, site, hosts) {
  try {
    const marks = hosts.map(() => '?').join(',');
    const row = db.prepare(`
      SELECT v.name, v.ip_address FROM vcenter_vms v
      JOIN vcenter_hosts h ON h.vcenter_id = v.vcenter_id AND h.name = v.host_name
      WHERE h.name IN (${marks}) AND h.connection_state = 'CONNECTED' AND h.in_maintenance = 0
        AND v.power_state = 'POWERED_ON' AND v.ip_address IS NOT NULL AND v.name LIKE ?
      ORDER BY v.host_name, v.name LIMIT 1
    `).get(...hosts, `${site}-%`);
    if (row) return { vm: row.name, ip: row.ip_address };
  } catch { /* no vcenter tables */ }
  return { vm: null, ip: site === 'nyc' ? '10.100.11.11' : '10.101.11.11' };
}

// Link-looking descriptions that resolve to nothing in the portal.
const OUTLIERS = {
  'phx-wan-rtr-01|Gi0/0/0': 'uplink to CenturyLink circuit 44KXGS123456 to Dallas DC',
  'dal-wan-rtr-01|Gi0/0/0': 'to Zayo dal-pe-7 Gi0/2/1',
  'phx-dist-04|Te1/0/40': 'to legacy-6509-b Gi3/12',
  'dal-core-02|Te1/0/40': 'link to vendor-cage-sw Gi1/0/1',
  'den-acc-01|Gi1/0/20': 'to dmz-sw-03 Gi1/0/24',
  'phx-asa-01|Gi0/5': 'uplink to colo-xc-114',
};

// Round 3 description overrides applied after the v1 random draws so the v1
// streams are untouched. Two uplinks per DC WAN router pair and an unresolved
// branch uplink; two access ports with names so the anomaly ports read well.
const R3_DESC = {
  'phx-wan-rtr-01|Gi0/0/1': 'WAN Zayo circuit 12345 to Dallas',
  'phx-wan-rtr-02|Gi0/0/0': 'WAN Lumen MPLS circuit 55012 to Dallas',
  'dal-wan-rtr-01|Gi0/0/1': 'WAN Zayo circuit 12346 to Phoenix',
  'dal-wan-rtr-02|Gi0/0/0': 'WAN Lumen MPLS circuit 55013 to Phoenix',
  'den-rtr-01|Gi0/0/0': 'to den-edge-pe2 Gi0/0/4',
  'phx-acc-06|Gi1/0/20': 'Users VLAN 20 third floor',
  'phx-acc-08|Gi1/0/25': 'Printer cluster',
};
// Round 13: circuit roles. Every circuit port carries the CG ifAlias tag class as props_json.iccClass
// (the poller stores it from "[t=<class> ...]"); dia and mpls are provider WAN circuits, p2p is a
// site-to-site link. The Zayo pair phx<->dal is a site link and flaps; the Lumen MPLS and CenturyLink
// ports are the DC WANs. Branch sites get one or two WANs: abq WAN2 is down for 3 days (site degraded),
// both tus WANs are down (site down; the tus collector is down too).
const R13_CLASS = {
  'phx-wan-rtr-01|Gi0/0/0': 'dia', 'phx-wan-rtr-02|Gi0/0/0': 'mpls', 'phx-wan-rtr-01|Gi0/0/1': 'p2p',
  'dal-wan-rtr-01|Gi0/0/0': 'dia', 'dal-wan-rtr-02|Gi0/0/0': 'mpls', 'dal-wan-rtr-01|Gi0/0/1': 'p2p',
  'den-rtr-01|Gi0/0/0': 'dia', 'den-rtr-01|Te0/1/0': 'mpls',
  'slc-rtr-01|Gi0/0/0': 'dia',
  'abq-rtr-01|Gi0/0/0': 'dia', 'abq-rtr-01|Te0/1/0': 'mpls',
  'tus-rtr-01|Gi0/0/0': 'dia', 'tus-rtr-01|Te0/1/0': 'mpls',
};
const R13_DESC = {
  'phx-wan-rtr-01|Gi0/0/1': 'Zayo p2p circuit 12345 to Dallas DC',
  'dal-wan-rtr-01|Gi0/0/1': 'Zayo p2p circuit 12346 to Phoenix DC',
  'den-rtr-01|Te0/1/0': 'WAN Lumen MPLS circuit 61010',
  'abq-rtr-01|Te0/1/0': 'WAN AT&T MPLS circuit 72031',
  'tus-rtr-01|Te0/1/0': 'WAN Cogent circuit 33077',
};
// Circuit ports that had no history before round 13: 5 days each (own PRNG stream, so no v1 or round 3 row moves,
// and the total stays under the 150000 history rows seedDemo.test.js allows).
const R13_HISTORY = ['den-rtr-01|Te0/1/0', 'abq-rtr-01|Gi0/0/0', 'abq-rtr-01|Te0/1/0', 'tus-rtr-01|Gi0/0/0', 'tus-rtr-01|Te0/1/0'];
// Down now: abq WAN2 since 3 days, both tus WANs since 6 hours.
const R13_DOWN_SINCE_K = { 'abq-rtr-01|Te0/1/0': 288, 'tus-rtr-01|Gi0/0/0': 24, 'tus-rtr-01|Te0/1/0': 24 };
// The Zayo site link flaps on 5 of the last 7 days: a 30 minute outage at about 5 hours past the same
// time of day on day offsets 0,1,2,4,5; day 0 also had an earlier single-sample drop.
const R13_FLAP_KEYS = new Set(['phx-wan-rtr-01|Gi0/0/1', 'dal-wan-rtr-01|Gi0/0/1']);
const R13_FLAP_DAYS = [0, 1, 2, 4, 5];
const r13FlapDown = (k) => {
  if (k === 24) return true;
  return R13_FLAP_DAYS.some((d) => k === d * 96 + 20 || k === d * 96 + 21);
};
// Event meta per circuit port: role and the far site (a device of that site resolves its site_key).
const R13_CIRCUITS = {
  'phx-wan-rtr-01|Gi0/0/0': { role: 'wan' }, 'phx-wan-rtr-02|Gi0/0/0': { role: 'wan' },
  'phx-wan-rtr-01|Gi0/0/1': { role: 'site-link', far: 'dal-wan-rtr-01' },
  'dal-wan-rtr-01|Gi0/0/0': { role: 'wan' }, 'dal-wan-rtr-02|Gi0/0/0': { role: 'wan' },
  'dal-wan-rtr-01|Gi0/0/1': { role: 'site-link', far: 'phx-wan-rtr-01' },
  'den-rtr-01|Gi0/0/0': { role: 'wan' }, 'den-rtr-01|Te0/1/0': { role: 'wan' },
  'slc-rtr-01|Gi0/0/0': { role: 'wan' },
  'abq-rtr-01|Gi0/0/0': { role: 'wan' }, 'abq-rtr-01|Te0/1/0': { role: 'wan' },
  'tus-rtr-01|Gi0/0/0': { role: 'wan' }, 'tus-rtr-01|Te0/1/0': { role: 'wan' },
};

// 30 days of history: the WAN circuits (phx-wan-rtr-01 Gi0/0/0 is the saturated one).
const SAT_KEY = 'phx-wan-rtr-01|Gi0/0/0';
// The saturated circuit runs hot from SAT_HOUR_FROM to SAT_HOUR_TO UTC every day.
const SAT_HOUR_FROM = 14;
const SAT_HOUR_TO = 22;
const WAN_HISTORY = [
  SAT_KEY, 'phx-wan-rtr-01|Gi0/0/1', 'phx-wan-rtr-02|Gi0/0/0', 'dal-wan-rtr-01|Gi0/0/0',
  'dal-wan-rtr-01|Gi0/0/1', 'dal-wan-rtr-02|Gi0/0/0', 'den-rtr-01|Gi0/0/0',
];
const UTIL_ANOM_KEY = 'phx-acc-06|Gi1/0/20';
const ERR_ANOM_KEY = 'phx-acc-08|Gi1/0/25';
// Host-facing ports of nyc-esx-0101 and lon-esx-0101 (both vmnics). Their backup
// nights run hot; the other seeded nights stay quiet.
const BACKUP_PORTS = new Set(['nyc-acc-01|Gi1/0/1', 'nyc-acc-02|Gi1/0/1', 'lon-acc-01|Gi1/0/1', 'lon-acc-02|Gi1/0/1']);
// Only vmnic0 (acc-01) carries the backup traffic; vmnic1 stays idle so each hot run is one finding.
const BACKUP_HOT = new Set(['nyc-acc-01|Gi1/0/1', 'lon-acc-01|Gi1/0/1']);
const R3_HISTORY8 = [UTIL_ANOM_KEY, ERR_ANOM_KEY, ...BACKUP_PORTS];
const R3_CURRENT = { [SAT_KEY]: { inU: 79, outU: 62 }, [UTIL_ANOM_KEY]: { inU: 32, outU: 14 }, [ERR_ANOM_KEY]: { errs: 14 } };
const R3_KEYS = new Set([...WAN_HISTORY, ...R3_HISTORY8]);
const HOT = { 'phx-core-01|Te1/0/46': { dir: 'out', pct: 91 }, 'dal-dist-01|Te1/0/47': { dir: 'in', pct: 87 } };
// lon-acc-02 Gi1/0/2 is an ESXi host port (vmnic1 of the second lon host), so
// the server map has a host-facing link with a network issue.
const ERR_PORTS = new Set(['phx-acc-05|Te1/1/1', 'slc-acc-01|Te1/1/1', 'dal-acc-02|Gi1/0/9', 'lon-acc-02|Gi1/0/2']);
const FLAP_PORTS = new Set(['phx-acc-03|Gi1/0/17', 'abq-acc-01|Gi1/0/18']);
const DOWN_UPLINKS = new Set(['phx-dist-03|Te1/0/48', 'phx-core-02|Te1/0/3']);
const DOWN_PORTS = new Set([
  ...DOWN_UPLINKS, 'phx-acc-01|Gi1/0/12', 'phx-acc-02|Gi1/0/30', 'phx-acc-04|Gi1/0/7', 'dal-acc-01|Gi1/0/41',
  'abq-acc-02|Gi1/0/8',
]);
const DORMANT_PORTS = new Set(['dal-wan-rtr-02|Gi0/0/3', 'phx-wan-rtr-02|Gi0/0/3', 'den-rtr-01|Gi0/0/3', 'slc-rtr-01|Gi0/0/3']);
const FLAP_ROWS = new Set([9, 33, 34, 61, 80]);
const SAFE_DESC = ['', '', 'Users VLAN 20', 'VoIP VLAN 30', 'Printer', 'Wireless AP', 'Camera', 'Badge reader', 'Spare'];
const ASA_DESC = ['outside', 'inside', 'dmz', 'failover', 'management', 'guest'];
const F5_DESC = ['external', 'internal', 'ha', 'servers', 'management'];

// -- Main -----------------------------------------------------------------------

function seedLogicmonitor(db, { now, encrypt }) {
  const nowMs = now;
  const nowSec = Math.floor(nowMs / 1000);
  const rng = rngFor('logicmonitor-demo');
  const todayStr = new Date(nowMs).toISOString().slice(0, 10);
  const dayOf = (minAgo) => new Date(nowMs - minAgo * 60000).toISOString().slice(0, 10);
  const epochAgo = (minAgo) => Math.floor((nowMs - minAgo * 60000) / 1000);
  const wp1 = { lmApi: !!lmApi, checks: false, poller: false, issues: false };

  const devices = buildDevicePlan(db);
  const byName = new Map(devices.map((d) => [d.name, d]));
  const dc2Rng = rngFor('logicmonitor-dc2');
  const dc2 = dc2ServerPorts(db);
  const r3Rng = rngFor('logicmonitor-r3');
  const r8Rng = rngFor('logicmonitor-r8-devices');
  for (const d of devices) {
    d.ident = deviceIdentity(d, d.r8 ? r8Rng : d.r3 ? r3Rng : DC2_SITES.has(d.site) ? dc2Rng : rng);
    Object.assign(d, classify(d, d.ident));
    d.groups = groupsFor(d);
    d.collector = SITES[d.site] ? COLLECTORS.find((c) => c.id === SITES[d.site].collectorId)
      : d.collectorId ? COLLECTORS.find((c) => c.id === d.collectorId) : null;
    d.hostStatus = d.site === 'tus' ? 'dead-collector' : DEAD[d.name] ? 'dead' : 'normal';
    d.inSdt = SDT_DEVICES.includes(d.name);
  }

  // Interfaces (instance ids from 700000), keyed "device|abbr".
  const links = uplinkDescriptions();
  const linkDesc = new Map(links.map((l) => [`${l.src}|${l.srcPort}`, `to ${l.dst} ${l.dstPort}`]));
  const linkByKey = new Map(links.map((l) => [`${l.src}|${l.srcPort}`, l]));
  const unmonDone = new Set();
  const demoNeighbors = []; // CDP/LLDP neighbour instances for buildTopologyLinks (round 10)
  const ifaces = [];
  const ifByKey = new Map();
  let instanceSeq = 700000;
  let hdsSeq = 40000;
  const v1IfRng = rngFor('logicmonitor-ifaces');
  const dc2IfRng = rngFor('logicmonitor-dc2-ifaces');
  const r3IfRng = rngFor('logicmonitor-r3-ifaces');
  for (const d of devices) {
    const ports = portsFor(d);
    if (!ports.length) continue;
    const ifRng = d.r3 ? r3IfRng : DC2_SITES.has(d.site) ? dc2IfRng : v1IfRng;
    d.ifHds = hdsSeq;
    hdsSeq += 1;
    ports.forEach((p, idx) => {
      const short = abbr(p.full);
      const key = `${d.name}|${short}`;
      instanceSeq += 1;
      const ifIndex = idx + 1;
      let description = linkDesc.get(key) || OUTLIERS[key] || dc2.desc.get(key);
      let cls;
      if (linkDesc.has(key)) cls = 'uplink';
      else if (OUTLIERS[key]) cls = 'trunk';
      else if (dc2.desc.has(key)) cls = 'active';
      else if (d.kind === 'access' || d.kind === 'branch-access') cls = chance(ifRng, 0.55) ? 'active' : 'idle';
      else if (d.kind === 'core' || d.kind === 'dist') cls = 'idle';
      else cls = 'trunk';
      if (description == null) {
        if (d.kind === 'asa') description = ASA_DESC[idx] || '';
        else if (d.kind === 'f5') description = F5_DESC[idx] || '';
        else if (d.kind.endsWith('rtr')) description = idx === 0 ? 'WAN circuit' : 'LAN';
        else if (cls === 'idle' && (d.kind === 'core' || d.kind === 'dist')) description = '';
        else description = pick(ifRng, SAFE_DESC);
      }
      const baseUtil = cls === 'uplink' ? randFloat(ifRng, 15, 55, 1)
        : cls === 'trunk' ? randFloat(ifRng, 5, 40, 1)
          : cls === 'active' ? randFloat(ifRng, 1.2, 6, 2) : randFloat(ifRng, 0.02, 0.6, 2);
      const f = {
        key, device: d, full: p.full, short, ifIndex, speed: p.speed, description, cls,
        instanceId: instanceSeq,
        instanceName: `SNMP_Network_Interfaces-${p.full} [ID:${ifIndex}]`,
        baseIn: baseUtil, baseOut: Math.max(0.01, Number((baseUtil * randFloat(ifRng, 0.5, 1.2, 2)).toFixed(2))),
        status: DOWN_PORTS.has(key) || R13_DOWN_SINCE_K[key] ? 2 : DORMANT_PORTS.has(key) ? 5 : 1,
        history: 0,
      };
      if (R3_DESC[key]) f.description = R3_DESC[key];
      if (R13_DESC[key]) f.description = R13_DESC[key];
      // The CG ifAlias tag the poller turns into props_json.iccClass (buildTopologyLinks reads it from the text).
      if (R13_CLASS[key]) f.description = `${f.description} [t=${R13_CLASS[key]} m= q= n=]`;
      if (key === UTIL_ANOM_KEY || key === ERR_ANOM_KEY || BACKUP_PORTS.has(key)) { f.cls = 'active'; f.baseIn = randFloat(r3IfRng, 2, 5, 2); f.baseOut = Number((f.baseIn * 0.8).toFixed(2)); }
      if (WAN_HISTORY.includes(key) && key !== SAT_KEY) { f.baseIn = randFloat(r3IfRng, 18, 40, 1); f.baseOut = randFloat(r3IfRng, 12, 30, 1); }
      if (key === SAT_KEY) { f.baseIn = 50; f.baseOut = 40; }
      if (R3_KEYS.has(key)) f.r3 = true;
      ifaces.push(f);
      ifByKey.set(key, f);
    });
  }

  // History subsets: trouble interfaces plus core/dist uplinks get 30 days;
  // the next 60 uplinks get 24 h. Dead devices and Tucson are excluded.
  const eligible = (f) => f.device.hostStatus === 'normal';
  const full = [];
  for (const k of [...Object.keys(HOT), ...ERR_PORTS, ...FLAP_PORTS, ...DOWN_UPLINKS]) full.push(ifByKey.get(k));
  const coreDistUplinks = ifaces.filter((f) => f.cls === 'uplink' && ['core', 'dist'].includes(f.device.kind) && eligible(f) && !full.includes(f));
  for (const f of coreDistUplinks) if (full.length < 40) full.push(f);
  for (const f of full) f.history = 30;
  // Round 3 history sets are added after the v1 cap so the v1 picks do not move.
  for (const k of WAN_HISTORY) { const f = ifByKey.get(k); if (f && !full.includes(f)) { f.history = 30; full.push(f); } }
  for (const k of R3_HISTORY8) { const f = ifByKey.get(k); if (f && !f.history) f.history = 8; }
  for (const k of R13_HISTORY) { const f = ifByKey.get(k); if (f) { f.history = 5; f.r13 = true; } }
  const dayOnly = ifaces.filter((f) => !f.history && eligible(f) && (f.cls === 'uplink' || f.cls === 'trunk')).slice(0, 60);
  for (const f of dayOnly) f.history = 1;

  // -- Alerts plan (open), built before devices so device alert_status agrees.
  const DS = {
    host: { name: 'Host Status', id: 101 }, ping: { name: 'Ping', id: 102 }, if: { name: 'SNMP_Network_Interfaces', id: 501 },
    cpu: { name: 'Cisco_CPU_SNMP', id: 601 }, mem: { name: 'Cisco_MemoryPools_SNMP', id: 602 }, fru: { name: 'Cisco_FRU_Power', id: 603 },
    f5sys: { name: 'F5_BigIP_System', id: 701 }, f5fo: { name: 'F5_BigIP_FailoverStatus', id: 702 }, vol: { name: 'WinVolumeUsage-', id: 901 },
  };
  let alertSeq = 0;
  let dsInstSeq = 900000;
  const dsInstances = new Map();
  const dsInstance = (devName, dsName, label) => {
    const k = `${devName}|${dsName}|${label}`;
    if (!dsInstances.has(k)) { dsInstSeq += 1; dsInstances.set(k, dsInstSeq); }
    return dsInstances.get(k);
  };
  const alerts = [];
  const sevNorm = (s) => (s >= 4 ? 'critical' : s === 3 ? 'warning' : 'info');
  const ruleFor = (dev) => (dev && ['win', 'linux'].includes(dev.kind) ? ['Server Default', 'Server Team'] : ['Network Critical', 'NOC Escalation']);
  function addAlert(a) {
    alertSeq += 1;
    const dev = a.device ? byName.get(a.device) : null;
    const [rule, chain] = a.unrouted ? ['', ''] : ruleFor(dev);
    const row = {
      lmAlertId: a.idPrefix ? `${a.idPrefix}${100000 + alertSeq}` : `DS${5400000 + alertSeq}`,
      internalId: `LMD${80000 + alertSeq}`,
      type: a.type || 'dataSourceAlert',
      severity: a.sev,
      deviceId: dev ? dev.id : null,
      objectName: a.objectName || (dev ? dev.name : ''),
      objectType: a.objectType || 'device',
      template: a.ds,
      templateType: a.templateType || 'DS',
      instanceId: a.instanceId != null ? a.instanceId : null,
      instanceName: a.instanceName || '',
      instanceDescription: a.instanceDescription || '',
      dataPoint: a.dp || '',
      value: a.value, threshold: a.threshold, clearValue: a.clearValue || null,
      startEpoch: a.startEpoch, endEpoch: a.endEpoch || null,
      acked: a.ackedMin ? 1 : 0,
      ackedBy: a.ackedMin ? pick(rng, ['k.ramirez', 'p.nguyen', 'noc.shared']) : '',
      ackComment: a.ackedMin ? (a.ackComment || 'Investigating') : '',
      ackedEpoch: a.ackedMin ? epochAgo(a.ackedMin) : 0,
      sdted: dev && dev.inSdt && !a.cleared ? 1 : 0,
      suppressor: dev && dev.inSdt && !a.cleared ? 'SDT' : null,
      cleared: a.cleared ? 1 : 0,
      rule, ruleId: rule ? (rule === 'Network Critical' ? 11 : 12) : 0, chain,
    };
    alerts.push(row);
    return row;
  }
  const ifAlert = (key, dp, sev, startMin, extra = {}) => {
    const f = ifByKey.get(key);
    return addAlert({
      device: f.device.name, ds: DS.if.name, instanceId: f.instanceId, instanceName: f.instanceName,
      instanceDescription: f.description, dp, sev, startEpoch: epochAgo(startMin), ...extra,
    });
  };
  const devAlert = (devName, dsKey, label, dp, sev, startMin, extra = {}) => addAlert({
    device: devName, ds: DS[dsKey].name, instanceId: dsInstance(devName, DS[dsKey].name, label),
    instanceName: label, dp, sev, startEpoch: epochAgo(startMin), ...extra,
  });

  // Storm: 55 InDiscards alerts on the DAL access layer in the last 15 minutes.
  let storm = 0;
  for (let s = 1; s <= 4 && storm < 55; s += 1) {
    for (let p = 1; p <= 14 && storm < 55; p += 1) {
      storm += 1;
      ifAlert(`dal-acc-${pad2(s)}|Gi1/0/${p}`, 'InDiscards', 3, 2 + (storm % 12), {
        value: String(randInt(rng, 240, 980)), threshold: '> 100 200 300', ackedMin: storm === 1 ? 1 : 0,
        ackComment: 'Broadcast storm on DAL access VLAN 20, STP root check in progress',
      });
    }
  }
  devAlert('den-acc-02', 'host', 'HostStatus', 'idleInterval', 4, DEAD_MIN['den-acc-02'] - 6, { value: '259200.0', threshold: '> 300 300 300' });
  devAlert('phx-acc-07', 'host', 'HostStatus', 'idleInterval', 4, DEAD_MIN['phx-acc-07'] - 6, { value: '17640.0', threshold: '> 300 300 300' });
  devAlert('slc-ap-01', 'host', 'HostStatus', 'idleInterval', 4, DEAD_MIN['slc-ap-01'] - 6, { value: '2040.0', threshold: '> 300 300 300' });
  devAlert('phx-batch-02', 'host', 'HostStatus', 'idleInterval', 3, DEAD_MIN['phx-batch-02'] - 6, { value: '172440.0', threshold: '> 300 300 300', ackedMin: 2700 });
  addAlert({
    type: 'agentDownAlert', idPrefix: 'LMA', objectName: 'tus-col01', objectType: 'collector', ds: 'Collector Down',
    templateType: 'AGENT', sev: 4, dp: '', value: 'down', threshold: '', startEpoch: epochAgo(COLLECTOR_DOWN_MIN - 3),
  });
  ifAlert('phx-dist-03|Te1/0/48', 'Status', 4, 118, { value: '2', threshold: '= 2' });
  ifAlert('phx-core-02|Te1/0/3', 'Status', 4, 118, { value: '2', threshold: '= 2' });
  ifAlert('phx-acc-01|Gi1/0/12', 'Status', 3, 2200, { value: '2', threshold: '= 2', ackedMin: 2100, ackComment: 'Desk move, port to be re-patched' });
  // Round 13: two access-port Status alerts (dal-acc-03, slc-acc-02) moved onto the circuit ports that went
  // down, and three access ports (dal-acc-03, slc-acc-02, den-acc-01) came back up, so the pinned alert and
  // down-interface counts hold: abq WAN2 down for 3 days, both tus WANs down for 6 hours (one alert, acked).
  ifAlert('abq-rtr-01|Te0/1/0', 'Status', 3, 4320, { value: '2', threshold: '= 2' });
  ifAlert('abq-acc-02|Gi1/0/8', 'Status', 3, 95, { value: '2', threshold: '= 2' });
  ifAlert('tus-rtr-01|Te0/1/0', 'Status', 3, 345, { value: '2', threshold: '= 2', ackedMin: 300, ackComment: 'Collector and carrier both down, ticket open' });
  ifAlert('phx-core-01|Te1/0/46', 'OutUtilizationPercent', 3, 230, { value: '91.4', threshold: '> 80 90 95' });
  ifAlert('dal-dist-01|Te1/0/47', 'InUtilizationPercent', 3, 205, { value: '87.2', threshold: '> 80 90 95' });
  ifAlert('phx-acc-05|Te1/1/1', 'InErrors', 3, 1300, { value: '4.6', threshold: '> 1 5 10' });
  ifAlert('slc-acc-01|Te1/1/1', 'InErrors', 3, 1250, { value: '3.9', threshold: '> 1 5 10' });
  ifAlert('dal-acc-02|Gi1/0/9', 'InErrors', 3, 1380, { value: '5.2', threshold: '> 1 5 10' });
  devAlert('phx-core-02', 'cpu', 'Cisco_CPU_SNMP-1', 'CPU1min', 4, 150, { value: '96', threshold: '> 80 90 95', ackedMin: 120, ackComment: 'Linked to Te1/0/3 reconvergence' });
  devAlert('dal-wan-rtr-01', 'cpu', 'Cisco_CPU_SNMP-1', 'CPU1min', 3, 420, { value: '91', threshold: '> 80 90 95', ackedMin: 400 });
  devAlert('slc-rtr-01', 'cpu', 'Cisco_CPU_SNMP-1', 'CPU1min', 3, 25, { value: '88', threshold: '> 80 90 95' });
  devAlert('phx-asa-02', 'cpu', 'Cisco_CPU_SNMP-1', 'CPU1min', 4, 70, { value: '97', threshold: '> 80 90 95' });
  devAlert('phx-dist-02', 'mem', 'Cisco_MemoryPools_SNMP-Processor', 'PercentFree', 3, 900, { value: '8.4', threshold: '< 20 10 5', ackedMin: 880 });
  devAlert('den-rtr-01', 'mem', 'Cisco_MemoryPools_SNMP-Processor', 'PercentFree', 3, 4000, { value: '12.1', threshold: '< 20 10 5', ackedMin: 3900, unrouted: true });
  devAlert('phx-f5-01', 'f5sys', 'F5_BigIP_System', 'MemoryUsage', 3, 600, { value: '92.8', threshold: '> 85 90 95', ackedMin: 580 });
  devAlert('dal-f5-01', 'f5sys', 'F5_BigIP_System', 'MemoryUsage', 3, 12, { value: '91.1', threshold: '> 85 90 95' });
  devAlert('phx-f5-02', 'f5sys', 'F5_BigIP_System', 'CPUUtilization', 2, 50, { value: '78', threshold: '> 75 90 95', unrouted: true });
  devAlert('dal-f5-02', 'f5fo', 'F5_BigIP_FailoverStatus', 'FailoverStatus', 3, 100, { value: '3', threshold: '!= 4' });
  devAlert('phx-sql-03', 'vol', 'WinVolumeUsage-C:\\', 'PercentUsed', 3, 300, { value: '93.5', threshold: '> 90 95 98' });
  devAlert('phx-file-01', 'vol', 'WinVolumeUsage-E:\\', 'PercentUsed', 4, 12 * 1440, { value: '98.7', threshold: '> 90 95 98', ackedMin: 11 * 1440, ackComment: 'Archive project waiting on storage request' });
  devAlert('dal-sql-01', 'vol', 'WinVolumeUsage-L:\\', 'PercentUsed', 3, 2000, { value: '91.2', threshold: '> 90 95 98', ackedMin: 1900 });
  devAlert('phx-app-07', 'ping', 'Ping', 'PingLossPercent', 2, 90, { value: '20', threshold: '> 10 50 100' });
  devAlert('dal-web-02', 'ping', 'Ping', 'PingLossPercent', 2, 80, { value: '20', threshold: '> 10 50 100' });
  devAlert('abq-acc-02', 'fru', 'Cisco_FRU_Power-PS2 PWR-C5-125WAC', 'OperatingStatus', 3, 100, { value: '3', threshold: '!= 2' });
  devAlert('dal-core-01', 'fru', 'Cisco_FRU_Power-PS1 PWR-C1-1500WAC', 'OperatingStatus', 3, 9 * 1440 + 30, { value: '3', threshold: '!= 2', ackedMin: 9 * 1440, ackComment: 'RMA opened with TAC', unrouted: true });
  // Dependency scenario: abq-dist-01 and the three access switches behind it stopped
  // reporting 25 minutes ago. Every access switch alerts on its host and on its
  // ports; computeShadows folds all of them under abq-dist-01.
  for (const n of ['abq-dist-01', ...ABQ_DOWNSTREAM]) {
    devAlert(n, 'host', 'HostStatus', 'idleInterval', 4, DEAD_MIN[n] - 6, { value: '1500.0', threshold: '> 300 300 300' });
  }
  [[7, 'abq-acc-03'], [7, 'abq-acc-04'], [6, 'abq-acc-05']].forEach(([count, n]) => {
    for (let p = 1; p <= count; p += 1) {
      ifAlert(`${n}|Gi1/0/${p}`, 'Status', p === 1 ? 4 : 3, 16 + (p % 4), { value: '2', threshold: '= 2' });
    }
  });
  // Round 9 WP6 scenario "duplicate-feeds": four open alerts raised by DataSources that
  // relay a platform ICC polls directly (NetApp AIQUM, Cohesity, vCenter datastore,
  // Zerto). markDuplicateAlerts tags them duplicate:<platform> once that platform has
  // a source; they then stay out of the counts, the Ops Agent and the alert list.
  [
    ['ntm_aiqum_alerts', 'snx2-nacls-01', 3, 'AggregateSpaceNearlyFull', '91', 35],
    ['ntm_cohesity_cluster_alerts', 'snx2dragcl-az', 4, 'ClusterAlertCount', '3', 55],
    ['VMware_vCenter_Datastore_Usage', 'phx-vc-01', 3, 'PercentUsed', '93.2', 140],
    ['Zerto_VPG_Status', 'phx-zvm-01', 3, 'RpoStatus', '2', 22],
  ].forEach(([ds, objectName, sev, dp, value, startMin], i) => addAlert({
    ds, objectName, objectType: 'device', instanceName: `relay-${i + 1}`, dp, sev, value, threshold: '> 90 95 98', startEpoch: epochAgo(startMin),
  }));
  // Website alerts for the down check (filled after the check plan below).

  // -- Checks plan ----------------------------------------------------------------
  const CHECKS = [
    { wid: 101, kind: 'ping', name: 'PHX core reachability', target: '10.10.0.1', locs: ['den', 'slc', 'abq', 'tus'], days: 30, base: { den: 38, slc: 29, abq: 22, tus: 14 }, degradeDen: true },
    { wid: 102, kind: 'ping', name: 'DAL core reachability', target: '10.20.0.1', locs: ['den', 'slc', 'abq', 'tus'], days: 30, base: { den: 41, slc: 44, abq: 35, tus: 33 }, degradeDen: true },
    { wid: 103, kind: 'ping', name: 'PHX DC firewall', target: '10.10.0.254', locs: ['den', 'slc', 'abq'], days: 30, base: { den: 39, slc: 30, abq: 23 }, degradeDen: true },
    { wid: 104, kind: 'ping', name: 'DAL DC firewall', target: '10.20.0.254', locs: ['den', 'slc', 'abq'], days: 2, base: { den: 42, slc: 45, abq: 36 } },
    { wid: 105, kind: 'ping', name: 'PHX ERP VIP', target: '10.10.50.10', locs: ['den', 'abq'], days: 2, base: { den: 37, abq: 21 }, downAt: 'abq' },
    { wid: 106, kind: 'ping', name: 'DAL DR replication link', target: '10.20.60.5', locs: ['phx'], days: 30, base: { phx: 24 }, latencyAt: 'phx' },
    { wid: 107, kind: 'ping', name: 'PHX VoIP gateway', target: '10.10.70.2', locs: ['slc', 'den'], days: 30, base: { slc: 31, den: 40 }, lossAt: 'slc', count: 20 },
    { wid: 108, kind: 'ping', name: 'DAL file services', target: '10.20.80.15', locs: ['abq', 'slc'], days: 30, base: { abq: 36, slc: 46 }, overallDown: true },
    { uptimeDevice: 'PHX DNS anycast', kind: 'ping', name: 'PHX DNS anycast', target: '10.10.0.53', locs: ['den', 'slc'], days: 2, base: { den: 36, slc: 28 } },
    { uptimeDevice: 'DAL DNS anycast', kind: 'ping', name: 'DAL DNS anycast', target: '10.20.0.53', locs: ['abq', 'tus'], days: 2, base: { abq: 34, tus: 32 } },
    { wid: 111, kind: 'web', name: 'Intranet portal', target: 'intranet.acme.local', locs: ['den', 'slc'], days: 2, base: { den: 240, slc: 210 } },
    { wid: 112, kind: 'web', name: 'ERP web', target: 'erp.acme.local', locs: ['abq', 'den'], days: 2, base: { abq: 320, den: 360 } },
    { wid: 113, kind: 'web', name: 'Public website', target: 'www.acme-example.com', external: [[2, 'Washington DC'], [3, 'Oregon'], [4, 'Dublin']], days: 2, base: { 2: 180, 3: 140, 4: 260 } },
    { wid: 114, kind: 'web', name: 'Customer API', target: 'api.acme-example.com', external: [[2, 'Washington DC'], [3, 'Oregon']], days: 2, base: { 2: 120, 3: 95 } },
  ];
  // One ping check per round-2 site aimed at a demo VM; the nyc one runs at
  // 3x baseline from dal-col01 for the last 2 hours (latency-anomaly on a
  // server the vCenter and LM maps both know).
  for (const [wid, site, latency] of [[115, 'nyc', true], [116, 'lon', false]]) {
    const t = dc2CheckTarget(db, site, dc2.hosts[site]);
    CHECKS.push({
      wid, kind: 'ping', name: `${site.toUpperCase()} ${t.vm || 'app server'} reachability`, target: t.ip,
      locs: ['phx', 'dal'], days: latency ? 30 : 2, base: site === 'nyc' ? { phx: 52, dal: 34 } : { phx: 138, dal: 112 },
      ...(latency ? { latencyAt: 'dal' } : {}),
    });
  }
  // Two checks created an hour ago: too few samples for a baseline (data quality list).
  CHECKS.push(
    { wid: 117, kind: 'ping', name: 'DEN guest gateway', target: '10.31.40.200', locs: ['den'], days: 0.04, base: { den: 33 } },
    { wid: 118, kind: 'ping', name: 'SLC badge controller', target: '10.32.40.201', locs: ['slc'], days: 0.04, base: { slc: 27 } },
  );
  // Round 11 WP-V: eight ZSDC_ uptime checks across four Zscaler data centre cities.
  CHECKS.push(...require('./logicmonitorServicesDemo').zsdcChecks());
  let uptimeInst = 950000;
  for (const c of CHECKS) {
    if (c.uptimeDevice) {
      const dev = byName.get(c.uptimeDevice);
      c.checkId = `u:${dev.id}`;
      c.origin = 'uptime';
    } else {
      c.checkId = `w:${c.wid}`;
      c.origin = 'website';
    }
    c.count = c.count || 5;
    c.locations = [];
    if (c.external) {
      c.isInternal = 0;
      c.external.forEach(([smg, label], i) => c.locations.push({ cpId: String(c.wid * 10 + i + 1), label, smg, collectorId: null, base: c.base[smg], key: String(smg) }));
    } else {
      c.isInternal = 1;
      c.locs.forEach((s, i) => {
        const col = COLLECTOR_BY_SITE[s];
        const cpId = c.origin === 'uptime' ? `i:${(uptimeInst += 1)}` : String(c.wid * 10 + i + 1);
        c.locations.push({ cpId, label: col.host, smg: 0, collectorId: col.id, base: c.base[s], key: s });
      });
    }
  }
  const downCheck = CHECKS.find((c) => c.overallDown);
  for (const loc of downCheck.locations) {
    addAlert({
      type: 'websiteAlert', idPrefix: 'LMS', objectName: downCheck.name, objectType: 'website', ds: downCheck.name,
      templateType: 'WEBSITE', instanceName: loc.label, dp: 'status', sev: 4, value: '24', threshold: '!= 1',
      startEpoch: epochAgo(27),
    });
  }

  // Round 10 WP-B: LM alerts that relay the Cohesity feed ICC polls itself. Both clusters exist in the
  // Cohesity demo, so the duplicate rule (device resolves to an ICC cluster) tags them.
  addAlert({
    device: COHESITY_LM_CLUSTERS[0], ds: 'Cohesity_DataPlatform_Alerts', instanceId: dsInstance(COHESITY_LM_CLUSTERS[0], 'Cohesity_DataPlatform_Alerts', 'Alerts'),
    instanceName: 'Alerts', dp: 'CriticalAlerts', sev: 3, value: '2', threshold: '> 0', startEpoch: epochAgo(240),
  });
  addAlert({
    device: COHESITY_LM_CLUSTERS[1], ds: 'Cohesity Protection Jobs', instanceId: dsInstance(COHESITY_LM_CLUSTERS[1], 'Cohesity Protection Jobs', 'SQL_Daily'),
    instanceName: 'SQL_Daily', dp: 'LastRunStatus', sev: 3, value: '2', threshold: '= 2', startEpoch: epochAgo(310),
  });

  // Cleared alerts: 400 over 30 days, 3 noisy conditions among them.
  const clearedRng = rngFor('logicmonitor-cleared');
  const noisy = [
    { n: 60, mk: () => ({ key: 'phx-acc-03|Gi1/0/17', dp: 'Status', sev: 3, value: '2', threshold: '= 2' }) },
    { n: 45, mk: () => ({ dev: 'dal-f5-01', ds: 'f5sys', label: 'F5_BigIP_System', dp: 'MemoryUsage', sev: 3, value: String(randFloat(clearedRng, 86, 94, 1)), threshold: '> 85 90 95' }) },
    { n: 40, mk: () => ({ dev: 'slc-rtr-01', ds: 'cpu', label: 'Cisco_CPU_SNMP-1', dp: 'CPU1min', sev: 3, value: String(randInt(clearedRng, 82, 95)), threshold: '> 80 90 95' }) },
  ];
  const randomPool = [
    () => ({ dev: pick(clearedRng, ['phx-core-01', 'dal-core-02', 'phx-dist-01', 'dal-wan-rtr-02', 'den-rtr-01', 'abq-rtr-01']), ds: 'cpu', label: 'Cisco_CPU_SNMP-1', dp: 'CPU1min', sev: pick(clearedRng, [3, 3, 4]), value: String(randInt(clearedRng, 81, 99)), threshold: '> 80 90 95' }),
    () => ({ dev: pick(clearedRng, ['phx-dist-02', 'dal-dist-03', 'slc-rtr-01', 'phx-asa-01']), ds: 'mem', label: 'Cisco_MemoryPools_SNMP-Processor', dp: 'PercentFree', sev: 3, value: String(randFloat(clearedRng, 6, 19, 1)), threshold: '< 20 10 5' }),
    () => {
      const f = pick(clearedRng, ifaces.filter((x) => x.cls === 'active' && x.device.hostStatus === 'normal' && !DC2_SITES.has(x.device.site) && !x.device.r3 && !x.r3));
      return { key: f.key, dp: 'Status', sev: 3, value: '2', threshold: '= 2' };
    },
    () => {
      const f = pick(clearedRng, ifaces.filter((x) => x.cls === 'uplink' && x.device.hostStatus === 'normal' && !DC2_SITES.has(x.device.site) && !x.device.r3));
      return { key: f.key, dp: pick(clearedRng, ['InUtilizationPercent', 'OutUtilizationPercent']), sev: 3, value: String(randFloat(clearedRng, 80, 93, 1)), threshold: '> 80 90 95' };
    },
    () => ({ dev: pick(clearedRng, devices.filter((d) => d.kind === 'win' && d.hostStatus === 'normal')).name, ds: 'vol', label: 'WinVolumeUsage-C:\\', dp: 'PercentUsed', sev: pick(clearedRng, [3, 4]), value: String(randFloat(clearedRng, 90, 99, 1)), threshold: '> 90 95 98' }),
    () => ({ dev: pick(clearedRng, devices.filter((d) => ['win', 'linux'].includes(d.kind) && d.hostStatus === 'normal')).name, ds: 'ping', label: 'Ping', dp: 'PingLossPercent', sev: 2, value: '20', threshold: '> 10 50 100' }),
    () => ({ dev: pick(clearedRng, ['phx-f5-02', 'dal-f5-02']), ds: 'f5sys', label: 'F5_BigIP_System', dp: 'CPUUtilization', sev: 2, value: String(randInt(clearedRng, 76, 89)), threshold: '> 75 90 95' }),
    () => ({ dev: pick(clearedRng, devices.filter((d) => ['access', 'branch-access'].includes(d.kind) && d.hostStatus === 'normal' && !DC2_SITES.has(d.site) && !d.r3)).name, ds: 'host', label: 'HostStatus', dp: 'idleInterval', sev: 4, value: String(randInt(clearedRng, 310, 900)) + '.0', threshold: '> 300 300 300' }),
  ];
  const addCleared = (spec) => {
    const startMin = randInt(clearedRng, 90, 29 * 1440);
    const durMin = randInt(clearedRng, 4, 45);
    const extra = { cleared: true, endEpoch: epochAgo(startMin - durMin), clearValue: spec.dp === 'Status' ? '1' : null, value: spec.value, threshold: spec.threshold };
    if (spec.key) ifAlert(spec.key, spec.dp, spec.sev, startMin, extra);
    else devAlert(spec.dev, spec.ds, spec.label, spec.dp, spec.sev, startMin, extra);
  };
  for (const nz of noisy) for (let i = 0; i < nz.n; i += 1) addCleared(nz.mk());
  for (let i = 0; i < 400 - 145; i += 1) addCleared(pick(clearedRng, randomPool)());

  // Device alert rollups from the open alerts.
  const openByDev = new Map();
  for (const a of alerts) {
    if (a.cleared || !a.deviceId) continue;
    const cur = openByDev.get(a.deviceId) || { sev: 0, allAcked: true };
    cur.sev = Math.max(cur.sev, a.severity);
    cur.allAcked = cur.allAcked && !!a.acked;
    openByDev.set(a.deviceId, cur);
  }
  const sevWord = (s) => (s >= 4 ? 'critical' : s === 3 ? 'error' : 'warn');
  const openByIf = new Map();
  for (const a of alerts) if (!a.cleared && a.instanceId) openByIf.set(a.instanceId, Math.max(openByIf.get(a.instanceId) || 0, a.severity));

  // -- Write: inventory --------------------------------------------------------------
  const counts = {};
  const sourceId = db.transaction(() => {
    const features = {
      netflow: true, config: true, websites: true, uptime: true, topology: true,
      ifDataSource: 'SNMP_Network_Interfaces', ifColumns: IF_COLUMNS, checkColumns: CHECK_COLUMNS,
      collectorMgd: MGD, probedAt: new Date(nowMs - 6 * 3600000).toISOString(),
    };
    const rateLimit = {
      device: { limit: 500, remaining: 471, window: 60 }, alert: { limit: 400, remaining: 388, window: 60 },
      data: { limit: 500, remaining: 452, window: 60 }, at: new Date(nowMs - 60000).toISOString(),
    };
    const insSource = db.prepare(`
      INSERT INTO lm_sources (name, company, auth_mode, encrypted_credentials, verify_ssl, enabled,
        polling_interval_minutes, interface_poll_minutes, group_filter_json, interface_categories_json,
        features_json, rate_limit_json, last_poll_status, last_poll_error, last_poll_at,
        last_interface_poll_at, last_interface_poll_error, section_errors, last_hourly_at, last_daily_at, created_at)
      VALUES (?, ?, ?, ?, 1, 1, 5, 15, ?, NULL, ?, ?, ?, ?, datetime('now', ?), ?, NULL, NULL, ?, ?, datetime('now', ?))
    `);
    const sid = insSource.run(
      SOURCE_NAME, 'acmeops', 'lmv1',
      encrypt(JSON.stringify({ accessId: 'Z3kq8Demo4AccessId', accessKey: 'demo-not-a-real-key' })),
      '[]', JSON.stringify(features), JSON.stringify(rateLimit), 'success', null, '-2 minutes',
      db.prepare("SELECT datetime('now', '-6 minutes') d").get().d,
      db.prepare("SELECT datetime('now', '-40 minutes') d").get().d,
      db.prepare("SELECT datetime('now', '-6 hours') d").get().d,
      '-90 days',
    ).lastInsertRowid;
    insSource.run(
      LAB_NAME, 'acmelab', 'bearer', encrypt(JSON.stringify({ token: 'demo-not-a-real-token' })),
      null, null, null, 'error', 'credentials rejected (check token, role and host clock)', '-4 minutes',
      null, null, null, '-20 days',
    );

    // Collectors.
    const devCount = (cid) => devices.filter((d) => d.collector && d.collector.id === cid).length;
    const insCol = db.prepare(`
      INSERT INTO lm_collectors (source_id, collector_id, description, hostname, group_id, group_name, status, is_down,
        acked, in_sdt, number_of_hosts, number_of_instances, build, platform, arch, size, uptime_seconds,
        updated_epoch, created_epoch, last_notification_epoch, backup_collector_id, collector_device_id, ea, stale, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 'amd64', ?, ?, ?, ?, ?, ?, NULL, ?, 0, datetime('now'))
    `);
    for (const c of COLLECTORS) {
      const hosts = devCount(c.id);
      insCol.run(sid, c.id, `${c.host.toUpperCase()} ${SITES[c.site].label} collector`, c.host, c.groupId, COLLECTOR_GROUPS[c.groupId],
        c.down ? 2 : 0, c.down ? 1 : 0, hosts, hosts * randInt(rng, 60, 140), c.build, c.platform,
        c.groupId === 1 ? 'large' : 'small', c.down ? 0 : randInt(rng, 5, 60) * 86400,
        c.down ? epochAgo(COLLECTOR_DOWN_MIN) : epochAgo(1), epochAgo(randInt(rng, 200, 700) * 1440),
        c.down ? epochAgo(COLLECTOR_DOWN_MIN - 4) : 0, c.backup || null, 0);
    }
    counts.collectors = COLLECTORS.length;

    // Device groups.
    const insGroup = db.prepare(`
      INSERT INTO lm_device_groups (source_id, lm_group_id, parent_id, name, full_path, description, group_type,
        applies_to, num_of_hosts, num_of_direct_devices, group_status, disable_alerting, custom_props_json, stale, updated_at)
      VALUES (?, ?, 1, ?, ?, ?, 'Normal', ?, ?, ?, ?, 0, ?, 0, datetime('now'))
    `);
    for (const [gid, path] of GROUPS) {
      const members = devices.filter((d) => d.groups.includes(gid));
      const worst = members.some((d) => d.hostStatus !== 'normal') ? 'dead' : 'normal';
      insGroup.run(sid, gid, path.split('/').pop(), path, `${path} devices`, path.startsWith('Cloud') ? 'system.cloud.category == "AWS/EC2"' : '',
        members.length, members.length, worst, JSON.stringify([{ name: 'owner', value: path.startsWith('Network') ? 'netops' : 'infra' }]));
    }
    counts.groups = GROUPS.length;

    // Interfaces first so devices get if_count / if_up.
    const insIf = db.prepare(`
      INSERT INTO lm_interfaces (source_id, lm_device_id, hds_id, instance_id, instance_name, display_name, description,
        if_index, status, status_text, speed_bps, in_mbps, out_mbps, in_errors, out_errors, in_discards, out_discards,
        in_util_pct, out_util_pct, sampled_at_epoch, stop_monitoring, disable_alerting, alert_status, sdt_status,
        props_json, stale, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 0, datetime('now'))
    `);
    const statusText = (s) => (s === 1 ? 'up' : s === 2 ? 'down' : s == null ? 'unknown' : 'other');
    // Round 10: predef.externalResourceID as LogicMonitor writes it: it describes the interface's OWN device
    // (local port MAC, the device's sysname with serial, its chassis MAC, and the interface's own port).
    // The neighbour side is seeded as CDP/LLDP neighbour instances (demoNeighbors) that buildTopologyLinks
    // resolves through that identity index, with the remote port; a few ports see unmonitored neighbours.
    const demoPortName = (p) => p.replace(/^Te/, 'TenGigabitEthernet').replace(/^Gi/, 'GigabitEthernet').toLowerCase();
    const ifaceProps = (f) => {
      const props = [{ name: 'auto.interface.alias', value: f.description }, { name: 'auto.interface.speed', value: String(f.speed) }];
      const own = f.full.toLowerCase();
      const serial = f.device.ident && f.device.ident.serial ? `(${String(f.device.ident.serial).toLowerCase()})` : '';
      const tokens = [`interface:${demoPortMac(f.device.id, f.ifIndex)}`,
        `cdp-interface:${f.device.name}.acme.local${serial}--${own}`, `lldp-interface:${demoDeviceMac(f.device.id)}--${own}`];
      const l = linkByKey.get(f.key);
      const peer = l ? byName.get(l.dst) : null;
      if (peer) {
        const port = demoPortName(l.dstPort);
        const pSerial = peer.ident && peer.ident.serial ? `(${String(peer.ident.serial).toLowerCase()})` : '';
        demoNeighbors.push({ protocol: 'cdp', srcDeviceId: f.device.id, instance: { instanceId: f.instanceId, displayName: `${peer.name}.acme.local${pSerial}`, props: { auto: { 'neighbor.local_port': f.full, 'neighbor.remote_port': port } } } });
        demoNeighbors.push({ protocol: 'lldp', srcDeviceId: f.device.id, instance: { instanceId: f.instanceId, displayName: demoDeviceMac(peer.id), props: { auto: { 'neighbor.local_port': f.full, 'neighbor.remote_port': port } } } });
      } else if (UNMONITORED_CDP[f.device.name] && f.cls !== 'uplink' && !unmonDone.has(f.device.name)) {
        unmonDone.add(f.device.name);
        demoNeighbors.push({ protocol: 'cdp', srcDeviceId: f.device.id, instance: { instanceId: f.instanceId, displayName: `${UNMONITORED_CDP[f.device.name]}.acme.local`, props: { auto: { 'neighbor.local_port': f.full, 'neighbor.remote_port': 'eth0' } } } });
      }
      props.push({ name: 'predef.externalResourceID', value: tokens.join(',') });
      // Round 13: circuit ports carry the CG tag class, so they use the object shape the poller writes
      // ({auto, iccClass}); every other port keeps the name/value list.
      const cgClass = R13_CLASS[f.key];
      if (!cgClass) return props;
      return { auto: Object.fromEntries(props.map((p) => [p.name, p.value])), iccClass: cgClass };
    };
    for (const f of ifaces) {
      const d = f.device;
      let inU = f.baseIn;
      let outU = f.baseOut;
      if (HOT[f.key]) { if (HOT[f.key].dir === 'out') outU = HOT[f.key].pct; else inU = HOT[f.key].pct; }
      if (f.status !== 1) { inU = 0; outU = 0; }
      let errs = ERR_PORTS.has(f.key) ? randFloat(rng, 3, 6, 1) : 0;
      const cur3 = R3_CURRENT[f.key];
      if (cur3) { if (cur3.inU != null) inU = cur3.inU; if (cur3.outU != null) outU = cur3.outU; if (cur3.errs != null) errs = cur3.errs; }
      const stormDisc = d.name.startsWith('dal-acc-') && /^Gi1\/0\/(\d|1[0-4])$/.test(f.short) ? randInt(rng, 240, 980) : 0;
      const sampledMin = d.site === 'tus' ? COLLECTOR_DOWN_MIN : DEAD_MIN[d.name] || 3;
      f.cur = { inU, outU, errs };
      const sev = openByIf.get(f.instanceId);
      insIf.run(sid, d.id, d.ifHds, f.instanceId, f.instanceName, f.full, f.description, f.ifIndex, f.status, statusText(f.status),
        f.speed, round2(inU * f.speed / 1e8), round2(outU * f.speed / 1e8), errs, ERR_PORTS.has(f.key) ? 0.4 : 0, stormDisc, 0,
        round2(inU), round2(outU), epochAgo(sampledMin),
        sev ? `unconfirmed-${sevWord(sev)}-none` : 'none', d.inSdt ? 'none-SDT-none' : 'none-none-none',
        JSON.stringify(ifaceProps(f)));
      d.ifCount = (d.ifCount || 0) + 1;
      if (f.status === 1) d.ifUp = (d.ifUp || 0) + 1;
    }
    counts.interfaces = ifaces.length;

    // Devices.
    const insDev = db.prepare(`
      INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, description, device_type, host_status, alert_status,
        alert_status_priority, sdt_status, alert_disable_status, disable_alerting, group_ids_json, collector_id,
        preferred_collector_id, collector_description, enable_netflow, uptime_seconds, created_epoch, updated_epoch,
        deleted_time_ms, sysinfo, sysoid, sysname, hostname, model, vendor, role, is_network, categories, ips_json, version,
        serial, eri_json, ert, system_props_json, auto_props_json, custom_props_json, if_count, if_up, dead_since,
        first_seen, stale, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, datetime('now', ?), 0, datetime('now', ?))
    `);
    const deadSinceStmt = db.prepare("SELECT datetime('now', ?) d");
    for (const d of devices) {
      const id = d.ident;
      const fqdn = d.kind.startsWith('aws') || d.kind === 'azure-er' || d.kind === 'uptime' ? null : `${d.name}.acme.local`;
      const open = openByDev.get(d.id);
      const alertStatus = open ? `${open.allAcked ? 'confirmed' : 'unconfirmed'}-${sevWord(open.sev)}-${d.inSdt ? 'SDT' : 'none'}` : 'none';
      const priority = open ? (open.sev >= 4 ? 1 : open.sev === 3 ? 2 : 3) : 100000;
      const deadOffset = d.hostStatus === 'dead' ? DEAD[d.name] : d.hostStatus === 'dead-collector' ? `-${COLLECTOR_DOWN_MIN} minutes` : null;
      const newDays = NEW_DEVICES[d.name];
      const lr = d.r8 ? r8Rng : rng;
      const firstSeen = newDays ? `-${newDays} days` : `-${randInt(lr, 85, 89)} days`;
      const createdEpoch = newDays ? epochAgo(newDays * 1440 + 30) : epochAgo(randInt(lr, 120, 900) * 1440);
      const mac = demoDeviceMac(d.id);
      const sysProps = [
        { name: 'system.displayname', value: d.name }, { name: 'system.hostname', value: fqdn || d.ip },
        { name: 'system.ips', value: d.ip }, { name: 'system.categories', value: id.categories },
      ];
      if (id.sysinfo) sysProps.push({ name: 'system.sysinfo', value: id.sysinfo });
      if (id.sysoid) sysProps.push({ name: 'system.sysoid', value: id.sysoid });
      if (d.collector) sysProps.push({ name: 'system.collectorid', value: String(d.collector.id) });
      const autoProps = [];
      if (id.serial) autoProps.push({ name: 'auto.endpoint.serial_number', value: id.serial });
      if (id.model) autoProps.push({ name: 'auto.endpoint.model', value: id.model });
      if (id.ert) autoProps.push({ name: 'predef.externalResourceType', value: id.ert });
      if (fqdn) autoProps.push({ name: 'predef.externalResourceID', value: [mac, d.ip, fqdn].join(',') });
      // The site property mirrors the site group's last path segment so the
      // property rule and the group rule yield the same site key.
      const custom = [];
      if (d.kind.startsWith('aws')) custom.push({ name: 'site', value: 'AWS' });
      const cloudP = require('./logicmonitorIpslaCloudDemo').cloudProps(d);
      if (cloudP) { custom.push(...cloudP.custom); sysProps.push(...cloudP.system); }
      if (SITES[d.site]) custom.push({ name: 'site', value: SITES[d.site].group ? SITES[d.site].group.split('/').pop() : SITES[d.site].label });
      if (d.ident.deviceType === 0 && d.isNetwork) custom.push({ name: 'snmp.version', value: 'v3' });
      const disableAlerting = d.name === 'phx-lab-01' ? 1 : 0;
      const description = d.kind === 'uptime' ? `LM Uptime ping check to ${d.target}` : `${SITES[d.site] ? SITES[d.site].label : 'AWS'} ${d.kind.replace('-', ' ')}`;
      insDev.run(
        sid, d.id, fqdn || d.ip || d.name, d.name, description, id.deviceType, d.hostStatus, alertStatus, priority,
        d.inSdt ? 'none-SDT-none' : 'none-none-none', disableAlerting ? 'none-disable-none' : 'none-none-none', disableAlerting,
        JSON.stringify(d.groups), d.collector ? d.collector.id : 0, d.collector ? d.collector.id : 0,
        d.collector ? `${d.collector.host.toUpperCase()} ${SITES[d.collector.site].label} collector` : '',
        ['core', 'wan-rtr'].includes(d.kind) ? 1 : 0,
        d.hostStatus === 'normal' ? randInt(lr, 3, 400) * 86400 : null, createdEpoch, epochAgo(d.hostStatus === 'normal' ? 5 : (DEAD_MIN[d.name] || COLLECTOR_DOWN_MIN)),
        id.sysinfo, id.sysoid, fqdn ? d.name : null, fqdn || d.ip, id.model, d.vendor, d.role, d.isNetwork, id.categories,
        JSON.stringify(d.ip ? [d.ip] : []), d.version, id.serial,
        fqdn ? JSON.stringify({ mac: [mac], ip: [d.ip], fqdn: [fqdn] }) : JSON.stringify({ mac: [], ip: [], fqdn: [] }),
        id.ert, JSON.stringify(sysProps), JSON.stringify(autoProps), JSON.stringify(custom), d.ifCount || 0, d.ifUp || 0,
        deadOffset ? deadSinceStmt.get(deadOffset).d : null, firstSeen, deadOffset || '+0 seconds',
      );
    }
    counts.devices = devices.length;
    counts.networkDevices = devices.filter((d) => d.isNetwork).length;

    // Device datasources (network devices only; the poller refreshes these daily).
    const insDds = db.prepare(`
      INSERT INTO lm_device_datasources (source_id, lm_device_id, hds_id, datasource_id, datasource_name, datasource_display_name,
        instance_count, monitoring_instance_count, alert_status, sdt_status, stop_monitoring, is_interface, is_neighbor, refreshed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, datetime('now', '-6 hours'))
    `);
    const uplinkCount = new Map();
    for (const l of links) uplinkCount.set(l.src, (uplinkCount.get(l.src) || 0) + 1);
    let ddsRows = 0;
    for (const d of devices.filter((x) => x.isNetwork)) {
      const sdt = d.inSdt ? 'none-SDT-none' : 'none-none-none';
      const rows = [[101, 'HostStatus', 'Host Status', 1, 0, 0], [102, 'Ping', 'Ping', 1, 0, 0]];
      if (d.ifHds) rows.push([501, 'SNMP_Network_Interfaces', 'Network Interfaces', d.ifCount || 0, 1, 0, d.ifHds]);
      if (d.vendor === 'Cisco') rows.push([601, 'Cisco_CPU_SNMP', 'Cisco CPU', 1, 0, 0], [602, 'Cisco_MemoryPools_SNMP', 'Cisco Memory Pools', 2, 0, 0]);
      if (d.role === 'switch') rows.push([603, 'Cisco_FRU_Power', 'Cisco FRU Power', 2, 0, 0]);
      if (['access', 'branch-access'].includes(d.kind)) rows.push([604, 'Cisco_Catalyst_PowerOverEthernet', 'Cisco Catalyst PoE', 1, 0, 0]);
      if (['core', 'dist', 'access', 'branch-access', 'wan-rtr', 'branch-rtr'].includes(d.kind) && !NO_NEIGHBOR_DS.has(d.name)) {
        rows.push([611, 'LLDP_Neighbors', 'LLDP Neighbors', uplinkCount.get(d.name) || 1, 0, 1]);
        rows.push([612, 'CDP_Neighbors', 'CDP Neighbors', uplinkCount.get(d.name) || 1, 0, 1]);
      }
      if (d.kind === 'wan-rtr') rows.push([620, 'BGP-', 'BGP', 2, 0, 0]);
      if (d.role === 'router') rows.push([621, 'OSPF_Neighbors', 'OSPF Neighbors', 2, 0, 0]);
      if (d.kind === 'asa') rows.push([630, 'CiscoASA', 'Global PIX/ASA Stats', 1, 0, 0], [631, 'Cisco_ASA_Failover', 'Cisco ASA Failover', 1, 0, 0]);
      if (d.kind === 'f5') {
        rows.push([701, 'F5_BigIP_System', 'F5 BIG-IP System', 1, 0, 0], [702, 'F5_BigIP_FailoverStatus', 'F5 BIG-IP Failover Status', 1, 0, 0],
          [703, 'F5_BigIP_SSL_VIP_Certs', 'F5 BIG-IP SSL VIP Certificates', randInt(rng, 6, 18), 0, 0]);
      }
      if (d.kind === 'ap') rows.push([801, 'Cisco_Meraki_AccessPointHealth', 'Meraki Access Point Health', 1, 0, 0]);
      for (const [dsId, dsName, display, inst, isIf, isNb, fixedHds] of rows) {
        const hds = fixedHds || hdsSeq++;
        insDds.run(sid, d.id, hds, dsId, dsName, display, inst, inst, 'none', sdt, isIf, isNb);
        ddsRows += 1;
      }
    }
    counts.deviceDatasources = ddsRows;
    counts.dsMetrics = seedDsMetrics(db, { sid, devices, ifaces, nowMs });

    // SDTs: 5 effective device SDTs plus a future collector SDT and a weekly group SDT.
    const insSdt = db.prepare(`
      INSERT INTO lm_sdts (source_id, sdt_id, sdt_type, schedule_type, is_effective, start_ms, end_ms, duration, admin, comment,
        lm_device_id, device_display_name, group_id, group_full_path, collector_id, datasource_name, instance_id, website_id,
        raw_json, stale, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 0, datetime('now'))
    `);
    const sdtComments = ['Firmware upgrade window CHG0041872', 'F5 pair failover test', 'SQL CU patching', 'Kernel patching', 'IIS migration'];
    SDT_DEVICES.forEach((n, i) => {
      const d = byName.get(n);
      const startMs = nowMs - (i < 2 ? 2 : 26) * 3600000;
      const endMs = nowMs + (4 + i) * 3600000;
      insSdt.run(sid, `R_${31 + i}`, 'ResourceSDT', 'oneTime', 1, startMs, endMs, Math.round((endMs - startMs) / 60000),
        pick(rng, ['k.ramirez', 'p.nguyen', 'admin.ops']), sdtComments[i], d.id, d.name, null, null, null,
        JSON.stringify({ id: `R_${31 + i}`, type: 'ResourceSDT', sdtType: 'oneTime', deviceId: d.id, startDateTime: startMs, endDateTime: endMs }));
    });
    insSdt.run(sid, 'C_7', 'CollectorSDT', 'oneTime', 0, nowMs + 3 * 86400000, nowMs + 3 * 86400000 + 7200000, 120, 'admin.ops',
      'dal-col01 host patching', null, null, null, null, 12, JSON.stringify({ id: 'C_7', type: 'CollectorSDT', collectorId: 12 }));
    insSdt.run(sid, 'HG_3', 'ResourceGroupSDT', 'weekly', 0, null, null, 180, 'admin.ops', 'Windows patch Sunday',
      null, null, GROUP_ID['Servers/Windows'], 'Servers/Windows', null, JSON.stringify({ id: 'HG_3', type: 'ResourceGroupSDT', sdtType: 'weekly', weekDay: 'Sunday', hour: 2, endHour: 5 }));
    counts.sdts = SDT_DEVICES.length + 2;

    // Alerts.
    const insAlert = db.prepare(`
      INSERT INTO lm_alerts (source_id, lm_alert_id, internal_id, type, severity, severity_norm, lm_device_id, monitor_object_name,
        monitor_object_type, resource_template_name, resource_template_type, instance_id, instance_name, instance_description,
        data_point_name, alert_value, threshold, clear_value, start_epoch, end_epoch, acked, acked_by, ack_comment, acked_epoch,
        sdted, suppressor, cleared, closed_reason, rule, rule_id, chain, anomaly, ad_alert, condition_key, raw_json, captured_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, 0, ?, ?, datetime('now'), datetime('now'))
    `);
    const ckey = (a) => (lmApi && lmApi.conditionKey
      ? lmApi.conditionKey(sid, { monitorObjectName: a.objectName, resourceTemplateName: a.template, instanceName: a.instanceName, dataPointName: a.dataPoint })
      : `lm:${sid}:${String(a.objectName).toLowerCase()}:${a.template}:${a.instanceName || ''}:${a.dataPoint || ''}`);
    for (const a of alerts) {
      insAlert.run(sid, a.lmAlertId, a.internalId, a.type, a.severity, sevNorm(a.severity), a.deviceId, a.objectName, a.objectType,
        a.template, a.templateType, a.instanceId, a.instanceName, a.instanceDescription, a.dataPoint, a.value, a.threshold,
        a.clearValue, a.startEpoch, a.endEpoch, a.acked, a.ackedBy, a.ackComment, a.ackedEpoch, a.sdted, a.suppressor, a.cleared,
        a.rule, a.ruleId, a.chain, ckey(a),
        JSON.stringify({ id: a.lmAlertId, type: a.type, severity: a.severity, monitorObjectName: a.objectName, resourceTemplateName: a.template, instanceName: a.instanceName, dataPointName: a.dataPoint, startEpoch: a.startEpoch }));
    }
    counts.alertsOpen = alerts.filter((a) => !a.cleared).length;
    counts.alertsCleared = alerts.filter((a) => a.cleared).length;
    counts.alertsAcked = alerts.filter((a) => !a.cleared && a.acked).length;
    counts.alertsSdted = alerts.filter((a) => !a.cleared && a.sdted).length;

    // Checks and their locations (last_* filled after the history pass).
    const insCheck = db.prepare(`
      INSERT INTO lm_checks (source_id, check_id, kind, origin, name, target, description, status, alert_status, sdt_status,
        overall_alert_level, polling_interval, transition, global_sm_alert_cond, is_internal, stop_monitoring, disable_alerting,
        group_id, test_location_json, collectors_json, steps_json, raw_json, stale, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, 'none-none-none', 'warn', 5, 1, 0, ?, 0, 0, 1, ?, ?, ?, ?, 0, datetime('now'))
    `);
    for (const c of CHECKS) {
      const cols = c.isInternal ? c.locations.map((l) => {
        const col = COLLECTORS.find((x) => x.id === l.collectorId);
        return { id: col.id, hostname: col.host, description: `${col.host.toUpperCase()} collector`, collectorGroupId: col.groupId, collectorGroupName: COLLECTOR_GROUPS[col.groupId], status: col.down ? 'down' : 'active' };
      }) : [];
      const testLocation = c.isInternal ? { collectorIds: c.locations.map((l) => l.collectorId) } : { smgIds: c.locations.map((l) => l.smg) };
      const steps = c.kind === 'web' ? [{ url: '/', HTTPMethod: 'GET', statusCode: '200', followRedirection: true, timeout: 30 }] : null;
      insCheck.run(sid, c.checkId, c.kind, c.origin, c.name, c.target,
        c.kind === 'web' ? `HTTPS check of ${c.target}` : `Ping ${c.target}, ${c.count} packets`,
        c.overallDown ? 'unconfirmed-critical-none' : 'none', c.isInternal,
        JSON.stringify(testLocation), JSON.stringify(cols), steps ? JSON.stringify(steps) : null,
        JSON.stringify({ type: c.origin === 'uptime' ? 'uptimepingcheck' : c.kind === 'web' ? 'webcheck' : 'pingcheck', host: c.target, count: c.count, isInternal: !!c.isInternal }));
    }
    counts.checks = CHECKS.length;
    return sid;
  })();

  // -- Write: interface history and daily ------------------------------------------
  const ifHist = db.transaction(() => {
    const ins = db.prepare(`
      INSERT INTO lm_interface_history (source_id, instance_id, captured_at, status, in_mbps, out_mbps, in_errors, out_errors,
        in_discards, out_discards, in_util_pct, out_util_pct)
      VALUES (?, ?, datetime('now', ?), ?, ?, ?, ?, ?, 0, 0, ?, ?)
    `);
    const insDaily = db.prepare(`
      INSERT INTO lm_interface_daily (source_id, instance_id, day, samples, down_samples, flaps, max_in_util_pct, max_out_util_pct,
        avg_in_util_pct, avg_out_util_pct, errors_sum, discards_sum, in_mbps_avg, out_mbps_avg)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const hRng = rngFor('logicmonitor-if-history');
    const r3hRng = rngFor('logicmonitor-r3-if-history');
    const r13hRng = rngFor('logicmonitor-r13-if-history');
    const spikeDays = new Set([1, 2, 3].map((d) => dayOf(d * 1440)));
    // Backup nights: 01:00 to 03:00 UTC, one and three nights ago. Only the
    // night one night ago runs hot on the ports (see seedRound3Data).
    const hotWindow = backupWindow(nowMs, 1);
    let rows = 0;
    let dailyRows = 0;
    for (const f of ifaces) {
      const daily = new Map();
      if (f.history) {
        const n = f.history * 96;
        const rr = f.r13 ? r13hRng : f.r3 ? r3hRng : hRng;
        let prevStatus = null;
        for (let k = n - 1; k >= 0; k -= 1) {
          const m = k * IF_STEP_MIN + 3;
          const hourPhx = (((nowMs - m * 60000) / 3600000 - 7) % 24 + 24) % 24;
          const diurnal = Math.max(0.15, 0.55 + 0.45 * Math.sin(Math.PI * (hourPhx - 7) / 12));
          let inU = f.baseIn * diurnal * randFloat(rr, 0.9, 1.1, 3);
          let outU = f.baseOut * diurnal * randFloat(rr, 0.9, 1.1, 3);
          const tMs = nowMs - m * 60000;
          const hrUtc = new Date(tMs).getUTCHours();
          let inErr3 = null;
          if (f.key === SAT_KEY) {
            if (hrUtc >= SAT_HOUR_FROM && hrUtc <= SAT_HOUR_TO) { inU = randFloat(rr, 84, 90, 1); outU = randFloat(rr, 55, 68, 1); } else { inU = randFloat(rr, 25, 50, 1); outU = randFloat(rr, 20, 40, 1); }
            if (spikeDays.has(dayOf(m)) && hrUtc === 17 && new Date(tMs).getUTCMinutes() < 30) inU = randFloat(rr, 96.2, 97.8, 1);
          } else if (f.key === UTIL_ANOM_KEY) {
            inU = randFloat(rr, 9, 11, 1); outU = randFloat(rr, 5, 7, 1);
            if (k < 4) { inU = randFloat(rr, 30.5, 33.5, 1); outU = randFloat(rr, 13, 15, 1); }
          } else if (f.key === ERR_ANOM_KEY) {
            inErr3 = k < 4 ? [randFloat(rr, 11, 16, 1), randFloat(rr, 0, 1, 1)] : [0, 0];
          } else if (BACKUP_HOT.has(f.key) && tMs >= hotWindow.start && tMs < hotWindow.end) {
            inU = randFloat(rr, 83, 88, 1); outU = randFloat(rr, 80, 86, 1);
          }
          const hot = HOT[f.key];
          if (hot && k < 16) {
            const v = randFloat(hRng, hot.pct - 2, hot.pct + 3, 1);
            if (hot.dir === 'out') outU = v; else inU = v;
          }
          let status = 1;
          if (DOWN_UPLINKS.has(f.key) && k < 8) status = 2;
          if (FLAP_PORTS.has(f.key) && (k < 96 ? FLAP_ROWS.has(k) : chance(hRng, 0.004))) status = 2;
          if (R13_DOWN_SINCE_K[f.key] && k < R13_DOWN_SINCE_K[f.key]) status = 2;
          if (R13_FLAP_KEYS.has(f.key) && r13FlapDown(k)) status = 2;
          if (status !== 1) { inU = 0; outU = 0; }
          const inErr = inErr3 ? inErr3[0] : ERR_PORTS.has(f.key) && k < 96 ? randFloat(hRng, 2, 6, 1) : 0;
          const outErr = inErr3 ? inErr3[1] : ERR_PORTS.has(f.key) && k < 96 ? randFloat(hRng, 0, 1, 1) : 0;
          ins.run(sourceId, f.instanceId, `-${m} minutes`, status, round2(inU * f.speed / 1e8), round2(outU * f.speed / 1e8), inErr, outErr, round2(inU), round2(outU));
          rows += 1;
          const day = dayOf(m);
          if (day !== todayStr) {
            const g = daily.get(day) || { n: 0, down: 0, flaps: 0, maxIn: 0, maxOut: 0, sumIn: 0, sumOut: 0, err: 0, mIn: 0, mOut: 0 };
            g.n += 1;
            if (status !== 1) g.down += 1;
            if (prevStatus != null && prevStatus !== status) g.flaps += 1;
            g.maxIn = Math.max(g.maxIn, inU); g.maxOut = Math.max(g.maxOut, outU);
            g.sumIn += inU; g.sumOut += outU; g.err += inErr + outErr;
            g.mIn += inU * f.speed / 1e8; g.mOut += outU * f.speed / 1e8;
            daily.set(day, g);
          }
          prevStatus = status;
        }
      }
      // Synthetic daily rows for the 30 days (or up to the day a device died).
      const deadMin = f.device.hostStatus === 'dead' ? DEAD_MIN[f.device.name] : 0;
      for (let dOff = 1; dOff <= 30; dOff += 1) {
        const day = dayOf(dOff * 1440);
        if (dOff * 1440 < deadMin) continue;
        if (daily.has(day)) continue;
        if (f.history === 30) continue;
        const down = f.status === 2 && !DOWN_UPLINKS.has(f.key) && !R13_DOWN_SINCE_K[f.key] ? 96 : 0;
        const k = down ? 0 : 1;
        const maxIn = f.baseIn * randFloat(hRng, 1.1, 1.4, 2) * k;
        const maxOut = f.baseOut * randFloat(hRng, 1.1, 1.4, 2) * k;
        const avgIn = f.baseIn * 0.6 * k;
        const avgOut = f.baseOut * 0.6 * k;
        daily.set(day, {
          n: 96, down, flaps: FLAP_PORTS.has(f.key) ? randInt(hRng, 0, 2) : 0, maxIn, maxOut, sumIn: avgIn * 96, sumOut: avgOut * 96,
          err: ERR_PORTS.has(f.key) ? randInt(hRng, 0, 20) : 0, mIn: avgIn * f.speed / 1e8 * 96, mOut: avgOut * f.speed / 1e8 * 96,
        });
      }
      for (const [day, g] of daily) {
        insDaily.run(sourceId, f.instanceId, day, g.n, g.down, g.flaps, round2(g.maxIn), round2(g.maxOut),
          round2(g.sumIn / g.n), round2(g.sumOut / g.n), round2(g.err), 0, round2(g.mIn / g.n), round2(g.mOut / g.n));
        dailyRows += 1;
      }
    }
    return { rows, dailyRows };
  })();
  counts.interfaceHistory = ifHist.rows;
  counts.interfaceDaily = ifHist.dailyRows;

  // -- Write: check history, daily and location state -------------------------------
  const chk = db.transaction(() => {
    const ins = db.prepare(`
      INSERT INTO lm_check_history (source_id, check_id, checkpoint_id, captured_at, sample_epoch, status, rtt_avg_ms, rtt_min_ms,
        rtt_max_ms, loss_pct, response_ms, raw_json)
      VALUES (?, ?, ?, datetime('now', ?), ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insLoc = db.prepare(`
      INSERT INTO lm_check_locations (source_id, check_id, checkpoint_id, label, smg_id, collector_id, is_overall, last_status,
        last_rtt_ms, last_loss_pct, last_response_ms, last_sample_epoch, stale, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
    `);
    const insDaily = db.prepare(`
      INSERT INTO lm_check_daily (source_id, check_id, checkpoint_id, day, samples, down_samples, rtt_avg, rtt_p95, loss_avg,
        loss_max, response_avg)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const cRng = rngFor('logicmonitor-check-history');
    let rows = 0;
    let dailyRows = 0;
    let locRows = 0;
    const writeDaily = (c, cpId, daily) => {
      for (const [day, g] of daily) {
        const hourly = [...g.hours.values()].map((h) => h.sum / h.n);
        // rtt_p95 is approximate: the max of the hourly averages for the day.
        insDaily.run(sourceId, c.checkId, cpId, day, g.n, g.down, g.rttN ? round2(g.rtt / g.rttN) : null,
          hourly.length ? round2(Math.max(...hourly)) : null, g.lossN ? round2(g.loss / g.lossN) : null,
          g.lossN ? round2(g.lossMax) : null, g.respN ? round2(g.resp / g.respN) : null);
        dailyRows += 1;
      }
    };
    for (const c of CHECKS) {
      const n = Math.ceil(c.days * 288);
      const downAt = new Map();
      for (const loc of c.locations) {
        const daily = new Map();
        const tusDown = loc.collectorId === 24;
        let last = null;
        for (let k = n - 1; k >= 0; k -= 1) {
          const m = k * CHECK_STEP_MIN + 1;
          if (tusDown && m < COLLECTOR_DOWN_MIN) continue;
          const epoch = epochAgo(m);
          const hourUtc = new Date(epoch * 1000).getUTCHours();
          const wobble = Math.sin((hourUtc / 24) * 2 * Math.PI) * 0.06;
          let status = 'up';
          let rtt = null; let rmin = null; let rmax = null; let loss = null; let resp = null; let raw = null;
          const isDown = (c.overallDown && m < 30) || (c.downAt === loc.key && m < 20);
          if (c.kind === 'ping') {
            const sent = c.count;
            let lost = m > 60 && chance(cRng, 0.003) ? 1 : 0;
            let factor = 1 + wobble;
            if (c.degradeDen && loc.key === 'den' && m < 60) factor = 2.6;
            if (c.latencyAt === loc.key && m < 120) factor = 3;
            if (c.lossAt === loc.key && m < 120) { lost = 3; factor = 1.1; }
            if (isDown) { status = 'down'; lost = sent; }
            const recv = sent - lost;
            loss = round2(100 * (1 - recv / sent));
            if (recv > 0) {
              rtt = round2(loc.base * factor + randFloat(cRng, -2.5, 2.5, 2));
              rmin = round2(Math.max(0.5, rtt - randFloat(cRng, 1, 3, 2)));
              rmax = round2(rtt + randFloat(cRng, 2, 8, 2));
            }
            if (m < 1440) raw = JSON.stringify({ [CHECK_COLUMNS.ping.sent]: sent, [CHECK_COLUMNS.ping.received]: recv, [CHECK_COLUMNS.ping.rtt_min_ms]: rmin, [CHECK_COLUMNS.ping.rtt_max_ms]: rmax, [CHECK_COLUMNS.ping.rtt_avg_ms]: rtt, status: isDown ? 24 : 1 });
          } else {
            if (isDown) status = 'down';
            else resp = round2(loc.base * (1 + wobble) + randFloat(cRng, -25, 40, 1));
            if (m < 1440) raw = JSON.stringify({ [CHECK_COLUMNS.web.response_ms]: resp, status: isDown ? 2 : 1, sslDaysUntilExpiration: 74 });
          }
          if (isDown) downAt.set(m, (downAt.get(m) || 0) + 1);
          ins.run(sourceId, c.checkId, loc.cpId, `-${m} minutes`, epoch, status, rtt, rmin, rmax, loss, resp, raw);
          rows += 1;
          last = { status, rtt, loss, resp, epoch };
          const day = dayOf(m);
          if (day !== todayStr) {
            const g = daily.get(day) || { n: 0, down: 0, rtt: 0, rttN: 0, loss: 0, lossN: 0, lossMax: 0, resp: 0, respN: 0, hours: new Map() };
            g.n += 1;
            if (status === 'down') g.down += 1;
            if (rtt != null) {
              g.rtt += rtt; g.rttN += 1;
              const hk = Math.floor(epoch / 3600);
              const h = g.hours.get(hk) || { sum: 0, n: 0 };
              h.sum += rtt; h.n += 1; g.hours.set(hk, h);
            }
            if (loss != null) { g.loss += loss; g.lossN += 1; g.lossMax = Math.max(g.lossMax, loss); }
            if (resp != null) { g.resp += resp; g.respN += 1; }
            daily.set(day, g);
          }
        }
        writeDaily(c, loc.cpId, daily);
        const lastStatus = tusDown ? 'unknown' : last.status;
        insLoc.run(sourceId, c.checkId, loc.cpId, loc.label, loc.smg, loc.collectorId, 0, lastStatus,
          last.rtt, last.loss, last.resp, last.epoch);
        locRows += 1;
      }
      // Overall checkpoint: 24 h of status rows (no aggregated RTT is published).
      let lastOverall = null;
      const total = c.locations.length;
      for (let k = 287; k >= 0; k -= 1) {
        const m = k * CHECK_STEP_MIN + 1;
        const failed = downAt.get(m) || 0;
        const status = failed && failed >= total ? 'down' : 'up';
        const epoch = epochAgo(m);
        ins.run(sourceId, c.checkId, 'overall', `-${m} minutes`, epoch, status, null, null, null, null, null,
          JSON.stringify({ overallStatus: status === 'down' ? 2 : 1, totalSmCount: total, failSmCount: failed, reportlSmEpoch: epoch }));
        rows += 1;
        lastOverall = { status, epoch };
      }
      insLoc.run(sourceId, c.checkId, 'overall', 'Overall', 0, null, 1, lastOverall.status, null, null, null, lastOverall.epoch);
      locRows += 1;
    }
    return { rows, dailyRows, locRows };
  })();
  counts.checkHistory = chk.rows;
  counts.checkDaily = chk.dailyRows;
  counts.checkLocations = chk.locRows;

  // -- Write: admins, roles, metrics history -----------------------------------------
  db.transaction(() => {
    const roles = [
      [1, 'administrator', 'Full access', 1, ['*']],
      [2, 'manager', 'Manage devices, alerts and dashboards', 0, ['devices:manage', 'alerts:manage', 'dashboards:manage']],
      [3, 'readonly', 'View only', 0, ['*:view']],
      [4, 'ackonly', 'View, acknowledge and SDT', 0, ['*:view', 'alerts:ack', 'sdt:manage']],
    ];
    const admins = [
      [1, 'admin.ops', 'admin.ops@acme.example', 'active', ['administrator'], 1, 0, 30, 1],
      [2, 'k.ramirez', 'k.ramirez@acme.example', 'active', ['manager'], 0, 0, 120, 1],
      [3, 'p.nguyen', 'p.nguyen@acme.example', 'active', ['manager'], 0, 0, 2 * 1440, 1],
      [4, 't.okafor', 't.okafor@acme.example', 'active', ['readonly'], 0, 0, 9 * 1440, 0],
      [5, 'm.chen', 'm.chen@acme.example', 'suspended', ['manager'], 0, 0, 140 * 1440, 1],
      [6, 'svc-icc-readonly', 'netops@acme.example', 'active', ['readonly'], 1, 1, 3, 0],
      [7, 'svc-servicenow', 'itsm@acme.example', 'active', ['manager'], 2, 1, 1, 0],
      [8, 'l.patel', 'l.patel@acme.example', 'active', ['readonly'], 0, 0, null, 1],
      [9, 'noc.shared', 'noc@acme.example', 'active', ['ackonly'], 0, 0, 15, 1],
    ];
    const insRole = db.prepare(`
      INSERT INTO lm_roles (source_id, role_id, name, description, user_count, two_fa_required, privileges_json, stale, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
    `);
    for (const [id, name, desc, twoFa, privs] of roles) {
      insRole.run(sourceId, id, name, desc, admins.filter((a) => a[4].includes(name)).length, twoFa, JSON.stringify(privs.map((p) => ({ objectType: p.split(':')[0], operation: p.split(':')[1] || 'write' }))));
    }
    const insAdmin = db.prepare(`
      INSERT INTO lm_admins (source_id, admin_id, username, email, status, roles_json, api_token_count, apionly, last_login_epoch,
        two_fa, created_by, stale, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
    `);
    for (const [id, user, email, status, roleNames, tokens, apionly, loginMin, twoFa] of admins) {
      insAdmin.run(sourceId, id, user, email, status, JSON.stringify(roleNames), tokens, apionly,
        loginMin == null ? null : epochAgo(loginMin), twoFa, id === 1 ? 'system' : 'admin.ops');
    }
    counts.admins = admins.length;
    counts.roles = roles.length;

    // Hourly metrics for 30 days, current hour equal to the seeded state.
    const insMetric = db.prepare(`
      INSERT INTO lm_metrics_history (source_id, captured_at, devices_total, devices_normal, devices_dead, devices_dead_collector,
        devices_in_sdt, network_devices, interfaces_total, interfaces_up, interfaces_down, alerts_critical, alerts_error,
        alerts_warning, alerts_acked, collectors_total, collectors_down, checks_total, checks_down, checks_degraded)
      VALUES (?, datetime('now', ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const mRng = rngFor('logicmonitor-metrics');
    const open = alerts.filter((a) => !a.cleared);
    const ifTotal = ifaces.length;
    const ifDownNow = ifaces.filter((f) => f.status === 2).length;
    for (let h = 719; h >= 0; h -= 1) {
      const mins = h * 60;
      const total = devices.filter((d) => !NEW_DEVICES[d.name] || NEW_DEVICES[d.name] * 1440 > mins).length;
      const dead = Object.keys(DEAD).filter((n) => DEAD_MIN[n] > mins).length;
      const deadCol = mins < COLLECTOR_DOWN_MIN ? 14 : 0;
      const sdt = mins < 120 ? SDT_DEVICES.length : mins < 26 * 60 ? 3 : 0;
      const ifDown = h === 0 ? ifDownNow : Math.max(0, 8 + randInt(mRng, -1, 1) + (mins < 120 ? 2 : 0));
      const crit = h === 0 ? open.filter((a) => a.severity >= 4).length : randInt(mRng, 3, 9) + (mins < COLLECTOR_DOWN_MIN ? 2 : 0);
      const err = h === 0 ? open.filter((a) => a.severity === 3).length : randInt(mRng, 12, 26);
      const warn = h === 0 ? open.filter((a) => a.severity === 2).length : randInt(mRng, 1, 5);
      insMetric.run(sourceId, `-${mins} minutes`, total, total - dead - deadCol, dead, deadCol, sdt,
        counts.networkDevices, ifTotal, ifTotal - ifDown - 4, ifDown, crit, err, warn,
        h === 0 ? counts.alertsAcked : randInt(mRng, 6, 12), COLLECTORS.length, mins < COLLECTOR_DOWN_MIN ? 1 : 0,
        CHECKS.length, mins < 30 ? 1 : 0, mins < 60 ? 5 : randInt(mRng, 0, 1));
    }
    counts.metrics = 720;
  })();

  // Platform flag (unifi.js pattern).
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES ('platform_logicmonitor_enabled', '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run();

  // -- WP1 passes: baselines, topology links, issue history ----------------------------
  // Round 9 latency watch scenarios: bend three locations' history before the baselines are computed.
  counts.watchHistory = require('./logicmonitorWatchDemo').seedWatchHistory(db, { sourceId, nowMs, checks: CHECKS });

  const checksMod = optionalModule('../../services/logicmonitorChecks');
  if (checksMod && checksMod.computeBaselines) {
    counts.baselines = checksMod.computeBaselines(db, sourceId, 7, 24, nowMs);
    wp1.checks = true;
  } else counts.baselines = 0;

  const pollerMod = optionalModule('../../services/logicmonitorPoller');
  if (pollerMod && pollerMod.buildTopologyLinks) {
    pollerMod.buildTopologyLinks(db, sourceId, { neighbors: demoNeighbors });
    wp1.poller = true;
  }
  // LLDP neighbours for 10 core/distribution links, added beside whatever the
  // description parser produced (different protocol, so nothing is replaced).
  db.transaction(() => {
    const ins = db.prepare(`
      INSERT OR IGNORE INTO lm_topology_links (source_id, src_device_id, src_instance_id, src_port, dst_device_id, dst_name,
        dst_port, protocol, confidence, first_seen, last_seen, stale)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'lldp', 'high', datetime('now', '-30 days'), datetime('now', '-6 hours'), 0)
    `);
    const lldp = links.filter((l) => (/-dist-0\d$/.test(l.src) && l.srcPort === 'Te1/0/47') || (/-core-01$/.test(l.src) && l.srcPort === 'Te1/0/45'));
    for (const l of lldp.slice(0, 10)) {
      const f = ifByKey.get(`${l.src}|${l.srcPort}`);
      const dst = byName.get(l.dst);
      ins.run(sourceId, f.device.id, f.instanceId, f.full, dst.id, `${dst.name}.acme.local`, l.dstPort.replace(/^Te/, 'TenGigabitEthernet'));
    }
  })();
  counts.topologyLinks = db.prepare('SELECT COUNT(*) c FROM lm_topology_links WHERE source_id = ?').get(sourceId).c;

  // -- Round 3: rows that do not depend on WP-S1 code ----------------------------------
  counts.round3 = seedRound3Data(db, { sourceId, nowMs, alerts, dc2 });

  // -- Round 3: WP-S1 passes, each skipped with a log line when absent -----------------
  wp1.s1 = runS1Passes(db, sourceId, counts, nowMs);
  counts.circuitEvents = seedCircuitEvents(db, { sourceId, nowMs });
  counts.blameHistory = seedBlameHistory(db, { sourceId, byName });
  counts.linkBurst = seedLinkBurst(db, { sourceId, nowMs });
  // Round 9: replay the latency watch engine over the scenario locations and compute the drift reference.
  try {
    counts.watch = require('./logicmonitorWatchDemo').seedWatchRows(db, { sourceId, nowMs, checks: CHECKS });
  } catch (err) { console.warn(`[seedDemo] logicmonitor latency watch scenarios skipped: ${err.message}`); }
  // Agent signals: six checks elevated from den-col01 at once (after the watch rows, which clear the episode table).
  try {
    counts.locationLatency = seedLocationLatency(db, { sourceId, nowMs, checks: CHECKS });
  } catch (err) { console.warn(`[seedDemo] logicmonitor location latency scenario skipped: ${err.message}`); }
  // Round 9 WP7: IP SLA metric baselines and the IP SLA watch replay (after the check episodes, which clear the table).
  try {
    counts.ipslaWatch = require('./logicmonitorIpslaCloudDemo').seedIpslaWatch(db, { sourceId, nowMs });
  } catch (err) { console.warn(`[seedDemo] logicmonitor ip sla watch scenarios skipped: ${err.message}`); }

  // Round 11 WP-R: raw DataSource store derived from the catalog metric rows.
  try {
    counts.rawValues = require('./logicmonitorRawDemo').seedRawValues(db, { sourceId });
  } catch (err) { console.warn(`[seedDemo] logicmonitor raw values skipped: ${err.message}`); }

  // Long-term history: device state per day (after the alerts, whose open counts land on the last row).
  try {
    counts.deviceDaily = seedDeviceDaily(db, { sourceId, devices, nowMs });
  } catch (err) { console.warn(`[seedDemo] logicmonitor device daily history skipped: ${err.message}`); }

  const issuesMod = optionalModule('../../services/logicmonitorIssues');
  if (issuesMod && issuesMod.reconcileIssueHistory) {
    issuesMod.reconcileIssueHistory();
    wp1.issues = true;
    counts.issueBackdated = backdateIssueHistory(db, nowMs);
  }
  counts.openIssueTypes = db.prepare("SELECT DISTINCT type FROM lm_issue_history WHERE status = 'open' ORDER BY type").all().map((r) => r.type);

  return { sources: 2, ...counts, wp1 };
}

// -- Agent signals: link burst and probe-location latency -------------------------
// Link burst: ports 7 and 8 on dal-acc-01, -02 and -03 went down 18 minutes ago (up at 33 and 48
// minutes ago, down at 18 and 3), so lm_interface_history holds six 1 -> 2 transitions on three
// devices inside the 30 minute window and lm_interfaces shows them down now. Reseed-safe: the
// newest history rows of those instances are replaced.
function seedLinkBurst(db, { sourceId, nowMs }) {
  const find = db.prepare(`
    SELECT i.instance_id AS id FROM lm_interfaces i JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
    WHERE i.source_id = ? AND d.display_name = ? AND i.display_name = ?
  `);
  const del = db.prepare("DELETE FROM lm_interface_history WHERE source_id = ? AND instance_id = ? AND captured_at >= datetime('now', '-55 minutes')");
  const ins = db.prepare(`
    INSERT INTO lm_interface_history (source_id, instance_id, captured_at, status, in_mbps, out_mbps, in_errors, out_errors, in_discards, out_discards, in_util_pct, out_util_pct)
    VALUES (?, ?, datetime('now', ?), ?, ?, ?, 0, 0, 0, 0, ?, ?)
  `);
  const down = db.prepare("UPDATE lm_interfaces SET status = 2, status_text = 'down', in_mbps = 0, out_mbps = 0, in_util_pct = 0, out_util_pct = 0 WHERE source_id = ? AND instance_id = ?");
  let n = 0;
  db.transaction(() => {
    for (const dev of ['dal-acc-01', 'dal-acc-02', 'dal-acc-03']) {
      for (const port of [7, 8]) {
        const r = find.get(sourceId, dev, `GigabitEthernet1/0/${port}`);
        if (!r) continue;
        del.run(sourceId, r.id);
        ins.run(sourceId, r.id, '-48 minutes', 1, 4, 3, 4, 3);
        ins.run(sourceId, r.id, '-33 minutes', 1, 4, 3, 4, 3);
        ins.run(sourceId, r.id, '-18 minutes', 2, 0, 0, 0, 0);
        ins.run(sourceId, r.id, '-3 minutes', 2, 0, 0, 0, 0);
        down.run(sourceId, r.id);
        n += 1;
      }
    }
  })();
  return n;
}

// Probe location: six ping checks are elevated from den-col01 now. PHX core, DAL core and PHX DC
// firewall are already 2.6x for the last hour (degradeDen in the plan); PHX ERP VIP, DAL DC firewall
// and PHX DNS anycast are bent to 1.7x for the last 41 minutes here, then the real episode engine is
// replayed over all six so the states come from code (location-latency fires at 3 elevated checks).
function seedLocationLatency(db, { sourceId, nowMs, checks }) {
  const watch = require('../../services/logicmonitorWatch');
  const t = require('../../services/logicmonitorIssues').getThresholds();
  const source = db.prepare('SELECT * FROM lm_sources WHERE id = ?').get(sourceId);
  const nowS = Math.floor(nowMs / 1000);
  const subjects = [];
  for (const [name, bend] of [['PHX core reachability', 0], ['DAL core reachability', 0], ['PHX DC firewall', 0],
    ['PHX ERP VIP', 1.7], ['DAL DC firewall', 1.7], ['PHX DNS anycast', 1.7]]) {
    const c = checks.find((x) => x.name === name);
    const l = c && c.locations.find((x) => x.key === 'den');
    if (l) subjects.push({ checkId: c.checkId, checkpointId: l.cpId, bend });
  }
  const scale = db.prepare(`
    UPDATE lm_check_history SET rtt_avg_ms = round(rtt_avg_ms * ?, 2), rtt_min_ms = round(rtt_min_ms * ?, 2), rtt_max_ms = round(rtt_max_ms * ?, 2)
    WHERE source_id = ? AND check_id = ? AND checkpoint_id = ? AND sample_epoch >= ? AND sample_epoch <= ? AND rtt_avg_ms IS NOT NULL
  `);
  const last = db.prepare('SELECT rtt_avg_ms FROM lm_check_history WHERE source_id = ? AND check_id = ? AND checkpoint_id = ? AND sample_epoch IS NOT NULL ORDER BY sample_epoch DESC LIMIT 1');
  const setLast = db.prepare('UPDATE lm_check_locations SET last_rtt_ms = ? WHERE source_id = ? AND check_id = ? AND checkpoint_id = ?');
  db.transaction(() => {
    for (const s of subjects) {
      if (!s.bend) continue;
      scale.run(s.bend, s.bend, s.bend, sourceId, s.checkId, s.checkpointId, nowS - 41 * 60, nowS);
      const row = last.get(sourceId, s.checkId, s.checkpointId);
      if (row) setLast.run(row.rtt_avg_ms, sourceId, s.checkId, s.checkpointId);
    }
  })();
  let opened = 0;
  for (const s of subjects) {
    for (let e = nowS - 3600; e <= nowS; e += 300) {
      opened += watch.evaluateWatch(db, source, t, e, { only: { checkId: s.checkId, checkpointId: s.checkpointId } }).opened;
    }
  }
  return { subjects: subjects.length, opened };
}

// -- Round 13: circuit event log ------------------------------------------------
// One lm_circuit_events row per status transition of a circuit port, read back from the
// lm_interface_history rows written above (same walk, same captured_at stamps as
// logicmonitorCircuits.recordCircuitTransitions, so that code adds nothing on a rerun). The Zayo
// site link (both ends) also gets a flap-start at the third change inside 24 hours; the saturated
// phx circuit gets a saturated event at the start of today's hot window; the first abq down event
// carries an operator note.
function seedCircuitEvents(db, { sourceId, nowMs }) {
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lm_circuit_events'").get()) return 0;
    const sqlStamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
    const siteOf = db.prepare('SELECT site_key AS k FROM lm_devices WHERE source_id = ? AND display_name = ?');
    const siteKeyOf = (name) => { const r = siteOf.get(sourceId, name); return r ? r.k : null; };
    const instOf = db.prepare(`
      SELECT i.instance_id AS id, i.display_name AS port FROM lm_interfaces i JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
      WHERE i.source_id = ? AND d.display_name = ? AND i.display_name = ?
    `);
    const hist = db.prepare('SELECT status, captured_at FROM lm_interface_history WHERE source_id = ? AND instance_id = ? AND status IS NOT NULL ORDER BY captured_at, id');
    db.prepare('DELETE FROM lm_circuit_events WHERE source_id = ?').run(sourceId);
    const ins = db.prepare(`
      INSERT INTO lm_circuit_events (source_id, instance_id, device_name, port, site_key, far_site_key, role, event, at, details_json, note, noted_by, noted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const dayMs = 86400000;
    const parseTs = (t) => Date.parse(`${t.replace(' ', 'T')}Z`);
    let noted = false;
    let n = 0;
    db.transaction(() => {
      for (const [key, m] of Object.entries(R13_CIRCUITS)) {
        const [dev, short] = key.split('|');
        const port = ({ 'Gi': 'GigabitEthernet', 'Te': 'TenGigabitEthernet' })[short.slice(0, 2)] + short.slice(2);
        const inst = instOf.get(sourceId, dev, port);
        if (!inst) continue;
        const site = siteKeyOf(dev);
        const far = m.far ? siteKeyOf(m.far) : null;
        const put = (event, at, details, note) => {
          ins.run(sourceId, inst.id, dev, port, site, far, m.role, event, at, details ? JSON.stringify(details) : null,
            note ? note : null, note ? 'netops' : null, note ? sqlStamp(parseTs(at) + 2 * 3600000) : null);
          n += 1;
        };
        const rows = hist.all(sourceId, inst.id);
        const changes = [];
        let prev = null;
        for (const h of rows) {
          const was = prev ? Number(prev.status) : null;
          const now = Number(h.status);
          if ((was === 1 && now === 2) || (was === 2 && now === 1)) {
            const event = now === 1 ? 'up' : 'down';
            const note = !noted && key === 'abq-rtr-01|Te0/1/0' && event === 'down'
              ? 'Carrier ticket CHG0041877 opened with AT&T, field tech dispatched, ETA tomorrow morning.' : null;
            if (note) noted = true;
            put(event, h.captured_at, { from: prev.status, to: h.status }, note);
            changes.push(parseTs(h.captured_at));
          }
          prev = h;
        }
        if (R13_FLAP_KEYS.has(key)) {
          // Flap episode: opens at the change that makes three inside 24 hours, closes after 24 hours
          // with no change (same rule as the recorder); the last episode is still open.
          let active = false;
          changes.forEach((t, i) => {
            if (active && t - changes[i - 1] > dayMs) { put('flap-stop', sqlStamp(changes[i - 1] + dayMs), { changes24h: 0 }); active = false; }
            const inWindow = changes.filter((c) => c <= t && c >= t - dayMs).length;
            if (!active && inWindow >= 3) { put('flap-start', sqlStamp(t + 1000), { changes24h: inWindow, threshold: 3 }); active = true; }
          });
        }
        if (key === 'phx-wan-rtr-01|Gi0/0/0') {
          const d = new Date(nowMs);
          d.setUTCHours(SAT_HOUR_FROM, 0, 0, 0);
          const at = d.getTime() > nowMs ? d.getTime() - dayMs : d.getTime();
          put('saturated', sqlStamp(at), { state: 'critical' });
        }
      }
    })();
    return n;
  } catch (err) {
    console.warn(`[seedDemo] logicmonitor circuit events skipped: ${err.message}`);
    return 0;
  }
}

const WEBHOOK_TOKEN = 'demo-webhook-token';
const NYC_EXTRA_JOBS = [
  { job: 'NYC_SQL_Log_Backup', startMin: 5, durMin: 70, bytes: 120e9 },
  { job: 'NYC_FileServer_Nightly', startMin: 20, durMin: 85, bytes: 95e9 },
  { job: 'NYC_Exchange_DB_Backup', startMin: 35, durMin: 60, bytes: 60e9 },
  { job: 'NYC_Archive_Sweep', startMin: 50, durMin: 45, bytes: 35e9 },
];

// -- Round 8: DataSource metrics (lm_ds_*) --------------------------------------
// Firewalls (the five Palo Alto devices plus the Cisco ASAs), the four F5s,
// Cisco device health, core and distribution optics, BGP and OSPF. Everything
// is deterministic (rngFor 'logicmonitor-r8') and reseed-safe: the rows of
// this source (and any orphans from an earlier seed) are deleted first.
// Scenarios: phx-fw-02 HA peer non-functional, dal-fw-01 3 of 24 tunnels down,
// phx-fw-01 sessions at 87%, den-fw-01 config unsynced, dal-f5-01 pool
// app-payments all down and web-portal 1 of 6 down, dal-f5-02 and phx-f5-02
// standby, a certificate 12 days from expiry on phx-f5-01, dal-dist-02 PSU
// failed, a BGP peer down on dal-wan-rtr-02, CPU 91% on phx-core-01.

// Round 10 WP-B: the Cohesity demo clusters (generators/cohesity.js buildClusterList) LogicMonitor monitors.
const COHESITY_LM_CLUSTERS = ['nyc-coh-prd-01', 'lon-coh-prd-01'];
const R8_STEPS = 336; // 7 days at 30 minutes
const R8_STEP_S = 1800;

const R8_FIREWALLS = {
  'phx-fw-01': { max: 1000000, cores: 8, ha: { local: 1, peer: 2 }, tunnels: 12, down: 0, util: 87, gp: [148, 1000], bgp: 2 },
  'phx-fw-02': { max: 1000000, cores: 8, ha: { local: 2, peer: 5 }, tunnels: 12, down: 0, util: 6, bgp: 2 },
  'dal-fw-01': { max: 500000, cores: 6, ha: { local: 1, peer: 2 }, tunnels: 24, down: 3, util: 41, gp: [62, 500], bgp: 2 },
  'dal-fw-02': { max: 500000, cores: 6, ha: { local: 2, peer: 1 }, tunnels: 24, down: 0, util: 5, bgp: 2 },
  'den-fw-01': { max: 200000, cores: 2, ha: null, tunnels: 6, down: 0, util: 12, unsynced: true },
};
const R8_PARTNERS = ['Appian', 'Zayo_DAL', 'Equinix_FR', 'AWS_use1', 'AWS_usw2', 'Azure_east', 'Fiserv', 'Broadridge', 'Workday', 'Okta',
  'Splunk_HEC', 'SWIFT', 'Cognizant', 'Infosys', 'ADP', 'Experian', 'Fidelity', 'StateStreet', 'Bloomberg', 'Refinitiv', 'DTCC', 'Moodys',
  'FactSet', 'MSCI'];
const R8_POOLS = [
  ['web-portal', 6, 443], ['app-payments', 3, 8443], ['api-gateway', 5, 443], ['sso-auth', 3, 443], ['sftp-ingest', 2, 22],
  ['reporting', 4, 8080], ['batch-api', 4, 8081], ['legacy-erp', 5, 7001],
];
const R8_WIDEIPS = ['portal', 'pay', 'api', 'sso', 'sftp', 'reports', 'batch', 'erp', 'mobile', 'partners'];
const R8_DAEMONS = ['f5_big3d_service_status', 'f5_mcpd_service_status', 'f5_tmm_service_status', 'f5_tmrouted_service_status', 'f5_gtmd_service_status', 'f5_gtm_gslb_status'];
const R8_CERTS = ['portal', 'pay', 'api', 'sso', 'sftp', 'reports', 'erp', 'partners'];

// ---- Round 9: Cisco wireless controllers -------------------------------------------
const WL_SSIDS = [['1', 'ACME-Corp', 0.46], ['2', 'ACME-Guest', 0.2], ['3', 'ACME-IoT', 0.12], ['4', 'ACME-Voice', 0.08], ['5', 'ACME-Lab', 0.06], ['6', 'ACME-Secure', 0.08]];
const WL_CFG = {
  'phx-wlc-01': { prefix: 'phx-wap', aps: 40, clients: 1860, usage: 62, avail: 96, aireos: true, cpu: 31, mem: 54, temp: 38,
    disassoc: [5, 17], downloading: [33], disabled: [38], radioDown: [[11, 1]], hot: [7, 23, 31, 36], errAp: 14, radiusBad: 1 },
  'dal-wlc-01': { prefix: 'dal-wap', aps: 40, clients: 1430, usage: 84, avail: 48, aireos: false, cpu: 44, mem: 61, temp: 41,
    disassoc: [9, 28], downloading: [], disabled: [39], radioDown: [[3, 0], [20, 1]], hot: [12, 25, 30], errAp: 22, radiusBad: -1 },
};

function seedWireless(devices, { put, rng, r1, series }) {
  const pad = (n) => String(n).padStart(2, '0');
  const whole = (arr) => arr.map((v) => Math.round(v));
  for (const d of devices.filter((x) => x.kind === 'wlc' && x.hostStatus === 'normal')) {
    const cfg = WL_CFG[d.name];
    if (!cfg) continue;
    for (let a = 1; a <= cfg.aps; a += 1) {
      const ap = `${cfg.prefix}-${pad(a)}`;
      const disabled = cfg.disabled.includes(a);
      const dis = cfg.disassoc.includes(a);
      const dl = cfg.downloading.includes(a);
      const oper = dis ? 2 : dl ? 3 : 1;
      put(d, 'Cisco_Wireless_AP', 'Cisco Wireless AP', 'wireless', ap, { ap_admin: disabled ? 2 : 1, ap_oper: oper });
      const slots = a % 13 === 0 ? [0, 1, 2] : [0, 1];
      for (const slot of slots) {
        const rdDown = cfg.radioDown.some(([ra, rs]) => ra === a && rs === slot);
        const hot = slot === 1 && cfg.hot.includes(a);
        const rdDisabled = disabled && slot === 0;
        const util = hot ? 72 + rng() * 13 : 5 + rng() * 58;
        const down = dis || rdDown;
        const clients = down || rdDisabled ? 0 : Math.round(rng() * (slot === 0 ? 14 : 22));
        const profile = (k) => (hot && k === 'load' ? 2 : rng() < 0.04 ? 2 : 1);
        const m = {
          radio_admin: rdDisabled ? 2 : 1,
          radio_oper: down || rdDisabled ? 1 : 2,
          radio_clients: clients,
          radio_users: clients,
          radio_tx_power: slot === 0 ? 3 : 2,
          radio_load_profile: profile('load'),
          radio_noise_profile: profile('noise'),
          radio_interference_profile: profile('interference'),
          radio_coverage_profile: profile('coverage'),
        };
        if (!down && !rdDisabled) {
          m.radio_util_pct = r1(util);
          m.radio_rx_util_pct = r1(util * 0.55);
          m.radio_tx_util_pct = r1(util * 0.3);
        }
        put(d, 'Cisco_Wireless_AccessPointRadio', 'Cisco Wireless AP Radio', 'wireless', `${ap}:${slot}`, m);
      }
      const bad = a === cfg.errAp;
      put(d, 'Cisco_Wireless_AccessPointInterfaces', 'Cisco Wireless AP Interfaces', 'wireless', `${ap} - GigabitEthernet0`, {
        apif_oper: dis ? 2 : 1,
        apif_admin: 1,
        apif_in_errors: bad ? r1(3.2 + rng() * 2) : r1(rng() * 0.3),
        apif_out_errors: bad ? r1(0.4 + rng()) : 0,
        apif_in_drops: r1(rng() * 0.4),
        apif_out_drops: r1(rng() * 0.2),
        apif_rx_bytes: dis ? 0 : Math.round(4e4 + rng() * 6e5),
        apif_tx_bytes: dis ? 0 : Math.round(8e4 + rng() * 1.2e6),
      });
    }

    let essTotal = 0;
    for (const [wlan, ssid, share] of WL_SSIDS) {
      const clients = Math.round(cfg.clients * share * (0.9 + rng() * 0.2));
      essTotal += clients;
      put(d, 'Cisco_Wireless_ESS', 'Cisco Wireless ESS', 'wireless', wlan, {
        ess_admin: 1, ess_broadcast: ssid === 'ACME-Secure' ? 0 : 1, ess_clients: clients,
      }, { ess_clients: whole(series(clients || 1, { amp: 0.45, jitter: 0.06, hi: 1e6 })) }, ssid);
    }

    put(d, 'Cisco_Wireless_GlobalPerformance', 'Cisco Wireless Global Performance', 'wireless', 'global', {
      cpu_pct: cfg.cpu, mem_pct: cfg.mem, temp_c: cfg.temp,
    }, {
      cpu_pct: series(cfg.cpu, { amp: 0.25 }),
      mem_pct: series(cfg.mem, { amp: 0.04, jitter: 0.01 }),
      temp_c: series(cfg.temp, { amp: 0.05, jitter: 0.01, hi: 90 }),
    });
    const maxClients = Math.round((essTotal * 100) / cfg.usage);
    put(d, 'Cisco_Wireless_ConnectionStatistics', 'Cisco Wireless Connection Statistics', 'wireless', 'global', {
      wlc_clients: essTotal, wlc_clients_max: maxClients, wlc_client_usage_pct: cfg.usage, wlc_aps_joined: cfg.aps - cfg.disassoc.length,
      wlc_ap_assoc_failed: r1(rng() * 0.6), wlc_abnormal_offline: r1(rng() * 0.05),
    }, {
      wlc_clients: whole(series(essTotal, { amp: 0.45, jitter: 0.05, hi: 1e6 })),
      wlc_client_usage_pct: series(cfg.usage, { amp: 0.2, jitter: 0.02 }),
    });
    put(d, 'Cisco_Wireless_DHCPStatistics', 'Cisco Wireless DHCP Statistics', 'wireless', 'dhcp', {
      dhcp_proxy: 1, dhcp_discover: r1(2 + rng() * 6), dhcp_offer: r1(2 + rng() * 6), dhcp_ack: r1(2 + rng() * 6), dhcp_nak: r1(rng() * 0.1), dhcp_tx_failures: 0,
    });
    put(d, 'Cisco_Wireless_MobilityStats', 'Cisco Wireless Mobility Stats', 'wireless', 'mobility', {
      mob_handoffs: r1(1 + rng() * 4), mob_handoff_requests: r1(1 + rng() * 4), mob_handoff_errors: r1(rng() * 0.05),
      mob_handoff_denied: 0, mob_handoff_dropped: r1(rng() * 0.05),
    });
    for (let sv = 1; sv <= 2; sv += 1) {
      const bad = cfg.radiusBad === sv - 1;
      const name = `10.${d.name.startsWith('phx') ? 10 : 20}.5.${sv}`;
      put(d, 'Cisco_Wireless_RADIUSAuthServers', 'Cisco Wireless RADIUS Auth Servers', 'wireless', String(sv), {
        radius_status: 1, radius_network_user: 1,
        radius_requests: bad ? r1(1.5 + rng()) : r1(8 + rng() * 10),
        radius_accepts: bad ? 0 : r1(7 + rng() * 9),
        radius_rejects: bad ? 0 : r1(rng() * 0.8),
        radius_challenges: 0,
        radius_timeouts: bad ? r1(1.4 + rng()) : 0,
        radius_retransmissions: bad ? r1(2 + rng() * 2) : r1(rng() * 0.2),
        radius_pending: bad ? Math.round(6 + rng() * 4) : Math.round(rng() * 2),
      }, null, name);
      put(d, 'Cisco_Wireless_RADIUSAccountingServers', 'Cisco Wireless RADIUS Accounting Servers', 'wireless', String(sv), {
        acct_status: 1, acct_requests: r1(6 + rng() * 8), acct_responses: r1(6 + rng() * 8), acct_timeouts: 0,
      }, null, name);
    }
    if (cfg.aireos) put(d, 'Cisco_Wireless_HighAvailability', 'Cisco Wireless High Availability', 'wireless', 'ha', { wlc_primary_unit: 1 });
    else put(d, 'Cisco_C9800_HA_Peer_State', 'Cisco C9800 HA Peer State', 'wireless', 'ha', { wlc_ha_peer_ok: 1 });
    put(d, 'ntm_wlc_ap_status_check', 'WLC AP Status Check', 'wireless', 'ap-status', { wlc_ap_available_pct: cfg.avail });
    put(d, 'ntm_wlc_mobility_domain_check', 'WLC Mobility Domain Check', 'wireless', 'mobility-domain', { wlc_mobility_status: 0 });
  }
}

// ---- Round 10 WP-B: Cohesity clusters through LogicMonitor ----------------------------
// Own PRNG and own series helper so no other round 8 or 9 stream moves. The datapoint
// enums are UNVERIFIED: 1 reads healthy and 0 reads down, matching logicmonitorCohesity.js.
// nyc: 71% full, two services down on node 2. lon: 86% full (warning), node 3 down,
// PSU 2 of node 2 faulted. Nodes are the "<cluster>-node-N" hostnames of cohesity_nodes.
const COH_SERVICES = ['bridge', 'apollo', 'athena', 'atom', 'bifrost', 'alerts', 'iris', 'magneto', 'stats', 'gandalf',
  'keychain', 'sentinel', 'vault', 'yoda', 'nexus', 'scribe', 'groot', 'eagle_agent', 'pushclient', 'janus',
  'icebox', 'hercules', 'heimdall', 'proxy_server', 'rpcgateway', 'tricorder', 'storage_proxy', 'patch_manager',
  'smb_proxy', 'nfs_proxy', 'etl_server', 'cluster_manager', 'node_exporter', 'flexlm', 'kerberos', 'ntp',
  'ldap_proxy', 'rigel', 'nimbus', 'cassini', 'opcenter', 'curator', 'ganesha', 'tiering', 'compass'];
const COH_JOBS = ['VM_Prod_Backup', 'SQL_Daily', 'NAS_Archive', 'Exchange_DB', 'Oracle_Weekly', 'Physical_Servers',
  'Gold-15min', 'Silver-1h', 'Bronze-24h', 'Endpoint_Config', 'O365_Mail', 'K8s_Clusters'];

function seedCohesityViaLm(devices, { put }) {
  const rng = rngFor('logicmonitor-cohesity-r10');
  const r1 = (v) => Math.round(v * 10) / 10;
  const steps = R8_STEPS;
  // Gentle daily wave ending exactly at cur.
  const wave = (cur, amp, lo = 0, hi = 100) => {
    const out = [];
    for (let i = 0; i < steps; i += 1) out.push(r1(Math.min(hi, Math.max(lo, cur * (1 + amp * Math.sin((i / 48) * 2 * Math.PI) + 0.01 * (rng() - 0.5))))));
    out[steps - 1] = cur;
    return out;
  };
  // Capacity climbs about 0.05 points a day.
  const creep = (cur) => Array.from({ length: steps }, (_, i) => r1(cur - ((steps - 1 - i) / 48) * 0.05));
  const CFG = {
    [COHESITY_LM_CLUSTERS[0]]: { usedPct: 71, totalTb: 400, downNode: 0, downServices: [[2, 'apollo'], [2, 'magneto']], psuFault: null },
    [COHESITY_LM_CLUSTERS[1]]: { usedPct: 86, totalTb: 250, downNode: 3, downServices: [], psuFault: [2, 2] },
  };
  const TB = 1024 ** 4;
  for (const d of devices.filter((x) => x.kind === 'cohesity' && x.hostStatus === 'normal')) {
    const cfg = CFG[d.name];
    if (!cfg) continue;
    const total = cfg.totalTb * TB;
    const used = Math.round(total * (cfg.usedPct / 100));
    put(d, 'Cohesity_DataPlatform_ClusterStatus', 'Cohesity Cluster Status', 'cohesity', 'cluster', { cluster_health: 1, cluster_nodes: 4 });
    put(d, 'Cohesity_DataPlatform_BasicStorage', 'Cohesity Basic Storage', 'cohesity', 'storage', {
      cap_used_pct: cfg.usedPct, cap_used_bytes: used, cap_total_bytes: total, cap_avail_bytes: total - used, dedupe_ratio: d.name === COHESITY_LM_CLUSTERS[0] ? 3.4 : 2.9,
    }, { cap_used_pct: creep(cfg.usedPct) });
    for (let n = 1; n <= 4; n += 1) {
      const node = `${d.name}-node-${n}`;
      const down = cfg.downNode === n;
      const cpu = r1(18 + rng() * 22);
      put(d, 'Cohesity_DataPlatform_NodeStatus', 'Cohesity Node Status', 'cohesity', node, {
        node_status: down ? 0 : 1, node_cpu_pct: down ? null : cpu, node_mem_pct: down ? null : r1(48 + rng() * 20),
        node_uptime: down ? 0 : Math.round(86400 * (20 + rng() * 120)),
      }, down ? null : { node_cpu_pct: wave(cpu, 0.2) });
      for (let f = 1; f <= 3; f += 1) put(d, 'Cohesity_DataPlatform_Fans', 'Cohesity Fans', 'cohesity', `${node} Fan ${f}`, { fan_state: 1, fan_rpm: Math.round(5400 + rng() * 600) });
      for (let ps = 1; ps <= 2; ps += 1) {
        const bad = cfg.psuFault && cfg.psuFault[0] === n && cfg.psuFault[1] === ps;
        put(d, 'Cohesity_DataPlatform_PowerSupplies', 'Cohesity Power Supplies', 'cohesity', `${node} PSU ${ps}`, { psu_state: bad ? 0 : 1 });
      }
      for (const svc of COH_SERVICES) {
        const bad = cfg.downServices.some(([nn, name]) => nn === n && name === svc);
        put(d, 'ntm_cohesity_node_services', 'Cohesity Node Services', 'cohesity', `${node}-${svc}`, { service_state: bad || down ? 0 : 1 });
      }
    }
    COH_JOBS.forEach((job, ji) => put(d, 'Cohesity_DataPlatform_ProtectionJobs', 'Cohesity Protection Jobs', 'cohesity', job, {
      job_status: ji === 1 && d.name === COHESITY_LM_CLUSTERS[1] ? 2 : 1, job_last_run: Math.round(3600 * (2 + rng() * 20)),
    }));
    put(d, 'ntm_cohesity_alerts', 'Cohesity Alerts', 'cohesity', 'alerts', { alert_count: d.name === COHESITY_LM_CLUSTERS[0] ? 2 : 1 });
    put(d, 'Cohesity_DataPlatform_Troubleshooter', 'Cohesity Troubleshooter', 'cohesity', 'troubleshooter', { trouble_state: 1 });
  }
}

function seedDsMetrics(db, { sid, devices, ifaces, nowMs }) {
  const out = { instances: 0, metrics: 0, history: 0, devices: 0 };
  if (!hasTable(db, 'lm_ds_instances') || !hasTable(db, 'lm_ds_metrics') || !hasTable(db, 'lm_ds_metrics_history')) return out;
  for (const t of ['lm_ds_metrics_history', 'lm_ds_metrics', 'lm_ds_instances', ...(hasTable(db, 'lm_ds_metric_baseline') ? ['lm_ds_metric_baseline'] : []), ...(hasTable(db, 'lm_ds_daily') ? ['lm_ds_daily'] : [])]) {
    db.prepare(`DELETE FROM ${t} WHERE source_id = ? OR source_id NOT IN (SELECT id FROM lm_sources)`).run(sid);
  }
  const rng = rngFor('logicmonitor-r8');
  const latest = Math.floor(nowMs / 1000) - 240;
  const r1 = (v) => Math.round(v * 10) / 10;
  const noise = () => rng() + rng() - 1;

  const ddsFind = db.prepare('SELECT hds_id FROM lm_device_datasources WHERE source_id = ? AND lm_device_id = ? AND datasource_name = ?');
  const ddsIns = db.prepare(`
    INSERT INTO lm_device_datasources (source_id, lm_device_id, hds_id, datasource_id, datasource_name, datasource_display_name,
      instance_count, monitoring_instance_count, alert_status, sdt_status, stop_monitoring, is_interface, is_neighbor, refreshed_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 1, 'none', ?, 0, 0, 0, datetime('now', '-6 hours'))
  `);
  const ddsUpd = db.prepare(`
    UPDATE lm_device_datasources SET instance_count = ?, monitoring_instance_count = ?, metrics_last_at = datetime('now', '-4 minutes')
    WHERE source_id = ? AND lm_device_id = ? AND hds_id = ?
  `);
  const insInst = db.prepare(`
    INSERT OR REPLACE INTO lm_ds_instances (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, instance_name, stale, first_seen, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now', '-7 days'), datetime('now', '-4 minutes'))
  `);
  const insMet = db.prepare(`
    INSERT OR REPLACE INTO lm_ds_metrics (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, metric, datapoint, value, sampled_at_epoch, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-4 minutes'))
  `);
  const insHist = db.prepare(`
    INSERT INTO lm_ds_metrics_history (source_id, lm_device_id, hds_id, instance_key, metric, value, sampled_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const hdsMap = new Map();
  const instN = new Map();
  let nextHds = 60000;
  let nextDsId = 8000;
  const hdsFor = (dev, ds, display) => {
    const k = `${dev.id}|${ds}`;
    if (hdsMap.has(k)) return hdsMap.get(k);
    const hit = ddsFind.get(sid, dev.id, ds);
    let hds;
    if (hit) hds = hit.hds_id;
    else {
      hds = nextHds;
      nextHds += 1;
      nextDsId += 1;
      ddsIns.run(sid, dev.id, hds, nextDsId, ds, display || ds, dev.inSdt ? 'none-SDT-none' : 'none-none-none');
    }
    hdsMap.set(k, hds);
    return hds;
  };

  const dailyItems = []; // every seeded numeric metric, rolled into lm_ds_daily at the end (history round)
  /** One instance with its latest metric values; hist maps metric -> 336 values (oldest first). */
  function put(dev, ds, display, family, key, metrics, hist = null, name = null) {
    const hds = hdsFor(dev, ds, display);
    insInst.run(sid, dev.id, hds, ds, family, key, name || key);
    out.instances += 1;
    for (const [metric, value] of Object.entries(metrics)) {
      if (value == null) continue;
      if (typeof value === 'number' && Number.isFinite(value)) {
        dailyItems.push({ dev, hds, ds, key, metric, value, varies: !!(hist && hist[metric]) });
      }
      insMet.run(sid, dev.id, hds, ds, family, key, metric, metric, value, latest);
      out.metrics += 1;
    }
    if (hist) {
      for (const [metric, vals] of Object.entries(hist)) {
        for (let i = 0; i < vals.length; i += 1) {
          insHist.run(sid, dev.id, hds, key, metric, vals[i], latest - (vals.length - 1 - i) * R8_STEP_S);
          out.history += 1;
        }
      }
    }
    const ik = `${dev.id}|${hds}`;
    instN.set(ik, { dev, hds, n: (instN.has(ik) ? instN.get(ik).n : 0) + 1 });
  }

  // Diurnal series (9:00 peak) ending exactly at cur; lo/hi clamp.
  const diurnal = (i) => {
    const h = (((latest - (R8_STEPS - 1 - i) * R8_STEP_S) / 3600) % 24 + 24) % 24;
    return Math.sin(((h - 3) / 24) * 2 * Math.PI);
  };
  const series = (cur, { amp = 0.2, jitter = 0.03, lo = 0, hi = 100, ramp = null } = {}) => {
    const raw = [];
    for (let i = 0; i < R8_STEPS; i += 1) {
      let v = 1 + amp * diurnal(i) + jitter * noise();
      if (ramp) v *= ramp(i);
      raw.push(v);
    }
    const last = raw[R8_STEPS - 1] || 1;
    return raw.map((v, i) => (i === R8_STEPS - 1 ? cur : Math.min(hi, Math.max(lo, r1((cur * v) / last)))));
  };
  // Last 6 hours (12 steps) climb from `from` x cur to cur.
  const climb = (from) => (i) => (i >= R8_STEPS - 12 ? from + (1 - from) * ((i - (R8_STEPS - 12)) / 11) : 1);
  // Monotonic counter ending at cur, growing roughly `per` each step.
  const counter = (cur, per) => {
    const vals = new Array(R8_STEPS);
    let v = cur;
    for (let i = R8_STEPS - 1; i >= 0; i -= 1) {
      vals[i] = Math.max(0, Math.round(v));
      v -= per * (0.8 + 0.4 * rng());
    }
    return vals;
  };

  // ---- Cisco device health (every healthy Cisco network device) -----------------
  const CPU_RANGE = { core: [14, 28], dist: [10, 22], access: [4, 14], 'branch-access': [5, 16], 'wan-rtr': [18, 36], 'branch-rtr': [12, 30], asa: [20, 40] };
  for (const d of devices.filter((x) => x.vendor === 'Cisco' && x.isNetwork && x.kind !== 'wlc' && x.hostStatus === 'normal')) {
    const [lo, hi] = CPU_RANGE[d.kind] || [8, 24];
    const hot = d.name === 'phx-core-01';
    const cpu = hot ? 91 : r1(lo + rng() * (hi - lo));
    const mem = r1(30 + rng() * 35);
    put(d, 'Cisco_CPU_SNMP', 'Cisco CPU', 'health', '1', { cpu_pct: cpu },
      { cpu_pct: series(cpu, { amp: 0.25, ramp: hot ? climb(0.45) : null }) }, 'CPU 1');
    put(d, 'Cisco_MemoryPools_SNMP', 'Cisco Memory Pools', 'health', 'Processor', { mem_pct: mem }, { mem_pct: series(mem, { amp: 0.04, jitter: 0.01 }) });
    if (d.role === 'switch' || d.role === 'router') {
      put(d, 'Cisco_FRU_Power', 'Cisco FRU Power', 'health', 'PS1', { psu_state: 1 }, null, 'Power Supply 1');
      put(d, 'Cisco_FRU_Power', 'Cisco FRU Power', 'health', 'PS2', { psu_state: d.name === 'dal-dist-02' ? 3 : 1 }, null, 'Power Supply 2');
    }
    const fans = d.kind === 'core' ? 4 : d.kind === 'dist' ? 3 : 2;
    for (let f = 1; f <= fans; f += 1) put(d, 'CiscoFan-', 'Cisco Fans', 'health', `Fan${f}`, { fan_state: 1 }, null, `Fan ${f}`);
    put(d, 'Cisco_TemperatureSensors', 'Cisco Temperature Sensors', 'health', 'Inlet', { temp_c: r1(24 + rng() * 10), temp_state: 1 }, null, 'Inlet temperature');
  }

  // ---- Optics on core and distribution uplinks ------------------------------------
  for (const f of ifaces.filter((x) => x.cls === 'uplink' && ['core', 'dist'].includes(x.device.kind) && x.device.hostStatus === 'normal')) {
    put(f.device, 'Cisco_Transceiver_Sensors', 'Cisco Transceiver Sensors', 'optics', f.full, {
      rx_power_dbm: r1(-2 - rng() * 5), tx_power_dbm: r1(-1 - rng() * 3), temp_c: r1(30 + rng() * 10), current_ma: r1(6 + rng() * 3),
      voltage_v: 3.3, rx_low_warn: -11.9, rx_low_alarm: -14.4, tx_low_warn: -8,
    }, null, f.short);
  }

  // ---- Routing: BGP on WAN routers, OSPF on routers -----------------------------------
  for (const d of devices.filter((x) => ['wan-rtr', 'branch-rtr'].includes(x.kind) && x.hostStatus === 'normal')) {
    if (d.kind === 'wan-rtr') {
      const base = d.name.startsWith('dal') ? 20 : 10;
      for (let p = 1; p <= 2; p += 1) {
        const down = d.name === 'dal-wan-rtr-02' && p === 2;
        put(d, 'BGP-', 'BGP', 'routing', `203.0.113.${base + (d.name.endsWith('02') ? 2 : 0) + p}`, {
          bgp_peer_state: down ? 3 : 6, bgp_established_s: down ? 0 : 86400 * (10 + p * 7), bgp_prefixes_in: down ? 0 : 1000 + p * 4200,
        }, null, `AS6453 peer ${p}`);
      }
    }
    for (let n = 1; n <= (d.kind === 'wan-rtr' ? 2 : 1); n += 1) put(d, 'OSPF_Neighbors', 'OSPF Neighbors', 'routing', `10.255.${d.id % 200}.${n}`, { ospf_nbr_state: 8 });
  }

  // ---- Firewalls --------------------------------------------------------------------------
  for (const d of devices.filter((x) => x.vendor === 'Cisco' && x.kind === 'asa' && x.hostStatus === 'normal')) {
    put(d, 'CiscoASA', 'Global PIX/ASA Stats', 'firewall', 'global', { asa_connections: Math.round(20000 + rng() * 30000), asa_cpu_pct: r1(15 + rng() * 25), asa_mem_pct: r1(35 + rng() * 25) });
    put(d, 'Cisco_ASA_Failover', 'Cisco ASA Failover', 'firewall', 'failover', { asa_failover_state: 1 });
  }
  for (const d of devices.filter((x) => x.kind === 'paloalto')) {
    const cfg = R8_FIREWALLS[d.name];
    const active = !cfg.ha || cfg.ha.local === 1;
    const sessions = Math.round((cfg.max * cfg.util) / 100);
    const util = cfg.util;
    const tcp = Math.round(sessions * 0.74);
    const udp = Math.round(sessions * 0.22);
    put(d, 'PaloAlto_FW_GlobalSessions', 'PAN global sessions', 'firewall', 'global', {
      sessions_active: sessions, sessions_max: cfg.max, sessions_util_pct: util, sessions_tcp: tcp, sessions_udp: udp, sessions_icmp: sessions - tcp - udp,
    }, {
      sessions_active: series(sessions, { amp: 0.18, lo: 0, hi: cfg.max, ramp: d.name === 'phx-fw-01' ? climb(0.65) : null }).map((v) => Math.round(v)),
      sessions_util_pct: series(util, { amp: 0.18, ramp: d.name === 'phx-fw-01' ? climb(0.65) : null }),
    });
    put(d, 'PaloAlto_FW_GlobalPerformance', 'PAN global performance', 'firewall', 'global', {
      pkt_rate: Math.round(sessions / 3), throughput_kbps: Math.round(sessions * 4.5), session_rate: Math.round(sessions / 400),
    }, { throughput_kbps: series(Math.round(sessions * 4.5), { amp: 0.3, hi: 1e9 }).map((v) => Math.round(v)) });
    const mgmt = active ? r1(14 + rng() * 18) : r1(4 + rng() * 5);
    put(d, 'PaloAlto_FW_SystemResources', 'PAN system resources', 'firewall', 'system', { mgmt_cpu_pct: mgmt, mem_pct: r1(42 + rng() * 20), swap_pct: r1(1 + rng() * 4) },
      { mgmt_cpu_pct: series(mgmt, { amp: 0.2 }) });
    for (let c = 0; c < cfg.cores; c += 1) {
      put(d, 'PaloAlto_FW_DataplaneCores', 'PAN dataplane cores', 'firewall', `core${c}`, { core_cpu_pct: active ? r1(10 + cfg.util / 3 + rng() * 14) : r1(1 + rng() * 4) }, null, `Core ${c}`);
    }
    put(d, 'PaloAlto_FW_DroppedPackets', 'PAN dropped packets', 'firewall', 'global', { dropped: 1200000 + Math.round(rng() * 400000) },
      { dropped: counter(1400000, 600) });
    if (cfg.ha) {
      put(d, 'PaloAlto_FW_HA_Status', 'PAN HA status', 'firewall', 'ha', { ha_enabled: 1, ha_local_state: cfg.ha.local, ha_peer_state: cfg.ha.peer, ha_mode: 1 }, null, 'HA');
      put(d, 'PaloAlto_FW_HA_Interface', 'PAN HA interfaces', 'firewall', 'HA1', { ha_if_state: 1 });
      put(d, 'PaloAlto_FW_HA_Interface', 'PAN HA interfaces', 'firewall', 'HA2', { ha_if_state: 1 });
    } else {
      put(d, 'PaloAlto_FW_HA_Status', 'PAN HA status', 'firewall', 'ha', { ha_enabled: 0 }, null, 'HA');
    }
    // Tunnels: the first `down` ones are down; passive units report them all up.
    put(d, 'PaloAlto_FW_IPSecTunnelOverview', 'PAN IPSec overview', 'firewall', 'overview', {
      tunnels_up: cfg.tunnels - cfg.down, tunnels_down: cfg.down, tunnels_total: cfg.tunnels,
    });
    for (let t = 0; t < cfg.tunnels; t += 1) {
      const partner = R8_PARTNERS[(t + d.id) % R8_PARTNERS.length];
      const isDown = t < cfg.down;
      put(d, 'PaloAlto_FW_IPSecTunnelStats', 'PAN IPSec tunnels', 'firewall', `${partner}_IPsec_Tunnel_PROD:proxy${t + 1}`, {
        tunnel_state: isDown ? 0 : 1, tunnel_in_bps: isDown ? 0 : Math.round(1e5 + rng() * 4e7), tunnel_out_bps: isDown ? 0 : Math.round(1e5 + rng() * 3e7),
      });
    }
    if (cfg.gp) {
      put(d, 'PaloAlto_GlobalProtect_Gateway', 'PAN GlobalProtect gateway', 'firewall', 'gw-external', {
        gp_users_active: cfg.gp[0], gp_users_max: cfg.gp[1], gp_tunnels: cfg.gp[0] + Math.round(rng() * 6),
      }, null, 'GP external gateway');
    }
    put(d, 'PaloAlto_FW_Config_Synced', 'PAN config sync', 'firewall', 'config', { config_synced: cfg.unsynced ? 0 : 1, config_pending: cfg.unsynced ? 1 : 0 });
    put(d, 'PaloAlto_FW_ThreatAnalysis', 'PAN threat analysis', 'firewall', 'threats', {
      threats_total: 412000, threats_critical: 180, threats_high: 2100, threats_medium: 19000, threats_low: 88000, threats_informational: 302720,
    }, { threats_total: counter(412000, 150 + Math.round(cfg.max / 10000)) });
    for (const [zone, share] of [['trust', 0.5], ['untrust', 0.3], ['dmz', 0.15], ['guest', 0.05]]) {
      put(d, 'PaloAlto_FW_Zones', 'PAN zones', 'firewall', zone, {
        zone_in_bps: Math.round(sessions * 3000 * share), zone_out_bps: Math.round(sessions * 2200 * share), zone_sessions: Math.round(sessions * share),
      });
    }
    put(d, 'PaloAlto_FW_vSys', 'PAN virtual systems', 'firewall', 'vsys1', { vsys_sessions: sessions, vsys_util_pct: util });
    for (const lt of ['traffic', 'threat', 'url']) {
      put(d, 'PaloAlto_FW_LogForwarding', 'PAN log forwarding', 'firewall', lt, { log_forwarded: Math.round(1e6 + rng() * 5e6), log_dropped: Math.round(rng() * 40) });
    }
    for (const [disk, base] of [['/', 34], ['/opt/pancfg', 12], ['/opt/panrepo', 58]]) {
      put(d, 'PaloAlto_FW_Disk', 'PAN disks', 'firewall', disk, { disk_used_pct: r1(base + rng() * 4) });
    }
    for (const psu of ['PSU 1', 'PSU 2']) put(d, 'PaloAlto_FW_Power', 'PAN power supplies', 'firewall', psu, { psu_state: 1 });
    put(d, 'PaloAlto_FW_ChassisPower', 'PAN chassis power', 'firewall', 'chassis', { chassis_watts: Math.round(380 + rng() * 120) });
    for (const sensor of ['Ambient', 'Dataplane']) {
      put(d, 'PaloAlto_FW_Temperature', 'PAN temperature', 'firewall', sensor, { temp_c: r1(sensor === 'Ambient' ? 27 + rng() * 5 : 41 + rng() * 8), temp_alarm: 0 });
    }
    for (let p = 1; p <= (cfg.bgp || 0); p += 1) {
      put(d, 'PaloAlto_FW_BGP', 'PAN BGP', 'firewall', `10.250.${d.id % 200}.${p}`, { bgp_peer_state: 6, bgp_prefixes: 800 + p * 900 }, null, `peer ${p}`);
    }
    if (cfg.bgp) put(d, 'PaloAlto_FW_OSPF', 'PAN OSPF', 'firewall', `10.251.${d.id % 200}.1`, { ospf_nbr_state: 8 });
  }

  // ---- Load balancers ---------------------------------------------------------------------
  const f5Active = { 'phx-f5-01': true, 'dal-f5-01': true };
  for (const d of devices.filter((x) => x.kind === 'f5' && x.hostStatus === 'normal')) {
    const active = !!f5Active[d.name];
    const siteOctet = d.name.startsWith('dal') ? 20 : 10;
    const cpu = active ? r1(18 + rng() * 14) : r1(4 + rng() * 5);
    const mem = d.name === 'phx-f5-01' ? 88 : d.name === 'dal-f5-01' ? 87 : r1(52 + rng() * 14);
    const client = active ? Math.round(18000 + rng() * 9000) : 0;
    const server = active ? Math.round(client * 0.92) : 0;
    put(d, 'F5_BigIP_System', 'F5 BIG-IP System', 'loadbalancer', 'system', {
      cpu_pct: cpu, mem_pct: mem, client_connections: client, server_connections: server, throughput_bps: active ? Math.round(2.4e9 + rng() * 9e8) : 1.2e6,
    }, {
      cpu_pct: series(cpu, { amp: 0.3 }),
      mem_pct: series(mem, { amp: 0.04, jitter: 0.01 }),
      client_connections: series(client || 1, { amp: 0.35, hi: 1e9 }).map((v) => (active ? Math.round(v) : 0)),
      server_connections: series(server || 1, { amp: 0.35, hi: 1e9 }).map((v) => (active ? Math.round(v) : 0)),
    });
    put(d, 'F5_BigIP_FailoverStatus', 'F5 BIG-IP Failover Status', 'loadbalancer', 'failover', { failover_state: active ? 4 : 3, sync_state: 3 });
    // Pools: 8 pools, 32 members. dal-f5-01 carries the two failures.
    R8_POOLS.forEach(([pool, members, port], pi) => {
      for (let m = 1; m <= members; m += 1) {
        let avail = 1;
        if (d.name === 'dal-f5-01' && pool === 'app-payments') avail = 3;
        if (d.name === 'dal-f5-01' && pool === 'web-portal' && m === 4) avail = 3;
        put(d, 'F5_BigIP_PoolMemberStats', 'F5 BIG-IP Pool Member Stats', 'loadbalancer', `${pool}/10.${siteOctet}.${60 + pi}.${10 + m}:${port}`, {
          member_avail: avail, member_enabled: 1, member_connections: avail === 3 || !active ? 0 : Math.round(80 + rng() * 900),
          member_bits_in: avail === 3 || !active ? 0 : Math.round(2e6 + rng() * 4e7), member_bits_out: avail === 3 || !active ? 0 : Math.round(3e6 + rng() * 6e7),
        });
      }
    });
    R8_WIDEIPS.forEach((w) => put(d, 'F5_GTM_WideIP-', 'F5 GTM Wide IPs', 'loadbalancer', `${w}.acme-example.com`, { wideip_avail: 1, wideip_requests: Math.round(rng() * 90000) }));
    for (let v = 1; v <= 12; v += 1) put(d, 'F5_GTM_VIPs-', 'F5 GTM VIPs', 'loadbalancer', `gtm-vip-${pad2(v)}`, { vip_avail: 1, vip_enabled: 1 });
    ['phx-gtm', 'dal-gtm'].forEach((s) => put(d, 'F5_GTM_Servers-', 'F5 GTM Servers', 'loadbalancer', s, { gtm_server_avail: 1 }));
    ['phoenix-dc', 'dallas-dc'].forEach((s) => put(d, 'F5_GTM_Datacenters-', 'F5 GTM Datacenters', 'loadbalancer', s, { dc_avail: 1 }));
    put(d, 'F5_GTM_Global', 'F5 GTM Global', 'loadbalancer', 'global', { gtm_requests: Math.round(1e6 + rng() * 2e6), gtm_resolutions: Math.round(9e5 + rng() * 2e6) });
    R8_DAEMONS.forEach((ds) => put(d, ds, ds, 'loadbalancer', ds.replace(/_service_status$/, '').replace(/^f5_/, ''), { daemon_state: 1 }));
    R8_CERTS.forEach((c, ci) => {
      const days = d.name === 'phx-f5-01' && c === 'pay' ? 12 : 90 + ci * 63 + Math.round(rng() * 20);
      put(d, 'F5_BigIP_SSL_VIP_Certs', 'F5 BIG-IP SSL VIP Certificates', 'loadbalancer', `${c}.acme-example.com`, { cert_days_left: days });
    });
    put(d, 'F5_BigIP_Memory', 'F5 BIG-IP Memory', 'loadbalancer', 'memory', { tmm_mem_pct: r1(38 + rng() * 12), host_mem_pct: mem });
    put(d, 'F5_BigIP_Filesystem', 'F5 BIG-IP Filesystem', 'loadbalancer', '/var', { fs_used_pct: r1(41 + rng() * 6) });
    ['1.1', '1.2', '1.3', '1.4'].forEach((p) => put(d, 'F5_BigIP_Interfaces', 'F5 BIG-IP Interfaces', 'loadbalancer', p, {
      if_status: 1, if_in_bps: active ? Math.round(2e8 + rng() * 8e8) : 5e4, if_out_bps: active ? Math.round(2e8 + rng() * 8e8) : 5e4,
    }));
    for (let f = 1; f <= 3; f += 1) put(d, 'F5_BigIP_Fans', 'F5 BIG-IP Fans', 'loadbalancer', `fan${f}`, { fan_state: 1 });
    ['psu1', 'psu2'].forEach((p) => put(d, 'F5_BigIP_Power', 'F5 BIG-IP Power Supplies', 'loadbalancer', p, { psu_state: 1 }));
    put(d, 'F5_BigIP_Temperature', 'F5 BIG-IP Temperature', 'loadbalancer', 'chassis', { temp_c: r1(30 + rng() * 6) });
  }

  seedWireless(devices, { put, rng, r1, series });
  // Round 9 WP7: IP SLA probes and cloud circuits (generators/logicmonitorIpslaCloudDemo.js).
  require('./logicmonitorIpslaCloudDemo').seedIpslaCloud(devices, { put, rng, r1, series });
  // Round 10 WP-B: Cohesity through LogicMonitor (own PRNG, defined next to the wireless seed above).
  seedCohesityViaLm(devices, { put });
  // Round 11 WP-S: Linux and Windows guests with OS family rows (generators/logicmonitorServersDemo.js).
  require('./logicmonitorServersDemo').seedServersViaLm(devices, { put, rng, r1, series });
  // Round 11 WP-X: SQL Server, Splunk, EMC Unity and IronPort rows (generators/logicmonitorAppsDemo.js).
  require('./logicmonitorAppsDemo').seedAppsViaLm(devices, { put, rng, r1, series });
  // Round 11 WP-V: voice, Zscaler and ISE rows (generators/logicmonitorServicesDemo.js; own PRNG).
  require('./logicmonitorServicesDemo').seedServicesViaLm(devices, { put, r1, series, steps: R8_STEPS, stepSec: R8_STEP_S });

  // Keep the datasource inventory counts in step with what was collected.
  for (const { dev, hds, n } of instN.values()) ddsUpd.run(n, n, sid, dev.id, hds);
  out.devices = new Set([...instN.values()].map((x) => x.dev.id)).size;
  out.dailyRows = seedDsDaily(db, { sid, items: dailyItems, nowMs });
  return out;
}

// ---- Long-term history (lm_ds_daily, lm_device_daily) -------------------------------
// 90 days per seeded metric: a smooth curve around the current value (min and max within 15 percent,
// 48 samples a day), flat for state values. Two metrics tell a story: phx-fw-01 management CPU
// climbs from 35 to 80 percent over the last 14 days; phx-core-01 CPU climbs from 40 to its 91.
const HIST_DAYS = 90;
const DAILY_RAMPS = { 'phx-fw-01|mgmt_cpu_pct': [35, 80], 'phx-core-01|cpu_pct': [40, null] };

function seedDsDaily(db, { sid, items, nowMs }) {
  if (!hasTable(db, 'lm_ds_daily')) return 0;
  const ins = db.prepare(`
    INSERT OR REPLACE INTO lm_ds_daily (source_id, lm_device_id, hds_id, datasource_name, instance_key, metric, kind, day,
      samples, min_value, sum_value, max_value, last_value, last_epoch)
    VALUES (?, ?, ?, ?, ?, ?, 'catalog', ?, ?, ?, ?, ?, ?, ?)
  `);
  const rnd = rngFor('logicmonitor-ds-daily');
  const r2 = (v) => Math.round(v * 100) / 100;
  let n = 0;
  db.transaction(() => {
    for (const it of items) {
      const isPct = /pct$/.test(it.metric);
      const ramp = DAILY_RAMPS[`${it.dev.name}|${it.metric}`];
      const phase = rnd() * 6.28;
      for (let k = HIST_DAYS - 1; k >= 0; k -= 1) {
        const ms = nowMs - k * 86400000;
        const day = new Date(ms).toISOString().slice(0, 10);
        let avg = it.value;
        let lo = it.value;
        let hi = it.value;
        if (it.varies) {
          avg = it.value * (1 + 0.06 * Math.sin(k * 0.9 + phase) + 0.02 * (rnd() - 0.5));
          if (ramp && k < 14) {
            const to = ramp[1] == null ? it.value : ramp[1];
            avg = ramp[0] + (to - ramp[0]) * ((13 - k) / 13);
          }
          if (isPct) avg = Math.min(99, Math.max(0, avg));
          lo = avg * (1 - 0.15 * (0.4 + 0.6 * rnd()));
          hi = avg * (1 + 0.15 * (0.4 + 0.6 * rnd()));
          if (isPct) hi = Math.min(100, hi);
        }
        const samples = k === 0 ? 20 : 48;
        const epoch = Math.floor(ms / 1000);
        ins.run(sid, it.dev.id, it.hds, it.ds, it.key, it.metric, day, samples, r2(lo), r2(avg * samples), r2(hi), r2(k === 0 ? it.value : avg), epoch);
        n += 1;
      }
    }
  })();
  return n;
}

/** Device state and alert-count history, 90 days per seeded device. dal-core-02 is the story device. */
function seedDeviceDaily(db, { sourceId, devices, nowMs }) {
  if (!hasTable(db, 'lm_device_daily')) return 0;
  db.prepare('DELETE FROM lm_device_daily WHERE source_id = ?').run(sourceId);
  const ids = new Map(db.prepare('SELECT display_name, name, lm_device_id FROM lm_devices WHERE source_id = ?').all(sourceId)
    .map((r) => [r.display_name || r.name, r.lm_device_id]));
  const open = new Map();
  for (const r of db.prepare(`
    SELECT lm_device_id, COUNT(*) opened, SUM(CASE WHEN severity_norm = 'critical' THEN 1 ELSE 0 END) critical,
      SUM(CASE WHEN severity_norm = 'warning' THEN 1 ELSE 0 END) warning
    FROM lm_alerts WHERE source_id = ? AND cleared = 0 AND duplicate_of IS NULL AND lm_device_id IS NOT NULL GROUP BY lm_device_id
  `).all(sourceId)) open.set(r.lm_device_id, r);
  const ins = db.prepare(`
    INSERT OR REPLACE INTO lm_device_daily (source_id, lm_device_id, day, samples, dead_samples, dead_collector_samples, sdt_samples,
      worst_host_status, alerts_opened, alerts_critical, alerts_warning)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const rnd = rngFor('logicmonitor-device-daily');
  let n = 0;
  db.transaction(() => {
    for (const d of devices) {
      const id = ids.get(d.name);
      if (id == null) continue;
      for (let k = HIST_DAYS - 1; k >= 0; k -= 1) {
        const day = new Date(nowMs - k * 86400000).toISOString().slice(0, 10);
        const samples = k === 0 ? 120 : 288;
        let dead = 0;
        let deadC = 0;
        let sdt = 0;
        if (d.name === 'dal-core-02') {
          if (k === 20) dead = 100; else if (k === 19) dead = 288; else if (k === 3) dead = 190;
          if (k === 8 || k === 7) sdt = 96;
        }
        if (k === 0) {
          if (d.hostStatus === 'dead') dead = Math.min(samples, Math.max(1, Math.round((DEAD_MIN[d.name] || 60) / 5)));
          if (d.hostStatus === 'dead-collector') deadC = samples;
          if (d.inSdt) sdt = samples;
        }
        let opened = Math.floor(rnd() * 3.4);
        let crit = opened ? Math.floor(rnd() * (opened + 0.99)) : 0;
        let warn = opened - crit;
        if (k === 0 && open.has(id)) {
          const o = open.get(id);
          crit = Math.max(crit, o.critical || 0);
          warn = Math.max(warn, o.warning || 0);
          opened = Math.max(opened, o.opened, crit + warn);
        }
        if (dead && opened === 0) { opened = 1; crit = 1; }
        const worst = dead ? 'dead' : deadC ? 'dead-collector' : 'normal';
        ins.run(sourceId, id, day, samples, dead, deadC, sdt, worst, opened, crit, warn);
        n += 1;
      }
    }
  })();
  return n;
}

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}
function colsOf(db, table) {
  try { return new Set(db.prepare(`PRAGMA table_info('${table}')`).all().map((r) => r.name)); } catch { return new Set(); }
}

// Backup overlay runs, webhook source and events, config ledger rows. Every write
// to a round 3 column or table is guarded so the seed completes before v3 lands.
function seedRound3Data(db, { sourceId, nowMs, alerts, dc2 }) {
  const out = {
    backupRuns: 0, backupObjects: 0, nycExtraRuns: 0, webhookEvents: 0, webhookAlerts: 0, configChanges: 0,
    vmkernelRows: 0, zertoAlerts: 0, zertoVpgs: 0, replicationRuns: 0,
  };

  // Backup windows: two VMs per DC host, one run on the hot night (last night)
  // and one on a quiet night (three nights ago), all 01:00 to 03:00 UTC.
  if (hasTable(db, 'protection_runs') && hasTable(db, 'cohesity_objects') && hasTable(db, 'clusters')) {
    const objCols = colsOf(db, 'cohesity_objects');
    const insRun = db.prepare(`
      INSERT INTO protection_runs (cluster_id, job_id, job_name, run_type, status, start_time, end_time, error_code, error_message, logical_bytes, captured_at)
      VALUES (?, ?, ?, 'kRegular', 'kSuccess', ?, ?, NULL, NULL, ?, ?)
    `);
    const hasMs = objCols.has('last_backup_ms');
    const insObj = db.prepare(`
      INSERT INTO cohesity_objects (cluster_id, object_id, global_id, name, source_name, environment, object_type, os_type,
        logical_bytes, is_protected, protection_groups, policy_names, last_backup_status, sla_violated, ${hasMs ? 'last_backup_ms, ' : ''}captured_at)
      VALUES (?, ?, ?, ?, ?, 'VMware', 'VirtualMachine', 'Linux', ?, 1, ?, ?, 'Succeeded', 0, ${hasMs ? '?, ' : ''}?)
    `);
    let objectId = 80000;
    let jobId = 8800;
    // Reseed-safe: this generator owns job ids 8801.. and object ids 80001.. on every cluster.
    if (hasTable(db, 'replication_runs')) {
      try { db.prepare('DELETE FROM replication_runs WHERE protection_run_id IN (SELECT id FROM protection_runs WHERE job_id BETWEEN 8801 AND 8999)').run(); } catch { /* column set differs */ }
    }
    db.prepare('DELETE FROM protection_runs WHERE job_id BETWEEN 8801 AND 8999').run();
    db.prepare('DELETE FROM cohesity_objects WHERE object_id BETWEEN 80001 AND 80999').run();
    for (const site of ['nyc', 'lon']) {
      const host = dc2.hosts[site] && dc2.hosts[site][0];
      if (!host) continue;
      let vms = [];
      try { vms = db.prepare('SELECT name FROM vcenter_vms WHERE host_name = ? AND power_state = ? ORDER BY name LIMIT 2').all(host, 'POWERED_ON'); } catch { vms = []; }
      const cluster = db.prepare("SELECT id, name FROM clusters WHERE name LIKE ? || '-coh-prd-%' ORDER BY name LIMIT 1").get(site)
        || db.prepare('SELECT id, name FROM clusters ORDER BY name LIMIT 1').get();
      if (!cluster) continue;
      // A job name only these objects hold, so the run-to-host join resolves to exactly them.
      const job = `VM_Nightly_Backup_${site.toUpperCase()}`;
      vms.forEach((vm, i) => {
        const w = backupWindow(nowMs, i === 0 ? 1 : 3);
        jobId += 1;
        objectId += 1;
        const endMs = w.end - 17 * 60000;
        const bytes = 180e9 + i * 40e9;
        insRun.run(cluster.id, jobId, job, new Date(w.start).toISOString(), new Date(endMs).toISOString(), bytes, new Date(nowMs).toISOString());
        const groups = [job];
        // Round 4: four more jobs protect the first nyc VM inside the same hot window, so
        // the host shows one merged window of five runs with distinct logical bytes.
        if (site === 'nyc' && i === 0) {
          for (const x of NYC_EXTRA_JOBS) {
            jobId += 1;
            insRun.run(cluster.id, jobId, x.job, new Date(w.start + x.startMin * 60000).toISOString(),
              new Date(w.start + (x.startMin + x.durMin) * 60000).toISOString(), x.bytes, new Date(nowMs).toISOString());
            groups.push(x.job);
            out.backupRuns += 1;
            out.nycExtraRuns += 1;
          }
        }
        const args = [cluster.id, objectId, `${cluster.id}:demo:${objectId}`, vm.name, `vc-${site}.icc.demo`, bytes,
          JSON.stringify(groups), JSON.stringify([`${site}-vmware-daily`])];
        if (hasMs) args.push(endMs);
        args.push(new Date(nowMs).toISOString());
        insObj.run(...args);
        out.backupRuns += 1;
        out.backupObjects += 1;
      });
    }
  }

  Object.assign(out, applyCrossPlatformRows(db, { nowMs, dc2 }));
  const satDay = new Date(nowMs);
  satDay.setUTCHours(0, 0, 0, 0);
  const satAt = (hour, min) => new Date(satDay.getTime() - 86400000 + hour * 3600000 + min * 60000);
  if (hasTable(db, 'replication_runs') && hasTable(db, 'protection_runs') && hasTable(db, 'clusters')) {
    const clusters = db.prepare('SELECT id, name FROM clusters ORDER BY id').all();
    const src = clusters.find((c) => /^(phx|nyc)/i.test(c.name)) || clusters[0];
    const dst = clusters.find((c) => /^dal/i.test(c.name)) || clusters.find((c) => !src || c.id !== src.id) || src;
    const pr = src && db.prepare('SELECT id FROM protection_runs WHERE cluster_id = ? ORDER BY id LIMIT 1').get(src.id);
    if (pr) {
      db.prepare('DELETE FROM replication_runs WHERE protection_run_id = ? AND lag_seconds = 5400 AND target_cluster_id = ?').run(pr.id, dst.id);
      const insR = db.prepare(`
        INSERT INTO replication_runs (protection_run_id, cluster_id, target_cluster_name, target_cluster_id, status, logical_bytes, start_time, end_time, lag_seconds, captured_at)
        VALUES (?, ?, ?, ?, 'kSuccess', ?, ?, ?, 5400, ?)
      `);
      for (const [h, m, bytes] of [[15, 10, 420e9], [16, 40, 310e9]]) {
        const st = satAt(h, m);
        insR.run(pr.id, src.id, dst.name, dst.id, bytes, st.toISOString(), new Date(st.getTime() + 5400 * 1000).toISOString(), new Date(nowMs).toISOString());
        out.replicationRuns += 1;
      }
    }
  }

  // Webhook source and events.
  if (colsOf(db, 'lm_sources').has('webhook_enabled')) {
    const tokenHash = crypto.createHash('sha256').update(WEBHOOK_TOKEN).digest('hex');
    db.prepare(`
      UPDATE lm_sources SET webhook_token_hash = ?, webhook_enabled = 1, webhook_count = 128,
        webhook_last_at = datetime('now', '-10 minutes'), webhook_last_error = NULL WHERE id = ?
    `).run(tokenHash, sourceId);
    out.webhookTokenHash = tokenHash;
  }
  if (colsOf(db, 'lm_alerts').has('ingest')) {
    db.prepare("UPDATE lm_alerts SET ingest = 'poll' WHERE source_id = ?").run(sourceId);
    const openRows = alerts.filter((a) => !a.cleared);
    // Webhook-delivered: the abq outage (4 host + 4 ports), 2 storm ports, 2 cpu, 1 volume, 1 f5.
    const pickIds = [
      ...openRows.filter((a) => a.template === 'Host Status' && String(a.objectName).startsWith('abq-')).slice(0, 4),
      ...openRows.filter((a) => a.template === 'SNMP_Network_Interfaces' && String(a.objectName).startsWith('abq-acc-')).slice(0, 4),
      ...openRows.filter((a) => a.dataPoint === 'InDiscards').slice(0, 2),
      ...openRows.filter((a) => a.template === 'Cisco_CPU_SNMP').slice(0, 2),
      ...openRows.filter((a) => String(a.template).startsWith('WinVolumeUsage')).slice(0, 1),
      ...openRows.filter((a) => a.template === 'F5_BigIP_System').slice(0, 1),
    ].slice(0, 12);
    const upd = db.prepare("UPDATE lm_alerts SET ingest = 'webhook' WHERE source_id = ? AND lm_alert_id = ?");
    for (const a of pickIds) upd.run(sourceId, a.lmAlertId);
    out.webhookAlerts = pickIds.length;
    if (hasTable(db, 'lm_webhook_events')) {
      const insEv = db.prepare(`
        INSERT INTO lm_webhook_events (source_id, received_at, status, lm_alert_id, internal_id, host, accepted, error, raw_json)
        VALUES (?, datetime('now', ?), ?, ?, ?, ?, ?, ?, ?)
      `);
      for (let i = 0; i < 20; i += 1) {
        const a = pickIds[i % Math.max(1, pickIds.length)];
        let status = i % 5 === 3 ? 'cleared' : 'accepted';
        let accepted = 1;
        let error = null;
        let host = a ? String(a.objectName) : 'abq-dist-01';
        if (i === 7) { status = 'rejected'; accepted = 0; error = 'unknown device'; host = 'lab-switch-77'; }
        if (i === 14) { status = 'rejected'; accepted = 0; error = 'invalid payload: missing alertId'; host = ''; }
        insEv.run(sourceId, `-${12 + i * 17} minutes`, status, a ? a.lmAlertId : null, a ? a.internalId : null, host, accepted, error,
          JSON.stringify({ alertId: a ? a.lmAlertId : null, host, level: a ? (a.severity >= 4 ? 'critical' : 'error') : null, via: 'webhook' }));
        out.webhookEvents += 1;
      }
    }
  }

  // Config ledger rows for the last 24 h (the seed owns every logicmonitor row here).
  if (hasTable(db, 'config_changes')) {
    db.prepare("DELETE FROM config_changes WHERE platform = 'logicmonitor'").run();
    const ins = db.prepare(`
      INSERT INTO config_changes (platform, scope, system, item, change_type, old_value, new_value, detected_at)
      VALUES ('logicmonitor', ?, ?, ?, ?, ?, ?, ?)
    `);
    const at = (minAgo) => new Date(nowMs - minAgo * 60000).toISOString();
    const rows = [
      ['device-inventory', 'abq-dist-01', 'changed', 'version 17.9.3', 'version 17.9.4a', at(95)],
      ['device-inventory', 'phx-wan-rtr-01', 'changed', 'sysinfo Version 17.9.3', 'sysinfo Version 17.9.4a', at(310)],
      ['links', 'abq-dist-01 Te1/0/48', 'added', null, 'abq-rtr-01 Gi0/0/3 (description)', at(95)],
      ['links', 'abq-dist-01 Te1/0/2', 'changed', 'abq-acc-02 Te1/1/1', 'abq-acc-04 Te1/1/1', at(180)],
      ['links', 'phx-wan-rtr-01 Gi0/0/1', 'added', null, 'WAN Zayo circuit 12345 to Dallas', at(720)],
      ['links', 'phx-wan-rtr-01 Gi0/0/0', 'removed', 'to phx-core-02 Te1/0/44', null, at(1300)],
      ['links', 'phx-acc-03 Gi1/0/17', 'changed', 'Users VLAN 20', 'Users VLAN 20 (duplex auto, was full)', at(150)],
    ];
    for (const [scope, item, type, oldV, newV, when] of rows) ins.run(scope, SOURCE_NAME, item, type, oldV, newV, when);
    out.configChanges = rows.length;
  }
  return out;
}

// Cross-platform scenario rows that live in OTHER platforms' tables (vcenter_networks,
// zerto_alerts, zerto_vpgs). On the demo those packs re-seed their tables at every
// boot, which wipes these rows, so server.js calls this again after the packs have
// seeded (same pattern as scenarios/appServiceLinking). Idempotent.
function applyCrossPlatformRows(db, { nowMs = Date.now(), dc2 = null } = {}) {
  const out = { vmkernelRows: 0, zertoAlerts: 0, zertoVpgs: 0 };
  dc2 = dc2 || dc2ServerPorts(db);
  // vmkernel rule: nyc-esx-0101 management traffic leaves through vmnic0 only. The vcenter
  // generator already writes vmk0 (portgroup Management Network on vSwitch0), so only the
  // vSwitch0 uplinks change; missing rows are inserted. vmk0.switch_name holds the portgroup
  // name (the generator's convention) and the portgroup row names vSwitch0.
  if (hasTable(db, 'vcenter_networks') && hasTable(db, 'vcenter_hosts') && dc2.hosts.nyc && dc2.hosts.nyc[0]) {
    const host = dc2.hosts.nyc[0];
    const h = db.prepare('SELECT vcenter_id FROM vcenter_hosts WHERE name = ?').get(host);
    if (h) {
      const nowIso = new Date(nowMs).toISOString();
      const has = (kind, name) => !!db.prepare('SELECT 1 FROM vcenter_networks WHERE vcenter_id = ? AND host_name = ? AND kind = ? AND name = ?').get(h.vcenter_id, host, kind, name);
      const ins = db.prepare(`
        INSERT INTO vcenter_networks (vcenter_id, host_name, kind, name, switch_name, vlan_id, speed_mbps, mac, ip_address, netmask, mtu, uplinks, port_count, extra, captured_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      if (!has('vswitch', 'vSwitch0')) ins.run(h.vcenter_id, host, 'vswitch', 'vSwitch0', null, null, null, null, null, null, 1500, JSON.stringify(['vmnic0']), 128, null, nowIso);
      else db.prepare("UPDATE vcenter_networks SET uplinks = ? WHERE vcenter_id = ? AND host_name = ? AND kind = 'vswitch' AND name = 'vSwitch0'").run(JSON.stringify(['vmnic0']), h.vcenter_id, host);
      if (!has('portgroup', 'Management Network')) ins.run(h.vcenter_id, host, 'portgroup', 'Management Network', 'vSwitch0', 0, null, null, null, null, null, null, null, null, nowIso);
      if (!has('vmkernel', 'vmk0')) ins.run(h.vcenter_id, host, 'vmkernel', 'vmk0', 'Management Network', null, null, null, '10.101.11.5', '255.255.255.0', 1500, null, null, JSON.stringify({ dhcp: false }), nowIso);
      out.vmkernelRows = 1;
    }
  }

  // Replication vs circuits (Zerto half): the phx-wan-rtr-01 Gi0/0/0 circuit runs at 84 to 90 percent from
  // 14:00 to 22:00 UTC every day. Two Zerto RPO alerts and one breached VPG for a Phoenix
  // protected site, and two Cohesity replication runs with 90 minutes of lag, land inside
  // yesterday's window. vms_count is 0 on the new VPG so zerto_vms still sums to the VPG total.
  const satDay = new Date(nowMs);
  satDay.setUTCHours(0, 0, 0, 0);
  const satAt = (hour, min) => new Date(satDay.getTime() - 86400000 + hour * 3600000 + min * 60000);
  if (hasTable(db, 'zerto_alerts')) {
    const insA = db.prepare(`
      INSERT INTO zerto_alerts (alert_identifier, alert_type, severity, description, site_name, entity_type, collection_time, captured_at)
      VALUES (?, ?, ?, ?, ?, 'VPG', ?, ?)
    `);
    const capIso = new Date(nowMs).toISOString();
    db.prepare("DELETE FROM zerto_alerts WHERE alert_identifier IN ('demo-lm-rpo-1', 'demo-lm-rpo-2')").run();
    insA.run('demo-lm-rpo-1', 'VPG0014', 'Error', 'VPG PHX-ERP-DR-VPG RPO of 14 minutes exceeds the configured 5 minutes, replication to Dallas is behind',
      'Phoenix DC ZVM', satAt(15, 20).toISOString(), capIso);
    insA.run('demo-lm-rpo-2', 'VPG0021', 'Warning', 'VPG PHX-ERP-DR-VPG journal history is filling and RPO is drifting, replication throughput is below the change rate',
      'Phoenix DC ZVM', satAt(16, 5).toISOString(), capIso);
    out.zertoAlerts = 2;
  }
  if (hasTable(db, 'zerto_vpgs')) {
    db.prepare(`
      INSERT OR REPLACE INTO zerto_vpgs (vpg_identifier, name, vms_count, protected_site, protected_site_type, recovery_site, recovery_site_type,
        actual_rpo, configured_rpo, health, status, sub_status, actual_journal_history, configured_journal_history, zorg_name, captured_at)
      VALUES ('demo-lm-vpg-phx-1', 'PHX-ERP-DR-VPG', 0, 'Phoenix DC ZVM', 'vCenter', 'Dallas DC ZVM', 'vCenter',
        840, 300, 'Warning', 'NotMeetingSLA', 'NeedsAttention', 22, 24, 'ICC Demo Org', ?)
    `).run(new Date(nowMs).toISOString());
    out.zertoVpgs = 1;
  }
  // Round 9 (WP6) scenario "snapmirror-ports": the sgp to syd SnapMirror relationship is broken
  // off with a 52 hour lag. Two unused ports on phx-dist-04 are tied to sgp-ontap-prd-01-node-1
  // (running at 94 percent for the whole lag window, baseline 18) and syd-ontap-dr-01-node-1
  // (quiet), so the Correlation page shows one saturated and one normal side. Re-applied at
  // every demo boot because the netapp pack re-seeds its tables; the scenario's own link, history
  // and baseline rows are deleted and rewritten each time.
  try {
    if (hasTable(db, 'lm_topology_links') && hasTable(db, 'lm_interfaces') && hasTable(db, 'netapp_nodes')) {
      const sw = db.prepare("SELECT source_id, lm_device_id FROM lm_devices WHERE display_name = 'phx-dist-04'").get();
      const pairs = [['sgp-ontap-prd-01-node-1', 94], ['syd-ontap-dr-01-node-1', 22]];
      if (sw) {
        db.prepare("DELETE FROM lm_topology_links WHERE source_id = ? AND dst_platform = 'netapp' AND dst_ref LIKE '%-ontap-%'").run(sw.source_id);
        const free = db.prepare(`
          SELECT i.instance_id, i.display_name FROM lm_interfaces i
          WHERE i.source_id = ? AND i.lm_device_id = ? AND i.stale = 0
            AND NOT EXISTS (SELECT 1 FROM lm_topology_links l WHERE l.source_id = i.source_id AND l.src_instance_id = i.instance_id)
          ORDER BY i.instance_id DESC LIMIT 2
        `).all(sw.source_id, sw.lm_device_id);
        const insLink = db.prepare(`
          INSERT INTO lm_topology_links (source_id, src_device_id, src_instance_id, src_port, dst_name, dst_port, protocol, confidence, last_seen, dst_platform, dst_ref)
          VALUES (?, ?, ?, ?, ?, 'e01', 'description', 'high', datetime('now'), 'netapp', ?)
        `);
        const insHist = db.prepare(`
          INSERT INTO lm_interface_history (source_id, instance_id, captured_at, status, in_mbps, out_mbps, in_errors, out_errors, in_discards, out_discards, in_util_pct, out_util_pct)
          VALUES (?, ?, datetime('now', ?), 1, ?, ?, 0, 0, 0, 0, ?, ?)
        `);
        const insBase = db.prepare(`
          INSERT OR REPLACE INTO lm_interface_baseline (source_id, instance_id, hour_of_day, samples, util_median, util_mad, err_median, err_mad, computed_at)
          VALUES (?, ?, ?, 40, 18, 3, 0, 0, datetime('now'))
        `);
        free.forEach((f, idx) => {
          const [node, util] = pairs[idx];
          insLink.run(sw.source_id, sw.lm_device_id, f.instance_id, f.display_name, node.replace(/-node-\d+$/, ''), node);
          db.prepare("DELETE FROM lm_interface_history WHERE source_id = ? AND instance_id = ? AND captured_at >= datetime('now', '-8 days')").run(sw.source_id, f.instance_id);
          for (let m = 10; m <= 60 * 60; m += 30) {
            const wobble = ((m * 7) % 5) - 2;
            insHist.run(sw.source_id, f.instance_id, `-${m} minutes`, util * 10, util * 4, Math.min(99, util + wobble), Math.max(1, util / 2 + wobble));
          }
          for (let h = 0; h < 24; h += 1) insBase.run(sw.source_id, f.instance_id, h);
        });
        out.snapmirrorPorts = free.length;
      }
    }
  } catch { /* netapp or LM tables absent on an older schema */ }
  // Round 9 (WP6) scenario "cohesity-target-ports": node 1 of nyc-coh-prd-01 and lon-coh-prd-01
  // sits on the highest free GigabitEthernet1/0/x port of nyc-acc-01 and lon-acc-01 (a port with
  // no other link, so no client shares it). Both ports run hot (86 percent) in the 01:00 to 03:00 UTC backup
  // windows one and three nights ago and idle at 15 otherwise, so backupLoad shows the
  // target side next to the client side. Rewritten on every apply.
  try {
    if (hasTable(db, 'lm_topology_links') && hasTable(db, 'cohesity_nodes')) {
      db.prepare("DELETE FROM lm_topology_links WHERE dst_platform = 'cohesity' AND dst_ref LIKE '%-coh-prd-%'").run();
      const insLink = db.prepare(`
        INSERT INTO lm_topology_links (source_id, src_device_id, src_instance_id, src_port, dst_name, dst_port, protocol, confidence, last_seen, dst_platform, dst_ref)
        VALUES (?, ?, ?, ?, ?, 'eth0', 'lldp', 'high', datetime('now'), 'cohesity', ?)
      `);
      const insHist = db.prepare(`
        INSERT INTO lm_interface_history (source_id, instance_id, captured_at, status, in_mbps, out_mbps, in_errors, out_errors, in_discards, out_discards, in_util_pct, out_util_pct)
        VALUES (?, ?, ?, 1, ?, ?, 0, 0, 0, 0, ?, ?)
      `);
      const insBase = db.prepare(`
        INSERT OR REPLACE INTO lm_interface_baseline (source_id, instance_id, hour_of_day, samples, util_median, util_mad, err_median, err_mad, computed_at)
        VALUES (?, ?, ?, 40, 15, 3, 0, 0, datetime('now'))
      `);
      const sqlStamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
      for (const [dev, node] of [['nyc-acc-01', 'nyc-coh-prd-01-node-1'], ['lon-acc-01', 'lon-coh-prd-01-node-1']]) {
        const row = db.prepare(`
          SELECT i.source_id, i.lm_device_id, i.instance_id, i.display_name FROM lm_interfaces i
          JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
          WHERE d.display_name = ? AND i.stale = 0 AND i.display_name LIKE 'GigabitEthernet1/0/%'
            AND NOT EXISTS (SELECT 1 FROM lm_topology_links l WHERE l.source_id = i.source_id AND l.src_instance_id = i.instance_id)
          ORDER BY i.instance_id DESC LIMIT 1
        `).get(dev);
        if (!row) continue;
        insLink.run(row.source_id, row.lm_device_id, row.instance_id, row.display_name, node.replace(/-node-\d+$/, ''), node);
        db.prepare('DELETE FROM lm_interface_history WHERE source_id = ? AND instance_id = ? AND captured_at >= ?').run(row.source_id, row.instance_id, sqlStamp(nowMs - 6 * 86400000));
        const hot = [backupWindow(nowMs, 1), backupWindow(nowMs, 3)];
        for (let t = nowMs - 4 * 86400000; t <= nowMs; t += 15 * 60000) {
          const util = hot.some((w) => t >= w.start && t < w.end) ? 86 : 15;
          insHist.run(row.source_id, row.instance_id, sqlStamp(t), util * 10, util * 4, util, util / 2);
        }
        for (let h = 0; h < 24; h += 1) insBase.run(row.source_id, row.instance_id, h);
        out.cohesityTargetPorts = (out.cohesityTargetPorts || 0) + 1;
      }
    }
  } catch { /* cohesity_nodes or LM tables absent on an older schema */ }
  // Round 9 (WP6): LM alerts that relay a feed ICC polls itself get tagged after the
  // packs have seeded their tables (the owner check reads those tables). Idempotent.
  try {
    const r = require('../../services/logicmonitorDuplicates').markDuplicateAlerts(db);
    out.duplicateAlerts = r.marked;
  } catch { /* column absent on an older schema */ }
  return out;
}

// Round 4 blame history: 40 rows over 30 days. phx-dist-01 Te1/0/3 is blamed 9 times and
// dal-wan-rtr-01 Gi0/0/0 6 times; five other hops share the other 25. Skipped with a log
// line when lm_blame_history (WP-D1 migration v4) is absent.
function seedBlameHistory(db, { sourceId, byName }) {
  if (!hasTable(db, 'lm_blame_history')) {
    console.warn('[seedDemo] logicmonitor: lm_blame_history not present yet, skipping blame history');
    return { path: 'skipped', rows: 0 };
  }
  db.prepare('DELETE FROM lm_blame_history WHERE source_id = ?').run(sourceId);
  const rng = rngFor('logicmonitor-blame');
  const checks = db.prepare('SELECT check_id, name FROM lm_checks WHERE source_id = ? ORDER BY check_id').all(sourceId);
  const checkByName = new Map(checks.map((c) => [c.name, c.check_id]));
  const checkNames = ['DAL DR replication link', 'PHX ERP VIP', 'PHX VoIP gateway', 'DAL file services'].filter((n) => checkByName.has(n));
  const servers = ['phx-sql-01', 'phx-app-03', 'dal-sql-01', 'dal-web-02', 'phx-file-01'];
  const hops = [
    { dev: 'phx-dist-01', port: 'Te1/0/3', n: 9, state: 'down', reason: 'port down, last seen 3 minutes ago' },
    { dev: 'dal-wan-rtr-01', port: 'Gi0/0/0', n: 6, state: 'degraded', reason: 'utilization 94 percent, circuit saturated' },
    { dev: 'phx-core-01', port: 'Te1/0/45', n: 5, state: 'degraded', reason: 'input errors growing' },
    { dev: 'dal-dist-01', port: 'Te1/0/47', n: 5, state: 'degraded', reason: 'utilization 87 percent' },
    { dev: 'den-rtr-01', port: 'Gi0/0/0', n: 5, state: 'down', reason: 'port down' },
    { dev: 'abq-dist-01', port: 'Te1/0/48', n: 5, state: 'down', reason: 'device dead' },
    { dev: 'slc-rtr-01', port: 'Gi0/0/1', n: 5, state: 'degraded', reason: 'flapping, 4 transitions in 1 hour' },
  ];
  const siteOf = db.prepare('SELECT site_key FROM lm_devices WHERE source_id = ? AND lm_device_id = ?');
  const ins = db.prepare(`
    INSERT INTO lm_blame_history (source_id, at, kind, subject, subject_key, checkpoint_label, hop_device_id, hop_device_name, hop_port, hop_state, hop_reason, site_key, issue_key)
    VALUES (?, datetime('now', ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const plan = [];
  for (const h of hops) for (let i = 0; i < h.n; i += 1) plan.push(h);
  // Deterministic shuffle so the hops interleave across the 30 days.
  for (let i = plan.length - 1; i > 0; i -= 1) {
    const j = randInt(rng, 0, i);
    [plan[i], plan[j]] = [plan[j], plan[i]];
  }
  let rows = 0;
  plan.forEach((h, idx) => {
    const dev = byName.get(h.dev);
    if (!dev) return;
    const site = (siteOf.get(sourceId, dev.id) || {}).site_key || null;
    const minAgo = Math.floor((idx + rng()) * (30 * 1440 - 120) / plan.length) + 60;
    if (checkNames.length > 0 && idx % 2 === 0) {
      const name = checkNames[idx % checkNames.length];
      const id = checkByName.get(name);
      ins.run(sourceId, `-${minAgo} minutes`, 'check', name, id, idx % 4 === 0 ? 'abq-col01' : 'overall', dev.id, h.dev, h.port, h.state, h.reason, site, `check-down:${id}`);
    } else {
      const srv = servers[idx % servers.length];
      ins.run(sourceId, `-${minAgo} minutes`, 'server', srv, srv, null, dev.id, h.dev, h.port, h.state, h.reason, site, null);
    }
    rows += 1;
  });
  return { path: 'inserted', rows };
}

// Demo check targets are not addresses of any demo device, so computeSites
// leaves lm_checks.site_key null. Map the first token of the check name to a
// site by key stem (same UPDATE as computeSites, idempotent).
const CHECK_SITE_STEMS = { PHX: 'phoenix', DAL: 'dallas', DEN: 'denver', SLC: 'saltlake', ABQ: 'albuquerque', TUS: 'tucson', NYC: 'new-york', LON: 'london' };
const CHECK_SITE_BY_NAME = { 'Intranet portal': 'phoenix', 'ERP web': 'phoenix' };

function assignCheckSites(db, sourceId) {
  const sites = db.prepare('SELECT site_key, site_name FROM lm_sites WHERE source_id = ?').all(sourceId);
  const upd = db.prepare('UPDATE lm_checks SET site_key = ?, site_name = ? WHERE source_id = ? AND check_id = ?');
  let n = 0;
  for (const c of db.prepare('SELECT check_id, name FROM lm_checks WHERE source_id = ?').all(sourceId)) {
    const stem = CHECK_SITE_BY_NAME[c.name] || CHECK_SITE_STEMS[String(c.name || '').split(' ')[0].toUpperCase()];
    const site = stem ? sites.find((x) => x.site_key === stem || x.site_key.startsWith(`${stem}-`)) : null;
    if (!site) continue;
    upd.run(site.site_key, site.site_name || site.site_key, sourceId, c.check_id);
    n += 1;
  }
  return n;
}

const sqlStamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

// The reconcile step stamps every open issue first_seen = now. Give the demo
// issues the age their message or source data implies. Idempotent: every run
// recomputes from nowMs for open rows only; last_seen is left alone.
function backdateIssueHistory(db, nowMs) {
  const UNIT = { min: 60000, m: 60000, h: 3600000, d: 86400000 };
  const TWO_H = 2 * 3600000;
  const CHECK_TYPES = new Set(['check-down', 'latency-anomaly', 'packet-loss-anomaly']);
  const sources = new Map(db.prepare('SELECT name, id FROM lm_sources').all().map((r) => [r.name, r.id]));
  const upd = db.prepare('UPDATE lm_issue_history SET first_seen = ? WHERE id = ?');
  const checkStmt = db.prepare('SELECT check_id FROM lm_checks WHERE source_id = ? AND name = ? AND stale = 0 LIMIT 1');
  const cpStmt = db.prepare('SELECT DISTINCT checkpoint_id FROM lm_check_locations WHERE source_id = ? AND check_id = ?');
  const histStmt = db.prepare('SELECT sample_epoch, status FROM lm_check_history WHERE source_id = ? AND check_id = ? AND checkpoint_id = ? AND sample_epoch IS NOT NULL ORDER BY sample_epoch DESC LIMIT 600');
  const colStmt = db.prepare('SELECT last_notification_epoch FROM lm_collectors WHERE source_id = ? AND (hostname = ? OR description = ?) LIMIT 1');
  let changed = 0;
  for (const r of db.prepare("SELECT id, source, type, target, message FROM lm_issue_history WHERE status = 'open'").all()) {
    const sid = sources.get(r.source);
    let at = null;
    const m = /\bfor (\d+)\s*(min|m|h|d)\b/i.exec(r.message || '');
    if (m) at = nowMs - Number(m[1]) * UNIT[m[2].toLowerCase()];
    else if (CHECK_TYPES.has(r.type) && sid != null) {
      const name = String(r.target).split(' @ ')[0];
      const ck = checkStmt.get(sid, name);
      let earliest = null;
      if (ck) {
        for (const cp of cpStmt.all(sid, ck.check_id)) {
          let start = null;
          for (const h of histStmt.all(sid, ck.check_id, cp.checkpoint_id)) {
            if (h.status === 'up') break;
            start = h.sample_epoch;
          }
          if (start != null) earliest = earliest == null ? start : Math.min(earliest, start);
        }
      }
      at = earliest != null ? earliest * 1000 : nowMs - TWO_H;
    } else if (r.type === 'circuit-saturated') {
      const d = new Date(nowMs);
      d.setUTCHours(SAT_HOUR_FROM, 0, 0, 0);
      at = d.getTime() > nowMs ? d.getTime() - 86400000 : d.getTime();
    } else if (r.type === 'collector-down' && sid != null) {
      const c = colStmt.get(sid, r.target, r.target);
      at = c && c.last_notification_epoch ? c.last_notification_epoch * 1000 : nowMs - TWO_H;
    }
    if (at != null && at < nowMs) { upd.run(sqlStamp(at), r.id); changed += 1; }
  }
  return changed;
}

const S1_FUNCTIONS = {
  sites: ['computeSites'],
  tiers: ['computeTiers', 'recomputeTiers'],
  wan: ['markWanInterfaces', 'computeCircuits', 'markWan', 'computeWan', 'recomputeCircuits', 'markCircuits'],
  shadows: ['computeShadows'],
  baselines: ['computeInterfaceBaselines'],
};

// Runs the real WP-S1 passes in dependency order. Each function is looked up by
// name across the LogicMonitor service modules; a missing or failing one is
// logged and skipped so the seed still completes.
function runS1Passes(db, sourceId, counts, nowMs) {
  const mods = ['Sites', 'Path', 'Poller', 'Issues', 'Checks', 'Endpoints']
    .map((n) => optionalModule(`../../services/logicmonitor${n}`)).filter(Boolean);
  const find = (names) => {
    for (const m of mods) for (const n of names) if (typeof m[n] === 'function') return { fn: m[n], name: n };
    return null;
  };
  const ran = {};
  for (const step of ['sites', 'tiers', 'wan', 'shadows', 'baselines']) {
    const hit = find(S1_FUNCTIONS[step]);
    if (!hit) {
      console.warn(`[seedDemo] logicmonitor: no ${S1_FUNCTIONS[step][0]} yet, skipping the ${step} pass`);
      ran[step] = null;
      continue;
    }
    try {
      const result = step === 'shadows' ? hit.fn(db) : step === 'baselines' ? hit.fn(db, sourceId, nowMs) : hit.fn(db, sourceId);
      ran[step] = hit.name;
      if (step === 'sites') assignCheckSites(db, sourceId);
      if (step === 'baselines') counts.interfaceBaselines = typeof result === 'number' ? result : null;
    } catch (err) {
      console.warn(`[seedDemo] logicmonitor: ${hit.name} failed: ${err.message}`);
      ran[step] = `failed: ${err.message}`;
    }
  }
  if (!ran.shadows && colsOf(db, 'lm_alerts').has('shadowed_by')) {
    // Stand-in for computeShadows: the abq outage is the only dependency story seeded.
    const up = db.prepare("SELECT lm_device_id AS id FROM lm_devices WHERE source_id = ? AND display_name = 'abq-dist-01'").get(sourceId);
    if (up) {
      const marked = db.prepare(`
        UPDATE lm_alerts SET shadowed_by = ? WHERE source_id = ? AND cleared = 0
          AND lm_device_id IN (SELECT lm_device_id FROM lm_devices WHERE source_id = ? AND display_name LIKE 'abq-acc-0%' AND host_status = 'dead')
      `).run(JSON.stringify({ deviceId: up.id, deviceName: 'abq-dist-01', port: null, reason: 'device dead' }), sourceId, sourceId);
      ran.shadows = `fallback:${marked.changes}`;
    }
  }
  return ran;
}

// 01:00 to 03:00 UTC on the UTC date daysAgo days before now.
function backupWindow(nowMs, daysAgo) {
  const d = new Date(nowMs);
  d.setUTCHours(1, 0, 0, 0);
  const start = d.getTime() - daysAgo * 86400000;
  return { start, end: start + 2 * 3600000 };
}

function round2(v) {
  return v == null ? null : Math.round(v * 100) / 100;
}

module.exports = { seedLogicmonitor, applyCrossPlatformRows };
