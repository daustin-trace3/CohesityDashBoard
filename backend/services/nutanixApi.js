// Nutanix API client: Prism Central (v3 lists + groups API, v4 probe-only)
// and Prism Element (v2.0 + v1 for VM stats/NCC). Blind build — every parser
// guards every field access; a malformed/missing field degrades to null
// rather than throwing, and every response body is treated as untrusted.
// Basic auth + session-cookie reuse (per source), calls serialized per
// source, back off + surface on HTTP 429 (contract decisions #2, #7).
const axios = require('axios');
const https = require('https');
const { decrypt } = require('./encryption');
const logger = require('../utils/logger');

const SESSION_TTL_MS = 20 * 60 * 1000;
const sessions = new Map(); // source.id -> { cookie, fetchedAt }
const queues = new Map(); // source.id -> Promise (serialization mutex)

// ── Credentials / client plumbing ───────────────────────────────────────────

function creds(source) {
  // Unsaved candidates (test connection) carry a plaintext password;
  // registered rows carry the encrypted blob.
  if (source.password != null) return { username: source.username, password: source.password };
  if (!source.encrypted_credentials) return { username: source.username, password: null };
  try {
    const c = JSON.parse(decrypt(source.encrypted_credentials));
    return { username: source.username, password: c.password };
  } catch {
    return { username: source.username, password: null };
  }
}

function baseUrl(source) {
  const port = source.port || 9440;
  return `https://${source.host}:${port}`;
}

function baseClient(source, headers = {}) {
  return axios.create({
    baseURL: baseUrl(source),
    timeout: 60000,
    headers,
    httpsAgent: new https.Agent({ rejectUnauthorized: !!source.ssl_verify }),
    validateStatus: (s) => s >= 200 && s < 300,
  });
}

/** Serializes async work per source id — Nutanix rate-limits aggressive fanout. */
function serialize(sourceId, fn) {
  const key = sourceId ?? '_';
  const prior = queues.get(key) || Promise.resolve();
  const next = prior.then(fn, fn);
  queues.set(key, next.catch(() => {}));
  return next;
}

async function withBackoff(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.response?.status === 429) {
      const retryAfter = Number(err.response.headers?.['retry-after']) || 2;
      logger.warn(`[NutanixApi] HTTP 429 — backing off ${retryAfter}s`);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return await fn();
    }
    throw err;
  }
}

/**
 * Issues an HTTP call against a source, reusing a cached session cookie when
 * present; falls back to Basic auth and re-caches whatever cookie comes back.
 * A 401 forces one re-auth attempt.
 */
async function request(source, { method = 'GET', path, params, data, headers = {} } = {}) {
  const sourceId = source.id ?? `test-${source.host}`;
  return serialize(sourceId, () => withBackoff(async () => {
    const { username, password } = creds(source);
    const cached = sessions.get(sourceId);
    const useCookie = cached && Date.now() - cached.fetchedAt < SESSION_TTL_MS;

    const doCall = async (withCookie) => {
      const reqHeaders = { ...headers };
      const opts = { method, url: path, params, data };
      if (withCookie && cached?.cookie) {
        reqHeaders.Cookie = cached.cookie;
      } else if (username && password) {
        opts.auth = { username, password };
      }
      const client = baseClient(source, reqHeaders);
      const res = await client.request(opts);
      const setCookie = res.headers?.['set-cookie'];
      if (setCookie && setCookie.length) {
        sessions.set(sourceId, { cookie: setCookie.map((c) => c.split(';')[0]).join('; '), fetchedAt: Date.now() });
      }
      return res.data;
    };

    try {
      return await doCall(useCookie);
    } catch (err) {
      if (err.response?.status === 401 && useCookie) {
        sessions.delete(sourceId);
        return await doCall(false);
      }
      throw err;
    }
  }));
}

function invalidateSession(sourceId) {
  sessions.delete(sourceId);
}

// ── Parsing helpers (failure-tolerant, per contract §6-7) ──────────────────

// Nutanix "-1" (or -1) is the not-available sentinel throughout v1/v2/v3.
function numOrNull(v) {
  if (v == null || v === '-1' || v === -1) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v) {
  return v == null ? null : String(v);
}

function boolToInt(v) {
  return v ? 1 : 0;
}

function usecsToIso(usecs) {
  const n = Number(usecs);
  if (!Number.isFinite(n) || n <= 0) return null;
  try {
    return new Date(n / 1000).toISOString();
  } catch {
    return null;
  }
}

function jsonOrNull(v) {
  try {
    return v == null ? null : JSON.stringify(v);
  } catch {
    return null;
  }
}

// Substitutes {placeholder} tokens in a Nutanix alert message template from
// its context_types/context_values (PE) or parameters map (PC v3).
function substituteTemplate(template, contextTypes, contextValues) {
  if (typeof template !== 'string') return template ?? null;
  if (!Array.isArray(contextTypes) || !Array.isArray(contextValues)) return template;
  let out = template;
  for (let i = 0; i < contextTypes.length; i++) {
    const key = contextTypes[i];
    const val = contextValues[i];
    if (key == null) continue;
    out = out.split(`{${key}}`).join(val != null ? String(val) : '');
  }
  return out;
}

const safeArr = (v) => (Array.isArray(v) ? v : []);

// ── Prism Element (v2.0 + v1) ───────────────────────────────────────────────

const PE_V2 = '/PrismGateway/services/rest/v2.0';
const PE_V1 = '/PrismGateway/services/rest/v1';

async function peGet(source, path, params) {
  return request(source, { method: 'GET', path: `${PE_V2}${path}`, params });
}
async function peV1Get(source, path, params) {
  return request(source, { method: 'GET', path: `${PE_V1}${path}`, params });
}

async function fetchPECluster(source) {
  const c = await peGet(source, '/cluster/');
  if (!c || typeof c !== 'object') return null;
  const stats = c.stats || {};
  const usage = c.usage_stats || {};
  let ft = null;
  try { ft = await fetchFaultTolerance(source); } catch { ft = null; }
  let ncc = null;
  try { ncc = await fetchNccSummary(source); } catch { ncc = null; }
  return {
    uuid: strOrNull(c.uuid),
    name: strOrNull(c.name),
    aosVersion: strOrNull(c.version),
    hypervisorTypes: jsonOrNull(safeArr(c.hypervisor_types)),
    numNodes: numOrNull(c.num_nodes),
    redundancyFactor: numOrNull(c.cluster_redundancy_state?.current_redundancy_factor),
    operationMode: strOrNull(c.operation_mode),
    externalIp: strOrNull(c.cluster_external_i_p_address),
    storageCapacityBytes: numOrNull(usage['storage.capacity_bytes']),
    storageUsageBytes: numOrNull(usage['storage.usage_bytes']),
    reductionRatioPpm: numOrNull(usage['data_reduction.saving_ratio_ppm']),
    overallReductionRatioPpm: numOrNull(usage['data_reduction.overall.saving_ratio_ppm']),
    cpuUsagePpm: numOrNull(stats.hypervisor_cpu_usage_ppm),
    memoryUsagePpm: numOrNull(stats.hypervisor_memory_usage_ppm),
    controllerIops: numOrNull(stats.controller_num_iops),
    controllerLatencyUsecs: numOrNull(stats.controller_avg_io_latency_usecs),
    ioBandwidthKbps: numOrNull(stats.controller_io_bandwidth_kBps ?? stats.io_bandwidth_kBps),
    runwayDays: null, // PE has no runway (NCM-licensed, PC-only)
    ftFailuresTolerable: ft ? ft.minFailuresTolerable : null,
    ftDetails: ft ? jsonOrNull(ft.components) : null,
    nccPass: ncc ? ncc.pass : null,
    nccWarn: ncc ? ncc.warn : null,
    nccFail: ncc ? ncc.fail : null,
    unprotectedVmCount: null, // filled by poller from /protection_domains/unprotected_vms
  };
}

async function fetchFaultTolerance(source) {
  const d = await peGet(source, '/cluster/domain_fault_tolerance_status/');
  const list = safeArr(d?.entities ?? d);
  if (!list.length) return null;
  let min = null;
  const components = [];
  for (const entry of list) {
    const n = numOrNull(entry.number_of_failures_tolerable ?? entry.current_fault_tolerance);
    if (n != null) min = min == null ? n : Math.min(min, n);
    components.push({
      domain: strOrNull(entry.domain_type ?? entry.fault_tolerance_domain_type),
      component: strOrNull(entry.component_type),
      failuresTolerable: n,
    });
  }
  return { minFailuresTolerable: min, components };
}

async function fetchNccSummary(source) {
  try {
    const d = await peV1Get(source, '/ncc/run_summary');
    if (!d || typeof d !== 'object') return null;
    return {
      pass: numOrNull(d.pass ?? d.numPassed ?? d.passCount) ?? 0,
      warn: numOrNull(d.warn ?? d.numWarnings ?? d.warnCount) ?? 0,
      fail: numOrNull(d.fail ?? d.numFailed ?? d.failCount) ?? 0,
    };
  } catch {
    return null;
  }
}

async function fetchPEHosts(source) {
  const d = await peGet(source, '/hosts/');
  return safeArr(d?.entities).map((h) => {
    const stats = h.stats || {};
    const usage = h.usage_stats || {};
    return {
      uuid: strOrNull(h.uuid),
      name: strOrNull(h.name),
      serial: strOrNull(h.serial),
      blockModel: strOrNull(h.block_model_name ?? h.block_model),
      blockSerial: strOrNull(h.block_serial),
      position: h.position ? jsonOrNull(h.position) : null,
      cpuModel: strOrNull(h.cpu_model),
      numCpuSockets: numOrNull(h.num_cpu_sockets),
      numCpuCores: numOrNull(h.num_cpu_cores),
      cpuCapacityHz: numOrNull(h.cpu_capacity_in_hz),
      memoryCapacityBytes: numOrNull(h.memory_capacity_in_bytes),
      hypervisorType: strOrNull(h.hypervisor_type),
      hypervisorVersion: strOrNull(h.hypervisor_full_name),
      hypervisorIp: strOrNull(h.hypervisor_address),
      cvmIp: strOrNull(h.controller_vm_backplane_ip ?? h.service_v_m_external_i_p),
      ipmiIp: strOrNull(h.ipmi_address),
      biosVersion: strOrNull(h.bios_version),
      bmcVersion: strOrNull(h.bmc_version),
      numVms: numOrNull(h.num_v_ms),
      state: strOrNull(h.state),
      maintenanceMode: boolToInt(h.host_in_maintenance_mode),
      isDegraded: boolToInt(h.is_degraded),
      bootTimeUsecs: numOrNull(h.boot_time_in_usecs),
      cpuUsagePpm: numOrNull(stats.hypervisor_cpu_usage_ppm),
      memoryUsagePpm: numOrNull(stats.hypervisor_memory_usage_ppm),
      disksJson: h.disk_hardware_configs ? jsonOrNull(h.disk_hardware_configs) : null,
      storageCapacityBytes: numOrNull(usage['storage.capacity_bytes']),
      storageUsageBytes: numOrNull(usage['storage.usage_bytes']),
    };
  });
}

async function fetchPEVms(source) {
  const d = await peGet(source, '/vms/', { include_vm_disk_config: true, include_vm_nic_config: true });
  return safeArr(d?.entities).map((v) => {
    const disks = safeArr(v.vm_disk_info);
    const nics = safeArr(v.vm_nics);
    return {
      uuid: strOrNull(v.uuid),
      name: strOrNull(v.name),
      powerState: strOrNull(v.power_state),
      numVcpus: numOrNull(v.num_vcpus),
      memoryMb: numOrNull(v.memory_mb),
      hostUuid: strOrNull(v.host_uuid),
      hostName: null, // resolved by poller from the host map
      ipAddresses: jsonOrNull(nics.map((n) => n.ip_address).filter(Boolean)),
      ngtStatus: strOrNull(v.tools_running_status ?? v.nutanix_guest_tools?.state),
      guestOs: strOrNull(v.guest_operating_system),
      diskCount: disks.length,
      diskBytes: disks.reduce((s, d2) => s + (numOrNull(d2.size) || 0), 0) || null,
      categories: null,
      cpuUsagePpm: null,
      memoryUsagePpm: null,
      controllerIops: null,
      latencyUsecs: null,
    };
  });
}

// v1 per-VM stats — best-effort, PE only supplies stats this way.
async function fetchPEVmStats(source) {
  try {
    const d = await peV1Get(source, '/vms/');
    const map = new Map();
    for (const v of safeArr(d?.entities)) {
      const stats = v.stats || {};
      map.set(strOrNull(v.uuid), {
        cpuUsagePpm: numOrNull(stats.hypervisor_cpu_usage_ppm),
        memoryUsagePpm: numOrNull(stats?.guest?.memory_usage_ppm ?? stats['guest.memory_usage_ppm'] ?? stats.memory_usage_ppm),
        controllerIops: numOrNull(stats.controller_num_iops),
        latencyUsecs: numOrNull(stats.controller_avg_io_latency_usecs),
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

async function fetchPEContainers(source) {
  const d = await peGet(source, '/storage_containers/');
  return safeArr(d?.entities).map((c) => {
    const usage = c.usage_stats || {};
    return {
      uuid: strOrNull(c.storage_container_uuid ?? c.id),
      name: strOrNull(c.name),
      replicationFactor: numOrNull(c.replication_factor),
      compressionEnabled: boolToInt(c.compression_enabled),
      dedupEnabled: c.on_disk_dedup && c.on_disk_dedup !== 'OFF' ? 1 : 0,
      erasureCode: strOrNull(c.erasure_code),
      capacityBytes: numOrNull(usage['storage.capacity_bytes']),
      usageBytes: numOrNull(usage['storage.usage_bytes']),
      freeBytes: numOrNull(usage['storage.free_bytes']),
      reductionRatioPpm: numOrNull(usage['data_reduction.saving_ratio_ppm']),
    };
  });
}

async function fetchPEDisks(source) {
  const d = await peGet(source, '/disks/');
  return safeArr(d?.entities).map((disk) => {
    const usage = disk.usage_stats || {};
    const hw = disk.disk_hardware_config || {};
    return {
      diskUuid: strOrNull(disk.disk_uuid),
      serial: strOrNull(hw.serial_number),
      model: strOrNull(hw.model),
      vendor: strOrNull(hw.vendor),
      tier: strOrNull(disk.storage_tier_name),
      sizeBytes: numOrNull(disk.disk_size),
      usageBytes: numOrNull(usage['storage.usage_bytes']),
      online: boolToInt(disk.online),
      status: strOrNull(disk.disk_status),
      bad: boolToInt(hw.bad),
      hostName: strOrNull(disk.host_name),
      firmware: strOrNull(hw.current_firmware_version),
    };
  });
}

async function fetchPEAlerts(source) {
  const d = await peGet(source, '/alerts/', { count: 500, resolved: false });
  return safeArr(d?.entities).map((a) => {
    const sev = String(a.severity || '').replace(/^k/, '').toLowerCase();
    return {
      alertUuid: strOrNull(a.id),
      severity: sev === 'critical' ? 'critical' : sev === 'warning' ? 'warning' : 'info',
      title: strOrNull(a.alert_title),
      message: substituteTemplate(a.message, a.context_types, a.context_values),
      entityType: strOrNull(a.affected_entities?.[0]?.entity_type),
      entityName: strOrNull(a.affected_entities?.[0]?.entity_name),
      acknowledged: boolToInt(a.acknowledged),
      resolved: boolToInt(a.resolved),
      createdUsecs: numOrNull(a.created_time_stamp_in_usecs),
    };
  });
}

async function fetchPEEvents(source, sinceUsecs) {
  const d = await peGet(source, '/events/', { count: 500, start_time_in_usecs: sinceUsecs });
  return safeArr(d?.entities).map((e) => ({
    message: strOrNull(e.message ?? e.default_message),
    entityType: strOrNull(e.affected_entities?.[0]?.entity_type),
    entityName: strOrNull(e.affected_entities?.[0]?.entity_name),
    createdUsecs: numOrNull(e.created_time_stamp_in_usecs),
  }));
}

async function fetchPEPds(source) {
  const d = await peGet(source, '/protection_domains/');
  return safeArr(d?.entities).map((pd) => ({
    name: strOrNull(pd.name),
    active: boolToInt(pd.active),
    vmCount: safeArr(pd.vms).length,
    remoteSites: jsonOrNull(safeArr(pd.remote_site_names)),
    nextSnapshotUsecs: numOrNull(pd.next_snapshot_time_usecs),
    pendingReplications: numOrNull(pd.pending_replication_count) ?? 0,
    ongoingReplications: numOrNull(pd.ongoing_replication_count) ?? 0,
    txBandwidthKbps: numOrNull(pd.stats?.replication_transmitted_bandwidth_kBps),
    exclusiveSnapshotBytes: numOrNull(pd.usage_stats?.['dr.exclusive_snapshot_usage_bytes']),
    schedulesJson: jsonOrNull(safeArr(pd.cron_schedules)),
  }));
}

async function fetchPEReplications(source) {
  const d = await peGet(source, '/protection_domains/replications/');
  return safeArr(d?.entities).map((r) => ({
    replicationId: strOrNull(r.id),
    pdName: strOrNull(r.protection_domain_name),
    remoteSite: strOrNull(r.remote_site_name),
    snapshotId: strOrNull(r.snapshot_id),
    completedPercentage: r.completed_percentage != null ? Number(r.completed_percentage) : null,
    completedBytes: numOrNull(r.completed_bytes),
    etaSecs: numOrNull(r.replication_time_to_complete_secs),
    startUsecs: numOrNull(r.start_replication_time_usecs),
    paused: boolToInt(r.paused),
  }));
}

async function fetchPERemoteSites(source) {
  const d = await peGet(source, '/remote_sites/');
  return safeArr(d?.entities).map((rs) => ({
    name: strOrNull(rs.name),
    status: strOrNull(rs.status),
    latencyUsecs: numOrNull(rs.latency_in_usecs),
    capabilities: jsonOrNull(safeArr(rs.capabilities)),
    txBandwidthKbps: numOrNull(rs.stats?.replication_transmitted_bandwidth_kBps),
  }));
}

async function fetchPEUnprotectedVmCount(source) {
  try {
    const d = await peGet(source, '/protection_domains/unprotected_vms/');
    return safeArr(d?.entities).length;
  } catch {
    return null;
  }
}

async function fetchPESnapshots(source) {
  try {
    const d = await peGet(source, '/protection_domains/dr_snapshots/');
    return safeArr(d?.entities).map((s) => ({
      kind: 'pd_snapshot',
      pdName: strOrNull(s.protection_domain_name),
      vmUuid: null,
      vmName: null,
      createdAtTs: usecsToIso(s.snapshot_create_time_usecs),
      expiresAtTs: usecsToIso(s.snapshot_expiry_time_usecs),
      location: strOrNull(s.located_remote_site_name) || 'local',
      sizeBytes: numOrNull(s.size_in_bytes),
    }));
  } catch {
    return [];
  }
}

// ── Prism Central (v3 + groups) ─────────────────────────────────────────────

const PC_V3 = '/api/nutanix/v3';

async function pcPost(source, path, body) {
  return request(source, { method: 'POST', path: `${PC_V3}${path}`, data: body });
}

async function fetchPCClustersRaw(source, length = 100) {
  const d = await pcPost(source, '/clusters/list', { kind: 'cluster', length });
  return safeArr(d?.entities).filter((c) => !safeArr(c.status?.resources?.config?.service_list).includes('PRISM_CENTRAL'));
}

async function fetchGroupsClusterStats(source) {
  const body = {
    entity_type: 'cluster',
    group_member_count: 100,
    group_member_offset: 0,
    group_member_attributes: [
      { attribute: 'cluster_name' },
      { attribute: 'hypervisor_cpu_usage_ppm' },
      { attribute: 'hypervisor_memory_usage_ppm' },
      { attribute: 'controller_num_iops' },
      { attribute: 'controller_avg_io_latency_usecs' },
      { attribute: 'controller_io_bandwidth_kBps' },
      { attribute: 'storage.capacity_bytes' },
      { attribute: 'storage.usage_bytes' },
      { attribute: 'data_reduction.saving_ratio_ppm' },
      { attribute: 'data_reduction.overall.saving_ratio_ppm' },
      { attribute: 'capacity.runway' },
    ],
  };
  const d = await request(source, { method: 'POST', path: `${PC_V3}/groups`, data: body });
  const out = new Map(); // uuid -> stats
  for (const group of safeArr(d?.group_results)) {
    for (const entity of safeArr(group.entity_results)) {
      const uuid = strOrNull(entity.entity_id);
      const values = {};
      for (const attr of safeArr(entity.data)) {
        const v = attr.values?.[0]?.values?.[0];
        values[attr.name] = v;
      }
      out.set(uuid, {
        cpuUsagePpm: numOrNull(values.hypervisor_cpu_usage_ppm),
        memoryUsagePpm: numOrNull(values.hypervisor_memory_usage_ppm),
        controllerIops: numOrNull(values.controller_num_iops),
        controllerLatencyUsecs: numOrNull(values.controller_avg_io_latency_usecs),
        ioBandwidthKbps: numOrNull(values['controller_io_bandwidth_kBps']),
        storageCapacityBytes: numOrNull(values['storage.capacity_bytes']),
        storageUsageBytes: numOrNull(values['storage.usage_bytes']),
        reductionRatioPpm: numOrNull(values['data_reduction.saving_ratio_ppm']),
        overallReductionRatioPpm: numOrNull(values['data_reduction.overall.saving_ratio_ppm']),
        runwayDays: numOrNull(values['capacity.runway']),
      });
    }
  }
  return out;
}

async function fetchPCClusters(source) {
  const raw = await fetchPCClustersRaw(source);
  let statsMap = new Map();
  try { statsMap = await fetchGroupsClusterStats(source); } catch (err) {
    logger.debug(`[NutanixApi] PC groups cluster stats failed for ${source.name}: ${err.message}`);
  }
  return raw.map((c) => {
    const uuid = strOrNull(c.metadata?.uuid);
    const stats = statsMap.get(uuid) || {};
    const resources = c.status?.resources || {};
    return {
      uuid,
      name: strOrNull(c.status?.name),
      aosVersion: strOrNull(resources.config?.software_map?.NOS?.version),
      hypervisorTypes: jsonOrNull(safeArr(resources.nodes?.hypervisor_server_list).map((h) => h.type).filter(Boolean)),
      numNodes: safeArr(resources.nodes?.hypervisor_server_list).length || null,
      redundancyFactor: numOrNull(resources.config?.redundancy_factor),
      operationMode: null,
      externalIp: strOrNull(resources.network?.external_ip),
      storageCapacityBytes: stats.storageCapacityBytes ?? null,
      storageUsageBytes: stats.storageUsageBytes ?? null,
      reductionRatioPpm: stats.reductionRatioPpm ?? null,
      overallReductionRatioPpm: stats.overallReductionRatioPpm ?? null,
      cpuUsagePpm: stats.cpuUsagePpm ?? null,
      memoryUsagePpm: stats.memoryUsagePpm ?? null,
      controllerIops: stats.controllerIops ?? null,
      controllerLatencyUsecs: stats.controllerLatencyUsecs ?? null,
      ioBandwidthKbps: stats.ioBandwidthKbps ?? null,
      runwayDays: stats.runwayDays ?? null,
      ftFailuresTolerable: null, // no PC-wide fault-tolerance groups attribute; PE-only signal
      ftDetails: null,
      nccPass: null,
      nccWarn: null,
      nccFail: null,
      unprotectedVmCount: null,
    };
  });
}

async function fetchPCHosts(source) {
  const d = await pcPost(source, '/hosts/list', { kind: 'host', length: 500 });
  return safeArr(d?.entities).map((h) => {
    const r = h.status?.resources || {};
    return {
      uuid: strOrNull(h.metadata?.uuid),
      clusterUuid: strOrNull(r.cluster_reference?.uuid) || strOrNull(h.status?.cluster_reference?.uuid),
      name: strOrNull(h.status?.name),
      serial: strOrNull(r.serial_number),
      blockModel: strOrNull(r.block?.block_model),
      blockSerial: strOrNull(r.block?.block_serial_number),
      position: null,
      cpuModel: strOrNull(r.cpu_model),
      numCpuSockets: numOrNull(r.num_cpu_sockets),
      numCpuCores: numOrNull(r.num_cpu_cores),
      cpuCapacityHz: numOrNull(r.cpu_capacity_hz),
      memoryCapacityBytes: numOrNull(r.memory_capacity_mib) != null ? numOrNull(r.memory_capacity_mib) * 1024 * 1024 : null,
      hypervisorType: strOrNull(r.host_type),
      hypervisorVersion: strOrNull(r.hypervisor?.hypervisor_full_name),
      hypervisorIp: strOrNull(r.hypervisor?.ip),
      cvmIp: strOrNull(r.controller_vm?.ip),
      ipmiIp: strOrNull(r.ipmi?.ip),
      biosVersion: null,
      bmcVersion: null,
      numVms: null,
      state: null,
      maintenanceMode: 0,
      isDegraded: 0,
      bootTimeUsecs: null,
      cpuUsagePpm: null,
      memoryUsagePpm: null,
      disksJson: safeArr(r.host_disks_reference_list).length ? jsonOrNull(r.host_disks_reference_list) : null,
    };
  });
}

async function fetchPCVms(source) {
  const d = await pcPost(source, '/vms/list', { kind: 'vm', length: 500 });
  return safeArr(d?.entities).map((v) => {
    const r = v.status?.resources || {};
    const nics = safeArr(r.nic_list);
    const ips = nics.flatMap((n) => safeArr(n.ip_endpoint_list).map((e) => e.ip)).filter(Boolean);
    const disks = safeArr(r.disk_list);
    return {
      uuid: strOrNull(v.metadata?.uuid),
      clusterUuid: strOrNull(v.status?.cluster_reference?.uuid),
      clusterName: strOrNull(v.status?.cluster_reference?.name),
      name: strOrNull(v.status?.name),
      powerState: strOrNull(r.power_state),
      numVcpus: r.num_sockets != null && r.num_vcpus_per_socket != null
        ? numOrNull(r.num_sockets) * numOrNull(r.num_vcpus_per_socket) : null,
      memoryMb: numOrNull(r.memory_size_mib),
      hostUuid: strOrNull(r.host_reference?.uuid),
      hostName: strOrNull(r.host_reference?.name),
      ipAddresses: jsonOrNull(ips),
      ngtStatus: strOrNull(r.guest_tools?.nutanix_guest_tools?.state),
      guestOs: strOrNull(r.guest_tools?.nutanix_guest_tools?.guest_os_version),
      diskCount: disks.length,
      diskBytes: disks.reduce((s, d2) => s + (numOrNull(d2.disk_size_bytes) || 0), 0) || null,
      categories: v.metadata?.categories ? jsonOrNull(v.metadata.categories) : null,
    };
  });
}

async function fetchGroupsVmStats(source) {
  const body = {
    entity_type: 'mh_vm',
    group_member_count: 500,
    group_member_offset: 0,
    group_member_attributes: [
      { attribute: 'vm_name' },
      { attribute: 'hypervisor_cpu_usage_ppm' },
      { attribute: 'memory_usage_ppm' },
      { attribute: 'controller_num_iops' },
      { attribute: 'controller_avg_io_latency_usecs' },
    ],
  };
  const d = await request(source, { method: 'POST', path: `${PC_V3}/groups`, data: body });
  const out = new Map();
  for (const group of safeArr(d?.group_results)) {
    for (const entity of safeArr(group.entity_results)) {
      const uuid = strOrNull(entity.entity_id);
      const values = {};
      for (const attr of safeArr(entity.data)) values[attr.name] = attr.values?.[0]?.values?.[0];
      out.set(uuid, {
        cpuUsagePpm: numOrNull(values.hypervisor_cpu_usage_ppm),
        memoryUsagePpm: numOrNull(values.memory_usage_ppm),
        controllerIops: numOrNull(values.controller_num_iops),
        latencyUsecs: numOrNull(values.controller_avg_io_latency_usecs),
      });
    }
  }
  return out;
}

async function fetchPCAlerts(source) {
  const d = await pcPost(source, '/alerts/list', { kind: 'alert', length: 250, filter: 'resolved==false' });
  return safeArr(d?.entities).map((a) => {
    const r = a.status?.resources || {};
    const sev = String(r.severity || '').toLowerCase();
    return {
      alertUuid: strOrNull(a.metadata?.uuid),
      clusterUuid: strOrNull(r.source_entity?.entity?.uuid),
      clusterName: strOrNull(r.source_entity?.entity?.name),
      severity: sev === 'critical' ? 'critical' : sev === 'warning' ? 'warning' : 'info',
      title: strOrNull(r.title),
      message: substituteTemplate(r.default_message, Object.keys(r.parameters || {}), Object.values(r.parameters || {}).map((p) => p?.string_value ?? p)),
      entityType: strOrNull(r.source_entity?.entity?.type),
      entityName: strOrNull(r.source_entity?.entity?.name),
      acknowledged: boolToInt(r.acknowledged_status?.is_true),
      resolved: boolToInt(r.resolution_status?.is_true),
      createdUsecs: usecsFromIso(r.latest_occurrence_time),
    };
  });
}

function usecsFromIso(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms * 1000 : null;
}

async function fetchPCEvents(source, sinceIso) {
  try {
    const d = await pcPost(source, '/events/list', { kind: 'event', length: 250 });
    return safeArr(d?.entities).map((e) => {
      const r = e.status?.resources || {};
      return {
        message: strOrNull(r.message ?? r.default_message),
        clusterUuid: strOrNull(r.source_entity?.entity?.uuid),
        entityType: strOrNull(r.source_entity?.entity?.type),
        entityName: strOrNull(r.source_entity?.entity?.name),
        createdUsecs: usecsFromIso(r.creation_time) ?? usecsFromIso(e.metadata?.creation_time),
      };
    });
  } catch {
    return [];
  }
}

async function fetchPCPolicies(source) {
  const d = await pcPost(source, '/protection_rules/list', { kind: 'protection_rule', length: 250 });
  return safeArr(d?.entities).map((p) => {
    const r = p.status?.resources || p.spec?.resources || {};
    const schedules = safeArr(r.availability_zone_connectivity_list).flatMap((az) => safeArr(az.snapshot_schedule_list));
    const rpo = schedules.map((s) => numOrNull(s.recovery_point_objective_secs)).filter((n) => n != null);
    return {
      uuid: strOrNull(p.metadata?.uuid),
      name: strOrNull(p.status?.name ?? p.spec?.name),
      rpoSecs: rpo.length ? Math.min(...rpo) : null,
      remoteTargetsJson: jsonOrNull(safeArr(r.availability_zone_connectivity_list)),
      categoriesJson: r.category_filter ? jsonOrNull(r.category_filter) : null,
    };
  });
}

async function fetchPCRecoveryPoints(source) {
  const d = await pcPost(source, '/vm_recovery_points/list', { kind: 'vm_recovery_point', length: 500 });
  return safeArr(d?.entities).map((rp) => {
    const r = rp.status?.resources || {};
    return {
      kind: 'recovery_point',
      pdName: null,
      vmUuid: strOrNull(r.parent_vm_reference?.uuid),
      vmName: strOrNull(r.parent_vm_reference?.name),
      createdAtTs: strOrNull(r.creation_time),
      expiresAtTs: strOrNull(r.expiration_time),
      location: strOrNull(r.location_agnostic_uuid) ? 'PC' : null,
      sizeBytes: null,
    };
  });
}

// v4 GA probe — record what's discoverable but v3 remains the poll path
// (contract #1 / prism-central.md §1 recommendation).
async function fetchV4Probe(source) {
  const d = await request(source, { method: 'GET', path: '/api/clustermgmt/v4.0/config/clusters', params: { '$limit': 5 } });
  return safeArr(d?.data);
}

// ── Connection test ─────────────────────────────────────────────────────────

async function testConnection(sourceLike) {
  try {
    if (sourceLike.source_type === 'prism_central' || sourceLike.sourceType === 'prism_central') {
      const raw = await fetchPCClustersRaw(sourceLike, 5);
      let v4 = false;
      try { await fetchV4Probe(sourceLike); v4 = true; } catch { v4 = false; }
      return { ok: true, apiFlavor: v4 ? 'v3+v4' : 'v3', productVersion: strOrNull(raw[0]?.status?.resources?.config?.software_map?.NOS?.version) || null, clusterCount: raw.length };
    }
    const cluster = await peGet(sourceLike, '/cluster/');
    return { ok: true, apiFlavor: 'v2.0', productVersion: strOrNull(cluster?.version) || null };
  } catch (err) {
    const status = err.response?.status;
    return {
      ok: false,
      error: status === 401 ? 'Authentication failed — check the Nutanix username and password.'
        : status === 429 ? 'Rate limited by Nutanix — try again shortly.'
        : (err.response?.data?.message || err.message),
    };
  } finally {
    invalidateSession(sourceLike.id ?? `test-${sourceLike.host}`);
  }
}

module.exports = {
  // session/testing
  invalidateSession, testConnection,
  // PE
  fetchPECluster, fetchFaultTolerance, fetchNccSummary, fetchPEHosts, fetchPEVms, fetchPEVmStats,
  fetchPEContainers, fetchPEDisks, fetchPEAlerts, fetchPEEvents, fetchPEPds, fetchPEReplications,
  fetchPERemoteSites, fetchPEUnprotectedVmCount, fetchPESnapshots,
  // PC
  fetchPCClusters, fetchGroupsClusterStats, fetchPCHosts, fetchPCVms, fetchGroupsVmStats,
  fetchPCAlerts, fetchPCEvents, fetchPCPolicies, fetchPCRecoveryPoints, fetchV4Probe,
  // helpers (exported for the poller/tests)
  numOrNull, strOrNull, usecsToIso,
};
