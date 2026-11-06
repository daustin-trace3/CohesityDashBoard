/**
 * core/feeds.js: connector and feed registration, the duplicate rules, and
 * query() resolving the current tenant database. Modules are loaded with
 * createRequire so the registry and feeds share one instance with the app.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const feeds = require('../core/feeds');
const db = require('../db/database');

beforeEach(() => { feeds._reset(); });

function fakeConnector(extra) {
  return {
    name: 'Fake',
    register(f) {
      f.registerFeed('devices', (d, params) => ({ rows: [params.vendorKey || null], n: d.prepare('SELECT 7 AS n').get().n }));
      if (extra) extra(f);
    },
  };
}

describe('feeds registry', () => {
  it('registers a connector and lists its feeds', () => {
    feeds.registerConnector('fakeconn', fakeConnector());
    expect(feeds.hasConnector('fakeconn')).toBe(true);
    expect(feeds.hasFeed('fakeconn', 'devices')).toBe(true);
    expect(feeds.hasFeed('fakeconn', 'nope')).toBe(false);
    expect(feeds.listConnectors()).toEqual([{ id: 'fakeconn', name: 'Fake', feeds: ['devices'] }]);
  });

  it('throws on a duplicate connector, a duplicate feed and a bad or reserved id', () => {
    feeds.registerConnector('fakeconn', fakeConnector());
    expect(() => feeds.registerConnector('fakeconn', fakeConnector())).toThrow(/already registered/);
    expect(() => feeds.registerConnector('other', fakeConnector((f) => f.registerFeed('devices', () => []))))
      .toThrow(/feed 'devices' is already registered/);
    // the failed connector does not stay half registered
    expect(feeds.hasConnector('other')).toBe(false);
    expect(() => feeds.registerConnector('Bad Id', fakeConnector())).toThrow(/invalid connector id/);
    expect(() => feeds.registerConnector('settings', fakeConnector())).toThrow(/reserved/);
  });

  it('rejects a connector without register() or a name', () => {
    expect(() => feeds.registerConnector('a', { name: 'x' })).toThrow(/register/);
    expect(() => feeds.registerConnector('b', { register() {} })).toThrow(/name/);
  });

  it('registerFeed on an unknown connector throws', () => {
    expect(() => feeds.registerFeed('ghost', 'x', () => 1)).toThrow(/not registered/);
  });
});

describe('feeds.query', () => {
  it('runs the feed against the current tenant database', () => {
    feeds.registerConnector('fakeconn', fakeConnector());
    const out = feeds.query('fakeconn', 'devices', { vendorKey: 'f5' });
    expect(out).toEqual({ rows: ['f5'], n: 7 });
    // same database object the rest of core uses
    feeds.registerConnector('probe', { name: 'Probe', register(f) { f.registerFeed('same', (d) => d === db); } });
    expect(feeds.query('probe', 'same')).toBe(true);
  });

  it('accepts a database override and defaults params to an object', () => {
    let seen;
    feeds.registerConnector('fakeconn', { name: 'Fake', register(f) { f.registerFeed('x', (d, p) => { seen = { d, p }; return 1; }); } });
    const fakeDb = { tag: 'override' };
    feeds.query('fakeconn', 'x', undefined, { db: fakeDb });
    expect(seen.d).toBe(fakeDb);
    expect(seen.p).toEqual({});
  });

  it('throws FEED_UNKNOWN for an unknown connector or feed', () => {
    feeds.registerConnector('fakeconn', fakeConnector());
    for (const [c, f] of [['fakeconn', 'missing'], ['ghost', 'devices']]) {
      let err;
      try { feeds.query(c, f, {}); } catch (e) { err = e; }
      expect(err && err.code).toBe('FEED_UNKNOWN');
    }
  });

  it('is exposed through coreApi.feeds', () => {
    const { buildCoreApi } = require('../core/coreApi');
    const api = buildCoreApi();
    feeds.registerConnector('fakeconn', fakeConnector());
    expect(api.feeds.hasFeed('fakeconn', 'devices')).toBe(true);
    expect(api.feeds.query('fakeconn', 'devices', { vendorKey: 'x' }).rows).toEqual(['x']);
    expect(api.feeds.listConnectors().map((c) => c.id)).toEqual(['fakeconn']);
  });
});
