// NetApp ONTAP platform manifest (ICC contract C1). Wraps the existing
// routes/netapp.js router and services/netappPoller.js poller behind the
// plugin registry — no route or poller logic is duplicated here.
const netappMigrations = require('../../db/migrations/netapp');
const netappRouter = require('../../routes/netapp');
const { directPoller, aiqumTask, stopAll: netappStopAll } = require('../../services/netappPoller');

module.exports = {
  id: 'netapp',
  name: 'NetApp ONTAP',
  apiVersion: 1,
  migrations: netappMigrations,
  createRouter() {
    return netappRouter;
  },
  createPoller() {
    // Return a wrapper object that combines directPoller (framework handle for
    // direct clusters) + aiqumTask (global task for AIQUM-managed clusters).
    // Most methods delegate to directPoller; init/stopAll coordinate both.
    return {
      init: () => {
        // directPoller.init() loads and schedules direct clusters;
        // aiqumTask is started separately if AIQUM is configured (happens in
        // initNetAppPoller, called by services/netappPoller on startup).
        return directPoller.init();
      },
      schedule: (source) => directPoller.schedule(source),
      cancel: (sourceId) => directPoller.cancel(sourceId),
      trigger: (source) => directPoller.trigger(source),
      stopAll: netappStopAll,
      taskCount: () => directPoller.taskCount(),
    };
  },
  statusTables: ['netapp_arrays'],
  settingsFields: [],
  navSections: ['overview', 'arrays', 'settings'],
};
