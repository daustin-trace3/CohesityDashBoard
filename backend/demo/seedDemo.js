#!/usr/bin/env node
// Builds/refreshes the ICC demo SQLite database with deterministic, generic
// fixture data for every seeded page. Safe to re-run — wipes seeded tables
// first so a fresh run always refreshes relative timestamps.
//
// Usage:
//   node backend/demo/seedDemo.js
//   node backend/demo/seedDemo.js --db ./backend/data/demo.db
//   node backend/demo/seedDemo.js --force        (delete db file + wal/shm first)

const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const force = args.includes('--force');
const dbFlagIdx = args.indexOf('--db');
const dbArg = dbFlagIdx !== -1 ? args[dbFlagIdx + 1] : null;

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'demo.db');
const dbPath = dbArg ? path.resolve(dbArg) : (process.env.DASHBOARD_DB_PATH || DEFAULT_DB_PATH);
process.env.DASHBOARD_DB_PATH = dbPath;

// Same .env resolution as backend/server.js (backend/demo/.. -> backend/.. -> Dashboard/.env).
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

if (force) {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix;
    try { fs.rmSync(p); } catch { /* did not exist */ }
  }
}

const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Requiring db/database triggers schema creation via migrations.
const db = require('../db/database');
const argon2 = require('argon2');
const { encrypt } = require('../services/encryption');

const { seedCore } = require('./generators/core');
const { seedCohesity } = require('./generators/cohesity');
const { seedNetapp } = require('./generators/netapp');
const { seedPure } = require('./generators/pure');
const { seedZerto } = require('./generators/zerto');
const { seedVcenter } = require('./generators/vcenter');

const SEEDED_TABLES = [
  // core
  'user_groups', 'users', 'app_settings',
  // cohesity
  'replication_status_cache', 'consumption_breakdown', 'license_view_detail', 'cohesity_views',
  'license_meter_usage', 'license_type_usage', 'license_usage',
  'source_registrations', 'policies', 'replication_runs', 'protection_runs',
  'alerts', 'metrics_history', 'workload_history', 'clusters',
  // netapp
  'netapp_cifs_shares', 'netapp_cifs_sessions', 'netapp_export_rules',
  'netapp_nfs_clients', 'netapp_quotas', 'netapp_lifs', 'netapp_snapmirror',
  'netapp_alerts', 'netapp_disks', 'netapp_nodes', 'netapp_svms',
  'netapp_volumes', 'netapp_aggregates', 'netapp_metrics_history', 'netapp_arrays',
  // pure
  'pure_arrays',
  // zerto
  'zerto_vras', 'zerto_vms', 'zerto_alerts', 'zerto_vpgs', 'zerto_sites', 'zerto_metrics_history',
  // vcenter (children before the parent so FK deletes stay explicit)
  'vcenter_vms', 'vcenter_hosts', 'vcenter_clusters', 'vcenter_datastores',
  'vcenter_certs', 'vcenter_metrics_history', 'vcenter_networks',
  'vcenter_orphaned_vmdks', 'vcenter_events', 'vcenter_issue_history', 'vcenter_vcenters',
];

function wipeSeededTables(database) {
  database.transaction(() => {
    for (const table of SEEDED_TABLES) {
      try {
        database.exec(`DELETE FROM ${table}`);
      } catch (err) {
        console.error(`[seedDemo] failed to clear ${table}: ${err.message}`);
        throw err;
      }
    }
  })();
}

async function main() {
  const now = Date.now();

  console.log(`[seedDemo] Seeding demo database at ${dbPath}`);
  wipeSeededTables(db);

  await seedCore(db, { argon2, now });

  const cohesityResult = db.transaction(() => seedCohesity(db, { now, encrypt }))();
  const netappResult = db.transaction(() => seedNetapp(db, { now, encrypt }))();
  const pureResult = db.transaction(() => seedPure(db, { now, encrypt }))();
  const zertoResult = db.transaction(() => seedZerto(db, { now, encrypt }))();
  const vcenterResult = db.transaction(() => seedVcenter(db, { now, encrypt }))();

  const summary = [
    ['clusters', cohesityResult.clusters],
    ['metrics_history (cohesity)', cohesityResult.metrics],
    ['alerts (cohesity)', cohesityResult.alerts],
    ['protection_runs', cohesityResult.protectionRuns],
    ['replication_runs', cohesityResult.replicationRuns],
    ['policies', cohesityResult.policies],
    ['source_registrations', cohesityResult.sourceRegistrations],
    ['license_view_detail', cohesityResult.licenseViews],
    ['workload_history', cohesityResult.workloadRows],
    ['netapp_arrays', netappResult.arrays],
    ['metrics_history (netapp)', netappResult.metrics],
    ['netapp_snapmirror', netappResult.snapmirror],
    ['pure_arrays', pureResult.arrays],
    ['zerto sites/vras/vpgs/vms', `${zertoResult.sites}/${zertoResult.vras}/${zertoResult.vpgs}/${zertoResult.vms}`],
    ['vcenters/hosts/vms', `${vcenterResult.vcenters}/${vcenterResult.hosts}/${vcenterResult.vms}`],
    ['users', 1],
  ];

  console.log('\n[seedDemo] Summary:');
  const nameWidth = Math.max(...summary.map(([name]) => name.length));
  for (const [name, count] of summary) {
    console.log(`  ${name.padEnd(nameWidth)}  ${count}`);
  }
  console.log('\n[seedDemo] Done. Login: demo / IccDemo2026!');
}

main().catch((err) => {
  console.error('[seedDemo] FAILED:', err);
  process.exitCode = 1;
});
