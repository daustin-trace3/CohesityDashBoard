/**
 * LogicMonitor round 8: issue rules over the DataSource metric tables
 * (lm_ds_metrics). One test per issue type, the tunnel and hardware fold rules,
 * the "unknown enum number stays quiet" rule and device-in-SDT suppression.
 * Rows are seeded by hand into the per-file test DB through the migration.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const { encrypt } = require('../services/encryption');
const lmIssues = require('../services/logicmonitorIssues');

const TABLES = ['lm_issue_history', 'lm_ds_metrics_history', 'lm_ds_metrics', 'lm_ds_instances', 'lm_device_datasources', 'lm_devices', 'lm_sources'];

beforeAll(() => { runMigrations(db, 'logicmonitor', lmMigrations); });

let sid;
let hdsSeq;
beforeEach(() => {
  for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("DELETE FROM app_settings WHERE key LIKE 'lm_%'").run();
  sid = db.prepare('INSERT INTO lm_sources (name, company, auth_mode, encrypted_credentials) VALUES (?, ?, ?, ?)')
    .run('Acme', 'acme', 'lmv1', encrypt(JSON.stringify({ accessId: 'a', accessKey: 'b' }))).lastInsertRowid;
  hdsSeq = 1000;
});

function dev(id, name, over = {}) {
  db.prepare(`INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, device_type, host_status, sdt_status, vendor, role, is_network, site_key, stale)
    VALUES (?, ?, ?, ?, 0, 'normal', ?, ?, ?, 1, ?, 0)`)
    .run(sid, id, name, name, over.sdt || 'none-none-none', over.vendor || 'Cisco', over.role || 'switch', over.site || 'phoenix');
}

/** One metric row on one instance of a device DataSource. */
function m(devId, ds, family, instance, metric, value, extra = {}) {
  const hds = extra.hds || (db.prepare('SELECT hds_id FROM lm_ds_instances WHERE source_id = ? AND lm_device_id = ? AND datasource_name = ? LIMIT 1').get(sid, devId, ds) || {}).hds_id || (hdsSeq += 1);
  db.prepare(`INSERT OR IGNORE INTO lm_ds_instances (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, instance_name, stale)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(sid, devId, hds, ds, family, instance, extra.name || instance, extra.stale ? 1 : 0);
  db.prepare(`INSERT OR REPLACE INTO lm_ds_metrics (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, metric, datapoint, value, sampled_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sid, devId, hds, ds, family, instance, metric, metric, value, Math.floor(Date.now() / 1000) - 60);
}

const issuesOf = (type) => lmIssues.computeIssues().filter((i) => i.type === type);

describe('threshold keys', () => {
  it('defines the seven round 8 keys with the contract defaults and ranges', () => {
    const d = lmIssues.THRESHOLD_DEFS;
    expect(d.lm_metrics_data_calls_per_tick).toMatchObject({ def: 300, min: 20, max: 2000 });
    expect(d.lm_ds_history_days).toMatchObject({ def: 14, min: 3, max: 90 });
    expect(d.lm_fw_session_warn_pct).toMatchObject({ def: 80, min: 50, max: 100 });
    expect(d.lm_cpu_warn_pct).toMatchObject({ def: 85, min: 50, max: 100 });
    expect(d.lm_mem_warn_pct).toMatchObject({ def: 90, min: 50, max: 100 });
    expect(d.lm_cert_warn_days).toMatchObject({ def: 30, min: 1, max: 365 });
    expect(d.lm_tunnel_fold).toMatchObject({ def: 5, min: 2, max: 100 });
    expect(lmIssues.getThreshold('lm_cert_warn_days')).toBe(30);
  });
});

describe('firewall issues', () => {
  it('fw-ha-degraded: critical on a non-functional peer, critical on a suspended local, quiet on a healthy pair', () => {
    dev(1, 'fw-a', { vendor: 'Palo Alto', role: 'firewall' });
    m(1, 'PaloAlto_FW_HA_Status', 'firewall', 'ha', 'ha_enabled', 1);
    m(1, 'PaloAlto_FW_HA_Status', 'firewall', 'ha', 'ha_local_state', 1);
    m(1, 'PaloAlto_FW_HA_Status', 'firewall', 'ha', 'ha_peer_state', 5);
    dev(2, 'fw-b', { vendor: 'Palo Alto', role: 'firewall' });
    m(2, 'PaloAlto_FW_HA_Status', 'firewall', 'ha', 'ha_enabled', 1);
    m(2, 'PaloAlto_FW_HA_Status', 'firewall', 'ha', 'ha_local_state', 6);
    m(2, 'PaloAlto_FW_HA_Status', 'firewall', 'ha', 'ha_peer_state', 1);
    dev(3, 'fw-c', { vendor: 'Palo Alto', role: 'firewall' });
    m(3, 'PaloAlto_FW_HA_Status', 'firewall', 'ha', 'ha_enabled', 1);
    m(3, 'PaloAlto_FW_HA_Status', 'firewall', 'ha', 'ha_local_state', 1);
    m(3, 'PaloAlto_FW_HA_Status', 'firewall', 'ha', 'ha_peer_state', 2);
    const got = issuesOf('fw-ha-degraded');
    expect(got.map((i) => i.target).sort()).toEqual(['fw-a', 'fw-b']);
    expect(got.every((i) => i.severity === 'critical')).toBe(true);
    expect(got.find((i) => i.target === 'fw-a').message).toContain('peer state non-functional');
    expect(got.find((i) => i.target === 'fw-b').message).toContain('local state suspended');
  });

  it('fw-ha-degraded stays quiet for HA switched off and for state numbers it does not know', () => {
    dev(1, 'fw-off', { vendor: 'Palo Alto', role: 'firewall' });
    m(1, 'PaloAlto_FW_HA_Status', 'firewall', 'ha', 'ha_enabled', 0);
    m(1, 'PaloAlto_FW_HA_Status', 'firewall', 'ha', 'ha_peer_state', 5);
    dev(2, 'fw-gap', { vendor: 'Palo Alto', role: 'firewall' });
    m(2, 'PaloAlto_FW_HA_Status', 'firewall', 'ha', 'ha_enabled', 1);
    m(2, 'PaloAlto_FW_HA_Status', 'firewall', 'ha', 'ha_local_state', 99);
    m(2, 'PaloAlto_FW_HA_Status', 'firewall', 'ha', 'ha_peer_state', 42);
    expect(issuesOf('fw-ha-degraded')).toEqual([]);
  });

  it('fw-tunnel-down: one warning per down tunnel at or under the fold, one folded issue above it', () => {
    dev(1, 'fw-few', { vendor: 'Palo Alto', role: 'firewall' });
    for (let i = 1; i <= 4; i += 1) m(1, 'PaloAlto_FW_IPSecTunnelStats', 'firewall', `T${i}`, 'tunnel_state', i <= 2 ? 0 : 1);
    dev(2, 'fw-many', { vendor: 'Palo Alto', role: 'firewall' });
    for (let i = 1; i <= 24; i += 1) m(2, 'PaloAlto_FW_IPSecTunnelStats', 'firewall', `T${i}`, 'tunnel_state', i <= 3 ? 0 : 1);
    expect(lmIssues.getThreshold('lm_tunnel_fold')).toBe(5);
    let got = issuesOf('fw-tunnel-down');
    expect(got.filter((i) => i.target.startsWith('fw-few ')).map((i) => i.target).sort()).toEqual(['fw-few T1', 'fw-few T2']);
    expect(got.filter((i) => i.target.startsWith('fw-many'))).toHaveLength(3);
    // Fold threshold 2: fw-many has 3 down, which is more than 2, so one issue replaces them.
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('lm_tunnel_fold', '2')").run();
    got = issuesOf('fw-tunnel-down');
    const folded = got.filter((i) => i.target.startsWith('fw-many'));
    expect(folded).toHaveLength(1);
    expect(folded[0].message).toBe('3 of 24 IPSec tunnels down on fw-many (folded above 2)');
    expect(folded[0].severity).toBe('warning');
  });

  it('fw-session-high: warning at the threshold, from the percent or from active over max', () => {
    dev(1, 'fw-hot', { vendor: 'Palo Alto', role: 'firewall' });
    m(1, 'PaloAlto_FW_GlobalSessions', 'firewall', 'g', 'sessions_util_pct', 87);
    dev(2, 'fw-calc', { vendor: 'Palo Alto', role: 'firewall' });
    m(2, 'PaloAlto_FW_GlobalSessions', 'firewall', 'g', 'sessions_active', 90);
    m(2, 'PaloAlto_FW_GlobalSessions', 'firewall', 'g', 'sessions_max', 100);
    dev(3, 'fw-cool', { vendor: 'Palo Alto', role: 'firewall' });
    m(3, 'PaloAlto_FW_GlobalSessions', 'firewall', 'g', 'sessions_util_pct', 79);
    const got = issuesOf('fw-session-high');
    expect(got.map((i) => i.target).sort()).toEqual(['fw-calc', 'fw-hot']);
    expect(got.find((i) => i.target === 'fw-hot').message).toBe('fw-hot session table at 87% (threshold 80%)');
  });

  it('fw-config-unsynced: info only when config_synced says no', () => {
    dev(1, 'fw-un', { vendor: 'Palo Alto', role: 'firewall' });
    m(1, 'PaloAlto_FW_Config_Synced', 'firewall', 'c', 'config_synced', 0);
    dev(2, 'fw-ok', { vendor: 'Palo Alto', role: 'firewall' });
    m(2, 'PaloAlto_FW_Config_Synced', 'firewall', 'c', 'config_synced', 1);
    const got = issuesOf('fw-config-unsynced');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ severity: 'info', target: 'fw-un' });
  });
});

describe('load balancer issues', () => {
  it('lb-failover-degraded: warning for offline or forced offline, nothing for active and standby', () => {
    dev(1, 'f5-a', { vendor: 'F5', role: 'load-balancer', site: 'phoenix' });
    dev(2, 'f5-b', { vendor: 'F5', role: 'load-balancer', site: 'phoenix' });
    dev(3, 'f5-c', { vendor: 'F5', role: 'load-balancer', site: 'dallas' });
    dev(4, 'f5-d', { vendor: 'F5', role: 'load-balancer', site: 'dallas' });
    m(1, 'F5_BigIP_FailoverStatus', 'loadbalancer', 'f', 'failover_state', 4);
    m(2, 'F5_BigIP_FailoverStatus', 'loadbalancer', 'f', 'failover_state', 3);
    m(3, 'F5_BigIP_FailoverStatus', 'loadbalancer', 'f', 'failover_state', 4);
    m(4, 'F5_BigIP_FailoverStatus', 'loadbalancer', 'f', 'failover_state', 2);
    const got = issuesOf('lb-failover-degraded');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ severity: 'warning', target: 'f5-d' });
    expect(got[0].message).toContain('forced offline');
  });

  it('lb-failover-degraded: critical when neither device of a site pair is active', () => {
    dev(1, 'f5-a', { vendor: 'F5', role: 'load-balancer', site: 'phoenix' });
    dev(2, 'f5-b', { vendor: 'F5', role: 'load-balancer', site: 'phoenix' });
    m(1, 'F5_BigIP_FailoverStatus', 'loadbalancer', 'f', 'failover_state', 3);
    m(2, 'F5_BigIP_FailoverStatus', 'loadbalancer', 'f', 'failover_state', 3);
    const got = issuesOf('lb-failover-degraded');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ severity: 'critical', target: 'f5-a + f5-b' });
  });

  it('lb-pool-degraded: warning for one member down, critical when every member of a 2+ pool is down', () => {
    dev(1, 'f5-a', { vendor: 'F5', role: 'load-balancer' });
    for (let i = 1; i <= 3; i += 1) m(1, 'F5_BigIP_PoolMemberStats', 'loadbalancer', `app-payments/10.1.1.${i}:443`, 'member_avail', 3);
    for (let i = 1; i <= 6; i += 1) m(1, 'F5_BigIP_PoolMemberStats', 'loadbalancer', `web-portal/10.1.2.${i}:443`, 'member_avail', i === 1 ? 3 : 1);
    m(1, 'F5_BigIP_PoolMemberStats', 'loadbalancer', 'solo/10.1.3.1:80', 'member_avail', 3);
    m(1, 'F5_BigIP_PoolMemberStats', 'loadbalancer', 'healthy/10.1.4.1:80', 'member_avail', 1);
    m(1, 'F5_BigIP_PoolMemberStats', 'loadbalancer', 'unk/10.1.5.1:80', 'member_avail', 4);
    const got = Object.fromEntries(issuesOf('lb-pool-degraded').map((i) => [i.target, i.severity]));
    expect(got).toEqual({ 'f5-a app-payments': 'critical', 'f5-a web-portal': 'warning', 'f5-a solo': 'warning' });
  });

  it('lb-cert-expiring: warning under the threshold, critical under 7 days, none above', () => {
    dev(1, 'f5-a', { vendor: 'F5', role: 'load-balancer' });
    m(1, 'F5_BigIP_SSL_VIP_Certs', 'loadbalancer', 'soon.example.com', 'cert_days_left', 12);
    m(1, 'F5_BigIP_SSL_VIP_Certs', 'loadbalancer', 'urgent.example.com', 'cert_days_left', 5);
    m(1, 'F5_BigIP_SSL_VIP_Certs', 'loadbalancer', 'fine.example.com', 'cert_days_left', 200);
    const got = Object.fromEntries(issuesOf('lb-cert-expiring').map((i) => [i.target, i.severity]));
    expect(got).toEqual({ 'f5-a soon.example.com': 'warning', 'f5-a urgent.example.com': 'critical' });
    expect(issuesOf('lb-cert-expiring').find((i) => i.severity === 'warning').message).toContain('expires in 12 days (threshold 30 days)');
  });

  it('lb-daemon-down: critical when a daemon state is not running', () => {
    dev(1, 'f5-a', { vendor: 'F5', role: 'load-balancer' });
    m(1, 'f5_mcpd_service_status', 'loadbalancer', 'mcpd', 'daemon_state', 1);
    m(1, 'f5_tmm_service_status', 'loadbalancer', 'tmm', 'daemon_state', 0);
    const got = issuesOf('lb-daemon-down');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ severity: 'critical', target: 'f5-a tmm' });
  });
});

describe('device health issues', () => {
  it('device-cpu-high and device-memory-high use the latest value against the thresholds', () => {
    dev(1, 'core-1');
    m(1, 'Cisco_CPU_SNMP', 'health', 'c1', 'cpu_pct', 91);
    m(1, 'Cisco_MemoryPools_SNMP', 'health', 'p1', 'mem_pct', 95);
    dev(2, 'core-2');
    m(2, 'Cisco_CPU_SNMP', 'health', 'c1', 'cpu_pct', 84);
    m(2, 'Cisco_MemoryPools_SNMP', 'health', 'p1', 'mem_pct', 89);
    expect(issuesOf('device-cpu-high').map((i) => [i.target, i.severity, i.message])).toEqual([['core-1', 'warning', 'core-1 CPU at 91% (threshold 85%)']]);
    expect(issuesOf('device-memory-high').map((i) => [i.target, i.message])).toEqual([['core-1', 'core-1 memory at 95% (threshold 90%)']]);
  });

  it('hardware-fault: warning per faulty component, quiet for ok and not-present, folded above 5 per device', () => {
    dev(1, 'sw-1');
    m(1, 'Cisco_FRU_Power', 'health', 'PS1', 'psu_state', 1);
    m(1, 'Cisco_FRU_Power', 'health', 'PS2', 'psu_state', 3);
    m(1, 'Cisco_FRU_Power', 'health', 'PS3', 'psu_state', 5);
    dev(2, 'sw-2');
    for (let i = 1; i <= 7; i += 1) m(2, 'CiscoFan-', 'health', `Fan${i}`, 'fan_state', 2);
    const got = issuesOf('hardware-fault');
    expect(got.filter((i) => i.target.startsWith('sw-1'))).toHaveLength(1);
    expect(got.find((i) => i.target === 'sw-1 PS2').message).toContain('Power supply PS2 on sw-1 reports state 3');
    const folded = got.filter((i) => i.target.startsWith('sw-2'));
    expect(folded).toHaveLength(1);
    expect(folded[0].target).toBe('sw-2 hardware');
    expect(folded[0].message).toContain('7 hardware components report a fault on sw-2');
  });

  it('bgp-peer-down and ospf-neighbor-down: warning when not established or not full', () => {
    dev(1, 'rtr-1', { role: 'router' });
    m(1, 'BGP-', 'routing', '10.0.0.1', 'bgp_peer_state', 6);
    m(1, 'BGP-', 'routing', '10.0.0.2', 'bgp_peer_state', 3);
    m(1, 'OSPF_Neighbors', 'routing', '10.1.0.1', 'ospf_nbr_state', 8);
    m(1, 'OSPF_Neighbors', 'routing', '10.1.0.2', 'ospf_nbr_state', 2);
    expect(issuesOf('bgp-peer-down').map((i) => [i.severity, i.target])).toEqual([['warning', 'rtr-1 10.0.0.2']]);
    expect(issuesOf('ospf-neighbor-down').map((i) => [i.severity, i.target])).toEqual([['warning', 'rtr-1 10.1.0.2']]);
  });

  it('optic-power-low: only when the low-warning threshold datapoint exists', () => {
    dev(1, 'core-1');
    m(1, 'Cisco_Transceiver_Sensors', 'optics', 'Te1/0/1', 'rx_power_dbm', -14.2);
    m(1, 'Cisco_Transceiver_Sensors', 'optics', 'Te1/0/1', 'rx_low_warn', -12);
    m(1, 'Cisco_Transceiver_Sensors', 'optics', 'Te1/0/2', 'rx_power_dbm', -30);
    m(1, 'Cisco_Transceiver_Sensors', 'optics', 'Te1/0/3', 'rx_power_dbm', -5);
    m(1, 'Cisco_Transceiver_Sensors', 'optics', 'Te1/0/3', 'rx_low_warn', -12);
    const got = issuesOf('optic-power-low');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ severity: 'warning', target: 'core-1 Te1/0/1' });
    expect(got[0].message).toContain('receives -14.2 dBm, below its low warning of -12 dBm');
  });

  it('optic-power-low: generic sensor table judges power sensors only, by instance key', () => {
    dev(1, 'core-1');
    // Rx power below its low warning: issue.
    m(1, 'Cisco_Transceiver_Sensors', 'optics', 'Te1/0/1 Receive Power Sensor', 'optic_value', -14.2);
    m(1, 'Cisco_Transceiver_Sensors', 'optics', 'Te1/0/1 Receive Power Sensor', 'optic_low_warn', -12);
    // Healthy Tx power: none.
    m(1, 'Cisco_Transceiver_Sensors', 'optics', 'Te1/0/1 Transmit Power Sensor', 'optic_value', -2);
    m(1, 'Cisco_Transceiver_Sensors', 'optics', 'Te1/0/1 Transmit Power Sensor', 'optic_low_warn', -8);
    // Temperature row under its "low warning": not a power sensor, no issue.
    m(1, 'Cisco_Transceiver_Sensors', 'optics', 'Te1/0/1 Temperature Sensor', 'optic_value', 20);
    m(1, 'Cisco_Transceiver_Sensors', 'optics', 'Te1/0/1 Temperature Sensor', 'optic_low_warn', 30);
    const got = issuesOf('optic-power-low');
    expect(got).toHaveLength(1);
    expect(got[0].target).toBe('core-1 Te1/0/1 Receive Power Sensor');
    expect(got[0].message).toContain('reads -14.2 dBm, below its low warning of -12 dBm');
  });
});

describe('wireless issues', () => {
  const wlc = (id = 1, name = 'irv-wlc-1') => dev(id, name, { role: 'wireless' });

  it('wlan-ha-degraded: critical when the 9800 HA peer is not in hot standby', () => {
    wlc(1, 'wlc-a');
    m(1, 'Cisco_C9800_HA_Peer_State', 'wireless', 'ha', 'wlc_ha_peer_ok', 0);
    wlc(2, 'wlc-b');
    m(2, 'Cisco_C9800_HA_Peer_State', 'wireless', 'ha', 'wlc_ha_peer_ok', 1);
    expect(issuesOf('wlan-ha-degraded').map((i) => [i.severity, i.target])).toEqual([['critical', 'wlc-a']]);
  });

  it('wlan-ap-down: one per disassociating AP, quiet for disabled and downloading APs, folded above the threshold', () => {
    wlc(1, 'wlc-few');
    m(1, 'Cisco_Wireless_AP', 'wireless', 'AP-1', 'ap_oper', 1);
    m(1, 'Cisco_Wireless_AP', 'wireless', 'AP-2', 'ap_oper', 2);
    m(1, 'Cisco_Wireless_AP', 'wireless', 'AP-3', 'ap_oper', 3);
    m(1, 'Cisco_Wireless_AP', 'wireless', 'AP-4', 'ap_oper', 2);
    m(1, 'Cisco_Wireless_AP', 'wireless', 'AP-4', 'ap_admin', 2);
    wlc(2, 'wlc-many');
    for (let i = 1; i <= 10; i += 1) m(2, 'Cisco_Wireless_AP', 'wireless', `B-${i}`, 'ap_oper', i <= 6 ? 2 : 1);
    const got = issuesOf('wlan-ap-down');
    expect(got.filter((i) => i.target.startsWith('wlc-few')).map((i) => i.target)).toEqual(['wlc-few AP-2']);
    const folded = got.filter((i) => i.target.startsWith('wlc-many'));
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ severity: 'critical', target: 'wlc-many access points' });
    expect(folded[0].message).toContain('6 of 10 access points down');
  });

  it('wlan-ap-down: an AP that left the AP table in the last day is reported missing', () => {
    wlc(1, 'wlc-a');
    m(1, 'Cisco_Wireless_AP', 'wireless', 'AP-1', 'ap_oper', 1);
    m(1, 'Cisco_Wireless_AP', 'wireless', 'AP-gone', 'ap_oper', 1, { stale: true });
    const got = issuesOf('wlan-ap-down');
    expect(got.map((i) => i.target)).toEqual(['wlc-a AP-gone']);
    expect(got[0].message).toContain('left the controller');
  });

  it('wlan-radio-down skips disabled radios and radios of a down AP; wlan-channel-util-high uses the threshold', () => {
    wlc(1, 'wlc-a');
    m(1, 'Cisco_Wireless_AP', 'wireless', 'AP-1', 'ap_oper', 1);
    m(1, 'Cisco_Wireless_AP', 'wireless', 'AP-2', 'ap_oper', 2);
    m(1, 'Cisco_Wireless_AccessPointRadio', 'wireless', 'AP-1:0', 'radio_oper', 1);
    m(1, 'Cisco_Wireless_AccessPointRadio', 'wireless', 'AP-1:0', 'radio_admin', 1);
    m(1, 'Cisco_Wireless_AccessPointRadio', 'wireless', 'AP-1:1', 'radio_oper', 1);
    m(1, 'Cisco_Wireless_AccessPointRadio', 'wireless', 'AP-1:1', 'radio_admin', 2);
    m(1, 'Cisco_Wireless_AccessPointRadio', 'wireless', 'AP-2:0', 'radio_oper', 1);
    m(1, 'Cisco_Wireless_AccessPointRadio', 'wireless', 'AP-1:2', 'radio_util_pct', 82);
    m(1, 'Cisco_Wireless_AccessPointRadio', 'wireless', 'AP-1:3', 'radio_util_pct', 40);
    // Slot 3 is an auxiliary monitor radio: enabled and down by design, never an issue.
    m(1, 'Cisco_Wireless_AccessPointRadio', 'wireless', 'AP-1:3', 'radio_oper', 1);
    m(1, 'Cisco_Wireless_AccessPointRadio', 'wireless', 'AP-1:3', 'radio_admin', 1);
    const radios = issuesOf('wlan-radio-down');
    expect(radios.map((i) => i.target)).toEqual(['wlc-a AP-1:0']);
    expect(radios[0].message).toContain('2.4 GHz');
    expect(issuesOf('wlan-channel-util-high').map((i) => i.target)).toEqual(['wlc-a AP-1:2']);
  });

  it('controller level rules: AP availability, client capacity, mobility and RADIUS', () => {
    wlc(1, 'wlc-a');
    m(1, 'ntm_wlc_ap_status_check', 'wireless', 'g', 'wlc_ap_available_pct', 20);
    m(1, 'Cisco_Wireless_ConnectionStatistics', 'wireless', '0', 'wlc_client_usage_pct', 85);
    m(1, 'ntm_wlc_mobility_domain_check', 'wireless', 'g', 'wlc_mobility_status', 1);
    m(1, 'Cisco_Wireless_RADIUSAuthServers', 'wireless', '10.0.0.1', 'radius_status', 1);
    m(1, 'Cisco_Wireless_RADIUSAuthServers', 'wireless', '10.0.0.1', 'radius_timeouts', 2);
    m(1, 'Cisco_Wireless_RADIUSAuthServers', 'wireless', '10.0.0.2', 'radius_status', 1);
    m(1, 'Cisco_Wireless_RADIUSAuthServers', 'wireless', '10.0.0.2', 'radius_timeouts', 1);
    m(1, 'Cisco_Wireless_RADIUSAuthServers', 'wireless', '10.0.0.2', 'radius_accepts', 4);
    wlc(2, 'wlc-script-error');
    m(2, 'ntm_wlc_ap_status_check', 'wireless', 'g', 'wlc_ap_available_pct', -1);
    m(2, 'ntm_wlc_mobility_domain_check', 'wireless', 'g', 'wlc_mobility_status', 2);
    expect(issuesOf('wlan-ap-availability-low').map((i) => [i.severity, i.target])).toEqual([['critical', 'wlc-a']]);
    expect(issuesOf('wlan-client-capacity-high').map((i) => i.target)).toEqual(['wlc-a']);
    expect(issuesOf('wlan-mobility-down').map((i) => i.target)).toEqual(['wlc-a']);
    expect(issuesOf('wlan-radius-unresponsive').map((i) => i.target)).toEqual(['wlc-a RADIUS 10.0.0.1']);
  });
});

describe('metric issue plumbing', () => {
  it('a device in scheduled downtime raises nothing from metrics', () => {
    dev(1, 'core-sdt', { sdt: 'none-SDT-none' });
    m(1, 'Cisco_CPU_SNMP', 'health', 'c1', 'cpu_pct', 99);
    expect(issuesOf('device-cpu-high')).toEqual([]);
  });

  it('stale instances are ignored', () => {
    dev(1, 'core-1');
    m(1, 'Cisco_CPU_SNMP', 'health', 'c1', 'cpu_pct', 99, { stale: true });
    expect(issuesOf('device-cpu-high')).toEqual([]);
  });

  it('every new type is exported in METRIC_ISSUE_TYPES and reaches the issue history', () => {
    expect(lmIssues.METRIC_ISSUE_TYPES).toEqual(expect.arrayContaining([
      'fw-ha-degraded', 'fw-tunnel-down', 'fw-session-high', 'fw-config-unsynced', 'lb-failover-degraded', 'lb-pool-degraded',
      'lb-cert-expiring', 'lb-daemon-down', 'device-cpu-high', 'device-memory-high', 'hardware-fault', 'bgp-peer-down',
      'ospf-neighbor-down', 'optic-power-low',
    ]));
    dev(1, 'core-1');
    m(1, 'Cisco_CPU_SNMP', 'health', 'c1', 'cpu_pct', 99);
    lmIssues.reconcileIssueHistory();
    const open = db.prepare("SELECT type, target, severity FROM lm_issue_history WHERE status = 'open'").all();
    expect(open).toEqual([{ type: 'device-cpu-high', target: 'core-1', severity: 'warning' }]);
  });
});
