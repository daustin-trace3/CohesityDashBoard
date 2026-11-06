/**
 * Alert notifier and settings for a derived platform: the type catalog backfill
 * reads the connector feeds (owner-aware), the notification platform list
 * includes the platform only while it is present.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const registry = require('../core/registry');
const feeds = require('../core/feeds');
const notifier = require('../services/alertNotifier');
const { getNotificationSettings } = require('../services/settings');

function setDevices(n) {
  db.exec('DELETE FROM fder_dev');
  const ins = db.prepare("INSERT INTO fder_dev (vendor_key) VALUES ('zz')");
  for (let i = 0; i < n; i += 1) ins.run();
}

beforeAll(() => {
  db.exec('CREATE TABLE IF NOT EXISTS fder_dev (id INTEGER PRIMARY KEY, vendor_key TEXT)');
});

beforeEach(() => {
  registry._reset();
  feeds._reset();
  registry.init();
  feeds.registerConnector('fakeconn', {
    name: 'Fake',
    register(f) {
      f.registerFeed('issues', (d, p) => ({
        asOf: '2026-11-05T00:00:00Z',
        rows: p.vendorKey === 'zz'
          ? [{ type: 'lb-pool-degraded', first_seen: '2026-11-01 10:00:00', last_seen: '2026-11-04 10:00:00' }]
          : [],
      }));
      f.registerFeed('alerts', (d, p) => (p.vendorKey === 'zz'
        ? [{ resource_template_name: 'F5_BigIP_CPU', start_epoch: 1793000000, captured_at: '2026-11-04 12:00:00' }]
        : []));
    },
  });
  registry.registerPlugin({
    id: 'f5',
    name: 'F5 test',
    apiVersion: 1,
    derivedFrom: 'fakeconn',
    vendorKeys: ['zz'],
    presence: (coreApi) => coreApi.db.prepare("SELECT COUNT(*) AS n FROM fder_dev WHERE vendor_key = 'zz'").get().n,
    createRouter: () => (q, s, n) => n(),
    collectAlerts: () => [],
  });
  db.exec("DELETE FROM alert_notify_types WHERE platform = 'f5'");
  setDevices(0);
});

describe('type catalog backfill for a derived platform', () => {
  it('writes nothing while the platform has no devices', () => {
    notifier.refreshTypeCatalog('f5');
    expect(db.prepare("SELECT COUNT(*) AS n FROM alert_notify_types WHERE platform = 'f5'").get().n).toBe(0);
  });

  it('lists issue types and alert datasources from the feeds once present', () => {
    setDevices(2);
    notifier.refreshTypeCatalog('f5');
    const types = db.prepare("SELECT type, enabled FROM alert_notify_types WHERE platform = 'f5' ORDER BY type").all();
    expect(types.map((t) => t.type)).toEqual(['F5_BigIP_CPU', 'lb-pool-degraded']);
    // icc-phase1 keeps alert types enabled by default (feat starts them off).
    expect(types.every((t) => t.enabled === 1)).toBe(true);
  });
});

describe('notification platform list', () => {
  it('includes the derived platform only while it is present', () => {
    expect('f5' in getNotificationSettings().alertPlatforms).toBe(false);
    setDevices(1);
    const s = getNotificationSettings();
    expect(s.alertPlatforms.f5).toBe(true);
    expect(s.alertPlatformsActive.f5).toBe(true);
  });
});
