import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { pruneInBatches } = require('../core/dbPrune');

describe('pruneInBatches', () => {
  let dir;
  let db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbprune-'));
    db = new Database(path.join(dir, 't.db'));
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE hist (id INTEGER PRIMARY KEY, ts INTEGER, v TEXT)');
    const ins = db.prepare('INSERT INTO hist (ts, v) VALUES (?, ?)');
    db.transaction(() => {
      for (let i = 0; i < 12000; i += 1) ins.run(i < 6000 ? 1 : 100, 'x');
    })();
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('deletes old rows in batches and stops on a short batch', () => {
    const r = pruneInBatches(db, 'hist', 'ts < ?', [50], { batch: 5000 });
    expect(r).toEqual({ deleted: 6000, batches: 2 });
    expect(db.prepare('SELECT COUNT(*) c FROM hist').get().c).toBe(6000);
  });

  it('second call deletes nothing in one batch', () => {
    pruneInBatches(db, 'hist', 'ts < ?', [50], { batch: 5000 });
    expect(pruneInBatches(db, 'hist', 'ts < ?', [50], { batch: 5000 })).toEqual({ deleted: 0, batches: 1 });
  });

  it('rejects an invalid table name', () => {
    expect(() => pruneInBatches(db, 'hist; DROP TABLE hist', '1=1')).toThrow();
    expect(() => pruneInBatches(db, 'Hist', '1=1')).toThrow();
  });

  it('maxBatches stops early', () => {
    const r = pruneInBatches(db, 'hist', 'ts < ?', [50], { batch: 1000, maxBatches: 2 });
    expect(r).toEqual({ deleted: 2000, batches: 2 });
  });

  it('works without params', () => {
    const r = pruneInBatches(db, 'hist', '1=1', undefined, { batch: 5000 });
    expect(r.deleted).toBe(12000);
  });

  it('every pruned table in services has a rowid', () => {
    const fs2 = require('fs');
    const svc = path.join(__dirname, '..', 'services');
    const tables = new Set();
    const walk = (d) => {
      for (const e of fs2.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) {
          const src = fs2.readFileSync(p, 'utf8');
          for (const m of src.matchAll(/pruneInBatches\(\s*\w+,\s*'([a-z0-9_]+)'/g)) tables.add(m[1]);
        }
      }
    };
    walk(svc);
    expect(tables.size).toBeGreaterThan(10);
    // Schema DDL lives in migrations / db setup; assert none declares WITHOUT ROWID for these tables.
    const ddlRoots = [path.join(__dirname, '..', 'db'), path.join(__dirname, '..', 'core'), svc, path.join(__dirname, '..', 'migrations')];
    const withoutRowid = [];
    const scan = (d) => {
      if (!fs2.existsSync(d)) return;
      for (const e of fs2.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') scan(p); } else if (e.name.endsWith('.js')) {
          const src = fs2.readFileSync(p, 'utf8');
          for (const m of src.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z0-9_]+)[^;]*?WITHOUT ROWID/gi)) withoutRowid.push(m[1]);
        }
      }
    };
    ddlRoots.forEach(scan);
    for (const t of tables) expect(withoutRowid).not.toContain(t);
  });
});
