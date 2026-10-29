// vCenter groups: free tags over registered vCenters, plus the read-only
// capacity sites. Every function takes the db handle first so a pack can reuse it.

const listGroups = (db) => {
  const groups = db.prepare('SELECT id, name, color, sort_order FROM vcenter_groups ORDER BY sort_order, name').all();
  const members = db.prepare('SELECT group_id, vcenter_id FROM vcenter_group_members ORDER BY vcenter_id').all();
  const byGroup = new Map();
  for (const m of members) {
    if (!byGroup.has(m.group_id)) byGroup.set(m.group_id, []);
    byGroup.get(m.group_id).push(m.vcenter_id);
  }
  return groups.map((g) => ({
    id: g.id, name: g.name, color: g.color || null, sortOrder: g.sort_order, vcenterIds: byGroup.get(g.id) || [],
  }));
};

const getGroup = (db, id) => listGroups(db).find((g) => g.id === Number(id)) || null;

const listSites = (db) => {
  const sites = db.prepare('SELECT id, name, color FROM vcenter_sites ORDER BY sort_order, name').all();
  const rows = db.prepare('SELECT DISTINCT site_id, vcenter_id FROM vcenter_site_members ORDER BY vcenter_id').all();
  const bySite = new Map();
  for (const r of rows) {
    if (!bySite.has(r.site_id)) bySite.set(r.site_id, []);
    bySite.get(r.site_id).push(r.vcenter_id);
  }
  return sites.map((s) => ({ id: s.id, name: s.name, color: s.color || null, vcenterIds: bySite.get(s.id) || [] }));
};

const knownVcenterIds = (db, ids) => {
  const have = new Set(db.prepare('SELECT id FROM vcenter_vcenters').all().map((r) => r.id));
  return [...new Set((ids || []).map(Number))].filter((n) => have.has(n));
};

function setGroupMembers(db, groupId, vcenterIds) {
  const ids = knownVcenterIds(db, vcenterIds);
  const ins = db.prepare('INSERT OR IGNORE INTO vcenter_group_members (group_id, vcenter_id) VALUES (?, ?)');
  db.transaction(() => {
    db.prepare('DELETE FROM vcenter_group_members WHERE group_id = ?').run(groupId);
    for (const v of ids) ins.run(groupId, v);
  })();
}

function setVcenterGroups(db, vcenterId, groupIds) {
  const have = new Set(db.prepare('SELECT id FROM vcenter_groups').all().map((r) => r.id));
  const ids = [...new Set((groupIds || []).map(Number))].filter((n) => have.has(n));
  const ins = db.prepare('INSERT OR IGNORE INTO vcenter_group_members (group_id, vcenter_id) VALUES (?, ?)');
  db.transaction(() => {
    db.prepare('DELETE FROM vcenter_group_members WHERE vcenter_id = ?').run(vcenterId);
    for (const g of ids) ins.run(g, vcenterId);
  })();
}

function groupsByVcenter(db) {
  const rows = db.prepare(`
    SELECT m.vcenter_id, g.id, g.name, g.color
    FROM vcenter_group_members m JOIN vcenter_groups g ON g.id = m.group_id
    ORDER BY g.sort_order, g.name
  `).all();
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.vcenter_id)) map.set(r.vcenter_id, []);
    map.get(r.vcenter_id).push({ id: r.id, name: r.name, color: r.color || null });
  }
  return map;
}

module.exports = { listGroups, getGroup, listSites, setGroupMembers, setVcenterGroups, groupsByVcenter };
