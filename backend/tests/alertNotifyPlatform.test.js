/**
 * Per-platform alert email settings (owner spec, 2026-09-21): a platform with
 * its own recipients sends only to those; a platform with blank recipients
 * falls back to the Global Settings default; both blank sends nothing and
 * writes no alert_notifications row. A platform's minimum severity overrides
 * the global one, or inherits it when unset. A disabled (platform, type) is
 * never emailed, but other types on the same platform still are. The type
 * catalog is populated as alerts are seen, and Service Status (collectOpenAlerts)
 * is unaffected by mutes, severity or recipients.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const alertNotifier = require('../services/alertNotifier');
const { setSetting } = require('../services/settings');
const registry = require('../core/registry');

// collectOpenAlerts gates cohesity on registry.isBuiltinPresent when there is
// no registry entry for it (app.js normally calls this at boot).
registry.markBuiltin('cohesity');

let seq = 0;
function nextName(prefix) { seq += 1; return `${prefix}-${seq}`; }

function insertCluster() {
  const name = nextName('cluster');
  const info = db.prepare(`
    INSERT INTO clusters (name, connection_type, auth_type, encrypted_credentials)
    VALUES (?, 'direct', 'apikey', 'x')
  `).run(name);
  return info.lastInsertRowid;
}

function insertCohesityAlert(clusterId, { alertId, severity, alertCategory = null, description = 'issue' }) {
  db.prepare(`
    INSERT INTO alerts (cluster_id, cohesity_alert_id, severity, alert_type, alert_category, description, resolved, dismissed, first_seen, last_updated)
    VALUES (?, ?, ?, 'kTest', ?, ?, 0, 0, datetime('now'), datetime('now'))
  `).run(clusterId, alertId, severity, alertCategory, description);
}

function insertNetappArray() {
  const name = nextName('netapp-array');
  const info = db.prepare(`
    INSERT INTO netapp_arrays (name, mgmt_host, username, encrypted_credentials)
    VALUES (?, 'host', 'user', 'x')
  `).run(name);
  return info.lastInsertRowid;
}

function insertNetappAlert(arrayId, { alertKey, severity, message = 'netapp issue', source = 'health' }) {
  db.prepare(`
    INSERT INTO netapp_alerts (array_id, alert_key, severity, node_name, source, message)
    VALUES (?, ?, ?, 'node1', ?, ?)
  `).run(arrayId, alertKey, severity, source, message);
}

function setPlatformOverride(platform, { recipients, minSeverity } = {}) {
  db.prepare(`
    INSERT INTO alert_notify_platform (platform, recipients, min_severity, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(platform) DO UPDATE SET recipients = excluded.recipients, min_severity = excluded.min_severity, updated_at = excluded.updated_at
  `).run(platform, recipients ?? '', minSeverity ?? null);
}

function muteType(platform, type) {
  db.prepare('UPDATE alert_notify_types SET enabled = 0 WHERE platform = ? AND type = ?').run(platform, type);
}

function typeRow(platform, type) {
  return db.prepare('SELECT * FROM alert_notify_types WHERE platform = ? AND type = ?').get(platform, type);
}

function configureSmtp(overrides = {}) {
  const defaults = {
    smtp_enabled: '1',
    smtp_host: 'smtp.example.com',
    smtp_port: '587',
    smtp_encryption: 'starttls',
    smtp_auth_method: 'none',
    smtp_from: 'alerts@example.com',
    smtp_recipients: 'ops@example.com',
    alert_email_min_severity: 'warning',
    alert_email_platforms: JSON.stringify({ cohesity: true, pure: true, netapp: true }),
    alert_email_reminder_hours: '24',
  };
  for (const [k, v] of Object.entries({ ...defaults, ...overrides })) setSetting(k, v);
}

let sent;
beforeEach(() => {
  sent = [];
  alertNotifier._setTransportFactory(() => ({
    sendMail: async (msg) => { sent.push(msg); },
  }));
  db.exec('DELETE FROM alert_notifications');
  db.exec('DELETE FROM alerts');
  db.exec('DELETE FROM netapp_alerts');
  db.exec('DELETE FROM vcenter_issue_history');
  db.exec('DELETE FROM alert_notify_platform');
  db.exec('DELETE FROM alert_notify_types');
});

afterEach(() => {
  alertNotifier._reset();
});

describe('per-platform recipients', () => {
  it('a platform with its own recipients sends only to those', async () => {
    const arrayId = insertNetappArray();
    insertNetappAlert(arrayId, { alertKey: '0', severity: 'critical' });
    configureSmtp({ smtp_recipients: 'ops@example.com' });
    setPlatformOverride('netapp', { recipients: 'netapp-team@example.com' });

    await alertNotifier.run();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('netapp-team@example.com');
  });

  it('a platform with blank recipients falls back to the global default', async () => {
    const arrayId = insertNetappArray();
    insertNetappAlert(arrayId, { alertKey: '0', severity: 'critical' });
    configureSmtp({ smtp_recipients: 'ops@example.com' });
    // No alert_notify_platform row at all for netapp.

    await alertNotifier.run();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('ops@example.com');
  });

  it('both blank sends nothing and writes no alert_notifications row', async () => {
    const arrayId = insertNetappArray();
    insertNetappAlert(arrayId, { alertKey: '0', severity: 'critical' });
    configureSmtp({ smtp_recipients: '' });
    setPlatformOverride('netapp', { recipients: '' });

    await alertNotifier.run();
    expect(sent).toHaveLength(0);
    const row = db.prepare("SELECT * FROM alert_notifications WHERE source = 'netapp'").get();
    expect(row).toBeUndefined();
  });
});

describe('per-platform minimum severity', () => {
  it('overrides the global threshold', async () => {
    const arrayId = insertNetappArray();
    insertNetappAlert(arrayId, { alertKey: '0', severity: 'warning' });
    configureSmtp({ alert_email_min_severity: 'critical' });
    setPlatformOverride('netapp', { minSeverity: 'info' });

    await alertNotifier.run();
    expect(sent).toHaveLength(1);
  });

  it('inherits the global threshold when unset (null)', async () => {
    const arrayId = insertNetappArray();
    insertNetappAlert(arrayId, { alertKey: '0', severity: 'warning' });
    configureSmtp({ alert_email_min_severity: 'critical' });
    setPlatformOverride('netapp', { minSeverity: null });

    await alertNotifier.run();
    expect(sent).toHaveLength(0);
  });
});

describe('per-alert-type mute', () => {
  it('a muted type is not emailed, but a different type on the same platform still is', async () => {
    const clusterId = insertCluster();
    insertCohesityAlert(clusterId, { alertId: 'a1', severity: 'critical', alertCategory: 'kDisk', description: 'disk fault' });
    insertCohesityAlert(clusterId, { alertId: 'a2', severity: 'critical', alertCategory: 'kNode', description: 'node fault' });
    configureSmtp();
    // First run populates the catalog so there is a row to mute.
    await alertNotifier.run();
    expect(sent).toHaveLength(2);

    db.exec('DELETE FROM alert_notifications');
    sent.length = 0;
    muteType('cohesity', 'kDisk');
    await alertNotifier.run();
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain('node fault');
  });

  it('catalog rows are created enabled=1, and a muted type stays muted after the next run', async () => {
    const clusterId = insertCluster();
    insertCohesityAlert(clusterId, { alertId: 'a1', severity: 'critical', alertCategory: 'kDisk' });
    configureSmtp();

    await alertNotifier.run();
    expect(typeRow('cohesity', 'kDisk')).toMatchObject({ enabled: 1, label: 'Disk' });

    muteType('cohesity', 'kDisk');
    sent.length = 0;
    await alertNotifier.run();
    expect(sent).toHaveLength(0);
    expect(typeRow('cohesity', 'kDisk').enabled).toBe(0);
  });
});

describe('Service Status is unaffected by mutes, severity or recipients', () => {
  it('collectOpenAlerts still returns a muted, below-threshold, no-recipient alert', async () => {
    const clusterId = insertCluster();
    insertCohesityAlert(clusterId, { alertId: 'a1', severity: 'info', alertCategory: 'kDisk' });
    configureSmtp({ smtp_recipients: '', alert_email_min_severity: 'critical' });
    setPlatformOverride('cohesity', { recipients: '' });
    muteType('cohesity', 'kDisk');

    const { items } = alertNotifier.collectOpenAlerts();
    expect(items.some((i) => i.platform === 'cohesity' && i.sourceKey === `c${clusterId}:a1`)).toBe(true);
  });
});

describe('refreshTypeCatalog (backfill from full stored history)', () => {
  it('run() with SMTP disabled still fills the catalog from stored rows, including a resolved cohesity alert and a resolved issue-history type', async () => {
    const clusterId = insertCluster();
    insertCohesityAlert(clusterId, { alertId: 'a1', severity: 'critical', alertCategory: 'kDisk', description: 'disk fault' });
    db.prepare('UPDATE alerts SET resolved = 1 WHERE cluster_id = ? AND cohesity_alert_id = ?').run(clusterId, 'a1');

    db.prepare(`
      INSERT INTO vcenter_issue_history (issue_key, vcenter, severity, type, target, message, status)
      VALUES ('host-down|vc-01|esx-02', 'vc-01', 'critical', 'host-down', 'esx-02', 'Host is down', 'resolved')
    `).run();

    configureSmtp({ smtp_enabled: '0' });
    await alertNotifier.run();

    expect(sent).toHaveLength(0);
    expect(typeRow('cohesity', 'kDisk')).toMatchObject({ enabled: 1, label: 'Disk' });
    expect(typeRow('vcenter', 'host-down')).toMatchObject({ enabled: 1, label: 'host-down' });
  });

  it('never re-enables a muted type and keeps the older first_seen', () => {
    const clusterId = insertCluster();
    insertCohesityAlert(clusterId, { alertId: 'a1', severity: 'critical', alertCategory: 'kDisk' });

    alertNotifier.refreshTypeCatalog('cohesity');
    expect(typeRow('cohesity', 'kDisk').enabled).toBe(1);

    muteType('cohesity', 'kDisk');
    db.prepare("UPDATE alert_notify_types SET first_seen = '2020-01-01 00:00:00' WHERE platform = 'cohesity' AND type = 'kDisk'").run();

    alertNotifier.refreshTypeCatalog('cohesity');
    const after = typeRow('cohesity', 'kDisk');
    expect(after.enabled).toBe(0);
    expect(after.first_seen).toBe('2020-01-01 00:00:00');
  });

  it('a missing platform table does not throw', () => {
    // Real seam, not a bogus table: drop a table refreshTypeCatalog reads
    // (aws is untouched by every other test in this file) so the aws query
    // throws for real, and confirm the overall call still returns cleanly.
    db.exec('DROP TABLE aws_issue_history');
    expect(() => alertNotifier.refreshTypeCatalog()).not.toThrow();
  });
});
