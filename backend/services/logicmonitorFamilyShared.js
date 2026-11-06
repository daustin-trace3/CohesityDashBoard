// Shared pieces of the LogicMonitor family models (firewalls, wireless, voice, ISE; derived platforms, round 2).
// The family services take the db handle and an optional scope { vendorKeys, excludeOwned, registry }:
//   vendorKeys   array of vendor keys to INCLUDE (null = every vendor, [] = none)
//   excludeOwned drop devices whose vendor_key belongs to a PRESENT derived platform (one home per device)
//   registry     test seam; defaults to core/registry (guarded)
// Nothing here writes.
const { memoByDbState } = require('../core/dbMemo');
const lmIssues = require('./logicmonitorIssues');
const lb = require('./logicmonitorLoadBalancers');

const { DEVICE_SELECT, deviceOut, likePat } = lb;

const nowSec = () => Math.floor(Date.now() / 1000);
const rnd1 = (v) => (v == null ? null : Math.round(Number(v) * 10) / 10);
const epochToIso = (e) => (e == null || !Number.isFinite(Number(e)) ? null : new Date(Number(e) * 1000).toISOString());
// A percent outside 0..100 is a wrong catalog pick, never shown as a number.
const pctOnly = (v) => (v == null || !Number.isFinite(Number(v)) || v < 0 || v > 100 ? null : rnd1(v));

const devBase = (r, lk) => {
  const o = deviceOut(r, lk);
  return {
    deviceId: o.id, sourceId: o.sourceId, deviceName: o.displayName || o.name, siteKey: o.siteKey, siteName: o.siteName,
    vendor: o.vendor, model: o.model, version: o.version, hostStatus: o.hostStatus,
  };
};

const maxEpoch = (dev) => {
  let best = null;
  for (const inst of dev.instances.values()) for (const m of Object.values(inst.m)) if (m.epoch != null && (best == null || m.epoch > best)) best = m.epoch;
  return best;
};

const rowsOf = (dev, metric) => (dev ? lmIssues.devInstances(dev, metric) : []);
const num = (inst, metric) => (inst.m[metric] ? inst.m[metric].value : null);
const emptyDv = (r) => ({ instances: new Map(), sourceId: r.source_id, deviceId: r.lm_device_id, name: r.display_name || r.name });

function historySeries(db, sourceId, deviceId, hdsId, key, metric, hours) {
  const since = nowSec() - Math.max(1, Number(hours) || 24) * 3600;
  return db.prepare(`
    SELECT sampled_at_epoch epoch, value FROM lm_ds_metrics_history
    WHERE source_id = ? AND lm_device_id = ? AND hds_id = ? AND instance_key = ? AND metric = ? AND sampled_at_epoch >= ?
    ORDER BY sampled_at_epoch
  `).all(sourceId, deviceId, hdsId, key, metric, since);
}
/** History of the first instance of a device that carries the metric ([] when none). */
function deviceSeries(db, dev, metric, hours = 24) {
  const hit = lmIssues.devInstances(dev, metric)[0];
  return hit ? historySeries(db, dev.sourceId, dev.deviceId, hit.hds, hit.key, metric, hours) : [];
}

/** Counter growth per unit time from history (monotonic series only), summed over instances; null when unknown. Memoized per db state. */
function counterRates(db, metric, perSeconds, windowSec = 10800) {
  return memoByDbState(db, `lmCounterRates|${metric}|${perSeconds}|${windowSec}`, () => {
    const out = new Map();
    try {
      const since = nowSec() - windowSec;
      const series = new Map();
      for (const r of db.prepare(`
        SELECT source_id, lm_device_id, hds_id, instance_key, sampled_at_epoch e, value v FROM lm_ds_metrics_history
        WHERE metric = ? AND sampled_at_epoch >= ? ORDER BY sampled_at_epoch`).all(metric, since)) {
        const k = `${r.source_id}:${r.lm_device_id}|${r.hds_id}|${r.instance_key}`;
        if (!series.has(k)) series.set(k, []);
        series.get(k).push(r);
      }
      for (const [k, pts] of series) {
        if (pts.length < 2) continue;
        let mono = true;
        for (let i = 1; i < pts.length; i += 1) if (pts[i].v < pts[i - 1].v) { mono = false; break; }
        const span = pts[pts.length - 1].e - pts[0].e;
        if (!mono || span <= 0) continue;
        const rate = ((pts[pts.length - 1].v - pts[0].v) / span) * perSeconds;
        const dk = k.split('|')[0];
        out.set(dk, (out.get(dk) || 0) + rate);
      }
    } catch { /* history table missing */ }
    return out;
  });
}

// ---- Scope: vendor keys and one home per device ----------------------------------------------

const registryOf = (opts) => {
  if (opts && opts.registry) return opts.registry;
  try { return require('../core/registry'); } catch { return null; }
};

/** Vendor keys of non-stale devices that a PRESENT derived platform owns (sorted). */
function ownedVendorKeys(db, opts = {}) {
  const reg = registryOf(opts);
  if (!reg || typeof reg.derivedPlatformFor !== 'function') return [];
  let keys;
  try { keys = db.prepare('SELECT DISTINCT vendor_key FROM lm_devices WHERE stale = 0 AND vendor_key IS NOT NULL').all().map((r) => r.vendor_key); } catch { return []; }
  return keys.filter((k) => { try { return !!reg.derivedPlatformFor(k); } catch { return false; } }).sort();
}

/** { sql, params, key } for AND-ing into a lm_devices query aliased d. sql is '' when the scope is open. key identifies the scope for memo keys. */
function scopeClause(db, scope = {}) {
  const parts = [];
  const params = [];
  const vk = scope.vendorKeys;
  if (Array.isArray(vk)) {
    const keys = vk.map(String).filter(Boolean);
    if (!keys.length) parts.push('1 = 0');
    else { parts.push(`d.vendor_key IN (${keys.map(() => '?').join(',')})`); params.push(...keys); }
  }
  let owned = [];
  if (scope.excludeOwned) {
    owned = ownedVendorKeys(db, scope);
    if (owned.length) { parts.push(`(d.vendor_key IS NULL OR d.vendor_key NOT IN (${owned.map(() => '?').join(',')}))`); params.push(...owned); }
  }
  return { sql: parts.join(' AND '), params, key: `${Array.isArray(vk) ? vk.join(',') : '*'}|${owned.join(',')}` };
}

/** Devices matching a role selector, the list filters (q, siteKey, vendor, sourceId) and the scope. */
function roleDevices(db, whereSql, q = {}, scope = {}) {
  const where = ['d.stale = 0', whereSql];
  const params = [];
  if (q.q) {
    where.push("(d.display_name LIKE ? ESCAPE '\\' OR d.name LIKE ? ESCAPE '\\' OR d.model LIKE ? ESCAPE '\\' OR d.ips_json LIKE ? ESCAPE '\\')");
    const p = likePat(q.q);
    params.push(p, p, p, p);
  }
  if (q.siteKey) { where.push('d.site_key = ?'); params.push(String(q.siteKey)); }
  if (q.vendor) { where.push("COALESCE(d.vendor, 'Unknown') = ?"); params.push(String(q.vendor)); }
  if (q.sourceId) { where.push('d.source_id = ?'); params.push(Number(q.sourceId)); }
  const sc = scopeClause(db, scope);
  if (sc.sql) { where.push(sc.sql); params.push(...sc.params); }
  return db.prepare(`${DEVICE_SELECT} WHERE ${where.join(' AND ')} ORDER BY d.display_name, d.source_id`).all(...params);
}

/** One device row that also matches a role selector and the scope, else null. */
function roleDevice(db, whereSql, id, sourceId, scope = {}) {
  const args = [id];
  let extra = '';
  if (sourceId) { extra = ' AND d.source_id = ?'; args.push(Number(sourceId)); }
  const sc = scopeClause(db, scope);
  if (sc.sql) { extra += ` AND ${sc.sql}`; args.push(...sc.params); }
  return db.prepare(`${DEVICE_SELECT} WHERE d.lm_device_id = ? AND d.stale = 0 AND ${whereSql}${extra} ORDER BY d.source_id LIMIT 1`).get(...args) || null;
}

module.exports = {
  nowSec, rnd1, epochToIso, pctOnly, devBase, maxEpoch, rowsOf, num, emptyDv, historySeries, deviceSeries, counterRates,
  ownedVendorKeys, scopeClause, roleDevices, roleDevice,
};
