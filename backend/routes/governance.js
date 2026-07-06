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
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
