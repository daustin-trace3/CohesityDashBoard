// Service Status page (contract): platform id -> display metadata. Built-ins
// are a static table (colors match frontend/src/components/Layout.jsx's
// per-platform accent map); an installed pack falls back to its own
// manifest name/color under a generic /<id> route.
const registry = require('../core/registry');

const BUILTIN = {
  cohesity: { label: 'Cohesity', color: '#6CB33F', route: '/cohesity', alertsRoute: '/cohesity/alerts' },
  pure: { label: 'Pure', color: '#FF6B00', route: '/pure', alertsRoute: '/pure/alerts' },
  netapp: { label: 'NetApp', color: '#0067C5', route: '/netapp', alertsRoute: '/netapp/alerts' },
  zerto: { label: 'Zerto', color: '#EE3124', route: '/zerto', alertsRoute: '/zerto/alerts' },
  vcenter: { label: 'vCenter', color: '#0091DA', route: '/vcenter', alertsRoute: '/vcenter/alerts' },
  dell: { label: 'Dell', color: '#007DB8', route: '/dell', alertsRoute: '/dell/alerts' },
  aria: { label: 'Aria', color: '#00A2C7', route: '/aria', alertsRoute: '/aria/alerts' },
  ariaops: { label: 'Aria Operations', color: '#78BE20', route: '/ariaops', alertsRoute: '/ariaops/alerts' },
  aws: { label: 'AWS', color: '#FF9900', route: '/aws', alertsRoute: '/aws/alerts' },
  unifi: { label: 'UniFi', color: '#006FFF', route: '/unifi', alertsRoute: '/unifi/alerts' },
  brocade: { label: 'Brocade', color: '#CC092F', route: '/brocade', alertsRoute: '/brocade/issues' },
  bluecat: { label: 'BlueCat', color: '#0057B8', route: '/bluecat', alertsRoute: '/bluecat/alerts' },
};

function platformMeta(id) {
  if (BUILTIN[id]) return BUILTIN[id];
  const entry = registry.getPlugin(id);
  if (entry) {
    return { label: entry.name, color: entry.color || '#64748B', route: `/${id}`, alertsRoute: `/${id}` };
  }
  return { label: id, color: '#64748B', route: `/${id}`, alertsRoute: `/${id}` };
}

module.exports = { BUILTIN, platformMeta };
