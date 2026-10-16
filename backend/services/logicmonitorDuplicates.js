// LogicMonitor alerts that relay a feed ICC already polls directly (round 9, WP6).
//
// markDuplicateAlerts(db) tags open lm_alerts rows with lm_alerts.duplicate_of
// = 'duplicate:<platform>' when the DataSource that raised them is the LM view
// of a platform ICC reads itself AND that platform has a configured source.
// shadowed_by is a JSON dependency culprit (computeShadows), so duplicates use
// their own column (lm migration v7). Duplicates stay in the table and on the
// Alerts page behind a chip; collectAlerts, the Overview counters, the Ops
// Agent collector and the Alerts counts leave them out.
//
// The DataSource name patterns are UNVERIFIED against a live portal: they come
// from the names the catalog and the CG export use (ntm_aiqum_alerts,
// Cohesity_*, ntm_cohesity_*, VMware_* datastore and vCenter DataSources,
// Zerto_*, Brocade_* FC port DataSources). A pattern that misses simply leaves
// the alert visible, which is the safe direction.

const OWNERS = [
  { platform: 'netapp', label: 'NetApp (AIQUM)', ds: /^ntm_aiqum|aiqum_alerts/i, tables: ['netapp_aiqum_instances'] },
  { platform: 'cohesity', label: 'Cohesity', ds: /^(ntm_)?cohesity_/i, tables: ['clusters'] },
  { platform: 'vcenter', label: 'vCenter', ds: /^vmware_.*(datastore|vcenter|vcsa)|^vcenter/i, tables: ['vcenter_vcenters'] },
  { platform: 'zerto', label: 'Zerto', ds: /^zerto_/i, tables: ['zerto_sites', 'zerto_vpgs'] },
  { platform: 'brocade', label: 'Brocade', ds: /^brocade_.*(fc|port)/i, tables: ['brocade_sources'] },
];

function tableHasRows(dbh, name) {
  try {
    const t = dbh.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    if (!t) return false;
    return !!dbh.prepare(`SELECT 1 FROM ${name} LIMIT 1`).get();
  } catch { return false; }
}
function hasColumn(dbh, table, col) {
  try { return dbh.prepare(`PRAGMA table_info('${table}')`).all().some((c) => c.name === col); } catch { return false; }
}

/** Owner entry for a DataSource name, or null. Pure (no db). */
function ownerForDatasource(name) {
  const n = String(name == null ? '' : name);
  if (!n) return null;
  return OWNERS.find((o) => o.ds.test(n)) || null;
}

/**
 * Mark open alerts as duplicates and clear the mark on rows whose owner feed
 * is gone, cleared alerts, or DataSources that no longer match. Returns
 * {marked, cleared, byPlatform}. Never throws.
 */
function markDuplicateAlerts(dbh) {
  const res = { marked: 0, cleared: 0, byPlatform: {} };
  try {
    if (!hasColumn(dbh, 'lm_alerts', 'duplicate_of')) return res;
    const active = OWNERS.filter((o) => o.tables.some((t) => tableHasRows(dbh, t)));
    const want = new Map();
    const rows = dbh.prepare('SELECT id, resource_template_name, duplicate_of FROM lm_alerts WHERE cleared = 0 OR duplicate_of IS NOT NULL').all();
    const upd = dbh.prepare('UPDATE lm_alerts SET duplicate_of = ? WHERE id = ?');
    const run = dbh.transaction(() => {
      for (const r of rows) {
        const owner = active.find((o) => o.ds.test(String(r.resource_template_name || '')));
        const tag = owner && r.id != null ? `duplicate:${owner.platform}` : null;
        want.set(r.id, tag);
        if ((r.duplicate_of || null) === tag) { if (tag) res.byPlatform[owner.platform] = (res.byPlatform[owner.platform] || 0) + 1; continue; }
        upd.run(tag, r.id);
        if (tag) { res.marked += 1; res.byPlatform[owner.platform] = (res.byPlatform[owner.platform] || 0) + 1; } else res.cleared += 1;
      }
      // A cleared alert drops its mark so history rows read plainly.
      dbh.prepare('UPDATE lm_alerts SET duplicate_of = NULL WHERE cleared = 1 AND duplicate_of IS NOT NULL').run();
    });
    run();
  } catch { /* leave counts as built */ }
  return res;
}

/** {total, byPlatform: [{platform, label, count}]} over open duplicates. */
function duplicateSummary(dbh) {
  const out = { total: 0, byPlatform: [] };
  try {
    if (!hasColumn(dbh, 'lm_alerts', 'duplicate_of')) return out;
    const rows = dbh.prepare("SELECT duplicate_of, COUNT(*) n FROM lm_alerts WHERE cleared = 0 AND duplicate_of IS NOT NULL GROUP BY duplicate_of").all();
    for (const r of rows) {
      const platform = String(r.duplicate_of).replace(/^duplicate:/, '');
      const owner = OWNERS.find((o) => o.platform === platform);
      out.byPlatform.push({ platform, label: owner ? owner.label : platform, count: r.n });
      out.total += r.n;
    }
    out.byPlatform.sort((a, b) => b.count - a.count || a.platform.localeCompare(b.platform));
  } catch { /* zeros */ }
  return out;
}

module.exports = { markDuplicateAlerts, duplicateSummary, ownerForDatasource, OWNERS };
