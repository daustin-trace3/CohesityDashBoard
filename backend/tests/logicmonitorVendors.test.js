/**
 * Derived platforms round 1, LogicMonitor side: vendor keys and kinds, the ownership rule, the
 * post-store DataSource pass, the connector feeds and the extracted load balancer model.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const lmApi = require('../services/logicmonitorApi');
const V = require('../services/logicmonitorVendors');
const connector = require('../connectors/logicmonitor');

beforeAll(() => { runMigrations(db, 'logicmonitor', lmMigrations); });

describe('classifyVendorKey', () => {
  it('maps every enterprise number', () => {
    for (const [ent, key] of Object.entries(V.ENTERPRISE)) {
      const r = V.classifyVendorKey({ sysoid: `1.3.6.1.4.1.${ent}.1.2.3` });
      expect(r, `enterprise ${ent}`).toEqual({ key, reason: `sysoid:${ent}` });
    }
  });
  it('accepts a leading dot and ignores non-enterprise oids', () => {
    expect(V.classifyVendorKey({ sysoid: '.1.3.6.1.4.1.3375.2.1.3.4.94' }).key).toBe('f5');
    expect(V.classifyVendorKey({ sysoid: '1.3.6.1.2.1.1' })).toEqual({ key: null, reason: null });
  });
  it('overrides Net-SNMP with the Zscaler hint', () => {
    expect(V.classifyVendorKey({ sysoid: '1.3.6.1.4.1.8072.3.2.10', sysinfo: 'ZscalerOS 6.2' })).toEqual({ key: 'zscaler', reason: 'hint:zscaler' });
    expect(V.classifyVendorKey({ sysoid: '1.3.6.1.4.1.8072.3.2.10', sysinfo: 'Linux box' })).toEqual({ key: 'netsnmp', reason: 'sysoid:8072' });
  });
  it('F5OS 12276 is f5 / f5os and the role is load-balancer, not switch', () => {
    const args = { sysoid: '1.3.6.1.4.1.12276.1.1', model: 'rSeries r5600', sysinfo: 'F5OS-A 1.5' };
    const k = V.classifyVendorKey(args);
    expect(k.key).toBe('f5');
    expect(V.classifyVendorKind({ key: k.key, ...args })).toBe('f5os');
    expect(lmApi.classifyRole({ ert: 'Switch', categories: 'TopoSwitch', vendor: 'F5', ...args })).toBe('load-balancer');
  });
  it('BIG-IP is bigip, and gtm when it carries F5_GTM_ DataSources', () => {
    expect(V.classifyVendorKind({ key: 'f5', model: 'BIG-IP Tenant' })).toBe('bigip');
    expect(V.classifyVendorKind({ key: 'f5', datasources: ['F5_GTM_WideIP-', 'F5_BigIP_System'] })).toBe('gtm');
  });
  it('PFOS and Infinistream model text is netscout even under a Cisco oid', () => {
    expect(V.classifyVendorKey({ sysoid: '1.3.6.1.4.1.9.1.1', model: 'PFS 6010 PFOS 6.1' }).key).toBe('netscout');
    expect(V.classifyVendorKey({ model: 'Infinistream 7500' }).key).toBe('netscout');
    expect(V.classifyVendorKind({ key: 'netscout', model: 'PFOS' })).toBe('pfs');
    expect(V.classifyVendorKind({ key: 'netscout', model: 'Infinistream 7500' })).toBe('infinistream');
  });
  it('Panorama M-300 is paloalto / panorama, a PA-3440 is a firewall', () => {
    expect(V.classifyVendorKey({ sysoid: '1.3.6.1.4.1.25461.2.3.64' }).key).toBe('paloalto');
    expect(V.classifyVendorKind({ key: 'paloalto', model: 'M-300' })).toBe('panorama');
    expect(V.classifyVendorKind({ key: 'paloalto', model: 'PA-3440' })).toBe('firewall');
  });
  it('records an unknown enterprise number as a reason and leaves the key null', () => {
    expect(V.classifyVendorKey({ sysoid: '1.3.6.1.4.1.21671.1' })).toEqual({ key: null, reason: 'sysoid-unknown:21671' });
  });
  it('Cisco kinds: ISE before the firewall role, nexus, voice, switch', () => {
    expect(V.classifyVendorKind({ key: 'cisco', role: 'firewall', model: 'SNS-3755-K9' })).toBe('ise');
    expect(V.classifyVendorKind({ key: 'cisco', role: 'switch', model: 'N9K-C93180YC-FX' })).toBe('nexus');
    expect(V.classifyVendorKind({ key: 'cisco', role: 'switch', model: 'VG350', datasources: ['Cisco_SIP_Connections'] })).toBe('voice');
    expect(V.classifyVendorKind({ key: 'cisco', role: 'switch', model: 'C9300-48P', datasources: ['Cisco_SIP_Connections'] })).toBe('switch');
    expect(V.classifyVendorKind({ key: 'cisco', role: 'firewall', categories: 'CiscoASA' })).toBe('firewall');
  });
});

describe('Cisco and Meraki kinds (derived platforms round 2)', () => {
  const kindOf = (args) => V.classifyVendorKind(args);
  it('Meraki kinds come from the model, then from the sysinfo banner', () => {
    expect(kindOf({ key: 'meraki', model: 'MX250' })).toBe('mx');
    expect(kindOf({ key: 'meraki', model: '', sysinfo: 'Meraki MX250 Cloud Managed Security Appliance' })).toBe('mx');
    expect(kindOf({ key: 'meraki', model: 'MS225-48LP' })).toBe('ms');
    expect(kindOf({ key: 'meraki', sysinfo: 'Meraki MR46 Cloud Managed AP' })).toBe('mr');
    expect(kindOf({ key: 'meraki', model: 'MV12W' })).toBe('mv');
    expect(kindOf({ key: 'meraki', model: 'MG21' })).toBe('mg');
    expect(kindOf({ key: 'meraki', model: '', sysinfo: 'Meraki Cloud Managed device' })).toBe('other');
    expect(kindOf({ key: 'meraki' })).toBe('other');
  });
  it('catalyst is not a kind: a Catalyst switch stays a switch', () => {
    expect(kindOf({ key: 'cisco', role: 'switch', model: 'C9300-48P', categories: 'CiscoCatalyst' })).toBe('switch');
    expect(kindOf({ key: 'cisco', role: 'switch', model: 'WS-C3850-48P' })).toBe('switch');
  });
  it('a controller by model is wireless whatever the role, and an AP is ap', () => {
    expect(kindOf({ key: 'cisco', role: 'wireless', model: 'AIR-CT5520-K9' })).toBe('wireless');
    expect(kindOf({ key: 'cisco', role: 'other', model: 'AIR-CT5520-K9' })).toBe('wireless');
    expect(kindOf({ key: 'cisco', role: 'switch', model: 'C9800-40-K9' })).toBe('wireless');
    expect(kindOf({ key: 'cisco', role: 'wireless', model: 'AIR-AP3802I-B-K9' })).toBe('ap');
    expect(kindOf({ key: 'cisco', role: 'wireless', model: 'C9120AXI-B' })).toBe('ap');
    expect(kindOf({ key: 'cisco', role: 'wireless', model: 'CW9166I-B' })).toBe('ap');
    expect(kindOf({ key: 'cisco', role: 'other', model: 'X1', categories: 'CiscoCatalystAccessPoint' })).toBe('ap');
    expect(kindOf({ key: 'cisco', role: 'switch', model: 'C9300-24T' })).toBe('switch');
  });
  it('ESA and UCS keep their category kinds', () => {
    expect(kindOf({ key: 'cisco', role: 'other', categories: 'CiscoESA' })).toBe('esa');
    expect(kindOf({ key: 'cisco', role: 'other', categories: 'CiscoUCS' })).toBe('ucs');
  });
  it('VENDOR_KINDS covers every kind the classifier can return and KIND_LABELS labels each', () => {
    expect(V.VENDOR_KINDS).toEqual({
      f5: ['bigip', 'gtm', 'f5os'],
      cisco: ['switch', 'nexus', 'router', 'firewall', 'wireless', 'ap', 'ise', 'voice', 'ucs', 'esa'],
      meraki: ['mx', 'ms', 'mr', 'mv', 'mg', 'other'],
      paloalto: ['firewall', 'panorama'],
      zscaler: ['zpa', 'nss'],
      oracle: ['sbc'],
      netscout: ['pfs', 'infinistream'],
    });
    for (const kinds of Object.values(V.VENDOR_KINDS)) for (const k of kinds) expect(V.KIND_LABELS[k], k).toBeTruthy();
    expect(V.kindLabelOf('mx')).toBe('MX');
    expect(V.kindLabelOf('nope')).toBe('nope');
  });
  it('every kind the classifier returns is in VENDOR_KINDS', () => {
    const samples = [
      { key: 'cisco', model: 'SNS-3755-K9' }, { key: 'cisco', categories: 'CiscoESA' }, { key: 'cisco', categories: 'CiscoUCS' },
      { key: 'cisco', role: 'wireless' }, { key: 'cisco', role: 'firewall' }, { key: 'cisco', role: 'router' }, { key: 'cisco', model: 'N9K-C93180' },
      { key: 'cisco', model: 'C9300' }, { key: 'cisco', model: 'CW9166I' }, { key: 'meraki', model: 'MX64' }, { key: 'meraki' },
      { key: 'paloalto', model: 'M-300' }, { key: 'paloalto', model: 'PA-440' }, { key: 'zscaler' }, { key: 'oracle' },
      { key: 'netscout', model: 'PFOS' }, { key: 'f5', model: 'BIG-IP' },
    ];
    for (const a of samples) expect(V.VENDOR_KINDS[a.key], JSON.stringify(a)).toContain(V.classifyVendorKind(a));
  });
});

describe('vendorKeyFromDatasources', () => {
  it('classifies when every hinted name agrees', () => {
    const r = V.vendorKeyFromDatasources(['HostStatus', 'F5_BigIP_System', 'f5_mcpd_service_status', 'Ping']);
    expect(r.key).toBe('f5');
    expect(r.reason).toMatch(/^datasource:/);
  });
  it('returns null when hinted names disagree', () => {
    expect(V.vendorKeyFromDatasources(['F5_BigIP_System', 'PaloAlto_FW_HA_Status']).key).toBeNull();
  });
  it('never classifies on template DataSources', () => {
    const tpl = ['Cisco_CUCM_Processes', 'Cisco_IPSLA_Statistics', 'CiscoSLA_UDPEcho-', 'HostStatus', 'Ping', 'SNMP_Network_Interfaces', 'BGP-', 'OSPF_Neighbors'];
    expect(V.vendorKeyFromDatasources(tpl)).toEqual({ key: null, reason: null });
  });
});

describe('ownership', () => {
  it('device scoped membership', () => {
    expect(V.DEVICE_SCOPED_ISSUE_TYPES.has('lb-pool-degraded')).toBe(true);
    expect(V.DEVICE_SCOPED_ISSUE_TYPES.has('device-dead')).toBe(true);
    expect(V.DEVICE_SCOPED_ISSUE_TYPES.has('interface-down')).toBe(false);
    expect(V.isDeviceScopedIssueType('interface-down')).toBe(false);
    for (const t of ['circuit-down', 'site-wan-down', 'location-latency', 'link-burst', 'latency-drift', 'loss-degrading', 'check-down', 'collector-down', 'source-unreachable', 'unmonitored-neighbor', 'cloud-circuit-down', 'interface-flapping', 'circuit-flap-pattern']) {
      expect(V.isDeviceScopedIssueType(t), t).toBe(false);
    }
    expect(V.isDeviceScopedIssueType('lb-new-future-type')).toBe(true);
  });

  const fake = { derivedPlatformFor: (k) => (k === 'f5' ? 'f5' : null) };
  beforeEach(() => {
    for (const t of ['lm_devices', 'lm_sources']) db.prepare(`DELETE FROM ${t}`).run();
    db.prepare("INSERT INTO lm_sources (id, name, company, auth_mode, encrypted_credentials) VALUES (1, 'portal1', 'acme', 'lmv1', 'x')").run();
    const ins = db.prepare('INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, vendor_key, vendor_kind, vendor_reason, role, stale) VALUES (1, ?, ?, ?, ?, ?, ?, ?, 0)');
    ins.run(10, 'snot-ltm-1', 'snot-ltm-1', 'f5', 'bigip', 'sysoid:3375', 'load-balancer');
    ins.run(11, 'phx-sw-1', 'phx-sw-1', 'cisco', 'switch', 'sysoid:9', 'switch');
  });
  it('a present derived platform owns device scoped items of its devices only', () => {
    const o = (a) => V.ownerPlatformFor(db, a, { registry: fake });
    expect(o({ lmDeviceId: 10, sourceId: 1 })).toBe('f5');
    expect(o({ lmDeviceId: 11, sourceId: 1 })).toBe('logicmonitor');
    expect(o({ issueType: 'lb-pool-degraded', target: 'snot-ltm-1 /Common/pool1' })).toBe('f5');
    expect(o({ issueType: 'device-dead', target: 'snot-ltm-1' })).toBe('f5');
    expect(o({ issueType: 'interface-utilization-high', target: 'snot-ltm-1 1.1' })).toBe('logicmonitor');
    expect(o({ issueType: 'device-dead', target: 'phx-sw-1' })).toBe('logicmonitor');
  });
  it('stays with LogicMonitor when no derived platform is registered', () => {
    expect(V.ownerPlatformFor(db, { lmDeviceId: 10, sourceId: 1 }, { registry: { derivedPlatformFor: () => null } })).toBe('logicmonitor');
    expect(V.ownerPlatformFor(db, { lmDeviceId: 10, sourceId: 1 }, { registry: {} })).toBe('logicmonitor');
  });
});

describe('post-store pass', () => {
  beforeEach(() => {
    for (const t of ['lm_device_datasources', 'lm_devices', 'lm_sources']) db.prepare(`DELETE FROM ${t}`).run();
    db.prepare("INSERT INTO lm_sources (id, name, company, auth_mode, encrypted_credentials) VALUES (1, 'portal1', 'acme', 'lmv1', 'x')").run();
    const ins = db.prepare('INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, vendor_key, vendor_kind, vendor_reason, role, stale) VALUES (1, ?, ?, ?, ?, ?, ?, ?, 0)');
    ins.run(1, 'a', 'a', null, null, null, 'other'); // unkeyed, F5 DataSources
    ins.run(2, 'b', 'b', 'f5', 'bigip', 'sysoid:3375', 'load-balancer'); // keyed, GTM DataSources
    ins.run(3, 'c', 'c', 'netsnmp', null, 'sysoid:8072', 'server'); // weak key, ZPA DataSource
    ins.run(4, 'd', 'd', null, null, null, 'other'); // template DataSources only
    const ds = db.prepare('INSERT INTO lm_device_datasources (source_id, lm_device_id, hds_id, datasource_name) VALUES (1, ?, ?, ?)');
    let h = 1;
    for (const [dev, name] of [[1, 'F5_BigIP_System'], [2, 'F5_GTM_WideIP-'], [3, 'ntm_zpa_app_connector'], [4, 'Cisco_CUCM_Processes'], [4, 'Ping']]) ds.run(dev, h++, name);
  });
  it('keys, re-kinds, upgrades the weak key, and a second run writes nothing', () => {
    const first = V.applyDatasourceVendors(db, 1);
    expect(first.changed).toBe(3);
    const row = (id) => db.prepare('SELECT vendor_key k, vendor_kind kind, vendor_reason r FROM lm_devices WHERE lm_device_id = ?').get(id);
    expect(row(1)).toMatchObject({ k: 'f5', kind: 'bigip' });
    expect(row(1).r).toMatch(/^datasource:/);
    expect(row(2)).toMatchObject({ k: 'f5', kind: 'gtm', r: 'sysoid:3375' });
    expect(row(3)).toMatchObject({ k: 'zscaler', kind: 'zpa' });
    expect(row(4)).toMatchObject({ k: null });
    expect(V.applyDatasourceVendors(db, 1).changed).toBe(0);
  });
});

describe('normalizeDevice carries the vendor columns', () => {
  it('an F5 BIG-IP device', () => {
    const d = lmApi.normalizeDevice({
      id: 5, name: 'ltm1', displayName: 'ltm1', deviceType: 0,
      systemProperties: [{ name: 'system.sysoid', value: '1.3.6.1.4.1.3375.2.1.3.4.94' }, { name: 'system.sysinfo', value: 'BIG-IP 17.1.1 Build 0.0.4' }, { name: 'system.categories', value: 'F5' }],
    });
    expect(d).toMatchObject({ vendor: 'F5', role: 'load-balancer', vendorKey: 'f5', vendorKind: 'bigip', vendorReason: 'sysoid:3375' });
  });
});

describe('connector feeds', () => {
  const feeds = new Map();
  beforeAll(() => {
    // The registerFeed(connectorId, name, fn) form.
    connector.register({ registerFeed: (cid, name, fn) => { expect(cid).toBe('logicmonitor'); feeds.set(name, fn); } });
  });
  beforeEach(() => {
    for (const t of ['lm_issue_history', 'lm_alerts', 'lm_device_datasources', 'lm_devices', 'lm_sources']) db.prepare(`DELETE FROM ${t}`).run();
    db.prepare("INSERT INTO lm_sources (id, name, company, auth_mode, encrypted_credentials, last_poll_status) VALUES (1, 'portal1', 'acme', 'lmv1', 'x', 'success')").run();
    const ins = db.prepare('INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, vendor, vendor_key, vendor_kind, vendor_reason, role, host_status, is_network, stale) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)');
    ins.run(1, 'ltm-a', 'ltm-a', 'F5', 'f5', 'bigip', 'sysoid:3375', 'load-balancer', 'normal', 0);
    ins.run(2, 'ltm-b', 'ltm-b', 'F5', 'f5', 'gtm', 'sysoid:3375', 'load-balancer', 'normal', 0);
    ins.run(3, 'old-f5', 'old-f5', 'F5', 'f5', 'bigip', 'sysoid:3375', 'load-balancer', 'normal', 1);
    ins.run(4, 'sw-1', 'sw-1', 'Cisco', 'cisco', 'switch', 'sysoid:9', 'switch', 'normal', 0);
    ins.run(5, 'mystery', 'mystery', null, null, null, 'sysoid-unknown:21671', 'other', 'normal', 0);
    db.prepare("INSERT INTO lm_device_datasources (source_id, lm_device_id, hds_id, datasource_name) VALUES (1, 1, 1, 'F5_BigIP_System'), (1, 1, 2, 'NotInCatalogAtAll')").run();
    db.prepare("INSERT INTO lm_issue_history (issue_key, source, severity, type, target, message, status, first_seen, last_seen) VALUES ('k1', 'portal1', 'critical', 'lb-pool-degraded', 'ltm-a /Common/p1', 'pool', 'open', datetime('now'), datetime('now')), ('k2', 'portal1', 'warning', 'interface-utilization-high', 'ltm-a 1.1', 'if', 'open', datetime('now'), datetime('now')), ('k3', 'portal1', 'critical', 'device-dead', 'sw-1', 'dead', 'open', datetime('now'), datetime('now'))").run();
  });
  const q = (name, params) => feeds.get(name)(db, params || {});

  it('registers every feed name', () => {
    for (const n of ['devices', 'device', 'alerts', 'issues', 'issueHistory', 'configChanges', 'metrics', 'datasources', 'health', 'loadBalancers', 'loadBalancer', 'firewalls', 'firewall', 'wirelessOverview', 'wirelessControllers', 'wirelessController', 'wirelessAps', 'wirelessAp', 'wirelessRf', 'wirelessSsids', 'voice', 'voiceDevice', 'ise', 'iseNode', 'vendorCensus', 'sources', 'presence']) expect(feeds.has(n), n).toBe(true);
  });
  it('also registers through the per-connector facade form', () => {
    const got = [];
    connector.register({ registerFeed: (name) => got.push(name) });
    expect(got.length).toBe(feeds.size);
  });
  it('devices by vendorKey and kind skips stale rows', () => {
    const f5 = q('devices', { vendorKey: 'f5' });
    expect(f5.map((d) => d.id).sort()).toEqual([1, 2]);
    expect(f5[0]).toMatchObject({ vendorKey: 'f5', sourceName: 'portal1' });
    expect(q('devices', { vendorKey: 'f5', vendorKind: 'gtm' }).map((d) => d.id)).toEqual([2]);
    expect(q('device', { deviceId: 1, sourceId: 1 })).toMatchObject({ displayName: 'ltm-a', vendorKind: 'bigip' });
    expect(q('device', { deviceId: 999 })).toBeNull();
  });
  it('presence counts non-stale devices of the key', () => {
    expect(q('presence', { vendorKey: 'f5' })).toBe(2);
    expect(q('presence', { vendorKey: 'paloalto' })).toBe(0);
  });
  it('issues keep device scoped rows of the vendor only', () => {
    const r = q('issues', { vendorKey: 'f5' });
    expect(r.issues.map((i) => i.type)).toEqual(['lb-pool-degraded']);
    expect(r.asOf).toBeTruthy();
    expect(q('issueHistory', { vendorKey: 'f5' }).map((i) => i.type)).toEqual(['lb-pool-degraded']);
    expect(q('issueHistory', {}).length).toBe(3);
    expect(q('issueHistory', { severity: 'warning' }).map((i) => i.type)).toEqual(['interface-utilization-high']);
    expect(q('issueHistory', { type: 'device-dead' })[0]).toMatchObject({ issueKey: 'k3', firstSeen: expect.any(String) });
  });
  it('configChanges returns [] without the table and filters by vendor device', () => {
    db.prepare('DROP TABLE IF EXISTS config_changes').run();
    expect(q('configChanges', { vendorKey: 'f5' })).toEqual([]);
    db.prepare('CREATE TABLE config_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT, scope TEXT, system TEXT, item TEXT, change_type TEXT, old_value TEXT, new_value TEXT, detected_at TEXT)').run();
    const ins = db.prepare('INSERT INTO config_changes (platform, scope, system, item, change_type, detected_at) VALUES (?, ?, ?, ?, ?, ?)');
    const now = new Date().toISOString();
    ins.run('logicmonitor', 'x', 'portal1', 'ltm-a', 'changed', now);
    ins.run('logicmonitor', 'x', 'portal1', 'ltm-b mgmt0', 'changed', now);
    ins.run('logicmonitor', 'x', 'portal1', 'sw-1 Gi1', 'changed', now);
    ins.run('netapp', 'x', 'other', 'ltm-a', 'changed', now);
    expect(q('configChanges', { vendorKey: 'f5', days: 7 }).map((r) => r.item).sort()).toEqual(['ltm-a', 'ltm-b mgmt0']);
    db.prepare('DROP TABLE config_changes').run();
  });
  it('vendorCensus has an f5 row and an unknown enterprise row', () => {
    const rows = q('vendorCensus');
    const f5 = rows.find((r) => r.vendorKey === 'f5');
    expect(f5).toMatchObject({ label: 'F5', devices: 2, kinds: { bigip: 1, gtm: 1 }, dsNames: 2 });
    expect(f5.kindLabels).toEqual({ bigip: 'BIG-IP', gtm: 'GTM' });
    expect(['f5', 'logicmonitor']).toContain(f5.platform);
    expect(f5.dsUnmatched).toBeGreaterThanOrEqual(1);
    expect(f5.dsMatched + f5.dsUnmatched).toBe(f5.dsNames);
    const unk = rows.find((r) => r.reason === 'sysoid-unknown:21671');
    expect(unk).toMatchObject({ vendorKey: null, devices: 1 });
  });
  it('sources and health', () => {
    expect(q('sources')[0]).toMatchObject({ name: 'portal1', devices: 4 });
    expect(q('health', { deviceId: 1, sourceId: 1 })).toMatchObject({ hostStatus: 'normal', deadSince: null, collectorDown: false, sdt: false });
  });
  it('load balancer feed matches the LogicMonitor rule for the same devices', () => {
    const viaKey = q('loadBalancers', { vendorKey: 'f5' }).map((r) => r.deviceId).sort();
    const viaRole = q('loadBalancers', {}).map((r) => r.deviceId).sort();
    expect(viaKey).toEqual([1, 2]);
    expect(viaRole).toEqual([1, 2]);
    expect(q('loadBalancer', { deviceId: 1, vendorKey: 'f5' })).toMatchObject({ device: { id: 1 }, summary: { deviceId: 1 } });
    expect(q('loadBalancer', { deviceId: 4, vendorKey: 'f5' })).toBeNull();
  });
});
