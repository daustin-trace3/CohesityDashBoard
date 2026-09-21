/**
 * Cohesity's alert payload carries alertCategory (kDisk, kNode,
 * kBackupRestore, ...) -- the per-alert-type notification catalog's type
 * source for Cohesity (see services/alertNotifier.js collectCohesityAlerts).
 * upsertAlerts must store it on insert and refresh it on conflict.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { _upsertAlerts } = require('../services/poller');

let cluster;
const alert = (id, category) => ({
  id, severity: 'kCritical', alertState: 'kOpen', alertType: 'kTest',
  alertCategory: category, firstTimestampUsecs: 1700000000000000,
});
const category = (id) => db.prepare(
  'SELECT alert_category FROM alerts WHERE cluster_id = ? AND cohesity_alert_id = ?'
).get(cluster.id, id)?.alert_category;

beforeEach(() => {
  db.exec("DELETE FROM clusters WHERE name = 'alert-category-az'");
  const id = db.prepare(`
    INSERT INTO clusters (name, vip, connection_type, auth_type, encrypted_credentials)
    VALUES ('alert-category-az', '43', 'helios', 'apikey', 'enc')
  `).run().lastInsertRowid;
  cluster = { id };
});

describe('upsertAlerts alert_category', () => {
  it('stores alertCategory on insert', () => {
    _upsertAlerts(cluster, [alert('a', 'kBackupRestore')]);
    expect(category('a')).toBe('kBackupRestore');
  });

  it('updates alertCategory on conflict (re-poll of an existing alert)', () => {
    _upsertAlerts(cluster, [alert('a', 'kDisk')]);
    expect(category('a')).toBe('kDisk');
    _upsertAlerts(cluster, [alert('a', 'kNode')]);
    expect(category('a')).toBe('kNode');
  });

  it('leaves alert_category NULL when the payload has none', () => {
    _upsertAlerts(cluster, [alert('a', undefined)]);
    expect(category('a')).toBeNull();
  });
});
