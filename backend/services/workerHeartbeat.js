// Proof that the background process is alive, independent of anyone having a
// page open. The poller process writes one row every 30 s; the API process
// reads it back and watches for its absence, so "the agent stopped ticking"
// can be answered with which of three things it was:
//   no heartbeat at all      -> the poller process is not running this build
//   startedAt moved          -> it died and something restarted it
//   a gap with startedAt old -> it stayed up but the host slept or the event
//                               loop was blocked (the warn line in beat())
const logger = require('../utils/logger');
const { getSetting, setSetting } = require('./settings');

const KEY = 'poller_worker_heartbeat';
const BEAT_MS = 30000;
const GAP_MS = BEAT_MS * 4;        // 2 min with no beat from a process still up
const LOG_MS = 15 * 60000;         // one "still here" line per 15 min
const STALE_MS = 150000;           // what a page calls not reporting
const WATCH_MS = 5 * 60000;

const startedAt = new Date().toISOString();
let lastBeat = 0;
let lastLog = 0;
let handle = null;
let watchHandle = null;

function uptimeText() {
  const s = Math.floor(process.uptime());
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

function beat(role) {
  const now = Date.now();
  if (lastBeat && now - lastBeat > GAP_MS) {
    logger.warn(`[Worker] ${Math.round((now - lastBeat) / 60000)} min gap since the last heartbeat, but this process has been up ${uptimeText()}: the host was suspended or the event loop was blocked. Nothing polled or ticked during the gap.`);
  }
  lastBeat = now;
  const { forEachTenant } = require('../core/tenantRegistry');
  forEachTenant(() => {
    setSetting(KEY, JSON.stringify({ at: new Date(now).toISOString(), pid: process.pid, startedAt, role }));
  });
  if (now - lastLog >= LOG_MS) {
    lastLog = now;
    logger.info(`[Worker] heartbeat: ${role} pid ${process.pid} up ${uptimeText()}`);
  }
}

/** Called once by whichever process does the background work. */
function startHeartbeat(role = 'poller') {
  if (handle) return;
  lastLog = Date.now();
  logger.info(`[Worker] heartbeat started: ${role} pid ${process.pid}, every ${BEAT_MS / 1000}s`);
  const tick = () => { try { beat(role); } catch (err) { logger.warn(`[Worker] heartbeat write failed: ${err.message}`); } };
  tick();
  handle = setInterval(tick, BEAT_MS);
  if (handle.unref) handle.unref();   // never the reason a process stays alive
}

function stopHeartbeat() { if (handle) { clearInterval(handle); handle = null; } }

/** What the API process can tell a page about the worker. */
function readHeartbeat() {
  let raw = null;
  try { raw = getSetting(KEY); } catch { return null; }
  if (!raw) return null;
  let h; try { h = JSON.parse(raw); } catch { return null; }
  const age = Math.max(0, Math.round((Date.now() - Date.parse(h.at)) / 1000));
  return {
    at: h.at, pid: h.pid, startedAt: h.startedAt, role: h.role || 'poller',
    ageSeconds: age,
    // Up to now while it is beating; frozen at the last beat once it stops.
    uptimeSeconds: Math.max(0, Math.round(((age * 1000 < STALE_MS ? Date.now() : Date.parse(h.at)) - Date.parse(h.startedAt)) / 1000)),
    alive: age * 1000 < STALE_MS,
  };
}

function watchCheck() {
  const { forEachTenant } = require('../core/tenantRegistry');
  forEachTenant((tenant) => {
    const h = readHeartbeat();
    const who = tenant === 'default' ? '' : ` (tenant ${tenant})`;
    if (!h) logger.warn(`[Worker] no poller heartbeat${who}: the poller process is not running, or predates the heartbeat. Nothing is polling and the Ops Agent is not ticking.`);
    else if (!h.alive) logger.warn(`[Worker] poller heartbeat${who} is ${Math.round(h.ageSeconds / 60)} min old (pid ${h.pid}, started ${h.startedAt}): background work has stopped.`);
  });
}

/**
 * Run in the API process when the background work lives in another process:
 * puts a missing or stopped poller in the log unprompted, so it does not take
 * somebody noticing a stale timestamp on a page.
 */
function startWatchdog() {
  if (watchHandle) return;
  watchHandle = setInterval(watchCheck, WATCH_MS);
  if (watchHandle.unref) watchHandle.unref();
  setTimeout(watchCheck, 120000).unref?.();   // once the poller has had time to boot
}

function stopWatchdog() { if (watchHandle) { clearInterval(watchHandle); watchHandle = null; } }

module.exports = {
  startHeartbeat, stopHeartbeat, readHeartbeat, startWatchdog, stopWatchdog, watchCheck, KEY, BEAT_MS,
  // test seams: a gap cannot be waited out in a unit test
  _beatForTest: beat, _setLastBeatForTest: (ms) => { lastBeat = ms; },
};
