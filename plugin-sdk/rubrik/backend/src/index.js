// Rubrik demo platform plugin manifest (ICC contract C1). Static, seeded
// demo data — no live upstream connection. Mirrors plugin-sdk/template/.
//
// v2.0.0 restructure: this file now only assembles the manifest; the
// migrations (v1-v3, byte-identical) live in ./migrations.js and the v1.x
// routes (moved verbatim) live in ./routes.js.

const { migrations } = require('./migrations');
const { createRouter } = require('./routes');
const { server360, server360Suggest } = require('./server360');

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
  // Demo data is static (seeded by the migration) — no upstream to poll.
  // init()/stopAll() are no-ops so the host's plugin lifecycle stays uniform.
  createPoller(coreApi) {
    return {
      init() {
        coreApi.logger.info('[rubrik] Static demo data — no live polling configured.');
        return [];
      },
      stopAll() {},
    };
  },
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
