import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { platformPermission, sectionOf } = require('../middleware/requirePermission');

describe('platformPermission section derivation (rule B)', () => {
  const perm = platformPermission('fakens');
  it('uses the first path segment', () => {
    expect(perm({ path: '/interfaces/12', method: 'GET' })).toBe('fakens:interfaces:view');
    expect(perm({ path: '/interfaces', method: 'POST' })).toBe('fakens:interfaces:manage');
  });
  it('strips a trailing extension from the section', () => {
    expect(perm({ path: '/interfaces.csv', method: 'GET' })).toBe('fakens:interfaces:view');
    expect(perm({ path: '/export.json', method: 'GET' })).toBe('fakens:export:view');
  });
  it('falls back to * on an empty path', () => {
    expect(sectionOf('/')).toBe('*');
  });
  it('accepts a function namespace', () => {
    const p = platformPermission((req) => req.ns);
    expect(p({ ns: 'zz', path: '/a.csv', method: 'GET' })).toBe('zz:a:view');
  });
});
