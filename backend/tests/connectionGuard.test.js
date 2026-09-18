import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { changedTargetFields, assertSecretOnTargetChange, testTarget, notBlockedHost } = require('../utils/connectionGuard');
const { buildCoreApi } = require('../core/coreApi');

const stored = { host: 'vc01.corp.example', port: 443, ssl_verify: 1 };

describe('connectionGuard', () => {
  it('detects a changed target, ignoring case, whitespace, trailing slash and absent fields', () => {
    expect(changedTargetFields(stored, { host: ' VC01.corp.example/ ' }, ['host', 'port'])).toEqual([]);
    expect(changedTargetFields(stored, { host: 'evil.example' }, ['host', 'port'])).toEqual(['host']);
    expect(changedTargetFields(stored, { host: 'vc01.corp.example', port: 8443 }, ['host', 'port'])).toEqual(['port']);
    expect(changedTargetFields(stored, { name: 'renamed' }, ['host', 'port'])).toEqual([]);
    expect(changedTargetFields({ base_url: 'https://z.example' }, { baseUrl: 'https://evil.example' }, { baseUrl: 'base_url' })).toEqual(['baseUrl']);
  });

  it('a target change without a new secret is refused, with one it is allowed', () => {
    expect(() => assertSecretOnTargetChange({ stored, incoming: { host: 'evil.example' }, fields: ['host'], secretSupplied: false }))
      .toThrow(/again when changing the address/);
    try {
      assertSecretOnTargetChange({ stored, incoming: { host: 'evil.example' }, fields: ['host'], secretSupplied: false });
    } catch (err) {
      expect(err.status).toBe(400);
      expect(err.fields).toEqual(['host']);
    }
    expect(assertSecretOnTargetChange({ stored, incoming: { host: 'new.example' }, fields: ['host'], secretSupplied: true })).toEqual(['host']);
    expect(assertSecretOnTargetChange({ stored, incoming: { host: 'vc01.corp.example' }, fields: ['host'], secretSupplied: false })).toEqual([]);
  });

  it('a test that will use the saved secret dials the saved target, whatever the body says', () => {
    expect(testTarget({ stored, incoming: { host: 'evil.example', port: 22 }, fields: ['host', 'port'], secretSupplied: false }))
      .toEqual({ host: 'vc01.corp.example', port: 443 });
    expect(testTarget({ stored, incoming: { host: 'new.example' }, fields: ['host', 'port'], secretSupplied: true }))
      .toEqual({ host: 'new.example', port: 443 });
    expect(testTarget({ stored: null, incoming: { host: 'first.example', port: 443 }, fields: ['host', 'port'], secretSupplied: true }))
      .toEqual({ host: 'first.example', port: 443 });
  });

  it('notBlockedHost is an express-validator custom()', () => {
    expect(notBlockedHost('vc01.corp.example')).toBe(true);
    expect(notBlockedHost('')).toBe(true);
    expect(() => notBlockedHost('127.0.0.1')).toThrow();
    expect(() => notBlockedHost('https://169.254.169.254/latest')).toThrow();
  });
});

describe('coreApi surface handed to plugins', () => {
  it('exposes encrypt and decrypt but never the raw key', () => {
    const api = buildCoreApi({});
    expect(typeof api.encryption.encrypt).toBe('function');
    expect(typeof api.encryption.decrypt).toBe('function');
    expect(api.encryption.getKey).toBeUndefined();
    expect(Object.keys(api.encryption).sort()).toEqual(['decrypt', 'encrypt']);
  });

  it('exposes the connection guards as coreApi.net', () => {
    const api = buildCoreApi({});
    expect(api.net.isBlockedHost('localhost')).toBe(true);
    expect(api.net.isBlockedHost('10.1.2.3')).toBe(false);
    expect(typeof api.net.assertSecretOnTargetChange).toBe('function');
    expect(typeof api.net.testTarget).toBe('function');
  });
});
