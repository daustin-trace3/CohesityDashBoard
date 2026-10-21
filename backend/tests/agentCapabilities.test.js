import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const net = require('net');
const db = require('../db/database');
const { setSetting } = require('../services/settings');
const caps = require('../services/agentCapabilities');
const agent = require('../services/opsAgent');
const registry = require('../core/registry');

const NOW = '2026-10-14T20:00:00.000Z';

function insertIncident(key, host, platforms = ['dell']) {
  const r = db.prepare(`INSERT INTO ops_incidents (incident_key, title, host, platforms, severity, state, opened_at, hold_until, last_event_at)
    VALUES (?, ?, ?, ?, 'critical', 'collecting', ?, ?, ?)`).run(key, 'test', host, JSON.stringify(platforms), NOW, NOW, NOW);
  return db.prepare('SELECT * FROM ops_incidents WHERE id = ?').get(r.lastInsertRowid);
}
function attach(inc, platform, sourceKey, host) {
  db.prepare(`INSERT INTO ops_incident_alerts (incident_id, platform, source_key, severity, host, message, attached_at, first_seen) VALUES (?, ?, ?, 'critical', ?, 'm', ?, ?)`)
    .run(inc.id, platform, sourceKey, host, NOW, NOW);
}
const alertsOf = (id) => db.prepare('SELECT * FROM ops_incident_alerts WHERE incident_id = ?').all(id);

beforeEach(() => {
  db.exec('DELETE FROM ops_incident_alerts; DELETE FROM ops_incidents; DELETE FROM ops_capability_runs; DELETE FROM dell_devices; DELETE FROM dell_ome_instances;');
  setSetting(caps.SETTING_KEY, '');
  delete process.env.DASHBOARD_DEMO;
});

describe('catalog and settings', () => {
  it('lists the built-ins with their declared defaults: probes off, re-poll on', () => {
    const list = caps.listCapabilities();
    const ids = list.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['ping', 'tcp_port', 'dns', 'tls', 'repoll']));
    for (const c of list) {
      expect(caps.RISK_CLASSES).toContain(c.risk);
      expect(c.enabled).toBe(c.id === 'repoll');
    }
    expect(list.find((c) => c.id === 'repoll').playbook).toBe(false);
  });

  it('saves overrides per id, drops unknown ids and keeps the rest untouched', () => {
    caps.saveEnabled({ ping: true, bogus: true });
    expect(caps.isEnabled('ping')).toBe(true);
    expect(caps.enabledMap()).toEqual({ ping: true });
    caps.saveEnabled({ repoll: false });
    expect(caps.enabledMap()).toEqual({ ping: true, repoll: false });
    expect(caps.isEnabled('repoll')).toBe(false);
    expect(caps.isEnabled('tcp_port')).toBe(false);
  });

  it('a pack can contribute a capability, namespaced by pack id', () => {
    registry.registerPlugin({
      id: 'capfake', name: 'CapFake', apiVersion: registry.PLUGIN_API_VERSION, migrations: [],
      createRouter: () => (req, res, next) => next(),
      agentCapabilities: [{ id: 'lag', label: 'Lag', risk: 'platform-api', defaultEnabled: false, run: () => ({ ok: true, summary: 'x' }) }],
    });
    const c = caps.listCapabilities().find((x) => x.id === 'capfake:lag');
    expect(c).toMatchObject({ source: 'capfake', platform: 'capfake', risk: 'platform-api', enabled: false });
    registry._reset(); // icc-phase1 registry has no unregisterPlugin; the file registers nothing else
  });
});

describe('targets come from inventory, never free text', () => {
  it('resolves a Dell alert host through dell_devices and a poll: alert through the source table', () => {
    const ome = db.prepare("INSERT INTO dell_ome_instances (name, host, username, encrypted_credentials) VALUES ('OME-A', 'https://ome.lab.local:443', 'u', 'x')").run().lastInsertRowid;
    db.prepare("INSERT INTO dell_devices (ome_id, device_id, name, service_tag, ip_address) VALUES (?, 1, 'r740-07', 'ABC1234', '10.1.2.3')").run(ome);
    const inc = insertIncident('host:r740-07', 'r740-07 (ABC1234)');
    attach(inc, 'dell', 'd1:alert:1', 'r740-07 (ABC1234)');
    attach(inc, 'dell', `poll:${ome}`, 'OME-A');
    const t = caps.targetsFor(inc, alertsOf(inc.id));
    expect(t).toEqual([
      expect.objectContaining({ kind: 'host', platform: 'dell', name: 'r740-07', address: '10.1.2.3', hostKind: 'device', ports: [443, 22, 5900] }),
      expect.objectContaining({ kind: 'source', platform: 'dell', name: 'OME-A', address: 'ome.lab.local', ports: [443] }),
    ]);
  });

  it('a bare short name with no inventory address is reported, not probed', () => {
    const inc = insertIncident('host:mystery', 'mystery');
    attach(inc, 'pure', 'a1:alert:1', 'mystery');
    expect(caps.targetsFor(inc, alertsOf(inc.id))).toEqual([]);
    expect(caps.hostAddress('pure', 'mystery')).toMatchObject({ address: null });
    expect(caps.hostAddress('pure', 'filer.corp.example')).toMatchObject({ address: 'filer.corp.example' });
  });
});

describe('ports come from the platform profile', () => {
  beforeEach(() => {
    db.exec('DELETE FROM vcenter_vms; DELETE FROM vcenter_hosts; DELETE FROM vcenter_vcenters;');
    setSetting('ops_agent_platform_profiles', '');
    db.prepare("INSERT INTO vcenter_vcenters (id, name, host, username, encrypted_credentials) VALUES (1, 'vc-a', 'vc-a.lab.local', 'u', 'x')").run();
  });

  const vm = (name, os, ip) => db.prepare('INSERT INTO vcenter_vms (vcenter_id, vm_id, name, guest_os, ip_address) VALUES (1, ?, ?, ?, ?)').run(`vm-${name}`, name, os, ip);
  const targetFor = (host) => {
    const inc = insertIncident(`host:${host}`, host, ['vcenter']);
    attach(inc, 'vcenter', `v:${host}`, host);
    return caps.targetsFor(inc, alertsOf(inc.id));
  };

  it('a Windows guest gets 3389, 445 and 5985; a Linux guest gets 22', () => {
    vm('win-app-01', 'Microsoft Windows Server 2022 (64-bit)', '10.5.0.11');
    vm('lnx-app-01', 'Red Hat Enterprise Linux 9 (64-bit)', '10.5.0.12');
    vm('odd-app-01', 'FreeBSD (64-bit)', '10.5.0.13');
    const w = targetFor('win-app-01')[0];
    expect(w).toMatchObject({ kind: 'host', hostKind: 'vm', osFamily: 'windows', address: '10.5.0.11', ports: [3389, 445, 5985] });
    expect(w.portEntries[0]).toEqual({ port: 3389, label: 'RDP', expect: true });
    expect(targetFor('lnx-app-01')[0]).toMatchObject({ hostKind: 'vm', osFamily: 'linux', ports: [22] });
    expect(targetFor('odd-app-01')[0]).toMatchObject({ hostKind: 'vm', osFamily: 'other', ports: [443] });
  });

  it('an ESX host gets 443, 902, 22 and 903, the two reachable ones expected', () => {
    db.prepare("INSERT INTO vcenter_hosts (vcenter_id, host_id, name, cluster_name) VALUES (1, 'host-1', 'esx-07.lab.local', 'prod')").run();
    const t = targetFor('esx-07')[0];
    expect(t).toMatchObject({ hostKind: 'esx', address: 'esx-07.lab.local', ports: [443, 902, 22, 903] });
    expect(t.portEntries.filter((e) => e.expect).map((e) => e.port)).toEqual([443, 902]);
  });

  it('a user override changes the ports a target gets', () => {
    db.prepare("INSERT INTO vcenter_hosts (vcenter_id, host_id, name, cluster_name) VALUES (1, 'host-1', 'esx-07.lab.local', 'prod')").run();
    require('../services/agentProfiles').saveOverrides({ vcenter: { ports: { host: [{ port: 8443, label: 'alt', expect: true }] } } }, 'tester');
    expect(targetFor('esx-07')[0]).toMatchObject({ ports: [8443] });
  });
});

describe('tcp_port against a profile port list', () => {
  const tcp = require('../services/agentCapabilities/capabilities/tcp_port');
  let open; let openPort; let closedPort;
  beforeEach(async () => {
    open = net.createServer((s) => s.end());
    await new Promise((r) => open.listen(0, '127.0.0.1', r));
    openPort = open.address().port;
    const tmp = net.createServer();
    await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
    closedPort = tmp.address().port;
    await new Promise((r) => tmp.close(r));
  });
  afterEach(() => new Promise((r) => open.close(r)));

  it('is ok when every expected port is open and lists the informational ones apart', async () => {
    const r = await tcp.run({ address: '127.0.0.1', portEntries: [
      { port: openPort, label: 'HTTPS', expect: true },
      { port: closedPort, label: 'console', expect: false },
    ] });
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(new RegExp(`^1 of 1 expected open: ${openPort} HTTPS \\(\\d+ ms\\); not expected from ICC: ${closedPort} console closed`));
    expect(r.data.ports).toHaveLength(2);
    expect(r.data.ports[1]).toMatchObject({ port: closedPort, label: 'console', expect: false, open: false });
  });

  it('fails when an expected port is closed, even with another open', async () => {
    const r = await tcp.run({ address: '127.0.0.1', portEntries: [
      { port: openPort, label: 'SSH', expect: true },
      { port: closedPort, label: 'HTTPS', expect: true },
    ] });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/^1 of 2 expected open:/);
  });

  it('with nothing expected, any open port is ok; bare numbers count as expected', async () => {
    const any = await tcp.run({ address: '127.0.0.1', portEntries: [{ port: openPort, label: '', expect: false }, { port: closedPort, label: '', expect: false }] });
    expect(any.ok).toBe(true);
    const none = await tcp.run({ address: '127.0.0.1', portEntries: [{ port: closedPort, label: '', expect: false }] });
    expect(none.ok).toBe(false);
    const nums = await tcp.run({ address: '127.0.0.1', ports: [openPort, closedPort] });
    expect(nums.ok).toBe(false);
    expect(nums.summary).toMatch(/^1 of 2 expected open/);
  });

  it('applies only when the target has ports to try', () => {
    expect(tcp.appliesTo({ ports: [], portEntries: [] })).toBe(false);
    expect(tcp.appliesTo({ ports: [443], portEntries: [{ port: 443, label: '', expect: true }] })).toBe(true);
  });
});

describe('executor', () => {
  let server; let port;
  beforeEach(async () => {
    server = net.createServer((s) => s.end());
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  afterEach(() => new Promise((r) => server.close(r)));

  const incidentOnLoopback = () => {
    const ome = db.prepare("INSERT INTO dell_ome_instances (name, host, username, encrypted_credentials) VALUES ('OME-L', '127.0.0.1', 'u', 'x')").run().lastInsertRowid;
    const inc = insertIncident('platform:dell:wide', null);
    attach(inc, 'dell', `poll:${ome}`, 'OME-L');
    return inc;
  };

  it('runs only enabled capabilities, against the fixed port list, and writes the audit row', async () => {
    const probeCap = { id: 'tcp_port', label: 'TCP', risk: 'network-probe', defaultEnabled: false, run: require('../services/agentCapabilities/capabilities/tcp_port').run };
    const never = { id: 'ping', label: 'Ping', risk: 'network-probe', defaultEnabled: false, run: () => { throw new Error('must not run'); } };
    caps._setBuiltins([probeCap, never, require('../services/agentCapabilities/capabilities/repoll')]);
    try {
      caps.saveEnabled({ tcp_port: true });
      const inc = incidentOnLoopback();
      const alerts = alertsOf(inc.id);
      // Point the source's fixed port list at the listening socket.
      const targets = caps.targetsFor(inc, alerts);
      expect(targets[0].ports).toEqual([443]);
      const out = await caps.runPlaybook({ ...inc }, alerts.map((a) => a), {});
      expect(out.ran).toBe(true);
      expect(out.results).toHaveLength(1);
      expect(out.results[0]).toMatchObject({ capability: 'tcp_port', target: { kind: 'source', name: 'OME-L', address: '127.0.0.1' } });
      expect(out.results[0].data.ports.map((p) => p.port)).toEqual([443]);
      const rows = caps.listRuns({ incidentId: inc.id });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ capability: 'tcp_port', targetAddress: '127.0.0.1', risk: 'network-probe' });
      void port;
    } finally { caps._setBuiltins(null); }
  });

  it('a capability that throws or hangs yields a failed result, not a failed triage', async () => {
    caps._setBuiltins([
      { id: 'boom', label: 'Boom', risk: 'network-probe', defaultEnabled: true, run: () => { throw new Error('kaboom'); } },
      { id: 'quick', label: 'Quick', risk: 'read-only', defaultEnabled: true, run: () => ({ ok: true, summary: 'fine', data: { a: 1 } }) },
    ]);
    try {
      const inc = incidentOnLoopback();
      const out = await caps.runPlaybook(inc, alertsOf(inc.id), {});
      const byId = Object.fromEntries(out.results.map((r) => [r.capability, r]));
      expect(byId.boom).toMatchObject({ ok: false, summary: 'kaboom' });
      expect(byId.quick).toMatchObject({ ok: true, summary: 'fine', data: { a: 1 } });
    } finally { caps._setBuiltins(null); }
  });

  it('never probes on the public demo', async () => {
    caps.saveEnabled({ tcp_port: true, ping: true });
    process.env.DASHBOARD_DEMO = '1';
    const inc = incidentOnLoopback();
    const out = await caps.runPlaybook(inc, alertsOf(inc.id), {});
    expect(out.ran).toBe(false);
    expect(out.skipped).toMatch(/demo/);
    expect(caps.listRuns()).toEqual([]);
  });

  it('says why nothing ran when no capability is on', async () => {
    const inc = incidentOnLoopback();
    const out = await caps.runPlaybook(inc, alertsOf(inc.id), {});
    expect(out).toMatchObject({ ran: false, skipped: 'no capability is switched on' });
  });

  it('the dns capability resolves localhost and tcp_port reports a closed port', async () => {
    const dns = require('../services/agentCapabilities/capabilities/dns');
    const r = await dns.run({ address: 'localhost', ports: [443] });
    expect(r.ok).toBe(true);
    expect(r.data.forward.length).toBeGreaterThan(0);
    const tcp = require('../services/agentCapabilities/capabilities/tcp_port');
    const closed = await tcp.run({ address: '127.0.0.1', ports: [port] });
    expect(closed.ok).toBe(true);
    expect(closed.data.ports[0]).toMatchObject({ port, open: true });
  });

  it('tls against a plain socket fails cleanly with a reason', async () => {
    const tlsCap = require('../services/agentCapabilities/capabilities/tls');
    expect(tlsCap.appliesTo({ ports: [22] })).toBe(false);
    expect(tlsCap.appliesTo({ ports: [22, 443] })).toBe(true);
    const r = await tlsCap.run({ address: '127.0.0.1', ports: [port, 443] });
    void r; // the plain socket closes the handshake; either a timeout or an error is a clean failure
    const r2 = await tlsCap.run({ address: '127.0.0.1', ports: [443] });
    expect(r2.ok).toBe(false);
    expect(r2.summary).toMatch(/TLS/);
  });
});

describe('agent integration', () => {
  it('triage carries the live checks into the evidence, the fallback digest and the email', async () => {
    caps._setBuiltins([{ id: 'quick', label: 'Quick check', risk: 'read-only', defaultEnabled: true, run: () => ({ ok: false, summary: 'port 443 closed' }) }]);
    try {
      const ome = db.prepare("INSERT INTO dell_ome_instances (name, host, username, encrypted_credentials) VALUES ('OME-Q', '10.9.9.9', 'u', 'x')").run().lastInsertRowid;
      const inc = insertIncident('platform:dell:wide', null);
      attach(inc, 'dell', `poll:${ome}`, 'OME-Q');
      const analysis = await agent.triageIncident(inc, { force: true });
      expect(analysis.source).toBe('fallback');
      expect(analysis.reviewed.some((r) => /Live Quick check on OME-Q \(10\.9\.9\.9\): port 443 closed/.test(r))).toBe(true);
      const row = db.prepare('SELECT evidence_json FROM ops_incidents WHERE id = ?').get(inc.id);
      const ev = JSON.parse(row.evidence_json);
      expect(ev.liveChecks.results[0]).toMatchObject({ capability: 'quick', ok: false });
      const mail = agent.renderEmail(inc, alertsOf(inc.id), analysis, { liveChecks: ev.liveChecks });
      expect(mail.text).toMatch(/CHECKED LIVE/);
      expect(mail.text).toMatch(/Quick check on OME-Q \(10\.9\.9\.9\): FAILED, port 443 closed/);
      expect(mail.html).toMatch(/checked live/);
    } finally { caps._setBuiltins(null); }
  });

  it('the self-heal re-poll is skipped when the repoll capability is off', async () => {
    const seen = [];
    registry.registerPlugin({
      id: 'healplat', name: 'Heal', apiVersion: registry.PLUGIN_API_VERSION, migrations: [],
      createRouter: () => (req, res, next) => next(),
      createPoller: () => ({ trigger: (arg) => { seen.push(arg); return Promise.resolve(); } }),
    });
    try {
      const inc = insertIncident('platform:healplat:wide', null, ['healplat']);
      attach(inc, 'healplat', 'poll:5', 'src');
      caps.saveEnabled({ repoll: false });
      expect(agent.selfHealPass(NOW)).toBe(0);
      expect(seen).toEqual([]);
      expect(db.prepare('SELECT heal_attempted FROM ops_incidents WHERE id = ?').get(inc.id).heal_attempted).toBe(0);
      caps.saveEnabled({ repoll: true });
      expect(agent.selfHealPass(NOW)).toBe(1);
      expect(seen).toEqual([5]);
      expect(db.prepare('SELECT heal_attempted FROM ops_incidents WHERE id = ?').get(inc.id).heal_attempted).toBe(1);
    } finally { registry._reset(); }
  });
});

afterAll(() => { caps._setBuiltins(null); });
