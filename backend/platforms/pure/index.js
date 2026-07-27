// Pure Storage platform manifest (ICC contract C1). Wraps the existing
// routes/pure.js router and services/purePoller.js poller behind the plugin
// registry — no route or poller logic is duplicated here.
//
// Known seam: routes/pure1.js (Pure1 cloud) stays mounted statically at
// /api/pure1 in app.js — the dispatcher only routes /api/<pluginId>/*, and
// pure1 is a second, independent mount under the 'pure' platform's frontend
// area. It folds into this manifest properly once its frontend paths move
// under /pure in a later WP.
const pureMigrations = require('../../db/migrations/pure');
const pureRouter = require('../../routes/pure');
const { purePollerHandle } = require('../../services/purePoller');
const { initPure1Poller, pure1Task } = require('../../services/pure1Poller');

module.exports = {
  id: 'pure',
  name: 'Pure Storage',
  apiVersion: 1,
  migrations: pureMigrations,
  createRouter() {
    return pureRouter;
  },
  createPoller() {
    // Combined handle: the direct-array framework poller (per-source cron
    // tasks) plus the Pure1 SaaS account-global task. init/stopAll drive both;
    // schedule/cancel/trigger/taskCount delegate to the direct-array side only
    // (Pure1 has no per-source rows to schedule against).
    return {
      init: () => {
        purePollerHandle.init();
        initPure1Poller();
      },
      stopAll: () => {
        purePollerHandle.stopAll();
        if (pure1Task.isRunning()) pure1Task.stop();
      },
      schedule: purePollerHandle.schedule,
      cancel: purePollerHandle.cancel,
      trigger: purePollerHandle.trigger,
      taskCount: purePollerHandle.taskCount,
    };
  },
  statusTables: ['pure_arrays'],
  settingsFields: [],
  navSections: ['overview', 'arrays', 'settings'],
};
