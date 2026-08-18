// Cohesity licensing meters, ported from backend/services/licensing.js.
// db/logger/settings now come from coreApi (every export takes coreApi
// explicitly, dell/aws convention). Deviation: node-cron is not a plugin-sdk
// devDep (only axios has special dispensation for this pack — see api.js
// header) so the hourly schedule is a self-scheduled setInterval started
// from initExtras(coreApi), same pattern as poller.js's retention sweep.
// buildHeliosClient is inlined locally (2-line helper) rather than importing
// it from ./api — WP-A's api.js only kept heliosAllClusters (the sole export
// anything else in that pack calls); duplicating this tiny factory here is
// simpler than asking WP-A to widen its exports.
const axios = require('axios');

const CLUSTER_REPORT = 'storage-consumption-cluster';
const GROUP_REPORT = 'storage-consumption-group';

const LICENSE_TYPES = ['dataProtect', 'replica', 'smartFiles'];
const TYPE_LABEL = { dataProtect: 'DataProtect', replica: 'Replica', smartFiles: 'SmartFiles' };

function buildHeliosClient(apiKey) {
  return axios.create({ baseURL: 'https://helios.cohesity.com', timeout: 30000, headers: { apiKey } });
}

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

async function fetchConsumptionBreakdown(apiKey, coreApi) {
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
  if (failed > 0) coreApi.logger.warn(`[Licensing] Breakdown fetch failed for ${failed} cluster(s) — partial data stored.`);
  return { rows, viewDetail };
}

async function fetchLicenseMeters(apiKey, coreApi) {
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
  if (failed > 0) coreApi.logger.warn(`[Licensing] License meter fetch failed for ${failed} cluster(s) — partial data stored.`);
  return rows;
}

function replaceViewDetail(coreApi, rows) {
  const db = coreApi.db;
  const tx = db.transaction((rows) => {
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
  tx(rows);
}

function replaceMeters(coreApi, rows) {
  const db = coreApi.db;
  const tx = db.transaction((rows) => {
    db.prepare('DELETE FROM license_meter_usage').run();
    const stmt = db.prepare(`
      INSERT INTO license_meter_usage (system_id, system_name, feature, usage_gib, captured_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `);
    for (const r of rows) stmt.run(r.systemId, r.systemName, r.feature, r.usageGib);
  });
  tx(rows);
}

function replaceBreakdown(coreApi, rows) {
  const db = coreApi.db;
  const tx = db.transaction((rows) => {
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
  tx(rows);
}

function replaceLicenseUsage(coreApi, rows) {
  const db = coreApi.db;
  const tx = db.transaction((rows) => {
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
  tx(rows);
}

function replaceTypeUsage(coreApi, buckets) {
  const db = coreApi.db;
  const tx = db.transaction((buckets) => {
    db.prepare('DELETE FROM license_type_usage').run();
    const stmt = db.prepare(`
      INSERT INTO license_type_usage (license_type, front_end_bytes, captured_at)
      VALUES (?, ?, datetime('now'))
    `);
    for (const t of LICENSE_TYPES) stmt.run(t, buckets[t] || 0);
  });
  tx(buckets);
}

async function refreshLicensing(coreApi) {
  coreApi.pollerStatus.markStart('licensing', 0);
  const apiKey = coreApi.settings.getHeliosApiKey();
  if (!apiKey || apiKey.length < 20) {
    coreApi.logger.warn('[Licensing] Helios API key not configured — skipping licensing refresh.');
    coreApi.pollerStatus.markEnd('licensing', 0, 'error');
    return { ok: false, reason: 'no_key' };
  }
  const client = buildHeliosClient(apiKey);
  const legs = [
    { label: 'per-system capacity', run: async () => {
      const systems = await fetchStorageConsumption(client);
      replaceLicenseUsage(coreApi, systems);
      return `${systems.length} system(s)`;
    } },
    { label: 'license-type split', run: async () => {
      const buckets = await fetchTypeConsumption(client);
      replaceTypeUsage(coreApi, buckets);
      return LICENSE_TYPES.map(t => `${TYPE_LABEL[t]}=${(buckets[t] / 1024 ** 4).toFixed(0)}TiB`).join(' ');
    } },
    { label: 'consumption breakdown', run: async () => {
      const breakdown = await fetchConsumptionBreakdown(apiKey, coreApi);
      replaceBreakdown(coreApi, breakdown.rows);
      replaceViewDetail(coreApi, breakdown.viewDetail);
      return `${breakdown.rows.length} rows, ${breakdown.viewDetail.length} views`;
    } },
    { label: 'license meters', run: async () => {
      const meters = await fetchLicenseMeters(apiKey, coreApi);
      replaceMeters(coreApi, meters);
      return `${meters.length} meter rows`;
    } },
  ];
  const results = await Promise.allSettled(legs.map(l => l.run()));
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      failed.push(legs[i].label);
      coreApi.logger.warn(`[Licensing] Refresh leg '${legs[i].label}' failed — previous data kept: ${r.reason?.message || r.reason}`);
    }
  });
  if (failed.length === legs.length) {
    coreApi.pollerStatus.markEnd('licensing', 0, 'error');
    return { ok: false, reason: 'all_failed', failed };
  }
  coreApi.logger.info(`[Licensing] Refreshed ${legs.length - failed.length}/${legs.length} sources; ` +
    results.map((r, i) => `${legs[i].label}: ${r.status === 'fulfilled' ? r.value : 'FAILED'}`).join('; '));
  coreApi.pollerStatus.markEnd('licensing', 0, 'success');
  return { ok: true, failed };
}

function getLicensing(coreApi) {
  const db = coreApi.db;
  const settings = coreApi.settings.getLicenseSettings();
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

function getViewDetail(systemId, coreApi) {
  return coreApi.db.prepare(`
    SELECT system_id AS systemId, system_name AS systemName, view_name AS viewName,
           is_read_only AS isReadOnly, created_ms AS createdMs,
           physical_bytes AS physicalBytes, logical_bytes AS logicalBytes,
           data_written_bytes AS dataWrittenBytes, captured_at AS capturedAt
    FROM license_view_detail
    WHERE system_id = ?
    ORDER BY physical_bytes DESC
  `).all(String(systemId));
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Schedule hourly refresh + one refresh shortly after init. Demo-inert: never
 * scheduled under DASHBOARD_DEMO==='1' (seed data comes from WP-A's demoSeed).
 */
function initLicensing(coreApi) {
  if (process.env.DASHBOARD_DEMO === '1') return;
  setInterval(() => {
    refreshLicensing(coreApi).catch(e => coreApi.logger.error('[Licensing] scheduled refresh failed:', e.message));
  }, HOUR_MS);
  refreshLicensing(coreApi).catch(e => coreApi.logger.error('[Licensing] initial refresh failed:', e.message));
}

module.exports = { refreshLicensing, getLicensing, getViewDetail, initLicensing };
