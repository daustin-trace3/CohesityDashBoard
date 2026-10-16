// Cloud circuits (round 9, WP7): AWS Direct Connect connections and virtual
// interfaces, Azure ExpressRoute circuits. Everything here reads the family
// 'cloud' metrics the DataSource metrics tier stores in lm_ds_metrics; nothing
// polls the cloud directly.
//
// ALL UNVERIFIED against a live portal: the DataSource names, the datapoint
// names behind dx_* / vif_* / er_*, the connection state enum, the ERT strings
// and the bandwidth property name. The rules therefore tolerate absence and
// print the raw value they decided on.
//
//   cloud-circuit-down       critical  dx_state, vif_state or er_bgp says down.
//                            A numeric value of 0 is down; text containing
//                            "down" or "unavailable" is down. The raw value is
//                            in the message so the enum can be learned.
//   cloud-circuit-saturated  warning   max(in, out) bps at or above
//                            lm_circuit_sat_pct of the known bandwidth. The
//                            bandwidth comes from a device property whose name
//                            contains "bandwidth" (custom, then auto, then
//                            system), else it is unknown and the rule skips.
const KINDS = {
  'aws-dx': { label: 'Direct Connect', state: 'dx_state', in: 'dx_bps_in', out: 'dx_bps_out', bgp: null, prefix: 'dx_' },
  'aws-vif': { label: 'Direct Connect virtual interface', state: 'vif_state', in: 'vif_bps_in', out: 'vif_bps_out', bgp: 'vif_bgp', prefix: 'vif_' },
  'azure-er': { label: 'ExpressRoute', state: 'er_bgp', in: 'er_bps_in', out: 'er_bps_out', bgp: 'er_bgp', prefix: 'er_' },
};
const REGION_PROPS = ['system.aws.region', 'auto.aws.region', 'aws.region', 'system.azure.location', 'auto.azure.location', 'azure.location', 'system.region', 'auto.region', 'location', 'region'];

const fmtNum = (v) => (v == null ? 'n/a' : Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10));
const parseJson = (s, fb) => { try { const v = JSON.parse(s); return v == null ? fb : v; } catch { return fb; } };

/** Value reads as down: numeric 0, or text matching down|unavailable. */
function isDownValue(v) {
  if (v == null) return false;
  if (typeof v === 'number') return Number.isFinite(v) && Math.round(v) === 0;
  return /down|unavailable|^0$/i.test(String(v).trim());
}

/** Kind of a dev (from the index) by the metric keys its cloud instances carry; null when none. */
function kindOfDev(dev) {
  const keys = new Set();
  for (const inst of dev.instances.values()) if (inst.family === 'cloud') for (const k of Object.keys(inst.m)) keys.add(k);
  if (!keys.size) return null;
  for (const [kind, def] of Object.entries(KINDS)) if ([...keys].some((k) => k.startsWith(def.prefix))) return kind;
  return null;
}

/** "10 Gbps", "500Mbps", "1000" -> bits per second; a bare number is Mbps up to 100000, else bps. UNVERIFIED unit. */
function parseBandwidth(v) {
  if (v == null) return null;
  const m = /^\s*([\d.]+)\s*([kmgt]?)\s*(?:bps|b\/s|bit\/s)?\s*$/i.exec(String(v).replace(/,/g, ''));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = m[2].toLowerCase();
  if (u) return n * { k: 1e3, m: 1e6, g: 1e9, t: 1e12 }[u];
  return n <= 100000 ? n * 1e6 : n;
}

function propMap(row) {
  const out = new Map();
  for (const col of ['system_props_json', 'auto_props_json', 'custom_props_json']) {
    const list = parseJson(row[col], []);
    if (!Array.isArray(list)) continue;
    // custom last so it wins
    for (const p of list) if (p && p.name != null && p.value != null && p.value !== '') out.set(String(p.name).toLowerCase(), String(p.value));
  }
  return out;
}

/** {region, bandwidthBps, ert, props} for one device row. */
function deviceFacts(row) {
  if (!row) return { region: null, bandwidthBps: null, ert: null };
  const props = propMap(row);
  let region = null;
  for (const k of REGION_PROPS) if (props.has(k)) { region = props.get(k); break; }
  let bw = null;
  for (const [k, v] of props) if (/bandwidth/.test(k)) { bw = parseBandwidth(v); if (bw) break; }
  return { region, bandwidthBps: bw, ert: row.ert || null };
}

function factsFor(dbh, sourceId, deviceId) {
  try {
    return deviceFacts(dbh.prepare('SELECT ert, system_props_json, auto_props_json, custom_props_json FROM lm_devices WHERE source_id = ? AND lm_device_id = ?').get(sourceId, deviceId));
  } catch { return deviceFacts(null); }
}

/** Per-device state: 'critical' (down), 'warning' (saturated), 'ok', or 'unknown' with nothing read. */
function evaluateDev(dev, kind, facts, t) {
  const def = KINDS[kind];
  const insts = [...dev.instances.values()].filter((i) => i.family === 'cloud');
  let down = null;
  let raw = null;
  let inBps = null;
  let outBps = null;
  let bgp = null;
  let seenState = false;
  for (const i of insts) {
    const sv = i.m[def.state] && i.m[def.state].value;
    if (sv != null) {
      seenState = true;
      if (isDownValue(sv) && !down) { down = i; raw = sv; }
    }
    if (def.bgp && i.m[def.bgp] && i.m[def.bgp].value != null) bgp = bgp == null ? i.m[def.bgp].value : Math.min(bgp, i.m[def.bgp].value);
    if (i.m[def.in] && i.m[def.in].value != null) inBps = (inBps || 0) + i.m[def.in].value;
    if (i.m[def.out] && i.m[def.out].value != null) outBps = (outBps || 0) + i.m[def.out].value;
  }
  const peak = Math.max(inBps || 0, outBps || 0);
  const utilPct = facts.bandwidthBps && (inBps != null || outBps != null) ? (peak / facts.bandwidthBps) * 100 : null;
  const saturated = utilPct != null && utilPct >= t.lm_circuit_sat_pct;
  let state = 'unknown';
  if (down) state = 'critical';
  else if (saturated) state = 'warning';
  else if (seenState || inBps != null || outBps != null) state = 'ok';
  return { down, raw, inBps, outBps, bgp, utilPct, saturated, state };
}

/**
 * Issue rows for computeMetricIssues. index = loadDsIndex() output. Devices in
 * scheduled downtime raise nothing.
 */
function cloudIssues(dbh, t, srcName, index) {
  const issues = [];
  if (!index || !index.size) return issues;
  for (const dev of index.values()) {
    if (dev.sdt) continue;
    const kind = kindOfDev(dev);
    if (!kind) continue;
    const def = KINDS[kind];
    const facts = factsFor(dbh, dev.sourceId, dev.deviceId);
    const ev = evaluateDev(dev, kind, facts, t);
    const source = srcName.get(dev.sourceId);
    const name = dev.name;
    if (ev.down) {
      const what = ev.down.name && ev.down.name !== ev.down.key ? ` (${ev.down.name})` : '';
      issues.push({
        severity: 'critical', type: 'cloud-circuit-down', source, target: name,
        message: `${def.label} ${name}${what} is down: ${def.state} reads ${fmtNum(ev.raw)} (enum unverified; 0, down or unavailable count as down)`,
      });
    }
    if (ev.saturated) {
      issues.push({
        severity: 'warning', type: 'cloud-circuit-saturated', source, target: name,
        message: `${def.label} ${name} is at ${fmtNum(ev.utilPct)}% of its ${fmtNum(facts.bandwidthBps / 1e6)} Mbps (in ${fmtNum((ev.inBps || 0) / 1e6)} Mbps, out ${fmtNum((ev.outBps || 0) / 1e6)} Mbps; threshold ${t.lm_circuit_sat_pct}%)`,
      });
    }
  }
  return issues;
}

/**
 * Rows for the Circuits page "Cloud circuits" section:
 * [{sourceId, deviceId, name, kind, kindLabel, region, siteKey, state, stateRaw, bpsIn, bpsOut, bgp,
 *   bandwidthBps, utilPct, series24h: [{epoch, inBps, outBps}]}]. Worst first.
 * opts {sourceId, siteKey, hours (24)}. Never throws on missing tables.
 */
function cloudCircuits(dbh, t, opts = {}) {
  let index;
  try {
    index = require('./logicmonitorIssues').loadDsIndex(dbh, { families: ['cloud'], sourceId: opts.sourceId != null ? opts.sourceId : undefined });
  } catch { return []; }
  const hours = opts.hours || 24;
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const out = [];
  for (const dev of index.values()) {
    if (opts.siteKey && dev.siteKey !== opts.siteKey) continue;
    const kind = kindOfDev(dev);
    if (!kind) continue;
    const def = KINDS[kind];
    const facts = factsFor(dbh, dev.sourceId, dev.deviceId);
    const ev = evaluateDev(dev, kind, facts, t);
    const buckets = new Map();
    try {
      const rows = dbh.prepare(`
        SELECT metric, value, sampled_at_epoch AS e FROM lm_ds_metrics_history
        WHERE source_id = ? AND lm_device_id = ? AND metric IN (?, ?) AND sampled_at_epoch >= ? ORDER BY sampled_at_epoch
      `).all(dev.sourceId, dev.deviceId, def.in, def.out, since);
      for (const r of rows) {
        const b = buckets.get(r.e) || { epoch: r.e, inBps: 0, outBps: 0 };
        if (r.metric === def.in) b.inBps += r.value; else b.outBps += r.value;
        buckets.set(r.e, b);
      }
    } catch { /* history table missing */ }
    const down = ev.down;
    out.push({
      sourceId: dev.sourceId, deviceId: dev.deviceId, name: dev.name, kind, kindLabel: def.label,
      region: facts.region, siteKey: dev.siteKey || null, state: ev.state, stateRaw: down ? ev.raw : null,
      bpsIn: ev.inBps, bpsOut: ev.outBps, bgp: ev.bgp, bandwidthBps: facts.bandwidthBps,
      utilPct: ev.utilPct == null ? null : Math.round(ev.utilPct * 10) / 10,
      series24h: [...buckets.values()].sort((a, b) => a.epoch - b.epoch),
    });
  }
  const rank = { critical: 0, warning: 1, unknown: 2, ok: 3 };
  return out.sort((a, b) => rank[a.state] - rank[b.state] || String(a.name).localeCompare(String(b.name)));
}

module.exports = { cloudIssues, cloudCircuits, isDownValue, parseBandwidth, kindOfDev, deviceFacts, KINDS };
