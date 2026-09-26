import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { getSetting, setSetting } = require('../services/settings');
const hb = require('../services/workerHeartbeat');
const logger = require('../utils/logger');

let warns; let infos; let realWarn; let realInfo;
beforeEach(() => {
  setSetting(hb.KEY, '');
  warns = []; infos = [];
  realWarn = logger.warn; realInfo = logger.info;
  logger.warn = (...a) => warns.push(a.join(' '));
  logger.info = (...a) => infos.push(a.join(' '));
});
afterEach(() => { hb.stopHeartbeat(); logger.warn = realWarn; logger.info = realInfo; });

describe('worker heartbeat', () => {
  it('writes a beat the moment it starts, so a fresh process is visible at once', () => {
    hb.startHeartbeat('poller');
    const row = JSON.parse(getSetting(hb.KEY));
    expect(row.pid).toBe(process.pid);
    expect(row.role).toBe('poller');
    expect(Date.parse(row.at)).toBeGreaterThan(Date.now() - 5000);
    expect(infos.join(' ')).toContain('heartbeat started');
  });

  it('reads back as alive with an uptime, and as not alive once the beat is stale', () => {
    hb.startHeartbeat('poller');
    const live = hb.readHeartbeat();
    expect(live.alive).toBe(true);
    expect(live.ageSeconds).toBeLessThan(5);

    const old = new Date(Date.now() - 4 * 3600000).toISOString();
    setSetting(hb.KEY, JSON.stringify({ at: old, pid: 42, startedAt: new Date(Date.now() - 9 * 3600000).toISOString(), role: 'poller' }));
    const stale = hb.readHeartbeat();
    expect(stale.alive).toBe(false);
    expect(stale.ageSeconds).toBeGreaterThan(3 * 3600);
    expect(stale.uptimeSeconds).toBeGreaterThan(4 * 3600);   // it had been up before it stopped
  });

  it('reports nothing at all when the poller process has never run this build', () => {
    setSetting(hb.KEY, '');
    expect(hb.readHeartbeat()).toBeNull();
  });

  it('names a gap where the process stayed up but nothing happened', () => {
    hb.startHeartbeat('poller');
    warns.length = 0;
    // Pretend the last beat was ten minutes ago: a live process that wrote
    // nothing for ten minutes was suspended or blocked, and that is the line
    // that tells a stopped-service story apart from a sleeping-host story.
    hb._setLastBeatForTest(Date.now() - 10 * 60000);
    hb._beatForTest('poller');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('10 min gap');
    expect(warns[0]).toContain('suspended or the event loop was blocked');
  });
});

describe('watchdog in the API process', () => {
  it('says in the log that nothing is polling when no heartbeat exists', () => {
    setSetting(hb.KEY, '');
    hb.watchCheck();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('no poller heartbeat');
    expect(warns[0]).toContain('the Ops Agent is not ticking');
  });

  it('names the age and the pid when the heartbeat went stale', () => {
    setSetting(hb.KEY, JSON.stringify({ at: new Date(Date.now() - 4 * 3600000).toISOString(), pid: 7, startedAt: new Date(Date.now() - 5 * 3600000).toISOString(), role: 'poller' }));
    hb.watchCheck();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('240 min old');
    expect(warns[0]).toContain('pid 7');
  });

  it('stays quiet while the poller is beating', () => {
    hb.startHeartbeat('poller');
    warns.length = 0;
    hb.watchCheck();
    expect(warns).toHaveLength(0);
  });
});
