/**
 * LogicMonitor round 9 WP7: AWS Direct Connect and Azure ExpressRoute.
 * Catalog family and matching order, the inventory refresh filter, the two
 * issue types and the circuits rows. Datapoint names and enums are UNVERIFIED
 * in the code, so the tests pin the documented tolerance, not a live shape.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const { encrypt } = require('../services/encryption');
const lmIssues = require('../services/logicmonitorIssues');
const lmCatalog = require('../services/logicmonitorCatalog');
const lmCloud = require('../services/logicmonitorCloud');
const lmPoller = require('../services/logicmonitorPoller');

const TABLES = ['lm_issue_history', 'lm_ds_metrics_history', 'lm_ds_metrics', 'lm_ds_instances', 'lm_device_datasources', 'lm_devices', 'lm_sources'];
const NOW = Math.floor(Date.now() / 1000);

beforeAll(() => { runMigrations(db, 'logicmonitor', lmMigrations); });

let sid;
beforeEach(() => {
  for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("DELETE FROM app_settings WHERE key LIKE 'lm_%'").run();
  sid = db.prepare('INSERT INTO lm_sources (name, company, auth_mode, encrypted_credentials) VALUES (?, ?, ?, ?)')
    .run('Acme', 'acme', 'lmv1', encrypt(JSON.stringify({ accessId: 'a', accessKey: 'b' }))).lastInsertRowid;
});

function cloudDev(id, name, { type = 2, ert = 'AWS/DirectConnect', bandwidth = null, region = null, sdt = 'none-none-none', stale = 0 } = {}) {
  const custom = bandwidth ? JSON.stringify([{ name: 'bandwidth', value: bandwidth }]) : null;
  const sys = region ? JSON.stringify([{ name: 'system.aws.region', value: region }]) : null;
  db.prepare(`INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, device_type, host_status, sdt_status, vendor, role, is_network, ert,
    custom_props_json, system_props_json, site_key, stale) VALUES (?, ?, ?, ?, ?, 'normal', ?, 'AWS', 'other', 0, ?, ?, ?, 'aws', ?)`)
    .run(sid, id, name, name, type, sdt, ert, custom, sys, stale);
}
function metric(devId, ds, metric, value, { key = 'conn', hist = null } = {}) {
  const hds = 7000 + devId;
  const family = 'cloud';
  db.prepare(`INSERT OR IGNORE INTO lm_ds_instances (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, instance_name, stale)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)`).run(sid, devId, hds, ds, family, key, key);
  db.prepare(`INSERT OR REPLACE INTO lm_ds_metrics (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, metric, datapoint, value, sampled_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sid, devId, hds, ds, family, key, metric, metric, value, NOW - 60);
  if (hist) {
    hist.forEach((v, i) => {
      db.prepare('INSERT INTO lm_ds_metrics_history (source_id, lm_device_id, hds_id, instance_key, metric, value, sampled_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(sid, devId, hds, key, metric, v, NOW - (hist.length - 1 - i) * 1800);
    });
  }
}
const issuesOf = (type) => lmIssues.computeIssues().filter((i) => i.type === type);

describe('catalog', () => {
  it('has the cloud family with its label and the three DataSource entries', () => {
    expect(lmCatalog.FAMILIES).toContain('cloud');
    expect(lmCatalog.FAMILY_LABELS.cloud).toBe('Cloud circuits');
    expect(lmCatalog.catalogFor('AWS_DirectConnect_Connection')).toMatchObject({ family: 'cloud', label: 'AWS Direct Connect' });
    expect(Object.keys(lmCatalog.catalogFor('AWS_DirectConnect_Connection').metrics)).toEqual(
      ['dx_state', 'dx_bps_in', 'dx_bps_out', 'dx_light_in', 'dx_light_out', 'dx_errors']);
    // The virtual interface entry wins over the connection entry for a name that contains both words.
    const vif = lmCatalog.catalogFor('AWS_DirectConnectVirtualInterface');
    expect(vif.label).toBe('AWS Direct Connect virtual interface');
    expect(Object.keys(vif.metrics)).toEqual(['vif_state', 'vif_bps_in', 'vif_bps_out', 'vif_bgp']);
    expect(Object.keys(lmCatalog.catalogFor('Azure_ExpressRoute_Circuits').metrics)).toEqual(['er_bps_in', 'er_bps_out', 'er_bgp', 'er_arp']);
    for (const name of ['AWS_DirectConnect_Connection', 'AWS_DirectConnectVirtualInterface', 'Azure_ExpressRoute_Circuits']) {
      expect(lmCatalog.catalogFor(name).history).toBe(true);
    }
  });

  it('CLOUD_ERT_RE matches the three resource types and nothing else', () => {
    for (const ert of ['AWS/DirectConnect', 'AWS/DirectConnectVirtualInterface', 'Azure/ExpressRouteCircuit']) expect(lmCatalog.CLOUD_ERT_RE.test(ert)).toBe(true);
    for (const ert of ['AWS/EC2', 'Azure/VirtualMachine', 'Switch', '']) expect(lmCatalog.CLOUD_ERT_RE.test(ert)).toBe(false);
  });
});

describe('refreshCandidates', () => {
  it('includes device_type 2 and 4 resources with a cloud ERT next to network devices, and skips other cloud devices', () => {
    cloudDev(1, 'dx-1');
    cloudDev(2, 'er-1', { type: 4, ert: 'Azure/ExpressRouteCircuit' });
    cloudDev(3, 'ec2-1', { ert: 'AWS/EC2' });
    cloudDev(4, 'dx-stale', { stale: 1 });
    db.prepare(`INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, device_type, is_network, stale) VALUES (?, 5, 'sw-1', 'sw-1', 0, 1, 0)`).run(sid);
    const ids = lmPoller.refreshCandidates(sid).map((d) => d.lm_device_id).sort();
    expect(ids).toEqual([1, 2, 5]);
  });
});

describe('helpers', () => {
  it('isDownValue: numeric 0, or text down or unavailable', () => {
    expect(lmCloud.isDownValue(0)).toBe(true);
    expect(lmCloud.isDownValue(1)).toBe(false);
    expect(lmCloud.isDownValue(100)).toBe(false);
    expect(lmCloud.isDownValue('down')).toBe(true);
    expect(lmCloud.isDownValue('Unavailable')).toBe(true);
    expect(lmCloud.isDownValue('available')).toBe(false);
    expect(lmCloud.isDownValue(null)).toBe(false);
  });

  it('parseBandwidth reads units and treats a bare number as Mbps', () => {
    expect(lmCloud.parseBandwidth('10 Gbps')).toBe(1e10);
    expect(lmCloud.parseBandwidth('500Mbps')).toBe(5e8);
    expect(lmCloud.parseBandwidth('1000')).toBe(1e9);
    expect(lmCloud.parseBandwidth('2,000')).toBe(2e9);
    expect(lmCloud.parseBandwidth('fast')).toBeNull();
    expect(lmCloud.parseBandwidth(null)).toBeNull();
  });
});

describe('issues', () => {
  it('cloud-circuit-down is critical when the connection state reads 0 and prints the raw value', () => {
    cloudDev(1, 'dx-down');
    metric(1, 'AWS_DirectConnect_Connection', 'dx_state', 0);
    const rows = issuesOf('cloud-circuit-down');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: 'critical', source: 'Acme', target: 'dx-down' });
    expect(rows[0].message).toContain('dx_state reads 0');
  });

  it('a healthy state (1) raises nothing, an Azure BGP availability of 0 is down, and a virtual interface state 0 is down', () => {
    cloudDev(1, 'dx-ok');
    metric(1, 'AWS_DirectConnect_Connection', 'dx_state', 1);
    cloudDev(2, 'er-down', { type: 4, ert: 'Azure/ExpressRouteCircuit' });
    metric(2, 'Azure_ExpressRoute_Circuits', 'er_bgp', 0);
    cloudDev(3, 'vif-down', { ert: 'AWS/DirectConnectVirtualInterface' });
    metric(3, 'AWS_DirectConnectVirtualInterface', 'vif_state', 0);
    expect(issuesOf('cloud-circuit-down').map((i) => i.target).sort()).toEqual(['er-down', 'vif-down']);
  });

  it('cloud-circuit-saturated warns at lm_circuit_sat_pct of the bandwidth property and skips an unknown bandwidth', () => {
    cloudDev(1, 'dx-hot', { bandwidth: '1 Gbps' });
    metric(1, 'AWS_DirectConnect_Connection', 'dx_state', 1);
    metric(1, 'AWS_DirectConnect_Connection', 'dx_bps_in', 9e8);
    metric(1, 'AWS_DirectConnect_Connection', 'dx_bps_out', 1e8);
    cloudDev(2, 'dx-no-bw');
    metric(2, 'AWS_DirectConnect_Connection', 'dx_bps_in', 9e9);
    cloudDev(3, 'dx-cool', { bandwidth: '10 Gbps' });
    metric(3, 'AWS_DirectConnect_Connection', 'dx_bps_in', 1e9);
    const rows = issuesOf('cloud-circuit-saturated');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: 'warning', target: 'dx-hot' });
    expect(rows[0].message).toMatch(/90% of its 1000 Mbps/);
  });

  it('devices in scheduled downtime raise nothing and the types are exported', () => {
    cloudDev(1, 'dx-sdt', { sdt: 'none-SDT-none' });
    metric(1, 'AWS_DirectConnect_Connection', 'dx_state', 0);
    expect(issuesOf('cloud-circuit-down')).toEqual([]);
    expect(lmIssues.METRIC_ISSUE_TYPES).toEqual(expect.arrayContaining(['cloud-circuit-down', 'cloud-circuit-saturated']));
  });

  it('the issues reach the issue history', () => {
    cloudDev(1, 'dx-down');
    metric(1, 'AWS_DirectConnect_Connection', 'dx_state', 0);
    lmIssues.reconcileIssueHistory();
    expect(db.prepare("SELECT type, severity, target FROM lm_issue_history WHERE status = 'open'").all())
      .toEqual([{ type: 'cloud-circuit-down', severity: 'critical', target: 'dx-down' }]);
  });
});

describe('cloudCircuits', () => {
  const t = () => lmIssues.getThresholds();

  it('returns one row per connection with kind, region, state, throughput and the 24 hour series, worst first', () => {
    cloudDev(1, 'dx-ok', { bandwidth: '10 Gbps', region: 'us-east-1' });
    metric(1, 'AWS_DirectConnect_Connection', 'dx_state', 1);
    metric(1, 'AWS_DirectConnect_Connection', 'dx_bps_in', 2e9, { hist: [1e9, 1.5e9, 2e9] });
    metric(1, 'AWS_DirectConnect_Connection', 'dx_bps_out', 1e9, { hist: [5e8, 8e8, 1e9] });
    cloudDev(2, 'er-down', { type: 4, ert: 'Azure/ExpressRouteCircuit', bandwidth: '1000' });
    metric(2, 'Azure_ExpressRoute_Circuits', 'er_bgp', 0);
    const rows = lmCloud.cloudCircuits(db, t());
    expect(rows.map((r) => r.name)).toEqual(['er-down', 'dx-ok']);
    expect(rows[0]).toMatchObject({ kind: 'azure-er', state: 'critical', stateRaw: 0, bandwidthBps: 1e9 });
    expect(rows[1]).toMatchObject({ kind: 'aws-dx', region: 'us-east-1', state: 'ok', bpsIn: 2e9, bpsOut: 1e9, bandwidthBps: 1e10, utilPct: 20 });
    expect(rows[1].series24h).toHaveLength(3);
    expect(rows[1].series24h[2]).toMatchObject({ inBps: 2e9, outBps: 1e9 });
  });

  it('filters by source and by site and answers [] with no cloud devices', () => {
    expect(lmCloud.cloudCircuits(db, t())).toEqual([]);
    cloudDev(1, 'dx-1');
    metric(1, 'AWS_DirectConnect_Connection', 'dx_state', 1);
    expect(lmCloud.cloudCircuits(db, t(), { siteKey: 'elsewhere' })).toEqual([]);
    expect(lmCloud.cloudCircuits(db, t(), { siteKey: 'aws' })).toHaveLength(1);
    expect(lmCloud.cloudCircuits(db, t(), { sourceId: sid + 1000 })).toEqual([]);
  });
});

describe('round 10: properties, bandwidth parsing and the ECX entry', () => {
  const t = () => lmIssues.getThresholds();

  it('parseBandwidth reads "10Gbps", "500Mbps" and "1Gbps"', () => {
    expect(lmCloud.parseBandwidth('10Gbps')).toBe(1e10);
    expect(lmCloud.parseBandwidth('500Mbps')).toBe(5e8);
    expect(lmCloud.parseBandwidth('1Gbps')).toBe(1e9);
    expect(lmCloud.parseBandwidth('nonsense')).toBeNull();
  });

  it('deviceFacts reads system.aws.* properties, tags and prefers system.aws.bandwidth over the custom prop', () => {
    const row = {
      ert: 'AWS/DirectConnect',
      system_props_json: JSON.stringify([
        { name: 'system.aws.region', value: 'us-east-1' }, { name: 'system.aws.awsDevice', value: 'EqDC2-g2845xqir5zz' },
        { name: 'system.aws.bandwidth', value: '10Gbps' }, { name: 'system.aws.ownerAccount', value: '893373391538' },
        { name: 'system.aws.tag.cost-center', value: '524121' }, { name: 'system.aws.tag.sd-period', value: 'q4' },
      ]),
      custom_props_json: JSON.stringify([{ name: 'bandwidth', value: '1 Gbps' }]),
    };
    const f = lmCloud.deviceFacts(row);
    expect(f).toMatchObject({
      region: 'us-east-1', location: 'EqDC2-g2845xqir5zz', ownerAccount: '893373391538', bandwidthBps: 1e10, bandwidthText: '10Gbps',
      tags: { 'cost-center': '524121', 'sd-period': 'q4' },
    });
  });

  it('deviceFacts reads Azure region, subscription and bandwidth, and falls back to the custom prop', () => {
    const f = lmCloud.deviceFacts({
      system_props_json: JSON.stringify([{ name: 'system.azure.location', value: 'eastus' }, { name: 'system.azure.subscriptionId', value: 'sub-1' }, { name: 'system.azure.tag.owner', value: 'net' }]),
      custom_props_json: JSON.stringify([{ name: 'bandwidth', value: '500 Mbps' }]),
    });
    expect(f).toMatchObject({ region: 'eastus', subscription: 'sub-1', bandwidthBps: 5e8, tags: { owner: 'net' }, ownerAccount: null });
  });

  it('cloudCircuits rows carry the new fields', () => {
    cloudDev(1, 'dx-1');
    db.prepare('UPDATE lm_devices SET system_props_json = ? WHERE lm_device_id = 1').run(JSON.stringify([
      { name: 'system.aws.region', value: 'us-east-1' }, { name: 'system.aws.awsDevice', value: 'EqDC2-x' }, { name: 'system.aws.bandwidth', value: '10Gbps' },
      { name: 'system.aws.ownerAccount', value: '111122223333' }, { name: 'system.aws.tag.cost-center', value: '42' },
    ]));
    metric(1, 'AWS_DirectConnect_Connection', 'dx_state', 1);
    metric(1, 'AWS_DirectConnect_Connection', 'dx_bps_in', 5e9);
    const [row] = lmCloud.cloudCircuits(db, t());
    expect(row).toMatchObject({
      region: 'us-east-1', location: 'EqDC2-x', ownerAccount: '111122223333', bandwidthBps: 1e10, bandwidthText: '10Gbps', tags: { 'cost-center': '42' }, utilPct: 50,
    });
  });

  it('cloud-circuit-saturated uses bandwidthBps from system.aws.bandwidth', () => {
    cloudDev(1, 'dx-sat');
    db.prepare('UPDATE lm_devices SET system_props_json = ? WHERE lm_device_id = 1').run(JSON.stringify([{ name: 'system.aws.bandwidth', value: '1Gbps' }]));
    metric(1, 'AWS_DirectConnect_Connection', 'dx_state', 1);
    metric(1, 'AWS_DirectConnect_Connection', 'dx_bps_in', 9.5e8);
    const sat = issuesOf('cloud-circuit-saturated');
    expect(sat).toHaveLength(1);
    expect(sat[0].message).toContain('1000 Mbps');
  });

  it('the ECX utilisation DataSource matches the cloud family and fills utilisation when no bandwidth is known', () => {
    expect(lmCatalog.catalogFor('ntm_cloud_connectivity_azure_ecx_connection_utilization')).toMatchObject({ family: 'cloud' });
    const peer = lmCatalog.catalogFor('Microsoft_Azure_ExpressRouteCircuitPeering');
    expect(peer.metrics.er_bgp.match.some((r) => r.test('BgpAvailability'))).toBe(true);
    expect(peer.metrics.er_arp.match.some((r) => r.test('ArpAvailability'))).toBe(true);
    cloudDev(1, 'er-ecx', { type: 4, ert: 'Azure/ExpressRouteCircuit' });
    metric(1, 'ntm_cloud_connectivity_azure_ecx_connection_utilization', 'ecx_util_pct', 42);
    metric(1, 'ntm_cloud_connectivity_azure_ecx_connection_utilization', 'ecx_bps_in', 2e8);
    const [row] = lmCloud.cloudCircuits(db, t());
    expect(row).toMatchObject({ kind: 'azure-ecx', state: 'ok', utilPct: 42, bpsIn: 2e8 });
  });
});
