// Data retention settings: two buckets (trending, events) with a global value and an
// optional per-platform override. Mounted at /api/retention in app.js before the plugin
// dispatcher; each route gates itself (see core/retention.js for the resolve rules).
const express = require('express');
const registry = require('../core/registry');
const retention = require('../core/retention');
const { getSetting, setSetting } = require('../services/settings');
const { platformMeta } = require('../services/platformMeta');
const { requirePermission } = require('../middleware/requirePermission');
const { hasPermission } = require('../services/rbac');

const router = express.Router();

const NOTE = 'ICC Service Status timelines follow the global values.';
const CONFIG_LEDGER = { min: 30, max: 1825, def: 365 };

// Raw high-frequency sample windows that stay on their own keys, per platform.
const RAW = {
  logicmonitor: [
    { key: 'lm_interface_history_days', label: 'Interface history', def: 30, panel: 'Raw samples and limits' },
    { key: 'lm_check_history_days', label: 'Check history', def: 30, panel: 'Raw samples and limits' },
    { key: 'lm_ds_history_days', label: 'DataSource metric history', def: 14, panel: 'Raw samples and limits' },
  ],
  brocade: [
    { key: 'brocade_port_stats_retention_days', label: 'Port statistics', def: 14, panel: 'Alert Thresholds' },
  ],
};

function rawRows(id) {
  return (RAW[id] || []).map((r) => {
    const n = Number(getSetting(r.key));
    return { key: r.key, label: r.label, days: Number.isFinite(n) && n > 0 ? Math.round(n) : r.def, panel: r.panel };
  });
}

function configLedgerDays() {
  const n = Number(getSetting('config_ledger_retention_days'));
  if (!Number.isFinite(n) || n < CONFIG_LEDGER.min || n > CONFIG_LEDGER.max) return CONFIG_LEDGER.def;
  return Math.round(n);
}

/** Retention-capable platform ids: registered or built-in, never derived, never rubrik. */
function platformIds() {
  const ids = new Set();
  for (const p of registry.listPlugins()) ids.add(p.id);
  // Older registries (icc-phase1) have no isBuiltinPresent; cohesity is always-on there.
  if (typeof registry.isBuiltinPresent !== 'function' || registry.isBuiltinPresent('cohesity')) ids.add('cohesity');
  return [...ids].filter((id) => id !== 'rubrik' && id !== 'icc' && !registry.isDerived(id)
    && Object.prototype.hasOwnProperty.call(retention.COVERAGE, id));
}

function platformEnabled(id) {
  if (id === 'cohesity') return getSetting('platform_cohesity_enabled') !== '0';
  const p = registry.getPlugin(id);
  if (p) return !!p.enabled;
  return getSetting(`platform_${id}_enabled`) === '1';
}

function bucketView(id, bucket) {
  const r = retention.resolve(id, bucket);
  return { override: r.override, days: r.days, source: r.source };
}

function payload() {
  const platforms = platformIds().map((id) => {
    const cov = retention.COVERAGE[id] || { trending: [], events: [] };
    return {
      id,
      label: platformMeta(id).label,
      enabled: platformEnabled(id),
      settingsRoute: id === 'cohesity' ? '/settings' : `/${id}/settings`,
      trending: bucketView(id, 'trending'),
      events: bucketView(id, 'events'),
      coverage: { trending: [...cov.trending], events: [...cov.events] },
      raw: rawRows(id),
    };
  }).sort((a, b) => a.label.localeCompare(b.label));
  return {
    buckets: { trending: retention.BUCKETS.trending, events: retention.BUCKETS.events },
    global: { trending: retention.globalDays('trending'), events: retention.globalDays('events') },
    ledgers: { configLedgerDays: configLedgerDays() },
    platforms,
    note: NOTE,
  };
}

function bad(res, error, field) { return res.status(400).json({ error, field }); }

/** admin:settings:manage, or the platform's own <id>:settings:manage. */
function platformManage(req, res, next) {
  const grants = (req.auth && req.auth.grants) || [];
  const id = req.params.id;
  if (hasPermission(grants, 'admin:settings:manage') || hasPermission(grants, `${id}:settings:manage`)) return next();
  return res.status(403).json({ error: 'forbidden', required: `${id}:settings:manage` });
}

router.get('/', requirePermission(() => 'admin:settings:view'), (req, res) => {
  res.json(payload());
});

router.put('/global', requirePermission(() => 'admin:settings:manage'), (req, res) => {
  const b = req.body || {};
  const writes = [];
  for (const bucket of retention.BUCKET_KEYS) {
    if (b[bucket] === undefined) continue;
    const v = retention.validate(b[bucket], bucket);
    if (!v.ok) return bad(res, v.error, bucket);
    writes.push(() => retention.setGlobal(bucket, v.days));
  }
  if (b.configLedgerDays !== undefined) {
    const n = Number(b.configLedgerDays);
    if (b.configLedgerDays === '' || b.configLedgerDays === null || !Number.isFinite(n) || Math.round(n) !== n
      || n < CONFIG_LEDGER.min || n > CONFIG_LEDGER.max) {
      return bad(res, `Configuration change ledger must be ${CONFIG_LEDGER.min} to ${CONFIG_LEDGER.max} days`, 'configLedgerDays');
    }
    writes.push(() => setSetting('config_ledger_retention_days', String(n)));
  }
  writes.forEach((w) => w());
  res.json(payload());
});

router.put('/platforms/:id', platformManage, (req, res) => {
  const id = req.params.id;
  if (!platformIds().includes(id)) return res.status(404).json({ error: 'Unknown platform' });
  const b = req.body || {};
  const writes = [];
  for (const bucket of retention.BUCKET_KEYS) {
    if (b[bucket] === undefined) continue;
    const v = retention.validate(b[bucket], bucket, { allowInherit: true });
    if (!v.ok) return bad(res, v.error, bucket);
    writes.push(() => retention.setPlatform(id, bucket, v.days));
  }
  writes.forEach((w) => w());
  res.json(payload());
});

module.exports = router;
