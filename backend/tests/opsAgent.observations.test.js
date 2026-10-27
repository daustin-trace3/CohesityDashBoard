import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const db = require('../db/database');
const { setSetting, getOpsAgentSettings } = require('../services/settings');
const agent = require('../services/opsAgent');
const engine = require('../services/agentObservations');

const T0 = Date.parse('2026-10-22T12:00:00.000Z');
const at = (n) => new Date(T0 + n * 15 * 60000).toISOString();
const NOW = at(10);
const OBS_SETTINGS = { enabled: true, sustainSamples: 3, clearSamples: 2, patternMin: 3, patternDays: 7, historyDays: 90, disabledIds: [] };
const settings = { ...getOpsAgentSettings(), minSeverity: 'warning', holdMinutes: 10, renotifyMinutes: 60, observations: OBS_SETTINGS };
const KEY = 'vcenter:1:vm:web-01';

const cpu = () => engine.getObserver('vcenter:vm-cpu');
const sample = (n, v) => ({ subjectKey: KEY, label: 'web-01', host: 'web-01', sourceId: 1, sourceName: 'vc-a', value: v, capturedAt: at(n), context: { cpuCount: 4, esxHost: 'esx-01' } });
let tick = 0;
const feed = (list) => engine.ingest(cpu(), list, new Date(Date.parse(NOW) + (tick += 1) * 1000).toISOString(), OBS_SETTINGS, { warn: 90, crit: 100 });
const items = () => engine.collectItems(NOW, OBS_SETTINGS);
const incidents = () => db.prepare('SELECT * FROM ops_incidents ORDER BY id').all();
const alertsOf = (id) => db.prepare('SELECT * FROM ops_incident_alerts WHERE incident_id = ? ORDER BY rowid').all(id);

beforeEach(() => {
  db.exec('DELETE FROM ops_observations; DELETE FROM ops_incident_alerts; DELETE FROM ops_incidents; DELETE FROM ops_agent_runs;');
  setSetting('ops_agent_enabled', '1');
});

describe('observations feeding the agent', () => {
  it('a promoted episode opens an incident whose alert carries the obs: key, and links the episode', () => {
    feed([sample(0, 104), sample(1, 108), sample(2, 112)]);
    const stats = agent.groupTick(NOW, settings, { items: items(), failed: [] });
    expect(stats.incidentsOpened).toBe(1);
    const [inc] = incidents();
    expect(inc.incident_key).toBe('host:web-01');
    const [a] = alertsOf(inc.id);
    expect(a.source_key).toBe(`obs:vcenter:vm-cpu:${KEY}`);
    expect(a.type).toBe('vm-cpu-hot');
    expect(a.severity).toBe('critical');
    expect(a.message).toContain('VM web-01 CPU at 112% of 4 vCPU');
    const ep = db.prepare('SELECT * FROM ops_observations').get();
    expect(ep.incident_id).toBe(inc.id);
  });

  it('a watching episode opens no incident', () => {
    feed([sample(0, 95)]);
    const stats = agent.groupTick(NOW, settings, { items: items(), failed: [] });
    expect(stats.incidentsOpened).toBe(0);
    expect(incidents()).toEqual([]);
    expect(db.prepare('SELECT state, incident_id FROM ops_observations').get()).toMatchObject({ state: 'watching', incident_id: null });
  });

  it('a promoted episode stores peak and the first crossing on the alert row, and the title carries the peak', () => {
    feed([sample(0, 95), sample(1, 108), sample(2, 99), sample(3, 98)]);
    agent.groupTick(NOW, settings, { items: items(), failed: [] });
    const [inc] = incidents();
    expect(inc.title).toBe('web-01: VM CPU 98% (peak 108%)');
    const [a] = alertsOf(inc.id);
    const d = JSON.parse(a.detail_json);
    expect(d).toMatchObject({ value: 98, peak: 108, peakAt: at(1), openedAt: at(0), openedValue: 95, samples: 4, elevatedSamples: 4, warn: 90, crit: 100, unit: '%', state: 'degrading' });
    expect(a.message).toContain(`first over the line at 95% on ${at(0)}`);
    const shaped = agent.getIncident(inc.id);
    expect(shaped.alerts[0].detail).toMatchObject({ peak: 108, openedValue: 95 });
  });

  it('the stored detail and title refresh on the next tick while the incident is untriaged', () => {
    feed([sample(0, 95), sample(1, 99), sample(2, 99)]);
    agent.groupTick(NOW, settings, { items: items(), failed: [] });
    const [inc] = incidents();
    expect(inc.title).toBe('web-01: VM CPU 99%');
    feed([sample(3, 97)]);
    agent.groupTick(NOW, settings, { items: items(), failed: [] });
    expect(db.prepare('SELECT title FROM ops_incidents WHERE id = ?').get(inc.id).title).toBe('web-01: VM CPU 97% (peak 99%)');
    expect(JSON.parse(alertsOf(inc.id)[0].detail_json)).toMatchObject({ value: 97, peak: 99, samples: 4 });
  });

  it('after triage the model title stands', () => {
    feed([sample(0, 95), sample(1, 99), sample(2, 99)]);
    agent.groupTick(NOW, settings, { items: items(), failed: [] });
    const [inc] = incidents();
    db.prepare("UPDATE ops_incidents SET triaged_at = ?, title = 'Model title', state = 'triaged' WHERE id = ?").run(NOW, inc.id);
    feed([sample(3, 97)]);
    agent.groupTick(NOW, settings, { items: items(), failed: [] });
    expect(db.prepare('SELECT title FROM ops_incidents WHERE id = ?').get(inc.id).title).toBe('Model title');
  });

  it('a legacy watching incident is retired on the next tick with the stated resolution', () => {
    feed([sample(0, 95)]);
    const id = db.prepare("INSERT INTO ops_incidents (incident_key, title, host, platforms, severity, state, opened_at, hold_until, last_event_at, event_count, baseline) VALUES ('host:web-01', 'web-01: VM CPU 95%', 'web-01', '[\"vcenter\"]', 'info', 'collecting', ?, ?, ?, 1, 0)").run(NOW, NOW, NOW).lastInsertRowid;
    db.prepare("INSERT INTO ops_incident_alerts (incident_id, platform, source_key, severity, host, message, type, first_seen, attached_at) VALUES (?, 'vcenter', ?, 'info', 'web-01', 'watching', 'vm-cpu-hot', ?, ?)").run(id, `obs:vcenter:vm-cpu:${KEY}`, NOW, NOW);
    agent.groupTick(at(11), settings, { items: items(), failed: [] });
    const row = db.prepare('SELECT * FROM ops_incidents WHERE id = ?').get(id);
    expect(row).toMatchObject({ state: 'resolved', resolved_by: 'agent', classification: 'one-off' });
    expect(row.resolution).toBe('Watching episodes no longer open incidents; this one was opened under the earlier rule and the episode continues in the watch list.');
    expect(db.prepare('SELECT state FROM ops_observations').get().state).toBe('watching');
    expect(row.notify_count || 0).toBe(0);
  });

  it('closing the episode clears the alert at the next tick', () => {
    feed([sample(0, 95), sample(1, 95), sample(2, 95)]);
    agent.groupTick(NOW, settings, { items: items(), failed: [] });
    const [inc] = incidents();
    expect(alertsOf(inc.id)[0].cleared_at).toBeNull();
    feed([sample(3, 40), sample(4, 40)]);
    expect(items()).toEqual([]);
    agent.groupTick(NOW, settings, { items: items(), failed: [] });
    expect(alertsOf(inc.id)[0].cleared_at).not.toBeNull();
  });

  it('an engine failure keeps the platform in failed so its alerts are not cleared', () => {
    feed([sample(0, 95), sample(1, 95), sample(2, 95)]);
    agent.groupTick(NOW, settings, { items: items(), failed: [] });
    const [inc] = incidents();
    agent.groupTick(NOW, settings, { items: [], failed: ['vcenter'] });
    expect(alertsOf(inc.id)[0].cleared_at).toBeNull();
  });

  it('collectItems on the agent includes the observation items and survives an engine throw', () => {
    feed([sample(0, 95), sample(1, 95), sample(2, 95)]);
    const got = agent.collectItems(NOW, settings);
    expect(got.items.some((i) => i.kind === 'observation' && i.host === 'web-01')).toBe(true);
  });
});

describe('observation evidence', () => {
  const alertDriven = () => {
    agent.groupTick(NOW, settings, { items: [
      { platform: 'vcenter', sourceKey: 'v-guest-1', severity: 'warning', host: 'web-01', type: 'guest-volume-full', message: 'Guest volume C: is 93% full', firstSeen: NOW, lastSeen: NOW },
    ], failed: [] });
    const [inc] = incidents();
    return { inc, alerts: alertsOf(inc.id) };
  };

  it('an alert-driven incident on the same VM learns the VM is under watch, with series and warn/crit', () => {
    feed([sample(0, 95), sample(1, 99)]);                    // still watching
    const { inc, alerts } = alertDriven();
    const ev = agent.gatherIncidentEvidence(inc, alerts, settings);
    expect(ev.observations.episodes).toHaveLength(1);
    const e = ev.observations.episodes[0];
    expect(e).toMatchObject({ observerId: 'vcenter:vm-cpu', label: 'VM CPU', subject: 'web-01', state: 'watching', unit: '%', attached: false, thresholdWarn: 90, thresholdCrit: 100 });
    expect(e.series.map((p) => p.v)).toEqual([95, 99]);
    expect(ev.observations.lines[0]).toBe(`VM CPU on web-01: watching, now 99%, peak 99% at ${at(1)}, first over 90% at 95% on ${at(0)}, 2 of 2 samples elevated; series 95 99`);
    expect(e).toMatchObject({ openedValue: 95, openedAt: at(0), peakAt: at(1), elevatedSamples: 2, samples: 2, warn: 90, crit: 100 });
    // placed right after the alerts block
    const keys = Object.keys(ev);
    expect(keys.indexOf('observations')).toBe(keys.indexOf('alertsOmitted') + 1);
  });

  it('an attached promoted episode is marked attached and the history line counts closed episodes', () => {
    feed([sample(0, 95), sample(1, 50), sample(2, 50)]);      // one earlier one-off
    feed([sample(10, 95), sample(11, 95), sample(12, 95)]);   // promoted now
    agent.groupTick(NOW, settings, { items: items(), failed: [] });
    const [inc] = incidents();
    const ev = agent.gatherIncidentEvidence(inc, alertsOf(inc.id), settings);
    const e = ev.observations.episodes[0];
    expect(e.attached).toBe(true);
    expect(e.state).toBe('degrading');
    expect(ev.observations.history).toHaveLength(1);
    expect(ev.observations.history[0]).toMatchObject({ subject: 'web-01', outcome: 'one-off' });
    expect(ev.observations.lines.some((l) => l.startsWith('web-01 history (30 d): 1 episodes, 1 one-off, 0 sustained, 0 escalated'))).toBe(true);
  });

  it('no episodes, no block', () => {
    const { inc, alerts } = alertDriven();
    expect(agent.gatherIncidentEvidence(inc, alerts, settings).observations).toBeUndefined();
  });

  it('the timeline carries opened and promoted events from the episode', () => {
    feed([sample(0, 95), sample(1, 95), sample(2, 95)]);
    agent.groupTick(NOW, settings, { items: items(), failed: [] });
    const [inc] = incidents();
    const ev = agent.gatherIncidentEvidence(inc, alertsOf(inc.id), settings);
    const texts = ev.timeline.filter((t) => t.source === 'observation').map((t) => t.text);
    expect(texts).toEqual(expect.arrayContaining(['Observation opened: VM CPU web-01 went over 90%', 'Promoted: elevated for 3 samples (30 min)']));
  });
});

describe('prompt, fallback digest and email', () => {
  const promotedEvidence = () => {
    feed([sample(0, 105), sample(1, 108), sample(2, 112)]);
    agent.groupTick(NOW, settings, { items: items(), failed: [] });
    const [inc] = incidents();
    return { inc, alerts: alertsOf(inc.id), ev: agent.gatherIncidentEvidence(inc, alertsOf(inc.id), settings) };
  };

  it('adds the Observations sentence to the system prompt only when there is observation evidence', () => {
    const { ev } = promotedEvidence();
    const withObs = agent.systemPromptFor(ev).system;
    expect(withObs).toContain('Observations are ICC');
    expect(withObs).toContain('a blip, a repeat, or a change');
    const plain = { ...ev };
    delete plain.observations;
    expect(agent.systemPromptFor(plain).system).not.toContain('Observations are ICC');
  });

  it('the fallback digest names the condition and asks Virtualization to check what drives it', () => {
    const { ev } = promotedEvidence();
    const f = agent.fallbackTriage(ev);
    expect(f.summary).toContain('VM CPU web-01 has been over the critical line for 30 min (peak 112%)');
    expect(f.next_steps.some((s) => s.owner === 'Virtualization' && s.action.startsWith('Check what is driving web-01 (top processes'))).toBe(true);
    expect(f.reviewed.some((r) => r.startsWith('Observation, VM CPU on web-01: critical, now 112%, peak 112%'))).toBe(true);
    expect(f.reviewed.some((r) => r.includes('first over 90% at 105% on') && r.includes('3 of 3 samples elevated, promoted: '))).toBe(true);
  });

  it('a pattern item adds the burst-time correlation step', () => {
    const burst = (b) => [sample(b, 95), sample(b + 1, 50), sample(b + 2, 50)];
    feed([...burst(0), ...burst(4), ...burst(8)]);
    agent.groupTick(NOW, settings, { items: items(), failed: [] });
    const [inc] = incidents();
    const alerts = alertsOf(inc.id);
    expect(alerts[0].source_key).toBe(`obs-pattern:vcenter:vm-cpu:${KEY}`);
    const ev = agent.gatherIncidentEvidence(inc, alerts, settings);
    expect(ev.observations.patterns).toHaveLength(1);
    const f = agent.fallbackTriage(ev);
    expect(f.next_steps.some((s) => s.action.startsWith('Correlate the burst times of web-01 with scheduled jobs'))).toBe(true);
  });

  it('the email has a "What <agent> observed" section only when there are episodes', () => {
    const { inc, alerts, ev } = promotedEvidence();
    const analysis = agent.fallbackTriage(ev);
    const mail = agent.renderEmail(inc, alerts, analysis, { agentName: 'Otis', observations: ev.observations });
    expect(mail.text).toContain('WHAT OTIS OBSERVED');
    expect(mail.text).toMatch(/- VM CPU on web-01: critical, now 112%, peak 112% at .*, first over 90% at 105% on .*, 3 of 3 samples elevated, promoted: /);
    expect(mail.html).toContain('What Otis observed');
    const plain = agent.renderEmail(inc, alerts, analysis, { agentName: 'Otis' });
    expect(plain.text).not.toContain('OBSERVED');
    expect(plain.html).not.toContain('observed');
  });
});

describe('status and pulse', () => {
  it('status counts watching episodes (not incidents) and observing episodes and reports the observer count', () => {
    feed([sample(0, 95)]);
    agent.groupTick(NOW, settings, { items: items(), failed: [] });
    expect(incidents()).toEqual([]);
    const s = agent.status();
    expect(s.counts.watching).toBe(1);
    expect(s.counts.observing).toBe(1);
    expect(s.observations.enabled).toBe(true);
    expect(s.observations.observers).toBeGreaterThanOrEqual(4);
  });

  it('the pulse token moves when an episode moves', () => {
    const before = agent.pulse().token;
    feed([sample(0, 95)]);
    const mid = agent.pulse().token;
    expect(mid).not.toBe(before);
    feed([sample(1, 96)]);
    expect(agent.pulse().token).not.toBe(mid);
  });
});

// ---------------------------------------------------------------------------
// Observations as incidents: a watching episode opens a quiet incident that
// promotes into a normal triaged one.

const T = (min) => new Date(Date.parse(NOW) + min * 60000).toISOString();
const dueIds = (nowIso) => db.prepare("SELECT id FROM ops_incidents WHERE state = 'collecting' AND hold_until <= ?").all(nowIso).map((r) => r.id);
const listed = (id) => agent.listIncidents({ state: 'all' }).find((i) => i.id === id);

describe('watching observations stay quiet; promotion opens the incident', () => {
  it('a watching episode opens nothing, stays out of the incident list and counts in the watch tile', () => {
    feed([sample(0, 94)]);
    const stats = agent.groupTick(NOW, settings, { items: items(), failed: [] });
    expect(stats.incidentsOpened).toBe(0);
    expect(incidents()).toEqual([]);
    expect(agent.listIncidents({ state: 'all' })).toEqual([]);
    const later = T(5);
    agent.groupTick(later, settings, { items: engine.collectItems(later, OBS_SETTINGS), failed: [] });
    expect(incidents()).toEqual([]);
    expect(agent.status().counts.watching).toBe(1);
  });

  it('promotion to degrading opens a warning incident that is due in the same tick', () => {
    feed([sample(0, 95)]);
    agent.groupTick(NOW, settings, { items: items(), failed: [] });
    expect(incidents()).toEqual([]);
    feed([sample(1, 95), sample(2, 95)]);
    const now2 = T(1);
    const stats = agent.groupTick(now2, settings, { items: engine.collectItems(now2, OBS_SETTINGS), failed: [] });
    expect(stats.incidentsOpened).toBe(1);
    const [inc] = incidents();
    expect(alertsOf(inc.id)[0].severity).toBe('warning');
    expect(alertsOf(inc.id)[0].message).toContain('for 30 min');
    expect(inc).toMatchObject({ severity: 'warning', state: 'collecting', title: 'web-01: VM CPU 95%' });
    expect(dueIds(now2)).toEqual([inc.id]);
    expect(agent.status().counts.watching).toBe(0);
  });

  it('degrading to critical after a triage reopens the incident, due now', () => {
    feed([sample(0, 95), sample(1, 95), sample(2, 95)]);
    agent.groupTick(NOW, settings, { items: items(), failed: [] });
    const [inc] = incidents();
    db.prepare("UPDATE ops_incidents SET state = 'triaged', triaged_at = ? WHERE id = ?").run(T(-300), inc.id);
    feed([sample(3, 105), sample(4, 105), sample(5, 105)]);
    const now2 = T(2);
    agent.groupTick(now2, settings, { items: engine.collectItems(now2, OBS_SETTINGS), failed: [] });
    const after = incidents()[0];
    expect(alertsOf(inc.id)[0].severity).toBe('critical');
    expect(after).toMatchObject({ severity: 'critical', state: 'collecting' });
    expect(Date.parse(after.hold_until)).toBeLessThanOrEqual(Date.parse(now2));
    expect(dueIds(now2)).toEqual([inc.id]);
  });

  it('inside the re-triage cooldown a rising severity raises the incident but does not reopen it', () => {
    feed([sample(0, 95), sample(1, 95), sample(2, 95)]);
    agent.groupTick(NOW, settings, { items: items(), failed: [] });
    const [inc] = incidents();
    db.prepare("UPDATE ops_incidents SET state = 'triaged', triaged_at = ? WHERE id = ?").run(T(-5), inc.id);
    feed([sample(3, 105), sample(4, 105), sample(5, 105)]);
    const now2 = T(2);
    agent.groupTick(now2, settings, { items: engine.collectItems(now2, OBS_SETTINGS), failed: [] });
    expect(incidents()[0]).toMatchObject({ severity: 'critical', state: 'triaged' });
  });

  it('a watching episode that closes as a one-off opens no incident and stays in history', () => {
    feed([sample(0, 95), sample(1, 96)]);
    agent.groupTick(NOW, settings, { items: items(), failed: [] });
    feed([sample(2, 40), sample(3, 40)]);
    expect(items()).toEqual([]);
    agent.groupTick(T(1), settings, { items: [], failed: [] });
    expect(incidents()).toEqual([]);
    expect(db.prepare('SELECT state, outcome, peak_value FROM ops_observations').get()).toMatchObject({ state: 'closed', outcome: 'one-off', peak_value: 96 });
    expect(engine.episodeHistory(KEY, 3650)).toHaveLength(1);
  });

  it('a promoted episode that clears before triage resolves its incident with an observation-aware reason', () => {
    feed([sample(0, 95), sample(1, 96), sample(2, 97)]);
    agent.groupTick(NOW, settings, { items: items(), failed: [] });
    const [inc] = incidents();
    feed([sample(3, 40), sample(4, 40)]);
    expect(items()).toEqual([]);
    agent.groupTick(T(1), settings, { items: [], failed: [] });
    const done = incidents()[0];
    expect(done).toMatchObject({ id: inc.id, state: 'resolved', resolved_by: 'agent' });
    expect(done.resolution).toContain('web-01');
    expect(done.resolution).toContain('VM CPU');
    expect(done.resolution).toContain('(peak 97%)');
    expect(done.notify_count || 0).toBe(0);
  });

  it('a promoted item stays keyed host:<vm> in a wide platform, and a burst of them never folds', () => {
    const promotedItem = (i) => ({
      platform: 'vcenter', sourceKey: `obs:vcenter:vm-cpu:k${i}`, severity: 'warning', kind: 'observation',
      host: `vm-${i}`, type: 'vm-cpu-hot', title: `vm-${i}: VM CPU 95%`, message: 'hot', firstSeen: NOW, lastSeen: NOW,
    });
    const burst = Array.from({ length: 12 }, (_, i) => promotedItem(i));
    const poll = { platform: 'vcenter', sourceKey: 'poll:1', severity: 'critical', host: 'vc-a', type: 'poll-failed', message: 'down', firstSeen: NOW, lastSeen: NOW };
    agent.groupTick(NOW, settings, { items: [...burst, poll], failed: [] });
    const keys = incidents().map((i) => i.incident_key);
    expect(keys.filter((k) => /^host:vm-\d+$/.test(k))).toHaveLength(12);
    expect(keys).toContain('platform:vcenter:wide');
    // twelve promoted observations alone make no platform-wide incident
    db.exec('DELETE FROM ops_incident_alerts; DELETE FROM ops_incidents;');
    agent.groupTick(NOW, settings, { items: burst, failed: [] });
    expect(incidents().some((i) => i.incident_key.endsWith(':wide'))).toBe(false);
    expect(incidents()).toHaveLength(12);
  });

  it('observation items bypass the minimum severity', () => {
    const strict = { ...settings, minSeverity: 'critical' };
    const other = (n, label) => ({ ...sample(n, 95), subjectKey: `vcenter:1:vm:${label}`, label, host: label });
    feed([sample(0, 95), sample(1, 95), sample(2, 95)]);                // degrading (warning)
    engine.ingest(cpu(), [other(0, 'db-01'), other(1, 'db-01'), other(2, 'db-01')], T(3), OBS_SETTINGS, { warn: 90, crit: 100 });   // degrading (warning)
    const stats = agent.groupTick(NOW, strict, { items: items(), failed: [] });
    expect(stats.incidentsOpened).toBe(2);
    expect(incidents().map((i) => i.incident_key).sort()).toEqual(['host:db-01', 'host:web-01']);
  });

  it('openObservationIncidents opens incidents for live episodes and leaves other incidents alone', () => {
    agent.groupTick(NOW, settings, { items: [
      { platform: 'vcenter', sourceKey: 'v-guest-9', severity: 'warning', host: 'file-01', type: 'guest-volume-full', message: 'Guest volume D: is 95% full', firstSeen: NOW, lastSeen: NOW },
    ], failed: [] });
    feed([sample(0, 95), sample(1, 95), sample(2, 95)]);
    const r = agent.openObservationIncidents(NOW);
    expect(r.incidentsOpened).toBe(1);
    const keys = incidents().map((i) => i.incident_key).sort();
    expect(keys).toEqual(['host:file-01', 'host:web-01']);
    const other = incidents().find((i) => i.incident_key === 'host:file-01');
    expect(alertsOf(other.id)[0].cleared_at).toBeNull();
    const mine = incidents().find((i) => i.incident_key === 'host:web-01');
    expect(listed(mine.id)).toMatchObject({ severity: 'warning', state: 'collecting' });
  });

  it('openObservationIncidents opens nothing for a watching episode', () => {
    feed([sample(0, 95)]);
    expect(agent.openObservationIncidents(NOW).incidentsOpened).toBe(0);
    expect(incidents()).toEqual([]);
  });
});
