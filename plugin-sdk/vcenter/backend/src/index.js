// vCenter platform manifest.
//
// Migrations copied VERBATIM (same scope id 'vcenter') so an existing local
// DB's vcenter_* data (and its schema_migrations row) is adopted intact on
// install.
//
// HOOKS moved from core into this manifest (ported VERBATIM logic, db/
// getSetting now via coreApi):
//   - opsSummary        <- backend/routes/ops.js's vcenterSummary()
//   - collectAlerts     <- backend/services/alertNotifier.js's
//                          collectVcenterIssues() (vcenter has no per-alert
//                          table like dell_alerts — its "alerts" ARE the
//                          computed-issue lifecycle in vcenter_issue_history,
//                          same source the Alerts page and issue-history
//                          endpoint read)
//   - searchCategories  <- backend/routes/search.js's 'vcenter-vms',
//                          'vcenter-hosts', 'vcenter-datastores' entries (ALL
//                          three ported)
//   - metricsHistory    <- static config (vcenter_vcenters/
//                          vcenter_metrics_history/vcenter_id), mirroring the
//                          vcenter entry pollerProcess/pollerStatus expect
// No server360/server360Suggest: grepped backend/services/server360*.js for
// 'vcenter' and found no manifest-hook references — core's routes/
// server360.js queries vcenter_* tables directly (tables are the interface),
// so this plugin does not invent hooks the built-in manifest never declared.
const migrations = require('./migrations');
const { createRouter } = require('./router');
const { createVcenterPoller } = require('./poller');

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

  const vcs = count('SELECT COUNT(*) c FROM vcenter_vcenters');
  if (!vcs) return null;
  const vcErr = countSafe("SELECT COUNT(*) c FROM vcenter_vcenters WHERE last_poll_status = 'error'");
  const hosts = count('SELECT COUNT(*) c FROM vcenter_hosts');
  const hostsDisc = countSafe("SELECT COUNT(*) c FROM vcenter_hosts WHERE connection_state IS NOT NULL AND connection_state != 'CONNECTED'");
  const vms = count('SELECT COUNT(*) c FROM vcenter_vms');
  const datastores = countSafe('SELECT COUNT(*) c FROM vcenter_datastores');
  const dsDown = countSafe('SELECT COUNT(*) c FROM vcenter_datastores WHERE accessible = 0');
  const dsLow = countSafe('SELECT COUNT(*) c FROM vcenter_datastores WHERE accessible != 0 AND capacity_bytes > 0 AND CAST(free_bytes AS REAL) / capacity_bytes < 0.10');
  const exceptions = [];
  if (vcErr) exceptions.push(exception('critical', vcErr, `${fnum(vcErr)} vCenter${vcErr === 1 ? '' : 's'} unreachable`, '/vcenter'));
  if (hostsDisc) exceptions.push(exception('critical', hostsDisc, `${fnum(hostsDisc)} host${hostsDisc === 1 ? '' : 's'} disconnected`, '/vcenter/hosts'));
  if (dsDown) exceptions.push(exception('critical', dsDown, `${fnum(dsDown)} datastore${dsDown === 1 ? '' : 's'} inaccessible`, '/vcenter/datastores'));
  if (dsLow) exceptions.push(exception('warning', dsLow, `${fnum(dsLow)} datastore${dsLow === 1 ? '' : 's'} < 10% free`, '/vcenter/datastores'));
  return {
    objects: vcs + hosts + vms + datastores,
    headline: [
      { label: 'ESXi hosts', value: hosts },
      { label: 'VMs', value: vms },
    ],
    exceptions,
    spark: spark7(all(
      "SELECT date(created_at) d, COUNT(*) c FROM vcenter_events WHERE severity IN ('error','warning') AND created_at >= datetime('now','-7 days') GROUP BY date(created_at)"
    )),
    sparkLabel: 'error/warning events / day',
  };
}

/** Open vCenter computed issues — reconcileIssueHistory (issues.js) keeps
 *  vcenter_issue_history current with a stable issue_key per issue, and
 *  resolving drops the row out of this query (which is what ends reminders). */
function collectAlerts(coreApi) {
  const rows = coreApi.db.prepare(`
    SELECT issue_key AS issueKey, vcenter, severity, message,
           first_seen AS firstSeen, last_seen AS lastSeen
    FROM vcenter_issue_history WHERE status = 'open'
  `).all();
  return rows.map((r) => ({
    sourceKey: `v:${r.issueKey}`,
    severity: String(r.severity || '').toLowerCase(),
    host: r.vcenter,
    message: r.message || '',
    firstSeen: toIso(r.firstSeen),
    lastSeen: toIso(r.lastSeen),
  }));
}

const escLike = '\\';
const searchCategories = [
  {
    key: 'vcenter-vms', label: 'vCenter VMs', platform: 'vcenter', perm: 'vcenter:vms:view', base: '/vcenter/inventory',
    sql: `SELECT m.name AS title, (COALESCE(m.cluster_name, '') || ' · ' || v.name) AS subtitle
          FROM vcenter_vms m JOIN vcenter_vcenters v ON v.id = m.vcenter_id
          WHERE m.name LIKE ? ESCAPE '${escLike}' ORDER BY m.name LIMIT ?`,
    params: 2,
  },
  {
    key: 'vcenter-hosts', label: 'ESX Hosts', platform: 'vcenter', perm: 'vcenter:hosts:view', base: '/vcenter/hosts',
    sql: `SELECT name AS title, cluster_name AS subtitle FROM vcenter_hosts WHERE name LIKE ? ESCAPE '${escLike}' ORDER BY name LIMIT ?`,
    params: 2,
  },
  {
    key: 'vcenter-datastores', label: 'Datastores', platform: 'vcenter', perm: 'vcenter:datastores:view', base: '/vcenter/datastores',
    sql: `SELECT name AS title, ds_type AS subtitle FROM vcenter_datastores WHERE name LIKE ? ESCAPE '${escLike}' ORDER BY name LIMIT ?`,
    params: 2,
  },
];

module.exports = {
  id: 'vcenter',
  name: 'VMware vCenter',
  apiVersion: 1,
  color: '#0091DA',
  // No hardcoded version: the installer falls back to the packaged
  // manifest.json (sourced from plugin.json at pack time). A literal here
  // goes stale on upgrades and — because the bundle URL cache-buster is
  // ?v=<version> — makes CDNs serve the OLD frontend bundle forever.
  migrations,
  createRouter(coreApi) {
    return createRouter(coreApi);
  },
  createPoller(coreApi) {
    return createVcenterPoller(coreApi);
  },
  statusTables: ['vcenter_vcenters'],
  settingsFields: [],
  navSections: ['overview', 'hosts', 'datastores', 'settings'],
  opsSummary,
  collectAlerts,
  searchCategories,
  metricsHistory: { arraysTable: 'vcenter_vcenters', metricsTable: 'vcenter_metrics_history', arrayIdColumn: 'vcenter_id' },
};
