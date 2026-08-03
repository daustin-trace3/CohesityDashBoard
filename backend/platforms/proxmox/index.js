// Proxmox VE platform manifest (ICC contract). Direct-connection model like
// vCenter: registered servers in proxmox_servers, one framework poller task
// per server.
const proxmoxMigrations = require('../../db/migrations/proxmox');
const proxmoxRouter = require('../../routes/proxmox');
const { proxmoxPoller, initProxmoxPoller } = require('../../services/proxmoxPoller');

module.exports = {
  id: 'proxmox',
  name: 'Proxmox VE',
  apiVersion: 1,
  color: '#E57000',
  migrations: proxmoxMigrations,
  createRouter() {
    return proxmoxRouter;
  },
  createPoller() {
    return {
      ...proxmoxPoller,
      init: () => initProxmoxPoller(),
    };
  },
  statusTables: ['proxmox_servers'],
  settingsFields: [],
  navSections: ['overview', 'nodes', 'guests', 'storage', 'backups', 'settings'],
  datasets: [
    {
      id: 'proxmox.guests',
      label: 'Proxmox Guests',
      table: 'proxmox_guests',
      section: 'guests',
      defaultSort: 'name',
      columns: [
        { key: 'name', label: 'Guest', type: 'string', filterable: true },
        { key: 'vmid', label: 'VMID', type: 'number', filterable: true },
        { key: 'type', label: 'Type', type: 'enum', filterable: true },
        { key: 'node', label: 'Node', type: 'string', filterable: true },
        { key: 'status', label: 'Status', type: 'enum', filterable: true },
        { key: 'is_template', label: 'Template', type: 'boolean', filterable: true },
        { key: 'cpu_count', label: 'vCPUs', type: 'number', aggregatable: true },
        { key: 'mem_total', label: 'Memory', type: 'number', unit: 'bytes', aggregatable: true },
        { key: 'disk_total', label: 'Disk', type: 'number', unit: 'bytes', aggregatable: true },
      ],
    },
    {
      id: 'proxmox.nodes',
      label: 'Proxmox Nodes',
      table: 'proxmox_nodes',
      section: 'nodes',
      defaultSort: 'name',
      columns: [
        { key: 'name', label: 'Node', type: 'string', filterable: true },
        { key: 'status', label: 'Status', type: 'enum', filterable: true },
        { key: 'cpu_usage', label: 'CPU Usage', type: 'number', aggregatable: true },
        { key: 'cpu_total', label: 'CPU Total', type: 'number', aggregatable: true },
        { key: 'mem_used', label: 'Memory Used', type: 'number', unit: 'bytes', aggregatable: true },
        { key: 'mem_total', label: 'Memory Total', type: 'number', unit: 'bytes', aggregatable: true },
        { key: 'pve_version', label: 'PVE Version', type: 'string', filterable: true },
      ],
    },
    {
      id: 'proxmox.storage',
      label: 'Proxmox Storage',
      table: 'proxmox_storage',
      section: 'storage',
      defaultSort: 'storage',
      columns: [
        { key: 'storage', label: 'Storage', type: 'string', filterable: true },
        { key: 'node', label: 'Node', type: 'string', filterable: true },
        { key: 'type', label: 'Type', type: 'enum', filterable: true },
        { key: 'used_bytes', label: 'Used', type: 'number', unit: 'bytes', aggregatable: true },
        { key: 'total_bytes', label: 'Total', type: 'number', unit: 'bytes', aggregatable: true },
        { key: 'active', label: 'Active', type: 'boolean', filterable: true },
      ],
    },
  ],
};
