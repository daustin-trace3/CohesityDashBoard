/**
 * LogicMonitor latency watch: episodeWhy() gives the plain-English reason for an episode state, and
 * episodeView() attaches it as `why` so every episode row the routes return carries it.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const w = require('../services/logicmonitorWatch');

const T = { lm_watch_sustain_minutes: 15, lm_watch_trend_windows: 3, lm_watch_severe_ratio: 2, lm_watch_clear_samples: 3 };
const base = {
  id: 1, kind: 'latency', state: 'watching', opened_at: '2026-10-19T10:00:00.000Z', promoted_at: null, closed_at: null, outcome: null,
  peak_ms: 84.2, peak_ratio: 2.8, loss_max_pct: 0, baseline_median: 30, baseline_samples: 168, samples: 12, elevated_samples: 5,
  consecutive_normal: 0, promote_reason: null, likely_hop: null,
};

describe('episodeWhy', () => {
  it('watching names the numbers and what would promote it', () => {
    const r = w.episodeWhy(base, T);
    expect(r.headline).toBe('Watching: latency above baseline, not yet promoted');
    expect(r.lines[0]).toBe('Peak 84.2 ms, 2.8x the baseline of 30 ms (168 samples)');
    expect(r.lines).toContain('5 of 12 samples elevated since 2026-10-19T10:00:00.000Z');
    expect(r.lines.join(' ')).toContain('Becomes degrading after 15 min elevated, 3 rising windows, packet loss with latency, or two samples over 2x the baseline');
  });

  it('degrading shows the promote reason, the critical rule and the close progress', () => {
    const r = w.episodeWhy({ ...base, state: 'degrading', promote_reason: 'elevated for 16 min', promoted_at: '2026-10-19T10:16:00.000Z', consecutive_normal: 1 }, T);
    expect(r.headline).toBe('Degrading: elevated for 16 min (promoted 2026-10-19T10:16:00.000Z)');
    expect(r.lines.join('\n')).toContain('Becomes critical when the location goes down or the severe condition');
    expect(r.lines.join('\n')).toContain('holds for 15 min');
    expect(r.lines).toContain('Closes after 3 normal samples (1 so far)');
  });

  it('critical adds the likely hop', () => {
    const r = w.episodeWhy({ ...base, state: 'critical', promote_reason: 'location down', promoted_at: '2026-10-19T10:20:00.000Z', likely_hop: 'phx-rtr-01 Gi0/0/0, down' }, T);
    expect(r.headline).toBe('Critical: location down (promoted 2026-10-19T10:20:00.000Z)');
    expect(r.lines).toContain('Likely hop: phx-rtr-01 Gi0/0/0, down');
    expect(r.lines.some((l) => l.startsWith('Closes after'))).toBe(true);
  });

  it('closed explains the outcome', () => {
    const one = w.episodeWhy({ ...base, state: 'closed', outcome: 'one-off', closed_at: '2026-10-19T10:30:00.000Z' }, T);
    expect(one.headline).toBe('Closed 2026-10-19T10:30:00.000Z, outcome one-off');
    expect(one.lines[0]).toMatch(/without ever being promoted/);
    expect(w.episodeWhy({ ...base, state: 'closed', outcome: 'sustained', closed_at: 'x' }, T).lines[0]).toMatch(/degrading but never critical/);
    expect(w.episodeWhy({ ...base, state: 'closed', outcome: 'escalated', closed_at: 'x' }, T).lines[0]).toMatch(/reached critical/);
  });

  it('the loss kind reports peak loss, not milliseconds', () => {
    const r = w.episodeWhy({ ...base, kind: 'loss', peak_ms: null, peak_ratio: null, loss_max_pct: 12.5 }, T);
    expect(r.headline).toBe('Watching: packet loss above baseline, not yet promoted');
    expect(r.lines[0]).toBe('Peak loss 12.5%');
  });

  it('uses the supplied thresholds and episodeView attaches why', () => {
    const r = w.episodeWhy(base, { ...T, lm_watch_sustain_minutes: 30, lm_watch_severe_ratio: 3 });
    expect(r.lines.join(' ')).toContain('after 30 min elevated');
    expect(r.lines.join(' ')).toContain('over 3x');
    const v = w.episodeView({ ...base, subject_label: 'chk @ loc' }, T);
    expect(v.why.headline).toMatch(/^Watching/);
  });
});
