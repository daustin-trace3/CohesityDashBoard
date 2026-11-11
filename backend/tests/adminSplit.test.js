/**
 * db/adminSplit.js: the admin file (users, sessions, groups, grants, settings,
 * plugins, directory and identity providers) split from the data file.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runMigrations } = require('../core/migrations');
const { ADMIN_TABLES, adminPathFor, openPair, moveAdminTables, writesAdminTable } = require('../db/adminSplit');

const coreMigrations = require('../db/migrations/core');
const directoryMigrations = require('../db/migrations/directory');
const adminMigrations = require('../db/migrations/admin');
const SCOPES = {
  cohesity: require('../db/migrations/cohesity'),
  pure: require('../db/migrations/pure'),
  netapp: require('../db/migrations/netapp'),
  zerto: require('../db/migrations/zerto'),
  vcenter: require('../db/migrations/vcenter'),
  dell: require('../db/migrations/dell'),
  aria: require('../db/migrations/aria'),
  ariaops: require('../db/migrations/ariaops'),
  netbackup: require('../db/migrations/netbackup'),
  aws: require('../db/migrations/aws'),
  proxmox: require('../db/migrations/proxmox'),
  brocade: require('../db/migrations/brocade'),
  bluecat: require('../db/migrations/bluecat'),
  logicmonitor: require('../db/migrations/logicmonitor'),
};

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'icc-split-')), 'x.db');
const attachSql = (file) => "ATTACH DATABASE '" + adminPathFor(file).replace(/\\/g, '/') + "' AS admin";

function dataScopes(db) {
  runMigrations(db, 'core', coreMigrations);
  for (const [scope, steps] of Object.entries(SCOPES)) runMigrations(db, scope, steps);
}
function open(file) {
  return openPair(file, {
    logger: quiet,
    migrate: dataScopes,
    migrateAdmin(a) { runMigrations(a, 'directory', directoryMigrations); runMigrations(a, 'admin', adminMigrations); },
  });
}
const names = (db) => db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
const countOf = (db, table) => db.prepare('SELECT count(*) AS c FROM ' + table).get().c;
const collapse = (s) => String(s).replace(/\s+/g, ' ').replace(/"/g, '').replace(/\s*([(),])\s*/g, '$1').trim();
function schemaSql(db) {
  const out = {};
  for (const r of db.prepare('SELECT name, sql FROM main.sqlite_master WHERE sql IS NOT NULL ORDER BY name').all()) {
    out[r.name] = collapse(r.sql).replace(/^CREATE TABLE IF NOT EXISTS /i, 'CREATE TABLE ');
  }
  return out;
}

describe('adminPathFor', () => {
  it('replaces .db, appends otherwise, keeps :memory:', () => {
    expect(adminPathFor('/d/cohesity.db')).toBe('/d/cohesity.admin.db');
    expect(adminPathFor('/d/tenant')).toBe('/d/tenant.admin.db');
    expect(adminPathFor(':memory:')).toBe(':memory:');
  });
});

describe('fresh pair', () => {
  it('splits the tables and keeps platform tables in the data file', () => {
    const file = tmp();
    const { db, adminDb, adminPath } = open(file);
    expect(adminPath).toBe(adminPathFor(file));
    const inAdmin = names(adminDb);
    for (const t of ['users', 'groups', 'user_groups', 'role_grants', 'auth_sessions', 'service_accounts', 'app_settings', 'plugins',
      'user_dashboards', 'directory_sync_log', 'idp_providers', 'idp_auth_state', 'idp_seen_assertions', 'idp_sync_log']) {
      expect(inAdmin).toContain(t);
    }
    expect(inAdmin.filter((t) => !ADMIN_TABLES.includes(t)).sort()).toEqual(['schema_migrations', 'sqlite_sequence']);
    const inMain = names(db);
    for (const t of ADMIN_TABLES) expect(inMain).not.toContain(t);
    expect(inMain).toContain('icc_txn_anchor');
    expect(inMain).toContain('clusters');
    // Reads resolve through the attachment.
    expect(countOf(db, 'users')).toBe(0);
    expect(countOf(db, 'groups')).toBeGreaterThan(0);
    expect(() => adminDb.prepare('SELECT 1 FROM clusters')).toThrow(/no such table/);
    // The directory scope runs on the admin file.
    expect(adminDb.prepare("SELECT count(*) AS c FROM schema_migrations WHERE scope = 'directory'").get().c).toBe(directoryMigrations.length);
    expect(db.prepare("SELECT count(*) AS c FROM main.schema_migrations WHERE scope = 'directory'").get().c).toBe(0);
  });
});

describe('pre-split single-file database', () => {
  function legacy(file) {
    const old = new Database(file);
    old.pragma('journal_mode = WAL');
    old.pragma('foreign_keys = ON');
    dataScopes(old);
    runMigrations(old, 'directory', directoryMigrations);
    const now = new Date().toISOString();
    const u = old.prepare("INSERT INTO users (username, password_hash, display_name, created_at, updated_at) VALUES (?, 'h', ?, ?, ?)");
    for (const n of ['ann', 'bob', 'cy']) u.run(n, n.toUpperCase(), now, now);
    const g = old.prepare('INSERT INTO groups (name, description, is_system, created_at) VALUES (?, ?, 0, ?)');
    g.run('Ops', 'ops team', now);
    g.run('Ro', 'read only', now);
    const gid = old.prepare("SELECT id FROM groups WHERE name = 'Ops'").get().id;
    const uids = old.prepare('SELECT id FROM users ORDER BY id').all().map((r) => r.id);
    for (const id of uids) old.prepare('INSERT INTO user_groups (user_id, group_id) VALUES (?, ?)').run(id, gid);
    old.prepare("INSERT INTO role_grants (subject_type, subject_id, permission, created_at) VALUES ('user', ?, 'cohesity:*:view', ?)").run(uids[0], now);
    for (const id of uids) {
      old.prepare('INSERT INTO auth_sessions (id, user_id, csrf_token, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)').run('s' + id, id, 'c', now, now, now);
    }
    const s = old.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))");
    for (let i = 0; i < 6; i++) s.run('k' + i, 'v' + i);
    old.prepare("INSERT INTO plugins (id, version, schema_version, enabled, status, installed_at, updated_at) VALUES ('p1', '1.0.0', 0, 1, 'active', ?, ?)").run(now, now);
    old.prepare("INSERT INTO idp_providers (name, slug, type, created_at, updated_at) VALUES ('Okta', 'okta', 'oidc', ?, ?)").run(now, now);
    const seq = old.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'users'").get().seq;
    old.close();
    return { uids, seq };
  }

  it('moves every row with the same ids, drops the main copies and is a no-op afterwards', () => {
    const file = tmp();
    const { uids, seq } = legacy(file);
    const { db, adminDb } = open(file);
    expect(adminDb.prepare('SELECT id FROM users ORDER BY id').all().map((r) => r.id)).toEqual(uids);
    expect(adminDb.prepare("SELECT count(*) AS c FROM groups WHERE name IN ('Ops', 'Ro')").get().c).toBe(2);
    expect(countOf(adminDb, 'user_groups')).toBe(3);
    expect(adminDb.prepare("SELECT count(*) AS c FROM role_grants WHERE subject_type = 'user'").get().c).toBe(1);
    expect(countOf(adminDb, 'auth_sessions')).toBe(3);
    expect(adminDb.prepare("SELECT count(*) AS c FROM app_settings WHERE key LIKE 'k%'").get().c).toBe(6);
    expect(countOf(adminDb, 'plugins')).toBe(1);
    expect(countOf(adminDb, 'idp_providers')).toBe(1);
    expect(adminDb.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'users'").get().seq).toBeGreaterThanOrEqual(seq);
    const ins = adminDb.prepare("INSERT INTO users (username, password_hash, display_name, created_at, updated_at) VALUES ('new', 'h', 'N', 'a', 'a')").run();
    expect(Number(ins.lastInsertRowid)).toBeGreaterThan(Math.max(...uids));
    for (const t of ADMIN_TABLES) expect(names(db)).not.toContain(t);
    expect(adminDb.prepare("SELECT count(*) AS c FROM schema_migrations WHERE scope = 'directory'").get().c).toBe(directoryMigrations.length);

    // Structure equals a fresh pair's admin file, table by table.
    const fresh = open(tmp());
    const a = schemaSql(adminDb);
    const b = schemaSql(fresh.adminDb);
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    for (const t of Object.keys(b)) expect(a[t], t).toBe(b[t]);

    const present = ADMIN_TABLES.filter((t) => names(adminDb).includes(t));
    const counts = present.map((t) => countOf(adminDb, t));
    db.close();
    adminDb.close();
    const second = open(file);
    expect(present.map((t) => countOf(second.adminDb, t))).toEqual(counts);
  });
});

describe('moveAdminTables', () => {
  it('returns moved: [] the second time', () => {
    const { db } = open(tmp());
    expect(moveAdminTables(db, { logger: quiet })).toEqual({ moved: [] });
    expect(moveAdminTables(db, { logger: quiet })).toEqual({ moved: [] });
  });

  it('finishes after a crash that left admin populated and main tables present, without duplicates', () => {
    const file = tmp();
    const old = new Database(file);
    old.pragma('journal_mode = WAL');
    dataScopes(old);
    runMigrations(old, 'directory', directoryMigrations);
    const now = new Date().toISOString();
    old.prepare("INSERT INTO users (username, password_hash, display_name, created_at, updated_at) VALUES ('ann', 'h', 'A', ?, ?)").run(now, now);
    old.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('k', 'v', datetime('now'))").run();
    old.close();
    // Crash simulation: the users table was copied to the admin file, main still has everything.
    const data = new Database(file);
    data.exec(attachSql(file));
    const ddl = data.prepare("SELECT sql FROM main.sqlite_master WHERE name = 'users'").get().sql;
    data.exec(ddl.replace(/CREATE TABLE (IF NOT EXISTS )?users/i, 'CREATE TABLE admin.users'));
    data.exec('INSERT INTO admin.users SELECT * FROM main.users');
    data.close();
    const pair = open(file);
    expect(countOf(pair.adminDb, 'users')).toBe(1);
    expect(pair.adminDb.prepare("SELECT count(*) AS c FROM app_settings WHERE key = 'k'").get().c).toBe(1);
    expect(names(pair.db)).not.toContain('users');
  });
});

describe('guard', () => {
  it('throws in test mode for an admin write through the data connection, never for reads or the admin connection', () => {
    const { db, adminDb } = open(tmp());
    expect(() => db.prepare("UPDATE users SET display_name = 'x'")).toThrow(/admin table written through the data connection/);
    expect(() => db.exec('DELETE FROM app_settings')).toThrow(/admin table written/);
    expect(() => db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (1, 1)')).toThrow(/admin table written/);
    expect(() => db.prepare('SELECT count(*) FROM users').get()).not.toThrow();
    expect(() => db.prepare("UPDATE admin.users SET display_name = 'x'").run()).not.toThrow();
    expect(() => adminDb.prepare("UPDATE users SET display_name = 'x'").run()).not.toThrow();
    expect(writesAdminTable('INSERT INTO groups_x VALUES (1)')).toBe(false);
    expect(writesAdminTable('UPDATE clusters SET x = 1')).toBe(false);
  });
});

describe('core.js discipline', () => {
  it('no core step above the version that existed at the split touches an admin table', () => {
    const LAST_BEFORE_SPLIT = 37;
    const re = new RegExp('\\b(' + ADMIN_TABLES.join('|') + ')\\b');
    for (const s of coreMigrations.filter((x) => x.version > LAST_BEFORE_SPLIT)) {
      expect(re.test(s.up.toString()), 'core v' + s.version).toBe(false);
    }
  });
});
