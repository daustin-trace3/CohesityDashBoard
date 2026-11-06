// LogicMonitor Cisco ISE model (derived platforms, round 2): ISE nodes from the ISE DataSources. Moved out of
// routes/logicmonitor.js so the LogicMonitor routes (every vendor, devices owned by a present derived platform
// excluded) and the Cisco platform (through the connector feeds) share one model. Every function takes the db
// handle and an optional scope { vendorKeys, excludeOwned, registry }; nothing writes. DataSource and datapoint
// names behind these rows are UNVERIFIED.
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
const ISE_WHERE = `(${hasDs(`${dsLike('Cisco_ISE_', 'ntm_ise_', 'ntm_cisco_ise_')} OR x.datasource_name = 'ntm_deployment_nodes_status'`)})`;
const FAMS_SEC = ['security', 'health', 'os'];

function iseRow(r, lk, dev, issues, modes) {
  const dv = dev || emptyDv(r);
  const name = r.display_name || r.name;
  const devIssues = issuesOnDevice(issues, name);
  return {
    ...devBase(r, lk),
    ...lmAppliances.iseFacts(dv, modes),
    openIssues: devIssues.length,
    state: stateFromIssues(devIssues, dv.instances.size > 0),
    sampledAt: epochToIso(maxEpoch(dv)),
  };
}

const ISE_COLUMNS = ['deviceName', 'siteName', 'vendor', 'model', 'version', 'hostStatus', 'sessions', 'diskUsedMaxPct', 'cpuPct', 'memPct', 'appStateRaw', 'certDaysMin',
  'nodeStateRaw', 'nodes', 'nodesDown', 'openIssues', 'state', 'sampledAt'];

function listIse(db, q = {}) {
  const lk = lookups(db);
  const devs = roleDevices(db, ISE_WHERE, q, q);
  const index = lmIssues.loadDsIndex(db, { families: FAMS_SEC, devices: devs });
  const issues = openIssues(db);
  const modes = lmAppliances.modeMap(index, ['connector_state', 'node_state', 'app_state']);
  let rows = devs.map((r) => iseRow(r, lk, index.get(`${r.source_id}:${r.lm_device_id}`), issues, modes));
  if (q.state) rows = rows.filter((r) => r.state === q.state);
  return rows;
}

/** The ISE node 360 payload (GET /ise/:deviceId), or null. opts: deviceId, sourceId + the scope. */
function iseDetail(db, opts = {}) {
  const r = roleDevice(db, ISE_WHERE, opts.deviceId, opts.sourceId, opts);
  if (!r) return null;
  const A = lmAppliances;
  const lk = lookups(db);
  const idxAll = lmIssues.loadDsIndex(db, { families: FAMS_SEC });
  const dev = idxAll.get(`${r.source_id}:${r.lm_device_id}`) || emptyDv(r);
  const modes = A.modeMap(idxAll, ['connector_state', 'node_state', 'app_state']);
  const issues = openIssues(db);
  const summary = iseRow(r, lk, dev, issues, modes);
  const byKey = (a, b) => String(a.name).localeCompare(String(b.name));
  const certs = [
    ...rowsOf(dev, 'cert_days').map((i) => ({ name: i.name, kind: 'Certificate', daysLeft: num(i, 'cert_days') })),
    ...rowsOf(dev, 'eap_cert_days').map((i) => ({ name: i.name, kind: 'EAP certificate', daysLeft: num(i, 'eap_cert_days') })),
  ].sort((a, b) => (a.daysLeft - b.daysLeft) || byKey(a, b));
  const disks = rowsOf(dev, 'disk_used_pct').map((i) => ({ name: i.name, usedPct: rnd1(num(i, 'disk_used_pct')) })).sort((a, b) => (b.usedPct - a.usedPct) || byKey(a, b));
  const nodes = [
    ...rowsOf(dev, 'node_state').map((i) => ({ name: i.name, kind: 'Deployment node', raw: num(i, 'node_state'), down: A.readsDown(num(i, 'node_state'), modes.get('node_state')) })),
    ...rowsOf(dev, 'app_state').map((i) => ({ name: i.name, kind: 'Application', raw: num(i, 'app_state'), down: A.readsDown(num(i, 'app_state'), modes.get('app_state')) })),
  ].sort(byKey);
  return {
    device: deviceOut(r, lk),
    summary,
    certificates: certs,
    disks,
    nodes,
    history: { sessions: deviceSeries(db, dev, 'sessions', 24), cpuPct: deviceSeries(db, dev, 'cpu_pct', 24), memPct: deviceSeries(db, dev, 'mem_pct', 24) },
    issues: issuesOnDevice(issues, r.display_name || r.name),
  };
}

module.exports = { ISE_WHERE, FAMS_SEC, iseRow, listIse, iseDetail };
