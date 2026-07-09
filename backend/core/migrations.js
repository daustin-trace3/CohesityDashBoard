/**
 * Versioned migration runner shared by all scopes (core, cohesity, pure,
 * netapp, and future plugin manifests). Each scope's steps are recorded
 * independently in `schema_migrations` keyed by (scope, version), so an
 * existing production DB — which already has every table but an empty
 * `schema_migrations` — can safely replay idempotent steps without error.
 */

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      scope       TEXT NOT NULL,
      version     INTEGER NOT NULL,
      applied_at  TEXT NOT NULL,
      PRIMARY KEY (scope, version)
    )
  `);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} scope
 * @param {Array<{version: number, up: (db: any) => void, noTransaction?: boolean}>} steps
 */
function runMigrations(db, scope, steps) {
  ensureMigrationsTable(db);

  const row = db
    .prepare('SELECT MAX(version) AS v FROM schema_migrations WHERE scope = ?')
    .get(scope);
  const maxApplied = row && row.v != null ? row.v : 0;

  const pending = (steps || [])
    .filter((s) => s.version > maxApplied)
    .sort((a, b) => a.version - b.version);

  const recordApplied = db.prepare(
    'INSERT INTO schema_migrations (scope, version, applied_at) VALUES (?, ?, ?)'
  );

  for (const step of pending) {
    try {
      if (step.noTransaction) {
        step.up(db);
      } else {
        db.transaction(() => step.up(db))();
      }
      recordApplied.run(scope, step.version, new Date().toISOString());
    } catch (err) {
      const wrapped = new Error(`[migrations] ${scope} v${step.version}: ${err.message}`);
      wrapped.cause = err;
      throw wrapped;
    }
  }
}

module.exports = { runMigrations, ensureMigrationsTable };
