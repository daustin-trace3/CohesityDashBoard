/**
 * core/dbTransactions.js: IMMEDIATE by default, mode forwarding, nesting, slow log, poller-only busy retry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installTransactionShim } = require('../core/dbTransactions');

let dir; let file; let A; let B;
const mkLogger = () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icc-dbtxn-'));
  file = path.join(dir, 't.db');
  A = new Database(file);
  A.pragma('journal_mode = WAL');
  A.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  B = new Database(file);
  B.pragma('busy_timeout = 0');
});
afterEach(() => {
  try { A.close(); } catch { /* closed */ }
  try { B.close(); } catch { /* closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('installTransactionShim', () => {
  it('default mode takes the write lock before any write (measured with a second connection)', () => {
    installTransactionShim(A, { logger: mkLogger() });
    let code = null;
    A.transaction(() => {
      // No write has happened yet; an IMMEDIATE transaction already holds the lock.
      try { B.prepare('BEGIN IMMEDIATE').run(); } catch (e) { code = e.code; try { B.exec('ROLLBACK'); } catch { /* none open */ } }
    })();
    expect(code).toBe('SQLITE_BUSY');
  });

  it('the deferred mode does not hold the lock up front, and every mode name still forwards', () => {
    installTransactionShim(A, { logger: mkLogger() });
    const txn = A.transaction(() => {
      let ok = true;
      try { B.prepare('BEGIN IMMEDIATE').run(); } catch { ok = false; } finally { try { B.exec('ROLLBACK'); } catch { /* none */ } }
      return ok;
    });
    expect(txn.deferred()).toBe(true);
    expect(txn.default()).toBe(true);
    expect(txn.immediate()).toBe(false);
    expect(txn.exclusive()).toBe(false);
    expect(txn()).toBe(false);
  });

  it('nested runners commit both writes', () => {
    installTransactionShim(A, { logger: mkLogger() });
    const inner = A.transaction((v) => { A.prepare('INSERT INTO t (v) VALUES (?)').run(v); });
    const outer = A.transaction(() => { A.prepare('INSERT INTO t (v) VALUES (?)').run('outer'); inner('inner'); inner.immediate('inner2'); });
    outer();
    expect(A.prepare('SELECT v FROM t ORDER BY id').all().map((r) => r.v)).toEqual(['outer', 'inner', 'inner2']);
  });

  it('logs one slow-transaction line naming the definition site', () => {
    const logger = mkLogger();
    installTransactionShim(A, { logger, slowMs: 1 });
    A.transaction(() => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); })();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const line = logger.warn.mock.calls[0][0];
    expect(line).toContain('slow transaction');
    expect(line).toContain('dbTransactions.test.js');
  });

  it('poller role retries a SQLITE_BUSY run once and returns the value', () => {
    const logger = mkLogger();
    installTransactionShim(A, { logger, role: 'poller', busyRetries: 1 });
    let calls = 0;
    const run = A.transaction(() => {
      calls += 1;
      if (calls === 1) { const e = new Error('busy'); e.code = 'SQLITE_BUSY'; throw e; }
      return 'done';
    });
    expect(run()).toBe('done');
    expect(calls).toBe(2);
    const retries = logger.warn.mock.calls.filter((c) => String(c[0]).includes('busy, retry'));
    expect(retries).toHaveLength(1);
    expect(retries[0][0]).toContain('retry 1 of 1');
  });

  it('web role throws at once', () => {
    const logger = mkLogger();
    installTransactionShim(A, { logger, role: 'web', busyRetries: 3 });
    let calls = 0;
    const run = A.transaction(() => { calls += 1; const e = new Error('busy'); e.code = 'SQLITE_BUSY'; throw e; });
    expect(() => run()).toThrow('busy');
    expect(calls).toBe(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('a non-busy error is never retried', () => {
    installTransactionShim(A, { logger: mkLogger(), role: 'poller', busyRetries: 2 });
    let calls = 0;
    const run = A.transaction(() => { calls += 1; throw new Error('boom'); });
    expect(() => run()).toThrow('boom');
    expect(calls).toBe(1);
  });
});

describe('anchor mode (data file with the admin file attached)', () => {
  let adminFile; let admin2;
  beforeEach(() => {
    adminFile = path.join(dir, 't.admin.db');
    const seed = new Database(adminFile);
    seed.pragma('journal_mode = WAL');
    seed.exec('CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT)');
    seed.close();
    A.exec("ATTACH DATABASE '" + adminFile.replace(/\\/g, '/') + "' AS admin");
    A.exec('CREATE TABLE icc_txn_anchor (n INTEGER NOT NULL)');
    A.exec('INSERT INTO icc_txn_anchor (n) VALUES (0)');
    admin2 = new Database(adminFile);
    admin2.pragma('busy_timeout = 300');
    B.pragma('busy_timeout = 300');
  });
  afterEach(() => { try { admin2.close(); } catch { /* closed */ } });

  const tryWrite = (conn, sql) => { try { conn.prepare(sql).run(); return null; } catch (e) { return e.code; } };

  it('a default transaction holds the data write lock but leaves the admin file writable', () => {
    installTransactionShim(A, { logger: mkLogger(), anchor: true });
    let dataCode; let adminCode;
    A.transaction(() => {
      dataCode = tryWrite(B, "INSERT INTO t (v) VALUES ('x')");
      adminCode = tryWrite(admin2, "INSERT INTO a (v) VALUES ('x')");
    })();
    expect(dataCode).toBe('SQLITE_BUSY');
    expect(adminCode).toBeNull();
  });

  it('immediate and default modes behave the same way', () => {
    installTransactionShim(A, { logger: mkLogger(), anchor: true });
    for (const mode of ['immediate', 'default']) {
      let dataCode; let adminCode;
      const txn = A.transaction(() => {
        dataCode = tryWrite(B, "INSERT INTO t (v) VALUES ('x')");
        adminCode = tryWrite(admin2, "INSERT INTO a (v) VALUES ('y')");
      });
      txn[mode]();
      expect(dataCode).toBe('SQLITE_BUSY');
      expect(adminCode).toBeNull();
    }
  });

  it('a nested runner does not touch the anchor again', () => {
    installTransactionShim(A, { logger: mkLogger(), anchor: true });
    const inner = A.transaction(() => { A.prepare('INSERT INTO t (v) VALUES (?)').run('inner'); });
    A.transaction(() => { inner(); inner.immediate(); })();
    expect(A.prepare('SELECT n FROM icc_txn_anchor').get().n).toBe(1);
    expect(A.prepare('SELECT count(*) AS c FROM t').get().c).toBe(2);
  });

  it('the plain shim on a connection with an attachment blocks the admin file (why anchor mode exists)', () => {
    installTransactionShim(A, { logger: mkLogger() });
    let adminCode;
    A.transaction(() => { adminCode = tryWrite(admin2, "INSERT INTO a (v) VALUES ('x')"); })();
    expect(adminCode).toBe('SQLITE_BUSY');
  });

  it('an anchored body that writes an admin table commits to both files', () => {
    installTransactionShim(A, { logger: mkLogger(), anchor: true });
    A.transaction(() => {
      A.prepare("INSERT INTO t (v) VALUES ('d')").run();
      A.prepare("INSERT INTO admin.a (v) VALUES ('a')").run();
    })();
    expect(A.prepare('SELECT count(*) AS c FROM t').get().c).toBe(1);
    expect(admin2.prepare('SELECT count(*) AS c FROM a').get().c).toBe(1);
  });
});
