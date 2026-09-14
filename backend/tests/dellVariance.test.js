import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { fingerprint, syncVariances } from '../services/dellVariance.js';

const detail = [
  { group: 'BIOS', attribute: 'BootMode', expected: 'Uefi', current: 'Bios', reason: 'differs' },
  { group: 'NIC', attribute: 'SriovGlobalEnable', expected: 'Enabled', current: 'Disabled', reason: 'differs' },
];

function mkdb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE dell_config_variances (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ome_id INTEGER, baseline_id INTEGER, device_id INTEGER,
    service_tag TEXT, device_name TEXT, reason TEXT, accepted_by TEXT, accepted_at TEXT,
    fingerprint TEXT, drift_count INTEGER, state TEXT DEFAULT 'active', stale_at TEXT)`);
  db.prepare(`INSERT INTO dell_config_variances (ome_id, baseline_id, device_id, reason, fingerprint, drift_count)
    VALUES (1, 7, 42, 'known', ?, 2)`).run(fingerprint(detail));
  return db;
}
const state = (db) => db.prepare('SELECT state, stale_at FROM dell_config_variances WHERE id = 1').get();

describe('dell config variance fingerprint', () => {
  it('is order-insensitive and ignores the reason text', () => {
    const a = fingerprint(detail);
    const b = fingerprint([{ ...detail[1], reason: 'other' }, { ...detail[0] }]);
    expect(a).toBe(b);
  });
  it('changes when a current value changes or an attribute is added', () => {
    const a = fingerprint(detail);
    expect(fingerprint([detail[0], { ...detail[1], current: 'Enabled' }])).not.toBe(a);
    expect(fingerprint([...detail, { group: 'iDRAC', attribute: 'NTP', expected: 'a', current: 'b' }])).not.toBe(a);
  });
});

describe('syncVariances', () => {
  let db;
  beforeEach(() => { db = mkdb(); });

  it('keeps an accepted variance active while the drift is unchanged', () => {
    const r = syncVariances(db, 1, [{ baselineId: 7, deviceId: 42, status: 'noncompliant', detail }]);
    expect(r).toEqual({ stale: 0, reactivated: 0 });
    expect(state(db).state).toBe('active');
  });
  it('marks the variance stale when the config drifts further', () => {
    const changed = [...detail, { group: 'iDRAC', attribute: 'NTP', expected: 'a', current: 'b' }];
    const r = syncVariances(db, 1, [{ baselineId: 7, deviceId: 42, status: 'noncompliant', detail: changed }]);
    expect(r.stale).toBe(1);
    expect(state(db).state).toBe('stale');
    expect(state(db).stale_at).toBeTruthy();
  });
  it('reactivates a stale variance when the drift returns to the accepted shape', () => {
    db.prepare("UPDATE dell_config_variances SET state = 'stale', stale_at = '2026-01-01 00:00:00'").run();
    const r = syncVariances(db, 1, [{ baselineId: 7, deviceId: 42, status: 'noncompliant', detail }]);
    expect(r.reactivated).toBe(1);
    expect(state(db)).toEqual({ state: 'active', stale_at: null });
  });
  it('leaves the variance alone when the device is compliant, missing, or has no detail', () => {
    syncVariances(db, 1, [{ baselineId: 7, deviceId: 42, status: 'compliant', detail: null }]);
    expect(state(db).state).toBe('active');
    syncVariances(db, 1, []);
    expect(state(db).state).toBe('active');
    syncVariances(db, 1, [{ baselineId: 7, deviceId: 42, status: 'noncompliant', detail: null }]);
    expect(state(db).state).toBe('active');
  });
  it('does not touch variances of another OME', () => {
    syncVariances(db, 2, [{ baselineId: 7, deviceId: 42, status: 'noncompliant', detail: [] }]);
    expect(state(db).state).toBe('active');
  });
});
