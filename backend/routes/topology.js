// Cross-platform Topology Map: anchor on one device (server/VM) and fan out
// the graph of everything it touches, tiered Backup -> Compute -> SAN ->
// Storage. Mirrors server360.js closely: same platformEnabled()/hasPermission
// gating per platform section, same identity-set building (anchor vCenter VM
// by name/guest_hostname; collect names + IPs incl. guest_nics). Each
// platform section is wrapped in try/catch so one platform's failure
// degrades to missing nodes, not a 500.
const express = require('express');
const db = require('../db/database');
const { hasPermission } = require('../services/rbac');
const { getSetting } = require('../services/settings');
const registry = require('../core/registry');
const logger = require('../utils/logger');

const router = express.Router();

// Same cohesity special-case as server360: gated on registry presence rather
// than a literal-id hardcode.
const platformEnabled = (id) => {
  if (id === 'cohesity') {
    const entry = registry.getPlugin('cohesity');
    return entry ? entry.enabled : registry.isBuiltinPresent('cohesity');
  }
  return String(getSetting(`platform_${id}_enabled`) ?? '0') === '1';
};
const parseJson = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };
const lower = (s) => String(s || '').toLowerCase();
const esc = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
const q = (s) => encodeURIComponent(s);

/** GET /api/topology?name=<device> — anchored graph across all tiers. */
router.get('/', (req, res, next) => {
  try {
    const query = String(req.query.name || '').trim();
    if (!query) return res.status(400).json({ error: 'name required' });
    const grants = (req.auth && req.auth.grants) || [];
    const can = (perm) => hasPermission(grants, perm);
    const short = query.split('.')[0];

    const nodes = new Map();
    const edges = [];
    const addNode = (n) => { if (!nodes.has(n.id)) nodes.set(n.id, n); return nodes.get(n.id); };
    const addEdge = (from, to, kind, label = '') => { if (from && to) edges.push({ from, to, kind, label }); };

    // ── Anchor: vCenter VM (same match as server360) ────────────────────
    let vm = null;
    if (platformEnabled('vcenter') && can('vcenter:vms:view')) {
      vm = db.prepare(`
        SELECT m.*, v.name AS vcenter_name
        FROM vcenter_vms m
        JOIN vcenter_vcenters v ON v.id = m.vcenter_id
        WHERE lower(m.name) IN (?, ?) OR lower(COALESCE(m.guest_hostname, '')) IN (?, ?)
           OR lower(COALESCE(m.guest_hostname, '')) LIKE ? ESCAPE '\\'
        LIMIT 1
      `).get(lower(query), lower(short), lower(query), lower(short), `${esc(lower(short))}.%`);
      if (vm) {
        vm.networks = parseJson(vm.networks, []);
        vm.datastores = parseJson(vm.datastores, []);
      }
    }

    // Identity set: every name/IP we can pivot on (same construction as server360).
    const names = new Set([lower(query), lower(short)]);
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

    // ── Anchor node ───────────────────────────────────────────────────────
    let anchorId;
    let anchorHostName = null; // host name to attach SAN section to, if any
    if (vm) {
      anchorId = `vm:${vm.name}`;
      addNode({
        id: anchorId, type: 'vm', tier: 'compute', platform: 'vcenter',
        label: vm.name,
        sublabel: `${vm.power_state || 'unknown'} · ${vm.cpu_count || '?'} vCPU / ${vm.memory_mb ? Math.round(vm.memory_mb / 1024) : '?'} GB`,
        route: `/vcenter/inventory?q=${q(vm.name)}`,
        status: vm.power_state === 'poweredOn' ? 'ok' : (vm.power_state ? 'warn' : 'unknown'),
      });
      if (vm.host_name) {
        anchorHostName = vm.host_name;
        const hostId = `host:${vm.host_name}`;
        addNode({
          id: hostId, type: 'host', tier: 'compute', platform: 'vcenter',
          label: vm.host_name, sublabel: vm.cluster_name || '',
          route: `/vcenter/hosts?q=${q(vm.host_name)}`, status: 'unknown',
        });
        addEdge(anchorId, hostId, 'runs-on', '');
        const vcenterId = `vcenter:${vm.vcenter_name}`;
        addNode({
          id: vcenterId, type: 'vcenter', tier: 'compute', platform: 'vcenter',
          label: vm.vcenter_name, sublabel: '', route: '/vcenter/settings', status: 'unknown',
        });
        addEdge(hostId, vcenterId, 'managed-by', '');
      }
      for (const ds of vm.datastores) {
        const dsName = typeof ds === 'string' ? ds : (ds?.name || null);
        if (!dsName) continue;
        const dsId = `datastore:${dsName}`;
        addNode({
          id: dsId, type: 'datastore', tier: 'storage', platform: 'vcenter',
          label: dsName, sublabel: '', route: `/vcenter/datastores?q=${q(dsName)}`, status: 'unknown',
        });
        addEdge(anchorId, dsId, 'stores-on', '');
      }
    } else {
      anchorId = `device:${query}`;
      addNode({
        id: anchorId, type: 'host', tier: 'compute', platform: null,
        label: query, sublabel: '', route: null, status: 'unknown',
      });
    }

    // ── SAN (brocade) ─────────────────────────────────────────────────────
    if (platformEnabled('brocade') && can('brocade:objects:view')) {
      try {
        const sanNames = new Set(names);
        if (anchorHostName) sanNames.add(lower(anchorHostName));
        const sanList = [...sanNames];
        const sanPh = sanList.map(() => '?').join(',');
        const hbaRows = db.prepare(`
          SELECT * FROM brocade_device_ports
          WHERE stale = 0 AND (lower(enclosure_name) IN (${sanPh}) OR lower(fdmi_host_name) IN (${sanPh}))
        `).all(...sanList, ...sanList);

        if (hbaRows.length) {
          const allZoneNames = new Set();
          for (const hba of hbaRows) {
            const hbaId = `hba:${hba.wwn}`;
            addNode({
              id: hbaId, type: 'hba', tier: 'san', platform: 'brocade',
              label: hba.wwn, sublabel: hba.zone_alias || hba.symbolic_name || hba.device_symbolic_name || '',
              route: `/brocade/devices?q=${q(hba.wwn)}`, status: hba.is_missing ? 'warn' : 'ok',
            });
            addEdge(anchorId, hbaId, 'attached-to', '');

            if (hba.switch_name) {
              const switchId = `switch:${hba.switch_wwn || hba.switch_name}`;
              addNode({
                id: switchId, type: 'switch', tier: 'san', platform: 'brocade',
                label: hba.switch_name, sublabel: hba.fabric_name || '',
                route: `/brocade/switches?q=${q(hba.switch_name)}`, status: 'unknown',
              });
              addEdge(hbaId, switchId, 'connected', `${hba.slot_number ?? ''}/${hba.port_number ?? ''}`.replace(/^\/|\/$/g, '') || '');

              if (hba.fabric_name) {
                const fabricId = `fabric:${hba.fabric_name}`;
                addNode({
                  id: fabricId, type: 'fabric', tier: 'san', platform: 'brocade',
                  label: hba.fabric_name, sublabel: '', route: `/brocade/fabrics?q=${q(hba.fabric_name)}`, status: 'unknown',
                });
                addEdge(switchId, fabricId, 'member-of', '');
              }
            }

            for (const z of parseJson(hba.active_zones, [])) allZoneNames.add(z);
          }

          if (allZoneNames.size) {
            const hbaZones = new Map(hbaRows.map((h) => [h.wwn, new Set(parseJson(h.active_zones, []))]));
            const targetRows = db.prepare(`
              SELECT * FROM brocade_device_ports
              WHERE stale = 0 AND lower(COALESCE(port_role, '')) LIKE '%target%'
            `).all();
            let capped = false;
            let kept = 0;
            for (const t of targetRows) {
              const tZones = new Set(parseJson(t.active_zones, []));
              // shared zones with ANY of the anchor's hba rows
              let shared = [];
              for (const [, zs] of hbaZones) {
                for (const z of zs) if (tZones.has(z)) shared.push(z);
              }
              shared = [...new Set(shared)];
              if (!shared.length) continue;
              if (kept >= 40) { capped = true; break; }
              kept += 1;

              const targetId = `targetPort:${t.wwn}`;
              addNode({
                id: targetId, type: 'targetPort', tier: 'san', platform: 'brocade',
                label: t.wwn, sublabel: t.enclosure_name || '',
                route: `/brocade/devices?q=${q(t.wwn)}`, status: t.is_missing ? 'warn' : 'ok',
              });
              const zoneLabel = shared.length > 2 ? `${shared.slice(0, 2).join(', ')} +${shared.length - 2}` : shared.join(', ');
              // edge from whichever anchor hba shares a zone with this target
              for (const hba of hbaRows) {
                const hz = hbaZones.get(hba.wwn);
                if ([...hz].some((z) => tZones.has(z))) {
                  addEdge(`hba:${hba.wwn}`, targetId, 'zoned', zoneLabel);
                }
              }
              if (t.enclosure_name) {
                const arrId = `array:${t.enclosure_name}`;
                addNode({
                  id: arrId, type: 'array', tier: 'storage', platform: 'brocade',
                  label: t.enclosure_name, sublabel: '', route: `/brocade/devices?q=${q(t.enclosure_name)}`, status: 'unknown',
                });
                addEdge(targetId, arrId, 'belongs-to', '');
              }
            }
            if (capped) {
              const anchorNode = nodes.get(anchorId);
              if (anchorNode) anchorNode.sublabel = `${anchorNode.sublabel || ''} (SAN target ports capped at 40)`.trim();
            }
          }
        }
      } catch (err) { logger.warn('[topology] brocade section failed:', err.message); }
    }

    // ── Storage (netapp by IP) ───────────────────────────────────────────
    if (platformEnabled('netapp') && ipList.length && (can('netapp:nfs:view') || can('netapp:cifs:view'))) {
      try {
        const nfs = can('netapp:nfs:view') ? db.prepare(`
          SELECT n.client_ip, n.svm_name, n.volume_name, a.name AS array_name
          FROM netapp_nfs_clients n JOIN netapp_arrays a ON a.id = n.array_id
          WHERE n.client_ip IN (${ipPh})
        `).all(...ipList) : [];
        const smb = can('netapp:cifs:view') ? db.prepare(`
          SELECT s.client_ip, s.svm_name, s.volume_name, a.name AS array_name
          FROM netapp_cifs_sessions s JOIN netapp_arrays a ON a.id = s.array_id
          WHERE s.client_ip IN (${ipPh})
        `).all(...ipList) : [];
        for (const row of [...nfs.map((r) => ({ ...r, proto: 'nfs' })), ...smb.map((r) => ({ ...r, proto: 'smb' }))]) {
          if (!row.volume_name) continue;
          const volId = `volume:${row.volume_name}`;
          addNode({
            id: volId, type: 'volume', tier: 'storage', platform: 'netapp',
            label: row.volume_name, sublabel: `${row.svm_name || ''} / ${row.array_name || ''}`.replace(/^\s*\/\s*/, ''),
            route: `/netapp/volumes?q=${q(row.volume_name)}`, status: 'unknown',
          });
          addEdge(anchorId, volId, 'mounts', row.proto);
          if (row.array_name) {
            const arrId = `array:${row.array_name}`;
            addNode({
              id: arrId, type: 'array', tier: 'storage', platform: 'netapp',
              label: row.array_name, sublabel: '', route: `/netapp/volumes?q=${q(row.array_name)}`, status: 'unknown',
            });
            addEdge(volId, arrId, 'lives-on', '');
          }
        }
      } catch (err) { logger.warn('[topology] netapp section failed:', err.message); }
    }

    // ── Storage (pure) ────────────────────────────────────────────────────
    if (platformEnabled('pure') && can('pure:overview:view')) {
      try {
        const pureNames = new Set(names);
        if (anchorHostName) pureNames.add(lower(anchorHostName));
        const pureList = [...pureNames];
        const purePh = pureList.map(() => '?').join(',');
        const hosts = db.prepare(`SELECT * FROM pure_hosts WHERE lower(name) IN (${purePh})`).all(...pureList);
        // Deviation from contract: pure_hosts has no wwns/iqns column on this
        // schema (id, array_id, name, connection_count, personality,
        // protocol, captured_at) — brocade-hba cross-match skipped.
        for (const host of hosts) {
          const conns = db.prepare(`
            SELECT c.*, a.name AS array_name FROM pure_connections c
            JOIN pure_arrays a ON a.id = c.array_id
            WHERE c.array_id = ? AND c.host_name = ?
            LIMIT 15
          `).all(host.array_id, host.name);
          for (const c of conns) {
            const volId = `volume:${c.volume_name}`;
            addNode({
              id: volId, type: 'volume', tier: 'storage', platform: 'pure',
              label: c.volume_name, sublabel: c.array_name || '',
              route: `/pure?q=${q(c.volume_name)}`, status: 'unknown',
            });
            addEdge(anchorId, volId, 'mounts', '');
            if (c.array_name) {
              const arrId = `array:${c.array_name}`;
              addNode({
                id: arrId, type: 'array', tier: 'storage', platform: 'pure',
                label: c.array_name, sublabel: '', route: `/pure?q=${q(c.array_name)}`, status: 'unknown',
              });
              addEdge(volId, arrId, 'lives-on', '');
            }
          }
        }
      } catch (err) { logger.warn('[topology] pure section failed:', err.message); }
    }

    // ── Backup (cohesity) ─────────────────────────────────────────────────
    if (can('cohesity:workloads:view')) {
      try {
        const objects = db.prepare(`
          SELECT o.*, c.name AS cluster_name FROM cohesity_objects o
          JOIN clusters c ON c.id = o.cluster_id
          WHERE lower(o.name) IN (${namePh})
        `).all(...nameList).map((o) => ({
          ...o,
          protection_groups: parseJson(o.protection_groups, []),
          policy_names: parseJson(o.policy_names, []),
        }));
        for (const obj of objects) {
          const groups = obj.protection_groups.length ? obj.protection_groups : (obj.is_protected ? [] : ['__unprotected__']);
          for (const grp of groups) {
            const isUnprotected = grp === '__unprotected__';
            const grpName = isUnprotected ? `${obj.name} (unprotected)` : grp;
            const protId = `protection:${grpName}`;
            addNode({
              id: protId, type: 'protection', tier: 'backup', platform: 'cohesity',
              label: isUnprotected ? 'Not protected' : grp,
              sublabel: isUnprotected ? '' : (obj.policy_names.join(', ') || ''),
              route: `/data-protection?q=${q(isUnprotected ? obj.name : grp)}`,
              status: isUnprotected ? 'warn' : (obj.sla_violated ? 'warn' : 'ok'),
            });
            addEdge(anchorId, protId, 'protected-by', '');
            if (!isUnprotected && obj.cluster_name) {
              const clusterId = `cluster:${obj.cluster_name}`;
              addNode({
                id: clusterId, type: 'cluster', tier: 'backup', platform: 'cohesity',
                label: obj.cluster_name, sublabel: '', route: `/cohesity/clusters?q=${q(obj.cluster_name)}`, status: 'unknown',
              });
              addEdge(protId, clusterId, 'on-cluster', '');
            }
          }
        }
      } catch (err) { logger.warn('[topology] cohesity section failed:', err.message); }
    }

    // ── Backup (zerto) ────────────────────────────────────────────────────
    if (platformEnabled('zerto') && can('zerto:vms:view')) {
      try {
        const zvms = db.prepare(`SELECT * FROM zerto_vms WHERE lower(name) IN (${namePh})`).all(...nameList);
        for (const zvm of zvms) {
          for (const vpgName of parseJson(zvm.vpg_names, [])) {
            const vpgId = `vpg:${vpgName}`;
            addNode({
              id: vpgId, type: 'vpg', tier: 'backup', platform: 'zerto',
              label: vpgName, sublabel: `${zvm.protected_site || ''} -> ${zvm.recovery_site || ''}`,
              route: `/zerto/vpgs?q=${q(vpgName)}`, status: 'unknown',
            });
            addEdge(anchorId, vpgId, 'replicated-by', '');
          }
        }
      } catch (err) { logger.warn('[topology] zerto section failed:', err.message); }
    }

    // ── Backup (netbackup) ────────────────────────────────────────────────
    // Deviation from contract: this branch has no platform_netbackup_enabled
    // setting or 'netbackup' registry entry wired up yet (grep found nothing
    // in routes/ or services/settings.js besides the RBAC default-grant
    // strings), so platformEnabled('netbackup') always resolves false today.
    // Section is implemented per-contract for when that wiring lands.
    if (platformEnabled('netbackup') && can('netbackup:jobs:view')) {
      try {
        const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='netbackup_jobs'`).get();
        if (tableExists) {
          const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
          const jobs = db.prepare(`
            SELECT DISTINCT policy_name, state, started_at FROM netbackup_jobs
            WHERE lower(client_name) IN (${namePh}) AND started_at >= ?
            ORDER BY started_at DESC
          `).all(...nameList, sevenDaysAgo);
          const seen = new Set();
          let count = 0;
          for (const j of jobs) {
            if (!j.policy_name || seen.has(j.policy_name) || count >= 6) continue;
            seen.add(j.policy_name);
            count += 1;
            const polId = `policy:${j.policy_name}`;
            addNode({
              id: polId, type: 'policy', tier: 'backup', platform: 'netbackup',
              label: j.policy_name, sublabel: `${j.state || ''} · ${j.started_at || ''}`,
              route: `/netbackup?q=${q(j.policy_name)}`, status: 'unknown',
            });
            addEdge(anchorId, polId, 'backed-up-by', '');
          }
        }
      } catch (err) { logger.warn('[topology] netbackup section failed:', err.message); }
    }

    // ── Dedupe + drop dangling edges ─────────────────────────────────────
    const finalNodes = [...nodes.values()];
    const finalEdges = edges.filter((e) => nodes.has(e.from) && nodes.has(e.to));

    res.json({
      query,
      identity: { names: [...names], ips: ipList },
      nodes: finalNodes,
      edges: finalEdges,
    });
  } catch (err) { next(err); }
});

module.exports = router;
