// Demo scenarios for the latency watch (round 9), called from
// generators/logicmonitor.js in two steps: seedWatchHistory bends the stored
// check history BEFORE the baselines are computed, seedWatchRows replays the
// real episode engine over that history AFTER the topology passes (so the
// blamed hop is real) and computes the drift reference. Episodes are therefore
// produced by logicmonitorWatch.evaluateWatch, not written by hand.
//
// Scenarios (all deterministic, reseed-safe: the source's episodes and
// reference rows are deleted first):
//   sustained  the NYC app server reachability check from the phx collector runs
//              1.85x its baseline for the last 41 minutes: an open degrading
//              episode (latency-degrading) with a likely hop. (A branch site
//              location is not used: abq and slc already hold two anomalies each,
//              and a third would fold them into location-degraded.)
//   pattern    "DAL core reachability" from the abq collector has four
//              single-sample spikes at 5.6, 4.1, 2.7 and 1.2 days ago: four
//              closed one-off episodes (latency-pattern).
//   drift      "PHX core reachability" from the abq collector has run 35%
//              above its earlier weeks for the last 7 days (latency-drift).
const SCENARIOS = {
  sustained: { checkPrefix: 'NYC ', loc: 'phx' },
  pattern: { check: 'DAL core reachability', loc: 'abq' },
  drift: { check: 'PHX core reachability', loc: 'abq' },
};
const SPIKES = [
  { daysAgo: 5.6, factor: 3.4 },
  { daysAgo: 4.1, factor: 2.8 },
  { daysAgo: 2.7, factor: 3.1 },
  { daysAgo: 1.2, factor: 3.3 },
];

function locOf(checks, scenario) {
  const c = checks.find((x) => (scenario.check ? x.name === scenario.check : String(x.name).startsWith(scenario.checkPrefix)) && x.locations.some((l) => l.key === scenario.loc));
  const l = c && c.locations.find((x) => x.key === scenario.loc);
  return c && l ? { checkId: c.checkId, checkpointId: l.cpId, label: l.label, name: c.name } : null;
}

function scale(db, sourceId, loc, fromEpoch, toEpoch, factor) {
  db.prepare(`
    UPDATE lm_check_history SET rtt_avg_ms = round(rtt_avg_ms * ?, 2), rtt_min_ms = round(rtt_min_ms * ?, 2), rtt_max_ms = round(rtt_max_ms * ?, 2)
    WHERE source_id = ? AND check_id = ? AND checkpoint_id = ? AND sample_epoch >= ? AND sample_epoch <= ? AND rtt_avg_ms IS NOT NULL
  `).run(factor, factor, factor, sourceId, loc.checkId, loc.checkpointId, fromEpoch, toEpoch);
}

function refreshLast(db, sourceId, loc) {
  const last = db.prepare(`
    SELECT rtt_avg_ms FROM lm_check_history WHERE source_id = ? AND check_id = ? AND checkpoint_id = ? AND sample_epoch IS NOT NULL
    ORDER BY sample_epoch DESC LIMIT 1
  `).get(sourceId, loc.checkId, loc.checkpointId);
  if (last) {
    db.prepare('UPDATE lm_check_locations SET last_rtt_ms = ? WHERE source_id = ? AND check_id = ? AND checkpoint_id = ?')
      .run(last.rtt_avg_ms, sourceId, loc.checkId, loc.checkpointId);
  }
}

/** Bend the history of the three scenario locations (before computeBaselines). */
function seedWatchHistory(db, { sourceId, nowMs, checks }) {
  const nowS = Math.floor(nowMs / 1000);
  const done = {};
  db.transaction(() => {
    const a = locOf(checks, SCENARIOS.sustained);
    if (a) {
      scale(db, sourceId, a, nowS - 41 * 60, nowS, 1.85);
      refreshLast(db, sourceId, a);
      done.sustained = true;
    }
    const b = locOf(checks, SCENARIOS.pattern);
    if (b) {
      const near = db.prepare(`
        SELECT sample_epoch FROM lm_check_history WHERE source_id = ? AND check_id = ? AND checkpoint_id = ? AND sample_epoch IS NOT NULL
        ORDER BY ABS(sample_epoch - ?) LIMIT 1
      `);
      for (const sp of SPIKES) {
        const row = near.get(sourceId, b.checkId, b.checkpointId, nowS - Math.round(sp.daysAgo * 86400));
        if (row) scale(db, sourceId, b, row.sample_epoch, row.sample_epoch, sp.factor);
      }
      done.pattern = true;
    }
    const c = locOf(checks, SCENARIOS.drift);
    if (c) {
      scale(db, sourceId, c, nowS - 7 * 86400, nowS, 1.35);
      refreshLast(db, sourceId, c);
      done.drift = true;
    }
  })();
  return done;
}

/** Replay the engine over the scenario locations and compute the reference (after the topology passes). */
function seedWatchRows(db, { sourceId, nowMs, checks }) {
  const watch = require('../../services/logicmonitorWatch');
  const t = require('../../services/logicmonitorIssues').getThresholds();
  const source = db.prepare('SELECT * FROM lm_sources WHERE id = ?').get(sourceId);
  const nowS = Math.floor(nowMs / 1000);
  db.prepare('DELETE FROM lm_latency_episodes WHERE source_id = ? OR source_id NOT IN (SELECT id FROM lm_sources)').run(sourceId);
  db.prepare('DELETE FROM lm_check_reference WHERE source_id = ? OR source_id NOT IN (SELECT id FROM lm_sources)').run(sourceId);
  const out = { reference: watch.computeReference(db, sourceId, t, { force: true, nowMs }).written, opened: 0, promoted: 0, closed: 0 };
  const replay = (scenario, fromEpoch) => {
    const loc = locOf(checks, scenario);
    if (!loc) return;
    for (let e = fromEpoch; e <= nowS; e += 300) {
      const r = watch.evaluateWatch(db, source, t, e, { only: { checkId: loc.checkId, checkpointId: loc.checkpointId } });
      out.opened += r.opened; out.promoted += r.promoted; out.closed += r.closed;
    }
  };
  replay(SCENARIOS.pattern, nowS - Math.round(6.5 * 86400));
  replay(SCENARIOS.sustained, nowS - 3600);
  out.episodes = db.prepare('SELECT state, outcome, COUNT(*) AS n FROM lm_latency_episodes WHERE source_id = ? GROUP BY state, outcome').all(sourceId);
  return out;
}

module.exports = { seedWatchHistory, seedWatchRows, SCENARIOS };
