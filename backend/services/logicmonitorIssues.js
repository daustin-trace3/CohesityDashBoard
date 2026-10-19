// Computed LogicMonitor issues (shared by routes, the manifest hooks and the
// poller) plus their lifecycle history, eonIssues.js model exactly. LM's own
// alerts are passed through separately by the manifest's collectAlerts; these
// are the ICC-derived rules from contract section 7: portal reachability,
// collector health, dead devices, interface trends, alert storms, new devices
// and the check rules from logicmonitorChecks. Issue identity is
// `type|source|target`.
const { pruneInBatches } = require('../core/dbPrune');
const db = require('../db/database');
const { getSetting } = require('./settings');
const checks = require('./logicmonitorChecks');
const { hasSdt, compareBuildStr } = require('./logicmonitorApi');
const lmPath = require('./logicmonitorPath');

// Every /config key (contract section 9), clamped on read.
const THRESHOLD_DEFS = {
  lm_if_util_warn_pct: { def: 80, min: 50, max: 100, label: 'Interface utilization warning (%)' },
  lm_if_err_warn: { def: 100, min: 1, max: 100000, label: 'Interface errors in 24 h warning' },
  lm_if_flap_warn: { def: 3, min: 1, max: 100, label: 'Interface status changes in 24 h warning' },
  lm_dead_grace_min: { def: 10, min: 0, max: 1440, label: 'Dead device grace (minutes)' },
  lm_alert_storm_count: { def: 50, min: 5, max: 10000, label: 'Alert storm (alerts in 15 min)' },
  lm_alert_retention_days: { def: 30, min: 1, max: 365, label: 'Cleared alert retention (days)' },
  lm_new_device_days: { def: 3, min: 0, max: 30, label: 'New device notice (days)' },
  lm_interface_history_days: { def: 30, min: 7, max: 90, label: 'Interface history retention (days)' },
  ...checks.CHECK_THRESHOLD_DEFS,
  // Round 3 (sites, path, suppression, circuits, interface baselines, webhook).
  lm_site_group_roots: { type: 'text', def: 'Network,Sites,Locations,Branch', maxLength: 500, label: 'Site group roots (comma list)' },
  lm_site_property: { type: 'text', def: 'site', maxLength: 120, label: 'Site device property name' },
  lm_site_from_hostname: { def: 1, min: 0, max: 1, bool: true, label: 'Derive site from hostname prefix' },
  lm_path_max_hops: { def: 6, min: 2, max: 12, label: 'Path hops from a server to the WAN edge' },
  lm_shadow_enabled: { def: 1, min: 0, max: 1, bool: true, label: 'Suppress alerts shadowed by an upstream failure' },
  lm_circuit_sat_pct: { def: 80, min: 50, max: 100, label: 'Circuit saturation p95 warning (%)' },
  lm_circuit_crit_pct: { def: 95, min: 60, max: 100, label: 'Circuit daily peak critical (%)' },
  lm_circuit_sat_days: { def: 7, min: 1, max: 30, label: 'Circuit saturation window (days)' },
  lm_if_baseline_days: { def: 7, min: 3, max: 30, label: 'Interface baseline window (days)' },
  lm_if_baseline_min_samples: { def: 48, min: 12, max: 2000, label: 'Minimum history samples per interface baseline' },
  lm_if_anomaly_k: { def: 4, min: 1, max: 10, label: 'Interface anomaly k (x MAD)' },
  lm_if_anomaly_util_min_pct: { def: 20, min: 1, max: 100, label: 'Interface utilization anomaly minimum (%)' },
  lm_if_anomaly_err_min: { def: 5, min: 1, max: 100000, label: 'Interface error anomaly minimum' },
  lm_backup_overlay_util_pct: { def: 70, min: 30, max: 100, label: 'Backup window port utilization (%)' },
  lm_wan_overrides: { type: 'text', def: '', maxLength: 2000, label: 'WAN circuit overrides (device:port, prefix ! to exclude)' },
  lm_webhook_rate_per_min: { def: 600, min: 60, max: 6000, label: 'Webhook rate limit (per minute)' },
  // Round 8 (DataSource metric collector, firewalls, load balancers, device health).
  lm_metrics_data_calls_per_tick: { def: 300, min: 20, max: 2000, label: 'Metrics tier data calls per run' },
  // Round 11: estate default for raw DataSource calls per run (a source's own raw_calls_per_tick wins; the
  // catalog-only cap above applies to sources with raw polling switched off).
  lm_raw_calls_per_tick: { def: 600, min: 50, max: 3000, label: 'Raw DataSource calls per run (estate default)' },
  lm_ds_history_days: { def: 14, min: 3, max: 90, label: 'DataSource metric history retention (days)' },
  lm_fw_session_warn_pct: { def: 80, min: 50, max: 100, label: 'Firewall session table warning (%)' },
  lm_cpu_warn_pct: { def: 85, min: 50, max: 100, label: 'Device CPU warning (%)' },
  lm_mem_warn_pct: { def: 90, min: 50, max: 100, label: 'Device memory warning (%)' },
  lm_cert_warn_days: { def: 30, min: 1, max: 365, label: 'Certificate expiry warning (days)' },
  lm_tunnel_fold: { def: 5, min: 2, max: 100, label: 'IPSec tunnels down before they fold into one issue' },
  // Cohesity via LogicMonitor (round 10).
  lm_cohesity_cap_warn_pct: { def: 80, min: 50, max: 100, label: 'Cohesity cluster capacity warning (%)' },
  lm_cohesity_cap_crit_pct: { def: 90, min: 50, max: 100, label: 'Cohesity cluster capacity critical (%)' },
  // Servers via LogicMonitor (round 11).
  lm_fs_warn_pct: { def: 85, min: 50, max: 100, label: 'Server filesystem warning (%)' },
  lm_fs_crit_pct: { def: 95, min: 50, max: 100, label: 'Server filesystem critical (%)' },
  // Wireless (Cisco WLC DataSources).
  lm_wlan_chan_util_warn_pct: { def: 70, min: 30, max: 100, label: 'Radio channel utilization warning (%)' },
  lm_wlan_client_cap_warn_pct: { def: 80, min: 50, max: 100, label: 'Controller client capacity warning (%)' },
  lm_wlan_ap_avail_warn_pct: { def: 50, min: 5, max: 100, label: 'Controller AP availability warning (%)' },
  lm_wlan_ap_fold: { def: 5, min: 2, max: 200, label: 'Wireless APs or radios before they fold into one issue' },
  // Round 9: latency watch (logicmonitorWatch.js) and anomaly hysteresis.
  lm_watch_sustain_minutes: { def: 15, min: 5, max: 120, label: 'Minutes elevated before a watch becomes degrading' },
  lm_watch_trend_windows: { def: 3, min: 2, max: 10, label: 'Rising 10 minute windows that promote a watch' },
  lm_watch_severe_ratio: { def: 2, min: 1.2, max: 10, float: true, label: 'Severe spike ratio over baseline' },
  lm_watch_clear_samples: { def: 3, min: 1, max: 20, label: 'Normal samples that close an episode' },
  lm_watch_repeat_days: { def: 7, min: 1, max: 30, label: 'Repeat window (days)' },
  lm_watch_repeat_min: { def: 3, min: 2, max: 20, label: 'One-off episodes in the window that raise a pattern' },
  lm_watch_drift_pct: { def: 25, min: 5, max: 200, label: 'Baseline drift against the reference (%)' },
  lm_watch_drift_crit_pct: { def: 50, min: 10, max: 400, label: 'Baseline drift warning (%)' },
  lm_watch_reference_days: { def: 28, min: 14, max: 90, label: 'Drift reference window (days)' },
  lm_issue_clear_absences: { def: 2, min: 1, max: 10, label: 'Polls an anomaly must be absent before its issue clears' },
  // Round 12: carrier aliases for circuit labels and operator-defined raw datapoint rules.
  lm_carrier_aliases: { type: 'text', def: '', maxLength: 2000, label: 'Carrier aliases (token=Carrier, comma list)' },
  lm_raw_rules: { type: 'text', def: '[]', maxLength: 20000, label: 'Raw datapoint rules (JSON)' },
};

/** Text settings (site roots, WAN overrides): a trimmed string, capped. */
function getTextSetting(key) {
  const d = THRESHOLD_DEFS[key];
  if (!d || d.type !== 'text') throw new Error(`unknown LogicMonitor text setting ${key}`);
  let raw;
  try { raw = getSetting(key); } catch { raw = null; }
  if (raw == null) return d.def;
  return String(raw).trim().slice(0, d.maxLength);
}

function getThreshold(key) {
  const d = THRESHOLD_DEFS[key];
  if (!d) throw new Error(`unknown LogicMonitor threshold ${key}`);
  if (d.type === 'text') return getTextSetting(key);
  let raw;
  try { raw = getSetting(key); } catch { raw = null; }
  if (raw == null || raw === '') return d.def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return d.def;
  if (d.float) return Math.min(d.max, Math.max(d.min, Math.round(n * 10) / 10));
  return Math.min(d.max, Math.max(d.min, Math.round(n)));
}

function getThresholds() {
  const out = {};
  for (const k of Object.keys(THRESHOLD_DEFS)) out[k] = getThreshold(k);
  return out;
}

/** -1 / 0 / 1 on the first two dotted parts ("39.005" vs "41.000"). */
const compareBuild = (a, b) => compareBuildStr(a, b);
const isBehind = (build, mgd) => !!(build && mgd && compareBuildStr(build, mgd) < 0);

function parseJson(v, fallback) {
  if (v == null || v === '') return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---- Round 8: DataSource metric rules -----------------------------------------
// Every enum below is UNVERIFIED (no live portal): LogicMonitor DataSources do
// not agree on one numbering, so each rule only fires on values it names. A
// number the table does not know is treated as healthy, so a mapping gap
// never raises an alarm.

// PAN-OS HA states (panSysHAState order). 4 tentative, 5 non-functional and
// 6 suspended are the unhealthy ones.
const HA_TEXT = { 0: 'unknown', 1: 'active', 2: 'passive', 3: 'initial', 4: 'tentative', 5: 'non-functional', 6: 'suspended', 7: 'active-primary', 8: 'active-secondary' };
const haText = (v) => (v == null ? null : (HA_TEXT[Math.round(v)] || String(Math.round(v))));
const isHaBadLocal = (v) => v != null && [5, 6].includes(Math.round(v));
const isHaBadPeer = (v) => v != null && [4, 5, 6].includes(Math.round(v));
/** HA is on when ha_enabled says 1, or (no ha_enabled datapoint) a state was reported. */
const isHaEnabled = (enabled, local, peer) => (enabled != null ? Math.round(enabled) === 1 : (local != null || peer != null));

// F5 sys failover: 0 unknown, 1 offline, 2 forced offline, 3 standby, 4 active.
const FAILOVER_TEXT = { 0: 'unknown', 1: 'offline', 2: 'forced offline', 3: 'standby', 4: 'active' };
const failoverText = (v) => (v == null ? null : (FAILOVER_TEXT[Math.round(v)] || 'unknown'));

// F5 object availability colour: 1 green, 2 yellow (up, with a warning), 3 red
// (down). 0, 4 and 5 (none, blue, gray) are unknown or disabled and never count as down.
const availState = (v) => {
  if (v == null) return 'unknown';
  const n = Math.round(v);
  if (n === 1) return 'up';
  if (n === 2) return 'warn';
  if (n === 3) return 'down';
  return 'unknown';
};

// Tunnel state: 0 down, anything else up or unknown.
const tunnelIsDown = (v) => v != null && Math.round(v) === 0;

// Component state metrics: 1 is ok, 5 is "not present" (an empty slot), the rest is a fault.
// Healthy enum values per state metric. Cisco redundancy MIB cRFStatusUnitState:
// 9 standbyHot and 14 active are healthy (UNVERIFIED against the live portal,
// from the MIB); every other state table here uses 1 ok and 5 normal.
// Nexus 9300 fixed chassis report the chassis itself as the line card through
// the same redundancy MIB, so StatusLineCard, StatusSup1 and StatusSup2 carry 14
// (active) on a healthy switch too; 2 is cefcModuleOperStatus ok.
const NEXUS_HEALTHY = [1, 2, 5, 9, 14];
const HEALTHY_STATES = { sup_state: NEXUS_HEALTHY, sup1_state: NEXUS_HEALTHY, sup2_state: NEXUS_HEALTHY, linecard_state: NEXUS_HEALTHY };
// Round 12: a metric named *_alarm is a flag, 0 = fine and 1 or more = alarm (Palo Alto power and temperature).
const isAlarmMetric = (metric) => typeof metric === 'string' && /_alarm$/.test(metric);
const stateIsFault = (v, metric = null) => {
  if (v == null) return false;
  if (isAlarmMetric(metric)) return Math.round(v) >= 1;
  return !(HEALTHY_STATES[metric] || [1, 5]).includes(Math.round(v));
};
// stack_member_state has its own rule (stack-member-degraded: cswSwitchState 4 ready is the healthy value).
const HW_STATE_LABELS = {
  psu_state: 'power supply', fan_state: 'fan', temp_state: 'temperature sensor',
  linecard_state: 'line card', sup_state: 'supervisor',
  psu_low_alarm: 'power supply low alarm', psu_high_alarm: 'power supply high alarm', temp_alarm: 'temperature alarm',
};

// cswSwitchState (Cisco stack member state) and cswSwitchRole.
const STACK_STATE_TEXT = { 1: 'waiting', 2: 'progressing', 3: 'added', 4: 'ready', 5: 'sdmMismatch', 6: 'verMismatch', 7: 'featureMismatch', 8: 'newMasterInit', 9: 'provisioned', 10: 'invalid', 11: 'removed' };
const stackStateText = (v) => (v == null ? null : (STACK_STATE_TEXT[Math.round(v)] || String(Math.round(v))));
const STACK_HEALTHY = [4, 9];
const STACK_ROLE_TEXT = { 1: 'master', 2: 'member', 3: 'notMember', 4: 'standby' };
const stackRoleText = (v) => (v == null ? null : (STACK_ROLE_TEXT[Math.round(v)] || String(Math.round(v))));

const fmtUptime = (sec) => {
  const mins = Math.floor(sec / 60);
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
};

/**
 * Pool name from a "pool/member:port" instance key: the text before the first
 * '/' or ':' (a leading '/' and the "Common/" partition are dropped first).
 * ASSUMPTION: LogicMonitor F5 pool member instances are named pool then member.
 */
function poolOf(key) {
  let k = String(key || '').replace(/^\/+/, '').replace(/^Common\//i, '');
  const m = k.search(/[/:]/);
  if (m > 0) k = k.slice(0, m);
  return k || String(key || '');
}

// -- Wireless (enums verified against live AireOS and Catalyst 9800 controllers) --

const AP_OPER_TEXT = { 1: 'associated', 2: 'disassociating', 3: 'downloading' };
const apOperText = (v) => (v == null ? null : (AP_OPER_TEXT[Math.round(v)] || String(Math.round(v))));
/** Radio instance key "<ap>:<slot>" -> AP name. */
const apOfRadio = (key) => String(key || '').replace(/:\d+$/, '');
const slotOfRadio = (key) => { const m = String(key || '').match(/:(\d+)$/); return m ? Number(m[1]) : null; };
// Slot 0 is 2.4 GHz and slot 1 is 5 GHz on Cisco APs; slot 2 is a second 5 GHz or a 6 GHz radio by model.
// Slot 3 and above are auxiliary (scanning, monitor) radios that serve no clients and are often down by design.
const bandOfSlot = (slot) => (slot === 0 ? '2.4 GHz' : slot === 1 ? '5 GHz' : slot === 2 ? '5/6 GHz' : slot == null ? 'Unknown' : `Aux (slot ${slot})`);
const isClientSlot = (slot) => slot == null || slot <= 2;
/** AP ethernet instance key "<ap> - <interface>" -> AP name. */
const apOfIf = (key) => String(key || '').split(' - ')[0];
const radioIsUp = (v) => v != null && Math.round(v) === 2;
const radioIsDown = (v) => v != null && Math.round(v) === 1;
const isDisabled = (v) => v != null && Math.round(v) === 2;
// An AP whose latest sample is this much older than the controller's freshest AP sample stopped reporting.
const AP_SILENT_SEC = 3 * 3600;
const AP_MISSING_HOURS = 24;

/**
 * APs that left a controller's AP table in the last AP_MISSING_HOURS (stale
 * instances, which loadDsIndex skips): Map "sourceId:deviceId" -> [{ key, name, since }].
 */
function loadMissingAps(dbh = db) {
  const out = new Map();
  try {
    for (const r of dbh.prepare(`
      SELECT source_id, lm_device_id, instance_key, instance_name, updated_at FROM lm_ds_instances
      WHERE datasource_name = 'Cisco_Wireless_AP' AND stale = 1 AND updated_at >= datetime('now', ?)
    `).all(`-${AP_MISSING_HOURS} hours`)) {
      const dk = `${r.source_id}:${r.lm_device_id}`;
      if (!out.has(dk)) out.set(dk, []);
      out.get(dk).push({ key: r.instance_key, name: r.instance_name || r.instance_key, since: r.updated_at });
    }
  } catch { /* table not migrated */ }
  return out;
}

/**
 * Every AP of one controller with a status: up, down (disassociating, silent or
 * missing), disabled or downloading. missing = loadMissingAps(...).get(devKey).
 */
function wirelessAps(dev, missing = []) {
  const insts = devInstances(dev, 'ap_oper');
  let fresh = null;
  for (const i of insts) if (i.m.ap_oper.epoch != null && (fresh == null || i.m.ap_oper.epoch > fresh)) fresh = i.m.ap_oper.epoch;
  const out = insts.map((i) => {
    const oper = i.m.ap_oper.value;
    const admin = i.m.ap_admin ? i.m.ap_admin.value : null;
    const silent = fresh != null && i.m.ap_oper.epoch != null && fresh - i.m.ap_oper.epoch > AP_SILENT_SEC;
    let status = 'up';
    if (isDisabled(admin)) status = 'disabled';
    else if (silent) status = 'silent';
    else if (Math.round(oper) === 2) status = 'down';
    else if (Math.round(oper) === 3) status = 'downloading';
    return { key: i.key, name: i.name, admin, oper, operText: apOperText(oper), status, epoch: i.m.ap_oper.epoch };
  });
  for (const m of missing || []) out.push({ key: m.key, name: m.name, admin: null, oper: null, operText: null, status: 'missing', since: m.since, epoch: null });
  return out;
}
const apIsDown = (ap) => ['down', 'silent', 'missing'].includes(ap.status);

function wirelessIssues(dev, t, push, missing) {
  const name = dev.name;
  const fold = t.lm_wlan_ap_fold;

  const ha = devVal(dev, 'wlc_ha_peer_ok');
  if (ha != null && Math.round(ha) === 0) {
    push(dev, 'critical', 'wlan-ha-degraded', name, `${name} HA peer is not in hot standby (HAPeerState 0)`);
  }

  const avail = devVal(dev, 'wlc_ap_available_pct');
  if (avail != null && avail >= 0 && avail < t.lm_wlan_ap_avail_warn_pct) {
    push(dev, avail < t.lm_wlan_ap_avail_warn_pct / 2 ? 'critical' : 'warning', 'wlan-ap-availability-low', name,
      `${name} reports ${fmtNum(avail)}% of its APs available (threshold ${t.lm_wlan_ap_avail_warn_pct}%)`);
  }

  const aps = wirelessAps(dev, missing);
  const downAps = aps.filter(apIsDown);
  if (downAps.length) {
    const managed = aps.filter((a) => a.status !== 'disabled').length;
    if (downAps.length > fold) {
      const half = managed >= 4 && downAps.length * 2 >= managed;
      push(dev, half ? 'critical' : 'warning', 'wlan-ap-down', `${name} access points`,
        `${downAps.length} of ${managed} access points down on ${name} (${downAps.slice(0, 3).map((a) => a.name).join(', ')}, ...)`);
    } else {
      for (const a of downAps) {
        const why = a.status === 'missing' ? `left the controller at ${a.since} UTC` : a.status === 'silent' ? 'stopped reporting' : `is ${a.operText}`;
        push(dev, 'warning', 'wlan-ap-down', `${name} ${a.name}`, `Access point ${a.name} on ${name} ${why}`);
      }
    }
  }

  const downApNames = new Set(downAps.map((a) => a.key));
  const radiosDown = devInstances(dev, 'radio_oper').filter((i) => radioIsDown(i.m.radio_oper.value) && isClientSlot(slotOfRadio(i.key))
    && !(i.m.radio_admin && isDisabled(i.m.radio_admin.value)) && !downApNames.has(apOfRadio(i.key)));
  if (radiosDown.length > fold) {
    push(dev, 'warning', 'wlan-radio-down', `${name} radios`,
      `${radiosDown.length} enabled radios are down on ${name} (${radiosDown.slice(0, 3).map((i) => i.name).join(', ')}, ...)`);
  } else {
    for (const i of radiosDown) {
      push(dev, 'warning', 'wlan-radio-down', `${name} ${i.name}`,
        `Radio ${i.name} (${bandOfSlot(slotOfRadio(i.key))}) on ${name} is enabled but down`);
    }
  }

  const hot = devInstances(dev, 'radio_util_pct').filter((i) => i.m.radio_util_pct.value >= t.lm_wlan_chan_util_warn_pct)
    .sort((a, b) => b.m.radio_util_pct.value - a.m.radio_util_pct.value);
  if (hot.length > fold) {
    push(dev, 'warning', 'wlan-channel-util-high', `${name} radios`,
      `${hot.length} radios on ${name} at or above ${t.lm_wlan_chan_util_warn_pct}% channel utilization (busiest ${hot.slice(0, 3).map((i) => `${i.name} ${fmtNum(i.m.radio_util_pct.value)}%`).join(', ')})`);
  } else {
    for (const i of hot) {
      push(dev, 'warning', 'wlan-channel-util-high', `${name} ${i.name}`,
        `Radio ${i.name} (${bandOfSlot(slotOfRadio(i.key))}) on ${name} at ${fmtNum(i.m.radio_util_pct.value)}% channel utilization (threshold ${t.lm_wlan_chan_util_warn_pct}%)`);
    }
  }

  const cap = devVal(dev, 'wlc_client_usage_pct');
  if (cap != null && cap >= t.lm_wlan_client_cap_warn_pct) {
    push(dev, 'warning', 'wlan-client-capacity-high', name, `${name} is at ${fmtNum(cap)}% of its client capacity (threshold ${t.lm_wlan_client_cap_warn_pct}%)`);
  }

  const mob = devVal(dev, 'wlc_mobility_status');
  if (mob != null && Math.round(mob) === 1) {
    push(dev, 'warning', 'wlan-mobility-down', name, `${name} reports mobility tunnels down in its mobility domain`);
  }

  for (const i of devInstances(dev, 'radius_status')) {
    if (Math.round(i.m.radius_status.value) !== 1) continue;
    const v = (k) => (i.m[k] ? i.m[k].value : 0);
    if (v('radius_timeouts') > 0 && v('radius_accepts') + v('radius_rejects') + v('radius_challenges') === 0) {
      push(dev, 'warning', 'wlan-radius-unresponsive', `${name} RADIUS ${i.name}`,
        `RADIUS server ${i.name} on ${name} is timing out (${fmtNum(v('radius_timeouts'))}/s) with no responses`);
    }
  }

  const errIfs = devInstances(dev, 'apif_in_errors').filter((i) => i.m.apif_in_errors.value > 1 || (i.m.apif_out_errors && i.m.apif_out_errors.value > 1));
  if (errIfs.length > fold) {
    push(dev, 'warning', 'wlan-ap-uplink-errors', `${name} AP uplinks`,
      `${errIfs.length} access point uplinks on ${name} report more than 1 error per second (${errIfs.slice(0, 3).map((i) => i.name).join(', ')}, ...)`);
  } else {
    for (const i of errIfs) {
      const inE = i.m.apif_in_errors.value;
      const outE = i.m.apif_out_errors ? i.m.apif_out_errors.value : 0;
      push(dev, 'warning', 'wlan-ap-uplink-errors', `${name} ${i.name}`,
        `Access point uplink ${i.name} on ${name} reports ${fmtNum(inE)} input and ${fmtNum(outE)} output errors per second`);
    }
  }
}

const WIRELESS_ISSUE_TYPES = [
  'wlan-ha-degraded', 'wlan-ap-availability-low', 'wlan-ap-down', 'wlan-radio-down', 'wlan-channel-util-high',
  'wlan-client-capacity-high', 'wlan-mobility-down', 'wlan-radius-unresponsive', 'wlan-ap-uplink-errors',
];

const METRIC_ISSUE_TYPES = [
  'fw-ha-degraded', 'fw-tunnel-down', 'fw-session-high', 'fw-config-unsynced',
  'lb-failover-degraded', 'lb-pool-degraded', 'lb-cert-expiring', 'lb-daemon-down',
  'device-cpu-high', 'device-memory-high', 'hardware-fault', 'bgp-peer-down', 'ospf-neighbor-down', 'optic-power-low',
  // Round 12
  'device-ping-loss', 'ntp-unsynced', 'stack-member-degraded', 'device-rebooted', 'filesystem-inaccessible', 'raw-threshold',
  'cloud-circuit-down', 'cloud-circuit-saturated',
  ...WIRELESS_ISSUE_TYPES,
];

/**
 * Latest metric rows grouped per device: Map "sourceId:deviceId" ->
 * { sourceId, deviceId, name, vendor, role, siteKey, sdt, instances: Map }.
 * An instance is { ds, hds, family, key, name, m: { metric: { value, datapoint, epoch } } }.
 * Stale instances are skipped; a metric whose instance row is missing keeps the key as its name.
 * opts.families narrows to catalog families, opts.sourceId / opts.deviceId to one device.
 */
function loadDsIndex(dbh = db, opts = {}) {
  const out = new Map();
  const where = ['COALESCE(i.stale, 0) = 0'];
  const args = [];
  if (Array.isArray(opts.families) && opts.families.length) {
    where.push(`m.family IN (${opts.families.map(() => '?').join(',')})`);
    args.push(...opts.families);
  }
  if (opts.sourceId != null) { where.push('m.source_id = ?'); args.push(opts.sourceId); }
  if (opts.deviceId != null) { where.push('m.lm_device_id = ?'); args.push(opts.deviceId); }
  let rows;
  try {
    rows = dbh.prepare(`
      SELECT m.source_id, m.lm_device_id, m.hds_id, m.datasource_name, m.family, m.instance_key, i.instance_name,
        m.metric, m.datapoint, m.value, m.sampled_at_epoch,
        d.display_name, d.name AS device_name, d.vendor, d.role, d.site_key, d.sdt_status
      FROM lm_ds_metrics m
      JOIN lm_devices d ON d.source_id = m.source_id AND d.lm_device_id = m.lm_device_id AND d.stale = 0
      LEFT JOIN lm_ds_instances i ON i.source_id = m.source_id AND i.lm_device_id = m.lm_device_id
        AND i.hds_id = m.hds_id AND i.instance_key = m.instance_key
      WHERE ${where.join(' AND ')}
    `).all(...args);
  } catch { return out; }
  for (const r of rows) {
    const dk = `${r.source_id}:${r.lm_device_id}`;
    let dev = out.get(dk);
    if (!dev) {
      dev = {
        sourceId: r.source_id, deviceId: r.lm_device_id, name: r.display_name || r.device_name,
        vendor: r.vendor, role: r.role, siteKey: r.site_key || null, sdt: hasSdt(r.sdt_status), instances: new Map(),
      };
      out.set(dk, dev);
    }
    const ik = `${r.hds_id}|${r.instance_key}`;
    let inst = dev.instances.get(ik);
    if (!inst) {
      inst = { ds: r.datasource_name, hds: r.hds_id, family: r.family, key: r.instance_key, name: r.instance_name || r.instance_key, m: {} };
      dev.instances.set(ik, inst);
    }
    inst.m[r.metric] = { value: r.value, datapoint: r.datapoint, epoch: r.sampled_at_epoch };
  }
  return out;
}

/** Instances of a device that carry a metric. */
function devInstances(dev, metric) {
  const res = [];
  for (const inst of dev.instances.values()) if (inst.m[metric] && inst.m[metric].value != null) res.push(inst);
  return res;
}
/** First non-null value of a metric on the device (single-instance metrics). */
function devVal(dev, metric) {
  const hit = devInstances(dev, metric)[0];
  return hit ? hit.m[metric].value : null;
}
/** Highest value of a metric over the device's instances, with the instance. */
function devMax(dev, metric) {
  let best = null;
  for (const inst of devInstances(dev, metric)) {
    if (!best || inst.m[metric].value > best.value) best = { value: inst.m[metric].value, inst };
  }
  return best;
}

const fmtNum = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10));

function computeMetricIssues(dbh, t, srcName) {
  const issues = [];
  const index = loadDsIndex(dbh);
  if (!index.size) return issues;
  const push = (dev, severity, type, target, message) => issues.push({ severity, type, source: srcName.get(dev.sourceId), target, message });
  const missingAps = loadMissingAps(dbh);
  let deadDevices = new Set();
  try {
    deadDevices = new Set(dbh.prepare("SELECT source_id, lm_device_id FROM lm_devices WHERE stale = 0 AND host_status = 'dead'").all().map((r) => r.source_id + ':' + r.lm_device_id));
  } catch { /* no device table: nothing is dead */ }

  // F5 pairs: devices with a failover state, grouped by site.
  const failoverBySite = new Map();

  for (const dev of index.values()) {
    const name = dev.name;
    const suppressed = dev.sdt; // devices in scheduled downtime raise nothing

    // Firewall HA.
    const haEnabled = devVal(dev, 'ha_enabled');
    const haLocal = devVal(dev, 'ha_local_state');
    const haPeer = devVal(dev, 'ha_peer_state');
    if (!suppressed && isHaEnabled(haEnabled, haLocal, haPeer) && (isHaBadPeer(haPeer) || isHaBadLocal(haLocal))) {
      const why = isHaBadLocal(haLocal) ? `local state ${haText(haLocal)}` : `peer state ${haText(haPeer)}`;
      push(dev, 'critical', 'fw-ha-degraded', name,
        `${name} HA is degraded: ${why} (local ${haText(haLocal) || 'n/a'}, peer ${haText(haPeer) || 'n/a'}; healthy is active or passive)`);
    }

    // Firewall sessions.
    const sessions = devMax(dev, 'sessions_util_pct');
    let sessPct = sessions ? sessions.value : null;
    if (sessPct == null) {
      const act = devVal(dev, 'sessions_active');
      const max = devVal(dev, 'sessions_max');
      if (act != null && max) sessPct = (act / max) * 100;
    }
    if (!suppressed && sessPct != null && sessPct >= t.lm_fw_session_warn_pct) {
      push(dev, 'warning', 'fw-session-high', name,
        `${name} session table at ${fmtNum(sessPct)}% (threshold ${t.lm_fw_session_warn_pct}%)`);
    }

    // Config sync.
    const synced = devVal(dev, 'config_synced');
    if (!suppressed && synced != null && Math.round(synced) === 0) {
      push(dev, 'info', 'fw-config-unsynced', name, `${name} configuration is not synchronized with its HA peer`);
    }

    // IPSec tunnels.
    const tunnels = devInstances(dev, 'tunnel_state');
    const downT = tunnels.filter((i) => tunnelIsDown(i.m.tunnel_state.value));
    if (!suppressed && downT.length) {
      if (downT.length > t.lm_tunnel_fold) {
        push(dev, 'warning', 'fw-tunnel-down', `${name} IPSec tunnels`,
          `${downT.length} of ${tunnels.length} IPSec tunnels down on ${name} (folded above ${t.lm_tunnel_fold})`);
      } else {
        for (const i of downT) {
          push(dev, 'warning', 'fw-tunnel-down', `${name} ${i.name}`, `IPSec tunnel ${i.name} on ${name} is down`);
        }
      }
    }

    // F5 failover state per device.
    const fo = devVal(dev, 'failover_state');
    if (fo != null) {
      const k = dev.siteKey || '-';
      if (!failoverBySite.has(k)) failoverBySite.set(k, []);
      failoverBySite.get(k).push({ dev, state: Math.round(fo) });
      if (!suppressed && [1, 2].includes(Math.round(fo))) {
        push(dev, 'warning', 'lb-failover-degraded', name, `${name} failover state is ${failoverText(fo)} (expected active or standby)`);
      }
    }

    // F5 pools from member availability.
    if (!suppressed) {
      const pools = new Map();
      for (const i of devInstances(dev, 'member_avail')) {
        const p = poolOf(i.key);
        const e = pools.get(p) || { total: 0, down: 0 };
        e.total += 1;
        if (availState(i.m.member_avail.value) === 'down') e.down += 1;
        pools.set(p, e);
      }
      for (const [p, e] of pools) {
        if (!e.down) continue;
        const all = e.down === e.total && e.total >= 2;
        push(dev, all ? 'critical' : 'warning', 'lb-pool-degraded', `${name} ${p}`,
          all ? `Pool ${p} on ${name} has every member down (${e.down} of ${e.total})`
            : `Pool ${p} on ${name} has ${e.down} of ${e.total} members down`);
      }
    }

    // Certificates.
    if (!suppressed) {
      for (const i of devInstances(dev, 'cert_days_left')) {
        const days = i.m.cert_days_left.value;
        if (days < t.lm_cert_warn_days) {
          const crit = days < 7;
          push(dev, crit ? 'critical' : 'warning', 'lb-cert-expiring', `${name} ${i.name}`,
            days < 0 ? `Certificate ${i.name} on ${name} expired ${fmtNum(-days)} days ago`
              : `Certificate ${i.name} on ${name} expires in ${fmtNum(days)} days (threshold ${t.lm_cert_warn_days} days)`);
        }
      }
    }

    // Daemons: daemon_state follows the LM enum (1 = running); daemon_exit is the exit-code
    // convention of the customer's script DataSources (0 = running), a warning because a GTM
    // daemon legitimately reports non-zero on an LTM-only unit.
    if (!suppressed) {
      for (const i of devInstances(dev, 'daemon_state')) {
        if (Math.round(i.m.daemon_state.value) !== 1) {
          push(dev, 'critical', 'lb-daemon-down', `${name} ${i.name}`, `Service ${i.name} on ${name} is not running (state ${fmtNum(i.m.daemon_state.value)})`);
        }
      }
      for (const i of devInstances(dev, 'daemon_exit')) {
        if (i.m.daemon_exit.value != null && Math.round(i.m.daemon_exit.value) !== 0) {
          push(dev, 'warning', 'lb-daemon-down', `${name} ${i.name}`, `Service ${i.name} on ${name} reports exit status ${fmtNum(i.m.daemon_exit.value)} (0 = running)`);
        }
      }
    }

    // CPU and memory (any family; the latest value, the tier is 30 minutes).
    // A percent above 100 is not a percent (a wrong learned pick or a multi-core sum): skip it.
    const pctOk = (m) => m && m.value != null && m.value <= 100;
    const cpu = devMax(dev, 'cpu_pct');
    if (!suppressed && pctOk(cpu) && cpu.value >= t.lm_cpu_warn_pct) {
      push(dev, 'warning', 'device-cpu-high', name, `${name} CPU at ${fmtNum(cpu.value)}% (threshold ${t.lm_cpu_warn_pct}%)`);
    }
    const mem = devMax(dev, 'mem_pct');
    if (!suppressed && pctOk(mem) && mem.value >= t.lm_mem_warn_pct) {
      push(dev, 'warning', 'device-memory-high', name, `${name} memory at ${fmtNum(mem.value)}% (threshold ${t.lm_mem_warn_pct}%)`);
    }

    // Round 12: ping loss, NTP, stack members, reboots, inaccessible filesystems.
    if (!suppressed) {
      const loss = devMax(dev, 'ping_loss_pct');
      if (pctOk(loss) && loss.value > 0 && loss.value >= t.lm_check_loss_min_pct && !deadDevices.has(dev.sourceId + ':' + dev.deviceId)) {
        const rtt = devVal(dev, 'ping_rtt_ms');
        push(dev, loss.value >= t.lm_check_loss_crit_pct ? 'critical' : 'warning', 'device-ping-loss', name,
          `${name} loses ${fmtNum(loss.value)}% of its pings${rtt != null ? ` (average round trip ${fmtNum(rtt)} ms)` : ''}`);
      }
      for (const i of devInstances(dev, 'ntp_synced')) {
        if (Math.round(i.m.ntp_synced.value) === 0) {
          const st = i.m.ntp_stratum ? i.m.ntp_stratum.value : null;
          push(dev, 'warning', 'ntp-unsynced', name, `NTP is not synchronised on ${name}${st != null ? ` (stratum ${fmtNum(st)})` : ''}`);
          break;
        }
      }
      for (const i of devInstances(dev, 'stack_member_state')) {
        const v = Math.round(i.m.stack_member_state.value);
        if (!STACK_HEALTHY.includes(v)) {
          const role = i.m.stack_role ? stackRoleText(i.m.stack_role.value) : null;
          push(dev, 'warning', 'stack-member-degraded', `${name} ${i.name}`,
            `Stack member ${i.name} on ${name} is ${stackStateText(v)} (state ${v}, ready is 4)${role ? `, role ${role}` : ''}`);
        }
      }
      for (const i of devInstances(dev, 'fs_not_accessible')) {
        if (Math.round(i.m.fs_not_accessible.value) === 1) {
          push(dev, 'warning', 'filesystem-inaccessible', `${name} ${i.name}`, `Filesystem ${i.name} on ${name} is not accessible`);
        }
      }
    }
    // A device that is also dead gets device-dead, not a reboot notice.
    if (!suppressed && !deadDevices.has(dev.sourceId + ':' + dev.deviceId)) {
      const up = devMax(dev, 'uptime_s');
      if (up && up.value >= 0 && up.value < 86400) {
        push(dev, 'info', 'device-rebooted', name, `${name} rebooted: up for ${fmtUptime(up.value)}`);
      }
    }

    // Hardware components; more than 5 faults on one device fold into one issue.
    if (!suppressed) {
      const faults = [];
      for (const metric of Object.keys(HW_STATE_LABELS)) {
        for (const i of devInstances(dev, metric)) {
          if (i.family === 'cohesity') continue; // round 10: cohesity-hardware-fault (logicmonitorCohesity.js) owns these
          if (stateIsFault(i.m[metric].value, metric)) faults.push({ i, metric, v: i.m[metric].value });
        }
      }
      if (faults.length > 5) {
        push(dev, 'warning', 'hardware-fault', `${name} hardware`,
          `${faults.length} hardware components report a fault on ${name} (${faults.slice(0, 3).map((f) => f.i.name).join(', ')}, ...)`);
      } else {
        for (const f of faults) {
          const label = HW_STATE_LABELS[f.metric][0].toUpperCase() + HW_STATE_LABELS[f.metric].slice(1);
          push(dev, 'warning', 'hardware-fault', `${name} ${f.i.name}`,
            isAlarmMetric(f.metric) ? `${label} is set on ${f.i.name} of ${name} (value ${fmtNum(f.v)}, 0 = fine)`
              : `${label} ${f.i.name} on ${name} reports state ${fmtNum(f.v)} (expected 1 = ok)`);
        }
      }
    }

    // Routing neighbours.
    if (!suppressed) {
      for (const i of devInstances(dev, 'bgp_peer_state')) {
        if (Math.round(i.m.bgp_peer_state.value) !== 6) {
          push(dev, 'warning', 'bgp-peer-down', `${name} ${i.name}`, `BGP peer ${i.name} on ${name} is not established (state ${fmtNum(i.m.bgp_peer_state.value)}, established is 6)`);
        }
      }
      for (const i of devInstances(dev, 'ospf_nbr_state')) {
        if (Math.round(i.m.ospf_nbr_state.value) !== 8) {
          push(dev, 'warning', 'ospf-neighbor-down', `${name} ${i.name}`, `OSPF neighbor ${i.name} on ${name} is not full (state ${fmtNum(i.m.ospf_nbr_state.value)}, full is 8)`);
        }
      }
    }

    if (!suppressed) wirelessIssues(dev, t, push, missingAps.get(`${dev.sourceId}:${dev.deviceId}`));

    // Optics: only when LogicMonitor exposes the low-warning threshold as a
    // datapoint (rx_low_warn); with no threshold there is no issue.
    if (!suppressed) {
      for (const i of devInstances(dev, 'rx_power_dbm')) {
        const rx = i.m.rx_power_dbm.value;
        const lowWarn = i.m.rx_low_warn ? i.m.rx_low_warn.value : null;
        if (lowWarn != null && rx < lowWarn) {
          push(dev, 'warning', 'optic-power-low', `${name} ${i.name}`, `Optic ${i.name} on ${name} receives ${fmtNum(rx)} dBm, below its low warning of ${fmtNum(lowWarn)} dBm`);
        }
      }
      // Generic sensor-table DataSource: one row per sensor, the kind is in the
      // instance key and the thresholds are datapoints of the same row. Only
      // power sensors are judged (temperature, voltage and current rows share
      // the DataSource).
      for (const i of devInstances(dev, 'optic_value')) {
        if (i.m.rx_power_dbm) continue;
        if (!/rx|receive|tx|transmit|power/i.test(String(i.key || i.name || ''))) continue;
        const v = i.m.optic_value.value;
        const lowWarn = i.m.optic_low_warn ? i.m.optic_low_warn.value : null;
        if (lowWarn != null && v < lowWarn) {
          push(dev, 'warning', 'optic-power-low', `${name} ${i.name}`, `Optic ${i.name} on ${name} reads ${fmtNum(v)} dBm, below its low warning of ${fmtNum(lowWarn)} dBm`);
        }
      }
    }
  }

  // F5 pairs where no device is active.
  for (const group of failoverBySite.values()) {
    const known = group.filter((g) => g.state >= 1 && g.state <= 4);
    if (known.length >= 2 && !known.some((g) => g.state === 4)) {
      const names = known.map((g) => g.dev.name).sort();
      push(known[0].dev, 'critical', 'lb-failover-degraded', names.join(' + '),
        `No F5 in the pair ${names.join(' and ')} is active (${known.map((g) => `${g.dev.name} ${failoverText(g.state)}`).join(', ')})`);
    }
  }

  // Round 9: AWS Direct Connect and Azure ExpressRoute (family 'cloud').
  try { issues.push(...require('./logicmonitorCloud').cloudIssues(dbh, t, srcName, index)); } catch { /* a cloud rule fault must not hide the other issues */ }
  // Round 10: Cohesity clusters seen through LogicMonitor (family 'cohesity').
  try { issues.push(...require('./logicmonitorCohesity').cohesityIssues(dbh, t, srcName, index)); } catch { /* a Cohesity rule fault must not hide the other issues */ }
  // Round 11: Linux and Windows servers (families 'os' and 'health').
  try { issues.push(...require('./logicmonitorServers').serverIssues(dbh, t, srcName, index)); } catch { /* a server rule fault must not hide the other issues */ }
  // Round 11: applications and appliances (family 'apps').
  try { issues.push(...require('./logicmonitorApps').appsIssues(dbh, t, srcName, index)); } catch { /* an apps rule fault must not hide the other issues */ }
  // Round 11: voice, Zscaler and ISE appliances (families 'voice' and 'security').
  try { issues.push(...require('./logicmonitorAppliances').applianceIssues(dbh, t, srcName, index)); } catch { /* an appliance rule fault must not hide the other issues */ }
  return issues;
}

function computeIssues({ nowMs = Date.now() } = {}) {
  const t = getThresholds();
  const issues = [];
  const sources = db.prepare('SELECT * FROM lm_sources').all();
  if (!sources.length) return issues;
  const srcName = new Map(sources.map((s) => [s.id, s.name]));

  // source-unreachable
  for (const s of sources) {
    if (s.last_poll_status === 'error') {
      issues.push({ severity: 'critical', type: 'source-unreachable', source: s.name, target: s.name,
        message: `LogicMonitor portal ${s.name} (${s.company}.logicmonitor.com) is unreachable: ${s.last_poll_error || 'poll failed'}` });
    }
  }

  // collector-down (one incident per collector; its dead-collector devices
  // raise nothing of their own) and collector-build-behind.
  const devicesOnCollector = db.prepare('SELECT COUNT(*) n FROM lm_devices WHERE source_id = ? AND collector_id = ? AND stale = 0');
  for (const c of db.prepare('SELECT * FROM lm_collectors WHERE stale = 0').all()) {
    const source = srcName.get(c.source_id);
    const target = c.hostname || c.description || `collector ${c.collector_id}`;
    if (c.is_down && !c.in_sdt) {
      const n = devicesOnCollector.get(c.source_id, c.collector_id).n;
      issues.push({ severity: 'critical', type: 'collector-down', source, target,
        message: `Collector ${target} is down; ${plural(n, 'device')} on it are not being monitored${c.acked ? ' (acknowledged in LogicMonitor)' : ''}` });
    }
  }
  for (const s of sources) {
    const mgd = parseJson(s.features_json, {})?.collectorMgd;
    if (!mgd) continue;
    for (const c of db.prepare('SELECT * FROM lm_collectors WHERE source_id = ? AND stale = 0').all(s.id)) {
      if (isBehind(c.build, mgd)) {
        const target = c.hostname || c.description || `collector ${c.collector_id}`;
        issues.push({ severity: 'info', type: 'collector-build-behind', source: s.name, target,
          message: `Collector ${target} runs build ${c.build}, below the required release ${mgd}; LogicMonitor will force the upgrade` });
      }
    }
  }

  // device-dead. Network devices and check targets are critical, others
  // warning; SDT suppresses; grace from deleted_time_ms (time dead, ms) when
  // LM sends it, else from when ICC first saw it dead.
  const checkTargets = new Set(db.prepare('SELECT lower(target) t FROM lm_checks WHERE stale = 0 AND target IS NOT NULL').all().map((r) => r.t));
  const graceMs = t.lm_dead_grace_min * 60000;
  const deadList = [];
  for (const d of db.prepare("SELECT * FROM lm_devices WHERE stale = 0 AND host_status = 'dead'").all()) {
    if (hasSdt(d.sdt_status)) continue;
    let deadMs = null;
    if (d.deleted_time_ms != null && d.deleted_time_ms > 0) deadMs = d.deleted_time_ms;
    else if (d.dead_since) {
      const at = Date.parse(String(d.dead_since).includes('T') ? d.dead_since : `${String(d.dead_since).replace(' ', 'T')}Z`);
      if (Number.isFinite(at)) deadMs = nowMs - at;
    }
    if (deadMs == null || deadMs < graceMs) continue;
    deadList.push({ d, deadMs });
  }
  // Dependency suppression: a dead device behind a dead switch or a down
  // uplink is a consequence, not a root cause. The culprit gets "+N".
  const shadowOn = t.lm_shadow_enabled === 1;
  const shadowedDead = new Map();
  const deadBehind = new Map();
  if (shadowOn && deadList.length) {
    const pctx = lmPath.makeContext(db);
    for (const { d } of deadList) {
      const cause = lmPath.shadowCause(db, pctx, d.source_id, d.lm_device_id);
      if (!cause) continue;
      shadowedDead.set(`${d.source_id}:${d.lm_device_id}`, cause);
      const ck = `${cause.sourceId}:${cause.deviceId}`;
      deadBehind.set(ck, (deadBehind.get(ck) || 0) + 1);
    }
  }
  const alertShadows = shadowOn ? shadowedAlertCounts(db) : new Map();
  for (const { d, deadMs } of deadList) {
    const names = [d.display_name, d.name, d.hostname, ...parseJson(d.ips_json, [])].filter(Boolean).map((x) => String(x).toLowerCase());
    const isTarget = names.some((n) => checkTargets.has(n));
    const target = d.display_name || d.name;
    const mins = Math.round(deadMs / 60000);
    const since = mins >= 120 ? `${Math.round(mins / 60)} h` : `${mins} min`;
    let message = `${target}${d.role && d.role !== 'other' ? ` (${d.role})` : ''} is not responding to its collector for ${since}`;
    let severity = d.is_network || isTarget ? 'critical' : 'warning';
    const cause = shadowedDead.get(`${d.source_id}:${d.lm_device_id}`);
    if (cause) {
      message += ` (shadowed by ${cause.deviceName}${cause.port ? ` ${cause.port}` : ''})`;
      severity = 'info';
    } else {
      const n = (deadBehind.get(`${d.source_id}:${d.lm_device_id}`) || 0) + (alertShadows.get(`${d.source_id}:${d.lm_device_id}`) || 0);
      if (n) message += ` +${n} downstream shadowed`;
    }
    issues.push({ severity, type: 'device-dead', source: srcName.get(d.source_id), target, message });
  }

  // device-in-sdt
  for (const d of db.prepare("SELECT source_id, display_name, name, sdt_status FROM lm_devices WHERE stale = 0 AND sdt_status IS NOT NULL AND sdt_status != '' AND sdt_status != 'none-none-none'").all()) {
    if (!hasSdt(d.sdt_status)) continue;
    const target = d.display_name || d.name;
    issues.push({ severity: 'info', type: 'device-in-sdt', source: srcName.get(d.source_id), target,
      message: `${target} is in scheduled downtime (${d.sdt_status})` });
  }

  // Interface trend rules over history.
  const dayAgo = new Date(nowMs - 86400000).toISOString().replace('T', ' ').slice(0, 19);
  const hist = db.prepare(`
    SELECT h.source_id, h.instance_id, h.captured_at, h.status, h.in_errors, h.out_errors, h.in_util_pct, h.out_util_pct
    FROM lm_interface_history h
    JOIN lm_interfaces i ON i.source_id = h.source_id AND i.instance_id = h.instance_id
    WHERE h.captured_at >= ? AND i.stale = 0 AND COALESCE(i.stop_monitoring, 0) = 0
    ORDER BY h.source_id, h.instance_id, h.captured_at DESC, h.id DESC
  `).all(dayAgo);
  const byInst = new Map();
  for (const r of hist) {
    const k = `${r.source_id}|${r.instance_id}`;
    if (!byInst.has(k)) byInst.set(k, []);
    byInst.get(k).push(r);
  }
  if (byInst.size) {
    const ifBaselines = new Map();
    try {
      for (const b of db.prepare('SELECT * FROM lm_interface_baseline WHERE hour_of_day = ?').all(new Date(nowMs).getUTCHours())) {
        ifBaselines.set(`${b.source_id}|${b.instance_id}`, b);
      }
    } catch { /* baselines not built yet */ }
    const ifInfo = db.prepare(`
      SELECT i.display_name, i.instance_name, d.display_name AS device_name, d.name AS device_alt
      FROM lm_interfaces i LEFT JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id
      WHERE i.source_id = ? AND i.instance_id = ?
    `);
    for (const [k, rows] of byInst) {
      const [sid, iid] = k.split('|').map(Number);
      const info = ifInfo.get(sid, iid) || {};
      const target = `${info.device_name || info.device_alt || 'device'} ${info.display_name || info.instance_name || iid}`;
      const source = srcName.get(sid);
      const last3 = rows.slice(0, 3);
      const maxUtil = (r) => Math.max(r.in_util_pct ?? -1, r.out_util_pct ?? -1);
      if (last3.length === 3 && last3.every((r) => maxUtil(r) >= t.lm_if_util_warn_pct)) {
        issues.push({ severity: 'warning', type: 'interface-utilization-high', source, target,
          message: `${target} at ${Math.round(maxUtil(last3[0]))}% utilization for the last 3 samples (threshold ${t.lm_if_util_warn_pct}%)` });
      }
      // Baseline anomalies (hour of day median and MAD), only where the
      // static threshold has not already fired for this interface.
      const bl = ifBaselines.get(`${sid}|${iid}`);
      if (bl && last3.length === 3) {
        const meanOf = (fn) => last3.reduce((sum, r) => sum + fn(r), 0) / 3;
        const alreadyHigh = issues.some((x) => x.type === 'interface-utilization-high' && x.target === target && x.source === source);
        const mu = meanOf((r) => Math.max(r.in_util_pct ?? 0, r.out_util_pct ?? 0));
        if (!alreadyHigh && bl.util_median != null
          && mu > bl.util_median + t.lm_if_anomaly_k * Math.max(bl.util_mad || 0, 2) && mu > t.lm_if_anomaly_util_min_pct) {
          issues.push({ severity: 'warning', type: 'interface-util-anomaly', source, target,
            message: `${target} at ${Math.round(mu)}% utilization, baseline ${Math.round(bl.util_median)} +/- ${Math.round(bl.util_mad || 0)}% for this hour` });
        }
        const me = meanOf((r) => (r.in_errors || 0) + (r.out_errors || 0));
        if (bl.err_median != null
          && me > bl.err_median + t.lm_if_anomaly_k * Math.max(bl.err_mad || 0, 1) && me > t.lm_if_anomaly_err_min) {
          issues.push({ severity: 'warning', type: 'interface-error-anomaly', source, target,
            message: `${target} logging ${Math.round(me)} errors per sample, baseline ${Math.round(bl.err_median)} +/- ${Math.round(bl.err_mad || 0)} for this hour` });
        }
      }
      const errs = (r) => (r.in_errors || 0) + (r.out_errors || 0);
      const errSum = rows.reduce((s, r) => s + errs(r), 0);
      if (errSum > t.lm_if_err_warn && last3.length === 3 && last3.every((r) => errs(r) > 0)) {
        issues.push({ severity: 'warning', type: 'interface-errors-growing', source, target,
          message: `${target} logged ${Math.round(errSum)} errors in 24 h and is still erroring` });
      }
      let flaps = 0;
      let prev = null;
      for (const r of [...rows].reverse()) {
        if (r.status == null) continue;
        if (prev != null && r.status !== prev) flaps += 1;
        prev = r.status;
      }
      if (flaps >= t.lm_if_flap_warn) {
        issues.push({ severity: 'warning', type: 'interface-flapping', source, target,
          message: `${target} changed status ${flaps} times in 24 h` });
      }
    }
  }

  // circuit-saturated (WAN circuits, round 3).
  try {
    for (const c of lmPath.circuitRows(db, { nowMs })) {
      if (c.satState === 'ok') continue;
      const target = `${c.deviceName} ${c.port}`;
      const peak = Math.max(c.p95InPct ?? 0, c.p95OutPct ?? 0);
      issues.push({ severity: c.satState === 'critical' ? 'critical' : 'warning', type: 'circuit-saturated', source: srcName.get(c.sourceId), target,
        message: `WAN circuit ${target}${c.label ? ` (${c.label})` : ''} p95 ${Math.round(peak)}% over ${t.lm_circuit_sat_days} days${c.satState === 'critical' ? `, daily peak at or above ${t.lm_circuit_crit_pct}% for ${c.critDays} days running` : ''}${c.maxDailyPct != null ? ` (highest daily peak ${Math.round(c.maxDailyPct)}%)` : ''}` });
    }
  } catch { /* circuit metrics unavailable */ }

  // alert-storm
  const stormSince = Math.floor(nowMs / 1000) - 900;
  for (const r of db.prepare('SELECT source_id, COUNT(*) n FROM lm_alerts WHERE start_epoch >= ? GROUP BY source_id').all(stormSince)) {
    if (r.n > t.lm_alert_storm_count) {
      const source = srcName.get(r.source_id);
      issues.push({ severity: 'info', type: 'alert-storm', source, target: source,
        message: `${r.n} LogicMonitor alerts opened on ${source} in the last 15 minutes` });
    }
  }

  // Check rules (site reachability).
  try {
    issues.push(...checks.evaluateAnomalies(db, { nowMs }));
  } catch { /* a check evaluation fault must not hide the other issues */ }

  // Round 9: latency watch (degrading episodes, repeating one-offs, drift).
  try {
    issues.push(...require('./logicmonitorWatch').computeWatchIssues(db, t, srcName));
  } catch { /* a watch fault must not hide the other issues */ }

  // Round 10: neighbours CDP/LLDP see that nothing monitors (one folded info issue per source).
  try {
    issues.push(...require('./logicmonitorEri').unmonitoredNeighborIssues(db, t, srcName));
  } catch { /* an ERI fault must not hide the other issues */ }

  // device-new, with the bootstrap guard: a portal whose first successful
  // poll is younger than the window would flag its whole inventory.
  if (t.lm_new_device_days > 0) {
    const windowMs = t.lm_new_device_days * 86400000;
    const cutoff = new Date(nowMs - windowMs).toISOString().replace('T', ' ').slice(0, 19);
    for (const s of sources) {
      const first = db.prepare('SELECT MIN(captured_at) t FROM lm_metrics_history WHERE source_id = ?').get(s.id)?.t;
      if (!first || first > cutoff) continue;
      for (const d of db.prepare('SELECT display_name, name, role, first_seen FROM lm_devices WHERE source_id = ? AND stale = 0 AND first_seen >= ?').all(s.id, cutoff)) {
        const target = d.display_name || d.name;
        issues.push({ severity: 'info', type: 'device-new', source: s.name, target,
          message: `${target}${d.role && d.role !== 'other' ? ` (${d.role})` : ''} was added to LogicMonitor on ${String(d.first_seen).slice(0, 10)}` });
      }
    }
  }

  // Round 8: rules over the DataSource metric tables (lm_ds_metrics).
  try {
    issues.push(...computeMetricIssues(db, t, srcName));
  } catch { /* a metric rule fault must not hide the other issues */ }

  // Round 12: operator-defined raw datapoint rules (lm_raw_rules).
  try {
    issues.push(...require('./logicmonitorRawRules').rawRuleIssues(db, t, srcName, getTextSetting('lm_raw_rules')));
  } catch { /* a raw rule fault must not hide the other issues */ }

  const order = { critical: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}

const issueKey = (i) => `${i.type}|${i.source}|${i.target}`;

// Check issues that carry a "Likely hop" tail (logicmonitorChecks). Each open
// one records its blamed hop once per (issue, hop) in lm_blame_history for the
// Correlation page; the blame is recomputed here because the issue object only
// holds the text.
const CHECK_BLAME_TYPES = new Set(['check-down', 'check-location-down', 'latency-anomaly', 'packet-loss-anomaly', 'latency-degrading', 'loss-degrading']);
function recordCheckBlames(current) {
  try {
    const cands = [...current.values()].filter((i) => CHECK_BLAME_TYPES.has(i.type) && /Likely hop:/.test(String(i.message || '')));
    if (!cands.length) return;
    const corr = require('./logicmonitorCorrelation');
    const ctx = lmPath.makeContext(db);
    const srcByName = new Map(db.prepare('SELECT id, name FROM lm_sources').all().map((s) => [s.name, s.id]));
    const openStmt = db.prepare("SELECT first_seen FROM lm_issue_history WHERE issue_key = ? AND status = 'open' ORDER BY id DESC LIMIT 1");
    const checkStmt = db.prepare('SELECT check_id FROM lm_checks WHERE source_id = ? AND name = ? AND stale = 0 LIMIT 1');
    const labelStmt = db.prepare('SELECT checkpoint_id FROM lm_check_locations WHERE source_id = ? AND check_id = ? AND label = ? AND stale = 0 LIMIT 1');
    const overallStmt = db.prepare('SELECT checkpoint_id FROM lm_check_locations WHERE source_id = ? AND check_id = ? AND stale = 0 ORDER BY is_overall DESC LIMIT 1');
    for (const i of cands) {
      const sid = srcByName.get(i.source);
      if (sid == null) continue;
      const at = i.type === 'check-down' ? -1 : String(i.target).lastIndexOf(' @ ');
      const checkName = at >= 0 ? String(i.target).slice(0, at) : String(i.target);
      const label = at >= 0 ? String(i.target).slice(at + 3) : null;
      const check = checkStmt.get(sid, checkName);
      if (!check) continue;
      const cp = label != null ? labelStmt.get(sid, check.check_id, label) : overallStmt.get(sid, check.check_id);
      const blame = lmPath.blameForCheck(db, check.check_id, cp ? cp.checkpoint_id : null, { ctx, sourceId: sid });
      if (!blame) continue;
      const open = openStmt.get(issueKey(i));
      corr.recordBlame(db, {
        sourceId: sid, kind: 'check', subject: checkName, subjectKey: check.check_id, checkpointLabel: label,
        blame, siteKey: blame.siteKey || null, issueKey: issueKey(i), dedupeSince: open ? open.first_seen : null,
      });
    }
  } catch { /* blame history is best effort */ }
}

// Anomaly issues flap with the data, so an open row survives
// lm_issue_clear_absences consecutive polls without its key before it resolves
// (lm_issue_history.absent_polls counts them; a poll that has the key resets it).
const ANOMALY_TYPES = new Set(['latency-anomaly', 'packet-loss-anomaly', 'interface-util-anomaly', 'interface-error-anomaly', 'latency-degrading', 'loss-degrading']);

const reconcileIssueHistoryTxn = db.transaction(() => {
  const current = new Map(computeIssues().map((i) => [issueKey(i), i]));
  const open = db.prepare("SELECT * FROM lm_issue_history WHERE status = 'open'").all();
  const clearAbsences = getThreshold('lm_issue_clear_absences');

  const touch = db.prepare(`
    UPDATE lm_issue_history SET last_seen = datetime('now'), message = ?, severity = ?, absent_polls = 0 WHERE id = ?
  `);
  const absent = db.prepare('UPDATE lm_issue_history SET absent_polls = ? WHERE id = ?');
  const resolve = db.prepare(`
    UPDATE lm_issue_history SET status = 'resolved', resolved_at = datetime('now'), last_seen = datetime('now') WHERE id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO lm_issue_history (issue_key, source, severity, type, target, message)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const openKeys = new Set();
  for (const row of open) {
    const cur = current.get(row.issue_key);
    if (cur) {
      openKeys.add(row.issue_key);
      touch.run(cur.message, cur.severity, row.id);
    } else if (ANOMALY_TYPES.has(row.type) && (row.absent_polls || 0) + 1 < clearAbsences) {
      absent.run((row.absent_polls || 0) + 1, row.id);
    } else {
      resolve.run(row.id);
    }
  }
  for (const [key, i] of current) {
    if (!openKeys.has(key)) insert.run(key, i.source, i.severity, i.type, i.target, i.message);
  }
  recordCheckBlames(current);
});

/** Open alerts shadowed under each culprit device: Map "source:device" -> count. */
function shadowedAlertCounts(dbh = db) {
  const out = new Map();
  try {
    for (const r of dbh.prepare(`
      SELECT source_id, json_extract(shadowed_by, '$.deviceId') AS culprit, COUNT(*) n
      FROM lm_alerts WHERE cleared = 0 AND shadowed_by IS NOT NULL AND json_valid(shadowed_by) GROUP BY source_id, culprit
    `).all()) if (r.culprit != null) out.set(`${r.source_id}:${r.culprit}`, r.n);
  } catch { /* column not migrated */ }
  return out;
}

/** An issue that computeIssues marked as a consequence of an upstream failure. */
const isShadowedIssue = (row) => !!(row && row.type === 'device-dead' && /\(shadowed by /.test(String(row.message || '')));

/**
 * Dependency suppression. For every open LM alert on a device D, when the
 * path above D (logicmonitorPath) holds a hop that is critical because the
 * device is dead or its facing port is down, store that hop in
 * lm_alerts.shadowed_by ({sourceId, deviceId, deviceName, port, reason}); the
 * flag is cleared as soon as the upstream recovers (recomputed every pass).
 * Respects lm_shadow_enabled. opts {sourceId, deviceId} narrows the pass to
 * one device (the webhook writer). Returns {shadowed, cleared, culprits}.
 */
function computeShadows(dbh = db, opts = {}) {
  const res = { shadowed: 0, cleared: 0, culprits: 0 };
  try {
    const scope = [];
    const args = [];
    if (opts.sourceId != null) { scope.push('source_id = ?'); args.push(opts.sourceId); }
    if (opts.deviceId != null) { scope.push('lm_device_id = ?'); args.push(opts.deviceId); }
    const scopeSql = scope.length ? ` AND ${scope.join(' AND ')}` : '';
    const enabled = getThreshold('lm_shadow_enabled') === 1;
    const clearStale = dbh.prepare(`UPDATE lm_alerts SET shadowed_by = NULL WHERE shadowed_by IS NOT NULL AND (cleared = 1${enabled ? '' : ' OR 1 = 1'})${scopeSql}`);
    res.cleared += clearStale.run(...args).changes;
    if (!enabled) return res;
    const rows = dbh.prepare(`SELECT id, source_id, lm_device_id, shadowed_by FROM lm_alerts WHERE cleared = 0 AND lm_device_id IS NOT NULL${scopeSql}`).all(...args);
    if (!rows.length) return res;
    const ctx = lmPath.makeContext(dbh);
    const causes = new Map();
    const upd = dbh.prepare('UPDATE lm_alerts SET shadowed_by = ? WHERE id = ?');
    const culprits = new Set();
    dbh.transaction(() => {
      for (const r of rows) {
        const k = `${r.source_id}:${r.lm_device_id}`;
        if (!causes.has(k)) causes.set(k, lmPath.shadowCause(dbh, ctx, r.source_id, r.lm_device_id));
        const c = causes.get(k);
        const next = c ? JSON.stringify({ deviceId: c.deviceId, deviceName: c.deviceName, port: c.port, reason: c.reason, sourceId: c.sourceId }) : null;
        if (c) { res.shadowed += 1; culprits.add(`${c.sourceId}:${c.deviceId}`); }
        if (next !== (r.shadowed_by || null)) {
          upd.run(next, r.id);
          if (!c) res.cleared += 1;
        }
      }
    })();
    res.culprits = culprits.size;
  } catch { /* suppression is best effort; alerts stay visible */ }
  return res;
}

// BEGIN IMMEDIATE, same rationale as unifiIssues.js. Shadows are recomputed
// first so the issue pass and collectAlerts read the same upstream picture.
const reconcileIssueHistory = () => {
  try { computeShadows(db); } catch { /* best effort */ }
  const out = reconcileIssueHistoryTxn.immediate();
  pruneInBatches(db, 'lm_issue_history', "status = 'resolved' AND resolved_at < datetime('now', '-90 days')");
  return out;
};

module.exports = {
  THRESHOLD_DEFS, getThreshold, getThresholds, getTextSetting,
  compareBuild, isBehind,
  computeIssues, issueKey, reconcileIssueHistory, ANOMALY_TYPES,
  computeShadows, shadowedAlertCounts, isShadowedIssue,
  // Round 8 helpers shared with routes/logicmonitor.js.
  loadDsIndex, computeMetricIssues, haText, failoverText, availState, poolOf, devVal, devMax, devInstances,
  isHaBadPeer, isHaBadLocal, isHaEnabled, tunnelIsDown, stateIsFault, METRIC_ISSUE_TYPES,
  // Wireless helpers shared with routes/logicmonitor.js.
  WIRELESS_ISSUE_TYPES, loadMissingAps, wirelessAps, apIsDown, apOperText, apOfRadio, slotOfRadio, bandOfSlot, isClientSlot, apOfIf,
  radioIsUp, radioIsDown, isDisabled,
};
