/**
 * services/walCheckpoint.js checkpointOnce on a temp WAL database.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkpointOnce } = require('../services/walCheckpoint');

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icc-wal-'));
  const file = path.join(dir, 'w.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');   // let the log build up
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  const ins = db.prepare('INSERT INTO t (v) VALUES (?)');
  db.transaction(() => { for (let i = 0; i < 4000; i++) ins.run('x'.repeat(200)); })();
  try { return fn(db, file); } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('checkpointOnce', () => {
  it('passive below the threshold returns the full shape', () => {
    withDb((db, file) => {
      const r = checkpointOnce(db, file, { truncateAboveBytes: 1024 * 1024 * 1024 });
      expect(r.mode).toBe('passive');
      expect(r.checkpointed).toBeGreaterThanOrEqual(0);
      expect(r).toHaveProperty('busy');
      expect(r).toHaveProperty('log');
      expect(r.walBytesBefore).toBeGreaterThan(0);
    });
  });

  it('truncates a log above the threshold down to zero bytes', () => {
    withDb((db, file) => {
      const r = checkpointOnce(db, file, { truncateAboveBytes: 0 });
      expect(r.mode).toBe('truncate');
      expect(r.walBytesBefore).toBeGreaterThan(0);
      expect(r.walBytesAfter).toBe(0);
    });
  });
});
