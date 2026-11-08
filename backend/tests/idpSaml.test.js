/**
 * SAML 2.0 lane of the identity-provider feature (2026-11-06): a signed
 * Response built here with xml-crypto and a fixture key pair, validated through
 * services/idpSaml.js against the real idp_auth_state / idp_seen_assertions
 * tables. Covers identity mapping, tampering, InResponseTo state, replay,
 * IdP-initiated gating, metadata import and SP metadata.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const require = createRequire(import.meta.url);
const { SignedXml } = require('xml-crypto');

const KEY = fs.readFileSync(path.join(__dirname, 'fixtures', 'idp-saml-test-key.pem'), 'utf8');
const CERT = fs.readFileSync(path.join(__dirname, 'fixtures', 'idp-saml-test-cert.pem'), 'utf8');

const IDP = 'http://www.okta.com/exk-test';
const SSO = 'https://dev-1.okta.com/app/icc/exk-test/sso/saml';
const ACS = 'https://icc.test/api/auth/sso/okta-saml/acs';
const SP = 'https://icc.test/api/auth/sso/okta-saml/metadata';
const urls = { acsUrl: ACS, spEntityId: SP, metadataUrl: SP, redirectUri: '' };
const secretOf = () => '';

let db; let idpSaml; let idpProviders; let providerId; let stateStore;

function insertProvider(slug, extra = {}) {
  const now = new Date().toISOString();
  const row = {
    name: `Okta ${slug}`, slug, type: 'saml', enabled: 1, idp_entity_id: IDP, idp_sso_url: SSO, idp_cert_pem: CERT,
    sp_entity_id: SP, claim_subject: 'nameid', claim_email: 'email', claim_name: 'displayName', claim_groups: 'groups',
    want_assertions_signed: 1, allow_idp_initiated: 0, created_at: now, updated_at: now, ...extra,
  };
  const cols = Object.keys(row);
  const info = db.prepare(`INSERT INTO idp_providers (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(row));
  return info.lastInsertRowid;
}

function row() { return db.prepare('SELECT * FROM idp_providers WHERE id = ?').get(providerId); }

/** Sign the Assertion inside a Response and return the XML string. */
function buildResponse({ inResponseTo, nameId = 'alice@lab.test', groups = ['Backup Admins', 'Storage Viewers'], assertionId = `_a${crypto.randomBytes(8).toString('hex')}`, attrs = {} }) {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const irt = inResponseTo ? ` InResponseTo="${inResponseTo}"` : '';
  const attrXml = [
    ['groups', groups], ['displayName', ['Alice Anders']], ...Object.entries(attrs).map(([k, v]) => [k, [].concat(v)]),
  ].map(([n, vs]) => `<saml:Attribute Name="${n}">${vs.map((v) => `<saml:AttributeValue xsi:type="xs:string">${v}</saml:AttributeValue>`).join('')}</saml:Attribute>`).join('');
  const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ID="${assertionId}" IssueInstant="${iso(now)}" Version="2.0">`
    + `<saml:Issuer>${IDP}</saml:Issuer>`
    + `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml:NameID>`
    + `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${irt} NotOnOrAfter="${iso(now + 300000)}" Recipient="${ACS}"/></saml:SubjectConfirmation></saml:Subject>`
    + `<saml:Conditions NotBefore="${iso(now - 300000)}" NotOnOrAfter="${iso(now + 300000)}"><saml:AudienceRestriction><saml:Audience>${SP}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`
    + `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`
    + `<saml:AttributeStatement>${attrXml}</saml:AttributeStatement></saml:Assertion>`;
  const response = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${crypto.randomBytes(8).toString('hex')}" Version="2.0" IssueInstant="${iso(now)}" Destination="${ACS}"${irt}>`
    + `<saml:Issuer>${IDP}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${assertion}</samlp:Response>`;
  const sig = new SignedXml({
    privateKey: KEY, publicCert: CERT,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  });
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
  });
  sig.computeSignature(response, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
  return sig.getSignedXml();
}

const b64 = (xml) => Buffer.from(xml, 'utf8').toString('base64');

/** Start a login through the real shim; returns { stateId, requestId }. */
async function startLogin() {
  const stateId = idpProviders.createState({ providerId, kind: 'saml', returnTo: '/ops' });
  const url = await idpSaml.authorizeUrl(row(), urls, secretOf, stateStore, stateId);
  expect(url.startsWith(SSO)).toBe(true);
  expect(url).toContain('SAMLRequest=');
  const requestId = db.prepare('SELECT request_id FROM idp_auth_state WHERE id = ?').get(stateId).request_id;
  expect(requestId).toBeTruthy();
  return { stateId, requestId };
}

beforeAll(() => {
  db = require('../db/database');
  idpSaml = require('../services/idpSaml');
  idpProviders = require('../services/idpProviders');
  stateStore = { setRequestId: idpProviders.setStateRequestId, getByRequestId: idpProviders.getStateByRequestId, consume: idpProviders.consumeState };
  providerId = insertProvider('okta-saml');
});

describe('SP-initiated sign-in', () => {
  it('accepts a signed response and maps identity and groups', async () => {
    const { stateId, requestId } = await startLogin();
    const out = await idpSaml.validateAcs(row(), urls, secretOf, stateStore, { SAMLResponse: b64(buildResponse({ inResponseTo: requestId })), RelayState: stateId });
    expect(out.stateId).toBe(stateId);
    expect(out.state.return_to).toBe('/ops');
    expect(out.identity).toMatchObject({
      subject: 'alice@lab.test', email: 'alice@lab.test', displayName: 'Alice Anders', active: true,
      groups: ['Backup Admins', 'Storage Viewers'], groupIds: [],
    });
    expect(out.assertionId).toMatch(/^_a/);
    // the state row is gone: single use
    expect(db.prepare('SELECT 1 FROM idp_auth_state WHERE id = ?').get(stateId)).toBeUndefined();
  });

  it('a single group value arrives as a one-item array', async () => {
    const { stateId, requestId } = await startLogin();
    const out = await idpSaml.validateAcs(row(), urls, secretOf, stateStore, { SAMLResponse: b64(buildResponse({ inResponseTo: requestId, groups: ['Only One'] })), RelayState: stateId });
    expect(out.identity.groups).toEqual(['Only One']);
  });

  it('rejects a tampered assertion as sso_signature', async () => {
    const { stateId, requestId } = await startLogin();
    const xml = buildResponse({ inResponseTo: requestId }).replace('alice@lab.test', 'mallory@lab.test');
    let err;
    try { await idpSaml.validateAcs(row(), urls, secretOf, stateStore, { SAMLResponse: b64(xml), RelayState: stateId }); } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(idpSaml.errorCode(err)).toBe('sso_signature');
  });

  it('rejects a response answering a request ICC never made as sso_state', async () => {
    const { stateId } = await startLogin();
    let err;
    try { await idpSaml.validateAcs(row(), urls, secretOf, stateStore, { SAMLResponse: b64(buildResponse({ inResponseTo: '_neverIssued' })), RelayState: stateId }); } catch (e) { err = e; }
    expect(idpSaml.errorCode(err)).toBe('sso_state');
  });

  it('rejects a second use of the same request as sso_state (state consumed)', async () => {
    const { stateId, requestId } = await startLogin();
    const first = b64(buildResponse({ inResponseTo: requestId }));
    await idpSaml.validateAcs(row(), urls, secretOf, stateStore, { SAMLResponse: first, RelayState: stateId });
    let err;
    try { await idpSaml.validateAcs(row(), urls, secretOf, stateStore, { SAMLResponse: first, RelayState: stateId }); } catch (e) { err = e; }
    expect(idpSaml.errorCode(err)).toBe('sso_state');
  });

  it('rejects an expired state as sso_state', async () => {
    const { stateId, requestId } = await startLogin();
    db.prepare('UPDATE idp_auth_state SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), stateId);
    let err;
    try { await idpSaml.validateAcs(row(), urls, secretOf, stateStore, { SAMLResponse: b64(buildResponse({ inResponseTo: requestId })), RelayState: stateId }); } catch (e) { err = e; }
    expect(idpSaml.errorCode(err)).toBe('sso_state');
  });

  it('rejects a mismatched RelayState as sso_state', async () => {
    const { requestId } = await startLogin();
    let err;
    try { await idpSaml.validateAcs(row(), urls, secretOf, stateStore, { SAMLResponse: b64(buildResponse({ inResponseTo: requestId })), RelayState: 'someone-elses' }); } catch (e) { err = e; }
    expect(idpSaml.errorCode(err)).toBe('sso_state');
  });

  it('rejects garbage as sso_assertion', async () => {
    let err;
    try { await idpSaml.validateAcs(row(), urls, secretOf, stateStore, { SAMLResponse: b64('<nope/>') }); } catch (e) { err = e; }
    expect(['sso_assertion', 'sso_signature', 'sso_state']).toContain(idpSaml.errorCode(err));
    try { await idpSaml.validateAcs(row(), urls, secretOf, stateStore, {}); } catch (e) { err = e; }
    expect(idpSaml.errorCode(err)).toBe('sso_assertion');
  });
});

describe('IdP-initiated sign-in and replay', () => {
  it('is refused unless the provider allows it', async () => {
    let err;
    try { await idpSaml.validateAcs(row(), urls, secretOf, stateStore, { SAMLResponse: b64(buildResponse({})) }); } catch (e) { err = e; }
    expect(idpSaml.errorCode(err)).toBe('sso_state');
  });

  it('is accepted when allowed, lands without a state, and a second copy is sso_replay', async () => {
    const id = insertProvider('okta-idpinit', { allow_idp_initiated: 1 });
    const r = () => db.prepare('SELECT * FROM idp_providers WHERE id = ?').get(id);
    const xml = b64(buildResponse({ assertionId: '_replaytest1' }));
    const out = await idpSaml.validateAcs(r(), urls, secretOf, stateStore, { SAMLResponse: xml });
    expect(out.stateId).toBeNull();
    expect(out.identity.subject).toBe('alice@lab.test');
    let err;
    try { await idpSaml.validateAcs(r(), urls, secretOf, stateStore, { SAMLResponse: xml }); } catch (e) { err = e; }
    expect(idpSaml.errorCode(err)).toBe('sso_replay');
    expect(db.prepare('SELECT COUNT(*) c FROM idp_seen_assertions').get().c).toBeGreaterThan(0);
  });
});

describe('mapIdentity', () => {
  const base = { claim_subject: 'nameid', claim_email: 'email', claim_name: 'displayName', claim_groups: 'groups' };
  it('uses the nameid, falls back to nameid as email for the email format, splits nothing', () => {
    const id = idpSaml.mapIdentity(base, { nameID: 'bob@x.test', nameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress', groups: 'Solo' });
    expect(id).toMatchObject({ subject: 'bob@x.test', email: 'bob@x.test', groups: ['Solo'], username: null });
  });
  it('reads an attribute subject and first/last name when no display name is sent', () => {
    const id = idpSaml.mapIdentity({ ...base, claim_subject: 'userId' }, { nameID: 'n', userId: '00u123', email: 'c@x.test', firstName: 'Cy', lastName: 'Lee', groups: ['A', 'B'] });
    expect(id).toMatchObject({ subject: '00u123', displayName: 'Cy Lee', groups: ['A', 'B'] });
  });
  it('errorCode maps node-saml messages', () => {
    expect(idpSaml.errorCode(new Error('Invalid signature'))).toBe('sso_signature');
    expect(idpSaml.errorCode(new Error('InResponseTo is not valid'))).toBe('sso_state');
    expect(idpSaml.errorCode(new Error('something else'))).toBe('sso_assertion');
    expect(idpSaml.errorCode(Object.assign(new Error('x'), { sso: 'sso_replay' }))).toBe('sso_replay');
  });
});

describe('metadata', () => {
  const MD = `<?xml version="1.0"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${IDP}"><md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">`
    + `<md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${CERT.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`
    + `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://post.example/sso"/>`
    + `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${SSO}"/>`
    + `</md:IDPSSODescriptor></md:EntityDescriptor>`;

  it('imports entity id, the redirect SSO URL and the signing certificate', () => {
    const out = idpSaml.importMetadata(MD);
    expect(out.entityId).toBe(IDP);
    expect(out.ssoUrl).toBe(SSO);
    expect(out.certPem).toContain('BEGIN CERTIFICATE');
    expect(new crypto.X509Certificate(out.certPem).subject).toContain('icc-saml-test');
  });
  it('rejects non-metadata with status 400', () => {
    let err;
    try { idpSaml.importMetadata('<a/>'); } catch (e) { err = e; }
    expect(err.status).toBe(400);
    expect(err.error).toMatch(/EntityDescriptor/);
  });
  it('SP metadata carries the ACS URL and entity id', () => {
    const xml = idpSaml.spMetadata(row(), urls, secretOf);
    expect(xml).toContain(ACS);
    expect(xml).toContain(SP);
  });
  it('testProvider checks the cert, the https SSO URL and a metadata URL through the injected http', async () => {
    const ok = await idpSaml.testProvider({ ...row(), idp_metadata_url: 'https://md.example/m.xml' }, async () => ({ status: 200, data: MD }));
    expect(ok.ok).toBe(true);
    expect(ok.checks.map((c) => c.name)).toEqual(['Entity ID', 'SSO URL', 'Signing certificate', 'Metadata URL']);
    const bad = await idpSaml.testProvider({ ...row(), idp_sso_url: 'http://insecure.example/sso', idp_cert_pem: 'garbage' }, null);
    expect(bad.ok).toBe(false);
    expect(bad.checks.filter((c) => !c.ok).map((c) => c.name).sort()).toEqual(['SSO URL', 'Signing certificate']);
  });
});
