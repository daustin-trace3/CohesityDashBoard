/**
 * LogicMonitor round 11, WP-S: servers via LogicMonitor.
 * The 'os' catalog family, the three issue types (filesystem, stopped service, NFS mount), the
 * pseudo filesystem skip and per-device fold, the Server 360 OS group, the App Services hint and the
 * /lookup families. Datapoint names and enums are UNVERIFIED against a live portal; rows are
 * seeded by hand.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import request from 'supertest';

const require = createRequire(import.meta.url);
const express = require('express');
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const { encrypt } = require('../services/encryption');
const lmIssues = require('../services/logicmonitorIssues');
const catalog = require('../services/logicmonitorCatalog');
const servers = require('../services/logicmonitorServers');
const platform = require('../platforms/logicmonitor');

const TABLES = ['lm_alerts', 'lm_issue_history', 'lm_ds_metrics_history', 'lm_ds_metrics', 'lm_ds_instances', 'lm_device_datasources', 'lm_devices', 'lm_sources'];

let app;
let sid;
let hdsSeq;

beforeAll(() => {
  runMigrations(db, 'logicmonitor', lmMigrations);
  const router = require('../routes/logicmonitor');
  const errorHandler = require('../middleware/errorHandler');
  app = express();
  app.use(express.json());
  app.use('/api/logicmonitor', router);
  app.use(errorHandler);
});

beforeEach(() => {
  for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("DELETE FROM app_settings WHERE key LIKE 'lm_%'").run();
  sid = db.prepare('INSERT INTO lm_sources (name, company, auth_mode, encrypted_credentials) VALUES (?, ?, ?, ?)')
    .run('Acme', 'acme', 'lmv1', encrypt(JSON.stringify({ accessId: 'a', accessKey: 'b' }))).lastInsertRowid;
  hdsSeq = 1000;
});

function dev(id, name, over = {}) {
  db.prepare(`INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, hostname, device_type, host_status, sdt_status, vendor, role, is_network, site_key, ips_json, stale)
    VALUES (?, ?, ?, ?, ?, 0, 'normal', ?, 'Net-SNMP', 'server', 0, 'phoenix', ?, 0)`)
    .run(sid, id, name, name, over.hostname || name, over.sdt || 'none-none-none', JSON.stringify(over.ips || []));
}

function m(devId, ds, family, instance, metric, value, extra = {}) {
  const hds = (db.prepare('SELECT hds_id FROM lm_ds_instances WHERE source_id = ? AND lm_device_id = ? AND datasource_name = ? LIMIT 1').get(sid, devId, ds) || {}).hds_id || (hdsSeq += 1);
  db.prepare(`INSERT OR IGNORE INTO lm_ds_instances (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, instance_name, stale)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)`).run(sid, devId, hds, ds, family, instance, extra.name || instance);
  db.prepare(`INSERT OR REPLACE INTO lm_ds_metrics (source_id, lm_device_id, hds_id, datasource_name, family, instance_key, metric, datapoint, value, sampled_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sid, devId, hds, ds, family, instance, metric, metric, value, Math.floor(Date.now() / 1000) - 60);
}

const fsRow = (devId, mount, pct) => m(devId, 'SNMP_Filesystem_Usage', 'health', mount, 'fs_used_pct', pct);
const issuesOf = (type) => lmIssues.computeIssues().filter((i) => i.type === type);

describe('catalog family', () => {
  it('registers the os family and matches the Linux and Windows DataSource names', () => {
    expect(catalog.FAMILIES).toContain('os');
    expect(catalog.FAMILY_LABELS.os).toBe('Server OS (via LogicMonitor)');
    for (const name of ['SNMP_Filesystem_Status', 'NetSNMPdiskIO-sda', 'Linux_Sensors_Temperature', 'snmpHR_NFSMount-', 'HostStatus',
      'WinCPU', 'WinMemory', 'WinVolumeUsage-C:', 'WinServices-W32Time', 'WinSystemUptime', 'WinProcessStats-', 'WinEventLog-System']) {
      expect(catalog.catalogFor(name)?.family, name).toBe('os');
    }
  });

  it('keeps the shared health entries and extends the filesystem entry in place', () => {
    for (const name of ['NetSNMPCPUwithCores', 'NetSNMP_Memory_Usage', 'SNMP_Host_Uptime', 'SNMP_Filesystem_Usage']) {
      expect(catalog.catalogFor(name)?.family, name).toBe('health');
    }
    const fsEntry = catalog.catalogFor('SNMP_Filesystem_Usage');
    expect(Object.keys(fsEntry.metrics)).toEqual(['fs_used_pct', 'fs_used_bytes', 'fs_total_bytes', 'fs_free_bytes']);
    expect(fsEntry.history).toBe(true);
    expect(fsEntry.maxInstances).toBe(400);
    expect(catalog.catalogFor('WinCPU').history).toBe(true);
    expect(catalog.catalogFor('WinVolumeUsage-').history).toBe(true);
  });

  it('claims percent used before the byte datapoints', () => {
    const { parseDsBody } = require('../services/logicmonitorMetrics');
    const res = parseDsBody({ dataPoints: ['PercentUsed', 'UsedBytes', 'TotalBytes', 'FreeBytes'], instances: {} }, catalog.catalogFor('SNMP_Filesystem_Usage'));
    expect(res.learned).toMatchObject({ fs_used_pct: 'PercentUsed', fs_used_bytes: 'UsedBytes', fs_total_bytes: 'TotalBytes', fs_free_bytes: 'FreeBytes' });
  });
});

describe('helpers', () => {
  it('skips pseudo filesystems', () => {
    for (const n of ['/proc', '/sys/fs/cgroup', '/dev', '/dev/shm', '/run', '/run/user/1000', 'tmpfs', 'TMPFS']) expect(servers.isPseudoFs(n), n).toBe(true);
    for (const n of ['/', '/var', '/data', '/mnt/run', '/devices', 'C:\\']) expect(servers.isPseudoFs(n), n).toBe(false);
  });

  it('reads stopped services and down mounts', () => {
    expect(servers.serviceIsStopped(1)).toBe(true);
    expect(servers.serviceIsStopped(4)).toBe(false);
    expect(servers.serviceIsStopped('Stopped')).toBe(true);
    expect(servers.serviceIsStopped(null)).toBe(false);
    expect(servers.mountIsDown(0)).toBe(true);
    expect(servers.mountIsDown(10)).toBe(false);
    expect(servers.mountIsDown('stale')).toBe(true);
    expect(servers.mountIsDown(1)).toBe(false);
  });
});

describe('server-filesystem-full', () => {
  it('threshold keys exist with the contract defaults', () => {
    expect(lmIssues.THRESHOLD_DEFS.lm_fs_warn_pct).toMatchObject({ def: 85, min: 50, max: 100 });
    expect(lmIssues.THRESHOLD_DEFS.lm_fs_crit_pct).toMatchObject({ def: 95, min: 50, max: 100 });
  });

  it('warns at 85, is critical at 95 and ignores anything below', () => {
    dev(1, 'lin-a');
    fsRow(1, '/', 84.9);
    fsRow(1, '/var', 85);
    fsRow(1, '/data', 94.9);
    fsRow(1, '/backup', 95);
    const got = issuesOf('server-filesystem-full');
    const by = Object.fromEntries(got.map((i) => [i.target, i.severity]));
    expect(by).toEqual({ 'lin-a /var': 'warning', 'lin-a /data': 'warning', 'lin-a /backup': 'critical' });
    expect(got.find((i) => i.target === 'lin-a /backup').message).toContain('95%');
  });

  it('skips /proc, /sys, /dev, /run and tmpfs even at 100 percent', () => {
    dev(1, 'lin-a');
    for (const mount of ['/proc', '/sys/kernel', '/dev/shm', '/run/lock', 'tmpfs']) fsRow(1, mount, 100);
    fsRow(1, '/', 40);
    expect(issuesOf('server-filesystem-full')).toEqual([]);
  });

  it('reads Windows volumes (vol_used_pct)', () => {
    dev(2, 'win-a');
    m(2, 'WinVolumeUsage-', 'os', 'C:\\', 'vol_used_pct', 96);
    m(2, 'WinVolumeUsage-', 'os', 'D:\\', 'vol_used_pct', 50);
    const got = issuesOf('server-filesystem-full');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ severity: 'critical', target: 'win-a C:\\' });
  });

  it('does not judge another vendor filesystem DataSource such as the F5 one', () => {
    dev(3, 'f5-a');
    m(3, 'F5_BigIP_Filesystem', 'loadbalancer', '/var', 'fs_used_pct', 99);
    expect(issuesOf('server-filesystem-full')).toEqual([]);
  });

  it('folds above lm_tunnel_fold filesystems on one device into a single issue', () => {
    dev(1, 'lin-a');
    for (let i = 1; i <= 7; i += 1) fsRow(1, `/vol${i}`, 90 + i);
    const got = issuesOf('server-filesystem-full');
    expect(got).toHaveLength(1);
    expect(got[0].target).toBe('lin-a (7 filesystems)');
    expect(got[0].severity).toBe('critical');
    expect(got[0].message).toContain('7 filesystems');
    expect(got[0].message).toContain('/vol7');
  });

  it('honours a changed warning threshold and devices in scheduled downtime', () => {
    dev(1, 'lin-a');
    dev(2, 'lin-sdt', { sdt: 'none-SDT-none' });
    fsRow(1, '/', 70);
    fsRow(2, '/', 99);
    expect(issuesOf('server-filesystem-full')).toEqual([]);
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('lm_fs_warn_pct', '60')").run();
    const got = issuesOf('server-filesystem-full');
    expect(got.map((i) => i.target)).toEqual(['lin-a /']);
  });
});

describe('server-service-stopped and server-nfs-mount-down', () => {
  it('raises a warning per stopped Windows service and prints the raw value', () => {
    dev(1, 'win-a');
    m(1, 'WinServices-', 'os', 'W32Time', 'svc_state', 1);
    m(1, 'WinServices-', 'os', 'Spooler', 'svc_state', 4);
    const got = issuesOf('server-service-stopped');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ severity: 'warning', target: 'win-a W32Time' });
    expect(got[0].message).toContain('state reads 1');
  });

  it('folds many stopped services into one issue', () => {
    dev(1, 'win-a');
    for (let i = 1; i <= 7; i += 1) m(1, 'WinServices-', 'os', `svc${i}`, 'svc_state', 1);
    const got = issuesOf('server-service-stopped');
    expect(got).toHaveLength(1);
    expect(got[0].target).toBe('win-a (7 services)');
  });

  it('raises server-nfs-mount-down when a mount reads 0, not 10', () => {
    dev(1, 'lin-a');
    m(1, 'snmpHR_NFSMount-', 'os', '/mnt/backup', 'nfs_mount_state', 0);
    m(1, 'snmpHR_NFSMount-', 'os', '/mnt/home', 'nfs_mount_state', 1);
    m(1, 'snmpHR_NFSMount-', 'os', '/mnt/odd', 'nfs_mount_state', 10);
    const got = issuesOf('server-nfs-mount-down');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ severity: 'warning', target: 'lin-a /mnt/backup' });
  });

  it('does not duplicate CPU and memory: the generic rules still fire from os family rows', () => {
    dev(1, 'win-a');
    m(1, 'WinCPU', 'os', 'cpu', 'cpu_pct', 97);
    m(1, 'WinMemory', 'os', 'memory', 'mem_pct', 50);
    expect(issuesOf('device-cpu-high')).toHaveLength(1);
    expect(issuesOf('device-memory-high')).toEqual([]);
    expect(lmIssues.computeIssues().filter((i) => /^server-/.test(i.type))).toEqual([]);
  });
});

describe('Server 360 OS group', () => {
  it('lists CPU, memory, filesystems over the line, stopped services and uptime', () => {
    dev(1, 'lin-a', { ips: ['10.9.9.9'] });
    m(1, 'NetSNMPCPUwithCores', 'health', 'cpu', 'cpu_pct', 22.5);
    m(1, 'NetSNMP_Memory_Usage', 'health', 'memory', 'mem_pct', 61);
    m(1, 'SNMP_Host_Uptime', 'health', 'uptime', 'uptime_s', 3 * 86400 + 7200);
    fsRow(1, '/data', 97);
    fsRow(1, '/', 30);
    m(1, 'WinServices-', 'os', 'W32Time', 'svc_state', 1);
    const out = platform.server360({ db }, { names: ['lin-a'], ips: [] });
    const g = out.groups.find((x) => x.lines.some((l) => l.startsWith('CPU')));
    expect(g).toBeTruthy();
    expect(g.lines).toEqual(expect.arrayContaining([
      'CPU 22.5%', 'Memory 61%', 'Uptime 3d 2h',
      'Filesystem /data 97% full (critical at 95%)', 'Service stopped: W32Time (state 1)',
    ]));
    expect(g.lines.join('\n')).not.toContain('Filesystem / ');
    expect(g.facts.find((f) => f.label === 'Filesystems Over Warning')).toMatchObject({ value: '1/2', tone: 'crit' });
  });

  it('adds no OS group when the device has no os or health metrics', () => {
    dev(1, 'lin-bare');
    const out = platform.server360({ db }, { names: ['lin-bare'], ips: [] });
    expect(out.groups.some((x) => x.lines.some((l) => l.startsWith('CPU')))).toBe(false);
  });
});

describe('App Services hint', () => {
  const alert = (devId, sev, over = {}) => db.prepare(`INSERT INTO lm_alerts (source_id, lm_alert_id, condition_key, lm_device_id, severity, severity_norm, resource_template_name, instance_name, data_point_name, alert_value, start_epoch, cleared)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(sid, over.id || `A${devId}${sev}`, `K${devId}${sev}`, devId, sev === 'critical' ? 4 : 3, sev, 'WinVolumeUsage-', 'C:', 'PercentUsed', '97', 1700000000);

  it('is null when LogicMonitor does not know the server or it is healthy', () => {
    expect(servers.lmServerHint(db, { names: ['nobody'], ips: [] })).toBeNull();
    dev(1, 'win-a');
    alert(1, 'warning');
    expect(servers.lmServerHint(db, { names: ['win-a'], ips: [] })).toBeNull();
  });

  it('reports an open critical LM alert', () => {
    dev(1, 'win-a');
    alert(1, 'critical');
    const hint = servers.lmServerHint(db, { names: ['win-a'], ips: [] });
    expect(hint).toMatchObject({ device: 'win-a', criticalAlerts: 1, filesystem: null });
    expect(hint.note).toContain('1 open critical LogicMonitor alert');
  });

  it('reports an open critical server-filesystem-full issue', () => {
    dev(1, 'lin-a');
    fsRow(1, '/var', 98);
    lmIssues.reconcileIssueHistory();
    const hint = servers.lmServerHint(db, { names: ['lin-a'], ips: [] });
    expect(hint).toBeTruthy();
    expect(hint.filesystem).toContain('/var');
    expect(hint.criticalAlerts).toBe(0);
  });
});

describe('/lookup', () => {
  it('returns the os and health families with labels from the catalog', async () => {
    dev(1, 'lin-a', { ips: ['10.9.9.9'] });
    m(1, 'NetSNMPCPUwithCores', 'health', 'cpu', 'cpu_pct', 12);
    m(1, 'SNMP_Filesystem_Status', 'os', '/', 'fs_status', 1);
    m(1, 'snmpHR_NFSMount-', 'os', '/mnt/x', 'nfs_mount_state', 1);
    const res = await request(app).get('/api/logicmonitor/lookup').query({ names: 'lin-a' });
    expect(res.status).toBe(200);
    expect(res.body.device.displayName).toBe('lin-a');
    expect(res.body.families.sort()).toEqual(['health', 'os']);
    const nfs = res.body.metrics.find((x) => x.metric === 'nfs_mount_state');
    expect(nfs).toMatchObject({ family: 'os', label: 'NFS mount state', datasourceLabel: 'NFS mounts' });
    const osOnly = await request(app).get('/api/logicmonitor/lookup').query({ names: 'lin-a', family: 'os' });
    expect(osOnly.body.families).toEqual(['os']);
  });
});
