'use strict';

// Contract C11.4 — deterministic in-memory Pure1 fixtures for demo mode.
// Every exported function here mirrors the exact response shape of the
// matching live function in services/pure1Api.js so routes/pure1.js (and
// the frontend/src/pages/pure/* pages that consume it) cannot tell the
// difference. Data is generated once per process (module-scope cache) with
// a mulberry32 PRNG keyed by entity name, so re-runs are stable apart from
// timestamps, which are relative to Date.now().

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rngFor(name) {
  return mulberry32(hashSeed(name));
}

function randRange(rng, min, max) {
  return min + rng() * (max - min);
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

// ── Fleet naming (contract C11.2 — MUST match the seedDemo naming scheme) ──

const MODELS = ['FlashArray//X70R3', 'FlashArray//X50R3', 'FlashArray//C60R3', 'FlashArray//XL170'];
const PURITY_VERSIONS = ['6.5.1', '6.4.10'];

// site -> array-suffix plan; name pattern is `${site}-fa-${suffix}` where
// suffix already contains env + zero-padded index (e.g. "prd-01"). 20 arrays total.
const FLEET_PLAN = [
  ['nyc', ['prd-01', 'prd-02', 'dr-01']],
  ['lon', ['prd-01', 'prd-02', 'dr-01']],
  ['fra', ['prd-01', 'prd-02', 'dr-01']],
  ['sgp', ['prd-01', 'dr-01']],
  ['syd', ['prd-01', 'dr-01']],
  ['chi', ['prd-01', 'dev-01']],
  ['dal', ['prd-01', 'dev-01']],
  ['tor', ['prd-01', 'prd-02', 'dr-01']],
];

function buildArrayNames() {
  const names = [];
  for (const [site, suffixes] of FLEET_PLAN) {
    for (const suffix of suffixes) names.push(`${site}-fa-${suffix}`);
  }
  return names;
}

function arrayIdFor(name) { return `demo-pure-${name}`; }

// ── Fleet (arrays + capacity) ────────────────────────────────────────────

let _fleet = null;

function buildFleet() {
  const names = buildArrayNames();
  return names.map((name, idx) => {
    const rng = rngFor(name);
    const model = MODELS[idx % MODELS.length];
    const version = PURITY_VERSIONS[idx % PURITY_VERSIONS.length];
    const total = Math.round(randRange(rng, 300, 1200) * 1e12); // 300TB..1.2PB
    const pctUsed = randRange(rng, 40, 80);
    const used = Math.round(total * (pctUsed / 100));
    const dataReduction = randRange(rng, 3, 5);
    const volumeSpace = Math.round(used * 0.6);
    const sharedSpace = Math.round(used * 0.2);
    const snapshotSpace = Math.round(used * 0.1);
    const systemSpace = Math.round(used * 0.05);
    const replicationSpace = used - volumeSpace - sharedSpace - snapshotSpace - systemSpace;
    const capturedAt = Date.now() - Math.round(randRange(rng, 0, 3600000));
    return {
      id: arrayIdFor(name),
      name,
      fqdn: `${name}.demo.local`,
      model,
      os: 'Purity//FA',
      version,
      total,
      used,
      pctUsed: total > 0 ? (used / total) * 100 : null,
      dataReduction,
      effectiveUsed: dataReduction ? used * dataReduction : null,
      volumeSpace,
      snapshotSpace,
      sharedSpace,
      capturedAt,
      tags: [],
      // internal-only, stripped before returning from getOverview()
      _systemSpace: systemSpace,
      _replicationSpace: replicationSpace,
      _baseRng: name,
    };
  });
}

function getFleet() {
  if (!_fleet) _fleet = buildFleet();
  return _fleet;
}

function findArray(arrayId) {
  return getFleet().find((a) => a.id === arrayId) || null;
}

// ── /overview ─────────────────────────────────────────────────────────────

async function getOverview() {
  return getFleet()
    .map(({ _systemSpace, _replicationSpace, _baseRng, ...row }) => row)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── /alerts ──────────────────────────────────────────────────────────────

const ALERT_CATEGORIES = ['array', 'hardware', 'software'];
const ALERT_SEVERITIES = ['critical', 'warning', 'info'];
const ALERT_SUMMARIES = {
  array: ['Capacity threshold approaching', 'Replication link degraded', 'Array connection lost'],
  hardware: ['Drive predicted failure', 'Power supply fault', 'Controller failover occurred', 'Temperature threshold exceeded'],
  software: ['Purity upgrade recommended', 'License expiring soon', 'Snapshot policy violation'],
};

let _alerts = null;

function buildAlerts() {
  const fleet = getFleet();
  const rng = rngFor('fleet-alerts');
  const out = [];
  const count = 15;
  for (let i = 0; i < count; i++) {
    const arr = fleet[Math.floor(rng() * fleet.length)];
    const category = ALERT_CATEGORIES[Math.floor(rng() * ALERT_CATEGORIES.length)];
    // Skew toward info/warning (roughly matches contract's real-cluster mix).
    const sevRoll = rng();
    const severity = sevRoll < 0.15 ? 'critical' : sevRoll < 0.5 ? 'warning' : 'info';
    const summary = pick(rng, ALERT_SUMMARIES[category]);
    const createdOffsetMs = Math.round(randRange(rng, 0, 14 * 86400000));
    const created = Date.now() - createdOffsetMs;
    const updated = created + Math.round(randRange(rng, 0, 3600000));
    out.push({
      id: `demo-alert-${arr.name}-${i}`,
      arrayName: arr.name,
      arrayFqdn: arr.fqdn,
      severity,
      category,
      component: `${category}.${i}`,
      componentType: category,
      summary,
      code: 1000 + i,
      state: rng() < 0.85 ? 'open' : 'closed',
      created,
      updated,
      knowledgeBaseUrl: null,
    });
  }
  return out.filter((a) => a.state === 'open');
}

async function getAlerts() {
  if (!_alerts) _alerts = buildAlerts();
  return _alerts;
}

// ── /enrichment + /hardware (shared per-array hardware generation) ─────────

const HW_STATUSES = ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'unhealthy'];

const _hardwareByArrayId = new Map();

function buildHardwareForArray(arr) {
  const rng = rngFor(`hw-${arr.name}`);
  const controllers = ['CT0', 'CT1'].map((name, i) => ({
    id: `${arr.id}-${name.toLowerCase()}`,
    name,
    mode: i === 0 ? 'primary' : 'secondary',
    model: arr.model,
    status: pick(rng, HW_STATUSES),
    type: 'controller',
    version: arr.version,
    serial: `PSC${hashSeed(`${arr.name}-${name}`).toString(36).toUpperCase().slice(0, 8)}`,
  }));

  const components = [];
  components.push({
    id: `${arr.id}-chassis`,
    name: 'CH0',
    type: 'chassis',
    model: arr.model,
    serial: `PCH${hashSeed(`${arr.name}-chassis`).toString(36).toUpperCase().slice(0, 8)}`,
    slot: null,
    status: pick(rng, HW_STATUSES),
    speed: null,
    temperature: Math.round(randRange(rng, 28, 45)),
    voltage: null,
  });
  for (const c of controllers) {
    components.push({
      id: `${arr.id}-comp-${c.name.toLowerCase()}`,
      name: c.name,
      type: 'controller',
      model: c.model,
      serial: c.serial,
      slot: null,
      status: c.status,
      speed: null,
      temperature: Math.round(randRange(rng, 30, 55)),
      voltage: null,
    });
  }
  const extraTypes = ['fan', 'power_supply', 'temp_sensor'];
  for (const type of extraTypes) {
    for (let i = 0; i < 2; i++) {
      components.push({
        id: `${arr.id}-${type}-${i}`,
        name: `${type.toUpperCase()}${i}`,
        type,
        model: null,
        serial: null,
        slot: i,
        status: pick(rng, HW_STATUSES),
        speed: type === 'fan' ? Math.round(randRange(rng, 2000, 8000)) : null,
        temperature: type === 'temp_sensor' ? Math.round(randRange(rng, 25, 50)) : null,
        voltage: type === 'power_supply' ? Math.round(randRange(rng, 110, 240)) : null,
      });
    }
  }

  const driveCount = Math.round(randRange(rng, 12, 24));
  const drives = [];
  for (let i = 0; i < driveCount; i++) {
    drives.push({
      id: `${arr.id}-drive-${i}`,
      name: `BAY${String(i).padStart(2, '0')}`,
      capacity: Math.round(randRange(rng, 1, 4) * 1e12),
      protocol: rng() < 0.7 ? 'NVMe' : 'SAS',
      status: pick(rng, HW_STATUSES) === 'ok' ? 'healthy' : 'unhealthy',
      type: 'SSD',
    });
  }

  return {
    controllers: controllers.sort((a, b) => a.name.localeCompare(b.name)),
    components: components.sort((a, b) => String(a.name).localeCompare(String(b.name))),
    drives: drives.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function hardwareFor(arr) {
  if (!_hardwareByArrayId.has(arr.id)) _hardwareByArrayId.set(arr.id, buildHardwareForArray(arr));
  return _hardwareByArrayId.get(arr.id);
}

let _enrichment = null;

function buildEnrichment() {
  const out = {};
  for (const arr of getFleet()) {
    const hw = hardwareFor(arr);
    const allStatuses = [...hw.components, ...hw.drives].map((c) => String(c.status || '').toLowerCase());
    const unhealthy = allStatuses.filter((s) => !['ok', 'healthy'].includes(s)).length;
    const health = unhealthy === 0 ? 'ok' : unhealthy === 1 ? 'warn' : 'crit';
    const chassis = hw.components.find((c) => c.type === 'chassis');
    out[arr.id] = {
      health,
      unhealthy,
      provisioned: Math.round(arr.used * 1.3),
      chassisSerial: chassis ? chassis.serial : null,
      controllerSerials: hw.controllers.map((c) => c.serial),
    };
  }
  return out;
}

async function getEnrichment() {
  if (!_enrichment) _enrichment = buildEnrichment();
  return _enrichment;
}

async function fetchHardware(arrayId) {
  const arr = findArray(arrayId);
  if (!arr) return { controllers: [], components: [], drives: [] };
  return hardwareFor(arr);
}

// ── /connectivity ────────────────────────────────────────────────────────

async function fetchConnectivity(arrayId) {
  const arr = findArray(arrayId);
  if (!arr) return { interfaces: [], ports: [] };
  const rng = rngFor(`conn-${arr.name}`);
  const interfaces = [];
  const ifaceCount = Math.round(randRange(rng, 4, 8));
  for (let i = 0; i < ifaceCount; i++) {
    interfaces.push({
      id: `${arr.id}-iface-${i}`,
      name: `ct${i % 2}.eth${Math.floor(i / 2)}`,
      address: `10.${(hashSeed(arr.name) % 200) + 10}.${i}.${10 + i}`,
      netmask: '255.255.255.0',
      gateway: `10.${(hashSeed(arr.name) % 200) + 10}.${i}.1`,
      mac: `02:00:00:${(i).toString(16).padStart(2, '0')}:00:01`,
      mtu: 1500,
      speed: pick(rng, [1e9, 10e9, 25e9]),
      enabled: rng() > 0.1,
      services: 'management, replication',
    });
  }
  const ports = [];
  const portCount = Math.round(randRange(rng, 2, 4));
  for (let i = 0; i < portCount; i++) {
    ports.push({
      id: `${arr.id}-port-${i}`,
      name: `CT0.FC${i}`,
      wwn: `5001438${hashSeed(`${arr.name}-${i}`).toString(16).padStart(9, '0')}`,
      iqn: null,
      nqn: null,
      portal: null,
      failover: 'none',
    });
  }
  return {
    interfaces: interfaces.sort((a, b) => a.name.localeCompare(b.name)),
    ports: ports.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ── /volumes ─────────────────────────────────────────────────────────────

const VOLUME_NAME_TEMPLATES = ['vm-datastore', 'sql-logs', 'sql-data', 'oracle-redo', 'app-data', 'backup-stage'];

async function fetchVolumes(arrayId) {
  const arr = findArray(arrayId);
  if (!arr) return [];
  const rng = rngFor(`vols-${arr.name}`);
  const count = Math.round(randRange(rng, 20, 60));
  const out = [];
  for (let i = 0; i < count; i++) {
    const template = pick(rng, VOLUME_NAME_TEMPLATES);
    const name = template === 'vm-datastore' ? `${arr.name.split('-')[0]}-${template}-${String(i).padStart(2, '0')}` : `${template}-${String(i).padStart(2, '0')}`;
    out.push({
      id: `${arr.id}-vol-${i}`,
      name,
      provisioned: Math.round(randRange(rng, 100, 5000) * 1e9),
      serial: `PSV${hashSeed(`${arr.name}-${i}`).toString(36).toUpperCase().slice(0, 10)}`,
      pod: null,
      source: null,
      created: Date.now() - Math.round(randRange(rng, 0, 365 * 86400000)),
    });
  }
  return out.sort((a, b) => (b.provisioned || 0) - (a.provisioned || 0));
}

// ── /pods ────────────────────────────────────────────────────────────────

let _pods = null;

function buildPods() {
  const fleet = getFleet();
  const rng = rngFor('fleet-pods');
  const podCount = 5;
  const pods = [];
  for (let i = 0; i < podCount; i++) {
    const stretched = i < 3; // half-ish stretched across two arrays
    const a1 = fleet[Math.floor(rng() * fleet.length)];
    let members = [{ id: a1.id, name: a1.name, status: 'online', mediatorStatus: 'online', frozenAt: null }];
    if (stretched) {
      let a2 = fleet[Math.floor(rng() * fleet.length)];
      let guard = 0;
      while (a2.id === a1.id && guard++ < 10) a2 = fleet[Math.floor(rng() * fleet.length)];
      members.push({ id: a2.id, name: a2.name, status: 'online', mediatorStatus: 'online', frozenAt: null });
    }
    pods.push({
      id: `demo-pod-${i}`,
      name: `pod-${a1.name.split('-')[0]}-${i}`,
      mediator: 'online',
      arrays: members,
    });
  }
  return pods;
}

async function fetchPods() {
  if (!_pods) _pods = buildPods();
  return [..._pods].sort((a, b) => a.name.localeCompare(b.name));
}

// ── capacity / performance history ─────────────────────────────────────────

const CAPACITY_METRICS = [
  'array_total_capacity', 'array_volume_space', 'array_shared_space',
  'array_snapshot_space', 'array_system_space', 'array_replication_space',
  'array_data_reduction',
];
const PERF_METRICS = [
  'array_read_iops', 'array_write_iops', 'array_read_latency_us', 'array_write_latency_us',
  'array_read_bandwidth', 'array_write_bandwidth',
];

function resolutionForDays(days) {
  if (days <= 1) return 300000;
  if (days <= 7) return 3600000;
  return 86400000;
}

async function fetchCapacityHistory(arrayId, days = 30) {
  const arr = findArray(arrayId);
  const end = Date.now();
  const start = end - days * 86400000;
  const resolution = 86400000;
  if (!arr) return { start, end, resolution, series: {} };
  const rng = rngFor(`cap-hist-${arr.name}`);
  const points = Math.ceil((end - start) / resolution);
  const series = {};
  for (const m of CAPACITY_METRICS) series[m] = [];
  // Slow linear growth toward the array's current (latest) values.
  for (let i = 0; i < points; i++) {
    const ts = start + i * resolution;
    const progress = points > 1 ? i / (points - 1) : 1;
    const growth = 0.85 + progress * 0.15; // ramps up to today's value
    const noise = 1 + (rng() - 0.5) * 0.02;
    series.array_total_capacity.push([ts, arr.total]);
    series.array_volume_space.push([ts, Math.round(arr.volumeSpace * growth * noise)]);
    series.array_shared_space.push([ts, Math.round(arr.sharedSpace * growth * noise)]);
    series.array_snapshot_space.push([ts, Math.round(arr.snapshotSpace * growth * noise)]);
    series.array_system_space.push([ts, Math.round(arr._systemSpace * growth * noise)]);
    series.array_replication_space.push([ts, Math.round(arr._replicationSpace * growth * noise)]);
    series.array_data_reduction.push([ts, Math.round(arr.dataReduction * (0.95 + rng() * 0.1) * 100) / 100]);
  }
  return { start, end, resolution, series };
}

async function fetchPerformanceHistory(arrayId, days = 1) {
  const arr = findArray(arrayId);
  const end = Date.now();
  const start = end - days * 86400000;
  const resolution = resolutionForDays(days);
  if (!arr) return { start, end, resolution, series: {} };
  const rng = rngFor(`perf-hist-${arr.name}`);
  const points = Math.min(300, Math.ceil((end - start) / resolution));
  const step = (end - start) / points;
  const series = {};
  for (const m of PERF_METRICS) series[m] = [];
  const baseIops = randRange(rng, 5000, 40000);
  const baseLatencyUs = randRange(rng, 300, 2000);
  const baseBandwidth = randRange(rng, 100e6, 800e6);
  for (let i = 0; i < points; i++) {
    const ts = start + i * step;
    // Diurnal wave: peak mid-day, trough overnight.
    const hourOfDay = (new Date(ts).getUTCHours() + new Date(ts).getUTCMinutes() / 60);
    const wave = 0.6 + 0.4 * Math.sin(((hourOfDay - 6) / 24) * 2 * Math.PI);
    const noise = 1 + (rng() - 0.5) * 0.1;
    series.array_read_iops.push([ts, Math.round(baseIops * 0.6 * wave * noise)]);
    series.array_write_iops.push([ts, Math.round(baseIops * 0.4 * wave * noise)]);
    series.array_read_latency_us.push([ts, Math.round(baseLatencyUs * (0.8 + (1 - wave) * 0.4) * noise)]);
    series.array_write_latency_us.push([ts, Math.round(baseLatencyUs * 1.2 * (0.8 + (1 - wave) * 0.4) * noise)]);
    series.array_read_bandwidth.push([ts, Math.round(baseBandwidth * 0.6 * wave * noise)]);
    series.array_write_bandwidth.push([ts, Math.round(baseBandwidth * 0.4 * wave * noise)]);
  }
  return { start, end, resolution, series };
}

module.exports = {
  getOverview,
  getAlerts,
  getEnrichment,
  fetchVolumes,
  fetchPods,
  fetchHardware,
  fetchConnectivity,
  fetchCapacityHistory,
  fetchPerformanceHistory,
  buildArrayNames,
};
