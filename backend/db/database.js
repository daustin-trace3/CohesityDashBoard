const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'cohesity.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode and foreign keys via exec
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

// Run schema migrations
const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
db.exec(schema);

// Migration: add tags column if not present
try {
  db.exec("ALTER TABLE clusters ADD COLUMN tags TEXT NOT NULL DEFAULT ''");
} catch {
  // Column already exists — ignore
}

// Migration: llm_insights gained a `mode` column + composite primary key.
// The cached LLM text is disposable, so an older single-mode table is just
// dropped and recreated by the schema above.
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

// Migration: replication_runs had no unique constraint, so every poll cycle
// re-inserted the same copy runs (observed: ~11.6M rows, 96% duplicates).
// Rebuild the table keeping the newest row per copy run (later polls carry the
// final status), then enforce uniqueness. IFNULL is needed because NULLs never
// conflict in SQLite unique indexes. Runs once; gated on the index name.
const hasReplUniqueIndex = db
  .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_repl_runs_unique'")
  .get();
if (!hasReplUniqueIndex) {
  const started = Date.now();
  const before = db.prepare('SELECT COUNT(*) c FROM replication_runs').get().c;
  console.log(`[migration] Deduplicating replication_runs (${before} rows) — this runs once and may take a minute…`);

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

  const after = db.prepare('SELECT COUNT(*) c FROM replication_runs').get().c;
  console.log(`[migration] replication_runs deduplicated: ${before} -> ${after} rows in ${((Date.now() - started) / 1000).toFixed(1)}s. Reclaiming disk space (VACUUM)…`);
  db.exec('VACUUM');
  console.log('[migration] VACUUM complete.');
}

module.exports = db;
