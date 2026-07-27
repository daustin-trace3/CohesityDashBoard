// Aria Automation poller — one scheduled task per registered instance
// (framework per-source model, like vCenter/Dell). Every section is fetched
// and stored independently: a failing section returns null and the
// conditional-replace guard below keeps whatever rows are already in the DB
// (null = section unavailable this poll, [] = genuinely empty). The poll as
// a whole only fails — and only then does it throw, so the framework marks
// the instance in error — when reachability or login itself fails.
const db = require('../db/database');
const { createPoller } = require('../core/pollerFramework');
const {
  fetchDeployments, fetchRequests, fetchCloudAccounts, fetchIntegrations,
  fetchProjects, fetchCatalogSources, fetchAbxRuns, fetchPipelineExecutions,
  fetchApprovals, fetchAbout, fetchHealth, fetchTlsCert, getBearer,
} = require('./ariaApi');
const { reconcileIssueHistory } = require('./ariaIssues');
const logger = require('../utils/logger');

const safeMsg = (e) => (e?.response ? `HTTP ${e.response.status}` : (e?.message || String(e)));

async function safe(label, row, fn) {
  try {
    return await fn();
  } catch (err) {
    logger.debug(`[AriaPoller] ${row.name}: ${label} failed (skipping): ${safeMsg(err)}`);
    return null;
  }
}

async function collect(row) {
  // Reachability + login are the only things allowed to fail the whole poll.
  try {
    await fetchHealth(row);
  } catch (err) {
    throw new Error(`Aria instance unreachable: ${safeMsg(err)}`);
  }
  await getBearer(row);

  const about = await safe('about', row, () => fetchAbout(row));
  const cert = await safe('tls cert', row, () => fetchTlsCert(row));
  const deployments = await safe('deployments', row, () => fetchDeployments(row));
  const requests = await safe('requests', row, () => fetchRequests(row));
  const cloudAccounts = await safe('cloud accounts', row, () => fetchCloudAccounts(row));
  const integrations = await safe('integrations', row, () => fetchIntegrations(row));
  const projects = await safe('projects', row, () => fetchProjects(row));
  const catalogSources = await safe('catalog sources', row, () => fetchCatalogSources(row));
  const abxRuns = await safe('abx runs', row, () => fetchAbxRuns(row));
  // vRO workflow runs skipped in v1 — per-workflow enumeration is too
  // expensive to poll fleet-wide; extensibility coverage is abx + pipeline.
  const pipelineExecutions = await safe('pipeline executions', row, () => fetchPipelineExecutions(row));
  const approvals = await safe('approvals', row, () => fetchApprovals(row));

  return {
    about, cert, deployments, requests, cloudAccounts, integrations,
    projects, catalogSources, abxRuns, pipelineExecutions, approvals,
  };
}

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

const store = db.transaction((instanceId, data) => {
  const {
    about, cert, deployments, requests, cloudAccounts, integrations,
    projects, catalogSources, abxRuns, pipelineExecutions, approvals,
  } = data;

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
        created_by, created_at_src, updated_at_src, lease_expire_at, resource_count, raw_status_detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const d of deployments) {
      stmt.run(instanceId, d?.id != null ? String(d.id) : null, d?.name ?? null,
        d?.projectName ?? d?.project?.name ?? null, d?.status ?? null,
        d?.createdBy ?? null, d?.createdAt ?? null, d?.lastUpdatedAt ?? null,
        d?.leaseExpireAt ?? null, d?.resourceCount != null ? Number(d.resourceCount) : null,
        d?.statusDetail ? JSON.stringify(d.statusDetail) : null);
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
  if (abxRuns !== null) {
    for (const r of abxRuns) {
      runStmt.run(instanceId, 'abx', r?.id != null ? String(r.id) : null, r?.name ?? null,
        r?.runState ?? r?.state ?? null, r?.project ?? null,
        r?.createdAt ?? (r?.createdMillis != null ? new Date(Number(r.createdMillis)).toISOString() : null),
        r?.error ?? r?.statusMessage ?? null);
    }
  }
  if (pipelineExecutions !== null) {
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

async function pollAria(row) {
  try {
    const data = await collect(row);
    store(row.id, data);
    db.prepare(`
      UPDATE aria_instances SET last_poll_status = 'success', last_poll_error = NULL,
        last_poll_at = datetime('now') WHERE id = ?
    `).run(row.id);
    logger.info(`[AriaPoller] ${row.name}: ${(data.deployments || []).length} deployment(s), ${(data.requests || []).length} request(s)`);
  } catch (err) {
    db.prepare(`
      UPDATE aria_instances SET reachable = 0, last_poll_status = 'error', last_poll_error = ?,
        last_poll_at = datetime('now') WHERE id = ?
    `).run(safeMsg(err), row.id);
    throw err;
  } finally {
    // Runs on success AND failure so "instance unreachable" opens/resolves in
    // the issue timeline as soon as the poll outcome is recorded.
    try { reconcileIssueHistory(); } catch (err) {
      logger.warn(`[AriaPoller] issue-history reconcile failed: ${err.message}`);
    }
  }
}

const ariaPoller = createPoller({
  id: 'aria',
  loadSources: () => db.prepare('SELECT * FROM aria_instances').all(),
  intervalMinutes: (row) => row.polling_interval_minutes,
  poll: pollAria,
});

function initAriaPoller() {
  const sources = ariaPoller.init();
  logger.info(`[AriaPoller] Initialized ${sources.length} Aria instance(s)`);
  return ariaPoller;
}

module.exports = { initAriaPoller, ariaPoller, pollAria };
