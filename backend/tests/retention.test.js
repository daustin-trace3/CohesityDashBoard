const adminOf = (d) => d.adminHandle || d; // admin tables are written through the admin connection (db/adminSplit.js)
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const db = require('../db/database');
const { setSetting } = require('../services/settings');
const retention = require('../core/retention');

function clearKeys() {
  adminOf(db).prepare("DELETE FROM app_settings WHERE key LIKE 'retention_%' OR key LIKE 'vcenter_%_history_days' OR key LIKE 'vcenter_event_retention_days' OR key LIKE 'lm_%_days' OR key LIKE 'brocade_event_retention_days' OR key LIKE 'zerto_event_retention_days' OR key LIKE 'hyperv_%_days'").run();
}

describe('core/retention resolve', () => {
  beforeEach(clearKeys);

  it('defaults are trending 365 and events 30', () => {
    expect(retention.resolve('pure', 'trending')).toEqual({ days: 365, source: 'default', override: null, global: 365 });
    expect(retention.resolve('pure', 'events')).toEqual({ days: 30, source: 'default', override: null, global: 30 });
  });

  it('a saved global applies to every platform without an override', () => {
    retention.setGlobal('trending', 180);
    expect(retention.resolve('dell', 'trending')).toMatchObject({ days: 180, source: 'global', override: null });
    expect(retention.resolve('netapp', 'trending').days).toBe(180);
    expect(retention.resolve('dell', 'events').days).toBe(30);
  });

  it('a platform override wins over the global', () => {
    retention.setGlobal('events', 60);
    retention.setPlatform('dell', 'events', 14);
    expect(retention.resolve('dell', 'events')).toEqual({ days: 14, source: 'platform', override: 14, global: 60 });
    expect(retention.resolve('pure', 'events').days).toBe(60);
  });

  it('clearing an override returns to inherit', () => {
    retention.setPlatform('dell', 'events', 14);
    retention.setPlatform('dell', 'events', null);
    expect(retention.resolve('dell', 'events').source).toBe('default');
    retention.setPlatform('dell', 'events', 90);
    retention.setPlatform('dell', 'events', '');
    expect(retention.resolve('dell', 'events').override).toBeNull();
  });

  it('0 means keep forever at either level', () => {
    retention.setGlobal('trending', 0);
    expect(retention.days('aws', 'trending')).toBe(0);
    retention.setPlatform('aws', 'trending', 400);
    expect(retention.days('aws', 'trending')).toBe(400);
    retention.setPlatform('aws', 'trending', 0);
    expect(retention.resolve('aws', 'trending')).toMatchObject({ days: 0, source: 'platform', override: 0 });
  });

  it('a stored value outside the range is ignored, never clamped down', () => {
    setSetting('retention_events_days', '3');
    expect(retention.resolve('pure', 'events')).toMatchObject({ days: 30, source: 'default' });
    setSetting('retention_pure_events_days', 'abc');
    expect(retention.resolve('pure', 'events').override).toBeNull();
    setSetting('retention_pure_events_days', '99999');
    expect(retention.resolve('pure', 'events').override).toBeNull();
  });

  it('validate rejects fractions, negatives and out-of-range values', () => {
    expect(retention.validate(12.5, 'events').ok).toBe(false);
    expect(retention.validate(-1, 'events').ok).toBe(false);
    expect(retention.validate(6, 'events').ok).toBe(false);
    expect(retention.validate(7, 'events')).toEqual({ ok: true, days: 7 });
    expect(retention.validate(29, 'trending').ok).toBe(false);
    expect(retention.validate(0, 'trending')).toEqual({ ok: true, days: 0 });
    expect(retention.validate('', 'trending').ok).toBe(false);
    expect(retention.validate('', 'trending', { allowInherit: true })).toEqual({ ok: true, days: null });
    expect(() => retention.setGlobal('events', 5)).toThrow(/7 to 3650/);
    expect(() => retention.resolve('pure', 'nope')).toThrow(/unknown bucket/);
    expect(() => retention.platformKey('../x', 'events')).toThrow(/bad platform/);
  });
});

describe('core/retention prune', () => {
  beforeEach(() => {
    clearKeys();
    db.exec(`DROP TABLE IF EXISTS rt_test; CREATE TABLE rt_test (id INTEGER PRIMARY KEY, src INTEGER, at TEXT, day TEXT, ep INTEGER, epms INTEGER)`);
    const ins = db.prepare('INSERT INTO rt_test (src, at, day, ep, epms) VALUES (?, ?, ?, ?, ?)');
    const now = Date.now();
    for (const ageDays of [1, 10, 40, 100, 500]) {
      const t = now - ageDays * 86400 * 1000;
      const iso = new Date(t).toISOString();
      ins.run(1, iso.slice(0, 19).replace('T', ' '), iso.slice(0, 10), Math.floor(t / 1000), t);
      ins.run(2, iso.slice(0, 19).replace('T', ' '), iso.slice(0, 10), Math.floor(t / 1000), t);
    }
  });

  const count = (src) => db.prepare('SELECT COUNT(*) AS n FROM rt_test' + (src ? ' WHERE src = ' + src : '')).get().n;

  it('deletes rows older than the effective days with the datetime kind', () => {
    retention.setGlobal('events', 30);
    const r = retention.prune(db, { platform: 'dell', bucket: 'events', table: 'rt_test', column: 'at', kind: 'datetime' });
    expect(r).toMatchObject({ days: 30, skipped: false, deleted: 6 });
    expect(count()).toBe(4);
  });

  it('honours an extra where clause and its params', () => {
    retention.setPlatform('dell', 'events', 7);
    retention.prune(db, { platform: 'dell', bucket: 'events', table: 'rt_test', column: 'at', kind: 'datetime', where: 'src = ?', params: [1] });
    expect(count(1)).toBe(1);
    expect(count(2)).toBe(5);
  });

  it('date, iso, epoch_s and epoch_ms kinds agree', () => {
    retention.setGlobal('trending', 60);
    for (const [col, kind] of [['day', 'date'], ['at', 'iso'], ['ep', 'epoch_s'], ['epms', 'epoch_ms']]) {
      db.exec("DELETE FROM rt_test WHERE 0"); // keep rows; each kind must find the same two ages
      const sql = retention.agePredicate(col, kind, 60);
      const n = db.prepare(`SELECT COUNT(*) AS n FROM rt_test WHERE ${sql.sql}`).get(...sql.params).n;
      expect(n, kind).toBe(4); // ages 100 and 500 for both sources
    }
  });

  it('0 skips the delete and reports it', () => {
    retention.setPlatform('dell', 'events', 0);
    const r = retention.prune(db, { platform: 'dell', bucket: 'events', table: 'rt_test', column: 'at' });
    expect(r).toEqual({ deleted: 0, batches: 0, days: 0, skipped: true });
    expect(count()).toBe(10);
  });

  it('refuses a column name with SQL in it', () => {
    expect(() => retention.agePredicate("at; DROP TABLE rt_test", 'datetime', 30)).toThrow(/bad column/);
  });
});

describe('core/retention legacy fold', () => {
  beforeEach(clearKeys);

  it('copies the largest saved legacy value into the platform override once', () => {
    setSetting('vcenter_vm_history_days', '120');
    setSetting('vcenter_daily_history_days', '900');
    setSetting('vcenter_event_retention_days', '45');
    setSetting('lm_alert_retention_days', '200');
    const written = retention.migrateLegacy(adminOf(db));
    expect(written).toEqual(expect.arrayContaining([
      { platform: 'vcenter', bucket: 'trending', days: 900 },
      { platform: 'vcenter', bucket: 'events', days: 45 },
      { platform: 'logicmonitor', bucket: 'events', days: 200 },
    ]));
    expect(retention.resolve('vcenter', 'trending')).toMatchObject({ days: 900, source: 'platform' });
    expect(retention.resolve('logicmonitor', 'trending').source).toBe('default');
    // second run: nothing to do, overrides untouched
    setSetting('vcenter_vm_history_days', '2000');
    expect(retention.migrateLegacy(adminOf(db))).toEqual([]);
    expect(retention.days('vcenter', 'trending')).toBe(900);
  });

  it('ignores legacy values that are blank or out of the bucket range', () => {
    setSetting('brocade_event_retention_days', '');
    setSetting('zerto_event_retention_days', '3');
    expect(retention.migrateLegacy(adminOf(db))).toEqual([]);
  });
});

describe('core/retention coverage', () => {
  it('every covered table exists in the migrated schema, except pack-only platforms absent on this branch', () => {
    const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    const missing = [];
    for (const [platform, buckets] of Object.entries(retention.COVERAGE)) {
      const tables = [...buckets.trending, ...buckets.events];
      const anyPresent = tables.some((t) => have.has(t));
      if (!anyPresent) continue; // platform not on this branch (netbackup/proxmox on feat, eon/hyperv/unifi on icc-phase1)
      for (const t of tables) if (!have.has(t)) missing.push(`${platform}:${t}`);
    }
    expect(missing).toEqual([]);
  });
});
