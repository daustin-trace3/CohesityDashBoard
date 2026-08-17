// Zerto plugin manifest. Wraps the Zerto Analytics SaaS API + poller behind
// the plugin registry. Unlike Dell/pure/netapp there are no per-source
// connections — one SaaS credential covers the whole account, so the poller
// is a single global task (modeled as one fixed "source" — see poller.js).
//
// Migrations copied VERBATIM (same scope id 'zerto') so an existing local
// DB's zerto_* data (and its schema_migrations row) is adopted intact on
// install.
//
// HOOKS moved from core into this manifest (ported VERBATIM logic, db/
// getSetting now via coreApi):
//   - opsSummary        <- backend/routes/ops.js's zertoSummary()
//   - collectAlerts     <- backend/services/alertNotifier.js's
//                          collectZertoAlerts() — preserves the per-alert-type
//                          zerto_alert_catalog.enabled mute (commit bb3c1c9)
//   - searchCategories  <- backend/routes/search.js's 'zerto-vpgs',
//                          'zerto-vms', 'zerto-sites' entries
// No metricsHistory: the built-in manifest (backend/platforms/zerto/index.js)
// never declared it either — Zerto has no per-source "arrays" table to key
// metrics history off of (account-wide, not per-array). No server360/
// server360Suggest: grepped backend/services/server360*.js for 'zerto' and
// found no references.
const migrations = require('./migrations');
const { createRouter } = require('./router');
const { createZertoPoller } = require('./poller');

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

  const vpgs = one('SELECT COUNT(*) c, COALESCE(SUM(vms_count), 0) vms FROM zerto_vpgs') || {};
  const sites = count('SELECT COUNT(*) c FROM zerto_sites');
  const disconnected = countSafe("SELECT COUNT(*) c FROM zerto_sites WHERE connection_status IS NOT NULL AND connection_status != 'Connected'");
  const health = {};
  for (const r of all('SELECT health, COUNT(*) c FROM zerto_vpgs GROUP BY health')) health[String(r.health || '')] = num(r.c);
  const rpoBreach = countSafe('SELECT COUNT(*) c FROM zerto_vpgs WHERE configured_rpo > 0 AND actual_rpo > configured_rpo');
  const errAlerts = countSafe("SELECT COUNT(*) c FROM zerto_alerts WHERE severity = 'Error'");
  const exceptions = [];
  if (disconnected) exceptions.push(exception('critical', disconnected, `${fnum(disconnected)} site${disconnected === 1 ? '' : 's'} disconnected`, '/zerto/sites'));
  if (health.Error) exceptions.push(exception('critical', health.Error, `${fnum(health.Error)} VPG${health.Error === 1 ? '' : 's'} in error`, '/zerto/vpgs'));
  if (health.Warning) exceptions.push(exception('warning', health.Warning, `${fnum(health.Warning)} VPG${health.Warning === 1 ? '' : 's'} warning`, '/zerto/vpgs'));
  if (rpoBreach) exceptions.push(exception('warning', rpoBreach, `${fnum(rpoBreach)} VPG${rpoBreach === 1 ? '' : 's'} over RPO target`, '/zerto/replication'));
  if (errAlerts) exceptions.push(exception('critical', errAlerts, `${fnum(errAlerts)} open error alert${errAlerts === 1 ? '' : 's'}`, '/zerto/alerts'));
  return {
    objects: num(vpgs.c) + num(vpgs.vms) + sites,
    headline: [
      { label: 'VPGs', value: num(vpgs.c) },
      { label: 'Protected VMs', value: num(vpgs.vms) },
    ],
    exceptions,
    spark: spark7(all(
      "SELECT date(captured_at) d, MAX(alerts_count) c FROM zerto_metrics_history WHERE captured_at >= datetime('now','-7 days') GROUP BY date(captured_at)"
    )),
    sparkLabel: 'open alerts / day',
  };
}

/** Active Zerto alerts — zerto_alerts is wiped+reloaded every poll, but
 *  alert_identifier is Zerto's own stable id so it survives the reload.
 *  Per-type toggles: a code disabled in zerto_alert_catalog is muted — it
 *  drops out of the collector entirely, which also ends its reminders. */
function collectAlerts(coreApi) {
  const rows = coreApi.db.prepare(`
    SELECT alert_identifier AS alertId, severity, description, site_name AS siteName,
           collection_time AS collectionTime, captured_at AS capturedAt
    FROM zerto_alerts z
    WHERE z.alert_type IS NULL OR NOT EXISTS (
      SELECT 1 FROM zerto_alert_catalog c WHERE c.alert_type = z.alert_type AND c.enabled = 0
    )
  `).all();
  return rows.map((r) => ({
    sourceKey: `z:${r.alertId}`,
    severity: String(r.severity || '').toLowerCase(),
    host: r.siteName || 'Zerto',
    message: r.description || '',
    firstSeen: toIso(r.collectionTime || r.capturedAt),
    lastSeen: toIso(r.capturedAt),
  }));
}

const searchCategories = [
  {
    key: 'zerto-vpgs', label: 'Zerto VPGs', platform: 'zerto', perm: 'zerto:vpgs:view', base: '/zerto/vpgs',
    sql: `SELECT name AS title, (COALESCE(protected_site, '') || ' -> ' || COALESCE(recovery_site, '')) AS subtitle
          FROM zerto_vpgs WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?`,
  },
  {
    key: 'zerto-vms', label: 'Zerto VMs', platform: 'zerto', perm: 'zerto:vms:view', base: '/zerto/vms',
    sql: `SELECT name AS title, vpg_names AS subtitle FROM zerto_vms WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?`,
  },
  {
    key: 'zerto-sites', label: 'Zerto Sites', platform: 'zerto', perm: 'zerto:sites:view', base: '/zerto/sites',
    sql: `SELECT name AS title, site_type AS subtitle FROM zerto_sites WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?`,
  },
];

module.exports = {
  id: 'zerto',
  name: 'Zerto',
  apiVersion: 1,
  // No hardcoded version: the installer falls back to the packaged
  // manifest.json (sourced from plugin.json at pack time). A literal here
  // goes stale on upgrades and — because the bundle URL cache-buster is
  // ?v=<version> — makes CDNs serve the OLD frontend bundle forever.
  color: '#EE3124',
  migrations,
  createRouter(coreApi) {
    return createRouter(coreApi);
  },
  createPoller(coreApi) {
    return createZertoPoller(coreApi);
  },
  statusTables: ['zerto_sites'],
  settingsFields: [],
  navSections: ['overview', 'settings'],
  opsSummary,
  collectAlerts,
  searchCategories,
};
