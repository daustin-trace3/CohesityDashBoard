/**
 * Ops Agent cross-platform helpers: relatedOtherPlatformEvents (agent-side
 * replacement for Service Status's dead alert-event source) and buildTimeline.
 * Both take a database handle, so most cases run on a private in-memory db
 * with only the tables they read; the config ledger case uses the shared one.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const sharedDb = require('../db/database');
const tl = require('../services/agentTimeline');

const NOW_MS = Date.parse('2026-10-22T12:00:00.000Z');
const iso = (minAgo) => new Date(NOW_MS - minAgo * 60000).toISOString();

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ops_incidents (id INTEGER PRIMARY KEY, state TEXT);
    CREATE TABLE ops_incident_alerts (id INTEGER PRIMARY KEY, incident_id INTEGER, platform TEXT, source_key TEXT, severity TEXT, host TEXT, message TEXT, first_seen TEXT, attached_at TEXT, cleared_at TEXT);
    CREATE TABLE vcenter_hosts (id INTEGER PRIMARY KEY, vcenter_id INTEGER, host_id TEXT, name TEXT, serial TEXT, service_tag TEXT, uuid TEXT);
    CREATE TABLE dell_devices (id INTEGER PRIMARY KEY, ome_id INTEGER, device_id INTEGER, service_tag TEXT, name TEXT, model TEXT, chassis_service_tag TEXT, ip_address TEXT, idrac_mac TEXT, os_hostname TEXT);
    CREATE TABLE dell_components (id INTEGER PRIMARY KEY, ome_id INTEGER, device_id INTEGER, kind TEXT, extra TEXT);
    CREATE TABLE lm_devices (source_id INTEGER, lm_device_id INTEGER, display_name TEXT, name TEXT, sysname TEXT, site_key TEXT, stale INTEGER DEFAULT 0);
    CREATE TABLE lm_interfaces (source_id INTEGER, lm_device_id INTEGER, instance_id INTEGER, display_name TEXT, status INTEGER, stale INTEGER DEFAULT 0);
    CREATE TABLE lm_interface_history (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER, instance_id INTEGER, captured_at TEXT, status INTEGER);
    CREATE TABLE lm_circuit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER, device_name TEXT, port TEXT, site_key TEXT, role TEXT, event TEXT, at TEXT);
    CREATE TABLE lm_latency_episodes (id INTEGER PRIMARY KEY AUTOINCREMENT, subject_label TEXT, site_key TEXT, kind TEXT, state TEXT, opened_at TEXT, promoted_at TEXT, peak_ms REAL);
    CREATE TABLE vcenter_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT, message TEXT, entity_name TEXT, created_at TEXT);
  `);
  return db;
}

describe('parseTs', () => {
  it('reads ISO, zoneless SQLite stamps (as UTC) and epoch numbers', () => {
    expect(tl.parseTs('2026-10-22T12:00:00.000Z')).toBe(NOW_MS);
    expect(tl.parseTs('2026-10-22 12:00:00')).toBe(NOW_MS);
    expect(tl.parseTs(NOW_MS)).toBe(NOW_MS);
    expect(tl.parseTs(NOW_MS * 1000)).toBe(NOW_MS);
    expect(tl.parseTs(null)).toBeNull();
    expect(tl.parseTs('not a date')).toBeNull();
  });
});

describe('relatedOtherPlatformEvents', () => {
  let db;
  const addAlert = (incident, platform, host, firstSeen, o = {}) => db.prepare(
    "INSERT INTO ops_incident_alerts (incident_id, platform, source_key, severity, host, message, first_seen, attached_at, cleared_at) VALUES (?, ?, ?, 'critical', ?, ?, ?, ?, ?)"
  ).run(incident, platform, o.key || `k${Math.random()}`, host, o.message || 'alert', firstSeen, firstSeen, o.cleared || null);
  beforeEach(() => {
    db = makeDb();
    db.exec("INSERT INTO ops_incidents (id, state) VALUES (1, 'collecting'), (2, 'collecting'), (3, 'resolved')");
  });
  const anchor = NOW_MS;

  it('finds open alerts on other platforms for the same host, inside 24 h either side only', () => {
    addAlert(2, 'dell', 'ESX-01 (ABC1234)', iso(30), { message: 'PSU failed' });
    addAlert(2, 'brocade', 'esx-01.lab.local', iso(60 * 25), { message: 'too old' });      // 25 h before the anchor
    addAlert(2, 'pure', 'other-host', iso(30), { message: 'different host' });
    addAlert(2, 'dell', 'esx-01', iso(30), { message: 'cleared', cleared: iso(5) });
    addAlert(3, 'dell', 'esx-01', iso(30), { message: 'resolved incident' });
    addAlert(1, 'dell', 'esx-01', iso(30), { message: 'same incident' });
    addAlert(2, 'vcenter', 'esx-01', iso(30), { message: 'same platform' });
    const rows = tl.relatedOtherPlatformEvents({ incidentId: 1, platform: 'vcenter', host: 'esx-01.lab.local', anchorMs: anchor }, db);
    expect(rows.map((r) => r.message)).toEqual(['PSU failed']);
    expect(rows[0]).toMatchObject({ platform: 'dell', severity: 'critical', host: 'ESX-01 (ABC1234)', incidentId: 2 });
    expect(rows[0].firstSeen).toBe(iso(30));
  });

  it('matches by the identity index when the two platforms use different names', () => {
    db.prepare("INSERT INTO vcenter_hosts (vcenter_id, host_id, name, serial, service_tag) VALUES (1, 'h1', 'esx-77.corp.local', 'TAG7777X', 'TAG7777X')").run();
    db.prepare("INSERT INTO dell_devices (ome_id, device_id, service_tag, name, model, ip_address) VALUES (1, 1, 'TAG7777X', 'dell-rack-77', 'R650', '10.1.2.77')").run();
    addAlert(2, 'dell', 'dell-rack-77', iso(10), { message: 'iDRAC unreachable' });
    const viaIdentity = tl.relatedOtherPlatformEvents({ incidentId: 1, platform: 'vcenter', host: 'esx-77.corp.local', anchorMs: anchor }, db);
    expect(viaIdentity.map((r) => r.message)).toEqual(['iDRAC unreachable']);
    // a host the index does not know shares no name and matches nothing
    expect(tl.relatedOtherPlatformEvents({ incidentId: 1, platform: 'vcenter', host: 'stranger', anchorMs: anchor }, db)).toEqual([]);
  });

  it('caps at 10, newest first', () => {
    for (let i = 0; i < 14; i++) addAlert(2, 'dell', 'esx-01', iso(100 - i), { message: `m${i}`, key: `k${i}` });
    const rows = tl.relatedOtherPlatformEvents({ incidentId: 1, platform: 'vcenter', host: 'esx-01', anchorMs: anchor }, db);
    expect(rows).toHaveLength(10);
    expect(rows[0].message).toBe('m13');
  });
});

describe('buildTimeline', () => {
  let db;
  beforeEach(() => {
    db = makeDb();
    db.prepare("INSERT INTO lm_devices (source_id, lm_device_id, display_name, name, site_key) VALUES (1, 10, 'dal-sw-01', 'dal-sw-01', 'dallas')").run();
  });
  const alertRow = (o = {}) => ({ platform: 'logicmonitor', severity: 'critical', host: 'dal-sw-01', message: 'port down', first_seen: iso(30), attached_at: iso(30), cleared_at: null, ...o });
  const inc = { id: 1, incident_key: 'host:dal-sw-01', opened_at: iso(30) };
  const build = (alerts, evidence = {}, i = inc) => tl.buildTimeline(i, alerts, evidence, { dbh: db, now: NOW_MS });

  it('merges sources newest first and stays inside [first alert - 60 min, now]', () => {
    db.prepare("INSERT INTO lm_circuit_events (source_id, device_name, port, site_key, role, event, at) VALUES (1, 'dal-wan-1', 'Te0/1', 'dallas', 'wan', 'down', ?)").run(iso(20));
    db.prepare("INSERT INTO lm_circuit_events (source_id, device_name, port, site_key, role, event, at) VALUES (1, 'dal-wan-1', 'Te0/1', 'dallas', 'wan', 'up', ?)").run(iso(120));   // before the window
    db.prepare("INSERT INTO lm_circuit_events (source_id, device_name, port, site_key, role, event, at) VALUES (1, 'x', 'y', 'elsewhere', 'wan', 'down', ?)").run(iso(20));        // other site
    db.prepare("INSERT INTO vcenter_events (event_type, message, entity_name, created_at) VALUES ('VmMigratedEvent', 'moved', 'dal-sw-01', ?)").run(iso(45));
    db.prepare("INSERT INTO lm_interfaces (source_id, lm_device_id, instance_id, display_name, status) VALUES (1, 10, 5, 'Gi1/0/1', 2)").run();
    db.prepare("INSERT INTO lm_interface_history (source_id, instance_id, captured_at, status) VALUES (1, 5, ?, 1), (1, 5, ?, 2), (1, 5, ?, 2)").run(iso(40), iso(25), iso(10));
    const out = build([alertRow()], { failedBackupJobs: [{ platform: 'cohesity', job: 'PG1', source: 'cl1', finished: iso(15), error: 'client down' }] });
    const texts = out.map((t) => t.text);
    expect(texts.some((t) => /^Circuit down: dal-wan-1 Te0\/1 \(wan\)/.test(t))).toBe(true);
    expect(texts.some((t) => /^VmMigratedEvent on dal-sw-01/.test(t))).toBe(true);
    expect(texts.some((t) => /^Interface down: dal-sw-01 Gi1\/0\/1/.test(t))).toBe(true);
    expect(texts.some((t) => /^Backup job failed: PG1 on cl1: client down/.test(t))).toBe(true);
    expect(texts.some((t) => /^Alert \(critical\) dal-sw-01: port down/.test(t))).toBe(true);
    expect(texts.some((t) => /elsewhere|\bUp\b|Circuit up/.test(t))).toBe(false);
    // newest first, ISO stamps, nothing older than 60 min before the first alert
    for (let i = 1; i < out.length; i++) expect(out[i - 1].at >= out[i].at).toBe(true);
    expect(out.every((t) => Date.parse(t.at) >= NOW_MS - 90 * 60000 && Date.parse(t.at) <= NOW_MS)).toBe(true);
    expect(out.find((t) => /^Interface down/.test(t.text)).at).toBe(iso(25));   // the start of the down streak
  });

  it('caps at 20 items and 160 characters per text', () => {
    const alerts = Array.from({ length: 8 }, (_, i) => alertRow({ message: 'x'.repeat(400), first_seen: iso(50 - i), host: 'dal-sw-01' }));
    for (let i = 0; i < 9; i++) db.prepare("INSERT INTO vcenter_events (event_type, message, entity_name, created_at) VALUES ('E', ?, 'dal-sw-01', ?)").run(`event ${i}`, iso(40 - i));
    for (let i = 0; i < 9; i++) db.prepare("INSERT INTO lm_circuit_events (source_id, device_name, port, site_key, role, event, at) VALUES (1, 'd', ?, 'dallas', 'wan', 'flap-start', ?)").run(`p${i}`, iso(30 - i));
    const jobs = Array.from({ length: 9 }, (_, i) => ({ platform: 'cohesity', job: `J${i}`, source: 'c', finished: iso(20 - i) }));
    const out = build(alerts, { failedBackupJobs: jobs });
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.length).toBe(20);
    expect(out.every((t) => t.text.length <= 160)).toBe(true);
  });

  it('puts latency episodes of the incident checks and the probe location on the timeline', () => {
    db.prepare("INSERT INTO lm_latency_episodes (subject_label, site_key, kind, state, opened_at, promoted_at, peak_ms) VALUES ('Web Portal @ Australia - Sydney', NULL, 'latency', 'critical', ?, ?, 840)").run(iso(35), iso(20));
    db.prepare("INSERT INTO lm_latency_episodes (subject_label, site_key, kind, state, opened_at, promoted_at, peak_ms) VALUES ('Other check @ US - Oregon', NULL, 'latency', 'watching', ?, NULL, 90)").run(iso(35));
    const locInc = { id: 2, incident_key: 'lm-location:australia-sydney', opened_at: iso(30) };
    const out = build([alertRow({ host: 'Web Portal @ Australia - Sydney', message: 'latency' })], {}, locInc);
    const texts = out.map((t) => t.text);
    expect(texts.some((t) => /^Latency episode opened: Web Portal @ Australia - Sydney, peak 840 ms/.test(t))).toBe(true);
    expect(texts.some((t) => /^Latency episode promoted to critical: Web Portal/.test(t))).toBe(true);
    expect(texts.some((t) => /Other check/.test(t))).toBe(false);
  });

  it('reads the shared config ledger for the incident hosts and never throws on missing tables', () => {
    sharedDb.exec('DELETE FROM config_changes');
    const real = Date.now();
    const at = new Date(real - 20 * 60000).toISOString();
    sharedDb.prepare("INSERT INTO config_changes (platform, scope, system, item, change_type, old_value, new_value, detected_at) VALUES ('netapp', 'nfs', 'dal-sw-01', 'export /vol1', 'changed', 'a', 'b', ?)").run(at);
    const emptyDb = new Database(':memory:');                 // none of the source tables exist
    const fresh = alertRow({ first_seen: new Date(real - 30 * 60000).toISOString() });
    const out = tl.buildTimeline(inc, [fresh], {}, { dbh: emptyDb, now: real });
    expect(out.some((t) => t.platform === 'netapp' && /^Config changed: dal-sw-01 export \/vol1/.test(t.text))).toBe(true);
    expect(out.some((t) => /^Alert \(critical\)/.test(t.text))).toBe(true);
    sharedDb.exec('DELETE FROM config_changes');
  });
});
