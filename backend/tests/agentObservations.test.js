import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const db = require('../db/database');
const registry = require('../core/registry');
const engine = require('../services/agentObservations');

const T0 = Date.parse('2026-10-22T12:00:00.000Z');
const at = (n) => new Date(T0 + n * 15 * 60000).toISOString();   // n-th 15 minute poll
const NOW = at(40);
const S = { enabled: true, sustainSamples: 3, clearSamples: 2, patternMin: 3, patternDays: 7, historyDays: 90, disabledIds: [] };
const TH = { warn: 90, crit: 100 };

let fakeSamples = [];
const fake = {
  id: 'hot', platform: 'fakeplat', label: 'Fake load', unit: '%', kind: 'sustained', issueType: 'fake-hot',
  noun: 'Box', metric: 'load', description: 'test observer',
  thresholds: () => TH,
  sample: () => fakeSamples,
  capacity: (c) => (c.cores ? `${c.cores} cores` : null),
};
const OBS = 'fk:hot';

const sample = (n, v, extra = {}) => ({ subjectKey: 'fk:1:box:b1', label: 'b1', host: 'b1', sourceId: 1, sourceName: 'fk-src', value: v, capturedAt: at(n), context: { cores: 4 }, ...extra });
const ob = () => engine.getObserver(OBS);
const feed = (samples, th = TH, st = S) => engine.ingest(ob(), samples, NOW, st, th);
const rows = () => db.prepare('SELECT * FROM ops_observations ORDER BY id').all();

beforeEach(() => {
  db.exec('DELETE FROM ops_observations');
  fakeSamples = [];
  vi.spyOn(registry, 'getAgentObserverProviders').mockReturnValue([{ id: 'fk', name: 'Fake', observers: [fake] }]);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('observer registry', () => {
  it('lists built-ins and namespaces pack observers by pack id', () => {
    const ids = engine.listObservers().map((o) => o.id);
    expect(ids).toEqual(expect.arrayContaining(['vcenter:vm-cpu', 'vcenter:vm-memory', 'vcenter:host-cpu', 'vcenter:host-memory', OBS]));
    expect(engine.listObservers({ ...S, disabledIds: [OBS] }).find((o) => o.id === OBS).enabled).toBe(false);
    expect(engine.listObservers().find((o) => o.id === OBS).source).toBe('fk');
  });
  it('ignores a pack observer that lacks sample or thresholds', () => {
    registry.getAgentObserverProviders.mockReturnValue([{ id: 'bad', name: 'Bad', observers: [{ id: 'x', platform: 'p', issueType: 't' }] }]);
    expect(engine.listObservers().find((o) => o.id === 'bad:x')).toBeUndefined();
  });
});

describe('episode state machine', () => {
  it('does nothing for normal samples and opens a watching row on the first elevated one', () => {
    feed([sample(0, 50), sample(1, 60)]);
    expect(rows()).toHaveLength(0);
    feed([sample(2, 95)]);
    const [r] = rows();
    expect(r).toMatchObject({ state: 'watching', samples: 1, elevated_samples: 1, observer_id: OBS, subject_label: 'b1', issue_key: `obs:${OBS}:fk:1:box:b1`, promoted_at: null });
    expect(r.elevated_run_start).toBe(at(2));
  });

  it('promotes to degrading after sustainSamples elevated samples in a row, with a reason and issue key', () => {
    feed([sample(0, 95), sample(1, 96)]);
    expect(rows()[0].state).toBe('watching');
    feed([sample(2, 97)]);
    const r = rows()[0];
    expect(r.state).toBe('degrading');
    expect(r.promote_reason).toBe('elevated for 3 samples (30 min)');
    expect(r.promoted_at).toBe(at(2));
    expect(r.issue_key).toBe(`obs:${OBS}:fk:1:box:b1`);
  });

  it('promotes at once on two severe samples', () => {
    feed([sample(0, 105), sample(1, 110)]);
    const r = rows()[0];
    expect(r.state).toBe('degrading');
    expect(r.promote_reason).toBe('over the critical line on two samples');
  });

  it('goes critical after sustainSamples severe samples in a row', () => {
    feed([sample(0, 105), sample(1, 110), sample(2, 112)]);
    const r = rows()[0];
    expect(r.state).toBe('critical');
    expect(r.promote_reason).toBe('severe for 3 samples (30 min)');
    expect(r.peak_value).toBe(112);
  });

  it('a normal sample resets the elevated run', () => {
    feed([sample(0, 95), sample(1, 96), sample(2, 50), sample(3, 95), sample(4, 96)]);
    const r = rows()[0];
    expect(r.state).toBe('watching');
    expect(r.elevated_run_start).toBe(at(3));
    expect(r.consecutive_normal).toBe(0);
  });

  it('closes after clearSamples normal samples: one-off, sustained and escalated', () => {
    feed([sample(0, 95), sample(1, 50), sample(2, 50)]);
    expect(rows()[0]).toMatchObject({ state: 'closed', outcome: 'one-off', closed_at: at(2) });

    feed([sample(10, 95), sample(11, 95), sample(12, 95), sample(13, 40), sample(14, 40)]);
    expect(rows()[1]).toMatchObject({ state: 'closed', outcome: 'sustained' });

    feed([sample(20, 110), sample(21, 110), sample(22, 110), sample(23, 40), sample(24, 40)]);
    expect(rows()[2]).toMatchObject({ state: 'closed', outcome: 'escalated' });
  });

  it('a sustain of one promotes on the first elevated sample', () => {
    feed([sample(0, 95)], TH, { ...S, sustainSamples: 1 });
    expect(rows()[0].state).toBe('degrading');
  });

  it('counts a sample only once: repeated or older capturedAt is ignored', () => {
    feed([sample(0, 95)]);
    feed([sample(0, 95), sample(0, 99)]);
    feed([sample(0, 95)]);
    expect(rows()[0].samples).toBe(1);
    feed([sample(1, 95)]);
    expect(rows()[0].samples).toBe(2);
    expect(rows()).toHaveLength(1);
  });

  it('does not reopen from a sample at or before the last close', () => {
    feed([sample(0, 95), sample(1, 50), sample(2, 50)]);
    feed([sample(1, 99)]);
    expect(rows()).toHaveLength(1);
  });

  it('keeps the last 48 samples in the series', () => {
    const many = [];
    for (let i = 0; i < 60; i++) many.push(sample(i, 95));
    feed(many);
    const r = rows()[0];
    const series = JSON.parse(r.series_json);
    expect(series).toHaveLength(48);
    expect(series[47]).toEqual({ t: at(59), v: 95 });
    expect(r.samples).toBe(60);
  });

  it('stores the thresholds in force and merges context', () => {
    feed([sample(0, 95)], { warn: 80, crit: 99 });
    const r = rows()[0];
    expect([r.threshold_warn, r.threshold_crit, r.unit]).toEqual([80, 99, '%']);
    expect(JSON.parse(r.context_json)).toEqual({ cores: 4 });
  });

  it('evaluate closes an episode whose subject stopped being sampled for 6 hours as stale', () => {
    feed([sample(0, 95)]);
    const closed = engine.closeStale(new Date(T0 + 7 * 3600000).toISOString());
    expect(closed).toBe(1);
    expect(rows()[0]).toMatchObject({ state: 'closed', outcome: 'stale' });
    expect(engine.closeStale(new Date(T0 + 8 * 3600000).toISOString())).toBe(0);
  });
});

describe('evaluate', () => {
  it('samples enabled observers and skips disabled ones', () => {
    fakeSamples = [sample(0, 95)];
    const n = engine.evaluate(NOW, { ...S, disabledIds: [OBS] });
    expect(n.opened).toBe(0);
    expect(rows()).toHaveLength(0);
    const m = engine.evaluate(NOW, S);
    expect(m.opened).toBe(1);
    expect(rows()).toHaveLength(1);
  });

  it('does nothing when observations are switched off', () => {
    fakeSamples = [sample(0, 95)];
    engine.evaluate(NOW, { ...S, enabled: false });
    expect(rows()).toHaveLength(0);
    expect(engine.collectItems(NOW, { ...S, enabled: false })).toEqual([]);
  });

  it('survives an observer that throws', () => {
    fake.sample = () => { throw new Error('boom'); };
    try { expect(() => engine.evaluate(NOW, S)).not.toThrow(); } finally { fake.sample = () => fakeSamples; }
  });
});

describe('collectItems', () => {
  it('hands over a watching episode as an info item flagged watch, with a title and a watching message', () => {
    feed([sample(0, 95)]);
    const [it] = engine.collectItems(NOW, S);
    expect(it).toMatchObject({
      platform: 'fakeplat', sourceKey: `obs:${OBS}:fk:1:box:b1`, severity: 'info', watch: true, kind: 'observation',
      observationId: rows()[0].id, host: 'b1', type: 'fake-hot', firstSeen: at(0), lastSeen: NOW, title: 'b1: Fake load 95%',
    });
    expect(it.message).toBe('Box b1 load at 95% of 4 cores, watching (1 elevated of 1 samples, warn 90%, crit 100%)');
  });

  it('backfills a null issue_key on a watching row opened before the key was written at open', () => {
    feed([sample(0, 95)]);
    db.prepare('UPDATE ops_observations SET issue_key = NULL').run();
    const [it] = engine.collectItems(NOW, S);
    expect(it.sourceKey).toBe(`obs:${OBS}:fk:1:box:b1`);
    expect(rows()[0].issue_key).toBe(`obs:${OBS}:fk:1:box:b1`);
  });

  it('degrading item: warning with the exact message', () => {
    feed([sample(0, 95), sample(1, 99), sample(2, 99)]);
    const [it] = engine.collectItems(NOW, S);
    expect(it).toMatchObject({
      platform: 'fakeplat', sourceKey: `obs:${OBS}:fk:1:box:b1`, severity: 'warning', host: 'b1', type: 'fake-hot',
      firstSeen: at(2), lastSeen: NOW, kind: 'observation', observationId: rows()[0].id, watch: false, title: 'b1: Fake load 99%',
    });
    expect(it.message).toBe('Box b1 load at 99% of 4 cores for 30 min (peak 99%, warn 90%, crit 100%)');
  });

  it('critical item: critical with the over-the-line wording', () => {
    feed([sample(0, 104), sample(1, 112), sample(2, 118)]);
    const [it] = engine.collectItems(NOW, S);
    expect(it.severity).toBe('critical');
    expect(it.message).toBe('Box b1 load at 118% of 4 cores, over the critical line for 30 min (peak 118%, warn 90%, crit 100%)');
  });

  it('omits the "of ..." part when context lacks the capacity', () => {
    feed([sample(0, 95, { context: {} }), sample(1, 95, { context: {} }), sample(2, 95, { context: {} })]);
    expect(engine.collectItems(NOW, S)[0].message).toBe('Box b1 load at 95% for 30 min (peak 95%, warn 90%, crit 100%)');
  });

  it('uses the observer message hook when it has one', () => {
    fake.message = (ep, level) => `custom ${ep.subject_label} ${level}`;
    try {
      feed([sample(0, 95), sample(1, 95), sample(2, 95)]);
      expect(engine.collectItems(NOW, S)[0].message).toBe('custom b1 degrading');
    } finally { delete fake.message; }
  });

  it('drops the item when the episode closes', () => {
    feed([sample(0, 95), sample(1, 95), sample(2, 95), sample(3, 50), sample(4, 50)]);
    expect(engine.collectItems(NOW, S)).toEqual([]);
  });

  it('a disabled observer hands nothing over', () => {
    feed([sample(0, 95), sample(1, 95), sample(2, 95)]);
    expect(engine.collectItems(NOW, { ...S, disabledIds: [OBS] })).toEqual([]);
  });
});

describe('one-off patterns', () => {
  const burst = (base) => [sample(base, 95), sample(base + 1, 50), sample(base + 2, 50)];

  it('raises a pattern item at patternMin one-offs and clears it when the window no longer holds them', () => {
    feed([...burst(0), ...burst(4)]);
    expect(engine.collectItems(NOW, S)).toEqual([]);
    feed(burst(8));
    const items = engine.collectItems(NOW, S);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      platform: 'fakeplat', sourceKey: `obs-pattern:${OBS}:fk:1:box:b1`, severity: 'warning', host: 'b1',
      type: 'fake-hot-pattern', kind: 'observation-pattern', observationId: null, firstSeen: at(2),
    });
    expect(items[0].message).toBe('Box b1 load ran hot in 3 short bursts in the last 7 days (longest 0 min, peak 95%); each cleared on its own.');
    const later = new Date(T0 + 9 * 86400000).toISOString();
    expect(engine.collectItems(later, S)).toEqual([]);
  });

  it('respects the patternMin setting', () => {
    feed([...burst(0), ...burst(4)]);
    expect(engine.collectItems(NOW, { ...S, patternMin: 2 })).toHaveLength(1);
  });
});

describe('reads and prune', () => {
  it('lists active and closed episodes, opens one by id and prunes old closed rows', () => {
    feed([sample(0, 95), sample(1, 50), sample(2, 50), sample(10, 95)]);
    expect(engine.listEpisodes({ scope: 'active' })).toHaveLength(1);
    expect(engine.listEpisodes({ scope: 'closed' })).toHaveLength(1);
    expect(engine.listEpisodes({ scope: 'all' })).toHaveLength(2);
    const closed = engine.listEpisodes({ scope: 'closed' })[0];
    expect(engine.getEpisode(closed.id).outcome).toBe('one-off');
    expect(engine.getEpisode(99999)).toBeNull();
    expect(engine.describe(closed).label).toBe('Fake load');

    expect(engine.prune({ ...S, historyDays: 90 }).deleted).toBe(0);
    db.prepare("UPDATE ops_observations SET closed_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(closed.id);
    expect(engine.prune({ ...S, historyDays: 90 }).deleted).toBe(1);
    expect(engine.listEpisodes({ scope: 'all' })).toHaveLength(1);
  });

  it('openEpisodes finds attached and host-matched episodes, attached first', () => {
    feed([sample(0, 95), sample(1, 95), sample(2, 95)]);
    const hostKey = (h) => String(h).toLowerCase();
    const byHost = engine.openEpisodes({ hosts: ['b1'], issueKeys: [], hostKey });
    expect(byHost).toHaveLength(1);
    expect(byHost[0].attached).toBe(false);
    const byKey = engine.openEpisodes({ hosts: [], issueKeys: [`obs:${OBS}:fk:1:box:b1`], hostKey });
    expect(byKey[0].attached).toBe(true);
    expect(engine.openEpisodes({ hosts: ['other'], issueKeys: [], hostKey })).toEqual([]);
  });
});
