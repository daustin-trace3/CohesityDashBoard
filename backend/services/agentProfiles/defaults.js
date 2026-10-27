// Default Ops Agent platform profiles (product content). One entry per
// platform id. Fields:
//   focus           prose the model sees only when the platform is in the incident (max 600 chars)
//   ports           { source: [...], host: [...] } tcp_port entries { port, label, expect }
//                   expect true = ICC should reach it (a closed result is evidence),
//                   expect false = informational
//   guestPorts      { windows, linux, other } for hypervisor platforms (VM guests by OS family)
//   evidenceBudget  { alerts, failedBackupJobs, networkBlocks } row caps for the evidence
//   relations       ids of the cross-platform templates (see RELATION_TEMPLATES) this platform can emit
// The 161 SNMP port of LogicMonitor devices is UDP and cannot be TCP-probed, so it is not listed.

const p = (port, label, expect) => ({ port, label, expect });

const GUEST_PORTS = {
  windows: [p(3389, 'RDP', true), p(445, 'SMB', false), p(5985, 'WinRM', false)],
  linux: [p(22, 'SSH', true)],
  other: [p(443, 'HTTPS', false)],
};

const guest = () => ({
  windows: GUEST_PORTS.windows.map((x) => ({ ...x })),
  linux: GUEST_PORTS.linux.map((x) => ({ ...x })),
  other: GUEST_PORTS.other.map((x) => ({ ...x })),
});

/** One human sentence per relation template id, shown read-only in the profile editor. */
const RELATION_TEMPLATES = {
  vm_host: 'VM {vm} runs on host {host} in cluster {cluster} ({vcenter})',
  vm_cohesity: '{vm} is protected by Cohesity group {group} on {cluster}, last good backup {age}',
  vm_zerto: '{vm} is replicated by Zerto VPG {vpg} ({status})',
  host_dell: 'host {host} is Dell {model}, service tag {tag}, OME status {status}',
  host_lm_uplinks: 'host {host} uplinks: {device} {port} ({status})',
  cohesity_vm: 'Cohesity object {object} is vCenter VM {vm} on host {host}',
  dell_host: 'service tag {tag} is ESX host {host} in cluster {cluster}',
  identity_links: '{host} is also {platform} {object}, for every other platform the identity index places it on',
  app_servers: '{label} ({usageId}) runs on {n} servers: {first five names}',
};

const DEFAULTS = {
  cohesity: {
    focus: 'Alert categories map to subsystems: a failed protection run with a client or snapshot error is a workload problem before a cluster one; replication lag on one target with a healthy source points at the WAN or the target; node or disk alerts are hardware. failedBackupJobs lists failed runs from the last 24 hours: quote the decisive part of the error in likely_cause. A cluster reached through Helios has no direct address, so a probe miss there says nothing.',
    ports: { source: [p(443, 'HTTPS REST', true)], host: [p(443, 'HTTPS', true), p(22, 'SSH', false)] },
    evidenceBudget: { alerts: 20, failedBackupJobs: 10, networkBlocks: 3 },
    relations: ['cohesity_vm', 'identity_links'],
  },
  netbackup: {
    focus: 'Primary server alerts come from job status; a status code names the component (media, client, network). A failed job on one client with others succeeding is client-side. Appliance alerts are hardware or storage, not jobs. failedBackupJobs lists failed jobs from the last 24 hours with the status code: say which jobs failed and use them in likely_cause.',
    ports: { source: [p(1556, 'PBX', true), p(443, 'Web UI', true), p(13724, 'vnetd', false)], host: [p(443, 'HTTPS', true)] },
    evidenceBudget: { alerts: 20, failedBackupJobs: 10, networkBlocks: 3 },
    relations: ['identity_links'],
  },
  pure: {
    focus: 'Array alerts are hardware, capacity or connectivity. A host connectivity alert with the array healthy points at the SAN path (Brocade) or the host HBA. Capacity alerts are not urgent unless the array is above the configured critical line.',
    ports: { source: [p(443, 'HTTPS', true), p(22, 'SSH', false)], host: [p(443, 'HTTPS', true), p(22, 'SSH', false)] },
    evidenceBudget: { alerts: 15, failedBackupJobs: 10, networkBlocks: 3 },
    relations: ['identity_links'],
  },
  netapp: {
    focus: 'ONTAP alerts carry the node and subsystem; a SnapMirror lag with both clusters healthy is a network or schedule problem, not storage. AIQUM-reported clusters have no direct address. A volume full alert names the SVM and volume, use them.',
    ports: { source: [p(443, 'HTTPS', true), p(22, 'SSH', false)], host: [p(443, 'HTTPS', true), p(22, 'SSH', false)] },
    evidenceBudget: { alerts: 15, failedBackupJobs: 10, networkBlocks: 3 },
    relations: ['identity_links'],
  },
  vcenter: {
    focus: 'Host alerts (disconnected, maintenance, HA) are about the ESX host; VM alerts (powered off, tools, guest volume full) are about the guest. A VM that just relocated or powered off is a vCenter event, check the events before blaming the guest OS. Current CPU and memory against the 30-day average and max say whether a guest is under new pressure.',
    ports: {
      source: [p(443, 'HTTPS', true), p(22, 'SSH', false), p(389, 'LDAP', false), p(636, 'LDAPS', false)],
      host: [p(443, 'HTTPS', true), p(902, 'ESX management', true), p(22, 'SSH', false), p(903, 'VM console', false)],
    },
    guestPorts: guest(),
    evidenceBudget: { alerts: 15, failedBackupJobs: 10, networkBlocks: 3 },
    relations: ['vm_host', 'vm_cohesity', 'vm_zerto', 'host_dell', 'host_lm_uplinks', 'app_servers', 'identity_links'],
  },
  proxmox: {
    focus: 'Node alerts are about the PVE node; guest alerts about the VM or container. A cluster quorum alert explains every guest alert that follows it.',
    ports: { source: [p(8006, 'Web UI', true), p(22, 'SSH', true)], host: [p(8006, 'Web UI', true), p(22, 'SSH', true)] },
    guestPorts: guest(),
    evidenceBudget: { alerts: 15, failedBackupJobs: 10, networkBlocks: 3 },
    relations: ['identity_links'],
  },
  nutanix: {
    focus: 'Prism Central reports cluster-wide, Prism Element per cluster; a PE alert with PC quiet is a single cluster. CVM alerts are the control plane, not the guests.',
    ports: { source: [p(9440, 'Prism', true), p(22, 'SSH', false)], host: [p(9440, 'Prism', true), p(22, 'SSH', false)] },
    guestPorts: guest(),
    evidenceBudget: { alerts: 15, failedBackupJobs: 10, networkBlocks: 3 },
    relations: ['identity_links'],
  },
  dell: {
    focus: 'OME alerts carry a service tag; warranty and firmware alerts are lifecycle, not outages. A hardware alert (PSU, fan, disk, memory) on a server that is also a vCenter host explains host-side symptoms, say which. iDRAC unreachable with the server up is a management network issue.',
    ports: { source: [p(443, 'OME HTTPS', true)], host: [p(443, 'iDRAC HTTPS', true), p(22, 'SSH', false), p(5900, 'Virtual console', false)] },
    evidenceBudget: { alerts: 15, failedBackupJobs: 10, networkBlocks: 3 },
    relations: ['dell_host', 'identity_links'],
  },
  brocade: {
    focus: 'SANnav alerts name the switch and port; a port down on one switch with the peer healthy is a cable, SFP or the attached HBA. A fabric-wide alert explains every path alert after it. Count lost paths per host, one lost path is degraded, all lost is an outage.',
    ports: { source: [p(443, 'SANnav HTTPS', true)], host: [p(22, 'SSH', true), p(443, 'HTTPS', true), p(80, 'HTTP', false)] },
    evidenceBudget: { alerts: 15, failedBackupJobs: 10, networkBlocks: 3 },
    relations: ['identity_links'],
  },
  bluecat: {
    focus: 'BAM alerts are management; BDDS alerts are the DNS or DHCP service. A DNS server unreachable from ICC with BAM healthy is that server or its network. Deployment failures name the server.',
    ports: { source: [p(443, 'BAM HTTPS', true)], host: [p(443, 'HTTPS', true), p(53, 'DNS TCP', true), p(22, 'SSH', false)] },
    evidenceBudget: { alerts: 15, failedBackupJobs: 10, networkBlocks: 3 },
    relations: ['identity_links'],
  },
  unifi: {
    focus: 'Controller alerts are the UDM; device alerts (offline, PoE, port) are the switch or AP. A device offline with its uplink port down on the parent is the cable or the parent.',
    ports: { source: [p(443, 'UDM HTTPS', true)], host: [p(22, 'SSH', true), p(443, 'HTTPS', false)] },
    evidenceBudget: { alerts: 15, failedBackupJobs: 10, networkBlocks: 3 },
    relations: ['identity_links'],
  },
  zerto: {
    focus: 'A VPG RPO breach with the sites connected is bandwidth or journal; a VRA alert with the host up is the VRA VM; site disconnected explains every VPG alert after it. Zerto re-raises alerts under new identifiers, so a repeat is the same condition unless the text changed.',
    ports: {
      source: [p(443, 'ZVM HTTPS', true), p(9669, 'ZVM API', true), p(22, 'SSH', false)],
      host: [p(9669, 'ZVM API', true), p(443, 'ZVM HTTPS', true), p(4007, 'VRA', false), p(4008, 'VRA', false), p(9007, 'ZVM to ZVM', false), p(9008, 'ZVM to ZVM', false)],
    },
    evidenceBudget: { alerts: 15, failedBackupJobs: 10, networkBlocks: 3 },
    relations: ['vm_zerto', 'identity_links'],
  },
  logicmonitor: {
    focus: 'A device dead with its collector down is the collector; dead with the collector up is the device or its path. A process check at 0 means no matching process, not a failed check. network blocks name the likely hop (port, interface, reachability, path to the WAN): put it ahead of host-level work. A site with one of two WAN circuits down is degraded, not down: say which circuit carries it. A circuit that flapped on several days before failing is failing: recommend the carrier ticket with the circuit id.',
    ports: { source: [], host: [p(443, 'Collector HTTPS', false), p(22, 'SSH', false)] },
    evidenceBudget: { alerts: 15, failedBackupJobs: 10, networkBlocks: 3 },
    relations: ['host_lm_uplinks', 'identity_links'],
  },
  aria: {
    focus: 'Automation alerts are deployments and requests; a failed request names the blueprint and the error. Appliance health is separate from request failures.',
    ports: { source: [p(443, 'HTTPS', true)], host: [p(443, 'HTTPS', true)] },
    evidenceBudget: { alerts: 10, failedBackupJobs: 10, networkBlocks: 3 },
    relations: ['identity_links'],
  },
  ariaops: {
    focus: 'Aria Operations alerts are its own analytics; treat them as a second opinion on a host that another platform also reports, never as the only evidence.',
    ports: { source: [p(443, 'HTTPS', true)], host: [p(443, 'HTTPS', true)] },
    evidenceBudget: { alerts: 10, failedBackupJobs: 10, networkBlocks: 3 },
    relations: ['identity_links'],
  },
  aws: {
    focus: 'Account alerts are posture and cost; a service unreachable is an AWS or IAM condition, not a host. No probes from ICC apply.',
    ports: { source: [], host: [] },
    evidenceBudget: { alerts: 10, failedBackupJobs: 10, networkBlocks: 3 },
    relations: ['identity_links'],
  },
  eon: {
    focus: 'Posture findings and job failures; a resource not backed up in PROD is critical by environment. No probes from ICC apply.',
    ports: { source: [], host: [] },
    evidenceBudget: { alerts: 10, failedBackupJobs: 10, networkBlocks: 3 },
    relations: ['identity_links'],
  },
};

/** Used when a platform has no entry (a pack nobody wrote a profile for). */
const GENERIC = {
  focus: '',
  ports: { source: [p(443, 'HTTPS', true)], host: [p(443, 'HTTPS', true)] },
  evidenceBudget: { alerts: 15, failedBackupJobs: 10, networkBlocks: 3 },
  relations: ['identity_links'],
};

const BUDGET_DEFAULTS = { alerts: 15, failedBackupJobs: 10, networkBlocks: 3 };

/** Which stored metric the history_slice capability reads in playbook mode, by platform and alert
 *  type. Metric names are the friendly names history_slice builds per target. Alert type names here
 *  are best effort: a type with no entry (or a metric the target has no history for) is skipped. */
const historyMetricFor = {
  vcenter: {
    'datastore-usage': 'vcenter_datastore_free_pct',
    'host-cpu': 'vcenter_host_cpu_pct',
    'host-memory': 'vcenter_host_mem_pct',
    'vm-cpu': 'vcenter_vm_cpu_mhz',
    'vm-memory': 'vcenter_vm_mem_mb',
  },
  pure: { 'capacity-high': 'pure_used_pct', 'latency-high': 'pure_read_latency_us' },
  netapp: { 'capacity-high': 'netapp_used_pct', 'latency-high': 'netapp_read_latency_us' },
  cohesity: { 'capacity-high': 'cohesity_used_pct' },
  brocade: { 'port-errors': 'brocade_crc_errors', 'crc-errors': 'brocade_crc_errors' },
};

module.exports = { DEFAULTS, GENERIC, GUEST_PORTS, RELATION_TEMPLATES, BUDGET_DEFAULTS, historyMetricFor };
