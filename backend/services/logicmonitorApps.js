// Applications and appliances seen through LogicMonitor (round 11, WP-X).
//
// The 'apps' metric family (logicmonitorCatalog.js) stores Microsoft SQL Server, Splunk,
// Hyper-V, XenServer, Cisco IronPort / ESA and EMC DataSources. This file turns those rows
// into issues and into the rows the Applications page reads:
//
//   app-service-down    critical  sql_state, hv_vm_state, xen_host_state or emc_health reads down
//   app-capacity-high   warning   splunk_license_used_pct, emc_cap_used_pct or esa_quarantine_pct at or over 85
//   app-queue-high      warning   splunk_queue_fill_pct over 80 or esa_queue over 500
//
// ALL DataSource names, datapoint names and state enums are UNVERIFIED and BLIND: none of these
// DataSources exists on the first live portal. A raw state value is numeric; 0, or text matching
// down|offline|fail, counts as down, and every message prints the raw value so a wrong guess is
// visible. No threshold keys: the limits below are fixed on purpose (no new settings this round).

const { isDownValue } = require('./logicmonitorCohesity');

const CAPACITY_WARN_PCT = 85;
const SPLUNK_QUEUE_WARN_PCT = 80;
const ESA_QUEUE_WARN = 500;
// Down hypervisor VMs fold into one issue above this many on a device.
const HV_FOLD = 5;

const fmtNum = (v) => (v == null ? 'n/a' : Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10));

// kind -> label and metric key prefix. The kind of an instance comes from its metric key prefix, not
// from the DataSource name, because one catalog entry can cover many DataSource names.
const KINDS = [
  { id: 'sql', label: 'SQL Server', prefix: 'sql_' },
  { id: 'splunk', label: 'Splunk', prefix: 'splunk_' },
  { id: 'hyperv', label: 'Hyper-V', prefix: 'hv_' },
  { id: 'xen', label: 'XenServer', prefix: 'xen_' },
  { id: 'ironport', label: 'IronPort / ESA', prefix: 'esa_' },
  { id: 'emc', label: 'EMC', prefix: 'emc_' },
];
const KIND_BY_ID = new Map(KINDS.map((k) => [k.id, k]));

/** Kind id for a metric key, or null. */
function kindOfMetric(metric) {
  const k = KINDS.find((x) => String(metric).startsWith(x.prefix));
  return k ? k.id : null;
}

// Metrics shown in the list and the 360 summary, with the roll-up over a device's instances.
// state = down wins, then the first value; sum, max, min as named.
const KEY_METRICS = {
  sql: [['sql_state', 'state'], ['sql_connections', 'sum'], ['sql_batch_rate', 'sum'], ['sql_buffer_hit_pct', 'min'], ['sql_blocked', 'sum'], ['sql_backup_age_h', 'max'], ['sql_db_size', 'sum']],
  splunk: [['splunk_indexing_rate', 'sum'], ['splunk_queue_fill_pct', 'max'], ['splunk_search_concurrency', 'sum'], ['splunk_license_used_pct', 'max']],
  hyperv: [['hv_vm_state', 'state'], ['hv_cpu_pct', 'max'], ['hv_mem_pct', 'max']],
  xen: [['xen_host_state', 'state'], ['xen_cpu_pct', 'max'], ['xen_mem_pct', 'max'], ['xen_vm_count', 'sum']],
  ironport: [['esa_queue', 'max'], ['esa_cpu_pct', 'max'], ['esa_mem_pct', 'max'], ['esa_msgs_rate', 'sum'], ['esa_quarantine_pct', 'max']],
  emc: [['emc_health', 'state'], ['emc_cap_used_pct', 'max'], ['emc_disk_faults', 'sum'], ['emc_temp', 'max']],
};

/** Instances of a device index entry that belong to the apps family. */
function appInstances(dev) {
  return [...dev.instances.values()].filter((i) => i.family === 'apps');
}

/** Kind ids present on a device, in KINDS order. */
function kindsOf(dev) {
  const seen = new Set();
  for (const i of appInstances(dev)) for (const m of Object.keys(i.m)) { const k = kindOfMetric(m); if (k) seen.add(k); }
  return KINDS.map((k) => k.id).filter((id) => seen.has(id));
}

function rollup(insts, metric, how) {
  const vals = insts.filter((i) => i.m[metric] && i.m[metric].value != null).map((i) => i.m[metric].value);
  if (!vals.length) return null;
  if (how === 'sum') return vals.reduce((a, b) => a + b, 0);
  if (how === 'min') return Math.min(...vals);
  if (how === 'max') return Math.max(...vals);
  const down = vals.find((v) => isDownValue(v));
  return down !== undefined ? down : vals[0];
}

/**
 * Summary of one device: { kinds, instances, metrics: { key: value or null }, downCount }.
 * downCount is the number of state metric readings that are down.
 */
function summarize(dev) {
  const insts = appInstances(dev);
  const kinds = kindsOf(dev);
  const metrics = {};
  let downCount = 0;
  for (const k of kinds) {
    for (const [metric, how] of KEY_METRICS[k]) {
      metrics[metric] = rollup(insts, metric, how);
      if (how === 'state') downCount += insts.filter((i) => i.m[metric] && i.m[metric].value != null && isDownValue(i.m[metric].value)).length;
    }
  }
  return { kinds, instances: insts.length, metrics, downCount };
}

const short = (v, unit = '') => (v == null ? null : `${fmtNum(Math.round(v * 10) / 10)}${unit}`);
const stateWord = (v) => (v == null ? null : isDownValue(v) ? 'down' : 'up');

/** One line of headline figures for a summarize() result, for the list and the CSV. */
function headline(sum) {
  const m = sum.metrics;
  const parts = [];
  for (const k of sum.kinds) {
    const bits = [];
    if (k === 'sql') bits.push(stateWord(m.sql_state), short(m.sql_connections, ' connections'), short(m.sql_batch_rate, ' batch/s'), short(m.sql_blocked, ' blocked'));
    if (k === 'splunk') bits.push(short(m.splunk_indexing_rate, ' KB/s indexed'), short(m.splunk_queue_fill_pct, '% queue'), short(m.splunk_license_used_pct, '% license'));
    if (k === 'hyperv') bits.push(stateWord(m.hv_vm_state), short(m.hv_cpu_pct, '% CPU'), short(m.hv_mem_pct, '% memory'));
    if (k === 'xen') bits.push(stateWord(m.xen_host_state), short(m.xen_cpu_pct, '% CPU'), short(m.xen_vm_count, ' VMs'));
    if (k === 'ironport') bits.push(short(m.esa_queue, ' queued'), short(m.esa_cpu_pct, '% CPU'), short(m.esa_quarantine_pct, '% quarantine'));
    if (k === 'emc') bits.push(stateWord(m.emc_health), short(m.emc_cap_used_pct, '% used'), short(m.emc_disk_faults, ' disk faults'));
    const text = bits.filter(Boolean).join(', ');
    parts.push(`${KIND_BY_ID.get(k).label}: ${text || 'no figures yet'}`);
  }
  return parts.join('; ');
}

/**
 * Issue rows for computeMetricIssues. index = loadDsIndex() output
 * (Map of device -> { instances: Map of { family, key, name, m } }). Devices in
 * scheduled downtime raise nothing.
 */
function appsIssues(dbh, t, srcName, index) {
  const issues = [];
  if (!index || !index.size) return issues;
  for (const dev of index.values()) {
    if (dev.sdt) continue;
    const insts = appInstances(dev);
    if (!insts.length) continue;
    const source = srcName.get(dev.sourceId);
    const name = dev.name;
    const push = (severity, type, inst, message) => issues.push({
      severity, type, source, target: inst ? `${name} ${inst}` : name, message,
    });

    for (const [metric, label] of [['sql_state', 'SQL Server service'], ['xen_host_state', 'XenServer host'], ['emc_health', 'EMC array']]) {
      for (const i of insts) {
        const v = i.m[metric] && i.m[metric].value;
        if (v != null && isDownValue(v)) {
          push('critical', 'app-service-down', i.name,
            `${label} ${i.name} on ${name} is down: ${metric.replace(/_/g, ' ')} reads ${fmtNum(v)} (enum unverified; 0, down, offline or fail count as down)`);
        }
      }
    }
    // Hyper-V VMs fold above HV_FOLD.
    const hvAll = insts.filter((i) => i.m.hv_vm_state && i.m.hv_vm_state.value != null);
    const hvDown = hvAll.filter((i) => isDownValue(i.m.hv_vm_state.value));
    if (hvDown.length > HV_FOLD) {
      push('critical', 'app-service-down', `(${hvDown.length} VMs)`,
        `${hvDown.length} of ${hvAll.length} Hyper-V VMs down on ${name} (folded above ${HV_FOLD}; first ${hvDown.slice(0, 3).map((i) => i.name).join(', ')}; raw state ${fmtNum(hvDown[0].m.hv_vm_state.value)}, enum unverified)`);
    } else {
      for (const i of hvDown) {
        push('critical', 'app-service-down', i.name,
          `Hyper-V VM ${i.name} on ${name} is down: VM state reads ${fmtNum(i.m.hv_vm_state.value)} (enum unverified; 0, down, offline or fail count as down)`);
      }
    }

    for (const [metric, label] of [['splunk_license_used_pct', 'Splunk license'], ['emc_cap_used_pct', 'EMC capacity'], ['esa_quarantine_pct', 'IronPort quarantine']]) {
      for (const i of insts) {
        const v = i.m[metric] && i.m[metric].value;
        if (v != null && v >= CAPACITY_WARN_PCT) {
          push('warning', 'app-capacity-high', i.name,
            `${label} ${i.name} on ${name} is ${fmtNum(v)}% used (warning at ${CAPACITY_WARN_PCT}%)`);
        }
      }
    }

    for (const i of insts) {
      const q = i.m.splunk_queue_fill_pct && i.m.splunk_queue_fill_pct.value;
      if (q != null && q > SPLUNK_QUEUE_WARN_PCT) {
        push('warning', 'app-queue-high', i.name, `Splunk queue ${i.name} on ${name} is ${fmtNum(q)}% full (warning over ${SPLUNK_QUEUE_WARN_PCT}%)`);
      }
      const e = i.m.esa_queue && i.m.esa_queue.value;
      if (e != null && e > ESA_QUEUE_WARN) {
        push('warning', 'app-queue-high', i.name, `IronPort work queue on ${name} holds ${fmtNum(e)} messages (warning over ${ESA_QUEUE_WARN})`);
      }
    }
  }
  return issues;
}

module.exports = {
  appsIssues, summarize, headline, kindsOf, kindOfMetric, appInstances, KINDS, KIND_BY_ID, KEY_METRICS,
  CAPACITY_WARN_PCT, SPLUNK_QUEUE_WARN_PCT, ESA_QUEUE_WARN, HV_FOLD,
};
