// Server 360 contribution (host manifest hook, 2026-08-03): when the ops
// Server 360 page pivots on a name/IP, the host calls server360(coreApi, ctx)
// on every enabled installed plugin and renders the returned DISPLAY-READY
// section generically (see backend/core/registry.js getServer360Providers()
// and backend/routes/server360.js). Reference implementation: rubrik's
// plugin-sdk/rubrik/backend/src/server360.js.
//
// Ported from the built-in's raw `proxmox: { guests: [...] }` contribution in
// backend/routes/server360.js (guest lookup by name OR agent-reported IP),
// reshaped into display-ready facts/lines/link groups.
const ACCENT = '#E57000';

const fmtBytes = (b) => {
  if (b == null) return '—';
  if (b >= 1e12) return `${(b / 1e12).toLocaleString(undefined, { maximumFractionDigits: 2 })} TB`;
  if (b >= 1e9) return `${(b / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  if (b >= 1e6) return `${(b / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
  return `${Number(b).toLocaleString()} B`;
};

const backupTone = (status) => (status === 'OK' ? 'ok' : status ? 'crit' : 'neutral');

function server360(coreApi, { names, ips } = {}) {
  const nameList = (names || []).map((n) => String(n).toLowerCase()).filter(Boolean);
  const ipList = (ips || []).filter(Boolean);
  if (!nameList.length && !ipList.length) return null;

  const db = coreApi.db;
  const rows = new Map();

  if (nameList.length) {
    const ph = nameList.map(() => '?').join(',');
    for (const g of db.prepare(`
      SELECT g.*, s.name AS server_name FROM proxmox_guests g JOIN proxmox_servers s ON s.id = g.server_id
      WHERE lower(g.name) IN (${ph})
    `).all(...nameList)) rows.set(g.id, g);
  }
  for (const ip of ipList) {
    const pattern = `%"${String(ip).replace(/[\\%_]/g, (c) => `\\${c}`)}"%`;
    for (const g of db.prepare(`
      SELECT g.*, s.name AS server_name FROM proxmox_guests g JOIN proxmox_servers s ON s.id = g.server_id
      WHERE g.ip_addresses LIKE ? ESCAPE '\\'
    `).all(pattern)) rows.set(g.id, g);
  }

  const guests = [...rows.values()];
  if (!guests.length) return null;

  const groups = guests.map((g) => {
    let ipAddresses = [];
    try { ipAddresses = g.ip_addresses ? JSON.parse(g.ip_addresses) : []; } catch { ipAddresses = []; }
    const facts = [
      { label: 'Guest', value: `${g.name} (${g.type} ${g.vmid})` },
      { label: 'Server / Node', value: `${g.server_name} / ${g.node || '—'}` },
      { label: 'Status', value: g.status || '—', tone: g.status === 'running' ? 'ok' : 'neutral' },
      { label: 'OS', value: g.os_name || '—' },
      { label: 'IP(s)', value: ipAddresses.length ? ipAddresses.join(', ') : '—' },
      g.last_backup_at
        ? { label: 'Last Backup', value: `${g.last_backup_status || '—'} · ${new Date(g.last_backup_at).toLocaleDateString()}`, tone: backupTone(g.last_backup_status) }
        : { label: 'Last Backup', value: '—' },
      { label: 'Disk', value: `${fmtBytes(g.disk_used)} / ${fmtBytes(g.disk_total)}` },
    ];

    const lines = [`${g.snapshot_count || 0} snapshot(s)${g.oldest_snapshot_at ? ` · oldest ${String(g.oldest_snapshot_at).slice(0, 10)}` : ''}`];

    return {
      facts,
      lines,
      link: { label: 'Open Guest 360 →', href: `/proxmox/guest-360?id=${g.id}` },
    };
  });

  return { title: 'Backup (Proxmox VE)', chip: { label: 'Proxmox VE', color: ACCENT }, groups };
}

function server360Suggest(coreApi, q) {
  const term = String(q || '').trim();
  if (term.length < 2) return [];
  const pattern = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return coreApi.db
    .prepare(`SELECT DISTINCT name FROM proxmox_guests WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 8`)
    .all(pattern)
    .map((r) => r.name);
}

module.exports = { server360, server360Suggest };
