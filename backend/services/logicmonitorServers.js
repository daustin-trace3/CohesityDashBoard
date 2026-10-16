// Servers seen through LogicMonitor (round 11, lm11-servers).
//
// The 'os' metric family (logicmonitorCatalog.js) plus the Net-SNMP filesystem entry in the
// 'health' family hold Linux and Windows server data. This file turns it into issues:
//
//   server-filesystem-full  warning at lm_fs_warn_pct, critical at lm_fs_crit_pct, per filesystem
//                           (folded into one issue per device above lm_tunnel_fold)
//   server-service-stopped  warning, a Windows service reads stopped
//   server-nfs-mount-down   warning, an NFS mount reads down
//
// CPU and memory issues already come from the generic device-cpu-high / device-memory-high
// rules (cpu_pct and mem_pct exist in the health and os families); they are not repeated here.
//
// ALL datapoint names and state enums are UNVERIFIED against a live portal (the sandbox has
// zero Windows DataSource instances). Windows service State is read as the Win32 service
// state enum (1 stopped, 4 running), which is a guess; text containing "stop" also counts.
// An NFS mount reads down at numeric 0 or text matching down|unmount|stale|fail. Every
// message prints the raw value so a wrong guess is visible.

const fmtNum = (v) => (v == null ? 'n/a' : Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10));

// Pseudo filesystems that are full by design: /proc, /sys, /dev (and /dev/shm), /run, tmpfs.
const PSEUDO_FS_RE = /^(\/proc|\/sys|\/dev|\/run)(\/|$)|^tmpfs$/i;
const isPseudoFs = (name) => PSEUDO_FS_RE.test(String(name == null ? '' : name).trim());

function serviceIsStopped(v) {
  if (v == null) return false;
  if (typeof v === 'number') return Number.isFinite(v) && Math.round(v) === 1;
  return /stop/i.test(String(v));
}

function mountIsDown(v) {
  if (v == null) return false;
  if (typeof v === 'number') return Number.isFinite(v) && Math.round(v) === 0;
  return /down|unmount|stale|fail|^0$/i.test(String(v).trim());
}

/** The filesystem rows of a device: { name, pct } for the Linux (fs_used_pct on SNMP_Filesystem_Usage) and Windows (vol_used_pct) entries. */
function filesystemsOf(dev) {
  const out = [];
  for (const inst of dev.instances.values()) {
    let pct = null;
    if (inst.m.vol_used_pct && inst.m.vol_used_pct.value != null) pct = inst.m.vol_used_pct.value;
    else if (inst.ds === 'SNMP_Filesystem_Usage' && inst.m.fs_used_pct && inst.m.fs_used_pct.value != null) pct = inst.m.fs_used_pct.value;
    if (pct == null || !Number.isFinite(pct)) continue;
    if (isPseudoFs(inst.name) || isPseudoFs(inst.key)) continue;
    out.push({ name: inst.name || inst.key, pct });
  }
  return out;
}

/** Window rows of every instance of a metric on the device. */
function rowsOf(dev, metric) {
  const out = [];
  for (const inst of dev.instances.values()) if (inst.m[metric] && inst.m[metric].value != null) out.push(inst);
  return out;
}

/**
 * Issue rows for computeMetricIssues. index = loadDsIndex() output. Devices in scheduled
 * downtime raise nothing.
 */
function serverIssues(dbh, t, srcName, index) {
  const issues = [];
  if (!index || !index.size) return issues;
  const warn = t.lm_fs_warn_pct;
  const crit = t.lm_fs_crit_pct;
  const fold = t.lm_tunnel_fold;
  for (const dev of index.values()) {
    if (dev.sdt) continue;
    const source = srcName.get(dev.sourceId);
    const name = dev.name;
    const push = (severity, type, target, message) => issues.push({ severity, type, source, target, message });

    const fsOver = filesystemsOf(dev).filter((f) => f.pct >= warn).sort((a, b) => b.pct - a.pct || String(a.name).localeCompare(String(b.name)));
    if (fsOver.length > fold) {
      const worst = fsOver[0];
      push(fsOver.some((f) => f.pct >= crit) ? 'critical' : 'warning', 'server-filesystem-full', `${name} (${fsOver.length} filesystems)`,
        `${fsOver.length} filesystems on ${name} are at or over ${warn}% (folded above ${fold}; fullest ${worst.name} at ${fmtNum(worst.pct)}%)`);
    } else {
      for (const f of fsOver) {
        const critical = f.pct >= crit;
        push(critical ? 'critical' : 'warning', 'server-filesystem-full', `${name} ${f.name}`,
          `Filesystem ${f.name} on ${name} is ${fmtNum(f.pct)}% full (${critical ? `critical at ${crit}%` : `warning at ${warn}%`})`);
      }
    }

    const stopped = rowsOf(dev, 'svc_state').filter((i) => serviceIsStopped(i.m.svc_state.value));
    if (stopped.length > fold) {
      push('warning', 'server-service-stopped', `${name} (${stopped.length} services)`,
        `${stopped.length} Windows services are stopped on ${name} (folded above ${fold}; first ${stopped.slice(0, 3).map((i) => i.name).join(', ')}; raw state ${fmtNum(stopped[0].m.svc_state.value)}, enum unverified)`);
    } else {
      for (const i of stopped) {
        push('warning', 'server-service-stopped', `${name} ${i.name}`,
          `Windows service ${i.name} on ${name} is stopped: state reads ${fmtNum(i.m.svc_state.value)} (enum unverified; 1 or text containing stop counts as stopped)`);
      }
    }

    const nfsDown = rowsOf(dev, 'nfs_mount_state').filter((i) => mountIsDown(i.m.nfs_mount_state.value));
    for (const i of nfsDown) {
      push('warning', 'server-nfs-mount-down', `${name} ${i.name}`,
        `NFS mount ${i.name} on ${name} is down: mount state reads ${fmtNum(i.m.nfs_mount_state.value)} (enum unverified; 0 or text down, unmount, stale or fail counts as down)`);
    }
  }
  return issues;
}

/**
 * App Services hint (round 11): when a server resolves to a LogicMonitor device that has an
 * open critical LM alert or an open critical server-filesystem-full issue, returns
 * { device, criticalAlerts, filesystem, note }; otherwise null. Never throws. Read-only.
 */
function lmServerHint(dbh, { names = [], ips = [] } = {}) {
  try {
    const platform = require('../platforms/logicmonitor');
    const [d] = platform.matchDevices(dbh, names, ips, 1);
    if (!d) return null;
    const devName = d.display_name || d.name;
    const alerts = dbh.prepare(`
      SELECT resource_template_name, instance_name, data_point_name, alert_value FROM lm_alerts
      WHERE source_id = ? AND lm_device_id = ? AND cleared = 0 AND duplicate_of IS NULL AND severity_norm = 'critical'
      ORDER BY start_epoch DESC LIMIT 5
    `).all(d.source_id, d.lm_device_id);
    const total = alerts.length
      ? dbh.prepare("SELECT COUNT(*) n FROM lm_alerts WHERE source_id = ? AND lm_device_id = ? AND cleared = 0 AND duplicate_of IS NULL AND severity_norm = 'critical'").get(d.source_id, d.lm_device_id).n
      : 0;
    let fs = null;
    try {
      const prefix = `${devName} `;
      fs = dbh.prepare(`
        SELECT message FROM lm_issue_history
        WHERE status = 'open' AND type = 'server-filesystem-full' AND severity = 'critical' AND (target = ? OR substr(target, 1, ?) = ?)
        ORDER BY last_seen DESC LIMIT 1
      `).get(devName, prefix.length, prefix);
    } catch { fs = null; }
    if (!total && !fs) return null;
    const first = alerts[0];
    const parts = [];
    if (total) parts.push(`${total} open critical LogicMonitor alert${total === 1 ? '' : 's'} (${[first.resource_template_name, first.instance_name, first.data_point_name].filter(Boolean).join(' / ')})`);
    if (fs) parts.push(fs.message);
    return { device: devName, criticalAlerts: total, filesystem: fs ? fs.message : null, note: parts.join('; ') };
  } catch { return null; }
}

module.exports = { lmServerHint, serverIssues, filesystemsOf, isPseudoFs, serviceIsStopped, mountIsDown };
