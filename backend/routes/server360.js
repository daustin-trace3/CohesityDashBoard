// Server 360: one endpoint correlating everything the estate knows about a
// single server. Anchor = the vCenter VM (matched by name / guest hostname);
// joins fan out by NAME (Cohesity objects+agents, Zerto VMs, vRA deployment
// resources) and by IP (NetApp NFS clients + SMB sessions, vRA resources).
// Sections are gated on RBAC grants + platform-enabled flags, like /api/search.
const express = require('express');
const db = require('../db/database');
const { hasPermission } = require('../services/rbac');
const { getSetting } = require('../services/settings');
const registry = require('../core/registry');
const logger = require('../utils/logger');

const router = express.Router();

const platformEnabled = (id) => id === 'cohesity' || String(getSetting(`platform_${id}_enabled`) ?? '0') === '1';
const parseJson = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };
const lower = (s) => String(s || '').toLowerCase();

/** GET /api/server360/suggest?q= — server-name typeahead for the picker. */
router.get('/suggest', (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ names: [] });
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const names = new Set();
    const grants = (req.auth && req.auth.grants) || [];
    if (platformEnabled('vcenter') && hasPermission(grants, 'vcenter:vms:view')) {
      for (const r of db.prepare(`SELECT name FROM vcenter_vms WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 8`).all(pattern)) names.add(r.name);
    }
    if (hasPermission(grants, 'cohesity:workloads:view')) {
      for (const r of db.prepare(`SELECT name FROM cohesity_objects WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 8`).all(pattern)) names.add(r.name);
    }
    if (platformEnabled('netbackup') && hasPermission(grants, 'netbackup:jobs:view')) {
      for (const r of db.prepare(`SELECT DISTINCT client_name AS name FROM netbackup_jobs WHERE client_name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 8`).all(pattern)) names.add(r.name);
    }
    if (platformEnabled('proxmox') && hasPermission(grants, 'proxmox:guests:view')) {
      for (const r of db.prepare(`SELECT name FROM proxmox_guests WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 8`).all(pattern)) names.add(r.name);
    }
    for (const p of registry.getServer360Providers()) {
      if (!p.suggest || !hasPermission(grants, `${p.id}:objects:view`)) continue;
      try {
        for (const n of p.suggest(q) || []) names.add(n);
      } catch (err) { logger.warn(`[server360] plugin '${p.id}' suggest failed:`, err.message); }
    }
    res.json({ names: [...names].slice(0, 10) });
  } catch (err) { next(err); }
});

/** GET /api/server360?name=<server> — the full correlated view. */
router.get('/', (req, res, next) => {
  try {
    const q = String(req.query.name || '').trim();
    if (!q) return res.status(400).json({ error: 'name required' });
    const grants = (req.auth && req.auth.grants) || [];
    const can = (perm) => hasPermission(grants, perm);
    const short = q.split('.')[0];

    // ── Anchor: vCenter VM ────────────────────────────────────────────────
    let vm = null;
    if (platformEnabled('vcenter') && can('vcenter:vms:view')) {
      vm = db.prepare(`
        SELECT m.*, v.name AS vcenter_name,
               h.cpu_mhz_capacity AS host_cpu_mhz_capacity, h.cpu_cores AS host_cpu_cores
        FROM vcenter_vms m
        JOIN vcenter_vcenters v ON v.id = m.vcenter_id
        LEFT JOIN vcenter_hosts h ON h.vcenter_id = m.vcenter_id AND h.name = m.host_name
        WHERE lower(m.name) IN (?, ?) OR lower(COALESCE(m.guest_hostname, '')) IN (?, ?)
           OR lower(COALESCE(m.guest_hostname, '')) LIKE ? ESCAPE '\\'
        LIMIT 1
      `).get(lower(q), lower(short), lower(q), lower(short), `${lower(short).replace(/[\\%_]/g, (c) => `\\${c}`)}.%`);
      if (vm) {
        const perCore = vm.host_cpu_mhz_capacity && vm.host_cpu_cores ? vm.host_cpu_mhz_capacity / vm.host_cpu_cores : null;
        const cap = perCore && vm.cpu_count ? perCore * vm.cpu_count : null;
        vm.cpu_pct = vm.cpu_usage_mhz != null && cap ? Math.round((vm.cpu_usage_mhz / cap) * 1000) / 10 : null;
        vm.mem_pct = vm.mem_usage_mb != null && vm.memory_mb ? Math.round((vm.mem_usage_mb / vm.memory_mb) * 1000) / 10 : null;
        vm.networks = parseJson(vm.networks, []);
        vm.datastores = parseJson(vm.datastores, []);
      }
    }

    // Identity set: every name/IP we can pivot on.
    const names = new Set([lower(q), lower(short)]);
    if (vm) {
      names.add(lower(vm.name));
      if (vm.guest_hostname) { names.add(lower(vm.guest_hostname)); names.add(lower(String(vm.guest_hostname).split('.')[0])); }
    }
    names.delete('');
    const ips = new Set();
    if (vm?.ip_address) ips.add(vm.ip_address);
    for (const nic of parseJson(vm?.guest_nics, [])) for (const ip of (nic.ips || [])) ips.add(ip);

    const nameList = [...names];
    const namePh = nameList.map(() => '?').join(',');
    const ipList = [...ips];
    const ipPh = ipList.map(() => '?').join(',');

    // ── Cohesity: protection posture + agent ──────────────────────────────
    let cohesity = null;
    if (can('cohesity:workloads:view')) {
      const objects = db.prepare(`
        SELECT o.*, c.name AS cluster_name FROM cohesity_objects o
        JOIN clusters c ON c.id = o.cluster_id
        WHERE lower(o.name) IN (${namePh}) ORDER BY o.is_protected DESC
      `).all(...nameList).map((o) => ({
        ...o,
        protection_groups: parseJson(o.protection_groups, []),
        policy_names: parseJson(o.policy_names, []),
      }));
      const agents = db.prepare(`
        SELECT a.*, c.name AS cluster_name FROM cohesity_agents a
        JOIN clusters c ON c.id = a.cluster_id
        WHERE lower(a.name) IN (${namePh})
      `).all(...nameList);
      if (objects.length || agents.length) cohesity = { objects, agents };
    }

    // ── Zerto: DR posture ─────────────────────────────────────────────────
    let zerto = null;
    if (platformEnabled('zerto') && can('zerto:vms:view')) {
      const rows = db.prepare(`SELECT * FROM zerto_vms WHERE lower(name) IN (${namePh})`).all(...nameList);
      if (rows.length) zerto = { vms: rows };
    }

    // ── NetApp: live NFS/SMB mounts by client IP ─────────────────────────
    let netapp = null;
    if (platformEnabled('netapp') && ipList.length && (can('netapp:nfs:view') || can('netapp:cifs:view'))) {
      const volDetail = db.prepare(`
        SELECT v.size_bytes, v.used_bytes, v.used_percent, v.state
        FROM netapp_volumes v JOIN netapp_arrays a ON a.id = v.array_id
        WHERE v.name = ? AND COALESCE(v.svm_name, '') = COALESCE(?, '') AND a.name = ?
      `);
      const enrich = (r) => ({ ...r, volume: r.volume_name ? { ...volDetail.get(r.volume_name, r.svm_name, r.array_name) } : null });
      const nfs = can('netapp:nfs:view') ? db.prepare(`
        SELECT n.client_ip, n.svm_name, n.volume_name, n.node_name, n.protocol, n.server_ip, a.name AS array_name
        FROM netapp_nfs_clients n JOIN netapp_arrays a ON a.id = n.array_id
        WHERE n.client_ip IN (${ipPh})
      `).all(...ipList).map(enrich) : [];
      const smb = can('netapp:cifs:view') ? db.prepare(`
        SELECT s.client_ip, s.smb_user, s.svm_name, s.volume_name, s.protocol, s.open_files,
               s.connected_duration, a.name AS array_name
        FROM netapp_cifs_sessions s JOIN netapp_arrays a ON a.id = s.array_id
        WHERE s.client_ip IN (${ipPh})
      `).all(...ipList).map(enrich) : [];
      if (nfs.length || smb.length) netapp = { nfs, smb };
    }

    // ── vRA: provenance via deployment resources (name or IP) ────────────
    let aria = null;
    if (platformEnabled('aria') && can('aria:deployments:view')) {
      const byName = db.prepare(`
        SELECT r.*, i.name AS instance_name FROM aria_deployment_resources r
        JOIN aria_instances i ON i.id = r.instance_id
        WHERE lower(COALESCE(r.name, '')) IN (${namePh})
      `).all(...nameList);
      const rows = new Map(byName.map((r) => [r.id, r]));
      if (ipList.length) {
        for (const r of db.prepare(`
          SELECT r.*, i.name AS instance_name FROM aria_deployment_resources r
          JOIN aria_instances i ON i.id = r.instance_id, json_each(COALESCE(r.ip_addresses, '[]')) je
          WHERE je.value IN (${ipPh})
        `).all(...ipList)) rows.set(r.id, r);
      }
      const resources = [...rows.values()];
      if (resources.length) {
        const depIds = [...new Set(resources.map((r) => r.deployment_id).filter(Boolean))];
        const deployments = depIds.length ? db.prepare(`
          SELECT d.*, i.name AS instance_name FROM aria_deployments d
          JOIN aria_instances i ON i.id = d.instance_id
          WHERE d.deployment_id IN (${depIds.map(() => '?').join(',')})
        `).all(...depIds) : [];
        aria = {
          resources: resources.map((r) => ({ ...r, ip_addresses: parseJson(r.ip_addresses, []) })),
          deployments,
        };
      }
    }

    // ── Proxmox: guest posture by name ────────────────────────────────────
    let proxmox = null;
    if (platformEnabled('proxmox') && can('proxmox:guests:view')) {
      const rows = db.prepare(`
        SELECT g.*, s.name AS server_name FROM proxmox_guests g
        JOIN proxmox_servers s ON s.id = g.server_id
        WHERE lower(g.name) IN (${namePh})
      `).all(...nameList);
      if (rows.length) proxmox = { guests: rows };
    }

    // ── NetBackup: backup posture by client name ──────────────────────────
    let netbackup = null;
    if (platformEnabled('netbackup') && can('netbackup:jobs:view')) {
      const jobs = db.prepare(`
        SELECT j.*, s.name AS source_name FROM netbackup_jobs j
        JOIN netbackup_sources s ON s.id = j.source_id
        WHERE lower(j.client_name) IN (${namePh}) AND j.started_at >= datetime('now', '-7 days')
      `).all(...nameList);
      if (jobs.length) {
        const byClient = new Map();
        for (const j of jobs) {
          const key = `${lower(j.client_name)}|${j.source_id}`;
          let c = byClient.get(key);
          if (!c) {
            c = {
              clientName: j.client_name, sourceName: j.source_name, policies: new Set(),
              jobs7d: 0, failed7d: 0, lastStatus: null, lastRunAt: null, lastSuccessAt: null, logicalBytes: null,
            };
            byClient.set(key, c);
          }
          if (j.policy_name) c.policies.add(j.policy_name);
          c.jobs7d += 1;
          const failed = j.state === 'FAILED' || (['EXITED', 'DONE'].includes(j.state) && Number(j.status_code || 0) > 0);
          const succeeded = !failed && ['EXITED', 'DONE'].includes(j.state);
          if (failed) c.failed7d += 1;
          const runAt = j.ended_at || j.started_at;
          if (runAt && (!c.lastRunAt || runAt > c.lastRunAt)) {
            c.lastRunAt = runAt;
            c.lastStatus = failed ? 'failed' : succeeded ? 'success' : (j.state || null);
          }
          if (succeeded && runAt && (!c.lastSuccessAt || runAt > c.lastSuccessAt)) {
            c.lastSuccessAt = runAt;
            c.logicalBytes = j.kilobytes != null ? j.kilobytes * 1024 : null;
          }
        }
        netbackup = { clients: [...byClient.values()].map((c) => ({ ...c, policies: [...c.policies] })) };
      }
    }

    // ── Installed plugins: display-ready sections via manifest.server360 ──
    const pluginSections = [];
    for (const p of registry.getServer360Providers()) {
      if (!can(`${p.id}:objects:view`)) continue;
      try {
        const section = p.run({ query: q, names: nameList, ips: ipList });
        if (section) pluginSections.push({ id: p.id, ...section });
      } catch (err) { logger.warn(`[server360] plugin '${p.id}' section failed:`, err.message); }
    }

    res.json({
      query: q,
      identity: { names: nameList, ips: ipList },
      vcenter: vm,
      cohesity,
      zerto,
      netapp,
      aria,
      netbackup,
      proxmox,
      plugins: pluginSections,
    });
  } catch (err) { next(err); }
});

module.exports = router;
