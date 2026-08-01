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
  datasets: [
    {
      id: 'zerto.vpgs',
      label: 'Zerto VPGs',
      table: 'zerto_vpgs',
      section: 'overview',
      defaultSort: 'name',
      columns: [
        { key: 'name', label: 'VPG', type: 'string', filterable: true },
        { key: 'vms_count', label: 'VMs', type: 'number', aggregatable: true },
        { key: 'protected_site', label: 'Protected Site', type: 'string', filterable: true },
        { key: 'recovery_site', label: 'Recovery Site', type: 'string', filterable: true },
        { key: 'actual_rpo', label: 'Actual RPO (s)', type: 'number', aggregatable: true },
        { key: 'configured_rpo', label: 'Configured RPO (s)', type: 'number', aggregatable: true },
        { key: 'health', label: 'Health', type: 'enum', filterable: true },
        { key: 'status', label: 'Status', type: 'enum', filterable: true },
        { key: 'zorg_name', label: 'ZORG', type: 'string', filterable: true },
      ],
    },
    {
      id: 'zerto.sites',
      label: 'Zerto Sites',
      table: 'zerto_sites',
      section: 'overview',
      defaultSort: 'name',
      columns: [
        { key: 'name', label: 'Site', type: 'string', filterable: true },
        { key: 'site_type', label: 'Type', type: 'enum', filterable: true },
        { key: 'version', label: 'Version', type: 'string', filterable: true },
        { key: 'connection_status', label: 'Connection', type: 'enum', filterable: true },
      ],
    },
    {
      id: 'zerto.vms',
      label: 'Zerto Protected VMs',
      table: 'zerto_vms',
      section: 'overview',
      defaultSort: 'name',
      columns: [
        { key: 'name', label: 'VM', type: 'string', filterable: true },
        { key: 'provisioned_storage_mb', label: 'Provisioned (MB)', type: 'number', aggregatable: true },
        { key: 'used_storage_mb', label: 'Used (MB)', type: 'number', aggregatable: true },
        { key: 'protected_site', label: 'Protected Site', type: 'string', filterable: true },
        { key: 'recovery_site', label: 'Recovery Site', type: 'string', filterable: true },
        { key: 'zorg_name', label: 'ZORG', type: 'string', filterable: true },
      ],
    },
    {
      id: 'zerto.metrics_history',
      label: 'Zerto Account Trends',
      table: 'zerto_metrics_history',
      section: 'overview',
      defaultSort: 'captured_at',
      columns: [
        { key: 'captured_at', label: 'Captured At', type: 'datetime', filterable: true },
        { key: 'sites_count', label: 'Sites', type: 'number', aggregatable: true },
        { key: 'vpgs_count', label: 'VPGs', type: 'number', aggregatable: true },
        { key: 'healthy_vpgs', label: 'Healthy VPGs', type: 'number', aggregatable: true },
        { key: 'erroneous_vpgs', label: 'Erroneous VPGs', type: 'number', aggregatable: true },
        { key: 'vms_count', label: 'VMs', type: 'number', aggregatable: true },
        { key: 'avg_actual_rpo', label: 'Avg RPO (s)', type: 'number', aggregatable: true },
        { key: 'used_storage_mb', label: 'Used (MB)', type: 'number', aggregatable: true },
      ],
    },
  ],
};
