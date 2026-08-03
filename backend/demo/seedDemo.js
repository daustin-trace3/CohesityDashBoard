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
const { seedDell } = require('./generators/dell');
const { seedAria } = require('./generators/aria');
const { seedNetbackup } = require('./generators/netbackup');
const { seedAws } = require('./generators/aws');
const { seedProxmox } = require('./generators/proxmox');

const SEEDED_TABLES = [
  // core
  'user_groups', 'users', 'app_settings',
  // cohesity
  'replication_status_cache', 'consumption_breakdown', 'license_view_detail', 'cohesity_views',
  'license_meter_usage', 'license_type_usage', 'license_usage',
  'source_registrations', 'policies', 'replication_runs', 'protection_runs',
  'alerts', 'metrics_history', 'workload_history', 'cohesity_objects', 'cohesity_agents', 'clusters',
  'aria_deployment_resources',
  // netapp
  'netapp_cifs_shares', 'netapp_cifs_sessions', 'netapp_export_rules',
  'netapp_nfs_clients', 'netapp_quotas', 'netapp_lifs', 'netapp_snapmirror',
  'netapp_alerts', 'netapp_disks', 'netapp_nodes', 'netapp_svms',
  'netapp_volumes', 'netapp_aggregates', 'netapp_metrics_history', 'netapp_arrays',
  'netapp_aiqum_instances',
  // pure
  'pure_arrays',
  'pure1_arrays', 'pure1_alerts', 'pure1_pods', 'pure1_metrics_history',
  // zerto
  'zerto_vras', 'zerto_vms', 'zerto_alerts', 'zerto_vpgs', 'zerto_sites', 'zerto_metrics_history', 'zerto_licenses',
  // vcenter (children before the parent so FK deletes stay explicit)
  'vcenter_vms', 'vcenter_hosts', 'vcenter_clusters', 'vcenter_datastores',
  'vcenter_certs', 'vcenter_metrics_history', 'vcenter_networks',
  'vcenter_orphaned_vmdks', 'vcenter_events', 'vcenter_issue_history', 'vcenter_vcenters',
  // dell (children before the parent)
  'dell_devices', 'dell_components', 'dell_alerts', 'dell_warranties',
  'dell_firmware_compliance', 'dell_metrics_history', 'dell_ome_instances',
  // aria (children before the parent)
  'aria_deployments', 'aria_requests', 'aria_endpoints', 'aria_projects',
  'aria_catalog_sources', 'aria_images', 'aria_image_mappings', 'aria_flavor_mappings', 'aria_blueprints',
  'aria_runs', 'aria_approvals', 'aria_metrics_history',
  'aria_issue_history', 'aria_instances',
  // netbackup (children before the parent)
  'netbackup_jobs', 'netbackup_policies', 'netbackup_storage_units', 'netbackup_disk_pools',
  'netbackup_media_servers', 'netbackup_appliances', 'netbackup_alerts',
  'netbackup_issue_history', 'netbackup_metrics_history', 'netbackup_sources',
  'netbackup_appliance_hw', 'netbackup_appliance_conns',
  // aws
  'aws_ec2_instances', 'aws_ebs_volumes', 'aws_lightsail_instances',
  'aws_ecs_services', 'aws_ecs_clusters', 'aws_s3_buckets', 'aws_bedrock_usage',
  'aws_cost_daily', 'aws_metrics_history', 'aws_issue_history',
  'aws_rds_instances', 'aws_lambda_functions', 'aws_dynamo_tables',
  'aws_ecr_repos', 'aws_subnets', 'aws_vpcs',
  'aws_s3_size_history', 'aws_rds_storage_history', 'aws_cost_usage_daily',
  'aws_cost_instance_type_daily', 'aws_health_events', 'aws_optimizer_recommendations',
  'aws_accounts',
  // proxmox (children before the parent)
  'proxmox_guests', 'proxmox_storage', 'proxmox_backup_jobs', 'proxmox_tasks',
  'proxmox_metrics', 'proxmox_issue_history', 'proxmox_snapshots', 'proxmox_services',
  'proxmox_disks', 'proxmox_node_networks', 'proxmox_storage_content', 'proxmox_events',
  'proxmox_nodes', 'proxmox_servers',
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
  const dellResult = db.transaction(() => seedDell(db, { now, encrypt }))();
  const ariaResult = db.transaction(() => seedAria(db, { now, encrypt }))();
  const netbackupResult = db.transaction(() => seedNetbackup(db, { now, encrypt }))();
  const awsResult = db.transaction(() => seedAws(db, { now, encrypt }))();
  const proxmoxResult = db.transaction(() => seedProxmox(db, { now, encrypt }))();

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
    ['dell instances/devices/components', `${dellResult.instances}/${dellResult.devices}/${dellResult.components}`],
    ['aria instances/deployments/requests', `${ariaResult.instances}/${ariaResult.deployments}/${ariaResult.requests}`],
    ['netbackup sources/policies/jobs', `${netbackupResult.sources}/${netbackupResult.policies}/${netbackupResult.jobs}`],
    ['aws ec2/ecs services/s3/cost rows', `${awsResult.ec2}/${awsResult.ecsServices}/${awsResult.s3}/${awsResult.costRows}`],
    ['proxmox servers/nodes/guests', `${proxmoxResult.servers}/${proxmoxResult.nodes}/${proxmoxResult.guests}`],
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
