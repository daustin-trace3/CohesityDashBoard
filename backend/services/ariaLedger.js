'use strict';

// Append-only record of every Aria deployment (and the machine resources under
// it) ICC has seen. The live aria_deployments / aria_deployment_resources tables
// are rewritten on every poll; this ledger is only ever upserted, so creation
// dates and VM names outlive what Aria still lists.
const { pruneInBatches } = require('../core/dbPrune');
const { getSetting } = require('./settings');

function numSetting(key, def, min, max) {
  const raw = getSetting(key);
  if (raw == null || String(raw).trim() === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : def;
}
const deploymentFetchCap = () => numSetting('aria_deployment_fetch_cap', 2000, 200, 20000);
const resourceFetchCap = () => numSetting('aria_resource_fetch_cap', 300, 50, 2000);
const ledgerRetentionDays = () => numSetting('aria_ledger_retention_days', 0, 0, 3650);

const depIdOf = (d) => (d?.id != null ? String(d.id) : (d?.deploymentId != null ? String(d.deploymentId) : null));
const SEP = String.fromCharCode(31);

/**
 * Deployment ids in the order the resources call should visit them:
 * (1) no ledger row, or never fetched, newest created first;
 * (2) the rest, oldest resources_at first.
 */
function resourceFetchOrder(db, instanceId, deployments) {
  const rows = db.prepare('SELECT deployment_id, resources_at FROM aria_deployment_ledger WHERE instance_id = ?').all(instanceId);
  const at = new Map(rows.map((r) => [r.deployment_id, r.resources_at]));
  const fresh = [];
  const seen = [];
  for (const d of (deployments || [])) {
    const id = depIdOf(d);
    if (!id) continue;
    const ra = at.get(id);
    if (ra == null) fresh.push({ id, created: String(d?.createdAt || '') });
    else seen.push({ id, ra: String(ra) });
  }
  fresh.sort((a, b) => b.created.localeCompare(a.created));
  seen.sort((a, b) => a.ra.localeCompare(b.ra));
  return [...fresh.map((x) => x.id), ...seen.map((x) => x.id)];
}

function recordPoll(db, args) {
  const {
    instanceId, nowIso, deployments, deploymentsCapped = false,
    deploymentResources = null, resourcesFetchedFor = null,
  } = args;
  const now = nowIso || new Date().toISOString();
  const result = { inserted: 0, updated: 0, removed: 0, resourcesInserted: 0, resourcesRemoved: 0 };

  const run = db.transaction(() => {
    const existing = new Set(db.prepare('SELECT deployment_id FROM aria_deployment_ledger WHERE instance_id = ?')
      .all(instanceId).map((r) => r.deployment_id));
    const upsert = db.prepare(`
      INSERT INTO aria_deployment_ledger
        (instance_id, deployment_id, name, project_name, project_id, status, created_by, owned_by,
         created_at_src, updated_at_src, lease_expire_at, resource_count, first_seen_at, last_seen_at, removed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(instance_id, deployment_id) DO UPDATE SET
        name = excluded.name, project_name = excluded.project_name, project_id = excluded.project_id,
        status = excluded.status, created_by = excluded.created_by, owned_by = excluded.owned_by,
        updated_at_src = excluded.updated_at_src, lease_expire_at = excluded.lease_expire_at,
        resource_count = excluded.resource_count,
        created_at_src = COALESCE(aria_deployment_ledger.created_at_src, excluded.created_at_src),
        last_seen_at = excluded.last_seen_at, removed_at = NULL
    `);

    // Resolve project names and resource counts the same way the live store does.
    const resCount = new Map();
    for (const r of (deploymentResources || [])) {
      const k = String(r?.deploymentId ?? '');
      if (k) resCount.set(k, (resCount.get(k) || 0) + 1);
    }
    const projName = new Map();
    try {
      for (const p of db.prepare('SELECT project_id, name FROM aria_projects WHERE instance_id = ?').all(instanceId)) {
        if (p.name) projName.set(String(p.project_id), p.name);
      }
    } catch { /* projects table optional */ }

    const fetchedIds = [];
    for (const d of (deployments || [])) {
      const id = depIdOf(d);
      if (!id) continue;
      fetchedIds.push(id);
      const projectId = d?.projectId != null ? String(d.projectId) : (d?.project?.id != null ? String(d.project.id) : null);
      const count = d?.resourceCount != null ? Number(d.resourceCount)
        : Array.isArray(d?.resources) ? d.resources.length
          : resCount.has(id) ? resCount.get(id) : null;
      upsert.run(instanceId, id, d?.name ?? null,
        d?.projectName ?? d?.project?.name ?? (projectId != null ? projName.get(projectId) : null) ?? null,
        projectId, d?.status ?? null, d?.createdBy ?? d?.ownedBy ?? null,
        d?.ownedBy ?? (typeof d?.owner === 'string' ? d.owner : d?.owner?.name) ?? null,
        d?.createdAt ?? null, d?.lastUpdatedAt ?? d?.updatedAt ?? null,
        d?.leaseExpireAt ?? d?.leaseExpiration ?? null, count, now, now);
      if (existing.has(id)) result.updated += 1; else result.inserted += 1;
    }

    if (!deploymentsCapped) {
      // Present in the ledger and open, but not in this fetch. Diffed in JS so no
      // statement carries a large NOT IN list.
      const fetched = new Set(fetchedIds);
      const open = db.prepare('SELECT deployment_id FROM aria_deployment_ledger WHERE instance_id = ? AND removed_at IS NULL')
        .all(instanceId).map((r) => r.deployment_id);
      const markDep = db.prepare('UPDATE aria_deployment_ledger SET removed_at = ? WHERE instance_id = ? AND deployment_id = ?');
      const markRes = db.prepare('UPDATE aria_deployment_resource_ledger SET removed_at = ? WHERE instance_id = ? AND deployment_id = ? AND removed_at IS NULL');
      for (const id of open) {
        if (fetched.has(id)) continue;
        markDep.run(now, instanceId, id);
        result.resourcesRemoved += markRes.run(now, instanceId, id).changes;
        result.removed += 1;
      }
    }

    if (deploymentResources) {
      const existingRes = new Set(db.prepare(`SELECT deployment_id || char(31) || resource_id AS k FROM aria_deployment_resource_ledger WHERE instance_id = ?`)
        .all(instanceId).map((r) => r.k));
      const upRes = db.prepare(`
        INSERT INTO aria_deployment_resource_ledger
          (instance_id, deployment_id, resource_id, name, type, state, ip_addresses, first_seen_at, last_seen_at, removed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(instance_id, deployment_id, resource_id) DO UPDATE SET
          name = excluded.name, type = excluded.type, state = excluded.state,
          ip_addresses = excluded.ip_addresses, last_seen_at = excluded.last_seen_at, removed_at = NULL
      `);
      const seenByDep = new Map();
      for (const r of deploymentResources) {
        const dep = r?.deploymentId != null ? String(r.deploymentId) : null;
        const rid = r?.resourceId != null ? String(r.resourceId) : null;
        if (!dep || !rid) continue;
        upRes.run(instanceId, dep, rid, r.name ?? null, r.type ?? null, r.state ?? null,
          r.ipAddresses?.length ? JSON.stringify(r.ipAddresses) : null, now, now);
        if (!existingRes.has(`${dep}${SEP}${rid}`)) result.resourcesInserted += 1;
        if (!seenByDep.has(dep)) seenByDep.set(dep, new Set());
        seenByDep.get(dep).add(rid);
      }

      const visited = resourcesFetchedFor ? [...resourcesFetchedFor].map(String) : [];
      const setAt = db.prepare('UPDATE aria_deployment_ledger SET resources_at = ? WHERE instance_id = ? AND deployment_id = ?');
      const liveRes = db.prepare('SELECT resource_id FROM aria_deployment_resource_ledger WHERE instance_id = ? AND deployment_id = ? AND removed_at IS NULL');
      const markOne = db.prepare('UPDATE aria_deployment_resource_ledger SET removed_at = ? WHERE instance_id = ? AND deployment_id = ? AND resource_id = ?');
      for (const dep of visited) {
        setAt.run(now, instanceId, dep);
        const seen = seenByDep.get(dep) || new Set();
        for (const row of liveRes.all(instanceId, dep)) {
          if (!seen.has(row.resource_id)) {
            markOne.run(now, instanceId, dep, row.resource_id);
            result.resourcesRemoved += 1;
          }
        }
      }
    }
  });
  run();
  return result;
}

/** Opt-in prune: removed rows older than N days. 0 does nothing. Call outside any transaction. */
function pruneRemoved(db, retentionDays) {
  const days = Number(retentionDays);
  if (!Number.isFinite(days) || days <= 0) return { deleted: 0 };
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const a = pruneInBatches(db, 'aria_deployment_resource_ledger', 'removed_at IS NOT NULL AND removed_at < ?', [cutoff]);
  const b = pruneInBatches(db, 'aria_deployment_ledger', 'removed_at IS NOT NULL AND removed_at < ?', [cutoff]);
  return { deleted: a.deleted + b.deleted };
}

module.exports = {
  recordPoll, resourceFetchOrder, pruneRemoved,
  deploymentFetchCap, resourceFetchCap, ledgerRetentionDays,
};
