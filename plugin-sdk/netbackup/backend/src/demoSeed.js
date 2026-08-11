// NetBackup scope demo data: 2 sources (one on-prem primary, one Alta SaaS),
// 8 policies across VMware/MS-Windows/Standard/Oracle/NBU-Catalog, ~400 jobs
// over the last 7 days with a realistic overnight-heavy schedule and ~92%
// success, 4 storage units + 2 disk pools, 3 media servers, 5 appliances, 3
// upstream alerts, and 30 days of per-source metrics history. Includes
// deliberate trouble so the Overview issues panel demos every rule: a policy
// failing 100% for 2 straight days, a client with no successful backup in 4
// days, a disk pool pinned at 91% used, and a media server stuck DOWN.
//
// Ported from backend/demo/generators/netbackup.js — its require('./core')
// becomes require('./demoRng') (plugin-sdk/proxmox/backend/src/demoRng.js
// lift: only the seeded-random helpers, same export names). The original
// generator never required netbackupIssues.js (unlike proxmox's generator,
// which called reconcileIssueHistory) — it hand-seeds netbackup_issue_history
// directly, mirroring netbackupIssues.js's key scheme in a comment, so there
// is no dynamic require to repoint here.
//
// DEMO POLICY DEVIATION (per the conversion contract, not a guess): unlike
// plugin-sdk/proxmox's demoSeed.js (which wipes+reinserts its servers table
// every boot), this plugin's DEMO_TABLES wipe EXCLUDES netbackup_sources and
// netbackup_appliance_conns — the contract calls these "user tables" since a
// demo box can also carry manually-registered real sources alongside the
// seeded ones (see project_platform_connections: SaaS/Direct tabs, coexisting
// sources). insertSource/insertApplianceConn are upserts keyed on the UNIQUE
// name column instead of the original's plain INSERT, so re-seeding refreshes
// the two demo rows' fields/timestamps without violating the UNIQUE
// constraint and without touching any other registered source/connection.
const { randInt, randFloat, pick, chance, rngFor } = require('./demoRng');

const POLICY_DEFS = [
  { name: 'VMWARE-PROD-DAILY', type: 'VMware', clients: ['vm-web01', 'vm-web02', 'vm-app01', 'vm-app02', 'vm-db01'], weekly: false },
  { name: 'VMWARE-DEV-WEEKLY', type: 'VMware', clients: ['vm-dev01', 'vm-dev02', 'vm-dev03'], weekly: true },
  { name: 'WIN-FILESERVERS', type: 'MS-Windows', clients: ['win-fs01', 'win-fs02', 'win-fs03', 'win-fs04'], weekly: false },
  { name: 'WIN-DOMAIN-CONTROLLERS', type: 'MS-Windows', clients: ['win-dc01', 'win-dc02'], weekly: false },
  { name: 'STD-LINUX-DAILY', type: 'Standard', clients: ['lnx-app01', 'lnx-app02', 'lnx-file01'], weekly: false },
  { name: 'ORACLE-PROD-RMAN', type: 'Oracle', clients: ['ora-prod01', 'ora-prod02'], weekly: false },
  { name: 'NBU-CATALOG-BACKUP', type: 'NBU-Catalog', clients: ['nbu-primary-01'], weekly: false },
  { name: 'ALTA-CLOUD-VMWARE', type: 'VMware', clients: ['alta-vm01', 'alta-vm02', 'alta-vm03', 'alta-vm04'], weekly: false },
];

// Trouble scenarios: this policy fails 100% of its jobs on the two days it
// runs 2-3 days ago; this client has no successful backup in the last 4 days.
const FAILING_POLICY = 'VMWARE-PROD-DAILY';
const FAILING_POLICY_DAYS_AGO = [2, 3];
const STALE_CLIENT = 'win-fs02';
// Day 4 included: a day-4 job stamped later in the day than "now" still falls
// inside the rolling now-4d window the stale-backup rule (and its test) uses.
const STALE_CLIENT_DAYS_AGO = [0, 1, 2, 3, 4];
const FAILURE_CODES = [84, 58, 2074, 1, 13, 6];
const SPECIAL_CODES = [84, 58, 2074];

function nightHour(rng) {
  // Overnight backup window: 20:00-23:59 or 00:00-05:59.
  return chance(rng, 0.6) ? randInt(rng, 20, 23) : randInt(rng, 0, 5);
}

function dayHour(rng) {
  return randInt(rng, 9, 17);
}

function seedNetbackup(db, { now, encrypt }) {
  const nowIso = new Date(now).toISOString();

  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES ('platform_netbackup_enabled', '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run();

  // Upsert on name (netbackup_sources.name is UNIQUE) so re-seeding refreshes
  // the two demo sources in place instead of colliding with a prior seed —
  // see the DEMO POLICY DEVIATION note at the top of this file.
  const insertSource = db.prepare(`
    INSERT INTO netbackup_sources (name, source_type, host, port, auth_mode, username,
      domain_name, domain_type, encrypted_credentials, ssl_verify, polling_interval_minutes,
      last_poll_status, last_poll_error, last_poll_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 15, 'success', NULL, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      source_type = excluded.source_type, host = excluded.host, port = excluded.port,
      auth_mode = excluded.auth_mode, username = excluded.username,
      domain_name = excluded.domain_name, domain_type = excluded.domain_type,
      encrypted_credentials = excluded.encrypted_credentials, ssl_verify = excluded.ssl_verify,
      last_poll_status = excluded.last_poll_status, last_poll_error = excluded.last_poll_error,
      last_poll_at = excluded.last_poll_at, updated_at = excluded.updated_at
  `);
  const insertPolicy = db.prepare(`
    INSERT INTO netbackup_policies (source_id, name, policy_type, active, client_count,
      schedule_count, selection_count, detail_json, captured_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
  `);
  const insertJob = db.prepare(`
    INSERT INTO netbackup_jobs (source_id, job_id, parent_job_id, job_type, state, status_code,
      policy_name, policy_type, client_name, schedule_type, storage_unit, kilobytes,
      files_count, elapsed_seconds, throughput_kbps, started_at, ended_at, captured_at)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertStorageUnit = db.prepare(`
    INSERT INTO netbackup_storage_units (source_id, name, storage_unit_type, disk_pool,
      media_server, max_concurrent_jobs, capacity_bytes, free_bytes, used_bytes, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertDiskPool = db.prepare(`
    INSERT INTO netbackup_disk_pools (source_id, name, server_type, status,
      total_capacity_bytes, used_capacity_bytes, available_capacity_bytes, volume_count, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMediaServer = db.prepare(`
    INSERT INTO netbackup_media_servers (source_id, name, state, version, captured_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertAppliance = db.prepare(`
    INSERT INTO netbackup_appliances (source_id, name, host_type, appliance_type, model,
      serial_number, os_type, os_version, cpu_architecture, nbu_version, raw_json, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAlert = db.prepare(`
    INSERT INTO netbackup_alerts (source_id, alert_id, severity, category, message, occurred_at, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertIssue = db.prepare(`
    INSERT INTO netbackup_issue_history (source_id, issue_key, source, type, target, severity, message, status,
      first_seen, last_seen, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open', datetime('now', ?), datetime('now', ?), NULL)
  `);
  const insertMetrics = db.prepare(`
    INSERT INTO netbackup_metrics_history (source_id, captured_at, jobs_24h, failed_jobs_24h,
      success_rate, active_policies, protected_clients, storage_capacity_bytes,
      storage_used_bytes, media_server_count, appliance_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSlp = db.prepare(`
    INSERT INTO netbackup_slps (source_id, name, version, data_classification, priority,
      operation_count, operations_json, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertWorkloadHistory = db.prepare(`
    INSERT INTO netbackup_workload_history
      (source_id, workload, protected_clients, job_count, success_count, failed_count, protected_bytes, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const GIB = 1024 ** 3;

  // ── Sources ──────────────────────────────────────────────────────────────
  insertSource.run(
    'nbu-primary-01', 'primary', 'nbu-primary-01.icc.demo', 1556, 'password', 'nbu-admin',
    null, null, encrypt(JSON.stringify({ password: 'demo-not-real' })), 0,
    new Date(now - randInt(rngFor('nbu-primary-01'), 2, 14) * 60000).toISOString(), nowIso, nowIso
  );
  const primaryId = db.prepare("SELECT id FROM netbackup_sources WHERE name = 'nbu-primary-01'").get().id;

  insertSource.run(
    'Alta Production', 'alta', 'https://acme.netbackup.alta.veritas.com/netbackup', 1556, 'apikey', null,
    null, null, encrypt(JSON.stringify({ apiKey: 'demo-not-real-key' })), 1,
    new Date(now - randInt(rngFor('Alta Production'), 2, 14) * 60000).toISOString(), nowIso, nowIso
  );
  const altaId = db.prepare("SELECT id FROM netbackup_sources WHERE name = 'Alta Production'").get().id;

  // ── Policies ─────────────────────────────────────────────────────────────
  const PRIMARY_POLICIES = POLICY_DEFS.slice(0, 5);
  const ALTA_POLICIES = POLICY_DEFS.slice(5);
  const policySourceOf = {};
  for (const def of PRIMARY_POLICIES) policySourceOf[def.name] = primaryId;
  for (const def of ALTA_POLICIES) policySourceOf[def.name] = altaId;

  const SCHEDULE_POOL = [
    { scheduleName: 'Full-Weekly', scheduleType: 'Full', frequencySeconds: 604800, retentionLevel: 3 },
    { scheduleName: 'Incr-Daily', scheduleType: 'Differential Incremental', frequencySeconds: 86400, retentionLevel: 1 },
    { scheduleName: 'Cumulative-Monthly', scheduleType: 'Cumulative Incremental', frequencySeconds: 2592000, retentionLevel: 4 },
  ];
  const SELECTIONS_BY_TYPE = {
    VMware: ['vmware:/?filter=Displayname Contains "vm-"', 'vmware:/?filter=Powerstate Equal poweredOn'],
    'MS-Windows': ['ALL_LOCAL_DRIVES', 'C:\\Users', 'D:\\Shares', 'System State:\\'],
    Standard: ['/data', '/home', '/var/www', '/opt/app'],
    Oracle: ['/oracle/rman/backup_full.sh', '/oracle/rman/backup_arch.sh'],
    'NBU-Catalog': ['NBU-Catalog'],
  };
  for (const def of POLICY_DEFS) {
    const schedCount = def.weekly ? 1 : randInt(rngFor(`${def.name}-sched`), 1, 3);
    const selPool = SELECTIONS_BY_TYPE[def.type] || SELECTIONS_BY_TYPE.Standard;
    const selCount = Math.min(selPool.length, randInt(rngFor(`${def.name}-sel`), 1, 4));
    const detail = {
      clients: def.clients.slice(),
      schedules: SCHEDULE_POOL.slice(0, schedCount),
      selections: selPool.slice(0, selCount),
    };
    insertPolicy.run(
      policySourceOf[def.name], def.name, def.type, def.clients.length,
      schedCount, selCount, JSON.stringify(detail), nowIso
    );
  }

  // ── SLPs (Storage Lifecycle Policies): gold/silver per source ───────────
  const SLPS = [
    {
      source: primaryId, name: 'GOLD-VMWARE-PROD', version: 3, classification: 'Gold', priority: 1,
      operations: [
        { type: 'backup', policy: FAILING_POLICY },
        { type: 'replication', target: 'Alta Production' },
        { type: 'expiration', retention: '90 days' },
      ],
    },
    {
      source: primaryId, name: 'SILVER-FILESERVERS', version: 2, classification: 'Silver', priority: 2,
      operations: [
        { type: 'backup' },
        { type: 'expiration', retention: '30 days' },
      ],
    },
    {
      source: altaId, name: 'GOLD-CLOUD-VMWARE', version: 2, classification: 'Gold', priority: 1,
      operations: [
        { type: 'backup' },
        { type: 'replication', target: 'On-Prem DR' },
        { type: 'expiration', retention: '60 days' },
      ],
    },
    {
      source: altaId, name: 'SILVER-CLOUD-STANDARD', version: 1, classification: 'Silver', priority: 3,
      operations: [
        { type: 'backup' },
        { type: 'expiration', retention: '14 days' },
      ],
    },
  ];
  for (const slp of SLPS) {
    insertSlp.run(slp.source, slp.name, slp.version, slp.classification, slp.priority,
      slp.operations.length, JSON.stringify(slp.operations), nowIso);
  }

  // ── Storage units + disk pools ──────────────────────────────────────────
  const suRng = rngFor('netbackup-storage');
  const diskPoolPrimary = {
    name: 'dp-primary-01', server_type: 'PureDisk', status: 'UP',
    total: 200 * 1024 * GIB, used: Math.round(200 * 1024 * GIB * 0.91), volumeCount: 4,
  };
  insertDiskPool.run(primaryId, diskPoolPrimary.name, diskPoolPrimary.server_type, diskPoolPrimary.status,
    diskPoolPrimary.total, diskPoolPrimary.used, diskPoolPrimary.total - diskPoolPrimary.used,
    diskPoolPrimary.volumeCount, nowIso);

  const diskPoolAlta = {
    name: 'dp-alta-cloud-01', server_type: 'CloudCatalyst', status: 'UP',
    total: 500 * 1024 * GIB, used: Math.round(500 * 1024 * GIB * randFloat(suRng, 0.4, 0.55, 2)), volumeCount: 2,
  };
  insertDiskPool.run(altaId, diskPoolAlta.name, diskPoolAlta.server_type, diskPoolAlta.status,
    diskPoolAlta.total, diskPoolAlta.used, diskPoolAlta.total - diskPoolAlta.used,
    diskPoolAlta.volumeCount, nowIso);

  // Pool-type variety so the Storage page can report by type (Doug 2026-07-30):
  // MSDP, OST/DataDomain and S3 archive alongside the two pools above.
  const EXTRA_POOLS = [
    { source: primaryId, name: 'dp-msdp-01', type: 'PureDisk (MSDP)', total: 400, usedFrac: 0.62, vols: 8 },
    { source: primaryId, name: 'dp-ost-dd-01', type: 'OST (DataDomain)', total: 350, usedFrac: 0.48, vols: 2 },
    { source: primaryId, name: 'dp-adv-01', type: 'AdvancedDisk', total: 80, usedFrac: 0.35, vols: 2 },
    { source: altaId, name: 'dp-s3-archive-01', type: 'Cloud (S3 Archive)', total: 1200, usedFrac: 0.27, vols: 1 },
  ];
  for (const p of EXTRA_POOLS) {
    const total = p.total * 1024 * GIB;
    const used = Math.round(total * p.usedFrac);
    insertDiskPool.run(p.source, p.name, p.type, 'UP', total, used, total - used, p.vols, nowIso);
  }

  const STORAGE_UNITS = [
    { source: primaryId, name: 'stu-disk-01', type: 'Disk', diskPool: diskPoolPrimary.name, mediaServer: 'nbu-media-01', maxJobs: 12, capGiB: 100 },
    { source: primaryId, name: 'stu-disk-02', type: 'Disk', diskPool: diskPoolPrimary.name, mediaServer: 'nbu-media-02', maxJobs: 12, capGiB: 100 },
    { source: primaryId, name: 'stu-tape-01', type: 'Tape (STL)', diskPool: null, mediaServer: 'nbu-media-01', maxJobs: 4, capGiB: 300 },
    { source: altaId, name: 'stu-cloud-01', type: 'Cloud (S3)', diskPool: diskPoolAlta.name, mediaServer: null, maxJobs: 20, capGiB: 500 },
    { source: primaryId, name: 'stu-msdp-01', type: 'Disk (MSDP)', diskPool: 'dp-msdp-01', mediaServer: 'nbu-media-01', maxJobs: 16, capGiB: 400 * 1024 },
    { source: primaryId, name: 'stu-ost-dd-01', type: 'Disk (OST)', diskPool: 'dp-ost-dd-01', mediaServer: 'nbu-media-02', maxJobs: 8, capGiB: 350 * 1024 },
    { source: altaId, name: 'stu-s3-archive-01', type: 'Cloud (S3 Archive)', diskPool: 'dp-s3-archive-01', mediaServer: null, maxJobs: 6, capGiB: 1200 * 1024 },
  ];
  for (const su of STORAGE_UNITS) {
    const total = su.capGiB * GIB;
    const usedFrac = su.diskPool === diskPoolPrimary.name ? 0.91 : randFloat(suRng, 0.3, 0.6, 2);
    const used = Math.round(total * usedFrac);
    insertStorageUnit.run(su.source, su.name, su.type, su.diskPool, su.mediaServer,
      su.maxJobs, total, total - used, used, nowIso);
  }

  // ── Media servers (nbu-media-02 stuck DOWN) ─────────────────────────────
  const MEDIA_SERVERS = [
    { source: primaryId, name: 'nbu-media-01', state: 'ACTIVE', version: '11.0' },
    { source: primaryId, name: 'nbu-media-02', state: 'DOWN', version: '11.0' },
    { source: altaId, name: 'nbu-media-alta-01', state: 'ACTIVE', version: '11.0' },
  ];
  for (const ms of MEDIA_SERVERS) {
    insertMediaServer.run(ms.source, ms.name, ms.state, ms.version, nowIso);
  }

  // ── Appliances (2 NB5250, 1 flex, 2 byo) ────────────────────────────────
  const applRng = rngFor('netbackup-appliances');
  const APPLIANCES = [
    { source: primaryId, name: 'nbu-primary-01', hostType: 'PRIMARY_SERVER', applianceType: 'appliance', model: 'NB5250', serial: 'NB5250-A1B2C3', os: 'NetBackup Appliance OS', osVer: '5.1', cpu: 'x86_64', nbuVer: '11.0' },
    { source: primaryId, name: 'nbu-media-01', hostType: 'MEDIA_SERVER', applianceType: 'appliance', model: 'NB5250', serial: 'NB5250-D4E5F6', os: 'NetBackup Appliance OS', osVer: '5.1', cpu: 'x86_64', nbuVer: '11.0' },
    { source: primaryId, name: 'nbu-flex-01', hostType: 'MEDIA_SERVER', applianceType: 'flex', model: 'NetBackup Flex 5350', serial: 'FLEX-G7H8I9', os: 'NetBackup Flex OS', osVer: '2.4', cpu: 'x86_64', nbuVer: '11.0' },
    { source: primaryId, name: 'nbu-media-02', hostType: 'MEDIA_SERVER', applianceType: 'byo', model: null, serial: null, os: 'Red Hat Enterprise Linux', osVer: '9.4', cpu: 'x86_64', nbuVer: '11.0' },
    { source: altaId, name: 'nbu-media-alta-01', hostType: 'MEDIA_SERVER', applianceType: 'byo', model: null, serial: null, os: 'Red Hat Enterprise Linux', osVer: '9.4', cpu: 'x86_64', nbuVer: '11.0' },
  ];
  for (const a of APPLIANCES) {
    insertAppliance.run(a.source, a.name, a.hostType, a.applianceType, a.model, a.serial,
      a.os, a.osVer, a.cpu, a.nbuVer, JSON.stringify({ demo: true, hostName: a.name }), nowIso);
  }
  void applRng;

  // ── Upstream alerts ──────────────────────────────────────────────────────
  const ALERTS = [
    { source: primaryId, id: 'alert-1001', severity: 'critical', category: 'Storage', message: 'Disk pool dp-primary-01 is 91% full', minAgo: 45 },
    { source: primaryId, id: 'alert-1002', severity: 'warning', category: 'MediaServer', message: 'Media server nbu-media-02 is not responding', minAgo: 210 },
    { source: altaId, id: 'alert-2001', severity: 'warning', category: 'Job', message: "Policy VMWARE-PROD-DAILY backups have failed repeatedly", minAgo: 90 },
  ];
  for (const a of ALERTS) {
    insertAlert.run(a.source, a.id, a.severity, a.category, a.message,
      new Date(now - a.minAgo * 60000).toISOString(), nowIso);
  }

  // ── Jobs: ~400 over the last 7 days ─────────────────────────────────────
  let jobId = 500000;
  let jobTotal = 0;
  const jobRng = rngFor('netbackup-jobs');
  const jobStats = {}; // policy_name -> { total, failed }
  const clientLastSuccess = {}; // client -> most recent success timestamp (ms)

  function recordJob(sourceId, policy, clientName, dayAgo, forceFail, isNight) {
    const hour = isNight ? nightHour(jobRng) : dayHour(jobRng);
    const minute = randInt(jobRng, 0, 59);
    const started = new Date(now);
    started.setUTCDate(started.getUTCDate() - dayAgo);
    started.setUTCHours(hour, minute, 0, 0);
    const startedMs = started.getTime();
    if (startedMs > now) return; // avoid future timestamps for "today"

    const elapsed = policy.type === 'VMware' ? randInt(jobRng, 600, 7200) : randInt(jobRng, 90, 3600);
    const endedMs = startedMs + elapsed * 1000;

    let success = forceFail ? false : chance(jobRng, 0.92);
    let state, statusCode;
    if (success) {
      state = 'DONE';
      statusCode = 0;
    } else {
      state = chance(jobRng, 0.3) ? 'FAILED' : 'DONE';
      statusCode = chance(jobRng, 0.4) ? pick(jobRng, SPECIAL_CODES) : pick(jobRng, FAILURE_CODES);
    }

    const kilobytes = policy.type === 'VMware'
      ? randInt(jobRng, 5_000_000, 400_000_000)
      : policy.type === 'Oracle'
        ? randInt(jobRng, 1_000_000, 80_000_000)
        : randInt(jobRng, 100_000, 20_000_000);
    const filesCount = policy.type === 'NBU-Catalog' ? randInt(jobRng, 1, 5) : randInt(jobRng, 10, 50000);
    const throughput = success ? randInt(jobRng, 5000, 250000) : null;
    const storageUnit = pick(jobRng, STORAGE_UNITS.filter((s) => s.source === sourceId)).name;
    const scheduleType = policy.weekly ? 'FULL' : pick(jobRng, ['FULL', 'INCR', 'DIFF_INCR']);

    insertJob.run(
      sourceId, jobId++, 'Backup', state, statusCode, policy.name, policy.type, clientName,
      scheduleType, storageUnit, kilobytes, filesCount, elapsed, throughput,
      new Date(startedMs).toISOString(), new Date(endedMs).toISOString(), nowIso
    );
    jobTotal++;

    if (!jobStats[policy.name]) jobStats[policy.name] = { total: 0, failed: 0 };
    jobStats[policy.name].total++;
    if (!success) jobStats[policy.name].failed++;

    if (success) {
      if (!clientLastSuccess[clientName] || startedMs > clientLastSuccess[clientName]) {
        clientLastSuccess[clientName] = startedMs;
      }
    } else if (!(clientName in clientLastSuccess)) {
      clientLastSuccess[clientName] = null;
    }
  }

  for (let dayAgo = 6; dayAgo >= 0; dayAgo--) {
    for (const def of POLICY_DEFS) {
      const sourceId = policySourceOf[def.name];
      // Weekly policy only runs once, on day 3.
      if (def.weekly && dayAgo !== 3) continue;

      const policyForceFail = def.name === FAILING_POLICY && FAILING_POLICY_DAYS_AGO.includes(dayAgo);

      for (const clientName of def.clients) {
        const clientForceFail = clientName === STALE_CLIENT && STALE_CLIENT_DAYS_AGO.includes(dayAgo);
        const runs = randInt(jobRng, 2, 4);
        for (let r = 0; r < runs; r++) {
          const isNight = r === 0 ? true : chance(jobRng, 0.7);
          recordJob(sourceId, def, clientName, dayAgo, policyForceFail || clientForceFail, isNight);
        }
      }
    }
  }

  // ── Replication jobs: ~60 over 7 days, ~10% failed, feeds the SLP page ──
  const repRng = rngFor('netbackup-replication');
  let repJobId = 900000;
  let repTotal = 0;
  let repFailed = 0;
  const REPLICATION_COUNT = 60;
  for (let i = 0; i < REPLICATION_COUNT; i++) {
    const def = pick(repRng, POLICY_DEFS);
    const sourceId = policySourceOf[def.name];
    const clientName = pick(repRng, def.clients);
    const dayAgo = randInt(repRng, 0, 6);
    const hour = nightHour(repRng);
    const minute = randInt(repRng, 0, 59);
    const started = new Date(now);
    started.setUTCDate(started.getUTCDate() - dayAgo);
    started.setUTCHours(hour, minute, 0, 0);
    let startedMs = started.getTime();
    if (startedMs > now) startedMs = now - randInt(repRng, 60, 3600) * 1000;

    const elapsed = randInt(repRng, 300, 5400);
    const endedMs = startedMs + elapsed * 1000;
    const staleClientForceFail = clientName === STALE_CLIENT && STALE_CLIENT_DAYS_AGO.includes(dayAgo);
    const success = staleClientForceFail ? false : chance(repRng, 0.9);
    const state = success ? 'DONE' : (chance(repRng, 0.3) ? 'FAILED' : 'DONE');
    const statusCode = success ? 0 : (chance(repRng, 0.4) ? pick(repRng, SPECIAL_CODES) : pick(repRng, FAILURE_CODES));
    const kilobytes = def.type === 'VMware'
      ? randInt(repRng, 5_000_000, 400_000_000)
      : def.type === 'Oracle'
        ? randInt(repRng, 1_000_000, 80_000_000)
        : randInt(repRng, 100_000, 20_000_000);
    const filesCount = randInt(repRng, 10, 50000);
    const throughput = success ? randInt(repRng, 5000, 250000) : null;
    const storageUnit = pick(repRng, STORAGE_UNITS.filter((s) => s.source === sourceId)).name;

    insertJob.run(
      sourceId, repJobId++, 'REPLICATION', state, statusCode, def.name, def.type, clientName,
      'FULL', storageUnit, kilobytes, filesCount, elapsed, throughput,
      new Date(startedMs).toISOString(), new Date(endedMs).toISOString(), nowIso
    );
    repTotal++;
    if (!success) repFailed++;
  }

  // ── Issue history: seeded directly (mirrors netbackupIssues.js key scheme)
  // so it stays consistent once the computed-issues service reconciles it.
  const failingStats = jobStats[FAILING_POLICY] || { total: 0, failed: 0 };
  const histRng = rngFor('netbackup-issue-history');
  const issues = [
    {
      sourceId: primaryId,
      key: `job-failures:${primaryId}:${FAILING_POLICY}`,
      severity: 'critical',
      message: `Policy ${FAILING_POLICY} has ${failingStats.failed} failed job(s) of ${failingStats.total} in the last 24h`,
      openedMinAgo: 2 * 24 * 60 + randInt(histRng, 10, 200),
    },
    {
      sourceId: primaryId,
      key: `storage-low:${primaryId}:${diskPoolPrimary.name}`,
      severity: 'critical',
      message: `Disk pool ${diskPoolPrimary.name} has 9.0% free space`,
      openedMinAgo: randInt(histRng, 6 * 60, 3 * 24 * 60),
    },
    {
      sourceId: primaryId,
      key: `media-server-down:${primaryId}:nbu-media-02`,
      severity: 'warning',
      message: 'Media server nbu-media-02 is DOWN',
      openedMinAgo: randInt(histRng, 3 * 60, 4 * 24 * 60),
    },
    {
      sourceId: primaryId,
      key: `stale-backup:${primaryId}:${STALE_CLIENT}`,
      severity: 'warning',
      message: `Client ${STALE_CLIENT} has no successful backup in over 48 hours`,
      openedMinAgo: 4 * 24 * 60 - randInt(histRng, 10, 60),
    },
  ];
  for (const a of ALERTS) {
    issues.push({
      sourceId: a.source,
      key: `upstream-alert:${a.source}:${a.id}`,
      severity: a.severity === 'critical' ? 'critical' : 'warning',
      message: a.message,
      openedMinAgo: a.minAgo,
    });
  }
  const sourceNameOf = db.prepare('SELECT name FROM netbackup_sources WHERE id = ?');
  for (const issue of issues) {
    const segments = issue.key.split(':');
    insertIssue.run(issue.sourceId, issue.key,
      sourceNameOf.get(issue.sourceId)?.name ?? 'estate',
      segments[0], segments[segments.length - 1],
      issue.severity, issue.message,
      `-${issue.openedMinAgo} minutes`, '-4 minutes');
  }

  // ── 30 days of per-source metrics history ───────────────────────────────
  const jobsBySource = { [primaryId]: [], [altaId]: [] };
  for (const row of db.prepare('SELECT source_id, state, status_code, started_at FROM netbackup_jobs').all()) {
    jobsBySource[row.source_id].push(row);
  }
  const activePolicyCount = { [primaryId]: PRIMARY_POLICIES.length, [altaId]: ALTA_POLICIES.length };
  const protectedClients = {
    [primaryId]: new Set(PRIMARY_POLICIES.flatMap((d) => d.clients)).size,
    [altaId]: new Set(ALTA_POLICIES.flatMap((d) => d.clients)).size,
  };
  const storageTotals = {
    [primaryId]: STORAGE_UNITS.filter((s) => s.source === primaryId).reduce((acc, s) => acc + s.capGiB * GIB, 0),
    [altaId]: STORAGE_UNITS.filter((s) => s.source === altaId).reduce((acc, s) => acc + s.capGiB * GIB, 0),
  };
  const mediaServerCounts = {
    [primaryId]: MEDIA_SERVERS.filter((m) => m.source === primaryId).length,
    [altaId]: MEDIA_SERVERS.filter((m) => m.source === altaId).length,
  };
  const applianceCounts = {
    [primaryId]: APPLIANCES.filter((a) => a.source === primaryId).length,
    [altaId]: APPLIANCES.filter((a) => a.source === altaId).length,
  };

  const metricsRng = rngFor('netbackup-metrics-history');
  let metricsRows = 0;
  for (const sourceId of [primaryId, altaId]) {
    for (let i = 30; i >= 0; i--) {
      const dayMs = now - i * 86400000;
      const windowStart = dayMs - 86400000;
      const jobsInWindow = i <= 6
        ? jobsBySource[sourceId].filter((j) => {
            const t = new Date(j.started_at).getTime();
            return t > windowStart && t <= dayMs;
          })
        : null;
      let jobs24h, failed24h, successRate;
      if (jobsInWindow && jobsInWindow.length) {
        jobs24h = jobsInWindow.length;
        failed24h = jobsInWindow.filter((j) => j.status_code !== 0).length;
        successRate = Math.round(((jobs24h - failed24h) / jobs24h) * 1000) / 10;
      } else {
        jobs24h = randInt(metricsRng, 10, 40);
        failed24h = randInt(metricsRng, 0, 2);
        successRate = Math.round(((jobs24h - failed24h) / jobs24h) * 1000) / 10;
      }
      const used = Math.round(storageTotals[sourceId] * randFloat(metricsRng, 0.45, 0.7, 2));
      insertMetrics.run(sourceId, new Date(dayMs).toISOString(), jobs24h, failed24h, successRate,
        activePolicyCount[sourceId], protectedClients[sourceId], storageTotals[sourceId], used,
        mediaServerCounts[sourceId], applianceCounts[sourceId]);
      metricsRows++;
    }
  }

  // ── 60 days of daily per-source/workload snapshots ──────────────────────
  // One batch per source per day (all workload rows for a source on a given
  // day share the same captured_at), with a dip for the failing policy's
  // workload (VMware @ primary) matching FAILING_POLICY_DAYS_AGO.
  const TB = 1024 ** 4;
  const WORKLOAD_HISTORY_DAYS = 59;
  const workloadDefsBySource = { [primaryId]: PRIMARY_POLICIES, [altaId]: ALTA_POLICIES };
  let workloadHistoryRows = 0;
  for (const sourceId of [primaryId, altaId]) {
    const defs = workloadDefsBySource[sourceId];
    const workloads = [...new Set(defs.map((d) => d.type))];
    const whRng = rngFor(`netbackup-workload-history-${sourceId}`);
    const baseByWorkload = workloads.map((workload) => ({
      workload,
      clients: new Set(defs.filter((d) => d.type === workload).flatMap((d) => d.clients)).size,
      protectedTb: workload === 'VMware' ? randFloat(whRng, 8, 40, 2) : randFloat(whRng, 1, 12, 2),
      growth: randFloat(whRng, 0.04, 0.16, 3),
    }));
    for (let d = WORKLOAD_HISTORY_DAYS; d >= 0; d--) {
      const capturedAt = new Date(now - d * 86400000).toISOString();
      const progress = (WORKLOAD_HISTORY_DAYS - d) / WORKLOAD_HISTORY_DAYS;
      for (const base of baseByWorkload) {
        const dip = sourceId === primaryId && base.workload === 'VMware' && FAILING_POLICY_DAYS_AGO.includes(d);
        let scale = 1 - base.growth + base.growth * progress;
        if (dip) scale *= 0.7;
        const protectedBytes = Math.round(base.protectedTb * TB * scale);
        const runsPerClient = randInt(whRng, 2, 4);
        const jobCount = base.clients * runsPerClient;
        const failRate = dip ? 0.45 : 0.05;
        const failedCount = Math.round(jobCount * failRate);
        const successCount = jobCount - failedCount;
        insertWorkloadHistory.run(sourceId, base.workload, base.clients, jobCount,
          successCount, failedCount, protectedBytes, capturedAt);
        workloadHistoryRows++;
      }
    }
  }

  // ── Entitlement: size netbackup_entitled_tb so computed FETB lands ~70% ──
  const fetbRows = db.prepare(`
    SELECT client_name, MAX(kilobytes) AS kb FROM netbackup_jobs
    WHERE status_code = 0 AND job_type = 'Backup' AND started_at >= datetime('now', '-30 days')
    GROUP BY client_name
  `).all();
  const feBytes = fetbRows.reduce((acc, r) => acc + (r.kb || 0) * 1024, 0);
  const feTb = feBytes / TB;
  const rawTarget = feTb / 0.7;
  const roundTo = rawTarget < 20 ? 1 : rawTarget < 200 ? 10 : 50;
  let entitledTb = Math.round(rawTarget / roundTo) * roundTo;
  if (entitledTb < 1) entitledTb = 1;
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES ('netbackup_entitled_tb', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(String(entitledTb));

  // ── Appliance connections + hardware (52xx/53xx hardware monitoring) ────
  // Upsert on name (netbackup_appliance_conns.name is UNIQUE) — same reseed
  // policy as netbackup_sources above.
  const insertApplianceConn = db.prepare(`
    INSERT INTO netbackup_appliance_conns (name, host, port, username, encrypted_credentials,
      ssl_verify, polling_interval_minutes, last_poll_status, last_poll_error, last_poll_at, created_at, updated_at)
    VALUES (?, ?, 443, 'admin', ?, 0, 30, 'success', NULL, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      host = excluded.host, encrypted_credentials = excluded.encrypted_credentials,
      last_poll_status = excluded.last_poll_status, last_poll_error = excluded.last_poll_error,
      last_poll_at = excluded.last_poll_at, updated_at = excluded.updated_at
  `);
  const insertApplianceHw = db.prepare(`
    INSERT INTO netbackup_appliance_hw (conn_id, component_type, component_name, status, state_raw, detail_json, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const applHwRng = rngFor('netbackup-appliance-hw');
  insertApplianceConn.run(
    'nbu-appl-5250-01', 'nbu-appl-5250-01.icc.demo',
    encrypt(JSON.stringify({ password: 'demo-not-real' })),
    new Date(now - randInt(applHwRng, 2, 14) * 60000).toISOString(), nowIso, nowIso
  );
  const applConn1Id = db.prepare("SELECT id FROM netbackup_appliance_conns WHERE name = 'nbu-appl-5250-01'").get().id;
  insertApplianceConn.run(
    'nbu-appl-5250-02', 'nbu-appl-5250-02.icc.demo',
    encrypt(JSON.stringify({ password: 'demo-not-real' })),
    new Date(now - randInt(applHwRng, 2, 14) * 60000).toISOString(), nowIso, nowIso
  );
  const applConn2Id = db.prepare("SELECT id FROM netbackup_appliance_conns WHERE name = 'nbu-appl-5250-02'").get().id;

  const FAILED_DISK_SLOT = 3; // disk #4 on -01 fails
  const WARN_PSU_SLOT = 2; // PSU #2 on -02 degrades

  function seedApplianceComponents(connId, isApplOne) {
    let hwCount = 0;
    for (let i = 1; i <= 12; i++) {
      const failed = isApplOne && i === FAILED_DISK_SLOT + 1;
      const status = failed ? 'critical' : 'ok';
      const stateRaw = failed ? 'Failed' : 'OK';
      insertApplianceHw.run(connId, 'disk', `Disk Slot ${i}`, status, stateRaw,
        JSON.stringify({ slot: i, sizeGb: 4000, model: 'NBU-HDD-4TB' }), nowIso);
      hwCount++;
    }
    const raidDegraded = isApplOne;
    insertApplianceHw.run(connId, 'raid', 'VolumeGroup 1', raidDegraded ? 'warning' : 'ok',
      raidDegraded ? 'Degraded' : 'Optimal', JSON.stringify({ raidLevel: 'RAID6' }), nowIso);
    hwCount++;
    for (let i = 1; i <= 4; i++) {
      insertApplianceHw.run(connId, 'fan', `Fan ${i}`, 'ok', 'Normal', JSON.stringify({ rpm: 4200 + i * 50 }), nowIso);
      hwCount++;
    }
    for (let i = 1; i <= 2; i++) {
      const warn = !isApplOne && i === WARN_PSU_SLOT;
      insertApplianceHw.run(connId, 'psu', `PSU ${i}`, warn ? 'warning' : 'ok', warn ? 'Predictive' : 'OK',
        JSON.stringify({ wattage: 1100 }), nowIso);
      hwCount++;
    }
    for (let i = 1; i <= 6; i++) {
      insertApplianceHw.run(connId, 'temperature', `Temp Sensor ${i}`, 'ok', 'Normal', JSON.stringify({ celsius: 32 + i }), nowIso);
      hwCount++;
    }
    for (let i = 1; i <= 4; i++) {
      insertApplianceHw.run(connId, 'network', `eth${i}`, 'ok', 'Online', JSON.stringify({ linkSpeedMbps: 10000 }), nowIso);
      hwCount++;
    }
    for (let i = 1; i <= 8; i++) {
      insertApplianceHw.run(connId, 'memory', `DIMM ${i}`, 'ok', 'OK', JSON.stringify({ sizeGb: 32 }), nowIso);
      hwCount++;
    }
    for (let i = 1; i <= 2; i++) {
      insertApplianceHw.run(connId, 'cpu', `CPU ${i}`, 'ok', 'OK', JSON.stringify({ cores: 16 }), nowIso);
      hwCount++;
    }
    return hwCount;
  }

  const applHw1Count = seedApplianceComponents(applConn1Id, true);
  const applHw2Count = seedApplianceComponents(applConn2Id, false);

  const applianceIssueRng = rngFor('netbackup-appliance-issue-history');
  const applianceIssues = [
    {
      connId: applConn1Id, connName: 'nbu-appl-5250-01', type: 'disk',
      name: `Disk Slot ${FAILED_DISK_SLOT + 1}`, severity: 'critical', stateRaw: 'Failed',
      openedMinAgo: randInt(applianceIssueRng, 6 * 60, 3 * 24 * 60),
    },
    {
      connId: applConn1Id, connName: 'nbu-appl-5250-01', type: 'raid',
      name: 'VolumeGroup 1', severity: 'warning', stateRaw: 'Degraded',
      openedMinAgo: randInt(applianceIssueRng, 6 * 60, 3 * 24 * 60),
    },
    {
      connId: applConn2Id, connName: 'nbu-appl-5250-02', type: 'psu',
      name: `PSU ${WARN_PSU_SLOT}`, severity: 'warning', stateRaw: 'Predictive',
      openedMinAgo: randInt(applianceIssueRng, 6 * 60, 3 * 24 * 60),
    },
  ];
  for (const ai of applianceIssues) {
    const status = ai.severity;
    insertIssue.run(
      null, `appliance-hw:${ai.connId}:${ai.type}:${ai.name}`, ai.connName, 'appliance-hw', `${ai.type} ${ai.name}`,
      ai.severity, `${ai.connName} ${ai.type} ${ai.name} is ${status} (${ai.stateRaw})`,
      `-${ai.openedMinAgo} minutes`, '-4 minutes'
    );
  }

  return {
    sources: 2,
    policies: POLICY_DEFS.length,
    jobs: jobTotal + repTotal,
    replicationJobs: repTotal,
    replicationFailed: repFailed,
    storageUnits: STORAGE_UNITS.length,
    diskPools: 2,
    mediaServers: MEDIA_SERVERS.length,
    appliances: APPLIANCES.length,
    alerts: ALERTS.length,
    issueHistory: issues.length,
    metricsHistory: metricsRows,
    slps: SLPS.length,
    workloadHistory: workloadHistoryRows,
    entitledTb,
    frontEndTb: Math.round(feTb * 100) / 100,
    applianceConns: 2,
    applianceHwComponents: applHw1Count + applHw2Count,
    applianceIssues: applianceIssues.length,
  };
}

// Demo-only entry point. Wipes the seeded netbackup_* estate (children before
// parents, FK order) EXCLUDING netbackup_sources/netbackup_appliance_conns
// (see the DEMO POLICY DEVIATION note at the top of this file) and
// regenerates it with fresh relative timestamps, so a demo box refreshes on
// every boot instead of aging into a stale-looking estate. NEVER runs outside
// demo mode — see the DASHBOARD_DEMO gate in poller.js.
const DEMO_TABLES = [
  'netbackup_jobs', 'netbackup_policies', 'netbackup_storage_units', 'netbackup_disk_pools',
  'netbackup_media_servers', 'netbackup_appliances', 'netbackup_alerts', 'netbackup_issue_history',
  'netbackup_metrics_history', 'netbackup_slps', 'netbackup_workload_history',
  'netbackup_appliance_overrides', 'netbackup_appliance_hw',
];

function seedNetbackupDemo(coreApi) {
  const db = coreApi.db;
  return db.transaction(() => {
    for (const table of DEMO_TABLES) {
      const exists = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
      ).get(table);
      if (exists) db.exec(`DELETE FROM ${table}`);
    }
    return seedNetbackup(db, { now: Date.now(), encrypt: coreApi.encryption.encrypt });
  })();
}

module.exports = { seedNetbackup, seedNetbackupDemo };
