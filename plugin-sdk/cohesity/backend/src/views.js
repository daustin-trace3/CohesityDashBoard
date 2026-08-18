// Cohesity Views inventory, ported from backend/services/views.js. db/logger/
// settings via coreApi; node-cron replaced by a self-scheduled setInterval
// from initExtras(coreApi) — see licensing.js header for why. buildHeliosClient
// inlined locally (same reasoning as licensing.js).
const axios = require('axios');

function buildHeliosClient(apiKey) {
  return axios.create({ baseURL: 'https://helios.cohesity.com', timeout: 30000, headers: { apiKey } });
}

function clusterClient(apiKey, clusterId) {
  return axios.create({
    baseURL: 'https://helios.cohesity.com',
    timeout: 90000,
    headers: { apiKey, accessClusterId: String(clusterId) },
  });
}

async function fetchGroupReplication(client) {
  const replicates = new Map();
  const policyHasRepl = new Map();
  try {
    const { data } = await client.get('/v2/data-protect/policies', { timeout: 60000 });
    for (const p of (data?.policies || [])) {
      policyHasRepl.set(p.id, (p.remoteTargetPolicy?.replicationTargets || []).length > 0);
    }
  } catch { /* policies unavailable — fall back to group replicationParams only */ }
  try {
    const { data } = await client.get('/v2/data-protect/protection-groups?environments=kView&isDeleted=false', { timeout: 60000 });
    for (const g of (data?.protectionGroups || [])) {
      const viaParams = !!g.viewParams?.replicationParams;
      replicates.set(g.name, viaParams || policyHasRepl.get(g.policyId) === true);
    }
  } catch { /* groups unavailable — views still report protected via viewProtection */ }
  return replicates;
}

async function fetchClusterViews(apiKey, cluster) {
  const client = clusterClient(apiKey, cluster.clusterId);
  const { data } = await client.get(
    '/v2/file-services/views?maxCount=2000&includeStats=true&includeProtectionGroups=true',
    { timeout: 90000 }
  );
  const views = data?.views || [];
  if (views.length === 0) return [];
  const groupReplicates = await fetchGroupReplication(client);

  return views.map(v => {
    const groups = (v.viewProtection?.protectionGroups || []);
    const groupNames = groups.map(g => g.groupName).filter(Boolean);
    const lastRun = groups
      .map(g => g.lastRun?.localBackupInfo)
      .filter(Boolean)
      .sort((a, b) => (b.startTimeUsecs || 0) - (a.startTimeUsecs || 0))[0] || null;
    const stats = v.stats?.dataUsageStats || {};
    return {
      systemId: String(cluster.clusterId),
      systemName: cluster.name || null,
      viewId: v.viewId ?? null,
      name: v.name,
      category: v.category || null,
      storageDomain: v.storageDomainName || null,
      protocols: (v.protocolAccess || []).map(p => (p.type || String(p)).replace(/^k/, '')).join(','),
      isReadOnly: v.isReadOnly ? 1 : 0,
      protected: groupNames.length > 0 ? 1 : 0,
      protectionGroups: groupNames.length ? JSON.stringify(groupNames) : null,
      replicatedOut: groupNames.some(n => groupReplicates.get(n)) ? 1 : 0,
      lastBackupStatus: lastRun?.status || null,
      lastBackupMs: lastRun?.startTimeUsecs ? Math.round(lastRun.startTimeUsecs / 1000) : null,
      datalockMode: v.fileLockConfig?.mode || null,
      datalockRetentionMs: v.fileLockConfig?.defaultRetentionDurationMsecs ?? null,
      logicalBytes: stats.totalLogicalUsageBytes ?? null,
      consumedBytes: stats.storageConsumedBytes ?? null,
      dataInBytes: stats.dataInBytes ?? null,
      dataWrittenBytes: stats.dataWrittenBytes ?? null,
      fileCount: stats.numFiles ?? null,
      createdMs: v.createTimeMsecs ?? null,
    };
  });
}

async function fetchAllViews(apiKey, coreApi) {
  const helios = buildHeliosClient(apiKey);
  const { data } = await helios.get('/mcm/clusters/connectionStatus');
  const clusters = (Array.isArray(data) ? data : []).filter(c => c.connectedToCluster);

  const rows = [];
  let failed = 0;
  const CONCURRENCY = 4;
  for (let i = 0; i < clusters.length; i += CONCURRENCY) {
    const batch = clusters.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(c => fetchClusterViews(apiKey, c)));
    for (const r of results) {
      if (r.status === 'fulfilled') rows.push(...r.value);
      else failed += 1;
    }
  }
  if (failed > 0) coreApi.logger.warn(`[Views] Fetch failed for ${failed} cluster(s) — partial inventory stored.`);
  return { rows, failed, clusterCount: clusters.length };
}

function replaceViews(coreApi, rows) {
  const db = coreApi.db;
  const tx = db.transaction((rows) => {
    db.prepare('DELETE FROM cohesity_views').run();
    const stmt = db.prepare(`
      INSERT INTO cohesity_views
        (system_id, system_name, view_id, name, category, storage_domain, protocols,
         is_read_only, protected, protection_groups, replicated_out,
         last_backup_status, last_backup_ms, datalock_mode, datalock_retention_ms,
         logical_bytes, consumed_bytes,
         data_in_bytes, data_written_bytes, file_count, created_ms, captured_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    for (const r of rows) {
      stmt.run(r.systemId, r.systemName, r.viewId, r.name, r.category, r.storageDomain,
        r.protocols, r.isReadOnly, r.protected, r.protectionGroups, r.replicatedOut,
        r.lastBackupStatus, r.lastBackupMs, r.datalockMode, r.datalockRetentionMs,
        r.logicalBytes, r.consumedBytes,
        r.dataInBytes, r.dataWrittenBytes, r.fileCount, r.createdMs);
    }
  });
  tx(rows);
}

async function refreshViews(coreApi) {
  coreApi.pollerStatus.markStart('views', 0);
  const apiKey = coreApi.settings.getHeliosApiKey();
  if (!apiKey || apiKey.length < 20) {
    coreApi.logger.warn('[Views] Helios API key not configured — skipping views refresh.');
    coreApi.pollerStatus.markEnd('views', 0, 'error');
    return { ok: false, reason: 'no_key' };
  }
  try {
    const { rows, failed, clusterCount } = await fetchAllViews(apiKey, coreApi);
    if (rows.length === 0 && failed === clusterCount && clusterCount > 0) {
      coreApi.pollerStatus.markEnd('views', 0, 'error');
      return { ok: false, reason: 'all_failed' };
    }
    replaceViews(coreApi, rows);
    coreApi.logger.info(`[Views] Refreshed ${rows.length} view(s) across ${clusterCount - failed}/${clusterCount} cluster(s).`);
    coreApi.pollerStatus.markEnd('views', 0, 'success');
    return { ok: true, count: rows.length };
  } catch (err) {
    coreApi.logger.warn(`[Views] Refresh failed — previous data kept: ${err.message}`);
    coreApi.pollerStatus.markEnd('views', 0, 'error');
    return { ok: false, reason: 'error' };
  }
}

function getViews(coreApi) {
  const db = coreApi.db;
  const rows = db.prepare(`
    SELECT system_id AS systemId, system_name AS systemName, view_id AS viewId,
           name, category, storage_domain AS storageDomain, protocols,
           is_read_only AS isReadOnly, protected, protection_groups AS protectionGroups,
           replicated_out AS replicatedOut, last_backup_status AS lastBackupStatus,
           last_backup_ms AS lastBackupMs, datalock_mode AS datalockMode,
           datalock_retention_ms AS datalockRetentionMs, logical_bytes AS logicalBytes,
           consumed_bytes AS consumedBytes, data_in_bytes AS dataInBytes,
           data_written_bytes AS dataWrittenBytes, file_count AS fileCount,
           created_ms AS createdMs, captured_at AS capturedAt
    FROM cohesity_views
    ORDER BY system_name, name
  `).all().map(r => ({ ...r, protectionGroups: r.protectionGroups ? JSON.parse(r.protectionGroups) : [] }));

  const summary = {
    total: rows.length,
    protected: rows.filter(r => r.protected).length,
    replicatedOut: rows.filter(r => r.replicatedOut).length,
    replicasIn: rows.filter(r => r.isReadOnly).length,
    unprotectedWritable: rows.filter(r => !r.protected && !r.isReadOnly).length,
    dataLocked: rows.filter(r => r.datalockMode).length,
    logicalBytes: rows.reduce((s, r) => s + (r.logicalBytes || 0), 0),
    consumedBytes: rows.reduce((s, r) => s + (r.consumedBytes || 0), 0),
    consumedWritableBytes: rows.reduce((s, r) => s + (r.isReadOnly ? 0 : (r.consumedBytes || 0)), 0),
    consumedReplicasBytes: rows.reduce((s, r) => s + (r.isReadOnly ? (r.consumedBytes || 0) : 0), 0),
    clusterCount: new Set(rows.map(r => r.systemId)).size,
    capturedAt: rows[0]?.capturedAt || null,
  };
  return { summary, views: rows };
}

const HOUR_MS = 60 * 60 * 1000;

/** Demo-inert: never scheduled under DASHBOARD_DEMO==='1'. */
function initViews(coreApi) {
  if (process.env.DASHBOARD_DEMO === '1') return;
  setInterval(() => {
    refreshViews(coreApi).catch(err => coreApi.logger.error(`[Views] Scheduled refresh failed: ${err.message}`));
  }, HOUR_MS);
  refreshViews(coreApi).catch(err => coreApi.logger.error(`[Views] Initial refresh failed: ${err.message}`));
}

module.exports = { refreshViews, getViews, initViews };
