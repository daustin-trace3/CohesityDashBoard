import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const deprecated = require('../middleware/deprecatedAlias.js');
const logger = require('../utils/logger.js');

const req = (over = {}) => ({
  method: 'GET', originalUrl: '/api/clusters', ip: '10.0.0.9',
  get: (h) => over.headers?.[h.toLowerCase()] ?? null,
  ...over,
});

let lines; let realWarn;
beforeEach(() => {
  deprecated._reset();
  lines = [];
  realWarn = logger.warn;
  logger.warn = (...args) => lines.push(args.join(' '));
});
afterEach(() => { logger.warn = realWarn; });

describe('deprecated alias warning', () => {
  it('names the page that called it, so a plugin page or a stale bundle is identifiable', () => {
    const mw = deprecated('/api/clusters', '/api/cohesity/clusters');
    let passed = 0;
    mw(req({ headers: { referer: 'https://icc.lab/rubrik/replication', 'user-agent': 'Mozilla/5.0 Edge' } }), {}, () => { passed += 1; });
    expect(passed).toBe(1);                       // always forwards
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('/api/clusters');
    expect(lines[0]).toContain('page https://icc.lab/rubrik/replication');
    expect(lines[0]).toContain('from 10.0.0.9');
    expect(lines[0]).toContain('agent Mozilla/5.0 Edge');
  });

  it('logs once per caller, not once per request, and separates distinct callers', () => {
    const mw = deprecated('/api/alerts', '/api/cohesity/alerts');
    const a = { headers: { referer: 'https://icc.lab/ops', 'user-agent': 'Edge' } };
    const b = { headers: { 'user-agent': 'curl/8.4' } };
    mw(req(a), {}, () => {}); mw(req(a), {}, () => {}); mw(req(a), {}, () => {});
    expect(lines).toHaveLength(1);
    mw(req(b), {}, () => {});
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('agent curl/8.4');
  });

  it('survives a request with no headers at all', () => {
    const mw = deprecated('/api/metrics', '/api/cohesity/metrics');
    expect(() => mw({ method: 'GET', url: '/api/metrics' }, {}, () => {})).not.toThrow();
    expect(lines[0]).toContain('/api/metrics');
  });
});
