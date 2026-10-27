/**
 * LogicMonitor backend core (WP1): migrations, the LMv1 signer and request
 * plumbing, pagination with negative totals, filter encoding, the
 * classification table, alert condition keys and the alert upsert /
 * not_reported close, interface column mapping from a fake data response,
 * check column learning, baselines and anomaly rules with hand-computed
 * numbers, the topology description parser and the issue rules. Rows are
 * seeded straight into the per-file test DB through the migration.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const crypto = require('crypto');

const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const { encrypt } = require('../services/encryption');
const lmApi = require('../services/logicmonitorApi');
const lmChecks = require('../services/logicmonitorChecks');
const lmIssues = require('../services/logicmonitorIssues');
const lmPoller = require('../services/logicmonitorPoller');

const TABLES = [
  'lm_sources', 'lm_devices', 'lm_device_groups', 'lm_device_datasources', 'lm_interfaces',
  'lm_interface_history', 'lm_interface_daily', 'lm_alerts', 'lm_collectors', 'lm_sdts', 'lm_checks',
  'lm_check_locations', 'lm_check_history', 'lm_check_baseline', 'lm_check_daily', 'lm_topology_links',
  'lm_admins', 'lm_roles', 'lm_issue_history', 'lm_metrics_history', 'lm_ai_reports',
  'lm_sites', 'lm_interface_baseline', 'lm_webhook_events', 'lm_blame_history',
  'lm_ds_instances', 'lm_ds_metrics', 'lm_ds_metrics_history',
  'lm_latency_episodes', 'lm_check_reference', 'lm_unmonitored_neighbors', 'lm_ds_values', 'lm_ds_datapoints', 'lm_ds_daily', 'lm_device_daily',
];

beforeAll(() => {
  runMigrations(db, 'logicmonitor', lmMigrations);
});

const wipe = () => {
  for (const t of [...TABLES].reverse()) db.prepare(`DELETE FROM ${t}`).run();
};

function insertSource(overrides = {}) {
  return db.prepare(`
    INSERT INTO lm_sources (name, company, auth_mode, encrypted_credentials, last_poll_status, last_poll_error, features_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.name ?? 'portal1',
    overrides.company ?? 'acme',
    overrides.auth_mode ?? 'lmv1',
    encrypt(JSON.stringify({ accessId: 'AID', accessKey: 'AKEY' })),
    overrides.last_poll_status ?? 'success',
    overrides.last_poll_error ?? null,
    overrides.features_json ?? null,
  ).lastInsertRowid;
}

function insertDevice(sourceId, o = {}) {
  db.prepare(`
    INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, device_type, host_status, sdt_status,
      collector_id, is_network, role, vendor, deleted_time_ms, dead_since, ips_json, eri_json, first_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
  `).run(sourceId, o.id, o.name ?? `dev${o.id}`, o.display ?? `dev${o.id}`, o.deviceType ?? 0, o.host ?? 'normal',
    o.sdt ?? 'none-none-none', o.collector ?? null, o.network ?? 1, o.role ?? 'switch', o.vendor ?? 'Cisco',
    o.deletedMs ?? null, o.deadSince ?? null, JSON.stringify(o.ips || []), JSON.stringify(o.eri || { mac: [], ip: [], fqdn: [] }),
    o.firstSeen ?? null);
}

describe('migrations/logicmonitor.js', () => {
  it('creates all 37 lm_* tables and the four dataset views', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'lm_%'").all().map((r) => r.name);
    for (const t of TABLES) expect(tables, `missing ${t}`).toContain(t);
    expect(tables.length).toBe(37);
    const views = db.prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name LIKE 'logicmonitor_%'").all().map((r) => r.name).sort();
    expect(views).toEqual(['logicmonitor_alerts', 'logicmonitor_checks', 'logicmonitor_devices', 'logicmonitor_interfaces']);
  });

  it('the manifest loads and passes registry shape rules', () => {
    const manifest = require('../platforms/logicmonitor');
    expect(manifest.id).toBe('logicmonitor');
    expect(manifest.apiVersion).toBe(1);
    for (const ds of manifest.datasets) {
      expect(ds.id.startsWith('logicmonitor.')).toBe(true);
      expect(ds.table.startsWith('logicmonitor_')).toBe(true);
    }
    const datasetCatalog = require('../services/datasetCatalog');
    expect(() => datasetCatalog.registerDatasets('logicmonitor', manifest.datasets)).not.toThrow();
  });
});

describe('logicmonitorApi: LMv1 signing and request plumbing', () => {
  afterEach(() => { lmApi._setTransport(null); lmApi._setSleep(null); });

  it('signs METHOD + epoch + body + resourcePath, hex then base64', () => {
    const epoch = 1760400000000;
    const toSign = `GET${epoch}/device/devices`;
    const hex = crypto.createHmac('sha256', 'secretKey').update(toSign).digest('hex');
    const expected = `LMv1 myId:${Buffer.from(hex, 'utf8').toString('base64')}:${epoch}`;
    expect(lmApi.signLmv1('myId', 'secretKey', 'get', '/device/devices', '', epoch)).toBe(expected);
    // Base64 of the raw digest bytes is the classic mistake (1401): must differ.
    const wrong = crypto.createHmac('sha256', 'secretKey').update(toSign).digest('base64');
    expect(expected.split(':')[1]).not.toBe(wrong);
  });

  it('signs the path without the query string and sends X-Version 3', async () => {
    let seen = null;
    lmApi._setTransport(async (cfg) => { seen = cfg; return { status: 200, data: { total: 0, items: [] }, headers: {} }; });
    const src = { id: 999, company: 'acme', auth_mode: 'lmv1', accessId: 'AID', accessKey: 'AKEY' };
    await lmApi.request(src, 'get', '/device/devices', { params: { size: 5, filter: 'displayName:"a+b"' } });
    expect(seen.headers['X-Version']).toBe('3');
    expect(seen.url).toBe('https://acme.logicmonitor.com/santaba/rest/device/devices?size=5&filter=displayName%3A%22a%252Bb%22');
    const [, sig, epoch] = seen.headers.Authorization.replace('LMv1 ', '').split(':');
    const hex = crypto.createHmac('sha256', 'AKEY').update(`GET${epoch}/device/devices`).digest('hex');
    expect(sig).toBe(Buffer.from(hex).toString('base64'));
  });

  it('signs the exact POST body bytes it sends', async () => {
    let seen = null;
    lmApi._setTransport(async (cfg) => { seen = cfg; return { status: 200, data: {}, headers: {} }; });
    const src = { id: 998, company: 'acme', accessId: 'AID', accessKey: 'AKEY' };
    await lmApi.request(src, 'post', '/device/instances/x', { data: { instanceIds: '1,2' } });
    const [, sig, epoch] = seen.headers.Authorization.replace('LMv1 ', '').split(':');
    const hex = crypto.createHmac('sha256', 'AKEY').update(`POST${epoch}${seen.data}/device/instances/x`).digest('hex');
    expect(seen.data).toBe('{"instanceIds":"1,2"}');
    expect(sig).toBe(Buffer.from(hex).toString('base64'));
  });

  it('bearer mode sends Bearer, 401 is reported without retry, v1 envelope fails loudly', async () => {
    let calls = 0;
    lmApi._setTransport(async (cfg) => {
      calls += 1;
      expect(cfg.headers.Authorization).toBe('Bearer tok');
      return { status: 401, data: { errorMessage: 'Authentication failed', errorCode: 1401 }, headers: {} };
    });
    const src = { id: 997, company: 'acme', auth_mode: 'bearer', token: 'tok' };
    await expect(lmApi.request(src, 'get', '/device/devices')).rejects.toThrow(lmApi.CREDS_REJECTED);
    expect(calls).toBe(1);
    lmApi._setTransport(async () => ({ status: 200, data: { status: 200, errmsg: 'OK', data: {} }, headers: {} }));
    await expect(lmApi.request(src, 'get', '/device/devices')).rejects.toThrow(/v1 envelope/);
  });

  it('429 sleeps the window and retries once; low remaining waits; headers are tracked', async () => {
    const sleeps = [];
    lmApi._setSleep(async (ms) => { sleeps.push(ms); });
    let n = 0;
    lmApi._setTransport(async () => {
      n += 1;
      if (n === 1) return { status: 429, data: { errorMessage: 'too many' }, headers: { 'x-rate-limit-window': '7' } };
      return { status: 200, data: { items: [] }, headers: { 'x-rate-limit-limit': '500', 'x-rate-limit-remaining': '2', 'x-rate-limit-window': '60' } };
    });
    const src = { id: 996, company: 'acme', accessId: 'A', accessKey: 'K' };
    await lmApi.request(src, 'get', '/device/devices/5/devicedatasources');
    expect(n).toBe(2);
    expect(sleeps[0]).toBe(7000);
    const snap = lmApi.getRateLimitSnapshot(996);
    expect(snap['/device/devices/{id}/devicedatasources']).toMatchObject({ limit: 500, remaining: 2, window: 60 });
    await lmApi.request(src, 'get', '/device/devices/6/devicedatasources');
    expect(sleeps.length).toBe(2);
    expect(sleeps[1]).toBeGreaterThan(50000);
  });

  it('normalizeCompany strips scheme, domain and slashes', () => {
    expect(lmApi.normalizeCompany('https://Acme.logicmonitor.com/santaba/rest')).toBe('acme');
    expect(lmApi.normalizeCompany('acme-ops')).toBe('acme-ops');
    expect(lmApi.normalizeCompany('bad host!')).toBeNull();
    expect(lmApi.normalizeCompany('')).toBeNull();
  });
});

describe('logicmonitorApi: pagination and filters', () => {
  it('pages through a NEGATIVE total until a short page', async () => {
    const pages = [
      { total: -1000, items: [1, 2] },
      { total: -1000, items: [3, 4] },
      { total: 5, items: [5] },
    ];
    const offsets = [];
    const res = await lmApi.paginateWith(async (offset) => { offsets.push(offset); return pages[offsets.length - 1]; }, { size: 2 });
    expect(res.items).toEqual([1, 2, 3, 4, 5]);
    expect(offsets).toEqual([0, 2, 4]);
  });

  it('stops when a positive total is reached on a full page, and on the offset cap', async () => {
    let calls = 0;
    const res = await lmApi.paginateWith(async () => { calls += 1; return { total: 4, items: [calls * 2 - 1, calls * 2] }; }, { size: 2 });
    expect(res.items).toEqual([1, 2, 3, 4]);
    expect(calls).toBe(2);
    const capped = await lmApi.paginateWith(async () => ({ total: -1, items: [1, 2] }), { size: 2, maxOffset: 6 });
    expect(capped.items.length).toBe(6);
    expect(capped.truncated).toBe(true);
  });

  it('builds filters with quoted strings, bare numbers and | OR, and double-encodes +', () => {
    expect(lmApi.buildFilter([['displayName', ':', 'core-sw'], ['deviceType', ':', 0]])).toBe('displayName:"core-sw",deviceType:0');
    expect(lmApi.buildFilter([['hostGroupIds', ':', ['24517', '31']]])).toBe('hostGroupIds:"24517"|"31"');
    expect(lmApi.encodeFilter('name:"a+b",x>:1')).toBe('name%3A%22a%252Bb%22%2Cx%3E%3A1');
  });
});

describe('logicmonitorApi: classification (section 5)', () => {
  const cases = [
    [{ sysoid: '1.3.6.1.4.1.9.1.2066' }, 'Cisco'],
    [{ sysoid: '.1.3.6.1.4.1.3375.2.1.3.4.43' }, 'F5'],
    [{ sysoid: '.1.3.6.1.4.1.2636.1.1' }, 'Juniper'],
    [{ sysoid: '.1.3.6.1.4.1.47196.4.1.1.1' }, 'Aruba CX'],
    [{ sysoid: '.1.3.6.1.4.1.8072.3.2.10' }, 'Net-SNMP'],
    [{ categories: 'snmp,CiscoASA' }, 'Cisco'],
    [{ categories: 'snmp,F5Active' }, 'F5'],
    [{ sysinfo: 'Arista Networks EOS version 4.31.2F' }, 'Arista'],
    [{ sysinfo: 'Linux host 5.15' }, null],
  ];
  for (const [input, vendor] of cases) {
    it(`vendor ${JSON.stringify(input)} -> ${vendor}`, () => expect(lmApi.classifyVendor(input)).toBe(vendor));
  }

  it('role from ERT first, then categories, then vendor', () => {
    expect(lmApi.classifyRole({ ert: 'Firewall', vendor: 'Cisco' })).toBe('firewall');
    expect(lmApi.classifyRole({ ert: 'LOADBALANCECOLLECTOR' })).toBe('load-balancer');
    expect(lmApi.classifyRole({ ert: 'VirtualMachine' })).toBe('server');
    expect(lmApi.classifyRole({ ert: 'StorageNode' })).toBe('storage');
    expect(lmApi.classifyRole({ categories: 'snmp,CiscoASA', vendor: 'Cisco' })).toBe('firewall');
    expect(lmApi.classifyRole({ categories: 'F5GTM', vendor: 'F5' })).toBe('load-balancer');
    expect(lmApi.classifyRole({ vendor: 'F5' })).toBe('load-balancer');
    expect(lmApi.classifyRole({ categories: 'CiscoMerakiWireless' })).toBe('wireless');
    expect(lmApi.classifyRole({ ert: 'WLC', categories: 'snmp,TopoSwitch,Cisco', vendor: 'Cisco' })).toBe('wireless');
    expect(lmApi.classifyRole({ ert: 'Wireless', categories: 'TopoSwitch', vendor: 'Cisco' })).toBe('wireless');
    expect(lmApi.classifyRole({ categories: 'snmp,TopoSwitch', vendor: 'Cisco' })).toBe('switch');
    expect(lmApi.classifyRole({ categories: 'CiscoUCSManager' })).toBe('server');
    expect(lmApi.classifyRole({ categories: 'Windows' })).toBe('server');
    expect(lmApi.classifyRole({ vendor: 'Cisco' })).toBe('switch');
    expect(lmApi.classifyRole({ vendor: 'Microsoft' })).toBe('other');
  });

  // Round 11 (lm11-servers): server roles and the NetScout, Zscaler and Oracle vendors.
  it('Windows and Linux categories without a network category are servers', () => {
    expect(lmApi.classifyRole({ categories: 'snmp,NetSNMP,Linux,TopoSwitch', vendor: 'Net-SNMP' })).toBe('server');
    expect(lmApi.classifyRole({ categories: 'Windows,WMI,TopoSwitch' })).toBe('server');
    expect(lmApi.classifyRole({ ert: 'VirtualMachineResource', categories: 'snmp,TopoSwitch', vendor: 'Net-SNMP' })).toBe('server');
    expect(lmApi.classifyRole({ ert: 'PhysicalServer' })).toBe('server');
    // A network category keeps its role.
    expect(lmApi.classifyRole({ categories: 'Linux,CiscoASA', vendor: 'Cisco' })).toBe('firewall');
    expect(lmApi.classifyRole({ categories: 'snmp,TopoSwitch', vendor: 'Cisco' })).toBe('switch');
  });

  it('detects NetScout, Zscaler and Oracle vendors (patterns UNVERIFIED live)', () => {
    expect(lmApi.classifyVendor({ sysoid: '.1.3.6.1.4.1.8072.3.2.10', categories: 'snmp,NetSNMP,Linux', sysinfo: 'NetScout nGenius PFS 6010' })).toBe('NetScout');
    expect(lmApi.classifyVendor({ categories: 'snmp,Infinistream' })).toBe('NetScout');
    expect(lmApi.classifyVendor({ sysinfo: 'PFS 5010 packet flow switch' })).toBe('NetScout');
    expect(lmApi.classifyVendor({ sysoid: '.1.3.6.1.4.1.8072.3.2.10', sysinfo: 'Linux zscaler-nss 4.18 ZscalerOS' })).toBe('Zscaler');
    expect(lmApi.classifyVendor({ categories: 'snmp,ntm_sbc_system_health' })).toBe('Oracle');
    expect(lmApi.classifyVendor({ sysinfo: 'Acme Packet Net-Net 4600' })).toBe('Oracle');
    expect(lmApi.classifyVendor({ sysoid: '.1.3.6.1.4.1.9.1.2066' })).toBe('Cisco');
  });

  it('is_network needs deviceType 0 and a network role', () => {
    expect(lmApi.isNetworkDevice({ deviceType: 0, role: 'switch' })).toBe(true);
    expect(lmApi.isNetworkDevice({ deviceType: 2, role: 'switch' })).toBe(false);
    expect(lmApi.isNetworkDevice({ deviceType: 0, role: 'server' })).toBe(false);
  });

  it('every VERSION_PATTERNS example parses', () => {
    for (const p of lmApi.VERSION_PATTERNS) expect(lmApi.parseVersion(p.example), p.vendor).toBeTruthy();
    expect(lmApi.parseVersion('Cisco IOS Software, C9300 Software (CAT9K_IOSXE), Version 17.9.4a, RELEASE SOFTWARE')).toBe('17.9.4a');
    expect(lmApi.parseVersion('BIG-IP 17.1.1 Build 0.0.4 Final')).toBe('17.1.1');
    expect(lmApi.parseVersion('no version here')).toBeNull();
  });

  it('normalizeDevice reads property arrays, ERI and the comma group string', () => {
    const d = lmApi.normalizeDevice({
      id: 44, name: '10.1.2.3', displayName: 'core-sw-01', deviceType: 0, hostStatus: 'normal',
      hostGroupIds: '2,391', currentCollectorId: 12, createdOn: 1700000000,
      systemProperties: [
        { name: 'system.sysoid', value: '1.3.6.1.4.1.9.1.2066' },
        { name: 'system.sysinfo', value: 'Cisco IOS Software, Version 17.6.5, RELEASE' },
        { name: 'system.ips', value: '10.1.2.3,10.9.9.9' },
        { name: 'system.sysname', value: 'core-sw-01.acme.local' },
      ],
      autoProperties: [{ name: 'predef.externalResourceID', value: '00:11:22:33:44:55,10.1.2.3,core-sw-01.acme.local' }],
      customProperties: [{ name: 'system.categories', value: 'snmp,Cisco,TopoSwitch' }],
    });
    expect(d.vendor).toBe('Cisco');
    expect(d.role).toBe('switch');
    expect(d.isNetwork).toBe(1);
    expect(d.version).toBe('17.6.5');
    expect(d.groupIds).toEqual([2, 391]);
    expect(d.ips).toEqual(['10.1.2.3', '10.9.9.9']);
    expect(d.eri).toEqual({ mac: ['00:11:22:33:44:55'], ip: ['10.1.2.3'], fqdn: ['core-sw-01.acme.local'] });
  });

  it('alertStatus three-slot parse: slot 1 is ack state, not severity', () => {
    expect(lmApi.parseAlertStatus('unconfirmed-critical-none')).toEqual({ severity: 'critical', acked: false, sdt: false });
    expect(lmApi.parseAlertStatus('confirmed-warn-none')).toEqual({ severity: 'warn', acked: true, sdt: false });
    expect(lmApi.parseAlertStatus('none')).toEqual({ severity: null, acked: false, sdt: false });
    expect(lmApi.hasSdt('none-SDT-none')).toBe(true);
    expect(lmApi.hasSdt('none-none-none')).toBe(false);
  });
});

describe('alerts: condition key, upsert and not_reported close', () => {
  let sid;
  beforeEach(() => { wipe(); sid = insertSource(); });

  const raw = (id, extra = {}) => ({
    id, internalId: 'LMD1', type: 'dataSourceAlert', severity: 4, startEpoch: 1760000000, endEpoch: 0, cleared: false,
    monitorObjectId: 44, monitorObjectName: 'Core-SW-01', monitorObjectType: 'device',
    resourceTemplateName: 'SNMP_Network_Interfaces', instanceName: 'Gi1/0/1', dataPointName: 'Status',
    alertValue: '2', threshold: '!= 1 1 1', rule: '', acked: false, sdted: false, ...extra,
  });

  it('condition key is content-stable and never the LM id', () => {
    const a = lmApi.normalizeAlert(raw('DS1'), sid);
    const b = lmApi.normalizeAlert(raw('DS2'), sid);
    expect(a.conditionKey).toBe(`lm:${sid}:core-sw-01:SNMP_Network_Interfaces:Gi1/0/1:Status`);
    expect(b.conditionKey).toBe(a.conditionKey);
    expect(a.severityNorm).toBe('critical');
    expect(lmApi.normalizeAlert(raw('DS3', { severity: 3 }), sid).severityNorm).toBe('warning');
    expect(lmApi.normalizeAlert(raw('DS4', { severity: 2 }), sid).severityNorm).toBe('info');
    expect(a.lmDeviceId).toBe(44);
  });

  it('upserts open rows, closes cleared ones and marks unreported ones not_reported', () => {
    const A = lmApi.normalizeAlert(raw('DSA'), sid);
    const B = lmApi.normalizeAlert(raw('DSB', { instanceName: 'Gi1/0/2' }), sid);
    lmPoller.storeAlerts(sid, [A, B], [], { openOk: true });
    expect(db.prepare('SELECT COUNT(*) n FROM lm_alerts WHERE cleared = 0').get().n).toBe(2);

    const Acleared = lmApi.normalizeAlert(raw('DSA', { cleared: true, endEpoch: 1760000500 }), sid);
    lmPoller.storeAlerts(sid, [], [Acleared], { openOk: true });
    const rows = Object.fromEntries(db.prepare('SELECT lm_alert_id, cleared, closed_reason, end_epoch FROM lm_alerts').all().map((r) => [r.lm_alert_id, r]));
    expect(rows.DSA).toMatchObject({ cleared: 1, closed_reason: 'cleared', end_epoch: 1760000500 });
    expect(rows.DSB.cleared).toBe(1);
    expect(rows.DSB.closed_reason).toBe('not_reported');
  });

  it('a failed open pass never closes rows', () => {
    lmPoller.storeAlerts(sid, [lmApi.normalizeAlert(raw('DSX'), sid)], [], { openOk: true });
    lmPoller.storeAlerts(sid, [], [], { openOk: false });
    expect(db.prepare("SELECT cleared FROM lm_alerts WHERE lm_alert_id = 'DSX'").get().cleared).toBe(0);
  });

  it('collectAlerts returns issues plus open severity >= 3 alerts keyed by condition', () => {
    const manifest = require('../platforms/logicmonitor');
    lmPoller.storeAlerts(sid, [
      lmApi.normalizeAlert(raw('DS10'), sid),
      lmApi.normalizeAlert(raw('DS11', { severity: 2, instanceName: 'Gi1/0/9' }), sid),
      lmApi.normalizeAlert(raw('DS12', { sdted: true, instanceName: 'Gi1/0/8' }), sid),
    ], [], { openOk: true });
    db.prepare("INSERT INTO lm_issue_history (issue_key, source, severity, type, target, message) VALUES ('collector-down|portal1|col1', 'portal1', 'critical', 'collector-down', 'col1', 'down')").run();
    const items = manifest.collectAlerts({ db });
    const keys = items.map((i) => i.sourceKey);
    expect(keys).toContain('collector-down|portal1|col1');
    expect(keys).toContain(`lm:${sid}:core-sw-01:SNMP_Network_Interfaces:Gi1/0/1:Status`);
    expect(items.length).toBe(2);
    const alert = items.find((i) => i.sourceKey.startsWith('lm:'));
    expect(alert).toMatchObject({ severity: 'critical', host: 'Core-SW-01', type: 'SNMP_Network_Interfaces' });
    expect(alert.message).toBe('SNMP_Network_Interfaces Gi1/0/1 Status = 2 (threshold != 1 1 1)');
    expect(alert.firstSeen).toBe(new Date(1760000000 * 1000).toISOString());
  });
});

describe('interfaces: column mapping from a fake data response', () => {
  it('maps by name, skips "No Data", derives Mbps and utilization', () => {
    const body = {
      dataSourceName: 'SNMP_Network_Interfaces',
      dataPoints: ['InOctets', 'OutOctets', 'InErrors', 'Status', 'InInterfaceSpeed'],
      instances: {
        'SNMP_Network_Interfaces-GigabitEthernet1/0/1 [ID:1]': {
          time: [1760400000000, 1760400300000, 1760400600000],
          values: [
            [12500000, 6250000, 1, 1, 1000000000],
            [25000000, 'No Data', 3, 1, 1000000000],
            ['No Data', null, null, 2, 1000000000],
          ],
        },
        'SNMP_Network_Interfaces-Unknown [ID:9]': { time: [1], values: [[1, 1, 1, 1, 1]] },
      },
    };
    const rows = [{ instance_id: 501, instance_name: 'SNMP_Network_Interfaces-GigabitEthernet1/0/1 [ID:1]', display_name: 'GigabitEthernet1/0/1' }];
    const out = lmPoller.mapInterfaceResponse(body, rows);
    expect(out.length).toBe(1);
    const s = out[0];
    expect(s.instanceId).toBe(501);
    // Current = last non-gap per column: InOctets 25e6 -> 200 Mbps, OutOctets 6.25e6 -> 50 Mbps.
    expect(s.current.inMbps).toBe(200);
    expect(s.current.outMbps).toBe(50);
    expect(s.current.status).toBe(2);
    expect(s.current.inErrors).toBe(3);
    expect(s.current.speedBps).toBe(1000000000);
    expect(s.current.inUtil).toBe(20);
    expect(s.current.outUtil).toBe(5);
    // Average over non-gap samples: InOctets (12.5e6 + 25e6) / 2 -> 150 Mbps; errors (1 + 3) / 2.
    expect(s.average.inMbps).toBe(150);
    expect(s.average.inErrors).toBe(2);
    expect(s.sampledAt).toBe(1760400600);
    expect(lmPoller.statusText(1)).toBe('up');
    expect(lmPoller.statusText(2)).toBe('down');
    expect(lmPoller.statusText(7)).toBe('other');
    expect(lmPoller.statusText(null)).toBe('unknown');
  });

  it('matches instances by name with the DataSource prefix stripped', () => {
    const rows = [{ instance_id: 7, instance_name: null, display_name: 'Gi1/0/2' }];
    expect(lmPoller.matchInstance(rows, 'SNMP_Network_Interfaces-Gi1/0/2 [ID:2]', 'SNMP_Network_Interfaces')).toBe(rows[0]);
  });
});

describe('checks: column learning and row mapping', () => {
  it('learns ping columns by name and derives loss from sent and received', () => {
    const dp = ['status', 'minRTT', 'maxRTT', 'avgRTT', 'sendPkts', 'recdPkts'];
    const l = lmChecks.learnCheckColumns(dp, 'ping');
    expect(l.columns).toMatchObject({ status: 'status', rttMin: 'minRTT', rttMax: 'maxRTT', rttAvg: 'avgRTT', sent: 'sendPkts', recv: 'recdPkts' });
    expect(l.isOverall).toBe(false);
    const row = lmChecks.mapCheckRow([1, 10, 40, 21, 5, 4], l, dp);
    expect(row).toMatchObject({ status: 'up', rttMinMs: 10, rttMaxMs: 40, rttAvgMs: 21, lossPct: 20 });
    expect(lmChecks.mapCheckRow([24, 10, 40, 21, 5, 0], l, dp)).toMatchObject({ status: 'down', lossPct: 100 });
  });

  it('marks the Overall checkpoint by its datapoint set; web responsetime goes to responseMs', () => {
    expect(lmChecks.learnCheckColumns(['overallStatus', 'totalSmCount', 'failSmCount'], 'ping').isOverall).toBe(true);
    const web = lmChecks.learnCheckColumns(['status', 'responseTime', 'sslDaysUntilExpiration'], 'web');
    expect(web.columns.response).toBe('responseTime');
    expect(web.unmatched).toContain('sslDaysUntilExpiration');
    const ping = lmChecks.learnCheckColumns(['status', 'responseTime'], 'ping');
    expect(ping.columns.rttAvg).toBe('responseTime');
  });

  it('positional responses (no dataPoints) map nothing and keep the raw columns', () => {
    const l = lmChecks.learnCheckColumns(undefined, 'ping', 3);
    expect(l.positional).toBe(true);
    expect(l.unmatched).toEqual(['col0', 'col1', 'col2']);
  });

  it('parseCheckSeries converts millisecond times and drops gap rows', () => {
    const dp = ['status', 'avgRTT'];
    const l = lmChecks.learnCheckColumns(dp, 'ping');
    const rows = lmChecks.parseCheckSeries({ time: [1760400300000, 1760400000], values: [[1, 30], ['No Data', null]] }, l, dp);
    expect(rows.length).toBe(1);
    expect(rows[0].sampleEpoch).toBe(1760400300);
  });
});

describe('checks: baselines and anomaly rules', () => {
  const NOW = Date.UTC(2026, 9, 14, 12, 30, 0);
  const nowSec = Math.floor(NOW / 1000);
  let sid;

  function seedCheck(checkId, name, label, { isInternal = 1 } = {}) {
    db.prepare(`INSERT INTO lm_checks (source_id, check_id, kind, origin, name, target, polling_interval, is_internal)
      VALUES (?, ?, 'ping', 'website', ?, ?, 5, ?)`).run(sid, checkId, name, `${name}.target`, isInternal);
    db.prepare(`INSERT INTO lm_check_locations (source_id, check_id, checkpoint_id, lm_checkpoint_id, label, is_overall)
      VALUES (?, ?, 'cp1', 1, ?, 0)`).run(sid, checkId, label);
    db.prepare(`INSERT INTO lm_check_locations (source_id, check_id, checkpoint_id, lm_checkpoint_id, label, is_overall, last_status, last_sample_epoch)
      VALUES (?, ?, 'overall', 0, 'Overall', 1, 'up', ?)`).run(sid, checkId, nowSec - 60);
    // 25 baseline samples at 12:xx UTC on the 5 previous days: RTT 28..32 (median 30, MAD 1), loss 0.
    const ins = db.prepare(`INSERT INTO lm_check_history (source_id, check_id, checkpoint_id, sample_epoch, status, rtt_avg_ms, loss_pct)
      VALUES (?, ?, 'cp1', ?, 'up', ?, 0)`);
    for (let day = 1; day <= 5; day += 1) {
      for (let k = 0; k < 5; k += 1) ins.run(sid, checkId, Date.UTC(2026, 9, 14 - day, 12, k * 10) / 1000, 28 + k);
    }
  }

  function seedRecent(checkId, rtt, loss) {
    const ins = db.prepare(`INSERT INTO lm_check_history (source_id, check_id, checkpoint_id, sample_epoch, status, rtt_avg_ms, loss_pct)
      VALUES (?, ?, 'cp1', ?, 'up', ?, ?)`);
    for (let i = 3; i >= 1; i -= 1) ins.run(sid, checkId, nowSec - i * 300, rtt, loss);
    db.prepare(`UPDATE lm_check_locations SET last_status = 'up', last_rtt_ms = ?, last_loss_pct = ?, last_sample_epoch = ?
      WHERE source_id = ? AND check_id = ? AND checkpoint_id = 'cp1'`).run(rtt, loss, nowSec - 300, sid, checkId);
  }

  beforeEach(() => { wipe(); sid = insertSource(); });

  it('median and MAD by hand', () => {
    expect(lmChecks.median([28, 29, 30, 31, 32])).toBe(30);
    expect(lmChecks.mad([28, 29, 30, 31, 32])).toBe(1);
    expect(lmChecks.median([1, 2, 3, 4])).toBe(2.5);
  });

  it('computeBaselines groups by UTC hour and skips the current hour', () => {
    seedCheck('w:1', 'phx-to-dc1', 'PHX-COL01');
    seedRecent('w:1', 30, 0);
    const n = lmChecks.computeBaselines(db, sid, 7, 24, NOW);
    expect(n).toBe(1);
    const b = db.prepare("SELECT * FROM lm_check_baseline WHERE check_id = 'w:1'").get();
    expect(b).toMatchObject({ hour_of_day: 12, samples: 25, rtt_median: 30, rtt_mad: 1, loss_median: 0, loss_mad: 0 });
    // Below minSamples nothing is written.
    expect(lmChecks.computeBaselines(db, sid, 7, 26, NOW)).toBe(0);
  });

  it('latency anomaly: 50 ms > 30 + 3 * max(1, 5) = 45 is a warning; 120 ms is critical', () => {
    seedCheck('w:1', 'phx-to-dc1', 'PHX-COL01');
    seedRecent('w:1', 50, 0);
    lmChecks.computeBaselines(db, sid, 7, 24, NOW);
    let issues = lmChecks.evaluateAnomalies(db, { nowMs: NOW });
    expect(issues).toEqual([expect.objectContaining({
      type: 'latency-anomaly', severity: 'warning', target: 'phx-to-dc1 @ PHX-COL01',
      message: 'RTT 50 ms, baseline 30 +/- 1 ms, from collector PHX-COL01',
    })]);
    db.prepare("DELETE FROM lm_check_history WHERE sample_epoch > ?").run(nowSec - 3600);
    seedRecent('w:1', 120, 0);
    issues = lmChecks.evaluateAnomalies(db, { nowMs: NOW });
    expect(issues[0]).toMatchObject({ type: 'latency-anomaly', severity: 'critical' });
  });

  it('44 ms stays quiet (below 45), and the absolute floor of 20 ms holds', () => {
    seedCheck('w:1', 'phx-to-dc1', 'PHX-COL01');
    seedRecent('w:1', 44, 0);
    lmChecks.computeBaselines(db, sid, 7, 24, NOW);
    expect(lmChecks.evaluateAnomalies(db, { nowMs: NOW })).toEqual([]);
  });

  it('packet-loss anomaly: 10% > 0 + 3 * max(0, 1) and >= 2 is a warning; 25% is critical', () => {
    seedCheck('w:1', 'phx-to-dc1', 'PHX-COL01');
    seedRecent('w:1', 30, 10);
    lmChecks.computeBaselines(db, sid, 7, 24, NOW);
    expect(lmChecks.evaluateAnomalies(db, { nowMs: NOW })[0]).toMatchObject({ type: 'packet-loss-anomaly', severity: 'warning' });
    db.prepare('DELETE FROM lm_check_history WHERE sample_epoch > ?').run(nowSec - 3600);
    seedRecent('w:1', 30, 25);
    expect(lmChecks.evaluateAnomalies(db, { nowMs: NOW })[0]).toMatchObject({ type: 'packet-loss-anomaly', severity: 'critical' });
  });

  it('check-down from Overall down; per-location down when Overall is up', () => {
    seedCheck('w:1', 'phx-to-dc1', 'PHX-COL01');
    seedCheck('w:2', 'phx-to-dc2', 'PHX-COL01');
    db.prepare("UPDATE lm_check_locations SET last_status = 'down' WHERE check_id = 'w:1' AND checkpoint_id = 'overall'").run();
    db.prepare("UPDATE lm_check_locations SET last_status = 'down', last_sample_epoch = ? WHERE check_id = 'w:2' AND checkpoint_id = 'cp1'").run(nowSec - 60);
    const issues = lmChecks.evaluateAnomalies(db, { nowMs: NOW });
    expect(issues.find((i) => i.type === 'check-down')).toMatchObject({ target: 'phx-to-dc1', severity: 'critical' });
    expect(issues.find((i) => i.type === 'check-location-down')).toMatchObject({ target: 'phx-to-dc2 @ PHX-COL01', severity: 'warning' });
  });

  it('three anomalous checks at one collector fold into one location-degraded issue', () => {
    for (const n of [1, 2, 3]) {
      seedCheck(`w:${n}`, `phx-to-site${n}`, 'PHX-COL01');
      seedRecent(`w:${n}`, 60, 0);
    }
    lmChecks.computeBaselines(db, sid, 7, 24, NOW);
    const issues = lmChecks.evaluateAnomalies(db, { nowMs: NOW });
    expect(issues.length).toBe(1);
    expect(issues[0]).toMatchObject({ type: 'location-degraded', severity: 'critical', target: 'PHX-COL01' });
  });

  it('evaluateLocations exposes the matrix fields', () => {
    seedCheck('w:1', 'phx-to-dc1', 'PHX-COL01');
    seedRecent('w:1', 50, 0);
    lmChecks.computeBaselines(db, sid, 7, 24, NOW);
    const loc = lmChecks.evaluateLocations(db, { nowMs: NOW }).find((l) => l.checkpointId === 'cp1');
    expect(loc).toMatchObject({ anomaly: 'latency', baselineRttMs: 30, baselineRttMad: 1, rttAvgMs: 50, status: 'up', isOverall: false });
  });
});

describe('topology: description parser and link builder', () => {
  const index = new Map([['core-sw-01', 1], ['dist-sw-02', 2], ['10.0.0.9', 3]]);
  const resolve = (t) => index.get(String(t).toLowerCase()) ?? null;

  it('parses "to <device> <port>" forms', () => {
    expect(lmPoller.parseLinkDescription('Uplink to core-sw-01 Gi1/0/48', resolve)).toEqual({ dstDeviceId: 1, dstName: 'core-sw-01', dstPort: 'Gi1/0/48', confidence: 'high' });
    expect(lmPoller.parseLinkDescription('to dist-sw-02:Te1/1/1', resolve)).toMatchObject({ dstDeviceId: 2, dstPort: 'Te1/1/1', confidence: 'high' });
    expect(lmPoller.parseLinkDescription('-> DIST-SW-02', resolve)).toMatchObject({ dstDeviceId: 2, dstPort: null, confidence: 'medium' });
    expect(lmPoller.parseLinkDescription('link to core-sw-01-Gi1/0/2', resolve)).toMatchObject({ dstDeviceId: 1, dstPort: 'Gi1/0/2', confidence: 'high' });
  });

  it('falls back to a bare resolvable token (low), keeps link-shaped outliers unresolved, ignores the rest', () => {
    expect(lmPoller.parseLinkDescription('backup path via 10.0.0.9', resolve)).toMatchObject({ dstDeviceId: 3, confidence: 'low' });
    expect(lmPoller.parseLinkDescription('uplink to mystery-box Gi0/1', resolve)).toEqual({ dstDeviceId: null, dstName: 'mystery-box', dstPort: null, confidence: 'low' });
    expect(lmPoller.parseLinkDescription('printer port', resolve)).toBeNull();
    expect(lmPoller.parseLinkDescription('', resolve)).toBeNull();
  });

  it('buildTopologyLinks resolves through the ERI index and keeps first_seen', () => {
    wipe();
    const sid = insertSource();
    insertDevice(sid, { id: 10, display: 'access-sw-01' });
    insertDevice(sid, { id: 11, display: 'core-sw-01.acme.local', eri: { mac: ['00:11:22:33:44:55'], ip: [], fqdn: [] } });
    const ins = db.prepare('INSERT INTO lm_interfaces (source_id, lm_device_id, instance_id, display_name, description) VALUES (?, ?, ?, ?, ?)');
    ins.run(sid, 10, 100, 'Gi1/0/49', 'to core-sw-01 Gi1/0/1');
    ins.run(sid, 10, 101, 'Gi1/0/50', 'peer 00:11:22:33:44:55');
    ins.run(sid, 10, 102, 'Gi1/0/51', 'uplink to unknown-sw');
    ins.run(sid, 10, 103, 'Gi1/0/1', 'office desk');
    const res = lmPoller.buildTopologyLinks(db, sid);
    expect(res).toEqual({ links: 3, resolved: 2, resolvedIcc: 0, eri: { cdp: 0, lldp: 0, resolved: 0, neighborsResolvedByEri: 0 } });
    const rows = db.prepare('SELECT src_instance_id, dst_device_id, dst_port, confidence FROM lm_topology_links ORDER BY src_instance_id').all();
    expect(rows).toEqual([
      { src_instance_id: 100, dst_device_id: 11, dst_port: 'Gi1/0/1', confidence: 'high' },
      { src_instance_id: 101, dst_device_id: 11, dst_port: null, confidence: 'low' },
      { src_instance_id: 102, dst_device_id: null, dst_port: null, confidence: 'low' },
    ]);
    db.prepare("UPDATE lm_topology_links SET first_seen = '2026-01-01 00:00:00' WHERE src_instance_id = 100").run();
    lmPoller.buildTopologyLinks(db, sid);
    expect(db.prepare('SELECT first_seen FROM lm_topology_links WHERE src_instance_id = 100').get().first_seen).toBe('2026-01-01 00:00:00');
  });
});

describe('logicmonitorIssues: rules', () => {
  let sid;
  beforeEach(() => { wipe(); sid = insertSource({ features_json: JSON.stringify({ collectorMgd: '41.000' }) }); });

  const byType = (issues, type) => issues.filter((i) => i.type === type);

  it('source-unreachable when the last poll errored', () => {
    db.prepare("UPDATE lm_sources SET last_poll_status = 'error', last_poll_error = 'HTTP 503' WHERE id = ?").run(sid);
    expect(byType(lmIssues.computeIssues(), 'source-unreachable')[0]).toMatchObject({ severity: 'critical', target: 'portal1' });
  });

  it('collector-down counts its devices; dead-collector devices raise nothing; build behind MGD is info', () => {
    db.prepare(`INSERT INTO lm_collectors (source_id, collector_id, hostname, is_down, in_sdt, build) VALUES (?, 5, 'col-phx', 1, 0, '39.005')`).run(sid);
    db.prepare(`INSERT INTO lm_collectors (source_id, collector_id, hostname, is_down, in_sdt, build) VALUES (?, 6, 'col-dc1', 0, 0, '41.000')`).run(sid);
    insertDevice(sid, { id: 1, collector: 5, host: 'dead-collector' });
    insertDevice(sid, { id: 2, collector: 5, host: 'dead-collector' });
    const issues = lmIssues.computeIssues();
    expect(byType(issues, 'collector-down')).toEqual([expect.objectContaining({ target: 'col-phx', severity: 'critical' })]);
    expect(byType(issues, 'collector-down')[0].message).toMatch(/2 devices/);
    expect(byType(issues, 'device-dead')).toEqual([]);
    expect(byType(issues, 'collector-build-behind')).toEqual([expect.objectContaining({ target: 'col-phx', severity: 'info' })]);
    expect(lmIssues.compareBuild('39.005', '41.000')).toBe(-1);
    expect(lmIssues.isBehind('41.000', '41.000')).toBe(false);
  });

  it('device-dead honours the grace window, SDT and the network flag', () => {
    insertDevice(sid, { id: 1, display: 'core-sw', host: 'dead', deletedMs: 20 * 60000, network: 1 });
    insertDevice(sid, { id: 2, display: 'new-dead', host: 'dead', deletedMs: 2 * 60000 });
    insertDevice(sid, { id: 3, display: 'web01', host: 'dead', deletedMs: 3600000, network: 0, role: 'server' });
    insertDevice(sid, { id: 4, display: 'maint', host: 'dead', deletedMs: 3600000, sdt: 'none-SDT-none' });
    insertDevice(sid, { id: 5, display: 'old-dead', host: 'dead', deadSince: '2026-01-01 00:00:00' });
    const dead = byType(lmIssues.computeIssues(), 'device-dead');
    const map = Object.fromEntries(dead.map((i) => [i.target, i.severity]));
    expect(map).toEqual({ 'core-sw': 'critical', web01: 'warning', 'old-dead': 'critical' });
    expect(byType(lmIssues.computeIssues(), 'device-in-sdt').map((i) => i.target)).toEqual(['maint']);
  });

  it('interface utilization, errors and flapping from history', () => {
    insertDevice(sid, { id: 1, display: 'edge-sw' });
    db.prepare("INSERT INTO lm_interfaces (source_id, lm_device_id, instance_id, display_name) VALUES (?, 1, 900, 'Gi1/0/1')").run(sid);
    db.prepare("INSERT INTO lm_interfaces (source_id, lm_device_id, instance_id, display_name) VALUES (?, 1, 901, 'Gi1/0/2')").run(sid);
    const ins = db.prepare(`INSERT INTO lm_interface_history (source_id, instance_id, captured_at, status, in_util_pct, out_util_pct, in_errors, out_errors)
      VALUES (?, ?, datetime('now', ?), ?, ?, ?, ?, ?)`);
    // 900: hot for the last 3 rows, 40 errors per row over 4 rows = 160 > 100.
    ins.run(sid, 900, '-60 minutes', 1, 50, 10, 40, 0);
    ins.run(sid, 900, '-45 minutes', 1, 85, 10, 40, 0);
    ins.run(sid, 900, '-30 minutes', 1, 90, 10, 40, 0);
    ins.run(sid, 900, '-15 minutes', 1, 10, 95, 40, 0);
    // 901: status 1,2,1,2 = 3 changes.
    ins.run(sid, 901, '-60 minutes', 1, 1, 1, 0, 0);
    ins.run(sid, 901, '-45 minutes', 2, 1, 1, 0, 0);
    ins.run(sid, 901, '-30 minutes', 1, 1, 1, 0, 0);
    ins.run(sid, 901, '-15 minutes', 2, 1, 1, 0, 0);
    const issues = lmIssues.computeIssues();
    expect(byType(issues, 'interface-utilization-high').map((i) => i.target)).toEqual(['edge-sw Gi1/0/1']);
    expect(byType(issues, 'interface-errors-growing').map((i) => i.target)).toEqual(['edge-sw Gi1/0/1']);
    expect(byType(issues, 'interface-flapping').map((i) => i.target)).toEqual(['edge-sw Gi1/0/2']);
  });

  it('alert-storm above 50 alerts in 15 minutes', () => {
    const ins = db.prepare(`INSERT INTO lm_alerts (source_id, lm_alert_id, start_epoch, condition_key) VALUES (?, ?, ?, ?)`);
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 51; i += 1) ins.run(sid, `DS${i}`, now - 60, `k${i}`);
    expect(byType(lmIssues.computeIssues(), 'alert-storm')).toHaveLength(1);
    db.prepare("DELETE FROM lm_alerts WHERE lm_alert_id = 'DS0'").run();
    expect(byType(lmIssues.computeIssues(), 'alert-storm')).toHaveLength(0);
  });

  it('device-new respects the bootstrap guard', () => {
    insertDevice(sid, { id: 1, display: 'brand-new' });
    expect(byType(lmIssues.computeIssues(), 'device-new')).toHaveLength(0);
    db.prepare("INSERT INTO lm_metrics_history (source_id, captured_at) VALUES (?, datetime('now', '-10 days'))").run(sid);
    expect(byType(lmIssues.computeIssues(), 'device-new').map((i) => i.target)).toEqual(['brand-new']);
  });

  it('reconcileIssueHistory opens, touches and resolves with BEGIN IMMEDIATE', () => {
    db.prepare("UPDATE lm_sources SET last_poll_status = 'error' WHERE id = ?").run(sid);
    lmIssues.reconcileIssueHistory();
    expect(db.prepare("SELECT issue_key, status FROM lm_issue_history").all()).toEqual([{ issue_key: 'source-unreachable|portal1|portal1', status: 'open' }]);
    db.prepare("UPDATE lm_sources SET last_poll_status = 'success' WHERE id = ?").run(sid);
    lmIssues.reconcileIssueHistory();
    expect(db.prepare('SELECT status FROM lm_issue_history').get().status).toBe('resolved');
  });

  it('getThresholds clamps every section 9 key', () => {
    const { setSetting } = require('../services/settings');
    setSetting('lm_if_util_warn_pct', '5');
    setSetting('lm_check_latency_k', '99');
    const t = lmIssues.getThresholds();
    expect(t.lm_if_util_warn_pct).toBe(50);
    expect(t.lm_check_latency_k).toBe(10);
    expect(t.lm_check_data_calls_per_tick).toBe(200);
    expect(Object.keys(t).length).toBe(69);
    setSetting('lm_if_util_warn_pct', '80');
    setSetting('lm_check_latency_k', '3');
  });
});

describe('manifest hooks: opsSummary, server360, topology', () => {
  let sid;
  beforeEach(() => { wipe(); sid = insertSource(); });

  it('opsSummary returns null without sources and counts network devices', () => {
    const manifest = require('../platforms/logicmonitor');
    wipe();
    expect(manifest.opsSummary({ db })).toBeNull();
    sid = insertSource();
    insertDevice(sid, { id: 1 });
    insertDevice(sid, { id: 2, host: 'dead' });
    insertDevice(sid, { id: 3, network: 0, role: 'server' });
    const s = manifest.opsSummary({ db });
    expect(s.objects).toBe(2);
    expect(s.headline[0]).toEqual({ label: 'Devices', value: '2/3' });
  });

  it('server360 matches by name or IP and links to the device', () => {
    const manifest = require('../platforms/logicmonitor');
    insertDevice(sid, { id: 44, display: 'core-sw-01', ips: ['10.1.2.3'] });
    const byIp = manifest.server360({ db }, { names: new Set(['nothing']), ips: new Set(['10.1.2.3']) });
    expect(byIp.groups[0].link.href).toBe('/logicmonitor/devices?device=44');
    expect(manifest.server360({ db }, { names: new Set(['zzz']), ips: new Set() })).toBeNull();
  });

  it('topology adds the collector and linked neighbours, red on a down port', () => {
    const manifest = require('../platforms/logicmonitor');
    db.prepare(`INSERT INTO lm_collectors (source_id, collector_id, hostname, is_down) VALUES (?, 5, 'col-phx', 0)`).run(sid);
    insertDevice(sid, { id: 10, display: 'access-sw-01', collector: 5 });
    insertDevice(sid, { id: 11, display: 'core-sw-01' });
    db.prepare("INSERT INTO lm_interfaces (source_id, lm_device_id, instance_id, display_name, status_text) VALUES (?, 10, 100, 'Gi1/0/49', 'down')").run(sid);
    db.prepare(`INSERT INTO lm_topology_links (source_id, src_device_id, src_instance_id, src_port, dst_device_id, dst_name, dst_port, protocol, confidence)
      VALUES (?, 10, 100, 'Gi1/0/49', 11, 'core-sw-01', 'Gi1/0/1', 'description', 'high')`).run(sid);
    const g = manifest.topology({ db }, { names: new Set(['access-sw-01']), ips: new Set(), anchorId: 'device:access-sw-01' });
    expect(g.nodes.map((n) => n.id).sort()).toEqual([`lm-collector:${sid}:5`, `lm-device:${sid}:11`]);
    const link = g.edges.find((e) => e.kind === 'link');
    expect(link).toMatchObject({ label: 'Gi1/0/49 - Gi1/0/1', status: 'crit' });
    expect(manifest.topology({ db }, { names: new Set(['nope']), ips: new Set(), anchorId: 'x' })).toBeNull();
  });
});

describe('poller: full tier 1 and tier 2 pass against a fake portal', () => {
  afterEach(() => { lmApi._setTransport(null); lmApi._setSleep(null); });

  it('stores every section, refreshes new devices, pulls check and interface data', async () => {
    wipe();
    const sid = insertSource();
    lmApi._setSleep(async () => {});
    const now = Math.floor(Date.now() / 1000);
    const routes = {
      '/setting/collector/collectors': { items: [{ id: 5, hostname: 'col-phx', isDown: false, build: '39.005', collectorGroupName: 'PHX' }] },
      '/device/groups': { items: [{ id: 2, name: 'Core', fullPath: 'Network/Core', parentId: 1 }] },
      '/device/devices': { total: -1, items: [{
        id: 44, name: '10.1.2.3', displayName: 'core-sw-01', deviceType: 0, hostStatus: 'dead', alertStatus: 'none',
        sdtStatus: 'none-none-none', hostGroupIds: '2', currentCollectorId: 5,
        systemProperties: [{ name: 'system.sysoid', value: '1.3.6.1.4.1.9.1.1' }, { name: 'system.sysinfo', value: 'Cisco IOS Software, Version 17.9.4a, RELEASE' }],
      }] },
      '/sdt/sdts': { items: [{ id: 'R_1', type: 'ResourceSDT', sdtType: 'oneTime', startDateTime: Date.now() - 1000, endDateTime: Date.now() + 1000, deviceId: 44 }] },
      '/alert/alerts': { items: [{ id: 'DS9', severity: 4, startEpoch: now - 60, monitorObjectName: 'core-sw-01', monitorObjectType: 'device', monitorObjectId: 44, resourceTemplateName: 'Host Status', dataPointName: 'idleInterval' }] },
      '/website/websites': { items: [{ id: 7, name: 'phx-to-dc1', type: 'pingcheck', host: '10.9.9.9', isInternal: true,
        collectors: [{ id: 5, hostname: 'col-phx' }], checkpoints: [{ id: 70, geoInfo: 'col-phx', smgId: 3 }, { id: 71, geoInfo: 'Overall', smgId: 0 }] }] },
      '/website/websites/7/checkpoints/70/data': { dataPoints: ['status', 'avgRTT', 'sendPkts', 'recdPkts'], time: [(now - 120) * 1000], values: [[1, 22, 5, 5]] },
      '/website/websites/7/checkpoints/71/data': { dataPoints: ['overallStatus', 'totalSmCount'], time: [(now - 120) * 1000], values: [[1, 1]] },
      '/device/devices/44/devicedatasources': { items: [{ id: 300, dataSourceName: 'SNMP_Network_Interfaces', instanceNumber: 1 }, { id: 301, dataSourceName: 'LLDP_Neighbors' }] },
      '/device/devices/44/devicedatasources/300/instances': { items: [{ id: 900, name: 'SNMP_Network_Interfaces-Gi1/0/1 [ID:1]', displayName: 'Gi1/0/1 [ID:1]', wildValue: '1', description: 'to nowhere-sw Gi0/1' }] },
      '/device/devices/44/devicedatasources/301/instances': { items: [{ id: 950, name: 'LLDP_Neighbors-dist-sw', displayName: 'dist-sw', autoProperties: [{ name: 'auto.lldp.remote.port', value: 'Gi0/2' }] }] },
      '/device/devices/44/devicedatasources/300/data': { dataSourceName: 'SNMP_Network_Interfaces', dataPoints: ['InMbps', 'OutMbps', 'Status', 'InUtilizationPercent'],
        instances: { 'SNMP_Network_Interfaces-Gi1/0/1 [ID:1]': { time: [(now - 60) * 1000], values: [[10, 5, 1, 1]] } } },
      '/setting/collector/collectors/versions': { items: [{ version: '41.000', mandatory: true }] },
      '/setting/admins': { items: [{ id: 1, username: 'svc-icc', status: 'active', roles: [{ name: 'readonly' }], apionly: true }] },
      '/setting/roles': { items: [{ id: 1, name: 'readonly', privileges: [] }] },
    };
    const calls = [];
    lmApi._setTransport(async (cfg) => {
      const path = cfg.url.replace('https://acme.logicmonitor.com/santaba/rest', '').split('?')[0];
      calls.push(cfg.url);
      if (path === '/device/devices' && cfg.url.includes('filter=deviceType')) return { status: 200, data: { items: [] }, headers: {} };
      const body = routes[path];
      if (!body) return { status: 404, data: { errorMessage: `no route ${path}` }, headers: {} };
      return { status: 200, data: body, headers: {} };
    });
    const source = lmPoller.loadSources().find((s) => s.id === sid);
    await lmPoller.pollSource(source);

    const src = db.prepare('SELECT * FROM lm_sources WHERE id = ?').get(sid);
    expect(src.last_poll_error).toBeNull();
    expect(src.last_poll_status).toBe('success');
    expect(db.prepare('SELECT vendor, role, is_network, version, dead_since IS NOT NULL ds FROM lm_devices').get())
      .toEqual({ vendor: 'Cisco', role: 'switch', is_network: 1, version: '17.9.4a', ds: 1 });
    expect(db.prepare('SELECT COUNT(*) n FROM lm_interfaces').get().n).toBe(1);
    expect(db.prepare('SELECT is_effective FROM lm_sdts').get().is_effective).toBe(1);
    expect(db.prepare('SELECT condition_key FROM lm_alerts').get().condition_key).toBe(`lm:${sid}:core-sw-01:Host Status::idleInterval`);
    const locs = db.prepare('SELECT checkpoint_id, label, is_overall, collector_id, last_status, last_rtt_ms, last_loss_pct FROM lm_check_locations ORDER BY checkpoint_id').all();
    expect(locs).toEqual([
      { checkpoint_id: '70', label: 'col-phx', is_overall: 0, collector_id: 5, last_status: 'up', last_rtt_ms: 22, last_loss_pct: 0 },
      { checkpoint_id: 'overall', label: 'Overall', is_overall: 1, collector_id: null, last_status: 'up', last_rtt_ms: null, last_loss_pct: null },
    ]);
    expect(JSON.parse(src.features_json)).toMatchObject({ collectorMgd: '41.000', ifDataSource: 'SNMP_Network_Interfaces' });
    expect(db.prepare('SELECT COUNT(*) n FROM lm_admins').get().n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM lm_metrics_history').get().n).toBe(1);
    const links = db.prepare('SELECT protocol, dst_name, dst_port FROM lm_topology_links ORDER BY protocol').all();
    expect(links).toEqual([
      { protocol: 'description', dst_name: 'nowhere-sw', dst_port: null },
      { protocol: 'lldp', dst_name: 'dist-sw', dst_port: 'Gi0/2' },
    ]);
    expect(calls.some((u) => u.includes('datafetch'))).toBe(false);

    await lmPoller.pollInterfaces(lmPoller.loadSources().find((s) => s.id === sid));
    expect(db.prepare('SELECT status_text, in_mbps, in_util_pct FROM lm_interfaces').get()).toEqual({ status_text: 'up', in_mbps: 10, in_util_pct: 1 });
    expect(db.prepare('SELECT if_count, if_up FROM lm_devices').get()).toEqual({ if_count: 1, if_up: 1 });
    expect(db.prepare('SELECT COUNT(*) n FROM lm_interface_history').get().n).toBe(1);
    expect(JSON.parse(db.prepare('SELECT features_json FROM lm_sources').get().features_json).ifColumns)
      .toEqual(['InMbps', 'OutMbps', 'Status', 'InUtilizationPercent']);
  });

  it('a poll where every section fails marks the source error and throws', async () => {
    wipe();
    const sid = insertSource({ last_poll_status: null });
    lmApi._setSleep(async () => {});
    lmApi._setTransport(async () => ({ status: 503, data: { errorMessage: 'down' }, headers: {} }));
    await expect(lmPoller.pollSource(lmPoller.loadSources().find((s) => s.id === sid))).rejects.toThrow();
    expect(db.prepare('SELECT last_poll_status FROM lm_sources').get().last_poll_status).toBe('error');
  });
});

// ---- Round 2: cross-platform endpoints and the server-object path ------------

const lmEndpoints = require('../services/logicmonitorEndpoints');

function ensureVcenterFixtures() {
  // The vCenter migration normally creates these (the test DB runs the
  // registry migrations); the fallback DDL matches vcenter.js v11.
  db.exec(`
    CREATE TABLE IF NOT EXISTS vcenter_host_nic_neighbors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vcenter_id INTEGER NOT NULL REFERENCES vcenter_vcenters(id) ON DELETE CASCADE,
      host_name TEXT NOT NULL, nic TEXT NOT NULL, mac TEXT, protocol TEXT NOT NULL,
      switch_name TEXT, switch_port TEXT, switch_address TEXT, switch_platform TEXT, vlan INTEGER,
      raw_json TEXT, captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (vcenter_id, host_name, nic, protocol)
    );
  `);
  clearVcenterFixtures();
  const vcId = db.prepare(`INSERT INTO vcenter_vcenters (name, host, username, encrypted_credentials) VALUES ('vc-test', 'vc.test', 'u', 'x')`).run().lastInsertRowid;
  const host = db.prepare('INSERT INTO vcenter_hosts (vcenter_id, host_id, name, connection_state) VALUES (?, ?, ?, ?)');
  host.run(vcId, 'host-1', 'nyc-esx-0101.icc.demo', 'connected');
  host.run(vcId, 'host-2', 'esx9.a.local', 'connected');
  host.run(vcId, 'host-3', 'esx9.b.local', 'connected');
  db.prepare('INSERT INTO vcenter_vms (vcenter_id, vm_id, name, host_name, ip_address) VALUES (?, ?, ?, ?, ?)')
    .run(vcId, 'vm-1', 'web01', 'nyc-esx-0101.icc.demo', '10.9.9.9');
  return vcId;
}
function clearVcenterFixtures() {
  db.prepare('DELETE FROM vcenter_host_nic_neighbors').run();
  db.prepare('DELETE FROM vcenter_vms').run();
  db.prepare('DELETE FROM vcenter_hosts').run();
  db.prepare("DELETE FROM vcenter_vcenters WHERE name = 'vc-test'").run();
}
const addIface = (sid, dev, iid, name, o = {}) => db.prepare(`
  INSERT INTO lm_interfaces (source_id, lm_device_id, instance_id, display_name, description, status, status_text, in_util_pct, out_util_pct, in_errors, out_errors)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(sid, dev, iid, name, o.desc ?? null, o.status ?? 1, o.statusText ?? 'up', o.inUtil ?? null, o.outUtil ?? null, o.inErr ?? null, o.outErr ?? null);

describe('migration v2: dst_platform and dst_ref on lm_topology_links', () => {
  it('adds both columns', () => {
    const cols = db.prepare("PRAGMA table_info('lm_topology_links')").all().map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['dst_platform', 'dst_ref']));
  });
});

describe('cross-platform resolver (C1)', () => {
  afterEach(() => clearVcenterFixtures());

  it('resolves LM first, then the ICC host index; ambiguous short names stay unresolved', () => {
    wipe();
    ensureVcenterFixtures();
    const sid = insertSource();
    insertDevice(sid, { id: 10, display: 'nyc-acc-01' });
    insertDevice(sid, { id: 11, display: 'core-sw-01' });
    addIface(sid, 10, 100, 'Gi1/0/1', { desc: 'to core-sw-01 Gi1/0/49' });
    addIface(sid, 10, 101, 'Gi1/0/2', { desc: 'to nyc-esx-0101 vmnic0' });
    addIface(sid, 10, 102, 'Gi1/0/3', { desc: 'server nyc-esx-0101.icc.demo' });
    addIface(sid, 10, 103, 'Gi1/0/4', { desc: 'to esx9 vmnic1' });
    addIface(sid, 10, 104, 'Gi1/0/5', { desc: 'uplink to unknown-sw' });
    const res = lmPoller.buildTopologyLinks(db, sid);
    expect(res).toEqual({ links: 5, resolved: 1, resolvedIcc: 2, eri: { cdp: 0, lldp: 0, resolved: 0, neighborsResolvedByEri: 0 } });
    const rows = db.prepare('SELECT src_instance_id, dst_device_id, dst_platform, dst_ref, dst_name, dst_port, confidence FROM lm_topology_links ORDER BY src_instance_id').all();
    expect(rows).toEqual([
      { src_instance_id: 100, dst_device_id: 11, dst_platform: 'logicmonitor', dst_ref: null, dst_name: 'core-sw-01', dst_port: 'Gi1/0/49', confidence: 'high' },
      { src_instance_id: 101, dst_device_id: null, dst_platform: 'vcenter', dst_ref: 'nyc-esx-0101.icc.demo', dst_name: 'nyc-esx-0101', dst_port: 'vmnic0', confidence: 'high' },
      { src_instance_id: 102, dst_device_id: null, dst_platform: 'vcenter', dst_ref: 'nyc-esx-0101.icc.demo', dst_name: 'nyc-esx-0101.icc.demo', dst_port: null, confidence: 'medium' },
      { src_instance_id: 103, dst_device_id: null, dst_platform: null, dst_ref: null, dst_name: 'esx9', dst_port: null, confidence: 'low' },
      { src_instance_id: 104, dst_device_id: null, dst_platform: null, dst_ref: null, dst_name: 'unknown-sw', dst_port: null, confidence: 'low' },
    ]);
  });

  it('never resolves a token the LM index knows to another platform', () => {
    const idx = { exact: new Map([['core-sw-01', { platform: 'unifi', ref: 'core-sw-01' }]]), short: new Map() };
    const r = lmEndpoints.makeIccResolver(idx, new Map([['core-sw-01', 11]]));
    expect(r('core-sw-01')).toBeNull();
    expect(r('CORE-SW-01.acme.local')).toBeNull();
  });
});

describe('port normalisation (C2)', () => {
  const ifs = (...names) => names.map((n, k) => ({ instance_id: k + 1, display_name: n }));
  it('matches by display name, then by prefix plus slot path', () => {
    expect(lmEndpoints.matchPort('GigabitEthernet1/0/12', ifs('GigabitEthernet1/0/12'))).toMatchObject({ quality: 'exact' });
    expect(lmEndpoints.matchPort('Gi1/0/12', ifs('GigabitEthernet1/0/12', 'TenGigabitEthernet1/0/12')))
      .toMatchObject({ quality: 'port-number', iface: { display_name: 'GigabitEthernet1/0/12' } });
    expect(lmEndpoints.matchPort('GigabitEthernet1/0/12', ifs('Gi1/0/12'))).toMatchObject({ quality: 'port-number', iface: { instance_id: 1 } });
    expect(lmEndpoints.matchPort('Te1/1/1', ifs('Gi1/1/1', 'TenGigabitEthernet1/1/1'))).toMatchObject({ quality: 'port-number', iface: { instance_id: 2 } });
    expect(lmEndpoints.matchPort('Te1/1/1', ifs('Gi1/1/1'))).toEqual({ iface: null, quality: 'none' });
    expect(lmEndpoints.matchPort('Gi1/0/12 [ID:12]', ifs('Gi1/0/12'))).toMatchObject({ quality: 'exact' });
    expect(lmEndpoints.portParts('Ethernet1/5')).toEqual({ prefix: 'et', path: '1/5' });
  });
});

describe('endpoints join and server path (C2, C3)', () => {
  let sid;
  beforeEach(() => {
    wipe();
    const vcId = ensureVcenterFixtures();
    sid = insertSource();
    insertDevice(sid, { id: 10, display: 'nyc-acc-01', ips: ['10.0.5.1'] });
    insertDevice(sid, { id: 12, display: 'nyc-dist-01' });
    addIface(sid, 10, 100, 'GigabitEthernet1/0/3', { desc: 'to nyc-esx-0101 vmnic0', inUtil: 91, outUtil: 12, inErr: 2, outErr: 3 });
    addIface(sid, 10, 101, 'GigabitEthernet1/0/4');
    addIface(sid, 10, 102, 'TenGigabitEthernet1/1/1', { desc: 'to nyc-dist-01 Te1/0/1' });
    addIface(sid, 12, 200, 'TenGigabitEthernet1/0/1');
    lmPoller.buildTopologyLinks(db, sid);
    const hint = db.prepare(`INSERT INTO vcenter_host_nic_neighbors (vcenter_id, host_name, nic, protocol, switch_name, switch_port, switch_address)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    hint.run(vcId, 'nyc-esx-0101.icc.demo', 'vmnic0', 'cdp', 'nyc-acc-01', 'Gi1/0/3', '10.0.5.1');
    hint.run(vcId, 'nyc-esx-0101.icc.demo', 'vmnic1', 'lldp', 'nyc-acc-01.acme.local', 'GigabitEthernet1/0/4', null);
    hint.run(vcId, 'nyc-esx-0102.icc.demo', 'vmnic0', 'cdp', 'other-name', 'Gi1/0/48', '10.0.5.1');
    hint.run(vcId, 'nyc-esx-0103.icc.demo', 'vmnic0', 'cdp', 'not-in-lm', 'Gi1/0/9', null);
    db.prepare(`INSERT INTO lm_issue_history (issue_key, source, severity, type, target, message, status)
      VALUES ('interface-utilization-high|portal1|nyc-acc-01 GigabitEthernet1/0/3', 'portal1', 'warning', 'interface-utilization-high',
      'nyc-acc-01 GigabitEthernet1/0/3', 'nyc-acc-01 GigabitEthernet1/0/3 at 91% utilization for the last 3 samples (threshold 80%)', 'open')`).run();
    db.prepare("INSERT INTO lm_checks (source_id, check_id, kind, origin, name, target) VALUES (?, 'w:1', 'ping', 'website', 'Ping web01', '10.9.9.9')").run(sid);
    db.prepare(`INSERT INTO lm_check_locations (source_id, check_id, checkpoint_id, label, is_overall, last_status, last_rtt_ms, last_loss_pct, last_sample_epoch)
      VALUES (?, 'w:1', '70', 'col-nyc', 0, 'down', NULL, 100, ?)`).run(sid, Math.floor(Date.now() / 1000));
  });
  afterEach(() => clearVcenterFixtures());

  it('merges the description row with the CDP hint, matches by name, short name and address', () => {
    const rows = lmEndpoints.endpointsAll(db);
    const by = (port, ep) => rows.find((r) => r.port === port && String(r.endpoint).startsWith(ep));
    const p3 = by('GigabitEthernet1/0/3', 'nyc-esx-0101');
    expect(p3).toMatchObject({
      deviceId: 10, deviceName: 'nyc-acc-01', instanceId: 100, portStatusText: 'up', portInUtilPct: 91, portErrors: 5,
      endpointPlatform: 'vcenter', nic: 'vmnic0', protocol: 'description+cdp', confidence: 'high',
      origin: 'vcenter-hint', matchQuality: 'port-number', corroborated: true,
    });
    expect(by('GigabitEthernet1/0/4', 'nyc-esx-0101')).toMatchObject({ instanceId: 101, protocol: 'lldp', matchQuality: 'exact', confidence: 'high', nic: 'vmnic1' });
    // Address match on a switch name LM does not know; the port does not exist.
    expect(rows.find((r) => r.endpoint === 'nyc-esx-0102.icc.demo')).toMatchObject({ deviceId: 10, instanceId: null, matchQuality: 'none', port: 'Gi1/0/48' });
    expect(rows.some((r) => r.endpoint === 'nyc-esx-0103.icc.demo')).toBe(false);
    expect(rows).toHaveLength(3);
    expect(lmEndpoints.endpointsSummary(rows)).toEqual({ total: 3, corroborated: 1, byPlatform: [{ platform: 'vcenter', count: 3 }], unmatchedPorts: 1 });
    expect(lmEndpoints.endpointsForDevice(db, sid, 12)).toEqual([]);
  });

  it('serverPath for a VM inherits the host switch ports, carries the open issue, one uplink hop and the check', () => {
    const p = lmEndpoints.serverPath(db, { names: ['web01'], ips: [] });
    expect(p.anchor).toEqual({ name: 'web01', kind: 'vm', hostName: 'nyc-esx-0101.icc.demo' });
    expect(p.switchPorts).toHaveLength(2);
    const p3 = p.switchPorts.find((s) => s.instanceId === 100);
    expect(p3).toMatchObject({ deviceName: 'nyc-acc-01', port: 'GigabitEthernet1/0/3', statusText: 'up', inUtilPct: 91, errors: 5, nic: 'vmnic0', source: 'vcenter-hint', tone: 'warn' });
    expect(p3.issues).toEqual([expect.objectContaining({ type: 'interface-utilization-high', severity: 'warning' })]);
    expect(p.uplinks).toEqual([expect.objectContaining({
      from: { deviceId: 10, deviceName: 'nyc-acc-01', port: 'TenGigabitEthernet1/1/1' },
      to: { deviceId: 12, deviceName: 'nyc-dist-01', port: 'Te1/0/1' }, statusText: 'up', tone: 'ok',
    })]);
    expect(p.checks).toHaveLength(1);
    expect(p.checks[0]).toMatchObject({ checkId: 'w:1', name: 'Ping web01', target: '10.9.9.9' });
    expect(p.checks[0].locations[0]).toMatchObject({ label: 'col-nyc', anomaly: 'down' });
    expect(lmEndpoints.checkTone(lmEndpoints.worstLocation(p.checks[0]))).toBe('crit');
  });

  it('serverPath for an unknown name is empty and never throws', () => {
    expect(lmEndpoints.serverPath(db, { names: ['no-such-host'], ips: [] }))
      .toEqual({ anchor: { name: 'no-such-host', kind: 'device', hostName: null }, switchPorts: [], uplinks: [], checks: [] });
    expect(lmEndpoints.serverPath({ prepare() { throw new Error('boom'); } }, { names: ['x'] }).switchPorts).toEqual([]);
  });

  it('topology hook for a VM anchor draws host-to-switch uplinks, the switch hop and the reachability edge', () => {
    const manifest = require('../platforms/logicmonitor');
    const g = manifest.topology({ db }, { names: ['web01'], ips: ['10.9.9.9'], anchorId: 'vm:web01' });
    expect(g.nodes.map((n) => n.id).sort()).toEqual([`lm-check:${sid}:w:1`, `lm-device:${sid}:10`, `lm-device:${sid}:12`]);
    const up = g.edges.filter((e) => e.kind === 'uplink');
    expect(up.every((e) => e.from === 'host:nyc-esx-0101.icc.demo' && e.to === `lm-device:${sid}:10`)).toBe(true);
    expect(up.find((e) => e.label === 'vmnic0 - GigabitEthernet1/0/3')).toMatchObject({ status: 'warn' });
    expect(up.find((e) => e.label === 'vmnic1 - GigabitEthernet1/0/4').status).toBeUndefined();
    expect(g.edges.find((e) => e.kind === 'link')).toMatchObject({ from: `lm-device:${sid}:10`, to: `lm-device:${sid}:12`, label: 'TenGigabitEthernet1/1/1 - Te1/0/1' });
    expect(g.edges.find((e) => e.kind === 'reachability')).toMatchObject({ from: 'vm:web01', status: 'crit', issue: 'Ping web01 from col-nyc: down' });
  });

  it('server360 adds a network path group with switch ports and the check', () => {
    const manifest = require('../platforms/logicmonitor');
    const s = manifest.server360({ db }, { names: new Set(['web01']), ips: new Set(['10.9.9.9']) });
    const g = s.groups[s.groups.length - 1];
    expect(g.lines).toContain('Switch port: nyc-acc-01 GigabitEthernet1/0/3 (up, in 91% out 12%)');
    expect(g.lines.some((l) => l.startsWith('Reachability: Ping web01 from col-nyc'))).toBe(true);
    expect(g.facts.find((f) => f.value === 'nyc-acc-01 GigabitEthernet1/0/3').tone).toBe('warn');
    expect(g.facts.find((f) => f.label === 'Reachability').tone).toBe('crit');
  });
});

// ---- Round 3: sites, path and blame, suppression, circuits, baselines ---------

const lmSites = require('../services/logicmonitorSites');
const lmPath = require('../services/logicmonitorPath');
const { setSetting } = require('../services/settings');

const HOUR_MS = 3600000;
const sqlStamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/**
 * phx-acc-01 (1) -> phx-dist-01 (2) -> core-sw-01 (3) -> phx-rtr-01 (4), and
 * the VM web01 on nyc-esx-0101.icc.demo plugged into phx-acc-01 Gi1/0/5 by a
 * CDP hint. web01 is also an LM server device (5).
 */
function seedPathEstate() {
  wipe();
  db.prepare("DELETE FROM app_settings WHERE key LIKE 'lm_%'").run();
  const sid = insertSource();
  const vcId = ensureVcenterFixtures();
  const grp = db.prepare('INSERT INTO lm_device_groups (source_id, lm_group_id, name, full_path, stale) VALUES (?, ?, ?, ?, 0)');
  grp.run(sid, 1, 'Phoenix', 'Network/Branch/Phoenix');
  grp.run(sid, 2, 'Core', 'Network/Core');
  insertDevice(sid, { id: 1, display: 'phx-acc-01', role: 'switch', ips: ['10.1.1.1'] });
  insertDevice(sid, { id: 2, display: 'phx-dist-01', role: 'switch' });
  insertDevice(sid, { id: 3, display: 'core-sw-01', role: 'switch' });
  insertDevice(sid, { id: 4, display: 'phx-rtr-01', role: 'router' });
  insertDevice(sid, { id: 5, display: 'web01', network: 0, role: 'server', vendor: null, ips: ['10.9.9.9'] });
  db.prepare("UPDATE lm_devices SET group_ids_json = '[1]' WHERE source_id = ? AND lm_device_id IN (1, 2, 4)").run(sid);
  db.prepare("UPDATE lm_devices SET group_ids_json = '[2]' WHERE source_id = ? AND lm_device_id = 3").run(sid);
  addIface(sid, 1, 11, 'GigabitEthernet1/0/5', { inUtil: 5, outUtil: 3 });
  addIface(sid, 1, 12, 'Gi1/0/48');
  addIface(sid, 2, 20, 'Gi1/0/1');
  addIface(sid, 2, 21, 'Te1/1/1');
  addIface(sid, 3, 30, 'Te1/0/1');
  addIface(sid, 3, 31, 'Te1/0/9');
  addIface(sid, 4, 40, 'Gi0/0/1', { desc: 'WAN Zayo circuit 12345 to Dallas' });
  addIface(sid, 4, 41, 'Gi0/0/2', { desc: 'to hq-x' });
  addIface(sid, 4, 42, 'Gi0/0/3', { desc: 'LAN' });
  const link = (src, inst, port, dst, dport) => db.prepare(`
    INSERT INTO lm_topology_links (source_id, src_device_id, src_instance_id, src_port, dst_device_id, dst_port, protocol, confidence, dst_platform)
    VALUES (?, ?, ?, ?, ?, ?, 'description', 'high', ?)
  `).run(sid, src, inst, port, dst, dport, dst == null ? null : 'logicmonitor');
  link(1, 12, 'Gi1/0/48', 2, 'Gi1/0/1');
  link(2, 21, 'Te1/1/1', 3, 'Te1/0/1');
  link(3, 31, 'Te1/0/9', 4, 'Gi0/0/1');
  link(4, 41, 'Gi0/0/2', null, null);
  db.prepare(`INSERT INTO vcenter_host_nic_neighbors (vcenter_id, host_name, nic, protocol, switch_name, switch_port)
    VALUES (?, 'nyc-esx-0101.icc.demo', 'vmnic0', 'cdp', 'phx-acc-01', 'Gi1/0/5')`).run(vcId);
  lmPath.computeTiers(db, sid);
  return sid;
}

const setIfStatus = (sid, iid, text) => db.prepare('UPDATE lm_interfaces SET status = ?, status_text = ? WHERE source_id = ? AND instance_id = ?')
  .run(text === 'down' ? 2 : 1, text, sid, iid);

describe('round 3: sites (C1)', () => {
  afterEach(() => { clearVcenterFixtures(); });

  it('derives sites from group paths, properties and hostname prefixes; collector majority; check target', () => {
    const sid = seedPathEstate();
    insertDevice(sid, { id: 6, display: 'den-sw-01', role: 'switch' });
    insertDevice(sid, { id: 7, display: 'lonely', network: 0, role: 'server', vendor: null });
    insertDevice(sid, { id: 8, display: 'plain', network: 0, role: 'server', vendor: null });
    db.prepare('UPDATE lm_devices SET custom_props_json = ? WHERE source_id = ? AND lm_device_id = 7').run(JSON.stringify([{ name: 'site', value: 'Boston' }]), sid);
    db.prepare('UPDATE lm_devices SET collector_id = 1 WHERE source_id = ? AND lm_device_id IN (1, 2, 7)').run(sid);
    db.prepare("INSERT INTO lm_collectors (source_id, collector_id, hostname, stale) VALUES (?, 1, 'phx-col01', 0)").run(sid);
    db.prepare("INSERT INTO lm_checks (source_id, check_id, kind, origin, name, target, is_internal, stale) VALUES (?, 'w:1', 'ping', 'website', 'Ping app', '10.1.1.1', 1, 0)").run(sid);
    db.prepare("INSERT INTO lm_check_locations (source_id, check_id, checkpoint_id, label, collector_id, stale) VALUES (?, 'w:1', 'c1', 'phx-col01', 1, 0)").run(sid);

    const r = lmSites.computeSites(db, sid);
    const site = (id) => db.prepare('SELECT site_key, site_name, site_source FROM lm_devices WHERE source_id = ? AND lm_device_id = ?').get(sid, id);
    expect(site(1)).toEqual({ site_key: 'phoenix', site_name: 'Phoenix', site_source: 'group' });
    expect(site(3).site_key).toBe('core'); // "Network/Core": the segment after the root Network
    expect(site(6)).toEqual({ site_key: 'den', site_name: 'den', site_source: 'hostname' });
    expect(site(7)).toEqual({ site_key: 'boston', site_name: 'Boston', site_source: 'property' });
    expect(site(8).site_key).toBe(null);
    expect(r.devicesNoSite).toBeGreaterThanOrEqual(2);
    // collector 1 serves two phoenix devices and one boston device: phoenix wins
    expect(db.prepare('SELECT site_key FROM lm_collectors WHERE source_id = ? AND collector_id = 1').get(sid).site_key).toBe('phoenix');
    expect(db.prepare("SELECT site_key FROM lm_checks WHERE source_id = ? AND check_id = 'w:1'").get(sid).site_key).toBe('phoenix');
    expect(db.prepare("SELECT site_key FROM lm_check_locations WHERE source_id = ? AND check_id = 'w:1'").get(sid).site_key).toBe('phoenix');
    const row = db.prepare("SELECT * FROM lm_sites WHERE source_id = ? AND site_key = 'phoenix'").get(sid);
    expect(row.device_count).toBe(3);
    expect(row.network_count).toBe(3);
    expect(JSON.parse(row.collector_ids_json)).toEqual([1]);
    // roots from the per-portal rule replace the defaults
    db.prepare('UPDATE lm_sources SET site_rule_json = ? WHERE id = ?').run(JSON.stringify({ roots: ['Branch'], property: 'site', fromHostname: false }), sid);
    lmSites.computeSites(db, sid);
    expect(site(3).site_key).toBe(null);
    expect(site(6).site_key).toBe(null);
    expect(site(1).site_key).toBe('phoenix');
  });

  it('siteOf resolves a device name, an ip, and a server through its CDP switch', () => {
    const sid = seedPathEstate();
    lmSites.computeSites(db, sid);
    expect(lmSites.siteOf(db, { names: ['phx-dist-01'] })).toMatchObject({ siteKey: 'phoenix', sourceId: sid });
    expect(lmSites.siteOf(db, { ips: ['10.1.1.1'] }).siteKey).toBe('phoenix');
    expect(lmSites.siteOf(db, { names: ['web01'] }).siteKey).toBe('phoenix');
    expect(lmSites.siteOf(db, { names: ['nobody'] })).toBe(null);
    expect(lmSites.slug('  New York / HQ ')).toBe('new-york-hq');
  });
});

describe('round 3: tiers, path and blame (C2)', () => {
  afterEach(() => { clearVcenterFixtures(); });

  it('ranks tiers and builds the four hop path from the server', () => {
    const sid = seedPathEstate();
    const tier = (id) => db.prepare('SELECT tier FROM lm_devices WHERE source_id = ? AND lm_device_id = ?').get(sid, id).tier;
    expect([1, 2, 3, 4, 5].map(tier)).toEqual([1, 2, 3, 4, null]);
    const path = lmPath.pathFor(db, { names: ['web01'], ips: ['10.9.9.9'] });
    expect(path.map((h) => h.deviceName)).toEqual(['phx-acc-01', 'phx-dist-01', 'core-sw-01', 'phx-rtr-01']);
    expect(path[0].inPort.display).toBe('GigabitEthernet1/0/5');
    expect(path[0].outPort.display).toBe('Gi1/0/48');
    expect(path[1].inPort.display).toBe('Gi1/0/1');
    expect(path[3].tier).toBe(4);
    expect(path.every((h) => h.health.state === 'ok')).toBe(true);
    expect(lmPath.blame(path)).toBe(null);
    // an LM network device as the anchor starts the chain at itself
    expect(lmPath.pathFor(db, { names: ['phx-dist-01'] }).map((h) => h.deviceName)).toEqual(['phx-dist-01', 'core-sw-01', 'phx-rtr-01']);
    // unknown host: empty, never a throw
    expect(lmPath.pathFor(db, { names: ['nobody'] })).toEqual([]);
  });

  it('blame prefers a critical hop over an earlier warning, and falls back to the warning', () => {
    const sid = seedPathEstate();
    db.prepare("INSERT INTO lm_issue_history (issue_key, source, severity, type, target, message, status) VALUES ('k', 'portal1', 'warning', 'interface-errors-growing', 'phx-acc-01 GigabitEthernet1/0/5', '120 errors in 24 h', 'open')").run();
    setIfStatus(sid, 21, 'down');
    const path = lmPath.pathFor(db, { names: ['web01'] });
    expect(path[0].health).toMatchObject({ state: 'warning', kind: 'issue' });
    expect(path[1].health).toMatchObject({ state: 'critical', kind: 'port-down', port: 'Te1/1/1' });
    expect(lmPath.blame(path)).toMatchObject({ deviceName: 'phx-dist-01', port: 'Te1/1/1', state: 'critical', hopIndex: 1 });
    setIfStatus(sid, 21, 'up');
    const warnOnly = lmPath.blame(lmPath.pathFor(db, { names: ['web01'] }));
    expect(warnOnly).toMatchObject({ deviceName: 'phx-acc-01', port: 'GigabitEthernet1/0/5', state: 'warning', hopIndex: 0 });
    expect(warnOnly.reason).toBe('120 errors in 24 h');
  });

  it('a dead device and a severity 4 alert make a hop critical', () => {
    const sid = seedPathEstate();
    db.prepare("UPDATE lm_devices SET host_status = 'dead', dead_since = ? WHERE source_id = ? AND lm_device_id = 3").run(sqlStamp(Date.now() - 2 * HOUR_MS), sid);
    const b = lmPath.blame(lmPath.pathFor(db, { names: ['web01'] }));
    expect(b).toMatchObject({ deviceName: 'core-sw-01', state: 'critical', kind: 'dead', hopIndex: 2 });
    expect(b.since).toMatch(/Z$/);
    db.prepare("UPDATE lm_devices SET host_status = 'normal', dead_since = NULL WHERE source_id = ? AND lm_device_id = 3").run(sid);
    db.prepare("INSERT INTO lm_alerts (source_id, lm_alert_id, severity, severity_norm, lm_device_id, monitor_object_name, resource_template_name, cleared, condition_key, start_epoch) VALUES (?, 'DS9', 4, 'critical', 2, 'phx-dist-01', 'Cisco_CPU_SNMP', 0, 'k9', ?)").run(sid, Math.floor(Date.now() / 1000) - 600);
    const c = lmPath.blame(lmPath.pathFor(db, { names: ['web01'] }));
    expect(c).toMatchObject({ deviceName: 'phx-dist-01', kind: 'alert', state: 'critical' });
  });

  it('blameForCheck points a check at the down uplink on the target side', () => {
    const sid = seedPathEstate();
    lmSites.computeSites(db, sid);
    db.prepare("INSERT INTO lm_checks (source_id, check_id, kind, origin, name, target, is_internal, stale) VALUES (?, 'w:1', 'ping', 'website', 'Ping web01', '10.9.9.9', 0, 0)").run(sid);
    db.prepare("INSERT INTO lm_check_locations (source_id, check_id, checkpoint_id, label, is_overall, last_status, last_rtt_ms, last_loss_pct, last_sample_epoch, stale) VALUES (?, 'w:1', 'c1', 'Dallas', 0, 'up', 100, 0, ?, 0)")
      .run(sid, Math.floor(Date.now() / 1000));
    setIfStatus(sid, 21, 'down');
    const b = lmPath.blameForCheck(db, 'w:1', 'c1', { sourceId: sid });
    expect(b).toMatchObject({ deviceName: 'phx-dist-01', port: 'Te1/1/1', side: 'target' });
    expect(lmPath.likelyHopText(b)).toContain('Likely hop: phx-dist-01 Te1/1/1, port Te1/1/1 on phx-dist-01 is down');
    expect(lmPath.blameForCheck(db, 'no-such-check', null)).toBe(null);
  });
});

describe('round 3: dependency suppression (C3)', () => {
  afterEach(() => { clearVcenterFixtures(); });

  const alertFor = (sid, id, dev, name, ds) => lmPoller.upsertAlertRow(db, sid, {
    id, internalId: `LMD${id}`, severity: 4, monitorObjectType: 'device', monitorObjectId: dev, monitorObjectName: name,
    resourceTemplateName: ds, instanceName: 'HostStatus', dataPointName: 'idleInterval', startEpoch: Math.floor(Date.now() / 1000) - 300, cleared: false,
  });
  const shadow = (sid, id) => JSON.parse(db.prepare('SELECT shadowed_by FROM lm_alerts WHERE source_id = ? AND lm_alert_id = ?').get(sid, id).shadowed_by || 'null');

  it('shadows alerts behind a down uplink, leaves the culprit loud, clears on recovery and when disabled', () => {
    const sid = seedPathEstate();
    alertFor(sid, 'DS1', 5, 'web01', 'Host Status');
    alertFor(sid, 'DS2', 1, 'phx-acc-01', 'Host Status');
    alertFor(sid, 'DS3', 2, 'phx-dist-01', 'Host Status');
    expect(shadow(sid, 'DS1')).toBe(null);
    setIfStatus(sid, 21, 'down');
    const r = lmIssues.computeShadows(db);
    expect(r.shadowed).toBe(2);
    expect(shadow(sid, 'DS1')).toMatchObject({ deviceId: 2, deviceName: 'phx-dist-01', port: 'Te1/1/1', reason: 'port-down' });
    expect(shadow(sid, 'DS2')).toMatchObject({ deviceName: 'phx-dist-01' });
    expect(shadow(sid, 'DS3')).toBe(null);
    // collectAlerts: shadowed alerts are gone, the culprit says how many it hides
    const manifest = require('../platforms/logicmonitor');
    const items = manifest.collectAlerts({ db });
    const hostStatus = items.filter((i) => i.type === 'Host Status');
    expect(hostStatus.map((i) => i.host)).toEqual(['phx-dist-01']);
    expect(hostStatus[0].message).toContain('+2 downstream shadowed');
    // recovery clears the flag
    setIfStatus(sid, 21, 'up');
    lmIssues.computeShadows(db);
    expect(shadow(sid, 'DS1')).toBe(null);
    expect(shadow(sid, 'DS2')).toBe(null);
    // disabled: nothing is shadowed even with the port down
    setIfStatus(sid, 21, 'down');
    setSetting('lm_shadow_enabled', '0');
    expect(lmIssues.computeShadows(db).shadowed).toBe(0);
    expect(shadow(sid, 'DS1')).toBe(null);
  });

  it('a dead switch shadows the device-dead issues behind it and reads +N on its own', () => {
    const sid = seedPathEstate();
    const ago = sqlStamp(Date.now() - HOUR_MS);
    db.prepare("UPDATE lm_devices SET host_status = 'dead', dead_since = ? WHERE source_id = ? AND lm_device_id IN (1, 2)").run(ago, sid);
    alertFor(sid, 'DS2', 1, 'phx-acc-01', 'Host Status');
    lmIssues.computeShadows(db);
    const dead = lmIssues.computeIssues().filter((i) => i.type === 'device-dead');
    const acc = dead.find((i) => i.target === 'phx-acc-01');
    const dist = dead.find((i) => i.target === 'phx-dist-01');
    expect(acc.severity).toBe('info');
    expect(acc.message).toContain('(shadowed by phx-dist-01)');
    expect(dist.severity).toBe('critical');
    expect(dist.message).toContain('+2 downstream shadowed'); // the acc device-dead issue and the DS2 alert
    // the shadowed issue stays in the history but collectAlerts skips it
    lmIssues.reconcileIssueHistory();
    const keys = require('../platforms/logicmonitor').collectAlerts({ db }).map((i) => i.sourceKey);
    expect(keys.some((k) => k.includes('device-dead|') && k.includes('phx-acc-01'))).toBe(false);
    expect(keys.some((k) => k.includes('device-dead|') && k.includes('phx-dist-01'))).toBe(true);
  });

  it('upsertAlertRow shares the polled condition key and closes on a cleared status', () => {
    const sid = seedPathEstate();
    const out = alertFor(sid, 'DS7', 5, 'Web01', 'Host Status');
    expect(out.conditionKey).toBe(`lm:${sid}:web01:Host Status:HostStatus:idleInterval`);
    expect(out.conditionKey).toBe(lmApi.conditionKey(sid, { monitorObjectName: 'WEB01', resourceTemplateName: 'Host Status', instanceName: 'HostStatus', dataPointName: 'idleInterval' }));
    let row = db.prepare("SELECT * FROM lm_alerts WHERE lm_alert_id = 'DS7'").get();
    expect(row).toMatchObject({ ingest: 'webhook', cleared: 0, severity_norm: 'critical', lm_device_id: 5 });
    lmPoller.upsertAlertRow(db, sid, { id: 'DS7', severity: 4, monitorObjectType: 'device', monitorObjectId: 5, monitorObjectName: 'Web01', resourceTemplateName: 'Host Status', instanceName: 'HostStatus', dataPointName: 'idleInterval', cleared: true, endEpoch: Math.floor(Date.now() / 1000) });
    row = db.prepare("SELECT * FROM lm_alerts WHERE lm_alert_id = 'DS7'").get();
    expect(row).toMatchObject({ cleared: 1, closed_reason: 'cleared', ingest: 'webhook' });
    expect(row.end_epoch).toBeGreaterThan(0);
    expect(lmPoller.upsertAlertRow(db, sid, {})).toBe(null);
  });
});

describe('round 3: circuits (C4)', () => {
  afterEach(() => { clearVcenterFixtures(); db.prepare("DELETE FROM app_settings WHERE key = 'lm_wan_overrides'").run(); });

  it('marks WAN interfaces by description, unresolved uplink and overrides', () => {
    const sid = seedPathEstate();
    expect(lmPath.computeCircuits(db, sid).marked).toBe(2);
    const wan = (id) => db.prepare('SELECT is_wan, wan_reason, wan_label FROM lm_interfaces WHERE source_id = ? AND instance_id = ?').get(sid, id);
    expect(wan(40)).toEqual({ is_wan: 1, wan_reason: 'carrier-description', wan_label: 'WAN Zayo circuit 12345 to Dallas' });
    expect(wan(41)).toMatchObject({ is_wan: 1, wan_reason: 'unresolved-uplink' });
    expect(wan(42).is_wan).toBe(0);
    setSetting('lm_wan_overrides', 'phx-rtr-01:Gi0/0/3, !phx-rtr-01:Gi0/0/1');
    lmPath.computeCircuits(db, sid);
    expect(wan(42)).toMatchObject({ is_wan: 1, wan_reason: 'override' });
    expect(wan(40).is_wan).toBe(0);
    expect(lmPath.parseWanOverrides('a:b,!c:d')).toEqual([{ device: 'a', port: 'b', exclude: false }, { device: 'c', port: 'd', exclude: true }]);
  });

  it('computes p95, headroom and the saturation state; three days at the peak is critical', () => {
    const sid = seedPathEstate();
    lmPath.computeCircuits(db, sid);
    const h = db.prepare('INSERT INTO lm_interface_history (source_id, instance_id, captured_at, status, in_util_pct, out_util_pct, in_errors, out_errors) VALUES (?, 40, ?, 1, ?, 10, 1, 0)');
    for (let i = 1; i <= 20; i += 1) h.run(sid, sqlStamp(Date.now() - i * 30 * 60000), 65 + i);
    let row = lmPath.circuitRows(db, { sourceId: sid }).find((c) => c.instanceId === 40);
    expect(row).toMatchObject({ p95InPct: 84, p95OutPct: 10, headroomPct: 16, satState: 'warning', state: 'warning', deviceName: 'phx-rtr-01', port: 'Gi0/0/1' });
    expect(row.errors24h).toBe(20);
    const d = db.prepare('INSERT INTO lm_interface_daily (source_id, instance_id, day, max_in_util_pct, max_out_util_pct) VALUES (?, 40, ?, 96, 20)');
    for (const k of [1, 2, 3]) d.run(sid, new Date(Date.now() - k * 86400000).toISOString().slice(0, 10));
    row = lmPath.circuitRows(db, { sourceId: sid }).find((c) => c.instanceId === 40);
    expect(row).toMatchObject({ satState: 'critical', maxDailyPct: 96, critDays: 3 });
    const issue = lmIssues.computeIssues().find((i) => i.type === 'circuit-saturated');
    expect(issue).toMatchObject({ severity: 'critical', target: 'phx-rtr-01 Gi0/0/1' });
    expect(issue.message).toContain('p95 84% over 7 days');
    const profile = lmPath.circuitProfile(db, 40);
    expect(profile.hours).toHaveLength(24);
    expect(profile.daily).toHaveLength(3);
    expect(profile.daily[0]).toHaveProperty('maxInPct', 96);
    expect(lmPath.circuitProfile(db, 99999)).toBe(null);
    expect(lmPath.longestDayRun(['2026-10-01', '2026-10-02', '2026-10-04', '2026-10-05', '2026-10-06'])).toBe(3);
    expect(lmPath.p95([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(10);
  });
});

describe('round 3: interface baselines and anomalies (C5)', () => {
  afterEach(() => { clearVcenterFixtures(); });

  function seedHistory(sid) {
    const h = db.prepare('INSERT INTO lm_interface_history (source_id, instance_id, captured_at, status, in_util_pct, out_util_pct, in_errors, out_errors) VALUES (?, 11, ?, 1, ?, 1, 0, 0)');
    // 72 hourly samples: each UTC hour of day gets three, valued 10, 11 and 12
    for (let j = 1; j <= 72; j += 1) h.run(sid, sqlStamp(Date.now() - j * HOUR_MS), 10 + Math.floor((j - 1) / 24));
  }

  it('computes hour of day median and MAD; skips interfaces under the minimum', () => {
    const sid = seedPathEstate();
    seedHistory(sid);
    expect(lmPoller.computeInterfaceBaselines(db, sid)).toBe(24);
    const hour = new Date().getUTCHours();
    const b = db.prepare('SELECT * FROM lm_interface_baseline WHERE source_id = ? AND instance_id = 11 AND hour_of_day = ?').get(sid, hour);
    expect(b).toMatchObject({ samples: 3, util_median: 11, util_mad: 1, err_median: 0, err_mad: 0 });
    setSetting('lm_if_baseline_min_samples', '100');
    expect(lmPoller.computeInterfaceBaselines(db, sid)).toBe(0);
    setSetting('lm_if_baseline_min_samples', '48');
  });

  it('raises interface-util-anomaly and interface-error-anomaly on the last 3 samples', () => {
    const sid = seedPathEstate();
    seedHistory(sid);
    lmPoller.computeInterfaceBaselines(db, sid);
    const h = db.prepare('INSERT INTO lm_interface_history (source_id, instance_id, captured_at, status, in_util_pct, out_util_pct, in_errors, out_errors) VALUES (?, 11, ?, 1, 60, 1, ?, 0)');
    for (let m = 1; m <= 3; m += 1) h.run(sid, sqlStamp(Date.now() - m * 60000), 50);
    const issues = lmIssues.computeIssues();
    const util = issues.find((i) => i.type === 'interface-util-anomaly');
    expect(util.target).toBe('phx-acc-01 GigabitEthernet1/0/5');
    expect(util.message).toContain('baseline 11 +/- 1%');
    expect(issues.some((i) => i.type === 'interface-error-anomaly')).toBe(true);
    expect(issues.some((i) => i.type === 'interface-utilization-high')).toBe(false); // 60% is under the static 80%
    setSetting('lm_if_anomaly_util_min_pct', '90');
    expect(lmIssues.computeIssues().some((i) => i.type === 'interface-util-anomaly')).toBe(false);
    db.prepare("DELETE FROM app_settings WHERE key = 'lm_if_anomaly_util_min_pct'").run();
  });

  it('backup windows join a Cohesity run to the host port and compare with the run mean', () => {
    const sid = seedPathEstate();
    db.exec(`
      CREATE TABLE IF NOT EXISTS clusters (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE IF NOT EXISTS protection_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, cluster_id INTEGER, job_id INTEGER, job_name TEXT, status TEXT, start_time TEXT, end_time TEXT);
      CREATE TABLE IF NOT EXISTS cohesity_objects (id INTEGER PRIMARY KEY AUTOINCREMENT, cluster_id INTEGER, name TEXT, protection_groups TEXT);
    `);
    const clusterId = db.prepare("INSERT INTO clusters (name, connection_type, auth_type, encrypted_credentials) VALUES ('cg-clu1', 'direct', 'apikey', 'x')").run().lastInsertRowid;
    const start = Date.now() - 3 * HOUR_MS;
    const end = Date.now() - 2 * HOUR_MS;
    const runId = db.prepare("INSERT INTO protection_runs (cluster_id, job_id, job_name, status, start_time, end_time) VALUES (?, 77, 'VM_Prod', 'kSuccess', ?, ?)")
      .run(clusterId, new Date(start).toISOString(), new Date(end).toISOString()).lastInsertRowid;
    const objId = db.prepare("INSERT INTO cohesity_objects (cluster_id, name, protection_groups) VALUES (?, 'web01', ?)").run(clusterId, JSON.stringify(['VM_Prod'])).lastInsertRowid;
    try {
      const h = db.prepare('INSERT INTO lm_interface_history (source_id, instance_id, captured_at, status, in_util_pct, out_util_pct) VALUES (?, 11, ?, 1, ?, 5)');
      for (const m of [10, 20, 30, 40]) h.run(sid, sqlStamp(start + m * 60000), 85);
      const w = lmEndpoints.backupWindows(db);
      expect(w).toHaveLength(1);
      expect(w[0]).toMatchObject({ jobName: 'VM_Prod', cluster: 'cg-clu1', objectName: 'web01', host: 'nyc-esx-0101.icc.demo', deviceName: 'phx-acc-01', port: 'GigabitEthernet1/0/5', meanUtilPct: 85, status: 'kSuccess', finding: 'saturates' });
      // under the saturation line and no baseline: not a finding
      db.prepare('UPDATE lm_interface_history SET in_util_pct = 30 WHERE instance_id = 11').run();
      expect(lmEndpoints.backupWindows(db)).toEqual([]);
    } finally {
      db.prepare('DELETE FROM protection_runs WHERE id = ?').run(runId);
      db.prepare('DELETE FROM cohesity_objects WHERE id = ?').run(objId);
      db.prepare('DELETE FROM clusters WHERE id = ?').run(clusterId);
    }
  });
});

describe('round 3: manifest seams (C6)', () => {
  afterEach(() => { clearVcenterFixtures(); });

  it('exposes three read-only database capabilities that pass the host validator', () => {
    const manifest = require('../platforms/logicmonitor');
    expect(manifest.agentCapabilities.map((c) => c.id)).toEqual(['lm_port_history', 'lm_sdt_lookup', 'lm_path_blame', 'lm_latency_watch', 'lm_ds_data']);
    for (const c of manifest.agentCapabilities) {
      expect(/^[a-z0-9_-]{2,40}$/.test(c.id)).toBe(true);
      expect(c.risk).toBe(c.id === 'lm_ds_data' ? 'platform-api' : 'read-only');
      expect(typeof c.run).toBe('function');
    }
    expect(manifest.navSections).toEqual(expect.arrayContaining(['sites', 'circuits']));
  });

  it('capabilities read stored rows: port history, SDT and path blame', () => {
    const sid = seedPathEstate();
    lmSites.computeSites(db, sid);
    db.prepare('INSERT INTO lm_interface_history (source_id, instance_id, captured_at, status, in_util_pct, out_util_pct) VALUES (?, 11, ?, 1, 42, 7)').run(sid, sqlStamp(Date.now() - 600000));
    const caps = Object.fromEntries(require('../platforms/logicmonitor').agentCapabilities.map((c) => [c.id, c]));
    const target = { kind: 'host', platform: 'logicmonitor', name: 'web01', address: '10.9.9.9' };
    const ph = caps.lm_port_history.run(target);
    expect(ph.ok).toBe(true);
    expect(ph.summary).toContain('phx-acc-01 GigabitEthernet1/0/5');
    expect(ph.summary).toContain('in 42% out 7%');
    expect(caps.lm_sdt_lookup.run(target).summary).toBe('no scheduled downtime');
    db.prepare("INSERT INTO lm_sdts (source_id, sdt_id, sdt_type, is_effective, start_ms, end_ms, comment, lm_device_id, stale) VALUES (?, 's1', 'DeviceSDT', 1, ?, ?, 'switch upgrade', 1, 0)")
      .run(sid, Date.now() - HOUR_MS, Date.now() + HOUR_MS);
    const sdt = caps.lm_sdt_lookup.run(target);
    expect(sdt.summary).toContain('switch phx-acc-01: in maintenance until');
    expect(sdt.summary).toContain('(switch upgrade)');
    setIfStatus(sid, 21, 'down');
    const pb = caps.lm_path_blame.run(target);
    expect(pb.ok).toBe(true);
    expect(pb.summary).toContain('blame: Likely hop: phx-dist-01 Te1/1/1');
    expect(caps.lm_port_history.run({ name: 'nobody', address: null }).ok).toBe(false);
  });

  it('lm_ds_data reads the alerting datasource of the matched device and names unknown shapes', async () => {
    const sid = seedPathEstate();
    const cap = require('../platforms/logicmonitor').agentCapabilities.find((c) => c.id === 'lm_ds_data');
    expect(cap).toMatchObject({ risk: 'platform-api', defaultEnabled: false, timeoutMs: 8000, deepOnly: true, platform: '*' });
    db.prepare("INSERT INTO lm_device_datasources (source_id, lm_device_id, hds_id, datasource_name) VALUES (?, 5, 501, 'WinCPU'), (?, 5, 502, 'Disk')").run(sid, sid);
    db.prepare("INSERT INTO lm_alerts (source_id, lm_alert_id, lm_device_id, resource_template_name, cleared, start_epoch, condition_key) VALUES (?, 'a1', 5, 'Disk', 0, 100, 'k1')").run(sid);
    let seen = null;
    lmApi._setTransport(async (cfg) => { seen = cfg; return { status: 200, data: { dataPoints: ['Used', 'Free'], values: [[10, 90], [30, 70], ['No Data', null]], time: [1, 2, 3] }, headers: {} }; });
    const target = { kind: 'host', platform: 'vcenter', name: 'WEB01', address: '10.9.9.9' };
    const ok = await cap.run(target, { alerts: [{ first_seen: '2026-10-27 10:00:00' }] });
    expect(String(seen.url)).toContain('/device/devices/5/devicedatasources/502/data');
    expect(ok.ok).toBe(true);
    expect(ok.data.lines[0]).toBe('Used: last 30, min 10, max 30 over the window');
    expect(ok.data.lines.length).toBeLessThanOrEqual(8);
    lmApi._setTransport(async () => ({ status: 200, data: { surprise: 1, other: 2 }, headers: {} }));
    const bad = await cap.run(target, { alerts: [] });
    expect(bad.ok).toBe(false);
    expect(bad.summary).toContain('surprise, other');
    expect((await cap.run({ name: 'nobody', address: null }, {})).ok).toBe(false);
  });

  it('incidentEvidence for a VM anchor names the likely hop, ports, site and changes; siteOf wraps the resolver', () => {
    const sid = seedPathEstate();
    lmSites.computeSites(db, sid);
    setIfStatus(sid, 21, 'down');
    const manifest = require('../platforms/logicmonitor');
    const ev = manifest.incidentEvidence({ db }, { names: ['web01'], ips: ['10.9.9.9'] });
    expect(ev.title).toBe('LogicMonitor network');
    expect(ev.lines[0]).toMatch(/^Likely hop: phx-dist-01 Te1\/1\/1/);
    expect(ev.lines.some((l) => l.startsWith('Switch port phx-acc-01 GigabitEthernet1/0/5'))).toBe(true);
    expect(ev.lines.some((l) => l.startsWith('Site Phoenix: '))).toBe(true);
    expect(ev.lines.length).toBeLessThanOrEqual(40);
    expect(manifest.incidentEvidence({ db }, { names: ['nobody'] })).toBe(null);
    expect(manifest.siteOf({ db }, { names: ['web01'] })).toMatchObject({ siteKey: 'phoenix', siteName: 'Phoenix' });
    expect(manifest.siteOf({ db }, { names: ['nobody'] })).toBe(null);
    expect(manifest.incidentEvidence({}, {})).toBe(null);
  });
});

// ---- Round 4: the Correlation page (backup load, replication, changes, blames) ----

const lmCorrelation = require('../services/logicmonitorCorrelation');

describe('round 4: backup load on switch ports (B1)', () => {
  const NOW = Date.now();
  let vcId; let clusterId; let sid;
  const JOBS = ['J1', 'J2', 'J3', 'J4', 'J5', 'J6'];

  function cleanBackup() {
    for (const t of ['protection_runs', 'cohesity_objects', 'clusters', 'vcenter_networks']) db.prepare(`DELETE FROM ${t}`).run();
  }
  const addRun = (job, jobId, startMs, endMs, bytes) => db.prepare(`INSERT INTO protection_runs (cluster_id, job_id, job_name, status, start_time, end_time, logical_bytes)
    VALUES (?, ?, ?, 'kSuccess', ?, ?, ?)`).run(clusterId, jobId, job, new Date(startMs).toISOString(), new Date(endMs).toISOString(), bytes);
  const net = (kind, name, sw, uplinks) => db.prepare('INSERT INTO vcenter_networks (vcenter_id, host_name, kind, name, switch_name, uplinks) VALUES (?, ?, ?, ?, ?, ?)')
    .run(vcId, 'nyc-esx-0101.icc.demo', kind, name, sw, uplinks ? JSON.stringify(uplinks) : null);
  const hist = (inst, fromMs, toMs, util) => {
    const h = db.prepare('INSERT INTO lm_interface_history (source_id, instance_id, captured_at, status, in_util_pct, out_util_pct) VALUES (?, ?, ?, 1, ?, 5)');
    for (let t = fromMs; t <= toMs; t += 10 * 60000) h.run(sid, inst, sqlStamp(t), util);
  };

  beforeEach(() => {
    cleanBackup();
    sid = seedPathEstate();
    vcId = db.prepare("SELECT id FROM vcenter_vcenters WHERE name = 'vc-test'").get().id;
    addIface(sid, 1, 13, 'Gi1/0/6');
    addIface(sid, 1, 14, 'Gi1/0/7');
    db.prepare(`INSERT INTO vcenter_host_nic_neighbors (vcenter_id, host_name, nic, protocol, switch_name, switch_port)
      VALUES (?, 'nyc-esx-0101.icc.demo', 'vmnic1', 'cdp', 'phx-acc-01', 'Gi1/0/6')`).run(vcId);
    db.prepare(`INSERT INTO lm_topology_links (source_id, src_device_id, src_instance_id, src_port, protocol, confidence, dst_platform, dst_ref, dst_name)
      VALUES (?, 1, 14, 'Gi1/0/7', 'description', 'high', 'dell', 'dellhost1.corp', 'dellhost1')`).run(sid);
    clusterId = db.prepare("INSERT INTO clusters (name, connection_type, auth_type, encrypted_credentials) VALUES ('cg-clu1', 'direct', 'apikey', 'x')").run().lastInsertRowid;
    // six overlapping runs on web01's host (10 minutes apart, 40 minutes long), equal bytes
    const start = NOW - 3 * HOUR_MS;
    JOBS.forEach((j, i) => addRun(j, 100 + i, start + i * 10 * 60000, start + i * 10 * 60000 + 40 * 60000, 1000));
    db.prepare("INSERT INTO cohesity_objects (cluster_id, name, protection_groups) VALUES (?, 'web01', ?)").run(clusterId, JSON.stringify(JOBS));
    hist(11, start, start + 100 * 60000, 85);
    hist(13, start, start + 100 * 60000, 40);
  });
  afterEach(() => { cleanBackup(); clearVcenterFixtures(); });

  it('merges six overlapping runs on one host into one window whose shares sum to 100; vmkernel picks vmnic0 only', () => {
    net('vswitch', 'vSwitch0', null, ['vmnic0']);
    net('portgroup', 'Management Network', 'vSwitch0', null);
    net('vmkernel', 'vmk0', 'Management Network', null);
    const rows = lmCorrelation.backupLoad(db, { nowMs: NOW });
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r).toMatchObject({ deviceName: 'phx-acc-01', port: 'GigabitEthernet1/0/5', instanceId: 11, host: 'nyc-esx-0101.icc.demo', hostPlatform: 'vcenter', uplinkRule: 'vmkernel', runCount: 6, finding: 'saturates', meanUtilPct: 85 });
    expect(r.runs.map((x) => x.jobName)).toEqual(JOBS);
    expect(Math.round(r.runs.reduce((a, x) => a + x.sharePct, 0) * 10) / 10).toBe(100);
    expect(r.runs[0]).toMatchObject({ cluster: 'cg-clu1', objectName: 'web01', status: 'kSuccess', logicalBytes: 1000 });
    expect(r.windowStart < r.windowEnd).toBe(true);
    expect(r.windowStart).toMatch(/Z$/);
  });

  it('falls back to every hint row when the vmkernel chain is missing, saturating port first', () => {
    const rows = lmCorrelation.backupLoad(db, { nowMs: NOW });
    expect(rows.map((r) => r.instanceId)).toEqual([11, 13]);
    expect(rows.every((r) => r.uplinkRule === 'all-uplinks')).toBe(true);
    expect(rows[1].finding).toBeUndefined();
    // a vmkernel row whose vswitch has no uplinks also falls back
    net('vswitch', 'vSwitch0', null, []);
    net('portgroup', 'Management Network', 'vSwitch0', null);
    net('vmkernel', 'vmk0', 'Management Network', null);
    expect(lmCorrelation.backupLoad(db, { nowMs: NOW })[0].uplinkRule).toBe('all-uplinks');
  });

  it('a physical server uses its endpoint rows; a run with no port history makes no row', () => {
    const start = NOW - 2 * HOUR_MS;
    addRun('PhysJob', 300, start, start + 30 * 60000, null);
    db.prepare("INSERT INTO cohesity_objects (cluster_id, name, protection_groups) VALUES (?, 'dellhost1', ?)").run(clusterId, JSON.stringify(['PhysJob']));
    expect(lmCorrelation.backupLoad(db, { nowMs: NOW }).some((r) => r.host === 'dellhost1')).toBe(false); // no history on instance 14 yet
    hist(14, start, start + 30 * 60000, 20);
    const phys = lmCorrelation.backupLoad(db, { nowMs: NOW }).find((r) => r.host === 'dellhost1');
    expect(phys).toMatchObject({ uplinkRule: 'physical', hostPlatform: 'dell', instanceId: 14, runCount: 1, meanUtilPct: 20 });
    expect(phys.runs[0].sharePct).toBe(null); // bytes missing
    expect(lmCorrelation.backupLoadByPort([phys]).get(`${sid}:14`)).toEqual({ count: 1, lastWindow: phys.windowEnd });
    expect(lmEndpoints.backupLoad(db, { nowMs: NOW }).length).toBeGreaterThan(0);
  });
});

describe('round 4: replication vs circuits (B2)', () => {
  const NOW = Date.now();
  let sid; let clusterId;

  function cleanRepl() {
    for (const t of ['replication_runs', 'protection_runs', 'clusters', 'zerto_vpgs', 'zerto_alerts']) db.prepare(`DELETE FROM ${t}`).run();
  }
  beforeEach(() => {
    cleanRepl();
    sid = seedPathEstate();
    lmSites.computeSites(db, sid);
    lmPath.computeCircuits(db, sid);
    const h = db.prepare('INSERT INTO lm_interface_history (source_id, instance_id, captured_at, status, in_util_pct, out_util_pct) VALUES (?, ?, ?, 1, ?, 10)');
    for (let k = 0; k < 48; k += 1) {
      const t = NOW - 30000 - 300000 * k;
      const hot = k <= 2 || (t >= NOW - 2 * HOUR_MS && t <= NOW - HOUR_MS);
      h.run(sid, 40, sqlStamp(t), hot ? 90 : 30);
      h.run(sid, 41, sqlStamp(t), 10);
    }
  });
  afterEach(() => { cleanRepl(); clearVcenterFixtures(); });

  it('lists the saturated circuit as coincident and the quiet one without a finding; unresolved sites need a finding', () => {
    db.prepare(`INSERT INTO zerto_vpgs (vpg_identifier, name, protected_site, recovery_site, actual_rpo, configured_rpo, status)
      VALUES ('v1', 'Payments', 'Phoenix DC', 'Dallas DR', 900, 300, 'MeetingSLA')`).run();
    db.prepare("INSERT INTO zerto_vpgs (vpg_identifier, name, protected_site, actual_rpo, configured_rpo) VALUES ('v2', 'Healthy', 'Phoenix DC', 100, 300)").run();
    db.prepare(`INSERT INTO zerto_alerts (alert_identifier, alert_type, description, site_name, collection_time)
      VALUES ('a1', 'RPO', 'RPO exceeded for VPG Payments', 'Phoenix DC', ?)`).run(new Date(NOW - 3 * HOUR_MS).toISOString());
    db.prepare("INSERT INTO zerto_alerts (alert_identifier, alert_type, description, site_name, collection_time) VALUES ('a2', 'VRA', 'VRA disk almost full', 'Phoenix DC', ?)")
      .run(new Date(NOW - 3 * HOUR_MS).toISOString());
    clusterId = db.prepare("INSERT INTO clusters (name, connection_type, auth_type, encrypted_credentials) VALUES ('cg-clu1', 'direct', 'apikey', 'x')").run().lastInsertRowid;
    const prId = db.prepare("INSERT INTO protection_runs (cluster_id, job_id, job_name, status, start_time, end_time) VALUES (?, 1, 'VM_Prod', 'kSuccess', ?, ?)")
      .run(clusterId, new Date(NOW - 2 * HOUR_MS).toISOString(), new Date(NOW - HOUR_MS).toISOString()).lastInsertRowid;
    db.prepare(`INSERT INTO replication_runs (protection_run_id, cluster_id, target_cluster_name, status, start_time, end_time, lag_seconds)
      VALUES (?, ?, 'other-dc-clu', 'Failed', ?, ?, 5400)`).run(prId, clusterId, new Date(NOW - 2 * HOUR_MS).toISOString(), new Date(NOW - HOUR_MS).toISOString());
    db.prepare(`INSERT INTO replication_runs (protection_run_id, cluster_id, target_cluster_name, status, start_time, end_time, lag_seconds)
      VALUES (?, ?, 'second-dc-clu', 'Succeeded', ?, ?, 60)`).run(prId, clusterId, new Date(NOW - 2 * HOUR_MS).toISOString(), new Date(NOW - HOUR_MS).toISOString());

    const rows = lmCorrelation.replicationVsCircuits(db, { nowMs: NOW });
    const by = (kind) => rows.filter((r) => r.kind === kind);
    // VPG: site resolves to Phoenix, both phx circuits listed, the hot one is coincident
    const rpo = by('zerto-rpo');
    expect(rpo).toHaveLength(2);
    expect(rpo[0]).toMatchObject({ subject: 'Payments', siteKey: 'phoenix', finding: 'coincident', circuitUtilPct: 90, circuitP95Pct: 90, overlapMinutes: 15, until: null });
    expect(rpo[0].circuit).toMatchObject({ deviceName: 'phx-rtr-01', port: 'Gi0/0/1', siteKey: 'phoenix' });
    expect(rpo[0].detail).toContain('Actual RPO 15 min against 5 min configured');
    expect(rpo[1].circuit.port).toBe('Gi0/0/2');
    expect(rpo[1].finding).toBeUndefined();
    // Zerto alert: only the RPO wording counts; circuits were quiet then
    const alerts = by('zerto-alert');
    expect(alerts).toHaveLength(2);
    expect(alerts.every((r) => r.finding === undefined && r.subject === 'RPO' && r.overlapMinutes === 60)).toBe(true);
    // Cohesity run: target not resolvable, so only the circuit over the line is listed
    const cohesity = by('cohesity-replication');
    expect(cohesity).toHaveLength(1);
    expect(cohesity[0]).toMatchObject({ subject: 'VM_Prod', siteKey: null, finding: 'coincident', overlapMinutes: 60 });
    expect(cohesity[0].detail).toContain('Failed, lag 1.5 h, to other-dc-clu');
    expect(cohesity[0].circuit.port).toBe('Gi0/0/1');
    expect(rows[0].finding).toBe('coincident'); // findings sort first
  });

  it('returns nothing without events or circuits and never throws', () => {
    expect(lmCorrelation.replicationVsCircuits(db, { nowMs: NOW })).toEqual([]);
    db.prepare('UPDATE lm_interfaces SET is_wan = 0').run();
    expect(lmCorrelation.replicationVsCircuits(db, { nowMs: NOW })).toEqual([]);
  });
});

describe('round 4: changes followed by incidents (B3)', () => {
  const NOW = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  let sid;
  beforeEach(() => {
    db.prepare('DELETE FROM config_changes').run();
    sid = seedPathEstate();
    lmSites.computeSites(db, sid);
  });
  afterEach(() => { db.prepare('DELETE FROM config_changes').run(); clearVcenterFixtures(); });

  const change = (system, item, ms) => db.prepare("INSERT INTO config_changes (platform, scope, system, item, change_type, old_value, new_value, detected_at) VALUES ('logicmonitor', 'device-inventory', ?, ?, 'changed', 'a', 'b', ?)")
    .run(system, item, iso(ms));
  const issue = (key, type, target, ms) => db.prepare("INSERT INTO lm_issue_history (issue_key, source, severity, type, target, message, status, first_seen) VALUES (?, 'portal1', 'warning', ?, ?, ?, 'open', ?)")
    .run(key, type, target, `${type} on ${target}`, sqlStamp(ms));

  it('pairs a change with incidents inside 24 hours, by name, by blame hop and by LM alert; ignores earlier and later ones', () => {
    change('phx-dist-01', 'Te1/1/1 description', NOW - 5 * HOUR_MS);
    change('phx-acc-01', 'firmware', NOW - 30 * HOUR_MS);
    issue('interface-flapping|portal1|phx-dist-01 Te1/1/1', 'interface-flapping', 'phx-dist-01 Te1/1/1', NOW - 4 * HOUR_MS);
    issue('interface-errors-growing|portal1|phx-dist-01 Gi1/0/1', 'interface-errors-growing', 'phx-dist-01 Gi1/0/1', NOW - 40 * HOUR_MS); // before the change
    issue('device-dead|portal1|phx-acc-01', 'device-dead', 'phx-acc-01', NOW - 28 * HOUR_MS); // 2 h after
    issue('device-dead|portal1|phx-acc-01b', 'device-dead', 'phx-acc-01', NOW - 3 * HOUR_MS); // 27 h after: outside
    issue('device-new|portal1|phx-dist-01', 'device-new', 'phx-dist-01', NOW - 4 * HOUR_MS); // not an incident type
    issue('check-down|portal1|Ping web01', 'check-down', 'Ping web01', NOW - 3 * HOUR_MS);
    lmCorrelation.recordBlame(db, { sourceId: sid, kind: 'check', subject: 'Ping web01', subjectKey: 'w:1', issueKey: 'check-down|portal1|Ping web01',
      blame: { deviceId: 2, deviceName: 'phx-dist-01', port: 'Te1/1/1', state: 'critical', reason: 'down' } });
    db.prepare("INSERT INTO lm_alerts (source_id, lm_alert_id, severity, severity_norm, lm_device_id, monitor_object_name, resource_template_name, data_point_name, alert_value, cleared, condition_key, start_epoch) VALUES (?, 'DS5', 3, 'warning', 2, 'phx-dist-01', 'Cisco_CPU_SNMP', 'CPUBusyPercent', '97', 0, 'k5', ?)")
      .run(sid, Math.floor((NOW - 5 * HOUR_MS + 30 * 60000) / 1000));
    const rows = lmCorrelation.changesThenIncidents(db, { nowMs: NOW });
    expect(rows.map((r) => `${r.system}|${r.incident.type}|${r.incident.minutesAfter}`)).toEqual([
      'phx-dist-01|lm-alert|30', 'phx-dist-01|interface-flapping|60', 'phx-dist-01|check-down|120', 'phx-acc-01|device-dead|120',
    ]);
    expect(rows[0]).toMatchObject({ scope: 'device-inventory', item: 'Te1/1/1 description', changeType: 'changed', oldValue: 'a', newValue: 'b', siteKey: 'phoenix' });
    expect(rows[0].changedAt).toMatch(/Z$/);
    expect(rows[0].incident.target).toBe('phx-dist-01');
    expect(rows[0].incident.message).toBe('Cisco_CPU_SNMP CPUBusyPercent = 97');
    expect(lmCorrelation.changesThenIncidents(db, { days: 1, nowMs: NOW }).every((r) => r.system === 'phx-dist-01')).toBe(true);
  });

  it('resolves the device from the ledger item when system is the portal name (links scope "device port" too)', () => {
    db.prepare("INSERT INTO config_changes (platform, scope, system, item, change_type, old_value, new_value, detected_at) VALUES ('logicmonitor', 'device-inventory', 'Demo portal', 'phx-dist-01', 'changed', 'version 1', 'version 2', ?)").run(iso(NOW - 5 * HOUR_MS));
    db.prepare("INSERT INTO config_changes (platform, scope, system, item, change_type, old_value, new_value, detected_at) VALUES ('logicmonitor', 'links', 'Demo portal', 'phx-acc-01 Gi1/0/17', 'changed', 'VLAN 20', 'VLAN 20 (duplex auto)', ?)").run(iso(NOW - 6 * HOUR_MS));
    issue('interface-flapping|portal1|phx-dist-01 Te1/1/1', 'interface-flapping', 'phx-dist-01 Te1/1/1', NOW - 4 * HOUR_MS);
    issue('device-dead|portal1|phx-acc-01', 'device-dead', 'phx-acc-01', NOW - 3 * HOUR_MS);
    const rows = lmCorrelation.changesThenIncidents(db, { nowMs: NOW });
    expect(rows.map((r) => `${r.device}|${r.system}|${r.incident.type}|${r.incident.minutesAfter}`)).toEqual([
      'phx-dist-01|Demo portal|interface-flapping|60', 'phx-acc-01|Demo portal|device-dead|180',
    ]);
    expect(rows[0].siteKey).toBe('phoenix');
  });

  it('no change rows means an empty list', () => {
    expect(lmCorrelation.changesThenIncidents(db, { nowMs: NOW })).toEqual([]);
  });
});

describe('round 4: blame history (B4)', () => {
  const NOW = Date.now();
  const hop = (port = 'Te1/1/1', extra = {}) => ({ deviceId: 2, deviceName: 'phx-dist-01', port, state: 'critical', reason: 'port down', ...extra });
  let sid;
  beforeEach(() => { sid = seedPathEstate(); lmSites.computeSites(db, sid); });
  afterEach(() => { clearVcenterFixtures(); db.prepare('DELETE FROM app_service_watch').run(); });

  it('recordBlame writes once per subject, issue and hop while the dedupe window holds, and skips ok blames', () => {
    const since = sqlStamp(NOW - HOUR_MS);
    const rec = (b, o = {}) => lmCorrelation.recordBlame(db, { sourceId: sid, kind: 'check', subject: 'Ping web01', subjectKey: 'w:1', issueKey: 'k1', blame: b, dedupeSince: since, ...o });
    expect(rec(hop())).toBe(true);
    expect(rec(hop())).toBe(false);
    expect(rec(hop('Te1/1/2'))).toBe(true); // the hop changed
    expect(rec(hop(), { issueKey: 'k2' })).toBe(true); // another issue
    expect(rec({ ...hop(), state: 'ok' })).toBe(false);
    expect(rec(null)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) n FROM lm_blame_history').get().n).toBe(3);
    expect(lmCorrelation.recordBlame(db, { sourceId: null, blame: hop() })).toBe(false);
  });

  it('reconcileIssueHistory records the check blame once and again only when the hop changes', () => {
    db.prepare("INSERT INTO lm_checks (source_id, check_id, kind, origin, name, target, is_internal, stale) VALUES (?, 'w:1', 'ping', 'website', 'Ping web01', '10.9.9.9', 0, 0)").run(sid);
    db.prepare("INSERT INTO lm_check_locations (source_id, check_id, checkpoint_id, label, is_overall, last_status, last_rtt_ms, last_loss_pct, last_sample_epoch, stale) VALUES (?, 'w:1', 'overall', 'Overall', 1, 'down', NULL, 100, ?, 0)")
      .run(sid, Math.floor(Date.now() / 1000));
    setIfStatus(sid, 21, 'down');
    lmIssues.reconcileIssueHistory();
    const rows = () => db.prepare('SELECT * FROM lm_blame_history ORDER BY id').all();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ kind: 'check', subject: 'Ping web01', subject_key: 'w:1', hop_device_name: 'phx-dist-01', hop_port: 'Te1/1/1', hop_state: 'critical', site_key: 'phoenix' });
    expect(rows()[0].issue_key).toBe('check-down|portal1|Ping web01');
    lmIssues.reconcileIssueHistory();
    expect(rows()).toHaveLength(1);
    // the culprit moves up one hop: a new row
    setIfStatus(sid, 21, 'up');
    setIfStatus(sid, 31, 'down');
    lmIssues.reconcileIssueHistory();
    expect(rows()).toHaveLength(2);
    expect(rows()[1]).toMatchObject({ hop_device_name: 'core-sw-01', hop_port: 'Te1/0/9' });
  });

  it('rolls hops up by count with top subjects, apps affected and the recent list; old rows fall out', () => {
    const rec = (b, o) => lmCorrelation.recordBlame(db, { sourceId: sid, blame: b, ...o });
    for (let i = 0; i < 2; i += 1) rec(hop(), { kind: 'check', subject: 'Ping web01', subjectKey: 'w:1', at: sqlStamp(NOW - (i + 1) * HOUR_MS) });
    rec(hop(), { kind: 'server', subject: 'web01', subjectKey: 'web01', at: sqlStamp(NOW - 3 * HOUR_MS) });
    rec({ deviceId: 4, deviceName: 'phx-rtr-01', port: 'Gi0/0/1', state: 'warning', reason: 'errors growing' }, { kind: 'check', subject: 'Ping web01', subjectKey: 'w:1', at: sqlStamp(NOW - 4 * HOUR_MS) });
    rec(hop(), { kind: 'check', subject: 'old', subjectKey: 'x', at: sqlStamp(NOW - 40 * 86400000) });
    db.prepare("UPDATE vcenter_vms SET tags = '[\"usage-id: aa1\"]' WHERE name = 'web01'").run();
    db.prepare("INSERT INTO app_service_watch (usage_id, display_id, created_at) VALUES ('aa1', 'AA1', ?)").run(new Date().toISOString());
    const h = lmCorrelation.blameHistory(db, { nowMs: NOW });
    expect(h.hops).toHaveLength(2);
    expect(h.hops[0]).toMatchObject({ deviceId: 2, deviceName: 'phx-dist-01', port: 'Te1/1/1', siteKey: 'phoenix', count: 3 });
    expect(h.hops[0].subjects).toEqual([{ kind: 'check', subject: 'Ping web01', count: 2 }, { kind: 'server', subject: 'web01', count: 1 }]);
    expect(h.hops[0].appsAffected).toEqual(['aa1']);
    expect(h.hops[0].lastAt > h.hops[0].firstAt).toBe(true);
    expect(h.hops[1]).toMatchObject({ deviceName: 'phx-rtr-01', count: 1, appsAffected: ['aa1'] });
    expect(h.recent).toHaveLength(4);
    expect(h.recent[0]).toMatchObject({ kind: 'check', hopDeviceName: 'phx-dist-01', hopPort: 'Te1/1/1', hopState: 'critical', hopReason: 'port down' });
    expect(lmCorrelation.blameHistory(db, { days: 60, nowMs: NOW }).hops[0].count).toBe(4);
  });
});
