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
