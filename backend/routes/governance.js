const express = require('express');
const db = require('../db/database');

const router = express.Router();

function parseJsonArray(s) {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * GET /api/governance
 * Policy audit, unprotected-source audit, and software version drift —
 * computed entirely from locally stored snapshots.
 */
router.get('/', (req, res, next) => {
  try {
    // ── Policies + audit flags ─────────────────────────────────────────────
    const policyRows = db.prepare(`
      SELECT p.*, c.name AS cluster_name
      FROM policies p
      JOIN clusters c ON p.cluster_id = c.id
      ORDER BY p.name, c.name
    `).all();

    const policies = policyRows.map(p => {
      const replicationTargets = parseJsonArray(p.replication_targets);
      const archivalTargets = parseJsonArray(p.archival_targets);
      return {
        clusterId: p.cluster_id,
        clusterName: p.cluster_name,
        policyId: p.policy_id,
        name: p.name,
        retentionDays: p.retention_days,
        replicationTargets,
        archivalTargets,
        dataLock: !!p.datalock,
        noOffsiteCopy: replicationTargets.length === 0 && archivalTargets.length === 0,
        capturedAt: p.captured_at,
      };
    });

    // Retention drift: same policy name on multiple clusters with different retention.
    // Cohesity's canned built-in policies are skipped — operators can't align them.
    const BUILTIN_POLICY_NAMES = new Set(['protect once']);
    const byName = new Map();
    for (const p of policies) {
      if (!p.name) continue;
      if (BUILTIN_POLICY_NAMES.has(p.name.trim().toLowerCase())) continue;
      if (!byName.has(p.name)) byName.set(p.name, []);
      byName.get(p.name).push(p);
    }
    const retentionDrift = [];
    for (const [name, group] of byName) {
      const retentions = [...new Set(group.map(p => p.retentionDays).filter(v => v != null))];
      if (group.length > 1 && retentions.length > 1) {
        retentionDrift.push({
          name,
          variants: group.map(p => ({
            clusterName: p.clusterName,
            retentionDays: p.retentionDays,
          })),
        });
      }
    }

    // ── Unprotected sources ────────────────────────────────────────────────
    const sources = db.prepare(`
      SELECT s.*, c.name AS cluster_name
      FROM source_registrations s
      JOIN clusters c ON s.cluster_id = c.id
      ORDER BY s.unprotected_count DESC, c.name
    `).all().map(s => ({
      clusterId: s.cluster_id,
      clusterName: s.cluster_name,
      sourceId: s.source_id,
      sourceName: s.source_name,
      environment: s.environment,
      protectedCount: s.protected_count,
      unprotectedCount: s.unprotected_count,
      protectedBytes: s.protected_bytes,
      unprotectedBytes: s.unprotected_bytes,
      capturedAt: s.captured_at,
    }));

    const totalUnprotected = sources.reduce((sum, s) => sum + (s.unprotectedCount || 0), 0);
    const totalProtected = sources.reduce((sum, s) => sum + (s.protectedCount || 0), 0);

    // ── Version drift ──────────────────────────────────────────────────────
    const versionRows = db.prepare(`
      SELECT c.id AS cluster_id, c.name AS cluster_name, m.software_version
      FROM clusters c
      LEFT JOIN metrics_history m ON m.id = (
        SELECT id FROM metrics_history
        WHERE cluster_id = c.id AND software_version IS NOT NULL
        ORDER BY captured_at DESC LIMIT 1
      )
      ORDER BY c.name
    `).all();

    const versionCounts = new Map();
    for (const r of versionRows) {
      if (!r.software_version) continue;
      versionCounts.set(r.software_version, (versionCounts.get(r.software_version) || 0) + 1);
    }
    let dominantVersion = null;
    let dominantCount = 0;
    for (const [v, count] of versionCounts) {
      if (count > dominantCount) { dominantVersion = v; dominantCount = count; }
    }

    const versions = versionRows.map(r => ({
      clusterId: r.cluster_id,
      clusterName: r.cluster_name,
      softwareVersion: r.software_version,
      isOutlier: !!(r.software_version && dominantVersion && r.software_version !== dominantVersion),
    }));

    // ── Views audit ────────────────────────────────────────────────────────
    // Writable views only: read-only views are replicas whose protection,
    // replication, and DataLock are governed at the source cluster.
    const auditViews = db.prepare(`
      SELECT system_id AS systemId, system_name AS systemName, name, category,
             protocols, protected, replicated_out AS replicatedOut,
             datalock_mode AS datalockMode, consumed_bytes AS consumedBytes,
             created_ms AS createdMs, captured_at AS capturedAt
      FROM cohesity_views
      WHERE is_read_only = 0
      ORDER BY system_name, name
    `).all().map(v => ({
      ...v,
      noBackup: !v.protected,
      noReplication: !v.replicatedOut,
      noDatalock: !v.datalockMode,
    }));
    const viewsAudit = {
      totalWritable: auditViews.length,
      noBackupCount: auditViews.filter(v => v.noBackup).length,
      noReplicationCount: auditViews.filter(v => v.noReplication).length,
      noDatalockCount: auditViews.filter(v => v.noDatalock).length,
      views: auditViews.filter(v => v.noBackup || v.noReplication || v.noDatalock),
    };

    // ── Agent versions (physical sources) ─────────────────────────────────
    // "Current" = the newest agent version seen anywhere in the fleet,
    // ordered by parsed semver then embedded release date.
    const agentRows = db.prepare(`
      SELECT a.*, c.name AS cluster_name
      FROM cohesity_agents a JOIN clusters c ON c.id = a.cluster_id
      ORDER BY c.name, a.name
    `).all();
    const versionKey = (v) => {
      const m = String(v || '').match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:_u(\d+))?/);
      const d = String(v || '').match(/release-(\d{8})/);
      return [m ? +m[1] : 0, m ? +m[2] : 0, m?.[3] ? +m[3] : 0, m?.[4] ? +m[4] : 0, d ? +d[1] : 0];
    };
    let latestAgentVersion = null;
    for (const r of agentRows) {
      if (!r.agent_version) continue;
      if (!latestAgentVersion) { latestAgentVersion = r.agent_version; continue; }
      const a = versionKey(r.agent_version), b = versionKey(latestAgentVersion);
      for (let i = 0; i < a.length; i++) {
        if (a[i] > b[i]) { latestAgentVersion = r.agent_version; break; }
        if (a[i] < b[i]) break;
      }
    }
    const agents = agentRows.map(r => ({
      clusterName: r.cluster_name,
      sourceId: r.source_id,
      name: r.name,
      hostType: r.host_type,
      osName: r.os_name,
      agentVersion: r.agent_version,
      agentStatus: r.agent_status,
      upgradability: r.upgradability,
      isCurrent: !!(r.agent_version && latestAgentVersion && r.agent_version === latestAgentVersion),
    }));

    res.json({
      generatedAt: new Date().toISOString(),
      summary: {
        policyCount: policies.length,
        noOffsiteCopyCount: policies.filter(p => p.noOffsiteCopy).length,
        retentionDriftCount: retentionDrift.length,
        totalUnprotected,
        totalProtected,
        versionSpread: versionCounts.size,
        dominantVersion,
      },
      policies,
      retentionDrift,
      sources,
      versions,
      viewsAudit,
      agentsAudit: {
        latestVersion: latestAgentVersion,
        total: agents.length,
        outdated: agents.filter(a => !a.isCurrent).length,
        agents,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
