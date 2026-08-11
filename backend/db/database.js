const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { runMigrations } = require('../core/migrations');
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

const DB_PATH = process.env.DASHBOARD_DB_PATH || path.join(__dirname, '..', 'data', 'cohesity.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode and foreign keys via exec
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
// Two processes (API + poller) share this file — wait out the other
// process's write transactions instead of failing with SQLITE_BUSY.
db.pragma('busy_timeout = 5000');

// Run versioned migrations, scope by scope. Idempotent — safe on both a
// fresh DB and an existing populated DB with an empty schema_migrations.
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

module.exports = db;
