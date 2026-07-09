const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { runMigrations } = require('../core/migrations');
const coreMigrations = require('./migrations/core');
const cohesityMigrations = require('./migrations/cohesity');
const pureMigrations = require('./migrations/pure');
const netappMigrations = require('./migrations/netapp');

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

// Run versioned migrations, scope by scope. Idempotent — safe on both a
// fresh DB and an existing populated DB with an empty schema_migrations.
runMigrations(db, 'core', coreMigrations);
runMigrations(db, 'cohesity', cohesityMigrations);
runMigrations(db, 'pure', pureMigrations);
runMigrations(db, 'netapp', netappMigrations);

module.exports = db;
