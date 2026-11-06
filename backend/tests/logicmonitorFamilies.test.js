/**
 * Derived platforms round 2, LogicMonitor side: the firewall, wireless, voice and ISE family models extracted
 * from routes/logicmonitor.js into services, their vendorKeys / excludeOwned scope, and the connector feeds
 * that hand them to the Cisco platform. The existing LM route tests pin that the routes' shapes did not move.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const connector = require('../connectors/logicmonitor');
const FW = require('../services/logicmonitorFirewalls');
const WL = require('../services/logicmonitorWireless');
const VO = require('../services/logicmonitorVoice');
const ISE = require('../services/logicmonitorIse');
const SH = require('../services/logicmonitorFamilyShared');

beforeAll(() => { runMigrations(db, 'logicmonitor', lmMigrations); });

const TABLES = ['lm_ds_metrics_history', 'lm_ds_metrics', 'lm_ds_instances', 'lm_issue_history', 'lm_alerts', 'lm_device_datasources',
  'lm_device_groups', 'lm_collectors', 'lm_devices', 'lm_sources'];
function wipe() { for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run(); }
function ins(table, row) {
  const cols = Object.keys(row);
  return db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c])).lastInsertRowid;
}
const nowSec = () => Math.floor(Date.now() / 1000);

let sid;
const hdsOf = new Map();
let seq = 100;

function dev(id, name, over = {}) {
  ins('lm_devices', {
    source_id: sid, lm_device_id: id, name, display_name: name, device_type: 0, host_status: 'normal', alert_status: 'none',
    sdt_status: 'none-none-none', vendor: over.vendor || 'Cisco', role: over.role || 'switch', is_network: 1, model: over.model || null,
    site_key: over.site || 'phoenix', site_name: over.siteName || 'Phoenix', ips_json: '[]', stale: 0,
    vendor_key: over.key === undefined ? 'cisco' : over.key, vendor_kind: over.kind || null,
  });
}
function met(devId, ds, family, inst, metric, value, name) {
  const hk = `${devId}|${ds}`;
  if (!hdsOf.has(hk)) { seq += 1; hdsOf.set(hk, seq); }
  const hds = hdsOf.get(hk);
  db.prepare(`INSERT OR IGNORE INTO lm_ds_instances (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, instance_name, stale)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)`).run(sid, devId, hds, ds, family, inst, name || inst);
  db.prepare(`INSERT OR REPLACE INTO lm_ds_metrics (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, metric, datapoint, value, sampled_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sid, devId, hds, ds, family, inst, metric, metric, value, nowSec() - 120);
  if (!db.prepare('SELECT 1 FROM lm_device_datasources WHERE source_id = ? AND lm_device_id = ? AND hds_id = ?').get(sid, devId, hds)) {
    ins('lm_device_datasources', { source_id: sid, lm_device_id: devId, hds_id: hds, datasource_id: hds, datasource_name: ds, datasource_display_name: ds, instance_count: 1, is_interface: 0, is_neighbor: 0 });
  }
  return hds;
}

// A registry stand-in: cisco and meraki are owned by a present 'cisco' platform, nothing else.
const fakeRegistry = (owned = ['cisco', 'meraki']) => ({ derivedPlatformFor: (k) => (owned.includes(k) ? 'cisco' : null) });

beforeEach(() => {
  wipe();
  hdsOf.clear();
  sid = ins('lm_sources', { name: 'portal1', company: 'acme', auth_mode: 'lmv1', encrypted_credentials: 'x', features_json: '{}' });
  // Firewalls: Palo Alto, Cisco ASA, Meraki MX.
  dev(1, 'phx-fw-01', { vendor: 'Palo Alto', role: 'firewall', model: 'PA-5220', key: 'paloalto', kind: 'firewall' });
  dev(2, 'den-asa-01', { vendor: 'Cisco', role: 'firewall', model: 'ASA5525', key: 'cisco', kind: 'firewall', site: 'denver', siteName: 'Denver' });
  dev(3, 'den-mx-01', { vendor: 'Meraki', role: 'firewall', model: 'MX250', key: 'meraki', kind: 'mx', site: 'denver', siteName: 'Denver' });
  met(1, 'PaloAlto_FW_HA_Status', 'firewall', 'ha', 'ha_enabled', 1);
  met(2, 'CiscoASA', 'firewall', 'asa', 'asa_cpu_pct', 22);
  met(3, 'Meraki_MX_Uplink', 'firewall', 'u', 'sessions_active', 10);
  // Wireless: a Cisco WLC with three APs and an SSID, a Meraki-keyed controller-less device is not a WLC.
  dev(11, 'irv-wlc-1', { role: 'wireless', model: 'C9800-40-K9', key: 'cisco', kind: 'wireless' });
  dev(12, 'oth-wlc-1', { role: 'wireless', model: 'AIR-CT3504-K9', key: 'netsnmp', site: 'oth', siteName: 'Other' });
  for (const [k, st] of [['AP-A', 1], ['AP-B', 1], ['AP-C', 2]]) met(11, 'Cisco_Wireless_AP', 'wireless', k, 'ap_oper', st);
  met(11, 'Cisco_Wireless_AccessPointRadio', 'wireless', 'AP-A:0', 'radio_oper', 2);
  met(11, 'Cisco_Wireless_AccessPointRadio', 'wireless', 'AP-A:0', 'radio_admin', 1);
  met(11, 'Cisco_Wireless_AccessPointRadio', 'wireless', 'AP-A:0', 'radio_util_pct', 30);
  met(11, 'Cisco_Wireless_AccessPointRadio', 'wireless', 'AP-A:0', 'radio_clients', 4);
  met(11, 'Cisco_Wireless_ESS', 'wireless', 'WLAN: 1', 'ess_clients', 30, 'Corp');
  met(11, 'Cisco_Wireless_ESS', 'wireless', 'WLAN: 1', 'ess_admin', 1, 'Corp');
  met(12, 'Cisco_Wireless_AP', 'wireless', 'OT-1', 'ap_oper', 1);
  // ISE and voice.
  dev(21, 'phx-ipsn-1', { role: 'firewall', model: 'SNS-3755-K9', key: 'cisco', kind: 'ise' });
  met(21, 'Cisco_ISE_ServerSessions', 'security', 'sessions', 'sessions', 1500);
  met(21, 'ntm_ise_application_and_certificate_status', 'security', 'admin-cert', 'cert_days', 12);
  dev(31, 'phx-sbc-01', { vendor: 'Oracle', role: 'server', model: 'Acme Packet 4600', key: 'oracle', kind: 'sbc' });
  met(31, 'ntm_sbc_cpu_utilization', 'voice', 'cpu', 'sbc_cpu_pct', 25);
  dev(32, 'phx-cube-01', { vendor: 'Cisco', role: 'router', model: 'ISR4451', key: 'cisco', kind: 'voice' });
  met(32, 'Cisco_SIP_Connections', 'voice', 'sip', 'sip_active_tcp', 12);
  require('../services/logicmonitorIssues').reconcileIssueHistory();
});
afterEach(() => { wipe(); });

const names = (rows, k = 'deviceName') => rows.map((r) => r[k]).sort();

describe('firewall model', () => {
  it('lists every vendor with an open scope', () => {
    expect(names(FW.listFirewalls(db))).toEqual(['den-asa-01', 'den-mx-01', 'phx-fw-01']);
  });
  it('vendorKeys cisco and meraki return the ASA and MX rows and not the Palo Alto one', () => {
    const rows = FW.listFirewalls(db, { vendorKeys: ['cisco', 'meraki'], excludeOwned: false });
    expect(names(rows)).toEqual(['den-asa-01', 'den-mx-01']);
    expect(rows[0]).toHaveProperty('state');
    expect(rows[0]).toHaveProperty('haText');
  });
  it('an empty vendorKeys array matches nothing; null matches every vendor', () => {
    expect(FW.listFirewalls(db, { vendorKeys: [] })).toEqual([]);
    expect(FW.listFirewalls(db, { vendorKeys: null })).toHaveLength(3);
  });
  it('excludeOwned drops the devices of a present derived platform and keeps the rest', () => {
    const rows = FW.listFirewalls(db, { vendorKeys: null, excludeOwned: true, registry: fakeRegistry() });
    expect(names(rows)).toEqual(['phx-fw-01']);
    // No platform present: nothing is excluded.
    expect(FW.listFirewalls(db, { excludeOwned: true, registry: fakeRegistry([]) })).toHaveLength(3);
    // Only cisco present: the Meraki row stays.
    expect(names(FW.listFirewalls(db, { excludeOwned: true, registry: fakeRegistry(['cisco']) }))).toEqual(['den-mx-01', 'phx-fw-01']);
  });
  it('filters by q, siteKey and sourceId inside the scope', () => {
    expect(names(FW.listFirewalls(db, { q: 'asa' }))).toEqual(['den-asa-01']);
    expect(names(FW.listFirewalls(db, { siteKey: 'denver', vendorKeys: ['meraki'] }))).toEqual(['den-mx-01']);
    expect(FW.listFirewalls(db, { sourceId: sid + 99 })).toEqual([]);
  });
  it('detail answers inside the scope and null outside it', () => {
    expect(FW.firewallDetail(db, { deviceId: 2, vendorKeys: ['cisco'] })).toMatchObject({ device: { id: 2 }, summary: { deviceId: 2 } });
    expect(FW.firewallDetail(db, { deviceId: 1, vendorKeys: ['cisco'] })).toBeNull();
    expect(FW.firewallDetail(db, { deviceId: 2, excludeOwned: true, registry: fakeRegistry() })).toBeNull();
    expect(FW.firewallDetail(db, { deviceId: 2 })).not.toBeNull();
    expect(FW.firewallDetail(db, { deviceId: 999 })).toBeNull();
  });
});

describe('wireless model', () => {
  it('controller list and detail', () => {
    const rows = WL.listControllers(db, {});
    expect(names(rows)).toEqual(['irv-wlc-1', 'oth-wlc-1']);
    const irv = rows.find((r) => r.deviceName === 'irv-wlc-1');
    expect(irv).toMatchObject({ platform: 'Catalyst 9800', apsTotal: 3, apsDown: 1, ssids: 1 });
    const d = WL.controllerDetail(db, { deviceId: 11 });
    expect(d).toMatchObject({ device: { id: 11 }, summary: { deviceName: 'irv-wlc-1' } });
    expect(d.aps).toHaveLength(3);
    expect(d.ssids.map((s) => s.ssid)).toEqual(['Corp']);
  });
  it('vendorKeys cisco keeps the Cisco controller only; excludeOwned drops it', () => {
    expect(names(WL.listControllers(db, { vendorKeys: ['cisco'] }))).toEqual(['irv-wlc-1']);
    expect(names(WL.listControllers(db, { vendorKeys: ['cisco', 'meraki'], excludeOwned: false }))).toEqual(['irv-wlc-1']);
    expect(names(WL.listControllers(db, { excludeOwned: true, registry: fakeRegistry() }))).toEqual(['oth-wlc-1']);
    expect(WL.controllerDetail(db, { deviceId: 11, excludeOwned: true, registry: fakeRegistry() })).toBeNull();
    expect(WL.controllerDetail(db, { deviceId: 12, vendorKeys: ['cisco'] })).toBeNull();
  });
  it('APs, AP detail, overview, rf and ssids follow the scope', () => {
    expect(WL.listAps(db, { vendorKeys: ['cisco'] }).map((a) => a.apKey).sort()).toEqual(['AP-A', 'AP-B', 'AP-C']);
    expect(WL.listAps(db, { excludeOwned: true, registry: fakeRegistry() }).map((a) => a.apKey)).toEqual(['OT-1']);
    const ap = WL.apDetail(db, { controllerId: 11, apKey: 'AP-A', vendorKeys: ['cisco'] });
    expect(ap.ap).toMatchObject({ apKey: 'AP-A', controller: 'irv-wlc-1' });
    expect(ap).toHaveProperty('radios');
    expect(WL.apDetail(db, { controllerId: 11, apKey: 'NOPE', vendorKeys: ['cisco'] })).toEqual({ missing: 'ap' });
    expect(WL.apDetail(db, { controllerId: 999, apKey: 'AP-A' })).toEqual({ missing: 'controller' });
    const ov = WL.wirelessOverview(db, { vendorKeys: ['cisco'] });
    expect(ov.totals).toMatchObject({ controllers: 1, aps: 3, apsDown: 1 });
    expect(WL.rfTable(db, { vendorKeys: ['cisco'] })).toHaveProperty('bands');
    expect(WL.ssidTable(db, { vendorKeys: ['cisco'] }).summary.map((s) => s.ssid)).toEqual(['Corp']);
    expect(WL.listRadios(db, { vendorKeys: ['cisco'] })).toHaveLength(1);
  });
  it('the memoized model sees new data after a write and does not leak between scopes', () => {
    expect(WL.listControllers(db, { vendorKeys: ['cisco'] })).toHaveLength(1);
    expect(WL.listControllers(db, { vendorKeys: ['netsnmp'] })).toHaveLength(1);
    dev(13, 'new-wlc', { role: 'wireless', model: 'AIR-CT5520-K9', key: 'cisco', kind: 'wireless' });
    expect(WL.listControllers(db, { vendorKeys: ['cisco'] })).toHaveLength(2);
    // Returned rows are the cached objects: a second call is the same content.
    expect(names(WL.listControllers(db, { vendorKeys: ['cisco'] }))).toEqual(['irv-wlc-1', 'new-wlc']);
  });
});

describe('voice and ISE models', () => {
  it('voice lists SBC and CUBE rows and scopes by vendor key', () => {
    expect(names(VO.listVoice(db, {}))).toEqual(['phx-cube-01', 'phx-sbc-01']);
    expect(names(VO.listVoice(db, { vendorKeys: ['cisco'] }))).toEqual(['phx-cube-01']);
    expect(names(VO.listVoice(db, { excludeOwned: true, registry: fakeRegistry() }))).toEqual(['phx-sbc-01']);
    const sbc = VO.listVoice(db, { vendorKeys: ['oracle'] })[0];
    expect(sbc).toMatchObject({ kind: 'sbc', cpuPct: 25 });
    expect(VO.voiceDetail(db, { deviceId: 31, vendorKeys: ['oracle'] })).toMatchObject({ device: { id: 31 }, summary: { kind: 'sbc' } });
    expect(VO.voiceDetail(db, { deviceId: 31, vendorKeys: ['cisco'] })).toBeNull();
    expect(VO.listVoice(db, { kind: 'sbc' }).map((r) => r.deviceName)).toEqual(['phx-sbc-01']);
  });
  it('ISE lists nodes, scopes by vendor key and returns the 360', () => {
    expect(names(ISE.listIse(db, {}))).toEqual(['phx-ipsn-1']);
    expect(names(ISE.listIse(db, { vendorKeys: ['cisco', 'meraki'] }))).toEqual(['phx-ipsn-1']);
    expect(ISE.listIse(db, { vendorKeys: ['f5'] })).toEqual([]);
    expect(ISE.listIse(db, { excludeOwned: true, registry: fakeRegistry() })).toEqual([]);
    const d = ISE.iseDetail(db, { deviceId: 21, vendorKeys: ['cisco'] });
    expect(d).toMatchObject({ device: { id: 21 }, summary: { sessions: 1500 } });
    expect(d.certificates[0]).toMatchObject({ daysLeft: 12 });
    expect(ISE.iseDetail(db, { deviceId: 21, excludeOwned: true, registry: fakeRegistry() })).toBeNull();
  });
});

describe('family scope helpers', () => {
  it('ownedVendorKeys uses the registry presence', () => {
    expect(SH.ownedVendorKeys(db, { registry: fakeRegistry() })).toEqual(['cisco', 'meraki']);
    expect(SH.ownedVendorKeys(db, { registry: fakeRegistry([]) })).toEqual([]);
    expect(SH.ownedVendorKeys(db, { registry: { derivedPlatformFor: () => { throw new Error('boom'); } } })).toEqual([]);
  });
  it('a missing registry owns nothing', () => {
    expect(SH.ownedVendorKeys(db, { registry: {} })).toEqual([]);
  });
});

describe('connector family feeds', () => {
  const feeds = new Map();
  beforeAll(() => { connector.register({ registerFeed: (name, fn) => feeds.set(name, fn) }); });
  const q = (name, params) => feeds.get(name)(db, params || {});

  it('registers every family feed name', () => {
    for (const n of ['firewalls', 'firewall', 'wirelessOverview', 'wirelessControllers', 'wirelessController', 'wirelessAps', 'wirelessAp',
      'wirelessRf', 'wirelessSsids', 'voice', 'voiceDevice', 'ise', 'iseNode']) expect(feeds.has(n), n).toBe(true);
  });
  it('firewalls honours vendorKeys and never excludes owned devices', () => {
    expect(names(q('firewalls', { vendorKeys: ['cisco', 'meraki'] }))).toEqual(['den-asa-01', 'den-mx-01']);
    expect(names(q('firewalls', {}))).toEqual(['den-asa-01', 'den-mx-01', 'phx-fw-01']);
    expect(q('firewall', { deviceId: 2, vendorKeys: ['cisco'] })).toMatchObject({ summary: { deviceId: 2 } });
    expect(q('firewall', { deviceId: 1, vendorKeys: ['cisco'] })).toBeNull();
  });
  it('a request cannot smuggle a registry or an exclusion through the feed params', () => {
    const rows = q('firewalls', { excludeOwned: true, registry: fakeRegistry(), vendorKeys: ['cisco'] });
    expect(names(rows)).toEqual(['den-asa-01']);
  });
  it('wireless feeds', () => {
    expect(names(q('wirelessControllers', { vendorKeys: ['cisco'] }))).toEqual(['irv-wlc-1']);
    expect(q('wirelessController', { deviceId: 11, vendorKeys: ['cisco'] })).toMatchObject({ summary: { deviceName: 'irv-wlc-1' } });
    expect(q('wirelessAps', { vendorKeys: ['cisco'] })).toHaveLength(3);
    expect(q('wirelessAp', { controllerId: 11, apKey: 'AP-A', vendorKeys: ['cisco'] })).toHaveProperty('ap');
    expect(q('wirelessAp', { controllerId: 11, apKey: 'NOPE', vendorKeys: ['cisco'] })).toBeNull();
    expect(q('wirelessOverview', { vendorKeys: ['cisco'] }).totals.controllers).toBe(1);
    expect(q('wirelessRf', { vendorKeys: ['cisco'] })).toHaveProperty('bands');
    expect(q('wirelessSsids', { vendorKeys: ['cisco'] })).toHaveProperty('summary');
  });
  it('voice and ISE feeds', () => {
    expect(names(q('voice', { vendorKeys: ['cisco'] }))).toEqual(['phx-cube-01']);
    expect(q('voiceDevice', { deviceId: 32, vendorKeys: ['cisco'] })).toMatchObject({ summary: { kind: 'cube' } });
    expect(names(q('ise', { vendorKeys: ['cisco'] }))).toEqual(['phx-ipsn-1']);
    expect(q('iseNode', { deviceId: 21, vendorKeys: ['cisco'] })).toMatchObject({ device: { id: 21 } });
    expect(q('iseNode', { deviceId: 21, vendorKeys: ['f5'] })).toBeNull();
  });
  it('vendorCensus carries kindLabels next to kinds', () => {
    const cisco = q('vendorCensus').find((r) => r.vendorKey === 'cisco');
    expect(cisco.kinds).toMatchObject({ firewall: 1, wireless: 1, ise: 1, voice: 1 });
    expect(cisco.kindLabels).toMatchObject({ firewall: 'Firewall', wireless: 'Wireless controller', ise: 'ISE', voice: 'Voice' });
    const meraki = q('vendorCensus').find((r) => r.vendorKey === 'meraki');
    expect(meraki.kindLabels).toEqual({ mx: 'MX' });
  });
});

describe('LogicMonitor routes: one home per device', () => {
  let app;
  const API = '/api/logicmonitor';
  beforeAll(() => {
    const express = require('express');
    app = express();
    app.use(express.json());
    app.use(API, require('../routes/logicmonitor'));
    app.use(require('../middleware/errorHandler'));
  });
  afterEach(() => { vi.restoreAllMocks(); });
  const own = (keys) => vi.spyOn(require('../core/registry'), 'derivedPlatformFor').mockImplementation((k) => (keys.includes(k) ? 'cisco' : null));

  it('lists every vendor while no derived platform is present', async () => {
    own([]);
    const res = await request(app).get(`${API}/firewalls`);
    expect(names(res.body)).toEqual(['den-asa-01', 'den-mx-01', 'phx-fw-01']);
    expect(names((await request(app).get(`${API}/wireless/controllers`)).body)).toEqual(['irv-wlc-1', 'oth-wlc-1']);
  });
  it('drops the Cisco and Meraki devices from the family pages once Cisco is present', async () => {
    own(['cisco', 'meraki']);
    expect(names((await request(app).get(`${API}/firewalls`)).body)).toEqual(['phx-fw-01']);
    expect((await request(app).get(`${API}/firewalls/2`)).status).toBe(404);
    expect((await request(app).get(`${API}/firewalls/1`)).status).toBe(200);
    expect(names((await request(app).get(`${API}/wireless/controllers`)).body)).toEqual(['oth-wlc-1']);
    expect((await request(app).get(`${API}/wireless/controllers/11`)).status).toBe(404);
    expect((await request(app).get(`${API}/wireless/ap?controllerId=11&ap=AP-A`)).status).toBe(404);
    expect((await request(app).get(`${API}/ise`)).body).toEqual([]);
    expect((await request(app).get(`${API}/ise/21`)).status).toBe(404);
    expect(names((await request(app).get(`${API}/voice`)).body)).toEqual(['phx-sbc-01']);
  });
  it('the Devices list still shows every device', async () => {
    own(['cisco', 'meraki']);
    const res = await request(app).get(`${API}/devices?limit=100`);
    expect(res.status).toBe(200);
    const items = res.body.items || res.body;
    expect(items.length).toBe(8);
  });
});
