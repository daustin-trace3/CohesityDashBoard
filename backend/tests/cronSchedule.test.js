import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { scheduleCron } = require('../core/cronSchedule');

function fakeCron() {
  const calls = [];
  return { calls, schedule: (expression, cb, options) => { calls.push({ expression, cb, options }); return { stop() {} }; } };
}

describe('scheduleCron', () => {
  it('asks node-cron to recover missed ticks', () => {
    const lib = fakeCron();
    scheduleCron('*/5 * * * *', () => {}, lib);
    expect(lib.calls[0].options).toEqual({ recoverMissedExecutions: true });
  });

  it('runs a minute once even when node-cron fires it twice', () => {
    const lib = fakeCron();
    let runs = 0;
    scheduleCron('*/5 * * * *', () => { runs += 1; }, lib);
    const { cb } = lib.calls[0];
    cb(new Date('2026-10-21T17:20:00.400Z'));
    cb(new Date('2026-10-21T17:20:00.900Z'));
    expect(runs).toBe(1);
    cb(new Date('2026-10-21T17:25:00.100Z'));
    expect(runs).toBe(2);
  });

  it('does not dedupe manual runs', () => {
    const lib = fakeCron();
    let runs = 0;
    scheduleCron('*/5 * * * *', () => { runs += 1; }, lib);
    lib.calls[0].cb('manual');
    lib.calls[0].cb('manual');
    expect(runs).toBe(2);
  });
});
