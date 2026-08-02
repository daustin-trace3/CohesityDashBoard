// Core Cohesity dataset declarations for the custom-dashboard catalog.
// Cohesity is not a registry plugin (Phase 1), so its datasets are registered
// directly with core: true (its tables predate the '<ns>_' prefix rule).
// Sections map onto existing cohesity:<section>:view permission strings so
// current role grants keep working unchanged.
const catalog = require('./datasetCatalog');

const COHESITY_DATASETS = [
  {
    id: 'cohesity.metrics_history',
    label: 'Cohesity Capacity History',
    table: 'v_ds_metrics_history',
    section: 'metrics',
    defaultSort: 'captured_at',
    columns: [
      { key: 'cluster_id', label: 'Cluster ID', type: 'number', filterable: true },
      { key: 'cluster_name', label: 'Cluster', type: 'string', filterable: true },
      { key: 'captured_at', label: 'Captured At', type: 'datetime', filterable: true },
      { key: 'total_capacity_bytes', label: 'Total Capacity', type: 'number', unit: 'bytes', aggregatable: true },
      { key: 'used_bytes', label: 'Used', type: 'number', unit: 'bytes', aggregatable: true },
      { key: 'logical_bytes', label: 'Logical', type: 'number', unit: 'bytes', aggregatable: true },
      { key: 'data_reduction_ratio', label: 'Data Reduction', type: 'number', aggregatable: true },
      { key: 'node_count', label: 'Nodes', type: 'number', aggregatable: true },
      { key: 'software_version', label: 'Software Version', type: 'string', filterable: true },
    ],
  },
  {
    id: 'cohesity.alerts',
    label: 'Cohesity Alerts',
    table: 'v_ds_alerts',
    section: 'alerts',
    defaultSort: 'first_seen',
    columns: [
      { key: 'cluster_id', label: 'Cluster ID', type: 'number', filterable: true },
      { key: 'cluster_name', label: 'Cluster', type: 'string', filterable: true },
      { key: 'severity', label: 'Severity', type: 'enum', filterable: true },
      { key: 'alert_type', label: 'Type', type: 'string', filterable: true },
      { key: 'description', label: 'Description', type: 'string' },
      { key: 'resolved', label: 'Resolved', type: 'boolean', filterable: true },
      { key: 'dismissed', label: 'Dismissed', type: 'boolean', filterable: true },
      { key: 'first_seen', label: 'First Seen', type: 'datetime', filterable: true },
    ],
  },
  {
    id: 'cohesity.protection_runs',
    label: 'Cohesity Protection Runs',
    table: 'v_ds_protection_runs',
    section: 'analytics',
    defaultSort: 'start_time',
    columns: [
      { key: 'cluster_id', label: 'Cluster ID', type: 'number', filterable: true },
      { key: 'cluster_name', label: 'Cluster', type: 'string', filterable: true },
      { key: 'job_name', label: 'Job', type: 'string', filterable: true },
      { key: 'run_type', label: 'Run Type', type: 'enum', filterable: true },
      { key: 'status', label: 'Status', type: 'enum', filterable: true },
      { key: 'start_time', label: 'Start', type: 'datetime', filterable: true },
      { key: 'end_time', label: 'End', type: 'datetime' },
      { key: 'logical_bytes', label: 'Logical', type: 'number', unit: 'bytes', aggregatable: true },
    ],
  },
];

function registerCoreDatasets() {
  catalog.registerDatasets('cohesity', COHESITY_DATASETS, { core: true });
}

module.exports = { registerCoreDatasets };
