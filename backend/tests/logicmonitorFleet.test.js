/**
 * LogicMonitor fleet hygiene (logicmonitorFleet.js) and the connector feeds that expose it.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const fleet = require('../services/logicmonitorFleet');
const connector = require('../connectors/logicmonitor');

let SID;
const dayStr = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);

beforeAll(() => { runMigrations(db, 'logicmonitor', lmMigrations); });
beforeEach(() => {
  for (const t of ['lm_trend_findings', 'lm_alerts', 'lm_device_daily', 'lm_devices', 'lm_sites', 'lm_sources']) db.prepare(`DELETE FROM ${t}`).run();
  SID = db.prepare("INSERT INTO lm_sources (name, company, auth_mode, encrypted_credentials) VALUES ('p1', 'acme', 'lmv1', 'x')").run().lastInsertRowid;
});

function dev(id, name, o = {}) {
  db.prepare('INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, model, version, vendor_key, vendor_kind, site_key, host_status, is_network, stale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)')
    .run(SID, id, name, name, o.model || 'C9300', o.version || '17.9.4', o.vendorKey || 'cisco', o.kind || 'switch', o.site || 'phx', o.host || 'normal');
}

describe('versionSpread', () => {
  it('marks the dominant version per model and lists the outliers', () => {
    dev(1, 'a', { version: '17.9.4' }); dev(2, 'b', { version: '17.9.4' }); dev(3, 'c', { version: '17.6.1' });
    dev(4, 'd', { model: 'C9500', version: '17.9.4' });
    const r = fleet.versionSpread(db, { vendorKey: 'cisco' });
    expect(r.versions.find((v) => v.model === 'C9300' && v.version === '17.9.4')).toMatchObject({ devices: 2, dominant: true });
    expect(r.outliers).toHaveLength(1);
    expect(r.outliers[0]).toMatchObject({ device: 'c', dominantVersion: '17.9.4' });
  });

  it('includes meraki only when asked', () => {
    dev(1, 'a'); dev(2, 'm', { vendorKey: 'meraki' });
    expect(fleet.versionSpread(db, { vendorKey: 'cisco' }).versions.reduce((n, v) => n + v.devices, 0)).toBe(1);
    expect(fleet.versionSpread(db, { vendorKey: 'cisco', includeMeraki: true }).versions.reduce((n, v) => n + v.devices, 0)).toBe(2);
  });
});

describe('availability', () => {
  it('excludes SDT days and rolls up per site', () => {
    dev(1, 'a', { site: 'phx' }); dev(2, 'b', { site: 'phx' });
    const ins = db.prepare('INSERT INTO lm_device_daily (source_id, lm_device_id, day, samples, dead_samples, dead_collector_samples, sdt_samples) VALUES (?, ?, ?, ?, ?, 0, ?)');
    for (let i = 0; i < 10; i += 1) ins.run(SID, 1, dayStr(i), 100, i === 3 ? 50 : 0, i === 5 ? 100 : 0);
    for (let i = 0; i < 10; i += 1) ins.run(SID, 2, dayStr(i), 100, 0, 0);
    const r = fleet.availability(db, { vendorKey: 'cisco', days: 30 });
    const a = r.devices.find((d) => d.device === 'a');
    expect(a).toMatchObject({ sdtDays: 1, deadDays: 1, normalDays: 8 });
    expect(a.availabilityPct).toBeCloseTo(((9 * 100 - 50) / 900) * 100, 1);
    expect(r.sites).toHaveLength(1);
    expect(r.sites[0].devices).toBe(2);
  });
});

describe('alertNoise', () => {
  it('counts alerts, median clear time and repeat offenders, skipping duplicates and shadowed alerts', () => {
    dev(1, 'a');
    const now = Math.floor(Date.now() / 1000);
    const ins = db.prepare(`INSERT INTO lm_alerts (source_id, lm_alert_id, condition_key, lm_device_id, resource_template_name, severity_norm, start_epoch, end_epoch, cleared, duplicate_of, shadowed_by)
      VALUES (?, ?, ?, 1, 'Ping', 'critical', ?, ?, ?, ?, ?)`);
    for (let i = 0; i < 4; i += 1) ins.run(SID, `A${i}`, `k${i}`, now - 3600 * (i + 1), now - 3600 * (i + 1) + 600, 1, null, null);
    ins.run(SID, 'D1', 'kd', now - 100, null, 0, 'x', null);
    ins.run(SID, 'S1', 'ks', now - 100, null, 0, null, '{"deviceId":9}');
    const r = fleet.alertNoise(db, { vendorKey: 'cisco', days: 30 });
    expect(r.byDataSource[0]).toMatchObject({ name: 'Ping', alerts: 4, medianMinutesToClear: 10 });
    expect(r.repeatOffenders[0]).toMatchObject({ device: 'a', type: 'Ping', count7d: 4 });
  });
});

describe('feeds', () => {
  it('register under the contract names and answer empty shapes on an empty portal', () => {
    const feeds = new Map();
    connector.register({ registerFeed: (n, fn) => feeds.set(n, fn) });
    for (const n of ['trends', 'trendSeries', 'interfaceSeries', 'fleetVersions', 'availability', 'alertNoise', 'hardware', 'interfacesAnalytics', 'optics', 'poe',
      'routingPeers', 'deviceResources', 'reachability', 'wirelessAnalytics', 'certificates', 'poolMembers', 'gtm', 'daemonFlaps', 'haState', 'hourlyProfile',
      'interfaces', 'interfaceHistory', 'interfaceCompare']) expect(feeds.has(n), n).toBe(true);
    db.prepare('DELETE FROM lm_devices').run();
    expect(feeds.get('trends')(db, { vendorKey: 'cisco' })).toEqual([]);
    expect(feeds.get('fleetVersions')(db, { vendorKey: 'cisco' })).toEqual({ versions: [], rows: [], outliers: [] });
    expect(feeds.get('hardware')(db, { vendorKey: 'f5' }).components).toEqual([]);
    expect(feeds.get('interfaces')(db, { vendorKey: 'cisco' })).toMatchObject({ items: [], total: 0 });
    expect(feeds.get('gtm')(db, {}).requestsPerDay).toEqual([]);
    expect(feeds.get('hourlyProfile')(db, { vendorKey: 'f5' }).cells).toEqual([]);
  });
});
