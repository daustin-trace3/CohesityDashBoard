// Rubrik platform plugin manifest (ICC contract C1). Polls Rubrik Security
// Cloud live (services in ./rscApi.js + ./poller.js) when an 'rsc' connection
// is registered; demo instances keep their seeded estate instead.
//
// v2.0.0 restructure: this file now only assembles the manifest; the
// migrations (v1-v3, byte-identical) live in ./migrations.js and the v1.x
// routes (moved verbatim) live in ./routes.js.

const { migrations } = require('./migrations');
const { createRouter } = require('./routes');
const { server360, server360Suggest } = require('./server360');
const { createRubrikPoller: createPoller } = require('./poller');

module.exports = {
  id: 'rubrik',
  name: 'Rubrik',
  apiVersion: 1,
  color: '#00B388',
  migrations,
  createRouter,
  // Host Server 360 contribution (ops page): display-ready backup posture
  // for any Rubrik protected object matching the pivot identity.
  server360,
  server360Suggest,
  // Live RSC polling, one task per registered 'rsc' connection. Demo
  // instances keep their seeded estate and skip polling entirely.
  createPoller,
  // Gives Rubrik a section in /api/poller/status (contract: arraysTable +
  // metricsTable joined on arrayIdColumn).
  metricsHistory: { arraysTable: 'rubrik_clusters', metricsTable: 'rubrik_capacity_history', arrayIdColumn: 'cluster_id' },
  statusTables: [
    'rubrik_clusters',
    'rubrik_protected_objects',
    'rubrik_jobs',
    'rubrik_sla_domains',
    'rubrik_capacity_history',
    'rubrik_replication_pairs',
    'rubrik_archival_locations',
    'rubrik_anomaly_events',
    'rubrik_threat_hunts',
    'rubrik_events',
    'rubrik_connections',
  ],
};
