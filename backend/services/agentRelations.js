// Ops Agent relations: one-line statements of how the systems in an incident
// connect across platforms (VM -> ESX host -> Dell server, VM -> Cohesity
// group, VM -> Zerto VPG, host -> switch ports, app -> servers), computed from
// tables ICC already holds and emitted into evidence.relations. A line exists
// only when its rows exist and every platform it touches is enabled for the
// tenant; there is no standing primer on platforms that are absent. Every
// query is guarded, because a platform's table may not exist on a branch or
// pack-served install.
const db = require('../db/database');
const logger = require('../utils/logger');
const registry = require('../core/registry');
const { getSetting } = require('./settings');

const MAX_LINES = 8;
const MAX_LINE_CHARS = 200;
const MAX_HOSTS = 6;

function platformOn(id) {
  if (id === 'cohesity') return getSetting('platform_cohesity_enabled') !== '0';
  try { const p = registry.getPlugin(id); return !!(p && p.enabled && p.status !== 'error'); } catch { return false; }
}

function all(sql, ...args) {
  try { return db.prepare(sql).all(...args); } catch { return []; }
}
const one = (sql, ...args) => all(sql, ...args)[0] || null;

const lc = (s) => String(s || '').trim().toLowerCase();
const shortOf = (s) => lc(s).split('.')[0];
/** Alert host strings sometimes carry a suffix ("web01 (vm)"): keep the name. */
const cleanHost = (s) => String(s || '').replace(/\s*\([^)]*\)\s*$/, '').split(/[\s,]/)[0].trim();

function listOf(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String);
  const s = String(v).trim();
  if (s.startsWith('[')) { try { const j = JSON.parse(s); if (Array.isArray(j)) return j.map(String); } catch { /* fall through */ } }
  return s.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
}

function ageText(ms) {
  if (!ms) return 'none recorded';
  const h = Math.max(0, Math.round((Date.now() - Number(ms)) / 3600000));
  return h < 48 ? `${h} hours ago` : `${Math.round(h / 24)} days ago`;
}

function vmRow(host) {
  const names = [...new Set([lc(host), shortOf(host)].filter(Boolean))];
  if (!names.length) return null;
  const ph = names.map(() => '?').join(',');
  return one(`
    SELECT v.name, v.host_name, v.cluster_name, v.guest_hostname, vc.name AS vcenter
    FROM vcenter_vms v LEFT JOIN vcenter_vcenters vc ON vc.id = v.vcenter_id
    WHERE lower(v.name) IN (${ph}) OR lower(COALESCE(v.guest_hostname, '')) IN (${ph})
       OR lower(substr(v.name, 1, instr(v.name || '.', '.') - 1)) IN (${ph})
    LIMIT 1`, ...names, ...names, ...names);
}

function esxRow(name) {
  const names = [...new Set([lc(name), shortOf(name)].filter(Boolean))];
  if (!names.length) return null;
  const ph = names.map(() => '?').join(',');
  return one(`
    SELECT h.name, h.cluster_name, h.service_tag, vc.name AS vcenter
    FROM vcenter_hosts h LEFT JOIN vcenter_vcenters vc ON vc.id = h.vcenter_id
    WHERE lower(h.name) IN (${ph}) OR lower(substr(h.name, 1, instr(h.name || '.', '.') - 1)) IN (${ph})
    LIMIT 1`, ...names, ...names);
}

function cohesityObjectFor(names) {
  const list = [...new Set(names.map(lc).filter(Boolean))];
  if (!list.length) return null;
  const ph = list.map(() => '?').join(',');
  return one(`
    SELECT o.name, o.is_protected, o.last_backup_ms, o.protection_groups, c.name AS cluster
    FROM cohesity_objects o LEFT JOIN clusters c ON c.id = o.cluster_id
    WHERE lower(o.name) IN (${ph})
       OR (instr(o.name, '.') > 0 AND lower(substr(o.name, 1, instr(o.name, '.') - 1)) IN (${ph}))
    ORDER BY COALESCE(o.last_backup_ms, 0) DESC LIMIT 1`, ...list, ...list);
}

// ---------------------------------------------------------------------------
// Templates. Each takes ctx { host, alertsOn(platform), ... } and returns a
// string or null. They are independent: one failing never blocks another.
// ---------------------------------------------------------------------------

const TEMPLATES = {
  vm_host(h) {
    if (!platformOn('vcenter')) return null;
    const vm = vmRow(h);
    if (!vm || !vm.host_name) return null;
    return `VM ${vm.name} runs on host ${vm.host_name}${vm.cluster_name ? ` in cluster ${vm.cluster_name}` : ''}${vm.vcenter ? ` (${vm.vcenter})` : ''}`;
  },

  vm_cohesity(h) {
    if (!platformOn('vcenter') || !platformOn('cohesity')) return null;
    const vm = vmRow(h);
    if (!vm) return null;
    const obj = cohesityObjectFor([vm.name, shortOf(vm.name), vm.guest_hostname]);
    if (!obj || !obj.is_protected) return null;
    const group = listOf(obj.protection_groups).slice(0, 2).join(', ');
    return `${vm.name} is protected by Cohesity ${group ? `group ${group}` : 'protection'} on ${obj.cluster || 'a cluster'}, last good backup ${ageText(obj.last_backup_ms)}`;
  },

  vm_zerto(h) {
    if (!platformOn('vcenter') || !platformOn('zerto')) return null;
    const vm = vmRow(h);
    if (!vm) return null;
    const z = one('SELECT vpg_names, vpg_statuses FROM zerto_vms WHERE lower(name) IN (?, ?) LIMIT 1', lc(vm.name), shortOf(vm.name));
    if (!z) return null;
    const vpgs = listOf(z.vpg_names);
    if (!vpgs.length) return null;
    const statuses = listOf(z.vpg_statuses);
    return `${vm.name} is replicated by Zerto VPG ${vpgs.slice(0, 2).join(', ')}${statuses.length ? ` (${statuses.slice(0, 2).join(', ')})` : ''}`;
  },

  host_dell(h) {
    if (!platformOn('vcenter') || !platformOn('dell')) return null;
    const esx = esxRow(h) || (() => { const vm = vmRow(h); return vm && vm.host_name ? esxRow(vm.host_name) : null; })();
    if (!esx || !esx.service_tag) return null;
    const d = one('SELECT model, service_tag, health FROM dell_devices WHERE lower(service_tag) = ? LIMIT 1', lc(esx.service_tag));
    if (!d) return null;
    return `host ${esx.name} is Dell ${d.model || 'server'}, service tag ${d.service_tag}, OME status ${d.health || 'unknown'}`;
  },

  host_lm_uplinks(h) {
    if (!platformOn('logicmonitor')) return null;
    const esx = esxRow(h) || (() => { const vm = vmRow(h); return vm && vm.host_name ? esxRow(vm.host_name) : null; })();
    const target = esx ? esx.name : h;
    let ports = [];
    try { ports = require('./logicmonitorEndpoints').serverPath(db, { names: [target], ips: [] }).switchPorts || []; } catch { return null; }
    ports = ports.filter((p) => p && p.deviceName).slice(0, 3);
    if (!ports.length) return null;
    return `host ${target} uplinks: ${ports.map((p) => `${p.deviceName} ${p.port || '?'} (${p.statusText || p.tone || 'unknown'})`).join(', ')}`;
  },

  // The identity index says this host is also an object on other platforms
  // (a Dell server that is an ESX host and an LM device, a VM that is a
  // Cohesity object). One line per host listing every other platform.
  identity_links(h, ctx) {
    let rec = null;
    try {
      const hi = require('./hostIdentity');
      rec = hi.resolveToken(hi.buildIdentityIndex(db), h);
    } catch { return null; }
    if (!rec) return null;
    const entries = [{ platform: rec.platform, ref: rec.label || rec.refKey }];
    for (const a of rec.alsoKnownAs || []) entries.push({ platform: a.platform, ref: a.refKey });
    for (const p of rec.platforms || []) if (!entries.some((e) => e.platform === p)) entries.push({ platform: p, ref: rec.label || rec.refKey });
    if (entries.length < 2) return null;
    const { platformMeta } = require('./platformMeta');
    const seen = new Set();
    const others = entries.filter((e) => {
      if (!e.platform || seen.has(e.platform) || ctx.alertsOn(e.platform) || !platformOn(e.platform)) return false;
      seen.add(e.platform);
      return true;
    });
    if (!others.length) return null;
    return `${h} is also ${others.slice(0, 4).map((e) => `${platformMeta(e.platform).label} ${e.ref}`).join(', ')}`;
  },

  // Reverse of vm_cohesity: the incident host is a Cohesity object that is a vCenter VM.
  cohesity_vm(h, ctx) {
    if (!ctx.alertsOn('cohesity') || !platformOn('vcenter') || !platformOn('cohesity')) return null;
    const obj = cohesityObjectFor([h, shortOf(h)]);
    if (!obj) return null;
    const vm = vmRow(obj.name);
    if (!vm) return null;
    return `Cohesity object ${obj.name} is vCenter VM ${vm.name}${vm.host_name ? ` on host ${vm.host_name}` : ''}`;
  },

  // Reverse of host_dell: the incident host is a Dell device that is an ESX host.
  dell_host(h, ctx) {
    if (!ctx.alertsOn('dell') || !platformOn('vcenter') || !platformOn('dell')) return null;
    const d = one('SELECT service_tag FROM dell_devices WHERE lower(name) IN (?, ?) OR lower(service_tag) = ? LIMIT 1', lc(h), shortOf(h), lc(h));
    if (!d || !d.service_tag) return null;
    const esx = one(`SELECT h.name, h.cluster_name FROM vcenter_hosts h WHERE lower(h.service_tag) = ? LIMIT 1`, lc(d.service_tag));
    if (!esx) return null;
    return `service tag ${d.service_tag} is ESX host ${esx.name}${esx.cluster_name ? ` in cluster ${esx.cluster_name}` : ''}`;
  },
};

function appServerLines(evidence) {
  const out = [];
  const seen = new Set();
  for (const h of (evidence && evidence.hosts) || []) {
    const app = h && h.app;
    if (!app || !app.usageId || seen.has(app.usageId)) continue;
    seen.add(app.usageId);
    const names = (app.servers || []).map((s) => (s && (s.name || s.vm)) || String(s)).filter(Boolean);
    if (!names.length) continue;
    out.push(`${app.label || 'App service'} (${app.usageId}) runs on ${names.length} server${names.length === 1 ? '' : 's'}: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', ...' : ''}`);
  }
  return out;
}

/** relation lines for one incident; never throws. */
function relationLines(evidence, alerts) {
  const lines = [];
  const add = (l) => { if (l) { const t = String(l).slice(0, MAX_LINE_CHARS); if (!lines.includes(t)) lines.push(t); } };
  try {
    const hosts = [];
    for (const h of (evidence && evidence.hosts) || []) if (h && h.host) hosts.push(cleanHost(h.host));
    for (const a of alerts || []) if (a && a.host && !a.cleared_at) hosts.push(cleanHost(a.host));
    for (const a of (evidence && evidence.alerts) || []) if (a && a.host && !a.cleared) hosts.push(cleanHost(a.host));
    const uniq = [...new Set(hosts.filter(Boolean))].slice(0, MAX_HOSTS);
    for (const h of uniq) {
      const hl = lc(h);
      const alertsOn = (platform) => (alerts || []).some((a) => a.platform === platform && !a.cleared_at && lc(cleanHost(a.host)) === hl)
        || ((evidence && evidence.alerts) || []).some((a) => a.platform === platform && !a.cleared && lc(cleanHost(a.host)) === hl);
      for (const [id, fn] of Object.entries(TEMPLATES)) {
        try { add(fn(h, { alertsOn })); } catch (err) { logger.debug(`[OpsAgent] relation ${id} skipped: ${err.message}`); }
      }
    }
    for (const l of appServerLines(evidence)) add(l);
  } catch (err) { logger.warn(`[OpsAgent] relations skipped: ${err.message}`); }
  return lines.slice(0, MAX_LINES);
}

module.exports = { relationLines, TEMPLATES, MAX_LINES, MAX_LINE_CHARS };
