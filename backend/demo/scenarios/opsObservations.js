// Ops Agent observations story for the demo. The rows are real engine output:
// each subject's samples are replayed through agentObservations.ingest with
// capturedAt stepping 15 minutes, so the states, outcomes and series match
// what the live tick would have produced. Subjects (five, picked from the
// vCenter rows the generator already wrote):
//   - a VM with a CPU episode that is critical now (118%, peak 124%, 10 samples)
//   - a VM with a memory episode that is degrading (93%, promoted 30 min ago)
//   - a VM with a CPU episode still watching (2 elevated samples, not promoted)
//   - a VM with four closed one-off CPU bursts in the last 7 days (in pattern)
//   - an ESX host with a memory episode that closed yesterday (sustained, 90 min)
// The matching vcenter_vms / vcenter_hosts usage columns are set so the
// inventory pages agree with the episodes. The seed does not open incidents;
// the agent's own tick does that from the promoted episodes.
// Re-runnable: it deletes the observer rows for these four observers first.
const STEP_MS = 15 * 60 * 1000;
const PREFERRED = { cpuCritical: 'app-db-01', memDegrading: 'web-02', cpuWatching: 'batch-01', cpuPattern: 'report-01' };
const OBSERVER_IDS = ['vcenter:vm-cpu', 'vcenter:vm-memory', 'vcenter:host-cpu', 'vcenter:host-memory'];
const SETTINGS = { enabled: true, sustainSamples: 3, clearSamples: 2, patternMin: 3, patternDays: 7, historyDays: 90, disabledIds: [] };

function pickVms(db) {
  const rows = db.prepare(`
    SELECT v.vcenter_id, v.name, v.host_name, v.cluster_name, v.cpu_count, v.memory_mb,
           h.cpu_mhz_capacity, h.cpu_cores, vc.name AS vcenter_name
      FROM vcenter_vms v
      JOIN vcenter_hosts h ON h.vcenter_id = v.vcenter_id AND h.name = v.host_name
      JOIN vcenter_vcenters vc ON vc.id = v.vcenter_id
     WHERE UPPER(v.power_state) = 'POWERED_ON' AND v.cpu_count > 0 AND v.memory_mb > 0
       AND h.cpu_cores > 0 AND h.cpu_mhz_capacity > 0
     ORDER BY v.name, v.vcenter_id`).all();
  const used = new Set();
  const take = (preferred) => {
    let row = rows.find((r) => r.name === preferred && !used.has(r.name));
    if (!row) row = rows.find((r) => !used.has(r.name));
    if (row) used.add(row.name);
    return row;
  };
  return {
    cpuCritical: take(PREFERRED.cpuCritical),
    memDegrading: take(PREFERRED.memDegrading),
    cpuWatching: take(PREFERRED.cpuWatching),
    cpuPattern: take(PREFERRED.cpuPattern),
  };
}

function pickHost(db) {
  return db.prepare(`
    SELECT h.vcenter_id, h.name, h.cluster_name, h.cpu_cores, h.mem_bytes_capacity, vc.name AS vcenter_name
      FROM vcenter_hosts h JOIN vcenter_vcenters vc ON vc.id = h.vcenter_id
     WHERE LOWER(h.connection_state) = 'connected' AND h.in_maintenance = 0 AND h.mem_bytes_capacity > 0
     ORDER BY (h.name = 'demo-esx-03') DESC, h.name, h.vcenter_id LIMIT 1`).get();
}

// values[i] is the sample at (endMs - (n - 1 - i) * STEP_MS) unless times is given.
function stepped(values, endMs) {
  return values.map((v, i) => ({ value: v, ms: endMs - (values.length - 1 - i) * STEP_MS }));
}

function vmSamples(vm, kind, series) {
  const memory = kind === 'mem';
  return series.map((s) => ({
    subjectKey: `vcenter:${vm.vcenter_id}:vm:${vm.name}`,
    label: vm.name,
    host: vm.name,
    sourceId: vm.vcenter_id,
    sourceName: vm.vcenter_name,
    value: s.value,
    capturedAt: new Date(s.ms).toISOString(),
    context: memory
      ? { cluster: vm.cluster_name, esxHost: vm.host_name, memoryMb: vm.memory_mb, cpuCount: vm.cpu_count }
      : { cluster: vm.cluster_name, esxHost: vm.host_name, cpuCount: vm.cpu_count, memoryMb: vm.memory_mb },
  }));
}

function replay(observer, samples, settings, getSetting, engine) {
  const thresholds = observer.thresholds(getSetting);
  for (const sample of samples) {
    engine.ingest(observer, [sample], sample.capturedAt, settings, thresholds);
  }
}

function applyOpsObservations(db, { now = Date.now() } = {}) {
  const tableOk = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ops_observations'").get();
  if (!tableOk) return { applied: false, reason: 'ops_observations table missing' };

  // Lazy requires: the engine pulls in the db module and the registry.
  const engine = require('../../services/agentObservations');
  const { getSetting } = require('../../services/settings');
  engine.registerBuiltins();
  const cpu = engine.getObserver('vcenter:vm-cpu');
  const mem = engine.getObserver('vcenter:vm-memory');
  const hostMem = engine.getObserver('vcenter:host-memory');
  if (!cpu || !mem || !hostMem) return { applied: false, reason: 'vcenter observers not registered' };

  const vms = pickVms(db);
  const host = pickHost(db);
  if (!vms.cpuCritical || !vms.memDegrading || !vms.cpuWatching || !vms.cpuPattern || !host) {
    return { applied: false, reason: 'not enough powered-on VMs or connected hosts' };
  }

  const ph = OBSERVER_IDS.map(() => '?').join(',');
  db.prepare(`DELETE FROM ops_observations WHERE observer_id IN (${ph})`).run(...OBSERVER_IDS);

  const end = Math.floor(now / STEP_MS) * STEP_MS;

  // 1. CPU critical: elevated, two severe samples promote it, then it stays severe.
  replay(cpu, vmSamples(vms.cpuCritical, 'cpu', stepped([96, 103, 108, 112, 115, 124, 121, 119, 120, 118], end)), SETTINGS, getSetting, engine);

  // 2. Memory degrading: five elevated samples, promoted on the third (30 min ago).
  replay(mem, vmSamples(vms.memDegrading, 'mem', stepped([72, 75, 80, 91, 92, 93, 94, 93], end)), SETTINGS, getSetting, engine);

  // 3. CPU watching: two elevated samples, below the sustain count.
  replay(cpu, vmSamples(vms.cpuWatching, 'cpu', stepped([40, 55, 93, 95], end)), SETTINGS, getSetting, engine);

  // 4. CPU pattern: four short bursts, each two elevated then two normal samples.
  const day = 24 * 60 * 60 * 1000;
  const burst = [];
  for (const daysAgo of [6, 4, 2, 1]) {
    const start = end - daysAgo * day + 2 * 60 * 60 * 1000;
    burst.push(...[92, 95, 40, 35].map((v, i) => ({ value: v, ms: start + i * STEP_MS })));
  }
  replay(cpu, vmSamples(vms.cpuPattern, 'cpu', burst), SETTINGS, getSetting, engine);

  // 5. Host memory: elevated for 90 minutes starting 30 h ago, then closed.
  const hostStart = end - 30 * 60 * 60 * 1000;
  const hostSeries = [88, 89, 90, 91, 90, 89, 62, 60].map((v, i) => ({ value: v, ms: hostStart + i * STEP_MS }));
  replay(hostMem, hostSeries.map((s) => ({
    subjectKey: `vcenter:${host.vcenter_id}:host:${host.name}`,
    label: host.name,
    host: host.name,
    sourceId: host.vcenter_id,
    sourceName: host.vcenter_name,
    value: s.value,
    capturedAt: new Date(s.ms).toISOString(),
    context: { cluster: host.cluster_name, cpuCores: host.cpu_cores },
  })), SETTINGS, getSetting, engine);

  // Make the inventory agree with the episodes' latest values.
  const setVmCpu = db.prepare(`UPDATE vcenter_vms SET cpu_usage_mhz = ? WHERE vcenter_id = ? AND name = ?`);
  const setVmMem = db.prepare(`UPDATE vcenter_vms SET mem_usage_mb = ? WHERE vcenter_id = ? AND name = ?`);
  const cpuMhz = (vm, pct) => Math.round((pct / 100) * (vm.cpu_mhz_capacity / vm.cpu_cores) * vm.cpu_count);
  const memMb = (vm, pct) => Math.round((pct / 100) * vm.memory_mb);
  setVmCpu.run(cpuMhz(vms.cpuCritical, 118), vms.cpuCritical.vcenter_id, vms.cpuCritical.name);
  setVmMem.run(memMb(vms.memDegrading, 93), vms.memDegrading.vcenter_id, vms.memDegrading.name);
  setVmCpu.run(cpuMhz(vms.cpuWatching, 95), vms.cpuWatching.vcenter_id, vms.cpuWatching.name);
  setVmCpu.run(cpuMhz(vms.cpuPattern, 35), vms.cpuPattern.vcenter_id, vms.cpuPattern.name);
  db.prepare('UPDATE vcenter_hosts SET mem_bytes_used = ? WHERE vcenter_id = ? AND name = ?')
    .run(Math.round(0.6 * host.mem_bytes_capacity), host.vcenter_id, host.name);

  const counts = db.prepare(`SELECT state, COUNT(*) c FROM ops_observations WHERE observer_id IN (${ph}) GROUP BY state`)
    .all(...OBSERVER_IDS);
  return {
    applied: true,
    subjects: { ...Object.fromEntries(Object.entries(vms).map(([k, v]) => [k, v.name])), hostMemory: host.name },
    byState: Object.fromEntries(counts.map((r) => [r.state, r.c])),
  };
}

module.exports = { applyOpsObservations };
