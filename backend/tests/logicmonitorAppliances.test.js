/**
 * LogicMonitor round 11, WP-V: voice, Zscaler and Cisco ISE appliances.
 * Catalog entries (security family, SBC pools, GANC checks, SIP error history),
 * the seven issue types, the estate-majority polarity rule for status metrics,
 * the ZSDC city parser and the fact builders. Datapoint names and enums are
 * UNVERIFIED against a live portal; rows are seeded by hand.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const { encrypt } = require('../services/encryption');
const lmIssues = require('../services/logicmonitorIssues');
const catalog = require('../services/logicmonitorCatalog');
const A = require('../services/logicmonitorAppliances');

const TABLES = ['lm_alerts', 'lm_issue_history', 'lm_ds_metrics_history', 'lm_ds_metrics', 'lm_ds_instances', 'lm_device_datasources', 'lm_devices', 'lm_sources'];

let sid;
let hdsSeq;

beforeAll(() => {
  runMigrations(db, 'logicmonitor', lmMigrations);
});

beforeEach(() => {
  for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("DELETE FROM app_settings WHERE key LIKE 'lm_%'").run();
  sid = db.prepare('INSERT INTO lm_sources (name, company, auth_mode, encrypted_credentials) VALUES (?, ?, ?, ?)')
    .run('Acme', 'acme', 'lmv1', encrypt(JSON.stringify({ accessId: 'a', accessKey: 'b' }))).lastInsertRowid;
  hdsSeq = 3000;
});

function dev(id, name, over = {}) {
  db.prepare(`INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, hostname, device_type, host_status, sdt_status, vendor, role, is_network, site_key, ips_json, stale)
    VALUES (?, ?, ?, ?, ?, 0, 'normal', ?, 'Net-SNMP', 'server', 0, 'phoenix', '[]', 0)`)
    .run(sid, id, name, name, name, over.sdt || 'none-none-none');
}

function m(devId, ds, family, instance, metric, value, datapoint = null) {
  const hds = (db.prepare('SELECT hds_id FROM lm_ds_instances WHERE source_id = ? AND lm_device_id = ? AND datasource_name = ? LIMIT 1').get(sid, devId, ds) || {}).hds_id || (hdsSeq += 1);
  db.prepare(`INSERT OR IGNORE INTO lm_ds_instances (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, instance_name, stale)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)`).run(sid, devId, hds, ds, family, instance, instance);
  db.prepare(`INSERT OR REPLACE INTO lm_ds_metrics (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, metric, datapoint, value, sampled_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sid, devId, hds, ds, family, instance, metric, datapoint || metric, value, Math.floor(Date.now() / 1000) - 60);
  return hds;
}

const issuesOf = (type) => lmIssues.computeIssues().filter((i) => i.type === type);

describe('catalog', () => {
  it('registers the security family and matches the ISE, ZPA and ASA DataSources', () => {
    expect(catalog.FAMILIES).toContain('security');
    expect(catalog.FAMILY_LABELS.security).toBe('Security appliances (via LogicMonitor)');
    for (const name of ['Cisco_ISE_ServerSessions', 'Cisco_ISE_Disk', 'ntm_ise_application_and_certificate_status', 'ntm_cisco_ise_eap_certificate',
      'ntm_deployment_nodes_status', 'ntm_cisco_ise_memory_cpu', 'ntm_zpa_app_connector', 'Zscaler ZPA Port Exhaustion', 'ntm_zpa_ntp_time_sync', 'ntm_asa_license_authorization']) {
      expect(catalog.catalogFor(name)?.family, name).toBe('security');
    }
    expect(Object.keys(catalog.catalogFor('ntm_cisco_ise_memory_cpu').metrics)).toEqual(['cpu_pct', 'mem_pct']);
  });

  it('gives the SBC steering pools and the GANC checks voice entries, and keeps the other SBC DataSources on the loose entry', () => {
    expect(catalog.catalogFor('ntm_sbc_steering_pool_performance').metrics).toHaveProperty('sbc_pool_util_pct');
    expect(catalog.catalogFor('ntm_ganc_mobility_domain_check').family).toBe('voice');
    expect(catalog.catalogFor('ntm_ganc_ise_radius_check').metrics).toHaveProperty('ganc_radius_state');
    expect(catalog.catalogFor('ntm_sbc_fan_state').metrics).toHaveProperty('sbc_fan_state');
  });

  it('stores history for the SIP error counters so a rate can be read', () => {
    expect(catalog.catalogFor('Cisco_SIP_Server_Errors').history).toBe(true);
    expect(catalog.catalogFor('Cisco_SIP_Client_Errors').history).toBe(true);
  });

  it('claims ISE certificate days and ZPA port use by loose datapoint names', () => {
    const { parseDsBody } = require('../services/logicmonitorMetrics');
    const ise = parseDsBody({ dataPoints: ['AdminCertDaysLeft', 'AppStatus'], instances: {} }, catalog.catalogFor('ntm_ise_application_and_certificate_status'));
    expect(ise.learned).toMatchObject({ cert_days: 'AdminCertDaysLeft', app_state: 'AppStatus' });
    const zpa = parseDsBody({ dataPoints: ['PortsUsedPercent'], instances: {} }, catalog.catalogFor('Zscaler ZPA Port Exhaustion'));
    expect(zpa.learned).toMatchObject({ port_used_pct: 'PortsUsedPercent' });
  });
});

describe('helpers', () => {
  it('parses the ZSDC city and falls back to the code', () => {
    expect(A.zsdcCity('ZSDC_AMS3-Amsterdam-uptime')).toEqual({ code: 'AMS3', city: 'Amsterdam' });
    expect(A.zsdcCity('ZSDC_SJC1-San Jose I -uptime')).toEqual({ code: 'SJC1', city: 'San Jose I' });
    expect(A.zsdcCity('ZSDC_LHR2-uptime')).toEqual({ code: 'LHR2', city: 'LHR2' });
    expect(A.isZsdc('zsdc_x-y')).toBe(true);
    expect(A.isZsdc('Public website')).toBe(false);
  });

  it('reads states: 3 or more is not healthy, a score under 70 is not healthy, null is never bad', () => {
    expect(A.stateBad(2)).toBe(false);
    expect(A.stateBad(3)).toBe(true);
    expect(A.stateBad(-1)).toBe(true);
    expect(A.stateBad(null)).toBe(false);
    expect(A.stateBad(85, 'HealthScore')).toBe(false);
    expect(A.stateBad(40, 'HealthScore')).toBe(true);
  });

  it('learns polarity from the estate: zero is down only when most instances read non-zero', () => {
    expect(A.readsDown(0, 1)).toBe(true);
    expect(A.readsDown(0, 0)).toBe(false);
    expect(A.readsDown(1, 0)).toBe(false);
    expect(A.readsDown(null, 1)).toBe(false);
    const index = new Map([['1:1', { instances: new Map([['a', { m: { connector_state: { value: 1 } } }], ['b', { m: { connector_state: { value: 1 } } }], ['c', { m: { connector_state: { value: 0 } } }]]) }]]);
    expect(A.modeMap(index, ['connector_state']).get('connector_state')).toBe(1);
  });
});

describe('voice issues', () => {
  it('raises voice-sbc-degraded for a fan state of 3 or more and prints the raw value', () => {
    dev(1, 'phx-sbc-01');
    m(1, 'ntm_sbc_system_health', 'voice', 'system', 'sbc_health_state', 1);
    m(1, 'ntm_sbc_fan_state', 'voice', 'fan1', 'sbc_fan_state', 2);
    m(1, 'ntm_sbc_fan_state', 'voice', 'fan2', 'sbc_fan_state', 5);
    const rows = issuesOf('voice-sbc-degraded');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: 'warning', target: 'phx-sbc-01 fan2' });
    expect(rows[0].message).toContain('reads 5');
    expect(rows[0].message).toContain('enum unverified');
  });

  it('flags the health state itself and folds many faulty components into one issue', () => {
    dev(1, 'phx-sbc-01');
    m(1, 'ntm_sbc_system_health', 'voice', 'system', 'sbc_health_state', 4);
    expect(issuesOf('voice-sbc-degraded').map((i) => i.target)).toEqual(['phx-sbc-01']);
    for (let i = 1; i <= 7; i += 1) m(1, 'ntm_sbc_temperature', 'voice', `t${i}`, 'sbc_temp_c', 40);
    for (let i = 1; i <= 7; i += 1) m(1, 'ntm_sbc_fan_state', 'voice', `fan${i}`, 'sbc_fan_state', 6);
    const rows = issuesOf('voice-sbc-degraded');
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toMatch(/^8 SBC components/);
  });

  it('raises nothing for a healthy SBC or a device in scheduled downtime', () => {
    dev(1, 'phx-sbc-01');
    m(1, 'ntm_sbc_fan_state', 'voice', 'fan1', 'sbc_fan_state', 2);
    expect(issuesOf('voice-sbc-degraded')).toEqual([]);
    dev(2, 'dal-sbc-01', { sdt: 'SDT-none-none' });
    m(2, 'ntm_sbc_fan_state', 'voice', 'fan1', 'sbc_fan_state', 9);
    expect(issuesOf('voice-sbc-degraded')).toEqual([]);
  });

  it('raises voice-sip-errors only when counter history grows over 1 per second', () => {
    dev(1, 'phx-cube-01');
    dev(2, 'dal-cube-01');
    const hist = (devId, hds, perSec) => {
      const stmt = db.prepare('INSERT INTO lm_ds_metrics_history (source_id, lm_device_id, hds_id, instance_key, metric, value, sampled_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const now = Math.floor(Date.now() / 1000);
      stmt.run(sid, devId, hds, 'sip', 'sip_server_int_error', 1000, now - 3600);
      stmt.run(sid, devId, hds, 'sip', 'sip_server_int_error', 1000 + perSec * 3600, now);
    };
    hist(1, m(1, 'Cisco_SIP_Server_Errors', 'voice', 'sip', 'sip_server_int_error', 5000), 0.4);
    hist(2, m(2, 'Cisco_SIP_Server_Errors', 'voice', 'sip', 'sip_server_int_error', 9000), 3);
    const rows = issuesOf('voice-sip-errors');
    expect(rows.map((r) => r.target)).toEqual(['dal-cube-01']);
    expect(rows[0].message).toContain('3 per second');
  });

  it('reads no SIP error rate from a single sample or a counter reset', () => {
    dev(1, 'phx-cube-01');
    const hds = m(1, 'Cisco_SIP_Server_Errors', 'voice', 'sip', 'sip_server_int_error', 5000);
    const stmt = db.prepare('INSERT INTO lm_ds_metrics_history (source_id, lm_device_id, hds_id, instance_key, metric, value, sampled_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const now = Math.floor(Date.now() / 1000);
    stmt.run(sid, 1, hds, 'sip', 'sip_server_int_error', 900000, now - 600);
    stmt.run(sid, 1, hds, 'sip', 'sip_server_int_error', 40, now);
    expect(issuesOf('voice-sip-errors')).toEqual([]);
  });
});

describe('ISE, ZPA and ASA issues', () => {
  it('raises ise-cert-expiring as warning under the threshold and critical under 7 days', () => {
    dev(1, 'phx-ipsn-1');
    m(1, 'ntm_ise_application_and_certificate_status', 'security', 'admin', 'cert_days', 12);
    m(1, 'ntm_ise_application_and_certificate_status', 'security', 'portal', 'cert_days', 5);
    m(1, 'ntm_cisco_ise_eap_certificate', 'security', 'eap', 'eap_cert_days', 200);
    const rows = issuesOf('ise-cert-expiring');
    expect(rows.map((r) => [r.target, r.severity])).toEqual(expect.arrayContaining([['phx-ipsn-1 certificate admin', 'warning'], ['phx-ipsn-1 certificate portal', 'critical']]));
    expect(rows).toHaveLength(2);
    m(1, 'ntm_cisco_ise_eap_certificate', 'security', 'eap', 'eap_cert_days', -3);
    expect(issuesOf('ise-cert-expiring').find((r) => r.target.includes('EAP')).message).toContain('expired 3 days ago');
  });

  it('raises ise-node-down only when the estate majority reads non-zero', () => {
    for (const id of [1, 2, 3]) dev(id, `ipsn-${id}`);
    m(1, 'ntm_deployment_nodes_status', 'security', 'node', 'node_state', 1);
    m(2, 'ntm_deployment_nodes_status', 'security', 'node', 'node_state', 1);
    m(3, 'ntm_deployment_nodes_status', 'security', 'node', 'node_state', 0);
    expect(issuesOf('ise-node-down').map((r) => [r.target, r.severity])).toEqual([['ipsn-3 node', 'critical']]);
    // Every node reading 0 looks like a 0 = ok convention: no issue.
    m(1, 'ntm_deployment_nodes_status', 'security', 'node', 'node_state', 0);
    m(2, 'ntm_deployment_nodes_status', 'security', 'node', 'node_state', 0);
    expect(issuesOf('ise-node-down')).toEqual([]);
  });

  it('raises zpa-connector-down and zpa-port-exhaustion at the firewall session threshold', () => {
    for (const id of [1, 2, 3]) dev(id, `zpa-${id}`);
    m(1, 'ntm_zpa_app_connector', 'security', 'connector', 'connector_state', 1);
    m(2, 'ntm_zpa_app_connector', 'security', 'connector', 'connector_state', 1);
    m(3, 'ntm_zpa_app_connector', 'security', 'connector', 'connector_state', 0);
    m(1, 'Zscaler ZPA Port Exhaustion', 'security', 'ports', 'port_used_pct', 79);
    m(2, 'Zscaler ZPA Port Exhaustion', 'security', 'ports', 'port_used_pct', 80);
    expect(issuesOf('zpa-connector-down').map((r) => [r.target, r.severity])).toEqual([['zpa-3 connector', 'critical']]);
    expect(issuesOf('zpa-port-exhaustion').map((r) => [r.target, r.severity])).toEqual([['zpa-2 ports', 'warning']]);
  });

  it('raises asa-license-unauthorized for a state of 3 or more', () => {
    dev(1, 'phx-asa-01');
    dev(2, 'dal-asa-01');
    m(1, 'ntm_asa_license_authorization', 'security', 'license', 'asa_license_state', 2);
    m(2, 'ntm_asa_license_authorization', 'security', 'license', 'asa_license_state', 4);
    expect(issuesOf('asa-license-unauthorized').map((r) => r.target)).toEqual(['dal-asa-01 license']);
  });
});

describe('fact builders', () => {
  const load = (id) => lmIssues.loadDsIndex(db, { sourceId: sid, deviceId: id }).get(`${sid}:${id}`);

  it('builds SBC facts', () => {
    dev(1, 'phx-sbc-01');
    m(1, 'ntm_sbc_system_health', 'voice', 'system', 'sbc_health_state', 1);
    m(1, 'ntm_sbc_cpu_utilization', 'voice', 'cpu', 'sbc_cpu_pct', 23.46);
    m(1, 'ntm_sbc_fan_state', 'voice', 'f1', 'sbc_fan_state', 2);
    m(1, 'ntm_sbc_fan_state', 'voice', 'f2', 'sbc_fan_state', 7);
    m(1, 'ntm_sbc_steering_pool_performance', 'voice', 'p1', 'sbc_pool_util_pct', 41);
    const facts = A.sbcFacts(load(1));
    expect(facts).toMatchObject({ healthRaw: 1, healthBad: false, cpuPct: 23.5, fans: 2, fansBad: 1, pools: 1, poolUtilMaxPct: 41 });
    expect(A.voiceKind(load(1))).toBe('sbc');
  });

  it('builds ISE and ZPA facts with the estate polarity', () => {
    dev(1, 'ipsn-1');
    m(1, 'Cisco_ISE_ServerSessions', 'security', 'sessions', 'sessions', 900);
    m(1, 'ntm_ise_application_and_certificate_status', 'security', 'cert', 'cert_days', 45);
    m(1, 'ntm_cisco_ise_eap_certificate', 'security', 'eap', 'eap_cert_days', 20);
    m(1, 'ntm_deployment_nodes_status', 'security', 'node', 'node_state', 1);
    const ise = A.iseFacts(load(1), new Map([['node_state', 1]]));
    expect(ise).toMatchObject({ sessions: 900, certDaysMin: 20, nodes: 1, nodesDown: 0 });
    dev(2, 'zpa-1');
    m(2, 'ntm_zpa_app_connector', 'security', 'connector', 'connector_state', 0);
    expect(A.zpaFacts(load(2), new Map([['connector_state', 1]]))).toMatchObject({ connectors: 1, connectorDown: true });
    expect(A.zpaFacts(load(2), new Map([['connector_state', 0]]))).toMatchObject({ connectorDown: false });
  });
});
