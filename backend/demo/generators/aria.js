// VMware Aria Automation (vRA) demo data: two on-prem instances with
// deployments, requests, endpoints, projects, catalog sources, abx/pipeline
// runs, and approvals. Includes deliberate trouble so the Overview issues
// panel demos every rule: unhealthy endpoints, failed deployments, leases
// expiring/expired, an expiring TLS cert, catalog import errors, failed
// runs, and pending approvals.
const { randInt, randFloat, pick, chance, rngFor } = require('./core');

const PROJECT_NAMES = ['Platform Eng', 'Data Science', 'QA Sandbox', 'Customer Portal', 'Internal Tools', 'Networking'];
const DEPLOYMENT_ROLES = ['web-app', 'db-cluster', 'k8s-node-pool', 'batch-worker', 'analytics-stack', 'jump-host'];
const REQUEST_ACTIONS = ['Create Deployment', 'Resize', 'Power Off', 'Power On', 'Destroy Deployment', 'Change Lease'];
const CLOUD_ACCOUNTS = [
  { name: 'vsphere-prod-01', type: 'vsphere' },
  { name: 'vsphere-dr-01', type: 'vsphere' },
  { name: 'aws-shared', type: 'aws' },
];
const INTEGRATIONS = [
  { name: 'nsx-prod', type: 'nsx-t' },
  { name: 'ansible-tower', type: 'ansible' },
  { name: 'servicenow-cmdb', type: 'itsm' },
];
const CATALOG_SOURCES = [
  { name: 'Terraform Modules', type: 'terraform' },
  { name: 'VRO Workflows', type: 'workflow' },
  { name: 'ABX Actions Catalog', type: 'abx' },
];
const REGIONS = ['Datacenter:dc-prod', 'Datacenter:dc-dr'];
const FABRIC_IMAGES = [
  { name: 'ubuntu-22.04-cloudimg-tmpl', os: 'LINUX', desc: 'Ubuntu 22.04 LTS cloud image' },
  { name: 'ubuntu-20.04-cloudimg-tmpl', os: 'LINUX', desc: 'Ubuntu 20.04 LTS cloud image' },
  { name: 'rhel-9.3-base-tmpl', os: 'LINUX', desc: 'RHEL 9.3 hardened base' },
  { name: 'win2022-std-core-tmpl', os: 'WINDOWS', desc: 'Windows Server 2022 Standard Core' },
  { name: 'win2019-std-tmpl', os: 'WINDOWS', desc: 'Windows Server 2019 Standard' },
  { name: 'photon-5-minimal-tmpl', os: 'LINUX', desc: 'Photon OS 5 minimal' },
];
const IMAGE_MAPPINGS = [
  { mapping: 'ubuntu-22', image: 'ubuntu-22.04-cloudimg-tmpl', os: 'LINUX' },
  { mapping: 'ubuntu-20', image: 'ubuntu-20.04-cloudimg-tmpl', os: 'LINUX' },
  { mapping: 'rhel-9', image: 'rhel-9.3-base-tmpl', os: 'LINUX' },
  { mapping: 'win-2022', image: 'win2022-std-core-tmpl', os: 'WINDOWS' },
];
// Blueprints reference image MAPPING names; 'rhel-9' is deliberately never
// referenced and photon/win2019 have no mapping, so the Unused Images panel
// always has content to demo.
const BLUEPRINTS = [
  { name: 'three-tier-web', images: ['ubuntu-22'], status: 'RELEASED' },
  { name: 'k8s-worker-pool', images: ['ubuntu-22'], status: 'RELEASED' },
  { name: 'sql-cluster', images: ['win-2022'], status: 'RELEASED' },
  { name: 'legacy-batch', images: ['ubuntu-20'], status: 'DRAFT' },
  { name: 'analytics-sandbox', images: ['ubuntu-22', 'ubuntu-20'], status: 'RELEASED' },
];
const FLAVOR_MAPPINGS = [
  { name: 'small', cpu: 2, memMb: 4096 },
  { name: 'medium', cpu: 4, memMb: 8192 },
  { name: 'large', cpu: 8, memMb: 16384 },
  { name: 'xlarge', cpu: 16, memMb: 32768 },
];

function seedAria(db, { now, encrypt }) {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES ('platform_aria_enabled', '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run();

  const nowIso = new Date(now).toISOString();
  const instances = [
    { name: 'vra-prod', host: 'vra-prod.demo.local', certDays: 700 },
    { name: 'vra-dr', host: 'vra-dr.demo.local', certDays: 20 }, // trips the cert-expiring rule
  ];

  const instStmt = db.prepare(`
    INSERT INTO aria_instances (name, host, username, domain, encrypted_credentials, ssl_verify,
      polling_interval_minutes, version, api_version, reachable,
      cert_subject, cert_issuer, cert_valid_from, cert_valid_to,
      last_poll_status, last_poll_error, last_poll_at, created_at, updated_at)
    VALUES (?, ?, 'demo-viewer', NULL, ?, 0, 15, ?, ?, 1, ?, ?, ?, ?, 'success', NULL, ?, ?, ?)
  `);
  const depStmt = db.prepare(`
    INSERT INTO aria_deployments (instance_id, deployment_id, name, project_name, status,
      created_by, created_at_src, updated_at_src, lease_expire_at, resource_count, raw_status_detail, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const reqStmt = db.prepare(`
    INSERT OR IGNORE INTO aria_requests (instance_id, request_id, deployment_id, name, status,
      requested_by, created_at_src, updated_at_src, detail, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const epStmt = db.prepare(`
    INSERT INTO aria_endpoints (instance_id, endpoint_id, kind, name, type, health_state, detail, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const projStmt = db.prepare(`
    INSERT INTO aria_projects (instance_id, project_id, name, description, captured_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const catStmt = db.prepare(`
    INSERT INTO aria_catalog_sources (instance_id, source_id, name, type, items_imported,
      items_found, last_import_at, last_import_errors, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const runStmt = db.prepare(`
    INSERT OR IGNORE INTO aria_runs (instance_id, kind, run_id, name, status, project_name, started_at_src, message, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const apprStmt = db.prepare(`
    INSERT INTO aria_approvals (instance_id, approval_id, subject, requested_by, status, created_at_src, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const imgStmt = db.prepare(`
    INSERT INTO aria_images (instance_id, image_id, name, description, external_id,
      region, os_family, is_private, custom_properties, created_at_src, updated_at_src, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const imgMapStmt = db.prepare(`
    INSERT INTO aria_image_mappings (instance_id, profile_id, profile_name, region,
      mapping_name, image_name, image_external_id, os_family, description, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const flavorStmt = db.prepare(`
    INSERT INTO aria_flavor_mappings (instance_id, profile_name, region, mapping_name, cpu_count, memory_mb, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const bpStmt = db.prepare(`
    INSERT INTO aria_blueprints (instance_id, blueprint_id, name, project_name, status, updated_at_src, image_refs, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const histStmt = db.prepare(`
    INSERT INTO aria_metrics_history (instance_id, captured_at, deployments_total, deployments_failed,
      deployments_lease_expiring, requests_24h_total, requests_24h_failed, endpoints_total,
      endpoints_unhealthy, runs_24h_failed, approvals_pending)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totals = { instances: 0, deployments: 0, requests: 0, endpoints: 0, projects: 0, catalogSources: 0, runs: 0, approvals: 0, images: 0, imageMappings: 0, flavors: 0, blueprints: 0 };
  let depIdSeq = 1000;
  let reqIdSeq = 5000;
  let runIdSeq = 9000;
  let apprIdSeq = 3000;

  for (const inst of instances) {
    const rng = rngFor(inst.name);
    const certValidTo = new Date(now + inst.certDays * 86400000).toISOString();
    const info = instStmt.run(
      inst.name, inst.host, encrypt(JSON.stringify({ password: 'demo-not-real' })),
      '8.16.0', '2021-07-15',
      `CN=${inst.host}, O=ICC Demo, C=US`, 'CN=CA, DC=vsphere, DC=local',
      new Date(now - 700 * 86400000).toISOString(), certValidTo,
      new Date(now - randInt(rng, 2, 14) * 60000).toISOString(), nowIso, nowIso
    );
    const instanceId = info.lastInsertRowid;
    totals.instances += 1;

    // ── Projects ─────────────────────────────────────────────────────────
    const projectCount = randInt(rng, 4, 6);
    const projects = PROJECT_NAMES.slice(0, projectCount);
    projects.forEach((name, idx) => {
      projStmt.run(instanceId, `proj-${idx + 1}`, name, `${name} workloads`, nowIso);
      totals.projects += 1;
    });

    // ── Deployments ──────────────────────────────────────────────────────
    const deploymentCount = randInt(rng, 40, 80);
    const deployments = [];
    for (let d = 0; d < deploymentCount; d++) {
      const deploymentId = `dep-${depIdSeq++}`;
      const project = pick(rng, projects);
      const role = pick(rng, DEPLOYMENT_ROLES);
      const name = `${role}-${String(d + 1).padStart(3, '0')}`;
      // ~6% failed, a few leases expiring within 7d, one expired.
      const failed = chance(rng, 0.06);
      const status = failed ? pick(rng, ['CREATE_FAILED', 'UPDATE_FAILED']) : 'CREATE_SUCCESSFUL';
      let leaseDays = randInt(rng, 10, 180);
      if (d === 0) leaseDays = -3; // expired
      else if (d < 4) leaseDays = randInt(rng, 1, 6); // expiring soon
      const leaseExpireAt = new Date(now + leaseDays * 86400000).toISOString();
      const createdAt = new Date(now - randInt(rng, 5, 400) * 86400000).toISOString();
      depStmt.run(instanceId, deploymentId, name, project, status,
        pick(rng, ['alice@demo.local', 'bob@demo.local', 'svc-provisioner@demo.local']),
        createdAt, nowIso, leaseExpireAt, randInt(rng, 1, 12),
        failed ? 'Provisioning failed: resource quota exceeded' : null, nowIso);
      totals.deployments += 1;
      deployments.push({ deploymentId, name });
    }

    // ── Requests (append+dedupe, last 48h) ──────────────────────────────
    const requestCount = randInt(rng, 100, 140);
    for (let r = 0; r < requestCount; r++) {
      const requestId = `req-${reqIdSeq++}`;
      const dep = pick(rng, deployments);
      const failed = chance(rng, 0.08);
      const minutesAgo = randInt(rng, 1, 48 * 60);
      const capturedAt = new Date(now - minutesAgo * 60000).toISOString();
      reqStmt.run(instanceId, requestId, dep.deploymentId, pick(rng, REQUEST_ACTIONS),
        failed ? 'FAILED' : 'SUCCESSFUL',
        pick(rng, ['alice@demo.local', 'bob@demo.local', 'svc-provisioner@demo.local']),
        capturedAt, capturedAt,
        failed ? 'Request failed: timeout waiting for provider response' : null, capturedAt);
      totals.requests += 1;
    }

    // ── Endpoints: cloud accounts + integrations ─────────────────────────
    const endpointDefs = [...CLOUD_ACCOUNTS, ...INTEGRATIONS];
    let unhealthyAssigned = false;
    endpointDefs.forEach((ep, idx) => {
      const isIntegration = idx >= CLOUD_ACCOUNTS.length;
      // Guarantee at least one unhealthy endpoint per instance.
      const forceUnhealthy = !unhealthyAssigned && idx === endpointDefs.length - 1;
      const unhealthy = forceUnhealthy || chance(rng, 0.1);
      if (unhealthy) unhealthyAssigned = true;
      epStmt.run(instanceId, `ep-${idx + 1}`, isIntegration ? 'integration' : 'cloud-account',
        ep.name, ep.type, unhealthy ? 'ERROR' : 'OK',
        JSON.stringify({ state: unhealthy ? 'ERROR' : 'OK' }), nowIso);
      totals.endpoints += 1;
    });

    // ── Catalog sources — one with import errors ────────────────────────
    CATALOG_SOURCES.forEach((src, idx) => {
      const hasErrors = idx === 0;
      const found = randInt(rng, 10, 60);
      const imported = hasErrors ? Math.max(0, found - randInt(rng, 1, 5)) : found;
      catStmt.run(instanceId, `cat-${idx + 1}`, src.name, src.type, imported, found,
        new Date(now - randInt(rng, 1, 24) * 3600000).toISOString(),
        hasErrors ? 'Failed to import 3 items: authentication error against upstream registry' : null, nowIso);
      totals.catalogSources += 1;
    });

    // ── Images: fabric images per region + curated mappings + flavors ────
    let imgIdSeq = 1;
    for (const region of REGIONS) {
      for (const img of FABRIC_IMAGES) {
        // Staggered discovery dates so "which image is newer" reads clearly.
        const discoveredDaysAgo = randInt(rng, 10, 500);
        imgStmt.run(instanceId, `img-${imgIdSeq}`, img.name, img.desc,
          `vm-template-${1000 + imgIdSeq}`, region, img.os, chance(rng, 0.3) ? 1 : 0,
          JSON.stringify({ diskSizeGb: pick(rng, [40, 60, 80, 120]) }),
          new Date(now - discoveredDaysAgo * 86400000).toISOString(),
          new Date(now - randInt(rng, 0, 3) * 86400000).toISOString(), nowIso);
        imgIdSeq += 1;
        totals.images += 1;
      }
      IMAGE_MAPPINGS.forEach((m) => {
        imgMapStmt.run(instanceId, `imgprof-${region}`, `${region.split(':')[1]}-images`, region,
          m.mapping, m.image, `vm-template-${1000 + FABRIC_IMAGES.findIndex((f) => f.name === m.image) + 1}`,
          m.os, `${m.mapping} standard build`, nowIso);
        totals.imageMappings += 1;
      });
      FLAVOR_MAPPINGS.forEach((f) => {
        flavorStmt.run(instanceId, `${region.split(':')[1]}-flavors`, region, f.name, f.cpu, f.memMb, nowIso);
        totals.flavors += 1;
      });
    }

    // ── Blueprints referencing image mappings (rhel-9 left unused) ───────
    BLUEPRINTS.forEach((bp, idx) => {
      bpStmt.run(instanceId, `bp-${idx + 1}`, bp.name, pick(rng, projects), bp.status,
        new Date(now - randInt(rng, 1, 90) * 86400000).toISOString(),
        JSON.stringify(bp.images), nowIso);
      totals.blueprints += 1;
    });

    // ── Runs: abx + pipeline over 48h ────────────────────────────────────
    const runCount = randInt(rng, 50, 70);
    for (let r = 0; r < runCount; r++) {
      const kind = chance(rng, 0.5) ? 'abx' : 'pipeline';
      const runId = `run-${runIdSeq++}`;
      const failed = chance(rng, 0.1);
      const minutesAgo = randInt(rng, 1, 48 * 60);
      const startedAt = new Date(now - minutesAgo * 60000).toISOString();
      runStmt.run(instanceId, kind, runId, `${kind}-${pick(rng, DEPLOYMENT_ROLES)}-run`,
        failed ? 'FAILED' : 'SUCCESSFUL', pick(rng, projects), startedAt,
        failed ? `${kind} run failed: script exited non-zero` : null, startedAt);
      totals.runs += 1;
    }

    // ── Approvals: 4, 2 pending and aged ─────────────────────────────────
    const approvals = [
      { status: 'PENDING', agedDays: 6 },
      { status: 'PENDING', agedDays: 3 },
      { status: 'APPROVED', agedDays: 20 },
      { status: 'REJECTED', agedDays: 15 },
    ];
    approvals.forEach((a) => {
      apprStmt.run(instanceId, `appr-${apprIdSeq++}`, `Deployment request approval`,
        pick(rng, ['alice@demo.local', 'bob@demo.local']), a.status,
        new Date(now - a.agedDays * 86400000).toISOString(), nowIso);
      totals.approvals += 1;
    });

    // ── Metrics history: hourly snapshots for 7 days ─────────────────────
    const histRng = rngFor(`${inst.name}-history`);
    for (let h = 7 * 24; h >= 0; h--) {
      const growth = 0.9 + ((7 * 24 - h) / (7 * 24)) * 0.1;
      histStmt.run(instanceId, new Date(now - h * 3600000).toISOString(),
        Math.round(deploymentCount * growth), randInt(histRng, 0, 5),
        randInt(histRng, 0, 4), randInt(histRng, 2, 8), randInt(histRng, 0, 2),
        endpointDefs.length, unhealthyAssigned ? randInt(histRng, 0, 1) : 0,
        randInt(histRng, 0, 3), randInt(histRng, 0, 2));
    }
  }

  // ── Deployment resources (Server 360 join): first three deployments of the
  // first instance own the nyc VM IPs 10.100.11.11-13 seeded as NetApp
  // clients, so the correlated view links vRA → vCenter → NetApp end to end.
  const drStmt = db.prepare(`
    INSERT INTO aria_deployment_resources
      (instance_id, deployment_id, resource_id, name, type, state, ip_addresses, captured_at)
    VALUES (?, ?, ?, ?, 'Cloud.vSphere.Machine', 'OK', ?, ?)
  `);
  const firstDeps = db.prepare(`
    SELECT instance_id, deployment_id, name FROM aria_deployments ORDER BY instance_id, id LIMIT 3
  `).all();
  firstDeps.forEach((dep, i) => {
    drStmt.run(dep.instance_id, dep.deployment_id, `res-${dep.deployment_id}-0`,
      `${dep.name}-vm-01`, JSON.stringify([`10.100.11.1${1 + i}`]), nowIso);
  });

  // ── Issue lifecycle history — the real reconcile against the just-seeded
  // inventory so aria_issue_history keys match computeIssues exactly. ─────
  const { reconcileIssueHistory } = require('../../services/ariaIssues');
  reconcileIssueHistory();

  return {
    ...totals,
    issueHistory: db.prepare('SELECT COUNT(*) n FROM aria_issue_history').get().n,
  };
}

module.exports = { seedAria };
