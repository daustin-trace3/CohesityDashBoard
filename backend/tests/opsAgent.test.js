import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    recurrence: { windowDays: 14, threshold: 3, count: 3, isPattern: true, typicalGapMinutes: 180, closedByAgent: 2,
      occurrences: [{ id: 3, openedAt: NOW, minutesOpen: 20, closedBy: 'agent', resolution: 'cleared' }, { id: 2, openedAt: NOW, minutesOpen: 15, closedBy: 'agent', resolution: 'cleared' }] },
    concurrentOpenIncidents: [],
  };

  it('classifies from history and counts, and lists what it reviewed', () => {
    const a = agent.fallbackTriage(evidence);
    expect(a.classification).toBe('recurring');
    expect(a.reviewed.some((r) => /still up/.test(r))).toBe(true);
    expect(a.reviewed.some((r) => /SAN path/.test(r))).toBe(true);
    expect(a.next_steps.length).toBeGreaterThanOrEqual(3);
    const single = agent.fallbackTriage({ ...evidence, recurrence: { windowDays: 14, count: 1, isPattern: false, occurrences: [] }, alerts: [evidence.alerts[0]] });
    expect(single.classification).toBe('one-off');
  });

  it('renders subject, text sections and escaped html', () => {
    const inc = { id: 7, title: 'esx-01 storage', host: 'esx-01', platforms: JSON.stringify(['vcenter', 'brocade']), severity: 'critical', opened_at: NOW, notify_count: 1, model: 'gpt-x' };
    const analysis = { ...agent.fallbackTriage(evidence), source: 'ai', title: 'Path <lost>' };
    const mail = agent.renderEmail(inc, [{ platform: 'vcenter', severity: 'critical', host: 'esx-01', message: 'Datastore "DS1" inaccessible', first_seen: NOW }], analysis, { update: 1, agentName: 'Otis' });
    // The agent's name rides in the From display name, not the subject.
    // fallbackTriage marks a critical incident human-required, which prefixes the subject.
    expect(mail.subject).toBe('HUMAN REQUIRED | CRITICAL | esx-01 | Path <lost> [update 1]');
    const calm = agent.renderEmail(inc, [], { ...analysis, human_required: false }, { update: 1, agentName: 'Otis' });
    expect(calm.subject).toBe('CRITICAL | esx-01 | Path <lost> [update 1]');
    expect(mail.text).toContain('Otis, incident #7 (update 1)');
    // Timestamps render as Pacific wall-clock time, never raw ISO.
    expect(mail.text).toContain('Opened: 9-25-2026 1:00pm PDT');
    expect(mail.text).toContain('(since 9-25-2026 1:00pm PDT)');
    expect(mail.text).not.toContain(NOW);
    expect(mail.html).not.toContain(NOW);
    for (const h of ['WHAT HAPPENED', 'WHAT OTIS REVIEWED', 'LIKELY CAUSE', 'NEXT STEPS FOR THE NEXT LEVEL', 'ESCALATION']) expect(mail.text).toContain(h);
    expect(mail.text).toContain('1. [L2]');
    expect(mail.html).toContain('Path &lt;lost&gt;');
    expect(mail.html).toContain('&quot;DS1&quot;');
    expect(mail.html).toContain('Analysis from Otis. Open Ops &gt; Ops Agent in ICC for full details.');
    expect(mail.text).toContain('Analysis from Otis. Open Ops > Ops Agent in ICC for full details.');
  });

  it('renders a multi-line summary as one bullet per issue, single line as a paragraph', () => {
    const inc = { id: 9, title: 'two problems', host: 'esx-01', platforms: JSON.stringify(['vcenter']), severity: 'critical', opened_at: NOW, notify_count: 0 };
    const analysis = { ...agent.fallbackTriage(evidence), source: 'ai', summary: 'esx-01 lost a SAN path.\nDatastore DS1 went inaccessible.' };
    const mail = agent.renderEmail(inc, [], analysis, { agentName: 'Otis' });
    expect(mail.text).toContain('- esx-01 lost a SAN path.');
    expect(mail.text).toContain('- Datastore DS1 went inaccessible.');
    expect(mail.html).toContain('<li style="margin:2px 0">esx-01 lost a SAN path.</li>');
    const single = agent.renderEmail(inc, [], { ...analysis, summary: 'One thing happened.' }, { agentName: 'Otis' });
    expect(single.text).toContain('WHAT HAPPENED\nOne thing happened.');
    expect(single.html).toContain('<p style="margin:0">One thing happened.</p>');
  });

  it('shapes an array summary into newline-joined lines and tolerates a plain string', () => {
    const noop = { restore: (s) => s };
    const fallback = { classification: 'one-off', summary: 'fallback' };
    const shaped = agent.shapeAnalysis({ classification: 'incident', summary: [' line one ', 'line two', 42, ''] }, noop, fallback);
    expect(shaped.summary).toBe('line one\nline two');
    expect(agent.shapeAnalysis({ summary: 'just a paragraph' }, noop, fallback).summary).toBe('just a paragraph');
    expect(agent.shapeAnalysis({ summary: [] }, noop, fallback).summary).toBe('fallback');
  });

  it('collects recent failed Cohesity runs, scoped to the alerting cluster when it matches', () => {
    db.exec("DELETE FROM protection_runs; DELETE FROM clusters;");
    const addCluster = db.prepare("INSERT INTO clusters (name, connection_type, auth_type, encrypted_credentials) VALUES (?, 'helios', 'apikey', 'x')");
    const a = addCluster.run('cohx-cl01').lastInsertRowid;
    const b = addCluster.run('cohx-cl02').lastInsertRowid;
    const run = db.prepare('INSERT INTO protection_runs (cluster_id, job_id, job_name, status, start_time, end_time, error_message) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const recent = new Date(Date.now() - 3600000).toISOString();
    const old = new Date(Date.now() - 3 * 86400000).toISOString();
    run.run(a, 1, 'VM-Nightly', 'kFailed', recent, recent, 'snapshot timed out');
    run.run(a, 2, 'SQL-Hourly', 'kSuccess', recent, recent, null);
    run.run(a, 3, 'Old-Fail', 'kFailed', old, old, 'ancient history');
    run.run(b, 4, 'Other-Cluster-Fail', 'kFailed', recent, recent, 'other cluster');
    const scoped = agent.collectFailedBackupJobs(['cohesity'], [{ platform: 'cohesity', host: 'COHX-CL01' }]);
    expect(scoped.map((j) => j.job)).toEqual(['VM-Nightly']);
    expect(scoped[0].error).toBe('snapshot timed out');
    // No matching cluster name: fall back to every cluster's recent failures.
    const unscoped = agent.collectFailedBackupJobs(['cohesity'], [{ platform: 'cohesity', host: 'something-else' }]);
    expect(unscoped.map((j) => j.job).sort()).toEqual(['Other-Cluster-Fail', 'VM-Nightly']);
    // Non-backup platforms contribute nothing.
    expect(agent.collectFailedBackupJobs(['vcenter'], [])).toEqual([]);
    db.exec('DELETE FROM protection_runs; DELETE FROM clusters;');
  });

  it('renders a failed backup jobs section only when jobs are present', () => {
    const inc = { id: 11, title: 'backup trouble', host: 'cohx-cl01', platforms: JSON.stringify(['cohesity']), severity: 'critical', opened_at: NOW, notify_count: 0 };
    const failedJobs = [{ platform: 'cohesity', source: 'cohx-cl01', job: 'VM-Nightly', status: 'kFailed', started: NOW, finished: NOW, error: 'kTimeout: snapshot timed out' }];
    const mail = agent.renderEmail(inc, [], agent.fallbackTriage(evidence), { agentName: 'Otis', failedJobs });
    expect(mail.text).toContain('FAILED BACKUP JOBS (LAST 24H, 1 total)');
    expect(mail.text).toContain('- Cohesity | cohx-cl01 | VM-Nightly | kFailed');
    expect(mail.text).toContain('kTimeout: snapshot timed out');
    expect(mail.html).toContain('Failed backup jobs (last 24h, 1 total)');
    expect(mail.html).toContain('kTimeout: snapshot timed out');
    const without = agent.renderEmail(inc, [], agent.fallbackTriage(evidence), { agentName: 'Otis' });
    expect(without.text).not.toContain('FAILED BACKUP JOBS');
    expect(without.html).not.toContain('Failed backup jobs');
  });

  it('lists only the newest 5 alerts per group and counts the rest', () => {
    const inc = { id: 8, title: 'big one', host: 'esx-01', platforms: JSON.stringify(['vcenter']), severity: 'critical', opened_at: NOW, notify_count: 0 };
    const at = (i) => `2026-09-25T${String(10 + i).padStart(2, '0')}:00:00.000Z`;
    const many = [
      ...Array.from({ length: 8 }, (_, i) => ({ platform: 'vcenter', severity: 'critical', host: 'esx-01', message: `open alert ${i}`, first_seen: at(i) })),
      ...Array.from({ length: 7 }, (_, i) => ({ platform: 'vcenter', severity: 'warning', host: 'esx-01', message: `cleared alert ${i}`, first_seen: at(i), cleared_at: NOW })),
    ];
    const mail = agent.renderEmail(inc, many, agent.fallbackTriage(evidence), { agentName: 'Otis' });
    expect(mail.text).toContain('ALERTS IN THIS INCIDENT (8 open, 7 cleared, newest shown)');
    expect(mail.text).toContain('open alert 7');       // newest survives the cap
    expect(mail.text).not.toContain('open alert 2');   // oldest does not
    expect(mail.text).toContain('... and 3 more open alerts; the full list is on the Ops Agent page.');
    expect(mail.text).toContain('... and 2 more cleared.');
    expect(mail.html).toContain('and 3 more open alerts');
    expect(mail.html).not.toContain('cleared alert 1');
  });
});

describe('re-triage cooldown (the 2026-09-28 flap-storm defect)', () => {
  const later = (min) => new Date(Date.parse(NOW) + min * 60000).toISOString();

  function notifiedIncident() {
    agent.groupTick(NOW, settings, { items: [item('zerto', 'z:VRA0004:aaa', { host: 'zmsite-a' })], failed: [] });
    const id = incidents()[0].id;
    db.prepare("UPDATE ops_incidents SET state = 'notified', triaged_at = ?, notified_at = ? WHERE id = ?").run(NOW, NOW, id);
    return id;
  }

  it('a new alert inside the renotify window attaches without re-opening triage', () => {
    const id = notifiedIncident();
    agent.groupTick(later(2), settings, { items: [
      item('zerto', 'z:VRA0004:aaa', { host: 'zmsite-a' }),
      item('zerto', 'z:VRA0004:bbb', { host: 'zmsite-a', firstSeen: later(2) }),
    ], failed: [] });
    const inc = incidents()[0];
    expect(inc.id).toBe(id);
    expect(inc.state).toBe('notified');          // no bounce back to collecting
    expect(alertsOf(id)).toHaveLength(2);        // but the alert did attach
  });

  it('a new alert after the window re-opens the incident for triage', () => {
    const id = notifiedIncident();
    agent.groupTick(later(120), settings, { items: [
      item('zerto', 'z:VRA0004:bbb', { host: 'zmsite-a', firstSeen: later(120) }),
    ], failed: [] });
    expect(incidents()[0].id).toBe(id);
    expect(incidents()[0].state).toBe('collecting');
  });

  it('a re-firing alert with the same key re-arms its cleared row', () => {
    const holding = { ...settings, autoResolveMinutes: 30 }; // keep it open while quiet
    const id = notifiedIncident();
    // The alert goes quiet: its row is cleared, the incident holds in 'clearing'.
    agent.groupTick(later(1), holding, { items: [], failed: [] });
    expect(alertsOf(id)[0].cleared_at).not.toBeNull();
    expect(incidents()[0].state).toBe('clearing');
    // It fires again with the SAME key (content-stable): the row re-arms
    // instead of the firing reading as a brand-new alert forever.
    agent.groupTick(later(3), holding, { items: [item('zerto', 'z:VRA0004:aaa', { host: 'zmsite-a' })], failed: [] });
    const rows = alertsOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].cleared_at).toBeNull();
    expect(incidents()[0].state).toBe('notified'); // still inside the cooldown, no re-triage
  });

  it('a clearing incident whose alert returns inside the cooldown stops the quiet-close clock', () => {
    const id = notifiedIncident();
    db.prepare("UPDATE ops_incidents SET state = 'clearing', cleared_since = ? WHERE id = ?").run(NOW, id);
    db.prepare('UPDATE ops_incident_alerts SET cleared_at = ? WHERE incident_id = ?').run(NOW, id);
    agent.groupTick(later(2), settings, { items: [item('zerto', 'z:VRA0004:aaa', { host: 'zmsite-a' })], failed: [] });
    const inc = incidents()[0];
    expect(inc.state).toBe('notified');
    expect(inc.cleared_since).toBeNull();
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
    // Since the re-triage cooldown (2026-09-28) a re-fire inside the renotify
    // window returns to the post-triage state instead of collecting again;
    // what matters is that it does NOT close and the quiet clock stops.
    expect(row.state).toBe('triaged');
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

describe('a tick that never finishes', () => {
  it('records the start so the API process can see one in flight, and clears it at the end', async () => {
    const { getSetting } = require('../services/settings');
    await agent.runOnce({ force: true });
    expect(getSetting('ops_agent_tick_started')).toBe('');            // cleared when it ended
    const runs = db.prepare('SELECT * FROM ops_agent_runs').all();
    expect(runs).toHaveLength(1);                                      // and the run row was written
    expect(agent.status().tickStartedAt).toBeNull();
  });

  it('reports the in-flight tick through status()', () => {
    const { setSetting } = require('../services/settings');
    const started = new Date(Date.now() - 12 * 60000).toISOString();
    setSetting('ops_agent_tick_started', started);
    expect(agent.status().tickStartedAt).toBe(started);
  });
});

describe('email when the model did not answer', () => {
  it('says why there is no AI narrative instead of only that there is none', () => {
    const inc = { id: 7, platforms: '["dell"]', severity: 'critical', host: 'r740-07', title: 'Host down',
      opened_at: NOW, triage_error: 'LLM request failed (HTTP 400). response_format is not supported.' };
    const analysis = { source: 'fallback', classification: 'incident', confidence: 'low', summary: 's', impact: 'i',
      correlation: 'c', likely_cause: 'l', reviewed: [], next_steps: [], escalate: 'e' };
    const mail = agent.renderEmail(inc, [], analysis, { agentName: 'ICC Operations Agent' });
    expect(mail.text).toContain('No AI narrative: LLM request failed (HTTP 400)');
    expect(mail.html).toContain('No AI narrative: LLM request failed (HTTP 400)');
  });

  it('says nothing extra when the model did answer', () => {
    const inc = { id: 8, platforms: '["dell"]', severity: 'warning', title: 'x', opened_at: NOW, triage_error: null };
    const analysis = { source: 'ai', classification: 'one-off', confidence: 'high', summary: 's', reviewed: [], next_steps: [] };
    expect(agent.renderEmail(inc, [], analysis, {}).text).not.toContain('No AI narrative');
  });
});

describe('the agent speaks in its own name', () => {
  it('labels the reviewed and did sections with the agent name', () => {
    const inc = { id: 9, platforms: '["cohesity"]', severity: 'warning', host: 'node-2', title: 'Disk',
      opened_at: NOW, triage_error: null };
    const analysis = { source: 'ai', classification: 'incident', confidence: 'high', summary: 's', impact: 'i',
      correlation: 'c', likely_cause: 'l', reviewed: ['checked the cluster'], next_steps: [], escalate: 'e' };
    const mail = agent.renderEmail(inc, [], analysis, { agentName: 'Tank',
      healActions: [{ at: NOW, action: 'repoll', target: 'cl-1', result: 'poll triggered' }] });
    expect(mail.text).toContain('WHAT TANK REVIEWED');
    expect(mail.text).toContain('WHAT TANK DID');
    expect(mail.html).toContain('What Tank reviewed');
    expect(mail.html).toContain('What Tank did');
    expect(mail.text).not.toContain('WHAT ICC REVIEWED');
  });
});

describe('an unparsable model answer', () => {
  it('describes a cut-off object differently from prose, so the cause is readable', () => {
    const cut = agent.describeUnparsed('{"classification":"incident","summary":"the host stopped repo');
    expect(cut).toContain('started as JSON and was cut off');
    const prose = agent.describeUnparsed('Sure! Here is my analysis of the incident.');
    expect(prose).toContain('was not JSON at all');
  });

  it('still recovers JSON from a fenced or chatty answer without a retry', () => {
    expect(agent.parseModelJson('```json\n{"classification":"noise"}\n```').classification).toBe('noise');
    expect(agent.parseModelJson('Here you go: {"classification":"one-off"} hope that helps').classification).toBe('one-off');
  });
});

describe('repeating conditions', () => {
  const key = 'host:esx-09';
  const open = (openedAt, resolvedAt, resolution) => db.prepare(`
    INSERT INTO ops_incidents (incident_key, title, host, platforms, severity, state, opened_at, hold_until, last_event_at,
      event_count, resolved_at, resolved_by, resolution, classification)
    VALUES (?, 'Path lost', 'esx-09', '["brocade"]', 'critical', ?, ?, ?, ?, 2, ?, ?, ?, 'incident')
  `).run(key, resolvedAt ? 'resolved' : 'collecting', openedAt, openedAt, openedAt, resolvedAt, resolvedAt ? 'agent' : null, resolution, ).lastInsertRowid;
  const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();

  it('counts prior incidents on the same key and calls it a pattern at the threshold', () => {
    open(ago(30), ago(29), 'Every alert cleared; closed after a quiet window.');
    open(ago(18), ago(17.6), 'Every alert cleared; closed after a quiet window.');
    const id = open(ago(1), null, null);
    const row = db.prepare('SELECT * FROM ops_incidents WHERE id = ?').get(id);
    const rec = agent.recurrenceFor(row, { patternDays: 14, patternMin: 3 });
    expect(rec.count).toBe(3);
    expect(rec.isPattern).toBe(true);
    expect(rec.occurrences).toHaveLength(2);
    expect(rec.occurrences[0].closedBy).toBe('agent');
    expect(rec.occurrences[0].resolution).toContain('quiet window');
    expect(rec.typicalGapMinutes).toBeGreaterThan(600);     // roughly twelve to seventeen hours apart
  });

  it('stays quiet below the threshold, and the line says what a person should look at', () => {
    open(ago(5), ago(4), 'cleared');
    const id = open(ago(1), null, null);
    const row = db.prepare('SELECT * FROM ops_incidents WHERE id = ?').get(id);
    expect(agent.recurrenceFor(row, { patternDays: 14, patternMin: 3 }).isPattern).toBe(false);
    expect(agent.recurrenceLine(agent.recurrenceFor(row, { patternDays: 14, patternMin: 2 })))
      .toContain('The repetition is the fault worth investigating');
  });

  it('puts the history and a repeat marker in the email', () => {
    const inc = { id: 3, platforms: '["brocade"]', severity: 'critical', host: 'esx-09', title: 'Path lost',
      opened_at: NOW, triage_error: null };
    const analysis = { source: 'ai', classification: 'recurring', confidence: 'high', summary: 's', reviewed: [], next_steps: [] };
    const recurrence = { isPattern: true, count: 4, windowDays: 14, threshold: 3, typicalGapMinutes: 240, closedByAgent: 3,
      occurrences: [{ openedAt: '2026-09-25T02:00:00.000Z', minutesOpen: 12, closedBy: 'agent', resolution: 'Cleared on its own.' }] };
    const mail = agent.renderEmail(inc, [], analysis, { agentName: 'Tank', recurrence });
    expect(mail.subject).toContain('[repeat 4]');
    expect(mail.text).toContain('THIS IS A REPEAT (4 times in 14 days)');
    expect(mail.text).toContain('about every 4.0 hours');
    expect(mail.text).toContain('closed by agent. Cleared on its own.');
    expect(mail.html).toContain('This is a repeat (4 times in 14 days)');
  });

  it(`leaves an ordinary incident's email untouched`, () => {
    const inc = { id: 4, platforms: '["dell"]', severity: 'warning', title: 'x', opened_at: NOW, triage_error: null };
    const analysis = { source: 'ai', classification: 'one-off', confidence: 'high', summary: 's', reviewed: [], next_steps: [] };
    const mail = agent.renderEmail(inc, [], analysis, { recurrence: { isPattern: false, count: 1 } });
    expect(mail.subject).not.toContain('repeat');
    expect(mail.text).not.toContain('THIS IS A REPEAT');
  });
});

describe('a pattern overrides the triage verdict', () => {
  it('classes the incident recurring and demands a human, whatever the digest said', async () => {
    const key = 'host:db-11';
    const ins = (openedAt, resolvedAt) => db.prepare(`
      INSERT INTO ops_incidents (incident_key, title, host, platforms, severity, state, opened_at, hold_until, last_event_at,
        event_count, resolved_at, resolved_by, resolution, classification)
      VALUES (?, 'Backup missed', 'db-11', '["cohesity"]', 'warning', ?, ?, ?, ?, 1, ?, ?, ?, 'one-off')
    `).run(key, resolvedAt ? 'resolved' : 'collecting', openedAt, openedAt, openedAt, resolvedAt,
      resolvedAt ? 'agent' : null, resolvedAt ? 'Cleared on its own after 20 minutes.' : null).lastInsertRowid;
    const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();
    ins(ago(50), ago(49));
    ins(ago(26), ago(25));
    setSetting('ops_agent_pattern_min', '3');
    setSetting('ops_agent_pattern_days', '14');
    const id = ins(ago(1), null);

    await agent.retriage(id);

    const row = db.prepare('SELECT * FROM ops_incidents WHERE id = ?').get(id);
    expect(row.classification).toBe('recurring');
    const analysis = JSON.parse(row.analysis_json);
    expect(analysis.human_required).toBe(true);
    expect(analysis.human_reason).toContain('3 times in 14 days');
    const detail = agent.getIncident(id);
    expect(detail.isPattern).toBe(true);
    expect(detail.recurrence.occurrences).toHaveLength(2);
    expect(detail.recurrence.occurrences[0].resolution).toContain('Cleared on its own');
  });
});

describe('site grouping (LogicMonitor round 3)', () => {
  const siteOf = (it) => {
    const h = agent.hostKey(it.host);
    if (h.startsWith('phx-')) return { siteKey: 'phoenix', siteName: 'Phoenix' };
    if (h.startsWith('dal-')) return { siteKey: 'dallas', siteName: 'Dallas' };
    return null;
  };

  it('keys by site when a provider places the host, and falls back to the platform rule otherwise', () => {
    const wide = new Set();
    expect(agent.incidentKeyFor({ platform: 'vcenter', sourceKey: 'v1', host: 'phx-esx-01' }, wide, { mode: 'site', siteOf })).toBe('site:phoenix');
    expect(agent.incidentKeyFor({ platform: 'dell', sourceKey: 'd1', host: 'lone-host' }, wide, { mode: 'site', siteOf })).toBe('host:lone-host');
    expect(agent.incidentKeyFor({ platform: 'pure', sourceKey: 'p1', host: '' }, wide, { mode: 'site', siteOf })).toBe('platform:pure');
    expect(agent.incidentKeyFor({ platform: 'netapp', sourceKey: 'n1', host: 'phx-filer' }, new Set(['netapp']), { mode: 'site', siteOf: () => null })).toBe('platform:netapp:wide');
    // an item that already carries its siteKey needs no provider
    expect(agent.incidentKeyFor({ platform: 'logicmonitor', sourceKey: 'lm1', host: 'x', siteKey: 'denver' }, wide, { mode: 'site' })).toBe('site:denver');
    // a poll item names a source, not a place
    expect(agent.incidentKeyFor({ platform: 'vcenter', sourceKey: 'poll:3', host: 'phx-vc' }, wide, { mode: 'site', siteOf })).toBe('host:phx-vc');
    // the other modes ignore sites
    expect(agent.incidentKeyFor({ platform: 'vcenter', sourceKey: 'v1', host: 'phx-esx-01' }, wide, { mode: 'platform', siteOf })).toBe('host:phx-esx-01');
  });

  it('folds a site into one incident titled with live counts, and ranks it between host and platform-wide', () => {
    agent.groupTick(NOW, { ...settings, grouping: 'site' }, { items: [
      item('vcenter', 'v1', { host: 'phx-esx-01' }),
      item('brocade', 'b1', { host: 'phx-esx-02', severity: 'warning' }),
      item('dell', 'd1', { host: 'phx-esx-02' }),
      item('dell', 'd2', { host: 'dal-esx-01' }),
      item('dell', 'd3', { host: 'lone-host' }),
    ], failed: [], siteOf });
    const rows = incidents();
    const phx = rows.find((r) => r.incident_key === 'site:phoenix');
    expect(phx.event_count).toBe(3);
    expect(phx.host).toBeNull();
    expect(phx.title).toBe('Phoenix: 3 alerts across 2 devices');
    expect(rows.find((r) => r.incident_key === 'site:dallas').title).toBe('Dallas: 1 alert across 1 device');
    expect(rows.find((r) => r.incident_key === 'host:lone-host')).toBeTruthy();
    const shaped = agent.getIncident(phx.id);
    expect(shaped.kind).toBe('site');
    const hostOne = agent.getIncident(rows.find((r) => r.incident_key === 'host:lone-host').id);
    expect(hostOne.kind).toBe('host');
    expect(shaped.impactScore).toBeGreaterThan(hostOne.impactScore);
  });
});

describe('network evidence providers', () => {
  const registry = require('../core/registry');
  const realEvidence = registry.getIncidentEvidenceProviders;
  const realSites = registry.getSiteProviders;
  afterEach(() => { registry.getIncidentEvidenceProviders = realEvidence; registry.getSiteProviders = realSites; });

  const seedIncident = () => {
    const id = db.prepare(`
      INSERT INTO ops_incidents (incident_key, title, host, platforms, severity, state, opened_at, hold_until, last_event_at, event_count)
      VALUES ('host:phx-esx-01', 'phx-esx-01', 'phx-esx-01', '["vcenter"]', 'critical', 'collecting', ?, ?, ?, 1)
    `).run(NOW, NOW, NOW).lastInsertRowid;
    db.prepare(`INSERT INTO ops_incident_alerts (incident_id, platform, source_key, severity, host, message, first_seen, attached_at)
      VALUES (?, 'vcenter', 'v1', 'critical', 'phx-esx-01', 'host lost', ?, ?)`).run(id, NOW, NOW);
    return id;
  };

  it('merges provider blocks into evidence.network, blame first, capped, and survives a throwing provider', async () => {
    const seen = [];
    registry.getSiteProviders = () => [{ id: 'logicmonitor', run: () => ({ siteKey: 'phoenix', siteName: 'Phoenix' }) }];
    registry.getIncidentEvidenceProviders = () => [
      { id: 'boom', name: 'Boom', run: () => { throw new Error('provider exploded'); } },
      { id: 'logicmonitor', name: 'LogicMonitor', run: (ctx) => {
        seen.push(ctx);
        if (!ctx.names.length) return { title: 'Site Phoenix', lines: ['3 devices, 1 dead'] };
        return { title: 'Network path for phx-esx-01', lines: ['Blame: phx-dist-01 Te1/0/3 is down since 9-27-2026', ...Array.from({ length: 60 }, (_, i) => `hop ${i}`)] };
      } },
    ];
    const id = seedIncident();
    await agent.retriage(id);
    const detail = agent.getIncident(id);
    const net = detail.evidence.network;
    expect(net).toHaveLength(2);
    expect(net[0].title).toBe('Network path for phx-esx-01');
    expect(net[0].lines).toHaveLength(40);
    expect(net[0].lines[0]).toMatch(/^Blame:/);
    expect(net[1]).toEqual({ title: 'Site Phoenix', lines: ['3 devices, 1 dead'] });
    expect(seen.some((c) => c.names.includes('phx-esx-01') && c.siteKey === 'phoenix')).toBe(true);
    expect(seen.some((c) => !c.names.length && c.siteKey === 'phoenix')).toBe(true);
    // the rule-based digest names the network finding
    expect(detail.analysis.reviewed.some((r) => r.includes('Network, Network path for phx-esx-01'))).toBe(true);
  });

  it('adds nothing when no provider is registered', async () => {
    registry.getIncidentEvidenceProviders = () => [];
    const id = seedIncident();
    await agent.retriage(id);
    expect(agent.getIncident(id).evidence.network).toEqual([]);
  });

  it('renders a Network section in both the text and html email', () => {
    const inc = { id: 9, platforms: '["vcenter"]', severity: 'critical', title: 'x', opened_at: NOW, triage_error: null };
    const analysis = { source: 'ai', classification: 'incident', confidence: 'high', summary: 's', reviewed: [], next_steps: [] };
    const network = [{ title: 'Network path for phx-esx-01', lines: ['Blame: phx-dist-01 Te1/0/3 is down'] }];
    const mail = agent.renderEmail(inc, [], analysis, { network });
    expect(mail.text).toContain('NETWORK\nNetwork path for phx-esx-01\n- Blame: phx-dist-01 Te1/0/3 is down');
    expect(mail.html).toContain('>Network</h3>');
    expect(mail.html).toContain('Blame: phx-dist-01 Te1/0/3 is down');
    expect(agent.renderEmail(inc, [], analysis, {}).text).not.toContain('NETWORK');
  });
});

describe('webhook wake flag', () => {
  it('wake() writes the flag; wakeCheck() ticks once per new flag and not when the agent is off', () => {
    db.prepare("DELETE FROM app_settings WHERE key = 'ops_agent_wake_requested'").run();
    expect(agent.wakeCheck()).toBe(false);          // no flag
    const at = agent.wake();
    expect(typeof at).toBe('string');
    expect(db.prepare("SELECT value FROM app_settings WHERE key = 'ops_agent_wake_requested'").get().value).toBe(at);
    setSetting('ops_agent_enabled', '0');
    expect(agent.wakeCheck()).toBe(false);          // seen, but the agent is off
    agent.wake();
    setSetting('ops_agent_enabled', '1');
    expect(agent.wakeCheck()).toBe(true);           // a new flag
    expect(agent.wakeCheck()).toBe(false);          // same flag again
  });
});

describe('platform profiles: relations and evidence budget', () => {
  const registry = require('../core/registry');
  const added = [];
  const fake = (id) => {
    try {
      registry.registerPlugin({ id, name: id, apiVersion: registry.PLUGIN_API_VERSION, migrations: [], createRouter: () => (req, res, next) => next() });
      added.push(id);
    } catch { /* already registered by another suite */ }
  };
  afterEach(() => { while (added.length) registry.unregisterPlugin(added.pop()); });

  const seedIncident = (host, platforms = ['vcenter'], alertCount = 1) => {
    const id = db.prepare(`
      INSERT INTO ops_incidents (incident_key, title, host, platforms, severity, state, opened_at, hold_until, last_event_at, event_count)
      VALUES (?, ?, ?, ?, 'critical', 'collecting', ?, ?, ?, ?)
    `).run(`host:${host}`, host, host, JSON.stringify(platforms), NOW, NOW, NOW, alertCount).lastInsertRowid;
    for (let i = 0; i < alertCount; i++) {
      db.prepare(`INSERT INTO ops_incident_alerts (incident_id, platform, source_key, severity, host, message, first_seen, attached_at)
        VALUES (?, ?, ?, 'critical', ?, ?, ?, ?)`).run(id, platforms[0], `k${i}`, host, `alert ${i}`, new Date(Date.parse(NOW) + i * 1000).toISOString(), NOW);
    }
    return id;
  };

  const seedChain = () => {
    db.exec(`DELETE FROM vcenter_vms; DELETE FROM vcenter_hosts; DELETE FROM vcenter_vcenters; DELETE FROM cohesity_objects; DELETE FROM clusters;
             DELETE FROM zerto_vms; DELETE FROM dell_devices; DELETE FROM dell_ome_instances;`);
    db.prepare("INSERT INTO vcenter_vcenters (id, name, host, username, encrypted_credentials) VALUES (1, 'vc-a', 'vc-a.lab', 'u', 'x')").run();
    db.prepare("INSERT INTO vcenter_hosts (vcenter_id, host_id, name, cluster_name, service_tag) VALUES (1, 'h1', 'esx-07.lab.local', 'prod', 'TAG1')").run();
    db.prepare("INSERT INTO vcenter_vms (vcenter_id, vm_id, name, host_name, cluster_name, guest_os) VALUES (1, 'v1', 'web-01', 'esx-07.lab.local', 'prod', 'Ubuntu Linux (64-bit)')").run();
    const cl = db.prepare("INSERT INTO clusters (name, connection_type, vip, auth_type, encrypted_credentials) VALUES ('snx2', 'direct', '10.0.0.1', 'apikey', 'x')").run().lastInsertRowid;
    db.prepare("INSERT INTO cohesity_objects (cluster_id, object_id, name, is_protected, last_backup_ms, protection_groups) VALUES (?, 1, 'web-01', 1, ?, '[\"PG-Gold\"]')").run(cl, Date.now() - 5 * 3600000);
    db.prepare("INSERT INTO zerto_vms (vm_identifier, name, vpg_names, vpg_statuses) VALUES ('z1', 'web-01', 'VPG-Web', 'MeetingSLA')").run();
    const ome = db.prepare("INSERT INTO dell_ome_instances (name, host, username, encrypted_credentials) VALUES ('OME', 'ome.lab', 'u', 'x')").run().lastInsertRowid;
    db.prepare("INSERT INTO dell_devices (ome_id, device_id, name, service_tag, model, health) VALUES (?, 1, 'esx-07', 'TAG1', 'PowerEdge R740', 'Healthy')").run(ome);
  };

  it('writes the VM -> host -> Cohesity -> Zerto -> Dell chain into evidence.relations', async () => {
    ['vcenter', 'zerto', 'dell'].forEach(fake);
    seedChain();
    const id = seedIncident('web-01');
    await agent.retriage(id);
    const rel = agent.getIncident(id).evidence.relations;
    expect(rel).toEqual(expect.arrayContaining([
      'VM web-01 runs on host esx-07.lab.local in cluster prod (vc-a)',
      expect.stringMatching(/^web-01 is protected by Cohesity group PG-Gold on snx2, last good backup 5 hours ago$/),
      'web-01 is replicated by Zerto VPG VPG-Web (MeetingSLA)',
      'host esx-07.lab.local is Dell PowerEdge R740, service tag TAG1, OME status Healthy',
    ]));
    expect(rel.length).toBeLessThanOrEqual(8);
    for (const l of rel) expect(l.length).toBeLessThanOrEqual(200);
  });

  it('emits nothing for platforms that are not enabled, and nothing when no rows match', async () => {
    seedChain();
    const id = seedIncident('web-01'); // no platform registered at all, Cohesity setting on
    await agent.retriage(id);
    expect(agent.getIncident(id).evidence.relations).toEqual([]);
    ['vcenter'].forEach(fake);
    const id2 = seedIncident('unknown-box');
    await agent.retriage(id2);
    expect(agent.getIncident(id2).evidence.relations).toEqual([]);
  });

  it('trims each platform to its evidence budget and counts the rest as omitted', () => {
    const id = seedIncident('esx-01', ['vcenter'], 20);
    const inc = db.prepare('SELECT * FROM ops_incidents WHERE id = ?').get(id);
    const ev = agent.gatherIncidentEvidence(inc, alertsOf(id));
    expect(ev.alerts).toHaveLength(15);
    expect(ev.alertsTotal).toBe(20);
    expect(ev.alertsOmitted).toBe(5);
    // newest first inside the same severity
    expect(ev.alerts[0].message).toBe('alert 19');
  });

  it('puts How these systems connect in the text and html email only when there are relations', () => {
    const inc = { id: 9, platforms: '["vcenter"]', severity: 'critical', title: 'x', opened_at: NOW, triage_error: null };
    const analysis = agent.fallbackTriage({ incident: { platforms: ['vcenter'] }, alerts: [], hosts: [] });
    const relations = ['VM web-01 runs on host esx-07 in cluster prod (vc-a)'];
    const mail = agent.renderEmail(inc, [], analysis, { relations });
    expect(mail.text).toContain('HOW THESE SYSTEMS CONNECT\n- VM web-01 runs on host esx-07 in cluster prod (vc-a)');
    expect(mail.html).toContain('How these systems connect');
    const plain = agent.renderEmail(inc, [], analysis, {});
    expect(plain.text).not.toContain('HOW THESE SYSTEMS CONNECT');
    expect(plain.html).not.toContain('How these systems connect');
  });

  it('builds the triage system prompt from the incident platforms only', () => {
    const built = agent.systemPromptFor({ incident: { platforms: ['vcenter'] }, alerts: [{ platform: 'vcenter', cleared: false }] });
    expect(built.focusUsed).toEqual(['vcenter']);
    expect(built.system).toMatch(/Platform notes, vCenter:/);
    expect(built.system).not.toMatch(/Cohesity/);
  });
});

describe('LogicMonitor signals: check hostKey, collector groupKey, cross-platform evidence, timeline', () => {
  const registry = require('../core/registry');
  const hostIdentity = require('../services/hostIdentity');
  const realEvidence = registry.getIncidentEvidenceProviders;
  const realSites = registry.getSiteProviders;
  const added = [];
  afterEach(() => {
    registry.getIncidentEvidenceProviders = realEvidence;
    registry.getSiteProviders = realSites;
    while (added.length) registry.unregisterPlugin(added.pop());
  });
  const fake = (id) => {
    try {
      registry.registerPlugin({ id, name: id, apiVersion: registry.PLUGIN_API_VERSION, migrations: [], createRouter: () => (req, res, next) => next() });
      added.push(id);
    } catch { /* already registered by another suite */ }
  };

  const group = (platform, sourceKey, o = {}) => ({ ...item(platform, sourceKey, o), groupKey: o.groupKey, location: o.location });

  it('hostKey keeps the whole check name for a "check @ location" target', () => {
    expect(agent.hostKey('Web Portal @ Australia - Sydney')).toBe('web-portal');
    expect(agent.hostKey('DAL  core   reachability @ abq')).toBe('dal-core-reachability');
    expect(agent.hostKey('ESX-01.lab.local')).toBe('esx-01');
    expect(agent.hostKey('r740-07 (ABC1234)')).toBe('r740-07');
  });

  it('incidentKeyFor honours groupKey in platform and site modes only', () => {
    const it1 = { platform: 'logicmonitor', sourceKey: 'latency-degrading|1|chk', host: 'Web Portal @ Sydney', groupKey: 'lm-location:australia-sydney' };
    expect(agent.incidentKeyFor(it1, new Set(), { mode: 'platform' })).toBe('lm-location:australia-sydney');
    expect(agent.incidentKeyFor(it1, new Set(['logicmonitor']), { mode: 'platform' })).toBe('lm-location:australia-sydney');
    expect(agent.incidentKeyFor(it1, new Set(), { mode: 'site', siteOf: () => ({ siteKey: 'phoenix' }) })).toBe('lm-location:australia-sydney');
    expect(agent.incidentKeyFor(it1, new Set(), { mode: 'component' })).toBe('host:web-portal');
    expect(agent.incidentKeyFor(it1, new Set(), { mode: 'service', appOf: new Map() })).toBe('host:web-portal');
    expect(agent.incidentKeyFor({ ...it1, groupKey: undefined }, new Set(), { mode: 'platform' })).toBe('host:web-portal');
  });

  it('folds location and burst items into one incident each, with head titles and kinds', () => {
    agent.groupTick(NOW, { ...settings, grouping: 'platform' }, { items: [
      group('logicmonitor', 'latency-degrading|1|Web @ Sydney', { host: 'Web @ Australia - Sydney', groupKey: 'lm-location:australia-sydney', location: 'Australia - Sydney' }),
      group('logicmonitor', 'check-down|1|Api @ Sydney', { host: 'Api @ Australia - Sydney', groupKey: 'lm-location:australia-sydney', location: 'Australia - Sydney' }),
      group('logicmonitor', 'location-latency|1|Australia - Sydney', { host: 'Australia - Sydney', groupKey: 'lm-location:australia-sydney', location: 'Australia - Sydney', message: '3 of 8 checks probed from Australia - Sydney are elevated now (1 critical, median peak 1.3x): Web, Api' }),
      group('logicmonitor', 'link-burst|1|estate', { host: 'estate', groupKey: 'lm-burst:estate', message: '6 interfaces went down in the last 30 min on 3 devices (sites dallas): dal-sw-01 Gi1/0/1' }),
      group('logicmonitor', 'interface-flapping|1|dal-sw-01 Gi1/0/1', { host: 'dal-sw-01', groupKey: 'lm-burst:estate' }),
      group('vcenter', 'v1', { host: 'esx-01' }),
    ], failed: [] });
    const rows = incidents();
    const loc = rows.find((r) => r.incident_key === 'lm-location:australia-sydney');
    const burst = rows.find((r) => r.incident_key === 'lm-burst:estate');
    expect(rows).toHaveLength(3);
    expect(loc.event_count).toBe(3);
    expect(loc.host).toBeNull();
    expect(loc.title).toBe('Latency from Australia - Sydney: 3 checks elevated');
    expect(burst.event_count).toBe(2);
    expect(burst.title).toBe('6 interfaces went down in the last 30 min on 3 devices (sites dallas): dal-sw-01');   // first 80 characters
    expect(agent.getIncident(loc.id).kind).toBe('location');
    expect(agent.getIncident(burst.id).kind).toBe('network-burst');
    expect(alertsOf(loc.id).map((a) => a.source_key).sort()).toEqual(['check-down|1|Api @ Sydney', 'latency-degrading|1|Web @ Sydney', 'location-latency|1|Australia - Sydney']);
  });

  it('component mode keeps the folded items apart', () => {
    agent.groupTick(NOW, { ...settings, grouping: 'component' }, { items: [
      group('logicmonitor', 'latency-degrading|1|Web @ Sydney', { host: 'Web @ Sydney', groupKey: 'lm-location:australia-sydney' }),
      group('logicmonitor', 'latency-degrading|1|Api @ Sydney', { host: 'Api @ Sydney', groupKey: 'lm-location:australia-sydney' }),
    ], failed: [] });
    expect(incidents().map((r) => r.incident_key).sort()).toEqual(['host:api', 'host:web']);
  });

  it('keeps a site-only block beside a host block that has the same title', () => {
    registry.getSiteProviders = () => [{ id: 'logicmonitor', run: () => ({ siteKey: 'phoenix', siteName: 'Phoenix' }) }];
    registry.getIncidentEvidenceProviders = () => [{ id: 'logicmonitor', name: 'LogicMonitor network', run: (ctx) => (
      ctx.names.length ? { title: 'LogicMonitor network', lines: ['Device phx-esx-01'] } : { title: 'LogicMonitor network', lines: ['Site Phoenix: 3/4 devices normal'] }) }];
    const inc = { incident_key: 'host:phx-esx-01' };
    const blocks = agent.gatherNetworkEvidence(inc, ['phx-esx-01']);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.lines[0]).sort()).toEqual(['Device phx-esx-01', 'Site Phoenix: 3/4 devices normal']);
    // the same title for the same context is still a duplicate
    expect(agent.gatherNetworkEvidence(inc, ['phx-esx-01', 'phx-esx-01'])).toHaveLength(2);
  });

  const seedInc = (key, host, platform, firstSeen, state = 'collecting') => {
    const id = db.prepare(`INSERT INTO ops_incidents (incident_key, title, host, platforms, severity, state, opened_at, hold_until, last_event_at, event_count)
      VALUES (?, ?, ?, ?, 'critical', ?, ?, ?, ?, 1)`).run(key, host, host, JSON.stringify([platform]), state, firstSeen, firstSeen, firstSeen).lastInsertRowid;
    db.prepare(`INSERT INTO ops_incident_alerts (incident_id, platform, source_key, severity, host, message, first_seen, attached_at)
      VALUES (?, ?, ?, 'critical', ?, ?, ?, ?)`).run(id, platform, `k-${id}`, host, `${platform} alert on ${host}`, firstSeen, firstSeen);
    return id;
  };
  const minutesAfter = (min) => new Date(Date.parse(NOW) + min * 60000).toISOString();

  it('fills relatedOtherPlatformEvents from the agent alert rows, inside 24 h only, and adds a timeline', () => {
    const mine = seedInc('host:esx-01', 'esx-01', 'vcenter', NOW);
    seedInc('host:esx-01-d', 'esx-01 (TAG1)', 'dell', minutesAfter(30));
    seedInc('host:esx-01-b', 'esx-01.lab.local', 'brocade', minutesAfter(25 * 60));
    const inc = db.prepare('SELECT * FROM ops_incidents WHERE id = ?').get(mine);
    const ev = agent.gatherIncidentEvidence(inc, alertsOf(mine));
    const rel = ev.hosts[0].relatedOtherPlatformEvents;
    expect(rel.map((r) => r.platform)).toEqual(['dell']);
    expect(rel[0]).toMatchObject({ host: 'esx-01 (TAG1)', severity: 'critical', message: 'dell alert on esx-01 (TAG1)' });
    expect(rel[0].incidentId).not.toBe(mine);
    expect(Array.isArray(ev.timeline)).toBe(true);
    expect(ev.timeline.some((t) => t.platform === 'vcenter' && /^Alert \(critical\)/.test(t.text))).toBe(true);
  });

  it('relates a Dell alert to a vCenter alert through the identity index', () => {
    db.exec('DELETE FROM vcenter_hosts; DELETE FROM dell_devices; DELETE FROM dell_ome_instances;');
    hostIdentity.invalidateIdentityIndex(db);
    const ome = db.prepare("INSERT INTO dell_ome_instances (name, host, username, encrypted_credentials) VALUES ('OME', 'ome.lab', 'u', 'x')").run().lastInsertRowid;
    db.prepare("INSERT INTO vcenter_vcenters (id, name, host, username, encrypted_credentials) VALUES (1, 'vc-a', 'vc-a.lab', 'u', 'x') ON CONFLICT(id) DO NOTHING").run();
    db.prepare("INSERT INTO vcenter_hosts (vcenter_id, host_id, name, service_tag, serial) VALUES (1, 'h9', 'esx-99.lab.local', 'IDTAG99', 'IDTAG99')").run();
    db.prepare("INSERT INTO dell_devices (ome_id, device_id, name, service_tag, model) VALUES (?, 9, 'rack-dell-99', 'IDTAG99', 'R650')").run(ome);
    const mine = seedInc('host:esx-99', 'esx-99.lab.local', 'vcenter', NOW);
    seedInc('host:rack-dell-99', 'rack-dell-99', 'dell', minutesAfter(5));
    const inc = db.prepare('SELECT * FROM ops_incidents WHERE id = ?').get(mine);
    const ev = agent.gatherIncidentEvidence(inc, alertsOf(mine));
    expect(ev.hosts[0].relatedOtherPlatformEvents.map((r) => r.host)).toEqual(['rack-dell-99']);
    // and the identity_links relation names the other platform
    ['vcenter', 'dell'].forEach(fake);
    hostIdentity.invalidateIdentityIndex(db);
    const lines = require('../services/agentRelations').relationLines({ hosts: [{ host: 'esx-99.lab.local' }], alerts: [] }, [{ platform: 'vcenter', host: 'esx-99.lab.local', cleared_at: null }]);
    expect(lines.some((l) => /^esx-99\.lab\.local is also Dell /.test(l))).toBe(true);
    db.exec('DELETE FROM vcenter_hosts; DELETE FROM dell_devices; DELETE FROM dell_ome_instances;');
    hostIdentity.invalidateIdentityIndex(db);
  });

  it('renders a Timeline section in the text and html email only when there are rows', () => {
    const inc = { id: 9, platforms: '["vcenter"]', severity: 'critical', title: 'x', opened_at: NOW, triage_error: null };
    const analysis = agent.fallbackTriage({ incident: { platforms: ['vcenter'] }, alerts: [], hosts: [] });
    const timeline = [{ at: NOW, platform: 'vcenter', text: 'Alert (critical) esx-01: host lost' }];
    const mail = agent.renderEmail(inc, [], analysis, { timeline });
    expect(mail.text).toContain('TIMELINE (NEWEST FIRST)\n- ');
    expect(mail.text).toContain('| vCenter | Alert (critical) esx-01: host lost');
    expect(mail.html).toContain('Timeline (newest first)');
    const plain = agent.renderEmail(inc, [], analysis, {});
    expect(plain.text).not.toContain('TIMELINE');
    expect(plain.html).not.toContain('Timeline (newest first)');
  });
});
