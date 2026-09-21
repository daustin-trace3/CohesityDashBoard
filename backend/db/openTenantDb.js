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
const awsMigrations = require('./migrations/aws');
const unifiMigrations = require('./migrations/unifi');
const brocadeMigrations = require('./migrations/brocade');
const bluecatMigrations = require('./migrations/bluecat');
const directoryMigrations = require('./migrations/directory');

// Opens one tenant's database file and brings its schema up to date. Every
// tenant has its own file (see core/tenantRegistry.js); nothing here is shared.
function openTenantDb(dbPath) {
  const dataDir = path.dirname(dbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const db = new Database(dbPath);

  // Enable WAL mode and foreign keys via exec
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  // Two processes (API + poller) share this file, so wait out the other
  // process's write transactions instead of failing with SQLITE_BUSY.
  db.pragma('busy_timeout = 15000');

  // Run versioned migrations, scope by scope. Idempotent, safe on both a
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
  runMigrations(db, 'aws', awsMigrations);
  runMigrations(db, 'unifi', unifiMigrations);
  runMigrations(db, 'brocade', brocadeMigrations);
  runMigrations(db, 'bluecat', bluecatMigrations);
  runMigrations(db, 'directory', directoryMigrations);

  // Two tables that are not part of any migration scope. Their modules used to
  // create them on require; other code queries them directly, so every tenant
  // database gets them the moment it is opened.
  db.exec(`
    CREATE TABLE IF NOT EXISTS poller_status (
      type             TEXT NOT NULL,
      entity_id        INTEGER NOT NULL DEFAULT 0,
      last_poll_start  TEXT,
      last_poll_end    TEXT,
      last_poll_status TEXT,
      is_syncing       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (type, entity_id)
    );
    CREATE TABLE IF NOT EXISTS dns_cache (
      ip          TEXT PRIMARY KEY,
      name        TEXT,
      resolved_at TEXT NOT NULL
    );
  `);

  return db;
}

module.exports = { openTenantDb };
