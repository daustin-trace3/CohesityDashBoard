/**
 * Runs the real seedDemo.js as a child process against a throwaway temp DB
 * (so it doesn't collide with the ENCRYPTION_KEY / DASHBOARD_DB_PATH this
 * test suite already stubs via tests/setup.js — see that file's note on why
 * dotenv can't override env vars set before it loads), then opens the
 * resulting SQLite file directly and asserts volumes + a few key enums.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import Database from 'better-sqlite3';

const backendDir = path.join(__dirname, '..');
const seedScript = path.join(backendDir, 'demo', 'seedDemo.js');

let tmpDir;
let dbPath;
let db;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icc-seed-demo-test-'));
  dbPath = path.join(tmpDir, 'seed-test.db');

  execFileSync(process.execPath, [seedScript, '--db', dbPath, '--force'], {
    cwd: backendDir,
    env: process.env,
    stdio: 'pipe',
  });

  db = new Database(dbPath, { readonly: true });
}, 120000);

afterAll(() => {
  if (db) db.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* win file locks */ }
});

describe('seedDemo.js', () => {
  it('seeds 24 cohesity clusters', () => {
    const row = db.prepare('SELECT COUNT(*) c FROM clusters').get();
    expect(row.c).toBe(24);
  });

  it('seeds 20 pure arrays', () => {
    const row = db.prepare('SELECT COUNT(*) c FROM pure_arrays').get();
    expect(row.c).toBe(20);
  });

  it('seeds 6 netapp arrays', () => {
    const row = db.prepare('SELECT COUNT(*) c FROM netapp_arrays').get();
    expect(row.c).toBe(6);
  });

  it('seeds more than 5000 metrics_history rows', () => {
    const row = db.prepare('SELECT COUNT(*) c FROM metrics_history').get();
    expect(row.c).toBeGreaterThan(5000);
  });

  it('seeds the demo user', () => {
    const row = db.prepare("SELECT username FROM users WHERE username = 'demo'").get();
    expect(row).toBeTruthy();
  });

  it('seeds 30 cohesity_views matching license_view_detail names', () => {
    const views = db.prepare('SELECT COUNT(*) c FROM cohesity_views').get();
    expect(views.c).toBe(30);
    const orphans = db.prepare(`
      SELECT COUNT(*) c FROM cohesity_views v
      WHERE NOT EXISTS (SELECT 1 FROM license_view_detail d WHERE d.view_name = v.name)
    `).get();
    expect(orphans.c).toBe(0);
    const flagged = db.prepare('SELECT COUNT(*) c FROM cohesity_views WHERE is_read_only = 0 AND (protected = 0 OR replicated_out = 0 OR datalock_mode IS NULL)').get();
    expect(flagged.c).toBeGreaterThan(0);
  });

  it('seeds policy replication_targets as arrays of strings', () => {
    const rows = db.prepare("SELECT replication_targets FROM policies WHERE replication_targets != '[]'").all();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      for (const t of JSON.parse(r.replication_targets)) expect(typeof t).toBe('string');
    }
  });

  it('seeds a protection_run with status kSuccess', () => {
    const row = db.prepare("SELECT id FROM protection_runs WHERE status = 'kSuccess' LIMIT 1").get();
    expect(row).toBeTruthy();
  });

  it('seeds alerts with lowercase severity', () => {
    const row = db.prepare('SELECT severity FROM alerts LIMIT 1').get();
    expect(row.severity).toBe(row.severity.toLowerCase());
    expect(['critical', 'warning', 'info']).toContain(row.severity);
  });

  it('seeds platform flags as string "1"', () => {
    const rows = db.prepare(
      "SELECT key, value FROM app_settings WHERE key IN ('platform_pure_enabled', 'platform_netapp_enabled')"
    ).all();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.value).toBe('1');
    }
  });
});
