/**
 * WP14 (C10.3/C10.5): alertNotifier's collectors, severity threshold,
 * platform toggle, subject/body format, new-vs-reminder dedupe, stale
 * housekeeping, NetApp content-stable keys, and no-throw-on-send-failure.
 *
 * No network: every test injects a fake transport via _setTransportFactory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const alertNotifier = require('../services/alertNotifier');
const { setSetting } = require('../services/settings');
const { encrypt } = require('../services/encryption');

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

function insertCohesityAlert(clusterId, { alertId, severity, alertType = 'DiskFailure', description = 'disk failed', resolved = 0, firstSeen = new Date().toISOString(), lastUpdated = new Date().toISOString() }) {
  db.prepare(`
    INSERT INTO alerts (cluster_id, cohesity_alert_id, severity, alert_type, description, resolved, dismissed, first_seen, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(clusterId, alertId, severity, alertType, description, resolved, firstSeen, lastUpdated);
}

function resolveCohesityAlert(clusterId, alertId) {
  db.prepare('UPDATE alerts SET resolved = 1 WHERE cluster_id = ? AND cohesity_alert_id = ?').run(clusterId, alertId);
}

function insertPureArray() {
  const name = nextName('pure-array');
  const info = db.prepare(`
    INSERT INTO pure_arrays (name, mgmt_host, client_id, key_id, username, encrypted_credentials)
    VALUES (?, 'host', 'cid', 'kid', 'user', 'x')
  `).run(name);
  return info.lastInsertRowid;
}

function insertPureAlert(arrayId, { alertId, severity, summary = 'pure issue', createdAtMs = Date.now(), updatedAtMs = Date.now() }) {
  db.prepare(`
    INSERT INTO pure_alerts (array_id, pure_alert_id, severity, summary, created_at_ms, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(arrayId, alertId, severity, summary, createdAtMs, updatedAtMs);
}

function insertNetappArray() {
  const name = nextName('netapp-array');
  const info = db.prepare(`
    INSERT INTO netapp_arrays (name, mgmt_host, username, encrypted_credentials)
    VALUES (?, 'host', 'user', 'x')
  `).run(name);
  return info.lastInsertRowid;
}

function insertNetappAlert(arrayId, { alertKey, severity, message = 'netapp issue', nodeName = 'node1' }) {
  db.prepare(`
    INSERT INTO netapp_alerts (array_id, alert_key, severity, node_name, source, message)
    VALUES (?, ?, ?, ?, 'health', ?)
  `).run(arrayId, alertKey, severity, nodeName, message);
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
  db.exec('DELETE FROM pure_alerts');
  db.exec('DELETE FROM netapp_alerts');
});

afterEach(() => {
  alertNotifier._reset();
});

describe('alertNotifier', () => {
  it('(a) severity threshold: info suppressed at warning threshold; netapp error passes warning, fails critical', async () => {
    const clusterId = insertCluster();
    insertCohesityAlert(clusterId, { alertId: 'a-info', severity: 'info' });
    const netappArrayId = insertNetappArray();
    insertNetappAlert(netappArrayId, { alertKey: '0', severity: 'error' });

    configureSmtp({ alert_email_min_severity: 'warning' });
    await alertNotifier.run();
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain('ERROR');

    db.exec('DELETE FROM alert_notifications');
    sent.length = 0;
    configureSmtp({ alert_email_min_severity: 'critical' });
    await alertNotifier.run();
    expect(sent).toHaveLength(0);
  });

  it('(b) platform toggle excludes a source entirely', async () => {
    const netappArrayId = insertNetappArray();
    insertNetappAlert(netappArrayId, { alertKey: '0', severity: 'critical' });

    configureSmtp({
      alert_email_min_severity: 'warning',
      alert_email_platforms: JSON.stringify({ cohesity: true, pure: true, netapp: false }),
    });
    await alertNotifier.run();
    expect(sent).toHaveLength(0);
  });

  it('(c) subject format is SEV | host | msg', async () => {
    const clusterId = insertCluster();
    insertCohesityAlert(clusterId, { alertId: 'a1', severity: 'critical', alertType: 'DiskFailure', description: 'disk 3 failed' });
    configureSmtp();
    await alertNotifier.run();
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/^CRITICAL \| cluster-\d+ \| DiskFailure: disk 3 failed$/);
  });

  it('(d) body contains full message, first-fired, and notification count', async () => {
    const clusterId = insertCluster();
    insertCohesityAlert(clusterId, { alertId: 'a1', severity: 'critical', description: 'a very specific long description of the failure' });
    configureSmtp();
    await alertNotifier.run();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('a very specific long description of the failure');
    expect(sent[0].text).toContain('First fired:');
    expect(sent[0].text).toContain('Notifications sent for this alert: 1');
  });

  it('(e) a second run with no changes sends nothing (dedupe)', async () => {
    const clusterId = insertCluster();
    insertCohesityAlert(clusterId, { alertId: 'a1', severity: 'critical' });
    configureSmtp();
    await alertNotifier.run();
    expect(sent).toHaveLength(1);
    sent.length = 0;
    await alertNotifier.run();
    expect(sent).toHaveLength(0);
  });

  it('(f) reminder sent after reminderHours with [REMINDER n] and bumped notify_count', async () => {
    const clusterId = insertCluster();
    insertCohesityAlert(clusterId, { alertId: 'a1', severity: 'critical' });
    configureSmtp({ alert_email_reminder_hours: '24' });
    await alertNotifier.run();
    expect(sent).toHaveLength(1);

    db.prepare(`
      UPDATE alert_notifications SET last_notified_at = datetime('now', '-25 hours')
      WHERE source = 'cohesity' AND source_key = ?
    `).run(`c${clusterId}:a1`);

    sent.length = 0;
    await alertNotifier.run();
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain('[REMINDER 2]');

    const row = db.prepare('SELECT notify_count FROM alert_notifications WHERE source = ? AND source_key = ?')
      .get('cohesity', `c${clusterId}:a1`);
    expect(row.notify_count).toBe(2);
  });

  it('(g) a resolved cohesity alert stops reminding', async () => {
    const clusterId = insertCluster();
    insertCohesityAlert(clusterId, { alertId: 'a1', severity: 'critical' });
    configureSmtp({ alert_email_reminder_hours: '24' });
    await alertNotifier.run();
    expect(sent).toHaveLength(1);

    resolveCohesityAlert(clusterId, 'a1');
    db.prepare(`
      UPDATE alert_notifications SET last_notified_at = datetime('now', '-25 hours')
      WHERE source = 'cohesity' AND source_key = ?
    `).run(`c${clusterId}:a1`);

    sent.length = 0;
    await alertNotifier.run();
    expect(sent).toHaveLength(0);
  });

  it('(h) netapp table wipe+reload with the same message does not resend (content-stable key)', async () => {
    const arrayId = insertNetappArray();
    insertNetappAlert(arrayId, { alertKey: '0', severity: 'critical', message: 'fan failure on shelf 2' });
    configureSmtp();
    await alertNotifier.run();
    expect(sent).toHaveLength(1);

    // Simulate the poller's wipe+reload: same alert_key, same message, new row id.
    db.prepare('DELETE FROM netapp_alerts WHERE array_id = ?').run(arrayId);
    insertNetappAlert(arrayId, { alertKey: '0', severity: 'critical', message: 'fan failure on shelf 2' });

    sent.length = 0;
    await alertNotifier.run();
    expect(sent).toHaveLength(0);
  });

  it('(i) a send failure does not write a row, so the alert is retried next run', async () => {
    const clusterId = insertCluster();
    insertCohesityAlert(clusterId, { alertId: 'a1', severity: 'critical' });
    configureSmtp();

    alertNotifier._setTransportFactory(() => ({
      sendMail: async () => { throw new Error('smtp down'); },
    }));
    await alertNotifier.run();
    const row = db.prepare('SELECT * FROM alert_notifications WHERE source = ? AND source_key = ?')
      .get('cohesity', `c${clusterId}:a1`);
    expect(row).toBeUndefined();

    sent = [];
    alertNotifier._setTransportFactory(() => ({
      sendMail: async (msg) => { sent.push(msg); },
    }));
    await alertNotifier.run();
    expect(sent).toHaveLength(1);
  });
});
