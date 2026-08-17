// Aria Automation poller — one scheduled task per registered instance
// (framework per-source model, like vCenter/Dell). Every section is fetched
// and stored independently: a failing section returns null and the
// conditional-replace guard below keeps whatever rows are already in the DB
// (null = section unavailable this poll, [] = genuinely empty). The poll as
// a whole only fails — and only then does it throw, so the framework marks
// the instance in error — when reachability or login itself fails.
//
// Ported from backend/services/ariaPoller.js. db/logger/createPoller now come
// from coreApi rather than direct host requires.
//
// Module-scoped singleton: createRouter() and manifest.createPoller() are
// both called by the host registry against the same coreApi, but createRouter
// runs first and needs to reach the same poller instance for
// schedule/cancel/trigger on instance CRUD. getPoller() lazily builds it if
// not yet created, and createAriaPoller() (the manifest.createPoller entry
// point) reuses it if router.js got there first (dell/unifi poller.js pattern).
const api = require('./api');
const { reconcileIssueHistory } = require('./issues');

let pollerInstance = null;

const safeMsg = (e) => (e?.response ? `HTTP ${e.response.status}` : (e?.message || String(e)));

async function safe(label, row, coreApi, fn) {
  try {
    return await fn();
  } catch (err) {
    coreApi.logger.debug(`[AriaPoller] ${row.name}: ${label} failed (skipping): ${safeMsg(err)}`);
    return null;
  }
}

async function collect(row, coreApi) {
  // Reachability + login are the only things allowed to fail the whole poll.
  try {
    await api.fetchHealth(row);
  } catch (err) {
    throw new Error(`Aria instance unreachable: ${safeMsg(err)}`);
  }
  await api.getBearer(row, coreApi);

  const about = await safe('about', row, coreApi, () => api.fetchAbout(row, coreApi));
  const cert = await safe('tls cert', row, coreApi, () => api.fetchTlsCert(row));
  const deployments = await safe('deployments', row, coreApi, () => api.fetchDeployments(row, coreApi));
  const deploymentResources = deployments === null ? null
    : await safe('deployment resources', row, coreApi, () => api.fetchDeploymentResources(row, coreApi, deployments));
  const requests = deployments === null ? null
    : await safe('requests', row, coreApi, () => api.fetchRequests(row, coreApi, deployments));
  const cloudAccounts = await safe('cloud accounts', row, coreApi, () => api.fetchCloudAccounts(row, coreApi));
  const integrations = await safe('integrations', row, coreApi, () => api.fetchIntegrations(row, coreApi));
  const projects = await safe('projects', row, coreApi, () => api.fetchProjects(row, coreApi));
  const catalogSources = await safe('catalog sources', row, coreApi, () => api.fetchCatalogSources(row, coreApi));
  const fabricImages = await safe('fabric images', row, coreApi, () => api.fetchFabricImages(row, coreApi));
  const imageProfiles = await safe('image profiles', row, coreApi, () => api.fetchImageProfiles(row, coreApi));
  const flavorProfiles = await safe('flavor profiles', row, coreApi, () => api.fetchFlavorProfiles(row, coreApi));
  const blueprints = await safe('blueprints', row, coreApi, () => api.fetchBlueprints(row, coreApi));
  const abxRuns = await safe('abx runs', row, coreApi, () => api.fetchAbxRuns(row, coreApi));
  // vRO workflow runs skipped in v1 — per-workflow enumeration is too
  // expensive to poll fleet-wide; extensibility coverage is abx + pipeline.
  const pipelineExecutions = await safe('pipeline executions', row, coreApi, () => api.fetchPipelineExecutions(row, coreApi));
  const approvals = await safe('approvals', row, coreApi, () => api.fetchApprovals(row, coreApi));

  return {
    about, cert, deployments, deploymentResources, requests, cloudAccounts, integrations,
    projects, catalogSources, fabricImages, imageProfiles, flavorProfiles,
    blueprints, abxRuns, pipelineExecutions, approvals,
  };
}

// Image/flavor profiles carry their per-region mappings as an object keyed by
// the logical name blueprints reference. The key ('imageMapping' vs
// 'imageMappings', singular map vs list) is unverified — accept both.
function mappingEntries(profile, ...keys) {
  for (const k of keys) {
    let m = profile?.[k];
    // Newer vRA nests the map one level deeper: imageMappings.mapping.{name: {...}}
    if (m && typeof m === 'object' && !Array.isArray(m) && m.mapping && typeof m.mapping === 'object' && !Array.isArray(m.mapping)) {
      m = m.mapping;
    }
    if (Array.isArray(m)) {
      return m.map((item) => [item?.mappingName ?? item?.name ?? null, item]).filter(([n]) => n);
    }
    if (m && typeof m === 'object') return Object.entries(m);
  }
  return [];
}

// The mapping value's target image name hides in different places per
// version; a bare string value IS the image name.
function mappingImageName(img) {
  if (typeof img === 'string') return img;
  return img?.image?.name ?? img?.name ?? img?.imageName ?? null;
}

const profileRegion = (p) =>
  p?.externalRegionId ?? p?.regionId ?? p?._links?.region?.href?.split('/').pop() ?? null;

// Best-effort candidate fields the upstream might use for a health/status
// string on cloud-accounts/integrations — shape is unverified, so every
// candidate is stashed in `detail` and the first non-null wins as health_state.
function endpointHealthState(e) {
  const candidates = [
    e?.endpointHealthCheckState, e?.healthCheckState, e?.healthState,
    e?.status, e?.state, e?.connectionState,
  ];
  const state = candidates.find((v) => v != null);
  return state != null ? String(state) : null;
}

function endpointDetail(e) {
  return JSON.stringify({
    endpointHealthCheckState: e?.endpointHealthCheckState ?? null,
    healthCheckState: e?.healthCheckState ?? null,
    healthState: e?.healthState ?? null,
    status: e?.status ?? null,
    state: e?.state ?? null,
    connectionState: e?.connectionState ?? null,
  });
}

function buildStore(coreApi) {
  const db = coreApi.db;
  return db.transaction((instanceId, data) => {
    const {
      about, cert, deployments, deploymentResources, requests, cloudAccounts, integrations,
      projects, catalogSources, fabricImages, imageProfiles, flavorProfiles,
      blueprints, abxRuns, pipelineExecutions, approvals,
    } = data;

    if (deploymentResources !== null && deploymentResources !== undefined) {
      db.prepare('DELETE FROM aria_deployment_resources WHERE instance_id = ?').run(instanceId);
      const drStmt = db.prepare(`
        INSERT INTO aria_deployment_resources
          (instance_id, deployment_id, resource_id, name, type, state, ip_addresses)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of deploymentResources) {
        drStmt.run(instanceId, r.deploymentId ?? null, r.resourceId ?? null, r.name ?? null,
          r.type ?? null, r.state ?? null,
          r.ipAddresses?.length ? JSON.stringify(r.ipAddresses) : null);
      }
    }

    db.prepare(`
      UPDATE aria_instances SET
        reachable = 1,
        version = COALESCE(?, version),
        api_version = COALESCE(?, api_version),
        cert_subject = COALESCE(?, cert_subject),
        cert_issuer = COALESCE(?, cert_issuer),
        cert_valid_from = COALESCE(?, cert_valid_from),
        cert_valid_to = COALESCE(?, cert_valid_to)
      WHERE id = ?
    `).run(
      about?.latestApiVersion ? String(about.latestApiVersion) : null,
      about?.latestApiVersion ? String(about.latestApiVersion) : null,
      cert?.subject ?? null, cert?.issuer ?? null, cert?.validFrom ?? null, cert?.validTo ?? null,
      instanceId
    );

    if (deployments !== null) {
      db.prepare('DELETE FROM aria_deployments WHERE instance_id = ?').run(instanceId);
      const stmt = db.prepare(`
        INSERT INTO aria_deployments (instance_id, deployment_id, name, project_name, status,
          created_by, created_at_src, updated_at_src, lease_expire_at, resource_count,
          raw_status_detail, project_id, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      // Live vRA (2026-07-28): deployments carry projectId only — resolve names
      // through the projects fetch from the same poll.
      const projName = new Map((projects || []).map((p) => [String(p?.id), p?.name]).filter(([, n]) => n));
      const resCount = new Map();
      for (const r of (deploymentResources || [])) {
        const k = String(r?.deploymentId ?? '');
        if (k) resCount.set(k, (resCount.get(k) || 0) + 1);
      }
      for (const d of deployments) {
        const depId = d?.id != null ? String(d.id) : null;
        const projectId = d?.projectId != null ? String(d.projectId) : (d?.project?.id != null ? String(d.project.id) : null);
        const count = d?.resourceCount != null ? Number(d.resourceCount)
          : Array.isArray(d?.resources) ? d.resources.length
            : (depId != null && resCount.has(depId)) ? resCount.get(depId) : null;
        stmt.run(instanceId, depId, d?.name ?? null,
          d?.projectName ?? d?.project?.name ?? (projectId != null ? projName.get(projectId) : null) ?? null,
          d?.status ?? null,
          d?.createdBy ?? d?.ownedBy ?? null, d?.createdAt ?? null, d?.lastUpdatedAt ?? d?.updatedAt ?? null,
          d?.leaseExpireAt ?? d?.leaseExpiration ?? null, count,
          d?.statusDetail ? JSON.stringify(d.statusDetail) : null,
          projectId, JSON.stringify(d));
      }
    }

    if (cloudAccounts !== null) {
      db.prepare("DELETE FROM aria_endpoints WHERE instance_id = ? AND kind = 'cloud-account'").run(instanceId);
      const stmt = db.prepare(`
        INSERT INTO aria_endpoints (instance_id, endpoint_id, kind, name, type, health_state, detail)
        VALUES (?, ?, 'cloud-account', ?, ?, ?, ?)
      `);
      for (const e of cloudAccounts) {
        stmt.run(instanceId, e?.id != null ? String(e.id) : null, e?.name ?? null,
          e?.cloudAccountType ?? null, endpointHealthState(e), endpointDetail(e));
      }
    }
    if (integrations !== null) {
      db.prepare("DELETE FROM aria_endpoints WHERE instance_id = ? AND kind = 'integration'").run(instanceId);
      const stmt = db.prepare(`
        INSERT INTO aria_endpoints (instance_id, endpoint_id, kind, name, type, health_state, detail)
        VALUES (?, ?, 'integration', ?, ?, ?, ?)
      `);
      for (const e of integrations) {
        stmt.run(instanceId, e?.id != null ? String(e.id) : null, e?.name ?? null,
          e?.integrationType ?? null, endpointHealthState(e), endpointDetail(e));
      }
    }

    if (projects !== null) {
      db.prepare('DELETE FROM aria_projects WHERE instance_id = ?').run(instanceId);
      const stmt = db.prepare(`
        INSERT INTO aria_projects (instance_id, project_id, name, description) VALUES (?, ?, ?, ?)
      `);
      for (const p of projects) {
        stmt.run(instanceId, p?.id != null ? String(p.id) : null, p?.name ?? null, p?.description ?? null);
      }
    }

    if (catalogSources !== null) {
      db.prepare('DELETE FROM aria_catalog_sources WHERE instance_id = ?').run(instanceId);
      const stmt = db.prepare(`
        INSERT INTO aria_catalog_sources (instance_id, source_id, name, type,
          items_imported, items_found, last_import_at, last_import_errors)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const c of catalogSources) {
        const errors = c?.lastImportErrors;
        stmt.run(instanceId, c?.id != null ? String(c.id) : null, c?.name ?? null, c?.typeId ?? null,
          c?.itemsImported != null ? Number(c.itemsImported) : null,
          c?.itemsFound != null ? Number(c.itemsFound) : null,
          c?.lastImportStartedAt ?? null,
          errors ? (Array.isArray(errors) ? errors.join('; ') : String(errors)) : null);
      }
    }

    if (fabricImages !== null) {
      db.prepare('DELETE FROM aria_images WHERE instance_id = ?').run(instanceId);
      const stmt = db.prepare(`
        INSERT INTO aria_images (instance_id, image_id, name, description, external_id,
          region, os_family, is_private, custom_properties, created_at_src, updated_at_src)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const img of fabricImages) {
        stmt.run(instanceId, img?.id != null ? String(img.id) : null, img?.name ?? null,
          img?.description ?? null, img?.externalId ?? null,
          img?.externalRegionId ?? img?.region ?? null, img?.osFamily ?? null,
          img?.isPrivate != null ? (img.isPrivate ? 1 : 0) : null,
          img?.customProperties ? JSON.stringify(img.customProperties) : null,
          img?.createdAt ?? null, img?.updatedAt ?? null);
      }
    }

    if (imageProfiles !== null) {
      db.prepare('DELETE FROM aria_image_mappings WHERE instance_id = ?').run(instanceId);
      const stmt = db.prepare(`
        INSERT INTO aria_image_mappings (instance_id, profile_id, profile_name, region,
          mapping_name, image_name, image_external_id, os_family, description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const p of imageProfiles) {
        const region = profileRegion(p);
        for (const [mappingName, img] of mappingEntries(p, 'imageMapping', 'imageMappings')) {
          const o = (img && typeof img === 'object') ? img : {};
          stmt.run(instanceId, p?.id != null ? String(p.id) : null, p?.name ?? null, region,
            mappingName, mappingImageName(img), o.externalId ?? o.image?.externalId ?? null,
            o.osFamily ?? o.image?.osFamily ?? null, o.description ?? o.image?.description ?? null);
        }
      }
    }

    if (flavorProfiles !== null) {
      db.prepare('DELETE FROM aria_flavor_mappings WHERE instance_id = ?').run(instanceId);
      const stmt = db.prepare(`
        INSERT INTO aria_flavor_mappings (instance_id, profile_name, region, mapping_name, cpu_count, memory_mb)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const p of flavorProfiles) {
        const region = profileRegion(p);
        for (const [mappingName, f] of mappingEntries(p, 'flavorMapping', 'flavorMappings')) {
          stmt.run(instanceId, p?.name ?? null, region, mappingName,
            f?.cpuCount != null ? Number(f.cpuCount) : null,
            f?.memoryInMB != null ? Number(f.memoryInMB) : (f?.memoryMb != null ? Number(f.memoryMb) : null));
        }
      }
    }

    if (blueprints !== null) {
      db.prepare('DELETE FROM aria_blueprints WHERE instance_id = ?').run(instanceId);
      const stmt = db.prepare(`
        INSERT INTO aria_blueprints (instance_id, blueprint_id, name, project_name, status,
          updated_at_src, image_refs)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const b of blueprints) {
        stmt.run(instanceId, b?.id != null ? String(b.id) : null, b?.name ?? null,
          b?.projectName ?? b?.project?.name ?? null,
          b?.status ?? (b?.released != null ? (b.released ? 'RELEASED' : 'DRAFT') : null),
          b?.updatedAt ?? null,
          Array.isArray(b?.imageRefs) ? JSON.stringify(b.imageRefs) : null);
      }
    }

    if (approvals !== null) {
      db.prepare('DELETE FROM aria_approvals WHERE instance_id = ?').run(instanceId);
      const stmt = db.prepare(`
        INSERT INTO aria_approvals (instance_id, approval_id, subject, requested_by, status, created_at_src)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const a of approvals) {
        stmt.run(instanceId, a?.id != null ? String(a.id) : null, a?.subject ?? null,
          a?.requestedBy ?? null, a?.status ?? null, a?.createdAt ?? null);
      }
    }

    // Append-only logs: INSERT OR IGNORE keeps a stable identity across polls,
    // then each is trimmed to its newest 2000 rows for that instance.
    if (requests !== null) {
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO aria_requests (instance_id, request_id, deployment_id, name,
          status, requested_by, created_at_src, updated_at_src, detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of requests) {
        stmt.run(instanceId, r?.id != null ? String(r.id) : null, r?.deploymentId ?? null,
          r?.name ?? r?.actionName ?? null, r?.status ?? null, r?.requestedBy ?? null,
          r?.createdAt ?? null, r?.updatedAt ?? null,
          r?.statusDetails ?? r?.details ? String(r.statusDetails ?? r.details) : null);
      }
      db.prepare(`
        DELETE FROM aria_requests WHERE instance_id = ? AND id NOT IN (
          SELECT id FROM aria_requests WHERE instance_id = ? ORDER BY id DESC LIMIT 2000
        )
      `).run(instanceId, instanceId);
    }

    const runStmt = db.prepare(`
      INSERT OR IGNORE INTO aria_runs (instance_id, kind, run_id, name, status, project_name, started_at_src, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    if (Array.isArray(abxRuns)) {
      for (const r of abxRuns) {
        runStmt.run(instanceId, 'abx', r?.id != null ? String(r.id) : null, r?.name ?? null,
          r?.runState ?? r?.state ?? null, r?.project ?? null,
          r?.createdAt ?? (r?.createdMillis != null ? new Date(Number(r.createdMillis)).toISOString() : null),
          r?.error ?? r?.statusMessage ?? null);
      }
    }
    if (Array.isArray(pipelineExecutions)) {
      for (const r of pipelineExecutions) {
        runStmt.run(instanceId, 'pipeline', r?.id != null ? String(r.id) : null, r?.name ?? null,
          r?.status ?? null, r?.project ?? null, r?.createdAt ?? null, r?.statusMessage ?? null);
      }
    }
    if (abxRuns !== null || pipelineExecutions !== null) {
      db.prepare(`
        DELETE FROM aria_runs WHERE instance_id = ? AND id NOT IN (
          SELECT id FROM aria_runs WHERE instance_id = ? ORDER BY id DESC LIMIT 2000
        )
      `).run(instanceId, instanceId);
    }

    // Metrics snapshot: computed from the DB state right after the updates
    // above, so a section that kept its last-good rows still contributes.
    const depAgg = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status LIKE '%FAIL%' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN lease_expire_at IS NOT NULL AND julianday(lease_expire_at) - julianday('now') <= 7 THEN 1 ELSE 0 END) AS lease_expiring
      FROM aria_deployments WHERE instance_id = ?
    `).get(instanceId);
    const reqAgg = db.prepare(`
      SELECT COUNT(*) AS total, SUM(CASE WHEN status LIKE '%FAIL%' THEN 1 ELSE 0 END) AS failed
      FROM aria_requests WHERE instance_id = ? AND captured_at >= datetime('now', '-24 hours')
    `).get(instanceId);
    const epAgg = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN health_state IS NOT NULL AND LOWER(health_state) NOT IN ('ok','up','healthy','connected','active','available') THEN 1 ELSE 0 END) AS unhealthy
      FROM aria_endpoints WHERE instance_id = ?
    `).get(instanceId);
    const runsFailed = db.prepare(`
      SELECT COUNT(*) AS n FROM aria_runs
      WHERE instance_id = ? AND status LIKE '%FAIL%' AND captured_at >= datetime('now', '-24 hours')
    `).get(instanceId).n;
    const approvalsPending = db.prepare(`
      SELECT COUNT(*) AS n FROM aria_approvals WHERE instance_id = ? AND status LIKE '%PENDING%'
    `).get(instanceId).n;

    db.prepare(`
      INSERT INTO aria_metrics_history (instance_id, deployments_total, deployments_failed,
        deployments_lease_expiring, requests_24h_total, requests_24h_failed, endpoints_total,
        endpoints_unhealthy, runs_24h_failed, approvals_pending)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(instanceId, depAgg.total, depAgg.failed, depAgg.lease_expiring,
      reqAgg.total, reqAgg.failed, epAgg.total, epAgg.unhealthy, runsFailed, approvalsPending);
    db.prepare("DELETE FROM aria_metrics_history WHERE captured_at < datetime('now', '-365 days')").run();
  });
}

async function pollAria(row, coreApi) {
  const db = coreApi.db;
  const store = buildStore(coreApi);
  try {
    const data = await collect(row, coreApi);
    store(row.id, data);
    db.prepare(`
      UPDATE aria_instances SET last_poll_status = 'success', last_poll_error = NULL,
        last_poll_at = datetime('now') WHERE id = ?
    `).run(row.id);
    coreApi.logger.info(`[AriaPoller] ${row.name}: ${(data.deployments || []).length} deployment(s), ${(data.requests || []).length} request(s)`);
  } catch (err) {
    db.prepare(`
      UPDATE aria_instances SET reachable = 0, last_poll_status = 'error', last_poll_error = ?,
        last_poll_at = datetime('now') WHERE id = ?
    `).run(safeMsg(err), row.id);
    throw err;
  } finally {
    // Runs on success AND failure so "instance unreachable" opens/resolves in
    // the issue timeline as soon as the poll outcome is recorded.
    try { reconcileIssueHistory(coreApi); } catch (err) {
      coreApi.logger.warn(`[AriaPoller] issue-history reconcile failed: ${err.message}`);
    }
  }
}

function buildPoller(coreApi) {
  return coreApi.createPoller({
    id: 'aria',
    loadSources: () => coreApi.db.prepare('SELECT * FROM aria_instances').all(),
    intervalMinutes: (row) => row.polling_interval_minutes,
    poll: (row) => pollAria(row, coreApi),
  });
}

/** Shared singleton instance poller (schedule/cancel/trigger/init/stopAll),
 *  built lazily on first access regardless of whether createRouter or
 *  manifest.createPoller reaches it first. */
function getPoller(coreApi) {
  if (!pollerInstance) pollerInstance = buildPoller(coreApi);
  return pollerInstance;
}

/** Manifest createPoller(coreApi) entry point. On a demo instance ONLY, this
 *  regenerates the fixture estate first (demoSeed.js), so demo timestamps
 *  stay relative to boot. Real instances never seed. Returns a handle
 *  mirroring the built-in's createPoller() shape. */
function createAriaPoller(coreApi) {
  if (process.env.DASHBOARD_DEMO === '1') {
    const seedDemo = () => {
      try {
        const { seedAriaDemo } = require('./demoSeed');
        const r = seedAriaDemo(coreApi);
        coreApi.logger.info(`[AriaPoller] demo estate seeded: ${r.instances} instances, ${r.deployments} deployments`);
        return r;
      } catch (err) {
        coreApi.logger.warn(`[AriaPoller] demo seed failed: ${err.message}`);
        return null;
      }
    };
    seedDemo();
    // Demo instances seed fixtures but NEVER poll them: the seeded vRA hosts
    // are fictitious internal names, but polling them for real would still
    // hammer DNS/connect failures every cycle and eventually flip the
    // pristine demo estate to error state. trigger() re-seeds instead,
    // matching the demo Refresh button semantics.
    return {
      init: () => { coreApi.logger.info('[AriaPoller] demo mode — polling disabled, fixtures only'); return []; },
      stopAll: () => {},
      trigger: () => { seedDemo(); return Promise.resolve(); },
      schedule: () => {},
      cancel: () => {},
      taskCount: () => 0,
    };
  }

  const ariaPoller = getPoller(coreApi);

  return {
    init: () => {
      const sources = ariaPoller.init();
      coreApi.logger.info(`[AriaPoller] Initialized ${sources.length} Aria instance(s)`);
      return sources;
    },
    stopAll: () => ariaPoller.stopAll(),
    trigger: (rowOrId) => {
      const row = typeof rowOrId === 'object' ? rowOrId : coreApi.db.prepare('SELECT * FROM aria_instances WHERE id = ?').get(rowOrId);
      return row ? ariaPoller.trigger(row) : Promise.resolve();
    },
    schedule: (row) => ariaPoller.schedule(row),
    cancel: (rowId) => ariaPoller.cancel(rowId),
    taskCount: () => ariaPoller.taskCount(),
  };
}

module.exports = { createAriaPoller, getPoller, pollAria };
