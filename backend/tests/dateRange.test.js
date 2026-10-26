import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseDateRange, rangeDayKeys, rangeFilename, rangeResponse } = require('../utils/dateRange');

afterEach(() => { vi.useRealTimers(); });

describe('parseDateRange', () => {
  it('defaults to the last 30 calendar days including today', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T15:00:00Z'));
    const r = parseDateRange({});
    expect(r).toMatchObject({ mode: 'days', days: 30, tz: 0, toDay: '2026-10-26', fromDay: '2026-09-27' });
    expect(r.fromMs).toBe(Date.UTC(2026, 8, 27));
    expect(r.toMs).toBe(Date.UTC(2026, 9, 26, 23, 59, 59, 999));
    expect(rangeDayKeys(r)).toHaveLength(30);
    expect(rangeDayKeys(r)[0]).toBe('2026-10-26');
    expect(rangeDayKeys(r)[29]).toBe('2026-09-27');
  });

  it('days=7 returns seven keys, newest first', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T15:00:00Z'));
    const keys = rangeDayKeys(parseDateRange({ days: '7' }));
    expect(keys).toEqual(['2026-10-26', '2026-10-25', '2026-10-24', '2026-10-23', '2026-10-22', '2026-10-21', '2026-10-20']);
  });

  it('uses the browser local day when tz is given (tz 420 = UTC-7)', () => {
    vi.useFakeTimers();
    // 03:00 UTC on the 26th is still the evening of the 25th in UTC-7.
    vi.setSystemTime(new Date('2026-10-26T03:00:00Z'));
    const r = parseDateRange({ days: '2', tz: '420' });
    expect(r.toDay).toBe('2026-10-25');
    expect(r.fromDay).toBe('2026-10-24');
    expect(r.fromMs).toBe(Date.UTC(2026, 9, 24, 7, 0, 0));
    expect(r.toMs).toBe(Date.UTC(2026, 9, 26, 6, 59, 59, 999));
  });

  it('handles a positive-offset zone (tz -600 = UTC+10)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T20:00:00Z'));
    const r = parseDateRange({ days: '1', tz: '-600' });
    expect(r.toDay).toBe('2026-10-26');
    expect(r.fromMs).toBe(Date.UTC(2026, 9, 25, 14, 0, 0));
  });

  it('custom range is inclusive and wins over days', () => {
    const r = parseDateRange({ days: '7', from: '2026-10-01', to: '2026-10-26' });
    expect(r.mode).toBe('custom');
    expect(r.days).toBe(26);
    expect(r.fromMs).toBe(Date.UTC(2026, 9, 1));
    expect(r.toMs).toBe(Date.UTC(2026, 9, 26, 23, 59, 59, 999));
    expect(rangeDayKeys(r)[25]).toBe('2026-10-01');
    expect(rangeFilename('cohesity', r)).toBe('cohesity-backup-history-2026-10-01_2026-10-26.csv');
  });

  it('a single-day custom range has one key', () => {
    const r = parseDateRange({ from: '2026-10-05', to: '2026-10-05' });
    expect(r.days).toBe(1);
    expect(rangeDayKeys(r)).toEqual(['2026-10-05']);
  });

  it('rejects bad input with status 400', () => {
    const cases = [
      { days: '0' }, { days: '366' }, { days: 'abc' }, { days: '1.5' },
      { from: '2026-10-05' }, { from: '2026-10-05', to: 'nope' },
      { from: '2026-10-06', to: '2026-10-05' }, { from: '2026-02-31', to: '2026-03-02' },
      { from: '2025-01-01', to: '2026-10-26' }, { tz: '900' }, { tz: 'x' },
    ];
    for (const q of cases) {
      let err;
      try { parseDateRange(q); } catch (e) { err = e; }
      expect(err, JSON.stringify(q)).toBeTruthy();
      expect(err.status).toBe(400);
      expect(typeof err.message).toBe('string');
    }
  });

  it('rangeResponse flags truncation against the history depth', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T12:00:00Z'));
    const r = parseDateRange({ days: '90' });
    expect(rangeResponse(r, 30).truncated).toBe(true);
    expect(rangeResponse(r, 120).truncated).toBe(false);
    const none = rangeResponse(r, null);
    expect(none.historyDays).toBeNull();
    expect(none.truncated).toBe(false);
    expect(none.dayKeys).toHaveLength(90);
    expect(none.range).toMatchObject({ mode: 'days', days: 90, tz: 0 });
  });
});
