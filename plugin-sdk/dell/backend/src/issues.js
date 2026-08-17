// Computed Dell issues (shared by router.js and the manifest's
// opsSummary/collectAlerts hooks). Ported from the computeIssues() function
// inline in backend/routes/dell.js — db/getSetting now come from coreApi
// rather than direct host requires. Dell carries no issue-history table (no
// dell_issue_history in migrations.js), so — unlike unifi/nutanix — this is
// computed live on every call, never persisted or reconciled.
function warrantyWarnDays(coreApi) {
  const n = parseInt(coreApi.settings.getSetting('dell_warranty_warn_days'), 10);
  return Number.isFinite(n) ? Math.min(365, Math.max(1, n)) : 90;
}

function computeIssues(coreApi) {
  const db = coreApi.db;
  const issues = [];
  const warnDays = warrantyWarnDays(coreApi);
  for (const o of db.prepare('SELECT * FROM dell_ome_instances').all()) {
    if (o.last_poll_status === 'error') {
      issues.push({ severity: 'critical', type: 'unreachable', ome: o.name, message: `OME unreachable: ${o.last_poll_error || 'poll failed'}` });
    }
  }
  const badDevices = db.prepare(`
    SELECT d.name, d.service_tag, d.health, o.name AS ome_name FROM dell_devices d
    JOIN dell_ome_instances o ON o.id = d.ome_id WHERE d.health IN ('critical', 'warning')
    ORDER BY CASE d.health WHEN 'critical' THEN 0 ELSE 1 END LIMIT 200
  `).all();
  for (const d of badDevices) {
    issues.push({ severity: d.health === 'critical' ? 'critical' : 'warning', type: 'device_health', ome: d.ome_name, message: `${d.name || d.service_tag} health is ${d.health}` });
  }
  const badComps = db.prepare(`
    SELECT c.kind, c.name, c.status, d.name AS device_name, o.name AS ome_name
    FROM dell_components c
    JOIN dell_devices d ON d.ome_id = c.ome_id AND d.device_id = c.device_id
    JOIN dell_ome_instances o ON o.id = c.ome_id
    WHERE c.status IN ('critical', 'warning') LIMIT 200
  `).all();
  for (const c of badComps) {
    issues.push({ severity: c.status === 'critical' ? 'critical' : 'warning', type: 'component', ome: c.ome_name, message: `${c.device_name}: ${c.kind} ${c.name || ''} is ${c.status}`.trim() });
  }
  // A service tag with multiple agreements is judged by its BEST one — an
  // expired base warranty under an active renewal is not an issue.
  const expiring = db.prepare(`
    SELECT w.service_tag, w.device_model, MAX(w.days_remaining) AS days_remaining, o.name AS ome_name
    FROM dell_warranties w JOIN dell_ome_instances o ON o.id = w.ome_id
    WHERE w.days_remaining IS NOT NULL
    GROUP BY w.ome_id, w.service_tag
    HAVING MAX(w.days_remaining) <= ? ORDER BY days_remaining LIMIT 200
  `).all(warnDays);
  for (const w of expiring) {
    issues.push({
      severity: w.days_remaining <= 0 ? 'critical' : 'warning', type: 'warranty', ome: w.ome_name,
      message: w.days_remaining <= 0
        ? `Warranty expired on ${w.device_model || ''} ${w.service_tag}`.trim()
        : `Warranty on ${w.device_model || ''} ${w.service_tag} expires in ${w.days_remaining}d`.trim(),
    });
  }
  // Configuration drift: a device out of compliance with its config baseline.
  const drifted = db.prepare(`
    SELECT c.device_name, c.service_tag, c.baseline_name, o.name AS ome_name
    FROM dell_config_compliance c JOIN dell_ome_instances o ON o.id = c.ome_id
    WHERE c.status = 'noncompliant' ORDER BY c.device_name LIMIT 200
  `).all();
  for (const c of drifted) {
    issues.push({
      severity: 'warning', type: 'config_compliance', ome: c.ome_name,
      message: `${c.device_name || c.service_tag} is not compliant with baseline ${c.baseline_name || ''}`.trim(),
    });
  }
  const order = { critical: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
}

module.exports = { computeIssues, warrantyWarnDays };
