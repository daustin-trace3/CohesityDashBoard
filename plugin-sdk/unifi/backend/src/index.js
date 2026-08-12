// UniFi plugin manifest. Hook parity with the built-in
// backend/platforms/unifi/index.js (manifest-hooks built-in, the nutanix
// model) — opsSummary/collectAlerts/searchCategories/metricsHistory/
// server360/server360Suggest are all wired via the host's manifest hooks
// (backend/core/registry.js). No core.js/ops.js/poller.js/alertNotifier.js/
// search.js/server360.js edits required.
//
// Migrations copied VERBATIM (same scope id 'unifi') so an existing local
// DB's unifi_* data (and its schema_migrations row) is adopted intact on
// install.
const migrations = require('./migrations');
const { createRouter } = require('./router');
const { createUnifiPoller } = require('./poller');
const { computeIssues } = require('./issues');

function opsSummary(coreApi) {
  const db = coreApi.db;
  const sourceCount = db.prepare('SELECT COUNT(*) n FROM unifi_sources').get().n;
  if (!sourceCount) return null;

  const deviceCount = db.prepare('SELECT COUNT(*) n FROM unifi_devices').get().n;
  const deviceTotals = db.prepare('SELECT COUNT(*) total, SUM(CASE WHEN state = 1 THEN 1 ELSE 0 END) online FROM unifi_devices').get();
  const clientCount = db.prepare('SELECT COUNT(*) n FROM unifi_clients').get().n;
  const wanRow = db.prepare('SELECT isp_name FROM unifi_wan LIMIT 1').get();

  const issues = computeIssues(coreApi);
  const bySeverity = { critical: 0, warning: 0, info: 0 };
  for (const i of issues) bySeverity[i.severity] = (bySeverity[i.severity] || 0) + 1;

  const exceptions = [];
  if (bySeverity.critical) {
    exceptions.push({ severity: 'critical', count: bySeverity.critical, text: `${bySeverity.critical} critical issue${bySeverity.critical === 1 ? '' : 's'}`, link: '/unifi' });
  }
  if (bySeverity.warning) {
    exceptions.push({ severity: 'warning', count: bySeverity.warning, text: `${bySeverity.warning} warning${bySeverity.warning === 1 ? '' : 's'}`, link: '/unifi' });
  }
  if (bySeverity.info) {
    exceptions.push({ severity: 'info', count: Math.min(bySeverity.info, 3), text: `${bySeverity.info} info notice${bySeverity.info === 1 ? '' : 's'}`, link: '/unifi' });
  }

  const spark = db.prepare('SELECT clients_total FROM unifi_metrics_history ORDER BY captured_at DESC LIMIT 24').all()
    .reverse().map((r) => r.clients_total);

  return {
    objects: deviceCount,
    headline: [
      { label: 'Devices', value: deviceTotals.total || 0 },
      { label: 'Online', value: deviceTotals.online || 0 },
      { label: 'Clients', value: clientCount },
      { label: 'ISP', value: wanRow?.isp_name || '—' },
    ],
    exceptions,
    spark: spark.length ? spark : null,
    sparkLabel: 'clients',
  };
}

function collectAlerts(coreApi) {
  return coreApi.db.prepare(`
    SELECT issue_key, severity, source, target, message, first_seen, last_seen
    FROM unifi_issue_history WHERE status = 'open'
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
    key: 'unifi-devices', label: 'UniFi Devices', platform: 'unifi', perm: 'unifi:objects:view', base: '/unifi',
    sql: `SELECT d.name AS title, (d.model || ' ' || COALESCE(d.ip, '')) AS subtitle FROM unifi_devices d
          WHERE d.name LIKE ? ESCAPE '\\' ORDER BY d.name LIMIT ?`,
  },
  {
    key: 'unifi-clients', label: 'UniFi Clients', platform: 'unifi', perm: 'unifi:objects:view', base: '/unifi',
    sql: `SELECT COALESCE(c.name, c.hostname) AS title, c.ip AS subtitle FROM unifi_clients c
          WHERE COALESCE(c.name, c.hostname) LIKE ? ESCAPE '\\' ORDER BY COALESCE(c.name, c.hostname) LIMIT ?`,
  },
  {
    key: 'unifi-wlans', label: 'UniFi WLANs', platform: 'unifi', perm: 'unifi:objects:view', base: '/unifi',
    sql: `SELECT w.name AS title, w.security AS subtitle FROM unifi_wlans w
          WHERE w.name LIKE ? ESCAPE '\\' ORDER BY w.name LIMIT ?`,
  },
  {
    key: 'unifi-cameras', label: 'UniFi Cameras', platform: 'unifi', perm: 'unifi:objects:view', base: '/unifi',
    sql: `SELECT c.name AS title, (CASE WHEN c.model_key = 'chime' THEN 'Chime' ELSE 'Camera' END || ' · ' || COALESCE(c.state, '')) AS subtitle
          FROM unifi_cameras c WHERE c.name LIKE ? ESCAPE '\\' ORDER BY c.name LIMIT ?`,
  },
];

/**
 * Server 360 contribution: UniFi clients matching the queried server
 * name/hostname or IP, plus devices matching by name. Display-ready per the
 * registry.js provider contract; never throws.
 */
function server360(coreApi, ctx) {
  const db = coreApi.db;
  const names = Array.from(ctx?.names || []).map((n) => String(n).toLowerCase());
  const ips = Array.from(ctx?.ips || []);
  if (!names.length && !ips.length) return null;

  const matches = new Map(); // mac -> row
  if (names.length) {
    const placeholders = names.map(() => '?').join(',');
    for (const row of db.prepare(`
      SELECT c.*, s.name AS source_name FROM unifi_clients c JOIN unifi_sources s ON s.id = c.source_id
      WHERE LOWER(COALESCE(c.name, '')) IN (${placeholders}) OR LOWER(COALESCE(c.hostname, '')) IN (${placeholders})
    `).all(...names, ...names)) {
      matches.set(row.mac, row);
    }
  }
  if (ips.length) {
    const placeholders = ips.map(() => '?').join(',');
    for (const row of db.prepare(`
      SELECT c.*, s.name AS source_name FROM unifi_clients c JOIN unifi_sources s ON s.id = c.source_id
      WHERE c.ip IN (${placeholders})
    `).all(...ips)) {
      if (!matches.has(row.mac)) matches.set(row.mac, row);
    }
  }
  if (!matches.size) return null;

  const groups = [...matches.values()].slice(0, 10).map((c) => {
    const connection = c.is_wired === 1
      ? `Wired — ${c.sw_name || c.sw_mac || 'unknown switch'} port ${c.sw_port ?? '—'}`
      : `WiFi — ${c.essid || 'unknown SSID'} via ${c.ap_name || c.ap_mac || 'unknown AP'} (${c.signal ?? '—'} dBm)`;
    return {
      facts: [
        { label: 'IP', value: c.ip || '—' },
        { label: 'MAC', value: c.mac },
        { label: 'Connection', value: connection },
        { label: 'Network', value: c.network || '—' },
      ],
      lines: [],
      link: { label: c.name || c.hostname || c.mac, href: `/unifi/clients?q=${encodeURIComponent(c.name || c.hostname || c.mac)}` },
    };
  });

  return {
    title: 'UniFi',
    chip: { label: 'UniFi', color: '#006FFF' },
    groups,
    link: { label: 'View in UniFi', href: `/unifi/clients?q=${encodeURIComponent([...matches.values()][0].name || [...matches.values()][0].hostname || '')}` },
  };
}

function server360Suggest(coreApi, q) {
  const db = coreApi.db;
  const pattern = `%${String(q || '').replace(/[%_]/g, '\\$&')}%`;
  return db.prepare(`
    SELECT DISTINCT COALESCE(name, hostname) AS n FROM unifi_clients
    WHERE COALESCE(name, hostname) LIKE ? ESCAPE '\\' ORDER BY n LIMIT 8
  `).all(pattern).map((r) => r.n).filter(Boolean);
}

module.exports = {
  id: 'unifi',
  name: 'Ubiquiti UniFi',
  apiVersion: 1,
  color: '#006FFF',
  // No hardcoded version: the installer falls back to the packaged
  // manifest.json (sourced from plugin.json at pack time). A literal here
  // goes stale on upgrades and — because the bundle URL cache-buster is
  // ?v=<version> — makes CDNs serve the OLD frontend bundle forever.
  migrations,
  createRouter(coreApi) {
    return createRouter(coreApi);
  },
  createPoller(coreApi) {
    return createUnifiPoller(coreApi);
  },
  statusTables: ['unifi_sources'],
  settingsFields: [],
  navSections: ['overview', 'devices', 'ports', 'clients', 'wifi', 'protect', 'topology', 'wan', 'security', 'alerts', 'settings'],
  datasets: [
    {
      id: 'unifi.devices',
      label: 'UniFi Devices',
      table: 'unifi_devices',
      section: 'devices',
      defaultSort: 'name',
      columns: [
        { key: 'name', label: 'Device', type: 'string', filterable: true },
        { key: 'model', label: 'Model', type: 'string', filterable: true },
        { key: 'type', label: 'Type', type: 'enum', filterable: true },
        { key: 'ip', label: 'IP', type: 'string' },
        { key: 'state', label: 'State', type: 'number', filterable: true },
        { key: 'cpu_pct', label: 'CPU %', type: 'number', aggregatable: true },
        { key: 'mem_pct', label: 'Mem %', type: 'number', aggregatable: true },
        { key: 'num_sta', label: 'Clients', type: 'number', aggregatable: true },
      ],
    },
    {
      id: 'unifi.ports',
      label: 'UniFi Ports',
      table: 'unifi_ports',
      section: 'ports',
      defaultSort: 'port_idx',
      columns: [
        { key: 'device_mac', label: 'Device MAC', type: 'string', filterable: true },
        { key: 'port_idx', label: 'Port', type: 'number' },
        { key: 'media', label: 'Media', type: 'enum', filterable: true },
        { key: 'up', label: 'Up', type: 'boolean', filterable: true },
        { key: 'speed', label: 'Speed', type: 'number', unit: 'mbps', aggregatable: true },
        { key: 'poe_power', label: 'PoE Power', type: 'number', unit: 'watts', aggregatable: true },
      ],
    },
    {
      id: 'unifi.clients',
      label: 'UniFi Clients',
      table: 'unifi_clients',
      section: 'clients',
      defaultSort: 'name',
      columns: [
        { key: 'name', label: 'Client', type: 'string', filterable: true },
        { key: 'ip', label: 'IP', type: 'string', filterable: true },
        { key: 'is_wired', label: 'Wired', type: 'boolean', filterable: true },
        { key: 'is_guest', label: 'Guest', type: 'boolean', filterable: true },
        { key: 'network', label: 'Network', type: 'enum', filterable: true },
        { key: 'satisfaction', label: 'Satisfaction', type: 'number', aggregatable: true },
      ],
    },
    {
      id: 'unifi.wlans',
      label: 'UniFi WLANs',
      table: 'unifi_wlans',
      section: 'wifi',
      defaultSort: 'name',
      columns: [
        { key: 'name', label: 'WLAN', type: 'string', filterable: true },
        { key: 'security', label: 'Security', type: 'enum', filterable: true },
        { key: 'enabled', label: 'Enabled', type: 'boolean', filterable: true },
        { key: 'is_guest', label: 'Guest', type: 'boolean', filterable: true },
      ],
    },
  ],
  opsSummary,
  collectAlerts,
  searchCategories,
  metricsHistory: { arraysTable: 'unifi_sources', metricsTable: 'unifi_metrics_history', arrayIdColumn: 'source_id' },
  server360,
  server360Suggest,
};
