// NetApp ONTAP platform manifest (ICC contract C1). Wraps the existing
// routes/netapp.js router and services/netappPoller.js poller behind the
// plugin registry — no route or poller logic is duplicated here.
const netappMigrations = require('../../db/migrations/netapp');
const netappRouter = require('../../routes/netapp');
const { directPoller, initNetAppPoller, stopAll: netappStopAll } = require('../../services/netappPoller');

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
    // direct clusters) + aiqumPoller (per-gateway schedules). init runs the
    // FULL initializer — the old version only inited direct clusters, so the
    // dedicated poller process never scheduled the AIQUM sync at all.
    return {
      init: () => initNetAppPoller(),
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
