/**
 * Estate Advisor refresh (2026-11-09): the new keys on the seven existing reports, the three new reports
 * (lifecycle_support, capacity_outlook, ops_agent_review), the ISO-cutoff fix for the 24 hour counts, list caps,
 * and the anonymizer scrubbing every seeded name out of the gathers.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const estate = require('../services/advisors/estateAdvisor');
const { createAnonymizer } = require('../services/anonymizer');
const lmGroups = require('../services/logicmonitorGroups');

// A self-signed certificate generated for this test (CN okta-test), valid until 2126.
const SAML_CERT_BODY = [
  'MIIDCzCCAfOgAwIBAgIUBspV346L42pJLupO2XezJXYx9bEwDQYJKoZIhvcNAQEL',
  'BQAwFDESMBAGA1UEAwwJb2t0YS10ZXN0MCAXDTI2MTEwOTE1NTMwNloYDzIxMjYx',
  'MDE2MTU1MzA2WjAUMRIwEAYDVQQDDAlva3RhLXRlc3QwggEiMA0GCSqGSIb3DQEB',
  'AQUAA4IBDwAwggEKAoIBAQCNpl1CqbW8dJoJkaHQ02vi6mZosoCTB0Kz1No60HBt',
  '4JinFciEzD+FElFuFFbDwYXTcPJyavYFQbFjViS58gWh3dvxwk7rK/4VR28Y3EKh',
  'odYNiwJdAPneXig34+539fOCLCd10pZsQRB0nVL9MFjPUgBY9o6JSyruo/57U9A0',
  'gBwAqKh3w0mBy9gQmfGCNNdvOPkcoa5r3wwYEiiEcV6ce5mNHjhwpnRHrpsiGw2z',
  'Wqk7xLShKI3aO/2Bsf8EKfd9tbdPfYzhFFF/13HhZQ7PsDmhhjcJNUzR6/o7uRow',
  '4eVPdjMTa6hcQHvTaaA6SZ0jts4e1jewx7E4jy4aRY6vAgMBAAGjUzBRMB0GA1Ud',
  'DgQWBBQzIm4h/nlEu81/PMVb3s/cFBaKDjAfBgNVHSMEGDAWgBQzIm4h/nlEu81/',
  'PMVb3s/cFBaKDjAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQA+',
  'dK0/lN4KYKvqy4Pjz3iTOJCCIeXSUpcSa2tRhZbPYjUDQOfZGEXPV8raiow7eiIx',
  'YyKA77WKk1GhaxwHP1HFchorO9TofJ99wNKuHifkGOZUIOIPGvdX4L2/xSibWYoo',
  'Y96rc76WoPFOyg6/aTXt2hzFRwfpywWvhktku+asL4l5mxZKzQcJns/R79bTRv90',
  'CRqOFMP2vcPg87alR2xLwF+RaGdN/rB0vmQXijw534R0OKpvvCVmp81+rwYAztwK',
  'Ihz5EKPRAD6r7cXcC8Nud3HsF0pLXNsVgWfX6/7Jis5keI+DRXbAo3NvSg0YmzoY',
  'ZxNCbc39foLZchND/3wA',
].join('');
const SAML_PEM = `-----BEGIN CERTIFICATE-----\n${SAML_CERT_BODY.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`;

// Hyper-V exists only on feat/multi-tenant; its cases are conditional on the migration file here.
const HAS_HYPERV = require('fs').existsSync(require('path').join(__dirname, '../db/migrations/hyperv.js'));
const SCOPES = ['cohesity', 'pure', 'vcenter', ...(HAS_HYPERV ? ['hyperv'] : []), 'aws', 'directory', 'logicmonitor', 'netapp', 'zerto'];
const CLEAR = [
  'lm_circuit_events', 'lm_issue_history', 'lm_devices', 'lm_sites', 'lm_sources',
  'ops_observations', 'ops_incident_analyses', 'ops_capability_runs', 'ops_incidents', 'service_group_status_timeline',
  'idp_sync_log', 'idp_providers', 'directory_sync_log', 'hyperv_replication', 'hyperv_hosts', 'hyperv_sources',
  'hyperv_vms', 'vcenter_datastores', 'lm_device_groups', 'protection_runs', 'clusters', 'zerto_events', 'zerto_vras',
  'aws_sp_utilization_daily', 'aws_capability_status', 'aws_savings_plans', 'aws_accounts',
  'pure1_subscription_assets', 'pure1_arrays', 'vcenter_datastore_history', 'vcenter_vcenters', 'config_state',
];

const ins = (table, row) => {
  const cols = Object.keys(row);
  return db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c])).lastInsertRowid;
};
const insHv = (table, row) => (HAS_HYPERV ? ins(table, row) : null);
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const sqlAgo = (ms) => ago(ms).replace('T', ' ').slice(0, 19);
const DAY = 86400000;

beforeAll(() => {
  for (const s of SCOPES) runMigrations(db, s, require(`../db/migrations/${s}`));
});

beforeEach(() => {
  for (const t of CLEAR) { try { db.exec(`DELETE FROM ${t}`); } catch { /* table absent on this build */ } }
});

describe('estate advisor refresh', () => {
  it('lists ten reports and runs every gather on an empty database', () => {
    expect(estate.REPORTS).toEqual(expect.arrayContaining([
      'daily_brief', 'network_dependency', 'certificate_audit', 'access_review', 'recovery_readiness', 'change_ledger',
      'cloud_cost_posture', 'lifecycle_support', 'capacity_outlook', 'ops_agent_review']));
    expect(estate.REPORTS).toHaveLength(10);
    for (const key of estate.REPORTS) expect(typeof estate.gatherFor(key), key).toBe('object');
  });

  it('daily_brief 24 hour counts use ISO cutoffs, not datetime(now)', () => {
    // 20 hours ago counts, 30 hours ago does not. The old SQL compared these ISO stamps with a space-format cutoff.
    const base = { platforms: '["vcenter"]', severity: 'warning', hold_until: ago(0), last_event_at: ago(0), state: 'resolved', baseline: 0 };
    ins('ops_incidents', { ...base, incident_key: 'a', opened_at: ago(20 * 3600000), resolved_at: ago(19 * 3600000), notified_at: ago(19 * 3600000) });
    ins('ops_incidents', { ...base, incident_key: 'b', opened_at: ago(30 * 3600000), resolved_at: ago(29 * 3600000), notified_at: ago(29 * 3600000) });
    ins('ops_capability_runs', { capability: 'ping', risk: 'read', target_kind: 'host', ok: 1, ran_at: ago(3600000) });
    ins('ops_capability_runs', { capability: 'ping', risk: 'read', target_kind: 'host', ok: 1, ran_at: ago(40 * 3600000) });
    ins('ops_incident_analyses', { incident_id: 1, at: ago(3600000), trigger: 'tick' });
    const l = estate.gatherFor('daily_brief').last24h;
    expect(l).toMatchObject({ incidentsOpened: 1, incidentsResolved: 1, analysesEmailed: 1, capabilityRuns: 1, analyses: 1 });
  });

  it('daily_brief carries services, site WAN, observations, human required and Hyper-V', () => {
    const src = ins('lm_sources', { name: 'Acme', company: 'acme', auth_mode: 'lmv1', encrypted_credentials: 'x' });
    // Service labels come from group names, which the anonymizer dictionary reads from lm_device_groups.
    ins('lm_device_groups', { source_id: src, lm_group_id: 1, name: 'Checkout Service', full_path: 'Apps/Checkout Service' });
    ins('lm_sites', { source_id: src, site_key: 'zephyr', site_name: 'Zephyr WAN Site', wan_state: 'degraded', wan_total: 2, wan_down: 1 });
    ins('lm_sites', { source_id: src, site_key: 'okay', site_name: 'Fine Site', wan_state: 'ok', wan_total: 2, wan_down: 0 });
    ins('service_group_status_timeline', { service_id: 'checkout', label: 'Checkout Service', state: 'degraded', at: ago(3600000) });
    ins('service_group_status_timeline', { service_id: 'checkout', label: 'Checkout Service', state: 'failed', at: ago(1800000) });
    const vcId = ins('vcenter_vcenters', { name: 'vc-brief', host: 'vc-brief', username: 'u', encrypted_credentials: 'x' });
    ins('vcenter_vms', { vcenter_id: vcId, vm_id: 'vm-1', name: 'hot-vm-01' });
    ins('ops_observations', { observer_id: 'vcenter:vm-cpu', platform: 'vcenter', subject_key: 's1', subject_label: 'hot-vm-01', state: 'degrading', opened_at: ago(3600000), updated_at: ago(0), last_value: 95, peak_value: 99, unit: '%' });
    ins('ops_observations', { observer_id: 'vcenter:vm-cpu', platform: 'vcenter', subject_key: 's2', subject_label: 'warm-vm-02', state: 'watching', opened_at: ago(3600000), updated_at: ago(0) });
    ins('ops_incidents', { incident_key: 'pattern:x', title: 'Needs a person', host: 'hot-vm-01', platforms: '["vcenter"]', severity: 'warning', state: 'notified', opened_at: ago(DAY), hold_until: ago(DAY), last_event_at: ago(0), requires_human: 1 });
    const hs = insHv('hyperv_sources', { name: 'hv-src', host: 'hv1', username: 'u', encrypted_credentials: 'x' });
    insHv('hyperv_hosts', { source_id: hs, name: 'hv-node-1', state: 'down' });
    insHv('hyperv_replication', { source_id: hs, vm_id: 'v1', vm_name: 'hv-replica-vm', health: 'critical', state: 'error' });

    const real = lmGroups.services;
    lmGroups.services = () => [{ serviceId: 'checkout', label: 'Checkout Service', state: 'degraded', counts: { crit: 1, warn: 2, ok: 7, total: 10 } }];
    let out;
    try { out = estate.gatherFor('daily_brief'); } finally { lmGroups.services = real; }

    expect(out.lmServices).toEqual([{ label: 'Checkout Service', state: 'degraded', devices: 10, failed: 1, degraded: 2 }]);
    expect(out.serviceTimeline24h).toEqual([{ service: 'Checkout Service', transitions: 2, lastState: 'failed' }]);
    expect(out.siteWan).toEqual([{ site: 'Zephyr WAN Site', wanState: 'degraded', wanTotal: 2, wanDown: 1 }]);
    expect(out.observations.counts).toEqual({ watching: 1, degrading: 1, critical: 0 });
    expect(out.observations.open).toMatchObject([{ subject: 'hot-vm-01', state: 'degrading', peak: 99 }]);
    expect(out.humanRequired).toMatchObject({ total: 1, items: [{ title: 'Needs a person' }] });
    if (HAS_HYPERV) expect(out.hypervBrief).toMatchObject({ hosts: 1, hostsDown: 1, replicationUnhealthy: 1 });

    // Rule: the scrubbed gather carries none of the seeded names.
    const sent = JSON.stringify(createAnonymizer().anonymize(out));
    for (const secret of ['Zephyr WAN Site', 'Checkout Service', 'hot-vm-01']) expect(sent.includes(secret), secret).toBe(false);
  });

  it('network_dependency adds circuit events and derived platform counts', () => {
    const src = ins('lm_sources', { name: 'Acme', company: 'acme', auth_mode: 'lmv1', encrypted_credentials: 'x' });
    ins('lm_devices', { source_id: src, lm_device_id: 1, name: 'f5-a', display_name: 'f5-a', vendor_key: 'f5', host_status: 'dead', stale: 0 });
    ins('lm_devices', { source_id: src, lm_device_id: 2, name: 'sw-a', display_name: 'sw-a', vendor_key: 'cisco', host_status: 'normal', stale: 0 });
    ins('lm_devices', { source_id: src, lm_device_id: 3, name: 'mx-a', display_name: 'mx-a', vendor_key: 'meraki', host_status: 'normal', stale: 0 });
    for (let i = 0; i < 3; i += 1) ins('lm_circuit_events', { source_id: src, instance_id: 5, device_name: 'edge-1', port: 'Gi0/1', event: 'down', at: sqlAgo(3600000 * (i + 1)) });
    ins('lm_circuit_events', { source_id: src, instance_id: 5, device_name: 'edge-1', port: 'Gi0/1', event: 'up', at: sqlAgo(1000) });
    ins('lm_circuit_events', { source_id: src, instance_id: 6, device_name: 'old', port: 'Gi0/2', event: 'down', at: sqlAgo(10 * DAY) });
    const out = estate.gatherFor('network_dependency');
    expect(out.circuitEvents7d.byKind).toMatchObject({ down: 3, up: 1 });
    expect(out.circuitEvents7d.topCircuits[0]).toMatchObject({ device: 'edge-1', events: 4 });
    expect(out.derivedPlatforms).toEqual(expect.arrayContaining([
      { platform: 'f5', devices: 1, dead: 1, meraki: 0 }, { platform: 'cisco', devices: 2, dead: 0, meraki: 1 }]));
  });

  it('certificate_audit reads Okta SAML, ISE and F5 and Hyper-V certificates', () => {
    const now = new Date().toISOString();
    ins('idp_providers', { name: 'okta-secret', slug: 'okta', type: 'saml', enabled: 1, idp_cert_pem: SAML_PEM, created_at: now, updated_at: now });
    ins('lm_issue_history', { issue_key: 'k1', type: 'ise-cert-expiring', target: 'ise-node-1', message: 'Certificate expires in 12 days', status: 'open', severity: 'warning' });
    ins('lm_issue_history', { issue_key: 'k2', type: 'lb-cert-expiring', target: 'bigip-1', message: 'Certificate expiry unreadable', status: 'open', severity: 'warning' });
    const hs = insHv('hyperv_sources', { name: 'hv-src', host: 'hv1', username: 'u', encrypted_credentials: 'x' });
    insHv('hyperv_hosts', { source_id: hs, name: 'hv-node-1', state: 'up', cert_valid_to: new Date(Date.now() + 20 * DAY).toISOString() });
    const out = estate.gatherFor('certificate_audit');
    const by = (p) => out.expiringSoonest.filter((c) => c.platform === p);
    expect(by('okta')).toHaveLength(1);
    expect(by('okta')[0].expires.startsWith('2126')).toBe(true);
    expect(by('ISE (LogicMonitor)')[0]).toMatchObject({ daysLeft: 12 });
    expect(by('F5 (LogicMonitor)')[0].daysLeft).toBeNull();
    if (HAS_HYPERV) expect(by('Hyper-V')[0].daysLeft).toBeGreaterThanOrEqual(19);
    // An unreadable days value sorts last and falls in no bucket.
    expect(out.expiringSoonest[out.expiringSoonest.length - 1].platform).toBe('F5 (LogicMonitor)');
    expect(out.summary.within30Days).toBe(HAS_HYPERV ? 2 : 1);
  });

  it('access_review lists identity providers, sign-in sources and directory sync', () => {
    const now = new Date().toISOString();
    const pid = ins('idp_providers', { name: 'okta-secret', slug: 'okta', type: 'oidc', enabled: 1, mgmt_kind: 'okta', created_at: now, updated_at: now });
    db.prepare('INSERT INTO idp_sync_log (provider_id, started_at, trigger, status, groups_synced, users_seen) VALUES (?, ?, ?, ?, ?, ?)').run(pid, now, 'schedule', 'ok', 4, 20);
    db.prepare('INSERT INTO directory_sync_log (started_at, trigger, status, groups_synced, users_seen) VALUES (?, ?, ?, ?, ?)').run(now, 'manual', 'ok', 3, 11);
    const out = estate.gatherFor('access_review');
    expect(out.idpProviders).toMatchObject([{ name: 'okta-secret', protocol: 'oidc', enabled: true, oktaSync: true, lastSyncCounts: { groups: 4, users: 20 } }]);
    expect(out.directorySync).toMatchObject([{ status: 'ok', groups: 3, users: 11 }]);
    expect(Array.isArray(out.ssoUsers)).toBe(true);
  });

  it('recovery_readiness adds Hyper-V replication, Cohesity runs and Zerto events', () => {
    const hs = insHv('hyperv_sources', { name: 'hv-src', host: 'hv1', username: 'u', encrypted_credentials: 'x' });
    insHv('hyperv_vms', { source_id: hs, vm_id: 'v1', name: 'hv-replica-vm', state: 'running' });
    insHv('hyperv_replication', { source_id: hs, vm_id: 'v1', vm_name: 'hv-replica-vm', health: 'critical', state: 'error' });
    insHv('hyperv_replication', { source_id: hs, vm_id: 'v2', vm_name: 'ok-vm', health: 'normal', state: 'replicating' });
    const cl = ins('clusters', { name: 'cl-secret', connection_type: 'direct', auth_type: 'apikey', encrypted_credentials: 'x' });
    ins('protection_runs', { cluster_id: cl, job_name: 'pg-secret', status: 'kFailure', start_time: ago(DAY) });
    ins('protection_runs', { cluster_id: cl, job_name: 'pg-secret', status: 'kSuccess', start_time: ago(2 * DAY) });
    ins('protection_runs', { cluster_id: cl, job_name: 'pg-secret', status: 'kFailure', start_time: ago(20 * DAY) });
    db.prepare("INSERT INTO zerto_events (event_identifier, category, code, event_type, description, occurred_on) VALUES ('e1', 'Alerts', 'VRA0001', 'VRA', 'VRA down', ?)").run(ago(3600000));
    db.prepare("INSERT INTO zerto_vras (site_identifier, name, status) VALUES ('s1', 'vra-1', 'Installed')").run();
    const out = estate.gatherFor('recovery_readiness');
    if (HAS_HYPERV) expect(out.hypervReplication).toMatchObject({ total: 2, worst: [{ vm: 'hv-replica-vm', health: 'critical' }] });
    expect(out.cohesityRuns7d).toMatchObject({ total: 2, failed: 1, topFailingGroups: [{ protectionGroup: 'pg-secret', failedRuns: 1 }] });
    expect(out.zertoEvents24h.byCategory).toEqual([{ category: 'Alerts', count: 1 }]);
    expect(out.zertoVras).toEqual([{ status: 'Installed', count: 1 }]);
    const sent = JSON.stringify(createAnonymizer().anonymize(out));
    for (const secret of ['hv-replica-vm', 'cl-secret']) expect(sent.includes(secret), secret).toBe(false);
  });

  it('change_ledger lists the scopes it holds', () => {
    const now = new Date().toISOString();
    ins('config_state', { platform: 'netapp', scope: 'nfs-exports', system: 's1', item: 'i1', value: 'v', updated_at: now });
    ins('config_state', { platform: 'netapp', scope: 'nfs-exports', system: 's1', item: 'i2', value: 'v', updated_at: now });
    ins('config_state', { platform: 'idp', scope: 'idp-group-membership', system: 's1', item: 'i1', value: 'v', updated_at: now });
    const out = estate.gatherFor('change_ledger');
    expect(out.scopes).toEqual([
      { platform: 'idp', scope: 'idp-group-membership', itemsTracked: 1 },
      { platform: 'netapp', scope: 'nfs-exports', itemsTracked: 2 },
    ]);
  });

  it('cloud cost extras report Savings Plans, capability gaps and which sources were present', () => {
    const acct = ins('aws_accounts', { name: 'acct-secret' });
    ins('aws_savings_plans', { account_id: acct, sp_arn: 'arn:sp-1', sp_type: 'Compute', end_at: new Date(Date.now() + 30 * DAY).toISOString() });
    ins('aws_savings_plans', { account_id: acct, sp_arn: 'arn:sp-2', sp_type: 'Compute', end_at: new Date(Date.now() + 400 * DAY).toISOString() });
    db.prepare('INSERT INTO aws_sp_utilization_daily (account_id, day, utilization_pct) VALUES (?, ?, ?)').run(acct, new Date().toISOString().slice(0, 10), 93.5);
    db.prepare("INSERT INTO aws_capability_status (account_id, capability, status) VALUES (?, 'optimization_hub', 'denied')").run(acct);
    const extras = estate._gathers.gatherCostExtras();
    expect(extras.savingsPlans).toMatchObject({ count: 2, endingWithin90Days: 1, utilizationPct: { pct: 93.5 } });
    expect(extras.capabilitiesNotAvailable).toEqual([{ capability: 'optimization_hub', status: 'denied' }]);
    expect(extras.present).toEqual(expect.arrayContaining(['savingsPlans', 'capabilityStatus']));
    expect(extras.present).not.toContain('eonCost');
  });

  it('lifecycle_support carries Pure1 end of life', () => {
    ins('pure1_arrays', { pure1_id: 'p1', name: 'array-secret-1', model: 'FlashArray//X50R3', version: '6.5.1' });
    ins('pure1_subscription_assets', { asset_id: 'a1', pure1_array_id: 'p1', name: 'array-secret-1', end_of_life_date_ms: Date.now() - 30 * DAY });
    const out = estate.gatherFor('lifecycle_support');
    expect(out.pure1.summary).toMatchObject({ arrays: 1, hwEolPast: 1 });
    expect(out.pure1.worstArrays[0]).toMatchObject({ hardwareState: 'past', worst: 'crit' });
    expect(out.sourcesPresent).toContain('pure1');
    expect(out.pure1.sourceTables).toMatch(/pure1_subscription_assets/);
    const sent = JSON.stringify(createAnonymizer().anonymize(out));
    expect(sent.includes('array-secret-1')).toBe(false);
  });

  it('capacity_outlook ranks a growing datastore by days to full and does not extrapolate a flat one', () => {
    const vc = ins('vcenter_vcenters', { name: 'vc-secret-01', host: 'vc1', username: 'u', encrypted_credentials: 'x' });
    const TB = 1e12;
    for (const n of ['ds-growing', 'ds-flat', 'ds-single']) ins('vcenter_datastores', { vcenter_id: vc, datastore_id: n, name: n });
    const point = (name, daysAgo, used) => ins('vcenter_datastore_history', {
      vcenter_id: vc, datastore_name: name, captured_at: ago(daysAgo * DAY), capacity_bytes: 10 * TB, free_bytes: 10 * TB - used,
    });
    point('ds-growing', 20, 5 * TB); point('ds-growing', 0, 7 * TB); // +0.1 TB a day, 3 TB left: 30 days
    point('ds-flat', 20, 6 * TB); point('ds-flat', 0, 6 * TB);
    point('ds-single', 0, 9 * TB);
    const out = estate.gatherFor('capacity_outlook');
    const ds = out.stores.vcenterDatastores;
    expect(ds.total).toBe(3);
    const by = (n) => ds.ranked.find((r) => r.name === n);
    expect(by('ds-growing')).toMatchObject({ trend: 'growing', daysToFull: 30, historyDays: 20 });
    expect(by('ds-flat')).toMatchObject({ trend: 'flat or shrinking', daysToFull: null });
    expect(by('ds-single')).toMatchObject({ trend: 'not enough history', daysToFull: null });
    expect(ds.ranked[0].name).toBe('ds-growing');
    expect(out.storesPresent).toContain('vcenterDatastores');
    const sent = JSON.stringify(createAnonymizer().anonymize(out));
    for (const secret of ['vc-secret-01', 'ds-growing']) expect(sent.includes(secret), secret).toBe(false);
  });

  it('ops_agent_review buckets resolutions, counts repeats and reads the settings', () => {
    const base = { platforms: '["vcenter"]', severity: 'warning', hold_until: ago(0), last_event_at: ago(0), baseline: 0 };
    const resolved = (key, by, classification, resolution, openedAgo, resolvedAgo) => ins('ops_incidents', {
      ...base, incident_key: key, title: `t-${key}`, state: 'resolved', resolved_by: by, classification, resolution,
      opened_at: ago(openedAgo), resolved_at: ago(resolvedAgo),
    });
    resolved('a', 'agent', 'self-healed', null, 3 * DAY, 3 * DAY - 600000);
    resolved('b', 'agent', null, 'Cleared before the hold window ended; never triaged or emailed.', 2 * DAY, 2 * DAY - 300000);
    resolved('c', 'doug', null, 'fixed', 5 * DAY, 4 * DAY);
    for (let i = 0; i < 3; i += 1) resolved('rep', 'agent', null, 'Every alert in this incident cleared.', (i + 1) * DAY, (i + 1) * DAY - 60000);
    ins('ops_incidents', { ...base, incident_key: 'old', state: 'resolved', resolved_by: 'agent', opened_at: ago(60 * DAY), resolved_at: ago(59 * DAY) });
    ins('ops_capability_runs', { capability: 'ping', risk: 'read', target_kind: 'host', ok: 0, ran_at: ago(DAY), requested_by: 'agent' });
    ins('ops_capability_runs', { capability: 'ping', risk: 'read', target_kind: 'host', ok: 1, ran_at: ago(DAY) });
    ins('ops_incident_analyses', { incident_id: 1, at: ago(DAY), trigger: 'tick', model: 'm-1' });
    ins('ops_incident_analyses', { incident_id: 1, at: ago(DAY), trigger: 'deep-pass', model: 'm-1', error: 'x' });
    ins('ops_observations', { observer_id: 'vcenter:vm-cpu', platform: 'vcenter', subject_key: 's1', subject_label: 'vm-1', state: 'closed', outcome: 'one-off', opened_at: ago(2 * DAY), closed_at: ago(DAY), updated_at: ago(DAY) });
    const out = estate.gatherFor('ops_agent_review');
    expect(out.incidents).toMatchObject({ opened: 6, resolved: 6, openNow: 0 });
    const kinds = Object.fromEntries(out.incidents.resolvedBy.map((r) => [r.kind, r.count]));
    expect(kinds).toEqual({ 'self-healed': 1, 'self-cleared': 1, human: 1, quiet: 3 });
    expect(out.incidents.byPlatform).toEqual([{ platform: 'vcenter', count: 6 }]);
    expect(out.repeats).toMatchObject([{ timesOpened: 3 }]);
    expect(out.analyses).toMatchObject({ total: 2, withError: 1 });
    expect(out.analyses.byTrigger).toEqual(expect.arrayContaining([{ trigger: 'tick', count: 1 }, { trigger: 'deep-pass', count: 1 }]));
    expect(out.capabilityRuns.requestedBy).toEqual(expect.arrayContaining([{ requestedBy: 'agent', count: 1 }, { requestedBy: 'playbook', count: 1 }]));
    expect(out.observations.closedByOutcome).toEqual([{ outcome: 'one-off', count: 1 }]);
    expect(out.settings).toMatchObject({ grouping: 'platform', holdMinutes: 10 });
  });

  it('caps every list and keeps the gathers small', () => {
    const src = ins('lm_sources', { name: 'Acme', company: 'acme', auth_mode: 'lmv1', encrypted_credentials: 'x' });
    for (let i = 0; i < 60; i += 1) {
      ins('lm_sites', { source_id: src, site_key: `s${i}`, site_name: `Site ${i}`, wan_state: 'degraded', wan_total: 2, wan_down: 1 });
      ins('ops_incidents', { incident_key: `h${i}`, title: `Human ${i}`, platforms: '["vcenter"]', severity: 'warning', state: 'notified', opened_at: ago(DAY), hold_until: ago(DAY), last_event_at: ago(0), requires_human: 1 });
      ins('ops_observations', { observer_id: 'vcenter:vm-cpu', platform: 'vcenter', subject_key: `o${i}`, subject_label: `vm-${i}`, state: 'critical', opened_at: ago(DAY), updated_at: ago(0), peak_value: i });
      ins('lm_circuit_events', { source_id: src, instance_id: i, device_name: `d${i}`, port: 'p', event: 'down', at: sqlAgo(3600000) });
    }
    const brief = estate.gatherFor('daily_brief');
    expect(brief.siteWan).toHaveLength(10);
    expect(brief.humanRequired).toMatchObject({ total: 60 });
    expect(brief.humanRequired.items).toHaveLength(10);
    expect(brief.observations.open).toHaveLength(10);
    expect(estate.gatherFor('network_dependency').circuitEvents7d.topCircuits).toHaveLength(10);
    for (const key of estate.REPORTS) expect(JSON.stringify(estate.gatherFor(key)).length, key).toBeLessThan(60 * 1024);
  });
});
