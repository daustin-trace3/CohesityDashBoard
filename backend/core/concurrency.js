// Bounded concurrency for pollers: run independent API calls a few at a time
// inside one tick instead of one after another.

const MIN_IN_FLIGHT = 1;
const MAX_IN_FLIGHT = 16;
const DEFAULT_IN_FLIGHT = 4;

function clampLimit(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < MIN_IN_FLIGHT) return fallback;
  return Math.min(MAX_IN_FLIGHT, Math.round(n));
}

/**
 * Run fn(item, index) over items with at most `limit` in flight. Results keep
 * the item order. One failure never rejects the run: each slot is
 * { ok: true, value } or { ok: false, error }.
 */
async function mapLimit(items, limit, fn) {
  const list = Array.from(items || []);
  const results = new Array(list.length);
  const width = Math.max(1, Math.min(Math.floor(Number(limit)) || 1, list.length || 1));
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const i = next;
      next += 1;
      try {
        results[i] = { ok: true, value: await fn(list[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  }
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

/** Values of a mapLimit run in order; throws the first failure (for loops that used to abort on one). */
function valuesOrThrow(results) {
  const bad = results.find((r) => !r.ok);
  if (bad) throw bad.error;
  return results.map((r) => r.value);
}

/**
 * Calls a poller of `platformId` keeps open at once. Global setting
 * poller_calls_in_flight (default 4, 1 to 16); a <platform>_calls_in_flight
 * setting overrides it when present.
 */
function callsInFlight(platformId) {
  const settings = require('../services/settings');
  const global = clampLimit(settings.getSetting('poller_calls_in_flight'), DEFAULT_IN_FLIGHT);
  if (!platformId) return global;
  const own = settings.getSetting(`${String(platformId).replace(/[^a-z0-9]+/gi, '_')}_calls_in_flight`);
  if (own == null || String(own).trim() === '') return global;
  return clampLimit(own, global);
}

module.exports = { mapLimit, valuesOrThrow, callsInFlight, MIN_IN_FLIGHT, MAX_IN_FLIGHT, DEFAULT_IN_FLIGHT };
