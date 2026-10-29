/** vCenter groups: CRUD, membership both ways, carried on /vcenters and /guest-os. */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const vcenterRouter = require('../routes/vcenter');

let app;
let vcA;
let vcB;
let vcC;

function addVc(name) {
  return db.prepare(`
    INSERT INTO vcenter_vcenters (name, host, username, encrypted_credentials, last_poll_status)
    VALUES (?, ?, 'admin', 'enc', 'success')
  `).run(name, `${name}.corp.local`).lastInsertRowid;
}

const count = (sql, ...args) => db.prepare(sql).get(...args).n;

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.auth = { grants: ['*:*:*'] }; next(); });
  app.use('/api/vcenter', vcenterRouter);

  db.exec('DELETE FROM vcenter_group_members');
  db.exec('DELETE FROM vcenter_groups');
  db.exec('DELETE FROM vcenter_site_members');
  db.exec('DELETE FROM vcenter_sites');
  db.exec('DELETE FROM vcenter_vms');
  db.exec('DELETE FROM vcenter_vcenters');
  vcA = addVc('grp-a');
  vcB = addVc('grp-b');
  vcC = addVc('grp-c');
});

describe('vCenter groups', () => {
  let gid;

  it('creates a group with members', async () => {
    const res = await request(app).post('/api/vcenter/groups')
      .send({ name: '  Site1 ', color: '#0091DA', vcenterIds: [vcA, vcB, 99999] });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Site1');
    expect(res.body.color).toBe('#0091DA');
    expect(res.body.vcenterIds.sort()).toEqual([vcA, vcB].sort());
    gid = res.body.id;
  });

  it('rejects a duplicate name with 409 and a bad body with 400', async () => {
    const dup = await request(app).post('/api/vcenter/groups').send({ name: 'Site1' });
    expect(dup.status).toBe(409);
    const bad = await request(app).post('/api/vcenter/groups').send({ name: '' });
    expect(bad.status).toBe(400);
    expect(bad.body.details).toBeTruthy();
    const badColor = await request(app).post('/api/vcenter/groups').send({ name: 'X', color: 'red' });
    expect(badColor.status).toBe(400);
  });

  it('renames, recolours and clears the colour', async () => {
    let res = await request(app).put(`/api/vcenter/groups/${gid}`).send({ name: 'Site One', color: '#112233' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Site One');
    expect(res.body.color).toBe('#112233');
    res = await request(app).put(`/api/vcenter/groups/${gid}`).send({ color: null });
    expect(res.body.color).toBeNull();
    const other = await request(app).post('/api/vcenter/groups').send({ name: 'Other' });
    const clash = await request(app).put(`/api/vcenter/groups/${other.body.id}`).send({ name: 'Site One' });
    expect(clash.status).toBe(409);
    expect((await request(app).put('/api/vcenter/groups/99999').send({ name: 'Z' })).status).toBe(404);
  });

  it('sets members from the group side', async () => {
    const res = await request(app).put(`/api/vcenter/groups/${gid}`).send({ vcenterIds: [vcC] });
    expect(res.body.vcenterIds).toEqual([vcC]);
  });

  it('sets groups from the vCenter side', async () => {
    const other = (await request(app).get('/api/vcenter/groups')).body.groups.find((g) => g.name === 'Other');
    const res = await request(app).put(`/api/vcenter/vcenters/${vcA}/groups`).send({ groupIds: [gid, other.id, 99999] });
    expect(res.status).toBe(200);
    expect(res.body.groups.map((g) => g.id).sort()).toEqual([gid, other.id].sort());
    const after = (await request(app).get('/api/vcenter/groups')).body.groups.find((g) => g.id === gid);
    expect(after.vcenterIds.sort()).toEqual([vcA, vcC].sort());
    expect((await request(app).put('/api/vcenter/vcenters/99999/groups').send({ groupIds: [] })).status).toBe(404);
  });

  it('GET /vcenters carries groups per row', async () => {
    const res = await request(app).get('/api/vcenter/vcenters');
    const a = res.body.find((v) => v.id === vcA);
    const b = res.body.find((v) => v.id === vcB);
    expect(a.groups.length).toBe(2);
    expect(a.groups[0]).toHaveProperty('name');
    expect(b.groups).toEqual([]);
  });

  it('GET /guest-os carries groups and sites', async () => {
    const siteId = db.prepare("INSERT INTO vcenter_sites (name, color, sort_order) VALUES ('DC-T', '#abcdef', 0)").run().lastInsertRowid;
    db.prepare("INSERT INTO vcenter_site_members (site_id, vcenter_id, member_type, member_name) VALUES (?, ?, 'cluster', 'cl1')").run(siteId, vcB);
    db.prepare("INSERT INTO vcenter_site_members (site_id, vcenter_id, member_type, member_name) VALUES (?, ?, 'vcenter', 'grp-b')").run(siteId, vcB);
    const res = await request(app).get('/api/vcenter/guest-os');
    expect(res.status).toBe(200);
    expect(res.body.groups.find((g) => g.id === gid).vcenterIds.sort()).toEqual([vcA, vcC].sort());
    const site = res.body.sites.find((s) => s.name === 'DC-T');
    expect(site.vcenterIds).toEqual([vcB]);
  });

  it('deleting a group removes its memberships', async () => {
    const res = await request(app).delete(`/api/vcenter/groups/${gid}`);
    expect(res.status).toBe(204);
    expect(count('SELECT COUNT(*) AS n FROM vcenter_group_members WHERE group_id = ?', gid)).toBe(0);
    expect((await request(app).delete(`/api/vcenter/groups/${gid}`)).status).toBe(404);
  });

  it('deleting a vCenter removes its memberships', async () => {
    const g = await request(app).post('/api/vcenter/groups').send({ name: 'Tmp', vcenterIds: [vcB, vcC] });
    expect(count('SELECT COUNT(*) AS n FROM vcenter_group_members WHERE vcenter_id = ?', vcB)).toBe(1);
    const res = await request(app).delete(`/api/vcenter/vcenters/${vcB}`);
    expect(res.status).toBe(200);
    expect(count('SELECT COUNT(*) AS n FROM vcenter_group_members WHERE vcenter_id = ?', vcB)).toBe(0);
    const after = (await request(app).get('/api/vcenter/groups')).body.groups.find((x) => x.id === g.body.id);
    expect(after.vcenterIds).toEqual([vcC]);
  });
});
