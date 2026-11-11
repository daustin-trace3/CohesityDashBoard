// Opens the data file and the admin file (db/adminSplit.js) once per process.
const path = require('path');
const { runMigrations } = require('../core/migrations');
const { openPair } = require('./adminSplit');
const logger = require('../utils/logger');
const coreMigrations = require('./migrations/core');
const cohesityMigrations = require('./migrations/cohesity');
const pureMigrations = require('./migrations/pure');
const netappMigrations = require('./migrations/netapp');
const zertoMigrations = require('./migrations/zerto');
const vcenterMigrations = require('./migrations/vcenter');
const dellMigrations = require('./migrations/dell');
const ariaMigrations = require('./migrations/aria');
const ariaopsMigrations = require('./migrations/ariaops');
const netbackupMigrations = require('./migrations/netbackup');
const awsMigrations = require('./migrations/aws');
const proxmoxMigrations = require('./migrations/proxmox');
const brocadeMigrations = require('./migrations/brocade');
const bluecatMigrations = require('./migrations/bluecat');
const logicmonitorMigrations = require('./migrations/logicmonitor');
const directoryMigrations = require('./migrations/directory');
const adminMigrations = require('./migrations/admin');

const DB_PATH = process.env.DASHBOARD_DB_PATH || path.join(__dirname, '..', 'data', 'cohesity.db');

const pair = openPair(DB_PATH, {
  adminPath: process.env.DASHBOARD_ADMIN_DB_PATH || undefined,
  logger,
  role: process.env.ICC_PROCESS_ROLE || 'web',
  // Data-file scopes. Idempotent: safe on a fresh file and on a populated one.
  migrate(db) {
    runMigrations(db, 'core', coreMigrations);
    runMigrations(db, 'cohesity', cohesityMigrations);
    runMigrations(db, 'pure', pureMigrations);
    runMigrations(db, 'netapp', netappMigrations);
    runMigrations(db, 'zerto', zertoMigrations);
    runMigrations(db, 'vcenter', vcenterMigrations);
    runMigrations(db, 'dell', dellMigrations);
    runMigrations(db, 'aria', ariaMigrations);
    runMigrations(db, 'ariaops', ariaopsMigrations);
    runMigrations(db, 'netbackup', netbackupMigrations);
    runMigrations(db, 'aws', awsMigrations);
    runMigrations(db, 'proxmox', proxmoxMigrations);
    runMigrations(db, 'brocade', brocadeMigrations);
    runMigrations(db, 'bluecat', bluecatMigrations);
    runMigrations(db, 'logicmonitor', logicmonitorMigrations);
  },
  // Admin-file scopes.
  migrateAdmin(adminDb) {
    runMigrations(adminDb, 'directory', directoryMigrations);
    runMigrations(adminDb, 'admin', adminMigrations);
  },
});

module.exports = { db: pair.db, adminDb: pair.adminDb, adminPath: pair.adminPath };
