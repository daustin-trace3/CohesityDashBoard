// Aria Operations (vROps) demo data: two registered instances — a healthy
// production analytics cluster and a DR instance that last polled with an
// error — monitoring the SAME estate the vCenter generator builds, so the
// demo reads as one environment seen through two tools. Resources span
// VirtualMachine/HostSystem/Datastore with a realistic health mix, alerts
// cover every level the Overview and Alerts pages colour-code, and
// ariaops_metrics_history carries 30 days of daily snapshots for trends.
//
// Deliberate trouble: RED hosts and datastores, a badge of YELLOW/ORANGE
// resources, CRITICAL + IMMEDIATE alerts on named resources, and one
// instance whose last poll failed.
const { randInt, randFloat, pick, chance, rngFor } = require('./core');

// Same sites the vCenter generator uses, so names line up across platforms.
const SITES = ['nyc', 'lon', 'fra', 'sgp'];
const VM_ROLES = ['app', 'db', 'web', 'dc', 'file', 'mon', 'ci', 'jump'];
const HEALTH_WEIGHTS = [
  { health: 'GREEN', weight: 78 },
  { health: 'YELLOW', weight: 12 },
  { health: 'ORANGE', weight: 5 },
  { health: 'RED', weight: 3 },
  { health: 'GREY', weight: 2 },
];
// Definitions are keyed by the resource kind they can fire against — a
// "memory ballooning" alert on an ESXi host (or a "host CPU" alert on a VM)
// is the kind of nonsense that gets noticed in a live demo.
const ALERT_DEFS = {
  VirtualMachine: [
    { name: 'Virtual machine has CPU contention', impact: 'risk', level: 'WARNING' },
    { name: 'Virtual machine is experiencing memory ballooning', impact: 'health', level: 'WARNING' },
    { name: 'Virtual machine has undersized memory', impact: 'efficiency', level: 'INFO' },
    { name: 'Virtual machine snapshot is older than 30 days', impact: 'efficiency', level: 'WARNING' },
    { name: 'Virtual machine guest file system is running out of space', impact: 'risk', level: 'IMMEDIATE' },
  ],
  HostSystem: [
    { name: 'Host has sustained high CPU workload', impact: 'health', level: 'IMMEDIATE' },
    { name: 'Host is violating vSphere HA admission control policy', impact: 'risk', level: 'CRITICAL' },
    { name: 'Host network packet loss detected', impact: 'health', level: 'WARNING' },
    { name: 'Host memory usage is at critical level', impact: 'health', level: 'CRITICAL' },
    { name: 'Host has reclaimable capacity', impact: 'efficiency', level: 'INFO' },
  ],
  Datastore: [
    { name: 'Datastore is running out of disk space', impact: 'risk', level: 'CRITICAL' },
    { name: 'Datastore latency is above threshold', impact: 'health', level: 'IMMEDIATE' },
    { name: 'Datastore has reclaimable capacity from orphaned disks', impact: 'efficiency', level: 'INFO' },
    { name: 'Datastore I/O contention is affecting virtual machines', impact: 'health', level: 'WARNING' },
  ],
};

function weightedHealth(rng) {
  const total = HEALTH_WEIGHTS.reduce((a, h) => a + h.weight, 0);
  let roll = randInt(rng, 1, total);
  for (const h of HEALTH_WEIGHTS) {
    roll -= h.weight;
    if (roll <= 0) return h.health;
  }
  return 'GREEN';
}

function seedAriaops(db, { now, encrypt }) {
  const agoStmt = db.prepare("SELECT datetime('now', ?) d");
  const ago = (offset) => agoStmt.get(offset).d;
  const nowMs = new Date(now).getTime();

  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES ('platform_ariaops_enabled', '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run();

  const insertInstance = db.prepare(`
    INSERT INTO ariaops_instances (name, host, username, auth_source, encrypted_credentials, ssl_verify,
      polling_interval_minutes, version, last_poll_status, last_poll_error, last_poll_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, 15, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `);
  const insertResource = db.prepare(`
    INSERT INTO ariaops_resources (instance_id, resource_id, name, kind, adapter_kind, health,
      status_json, cpu_pct, mem_pct, stats_captured_at, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const insertAlert = db.prepare(`
    INSERT INTO ariaops_alerts (instance_id, alert_id, level, status, resource_name, definition_name,
      impact, started_at_ms, updated_at_ms, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const insertMetric = db.prepare(`
    INSERT INTO ariaops_metrics_history (instance_id, captured_at, resources_total, vms_total,
      resources_red, resources_yellow, alerts_critical, alerts_total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const INSTANCES = [
    {
      name: 'vrops-prod-01', host: 'vrops-prod-01.icc.demo', user: 'svc-icc@vsphere.local',
      authSource: 'vsphere.local', version: '8.18.1', sites: ['nyc', 'lon', 'fra'],
      status: 'success', error: null, pollAt: ago('-6 minutes'),
    },
    {
      name: 'vrops-dr-01', host: 'vrops-dr-01.icc.demo', user: 'svc-icc@vsphere.local',
      authSource: 'vsphere.local', version: '8.16.2', sites: ['sgp'],
      status: 'error', error: 'Suite API token request failed: 401 Unauthorized',
      pollAt: ago('-52 minutes'),
    },
  ];

  const instanceIds = [];
  for (const inst of INSTANCES) {
    const info = insertInstance.run(
      inst.name, inst.host, inst.user, inst.authSource,
      encrypt(JSON.stringify({ password: 'demo-not-real' })),
      inst.version, inst.status, inst.error, inst.pollAt,
    );
    instanceIds.push({ id: info.lastInsertRowid, ...inst });
  }

  let resourceTotal = 0;
  let alertTotal = 0;
  let metricTotal = 0;
  const perInstanceCounts = new Map();

  for (const inst of instanceIds) {
    const rng = rngFor(`ariaops-${inst.name}`);
    const resources = [];

    // ── Hosts: 4 per site, one deliberately RED on the first site ────────
    inst.sites.forEach((site, siteIdx) => {
      for (let h = 1; h <= 4; h++) {
        const name = `esx-${site}-${String(h).padStart(2, '0')}.icc.demo`;
        const forcedRed = siteIdx === 0 && h === 3;
        const health = forcedRed ? 'RED' : weightedHealth(rng);
        resources.push({
          kind: 'HostSystem', adapterKind: 'VMWARE', name, health,
          cpu: forcedRed ? randFloat(rng, 92, 98) : randFloat(rng, 18, 74),
          mem: forcedRed ? randFloat(rng, 88, 96) : randFloat(rng, 32, 81),
        });
      }
    });

    // ── Datastores: 3 per site, one critically full on the first site ────
    inst.sites.forEach((site, siteIdx) => {
      for (const kind of ['ssd', 'nl', 'vsan']) {
        const name = `ds-${site}-${kind}-01`;
        const forcedRed = siteIdx === 0 && kind === 'nl';
        resources.push({
          kind: 'Datastore', adapterKind: 'VMWARE', name,
          health: forcedRed ? 'RED' : weightedHealth(rng),
          cpu: null,
          mem: forcedRed ? randFloat(rng, 94, 99) : randFloat(rng, 38, 86),
        });
      }
    });

    // ── VMs: 14 per site across the standard role names ──────────────────
    inst.sites.forEach((site) => {
      for (let v = 1; v <= 14; v++) {
        const role = pick(rng, VM_ROLES);
        const name = `${site}-${role}-${String(v).padStart(2, '0')}`;
        const powered = !chance(rng, 0.06);
        resources.push({
          kind: 'VirtualMachine', adapterKind: 'VMWARE', name,
          health: powered ? weightedHealth(rng) : 'GREY',
          cpu: powered ? randFloat(rng, 2, 88) : 0,
          mem: powered ? randFloat(rng, 12, 91) : 0,
          powered,
        });
      }
    });

    resources.forEach((r, idx) => {
      const statusJson = JSON.stringify({
        resourceState: r.powered === false ? 'STOPPED' : 'STARTED',
        resourceStatus: r.health === 'GREY' ? 'DATA_RECEIVING' : 'DATA_RECEIVING',
        healthValue: { GREEN: 100, YELLOW: 75, ORANGE: 50, RED: 25, GREY: 0 }[r.health],
      });
      insertResource.run(
        inst.id, `${inst.name}-res-${String(idx + 1).padStart(4, '0')}`, r.name, r.kind,
        r.adapterKind, r.health, statusJson,
        r.cpu === null ? null : Number(r.cpu), r.mem === null ? null : Number(r.mem),
        ago(`-${randInt(rng, 3, 20)} minutes`),
      );
    });
    resourceTotal += resources.length;

    // ── Alerts on real resource names, newest first ──────────────────────
    const unhealthy = resources.filter((r) => r.health === 'RED' || r.health === 'ORANGE' || r.health === 'YELLOW');
    const alertCount = inst.sites.length * 6;
    for (let a = 0; a < alertCount; a++) {
      const target = unhealthy.length ? unhealthy[a % unhealthy.length] : pick(rng, resources);
      const defs = ALERT_DEFS[target.kind];
      const def = defs[a % defs.length];
      // Keep the level consistent with how bad the target actually is.
      const level = target.health === 'RED' && def.level === 'WARNING' ? 'IMMEDIATE' : def.level;
      const startedMs = nowMs - randInt(rng, 20, 14 * 24 * 60) * 60 * 1000;
      insertAlert.run(
        inst.id, `${inst.name}-alert-${String(a + 1).padStart(4, '0')}`, level,
        chance(rng, 0.85) ? 'ACTIVE' : 'SUSPENDED', target.name, def.name, def.impact,
        startedMs, startedMs + randInt(rng, 5, 240) * 60 * 1000,
      );
    }
    alertTotal += alertCount;

    const counts = {
      total: resources.length,
      vms: resources.filter((r) => r.kind === 'VirtualMachine').length,
      red: resources.filter((r) => r.health === 'RED').length,
      yellow: resources.filter((r) => r.health === 'YELLOW').length,
    };
    perInstanceCounts.set(inst.id, counts);

    // ── 30 days of daily snapshots, drifting toward today's real counts ──
    for (let d = 30; d >= 0; d--) {
      const drift = d / 30;
      insertMetric.run(
        inst.id, ago(`-${d} days`),
        Math.round(counts.total - drift * randInt(rng, 0, 6)),
        Math.round(counts.vms - drift * randInt(rng, 0, 4)),
        Math.max(0, Math.round(counts.red + (chance(rng, 0.3) ? randInt(rng, -1, 2) : 0))),
        Math.max(0, Math.round(counts.yellow + randInt(rng, -2, 3))),
        randInt(rng, 0, 4),
        Math.round(alertCount * (0.7 + randFloat(rng, 0, 0.5))),
      );
      metricTotal += 1;
    }
  }

  return {
    instances: instanceIds.length,
    resources: resourceTotal,
    alerts: alertTotal,
    metrics: metricTotal,
  };
}

module.exports = { seedAriaops };
