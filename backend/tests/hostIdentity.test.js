/**
 * LogicMonitor round 9, WP3: cross-platform host identity index and resolver.
 * Uses a private in-memory database so no platform migration has to run; the
 * tables carry only the columns the readers use, with and without the round 9
 * columns (vcenter_hosts.serial / service_tag, dell_devices.idrac_mac).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const hi = require('../services/hostIdentity');
const lmEndpoints = require('../services/logicmonitorEndpoints');

function seed(db, { round9 = true } = {}) {
  db.exec(`
    CREATE TABLE vcenter_hosts (id INTEGER PRIMARY KEY, vcenter_id INTEGER, host_id TEXT, name TEXT${round9 ? ', serial TEXT, service_tag TEXT, uuid TEXT' : ''});
    CREATE TABLE vcenter_networks (id INTEGER PRIMARY KEY, vcenter_id INTEGER, host_name TEXT, kind TEXT, name TEXT, mac TEXT, ip_address TEXT);
    CREATE TABLE vcenter_vms (id INTEGER PRIMARY KEY, vcenter_id INTEGER, vm_id TEXT, name TEXT, host_name TEXT, ip_address TEXT, guest_hostname TEXT, guest_nics TEXT);
    CREATE TABLE dell_devices (id INTEGER PRIMARY KEY, ome_id INTEGER, device_id INTEGER, service_tag TEXT, name TEXT, model TEXT,
      chassis_service_tag TEXT, ip_address TEXT${round9 ? ', idrac_mac TEXT, os_hostname TEXT' : ''});
    CREATE TABLE dell_components (id INTEGER PRIMARY KEY, ome_id INTEGER, device_id INTEGER, kind TEXT, extra TEXT);
    CREATE TABLE clusters (id INTEGER PRIMARY KEY, name TEXT, vip TEXT);
    CREATE TABLE netapp_arrays (id INTEGER PRIMARY KEY, name TEXT, management_ip TEXT, mgmt_host TEXT);
    CREATE TABLE netapp_nodes (id INTEGER PRIMARY KEY, array_id INTEGER, name TEXT, serial_number TEXT);
    CREATE TABLE netapp_lifs (id INTEGER PRIMARY KEY, array_id INTEGER, address TEXT, node_name TEXT, port_name TEXT);
    CREATE TABLE pure_arrays (id INTEGER PRIMARY KEY, name TEXT, mgmt_host TEXT);
    CREATE TABLE pure_controllers (id INTEGER PRIMARY KEY, array_id INTEGER, name TEXT);
    CREATE TABLE pure_network_interfaces (id INTEGER PRIMARY KEY, array_id INTEGER, address TEXT, mac_address TEXT);
    CREATE TABLE brocade_switches (id INTEGER PRIMARY KEY, name TEXT, ip_address TEXT, wwn TEXT, serial_number TEXT);
    CREATE TABLE zerto_sites (id INTEGER PRIMARY KEY, name TEXT, zvm_ip TEXT);
    CREATE TABLE unifi_devices (id INTEGER PRIMARY KEY, name TEXT, ip TEXT, mac TEXT, serial TEXT);
  `);
  db.prepare(`INSERT INTO vcenter_hosts (vcenter_id, host_id, name${round9 ? ', serial, service_tag' : ''}) VALUES (1, ?, ?${round9 ? ', ?, ?' : ''})`)
    .run(...['h1', 'esx01.corp.local', ...(round9 ? ['ABC1234', 'ABC1234'] : [])]);
  db.prepare(`INSERT INTO vcenter_hosts (vcenter_id, host_id, name${round9 ? ', serial, service_tag' : ''}) VALUES (1, ?, ?${round9 ? ', ?, ?' : ''})`)
    .run(...['h2', 'esx9.a.local', ...(round9 ? [null, null] : [])]);
  db.prepare(`INSERT INTO vcenter_hosts (vcenter_id, host_id, name${round9 ? ', serial, service_tag' : ''}) VALUES (1, ?, ?${round9 ? ', ?, ?' : ''})`)
    .run(...['h3', 'esx9.b.local', ...(round9 ? [null, null] : [])]);
  db.prepare("INSERT INTO vcenter_networks (vcenter_id, host_name, kind, mac, ip_address) VALUES (1, 'esx01.corp.local', 'vmkernel', NULL, '10.1.1.11')").run();
  db.prepare("INSERT INTO vcenter_networks (vcenter_id, host_name, kind, mac, ip_address) VALUES (1, 'esx01.corp.local', 'pnic', 'AA:BB:CC:00:00:01', NULL)").run();
  db.prepare("INSERT INTO vcenter_vms (vcenter_id, vm_id, name, host_name, ip_address, guest_hostname, guest_nics) VALUES (1, 'vm-1', 'web01', 'esx01.corp.local', '10.9.9.9', 'web01.corp.local', ?)")
    .run(JSON.stringify([{ ips: ['10.9.9.10'], mac: '00:50:56:aa:bb:cc' }]));
  // Dell: one server that is the ESX host above (service tag join), one standalone with an iDRAC MAC.
  const dell = db.prepare(`INSERT INTO dell_devices (ome_id, device_id, service_tag, name, model, chassis_service_tag, ip_address${round9 ? ', idrac_mac, os_hostname' : ''}) VALUES (1, ?, ?, ?, 'R650', 'CHS0001', ?${round9 ? ', ?, ?' : ''})`);
  dell.run(...[1, 'ABC1234', 'dell-esx01', '10.1.2.11', ...(round9 ? ['c8:4b:d6:a1:6e:01', 'esx01.corp.local'] : [])]);
  dell.run(...[2, 'XYZ9876', 'pentest1', '10.1.2.12', ...(round9 ? ['c8:4b:d6:a1:6e:31', 'pentest1'] : [])]);
  db.prepare("INSERT INTO dell_components (ome_id, device_id, kind, extra) VALUES (1, 2, 'os', ?)").run(JSON.stringify({ hostname: 'pentest1.corp.local' }));
  db.prepare("INSERT INTO dell_components (ome_id, device_id, kind, extra) VALUES (1, 2, 'nic', ?)").run(JSON.stringify({ ports: [{ portId: '1', macs: ['B0:7B:25:11:22:33'] }] }));
  db.prepare("INSERT INTO clusters (id, name, vip) VALUES (1, 'snotbkagcl-az', '10.2.0.5')").run();
  db.prepare("INSERT INTO netapp_arrays (id, name, management_ip, mgmt_host) VALUES (1, 'asx1nacls', '10.3.0.5', 'asx1nacls.corp.local')").run();
  db.prepare("INSERT INTO netapp_nodes (array_id, name, serial_number) VALUES (1, 'asx1nacls-01', '721234567890')").run();
  db.prepare("INSERT INTO netapp_nodes (array_id, name, serial_number) VALUES (1, 'asx1nacls-02', '721234567891')").run();
  db.prepare("INSERT INTO netapp_lifs (array_id, address, node_name, port_name) VALUES (1, '10.3.1.2', 'asx1nacls-02', 'e4a')").run();
  db.prepare("INSERT INTO pure_arrays (id, name, mgmt_host) VALUES (1, 'snx2gcprdr1sa01', '10.4.0.5')").run();
  db.prepare("INSERT INTO pure_controllers (array_id, name) VALUES (1, 'CT0'), (1, 'CT1')").run();
  db.prepare("INSERT INTO pure_network_interfaces (array_id, address, mac_address) VALUES (1, '10.4.0.6', '24:a9:37:00:00:01')").run();
  db.prepare("INSERT INTO brocade_switches (name, ip_address, wwn, serial_number) VALUES ('chx1-pfs-1', '10.5.0.5', '10:00:50:eb:1a:00:00:01', 'BRC0001')").run();
  db.prepare("INSERT INTO zerto_sites (name, zvm_ip) VALUES ('phx-zvm', '10.6.0.5')").run();
  db.prepare("INSERT INTO unifi_devices (name, ip, mac, serial) VALUES ('udm-pro', '10.7.0.1', 'f0:9f:c2:00:00:01', 'UNIFI01')").run();
}

let db;
beforeEach(() => { db = new Database(':memory:'); });

describe('buildIdentityIndex', () => {
  it('reads every platform and merges a Dell server that is an ESX host into one ref', () => {
    seed(db);
    const idx = hi.buildIdentityIndex(db, { fresh: true });
    const host = idx.byName.get('esx01.corp.local');
    expect(host).toMatchObject({ platform: 'vcenter', kind: 'host', refKey: 'esx01.corp.local' });
    expect(host.platforms).toEqual(['vcenter', 'dell']);
    expect(host.alsoKnownAs).toEqual(expect.arrayContaining([{ platform: 'dell', refKey: 'dell-esx01' }]));
    // the Dell names, address and MAC resolve to the same ref
    expect(hi.resolveToken(idx, 'dell-esx01')).toBe(host);
    expect(idx.byIp.get('10.1.2.11')).toBe(host);
    expect(idx.byIp.get('10.1.1.11')).toBe(host);
    expect(idx.byMac.get('c8:4b:d6:a1:6e:01')).toBe(host);
    expect(idx.byMac.get('aa:bb:cc:00:00:01')).toBe(host);
    // standalone Dell keeps its own ref and the OS hostname
    const pen = idx.byName.get('pentest1');
    expect(pen).toMatchObject({ platform: 'dell', platforms: ['dell'] });
    expect(pen.names).toEqual(expect.arrayContaining(['pentest1', 'pentest1.corp.local']));
    expect(idx.byMac.get('b0:7b:25:11:22:33')).toBe(pen);
    expect(pen.chassisTag).toBe('CHS0001');
    // every other platform is present
    const platforms = new Set([...idx.refs.values()].flatMap((r) => r.platforms));
    expect([...platforms].sort()).toEqual(['brocade', 'cohesity', 'dell', 'netapp', 'pure', 'unifi', 'vcenter', 'zerto']);
    expect(idx.byName.get('asx1nacls-02').ports).toEqual(['e4a']);
    expect(idx.byName.get('snx2gcprdr1sa01').controllers).toEqual(['CT0', 'CT1']);
  });

  it('keeps the platform order: the vCenter host wins a name a VM also carries', () => {
    seed(db);
    db.prepare("INSERT INTO vcenter_vms (vcenter_id, vm_id, name) VALUES (1, 'vm-9', 'esx01.corp.local')").run();
    const idx = hi.buildIdentityIndex(db, { fresh: true });
    expect(idx.byName.get('esx01.corp.local').kind).toBe('host');
    expect(idx.byName.get('esx01.corp.local').alsoKnownAs).toEqual(expect.arrayContaining([{ platform: 'vcenter', refKey: 'esx01.corp.local' }]));
  });

  it('tolerates a missing table, missing round 9 columns and an empty database', () => {
    expect(hi.buildIdentityIndex(db, { fresh: true }).refs.size).toBe(0);
    const db2 = new Database(':memory:');
    seed(db2, { round9: false });
    const idx = hi.buildIdentityIndex(db2, { fresh: true });
    expect(idx.refs.size).toBeGreaterThan(5);
    // no serial column: no service tag join, the Dell server stands alone
    expect(idx.byName.get('dell-esx01').platform).toBe('dell');
  });

  it('caches per handle for 60 s and rebuilds on fresh or invalidate', () => {
    seed(db);
    const a = hi.buildIdentityIndex(db, { fresh: true });
    db.prepare("INSERT INTO zerto_sites (name, zvm_ip) VALUES ('dal-zvm', '10.6.0.6')").run();
    expect(hi.buildIdentityIndex(db)).toBe(a);
    hi.invalidateIdentityIndex(db);
    expect(hi.buildIdentityIndex(db).byName.has('dal-zvm')).toBe(true);
  });
});

describe('resolveToken', () => {
  let idx;
  beforeEach(() => { seed(db); idx = hi.buildIdentityIndex(db, { fresh: true }); });

  it('resolves exact name, short name, IPv4, MAC, serial and an FQDN short form in that order', () => {
    expect(hi.resolveToken(idx, 'ESX01.corp.local').label).toBe('esx01.corp.local');
    expect(hi.resolveToken(idx, 'esx01').refKey).toBe('esx01.corp.local');           // short name of an FQDN
    expect(hi.resolveToken(idx, '10.4.0.6').refKey).toBe('snx2gcprdr1sa01');          // Pure interface address
    expect(hi.resolveToken(idx, 'C8-4B-D6-A1-6E-31').refKey).toBe('pentest1');         // MAC, dashes
    expect(hi.resolveToken(idx, 'c84b.d6a1.6e31').refKey).toBe('pentest1');            // MAC, dotted
    expect(hi.resolveToken(idx, 'c84bd6a16e31').refKey).toBe('pentest1');              // MAC, bare
    expect(hi.resolveToken(idx, 'XYZ9876').refKey).toBe('pentest1');                  // Dell service tag
    expect(hi.resolveToken(idx, 'abc1234').platforms).toEqual(['vcenter', 'dell']);    // tag of the merged ref
    expect(hi.resolveToken(idx, 'chx1-pfs-1(flm29210hwa)').platform).toBe('brocade');  // "(serial)" tail
    expect(hi.resolveToken(idx, 'asx1nacls-01.other.domain').platform).toBe('netapp'); // FQDN short form
  });

  it('returns null for ambiguous short names, short tokens and unknown names, and says why', () => {
    expect(hi.resolveToken(idx, 'esx9')).toBeNull();
    expect(hi.explainToken(idx, 'esx9').reason).toBe('ambiguous');
    expect(hi.resolveToken(idx, 'e4')).toBeNull();
    expect(hi.explainToken(idx, 'e4').reason).toBe('no-name');
    expect(hi.explainToken(idx, 'nothing-here').reason).toBe('unknown-name');
    expect(hi.resolveToken(idx, '')).toBeNull();
  });

  it('normalises MAC spellings', () => {
    expect(hi.normMac('AA-BB-CC-DD-EE-FF')).toBe('aa:bb:cc:dd:ee:ff');
    expect(hi.normMac('aabb.ccdd.eeff')).toBe('aa:bb:cc:dd:ee:ff');
    expect(hi.normMac('aa:bb:cc:dd:ee')).toBeNull();
    expect(hi.normMac('not-a-mac-address')).toBeNull();
  });

  it('feeds makeIccResolver: LM-known tokens are refused, hits carry platform and refKey', () => {
    const r = lmEndpoints.makeIccResolver(idx, new Map([['core-sw-01', 11]]));
    expect(r('asx1nacls-02')).toMatchObject({ platform: 'netapp', ref: 'asx1nacls-02' });
    expect(r('core-sw-01')).toBeNull();
    expect(r('dell-esx01')).toMatchObject({ platform: 'vcenter', ref: 'esx01.corp.local' });
  });

  it('gives serverPath an anchor for a Dell, NetApp or Brocade name vCenter does not know', () => {
    const p = lmEndpoints.resolveAnchor(db, ['asx1nacls-02'], []);
    expect(p.anchor).toMatchObject({ name: 'asx1nacls-02', kind: 'netapp' });
    expect(p.ipSet.has('10.3.1.2')).toBe(true);          // the node's LIF address joins the match set
    const q = lmEndpoints.resolveAnchor(db, [], ['10.5.0.5']);
    expect(q.anchor).toMatchObject({ name: 'chx1-pfs-1', kind: 'brocade' });
    // a merged Dell + ESX host: the Dell names join the match set of the vCenter anchor
    const h = lmEndpoints.resolveAnchor(db, ['esx01.corp.local'], []);
    expect(h.anchor.kind).toBe('host');
    expect(h.nameSet.has('dell-esx01')).toBe(true);
  });
});
