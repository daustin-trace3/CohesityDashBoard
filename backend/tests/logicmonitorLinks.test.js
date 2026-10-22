/**
 * LogicMonitor agent signals: link bursts (logicmonitorLinks.js), the
 * per-device interface evidence line, the collectAlerts groupKey hints for
 * the probe-location and burst folds, and the order and titles of the
 * incidentEvidence block. Rows are seeded by hand through the migration.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const { encrypt } = require('../services/encryption');
const lmIssues = require('../services/logicmonitorIssues');
const lmLinks = require('../services/logicmonitorLinks');

const TABLES = ['lm_latency_episodes', 'lm_interface_history', 'lm_interfaces', 'lm_alerts', 'lm_issue_history', 'lm_sites',
  'lm_devices', 'lm_check_locations', 'lm_checks', 'lm_sources'];
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const stamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const minAgo = (m) => stamp(NOW - m * 60000);

beforeAll(() => { runMigrations(db, 'logicmonitor', lmMigrations); });

let sid;
let t;
beforeEach(() => {
  for (const tbl of TABLES) db.prepare(`DELETE FROM ${tbl}`).run();
  db.prepare("DELETE FROM app_settings WHERE key LIKE 'lm_%'").run();
  sid = db.prepare('INSERT INTO lm_sources (name, company, auth_mode, encrypted_credentials) VALUES (?, ?, ?, ?)')
    .run('Acme', 'acme', 'lmv1', encrypt(JSON.stringify({ accessId: 'a', accessKey: 'b' }))).lastInsertRowid;
  t = lmIssues.getThresholds();
});

function device(id, name, siteKey = 'dallas', siteName = 'Dallas') {
  db.prepare(`INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, device_type, host_status, is_network, role, ips_json, eri_json, site_key, site_name)
    VALUES (?, ?, ?, ?, 0, 'normal', 1, 'switch', '[]', '{"mac":[],"ip":[],"fqdn":[]}', ?, ?)`).run(sid, id, name, name, siteKey, siteName);
}
let nextInst = 1000;
/** Interface with history: samples = [[minutesAgo, status], ...]; the interface row mirrors the newest sample. */
function iface(deviceId, port, samples) {
  const inst = nextInst++;
  const sorted = [...samples].sort((a, b) => b[0] - a[0]);
  const lastStatus = sorted[sorted.length - 1][1];
  db.prepare(`INSERT INTO lm_interfaces (source_id, lm_device_id, instance_id, instance_name, display_name, status, status_text, stale, stop_monitoring)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`).run(sid, deviceId, inst, port, port, lastStatus, lastStatus === 2 ? 'down' : 'up');
  const h = db.prepare('INSERT INTO lm_interface_history (source_id, instance_id, captured_at, status) VALUES (?, ?, ?, ?)');
  for (const [m, s] of samples) h.run(sid, inst, minAgo(m), s);
  return inst;
}
const wentDown = (deviceId, port, downMinAgo) => iface(deviceId, port, [[downMinAgo + 15, 1], [downMinAgo, 2], [3, 2]]);
/** Move the seeded history from the fixed NOW to the real clock (for code that reads Date.now()). */
const shiftToNow = () => db.prepare("UPDATE lm_interface_history SET captured_at = strftime('%Y-%m-%d %H:%M:%S', captured_at, ? || ' seconds')").run(Math.round((Date.now() - NOW) / 1000));
const srcMap = () => new Map([[sid, 'Acme']]);
const burst = () => lmLinks.linkBurstIssues(db, t, srcMap(), NOW);

describe('link-burst', () => {
  it('raises one critical issue for 5 interfaces down in 30 minutes across 3 devices of one site', () => {
    device(1, 'dal-acc-01'); device(2, 'dal-acc-02'); device(3, 'dal-acc-03');
    wentDown(1, 'Gi1/0/7', 18); wentDown(1, 'Gi1/0/8', 18);
    wentDown(2, 'Gi1/0/7', 18); wentDown(2, 'Gi1/0/8', 17);
    wentDown(3, 'Gi1/0/7', 10);
    const issues = burst();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'critical', type: 'link-burst', source: 'Acme', target: 'dallas' });
    expect(issues[0].message).toMatch(/^5 interfaces went down in the last 30 min on 3 devices \(sites Dallas\): dal-acc-0\d Gi1\/0\/\d/);
    expect(issues[0].message.split(': ')[1].split(', ')).toHaveLength(5);
  });

  it('needs two devices: five interfaces on one switch is a switch story, not a burst', () => {
    device(1, 'dal-acc-01');
    for (const p of [1, 2, 3, 4, 5]) wentDown(1, `Gi1/0/${p}`, 12);
    expect(burst()).toEqual([]);
  });

  it('needs lm_link_burst_min interfaces', () => {
    device(1, 'dal-acc-01'); device(2, 'dal-acc-02');
    wentDown(1, 'Gi1/0/1', 12); wentDown(1, 'Gi1/0/2', 12); wentDown(2, 'Gi1/0/1', 12); wentDown(2, 'Gi1/0/2', 12);
    expect(burst()).toEqual([]);
    wentDown(2, 'Gi1/0/3', 12);
    expect(burst()).toHaveLength(1);
  });

  it('counts a transition inside the window and ignores one outside it', () => {
    device(1, 'dal-acc-01'); device(2, 'dal-acc-02');
    wentDown(1, 'Gi1/0/1', 12); wentDown(1, 'Gi1/0/2', 12); wentDown(2, 'Gi1/0/1', 12); wentDown(2, 'Gi1/0/2', 12);
    wentDown(2, 'Gi1/0/3', 31); // went down 31 minutes ago: outside the 30 minute window
    expect(burst()).toEqual([]);
    wentDown(2, 'Gi1/0/4', 29); // 29 minutes ago: inside
    const issues = burst();
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/^5 interfaces went down/);
  });

  it('skips interfaces that came back up and stale or unmonitored rows', () => {
    device(1, 'dal-acc-01'); device(2, 'dal-acc-02');
    wentDown(1, 'Gi1/0/1', 12); wentDown(1, 'Gi1/0/2', 12); wentDown(2, 'Gi1/0/1', 12); wentDown(2, 'Gi1/0/2', 12);
    iface(2, 'Gi1/0/3', [[27, 1], [12, 2], [2, 1]]); // went down and recovered
    const stale = wentDown(2, 'Gi1/0/4', 12);
    db.prepare('UPDATE lm_interfaces SET stale = 1 WHERE source_id = ? AND instance_id = ?').run(sid, stale);
    expect(burst()).toEqual([]);
  });

  it('targets "estate" when the devices span sites, and caps the named interfaces at 6', () => {
    device(1, 'dal-acc-01'); device(2, 'phx-acc-01', 'phoenix', 'Phoenix');
    for (const p of [1, 2, 3, 4]) wentDown(1, `Gi1/0/${p}`, 12);
    for (const p of [1, 2, 3, 4]) wentDown(2, `Gi1/0/${p}`, 12);
    const [issue] = burst();
    expect(issue.target).toBe('estate');
    expect(issue.message).toMatch(/^8 interfaces went down in the last 30 min on 2 devices \(sites Dallas, Phoenix\): /);
    expect(issue.message).toContain(', and 2 more');
  });

  it('honours the threshold overrides through computeIssues', () => {
    device(1, 'dal-acc-01'); device(2, 'dal-acc-02');
    wentDown(1, 'Gi1/0/1', 12); wentDown(2, 'Gi1/0/1', 12);
    shiftToNow();
    expect(lmIssues.computeIssues().filter((i) => i.type === 'link-burst')).toHaveLength(0);
    require('../services/settings').setSetting('lm_link_burst_min', '2');
    expect(lmIssues.computeIssues().filter((i) => i.type === 'link-burst')).toHaveLength(1);
  });
});

describe('deviceInterfaceLines', () => {
  const addAlert = (deviceId, ds, key) => db.prepare(`INSERT INTO lm_alerts (source_id, lm_alert_id, condition_key, severity, severity_norm, lm_device_id, monitor_object_name, resource_template_name, cleared)
    VALUES (?, ?, ?, 3, 'error', ?, 'dal-acc-01', ?, 0)`).run(sid, key, `ck-${key}`, deviceId, ds);
  const addIssue = (type, target) => db.prepare("INSERT INTO lm_issue_history (issue_key, source, severity, type, target, message, status) VALUES (?, 'Acme', 'warning', ?, ?, 'x', 'open')")
    .run(`${type}|Acme|${target}`, type, target);
  const dev = () => db.prepare('SELECT * FROM lm_devices WHERE lm_device_id = 1').get();

  it('summarises down, flapping, error and alert counts with the down-since time', () => {
    device(1, 'dal-acc-01');
    iface(1, 'Gi1/0/7', [[60, 1], [20, 2], [3, 2]]);
    iface(1, 'Gi1/0/8', [[60, 1]]);
    addIssue('interface-flapping', 'dal-acc-01 Gi1/0/8');
    addIssue('interface-errors-growing', 'dal-acc-01 Gi1/0/9');
    addIssue('interface-error-anomaly', 'dal-acc-01 Gi1/0/9');
    addIssue('interface-flapping', 'dal-acc-02 Gi1/0/1'); // another device
    addAlert(1, 'Network Interfaces', 'a1');
    addAlert(1, 'SNMP_Network_Interfaces', 'a2');
    addAlert(1, 'Cisco_Memory', 'a3');
    const lines = lmLinks.deviceInterfaceLines(db, dev());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Interfaces on dal-acc-01: 1 down now \(Gi1\/0\/7 since \d{4}-\d\d-\d\d \d\d:\d\d UTC\), 1 flapping in 24 h, 2 with errors rising, 2 open LM interface alerts$/);
  });

  it('is omitted when every count is zero', () => {
    device(1, 'dal-acc-01');
    iface(1, 'Gi1/0/8', [[60, 1]]);
    expect(lmLinks.deviceInterfaceLines(db, dev())).toEqual([]);
  });
});

describe('collectAlerts groupKey', () => {
  const manifest = () => require('../platforms/logicmonitor');
  const addIssue = (type, target, severity = 'warning') => db.prepare('INSERT INTO lm_issue_history (issue_key, source, severity, type, target, message, status, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(`${type}|Acme|${target}`, 'Acme', severity, type, target, `${type} message`, 'open', stamp(NOW - 600000), stamp(NOW));
  const byKey = (items) => Object.fromEntries(items.map((i) => [i.sourceKey, i]));

  it('folds check issues from a location with an open location-latency issue, and only those', () => {
    addIssue('location-latency', 'Australia - Sydney', 'critical');
    addIssue('latency-degrading', 'Web Portal @ Australia - Sydney');
    addIssue('latency-pattern', 'API @ Australia - Sydney');
    addIssue('check-location-down', 'DNS @ Australia - Sydney');
    addIssue('latency-degrading', 'Web Portal @ US - Oregon');
    addIssue('device-dead', 'sw-01', 'critical');
    const m = byKey(manifest().collectAlerts({ db }));
    expect(m['location-latency|Acme|Australia - Sydney'].groupKey).toBe('lm-location:australia-sydney');
    expect(m['latency-degrading|Acme|Web Portal @ Australia - Sydney'].groupKey).toBe('lm-location:australia-sydney');
    expect(m['latency-pattern|Acme|API @ Australia - Sydney'].groupKey).toBe('lm-location:australia-sydney');
    expect(m['check-location-down|Acme|DNS @ Australia - Sydney'].groupKey).toBe('lm-location:australia-sydney');
    expect(m['latency-degrading|Acme|Web Portal @ US - Oregon'].groupKey).toBeUndefined();
    expect(m['device-dead|Acme|sw-01'].groupKey).toBeUndefined();
    // host stays the full target so the agent keeps the check name; location and checkName ride along
    expect(m['latency-degrading|Acme|Web Portal @ Australia - Sydney']).toMatchObject({ host: 'Web Portal @ Australia - Sydney', checkName: 'Web Portal', location: 'Australia - Sydney' });
  });

  it('folds interface issues and LM interface alerts on burst devices under lm-burst:<target>', () => {
    device(1, 'dal-acc-01'); device(2, 'dal-acc-02'); device(3, 'dal-acc-09');
    for (const p of [1, 2, 3]) wentDown(1, `Gi1/0/${p}`, 12);
    for (const p of [1, 2]) wentDown(2, `Gi1/0/${p}`, 12);
    shiftToNow();
    addIssue('link-burst', 'dallas', 'critical');
    addIssue('interface-flapping', 'dal-acc-01 Gi1/0/4');
    addIssue('interface-flapping', 'dal-acc-09 Gi1/0/4');
    db.prepare(`INSERT INTO lm_alerts (source_id, lm_alert_id, condition_key, severity, severity_norm, lm_device_id, monitor_object_name, resource_template_name, cleared)
      VALUES (?, 'x1', 'ck-x1', 4, 'critical', 2, 'dal-acc-02', 'Network Interfaces', 0)`).run(sid);
    db.prepare(`INSERT INTO lm_alerts (source_id, lm_alert_id, condition_key, severity, severity_norm, lm_device_id, monitor_object_name, resource_template_name, cleared)
      VALUES (?, 'x2', 'ck-x2', 4, 'critical', 3, 'dal-acc-09', 'Network Interfaces', 0)`).run(sid);
    const m = byKey(manifest().collectAlerts({ db }));
    expect(m['link-burst|Acme|dallas'].groupKey).toBe('lm-burst:dallas');
    expect(m['interface-flapping|Acme|dal-acc-01 Gi1/0/4'].groupKey).toBe('lm-burst:dallas');
    expect(m['interface-flapping|Acme|dal-acc-09 Gi1/0/4'].groupKey).toBeUndefined();
    expect(m['ck-x1'].groupKey).toBe('lm-burst:dallas');
    expect(m['ck-x2'].groupKey).toBeUndefined();
  });
});

describe('incidentEvidence order and titles', () => {
  const manifest = () => require('../platforms/logicmonitor');

  function estate() {
    device(1, 'dal-acc-01');
    db.prepare("INSERT INTO lm_sites (source_id, site_key, site_name) VALUES (?, 'dallas', 'Dallas')").run(sid);
    iface(1, 'Gi1/0/7', [[60, 1], [20, 2], [3, 2]]);
    db.prepare(`INSERT INTO lm_alerts (source_id, lm_alert_id, condition_key, severity, severity_norm, lm_device_id, monitor_object_name, resource_template_name, cleared)
      VALUES (?, 'e1', 'ck-e1', 3, 'error', 1, 'dal-acc-01', 'Network Interfaces', 0)`).run(sid);
    db.prepare(`INSERT INTO lm_latency_episodes (source_id, subject_kind, check_id, checkpoint_id, subject_key, subject_label, site_key, kind, state, outcome, opened_at, closed_at, last_sample_epoch, peak_ratio)
      VALUES (?, 'check', 'w:1', '11', 'check:w:1:11', 'dal-acc-01 reachability @ den-col01', 'dallas', 'latency', 'closed', 'one-off', ?, ?, 1, 2.1)`)
      .run(sid, new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() - 80000000).toISOString());
  }

  it('puts the device and interface lines before the alerts, and the site lines before the episode lines', () => {
    estate();
    const ev = manifest().incidentEvidence({ db }, { names: ['dal-acc-01'], ips: [], siteKey: 'dallas' });
    expect(ev.title).toBe('LogicMonitor network');
    const idx = (re) => ev.lines.findIndex((l) => re.test(l));
    const dev = idx(/^Device dal-acc-01/);
    const ifc = idx(/^Interfaces on dal-acc-01: 1 down now/);
    const alert = idx(/^LM alert /);
    const site = idx(/^Site Dallas: .*, 1 open LM interface alerts$/);
    const epi = idx(/^Episode history/);
    expect(dev).toBeGreaterThanOrEqual(0);
    expect(ifc).toBe(dev + 1);
    expect(alert).toBeGreaterThan(ifc);
    expect(site).toBeGreaterThan(alert);
    expect(epi).toBeGreaterThan(site);
  });

  it('titles a site-only context "LogicMonitor site <name>"', () => {
    estate();
    const ev = manifest().incidentEvidence({ db }, { names: [], ips: [], siteKey: 'dallas' });
    expect(ev.title).toBe('LogicMonitor site Dallas');
    expect(ev.lines.some((l) => l.startsWith('Site Dallas: '))).toBe(true);
  });

  it('adds the probe-location line for an incident whose check is elevated from that location', () => {
    estate();
    db.prepare("INSERT INTO lm_issue_history (issue_key, source, severity, type, target, message, status) VALUES (?, 'Acme', 'critical', 'location-latency', 'den-col01', ?, 'open')")
      .run('location-latency|Acme|den-col01', '6 of 9 checks probed from den-col01 are elevated now (2 critical, median peak 1.3x): a, b; this points at the probe location or its upstream, not the destinations');
    db.prepare("UPDATE lm_latency_episodes SET state = 'degrading', outcome = NULL, closed_at = NULL").run();
    const ev = manifest().incidentEvidence({ db }, { names: ['dal-acc-01 reachability @ den-col01'], ips: [] });
    expect(ev.lines).toContain('Probe location den-col01: 6 of 9 checks elevated (2 critical), median 1.3x');
  });

  it('adds the estate-wide burst line while a link-burst issue is open', () => {
    device(1, 'dal-acc-01'); device(2, 'dal-acc-02');
    for (const p of [1, 2, 3]) wentDown(1, `Gi1/0/${p}`, 12);
    for (const p of [1, 2]) wentDown(2, `Gi1/0/${p}`, 12);
    shiftToNow();
    expect(lmLinks.estateBurstLine(db)).toBe(null);
    db.prepare("INSERT INTO lm_issue_history (issue_key, source, severity, type, target, message, status) VALUES ('link-burst|Acme|dallas', 'Acme', 'critical', 'link-burst', 'dallas', 'x', 'open')").run();
    expect(lmLinks.estateBurstLine(db)).toBe('Links down estate-wide in the last 30 min: 5 on 2 devices (Dallas)');
    const ev = manifest().incidentEvidence({ db }, { names: ['dal-acc-01'], ips: [] });
    expect(ev.lines).toContain('Links down estate-wide in the last 30 min: 5 on 2 devices (Dallas)');
  });
});
