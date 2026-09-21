/**
 * Cohesity alerts: the cluster only ever reports OPEN alerts, so one that was
 * resolved there, or that has not fired inside the alert window, just stops
 * coming back. ICC closes those itself and reopens them if they fire again.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { _upsertAlerts } = require('../services/poller');
const { ALERTS_FETCH_MAX } = require('../services/cohesityApi');
const { setSetting, getCohesityAlertWindowDays } = require('../services/settings');

let cluster;
const alert = (id, severity = 'kCritical') => ({ id, severity, alertState: 'kOpen', alertType: 'kTest', firstTimestampUsecs: 1700000000000000 });
const state = () => Object.fromEntries(db.prepare('SELECT cohesity_alert_id id, resolved, dismissed, closed_reason FROM alerts WHERE cluster_id = ?').all(cluster.id)
  .map((r) => [r.id, `${r.resolved}${r.dismissed}${r.closed_reason || ''}`]));

beforeEach(() => {
  db.exec("DELETE FROM clusters WHERE name = 'alert-window-az'");
  const id = db.prepare(`
    INSERT INTO clusters (name, vip, connection_type, auth_type, encrypted_credentials)
    VALUES ('alert-window-az', '42', 'helios', 'apikey', 'enc')
  `).run().lastInsertRowid;
  cluster = { id };
});

describe('upsertAlerts close-out', () => {
  it('closes an alert the cluster stops reporting and reopens it when it fires again', () => {
    _upsertAlerts(cluster, [alert('a'), alert('b')]);
    expect(state()).toEqual({ a: '00', b: '00' });

    _upsertAlerts(cluster, [alert('a')]);
    expect(state()).toEqual({ a: '00', b: '10not_reported' });

    _upsertAlerts(cluster, [alert('a'), alert('b')]);
    expect(state()).toEqual({ a: '00', b: '00' });
  });

  it('an empty answer closes everything open, and a dismissed alert keeps its own flag', () => {
    _upsertAlerts(cluster, [alert('a'), alert('b')]);
    db.prepare("UPDATE alerts SET dismissed = 1 WHERE cluster_id = ? AND cohesity_alert_id = 'b'").run(cluster.id);
    _upsertAlerts(cluster, { alerts: [] });
    expect(state()).toEqual({ a: '10not_reported', b: '11not_reported' });
  });

  it('an answer cut off at the fetch limit proves nothing, so nothing is closed', () => {
    _upsertAlerts(cluster, [alert('keep-me')]);
    const full = Array.from({ length: ALERTS_FETCH_MAX }, (_, i) => alert(`bulk-${i}`, 'kInfo'));
    _upsertAlerts(cluster, full);
    expect(state()['keep-me']).toBe('00');
  });
});

describe('alert window setting', () => {
  it('defaults to 5 days, accepts 0 to 365, and falls back on a bad value', () => {
    setSetting('cohesity_alert_window_days', '');
    expect(getCohesityAlertWindowDays()).toBe(0);
    setSetting('cohesity_alert_window_days', '14');
    expect(getCohesityAlertWindowDays()).toBe(14);
    setSetting('cohesity_alert_window_days', '999');
    expect(getCohesityAlertWindowDays()).toBe(5);
    setSetting('cohesity_alert_window_days', '5');
  });
});
