/**
 * Entitlement resolution (C9.5): entitlementsFromPayloads() is pure over
 * already-decoded CDBL/CDBX payloads, and getEntitlements() wires it to the
 * real verified key/extension the same way getLicenseStatus() does.
 */
import crypto from 'crypto';
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { entitlementsFromPayloads, getEntitlements } = require('../services/license');

// Test-only keypair — mirrors the CDBL/CDBX envelope shape (does NOT need to
// verify against the vendor public key baked into license.js; these tests
// exercise entitlementsFromPayloads() directly with the decoded payloads).
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

function sign(type, payload) {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign(null, Buffer.from(payloadB64), privateKey).toString('base64url');
  return `${type}-${payloadB64}.${sig}`;
}

/** Round-trips a signed CDBL/CDBX string back into its payload object, the
 *  same way verifySigned() would after checking the signature. */
function decodePayload(signedStr) {
  const [, body] = signedStr.split('-');
  const [payloadB64] = body.split('.');
  return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
}

describe('entitlementsFromPayloads', () => {
  it('no ent field on the key payload → all platforms', () => {
    const key = decodePayload(sign('CDBL', { v: 1, id: 'lic1', exp: '2099-01-01' }));
    expect(entitlementsFromPayloads(key, null)).toEqual({ all: true });
  });

  it('empty ent array on the key payload → all platforms', () => {
    const key = decodePayload(sign('CDBL', { v: 1, id: 'lic1', exp: '2099-01-01', ent: [] }));
    expect(entitlementsFromPayloads(key, null)).toEqual({ all: true });
  });

  it('no payload at all → all platforms', () => {
    expect(entitlementsFromPayloads(null, null)).toEqual({ all: true });
  });

  it('key ent only, no extension → limited to key platforms', () => {
    const key = decodePayload(sign('CDBL', { v: 1, id: 'lic1', exp: '2099-01-01', ent: ['pure'] }));
    expect(entitlementsFromPayloads(key, null)).toEqual({ all: false, platforms: ['pure'] });
  });

  it('extension ent replaces the key ent', () => {
    const key = decodePayload(sign('CDBL', { v: 1, id: 'lic1', exp: '2099-01-01', ent: ['pure'] }));
    const ext = decodePayload(sign('CDBX', { v: 1, id: 'lic1', exp: '2100-01-01', ent: ['netapp', 'zerto'] }));
    expect(entitlementsFromPayloads(key, ext)).toEqual({ all: false, platforms: ['netapp', 'zerto'] });
  });

  it('extension without ent preserves the key ent', () => {
    const key = decodePayload(sign('CDBL', { v: 1, id: 'lic1', exp: '2099-01-01', ent: ['pure'] }));
    const ext = decodePayload(sign('CDBX', { v: 1, id: 'lic1', exp: '2100-01-01' }));
    expect(entitlementsFromPayloads(key, ext)).toEqual({ all: false, platforms: ['pure'] });
  });

  it('extension with empty ent falls back to the key ent', () => {
    const key = decodePayload(sign('CDBL', { v: 1, id: 'lic1', exp: '2099-01-01', ent: ['pure'] }));
    const ext = decodePayload(sign('CDBX', { v: 1, id: 'lic1', exp: '2100-01-01', ent: [] }));
    expect(entitlementsFromPayloads(key, ext)).toEqual({ all: false, platforms: ['pure'] });
  });

  it('publicKey is a valid Ed25519 key (sanity check on the test signer)', () => {
    expect(publicKey.asymmetricKeyType).toBe('ed25519');
  });
});

describe('getEntitlements', () => {
  it('returns {all:true} when LICENSE_KEY is unset', () => {
    expect(getEntitlements()).toEqual({ all: true });
  });
});
