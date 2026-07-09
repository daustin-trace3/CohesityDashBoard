import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

// pollerFramework.js is CJS and requires pollerStatus.js via require(); to
// observe the same module instance (same in-memory `states` Map) the test
// must also load both via require() rather than a separate ESM import,
// which vitest's SSR transform otherwise resolves to a distinct instance.
const require = createRequire(import.meta.url);

// Fake cron lib: schedule() returns a task handle with a spy-able stop(), and
// exposes fire() so tests can trigger the callback directly instead of
// waiting on a real cron tick.
function makeFakeCronLib() {
  const scheduled = [];
  return {
    scheduled,
    schedule(expression, cb) {
      const task = { expression, cb, stopped: false, stop: vi.fn(() => { task.stopped = true; }) };
      scheduled.push(task);
      return task;
    },
  };
}

describe('pollerFramework', () => {
  let createPoller;
  let createGlobalTask;
  let pollerStatus;

  beforeEach(() => {
    vi.resetModules();
    const framework = require('../core/pollerFramework.js');
    createPoller = framework.createPoller;
    createGlobalTask = framework.createGlobalTask;
    pollerStatus = require('../services/pollerStatus.js');
  });

  describe('createPoller', () => {
    it('schedule() creates a task; rescheduling the same source cancels the old one first (taskCount stable)', () => {
      const cronLib = makeFakeCronLib();
      const poller = createPoller({ id: 'test', loadSources: () => [], poll: async () => {}, cronLib });

      const source = { id: 1, name: 'src-1', polling_interval_minutes: 10 };
      poller.schedule(source);
      expect(poller.taskCount()).toBe(1);
      const firstTask = cronLib.scheduled[0];

      poller.schedule(source);
      expect(poller.taskCount()).toBe(1);
      expect(firstTask.stop).toHaveBeenCalledTimes(1);
      expect(cronLib.scheduled).toHaveLength(2);
    });

    it('clamps the interval below 5 minutes up to 5', () => {
      const cronLib = makeFakeCronLib();
      const poller = createPoller({
        id: 'test', loadSources: () => [], poll: async () => {}, cronLib,
        intervalMinutes: (source) => source.polling_interval_minutes,
      });
      poller.schedule({ id: 1, name: 's', polling_interval_minutes: 2 });
      expect(cronLib.scheduled[0].expression).toBe('*/5 * * * *');
    });

    it('falls back to the configured default when interval is missing', () => {
      const cronLib = makeFakeCronLib();
      const poller = createPoller({
        id: 'test', loadSources: () => [], poll: async () => {}, cronLib, defaultIntervalMinutes: 15,
      });
      poller.schedule({ id: 1, name: 's', polling_interval_minutes: undefined });
      expect(cronLib.scheduled[0].expression).toBe('*/15 * * * *');
    });

    it('trigger() runs poll() wrapped with markStart/markEnd success', async () => {
      const cronLib = makeFakeCronLib();
      const poll = vi.fn(async () => {});
      const poller = createPoller({ id: 'cohesity', loadSources: () => [], poll, cronLib });

      const source = { id: 42, name: 'cluster-42' };
      await poller.trigger(source);

      expect(poll).toHaveBeenCalledWith(source);
      const state = pollerStatus.getState('cohesity', 42);
      expect(state.lastPollStatus).toBe('success');
      expect(state.isSyncing).toBe(false);
      expect(state.lastPollStart).not.toBeNull();
      expect(state.lastPollEnd).not.toBeNull();
    });

    it('poll() throwing marks the source as error, never propagates, and leaves other sources unaffected', async () => {
      const cronLib = makeFakeCronLib();
      const poll = vi.fn(async (source) => {
        if (source.id === 1) throw new Error('boom');
      });
      const poller = createPoller({ id: 'pure', loadSources: () => [], poll, cronLib });

      await expect(poller.trigger({ id: 1, name: 'bad' })).resolves.toBeUndefined();
      await poller.trigger({ id: 2, name: 'good' });

      expect(pollerStatus.getState('pure', 1).lastPollStatus).toBe('error');
      expect(pollerStatus.getState('pure', 2).lastPollStatus).toBe('success');
    });

    it('poll() throwing does not create an unhandled rejection', async () => {
      const cronLib = makeFakeCronLib();
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        const poller = createPoller({
          id: 'netapp', loadSources: () => [], poll: async () => { throw new Error('nope'); }, cronLib,
        });
        poller.schedule({ id: 9, name: 'array-9', polling_interval_minutes: 5 });
        cronLib.scheduled[0].cb();
        await new Promise((resolve) => setImmediate(resolve));
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('stopAll() cancels every scheduled task', () => {
      const cronLib = makeFakeCronLib();
      const poller = createPoller({ id: 'test', loadSources: () => [], poll: async () => {}, cronLib });
      poller.schedule({ id: 1, name: 'a', polling_interval_minutes: 5 });
      poller.schedule({ id: 2, name: 'b', polling_interval_minutes: 5 });
      expect(poller.taskCount()).toBe(2);

      poller.stopAll();

      expect(poller.taskCount()).toBe(0);
      for (const task of cronLib.scheduled) expect(task.stop).toHaveBeenCalled();
    });

    it('init() logs and continues with zero tasks when loadSources() throws', () => {
      const cronLib = makeFakeCronLib();
      const poller = createPoller({
        id: 'test',
        loadSources: () => { throw new Error('db not ready'); },
        poll: async () => {},
        cronLib,
      });

      const result = poller.init();

      expect(result).toEqual([]);
      expect(poller.taskCount()).toBe(0);
    });

    it('init() schedules every source returned by loadSources()', () => {
      const cronLib = makeFakeCronLib();
      const sources = [
        { id: 1, name: 'a', polling_interval_minutes: 10 },
        { id: 2, name: 'b', polling_interval_minutes: 20 },
      ];
      const poller = createPoller({ id: 'test', loadSources: () => sources, poll: async () => {}, cronLib });

      const result = poller.init();

      expect(result).toBe(sources);
      expect(poller.taskCount()).toBe(2);
    });
  });

  describe('createGlobalTask', () => {
    it('start() schedules a task; isRunning() reflects state; stop() cancels it', () => {
      const cronLib = makeFakeCronLib();
      const task = createGlobalTask({ id: 'netapp', intervalMinutes: 15, run: async () => {}, cronLib });

      expect(task.isRunning()).toBe(false);
      task.start();
      expect(task.isRunning()).toBe(true);
      expect(cronLib.scheduled).toHaveLength(1);

      task.stop();
      expect(task.isRunning()).toBe(false);
      expect(cronLib.scheduled[0].stop).toHaveBeenCalled();
    });

    it('reschedule() cancels the previous cron task before creating a new one', () => {
      const cronLib = makeFakeCronLib();
      const task = createGlobalTask({ id: 'netapp', intervalMinutes: 15, run: async () => {}, cronLib });

      task.start();
      const firstTask = cronLib.scheduled[0];
      task.reschedule();

      expect(firstTask.stop).toHaveBeenCalledTimes(1);
      expect(cronLib.scheduled).toHaveLength(2);
      expect(task.isRunning()).toBe(true);
    });

    it('trigger() runs run() wrapped with markStart/markEnd success on sourceId 0 by default', async () => {
      const cronLib = makeFakeCronLib();
      const run = vi.fn(async () => {});
      const task = createGlobalTask({ id: 'netapp', intervalMinutes: 15, run, cronLib });

      await task.trigger();

      expect(run).toHaveBeenCalledTimes(1);
      expect(pollerStatus.getState('netapp', 0).lastPollStatus).toBe('success');
    });

    it('run() throwing marks error and never propagates', async () => {
      const cronLib = makeFakeCronLib();
      const task = createGlobalTask({
        id: 'netapp', sourceId: 0, intervalMinutes: 15, run: async () => { throw new Error('sync failed'); }, cronLib,
      });

      await expect(task.trigger()).resolves.toBeUndefined();
      expect(pollerStatus.getState('netapp', 0).lastPollStatus).toBe('error');
    });
  });
});
