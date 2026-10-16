// Cohesity clusters seen through LogicMonitor (round 10, WP-B).
//
// The 'cohesity' metric family (logicmonitorCatalog.js) stores the
// Cohesity_DataPlatform_* and ntm_cohesity_* DataSources of a cluster that
// LogicMonitor monitors over SNMP and its own scripts. This file turns those
// rows into issues:
//
//   cohesity-node-down        critical  a node_status instance reads down
//   cohesity-service-down     warning   a service_state instance reads down (folded per cluster)
//   cohesity-hardware-fault   warning   a fan_state or psu_state instance reads not healthy
//   cohesity-capacity-high    warning / critical  cap_used_pct at or over the two thresholds
//
// ALL datapoint names and state enums are UNVERIFIED against a live portal.
// A raw state value is numeric; 0, or text matching down|offline|fail, counts
// as down, and every message prints the raw value so a wrong guess is visible.
// ProtectionJobs rows are collected but raise nothing: ICC has the direct
// Cohesity feed for backups.

const fmtNum = (v) => (v == null ? 'n/a' : Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10));

/** Raw state reads as not healthy. Numeric 0 only (10 is not 0); text by keyword. */
function isDownValue(v) {
  if (v == null) return false;
  if (typeof v === 'number') return Number.isFinite(v) && Math.round(v) === 0;
  return /down|offline|fail|^0$/i.test(String(v).trim());
}

/**
 * Issue rows for computeMetricIssues. index = loadDsIndex() output
 * (Map of device -> { instances: Map of { family, key, name, m } }). Devices in
 * scheduled downtime raise nothing.
 */
function cohesityIssues(dbh, t, srcName, index) {
  const issues = [];
  if (!index || !index.size) return issues;
  const warnPct = t.lm_cohesity_cap_warn_pct;
  const critPct = t.lm_cohesity_cap_crit_pct;
  const fold = t.lm_tunnel_fold;
  for (const dev of index.values()) {
    if (dev.sdt) continue;
    const insts = [...dev.instances.values()].filter((i) => i.family === 'cohesity');
    if (!insts.length) continue;
    const source = srcName.get(dev.sourceId);
    const cluster = dev.name;
    const push = (severity, type, instName, message) => issues.push({
      severity, type, source, target: instName ? `${cluster} ${instName}` : cluster, message,
    });

    for (const i of insts) {
      const v = i.m.node_status && i.m.node_status.value;
      if (v != null && isDownValue(v)) {
        push('critical', 'cohesity-node-down', i.name,
          `Cohesity node ${i.name} on ${cluster} is down: node status reads ${fmtNum(v)} (enum unverified; 0, down, offline or fail count as down)`);
      }
    }

    const svcDown = insts.filter((i) => i.m.service_state && i.m.service_state.value != null && isDownValue(i.m.service_state.value));
    const svcTotal = insts.filter((i) => i.m.service_state && i.m.service_state.value != null).length;
    if (svcDown.length > fold) {
      push('warning', 'cohesity-service-down', `(${svcDown.length} services)`,
        `${svcDown.length} of ${svcTotal} Cohesity services down on ${cluster} (folded above ${fold}; first ${svcDown.slice(0, 3).map((i) => i.name).join(', ')}; raw state ${fmtNum(svcDown[0].m.service_state.value)}, enum unverified)`);
    } else {
      for (const i of svcDown) {
        push('warning', 'cohesity-service-down', i.name,
          `Cohesity service ${i.name} on ${cluster} is down: service state reads ${fmtNum(i.m.service_state.value)} (enum unverified; 0, down, offline or fail count as down)`);
      }
    }

    for (const i of insts) {
      for (const [metric, label] of [['fan_state', 'fan'], ['psu_state', 'power supply']]) {
        const v = i.m[metric] && i.m[metric].value;
        if (v != null && isDownValue(v)) {
          push('warning', 'cohesity-hardware-fault', i.name,
            `Cohesity ${label} ${i.name} on ${cluster} is not healthy: ${metric.replace('_', ' ')} reads ${fmtNum(v)} (enum unverified; 0, down, offline or fail count as down)`);
        }
      }
    }

    // Capacity: the used percent datapoint, else used / total.
    let usedPct = null;
    let capInst = null;
    for (const i of insts) {
      if (i.m.cap_used_pct && i.m.cap_used_pct.value != null) { usedPct = i.m.cap_used_pct.value; capInst = i; break; }
    }
    if (usedPct == null) {
      for (const i of insts) {
        const u = i.m.cap_used_bytes && i.m.cap_used_bytes.value;
        const tot = i.m.cap_total_bytes && i.m.cap_total_bytes.value;
        if (u != null && tot != null && tot > 0) { usedPct = (u / tot) * 100; capInst = i; break; }
      }
    }
    if (usedPct != null && usedPct >= warnPct) {
      const crit = usedPct >= critPct;
      push(crit ? 'critical' : 'warning', 'cohesity-capacity-high', capInst ? capInst.name : '',
        `Cohesity cluster ${cluster} is ${fmtNum(usedPct)}% full (${crit ? `critical at ${critPct}%` : `warning at ${warnPct}%`})`);
    }
  }
  return issues;
}

module.exports = { cohesityIssues, isDownValue };
