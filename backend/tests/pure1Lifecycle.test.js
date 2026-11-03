/**
 * Pure1 lifecycle round: hardware end of life, support contracts, subscriptions
 * and Purity code end of life. Covers the evaluation (services/pure1Lifecycle),
 * GET /api/pure1/governance(.csv), the notifier items and the poller's
 * asset matching and last-good behaviour.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const logger = require('../utils/logger');
const pure1Api = require('../services/pure1Api');
const registry = require('../core/registry');
const { evaluate } = require('../services/pure1Lifecycle');
const { matchAssetsToArrays, refreshLifecycle } = require('../services/pure1Poller');
const alertNotifier = require('../services/alertNotifier');
const pure1Router = require('../routes/pure1');

const DAY = 86400000;
const FIXED_NOW = new Date('2026-11-03T12:00:00Z');
const FIXED_DAY = Date.UTC(2026, 10, 3);
const REAL_DAY = Math.floor(Date.now() / DAY) * DAY;

const TABLES = [
  'pure1_arrays', 'pure1_subscription_assets', 'pure1_support_contracts',
  'pure1_subscriptions', 'pure1_subscription_licenses',
];

let app;

beforeAll(() => {
  app = express();
  app.use('/api/pure1', pure1Router);
  // icc-phase1: no markBuiltin on this branch's registry; the cohesity gate falls back to always-on.
  if (typeof registry.markBuiltin === 'function') registry.markBuiltin('cohesity');
});

beforeEach(() => { for (const t of TABLES) db.exec(`DELETE FROM ${t}`); });

function insertArray(id, name, version, serial, model = 'FlashArray//X70R3') {
  db.prepare(`INSERT INTO pure1_arrays (pure1_id, name, fqdn, model, os, version, chassis_serial, health)
              VALUES (?, ?, ?, ?, 'Purity//FA', ?, ?, 'ok')`).run(id, name, `${name}.test`, model, version, serial);
}

function insertAsset(assetId, arrayId, { eol, subId = null, subName = null, serial = null, name = null, model = 'FlashArray//X70R3', version = '6.9.4', address = null, up = null } = {}) {
  db.prepare(`INSERT INTO pure1_subscription_assets (asset_id, name, pure1_array_id, array_name, chassis_serial, model, version,
      customer_name, activation_date_ms, end_of_life_date_ms, install_address, subscription_id, subscription_name,
      upgrade_action_needed, upgrade_commitment_date_ms, upgrade_eligibility_date_ms, as_of_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'Test Bank', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    assetId, name || assetId, arrayId, null, serial, model, version, FIXED_DAY - 500 * DAY, eol ?? null,
    address ? JSON.stringify(address) : null, subId, subName,
    up ? up.action : null, up ? up.commit : null, up ? up.elig : null, FIXED_DAY
  );
}

function insertContract(resourceId, start, end) {
  db.prepare('INSERT INTO pure1_support_contracts (resource_id, resource_name, start_date_ms, end_date_ms) VALUES (?, ?, ?, ?)')
    .run(resourceId, resourceId, start, end);
}

function insertSub(id, name, expiration, status = 'active') {
  db.prepare(`INSERT INTO pure1_subscriptions (subscription_id, name, customer_name, service, service_tier, service_sla, status,
      start_date_ms, expiration_date_ms, subscription_term) VALUES (?, ?, 'Test Bank', 'Evergreen//One', 'Premium', 'Gold', ?, ?, ?, 24)`)
    .run(id, name, status, FIXED_DAY - 700 * DAY, expiration);
}

function insertLicense(id, subId, subName, expiration, resources = []) {
  db.prepare(`INSERT INTO pure1_subscription_licenses (license_id, name, subscription_id, subscription_name, service_tier,
      start_date_ms, expiration_date_ms, resources) VALUES (?, ?, ?, ?, 'Premium', ?, ?, ?)`)
    .run(id, `${id} name`, subId, subName, FIXED_DAY - 700 * DAY, expiration, JSON.stringify(resources));
}

/** Four arrays: crit, warn, ok, unknown. Dates are offsets from `base`. */
function seedFleet(base) {
  insertArray('A1', 'fa-one', '6.5.1', 'SN-1');
  insertArray('A2', 'fa-two', '6.9.4', 'SN-2');
  insertArray('A3', 'fa-three', '6.9.4', 'SN-3');
  insertArray('A4', 'fa-four', '4.1.2', 'SN-4', 'FlashBlade//S200');

  insertSub('sub-a', 'Sub A', base + 30 * DAY);
  insertSub('sub-b', 'Sub B', base + 400 * DAY);
  insertSub('sub-c', 'Sub C', base - 100 * DAY, 'terminated');
  insertLicense('lic-a', 'sub-a', 'Sub A', base + 30 * DAY, [{ id: 'A1', name: 'fa-one', resource_type: 'arrays' }]);
  insertLicense('lic-b', 'sub-b', 'Sub B', base + 400 * DAY, [{ id: 'A2', name: 'fa-two' }, { id: 'A3', name: 'fa-three' }]);

  insertAsset('asset-1', 'A1', { eol: base - 10 * DAY, subId: 'sub-a', subName: 'Sub A', serial: 'SN-1', address: { city: 'Phoenix', country: 'US' }, up: { action: 'Controller upgrade', commit: base - 5 * DAY, elig: base - 300 * DAY } });
  insertAsset('asset-2', 'A2', { eol: base + 100 * DAY, subId: 'sub-b', subName: 'Sub B', serial: 'SN-2' });
  insertAsset('asset-3', 'A3', { eol: base + 1000 * DAY, subId: 'sub-b', subName: 'Sub B', serial: 'SN-3' });
  insertAsset('asset-orphan', null, { eol: base + 700 * DAY, subId: 'sub-b', subName: 'Sub B', serial: 'SN-9999', name: 'orphan-fa' });

  insertContract('A1', base - 1100 * DAY, base - 5 * DAY);
  insertContract('A2', base - 700 * DAY, base + 40 * DAY);
  insertContract('A3', base - 100 * DAY, base + 500 * DAY);
  // An older ended contract beside the current one: the newest end date wins.
  insertContract('A3', base - 1500 * DAY, base - 400 * DAY);
}

describe('evaluate()', () => {
  it('derives hardware, contract, subscription and purity states per array', () => {
    seedFleet(FIXED_DAY);
    const g = evaluate(FIXED_NOW);
    const by = Object.fromEntries(g.arrays.map((a) => [a.name, a]));

    expect(by['fa-one'].hardware.state).toBe('past');
    expect(by['fa-one'].hardware.daysToEol).toBe(-10);
    expect(by['fa-one'].contract.state).toBe('expired');
    expect(by['fa-one'].subscription.state).toBe('expiring');
    expect(by['fa-one'].purity.phase).toBe('eol');
    expect(by['fa-one'].worst).toBe('crit');
    expect(by['fa-one'].hardware.installAddress).toEqual({ city: 'Phoenix', country: 'US' });
    expect(by['fa-one'].hardware.upgrade.actionNeeded).toBe('Controller upgrade');
    expect(by['fa-one'].license.id).toBe('lic-a');

    expect(by['fa-two'].hardware.state).toBe('approaching');
    expect(by['fa-two'].contract.state).toBe('expiring');
    expect(by['fa-two'].contract.daysLeft).toBe(40);
    expect(by['fa-two'].purity.phase).toBe('supported');
    expect(by['fa-two'].worst).toBe('warn');
    expect(by['fa-two'].hardware.upgrade).toBeNull();

    expect(by['fa-three'].hardware.state).toBe('ok');
    expect(by['fa-three'].contract.state).toBe('ok');
    expect(by['fa-three'].contract.endDate).toBe(FIXED_DAY + 500 * DAY);
    expect(by['fa-three'].subscription.state).toBe('ok');
    expect(by['fa-three'].worst).toBe('ok');

    expect(by['fa-four'].hardware.state).toBe('unknown');
    expect(by['fa-four'].hardware.assetId).toBeNull();
    expect(by['fa-four'].contract.state).toBe('unknown');
    expect(by['fa-four'].subscription).toBeNull();
    expect(by['fa-four'].purity.phase).toBe('unknown');
    expect(by['fa-four'].worst).toBe('unknown');
  });

  it('counts the summary and lists unmatched assets', () => {
    seedFleet(FIXED_DAY);
    const g = evaluate(FIXED_NOW);
    expect(g.summary).toEqual({
      arrays: 4,
      hwEolPast: 1, hwEolApproaching: 1, hwEolUnknown: 1,
      contractsExpired: 1, contractsExpiring: 1, contractsUnknown: 1,
      purityEol: 1, purityApproaching: 0, puritySupported: 2, purityUnknown: 1,
      subscriptions: 3, subscriptionsExpiring: 1, assetsUnmatched: 1,
    });
    expect(g.assetsUnmatched).toHaveLength(1);
    expect(g.assetsUnmatched[0]).toMatchObject({ assetId: 'asset-orphan', chassisSerial: 'SN-9999', subscriptionName: 'Sub B' });
    expect(g.thresholds).toEqual({ hwEolWarnDays: 180, contractWarnDays: 90, purityEolWarnDays: 180 });
    expect(g.purityTable.line_count).toBe(5);
  });

  it('rolls up versions, models and subscriptions', () => {
    seedFleet(FIXED_DAY);
    const g = evaluate(FIXED_NOW);
    expect(g.versions.map((v) => v.version)).toEqual(['6.9.4', '6.5.1', '4.1.2']);
    expect(g.versions[0].count).toBe(2);
    const x70 = g.models.find((m) => m.model === 'FlashArray//X70R3');
    expect(x70).toMatchObject({ count: 3, pastEol: 1, approaching: 1 });
    expect(x70.earliestEol).toBe(FIXED_DAY - 10 * DAY);
    expect(g.models.find((m) => m.model === 'FlashBlade//S200').earliestEol).toBeNull();
    const subB = g.subscriptions.find((s) => s.id === 'sub-b');
    expect(subB).toMatchObject({ arrayCount: 2, licenseCount: 1, state: 'ok', service: 'Evergreen//One' });
    expect(g.subscriptions.find((s) => s.id === 'sub-c').state).toBe('expired');
    expect(g.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('honours threshold overrides', () => {
    seedFleet(FIXED_DAY);
    insertArray('A5', 'fa-five', '6.7.9', 'SN-5');
    const g = evaluate(FIXED_NOW, { thresholds: { hwEolWarnDays: 30, contractWarnDays: 7, purityEolWarnDays: 400 } });
    const by = Object.fromEntries(g.arrays.map((a) => [a.name, a]));
    expect(by['fa-two'].hardware.state).toBe('ok');
    expect(by['fa-two'].contract.state).toBe('ok');
    expect(by['fa-five'].purity.phase).toBe('approaching');
  });

  it('falls back to the license resource list when the asset has no license id', () => {
    seedFleet(FIXED_DAY);
    const g = evaluate(FIXED_NOW);
    const two = g.arrays.find((a) => a.name === 'fa-two');
    expect(two.license.id).toBe('lic-b');
  });

  it('returns empty collections on a fresh install', () => {
    const g = evaluate(FIXED_NOW);
    expect(g.arrays).toEqual([]);
    expect(g.asOf).toBeNull();
    expect(g.summary.arrays).toBe(0);
  });
});

describe('thresholds setting', () => {
  it('clamps saved values and reads them back', () => {
    pure1Api.setConfig({ hwEolWarnDays: 5000, contractWarnDays: 1, purityEolWarnDays: 365 });
    try {
      expect(pure1Api.getLifecycleThresholds()).toEqual({ hwEolWarnDays: 1095, contractWarnDays: 7, purityEolWarnDays: 365 });
      expect(pure1Api.getConfig()).toMatchObject({ hwEolWarnDays: 1095, contractWarnDays: 7, purityEolWarnDays: 365 });
    } finally {
      pure1Api.setConfig({ hwEolWarnDays: 180, contractWarnDays: 90, purityEolWarnDays: 180 });
    }
    expect(pure1Api.getLifecycleThresholds()).toEqual({ hwEolWarnDays: 180, contractWarnDays: 90, purityEolWarnDays: 180 });
  });
});

describe('GET /api/pure1/governance', () => {
  it('returns the documented shape from the tables', async () => {
    seedFleet(FIXED_DAY);
    const res = await request(app).get('/api/pure1/governance');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      ['arrays', 'asOf', 'assetsUnmatched', 'models', 'purityTable', 'subscriptions', 'summary', 'thresholds', 'versions'].sort()
    );
    expect(res.body.summary.arrays).toBe(4);
    expect(res.body.summary.assetsUnmatched).toBe(1);
    const a = res.body.arrays.find((x) => x.name === 'fa-one');
    expect(Object.keys(a).sort()).toEqual(
      ['chassisSerial', 'contract', 'fqdn', 'hardware', 'health', 'id', 'license', 'model', 'name', 'os', 'purity', 'subscription', 'version', 'worst'].sort()
    );
    expect(Object.keys(a.hardware).sort()).toEqual(
      ['activationDate', 'assetId', 'assetName', 'customerName', 'daysToEol', 'endOfLifeDate', 'installAddress', 'state', 'upgrade'].sort()
    );
    expect(Object.keys(a.contract).sort()).toEqual(['daysLeft', 'endDate', 'startDate', 'state']);
    expect(Object.keys(a.subscription).sort()).toEqual(
      ['daysLeft', 'expirationDate', 'id', 'name', 'service', 'serviceSla', 'serviceTier', 'startDate', 'state', 'status', 'term']
    );
  });

  it('exports one csv row per array with a formula guard', async () => {
    seedFleet(FIXED_DAY);
    db.prepare("UPDATE pure1_arrays SET name = '=cmd' WHERE pure1_id = 'A4'").run();
    const res = await request(app).get('/api/pure1/governance.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = res.text.trim().split('\r\n');
    expect(lines).toHaveLength(5);
    expect(lines[0].startsWith('Array,FQDN,Model')).toBe(true);
    expect(lines.some((l) => l.startsWith("'=cmd,"))).toBe(true);
  });
});

describe('notifier items', () => {
  const lifecycleItems = () => {
    registry.registerPlugin({
      id: 'pure', name: 'Pure', apiVersion: registry.PLUGIN_API_VERSION, migrations: [],
      createRouter: () => (req, res, next) => next(),
    });
    try {
      return alertNotifier.collectOpenAlerts().items.filter((i) => String(i.type || '').startsWith('pure1-') && i.type !== 'pure1-metrics-stale');
    } finally { registry.unregisterPlugin('pure'); }
  };

  it('raises critical and warning items per state with stable source keys', () => {
    seedFleet(REAL_DAY);
    const items = lifecycleItems();
    const keys = items.map((i) => i.sourceKey).sort();
    expect(keys).toEqual([
      'pure1-contract:A1', 'pure1-contract:A2',
      'pure1-hw-eol:A1', 'pure1-hw-eol:A2',
      'pure1-purity:A1',
      'pure1-subscription:A1',
    ]);
    const get = (k) => items.find((i) => i.sourceKey === k);
    expect(get('pure1-hw-eol:A1')).toMatchObject({ severity: 'critical', type: 'pure1-hardware-eol', host: 'fa-one', platform: 'pure' });
    expect(get('pure1-hw-eol:A1').message).toMatch(/^Hardware end of life \d{4}-\d{2}-\d{2} \(10 days ago\)$/);
    expect(get('pure1-hw-eol:A2').severity).toBe('warning');
    expect(get('pure1-contract:A1')).toMatchObject({ severity: 'critical', type: 'pure1-support-expiring' });
    expect(get('pure1-contract:A2').severity).toBe('warning');
    expect(get('pure1-subscription:A1')).toMatchObject({ severity: 'warning', type: 'pure1-subscription-expiring' });
    expect(get('pure1-purity:A1')).toMatchObject({ severity: 'critical', type: 'pure1-purity-eol' });
    expect(get('pure1-purity:A1').message).toMatch(/^Purity 6\.5\.1 line 6\.5 end of development 2026-09-30/);
  });

  it('lists the four types in the Pure alert-type catalog once arrays are on record', () => {
    seedFleet(REAL_DAY);
    alertNotifier.refreshTypeCatalog('pure');
    const rows = db.prepare("SELECT type, enabled FROM alert_notify_types WHERE platform = 'pure' AND type LIKE 'pure1-%'").all();
    const types = rows.map((r) => r.type).sort();
    expect(types).toEqual(['pure1-hardware-eol', 'pure1-metrics-stale', 'pure1-purity-eol', 'pure1-subscription-expiring', 'pure1-support-expiring']);
    // icc-phase1 keeps new alert types enabled by default (feat inserts them off).
    expect(rows.every((r) => r.enabled === 1)).toBe(true);
  });
});

describe('matchAssetsToArrays', () => {
  const arrays = [
    { id: 'A', name: 'fa-alpha', chassisSerial: 'SN-A' },
    { id: 'B', name: 'fa-beta', chassisSerial: 'SN-B' },
  ];
  const asset = (id, name, serial) => ({ id, name, array: { chassisSerialNumber: serial } });

  it('prefers the chassis serial over the name', () => {
    const [m] = matchAssetsToArrays([asset('1', 'fa-beta', 'SN-A')], arrays);
    expect(m.array.id).toBe('A');
    expect(m.by).toBe('serial');
  });

  it('falls back to a case-insensitive name match', () => {
    const [m] = matchAssetsToArrays([asset('1', 'FA-Beta', null)], arrays);
    expect(m.array.id).toBe('B');
    expect(m.by).toBe('name');
  });

  it('keeps unmatched assets in order with a null array', () => {
    const out = matchAssetsToArrays([asset('1', 'nope', 'SN-Z'), asset('2', 'fa-alpha', 'sn-a ')], arrays);
    expect(out.map((m) => m.asset.id)).toEqual(['1', '2']);
    expect(out[0].array).toBeNull();
    expect(out[0].by).toBeNull();
    expect(out[1].array.id).toBe('A');
  });
});

describe('refreshLifecycle', () => {
  const saved = {};
  let warn;
  const names = ['fetchSubscriptionAssets', 'fetchSupportContracts', 'fetchSubscriptions', 'fetchSubscriptionLicenses'];

  beforeEach(() => {
    for (const n of names) saved[n] = pure1Api[n];
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const n of names) pure1Api[n] = saved[n];
    vi.restoreAllMocks();
  });

  it('replaces the tables whose fetch worked and keeps the old rows of one that failed', async () => {
    insertContract('old-array', FIXED_DAY - 100 * DAY, FIXED_DAY + 100 * DAY);
    insertSub('old-sub', 'Old sub', FIXED_DAY + 10 * DAY);
    insertAsset('old-asset', null, { eol: FIXED_DAY });

    pure1Api.fetchSubscriptionAssets = async () => [{
      id: 'asset-new', name: 'fa-alpha', asOf: FIXED_DAY, activationDate: FIXED_DAY - DAY, endOfLifeDate: FIXED_DAY + 30 * DAY,
      customerName: 'Bank', installAddress: { city: 'X' }, license: { id: 'l1', name: 'L1' }, subscription: { id: 's1', name: 'S1' },
      array: { model: 'FlashArray//X', version: '6.7.9', chassisSerialNumber: 'SN-A' },
      upgradeDetails: { actionNeeded: 'yes', commitmentDate: FIXED_DAY, eligibilityDate: FIXED_DAY },
    }];
    pure1Api.fetchSupportContracts = async () => { throw new Error('boom'); };
    pure1Api.fetchSubscriptions = async () => [];
    pure1Api.fetchSubscriptionLicenses = async () => [{
      id: 'l1', name: 'L1', subscriptionId: 's1', subscriptionName: 'S1', serviceTier: 'Premium',
      startDate: FIXED_DAY, expirationDate: FIXED_DAY + DAY, lastUpdated: FIXED_DAY, siteAddress: null, resources: [{ id: 'A', name: 'fa-alpha' }],
    }];

    await refreshLifecycle([{ id: 'A', name: 'fa-alpha', chassisSerial: 'SN-A' }]);

    // failed fetch: old contract row kept
    expect(db.prepare('SELECT resource_id FROM pure1_support_contracts').all().map((r) => r.resource_id)).toEqual(['old-array']);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('support contracts fetch failed'))).toBe(true);
    // empty successful fetch: table replaced wholesale
    expect(db.prepare('SELECT COUNT(*) AS n FROM pure1_subscriptions').get().n).toBe(0);
    // assets replaced and matched by serial
    const assets = db.prepare('SELECT * FROM pure1_subscription_assets').all();
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ asset_id: 'asset-new', pure1_array_id: 'A', array_name: 'fa-alpha', chassis_serial: 'SN-A', upgrade_action_needed: 'yes' });
    expect(JSON.parse(assets[0].install_address)).toEqual({ city: 'X' });
    expect(db.prepare('SELECT license_id FROM pure1_subscription_licenses').all()).toEqual([{ license_id: 'l1' }]);
  });
});
