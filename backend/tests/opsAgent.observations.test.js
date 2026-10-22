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

  it('a watching episode opens nothing', () => {
    feed([sample(0, 95)]);
    const stats = agent.groupTick(NOW, settings, { items: items(), failed: [] });
    expect(stats.incidentsOpened).toBe(0);
    expect(incidents()).toHaveLength(0);
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
    expect(ev.observations.lines[0]).toMatch(/^VM CPU web-01: watching, 99% now, peak 99% at .*warn 90 crit 100; series 95 99$/);
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
    expect(f.reviewed.some((r) => r.startsWith('Observation, VM CPU web-01: critical'))).toBe(true);
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
    expect(mail.text).toMatch(/- VM CPU \| web-01 \| critical \| now 112% \| peak 112% \| elevated 30 min \| since /);
    expect(mail.html).toContain('What Otis observed');
    const plain = agent.renderEmail(inc, alerts, analysis, { agentName: 'Otis' });
    expect(plain.text).not.toContain('OBSERVED');
    expect(plain.html).not.toContain('observed');
  });
});

describe('status and pulse', () => {
  it('status counts watching and observing episodes and reports the observer count', () => {
    feed([sample(0, 95)]);
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
