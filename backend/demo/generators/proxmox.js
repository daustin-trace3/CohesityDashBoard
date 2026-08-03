// Proxmox VE scope demo data: 2 servers ("pve-lab-01" single node,
// "pve-cluster-hq" 3-node cluster), ~28 mixed qemu/lxc guests (2 templates),
// 6 storage entries, 2 backup jobs per server, 14 days of tasks, and hourly
// per-node metrics. Includes deliberate trouble so the Overview issues panel
// demos every proxmoxIssues.js rule: an offline node, a storage at 97% and
// one at 88%, a failed vzdump, a stale-backup guest, a failed migration task,
// a node cert expiring in 12 days, a lost-quorum cluster, and a
// token-permissions warning on pve-lab-01.
const { randInt, randFloat, pick, chance, rngFor } = require('./core');

const GIB = 1024 ** 3;

function seedProxmox(db, { now, encrypt }) {
  const agoStmt = db.prepare("SELECT datetime('now', ?) d");
  const ago = (offset) => agoStmt.get(offset).d;

  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES ('platform_proxmox_enabled', '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run();

  const insertServer = db.prepare(`
    INSERT INTO proxmox_servers (name, host, port, token_id, encrypted_credentials, ssl_verify,
      polling_interval_minutes, quorate, forbidden_endpoints, last_poll_status, last_poll_error, last_poll_at, created_at, updated_at)
    VALUES (?, ?, 8006, ?, ?, 0, 10, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `);
  const insertNode = db.prepare(`
    INSERT INTO proxmox_nodes (server_id, name, status, cpu_usage, cpu_total, mem_used, mem_total,
      disk_used, disk_total, uptime_seconds, load_avg, pve_version, kernel_version,
      cert_expires_at, subscription_status, updates_available, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const insertGuest = db.prepare(`
    INSERT INTO proxmox_guests (server_id, vmid, name, type, node, status, is_template, cpu_count,
      cpu_usage, mem_used, mem_total, disk_used, disk_total, uptime_seconds, net_in, net_out,
      pool, tags, last_backup_at, last_backup_status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const insertStorage = db.prepare(`
    INSERT INTO proxmox_storage (server_id, node, storage, type, content, active, shared,
      used_bytes, total_bytes, avail_bytes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const insertJob = db.prepare(`
    INSERT INTO proxmox_backup_jobs (server_id, job_id, enabled, schedule, storage, mode, compress,
      selection, next_run, updated_at)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const insertTask = db.prepare(`
    INSERT INTO proxmox_tasks (server_id, upid, node, type, target, user, status, started_at, ended_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'root@pam', ?, ?, ?, datetime('now'))
  `);
  const insertMetric = db.prepare(`
    INSERT INTO proxmox_metrics (server_id, node, captured_at, cpu_usage, mem_used, mem_total, storage_used, storage_total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertIssue = db.prepare(`
    INSERT INTO proxmox_issue_history (issue_key, source, source_id, severity, type, target, message, status, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
  `);

  let taskCounter = 0;
  const nextUpid = (node, type, vmidOrTarget) => {
    taskCounter++;
    return `UPID:${node}:${String(taskCounter).padStart(8, '0')}:00000000:${type}:${vmidOrTarget}:root@pam:`;
  };

  // ── pve-lab-01: single node ─────────────────────────────────────────────
  insertServer.run('pve-lab-01', 'pve-lab-01.icc.demo', 'demo@pve!icc-token',
    encrypt(JSON.stringify({ tokenSecret: 'demo-not-real' })),
    null, JSON.stringify(['nodes/status', 'cluster/resources', 'cluster/backup']),
    'success', null, ago('-6 minutes'));
  const labId = db.prepare("SELECT id FROM proxmox_servers WHERE name = 'pve-lab-01'").get().id;

  insertNode.run(labId, 'pve-lab-01', 'online', 0.18, 16, 24 * GIB, 64 * GIB, 420 * GIB, 900 * GIB,
    randInt(rngFor('pve-lab-01-uptime'), 20, 200) * 86400, '0.42, 0.51, 0.48', '9.1.4', '6.8.12-4-pve',
    ago('+12 days'), 'notfound', 3);

  insertStorage.run(labId, 'pve-lab-01', 'local', 'dir', 'iso,vztmpl,backup', 1, 0,
    Math.round(0.45 * 200 * GIB), 200 * GIB, Math.round(0.55 * 200 * GIB));
  insertStorage.run(labId, 'pve-lab-01', 'local-lvm', 'lvmthin', 'images,rootdir', 1, 0,
    Math.round(0.97 * 700 * GIB), 700 * GIB, Math.round(0.03 * 700 * GIB));

  insertJob.run(labId, 'lab-daily-all', '02:00', 'local', 'snapshot', 'zstd', 'all', ago('+18 hours'));
  insertJob.run(labId, 'lab-weekly-db', 'sat 03:00', 'local', 'stop', 'zstd', '103', ago('+4 days'));

  const LAB_GUESTS = [
    { vmid: 100, name: 'lab-web-01', type: 'qemu', status: 'running', backup: 'healthy' },
    { vmid: 101, name: 'lab-web-02', type: 'qemu', status: 'running', backup: 'healthy' },
    { vmid: 102, name: 'lab-app-01', type: 'qemu', status: 'running', backup: 'healthy' },
    { vmid: 103, name: 'lab-db-01', type: 'qemu', status: 'running', backup: 'failed-recent' },
    { vmid: 104, name: 'lab-mon-01', type: 'lxc', status: 'running', backup: 'healthy' },
    { vmid: 105, name: 'lab-dns-01', type: 'lxc', status: 'running', backup: 'healthy' },
    { vmid: 106, name: 'lab-file-01', type: 'lxc', status: 'stopped', backup: 'healthy' },
    { vmid: 107, name: 'ubuntu-2204-tpl', type: 'qemu', status: 'stopped', backup: 'none', template: true },
  ];

  let guestTotal = 0, taskTotal = 0, metricTotal = 0;
  const seedGuestSet = (serverId, serverName, nodeName, guests, rngSeed) => {
    const rng = rngFor(rngSeed);
    for (const g of guests) {
      const isTemplate = !!g.template;
      const running = g.status === 'running';
      const memTotal = pick(rng, [2, 4, 8, 16]) * GIB;
      const diskTotal = pick(rng, [20, 40, 80]) * GIB;
      let lastBackupAt = null, lastBackupStatus = null;
      if (g.backup === 'healthy') { lastBackupAt = ago(`-${randInt(rng, 3, 20)} hours`); lastBackupStatus = 'OK'; }
      else if (g.backup === 'failed-recent') { lastBackupAt = ago('-8 hours'); lastBackupStatus = 'OK'; }
      else if (g.backup === 'stale') { lastBackupAt = ago('-120 hours'); lastBackupStatus = 'OK'; }

      insertGuest.run(serverId, g.vmid, g.name, g.type, nodeName, isTemplate ? 'stopped' : g.status,
        isTemplate ? 1 : 0, isTemplate ? null : pick(rng, [1, 2, 4]),
        isTemplate ? null : (running ? randFloat(rng, 0.02, 0.55, 3) : 0),
        isTemplate ? null : (running ? Math.round(memTotal * randFloat(rng, 0.3, 0.75, 2)) : 0),
        isTemplate ? null : memTotal,
        Math.round(diskTotal * randFloat(rng, 0.25, 0.6, 2)), diskTotal,
        isTemplate ? null : (running ? randInt(rng, 3600, 30 * 86400) : null),
        isTemplate ? null : (running ? randInt(rng, 1e6, 5e9) : 0),
        isTemplate ? null : (running ? randInt(rng, 1e6, 5e9) : 0),
        null, JSON.stringify(isTemplate ? ['template'] : [g.type === 'qemu' ? 'vm' : 'container']),
        lastBackupAt, lastBackupStatus);
      guestTotal++;

      if (isTemplate) continue;

      // Rolling vzdump history: a healthy run most days, plus deliberate trouble.
      for (let d = 3; d >= 0; d--) {
        if (g.backup === 'stale' && d <= 4) continue; // no attempts inside the stale window
        const startOffset = d * 24 + randInt(rng, 2, 5);
        const okUpid = nextUpid(nodeName, 'vzdump', g.vmid);
        insertTask.run(serverId, okUpid, nodeName, 'vzdump', String(g.vmid), 'OK',
          ago(`-${startOffset} hours`), ago(`-${startOffset - 1} hours`));
        taskTotal++;
      }
      if (g.backup === 'stale') {
        const staleUpid = nextUpid(nodeName, 'vzdump', g.vmid);
        insertTask.run(serverId, staleUpid, nodeName, 'vzdump', String(g.vmid), 'OK', ago('-121 hours'), ago('-120 hours'));
        taskTotal++;
      }
      if (g.backup === 'failed-recent') {
        const failUpid = nextUpid(nodeName, 'vzdump', g.vmid);
        insertTask.run(serverId, failUpid, nodeName, 'vzdump', String(g.vmid), 'job errors\nvzdump backup job failed - unable to write to storage',
          ago('-49 hours'), ago('-48 hours'));
        taskTotal++;
      }
      // Lifecycle noise: a few start/stop tasks across the last 14 days.
      for (let i = 0; i < 3; i++) {
        const day = randInt(rng, 1, 13);
        const type = pick(rng, ['qmstart', 'qmstop', 'qmreboot']);
        insertTask.run(serverId, nextUpid(nodeName, type, g.vmid), nodeName, type, String(g.vmid), 'OK',
          ago(`-${day * 24 + randInt(rng, 1, 23)} hours`), ago(`-${day * 24 + randInt(rng, 1, 23) - 1} hours`));
        taskTotal++;
      }
    }
  };

  seedGuestSet(labId, 'pve-lab-01', 'pve-lab-01', LAB_GUESTS, 'pve-lab-01-guests');

  // 48h of hourly metrics for the lab node.
  const labRng = rngFor('pve-lab-01-metrics');
  for (let h = 48; h >= 0; h--) {
    insertMetric.run(labId, 'pve-lab-01', ago(`-${h} hours`),
      randFloat(labRng, 0.1, 0.35, 3), Math.round(64 * GIB * randFloat(labRng, 0.3, 0.45, 2)), 64 * GIB,
      Math.round(900 * GIB * randFloat(labRng, 0.55, 0.62, 2)), 900 * GIB);
    metricTotal++;
  }

  // ── pve-cluster-hq: 3-node cluster ──────────────────────────────────────
  insertServer.run('pve-cluster-hq', 'pve-hq-01.icc.demo', 'demo@pve!icc-token',
    encrypt(JSON.stringify({ tokenSecret: 'demo-not-real' })),
    0, null,
    'success', null, ago('-4 minutes'));
  const hqId = db.prepare("SELECT id FROM proxmox_servers WHERE name = 'pve-cluster-hq'").get().id;

  insertNode.run(hqId, 'pve-hq-01', 'online', 0.32, 32, 96 * GIB, 256 * GIB, 1200 * GIB, 3000 * GIB,
    randInt(rngFor('hq-01-uptime'), 20, 200) * 86400, '1.10, 1.22, 1.05', '9.1.4', '6.8.12-4-pve',
    ago('+280 days'), 'notfound', 5);
  insertNode.run(hqId, 'pve-hq-02', 'online', 0.29, 32, 88 * GIB, 256 * GIB, 1100 * GIB, 3000 * GIB,
    randInt(rngFor('hq-02-uptime'), 20, 200) * 86400, '0.95, 1.02, 0.99', '9.1.4', '6.8.12-4-pve',
    ago('+300 days'), 'notfound', 4);
  insertNode.run(hqId, 'pve-hq-03', 'offline', null, 32, null, 256 * GIB, null, 3000 * GIB,
    null, null, '9.1.4', '6.8.12-4-pve', ago('+310 days'), 'notfound', null);

  insertStorage.run(hqId, 'pve-hq-01', 'local', 'dir', 'iso,vztmpl,backup', 1, 0,
    Math.round(0.5 * 300 * GIB), 300 * GIB, Math.round(0.5 * 300 * GIB));
  insertStorage.run(hqId, 'pve-hq-01', 'local-lvm', 'lvmthin', 'images,rootdir', 1, 0,
    Math.round(0.88 * 1500 * GIB), 1500 * GIB, Math.round(0.12 * 1500 * GIB));
  insertStorage.run(hqId, 'pve-hq-02', 'local', 'dir', 'iso,vztmpl,backup', 1, 0,
    Math.round(0.4 * 300 * GIB), 300 * GIB, Math.round(0.6 * 300 * GIB));
  insertStorage.run(hqId, 'pve-hq-02', 'local-lvm', 'lvmthin', 'images,rootdir', 1, 0,
    Math.round(0.6 * 1500 * GIB), 1500 * GIB, Math.round(0.4 * 1500 * GIB));

  insertJob.run(hqId, 'hq-daily-all', '01:00', 'local', 'snapshot', 'zstd', 'all', ago('+16 hours'));
  insertJob.run(hqId, 'hq-critical-4h', '*/4:00', 'local', 'snapshot', 'lzo', '200,204,210', ago('+2 hours'));

  const HQ01_GUESTS = [
    { vmid: 200, name: 'hq-web-01', type: 'qemu', status: 'running', backup: 'healthy' },
    { vmid: 201, name: 'hq-web-02', type: 'qemu', status: 'running', backup: 'healthy' },
    { vmid: 202, name: 'hq-app-01', type: 'qemu', status: 'running', backup: 'healthy' },
    { vmid: 203, name: 'hq-app-02', type: 'qemu', status: 'running', backup: 'healthy' },
    { vmid: 204, name: 'hq-db-01', type: 'qemu', status: 'running', backup: 'healthy' },
    { vmid: 205, name: 'hq-cache-01', type: 'lxc', status: 'running', backup: 'healthy' },
    { vmid: 206, name: 'hq-lb-01', type: 'lxc', status: 'running', backup: 'healthy' },
    { vmid: 207, name: 'debian-12-tpl', type: 'lxc', status: 'stopped', backup: 'none', template: true },
  ];
  const HQ02_GUESTS = [
    { vmid: 210, name: 'hq-web-03', type: 'qemu', status: 'running', backup: 'healthy' },
    { vmid: 211, name: 'hq-app-03', type: 'qemu', status: 'running', backup: 'healthy' },
    { vmid: 212, name: 'hq-app-04', type: 'qemu', status: 'running', backup: 'healthy' },
    { vmid: 213, name: 'hq-app-05', type: 'qemu', status: 'running', backup: 'stale' },
    { vmid: 214, name: 'hq-mon-01', type: 'lxc', status: 'running', backup: 'healthy' },
    { vmid: 215, name: 'hq-dns-01', type: 'lxc', status: 'running', backup: 'healthy' },
    { vmid: 216, name: 'hq-file-01', type: 'lxc', status: 'running', backup: 'healthy' },
    { vmid: 217, name: 'hq-ci-01', type: 'qemu', status: 'running', backup: 'healthy' },
  ];
  const HQ03_GUESTS = [
    { vmid: 220, name: 'hq-batch-01', type: 'qemu', status: 'stopped', backup: 'healthy' },
    { vmid: 221, name: 'hq-batch-02', type: 'qemu', status: 'stopped', backup: 'healthy' },
    { vmid: 222, name: 'hq-jump-01', type: 'lxc', status: 'stopped', backup: 'healthy' },
    { vmid: 223, name: 'hq-log-01', type: 'lxc', status: 'stopped', backup: 'healthy' },
  ];

  seedGuestSet(hqId, 'pve-cluster-hq', 'pve-hq-01', HQ01_GUESTS, 'hq-01-guests');
  seedGuestSet(hqId, 'pve-cluster-hq', 'pve-hq-02', HQ02_GUESTS, 'hq-02-guests');
  seedGuestSet(hqId, 'pve-cluster-hq', 'pve-hq-03', HQ03_GUESTS, 'hq-03-guests');

  // Deliberate failed migration task (last 24h) — task-failed rule.
  insertTask.run(hqId, nextUpid('pve-hq-02', 'qmigrate', 211), 'pve-hq-02', 'qmigrate', '211',
    'migration aborted: TASK ERROR: too many concurrent migrations, please try again', ago('-3 hours'), ago('-2 hours'));
  taskTotal++;

  // Hourly metrics for the two online cluster nodes (48h); the offline node
  // stopped reporting ~6h ago.
  for (const node of ['pve-hq-01', 'pve-hq-02']) {
    const rng = rngFor(`${node}-metrics`);
    for (let h = 48; h >= 0; h--) {
      insertMetric.run(hqId, node, ago(`-${h} hours`),
        randFloat(rng, 0.25, 0.5, 3), Math.round(256 * GIB * randFloat(rng, 0.3, 0.4, 2)), 256 * GIB,
        Math.round(1500 * GIB * randFloat(rng, 0.55, 0.7, 2)), 1500 * GIB);
      metricTotal++;
    }
  }
  const hq03Rng = rngFor('pve-hq-03-metrics');
  for (let h = 48; h >= 6; h--) {
    insertMetric.run(hqId, 'pve-hq-03', ago(`-${h} hours`),
      randFloat(hq03Rng, 0.2, 0.4, 3), Math.round(256 * GIB * randFloat(hq03Rng, 0.3, 0.4, 2)), 256 * GIB,
      Math.round(1500 * GIB * randFloat(hq03Rng, 0.5, 0.6, 2)), 1500 * GIB);
    metricTotal++;
  }

  // ── Computed issue reconcile (proxmoxIssues.js, owned by WP1) ───────────
  // NOTE (WP5 deviation): wrapped in try/catch because services/proxmoxIssues.js
  // does not exist yet at the time this generator was written (WP1's file
  // lands in parallel). Once it lands this becomes a plain require+call like
  // vcenter's, and the try/catch can be removed.
  let reconcileProxmoxIssues = null;
  try {
    ({ reconcileIssueHistory: reconcileProxmoxIssues } = require('../../services/proxmoxIssues'));
  } catch (err) {
    console.error(`[seedDemo] proxmoxIssues module unavailable, skipping computed-issue reconcile: ${err.message}`);
  }
  if (reconcileProxmoxIssues) {
    reconcileProxmoxIssues();
  } else {
    // proxmoxIssues.js isn't landed yet — hand-seed quorum-lost/token-permissions
    // (driven by proxmox_servers.quorate=0 and forbidden_endpoints above) so the
    // demo still shows every rule until the real reconcile is available.
    insertIssue.run('quorum-lost|pve-cluster-hq|pve-cluster-hq', 'pve-cluster-hq', hqId, 'critical',
      'quorum-lost', 'pve-cluster-hq', 'Cluster pve-cluster-hq has lost quorum (1 of 3 nodes unreachable)',
      ago('-90 minutes'), ago('-4 minutes'));
    insertIssue.run('token-permissions|pve-lab-01|pve-lab-01', 'pve-lab-01', labId, 'warning',
      'token-permissions', 'pve-lab-01', 'API token for pve-lab-01 is missing PVEAuditor — some inventory may be incomplete',
      ago('-6 days'), ago('-6 minutes'));
  }

  return {
    servers: 2,
    nodes: 4,
    guests: guestTotal,
    storages: 6,
    backupJobs: 4,
    tasks: taskTotal,
    metrics: metricTotal,
    issueHistory: db.prepare('SELECT COUNT(*) n FROM proxmox_issue_history').get().n,
  };
}

module.exports = { seedProxmox };
