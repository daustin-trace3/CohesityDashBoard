/**
 * Estate Advisor network inputs (round 12, package B): the daily_brief network block, the
 * network_dependency report gather executed against seeded tables, the report listing, and
 * the anonymizer scrubbing app labels, server names and site names out of that gather.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { setSetting } = require('../services/settings');
const appSvc = require('../services/appServiceStatus');
const estate = require('../services/advisors/estateAdvisor');
const { createAnonymizer } = require('../services/anonymizer');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');

const CLEAR = [
  'service_alert_analyses', 'service_alert_events', 'service_status_timeline',
  'app_service_state', 'app_service_watch', 'app_service_catalog',
  'vcenter_vms', 'vcenter_hosts', 'vcenter_datastores', 'vcenter_vcenters', 'poller_status',
];
const LM_CLEAR = [
  'lm_latency_episodes', 'lm_collectors', 'lm_sites', 'lm_alerts', 'lm_unmonitored_neighbors',
  'lm_interface_history', 'lm_interface_daily', 'lm_issue_history',
  'lm_check_locations', 'lm_checks', 'lm_topology_links', 'lm_interfaces', 'lm_devices', 'lm_sources',
];

const ins = (table, row) => {
  const cols = Object.keys(row);
  return db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c])).lastInsertRowid;
};

let src;

function seedApp() {
  const vcId = db.prepare("INSERT INTO vcenter_vcenters (name, host, username, encrypted_credentials) VALUES ('est-vc', 'est-vc.corp.local', 'admin', 'enc')").run().lastInsertRowid;
  db.prepare("INSERT INTO vcenter_hosts (vcenter_id, host_id, name, cluster_name, connection_state, power_state) VALUES (?, 'h1', 'esx-a.corp.local', 'cl-app', 'CONNECTED', 'POWERED_ON')").run(vcId);
  for (const n of ['payhub-vm-01', 'payhub-vm-02']) {
    db.prepare(`
      INSERT INTO vcenter_vms (vcenter_id, vm_id, name, host_name, cluster_name, power_state, tools_status, ip_address, tags, datastores)
      VALUES (?, ?, ?, 'esx-a.corp.local', 'cl-app', 'POWERED_ON', 'toolsOk', NULL, ?, '[]')
    `).run(vcId, `vm-${n}`, n, JSON.stringify(['usage-id: AA00001721']));
  }
  appSvc.addWatch({ usageId: 'aa00001721', label: 'Quasar Ledger' });
}

function seedLm({ dead = true } = {}) {
  src = ins('lm_sources', { name: 'Acme', company: 'acme', auth_mode: 'lmv1', encrypted_credentials: 'x' });
  ins('lm_sites', { source_id: src, site_key: 'zephyr-dc', site_name: 'Zephyr Datacenter' });
  ins('lm_devices', { source_id: src, lm_device_id: 201, name: '10.1.1.1', display_name: 'sw-zeph-1', role: 'switch', is_network: 1, host_status: dead ? 'dead' : 'normal', site_key: 'zephyr-dc', site_name: 'Zephyr Datacenter' });
  for (const [id, n] of [[301, 'payhub-vm-01'], [302, 'payhub-vm-02']]) {
    ins('lm_devices', { source_id: src, lm_device_id: id, name: n, display_name: n, is_network: 0, host_status: 'normal', site_key: 'zephyr-dc', site_name: 'Zephyr Datacenter' });
  }
  ins('lm_interfaces', { source_id: src, lm_device_id: 201, instance_id: 1, display_name: 'Gi1/0/5', status: 1, status_text: 'up' });
  ins('lm_topology_links', {
    source_id: src, src_device_id: 201, src_instance_id: 1, src_port: 'Gi1/0/5', dst_name: 'esx-a.corp.local', dst_port: 'vmnic0',
    protocol: 'lldp', confidence: 'high', last_seen: new Date().toISOString(), dst_platform: 'vcenter', dst_ref: 'esx-a.corp.local',
  });
  ins('lm_interfaces', { source_id: src, lm_device_id: 201, instance_id: 2, display_name: 'Gi0/0/1', status: 2, status_text: 'down', is_wan: 1, stale: 0, wan_label: 'MPLS Dallas', description: 'MPLS Dallas' });
  ins('lm_collectors', { source_id: src, collector_id: 48, hostname: 'col-zeph', is_down: 1, stale: 0, site_key: 'zephyr-dc', site_name: 'Zephyr Datacenter' });
  const open = new Date().toISOString();
  ins('lm_latency_episodes', { source_id: src, subject_kind: 'check', check_id: 'c1', checkpoint_id: 'cp1', subject_key: 'check:c1:cp1', subject_label: 'ping dal-core from Zephyr', site_key: 'zephyr-dc', kind: 'latency', state: 'degrading', opened_at: open });
  for (let i = 0; i < 3; i += 1) {
    ins('lm_latency_episodes', { source_id: src, subject_kind: 'check', check_id: 'c2', checkpoint_id: 'cp2', subject_key: 'check:c2:cp2', subject_label: 'ping edge-gw from Zephyr', site_key: 'zephyr-dc', kind: 'latency', state: 'closed', outcome: 'one-off', opened_at: new Date(Date.now() - (i + 1) * 3600000).toISOString() });
  }
  ins('lm_unmonitored_neighbors', { source_id: src, neighbor_key: 'n1', neighbor_name: 'mystery-sw', kind: 'switch', stale: 0 });
}

beforeEach(() => {
  runMigrations(db, 'logicmonitor', lmMigrations);
  for (const t of CLEAR) db.exec(`DELETE FROM ${t}`);
  for (const t of LM_CLEAR) db.exec(`DELETE FROM ${t}`);
  appSvc._resetTableCache();
  setSetting('service_status_ai_enabled', '0');
});

describe('estate advisor network inputs', () => {
  it('lists network_dependency among the reports and executes its gather on an empty database', () => {
    expect(estate.REPORTS).toContain('network_dependency');
    const out = estate.gatherFor('network_dependency');
    expect(out.appsRankedByNetworkState).toEqual([]);
    expect(out.estate).toBeUndefined();
  });

  it('daily_brief has no network block without a LogicMonitor portal', () => {
    expect(estate.gatherFor('daily_brief').network).toBeUndefined();
  });

  it('daily_brief carries the network block when a portal exists', () => {
    seedApp(); seedLm();
    const n = estate.gatherFor('daily_brief').network;
    expect(n).toMatchObject({
      portals: 1, devicesDead: 1, networkDevicesDead: 1, collectorsDown: 1, unmonitoredNeighbours: 1,
      latencyEpisodesOpen: { watching: 0, degrading: 1, critical: 0 },
    });
    expect(n.sitesCritical).toEqual(['Zephyr Datacenter']);
    expect(n.circuitsNotOk).toMatchObject([{ deviceName: 'sw-zeph-1', port: 'Gi0/0/1', state: 'critical' }]);
    expect(n.alertsOpenBySeverity).toEqual({ critical: 0, warning: 0, info: 0 });
  });

  it('network_dependency ranks the app with its sites and reports estate conditions', () => {
    seedApp(); seedLm();
    const out = estate.gatherFor('network_dependency');
    expect(out.appsRankedByNetworkState).toHaveLength(1);
    const a = out.appsRankedByNetworkState[0];
    expect(a).toMatchObject({ app: 'Quasar Ledger', state: 'degraded', servers: 2 });
    expect(a.networkSummary.sites[0]).toMatchObject({ siteKey: 'zephyr-dc', deadNetworkDevices: 1, collectorsDown: 1 });
    expect(a.networkSummary.singleSwitchServers.sort()).toEqual(['payhub-vm-01', 'payhub-vm-02']);
    expect(out.estate.sitesCritical).toEqual(['Zephyr Datacenter']);
    expect(out.estate.repeatingChecks).toMatchObject([{ check: 'ping edge-gw from Zephyr', oneOffsIn7Days: 3 }]);
  });

  it('the anonymizer removes the app label, server names and site name from the gather', () => {
    seedApp(); seedLm();
    const raw = estate.gatherFor('network_dependency');
    const sent = JSON.stringify(createAnonymizer().anonymize(raw));
    for (const secret of ['Quasar Ledger', 'payhub-vm-01', 'Zephyr Datacenter', 'sw-zeph-1', 'zephyr-dc']) {
      expect(sent.includes(secret), secret).toBe(false);
    }
    const brief = JSON.stringify(createAnonymizer().anonymize(estate.gatherFor('daily_brief')));
    expect(brief.includes('Zephyr Datacenter')).toBe(false);
    expect(brief.includes('Quasar Ledger')).toBe(false);
  });
});
