/**
 * Okta Management API sync (2026-11-06): a fake Okta served through the
 * idpOktaApi setHttp seam (two Link header lines, one 429), the sync into
 * users / user_groups, deactivation of removed users, pinned users kept,
 * group-by-name resolution, and the notifier item after a failed sync.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const BASE = 'https://dev-1.okta.com';
const u = (id, login, status = 'ACTIVE', first = 'F', last = 'L') => ({ id, status, profile: { login, email: login, firstName: first, lastName: last } });

const fake = {
  groups: [{ id: '00gBA', type: 'OKTA_GROUP', profile: { name: 'Backup Admins', description: 'Backup operators' } }, { id: '00gSV', type: 'OKTA_GROUP', profile: { name: 'Storage Viewers', description: '' } }],
  members: {
    '00gBA': [u('00u1', 'alice@lab.test', 'ACTIVE', 'Alice', 'Anders'), u('00u2', 'bob@lab.test', 'ACTIVE', 'Bob', 'Brown'), u('00u3', 'dave@lab.test', 'SUSPENDED', 'Dave', 'Disabled')],
    '00gSV': [u('00u1', 'alice@lab.test', 'ACTIVE', 'Alice', 'Anders')],
  },
  calls: [],
  limited: false,
  token: 'good-token',
  hits429: 0,
};

/** Fake axios-shaped Okta. Group 00gBA members come in two pages with two Link header lines; page 2 rate limits once. */
async function fakeHttp({ method, url, headers }) {
  fake.calls.push(url);
  if (headers.Authorization !== `SSWS ${fake.token}`) return { status: 401, headers: {}, data: { errorSummary: 'Invalid token provided' } };
  const parsed = new URL(url);
  const p = parsed.pathname;
  if (p === '/api/v1/users/me') return { status: 200, headers: {}, data: u('00uMe', 'svc@lab.test') };
  if (p === '/api/v1/groups') {
    const q = (parsed.searchParams.get('q') || '').toLowerCase();
    return { status: 200, headers: {}, data: fake.groups.filter((g) => g.profile.name.toLowerCase().includes(q)) };
  }
  let m = /^\/api\/v1\/groups\/([^/]+)\/users$/.exec(p);
  if (m) {
    const all = fake.members[m[1]] || [];
    if (m[1] !== '00gBA') return { status: 200, headers: {}, data: all };
    if (!parsed.searchParams.get('after')) {
      return { status: 200, headers: { link: [`<${BASE}${p}?limit=200>; rel="self"`, `<${BASE}${p}?after=p2&limit=200>; rel="next"`] }, data: all.slice(0, 2) };
    }
    if (fake.limited && fake.hits429 === 0) {
      fake.hits429 += 1;
      return { status: 429, headers: { 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000)) }, data: { errorSummary: 'Too many requests' } };
    }
    return { status: 200, headers: { link: `<${BASE}${p}?after=p2&limit=200>; rel="self"` }, data: all.slice(2) };
  }
  m = /^\/api\/v1\/users\/([^/]+)$/.exec(p);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const hit = Object.values(fake.members).flat().find((x) => x.id === id || x.profile.login === id);
    return hit ? { status: 200, headers: {}, data: hit } : { status: 404, headers: {}, data: { errorSummary: 'Not found' } };
  }
  return { status: 404, headers: {}, data: {} };
}

let db; let okta; let idpSync; let idpProvision; let encryption; let notifier; let pid;

function addGroup(name, extra = {}) {
  const now = new Date().toISOString();
  const info = db.prepare("INSERT INTO groups (name, description, is_system, created_at, provider, external_name, external_id, idp_provider_id) VALUES (?, '', 0, ?, 'idp', ?, ?, ?)")
    .run(`ICC ${name}`, now, name, extra.externalId || null, pid);
  return info.lastInsertRowid;
}

const user = (login) => db.prepare('SELECT * FROM users WHERE username = ?').get(login);
const members = (gid) => db.prepare("SELECT u.username FROM user_groups ug JOIN users u ON u.id = ug.user_id WHERE ug.group_id = ? AND ug.source = 'idp' ORDER BY u.username").all(gid).map((r) => r.username);

beforeAll(() => {
  db = require('../db/database');
  okta = require('../services/idpOktaApi');
  idpSync = require('../services/idpSync');
  idpProvision = require('../services/idpProvision');
  encryption = require('../services/encryption');
  notifier = require('../services/alertNotifier');
  okta.setHttp(fakeHttp);
  const now = new Date().toISOString();
  pid = db.prepare(`INSERT INTO idp_providers (name, slug, type, enabled, issuer, client_id, mgmt_kind, mgmt_base_url, mgmt_token, mgmt_deactivate_removed, created_at, updated_at)
    VALUES ('Okta Lab', 'okta-lab', 'oidc', 1, 'https://dev-1.okta.com', 'cid', 'okta', ?, ?, 1, ?, ?)`)
    .run(BASE, encryption.encrypt(fake.token), now, now).lastInsertRowid;
});

beforeEach(() => { fake.calls.length = 0; fake.limited = false; fake.hits429 = 0; });

describe('Okta client', () => {
  it('follows Link rel=next across two header lines and pages', async () => {
    const c = okta.createClient({ baseUrl: BASE, token: fake.token });
    const ms = await c.groupMembers('00gBA');
    expect(ms.map((x) => x.username)).toEqual(['alice@lab.test', 'bob@lab.test', 'dave@lab.test']);
    expect(ms[0]).toMatchObject({ subject: '00u1', email: 'alice@lab.test', displayName: 'Alice Anders', active: true });
    expect(ms[2].active).toBe(false);
  });
  it('retries once after a 429 and then succeeds', async () => {
    fake.limited = true;
    const c = okta.createClient({ baseUrl: BASE, token: fake.token });
    const ms = await c.groupMembers('00gBA');
    expect(ms).toHaveLength(3);
    expect(fake.hits429).toBe(1);
  });
  it('reports a rejected token', async () => {
    const c = okta.createClient({ baseUrl: BASE, token: 'bad' });
    await expect(c.test()).rejects.toMatchObject({ status: 401 });
    expect((await okta.createClient({ baseUrl: BASE, token: fake.token }).test()).login).toBe('svc@lab.test');
  });
  it('finds a group by exact case-insensitive name and a user by login', async () => {
    const c = okta.createClient({ baseUrl: BASE, token: fake.token });
    expect((await c.getGroupByName('backup admins')).id).toBe('00gBA');
    expect(await c.getGroupByName('Backup')).toBeNull();
    expect((await c.getUser('bob@lab.test')).subject).toBe('00u2');
    expect(await c.getUser('nobody')).toBeNull();
  });
});

describe('runSync', () => {
  let gBA; let gSV;
  beforeAll(() => { gBA = addGroup('Backup Admins'); gSV = addGroup('Storage Viewers', { externalId: '00gSV' }); });

  it('resolves the group id by name, creates users, sets idp memberships, records a log row', async () => {
    fake.limited = true;
    const r = await idpSync.runSync(pid, 'manual');
    expect(r).toMatchObject({ status: 'ok', groups: 2, seen: 3, created: 3, deactivated: 0 });
    expect(db.prepare('SELECT external_id FROM groups WHERE id = ?').get(gBA).external_id).toBe('00gBA');
    expect(members(gBA)).toEqual(['alice@lab.test', 'bob@lab.test', 'dave@lab.test']);
    expect(members(gSV)).toEqual(['alice@lab.test']);
    expect(user('alice@lab.test')).toMatchObject({ auth_provider: 'oidc', idp_provider_id: pid, external_id: `idp:https://dev-1.okta.com:00u1`, is_active: 1 });
    expect(user('dave@lab.test').is_active).toBe(0);
    const p = db.prepare('SELECT * FROM idp_providers WHERE id = ?').get(pid);
    expect(p.mgmt_last_status).toBe('ok');
    expect(p.mgmt_last_error).toBeNull();
    const runs = idpSync.lastRuns(pid, 5);
    expect(runs[0]).toMatchObject({ status: 'ok', trigger: 'manual', users_created: 3 });
    expect(idpSync.isRunning(pid)).toBe(false);
  });

  it('a second run changes nothing', async () => {
    const r = await idpSync.runSync(pid, 'schedule');
    expect(r).toMatchObject({ status: 'ok', created: 0, updated: 0, deactivated: 0 });
  });

  it('deactivates a user removed from Okta, keeps a pinned user, drops idp memberships', async () => {
    const eve = idpProvision.importUser(db.prepare('SELECT * FROM idp_providers WHERE id = ?').get(pid), { subject: 'eve@lab.test', email: 'eve@lab.test', username: 'eve@lab.test', displayName: 'Eve', groups: [], groupIds: [], active: true }, []);
    expect(eve.directory_pinned).toBe(1);
    fake.members['00gBA'] = fake.members['00gBA'].filter((x) => x.id !== '00u2');
    const r = await idpSync.runSync(pid, 'schedule');
    expect(r.status).toBe('ok');
    expect(r.deactivated).toBe(1);
    expect(user('bob@lab.test').is_active).toBe(0);
    expect(members(gBA)).not.toContain('bob@lab.test');
    expect(user('eve@lab.test').is_active).toBe(1);
    expect(user('alice@lab.test').is_active).toBe(1);
  });

  it('a group missing from Okta skips the deactivation pass', async () => {
    const gX = addGroup('Does Not Exist');
    const before = user('alice@lab.test').is_active;
    fake.members['00gBA'] = fake.members['00gBA'].filter((x) => x.id !== '00u1');
    const r = await idpSync.runSync(pid, 'schedule');
    expect(r.status).toBe('ok');
    expect(r.message).toMatch(/Does Not Exist/);
    expect(r.deactivated).toBe(0);
    expect(user('alice@lab.test').is_active).toBe(before);
    db.prepare('DELETE FROM groups WHERE id = ?').run(gX);
  });

  it('records a failed sync, keeps users, and raises the notifier item', async () => {
    fake.token = 'rotated';
    const r = await idpSync.runSync(pid, 'schedule');
    expect(r.status).toBe('error');
    expect(r.message).toMatch(/401|rejected/i);
    const p = db.prepare('SELECT * FROM idp_providers WHERE id = ?').get(pid);
    expect(p.mgmt_last_status).toBe('error');
    const items = notifier.collectIdpIssues();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sourceKey: `idp:sync:${pid}`, severity: 'warning', host: 'Okta Lab', type: 'idp-sync-failed', typeLabel: 'IdP sync failed' });
    expect(items[0].message).toMatch(/^Identity provider sync failed: /);
    fake.token = 'good-token';
    const ok = await idpSync.runSync(pid, 'manual');
    expect(ok.status).toBe('ok');
    expect(notifier.collectIdpIssues()).toHaveLength(0);
  });

  it('skips a provider without a Management API', async () => {
    const now = new Date().toISOString();
    const id = db.prepare("INSERT INTO idp_providers (name, slug, type, created_at, updated_at) VALUES ('Bare', 'bare', 'saml', ?, ?)").run(now, now).lastInsertRowid;
    expect(await idpSync.runSync(id, 'manual')).toMatchObject({ skipped: true });
    expect(await idpSync.runSync(99999, 'manual')).toMatchObject({ skipped: true });
  });
});
