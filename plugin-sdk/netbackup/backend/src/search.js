// Global search contribution (manifest field `searchCategories`, host
// contract landed 2026-08-03 — see backend/core/registry.js
// getSearchCategoryContributors() and backend/routes/search.js). Ported
// verbatim from the built-in categories in backend/routes/search.js.
const searchCategories = [
  {
    key: 'netbackup-clients', label: 'NetBackup Clients', platform: 'netbackup', perm: 'netbackup:clients:view', base: '/netbackup/jobs',
    sql: `SELECT DISTINCT client_name AS title FROM netbackup_jobs WHERE client_name LIKE ? ESCAPE '\\' ORDER BY client_name LIMIT ?`,
  },
  {
    key: 'netbackup-policies', label: 'NetBackup Policies', platform: 'netbackup', perm: 'netbackup:policies:view', base: '/netbackup/policies',
    sql: `SELECT name AS title, policy_type AS subtitle FROM netbackup_policies WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?`,
  },
  {
    key: 'netbackup-appliances', label: 'NetBackup Appliances', platform: 'netbackup', perm: 'netbackup:appliances:view', base: '/netbackup/appliances',
    sql: `SELECT name AS title, appliance_type AS subtitle FROM netbackup_appliances WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?`,
  },
];

module.exports = { searchCategories };
