// LogicMonitor pollers: two framework pollers over lm_sources combined into
// one handle (Brocade pattern). Tier 1 ('logicmonitor', every
// polling_interval_minutes): collectors, groups, devices, SDTs, alerts and the
// site reachability checks, plus hourly (baselines, check daily rollup) and
// daily work (collector versions, admins and roles, datasource and instance
// refresh, interface daily rollup, retention, config ledger, topology). Tier 2
// ('logicmonitor-interfaces', every interface_poll_minutes): one per device
// DataSource data call per network device into lm_interfaces and
// lm_interface_history. The datafetch endpoint (5/min) is never used. Every
// section runs through trySection; a poll where EVERY section fails marks the
// source error and throws (Cohesity resilience rule, 2026-09-28).
const { pruneInBatches } = require('../core/dbPrune');
const db = require('../db/database');
const { createPoller } = require('../core/pollerFramework');
const lmApi = require('./logicmonitorApi');
const { mapLimit, callsInFlight } = require('../core/concurrency');
const lmChecks = require('./logicmonitorChecks');
const { reconcileIssueHistory, getThreshold, isBehind, computeShadows } = require('./logicmonitorIssues');
const lmSites = require('./logicmonitorSites');
const lmPath = require('./logicmonitorPath');
const lmEndpoints = require('./logicmonitorEndpoints');
const hostIdentity = require('./hostIdentity');
const lmEri = require('./logicmonitorEri');
const lmGrammar = require('./logicmonitorGrammar');
const lmMetrics = require('./logicmonitorMetrics');
const lmWatch = require('./logicmonitorWatch');
const { isDemo } = require('./demoMode');
const logger = require('../utils/logger');

const safeMsg = (e) => lmApi.errMsg(e);
const { jsonOrNull } = lmApi;
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const localDay = (ms = Date.now()) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const nowSec = () => Math.floor(Date.now() / 1000);

async function trySection(label, fn) {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    logger.warn(`[LmPoller] ${label} failed: ${safeMsg(err)}`);
    return { ok: false, error: safeMsg(err) };
  }
}

function parseJson(v, fallback) {
  if (v == null || v === '') return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

function readFeatures(sourceId) {
  const row = db.prepare('SELECT features_json FROM lm_sources WHERE id = ?').get(sourceId);
  return parseJson(row?.features_json, {}) || {};
}

/** Merge keys into features_json; writes only when something changed (the
 *  column is in loadSources, so a write reschedules the source). */
function mergeFeatures(sourceId, patch) {
  const cur = readFeatures(sourceId);
  const next = { ...cur, ...patch };
  if (JSON.stringify(cur) === JSON.stringify(next)) return cur;
  db.prepare('UPDATE lm_sources SET features_json = ? WHERE id = ?').run(JSON.stringify(next), sourceId);
  return next;
}

function markStale(table, idCol, sourceId, ids, extraWhere = '', extraParams = []) {
  db.prepare(`UPDATE ${table} SET stale = 1 WHERE source_id = ? ${extraWhere} AND ${idCol} NOT IN (SELECT value FROM json_each(?))`)
    .run(sourceId, ...extraParams, JSON.stringify(ids));
}

// -- Store: collectors, groups, devices, SDTs ------------------------------------

const storeCollectors = db.transaction((sourceId, rows) => {
  const stmt = db.prepare(`
    INSERT INTO lm_collectors (source_id, collector_id, description, hostname, group_id, group_name, status, is_down,
      acked, in_sdt, number_of_hosts, number_of_instances, build, platform, arch, size, uptime_seconds, updated_epoch,
      created_epoch, last_notification_epoch, backup_collector_id, collector_device_id, ea, stale, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
    ON CONFLICT(source_id, collector_id) DO UPDATE SET
      description = excluded.description, hostname = excluded.hostname, group_id = excluded.group_id,
      group_name = excluded.group_name, status = excluded.status, is_down = excluded.is_down, acked = excluded.acked,
      in_sdt = excluded.in_sdt, number_of_hosts = excluded.number_of_hosts, number_of_instances = excluded.number_of_instances,
      build = excluded.build, platform = excluded.platform, arch = excluded.arch, size = excluded.size,
      uptime_seconds = excluded.uptime_seconds, updated_epoch = excluded.updated_epoch, created_epoch = excluded.created_epoch,
      last_notification_epoch = excluded.last_notification_epoch, backup_collector_id = excluded.backup_collector_id,
      collector_device_id = excluded.collector_device_id, ea = excluded.ea, stale = 0, updated_at = datetime('now')
  `);
  const ids = [];
  for (const c of rows) {
    if (c.collectorId == null) continue;
    ids.push(c.collectorId);
    stmt.run(sourceId, c.collectorId, c.description, c.hostname, c.groupId, c.groupName, c.status, c.isDown, c.acked,
      c.inSdt, c.numberOfHosts, c.numberOfInstances, c.build, c.platform, c.arch, c.size, c.uptimeSeconds, c.updatedEpoch,
      c.createdEpoch, c.lastNotificationEpoch, c.backupCollectorId, c.collectorDeviceId, c.ea);
  }
  markStale('lm_collectors', 'collector_id', sourceId, ids);
});

const storeGroups = db.transaction((sourceId, rows) => {
  const stmt = db.prepare(`
    INSERT INTO lm_device_groups (source_id, lm_group_id, parent_id, name, full_path, description, group_type, applies_to,
      num_of_hosts, num_of_direct_devices, group_status, disable_alerting, custom_props_json, stale, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
    ON CONFLICT(source_id, lm_group_id) DO UPDATE SET
      parent_id = excluded.parent_id, name = excluded.name, full_path = excluded.full_path, description = excluded.description,
      group_type = excluded.group_type, applies_to = excluded.applies_to, num_of_hosts = excluded.num_of_hosts,
      num_of_direct_devices = excluded.num_of_direct_devices, group_status = excluded.group_status,
      disable_alerting = excluded.disable_alerting, custom_props_json = excluded.custom_props_json, stale = 0,
      updated_at = datetime('now')
  `);
  const ids = [];
  for (const g of rows) {
    if (g.lmGroupId == null) continue;
    ids.push(g.lmGroupId);
    stmt.run(sourceId, g.lmGroupId, g.parentId, g.name, g.fullPath, g.description, g.groupType, g.appliesTo,
      g.numOfHosts, g.numOfDirectDevices, g.groupStatus, g.disableAlerting, jsonOrNull(g.customProps));
  }
  markStale('lm_device_groups', 'lm_group_id', sourceId, ids);
});

/** Upsert devices; first_seen is kept, dead_since is set when host_status
 *  first reads dead and cleared when it recovers; if_count/if_up untouched. */
const storeDevices = db.transaction((sourceId, rows) => {
  const stmt = db.prepare(`
    INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, description, device_type, host_status,
      alert_status, alert_status_priority, sdt_status, alert_disable_status, disable_alerting, group_ids_json,
      collector_id, preferred_collector_id, collector_description, enable_netflow, uptime_seconds, created_epoch,
      updated_epoch, deleted_time_ms, sysinfo, sysoid, sysname, hostname, model, vendor, role, is_network, categories,
      ips_json, version, serial, eri_json, ert, system_props_json, auto_props_json, custom_props_json, dead_since,
      stale, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      CASE WHEN ? = 'dead' THEN datetime('now') ELSE NULL END, 0, datetime('now'))
    ON CONFLICT(source_id, lm_device_id) DO UPDATE SET
      name = excluded.name, display_name = excluded.display_name, description = excluded.description,
      device_type = excluded.device_type, host_status = excluded.host_status, alert_status = excluded.alert_status,
      alert_status_priority = excluded.alert_status_priority, sdt_status = excluded.sdt_status,
      alert_disable_status = excluded.alert_disable_status, disable_alerting = excluded.disable_alerting,
      group_ids_json = excluded.group_ids_json, collector_id = excluded.collector_id,
      preferred_collector_id = excluded.preferred_collector_id, collector_description = excluded.collector_description,
      enable_netflow = excluded.enable_netflow, uptime_seconds = excluded.uptime_seconds,
      created_epoch = excluded.created_epoch, updated_epoch = excluded.updated_epoch,
      deleted_time_ms = excluded.deleted_time_ms, sysinfo = excluded.sysinfo, sysoid = excluded.sysoid,
      sysname = excluded.sysname, hostname = excluded.hostname, model = excluded.model, vendor = excluded.vendor,
      role = excluded.role, is_network = excluded.is_network, categories = excluded.categories,
      ips_json = excluded.ips_json, version = excluded.version, serial = excluded.serial, eri_json = excluded.eri_json,
      ert = excluded.ert, system_props_json = excluded.system_props_json, auto_props_json = excluded.auto_props_json,
      custom_props_json = excluded.custom_props_json,
      dead_since = CASE WHEN excluded.host_status = 'dead' THEN COALESCE(lm_devices.dead_since, datetime('now')) ELSE NULL END,
      stale = 0, updated_at = datetime('now')
  `);
  const ids = [];
  for (const d of rows) {
    if (d.lmDeviceId == null) continue;
    ids.push(d.lmDeviceId);
    stmt.run(sourceId, d.lmDeviceId, d.name, d.displayName, d.description, d.deviceType, d.hostStatus, d.alertStatus,
      d.alertStatusPriority, d.sdtStatus, d.alertDisableStatus, d.disableAlerting, JSON.stringify(d.groupIds || []),
      d.collectorId, d.preferredCollectorId, d.collectorDescription, d.enableNetflow, d.uptimeSeconds, d.createdEpoch,
      d.updatedEpoch, d.deletedTimeMs, d.sysinfo, d.sysoid, d.sysname, d.hostname, d.model, d.vendor, d.role,
      d.isNetwork, d.categories, JSON.stringify(d.ips || []), d.version, d.serial, jsonOrNull(d.eri), d.ert,
      jsonOrNull(d.systemProps), jsonOrNull(d.autoProps), jsonOrNull(d.customProps), d.hostStatus);
  }
  markStale('lm_devices', 'lm_device_id', sourceId, ids);
});

const storeSdts = db.transaction((sourceId, rows) => {
  const stmt = db.prepare(`
    INSERT INTO lm_sdts (source_id, sdt_id, sdt_type, schedule_type, is_effective, start_ms, end_ms, duration, admin,
      comment, lm_device_id, device_display_name, group_id, group_full_path, collector_id, datasource_name,
      instance_id, website_id, raw_json, stale, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
    ON CONFLICT(source_id, sdt_id) DO UPDATE SET
      sdt_type = excluded.sdt_type, schedule_type = excluded.schedule_type, is_effective = excluded.is_effective,
      start_ms = excluded.start_ms, end_ms = excluded.end_ms, duration = excluded.duration, admin = excluded.admin,
      comment = excluded.comment, lm_device_id = excluded.lm_device_id, device_display_name = excluded.device_display_name,
      group_id = excluded.group_id, group_full_path = excluded.group_full_path, collector_id = excluded.collector_id,
      datasource_name = excluded.datasource_name, instance_id = excluded.instance_id, website_id = excluded.website_id,
      raw_json = excluded.raw_json, stale = 0, updated_at = datetime('now')
  `);
  const ids = [];
  for (const s of rows) {
    if (s.sdtId == null) continue;
    ids.push(s.sdtId);
    stmt.run(sourceId, s.sdtId, s.sdtType, s.scheduleType, s.isEffective, s.startMs, s.endMs, s.duration, s.admin,
      s.comment, s.lmDeviceId, s.deviceDisplayName, s.groupId, s.groupFullPath, s.collectorId, s.datasourceName,
      s.instanceId, s.websiteId, jsonOrNull(s.raw));
  }
  markStale('lm_sdts', 'sdt_id', sourceId, ids);
});

// -- Store: alerts -------------------------------------------------------------------

function prepareAlertUpsert(dbh) {
  return dbh.prepare(`
    INSERT INTO lm_alerts (source_id, lm_alert_id, internal_id, type, severity, severity_norm, lm_device_id,
      monitor_object_name, monitor_object_type, resource_template_name, resource_template_type, instance_id,
      instance_name, instance_description, data_point_name, alert_value, threshold, clear_value, start_epoch,
      end_epoch, acked, acked_by, ack_comment, acked_epoch, sdted, suppressor, cleared, closed_reason, rule, rule_id,
      chain, anomaly, ad_alert, condition_key, raw_json, ingest, captured_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      datetime('now'), datetime('now'))
    ON CONFLICT(source_id, lm_alert_id) DO UPDATE SET
      internal_id = excluded.internal_id, type = excluded.type, severity = excluded.severity,
      severity_norm = excluded.severity_norm, lm_device_id = excluded.lm_device_id,
      monitor_object_name = excluded.monitor_object_name, monitor_object_type = excluded.monitor_object_type,
      resource_template_name = excluded.resource_template_name, resource_template_type = excluded.resource_template_type,
      instance_id = excluded.instance_id, instance_name = excluded.instance_name,
      instance_description = excluded.instance_description, data_point_name = excluded.data_point_name,
      alert_value = excluded.alert_value, threshold = excluded.threshold, clear_value = excluded.clear_value,
      start_epoch = excluded.start_epoch, end_epoch = excluded.end_epoch, acked = excluded.acked,
      acked_by = excluded.acked_by, ack_comment = excluded.ack_comment, acked_epoch = excluded.acked_epoch,
      sdted = excluded.sdted, suppressor = excluded.suppressor, cleared = excluded.cleared,
      closed_reason = excluded.closed_reason, rule = excluded.rule, rule_id = excluded.rule_id, chain = excluded.chain,
      anomaly = excluded.anomaly, ad_alert = excluded.ad_alert, condition_key = excluded.condition_key,
      raw_json = excluded.raw_json, ingest = COALESCE(lm_alerts.ingest, excluded.ingest),
      captured_at = CASE WHEN excluded.cleared = 0 THEN datetime('now') ELSE lm_alerts.captured_at END,
      updated_at = datetime('now')
  `);
}

/** One normalized alert into lm_alerts (shadowed_by is left to computeShadows). */
function runAlertUpsert(stmt, sourceId, a, cleared, ingest) {
  if (a.lmAlertId == null) return;
  stmt.run(sourceId, a.lmAlertId, a.internalId, a.type, a.severity, a.severityNorm, a.lmDeviceId, a.monitorObjectName,
    a.monitorObjectType, a.resourceTemplateName, a.resourceTemplateType, a.instanceId, a.instanceName,
    a.instanceDescription, a.dataPointName, a.alertValue, a.threshold, a.clearValue, a.startEpoch,
    cleared ? (a.endEpoch || nowSec()) : null, a.acked, a.ackedBy, a.ackComment, a.ackedEpoch,
    cleared ? 0 : a.sdted, a.suppressor, cleared ? 1 : 0, cleared ? 'cleared' : null, a.rule, a.ruleId, a.chain,
    a.anomaly, a.adAlert, a.conditionKey, jsonOrNull(a.raw), ingest);
}

/**
 * Upsert the open pass and the cleared pass. When the open pass succeeded,
 * a row still open locally that neither pass reported is closed with
 * closed_reason 'not_reported' (the fallback when the cleared pass misses it).
 */
const storeAlerts = db.transaction((sourceId, openRows, clearedRows, { openOk = true } = {}) => {
  const stmt = prepareAlertUpsert(db);
  const openIds = [];
  for (const a of openRows || []) { if (a.cleared) continue; openIds.push(a.lmAlertId); runAlertUpsert(stmt, sourceId, a, false, 'poll'); }
  for (const a of clearedRows || []) runAlertUpsert(stmt, sourceId, a, true, 'poll');
  if (openOk) {
    db.prepare(`
      UPDATE lm_alerts SET cleared = 1, closed_reason = 'not_reported', end_epoch = ?, updated_at = datetime('now')
      WHERE source_id = ? AND cleared = 0 AND lm_alert_id NOT IN (SELECT value FROM json_each(?))
    `).run(nowSec(), sourceId, JSON.stringify(openIds));
  }
});

/**
 * The one writer both ingest paths share. alertLike carries the REST field
 * names (id, internalId, severity, monitorObjectId, monitorObjectName,
 * resourceTemplateName, instanceName, dataPointName, startEpoch, cleared,
 * ...); it is normalized exactly as a polled alert (severity_norm, the
 * content-stable condition_key, never the LM id), upserted by (source_id,
 * lm_alert_id), and the dependency suppression is re-evaluated for its
 * device. A cleared alert keeps its row (cleared = 1, end_epoch set) so the
 * poll's not_reported rule and the retention prune treat it like any other.
 * Returns {lmAlertId, conditionKey, cleared, severityNorm, lmDeviceId} or
 * null when the alert has no id.
 */
function upsertAlertRow(dbh, sourceId, alertLike, { ingest = 'webhook' } = {}) {
  const a = lmApi.normalizeAlert(alertLike || {}, sourceId);
  if (a.lmAlertId == null) return null;
  const cleared = !!a.cleared;
  runAlertUpsert(prepareAlertUpsert(dbh), sourceId, a, cleared, ingest);
  if (a.lmDeviceId != null) {
    try { computeShadows(dbh, { sourceId, deviceId: a.lmDeviceId }); } catch { /* suppression is best effort */ }
  }
  return { lmAlertId: a.lmAlertId, conditionKey: a.conditionKey, cleared, severityNorm: a.severityNorm, lmDeviceId: a.lmDeviceId };
}

/** Cleared-pass window start: one day back, or the oldest locally open
 *  alert's start (bounded to 7 days) so long-running alerts close precisely. */
function clearedSince(sourceId) {
  const oldestOpen = db.prepare('SELECT MIN(start_epoch) t FROM lm_alerts WHERE source_id = ? AND cleared = 0').get(sourceId)?.t;
  const dayAgo = nowSec() - 86400;
  const floor = nowSec() - 7 * 86400;
  return Math.max(floor, Math.min(dayAgo, oldestOpen || dayAgo) - 60);
}

// -- Checks --------------------------------------------------------------------------

const storeChecks = db.transaction((sourceId, rows, origin) => {
  const stmt = db.prepare(`
    INSERT INTO lm_checks (source_id, check_id, kind, origin, name, target, description, status, alert_status, sdt_status,
      overall_alert_level, polling_interval, transition, global_sm_alert_cond, is_internal, stop_monitoring,
      disable_alerting, group_id, test_location_json, collectors_json, steps_json, raw_json, stale, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
    ON CONFLICT(source_id, check_id) DO UPDATE SET
      kind = excluded.kind, origin = excluded.origin, name = excluded.name, target = excluded.target,
      description = excluded.description, status = excluded.status, alert_status = excluded.alert_status,
      sdt_status = excluded.sdt_status, overall_alert_level = excluded.overall_alert_level,
      polling_interval = excluded.polling_interval, transition = excluded.transition,
      global_sm_alert_cond = excluded.global_sm_alert_cond, is_internal = excluded.is_internal,
      stop_monitoring = excluded.stop_monitoring, disable_alerting = excluded.disable_alerting,
      group_id = excluded.group_id, test_location_json = excluded.test_location_json,
      collectors_json = excluded.collectors_json, steps_json = excluded.steps_json, raw_json = excluded.raw_json,
      stale = 0, updated_at = datetime('now')
  `);
  const loc = db.prepare(`
    INSERT INTO lm_check_locations (source_id, check_id, checkpoint_id, lm_checkpoint_id, label, smg_id, collector_id,
      is_overall, stale, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
    ON CONFLICT(source_id, check_id, checkpoint_id) DO UPDATE SET
      lm_checkpoint_id = excluded.lm_checkpoint_id, label = excluded.label, smg_id = excluded.smg_id,
      collector_id = excluded.collector_id, is_overall = MAX(lm_check_locations.is_overall, excluded.is_overall),
      stale = 0, updated_at = datetime('now')
  `);
  const ids = [];
  for (const c of rows) {
    ids.push(c.checkId);
    stmt.run(sourceId, c.checkId, c.kind, c.origin, c.name, c.target, c.description, c.status, c.alertStatus,
      c.sdtStatus, c.overallAlertLevel, c.pollingInterval, c.transition, c.globalSmAlertCond, c.isInternal,
      c.stopMonitoring, c.disableAlerting, c.groupId, jsonOrNull(c.testLocation), jsonOrNull(c.collectors),
      jsonOrNull(c.steps), jsonOrNull(c.raw));
    if (origin === 'website') {
      const cpIds = [];
      for (const l of c.locations || []) {
        cpIds.push(l.checkpointId);
        loc.run(sourceId, c.checkId, l.checkpointId, l.lmCheckpointId, l.label, l.smgId, l.collectorId, l.isOverall);
      }
      markStale('lm_check_locations', 'checkpoint_id', sourceId, cpIds, 'AND check_id = ?', [c.checkId]);
    }
  }
  markStale('lm_checks', 'check_id', sourceId, ids, 'AND origin = ?', [origin]);
});

function learnedFor(features, key, kind, dataPoints, valuesLen) {
  const names = Array.isArray(dataPoints) && dataPoints.length ? dataPoints
    : (Array.isArray(features?.checkColumns?.[key]?.dataPoints) && features.checkColumns[key].dataPoints.length === valuesLen
      ? features.checkColumns[key].dataPoints : null);
  return { names, learned: lmChecks.learnCheckColumns(names, kind, valuesLen) };
}

const appendCheckRows = db.transaction((sourceId, checkId, checkpointId, rows, names, isOverall) => {
  const last = db.prepare('SELECT last_sample_epoch FROM lm_check_locations WHERE source_id = ? AND check_id = ? AND checkpoint_id = ?')
    .get(sourceId, checkId, checkpointId)?.last_sample_epoch || 0;
  const ins = db.prepare(`
    INSERT INTO lm_check_history (source_id, check_id, checkpoint_id, sample_epoch, status, rtt_avg_ms, rtt_min_ms,
      rtt_max_ms, loss_pct, response_ms, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let newest = null;
  let added = 0;
  for (const r of rows) {
    if (r.sampleEpoch <= last) continue;
    ins.run(sourceId, checkId, checkpointId, r.sampleEpoch, r.status, r.rttAvgMs, r.rttMinMs, r.rttMaxMs, r.lossPct,
      r.responseMs, JSON.stringify({ dataPoints: names || null, values: r.raw }));
    added += 1;
    newest = r;
  }
  if (newest) {
    db.prepare(`
      UPDATE lm_check_locations SET last_status = ?, last_rtt_ms = ?, last_loss_pct = ?, last_response_ms = ?,
        last_sample_epoch = ?, is_overall = MAX(is_overall, ?), updated_at = datetime('now')
      WHERE source_id = ? AND check_id = ? AND checkpoint_id = ?
    `).run(newest.status, newest.rttAvgMs, newest.lossPct, newest.responseMs, newest.sampleEpoch, isOverall ? 1 : 0,
      sourceId, checkId, checkpointId);
  }
  return added;
});

/** Window for a check data call: since the last sample, at least 10 minutes,
 *  at most 6 hours (LM raw data calls stay under 8 hours). */
function checkWindow(lastEpoch, now = nowSec()) {
  const start = Math.max(now - 6 * 3600, Math.min(lastEpoch ? lastEpoch + 1 : 0, now - 600));
  return { start, end: now };
}

/**
 * Per check, per checkpoint data pull, round robin oldest sample first and
 * capped at lm_check_data_calls_per_tick calls. Website checkpoints are one
 * call each; an Uptime DataSource is one call covering all its instances.
 */
async function pollCheckData(source) {
  const cap = getThreshold('lm_check_data_calls_per_tick');
  let features = readFeatures(source.id);
  const learnedPatch = {};
  const jobs = [];
  for (const l of db.prepare(`
    SELECT l.check_id, l.checkpoint_id, l.lm_checkpoint_id, l.last_sample_epoch, l.is_overall, c.kind, c.origin
    FROM lm_check_locations l JOIN lm_checks c ON c.source_id = l.source_id AND c.check_id = l.check_id
    WHERE l.source_id = ? AND l.stale = 0 AND c.stale = 0 AND c.origin = 'website' AND COALESCE(c.stop_monitoring, 0) = 0
      AND l.lm_checkpoint_id IS NOT NULL
  `).all(source.id)) {
    jobs.push({ type: 'website', last: l.last_sample_epoch || 0, l });
  }
  for (const h of db.prepare(`
    SELECT l.check_id, l.hds_id, MIN(COALESCE(l.last_sample_epoch, 0)) last, c.kind, d.datasource_name
    FROM lm_check_locations l
    JOIN lm_checks c ON c.source_id = l.source_id AND c.check_id = l.check_id
    LEFT JOIN lm_device_datasources d ON d.source_id = l.source_id AND d.hds_id = l.hds_id
    WHERE l.source_id = ? AND l.stale = 0 AND c.stale = 0 AND c.origin = 'uptime' AND l.hds_id IS NOT NULL
    GROUP BY l.check_id, l.hds_id
  `).all(source.id)) {
    jobs.push({ type: 'uptime', last: h.last || 0, h });
  }
  jobs.sort((a, b) => a.last - b.last);
  if (jobs.length > cap) logger.info(`[LmPoller] ${source.name}: ${jobs.length} check data calls due, capped at ${cap} this tick`);
  let calls = 0;
  let failures = 0;
  let rows = 0;
  const inFlight = callsInFlight('logicmonitor');
  const startedAt = Date.now();
  // Only the network call overlaps; everything after each await is synchronous, so the
  // learned columns and the row writes of two jobs never interleave.
  await mapLimit(jobs.slice(0, cap), inFlight, async (job) => {
    calls += 1;
    try {
      if (job.type === 'website') {
        const { l } = job;
        const websiteId = Number(String(l.check_id).slice(2));
        const win = checkWindow(l.last_sample_epoch);
        const body = await lmApi.fetchCheckpointData(source, websiteId, l.lm_checkpoint_id, win);
        const key = `website:${l.kind}`;
        const valuesLen = Array.isArray(body?.values?.[0]) ? body.values[0].length : 0;
        const { names, learned } = learnedFor(features, key, l.kind, body?.dataPoints, valuesLen);
        if (Array.isArray(body?.dataPoints) && body.dataPoints.length) learnedPatch[key] = { dataPoints: body.dataPoints, columns: learned.columns };
        const parsed = lmChecks.parseCheckSeries(body, learned, names);
        rows += appendCheckRows(source.id, l.check_id, l.checkpoint_id, parsed, names, learned.isOverall);
      } else {
        const { h } = job;
        const deviceId = Number(String(h.check_id).slice(2));
        const win = checkWindow(h.last);
        const body = await lmApi.fetchDsData(source, deviceId, h.hds_id, win);
        const dsName = body?.dataSourceName || h.datasource_name || '';
        const key = `uptime:${dsName}`;
        const { names, learned } = learnedFor(features, key, h.kind, body?.dataPoints, 0);
        if (Array.isArray(body?.dataPoints) && body.dataPoints.length) learnedPatch[key] = { dataPoints: body.dataPoints, columns: learned.columns };
        const locs = db.prepare('SELECT checkpoint_id, instance_name, label FROM lm_check_locations WHERE source_id = ? AND check_id = ? AND hds_id = ?')
          .all(source.id, h.check_id, h.hds_id);
        for (const [instKey, series] of Object.entries(body?.instances || {})) {
          const loc = matchInstance(locs, instKey, dsName);
          if (!loc) continue;
          const parsed = lmChecks.parseCheckSeries(series, learned, names);
          rows += appendCheckRows(source.id, h.check_id, loc.checkpoint_id, parsed, names, learned.isOverall || /overall/i.test(dsName));
        }
      }
    } catch (err) {
      failures += 1;
      logger.warn(`[LmPoller] check data call failed: ${safeMsg(err)}`);
    }
  });
  if (Object.keys(learnedPatch).length) {
    features = mergeFeatures(source.id, { checkColumns: { ...(features.checkColumns || {}), ...learnedPatch } });
  }
  if (calls && failures === calls) throw new Error(`every check data call failed (${calls})`);
  if (calls) logger.info(`[LmPoller] ${source.name}: ${calls} check data call(s)${failures ? `, ${failures} failed` : ''}, ${rows} row(s), in flight ${inFlight}, ${Math.round((Date.now() - startedAt) / 100) / 10} s`);
  return { calls, failures, rows, inFlight };
}

/** Match a data response instance key ("DataSource-alias") to a stored row:
 *  exact instance name, else the key with the DataSource prefix and any
 *  " [ID:n]" suffix stripped against the label. */
function matchInstance(rows, key, dsName) {
  const k = String(key);
  const lower = k.toLowerCase();
  const exact = rows.find((r) => r.instance_name && r.instance_name.toLowerCase() === lower);
  if (exact) return exact;
  let stripped = k;
  if (dsName && stripped.startsWith(`${dsName}-`)) stripped = stripped.slice(dsName.length + 1);
  stripped = lmApi.stripIdSuffix(stripped).toLowerCase();
  return rows.find((r) => (r.label || r.display_name || '').toLowerCase() === stripped
    || (r.instance_name && lmApi.stripIdSuffix(r.instance_name).toLowerCase() === lower)) || null;
}

// -- Datasource and instance refresh (daily, and for new devices) ----------------

function interfaceDsName(rows) {
  for (const name of lmApi.INTERFACE_DATASOURCES) {
    const hit = rows.find((r) => r.datasourceName === name);
    if (hit) return hit;
  }
  return null;
}

const storeDeviceDatasources = db.transaction((sourceId, deviceId, rows, ifHdsId) => {
  db.prepare('DELETE FROM lm_device_datasources WHERE source_id = ? AND lm_device_id = ?').run(sourceId, deviceId);
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO lm_device_datasources (source_id, lm_device_id, hds_id, datasource_id, datasource_name,
      datasource_display_name, instance_count, monitoring_instance_count, alert_status, sdt_status, stop_monitoring,
      is_interface, is_neighbor, refreshed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  for (const r of rows) {
    if (r.hdsId == null) continue;
    stmt.run(sourceId, deviceId, r.hdsId, r.datasourceId, r.datasourceName, r.datasourceDisplayName, r.instanceCount,
      r.monitoringInstanceCount, r.alertStatus, r.sdtStatus, r.stopMonitoring, r.hdsId === ifHdsId ? 1 : 0,
      lmApi.NEIGHBOR_DATASOURCES[r.datasourceName] ? 1 : 0);
  }
});

const storeInterfaces = db.transaction((sourceId, deviceId, hdsId, instances) => {
  const stmt = db.prepare(`
    INSERT INTO lm_interfaces (source_id, lm_device_id, hds_id, instance_id, instance_name, display_name, description,
      if_index, stop_monitoring, disable_alerting, alert_status, sdt_status, props_json, stale, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
    ON CONFLICT(source_id, instance_id) DO UPDATE SET
      lm_device_id = excluded.lm_device_id, hds_id = excluded.hds_id, instance_name = excluded.instance_name,
      display_name = excluded.display_name, description = excluded.description, if_index = excluded.if_index,
      stop_monitoring = excluded.stop_monitoring, disable_alerting = excluded.disable_alerting,
      alert_status = excluded.alert_status, sdt_status = excluded.sdt_status, props_json = excluded.props_json,
      stale = 0, updated_at = datetime('now')
  `);
  const ids = [];
  for (const i of instances) {
    if (i.instanceId == null) continue;
    ids.push(i.instanceId);
    stmt.run(sourceId, deviceId, hdsId, i.instanceId, i.instanceName, i.displayName, i.description, i.ifIndex,
      i.stopMonitoring, i.disableAlerting, i.alertStatus, i.sdtStatus, jsonOrNull(i.props));
  }
  markStale('lm_interfaces', 'instance_id', sourceId, ids, 'AND lm_device_id = ?', [deviceId]);
  db.prepare(`
    UPDATE lm_devices SET if_count = (SELECT COUNT(*) FROM lm_interfaces WHERE source_id = ? AND lm_device_id = ? AND stale = 0)
    WHERE source_id = ? AND lm_device_id = ?
  `).run(sourceId, deviceId, sourceId, deviceId);
});

const storeUptimeLocations = db.transaction((sourceId, deviceId, perDs) => {
  const checkId = `u:${deviceId}`;
  const stmt = db.prepare(`
    INSERT INTO lm_check_locations (source_id, check_id, checkpoint_id, hds_id, instance_name, label, is_overall,
      stale, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
    ON CONFLICT(source_id, check_id, checkpoint_id) DO UPDATE SET
      hds_id = excluded.hds_id, instance_name = excluded.instance_name, label = excluded.label,
      is_overall = excluded.is_overall, stale = 0, updated_at = datetime('now')
  `);
  const ids = [];
  for (const { hdsId, dsName, instances } of perDs) {
    const overall = /overall/i.test(dsName) ? 1 : 0;
    for (const i of instances) {
      if (i.instanceId == null) continue;
      const cp = `i:${i.instanceId}`;
      ids.push(cp);
      stmt.run(sourceId, checkId, cp, hdsId, i.instanceName, overall ? 'Overall' : (i.displayName || i.instanceName), overall);
    }
  }
  markStale('lm_check_locations', 'checkpoint_id', sourceId, ids, 'AND check_id = ?', [checkId]);
});

/** Refresh one device's datasources and the instance lists that ICC reads
 *  (interfaces, LLDP/CDP neighbours, Uptime check instances). Returns the
 *  neighbour instances found: [{protocol, srcDeviceId, instance}]. */
async function refreshDevice(source, device) {
  const rows = await lmApi.fetchDeviceDatasources(source, device.lm_device_id);
  const ifRow = device.is_network ? interfaceDsName(rows) : null;
  storeDeviceDatasources(source.id, device.lm_device_id, rows, ifRow ? ifRow.hdsId : null);
  const neighbors = [];
  if (ifRow) {
    const inst = await lmApi.fetchInstances(source, device.lm_device_id, ifRow.hdsId);
    storeInterfaces(source.id, device.lm_device_id, ifRow.hdsId, inst);
  }
  for (const r of rows) {
    const protocol = lmApi.NEIGHBOR_DATASOURCES[r.datasourceName];
    if (!protocol || !device.is_network) continue;
    const inst = await lmApi.fetchInstances(source, device.lm_device_id, r.hdsId);
    for (const i of inst) neighbors.push({ protocol, srcDeviceId: device.lm_device_id, instance: i });
  }
  if ([18, 19].includes(Number(device.device_type))) {
    const perDs = [];
    for (const r of rows.filter((x) => lmApi.UPTIME_DATASOURCES.includes(x.datasourceName))) {
      perDs.push({ hdsId: r.hdsId, dsName: r.datasourceName, instances: await lmApi.fetchInstances(source, device.lm_device_id, r.hdsId) });
    }
    if (perDs.length) storeUptimeLocations(source.id, device.lm_device_id, perDs);
  }
  return { ifDataSource: ifRow ? ifRow.datasourceName : null, neighbors };
}

function refreshCandidates(sourceId, { onlyMissing = false } = {}) {
  // Round 9: AWS Direct Connect and Azure ExpressRoute resources (device_type 2 and 4, not network
  // devices) are inventoried too when their external resource type matches CLOUD_ERT_RE.
  const cloudRe = require('./logicmonitorCatalog').CLOUD_ERT_RE;
  return db.prepare(`
    SELECT d.lm_device_id, d.is_network, d.device_type, d.display_name, d.ert FROM lm_devices d
    WHERE d.source_id = ? AND d.stale = 0 AND (d.is_network = 1 OR d.device_type IN (18, 19) OR (d.device_type IN (2, 4) AND d.ert IS NOT NULL))
    ${onlyMissing ? 'AND NOT EXISTS (SELECT 1 FROM lm_device_datasources x WHERE x.source_id = d.source_id AND x.lm_device_id = d.lm_device_id)' : ''}
    ORDER BY d.lm_device_id
  `).all(sourceId).filter((d) => d.is_network === 1 || d.device_type === 18 || d.device_type === 19 || cloudRe.test(String(d.ert || '')));
}

async function refreshDevices(source, devices) {
  const counts = new Map();
  const neighbors = [];
  let failed = 0;
  for (const d of devices) {
    try {
      const res = await refreshDevice(source, d);
      if (res.ifDataSource) counts.set(res.ifDataSource, (counts.get(res.ifDataSource) || 0) + 1);
      neighbors.push(...res.neighbors);
    } catch (err) {
      failed += 1;
      logger.warn(`[LmPoller] datasource refresh of ${d.display_name || d.lm_device_id} failed: ${safeMsg(err)}`);
    }
  }
  if (devices.length && failed === devices.length) throw new Error(`datasource refresh failed on all ${failed} device(s)`);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top) mergeFeatures(source.id, { ifDataSource: top[0] });
  return { refreshed: devices.length - failed, failed, neighbors };
}

// -- Topology (section 8) -------------------------------------------------------

const PORT_RE = /^(?:[A-Za-z][A-Za-z-]{0,24})?\d+(?:[/.:]\d+)*$/;
const cleanTok = (t) => String(t || '').replace(/^[\s"'([<]+/, '').replace(/[\s"')\]>,;.]+$/, '');

/**
 * Parse one interface description into a link. resolve(name) -> device id or
 * null. Order: "to|->|uplink to|link to <name>[sep]<port>" (high when name
 * and port parse, medium when only the name resolves), then any bare token
 * that resolves (low). A description that looks like a link but resolves to
 * nothing comes back with dstDeviceId null so Governance can list it.
 */
function parseLinkDescription(desc, resolve) {
  const s = String(desc || '').trim();
  if (!s) return null;
  const m = s.match(/(?:^|[\s(\[])(?:uplink\s+to|link\s+to|to|->)\s*[:-]?\s*(\S+)(?:\s+(?:port\s+)?(\S+))?/i);
  if (m) {
    const tok = cleanTok(m[1]);
    const next = m[2] ? cleanTok(m[2]) : null;
    let name = tok;
    let port = null;
    let id = tok ? resolve(tok) : null;
    if (id == null) {
      for (const sep of [':', ',', '/']) {
        const i = tok.indexOf(sep);
        if (i > 0) {
          const r = resolve(tok.slice(0, i));
          if (r != null) { id = r; name = tok.slice(0, i); port = tok.slice(i + 1) || null; break; }
        }
      }
    }
    if (id == null) {
      const parts = tok.split('-');
      for (let k = parts.length - 1; k > 0 && id == null; k -= 1) {
        const n = parts.slice(0, k).join('-');
        const p = parts.slice(k).join('-');
        if (PORT_RE.test(p)) {
          const r = resolve(n);
          if (r != null) { id = r; name = n; port = p; }
        }
      }
    }
    if (port == null && next && PORT_RE.test(next)) port = next;
    if (id != null) return { dstDeviceId: id, dstName: name, dstPort: port, confidence: port ? 'high' : 'medium' };
  }
  for (const raw of s.split(/[\s,;()[\]]+/)) {
    const t = cleanTok(raw);
    if (t.length < 3 || /^\d+$/.test(t)) continue;
    const r = resolve(t);
    if (r != null) return { dstDeviceId: r, dstName: t, dstPort: null, confidence: 'low' };
  }
  if (/\bto\s|uplink|->/i.test(s)) return { dstDeviceId: null, dstName: m ? cleanTok(m[1]) || null : null, dstPort: null, confidence: 'low' };
  return null;
}

/** ERI and name index for one source: lower-cased display_name, name,
 *  sysname, hostname, ips, ERI mac/ip/fqdn, plus short names for FQDNs. */
function buildDeviceIndex(dbh, sourceId) {
  const index = new Map();
  const add = (k, id) => {
    if (!k) return;
    const key = String(k).toLowerCase().trim();
    if (!key) return;
    if (!index.has(key)) index.set(key, id);
    const short = key.includes('.') && !/^\d+(\.\d+){3}$/.test(key) ? key.split('.')[0] : null;
    if (short && short.length >= 3 && !index.has(short)) index.set(short, id);
    // Round 9: "name(serial)" spellings index under the bare name and its short form too.
    const bare = key.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (bare && bare !== key) {
      if (!index.has(bare)) index.set(bare, id);
      const bareShort = bare.includes('.') && !/^\d+(\.\d+){3}$/.test(bare) ? bare.split('.')[0] : null;
      if (bareShort && bareShort.length >= 3 && !index.has(bareShort)) index.set(bareShort, id);
    }
  };
  for (const d of dbh.prepare('SELECT lm_device_id, display_name, name, sysname, hostname, serial, ips_json, eri_json FROM lm_devices WHERE source_id = ? AND stale = 0').all(sourceId)) {
    [d.display_name, d.name, d.sysname, d.hostname].forEach((n) => add(n, d.lm_device_id));
    if (d.serial && String(d.serial).trim().length >= 7) add(d.serial, d.lm_device_id);
    for (const ip of parseJson(d.ips_json, []) || []) add(ip, d.lm_device_id);
    const eri = parseJson(d.eri_json, {}) || {};
    for (const k of ['mac', 'ip', 'fqdn']) for (const v of eri[k] || []) add(v, d.lm_device_id);
  }
  return index;
}

function makeResolver(index, selfId) {
  return (tok) => {
    const k = String(tok || '').toLowerCase().trim();
    if (!k) return null;
    let id = index.get(k);
    if (id == null && k.includes('.') && !/^\d+(\.\d+){3}$/.test(k)) id = index.get(k.split('.')[0]);
    if (id == null) {
      // "nyx1-mgt-1(flm29210hwa)": cleanTok may already have eaten the closing paren.
      const bare = k.replace(/\s*\([^)]*\)?\s*$/, '').trim();
      if (bare && bare !== k) {
        id = index.get(bare);
        if (id == null && bare.includes('.') && !/^\d+(\.\d+){3}$/.test(bare)) id = index.get(bare.split('.')[0]);
      }
    }
    return id == null || id === selfId ? null : id;
  };
}

/** Neighbour instance (LLDP_Neighbors / CDP_Neighbors) to a link row. The
 *  instance property names are UNVERIFIED: any property containing 'port'
 *  feeds the ports (one containing 'local' is the local port). */
function parseNeighborInstance(inst, resolve) {
  const props = { ...(inst.props?.auto || {}), ...(inst.props?.custom || {}), ...(inst.props?.system || {}) };
  let srcPort = null;
  let dstPort = null;
  let dstName = null;
  for (const [k, v] of Object.entries(props)) {
    const lk = k.toLowerCase();
    if (v == null || v === '') continue;
    if (lk.includes('port')) {
      if (lk.includes('local')) srcPort = srcPort || v;
      else dstPort = dstPort || v;
    } else if (!dstName && (lk.includes('sysname') || lk.includes('deviceid') || lk.includes('remote') || lk.includes('neighbor') || lk.includes('neighbour'))) {
      dstName = v;
    }
  }
  const candidates = [dstName, inst.displayName, inst.description, inst.wildValue].filter(Boolean);
  let dstDeviceId = null;
  for (const c of candidates) {
    dstDeviceId = resolve(cleanTok(String(c).split(/\s+/)[0]));
    if (dstDeviceId != null) { dstName = dstName || c; break; }
  }
  if (!dstName) dstName = inst.displayName || inst.description || null;
  if (!dstName && !dstPort) dstName = JSON.stringify({ name: inst.instanceName, wildValue: inst.wildValue, props });
  return { srcPort, dstName, dstPort, dstDeviceId, confidence: dstDeviceId != null ? 'high' : 'low' };
}

/**
 * Second-chance resolution against the ICC host index (round 2): only for a
 * link the LM index left unresolved. A far end found in another platform's
 * host inventory keeps dstDeviceId null and carries dstPlatform / dstRef;
 * confidence is high when a port parsed, else medium. LM-resolved links get
 * dstPlatform 'logicmonitor'; unresolved ones stay as v1 wrote them.
 */
function withIccFallback(link, parse, iccResolve) {
  if (link && link.dstDeviceId != null) return { ...link, dstPlatform: 'logicmonitor', dstRef: null };
  if (!iccResolve) return link;
  const icc = parse(iccResolve);
  if (icc && icc.dstDeviceId && typeof icc.dstDeviceId === 'object') {
    const hit = icc.dstDeviceId;
    return {
      ...icc,
      dstDeviceId: null,
      dstPlatform: hit.platform,
      dstRef: hit.ref,
      confidence: icc.dstPort ? 'high' : 'medium',
    };
  }
  return link;
}

/**
 * Recompute lm_topology_links for one source from interface descriptions
 * (protocol 'description'), plus LLDP/CDP neighbour instances when the daily
 * refresh hands them in. Rows are replaced per source and protocol family in
 * one transaction, keeping first_seen by (src_instance_id, protocol).
 * Without neighbours the existing lldp/cdp rows are left alone. Far ends the
 * LM index cannot resolve are tried against the ICC host index (vCenter
 * hosts and VMs, Dell, UniFi, NetApp nodes, Pure arrays).
 */
function buildTopologyLinks(dbh, sourceId, { neighbors = null } = {}) {
  const index = buildDeviceIndex(dbh, sourceId);
  let iccResolve = null;
  try {
    // Round 9: the identity index (names, IPs, MACs, serials, service tags across platforms).
    const idIndex = hostIdentity.buildIdentityIndex(dbh, { fresh: true });
    if (idIndex.refs.size) iccResolve = lmEndpoints.makeIccResolver(idIndex, index);
  } catch (err) {
    logger.warn(`[LmPoller] ICC host index failed, links resolve against LM only: ${safeMsg(err)}`);
  }
  // Round 10: predef.externalResourceID on every interface describes that interface's OWN device,
  // so it feeds an identity index (sysname, serial, chassis MAC, port) that resolves the neighbour
  // instances below; it emits no links itself.
  let eri = { rows: [], identity: null, cdp: 0, lldp: 0, resolved: 0 };
  try {
    eri = lmEri.buildEriLinks(dbh, sourceId);
  } catch (err) {
    logger.warn(`[LmPoller] ERI identity build failed, neighbours resolve without it: ${safeMsg(err)}`);
  }
  const ifaces = dbh.prepare(`
    SELECT lm_device_id, instance_id, display_name, description, props_json FROM lm_interfaces
    WHERE source_id = ? AND stale = 0 AND description IS NOT NULL AND description != ''
  `).all(sourceId);
  const rows = [];
  const classUpdates = [];
  for (const i of ifaces) {
    const parse = (resolve) => parseLinkDescription(i.description, resolve);
    const lmResolve = makeResolver(index, i.lm_device_id);
    // The description grammar (NetApp, Pure, iDRAC, CG tag) runs before the generic parser.
    const g = lmGrammar.linkFromDescription(i.description, lmResolve, iccResolve);
    if (g.cls !== undefined) classUpdates.push({ instanceId: i.instance_id, propsJson: i.props_json, cls: g.cls });
    const link = g.link || withIccFallback(parse(lmResolve), parse, iccResolve);
    if (!link) continue;
    rows.push({ srcDeviceId: i.lm_device_id, srcInstanceId: i.instance_id, srcPort: i.display_name, protocol: 'description', ...link });
  }
  const neighborRows = [];
  let resolvedByEri = 0;
  if (Array.isArray(neighbors)) {
    for (const n of neighbors) {
      const raw = parseNeighborInstance(n.instance, () => null);
      const name = raw.dstName;
      const sm = String(name || '').match(/\(([^()]*)\)?\s*$/);
      const res = lmEri.resolveNeighbor(eri.identity, index, iccResolve, {
        name, serial: sm ? sm[1] : null, mac: hostIdentity.normMac(name), port: raw.dstPort, selfId: n.srcDeviceId,
      });
      if (res.via === 'eri') resolvedByEri += 1;
      const row = {
        srcDeviceId: n.srcDeviceId, srcInstanceId: n.instance.instanceId, srcPort: raw.srcPort, protocol: n.protocol,
        dstName: name, dstPort: res.dstPort, dstDeviceId: res.dstDeviceId, confidence: res.confidence,
      };
      if (res.dstPlatform) { row.dstPlatform = res.dstPlatform; row.dstRef = res.dstRef; }
      neighborRows.push(row);
    }
    rows.push(...neighborRows);
  }
  const linkCols = new Set(dbh.prepare("PRAGMA table_info('lm_topology_links')").all().map((c) => c.name));
  const hasPlatformCols = linkCols.has('dst_platform') && linkCols.has('dst_ref');
  const protocols = Array.isArray(neighbors) ? ['description', 'lldp', 'cdp'] : ['description'];
  const placeholders = protocols.map(() => '?').join(',');
  const txn = dbh.transaction(() => {
    const firstSeen = new Map(dbh.prepare(`SELECT src_instance_id, protocol, first_seen FROM lm_topology_links WHERE source_id = ? AND protocol IN ('description', 'lldp', 'cdp')`)
      .all(sourceId).map((r) => [`${r.src_instance_id}|${r.protocol}`, r.first_seen]));
    dbh.prepare(`DELETE FROM lm_topology_links WHERE source_id = ? AND protocol IN (${placeholders})`).run(sourceId, ...protocols);
    const ins = hasPlatformCols
      ? dbh.prepare(`
      INSERT OR REPLACE INTO lm_topology_links (source_id, src_device_id, src_instance_id, src_port, dst_device_id, dst_name,
        dst_port, protocol, confidence, first_seen, last_seen, stale, dst_platform, dst_ref)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), datetime('now'), 0, ?, ?)
    `)
      : dbh.prepare(`
      INSERT OR REPLACE INTO lm_topology_links (source_id, src_device_id, src_instance_id, src_port, dst_device_id, dst_name,
        dst_port, protocol, confidence, first_seen, last_seen, stale)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), datetime('now'), 0)
    `);
    for (const r of rows) {
      const base = [sourceId, r.srcDeviceId, r.srcInstanceId, r.srcPort || null, r.dstDeviceId, r.dstName || null, r.dstPort || null,
        r.protocol, r.confidence, firstSeen.get(`${r.srcInstanceId}|${r.protocol}`) || null];
      if (hasPlatformCols) ins.run(...base, r.dstPlatform || null, r.dstRef || null);
      else ins.run(...base);
    }
    // CG tag class ("[t=srv ...]") kept on the interface as props_json.iccClass; cleared when the tag is gone.
    const setProps = dbh.prepare('UPDATE lm_interfaces SET props_json = ? WHERE source_id = ? AND instance_id = ?');
    for (const u of classUpdates) {
      const props = parseJson(u.propsJson, {});
      const base = props && typeof props === 'object' && !Array.isArray(props) ? props : {};
      if ((base.iccClass || null) === (u.cls || null)) continue;
      if (u.cls) base.iccClass = u.cls; else delete base.iccClass;
      setProps.run(JSON.stringify(base), sourceId, u.instanceId);
    }
    // Only a build that carried the neighbour instances knows who is unmonitored.
    try { if (Array.isArray(neighbors)) lmEri.refreshUnmonitored(dbh, sourceId, neighborRows); } catch (err) { logger.warn(`[LmPoller] unmonitored neighbour refresh failed: ${safeMsg(err)}`); }
  });
  txn();
  return {
    links: rows.length,
    resolved: rows.filter((r) => r.dstDeviceId != null).length,
    resolvedIcc: rows.filter((r) => r.dstDeviceId == null && r.dstPlatform).length,
    eri: { cdp: eri.cdp, lldp: eri.lldp, resolved: eri.resolved, neighborsResolvedByEri: resolvedByEri },
  };
}

// -- Daily rollups, retention, ledger --------------------------------------------

/** lm_interface_daily for one UTC day, written only when missing. */
function rollupInterfaceDaily(sourceId, day) {
  const from = `${day} 00:00:00`;
  const to = `${utcDay(Date.parse(`${day}T00:00:00Z`) + 86400000)} 00:00:00`;
  const rows = db.prepare(`
    SELECT instance_id, status, in_mbps, out_mbps, in_errors, out_errors, in_discards, out_discards, in_util_pct, out_util_pct
    FROM lm_interface_history WHERE source_id = ? AND captured_at >= ? AND captured_at < ?
    ORDER BY instance_id, captured_at, id
  `).all(sourceId, from, to);
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.instance_id)) groups.set(r.instance_id, []);
    groups.get(r.instance_id).push(r);
  }
  const avg = (arr) => { const a = arr.filter((v) => v != null); return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; };
  const max = (arr) => { const a = arr.filter((v) => v != null); return a.length ? Math.max(...a) : null; };
  const ins = db.prepare(`
    INSERT OR IGNORE INTO lm_interface_daily (source_id, instance_id, day, samples, down_samples, flaps, max_in_util_pct,
      max_out_util_pct, avg_in_util_pct, avg_out_util_pct, errors_sum, discards_sum, in_mbps_avg, out_mbps_avg)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let written = 0;
  db.transaction(() => {
    for (const [iid, list] of groups) {
      let flaps = 0;
      let prev = null;
      for (const r of list) { if (r.status == null) continue; if (prev != null && r.status !== prev) flaps += 1; prev = r.status; }
      const res = ins.run(sourceId, iid, day, list.length, list.filter((r) => r.status === 2).length, flaps,
        max(list.map((r) => r.in_util_pct)), max(list.map((r) => r.out_util_pct)),
        avg(list.map((r) => r.in_util_pct)), avg(list.map((r) => r.out_util_pct)),
        list.reduce((s, r) => s + (r.in_errors || 0) + (r.out_errors || 0), 0),
        list.reduce((s, r) => s + (r.in_discards || 0) + (r.out_discards || 0), 0),
        avg(list.map((r) => r.in_mbps)), avg(list.map((r) => r.out_mbps)));
      written += res.changes;
    }
  })();
  return written;
}

/**
 * lm_interface_baseline for one portal: per interface and UTC hour of day,
 * the median and MAD of max(in, out) utilization and of in + out errors over
 * the last lm_if_baseline_days, current hour excluded, network devices only.
 * An interface needs lm_if_baseline_min_samples history rows in the window
 * (polled every 15 minutes it yields about 28 rows per hour of day in 7 days,
 * so the minimum applies to the whole window and each hour needs at least 3
 * samples). Returns rows written.
 */
function computeInterfaceBaselines(dbh, sourceId, nowMs = Date.now()) {
  const days = getThreshold('lm_if_baseline_days');
  const minTotal = getThreshold('lm_if_baseline_min_samples');
  const hourStart = Math.floor(nowMs / 3600000) * 3600000;
  const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  const rows = dbh.prepare(`
    SELECT h.instance_id, h.captured_at, h.in_util_pct, h.out_util_pct, h.in_errors, h.out_errors
    FROM lm_interface_history h
    JOIN lm_interfaces i ON i.source_id = h.source_id AND i.instance_id = h.instance_id AND i.stale = 0
    JOIN lm_devices d ON d.source_id = i.source_id AND d.lm_device_id = i.lm_device_id AND d.is_network = 1 AND d.stale = 0
    WHERE h.source_id = ? AND h.captured_at >= ? AND h.captured_at < ?
  `).all(sourceId, fmt(hourStart - days * 86400000), fmt(hourStart));
  const byInst = new Map();
  for (const r of rows) {
    if (!byInst.has(r.instance_id)) byInst.set(r.instance_id, []);
    byInst.get(r.instance_id).push(r);
  }
  const ins = dbh.prepare(`
    INSERT OR REPLACE INTO lm_interface_baseline (source_id, instance_id, hour_of_day, samples, util_median, util_mad, err_median, err_mad, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  let written = 0;
  dbh.transaction(() => {
    dbh.prepare('DELETE FROM lm_interface_baseline WHERE source_id = ?').run(sourceId);
    for (const [iid, list] of byInst) {
      if (list.length < minTotal) continue;
      const hours = new Map();
      for (const r of list) {
        const hr = new Date(`${r.captured_at.replace(' ', 'T')}Z`).getUTCHours();
        if (!hours.has(hr)) hours.set(hr, { util: [], err: [] });
        const e = hours.get(hr);
        if (r.in_util_pct != null || r.out_util_pct != null) e.util.push(Math.max(r.in_util_pct ?? -1, r.out_util_pct ?? -1));
        if (r.in_errors != null || r.out_errors != null) e.err.push((r.in_errors || 0) + (r.out_errors || 0));
      }
      for (const [hr, e] of hours) {
        if (e.util.length < 3 && e.err.length < 3) continue;
        ins.run(sourceId, iid, hr, Math.max(e.util.length, e.err.length),
          e.util.length >= 3 ? lmChecks.median(e.util) : null, e.util.length >= 3 ? lmChecks.mad(e.util) : null,
          e.err.length >= 3 ? lmChecks.median(e.err) : null, e.err.length >= 3 ? lmChecks.mad(e.err) : null);
        written += 1;
      }
    }
  })();
  return written;
}

function pruneHistories(sourceId) {
  const ifDays = getThreshold('lm_interface_history_days');
  const ckDays = getThreshold('lm_check_history_days');
  const alertDays = getThreshold('lm_alert_retention_days');
  pruneInBatches(db, 'lm_interface_history', "source_id = ? AND captured_at < datetime('now', ?)", [sourceId, `-${ifDays} days`]);
  pruneInBatches(db, 'lm_check_history', "source_id = ? AND captured_at < datetime('now', ?)", [sourceId, `-${ckDays} days`]);
  pruneInBatches(db, 'lm_alerts', 'source_id = ? AND cleared = 1 AND COALESCE(end_epoch, start_epoch, 0) < ?', [sourceId, nowSec() - alertDays * 86400]);
  pruneInBatches(db, 'lm_metrics_history', "source_id = ? AND captured_at < datetime('now', '-90 days')", [sourceId]);
  pruneInBatches(db, 'lm_webhook_events', "source_id = ? AND received_at < datetime('now', '-7 days')", [sourceId]);
  pruneInBatches(db, 'lm_blame_history', "source_id = ? AND at < datetime('now', '-90 days')", [sourceId]);
  pruneInBatches(db, 'lm_interface_daily', "source_id = ? AND day < date('now', '-400 days')", [sourceId]);
  pruneInBatches(db, 'lm_check_daily', "source_id = ? AND day < date('now', '-400 days')", [sourceId]);
}

function recordLedger(source) {
  const { recordSnapshot } = require('./configLedger');
  const groupPaths = new Map(db.prepare('SELECT lm_group_id, full_path FROM lm_device_groups WHERE source_id = ? AND stale = 0').all(source.id)
    .map((g) => [g.lm_group_id, g.full_path]));
  const collectors = new Map(db.prepare('SELECT collector_id, hostname, description, build, group_name FROM lm_collectors WHERE source_id = ? AND stale = 0').all(source.id)
    .map((c) => [c.collector_id, c]));
  recordSnapshot({
    platform: 'logicmonitor', scope: 'device-inventory', system: source.name,
    items: db.prepare('SELECT display_name, name, model, version, collector_id, group_ids_json FROM lm_devices WHERE source_id = ? AND stale = 0').all(source.id)
      .map((d) => {
        const c = collectors.get(d.collector_id);
        return {
          item: d.display_name || d.name,
          value: JSON.stringify({
            model: d.model || null,
            version: d.version || null,
            collector: c ? (c.hostname || c.description) : (d.collector_id ?? null),
            groups: (parseJson(d.group_ids_json, []) || []).map((id) => groupPaths.get(id) || String(id)).sort(),
          }),
        };
      }),
  });
  recordSnapshot({
    platform: 'logicmonitor', scope: 'collectors', system: source.name,
    items: [...collectors.values()].map((c) => ({ item: c.hostname || c.description || 'collector', value: JSON.stringify({ build: c.build || null, group: c.group_name || null }) })),
  });
  recordSnapshot({
    platform: 'logicmonitor', scope: 'admins', system: source.name,
    items: db.prepare('SELECT username, status, roles_json, apionly, two_fa FROM lm_admins WHERE source_id = ? AND stale = 0').all(source.id)
      .map((a) => ({
        item: a.username,
        value: JSON.stringify({ status: a.status || null, roles: [...(parseJson(a.roles_json, []) || [])].sort(), apionly: !!a.apionly, twoFA: !!a.two_fa }),
      })),
  });
}

const storeAdmins = db.transaction((sourceId, rows) => {
  const stmt = db.prepare(`
    INSERT INTO lm_admins (source_id, admin_id, username, email, status, roles_json, api_token_count, apionly,
      last_login_epoch, two_fa, created_by, stale, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
    ON CONFLICT(source_id, admin_id) DO UPDATE SET
      username = excluded.username, email = excluded.email, status = excluded.status, roles_json = excluded.roles_json,
      api_token_count = excluded.api_token_count, apionly = excluded.apionly, last_login_epoch = excluded.last_login_epoch,
      two_fa = excluded.two_fa, created_by = excluded.created_by, stale = 0, updated_at = datetime('now')
  `);
  const ids = [];
  for (const a of rows) {
    if (a.adminId == null) continue;
    ids.push(a.adminId);
    stmt.run(sourceId, a.adminId, a.username, a.email, a.status, JSON.stringify(a.roles), a.apiTokenCount, a.apionly,
      a.lastLoginEpoch, a.twoFa, a.createdBy);
  }
  markStale('lm_admins', 'admin_id', sourceId, ids);
});

const storeRoles = db.transaction((sourceId, rows) => {
  const stmt = db.prepare(`
    INSERT INTO lm_roles (source_id, role_id, name, description, user_count, two_fa_required, privileges_json, stale, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
    ON CONFLICT(source_id, role_id) DO UPDATE SET
      name = excluded.name, description = excluded.description, user_count = excluded.user_count,
      two_fa_required = excluded.two_fa_required, privileges_json = excluded.privileges_json, stale = 0,
      updated_at = datetime('now')
  `);
  const ids = [];
  for (const r of rows) {
    if (r.roleId == null) continue;
    ids.push(r.roleId);
    stmt.run(sourceId, r.roleId, r.name, r.description, r.userCount, r.twoFaRequired, JSON.stringify(r.privileges));
  }
  markStale('lm_roles', 'role_id', sourceId, ids);
});

/**
 * Licensed-feature discovery (features_json: websites, uptime, netflow,
 * config, topology, probedAt). Probe-only calls; a failure reads as false.
 * The ConfigSource filter (dataSourceType "CS") is UNVERIFIED.
 */
async function probeFeatures(source) {
  const websites = await lmApi.probeGet(source, '/website/websites', { size: 1 });
  const uptimeLocal = db.prepare("SELECT COUNT(*) n FROM lm_checks WHERE source_id = ? AND origin = 'uptime' AND stale = 0").get(source.id).n;
  const nf = db.prepare('SELECT lm_device_id FROM lm_devices WHERE source_id = ? AND enable_netflow = 1 AND stale = 0 LIMIT 1').get(source.id);
  const netflow = nf ? await lmApi.probeGet(source, `/device/devices/${nf.lm_device_id}/flows`, { size: 1 }) : { ok: false };
  const net = db.prepare('SELECT lm_device_id FROM lm_devices WHERE source_id = ? AND is_network = 1 AND stale = 0 LIMIT 1').get(source.id);
  const config = net ? await lmApi.probeGet(source, `/device/devices/${net.lm_device_id}/devicedatasources`, { size: 1, filter: 'dataSourceType:"CS"' }) : { ok: false };
  const topo = await lmApi.probeGet(source, '/setting/topologysources', { size: 1 });
  return mergeFeatures(source.id, {
    websites: !!(websites.ok && ((websites.count || 0) > 0 || (websites.total || 0) !== 0)),
    uptime: uptimeLocal > 0,
    netflow: !!netflow.ok,
    config: !!(config.ok && (config.count || 0) > 0),
    topology: !!(topo.ok && (topo.count || 0) > 0),
    probedAt: new Date().toISOString(),
  });
}

// -- Tier 1 poll ------------------------------------------------------------------------

async function hourlyWork(source) {
  const row = db.prepare('SELECT last_hourly_at FROM lm_sources WHERE id = ?').get(source.id);
  const hourKey = new Date().toISOString().slice(0, 13);
  if (row?.last_hourly_at && String(row.last_hourly_at).slice(0, 13) === hourKey) return { skipped: true };
  const baselines = lmChecks.computeBaselines(db, source.id);
  const daily = lmChecks.rollupCheckDaily(db, source.id, utcDay(Date.now() - 86400000));
  // raw_json is kept for the first 24 h of a sample only (probe loop), then dropped.
  db.prepare("UPDATE lm_check_history SET raw_json = NULL WHERE source_id = ? AND raw_json IS NOT NULL AND captured_at < datetime('now', '-1 day')").run(source.id);
  db.prepare('UPDATE lm_sources SET last_hourly_at = ? WHERE id = ?').run(new Date().toISOString(), source.id);
  return { baselines, daily };
}

function dailyDue(source) {
  const row = db.prepare('SELECT last_daily_at, features_json FROM lm_sources WHERE id = ?').get(source.id);
  const features = parseJson(row?.features_json, {}) || {};
  if (!features.probedAt) return true;
  return !row?.last_daily_at || row.last_daily_at !== localDay();
}

async function dailyWork(source, note) {
  const versions = await trySection('collectorVersions', async () => {
    const v = await lmApi.fetchCollectorVersions(source);
    if (v.mgd) mergeFeatures(source.id, { collectorMgd: v.mgd });
    return v;
  });
  note('collectorVersions', versions);

  const admins = await trySection('admins', () => lmApi.fetchAdmins(source));
  note('admins', admins);
  if (admins.ok) storeAdmins(source.id, admins.data);
  const roles = await trySection('roles', () => lmApi.fetchRoles(source));
  note('roles', roles);
  if (roles.ok) storeRoles(source.id, roles.data);

  // A refresh with no candidate devices made no API call, so it is not
  // counted as a successful section (the every-section-failed rule).
  const candidates = refreshCandidates(source.id);
  const refresh = await trySection('datasourceRefresh', () => refreshDevices(source, candidates));
  if (candidates.length || !refresh.ok) note('datasourceRefresh', refresh);

  try { rollupInterfaceDaily(source.id, utcDay(Date.now() - 86400000)); } catch (err) {
    logger.warn(`[LmPoller] interface daily rollup failed: ${err.message}`);
  }
  try { pruneHistories(source.id); } catch (err) { logger.warn(`[LmPoller] retention prune failed: ${err.message}`); }
  try { lmMetrics.pruneMetricsHistory(source.id); } catch (err) { logger.warn(`[LmPoller] metrics prune failed: ${err.message}`); }
  try { recordLedger(source); } catch (err) { logger.warn(`[LmPoller] config ledger failed: ${err.message}`); }
  try { buildTopologyLinks(db, source.id, { neighbors: refresh.ok ? refresh.data.neighbors : null }); } catch (err) {
    logger.warn(`[LmPoller] topology links failed: ${err.message}`);
  }
  try { lmPath.computeTiers(db, source.id); } catch (err) { logger.warn(`[LmPoller] tiers failed: ${err.message}`); }
  try { lmPath.computeCircuits(db, source.id); } catch (err) { logger.warn(`[LmPoller] circuits failed: ${err.message}`); }
  try { computeInterfaceBaselines(db, source.id); } catch (err) { logger.warn(`[LmPoller] interface baselines failed: ${err.message}`); }
  try { require('./logicmonitorMetricBaselines').computeMetricBaselines(db, source.id, require('./logicmonitorIssues').getThresholds()); } catch (err) { logger.warn(`[LmPoller] metric baselines failed: ${err.message}`); }
  try { lmWatch.pruneEpisodes(db); } catch (err) { logger.warn(`[LmPoller] episode prune failed: ${err.message}`); }
  // Weekly (computeReference skips itself while its newest row is under 6 days old).
  try { lmWatch.computeReference(db, source.id, require('./logicmonitorIssues').getThresholds()); } catch (err) { logger.warn(`[LmPoller] check reference failed: ${err.message}`); }
  const features = readFeatures(source.id);
  if (!features.probedAt) {
    try { await probeFeatures(source); } catch (err) { logger.warn(`[LmPoller] feature probe failed: ${err.message}`); }
  }
  db.prepare('UPDATE lm_sources SET last_daily_at = ? WHERE id = ?').run(localDay(), source.id);
}

function writeMetrics(sourceId) {
  const c = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM lm_devices WHERE source_id = @s AND stale = 0) devices_total,
      (SELECT COUNT(*) FROM lm_devices WHERE source_id = @s AND stale = 0 AND host_status = 'normal') devices_normal,
      (SELECT COUNT(*) FROM lm_devices WHERE source_id = @s AND stale = 0 AND host_status = 'dead') devices_dead,
      (SELECT COUNT(*) FROM lm_devices WHERE source_id = @s AND stale = 0 AND host_status = 'dead-collector') devices_dead_collector,
      (SELECT COUNT(*) FROM lm_devices WHERE source_id = @s AND stale = 0 AND sdt_status IS NOT NULL AND sdt_status != '' AND sdt_status != 'none-none-none') devices_in_sdt,
      (SELECT COUNT(*) FROM lm_devices WHERE source_id = @s AND stale = 0 AND is_network = 1) network_devices,
      (SELECT COUNT(*) FROM lm_interfaces WHERE source_id = @s AND stale = 0) interfaces_total,
      (SELECT COUNT(*) FROM lm_interfaces WHERE source_id = @s AND stale = 0 AND status_text = 'up') interfaces_up,
      (SELECT COUNT(*) FROM lm_interfaces WHERE source_id = @s AND stale = 0 AND status_text = 'down' AND COALESCE(stop_monitoring, 0) = 0) interfaces_down,
      (SELECT COUNT(*) FROM lm_alerts WHERE source_id = @s AND cleared = 0 AND duplicate_of IS NULL AND severity = 4) alerts_critical,
      (SELECT COUNT(*) FROM lm_alerts WHERE source_id = @s AND cleared = 0 AND duplicate_of IS NULL AND severity = 3) alerts_error,
      (SELECT COUNT(*) FROM lm_alerts WHERE source_id = @s AND cleared = 0 AND duplicate_of IS NULL AND severity = 2) alerts_warning,
      (SELECT COUNT(*) FROM lm_alerts WHERE source_id = @s AND cleared = 0 AND acked = 1) alerts_acked,
      (SELECT COUNT(*) FROM lm_collectors WHERE source_id = @s AND stale = 0) collectors_total,
      (SELECT COUNT(*) FROM lm_collectors WHERE source_id = @s AND stale = 0 AND is_down = 1) collectors_down,
      (SELECT COUNT(*) FROM lm_checks WHERE source_id = @s AND stale = 0) checks_total
  `).get({ s: sourceId });
  let checksDown = 0;
  let checksDegraded = 0;
  try {
    const locs = lmChecks.evaluateLocations(db, { sourceId });
    const byCheck = new Map();
    for (const l of locs) {
      const cur = byCheck.get(l.checkId) || { down: false, degraded: false };
      if (l.isOverall && l.status === 'down') cur.down = true;
      if (l.lmAlertOpen) cur.down = true;
      if (!l.isOverall && l.anomaly) cur.degraded = true;
      byCheck.set(l.checkId, cur);
    }
    for (const v of byCheck.values()) { if (v.down) checksDown += 1; else if (v.degraded) checksDegraded += 1; }
  } catch { /* checks may be empty */ }
  db.prepare(`
    INSERT INTO lm_metrics_history (source_id, devices_total, devices_normal, devices_dead, devices_dead_collector,
      devices_in_sdt, network_devices, interfaces_total, interfaces_up, interfaces_down, alerts_critical, alerts_error,
      alerts_warning, alerts_acked, collectors_total, collectors_down, checks_total, checks_down, checks_degraded)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sourceId, c.devices_total, c.devices_normal, c.devices_dead, c.devices_dead_collector, c.devices_in_sdt,
    c.network_devices, c.interfaces_total, c.interfaces_up, c.interfaces_down, c.alerts_critical, c.alerts_error,
    c.alerts_warning, c.alerts_acked, c.collectors_total, c.collectors_down, c.checks_total, checksDown, checksDegraded);
  return { ...c, checks_down: checksDown, checks_degraded: checksDegraded };
}

async function pollSource(source) {
  const sections = [];
  const note = (name, res) => sections.push({ name, ok: res.ok, error: res.error });
  try {
    const features = parseJson(source.features_json, {}) || {};

    const collectorsRes = await trySection('collectors', () => lmApi.fetchCollectors(source));
    note('collectors', collectorsRes);
    if (collectorsRes.ok) storeCollectors(source.id, collectorsRes.data);
    if (collectorsRes.ok && features.collectorMgd) {
      const behind = collectorsRes.data.filter((c) => isBehind(c.build, features.collectorMgd)).length;
      if (behind) logger.info(`[LmPoller] ${source.name}: ${behind} collector(s) below the required release ${features.collectorMgd}`);
    }

    const groupsRes = await trySection('groups', () => lmApi.fetchGroups(source));
    note('groups', groupsRes);
    if (groupsRes.ok) storeGroups(source.id, groupsRes.data);

    const groupIds = (parseJson(source.group_filter_json, []) || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
    const devicesRes = await trySection('devices', () => lmApi.fetchDevices(source, { groupIds: groupIds.length ? groupIds : null }));
    note('devices', devicesRes);
    if (devicesRes.ok) storeDevices(source.id, devicesRes.data);

    const sdtRes = await trySection('sdts', () => lmApi.fetchSdts(source));
    note('sdts', sdtRes);
    if (sdtRes.ok) storeSdts(source.id, sdtRes.data);

    const openRes = await trySection('alerts', () => lmApi.fetchOpenAlerts(source));
    note('alerts', openRes);
    const clearedRes = await trySection('clearedAlerts', () => lmApi.fetchClearedAlerts(source, clearedSince(source.id)));
    note('clearedAlerts', clearedRes);
    if (openRes.ok || clearedRes.ok) {
      storeAlerts(source.id, openRes.ok ? openRes.data : [], clearedRes.ok ? clearedRes.data : [], { openOk: openRes.ok });
      try { require('./logicmonitorDuplicates').markDuplicateAlerts(db); } catch (err) { logger.warn(`[LmPoller] duplicate marking failed: ${err.message}`); }
    }

    const websitesRes = await trySection('websites', () => lmApi.fetchWebsites(source));
    note('websites', websitesRes);
    if (websitesRes.ok) storeChecks(source.id, websitesRes.data, 'website');
    const uptimeRes = await trySection('uptimeChecks', async () => (await lmApi.fetchUptimeDevices(source)).map(lmApi.normalizeUptimeCheck));
    note('uptimeChecks', uptimeRes);
    if (uptimeRes.ok) storeChecks(source.id, uptimeRes.data, 'uptime');

    // Sites: cheap, from rows just stored (devices, collectors, checks, locations).
    try { lmSites.computeSites(db, source.id); } catch (err) { logger.warn(`[LmPoller] sites failed: ${err.message}`); }

    // New network devices and Uptime checks get their datasources now rather
    // than waiting for the daily refresh (capped per tick).
    const fresh = refreshCandidates(source.id, { onlyMissing: true }).slice(0, 25);
    if (fresh.length) {
      const freshRes = await trySection('newDeviceRefresh', () => refreshDevices(source, fresh));
      note('newDeviceRefresh', freshRes);
    }

    const checkDataRes = await trySection('checkData', () => pollCheckData(source));
    if (checkDataRes.ok ? checkDataRes.data.calls > 0 : true) note('checkData', checkDataRes);

    const hourlyRes = await trySection('hourly', () => hourlyWork(source));
    if (!hourlyRes.ok) note('hourly', hourlyRes);

    // Latency watch (round 9): episodes over the check samples just stored.
    try {
      const w = lmWatch.evaluateWatch(db, source, require('./logicmonitorIssues').getThresholds(), nowSec());
      if (w.opened || w.promoted || w.closed) logger.info(`[LmPoller] ${source.name}: latency watch opened ${w.opened}, promoted ${w.promoted}, closed ${w.closed}`);
    } catch (err) { logger.warn(`[LmPoller] latency watch failed: ${err.message}`); }

    if (dailyDue(source)) await dailyWork(source, note);

    const failures = sections.filter((s) => !s.ok);
    if (failures.length === sections.length) {
      throw new Error(failures[0]?.error || 'every LogicMonitor fetch failed');
    }

    const m = writeMetrics(source.id);
    const partial = failures.length > 0;
    db.prepare(`
      UPDATE lm_sources SET last_poll_status = ?, last_poll_error = ?, last_poll_at = datetime('now'), section_errors = ?,
        rate_limit_json = ?
      WHERE id = ?
    `).run(partial ? 'partial' : 'success',
      partial ? `Skipped: ${failures.map((f) => `${f.name} (${f.error})`).join('; ')}` : null,
      partial ? JSON.stringify(Object.fromEntries(failures.map((f) => [f.name, f.error]))) : null,
      JSON.stringify(lmApi.getRateLimitSnapshot(source.id)), source.id);
    logger.info(`[LmPoller] ${source.name}: ${m.devices_total} device(s) (${m.network_devices} network), ${m.alerts_critical + m.alerts_error + m.alerts_warning} open alert(s), ${m.checks_total} check(s)${partial ? `, ${failures.length} section(s) skipped` : ''}`);
  } catch (err) {
    db.prepare(`
      UPDATE lm_sources SET last_poll_status = 'error', last_poll_error = ?, last_poll_at = datetime('now'), section_errors = ?
      WHERE id = ?
    `).run(safeMsg(err), JSON.stringify(Object.fromEntries(sections.filter((s) => !s.ok).map((f) => [f.name, f.error]))), source.id);
    throw err;
  } finally {
    try { reconcileIssueHistory(); } catch (err) {
      logger.warn(`[LmPoller] issue-history reconcile failed: ${err.message}`);
    }
  }
}

// -- Tier 2 poll: interfaces ---------------------------------------------------------

// Datapoint names (SNMP_Network_Interfaces; Out*UtilizationPercent and the
// legacy fallbacks are UNVERIFIED) to ICC fields.
const IF_COLUMNS = {
  inMbps: ['InMbps'], outMbps: ['OutMbps'], inOctets: ['InOctets'], outOctets: ['OutOctets'],
  inErrors: ['InErrors'], outErrors: ['OutErrors'], inDiscards: ['InDiscards'], outDiscards: ['OutDiscards'],
  inUtil: ['InUtilizationPercent'], outUtil: ['OutUtilizationPercent'], status: ['Status', 'OperStatus'],
  speed: ['InInterfaceSpeed', 'InterfaceSpeed', 'Speed', 'InSpeedMbps'],
};

/** dataPoints array -> {field: index} by case-insensitive exact name. */
function mapInterfaceColumns(dataPoints) {
  const names = Array.isArray(dataPoints) ? dataPoints.map((n) => String(n)) : [];
  const lower = names.map((n) => n.toLowerCase());
  const out = {};
  for (const [field, list] of Object.entries(IF_COLUMNS)) {
    for (const cand of list) {
      const i = lower.indexOf(cand.toLowerCase());
      if (i >= 0) { out[field] = { index: i, name: names[i] }; break; }
    }
  }
  return out;
}

const cellNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null));

/**
 * One instance series to {current, average, sampledAt}: current = the LAST
 * non-gap sample per column, average = the mean of non-gap samples. Values
 * that are null or "No Data" are gaps. Mbps falls back to octets*8/1e6;
 * speed is bits per second unless the column name says Mbps and the value
 * is under 1e6, in which case it is multiplied by 1e6 (unit UNVERIFIED);
 * utilisation falls back to Mbps over speed.
 */
function summarizeInterfaceSeries(series, cols) {
  const values = Array.isArray(series?.values) ? series.values : [];
  const times = Array.isArray(series?.time) ? series.time : [];
  const current = {};
  const sums = {};
  const counts = {};
  let sampledAt = null;
  for (let i = 0; i < values.length; i += 1) {
    const row = values[i];
    if (!Array.isArray(row)) continue;
    let any = false;
    for (const [field, c] of Object.entries(cols)) {
      const v = cellNum(row[c.index]);
      if (v == null) continue;
      any = true;
      sums[field] = (sums[field] || 0) + v;
      counts[field] = (counts[field] || 0) + 1;
    }
    if (any) {
      const t = cellNum(times[i]);
      const sec = t == null ? null : (t > 1e11 ? Math.floor(t / 1000) : Math.floor(t));
      if (sec != null && (sampledAt == null || sec >= sampledAt)) sampledAt = sec;
    }
  }
  // Last non-gap per column, by time order (rows may come newest first).
  const order = values.map((_, i) => i).sort((a, b) => (cellNum(times[a]) || 0) - (cellNum(times[b]) || 0));
  for (const i of order) {
    const row = values[i];
    if (!Array.isArray(row)) continue;
    for (const [field, c] of Object.entries(cols)) {
      const v = cellNum(row[c.index]);
      if (v != null) current[field] = v;
    }
  }
  const average = {};
  for (const f of Object.keys(sums)) average[f] = sums[f] / counts[f];
  const finish = (s) => {
    let speed = s.speed ?? null;
    if (speed != null && cols.speed && /mbps/i.test(cols.speed.name) && speed < 1e6) speed *= 1e6;
    const inMbps = s.inMbps ?? (s.inOctets != null ? (s.inOctets * 8) / 1e6 : null);
    const outMbps = s.outMbps ?? (s.outOctets != null ? (s.outOctets * 8) / 1e6 : null);
    const util = (mbps) => (mbps != null && speed ? Math.min(100, (mbps * 1e6 * 100) / speed) : null);
    return {
      status: s.status != null ? Math.round(s.status) : null,
      speedBps: speed != null ? Math.round(speed) : null,
      inMbps, outMbps,
      inErrors: s.inErrors ?? null, outErrors: s.outErrors ?? null,
      inDiscards: s.inDiscards ?? null, outDiscards: s.outDiscards ?? null,
      inUtil: s.inUtil ?? util(inMbps), outUtil: s.outUtil ?? util(outMbps),
    };
  };
  return { current: finish(current), average: { ...finish(average), status: finish(current).status }, sampledAt, hasData: Object.keys(current).length > 0 };
}

const statusText = (code) => (code == null ? 'unknown' : code === 1 ? 'up' : code === 2 ? 'down' : 'other');

const storeInterfaceSamples = db.transaction((sourceId, deviceId, samples) => {
  const upd = db.prepare(`
    UPDATE lm_interfaces SET status = ?, status_text = ?, speed_bps = COALESCE(?, speed_bps), in_mbps = ?, out_mbps = ?,
      in_errors = ?, out_errors = ?, in_discards = ?, out_discards = ?, in_util_pct = ?, out_util_pct = ?,
      sampled_at_epoch = ?, updated_at = datetime('now')
    WHERE source_id = ? AND instance_id = ?
  `);
  const hist = db.prepare(`
    INSERT INTO lm_interface_history (source_id, instance_id, status, in_mbps, out_mbps, in_errors, out_errors,
      in_discards, out_discards, in_util_pct, out_util_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const { instanceId, current: c, average: a, sampledAt } of samples) {
    upd.run(c.status, statusText(c.status), c.speedBps, c.inMbps, c.outMbps, c.inErrors, c.outErrors, c.inDiscards,
      c.outDiscards, c.inUtil, c.outUtil, sampledAt, sourceId, instanceId);
    hist.run(sourceId, instanceId, a.status, a.inMbps, a.outMbps, a.inErrors, a.outErrors, a.inDiscards, a.outDiscards,
      a.inUtil, a.outUtil);
  }
  db.prepare(`
    UPDATE lm_devices SET
      if_count = (SELECT COUNT(*) FROM lm_interfaces WHERE source_id = ? AND lm_device_id = ? AND stale = 0),
      if_up = (SELECT COUNT(*) FROM lm_interfaces WHERE source_id = ? AND lm_device_id = ? AND stale = 0 AND status_text = 'up')
    WHERE source_id = ? AND lm_device_id = ?
  `).run(sourceId, deviceId, sourceId, deviceId, sourceId, deviceId);
});

/** Map one data response onto a device's stored interfaces. Pure over the
 *  rows handed in; returns [{instanceId, current, average, sampledAt}]. */
function mapInterfaceResponse(body, interfaceRows) {
  const cols = mapInterfaceColumns(body?.dataPoints);
  const dsName = body?.dataSourceName || '';
  const out = [];
  for (const [key, series] of Object.entries(body?.instances || {})) {
    const row = matchInstance(interfaceRows, key, dsName);
    if (!row) continue;
    const s = summarizeInterfaceSeries(series, cols);
    if (!s.hasData) continue;
    out.push({ instanceId: row.instance_id, ...s });
  }
  return out;
}

/** Interface window: since the device's last sample minus 60 s, at least 5
 *  minutes, at most 60 minutes. */
function interfaceWindow(lastEpoch, now = nowSec()) {
  const start = Math.max(now - 3600, Math.min(lastEpoch ? lastEpoch - 60 : 0, now - 300));
  return { start, end: now };
}

async function pollInterfaces(source) {
  const roles = parseJson(source.interface_categories_json, null);
  const roleFilter = Array.isArray(roles) && roles.length ? roles.map(String) : null;
  const devices = db.prepare(`
    SELECT d.lm_device_id, d.display_name, d.role, x.hds_id,
      (SELECT MAX(sampled_at_epoch) FROM lm_interfaces i WHERE i.source_id = d.source_id AND i.lm_device_id = d.lm_device_id) last_sample
    FROM lm_devices d
    JOIN lm_device_datasources x ON x.source_id = d.source_id AND x.lm_device_id = d.lm_device_id AND x.is_interface = 1
    WHERE d.source_id = ? AND d.is_network = 1 AND d.stale = 0
    ORDER BY d.lm_device_id
  `).all(source.id).filter((d) => !roleFilter || roleFilter.includes(d.role));
  let features = parseJson(source.features_json, {}) || {};
  let ok = 0;
  let failed = 0;
  let lastErr = null;
  const ifRowsStmt = db.prepare('SELECT instance_id, instance_name, display_name FROM lm_interfaces WHERE source_id = ? AND lm_device_id = ? AND stale = 0');
  const inFlight = callsInFlight('logicmonitor');
  const startedAt = Date.now();
  try {
    await mapLimit(devices, inFlight, async (d) => {
      try {
        const known = Array.isArray(features.ifColumns) && features.ifColumns.length ? features.ifColumns : null;
        // First call per portal goes without datapoints= to learn the
        // dataPoints array; later calls narrow to names that exist.
        let datapoints = null;
        if (known) {
          const wanted = Object.values(IF_COLUMNS).flat().filter((n) => known.includes(n));
          datapoints = wanted.length ? wanted.join(',') : null;
        }
        const body = await lmApi.fetchDsData(source, d.lm_device_id, d.hds_id, { ...interfaceWindow(d.last_sample), aggregate: 'average', datapoints });
        if (!known && Array.isArray(body?.dataPoints) && body.dataPoints.length && !(Array.isArray(features.ifColumns) && features.ifColumns.length)) {
          features = mergeFeatures(source.id, { ifColumns: body.dataPoints.map(String) });
        }
        const samples = mapInterfaceResponse(body, ifRowsStmt.all(source.id, d.lm_device_id));
        storeInterfaceSamples(source.id, d.lm_device_id, samples);
        ok += 1;
      } catch (err) {
        failed += 1;
        lastErr = safeMsg(err);
        logger.warn(`[LmPoller] interface data for ${d.display_name || d.lm_device_id} failed: ${lastErr}`);
      }
    });
    if (devices.length && ok === 0) throw new Error(`interface data failed on every device (${failed}): ${lastErr}`);
    db.prepare(`
      UPDATE lm_sources SET last_interface_poll_at = datetime('now'), last_interface_poll_error = ?, rate_limit_json = ? WHERE id = ?
    `).run(failed ? `Skipped ${failed} of ${devices.length} device(s): ${lastErr}` : null,
      JSON.stringify(lmApi.getRateLimitSnapshot(source.id)), source.id);
    logger.info(`[LmPoller] ${source.name}: interfaces polled on ${ok} device(s)${failed ? `, ${failed} failed` : ''}, in flight ${inFlight}, ${Math.round((Date.now() - startedAt) / 100) / 10} s`);
    return { ok, failed, devices: devices.length, inFlight };
  } catch (err) {
    db.prepare("UPDATE lm_sources SET last_interface_poll_at = datetime('now'), last_interface_poll_error = ? WHERE id = ?")
      .run(safeMsg(err), source.id);
    throw err;
  }
}

// -- Poller framework instances -----------------------------------------------------

// Config columns only (BlueCat lesson 2026-09-09): last_* columns are not
// selected so a poll's own writes never look like a config change.
const loadSources = () => db.prepare(`
  SELECT id, name, company, auth_mode, encrypted_credentials, verify_ssl, enabled, polling_interval_minutes,
    interface_poll_minutes, metrics_poll_minutes, metrics_families_json, group_filter_json, interface_categories_json, features_json
  FROM lm_sources WHERE enabled = 1
`).all();

const lmPoller = createPoller({
  id: 'logicmonitor',
  loadSources,
  intervalMinutes: (s) => s.polling_interval_minutes,
  serialize: true,
  defaultIntervalMinutes: 5,
  poll: pollSource,
});

const lmInterfacePoller = createPoller({
  id: 'logicmonitor-interfaces',
  loadSources,
  intervalMinutes: (s) => s.interface_poll_minutes,
  serialize: true,
  maxRunMinutes: 12,
  defaultIntervalMinutes: 15,
  poll: pollInterfaces,
});

// Tier 3 (round 8): catalog-driven DataSource metrics. Inert in demo mode.
const lmMetricsPoller = createPoller({
  id: 'logicmonitor-metrics',
  loadSources,
  intervalMinutes: (s) => s.metrics_poll_minutes,
  serialize: true,
  maxRunMinutes: 25,
  defaultIntervalMinutes: 30,
  poll: (source) => (isDemo() ? Promise.resolve({ inert: true }) : lmMetrics.pollMetrics(source)),
});

function initLogicmonitorPoller() {
  const a = lmPoller.init();
  const b = lmInterfacePoller.init();
  const c = lmMetricsPoller.init();
  logger.info(`[LmPoller] Initialized ${a.length} source(s) (inventory), ${b.length} (interfaces), ${c.length} (metrics)`);
  return a;
}

const resolveSource = (sourceOrId) => (typeof sourceOrId === 'object' && sourceOrId
  ? sourceOrId
  : loadSources().find((s) => Number(s.id) === Number(sourceOrId)) || null);

function createLogicmonitorPollerHandle() {
  return {
    init: () => initLogicmonitorPoller(),
    stopAll: () => { lmPoller.stopAll(); lmInterfacePoller.stopAll(); lmMetricsPoller.stopAll(); },
    trigger: (sourceOrId) => {
      const s = resolveSource(sourceOrId);
      return s ? lmPoller.trigger(s) : Promise.resolve();
    },
    triggerInterfaces: (sourceOrId) => {
      const s = resolveSource(sourceOrId);
      return s ? lmInterfacePoller.trigger(s) : Promise.resolve();
    },
    triggerMetrics: (sourceOrId) => {
      const s = resolveSource(sourceOrId);
      return s ? lmMetricsPoller.trigger(s) : Promise.resolve();
    },
    schedule: (source) => { lmPoller.schedule(source); lmInterfacePoller.schedule(source); lmMetricsPoller.schedule(source); },
    cancel: (sourceId) => { lmPoller.cancel(sourceId); lmInterfacePoller.cancel(sourceId); lmMetricsPoller.cancel(sourceId); },
    taskCount: () => lmPoller.taskCount() + lmInterfacePoller.taskCount() + lmMetricsPoller.taskCount(),
  };
}

// Singleton shared by routes and the manifest (same task maps).
const logicmonitorPollerHandle = createLogicmonitorPollerHandle();

module.exports = {
  lmPoller, lmInterfacePoller, lmMetricsPoller, loadSources,
  initLogicmonitorPoller, createLogicmonitorPollerHandle, logicmonitorPollerHandle,
  pollSource, pollInterfaces, probeFeatures,
  buildTopologyLinks, parseLinkDescription, parseNeighborInstance, buildDeviceIndex, makeResolver,
  storeAlerts, upsertAlertRow, computeInterfaceBaselines, refreshCandidates, storeDevices, storeCollectors, storeChecks, appendCheckRows, clearedSince,
  mapInterfaceColumns, summarizeInterfaceSeries, mapInterfaceResponse, matchInstance, statusText,
  checkWindow, interfaceWindow, rollupInterfaceDaily, pruneHistories, writeMetrics,
  IF_COLUMNS,
};
