import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { memoByDbState } = require('../core/dbMemo');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbmemo-'));
const file = path.join(dir, 't.db');
const opened = [];
function open() { const d = new Database(file); opened.push(d); return d; }
afterEach(() => { /* handles closed at the end of the file */ });

describe('memoByDbState', () => {
  it('hits when nothing changed, misses after a write on the same connection', () => {
    const a = open();
    a.exec('CREATE TABLE IF NOT EXISTS t (x INTEGER)');
    let calls = 0;
    const fn = () => { calls += 1; return [calls]; };
    const first = memoByDbState(a, 'k', fn);
    expect(memoByDbState(a, 'k', fn)).toBe(first);
    expect(calls).toBe(1);
    a.prepare('INSERT INTO t VALUES (1)').run();
    const second = memoByDbState(a, 'k', fn);
    expect(second).not.toBe(first);
    expect(calls).toBe(2);
  });

  it('misses after a write through a second connection to the same file', () => {
    const a = open();
    const b = open();
    a.exec('CREATE TABLE IF NOT EXISTS t (x INTEGER)');
    let calls = 0;
    const fn = () => { calls += 1; return calls; };
    memoByDbState(a, 'k2', fn);
    memoByDbState(a, 'k2', fn);
    expect(calls).toBe(1);
    b.prepare('INSERT INTO t VALUES (2)').run();
    memoByDbState(a, 'k2', fn);
    expect(calls).toBe(2);
  });

  it('isolates keys', () => {
    const a = open();
    expect(memoByDbState(a, 'one', () => 1)).toBe(1);
    expect(memoByDbState(a, 'two', () => 2)).toBe(2);
    expect(memoByDbState(a, 'one', () => 99)).toBe(1);
  });

  it('keeps at most 64 entries per db', () => {
    const a = open();
    for (let i = 0; i < 70; i += 1) memoByDbState(a, `n${i}`, () => i);
    let reran = false;
    memoByDbState(a, 'n0', () => { reran = true; return 0; });
    expect(reran).toBe(true);
    reran = false;
    memoByDbState(a, 'n69', () => { reran = true; return 69; });
    expect(reran).toBe(false);
  });

  it('works through a handle that lacks pragma()', () => {
    const a = open();
    const thin = { prepare: (s) => a.prepare(s), name: a.name };
    let calls = 0;
    memoByDbState(thin, 'thin', () => { calls += 1; return 1; });
    memoByDbState(thin, 'thin', () => { calls += 1; return 1; });
    expect(calls).toBe(1);
  });

  it('closes handles', () => { for (const d of opened) d.close(); expect(true).toBe(true); });
});
