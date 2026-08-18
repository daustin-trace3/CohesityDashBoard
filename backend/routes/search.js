// Estate-wide entity search: one endpoint fanning out cheap LIKE queries over
// the polled inventory tables, grouped by category. Every category is gated on
// the caller's RBAC grant AND the platform's enabled flag; results deep-link
// to the owning page with ?q=<name> (tables read it via useTableControls).
const express = require('express');
const db = require('../db/database');
const { hasPermission } = require('../services/rbac');
const { getSetting } = require('../services/settings');
const registry = require('../core/registry');

const router = express.Router();

const LIMIT_PER_CATEGORY = 8;
const escLike = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

// sql gets (pattern, limit); title/subtitle drive the dropdown rows.
const CATEGORIES = [
  { key: 'cohesity-clusters', label: 'Clusters', platform: 'cohesity', perm: 'cohesity:clusters:view', base: '/cohesity/clusters',
    sql: `SELECT name AS title, connection_type AS subtitle FROM clusters WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?` },
  { key: 'cohesity-objects', label: 'Objects (Sources)', platform: 'cohesity', perm: 'cohesity:workloads:view', base: '/sources',
    sql: `SELECT o.name AS title, (o.environment || ' · ' || c.name) AS subtitle
          FROM cohesity_objects o JOIN clusters c ON c.id = o.cluster_id
          WHERE o.name LIKE ? ESCAPE '\\' ORDER BY o.name LIMIT ?` },
  { key: 'cohesity-views', label: 'Views', platform: 'cohesity', perm: 'cohesity:views:view', base: '/views',
    sql: `SELECT name AS title, system_name AS subtitle FROM cohesity_views WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?` },
  { key: 'cohesity-groups', label: 'Protection Groups', platform: 'cohesity', perm: 'cohesity:governance:view', base: '/governance',
    sql: `SELECT p.name AS title, c.name AS subtitle FROM policies p JOIN clusters c ON c.id = p.cluster_id
          WHERE p.name LIKE ? ESCAPE '\\' ORDER BY p.name LIMIT ?` },
];

const platformEnabled = (id) => {
  if (id === 'cohesity') return true;
  return String(getSetting(`platform_${id}_enabled`) ?? '0') === '1';
};

/** GET /api/search?q= — grouped estate-wide entity search (min 2 chars). */
router.get('/', (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ results: [] });
    const pattern = `%${escLike(q)}%`;
    const grants = (req.auth && req.auth.grants) || [];

    // Phase 1 manifest-driven core hooks: merge plugin-declared categories
    // after the static built-in list, resolved per-request so hot-added
    // plugins are picked up without a restart.
    let pluginCategories = [];
    try {
      pluginCategories = registry.getSearchCategoryContributors();
    } catch { /* degrade: no plugin categories surfaced */ }

    const results = [];
    for (const cat of CATEGORIES.concat(pluginCategories)) {
      if (!platformEnabled(cat.platform)) continue;
      if (!hasPermission(grants, cat.perm)) continue;
      let items;
      try {
        const args = Array(cat.params || 1).fill(pattern);
        items = db.prepare(cat.sql).all(...args, LIMIT_PER_CATEGORY);
      } catch {
        continue; // table missing (platform never migrated) — skip quietly
      }
      if (!items.length) continue;
      results.push({
        key: cat.key,
        label: cat.label,
        platform: cat.platform,
        items: items.map((i) => ({
          title: i.title,
          subtitle: i.subtitle || null,
          route: `${cat.base}?q=${encodeURIComponent(i.title || q)}`,
        })),
      });
    }
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
