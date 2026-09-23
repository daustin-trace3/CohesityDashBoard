// Guest storage reads for the Guest Storage page and the CSV report: guest
// filesystems (VMware Tools guest.disk) and virtual disks, with the owner tag
// resolved per vCenter and the threshold state applied. Ported from
// backend/services/vcenterGuestStorage.js; db and settings come from coreApi.
const { guestDiskThresholds, ownerFromTags } = require('./issues');

const PAGE_SIZE_MAX = 200;
const FS_SORT_KEYS = ['used_pct', 'vm_name', 'mount', 'capacity_bytes', 'free_bytes', 'used_bytes', 'owner', 'vcenter_name', 'days_to_full', 'growth_bytes_per_day'];
const DISK_SORT_KEYS = ['capacity_bytes', 'used_bytes', 'used_pct', 'vm_name', 'label', 'datastore', 'vcenter_name', 'owner'];
const STATES = ['all', 'attention', 'critical', 'warning', 'ok'];

function stateOf(pct, t) {
  if (pct == null) return 'unknown';
  if (pct >= t.crit) return 'critical';
  if (pct >= t.warn) return 'warning';
  return 'ok';
}

function growthBaselines(db, vcenterId) {
  const rows = db.prepare(`
    SELECT h.vcenter_id, h.vm_id, h.mount, h.day, h.capacity_bytes, h.free_bytes
    FROM vcenter_vm_filesystem_history h
    WHERE h.day >= date('now', '-30 days') ${vcenterId ? 'AND h.vcenter_id = ?' : ''}
      AND h.day = (
        SELECT MIN(h2.day) FROM vcenter_vm_filesystem_history h2
        WHERE h2.vcenter_id = h.vcenter_id AND h2.vm_id = h.vm_id AND h2.mount = h.mount
          AND h2.day >= date('now', '-30 days')
      )
  `).all(...(vcenterId ? [vcenterId] : []));
  const map = new Map();
  for (const r of rows) map.set(`${r.vcenter_id}|${r.vm_id}|${r.mount}`, r);
  return map;
}

function daysBetween(dayStr) {
  const then = new Date(`${dayStr}T00:00:00Z`).getTime();
  return Number.isFinite(then) ? (Date.now() - then) / 86400000 : null;
}

function baseFilesystemRows(db, vcenterId) {
  return db.prepare(`
    SELECT f.id, f.vcenter_id, f.vm_id, f.vm_name, f.mount, f.fs_type, f.capacity_bytes, f.free_bytes, f.used_pct,
           f.captured_at, v.name AS vcenter_name, v.owner_tag_category,
           m.id AS vm_row_id, m.tags, m.power_state, m.tools_status, m.host_name, m.cluster_name, m.guest_os
    FROM vcenter_vm_filesystems f
    JOIN vcenter_vcenters v ON v.id = f.vcenter_id
    LEFT JOIN vcenter_vms m ON m.vcenter_id = f.vcenter_id AND m.vm_id = f.vm_id
    ${vcenterId ? 'WHERE f.vcenter_id = ?' : ''}
  `).all(...(vcenterId ? [vcenterId] : []));
}

function shapeFilesystem(r, t, baselines) {
  const usedBytes = r.capacity_bytes != null && r.free_bytes != null ? Math.max(0, r.capacity_bytes - r.free_bytes) : null;
  let growth = null;
  let daysToFull = null;
  const base = baselines.get(`${r.vcenter_id}|${r.vm_id}|${r.mount}`);
  if (base && base.free_bytes != null && usedBytes != null && base.capacity_bytes != null) {
    const days = daysBetween(base.day);
    if (days != null && days >= 3) {
      const usedThen = Math.max(0, base.capacity_bytes - base.free_bytes);
      growth = Math.round((usedBytes - usedThen) / days);
      if (growth > 0 && r.free_bytes != null) daysToFull = Math.round(r.free_bytes / growth);
    }
  }
  return {
    id: r.id, vcenter_id: r.vcenter_id, vcenter_name: r.vcenter_name,
    vm_id: r.vm_id, vm_row_id: r.vm_row_id, vm_name: r.vm_name,
    owner: ownerFromTags(r.tags, r.owner_tag_category),
    mount: r.mount, fs_type: r.fs_type,
    capacity_bytes: r.capacity_bytes, free_bytes: r.free_bytes, used_bytes: usedBytes, used_pct: r.used_pct,
    state: stateOf(r.used_pct, t),
    growth_bytes_per_day: growth, days_to_full: daysToFull,
    power_state: r.power_state, tools_status: r.tools_status, host_name: r.host_name,
    cluster_name: r.cluster_name, guest_os: r.guest_os, captured_at: r.captured_at,
  };
}

function applyFsFilters(rows, opts) {
  let list = rows;
  const state = STATES.includes(opts.state) ? opts.state : 'all';
  if (state === 'attention') list = list.filter((r) => r.state === 'critical' || r.state === 'warning');
  else if (state !== 'all') list = list.filter((r) => r.state === state);
  if (opts.owner) {
    const want = String(opts.owner).toLowerCase();
    list = list.filter((r) => (want === '(none)' ? !r.owner : String(r.owner || '').toLowerCase() === want));
  }
  if (opts.q) {
    const needle = String(opts.q).toLowerCase();
    list = list.filter((r) => [r.vm_name, r.mount, r.owner, r.host_name, r.cluster_name, r.vcenter_name, r.guest_os]
      .some((v) => String(v || '').toLowerCase().includes(needle)));
  }
  return list;
}

function sortRows(rows, sortBy, sortDir, keys, dflt) {
  const key = keys.includes(sortBy) ? sortBy : dflt;
  const dir = sortDir === 'asc' ? 1 : -1;
  const tie = (a, b) => String(a.vm_name || '').localeCompare(String(b.vm_name || '')) || String(a.mount || a.label || '').localeCompare(String(b.mount || b.label || ''));
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av == null && bv == null) return tie(a, b);
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return dir * (av - bv) || tie(a, b);
    return dir * String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }) || tie(a, b);
  });
}

function paginate(rows, opts) {
  const pageSize = opts.pageSize === 'all' ? Math.max(1, rows.length) : Math.min(PAGE_SIZE_MAX, Math.max(1, Number(opts.pageSize) || 25));
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(Math.max(0, Number(opts.page) || 0), totalPages - 1);
  return { page: { page, pageSize, total: rows.length, totalPages }, rows: rows.slice(page * pageSize, (page + 1) * pageSize) };
}

function filesystemSummary(db, t, vcenterId, shaped) {
  const vmsWithData = new Set();
  const vmsCritical = new Set();
  const vmsWarning = new Set();
  let critical = 0;
  let warning = 0;
  let capacity = 0;
  let used = 0;
  const owners = new Map();
  for (const r of shaped) {
    vmsWithData.add(`${r.vcenter_id}|${r.vm_id}`);
    if (r.state === 'critical') { critical++; vmsCritical.add(`${r.vcenter_id}|${r.vm_id}`); }
    else if (r.state === 'warning') { warning++; vmsWarning.add(`${r.vcenter_id}|${r.vm_id}`); }
    capacity += r.capacity_bytes || 0;
    used += r.used_bytes || 0;
    const o = r.owner || '(none)';
    owners.set(o, (owners.get(o) || 0) + 1);
  }
  const vcFilter = vcenterId ? 'AND m.vcenter_id = ?' : '';
  const vcArgs = vcenterId ? [vcenterId] : [];
  const noData = db.prepare(`
    SELECT COUNT(*) AS c FROM vcenter_vms m
    WHERE m.power_state = 'POWERED_ON' ${vcFilter}
      AND NOT EXISTS (SELECT 1 FROM vcenter_vm_filesystems f WHERE f.vcenter_id = m.vcenter_id AND f.vm_id = m.vm_id)
  `).get(...vcArgs).c;
  const toolsDown = db.prepare(`
    SELECT COUNT(*) AS c FROM vcenter_vms m
    WHERE m.power_state = 'POWERED_ON' ${vcFilter}
      AND COALESCE(m.tools_status, '') <> 'guestToolsRunning'
  `).get(...vcArgs).c;
  return {
    thresholds: t,
    volumes: shaped.length,
    vms: vmsWithData.size,
    critical, warning,
    vmsCritical: vmsCritical.size, vmsWarning: vmsWarning.size,
    capacityBytes: capacity, usedBytes: used,
    poweredOnWithoutData: noData,
    poweredOnToolsNotRunning: toolsDown,
    owners: [...owners.entries()].map(([owner, volumes]) => ({ owner, volumes })).sort((a, b) => a.owner.localeCompare(b.owner)),
  };
}

function listFilesystems(coreApi, opts = {}) {
  const db = coreApi.db;
  const t = guestDiskThresholds(coreApi);
  const vcenterId = opts.vcenterId ? Number(opts.vcenterId) : null;
  const baselines = growthBaselines(db, vcenterId);
  const shaped = baseFilesystemRows(db, vcenterId).map((r) => shapeFilesystem(r, t, baselines));
  const filtered = applyFsFilters(shaped, opts);
  const sorted = sortRows(filtered, opts.sortBy, opts.sortDir || 'desc', FS_SORT_KEYS, 'used_pct');
  const paged = paginate(sorted, opts);
  return { summary: filesystemSummary(db, t, vcenterId, shaped), ...paged };
}

function listDisks(coreApi, opts = {}) {
  const db = coreApi.db;
  const vcenterId = opts.vcenterId ? Number(opts.vcenterId) : null;
  const rows = db.prepare(`
    SELECT d.*, v.name AS vcenter_name, v.owner_tag_category, m.id AS vm_row_id, m.tags, m.power_state
    FROM vcenter_vm_disks d
    JOIN vcenter_vcenters v ON v.id = d.vcenter_id
    LEFT JOIN vcenter_vms m ON m.vcenter_id = d.vcenter_id AND m.vm_id = d.vm_id
    ${vcenterId ? 'WHERE d.vcenter_id = ?' : ''}
  `).all(...(vcenterId ? [vcenterId] : [])).map((r) => ({
    id: r.id, vcenter_id: r.vcenter_id, vcenter_name: r.vcenter_name, vm_id: r.vm_id, vm_row_id: r.vm_row_id,
    vm_name: r.vm_name, owner: ownerFromTags(r.tags, r.owner_tag_category), disk_key: r.disk_key, label: r.label,
    capacity_bytes: r.capacity_bytes, used_bytes: r.used_bytes,
    used_pct: r.capacity_bytes > 0 && r.used_bytes != null ? Math.round((r.used_bytes / r.capacity_bytes) * 1000) / 10 : null,
    thin: r.thin, datastore: r.datastore, file_name: r.file_name, power_state: r.power_state, captured_at: r.captured_at,
  }));
  let filtered = rows;
  if (opts.q) {
    const needle = String(opts.q).toLowerCase();
    filtered = rows.filter((r) => [r.vm_name, r.label, r.datastore, r.owner, r.vcenter_name, r.file_name]
      .some((v) => String(v || '').toLowerCase().includes(needle)));
  }
  if (opts.thin === '1') filtered = filtered.filter((r) => r.thin === 1);
  const sorted = sortRows(filtered, opts.sortBy, opts.sortDir || 'desc', DISK_SORT_KEYS, 'capacity_bytes');
  const paged = paginate(sorted, opts);
  const summary = {
    disks: rows.length,
    vms: new Set(rows.map((r) => `${r.vcenter_id}|${r.vm_id}`)).size,
    provisionedBytes: rows.reduce((n, r) => n + (r.capacity_bytes || 0), 0),
    usedBytes: rows.reduce((n, r) => n + (r.used_bytes || 0), 0),
    thin: rows.filter((r) => r.thin === 1).length,
  };
  return { summary, ...paged };
}

function vmStorage(coreApi, vcenterId, vmId) {
  const db = coreApi.db;
  const t = guestDiskThresholds(coreApi);
  const baselines = growthBaselines(db, vcenterId);
  const filesystems = baseFilesystemRows(db, vcenterId).filter((r) => r.vm_id === vmId).map((r) => shapeFilesystem(r, t, baselines));
  const disks = db.prepare(`
    SELECT d.* FROM vcenter_vm_disks d WHERE d.vcenter_id = ? AND d.vm_id = ? ORDER BY d.disk_key
  `).all(vcenterId, vmId).map((r) => ({
    ...r,
    used_pct: r.capacity_bytes > 0 && r.used_bytes != null ? Math.round((r.used_bytes / r.capacity_bytes) * 1000) / 10 : null,
  }));
  return { thresholds: t, filesystems: sortRows(filesystems, 'used_pct', 'desc', FS_SORT_KEYS, 'used_pct'), disks };
}

const gb = (b) => (b == null ? '' : (b / 1e9).toFixed(1));

function filesystemsCsv(coreApi, opts = {}) {
  const { rows } = listFilesystems(coreApi, { ...opts, pageSize: 'all', page: 0 });
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['vCenter', 'VM', 'Owner', 'Volume', 'Filesystem', 'Capacity GB', 'Used GB', 'Free GB', 'Used %', 'State',
    'Growth GB/day', 'Days to full', 'Host', 'Cluster', 'Guest OS', 'Power', 'Captured'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([r.vcenter_name, r.vm_name, r.owner, r.mount, r.fs_type, gb(r.capacity_bytes), gb(r.used_bytes), gb(r.free_bytes),
      r.used_pct, r.state, r.growth_bytes_per_day == null ? '' : (r.growth_bytes_per_day / 1e9).toFixed(2), r.days_to_full,
      r.host_name, r.cluster_name, r.guest_os, r.power_state, r.captured_at].map(esc).join(','));
  }
  return lines.join('\r\n');
}

function tagCategories(coreApi, vcenterId) {
  const rows = coreApi.db.prepare(`
    SELECT DISTINCT jt.value AS tag FROM vcenter_vms m, json_each(COALESCE(m.tags, '[]')) jt
    ${vcenterId ? 'WHERE m.vcenter_id = ?' : ''}
  `).all(...(vcenterId ? [vcenterId] : []));
  const cats = new Map();
  for (const r of rows) {
    const i = String(r.tag).indexOf(':');
    if (i === -1) continue;
    const c = String(r.tag).slice(0, i).trim();
    if (c) cats.set(c, (cats.get(c) || 0) + 1);
  }
  return [...cats.entries()].map(([category, tags]) => ({ category, tags })).sort((a, b) => a.category.localeCompare(b.category));
}

module.exports = {
  PAGE_SIZE_MAX, FS_SORT_KEYS, DISK_SORT_KEYS, STATES,
  listFilesystems, listDisks, vmStorage, filesystemsCsv, tagCategories,
};
