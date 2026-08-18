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
  { key: 'vcenter-vms', label: 'vCenter VMs', platform: 'vcenter', perm: 'vcenter:vms:view', base: '/vcenter/inventory',
    sql: `SELECT m.name AS title, (COALESCE(m.cluster_name, '') || ' · ' || v.name) AS subtitle
          FROM vcenter_vms m JOIN vcenter_vcenters v ON v.id = m.vcenter_id
          WHERE m.name LIKE ? ESCAPE '\\' ORDER BY m.name LIMIT ?` },
  { key: 'vcenter-hosts', label: 'ESX Hosts', platform: 'vcenter', perm: 'vcenter:hosts:view', base: '/vcenter/hosts',
    sql: `SELECT name AS title, cluster_name AS subtitle FROM vcenter_hosts WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?` },
  { key: 'vcenter-datastores', label: 'Datastores', platform: 'vcenter', perm: 'vcenter:datastores:view', base: '/vcenter/datastores',
    sql: `SELECT name AS title, ds_type AS subtitle FROM vcenter_datastores WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?` },
  { key: 'netapp-volumes', label: 'NetApp Volumes', platform: 'netapp', perm: 'netapp:volumes:view', base: '/netapp/volumes',
    sql: `SELECT v.name AS title, (COALESCE(v.svm_name, '') || ' · ' || a.name) AS subtitle
          FROM netapp_volumes v JOIN netapp_arrays a ON a.id = v.array_id
          WHERE v.name LIKE ? ESCAPE '\\' ORDER BY v.name LIMIT ?` },
  { key: 'netapp-shares', label: 'CIFS Shares', platform: 'netapp', perm: 'netapp:cifs:view', base: '/netapp/cifs',
    sql: `SELECT share_name AS title, (COALESCE(svm_name, '') || ' · ' || COALESCE(volume_name, '')) AS subtitle
          FROM netapp_cifs_shares WHERE share_name LIKE ? ESCAPE '\\' ORDER BY share_name LIMIT ?` },
  { key: 'zerto-vpgs', label: 'Zerto VPGs', platform: 'zerto', perm: 'zerto:vpgs:view', base: '/zerto/vpgs',
    sql: `SELECT name AS title, (COALESCE(protected_site, '') || ' → ' || COALESCE(recovery_site, '')) AS subtitle
          FROM zerto_vpgs WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?` },
  { key: 'zerto-vms', label: 'Zerto VMs', platform: 'zerto', perm: 'zerto:vms:view', base: '/zerto/vms',
    sql: `SELECT name AS title, vpg_names AS subtitle FROM zerto_vms WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?` },
  { key: 'zerto-sites', label: 'Zerto Sites', platform: 'zerto', perm: 'zerto:sites:view', base: '/zerto/sites',
    sql: `SELECT name AS title, site_type AS subtitle FROM zerto_sites WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?` },
  { key: 'pure-arrays', label: 'Pure Arrays', platform: 'pure', perm: 'pure:overview:view', base: '/pure',
    sql: `SELECT name AS title, model AS subtitle FROM pure1_arrays WHERE name LIKE ? ESCAPE '\\'
          UNION SELECT name AS title, mgmt_host AS subtitle FROM pure_arrays WHERE name LIKE ? ESCAPE '\\'
          ORDER BY title LIMIT ?`, params: 2 },
  { key: 'dell-devices', label: 'Dell Devices', platform: 'dell', perm: 'dell:devices:view', base: '/dell/devices',
    sql: `SELECT name AS title, (COALESCE(service_tag, '') || ' · ' || COALESCE(model, '')) AS subtitle
          FROM dell_devices WHERE name LIKE ? ESCAPE '\\' OR service_tag LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?`, params: 2 },
  { key: 'aria-deployments', label: 'Aria Deployments', platform: 'aria', perm: 'aria:deployments:view', base: '/aria/deployments',
    sql: `SELECT name AS title, (COALESCE(project_name, '') || ' · ' || COALESCE(status, '')) AS subtitle
          FROM aria_deployments WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?` },
  { key: 'ariaops-resources', label: 'Aria Ops Resources', platform: 'ariaops', perm: 'ariaops:resources:view', base: '/ariaops/resources',
    sql: `SELECT name AS title, (COALESCE(kind, '') || ' · ' || COALESCE(health, '')) AS subtitle
          FROM ariaops_resources WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?` },
  { key: 'aws-ec2', label: 'AWS EC2 Instances', platform: 'aws', perm: 'aws:ec2:view', base: '/aws/ec2',
    sql: `SELECT COALESCE(i.name, i.instance_id) AS title, (COALESCE(i.state, '') || ' · ' || COALESCE(i.instance_type, '') || ' · ' || a.name) AS subtitle
          FROM aws_ec2_instances i JOIN aws_accounts a ON a.id = i.account_id
          WHERE COALESCE(i.name, i.instance_id) LIKE ? ESCAPE '\\' ORDER BY title LIMIT ?` },
  { key: 'aws-s3', label: 'AWS S3 Buckets', platform: 'aws', perm: 'aws:s3:view', base: '/aws/s3',
    sql: `SELECT name AS title, region AS subtitle FROM aws_s3_buckets WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?` },
  { key: 'aws-ecs', label: 'AWS ECS Services', platform: 'aws', perm: 'aws:ecs:view', base: '/aws/ecs',
    sql: `SELECT service_name AS title, cluster_name AS subtitle FROM aws_ecs_services WHERE service_name LIKE ? ESCAPE '\\' ORDER BY service_name LIMIT ?` },
  { key: 'aws-rds', label: 'AWS RDS Instances', platform: 'aws', perm: 'aws:rds:view', base: '/aws/rds',
    sql: `SELECT r.db_id AS title, (COALESCE(r.engine, '') || ' · ' || a.name) AS subtitle
          FROM aws_rds_instances r JOIN aws_accounts a ON a.id = r.account_id
          WHERE r.db_id LIKE ? ESCAPE '\\' ORDER BY r.db_id LIMIT ?` },
  { key: 'aws-lambda', label: 'AWS Lambda Functions', platform: 'aws', perm: 'aws:lambda:view', base: '/aws/lambda',
    sql: `SELECT l.name AS title, (COALESCE(l.runtime, '') || ' · ' || a.name) AS subtitle
          FROM aws_lambda_functions l JOIN aws_accounts a ON a.id = l.account_id
          WHERE l.name LIKE ? ESCAPE '\\' ORDER BY l.name LIMIT ?` },
  { key: 'aws-dynamo', label: 'AWS DynamoDB Tables', platform: 'aws', perm: 'aws:dynamo:view', base: '/aws/dynamo',
    sql: `SELECT d.name AS title, (COALESCE(d.status, '') || ' · ' || a.name) AS subtitle
          FROM aws_dynamo_tables d JOIN aws_accounts a ON a.id = d.account_id
          WHERE d.name LIKE ? ESCAPE '\\' ORDER BY d.name LIMIT ?` },
];

const platformEnabled = (id) => {
  // WP0: cohesity is no longer a hardcoded always-on exception — it's gated
  // on registry presence, so a future registry-installed cohesity plugin
  // wins on its own `enabled` flag. Today it's never registered, so this is
  // identical to the old `id === 'cohesity'` hardcode.
  if (id === 'cohesity') {
    const entry = registry.getPlugin('cohesity');
    return entry ? entry.enabled : registry.isBuiltinPresent('cohesity');
  }
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
