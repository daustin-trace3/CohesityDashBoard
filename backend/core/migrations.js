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

  // Two processes (web and poller) boot at the same time after a pull and both
  // see the same pending list. Each step therefore re-checks its own row inside
  // the write lock and records itself with INSERT OR IGNORE, so the loser of the
  // race skips the step instead of failing on the primary key (seen on the CG
  // box 2026-11-09, logicmonitor v17).
  const isApplied = db.prepare(
    'SELECT 1 FROM schema_migrations WHERE scope = ? AND version = ?'
  );
  const recordApplied = db.prepare(
    'INSERT OR IGNORE INTO schema_migrations (scope, version, applied_at) VALUES (?, ?, ?)'
  );

  const applyStep = (step) => {
    if (isApplied.get(scope, step.version)) return;
    step.up(db);
    recordApplied.run(scope, step.version, new Date().toISOString());
  };

  for (const step of pending) {
    try {
      if (step.noTransaction) {
        applyStep(step);
      } else {
        db.transaction(() => applyStep(step)).immediate();
      }
    } catch (err) {
      const wrapped = new Error(`[migrations] ${scope} v${step.version}: ${err.message}`);
      wrapped.cause = err;
      throw wrapped;
    }
  }
}

module.exports = { runMigrations, ensureMigrationsTable };
