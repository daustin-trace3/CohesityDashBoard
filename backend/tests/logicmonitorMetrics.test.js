/**
 * LogicMonitor round 8, WP1: the DataSource catalog and the metric collector.
 * catalogFor resolution, instance key cleaning, parseDsBody over hand-built
 * bodies, and pollMetrics with lmApi.fetchDsData stubbed against seeded
 * lm_device_datasources rows (per-file test DB through the migration).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const lmApi = require('../services/logicmonitorApi');
const catalog = require('../services/logicmonitorCatalog');
const metrics = require('../services/logicmonitorMetrics');

const { catalogFor, cleanInstanceKey } = catalog;

const TABLES = [
  'lm_sources', 'lm_devices', 'lm_device_datasources', 'lm_ds_instances', 'lm_ds_metrics', 'lm_ds_metrics_history',
];

beforeAll(() => { runMigrations(db, 'logicmonitor', lmMigrations); });

const wipe = () => { for (const t of [...TABLES].reverse()) db.prepare(`DELETE FROM ${t}`).run(); };

function insertSource(o = {}) {
  return db.prepare(`
    INSERT INTO lm_sources (name, company, auth_mode, encrypted_credentials, metrics_poll_minutes, metrics_families_json, features_json)
    VALUES (?, 'acme', 'lmv1', 'x', ?, ?, ?)
  `).run(o.name ?? 'portal1', o.metricsPollMinutes ?? 30, o.families ?? null, o.features ?? null).lastInsertRowid;
}

function insertDevice(sourceId, id, name = `dev${id}`) {
  db.prepare('INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, is_network, stale) VALUES (?, ?, ?, ?, 1, 0)')
    .run(sourceId, id, name, name);
}

function insertDs(sourceId, deviceId, hdsId, dsName, o = {}) {
  db.prepare(`
    INSERT INTO lm_device_datasources (source_id, lm_device_id, hds_id, datasource_name, instance_count, stop_monitoring, is_interface, is_neighbor, metrics_last_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sourceId, deviceId, hdsId, dsName, o.instances ?? 1, o.stop ?? 0, o.isInterface ?? 0, o.isNeighbor ?? 0, o.lastAt ?? null);
}

const sourceRow = (id) => db.prepare('SELECT * FROM lm_sources WHERE id = ?').get(id);
const now = () => Math.floor(Date.now() / 1000);

describe('catalogFor', () => {
  const cases = {
    firewall: ['PaloAlto_FW_GlobalSessions', 'PaloAlto_FW_GlobalPerformance', 'PaloAlto_FW_SystemResources', 'PaloAlto_FW_DataplaneCores',
      'PaloAlto_FW_DroppedPackets', 'PaloAlto_FW_HA_Status', 'PaloAlto_FW_HA_Interface', 'PaloAlto_FW_IPSecTunnelOverview',
      'PaloAlto_FW_IPSecTunnelStats', 'PaloAlto_GlobalProtect_Gateway', 'PaloAlto_FW_Config_Synced', 'PaloAlto_FW_ThreatAnalysis',
      'PaloAlto_FW_Zones', 'PaloAlto_FW_vSys', 'PaloAlto_FW_LogForwarding', 'PaloAlto_FW_Disk', 'PaloAlto_FW_Power',
      'PaloAlto_FW_ChassisPower', 'PaloAlto_FW_Temperature', 'PaloAlto_FW_BGP', 'PaloAlto_FW_OSPF', 'PaloAlto_FW_SDWAN_Tunnel',
      'CiscoASA', 'Cisco_ASA_Failover', 'ntm_asa_license_authorization', 'ntm_meraki_mx_device_utilization'],
    loadbalancer: ['F5_BigIP_System', 'F5_BigIP_FailoverStatus', 'F5_BigIP_PoolMemberStats', 'F5_GTM_WideIP-', 'F5_GTM_VIPs-',
      'F5_GTM_Servers-', 'F5_GTM_Datacenters-', 'F5_GTM_Global', 'f5_big3d_service_status', 'f5_mcpd_service_status',
      'f5_tmm_service_status', 'f5_tmrouted_service_status', 'f5_gtmd_service_status', 'f5_gtm_gslb_status',
      'F5_BigIP_SSL_VIP_Certs', 'F5_BigIP_Memory', 'F5_BigIP_Filesystem', 'F5_BigIP_Interfaces', 'F5_BigIP_Fans',
      'F5_BigIP_Power', 'F5_BigIP_Temperature', 'F5OS Disk Overview', 'F5OS Fan Overview', 'F5OS Memory Overview',
      'F5OS Temperature Overview', 'F5os_CPU'],
    health: ['Cisco_CPU_SNMP', 'NetSNMPCPUwithCores', 'Brocade Corp CPU and Memory', 'Cisco_MemoryPools_SNMP', 'NetSNMP_Memory_Usage',
      'Cisco_FRU_Power', 'Cisco_Nexus_FRU_Power', 'Cisco_System_PowerSupplies', 'CiscoFan-', 'Cisco_TemperatureSensors',
      'Cisco_Entity_Sensors', 'Brocade Sensors-', 'Cisco_Nexus_Line_Card_Status', 'Cisco_Nexus_Supervisor_Status',
      'Cisco Switch Stack-', 'Cisco Switch Stack Ports-', 'Cisco_PowerOverEthernet', 'Cisco_Catalyst_PowerOverEthernet',
      'SNMP_Filesystem_Usage', 'SNMP_Host_Uptime'],
    optics: ['Cisco_Transceiver_Sensors'],
    routing: ['BGP-', 'OSPF_Neighbors', 'Cisco_EIGRP_Peers', 'ntm_CX_BGP', 'ntm_CX_BGP_Peering'],
    ipsla: ['CiscoSLA_jitter-', 'Cisco_IPSLA_Statistics', 'Groovy_Cisco_IPSLA_Statistics', 'ntm_ipsla_svd', 'CiscoSLA_ICMPEcho-', 'IPSLA_WAN'],
    voice: ['Cisco_SIP_Global', 'Cisco_SIP_Traffic', 'ntm_sbc_cpu', 'ntm_sbc_fan_status', 'ISDN_Channels'],
    wireless: ['Cisco_Wireless_AP', 'Cisco_Wireless_AccessPointRadio', 'Cisco_Wireless_GlobalPerformance',
      'Cisco_Wireless_HighAvailability', 'Cisco_C9800_HA_Peer_State', 'ntm_wlc_ap_status_check'],
  };
  for (const [family, names] of Object.entries(cases)) {
    it(`resolves the ${family} DataSources`, () => {
      for (const n of names) {
        const e = catalogFor(n);
        expect(e, n).toBeTruthy();
        expect(e.family, n).toBe(family);
      }
    });
  }

  it('resolves prefixed names with a live suffix and is case-insensitive', () => {
    expect(catalogFor('BGP-Peers')?.family).toBe('routing');
    expect(catalogFor('f5_gtm_wideip-ext')?.family).toBe('loadbalancer');
    expect(catalogFor('paloalto_fw_globalsessions')?.family).toBe('firewall');
  });

  it('returns null for unknown or empty names', () => {
    expect(catalogFor('SNMP_Network_Interfaces')).toBeNull();
    expect(catalogFor('')).toBeNull();
    expect(catalogFor(null)).toBeNull();
  });

  it('exports the family list and every entry carries the contract fields', () => {
    expect(catalog.FAMILIES).toEqual(['firewall', 'loadbalancer', 'health', 'optics', 'routing', 'ipsla', 'voice', 'wireless']);
    for (const f of catalog.FAMILIES) expect(catalog.FAMILY_LABELS[f]).toBeTruthy();
    for (const e of catalog.CATALOG) {
      expect(catalog.FAMILIES).toContain(e.family);
      expect(typeof e.history).toBe('boolean');
      expect(e.maxInstances).toBeGreaterThan(0);
      for (const d of Object.values(e.metrics)) {
        expect(['gauge', 'state', 'counter', 'pct']).toContain(d.kind);
        expect(d.match).toBeTruthy();
      }
    }
  });

  it('carries every metric key the pages depend on', () => {
    const keys = new Set(catalog.CATALOG.flatMap((e) => Object.keys(e.metrics)));
    for (const k of ['sessions_util_pct', 'ha_peer_state', 'tunnel_state', 'tunnels_up', 'gp_users_active', 'config_synced', 'threats_total',
      'failover_state', 'member_avail', 'wideip_avail', 'vip_avail', 'daemon_state', 'cert_days_left', 'cpu_pct', 'mem_pct',
      'psu_state', 'fan_state', 'temp_state', 'linecard_state', 'sup_state', 'stack_member_state', 'rx_power_dbm', 'rx_low_warn',
      'bgp_peer_state', 'ospf_nbr_state', 'rtt_ms', 'loss_pct', 'sip_connections', 'sbc_cpu_pct', 'ap_state', 'wlc_ap_down']) {
      expect(keys.has(k), k).toBe(true);
    }
  });
});

describe('cleanInstanceKey', () => {
  it('strips the DataSource prefix and the [ID:n] suffix', () => {
    expect(cleanInstanceKey('PaloAlto_FW_IPSecTunnelStats-Appian_IPsec_Tunnel_PROD:proxy1 [ID:76]', 'PaloAlto_FW_IPSecTunnelStats'))
      .toBe('Appian_IPsec_Tunnel_PROD:proxy1');
  });
  it('handles a missing prefix, a trailing-dash DataSource name and no suffix', () => {
    expect(cleanInstanceKey('plain [ID:9]', 'Other')).toBe('plain');
    expect(cleanInstanceKey('BGP-10.0.0.1', 'BGP-')).toBe('10.0.0.1');
    expect(cleanInstanceKey('F5_GTM_WideIP-www.example.com', 'F5_GTM_WideIP-')).toBe('www.example.com');
    expect(cleanInstanceKey('only', '')).toBe('only');
  });
});

describe('parseDsBody', () => {
  const entry = catalogFor('PaloAlto_FW_GlobalSessions');
  const t0 = 1760400000;
  const body = {
    dataSourceName: 'PaloAlto_FW_GlobalSessions',
    dataPoints: ['ActiveSessions', 'MaxSessions', 'SessionUtilization', 'TcpSessions', 'Whatever'],
    instances: {
      'PaloAlto_FW_GlobalSessions-Global [ID:11]': {
        time: [t0 * 1000, (t0 + 60) * 1000, (t0 + 120) * 1000],
        values: [[100, 1000, 10, 80, 1], [200, 1000, 20, 160, 1], [null, null, null, null, 1]],
      },
    },
  };

  it('learns datapoints, takes the last non-null sample and reports unmatched names', () => {
    const r = metrics.parseDsBody(body, entry, null);
    expect(r.learned.sessions_active).toBe('ActiveSessions');
    expect(r.learned.sessions_max).toBe('MaxSessions');
    expect(r.learned.sessions_util_pct).toBe('SessionUtilization');
    expect(r.learned.sessions_tcp).toBe('TcpSessions');
    expect(r.unmatched).toEqual(['Whatever']);
    expect(r.instances).toHaveLength(1);
    const inst = r.instances[0];
    expect(inst.key).toBe('Global');
    expect(inst.latest.sessions_active).toEqual({ value: 200, epoch: t0 + 60, datapoint: 'ActiveSessions' });
    expect(inst.latest.sessions_util_pct.value).toBe(20);
    expect(inst.samples.filter((s) => s.metric === 'sessions_active')).toHaveLength(2);
  });

  it('keeps a learned name present in the body and re-matches one that vanished', () => {
    const r = metrics.parseDsBody(body, entry, { sessions_active: 'MaxSessions', sessions_max: 'GoneColumn' });
    expect(r.learned.sessions_active).toBe('MaxSessions');
    // A datapoint belongs to one metric: the vanished column re-matches
    // against the names still free, so it cannot take MaxSessions again.
    expect(r.learned.sessions_max).not.toBe('MaxSessions');
  });

  it('maps nothing when the body has no dataPoints', () => {
    const r = metrics.parseDsBody({ instances: { a: { time: [1], values: [[1]] } } }, entry, null);
    expect(r.instances).toEqual([]);
    expect(r.learned).toEqual({});
  });

  it('stores memory as percent used when LM only gives PercentFree', () => {
    const e = catalogFor('Cisco_MemoryPools_SNMP');
    const r = metrics.parseDsBody({
      dataSourceName: 'Cisco_MemoryPools_SNMP',
      dataPoints: ['PercentFree'],
      instances: { 'Cisco_MemoryPools_SNMP-Processor [ID:1]': { time: [t0 * 1000], values: [[30]] } },
    }, e, null);
    expect(r.instances[0].latest.mem_pct).toEqual({ value: 70, epoch: t0, datapoint: '100-PercentFree' });
  });

  it('prefers the 5 minute CPU datapoint', () => {
    const e = catalogFor('Cisco_CPU_SNMP');
    const r = metrics.parseDsBody({ dataSourceName: 'Cisco_CPU_SNMP', dataPoints: ['CPU1Min', 'CPU5Min'], instances: {} }, e, null);
    expect(r.learned.cpu_pct).toBe('CPU5Min');
  });
});

describe('pollMetrics', () => {
  let spy;
  beforeEach(() => { wipe(); });
  afterEach(() => { if (spy) spy.mockRestore(); spy = null; });

  const sessionsBody = (extra = {}) => ({
    dataSourceName: 'PaloAlto_FW_GlobalSessions',
    dataPoints: ['ActiveSessions', 'MaxSessions', 'SessionUtilization'],
    instances: {
      'PaloAlto_FW_GlobalSessions-Global [ID:1]': { time: [(now() - 120) * 1000, (now() - 60) * 1000], values: [[100, 1000, 10], [150, 1000, 15]] },
      ...extra,
    },
  });

  it('writes latest values and history, then narrows the second call and marks a vanished instance stale', async () => {
    const sid = insertSource();
    insertDevice(sid, 1);
    insertDs(sid, 1, 501, 'PaloAlto_FW_GlobalSessions');
    spy = vi.spyOn(lmApi, 'fetchDsData').mockImplementation(async () => sessionsBody({
      'PaloAlto_FW_GlobalSessions-Second [ID:2]': { time: [(now() - 60) * 1000], values: [[5, 50, 10]] },
    }));
    const r1 = await metrics.pollMetrics(sourceRow(sid));
    expect(r1.ok).toBe(1);
    expect(spy.mock.calls[0][3].datapoints).toBeNull();

    const m = db.prepare("SELECT value, datapoint FROM lm_ds_metrics WHERE source_id = ? AND instance_key = 'Global' AND metric = 'sessions_active'").get(sid);
    expect(m.value).toBe(150);
    expect(m.datapoint).toBe('ActiveSessions');
    expect(db.prepare('SELECT COUNT(*) c FROM lm_ds_instances WHERE source_id = ? AND stale = 0').get(sid).c).toBe(2);
    expect(db.prepare("SELECT COUNT(*) c FROM lm_ds_metrics_history WHERE source_id = ? AND instance_key = 'Global' AND metric = 'sessions_active'").get(sid).c).toBe(2);

    const feat = JSON.parse(sourceRow(sid).features_json);
    expect(feat.dsColumns.PaloAlto_FW_GlobalSessions.sessions_active).toBe('ActiveSessions');
    expect(feat.dsUnmatched.PaloAlto_FW_GlobalSessions).toEqual([]);

    // Second run: narrowed datapoints, only Global comes back, Second goes stale.
    spy.mockImplementation(async () => sessionsBody());
    await metrics.pollMetrics(sourceRow(sid));
    const dp = spy.mock.calls[1][3].datapoints;
    expect(dp.split(',').sort()).toEqual(['ActiveSessions', 'MaxSessions', 'SessionUtilization']);
    const stale = db.prepare("SELECT stale FROM lm_ds_instances WHERE source_id = ? AND instance_key = 'Second'").get(sid);
    expect(stale.stale).toBe(1);
    // Same samples again add no history rows.
    expect(db.prepare("SELECT COUNT(*) c FROM lm_ds_metrics_history WHERE source_id = ? AND instance_key = 'Global' AND metric = 'sessions_active'").get(sid).c).toBe(2);
    expect(db.prepare('SELECT metrics_last_at, metrics_last_error FROM lm_device_datasources WHERE hds_id = 501').get().metrics_last_error).toBeNull();
  });

  it('does not write history for non-history entries', async () => {
    const sid = insertSource();
    insertDevice(sid, 1);
    insertDs(sid, 1, 601, 'PaloAlto_FW_Disk');
    spy = vi.spyOn(lmApi, 'fetchDsData').mockImplementation(async () => ({
      dataSourceName: 'PaloAlto_FW_Disk',
      dataPoints: ['UsedPercent'],
      instances: { 'PaloAlto_FW_Disk-/dev/sda [ID:1]': { time: [(now() - 30) * 1000], values: [[41]] } },
    }));
    await metrics.pollMetrics(sourceRow(sid));
    expect(db.prepare('SELECT COUNT(*) c FROM lm_ds_metrics_history WHERE source_id = ?').get(sid).c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM lm_ds_metrics WHERE source_id = ?').get(sid).c).toBe(1);
  });

  it('honours the data call cap and polls never-polled rows first, oldest next', async () => {
    const sid = insertSource();
    for (let i = 1; i <= 5; i += 1) insertDevice(sid, i);
    insertDs(sid, 1, 701, 'PaloAlto_FW_Disk', { lastAt: '2026-10-01 00:00:00' });
    insertDs(sid, 2, 702, 'PaloAlto_FW_Disk');
    insertDs(sid, 3, 703, 'PaloAlto_FW_Disk', { lastAt: '2026-09-01 00:00:00' });
    insertDs(sid, 4, 704, 'PaloAlto_FW_Disk');
    insertDs(sid, 5, 705, 'PaloAlto_FW_Disk', { lastAt: '2026-10-05 00:00:00' });
    expect(metrics.candidateRows(sourceRow(sid)).map((r) => r.hds_id)).toEqual([702, 704, 703, 701, 705]);

    const issues = require('../services/logicmonitorIssues');
    const capSpy = vi.spyOn(issues, 'getThreshold').mockImplementation((k) => (k === 'lm_metrics_data_calls_per_tick' ? 3 : 14));
    const calledHds = [];
    spy = vi.spyOn(lmApi, 'fetchDsData').mockImplementation(async (s, dev, hds) => {
      calledHds.push(hds);
      return { dataSourceName: 'PaloAlto_FW_Disk', dataPoints: ['UsedPercent'], instances: { 'PaloAlto_FW_Disk-/ [ID:1]': { time: [(now() - 30) * 1000], values: [[40]] } } };
    });
    try {
      const r = await metrics.pollMetrics(sourceRow(sid));
      expect(r.candidates).toBe(5);
      expect(r.polled).toBe(3);
      expect(calledHds).toEqual([702, 704, 703]);
    } finally {
      capSpy.mockRestore();
    }
  });

  it('records metrics_last_error on a throwing device without failing the run', async () => {
    const sid = insertSource();
    insertDevice(sid, 1);
    insertDevice(sid, 2);
    insertDs(sid, 1, 801, 'PaloAlto_FW_Disk');
    insertDs(sid, 2, 802, 'PaloAlto_FW_Disk');
    spy = vi.spyOn(lmApi, 'fetchDsData').mockImplementation(async (s, dev) => {
      if (dev === 1) throw new Error('boom 500');
      return { dataSourceName: 'PaloAlto_FW_Disk', dataPoints: ['UsedPercent'], instances: { 'PaloAlto_FW_Disk-/ [ID:5]': { time: [(now() - 30) * 1000], values: [[55]] } } };
    });
    const r = await metrics.pollMetrics(sourceRow(sid));
    expect(r.ok).toBe(1);
    expect(r.failed).toBe(1);
    expect(db.prepare('SELECT metrics_last_error e FROM lm_device_datasources WHERE hds_id = 801').get().e).toMatch(/boom/);
    expect(db.prepare('SELECT metrics_last_error e FROM lm_device_datasources WHERE hds_id = 802').get().e).toBeNull();
  });

  it('throws when every call fails', async () => {
    const sid = insertSource();
    insertDevice(sid, 1);
    insertDs(sid, 1, 901, 'PaloAlto_FW_Disk');
    spy = vi.spyOn(lmApi, 'fetchDsData').mockRejectedValue(new Error('down'));
    await expect(metrics.pollMetrics(sourceRow(sid))).rejects.toThrow(/every DataSource/);
  });

  it('ignores interfaces, neighbours, stopped, empty, unknown and disabled-family DataSources', async () => {
    const sid = insertSource({ families: JSON.stringify(['loadbalancer']) });
    insertDevice(sid, 1);
    insertDs(sid, 1, 1, 'PaloAlto_FW_Disk'); // firewall family is off
    insertDs(sid, 1, 2, 'F5_BigIP_System', { stop: 1 });
    insertDs(sid, 1, 3, 'F5_BigIP_System', { instances: 0 });
    insertDs(sid, 1, 4, 'F5_BigIP_System', { isInterface: 1 });
    insertDs(sid, 1, 5, 'F5_BigIP_System', { isNeighbor: 1 });
    insertDs(sid, 1, 6, 'Totally_Unknown_DS');
    insertDs(sid, 1, 7, 'F5_BigIP_Memory');
    expect(metrics.candidateRows(sourceRow(sid)).map((r) => r.hds_id)).toEqual([7]);
  });

  it('prune deletes old history and long-stale instances with their metrics', () => {
    const sid = insertSource();
    const old = now() - 40 * 86400;
    const recent = now() - 3600;
    const ins = db.prepare('INSERT INTO lm_ds_metrics_history (source_id, lm_device_id, hds_id, instance_key, metric, value, sampled_at_epoch) VALUES (?, 1, 1, ?, ?, 1, ?)');
    ins.run(sid, 'a', 'cpu_pct', old);
    ins.run(sid, 'a', 'cpu_pct', recent);
    db.prepare("INSERT INTO lm_ds_instances (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, stale, updated_at) VALUES (?, 1, 1, 'X', 'health', 'gone', 1, datetime('now', '-10 days'))").run(sid);
    db.prepare("INSERT INTO lm_ds_instances (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, stale, updated_at) VALUES (?, 1, 1, 'X', 'health', 'fresh', 1, datetime('now', '-1 days'))").run(sid);
    const mi = db.prepare("INSERT INTO lm_ds_metrics (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, metric, value, sampled_at_epoch) VALUES (?, 1, 1, 'X', 'health', ?, 'cpu_pct', 1, 1)");
    mi.run(sid, 'gone');
    mi.run(sid, 'fresh');
    metrics.pruneMetricsHistory(sid);
    expect(db.prepare('SELECT COUNT(*) c FROM lm_ds_metrics_history WHERE source_id = ?').get(sid).c).toBe(1);
    expect(db.prepare('SELECT instance_key k FROM lm_ds_instances WHERE source_id = ?').all(sid).map((r) => r.k)).toEqual(['fresh']);
    expect(db.prepare('SELECT instance_key k FROM lm_ds_metrics WHERE source_id = ?').all(sid).map((r) => r.k)).toEqual(['fresh']);
  });

  it('latestFor groups metrics per instance and historyFor returns the window oldest first', () => {
    const sid = insertSource();
    const insM = db.prepare("INSERT INTO lm_ds_metrics (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, metric, datapoint, value, sampled_at_epoch) VALUES (?, 7, 70, 'F5_BigIP_PoolMemberStats', 'loadbalancer', ?, ?, 'dp', ?, 100)");
    insM.run(sid, 'pool1/10.0.0.1:80', 'member_avail', 1);
    insM.run(sid, 'pool1/10.0.0.1:80', 'member_connections', 12);
    insM.run(sid, 'pool1/10.0.0.2:80', 'member_avail', 0);
    db.prepare("INSERT INTO lm_ds_instances (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, instance_name) VALUES (?, 7, 70, 'F5_BigIP_PoolMemberStats', 'loadbalancer', 'pool1/10.0.0.1:80', 'pool1/10.0.0.1:80')").run(sid);
    const rows = metrics.latestFor(sid, 7, 'loadbalancer');
    expect(rows).toHaveLength(2);
    const first = rows.find((r) => r.instance_key === 'pool1/10.0.0.1:80');
    expect(first.metrics.member_connections.value).toBe(12);
    expect(first.metrics.member_avail.datapoint).toBe('dp');
    expect(metrics.latestFor(sid, 7, 'firewall')).toEqual([]);

    const h = db.prepare('INSERT INTO lm_ds_metrics_history (source_id, lm_device_id, hds_id, instance_key, metric, value, sampled_at_epoch) VALUES (?, 7, 70, ?, ?, ?, ?)');
    h.run(sid, 'k', 'cpu_pct', 2, now() - 600);
    h.run(sid, 'k', 'cpu_pct', 1, now() - 1200);
    h.run(sid, 'k', 'cpu_pct', 9, now() - 7200);
    const series = metrics.historyFor(sid, 7, 70, 'k', 'cpu_pct', 1);
    expect(series.map((x) => x.value)).toEqual([1, 2]);
  });
});

describe('round 8 QA: one datapoint per metric, shortest name wins', () => {
  it('does not let a threshold datapoint satisfy the gauge it qualifies', () => {
    const { parseDsBody } = require('../services/logicmonitorMetrics');
    const { catalogFor } = require('../services/logicmonitorCatalog');
    const entry = catalogFor('Cisco_Transceiver_Sensors');
    const body = { dataSourceName: 'Cisco_Transceiver_Sensors', dataPoints: ['RxPowerLowWarn', 'RxPower', 'TxPower', 'Temperature'],
      instances: { 'Cisco_Transceiver_Sensors-Te1/1/1 [ID:9]': { time: [1700000000000], values: [[-14.5, -3.2, -2.1, 31]] } } };
    const out = parseDsBody(body, entry, null);
    expect(out.learned.rx_power_dbm).toBe('RxPower');
    expect(out.learned.rx_low_warn).toBe('RxPowerLowWarn');
    expect(out.learned.tx_power_dbm).toBe('TxPower');
    expect(Object.values(out.learned).length).toBe(new Set(Object.values(out.learned)).size);
    expect(out.instances[0].latest.rx_power_dbm.value).toBe(-3.2);
    expect(out.instances[0].latest.rx_low_warn.value).toBe(-14.5);
  });
});
