// App Services cross-platform linking story. The generated Cohesity objects
// and Zerto VMs use their own name shapes, so no usage-id tagged vCenter VM
// ever matched a backup or a replication record and every app's Backup and
// DR Replication panels sat empty. This scenario layers matching records
// over every tagged VM, after the platform generators have run:
//   - a Cohesity object per tagged VM on the VM's own site cluster, backed
//     up inside the acceptable age (Succeeded, 2-20 h old), wired to that
//     cluster's real VM_Prod_Backup group so Backup History lines up
//   - one app with stale backups (pp00003117, 30-80 h old) and one legacy
//     app only half protected (aa00001803), so the panels show the
//     degraded and unprotected states too
//   - Zerto VPGs per site for the Customer portal app (aa00001722,
//     replicating to the site's DR pair) and for the Mobile Banking API
//     (aa00001790) a VPG whose recovery site is an AWS ZCA, so the DR
//     component tells the on-prem and the cloud story
// Re-runnable: it removes its own rows first (object_id >= 90000,
// identifiers prefixed demo-appsvc-).
const { randInt, rngFor } = require('../generators/core');

const TAG = 'usage-id: ';
const OBJECT_ID_BASE = 90000;
const STALE_APP = 'pp00003117';      // Data warehouse: backups run late
const PARTIAL_APP = 'aa00001803';    // Legacy Statements: half unprotected
const DR_APPS = {
  aa00001722: { vpgApp: 'CustPortal', target: 'pair' }, // Customer portal
  aa00001790: { vpgApp: 'MobileBankingAPI', target: 'aws' }, // Mobile Banking API
};
// Zerto site pairs seeded by generators/zerto.js.
const ZERTO_PAIRS = { nyc: 'lon', fra: 'sgp', chi: 'dal' };
const AWS_SITE = { identifier: 'demo-site-aws', name: 'aws-use1-zca-01' };

function applyAppServiceLinking(db, { now = Date.now() } = {}) {
  const nowIso = new Date(now).toISOString();

  db.prepare(`DELETE FROM cohesity_objects WHERE object_id >= ${OBJECT_ID_BASE}`).run();
  db.prepare("DELETE FROM zerto_vms WHERE vm_identifier LIKE 'demo-appsvc-%'").run();
  db.prepare("DELETE FROM zerto_vpgs WHERE vpg_identifier LIKE 'demo-appsvc-%'").run();
  db.prepare('DELETE FROM zerto_sites WHERE site_identifier = ?').run(AWS_SITE.identifier);

  const vms = db.prepare(`
    SELECT m.name, m.guest_os, m.storage_committed_bytes, lower(jt.value) AS tag
    FROM vcenter_vms m, json_each(COALESCE(m.tags, '[]')) jt
    WHERE lower(jt.value) LIKE '${TAG}%'
    ORDER BY m.name
  `).all();

  const clusterFor = new Map();
  const jobFor = new Map();
  const site = (vmName) => vmName.split('-')[0];
  const lookupCluster = (s) => {
    if (!clusterFor.has(s)) {
      const row = db.prepare("SELECT id, name FROM clusters WHERE name LIKE ? || '-coh-prd-%' ORDER BY name LIMIT 1").get(s)
        || db.prepare('SELECT id, name FROM clusters ORDER BY name LIMIT 1').get();
      clusterFor.set(s, row || null);
    }
    return clusterFor.get(s);
  };
  const lookupJob = (clusterId) => {
    if (!jobFor.has(clusterId)) {
      const row = db.prepare("SELECT DISTINCT job_name FROM protection_runs WHERE cluster_id = ? AND job_name LIKE 'VM_Prod_Backup%' ORDER BY job_name LIMIT 1").get(clusterId);
      jobFor.set(clusterId, row?.job_name || 'VM_Prod_Backup_1');
    }
    return jobFor.get(clusterId);
  };

  const insertObject = db.prepare(`
    INSERT INTO cohesity_objects
      (cluster_id, object_id, global_id, name, source_name, environment, object_type,
       os_type, protection_type, logical_bytes, is_protected, protection_groups,
       policy_names, last_backup_status, sla_violated, last_backup_ms, captured_at)
    VALUES (?, ?, ?, ?, ?, 'VMware', 'VirtualMachine', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let objectRows = 0;
  let unprotected = 0;
  const drMembers = new Map(); // usageId -> [{ name, site, bytes }]
  for (const vm of vms) {
    const usageId = vm.tag.slice(TAG.length);
    const s = site(vm.name);
    const cluster = lookupCluster(s);
    if (!cluster) continue;
    const rng = rngFor(`appsvc-${vm.name}`);
    const partialSkip = usageId === PARTIAL_APP && objectRows % 2 === 1;
    const isProtected = !partialSkip;
    const ageHours = usageId === STALE_APP ? randInt(rng, 30, 80) : randInt(rng, 2, 20);
    const objectId = OBJECT_ID_BASE + objectRows;
    const job = lookupJob(cluster.id);
    insertObject.run(
      cluster.id, objectId, `${cluster.id}:demo:${objectId}`,
      vm.name, `vc-${s}.icc.demo`,
      String(vm.guest_os || '').includes('Windows') ? 'Windows' : 'Linux',
      vm.storage_committed_bytes || 100e9,
      isProtected ? 1 : 0,
      isProtected ? JSON.stringify([job]) : null,
      isProtected ? JSON.stringify([`${s}-vmware-daily`]) : null,
      isProtected ? 'Succeeded' : null,
      isProtected ? 0 : null,
      isProtected ? now - ageHours * 3600000 - randInt(rng, 0, 50) * 60000 : null,
      nowIso
    );
    objectRows++;
    if (!isProtected) unprotected++;
    if (DR_APPS[usageId]) {
      if (!drMembers.has(usageId)) drMembers.set(usageId, []);
      drMembers.get(usageId).push({ name: vm.name, site: s, bytes: vm.storage_committed_bytes || 100e9 });
    }
  }

  // ── Zerto DR coverage ────────────────────────────────────────────────────
  const insertVpg = db.prepare(`
    INSERT INTO zerto_vpgs (vpg_identifier, name, vms_count,
      protected_site, protected_site_type, recovery_site, recovery_site_type,
      actual_rpo, configured_rpo, health, status, sub_status,
      actual_journal_history, configured_journal_history, zorg_name, captured_at)
    VALUES (?, ?, ?, ?, 'vCenter', ?, ?, ?, 300, 'Healthy', 'MeetingSLA', 'None', ?, 24, 'ICC Demo Org', ?)
  `);
  const insertZvm = db.prepare(`
    INSERT INTO zerto_vms (vm_identifier, name, provisioned_storage_mb, used_storage_mb,
      vpg_names, vpg_statuses, protected_site, recovery_site, zorg_name, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ICC Demo Org', ?)
  `);

  let vpgRows = 0;
  let zvmRows = 0;
  let awsSiteAdded = 0;
  const needAwsSite = [...drMembers.keys()].some((id) => DR_APPS[id].target === 'aws');
  if (needAwsSite) {
    db.prepare(`
      INSERT INTO zerto_sites (site_identifier, name, site_type, version, zvm_ip,
        connection_status, last_connection_time, is_transmission_enabled, zorgs, updated_at)
      VALUES (?, ?, 'AWS', '10.0 U3', NULL, 'Connected', ?, 1, ?, ?)
    `).run(AWS_SITE.identifier, AWS_SITE.name, nowIso, JSON.stringify(['ICC Demo Org']), nowIso);
    awsSiteAdded = 1;
  }

  for (const [usageId, members] of drMembers) {
    const app = DR_APPS[usageId];
    // One VPG per protected site the app's servers live on.
    const bySite = new Map();
    for (const m of members) {
      if (!bySite.has(m.site)) bySite.set(m.site, []);
      bySite.get(m.site).push(m);
    }
    for (const [s, list] of bySite) {
      // Sites without a seeded ZVM pair protect through nyc, like a stretched
      // ZVM would; the AWS app always recovers into the ZCA.
      const zvmSite = ZERTO_PAIRS[s] ? s : 'nyc';
      const from = `${zvmSite}-zvm-prd-01`;
      const to = app.target === 'aws' ? AWS_SITE.name : `${ZERTO_PAIRS[zvmSite]}-zvm-dr-01`;
      const toType = app.target === 'aws' ? 'AWS' : 'vCenter';
      const rng = rngFor(`appsvc-vpg-${usageId}-${s}`);
      const vpgName = app.target === 'aws'
        ? `${s.toUpperCase()}-${app.vpgApp}-AWS-VPG-01`
        : `${s.toUpperCase()}-${app.vpgApp}-VPG-01`;
      insertVpg.run(
        `demo-appsvc-vpg-${usageId}-${s}`, vpgName, list.length,
        from, to, toType, randInt(rng, 8, 40), randInt(rng, 24, 30), nowIso
      );
      vpgRows++;
      for (const m of list) {
        const provisionedMb = Math.max(1, Math.round(m.bytes / (1024 * 1024)));
        insertZvm.run(
          `demo-appsvc-${m.name}`, m.name, provisionedMb, Math.round(provisionedMb * 0.6),
          JSON.stringify([vpgName]), JSON.stringify(['MeetingSLA']),
          from, to, nowIso
        );
        zvmRows++;
      }
    }
  }

  return { objects: objectRows, unprotected, vpgs: vpgRows, zertoVms: zvmRows, awsSite: awsSiteAdded };
}

module.exports = { applyAppServiceLinking };
