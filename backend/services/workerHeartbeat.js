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
  setSetting(KEY, JSON.stringify({ at: new Date(now).toISOString(), pid: process.pid, startedAt, role }));
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

// Email the watchdog finding (2026-09-28): the poller process cannot report
// its own death, so the API process sends this over the Global Settings SMTP
// relay. Enabled + recipients live under Cohesity Settings > Polling
// (poller_watchdog_email_enabled / poller_watchdog_recipients; blank
// recipients fall back to the global default list). One email when the
// silence passes EMAIL_AFTER_MS, a reminder every EMAIL_REPEAT_MS while it
// lasts, and one recovery note when the heartbeat returns.
const EMAIL_AFTER_MS = 10 * 60000;
const EMAIL_REPEAT_MS = 6 * 3600000;
const STATE_KEY = 'poller_watchdog_email_state';

function watchdogEmailCheck(h) {
  if (getSetting('poller_watchdog_email_enabled') !== '1') return;
  const { getNotificationSettings } = require('./settings');
  const alertNotifier = require('./alertNotifier');
  const config = getNotificationSettings();
  const to = (getSetting('poller_watchdog_recipients') || '').trim() || config.smtpRecipients;
  if (!config.smtpHost || !config.smtpFrom || !to) return;

  let state = {};
  try { state = JSON.parse(getSetting(STATE_KEY) || '{}'); } catch { state = {}; }
  const now = Date.now();
  const silent = !h || !h.alive;
  const silentSinceMs = h ? Date.parse(h.at) : (state.silentSince ? Date.parse(state.silentSince) : now);

  const send = (subject, text) => alertNotifier.createTransport(config)
    .sendMail({ from: config.smtpFrom, to, subject, text })
    .then(() => true)
    .catch((err) => { logger.error(`[Worker] watchdog email failed via ${config.smtpHost}:${config.smtpPort}: ${err.message}`); return false; });

  if (silent) {
    if (!state.silentSince) { state.silentSince = new Date(silentSinceMs).toISOString(); state.lastEmailAt = null; }
    const silentMin = Math.round((now - Date.parse(state.silentSince)) / 60000);
    const due = (now - Date.parse(state.silentSince)) >= EMAIL_AFTER_MS
      && (!state.lastEmailAt || (now - Date.parse(state.lastEmailAt)) >= EMAIL_REPEAT_MS);
    if (due) {
      send(
        'CRITICAL | ICC | poller process is not running',
        `The ICC background poller has not written a heartbeat for ${silentMin} minute(s)`
        + ` (last: ${h ? h.at : 'never on this build'}${h ? `, pid ${h.pid}, started ${h.startedAt}` : ''}).\n\n`
        + 'Nothing is polling and the Ops Agent is not ticking, so every page is aging and no alerts are being triaged or emailed.\n\n'
        + 'Check the poller service on the ICC host (systemctl status / journalctl for the poller unit) and restart it.\n\n'
        + `This reminder repeats every ${Math.round(EMAIL_REPEAT_MS / 3600000)} hours while the poller stays silent. ICC watchdog (web process).`
      ).then((ok) => { if (ok) { state.lastEmailAt = new Date(now).toISOString(); setSetting(STATE_KEY, JSON.stringify(state)); logger.info(`[Worker] watchdog email sent to ${to}: poller silent ${silentMin} min`); } });
      return; // state saved in the callback
    }
  } else if (state.silentSince) {
    const wasMin = Math.round((now - Date.parse(state.silentSince)) / 60000);
    if (state.lastEmailAt) {
      send(
        'RESOLVED | ICC | poller process is back',
        `The ICC background poller is heartbeating again (pid ${h.pid}, started ${h.startedAt}) after about ${wasMin} minute(s) of silence. Polling and the Ops Agent have resumed. ICC watchdog (web process).`
      ).then(() => logger.info(`[Worker] watchdog recovery email sent to ${to}`));
    }
    state = {};
  } else {
    return; // healthy and nothing pending — no write
  }
  setSetting(STATE_KEY, JSON.stringify(state));
}

function watchCheck() {
  const h = readHeartbeat();
  if (!h) logger.warn('[Worker] no poller heartbeat: the poller process is not running, or predates the heartbeat. Nothing is polling and the Ops Agent is not ticking.');
  else if (!h.alive) logger.warn(`[Worker] poller heartbeat is ${Math.round(h.ageSeconds / 60)} min old (pid ${h.pid}, started ${h.startedAt}): background work has stopped.`);
  try { watchdogEmailCheck(h); } catch (err) { logger.error(`[Worker] watchdog email check failed: ${err.message}`); }
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
  watchdogEmailCheck,
  // test seams: a gap cannot be waited out in a unit test
  _beatForTest: beat, _setLastBeatForTest: (ms) => { lastBeat = ms; },
};
