// Pure1 SaaS poller — one account-wide global task (mirrors zertoPoller.js).
// Pure1's REST API is fleet-wide (no per-source connections to schedule);
// current-state tables are replaced wholesale per poll, and an account-level
// snapshot is appended to pure1_metrics_history so the platform switcher's
// health bubble (routes/poller.js) has something to key off of instead of
// always reading grey.
const db = require('../db/database');
const cron = require('node-cron');
const { createGlobalTask } = require('../core/pollerFramework');
const { getSetting } = require('./settings');
const { isDemo } = require('./demoMode');
const pure1Api = require('./pure1Api');
const logger = require('../utils/logger');

const replaceArrays = db.transaction((rows, enrichment) => {
  db.prepare('DELETE FROM pure1_arrays').run();
  const stmt = db.prepare(`
    INSERT INTO pure1_arrays (pure1_id, name, fqdn, model, os, version,
      capacity_bytes, used_bytes, data_reduction, effective_used_bytes,
      volume_bytes, shared_bytes, snapshots_bytes, provisioned_bytes,
      health, health_detail, chassis_serial, controller_serials, tags, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  for (const r of rows) {
    if (!r.id) continue;
    const en = enrichment[r.id] || null;
    stmt.run(
      r.id, r.name || null, r.fqdn || null, r.model || null, r.os || null, r.version || null,
      r.total || null, r.used || null, r.dataReduction || null, r.effectiveUsed || null,
      r.volumeSpace || null, r.sharedSpace || null, r.snapshotSpace || null,
      en ? en.provisioned || null : null,
      en ? en.health || null : null,
      en ? JSON.stringify({ unhealthy: en.unhealthy }) : null,
      en ? en.chassisSerial || null : null,
      en ? JSON.stringify(en.controllerSerials || []) : null,
      JSON.stringify(r.tags || [])
    );
  }
});

const replaceAlerts = db.transaction((alerts) => {
  db.prepare('DELETE FROM pure1_alerts').run();
  const stmt = db.prepare(`
    INSERT INTO pure1_alerts (pure1_alert_id, array_name, array_fqdn, severity,
      category, component_type, component_name, summary, code, state,
      flagged, created_at_ms, updated_at_ms, knowledge_base_url, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, datetime('now'))
  `);
  for (const a of alerts) {
    if (!a.id) continue;
    stmt.run(
      a.id, a.arrayName || null, a.arrayFqdn || null, a.severity || null,
      a.category || null, a.componentType || null, a.component || null,
      a.summary || null, a.code ?? null, a.state || null,
      a.created ?? null, a.updated ?? null, a.knowledgeBaseUrl || null
    );
  }
});

const replacePods = db.transaction((pods) => {
  db.prepare('DELETE FROM pure1_pods').run();
  const stmt = db.prepare(`
    INSERT INTO pure1_pods (pure1_pod_id, name, mediator, arrays, captured_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);
  for (const p of pods) {
    stmt.run(p.id || null, p.name || null, p.mediator || null, JSON.stringify(p.arrays || []));
  }
});

function appendSnapshot(rows, alerts) {
  const arraysWarn = rows.filter((r) => r._health === 'warn').length;
  const arraysCrit = rows.filter((r) => r._health === 'crit').length;
  db.prepare(`
    INSERT INTO pure1_metrics_history (array_count, arrays_warn, arrays_crit,
      total_capacity_bytes, total_used_bytes, open_alerts)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    rows.length, arraysWarn, arraysCrit,
    rows.reduce((s, r) => s + (r.total || 0), 0),
    rows.reduce((s, r) => s + (r.used || 0), 0),
    alerts.length
  );
  db.prepare("DELETE FROM pure1_metrics_history WHERE captured_at < datetime('now', '-365 days')").run();
}

async function refreshAll() {
  if (!pure1Api.isConfigured() || isDemo()) {
    logger.debug('[Pure1Poller] Skipping poll — not configured or demo mode');
    return;
  }
  const rows = await pure1Api.getOverview({ force: true });

  let enrichment = {};
  try {
    enrichment = await pure1Api.getEnrichment({ force: true });
  } catch (err) {
    logger.error('[Pure1Poller] Enrichment fetch failed, keeping last-good health:', err.message);
    for (const row of db.prepare('SELECT pure1_id, health, health_detail, chassis_serial, controller_serials, provisioned_bytes FROM pure1_arrays').all()) {
      enrichment[row.pure1_id] = {
        health: row.health,
        unhealthy: row.health_detail ? (JSON.parse(row.health_detail).unhealthy ?? 0) : 0,
        chassisSerial: row.chassis_serial,
        controllerSerials: row.controller_serials ? JSON.parse(row.controller_serials) : [],
        provisioned: row.provisioned_bytes,
      };
    }
  }

  let alerts = [];
  try {
    alerts = await pure1Api.getAlerts({ force: true });
  } catch (err) {
    logger.error('[Pure1Poller] Alerts fetch failed, keeping last-good:', err.message);
    alerts = db.prepare('SELECT * FROM pure1_alerts').all().map((a) => ({ id: a.pure1_alert_id }));
  }

  try {
    const pods = await pure1Api.fetchPods();
    replacePods(pods);
  } catch (err) {
    logger.error('[Pure1Poller] Pods fetch failed, keeping last-good:', err.message);
  }

  const rowsForSnapshot = rows.map((r) => ({ ...r, _health: enrichment[r.id] ? enrichment[r.id].health : null }));
  const priorPerf = new Map(db.prepare(`
    SELECT pure1_id, read_iops, write_iops, read_latency_us, write_latency_us,
           read_bw_bytes, write_bw_bytes, perf_captured_at
    FROM pure1_arrays WHERE read_iops IS NOT NULL OR perf_captured_at IS NOT NULL
  `).all().map((r) => [r.pure1_id, r]));
  replaceArrays(rows, enrichment);
  replaceAlerts(alerts);
  appendSnapshot(rowsForSnapshot, alerts);

  // Per-array performance snapshot. replaceArrays() above rebuilt the rows
  // with null perf columns, so re-apply fresh values where the fetch worked
  // and the pre-replace values otherwise (last-good through outages).
  const perfStmt = db.prepare(`
    UPDATE pure1_arrays SET read_iops = ?, write_iops = ?, read_latency_us = ?,
      write_latency_us = ?, read_bw_bytes = ?, write_bw_bytes = ?, perf_captured_at = ?
    WHERE pure1_id = ?
  `);
  let perf = new Map();
  try {
    perf = await pure1Api.fetchLatestPerformance(rows.map((r) => r.id).filter(Boolean));
  } catch (err) {
    logger.error('[Pure1Poller] Performance fetch failed, keeping last-good:', err.message);
  }
  for (const r of rows) {
    if (!r.id) continue;
    const p = perf.get(r.id);
    const old = priorPerf.get(r.id);
    const src = p || old;
    if (!src) continue;
    perfStmt.run(
      (p ? p.readIops : old.read_iops) ?? null, (p ? p.writeIops : old.write_iops) ?? null,
      (p ? p.readLatencyUs : old.read_latency_us) ?? null, (p ? p.writeLatencyUs : old.write_latency_us) ?? null,
      (p ? p.readBw : old.read_bw_bytes) ?? null, (p ? p.writeBw : old.write_bw_bytes) ?? null,
      p ? (p.capturedAt ? new Date(p.capturedAt).toISOString() : null) : old.perf_captured_at,
      r.id
    );
  }
  logger.info(`[Pure1Poller] Refreshed ${rows.length} array(s), ${alerts.length} alert(s)`);
}

const pure1Task = createGlobalTask({
  id: 'pure1',
  intervalMinutes: () => Number(getSetting('pure1_poll_interval_minutes')) || 15,
  run: refreshAll,
  defaultIntervalMinutes: 15,
  cronLib: cron,
});

function initPure1Poller() {
  if (pure1Api.isConfigured() && !isDemo()) {
    pure1Task.reschedule();
    setTimeout(() => { pure1Task.trigger(); }, 4000);
  }
  return pure1Task;
}

module.exports = { initPure1Poller, refreshAll, pure1Task };
