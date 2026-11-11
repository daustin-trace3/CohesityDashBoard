// SAML 2.0 service-provider side of the identity-provider lane (2026-11-06,
// IDP-CONTRACT section 5). node-saml does the XML signature, conditions and
// InResponseTo work; this module owns: the cache shim that ties a request id
// to a state row, assertion replay protection, identity mapping, SP metadata,
// IdP metadata import and the connection test. The HTTP side (urlencoded body,
// redirects, error codes in the query string) lives in routes/authSso.js.

const crypto = require('crypto');
const { SAML, ValidateInResponseTo } = require('@node-saml/node-saml');
const { XMLParser } = require('fast-xml-parser');
const db = require('../db/adminDb');

const NAMEID_EMAIL = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';

function ssoError(code, message, status = 400) {
  const err = new Error(message || code);
  err.sso = code;
  err.status = status;
  return err;
}

/** Map any error raised while validating a response to a login error code. */
function errorCode(err) {
  if (err && err.sso) return err.sso;
  const msg = String((err && err.message) || err || '');
  if (/already been received|replay/i.test(msg)) return 'sso_replay';
  if (/InResponseTo/i.test(msg)) return 'sso_state';
  if (/signature/i.test(msg)) return 'sso_signature';
  return 'sso_assertion';
}

function pemBody(pem) {
  return String(pem || '')
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\s+/g, '');
}

function toPem(b64, label = 'CERTIFICATE') {
  const body = pemBody(b64);
  if (!body) return '';
  return `-----BEGIN ${label}-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
}

/**
 * Wrap the router's state store as a node-saml cacheProvider. The request id
 * node-saml generates is saved onto the state row created BEFORE authorizeUrl
 * (ctx.currentStateId). On the way back, a request id is valid only while an
 * unexpired state row carries it, and consuming deletes the row (single use).
 * ctx.consumed keeps the row that was consumed, so validateAcs can return it.
 */
function cacheShim(stateStore, ctx) {
  return {
    async saveAsync(key, value) {
      if (ctx.currentStateId) stateStore.setRequestId(ctx.currentStateId, key);
      return { value: String(value), createdAt: Date.now() };
    },
    async getAsync(key) {
      // node-saml reads the value as the instant the request was issued and
      // checks it against requestIdExpirationPeriodMs.
      const row = stateStore.getByRequestId(key);
      return row ? String(row.created_at) : null;
    },
    async removeAsync(key) {
      const row = stateStore.getByRequestId(key);
      if (!row) return null;
      const gone = stateStore.consume(row.id);
      if (gone) ctx.consumed = gone;
      return gone ? String(gone.id) : null;
    },
    async consumeAsync(key) {
      const row = stateStore.getByRequestId(key);
      if (!row) return null;
      const gone = stateStore.consume(row.id);
      if (!gone) return null;
      ctx.consumed = gone;
      return String(gone.id);
    },
  };
}

/** Configured node-saml instance. ctx = { currentStateId?, consumed? } is optional. */
function buildSaml(row, urls, secretOf, stateStore, ctx = {}) {
  const key = row.sp_key_pem ? (secretOf ? secretOf(row, 'sp_key_pem') : '') : '';
  const opts = {
    callbackUrl: urls.acsUrl,
    issuer: urls.spEntityId,
    entryPoint: row.idp_sso_url,
    idpCert: pemBody(row.idp_cert_pem),
    idpIssuer: row.idp_entity_id || undefined,
    audience: urls.spEntityId,
    wantAssertionsSigned: !!row.want_assertions_signed,
    wantAuthnResponseSigned: false,
    identifierFormat: NAMEID_EMAIL,
    acceptedClockSkewMs: 60000,
    disableRequestedAuthnContext: true,
    authnRequestBinding: 'HTTP-Redirect',
    validateInResponseTo: row.allow_idp_initiated ? ValidateInResponseTo.ifPresent : ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: 10 * 60 * 1000,
    cacheProvider: cacheShim(stateStore, ctx),
  };
  if (key) opts.privateKey = key;
  return new SAML(opts);
}

async function authorizeUrl(row, urls, secretOf, stateStore, relayState) {
  const ctx = { currentStateId: relayState };
  const saml = buildSaml(row, urls, secretOf, stateStore, ctx);
  return saml.getAuthorizeUrlAsync(relayState, undefined, {});
}

function attr(profile, name) {
  if (!name) return undefined;
  if (profile[name] !== undefined) return profile[name];
  const lower = String(name).toLowerCase();
  const k = Object.keys(profile).find((x) => x.toLowerCase() === lower);
  return k ? profile[k] : undefined;
}

function first(v) {
  if (Array.isArray(v)) return v.length ? first(v[0]) : undefined;
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'object') return v._ !== undefined ? String(v._) : undefined;
  const s = String(v).trim();
  return s || undefined;
}

function list(v) {
  if (v === undefined || v === null) return [];
  const arr = Array.isArray(v) ? v : [v];
  const out = [];
  for (const x of arr) {
    const s = typeof x === 'object' && x !== null ? (x._ !== undefined ? String(x._) : '') : String(x);
    const t = s.trim();
    if (t) out.push(t);
  }
  return out;
}

function mapIdentity(row, profile) {
  const subjectClaim = String(row.claim_subject || 'nameid');
  const subject = subjectClaim.toLowerCase() === 'nameid' ? first(profile.nameID) : first(attr(profile, subjectClaim));
  let email = first(attr(profile, row.claim_email)) || first(profile.email) || first(profile.mail);
  if (!email && profile.nameIDFormat === NAMEID_EMAIL) email = first(profile.nameID);
  const given = first(attr(profile, 'firstName')) || first(attr(profile, 'givenName'));
  const family = first(attr(profile, 'lastName')) || first(attr(profile, 'surname'));
  const displayName = first(attr(profile, row.claim_name)) || `${given || ''} ${family || ''}`.trim() || null;
  const username = first(attr(profile, 'login')) || first(attr(profile, 'username')) || first(attr(profile, 'preferred_username')) || null;
  return {
    subject: subject || null,
    email: email || null,
    username,
    displayName,
    groups: list(attr(profile, row.claim_groups)),
    groupIds: [],
    active: true,
  };
}

function assertionFacts(profile) {
  let xml = '';
  try { xml = profile.getAssertionXml ? profile.getAssertionXml() : ''; } catch { xml = ''; }
  const idm = /<(?:[\w-]+:)?Assertion\b[^>]*?\sID="([^"]+)"/.exec(xml);
  const nm = /<(?:[\w-]+:)?Conditions\b[^>]*?\sNotOnOrAfter="([^"]+)"/.exec(xml)
    || /<(?:[\w-]+:)?SubjectConfirmationData\b[^>]*?\sNotOnOrAfter="([^"]+)"/.exec(xml);
  return { id: idm ? idm[1] : null, notOnOrAfter: nm ? Date.parse(nm[1]) : NaN };
}

/** First sighting of an assertion id wins; a second sighting is a replay. */
function recordAssertion(providerId, assertionId, notOnOrAfterMs) {
  const base = Number.isFinite(notOnOrAfterMs) ? notOnOrAfterMs + 60000 : Date.now() + 10 * 60000;
  const expires = new Date(base).toISOString();
  const res = db.prepare('INSERT OR IGNORE INTO idp_seen_assertions (assertion_id, provider_id, expires_at) VALUES (?, ?, ?)')
    .run(`${providerId}:${assertionId}`, providerId, expires);
  return res.changes === 1;
}

/**
 * Validate a POSTed SAML response. Returns { identity, stateId, assertionId, state }.
 * stateId/state are null for an IdP-initiated response (allowed only when the
 * provider has allow_idp_initiated). Throws an Error with .sso set.
 */
async function validateAcs(row, urls, secretOf, stateStore, body) {
  const samlResponse = body && body.SAMLResponse;
  if (!samlResponse || typeof samlResponse !== 'string') throw ssoError('sso_assertion', 'SAMLResponse is missing');
  const ctx = {};
  const saml = buildSaml(row, urls, secretOf, stateStore, ctx);
  let result;
  try {
    result = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse, RelayState: body.RelayState });
  } catch (err) {
    const wrapped = new Error(err && err.message ? err.message : 'SAML validation failed');
    wrapped.sso = errorCode(err);
    wrapped.cause = err;
    throw wrapped;
  }
  const profile = result && result.profile;
  if (!profile || result.loggedOut) throw ssoError('sso_assertion', 'SAML response carried no login assertion');

  const state = ctx.consumed || null;
  if (state) {
    if (Number(state.provider_id) !== Number(row.id) || state.kind !== 'saml') throw ssoError('sso_state', 'State belongs to another provider');
    if (body.RelayState && String(body.RelayState) !== String(state.id)) throw ssoError('sso_state', 'RelayState does not match the request');
  } else if (!row.allow_idp_initiated) {
    throw ssoError('sso_state', 'IdP-initiated sign-in is not allowed for this provider');
  }

  const facts = assertionFacts(profile);
  const assertionId = facts.id || profile.ID || null;
  if (!assertionId) throw ssoError('sso_assertion', 'Assertion has no ID');
  if (!recordAssertion(row.id, assertionId, facts.notOnOrAfter)) throw ssoError('sso_replay', `Assertion ${assertionId} was already used`);

  const identity = mapIdentity(row, profile);
  if (!identity.subject) throw ssoError('sso_assertion', `Assertion has no value for ${row.claim_subject || 'nameid'}`);
  return { identity, stateId: state ? state.id : null, assertionId, state };
}

function spMetadata(row, urls, secretOf) {
  const saml = buildSaml(row, urls, secretOf, { setRequestId() {}, getByRequestId() { return null; }, consume() { return null; } });
  const cert = row.sp_cert_pem ? pemBody(row.sp_cert_pem) : null;
  return saml.generateServiceProviderMetadata(null, cert);
}

/** Parse IdP metadata XML. Throws { status: 400, error } on failure. */
function importMetadata(xml) {
  const bad = (msg) => Object.assign(new Error(msg), { status: 400, error: msg });
  if (!xml || typeof xml !== 'string') throw bad('Metadata XML is empty.');
  let doc;
  try {
    doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, parseTagValue: false }).parse(xml);
  } catch (e) {
    throw bad(`Metadata is not valid XML: ${e.message}`);
  }
  let ed = doc && doc.EntityDescriptor;
  if (!ed && doc && doc.EntitiesDescriptor) {
    const e = doc.EntitiesDescriptor.EntityDescriptor;
    ed = Array.isArray(e) ? e[0] : e;
  }
  if (!ed) throw bad('No EntityDescriptor found in the metadata.');
  const entityId = ed['@_entityID'];
  let idp = ed.IDPSSODescriptor;
  if (Array.isArray(idp)) idp = idp[0];
  if (!idp) throw bad('The metadata has no IDPSSODescriptor.');
  const sso = [].concat(idp.SingleSignOnService || []);
  if (!sso.length) throw bad('The metadata has no SingleSignOnService.');
  const redirect = sso.find((s) => /HTTP-Redirect$/.test(String(s['@_Binding'] || ''))) || sso[0];
  const ssoUrl = redirect['@_Location'];
  const keys = [].concat(idp.KeyDescriptor || []);
  const signing = keys.find((k) => !k['@_use'] || k['@_use'] === 'signing') || keys[0];
  let certRaw = signing && signing.KeyInfo && signing.KeyInfo.X509Data;
  if (Array.isArray(certRaw)) certRaw = certRaw[0];
  let cert = certRaw && certRaw.X509Certificate;
  if (Array.isArray(cert)) cert = cert[0];
  if (!entityId || !ssoUrl) throw bad('The metadata has no entityID or SSO location.');
  if (!cert) throw bad('The metadata has no signing certificate.');
  return { entityId, ssoUrl, certPem: toPem(String(cert)) };
}

async function testProvider(row, http) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  add('Entity ID', !!row.idp_entity_id, row.idp_entity_id || 'IdP entity ID is empty');
  let ssoOk = false;
  try {
    const u = new URL(row.idp_sso_url);
    ssoOk = u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname));
  } catch { ssoOk = false; }
  add('SSO URL', ssoOk, row.idp_sso_url ? (ssoOk ? row.idp_sso_url : 'SSO URL must be https://') : 'SSO URL is empty');
  try {
    const x = new crypto.X509Certificate(toPem(row.idp_cert_pem));
    const expired = new Date(x.validTo).getTime() < Date.now();
    add('Signing certificate', !expired, `${x.subject.replace(/\n/g, ', ')}; valid to ${x.validTo}${expired ? ' (EXPIRED)' : ''}`);
  } catch (e) {
    add('Signing certificate', false, `Certificate does not parse: ${e.message}`);
  }
  if (row.idp_metadata_url && http) {
    try {
      const res = await http({ method: 'GET', url: row.idp_metadata_url, headers: { Accept: 'application/xml' }, timeout: 10000 });
      if (res.status < 200 || res.status >= 300) {
        add('Metadata URL', false, `HTTP ${res.status}`);
      } else {
        const m = importMetadata(typeof res.data === 'string' ? res.data : String(res.data));
        add('Metadata URL', true, `Parsed; entity ${m.entityId}`);
      }
    } catch (e) {
      add('Metadata URL', false, e.message);
    }
  }
  return { ok: checks.every((c) => c.ok), checks };
}

module.exports = { buildSaml, authorizeUrl, validateAcs, spMetadata, importMetadata, testProvider, mapIdentity, errorCode, pemBody, toPem };
