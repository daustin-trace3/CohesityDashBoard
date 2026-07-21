// vCenter platform manifest (ICC contract C1). Direct-connection model like
// Pure: registered vCenters in vcenter_vcenters, one framework poller task
// per vCenter.
const vcenterMigrations = require('../../db/migrations/vcenter');
const vcenterRouter = require('../../routes/vcenter');
const { vcenterPoller, initVcenterPoller } = require('../../services/vcenterPoller');

module.exports = {
  id: 'vcenter',
  name: 'VMware vCenter',
  apiVersion: 1,
  migrations: vcenterMigrations,
  createRouter() {
    return vcenterRouter;
  },
  createPoller() {
    return {
      ...vcenterPoller,
      init: () => initVcenterPoller(),
    };
  },
  statusTables: ['vcenter_vcenters'],
  settingsFields: [],
  navSections: ['overview', 'hosts', 'datastores', 'settings'],
};
