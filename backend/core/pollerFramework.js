const nodeCron = require('node-cron');
const { scheduleCron } = require('./cronSchedule');
const logger = require('../utils/logger');
const pollerStatus = require('../services/pollerStatus');

// A poll that grows the process by this much, or leaves it above the high
// mark, gets one memory line in the log (see runWrapped).
const MEM_LOG_GROWTH_BYTES = 64 * 1048576;
const MEM_LOG_HIGH_BYTES = 400 * 1048576;

function resolveInterval(intervalMinutes, source, defaultIntervalMinutes) {
  const raw = typeof intervalMinutes === 'function' ? intervalMinutes(source) : intervalMinutes;
  const n = Number(raw);
  return Math.max(5, (Number.isFinite(n) && n > 0 ? n : 0) || defaultIntervalMinutes || 5);
}

function cronExpression(intervalMinutes) {
  return `*/${intervalMinutes} * * * *`;
}

const RECONCILE_CRON = '2,7,12,17,22,27,32,37,42,47,52,57 * * * *';

/**
 * Shared poller lifecycle for a platform's per-source polling: cron
 * scheduling, task bookkeeping, pollerStatus markStart/markEnd wrapping, and
 * per-source error isolation. Platform-specific fetch+persist logic lives in
 * the `poll` callback and is untouched by this framework.
 */
function createPoller({ id, loadSources, intervalMinutes, poll, shouldRun = null, serialize = false, maxRunMinutes = 20, defaultIntervalMinutes = 15, cronLib = nodeCron }) {
  const tasks = new Map(); // sourceId -> { task, interval }
  let reconcileTask = null;

  // A cron fire polls the CURRENT row, not the one captured when the task was
  // scheduled: the poll itself writes columns on the source row (last_*
  // stamps, cursors, learned features), so the captured row goes stale after
  // one poll. Falls back to the captured row when loadSources no longer
  // returns it (the reconcile cancels such a task within five minutes).
  function currentRow(source) {
    let rows = [];
    try { rows = loadSources() || []; } catch (err) {
      logger.warn(`[${id}] could not re-read source ${source.id} before polling: ${err?.message || err}`);
      return source;
    }
    return rows.find((s) => Number(s.id) === Number(source.id)) || source;
  }

  async function runWrapped(source) {
    pollerStatus.markStart(id, source.id);
    const rssBefore = process.memoryUsage().rss;
    try {
      await poll(source);
      pollerStatus.markEnd(id, source.id, 'success');
    } catch (err) {
      logger.error(`[${id}] Poll failed for ${source.name || source.id}:`, err?.message || err);
      pollerStatus.markEnd(id, source.id, 'error');
    } finally {
      // Which poll grows the process: pm2 restarts the poller past its memory
      // limit without saying what was running (seen 2026-10-19, ten kills an
      // hour). Logged only when this poll moved the needle or left it high.
      const mu = process.memoryUsage();
      const grew = mu.rss - rssBefore;
      if (grew > MEM_LOG_GROWTH_BYTES || mu.rss > MEM_LOG_HIGH_BYTES) {
        const mb = (n) => Math.round(n / 1048576);
        logger.info(`[${id}] ${source.name || source.id}: rss ${mb(mu.rss)} MB (${grew >= 0 ? '+' : ''}${mb(grew)} MB during this poll), heap ${mb(mu.heapUsed)} MB, external ${mb(mu.external)} MB`);
      }
    }
  }

  // serialize: one poll at a time for the whole platform — the next starts
  // only when the previous completed or failed, and a source already queued
  // or running is not queued again. Keeps a big fleet from hitting its
  // upstream (Helios) in bursts when many cron ticks line up.
  //
  // Head-of-line guard: a poll cannot be killed mid-flight in Node, so a
  // stuck one (every HTTP call has its own 30 s timeout, but a pathological
  // request sequence can run long) would otherwise delay every source behind
  // it. After maxRunMinutes the queue RELEASES and moves on; the stuck poll
  // keeps running in the background and still records its own end when (if)
  // it finishes. The source stays in `pending` until then, so its own next
  // fires are still skipped rather than piling a second copy on.
  let chain = Promise.resolve();
  const pending = new Set();
  function run(source) {
    if (!serialize) return runWrapped(source);
    if (pending.has(source.id)) {
      logger.debug(`[${id}] ${source.name || source.id} is already queued or polling — skipped`);
      return chain;
    }
    pending.add(source.id);
    chain = chain.then(() => {
      const work = (async () => {
        try { await runWrapped(source); } finally { pending.delete(source.id); }
      })();
      let timer = null;
      const release = new Promise((resolve) => {
        timer = setTimeout(() => {
          logger.warn(`[${id}] Poll of ${source.name || source.id} has run past ${maxRunMinutes} min — releasing the queue so other sources are not delayed; it continues in the background.`);
          resolve();
        }, maxRunMinutes * 60000);
        if (timer.unref) timer.unref();
      });
      work.finally(() => clearTimeout(timer));
      return Promise.race([work, release]);
    });
    return chain;
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
    const task = scheduleCron(cronExpression(interval), () => {
      const row = currentRow(source);
      // The gate only guards SCHEDULED polls (backoff after repeated total
      // failures); a manual trigger() bypasses it on purpose.
      if (shouldRun && !shouldRun(row)) {
        logger.debug(`[${id}] Skipping scheduled poll of ${row.name || row.id}: backing off`);
        return;
      }
      run(row);
    }, cronLib);
    tasks.set(source.id, { task, interval });
    logger.info(`[${id}] Scheduled source ${source.id} (${source.name}) every ${interval} min`);
    return task;
  }

  // Sources registered through the WEB process never reached a long-running
  // POLLER process (init() ran once at boot) — arrays added later sat
  // unpolled/stale until a restart. Re-read sources every 5 minutes: new rows
  // get scheduled AND polled immediately, rows whose interval changed are
  // rescheduled, deleted rows cancelled. Only the interval decides a
  // reschedule: comparing whole rows rescheduled every source on every poll
  // (the poll writes last_* stamps and cursors on the row), and the reconcile
  // shared the :00/:05 minute with the 5 minute polls it then cancelled
  // (CG box, 2026-10-21). Other column changes reach the poll through
  // currentRow() at the next fire.
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
        run(source);
      } else {
        const interval = resolveInterval(intervalMinutes, source, defaultIntervalMinutes);
        if (existing.interval !== interval) {
          logger.info(`[${id}] Reconcile: source ${source.id} (${source.name}) interval ${existing.interval} -> ${interval} min — rescheduling`);
          schedule(source);
        }
      }
    }
    for (const sourceId of [...tasks.keys()]) {
      if (!seen.has(sourceId)) {
        logger.info(`[${id}] Reconcile: source ${sourceId} removed — cancelling`);
        cancel(sourceId);
      }
    }
  }

  /** Poll one source now. Takes the source row (callers that already hold it)
   *  or its id, in which case the full row is resolved through loadSources —
   *  poll() needs every column, not just a name. */
  function trigger(source) {
    // A manual trigger bypasses the shouldRun backoff gate but still joins
    // the serialized queue, so "one poll at a time" holds even for clicks.
    if (source && typeof source === 'object') return run(source);
    const wanted = Number(source);
    let rows = [];
    try { rows = loadSources() || []; } catch (err) { return Promise.reject(err); }
    const row = rows.find((s) => Number(s.id) === wanted);
    if (!row) return Promise.reject(new Error(`[${id}] source ${source} not found`));
    return run(row);
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
    // Off the multiples of five, so the reconcile never shares a minute with
    // a scheduled poll (every interval is a multiple of 5).
    if (!reconcileTask) reconcileTask = scheduleCron(RECONCILE_CRON, reconcile, cronLib);
    return sources;
  }

  return { init, schedule, cancel, trigger, stopAll, taskCount, reconcile };
}

/**
 * A single recurring background task not tied to a per-row source (e.g. AIQUM
 * discovery + poll). Same pollerStatus wrapping and error isolation as
 * createPoller, keyed on `${id}:${sourceId}`.
 */
function createGlobalTask({ id, sourceId = 0, intervalMinutes, run, defaultIntervalMinutes = 15, cronLib = nodeCron, shouldRun }) {
  let task = null;

  async function runWrapped() {
    // Optional gate (e.g. an unconfigured SaaS account): skip without touching
    // poller_status so nothing records a poll that never happened.
    if (typeof shouldRun === 'function' && !shouldRun()) {
      logger.debug(`[${id}] skipped: not configured`);
      return;
    }
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
    task = scheduleCron(cronExpression(interval), () => {
      runWrapped();
    }, cronLib);
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
