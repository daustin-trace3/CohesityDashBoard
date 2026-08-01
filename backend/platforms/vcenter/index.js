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
  datasets: [
    {
      id: 'vcenter.hosts',
      label: 'ESX Hosts',
      table: 'vcenter_hosts',
      section: 'hosts',
      defaultSort: 'name',
      columns: [
        { key: 'name', label: 'Host', type: 'string', filterable: true },
        { key: 'cluster_name', label: 'Cluster', type: 'string', filterable: true },
        { key: 'connection_state', label: 'Connection', type: 'enum', filterable: true },
        { key: 'power_state', label: 'Power', type: 'enum', filterable: true },
        { key: 'in_maintenance', label: 'Maintenance', type: 'boolean', filterable: true },
        { key: 'vm_count', label: 'VMs', type: 'number', aggregatable: true },
        { key: 'cpu_mhz_capacity', label: 'CPU Capacity (MHz)', type: 'number', aggregatable: true },
        { key: 'cpu_mhz_used', label: 'CPU Used (MHz)', type: 'number', aggregatable: true },
        { key: 'mem_bytes_capacity', label: 'Memory Capacity (bytes)', type: 'number', aggregatable: true },
        { key: 'mem_bytes_used', label: 'Memory Used (bytes)', type: 'number', aggregatable: true },
      ],
    },
    {
      id: 'vcenter.datastores',
      label: 'Datastores',
      table: 'vcenter_datastores',
      section: 'datastores',
      defaultSort: 'name',
      columns: [
        { key: 'name', label: 'Datastore', type: 'string', filterable: true },
        { key: 'ds_type', label: 'Type', type: 'enum', filterable: true },
        { key: 'capacity_bytes', label: 'Capacity (bytes)', type: 'number', aggregatable: true },
        { key: 'free_bytes', label: 'Free (bytes)', type: 'number', aggregatable: true },
        { key: 'accessible', label: 'Accessible', type: 'boolean', filterable: true },
      ],
    },
    {
      id: 'vcenter.clusters',
      label: 'vSphere Clusters',
      table: 'vcenter_clusters',
      section: 'overview',
      defaultSort: 'name',
      columns: [
        { key: 'name', label: 'Cluster', type: 'string', filterable: true },
        { key: 'drs_enabled', label: 'DRS', type: 'boolean', filterable: true },
        { key: 'ha_enabled', label: 'HA', type: 'boolean', filterable: true },
        { key: 'host_count', label: 'Hosts', type: 'number', aggregatable: true },
        { key: 'vm_count', label: 'VMs', type: 'number', aggregatable: true },
        { key: 'cpu_mhz_capacity', label: 'CPU Capacity (MHz)', type: 'number', aggregatable: true },
        { key: 'cpu_mhz_used', label: 'CPU Used (MHz)', type: 'number', aggregatable: true },
        { key: 'mem_bytes_capacity', label: 'Memory Capacity (bytes)', type: 'number', aggregatable: true },
        { key: 'mem_bytes_used', label: 'Memory Used (bytes)', type: 'number', aggregatable: true },
      ],
    },
  ],
};
