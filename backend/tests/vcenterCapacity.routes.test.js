// Route-level checks for the site-capacity feature: sites CRUD + membership,
// overview/failover math from snapshot tables, hourly sampling, trends bucketing
// and the explorer's replicated-storage flag.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const vcenterMigrations = require('../db/migrations/vcenter');
const { encrypt } = require('../services/encryption');

const GIB = 1024 ** 3;
let app;
let vcId;

beforeAll(() => {
  runMigrations(db, 'vcenter', vcenterMigrations);
  for (const t of ['vcenter_site_members', 'vcenter_sites', 'vcenter_capacity_history', 'vcenter_datastore_history',
    'vcenter_vm_capacity_history', 'vcenter_vms', 'vcenter_hosts', 'vcenter_clusters', 'vcenter_datastores']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare("DELETE FROM vcenter_vcenters WHERE name = 'cap-vc'").run();
  vcId = db.prepare(`
    INSERT INTO vcenter_vcenters (name, host, username, encrypted_credentials, ssl_verify, polling_interval_minutes)
    VALUES ('cap-vc', 'cap.invalid', 'u', ?, 0, 15)
  `).run(encrypt(JSON.stringify({ password: 'x' }))).lastInsertRowid;

  // Two clusters: A = 3 hosts × (48 cores, 100 000 MHz, 512 GiB); B = 2 hosts of the same size.
  const host = db.prepare(`
    INSERT INTO vcenter_hosts (vcenter_id, host_id, name, cluster_name, connection_state, cpu_cores, cpu_mhz_capacity, cpu_mhz_used, mem_bytes_capacity, mem_bytes_used)
    VALUES (?, ?, ?, ?, 'CONNECTED', 48, 100000, ?, ?, ?)
  `);
  for (let i = 1; i <= 3; i++) host.run(vcId, `h-a${i}`, `esx-a${i}`, 'cl-a', 30000, 512 * GIB, 200 * GIB);
  for (let i = 1; i <= 2; i++) host.run(vcId, `h-b${i}`, `esx-b${i}`, 'cl-b', 30000, 512 * GIB, 200 * GIB);
  const cluster = db.prepare(`
    INSERT INTO vcenter_clusters (vcenter_id, cluster_id, name, host_count, vm_count, cpu_mhz_capacity, cpu_mhz_used, mem_bytes_capacity, mem_bytes_used)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  cluster.run(vcId, 'c-a', 'cl-a', 3, 2, 300000, 90000, 1536 * GIB, 600 * GIB);
  cluster.run(vcId, 'c-b', 'cl-b', 2, 1, 200000, 60000, 1024 * GIB, 400 * GIB);
  const vm = db.prepare(`
    INSERT INTO vcenter_vms (vcenter_id, vm_id, name, host_name, cluster_name, power_state, cpu_count, memory_mb, cpu_usage_mhz, mem_usage_mb, storage_committed_bytes, datastores)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  vm.run(vcId, 'vm-1', 'app01', 'esx-a1', 'cl-a', 'POWERED_ON', 8, 32768, 4000, 16384, 100 * GIB, JSON.stringify(['ds-rep']));
  vm.run(vcId, 'vm-2', 'app02', 'esx-a2', 'cl-a', 'POWERED_OFF', 4, 8192, 0, 0, 50 * GIB, JSON.stringify(['ds-rep', 'ds-local']));
  vm.run(vcId, 'vm-3', 'db01', 'esx-b1', 'cl-b', 'POWERED_ON', 16, 65536, 9000, 40000, 400 * GIB, JSON.stringify(['ds-b']));
  const ds = db.prepare(`
    INSERT INTO vcenter_datastores (vcenter_id, datastore_id, name, ds_type, capacity_bytes, free_bytes, accessible) VALUES (?, ?, ?, 'VMFS', ?, ?, 1)
  `);
  ds.run(vcId, 'd1', 'ds-rep', 10000 * GIB, 6000 * GIB);
  ds.run(vcId, 'd2', 'ds-local', 2000 * GIB, 1000 * GIB);
  ds.run(vcId, 'd3', 'ds-b', 8000 * GIB, 3000 * GIB);

  app = express();
  app.use(express.json());
  app.use('/api/vcenter', require('../routes/vcenter'));
});

describe('vCenter site capacity routes', () => {
  let siteA, siteB;

  it('creates sites and rejects duplicates', async () => {
    siteA = (await request(app).post('/api/vcenter/capacity/sites').send({ name: 'DC-A', color: '#0091DA' })).body;
    siteB = (await request(app).post('/api/vcenter/capacity/sites').send({ name: 'DC-B' })).body;
    expect(siteA.id).toBeTruthy();
    expect((await request(app).post('/api/vcenter/capacity/sites').send({ name: 'DC-A' })).status).toBe(409);
  });

  it('maps clusters and reports unmapped', async () => {
    const put = (b) => request(app).put('/api/vcenter/capacity/sites/members').send(b);
    expect((await put({ vcenterId: vcId, memberType: 'cluster', memberName: 'cl-a', siteId: siteA.id })).status).toBe(200);
    expect((await put({ vcenterId: vcId, memberType: 'cluster', memberName: 'cl-b', siteId: siteB.id })).status).toBe(200);
    const res = await request(app).get('/api/vcenter/capacity/sites');
    expect(res.body.sites).toHaveLength(2);
    expect(res.body.members).toHaveLength(2);
    expect(res.body.clusters.map((c) => [c.name, c.siteId])).toEqual([['cl-a', siteA.id], ['cl-b', siteB.id]]);
    expect(res.body.unmapped.clusters).toHaveLength(0);
  });

  it('overview: N+1 usable, allocation from powered-on VMs, failover fit', async () => {
    const res = await request(app).get('/api/vcenter/capacity/overview');
    expect(res.status).toBe(200);
    const a = res.body.sites.find((s) => s.name === 'DC-A');
    const b = res.body.sites.find((s) => s.name === 'DC-B');
    // cl-a: 3 hosts, largest 512 GiB → usable 1024 GiB; cl-b: 2 hosts → usable 512 GiB.
    expect(a.totals.mem.usableBytes).toBe(1024 * GIB);
    expect(b.totals.mem.usableBytes).toBe(512 * GIB);
    expect(a.totals.cpu.usableMhz).toBe(200000);
    expect(a.totals.cpu.usableCores).toBe(96);
    // Only app01 is powered on in DC-A → 8 vCPU / 32 GiB allocated.
    expect(a.totals.cpu.vcpuAllocated).toBe(8);
    expect(a.totals.mem.mbAllocated).toBe(32768);
    expect(a.totals.vmsOn).toBe(1);
    expect(a.totals.vmCount).toBe(2);
    // Failover: total used mem 1000 GiB. Into A (1024 usable) fits at ~97.7%; into B (512) does not.
    const fA = res.body.failover.find((f) => f.target === 'DC-A');
    const fB = res.body.failover.find((f) => f.target === 'DC-B');
    expect(fA.memUsedPct).toBeCloseTo(97.7, 0);
    expect(fA.fits).toBe(true);
    expect(fB.memUsedPct).toBeCloseTo(195.3, 0);
    expect(fB.fits).toBe(false);
    expect(res.body.unmappedClusterCount).toBe(0);
    expect(res.body.lastSampleAt).toBeNull();
  });

  it('sample writes per-cluster/VM history and the hourly gate holds', async () => {
    const res = await request(app).post('/api/vcenter/capacity/sample').send({});
    expect(res.body).toEqual({ vcenters: 1, sampled: 1 });
    expect(db.prepare('SELECT COUNT(*) n FROM vcenter_capacity_history').get().n).toBe(2);
    expect(db.prepare('SELECT COUNT(*) n FROM vcenter_vm_capacity_history').get().n).toBe(3);
    const row = db.prepare("SELECT * FROM vcenter_capacity_history WHERE cluster_name = 'cl-a'").get();
    expect(row.largest_host_mem_bytes).toBe(512 * GIB);
    expect(row.vcpu_allocated).toBe(8);
    const { writeCapacitySample } = require('../services/vcenterCapacity');
    expect(writeCapacitySample(vcId).sampled).toBe(false); // < 55 min since last
  });

  it('trends: buckets by site and returns growth keys', async () => {
    const res = await request(app).get(`/api/vcenter/capacity/trends?days=7&siteId=${siteA.id}`);
    expect(res.status).toBe(200);
    expect(res.body.points).toHaveLength(1);
    const p = res.body.points[0];
    expect(p.usableMemBytes).toBe(1024 * GIB);
    expect(p.memBytesUsedAvg).toBe(600 * GIB);
    expect(p.cpuCores).toBe(144);
    expect(res.body.growth).toHaveProperty('monthsUntilMemFull');
    const all = await request(app).get('/api/vcenter/capacity/trends?days=30');
    expect(all.body.points[0].usableMemBytes).toBe(1536 * GIB);
    expect((await request(app).get('/api/vcenter/capacity/trends?days=0')).status).toBe(400);
  });

  it('vm-trends validates query and returns the sampled row', async () => {
    expect((await request(app).get('/api/vcenter/capacity/vm-trends')).status).toBe(400);
    const res = await request(app).get(`/api/vcenter/capacity/vm-trends?vcenterId=${vcId}&vm=db01`);
    expect(res.body.points).toHaveLength(1);
    expect(res.body.points[0].memUsageMb).toBe(40000);
  });

  it('explorer: site rollups, VMs mapped to sites', async () => {
    const res = await request(app).get('/api/vcenter/capacity/explorer');
    const a = res.body.sites.find((s) => s.name === 'DC-A');
    expect(a.mem.usableBytes).toBe(1024 * GIB);
    const byName = Object.fromEntries(res.body.vms.map((v) => [v.name, v]));
    expect(byName.db01.siteId).toBe(siteB.id);
    expect(byName.app01.datastores).toBeUndefined();
  });

  it('auto-maps unmapped clusters to a site named after their vCenter, never touching manual mappings', async () => {
    const { autoCreateSites, ensureDefaultSites } = require('../services/vcenterCapacity');
    // Everything is mapped by hand → the poll-time hook is a no-op.
    expect(ensureDefaultSites()).toEqual({ created: 0, mapped: 0 });
    // Unmap cl-b, then auto-map: a site named after the vCenter ('cap-vc') appears and owns it; cl-a stays on DC-A.
    await request(app).put('/api/vcenter/capacity/sites/members').send({ vcenterId: vcId, memberType: 'cluster', memberName: 'cl-b', siteId: null });
    const res = await request(app).post('/api/vcenter/capacity/sites/auto').send({});
    expect(res.body).toEqual({ created: 1, mapped: 1 });
    const sites = (await request(app).get('/api/vcenter/capacity/sites')).body;
    const vcSite = sites.sites.find((s) => s.name === 'cap-vc');
    expect(vcSite).toBeTruthy();
    expect(sites.clusters.find((c) => c.name === 'cl-b').siteId).toBe(vcSite.id);
    expect(sites.clusters.find((c) => c.name === 'cl-a').siteId).toBe(siteA.id);
    // Idempotent: nothing left to map.
    expect(autoCreateSites()).toEqual({ created: 0, mapped: 0 });
    // Restore cl-b → DC-B for the cascade test below.
    await request(app).put('/api/vcenter/capacity/sites/members').send({ vcenterId: vcId, memberType: 'cluster', memberName: 'cl-b', siteId: siteB.id });
    await request(app).delete(`/api/vcenter/capacity/sites/${vcSite.id}`);
  });

  it('failover pairs: CRUD + overview pair summary in both directions', async () => {
    const bad = await request(app).post('/api/vcenter/capacity/pairs').send({ siteAId: siteA.id, siteBId: siteA.id });
    expect(bad.status).toBe(400);
    const made = await request(app).post('/api/vcenter/capacity/pairs').send({ siteAId: siteA.id, siteBId: siteB.id });
    expect(made.status).toBe(201);
    expect((await request(app).post('/api/vcenter/capacity/pairs').send({ siteAId: siteB.id, siteBId: siteA.id })).status).toBe(409);
    const list = (await request(app).get('/api/vcenter/capacity/pairs')).body;
    expect(list).toHaveLength(1);
    expect(list[0].siteAName).toBe('DC-A');
    const ov = (await request(app).get('/api/vcenter/capacity/overview')).body;
    expect(ov.pairs).toHaveLength(1);
    const p = ov.pairs[0];
    // Used mem: A 600 GiB, B 400 GiB; usable A 1024, B 512 → combined 1000/1536 = 65.1%.
    expect(p.combined.mem.usedPct).toBeCloseTo(65.1, 0);
    // Everything on B (A fails): 1000/512 = 195.3% → no. Everything on A (B fails): 1000/1024 = 97.7% → fits.
    expect(p.aToB.to).toBe('DC-B');
    expect(p.aToB.fits).toBe(false);
    expect(p.bToA.memUsedPct).toBeCloseTo(97.7, 0);
    expect(p.bToA.fits).toBe(true);
    expect((await request(app).delete(`/api/vcenter/capacity/pairs/${made.body.id}`)).body).toEqual({ deleted: true });
    expect((await request(app).delete(`/api/vcenter/capacity/pairs/${made.body.id}`)).status).toBe(404);
  });

  it('deleting a site cascades its members', async () => {
    expect((await request(app).delete(`/api/vcenter/capacity/sites/${siteB.id}`)).body).toEqual({ deleted: true });
    const res = await request(app).get('/api/vcenter/capacity/sites');
    expect(res.body.members.every((m) => m.siteId === siteA.id)).toBe(true);
    expect(res.body.unmapped.clusters.map((c) => c.name)).toEqual(['cl-b']);
  });
});
