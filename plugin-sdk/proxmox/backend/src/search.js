// Global search contribution (manifest field `searchCategories`, host
// contract landed 2026-08-03 — see backend/core/registry.js
// getSearchCategoryContributors() and backend/routes/search.js). Ported
// verbatim from the built-in categories in backend/routes/search.js.
const searchCategories = [
  {
    key: 'proxmox-guests', label: 'Proxmox Guests', platform: 'proxmox', perm: 'proxmox:guests:view', base: '/proxmox/guests',
    sql: `SELECT g.name AS title, (COALESCE(g.node, '') || ' · ' || s.name) AS subtitle
          FROM proxmox_guests g JOIN proxmox_servers s ON s.id = g.server_id
          WHERE g.name LIKE ? ESCAPE '\\' ORDER BY g.name LIMIT ?`,
  },
  {
    key: 'proxmox-nodes', label: 'Proxmox Nodes', platform: 'proxmox', perm: 'proxmox:nodes:view', base: '/proxmox/nodes',
    sql: `SELECT n.name AS title, s.name AS subtitle
          FROM proxmox_nodes n JOIN proxmox_servers s ON s.id = n.server_id
          WHERE n.name LIKE ? ESCAPE '\\' ORDER BY n.name LIMIT ?`,
  },
];

module.exports = { searchCategories };
