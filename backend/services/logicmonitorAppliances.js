// Voice, Zscaler and Cisco ISE appliances seen through LogicMonitor (round 11, WP-V).
//
// Metric families (logicmonitorCatalog.js): 'voice' (Oracle SBC, Cisco CUBE SIP counters, GANC
// checks) and 'security' (Cisco ISE, Zscaler ZPA connectors, ASA license). This file turns those
// rows into issues and into the per-device facts the Voice, Zscaler and ISE pages read:
//
//   voice-sbc-degraded         warning   SBC health, fan or power supply state reads not healthy
//   voice-sip-errors           warning   SIP client plus server error counters grow over 1 per second on a CUBE
//   ise-cert-expiring          warning / critical  certificate days left under lm_cert_warn_days / under 7
//   ise-node-down              critical  a deployment node or the ISE application reads down
//   zpa-connector-down         critical  a ZPA app connector reads down
//   zpa-port-exhaustion        warning   ZPA port use at or over lm_fw_session_warn_pct
//   asa-license-unauthorized   warning   the ASA license authorization state reads not authorized
//
// ALL datapoint names and state enums are UNVERIFIED against a live portal (the ntm_* DataSources
// are customer-written). Every message prints the raw value so a wrong guess is visible. Where a
// state polarity is unknown (0 = ok or 0 = down) the rule learns it from the estate: the most
// common value of that metric is taken as healthy, so a metric that reads 0 everywhere raises
// nothing instead of flagging every node.

const { isDownValue } = require('./logicmonitorCohesity');

const fmtNum = (v) => (v == null ? 'n/a' : Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10));
const rnd1 = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10) / 10);

// Fixed rule constants (no new settings keys this round).
const SIP_ERR_PER_SEC = 1; // client plus server SIP errors per second on one CUBE
const ISE_CERT_CRIT_DAYS = 7;
const SBC_SCORE_MIN = 70; // only used when the health datapoint is named like a score or percent
const SIP_WINDOW_SEC = 3 * 3600;

const SIP_SERVER_METRICS = ['sip_server_int_error', 'sip_server_unavailable', 'sip_server_gw_timeout', 'sip_server_errors'];
const SIP_CLIENT_METRICS = ['sip_client_bad_request', 'sip_client_unauthorized', 'sip_client_not_found', 'sip_client_errors'];

// -- Small readers over loadDsIndex() devices ----------------------------------

function insts(dev, metric) {
  const out = [];
  for (const i of dev.instances.values()) if (i.m[metric] && i.m[metric].value != null) out.push(i);
  return out;
}
const first = (dev, metric) => {
  const hit = insts(dev, metric)[0];
  return hit ? hit.m[metric].value : null;
};
function maxOf(dev, metric) {
  let best = null;
  for (const i of insts(dev, metric)) if (best == null || i.m[metric].value > best) best = i.m[metric].value;
  return best;
}
const sumOf = (dev, metric) => {
  const list = insts(dev, metric);
  return list.length ? list.reduce((s, i) => s + i.m[metric].value, 0) : null;
};
const byName = (a, b) => String(a.name).localeCompare(String(b.name));
const dsOf = (dev, re) => [...dev.instances.values()].filter((i) => re.test(i.ds));

/** Device kind in the voice family, from the DataSources it carries. */
function voiceKind(dev) {
  let sbc = false; let ganc = false; let cube = false;
  for (const i of dev.instances.values()) {
    if (/^ntm_sbc_/i.test(i.ds)) sbc = true;
    else if (/^ntm_ganc_/i.test(i.ds)) ganc = true;
    else if (/^Cisco_SIP_/i.test(i.ds) || /^ISDN_Channels$/i.test(i.ds)) cube = true;
  }
  return sbc ? 'sbc' : ganc ? 'ganc' : cube ? 'cube' : null;
}

/**
 * Value that counts as the healthy one for a state metric across the estate: the mode of every
 * instance value (ties go to the smaller number). Used where the polarity of 0 is unknown.
 */
function modeMap(index, metrics) {
  const counts = new Map();
  for (const dev of index.values()) {
    for (const i of dev.instances.values()) {
      for (const m of metrics) {
        const v = i.m[m] && i.m[m].value;
        if (v == null) continue;
        const k = `${m}|${Math.round(v)}`;
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
  }
  const best = new Map();
  for (const [k, n] of counts) {
    const [m, vs] = k.split('|');
    const v = Number(vs);
    const cur = best.get(m);
    if (!cur || n > cur.n || (n === cur.n && v < cur.v)) best.set(m, { v, n });
  }
  return new Map([...best].map(([m, x]) => [m, x.v]));
}

/**
 * A status metric reads down. Value 0 is down only when the estate majority reads non-zero; a
 * metric whose majority is 0 is taken as 0 = ok and flags any non-zero value instead only when it
 * is negative (script error), which is never reported as down.
 */
function readsDown(v, mode) {
  if (v == null) return false;
  if (mode === 0) return false; // majority reads 0: polarity looks like 0 = ok, so nothing is provably down
  return isDownValue(v);
}

/** SBC and license style state reads not healthy: 3 or more, negative, or a low score. */
function stateBad(v, datapoint) {
  if (v == null || !Number.isFinite(Number(v))) return false;
  const n = Number(v);
  if (/score|percent|pct/i.test(datapoint || '')) return n < SBC_SCORE_MIN;
  return n >= 3 || n < 0;
}

// -- SIP error rate from history ---------------------------------------------------

/** Per-second growth of the SIP error counters of a device: { server, client } (null when no history). */
function sipErrorRates(dbh, dev, nowSec = Math.floor(Date.now() / 1000)) {
  const metrics = [...SIP_SERVER_METRICS, ...SIP_CLIENT_METRICS];
  let rows = [];
  try {
    rows = dbh.prepare(`
      SELECT hds_id, instance_key, metric, sampled_at_epoch e, value v FROM lm_ds_metrics_history
      WHERE source_id = ? AND lm_device_id = ? AND metric IN (${metrics.map(() => '?').join(',')}) AND sampled_at_epoch >= ?
      ORDER BY sampled_at_epoch
    `).all(dev.sourceId, dev.deviceId, ...metrics, nowSec - SIP_WINDOW_SEC);
  } catch { return { server: null, client: null }; }
  const series = new Map();
  for (const r of rows) {
    const k = `${r.hds_id}|${r.instance_key}|${r.metric}`;
    if (!series.has(k)) series.set(k, []);
    series.get(k).push(r);
  }
  let server = null; let client = null;
  for (const [k, pts] of series) {
    if (pts.length < 2) continue;
    const span = pts[pts.length - 1].e - pts[0].e;
    if (span <= 0) continue;
    let grow = 0;
    for (let i = 1; i < pts.length; i += 1) if (pts[i].v >= pts[i - 1].v) grow += pts[i].v - pts[i - 1].v; // a reset adds nothing
    const rate = grow / span;
    const metric = k.split('|')[2];
    if (SIP_SERVER_METRICS.includes(metric)) server = (server || 0) + rate;
    else client = (client || 0) + rate;
  }
  return { server, client };
}

// -- Issues ------------------------------------------------------------------------

/**
 * Issue rows for computeMetricIssues. index = loadDsIndex() output. Devices in scheduled
 * downtime raise nothing.
 */
function applianceIssues(dbh, t, srcName, index) {
  const issues = [];
  if (!index || !index.size) return issues;
  const fold = t.lm_tunnel_fold;
  const certWarn = t.lm_cert_warn_days;
  const portWarn = t.lm_fw_session_warn_pct;
  const modes = modeMap(index, ['connector_state', 'node_state', 'app_state']);

  for (const dev of index.values()) {
    if (dev.sdt) continue;
    const source = srcName.get(dev.sourceId);
    const name = dev.name;
    const push = (severity, type, target, message) => issues.push({ severity, type, source, target, message });
    const all = [...dev.instances.values()];
    if (!all.some((i) => i.family === 'voice' || i.family === 'security')) continue;

    // Oracle SBC: health, fans, power supplies.
    const bad = [];
    for (const [metric, label] of [['sbc_health_state', 'health'], ['sbc_fan_state', 'fan'], ['sbc_psu_state', 'power supply']]) {
      for (const i of insts(dev, metric)) {
        const m = i.m[metric];
        if (stateBad(m.value, m.datapoint)) bad.push({ i, metric, label, v: m.value, dp: m.datapoint });
      }
    }
    if (bad.length > fold) {
      push('warning', 'voice-sbc-degraded', `${name} (${bad.length} components)`,
        `${bad.length} SBC components on ${name} are not healthy (first ${bad.slice(0, 3).map((b) => `${b.label} ${b.i.name}`).join(', ')}; raw ${fmtNum(bad[0].v)}, enum unverified)`);
    } else {
      for (const b of bad) {
        push('warning', 'voice-sbc-degraded', b.label === 'health' ? name : `${name} ${b.i.name}`,
          `SBC ${b.label === 'health' ? 'health' : b.i.name} on ${name} is not healthy: ${b.metric.replace(/_/g, ' ')} reads ${fmtNum(b.v)}${b.dp ? ` (${b.dp})` : ''} (enum unverified; 3 or more, or a score under ${SBC_SCORE_MIN}, counts as not healthy)`);
      }
    }

    // CUBE SIP errors.
    if (voiceKind(dev) === 'cube') {
      const r = sipErrorRates(dbh, dev);
      const total = (r.server || 0) + (r.client || 0);
      if ((r.server != null || r.client != null) && total > SIP_ERR_PER_SEC) {
        push('warning', 'voice-sip-errors', name,
          `SIP errors on ${name} are growing at ${fmtNum(rnd1(total))} per second (server ${fmtNum(rnd1(r.server || 0))}, client ${fmtNum(rnd1(r.client || 0))}; threshold ${SIP_ERR_PER_SEC} per second over 3 hours)`);
      }
    }

    // ISE certificates.
    for (const [metric, label] of [['cert_days', 'certificate'], ['eap_cert_days', 'EAP certificate']]) {
      for (const i of insts(dev, metric)) {
        const days = i.m[metric].value;
        if (days < certWarn) {
          const crit = days < ISE_CERT_CRIT_DAYS;
          push(crit ? 'critical' : 'warning', 'ise-cert-expiring', `${name} ${label} ${i.name}`,
            days < 0
              ? `ISE ${label} ${i.name} on ${name} expired ${fmtNum(Math.abs(days))} days ago`
              : `ISE ${label} ${i.name} on ${name} expires in ${fmtNum(days)} days (${crit ? `critical under ${ISE_CERT_CRIT_DAYS}` : `warning under ${certWarn}`} days)`);
        }
      }
    }

    // ISE nodes and application.
    for (const [metric, what] of [['node_state', 'deployment node'], ['app_state', 'application']]) {
      for (const i of insts(dev, metric)) {
        const v = i.m[metric].value;
        if (readsDown(v, modes.get(metric))) {
          push('critical', 'ise-node-down', `${name} ${i.name}`,
            `ISE ${what} ${i.name} on ${name} is down: ${metric.replace(/_/g, ' ')} reads ${fmtNum(v)} (enum unverified; read from the estate majority)`);
        }
      }
    }

    // ZPA connectors and port exhaustion.
    for (const i of insts(dev, 'connector_state')) {
      const v = i.m.connector_state.value;
      if (readsDown(v, modes.get('connector_state'))) {
        push('critical', 'zpa-connector-down', `${name} ${i.name}`,
          `ZPA app connector ${name} is down: connector state reads ${fmtNum(v)} (enum unverified; read from the estate majority)`);
      }
    }
    for (const i of insts(dev, 'port_used_pct')) {
      const v = i.m.port_used_pct.value;
      if (v >= portWarn) {
        push('warning', 'zpa-port-exhaustion', `${name} ${i.name}`,
          `ZPA connector ${name} has used ${fmtNum(rnd1(v))}% of its ports (threshold ${portWarn}%)`);
      }
    }

    // ASA license.
    for (const i of insts(dev, 'asa_license_state')) {
      const m = i.m.asa_license_state;
      if (stateBad(m.value, m.datapoint)) {
        push('warning', 'asa-license-unauthorized', `${name} ${i.name}`,
          `ASA ${name} license authorization reads ${fmtNum(m.value)} (enum unverified; 3 or more counts as not authorized)`);
      }
    }
  }
  return issues;
}

// -- Facts for the pages ---------------------------------------------------------------

/** SBC facts from the voice family. */
function sbcFacts(dev) {
  const health = insts(dev, 'sbc_health_state')[0];
  const fans = insts(dev, 'sbc_fan_state');
  const psus = insts(dev, 'sbc_psu_state');
  const pools = [...dev.instances.values()].filter((i) => i.m.sbc_pool_util_pct || i.m.sbc_pool_sessions || i.m.sbc_pool_failures);
  const badOf = (list, metric) => list.filter((i) => stateBad(i.m[metric].value, i.m[metric].datapoint)).length;
  return {
    healthRaw: health ? health.m.sbc_health_state.value : null,
    healthBad: health ? stateBad(health.m.sbc_health_state.value, health.m.sbc_health_state.datapoint) : null,
    cpuPct: rnd1(maxOf(dev, 'sbc_cpu_pct')),
    memPct: rnd1(maxOf(dev, 'sbc_mem_pct')),
    fans: fans.length,
    fansBad: badOf(fans, 'sbc_fan_state'),
    psus: psus.length,
    psusBad: badOf(psus, 'sbc_psu_state'),
    tempMaxC: rnd1(maxOf(dev, 'sbc_temp_c')),
    pools: pools.length,
    poolUtilMaxPct: rnd1(maxOf(dev, 'sbc_pool_util_pct')),
    poolSessions: sumOf(dev, 'sbc_pool_sessions'),
    poolFailures: sumOf(dev, 'sbc_pool_failures'),
    retransmissions: sumOf(dev, 'sbc_retransmissions'),
    localConnectionRaw: first(dev, 'sbc_local_connection_state'),
  };
}

/** CUBE facts: connections and SIP error rates. */
function cubeFacts(dbh, dev) {
  const tcp = sumOf(dev, 'sip_active_tcp');
  const udp = sumOf(dev, 'sip_active_udp');
  const conns = tcp == null && udp == null ? sumOf(dev, 'sip_connections') : (tcp || 0) + (udp || 0);
  const r = sipErrorRates(dbh, dev);
  return {
    sipConnections: conns,
    sipServerErrPerSec: rnd1(r.server),
    sipClientErrPerSec: rnd1(r.client),
    sipErrPerSec: r.server == null && r.client == null ? null : rnd1((r.server || 0) + (r.client || 0)),
    sipRetries: sumOf(dev, 'sip_retry_invites'),
    isdnBusy: sumOf(dev, 'isdn_busy'),
  };
}

/** GANC facts: mobility and ISE RADIUS check plus the wireless SSIDs and RADIUS servers it carries. */
function gancFacts(dev) {
  const ess = [...dev.instances.values()].filter((i) => i.m.ess_clients || i.m.ess_admin);
  const radius = [...dev.instances.values()].filter((i) => i.m.radius_status);
  return {
    mobilityRaw: first(dev, 'ganc_mobility_state'),
    radiusCheckRaw: first(dev, 'ganc_radius_state'),
    ssids: ess.length,
    clients: sumOf(dev, 'ess_clients'),
    radiusServers: radius.length,
    radiusServersDown: radius.filter((i) => Math.round(i.m.radius_status.value) === 0).length,
  };
}

/** ISE node facts. */
function iseFacts(dev, modes = new Map()) {
  const disks = insts(dev, 'disk_used_pct');
  const certDays = insts(dev, 'cert_days').map((i) => i.m.cert_days.value).concat(insts(dev, 'eap_cert_days').map((i) => i.m.eap_cert_days.value));
  const nodes = insts(dev, 'node_state');
  const apps = insts(dev, 'app_state');
  return {
    sessions: sumOf(dev, 'sessions'),
    diskUsedMaxPct: rnd1(maxOf(dev, 'disk_used_pct')),
    disks: disks.length,
    cpuPct: rnd1(maxOf(dev, 'cpu_pct')),
    memPct: rnd1(maxOf(dev, 'mem_pct')),
    appStateRaw: apps.length ? apps[0].m.app_state.value : null,
    appDown: apps.some((i) => readsDown(i.m.app_state.value, modes.get('app_state'))),
    certDaysMin: certDays.length ? Math.min(...certDays) : null,
    nodeStateRaw: nodes.length ? nodes[0].m.node_state.value : null,
    nodes: nodes.length,
    nodesDown: nodes.filter((i) => readsDown(i.m.node_state.value, modes.get('node_state'))).length,
  };
}

/** ZPA connector facts. */
function zpaFacts(dev, modes = new Map()) {
  const conns = insts(dev, 'connector_state');
  return {
    connectors: conns.length,
    connectorRaw: conns.length ? conns[0].m.connector_state.value : null,
    connectorDown: conns.some((i) => readsDown(i.m.connector_state.value, modes.get('connector_state'))),
    portUsedPct: rnd1(maxOf(dev, 'port_used_pct')),
    ntpOffset: first(dev, 'ntp_offset'),
    ntpStateRaw: first(dev, 'ntp_state'),
  };
}

/** NSS appliance facts: CPU and memory from the health family, filesystems from the os family when present. */
function nssFacts(dev, fsWarnPct = 85) {
  const fs = insts(dev, 'fs_used_pct');
  return {
    cpuPct: rnd1(maxOf(dev, 'cpu_pct')),
    memPct: rnd1(maxOf(dev, 'mem_pct')),
    filesystems: fs.length,
    fsUsedMaxPct: rnd1(maxOf(dev, 'fs_used_pct')),
    fsOverWarn: fs.filter((i) => i.m.fs_used_pct.value >= fsWarnPct).length,
  };
}

// -- Zscaler data centre checks -----------------------------------------------------------

const ZSDC_RE = /^ZSDC_/i;
const isZsdc = (name) => ZSDC_RE.test(String(name || ''));

/**
 * { code, city } from "ZSDC_<CODE>-<City> ...-uptime". The city is the text after the first dash
 * with a trailing "uptime" suffix removed; a name with no city falls back to the code.
 */
function zsdcCity(name) {
  const rest = String(name || '').replace(ZSDC_RE, '');
  const dash = rest.indexOf('-');
  const code = (dash < 0 ? rest : rest.slice(0, dash)).trim().toUpperCase();
  let city = dash < 0 ? '' : rest.slice(dash + 1);
  city = city.replace(/[\s-]*uptime\s*$/i, '').replace(/[\s-]+$/, '').trim();
  return { code, city: city || code };
}

module.exports = {
  applianceIssues, sipErrorRates, voiceKind, modeMap, readsDown, stateBad,
  sbcFacts, cubeFacts, gancFacts, iseFacts, zpaFacts, nssFacts,
  isZsdc, zsdcCity, byName, dsOf,
  SIP_ERR_PER_SEC, ISE_CERT_CRIT_DAYS,
};
