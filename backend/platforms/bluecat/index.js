// BlueCat platform manifest (ICC contract, feat/plugin-touchpoints).
// Manifest-hooks built-in (the unifi/nutanix model) — opsSummary/
// collectAlerts/searchCategories/metricsHistory/server360/server360Suggest
// are all wired via the branch's manifest hooks (backend/core/registry.js).
const bluecatMigrations = require('../../db/migrations/bluecat');
const bluecatRouter = require('../../routes/bluecat');
const { createBluecatPollerHandle } = require('../../services/bluecatPoller');
const { computeIssues } = require('../../services/bluecatIssues');

function opsSummary() {
  const db = require('../../db/database');
  const sourceCount = db.prepare('SELECT COUNT(*) n FROM bluecat_sources').get().n;
  if (!sourceCount) return null;

  const networkCount = db.prepare('SELECT COUNT(*) n FROM bluecat_networks').get().n;
  const recordCount = db.prepare('SELECT COUNT(*) n FROM bluecat_records').get().n;
  const viewCount = db.prepare('SELECT COUNT(*) n FROM bluecat_views').get().n;
  const zoneCount = db.prepare('SELECT COUNT(*) n FROM bluecat_zones').get().n;

  const issues = computeIssues();
  const bySeverity = { critical: 0, warning: 0, info: 0 };
  for (const i of issues) bySeverity[i.severity] = (bySeverity[i.severity] || 0) + 1;

  const exceptions = [];
  if (bySeverity.critical) exceptions.push({ severity: 'critical', count: bySeverity.critical, text: `${bySeverity.critical} critical issue${bySeverity.critical === 1 ? '' : 's'}`, link: '/bluecat' });
  if (bySeverity.warning) exceptions.push({ severity: 'warning', count: bySeverity.warning, text: `${bySeverity.warning} warning${bySeverity.warning === 1 ? '' : 's'}`, link: '/bluecat' });
  if (bySeverity.info) exceptions.push({ severity: 'info', count: Math.min(bySeverity.info, 3), text: `${bySeverity.info} info notice${bySeverity.info === 1 ? '' : 's'}`, link: '/bluecat' });

  const spark = db.prepare('SELECT networks_low_space FROM bluecat_metrics_history ORDER BY captured_at DESC LIMIT 24').all()
    .reverse().map((r) => r.networks_low_space);

  return {
    objects: networkCount + recordCount,
    headline: [
      { label: 'Views', value: viewCount },
      { label: 'Zones', value: zoneCount },
      { label: 'Records', value: recordCount },
      { label: 'Networks', value: networkCount },
    ],
    exceptions,
    spark: spark.length ? spark : null,
    sparkLabel: 'networks low on space',
  };
}

function collectAlerts() {
  const db = require('../../db/database');
  return db.prepare(`
    SELECT issue_key, severity, source, target, message, first_seen, last_seen
    FROM bluecat_issue_history WHERE status = 'open'
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
    key: 'bluecat-records', label: 'BlueCat Records', platform: 'bluecat', perm: 'bluecat:objects:view', base: '/bluecat',
    sql: `SELECT r.absolute_name AS title, (r.rr_type || ' ' || COALESCE(r.rdata, '')) AS subtitle FROM bluecat_records r
          WHERE r.absolute_name LIKE ? ESCAPE '\\' ORDER BY r.absolute_name LIMIT ?`,
  },
  {
    key: 'bluecat-addresses', label: 'BlueCat Addresses', platform: 'bluecat', perm: 'bluecat:objects:view', base: '/bluecat',
    sql: `SELECT a.address AS title, (COALESCE(a.name, '') || ' ' || COALESCE(a.state, '')) AS subtitle FROM bluecat_addresses a
          WHERE a.address LIKE ? ESCAPE '\\' OR a.name LIKE ? ESCAPE '\\' ORDER BY a.address LIMIT ?`,
    params: 2,
  },
  {
    key: 'bluecat-devices', label: 'BlueCat Devices', platform: 'bluecat', perm: 'bluecat:objects:view', base: '/bluecat',
    sql: `SELECT d.name AS title, COALESCE(d.device_type, '') AS subtitle FROM bluecat_devices d
          WHERE d.name LIKE ? ESCAPE '\\' ORDER BY d.name LIMIT ?`,
  },
  {
    key: 'bluecat-networks', label: 'BlueCat Networks', platform: 'bluecat', perm: 'bluecat:objects:view', base: '/bluecat',
    sql: `SELECT n.range AS title, COALESCE(n.name, '') AS subtitle FROM bluecat_networks n
          WHERE n.range LIKE ? ESCAPE '\\' ORDER BY n.range LIMIT ?`,
  },
];

/**
 * Server 360 contribution: BlueCat host/alias records whose name matches the
 * queried server name, plus records whose backing address matches a queried
 * IP. Display-ready per the registry.js provider contract; never throws.
 */
function server360(coreApi, ctx) {
  const db = coreApi.db;
  const names = Array.from(ctx?.names || []).map((n) => String(n).toLowerCase());
  const ips = Array.from(ctx?.ips || []);
  if (!names.length && !ips.length) return null;

  const matches = new Map();
  if (names.length) {
    const placeholders = names.map(() => '?').join(',');
    const shortClauses = names.map(() => "r.absolute_name LIKE ? ESCAPE '\\'").join(' OR ');
    const shortParams = names.map((n) => `${n}.%`);
    for (const row of db.prepare(`
      SELECT r.*, s.name AS source_name FROM bluecat_records r JOIN bluecat_sources s ON s.id = r.source_id
      WHERE LOWER(r.name) IN (${placeholders}) OR LOWER(r.absolute_name) IN (${placeholders}) OR ${shortClauses}
    `).all(...names, ...names, ...shortParams)) {
      matches.set(row.id, row);
    }
  }
  if (ips.length) {
    const placeholders = ips.map(() => '?').join(',');
    for (const row of db.prepare(`
      SELECT a.*, s.name AS source_name FROM bluecat_addresses a JOIN bluecat_sources s ON s.id = a.source_id
      JOIN bluecat_networks nw ON nw.source_id = a.source_id AND nw.network_id = a.network_id
      WHERE a.address IN (${placeholders})
    `).all(...ips)) {
      const key = `addr-${row.id}`;
      if (!matches.has(key)) matches.set(key, { ...row, isAddress: true });
    }
  }
  if (!matches.size) return null;

  const groups = [...matches.values()].slice(0, 10).map((r) => {
    if (r.isAddress) {
      return {
        facts: [
          { label: 'Address', value: r.address },
          { label: 'State', value: r.state || '-' },
          { label: 'MAC', value: r.mac || '-' },
        ],
        lines: [],
        link: { label: r.address, href: `/bluecat/dns?q=${encodeURIComponent(r.address)}` },
      };
    }
    return {
      facts: [
        { label: 'FQDN', value: r.absolute_name || r.name || '-' },
        { label: 'Type', value: r.rr_type || r.record_type || '-' },
        { label: 'Data', value: r.rdata || '-' },
        { label: 'TTL', value: r.ttl != null ? String(r.ttl) : '-' },
      ],
      lines: [],
      link: { label: r.absolute_name || r.name, href: `/bluecat/dns?q=${encodeURIComponent(r.absolute_name || r.name)}` },
    };
  });

  return {
    title: 'BlueCat',
    chip: { label: 'BlueCat', color: '#0057B8' },
    groups,
    link: { label: 'View in BlueCat', href: '/bluecat/dns' },
  };
}

function server360Suggest(coreApi, q) {
  const db = coreApi.db;
  const pattern = `%${String(q || '').replace(/[%_]/g, '\\$&')}%`;
  return db.prepare(`
    SELECT DISTINCT absolute_name FROM bluecat_records
    WHERE absolute_name LIKE ? ESCAPE '\\' ORDER BY absolute_name LIMIT 8
  `).all(pattern).map((r) => r.absolute_name).filter(Boolean);
}

module.exports = {
  id: 'bluecat',
  name: 'BlueCat Address Manager',
  apiVersion: 1,
  color: '#0057B8',
  migrations: bluecatMigrations,
  createRouter() {
    return bluecatRouter;
  },
  createPoller() {
    return createBluecatPollerHandle();
  },
  statusTables: ['bluecat_sources'],
  settingsFields: [],
  navSections: ['overview', 'ipspaces', 'dns', 'devices', 'servers', 'alerts', 'settings'],
  datasets: [
    {
      id: 'bluecat.networks',
      label: 'BlueCat Networks',
      table: 'bluecat_networks',
      section: 'ipspaces',
      defaultSort: 'range',
      columns: [
        { key: 'range', label: 'Range', type: 'string', filterable: true },
        { key: 'name', label: 'Name', type: 'string', filterable: true },
        { key: 'prefix', label: 'Prefix', type: 'number' },
        { key: 'capacity', label: 'Capacity', type: 'number', aggregatable: true },
        { key: 'gateway', label: 'Gateway', type: 'string' },
        { key: 'gateway_source', label: 'Gateway Source', type: 'enum', filterable: true },
        { key: 'used_static', label: 'Used', type: 'number', aggregatable: true },
        { key: 'free_static', label: 'Free', type: 'number', aggregatable: true },
        { key: 'free_pct', label: 'Free %', type: 'number' },
        { key: 'counts_source', label: 'Counts Source', type: 'enum', filterable: true },
        { key: 'location_name', label: 'Location', type: 'string', filterable: true },
      ],
    },
    {
      id: 'bluecat.records',
      label: 'BlueCat Records',
      table: 'bluecat_records',
      section: 'dns',
      defaultSort: 'absolute_name',
      columns: [
        { key: 'absolute_name', label: 'Name', type: 'string', filterable: true },
        { key: 'rr_type', label: 'Type', type: 'enum', filterable: true },
        { key: 'rdata', label: 'Data', type: 'string' },
        { key: 'ttl', label: 'TTL', type: 'number' },
        { key: 'record_type', label: 'Record Type', type: 'enum', filterable: true },
      ],
    },
    {
      id: 'bluecat.devices',
      label: 'BlueCat Devices',
      table: 'bluecat_devices',
      section: 'devices',
      defaultSort: 'name',
      columns: [
        { key: 'name', label: 'Device', type: 'string', filterable: true },
        { key: 'device_type', label: 'Type', type: 'enum', filterable: true },
        { key: 'device_subtype', label: 'Subtype', type: 'enum', filterable: true },
        { key: 'description', label: 'Description', type: 'string' },
      ],
    },
    {
      id: 'bluecat.servers',
      label: 'BlueCat Servers',
      table: 'bluecat_servers',
      section: 'servers',
      defaultSort: 'name',
      columns: [
        { key: 'name', label: 'Server', type: 'string', filterable: true },
        { key: 'profile', label: 'Profile', type: 'enum', filterable: true },
        { key: 'address', label: 'Address', type: 'string' },
        { key: 'connected', label: 'Connected', type: 'boolean', filterable: true },
        { key: 'last_deploy_status', label: 'Last Deploy', type: 'enum', filterable: true },
      ],
    },
  ],
  opsSummary,
  collectAlerts,
  searchCategories,
  metricsHistory: { arraysTable: 'bluecat_sources', metricsTable: 'bluecat_metrics_history', arrayIdColumn: 'source_id' },
  server360,
  server360Suggest,
};
