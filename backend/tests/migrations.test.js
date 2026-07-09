/**
 * Migration runner (contract C5) + the critical equivalence test (C5b):
 * a fresh DB built through the new versioned runner must land on the exact
 * same schema as the pre-refactor db/database.js (schema.sql exec + its
 * seven inline ALTER/rebuild blocks), and the new runner must also be a
 * no-op-safe pass over a DB that already went through the legacy path.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runMigrations } from '../core/migrations.js';
import coreMigrations from '../db/migrations/core.js';
import cohesityMigrations from '../db/migrations/cohesity.js';
import pureMigrations from '../db/migrations/pure.js';
import netappMigrations from '../db/migrations/netapp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'schema.sql');

/**
 * Verbatim copy of the seven inline migration blocks that used to live in
 * db/database.js before the ICC refactor, applied directly after
 * db/schema.sql is exec'd — i.e. the legacy startup path.
 */
function legacyInit(db) {
  try {
    db.exec("ALTER TABLE clusters ADD COLUMN tags TEXT NOT NULL DEFAULT ''");
  } catch {
    // Column already exists — ignore
  }

  try {
    const hasMode = db.prepare("PRAGMA table_info(llm_insights)").all().some(c => c.name === 'mode');
    if (!hasMode) {
      db.exec('DROP TABLE IF EXISTS llm_insights');
      db.exec(`
        CREATE TABLE llm_insights (
          cluster_id   INTEGER NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
          mode         TEXT NOT NULL DEFAULT 'system',
          model        TEXT,
          analysis     TEXT NOT NULL,
          generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (cluster_id, mode)
        )
      `);
    }
  } catch {
    // Table does not exist yet — schema.sql will create the current shape.
  }

  const hasReplUniqueIndex = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_repl_runs_unique'")
    .get();
  if (!hasReplUniqueIndex) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.transaction(() => {
      db.exec(`
        CREATE TABLE replication_runs_dedup (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          protection_run_id     INTEGER NOT NULL REFERENCES protection_runs(id) ON DELETE CASCADE,
          cluster_id            INTEGER NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
          target_cluster_name   TEXT,
          target_cluster_id     INTEGER,
          status                TEXT,
          logical_bytes         INTEGER,
          start_time            DATETIME,
          end_time              DATETIME,
          lag_seconds           INTEGER,
          captured_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.exec(`
        INSERT INTO replication_runs_dedup
        SELECT * FROM replication_runs
        WHERE id IN (
          SELECT MAX(id) FROM replication_runs
          GROUP BY protection_run_id,
                   IFNULL(target_cluster_id, -1),
                   IFNULL(target_cluster_name, ''),
                   IFNULL(start_time, '')
        )
      `);
      db.exec('DROP TABLE replication_runs');
      db.exec('ALTER TABLE replication_runs_dedup RENAME TO replication_runs');
      db.exec('CREATE INDEX IF NOT EXISTS idx_repl_runs_cluster_time ON replication_runs(cluster_id, start_time)');
      db.exec(`
        CREATE UNIQUE INDEX idx_repl_runs_unique ON replication_runs(
          protection_run_id,
          IFNULL(target_cluster_id, -1),
          IFNULL(target_cluster_name, ''),
          IFNULL(start_time, '')
        )
      `);
    })();
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('VACUUM');
  }

  try {
    db.exec("ALTER TABLE pure_arrays ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'client'");
  } catch {
    // Column already exists (or table not present yet) — ignore.
  }

  try { db.exec('ALTER TABLE pure_network_interfaces ADD COLUMN netmask TEXT'); } catch { /* exists */ }
  try { db.exec('ALTER TABLE pure_network_interfaces ADD COLUMN gateway TEXT'); } catch { /* exists */ }

  try { db.exec('ALTER TABLE netapp_arrays ADD COLUMN cluster_uuid TEXT'); } catch { /* exists */ }
  try { db.exec('ALTER TABLE netapp_arrays ADD COLUMN management_ip TEXT'); } catch { /* exists */ }
  try { db.exec('ALTER TABLE netapp_arrays ADD COLUMN version TEXT'); } catch { /* exists */ }
  try { db.exec("ALTER TABLE netapp_arrays ADD COLUMN source TEXT NOT NULL DEFAULT 'direct'"); } catch { /* exists */ }

  try {
    const hasAlertTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pure_alerts'")
      .get();
    const hasAlertIndex = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_pure_alerts_unique'")
      .get();
    if (hasAlertTable && !hasAlertIndex) {
      db.exec(
        'DELETE FROM pure_alerts WHERE id NOT IN (SELECT MAX(id) FROM pure_alerts GROUP BY array_id, pure_alert_id)'
      );
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_pure_alerts_unique ON pure_alerts(array_id, pure_alert_id)');
    }
  } catch (err) {
    console.error('[migration] pure_alerts unique index migration failed:', err.message);
  }
}

function buildLegacyDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
  legacyInit(db);
  return db;
}

function buildNewDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, 'core', coreMigrations);
  runMigrations(db, 'cohesity', cohesityMigrations);
  runMigrations(db, 'pure', pureMigrations);
  runMigrations(db, 'netapp', netappMigrations);
  return db;
}

function normalizeSchema(db) {
  return db
    .prepare(`
      SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE type IN ('table', 'index')
        AND name NOT LIKE 'sqlite_%'
        AND name != 'schema_migrations'
      ORDER BY type, name
    `)
    .all()
    .map((row) => ({
      type: row.type,
      name: row.name,
      tbl_name: row.tbl_name,
      // Strip SQL line comments (schema.sql has them, the migration steps
      // don't) before collapsing whitespace so only structure is compared.
      sql: (row.sql || '')
        .replace(/--[^\n]*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    }));
}

// Tables introduced by the ICC refactor (plugins, contract C4) and by WP7a's
// auth+RBAC migration (contract C8.1) never existed on the legacy schema.sql
// + inline-migration path, so they're excluded from the legacy-equivalence
// comparisons below and asserted to exist separately instead.
const NEW_TABLES = [
  'plugins', 'users', 'groups', 'user_groups', 'role_grants',
  'auth_sessions', 'service_accounts',
];

describe('runMigrations', () => {
  it('applies steps once and records them; re-running is a no-op', () => {
    const db = new Database(':memory:');
    let calls = 0;
    const steps = [
      {
        version: 1,
        up(d) {
          calls += 1;
          d.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
        },
      },
    ];

    runMigrations(db, 'test', steps);
    expect(calls).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM schema_migrations WHERE scope='test'").get().c).toBe(1);

    runMigrations(db, 'test', steps);
    expect(calls).toBe(1); // not re-applied
  });

  it('rolls back a failing step and leaves prior steps applied', () => {
    const db = new Database(':memory:');
    const steps = [
      {
        version: 1,
        up(d) {
          d.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
          d.prepare('INSERT INTO t (id) VALUES (1)').run();
        },
      },
      {
        version: 2,
        up(d) {
          d.prepare('INSERT INTO t (id) VALUES (2)').run();
          throw new Error('kaboom');
        },
      },
    ];

    expect(() => runMigrations(db, 'test', steps)).toThrow(/\[migrations\] test v2: kaboom/);

    const applied = db.prepare("SELECT version FROM schema_migrations WHERE scope='test'").all();
    expect(applied).toEqual([{ version: 1 }]);
    // v2's insert was rolled back with its transaction.
    expect(db.prepare('SELECT id FROM t ORDER BY id').all()).toEqual([{ id: 1 }]);
  });

  it('equivalence: fresh DB via the new runner matches the legacy schema.sql + inline-migration path', () => {
    const legacyDb = buildLegacyDb();
    const newDb = buildNewDb();

    const legacySchema = normalizeSchema(legacyDb);
    const newSchema = normalizeSchema(newDb).filter((r) => !NEW_TABLES.includes(r.name));
    expect(newSchema).toEqual(legacySchema);
    for (const name of NEW_TABLES) {
      expect(normalizeSchema(newDb).some((r) => r.name === name)).toBe(true);
    }

    legacyDb.close();
    newDb.close();
  });

  it('running the new runner against a DB already built via the legacy path completes without error and leaves every pre-existing table/index unchanged', () => {
    const db = buildLegacyDb();
    const before = normalizeSchema(db).filter((r) => !NEW_TABLES.includes(r.name));

    expect(() => {
      runMigrations(db, 'core', coreMigrations);
      runMigrations(db, 'cohesity', cohesityMigrations);
      runMigrations(db, 'pure', pureMigrations);
      runMigrations(db, 'netapp', netappMigrations);
    }).not.toThrow();

    const after = normalizeSchema(db);
    expect(after.filter((r) => !NEW_TABLES.includes(r.name))).toEqual(before);
    for (const name of NEW_TABLES) {
      expect(after.some((r) => r.name === name)).toBe(true);
    }

    db.close();
  });
});
