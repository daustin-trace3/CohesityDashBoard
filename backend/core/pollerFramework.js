const nodeCron = require('node-cron');
const logger = require('../utils/logger');
const pollerStatus = require('../services/pollerStatus');

function resolveInterval(intervalMinutes, source, defaultIntervalMinutes) {
  const raw = typeof intervalMinutes === 'function' ? intervalMinutes(source) : intervalMinutes;
  const n = Number(raw);
  return Math.max(5, (Number.isFinite(n) && n > 0 ? n : 0) || defaultIntervalMinutes || 5);
}

function cronExpression(intervalMinutes) {
  return `*/${intervalMinutes} * * * *`;
}

/**
 * Shared poller lifecycle for a platform's per-source polling: cron
 * scheduling, task bookkeeping, pollerStatus markStart/markEnd wrapping, and
 * per-source error isolation. Platform-specific fetch+persist logic lives in
 * the `poll` callback and is untouched by this framework.
 */
function createPoller({ id, loadSources, intervalMinutes, poll, defaultIntervalMinutes = 15, cronLib = nodeCron }) {
  const tasks = new Map(); // sourceId -> { task, snapshot }
  let reconcileTask = null;

  async function runWrapped(source) {
    pollerStatus.markStart(id, source.id);
    try {
      await poll(source);
      pollerStatus.markEnd(id, source.id, 'success');
    } catch (err) {
      logger.error(`[${id}] Poll failed for ${source.name || source.id}:`, err?.message || err);
      pollerStatus.markEnd(id, source.id, 'error');
    }
  }

  function cancel(sourceId) {
    const existing = tasks.get(sourceId);
    if (existing) {
      existing.task.stop();
      tasks.delete(sourceId);
    }
  }

  function schedule(source) {
    cancel(source.id);
    const interval = resolveInterval(intervalMinutes, source, defaultIntervalMinutes);
    const task = cronLib.schedule(cronExpression(interval), () => {
      runWrapped(source);
    });
    tasks.set(source.id, { task, snapshot: JSON.stringify(source) });
    logger.info(`[${id}] Scheduled source ${source.id} (${source.name}) every ${interval} min`);
    return task;
  }

  // Sources registered through the WEB process never reached a long-running
  // POLLER process (init() ran once at boot) — arrays added later sat
  // unpolled/stale until a restart. Re-read sources every 5 minutes: new rows
  // get scheduled AND polled immediately, changed rows rescheduled, deleted
  // rows cancelled.
  function reconcile() {
    let sources = [];
    try {
      sources = loadSources() || [];
    } catch (err) {
      logger.error(`[${id}] Reconcile failed to load sources:`, err?.message || err);
      return;
    }
    const seen = new Set();
    for (const source of sources) {
      seen.add(source.id);
      const existing = tasks.get(source.id);
      if (!existing) {
        logger.info(`[${id}] Reconcile: new source ${source.id} (${source.name}) — scheduling + polling now`);
        schedule(source);
        runWrapped(source);
      } else if (existing.snapshot !== JSON.stringify(source)) {
        logger.info(`[${id}] Reconcile: source ${source.id} (${source.name}) changed — rescheduling`);
        schedule(source);
      }
    }
    for (const sourceId of [...tasks.keys()]) {
      if (!seen.has(sourceId)) {
        logger.info(`[${id}] Reconcile: source ${sourceId} removed — cancelling`);
        cancel(sourceId);
      }
    }
  }

  function trigger(source) {
    return runWrapped(source);
  }

  function stopAll() {
    for (const entry of tasks.values()) entry.task.stop();
    tasks.clear();
    if (reconcileTask) {
      reconcileTask.stop();
      reconcileTask = null;
    }
  }

  function taskCount() {
    return tasks.size;
  }

  function init() {
    let sources = [];
    try {
      sources = loadSources() || [];
    } catch (err) {
      logger.error(`[${id}] Failed to load sources:`, err?.message || err);
      sources = [];
    }
    for (const source of sources) schedule(source);
    if (!reconcileTask) reconcileTask = cronLib.schedule('*/5 * * * *', reconcile);
    return sources;
  }

  return { init, schedule, cancel, trigger, stopAll, taskCount, reconcile };
}

/**
 * A single recurring background task not tied to a per-row source (e.g. AIQUM
 * discovery + poll). Same pollerStatus wrapping and error isolation as
 * createPoller, keyed on `${id}:${sourceId}`.
 */
function createGlobalTask({ id, sourceId = 0, intervalMinutes, run, defaultIntervalMinutes = 15, cronLib = nodeCron }) {
  let task = null;

  async function runWrapped() {
    pollerStatus.markStart(id, sourceId);
    try {
      await run();
      pollerStatus.markEnd(id, sourceId, 'success');
    } catch (err) {
      logger.error(`[${id}] Global task failed:`, err?.message || err);
      pollerStatus.markEnd(id, sourceId, 'error');
    }
  }

  function stop() {
    if (task) {
      task.stop();
      task = null;
    }
  }

  function start() {
    stop();
    const interval = resolveInterval(intervalMinutes, undefined, defaultIntervalMinutes);
    task = cronLib.schedule(cronExpression(interval), () => {
      runWrapped();
    });
    return task;
  }

  function reschedule() {
    return start();
  }

  function trigger() {
    return runWrapped();
  }

  function isRunning() {
    return task !== null;
  }

  return { start, stop, reschedule, trigger, isRunning };
}

module.exports = { createPoller, createGlobalTask };
