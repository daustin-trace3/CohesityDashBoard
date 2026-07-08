const cron = require('node-cron');
const axios = require('axios');
const db = require('../db/database');
const { buildHeliosClient } = require('./helios');
const { getLicenseSettings } = require('./settings');
const logger = require('../utils/logger');

// Per-cluster capacity source (fast, ~28 rows). Front-end/physical/capacity per system.
const CLUSTER_REPORT = 'storage-consumption-cluster';
// Per-protection-group source (heavier, thousands of rows) — carries `environment`
// and `targetRole`, which is what lets us split consumption by license type.
const GROUP_REPORT = 'storage-consumption-group';

const LICENSE_TYPES = ['dataProtect', 'replica', 'smartFiles'];
const TYPE_LABEL = { dataProtect: 'DataProtect', replica: 'Replica', smartFiles: 'SmartFiles' };

function dateFilter(days) {
  const now = Date.now() * 1000;
  const from = (Date.now() - days * 24 * 60 * 60 * 1000) * 1000;
  return { attribute: 'date', filterType: 'TimeRange', timeRangeFilterParams: { lowerBound: from, upperBound: now } };
}

async function previewReport(client, id, days, timeout) {
  const body = { id, filters: [dateFilter(days)], timezone: 'America/Los_Angeles', limit: { size: 5000 } };
  const { data } = await client.post(`/heliosreporting/api/v1/public/reports/${id}/preview`, body, { timeout });
  return data?.components || [];
}

/**
 * Per-system front-end / physical / capacity (storage-consumption-cluster).
 */
async function fetchStorageConsumption(client) {
  const comps = await previewReport(client, CLUSTER_REPORT, 7, 90000);
  const perCluster = comps.find(c => String(c.id) === '800');
  const rows = Array.isArray(perCluster?.data) ? perCluster.data : [];
  return rows.map(r => ({
    systemId: r.systemId != null ? String(r.systemId) : null,
    systemName: r.systemName || null,
    frontEndBytes: r.dataIngestedRetainedBytes ?? null,
    physicalBytes: r.scResiliencyBytes ?? null,
    capacityBytes: r.totalCapacityBytes ?? null,
    usagePercent: r.usagePercent ?? null,
    dataReduction: r.dataReduction ?? null,
  }));
}

/**
 * Consumed front-end (FETB) split by license type (storage-consumption-group).
 *   replica     — protection groups whose targetRole is not Primary (replica copies)
 *   smartFiles  — groups whose environment is kView (Cohesity Views / NAS shares)
 *   dataProtect — every other backed-up workload
 */
async function fetchTypeConsumption(client) {
  const comps = await previewReport(client, GROUP_REPORT, 7, 180000);
  const perGroup = comps.find(c => String(c.id) === '400');
  const rows = Array.isArray(perGroup?.data) ? perGroup.data : [];
  const buckets = { dataProtect: 0, replica: 0, smartFiles: 0 };
  for (const g of rows) {
    const fe = g.dataIngestedRetainedBytes || 0;
    if (g.targetRole && g.targetRole !== 'Primary') buckets.replica += fe;
    else if (g.environment === 'kView') buckets.smartFiles += fe;
    else buckets.dataProtect += fe;
  }
  return buckets;
}

// ── Per-system consumption breakdown (backup vs replication vs views) ────────
// The v1 stats/consumers API, reached per cluster through Helios passthrough
// (accessClusterId header), natively separates consumption by what the data is.
// Views are further split by license attribution: a read-only view is a
// replica of a view from another cluster (counts toward Replica licensing),
// while a writable view is actively receiving data — a NAS share or a
// backup-into-view target — and counts toward SmartFiles.
const SIMPLE_CONSUMER_CATEGORIES = [
  { type: 'kProtectionRuns', category: 'backup' },
  { type: 'kReplicationRuns', category: 'replication' },
  { type: 'kViewProtectionRuns', category: 'viewBackups' },
];

async function listConsumers(clusterClient, consumerType) {
  let cookie = null;
  const items = [];
  do {
    const url = `/irisservices/api/v1/public/stats/consumers?consumerType=${consumerType}&maxCount=1000` +
      (cookie ? `&paginationCookie=${encodeURIComponent(cookie)}` : '');
    const { data } = await clusterClient.get(url, { timeout: 60000 });
    items.push(...(data?.statsList || []));
    cookie = data?.paginationCookie || null;
  } while (cookie);
  return items;
}

function sumStats(items) {
  const out = { consumers: 0, physicalBytes: 0, logicalBytes: 0 };
  for (const s of items) {
    out.consumers += 1;
    out.physicalBytes += s.stats?.storageConsumedBytes || 0;
    out.logicalBytes += s.stats?.totalLogicalUsageBytes || 0;
  }
  return out;
}

/**
 * Views split by replication provenance: read-only views were replicated in
 * from another cluster ('viewsReplicated'); writable views hold data written
 * directly to this cluster ('views' — SmartFiles). Consumers with no matching
 * view (e.g. recently deleted views still holding storage) default to 'views'.
 */
async function fetchViewsSplit(clusterClient) {
  const items = await listConsumers(clusterClient, 'kViews');
  let readOnlyNames = new Set();
  const createdMs = new Map();
  try {
    const { data } = await clusterClient.get('/v2/file-services/views?maxCount=2000', { timeout: 60000 });
    for (const v of (data?.views || [])) {
      if (v.isReadOnly) readOnlyNames.add(v.name);
      if (v.createTimeMsecs) createdMs.set(v.name, v.createTimeMsecs);
    }
  } catch {
    // Views metadata unavailable — leave the set empty; everything lands in 'views'.
  }
  const detail = items.map(s => ({
    viewName: s.name,
    isReadOnly: readOnlyNames.has(s.name),
    createdMs: createdMs.get(s.name) ?? null,
    physicalBytes: s.stats?.storageConsumedBytes || 0,
    logicalBytes: s.stats?.totalLogicalUsageBytes || 0,
    dataWrittenBytes: s.stats?.dataWrittenBytes || 0,
  }));
  return {
    views: sumStats(items.filter(s => !readOnlyNames.has(s.name))),
    viewsReplicated: sumStats(items.filter(s => readOnlyNames.has(s.name))),
    detail,
  };
}

/**
 * Fetch the backup/replication/views breakdown for every Helios-connected
 * cluster. Clusters are processed a few at a time; a failing cluster is
 * skipped rather than failing the whole refresh.
 */
async function fetchConsumptionBreakdown(apiKey) {
  const helios = buildHeliosClient(apiKey);
  const { data } = await helios.get('/mcm/clusters/connectionStatus');
  const clusters = (Array.isArray(data) ? data : []).filter(c => c.connectedToCluster);

  const rows = [];
  const viewDetail = [];
  let failed = 0;
  const CONCURRENCY = 4;
  for (let i = 0; i < clusters.length; i += CONCURRENCY) {
    const batch = clusters.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async (c) => {
      const clusterClient = axios.create({
        baseURL: 'https://helios.cohesity.com',
        timeout: 90000,
        headers: { apiKey, accessClusterId: String(c.clusterId) },
      });
      const perCluster = [];
      for (const { type, category } of SIMPLE_CONSUMER_CATEGORIES) {
        const sums = sumStats(await listConsumers(clusterClient, type));
        perCluster.push({
          systemId: String(c.clusterId),
          systemName: c.name || null,
          category,
          ...sums,
        });
      }
      const split = await fetchViewsSplit(clusterClient);
      for (const category of ['views', 'viewsReplicated']) {
        perCluster.push({
          systemId: String(c.clusterId),
          systemName: c.name || null,
          category,
          ...split[category],
        });
      }
      return {
        rows: perCluster,
        viewDetail: split.detail.map(d => ({ systemId: String(c.clusterId), systemName: c.name || null, ...d })),
      };
    }));
    for (const r of results) {
      if (r.status === 'fulfilled') {
        rows.push(...r.value.rows);
        viewDetail.push(...r.value.viewDetail);
      } else failed += 1;
    }
  }
  if (failed > 0) logger.warn(`[Licensing] Breakdown fetch failed for ${failed} cluster(s) — partial data stored.`);
  return { rows, viewDetail };
}

/**
 * Cohesity's own license meters, per cluster (public/licenseUsage, GiB per
 * feature). currentUsageGiB of -1 means the feature is not metered — skipped.
 */
async function fetchLicenseMeters(apiKey) {
  const helios = buildHeliosClient(apiKey);
  const { data } = await helios.get('/mcm/clusters/connectionStatus');
  const clusters = (Array.isArray(data) ? data : []).filter(c => c.connectedToCluster);

  const rows = [];
  let failed = 0;
  const CONCURRENCY = 6;
  for (let i = 0; i < clusters.length; i += CONCURRENCY) {
    const batch = clusters.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async (c) => {
      const clusterClient = axios.create({
        baseURL: 'https://helios.cohesity.com',
        timeout: 60000,
        headers: { apiKey, accessClusterId: String(c.clusterId) },
      });
      const { data } = await clusterClient.get('/irisservices/api/v1/public/licenseUsage');
      const agg = {};
      for (const arr of Object.values(data?.usage || {})) {
        for (const f of arr) {
          if (f.currentUsageGiB != null && f.currentUsageGiB >= 0) {
            agg[f.featureName] = (agg[f.featureName] || 0) + f.currentUsageGiB;
          }
        }
      }
      return Object.entries(agg).map(([feature, usageGib]) => ({
        systemId: String(c.clusterId),
        systemName: c.name || null,
        feature,
        usageGib,
      }));
    }));
    for (const r of results) {
      if (r.status === 'fulfilled') rows.push(...r.value);
      else failed += 1;
    }
  }
  if (failed > 0) logger.warn(`[Licensing] License meter fetch failed for ${failed} cluster(s) — partial data stored.`);
  return rows;
}

const replaceViewDetail = db.transaction((rows) => {
  db.prepare('DELETE FROM license_view_detail').run();
  const stmt = db.prepare(`
    INSERT INTO license_view_detail
      (system_id, system_name, view_name, is_read_only, created_ms, physical_bytes, logical_bytes, data_written_bytes, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  for (const r of rows) {
    stmt.run(r.systemId, r.systemName, r.viewName, r.isReadOnly ? 1 : 0, r.createdMs, r.physicalBytes, r.logicalBytes, r.dataWrittenBytes);
  }
});

const replaceMeters = db.transaction((rows) => {
  db.prepare('DELETE FROM license_meter_usage').run();
  const stmt = db.prepare(`
    INSERT INTO license_meter_usage (system_id, system_name, feature, usage_gib, captured_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);
  for (const r of rows) stmt.run(r.systemId, r.systemName, r.feature, r.usageGib);
});

const replaceBreakdown = db.transaction((rows) => {
  db.prepare('DELETE FROM consumption_breakdown').run();
  const stmt = db.prepare(`
    INSERT INTO consumption_breakdown
      (system_id, system_name, category, consumers, physical_bytes, logical_bytes, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  for (const r of rows) {
    stmt.run(r.systemId, r.systemName, r.category, r.consumers, r.physicalBytes, r.logicalBytes);
  }
});

const replaceLicenseUsage = db.transaction((rows) => {
  db.prepare('DELETE FROM license_usage').run();
  const stmt = db.prepare(`
    INSERT INTO license_usage
      (system_id, system_name, front_end_bytes, physical_bytes, capacity_bytes, usage_percent, data_reduction, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  for (const r of rows) {
    stmt.run(r.systemId, r.systemName, r.frontEndBytes, r.physicalBytes, r.capacityBytes, r.usagePercent, r.dataReduction);
  }
});

const replaceTypeUsage = db.transaction((buckets) => {
  db.prepare('DELETE FROM license_type_usage').run();
  const stmt = db.prepare(`
    INSERT INTO license_type_usage (license_type, front_end_bytes, captured_at)
    VALUES (?, ?, datetime('now'))
  `);
  for (const t of LICENSE_TYPES) stmt.run(t, buckets[t] || 0);
});

/**
 * Refresh both the per-system snapshot and the per-license-type split from Helios.
 */
async function refreshLicensing() {
  const apiKey = require('./settings').getHeliosApiKey();
  if (!apiKey || apiKey.length < 20) {
    logger.warn('[Licensing] Helios API key not configured — skipping licensing refresh.');
    return { ok: false, reason: 'no_key' };
  }
  const client = buildHeliosClient(apiKey);
  // Each source fetches and stores independently. The four legs share one
  // Helios rate limit, so a heavy report can blow its timeout while the
  // others succeed — a failed leg keeps its previous rows instead of
  // discarding the whole refresh.
  const legs = [
    { label: 'per-system capacity', run: async () => {
      const systems = await fetchStorageConsumption(client);
      replaceLicenseUsage(systems);
      return `${systems.length} system(s)`;
    } },
    { label: 'license-type split', run: async () => {
      const buckets = await fetchTypeConsumption(client);
      replaceTypeUsage(buckets);
      return LICENSE_TYPES.map(t => `${TYPE_LABEL[t]}=${(buckets[t] / 1024 ** 4).toFixed(0)}TiB`).join(' ');
    } },
    { label: 'consumption breakdown', run: async () => {
      const breakdown = await fetchConsumptionBreakdown(apiKey);
      replaceBreakdown(breakdown.rows);
      replaceViewDetail(breakdown.viewDetail);
      return `${breakdown.rows.length} rows, ${breakdown.viewDetail.length} views`;
    } },
    { label: 'license meters', run: async () => {
      const meters = await fetchLicenseMeters(apiKey);
      replaceMeters(meters);
      return `${meters.length} meter rows`;
    } },
  ];
  const results = await Promise.allSettled(legs.map(l => l.run()));
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      failed.push(legs[i].label);
      logger.warn(`[Licensing] Refresh leg '${legs[i].label}' failed — previous data kept: ${r.reason?.message || r.reason}`);
    }
  });
  if (failed.length === legs.length) return { ok: false, reason: 'all_failed', failed };
  logger.info(`[Licensing] Refreshed ${legs.length - failed.length}/${legs.length} sources; ` +
    results.map((r, i) => `${legs[i].label}: ${r.status === 'fulfilled' ? r.value : 'FAILED'}`).join('; '));
  return { ok: true, failed };
}

/**
 * Current licensing view: per-type entitlement (settings) vs consumed (Helios),
 * plus the per-system detail table.
 */
function getLicensing() {
  const settings = getLicenseSettings();
  const entitled = settings.entitled;

  const typeRows = db.prepare(
    'SELECT license_type AS type, front_end_bytes AS frontEndBytes, captured_at AS capturedAt FROM license_type_usage'
  ).all();
  const consumedByType = Object.fromEntries(typeRows.map(r => [r.type, r.frontEndBytes || 0]));

  const byCluster = db.prepare(`
    SELECT system_id AS systemId, system_name AS systemName,
           front_end_bytes AS frontEndBytes, physical_bytes AS physicalBytes,
           capacity_bytes AS capacityBytes, usage_percent AS usagePercent,
           data_reduction AS dataReduction, captured_at AS capturedAt
    FROM license_usage ORDER BY front_end_bytes DESC
  `).all();

  const physical = byCluster.reduce((s, r) => s + (r.physicalBytes || 0), 0);
  const capacity = byCluster.reduce((s, r) => s + (r.capacityBytes || 0), 0);

  // Pivot the per-system breakdown: one row per system with a column per category.
  const bdRows = db.prepare(`
    SELECT system_id AS systemId, system_name AS systemName, category,
           consumers, physical_bytes AS physicalBytes, logical_bytes AS logicalBytes,
           captured_at AS capturedAt
    FROM consumption_breakdown
  `).all();
  const bdBySystem = new Map();
  const bdTotals = {};
  for (const r of bdRows) {
    if (!bdBySystem.has(r.systemId)) {
      bdBySystem.set(r.systemId, { systemId: r.systemId, systemName: r.systemName, categories: {} });
    }
    bdBySystem.get(r.systemId).categories[r.category] = {
      consumers: r.consumers || 0,
      physicalBytes: r.physicalBytes || 0,
      logicalBytes: r.logicalBytes || 0,
    };
    if (!bdTotals[r.category]) bdTotals[r.category] = { consumers: 0, physicalBytes: 0, logicalBytes: 0 };
    bdTotals[r.category].consumers += r.consumers || 0;
    bdTotals[r.category].physicalBytes += r.physicalBytes || 0;
    bdTotals[r.category].logicalBytes += r.logicalBytes || 0;
  }
  const breakdownSystems = [...bdBySystem.values()].sort((a, b) => {
    const sum = (s) => Object.values(s.categories).reduce((acc, c) => acc + c.physicalBytes, 0);
    return sum(b) - sum(a);
  });

  // License-type consumption. Primary source is Cohesity's own license meters
  // (public/licenseUsage) — the same accounting the licensing portal reads:
  //   DataProtect = dataProtect, Replica = dataProtectReplica,
  //   SmartFiles = externalViews (the meter the portal's SmartFiles figure
  //   tracks; the 'smartFiles' feature meter undercounts on older clusters).
  // Falls back to derived figures if the meter sweep returned nothing.
  const METER_SOURCE = { dataProtect: 'dataProtect', replica: 'dataProtectReplica', smartFiles: 'externalViews' };
  const meterRows = db.prepare(
    'SELECT feature, SUM(usage_gib) AS gib FROM license_meter_usage GROUP BY feature'
  ).all();
  const meterBytes = Object.fromEntries(meterRows.map(r => [r.feature, (r.gib || 0) * 1024 ** 3]));

  const replicaUsedBytes = (bdTotals.replication?.physicalBytes || 0) +
    (bdTotals.viewsReplicated?.physicalBytes || 0);
  const smartFilesUsedBytes = bdTotals.views?.physicalBytes || 0;
  const types = LICENSE_TYPES.map(key => {
    let consumedBytes = consumedByType[key] || 0;
    let basis = 'frontEnd';
    const meter = meterBytes[METER_SOURCE[key]] || 0;
    if (meter > 0) {
      consumedBytes = meter;
      basis = 'cohesityMeter';
    } else if (key === 'replica' && replicaUsedBytes > 0) {
      consumedBytes = replicaUsedBytes;
      basis = 'usedPhysical';
    } else if (key === 'smartFiles' && smartFilesUsedBytes > 0) {
      consumedBytes = smartFilesUsedBytes;
      basis = 'usedPhysical';
    }
    return {
      key,
      label: TYPE_LABEL[key],
      consumedBytes,
      basis,
      entitledTb: entitled[key] || 0,
    };
  });

  return {
    capturedAt: typeRows[0]?.capturedAt || byCluster[0]?.capturedAt || null,
    edition: settings.licenseEdition,
    expiry: settings.licenseExpiry,
    types,
    totals: {
      consumedFrontEndBytes: types.reduce((s, t) => s + t.consumedBytes, 0),
      physicalBytes: physical,
      capacityBytes: capacity,
      systems: byCluster.length,
    },
    byCluster,
    breakdown: {
      capturedAt: bdRows[0]?.capturedAt || null,
      totals: bdTotals,
      bySystem: breakdownSystems,
    },
  };
}

/**
 * Per-view rows for one system: which views are replicated in vs receiving
 * data, with sizes and creation dates.
 */
function getViewDetail(systemId) {
  return db.prepare(`
    SELECT system_id AS systemId, system_name AS systemName, view_name AS viewName,
           is_read_only AS isReadOnly, created_ms AS createdMs,
           physical_bytes AS physicalBytes, logical_bytes AS logicalBytes,
           data_written_bytes AS dataWrittenBytes, captured_at AS capturedAt
    FROM license_view_detail
    WHERE system_id = ?
    ORDER BY physical_bytes DESC
  `).all(String(systemId));
}

/**
 * Schedule hourly refresh + one refresh shortly after startup.
 */
function initLicensing() {
  cron.schedule('0 * * * *', () => {
    refreshLicensing().catch(e => logger.error('[Licensing] scheduled refresh failed:', e.message));
  });
  refreshLicensing().catch(e => logger.error('[Licensing] initial refresh failed:', e.message));
}

module.exports = { refreshLicensing, getLicensing, getViewDetail, initLicensing };
