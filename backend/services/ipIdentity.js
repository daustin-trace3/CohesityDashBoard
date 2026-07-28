const db = require('../db/database');

/**
 * IP -> known machine name, from inventory the dashboard already polls:
 * vCenter VMs (primary IP + guest NICs) first, then Aria deployment
 * resources. Lets storage-client lists (NetApp NFS/CIFS) show which VM an
 * IP belongs to without relying on reverse DNS. Best-effort — platforms
 * that are absent or empty simply contribute nothing.
 */
function buildIpIndex() {
  const map = new Map();
  const claim = (ip, name, source) => {
    if (ip && name && !map.has(ip)) map.set(ip, { name, source });
  };
  try {
    for (const vm of db.prepare('SELECT name, ip_address, guest_nics FROM vcenter_vms').all()) {
      claim(vm.ip_address, vm.name, 'vcenter');
      try {
        for (const nic of JSON.parse(vm.guest_nics || '[]')) {
          for (const ip of (nic.ips || [])) claim(ip, vm.name, 'vcenter');
        }
      } catch { /* malformed nic json */ }
    }
  } catch { /* vcenter tables absent */ }
  try {
    for (const r of db.prepare('SELECT name, ip_addresses FROM aria_deployment_resources WHERE ip_addresses IS NOT NULL').all()) {
      try {
        for (const ip of JSON.parse(r.ip_addresses)) claim(ip, r.name, 'aria');
      } catch { /* malformed */ }
    }
  } catch { /* aria tables absent */ }
  return map;
}

module.exports = { buildIpIndex };
