// Dell OpenManage Enterprise platform manifest (ICC contract C1).
// Direct-connection model like vCenter: registered appliances in
// dell_ome_instances, one framework poller task per instance.
const dellMigrations = require('../../db/migrations/dell');
const dellRouter = require('../../routes/dell');
const { dellPoller, initDellPoller } = require('../../services/dellPoller');

module.exports = {
  id: 'dell',
  name: 'Dell (OpenManage Enterprise)',
  apiVersion: 1,
  migrations: dellMigrations,
  createRouter() {
    return dellRouter;
  },
  createPoller() {
    return {
      ...dellPoller,
      init: () => initDellPoller(),
    };
  },
  statusTables: ['dell_ome_instances'],
  settingsFields: [],
  navSections: ['overview', 'devices', 'alerts', 'governance', 'settings'],
};
