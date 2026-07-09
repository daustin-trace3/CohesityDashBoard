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
  const tasks = new Map(); // sourceId -> cron task

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
      existing.stop();
      tasks.delete(sourceId);
    }
  }

  function schedule(source) {
    cancel(source.id);
    const interval = resolveInterval(intervalMinutes, source, defaultIntervalMinutes);
    const task = cronLib.schedule(cronExpression(interval), () => {
      runWrapped(source);
    });
    tasks.set(source.id, task);
    logger.info(`[${id}] Scheduled source ${source.id} (${source.name}) every ${interval} min`);
    return task;
  }

  function trigger(source) {
    return runWrapped(source);
  }

  function stopAll() {
    for (const task of tasks.values()) task.stop();
    tasks.clear();
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
    return sources;
  }

  return { init, schedule, cancel, trigger, stopAll, taskCount };
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
