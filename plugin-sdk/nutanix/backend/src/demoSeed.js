// Nutanix scope demo data: 2 Prism Central sources (fronting 5 AHV clusters
// total) + 4 standalone Prism Element sources (one Community Edition
// single-node), a Move companion appliance, and 31 days of per-cluster
// metrics history. Includes deliberate trouble so the Nutanix issues feed
// demos every rule in issues.js: a cluster with ft_failures_tolerable=0, two
// hot containers (91%/96%), a cluster at 88% storage, 3 unresolved critical
// alerts, a degraded host, a paused in-flight replication, an 8h-old
// recovery point under a 1h RPO policy, 12 unprotected VMs on a PE cluster, a
// cluster with runway_days=45, and a failed Move event. All sources poll
// clean (last_poll_status='success') — source-unreachable and auth-degraded
// are intentionally NOT triggered.
//
// Ported from backend/demo/generators/nutanix.js. ALL inserts here run ONLY
// behind the DASHBOARD_DEMO==='1' gate — see seedNutanixDemo() below, called
// from poller.js's manifest createPoller(coreApi) entry point on every boot
// in demo mode (wipe children->parents, then reseed with fresh relative
// timestamps). Real (non-demo) instances never call this module. Port traps
// fixed here: the generator's issue-history reconcile is repointed at this
// plugin's own ./issues module (threaded with coreApi) instead of the host's
// backend/services/nutanixIssues; only the seeded-random helpers were copied
// from the host's demo/generators/core.js (./demoRng.js) — no seedCore/
// encryption requires.
const { randInt, randFloat, pick, chance, rngFor } = require('./demoRng');

const HOST_MODELS = [
  { model: 'NX-3060-G7', cpu: 'Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz', sockets: 2, cores: 16, clockHz: 2000000000, memGb: 256, hybrid: true },
  { model: 'NX-8155-G8', cpu: 'Intel(R) Xeon(R) Platinum 8358 CPU @ 2.60GHz', sockets: 2, cores: 32, clockHz: 2600000000, memGb: 512, hybrid: false },
];
const SSD_MODELS = [
  { model: 'MZ7LH3T8HMLT-00005', vendor: 'Samsung', sizeGb: 3840 },
  { model: 'PM1733a', vendor: 'Samsung', sizeGb: 1920 },
];
const HDD_MODELS = [
  { model: 'HUH721212AL5204', vendor: 'HGST', sizeGb: 12000 },
  { model: 'ST16000NM001G', vendor: 'Seagate', sizeGb: 16000 },
];
const GUEST_OS = [
  'Microsoft Windows Server 2022', 'Microsoft Windows Server 2019',
  'Ubuntu Linux 22.04', 'Red Hat Enterprise Linux 9', 'Red Hat Enterprise Linux 8',
  'CentOS 7', 'SUSE Linux Enterprise 15',
];
const VM_ROLES = ['app', 'db', 'web', 'dc', 'file', 'mon', 'ci', 'jump'];
const NGT_STATUSES = ['INSTALLED_AND_ENABLED', 'INSTALLED_AND_ENABLED', 'INSTALLED_AND_ENABLED', 'INSTALLED_NOT_ENABLED', 'NOT_INSTALLED'];
// Reused exact VM names from the host vcenter demo generator's nyc Aria-suite
// block so Server 360 gets cross-platform hits on the same guest names.
const CROSS_HIT_VM_NAMES = ['vra-prod', 'vra-dr', 'vrops-nyc-01', 'vrli-nyc-01'];

const GIB = 1024 ** 3;

function uuid(rng) {
  const hex = () => Math.floor(rng() * 16).toString(16);
  const seg = (n) => Array.from({ length: n }, hex).join('');
  return `${seg(8)}-${seg(4)}-4${seg(3)}-${seg(4)}-${seg(12)}`;
}

// source name -> source_type / host / flags
const SOURCES = [
  { name: 'nyc-ntx-pc-01', type: 'prism_central', host: 'pc-nyc.icc.demo', isCe: 0, apiFlavor: 'v3', productVersion: 'pc.2024.3' },
  { name: 'lon-ntx-pc-01', type: 'prism_central', host: 'pc-lon.icc.demo', isCe: 0, apiFlavor: 'v3', productVersion: null },
  { name: 'fra-ntx-pe-01', type: 'prism_element', host: 'pe-fra.icc.demo', isCe: 0, apiFlavor: 'v2.0', productVersion: null },
  { name: 'sgp-ntx-pe-01', type: 'prism_element', host: 'pe-sgp.icc.demo', isCe: 1, apiFlavor: 'v2.0', productVersion: null },
  { name: 'syd-ntx-pe-01', type: 'prism_element', host: 'pe-syd.icc.demo', isCe: 0, apiFlavor: 'v2.0', productVersion: null },
  { name: 'chi-ntx-pe-01', type: 'prism_element', host: 'pe-chi.icc.demo', isCe: 0, apiFlavor: 'v2.0', productVersion: null },
];

// cluster plan: which source manages it, node count, VM count, deliberate flags
const CLUSTER_PLAN = [
  { source: 'nyc-ntx-pc-01', name: 'nyc-ntx-prd-01', numNodes: 4, vmCount: 120, criticalAlerts: true, rpoViolation: true, crossHits: true },
  { source: 'nyc-ntx-pc-01', name: 'nyc-ntx-dr-01', numNodes: 4, vmCount: 70, degradedHost: true },
  { source: 'nyc-ntx-pc-01', name: 'nyc-ntx-dev-01', numNodes: 4, vmCount: 40 },
  { source: 'lon-ntx-pc-01', name: 'lon-ntx-prd-01', numNodes: 4, vmCount: 110, hotContainer: 91 },
  { source: 'lon-ntx-pc-01', name: 'lon-ntx-dr-01', numNodes: 4, vmCount: 60, ftZero: true },
  { source: 'fra-ntx-pe-01', name: 'fra-ntx-prd-01', numNodes: 4, vmCount: 80, storageHot: 0.88, hotContainer: 96 },
  { source: 'sgp-ntx-pe-01', name: 'sgp-ntx-prd-01', numNodes: 1, vmCount: 15, isCe: true },
  { source: 'syd-ntx-pe-01', name: 'syd-ntx-prd-01', numNodes: 4, vmCount: 65, unprotected: 12 },
  { source: 'chi-ntx-pe-01', name: 'chi-ntx-prd-01', numNodes: 4, vmCount: 40, runwayLow: true },
];

function seedNutanix(db, { now, encrypt, coreApi }) {
  const agoStmt = db.prepare("SELECT datetime('now', ?) d");
  const ago = (offset) => agoStmt.get(offset).d;
  const nowIso = new Date(now).toISOString();

  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES ('platform_nutanix_enabled', '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run();

  const insertSource = db.prepare(`
    INSERT INTO nutanix_sources (name, source_type, host, port, username, encrypted_credentials,
      ssl_verify, polling_interval_minutes, is_ce, api_flavor, product_version,
      last_poll_status, last_poll_error, last_poll_at, created_at, updated_at)
    VALUES (@name, @source_type, @host, 9440, 'admin', @encrypted_credentials, 0, 15, @is_ce,
      @api_flavor, @product_version, 'success', NULL, @last_poll_at, @created_at, @updated_at)
  `);
  const insertCluster = db.prepare(`
    INSERT INTO nutanix_clusters (source_id, uuid, name, aos_version, hypervisor_types, num_nodes,
      redundancy_factor, operation_mode, external_ip, storage_capacity_bytes, storage_usage_bytes,
      reduction_ratio_ppm, overall_reduction_ratio_ppm, cpu_usage_ppm, memory_usage_ppm,
      controller_iops, controller_latency_usecs, io_bandwidth_kbps, runway_days,
      ft_failures_tolerable, ft_details, ncc_pass, ncc_warn, ncc_fail, unprotected_vm_count, updated_at)
    VALUES (@source_id, @uuid, @name, @aos_version, @hypervisor_types, @num_nodes, @redundancy_factor,
      @operation_mode, @external_ip, @storage_capacity_bytes, @storage_usage_bytes, @reduction_ratio_ppm,
      @overall_reduction_ratio_ppm, @cpu_usage_ppm, @memory_usage_ppm, @controller_iops,
      @controller_latency_usecs, @io_bandwidth_kbps, @runway_days, @ft_failures_tolerable, @ft_details,
      @ncc_pass, @ncc_warn, @ncc_fail, @unprotected_vm_count, @updated_at)
  `);
  const insertHost = db.prepare(`
    INSERT INTO nutanix_hosts (source_id, cluster_uuid, uuid, name, serial, block_model, block_serial,
      position, cpu_model, num_cpu_sockets, num_cpu_cores, cpu_capacity_hz, memory_capacity_bytes,
      hypervisor_type, hypervisor_version, hypervisor_ip, cvm_ip, ipmi_ip, bios_version, bmc_version,
      num_vms, state, maintenance_mode, is_degraded, boot_time_usecs, cpu_usage_ppm, memory_usage_ppm,
      disks_json, updated_at)
    VALUES (@source_id, @cluster_uuid, @uuid, @name, @serial, @block_model, @block_serial, @position,
      @cpu_model, @num_cpu_sockets, @num_cpu_cores, @cpu_capacity_hz, @memory_capacity_bytes,
      @hypervisor_type, @hypervisor_version, @hypervisor_ip, @cvm_ip, @ipmi_ip, @bios_version,
      @bmc_version, @num_vms, @state, @maintenance_mode, @is_degraded, @boot_time_usecs,
      @cpu_usage_ppm, @memory_usage_ppm, @disks_json, @updated_at)
  `);
  const insertDisk = db.prepare(`
    INSERT INTO nutanix_disks (source_id, cluster_uuid, disk_uuid, serial, model, vendor, tier,
      size_bytes, usage_bytes, online, status, bad, host_name, firmware, updated_at)
    VALUES (@source_id, @cluster_uuid, @disk_uuid, @serial, @model, @vendor, @tier, @size_bytes,
      @usage_bytes, @online, @status, @bad, @host_name, @firmware, @updated_at)
  `);
  const insertVm = db.prepare(`
    INSERT INTO nutanix_vms (source_id, cluster_uuid, cluster_name, uuid, name, power_state,
      num_vcpus, memory_mb, host_uuid, host_name, ip_addresses, ngt_status, guest_os, disk_count,
      disk_bytes, categories, cpu_usage_ppm, memory_usage_ppm, controller_iops, latency_usecs, updated_at)
    VALUES (@source_id, @cluster_uuid, @cluster_name, @uuid, @name, @power_state, @num_vcpus,
      @memory_mb, @host_uuid, @host_name, @ip_addresses, @ngt_status, @guest_os, @disk_count,
      @disk_bytes, @categories, @cpu_usage_ppm, @memory_usage_ppm, @controller_iops, @latency_usecs, @updated_at)
  `);
  const insertContainer = db.prepare(`
    INSERT INTO nutanix_containers (source_id, cluster_uuid, cluster_name, uuid, name,
      replication_factor, compression_enabled, dedup_enabled, erasure_code, capacity_bytes,
      usage_bytes, free_bytes, reduction_ratio_ppm, updated_at)
    VALUES (@source_id, @cluster_uuid, @cluster_name, @uuid, @name, @replication_factor,
      @compression_enabled, @dedup_enabled, @erasure_code, @capacity_bytes, @usage_bytes,
      @free_bytes, @reduction_ratio_ppm, @updated_at)
  `);
  const insertAlert = db.prepare(`
    INSERT INTO nutanix_alerts (source_id, cluster_uuid, cluster_name, alert_uuid, severity, title,
      message, entity_type, entity_name, acknowledged, resolved, created_usecs, created_at)
    VALUES (@source_id, @cluster_uuid, @cluster_name, @alert_uuid, @severity, @title, @message,
      @entity_type, @entity_name, @acknowledged, @resolved, @created_usecs, @created_at)
  `);
  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO nutanix_events (source_id, cluster_uuid, message, entity_type, entity_name,
      created_usecs, created_at)
    VALUES (@source_id, @cluster_uuid, @message, @entity_type, @entity_name, @created_usecs, @created_at)
  `);
  const insertPd = db.prepare(`
    INSERT INTO nutanix_pds (source_id, name, active, vm_count, remote_sites, next_snapshot_usecs,
      pending_replications, ongoing_replications, tx_bandwidth_kbps, exclusive_snapshot_bytes,
      schedules_json, updated_at)
    VALUES (@source_id, @name, @active, @vm_count, @remote_sites, @next_snapshot_usecs,
      @pending_replications, @ongoing_replications, @tx_bandwidth_kbps, @exclusive_snapshot_bytes,
      @schedules_json, @updated_at)
  `);
  const insertReplication = db.prepare(`
    INSERT INTO nutanix_replications (source_id, replication_id, pd_name, remote_site, snapshot_id,
      completed_percentage, completed_bytes, eta_secs, start_usecs, paused, updated_at)
    VALUES (@source_id, @replication_id, @pd_name, @remote_site, @snapshot_id, @completed_percentage,
      @completed_bytes, @eta_secs, @start_usecs, @paused, @updated_at)
  `);
  const insertRemoteSite = db.prepare(`
    INSERT INTO nutanix_remote_sites (source_id, name, status, latency_usecs, capabilities,
      tx_bandwidth_kbps, updated_at)
    VALUES (@source_id, @name, @status, @latency_usecs, @capabilities, @tx_bandwidth_kbps, @updated_at)
  `);
  const insertPolicy = db.prepare(`
    INSERT INTO nutanix_protection_policies (source_id, uuid, name, rpo_secs, remote_targets_json,
      categories_json, updated_at)
    VALUES (@source_id, @uuid, @name, @rpo_secs, @remote_targets_json, @categories_json, @updated_at)
  `);
  const insertRecoveryPoint = db.prepare(`
    INSERT INTO nutanix_recovery_points (source_id, kind, pd_name, vm_uuid, vm_name, created_at_ts,
      expires_at_ts, location, size_bytes, updated_at)
    VALUES (@source_id, @kind, @pd_name, @vm_uuid, @vm_name, @created_at_ts, @expires_at_ts,
      @location, @size_bytes, @updated_at)
  `);
  const insertMetric = db.prepare(`
    INSERT INTO nutanix_metrics_history (cluster_id, captured_at, storage_capacity_bytes,
      storage_usage_bytes, cpu_usage_ppm, memory_usage_ppm, controller_iops, controller_latency_usecs,
      replication_tx_kbps)
    VALUES (@cluster_id, @captured_at, @storage_capacity_bytes, @storage_usage_bytes, @cpu_usage_ppm,
      @memory_usage_ppm, @controller_iops, @controller_latency_usecs, @replication_tx_kbps)
  `);
  const insertMoveConn = db.prepare(`
    INSERT INTO nutanix_move_conns (name, host, username, encrypted_credentials, ssl_verify,
      appliance_version, last_poll_status, last_poll_error, last_poll_at, created_at, updated_at)
    VALUES (@name, @host, @username, @encrypted_credentials, 0, @appliance_version, 'success', NULL,
      @last_poll_at, @created_at, @updated_at)
  `);
  const insertMovePlan = db.prepare(`
    INSERT INTO nutanix_move_plans (conn_id, plan_uuid, name, state, migration_status, progress,
      source_provider, target_provider, vm_count, updated_at)
    VALUES (@conn_id, @plan_uuid, @name, @state, @migration_status, @progress, @source_provider,
      @target_provider, @vm_count, @updated_at)
  `);
  const insertMoveWorkload = db.prepare(`
    INSERT INTO nutanix_move_workloads (conn_id, plan_uuid, plan_name, vm_uuid, vm_name, state_code,
      state_label, progress, updated_at)
    VALUES (@conn_id, @plan_uuid, @plan_name, @vm_uuid, @vm_name, @state_code, @state_label, @progress, @updated_at)
  `);
  const insertMoveEvent = db.prepare(`
    INSERT INTO nutanix_move_events (conn_id, event_id, event_name, vm_name, plan_name, status,
      failure_notes, created_usecs, created_at)
    VALUES (@conn_id, @event_id, @event_name, @vm_name, @plan_name, @status, @failure_notes, @created_usecs, @created_at)
  `);
  // ── Sources ────────────────────────────────────────────────────────────
  const sourceIds = {};
  for (const s of SOURCES) {
    const info = insertSource.run({
      name: s.name, source_type: s.type, host: s.host,
      encrypted_credentials: encrypt(JSON.stringify({ username: 'admin', password: 'demo-not-real' })),
      is_ce: s.isCe, api_flavor: s.apiFlavor, product_version: s.productVersion,
      last_poll_at: ago(`-${randInt(rngFor(s.name), 2, 12)} minutes`), created_at: nowIso, updated_at: nowIso,
    });
    sourceIds[s.name] = info.lastInsertRowid;
  }

  // ── Clusters + hosts + disks + VMs + containers ───────────────────────
  let hostTotal = 0, vmTotal = 0, containerTotal = 0, diskTotal = 0;
  const clusters = []; // { id, uuid, name, sourceId, sourceName, plan, vmUuids: [] }
  let badDiskAssigned = false;
  let rpoViolationVm = null;

  CLUSTER_PLAN.forEach((plan, clusterIdx) => {
    const rng = rngFor(`nutanix-${plan.name}`);
    const sourceId = sourceIds[plan.source];
    const sourceType = SOURCES.find((s) => s.name === plan.source).type;
    const clusterUuid = uuid(rng);
    const isCe = !!plan.isCe;
    const rf = isCe ? 1 : 2;
    const capacityBytes = isCe
      ? Math.round(randFloat(rng, 8, 15, 2) * 1024 * GIB)
      : Math.round(randFloat(rng, 80, 400, 2) * 1024 * GIB);
    const usagePct = plan.storageHot != null ? plan.storageHot : randFloat(rng, 0.35, 0.7, 2);
    const usageBytes = Math.round(capacityBytes * usagePct);
    const ftValue = isCe ? null : (plan.ftZero ? 0 : 1);
    const runwayDays = isCe ? null : (plan.runwayLow ? 45 : randInt(rng, 200, 450));
    const nccPass = isCe ? null : randInt(rng, 100, 140);
    const nccWarn = isCe ? null : randInt(rng, 0, 4);
    const nccFail = isCe ? null : (chance(rng, 0.15) ? 1 : 0);

    insertCluster.run({
      source_id: sourceId, uuid: clusterUuid, name: plan.name,
      aos_version: isCe ? '6.5.6' : pick(rng, ['6.8.1', '6.10', '7.0.1']),
      hypervisor_types: JSON.stringify(['AHV']), num_nodes: plan.numNodes,
      redundancy_factor: rf, operation_mode: 'NORMAL',
      external_ip: `10.${20 + clusterIdx}.0.100`,
      storage_capacity_bytes: capacityBytes, storage_usage_bytes: usageBytes,
      reduction_ratio_ppm: randInt(rng, 1200000, 2400000),
      overall_reduction_ratio_ppm: randInt(rng, 1500000, 3200000),
      cpu_usage_ppm: randInt(rng, 200000, 650000), memory_usage_ppm: randInt(rng, 300000, 750000),
      controller_iops: randInt(rng, 3000, 25000), controller_latency_usecs: randInt(rng, 400, 2500),
      io_bandwidth_kbps: randInt(rng, 50000, 400000),
      runway_days: runwayDays, ft_failures_tolerable: ftValue,
      ft_details: isCe ? null : JSON.stringify({ domain: 'node', component: 'zookeeper' }),
      ncc_pass: nccPass, ncc_warn: nccWarn, ncc_fail: nccFail,
      unprotected_vm_count: plan.unprotected || 0,
      updated_at: nowIso,
    });
    const clusterId = db.prepare('SELECT id FROM nutanix_clusters WHERE source_id = ? AND uuid = ?').get(sourceId, clusterUuid).id;
    clusters.push({ id: clusterId, uuid: clusterUuid, name: plan.name, sourceId, sourceName: plan.source, sourceType, plan, vmUuids: [] });

    // Hosts + disks
    const hostRows = [];
    const hostModel = HOST_MODELS[clusterIdx % 2];
    const blockSerial = `BLK${1000 + clusterIdx}${String(randInt(rng, 10, 99))}`;
    for (let n = 1; n <= plan.numNodes; n++) {
      const hostUuid = uuid(rng);
      const hostName = `${plan.name}-node${String(n).padStart(2, '0')}`;
      const degraded = plan.degradedHost && n === 1;
      const disks = [];
      const ssdCount = hostModel.hybrid ? 2 : 6;
      const hddCount = hostModel.hybrid ? 4 : 0;
      for (let d = 0; d < ssdCount + hddCount; d++) {
        const isSsd = d < ssdCount;
        const dm = pick(rng, isSsd ? SSD_MODELS : HDD_MODELS);
        const sizeBytes = dm.sizeGb * GIB;
        const usedFrac = randFloat(rng, 0.3, 0.75, 2);
        const isBad = !badDiskAssigned && clusterIdx === 0 && n === 1 && d === 0;
        if (isBad) badDiskAssigned = true;
        const diskUuid = uuid(rng);
        const diskRow = {
          source_id: sourceId, cluster_uuid: clusterUuid, disk_uuid: diskUuid,
          serial: `${dm.model}-${String(randInt(rng, 100000, 999999))}`,
          model: dm.model, vendor: dm.vendor, tier: isSsd ? 'SSD' : 'HDD',
          size_bytes: sizeBytes, usage_bytes: Math.round(sizeBytes * usedFrac),
          online: isBad ? 0 : 1, status: isBad ? 'critical' : 'online', bad: isBad ? 1 : 0,
          host_name: hostName, firmware: isSsd ? 'DXT7201Q' : 'PAG1',
          updated_at: nowIso,
        };
        insertDisk.run(diskRow);
        diskTotal++;
        disks.push({ uuid: diskUuid, tier: diskRow.tier, sizeBytes, usageBytes: diskRow.usage_bytes, bad: !!isBad });
      }
      const hostVms = Math.round(plan.vmCount / plan.numNodes);
      insertHost.run({
        source_id: sourceId, cluster_uuid: clusterUuid, uuid: hostUuid, name: hostName,
        serial: `NTX${clusterIdx}${n}${String(randInt(rng, 1000, 9999))}`,
        block_model: hostModel.model, block_serial: blockSerial,
        position: String.fromCharCode(64 + n),
        cpu_model: hostModel.cpu, num_cpu_sockets: hostModel.sockets, num_cpu_cores: hostModel.cores,
        cpu_capacity_hz: hostModel.sockets * hostModel.cores * hostModel.clockHz,
        memory_capacity_bytes: hostModel.memGb * GIB,
        hypervisor_type: 'AHV', hypervisor_version: pick(rng, ['10.0.1.1', '10.1', '10.3']),
        hypervisor_ip: `10.${20 + clusterIdx}.1.${10 + n}`,
        cvm_ip: `10.${20 + clusterIdx}.2.${10 + n}`,
        ipmi_ip: `10.${20 + clusterIdx}.3.${10 + n}`,
        bios_version: pick(rng, ['G7T.500', 'G8T.020']), bmc_version: pick(rng, ['7.11', '8.02']),
        num_vms: hostVms, state: 'NORMAL', maintenance_mode: 0, is_degraded: degraded ? 1 : 0,
        boot_time_usecs: (now - randInt(rng, 5, 300) * 86400000) * 1000,
        cpu_usage_ppm: randInt(rng, 150000, 700000), memory_usage_ppm: randInt(rng, 250000, 800000),
        disks_json: JSON.stringify(disks.map((d) => ({ uuid: d.uuid, tier: d.tier, sizeBytes: d.sizeBytes, usageBytes: d.usageBytes, bad: d.bad }))),
        updated_at: nowIso,
      });
      hostTotal++;
      hostRows.push({ uuid: hostUuid, name: hostName });
    }

    // VMs
    for (let v = 0; v < plan.vmCount; v++) {
      const host = hostRows[v % hostRows.length];
      const role = pick(rng, VM_ROLES);
      const poweredOn = chance(rng, 0.9);
      const useCrossHit = plan.crossHits && v < CROSS_HIT_VM_NAMES.length;
      const vmName = useCrossHit ? CROSS_HIT_VM_NAMES[v] : `${plan.name}-${role}-${String(v + 1).padStart(3, '0')}`;
      const vmUuid = uuid(rng);
      const numVcpus = pick(rng, [2, 2, 4, 4, 8, 16]);
      const memoryMb = pick(rng, [4, 8, 8, 16, 32, 64]) * 1024;
      const ip = poweredOn ? `10.${20 + clusterIdx}.${10 + (v % 200)}.${10 + (v % 240)}` : null;
      insertVm.run({
        source_id: sourceId, cluster_uuid: clusterUuid, cluster_name: plan.name, uuid: vmUuid,
        name: vmName, power_state: poweredOn ? 'ON' : 'OFF', num_vcpus: numVcpus, memory_mb: memoryMb,
        host_uuid: host.uuid, host_name: host.name,
        ip_addresses: JSON.stringify(ip ? [ip] : []),
        ngt_status: pick(rng, NGT_STATUSES), guest_os: pick(rng, GUEST_OS),
        disk_count: randInt(rng, 1, 3), disk_bytes: randInt(rng, 20, 800) * GIB,
        categories: JSON.stringify({ Environment: chance(rng, 0.75) ? 'Production' : 'Dev', App: role.toUpperCase() }),
        cpu_usage_ppm: poweredOn ? randInt(rng, 50000, 800000) : null,
        memory_usage_ppm: poweredOn ? randInt(rng, 100000, 850000) : null,
        controller_iops: poweredOn ? randInt(rng, 20, 4000) : null,
        latency_usecs: poweredOn ? randInt(rng, 200, 3000) : null,
        updated_at: nowIso,
      });
      vmTotal++;
      clusters[clusterIdx].vmUuids.push({ uuid: vmUuid, name: vmName });
      if (plan.rpoViolation && v === 5 && !rpoViolationVm) {
        rpoViolationVm = { uuid: vmUuid, name: vmName, sourceId, sourceName: plan.source };
      }
    }

    // Containers: 3 per cluster
    for (let c = 1; c <= 3; c++) {
      const ctrName = `${plan.name}-ctr-${String(c).padStart(2, '0')}`;
      const ctrCapacity = Math.round(capacityBytes / 3);
      let ctrUsedPct = randFloat(rng, 0.3, 0.65, 2);
      if (plan.hotContainer && c === 1) ctrUsedPct = plan.hotContainer / 100;
      const ctrUsed = Math.round(ctrCapacity * ctrUsedPct);
      insertContainer.run({
        source_id: sourceId, cluster_uuid: clusterUuid, cluster_name: plan.name, uuid: uuid(rng),
        name: ctrName, replication_factor: rf, compression_enabled: 1, dedup_enabled: chance(rng, 0.5) ? 1 : 0,
        erasure_code: isCe ? null : (chance(rng, 0.4) ? 'ON' : 'OFF'),
        capacity_bytes: ctrCapacity, usage_bytes: ctrUsed, free_bytes: ctrCapacity - ctrUsed,
        reduction_ratio_ppm: randInt(rng, 1200000, 2600000), updated_at: nowIso,
      });
      containerTotal++;
    }
  });

  // ── Alerts: mix per cluster, nyc-ntx-prd-01 gets exactly 3 unresolved criticals ──
  const ALERT_TITLES = [
    { title: 'Node Detached From Metadata Ring', sev: 'critical', entity: 'Cluster' },
    { title: 'Metro Availability Witness Unreachable', sev: 'critical', entity: 'Cluster' },
    { title: 'Controller VM Memory Usage High', sev: 'warning', entity: 'Host' },
    { title: 'Disk Diagnostic Failure', sev: 'warning', entity: 'Disk' },
    { title: 'Time Drift Detected', sev: 'info', entity: 'Host' },
    { title: 'Protection Domain Replication Delayed', sev: 'warning', entity: 'ProtectionDomain' },
    { title: 'Cluster Services Restart', sev: 'info', entity: 'Cluster' },
  ];
  let alertTotal = 0;
  clusters.forEach((cl) => {
    const rng = rngFor(`nutanix-alerts-${cl.name}`);
    const forcedCriticals = cl.plan.criticalAlerts ? 3 : 0;
    for (let i = 0; i < forcedCriticals; i++) {
      insertAlert.run({
        source_id: cl.sourceId, cluster_uuid: cl.uuid, cluster_name: cl.name,
        alert_uuid: uuid(rng), severity: 'critical', title: ALERT_TITLES[i % 2].title,
        message: `${ALERT_TITLES[i % 2].title} on cluster ${cl.name}`,
        entity_type: 'Cluster', entity_name: cl.name, acknowledged: 0, resolved: 0,
        created_usecs: (now - randInt(rng, 10, 600) * 60000) * 1000,
        created_at: ago(`-${randInt(rng, 10, 600)} minutes`),
      });
      alertTotal++;
    }
    const extra = randInt(rng, 2, 5);
    for (let i = 0; i < extra; i++) {
      const def = pick(rng, ALERT_TITLES);
      const resolved = chance(rng, 0.5) ? 1 : 0;
      insertAlert.run({
        source_id: cl.sourceId, cluster_uuid: cl.uuid, cluster_name: cl.name,
        alert_uuid: uuid(rng), severity: def.sev, title: def.title,
        message: `${def.title} on ${cl.name}`,
        entity_type: def.entity, entity_name: cl.name, acknowledged: resolved, resolved,
        created_usecs: (now - randInt(rng, 60, 30 * 24 * 60) * 60000) * 1000,
        created_at: ago(`-${randInt(rng, 60, 30 * 24 * 60)} minutes`),
      });
      alertTotal++;
    }
  });

  // ── Events: ~200 rows across clusters ──────────────────────────────────
  const EVENT_TEMPLATES = [
    (h) => `Host ${h} rebooted successfully`,
    (h) => `VM live-migrated onto host ${h}`,
    (h) => `Snapshot created on host ${h}`,
    (h) => `Curator scan completed on ${h}`,
    (h) => `CVM services restarted on ${h}`,
  ];
  let eventTotal = 0;
  let eventKey = 500000;
  const eventsPerCluster = Math.round(200 / clusters.length);
  clusters.forEach((cl) => {
    const rng = rngFor(`nutanix-events-${cl.name}`);
    for (let i = 0; i < eventsPerCluster; i++) {
      const tpl = pick(rng, EVENT_TEMPLATES);
      const message = tpl(`${cl.name}-node0${randInt(rng, 1, Math.max(1, cl.plan.numNodes))}`);
      const createdAtMs = now - randInt(rng, 5, 48 * 60) * 60000;
      insertEvent.run({
        source_id: cl.sourceId, cluster_uuid: cl.uuid, message,
        entity_type: 'Host', entity_name: cl.name,
        created_usecs: createdAtMs * 1000 + (eventKey % 1000),
        created_at: new Date(createdAtMs).toISOString(),
      });
      eventKey++;
      eventTotal++;
    }
  });

  // ── Protection domains, replications, remote sites (PE sources) ───────
  const PE_SOURCES = SOURCES.filter((s) => s.type === 'prism_element');
  const PD_COUNTS = { 'fra-ntx-pe-01': 3, 'sgp-ntx-pe-01': 1, 'syd-ntx-pe-01': 3, 'chi-ntx-pe-01': 3 };
  const REMOTE_PAIR = { 'fra-ntx-pe-01': 'nyc-ntx-dr-01', 'sgp-ntx-pe-01': 'lon-ntx-dr-01', 'syd-ntx-pe-01': 'lon-ntx-dr-01', 'chi-ntx-pe-01': 'nyc-ntx-dr-01' };
  let pdTotal = 0, replicationTotal = 0;
  const pdNamesBySource = {};
  PE_SOURCES.forEach((s) => {
    const rng = rngFor(`nutanix-pd-${s.name}`);
    const sourceId = sourceIds[s.name];
    const remoteName = REMOTE_PAIR[s.name];
    insertRemoteSite.run({
      source_id: sourceId, name: remoteName, status: 'kConnected',
      latency_usecs: randInt(rng, 15000, 90000), capabilities: JSON.stringify(['kReplication', 'kMigration']),
      tx_bandwidth_kbps: randInt(rng, 50000, 500000), updated_at: nowIso,
    });
    pdNamesBySource[s.name] = [];
    const count = PD_COUNTS[s.name] || 1;
    for (let i = 1; i <= count; i++) {
      const pdName = `${s.name.replace('-pe-', '-pd-')}-${String(i).padStart(2, '0')}`;
      pdNamesBySource[s.name].push(pdName);
      insertPd.run({
        source_id: sourceId, name: pdName, active: 1, vm_count: randInt(rng, 3, 20),
        remote_sites: JSON.stringify([remoteName]),
        next_snapshot_usecs: (now + randInt(rng, 30, 600) * 60000) * 1000,
        pending_replications: randInt(rng, 0, 2), ongoing_replications: 0,
        tx_bandwidth_kbps: randInt(rng, 5000, 80000),
        exclusive_snapshot_bytes: randInt(rng, 1, 200) * GIB,
        schedules_json: JSON.stringify([{ type: 'kHourly', intervalSecs: 3600, retention: 24 }]),
        updated_at: nowIso,
      });
      pdTotal++;
    }
  });
  // 2 in-flight replications: syd healthy 62%, chi paused
  insertReplication.run({
    source_id: sourceIds['syd-ntx-pe-01'], replication_id: `repl-${uuid(rngFor('repl-syd'))}`,
    pd_name: pdNamesBySource['syd-ntx-pe-01'][0], remote_site: REMOTE_PAIR['syd-ntx-pe-01'],
    snapshot_id: `snap-${randInt(rngFor('snap-syd'), 100000, 999999)}`,
    completed_percentage: 62, completed_bytes: Math.round(0.62 * 40 * GIB), eta_secs: 1800,
    start_usecs: (now - 25 * 60000) * 1000, paused: 0, updated_at: nowIso,
  });
  insertReplication.run({
    source_id: sourceIds['chi-ntx-pe-01'], replication_id: `repl-${uuid(rngFor('repl-chi'))}`,
    pd_name: pdNamesBySource['chi-ntx-pe-01'][0], remote_site: REMOTE_PAIR['chi-ntx-pe-01'],
    snapshot_id: `snap-${randInt(rngFor('snap-chi'), 100000, 999999)}`,
    completed_percentage: 30, completed_bytes: Math.round(0.3 * 60 * GIB), eta_secs: null,
    start_usecs: (now - 90 * 60000) * 1000, paused: 1, updated_at: nowIso,
  });
  replicationTotal = 2;

  // ── Protection policies on PC sources ──────────────────────────────────
  const PC_SOURCES = SOURCES.filter((s) => s.type === 'prism_central');
  let policyTotal = 0;
  PC_SOURCES.forEach((s) => {
    const rng = rngFor(`nutanix-policy-${s.name}`);
    const sourceId = sourceIds[s.name];
    const goldName = `${s.name.split('-')[0]}-Gold-Hourly`;
    insertPolicy.run({
      source_id: sourceId, uuid: uuid(rng), name: goldName, rpo_secs: 3600,
      remote_targets_json: JSON.stringify([{ availabilityZone: 'PHYSICAL', clusterUuid: null }]),
      categories_json: JSON.stringify({ Environment: 'Production' }), updated_at: nowIso,
    });
    insertPolicy.run({
      source_id: sourceId, uuid: uuid(rng), name: `${s.name.split('-')[0]}-Silver-6Hour`, rpo_secs: 21600,
      remote_targets_json: JSON.stringify([{ availabilityZone: 'PHYSICAL', clusterUuid: null }]),
      categories_json: JSON.stringify({ Environment: 'Dev' }), updated_at: nowIso,
    });
    policyTotal += 2;
  });

  // ── Recovery points: recovery_point (PC) + pd_snapshot (PE) ────────────
  let recoveryPointTotal = 0;
  clusters.filter((cl) => cl.sourceType === 'prism_central').forEach((cl) => {
    const rng = rngFor(`nutanix-rp-${cl.name}`);
    const sample = cl.vmUuids.slice(0, Math.min(20, cl.vmUuids.length));
    sample.forEach((vm) => {
      const isViolator = rpoViolationVm && vm.uuid === rpoViolationVm.uuid;
      const ageHours = isViolator ? 8 : randFloat(rng, 0.1, 0.9, 2);
      insertRecoveryPoint.run({
        source_id: cl.sourceId, kind: 'recovery_point', pd_name: null, vm_uuid: vm.uuid, vm_name: vm.name,
        created_at_ts: new Date(now - ageHours * 3600000).toISOString(),
        expires_at_ts: new Date(now + 7 * 86400000).toISOString(),
        location: 'local', size_bytes: randInt(rng, 5, 200) * GIB, updated_at: nowIso,
      });
      recoveryPointTotal++;
    });
  });
  PE_SOURCES.forEach((s) => {
    const rng = rngFor(`nutanix-pdsnap-${s.name}`);
    const cl = clusters.find((c) => c.sourceName === s.name);
    if (!cl) return;
    const sample = cl.vmUuids.slice(0, Math.min(10, cl.vmUuids.length));
    sample.forEach((vm) => {
      insertRecoveryPoint.run({
        source_id: sourceIds[s.name], kind: 'pd_snapshot', pd_name: pick(rng, pdNamesBySource[s.name]),
        vm_uuid: vm.uuid, vm_name: vm.name,
        created_at_ts: new Date(now - randInt(rng, 1, 12) * 3600000).toISOString(),
        expires_at_ts: new Date(now + 30 * 86400000).toISOString(),
        location: 'local', size_bytes: randInt(rng, 5, 150) * GIB, updated_at: nowIso,
      });
      recoveryPointTotal++;
    });
  });

  // ── Metrics history: 31 days per cluster, upward growth trend ─────────
  let metricsTotal = 0;
  clusters.forEach((cl) => {
    const rng = rngFor(`nutanix-metrics-${cl.name}`);
    const row = db.prepare('SELECT storage_capacity_bytes, storage_usage_bytes, cpu_usage_ppm, memory_usage_ppm, controller_iops, controller_latency_usecs FROM nutanix_clusters WHERE id = ?').get(cl.id);
    for (let d = 30; d >= 0; d--) {
      const growth = 0.7 + ((30 - d) / 30) * 0.3;
      insertMetric.run({
        cluster_id: cl.id, captured_at: ago(`-${d} days`),
        storage_capacity_bytes: row.storage_capacity_bytes,
        storage_usage_bytes: Math.round(row.storage_usage_bytes * growth),
        cpu_usage_ppm: Math.max(0, Math.round(row.cpu_usage_ppm * growth) + randInt(rng, -20000, 20000)),
        memory_usage_ppm: Math.max(0, Math.round(row.memory_usage_ppm * growth) + randInt(rng, -20000, 20000)),
        controller_iops: Math.max(0, Math.round(row.controller_iops * growth)),
        controller_latency_usecs: row.controller_latency_usecs,
        replication_tx_kbps: randInt(rng, 1000, 60000),
      });
      metricsTotal++;
    }
  });

  // ── Move: 1 conn, 2 plans, 3 events ────────────────────────────────────
  const moveRng = rngFor('nutanix-move');
  const moveInfo = insertMoveConn.run({
    name: 'nyc-move-01', host: 'move-nyc.icc.demo', username: 'admin',
    encrypted_credentials: encrypt(JSON.stringify({ password: 'demo-not-real' })),
    appliance_version: '5.2.0', last_poll_at: ago('-8 minutes'), created_at: nowIso, updated_at: nowIso,
  });
  const moveConnId = moveInfo.lastInsertRowid;
  const planAUuid = uuid(moveRng);
  insertMovePlan.run({
    conn_id: moveConnId, plan_uuid: planAUuid, name: 'vcenter-to-ahv-wave1', state: 'in-progress',
    migration_status: 'MIGRATING', progress: 58, source_provider: 'VMware', target_provider: 'AHV',
    vm_count: 8, updated_at: nowIso,
  });
  const STATE_CODES = [1, 2, 3, 5, 5, 4, 6, 2];
  STATE_CODES.forEach((code, i) => {
    insertMoveWorkload.run({
      conn_id: moveConnId, plan_uuid: planAUuid, plan_name: 'vcenter-to-ahv-wave1',
      vm_uuid: uuid(moveRng), vm_name: `wave1-vm-${String(i + 1).padStart(2, '0')}`,
      state_code: code, state_label: code === 5 ? 'Ready for cutover' : `State ${code}`,
      progress: code === 5 ? 100 : randInt(moveRng, 10, 90), updated_at: nowIso,
    });
  });
  const planBUuid = uuid(moveRng);
  insertMovePlan.run({
    conn_id: moveConnId, plan_uuid: planBUuid, name: 'exchange-migration-complete', state: 'completed',
    migration_status: 'COMPLETED', progress: 100, source_provider: 'VMware', target_provider: 'AHV',
    vm_count: 5, updated_at: nowIso,
  });
  for (let i = 0; i < 5; i++) {
    insertMoveWorkload.run({
      conn_id: moveConnId, plan_uuid: planBUuid, plan_name: 'exchange-migration-complete',
      vm_uuid: uuid(moveRng), vm_name: `exch-vm-${String(i + 1).padStart(2, '0')}`,
      state_code: 8, state_label: 'State 8', progress: 100, updated_at: nowIso,
    });
  }
  const MOVE_EVENTS = [
    { name: 'MigrationStarted', vm: 'wave1-vm-01', plan: 'vcenter-to-ahv-wave1', status: 'SUCCESS', notes: null },
    { name: 'DiskSyncFailed', vm: 'wave1-vm-06', plan: 'vcenter-to-ahv-wave1', status: 'FAILED', notes: 'Disk sync failed: target datastore ran out of space during seeding phase' },
    { name: 'CutoverCompleted', vm: 'exch-vm-01', plan: 'exchange-migration-complete', status: 'SUCCESS', notes: null },
  ];
  MOVE_EVENTS.forEach((e, i) => {
    insertMoveEvent.run({
      conn_id: moveConnId, event_id: `move-evt-${i + 1}`, event_name: e.name, vm_name: e.vm,
      plan_name: e.plan, status: e.status, failure_notes: e.notes,
      created_usecs: (now - randInt(moveRng, 30, 600) * 60000) * 1000,
      created_at: ago(`-${randInt(moveRng, 30, 600)} minutes`),
    });
  });

  // ── Issue history: reconciled live from the seeded inventory ──────────
  let issueHistoryTotal = 0;
  try {
    const { reconcileIssueHistory } = require('./issues');
    reconcileIssueHistory(coreApi);
    const histRng = rngFor('nutanix-issue-history');
    for (const row of db.prepare("SELECT id FROM nutanix_issue_history WHERE status = 'open'").all()) {
      const ageMin = randInt(histRng, 3 * 60, 6 * 24 * 60);
      db.prepare(`
        UPDATE nutanix_issue_history SET first_seen = datetime('now', ?), last_seen = datetime('now', '-4 minutes') WHERE id = ?
      `).run(`-${ageMin} minutes`, row.id);
    }
    const insertResolved = db.prepare(`
      INSERT INTO nutanix_issue_history (issue_key, source, severity, type, target, message, status, first_seen, last_seen, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, 'resolved', datetime('now', ?), datetime('now', ?), datetime('now', ?))
    `);
    const RESOLVED = [
      ['cluster-storage|fra-ntx-pe-01|fra-ntx-dev-01', 'fra-ntx-pe-01', 'warning', 'cluster-storage', 'fra-ntx-dev-01',
        'Cluster fra-ntx-dev-01 storage is 82.4% full', 8 * 24 * 60, 4 * 24 * 60],
      ['prism-alerts|lon-ntx-pc-01|lon-ntx-prd-01', 'lon-ntx-pc-01', 'critical', 'prism-alerts', 'lon-ntx-prd-01',
        '2 unresolved critical alerts on cluster lon-ntx-prd-01', 5 * 24 * 60, 30 * 60],
    ];
    for (const [key, source, sev, type, target, msg, openedMinAgo, durationMin] of RESOLVED) {
      const resolvedMinAgo = openedMinAgo - durationMin;
      insertResolved.run(key, source, sev, type, target, msg,
        `-${openedMinAgo} minutes`, `-${resolvedMinAgo} minutes`, `-${resolvedMinAgo} minutes`);
    }
    issueHistoryTotal = db.prepare('SELECT COUNT(*) n FROM nutanix_issue_history').get().n;
  } catch (err) {
    console.error(`[demoSeed] nutanix issue history reconcile skipped: ${err.message}`);
  }

  return {
    sources: SOURCES.length, clusters: clusters.length, hosts: hostTotal, vms: vmTotal,
    containers: containerTotal, disks: diskTotal, alerts: alertTotal, events: eventTotal,
    pds: pdTotal, replications: replicationTotal, policies: policyTotal,
    recoveryPoints: recoveryPointTotal, metrics: metricsTotal, moveConns: 1, movePlans: 2,
    issueHistory: issueHistoryTotal,
  };
}

// Demo-only entry point. Wipes the nutanix_* estate (children before parents)
// and regenerates it with fresh relative timestamps, so a demo box refreshes
// on every boot instead of aging into a stale-looking estate. NEVER runs
// outside demo mode — see the DASHBOARD_DEMO gate in poller.js.
const DEMO_TABLES = [
  'nutanix_metrics_history', 'nutanix_recovery_points', 'nutanix_protection_policies',
  'nutanix_remote_sites', 'nutanix_replications', 'nutanix_pds', 'nutanix_events',
  'nutanix_alerts', 'nutanix_disks', 'nutanix_containers', 'nutanix_vms', 'nutanix_hosts',
  'nutanix_clusters', 'nutanix_move_events', 'nutanix_move_workloads', 'nutanix_move_plans',
  'nutanix_issue_history', 'nutanix_sources', 'nutanix_move_conns',
];

function seedNutanixDemo(coreApi) {
  const db = coreApi.db;
  return db.transaction(() => {
    for (const table of DEMO_TABLES) {
      const exists = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
      ).get(table);
      if (exists) db.exec(`DELETE FROM ${table}`);
    }
    return seedNutanix(db, { now: Date.now(), encrypt: coreApi.encryption.encrypt, coreApi });
  })();
}

module.exports = { seedNutanix, seedNutanixDemo };
