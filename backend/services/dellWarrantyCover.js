// OME raises its own warranty alerts per support contract, so a service tag
// whose base warranty lapsed under an active ProSupport renewal still
// produces an "expired" or "expires in N days" alert. ICC judges a tag by
// its BEST contract (MAX days_remaining), the same rule as the Support page,
// the Ops rollup and the computed issues. This predicate drops OME warranty
// alerts for tags whose best contract sits outside the warning window.
const { getSetting } = require('./settings');

const WARRANTY_RE = /warrant/i;

function warrantyWarnDays() {
  const n = parseInt(getSetting('dell_warranty_warn_days'), 10);
  return Number.isFinite(n) ? Math.min(365, Math.max(1, n)) : 90;
}

/** Returns keep(row) for dell_alerts rows (needs ome_id, category,
 *  subcategory, message, service_tag, device_name). True keeps the alert. */
function warrantyAlertFilter(db, warnDays = warrantyWarnDays()) {
  const covered = new Set();
  try {
    for (const r of db.prepare(`
      SELECT ome_id, service_tag FROM dell_warranties
      WHERE service_tag IS NOT NULL AND days_remaining IS NOT NULL
      GROUP BY ome_id, service_tag HAVING MAX(days_remaining) > ?
    `).all(warnDays)) covered.add(`${r.ome_id}|${String(r.service_tag).toUpperCase()}`);
  } catch { return () => true; }
  if (covered.size === 0) return () => true;
  const tagByName = new Map();
  try {
    for (const d of db.prepare('SELECT ome_id, name, service_tag FROM dell_devices WHERE service_tag IS NOT NULL').all()) {
      if (d.name) tagByName.set(`${d.ome_id}|${String(d.name).toLowerCase()}`, d.service_tag);
    }
  } catch { /* devices table missing: match on service_tag only */ }
  return (row) => {
    if (!WARRANTY_RE.test(`${row.category || ''} ${row.subcategory || ''} ${row.message || ''}`)) return true;
    const tag = row.service_tag || (row.device_name ? tagByName.get(`${row.ome_id}|${String(row.device_name).toLowerCase()}`) : null);
    if (!tag) return true;
    return !covered.has(`${row.ome_id}|${String(tag).toUpperCase()}`);
  };
}

module.exports = { warrantyAlertFilter, warrantyWarnDays, WARRANTY_RE };
