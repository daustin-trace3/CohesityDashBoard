// Zerto platform manifest (ICC contract C1). Wraps routes/zerto.js and the
// account-global zertoPoller behind the plugin registry. Unlike pure/netapp
// there are no per-source connections — one SaaS credential covers the whole
// account, so the poller is a single global task.
const zertoMigrations = require('../../db/migrations/zerto');
const zertoRouter = require('../../routes/zerto');
const { initZertoPoller, zertoTask, stopAll } = require('../../services/zertoPoller');

module.exports = {
  id: 'zerto',
  name: 'Zerto',
  apiVersion: 1,
  migrations: zertoMigrations,
  createRouter() {
    return zertoRouter;
  },
  createPoller() {
    return {
      init: () => initZertoPoller(),
      trigger: () => zertoTask.trigger(),
      stopAll,
      taskCount: () => (zertoTask.isRunning() ? 1 : 0),
    };
  },
  statusTables: ['zerto_sites'],
  settingsFields: [],
  navSections: ['overview', 'settings'],
};
