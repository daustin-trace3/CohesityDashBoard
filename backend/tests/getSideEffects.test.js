import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { platformPermission } = require('../middleware/requirePermission');

const perm = (method, path, query) => platformPermission('aws')({ method, path, query: query || {} });

describe('platformPermission', () => {
  it('maps plain reads to view and writes to manage', () => {
    expect(perm('GET', '/accounts')).toBe('aws:accounts:view');
    expect(perm('POST', '/accounts')).toBe('aws:accounts:manage');
    expect(perm('GET', '/')).toBe('aws:*:view');
  });

  it('treats GETs that act (probe, refresh=1) as manage', () => {
    expect(perm('GET', '/accounts/3/probe', { service: 'cost' })).toBe('aws:accounts:manage');
    expect(perm('GET', '/sources/2/probe/networks')).toBe('aws:sources:manage');
    expect(perm('GET', '/overview', { refresh: '1' })).toBe('aws:overview:manage');
    expect(perm('GET', '/overview', { refresh: '0' })).toBe('aws:overview:view');
    expect(perm('GET', '/probes-list')).toBe('aws:probes-list:view');
  });
});
