// Nutanix plugin manifest. Dual connection model (Prism Central / Prism
// Element) registered like vCenter/NetBackup, plus Move sub-connections.
// RBAC grants, ops-summary card, alert-email collection, global search, and
// per-cluster metrics history are all wired via the host's manifest hooks
// (backend/core/registry.js) — no core.js/ops.js/poller.js/alertNotifier.js/
// search.js/server360.js edits required.
//
// Ported from backend/platforms/nutanix/index.js. Migrations copied
// VERBATIM (same scope id 'nutanix') so an existing local DB's nutanix_* data
// (and its schema_migrations row) is adopted intact on install.
const { migrations } = require('./migrations');
const { createRouter } = require('./router');
const { createNutanixPoller } = require('./poller');
const { computeIssues } = require('./issues');

function opsSummary(coreApi) {
  const db = coreApi.db;
  const sourceCount = db.prepare('SELECT COUNT(*) n FROM nutanix_sources').get().n;
  if (!sourceCount) return null;

  const clusterCount = db.prepare('SELECT COUNT(*) n FROM nutanix_clusters').get().n;
  const vmCount = db.prepare('SELECT COUNT(*) n FROM nutanix_vms').get().n;
  const capAgg = db.prepare('SELECT SUM(storage_capacity_bytes) cap, SUM(storage_usage_bytes) used FROM nutanix_clusters').get();
  const usedPct = capAgg.cap > 0 ? Math.round((capAgg.used / capAgg.cap) * 100) : null;

  const issues = computeIssues(coreApi);
  const bySeverityCount = { critical: 0, warning: 0 };
  for (const i of issues) {
    if (i.severity === 'critical') bySeverityCount.critical += 1;
    else if (i.severity === 'warning') bySeverityCount.warning += 1;
  }
  const exceptions = [];
  if (bySeverityCount.critical) {
    exceptions.push({ severity: 'critical', count: bySeverityCount.critical, text: `${bySeverityCount.critical} critical issue${bySeverityCount.critical === 1 ? '' : 's'}`, link: '/nutanix' });
  }
  if (bySeverityCount.warning) {
    exceptions.push({ severity: 'warning', count: bySeverityCount.warning, text: `${bySeverityCount.warning} warning${bySeverityCount.warning === 1 ? '' : 's'}`, link: '/nutanix' });
  }

  return {
    objects: clusterCount + vmCount,
    headline: [
      { label: 'Clusters', value: clusterCount },
      { label: 'VMs', value: vmCount },
      { label: 'Storage used', value: usedPct != null ? `${usedPct}%` : '—' },
    ],
    exceptions,
    spark: null,
    sparkLabel: undefined,
  };
}

function collectAlerts(coreApi) {
  return coreApi.db.prepare(`
    SELECT issue_key, severity, source, target, message, first_seen, last_seen
    FROM nutanix_issue_history WHERE status = 'open'
  `).all().map((row) => ({
    sourceKey: row.issue_key,
    severity: row.severity,
    host: row.target || row.source,
    message: row.message,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  }));
}

const searchCategories = [
  {
    key: 'nutanix-clusters', label: 'Nutanix Clusters', platform: 'nutanix', perm: 'nutanix:clusters:view', base: '/nutanix/clusters',
    sql: `SELECT c.name AS title, s.name AS subtitle FROM nutanix_clusters c
          JOIN nutanix_sources s ON s.id = c.source_id
          WHERE c.name LIKE ? ESCAPE '\\' ORDER BY c.name LIMIT ?`,
  },
  {
    key: 'nutanix-vms', label: 'Nutanix VMs', platform: 'nutanix', perm: 'nutanix:vms:view', base: '/nutanix/vms',
    sql: `SELECT v.name AS title, v.cluster_name AS subtitle FROM nutanix_vms v
          WHERE v.name LIKE ? ESCAPE '\\' ORDER BY v.name LIMIT ?`,
  },
  {
    key: 'nutanix-hosts', label: 'Nutanix Hosts', platform: 'nutanix', perm: 'nutanix:hosts:view', base: '/nutanix/hosts',
    sql: `SELECT h.name AS title, s.name AS subtitle FROM nutanix_hosts h
          JOIN nutanix_sources s ON s.id = h.source_id
          WHERE h.name LIKE ? ESCAPE '\\' ORDER BY h.name LIMIT ?`,
  },
];

/**
 * Server 360 contribution: VMs matching the queried server name/IP, either by
 * case-insensitive name match or membership in the VM's ip_addresses JSON
 * array. Display-ready per the host registry.js provider contract; never
 * throws (a bad JSON row is skipped, not fatal).
 */
function server360(coreApi, ctx) {
  const db = coreApi.db;
  const names = Array.from(ctx?.names || []);
  const ips = Array.from(ctx?.ips || []);
  if (!names.length && !ips.length) return null;

  const matches = new Map(); // uuid -> row
  if (names.length) {
    const placeholders = names.map(() => '?').join(',');
    for (const row of db.prepare(`
      SELECT v.*, s.name AS source_name FROM nutanix_vms v JOIN nutanix_sources s ON s.id = v.source_id
      WHERE LOWER(v.name) IN (${placeholders})
    `).all(...names.map((n) => String(n).toLowerCase()))) {
      matches.set(row.uuid, row);
    }
  }
  if (ips.length) {
    for (const row of db.prepare(`
      SELECT v.*, s.name AS source_name FROM nutanix_vms v JOIN nutanix_sources s ON s.id = v.source_id
      WHERE v.ip_addresses IS NOT NULL
    `).all()) {
      if (matches.has(row.uuid)) continue;
      let vmIps = [];
      try { vmIps = JSON.parse(row.ip_addresses) || []; } catch { vmIps = []; }
      if (vmIps.some((ip) => ips.includes(ip))) matches.set(row.uuid, row);
    }
  }
  if (!matches.size) return null;

  const groups = [...matches.values()].slice(0, 10).map((vm) => ({
    facts: [
      { label: 'Cluster', value: vm.cluster_name || '—' },
      { label: 'Source', value: vm.source_name },
      { label: 'Power', value: vm.power_state || '—' },
      { label: 'vCPUs', value: vm.num_vcpus ?? '—' },
      { label: 'Memory (MB)', value: vm.memory_mb ?? '—' },
    ],
    lines: vm.host_name ? [`Host: ${vm.host_name}`] : [],
    // No per-VM detail route exists — deep-link to the VMs page pre-filtered
    // to this VM (?q= convention, same as global search).
    link: { label: vm.name, href: `/nutanix/vms?q=${encodeURIComponent(vm.name)}` },
  }));

  return {
    title: 'Nutanix',
    chip: { label: `${matches.size} VM${matches.size === 1 ? '' : 's'}`, color: '#7855FA' },
    groups,
  };
}

function server360Suggest(coreApi, q) {
  const db = coreApi.db;
  const pattern = `%${String(q || '').replace(/[%_]/g, '\\$&')}%`;
  return db.prepare(`
    SELECT DISTINCT name FROM nutanix_vms WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 8
  `).all(pattern).map((r) => r.name);
}

module.exports = {
  id: 'nutanix',
  name: 'Nutanix',
  apiVersion: 1,
  color: '#7855FA',
  // No hardcoded version: it overrides the packaged manifest.json, pins the
  // plugins DB row forever, and — because the bundle cache-buster is
  // ?v=<version> — makes CDNs serve the OLD frontend bundle after every
  // upgrade (campaign trap #5; this exact line masked the 1.0.1 upgrade).
  migrations,
  createRouter(coreApi) {
    return createRouter(coreApi);
  },
  createPoller(coreApi) {
    return createNutanixPoller(coreApi);
  },
  statusTables: ['nutanix_sources'],
  settingsFields: [],
  navSections: ['overview', 'clusters', 'hosts', 'vms', 'storage', 'protection', 'alerts', 'move', 'advisor', 'settings'],
  datasets: [
    {
      id: 'nutanix.clusters',
      label: 'Nutanix Clusters',
      table: 'nutanix_clusters',
      section: 'clusters',
      defaultSort: 'name',
      columns: [
        { key: 'name', label: 'Cluster', type: 'string', filterable: true },
        { key: 'aos_version', label: 'AOS Version', type: 'string', filterable: true },
        { key: 'num_nodes', label: 'Nodes', type: 'number', aggregatable: true },
        { key: 'operation_mode', label: 'Operation Mode', type: 'enum', filterable: true },
        { key: 'storage_capacity_bytes', label: 'Storage Capacity', type: 'number', unit: 'bytes', aggregatable: true },
        { key: 'storage_usage_bytes', label: 'Storage Used', type: 'number', unit: 'bytes', aggregatable: true },
        { key: 'runway_days', label: 'Runway', type: 'number', unit: 'days' },
        { key: 'ft_failures_tolerable', label: 'Failures Tolerable', type: 'number' },
      ],
    },
    {
      id: 'nutanix.hosts',
      label: 'Nutanix Hosts',
      table: 'nutanix_hosts',
      section: 'hosts',
      defaultSort: 'name',
      columns: [
        { key: 'name', label: 'Host', type: 'string', filterable: true },
        { key: 'hypervisor_type', label: 'Hypervisor', type: 'enum', filterable: true },
        { key: 'state', label: 'State', type: 'enum', filterable: true },
        { key: 'maintenance_mode', label: 'Maintenance', type: 'boolean', filterable: true },
        { key: 'is_degraded', label: 'Degraded', type: 'boolean', filterable: true },
        { key: 'num_vms', label: 'VMs', type: 'number', aggregatable: true },
        { key: 'num_cpu_cores', label: 'CPU Cores', type: 'number', aggregatable: true },
        { key: 'memory_capacity_bytes', label: 'Memory Capacity', type: 'number', unit: 'bytes', aggregatable: true },
      ],
    },
    {
      id: 'nutanix.vms',
      label: 'Nutanix VMs',
      table: 'nutanix_vms',
      section: 'vms',
      defaultSort: 'name',
      columns: [
        { key: 'name', label: 'VM', type: 'string', filterable: true },
        { key: 'cluster_name', label: 'Cluster', type: 'string', filterable: true },
        { key: 'power_state', label: 'Power', type: 'enum', filterable: true },
        { key: 'num_vcpus', label: 'vCPUs', type: 'number', aggregatable: true },
        { key: 'memory_mb', label: 'Memory (MB)', type: 'number', aggregatable: true },
        { key: 'ngt_status', label: 'NGT Status', type: 'enum', filterable: true },
      ],
    },
    {
      id: 'nutanix.containers',
      label: 'Nutanix Storage Containers',
      table: 'nutanix_containers',
      section: 'storage',
      defaultSort: 'name',
      columns: [
        { key: 'name', label: 'Container', type: 'string', filterable: true },
        { key: 'cluster_name', label: 'Cluster', type: 'string', filterable: true },
        { key: 'replication_factor', label: 'RF', type: 'number' },
        { key: 'capacity_bytes', label: 'Capacity', type: 'number', unit: 'bytes', aggregatable: true },
        { key: 'usage_bytes', label: 'Used', type: 'number', unit: 'bytes', aggregatable: true },
        { key: 'free_bytes', label: 'Free', type: 'number', unit: 'bytes', aggregatable: true },
      ],
    },
  ],
  opsSummary,
  collectAlerts,
  searchCategories,
  metricsHistory: { arraysTable: 'nutanix_clusters', metricsTable: 'nutanix_metrics_history', arrayIdColumn: 'cluster_id' },
  server360,
  server360Suggest,
};
