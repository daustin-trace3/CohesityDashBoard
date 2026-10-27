// AWS FinOps collector and computations (round of 2026-10-27).
//
// captureFinops runs once a day on the ELECTED account row (see awsPoller.isElected), gated by
// aws_accounts.last_finops_capture_at, after the existing Cost Explorer block. Every Cost
// Explorer capability below runs through capability(): a denied or not-enabled call records its
// status in aws_capability_status (with the IAM action the message names) and the capture carries
// on; only credential failures rethrow. Each request costs 0.01 USD, so the request count is
// stored per capability and summed for the Settings panel.
//
// Pure functions (linearForecast, iccAnomalies, budgetState, allocationSummary,
// bedrockModelForService) take rows and return rows so the vitest suites drive them without AWS;
// unitEconomics, evaluateBudgets, detectIccAnomalies and reconcileRecommendationState read and
// write the stored rows. Compute happens before any transaction opens. Timestamps this module
// writes are ISO strings (with the T); day columns are YYYY-MM-DD in UTC.
//
// The pack copy lives at plugin-sdk/aws/backend/src/finops.js.
const db = require('../db/database');
const { getSetting, setSetting } = require('./settings');
const { pruneInBatches } = require('../core/dbPrune');
const awsApi = require('./awsApi');
const logger = require('../utils/logger');

// awsPoller requires this module lazily (inside pollAccount); this module needs the poller's
// upserts and credential check, so it reaches back lazily too and the two never load each other
// at require time.
const poller = () => require('./awsPoller');

/** Capability ids, in the order the capture reports them. */
const CAPABILITIES = [
  'cost_tags', 'tag_keys', 'linked_accounts', 'forecast', 'sp_utilization', 'sp_coverage',
  'ri_utilization', 'ri_coverage', 'anomalies', 'rightsizing', 'sp_recommendation',
];

/** IAM action each capability needs; printed in the policy snippet when the status is denied. */
const CAPABILITY_ACTIONS = {
  cost_tags: ['ce:GetCostAndUsage'],
  tag_keys: ['ce:ListCostAllocationTags'],
  linked_accounts: ['ce:GetDimensionValues', 'ce:GetCostAndUsage'],
  forecast: ['ce:GetCostForecast'],
  sp_utilization: ['ce:GetSavingsPlansUtilization', 'ce:GetSavingsPlansUtilizationDetails'],
  sp_coverage: ['ce:GetSavingsPlansCoverage'],
  ri_utilization: ['ce:GetReservationUtilization'],
  ri_coverage: ['ce:GetReservationCoverage'],
  anomalies: ['ce:GetAnomalyMonitors', 'ce:GetAnomalies'],
  rightsizing: ['ce:GetRightsizingRecommendation'],
  sp_recommendation: ['ce:GetSavingsPlansPurchaseRecommendation'],
  cost_resources: ['ce:GetCostAndUsageWithResources'],
};

const DAY_MS = 86400000;
const MONTH_DAYS = 30.4;

// -- small helpers -------------------------------------------------------------------------

const utcDay = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (day, n) => utcDay(new Date(`${day}T00:00:00Z`).getTime() + n * DAY_MS);
const monthOf = (day) => String(day).slice(0, 7);
const monthStart = (day) => `${monthOf(day)}-01`;
function nextMonthStart(day) {
  const [y, m] = monthOf(day).split('-').map(Number);
  return utcDay(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1));
}
function addMonths(day, n) {
  const [y, m] = monthOf(day).split('-').map(Number);
  return utcDay(Date.UTC(y, m - 1 + n, 1));
}
const daysInMonthOf = (day) => Math.round((new Date(`${nextMonthStart(day)}T00:00:00Z`) - new Date(`${monthStart(day)}T00:00:00Z`)) / DAY_MS);
const dayDiff = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / DAY_MS);

function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
const round2 = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 100) / 100);
const num = (v, fallback = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };
const nowIso = (now) => new Date(now || Date.now()).toISOString();

function clampInt(raw, def, min, max) {
  const n = Number(raw);
  if (raw == null || raw === '' || !Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}
function clampFloat(raw, def, min, max) {
  const n = Number(raw);
  if (raw == null || raw === '' || !Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}
function parseJsonArray(raw) {
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** Parsed, clamped FinOps settings in the camelCase the /config route returns (legacy keys excluded). */
function finopsSettings() {
  const metric = getSetting('aws_finops_metric');
  const linked = getSetting('aws_finops_linked_accounts');
  return {
    finopsMetric: metric === 'unblended' ? 'unblended' : 'amortized',
    finopsTagKeys: parseJsonArray(getSetting('aws_finops_tag_keys'))
      .map((k) => String(k)).filter((k) => k.length >= 1 && k.length <= 128).slice(0, 10),
    finopsLinkedAccounts: ['auto', 'on', 'off'].includes(linked) ? linked : 'auto',
    anomalyPct: clampInt(getSetting('aws_finops_anomaly_pct'), 30, 5, 500),
    anomalyFloorUsd: clampFloat(getSetting('aws_finops_anomaly_floor_usd'), 5, 0, 100000),
    anomalyBaselineDays: clampInt(getSetting('aws_finops_anomaly_baseline_days'), 7, 3, 30),
    anomalyClearDays: clampInt(getSetting('aws_finops_anomaly_clear_days'), 2, 1, 14),
    spUtilWarnPct: clampInt(getSetting('aws_finops_sp_util_warn_pct'), 80, 1, 100),
    spExpiryWarnDays: clampInt(getSetting('aws_finops_sp_expiry_warn_days'), 30, 1, 365),
    priceGp2ToGp3PerGb: clampFloat(getSetting('aws_price_gp2_to_gp3_per_gb'), 0.02, 0, 10),
    priceEbsGp2PerGb: clampFloat(getSetting('aws_price_ebs_gp2_per_gb'), 0.10, 0, 10),
    priceEbsGp3PerGb: clampFloat(getSetting('aws_price_ebs_gp3_per_gb'), 0.08, 0, 10),
    priceNatGatewayMonth: clampFloat(getSetting('aws_price_nat_gateway_month'), 32.85, 0, 1000),
    finopsDigestEnabled: getSetting('aws_finops_digest_enabled') === '1',
    finopsDigestRecipients: String(getSetting('aws_finops_digest_recipients') || ''),
    finopsDigestWeekday: clampInt(getSetting('aws_finops_digest_weekday'), 1, 1, 7),
    tagKeysSeen: parseJsonArray(getSetting('aws_finops_tag_keys_seen')).map(String),
  };
}

/** SQL expression for the chosen cost metric over a table that has amount_usd + amortized_usd. */
const costExpr = (metric, alias = '') => {
  const p = alias ? `${alias}.` : '';
  return metric === 'unblended' ? `${p}amount_usd` : `COALESCE(${p}amortized_usd, ${p}amount_usd)`;
};

// -- capability wrapper --------------------------------------------------------------------

function setCapabilityStatus(accountId, id, { status, error = null, requests = 0, ok = false }, now) {
  const iso = nowIso(now);
  db.prepare(`
    INSERT INTO aws_capability_status (account_id, capability, status, error, requests, last_ok_at, last_checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, capability) DO UPDATE SET
      status = excluded.status, error = excluded.error, requests = excluded.requests,
      last_ok_at = COALESCE(excluded.last_ok_at, aws_capability_status.last_ok_at),
      last_checked_at = excluded.last_checked_at
  `).run(accountId, id, status, error, requests, ok ? iso : null, iso);
}

/** Every "perform: ce:X" action a (possibly joined) AccessDenied message names, de-duplicated. */
function deniedActions(message) {
  const out = [];
  const re = /perform:\s*([a-z0-9-]+:[A-Za-z0-9*]+)/g;
  let m;
  while ((m = re.exec(String(message || '')))) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/**
 * Run one capability. fn returns { requests } (rows are stored inside fn). Success records 'ok';
 * a failure is classified (denied / not_enabled / error) and recorded, the capture carries on.
 * Credential errors rethrow BEFORE classification.
 */
async function capability(account, id, fn) {
  try {
    const out = (await fn()) || {};
    setCapabilityStatus(account.id, id, { status: 'ok', error: out.note || null, requests: out.requests || 0, ok: true });
    return { status: 'ok', requests: out.requests || 0, out };
  } catch (err) {
    if (poller()._isCredentialError(err)) throw err;
    if (err?.name === 'DataUnavailableException') {
      // Nothing to report yet (no Savings Plans or reservations on the account): not a failure.
      setCapabilityStatus(account.id, id, { status: 'ok', error: 'No data available for this account yet.', requests: 1, ok: true });
      return { status: 'ok', requests: 1, out: {} };
    }
    const status = awsApi.classifyCeError(err);
    const message = String(err?.message || err).slice(0, 500);
    setCapabilityStatus(account.id, id, { status, error: message, requests: 0 });
    logger.warn(`[AwsFinops] ${account.name}: ${id} ${status}: ${message.slice(0, 200)}`);
    return { status, requests: 0, out: {} };
  }
}

/**
 * Run several independent sub-calls of one capability so a denial on the first does not hide a
 * denial on the second (the policy snippet should list every missing action in one go). Rejects
 * with the first failure's name and every message joined when any part failed.
 */
async function parts(fns) {
  let requests = 0;
  const failures = [];
  for (const f of fns) {
    try { requests += (await f()) || 0; } catch (err) { failures.push(err); }
  }
  if (failures.length) {
    const first = failures[0];
    const joined = new Error(failures.map((e) => e?.message || String(e)).join(' | '));
    joined.name = first?.name || 'Error';
    joined.requests = requests;
    throw joined;
  }
  return requests;
}

// -- pure computations ---------------------------------------------------------------------

/**
 * End of month forecast from the stored daily totals. dailyTotals = [{ day, usd }] ascending.
 * run rate = mean of the last 7 COMPLETE days ending two days before today (yesterday may be
 * partial); forecast = mtd + run rate x days left in the month (today included); band 0.85 / 1.15.
 * null when fewer than 3 complete days exist in that window.
 */
function linearForecast({ mtdUsd, dailyTotals, today }) {
  const last = addDays(today, -2);
  const first = addDays(today, -8);
  const window = (dailyTotals || []).filter((r) => r.day >= first && r.day <= last).slice(-7);
  if (window.length < 3) return null;
  const runRate = window.reduce((n, r) => n + num(r.usd), 0) / window.length;
  const daysLeft = daysInMonthOf(today) - Number(today.slice(8, 10)) + 1;
  const meanUsd = num(mtdUsd) + runRate * daysLeft;
  return { meanUsd, lowerUsd: meanUsd * 0.85, upperUsd: meanUsd * 1.15, source: 'linear' };
}

function budgetState({ amountUsd, warnPct, critPct, forecastAlert, actualUsd, forecastUsd }) {
  const pctActual = amountUsd > 0 ? (num(actualUsd) / amountUsd) * 100 : 0;
  if (pctActual >= critPct) return 'crit';
  if (pctActual >= warnPct) return 'warn';
  if (forecastAlert && forecastUsd != null && forecastUsd >= amountUsd) return 'forecast_warn';
  return 'ok';
}

/**
 * ICC's own per-service anomaly rule. Pure: rows = [{ day, service, usageType, usd }], open = current
 * open icc rows [{ anomalyId, scopeKey, startDay, expectedUsd }], rule = { pct, floorUsd,
 * baselineDays, clearDays }, today = 'YYYY-MM-DD' (UTC; today itself is partial and never evaluated).
 *
 * New: a service with a 7-day median of at least 1 USD a day, and no open row, fires when day D
 * (yesterday or the day before, earlier wins) exceeds the median of the baselineDays before D by
 * more than max(baseline x pct / 100, floorUsd). Open rows are judged against their own frozen
 * baseline: the count of consecutive normal days ending yesterday (so re-running the same day
 * never double counts) closes the row at clearDays and an elevated yesterday resets it to 0.
 */
function iccAnomalies({ rows, open, rule, today }) {
  const byService = new Map();
  const byUsage = new Map();
  for (const r of rows || []) {
    const usd = num(r.usd);
    if (!byService.has(r.service)) { byService.set(r.service, new Map()); byUsage.set(r.service, new Map()); }
    const series = byService.get(r.service);
    series.set(r.day, (series.get(r.day) || 0) + usd);
    const usage = byUsage.get(r.service);
    if (!usage.has(r.usageType)) usage.set(r.usageType, new Map());
    const um = usage.get(r.usageType);
    um.set(r.day, (um.get(r.day) || 0) + usd);
  }
  const threshold = (baseline) => Math.max(baseline * rule.pct / 100, rule.floorUsd);
  const out = { open: [], close: [], keepOpen: [] };

  const openByService = new Map((open || []).map((o) => [o.scopeKey, o]));
  for (const o of open || []) {
    const series = byService.get(o.scopeKey) || new Map();
    const baseline = num(o.expectedUsd);
    let streak = 0;
    let lastElevated = null;
    for (let d = addDays(today, -1); d >= o.startDay; d = addDays(d, -1)) {
      const v = series.get(d) || 0;
      if (v - baseline > threshold(baseline)) { lastElevated = d; break; }
      streak++;
    }
    if (streak >= rule.clearDays) {
      out.close.push({ anomalyId: o.anomalyId, endDay: lastElevated || o.startDay });
    } else {
      const actual = series.get(addDays(today, -1)) || 0;
      out.keepOpen.push({
        anomalyId: o.anomalyId, normalDays: streak, elevated: streak === 0, actualUsd: actual,
        impactUsd: actual - baseline, impactPct: baseline > 0 ? ((actual - baseline) / baseline) * 100 : null,
      });
    }
  }

  for (const [service, series] of byService) {
    if (openByService.has(service)) continue;
    const last7 = [];
    for (let i = 1; i <= 7; i++) last7.push(series.get(addDays(today, -i)) || 0);
    if (median(last7) < 1) continue;
    for (const D of [addDays(today, -2), addDays(today, -1)]) {
      if (!series.has(D)) continue;
      const base = [];
      for (let i = 1; i <= rule.baselineDays; i++) {
        const v = series.get(addDays(D, -i));
        if (v != null) base.push(v);
      }
      if (base.length < 3) continue;
      const baseline = median(base);
      const usd = series.get(D);
      const diff = usd - baseline;
      if (diff <= threshold(baseline)) continue;
      const causes = [];
      for (const [usageType, um] of byUsage.get(service)) {
        const own = [];
        for (let i = 1; i <= 7; i++) own.push(um.get(addDays(D, -i)) || 0);
        const u = um.get(D) || 0;
        const ownMedian = median(own);
        if (u - ownMedian > 0) causes.push({ usageType, usd: u, baselineUsd: ownMedian, delta: u - ownMedian });
      }
      causes.sort((a, b) => b.delta - a.delta);
      out.open.push({
        anomalyId: `icc:service:${service}:${D}`, scopeKey: service, startDay: D,
        actualUsd: usd, expectedUsd: baseline, impactUsd: diff,
        impactPct: baseline > 0 ? (diff / baseline) * 100 : null,
        rootCauses: causes.slice(0, 5).map(({ usageType, usd: u, baselineUsd }) => ({ usageType, usd: u, baselineUsd })),
      });
      break; // the earlier of the two days wins
    }
  }
  return out;
}

/**
 * Allocation summary for one dimension + key. rows = [{ day, value, service, usd }] (value '' =
 * unallocated), costRows = [{ day, usd }] day totals from aws_cost_daily for the same window.
 */
function allocationSummary({ rows, costRows }) {
  const totalUsd = (rows || []).reduce((n, r) => n + num(r.usd), 0);
  const unallocatedUsd = (rows || []).filter((r) => (r.value || '') === '').reduce((n, r) => n + num(r.usd), 0);
  const costTotal = (costRows || []).reduce((n, r) => n + num(r.usd), 0);
  const byValue = new Map();
  const byDay = new Map();
  for (const r of rows || []) {
    const value = r.value || '';
    const usd = num(r.usd);
    if (!byValue.has(value)) byValue.set(value, { value, usd: 0, services: new Map() });
    const v = byValue.get(value);
    v.usd += usd;
    v.services.set(r.service || '', (v.services.get(r.service || '') || 0) + usd);
    if (!byDay.has(r.day)) byDay.set(r.day, {});
    const d = byDay.get(r.day);
    d[value] = (d[value] || 0) + usd;
  }
  const values = [...byValue.values()].sort((a, b) => b.usd - a.usd).map((v) => ({
    value: v.value, usd: v.usd, pct: totalUsd > 0 ? (v.usd / totalUsd) * 100 : 0,
    services: [...v.services].map(([service, usd]) => ({ service, usd })).sort((a, b) => b.usd - a.usd),
  }));
  return {
    totalUsd, allocatedUsd: totalUsd - unallocatedUsd, unallocatedUsd,
    unallocatedPct: totalUsd > 0 ? (unallocatedUsd / totalUsd) * 100 : 0,
    coverageGapPct: costTotal > 0 ? ((costTotal - totalUsd) / costTotal) * 100 : 0,
    values,
    days: [...byDay].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, vals]) => ({ day, values: vals })),
  };
}

/** Model ids a Bedrock billing service line ('Claude Opus 4.6 (Amazon Bedrock Edition)') matches. */
function bedrockModelsForService(service, modelIds) {
  const name = String(service || '');
  const family = (name.match(/\b(opus|sonnet|haiku)\b/i) || [])[1];
  const ver = (name.replace(/\(.*\)/, '').match(/(\d+)(?:\.(\d+))?/) || []);
  if (!family || !ver[1]) return [];
  const fam = family.toLowerCase();
  const re = ver[2] != null
    ? new RegExp(`(^|[^0-9])${ver[1]}[-_.]?${ver[2]}([^0-9]|$)`)
    : new RegExp(`(^|[^0-9])${ver[1]}(?![-_.]\\d{1,2}(?!\\d))([^0-9]|$)`);
  return (modelIds || []).filter((id) => {
    const lower = String(id).toLowerCase();
    return lower.includes(fam) && re.test(lower);
  });
}
function bedrockModelForService(service, modelIds) {
  return bedrockModelsForService(service, modelIds)[0] || null;
}

// -- stored-row evaluators -----------------------------------------------------------------

const writeBudgetStatus = db.transaction((rows, iso) => {
  const stmt = db.prepare(`
    INSERT INTO aws_budget_status (budget_id, month, actual_usd, forecast_usd, forecast_source, pct_actual, pct_forecast, state, evaluated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(budget_id, month) DO UPDATE SET
      actual_usd = excluded.actual_usd, forecast_usd = excluded.forecast_usd, forecast_source = excluded.forecast_source,
      pct_actual = excluded.pct_actual, pct_forecast = excluded.pct_forecast, state = excluded.state, evaluated_at = excluded.evaluated_at
  `);
  for (const r of rows) {
    stmt.run(r.budgetId, r.month, r.actualUsd, r.forecastUsd, r.forecastSource, r.pctActual, r.pctForecast, r.state, iso);
  }
});

/** Daily totals for one budget scope, ascending, from `fromDay` through `toDay` inclusive. */
function scopeDailyTotals(budget, metric, fromDay, toDay) {
  const expr = costExpr(metric);
  if (budget.scope_type === 'tag') {
    return db.prepare(`
      SELECT day, SUM(${expr}) AS usd FROM aws_cost_alloc_daily
      WHERE dimension = 'tag' AND key = ? AND value = ? AND day >= ? AND day <= ?
      GROUP BY day ORDER BY day
    `).all(budget.scope_key || '', budget.scope_value ?? '', fromDay, toDay);
  }
  if (budget.scope_type === 'account') {
    return db.prepare(`
      SELECT day, SUM(${expr}) AS usd FROM aws_cost_daily WHERE account_id = ? AND day >= ? AND day <= ?
      GROUP BY day ORDER BY day
    `).all(Number(budget.scope_key) || 0, fromDay, toDay);
  }
  if (budget.scope_type === 'service') {
    return db.prepare(`
      SELECT day, SUM(${expr}) AS usd FROM aws_cost_daily WHERE service = ? AND day >= ? AND day <= ?
      GROUP BY day ORDER BY day
    `).all(budget.scope_value || '', fromDay, toDay);
  }
  return db.prepare(`
    SELECT day, SUM(${expr}) AS usd FROM aws_cost_daily WHERE day >= ? AND day <= ? GROUP BY day ORDER BY day
  `).all(fromDay, toDay);
}

/** Newest stored forecast for the current month and the chosen metric, or null. */
function storedForecast(metric, month) {
  return db.prepare(`
    SELECT * FROM aws_cost_forecast
    WHERE scope = 'total' AND LOWER(metric) LIKE ? AND substr(period_start, 1, 7) = ?
    ORDER BY generated_on DESC, id DESC LIMIT 1
  `).get(`${metric}%`, month) || null;
}

/** Evaluate every enabled budget for the current month and store its status row. */
function evaluateBudgets({ now = new Date() } = {}) {
  const metric = finopsSettings().finopsMetric;
  const today = utcDay(now);
  const month = monthOf(today);
  const start = monthStart(today);
  const budgets = db.prepare('SELECT * FROM aws_budgets WHERE enabled = 1 ORDER BY id').all();
  const results = [];
  for (const b of budgets) {
    const monthRows = scopeDailyTotals(b, metric, start, today);
    const actualUsd = monthRows.reduce((n, r) => n + num(r.usd), 0);
    const recent = scopeDailyTotals(b, metric, addDays(today, -10), today).map((r) => ({ day: r.day, usd: num(r.usd) }));
    let forecastUsd = null;
    let forecastSource = null;
    if (b.scope_type === 'total') {
      const f = storedForecast(metric, month);
      if (f && f.mean_usd != null) { forecastUsd = f.mean_usd; forecastSource = f.source; }
    }
    if (forecastUsd == null) {
      const lin = linearForecast({ mtdUsd: actualUsd, dailyTotals: recent, today });
      if (lin) { forecastUsd = lin.meanUsd; forecastSource = 'linear'; }
    }
    const pctActual = b.amount_usd > 0 ? (actualUsd / b.amount_usd) * 100 : 0;
    const pctForecast = forecastUsd != null && b.amount_usd > 0 ? (forecastUsd / b.amount_usd) * 100 : null;
    const state = budgetState({
      amountUsd: b.amount_usd, warnPct: b.warn_pct, critPct: b.crit_pct, forecastAlert: !!b.forecast_alert, actualUsd, forecastUsd,
    });
    results.push({ budgetId: b.id, month, state, actualUsd, forecastUsd, forecastSource, pctActual, pctForecast });
  }
  writeBudgetStatus(results, nowIso(now));
  return results.map((r) => ({ budgetId: r.budgetId, month: r.month, state: r.state, actualUsd: r.actualUsd, forecastUsd: r.forecastUsd }));
}

const writeIccAnomalies = db.transaction((accountId, plan, iso) => {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO aws_cost_anomalies (account_id, anomaly_id, source, monitor_arn, monitor_name, scope, scope_key,
      start_day, end_day, actual_usd, expected_usd, impact_usd, impact_pct, root_causes_json, status, normal_days,
      first_seen_at, last_seen_at)
    VALUES (?, ?, 'icc', NULL, NULL, 'service', ?, ?, NULL, ?, ?, ?, ?, ?, 'open', 0, ?, ?)
  `);
  let opened = 0;
  for (const r of plan.open) {
    opened += insert.run(accountId, r.anomalyId, r.scopeKey, r.startDay, r.actualUsd, r.expectedUsd, r.impactUsd,
      r.impactPct, JSON.stringify(r.rootCauses || []), iso, iso).changes;
  }
  const keepElevated = db.prepare(`
    UPDATE aws_cost_anomalies SET normal_days = 0, actual_usd = ?, impact_usd = ?, impact_pct = ?, last_seen_at = ?
    WHERE account_id = ? AND anomaly_id = ?
  `);
  const keepNormal = db.prepare('UPDATE aws_cost_anomalies SET normal_days = ? WHERE account_id = ? AND anomaly_id = ?');
  for (const k of plan.keepOpen) {
    if (k.elevated) keepElevated.run(k.actualUsd, k.impactUsd, k.impactPct, iso, accountId, k.anomalyId);
    else keepNormal.run(k.normalDays, accountId, k.anomalyId);
  }
  const close = db.prepare(`
    UPDATE aws_cost_anomalies SET status = 'closed', end_day = ?, normal_days = ?, last_seen_at = ?
    WHERE account_id = ? AND anomaly_id = ?
  `);
  for (const c of plan.close) close.run(c.endDay, c.normalDays ?? 0, iso, accountId, c.anomalyId);
});

const writeSupersede = db.transaction((rows) => {
  const stmt = db.prepare('UPDATE aws_cost_anomalies SET superseded_by = ? WHERE id = ?');
  for (const r of rows) stmt.run(r.by, r.id);
});

/** Run the ICC anomaly rule over the stored usage rows, write the result, mark rows AWS already covers. */
function detectIccAnomalies(accountId, { now = new Date() } = {}) {
  const settings = finopsSettings();
  const today = utcDay(now);
  const rule = {
    pct: settings.anomalyPct, floorUsd: settings.anomalyFloorUsd,
    baselineDays: settings.anomalyBaselineDays, clearDays: settings.anomalyClearDays,
  };
  const expr = costExpr(settings.finopsMetric);
  const rows = db.prepare(`
    SELECT day, service, usage_type AS usageType, ${expr} AS usd FROM aws_cost_usage_daily
    WHERE account_id = ? AND service IS NOT NULL AND day >= ? AND day < ?
  `).all(accountId, addDays(today, -(rule.baselineDays + 10)), today);
  const open = db.prepare(`
    SELECT anomaly_id AS anomalyId, scope_key AS scopeKey, start_day AS startDay, expected_usd AS expectedUsd, normal_days AS normalDays
    FROM aws_cost_anomalies WHERE account_id = ? AND source = 'icc' AND status = 'open'
  `).all(accountId);
  const plan = iccAnomalies({ rows, open, rule, today });
  writeIccAnomalies(accountId, plan, nowIso(now));

  // Supersede: an open icc row for a service an AWS anomaly also names, over overlapping days.
  const aws = db.prepare("SELECT anomaly_id, scope_key, start_day, end_day, root_causes_json FROM aws_cost_anomalies WHERE account_id = ? AND source = 'aws'").all(accountId);
  const icc = db.prepare(`
    SELECT id, scope_key, start_day, end_day FROM aws_cost_anomalies
    WHERE account_id = ? AND source = 'icc' AND status = 'open' AND superseded_by IS NULL
  `).all(accountId);
  const superseded = [];
  for (const i of icc) {
    const iEnd = i.end_day || today;
    const match = aws.find((a) => {
      const services = new Set([a.scope_key]);
      try { for (const rc of JSON.parse(a.root_causes_json || '[]')) if (rc.service) services.add(rc.service); } catch { /* ignore */ }
      if (!services.has(i.scope_key)) return false;
      const aEnd = a.end_day || today;
      return a.start_day <= iEnd && i.start_day <= aEnd;
    });
    if (match) superseded.push({ id: i.id, by: match.anomaly_id });
  }
  if (superseded.length) writeSupersede(superseded);
  return { opened: plan.open.length, closed: plan.close.length, superseded: superseded.length };
}

const writeRecommendationState = db.transaction((ops, iso) => {
  const insert = db.prepare(`
    INSERT INTO aws_recommendation_state (account_id, rec_key, status, est_monthly_savings_usd, first_seen_at, last_seen_at, updated_at)
    VALUES (?, ?, 'open', ?, ?, ?, ?)
    ON CONFLICT(account_id, rec_key) DO NOTHING
  `);
  const refresh = db.prepare(`
    UPDATE aws_recommendation_state SET est_monthly_savings_usd = ?, last_seen_at = ? WHERE account_id = ? AND rec_key = ?
  `);
  const reopen = db.prepare(`
    UPDATE aws_recommendation_state SET status = 'open', resolved_by = NULL, realized_usd = NULL, realized_at = NULL, updated_at = ?
    WHERE account_id = ? AND rec_key = ?
  `);
  const done = db.prepare(`
    UPDATE aws_recommendation_state SET status = 'done', resolved_by = 'auto', realized_usd = ?, realized_at = ?, updated_at = ?
    WHERE account_id = ? AND rec_key = ?
  `);
  for (const op of ops) {
    if (op.kind === 'insert') insert.run(op.accountId, op.key, op.est, iso, iso, iso);
    else if (op.kind === 'refresh') refresh.run(op.est, iso, op.accountId, op.key);
    else if (op.kind === 'reopen') reopen.run(iso, op.accountId, op.key);
    else if (op.kind === 'done') done.run(op.est, iso, iso, op.accountId, op.key);
  }
});

/**
 * Track the lifecycle of recommendations. freshRows = what the capture just found for `sources`
 * ([{ source, finding, resourceId, estMonthlySavingsUsd }]); a row still present is kept (status and
 * note untouched, estimate refreshed), a new one opens, one that vanished while open or accepted
 * with a positive estimate is marked done automatically with realized = its last estimate, and a
 * dismissed one is never touched. An auto-closed row that comes back is reopened (a user-closed one
 * stays as the user left it). Rows with no estimate and an "optimized" finding are not tracked.
 */
function reconcileRecommendationState(accountId, freshRows, { sources = [], now = new Date() } = {}) {
  const wanted = new Set(sources);
  const key = (r) => `${r.source}|${r.finding ?? ''}|${r.resourceId}`;
  const fresh = new Map();
  for (const r of freshRows || []) {
    if (!wanted.has(r.source)) continue;
    const est = r.estMonthlySavingsUsd == null ? null : num(r.estMonthlySavingsUsd);
    if ((!est || est <= 0) && /optimized/i.test(String(r.finding || ''))) continue;
    fresh.set(key(r), est);
  }
  const existing = new Map(db.prepare('SELECT * FROM aws_recommendation_state WHERE account_id = ?').all(accountId).map((r) => [r.rec_key, r]));
  const ops = [];
  let kept = 0; let created = 0; let autoDone = 0;
  for (const [k, est] of fresh) {
    const row = existing.get(k);
    if (!row) { ops.push({ kind: 'insert', accountId, key: k, est }); created++; continue; }
    ops.push({ kind: 'refresh', accountId, key: k, est });
    if (row.status === 'done' && row.resolved_by === 'auto') ops.push({ kind: 'reopen', accountId, key: k });
    kept++;
  }
  for (const [k, row] of existing) {
    if (fresh.has(k) || !wanted.has(k.split('|')[0])) continue;
    if (['open', 'accepted'].includes(row.status) && num(row.est_monthly_savings_usd) > 0) {
      ops.push({ kind: 'done', accountId, key: k, est: row.est_monthly_savings_usd });
      autoDone++;
    }
  }
  if (ops.length) writeRecommendationState(ops, nowIso(now));
  return { kept, created, autoDone };
}

// -- unit economics ------------------------------------------------------------------------

const TOKEN_KINDS = [
  ['cacheRead', /CacheReadInputTokenCount/i], ['cacheWrite', /CacheWriteInputTokenCount/i],
  ['input', /InputTokenCount/i], ['output', /OutputTokenCount/i],
];
const tokenKind = (usageType) => (TOKEN_KINDS.find(([, re]) => re.test(usageType)) || [])[0] || null;
/** Token quantity in millions: "1M tokens" amounts are already millions, a bare "Tokens" unit is divided. */
const toMTokens = (qty, unit) => (/^tokens?$/i.test(String(unit || '').trim()) ? num(qty) / 1e6 : num(qty));

/** Unit costs over [from, to] (YYYY-MM-DD, inclusive): Bedrock per million tokens, EC2, S3, Lightsail. */
function unitEconomics({ metric = 'amortized', from, to }) {
  const days = Math.max(1, dayDiff(from, to) + 1);
  const expr = costExpr(metric);

  const modelIds = db.prepare('SELECT DISTINCT model_id FROM aws_bedrock_usage').all().map((r) => r.model_id);
  const usageRows = db.prepare(`
    SELECT day, service, usage_type, ${expr} AS usd, usage_qty, usage_unit FROM aws_cost_usage_daily
    WHERE service LIKE '%Bedrock%' AND day >= ? AND day <= ?
  `).all(from, to);
  const byService = new Map();
  for (const r of usageRows) {
    if (!byService.has(r.service)) byService.set(r.service, []);
    byService.get(r.service).push(r);
  }
  const bedrock = [];
  for (const [service, rows] of byService) {
    let usd = 0;
    let mTokens = 0;
    const kinds = new Map();
    const series = new Map();
    for (const r of rows) {
      usd += num(r.usd);
      const isToken = /TokenCount-Units$/i.test(r.usage_type);
      const m = isToken ? toMTokens(r.usage_qty, r.usage_unit) : 0;
      mTokens += m;
      const s = series.get(r.day) || { day: r.day, usd: 0, mTokens: 0 };
      s.usd += num(r.usd); s.mTokens += m;
      series.set(r.day, s);
      const kind = isToken ? tokenKind(r.usage_type) : null;
      if (kind) {
        const k = kinds.get(kind) || { kind, usd: 0, mTokens: 0 };
        k.usd += num(r.usd); k.mTokens += m;
        kinds.set(kind, k);
      }
    }
    const ids = bedrockModelsForService(service, modelIds);
    let invocations = null;
    if (ids.length) {
      const inv = db.prepare(`
        SELECT SUM(invocations) AS n FROM aws_bedrock_usage WHERE model_id IN (${ids.map(() => '?').join(',')}) AND day >= ? AND day <= ?
      `).get(...ids, from, to);
      invocations = inv?.n ?? null;
    }
    const per = (u, t) => (t > 0 ? u / t : null);
    bedrock.push({
      service, model: service.replace(/\s*\(.*\)\s*$/, ''), modelId: ids[0] || null, invocations,
      usd, mTokens, usdPerMTok: per(usd, mTokens),
      kinds: ['input', 'output', 'cacheRead', 'cacheWrite'].filter((n) => kinds.has(n)).map((n) => {
        const k = kinds.get(n);
        return { kind: n, usd: k.usd, mTokens: k.mTokens, usdPerMTok: per(k.usd, k.mTokens) };
      }),
      series: [...series.values()].sort((a, b) => (a.day < b.day ? -1 : 1))
        .map((s) => ({ day: s.day, usd: s.usd, mTokens: s.mTokens, usdPerMTok: per(s.usd, s.mTokens) })),
    });
  }
  bedrock.sort((a, b) => b.usd - a.usd);

  const running = new Map(db.prepare(`
    SELECT instance_type, COUNT(*) AS n FROM aws_ec2_instances WHERE state = 'running' GROUP BY instance_type
  `).all().map((r) => [r.instance_type, r.n]));
  const ec2 = db.prepare(`
    SELECT instance_type, SUM(COALESCE(amortized_usd, amount_usd)) AS usd FROM aws_cost_instance_type_daily
    WHERE day >= ? AND day <= ? GROUP BY instance_type ORDER BY usd DESC
  `).all(from, to).map((r) => {
    const runningCount = running.get(r.instance_type) || 0;
    return {
      instanceType: r.instance_type, usd: num(r.usd), runningCount,
      usdPerInstanceMonth: runningCount > 0 ? (num(r.usd) / runningCount / days) * MONTH_DAYS : null,
    };
  });

  const serviceSeries = (service) => db.prepare(`
    SELECT day, SUM(${expr}) AS usd FROM aws_cost_daily WHERE service = ? AND day >= ? AND day <= ? GROUP BY day ORDER BY day
  `).all(service, from, to).map((r) => ({ day: r.day, usd: num(r.usd) }));
  const sum = (series) => series.reduce((n, r) => n + r.usd, 0);

  const s3Series = serviceSeries('Amazon Simple Storage Service');
  const s3Usd = sum(s3Series);
  const s3Tb = num(db.prepare('SELECT SUM(size_bytes) AS b FROM aws_s3_buckets').get()?.b) / 1e12;
  const lsSeries = serviceSeries('Amazon Lightsail');
  const lsUsd = sum(lsSeries);
  const lsCount = db.prepare('SELECT COUNT(*) AS n FROM aws_lightsail_instances').get().n;

  return {
    bedrock, ec2,
    s3: { usd: s3Usd, tb: s3Tb, usdPerTbMonth: s3Tb > 0 ? (s3Usd / s3Tb / days) * MONTH_DAYS : null, series: s3Series },
    lightsail: { usd: lsUsd, count: lsCount, usdPerInstanceMonth: lsCount > 0 ? (lsUsd / lsCount / days) * MONTH_DAYS : null, series: lsSeries },
  };
}

// -- capability read helpers ---------------------------------------------------------------

/** One row per capability (unknown when never checked) plus the synthetic cost_resources row. */
function capabilityRows(accountId) {
  const stored = accountId
    ? db.prepare('SELECT * FROM aws_capability_status WHERE account_id = ?').all(accountId)
    : db.prepare('SELECT * FROM aws_capability_status ORDER BY last_checked_at ASC').all();
  const byId = new Map();
  for (const r of stored) byId.set(r.capability, r);   // later (newer) rows win for the all-accounts read
  const actionsFor = (id, status, error) => {
    if (status === 'denied') {
      const parsed = deniedActions(error);
      if (parsed.length) return parsed;
    }
    return CAPABILITY_ACTIONS[id] || [];
  };
  const rows = CAPABILITIES.map((id) => {
    const r = byId.get(id);
    return {
      capability: id, status: r?.status || 'unknown', error: r?.error || null,
      iamActions: actionsFor(id, r?.status, r?.error), requests: r?.requests || 0,
      lastOkAt: r?.last_ok_at || null, lastCheckedAt: r?.last_checked_at || null,
    };
  });
  const acct = accountId
    ? db.prepare('SELECT * FROM aws_accounts WHERE id = ?').get(accountId)
    : db.prepare('SELECT * FROM aws_accounts ORDER BY id LIMIT 1').get();
  const cr = acct?.cost_resources_status || 'unknown';
  rows.push({
    capability: 'cost_resources', status: cr, error: acct?.cost_resources_error || null,
    iamActions: actionsFor('cost_resources', cr, acct?.cost_resources_error), requests: 0,
    lastOkAt: null, lastCheckedAt: acct?.last_cost_capture_at || null,
  });
  return rows;
}

/** Sorted unique IAM actions of every denied capability. */
function missingActions(accountId) {
  const out = new Set();
  for (const r of capabilityRows(accountId)) if (r.status === 'denied') for (const a of r.iamActions) out.add(a);
  return [...out].sort();
}

// -- overview ------------------------------------------------------------------------------

/** The GET /finops/overview body minus `capabilities` (the route adds those and the capture stamps). */
function buildFinopsOverview({ metric, accountId, now = new Date() } = {}) {
  const settings = finopsSettings();
  const m = metric === 'unblended' || metric === 'amortized' ? metric : settings.finopsMetric;
  const expr = costExpr(m);
  const acct = accountId ? ' AND account_id = ?' : '';
  const accParams = accountId ? [Number(accountId)] : [];
  const today = utcDay(now);
  const month = monthOf(today);
  const start = monthStart(today);
  const lastStart = addMonths(today, -1);

  const sumRange = (from, to) => num(db.prepare(`SELECT SUM(${expr}) AS s FROM aws_cost_daily WHERE day >= ? AND day <= ?${acct}`).get(from, to, ...accParams).s);
  const mtdUsd = sumRange(start, today);
  const lastMonthUsd = sumRange(lastStart, addDays(start, -1));
  const latest = db.prepare(`SELECT MAX(day) AS d FROM aws_cost_daily WHERE day >= ? AND day <= ?${acct}`).get(start, today, ...accParams).d;
  const dayCount = latest ? Number(latest.slice(8, 10)) : 0;
  const lastSame = dayCount ? sumRange(lastStart, addDays(lastStart, dayCount - 1)) : 0;
  const momPct = dayCount && lastSame > 0 ? ((sumRange(start, latest) - lastSame) / lastSame) * 100 : null;

  const dailyRows = db.prepare(`
    SELECT day, SUM(${expr}) AS usd FROM aws_cost_daily WHERE day >= ? AND day <= ?${acct} GROUP BY day ORDER BY day
  `).all(addDays(today, -10), today, ...accParams).map((r) => ({ day: r.day, usd: num(r.usd) }));
  const rr = dailyRows.filter((r) => r.day >= addDays(today, -8) && r.day <= addDays(today, -2)).slice(-7);
  const runRate = rr.length >= 3 ? rr.reduce((n, r) => n + r.usd, 0) / rr.length : null;

  let forecast = null;
  const stored = storedForecast(m, month);
  if (stored && stored.mean_usd != null) {
    forecast = { meanUsd: stored.mean_usd, lowerUsd: stored.lower_usd, upperUsd: stored.upper_usd, source: stored.source, generatedOn: stored.generated_on };
  } else {
    const lin = linearForecast({ mtdUsd, dailyTotals: dailyRows, today });
    if (lin) forecast = { ...lin, generatedOn: today };
  }

  const latestOf = (table, col) => db.prepare(`SELECT ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL${acct} ORDER BY day DESC LIMIT 1`).get(...accParams)?.v ?? null;
  const optimizerJoin = `
    FROM aws_optimizer_recommendations o
    LEFT JOIN aws_recommendation_state s ON s.account_id = o.account_id
      AND s.rec_key = o.source || '|' || COALESCE(o.finding, '') || '|' || o.resource_id
  `;
  const potential = num(db.prepare(`
    SELECT SUM(o.est_monthly_savings_usd) AS s ${optimizerJoin}
    WHERE COALESCE(s.status, 'open') IN ('open', 'accepted')${accountId ? ' AND o.account_id = ?' : ''}
  `).get(...accParams).s);
  const realized = num(db.prepare(`
    SELECT SUM(realized_usd) AS s FROM aws_recommendation_state WHERE status = 'done' AND realized_at >= ?${acct}
  `).get(new Date(new Date(now).getTime() - 90 * DAY_MS).toISOString(), ...accParams).s);
  const openAnomalies = db.prepare(`
    SELECT COUNT(*) AS n FROM aws_cost_anomalies WHERE status = 'open' AND superseded_by IS NULL${acct}
  `).get(...accParams).n;

  const tagKey = settings.finopsTagKeys[0] || null;
  let unallocatedPct = null;
  if (tagKey) {
    const a = db.prepare(`
      SELECT SUM(${expr}) AS total, SUM(CASE WHEN value = '' THEN ${expr} ELSE 0 END) AS un FROM aws_cost_alloc_daily
      WHERE dimension = 'tag' AND key = ? AND day >= ? AND day <= ?${acct}
    `).get(tagKey, start, today, ...accParams);
    if (a && num(a.total) > 0) unallocatedPct = (num(a.un) / num(a.total)) * 100;
  }

  const serviceTotals = (from, to) => new Map(db.prepare(`
    SELECT service, SUM(${expr}) AS usd FROM aws_cost_daily WHERE day >= ? AND day <= ?${acct} GROUP BY service
  `).all(from, to, ...accParams).map((r) => [r.service, num(r.usd)]));
  const thisByService = serviceTotals(start, today);
  const lastByService = dayCount ? serviceTotals(lastStart, addDays(lastStart, dayCount - 1)) : new Map();
  const sorted = [...thisByService].filter(([, usd]) => usd > 0).sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 8);
  const otherUsd = sorted.slice(8).reduce((n, [, usd]) => n + usd, 0);
  const mix = top.map(([service, usd]) => ({ service, usd: round2(usd), pct: mtdUsd > 0 ? round2((usd / mtdUsd) * 100) : 0 }));
  if (otherUsd > 0) mix.push({ service: 'Other', usd: round2(otherUsd), pct: mtdUsd > 0 ? round2((otherUsd / mtdUsd) * 100) : 0 });

  const movers = [];
  for (const service of new Set([...thisByService.keys(), ...lastByService.keys()])) {
    const t = thisByService.get(service) || 0;
    const l = lastByService.get(service) || 0;
    movers.push({ service, thisMonthUsd: round2(t), lastMonthUsd: round2(l), deltaUsd: round2(t - l), deltaPct: l > 0 ? round2(((t - l) / l) * 100) : null });
  }
  movers.sort((a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd));

  const firstMonth = addMonths(today, -12);
  const monthly = new Map(db.prepare(`
    SELECT substr(day, 1, 7) AS month, SUM(${expr}) AS usd FROM aws_cost_daily WHERE day >= ?${acct} GROUP BY month
  `).all(firstMonth, ...accParams).map((r) => [r.month, num(r.usd)]));
  const trend = [];
  for (let i = 0; i < 13; i++) {
    const mo = monthOf(addMonths(firstMonth, i));
    const cur = mo === month;
    trend.push({
      month: mo, usd: round2(monthly.get(mo) || 0),
      forecastUsd: cur && forecast ? round2(forecast.meanUsd) : null,
      forecastLowUsd: cur && forecast ? round2(forecast.lowerUsd) : null,
      forecastHighUsd: cur && forecast ? round2(forecast.upperUsd) : null,
    });
  }

  const budgets = db.prepare(`
    SELECT b.*, s.actual_usd, s.forecast_usd, s.pct_actual, s.state
    FROM aws_budgets b LEFT JOIN aws_budget_status s ON s.budget_id = b.id AND s.month = ?
    WHERE b.enabled = 1 ORDER BY b.name
  `).all(month).map((b) => ({
    id: b.id, name: b.name, scopeType: b.scope_type, scopeKey: b.scope_key, scopeValue: b.scope_value,
    amountUsd: round2(b.amount_usd), actualUsd: round2(b.actual_usd), forecastUsd: round2(b.forecast_usd),
    pctActual: round2(b.pct_actual), state: b.state || null,
  }));
  const anomalies = db.prepare(`
    SELECT * FROM aws_cost_anomalies WHERE status = 'open' AND superseded_by IS NULL${acct}
    ORDER BY impact_usd DESC LIMIT 5
  `).all(...accParams).map((a) => ({
    id: a.id, source: a.source, scopeKey: a.scope_key, startDay: a.start_day, endDay: a.end_day,
    impactUsd: round2(a.impact_usd), impactPct: round2(a.impact_pct), status: a.status,
  }));

  const amortizedFrom = db.prepare(`SELECT MIN(day) AS d FROM aws_cost_daily WHERE amortized_usd IS NOT NULL${acct}`).get(...accParams).d || null;

  return {
    metric: m, amortizedFrom, month,
    kpis: {
      mtdUsd: round2(mtdUsd),
      forecastUsd: forecast ? round2(forecast.meanUsd) : null,
      forecastLowUsd: forecast ? round2(forecast.lowerUsd) : null,
      forecastHighUsd: forecast ? round2(forecast.upperUsd) : null,
      forecastSource: forecast ? forecast.source : null,
      forecastGeneratedOn: forecast ? forecast.generatedOn : null,
      lastMonthUsd: round2(lastMonthUsd), momPct: round2(momPct), runRatePerDayUsd: round2(runRate),
      commitmentCoveragePct: round2(latestOf('aws_sp_coverage_daily', 'coverage_pct')),
      commitmentUtilizationPct: round2(latestOf('aws_sp_utilization_daily', 'utilization_pct')),
      openAnomalies, potentialSavingsUsd: round2(potential), realizedSavings90dUsd: round2(realized),
      unallocatedPct: round2(unallocatedPct), unallocatedTagKey: tagKey,
    },
    mix, trend, topMovers: movers.slice(0, 8), budgets, anomalies,
  };
}

// -- collector -----------------------------------------------------------------------------

/**
 * ONE-TIME 13 month history by SERVICE (both metrics) into aws_cost_daily, so the trend chart and
 * month over month have a year behind them. Stamps aws_accounts.finops_backfill_at.
 */
async function backfillCostHistory(account, { now = new Date() } = {}) {
  const today = utcDay(now);
  const { rows, requests } = await awsApi.fetchCostAndUsageGrouped(account, {
    start: addMonths(today, -12), end: today, groupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
  });
  poller().upsertCost(account.id, rows.map((r) => ({ day: r.day, service: r.keys[0] || 'Unknown', amountUsd: r.amountUsd, amortizedUsd: r.amortizedUsd })));
  db.prepare("UPDATE aws_accounts SET finops_backfill_at = datetime('now') WHERE id = ?").run(account.id);
  return { rows: rows.length, pages: requests };
}

/** Store the Cost Explorer forecast (remaining days) added to month to date, so the row is the month total. */
const writeForecast = db.transaction((accountId, f) => {
  db.prepare(`
    INSERT INTO aws_cost_forecast (account_id, scope, metric, period_start, period_end, generated_on, mean_usd, lower_usd, upper_usd, source)
    VALUES (?, 'total', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, scope, metric, period_start, generated_on) DO UPDATE SET
      period_end = excluded.period_end, mean_usd = excluded.mean_usd, lower_usd = excluded.lower_usd,
      upper_usd = excluded.upper_usd, source = excluded.source
  `).run(accountId, f.metric, f.periodStart, f.periodEnd, f.generatedOn, f.meanUsd, f.lowerUsd, f.upperUsd, f.source);
});

function runPrunes(now) {
  const cutoffDay = (days) => addDays(utcDay(now), -days);
  const cutoffIso = (days) => new Date(new Date(now).getTime() - days * DAY_MS).toISOString();
  for (const table of ['aws_cost_alloc_daily', 'aws_sp_utilization_daily', 'aws_sp_coverage_daily', 'aws_ri_utilization_daily', 'aws_ri_coverage_daily']) {
    pruneInBatches(db, table, 'day < ?', [cutoffDay(400)]);
  }
  pruneInBatches(db, 'aws_cost_forecast', 'generated_on < ?', [cutoffDay(400)]);
  pruneInBatches(db, 'aws_cost_anomalies', "status = 'closed' AND last_seen_at < ?", [cutoffIso(180)]);
  pruneInBatches(db, 'aws_budget_status', 'month < ?', [monthOf(addMonths(utcDay(now), -24))]);
  pruneInBatches(db, 'aws_recommendation_state', "status IN ('dismissed', 'done') AND updated_at < ?", [cutoffIso(365)]);
}

/** The Savings Plan arn tail ("abc-123" from "arn:aws:savingsplans::1234:savingsplan/abc-123"). */
const arnTail = (arn) => String(arn || '').split('/').pop();

function recordLedger(account, settings) {
  const items = [
    { item: 'metric', value: settings.finopsMetric },
    { item: 'tag_keys', value: JSON.stringify([...settings.finopsTagKeys].sort()) },
    { item: 'anomaly_rule', value: JSON.stringify({
      pct: settings.anomalyPct, floorUsd: settings.anomalyFloorUsd,
      baselineDays: settings.anomalyBaselineDays, clearDays: settings.anomalyClearDays,
    }) },
  ];
  for (const sp of db.prepare('SELECT * FROM aws_savings_plans WHERE account_id = ? ORDER BY sp_arn').all(account.id)) {
    items.push({
      item: `savings_plan:${arnTail(sp.sp_arn)}`,
      value: JSON.stringify({ term: sp.term, paymentOption: sp.payment_option, hourlyCommitmentUsd: sp.hourly_commitment_usd, endAt: sp.end_at }),
    });
  }
  require('./configLedger').recordSnapshot({ platform: 'aws', scope: 'finops', system: account.name, items });
}

/** ISO week key 'YYYY-Www' (UTC) and ISO weekday 1..7 for a date. */
function isoWeekInfo(now) {
  const d = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()));
  const weekday = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d - yearStart) / DAY_MS + 1) / 7);
  return { key: `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`, weekday };
}

const usdText = (n) => (n == null ? 'n/a' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Weekly FinOps digest through the alert SMTP transport (same settings and transport factory the
 * alert notifier uses). Throws err.code SMTP_NOT_CONFIGURED or NO_RECIPIENTS. Recipients =
 * aws_finops_digest_recipients, else the default alert recipients. Returns { ok: true, recipients }.
 */
async function sendFinopsDigest({ force = false, now = new Date() } = {}) {
  const { getNotificationSettings } = require('./settings');
  const config = getNotificationSettings();
  if (!config.smtpHost || !config.smtpFrom || (!force && !config.smtpEnabled)) {
    const err = new Error('SMTP is not fully configured (host and from address are required, see Global Settings, Notifications).');
    err.code = 'SMTP_NOT_CONFIGURED';
    throw err;
  }
  const settings = finopsSettings();
  const recipients = (settings.finopsDigestRecipients || config.smtpRecipients || '').split(/[,;\s]+/).filter(Boolean);
  if (!recipients.length) {
    const err = new Error('No digest recipients are set and no default alert recipients are configured.');
    err.code = 'NO_RECIPIENTS';
    throw err;
  }
  const o = buildFinopsOverview({ metric: settings.finopsMetric, now });
  const k = o.kpis;
  const budgetLines = o.budgets.map((b) => `${b.name}: ${usdText(b.actualUsd)} of ${usdText(b.amountUsd)} (${b.pctActual ?? 0}%), ${b.state || 'not evaluated'}`);
  const anomalyLines = o.anomalies.map((a) => `${a.scopeKey}: ${usdText(a.impactUsd)} over expected since ${a.startDay} (${a.source})`);
  const moverLines = o.topMovers.slice(0, 5).map((m) => `${m.service}: ${usdText(m.thisMonthUsd)} vs ${usdText(m.lastMonthUsd)} (${m.deltaUsd >= 0 ? '+' : '-'}${usdText(Math.abs(m.deltaUsd))})`);
  const head = [
    ['Month to date', usdText(k.mtdUsd)],
    ['Forecast', k.forecastUsd == null ? 'n/a' : `${usdText(k.forecastUsd)} (${k.forecastSource})`],
    ['Last month', usdText(k.lastMonthUsd)],
    ['Open anomalies', String(k.openAnomalies)],
    ['Potential savings per month', usdText(k.potentialSavingsUsd)],
    ['Realized savings, 90 days', usdText(k.realizedSavings90dUsd)],
  ];
  const text = [
    `AWS FinOps weekly digest (${o.metric} cost, month ${o.month})`,
    '',
    ...head.map(([a, b]) => `${a}: ${b}`),
    '', 'Budgets', ...(budgetLines.length ? budgetLines : ['None defined.']),
    '', 'Open anomalies', ...(anomalyLines.length ? anomalyLines : ['None.']),
    '', 'Largest movers against the same days last month', ...(moverLines.length ? moverLines : ['None.']),
    '--', 'Sent by ICC FinOps',
  ].join('\n');
  const list = (title, lines) => `<h3>${esc(title)}</h3><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px"><h2>AWS FinOps weekly digest</h2>
<p>${esc(o.metric)} cost, month ${esc(o.month)}</p>
<table cellpadding="4">${head.map(([a, b]) => `<tr><td>${esc(a)}</td><td><b>${esc(b)}</b></td></tr>`).join('')}</table>
${list('Budgets', budgetLines.length ? budgetLines : ['None defined.'])}
${list('Open anomalies', anomalyLines.length ? anomalyLines : ['None.'])}
${list('Largest movers against the same days last month', moverLines.length ? moverLines : ['None.'])}
<p style="color:#666">Sent by ICC FinOps</p></div>`;
  const transport = require('./alertNotifier').createTransport(config);
  await transport.sendMail({
    from: config.smtpFrom, to: recipients.join(', '),
    subject: `INFO | AWS | FinOps weekly digest | MTD ${usdText(k.mtdUsd)}${k.forecastUsd == null ? '' : `, forecast ${usdText(k.forecastUsd)}`}`,
    text, html,
  });
  return { ok: true, recipients };
}

/**
 * The daily FinOps block on the ELECTED account row. Each capability degrades on its own (denied,
 * not_enabled, error are recorded and the capture carries on); only credential errors rethrow, and
 * then last_finops_capture_at is NOT stamped so the next poll retries. Returns the request count and
 * each capability's status.
 */
async function captureFinops(account, { skipped = [], now = new Date() } = {}) {
  const settings = finopsSettings();
  const today = utcDay(now);
  const winStart = addDays(today, -35);
  const metricApi = settings.finopsMetric === 'unblended' ? 'UNBLENDED_COST' : 'AMORTIZED_COST';
  const statuses = {};
  let requests = 0;
  const run = async (id, fn) => {
    const r = await capability(account, id, fn);
    statuses[id] = r.status;
    requests += r.requests;
    return r;
  };
  const note = (id, status, error) => {
    setCapabilityStatus(account.id, id, { status, error, requests: 0 }, now);
    statuses[id] = status;
  };
  const up = poller();

  // 1. One-time 13 month history. A failure here never blocks the daily capabilities.
  const freshAccount = db.prepare('SELECT finops_backfill_at FROM aws_accounts WHERE id = ?').get(account.id);
  if (!freshAccount?.finops_backfill_at) {
    try {
      const b = await backfillCostHistory(account, { now });
      requests += b.pages;
    } catch (err) {
      if (up._isCredentialError(err)) throw err;
      logger.warn(`[AwsFinops] ${account.name}: cost history backfill failed: ${String(err?.message || err).slice(0, 200)}`);
    }
  }

  // 2. Active cost allocation tags (feeds the Settings suggestions).
  let activeTags = null;
  await run('tag_keys', async () => {
    const { rows, requests: n } = await awsApi.fetchCostAllocationTags(account);
    activeTags = rows.filter((r) => String(r.status).toLowerCase() === 'active').map((r) => r.tagKey);
    setSetting('aws_finops_tag_keys_seen', JSON.stringify([...new Set(activeTags)].sort()));
    return { requests: n };
  });

  // 3. Spend per configured tag key.
  if (!settings.finopsTagKeys.length) {
    note('cost_tags', 'unknown', 'No tag keys are configured (Settings, FinOps, Allocation).');
  } else {
    const queryable = settings.finopsTagKeys.filter((k) => !activeTags || activeTags.includes(k));
    const inactive = settings.finopsTagKeys.filter((k) => !queryable.includes(k));
    if (!queryable.length) {
      note('cost_tags', 'not_enabled', `Tag key(s) ${inactive.join(', ')} are not active cost allocation tags. Activate them in the Billing console.`);
    } else {
      const r = await run('cost_tags', async () => {
        let n = 0;
        for (const key of queryable) {
          const { rows, requests: pages } = await awsApi.fetchCostAndUsageGrouped(account, {
            start: winStart, end: today, groupBy: [{ Type: 'TAG', Key: key }, { Type: 'DIMENSION', Key: 'SERVICE' }],
          });
          n += pages;
          up.upsertCostAlloc(account.id, 'tag', key, rows.map((x) => {
            const raw = x.keys[0] || '';
            const at = raw.indexOf('$');
            return { day: x.day, value: at >= 0 ? raw.slice(at + 1) : raw, service: x.keys[1] || '', amountUsd: x.amountUsd, amortizedUsd: x.amortizedUsd };
          }));
        }
        return { requests: n, note: inactive.length ? `Skipped inactive tag key(s): ${inactive.join(', ')}.` : null };
      });
      void r;
    }
  }

  // 4. Linked accounts: auto = one probe, grouping only when the payer has members.
  if (settings.finopsLinkedAccounts === 'off') {
    note('linked_accounts', 'unknown', 'Linked account allocation is switched off.');
  } else {
    await run('linked_accounts', async () => {
      let n = 0;
      let count = 0;
      if (settings.finopsLinkedAccounts === 'auto') {
        const res = await awsApi.fetchLinkedAccountValues(account);
        n += res.requests;
        count = res.rows.length;
        if (count <= 1) return { requests: n, note: 'Standalone account: no linked accounts to allocate.' };
      }
      const { rows, requests: pages } = await awsApi.fetchCostAndUsageGrouped(account, {
        start: winStart, end: today, groupBy: [{ Type: 'DIMENSION', Key: 'LINKED_ACCOUNT' }, { Type: 'DIMENSION', Key: 'SERVICE' }],
      });
      up.upsertCostAlloc(account.id, 'linked_account', 'LINKED_ACCOUNT', rows.map((x) => ({
        day: x.day, value: x.keys[0] || '', service: x.keys[1] || '', amountUsd: x.amountUsd, amortizedUsd: x.amortizedUsd,
      })));
      return { requests: n + pages };
    });
  }

  // 5. Forecast: the CE value (remaining days) plus month to date; linear fallback when CE gave none.
  const mtd = num(db.prepare(`SELECT SUM(${costExpr(settings.finopsMetric)}) AS s FROM aws_cost_daily WHERE account_id = ? AND day >= ? AND day <= ?`)
    .get(account.id, monthStart(today), today).s);
  let ceForecast = false;
  const fStart = addDays(today, 1);
  const fEnd = nextMonthStart(today);
  if (fStart < fEnd) {
    await run('forecast', async () => {
      const { rows, requests: n } = await awsApi.fetchCostForecast(account, { metric: metricApi, start: fStart, end: fEnd });
      // Daily buckets for the remaining days; summing the bounds gives a conservative band.
      const f = rows.filter((r) => r.meanUsd != null).reduce((acc, r) => ({
        meanUsd: acc.meanUsd + r.meanUsd,
        lowerUsd: acc.lowerUsd + num(r.lowerUsd, r.meanUsd),
        upperUsd: acc.upperUsd + num(r.upperUsd, r.meanUsd),
        days: acc.days + 1,
      }), { meanUsd: 0, lowerUsd: 0, upperUsd: 0, days: 0 });
      if (f.days > 0) {
        writeForecast(account.id, {
          metric: settings.finopsMetric, periodStart: monthStart(today), periodEnd: fEnd, generatedOn: today,
          meanUsd: mtd + f.meanUsd, lowerUsd: mtd + f.lowerUsd, upperUsd: mtd + f.upperUsd, source: 'ce',
        });
        ceForecast = true;
      }
      return { requests: n };
    });
  } else {
    note('forecast', 'unknown', 'Last day of the month: no forecast requested.');
  }
  if (!ceForecast) {
    const totals = db.prepare(`
      SELECT day, SUM(${costExpr(settings.finopsMetric)}) AS usd FROM aws_cost_daily WHERE account_id = ? AND day >= ? AND day <= ?
      GROUP BY day ORDER BY day
    `).all(account.id, addDays(today, -10), today);
    const lin = linearForecast({ mtdUsd: mtd, dailyTotals: totals.map((r) => ({ day: r.day, usd: num(r.usd) })), today });
    if (lin) {
      writeForecast(account.id, {
        metric: settings.finopsMetric, periodStart: monthStart(today), periodEnd: fEnd, generatedOn: today,
        meanUsd: lin.meanUsd, lowerUsd: lin.lowerUsd, upperUsd: lin.upperUsd, source: 'linear',
      });
    }
  }

  // 6. Savings Plans and reservations.
  await run('sp_utilization', async () => parts([
    async () => {
      const { rows, requests: n } = await awsApi.fetchSavingsPlansUtilization(account, { start: winStart, end: today });
      up.upsertSpUtilization(account.id, rows);
      return n;
    },
    async () => {
      const { rows, requests: n } = await awsApi.fetchSavingsPlansUtilizationDetails(account, { start: addDays(today, -30), end: today });
      up.upsertSavingsPlans(account.id, rows);
      return n;
    },
  ]).then((n) => ({ requests: n })));
  await run('sp_coverage', async () => {
    const { rows, requests: n } = await awsApi.fetchSavingsPlansCoverage(account, { start: winStart, end: today });
    up.upsertSpCoverage(account.id, rows);
    return { requests: n };
  });
  await run('ri_utilization', async () => {
    const { rows, requests: n } = await awsApi.fetchReservationUtilization(account, { start: winStart, end: today });
    up.upsertRiUtilization(account.id, rows);
    return { requests: n };
  });
  await run('ri_coverage', async () => {
    const { rows, requests: n } = await awsApi.fetchReservationCoverage(account, { start: winStart, end: today });
    up.upsertRiCoverage(account.id, rows);
    return { requests: n };
  });

  // 7. AWS Cost Anomaly Detection (monitors kept in a setting, rows in aws_cost_anomalies).
  await run('anomalies', async () => {
    let monitors = parseJsonArray(getSetting('aws_finops_anomaly_monitors'));
    return parts([
      async () => {
        const res = await awsApi.fetchAnomalyMonitors(account);
        monitors = res.rows;
        setSetting('aws_finops_anomaly_monitors', JSON.stringify(res.rows));
        return res.requests;
      },
      async () => {
        const res = await awsApi.fetchAnomalies(account, { start: winStart, end: today });
        up.upsertAnomalies(account.id, res.rows, monitors);
        return res.requests;
      },
    ]).then((n) => ({ requests: n }));
  });

  // 8. Cost Explorer recommendations share the optimizer table; only sources whose call worked are replaced.
  const ceRows = [];
  const ceSources = [];
  const rs = await run('rightsizing', async () => {
    const { rows, requests: n } = await awsApi.fetchRightsizingRecommendations(account);
    for (const r of rows) {
      ceRows.push({
        source: 'ce-rightsizing', resourceType: 'ec2', resourceId: r.resourceId, resourceName: r.resourceName, region: r.region,
        finding: r.action, currentConfig: r.currentType, recommendedConfig: r.recommendedType,
        reason: `Cost Explorer rightsizing: max CPU ${r.cpuMaxPct ?? 'n/a'}%`, estMonthlySavingsUsd: r.estMonthlySavingsUsd,
      });
    }
    return { requests: n };
  });
  if (rs.status === 'ok') ceSources.push('ce-rightsizing');
  const sp = await run('sp_recommendation', async () => {
    const { rows, requests: n } = await awsApi.fetchSavingsPlansPurchaseRecommendation(account);
    for (const r of rows) {
      ceRows.push({
        source: 'ce-savings-plan', resourceType: 'savings-plan', resourceId: `${r.spType}|${r.term}|${r.paymentOption}`,
        resourceName: null, region: null, finding: 'purchase-savings-plan',
        currentConfig: `on-demand $${r.estOnDemandCostUsd ?? 'n/a'}/mo`, recommendedConfig: `$${r.hourlyCommitmentUsd ?? 'n/a'}/h commitment`,
        reason: `Cost Explorer ${r.spType} recommendation, ${r.lookbackDays} day lookback`, estMonthlySavingsUsd: r.estMonthlySavingsUsd,
      });
    }
    return { requests: n };
  });
  if (sp.status === 'ok') ceSources.push('ce-savings-plan');
  if (ceSources.length) {
    try { up.storeCeRecommendations(account.id, ceRows.filter((r) => ceSources.includes(r.source)), { sources: ceSources }); }
    catch (err) { logger.warn(`[AwsFinops] ${account.name}: storing Cost Explorer recommendations failed: ${err.message}`); }
  }

  // 9. Evaluate everything that reads stored rows, then retention, the ledger and the digest.
  const guarded = (label, fn) => { try { return fn(); } catch (err) { logger.warn(`[AwsFinops] ${account.name}: ${label} failed: ${err.message}`); return null; } };
  guarded('ICC anomaly rule', () => detectIccAnomalies(account.id, { now }));
  guarded('budget evaluation', () => evaluateBudgets({ now }));
  guarded('retention', () => runPrunes(now));
  guarded('config ledger snapshot', () => recordLedger(account, settings));

  db.prepare("UPDATE aws_accounts SET last_finops_capture_at = datetime('now') WHERE id = ?").run(account.id);

  if (settings.finopsDigestEnabled) {
    const { key, weekday } = isoWeekInfo(now);
    if (weekday === settings.finopsDigestWeekday && getSetting('aws_finops_digest_sent_week') !== key) {
      try {
        await sendFinopsDigest({ now });
        setSetting('aws_finops_digest_sent_week', key);
      } catch (err) {
        logger.warn(`[AwsFinops] weekly digest not sent: ${err.message}`);
      }
    }
  }
  void skipped;
  return { requests, capabilities: statuses };
}

module.exports = {
  CAPABILITIES,
  CAPABILITY_ACTIONS,
  // Collector entry points (async, called by awsPoller on the elected row).
  captureFinops,
  backfillCostHistory,
  sendFinopsDigest,
  // Stored-row evaluators (sync, called by the capture and by routes).
  evaluateBudgets,
  detectIccAnomalies,
  reconcileRecommendationState,
  // Pure helpers.
  linearForecast,
  iccAnomalies,
  budgetState,
  allocationSummary,
  unitEconomics,
  bedrockModelForService,
  // Read helpers for routes.
  buildFinopsOverview,
  capabilityRows,
  missingActions,
  finopsSettings,
  _capability: capability, _isoWeekInfo: isoWeekInfo, _deniedActions: deniedActions,
  _db: db, _getSetting: getSetting, _logger: logger,
};
