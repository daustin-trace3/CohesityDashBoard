// Admin database split (2026-11-10). The tables every request touches and admins
// change live in their own SQLite file, beside the data file; everything a
// poller writes on a schedule stays in the data file. One writer per file, so a
// poller transaction never makes a sign-in or a settings save wait.
//
// The admin file is ATTACHED to the data connection as "admin", so an
// unqualified statement on the data connection that names an admin table still
// resolves (main first, then attached databases). Writers use the admin
// connection; the guard below flags any admin write that goes through the data
// connection.
//
// This file is shared verbatim between branches: no tenant requires and no
// branch-only logic. A table in ADMIN_TABLES that is absent from main is skipped.
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { installTransactionShim } = require('../core/dbTransactions');

// Parents first (users, groups), then the rest.
const ADMIN_TABLES = [
  'users', 'groups', 'user_groups', 'role_grants', 'auth_sessions', 'service_accounts',
  'app_settings', 'plugins', 'user_dashboards', 'directory_sync_log',
  'idp_providers', 'idp_auth_state', 'idp_seen_assertions', 'idp_sync_log',
  'tenant_audit',
];

// Child-first drop order.
const DROP_ORDER = [
  'user_groups', 'role_grants', 'auth_sessions', 'idp_auth_state', 'idp_seen_assertions',
  'idp_sync_log', 'directory_sync_log', 'idp_providers', 'service_accounts', 'user_dashboards',
  'plugins', 'app_settings', 'tenant_audit', 'groups', 'users',
];

function adminPathFor(dataPath) {
  if (!dataPath || dataPath === ':memory:') return ':memory:';
  if (/\.db$/i.test(dataPath)) return dataPath.replace(/\.db$/i, '.admin.db');
  return `${dataPath}.admin.db`;
}

function applyPragmas(d) {
  d.exec('PRAGMA journal_mode = WAL');
  d.exec('PRAGMA foreign_keys = ON');
  d.pragma('busy_timeout = 15000');
  d.pragma('synchronous = NORMAL');
  d.pragma('wal_autocheckpoint = 1000');
}

const nullLogger = { info() {}, warn() {}, error() {}, debug() {} };

// ---- guard ----------------------------------------------------------------
const NAMES = ADMIN_TABLES.join('|');
const WRITE_RE = new RegExp(
  '\\b(?:INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|REPLACE\\s+INTO|UPDATE(?:\\s+OR\\s+\\w+)?|DELETE\\s+FROM)\\s+["`\\[]?(?:' + NAMES + ')["`\\]]?(?![\\w.])',
  'i'
);

function writesAdminTable(sql) {
  return typeof sql === 'string' && WRITE_RE.test(sql);
}

function installGuard(db, logger) {
  if (db.__iccAdminGuard) return;
  const seen = new Set();
  const check = (sql) => {
    if (!writesAdminTable(sql)) return;
    const msg = 'admin table written through the data connection: ' + String(sql).trim().replace(/\s+/g, ' ').slice(0, 120);
    if (process.env.VITEST || process.env.NODE_ENV === 'test') throw new Error(msg);
    if (seen.has(msg)) return;
    seen.add(msg);
    logger.warn('[db] ' + msg);
  };
  const prepare = db.prepare.bind(db);
  const exec = db.exec.bind(db);
  db.prepare = (sql, ...rest) => { check(sql); return prepare(sql, ...rest); };
  db.exec = (sql, ...rest) => { check(sql); return exec(sql, ...rest); };
  db.__iccAdminGuard = true;
}

// ---- move -----------------------------------------------------------------
function qIdent(n) { return '"' + String(n).replace(/"/g, '""') + '"'; }

const IDENT = '(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|\\w+)';

// CREATE TABLE users ( ... -> CREATE TABLE admin."users" ( ...
function qualifyCreateTable(sql, name) {
  const re = new RegExp('^\\s*CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?' + IDENT, 'i');
  if (!re.test(sql)) throw new Error('[db] cannot parse CREATE TABLE for ' + name);
  return sql.replace(re, 'CREATE TABLE admin.' + qIdent(name));
}

// CREATE [UNIQUE] INDEX [IF NOT EXISTS] name ON tbl -> CREATE [UNIQUE] INDEX admin."name" ON "tbl"
function qualifyCreateIndex(sql, idxName, tbl) {
  const re = new RegExp('^\\s*CREATE\\s+(UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?' + IDENT + '\\s+ON\\s+' + IDENT, 'i');
  if (!re.test(sql)) throw new Error('[db] cannot parse CREATE INDEX for ' + idxName);
  return sql.replace(re, (m, uniq) => 'CREATE ' + (uniq ? 'UNIQUE ' : '') + 'INDEX admin.' + qIdent(idxName) + ' ON ' + qIdent(tbl));
}

function colNames(db, schema, table) {
  return db.prepare('PRAGMA ' + schema + '.table_info(' + qIdent(table) + ')').all().map((c) => c.name);
}

function moveAdminTables(db, opts = {}) {
  const logger = opts.logger || nullLogger;
  const adminFile = opts.adminPath || 'the admin file';
  const run = db.transaction(() => {
    const rows = db.prepare(
      'SELECT name, type, tbl_name, sql FROM main.sqlite_master WHERE tbl_name IN (' + ADMIN_TABLES.map(() => '?').join(',') + ") AND name NOT LIKE 'sqlite_%'"
    ).all(...ADMIN_TABLES);
    const tables = rows.filter((r) => r.type === 'table');
    if (!tables.length) return { moved: [] };
    if (rows.some((r) => r.type === 'trigger')) {
      throw new Error('[db] admin split: a trigger exists on an admin table; the move does not carry triggers');
    }
    const present = new Set(tables.map((t) => t.name));
    const ordered = ADMIN_TABLES.filter((t) => present.has(t));

    db.exec(`CREATE TABLE IF NOT EXISTS admin.schema_migrations (
      scope       TEXT NOT NULL,
      version     INTEGER NOT NULL,
      applied_at  TEXT NOT NULL,
      PRIMARY KEY (scope, version)
    )`);

    const adminHas = new Set(
      db.prepare("SELECT name FROM admin.sqlite_master WHERE type = 'table'").all().map((r) => r.name)
    );
    const moved = [];
    for (const name of ordered) {
      const t = tables.find((x) => x.name === name);
      if (!adminHas.has(name)) {
        db.exec(qualifyCreateTable(t.sql, name));
        for (const ix of rows.filter((r) => r.type === 'index' && r.tbl_name === name && r.sql)) {
          db.exec(qualifyCreateIndex(ix.sql, ix.name, name));
        }
      } else {
        const a = colNames(db, 'admin', name).join(',');
        const m = colNames(db, 'main', name).join(',');
        // Admin may be ahead (a later admin migration added columns): main's
        // columns must be a prefix of admin's, in order.
        if (!(a === m || a.startsWith(m + ','))) {
          throw new Error('[db] admin split: columns of ' + name + ' differ between main (' + m + ') and admin (' + a + ')');
        }
      }
      const mc = colNames(db, 'main', name).map(qIdent).join(', ');
      db.exec('INSERT OR IGNORE INTO admin.' + qIdent(name) + ' (' + mc + ') SELECT ' + mc + ' FROM main.' + qIdent(name));
      const nm = db.prepare('SELECT count(*) AS n FROM main.' + qIdent(name)).get().n;
      const na = db.prepare('SELECT count(*) AS n FROM admin.' + qIdent(name)).get().n;
      if (na < nm) throw new Error('[db] admin split: ' + name + ' copy short, main ' + nm + ' rows, admin ' + na + ' rows');
      moved.push({ table: name, rows: nm });
    }

    // AUTOINCREMENT sequences keep counting where they left off.
    if (db.prepare("SELECT 1 FROM main.sqlite_master WHERE name = 'sqlite_sequence'").get()) {
      const seqs = db.prepare('SELECT name, seq FROM main.sqlite_sequence').all().filter((s) => present.has(s.name));
      for (const s of seqs) {
        const cur = db.prepare('SELECT seq FROM admin.sqlite_sequence WHERE name = ?').get(s.name);
        if (!cur) db.prepare('INSERT INTO admin.sqlite_sequence (name, seq) VALUES (?, ?)').run(s.name, s.seq);
        else if (cur.seq < s.seq) db.prepare('UPDATE admin.sqlite_sequence SET seq = ? WHERE name = ?').run(s.seq, s.name);
      }
    }

    if (db.prepare("SELECT 1 FROM main.sqlite_master WHERE name = 'schema_migrations'").get()) {
      db.exec("INSERT OR IGNORE INTO admin.schema_migrations SELECT * FROM main.schema_migrations WHERE scope = 'directory'");
    }

    // Rows are copied and verified above; the admin file is the copy from here on.
    for (const name of DROP_ORDER) {
      if (present.has(name)) db.exec('DROP TABLE main.' + qIdent(name));
    }
    for (const m of moved) logger.info('[db] moved ' + m.table + ' to ' + adminFile + ': ' + m.rows + ' rows');
    logger.info('[db] admin split: moved ' + moved.length + ' tables to ' + adminFile);
    return { moved };
  });
  return run.immediate();
}

// ---- open -----------------------------------------------------------------
// opts.migrate(db) runs every data-file migration scope (not directory);
// opts.migrateAdmin(adminDb) runs the directory and admin scopes.
function openPair(dataPath, opts = {}) {
  const logger = opts.logger || nullLogger;
  const role = opts.role || 'web';
  const adminPath = opts.adminPath || adminPathFor(dataPath);

  for (const p of [dataPath, adminPath]) {
    if (p && p !== ':memory:') {
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
  }

  const adminDb = new Database(adminPath);
  applyPragmas(adminDb);
  installTransactionShim(adminDb, { logger, role });

  const db = new Database(dataPath);
  applyPragmas(db);
  const attachTarget = adminPath === ':memory:' ? '' : adminPath.replace(/\\/g, '/');
  db.exec("ATTACH DATABASE '" + attachTarget.replace(/'/g, "''") + "' AS admin");
  db.exec('CREATE TABLE IF NOT EXISTS icc_txn_anchor (n INTEGER NOT NULL)');
  if (!db.prepare('SELECT 1 FROM icc_txn_anchor LIMIT 1').get()) {
    db.prepare('INSERT INTO icc_txn_anchor (n) VALUES (0)').run();
  }
  installTransactionShim(db, { logger, role, anchor: true });

  if (opts.migrate) opts.migrate(db);
  moveAdminTables(db, { logger, adminPath });
  installGuard(db, logger);
  if (opts.migrateAdmin) opts.migrateAdmin(adminDb);
  Object.defineProperty(db, 'adminHandle', { value: adminDb, enumerable: false });

  return { db, adminDb, adminPath };
}

// The admin connection that belongs to a data connection (demo generators and
// scripts that receive only `db`); a plain single-file handle (a test scratch
// database) is its own admin handle.
function adminOf(db) { return db.adminHandle || db; }

// Table existence across both files: an admin table is absent from main's
// sqlite_master once the split has run, so a check on one needs both schemas.
function tableExistsAny(db, name) {
  const q = (schema) => db.prepare('SELECT 1 FROM ' + schema + ".sqlite_master WHERE type = 'table' AND name = ?").get(name);
  if (q('main')) return true;
  try { return !!q('admin'); } catch { return false; }
}

module.exports = { adminOf, tableExistsAny, ADMIN_TABLES, adminPathFor, openPair, moveAdminTables, writesAdminTable, installGuard };
