// Veritas NetBackup platform manifest (ICC contract C1). Direct-connection
// model like vCenter/Aria: registered primary servers or Alta SaaS tenants in
// netbackup_sources, one framework poller task per source.
const netbackupMigrations = require('../../db/migrations/netbackup');
const netbackupRouter = require('../../routes/netbackup');
const { netbackupPoller, initNetbackupPoller } = require('../../services/netbackupPoller');

module.exports = {
  id: 'netbackup',
  name: 'Veritas NetBackup',
  apiVersion: 1,
  migrations: netbackupMigrations,
  createRouter() {
    return netbackupRouter;
  },
  createPoller() {
    return {
      ...netbackupPoller,
      init: () => initNetbackupPoller(),
    };
  },
  statusTables: ['netbackup_sources'],
  settingsFields: [],
  navSections: [
    'overview', 'advisor', 'alerts', 'jobs', 'policies', 'slps', 'governance',
    'backup-history', 'workloads', 'licensing', 'storage', 'appliances', 'privacy', 'settings',
  ],
};
