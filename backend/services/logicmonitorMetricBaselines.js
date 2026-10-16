// Hour-of-day baselines for DataSource metrics that keep history (round 9, WP7).
// Today that is IP SLA: rtt_ms, jitter_ms, loss_pct and mos per probe instance.
// The shape matches the check baselines (median and MAD per UTC hour, built
// over lm_if_baseline_days) and reuses lmChecks.median / lmChecks.mad, so the
// IP SLA watch can reuse the same sample rule.
//
// A second set of rows with metric '<metric>:ref' holds the frozen reference
// for drift: the hour medians over the window that ENDS 7 days ago, so a
// slow rise inside the live window cannot hide in it. The metrics history
// retention (lm_ds_history_days, default 14) limits how far back that goes,
// so with defaults the reference covers days 7 to 14.
//
// Every cutoff is an epoch built in JS and bound.
const lmChecks = require('./logicmonitorChecks');

// family -> metrics that get baselines. Keep it a map so other families can
// opt in later.
const BASELINE_METRICS = {
  ipsla: new Set(['rtt_ms', 'jitter_ms', 'loss_pct', 'mos']),
};
// Reference rows only exist for the metrics the watch reads for drift.
const REFERENCE_METRICS = new Set(['rtt_ms']);
const REF_SUFFIX = ':ref';
// IP SLA samples arrive every 30 minutes by default, so one hour bucket holds
// about 14 samples per week; the check default (24) would never be reached.
const MIN_SAMPLES = 6;
const REF_GAP_DAYS = 7;

const tableOk = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

/**
 * Rewrite lm_ds_metric_baseline for one source from lm_ds_metrics_history.
 * t is the threshold set (needs lm_if_baseline_days; lm_watch_reference_days
 * optional). opts.nowMs overrides the clock. Returns {written, reference}.
 */
function computeMetricBaselines(db, sourceId, t = {}, opts = {}) {
  const out = { written: 0, reference: 0 };
  if (!tableOk(db, 'lm_ds_metric_baseline') || !tableOk(db, 'lm_ds_metrics_history') || !tableOk(db, 'lm_ds_instances')) return out;
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  const hourStart = Math.floor(nowMs / 3600000) * 3600;
  const days = t.lm_if_baseline_days != null ? t.lm_if_baseline_days : 7;
  const refDays = t.lm_watch_reference_days != null ? t.lm_watch_reference_days : 28;
  const stamp = new Date(nowMs).toISOString();

  const families = Object.keys(BASELINE_METRICS);
  const stmt = db.prepare(`
    SELECT h.lm_device_id, h.hds_id, h.instance_key, h.metric, h.sampled_at_epoch AS e, h.value, i.family
    FROM lm_ds_metrics_history h
    JOIN lm_ds_instances i ON i.source_id = h.source_id AND i.lm_device_id = h.lm_device_id AND i.hds_id = h.hds_id AND i.instance_key = h.instance_key
    WHERE h.source_id = ? AND i.stale = 0 AND i.family IN (${families.map(() => '?').join(',')})
      AND h.sampled_at_epoch >= ? AND h.sampled_at_epoch < ? AND h.value IS NOT NULL
  `);
  const groups = new Map();
  const add = (r, metricKey) => {
    const hour = new Date(r.e * 1000).getUTCHours();
    const k = `${r.lm_device_id}\u0000${r.hds_id}\u0000${r.instance_key}\u0000${metricKey}\u0000${hour}`;
    let g = groups.get(k);
    if (!g) { g = { dev: r.lm_device_id, hds: r.hds_id, key: r.instance_key, metric: metricKey, hour, vals: [] }; groups.set(k, g); }
    g.vals.push(r.value);
  };
  for (const r of stmt.iterate(sourceId, ...families, hourStart - days * 86400, hourStart)) {
    if (BASELINE_METRICS[r.family] && BASELINE_METRICS[r.family].has(r.metric)) add(r, r.metric);
  }
  for (const r of stmt.iterate(sourceId, ...families, hourStart - refDays * 86400, hourStart - REF_GAP_DAYS * 86400)) {
    if (BASELINE_METRICS[r.family] && REFERENCE_METRICS.has(r.metric)) add(r, r.metric + REF_SUFFIX);
  }

  db.transaction(() => {
    db.prepare('DELETE FROM lm_ds_metric_baseline WHERE source_id = ?').run(sourceId);
    const ins = db.prepare(`
      INSERT INTO lm_ds_metric_baseline (source_id, lm_device_id, hds_id, instance_key, metric, hour_of_day, samples, median, mad, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const g of groups.values()) {
      if (g.vals.length < MIN_SAMPLES) continue;
      ins.run(sourceId, g.dev, g.hds, g.key, g.metric, g.hour, g.vals.length, lmChecks.median(g.vals), lmChecks.mad(g.vals), stamp);
      if (g.metric.endsWith(REF_SUFFIX)) out.reference += 1; else out.written += 1;
    }
  })();
  return out;
}

module.exports = { computeMetricBaselines, BASELINE_METRICS, REFERENCE_METRICS, REF_SUFFIX, MIN_SAMPLES };
