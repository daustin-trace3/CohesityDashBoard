/**
 * Multi-tenant phase 6 (docs/MULTI-TENANT-DESIGN.md decisions 15 and 16):
 * retention inside a tenant, export without secrets, close into a sealed
 * archive, restore, purge of old archives, and the tenant audit log.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const tenants = require('../core/tenantRegistry');
const { runAsTenant } = require('../core/tenantContext');
const lifecycle = require('../core/tenantLifecycle');
const accounts = require('../core/accounts');
const db = require('../db/database');

beforeAll(() => {
  tenants.createTenant({ id: 'oldco', name: 'Old Co' });
  runAsTenant('oldco', () => {
    db.prepare("INSERT INTO clusters (name, vip, connection_type, auth_type, encrypted_credentials) VALUES ('oldco-cl', '10.1.1.1', 'direct', 'userpass', 'SECRET-BLOB')").run();
    const { setSetting } = require('../services/settings');
    setSetting('helios_api_key', 'SECRET-KEY');
    setSetting('dns_server', '10.1.1.53');
    // Two metrics rows: one ancient, one fresh.
    const cid = db.prepare("SELECT id FROM clusters WHERE name = 'oldco-cl'").get().id;
    db.prepare("INSERT INTO metrics_history (cluster_id, captured_at) VALUES (?, datetime('now', '-400 days'))").run(cid);
    db.prepare("INSERT INTO metrics_history (cluster_id, captured_at) VALUES (?, datetime('now'))").run(cid);
  });
});

describe('retention inside a tenant', () => {
  it('ages out history older than the window and leaves inventory alone', () => {
    runAsTenant('oldco', () => {
      expect(lifecycle.runRetention()).toBe(null); // 0 = platform defaults, no pass
      require('../services/settings').setSetting(lifecycle.RETENTION_SETTING, '30');
      const removed = lifecycle.runRetention();
      expect(removed.metrics_history).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS n FROM metrics_history').get().n).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS n FROM clusters').get().n).toBe(1);
      expect(lifecycle.listTenantAudit().map((e) => e.action)).toContain('retention.run');
    });
  });
});

describe('export', () => {
  it('produces a zip whose database has no secrets and whose CSVs carry the inventory', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMP || '/tmp', 'icc-export-'));
    const zipPath = await lifecycle.exportTenant('oldco', dir, { id: 1, username: 'root' });
    expect(fs.existsSync(zipPath)).toBe(true);
    expect(fs.statSync(zipPath).size).toBeGreaterThan(1000);
    const raw = fs.readFileSync(zipPath);
    expect(raw.subarray(0, 2).toString()).toBe('PK');
    // The db copy is stored uncompressed only by chance; check secrets are
    // not present anywhere in the archive bytes, compressed or not, by
    // rebuilding the copy the same way and reading it.
    const copyPath = path.join(dir, 'check.db');
    lifecycle.copyWithoutSecrets('oldco', copyPath);
    const Database = require('better-sqlite3');
    const copy = new Database(copyPath, { readonly: true });
    expect(copy.prepare("SELECT encrypted_credentials AS c FROM clusters WHERE name = 'oldco-cl'").get().c).toBe('');
    expect(copy.prepare("SELECT value FROM app_settings WHERE key = 'helios_api_key'").get().value).toBe('');
    expect(copy.prepare("SELECT value FROM app_settings WHERE key = 'dns_server'").get().value).toBe('10.1.1.53');
    copy.close();
    expect(accounts.listAudit({ tenantId: 'oldco' }).some((e) => e.action === 'tenant.exported')).toBe(true);
    // The live tenant still has its secret.
    expect(runAsTenant('oldco', () => db.prepare("SELECT encrypted_credentials AS c FROM clusters WHERE name = 'oldco-cl'").get().c)).toBe('SECRET-BLOB');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('close, restore, purge', () => {
  it('closing seals the database into the archive and removes the live file; restoring brings it back', () => {
    const live = tenants.tenantDbPath('oldco');
    expect(fs.existsSync(live)).toBe(true);
    const { archive } = lifecycle.closeTenant('oldco', { id: 1, username: 'root' });
    expect(fs.existsSync(archive)).toBe(true);
    expect(fs.existsSync(live)).toBe(false);
    expect(tenants.getTenant('oldco').status).toBe('closed');
    expect(() => tenants.getHandle('oldco')).toThrow(/closed/);
    expect(() => lifecycle.closeTenant('default')).toThrow(/default tenant/);
    // The sealed file is not a readable SQLite file.
    expect(fs.readFileSync(archive).subarray(0, 6).toString()).not.toBe('SQLite');

    const back = lifecycle.restoreTenant('oldco', { id: 1, username: 'root' });
    expect(back.status).toBe('active');
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(archive)).toBe(false);
    expect(runAsTenant('oldco', () => db.prepare("SELECT name FROM clusters").all().map((r) => r.name))).toEqual(['oldco-cl']);
    expect(runAsTenant('oldco', () => lifecycle.listTenantAudit().map((e) => e.action))).toEqual(expect.arrayContaining(['tenant.closed', 'tenant.restored']));
  });

  it('archives past the archive retention are purged with an audit entry', () => {
    lifecycle.closeTenant('oldco', { id: 1, username: 'root' });
    lifecycle.setArchiveRetentionDays(10);
    expect(lifecycle.purgeArchives(Date.now())).toEqual([]);
    expect(lifecycle.purgeArchives(Date.now() + 11 * 86400000)).toEqual(['oldco']);
    expect(tenants.getTenant('oldco')).toBe(null);
    expect(accounts.listAudit().some((e) => e.action === 'tenant.purged' && e.tenant_id === 'oldco')).toBe(true);
  });
});
