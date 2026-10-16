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

// The live ERI of an interface on snot-bleaf-1-1: it names the interface's OWN device (different domain than LM's display name).
const OWN = 'interface:00:3a:9c:03:9b:8c,cdp-interface:snot-bleaf-1-1.capgroup.com(fdo22200gd7)--ethernet1/37,lldp-interface:00:3a:9c:03:9b:67--ethernet1/37';

describe('identity index, resolveNeighbor and buildTopologyLinks', () => {
  let sid;
  const iface = (devId, instId, name, eriText, desc = null) => db.prepare(`
    INSERT INTO lm_interfaces (source_id, lm_device_id, hds_id, instance_id, instance_name, display_name, description, props_json, stale)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, 0)
  `).run(sid, devId, instId, `if-${name}`, name, desc, JSON.stringify({ auto: { 'predef.externalResourceID': eriText } }));
  const dev = (id, name, o = {}) => db.prepare(`
    INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, device_type, host_status, is_network, role, vendor, serial, eri_json, stale)
    VALUES (?, ?, ?, ?, 0, 'normal', 1, 'switch', 'Cisco', ?, ?, 0)
  `).run(sid, id, name, name, o.serial || null, JSON.stringify({ mac: o.mac || [], ip: [], fqdn: [] }));
  const nbr = (protocol, srcDeviceId, instanceId, displayName, remotePort = null) => ({
    protocol, srcDeviceId,
    instance: { instanceId, displayName, props: { auto: remotePort ? { 'neighbor.remote_port': remotePort } : {} } },
  });
  const index = () => new Map([['sw-a', 1], ['snot-bleaf-1-1.cgftdev.com', 2], ['snot-bleaf-1-1', 2], ['sw-c', 3]]);

  beforeEach(() => {
    for (const t of ['lm_unmonitored_neighbors', 'lm_topology_links', 'lm_interfaces', 'lm_devices', 'lm_sources']) db.prepare(`DELETE FROM ${t}`).run();
    sid = db.prepare(`INSERT INTO lm_sources (name, company, auth_mode, encrypted_credentials, last_poll_status) VALUES ('p', 'acme', 'lmv1', ?, 'success')`)
      .run(encrypt(JSON.stringify({ accessId: 'a', accessKey: 'b' }))).lastInsertRowid;
    dev(1, 'sw-a');
    dev(2, 'snot-bleaf-1-1.cgftdev.com', { serial: 'FDO22200GD7' });
    dev(3, 'sw-c');
    iface(2, 201, 'Ethernet1/37', OWN);
    iface(2, 202, 'Ethernet1/38', 'interface:00:3a:9c:03:9b:8d,cdp-interface:snot-bleaf-1-1.capgroup.com(fdo22200gd7)--ethernet1/38,lldp-interface:00:3a:9c:03:9b:67--ethernet1/38');
    iface(1, 101, 'Eth1/1', 'interface:aa:bb:cc:00:00:01,cdp-interface:sw-a.capgroup.com--eth1/1');
  });

  it('builds the identity index from the interface ERIs (own device, not a neighbour)', () => {
    const idn = eri.buildIdentityIndex(db, sid);
    expect(idn.names.get('snot-bleaf-1-1')).toBe(2);
    expect(idn.serials.get('fdo22200gd7')).toBe(2);
    expect(idn.chassis.get('00:3a:9c:03:9b:67')).toBe(2);
    expect(idn.macs.get('00:3a:9c:03:9b:8c')).toEqual({ deviceId: 2, instanceId: 201, port: 'Ethernet1/37' });
    expect(idn.ports.get('snot-bleaf-1-1|ethernet1/37')).toMatchObject({ deviceId: 2, instanceId: 201 });
    expect(idn.ports.get('00:3a:9c:03:9b:67|ethernet1/38')).toMatchObject({ instanceId: 202 });
    expect(idn.interfacesWithEri).toBe(3);
    // buildEriLinks emits no links any more
    const out = eri.buildEriLinks(db, sid);
    expect(out.rows).toEqual([]);
    expect(out).toMatchObject({ interfacesWithEri: 3, cdpTokens: 3, lldpTokens: 2 });
  });

  it('resolveNeighbor: sysname with port, serial, chassis MAC, then the device index, then the ICC resolver', () => {
    const idn = eri.buildIdentityIndex(db, sid);
    const r = (o, resolver = null) => eri.resolveNeighbor(idn, index(), resolver, { selfId: 1, ...o });
    // sysname (different domain than LM's display name) with the remote port resolved to the far interface name
    expect(r({ name: 'snot-bleaf-1-1.capgroup.com(fdo22200gd7)', port: 'Ethernet1/37' }))
      .toMatchObject({ dstDeviceId: 2, dstPlatform: 'logicmonitor', confidence: 'high', via: 'eri', dstPort: 'Ethernet1/37' });
    // serial only
    expect(r({ name: 'renamed-box', serial: 'FDO22200GD7', port: 'x' })).toMatchObject({ dstDeviceId: 2, confidence: 'high', via: 'eri' });
    // chassis MAC as the neighbour name
    expect(r({ name: '00:3a:9c:03:9b:67', port: 'ethernet1/38' })).toMatchObject({ dstDeviceId: 2, via: 'eri', dstPort: 'Ethernet1/38' });
    // known sysname, unknown port: device kept, port left as the neighbour gave it
    expect(r({ name: 'snot-bleaf-1-1', port: 'Ethernet1/99' })).toMatchObject({ dstDeviceId: 2, dstPort: 'Ethernet1/99' });
    // not in the identity index, but the LM device index has it
    expect(r({ name: 'sw-c.corp.local' })).toMatchObject({ dstDeviceId: 3, confidence: 'medium', via: 'name' });
    // another platform
    const icc = (tok) => (String(tok).startsWith('esx-77') ? { platform: 'vcenter', ref: 'esx-77.corp' } : null);
    expect(r({ name: 'esx-77.corp', port: 'vmnic0' }, icc)).toMatchObject({ dstDeviceId: null, dstPlatform: 'vcenter', dstRef: 'esx-77.corp', via: 'icc' });
    // nothing knows it
    expect(r({ name: 'ascx-core-1.capgroup.com(fox2151pjj1)', port: 'e1' }))
      .toMatchObject({ dstDeviceId: null, dstPlatform: null, confidence: 'low', via: null, dstPort: 'e1' });
    // a loop back to the source device is not a hit
    expect(eri.resolveNeighbor(idn, index(), null, { name: 'snot-bleaf-1-1', selfId: 2 }).dstDeviceId).toBeNull();
  });

  it('buildTopologyLinks sends neighbour instances through resolveNeighbor and fills the unmonitored table', () => {
    const neighbors = [
      nbr('cdp', 1, 5001, 'snot-bleaf-1-1.capgroup.com(fdo22200gd7)', 'Ethernet1/37'),
      nbr('lldp', 3, 5002, '00:3a:9c:03:9b:67', 'ethernet1/38'),
      nbr('cdp', 1, 5003, 'sw-c.corp'),
      nbr('cdp', 1, 5004, 'ascx-core-1.capgroup.com(fox2151pjj1)', 'e1/1'),
      nbr('cdp', 3, 5005, 'ascx-core-1.capgroup.com(fox2151pjj1)', 'e1/2'),
      nbr('lldp', 1, 5006, 'e4a41ca6bffa', 'x'),
      nbr('cdp', 1, 5007, ' ', 'y'),
      nbr('cdp', 1, 5008, 'e4a41ca6bffa', 'z'),
      nbr('lldp', 3, 5009, 'unknown-firewall', 'p1'),
    ];
    const res = lmPoller.buildTopologyLinks(db, sid, { neighbors });
    const get = (inst, proto) => db.prepare('SELECT * FROM lm_topology_links WHERE src_instance_id = ? AND protocol = ?').get(inst, proto);
    expect(get(5001, 'cdp')).toMatchObject({ dst_device_id: 2, dst_port: 'Ethernet1/37', confidence: 'high', dst_platform: 'logicmonitor' });
    expect(get(5002, 'lldp')).toMatchObject({ dst_device_id: 2, dst_port: 'Ethernet1/38', confidence: 'high' });
    expect(get(5003, 'cdp')).toMatchObject({ dst_device_id: 3, confidence: 'medium' });
    expect(get(5004, 'cdp')).toMatchObject({ dst_device_id: null, dst_platform: null, dst_name: 'ascx-core-1.capgroup.com(fox2151pjj1)' });
    expect(res.eri.neighborsResolvedByEri).toBe(2);

    const rows = eri.unmonitoredRows(db);
    const byKey = Object.fromEntries(rows.map((x) => [x.key, x]));
    expect(Object.keys(byKey).sort()).toEqual(['ascx-core-1', 'e4:a4:1c:a6:bf:fa', 'unknown-firewall']);
    expect(byKey['ascx-core-1']).toMatchObject({ kind: 'cdp', portsSeen: 2, devicesSeen: 2, name: 'ascx-core-1.capgroup.com' });
    expect(byKey['e4:a4:1c:a6:bf:fa'].kind).toBe('lldp');
    expect(byKey['unknown-firewall'].kind).toBe('lldp');
    // blank and bare-hex cdp names are skipped
    expect(rows.find((x) => x.kind === 'cdp' && (x.key === '' || x.key === 'e4a41ca6bffa'))).toBeUndefined();

    const issues = eri.unmonitoredNeighborIssues(db, {}, new Map([[sid, 'p']]));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'info', type: 'unmonitored-neighbor', source: 'p' });
    expect(issues[0].message.startsWith('3 devices seen by CDP/LLDP are not monitored (top: ascx-core-1.capgroup.com')).toBe(true);
  });

  it('a description-only rebuild leaves the unmonitored table alone, and a neighbour that disappears goes stale', () => {
    lmPoller.buildTopologyLinks(db, sid, { neighbors: [nbr('cdp', 1, 5101, 'ghost-01.corp', 'e1')] });
    expect(eri.unmonitoredRows(db).map((x) => x.key)).toEqual(['ghost-01']);
    lmPoller.buildTopologyLinks(db, sid);
    expect(eri.unmonitoredRows(db).map((x) => x.key)).toEqual(['ghost-01']);
    lmPoller.buildTopologyLinks(db, sid, { neighbors: [] });
    expect(eri.unmonitoredRows(db)).toEqual([]);
    expect(eri.unmonitoredNeighborIssues(db, {}, new Map([[sid, 'p']]))).toEqual([]);
  });

  it('eriSummary reports the identity index, resolved-by-ERI and unmonitored counts', () => {
    lmPoller.buildTopologyLinks(db, sid, { neighbors: [
      nbr('cdp', 1, 5201, 'snot-bleaf-1-1.capgroup.com(fdo22200gd7)', 'Ethernet1/37'),
      nbr('cdp', 1, 5202, 'ghost-02.corp', 'e1'),
    ] });
    const s = eri.eriSummary(db);
    expect(s).toMatchObject({
      interfacesWithEri: 3, cdpTokens: 3, lldpTokens: 2, identityNames: 2, identitySerials: 1, identityChassis: 1,
      neighborsResolvedByEri: 1, unmonitored: 1, resolved: 1, unresolved: 1,
    });
  });
});

