/**
 * LogicMonitor round 10, WP-A: ERI (predef.externalResourceID) parsing, link
 * resolution, precedence over neighbour-instance links, the unmonitored
 * neighbour table and its folded issue. The live string comes from the first
 * real portal (CGSandBox).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const { encrypt } = require('../services/encryption');
const eri = require('../services/logicmonitorEri');
const lmPoller = require('../services/logicmonitorPoller');

const LIVE = 'interface:d4:78:9b:19:69:57,cdp-interface:asx1-bsleaf-1.capgroup.com(fdo231003gt)--ethernet1/12,lldp-interface:d4:78:9b:19:69:4b--ethernet1/12';

beforeAll(() => { runMigrations(db, 'logicmonitor', lmMigrations); });

describe('parseEri', () => {
  it('parses the live string', () => {
    const r = eri.parseEri(LIVE);
    expect(r.localMac).toBe('d4:78:9b:19:69:57');
    expect(r.cdp).toEqual([{
      name: 'asx1-bsleaf-1.capgroup.com', shortName: 'asx1-bsleaf-1', domain: 'capgroup.com', serial: 'fdo231003gt',
      port: 'ethernet1/12', raw: 'asx1-bsleaf-1.capgroup.com(fdo231003gt)',
    }]);
    expect(r.lldp).toEqual([{ chassisMac: 'd4:78:9b:19:69:4b', chassisRaw: 'd4:78:9b:19:69:4b', port: 'ethernet1/12' }]);
  });

  it('handles two cdp tokens, lldp only, upper-case MACs, missing serial and a domain-only name', () => {
    const two = eri.parseEri('interface:AA:BB:CC:00:00:01,cdp-interface:a-1(S1)--e1/1,cdp-interface:b-2.corp.local--e1/2');
    expect(two.localMac).toBe('aa:bb:cc:00:00:01');
    expect(two.cdp.map((c) => [c.shortName, c.serial, c.domain, c.port])).toEqual([['a-1', 'S1', null, 'e1/1'], ['b-2', null, 'corp.local', 'e1/2']]);
    const lldpOnly = eri.parseEri('lldp-interface:AA-BB-CC-DD-EE-FF--Gi1/0/1');
    expect(lldpOnly.cdp).toEqual([]);
    expect(lldpOnly.localMac).toBeNull();
    expect(lldpOnly.lldp[0]).toMatchObject({ chassisMac: 'aa:bb:cc:dd:ee:ff', port: 'Gi1/0/1' });
    expect(eri.parseEri(null)).toEqual({ localMac: null, cdp: [], lldp: [] });
    expect(eri.parseEri('cdp-interface: ').cdp[0].name).toBe('');
  });

  it('reads the property from props.auto, the demo array shape, or nothing', () => {
    expect(eri.extractEriText(JSON.stringify({ auto: { 'predef.externalResourceID': LIVE } }))).toBe(LIVE);
    expect(eri.extractEriText(JSON.stringify([{ name: 'predef.externalResourceID', value: LIVE }]))).toBe(LIVE);
    expect(eri.extractEriText(JSON.stringify({ auto: {} }))).toBeNull();
    expect(eri.extractEriText('not json')).toBeNull();
  });
});

describe('buildEriLinks and buildTopologyLinks', () => {
  let sid;
  const iface = (devId, instId, name, eriText, desc = null) => db.prepare(`
    INSERT INTO lm_interfaces (source_id, lm_device_id, hds_id, instance_id, instance_name, display_name, description, props_json, stale)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, 0)
  `).run(sid, devId, instId, `if-${name}`, name, desc, JSON.stringify({ auto: { 'predef.externalResourceID': eriText } }));
  const dev = (id, name, o = {}) => db.prepare(`
    INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, device_type, host_status, is_network, role, vendor, serial, eri_json, stale)
    VALUES (?, ?, ?, ?, 0, 'normal', 1, 'switch', 'Cisco', ?, ?, 0)
  `).run(sid, id, name, name, o.serial || null, JSON.stringify({ mac: o.mac || [], ip: [], fqdn: [] }));

  beforeEach(() => {
    for (const t of ['lm_unmonitored_neighbors', 'lm_topology_links', 'lm_interfaces', 'lm_devices', 'lm_sources']) db.prepare(`DELETE FROM ${t}`).run();
    sid = db.prepare(`INSERT INTO lm_sources (name, company, auth_mode, encrypted_credentials, last_poll_status) VALUES ('p', 'acme', 'lmv1', ?, 'success')`)
      .run(encrypt(JSON.stringify({ accessId: 'a', accessKey: 'b' }))).lastInsertRowid;
    dev(1, 'sw-a', { serial: 'AAA1111111', mac: ['00:11:22:33:44:01'] });
    dev(2, 'asx1-bsleaf-1', { serial: 'FDO231003GT', mac: ['d4:78:9b:19:69:4b'] });
    dev(3, 'sw-c', { mac: ['00:11:22:33:44:03'] });
    // sw-c port MACs share five octets with its chassis MAC
    iface(3, 301, 'Eth1/1', 'interface:00:11:22:33:44:77');
  });

  it('resolves cdp by name and serial, lldp by chassis MAC and by first five octets, ICC by resolver', () => {
    iface(1, 101, 'Eth1/12', LIVE);
    iface(1, 102, 'Eth1/13', 'cdp-interface:mystery-host--eth0,lldp-interface:00:11:22:33:44:99--eth0');
    iface(1, 103, 'Eth1/14', 'cdp-interface:esx-77.corp(zzz9999999)--vmnic0');
    const index = new Map([['sw-a', 1], ['asx1-bsleaf-1', 2], ['sw-c', 3]]);
    const resolver = (tok) => (String(tok).startsWith('esx-77') ? { platform: 'vcenter', ref: 'esx-77.corp' } : null);
    const out = eri.buildEriLinks(db, sid, { deviceIndex: index, resolver });
    const by = (inst, proto) => out.rows.find((r) => r.srcInstanceId === inst && r.protocol === proto);
    expect(by(101, 'cdp')).toMatchObject({ dstDeviceId: 2, dstPlatform: 'logicmonitor', confidence: 'high', dstPort: 'ethernet1/12', srcPort: 'Eth1/12' });
    expect(by(101, 'lldp')).toMatchObject({ dstDeviceId: 2, confidence: 'high' });
    expect(by(102, 'cdp')).toMatchObject({ dstDeviceId: null, dstPlatform: null, dstName: 'mystery-host', confidence: 'low' });
    // 00:11:22:33:44:99 is not a known MAC but shares five octets with sw-c's interface MAC and chassis MAC (device 3 only)
    expect(by(102, 'lldp')).toMatchObject({ dstDeviceId: 3, confidence: 'low' });
    expect(by(103, 'cdp')).toMatchObject({ dstDeviceId: null, dstPlatform: 'vcenter', dstRef: 'esx-77.corp' });
    expect(out.interfacesWithEri).toBe(4);
    expect(out.cdpTokens).toBe(3);
    expect(out.lldpTokens).toBe(2);
  });

  it('name-only matches are medium, serial matches are high, and a serial alone resolves', () => {
    iface(1, 111, 'Eth1/1', 'cdp-interface:sw-c--e1');
    iface(1, 112, 'Eth1/2', 'cdp-interface:renamed-sw(FDO231003GT)--e2');
    const index = new Map([['sw-a', 1], ['asx1-bsleaf-1', 2], ['sw-c', 3]]);
    const out = eri.buildEriLinks(db, sid, { deviceIndex: index, resolver: null });
    expect(out.rows.find((r) => r.srcInstanceId === 111)).toMatchObject({ dstDeviceId: 3, confidence: 'medium' });
    expect(out.rows.find((r) => r.srcInstanceId === 112)).toMatchObject({ dstDeviceId: 2, confidence: 'high' });
  });

  it('an ERI link takes precedence over a neighbour-instance link and fills lm_unmonitored_neighbors', () => {
    iface(1, 121, 'Eth1/21', 'cdp-interface:asx1-bsleaf-1(FDO231003GT)--e9');
    iface(1, 122, 'Eth1/22', 'cdp-interface:phx-ups-01.acme.local--eth0');
    iface(3, 123, 'Eth1/23', 'cdp-interface:phx-ups-01.acme.local--eth0,lldp-interface:e4a41ca6bffa--x');
    iface(3, 124, 'Eth1/24', 'cdp-interface: ,cdp-interface:e4a41ca6bffa--x');
    const neighbors = [
      { protocol: 'cdp', srcDeviceId: 1, instance: { instanceId: 121, displayName: 'sw-c', props: { auto: {} } } },
      { protocol: 'cdp', srcDeviceId: 3, instance: { instanceId: 301, displayName: 'sw-a', props: { auto: {} } } },
    ];
    const res = lmPoller.buildTopologyLinks(db, sid, { neighbors });
    const l121 = db.prepare("SELECT * FROM lm_topology_links WHERE src_instance_id = 121 AND protocol = 'cdp'").all();
    expect(l121.length).toBe(1);
    expect(l121[0].dst_device_id).toBe(2); // the instance link said sw-c (3); ERI wins
    expect(db.prepare("SELECT dst_device_id d FROM lm_topology_links WHERE src_instance_id = 301 AND protocol = 'cdp'").get().d).toBe(1);
    expect(res.eri.cdp).toBeGreaterThanOrEqual(3);
    const rows = db.prepare("SELECT * FROM lm_unmonitored_neighbors WHERE stale = 0 AND kind = 'cdp' ORDER BY neighbor_key").all();
    // the lldp chassis token e4a41ca6bffa normalizes to a real MAC, so it is an lldp neighbour; the cdp bare-hex name is dropped
    expect(db.prepare("SELECT neighbor_key FROM lm_unmonitored_neighbors WHERE kind = 'lldp'").all().map((r) => r.neighbor_key)).toEqual(['e4:a4:1c:a6:bf:fa']);
    expect(rows.map((r) => r.neighbor_key)).toEqual(['phx-ups-01']);
    expect(rows[0]).toMatchObject({ kind: 'cdp', ports_seen: 2, devices_seen: 2, neighbor_name: 'phx-ups-01.acme.local' });
    expect(eri.unmonitoredRows(db).length).toBe(2);

    const issues = eri.unmonitoredNeighborIssues(db, {}, new Map([[sid, 'p']]));
    expect(issues).toEqual([{ severity: 'info', type: 'unmonitored-neighbor', source: 'p', target: 'p',
      message: '2 devices seen by CDP/LLDP are not monitored (top: phx-ups-01.acme.local, e4:a4:1c:a6:bf:fa)' }]);
  });

  it('an unmonitored neighbour that disappears goes stale on the next build', () => {
    iface(1, 131, 'Eth1/31', 'cdp-interface:ghost-01--e1');
    lmPoller.buildTopologyLinks(db, sid);
    expect(eri.unmonitoredRows(db).map((r) => r.key)).toEqual(['ghost-01']);
    db.prepare('UPDATE lm_interfaces SET stale = 1 WHERE instance_id = 131').run();
    lmPoller.buildTopologyLinks(db, sid);
    expect(eri.unmonitoredRows(db)).toEqual([]);
    expect(eri.unmonitoredNeighborIssues(db, {}, new Map([[sid, 'p']]))).toEqual([]);
  });

  it('eriSummary counts interfaces, tokens and resolved links', () => {
    iface(1, 141, 'Eth1/41', LIVE);
    lmPoller.buildTopologyLinks(db, sid);
    const s = eri.eriSummary(db);
    expect(s).toMatchObject({ interfacesWithEri: 2, cdpTokens: 1, lldpTokens: 1, resolved: 2, unresolved: 0 });
  });
});
