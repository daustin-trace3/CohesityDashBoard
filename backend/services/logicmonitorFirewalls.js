// LogicMonitor firewall model (derived platforms, round 2). Moved out of routes/logicmonitor.js so the LogicMonitor
// routes (every vendor, devices owned by a present derived platform excluded) and the Cisco platform (vendorKeys
// ['cisco','meraki'], through the connector feeds) assemble the same rows and the same 360 payload.
// Every function takes the db handle and an optional scope { vendorKeys, excludeOwned, registry }; nothing writes.
const { memoByDbState } = require('../core/dbMemo');
const lmIssues = require('./logicmonitorIssues');
const lb = require('./logicmonitorLoadBalancers');
const S = require('./logicmonitorFamilyShared');

const { lookups, deviceOut, openIssues, issuesOnDevice, stateFromIssues } = lb;
const {
  rnd1, pctOnly, epochToIso, devBase, maxEpoch, rowsOf, num, emptyDv, deviceSeries, counterRates, roleDevices, roleDevice, scopeClause,
} = S;

// ISE nodes carry role firewall on CG; once the vendor classifier has typed one as ISE it is not a firewall.
const FW_WHERE = `((d.role = 'firewall' OR d.vendor LIKE 'Palo Alto%' OR EXISTS (
  SELECT 1 FROM lm_ds_metrics m WHERE m.source_id = d.source_id AND m.lm_device_id = d.lm_device_id AND m.family = 'firewall'))
  AND COALESCE(d.vendor_kind, '') <> 'ise')`;

const fwBool = (v) => (v == null ? null : Math.round(v) === 1);

function firewallRow(r, lk, dev, issues, rates) {
  const L = lmIssues;
  const dv = dev || { instances: new Map(), sourceId: r.source_id, deviceId: r.lm_device_id, name: r.display_name || r.name };
  const name = r.display_name || r.name;
  const haEnabledRaw = L.devVal(dv, 'ha_enabled');
  const haLocalRaw = L.devVal(dv, 'ha_local_state');
  const haPeerRaw = L.devVal(dv, 'ha_peer_state');
  const haOn = L.isHaEnabled(haEnabledRaw, haLocalRaw, haPeerRaw);
  const haLocal = L.haText(haLocalRaw);
  const haPeer = L.haText(haPeerRaw);
  const act = L.devVal(dv, 'sessions_active');
  const max = L.devVal(dv, 'sessions_max');
  let util = L.devVal(dv, 'sessions_util_pct');
  if (util == null && act != null && max) util = (act / max) * 100;
  const core = L.devMax(dv, 'core_cpu_pct');
  const mgmt = L.devVal(dv, 'mgmt_cpu_pct') ?? L.devVal(dv, 'asa_cpu_pct') ?? L.devVal(dv, 'cpu_pct');
  const mem = L.devVal(dv, 'mem_pct') ?? L.devVal(dv, 'asa_mem_pct');
  const tunnels = L.devInstances(dv, 'tunnel_state');
  let tUp = L.devVal(dv, 'tunnels_up');
  let tDown = L.devVal(dv, 'tunnels_down');
  if (tUp == null && tDown == null && tunnels.length) {
    tDown = tunnels.filter((i) => L.tunnelIsDown(i.m.tunnel_state.value)).length;
    tUp = tunnels.length - tDown;
  }
  const dk = `${r.source_id}:${r.lm_device_id}`;
  const devIssues = issuesOnDevice(issues, name);
  const hasData = dv.instances.size > 0;
  return {
    ...devBase(r, lk),
    haEnabled: hasData ? haOn : null,
    haLocalState: haLocal,
    haPeerState: haPeer,
    haLocalRaw: haLocalRaw == null ? null : Math.round(haLocalRaw),
    haPeerRaw: haPeerRaw == null ? null : Math.round(haPeerRaw),
    haText: !hasData || (haLocalRaw == null && haPeerRaw == null) ? null : (haOn ? `${haLocal || 'n/a'} / ${haPeer || 'n/a'}` : 'off'),
    sessionsActive: act,
    sessionsMax: max,
    sessionsUtilPct: pctOnly(util),
    dataplaneCpuPct: core ? pctOnly(core.value) : null,
    mgmtCpuPct: pctOnly(mgmt),
    memPct: pctOnly(mem),
    tunnelsUp: tUp,
    tunnelsDown: tDown,
    gpUsers: L.devVal(dv, 'gp_users_active'),
    configSynced: fwBool(L.devVal(dv, 'config_synced')),
    threatsPerHour: rates && rates.threats.has(dk) ? rnd1(rates.threats.get(dk)) : null,
    droppedPerMin: rates && rates.dropped.has(dk) ? rnd1(rates.dropped.get(dk)) : null,
    state: stateFromIssues(devIssues, hasData),
    sampledAt: epochToIso(maxEpoch(dv)),
  };
}

/** Firewall rows (the GET /firewalls shape). opts: q, siteKey, vendor, sourceId, state + the scope. */
function listFirewalls(db, opts = {}) {
  const lk = lookups(db);
  const devs = roleDevices(db, FW_WHERE, opts, opts);
  const index = lmIssues.loadDsIndex(db, { families: ['firewall', 'health'], devices: devs });
  const issues = openIssues(db);
  const rates = { threats: counterRates(db, 'threats_total', 3600), dropped: counterRates(db, 'dropped', 60) };
  let rows = devs.map((r) => firewallRow(r, lk, index.get(`${r.source_id}:${r.lm_device_id}`), issues, rates));
  if (opts.state) rows = rows.filter((r) => r.state === opts.state);
  return rows;
}

/** The firewall 360 payload (the GET /firewalls/:deviceId shape), or null when the device is not one in this scope. */
function firewallDetail(db, opts = {}) {
  const { deviceId, sourceId } = opts;
  const r = roleDevice(db, FW_WHERE, deviceId, sourceId, opts);
  if (!r) return null;
  const L = lmIssues;
  const lk = lookups(db);
  const idx = L.loadDsIndex(db, { sourceId: r.source_id, deviceId: r.lm_device_id });
  const dev = idx.get(`${r.source_id}:${r.lm_device_id}`) || { instances: new Map(), sourceId: r.source_id, deviceId: r.lm_device_id, name: r.display_name || r.name };
  const issues = openIssues(db);
  const rates = { threats: counterRates(db, 'threats_total', 3600), dropped: counterRates(db, 'dropped', 60) };
  const summary = firewallRow(r, lk, dev, issues, rates);
  const byKey = (a, b) => String(a.name).localeCompare(String(b.name));
  const ifState = (v) => (v == null ? null : (Math.round(v) === 1 ? 'up' : Math.round(v) === 0 ? 'down' : String(Math.round(v))));
  const ha = rowsOf(dev, 'ha_if_state').map((i) => ({ name: i.name, state: ifState(num(i, 'ha_if_state')), raw: num(i, 'ha_if_state') })).sort(byKey);
  const tunnels = rowsOf(dev, 'tunnel_state').map((i) => ({
    name: i.name,
    state: L.tunnelIsDown(num(i, 'tunnel_state')) ? 'down' : 'up',
    stateRaw: num(i, 'tunnel_state'),
    inBps: num(i, 'tunnel_in_bps'),
    outBps: num(i, 'tunnel_out_bps'),
  })).sort((a, b) => (a.state === b.state ? byKey(a, b) : a.state === 'down' ? -1 : 1));
  const zoneInst = [...dev.instances.values()].filter((i) => i.m.zone_sessions || i.m.zone_in_bps || i.m.zone_out_bps);
  const zones = zoneInst
    .map((i) => ({ name: i.name, inBps: num(i, 'zone_in_bps'), outBps: num(i, 'zone_out_bps'), sessions: num(i, 'zone_sessions') })).sort(byKey);
  const vsys = rowsOf(dev, 'vsys_sessions').map((i) => ({ name: i.name, sessions: num(i, 'vsys_sessions'), utilPct: rnd1(num(i, 'vsys_util_pct')) })).sort(byKey);
  const gateways = rowsOf(dev, 'gp_users_active').map((i) => ({ name: i.name, users: num(i, 'gp_users_active'), maxUsers: num(i, 'gp_users_max'), tunnels: num(i, 'gp_tunnels') })).sort(byKey);
  const logForwarding = rowsOf(dev, 'log_forwarded').map((i) => ({ name: i.name, forwarded: num(i, 'log_forwarded'), dropped: num(i, 'log_dropped') })).sort(byKey);
  const hardware = {
    disks: rowsOf(dev, 'disk_used_pct').map((i) => ({ name: i.name, usedPct: rnd1(num(i, 'disk_used_pct')) })).sort(byKey),
    psus: [...new Map([...rowsOf(dev, 'psu_state'), ...rowsOf(dev, 'psu_low_alarm'), ...rowsOf(dev, 'psu_high_alarm')].map((i) => [i.name, i])).values()].map((i) => {
      const alarm = (num(i, 'psu_low_alarm') || 0) + (num(i, 'psu_high_alarm') || 0);
      const st = num(i, 'psu_state');
      return { name: i.name, state: st != null ? st : alarm, ok: !(L.stateIsFault(st) || alarm >= 1), voltage: rnd1(num(i, 'cur_voltage')) };
    }).sort(byKey),
    temps: rowsOf(dev, 'temp_c').map((i) => ({ name: i.name, tempC: rnd1(num(i, 'temp_c')), alarm: i.m.temp_alarm ? Math.round(i.m.temp_alarm.value) !== 0 : null })).sort(byKey),
    chassisWatts: L.devVal(dev, 'chassis_watts'),
  };
  const bgp = rowsOf(dev, 'bgp_peer_state').map((i) => ({
    name: i.name, state: num(i, 'bgp_peer_state'), established: Math.round(num(i, 'bgp_peer_state')) === 6, prefixes: num(i, 'bgp_prefixes'),
  })).sort(byKey);
  const ospf = rowsOf(dev, 'ospf_nbr_state').map((i) => ({ name: i.name, state: num(i, 'ospf_nbr_state'), full: Math.round(num(i, 'ospf_nbr_state')) === 8 })).sort(byKey);
  const name = r.display_name || r.name;
  return {
    device: deviceOut(r, lk),
    summary,
    ha,
    tunnels,
    zones,
    vsys,
    globalProtect: {
      users: L.devVal(dev, 'gp_users_active'), maxUsers: L.devVal(dev, 'gp_users_max'), tunnels: L.devVal(dev, 'gp_tunnels'), gateways,
    },
    logForwarding,
    hardware,
    routing: { bgp, ospf },
    sessionsHistory: { utilPct: deviceSeries(db, dev, 'sessions_util_pct', 24), active: deviceSeries(db, dev, 'sessions_active', 24) },
    issues: issuesOnDevice(issues, name),
  };
}

module.exports = { FW_WHERE, firewallRow, listFirewalls, firewallDetail };
