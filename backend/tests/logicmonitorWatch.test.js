/**
 * LogicMonitor round 9: latency watch. The episode state machine (open,
 * sustain promote, trend promote, severe promote, critical, close one-off,
 * close sustained, close escalated), the repeating pattern issue, the drift
 * issue, issue hysteresis and the frozen reference. Rows are seeded by hand
 * into the per-file test DB through the migration.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const { encrypt } = require('../services/encryption');
const { setSetting } = require('../services/settings');
const lmIssues = require('../services/logicmonitorIssues');
const lmChecks = require('../services/logicmonitorChecks');
const lmWatch = require('../services/logicmonitorWatch');

const TABLES = ['lm_latency_episodes', 'lm_check_reference', 'lm_check_baseline', 'lm_check_history', 'lm_check_locations', 'lm_checks',
  'lm_issue_history', 'lm_sites', 'lm_sources'];
const T0 = Math.floor(Date.UTC(2026, 9, 16, 12, 0, 0) / 1000);
const CHECK = 'w:101';
const CP = '1011';

beforeAll(() => { runMigrations(db, 'logicmonitor', lmMigrations); });

let sid;
let source;
let t;
beforeEach(() => {
  for (const tbl of TABLES) db.prepare(`DELETE FROM ${tbl}`).run();
  db.prepare("DELETE FROM app_settings WHERE key LIKE 'lm_%'").run();
  sid = db.prepare('INSERT INTO lm_sources (name, company, auth_mode, encrypted_credentials) VALUES (?, ?, ?, ?)')
    .run('Acme', 'acme', 'lmv1', encrypt(JSON.stringify({ accessId: 'a', accessKey: 'b' }))).lastInsertRowid;
  source = { id: sid, name: 'Acme' };
  db.prepare(`INSERT INTO lm_checks (source_id, check_id, kind, origin, name, target, status, polling_interval, is_internal, stop_monitoring, stale)
    VALUES (?, ?, 'ping', 'website', 'PHX core', '10.0.0.1', 'active', 5, 1, 0, 0)`).run(sid, CHECK);
  db.prepare(`INSERT INTO lm_check_locations (source_id, check_id, checkpoint_id, label, is_overall, last_status, stale, site_key)
    VALUES (?, ?, ?, 'den-col01', 0, 'up', 0, 'denver')`).run(sid, CHECK, CP);
  for (let h = 0; h < 24; h += 1) baseline(h, 30);
  t = lmIssues.getThresholds();
});

function baseline(hour, rtt, mad = 1) {
  db.prepare(`INSERT OR REPLACE INTO lm_check_baseline (source_id, check_id, checkpoint_id, hour_of_day, samples, rtt_median, rtt_mad, loss_median, loss_mad, computed_at)
    VALUES (?, ?, ?, ?, 100, ?, ?, 0, 0, ?)`).run(sid, CHECK, CP, hour, rtt, mad, new Date().toISOString());
}

let cursor;
const sampleAt = (i) => T0 + 300 * i;
function addSample(i, rtt, { loss = 0, status = 'up' } = {}) {
  db.prepare(`INSERT INTO lm_check_history (source_id, check_id, checkpoint_id, sample_epoch, status, rtt_avg_ms, loss_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(sid, CHECK, CP, sampleAt(i), status, rtt, loss);
}
/** Insert samples one at a time and run the engine after each, like the poller. */
function play(values, startIndex = 0) {
  const total = { opened: 0, promoted: 0, closed: 0 };
  const seen = [];
  values.forEach((v, k) => {
    const i = startIndex + k;
    if (v && typeof v === 'object') addSample(i, v.rtt, v); else addSample(i, v);
    const r = lmWatch.evaluateWatch(db, source, t, sampleAt(i));
    total.opened += r.opened; total.promoted += r.promoted; total.closed += r.closed;
    seen.push(episode() ? episode().state : null);
  });
  cursor = startIndex + values.length;
  return { total, seen };
}
const episodes = () => db.prepare('SELECT * FROM lm_latency_episodes ORDER BY id').all();
const episode = () => episodes().slice(-1)[0] || null;
const flat = (n, v) => Array.from({ length: n }, () => v);

describe('classifySample', () => {
  const base = { samples: 100, rtt_median: 30, rtt_mad: 1, loss_median: 0, loss_mad: 0 };
  const last = (rtt, loss = 0) => [{ rtt_avg_ms: rtt, loss_pct: loss }, { rtt_avg_ms: rtt, loss_pct: loss }, { rtt_avg_ms: rtt, loss_pct: loss }];

  it('returns normal, elevated and severe with the ratio over the baseline median', () => {
    const tt = { ...lmChecks.checkThresholds(), lm_watch_severe_ratio: 2 };
    expect(lmChecks.classifySample(last(31), base, tt).level).toBe('normal');
    const el = lmChecks.classifySample(last(55), base, tt);
    expect(el).toMatchObject({ level: 'elevated', kind: 'latency', latency: true, severity: 'warning' });
    expect(el.ratio).toBeCloseTo(55 / 30, 5);
    expect(lmChecks.classifySample(last(70), base, tt).level).toBe('severe');
  });

  it('flags loss, wins over latency, and stays quiet without enough samples or a baseline', () => {
    const tt = lmChecks.checkThresholds();
    const both = lmChecks.classifySample(last(70, 25), base, tt);
    expect(both).toMatchObject({ kind: 'loss', loss: true, latency: true, level: 'severe', severity: 'critical' });
    expect(lmChecks.classifySample(last(70).slice(0, 2), base, tt).level).toBe('normal');
    expect(lmChecks.classifySample(last(70), null, tt).level).toBe('normal');
  });

  it('keeps evaluateLocationRule behaviour', () => {
    const tt = lmChecks.checkThresholds();
    expect(lmChecks.evaluateLocationRule({ lastStatus: 'up', recent: last(50), baseline: base, t: tt })).toMatchObject({ anomaly: 'latency', severity: 'warning' });
    expect(lmChecks.evaluateLocationRule({ lastStatus: 'up', recent: last(120), baseline: base, t: tt })).toMatchObject({ anomaly: 'latency', severity: 'critical' });
    expect(lmChecks.evaluateLocationRule({ lastStatus: 'down', recent: [], baseline: base, t: tt }).anomaly).toBe('down');
  });
});

describe('threshold keys', () => {
  it('defines the ten round 9 keys with the contract defaults and ranges', () => {
    const d = lmIssues.THRESHOLD_DEFS;
    expect(d.lm_watch_sustain_minutes).toMatchObject({ def: 15, min: 5, max: 120 });
    expect(d.lm_watch_trend_windows).toMatchObject({ def: 3, min: 2, max: 10 });
    expect(d.lm_watch_severe_ratio).toMatchObject({ def: 2, min: 1.2, max: 10 });
    expect(d.lm_watch_clear_samples).toMatchObject({ def: 3, min: 1, max: 20 });
    expect(d.lm_watch_repeat_days).toMatchObject({ def: 7, min: 1, max: 30 });
    expect(d.lm_watch_repeat_min).toMatchObject({ def: 3, min: 2, max: 20 });
    expect(d.lm_watch_drift_pct).toMatchObject({ def: 25, min: 5, max: 200 });
    expect(d.lm_watch_drift_crit_pct).toMatchObject({ def: 50, min: 10, max: 400 });
    expect(d.lm_watch_reference_days).toMatchObject({ def: 28, min: 14, max: 90 });
    expect(d.lm_issue_clear_absences).toMatchObject({ def: 2, min: 1, max: 10 });
  });

  it('keeps one decimal on the severe ratio', () => {
    setSetting('lm_watch_severe_ratio', '2.54');
    expect(lmIssues.getThreshold('lm_watch_severe_ratio')).toBe(2.5);
    setSetting('lm_watch_severe_ratio', '99');
    expect(lmIssues.getThreshold('lm_watch_severe_ratio')).toBe(10);
  });
});

describe('episode state machine', () => {
  it('opens a watching episode on the first elevated window and closes it as a one-off', () => {
    const r = play([...flat(6, 30), 100, ...flat(8, 30)]);
    expect(r.total).toEqual({ opened: 1, promoted: 0, closed: 1 });
    const e = episode();
    expect(e).toMatchObject({ state: 'closed', outcome: 'one-off', kind: 'latency', subject_key: `check:${CHECK}:${CP}`, subject_label: 'PHX core @ den-col01', site_key: 'denver' });
    expect(e.promoted_at).toBeNull();
    expect(e.baseline_median).toBe(30);
    expect(e.elevated_samples).toBe(3);
    expect(e.peak_ratio).toBeGreaterThan(1.7);
    expect(e.opened_at).toBe(new Date(sampleAt(6) * 1000).toISOString());
    expect(r.seen[6]).toBe('watching');
  });

  it('does nothing for a normal series', () => {
    const r = play(flat(20, 31));
    expect(r.total).toEqual({ opened: 0, promoted: 0, closed: 0 });
    expect(episodes()).toHaveLength(0);
  });

  it('promotes on sustain minutes (15 min elevated) and closes as sustained', () => {
    const r = play([...flat(6, 30), ...flat(8, 55), ...flat(6, 30)]);
    const e = episode();
    expect(r.total.promoted).toBe(1);
    expect(r.total.closed).toBe(1);
    expect(e).toMatchObject({ state: 'closed', outcome: 'sustained' });
    expect(e.promote_reason).toMatch(/^elevated for 15 min/);
    expect(e.promoted_at).toBe(new Date(sampleAt(10) * 1000).toISOString());
    expect(r.seen[9]).toBe('watching');
    expect(r.seen[10]).toBe('degrading');
  });

  it('promotes on a rising trend before the sustain time', () => {
    setSetting('lm_watch_severe_ratio', '5');
    t = lmIssues.getThresholds();
    const r = play([...flat(6, 30), 50, 58, 62, 66]);
    expect(r.seen[8]).toBe('watching');
    expect(r.seen[9]).toBe('degrading');
    expect(episode().promote_reason).toBe('rising over 3 windows');
    expect(JSON.parse(episode().trend_json)).toEqual([54, 60, 64]);
  });

  it('promotes on severe over two consecutive samples, then to critical when severe holds', () => {
    const r = play([...flat(6, 30), ...flat(3, 100)]);
    expect(r.seen[7]).toBe('watching');
    expect(r.seen[8]).toBe('degrading');
    expect(episodes()[0].promote_reason).toMatch(/baseline on two samples/);
    const r2 = play(flat(5, 100), cursor);
    expect(r2.seen[0]).toBe('degrading');
    expect(r2.seen[1]).toBe('critical');
    expect(episode().promote_reason).toBe('severe for 15 min');
  });

  it('promotes when loss joins a latency episode', () => {
    const r = play([...flat(6, 30), 55, 55, { rtt: 55, loss: 20 }, { rtt: 55, loss: 20 }]);
    expect(r.seen[7]).toBe('watching');
    expect(r.seen[8]).toBe('degrading');
    expect(episodes()[0].promote_reason).toBe('packet loss with latency');
  });

  it('goes critical when the location is down and closes as escalated', () => {
    const r = play([...flat(6, 30), ...flat(5, 55), { rtt: null, loss: 100, status: 'down' }, ...flat(8, 30)]);
    expect(r.total.promoted).toBeGreaterThanOrEqual(2);
    expect(episode()).toMatchObject({ state: 'closed', outcome: 'escalated' });
    expect(episode().promote_reason).toBe('location down');
  });

  it('closes a frozen watching episode as a one-off after 6 hours', () => {
    play([...flat(6, 30), 100]);
    expect(episode().state).toBe('watching');
    const r = lmWatch.evaluateWatch(db, source, t, sampleAt(6) + 7 * 3600);
    expect(r.closed).toBe(1);
    expect(episode()).toMatchObject({ state: 'closed', outcome: 'one-off' });
  });

  it('closes episodes whose location left the inventory', () => {
    play([...flat(6, 30), 100]);
    db.prepare('UPDATE lm_check_locations SET stale = 1').run();
    lmWatch.evaluateWatch(db, source, t, sampleAt(7));
    expect(episode().state).toBe('closed');
  });
});

describe('computeWatchIssues', () => {
  const srcMap = () => new Map([[sid, 'Acme']]);

  it('raises latency-degrading as a warning and critical as critical, with the check target format', () => {
    play([...flat(6, 30), ...flat(4, 100)]);
    let issues = lmWatch.computeWatchIssues(db, t, srcMap()).filter((i) => i.type === 'latency-degrading');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'warning', source: 'Acme', target: 'PHX core @ den-col01' });
    expect(issues[0].message).toMatch(/RTT 100 ms against a 30 ms baseline for \d+ min \(3\.3x\)/);
    play(flat(4, 100), cursor);
    issues = lmWatch.computeWatchIssues(db, t, srcMap()).filter((i) => i.type === 'latency-degrading');
    expect(issues[0].severity).toBe('critical');
  });

  it('raises nothing for a watching episode', () => {
    play([...flat(6, 30), 100]);
    expect(episode().state).toBe('watching');
    expect(lmWatch.computeWatchIssues(db, t, srcMap())).toEqual([]);
  });

  const oneOff = (daysAgo, ratio, hop, minutes = 10) => {
    const opened = Date.now() - daysAgo * 86400000;
    const openedS = Math.floor(opened / 1000);
    db.prepare(`INSERT INTO lm_latency_episodes (source_id, subject_kind, check_id, checkpoint_id, subject_key, subject_label, site_key, kind, state, outcome,
      opened_at, closed_at, last_sample_epoch, last_elevated_epoch, peak_ratio, likely_hop)
      VALUES (?, 'check', ?, ?, ?, 'PHX core @ den-col01', 'denver', 'latency', 'closed', 'one-off', ?, ?, ?, ?, ?, ?)`)
      .run(sid, CHECK, CP, `check:${CHECK}:${CP}`, new Date(opened).toISOString(), new Date(opened + 25 * 60000).toISOString(),
        openedS + 25 * 60, openedS + minutes * 60, ratio, hop);
  };

  it('raises latency-pattern when one-offs repeat, and builds the message from the episodes', () => {
    oneOff(5.5, 2.1, 'chx1-mgt-1 Gi1/0/1, down', 4);
    oneOff(4, 3.4, 'chx1-mgt-1 Gi1/0/1, down', 9);
    oneOff(2.5, 2.6, 'chx1-mgt-1 Gi1/0/1, down', 6);
    oneOff(1, 2.2, null, 5);
    const p = lmWatch.computeWatchIssues(db, t, srcMap()).filter((i) => i.type === 'latency-pattern');
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ severity: 'warning', target: 'PHX core @ den-col01' });
    expect(p[0].message).toBe('4 spikes in 6 days, 4 to 9 min each, peaks 2.1x to 3.4x baseline, likely hop chx1-mgt-1 in 3 of 4');
  });

  it('stays quiet below the repeat minimum, outside the window, and while a degrading episode is open', () => {
    oneOff(1, 2, null);
    oneOff(2, 2, null);
    expect(lmWatch.computeWatchIssues(db, t, srcMap()).filter((i) => i.type === 'latency-pattern')).toHaveLength(0);
    oneOff(20, 2, null);
    expect(lmWatch.computeWatchIssues(db, t, srcMap()).filter((i) => i.type === 'latency-pattern')).toHaveLength(0);
    oneOff(3, 2, null);
    expect(lmWatch.computeWatchIssues(db, t, srcMap()).filter((i) => i.type === 'latency-pattern')).toHaveLength(1);
    db.prepare(`INSERT INTO lm_latency_episodes (source_id, subject_kind, check_id, checkpoint_id, subject_key, subject_label, kind, state, opened_at, last_sample_epoch,
      baseline_median, peak_ms, trend_json) VALUES (?, 'check', ?, ?, ?, 'PHX core @ den-col01', 'latency', 'degrading', ?, ?, 30, 80, '[80]')`)
      .run(sid, CHECK, CP, `check:${CHECK}:${CP}`, new Date().toISOString(), Math.floor(Date.now() / 1000));
    const all = lmWatch.computeWatchIssues(db, t, srcMap());
    expect(all.filter((i) => i.type === 'latency-pattern')).toHaveLength(0);
    expect(all.filter((i) => i.type === 'latency-degrading')).toHaveLength(1);
  });

  const reference = (rtt) => {
    for (let h = 0; h < 24; h += 1) {
      db.prepare('INSERT OR REPLACE INTO lm_check_reference (source_id, check_id, checkpoint_id, hour_of_day, samples, rtt_median, loss_median, computed_at) VALUES (?, ?, ?, ?, 200, ?, 0, ?)')
        .run(sid, CHECK, CP, h, rtt, new Date().toISOString());
    }
  };

  it('raises latency-drift as info, and as a warning at the critical percentage', () => {
    reference(23);
    let d = lmWatch.computeWatchIssues(db, t, srcMap()).filter((i) => i.type === 'latency-drift');
    expect(d).toHaveLength(1);
    expect(d[0].severity).toBe('info');
    expect(d[0].message).toBe('Baseline RTT is up 30% against the 28-day reference (23 ms to 30 ms across 24 hours)');
    reference(18);
    d = lmWatch.computeWatchIssues(db, t, srcMap()).filter((i) => i.type === 'latency-drift');
    expect(d[0].severity).toBe('warning');
    expect(d[0].message).toContain('up 67%');
  });

  it('needs most hours: 15 drifted hours of 24 raise nothing, 16 do', () => {
    reference(20);
    for (let h = 0; h < 9; h += 1) baseline(h, 20);
    expect(lmWatch.computeWatchIssues(db, t, srcMap()).filter((i) => i.type === 'latency-drift')).toHaveLength(0);
    baseline(8, 30);
    expect(lmWatch.computeWatchIssues(db, t, srcMap()).filter((i) => i.type === 'latency-drift')).toHaveLength(1);
  });
});

describe('issue hysteresis', () => {
  const seedOpen = (type, key) => db.prepare(`INSERT INTO lm_issue_history (issue_key, source, severity, type, target, message, status)
    VALUES (?, 'Acme', 'warning', ?, 'PHX core @ den-col01', 'x', 'open')`).run(key, type);
  const row = (key) => db.prepare('SELECT status, absent_polls FROM lm_issue_history WHERE issue_key = ?').get(key);

  it('keeps an anomaly issue open for one absent poll and resolves it on the second', () => {
    seedOpen('latency-anomaly', 'latency-anomaly|Acme|PHX core @ den-col01');
    lmIssues.reconcileIssueHistory();
    expect(row('latency-anomaly|Acme|PHX core @ den-col01')).toEqual({ status: 'open', absent_polls: 1 });
    lmIssues.reconcileIssueHistory();
    expect(row('latency-anomaly|Acme|PHX core @ den-col01').status).toBe('resolved');
  });

  it('resolves other issue types at once and honours lm_issue_clear_absences', () => {
    seedOpen('device-dead', 'device-dead|Acme|sw1');
    lmIssues.reconcileIssueHistory();
    expect(row('device-dead|Acme|sw1').status).toBe('resolved');
    setSetting('lm_issue_clear_absences', '3');
    seedOpen('latency-degrading', 'latency-degrading|Acme|PHX core @ den-col01');
    lmIssues.reconcileIssueHistory();
    lmIssues.reconcileIssueHistory();
    expect(row('latency-degrading|Acme|PHX core @ den-col01')).toEqual({ status: 'open', absent_polls: 2 });
    lmIssues.reconcileIssueHistory();
    expect(row('latency-degrading|Acme|PHX core @ den-col01').status).toBe('resolved');
  });

  it('resets the counter when the key is present again', () => {
    seedOpen('latency-anomaly', 'latency-anomaly|Acme|x');
    lmIssues.reconcileIssueHistory();
    expect(row('latency-anomaly|Acme|x').absent_polls).toBe(1);
    db.prepare("UPDATE lm_issue_history SET absent_polls = 1, status = 'open'").run();
    // The touch path is exercised by a live latency-degrading issue below.
    play([...flat(6, 30), ...flat(5, 100)]);
    lmIssues.reconcileIssueHistory();
    const live = db.prepare("SELECT status, absent_polls FROM lm_issue_history WHERE type = 'latency-degrading'").get();
    expect(live).toEqual({ status: 'open', absent_polls: 0 });
  });
});

describe('computeReference', () => {
  const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

  function history(daysAgo, hour, rtt, n = 12) {
    const dayStart = Math.floor(NOW / 86400000) * 86400 - daysAgo * 86400;
    for (let k = 0; k < n; k += 1) {
      db.prepare('INSERT INTO lm_check_history (source_id, check_id, checkpoint_id, sample_epoch, status, rtt_avg_ms, loss_pct) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(sid, CHECK, CP, dayStart + hour * 3600 + k * 300, 'up', rtt, 0);
    }
  }

  it('uses the reference window and excludes the newest 7 days', () => {
    for (let d = 8; d <= 27; d += 1) history(d, 10, 20);
    for (let d = 0; d <= 6; d += 1) history(d, 10, 80);
    for (let d = 29; d <= 30; d += 1) history(d, 10, 500);
    const r = lmWatch.computeReference(db, sid, lmIssues.getThresholds(), { force: true, nowMs: NOW });
    expect(r).toEqual({ skipped: false, written: 1 });
    const row = db.prepare('SELECT * FROM lm_check_reference WHERE source_id = ?').get(sid);
    expect(row).toMatchObject({ check_id: CHECK, checkpoint_id: CP, hour_of_day: 10, samples: 240, rtt_median: 20, loss_median: 0 });
  });

  it('skips while the newest row is younger than 6 days and rewrites after that', () => {
    for (let d = 8; d <= 27; d += 1) history(d, 10, 20);
    lmWatch.computeReference(db, sid, lmIssues.getThresholds(), { force: true, nowMs: NOW });
    expect(lmWatch.computeReference(db, sid, lmIssues.getThresholds(), { nowMs: NOW + 3 * 86400000 })).toEqual({ skipped: true, written: 0 });
    for (let d = 8; d <= 27; d += 1) db.prepare('UPDATE lm_check_history SET rtt_avg_ms = 25 WHERE sample_epoch = ?').run(Math.floor(NOW / 86400000) * 86400 - d * 86400 + 10 * 3600);
    const r = lmWatch.computeReference(db, sid, lmIssues.getThresholds(), { nowMs: NOW + 7 * 86400000 });
    expect(r.skipped).toBe(false);
  });
});

describe('episodeSummary and pruneEpisodes', () => {
  it('counts by outcome and state, lists the newest first and matches check names', () => {
    play([...flat(6, 30), 100, ...flat(8, 30)]);
    play([...flat(2, 30), ...flat(6, 100)], cursor);
    const all = lmWatch.episodeSummary(db, { sourceId: sid, days: 7 });
    expect(all.total).toBe(2);
    expect(all.byOutcome.oneOff).toBe(1);
    expect(all.byState.closed).toBe(1);
    expect(all.byState.degrading + all.byState.critical).toBe(1);
    expect(all.episodes[0].openedAt >= all.episodes[1].openedAt).toBe(true);
    expect(lmWatch.episodeSummary(db, { names: ['PHX core'] }).total).toBe(2);
    expect(lmWatch.episodeSummary(db, { names: ['nothing'] }).total).toBe(0);
    expect(lmWatch.episodeSummary(db, { siteKey: 'denver' }).total).toBe(2);
    const lines = lmWatch.watchLines(db, { names: ['PHX core'] });
    expect(lines.lines[0]).toMatch(/^Episode history: 2 latency episodes in 30 days for PHX core: 1 one-off/);
  });

  it('prunes closed episodes older than the window and keeps open ones', () => {
    const old = new Date(Date.now() - 100 * 86400000).toISOString();
    db.prepare(`INSERT INTO lm_latency_episodes (source_id, subject_kind, subject_key, kind, state, outcome, opened_at, closed_at)
      VALUES (?, 'check', 'a', 'latency', 'closed', 'one-off', ?, ?)`).run(sid, old, old);
    db.prepare(`INSERT INTO lm_latency_episodes (source_id, subject_kind, subject_key, kind, state, opened_at)
      VALUES (?, 'check', 'b', 'latency', 'watching', ?)`).run(sid, old);
    expect(lmWatch.pruneEpisodes(db, 90)).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM lm_latency_episodes').get().n).toBe(1);
  });
});
