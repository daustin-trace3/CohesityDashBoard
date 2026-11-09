// LogicMonitor hardware health for the derived platforms (Cisco, F5): one row per component from the latest
// metric table, plus derived findings (redundancy lost, thermal outliers by model and site, switchovers).
// Pure of the db singleton and read-only.
//
// State mapping per metric (UNVERIFIED enums are noted; every row carries the raw value):
//   psu_state, fan_state, temp_state: 1 ok, 5 not present (unknown). Via lmIssues.stateIsFault for the Cisco enum.
//     F5 vendor: 1 good, 2 not present (unknown), anything else failed (F5 MIB: 0 bad, 1 good, 2 notPresent).
//   sup_state, sup1_state, sup2_state, linecard_state: Nexus redundancy enum, healthy 1, 2, 5, 9, 14 (see stateIsFault).
//   sensor_state: entPhySensorOperStatus 1 ok, 2 unavailable (unknown), 3 nonoperational (failed). Only rows that
//     are not ok are listed (Cisco_Entity_Sensors holds every optic and chassis sensor).
//   stack_member_state: cswSwitchState 4 ready or 9 provisioned ok, 1 waiting, 2 progressing, 8 newMasterInit degraded,
//     anything else failed.
//   stack_port_state: cswStackPortOperStatus 1 up ok, 2 down or 3 forcedDown failed, anything else unknown (UNVERIFIED).
//   temp_c: a gauge; the row state is ok and the outlier logic below judges it.
const fleet = require('./logicmonitorFleet');
const lmIssues = require('./logicmonitorIssues');

const DAY_MS = 86400000;
const dayOfMs = (ms) => new Date(ms).toISOString().slice(0, 10);
const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);

const HW_COMPONENT = {
  psu_state: 'psu', fan_state: 'fan', temp_c: 'temp', temp_state: 'temp', sensor_state: 'sensor', linecard_state: 'linecard',
  sup_state: 'supervisor', sup1_state: 'supervisor', sup2_state: 'supervisor', stack_member_state: 'stack_member', stack_port_state: 'stack_port',
};
const HW_METRICS = Object.keys(HW_COMPONENT);

function stateOf(metric, v, vendorKey) {
  if (v == null || !Number.isFinite(Number(v))) return 'unknown';
  const n = Math.round(Number(v));
  if (metric === 'temp_c') return 'ok';
  if (metric === 'sensor_state') return n === 1 ? 'ok' : n === 2 ? 'unknown' : 'failed';
  if (metric === 'stack_member_state') return [4, 9].includes(n) ? 'ok' : [1, 2, 8].includes(n) ? 'degraded' : 'failed';
  if (metric === 'stack_port_state') return n === 1 ? 'ok' : (n === 2 || n === 3) ? 'failed' : 'unknown';
  if (vendorKey === 'f5' && (metric === 'psu_state' || metric === 'fan_state')) return n === 1 ? 'ok' : n === 2 ? 'unknown' : 'failed';
  if ((metric === 'psu_state' || metric === 'fan_state' || metric === 'temp_state') && n === 5) return 'unknown';
  return lmIssues.stateIsFault(n, metric) ? 'failed' : 'ok';
}

/** Component rows, worst first: { device, site, model, component, instance, state, value, unit, sampledAt, ... ids }. */
function components(dbh, p = {}) {
  const devs = fleet.loadDevices(dbh, p);
  if (!devs.size) return [];
  const args = [...HW_METRICS];
  const keys = fleet.vendorKeysOf(p);
  const rows = dbh.prepare(`
    SELECT m.source_id, m.lm_device_id, m.hds_id, m.instance_key, i.instance_name, m.metric, m.value, m.sampled_at_epoch
    FROM lm_ds_metrics m
    JOIN lm_devices d ON d.source_id = m.source_id AND d.lm_device_id = m.lm_device_id AND d.stale = 0
    LEFT JOIN lm_ds_instances i ON i.source_id = m.source_id AND i.lm_device_id = m.lm_device_id AND i.hds_id = m.hds_id AND i.instance_key = m.instance_key
    WHERE m.metric IN (${HW_METRICS.map(() => '?').join(',')}) AND COALESCE(i.stale, 0) = 0
      ${keys ? `AND d.vendor_key IN (${keys.map(() => '?').join(',')})` : ''}
    ${p.deviceId != null && p.deviceId !== '' ? 'AND m.lm_device_id = ?' : ''}
  `).all(...args, ...(keys || []), ...(p.deviceId != null && p.deviceId !== '' ? [Number(p.deviceId)] : []));
  const out = [];
  for (const r of rows) {
    const d = devs.get(`${r.source_id}:${r.lm_device_id}`);
    if (!d) continue;
    const state = stateOf(r.metric, r.value, d.vendorKey);
    if (r.metric === 'sensor_state' && state === 'ok') continue;
    out.push({
      sourceId: d.sourceId, deviceId: d.deviceId, device: d.device, site: d.site, model: d.model, vendorKey: d.vendorKey,
      component: HW_COMPONENT[r.metric], metric: r.metric, instance: r.instance_name || r.instance_key, state,
      value: r.value, unit: r.metric === 'temp_c' ? 'C' : '', sampledAt: r.sampled_at_epoch ? new Date(r.sampled_at_epoch * 1000).toISOString() : null,
    });
  }
  const rank = { failed: 0, degraded: 1, unknown: 2, ok: 3 };
  out.sort((a, b) => rank[a.state] - rank[b.state] || String(a.device).localeCompare(String(b.device)) || String(a.instance).localeCompare(String(b.instance)));
  return out;
}

const mad = (arr, m) => fleet.median(arr.map((v) => Math.abs(v - m)));

/**
 * Derived findings from the component rows: redundancyLost, thermalOutliers (hotter than the model's or the site's
 * median by more than 2 MAD, with a 0.5 C floor on the MAD), switchovers30d (state_change trend findings).
 */
function derived(dbh, p = {}, rowsIn) {
  const rows = rowsIn || components(dbh, p);
  const devs = fleet.loadDevices(dbh, p);
  const up = (r) => { const d = devs.get(`${r.sourceId}:${r.deviceId}`); return d && d.hostStatus !== 'dead' && d.hostStatus !== 'dead-collector'; };
  const byDev = new Map();
  for (const r of rows) {
    const k = `${r.sourceId}:${r.deviceId}`;
    if (!byDev.has(k)) byDev.set(k, []);
    byDev.get(k).push(r);
  }

  const redundancyLost = [];
  for (const [k, list] of byDev) {
    const d = devs.get(k);
    if (!d || !up(list[0])) continue;
    const reasons = [];
    const psus = list.filter((r) => r.metric === 'psu_state');
    if (psus.length >= 2 && psus.filter((r) => r.state === 'ok').length === 1) reasons.push(`one of ${psus.length} power supplies ok`);
    const sups = list.filter((r) => r.metric === 'sup_state');
    if (sups.length >= 2 && sups.filter((r) => r.state === 'ok').length === 1) reasons.push(`one of ${sups.length} supervisors ok`);
    const s1 = list.filter((r) => r.metric === 'sup1_state'); const s2 = list.filter((r) => r.metric === 'sup2_state');
    if (s1.length && s2.length) {
      const bad1 = s1.some((r) => r.state === 'failed'); const bad2 = s2.some((r) => r.state === 'failed');
      if (bad1 !== bad2) reasons.push(`supervisor ${bad1 ? 1 : 2} not ok`);
    }
    const ports = list.filter((r) => r.metric === 'stack_port_state' && r.state === 'failed');
    if (ports.length) reasons.push(`stack ring open (${ports.map((r) => r.instance).join(', ')})`);
    for (const r of list.filter((x) => x.metric === 'stack_member_state' && x.state !== 'ok' && x.state !== 'unknown')) reasons.push(`stack member ${r.instance} ${r.state}`);
    if (reasons.length) redundancyLost.push({ sourceId: d.sourceId, deviceId: d.deviceId, device: d.device, site: d.site, reason: reasons.join('; ') });
  }

  // Thermal: each device's hottest temp_c sensor against its model and its site.
  const hottest = [];
  for (const [k, list] of byDev) {
    const d = devs.get(k);
    const temps = list.filter((r) => r.metric === 'temp_c' && Number.isFinite(Number(r.value)));
    if (!d || !temps.length) continue;
    const top = temps.reduce((a, b) => (Number(b.value) > Number(a.value) ? b : a));
    hottest.push({ d, sensor: top.instance, temp: Number(top.value) });
  }
  const groupStats = (keyFn) => {
    const g = new Map();
    for (const h of hottest) { const key = keyFn(h); if (key == null) continue; if (!g.has(key)) g.set(key, []); g.get(key).push(h.temp); }
    const out = new Map();
    for (const [key, vals] of g) if (vals.length >= 3) { const m = fleet.median(vals); out.set(key, { median: m, mad: Math.max(0.5, mad(vals, m)) }); }
    return out;
  };
  const model = groupStats((h) => h.d.model);
  const site = groupStats((h) => h.d.site);
  const flagged = [];
  for (const h of hottest) {
    const ms = h.d.model ? model.get(h.d.model) : null;
    const ss = h.d.site ? site.get(h.d.site) : null;
    const hotModel = ms && h.temp > ms.median + 2 * ms.mad;
    const hotSite = ss && h.temp > ss.median + 2 * ss.mad;
    if (!hotModel && !hotSite) continue;
    flagged.push({
      sourceId: h.d.sourceId, deviceId: h.d.deviceId, device: h.d.device, site: h.d.site, sensor: h.sensor, tempC: r1(h.temp),
      modelMedian: ms ? r1(ms.median) : null, modelMad: ms ? r1(ms.mad) : null, siteMedian: ss ? r1(ss.median) : null, siteMad: ss ? r1(ss.mad) : null,
      suspectedSiteHvac: false,
    });
  }
  const perSite = new Map();
  for (const f of flagged) perSite.set(f.site, (perSite.get(f.site) || 0) + 1);
  for (const f of flagged) f.suspectedSiteHvac = !!f.site && perSite.get(f.site) >= 3;
  flagged.sort((a, b) => b.tempC - a.tempC);

  // Switchovers: state changes of stack role, supervisors and failover state in the last 30 days.
  const switchovers30d = [];
  if (fleet.tableExists(dbh, 'lm_trend_findings')) {
    const cut = dayOfMs(Date.now() - 30 * DAY_MS);
    for (const r of dbh.prepare("SELECT source_id, lm_device_id, subject, metric, detail_json FROM lm_trend_findings WHERE kind = 'state_change' AND metric IN ('stack_role', 'sup_state', 'sup1_state', 'sup2_state', 'failover_state')").all()) {
      const d = devs.get(`${r.source_id}:${r.lm_device_id}`);
      if (!d) continue;
      let days = [];
      try { days = (JSON.parse(r.detail_json).days || []).filter((x) => x >= cut); } catch { days = []; }
      if (!days.length) continue;
      switchovers30d.push({ sourceId: d.sourceId, deviceId: d.deviceId, device: d.device, site: d.site, subject: r.subject, metric: r.metric, count: days.length, days, lastChangeDay: days[days.length - 1] });
    }
    switchovers30d.sort((a, b) => b.count - a.count);
  }
  return { redundancyLost, thermalOutliers: flagged, switchovers30d };
}

module.exports = { components, derived, stateOf, HW_METRICS };
