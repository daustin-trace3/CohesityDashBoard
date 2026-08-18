/**
 * WP14 (C10.3/C10.5): alertNotifier's collectors, severity threshold,
 * platform toggle, subject/body format, new-vs-reminder dedupe, stale
 * housekeeping, and no-throw-on-send-failure.
 *
 * No network: every test injects a fake transport via _setTransportFactory.
 *
 * netapp/zerto/vcenter/dell were removed from core in the 2026-08
 * pluginization campaign — their db/migrations/<id>.js files are gone, so
 * this file's tests that exercised them are guarded with an
 * it.skipIf(!<id>Present) instead of throwing on the missing tables. The
 * severity-threshold-across-sources and platform-toggle mechanics (which
 * are alertNotifier's own generic logic, not platform-owned) are instead
 * exercised against a minimal fake registry.collectAlerts contributor so
 * that coverage doesn't depend on any specific platform existing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const alertNotifier = require('../services/alertNotifier');
const { setSetting } = require('../services/settings');
const registry = require('../core/registry');
const express = require('express');

function platformPresent(id) {
  try { require.resolve(`../db/migrations/${id}`); return true; } catch { return false; }
}
const ZERTO_PRESENT = platformPresent('zerto');
const VCENTER_PRESENT = platformPresent('vcenter');
const DELL_PRESENT = platformPresent('dell');

function tryDelete(sql) {
  try { db.exec(sql); } catch { /* table doesn't exist on this branch — fine */ }
}

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

function insertZertoAlert({ alertId, severity, description = 'zerto issue', siteName = 'site-a' }) {
  db.prepare(`
    INSERT INTO zerto_alerts (alert_identifier, alert_type, severity, description, site_name)
    VALUES (?, 'VPG0014', ?, ?, ?)
  `).run(alertId, severity, description, siteName);
}

function insertVcenterIssue({ issueKey, severity, message = 'vcenter issue', status = 'open' }) {
  db.prepare(`
    INSERT INTO vcenter_issue_history (issue_key, vcenter, severity, type, target, message, status)
    VALUES (?, 'vc-01', ?, 'host-down', 'esx-01', ?, ?)
  `).run(issueKey, severity, message, status);
}

function insertDellInstance() {
  const name = nextName('ome');
  const info = db.prepare(`
    INSERT INTO dell_ome_instances (name, host, username, encrypted_credentials)
    VALUES (?, 'host', 'user', 'x')
  `).run(name);
  return info.lastInsertRowid;
}

function insertDellAlert(omeId, { alertId, severity, message = 'dell issue', status = 'not-acknowledged', deviceName = 'r740-01' }) {
  db.prepare(`
    INSERT INTO dell_alerts (ome_id, alert_id, severity, status, message, device_name)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(omeId, alertId, severity, status, message, deviceName);
}

// Minimal fake registry.collectAlerts contributor, standing in for a real
// platform plugin, to exercise alertNotifier's own generic mechanics
// (cross-source severity threshold, the platform-toggle gate) without
// depending on any specific platform's presence.
let fakeAlerts = [];
function registerFakeAlertPlugin() {
  registry.registerPlugin({
    id: 'fakealert',
    name: 'Fake Alert Source',
    apiVersion: registry.PLUGIN_API_VERSION,
    createRouter() { return express.Router(); },
    collectAlerts: () => fakeAlerts.map((a) => ({ ...a })),
  });
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
    alert_email_platforms: JSON.stringify({ cohesity: true, fakealert: true, netapp: true }),
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
  fakeAlerts = [];
  registry._reset();
  registry.init();
  registerFakeAlertPlugin();
  tryDelete('DELETE FROM alert_notifications');
  tryDelete('DELETE FROM alerts');
  tryDelete('DELETE FROM netapp_alerts');
  tryDelete('DELETE FROM zerto_alerts');
  tryDelete('DELETE FROM vcenter_issue_history');
  tryDelete('DELETE FROM dell_alerts');
});

afterEach(() => {
  alertNotifier._reset();
});

describe('alertNotifier', () => {
  it('(a) severity threshold: info suppressed at warning threshold; a plugin-collected error passes warning, fails critical', async () => {
    const clusterId = insertCluster();
    insertCohesityAlert(clusterId, { alertId: 'a-info', severity: 'info' });
    fakeAlerts.push({ sourceKey: 'fa-1', severity: 'error', host: 'fake-host', message: 'fake issue' });

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
    fakeAlerts.push({ sourceKey: 'fa-1', severity: 'critical', host: 'fake-host', message: 'fake issue' });

    configureSmtp({
      alert_email_min_severity: 'warning',
      alert_email_platforms: JSON.stringify({ cohesity: true, fakealert: false }),
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

  it('(h) a source surviving underlying-storage churn with the same message does not resend (content-stable key)', async () => {
    fakeAlerts.push({ sourceKey: '0', severity: 'critical', host: 'fake-host', message: 'fan failure on shelf 2' });
    configureSmtp();
    await alertNotifier.run();
    expect(sent).toHaveLength(1);

    // Simulate a poller's wipe+reload: same sourceKey, same message, but the
    // underlying row/object identity changed.
    fakeAlerts = [{ sourceKey: '0', severity: 'critical', host: 'fake-host', message: 'fan failure on shelf 2' }];

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

  it.skipIf(!ZERTO_PRESENT)('(j) zerto alerts send and survive the wipe+reload without resending', async () => {
    insertZertoAlert({ alertId: 'za-1', severity: 'Error', description: 'VPG rpo breached', siteName: 'nyc-zvm' });
    configureSmtp();
    await alertNotifier.run();
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('ERROR | nyc-zvm | VPG rpo breached');

    db.exec('DELETE FROM zerto_alerts');
    insertZertoAlert({ alertId: 'za-1', severity: 'Error', description: 'VPG rpo breached', siteName: 'nyc-zvm' });
    sent.length = 0;
    await alertNotifier.run();
    expect(sent).toHaveLength(0);
  });

  it.skipIf(!VCENTER_PRESENT)('(k) vcenter open issues send; resolved issues stop reminding', async () => {
    insertVcenterIssue({ issueKey: 'host-down|vc-01|esx-01', severity: 'critical', message: 'Host esx-01 is not responding' });
    configureSmtp({ alert_email_reminder_hours: '1' });
    await alertNotifier.run();
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain('vc-01');

    db.prepare("UPDATE vcenter_issue_history SET status = 'resolved'").run();
    db.prepare("UPDATE alert_notifications SET last_notified_at = datetime('now', '-2 hours')").run();
    sent.length = 0;
    await alertNotifier.run();
    expect(sent).toHaveLength(0);
  });

  it.skipIf(!DELL_PRESENT)('(l) dell acknowledged alerts are excluded and normal maps to info', async () => {
    const omeId = insertDellInstance();
    insertDellAlert(omeId, { alertId: 1, severity: 'critical', status: 'acknowledged' });
    insertDellAlert(omeId, { alertId: 2, severity: 'normal', message: 'link restored' });
    insertDellAlert(omeId, { alertId: 3, severity: 'critical', message: 'PSU failure', deviceName: 'r750-02' });

    configureSmtp({ alert_email_min_severity: 'warning' });
    await alertNotifier.run();
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('CRITICAL | r750-02 | PSU failure');
  });
});
