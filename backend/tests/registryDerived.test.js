/**
 * Derived platforms in the registry: derivedFrom / vendorKeys / presence,
 * the present filter on every manifest-hook getter, derivedPlatformFor,
 * isPresent and the platform_absent answer from dispatchTo.
 * Presence reads a scratch table so it changes with database state (the
 * registry memoizes it per database state, core/dbMemo.js).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);
const express = require('express');
const db = require('../db/database');
const registry = require('../core/registry');
const feeds = require('../core/feeds');

function derivedManifest(over = {}) {
  return {
    id: 'fder',
    name: 'Fake Derived',
    apiVersion: 1,
    color: '#123456',
    derivedFrom: 'fakeconn',
    vendorKeys: ['zz'],
    presence: (coreApi) => coreApi.db.prepare("SELECT COUNT(*) AS n FROM fder_dev WHERE vendor_key = 'zz'").get().n,
    createRouter() {
      const r = express.Router();
      r.get('/ping', (req, res) => res.json({ ok: true }));
      return r;
    },
    opsSummary: () => ({ objects: 1, headline: [], exceptions: [], spark: null }),
    collectAlerts: () => [],
    searchCategories: [{ key: 'fder-x', label: 'X', platform: 'fder', perm: 'fder:*:view', base: '/fder', sql: 'SELECT 1' }],
    agentProfile: { focus: 'fake' },
    ...over,
  };
}

function plainManifest(over = {}) {
  return { id: 'plain', name: 'Plain', apiVersion: 1, createRouter: () => (q, s, n) => n(), ...over };
}

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
  setDevices(0);
});

describe('derived platform validation', () => {
  it('throws when derivedFrom names an unregistered connector', () => {
    expect(() => registry.registerPlugin(derivedManifest({ derivedFrom: 'ghostconn' }))).toThrow(/not registered/);
  });

  it('throws when vendorKeys is empty, missing or not strings', () => {
    expect(() => registry.registerPlugin(derivedManifest({ vendorKeys: [] }))).toThrow(/vendorKeys/);
    expect(() => registry.registerPlugin(derivedManifest({ vendorKeys: undefined }))).toThrow(/vendorKeys/);
    expect(() => registry.registerPlugin(derivedManifest({ vendorKeys: [3] }))).toThrow(/vendorKeys/);
  });

  it('throws when a vendor key is claimed twice', () => {
    registry.registerPlugin(derivedManifest());
    expect(() => registry.registerPlugin(derivedManifest({ id: 'fder2' }))).toThrow(/already claimed by 'fder'/);
  });

  it('throws when a derived platform has no presence()', () => {
    expect(() => registry.registerPlugin(derivedManifest({ presence: undefined }))).toThrow(/presence/);
  });
});

describe('presence', () => {
  it('flips isPresent and presenceOf with the matched device count', () => {
    registry.registerPlugin(derivedManifest());
    expect(registry.isDerived('fder')).toBe(true);
    expect(registry.presenceOf('fder')).toBe(0);
    expect(registry.isPresent('fder')).toBe(false);
    setDevices(3);
    expect(registry.presenceOf('fder')).toBe(3);
    expect(registry.isPresent('fder')).toBe(true);
    setDevices(0);
    expect(registry.isPresent('fder')).toBe(false);
  });

  it('is always present for a platform that is not derived or unknown', () => {
    registry.registerPlugin(plainManifest());
    expect(registry.isDerived('plain')).toBe(false);
    expect(registry.isPresent('plain')).toBe(true);
    expect(registry.isPresent('never-registered')).toBe(true);
  });

  it('answers 0 when presence() throws', () => {
    registry.registerPlugin(derivedManifest({ presence: () => { throw new Error('no such table'); } }));
    expect(registry.presenceOf('fder')).toBe(0);
    expect(registry.isPresent('fder')).toBe(false);
  });

  it('derivedPlatformFor answers only while the platform is present and enabled', () => {
    registry.registerPlugin(derivedManifest());
    expect(registry.derivedPlatformFor('zz')).toBe(null);
    setDevices(2);
    expect(registry.derivedPlatformFor('zz')).toBe('fder');
    expect(registry.derivedPlatformFor('other')).toBe(null);
    registry.setEnabled('fder', false);
    expect(registry.derivedPlatformFor('zz')).toBe(null);
  });

  it('listDerived reports the state for settings rows', () => {
    registry.registerPlugin(derivedManifest());
    setDevices(4);
    expect(registry.listDerived()).toEqual([{
      id: 'fder', label: 'Fake Derived', derivedFrom: 'fakeconn', vendorKeys: ['zz'], enabled: true, present: true, matchedDevices: 4,
    }]);
    expect(registry.getPlugin('fder')).toMatchObject({ derived: true, derivedFrom: 'fakeconn' });
  });
});

describe('present filter on the manifest-hook getters', () => {
  const getters = {
  // icc-phase1 hand-wires ops, collectors, alert platforms and search (no manifest-hook loops); only the profile getter filters here.
    profiles: () => registry.getAgentProfileProviders().map((p) => p.id).sort(),
  };

  it('excludes a derived platform at zero devices and includes it at three', () => {
    registry.registerPlugin(derivedManifest());
    registry.registerPlugin(plainManifest({ opsSummary: () => null, collectAlerts: () => [], agentProfile: { focus: 'p' } }));
    expect(getters.profiles()).toEqual(['plain']);
    setDevices(3);
    expect(getters.profiles()).toEqual(['fder', 'plain']);
  });

  it('getAgentProfileProviders now also drops a disabled platform', () => {
    registry.registerPlugin(plainManifest({ agentProfile: { focus: 'p' } }));
    expect(getters.profiles()).toEqual(['plain']);
    registry.setEnabled('plain', false);
    expect(getters.profiles()).toEqual([]);
  });
});

describe('dispatchTo', () => {
  function app() {
    const a = express();
    a.use('/api/:pluginId', registry.dispatch);
    a.use((req, res) => res.status(404).json({ error: 'not_found' }));
    return a;
  }

  it('answers 404 platform_absent with no devices, then serves once one matches', async () => {
    registry.registerPlugin(derivedManifest());
    const absent = await request(app()).get('/api/fder/ping');
    expect(absent.status).toBe(404);
    expect(absent.body).toEqual({ error: 'platform_absent', derivedFrom: 'fakeconn' });
    setDevices(1);
    const ok = await request(app()).get('/api/fder/ping');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
  });

  it('keeps platform_disabled for a disabled derived platform', async () => {
    registry.registerPlugin(derivedManifest());
    setDevices(1);
    registry.setEnabled('fder', false);
    const res = await request(app()).get('/api/fder/ping');
    expect(res.body).toEqual({ error: 'platform_disabled' });
  });
});
