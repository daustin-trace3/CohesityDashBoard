// Computed vCenter issues (shared by router.js and the poller) plus their
// lifecycle history: each poll reconciles the freshly computed issue set
// against vcenter_issue_history so every issue gets first-seen / resolved
// timestamps instead of existing only as a live snapshot.
//
// Ported from backend/services/vcenterIssues.js — db/getSetting now come from
// coreApi rather than direct host requires.
const DS_USED_WARN_PCT = 80;
const CLUSTER_FREE_WARN_PCT = 20;

// Cert warning window is operator-configurable (vCenter Settings page);
// critical stays at 14 days, clamped down if the warning window is shorter.
function certWarnDays(coreApi) {
  const n = Number(coreApi.settings.getSetting('vcenter_cert_warn_days'));
  return Number.isFinite(n) && n >= 1 && n <= 365 ? Math.round(n) : 60;
}

const dsUsedPct = (d) => (d.capacity_bytes > 0 ? (1 - d.free_bytes / d.capacity_bytes) * 100 : null);

// Guest filesystem thresholds (vCenter Settings > Alert thresholds): warning
// at 80% used and critical at 90% by default. Critical never sits below warning.
function guestDiskThresholds(coreApi) {
  const read = (key, dflt) => {
    const n = Number(coreApi.settings.getSetting(key));
    return Number.isFinite(n) && n >= 1 && n <= 100 ? Math.round(n) : dflt;
  };
  const warn = read('vcenter_guest_disk_warn_pct', 80);
  const crit = Math.max(warn, read('vcenter_guest_disk_crit_pct', 90));
  return { warn, crit };
}

const fmtGb = (b) => (b == null ? '?' : `${(b / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`);

// "Owner" of a VM: the tag under the vCenter's configured owner category
// (for example "AdminOwner: Jane Doe" -> "Jane Doe"), or null.
function ownerFromTags(tagsJson, category) {
  if (!category || !tagsJson) return null;
  let tags;
  try { tags = JSON.parse(tagsJson); } catch { return null; }
  const prefix = `${String(category).toLowerCase()}:`;
  for (const t of Array.isArray(tags) ? tags : []) {
    const s = String(t);
    if (s.toLowerCase().startsWith(prefix)) return s.slice(s.indexOf(':') + 1).trim() || null;
  }
  return null;
}

/**
 * Current issues from the stored inventory. Every issue carries a `target`
 * (host/datastore/cluster name) so `type|vcenter|target` is a stable identity
 * across polls even as the message's numbers change.
 */
function computeIssues(coreApi) {
  const db = coreApi.db;
  const issues = [];
  for (const vc of db.prepare('SELECT * FROM vcenter_vcenters').all()) {
    if (vc.last_poll_status === 'error') {
      issues.push({ severity: 'critical', type: 'vcenter-unreachable', vcenter: vc.name, target: vc.name,
        message: `vCenter ${vc.name} is unreachable: ${vc.last_poll_error || 'poll failed'}` });
    }
  }
  const hosts = db.prepare(`
    SELECT h.*, v.name AS vcenter_name FROM vcenter_hosts h JOIN vcenter_vcenters v ON v.id = h.vcenter_id
  `).all();
  for (const h of hosts) {
    if (h.connection_state && h.connection_state !== 'CONNECTED') {
      issues.push({ severity: 'critical', type: 'host-down', vcenter: h.vcenter_name, target: h.name,
        message: `Host ${h.name} is ${String(h.connection_state).toLowerCase().replace(/_/g, ' ')}` });
    } else if (h.in_maintenance === 1) {
      issues.push({ severity: 'info', type: 'host-maintenance', vcenter: h.vcenter_name, target: h.name,
        message: `Host ${h.name} is in maintenance mode` });
    }
  }
  const datastores = db.prepare(`
    SELECT d.*, v.name AS vcenter_name FROM vcenter_datastores d JOIN vcenter_vcenters v ON v.id = d.vcenter_id
  `).all();
  for (const d of datastores) {
    const used = dsUsedPct(d);
    if (used != null && used > DS_USED_WARN_PCT) {
      issues.push({ severity: used > 90 ? 'critical' : 'warning', type: 'datastore-usage', vcenter: d.vcenter_name, target: d.name,
        message: `Datastore ${d.name} is ${used.toFixed(1)}% full` });
    }
  }
  const clusters = db.prepare(`
    SELECT c.*, v.name AS vcenter_name FROM vcenter_clusters c JOIN vcenter_vcenters v ON v.id = c.vcenter_id
  `).all();
  for (const c of clusters) {
    for (const [label, cap, used] of [
      ['CPU', c.cpu_mhz_capacity, c.cpu_mhz_used],
      ['memory', c.mem_bytes_capacity, c.mem_bytes_used],
    ]) {
      if (cap > 0 && used != null) {
        const freePct = (1 - used / cap) * 100;
        if (freePct < CLUSTER_FREE_WARN_PCT) {
          issues.push({ severity: freePct < 10 ? 'critical' : 'warning', type: 'cluster-capacity',
            vcenter: c.vcenter_name, target: `${c.name}:${label}`,
            message: `Cluster ${c.name} has ${freePct.toFixed(1)}% ${label} headroom left` });
        }
      }
    }
  }
  const certWarn = certWarnDays(coreApi);
  const certCrit = Math.min(14, certWarn);
  for (const cert of db.prepare(`
    SELECT c.*, v.name AS vcenter_name FROM vcenter_certs c JOIN vcenter_vcenters v ON v.id = c.vcenter_id
  `).all()) {
    if (!cert.valid_to) continue;
    const days = (new Date(cert.valid_to).getTime() - Date.now()) / 86400000;
    if (Number.isFinite(days) && days < certWarn) {
      issues.push({
        severity: days < certCrit ? 'critical' : 'warning', type: 'cert-expiry',
        vcenter: cert.vcenter_name, target: cert.vcenter_name,
        message: days < 0
          ? `vCenter ${cert.vcenter_name} TLS certificate EXPIRED ${Math.abs(Math.round(days))} day(s) ago`
          : `vCenter ${cert.vcenter_name} TLS certificate expires in ${Math.round(days)} day(s)`,
      });
    }
  }
  // Guest volumes near full (VMware Tools guest.disk). One issue per volume so
  // C: and E: on the same VM alert and clear on their own.
  const { warn: gdWarn, crit: gdCrit } = guestDiskThresholds(coreApi);
  for (const f of db.prepare(`
    SELECT f.vm_name, f.mount, f.capacity_bytes, f.free_bytes, f.used_pct,
           v.name AS vcenter_name, v.owner_tag_category, m.tags
    FROM vcenter_vm_filesystems f
    JOIN vcenter_vcenters v ON v.id = f.vcenter_id
    LEFT JOIN vcenter_vms m ON m.vcenter_id = f.vcenter_id AND m.vm_id = f.vm_id
    WHERE f.used_pct >= ?
  `).all(gdWarn)) {
    const owner = ownerFromTags(f.tags, f.owner_tag_category);
    issues.push({
      severity: f.used_pct >= gdCrit ? 'critical' : 'warning', type: 'guest-volume-full',
      vcenter: f.vcenter_name, target: `${f.vm_name}:${f.mount}`,
      message: `VM ${f.vm_name} volume ${f.mount} is ${f.used_pct.toFixed(1)}% full `
        + `(${fmtGb(f.free_bytes)} free of ${fmtGb(f.capacity_bytes)})${owner ? `, owner ${owner}` : ''}`,
    });
  }
  const order = { critical: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}

const issueKey = (i) => `${i.type}|${i.vcenter}|${i.target}`;

/**
 * Sync the computed issue set into vcenter_issue_history: new issues open a
 * row, still-present ones bump last_seen (message/severity refreshed), and
 * open rows whose issue is gone get resolved. Idempotent — safe to run after
 * every per-vCenter poll. Rows resolved >90 days ago are pruned.
 */
function reconcileIssueHistory(coreApi) {
  const db = coreApi.db;
  return db.transaction(() => {
    const current = new Map(computeIssues(coreApi).map((i) => [issueKey(i), i]));
    const open = db.prepare("SELECT * FROM vcenter_issue_history WHERE status = 'open'").all();

    const touch = db.prepare(`
      UPDATE vcenter_issue_history SET last_seen = datetime('now'), message = ?, severity = ? WHERE id = ?
    `);
    const resolve = db.prepare(`
      UPDATE vcenter_issue_history SET status = 'resolved', resolved_at = datetime('now'), last_seen = datetime('now') WHERE id = ?
    `);
    const insert = db.prepare(`
      INSERT INTO vcenter_issue_history (issue_key, vcenter, severity, type, target, message)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const openKeys = new Set();
    for (const row of open) {
      const cur = current.get(row.issue_key);
      if (cur) {
        openKeys.add(row.issue_key);
        touch.run(cur.message, cur.severity, row.id);
      } else {
        resolve.run(row.id);
      }
    }
    for (const [key, i] of current) {
      if (!openKeys.has(key)) insert.run(key, i.vcenter, i.severity, i.type, i.target, i.message);
    }
    db.prepare("DELETE FROM vcenter_issue_history WHERE status = 'resolved' AND resolved_at < datetime('now', '-90 days')").run();
  }).immediate();  // BEGIN IMMEDIATE: write lock up front, see host issue services
}

module.exports = {
  DS_USED_WARN_PCT, CLUSTER_FREE_WARN_PCT, certWarnDays, guestDiskThresholds, ownerFromTags,
  computeIssues, reconcileIssueHistory,
};
