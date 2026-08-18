// NetApp ONTAP plugin manifest.
//
// Migrations copied VERBATIM (same scope id 'netapp') so an existing local
// DB's netapp_* data (and its schema_migrations row) is adopted intact on
// install.
//
// HOOKS moved from core into this manifest (ported VERBATIM logic, db/
// settings now via coreApi):
//   - opsSummary        <- backend/routes/ops.js's netappSummary()
//   - collectAlerts     <- backend/services/alertNotifier.js's collectNetappAlerts()
//   - searchCategories  <- backend/routes/search.js's 'netapp-volumes' + 'netapp-shares' entries
//   - metricsHistory    <- static config (netapp_arrays/netapp_metrics_history/array_id),
//                          mirroring the netapp entry pollerProcess/pollerStatus expect
// No server360/server360Suggest hook: backend/services/pollerStatus.js's
// server360 lookup reads netapp_volumes/netapp_nfs_clients/netapp_cifs_sessions
// directly by table (cross-platform table-consumer pattern) — the built-in
// never declared a server360 manifest hook, so this plugin doesn't invent one.
const crypto = require('crypto');
const migrations = require('./migrations');
const { createRouter } = require('./router');
const { createNetappPoller } = require('./poller');

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

function opsSummary(coreApi) {
  const db = coreApi.db;
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const count = (sql, ...args) => num(one(sql, ...args)?.c);
  const countSafe = (sql, ...args) => { try { return count(sql, ...args); } catch { return 0; } };

  const arrays = count('SELECT COUNT(*) c FROM netapp_arrays');
  if (!arrays) return null;
  const volumes = countSafe('SELECT COUNT(*) c FROM netapp_volumes');
  const aggregates = countSafe('SELECT COUNT(*) c FROM netapp_aggregates');
  const sev = { crit: 0, warn: 0 };
  for (const r of all('SELECT severity, COUNT(*) c FROM netapp_alerts GROUP BY severity')) {
    const s = String(r.severity || '').toLowerCase();
    if (['emergency', 'alert', 'critical'].includes(s)) sev.crit += num(r.c);
    else if (['error', 'warning'].includes(s)) sev.warn += num(r.c);
  }
  const fullAggr = countSafe('SELECT COUNT(*) c FROM netapp_aggregates WHERE used_percent >= 90');
  const exceptions = [];
  if (sev.crit) exceptions.push(exception('critical', sev.crit, `${fnum(sev.crit)} critical alert${sev.crit === 1 ? '' : 's'}`, '/netapp/alerts'));
  if (sev.warn) exceptions.push(exception('warning', sev.warn, `${fnum(sev.warn)} warning alert${sev.warn === 1 ? '' : 's'}`, '/netapp/alerts'));
  if (fullAggr) exceptions.push(exception('warning', fullAggr, `${fnum(fullAggr)} aggregate${fullAggr === 1 ? '' : 's'} ≥ 90% used`, '/netapp/capacity'));
  return {
    objects: arrays + volumes + aggregates,
    headline: [
      { label: 'Clusters', value: arrays },
      { label: 'Volumes', value: volumes },
    ],
    exceptions,
    spark: null,
  };
}

/** Active NetApp alerts — netapp_alerts is wiped+reloaded every poll, so the
 *  sourceKey must be content-stable (index-based alert_key is not enough). */
function collectAlerts(coreApi) {
  const db = coreApi.db;
  const rows = db.prepare(`
    SELECT n.id AS rowId, n.array_id AS arrayId, n.alert_key AS alertKey, n.severity AS severity,
           n.node_name AS nodeName, n.message AS message, n.captured_at AS capturedAt,
           a.name AS arrayName
    FROM netapp_alerts n JOIN netapp_arrays a ON n.array_id = a.id
  `).all();
  return rows.map((r) => {
    const messageHash = crypto.createHash('sha256').update(r.message || '').digest('hex').slice(0, 12);
    let severity = String(r.severity || '').toLowerCase();
    if (severity === 'information') severity = 'info';
    return {
      sourceKey: `a${r.arrayId}:${r.alertKey}:${messageHash}`,
      severity,
      host: r.nodeName ? `${r.arrayName} (${r.nodeName})` : r.arrayName,
      message: r.message || '',
      firstSeen: toIso(r.capturedAt),
      lastSeen: toIso(r.capturedAt),
    };
  });
}

const searchCategories = [
  {
    key: 'netapp-volumes', label: 'NetApp Volumes', platform: 'netapp', perm: 'netapp:volumes:view', base: '/netapp/volumes',
    sql: `SELECT v.name AS title, (COALESCE(v.svm_name, '') || ' · ' || a.name) AS subtitle
          FROM netapp_volumes v JOIN netapp_arrays a ON a.id = v.array_id
          WHERE v.name LIKE ? ESCAPE '\\' ORDER BY v.name LIMIT ?`,
    params: 2,
  },
  {
    key: 'netapp-shares', label: 'CIFS Shares', platform: 'netapp', perm: 'netapp:cifs:view', base: '/netapp/cifs',
    sql: `SELECT share_name AS title, (COALESCE(svm_name, '') || ' · ' || COALESCE(volume_name, '')) AS subtitle
          FROM netapp_cifs_shares WHERE share_name LIKE ? ESCAPE '\\' ORDER BY share_name LIMIT ?`,
    params: 2,
  },
];

module.exports = {
  id: 'netapp',
  name: 'NetApp ONTAP',
  apiVersion: 1,
  color: '#0067C5',
  // No hardcoded version: the installer falls back to the packaged
  // manifest.json (sourced from plugin.json at pack time). A literal here
  // goes stale on upgrades and — because the bundle URL cache-buster is
  // ?v=<version> — makes CDNs serve the OLD frontend bundle forever.
  migrations,
  createRouter(coreApi) {
    return createRouter(coreApi);
  },
  createPoller(coreApi) {
    return createNetappPoller(coreApi);
  },
  statusTables: ['netapp_arrays'],
  settingsFields: [],
  navSections: ['overview', 'arrays', 'settings'],
  opsSummary,
  collectAlerts,
  searchCategories,
  metricsHistory: { arraysTable: 'netapp_arrays', metricsTable: 'netapp_metrics_history', arrayIdColumn: 'array_id' },
};
