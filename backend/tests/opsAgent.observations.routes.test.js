import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { setSetting, getSetting, getOpsAgentSettings } = require('../services/settings');
const engine = require('../services/agentObservations');
const agent = require('../services/opsAgent');
const { createApp } = require('../app');

const API_KEY = 'test-api-key';
const T0 = Date.parse('2026-10-22T12:00:00.000Z');
const at = (n) => new Date(T0 + n * 15 * 60000).toISOString();
const NOW = at(12);
const S = { enabled: true, sustainSamples: 3, clearSamples: 2, patternMin: 3, patternDays: 7, historyDays: 90, disabledIds: [] };

let app;
const get = (url) => request(app).get(url).set('x-api-key', API_KEY);
const put = (url, body) => request(app).put(url).set('x-api-key', API_KEY).send(body);

const sample = (key, label, n, v) => ({ subjectKey: key, label, host: label, sourceId: 1, sourceName: 'vc-a', value: v, capturedAt: at(n), context: { cpuCount: 4 } });
const feed = (id, list, th) => { const o = engine.getObserver(id); engine.ingest(o, list, NOW, S, th || o.thresholds(getSetting)); };

beforeAll(() => { app = createApp({ licenseGate: (req, res, next) => next() }); });
beforeEach(() => {
  db.exec('DELETE FROM ops_observations; DELETE FROM ops_incident_alerts; DELETE FROM ops_incidents;');
  for (const k of ['ops_obs_enabled', 'ops_obs_sustain_samples', 'ops_obs_clear_samples', 'ops_obs_pattern_min', 'ops_obs_pattern_days', 'ops_obs_history_days', 'ops_obs_disabled_ids']) setSetting(k, '');
});

describe('GET /api/ops-agent/observations', () => {
  it('lists active episodes worst first with the shape the page reads', async () => {
    feed('vcenter:vm-cpu', [sample('vcenter:1:vm:a', 'a', 0, 95)]);
    feed('vcenter:vm-cpu', [sample('vcenter:1:vm:b', 'b', 0, 120), sample('vcenter:1:vm:b', 'b', 1, 120), sample('vcenter:1:vm:b', 'b', 2, 120)]);
    const res = await get('/api/ops-agent/observations');
    expect(res.status).toBe(200);
    expect(res.body.map((e) => e.subject)).toEqual(['b', 'a']);
    expect(res.body[0]).toMatchObject({
      observerId: 'vcenter:vm-cpu', label: 'VM CPU', platform: 'vcenter', subject: 'b', host: 'b', sourceName: 'vc-a',
      kind: 'sustained', state: 'critical', outcome: null, unit: '%', value: 120, peak: 120, thresholdWarn: 90, thresholdCrit: 100,
      samples: 3, inPattern: false, patternCount: 0, incidentId: null,
    });
    expect(res.body[0].series).toEqual([{ t: at(0), v: 120 }, { t: at(1), v: 120 }, { t: at(2), v: 120 }]);
    expect(res.body[0].context).toMatchObject({ cpuCount: 4 });
    for (const k of ['id', 'openedAt', 'promotedAt', 'promoteReason', 'closedAt', 'lastSampleAt', 'minutes', 'elevatedSamples', 'peakAt']) expect(res.body[0]).toHaveProperty(k);
  });

  it('scope=closed lists finished episodes with their outcome, newest first; limit applies', async () => {
    const k = 'vcenter:1:vm:c';
    feed('vcenter:vm-cpu', [sample(k, 'c', 0, 95), sample(k, 'c', 1, 50), sample(k, 'c', 2, 50)]);
    feed('vcenter:vm-cpu', [sample(k, 'c', 5, 95), sample(k, 'c', 6, 50), sample(k, 'c', 7, 50)]);
    const closed = await get('/api/ops-agent/observations?scope=closed');
    expect(closed.body).toHaveLength(2);
    expect(closed.body[0]).toMatchObject({ state: 'closed', outcome: 'one-off' });
    expect(closed.body[0].closedAt > closed.body[1].closedAt).toBe(true);
    expect((await get('/api/ops-agent/observations?scope=closed&limit=1')).body).toHaveLength(1);
    expect((await get('/api/ops-agent/observations')).body).toEqual([]);
    expect((await get('/api/ops-agent/observations?scope=all')).body).toHaveLength(2);
  });

  it('flags a subject that is in pattern', async () => {
    const k = 'vcenter:1:vm:p';
    for (const b of [0, 4, 8]) feed('vcenter:vm-cpu', [sample(k, 'p', b, 95), sample(k, 'p', b + 1, 50), sample(k, 'p', b + 2, 50)]);
    const res = await get('/api/ops-agent/observations?scope=closed');
    expect(res.body.every((e) => e.inPattern && e.patternCount === 3)).toBe(true);
  });
});

describe('GET /api/ops-agent/observations/:id', () => {
  it('returns the full series and the 30 day history of the subject', async () => {
    const k = 'vcenter:1:vm:d';
    feed('vcenter:vm-cpu', [sample(k, 'd', 0, 95), sample(k, 'd', 1, 50), sample(k, 'd', 2, 50)]);
    feed('vcenter:vm-cpu', [sample(k, 'd', 6, 95), sample(k, 'd', 7, 96)]);
    const open = db.prepare("SELECT id FROM ops_observations WHERE state != 'closed'").get().id;
    const res = await get(`/api/ops-agent/observations/${open}`);
    expect(res.status).toBe(200);
    expect(res.body.series).toHaveLength(2);
    expect(res.body.history).toHaveLength(1);
    expect(res.body.history[0]).toMatchObject({ outcome: 'one-off', subject: 'd' });
    expect((await get('/api/ops-agent/observations/99999')).status).toBe(404);
  });
});

describe('GET /api/ops-agent/observers', () => {
  it('lists the four vCenter observers with thresholds and the enabled flag', async () => {
    setSetting('ops_obs_disabled_ids', JSON.stringify(['vcenter:host-cpu']));
    const res = await get('/api/ops-agent/observers');
    expect(res.status).toBe(200);
    const by = Object.fromEntries(res.body.map((o) => [o.id, o]));
    expect(Object.keys(by)).toEqual(expect.arrayContaining(['vcenter:vm-cpu', 'vcenter:vm-memory', 'vcenter:host-cpu', 'vcenter:host-memory']));
    expect(by['vcenter:vm-cpu']).toMatchObject({
      label: 'VM CPU', platform: 'vcenter', kind: 'sustained', unit: '%', issueType: 'vm-cpu-hot', enabled: true, source: 'builtin',
      thresholds: { warn: 90, crit: 100 },
    });
    expect(by['vcenter:vm-cpu'].description).toMatch(/vCPU/);
    expect(by['vcenter:host-cpu'].enabled).toBe(false);
    expect(by['vcenter:host-memory'].thresholds).toEqual({ warn: 85, crit: 95 });
  });
});

describe('status counts', () => {
  it('reports watching, observing and the observer block', async () => {
    feed('vcenter:vm-cpu', [sample('vcenter:1:vm:w', 'w', 0, 95)]);
    feed('vcenter:vm-cpu', [sample('vcenter:1:vm:x', 'x', 0, 95), sample('vcenter:1:vm:x', 'x', 1, 95), sample('vcenter:1:vm:x', 'x', 2, 95)]);
    // watching counts watching episodes; only the promoted one opens an incident
    agent.openObservationIncidents(NOW);
    expect(db.prepare('SELECT COUNT(*) c FROM ops_incidents').get().c).toBe(1);
    const res = await get('/api/ops-agent/status');
    expect(res.status).toBe(200);
    expect(res.body.counts).toMatchObject({ watching: 1, observing: 2 });
    expect(res.body.observations).toEqual({ enabled: true, observers: 4 });
    expect(res.body.settings.observations).toMatchObject({ enabled: true, sustainSamples: 3, clearSamples: 2, patternMin: 3, patternDays: 7, historyDays: 90, disabledIds: [] });
  });

  it('the incident detail alerts carry source_key and the observation kind', async () => {
    const k = 'vcenter:1:vm:z';
    feed('vcenter:vm-cpu', [sample(k, 'z', 0, 95), sample(k, 'z', 1, 95), sample(k, 'z', 2, 95)]);
    agent.groupTick(NOW, { ...getOpsAgentSettings(), holdMinutes: 10 }, { items: engine.collectItems(NOW, S), failed: [] });
    const id = db.prepare('SELECT id FROM ops_incidents').get().id;
    const res = await get(`/api/ops-agent/incidents/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.alerts[0]).toMatchObject({ source_key: `obs:vcenter:vm-cpu:${k}`, kind: 'observation', type: 'vm-cpu-hot' });
    expect(res.body.alerts[0].detail).toMatchObject({ value: 95, peak: 95, openedValue: 95, samples: 3, elevatedSamples: 3, warn: 90, crit: 100, unit: '%', state: 'degrading' });
  });

  it('scope=watching lists only open watching episodes with the series the watch list draws', async () => {
    feed('vcenter:vm-cpu', [sample('vcenter:1:vm:w', 'w', 0, 95), sample('vcenter:1:vm:w', 'w', 1, 50)]);
    feed('vcenter:vm-cpu', [sample('vcenter:1:vm:x', 'x', 0, 95), sample('vcenter:1:vm:x', 'x', 1, 95), sample('vcenter:1:vm:x', 'x', 2, 95)]);
    const res = await get('/api/ops-agent/observations?scope=watching');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ subject: 'w', state: 'watching', value: 50, peak: 95, samples: 2, elevatedSamples: 1, openedValue: 95, inPattern: false });
    expect(res.body[0].series).toEqual([{ t: at(0), v: 95 }, { t: at(1), v: 50 }]);
  });
});

describe('PUT /api/settings opsAgent.observations', () => {
  const save = (observations) => put('/api/settings', { opsAgent: { observations } });

  it('saves a valid block and GET /api/settings returns it', async () => {
    const res = await save({ enabled: false, sustainSamples: 5, clearSamples: 4, patternMin: 4, patternDays: 10, historyDays: 120, disabledIds: ['vcenter:vm-memory'] });
    expect(res.status).toBe(200);
    expect(getOpsAgentSettings().observations).toEqual({ enabled: false, sustainSamples: 5, clearSamples: 4, patternMin: 4, patternDays: 10, historyDays: 120, disabledIds: ['vcenter:vm-memory'] });
    const got = await get('/api/settings');
    expect(got.body.opsAgent.observations).toMatchObject({ enabled: false, sustainSamples: 5, disabledIds: ['vcenter:vm-memory'] });
  });

  it('refuses out-of-range numbers and names the field', async () => {
    for (const [field, value] of [['sustainSamples', 0], ['sustainSamples', 25], ['clearSamples', 13], ['patternMin', 1], ['patternMin', 11], ['patternDays', 31], ['historyDays', 6], ['historyDays', 366], ['historyDays', 'abc'], ['historyDays', 7.5]]) {
      const res = await save({ [field]: value });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe(field);
    }
    expect(getOpsAgentSettings().observations.sustainSamples).toBe(3);
  });

  it('refuses a disabledIds list with an unknown observer or a non-array and saves nothing', async () => {
    const bad = await save({ sustainSamples: 6, disabledIds: ['vcenter:vm-cpu', 'nope:nothing'] });
    expect(bad.status).toBe(400);
    expect(bad.body.field).toBe('disabledIds');
    expect((await save({ disabledIds: 'vcenter:vm-cpu' })).status).toBe(400);
    expect((await save({ disabledIds: [7] })).status).toBe(400);
    expect(getOpsAgentSettings().observations).toMatchObject({ sustainSamples: 3, disabledIds: [] });
  });

  it('refuses a non-object observations value', async () => {
    expect((await save('on')).status).toBe(400);
    expect((await save([])).status).toBe(400);
  });
});
