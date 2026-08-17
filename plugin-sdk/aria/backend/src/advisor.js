// Aria AI Advisor: operations/governance/endpoint-health reports. Ported from
// backend/services/advisors/ariaAdvisor.js. The original module eagerly
// required the host's db + services/platformAdvisor at require-time; a
// bundled plugin has neither available until coreApi is handed to it, so
// this exports a FACTORY — createAriaAdvisor(coreApi) — built lazily by
// router.js once coreApi is known (dell/nutanix advisor.js pattern). Per the
// plugin contract, coreApi.advisor is the host's services/platformAdvisor
// module (createPlatformAdvisor/linReg/parseUtcMs), never required directly.
function createAriaAdvisor(coreApi) {
  const db = coreApi.db;
  const { createPlatformAdvisor, linReg, parseUtcMs } = coreApi.advisor;

  function gatherOperations() {
    const instances = db.prepare('SELECT id, name FROM aria_instances').all();
    const names = new Map(instances.map((i) => [i.id, i.name]));

    const history = db.prepare(`
      SELECT instance_id, captured_at, deployments_total, deployments_failed, requests_24h_total, requests_24h_failed, runs_24h_failed
      FROM aria_metrics_history WHERE captured_at >= datetime('now', '-30 days') ORDER BY instance_id, captured_at ASC
    `).all();
    const byInstance = new Map();
    for (const r of history) {
      if (!byInstance.has(r.instance_id)) byInstance.set(r.instance_id, []);
      byInstance.get(r.instance_id).push(r);
    }
    const trend = instances.map((i) => {
      const series = byInstance.get(i.id) || [];
      const latest = series[series.length - 1];
      const pts = series.filter((r) => r.requests_24h_failed != null).map((r) => ({ x: parseUtcMs(r.captured_at), y: r.requests_24h_failed }));
      const reg = linReg(pts);
      return {
        instance: i.name,
        deploymentsTotal: latest?.deployments_total ?? null,
        deploymentsFailed: latest?.deployments_failed ?? null,
        requests24hTotal: latest?.requests_24h_total ?? null,
        requests24hFailed: latest?.requests_24h_failed ?? null,
        runs24hFailed: latest?.runs_24h_failed ?? null,
        requestFailureTrend: reg && reg.slope > 0 ? 'rising' : reg && reg.slope < 0 ? 'falling' : 'flat',
        dataPoints: series.length,
      };
    });

    const failedDeployments = db.prepare(`
      SELECT instance_id, name, project_name, raw_status_detail FROM aria_deployments
      WHERE status = 'FAILED' OR status = 'CREATE_FAILED' OR status LIKE '%FAIL%'
      LIMIT 30
    `).all().map((d) => ({ instance: names.get(d.instance_id) || `Instance ${d.instance_id}`, deployment: d.name, project: d.project_name, detail: d.raw_status_detail }));

    const failedRequests = db.prepare(`
      SELECT instance_id, name, detail, COUNT(*) count FROM aria_requests
      WHERE status = 'FAILED' AND updated_at_src >= datetime('now', '-1 day')
      GROUP BY instance_id, name, detail ORDER BY count DESC LIMIT 20
    `).all().map((r) => ({ instance: names.get(r.instance_id) || `Instance ${r.instance_id}`, request: r.name, detail: r.detail, count: r.count }));

    const failedRuns = db.prepare(`
      SELECT instance_id, kind, name, project_name, message FROM aria_runs
      WHERE status = 'FAILED'
      LIMIT 30
    `).all().map((r) => ({ instance: names.get(r.instance_id) || `Instance ${r.instance_id}`, kind: r.kind, run: r.name, project: r.project_name, message: r.message }));

    return {
      generatedAt: new Date().toISOString(),
      trend,
      failedDeployments,
      failedRequestsLast24h: failedRequests,
      failedRuns,
      note: instances.length === 0 ? 'No Aria Automation instances registered.' : undefined,
    };
  }

  function gatherGovernance() {
    const instances = db.prepare('SELECT id, name FROM aria_instances').all();
    const names = new Map(instances.map((i) => [i.id, i.name]));

    const deployments = db.prepare(`
      SELECT instance_id, name, project_name, lease_expire_at FROM aria_deployments
      WHERE lease_expire_at IS NOT NULL
    `).all();
    const leaseBuckets = { expired: 0, within7d: 0, within30d: 0, beyond: 0 };
    const expiringSoon = [];
    const now = Date.now();
    for (const d of deployments) {
      const ms = parseUtcMs(d.lease_expire_at);
      if (!ms) continue;
      const daysRemaining = Math.round((ms - now) / 86400000);
      if (daysRemaining < 0) leaseBuckets.expired += 1;
      else if (daysRemaining <= 7) leaseBuckets.within7d += 1;
      else if (daysRemaining <= 30) leaseBuckets.within30d += 1;
      else leaseBuckets.beyond += 1;
      if (daysRemaining <= 30) {
        expiringSoon.push({ instance: names.get(d.instance_id) || `Instance ${d.instance_id}`, deployment: d.name, project: d.project_name, daysRemaining });
      }
    }
    expiringSoon.sort((a, b) => a.daysRemaining - b.daysRemaining);

    const approvalsPending = db.prepare(`
      SELECT instance_id, subject, requested_by, created_at_src FROM aria_approvals
      WHERE status = 'PENDING' ORDER BY created_at_src ASC LIMIT 30
    `).all().map((a) => ({ instance: names.get(a.instance_id) || `Instance ${a.instance_id}`, subject: a.subject, requestedBy: a.requested_by, createdAt: a.created_at_src }));

    const catalogErrors = db.prepare(`
      SELECT instance_id, name, last_import_errors, last_import_at FROM aria_catalog_sources
      WHERE last_import_errors IS NOT NULL AND last_import_errors != '' AND last_import_errors != '[]'
    `).all().map((c) => ({ instance: names.get(c.instance_id) || `Instance ${c.instance_id}`, source: c.name, errors: c.last_import_errors, lastImportAt: c.last_import_at }));

    const blueprints = db.prepare('SELECT instance_id, image_refs FROM aria_blueprints').all()
      .map((b) => ({ instance_id: b.instance_id, refs: b.image_refs ? JSON.parse(b.image_refs) : [] }));
    const referencedNames = new Map(); // instance_id -> Set of referenced mapping/image names
    for (const b of blueprints) {
      if (!referencedNames.has(b.instance_id)) referencedNames.set(b.instance_id, new Set());
      for (const r of b.refs) referencedNames.get(b.instance_id).add(r);
    }
    const mappings = db.prepare('SELECT instance_id, mapping_name, image_name FROM aria_image_mappings').all();
    const mappedImageNames = new Map(); // instance_id -> Set of image names used via a referenced mapping
    for (const m of mappings) {
      const refs = referencedNames.get(m.instance_id);
      if (refs && refs.has(m.mapping_name)) {
        if (!mappedImageNames.has(m.instance_id)) mappedImageNames.set(m.instance_id, new Set());
        mappedImageNames.get(m.instance_id).add(m.image_name);
      }
    }
    const images = db.prepare('SELECT instance_id, name FROM aria_images').all();
    const unusedImages = images.filter((img) => {
      const refs = referencedNames.get(img.instance_id);
      const directlyUsed = refs && refs.has(img.name);
      const viaMapping = mappedImageNames.get(img.instance_id)?.has(img.name);
      return !directlyUsed && !viaMapping;
    }).map((img) => ({ instance: names.get(img.instance_id) || `Instance ${img.instance_id}`, image: img.name }))
      .slice(0, 30);

    return {
      generatedAt: new Date().toISOString(),
      leaseBuckets,
      deploymentsWithLeaseExpiringWithin30d: expiringSoon.slice(0, 30),
      approvalsPending,
      catalogImportErrors: catalogErrors,
      unusedImages,
      unusedImageCount: images.length ? unusedImages.length : null,
      totalImages: images.length,
      note: instances.length === 0 ? 'No Aria Automation instances registered.' : undefined,
    };
  }

  function gatherEndpointHealth() {
    const instances = db.prepare(`
      SELECT id, name, reachable, cert_subject, cert_valid_to, last_poll_status, last_poll_error FROM aria_instances
    `).all();
    const endpoints = db.prepare(`
      SELECT instance_id, name, kind, type, health_state FROM aria_endpoints
      WHERE health_state IS NOT NULL AND health_state != 'OK'
      LIMIT 30
    `).all();
    const names = new Map(instances.map((i) => [i.id, i.name]));
    const unhealthyEndpoints = endpoints.map((e) => ({
      instance: names.get(e.instance_id) || `Instance ${e.instance_id}`,
      endpoint: e.name, kind: e.kind, type: e.type, healthState: e.health_state,
    }));

    const now = Date.now();
    const certsExpiringSoon = instances
      .filter((i) => i.cert_valid_to)
      .map((i) => ({ instance: i.name, subject: i.cert_subject, daysRemaining: Math.round((parseUtcMs(i.cert_valid_to) - now) / 86400000) }))
      .filter((c) => c.daysRemaining <= 60)
      .sort((a, b) => a.daysRemaining - b.daysRemaining);

    const unreachableInstances = instances
      .filter((i) => i.reachable === 0 || i.last_poll_status === 'error')
      .map((i) => ({ instance: i.name, reachable: !!i.reachable, lastPollStatus: i.last_poll_status, lastPollError: i.last_poll_error }));

    return {
      generatedAt: new Date().toISOString(),
      unreachableInstances,
      certsExpiringWithin60d: certsExpiringSoon,
      unhealthyEndpoints,
      note: instances.length === 0 ? 'No Aria Automation instances registered.' : undefined,
    };
  }

  return createPlatformAdvisor({
    platform: 'aria',
    feature: 'Aria AI Advisor',
    table: 'aria_ai_reports',
    reports: {
      operations: {
        system:
          'You are a VMware Aria Automation (vRA) operations engineer. You are given per-instance deployment/request/run ' +
          'failure trends, failed deployments, the last 24h of failed requests with detail themes, and failed ' +
          'ABX/pipeline runs. Group failures into likely root-cause themes and prioritize by impact. Do not invent data. ' +
          'Markdown sections: **Summary**, **Systemic failure themes**, **Recommended actions**. Keep under ~400 words.',
        gather: gatherOperations,
        noun: 'operations review',
      },
      governance: {
        system:
          'You are a VMware Aria Automation governance analyst. You are given deployment lease-expiry buckets and the ' +
          'deployments expiring within 30 days, pending approvals (oldest first), catalog source import errors, and ' +
          'fabric images not referenced by any image mapping or blueprint (unused). Flag governance risks: leases about ' +
          'to expire, stale pending approvals, broken catalog imports, and cleanup candidates. Do not invent data. ' +
          'Markdown sections: **Summary**, **Governance risks (prioritized)**, **Cleanup candidates**, ' +
          '**Recommended actions**. Keep under ~400 words.',
        gather: gatherGovernance,
        noun: 'governance review',
      },
      endpoint_health: {
        system:
          'You are a VMware Aria Automation platform engineer. You are given instances that are unreachable or last ' +
          'failed to poll, instance management-certificate expiry within 60 days, and cloud-account/integration endpoints ' +
          'not in a healthy state. Prioritize by operational risk. Do not invent data. Markdown sections: **Summary**, ' +
          '**Key risks (prioritized)**, **Recommended actions**. Keep under ~300 words.',
        gather: gatherEndpointHealth,
        noun: 'endpoint health report',
      },
    },
  });
}

module.exports = { createAriaAdvisor };
