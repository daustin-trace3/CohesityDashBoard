import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { setSetting, getSetting } = require('../services/settings');
const engine = require('../services/agentObservations');
const vcenterObs = require('../services/agentObservations/observers/vcenter');
const vcenterRouter = require('../routes/vcenter');

const obs = (id) => engine.getObserver(id);
const samples = (id) => obs(id).sample(db);
const byLabel = (list) => Object.fromEntries(list.map((s) => [s.label, s]));

let vc;
beforeEach(() => {
  db.exec('DELETE FROM ops_observations; DELETE FROM vcenter_vms; DELETE FROM vcenter_hosts; DELETE FROM vcenter_vcenters;');
  for (const k of ['vm_cpu', 'vm_mem', 'host_cpu', 'host_mem']) { setSetting(`vcenter_${k}_warn_pct`, ''); setSetting(`vcenter_${k}_crit_pct`, ''); }
  vc = db.prepare(`
    INSERT INTO vcenter_vcenters (name, host, username, encrypted_credentials, last_poll_status, last_poll_at)
    VALUES ('vc-obs', 'vc-obs.lab', 'u', 'x', 'success', '2026-10-22 18:00:00')
  `).run().lastInsertRowid;
  const host = db.prepare(`
    INSERT INTO vcenter_hosts (vcenter_id, host_id, name, cluster_name, connection_state, in_maintenance, cpu_cores,
      cpu_mhz_capacity, cpu_mhz_used, mem_bytes_capacity, mem_bytes_used)
    VALUES (?, ?, ?, 'cl1', ?, ?, ?, ?, ?, ?, ?)
  `);
  const GB = 1024 ** 3;
  // 20 cores x 2000 MHz = 40000 MHz capacity -> 2000 MHz per core.
  host.run(vc, 'h1', 'esx-01', 'CONNECTED', 0, 20, 40000, 36000, 256 * GB, 240 * GB);
  host.run(vc, 'h2', 'esx-maint', 'CONNECTED', 1, 20, 40000, 39000, 256 * GB, 250 * GB);
  host.run(vc, 'h3', 'esx-down', 'NOT_RESPONDING', 0, 20, 40000, 39000, 256 * GB, 250 * GB);
  host.run(vc, 'h4', 'esx-nostats', 'CONNECTED', 0, 20, null, null, null, null);
  const vm = db.prepare(`
    INSERT INTO vcenter_vms (vcenter_id, vm_id, name, host_name, cluster_name, power_state, cpu_count, memory_mb, cpu_usage_mhz, mem_usage_mb)
    VALUES (?, ?, ?, ?, 'cl1', ?, ?, ?, ?, ?)
  `);
  // 4 vCPU on a 2000 MHz/core host = 8000 MHz allocation; 8320 MHz used = 104 percent.
  vm.run(vc, 'v1', 'web-01', 'esx-01', 'POWERED_ON', 4, 16384, 8320, 15728);
  vm.run(vc, 'v2', 'off-01', 'esx-01', 'POWERED_OFF', 4, 16384, 8320, 15728);
  vm.run(vc, 'v3', 'idle-01', 'esx-01', 'POWERED_ON', 2, 4096, null, null);
  vm.run(vc, 'v4', 'nohost-01', 'esx-gone', 'POWERED_ON', 2, 4096, 1000, 2048);
});

describe('vCenter VM observers', () => {
  it('CPU percent is usage MHz over vCPU count x the host per-core MHz, the routes/vcenter.js formula', () => {
    const s = byLabel(samples('vcenter:vm-cpu'));
    expect(s['web-01'].value).toBe(104);
    expect(s['web-01']).toMatchObject({
      subjectKey: `vcenter:${vc}:vm:web-01`, host: 'web-01', sourceId: vc, sourceName: 'vc-obs',
      capturedAt: '2026-10-22T18:00:00.000Z',
    });
    expect(s['web-01'].context).toMatchObject({ cpuCount: 4, esxHost: 'esx-01', cluster: 'cl1' });
  });

  it('skips powered-off VMs, VMs without usage and VMs whose host is unknown for CPU', () => {
    const s = byLabel(samples('vcenter:vm-cpu'));
    expect(Object.keys(s)).toEqual(['web-01']);
  });

  it('memory percent is usage MB over configured MB', () => {
    const s = byLabel(samples('vcenter:vm-memory'));
    expect(s['web-01'].value).toBe(96);
    expect(s['web-01'].context.memoryMb).toBe(16384);
    expect(s['nohost-01'].value).toBe(50);
    expect(s['off-01']).toBeUndefined();
    expect(s['idle-01']).toBeUndefined();
  });

  it('does not sample a vCenter whose last poll failed', () => {
    db.prepare("UPDATE vcenter_vcenters SET last_poll_status = 'error'").run();
    expect(samples('vcenter:vm-cpu')).toEqual([]);
    expect(samples('vcenter:host-cpu')).toEqual([]);
  });
});

describe('vCenter host observers', () => {
  it('CPU and memory percent come from quick stats; maintenance, disconnected and stat-less hosts are skipped', () => {
    const cpu = byLabel(samples('vcenter:host-cpu'));
    expect(Object.keys(cpu)).toEqual(['esx-01']);
    expect(cpu['esx-01'].value).toBe(90);
    expect(cpu['esx-01'].context.cpuCores).toBe(20);
    const mem = byLabel(samples('vcenter:host-memory'));
    expect(Object.keys(mem)).toEqual(['esx-01']);
    expect(mem['esx-01'].value).toBe(93.8);
    expect(mem['esx-01'].subjectKey).toBe(`vcenter:${vc}:host:esx-01`);
  });
});

describe('thresholds', () => {
  it('apply the documented defaults', () => {
    expect(obs('vcenter:vm-cpu').thresholds(getSetting)).toEqual({ warn: 90, crit: 100 });
    expect(obs('vcenter:vm-memory').thresholds(getSetting)).toEqual({ warn: 90, crit: 95 });
    expect(obs('vcenter:host-cpu').thresholds(getSetting)).toEqual({ warn: 85, crit: 95 });
    expect(obs('vcenter:host-memory').thresholds(getSetting)).toEqual({ warn: 85, crit: 95 });
  });

  it('read saved values, clamp crit up to warn and fall back on out-of-range values', () => {
    setSetting('vcenter_vm_cpu_warn_pct', '120');
    setSetting('vcenter_vm_cpu_crit_pct', '110');
    expect(obs('vcenter:vm-cpu').thresholds(getSetting)).toEqual({ warn: 120, crit: 120 });
    setSetting('vcenter_vm_mem_warn_pct', '150');
    expect(obs('vcenter:vm-memory').thresholds(getSetting)).toEqual({ warn: 90, crit: 95 });
    setSetting('vcenter_host_mem_warn_pct', '70');
    setSetting('vcenter_host_mem_crit_pct', '80');
    expect(obs('vcenter:host-memory').thresholds(getSetting)).toEqual({ warn: 70, crit: 80 });
  });

  it('ingest of the built-in observer opens an episode for the hot VM only', () => {
    const o = obs('vcenter:vm-cpu');
    const st = { sustainSamples: 3, clearSamples: 2 };
    const c = engine.ingest(o, o.sample(db), '2026-10-22T18:01:00.000Z', st, o.thresholds(getSetting));
    expect(c.opened).toBe(1);
    const row = db.prepare('SELECT * FROM ops_observations').get();
    expect(row).toMatchObject({ subject_label: 'web-01', state: 'watching', last_value: 104, platform: 'vcenter' });
    // Same poll stamp again: no duplicate sample.
    engine.ingest(o, o.sample(db), '2026-10-22T18:02:00.000Z', st, o.thresholds(getSetting));
    expect(db.prepare('SELECT samples FROM ops_observations').get().samples).toBe(1);
  });
});

describe('VM age and hold', () => {
  const NOW = Date.parse('2026-10-22T18:00:00.000Z');
  const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
  const web = () => byLabel(samples('vcenter:vm-cpu'))['web-01'];
  let inst;

  beforeEach(() => {
    db.exec('DELETE FROM aria_deployment_resources; DELETE FROM aria_deployments; DELETE FROM aria_instances; DELETE FROM vcenter_vm_daily;');
    setSetting('ops_obs_vm_min_age_hours', '');
    inst = db.prepare("INSERT INTO aria_instances (name, host, username, encrypted_credentials) VALUES ('ar1', 'ar1.lab', 'u', 'x')").run().lastInsertRowid;
  });

  const deploy = (depId, depName, createdAt, resName) => {
    db.prepare('INSERT INTO aria_deployments (instance_id, deployment_id, name, created_at_src) VALUES (?, ?, ?, ?)').run(inst, depId, depName, createdAt);
    db.prepare("INSERT INTO aria_deployment_resources (instance_id, deployment_id, resource_id, name, type, state) VALUES (?, ?, ?, ?, 'Cloud.vSphere.Machine', 'OK')").run(inst, depId, `r-${depId}`, resName);
  };
  const daily = (name, day) => db.prepare('INSERT INTO vcenter_vm_daily (vcenter_id, vm_name, day) VALUES (?, ?, ?)').run(vc, name, day);
  // The fixture poll stamp is 2026-10-22 18:00:00 UTC, so ages are measured to that instant.

  it('an Aria deployment match by VM name wins over vCenter created_at_src', () => {
    deploy('d1', 'web-tier-03', hoursAgo(20.5), 'WEB-01');
    db.prepare("UPDATE vcenter_vms SET created_at_src = ? WHERE name = 'web-01'").run(hoursAgo(500));
    const s = web();
    expect(s.context).toMatchObject({ createdSource: 'aria', createdDetail: 'web-tier-03', ageHours: 20.5, createdAt: hoursAgo(20.5) });
    expect(s.hold.reason).toBe('new VM, created 20.5 h ago (Aria deployment "web-tier-03"), grace 72 h');
  });

  it('falls back to the guest hostname (before the first dot) for the Aria match', () => {
    deploy('d2', 'pool-a', hoursAgo(10), 'web-guest');
    db.prepare("UPDATE vcenter_vms SET guest_hostname = 'web-guest.corp.example' WHERE name = 'web-01'").run();
    expect(web().context).toMatchObject({ createdSource: 'aria', createdDetail: 'pool-a', ageHours: 10 });
  });

  it('uses vCenter created_at_src when no Aria row matches', () => {
    db.prepare("UPDATE vcenter_vms SET created_at_src = ? WHERE name = 'web-01'").run(hoursAgo(30));
    const s = web();
    expect(s.context).toMatchObject({ createdSource: 'vcenter', createdDetail: null, ageHours: 30 });
    expect(s.hold.reason).toBe('new VM, created 30 h ago (vCenter created date), grace 72 h');
  });

  it('uses ICC first sight only when the VM first day is after the vCenter first day', () => {
    daily('idle-01', '2026-10-01');
    daily('web-01', '2026-10-22');
    const s = web();
    expect(s.context).toMatchObject({ createdSource: 'icc', createdAt: '2026-10-22T00:00:00.000Z', ageHours: 18 });
    expect(s.hold.reason).toBe('new VM, created 18 h ago (first seen by ICC), grace 72 h');
  });

  it('a VM first seen on the vCenter first day has an unknown age and no hold', () => {
    daily('web-01', '2026-10-22');
    daily('idle-01', '2026-10-22');
    const s = web();
    expect(s.hold).toBeUndefined();
    expect(s.context.createdAt).toBeUndefined();
  });

  it('unknown age means no hold', () => {
    const s = web();
    expect(s.hold).toBeUndefined();
    expect(s.context.createdAt).toBeUndefined();
  });

  it('a VM older than the grace carries its age but no hold', () => {
    db.prepare("UPDATE vcenter_vms SET created_at_src = ? WHERE name = 'web-01'").run(hoursAgo(100));
    const s = web();
    expect(s.hold).toBeUndefined();
    expect(s.context).toMatchObject({ createdSource: 'vcenter', ageHours: 100 });
  });

  it('vmMinAgeHours 0 turns the hold off but the context still carries createdAt', () => {
    setSetting('ops_obs_vm_min_age_hours', '0');
    db.prepare("UPDATE vcenter_vms SET created_at_src = ? WHERE name = 'web-01'").run(hoursAgo(5));
    const s = web();
    expect(s.hold).toBeUndefined();
    expect(s.context.createdAt).toBe(hoursAgo(5));
  });

  it('a held sample has hold.until = createdAt + 72 h', () => {
    db.prepare("UPDATE vcenter_vms SET created_at_src = ? WHERE name = 'web-01'").run(hoursAgo(8));
    const s = web();
    expect(s.hold.until).toBe(new Date(Date.parse(hoursAgo(8)) + 72 * 3600000).toISOString());
  });

  it('vmAges returns only VMs with a known age, keyed by vcenter id and lower-cased name', () => {
    expect(vcenterObs.vmAges(db, { nowMs: NOW }).size).toBe(0);
    db.prepare("UPDATE vcenter_vms SET created_at_src = ? WHERE name = 'web-01'").run(hoursAgo(3));
    expect(vcenterObs.vmAges(db, { nowMs: NOW }).get(`${vc}|web-01`)).toMatchObject({ source: 'vcenter' });
  });

  it('host observers carry no age fields', () => {
    db.prepare("UPDATE vcenter_vms SET created_at_src = ? WHERE name = 'web-01'").run(hoursAgo(3));
    const h = byLabel(samples('vcenter:host-cpu'))['esx-01'];
    expect(h.hold).toBeUndefined();
    expect(h.context.createdAt).toBeUndefined();
  });
});

describe('GET/PUT /api/vcenter/config thresholds', () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.auth = { grants: ['*:*:*'] }; next(); });
  app.use('/api/vcenter', vcenterRouter);
  void vcenterObs;

  it('GET returns the eight keys with defaults applied', async () => {
    const res = await request(app).get('/api/vcenter/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      vmCpuWarnPct: 90, vmCpuCritPct: 100, vmMemWarnPct: 90, vmMemCritPct: 95,
      hostCpuWarnPct: 85, hostCpuCritPct: 95, hostMemWarnPct: 85, hostMemCritPct: 95,
    });
  });

  it('PUT saves any subset and reads it back through the settings keys', async () => {
    const res = await request(app).put('/api/vcenter/config').send({ vmCpuWarnPct: 150, vmCpuCritPct: 180, hostMemWarnPct: 80 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ saved: true, vmCpuWarnPct: 150, vmCpuCritPct: 180, hostMemWarnPct: 80, hostMemCritPct: 95 });
    expect(getSetting('vcenter_vm_cpu_warn_pct')).toBe('150');
    expect(getSetting('vcenter_host_mem_warn_pct')).toBe('80');
  });

  it('PUT refuses out-of-range values and crit below warn, saving nothing', async () => {
    for (const body of [{ vmMemWarnPct: 101 }, { vmCpuWarnPct: 201 }, { hostCpuWarnPct: 0 }, { vmMemWarnPct: 'x' }]) {
      const res = await request(app).put('/api/vcenter/config').send(body);
      expect(res.status).toBe(400);
    }
    const bad = await request(app).put('/api/vcenter/config').send({ hostCpuWarnPct: 90, hostCpuCritPct: 80 });
    expect(bad.status).toBe(400);
    expect(getSetting('vcenter_host_cpu_warn_pct')).toBeFalsy();
    const lone = await request(app).put('/api/vcenter/config').send({ vmMemCritPct: 50 });
    expect(lone.status).toBe(400);
  });
});
