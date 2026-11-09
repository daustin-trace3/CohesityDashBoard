'use strict';

// Data retention: two buckets per platform, resolved platform override -> global -> default.
//
//   trending  metrics, capacity, performance, daily rollups, chart history   default 365 days
//   events    vendor events, stored alerts, hardware logs, resolved issues   default 30 days
//
// Setting keys (app_settings):
//   retention_<bucket>_days               global value
//   retention_<platform>_<bucket>_days    platform override; blank or absent = inherit
// Value meaning everywhere: blank = inherit, 0 = keep forever (no prune), N = N days.
//
// Prune sites call prune(db, {...}) or days(platform, bucket). Raw high-frequency sample
// tables (LogicMonitor datapoint, interface and check history, Brocade port stats) and the
// opt-in ledgers (Cohesity runs, Aria deployments, LM circuit events, config ledger) keep
// their own platform keys and are NOT covered here; see COVERAGE for what is.

const { pruneInBatches } = require('./dbPrune');

const DAY_MS = 86400 * 1000;

const BUCKETS = Object.freeze({
  trending: Object.freeze({
    key: 'trending', label: 'Trending history', default: 365, min: 30, max: 3650,
    description: 'Metrics, capacity, performance and daily rollups used by charts and trends.',
  }),
  events: Object.freeze({
    key: 'events', label: 'Events and alerts', default: 30, min: 7, max: 3650,
    description: 'Vendor events, stored alerts, hardware logs and resolved issue history.',
  }),
});
const BUCKET_KEYS = Object.freeze(Object.keys(BUCKETS));

// What each bucket covers per platform (table names), shown on the settings pages and
// checked by core/retention.test.js against the migrated schema. Keep in step with the
// prune sites: a table listed here is pruned through this module.
const COVERAGE = Object.freeze({
  cohesity: { trending: ['metrics_history', 'workload_history'], events: [] },
  pure: { trending: ['pure_metrics_history', 'pure_volume_history', 'pure1_metrics_history'], events: [] },
  netapp: { trending: ['netapp_metrics_history'], events: [] },
  zerto: { trending: ['zerto_metrics_history'], events: ['zerto_events'] },
  vcenter: {
    trending: ['vcenter_capacity_history', 'vcenter_vm_capacity_history', 'vcenter_host_capacity_history',
      'vcenter_datastore_history', 'vcenter_vm_daily', 'vcenter_host_daily', 'vcenter_vm_filesystem_history',
      'vcenter_metrics_history'],
    events: ['vcenter_events', 'vcenter_issue_history'],
  },
  dell: { trending: ['dell_metrics_history'], events: ['dell_hardware_logs', 'dell_alerts'] },
  brocade: { trending: [], events: ['brocade_events'] },
  aria: { trending: ['aria_metrics_history'], events: ['aria_issue_history'] },
  ariaops: { trending: ['ariaops_metrics_history'], events: [] },
  aws: {
    trending: ['aws_cost_resource_daily', 'aws_cost_resource_usage_daily', 'aws_metrics_history', 'aws_ec2_metrics_daily',
      'aws_rds_storage_history', 'aws_s3_size_history', 'aws_cost_alloc_daily', 'aws_sp_utilization_daily',
      'aws_sp_coverage_daily', 'aws_ri_utilization_daily', 'aws_ri_coverage_daily', 'aws_cost_forecast',
      'aws_budget_status', 'aws_cost_resource_estimate_daily', 'aws_cost_comparison'],
    events: ['aws_health_events', 'aws_cost_anomalies', 'aws_issue_history'],
  },
  bluecat: { trending: ['bluecat_metrics_history'], events: ['bluecat_issue_history'] },
  unifi: { trending: ['unifi_port_history', 'unifi_metrics_history'], events: ['unifi_events', 'unifi_issue_history'] },
  logicmonitor: {
    trending: ['lm_metrics_history', 'lm_ds_daily', 'lm_device_daily', 'lm_interface_daily', 'lm_check_daily'],
    events: ['lm_alerts', 'lm_blame_history', 'lm_issue_history', 'lm_latency_episodes'],
  },
  eon: { trending: ['eon_storage_summary', 'eon_metrics_history', 'eon_cost_daily'], events: ['eon_issue_history'] },
  hyperv: {
    trending: ['hyperv_host_history', 'hyperv_vm_history', 'hyperv_volume_history', 'hyperv_metrics_history',
      'hyperv_vm_daily', 'hyperv_host_daily'],
    events: ['hyperv_events', 'hyperv_issue_history'],
  },
  netbackup: { trending: ['netbackup_workload_history', 'netbackup_metrics_history'], events: ['netbackup_issue_history'] },
  proxmox: { trending: [], events: ['proxmox_issue_history', 'proxmox_events', 'proxmox_tasks'] },
  // Cross-platform rows follow the global values only (no override row in the UI).
  icc: { trending: ['service_status_timeline', 'service_group_status_timeline'], events: ['service_alert_events', 'service_alert_analyses'] },
});

// Legacy per-table keys folded into a bucket. Migration core v36 (feat) / v35 (icc-phase1)
// copies a saved legacy value into the platform override (largest wins per bucket) once;
// the old rows stay in app_settings and are ignored from then on.
const LEGACY_KEYS = Object.freeze({
  vcenter: {
    trending: ['vcenter_vm_history_days', 'vcenter_host_history_days', 'vcenter_cluster_history_days',
      'vcenter_datastore_history_days', 'vcenter_daily_history_days'],
    events: ['vcenter_event_retention_days'],
  },
  hyperv: {
    trending: ['hyperv_vm_history_days', 'hyperv_host_history_days', 'hyperv_volume_history_days',
      'hyperv_daily_history_days', 'hyperv_metrics_history_days'],
    events: ['hyperv_event_retention_days'],
  },
  logicmonitor: { trending: ['lm_daily_history_days'], events: ['lm_alert_retention_days'] },
  brocade: { trending: [], events: ['brocade_event_retention_days'] },
  zerto: { trending: [], events: ['zerto_event_retention_days'] },
});

let settingsMod = null;
function settings() {
  if (!settingsMod) settingsMod = require('../services/settings');
  return settingsMod;
}

function assertBucket(bucket) {
  if (!BUCKETS[bucket]) throw new Error(`retention: unknown bucket ${String(bucket)}`);
  return BUCKETS[bucket];
}

function globalKey(bucket) { assertBucket(bucket); return `retention_${bucket}_days`; }
function platformKey(platform, bucket) {
  assertBucket(bucket);
  if (!/^[a-z0-9_-]+$/.test(String(platform))) throw new Error(`retention: bad platform id ${String(platform)}`);
  return `retention_${platform}_${bucket}_days`;
}

/**
 * Parses a stored or posted value. Returns null for inherit (blank, absent, not a number),
 * 0 for keep forever, or a whole day count inside the bucket's range. Out of range is null,
 * so a bad row never shortens retention below the bucket minimum.
 */
function parseDays(raw, bucket) {
  const b = assertBucket(bucket);
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const d = Math.round(n);
  if (d === 0) return 0;
  if (d < b.min || d > b.max) return null;
  return d;
}

/** Validates a value posted by the UI. { ok, days } or { ok: false, error }. */
function validate(value, bucket, { allowInherit = false } = {}) {
  const b = assertBucket(bucket);
  if (value == null || value === '') {
    return allowInherit ? { ok: true, days: null } : { ok: false, error: `${b.label} needs a number of days` };
  }
  const n = Number(value);
  if (!Number.isFinite(n) || Math.round(n) !== n) return { ok: false, error: `${b.label} must be a whole number of days` };
  if (n === 0) return { ok: true, days: 0 };
  if (n < b.min || n > b.max) return { ok: false, error: `${b.label} must be 0 (keep forever) or ${b.min} to ${b.max} days` };
  return { ok: true, days: n };
}

function globalDays(bucket) {
  const b = assertBucket(bucket);
  const saved = parseDays(settings().getSetting(globalKey(bucket)), bucket);
  if (saved == null) return { days: b.default, source: 'default', saved: null };
  return { days: saved, source: 'global', saved };
}

/**
 * Effective retention for one platform and bucket.
 * { days, source: 'platform' | 'global' | 'default', override, global }
 * days 0 means keep forever.
 */
function resolve(platform, bucket) {
  const g = globalDays(bucket);
  const override = parseDays(settings().getSetting(platformKey(platform, bucket)), bucket);
  if (override == null) return { days: g.days, source: g.source, override: null, global: g.days };
  return { days: override, source: 'platform', override, global: g.days };
}

function days(platform, bucket) { return resolve(platform, bucket).days; }

/** Writes a global value (number, 0 = keep). */
function setGlobal(bucket, value) {
  const v = validate(value, bucket);
  if (!v.ok) throw Object.assign(new Error(v.error), { status: 400, field: bucket });
  settings().setSetting(globalKey(bucket), String(v.days));
  return v.days;
}

/** Writes a platform override; null or '' clears it (inherit). */
function setPlatform(platform, bucket, value) {
  const v = validate(value, bucket, { allowInherit: true });
  if (!v.ok) throw Object.assign(new Error(v.error), { status: 400, field: bucket });
  settings().setSetting(platformKey(platform, bucket), v.days == null ? '' : String(v.days));
  return v.days;
}

/**
 * Builds the age predicate for a column written in one of these shapes:
 *   datetime  SQLite 'YYYY-MM-DD HH:MM:SS' or ISO text compared with datetime('now', ?)
 *   date      'YYYY-MM-DD' day keys compared with date('now', ?)
 *   iso       JS ISO text compared with a bound ISO cutoff (safe for 'T' stamps)
 *   epoch_s   integer seconds
 *   epoch_ms  integer milliseconds
 */
function agePredicate(column, kind, d, now = Date.now()) {
  if (!/^[a-zA-Z0-9_.()\s,]+$/.test(column)) throw new Error('retention: bad column ' + column);
  switch (kind) {
    case 'datetime': return { sql: `${column} < datetime('now', ?)`, params: [`-${d} days`] };
    case 'date': return { sql: `${column} < date('now', ?)`, params: [`-${d} days`] };
    case 'iso': return { sql: `${column} < ?`, params: [new Date(now - d * DAY_MS).toISOString()] };
    case 'epoch_s': return { sql: `${column} < ?`, params: [Math.floor(now / 1000) - d * 86400] };
    case 'epoch_ms': return { sql: `${column} < ?`, params: [now - d * DAY_MS] };
    default: throw new Error('retention: unknown kind ' + String(kind));
  }
}

/**
 * Prunes aged rows of one table under the platform's bucket value.
 *   prune(db, { platform, bucket, table, column, kind, where, params })
 * `where` is an optional extra predicate ANDed in front (e.g. "source_id = ?" with params).
 * Returns { deleted, batches, days, skipped }. days 0 skips the delete entirely.
 */
function prune(db, { platform, bucket, table, column, kind = 'datetime', where = '', params = [], now } = {}) {
  const d = days(platform, bucket);
  if (d === 0) return { deleted: 0, batches: 0, days: 0, skipped: true };
  const age = agePredicate(column, kind, d, now);
  const sql = where ? `${where} AND ${age.sql}` : age.sql;
  const r = pruneInBatches(db, table, sql, [...params, ...age.params]);
  return { deleted: r.deleted, batches: r.batches, days: d, skipped: false };
}

/**
 * One-time fold of legacy per-table keys into platform overrides. Runs inside the core
 * migration with the raw db handle (no settings module), so it reads app_settings directly.
 * Largest saved legacy value per bucket wins; an existing override is never replaced;
 * legacy rows are left in place.
 */
function migrateLegacy(db) {
  const get = db.prepare('SELECT value FROM app_settings WHERE key = ?');
  const put = db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  const written = [];
  for (const [platform, buckets] of Object.entries(LEGACY_KEYS)) {
    for (const bucket of BUCKET_KEYS) {
      const keys = buckets[bucket] || [];
      if (!keys.length) continue;
      const target = platformKey(platform, bucket);
      const existing = get.get(target);
      if (existing && String(existing.value).trim() !== '') continue;
      let best = null;
      for (const k of keys) {
        const row = get.get(k);
        const d = row ? parseDays(row.value, bucket) : null;
        if (d == null) continue;
        if (d === 0) { best = 0; break; } // a keep-forever legacy value wins outright
        if (best == null || d > best) best = d;
      }
      if (best == null) continue;
      put.run(target, String(best));
      written.push({ platform, bucket, days: best });
    }
  }
  return written;
}

module.exports = {
  BUCKETS, BUCKET_KEYS, COVERAGE, LEGACY_KEYS, DAY_MS,
  globalKey, platformKey, parseDays, validate,
  globalDays, resolve, days, setGlobal, setPlatform,
  agePredicate, prune, migrateLegacy,
};
