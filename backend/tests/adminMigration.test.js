import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const adminMigrations = require('../db/migrations/admin');

const v1 = adminMigrations.find((m) => m.version === 1);
let db;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, is_system INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE role_grants (id INTEGER PRIMARY KEY AUTOINCREMENT, subject_type TEXT NOT NULL, subject_id INTEGER NOT NULL,
      permission TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (subject_type, subject_id, permission));
    CREATE TABLE service_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, permissions TEXT NOT NULL);
  `);
  for (const n of ['Admin', 'Operator', 'Viewer']) db.prepare('INSERT INTO groups (name, is_system) VALUES (?, 1)').run(n);
  db.prepare('INSERT INTO groups (name, is_system) VALUES (?, 0)').run('custom');
});

const gid = (name) => db.prepare('SELECT id FROM groups WHERE name = ?').get(name).id;
const grantsOf = (type, id) => db.prepare(
  'SELECT permission FROM role_grants WHERE subject_type = ? AND subject_id = ? ORDER BY permission'
).all(type, id).map((r) => r.permission);
const add = (type, id, p) => db.prepare(
  "INSERT INTO role_grants (subject_type, subject_id, permission, created_at) VALUES (?, ?, ?, 'x')"
).run(type, id, p);

describe('admin scope migration v1', () => {
  it('exists as admin version 1', () => {
    expect(v1).toBeTruthy();
  });

  it('copies wildcard-namespace grants to admin:, for groups and users', () => {
    add('group', gid('Admin'), '*:*:*');
    add('group', gid('custom'), '*:*:view');
    add('user', 7, '*:users:manage');
    add('group', gid('custom'), 'pure:*:view');
    v1.up(db);
    expect(grantsOf('group', gid('Admin'))).toEqual(['*:*:*', 'admin:*:*']);
    expect(grantsOf('group', gid('custom'))).toEqual(['*:*:view', 'admin:*:view', 'pure:*:view']);
    expect(grantsOf('user', 7)).toEqual(['*:users:manage', 'admin:users:manage']);
  });

  it('expands service account permission JSON and leaves others untouched', () => {
    db.prepare("INSERT INTO service_accounts (name, permissions) VALUES ('a', ?)").run(JSON.stringify(['*:*:*', 'pure:*:view']));
    db.prepare("INSERT INTO service_accounts (name, permissions) VALUES ('b', ?)").run(JSON.stringify(['pure:*:view']));
    db.prepare("INSERT INTO service_accounts (name, permissions) VALUES ('c', 'not json')").run();
    v1.up(db);
    const rows = db.prepare('SELECT name, permissions FROM service_accounts ORDER BY name').all();
    expect(JSON.parse(rows[0].permissions)).toEqual(['*:*:*', 'pure:*:view', 'admin:*:*']);
    expect(JSON.parse(rows[1].permissions)).toEqual(['pure:*:view']);
    expect(rows[2].permissions).toBe('not json');
  });

  it('gives the system Viewer and Operator groups the platform wildcard and no admin grant', () => {
    v1.up(db);
    expect(grantsOf('group', gid('Viewer'))).toEqual(['*:*:view']);
    expect(grantsOf('group', gid('Operator'))).toEqual(['*:*:manage']);
  });

  it('running it twice changes nothing', () => {
    add('group', gid('Admin'), '*:*:*');
    db.prepare("INSERT INTO service_accounts (name, permissions) VALUES ('a', ?)").run(JSON.stringify(['*:*:view']));
    v1.up(db);
    const snap = () => JSON.stringify([
      db.prepare('SELECT subject_type, subject_id, permission FROM role_grants ORDER BY id').all(),
      db.prepare('SELECT permissions FROM service_accounts ORDER BY id').all(),
    ]);
    const first = snap();
    v1.up(db);
    expect(snap()).toBe(first);
  });
});
