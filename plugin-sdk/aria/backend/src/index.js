// VMware Aria Automation plugin manifest.
//
// Migrations copied VERBATIM (same scope id 'aria') so an existing local
// DB's aria_* data (and its schema_migrations row) is adopted intact on
// install.
//
// HOOKS moved from core into this manifest (ported VERBATIM logic, db/
// getSetting now via coreApi):
//   - opsSummary        <- backend/routes/ops.js's ariaSummary()
//   - collectAlerts     <- backend/services/alertNotifier.js's collectAriaIssues()
//   - searchCategories  <- backend/routes/search.js's 'aria-deployments' entry
//   - metricsHistory    <- static config (aria_instances/aria_metrics_history/instance_id),
//                          mirroring the aria entry pollerProcess/pollerStatus expect
// No server360/server360Suggest: grepped backend/services/server360*.js for
// 'aria' and found no references — the built-in never contributed to Server
// 360, so this plugin omits the hooks rather than inventing behavior.
const migrations = require('./migrations');
const { createRouter } = require('./router');
const { createAriaPoller } = require('./poller');

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

  const instances = count('SELECT COUNT(*) c FROM aria_instances');
  if (!instances) return null;
  const instErr = countSafe("SELECT COUNT(*) c FROM aria_instances WHERE last_poll_status = 'error'");
  const deployments = countSafe('SELECT COUNT(*) c FROM aria_deployments');
  const deploymentsFail = countSafe("SELECT COUNT(*) c FROM aria_deployments WHERE status LIKE '%FAIL%'");
  const leaseExpiring = countSafe("SELECT COUNT(*) c FROM aria_deployments WHERE lease_expire_at IS NOT NULL AND julianday(lease_expire_at) - julianday('now') <= 7");
  const endpoints = countSafe('SELECT COUNT(*) c FROM aria_endpoints');
  const endpointsUnhealthy = countSafe(
    "SELECT COUNT(*) c FROM aria_endpoints WHERE health_state IS NOT NULL AND LOWER(health_state) NOT IN ('ok','up','healthy','connected','active','available')"
  );
  const requests24h = countSafe("SELECT COUNT(*) c FROM aria_requests WHERE captured_at >= datetime('now','-1 day')");
  const exceptions = [];
  if (instErr) exceptions.push(exception('critical', instErr, `${fnum(instErr)} instance${instErr === 1 ? '' : 's'} unreachable`, '/aria'));
  if (endpointsUnhealthy) exceptions.push(exception('critical', endpointsUnhealthy, `${fnum(endpointsUnhealthy)} endpoint${endpointsUnhealthy === 1 ? '' : 's'} unhealthy`, '/aria/infrastructure'));
  if (deploymentsFail) exceptions.push(exception('warning', deploymentsFail, `${fnum(deploymentsFail)} deployment${deploymentsFail === 1 ? '' : 's'} failed`, '/aria/deployments'));
  if (leaseExpiring) exceptions.push(exception('warning', leaseExpiring, `${fnum(leaseExpiring)} lease${leaseExpiring === 1 ? '' : 's'} expiring ≤ 7d`, '/aria/deployments'));
  return {
    objects: instances + deployments + endpoints,
    headline: [
      { label: 'Deployments', value: deployments },
      { label: 'Requests 24h', value: requests24h },
    ],
    exceptions,
    spark: spark7(all(
      "SELECT date(captured_at) d, COUNT(*) c FROM aria_requests WHERE status LIKE '%FAIL%' AND captured_at >= datetime('now','-7 days') GROUP BY date(captured_at)"
    )),
    sparkLabel: 'failed requests / day',
  };
}

/** Open Aria computed issues — reconcileIssueHistory keeps aria_issue_history
 *  current with a stable issue_key per issue, and resolving drops the row
 *  out of this query (which is what ends reminders). */
function collectAlerts(coreApi) {
  const rows = coreApi.db.prepare(`
    SELECT issue_key AS issueKey, instance, severity, message,
           first_seen AS firstSeen, last_seen AS lastSeen
    FROM aria_issue_history WHERE status = 'open'
  `).all();
  return rows.map((r) => ({
    sourceKey: `ar:${r.issueKey}`,
    severity: String(r.severity || '').toLowerCase(),
    host: r.instance,
    message: r.message || '',
    firstSeen: toIso(r.firstSeen),
    lastSeen: toIso(r.lastSeen),
  }));
}

const searchCategories = [
  {
    key: 'aria-deployments', label: 'Aria Deployments', platform: 'aria', perm: 'aria:deployments:view', base: '/aria/deployments',
    sql: `SELECT name AS title, (COALESCE(project_name, '') || ' · ' || COALESCE(status, '')) AS subtitle
          FROM aria_deployments WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?`,
  },
];

module.exports = {
  id: 'aria',
  name: 'VMware Aria Automation',
  apiVersion: 1,
  color: '#00A2C7',
  // No hardcoded version: the installer falls back to the packaged
  // manifest.json (sourced from plugin.json at pack time). A literal here
  // goes stale on upgrades and — because the bundle URL cache-buster is
  // ?v=<version> — makes CDNs serve the OLD frontend bundle forever.
  migrations,
  createRouter(coreApi) {
    return createRouter(coreApi);
  },
  createPoller(coreApi) {
    return createAriaPoller(coreApi);
  },
  statusTables: ['aria_instances'],
  settingsFields: [],
  navSections: ['overview', 'deployments', 'activity', 'infrastructure', 'extensibility', 'approvals', 'settings'],
  opsSummary,
  collectAlerts,
  searchCategories,
  metricsHistory: { arraysTable: 'aria_instances', metricsTable: 'aria_metrics_history', arrayIdColumn: 'instance_id' },
};
