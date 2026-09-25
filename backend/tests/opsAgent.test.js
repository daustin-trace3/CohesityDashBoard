import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const db = require('../db/database');
const { setSetting } = require('../services/settings');
const agent = require('../services/opsAgent');

const NOW = '2026-09-25T20:00:00.000Z';
const settings = { minSeverity: 'warning', holdMinutes: 10 };
const item = (platform, sourceKey, o = {}) => ({ platform, sourceKey, severity: o.severity || 'critical', host: o.host ?? 'esx-01.lab.local', message: o.message || 'alert text', firstSeen: NOW, lastSeen: NOW });

beforeEach(() => {
  db.exec('DELETE FROM ops_incident_alerts; DELETE FROM ops_incidents; DELETE FROM ops_agent_runs;');
  setSetting('ops_agent_enabled', '1');
});

const incidents = () => db.prepare('SELECT * FROM ops_incidents ORDER BY id').all();
const alertsOf = (id) => db.prepare('SELECT * FROM ops_incident_alerts WHERE incident_id = ? ORDER BY rowid').all(id);

describe('host key', () => {
  it('normalises case, domain and the Dell "(TAG)" suffix', () => {
    expect(agent.hostKey('ESX-01.lab.local')).toBe('esx-01');
    expect(agent.hostKey('r740-07 (ABC1234)')).toBe('r740-07');
    expect(agent.hostKey('10.40.7.66')).toBe('10.40.7.66');
    expect(agent.hostKey('')).toBe('');
  });
});

describe('grouping tick', () => {
  it('folds alerts on the same host from different platforms into one incident', () => {
    const stats = agent.groupTick(NOW, settings, { items: [
      item('vcenter', 'v1', { host: 'esx-01.lab.local' }),
      item('brocade', 'b1', { host: 'ESX-01', severity: 'warning' }),
      item('dell', 'd1', { host: 'r740-07 (ABC1234)' }),
    ], failed: [] });
    expect(stats.incidentsOpened).toBe(2);
    const [a, b] = incidents();
    expect(a.incident_key).toBe('host:esx-01');
    expect(JSON.parse(a.platforms).sort()).toEqual(['brocade', 'vcenter']);
    expect(a.severity).toBe('critical');
    expect(a.event_count).toBe(2);
    expect(b.incident_key).toBe('host:r740-07');
  });

  it('drops alerts below the minimum severity and groups hostless alerts per platform', () => {
    agent.groupTick(NOW, { ...settings, minSeverity: 'critical' }, { items: [
      item('pure', 'p1', { host: '', severity: 'critical' }),
      item('pure', 'p2', { host: null, severity: 'warning' }),
    ], failed: [] });
    const rows = incidents();
    expect(rows).toHaveLength(1);
    expect(rows[0].incident_key).toBe('platform:pure');
    expect(alertsOf(rows[0].id)).toHaveLength(1);
  });

  it('folds a platform into one wide incident while a source is unreachable', () => {
    agent.groupTick(NOW, settings, { items: [
      item('netapp', 'poll:3', { host: 'filer-a', message: 'ICC could not reach this source' }),
      item('netapp', 'n1', { host: 'filer-a' }),
      item('netapp', 'n2', { host: 'filer-b' }),
    ], failed: [] });
    const rows = incidents();
    expect(rows).toHaveLength(1);
    expect(rows[0].incident_key).toBe('platform:netapp:wide');
    expect(rows[0].event_count).toBe(3);
  });

  it('a second tick attaches nothing twice, clears gone alerts and resolves a self-cleared incident', () => {
    agent.groupTick(NOW, settings, { items: [item('vcenter', 'v1'), item('vcenter', 'v2', { host: 'esx-02' })], failed: [] });
    agent.groupTick(NOW, settings, { items: [item('vcenter', 'v1'), item('vcenter', 'v2', { host: 'esx-02' })], failed: [] });
    expect(incidents().every((i) => i.event_count === 1)).toBe(true);
    const later = '2026-09-25T20:03:00.000Z';
    agent.groupTick(later, settings, { items: [item('vcenter', 'v1')], failed: [] });
    const gone = incidents().find((i) => i.incident_key === 'host:esx-02');
    expect(gone.state).toBe('resolved');
    expect(gone.classification).toBe('self-cleared');
    expect(alertsOf(gone.id)[0].cleared_at).toBe(later);
    const kept = incidents().find((i) => i.incident_key === 'host:esx-01');
    expect(kept.state).toBe('collecting');
  });

  it('leaves alerts of a failed collector untouched', () => {
    agent.groupTick(NOW, settings, { items: [item('dell', 'd1')], failed: [] });
    agent.groupTick('2026-09-25T20:05:00.000Z', settings, { items: [], failed: ['dell'] });
    expect(incidents()[0].state).toBe('collecting');
    expect(alertsOf(incidents()[0].id)[0].cleared_at).toBeNull();
  });

  it('a notified incident that grows goes back to collecting for a re-triage', () => {
    agent.groupTick(NOW, settings, { items: [item('dell', 'd1')], failed: [] });
    db.prepare("UPDATE ops_incidents SET state = 'notified', notify_count = 1").run();
    agent.groupTick('2026-09-25T20:20:00.000Z', settings, { items: [item('dell', 'd1'), item('dell', 'd2', { severity: 'warning' })], failed: [] });
    const row = incidents()[0];
    expect(row.state).toBe('collecting');
    expect(row.event_count).toBe(2);
    expect(row.notify_count).toBe(1);
  });
});

describe('fallback triage and email', () => {
  const evidence = {
    incident: { id: 7, key: 'host:esx-01', title: 'esx-01', host: 'esx-01', platforms: ['vcenter', 'brocade'], severity: 'critical', openedAt: NOW },
    alerts: [
      { platform: 'vcenter', severity: 'critical', host: 'esx-01', message: 'Datastore inaccessible', cleared: false },
      { platform: 'brocade', severity: 'warning', host: 'esx-01', message: 'Port offline', cleared: false },
    ],
    hosts: [{ host: 'esx-01', platform: 'vcenter', verdict: 'degraded', verdictReason: 'host still up', hostRecords: [{ platform: 'vcenter', name: 'esx-01', up: true }], sanPaths: [{}], platformPolls: [], relatedOtherPlatformEvents: [{}] }],
    priorIncidentsSameKey30d: [{ id: 3 }],
    concurrentOpenIncidents: [],
  };

  it('classifies from history and counts, and lists what it reviewed', () => {
    const a = agent.fallbackTriage(evidence);
    expect(a.classification).toBe('recurring');
    expect(a.reviewed.some((r) => /still up/.test(r))).toBe(true);
    expect(a.reviewed.some((r) => /SAN path/.test(r))).toBe(true);
    expect(a.next_steps.length).toBeGreaterThanOrEqual(3);
    const single = agent.fallbackTriage({ ...evidence, priorIncidentsSameKey30d: [], alerts: [evidence.alerts[0]] });
    expect(single.classification).toBe('one-off');
  });

  it('renders subject, text sections and escaped html', () => {
    const inc = { id: 7, title: 'esx-01 storage', host: 'esx-01', platforms: JSON.stringify(['vcenter', 'brocade']), severity: 'critical', opened_at: NOW, notify_count: 1, model: 'gpt-x' };
    const analysis = { ...agent.fallbackTriage(evidence), source: 'ai', title: 'Path <lost>' };
    const mail = agent.renderEmail(inc, [{ platform: 'vcenter', severity: 'critical', host: 'esx-01', message: 'Datastore "DS1" inaccessible', first_seen: NOW }], analysis, { update: 1, agentName: 'Otis' });
    expect(mail.subject).toBe('[Otis] CRITICAL | esx-01 | Path <lost> [update 1]');
    expect(mail.text).toContain('Otis, incident #7 (update 1)');
    for (const h of ['WHAT HAPPENED', 'WHAT ICC REVIEWED', 'LIKELY CAUSE', 'NEXT STEPS FOR THE NEXT LEVEL', 'ESCALATION']) expect(mail.text).toContain(h);
    expect(mail.text).toContain('1. [L2]');
    expect(mail.html).toContain('Path &lt;lost&gt;');
    expect(mail.html).toContain('&quot;DS1&quot;');
    expect(mail.html).toContain('analysis by gpt-x');
  });
});

describe('manual resolve and baseline', () => {
  it('an alert resolved by hand stays quiet until it fires again later', () => {
    agent.groupTick(NOW, settings, { items: [item('dell', 'd1', { firstSeen: NOW })], failed: [] });
    const id = incidents()[0].id;
    db.prepare("UPDATE ops_incidents SET state = 'resolved', resolved_at = ?, resolved_by = 'doug' WHERE id = ?").run('2026-09-25T20:10:00.000Z', id);
    agent.groupTick('2026-09-25T20:11:00.000Z', settings, { items: [{ ...item('dell', 'd1'), firstSeen: NOW }], failed: [] });
    expect(incidents()).toHaveLength(1);
    agent.groupTick('2026-09-25T20:12:00.000Z', settings, { items: [{ ...item('dell', 'd1'), firstSeen: '2026-09-25T20:11:30.000Z' }], failed: [] });
    expect(incidents()).toHaveLength(2);
  });

  it('flags incidents opened on a cold start as baseline', () => {
    agent.groupTick(NOW, settings, { items: [item('pure', 'p1')], failed: [] }, { baseline: true });
    expect(incidents()[0].baseline).toBe(1);
    expect(agent.listIncidents({ state: 'open' })[0].baseline).toBe(true);
  });
});

describe('app services, self-heal and ordering', () => {
  it('keys app service items by app and keeps them out of the platform-wide fold', () => {
    const wide = new Set(['vcenter']);
    expect(agent.incidentKeyFor({ platform: 'appservice', sourceKey: 'usage:ATM42', host: 'ATM42 (Payments)' }, wide)).toBe('app:usage:ATM42');
    expect(agent.incidentKeyFor({ platform: 'vcenter', sourceKey: 'v1', host: 'esx-01' }, wide)).toBe('platform:vcenter:wide');
  });

  it('a stale source folds its platform into one incident and resolves as self-healed after a re-poll clears it', () => {
    agent.groupTick(NOW, settings, { items: [
      item('netapp', 'stale:4', { host: 'filer-c', severity: 'warning', message: 'Data is stale: no completed poll in 180 minutes' }),
      item('netapp', 'n9', { host: 'filer-c' }),
    ], failed: [] });
    const inc = incidents()[0];
    expect(inc.incident_key).toBe('platform:netapp:wide');
    db.prepare("UPDATE ops_incidents SET heal_attempted = 1, heal_at = ?, heal_actions_json = ? WHERE id = ?")
      .run('2026-09-25T20:01:00.000Z', JSON.stringify([{ at: '2026-09-25T20:01:00.000Z', action: 'repoll', target: 'filer-c', result: 'poll triggered' }]), inc.id);
    agent.groupTick('2026-09-25T20:04:00.000Z', settings, { items: [], failed: [] });
    const done = incidents()[0];
    expect(done.state).toBe('resolved');
    expect(done.classification).toBe('self-healed');
    expect(done.summary).toMatch(/re-polled filer-c/);
  });

  it('says a human is required when the re-poll did not help, and not for a plain warning', () => {
    const base = { incident: { id: 1, key: 'platform:netapp:wide', platforms: ['netapp'], severity: 'warning', host: null }, hosts: [], priorIncidentsSameKey30d: [], concurrentOpenIncidents: [] };
    const stuck = agent.fallbackTriage({ ...base, alerts: [{ platform: 'netapp', severity: 'warning', message: 'Data is stale: no completed poll in 200 minutes', cleared: false }], selfHeal: { outcome: 'still failing after the re-poll: NetApp filer-c' } });
    expect(stuck.human_required).toBe(true);
    const calm = agent.fallbackTriage({ ...base, alerts: [{ platform: 'netapp', severity: 'warning', message: 'Volume 80% full', cleared: false }] });
    expect(calm.human_required).toBe(false);
  });

  it('lists incidents by severity then impact, not by number', () => {
    agent.groupTick(NOW, settings, { items: [
      item('pure', 'p1', { host: 'array-a', severity: 'warning' }),
      item('dell', 'd1', { host: 'r740-01', severity: 'critical' }),
      item('appservice', 'usage:ATM7', { host: 'ATM7 (Trading)', severity: 'critical' }),
      item('vcenter', 'v1', { host: 'esx-09', severity: 'critical' }),
      item('brocade', 'b1', { host: 'esx-09', severity: 'warning' }),
    ], failed: [] });
    const list = agent.listIncidents({ state: 'open' });
    expect(list.map((i) => i.kind)).toEqual(['app-service', 'host', 'host', 'host']);
    expect(list[1].host).toBe('esx-09');
    expect(list[3].severity).toBe('warning');
    expect(list.every((i) => typeof i.impactScore === 'number')).toBe(true);
  });
});

describe('self-heal re-poll', () => {
  const registry = require('../core/registry');

  it('hands the poller the source id, so the framework resolves the full row', () => {
    const seen = [];
    registry.registerPlugin({
      id: 'fakeplat', name: 'Fake', apiVersion: registry.PLUGIN_API_VERSION, migrations: [],
      createRouter: () => (req, res, next) => next(),
      createPoller: () => ({ trigger: (arg) => { seen.push(arg); return Promise.resolve(); } }),
    });
    const rec = agent.triggerPoll('fakeplat', 7, 'filer-a');
    expect(rec).toMatchObject({ action: 'repoll', platform: 'fakeplat', target: 'filer-a', result: 'poll triggered' });
    expect(seen).toEqual([7]);
  });

  it('says so plainly when a platform has no poll ICC can trigger', () => {
    registry.registerPlugin({
      id: 'nopoll', name: 'NoPoll', apiVersion: registry.PLUGIN_API_VERSION, migrations: [],
      createRouter: () => (req, res, next) => next(),
    });
    expect(agent.triggerPoll('nopoll', 1, 'x').result).toMatch(/no on-demand poll/);
  });
});

describe('auto-resolution', () => {
  const CONFIG = { smtpHost: '', smtpFrom: '', smtpRecipients: '' };
  const quiet = { ...settings, autoResolveMinutes: 30, evidenceResolve: false, name: 'Otis', emailEnabled: false };
  const triaged = (id) => db.prepare("UPDATE ops_incidents SET state = 'triaged', triaged_at = ?, summary = 'x' WHERE id = ?").run(NOW, id);

  it('holds a triaged incident in clearing, then closes it once the alerts stay quiet', async () => {
    agent.groupTick(NOW, quiet, { items: [item('dell', 'd1')], failed: [] });
    triaged(incidents()[0].id);
    agent.groupTick('2026-09-25T20:05:00.000Z', quiet, { items: [], failed: [] });
    let row = incidents()[0];
    expect(row.state).toBe('clearing');
    expect(row.cleared_since).toBe('2026-09-25T20:05:00.000Z');

    await agent.resolvePass('2026-09-25T20:20:00.000Z', quiet, CONFIG, 5);
    expect(incidents()[0].state).toBe('clearing');   // 15 min of quiet, window is 30

    const out = await agent.resolvePass('2026-09-25T20:40:00.000Z', quiet, CONFIG, 5);
    row = incidents()[0];
    expect(out.resolvedQuiet).toBe(1);
    expect(row.state).toBe('resolved');
    expect(row.resolved_by).toBe('agent');
    expect(row.resolution).toMatch(/none fired again in the 35 minutes since, so Otis closed this incident/);
  });

  it('a re-fire inside the quiet window reopens the incident instead of closing it', async () => {
    agent.groupTick(NOW, quiet, { items: [item('dell', 'd1')], failed: [] });
    triaged(incidents()[0].id);
    agent.groupTick('2026-09-25T20:05:00.000Z', quiet, { items: [], failed: [] });
    expect(incidents()[0].state).toBe('clearing');
    agent.groupTick('2026-09-25T20:10:00.000Z', quiet, { items: [item('dell', 'd1', { firstSeen: '2026-09-25T20:09:00.000Z' })], failed: [] });
    const row = incidents()[0];
    expect(row.state).toBe('collecting');
    expect(row.cleared_since).toBeNull();
    const out = await agent.resolvePass('2026-09-25T21:00:00.000Z', quiet, CONFIG, 5);
    expect(out.resolvedQuiet).toBe(0);
  });

  it('closes on the spot when the quiet window is zero', () => {
    const immediate = { ...quiet, autoResolveMinutes: 0 };
    agent.groupTick(NOW, immediate, { items: [item('pure', 'p1')], failed: [] });
    triaged(incidents()[0].id);
    agent.groupTick('2026-09-25T20:05:00.000Z', immediate, { items: [], failed: [] });
    const row = incidents()[0];
    expect(row.state).toBe('resolved');
    expect(row.resolution).toMatch(/Every alert in this incident cleared/);
  });

  it('only offers evidence-resolution for a platform alert whose subject ICC sees as healthy', () => {
    const open = [{ source_key: 'a1', cleared_at: null }];
    const healthy = { hosts: [{ verdict: 'degraded', hostRecords: [{ up: true }], platformPolls: [{ lastPollStatus: 'success' }] }] };
    expect(agent.evidenceResolveEligible(open, healthy)).toBe(true);
    expect(agent.evidenceResolveEligible([{ source_key: 'poll:3', cleared_at: null }], healthy)).toBe(false);
    expect(agent.evidenceResolveEligible([{ source_key: 'stale:3', cleared_at: null }], healthy)).toBe(false);
    expect(agent.evidenceResolveEligible(open, { hosts: [{ verdict: 'offline', hostRecords: [{ up: true }] }] })).toBe(false);
    expect(agent.evidenceResolveEligible(open, { hosts: [{ verdict: 'degraded', hostRecords: [{ up: true }], platformPolls: [{ lastPollStatus: 'error' }] }] })).toBe(false);
    expect(agent.evidenceResolveEligible(open, { hosts: [{ verdict: 'degraded', hostRecords: [{ up: null }] }] })).toBe(false);
    expect(agent.evidenceResolveEligible([{ source_key: 'a1', cleared_at: NOW }], healthy)).toBe(false);
  });
});

describe('grouping modes', () => {
  const alerts = () => [
    { platform: 'cohesity', sourceKey: 'c1:a1', severity: 'critical', host: 'sql-01', message: 'backup failed', firstSeen: NOW },
    { platform: 'cohesity', sourceKey: 'c2:a9', severity: 'critical', host: 'web-02', message: 'backup failed', firstSeen: NOW },
    { platform: 'cohesity', sourceKey: 'poll:7', severity: 'critical', host: 'cluster-b', message: 'unreachable', firstSeen: NOW },
    { platform: 'vcenter', sourceKey: 'v:i1', severity: 'warning', host: 'vc-prod', message: 'host issue', firstSeen: NOW },
  ];
  const keys = () => incidents().map((i) => i.incident_key).sort();

  it('platform mode folds a platform whose source is unreachable (today\'s default)', () => {
    agent.groupTick(NOW, { ...settings, grouping: 'platform' }, { items: alerts(), failed: [] });
    expect(keys()).toEqual(['host:vc-prod', 'platform:cohesity:wide']);
  });

  it('component mode keeps every server and every source apart', () => {
    agent.groupTick(NOW, { ...settings, grouping: 'component' }, { items: alerts(), failed: [] });
    expect(keys()).toEqual(['host:cluster-b', 'host:sql-01', 'host:vc-prod', 'host:web-02']);
    const hostless = [{ platform: 'cohesity', sourceKey: 'c3:a4', severity: 'critical', host: null, message: 'cluster alert', firstSeen: NOW },
      { platform: 'cohesity', sourceKey: 'c4:a5', severity: 'critical', host: null, message: 'cluster alert', firstSeen: NOW }];
    agent.groupTick('2026-09-25T20:01:00.000Z', { ...settings, grouping: 'component' }, { items: [...alerts(), ...hostless], failed: [] });
    expect(keys()).toContain('src:cohesity:c3');
    expect(keys()).toContain('src:cohesity:c4');
  });

  it('service mode rolls a server into the app service it belongs to', () => {
    const appOf = new Map([['sql-01', { usageId: 'aa1', displayId: 'AA1', label: 'Payments' }]]);
    agent.groupTick(NOW, { ...settings, grouping: 'service' }, { items: alerts(), failed: [], appOf });
    expect(keys()).toEqual(['app:usage:aa1', 'host:vc-prod', 'host:web-02', 'src:cohesity:s7']);
    const app = incidents().find((i) => i.incident_key === 'app:usage:aa1');
    expect(app.title).toBe('App service AA1 (Payments)');
  });

  it('reads the source token each collector encodes', () => {
    expect(agent.sourceTokenOf({ sourceKey: 'c12:9' })).toBe('c12');
    expect(agent.sourceTokenOf({ sourceKey: 'a3:alert:hash' })).toBe('a3');
    expect(agent.sourceTokenOf({ sourceKey: 'poll:7' })).toBe('s7');
    expect(agent.sourceTokenOf({ sourceKey: 'stale:4' })).toBe('s4');
    expect(agent.sourceTokenOf({ sourceKey: 'aws:i1' })).toBe('aws');
  });
});

describe('email gating', () => {
  const on = { emailEnabled: true };
  const smtp = { smtpEnabled: true, smtpHost: 'smtp.lab', smtpFrom: 'icc@lab' };

  it('never sends automatically while SMTP is switched off in Global Settings', () => {
    expect(agent.emailBlockedReason(on, { ...smtp, smtpEnabled: false })).toMatch(/switched off in Global Settings/);
  });

  it('never sends while the agent\'s own switch is off, or with nowhere to send', () => {
    expect(agent.emailBlockedReason({ emailEnabled: false }, smtp)).toMatch(/agent's own email switch/);
    expect(agent.emailBlockedReason(on, { ...smtp, smtpHost: '' })).toMatch(/no host or from address/);
    expect(agent.emailBlockedReason(on, { ...smtp, smtpFrom: '' })).toMatch(/no host or from address/);
  });

  it('allows the send when both switches are on and SMTP is addressed', () => {
    expect(agent.emailBlockedReason(on, smtp)).toBeNull();
  });
});

describe('autonomous actions are logged at INFO with detail', () => {
  const logger = require('../utils/logger');
  let lines; let realInfo;
  beforeEach(() => { lines = []; realInfo = logger.info; logger.info = (...a) => lines.push(a.join(' ')); });
  afterEach(() => { logger.info = realInfo; });
  const acts = () => lines.filter((l) => l.includes('[OpsAgent] ACTION'));

  it('names the incident it opened, including a baseline backlog', () => {
    agent.groupTick(NOW, settings, { items: [item('dell', 'd1', { host: 'r740-01' })], failed: [] });
    expect(acts()).toHaveLength(1);
    expect(acts()[0]).toMatch(/ACTION opened incident: #\d+ r740-01 \[host:r740-01\] first alert \S+ critical$/);
    lines.length = 0;
    agent.groupTick(NOW, settings, { items: [item('pure', 'p1', { host: 'array-a' })], failed: [] }, { baseline: true });
    expect(acts()[0]).toMatch(/baseline \(pre-existing backlog, will not email\)/);
  });

  it('records a self-clear and a clearing hold, each naming the incident', () => {
    agent.groupTick(NOW, settings, { items: [item('dell', 'd1')], failed: [] });
    lines.length = 0;
    agent.groupTick('2026-09-25T20:02:00.000Z', settings, { items: [], failed: [] });
    expect(acts()[0]).toMatch(/ACTION resolved incident: #\d+ self-cleared before triage, never emailed/);

    db.exec("DELETE FROM ops_incident_alerts; DELETE FROM ops_incidents;");
    agent.groupTick(NOW, { ...settings, autoResolveMinutes: 30 }, { items: [item('dell', 'd2')], failed: [] });
    db.prepare("UPDATE ops_incidents SET state = 'notified'").run();
    lines.length = 0;
    agent.groupTick('2026-09-25T20:02:00.000Z', { ...settings, autoResolveMinutes: 30 }, { items: [], failed: [] });
    expect(acts()[0]).toMatch(/ACTION incident clearing: #\d+ every alert cleared, holding 30 min of quiet/);
  });

  it('logs the quiet close with how long it waited', async () => {
    agent.groupTick(NOW, { ...settings, autoResolveMinutes: 30 }, { items: [item('dell', 'd1')], failed: [] });
    const id = incidents()[0].id;
    db.prepare("UPDATE ops_incidents SET state = 'clearing', cleared_since = ? WHERE id = ?").run(NOW, id);
    lines.length = 0;
    await agent.resolvePass('2026-09-25T21:00:00.000Z', { ...settings, autoResolveMinutes: 30, evidenceResolve: false, name: 'Otis', emailEnabled: false }, { smtpHost: '', smtpFrom: '' }, 0);
    expect(acts()[0]).toMatch(/ACTION resolved incident: #\d+ quiet for 60 min after its alerts cleared/);
  });
});
