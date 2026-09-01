// Computed Brocade SAN issues (shared by routes and the poller) plus their
// lifecycle history — unifiIssues.js model. Issue identity is
// `type|source|target` — stable across polls even as the message text
// changes. Contract §5 (14 rules).
const db = require('../db/database');
const { getSetting } = require('./settings');

function clampedInt(key, def, min, max) {
  const n = Number(getSetting(key));
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : def;
}

const healthWarnScore = () => clampedInt('brocade_health_warn_score', 70, 1, 100);
const healthCritScore = () => clampedInt('brocade_health_crit_score', 50, 1, 100);
const certWarnDays = () => clampedInt('brocade_cert_warn_days', 60, 1, 365);
const eventStormCount = () => clampedInt('brocade_event_storm_count', 10, 1, 1000);
const eventRetentionDays = () => clampedInt('brocade_event_retention_days', 30, 1, 365);

const thresholdGetters = {
  brocadeHealthWarnScore: healthWarnScore,
  brocadeHealthCritScore: healthCritScore,
  brocadeCertWarnDays: certWarnDays,
  brocadeEventStormCount: eventStormCount,
  brocadeEventRetentionDays: eventRetentionDays,
};

// management_state bitmask (AdditionalSwitchInfo, int64) — the bits relevant
// to the mgmt-state issue rule.
const MGMT_BITS = {
  4: 'invalid credentials',
  16: 'not reachable',
  32: 'not manageable',
  128: 'VF list not visible',
  512: 'max session limit reached',
  32768: 'trap registration failed',
};

function decodeMgmtState(bitmask) {
  if (bitmask == null) return [];
  const labels = [];
  for (const [bit, label] of Object.entries(MGMT_BITS)) {
    // eslint-disable-next-line no-bitwise
    if (Number(bitmask) & Number(bit)) labels.push(label);
  }
  return labels;
}

const FABRIC_STATUS = { 2: { label: 'Marginal', severity: 'warning' }, 3: { label: 'Down', severity: 'critical' }, 6: { label: 'Unreachable', severity: 'critical' }, 7: { label: 'Degraded link', severity: 'warning' } };

function computeIssues() {
  const issues = [];
  const sources = db.prepare('SELECT * FROM brocade_sources').all();
  const srcName = new Map(sources.map((s) => [s.id, s.name]));

  // Rule 14: poll_failed
  for (const src of sources) {
    if (src.last_poll_status === 'error') {
      issues.push({ sourceId: src.id, source: src.name, type: 'poll_failed', target: src.name, severity: 'warning', message: src.last_poll_error || 'poll failed' });
    }
  }

  const switches = db.prepare('SELECT * FROM brocade_switches WHERE stale = 0').all();

  // Rule 1: switch_critical
  for (const sw of switches) {
    const source = srcName.get(sw.source_id) || `source ${sw.source_id}`;
    const opStatus = (sw.operational_status || '').toUpperCase();
    if (opStatus === 'CRITICAL') {
      issues.push({ sourceId: sw.source_id, source, type: 'switch_critical', target: sw.name || sw.wwn, severity: 'critical', message: `Switch ${sw.name || sw.wwn} is CRITICAL${sw.status_reason ? `: ${sw.status_reason}` : ''}` });
    } else if (opStatus === 'MARGINAL') {
      issues.push({ sourceId: sw.source_id, source, type: 'switch_critical', target: sw.name || sw.wwn, severity: 'warning', message: `Switch ${sw.name || sw.wwn} is MARGINAL${sw.status_reason ? `: ${sw.status_reason}` : ''}` });
    }
  }

  // Rule 2: switch_unreachable
  for (const sw of switches) {
    const source = srcName.get(sw.source_id) || `source ${sw.source_id}`;
    // eslint-disable-next-line no-bitwise
    const unreachableBit = sw.management_state != null && (Number(sw.management_state) & 16);
    if (unreachableBit || sw.is_missing === 1) {
      issues.push({ sourceId: sw.source_id, source, type: 'switch_unreachable', target: sw.name || sw.wwn, severity: 'critical', message: `Switch ${sw.name || sw.wwn} is unreachable/missing` });
    }
  }

  // Rule 3: switch_mgmt_state
  for (const sw of switches) {
    const source = srcName.get(sw.source_id) || `source ${sw.source_id}`;
    const labels = decodeMgmtState(sw.management_state).filter((l) => l !== 'not reachable');
    if (labels.length) {
      issues.push({ sourceId: sw.source_id, source, type: 'switch_mgmt_state', target: sw.name || sw.wwn, severity: 'warning', message: `Switch ${sw.name || sw.wwn} management state: ${labels.join(', ')}` });
    }
  }

  // Rule 4: fabric_unhealthy
  const fabrics = db.prepare('SELECT * FROM brocade_fabrics WHERE stale = 0').all();
  for (const f of fabrics) {
    const source = srcName.get(f.source_id) || `source ${f.source_id}`;
    const info = FABRIC_STATUS[f.status];
    if (info) {
      issues.push({ sourceId: f.source_id, source, type: 'fabric_unhealthy', target: f.name, severity: info.severity, message: `Fabric ${f.name} is ${info.label}` });
    }
  }

  // Rule 5: health_score_low
  const warnScore = healthWarnScore();
  const critScore = healthCritScore();
  for (const h of db.prepare('SELECT * FROM brocade_health_scores WHERE stale = 0').all()) {
    const source = srcName.get(h.source_id) || `source ${h.source_id}`;
    if (h.score == null) continue;
    if (h.score < critScore) {
      issues.push({ sourceId: h.source_id, source, type: 'health_score_low', target: h.entity_name || h.entity_guid, severity: 'critical', message: `${h.entity_type} ${h.entity_name} health score ${h.score} (critical)` });
    } else if (h.score < warnScore) {
      issues.push({ sourceId: h.source_id, source, type: 'health_score_low', target: h.entity_name || h.entity_guid, severity: 'warning', message: `${h.entity_type} ${h.entity_name} health score ${h.score} (warning)` });
    }
  }

  // Rule 6: port_fenced
  for (const p of db.prepare('SELECT * FROM brocade_switch_ports WHERE stale = 0 AND (fenced = 1 OR blocked = 1)').all()) {
    const source = srcName.get(p.source_id) || `source ${p.source_id}`;
    const target = `${p.switch_name || p.switch_wwn} port ${p.name || p.port_number}`;
    issues.push({ sourceId: p.source_id, source, type: 'port_fenced', target, severity: 'warning', message: `Port ${target} is ${p.fenced ? 'fenced' : 'blocked'}` });
  }

  // Rule 7: cert_expiring (switches + chassis)
  const warnDays = certWarnDays();
  const warnMs = warnDays * 86400000;
  const now = Date.now();
  for (const sw of switches) {
    if (sw.tls_cert_expiry_ms == null) continue;
    const source = srcName.get(sw.source_id) || `source ${sw.source_id}`;
    const delta = sw.tls_cert_expiry_ms - now;
    if (delta <= 0) {
      issues.push({ sourceId: sw.source_id, source, type: 'cert_expiring', target: sw.name || sw.wwn, severity: 'critical', message: `TLS certificate on ${sw.name || sw.wwn} has expired` });
    } else if (delta <= warnMs) {
      issues.push({ sourceId: sw.source_id, source, type: 'cert_expiring', target: sw.name || sw.wwn, severity: 'warning', message: `TLS certificate on ${sw.name || sw.wwn} expires in ${Math.ceil(delta / 86400000)}d` });
    }
  }
  for (const c of db.prepare('SELECT * FROM brocade_chassis WHERE stale = 0').all()) {
    if (c.tls_cert_expiry_ms == null) continue;
    const source = srcName.get(c.source_id) || `source ${c.source_id}`;
    const delta = c.tls_cert_expiry_ms - now;
    if (delta <= 0) {
      issues.push({ sourceId: c.source_id, source, type: 'cert_expiring', target: c.name || c.wwn, severity: 'critical', message: `TLS certificate on chassis ${c.name || c.wwn} has expired` });
    } else if (delta <= warnMs) {
      issues.push({ sourceId: c.source_id, source, type: 'cert_expiring', target: c.name || c.wwn, severity: 'warning', message: `TLS certificate on chassis ${c.name || c.wwn} expires in ${Math.ceil(delta / 86400000)}d` });
    }
  }

  // Rule 8: switch_eos — SANnav's flag OR derived from the Broadcom FOS
  // lifecycle table (SANnav <2.3.1 never reports eosStatus).
  const { lifecycleFor } = require('./brocadeFosLifecycle');
  for (const sw of switches) {
    const lc = lifecycleFor(sw.firmware_version, sw.eos_status);
    if (lc.isEos) {
      const source = srcName.get(sw.source_id) || `source ${sw.source_id}`;
      const since = lc.eosDate ? ` (EOS since ${lc.eosDate})` : '';
      issues.push({ sourceId: sw.source_id, source, type: 'switch_eos', target: sw.name || sw.wwn, severity: 'warning', message: `Switch ${sw.name || sw.wwn} firmware ${sw.firmware_version || ''} is End of Support${since}` });
    }
  }

  // Rule 9: firmware_drift — >1 distinct firmware_version among non-stale
  // switches in the same fabric.
  const byFabric = new Map(); // `${sourceId}|${fabricName}` -> Set(firmware)
  for (const sw of switches) {
    if (!sw.fabric_name || !sw.firmware_version) continue;
    const key = `${sw.source_id}|${sw.fabric_name}`;
    if (!byFabric.has(key)) byFabric.set(key, new Set());
    byFabric.get(key).add(sw.firmware_version);
  }
  for (const [key, versions] of byFabric) {
    if (versions.size <= 1) continue;
    const [sourceIdStr, fabricName] = key.split('|');
    const source = srcName.get(Number(sourceIdStr)) || `source ${sourceIdStr}`;
    issues.push({ sourceId: Number(sourceIdStr), source, type: 'firmware_drift', target: fabricName, severity: 'info', message: `Fabric ${fabricName} has firmware drift: ${[...versions].join(', ')}` });
  }

  // Rule 10: zone_default_access
  for (const zc of db.prepare('SELECT * FROM brocade_zone_configs WHERE stale = 0 AND is_effective = 1 AND default_zone_access = 1').all()) {
    const source = srcName.get(zc.source_id) || `source ${zc.source_id}`;
    issues.push({ sourceId: zc.source_id, source, type: 'zone_default_access', target: zc.fabric_name, severity: 'warning', message: `Fabric ${zc.fabric_name} effective zone config "${zc.cfg_name}" allows All Access` });
  }

  // Rule 11: zone_drift — one issue per fabric with a change in the last 24h.
  const zoneDriftFabrics = db.prepare(`
    SELECT source_id, fabric_name, MAX(detected_at) last FROM brocade_zone_changes
    WHERE detected_at >= datetime('now', '-1 day') GROUP BY source_id, fabric_name
  `).all();
  for (const zd of zoneDriftFabrics) {
    const source = srcName.get(zd.source_id) || `source ${zd.source_id}`;
    issues.push({ sourceId: zd.source_id, source, type: 'zone_drift', target: zd.fabric_name, severity: 'info', message: `Zoning changed on fabric ${zd.fabric_name} within the last 24h` });
  }

  // Rule 12: maintenance_mode
  for (const sw of switches) {
    if (sw.maintenance_mode === 1) {
      const source = srcName.get(sw.source_id) || `source ${sw.source_id}`;
      issues.push({ sourceId: sw.source_id, source, type: 'maintenance_mode', target: sw.name || sw.wwn, severity: 'info', message: `Switch ${sw.name || sw.wwn} is in maintenance mode` });
    }
  }

  // Rule 13: event_storm — critical/alert severity events in the last hour
  // >= threshold, per source.
  const stormCount = eventStormCount();
  const stormRows = db.prepare(`
    SELECT source_id, COUNT(*) n FROM brocade_events
    WHERE severity_norm IN ('critical', 'alert') AND last_occurred_ms >= ?
    GROUP BY source_id HAVING n >= ?
  `).all(Date.now() - 3600000, stormCount);
  for (const r of stormRows) {
    const source = srcName.get(r.source_id) || `source ${r.source_id}`;
    issues.push({ sourceId: r.source_id, source, type: 'event_storm', target: source, severity: 'warning', message: `${r.n} critical/alert events in the last hour on ${source}` });
  }

  const order = { critical: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}

const issueKey = (i) => `${i.type}|${i.source}|${i.target}`;

/**
 * Sync the computed issue set into brocade_issue_history: new issues open a
 * row, still-present ones bump last_seen, and open rows whose issue is gone
 * get resolved. Idempotent — safe to run after every poll.
 */
const reconcileIssueHistory = db.transaction(() => {
  const current = new Map(computeIssues().map((i) => [issueKey(i), i]));
  const open = db.prepare('SELECT * FROM brocade_issue_history WHERE resolved_at IS NULL').all();

  const touch = db.prepare(`UPDATE brocade_issue_history SET last_seen = datetime('now'), message = ?, severity = ? WHERE id = ?`);
  const resolve = db.prepare(`UPDATE brocade_issue_history SET resolved_at = datetime('now'), last_seen = datetime('now') WHERE id = ?`);
  const insert = db.prepare(`
    INSERT INTO brocade_issue_history (source_id, source, type, target, severity, message, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `);

  const openKeys = new Set();
  for (const row of open) {
    const key = `${row.type}|${row.source}|${row.target}`;
    const cur = current.get(key);
    if (cur) {
      openKeys.add(key);
      touch.run(cur.message, cur.severity, row.id);
    } else {
      resolve.run(row.id);
    }
  }
  for (const [key, i] of current) {
    if (!openKeys.has(key)) insert.run(i.sourceId ?? null, i.source, i.type, i.target, i.severity, i.message);
  }
});

module.exports = {
  healthWarnScore, healthCritScore, certWarnDays, eventStormCount, eventRetentionDays,
  thresholdGetters,
  decodeMgmtState,
  computeIssues,
  reconcileIssueHistory,
};
