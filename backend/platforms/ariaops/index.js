// Aria Operations platform manifest. Direct-connection model like Aria
// Automation/vCenter/Dell: registered instances in ariaops_instances, one
// framework poller task per instance.
const ariaopsMigrations = require('../../db/migrations/ariaops');
const ariaopsRouter = require('../../routes/ariaops');
const { ariaopsPoller, initAriaOpsPoller } = require('../../services/ariaopsPoller');

module.exports = {
  id: 'ariaops',
  name: 'Aria Operations',
  apiVersion: 1,
  migrations: ariaopsMigrations,
  createRouter() {
    return ariaopsRouter;
  },
  createPoller() {
    return {
      ...ariaopsPoller,
      init: () => initAriaOpsPoller(),
    };
  },
  statusTables: ['ariaops_instances'],
};
