/**
 * Active Directory integration (2026-09-03): pure helpers, connection and
 * search logic through the client-factory seam against a small fake AD
 * (UPN / DOMAIN\sam / DN binds, RootDSE, nested-group matching rule,
 * objectGUID buffers, disabled accounts), the sync into users/user_groups,
 * and the login route's directory path. The ldapts wire itself is exercised
 * only against a real domain (Doug's lab), not here.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);

const BASE = 'dc=lab,dc=test';
const DOMAIN = 'lab.test';
const guid = (n) => Buffer.from(n.toString(16).padStart(32, '0'), 'hex');

// svc (bind account), alice in Backup Admins, bob in a nested group under
// Backup Admins, carol in Storage Viewers only, dave disabled.
const ENTRIES = [
  { dn: `cn=svc,ou=service,${BASE}`, password: 'svc-pw', attrs: { objectClass: ['user'], objectCategory: 'person', sAMAccountName: 'svc', userPrincipalName: `svc@${DOMAIN}`, displayName: 'Service Account', objectGUID: guid(1), userAccountControl: '512' } },
  { dn: `cn=alice,ou=people,${BASE}`, password: 'alice-pw', attrs: { objectClass: ['user'], objectCategory: 'person', sAMAccountName: 'alice', userPrincipalName: `alice@${DOMAIN}`, displayName: 'Alice Anders', mail: 'alice@lab.test', objectGUID: guid(2), userAccountControl: '512' } },
  { dn: `cn=bob,ou=people,${BASE}`, password: 'bob-pw', attrs: { objectClass: ['user'], objectCategory: 'person', sAMAccountName: 'bob', userPrincipalName: `bob@${DOMAIN}`, displayName: 'Bob Brown', objectGUID: guid(3), userAccountControl: '512' } },
  { dn: `cn=carol,ou=people,${BASE}`, password: 'carol-pw', attrs: { objectClass: ['user'], objectCategory: 'person', sAMAccountName: 'carol', userPrincipalName: `carol@${DOMAIN}`, displayName: 'Carol Chen', objectGUID: guid(4), userAccountControl: '512' } },
  { dn: `cn=dave,ou=people,${BASE}`, password: 'dave-pw', attrs: { objectClass: ['user'], objectCategory: 'person', sAMAccountName: 'dave', userPrincipalName: `dave@${DOMAIN}`, displayName: 'Dave Disabled', objectGUID: guid(5), userAccountControl: '514' } },
  { dn: `cn=Backup Admins,ou=groups,${BASE}`, attrs: { objectClass: ['group'], sAMAccountName: 'Backup Admins', cn: 'Backup Admins', description: 'Backup operators', objectGUID: guid(10), member: [`cn=alice,ou=people,${BASE}`, `cn=Backup Tier2,ou=groups,${BASE}`, `cn=dave,ou=people,${BASE}`] } },
  { dn: `cn=Backup Tier2,ou=groups,${BASE}`, attrs: { objectClass: ['group'], sAMAccountName: 'Backup Tier2', cn: 'Backup Tier2', objectGUID: guid(11), member: [`cn=bob,ou=people,${BASE}`] } },
  { dn: `cn=Storage Viewers,ou=groups,${BASE}`, attrs: { objectClass: ['group'], sAMAccountName: 'Storage Viewers', cn: 'Storage Viewers', objectGUID: guid(12), member: [`cn=carol,ou=people,${BASE}`] } },
];
const norm = (dn) => String(dn).replace(/\s*,\s*/g, ',').toLowerCase();
const byDn = new Map(ENTRIES.map((e) => [norm(e.dn), e]));

// Transitive membership, the way AD's 1.2.840.113556.1.4.1941 rule resolves it.
function groupsOf(userDn, acc = new Set()) {
  for (const e of ENTRIES) {
    if (!e.attrs.objectClass.includes('group')) continue;
    if ((e.attrs.member || []).some((m) => norm(m) === norm(userDn)) && !acc.has(e.dn)) {
      acc.add(e.dn);
      groupsOf(e.dn, acc);
    }
  }
  return acc;
}

// Minimal RFC 4515 filter parser covering the shapes services/directory.js emits.
function unescape(v) { return v.replace(/\\([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))); }
function parseFilter(s) {
  let i = 0;
  function node() {
    if (s[i] !== '(') throw new Error(`bad filter at ${i}: ${s}`);
    i++;
    let out;
    if (s[i] === '&' || s[i] === '|') {
      const op = s[i++]; const kids = [];
      while (s[i] === '(') kids.push(node());
      out = { op, kids };
    } else if (s[i] === '!') {
      i++; out = { op: '!', kids: [node()] };
    } else {
      let j = i; while (s[j] !== ')') j++;
      const body = s.slice(i, j); i = j;
      const m = /^([^=:]+)(?::([\d.]+))?:?=(.*)$/.exec(body);
      out = { op: 'cmp', attr: m[1], rule: m[2] || null, value: m[3] };
    }
    if (s[i] !== ')') throw new Error(`expected ) at ${i}: ${s}`);
    i++;
    return out;
  }
  return node();
}
function matches(f, e) {
  if (f.op === '&') return f.kids.every((k) => matches(k, e));
  if (f.op === '|') return f.kids.some((k) => matches(k, e));
  if (f.op === '!') return !matches(f.kids[0], e);
  const a = f.attr.toLowerCase();
  if (f.rule === '1.2.840.113556.1.4.1941') {
    const target = unescape(f.value);
    if (a === 'memberof') return groupsOf(e.dn).has(byDn.get(norm(target))?.dn);
    if (a === 'member') return groupsOf(target).has(e.dn);
    return false;
  }
  const key = Object.keys(e.attrs).find((k) => k.toLowerCase() === a);
  const vals = key ? [].concat(e.attrs[key]).map((v) => (Buffer.isBuffer(v) ? v.toString('hex') : String(v))) : [];
  if (f.value === '*') return vals.length > 0;
  if (f.value.includes('*')) {
    const re = new RegExp('^' + f.value.split('*').map((p) => unescape(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
    return vals.some((v) => re.test(v));
  }
  return vals.some((v) => v.toLowerCase() === unescape(f.value).toLowerCase());
}

/** A fake ldapts Client: one per connection attempt, keyed by URL. */
const wire = { binds: [], urls: [] };
class FakeClient {
  constructor(url) { this.url = url; this.bound = null; wire.urls.push(url); }
  async startTLS() { /* accepted */ }
  async bind(dn, password) {
    if (this.url.includes(':1')) { const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e; }
    const key = norm(dn);
    const e = byDn.get(key) || ENTRIES.find((x) => x.attrs.userPrincipalName?.toLowerCase() === key || `lab\\${x.attrs.sAMAccountName}`.toLowerCase() === key);
    wire.binds.push(dn);
    if (!e || e.password !== password) {
      const err = new Error('Invalid Credentials');
      err.code = 49;
      throw err;
    }
    this.bound = e.dn;
  }
  async search(base, opts) {
    if (!this.bound) throw new Error('not bound');
    const b = norm(base);
    const scope = opts.scope || 'sub';
    if (b === '' && scope === 'base') return { searchEntries: [{ dn: '', defaultNamingContext: BASE, dnsHostName: `dc1.${DOMAIN}` }] };
    const f = parseFilter(opts.filter);
    const searchEntries = [];
    for (const e of ENTRIES) {
      const inScope = scope === 'base' ? norm(e.dn) === b : norm(e.dn).endsWith(b);
      if (!inScope || !matches(f, e)) continue;
      const out = { dn: e.dn };
      for (const [k, v] of Object.entries(e.attrs)) out[k] = Array.isArray(v) && v.length === 1 ? v[0] : v;
      searchEntries.push(out);
    }
    return { searchEntries };
  }
  async unbind() { this.bound = null; }
}

let db; let directory; let directorySync; let encryption;

beforeAll(() => {
  db = require('../db/database');
  directory = require('../services/directory');
  directorySync = require('../services/directorySync');
  encryption = require('../services/encryption');
  directory.setClientFactory((url) => new FakeClient(url));
  directory._setSrvResolver(async (name) => (name.startsWith('_ldap._tcp.dc._msdcs.') ? [{ name: 'dc1.lab.test.', port: 389, priority: 0, weight: 100 }, { name: 'dc2.lab.test.', port: 389, priority: 10, weight: 100 }] : []));
  directory.saveConfig({
    enabled: true, domain: DOMAIN, bindUser: 'svc', bindPassword: 'svc-pw',
    servers: [], tlsMode: 'auto', tlsVerify: false, syncIntervalMinutes: 60, deactivateRemoved: true,
  }, encryption.encrypt);
});

describe('pure helpers', () => {
  it('derives a base DN from the domain', () => {
    expect(directory.domainToBaseDn('Corp.Example.COM')).toBe('dc=corp,dc=example,dc=com');
  });
  it('normalizes bind and login names to UPN / sam', () => {
    expect(directory.toUpn('bob', 'lab.test')).toBe('bob@lab.test');
    expect(directory.toUpn('LAB\\bob', 'lab.test')).toBe('bob@lab.test');
    expect(directory.toUpn('bob@other.test', 'lab.test')).toBe('bob@other.test');
    expect(directory.toUpn('cn=svc,dc=lab,dc=test', 'lab.test')).toBe('cn=svc,dc=lab,dc=test');
    expect(directory.toSam('LAB\\bob')).toBe('bob');
    expect(directory.toSam('bob@lab.test')).toBe('bob');
  });
  it('decodes objectGUID and objectSid buffers', () => {
    expect(directory.guidToString(Buffer.from('00112233445566778899aabbccddeeff', 'hex'))).toBe('33221100-5544-7766-8899-aabbccddeeff');
    const sid = Buffer.concat([Buffer.from([1, 2, 0, 0, 0, 0, 0, 5]), Buffer.from([21, 0, 0, 0]), Buffer.from([0x39, 0x30, 0, 0])]);
    expect(directory.sidToString(sid)).toBe('S-1-5-21-12345');
  });
  it('escapes filter metacharacters', () => {
    expect(directory.escapeFilter('a*b(c)\\d')).toBe('a\\2ab\\28c\\29\\5cd');
  });
  it('discovers DCs from SRV records in priority order', async () => {
    expect(await directory.discoverServers('lab.test')).toEqual(['dc1.lab.test', 'dc2.lab.test']);
  });
});

describe('directory operations through the client seam', () => {
  it('testConnection discovers DCs, tries LDAPS first, binds as UPN, reads the RootDSE base DN', async () => {
    wire.urls.length = 0; wire.binds.length = 0;
    const r = await directory.testConnection();
    expect(r.ok).toBe(true);
    expect(r.servers).toEqual(['dc1.lab.test', 'dc2.lab.test']);
    expect(r.url).toBe('ldaps://dc1.lab.test:636');
    expect(r.baseDn).toBe(BASE);
    expect(r.boundAs).toBe('svc@lab.test');
    expect(wire.binds[0]).toBe('svc@lab.test');
    expect(r.userCount).toBe(5);
  });
  it('an explicit server list overrides discovery and a scheme pins the transport', async () => {
    directory.saveConfig({ servers: ['starttls://dc9.lab.test'] }, encryption.encrypt);
    wire.urls.length = 0;
    const r = await directory.testConnection();
    expect(r.ok).toBe(true);
    expect(r.url).toBe('ldap://dc9.lab.test:389');
    directory.saveConfig({ servers: [] }, encryption.encrypt);
  });
  it('searches groups by fragment and reads nested members', async () => {
    const groups = await directory.searchGroups('backup');
    expect(groups.map((g) => g.name).sort()).toEqual(['Backup Admins', 'Backup Tier2']);
    expect(groups[0].guid).toMatch(/^[0-9a-f-]{36}$/);
    const members = await directory.getGroupMembers(`cn=Backup Admins,ou=groups,${BASE}`);
    expect(members.map((m) => m.sam).sort()).toEqual(['alice', 'bob', 'dave']);
    expect(members.find((m) => m.sam === 'dave').disabled).toBe(true);
  });
  it('authenticates a domain user in every username form and rejects bad passwords', async () => {
    for (const name of ['alice', 'alice@lab.test', 'LAB\\alice']) {
      const r = await directory.authenticate(name, 'alice-pw');
      expect(r?.user.sam).toBe('alice');
      expect(r.groupDns).toContain(`cn=Backup Admins,ou=groups,${BASE}`);
    }
    expect(await directory.authenticate('alice', 'wrong')).toBeNull();
    expect(await directory.authenticate('alice', '')).toBeNull();
    expect(await directory.authenticate('nobody', 'x')).toBeNull();
    const bob = await directory.authenticate('bob', 'bob-pw');
    expect(bob.groupDns).toEqual(expect.arrayContaining([`cn=Backup Tier2,ou=groups,${BASE}`, `cn=Backup Admins,ou=groups,${BASE}`]));
    expect(await directory.authenticate('dave', 'dave-pw')).toBeNull();
  });
  it('a wrong service-account password stops at the first DC instead of retrying every one', async () => {
    directory.saveConfig({ bindPassword: 'bad' }, encryption.encrypt);
    wire.binds.length = 0;
    const r = await directory.testConnection();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid credentials/);
    expect(wire.binds.length).toBe(1);
    directory.saveConfig({ bindPassword: 'svc-pw' }, encryption.encrypt);
  });
});

describe('sync + login', () => {
  let app; let agent; let backupGroupId;
  beforeAll(() => {
    const registry = require('../core/registry');
    registry.init();
    const { createApp } = require('../app');
    app = createApp({ licenseGate: (req, res, next) => next() });
    agent = request.agent(app);
  });
  beforeEach(() => {
    db.prepare("DELETE FROM user_groups WHERE source = 'ad'").run();
    db.prepare("DELETE FROM users WHERE auth_provider = 'ad'").run();
    db.prepare("DELETE FROM groups WHERE provider = 'ad'").run();
    db.prepare('DELETE FROM auth_sessions').run();
    const now = new Date().toISOString();
    backupGroupId = db.prepare(`
      INSERT INTO groups (name, description, is_system, created_at, provider, external_id, external_dn, external_name)
      VALUES ('Backup Admins', 'linked', 0, ?, 'ad', 'g10', ?, 'Backup Admins')
    `).run(now, `cn=Backup Admins,ou=groups,${BASE}`).lastInsertRowid;
    db.prepare("INSERT OR IGNORE INTO role_grants (subject_type, subject_id, permission, created_at) VALUES ('group', ?, 'cohesity:*:view', ?)").run(backupGroupId, now);
  });

  it('runSync imports nested members, mirrors disabled state, and deactivates strays', async () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO users (username, password_hash, display_name, auth_provider, is_active, created_at, updated_at, external_id) VALUES ('zed', '!ad', 'Zed', 'ad', 1, ?, ?, 'gone')").run(now, now);
    const r = await directorySync.runSync('manual');
    expect(r.status).toBe('ok');
    expect(r.groups).toBe(1);
    expect(r.seen).toBe(3);
    const users = db.prepare("SELECT username, is_active FROM users WHERE auth_provider = 'ad' ORDER BY username").all();
    expect(users).toEqual([
      { username: 'alice', is_active: 1 }, { username: 'bob', is_active: 1 }, { username: 'dave', is_active: 0 }, { username: 'zed', is_active: 0 },
    ]);
    const members = db.prepare("SELECT u.username FROM user_groups ug JOIN users u ON u.id = ug.user_id WHERE ug.group_id = ? AND ug.source = 'ad' ORDER BY u.username").all(backupGroupId);
    expect(members.map((m) => m.username)).toEqual(['alice', 'bob', 'dave']);
    expect(r.deactivated).toBe(1);
    const r2 = await directorySync.runSync('manual');
    expect(r2.created).toBe(0);
    expect(db.prepare('SELECT status FROM directory_sync_log ORDER BY id DESC LIMIT 1').get().status).toBe('ok');
  });

  it('a local account with the same name is never overwritten by the sync', async () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO users (username, password_hash, display_name, auth_provider, is_active, created_at, updated_at) VALUES ('bob', 'localhash', 'Local Bob', 'local', 1, ?, ?)").run(now, now);
    const r = await directorySync.runSync('manual');
    expect(r.message).toMatch(/clash with local accounts: bob/);
    expect(db.prepare("SELECT auth_provider, password_hash FROM users WHERE username = 'bob'").get()).toEqual({ auth_provider: 'local', password_hash: 'localhash' });
    db.prepare("DELETE FROM users WHERE username = 'bob'").run();
  });

  it('admin-added memberships survive a sync, AD ones are reconciled', async () => {
    await directorySync.runSync('manual');
    const alice = db.prepare("SELECT id FROM users WHERE username = 'alice'").get();
    const viewer = db.prepare("SELECT id FROM groups WHERE name = 'Viewer'").get();
    db.prepare("INSERT INTO user_groups (user_id, group_id, source) VALUES (?, ?, 'local')").run(alice.id, viewer.id);
    await directorySync.runSync('manual');
    const rows = db.prepare('SELECT group_id, source FROM user_groups WHERE user_id = ? ORDER BY group_id').all(alice.id);
    expect(rows).toEqual(expect.arrayContaining([{ group_id: viewer.id, source: 'local' }, { group_id: backupGroupId, source: 'ad' }]));
  });

  it('POST /api/auth/login accepts a domain user in a linked group and refuses one outside it', async () => {
    const ok = await agent.post('/api/auth/login').send({ username: 'LAB\\alice', password: 'alice-pw' });
    expect(ok.status).toBe(200);
    expect(ok.body.user.username).toBe('alice');
    expect(ok.body.user.permissions).toContain('cohesity:*:view');
    const session = await agent.get('/api/auth/session');
    expect(session.status).toBe(200);
    expect(session.body.user.username).toBe('alice');

    const bad = await request(app).post('/api/auth/login').send({ username: 'alice', password: 'nope' });
    expect(bad.status).toBe(401);

    const carol = await request(app).post('/api/auth/login').send({ username: 'carol', password: 'carol-pw' });
    expect(carol.status).toBe(403);
    expect(carol.body.error).toMatch(/not in any group/);

    const dave = await request(app).post('/api/auth/login').send({ username: 'dave', password: 'dave-pw' });
    expect(dave.status).toBe(401);
  });

  it('setup-status advertises the domain once the directory is configured', async () => {
    const r = await request(app).get('/api/auth/setup-status');
    expect(r.body.directory).toEqual({ enabled: true, domain: DOMAIN });
  });

  it('directory unreachable -> 503 with a clear message', async () => {
    directory.saveConfig({ servers: ['ldap://127.0.0.1:1'] }, encryption.encrypt);
    const r = await request(app).post('/api/auth/login').send({ username: 'alice', password: 'alice-pw' });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/unreachable/);
    directory.saveConfig({ servers: [] }, encryption.encrypt);
  });
});
