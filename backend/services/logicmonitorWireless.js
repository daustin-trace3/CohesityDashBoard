// LogicMonitor wireless model (derived platforms, round 2): Cisco WLC controllers, access points, radios and SSIDs
// from the wireless DataSources. Moved out of routes/logicmonitor.js so the LogicMonitor routes (every vendor,
// devices owned by a present derived platform excluded) and the Cisco platform (vendorKeys ['cisco','meraki'],
// through the connector feeds) share one model. Every function takes the db handle and an optional scope
// { vendorKeys, excludeOwned, registry }; nothing writes. The model is memoized per db state and scope; callers
// must not mutate what it returns.
const { memoByDbState } = require('../core/dbMemo');
const lmIssues = require('./logicmonitorIssues');
const lb = require('./logicmonitorLoadBalancers');
const S = require('./logicmonitorFamilyShared');

const { lookups, deviceOut, openIssues, issuesOnDevice, stateFromIssues } = lb;
const {
  rnd1, pctOnly, epochToIso, devBase, maxEpoch, rowsOf, num, emptyDv, deviceSeries, counterRates, roleDevices, roleDevice, scopeClause,
} = S;
const { nowSec } = S;

const WLC_WHERE = `(d.role = 'wireless' OR d.vendor_kind = 'wireless' OR EXISTS (
  SELECT 1 FROM lm_ds_metrics m WHERE m.source_id = d.source_id AND m.lm_device_id = d.lm_device_id AND m.family = 'wireless'))`;
const PROFILE_KEYS = { load: 'radio_load_profile', noise: 'radio_noise_profile', interference: 'radio_interference_profile', coverage: 'radio_coverage_profile' };
const BANDS = ['2.4 GHz', '5 GHz', '5/6 GHz'];
const profileText = (v) => (v == null ? null : Math.round(v) === 1 ? 'pass' : Math.round(v) === 2 ? 'fail' : String(Math.round(v)));
const sumOf = (list, pick) => list.reduce((s, x) => s + (Number(pick(x)) || 0), 0);
const anyVal = (list, pick) => list.some((x) => pick(x) != null);
const wlcPlatform = (r) => (/C9800|9800/i.test(`${r.model || ''} ${r.sysinfo || ''}`) ? 'Catalyst 9800' : /AIR-CT|Cisco Controller/i.test(`${r.model || ''} ${r.sysinfo || ''}`) ? 'AireOS' : (r.vendor || null));

/** Radios of one controller as page rows. */
function radioRowsOf(dev, ctrl, util) {
  const L = lmIssues;
  const out = [];
  const seen = new Set();
  for (const inst of dev.instances.values()) {
    if (inst.ds !== 'Cisco_Wireless_AccessPointRadio' || seen.has(inst.key)) continue;
    seen.add(inst.key);
    const v = (k) => (inst.m[k] ? inst.m[k].value : null);
    const slot = L.slotOfRadio(inst.key);
    const disabled = L.isDisabled(v('radio_admin'));
    const oper = v('radio_oper');
    out.push({
      ...ctrl,
      radio: inst.name,
      ap: L.apOfRadio(inst.key),
      slot,
      band: L.bandOfSlot(slot),
      // Counted in totals and alerts: enabled, client-serving slot.
      counted: !disabled && L.isClientSlot(slot),
      state: disabled ? 'disabled' : L.radioIsUp(oper) ? 'up' : L.radioIsDown(oper) ? 'down' : 'unknown',
      channelUtilPct: rnd1(v('radio_util_pct')),
      rxUtilPct: rnd1(v('radio_rx_util_pct')),
      txUtilPct: rnd1(v('radio_tx_util_pct')),
      clients: v('radio_clients'),
      txPowerLevel: v('radio_tx_power'),
      loadProfile: profileText(v('radio_load_profile')),
      noiseProfile: profileText(v('radio_noise_profile')),
      interferenceProfile: profileText(v('radio_interference_profile')),
      coverageProfile: profileText(v('radio_coverage_profile')),
      hot: v('radio_util_pct') != null && v('radio_util_pct') >= util,
    });
  }
  return out;
}

/** AP ethernet ports of one controller grouped by AP name. */
function apPortsOf(dev) {
  const L = lmIssues;
  const byAp = new Map();
  for (const inst of dev.instances.values()) {
    if (inst.ds !== 'Cisco_Wireless_AccessPointInterfaces') continue;
    const v = (k) => (inst.m[k] ? inst.m[k].value : null);
    const ap = L.apOfIf(inst.key);
    if (!byAp.has(ap)) byAp.set(ap, []);
    byAp.get(ap).push({
      port: inst.key.slice(ap.length).replace(/^\s*-\s*/, '') || inst.key,
      state: v('apif_oper') == null ? null : Math.round(v('apif_oper')) === 1 ? 'up' : Math.round(v('apif_oper')) === 2 ? 'down' : String(Math.round(v('apif_oper'))),
      rxBps: v('apif_rx_bytes') == null ? null : v('apif_rx_bytes') * 8,
      txBps: v('apif_tx_bytes') == null ? null : v('apif_tx_bytes') * 8,
      inErrors: v('apif_in_errors'),
      outErrors: v('apif_out_errors'),
      inDrops: v('apif_in_drops'),
      outDrops: v('apif_out_drops'),
    });
  }
  return byAp;
}

/**
 * Everything the wireless pages read, built from one pass over the metric index:
 * controllers with their AP, radio and SSID rows. Filters: q, siteKey, sourceId.
 */
function buildWirelessModel(db, q = {}, scope = {}) {
  const L = lmIssues;
  const lk = lookups(db);
  const util = lmIssues.getThreshold('lm_wlan_chan_util_warn_pct');
  const devs = roleDevices(db, WLC_WHERE, q, scope);
  const index = L.loadDsIndex(db, { families: ['wireless', 'health'] });
  const missing = L.loadMissingAps(db);
  const issues = openIssues(db);
  const controllers = [];
  for (const r of devs) {
    const dk = `${r.source_id}:${r.lm_device_id}`;
    const dev = index.get(dk) || { instances: new Map(), sourceId: r.source_id, deviceId: r.lm_device_id, name: r.display_name || r.name };
    const base = devBase(r, lk);
    const ctrl = { controllerId: base.deviceId, sourceId: base.sourceId, controller: base.deviceName, siteKey: base.siteKey, siteName: base.siteName };
    const radios = radioRowsOf(dev, ctrl, util);
    const ports = apPortsOf(dev);
    const radiosByAp = new Map();
    for (const rd of radios) {
      if (!radiosByAp.has(rd.ap)) radiosByAp.set(rd.ap, []);
      radiosByAp.get(rd.ap).push(rd);
    }
    const aps = L.wirelessAps(dev, missing.get(dk)).map((a) => {
      const all = radiosByAp.get(a.key) || [];
      const rs = all.filter((x) => x.counted);
      const ps = ports.get(a.key) || [];
      const utilMax = rs.reduce((mx, x) => (x.channelUtilPct != null && (mx == null || x.channelUtilPct > mx) ? x.channelUtilPct : mx), null);
      return {
        ...ctrl,
        ap: a.name,
        apKey: a.key,
        status: a.status,
        operText: a.operText,
        adminText: a.admin == null ? null : L.isDisabled(a.admin) ? 'disabled' : 'enabled',
        since: a.since || null,
        radiosTotal: rs.length,
        radiosUp: rs.filter((x) => x.state === 'up').length,
        radiosDown: rs.filter((x) => x.state === 'down').length,
        clients: anyVal(rs, (x) => x.clients) ? sumOf(rs, (x) => x.clients) : null,
        maxChannelUtilPct: utilMax,
        util24: rs.find((x) => x.slot === 0)?.channelUtilPct ?? null,
        util5: rs.find((x) => x.slot === 1)?.channelUtilPct ?? null,
        uplinkState: ps.length ? (ps.some((p) => p.state === 'up') ? 'up' : 'down') : null,
        uplinkRxBps: anyVal(ps, (p) => p.rxBps) ? sumOf(ps, (p) => p.rxBps) : null,
        uplinkTxBps: anyVal(ps, (p) => p.txBps) ? sumOf(ps, (p) => p.txBps) : null,
        uplinkErrors: anyVal(ps, (p) => p.inErrors) ? rnd1(sumOf(ps, (p) => p.inErrors) + sumOf(ps, (p) => p.outErrors)) : null,
        sampledAt: epochToIso(a.epoch),
      };
    });
    const ssids = [];
    for (const inst of dev.instances.values()) {
      if (!inst.m.ess_clients && !inst.m.ess_admin) continue;
      const v = (k) => (inst.m[k] ? inst.m[k].value : null);
      ssids.push({
        ...ctrl, ssid: inst.name, wlan: inst.key, hdsId: inst.hds,
        enabled: v('ess_admin') == null ? null : Math.round(v('ess_admin')) === 1,
        broadcast: v('ess_broadcast') == null ? null : Math.round(v('ess_broadcast')) === 1,
        clients: v('ess_clients'),
      });
    }
    const radius = L.devInstances(dev, 'radius_status').map((i) => {
      const v = (k) => (i.m[k] ? i.m[k].value : null);
      const enabled = Math.round(v('radius_status')) === 1;
      const answered = (v('radius_accepts') || 0) + (v('radius_rejects') || 0) + (v('radius_challenges') || 0);
      return {
        server: i.name, enabled, networkUsers: v('radius_network_user') == null ? null : Math.round(v('radius_network_user')) === 1,
        requests: v('radius_requests'), accepts: v('radius_accepts'), rejects: v('radius_rejects'), challenges: v('radius_challenges'),
        timeouts: v('radius_timeouts'), retransmissions: v('radius_retransmissions'), pending: v('radius_pending'),
        state: !enabled ? 'disabled' : (v('radius_timeouts') || 0) > 0 && answered === 0 ? 'unresponsive' : 'ok',
      };
    });
    const ha = L.devVal(dev, 'wlc_ha_peer_ok');
    const primary = L.devVal(dev, 'wlc_primary_unit');
    const mob = L.devVal(dev, 'wlc_mobility_status');
    const essClients = anyVal(ssids, (s) => s.clients) ? sumOf(ssids, (s) => s.clients) : null;
    const radioClients = anyVal(radios, (x) => x.clients) ? sumOf(radios, (x) => x.clients) : null;
    const counted = radios.filter((x) => x.counted);
    const upRadios = counted.filter((x) => x.state === 'up' && x.channelUtilPct != null);
    const devIssues = issuesOnDevice(issues, base.deviceName);
    const managed = aps.filter((a) => a.status !== 'disabled');
    const cpu = L.devMax(dev, 'cpu_pct');
    controllers.push({
      dev,
      r,
      issues: devIssues,
      radios,
      aps,
      ssids,
      radius,
      row: {
        ...base,
        platform: wlcPlatform(r),
        haText: ha != null ? (Math.round(ha) === 1 ? 'hot standby' : 'degraded') : primary != null ? (Math.round(primary) === 1 ? 'primary' : 'secondary') : null,
        haDegraded: ha != null && Math.round(ha) === 0,
        cpuPct: cpu ? rnd1(cpu.value) : null,
        memPct: rnd1(L.devMax(dev, 'mem_pct')?.value),
        tempC: rnd1(L.devVal(dev, 'temp_c')),
        apsTotal: managed.length,
        apsUp: managed.filter((a) => a.status === 'up' || a.status === 'downloading').length,
        apsDown: managed.filter((a) => L.apIsDown(a)).length,
        apsDisabled: aps.length - managed.length,
        apAvailablePct: (() => { const v = L.devVal(dev, 'wlc_ap_available_pct'); return v == null || v < 0 ? null : rnd1(v); })(),
        radiosTotal: counted.length,
        radiosUp: counted.filter((x) => x.state === 'up').length,
        radiosDown: counted.filter((x) => x.state === 'down').length,
        radiosDisabled: radios.filter((x) => x.state === 'disabled').length,
        radiosAux: radios.filter((x) => !L.isClientSlot(x.slot)).length,
        hotRadios: radios.filter((x) => x.hot).length,
        avgChannelUtilPct: upRadios.length ? rnd1(sumOf(upRadios, (x) => x.channelUtilPct) / upRadios.length) : null,
        clients: essClients ?? L.devVal(dev, 'wlc_clients') ?? radioClients,
        clientsMax: L.devVal(dev, 'wlc_clients_max'),
        clientUsagePct: rnd1(L.devVal(dev, 'wlc_client_usage_pct')),
        ssids: ssids.length,
        radiusServers: radius.length,
        radiusUnresponsive: radius.filter((x) => x.state === 'unresponsive').length,
        mobility: mob == null ? null : Math.round(mob) === 0 ? 'ok' : Math.round(mob) === 1 ? 'tunnels down' : 'check error',
        state: stateFromIssues(devIssues, dev.instances.size > 0),
        sampledAt: epochToIso(maxEpoch(dev)),
      },
    });
  }
  return { controllers, util };
}

/** Memoized wireless model: { controllers, util }. A scope with a test registry is never memoized. */
function wirelessModel(db, q = {}, scope = {}) {
  if (scope.registry) return buildWirelessModel(db, q, scope);
  const sc = scopeClause(db, scope);
  const key = `lmWirelessModel|${sc.key}|${q.q || ''}|${q.siteKey || ''}|${q.sourceId || ''}|${q.vendor || ''}`;
  return memoByDbState(db, key, () => buildWirelessModel(db, q, scope));
}

function clientTrend(db, hours = 24, filter = {}) {
  const since = nowSec() - hours * 3600;
  const step = 1800;
  const where = ["metric = 'ess_clients'", 'sampled_at_epoch >= ?'];
  const args = [since];
  if (filter.sourceId) { where.push('source_id = ?'); args.push(filter.sourceId); }
  if (filter.deviceId) { where.push('lm_device_id = ?'); args.push(filter.deviceId); }
  let rows = [];
  try {
    rows = db.prepare(`SELECT source_id, lm_device_id, hds_id, instance_key, sampled_at_epoch e, value v FROM lm_ds_metrics_history WHERE ${where.join(' AND ')} ORDER BY sampled_at_epoch`).all(...args);
  } catch { return { total: [], bySeries: new Map() }; }
  const buckets = new Map();
  for (const r of rows) {
    const b = Math.floor(r.e / step) * step;
    if (!buckets.has(b)) buckets.set(b, new Map());
    buckets.get(b).set(`${r.source_id}:${r.lm_device_id}|${r.hds_id}|${r.instance_key}`, r.v);
  }
  const last = new Map();
  const total = [];
  const bySeries = new Map();
  for (const b of [...buckets.keys()].sort((a, c) => a - c)) {
    for (const [k, v] of buckets.get(b)) last.set(k, v);
    let sum = 0;
    for (const [k, v] of last) {
      sum += v;
      if (!bySeries.has(k)) bySeries.set(k, []);
      bySeries.get(k).push({ epoch: b, value: v });
    }
    total.push({ epoch: b, value: sum });
  }
  return { total, bySeries };
}

function histogram(values, edges = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]) {
  const out = edges.map((lo, i) => ({ bucket: `${lo}-${edges[i + 1] ?? 100}%`, count: 0 }));
  for (const v of values) {
    if (v == null) continue;
    let i = edges.length - 1;
    while (i > 0 && v < edges[i]) i -= 1;
    out[i].count += 1;
  }
  return out;
}

function ssidSummary(controllers) {
  const by = new Map();
  for (const c of controllers) {
    for (const s of c.ssids) {
      const k = s.ssid;
      const e = by.get(k) || { ssid: k, clients: 0, controllers: 0, enabledOn: 0, broadcast: null, hasClients: false };
      e.controllers += 1;
      if (s.enabled) e.enabledOn += 1;
      if (s.broadcast != null) e.broadcast = (e.broadcast || false) || s.broadcast;
      if (s.clients != null) { e.clients += s.clients; e.hasClients = true; }
      by.set(k, e);
    }
  }
  return [...by.values()].map(({ hasClients, ...e }) => ({ ...e, clients: hasClients ? e.clients : null })).sort((a, b) => (b.clients || 0) - (a.clients || 0));
}


/** The GET /wireless/overview payload. opts: q, siteKey, sourceId + the scope. */
function wirelessOverview(db, opts = {}) {
  const { controllers, util } = wirelessModel(db, opts, opts);
  const aps = controllers.flatMap((c) => c.aps);
  const radios = controllers.flatMap((c) => c.radios);
  const rows = controllers.map((c) => c.row);
  const managed = aps.filter((a) => a.status !== 'disabled');
  const byBand = BANDS.map((band) => {
    const rs = radios.filter((x) => x.band === band && x.counted);
    const up = rs.filter((x) => x.state === 'up' && x.channelUtilPct != null);
    return {
      band,
      radios: rs.length,
      up: rs.filter((x) => x.state === 'up').length,
      clients: anyVal(rs, (x) => x.clients) ? sumOf(rs, (x) => x.clients) : null,
      avgChannelUtilPct: up.length ? rnd1(sumOf(up, (x) => x.channelUtilPct) / up.length) : null,
      hot: rs.filter((x) => x.hot).length,
    };
  }).filter((b) => b.radios > 0);
  const bySite = new Map();
  for (const c of rows) {
    const k = c.siteName || c.siteKey || 'Unassigned';
    const e = bySite.get(k) || { site: k, controllers: 0, aps: 0, apsDown: 0, clients: 0 };
    e.controllers += 1; e.aps += c.apsTotal; e.apsDown += c.apsDown; e.clients += c.clients || 0;
    bySite.set(k, e);
  }
  const trend = clientTrend(db, 24, { sourceId: opts.sourceId });
  const bandsTotal = byBand.reduce((s, b) => s + (b.clients || 0), 0);
  return {
    totals: {
      controllers: rows.length,
      controllersDegraded: rows.filter((c) => c.state === 'critical' || c.state === 'warning').length,
      aps: managed.length,
      apsUp: managed.filter((a) => a.status === 'up' || a.status === 'downloading').length,
      apsDown: managed.filter((a) => ['down', 'silent', 'missing'].includes(a.status)).length,
      radios: radios.filter((x) => x.counted).length,
      radiosDown: radios.filter((x) => x.counted && x.state === 'down').length,
      hotRadios: radios.filter((x) => x.hot).length,
      clients: rows.some((c) => c.clients != null) ? sumOf(rows, (c) => c.clients) : null,
      ssids: ssidSummary(controllers).length,
      radiusUnresponsive: sumOf(rows, (c) => c.radiusUnresponsive),
    },
    controllers: rows,
    analytics: {
      byBand: byBand.map((b) => ({ ...b, clientSharePct: bandsTotal && b.clients != null ? rnd1((b.clients / bandsTotal) * 100) : null })),
      bySite: [...bySite.values()].sort((a, b) => b.clients - a.clients),
      bySsid: ssidSummary(controllers).slice(0, 12),
      busiestAps: [...aps].filter((a) => a.clients != null).sort((a, b) => b.clients - a.clients).slice(0, 10),
      hottestRadios: [...radios].filter((x) => x.channelUtilPct != null).sort((a, b) => b.channelUtilPct - a.channelUtilPct).slice(0, 10),
      downAps: aps.filter((a) => ['down', 'silent', 'missing'].includes(a.status)).slice(0, 50),
      channelUtilThresholdPct: util,
    },
    clientTrend: trend.total,
  };
}

/** Controller rows (the GET /wireless/controllers shape). */
function listControllers(db, opts = {}) {
  return wirelessModel(db, opts, opts).controllers.map((c) => c.row);
}

/** The controller 360 payload (GET /wireless/controllers/:deviceId), or null. opts: deviceId, sourceId + the scope. */
function controllerDetail(db, opts = {}) {
  const r = roleDevice(db, WLC_WHERE, opts.deviceId, opts.sourceId, opts);
  if (!r) return null;
  const c = wirelessModel(db, { sourceId: r.source_id }, opts).controllers.find((x) => x.r.lm_device_id === r.lm_device_id);
  if (!c) return null;
  const L = lmIssues;
  const dev = c.dev;
  const val = (k) => L.devVal(dev, k);
  const byBand = BANDS.map((band) => {
    const rs = c.radios.filter((x) => x.band === band && x.counted);
    const up = rs.filter((x) => x.state === 'up' && x.channelUtilPct != null);
    return { band, radios: rs.length, up: rs.filter((x) => x.state === 'up').length, down: rs.filter((x) => x.state === 'down').length,
      clients: anyVal(rs, (x) => x.clients) ? sumOf(rs, (x) => x.clients) : null, avgChannelUtilPct: up.length ? rnd1(sumOf(up, (x) => x.channelUtilPct) / up.length) : null, hot: rs.filter((x) => x.hot).length };
  }).filter((b) => b.radios > 0);
  const acct = L.devInstances(dev, 'acct_status').map((i) => ({
    server: i.name, enabled: Math.round(i.m.acct_status.value) === 1,
    requests: i.m.acct_requests ? i.m.acct_requests.value : null, responses: i.m.acct_responses ? i.m.acct_responses.value : null, timeouts: i.m.acct_timeouts ? i.m.acct_timeouts.value : null,
  }));
  const cpuSeries = deviceSeries(db, dev, 'cpu_pct', 24);
  const trend = clientTrend(db, 24, { sourceId: r.source_id, deviceId: r.lm_device_id });
  return {
    device: deviceOut(r, lookups(db)),
    summary: c.row,
    bands: byBand,
    aps: c.aps,
    ssids: [...c.ssids].sort((a, b) => (b.clients || 0) - (a.clients || 0)),
    radius: { auth: c.radius, accounting: acct },
    connections: {
      clients: val('wlc_clients'), clientsMax: val('wlc_clients_max'), clientUsagePct: rnd1(val('wlc_client_usage_pct')),
      apsJoined: val('wlc_aps_joined'), apAssocFailedPerSec: val('wlc_ap_assoc_failed'), abnormalOfflineRate: val('wlc_abnormal_offline'),
    },
    mobility: {
      status: c.row.mobility, handoffsPerSec: val('mob_handoffs'), requestsPerSec: val('mob_handoff_requests'),
      errorsPerSec: val('mob_handoff_errors'), deniedPerSec: val('mob_handoff_denied'), droppedPerSec: val('mob_handoff_dropped'),
    },
    dhcp: {
      proxy: val('dhcp_proxy') == null ? null : Math.round(val('dhcp_proxy')) === 1, discoverPerSec: val('dhcp_discover'), offerPerSec: val('dhcp_offer'),
      ackPerSec: val('dhcp_ack'), nakPerSec: val('dhcp_nak'), txFailuresPerSec: val('dhcp_tx_failures'),
    },
    cpuHistory: cpuSeries,
    clientHistory: trend.total,
    issues: c.issues,
  };
}

/** AP rows (the GET /wireless/aps shape). */
function listAps(db, opts = {}) {
  return wirelessModel(db, opts, opts).controllers.flatMap((c) => c.aps);
}

/** The AP 360 payload (GET /wireless/ap): { ap, radios, ports, issues }, or { missing: 'controller' | 'ap' }. opts: controllerId, sourceId, apKey + the scope. */
function apDetail(db, opts = {}) {
  const r = roleDevice(db, WLC_WHERE, opts.controllerId, opts.sourceId, opts);
  if (!r) return { missing: 'controller' };
  const c = wirelessModel(db, { sourceId: r.source_id }, opts).controllers.find((x) => x.r.lm_device_id === r.lm_device_id);
  const ap = c && c.aps.find((a) => a.apKey === opts.apKey);
  if (!ap) return { missing: 'ap' };
  const ports = apPortsOf(c.dev).get(ap.apKey) || [];
  const radios = c.radios.filter((x) => x.ap === ap.apKey).sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99));
  const pre = `${c.row.deviceName} ${ap.apKey}`;
  const issues = c.issues.filter((i) => { const t = String(i.target || ''); return t === pre || t.startsWith(`${pre}:`) || t.startsWith(`${pre} - `); });
  return { ap, radios, ports, issues };
}

/** Radio rows (the CSV rows of GET /wireless/rf.csv). */
function listRadios(db, opts = {}) {
  return wirelessModel(db, opts, opts).controllers.flatMap((c) => c.radios);
}

/** The GET /wireless/rf payload { thresholdPct, bands, radios }. */
function rfTable(db, opts = {}) {
  const { controllers, util } = wirelessModel(db, opts, opts);
  const radios = controllers.flatMap((c) => c.radios);
  const bands = BANDS.map((band) => {
    const inBand = radios.filter((x) => x.band === band);
    const rs = inBand.filter((x) => x.counted);
    const up = rs.filter((x) => x.state === 'up');
    const profiles = Object.fromEntries(Object.keys(PROFILE_KEYS).map((p) => [p, rs.filter((x) => x[`${p}Profile`] === 'fail').length]));
    const power = new Map();
    for (const x of up) if (x.txPowerLevel != null) power.set(x.txPowerLevel, (power.get(x.txPowerLevel) || 0) + 1);
    return {
      band,
      radios: rs.length,
      up: up.length,
      down: rs.filter((x) => x.state === 'down').length,
      disabled: inBand.filter((x) => x.state === 'disabled').length,
      clients: anyVal(rs, (x) => x.clients) ? sumOf(rs, (x) => x.clients) : null,
      avgChannelUtilPct: up.length && anyVal(up, (x) => x.channelUtilPct) ? rnd1(sumOf(up, (x) => x.channelUtilPct) / up.filter((x) => x.channelUtilPct != null).length) : null,
      avgRxUtilPct: up.length && anyVal(up, (x) => x.rxUtilPct) ? rnd1(sumOf(up, (x) => x.rxUtilPct) / up.filter((x) => x.rxUtilPct != null).length) : null,
      avgTxUtilPct: up.length && anyVal(up, (x) => x.txUtilPct) ? rnd1(sumOf(up, (x) => x.txUtilPct) / up.filter((x) => x.txUtilPct != null).length) : null,
      hot: rs.filter((x) => x.hot).length,
      utilHistogram: histogram(up.map((x) => x.channelUtilPct)),
      txPower: [...power.entries()].sort((a, b) => a[0] - b[0]).map(([level, count]) => ({ level, count })),
      profileFailures: profiles,
    };
  }).filter((b) => b.radios > 0);
  return { thresholdPct: util, bands, radios };
}

/** The GET /wireless/ssids payload { summary, rows, trend }. */
function ssidTable(db, opts = {}) {
  const { controllers } = wirelessModel(db, opts, opts);
  const rows = controllers.flatMap((c) => c.ssids);
  const summary = ssidSummary(controllers);
  const trend = clientTrend(db, 24, { sourceId: opts.sourceId });
  // Per-SSID trend: WLAN series are keyed by device, hds and instance key; map them to SSID names.
  const nameOf = new Map(rows.map((s) => [`${s.sourceId}:${s.controllerId}|${s.hdsId}|${s.wlan}`, s.ssid]));
  const bySsid = new Map();
  for (const [k, pts] of trend.bySeries) {
    const name = nameOf.get(k);
    if (!name) continue;
    const cur = bySsid.get(name) || new Map();
    for (const p of pts) cur.set(p.epoch, (cur.get(p.epoch) || 0) + p.value);
    bySsid.set(name, cur);
  }
  const top = summary.slice(0, 6).map((s) => s.ssid);
  return {
    summary,
    rows: rows.map(({ hdsId, ...s }) => s),
    trend: {
      total: trend.total,
      bySsid: top.filter((n) => bySsid.has(n)).map((n) => ({ ssid: n, points: [...bySsid.get(n).entries()].sort((a, b) => a[0] - b[0]).map(([epoch, value]) => ({ epoch, value })) })),
    },
  };
}

module.exports = {
  WLC_WHERE, BANDS, wirelessModel, clientTrend, wirelessOverview, listControllers, controllerDetail, listAps, apDetail, listRadios, rfTable, ssidTable,
};
