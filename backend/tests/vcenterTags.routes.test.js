/**
 * vCenter tag catalog + tag filter on the VM list (feeds the Tags page and
 * scripted exports): GET /api/vcenter/tags and GET /api/vcenter/vms?tag=...
 * Minimal express app wired to routes/vcenter.js against the shared test DB.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const vcenterRouter = require('../routes/vcenter');

let app;

beforeAll(() => {
  app = express();
  app.use((req, res, next) => { req.auth = { grants: ['*:*:*'] }; next(); });
  app.use('/api/vcenter', vcenterRouter);

  db.exec('DELETE FROM vcenter_vms');
  const vc = db.prepare(`
    INSERT INTO vcenter_vcenters (name, host, username, encrypted_credentials)
    VALUES ('tags-vc', 'tags-vc.corp.local', 'admin', 'enc')
  `).run().lastInsertRowid;
  const ins = db.prepare(`
    INSERT INTO vcenter_vms (vcenter_id, vm_id, name, host_name, cluster_name, power_state, cpu_count, memory_mb, tags)
    VALUES (?, ?, ?, 'esx1', 'cl1', 'POWERED_ON', 2, 4096, ?)
  `);
  ins.run(vc, 'vm-1', 'tag-vm-1', JSON.stringify(['Environment: Production', 'App: DB']));
  ins.run(vc, 'vm-2', 'tag-vm-2', JSON.stringify(['Environment: Production', 'Backup: Protected']));
  ins.run(vc, 'vm-3', 'tag-vm-3', JSON.stringify(['Environment: Dev']));
  ins.run(vc, 'vm-4', 'tag-vm-4', null);
  ins.run(vc, 'vm-5', 'tag-vm-5', JSON.stringify(['Legacy']));
});

describe('GET /api/vcenter/tags', () => {
  it('lists every tag with its VM count, split into category and name, plus untagged and total', async () => {
    const res = await request(app).get('/api/vcenter/tags');
    expect(res.status).toBe(200);
    const byTag = Object.fromEntries(res.body.tags.map((t) => [t.tag, t]));
    expect(byTag['Environment: Production']).toMatchObject({ category: 'Environment', name: 'Production', vms: 2 });
    expect(byTag['App: DB']).toMatchObject({ category: 'App', name: 'DB', vms: 1 });
    expect(byTag['Legacy']).toMatchObject({ category: 'Uncategorized', name: 'Legacy', vms: 1 });
    expect(res.body.untagged).toBe(1);
    expect(res.body.totalVms).toBe(5);
  });
});

describe('GET /api/vcenter/vms?tag=', () => {
  const names = (res) => res.body.map((v) => v.name).sort();

  it('one tag returns only VMs carrying it', async () => {
    const res = await request(app).get('/api/vcenter/vms').query({ tag: 'Environment: Production' });
    expect(res.status).toBe(200);
    expect(names(res)).toEqual(['tag-vm-1', 'tag-vm-2']);
  });

  it('two tags default to any, match=all narrows to VMs carrying both', async () => {
    const any = await request(app).get('/api/vcenter/vms?tag=Environment%3A%20Production&tag=Environment%3A%20Dev');
    expect(names(any)).toEqual(['tag-vm-1', 'tag-vm-2', 'tag-vm-3']);
    const all = await request(app).get('/api/vcenter/vms?tag=Environment%3A%20Production&tag=App%3A%20DB&match=all');
    expect(names(all)).toEqual(['tag-vm-1']);
  });

  it('untagged=1 returns VMs with no tags; an unknown tag returns an empty list', async () => {
    const un = await request(app).get('/api/vcenter/vms').query({ untagged: '1' });
    expect(names(un)).toEqual(['tag-vm-4']);
    const none = await request(app).get('/api/vcenter/vms').query({ tag: 'Nope: Nothing' });
    expect(none.status).toBe(200);
    expect(none.body).toEqual([]);
  });
});
