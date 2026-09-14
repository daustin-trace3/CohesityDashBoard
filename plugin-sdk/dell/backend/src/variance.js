// Accepted configuration variances for the Dell governance layer.
//
// A variance is an operator's statement that a device is intentionally out
// of compliance with a baseline. It is pinned to the drift as it looked at
// acceptance time via a fingerprint of every drifted attribute and its
// expected/current pair. After each poll the poller calls syncVariances():
// if the drift no longer matches the fingerprint the variance goes 'stale'
// and the device is reported as not compliant again; if the drift returns to
// exactly the accepted shape the variance becomes 'active' again.
// Ported from backend/services/dellVariance.js (node built-ins only).
const crypto = require('crypto');

/** Stable fingerprint of a compliance detail array (order-insensitive). */
function fingerprint(detail) {
  const rows = (Array.isArray(detail) ? detail : [])
    .map((d) => `${d.group ?? ''}|${d.attribute ?? ''}|${d.expected ?? ''}|${d.current ?? ''}`)
    .sort();
  return crypto.createHash('sha1').update(rows.join('\n')).digest('hex');
}

/** Reconcile stored variances for one OME against the reports just stored.
 *  `reports` are the poller's parsed rows ({baselineId, deviceId, status, detail}).
 *  Runs inside the poller's store() transaction. */
function syncVariances(db, omeId, reports) {
  const variances = db.prepare('SELECT id, baseline_id, device_id, fingerprint, state FROM dell_config_variances WHERE ome_id = ?').all(omeId);
  if (variances.length === 0) return { stale: 0, reactivated: 0 };
  const byKey = new Map(reports.map((r) => [`${r.baselineId}|${r.deviceId}`, r]));
  const markStale = db.prepare("UPDATE dell_config_variances SET state = 'stale', stale_at = datetime('now') WHERE id = ?");
  const reactivate = db.prepare("UPDATE dell_config_variances SET state = 'active', stale_at = NULL WHERE id = ?");
  let stale = 0; let reactivated = 0;
  for (const v of variances) {
    const r = byKey.get(`${v.baseline_id}|${v.device_id}`);
    // Device not in this poll, compliant now, or over the detail cap (no
    // detail to compare): leave the variance as it is.
    if (!r || r.status !== 'noncompliant' || !r.detail) continue;
    const fp = fingerprint(r.detail);
    if (fp !== v.fingerprint && v.state === 'active') { markStale.run(v.id); stale += 1; }
    else if (fp === v.fingerprint && v.state === 'stale') { reactivate.run(v.id); reactivated += 1; }
  }
  return { stale, reactivated };
}

module.exports = { fingerprint, syncVariances };
