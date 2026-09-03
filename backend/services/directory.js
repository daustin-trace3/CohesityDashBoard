// Active Directory over LDAPS (2026-09-03).
//
// Design goal from Doug: the admin supplies a domain name and one approved
// account, and ICC works out the rest. So:
//   - domain controllers come from DNS SRV (_ldap._tcp.dc._msdcs.<domain>,
//     then _ldap._tcp.<domain>), an explicit server list only overrides;
//   - the base DN is derived from the domain (dc=corp,dc=example,dc=com) and
//     then confirmed against the RootDSE defaultNamingContext;
//   - the bind account may be typed as "user", "user@domain" or "DOMAIN\user";
//   - LDAPS on 636 is tried first, StartTLS on 389 second, unless pinned.
//
// Everything that talks to the wire goes through createClient() so the test
// suite can swap in an in-process LDAP server or a fake client.

const dns = require('dns').promises;
const { getSetting, setSetting, getSecretSetting, secretSource } = require('./settings');
const logger = require('../utils/logger');

const SETTING_KEYS = {
  enabled: 'ad_enabled',
  domain: 'ad_domain',
  bindUser: 'ad_bind_user',
  bindPassword: 'ad_bind_password',
  servers: 'ad_servers',
  baseDn: 'ad_base_dn',
  tlsMode: 'ad_tls_mode',
  tlsVerify: 'ad_tls_verify',
  caCert: 'ad_ca_cert',
  syncIntervalMinutes: 'ad_sync_interval_minutes',
  deactivateRemoved: 'ad_deactivate_removed',
};

const TLS_MODES = new Set(['auto', 'ldaps', 'starttls']);
const CONNECT_TIMEOUT_MS = 8000;
const OP_TIMEOUT_MS = 30000;
const PAGE_SIZE = 500;
// AD matching rule: transitive membership (nested groups resolved server-side).
const IN_CHAIN = '1.2.840.113556.1.4.1941';
const UAC_ACCOUNTDISABLE = 0x0002;

/* ----------------------------------------------------------------------- */
/* Config                                                                  */
/* ----------------------------------------------------------------------- */

function parseServers(raw) {
  return String(raw || '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function getConfig() {
  const domain = String(getSetting(SETTING_KEYS.domain) || '').trim().toLowerCase();
  const tlsMode = String(getSetting(SETTING_KEYS.tlsMode) || 'auto');
  return {
    enabled: getSetting(SETTING_KEYS.enabled) === '1',
    domain,
    bindUser: String(getSetting(SETTING_KEYS.bindUser) || ''),
    bindPasswordSource: secretSource(SETTING_KEYS.bindPassword, null),
    servers: parseServers(getSetting(SETTING_KEYS.servers)),
    baseDn: String(getSetting(SETTING_KEYS.baseDn) || ''),
    tlsMode: TLS_MODES.has(tlsMode) ? tlsMode : 'auto',
    tlsVerify: getSetting(SETTING_KEYS.tlsVerify) !== '0',
    caCert: String(getSetting(SETTING_KEYS.caCert) || ''),
    syncIntervalMinutes: Math.min(1440, Math.max(5, Number(getSetting(SETTING_KEYS.syncIntervalMinutes)) || 60)),
    deactivateRemoved: getSetting(SETTING_KEYS.deactivateRemoved) !== '0',
  };
}

function isEnabled() {
  const c = getConfig();
  return c.enabled && !!c.domain && !!c.bindUser && c.bindPasswordSource !== 'none';
}

function getBindPassword() {
  return getSecretSetting(SETTING_KEYS.bindPassword, null);
}

/* ----------------------------------------------------------------------- */
/* Pure helpers (unit-tested)                                              */
/* ----------------------------------------------------------------------- */

function domainToBaseDn(domain) {
  return String(domain || '')
    .trim()
    .toLowerCase()
    .split('.')
    .filter(Boolean)
    .map((p) => `dc=${p}`)
    .join(',');
}

/** "user" | "DOMAIN\user" | "user@domain" -> "user@domain" (UPN form AD binds accept). */
function toUpn(username, domain) {
  let u = String(username || '').trim();
  if (!u) return '';
  // A distinguished name binds as-is (some service accounts are given that way).
  if (/^[a-z]+=[^,]+,/i.test(u)) return u;
  if (u.includes('\\')) u = u.split('\\').pop();
  if (u.includes('@')) return u;
  return domain ? `${u}@${domain}` : u;
}

/** The bare account name, for the local users table and sAMAccountName lookups. */
function toSam(username) {
  let u = String(username || '').trim();
  if (u.includes('\\')) u = u.split('\\').pop();
  if (u.includes('@')) u = u.split('@')[0];
  return u;
}

/** Does this login look like it targets the domain (DOMAIN\x or x@domain)? */
function isDomainQualified(username, domain) {
  const u = String(username || '');
  if (u.includes('\\')) return true;
  if (u.includes('@')) {
    const suffix = u.split('@').pop().toLowerCase();
    return !domain || suffix === domain || domain.endsWith(`.${suffix}`) || suffix.endsWith(`.${domain}`);
  }
  return false;
}

/** objectGUID bytes -> canonical GUID string (AD's mixed-endian layout). */
function guidToString(buf) {
  if (!buf || buf.length !== 16) return null;
  const b = Buffer.from(buf);
  const hex = (i) => b[i].toString(16).padStart(2, '0');
  return [
    hex(3) + hex(2) + hex(1) + hex(0),
    hex(5) + hex(4),
    hex(7) + hex(6),
    hex(8) + hex(9),
    hex(10) + hex(11) + hex(12) + hex(13) + hex(14) + hex(15),
  ].join('-');
}

/** objectSid bytes -> "S-1-5-21-..." */
function sidToString(buf) {
  if (!buf || buf.length < 8) return null;
  const b = Buffer.from(buf);
  const revision = b[0];
  const count = b[1];
  const authority = b.readUIntBE(2, 6);
  const parts = [];
  for (let i = 0; i < count && 8 + i * 4 + 4 <= b.length; i++) parts.push(b.readUInt32LE(8 + i * 4));
  return `S-${revision}-${authority}${parts.length ? '-' + parts.join('-') : ''}`;
}

/** Escape a value for use inside an LDAP filter (RFC 4515). */
function escapeFilter(v) {
  return String(v).replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function attr(entry, name) {
  const v = entry?.[name];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

function entryToUser(e) {
  const uac = Number(attr(e, 'userAccountControl')) || 0;
  return {
    dn: e.dn,
    sam: String(attr(e, 'sAMAccountName') || ''),
    upn: String(attr(e, 'userPrincipalName') || ''),
    displayName: String(attr(e, 'displayName') || attr(e, 'cn') || attr(e, 'sAMAccountName') || ''),
    email: String(attr(e, 'mail') || ''),
    guid: guidToString(attr(e, 'objectGUID')),
    disabled: (uac & UAC_ACCOUNTDISABLE) !== 0,
  };
}

function entryToGroup(e) {
  return {
    dn: e.dn,
    name: String(attr(e, 'sAMAccountName') || attr(e, 'cn') || ''),
    cn: String(attr(e, 'cn') || ''),
    description: attr(e, 'description') ? String(attr(e, 'description')) : null,
    guid: guidToString(attr(e, 'objectGUID')),
    sid: sidToString(attr(e, 'objectSid')),
  };
}

/* ----------------------------------------------------------------------- */
/* Discovery                                                               */
/* ----------------------------------------------------------------------- */

let resolveSrv = (name) => dns.resolveSrv(name);

async function discoverServers(domain) {
  const names = [`_ldap._tcp.dc._msdcs.${domain}`, `_ldap._tcp.${domain}`];
  for (const name of names) {
    try {
      const recs = await resolveSrv(name);
      if (recs && recs.length) {
        return recs
          .sort((a, b) => a.priority - b.priority || b.weight - a.weight)
          .map((r) => r.name.replace(/\.$/, ''));
      }
    } catch { /* try the next record name */ }
  }
  return [];
}

/* ----------------------------------------------------------------------- */
/* Connections                                                             */
/* ----------------------------------------------------------------------- */

let clientFactory = null;

/** Tests inject a factory returning an object with the ldapts Client surface. */
function setClientFactory(fn) { clientFactory = fn; }

function createClient(url, tlsOptions) {
  if (clientFactory) return clientFactory(url, tlsOptions);
  const { Client } = require('ldapts');
  return new Client({ url, tlsOptions, connectTimeout: CONNECT_TIMEOUT_MS, timeout: OP_TIMEOUT_MS, strictDN: false });
}

function tlsOptionsFor(cfg, host) {
  const opts = { rejectUnauthorized: cfg.tlsVerify, servername: host };
  if (cfg.caCert) opts.ca = cfg.caCert;
  return opts;
}

/** Candidate (url, startTls) attempts in order, honoring the pinned TLS mode. */
function attemptsFor(cfg, host) {
  // An explicit scheme pins the transport for that server: ldaps://host
  // (TLS), starttls://host (STARTTLS on 389), ldap://host (PLAIN, lab use
  // only; passwords cross the wire unencrypted).
  const m = /^(ldaps|ldap|starttls):\/\/(.+)$/i.exec(host);
  if (m) {
    const scheme = m[1].toLowerCase();
    const rest = m[2];
    const hp = /:\d+$/.test(rest) ? rest : `${rest}:${scheme === 'ldaps' ? 636 : 389}`;
    const h = hp.split(':')[0];
    if (scheme === 'ldaps') return [{ url: `ldaps://${hp}`, startTls: false, host: h }];
    if (scheme === 'starttls') return [{ url: `ldap://${hp}`, startTls: true, host: h }];
    return [{ url: `ldap://${hp}`, startTls: false, host: h, plain: true }];
  }
  const bare = host;
  const hasPort = /:\d+$/.test(bare);
  const out = [];
  if (cfg.tlsMode !== 'starttls') out.push({ url: `ldaps://${hasPort ? bare : `${bare}:636`}`, startTls: false, host: bare.split(':')[0] });
  if (cfg.tlsMode !== 'ldaps') out.push({ url: `ldap://${hasPort ? bare : `${bare}:389`}`, startTls: true, host: bare.split(':')[0] });
  return out;
}

/**
 * Open a connection to the first reachable DC and bind. Returns
 * { client, server, url, startTls }. Caller unbinds.
 */
async function connect(cfg, bindDn, bindPassword) {
  const servers = cfg.servers.length ? cfg.servers : await discoverServers(cfg.domain);
  if (!servers.length) throw new Error(`No domain controllers found for ${cfg.domain}. Add DNS SRV records or list servers explicitly.`);
  const errors = [];
  for (const server of servers) {
    for (const a of attemptsFor(cfg, server)) {
      const client = createClient(a.url, tlsOptionsFor(cfg, a.host));
      try {
        if (a.startTls) await client.startTLS(tlsOptionsFor(cfg, a.host));
        await client.bind(bindDn, bindPassword);
        return { client, server, url: a.url, startTls: a.startTls };
      } catch (err) {
        errors.push(`${a.url}: ${err.message}`);
        try { await client.unbind(); } catch { /* ignore */ }
        // Wrong credentials are the same on every DC: stop instead of
        // locking the account out by retrying across the whole list.
        if (isInvalidCredentials(err)) {
          const e = new Error('Invalid credentials.');
          e.code = 'INVALID_CREDENTIALS';
          e.attempts = errors;
          throw e;
        }
      }
    }
  }
  const e = new Error(`Could not connect to any domain controller: ${errors.join(' | ')}`);
  e.code = 'UNREACHABLE';
  e.attempts = errors;
  throw e;
}

function isInvalidCredentials(err) {
  const name = err?.constructor?.name || '';
  const msg = String(err?.message || '');
  return name === 'InvalidCredentialsError' || /invalid credentials|data 52e|AcceptSecurityContext/i.test(msg) || err?.code === 49;
}

/** Bind with the service account, run fn(client, ctx), always unbind. */
async function withServiceClient(fn) {
  const cfg = getConfig();
  if (!cfg.domain) throw new Error('Directory is not configured: domain is missing.');
  const password = getBindPassword();
  if (!cfg.bindUser || !password) throw new Error('Directory is not configured: bind account is missing.');
  const conn = await connect(cfg, toUpn(cfg.bindUser, cfg.domain), password);
  try {
    const baseDn = cfg.baseDn || (await readDefaultNamingContext(conn.client)) || domainToBaseDn(cfg.domain);
    return await fn(conn.client, { ...conn, cfg, baseDn });
  } finally {
    try { await conn.client.unbind(); } catch { /* ignore */ }
  }
}

async function readDefaultNamingContext(client) {
  try {
    const { searchEntries } = await client.search('', { scope: 'base', filter: '(objectClass=*)', attributes: ['defaultNamingContext', 'dnsHostName', 'domainFunctionality'] });
    return attr(searchEntries?.[0], 'defaultNamingContext') || null;
  } catch {
    return null;
  }
}

async function searchAll(client, baseDn, filter, attributes) {
  const opts = { scope: 'sub', filter, attributes, paged: { pageSize: PAGE_SIZE }, explicitBufferAttributes: ['objectGUID', 'objectSid'] };
  const { searchEntries } = await client.search(baseDn, opts);
  return searchEntries || [];
}

/* ----------------------------------------------------------------------- */
/* Operations                                                              */
/* ----------------------------------------------------------------------- */

const USER_ATTRS = ['sAMAccountName', 'userPrincipalName', 'displayName', 'cn', 'mail', 'objectGUID', 'userAccountControl'];
const GROUP_ATTRS = ['sAMAccountName', 'cn', 'description', 'objectGUID', 'objectSid'];

/** Discover, connect, bind and read the RootDSE. Never throws on config; returns a report. */
async function testConnection() {
  const cfg = getConfig();
  const report = { ok: false, domain: cfg.domain, servers: [], baseDn: null, boundAs: null, url: null, error: null };
  try {
    report.servers = cfg.servers.length ? cfg.servers : await discoverServers(cfg.domain);
    await withServiceClient(async (client, ctx) => {
      report.url = ctx.url;
      report.baseDn = ctx.baseDn;
      report.boundAs = toUpn(cfg.bindUser, cfg.domain);
      const users = await searchAll(client, ctx.baseDn, '(&(objectCategory=person)(objectClass=user))', ['sAMAccountName']);
      report.userCount = users.length;
      report.ok = true;
    });
  } catch (err) {
    report.error = err.message;
    if (err.attempts) report.attempts = err.attempts;
  }
  return report;
}

async function searchGroups(query, limit = 50) {
  const q = escapeFilter(String(query || '').trim());
  const filter = q ? `(&(objectClass=group)(|(cn=*${q}*)(sAMAccountName=*${q}*)))` : '(objectClass=group)';
  return withServiceClient(async (client, ctx) => {
    const entries = await searchAll(client, ctx.baseDn, filter, GROUP_ATTRS);
    return entries.map(entryToGroup).sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit);
  });
}

async function getGroupByDn(dn) {
  return withServiceClient(async (client) => {
    const { searchEntries } = await client.search(dn, { scope: 'base', filter: '(objectClass=group)', attributes: GROUP_ATTRS, explicitBufferAttributes: ['objectGUID', 'objectSid'] });
    return searchEntries?.[0] ? entryToGroup(searchEntries[0]) : null;
  });
}

/** Members of a group, nested groups flattened by the DC. */
async function getGroupMembers(groupDn) {
  const filter = `(&(objectCategory=person)(objectClass=user)(memberOf:${IN_CHAIN}:=${escapeFilter(groupDn)}))`;
  return withServiceClient(async (client, ctx) => (await searchAll(client, ctx.baseDn, filter, USER_ATTRS)).map(entryToUser));
}

/** All group DNs a user belongs to, transitively. */
async function getUserGroupDns(client, baseDn, userDn) {
  const filter = `(&(objectClass=group)(member:${IN_CHAIN}:=${escapeFilter(userDn)}))`;
  return (await searchAll(client, baseDn, filter, ['distinguishedName'])).map((e) => e.dn);
}

async function findUser(client, baseDn, username, domain) {
  const sam = escapeFilter(toSam(username));
  const upn = escapeFilter(toUpn(username, domain));
  const filter = `(&(objectCategory=person)(objectClass=user)(|(sAMAccountName=${sam})(userPrincipalName=${upn})))`;
  const entries = await searchAll(client, baseDn, filter, USER_ATTRS);
  return entries[0] ? entryToUser(entries[0]) : null;
}

/**
 * Verify a domain login. Binds AS THE USER on a fresh connection (that is the
 * password check), then uses the service account to read the user record and
 * transitive group DNs. Returns null on bad credentials, throws on outage.
 */
async function authenticate(username, password) {
  const cfg = getConfig();
  if (!password) return null;
  const upn = toUpn(username, cfg.domain);
  let userConn;
  try {
    userConn = await connect(cfg, upn, password);
  } catch (err) {
    if (err.code === 'INVALID_CREDENTIALS') return null;
    throw err;
  }
  try { await userConn.client.unbind(); } catch { /* ignore */ }

  return withServiceClient(async (client, ctx) => {
    const user = await findUser(client, ctx.baseDn, username, cfg.domain);
    if (!user || user.disabled) return null;
    const groupDns = await getUserGroupDns(client, ctx.baseDn, user.dn);
    return { user, groupDns };
  });
}

/* ----------------------------------------------------------------------- */
/* Settings writes                                                         */
/* ----------------------------------------------------------------------- */

function saveConfig(body, encrypt) {
  const s = (v) => (v === undefined || v === null ? undefined : String(v));
  if (body.enabled !== undefined) setSetting(SETTING_KEYS.enabled, body.enabled ? '1' : '0');
  if (s(body.domain) !== undefined) setSetting(SETTING_KEYS.domain, s(body.domain).trim().toLowerCase());
  if (s(body.bindUser) !== undefined) setSetting(SETTING_KEYS.bindUser, s(body.bindUser).trim());
  if (s(body.bindPassword) !== undefined && s(body.bindPassword) !== '') setSetting(SETTING_KEYS.bindPassword, encrypt(s(body.bindPassword)));
  if (body.servers !== undefined) setSetting(SETTING_KEYS.servers, parseServers(Array.isArray(body.servers) ? body.servers.join(',') : body.servers).join(','));
  if (s(body.baseDn) !== undefined) setSetting(SETTING_KEYS.baseDn, s(body.baseDn).trim());
  if (s(body.tlsMode) !== undefined) setSetting(SETTING_KEYS.tlsMode, TLS_MODES.has(s(body.tlsMode)) ? s(body.tlsMode) : 'auto');
  if (body.tlsVerify !== undefined) setSetting(SETTING_KEYS.tlsVerify, body.tlsVerify ? '1' : '0');
  if (s(body.caCert) !== undefined) setSetting(SETTING_KEYS.caCert, s(body.caCert).trim());
  if (body.syncIntervalMinutes !== undefined) setSetting(SETTING_KEYS.syncIntervalMinutes, String(Math.min(1440, Math.max(5, Number(body.syncIntervalMinutes) || 60))));
  if (body.deactivateRemoved !== undefined) setSetting(SETTING_KEYS.deactivateRemoved, body.deactivateRemoved ? '1' : '0');
  logger.info('[directory] configuration updated');
  return getConfig();
}

module.exports = {
  SETTING_KEYS,
  getConfig,
  isEnabled,
  saveConfig,
  testConnection,
  searchGroups,
  getGroupByDn,
  getGroupMembers,
  authenticate,
  discoverServers,
  // pure helpers
  domainToBaseDn,
  toUpn,
  toSam,
  isDomainQualified,
  guidToString,
  sidToString,
  escapeFilter,
  // test seams
  setClientFactory,
  _setSrvResolver: (fn) => { resolveSrv = fn; },
};
