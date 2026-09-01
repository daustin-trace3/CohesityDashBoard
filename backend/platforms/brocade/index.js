// Brocade SAN platform manifest (ICC contract, feat/plugin-touchpoints).
// Manifest-hooks built-in (the unifi/nutanix model) — opsSummary/
// collectAlerts/searchCategories/metricsHistory/server360/server360Suggest
// are all wired via the branch's manifest hooks (backend/core/registry.js).
const brocadeMigrations = require('../../db/migrations/brocade');
const brocadeRouter = require('../../routes/brocade');
const { brocadePollerHandle } = require('../../services/brocadePoller');
const { computeIssues } = require('../../services/brocadeIssues');

function opsSummary() {
  const db = require('../../db/database');
  const sourceCount = db.prepare('SELECT COUNT(*) n FROM brocade_sources').get().n;
  if (!sourceCount) return null;

  const fabricsTotal = db.prepare('SELECT COUNT(*) n FROM brocade_fabrics WHERE stale = 0').get().n;
  const switchTotals = db.prepare('SELECT COUNT(*) total FROM brocade_switches WHERE stale = 0').get();
  const portTotals = db.prepare(`
    SELECT COUNT(*) total, SUM(CASE WHEN LOWER(COALESCE(state,'')) = 'online' THEN 1 ELSE 0 END) online
    FROM brocade_switch_ports WHERE stale = 0
  `).get();

  const issues = computeIssues();
  const bySeverity = { critical: 0, warning: 0, info: 0 };
  for (const i of issues) bySeverity[i.severity] = (bySeverity[i.severity] || 0) + 1;

  // Deviation flag (WP1): the contract sketch showed headline/exceptions as
  // plain strings; unifi's ACTUAL code (and routes/ops.js's `exception()`
  // helper / pluginHooks.test.js) uses headline: [{label,value}] and
  // exceptions: [{severity,count,text,link}]. Following unifi's real shape.
  const exceptions = [];
  if (bySeverity.critical) exceptions.push({ severity: 'critical', count: bySeverity.critical, text: `${bySeverity.critical} critical issue${bySeverity.critical === 1 ? '' : 's'}`, link: '/brocade/issues' });
  if (bySeverity.warning) exceptions.push({ severity: 'warning', count: bySeverity.warning, text: `${bySeverity.warning} warning${bySeverity.warning === 1 ? '' : 's'}`, link: '/brocade/issues' });
  if (bySeverity.info) exceptions.push({ severity: 'info', count: Math.min(bySeverity.info, 3), text: `${bySeverity.info} info notice${bySeverity.info === 1 ? '' : 's'}`, link: '/brocade/issues' });

  const spark = db.prepare('SELECT ports_online FROM brocade_metrics ORDER BY ts DESC LIMIT 24').all()
    .reverse().map((r) => r.ports_online);

  return {
    objects: switchTotals.total || 0,
    headline: [
      { label: 'Fabrics', value: fabricsTotal },
      { label: 'Switches', value: switchTotals.total || 0 },
      { label: 'Ports Online', value: portTotals.online || 0 },
    ],
    exceptions,
    spark: spark.length ? spark : null,
    sparkLabel: 'ports online',
  };
}

function collectAlerts() {
  const db = require('../../db/database');
  // Deviation flag (WP1): mirrors unifi's collectAlerts, which reads its
  // open issue_history rows (for stable firstSeen/lastSeen) rather than
  // re-deriving from computeIssues() on every call. Contract §8 also asks
  // for unacknowledged critical/alert events from the last 24h folded in —
  // LEFT JOIN semantics preserved (source_id may be NULL-safe via COALESCE).
  const fromIssues = db.prepare(`
    SELECT source_id, source, type, target, severity, message, first_seen, last_seen
    FROM brocade_issue_history WHERE resolved_at IS NULL AND severity IN ('critical', 'warning')
  `).all().map((row) => ({
    sourceKey: `brocade:${row.source_id}:${row.type}:${row.target}`,
    severity: row.severity,
    host: row.target || row.source,
    message: row.message,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  }));

  const fromEvents = db.prepare(`
    SELECT e.*, s.name AS source_name FROM brocade_events e
    LEFT JOIN brocade_sources s ON s.id = e.source_id
    WHERE e.acknowledged = 0 AND e.severity_norm IN ('critical', 'alert')
      AND e.last_occurred_ms >= ?
  `).all(Date.now() - 86400000).map((e) => ({
    sourceKey: `brocade:${e.source_id}:event:${e.event_id}`,
    severity: 'critical',
    host: e.source_name || e.source_address || e.fabric_name || 'unknown',
    message: e.description || e.message_id || 'Brocade event',
    firstSeen: e.first_occurred_ms ? new Date(e.first_occurred_ms).toISOString() : null,
    lastSeen: e.last_occurred_ms ? new Date(e.last_occurred_ms).toISOString() : null,
  }));

  return [...fromIssues, ...fromEvents];
}

// `params` tells routes/search.js how many times to repeat the LIKE pattern
// bind (default 1) — required whenever the SQL has more than one `?` for the
// pattern itself (grep `cat.params` in routes/search.js: `Array(cat.params
// || 1).fill(pattern)`, args then `LIMIT_PER_CATEGORY` appended last).
const searchCategories = [
  {
    key: 'brocade-switches', label: 'Brocade Switches', platform: 'brocade', perm: 'brocade:objects:view', base: '/brocade/switches',
    params: 3,
    sql: `SELECT name AS title, (COALESCE(model, '') || ' ' || COALESCE(ip_address, '')) AS subtitle FROM brocade_switches
          WHERE (name LIKE ? ESCAPE '\\' OR wwn LIKE ? ESCAPE '\\' OR ip_address LIKE ? ESCAPE '\\') AND stale = 0 ORDER BY name LIMIT ?`,
  },
  {
    key: 'brocade-fabrics', label: 'Brocade Fabrics', platform: 'brocade', perm: 'brocade:objects:view', base: '/brocade/fabrics',
    sql: `SELECT name AS title, COALESCE(health, '') AS subtitle FROM brocade_fabrics
          WHERE name LIKE ? ESCAPE '\\' AND stale = 0 ORDER BY name LIMIT ?`,
  },
  {
    key: 'brocade-enclosures', label: 'Brocade Devices', platform: 'brocade', perm: 'brocade:objects:view', base: '/brocade/devices',
    params: 2,
    sql: `SELECT name AS title, COALESCE(host_name, '') AS subtitle FROM brocade_enclosures
          WHERE (name LIKE ? ESCAPE '\\' OR host_name LIKE ? ESCAPE '\\') AND stale = 0 ORDER BY name LIMIT ?`,
  },
  {
    key: 'brocade-device-ports', label: 'Brocade Device Ports', platform: 'brocade', perm: 'brocade:objects:view', base: '/brocade/devices',
    params: 2,
    sql: `SELECT COALESCE(symbolic_name, wwn) AS title, wwn AS subtitle FROM brocade_device_ports
          WHERE (wwn LIKE ? ESCAPE '\\' OR symbolic_name LIKE ? ESCAPE '\\') AND stale = 0 ORDER BY symbolic_name LIMIT ?`,
  },
];

/**
 * Server 360 contribution: enclosures matching the queried server
 * name/hostname or IP, plus their device ports. Display-ready per the
 * registry.js provider contract; never throws.
 */
function server360(coreApi, ctx) {
  const db = coreApi.db;
  const names = Array.from(ctx?.names || []).map((n) => String(n).toLowerCase());
  const ips = Array.from(ctx?.ips || []);
  if (!names.length && !ips.length) return null;

  const matches = new Map(); // guid -> row
  if (names.length) {
    const placeholders = names.map(() => '?').join(',');
    for (const row of db.prepare(`
      SELECT e.*, s.name AS source_name FROM brocade_enclosures e JOIN brocade_sources s ON s.id = e.source_id
      WHERE e.stale = 0 AND (LOWER(COALESCE(e.host_name, '')) IN (${placeholders}) OR LOWER(COALESCE(e.name, '')) IN (${placeholders}))
    `).all(...names, ...names)) {
      matches.set(row.guid, row);
    }
  }
  if (ips.length) {
    const placeholders = ips.map(() => '?').join(',');
    for (const row of db.prepare(`
      SELECT e.*, s.name AS source_name FROM brocade_enclosures e JOIN brocade_sources s ON s.id = e.source_id
      WHERE e.stale = 0 AND e.ip_address IN (${placeholders})
    `).all(...ips)) {
      if (!matches.has(row.guid)) matches.set(row.guid, row);
    }
  }
  if (names.length) {
    const placeholders = names.map(() => '?').join(',');
    for (const row of db.prepare(`
      SELECT DISTINCT e.* FROM brocade_device_ports dp
      JOIN brocade_enclosures e ON e.source_id = dp.source_id AND e.guid = dp.enclosure_guid
      WHERE dp.stale = 0 AND LOWER(COALESCE(dp.fdmi_host_name, '')) IN (${placeholders})
    `).all(...names)) {
      if (row.guid && !matches.has(row.guid)) matches.set(row.guid, row);
    }
  }
  if (!matches.size) return null;

  const groups = [...matches.values()].slice(0, 10).map((e) => {
    const ports = db.prepare('SELECT * FROM brocade_device_ports WHERE source_id = ? AND enclosure_guid = ? AND stale = 0').all(e.source_id, e.guid);
    const fabrics = [...new Set(ports.map((p) => p.fabric_name).filter(Boolean))];
    const zoneCount = new Set(ports.flatMap((p) => {
      try { return JSON.parse(p.active_zones || '[]'); } catch { return []; }
    })).size;
    return {
      facts: [
        { label: 'Enclosure', value: e.name || '—' },
        { label: 'Type', value: e.type || '—' },
        { label: 'Fabric(s)', value: fabrics.join(', ') || '—' },
        { label: 'Zones', value: String(zoneCount) },
      ],
      lines: ports.map((p) => `${p.wwn} → ${p.switch_name || p.switch_wwn || '—'} port ${p.switch_port_name || '—'} (${p.port_role || '—'})`),
      link: { label: e.name || e.host_name || e.guid, href: `/brocade/devices?search=${encodeURIComponent(e.name || e.host_name || '')}` },
    };
  });

  return {
    title: 'Brocade SAN',
    chip: { label: 'SAN', color: '#CC092F' },
    groups,
    link: { label: 'Open in Brocade SAN', href: `/brocade/devices?search=${encodeURIComponent([...matches.values()][0].name || '')}` },
  };
}

function server360Suggest(coreApi, q) {
  const db = coreApi.db;
  const pattern = `%${String(q || '').replace(/[%_]/g, '\\$&')}%`;
  return db.prepare(`
    SELECT DISTINCT COALESCE(host_name, name) AS n FROM brocade_enclosures
    WHERE stale = 0 AND (host_name LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\') ORDER BY n LIMIT 8
  `).all(pattern, pattern).map((r) => r.n).filter(Boolean);
}

module.exports = {
  id: 'brocade',
  name: 'Brocade SAN',
  apiVersion: 1,
  color: '#CC092F',
  migrations: brocadeMigrations,
  createRouter() {
    return brocadeRouter;
  },
  createPoller() {
    return brocadePollerHandle;
  },
  statusTables: ['brocade_sources'],
  settingsFields: [],
  navSections: ['overview', 'fabrics', 'switches', 'ports', 'devices', 'zoning', 'events', 'issues', 'trends', 'governance', 'settings'],
  datasets: [
    {
      id: 'brocade.switches',
      label: 'Brocade Switches',
      table: 'brocade_switches',
      section: 'switches',
      defaultSort: 'name',
      columns: [
        { key: 'name', label: 'Switch', type: 'string', filterable: true },
        { key: 'fabric_name', label: 'Fabric', type: 'string', filterable: true },
        { key: 'model', label: 'Model', type: 'string', filterable: true },
        { key: 'firmware_version', label: 'Firmware', type: 'string', filterable: true },
        { key: 'operational_status', label: 'Status', type: 'enum', filterable: true },
        { key: 'health', label: 'Health', type: 'enum', filterable: true },
        { key: 'max_port', label: 'Max Ports', type: 'number', aggregatable: true },
      ],
    },
    {
      id: 'brocade.fabrics',
      label: 'Brocade Fabrics',
      table: 'brocade_fabrics',
      section: 'fabrics',
      defaultSort: 'name',
      columns: [
        { key: 'name', label: 'Fabric', type: 'string', filterable: true },
        { key: 'status', label: 'Status', type: 'number', filterable: true },
        { key: 'health', label: 'Health', type: 'enum', filterable: true },
        { key: 'switch_count', label: 'Switches', type: 'number', aggregatable: true },
      ],
    },
    {
      id: 'brocade.switch_ports',
      label: 'Brocade Ports',
      table: 'brocade_switch_ports',
      section: 'ports',
      defaultSort: 'switch_name',
      columns: [
        { key: 'switch_name', label: 'Switch', type: 'string', filterable: true },
        { key: 'name', label: 'Port', type: 'string', filterable: true },
        { key: 'state', label: 'State', type: 'enum', filterable: true },
        { key: 'health', label: 'Health', type: 'enum', filterable: true },
        { key: 'speed', label: 'Speed', type: 'string' },
        { key: 'fabric_name', label: 'Fabric', type: 'string', filterable: true },
      ],
    },
    {
      id: 'brocade.events',
      label: 'Brocade Events',
      table: 'brocade_events',
      section: 'events',
      defaultSort: 'last_occurred_ms',
      columns: [
        { key: 'severity', label: 'Severity', type: 'enum', filterable: true },
        { key: 'source_name', label: 'Source', type: 'string', filterable: true },
        { key: 'description', label: 'Description', type: 'string' },
        { key: 'event_count', label: 'Count', type: 'number', aggregatable: true },
        { key: 'acknowledged', label: 'Acknowledged', type: 'boolean', filterable: true },
        { key: 'last_occurred_ms', label: 'Last Occurred', type: 'number' },
      ],
    },
    {
      id: 'brocade.metrics',
      label: 'Brocade SAN Trends',
      table: 'brocade_metrics',
      section: 'trends',
      defaultSort: 'ts',
      columns: [
        { key: 'switches_total', label: 'Switches', type: 'number', aggregatable: true },
        { key: 'ports_online', label: 'Ports Online', type: 'number', aggregatable: true },
        { key: 'events_critical_24h', label: 'Critical Events (24h)', type: 'number', aggregatable: true },
        { key: 'ts', label: 'Captured At', type: 'datetime' },
      ],
    },
  ],
  opsSummary,
  collectAlerts,
  searchCategories,
  metricsHistory: { arraysTable: 'brocade_sources', metricsTable: 'brocade_metrics', arrayIdColumn: 'source_id', tsColumn: 'ts' },
  server360,
  server360Suggest,
};
