/**
 * Bounded concurrency helper: mapLimit ordering, limit, failure isolation, and
 * the poller_calls_in_flight setting with its per-platform override.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { mapLimit, valuesOrThrow, callsInFlight } = require('../core/concurrency');
const settings = require('../services/settings');
const db = require('../db/database');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('mapLimit', () => {
  it('keeps result order even when later items finish first', async () => {
    const out = await mapLimit([30, 5, 20, 1], 4, async (ms, i) => { await sleep(ms); return i; });
    expect(out.map((r) => r.value)).toEqual([0, 1, 2, 3]);
    expect(out.every((r) => r.ok)).toBe(true);
  });

  it('never exceeds the limit and does reach it', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(5);
      active -= 1;
    });
    expect(out).toHaveLength(20);
    expect(peak).toBe(3);
  });

  it('one failure does not stop the rest and is reported in place', async () => {
    const seen = [];
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      seen.push(n);
      return n * 10;
    });
    expect(seen.sort()).toEqual([1, 3, 4, 5]);
    expect(out[1].ok).toBe(false);
    expect(out[1].error.message).toBe('boom');
    expect(out.filter((r) => r.ok).map((r) => r.value)).toEqual([10, 30, 40, 50]);
    expect(() => valuesOrThrow(out)).toThrow('boom');
  });

  it('limit 1 is sequential', async () => {
    const order = [];
    let active = 0;
    let peak = 0;
    await mapLimit([3, 1, 2], 1, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      order.push(`start${n}`);
      await sleep(n);
      order.push(`end${n}`);
      active -= 1;
    });
    expect(peak).toBe(1);
    expect(order).toEqual(['start3', 'end3', 'start1', 'end1', 'start2', 'end2']);
  });

  it('handles empty input and a limit larger than the list', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
    const out = await mapLimit([1, 2], 16, async (n) => n);
    expect(out.map((r) => r.value)).toEqual([1, 2]);
  });
});

describe('callsInFlight', () => {
  afterEach(() => {
    db.prepare("DELETE FROM app_settings WHERE key IN ('poller_calls_in_flight', 'zzplat_calls_in_flight')").run();
  });

  it('defaults to 4', () => {
    expect(callsInFlight('logicmonitor')).toBe(4);
  });

  it('reads the global setting and clamps to 1..16', () => {
    settings.setSetting('poller_calls_in_flight', '8');
    expect(callsInFlight('logicmonitor')).toBe(8);
    settings.setSetting('poller_calls_in_flight', '99');
    expect(callsInFlight('logicmonitor')).toBe(16);
    settings.setSetting('poller_calls_in_flight', '0');
    expect(callsInFlight('logicmonitor')).toBe(4);
    settings.setSetting('poller_calls_in_flight', 'abc');
    expect(callsInFlight('logicmonitor')).toBe(4);
  });

  it('honours a per-platform override only when the key exists', () => {
    settings.setSetting('poller_calls_in_flight', '6');
    expect(callsInFlight('zzplat')).toBe(6);
    settings.setSetting('zzplat_calls_in_flight', '2');
    expect(callsInFlight('zzplat')).toBe(2);
    expect(callsInFlight('logicmonitor')).toBe(6);
  });
});
