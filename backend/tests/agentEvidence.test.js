import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const db = require('../db/database');
const registry = require('../core/registry');
const evidence = require('../services/agentEvidence');

const NOW = Date.now();
const ISO = (offsetMin = 0) => new Date(NOW + offsetMin * 60000).toISOString();
const ZL = (offsetMin = 0) => ISO(offsetMin).replace('T', ' ').slice(0, 19);

const TABLES = [
  'vcenter_issue_history', 'vcenter_events', 'vcenter_host_daily', 'vcenter_vm_daily', 'vcenter_vms', 'vcenter_hosts', 'vcenter_vcenters',
  'alerts', 'cohesity_nodes', 'protection_runs', 'replication_runs', 'cohesity_objects', 'clusters',
  'pure_alerts', 'pure_hardware', 'pure_metrics_history', 'pure_arrays',
  'netapp_alerts', 'netapp_snapmirror', 'netapp_lifs', 'netapp_volumes', 'netapp_aggregates', 'netapp_metrics_history', 'netapp_arrays',
  'zerto_events', 'zerto_alerts', 'zerto_vpgs', 'zerto_sites',
  'dell_hardware_logs', 'dell_alerts', 'dell_components', 'dell_devices', 'dell_ome_instances',
  'brocade_issue_history', 'brocade_events', 'brocade_port_stats', 'brocade_device_ports', 'brocade_switch_ports', 'brocade_switches', 'brocade_sources',
];

function ins(table, row) {
  const keys = Object.keys(row);
  const info = db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => row[k]));
  return Number(info.lastInsertRowid);
}

const realGetPlugin = registry.getPlugin;
beforeEach(() => {
  for (const t of TABLES) db.exec(`DELETE FROM ${t}`);
  registry.getPlugin = () => ({ enabled: true, status: 'ok' });
});
afterEach(() => { registry.getPlugin = realGetPlugin; });

const ctxFor = (platform, host, alerts = [], extra = {}) => ({
  platforms: [platform], hosts: [{ host, platform }], subject: host, anchorMs: NOW - 3600000,
  alerts: alerts.map((a) => ({ platform, host, type: null, message: 'alert', first_seen: ISO(-60), ...a })), budgets: {}, ...extra,
});
const FACT_KEYS = ['state', 'since', 'openedTimes30d', 'meanMinutesOpen30d', 'metric', 'protection', 'replication'];
const factsOk = (b) => expect(Object.keys(b.facts).sort()).toEqual([...FACT_KEYS].sort());

function seedVcenter() {
  ins('vcenter_vcenters', { id: 1, name: 'vc01', host: 'vc01.lab', username: 'u', encrypted_credentials: 'x' });
  ins('vcenter_hosts', {
    vcenter_id: 1, host_id: 'h1', name: 'esx-01', cluster_name: 'PROD-A', connection_state: 'notResponding', in_maintenance: 0, vm_count: 14,
    cpu_mhz_capacity: 10000, cpu_mhz_used: 7800, mem_bytes_capacity: 100, mem_bytes_used: 50,
  });
  for (let i = 0; i < 14; i += 1) {
    ins('vcenter_vms', { vcenter_id: 1, vm_id: `vm${i}`, name: `vm-${i}`, host_name: 'esx-01', cluster_name: 'PROD-A', power_state: 'poweredOff' });
  }
  const day = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 10);
  for (let n = 1; n <= 5; n += 1) {
    ins('vcenter_host_daily', {
      vcenter_id: 1, host_name: 'esx-01', day: day(n), samples: 10, cpu_samples: 10, cpu_sum_mhz: 41000, cpu_max_mhz: 7800, cpu_capacity_mhz_last: 10000,
    });
  }
  const issue = (first, resolved) => ins('vcenter_issue_history', {
    issue_key: 'host-down|vc01|esx-01', vcenter: 'vc01', severity: 'critical', type: 'host-down', target: 'esx-01', message: 'down',
    status: resolved ? 'resolved' : 'open', first_seen: first, last_seen: first, resolved_at: resolved,
  });
  issue(ZL(-3 * 1440), ZL(-3 * 1440 + 30));
  issue(ZL(-1440), ZL(-1440 + 90));
  issue(ZL(-60), null);
  ins('vcenter_events', { vcenter_id: 1, event_key: 'e1', event_type: 'HostConnectionLostEvent', severity: 'error', message: 'Host connection lost', entity_name: 'esx-01', created_at: ISO(-55) });
}

describe('agentEvidence providers', () => {
  it('vcenter: an ESX host with placement, 30-day CPU, an event and issue history', () => {
    seedVcenter();
    const b = require('../services/agentEvidence/vcenter').run(db, ctxFor('vcenter', 'esx-01', [{ source_key: 'v:host-down|vc01|esx-01', type: 'host-down' }]));
    console.log('vcenter first line:', b.lines[0]);
    expect(b.lines[0]).toMatch(/^ESX host esx-01 \(cluster PROD-A, vc01\): connection notResponding since .*14 VMs placed, 0 powered on now, CPU now 78%/);
    expect(b.lines.some((l) => /^vCenter event .* HostConnectionLostEvent on esx-01: Host connection lost/.test(l))).toBe(true);
    expect(b.lines.some((l) => /^Issue host-down on esx-01 opened 3 times in 30 days, mean 60 minutes open/.test(l))).toBe(true);
    expect(b.facts.metric).toMatchObject({ name: 'cpu', now: 78, avg30d: 41, max30d: 78, unit: '%' });
    expect(b.facts.openedTimes30d).toBe(3);
    factsOk(b);
  });

  it('cohesity: a cluster with nodes, alerts, runs and replication; an object with its group', () => {
    const cid = ins('clusters', { name: 'cl-01', connection_type: 'direct', vip: '10.0.0.5', auth_type: 'userpass', encrypted_credentials: 'x' });
    for (const n of ['n1', 'n2', 'n3']) ins('cohesity_nodes', { cluster_id: cid, node_id: n, hostname: n, status: n === 'n3' ? 'Degraded' : 'Healthy', captured_at: ISO() });
    ins('alerts', { cluster_id: cid, cohesity_alert_id: 'a1', severity: 'kCritical', alert_type: 'Disk', description: 'Disk failure on node n3', resolved: 0, dismissed: 0, first_seen: ISO(-30) });
    ins('alerts', { cluster_id: cid, cohesity_alert_id: 'a2', severity: 'kWarning', alert_type: 'Space', description: 'Space is low', resolved: 0, dismissed: 0, first_seen: ISO(-20) });
    ins('protection_runs', { cluster_id: cid, job_id: 1, job_name: 'PROD-VMs', status: 'Failed', start_time: ISO(-40), error_message: 'snapshot timeout' });
    ins('replication_runs', { protection_run_id: 1, cluster_id: cid, target_cluster_name: 'cl-dr', status: 'Succeeded', start_time: ISO(-130), end_time: ISO(-125), lag_seconds: 7500 });
    ins('cohesity_objects', {
      cluster_id: cid, object_id: 7, name: 'vm-a', is_protected: 1, protection_groups: 'PROD-VMs', last_backup_status: 'Failed',
      last_backup_ms: NOW - 26 * 3600000, captured_at: ISO(),
    });
    const mod = require('../services/agentEvidence/cohesity');
    const b = mod.run(db, ctxFor('cohesity', 'cl-01'));
    console.log('cohesity first line:', b.lines[0]);
    expect(b.lines[0]).toMatch(/^Cluster cl-01 \(vip 10\.0\.0\.5, direct\): 3 nodes \(not healthy: n3 Degraded\), 2 open alerts in 24 h \(1 critical\), newest:/);
    expect(b.lines.some((l) => /^Replication cl-01 -> cl-dr: newest run Succeeded .*lag 2 h 5 m/.test(l))).toBe(true);
    expect(b.facts.replication).toEqual({ kind: 'cohesity', lagMinutes: 125, status: 'Succeeded' });
    factsOk(b);
    const o = mod.run(db, ctxFor('cohesity', 'vm-a'));
    console.log('cohesity object line:', o.lines[0]);
    expect(o.lines[0]).toMatch(/^Object vm-a: group PROD-VMs on cl-01, last good backup 26 hours ago, newest run Failed .*: snapshot timeout/);
    expect(o.facts.protection).toMatchObject({ kind: 'cohesity', lastRunStatus: 'Failed' });
  });

  it('pure: an array with capacity span, alerts and hardware not ok', () => {
    const aid = ins('pure_arrays', { name: 'fa-01', mgmt_host: 'fa-01.lab', client_id: 'c', key_id: 'k', username: 'u', issuer: 'i', encrypted_credentials: 'x' });
    ins('pure_metrics_history', { array_id: aid, captured_at: ZL(-3 * 1440), capacity_bytes: 1000, used_bytes: 640, purity_version: '6.4.10' });
    ins('pure_metrics_history', { array_id: aid, captured_at: ZL(-5), capacity_bytes: 1000, used_bytes: 710, purity_version: '6.4.10' });
    ins('pure_alerts', { array_id: aid, pure_alert_id: 11, severity: 'warning', category: 'hardware', component_name: 'CH0.PWR1', summary: 'Power supply failed', state: 'open', created_at_ms: NOW - 1800000, updated_at_ms: NOW });
    ins('pure_alerts', { array_id: aid, pure_alert_id: 12, severity: 'info', category: 'array', summary: 'Old one', state: 'closed', created_at_ms: NOW - 5 * 86400000, updated_at_ms: NOW });
    ins('pure_hardware', { array_id: aid, name: 'PSU1', type: 'power_supply', status: 'failed' });
    ins('pure_hardware', { array_id: aid, name: 'FAN1', type: 'cooling', status: 'ok' });
    const b = require('../services/agentEvidence/pure').run(db, ctxFor('pure', 'fa-01'));
    console.log('pure first line:', b.lines[0]);
    expect(b.lines[0]).toMatch(/^Pure array fa-01 \(purity 6\.4\.10\): capacity 71% \(30-day 64% to 71%\), 1 alerts in 24 h \(hardware\), hardware: 1 component\(s\) not ok \(PSU1 failed\)/);
    expect(b.facts.metric).toMatchObject({ name: 'capacity', now: 71, max30d: 71 });
    expect(b.facts.openedTimes30d).toBe(2);
    factsOk(b);
  });

  it('netapp: aggregates, volumes, SnapMirror lag and LIFs down', () => {
    const aid = ins('netapp_arrays', { name: 'nacl-01', mgmt_host: 'nacl-01.lab', username: 'u', encrypted_credentials: 'x', version: '9.14.1P3' });
    ins('netapp_metrics_history', { array_id: aid, captured_at: ZL(-5), total_bytes: 1000, used_bytes: 800, ontap_version: '9.14.1P3' });
    ins('netapp_aggregates', { array_id: aid, name: 'aggr1', used_percent: 88, captured_at: ZL() });
    ins('netapp_volumes', { array_id: aid, name: 'vol_prod', svm_name: 'svm1', used_percent: 94, captured_at: ZL() });
    ins('netapp_snapmirror', {
      array_id: aid, source_path: 'svm1:vol_prod', destination_path: 'svm2:vol_prod_dr', healthy: 0, lag_seconds: 11520, transfer_state: 'transfer error', captured_at: ZL(),
    });
    ins('netapp_lifs', { array_id: aid, name: 'lif_nfs_02', svm_name: 'svm1', state: 'down', enabled: 1, captured_at: ZL() });
    ins('netapp_alerts', { array_id: aid, alert_key: 'k1', severity: 'critical', node_name: 'nacl-01-01', source: 'vol', message: 'Volume vol_prod is nearly full' });
    const b = require('../services/agentEvidence/netapp').run(db, ctxFor('netapp', 'nacl-01'));
    console.log('netapp first line:', b.lines[0]);
    expect(b.lines[0]).toMatch(/^NetApp cluster nacl-01 \(ONTAP 9\.14\.1P3\): capacity 80%.*aggregates over 80%: aggr1 88%, volumes over 90%: vol_prod \(94%\)/);
    expect(b.lines.some((l) => /^SnapMirror svm1:vol_prod -> svm2:vol_prod_dr: lag 3 h 12 m, healthy no \(transfer error\)/.test(l))).toBe(true);
    expect(b.lines.some((l) => /LIFs down: lif_nfs_02/.test(l))).toBe(true);
    expect(b.facts.replication).toEqual({ kind: 'snapmirror', lagMinutes: 192, status: 'unhealthy' });
    factsOk(b);
  });

  it('zerto: a VPG with RPO against the configured target, status and sites', () => {
    ins('zerto_vpgs', {
      vpg_identifier: 'v1', name: 'PROD-DB', vms_count: 6, protected_site: 'NYC', recovery_site: 'DR-SITE', actual_rpo: 1840, configured_rpo: 300,
      status: 'NotMeetingSLA', actual_journal_history: 7200, configured_journal_history: 86400,
    });
    ins('zerto_alerts', { alert_identifier: 'a1', alert_type: 'VPG0001', severity: 'Warning', description: 'RPO is above the SLA', site_name: 'NYC', collection_time: ISO(-30) });
    ins('zerto_events', { event_identifier: 'e1', category: 'Alerts', event_type: 'RpoViolation', description: 'RPO violated for PROD-DB', occurred_on: ISO(-45), site_name: 'NYC' });
    const b = require('../services/agentEvidence/zerto').run(db, ctxFor('zerto', 'PROD-DB'));
    console.log('zerto first line:', b.lines[0]);
    expect(b.lines[0]).toMatch(/^Zerto VPG PROD-DB: RPO 1840 s against 300 s configured, journal history 7200 of 86400 \(as reported\), status NotMeetingSLA, 6 VMs, protected site NYC, recovery site DR-SITE/);
    expect(b.lines.some((l) => /^Zerto event .* RpoViolation: RPO violated for PROD-DB/.test(l))).toBe(true);
    expect(b.facts.replication).toMatchObject({ kind: 'zerto', lagMinutes: 31, status: 'NotMeetingSLA' });
    factsOk(b);
  });

  it('dell: a server with components not ok, OME alerts and a hardware log', () => {
    ins('dell_ome_instances', { id: 1, name: 'ome', host: 'ome.lab', username: 'u', encrypted_credentials: 'x' });
    ins('dell_devices', {
      ome_id: 1, device_id: 100, service_tag: 'ABC1234', name: 'R740-07', model: 'R740', health: 'Critical', power_state: 'On', connection_state: 'On', ip_address: '10.0.1.7',
    });
    ins('dell_components', { ome_id: 1, device_id: 100, kind: 'psu', name: 'PSU2', status: 'Critical' });
    ins('dell_components', { ome_id: 1, device_id: 100, kind: 'fan', name: 'Fan3', status: 'Warning' });
    ins('dell_components', { ome_id: 1, device_id: 100, kind: 'fan', name: 'Fan1', status: 'OK' });
    ins('dell_alerts', { ome_id: 1, alert_id: '9', severity: 'Critical', status: 'new', category: 'Power', message: 'The power supply 2 lost input power', device_name: 'R740-07', service_tag: 'ABC1234', created_at: ZL(-50) });
    ins('dell_hardware_logs', { ome_id: 1, device_id: 100, log_id: 'l1', severity: 'Critical', message_id: 'PSU0002', message: 'Power supply 2 lost input', created_at: ZL(-55) });
    const b = require('../services/agentEvidence/dell').run(db, ctxFor('dell', 'R740-07'));
    console.log('dell first line:', b.lines[0]);
    expect(b.lines[0]).toMatch(/^Dell R740-07 \(ABC1234\) R740: health Critical, power On, connection On, iDRAC 10\.0\.1\.7, components not ok: PSU2 Critical, Fan3 Warning/);
    expect(b.lines.some((l) => /^Hardware log .* PSU0002 Critical: Power supply 2 lost input/.test(l))).toBe(true);
    expect(b.lines.some((l) => /^1 OME alerts in 24 h \(Power\)/.test(l))).toBe(true);
    factsOk(b);
  });

  it('brocade: a switch with ports down, a host port with CRC counts, events and issue history', () => {
    ins('brocade_sources', { id: 1, name: 'sannav', host: 'sannav.lab' });
    ins('brocade_switches', { source_id: 1, wwn: 'sw-wwn', name: 'sw-a', firmware_version: '9.1.1c', status: 'healthy', fabric_name: 'FAB1', ip_address: '10.0.2.1' });
    ins('brocade_switch_ports', { source_id: 1, wwn: 'p-1', switch_wwn: 'sw-wwn', switch_name: 'sw-a', slot_number: 3, port_number: 12, state: 'Online', speed: '32G' });
    ins('brocade_switch_ports', { source_id: 1, wwn: 'p-2', switch_wwn: 'sw-wwn', switch_name: 'sw-a', slot_number: 3, port_number: 13, state: 'Offline', occupied: 1 });
    ins('brocade_device_ports', { source_id: 1, wwn: 'd-1', fdmi_host_name: 'esx-01', switch_name: 'sw-a', switch_port_wwn: 'p-1', slot_number: 3, port_number: 12 });
    ins('brocade_port_stats', { source_id: 1, port_wwn: 'p-1', ts: ZL(-30), crc_errors_delta: 1240, invalid_words: 5 });
    ins('brocade_events', { source_id: 1, event_id: 'e1', severity_norm: 'warning', source_name: 'sw-a', description: 'Port 3/12 CRC threshold exceeded', last_occurred_ms: NOW - 1200000 });
    for (const [f, r] of [[ZL(-2 * 1440), ZL(-2 * 1440 + 20)], [ZL(-1440), ZL(-1440 + 40)], [ZL(-60), null]]) {
      ins('brocade_issue_history', { source_id: 1, source: 'sannav', type: 'host_link_down', target: 'esx-01', severity: 'warning', message: 'link down', first_seen: f, last_seen: f, resolved_at: r });
    }
    const ctx = ctxFor('brocade', 'esx-01', [{ source_key: 'brocade:1:host_link_down:esx-01', type: 'host_link_down' }]);
    const b = require('../services/agentEvidence/brocade').run(db, ctx);
    console.log('brocade first line:', b.lines[0]);
    expect(b.lines[0]).toMatch(/^Brocade switch sw-a \(fabric FAB1, FOS 9\.1\.1c\): status healthy, 2 ports, 1 down/);
    expect(b.lines.some((l) => /^Port sw-a 3\/12 for esx-01: state Online at 32G, CRC errors 1240 in 24 h, invalid words 5 in 24 h/.test(l))).toBe(true);
    expect(b.lines.some((l) => /^Events: 1 in 24 h \(0 critical, 1 warning\)/.test(l))).toBe(true);
    expect(b.lines.some((l) => /^Issue host_link_down on esx-01 opened 3 times in 30 days, mean 30 minutes open/.test(l))).toBe(true);
    factsOk(b);
  });

  it('vcenter: the incident subject host wins over the first alerting VM and its children are summarised', () => {
    seedVcenter();
    const alerts = ['vm-0', 'vm-1', 'vm-2'].map((n) => ({ host: n, source_key: `v:guest-volume-full|vc01|${n}`, type: 'guest-volume-full' }));
    const ctx = { ...ctxFor('vcenter', 'esx-01', alerts), hosts: [{ host: 'vm-0', platform: 'vcenter' }] };
    const b = require('../services/agentEvidence/vcenter').run(db, ctx);
    expect(b.lines[0]).toMatch(/^ESX host esx-01 /);
    expect(b.lines.some((l) => l === '3 VMs on this host alerting: vm-0, vm-1, vm-2')).toBe(true);
  });

  it('returns null for an unknown subject', () => {
    seedVcenter();
    for (const p of evidence.PROVIDERS) expect(p.run(db, ctxFor(p.platform, 'no-such-thing'))).toBeNull();
  });
});

describe('agentEvidence gather', () => {
  const fakeBlock = (platform, n, width = 150) => ({
    platform, subject: 's', title: `${platform} block`, lines: Array.from({ length: n }, (_, i) => `${platform} line ${i} ${'x'.repeat(width)}`), facts: {},
  });
  let saved;
  beforeEach(() => { saved = evidence.PROVIDERS.map((p) => p.run); });
  afterEach(() => { evidence.PROVIDERS.forEach((p, i) => { p.run = saved[i]; }); });

  it('respects platformLines', () => {
    evidence.PROVIDERS.find((p) => p.platform === 'vcenter').run = () => fakeBlock('vcenter', 12, 10);
    const r = evidence.gather(db, { platforms: ['vcenter'], hosts: [], alerts: [], budgets: { vcenter: { platformLines: 4 } } });
    expect(r.blocks[0].lines).toHaveLength(4);
    const d = evidence.gather(db, { platforms: ['vcenter'], hosts: [], alerts: [], budgets: {} });
    expect(d.blocks[0].lines).toHaveLength(12);
  });

  it('gather caps total chars at 6000', () => {
    for (const id of ['vcenter', 'pure', 'netapp', 'zerto']) evidence.PROVIDERS.find((p) => p.platform === id).run = () => fakeBlock(id, 12, 150);
    const r = evidence.gather(db, { platforms: ['vcenter', 'pure', 'netapp', 'zerto'], hosts: [], alerts: [], budgets: {} });
    expect(r.chars).toBeLessThanOrEqual(evidence.PLATFORM_EVIDENCE_CHAR_CAP);
    expect(r.blocks).toHaveLength(4);
    expect(r.blocks.every((b) => b.lines.length >= 2)).toBe(true);
    expect(r.blocks[0].lines.length).toBeGreaterThan(r.blocks[3].lines.length - 1);
  });

  it('a provider whose platform is off is skipped', () => {
    for (const id of ['vcenter', 'pure']) evidence.PROVIDERS.find((p) => p.platform === id).run = () => fakeBlock(id, 3);
    registry.getPlugin = (id) => ({ enabled: id !== 'pure', status: 'ok' });
    const r = evidence.gather(db, { platforms: ['vcenter', 'pure'], hosts: [], alerts: [], budgets: {} });
    expect(r.blocks.map((b) => b.platform)).toEqual(['vcenter']);
  });

  it('a provider that throws does not break the others', () => {
    evidence.PROVIDERS.find((p) => p.platform === 'vcenter').run = () => { throw new Error('boom'); };
    evidence.PROVIDERS.find((p) => p.platform === 'pure').run = () => fakeBlock('pure', 3);
    const r = evidence.gather(db, { platforms: ['vcenter', 'pure'], hosts: [], alerts: [], budgets: {} });
    expect(r.blocks.map((b) => b.platform)).toEqual(['pure']);
  });

  it('adds the parent platform of a blast radius even when it is not in the incident', () => {
    evidence.PROVIDERS.find((p) => p.platform === 'dell').run = () => fakeBlock('dell', 3);
    const r = evidence.gather(db, { platforms: ['vcenter'], parentPlatform: 'dell', hosts: [], alerts: [], budgets: {} });
    expect(r.blocks.map((b) => b.platform)).toEqual(['dell']);
  });
});
