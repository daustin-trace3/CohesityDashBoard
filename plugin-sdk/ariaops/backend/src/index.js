// Aria Operations (vROps) plugin manifest.
//
// Migrations copied VERBATIM (same scope id 'ariaops') so an existing local
// DB's ariaops_* data (and its schema_migrations row) is adopted intact on
// install.
//
// HOOKS: searchCategories <- backend/routes/search.js's 'ariaops-resources'
// entry (ported verbatim) and metricsHistory <- static config
// (ariaops_instances/ariaops_metrics_history/instance_id), mirroring the
// dell entry pollerProcess/pollerStatus expect and verified against this
// plugin's own migrations.js/poller.js.
//
// NO opsSummary/collectAlerts: grepped backend/routes/ops.js and
// backend/services/alertNotifier.js for 'ariaops' — the only summarizer and
// issue-collector hits are 'aria' (Aria Automation, a separate platform with
// its own aria_* tables). The built-in ariaops platform never contributed an
// ops-summary card or an alert-email collector, so this plugin omits those
// hooks rather than inventing behavior.
//
// NO server360/server360Suggest: grepped backend/services/server360*.js for
// 'ariaops' and found no references.
const migrations = require('./migrations');
const { createRouter } = require('./router');
const { createAriaOpsPoller } = require('./poller');

const searchCategories = [
  {
    key: 'ariaops-resources', label: 'Aria Ops Resources', platform: 'ariaops', perm: 'ariaops:resources:view', base: '/ariaops/resources',
    sql: `SELECT name AS title, (COALESCE(kind, '') || ' · ' || COALESCE(health, '')) AS subtitle
          FROM ariaops_resources WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?`,
  },
];

module.exports = {
  id: 'ariaops',
  name: 'Aria Operations',
  apiVersion: 1,
  color: '#78BE20',
  // No hardcoded version: the installer falls back to the packaged
  // manifest.json (sourced from plugin.json at pack time). A literal here
  // goes stale on upgrades and — because the bundle URL cache-buster is
  // ?v=<version> — makes CDNs serve the OLD frontend bundle forever.
  migrations,
  createRouter(coreApi) {
    return createRouter(coreApi);
  },
  createPoller(coreApi) {
    return createAriaOpsPoller(coreApi);
  },
  statusTables: ['ariaops_instances'],
  settingsFields: [],
  navSections: ['overview', 'resources', 'alerts', 'settings'],
  searchCategories,
  metricsHistory: { arraysTable: 'ariaops_instances', metricsTable: 'ariaops_metrics_history', arrayIdColumn: 'instance_id' },
};
