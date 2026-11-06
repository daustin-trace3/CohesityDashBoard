// LogicMonitor voice model (derived platforms, round 2): SBC, CUBE and GANC devices from the voice DataSources.
// Moved out of routes/logicmonitor.js so the LogicMonitor routes (every vendor, devices owned by a present derived
// platform excluded) and the Cisco platform (through the connector feeds) share one model. Every function takes
// the db handle and an optional scope { vendorKeys, excludeOwned, registry }; nothing writes. Datapoint names
// and state enums behind these rows are UNVERIFIED; raw values travel next to every derived flag.
const { memoByDbState } = require('../core/dbMemo');
const lmIssues = require('./logicmonitorIssues');
const lb = require('./logicmonitorLoadBalancers');
const S = require('./logicmonitorFamilyShared');

const { lookups, deviceOut, openIssues, issuesOnDevice, stateFromIssues } = lb;
const {
  rnd1, pctOnly, epochToIso, devBase, maxEpoch, rowsOf, num, emptyDv, deviceSeries, counterRates, roleDevices, roleDevice, scopeClause,
} = S;
const lmAppliances = require('./logicmonitorAppliances');

const dsLike = (...prefixes) => prefixes.map((p) => `x.datasource_name LIKE '${p.replace(/_/g, '\\_')}%' ESCAPE '\\'`).join(' OR ');
const hasDs = (cond) => `EXISTS (SELECT 1 FROM lm_device_datasources x WHERE x.source_id = d.source_id AND x.lm_device_id = d.lm_device_id AND (${cond}))`;
const hasFamily = (fam) => `EXISTS (SELECT 1 FROM lm_ds_metrics m WHERE m.source_id = d.source_id AND m.lm_device_id = d.lm_device_id AND m.family = '${fam}')`;
const VOICE_WHERE = `(${hasDs(`${dsLike('ntm_sbc_', 'Cisco_SIP_', 'ntm_ganc_')} OR x.datasource_name = 'ISDN_Channels'`)} OR ${hasFamily('voice')})`;
const metricMeta = (dsName, metric) => {
  let e = null;
  try { e = require('./logicmonitorCatalog').catalogFor(dsName); } catch { e = null; }
  const m = e && e.metrics && e.metrics[metric];
  return { unit: (m && m.unit) || '', kind: (m && m.kind) || null, label: (m && m.label) || metric };
};

const FAMS_VOICE = ['voice', 'wireless'];


const VOICE_BLANK = {
  healthRaw: null, healthBad: null, cpuPct: null, memPct: null, fans: null, fansBad: null, psus: null, psusBad: null, tempMaxC: null,
  pools: null, poolUtilMaxPct: null, poolSessions: null, poolFailures: null, retransmissions: null, localConnectionRaw: null,
  sipConnections: null, sipServerErrPerSec: null, sipClientErrPerSec: null, sipErrPerSec: null, sipRetries: null, isdnBusy: null,
  mobilityRaw: null, radiusCheckRaw: null, ssids: null, clients: null, radiusServers: null, radiusServersDown: null,
};

function voiceKindOf(r, dv) {
  const k = lmAppliances.voiceKind(dv);
  if (k) return k;
  const n = String(r.display_name || r.name || '');
  return /sbc/i.test(n) ? 'sbc' : /ganc/i.test(n) ? 'ganc' : 'cube';
}

function voiceRow(db, r, lk, dev, issues) {
  const A = lmAppliances;
  const dv = dev || emptyDv(r);
  const name = r.display_name || r.name;
  const kind = voiceKindOf(r, dv);
  const facts = kind === 'sbc' ? A.sbcFacts(dv) : kind === 'ganc' ? A.gancFacts(dv) : A.cubeFacts(db, dv);
  const devIssues = issuesOnDevice(issues, name);
  return {
    ...devBase(r, lk),
    kind,
    ...VOICE_BLANK,
    ...facts,
    openIssues: devIssues.length,
    state: stateFromIssues(devIssues, dv.instances.size > 0),
    sampledAt: epochToIso(maxEpoch(dv)),
  };
}

const VOICE_COLUMNS = ['deviceName', 'kind', 'siteName', 'vendor', 'model', 'version', 'hostStatus', 'healthRaw', 'cpuPct', 'memPct', 'fans', 'fansBad', 'psus', 'psusBad',
  'tempMaxC', 'pools', 'poolUtilMaxPct', 'poolSessions', 'poolFailures', 'retransmissions', 'sipConnections', 'sipServerErrPerSec', 'sipClientErrPerSec', 'ssids', 'clients',
  'mobilityRaw', 'radiusCheckRaw', 'radiusServers', 'radiusServersDown', 'openIssues', 'state', 'sampledAt'];

function listVoice(db, q = {}) {
  const lk = lookups(db);
  const devs = roleDevices(db, VOICE_WHERE, q, q);
  const index = lmIssues.loadDsIndex(db, { families: FAMS_VOICE });
  const issues = openIssues(db);
  let rows = devs.map((r) => voiceRow(db, r, lk, index.get(`${r.source_id}:${r.lm_device_id}`), issues));
  if (q.state) rows = rows.filter((r) => r.state === q.state);
  if (q.kind) rows = rows.filter((r) => r.kind === q.kind);
  return rows;
}

function metricRowsOf(dev, pick, cap = 400) {
  const out = [];
  for (const i of dev.instances.values()) {
    if (!pick(i)) continue;
    for (const [mk, m] of Object.entries(i.m)) {
      const meta = metricMeta(i.ds, mk);
      out.push({ datasource: i.ds, instance: i.name, metric: mk, label: meta.label, unit: meta.unit, value: m.value, datapoint: m.datapoint });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/** The voice 360 payload (GET /voice/:deviceId), or null. opts: deviceId, sourceId + the scope. */
function voiceDetail(db, opts = {}) {
  const r = roleDevice(db, VOICE_WHERE, opts.deviceId, opts.sourceId, opts);
  if (!r) return null;
  const A = lmAppliances;
  const lk = lookups(db);
  const idx = lmIssues.loadDsIndex(db, { sourceId: r.source_id, deviceId: r.lm_device_id });
  const dev = idx.get(`${r.source_id}:${r.lm_device_id}`) || emptyDv(r);
  const issues = openIssues(db);
  const summary = voiceRow(db, r, lk, dev, issues);
  const byKey = (a, b) => String(a.name).localeCompare(String(b.name));
  const stateOf = (i, metric) => ({ name: i.name, raw: num(i, metric), bad: A.stateBad(num(i, metric), i.m[metric].datapoint) });
  const fans = rowsOf(dev, 'sbc_fan_state').map((i) => stateOf(i, 'sbc_fan_state')).sort(byKey);
  const psus = rowsOf(dev, 'sbc_psu_state').map((i) => stateOf(i, 'sbc_psu_state')).sort(byKey);
  const temps = rowsOf(dev, 'sbc_temp_c').map((i) => ({ name: i.name, tempC: rnd1(num(i, 'sbc_temp_c')) })).sort(byKey);
  const pools = [...dev.instances.values()].filter((i) => i.m.sbc_pool_util_pct || i.m.sbc_pool_sessions || i.m.sbc_pool_failures)
    .map((i) => ({ name: i.name, utilPct: rnd1(num(i, 'sbc_pool_util_pct')), sessions: num(i, 'sbc_pool_sessions'), failures: num(i, 'sbc_pool_failures') })).sort(byKey);
  const ssids = [...dev.instances.values()].filter((i) => i.m.ess_clients || i.m.ess_admin)
    .map((i) => ({ name: i.name, clients: num(i, 'ess_clients'), adminRaw: num(i, 'ess_admin') })).sort(byKey);
  const radius = rowsOf(dev, 'radius_status').map((i) => ({
    name: i.name, enabled: Math.round(num(i, 'radius_status')) === 1, requests: num(i, 'radius_requests'), rejects: num(i, 'radius_rejects'), timeouts: num(i, 'radius_timeouts'),
  })).sort(byKey);
  const sip = metricRowsOf(dev, (i) => /^Cisco_SIP_/i.test(i.ds) || /^ISDN_Channels$/i.test(i.ds));
  return {
    device: deviceOut(r, lk),
    summary,
    fans,
    psus,
    temps,
    pools,
    ssids,
    radius,
    sip,
    history: { cpuPct: deviceSeries(db, dev, 'sbc_cpu_pct', 24), memPct: deviceSeries(db, dev, 'sbc_mem_pct', 24) },
    issues: issuesOnDevice(issues, r.display_name || r.name),
  };
}

module.exports = { VOICE_WHERE, VOICE_BLANK, FAMS_VOICE, voiceRow, listVoice, voiceDetail };
