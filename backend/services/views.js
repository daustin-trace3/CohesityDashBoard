// Cohesity Views inventory — per Helios-connected cluster, the v2 file-services
// views list (with stats + protecting groups) joined against kView protection
// groups and policies to answer: is this view backed up, and does that backup
// replicate to another cluster? Stored wholesale per refresh (current state,
// not history), mirroring the licensing breakdown tables.
const axios = require('axios');
const cron = require('node-cron');
const db = require('../db/database');
const logger = require('../utils/logger');
const pollerStatus = require('./pollerStatus');
const { buildHeliosClient } = require('./helios');

function clusterClient(apiKey, clusterId) {
  return axios.create({
    baseURL: 'https://helios.cohesity.com',
    timeout: 90000,
    headers: { apiKey, accessClusterId: String(clusterId) },
  });
}

/** Map of protection group name -> does its run replicate to a remote cluster. */
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
    // Most recent run across the view's protection groups.
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

async function fetchAllViews(apiKey) {
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
  if (failed > 0) logger.warn(`[Views] Fetch failed for ${failed} cluster(s) — partial inventory stored.`);
  return { rows, failed, clusterCount: clusters.length };
}

const replaceViews = db.transaction((rows) => {
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

async function refreshViews() {
  pollerStatus.markStart('views', 0);
  const apiKey = require('./settings').getHeliosApiKey();
  if (!apiKey || apiKey.length < 20) {
    logger.warn('[Views] Helios API key not configured — skipping views refresh.');
    pollerStatus.markEnd('views', 0, 'error');
    return { ok: false, reason: 'no_key' };
  }
  try {
    const { rows, failed, clusterCount } = await fetchAllViews(apiKey);
    if (rows.length === 0 && failed === clusterCount && clusterCount > 0) {
      pollerStatus.markEnd('views', 0, 'error');
      return { ok: false, reason: 'all_failed' };
    }
    replaceViews(rows);
    logger.info(`[Views] Refreshed ${rows.length} view(s) across ${clusterCount - failed}/${clusterCount} cluster(s).`);
    pollerStatus.markEnd('views', 0, 'success');
    return { ok: true, count: rows.length };
  } catch (err) {
    logger.warn(`[Views] Refresh failed — previous data kept: ${err.message}`);
    pollerStatus.markEnd('views', 0, 'error');
    return { ok: false, reason: 'error' };
  }
}

function getViews() {
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
    // Same physical basis as the Licensing page's consumption breakdown:
    // writable views ↔ its 'Views (SmartFiles)' column, read-only ↔ 'Replicated Views'.
    consumedWritableBytes: rows.reduce((s, r) => s + (r.isReadOnly ? 0 : (r.consumedBytes || 0)), 0),
    consumedReplicasBytes: rows.reduce((s, r) => s + (r.isReadOnly ? (r.consumedBytes || 0) : 0), 0),
    clusterCount: new Set(rows.map(r => r.systemId)).size,
    capturedAt: rows[0]?.capturedAt || null,
  };
  return { summary, views: rows };
}

function initViews() {
  // Offset from the licensing refresh (top of hour) — both walk every Helios
  // cluster and share the same rate limit.
  cron.schedule('30 * * * *', () => {
    refreshViews().catch(err => logger.error(`[Views] Scheduled refresh failed: ${err.message}`));
  });
  refreshViews().catch(err => logger.error(`[Views] Initial refresh failed: ${err.message}`));
}

module.exports = { refreshViews, getViews, initViews };
