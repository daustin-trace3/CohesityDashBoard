'use strict';

// Built-in vCenter observers: CPU and memory of powered-on VMs and connected
// ESX hosts, read from the tables the vCenter poller already fills. The
// percent formulas are the ones routes/vcenter.js shows on the inventory
// pages (withVmPerfPct), so the agent and the page never disagree.

const round1 = (n) => Math.round(n * 10) / 10;

/** The zoneless SQLite UTC stamp vCenter keeps ("2026-10-22 18:00:00") as ISO. */
function isoOf(sqliteStamp) {
  if (!sqliteStamp) return null;
  const s = String(sqliteStamp);
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Read one threshold pair from settings. Crit is clamped up to warn. */
function readPair(getSetting, warnKey, critKey, defWarn, defCrit, max) {
  const read = (key, def) => {
    const raw = getSetting(key);
    if (raw == null || String(raw).trim() === '') return def;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1 && n <= max ? Math.round(n) : def;
  };
  const warn = read(warnKey, defWarn);
  const crit = Math.max(warn, read(critKey, defCrit));
  return { warn, crit };
}

// Keys, defaults and limits, shared with the vCenter config route.
const KEYS = {
  vmCpu: { warnKey: 'vcenter_vm_cpu_warn_pct', critKey: 'vcenter_vm_cpu_crit_pct', warn: 90, crit: 100, max: 200 },
  vmMem: { warnKey: 'vcenter_vm_mem_warn_pct', critKey: 'vcenter_vm_mem_crit_pct', warn: 90, crit: 95, max: 100 },
  hostCpu: { warnKey: 'vcenter_host_cpu_warn_pct', critKey: 'vcenter_host_cpu_crit_pct', warn: 85, crit: 95, max: 200 },
  hostMem: { warnKey: 'vcenter_host_mem_warn_pct', critKey: 'vcenter_host_mem_crit_pct', warn: 85, crit: 95, max: 100 },
};
const pairOf = (getSetting, k) => readPair(getSetting, k.warnKey, k.critKey, k.warn, k.crit, k.max);

const fmtGb = (mb) => {
  const gb = mb / 1024;
  return Number.isInteger(gb) ? String(gb) : gb.toFixed(1);
};

// Only vCenters whose last poll succeeded are sampled: an errored poll leaves
// the old rows in place, and re-reading them would count as fresh samples.
const VM_SQL = `
  SELECT m.name, m.vcenter_id, m.cluster_name, m.host_name, m.power_state, m.cpu_count, m.memory_mb,
         m.cpu_usage_mhz, m.mem_usage_mb,
         h.cpu_mhz_capacity AS host_cpu_mhz_capacity, h.cpu_cores AS host_cpu_cores,
         v.name AS vcenter_name, v.last_poll_at
  FROM vcenter_vms m
  JOIN vcenter_vcenters v ON v.id = m.vcenter_id
  LEFT JOIN vcenter_hosts h ON h.vcenter_id = m.vcenter_id AND h.name = m.host_name
  WHERE v.last_poll_status = 'success' AND m.power_state = 'POWERED_ON'
`;

const HOST_SQL = `
  SELECT h.name, h.vcenter_id, h.cluster_name, h.connection_state, h.in_maintenance, h.cpu_cores,
         h.cpu_mhz_capacity, h.cpu_mhz_used, h.mem_bytes_capacity, h.mem_bytes_used,
         v.name AS vcenter_name, v.last_poll_at
  FROM vcenter_hosts h
  JOIN vcenter_vcenters v ON v.id = h.vcenter_id
  WHERE v.last_poll_status = 'success'
`;

function vmSamples(db, pick) {
  const out = [];
  for (const r of db.prepare(VM_SQL).all()) {
    const capturedAt = isoOf(r.last_poll_at);
    if (!capturedAt || !r.name) continue;
    const s = pick(r);
    if (s == null) continue;
    out.push({
      subjectKey: `vcenter:${r.vcenter_id}:vm:${r.name}`, label: r.name, host: r.name,
      sourceId: r.vcenter_id, sourceName: r.vcenter_name, value: s.value, capturedAt,
      context: { cluster: r.cluster_name || null, esxHost: r.host_name || null, ...s.context },
    });
  }
  return out;
}

function hostSamples(db, pick) {
  const out = [];
  for (const r of db.prepare(HOST_SQL).all()) {
    const capturedAt = isoOf(r.last_poll_at);
    if (!capturedAt || !r.name) continue;
    if (r.connection_state && String(r.connection_state).toLowerCase() !== 'connected') continue;
    if (r.in_maintenance === 1) continue;
    const s = pick(r);
    if (s == null) continue;
    out.push({
      subjectKey: `vcenter:${r.vcenter_id}:host:${r.name}`, label: r.name, host: r.name,
      sourceId: r.vcenter_id, sourceName: r.vcenter_name, value: s.value, capturedAt,
      context: { cluster: r.cluster_name || null, ...s.context },
    });
  }
  return out;
}

const vmCpu = (r) => {
  const perCore = r.host_cpu_mhz_capacity && r.host_cpu_cores ? r.host_cpu_mhz_capacity / r.host_cpu_cores : null;
  const capacity = perCore && r.cpu_count ? perCore * r.cpu_count : null;
  if (r.cpu_usage_mhz == null || !capacity) return null;
  return { value: round1((r.cpu_usage_mhz / capacity) * 100), context: { cpuCount: r.cpu_count, usageMhz: r.cpu_usage_mhz } };
};
const vmMem = (r) => {
  if (r.mem_usage_mb == null || !r.memory_mb) return null;
  return { value: round1((r.mem_usage_mb / r.memory_mb) * 100), context: { memoryMb: r.memory_mb, usageMb: r.mem_usage_mb } };
};
const hostCpu = (r) => {
  if (r.cpu_mhz_used == null || !r.cpu_mhz_capacity) return null;
  return { value: round1((r.cpu_mhz_used / r.cpu_mhz_capacity) * 100), context: { cpuCores: r.cpu_cores || null } };
};
const hostMem = (r) => {
  if (r.mem_bytes_used == null || !r.mem_bytes_capacity) return null;
  return { value: round1((r.mem_bytes_used / r.mem_bytes_capacity) * 100), context: { memoryMb: Math.round(r.mem_bytes_capacity / 1048576) } };
};

module.exports = {
  KEYS, pairOf, isoOf,
  observers: [
    {
      id: 'vcenter:vm-cpu', platform: 'vcenter', label: 'VM CPU', unit: '%', kind: 'sustained',
      issueType: 'vm-cpu-hot', noun: 'VM', metric: 'CPU',
      description: 'CPU use of a powered-on VM as a percent of its own vCPU allocation, from vCenter quick stats each poll.',
      thresholds: (getSetting) => pairOf(getSetting, KEYS.vmCpu),
      sample: (db) => vmSamples(db, vmCpu),
      capacity: (c) => (c.cpuCount ? `${c.cpuCount} vCPU` : null),
    },
    {
      id: 'vcenter:vm-memory', platform: 'vcenter', label: 'VM memory', unit: '%', kind: 'sustained',
      issueType: 'vm-memory-hot', noun: 'VM', metric: 'memory',
      description: 'Guest memory use of a powered-on VM as a percent of its configured memory, from vCenter quick stats each poll.',
      thresholds: (getSetting) => pairOf(getSetting, KEYS.vmMem),
      sample: (db) => vmSamples(db, vmMem),
      capacity: (c) => (c.memoryMb ? `${fmtGb(c.memoryMb)} GB` : null),
    },
    {
      id: 'vcenter:host-cpu', platform: 'vcenter', label: 'ESX host CPU', unit: '%', kind: 'sustained',
      issueType: 'host-cpu-hot', noun: 'ESX host', metric: 'CPU',
      description: 'CPU use of a connected ESX host (not in maintenance) as a percent of its total MHz, from vCenter quick stats each poll.',
      thresholds: (getSetting) => pairOf(getSetting, KEYS.hostCpu),
      sample: (db) => hostSamples(db, hostCpu),
      capacity: (c) => (c.cpuCores ? `${c.cpuCores} cores` : null),
    },
    {
      id: 'vcenter:host-memory', platform: 'vcenter', label: 'ESX host memory', unit: '%', kind: 'sustained',
      issueType: 'host-memory-hot', noun: 'ESX host', metric: 'memory',
      description: 'Memory use of a connected ESX host (not in maintenance) as a percent of its physical memory, from vCenter quick stats each poll.',
      thresholds: (getSetting) => pairOf(getSetting, KEYS.hostMem),
      sample: (db) => hostSamples(db, hostMem),
      capacity: (c) => (c.memoryMb ? `${fmtGb(c.memoryMb)} GB` : null),
    },
  ],
};
