// Dell (OpenManage Enterprise) plugin manifest.
//
// Migrations copied VERBATIM (same scope id 'dell') so an existing local
// DB's dell_* data (and its schema_migrations row) is adopted intact on
// install.
//
// HOOKS moved from core into this manifest (ported VERBATIM logic, db/
// getSetting now via coreApi):
//   - opsSummary        <- backend/routes/ops.js's dellSummary()
//   - collectAlerts     <- backend/services/alertNotifier.js's collectDellAlerts()
//   - searchCategories  <- backend/routes/search.js's 'dell-devices' entry
//   - metricsHistory    <- static config (dell_ome_instances/dell_metrics_history/ome_id),
//                          mirroring the dell entry pollerProcess/pollerStatus expect
// No server360/server360Suggest: grepped backend/services/server360*.js for
// 'dell' and found no references — the built-in never contributed to Server
// 360, so this plugin omits the hooks rather than inventing behavior.
const migrations = require('./migrations');
const { createRouter } = require('./router');
const { createDellPoller } = require('./poller');
const { warrantyWarnDays } = require('./issues');

function toIso(value) {
  if (value == null) return null;
  if (typeof value === 'number') return new Date(value).toISOString();
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return String(value);
}

const num = (v) => Number(v) || 0;
const fnum = (v) => Number(v).toLocaleString('en-US');
const exception = (severity, cnt, text, link) => ({ severity, count: cnt, text, link });

// Align [{d:'YYYY-MM-DD', c}] rows to a dense last-7-days array (ops.js's spark7).
function spark7(rows) {
  const map = new Map(rows.map((r) => [r.d, num(r.c)]));
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    out.push(map.get(d) || 0);
  }
  return out;
}

function opsSummary(coreApi) {
  const db = coreApi.db;
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const count = (sql, ...args) => num(one(sql, ...args)?.c);
  const countSafe = (sql, ...args) => { try { return count(sql, ...args); } catch { return 0; } };

  const omes = count('SELECT COUNT(*) c FROM dell_ome_instances');
  if (!omes) return null;
  const omesErr = countSafe("SELECT COUNT(*) c FROM dell_ome_instances WHERE last_poll_status = 'error'");
  const devices = count('SELECT COUNT(*) c FROM dell_devices');
  const components = countSafe('SELECT COUNT(*) c FROM dell_components');
  const health = {};
  for (const r of all('SELECT health, COUNT(*) c FROM dell_devices GROUP BY health')) health[String(r.health || '')] = num(r.c);
  const disconnected = countSafe('SELECT COUNT(*) c FROM dell_devices WHERE connection_state = 0');
  const warnDays = warrantyWarnDays(coreApi);
  // A tag is judged by its best (most current) agreement.
  const expired = countSafe('SELECT COUNT(*) c FROM (SELECT MAX(days_remaining) best FROM dell_warranties GROUP BY ome_id, service_tag) WHERE best <= 0');
  const expiring = countSafe('SELECT COUNT(*) c FROM (SELECT MAX(days_remaining) best FROM dell_warranties GROUP BY ome_id, service_tag) WHERE best > 0 AND best <= ?', warnDays);
  const exceptions = [];
  if (omesErr) exceptions.push(exception('critical', omesErr, `${fnum(omesErr)} OME instance${omesErr === 1 ? '' : 's'} unreachable`, '/dell'));
  if (health.critical) exceptions.push(exception('critical', health.critical, `${fnum(health.critical)} device${health.critical === 1 ? '' : 's'} critical`, '/dell/hardware'));
  if (health.warning) exceptions.push(exception('warning', health.warning, `${fnum(health.warning)} device${health.warning === 1 ? '' : 's'} degraded`, '/dell/hardware'));
  if (disconnected) exceptions.push(exception('warning', disconnected, `${fnum(disconnected)} device${disconnected === 1 ? '' : 's'} disconnected`, '/dell/hardware'));
  if (expired) exceptions.push(exception('warning', expired, `${fnum(expired)} service tag${expired === 1 ? '' : 's'} out of support`, '/dell/support'));
  if (expiring) exceptions.push(exception('warning', expiring, `${fnum(expiring)} warrant${expiring === 1 ? 'y expires' : 'ies expire'} ≤ ${warnDays}d`, '/dell/support'));
  return {
    objects: omes + devices + components,
    headline: [
      { label: 'Servers', value: devices },
      { label: 'Components', value: components },
    ],
    exceptions,
    spark: spark7(all(
      "SELECT date(created_at) d, COUNT(*) c FROM dell_alerts WHERE severity IN ('critical','warning') AND created_at >= datetime('now','-7 days') GROUP BY date(created_at)"
    )),
    sparkLabel: 'crit/warn alerts / day',
  };
}

/** Un-acknowledged Dell OME alerts. dell_alerts is append-only (90-day
 *  retention) — acknowledging the alert in OME is what stops reminders. */
function collectAlerts(coreApi) {
  const rows = coreApi.db.prepare(`
    SELECT d.ome_id AS omeId, d.alert_id AS alertId, d.severity, d.message,
           d.device_name AS deviceName, d.service_tag AS serviceTag,
           d.created_at AS createdAt, d.captured_at AS capturedAt, o.name AS omeName
    FROM dell_alerts d JOIN dell_ome_instances o ON d.ome_id = o.id
    WHERE d.status IS NULL OR d.status != 'acknowledged'
  `).all();
  return rows.map((r) => {
    let severity = String(r.severity || '').toLowerCase();
    if (severity === 'normal') severity = 'info';
    return {
      sourceKey: `d${r.omeId}:${r.alertId}`,
      severity,
      host: r.deviceName ? `${r.deviceName}${r.serviceTag ? ` (${r.serviceTag})` : ''}` : r.omeName,
      message: r.message || '',
      firstSeen: toIso(r.createdAt || r.capturedAt),
      lastSeen: toIso(r.capturedAt),
    };
  });
}

const searchCategories = [
  {
    key: 'dell-devices', label: 'Dell Devices', platform: 'dell', perm: 'dell:devices:view', base: '/dell/devices',
    sql: `SELECT name AS title, (COALESCE(service_tag, '') || ' · ' || COALESCE(model, '')) AS subtitle
          FROM dell_devices WHERE name LIKE ? ESCAPE '\\' OR service_tag LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?`,
    params: 2,
  },
];

module.exports = {
  id: 'dell',
  name: 'Dell (OpenManage Enterprise)',
  apiVersion: 1,
  color: '#007DB8',
  // No hardcoded version: the installer falls back to the packaged
  // manifest.json (sourced from plugin.json at pack time). A literal here
  // goes stale on upgrades and — because the bundle URL cache-buster is
  // ?v=<version> — makes CDNs serve the OLD frontend bundle forever.
  migrations,
  createRouter(coreApi) {
    return createRouter(coreApi);
  },
  createPoller(coreApi) {
    return createDellPoller(coreApi);
  },
  statusTables: ['dell_ome_instances'],
  settingsFields: [],
  navSections: ['overview', 'devices', 'alerts', 'governance', 'settings'],
  opsSummary,
  collectAlerts,
  searchCategories,
  metricsHistory: { arraysTable: 'dell_ome_instances', metricsTable: 'dell_metrics_history', arrayIdColumn: 'ome_id' },
};
