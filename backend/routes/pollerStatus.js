// WP0: core-owned half of the former routes/poller.js (pure file
// reorganization — same mounted path /api/poller/status, same response
// shape). The trigger endpoints (cohesity-owned) live in routes/pollerTrigger.js.
const express = require('express');
const db = require('../db/database');
const pollerStatus = require('../services/pollerStatus');
const registry = require('../core/registry');
const { getSetting } = require('../services/settings');
const router = express.Router();

// Per-plugin metrics-history table + array-key column, for the lastCapture
// lookup in each entity's status row. Pure/NetApp today; any future platform
// plugin with a metrics_history table + statusTables[0] as its arrays table
// can add an entry here.
const PLATFORM_METRICS_HISTORY = {
  pure: { arraysTable: 'pure_arrays', metricsTable: 'pure_metrics_history', arrayIdColumn: 'array_id' },
  netapp: { arraysTable: 'netapp_arrays', metricsTable: 'netapp_metrics_history', arrayIdColumn: 'array_id' },
  vcenter: { arraysTable: 'vcenter_vcenters', metricsTable: 'vcenter_metrics_history', arrayIdColumn: 'vcenter_id' },
  dell: { arraysTable: 'dell_ome_instances', metricsTable: 'dell_metrics_history', arrayIdColumn: 'ome_id' },
  aria: { arraysTable: 'aria_instances', metricsTable: 'aria_metrics_history', arrayIdColumn: 'instance_id' },
  ariaops: { arraysTable: 'ariaops_instances', metricsTable: 'ariaops_metrics_history', arrayIdColumn: 'instance_id' },
  aws: { arraysTable: 'aws_accounts', metricsTable: 'aws_metrics_history', arrayIdColumn: 'account_id' },
};

router.get('/status', (req, res, next) => {
  try {
    const now = Date.now();

    // Helper: compute ageMinutes from a captured_at UTC string (no timezone suffix).
    function ageMinutes(capturedAt) {
      if (!capturedAt) return null;
      const ms = new Date(capturedAt + 'Z').getTime();
      if (isNaN(ms)) return null;
      return Math.round((now - ms) / 60000);
    }

    // Helper: build entity array from a table.
    function buildEntities(rows, metricsQuery, type) {
      return rows.map(row => {
        const metricsRow = db.prepare(metricsQuery).get(row.id);
        const lastDataCapture = metricsRow
          ? strftime(metricsRow.captured_at)
          : null;
        const age = ageMinutes(metricsRow ? metricsRow.captured_at : null);
        const interval = Math.max(5, row.polling_interval_minutes || 15);
        const state = pollerStatus.getState(type, row.id);
        return {
          id: row.id,
          name: row.name,
          intervalMinutes: interval,
          isSyncing: state.isSyncing,
          lastPollStart: state.lastPollStart,
          lastPollEnd: state.lastPollEnd,
          lastPollStatus: state.lastPollStatus,
          lastDataCapture,
          ageMinutes: age,
          isStale: age !== null ? age > interval * 2 + 5 : false,
        };
      });
    }

    // Attach Z suffix to bare UTC strings from SQLite.
    function strftime(val) {
      if (!val) return null;
      return val.endsWith('Z') ? val : val + 'Z';
    }

    // Cohesity clusters — the `clusters`/`metrics_history` tables live in the
    // cohesity pack's migrations (WP-E), so a host with the pack not yet
    // installed (or removed) has neither. Degrade to an empty section
    // instead of throwing, matching the extraPluginSections pattern below.
    let clusters = [];
    let cohesityEntities = [];
    try {
      clusters = db.prepare('SELECT id, name, polling_interval_minutes FROM clusters').all();
      cohesityEntities = buildEntities(
        clusters,
        'SELECT captured_at FROM metrics_history WHERE cluster_id = ? ORDER BY captured_at DESC LIMIT 1',
        'cohesity'
      );
    } catch { /* degrade: cohesity pack not installed */ }

    // Registry-driven platform plugins (pure, netapp): entities + enabled
    // state derive from the registry; the metrics-history table for the
    // lastCapture lookup comes from PLATFORM_METRICS_HISTORY above.
    const platformSections = {};
    for (const [pluginId, cfg] of Object.entries(PLATFORM_METRICS_HISTORY)) {
      const plugin = registry.getPlugin(pluginId);
      const arrays = db.prepare(`SELECT id, name, polling_interval_minutes FROM ${cfg.arraysTable}`).all();
      const entities = buildEntities(
        arrays,
        `SELECT captured_at FROM ${cfg.metricsTable} WHERE ${cfg.arrayIdColumn} = ? ORDER BY captured_at DESC LIMIT 1`,
        pluginId
      );
      platformSections[pluginId] = {
        enabled: plugin ? plugin.enabled : false,
        entities,
      };
    }

    // Phase 1 manifest-driven core hooks: plugins declaring a static
    // `metricsHistory` config get the same lastCapture-lookup section as the
    // built-ins above, merged at request time (not module load) so hot-added
    // plugins work without a restart. Missing/mismatched tables degrade to
    // an empty section instead of a 500.
    const extraPluginSections = {};
    let pluginMetricsHistory = {};
    try {
      pluginMetricsHistory = registry.getMetricsHistoryContributors();
    } catch { /* degrade: no plugin metrics-history sections surfaced */ }
    for (const [pluginId, cfg] of Object.entries(pluginMetricsHistory)) {
      if (pluginId in PLATFORM_METRICS_HISTORY) continue; // built-in already wins above
      const plugin = registry.getPlugin(pluginId);
      try {
        const arrays = db.prepare(`SELECT id, name, polling_interval_minutes FROM ${cfg.arraysTable}`).all();
        // tsColumn: metrics tables that use a column other than captured_at (e.g. brocade_metrics.ts)
        const tsCol = /^[a-z_]+$/.test(cfg.tsColumn || '') ? cfg.tsColumn : 'captured_at';
        const entities = buildEntities(
          arrays,
          `SELECT ${tsCol} AS captured_at FROM ${cfg.metricsTable} WHERE ${cfg.arrayIdColumn} = ? ORDER BY ${tsCol} DESC LIMIT 1`,
          pluginId
        );
        extraPluginSections[pluginId] = { enabled: plugin ? plugin.enabled : false, entities };
      } catch (err) {
        extraPluginSections[pluginId] = { enabled: plugin ? plugin.enabled : false, entities: [] };
      }
    }

    // Pure: direct arrays (pure_arrays) build entities as above; SaaS-only
    // deployments have no direct arrays, so fall back to the Pure1 account-
    // global snapshot (mirrors the Zerto block below) instead of an empty
    // entities:[] that the switcher reads as "no data" (grey).
    const purePlugin = registry.getPlugin('pure');
    let pureSection = platformSections.pure;
    if (!pureSection.entities || pureSection.entities.length === 0) {
      const pure1Row = db.prepare('SELECT MAX(captured_at) AS captured_at FROM pure1_metrics_history').get();
      const pure1Capture = pure1Row ? pure1Row.captured_at : null;
      const pure1Age = ageMinutes(pure1Capture);
      const pure1State = pollerStatus.getState('pure1', 0);
      const pure1Interval = Number(getSetting('pure1_poll_interval_minutes')) || 15;
      pureSection = {
        enabled: purePlugin ? purePlugin.enabled : false,
        isSyncing: pure1State.isSyncing,
        lastRefreshEnd: pure1State.lastPollEnd,
        lastDataCapture: strftime(pure1Capture),
        ageMinutes: pure1Age,
        isStale: pure1Age !== null ? pure1Age > pure1Interval * 2 + 5 : false,
        failedSources: pure1State.lastPollStatus === 'error' ? [{ name: 'Pure1' }] : [],
      };
    }

    // Licensing (global, no per-entity structure) — cohesity-owned table.
    let licenseCapture = null;
    try {
      const licenseRow = db.prepare('SELECT MAX(captured_at) AS captured_at FROM license_usage').get();
      licenseCapture = licenseRow ? licenseRow.captured_at : null;
    } catch { /* degrade: cohesity pack not installed */ }
    const licenseAge = ageMinutes(licenseCapture);
    const licensingState = pollerStatus.getState('licensing', 0);
    // Licensing interval is 60 min (hardcoded in initLicensing hourly cron).
    const licensingInterval = 60;

    // Views inventory (global, hourly cron in initViews) — cohesity-owned table.
    let viewsCapture = null;
    try {
      const viewsRow = db.prepare('SELECT MAX(captured_at) AS captured_at FROM cohesity_views').get();
      viewsCapture = viewsRow ? viewsRow.captured_at : null;
    } catch { /* degrade: cohesity pack not installed */ }
    const viewsAge = ageMinutes(viewsCapture);
    const viewsState = pollerStatus.getState('views', 0);

    // Zerto (account-global SaaS task — no per-entity structure)
    const zertoPlugin = registry.getPlugin('zerto');
    const zertoRow = db.prepare('SELECT MAX(captured_at) AS captured_at FROM zerto_metrics_history').get();
    const zertoCapture = zertoRow ? zertoRow.captured_at : null;
    const zertoAge = ageMinutes(zertoCapture);
    const zertoState = pollerStatus.getState('zerto', 0);
    const zertoInterval = Number(getSetting('zerto_poll_interval_minutes')) || 15;

    res.json({
      cohesity: {
        enabled: clusters.length > 0,
        entities: cohesityEntities,
      },
      pure: pureSection,
      netapp: platformSections.netapp,
      vcenter: platformSections.vcenter,
      dell: platformSections.dell,
      aria: platformSections.aria,
      ariaops: platformSections.ariaops,
      aws: platformSections.aws,
      licensing: {
        enabled: true,
        isSyncing: licensingState.isSyncing,
        lastRefreshEnd: licensingState.lastPollEnd,
        lastDataCapture: strftime(licenseCapture),
        ageMinutes: licenseAge,
        isStale: licenseAge !== null ? licenseAge > licensingInterval * 2 + 5 : false,
        failedSources: [],
      },
      views: {
        enabled: true,
        isSyncing: viewsState.isSyncing,
        lastRefreshEnd: viewsState.lastPollEnd,
        lastDataCapture: strftime(viewsCapture),
        ageMinutes: viewsAge,
        isStale: viewsAge !== null ? viewsAge > licensingInterval * 2 + 5 : false,
      },
      zerto: {
        enabled: zertoPlugin ? zertoPlugin.enabled : false,
        isSyncing: zertoState.isSyncing,
        lastRefreshEnd: zertoState.lastPollEnd,
        lastDataCapture: strftime(zertoCapture),
        ageMinutes: zertoAge,
        isStale: zertoAge !== null ? zertoAge > zertoInterval * 2 + 5 : false,
        failedSources: [],
      },
      ...extraPluginSections,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
