// Veritas NetBackup plugin manifest (ICC contract C1). Direct-connection
// model like vCenter/Aria: registered primary servers or Alta SaaS tenants in
// netbackup_sources (plus a second connection type, netbackup_appliance_conns,
// for 52xx/53xx hardware monitoring), one framework poller task per source.
//
// Ported from backend/platforms/netbackup/index.js + the netbackup blocks in
// backend/routes/ops.js, backend/services/alertNotifier.js,
// backend/routes/search.js, backend/routes/server360.js. Migrations copied
// VERBATIM from backend/db/migrations/netbackup.js so an existing local DB's
// netbackup_* data (and schema_migrations rows) is adopted intact on install.
const { migrations } = require('./migrations');
const { createRouter } = require('./routes');
const { createNetbackupPoller } = require('./poller');
const { opsSummary } = require('./ops');
const { collectAlerts } = require('./alerts');
const { searchCategories } = require('./search');
const { server360, server360Suggest } = require('./server360');

module.exports = {
  id: 'netbackup',
  name: 'Veritas NetBackup',
  apiVersion: 1,
  color: '#B1181E',
  migrations,
  createRouter,
  createPoller(coreApi) {
    return createNetbackupPoller(coreApi);
  },
  statusTables: ['netbackup_sources', 'netbackup_appliance_conns'],
  navSections: [
    'overview', 'advisor', 'alerts', 'jobs', 'policies', 'slps', 'governance',
    'backup-history', 'workloads', 'licensing', 'storage', 'appliances', 'privacy', 'settings',
  ],
  // Phase-1 manifest-driven core hooks (2026-08-03 contract): ops landing
  // page card, alert-email collector, global search categories, poller
  // status metrics-history section, and Server 360 backup-posture section.
  opsSummary,
  collectAlerts,
  searchCategories,
  metricsHistory: { arraysTable: 'netbackup_sources', metricsTable: 'netbackup_metrics_history', arrayIdColumn: 'source_id' },
  server360,
  server360Suggest,
};
