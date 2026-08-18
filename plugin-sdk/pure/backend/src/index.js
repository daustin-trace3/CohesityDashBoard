// Pure Storage plugin manifest.
//
// Migrations copied VERBATIM (same scope id 'pure') so an existing local
// DB's pure_*/pure1_* data (and its schema_migrations row) is adopted intact
// on install.
//
// HOOKS moved from core into this manifest (ported VERBATIM logic, db/
// settings now via coreApi):
//   - opsSummary        <- backend/routes/ops.js's pureSummary() (async —
//                          registry.getOpsSummaryProviders()'s run() is
//                          awaited by ops.js, so this stays async here too)
//   - collectAlerts     <- backend/services/alertNotifier.js's collectPureAlerts()
//   - searchCategories  <- backend/routes/search.js's 'pure-arrays' entry
//                          (UNION query across pure1_arrays + pure_arrays, params: 2)
//   - metricsHistory    <- static config (pure_arrays/pure_metrics_history/array_id),
//                          mirroring the pure entry pollerProcess/pollerStatus expect
// No server360/server360Suggest: grepped backend/routes/server360.js for
// 'pure' and found no references — the built-in never contributed to Server
// 360, so this plugin omits the hooks rather than inventing behavior.
const migrations = require('./migrations');
const { createRouter } = require('./router');
const { createPurePoller } = require('./poller');

const num = (v) => Number(v) || 0;
const fnum = (v) => Number(v).toLocaleString('en-US');
const exception = (severity, cnt, text, link) => ({ severity, count: cnt, text, link });

async function opsSummary(coreApi) {
  // The Pure platform's primary source is the Pure1 SaaS fleet (cached in
  // pure1Api per its TTL — no extra cloud calls per page load); the direct
  // pure_* tables only cover locally registered arrays and are the fallback.
  const pure1Api = require('./pure1Api');
  const db = coreApi.db;
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const count = (sql, ...args) => num(one(sql, ...args)?.c);
  const countSafe = (sql, ...args) => { try { return count(sql, ...args); } catch { return 0; } };

  const directArrays = count('SELECT COUNT(*) c FROM pure_arrays');
  const volumes = countSafe('SELECT COUNT(*) c FROM pure_volumes');
  const hosts = countSafe('SELECT COUNT(*) c FROM pure_hosts');
  const exceptions = [];
  let arrays = directArrays;
  let headline = null;
  if (pure1Api.isConfigured(coreApi)) {
    try {
      const [fleet, alerts] = await Promise.all([pure1Api.getOverview(coreApi), pure1Api.getAlerts(coreApi)]);
      arrays = Math.max(fleet.length, directArrays);
      const sev = { critical: 0, warning: 0 };
      for (const a of alerts || []) {
        const s = String(a.severity || '').toLowerCase();
        if (s === 'critical') sev.critical += 1;
        else if (s === 'warning') sev.warning += 1;
      }
      if (sev.critical) exceptions.push(exception('critical', sev.critical, `${fnum(sev.critical)} critical alert${sev.critical === 1 ? '' : 's'}`, '/pure/alerts'));
      if (sev.warning) exceptions.push(exception('warning', sev.warning, `${fnum(sev.warning)} open warning${sev.warning === 1 ? '' : 's'}`, '/pure/alerts'));
      const now = Date.now();
      const notReporting = fleet.filter((a) => !a.capturedAt || (now - a.capturedAt) > 3 * 86400000).length;
      if (notReporting) exceptions.push(exception('warning', notReporting, `${fnum(notReporting)} array${notReporting === 1 ? '' : 's'} not reporting to Pure1`, '/pure'));
      const nearFull = fleet.filter((a) => a.pctUsed != null && a.pctUsed >= 90).length;
      if (nearFull) exceptions.push(exception('warning', nearFull, `${fnum(nearFull)} array${nearFull === 1 ? '' : 's'} ≥ 90% used`, '/pure/capacity'));
      const total = fleet.reduce((s, a) => s + (a.total || 0), 0);
      const used = fleet.reduce((s, a) => s + (a.used || 0), 0);
      headline = [
        { label: 'Arrays', value: arrays },
        { label: 'Capacity Used', value: total > 0 ? `${Math.round((used / total) * 100)}%` : '—' },
      ];
    } catch { /* Pure1 unreachable — fall back to the direct tables below */ }
  }
  if (!headline) {
    const sev = {};
    for (const r of all("SELECT severity, COUNT(*) c FROM pure_alerts WHERE state IS NULL OR state = 'open' GROUP BY severity")) {
      sev[String(r.severity || '').toLowerCase()] = num(r.c);
    }
    if (sev.critical) exceptions.push(exception('critical', sev.critical, `${fnum(sev.critical)} critical alert${sev.critical === 1 ? '' : 's'}`, '/pure/alerts'));
    if (sev.warning) exceptions.push(exception('warning', sev.warning, `${fnum(sev.warning)} open warning${sev.warning === 1 ? '' : 's'}`, '/pure/alerts'));
    headline = [
      { label: 'Arrays', value: directArrays },
      { label: 'Volumes', value: volumes },
    ];
  }
  return {
    objects: arrays + volumes + hosts,
    headline,
    exceptions,
    spark: null,
  };
}

/** Active Pure alerts — pure_alerts only holds open alerts (poller deletes closed ones). */
function collectAlerts(coreApi) {
  const rows = coreApi.db.prepare(`
    SELECT p.pure_alert_id AS alertId, p.array_id AS arrayId, p.severity AS severity,
           p.summary AS summary, p.created_at_ms AS createdAtMs, p.updated_at_ms AS updatedAtMs,
           a.name AS arrayName
    FROM pure_alerts p JOIN pure_arrays a ON p.array_id = a.id
  `).all();
  const toIso = (ms) => (ms == null ? null : new Date(Number(ms)).toISOString());
  return rows
    .filter((r) => String(r.severity || '').toLowerCase() !== 'hidden')
    .map((r) => ({
      sourceKey: `a${r.arrayId}:${r.alertId}`,
      severity: String(r.severity || '').toLowerCase(),
      host: r.arrayName,
      message: r.summary || '',
      firstSeen: toIso(r.createdAtMs),
      lastSeen: toIso(r.updatedAtMs),
    }));
}

const searchCategories = [
  {
    key: 'pure-arrays', label: 'Pure Arrays', platform: 'pure', perm: 'pure:overview:view', base: '/pure',
    sql: `SELECT name AS title, model AS subtitle FROM pure1_arrays WHERE name LIKE ? ESCAPE '\\'
          UNION SELECT name AS title, mgmt_host AS subtitle FROM pure_arrays WHERE name LIKE ? ESCAPE '\\'
          ORDER BY title LIMIT ?`,
    params: 2,
  },
];

module.exports = {
  id: 'pure',
  name: 'Pure Storage',
  apiVersion: 1,
  color: '#FF6B00',
  // No hardcoded version: the installer falls back to the packaged
  // manifest.json (sourced from plugin.json at pack time). A literal here
  // goes stale on upgrades and — because the bundle URL cache-buster is
  // ?v=<version> — makes CDNs serve the OLD frontend bundle forever.
  migrations,
  createRouter(coreApi) {
    return createRouter(coreApi);
  },
  createPoller(coreApi) {
    return createPurePoller(coreApi);
  },
  statusTables: ['pure_arrays'],
  settingsFields: [],
  navSections: ['overview', 'arrays', 'settings'],
  opsSummary,
  collectAlerts,
  searchCategories,
  metricsHistory: { arraysTable: 'pure_arrays', metricsTable: 'pure_metrics_history', arrayIdColumn: 'array_id' },
};
