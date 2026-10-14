/**
 * LogicMonitor AI Advisor round 6 presets: network_brief, chokepoints,
 * change_impact, monitoring_coverage, suppression_review, app_network_exposure,
 * interface_errors, alert_delivery and the scoped site_brief. Every gather runs
 * on the empty schema and on a small hand-built estate; the site-brief routes
 * are driven over supertest with the LLM unconfigured (no network call).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);

const express = require('express');
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const { encrypt } = require('../services/encryption');

let app;
let advisor;

beforeAll(() => {
  runMigrations(db, 'logicmonitor', lmMigrations);
  advisor = require('../services/advisors/logicmonitorAdvisor');
  const router = require('../routes/logicmonitor');
  const errorHandler = require('../middleware/errorHandler');
  app = express();
  app.use(express.json());
  app.use('/api/logicmonitor', router);
  app.use(errorHandler);
});

const TABLES = ['lm_blame_history', 'lm_issue_history', 'lm_metrics_history', 'lm_ai_reports', 'lm_topology_links',
  'lm_webhook_events', 'lm_interface_baseline', 'lm_sites', 'lm_check_daily', 'lm_check_baseline', 'lm_check_history',
  'lm_check_locations', 'lm_checks', 'lm_sdts', 'lm_collectors', 'lm_alerts', 'lm_interface_daily', 'lm_interface_history',
  'lm_interfaces', 'lm_device_datasources', 'lm_device_groups', 'lm_devices', 'lm_sources', 'config_changes', 'app_service_watch'];

function wipe() {
  for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
}
function ins(table, row) {
  const cols = Object.keys(row);
  return db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => row[c])).lastInsertRowid;
}
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const sqlTs = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);
const nowSec = () => Math.floor(Date.now() / 1000);
const dayStr = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 10);

const UNSCOPED = ['network_brief', 'chokepoints', 'change_impact', 'monitoring_coverage', 'suppression_review',
  'app_network_exposure', 'interface_errors', 'alert_delivery'];

function seed() {
  const sid = ins('lm_sources', {
    name: 'Acme Ops', company: 'acme', auth_mode: 'lmv1', encrypted_credentials: encrypt(JSON.stringify({ accessId: 'a', accessKey: 'b' })),
    polling_interval_minutes: 5, webhook_enabled: 1, webhook_count: 1, webhook_last_at: sqlTs(9 * MIN),
  });
  ins('lm_sites', { source_id: sid, site_key: 'phoenix-dc', site_name: 'Phoenix DC', device_count: 2, network_count: 2 });
  const dev = (o) => ins('lm_devices', { source_id: sid, device_type: 0, alert_status: 'none', sdt_status: 'none-none-none', group_ids_json: '[]', host_status: 'normal', ...o });
  dev({ lm_device_id: 101, name: '10.0.0.1', display_name: 'phx-sw1', vendor: 'Cisco', role: 'switch', is_network: 1, model: 'C9300', version: '17.9.4a', site_key: 'phoenix-dc', if_count: 2, if_up: 1 });
  dev({ lm_device_id: 102, name: '10.0.0.2', display_name: 'phx-sw2', vendor: 'Cisco', role: 'switch', is_network: 1, model: 'C9300', version: '17.6.5', site_key: 'phoenix-dc', host_status: 'dead' });
  dev({ lm_device_id: 103, name: 'srv1', display_name: 'app-srv1', vendor: 'Microsoft', role: 'server', is_network: 0, sdt_status: 'none-SDT-none' });

  const iface = (o) => ins('lm_interfaces', { source_id: sid, lm_device_id: 101, speed_bps: 1000000000, sampled_at_epoch: nowSec() - 60, ...o });
  iface({ instance_id: 1, display_name: 'Gi1/0/1', instance_name: 'Gi1/0/1', description: 'to phx-sw2', status: 1, status_text: 'up', in_errors: 5, out_errors: 1 });
  iface({ instance_id: 2, display_name: 'Gi1/0/2', instance_name: 'Gi1/0/2', status: 2, status_text: 'down' });
  // Errors: 30 per day over the last 3 days, 2 per day over the 4 days before.
  for (let d = 0; d <= 6; d += 1) {
    ins('lm_interface_daily', { source_id: sid, instance_id: 1, day: dayStr(d * DAY), errors_sum: d <= 2 ? 30 : 2, discards_sum: 0, flaps: 0, max_in_util_pct: 10, max_out_util_pct: 5 });
  }
  ins('lm_interface_baseline', { source_id: sid, instance_id: 1, hour_of_day: new Date().getUTCHours(), samples: 20, util_median: 5, util_mad: 1, err_median: 1, err_mad: 0.5 });
  ins('lm_issue_history', { issue_key: 'k-err', source: 'Acme Ops', severity: 'warning', type: 'interface-errors-growing', target: 'phx-sw1 Gi1/0/1',
    message: 'phx-sw1 Gi1/0/1 logged 90 errors in 24 h and is still erroring', status: 'open', first_seen: sqlTs(3 * HOUR), last_seen: sqlTs(0) });

  // Blame: phx-sw1 Gi1/0/1 blamed 4 times across 3 distinct days.
  [0, 1, 2, 2].forEach((d, k) => ins('lm_blame_history', {
    source_id: sid, at: sqlTs(d * DAY + (k + 1) * MIN), kind: 'check', subject: 'dc-ping', subject_key: 'w:1', hop_device_id: 101,
    hop_device_name: 'phx-sw1', hop_port: 'Gi1/0/1', hop_state: 'critical', hop_reason: 'port errors', site_key: 'phoenix-dc', issue_key: `ik${k}`,
  }));

  // One change followed by an incident, one without.
  ins('config_changes', { platform: 'logicmonitor', scope: 'device-inventory', system: 'Acme Ops', item: 'phx-sw1', change_type: 'changed', old_value: 'a', new_value: 'b', detected_at: new Date(Date.now() - 5 * HOUR).toISOString() });
  ins('config_changes', { platform: 'logicmonitor', scope: 'links', system: 'Acme Ops', item: 'zzz-unknown', change_type: 'added', old_value: null, new_value: 'x', detected_at: new Date(Date.now() - 2 * HOUR).toISOString() });
  ins('lm_issue_history', { issue_key: 'k-dead', source: 'Acme Ops', severity: 'critical', type: 'device-dead', target: 'phx-sw1',
    message: 'phx-sw1 is dead', status: 'open', first_seen: new Date(Date.now() - 4 * HOUR).toISOString(), last_seen: sqlTs(0) });

  // Suppression: one shadowed alert, one SDT on the server.
  ins('lm_alerts', { source_id: sid, lm_alert_id: 'SH1', severity: 3, severity_norm: 'warning', lm_device_id: 103, monitor_object_name: 'app-srv1',
    resource_template_name: 'WinCPU', start_epoch: nowSec() - 3600, cleared: 0, acked: 0, sdted: 1, rule: 'Default', condition_key: 'c1',
    shadowed_by: JSON.stringify({ sourceId: sid, deviceId: 102, deviceName: 'phx-sw2', port: null, reason: 'device is dead' }) });
  ins('lm_sdts', { source_id: sid, sdt_id: 'S1', sdt_type: 'DeviceSDT', schedule_type: 'oneTime', is_effective: 1, start_ms: Date.now() - 10 * DAY,
    end_ms: Date.now() + DAY, admin: 'ops', comment: 'patching', lm_device_id: 103, device_display_name: 'app-srv1' });

  // Alert delivery: alert A1 started 600 s ago, webhook accepted it 540 s ago (lag about 60 s).
  ins('lm_alerts', { source_id: sid, lm_alert_id: 'A1', internal_id: 'LMD1', severity: 4, severity_norm: 'critical', lm_device_id: 101,
    monitor_object_name: 'phx-sw1', resource_template_name: 'Cisco_CPU', start_epoch: nowSec() - 600, cleared: 0, acked: 0, sdted: 0, rule: 'Default', condition_key: 'c2' });
  ins('lm_alerts', { source_id: sid, lm_alert_id: 'A2', internal_id: 'LMD2', severity: 3, severity_norm: 'warning', lm_device_id: 101,
    monitor_object_name: 'phx-sw1', resource_template_name: 'Cisco_Mem', start_epoch: nowSec() - 300, cleared: 0, acked: 0, sdted: 0, rule: 'Default', condition_key: 'c3' });
  ins('lm_webhook_events', { source_id: sid, received_at: sqlTs(540 * 1000), status: 'active', lm_alert_id: 'A1', internal_id: 'LMD1', host: 'phx-sw1', accepted: 1 });
  ins('lm_webhook_events', { source_id: sid, received_at: sqlTs(100 * 1000), status: 'active', lm_alert_id: 'ZZ', accepted: 0, error: 'status must be one of active' });
  [15, 10, 5].forEach((m) => ins('lm_metrics_history', { source_id: sid, captured_at: sqlTs(m * MIN), devices_total: 3 }));
  return sid;
}

beforeEach(() => { wipe(); });
afterAll(() => { wipe(); });

describe('logicmonitor advisor round 6: registry', () => {
  it('lists the nine new keys and marks only site_brief scoped', () => {
    for (const k of [...UNSCOPED, 'site_brief']) expect(advisor.REPORTS).toContain(k);
    expect(advisor.SCOPED).toEqual(['site_brief']);
    expect(advisor.REPORTS).toHaveLength(19);
  });
});

describe('logicmonitor advisor round 6: empty database', () => {
  it('every new gather returns its full shape with empty lists', () => {
    for (const k of UNSCOPED) {
      const out = advisor.gatherFor(k);
      expect(out.note, k).toBe('No LogicMonitor portals registered.');
      expect(typeof out.generatedAt, k).toBe('string');
    }
    const nb = advisor.gatherFor('network_brief');
    expect(nb.nodes).toEqual([]);
    expect(nb.burning).toEqual([]);
    expect(nb.trendsLastSixHours.hours).toHaveLength(6);
    expect(nb.changedLast24h.issuesOpened).toEqual([]);
    expect(advisor.gatherFor('chokepoints').topHops).toEqual([]);
    const ci = advisor.gatherFor('change_impact');
    expect(ci.pairedChanges).toEqual([]);
    expect(ci.newestChangesWithNoIncident).toEqual([]);
    const mc = advisor.gatherFor('monitoring_coverage');
    expect(mc.coverageScore).toBeNull();
    expect(mc.gaps.networkDevicesWithNoSite.items).toEqual([]);
    expect(mc.webhooksByPortal).toEqual([]);
    const sr = advisor.gatherFor('suppression_review');
    expect(sr.shadowedAlerts.byUpstream).toEqual([]);
    expect(sr.devicesInSdt.items).toEqual([]);
    expect(sr.sdtsOlderThanSevenDaysOrWithNoEnd).toEqual([]);
    expect(advisor.gatherFor('app_network_exposure')).toMatchObject({ appsWatched: 0, apps: [] });
    const ie = advisor.gatherFor('interface_errors');
    expect(ie.worstGrowingByDevice).toEqual([]);
    expect(ie.openIssues).toEqual([]);
    expect(advisor.gatherFor('alert_delivery').portals).toEqual([]);
  });

  it('site_brief returns null for a missing scope and an unknown site', () => {
    expect(advisor.gatherFor('site_brief')).toBeNull();
    expect(advisor.gatherFor('site_brief', { scope: 'phoenix-dc' })).toBeNull();
    expect(advisor.gatherFor('site_brief', { scope: 'Not A Key!' })).toBeNull();
  });
});

describe('logicmonitor advisor round 6: seeded estate', () => {
  it('every unscoped gather runs and carries no empty-estate note', () => {
    seed();
    for (const k of UNSCOPED) expect(advisor.gatherFor(k).note, k).toBeUndefined();
  });

  it('network_brief trims the overview to six points and lists the sites', () => {
    seed();
    const nb = advisor.gatherFor('network_brief');
    expect(nb.nodesTotal).toBe(1);
    expect(nb.nodes[0]).toMatchObject({ siteKey: 'phoenix-dc', devicesDead: 1 });
    expect(nb.nodes[0].reachability.lastSixHours).toHaveLength(6);
    expect(nb.counters.devicesDead).toBeGreaterThanOrEqual(1);
    expect(nb.changedLast24h.issuesOpenedTotal).toBeGreaterThanOrEqual(2);
    expect(nb.changedLast24h.configChangesByScope['device-inventory']).toBe(1);
  });

  it('chokepoints lists the seeded hop with its distinct days and current interface state', () => {
    seed();
    const cp = advisor.gatherFor('chokepoints');
    expect(cp.topHops).toHaveLength(1);
    expect(cp.topHops[0]).toMatchObject({ device: 'phx-sw1', port: 'Gi1/0/1', timesBlamed: 4, distinctDaysBlamed: 3, pattern: 'recurring' });
    expect(cp.topHops[0].currentInterface).toMatchObject({ port: 'Gi1/0/1', status: 'up', inErrors: 5 });
    expect(cp.topHops[0].openIssues.map((i) => i.type)).toContain('interface-errors-growing');
    expect(cp.recentBlames.length).toBe(4);
  });

  it('change_impact pairs the change that an incident followed and lists the other as unpaired', () => {
    seed();
    const ci = advisor.gatherFor('change_impact');
    expect(ci.changesTotal).toBe(2);
    expect(ci.changesFollowedByIncident).toBe(1);
    expect(ci.pairedChanges[0]).toMatchObject({ item: 'phx-sw1', scope: 'device-inventory' });
    expect(ci.pairedChanges[0].incidents[0]).toMatchObject({ type: 'device-dead' });
    expect(ci.pairedChanges[0].firstIncidentMinutesAfter).toBeGreaterThan(30);
    expect(ci.newestChangesWithNoIncident.map((c) => c.item)).toEqual(['zzz-unknown']);
    expect(ci.byScope.find((s) => s.scope === 'device-inventory')).toMatchObject({ changes: 1, followedByIncident: 1 });
  });

  it('monitoring_coverage reports the gaps, the populations and the webhook state', () => {
    seed();
    const mc = advisor.gatherFor('monitoring_coverage');
    expect(typeof mc.coverageScore).toBe('number');
    expect(mc.populations.networkDevices).toBe(2);
    expect(mc.gaps.switchesWithNoNeighborDatasource.total).toBe(2);
    expect(mc.gaps.networkDevicesWithNoSite.total).toBe(0);
    expect(mc.counts.devicesWithNoSite).toBe(1);
    expect(mc.counts.openAlertsShadowed).toBe(1);
    expect(mc.webhooksByPortal[0]).toMatchObject({ portal: 'Acme Ops', enabled: true, accepted7d: 1, rejected7d: 1 });
  });

  it('suppression_review counts the shadowed alert by upstream device and the SDT device', () => {
    seed();
    const sr = advisor.gatherFor('suppression_review');
    expect(sr.shadowedAlerts.total).toBe(1);
    expect(sr.shadowedAlerts.byUpstream[0]).toMatchObject({ upstream: 'phx-sw2', alerts: 1, reason: 'device is dead' });
    expect(sr.devicesInSdt.total).toBe(1);
    expect(sr.devicesInSdt.items[0]).toMatchObject({ device: 'app-srv1', openAlertsInSdt: 1 });
    expect(sr.devicesInSdt.items[0].sdt.startedHoursAgo).toBeGreaterThan(200);
    expect(sr.openAlertsInSdt.total).toBe(1);
    expect(sr.sdtsOlderThanSevenDaysOrWithNoEnd).toHaveLength(1);
    expect(sr.sdtsOlderThanSevenDaysOrWithNoEnd[0]).toMatchObject({ ageDays: 10, noEnd: false });
  });

  it('app_network_exposure lists a watched app even when no VM carries its tag', () => {
    seed();
    ins('app_service_watch', { usage_id: 'aa1', display_id: 'AA1', created_at: new Date().toISOString() });
    const ex = advisor.gatherFor('app_network_exposure');
    expect(ex.appsWatched).toBe(1);
    expect(ex.apps).toHaveLength(1);
    expect(ex.apps[0]).toMatchObject({ usageId: 'aa1', state: 'unknown', serversChecked: 0, distinctSwitches: 0 });
  });

  it('interface_errors lists the interface whose error rate grew, with its baseline and the open issue', () => {
    seed();
    const ie = advisor.gatherFor('interface_errors');
    expect(ie.interfacesGrowing).toBe(1);
    expect(ie.worstGrowingByDevice).toHaveLength(1);
    expect(ie.worstGrowingByDevice[0].device).toBe('phx-sw1');
    expect(ie.worstGrowingByDevice[0].ports[0]).toMatchObject({ port: 'Gi1/0/1', errorsPerDayLast3d: 30, errorsPerDayPrior4d: 2, baselineThisHour: { errMedian: 1, errMad: 0.5 } });
    expect(ie.openIssues).toHaveLength(1);
    expect(ie.openIssues[0].baselineThisHour).toMatchObject({ errMedian: 1 });
  });

  it('alert_delivery computes the webhook lag and the polling-only alerts', () => {
    seed();
    const ad = advisor.gatherFor('alert_delivery');
    expect(ad.portals).toHaveLength(1);
    const p = ad.portals[0];
    expect(p.lagSecondsAlertStartToWebhook7d.alertsSeenBothWays).toBe(1);
    expect(p.lagSecondsAlertStartToWebhook7d.median).toBeGreaterThanOrEqual(58);
    expect(p.lagSecondsAlertStartToWebhook7d.median).toBeLessThanOrEqual(62);
    expect(p.alertsSeenOnlyByPolling24h).toBe(2);
    expect(p.webhook.events24h).toEqual({ accepted: 1, rejected: 1 });
    expect(p.webhook.topRejectReasons24h[0].error).toContain('status must be');
    expect(p.polling.samples24h).toBe(3);
    expect(p.polling.averageGapMinutes24h).toBeGreaterThan(4);
    expect(p.polling.averageGapMinutes24h).toBeLessThan(6);
  });

  it('site_brief returns the site, its devices and the open issues for a seeded site', () => {
    seed();
    const sb = advisor.gatherFor('site_brief', { scope: 'phoenix-dc' });
    expect(sb.site).toMatchObject({ siteKey: 'phoenix-dc', siteName: 'Phoenix DC', portal: 'Acme Ops', state: 'critical', devicesDead: 1 });
    expect(sb.devicesTotal).toBe(2);
    expect(sb.devices[0]).toMatchObject({ device: 'phx-sw2', hostStatus: 'dead' });
    expect(sb.interfacesDownTotal).toBe(1);
    expect(sb.interfacesDown[0]).toMatchObject({ device: 'phx-sw1', port: 'Gi1/0/2' });
    expect(sb.openIssues.map((i) => i.type)).toEqual(expect.arrayContaining(['device-dead', 'interface-errors-growing']));
    expect(sb.changesLast7d.map((c) => c.item)).toEqual(['phx-sw1']);
    expect(sb.blamedHopsAtSite30d[0]).toMatchObject({ device: 'phx-sw1', timesBlamed: 4 });
    expect(sb.unmonitored.devicesWithNoInterfaceDatasource).toEqual(expect.arrayContaining(['phx-sw1']));
  });
});

describe('logicmonitor advisor round 6: routes', () => {
  const API = '/api/logicmonitor';

  it('site-brief GET is 404 for an unknown site and 200 with no cached report for a known one', async () => {
    seed();
    expect((await request(app).get(`${API}/advisor/site-brief/nope`)).status).toBe(404);
    const ok = await request(app).get(`${API}/advisor/site-brief/phoenix-dc`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ enabled: false, report: null });
    expect((await request(app).get(`${API}/advisor/site-brief/Bad_Key`)).status).toBe(400);
  });

  it('site-brief POST is 503 without a provider and 404 for an unknown site; email 404s with nothing cached', async () => {
    seed();
    expect((await request(app).post(`${API}/advisor/site-brief/phoenix-dc`)).status).toBe(503);
    expect((await request(app).post(`${API}/advisor/site-brief/nope`)).status).toBe(404);
    expect((await request(app).post(`${API}/advisor/site-brief/phoenix-dc/email`).send({})).status).toBe(404);
    expect((await request(app).post(`${API}/advisor/site-brief/nope/email`).send({})).status).toBe(404);
  });

  it('the generic routes answer 400 SCOPE_NEEDED for site_brief', async () => {
    for (const res of [
      await request(app).get(`${API}/advisor/site-brief`),
      await request(app).get(`${API}/advisor/reports/site-brief`),
      await request(app).post(`${API}/advisor/site-brief`),
      await request(app).post(`${API}/advisor/reports/site-brief/generate`),
      await request(app).post(`${API}/advisor/reports/site-brief/email`).send({}),
    ]) {
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SCOPE_NEEDED');
    }
  });

  it('the new unscoped keys are served by the generic routes', async () => {
    const g = await request(app).get(`${API}/advisor/network-brief`);
    expect(g.status).toBe(200);
    expect(g.body).toEqual({ enabled: false, report: null });
    expect((await request(app).post(`${API}/advisor/alert-delivery`)).status).toBe(503);
  });
});
