// Ops Agent dependencies: which system sits under which, read from tables ICC
// already holds. The agent uses it to fold an alert on a VM into the incident
// of the host, datastore, switch or site that broke under it, and to name the
// app services that ride on a failed component.
//
// Edges (kind: source of the edge):
//   host       vcenter_vms.host_name / hyperv_vms.host_name -> the host
//   datastore  vcenter_vms.datastores (JSON array of names) -> the datastore
//   switch     brocade_device_ports host -> switch; ESX hosts also through
//              LogicMonitor switch ports (lazy, only for the host asked about)
//   vpg        zerto_vms.vpg_names -> the VPG
//   site       zerto VPG and VM protected / recovery site -> the Zerto site
//   cluster    cohesity_objects.cluster_id -> the Cohesity cluster
//   source     vCenter and Hyper-V hosts and VMs -> the source that polls them
// App tags: vcenter_vms.tags "usage-id: <id>" joined to the watched apps.
//
// Everything is built once per database state (core/dbMemo) and then answered
// from Maps. Each reader is guarded and probes its columns, because a
// pack-served install may lag the host schema; a reader that fails
// contributes no edges and never throws.
const logger = require('../utils/logger');
const { memoByDbState } = require('../core/dbMemo');

const TAG_PREFIX = 'usage-id: ';
// First match wins when one child has several parents.
const KIND_ORDER = ['host', 'datastore', 'switch', 'vpg', 'site', 'cluster', 'source'];

// Same rule as opsAgent.hostKey; copied (not required) to avoid a require
// cycle, and tests/agentDependencies.test.js checks the two agree.
function hostKey(host) {
  let h = String(host || '').trim().toLowerCase();
  if (!h) return '';
  const at = h.indexOf(' @ ');
  if (at > 0) return h.slice(0, at).trim().replace(/\s+/g, '-');
  h = h.replace(/\s*\([^)]*\)\s*$/, '');
  h = h.split(/[\s,]/)[0];
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) h = h.split('.')[0];
  return h;
}

/** Host-like parents key by hostKey; datastores, VPGs, sites and clusters have
 *  free-form names (spaces, dots), so they key by the lower-cased full name. */
function parentKeyFor(kind, name) {
  if (kind === 'host' || kind === 'switch' || kind === 'source') return hostKey(name);
  return String(name || '').trim().toLowerCase();
}

function tableExists(db, name) {
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name); } catch { return false; }
}
function columnsOf(db, table) {
  try { return new Set(db.prepare(`PRAGMA table_info('${table}')`).all().map((c) => c.name)); } catch { return new Set(); }
}
/** SELECT the wanted columns that exist; [] when the table or all columns are missing. */
function readRows(db, table, wanted, tail = '') {
  try {
    if (!tableExists(db, table)) return [];
    const have = columnsOf(db, table);
    const cols = wanted.filter((c) => have.has(c));
    if (!cols.length) return [];
    return db.prepare(`SELECT ${cols.join(', ')} FROM ${table} ${tail}`).all();
  } catch (err) {
    logger.debug(`[AgentDeps] ${table} unreadable: ${err.message}`);
    return [];
  }
}
function listOf(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String);
  const s = String(v).trim();
  if (s.startsWith('[')) { try { const j = JSON.parse(s); if (Array.isArray(j)) return j.map(String); } catch { /* fall through */ } }
  return s.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
}

function build(db) {
  const parents = new Map();   // childKey -> [{kind, parent, parentKey, platform}]
  const children = new Map();  // `${kind}|${parentKey}` -> [{host, hostKey, platform, childKind}]
  const apps = new Map();      // childKey -> [{usageId, displayId, label}]
  const esxHosts = new Set();  // hostKey of every known vCenter / Hyper-V host
  const seenEdge = new Set();

  const edge = (child, childPlatform, childKind, kind, parent, parentPlatform) => {
    const ck = hostKey(child);
    const pk = parentKeyFor(kind, parent);
    if (!ck || !pk || !parent) return;
    const sig = `${ck}|${kind}|${pk}`;
    if (seenEdge.has(sig)) return;
    seenEdge.add(sig);
    if (!parents.has(ck)) parents.set(ck, []);
    parents.get(ck).push({ kind, parent: String(parent), parentKey: pk, platform: parentPlatform });
    const ckey = `${kind}|${pk}`;
    if (!children.has(ckey)) children.set(ckey, []);
    children.get(ckey).push({ host: String(child), hostKey: ck, platform: childPlatform, childKind });
  };

  // vCenter: VM -> host, VM -> datastores, host/VM -> vCenter, app tags.
  const vcNames = new Map();
  for (const r of readRows(db, 'vcenter_vcenters', ['id', 'name'])) vcNames.set(r.id, r.name);
  for (const h of readRows(db, 'vcenter_hosts', ['name', 'vcenter_id'])) {
    if (!h.name) continue;
    esxHosts.add(hostKey(h.name));
    if (vcNames.has(h.vcenter_id)) edge(h.name, 'vcenter', 'host', 'source', vcNames.get(h.vcenter_id), 'vcenter');
  }
  const vmRows = readRows(db, 'vcenter_vms', ['name', 'host_name', 'datastores', 'tags', 'vcenter_id']);
  const appTags = [];
  for (const v of vmRows) {
    if (!v.name) continue;
    if (v.host_name) edge(v.name, 'vcenter', 'vm', 'host', v.host_name, 'vcenter');
    for (const ds of listOf(v.datastores)) edge(v.name, 'vcenter', 'vm', 'datastore', ds, 'vcenter');
    if (vcNames.has(v.vcenter_id)) edge(v.name, 'vcenter', 'vm', 'source', vcNames.get(v.vcenter_id), 'vcenter');
    for (const t of listOf(v.tags)) {
      const tag = String(t).trim().toLowerCase();
      if (tag.startsWith(TAG_PREFIX)) appTags.push({ vm: v.name, usageId: tag.slice(TAG_PREFIX.length).trim() });
    }
  }

  // Hyper-V.
  const hvSources = new Map();
  for (const r of readRows(db, 'hyperv_sources', ['id', 'name'])) hvSources.set(r.id, r.name);
  for (const h of readRows(db, 'hyperv_hosts', ['name', 'source_id'])) {
    if (!h.name) continue;
    esxHosts.add(hostKey(h.name));
    if (hvSources.has(h.source_id)) edge(h.name, 'hyperv', 'host', 'source', hvSources.get(h.source_id), 'hyperv');
  }
  for (const v of readRows(db, 'hyperv_vms', ['name', 'host_name', 'source_id'])) {
    if (!v.name) continue;
    if (v.host_name) edge(v.name, 'hyperv', 'vm', 'host', v.host_name, 'hyperv');
    if (hvSources.has(v.source_id)) edge(v.name, 'hyperv', 'vm', 'source', hvSources.get(v.source_id), 'hyperv');
  }

  // Brocade: the host an HBA belongs to -> the switch it logs in on.
  const bCols = columnsOf(db, 'brocade_device_ports');
  const bTail = ['stale', 'is_missing'].filter((c) => bCols.has(c)).map((c) => `COALESCE(${c}, 0) = 0`).join(' AND ');
  for (const p of readRows(db, 'brocade_device_ports', ['fdmi_host_name', 'enclosure_name', 'switch_name'], bTail ? `WHERE ${bTail}` : '')) {
    const child = p.fdmi_host_name || p.enclosure_name;
    if (child && p.switch_name) edge(child, 'brocade', 'host', 'switch', p.switch_name, 'brocade');
  }

  // Zerto: VM -> VPG, VM and VPG -> site.
  for (const z of readRows(db, 'zerto_vms', ['name', 'vpg_names', 'protected_site', 'recovery_site'])) {
    if (!z.name) continue;
    for (const vpg of listOf(z.vpg_names)) edge(z.name, 'zerto', 'vm', 'vpg', vpg, 'zerto');
    if (z.protected_site) edge(z.name, 'zerto', 'vm', 'site', z.protected_site, 'zerto');
    if (z.recovery_site) edge(z.name, 'zerto', 'vm', 'site', z.recovery_site, 'zerto');
  }
  for (const g of readRows(db, 'zerto_vpgs', ['name', 'protected_site', 'recovery_site'])) {
    if (!g.name) continue;
    if (g.protected_site) edge(g.name, 'zerto', 'vpg', 'site', g.protected_site, 'zerto');
    if (g.recovery_site) edge(g.name, 'zerto', 'vpg', 'site', g.recovery_site, 'zerto');
  }

  // Cohesity: protected object -> the cluster that holds its backups.
  const clusterNames = new Map();
  for (const c of readRows(db, 'clusters', ['id', 'name'])) clusterNames.set(c.id, c.name);
  for (const o of readRows(db, 'cohesity_objects', ['name', 'cluster_id'])) {
    if (o.name && clusterNames.has(o.cluster_id)) edge(o.name, 'cohesity', 'object', 'cluster', clusterNames.get(o.cluster_id), 'cohesity');
  }

  // Watched app services with their label, for the VMs that carry the tag.
  if (appTags.length) {
    const info = new Map();
    for (const w of readRows(db, 'app_service_watch', ['usage_id', 'display_id', 'label'])) {
      info.set(String(w.usage_id).toLowerCase(), { displayId: w.display_id, label: w.label });
    }
    for (const c of readRows(db, 'app_service_catalog', ['usage_id', 'atm_id', 'name'])) {
      const cur = info.get(String(c.usage_id).toLowerCase());
      if (cur) { cur.label = cur.label || c.name; cur.displayId = cur.displayId || c.atm_id; }
    }
    for (const t of appTags) {
      const meta = info.get(t.usageId);
      if (!meta) continue;   // only watched apps count as affected
      const ck = hostKey(t.vm);
      const list = apps.get(ck) || [];
      if (!list.some((a) => a.usageId === t.usageId)) list.push({ usageId: t.usageId, displayId: meta.displayId || t.usageId, label: meta.label || null });
      apps.set(ck, list);
    }
  }

  return { parents, children, apps, esxHosts, lm: new Map(), lmEndpoints: null };
}

function built(db) {
  return memoByDbState(db, 'agentDependencies', () => build(db));
}

function byKindOrder(list) {
  return [...list].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

/** Switch ports an ESX host is plugged into per LogicMonitor, as parents of
 *  kind switch. Looked up for one host at a time (never the whole estate) and
 *  kept with the built index, so a state change drops it. */
function lmSwitchParents(db, b, key) {
  if (b.lm.has(key)) return b.lm.get(key);
  let out = [];
  try {
    const lme = require('./logicmonitorEndpoints');
    if (!b.lmEndpoints) b.lmEndpoints = lme.computeEndpoints(db);
    const seen = new Set();
    for (const p of lme.serverPath(db, { names: [key] }, { endpoints: b.lmEndpoints }).switchPorts || []) {
      if (!p.deviceName) continue;
      const pk = hostKey(p.deviceName);
      if (!pk || seen.has(pk)) continue;
      seen.add(pk);
      out.push({ kind: 'switch', parent: p.deviceName, parentKey: pk, platform: 'logicmonitor' });
    }
  } catch (err) {
    logger.debug(`[AgentDeps] LogicMonitor switch lookup failed for ${key}: ${err.message}`);
    out = [];
  }
  b.lm.set(key, out);
  return out;
}

/**
 * What this host sits under: [{kind, parent, parentKey, platform}] in the
 * order host, datastore, switch, vpg, site, cluster, source. opts.lm adds the
 * LogicMonitor switch ports for an ESX or Hyper-V host (one lookup, cached).
 */
function parentsOf(db, hostToken, { lm = false } = {}) {
  const key = hostKey(hostToken);
  if (!key) return [];
  const b = built(db);
  let list = b.parents.get(key) || [];
  if (lm && b.esxHosts.has(key)) {
    const extra = lmSwitchParents(db, b, key).filter((e) => !list.some((p) => p.kind === 'switch' && p.parentKey === e.parentKey));
    if (extra.length) list = [...list, ...extra];
  }
  return byKindOrder(list);
}

/** Everything under a parent: [{host, hostKey, platform, childKind}]. */
function childrenOf(db, parentToken, kind) {
  const b = built(db);
  return b.children.get(`${kind}|${parentKeyFor(kind, parentToken)}`) || [];
}

/** True when anything is known to sit under this parent. */
function isParent(db, kind, parentToken) {
  return childrenOf(db, parentToken, kind).length > 0;
}

/** Watched app services riding on the children of this parent, with their
 *  server names: [{usageId, displayId, label, servers}]. */
function appsOn(db, parentToken, kind) {
  const b = built(db);
  const out = new Map();
  for (const c of childrenOf(db, parentToken, kind)) {
    for (const a of b.apps.get(c.hostKey) || []) {
      const cur = out.get(a.usageId) || { usageId: a.usageId, displayId: a.displayId, label: a.label, servers: [] };
      if (!cur.servers.includes(c.host)) cur.servers.push(c.host);
      out.set(a.usageId, cur);
    }
  }
  return [...out.values()];
}

const SITE_UP = new Set(['connected', 'ok', 'online', 'true', '1']);

/**
 * Parents that are down according to stored state, with no alert row of their
 * own: an inaccessible datastore, a Zerto site that is not connected. since is
 * null on purpose: the rows carry only their last poll time, which moves on
 * every poll and says nothing about when the fault began.
 */
function downParentsStored(db) {
  const out = [];
  for (const d of readRows(db, 'vcenter_datastores', ['name', 'accessible'], 'WHERE accessible = 0')) {
    if (d.name) out.push({ kind: 'datastore', parent: d.name, parentKey: parentKeyFor('datastore', d.name), platform: 'vcenter', since: null });
  }
  for (const s of readRows(db, 'zerto_sites', ['name', 'connection_status'], "WHERE connection_status IS NOT NULL AND trim(connection_status) != ''")) {
    if (s.name && !SITE_UP.has(String(s.connection_status).trim().toLowerCase())) {
      out.push({ kind: 'site', parent: s.name, parentKey: parentKeyFor('site', s.name), platform: 'zerto', since: null });
    }
  }
  return out;
}

module.exports = { parentsOf, childrenOf, appsOn, isParent, downParentsStored, parentKeyFor, hostKey, KIND_ORDER };
