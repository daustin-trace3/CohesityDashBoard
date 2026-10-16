'use strict';

// Demo rows for the cross-platform identity columns (LogicMonitor round 9, WP4):
// dell_devices.idrac_mac and os_hostname, and vcenter_hosts.serial / service_tag.
//
// The demo's Dell servers (dcN-esx-NNN.demo.local) and vCenter hosts
// (<site>-esx-NNNN.icc.demo) have no name overlap, so OVERLAP_HOSTS vCenter hosts
// are paired with the first Dell servers by id order: the vCenter host takes the
// Dell service tag as serial and service_tag, and the Dell OS hostname becomes the
// vCenter host's short name (the OS component row is updated to match).
//
// Idempotent. Packs re-seed vcenter tables at demo boot, so server.js calls this
// again after the packs have seeded.

const OVERLAP_HOSTS = 6;

function macFor(deviceId) {
  const h = (Math.imul(deviceId, 2654435761) >>> 0).toString(16).padStart(8, '0');
  return `c8:4b:d6:${h.slice(0, 2)}:${h.slice(2, 4)}:${h.slice(4, 6)}`;
}

function applyHostIdentity(db) {
  const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  if (!has('dell_devices')) return { dell: 0, paired: 0 };

  const servers = db.prepare("SELECT id, ome_id, device_id, name, service_tag FROM dell_devices WHERE device_type = 'Server' ORDER BY ome_id, device_id").all();
  const upd = db.prepare('UPDATE dell_devices SET idrac_mac = ?, os_hostname = COALESCE(?, os_hostname) WHERE id = ?');
  const osRow = has('dell_components')
    ? db.prepare("SELECT id, extra FROM dell_components WHERE ome_id = ? AND device_id = ? AND kind = 'os'")
    : null;
  const setOs = has('dell_components') ? db.prepare('UPDATE dell_components SET extra = ? WHERE id = ?') : null;

  let paired = 0;
  const hosts = has('vcenter_hosts')
    ? db.prepare("SELECT id, name FROM vcenter_hosts WHERE connection_state IS NOT 'NOT_RESPONDING' ORDER BY id LIMIT ?").all(OVERLAP_HOSTS)
    : [];
  const pairByDell = new Map();
  hosts.forEach((h, i) => { if (servers[i] && servers[i].service_tag) pairByDell.set(servers[i].id, h); });

  for (const s of servers) {
    const h = pairByDell.get(s.id);
    let osHost = null;
    if (osRow) {
      const r = osRow.get(s.ome_id, s.device_id);
      let extra = {};
      try { extra = r?.extra ? JSON.parse(r.extra) : {}; } catch { extra = {}; }
      if (h) {
        extra.hostname = h.name.split('.')[0];
        if (r) setOs.run(JSON.stringify(extra), r.id);
      }
      osHost = extra.hostname || null;
    }
    if (!osHost) osHost = (s.name || '').split('.')[0] || null;
    upd.run(macFor(s.device_id), osHost, s.id);
  }
  const setVc = hosts.length ? db.prepare('UPDATE vcenter_hosts SET serial = ?, service_tag = ?, uuid = ? WHERE id = ?') : null;
  hosts.forEach((h, i) => {
    const s = servers[i];
    if (!s || !s.service_tag) return;
    setVc.run(s.service_tag, s.service_tag, `4c4c4544-${String(s.device_id).padStart(4, '0')}-0000-8000-${s.service_tag.toLowerCase().padEnd(12, '0').slice(0, 12)}`, h.id);
    paired += 1;
  });
  return { dell: servers.length, paired };
}

module.exports = { applyHostIdentity, macFor, OVERLAP_HOSTS };
