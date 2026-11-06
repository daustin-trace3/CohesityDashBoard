/**
 * Service Status for a derived platform (fed by a connector): it reports the
 * connector platform's polled sources with a "(via ...)" suffix, emits no
 * poll:/stale: events of its own, hides at zero devices and reads
 * "Fed by <connector>, N devices" when healthy.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const registry = require('../core/registry');
const feeds = require('../core/feeds');
const { setSetting } = require('../services/settings');
const pollerStatus = require('../services/pollerStatus');
const svc = require('../services/serviceStatus');

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
  feeds.registerConnector('fakeconn', { name: 'Fake', register() {} });
  registry.registerPlugin({
    id: 'fder',
    name: 'Fake Derived',
    apiVersion: 1,
    derivedFrom: 'fakeconn',
    vendorKeys: ['zz'],
    presence: (coreApi) => coreApi.db.prepare("SELECT COUNT(*) AS n FROM fder_dev WHERE vendor_key = 'zz'").get().n,
    createRouter: () => (q, s, n) => n(),
  });
  for (const t of ['service_alert_events', 'service_alert_analyses', 'service_status_timeline', 'poller_status']) db.exec(`DELETE FROM ${t}`);
  setSetting('service_status_ai_enabled', '0');
  setSetting('service_status_mode', 'platform');
  setSetting('service_status_stale_minutes', '120');
  svc._resetTestSeams();
  setDevices(3);
});

afterEach(() => { svc._resetTestSeams(); });

describe('derived platform alias', () => {
  it('polledSourcesFor returns the connector rows with the via suffix', () => {
    pollerStatus.markEnd('fakeconn', 0, 'success');
    const parent = svc.polledSourcesFor('fakeconn');
    const derived = svc.polledSourcesFor('fder');
    expect(parent).toHaveLength(1);
    expect(derived).toHaveLength(1);
    expect(derived[0].entityId).toBe(parent[0].entityId);
    expect(derived[0].lastPollStatus).toBe(parent[0].lastPollStatus);
    expect(derived[0].sourceName).toBe(`${parent[0].sourceName} (via fakeconn)`);
  });

  it('emits no poll: item of its own and reads "Fed by" when the connector polls fine', async () => {
    pollerStatus.markEnd('fakeconn', 0, 'success');
    await svc.sweep();
    expect(db.prepare("SELECT COUNT(*) AS n FROM service_alert_events WHERE platform = 'fder'").get().n).toBe(0);
    const row = db.prepare("SELECT state, reason FROM service_status_timeline WHERE platform = 'fder' ORDER BY id DESC LIMIT 1").get();
    expect(row.state).toBe('ok');
    expect(row.reason).toBe('Fed by fakeconn, 3 devices');
  });

  it('follows the connector poll status without raising events for itself', async () => {
    pollerStatus.markEnd('fakeconn', 0, 'error');
    await svc.sweep();
    expect(db.prepare("SELECT COUNT(*) AS n FROM service_alert_events WHERE platform = 'fder'").get().n).toBe(0);
    const row = db.prepare("SELECT state FROM service_status_timeline WHERE platform = 'fder' ORDER BY id DESC LIMIT 1").get();
    expect(row.state).toBe('offline');
  });

  it('is listed while present and hidden at zero devices', () => {
    expect(svc.getEnabledPlatformIds()).toContain('fder');
    setDevices(0);
    expect(svc.getEnabledPlatformIds()).not.toContain('fder');
  });
});
