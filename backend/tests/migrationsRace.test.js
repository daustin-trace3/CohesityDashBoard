/**
 * Two ICC processes boot at the same time after a pull and both see the same
 * pending migration list. The loser must skip the step, never fail on the
 * schema_migrations primary key (CG box, logicmonitor v17, 2026-11-09).
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runMigrations } from '../core/migrations.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icc-mig-race-'));
  return path.join(dir, 'race.db');
}

describe('migration runner under a two-process race', () => {
  it('skips a step another process recorded before this one took the lock', () => {
    const file = tmpDb();
    const a = new Database(file);
    const b = new Database(file);
    a.pragma('journal_mode = WAL');
    a.pragma('busy_timeout = 5000');
    b.pragma('busy_timeout = 5000');

    runMigrations(a, 't', [{ version: 1, up: (db) => db.exec('CREATE TABLE IF NOT EXISTS x (id INTEGER)') }]);

    let ranOnA = 0;
    const steps = [
      { version: 1, up: () => { throw new Error('v1 must not rerun'); } },
      {
        version: 2,
        up: (db) => {
          ranOnA += 1;
          db.exec('CREATE TABLE IF NOT EXISTS y (id INTEGER)');
        },
      },
    ];

    // Process B wins the race: it applies and records v2 while A has already
    // computed its pending list but not yet taken the write lock.
    runMigrations(b, 't', steps.map((s) => ({ ...s, up: s.version === 2 ? (db) => db.exec('CREATE TABLE IF NOT EXISTS y (id INTEGER)') : s.up })));
    expect(b.prepare("SELECT version FROM schema_migrations WHERE scope = 't' ORDER BY version").all().map((r) => r.version)).toEqual([1, 2]);

    // A's run: MAX(version) now reads 2 so nothing is pending; the real race
    // is the window between that read and the step, covered next.
    expect(() => runMigrations(a, 't', steps)).not.toThrow();
    expect(ranOnA).toBe(0);

    // Same window reproduced in one process: the step's own up() stands in for
    // the other process recording the version mid-run. The runner must not
    // throw on its INSERT afterwards and must record the version exactly once.
    const c = new Database(tmpDb());
    runMigrations(c, 't', [{ version: 1, up: () => {} }]);
    const racy = [{
      version: 2,
      up: (db) => {
        db.prepare("INSERT INTO schema_migrations (scope, version, applied_at) VALUES ('t', 2, 'other-process')").run();
      },
    }];
    expect(() => runMigrations(c, 't', racy)).not.toThrow();
    const rows = c.prepare("SELECT version, applied_at FROM schema_migrations WHERE scope = 't' AND version = 2").all();
    expect(rows).toHaveLength(1);
    expect(rows[0].applied_at).toBe('other-process');

    // noTransaction steps follow the same rule.
    const d = new Database(tmpDb());
    const racyNoTx = [{
      version: 1,
      noTransaction: true,
      up: (db) => {
        db.prepare("INSERT INTO schema_migrations (scope, version, applied_at) VALUES ('t', 1, 'other-process')").run();
      },
    }];
    expect(() => runMigrations(d, 't', racyNoTx)).not.toThrow();
    expect(d.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE scope = 't'").get().n).toBe(1);

    a.close(); b.close(); c.close(); d.close();
  });

  it('still records and runs pending steps in order on a quiet database', () => {
    const db = new Database(tmpDb());
    const order = [];
    runMigrations(db, 'q', [
      { version: 2, up: () => order.push(2) },
      { version: 1, up: () => order.push(1) },
    ]);
    expect(order).toEqual([1, 2]);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE scope = 'q' ORDER BY version").all().map((r) => r.version)).toEqual([1, 2]);
    runMigrations(db, 'q', [{ version: 1, up: () => { throw new Error('rerun'); } }]);
    db.close();
  });
});
