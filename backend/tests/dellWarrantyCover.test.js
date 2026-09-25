import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { warrantyAlertFilter } from '../services/dellWarrantyCover.js';

function mkdb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dell_warranties (ome_id INTEGER, service_tag TEXT, days_remaining INTEGER);
    CREATE TABLE dell_devices (ome_id INTEGER, name TEXT, service_tag TEXT);
  `);
  const w = db.prepare('INSERT INTO dell_warranties VALUES (?, ?, ?)');
  // RENEWED: lapsed base warranty plus an active ProSupport renewal.
  w.run(1, 'RENEWED', -120); w.run(1, 'RENEWED', 700);
  // ENDING: every contract inside the window.
  w.run(1, 'ENDING', 12); w.run(1, 'ENDING', -300);
  // Same tag on another OME with nothing active.
  w.run(2, 'RENEWED', -5);
  db.prepare('INSERT INTO dell_devices VALUES (1, ?, ?)').run('esx-renewed', 'RENEWED');
  return db;
}
const alert = (o) => ({ ome_id: 1, category: 'System Health', subcategory: null, message: '', service_tag: null, device_name: null, ...o });

describe('dell OME warranty alert cover', () => {
  const keep = warrantyAlertFilter(mkdb(), 90);

  it('drops a warranty alert when the tag has a contract outside the window', () => {
    expect(keep(alert({ service_tag: 'RENEWED', message: 'Warranty for device RENEWED has expired.' }))).toBe(false);
    expect(keep(alert({ service_tag: 'renewed', subcategory: 'Warranty', message: 'Support contract expires in 10 days' }))).toBe(false);
  });

  it('keeps a warranty alert when every contract is inside the window', () => {
    expect(keep(alert({ service_tag: 'ENDING', message: 'Warranty expires in 12 days' }))).toBe(true);
  });

  it('resolves the tag through the device name when the alert carries none', () => {
    expect(keep(alert({ device_name: 'ESX-Renewed', message: 'Warranty has expired' }))).toBe(false);
    expect(keep(alert({ device_name: 'unknown-host', message: 'Warranty has expired' }))).toBe(true);
  });

  it('is scoped per OME and leaves non-warranty alerts alone', () => {
    expect(keep(alert({ ome_id: 2, service_tag: 'RENEWED', message: 'Warranty has expired' }))).toBe(true);
    expect(keep(alert({ service_tag: 'RENEWED', message: 'Power supply redundancy lost' }))).toBe(true);
  });

  it('keeps everything when the window is wider than every contract', () => {
    const keepAll = warrantyAlertFilter(mkdb(), 365 * 3);
    expect(keepAll(alert({ service_tag: 'RENEWED', message: 'Warranty has expired' }))).toBe(true);
  });
});
