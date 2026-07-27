// Aria Automation platform manifest. Direct-connection model like
// vCenter/Dell: registered instances in aria_instances, one framework poller
// task per instance.
const ariaMigrations = require('../../db/migrations/aria');
const ariaRouter = require('../../routes/aria');
const { ariaPoller, initAriaPoller } = require('../../services/ariaPoller');

module.exports = {
  id: 'aria',
  name: 'VMware Aria Automation',
  apiVersion: 1,
  migrations: ariaMigrations,
  createRouter() {
    return ariaRouter;
  },
  createPoller() {
    return {
      ...ariaPoller,
      init: () => initAriaPoller(),
    };
  },
  statusTables: ['aria_instances'],
  settingsFields: [],
  navSections: ['overview', 'deployments', 'activity', 'infrastructure', 'extensibility', 'approvals', 'settings'],
};
