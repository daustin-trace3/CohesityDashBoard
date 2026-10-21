// Route-level checks for the vCenter long-term history reads: VM and host
// trends (raw vs daily granularity), the per-host window table, datastore
// growth, the datastore list growth fields and the retention config.
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

const get = (url) => request(app).get(`/api/vcenter${url}`);

beforeAll(() => {
  runMigrations(db, 'vcenter', vcenterMigrations);
  for (const t of ['vcenter_vm_daily', 'vcenter_host_daily', 'vcenter_host_capacity_history', 'vcenter_vm_capacity_history',
    'vcenter_datastore_history', 'vcenter_datastores', 'vcenter_vms', 'vcenter_hosts']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare("DELETE FROM app_settings WHERE key LIKE 'vcenter_%_days'").run();
  db.prepare("DELETE FROM vcenter_vcenters WHERE name = 'hist-vc'").run();
  vcId = db.prepare(`
    INSERT INTO vcenter_vcenters (name, host, username, encrypted_credentials, ssl_verify, polling_interval_minutes)
    VALUES ('hist-vc', 'hist.invalid', 'u', ?, 0, 15)
  `).run(encrypt(JSON.stringify({ password: 'x' }))).lastInsertRowid;

  db.prepare(`
    INSERT INTO vcenter_vms (vcenter_id, vm_id, name, host_name, cluster_name, power_state, cpu_count, memory_mb, cpu_usage_mhz, mem_usage_mb)
    VALUES (?, 'vm-1', 'web01', 'esx1', 'cl', 'POWERED_ON', 4, 8192, 900, 4000)
  `).run(vcId);

  // VM daily: three days. day -2: 24 samples avg 1000 MHz / 4000 MB; day -1: 24 samples avg 2000 / 6000; today: 12 samples avg 3000 / 7000.
  const vmDay = db.prepare(`
    INSERT INTO vcenter_vm_daily (vcenter_id, vm_name, day, cluster_name, samples, on_samples,
      cpu_samples, cpu_min_mhz, cpu_sum_mhz, cpu_max_mhz, cpu_last_mhz,
      mem_samples, mem_min_mb, mem_sum_mb, mem_max_mb, mem_last_mb, cpu_count_last, memory_mb_last, storage_last_bytes)
    VALUES (?, 'web01', date('now', ?), 'cl', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 4, 8192, ?)
  `);
  vmDay.run(vcId, '-2 days', 24, 24, 24, 500, 24000, 1500, 1000, 24, 3500, 96000, 4500, 4000, 10 * GIB);
  vmDay.run(vcId, '-1 days', 24, 24, 24, 1000, 48000, 3000, 2000, 24, 5500, 144000, 6500, 6000, 10 * GIB);
  vmDay.run(vcId, '0 days', 12, 6, 12, 2000, 36000, 4000, 3000, 12, 6500, 84000, 7500, 7000, 10 * GIB);
  // A raw row for the 7-day-or-less path.
  db.prepare(`
    INSERT INTO vcenter_vm_capacity_history (vcenter_id, captured_at, vm_name, cluster_name, power_state, cpu_usage_mhz, mem_usage_mb)
    VALUES (?, datetime('now', '-1 hours'), 'web01', 'cl', 'POWERED_ON', 800, 3900)
  `).run(vcId);

  // Hosts: esx1 (memory 50 percent) and esx2 (memory 80 percent), two daily rows each.
  const hostDay = db.prepare(`
    INSERT INTO vcenter_host_daily (vcenter_id, host_name, day, cluster_name, samples, disconnected_samples, maintenance_samples,
      cpu_samples, cpu_min_mhz, cpu_sum_mhz, cpu_max_mhz, cpu_last_mhz, cpu_capacity_mhz_last,
      mem_samples, mem_min_bytes, mem_sum_bytes, mem_max_bytes, mem_last_bytes, mem_capacity_bytes_last, vm_count_last, uptime_last_seconds)
    VALUES (?, ?, date('now', ?), 'cl', 24, ?, 0, 24, ?, ?, ?, ?, 100000, 24, ?, ?, ?, ?, ?, 10, 86400)
  `);
  const mem = (frac) => Math.round(512 * GIB * frac);
  for (const [d, disc] of [['-2 days', 6], ['-1 days', 0]]) {
    hostDay.run(vcId, 'esx1', d, disc, 20000, 20000 * 24, 40000, 30000, mem(0.4), mem(0.5) * 24, mem(0.6), mem(0.5), 512 * GIB);
    hostDay.run(vcId, 'esx2', d, 0, 50000, 50000 * 24, 90000, 60000, mem(0.7), mem(0.8) * 24, mem(0.9), mem(0.8), 512 * GIB);
  }
  db.prepare(`
    INSERT INTO vcenter_host_capacity_history (vcenter_id, captured_at, host_name, cluster_name, connection_state, in_maintenance,
      vm_count, cpu_mhz_capacity, cpu_mhz_used, mem_bytes_capacity, mem_bytes_used, uptime_seconds)
    VALUES (?, datetime('now', '-2 hours'), 'esx1', 'cl', 'CONNECTED', 0, 10, 100000, 25000, ?, ?, 3600)
  `).run(vcId, 512 * GIB, 256 * GIB);

  // Datastores: ds-grow rises 100 GiB a day over five days (1000 GiB), ds-short has only two days.
  const dsIns = db.prepare(`
    INSERT INTO vcenter_datastore_history (vcenter_id, captured_at, datastore_name, capacity_bytes, free_bytes)
    VALUES (?, datetime('now', ?), ?, ?, ?)
  `);
  for (let i = 4; i >= 0; i--) {
    dsIns.run(vcId, `-${i} days`, 'ds-grow', 1000 * GIB, (1000 - 100 * (5 - i)) * GIB);
    // a flat datastore: five days, no growth
    dsIns.run(vcId, `-${i} days`, 'ds-grow-early', 1000 * GIB, 900 * GIB);
  }
  dsIns.run(vcId, '-1 days', 'ds-short', 1000 * GIB, 800 * GIB);
  dsIns.run(vcId, '0 days', 'ds-short', 1000 * GIB, 700 * GIB);
  const dsNow = db.prepare(`
    INSERT INTO vcenter_datastores (vcenter_id, datastore_id, name, ds_type, capacity_bytes, free_bytes, accessible) VALUES (?, ?, ?, 'VMFS', ?, ?, 1)
  `);
  dsNow.run(vcId, 'd1', 'ds-grow', 1000 * GIB, 500 * GIB);
  dsNow.run(vcId, 'd2', 'ds-short', 1000 * GIB, 700 * GIB);
  dsNow.run(vcId, 'd3', 'ds-none', 1000 * GIB, 700 * GIB);

  app = express();
  app.use(express.json());
  app.use('/api/vcenter', require('../routes/vcenter'));
});

describe('vCenter history routes', () => {
  it('vm-trends: daily granularity beyond 7 days with average, band and summary', async () => {
    const res = await get(`/capacity/vm-trends?vcenterId=${vcId}&vm=web01&days=30`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ vm: 'web01', vcenterId: vcId, days: 30, granularity: 'day' });
    expect(res.body.points).toHaveLength(3);
    const p = res.body.points[1];
    expect(p).toMatchObject({ cpuUsageMhz: 2000, cpuMinMhz: 1000, cpuMaxMhz: 3000, memUsageMb: 6000, memMinMb: 5500, memMaxMb: 6500, onPct: 100, samples: 24, powerState: null });
    expect(res.body.points[2].onPct).toBe(50);
    // weighted average: (24000 + 48000 + 36000) / 60 samples
    expect(res.body.summary).toMatchObject({ cpuAvgMhz: 1800, cpuMaxMhz: 4000, memMaxMb: 7500, cpuNowMhz: 900, memNowMb: 4000, cpuCount: 4, memoryMb: 8192, samples: 60 });
    expect(res.body.summary.memAvgMb).toBe(Math.round((96000 + 144000 + 84000) / 60));
  });

  it('vm-trends: raw rows for 7 days or less, and parameter checks', async () => {
    const res = await get(`/capacity/vm-trends?vcenterId=${vcId}&vm=web01&days=7`);
    expect(res.body.granularity).toBe('hour');
    expect(res.body.points).toHaveLength(1);
    expect(res.body.points[0]).toMatchObject({ cpuUsageMhz: 800, cpuMinMhz: 800, cpuMaxMhz: 800, onPct: 100, samples: 1 });
    expect((await get('/capacity/vm-trends?vcenterId=1')).status).toBe(400);
    expect((await get(`/capacity/vm-trends?vcenterId=${vcId}&vm=web01&days=400`)).status).toBe(400);
  });

  it('host-trends: daily percentages and summary, raw rows for short windows', async () => {
    const res = await get(`/capacity/host-trends?vcenterId=${vcId}&host=esx1&days=30`);
    expect(res.status).toBe(200);
    expect(res.body.granularity).toBe('day');
    expect(res.body.points).toHaveLength(2);
    expect(res.body.points[0]).toMatchObject({ cpuUsedMhz: 20000, cpuMinMhz: 20000, cpuMaxMhz: 40000, cpuCapacityMhz: 100000, disconnectedPct: 25, uptimeSeconds: 86400, vmCount: 10, samples: 24 });
    expect(res.body.summary).toMatchObject({ cpuAvgPct: 20, cpuMaxPct: 40, memAvgPct: 50, memMaxPct: 60, disconnectedPct: 12.5, maintenancePct: 0, samples: 48 });
    const raw = await get(`/capacity/host-trends?vcenterId=${vcId}&host=esx1&days=1`);
    expect(raw.body.granularity).toBe('hour');
    expect(raw.body.points).toHaveLength(1);
    expect(raw.body.points[0]).toMatchObject({ cpuUsedMhz: 25000, disconnectedPct: 0, memCapacityBytes: 512 * GIB });
  });

  it('host-daily: one row per host sorted by memory average, cluster filter works', async () => {
    const res = await get('/capacity/host-daily?days=30');
    expect(res.status).toBe(200);
    expect(res.body.hosts.map((h) => h.host)).toEqual(['esx2', 'esx1']);
    expect(res.body.hosts[0]).toMatchObject({ vcenterId: vcId, cluster: 'cl', cpuAvgPct: 50, cpuMaxPct: 90, memAvgPct: 80, memMaxPct: 90, disconnectedPct: 0, vmCount: 10, samples: 48, days: 2 });
    expect(res.body.hosts[1].disconnectedPct).toBe(12.5);
    const one = await get(`/capacity/host-daily?cluster=${encodeURIComponent(`${vcId}|cl`)}&days=30`);
    expect(one.body.hosts).toHaveLength(2);
    const none = await get(`/capacity/host-daily?cluster=${encodeURIComponent(`${vcId}|other`)}&days=30`);
    expect(none.body.hosts).toHaveLength(0);
    expect((await get('/capacity/host-daily?days=3')).status).toBe(400);
  });

  it('datastore-trends: daily last sample, least-squares growth and days to full', async () => {
    const res = await get(`/capacity/datastore-trends?vcenterId=${vcId}&datastore=ds-grow&days=30`);
    expect(res.status).toBe(200);
    expect(res.body.granularity).toBe('day');
    expect(res.body.points).toHaveLength(5);
    expect(res.body.points[4]).toMatchObject({ capacityBytes: 1000 * GIB, freeBytes: 500 * GIB, usedBytes: 500 * GIB, usedPct: 50 });
    expect(res.body.growth.basisDays).toBe(5);
    expect(res.body.growth.usedBytesPerDay / GIB).toBeCloseTo(100, 1);
    expect(res.body.growth.daysToFull).toBeCloseTo(5, 1);
  });

  it('datastore-trends: a flat datastore has no days to full, and fewer than 3 days gives no growth', async () => {
    const early = await get(`/capacity/datastore-trends?vcenterId=${vcId}&datastore=ds-grow-early&days=30`);
    expect(early.body.points).toHaveLength(5);
    const short = await get(`/capacity/datastore-trends?vcenterId=${vcId}&datastore=ds-short&days=30`);
    expect(short.body.points).toHaveLength(2);
    expect(short.body.growth).toBeNull();
    const raw = await get(`/capacity/datastore-trends?vcenterId=${vcId}&datastore=ds-grow&days=7`);
    expect(raw.body.granularity).toBe('hour');
    expect((await get(`/capacity/datastore-trends?vcenterId=${vcId}&datastore=ds-grow&days=2000`)).status).toBe(400);
  });

  it('/datastores carries growth fields from the last 30 days', async () => {
    const res = await get('/datastores');
    expect(res.status).toBe(200);
    const by = Object.fromEntries(res.body.map((d) => [d.name, d]));
    expect(by['ds-grow'].usedBytesPerDay / GIB).toBeCloseTo(100, 0);
    expect(by['ds-grow'].daysToFull).toBeCloseTo(5, 0);
    expect(by['ds-grow'].trendBasisDays).toBe(5);
    expect(by['ds-short'].usedBytesPerDay).toBeNull();
    expect(by['ds-short'].daysToFull).toBeNull();
    expect(by['ds-none'].usedBytesPerDay).toBeNull();
    expect(by['ds-none'].trendBasisDays).toBe(0);
  });

  it('config: retention keys round trip with defaults and reject out-of-range values', async () => {
    const first = await get('/config');
    expect(first.body).toMatchObject({
      vmHistoryDays: 90, hostHistoryDays: 90, clusterHistoryDays: 365, datastoreHistoryDays: 365, dailyHistoryDays: 730, eventRetentionDays: 90,
    });
    const put = await request(app).put('/api/vcenter/config').send({ vmHistoryDays: 120, dailyHistoryDays: 1000, eventRetentionDays: 14 });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ saved: true, vmHistoryDays: 120, dailyHistoryDays: 1000, eventRetentionDays: 14, hostHistoryDays: 90 });
    expect((await get('/config')).body).toMatchObject({ vmHistoryDays: 120, dailyHistoryDays: 1000, eventRetentionDays: 14 });
    for (const bad of [{ vmHistoryDays: 10 }, { vmHistoryDays: 400 }, { clusterHistoryDays: 50 }, { eventRetentionDays: 2 }, { dailyHistoryDays: 2000 }]) {
      expect((await request(app).put('/api/vcenter/config').send(bad)).status).toBe(400);
    }
    // thresholds are untouched by a retention save
    expect((await get('/config')).body).toMatchObject({ certWarnDays: 60, guestDiskWarnPct: 80 });
    db.prepare("DELETE FROM app_settings WHERE key LIKE 'vcenter_%_days'").run();
  });
});
