/**
 * Self-contained Proxmox VE platform backend test (WP1). Runs the proxmox
 * migration into the shared per-file test DB, exercises proxmoxIssues
 * compute/reconcile against seeded rows for every rule, a minimal express
 * app wired to routes/proxmox.js, and the plugin dispatcher end-to-end
 * (mirrors tests/awsPlugin.test.js).
 *
 * Loaded via createRequire (not ESM import) so every service module below
 * resolves the SAME db/database.js singleton instance as app.js.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const proxmoxMigrations = require('../db/migrations/proxmox');
const { encrypt } = require('../services/encryption');

beforeAll(() => {
  runMigrations(db, 'proxmox', proxmoxMigrations);
});

function insertServer(overrides = {}) {
  const info = db.prepare(`
    INSERT INTO proxmox_servers (name, host, port, token_id, encrypted_credentials,
      ssl_verify, polling_interval_minutes, last_poll_status, last_poll_error, quorate, forbidden_endpoints)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.name ?? 'pve1',
    overrides.host ?? '10.0.0.10',
    overrides.port ?? 8006,
    overrides.token_id ?? 'root@pam!icc',
    overrides.encrypted_credentials !== undefined ? overrides.encrypted_credentials : encrypt(JSON.stringify({ tokenSecret: 'shh' })),
    overrides.ssl_verify ?? 0,
    overrides.polling_interval_minutes ?? 10,
    overrides.last_poll_status ?? null,
    overrides.last_poll_error ?? null,
    overrides.quorate ?? null,
    overrides.forbidden_endpoints ?? null,
  );
  return info.lastInsertRowid;
}

describe('proxmoxIssues.computeIssues + reconcileIssueHistory', () => {
  it('detects every issue rule from seeded rows', () => {
    const { computeIssues, reconcileIssueHistory } = require('../services/proxmoxIssues');

    const serverId = insertServer({
      name: 'pve-issues', quorate: 0, forbidden_endpoints: JSON.stringify(['cluster/resources']),
    });

    // node-offline
    db.prepare(`
      INSERT INTO proxmox_nodes (server_id, name, status) VALUES (?, 'node-down', 'offline')
    `).run(serverId);

    // storage-full / storage-warn
    db.prepare(`
      INSERT INTO proxmox_storage (server_id, node, storage, used_bytes, total_bytes)
      VALUES (?, 'node-down', 'local-crit', 970, 1000)
    `).run(serverId);
    db.prepare(`
      INSERT INTO proxmox_storage (server_id, node, storage, used_bytes, total_bytes)
      VALUES (?, 'node-down', 'local-warn', 880, 1000)
    `).run(serverId);
    db.prepare(`
      INSERT INTO proxmox_storage (server_id, node, storage, used_bytes, total_bytes)
      VALUES (?, 'node-down', 'local-ok', 100, 1000)
    `).run(serverId);

    // backup-failed: vzdump task failed within last 7 days.
    db.prepare(`
      INSERT INTO proxmox_guests (server_id, vmid, name, type, node, status, is_template)
      VALUES (?, 100, 'web-1', 'qemu', 'node-down', 'running', 0)
    `).run(serverId);
    db.prepare(`
      INSERT INTO proxmox_tasks (server_id, upid, node, type, target, status, started_at, ended_at)
      VALUES (?, 'UPID:failed', 'node-down', 'vzdump', '100', 'job errors', datetime('now', '-1 day'), datetime('now', '-1 day'))
    `).run(serverId);

    // task-failed: non-vzdump task failed within last 24h.
    db.prepare(`
      INSERT INTO proxmox_tasks (server_id, upid, node, type, target, status, started_at, ended_at)
      VALUES (?, 'UPID:migrate-fail', 'node-down', 'qmigrate', '100', 'failed', datetime('now', '-1 hour'), datetime('now', '-1 hour'))
    `).run(serverId);

    // backup-stale: non-template guest with no successful backup + a backup job exists.
    db.prepare(`
      INSERT INTO proxmox_guests (server_id, vmid, name, type, node, status, is_template)
      VALUES (?, 101, 'stale-guest', 'lxc', 'node-down', 'running', 0)
    `).run(serverId);
    db.prepare(`
      INSERT INTO proxmox_backup_jobs (server_id, job_id, enabled, storage, selection)
      VALUES (?, 'job1', 1, 'local', 'all')
    `).run(serverId);

    // cert-expiring
    db.prepare(`
      UPDATE proxmox_nodes SET cert_expires_at = datetime('now', '+10 days') WHERE server_id = ? AND name = 'node-down'
    `).run(serverId);

    const issues = computeIssues();
    const byType = (type) => issues.filter((i) => i.type === type);

    expect(byType('node-offline')).toHaveLength(1);
    expect(byType('node-offline')[0].severity).toBe('critical');
    expect(byType('node-offline')[0].target).toBe('node-down');

    expect(byType('storage-full').some((i) => i.target === 'node-down/local-crit')).toBe(true);
    expect(byType('storage-warn').some((i) => i.target === 'node-down/local-warn')).toBe(true);
    expect(byType('storage-full').some((i) => i.target === 'node-down/local-ok')).toBe(false);

    expect(byType('backup-failed').some((i) => i.target === 'web-1 (100)')).toBe(true);
    expect(byType('backup-failed')[0].severity).toBe('critical');

    expect(byType('task-failed').some((i) => i.target === 'qmigrate on node-down')).toBe(true);

    expect(byType('backup-stale').some((i) => i.target === 'stale-guest (101)')).toBe(true);

    expect(byType('cert-expiring').some((i) => i.target === 'node-down')).toBe(true);

    expect(byType('quorum-lost')).toHaveLength(1);
    expect(byType('quorum-lost')[0].source).toBe('pve-issues');

    expect(byType('token-permissions')).toHaveLength(1);
    expect(byType('token-permissions')[0].source).toBe('pve-issues');

    const severityRank = { critical: 0, warning: 1, info: 2 };
    for (let i = 1; i < issues.length; i++) {
      expect(severityRank[issues[i - 1].severity]).toBeLessThanOrEqual(severityRank[issues[i].severity]);
    }

    reconcileIssueHistory();
    const openRows = db.prepare("SELECT * FROM proxmox_issue_history WHERE status = 'open' AND source_id = ?").all(serverId);
    expect(openRows.length).toBe(issues.filter((i) => i.sourceId === serverId).length);

    // Resolve node-offline by fixing status, reconcile again -> flips to resolved.
    db.prepare("UPDATE proxmox_nodes SET status = 'online' WHERE server_id = ? AND name = 'node-down'").run(serverId);
    reconcileIssueHistory();
    const resolved = db.prepare(
      'SELECT * FROM proxmox_issue_history WHERE issue_key = ? AND source_id = ?'
    ).get('node-offline|pve-issues|node-down', serverId);
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolved_at).not.toBeNull();
  });

  it('clamps thresholds to their documented defaults', () => {
    const { storageWarnPct, storageCritPct, backupStaleDays, certWarnDays, snapshotAgeDays } = require('../services/proxmoxIssues');
    expect(storageWarnPct()).toBe(85);
    expect(storageCritPct()).toBe(95);
    expect(backupStaleDays()).toBe(3);
    expect(certWarnDays()).toBe(30);
    expect(snapshotAgeDays()).toBe(30);
  });

  it('detects the v2 issue rules: snapshot-age, service-down, smart-failing', () => {
    const { computeIssues } = require('../services/proxmoxIssues');
    const serverId = insertServer({ name: 'pve-v2-issues' });

    db.prepare(`
      INSERT INTO proxmox_guests (server_id, vmid, name, type, node, status, is_template)
      VALUES (?, 200, 'snap-guest', 'qemu', 'n1', 'running', 0)
    `).run(serverId);
    db.prepare(`
      INSERT INTO proxmox_snapshots (server_id, vmid, guest_name, name, snap_time)
      VALUES (?, 200, 'snap-guest', 'old-snap', datetime('now', '-45 days'))
    `).run(serverId);
    db.prepare(`
      INSERT INTO proxmox_snapshots (server_id, vmid, guest_name, name, snap_time)
      VALUES (?, 200, 'snap-guest', 'current', datetime('now', '-90 days'))
    `).run(serverId);

    db.prepare(`
      INSERT INTO proxmox_services (server_id, node, name, state, active_state, unit_state)
      VALUES (?, 'n1', 'pvescheduler', 'dead', 'inactive', 'enabled')
    `).run(serverId);

    db.prepare(`
      INSERT INTO proxmox_disks (server_id, node, devpath, health)
      VALUES (?, 'n1', '/dev/sda', 'FAILED')
    `).run(serverId);

    const issues = computeIssues();
    const byType = (type) => issues.filter((i) => i.sourceId === serverId && i.type === type);

    expect(byType('snapshot-age').some((i) => i.target === 'snap-guest (200): old-snap')).toBe(true);
    expect(byType('snapshot-age').some((i) => i.target.includes('current'))).toBe(false);

    expect(byType('service-down').some((i) => i.target === 'pvescheduler on n1')).toBe(true);

    expect(byType('smart-failing').some((i) => i.target === '/dev/sda on n1')).toBe(true);
    expect(byType('smart-failing')[0].severity).toBe('critical');
  });
});

describe('routes/proxmox.js basic CRUD + data endpoints (minimal express app, no dispatcher)', () => {
  let app;

  beforeAll(() => {
    const proxmoxRouter = require('../routes/proxmox');
    app = express();
    app.use(express.json());
    app.use('/api/proxmox', proxmoxRouter);
  });

  it('GET /api/proxmox/servers lists registered servers, never leaking the secret', async () => {
    const res = await request(app).get('/api/proxmox/servers');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const row of res.body) {
      expect(row.encryptedCredentials).toBeUndefined();
      expect(row.tokenSecret).toBeUndefined();
      expect(typeof row.hasCredentials).toBe('boolean');
    }
  });

  it('POST/PUT/DELETE /api/proxmox/servers round-trips, PUT keeps secret when blank, 409 on dup name', async () => {
    const created = await request(app).post('/api/proxmox/servers').send({
      name: 'crud-test-server', host: '10.0.0.20', tokenId: 'root@pam!crud', tokenSecret: 's3cr3t',
    });
    expect(created.status).toBe(201);
    expect(created.body.id).toBeTypeOf('number');
    expect(created.body.tokenId).toBe('root@pam!crud');
    expect(created.body.hasCredentials).toBe(true);
    expect(created.body.tokenSecret).toBeUndefined();
    const serverId = created.body.id;

    const dup = await request(app).post('/api/proxmox/servers').send({
      name: 'crud-test-server', host: '10.0.0.99', tokenId: 'x', tokenSecret: 'y',
    });
    expect(dup.status).toBe(409);

    const before = db.prepare('SELECT encrypted_credentials FROM proxmox_servers WHERE id = ?').get(serverId).encrypted_credentials;
    const updated = await request(app).put(`/api/proxmox/servers/${serverId}`).send({ pollingIntervalMinutes: 20 });
    expect(updated.status).toBe(200);
    expect(updated.body.pollingIntervalMinutes).toBe(20);
    const after = db.prepare('SELECT encrypted_credentials FROM proxmox_servers WHERE id = ?').get(serverId).encrypted_credentials;
    expect(after).toBe(before); // blank tokenSecret on PUT keeps stored credential

    const deleted = await request(app).delete(`/api/proxmox/servers/${serverId}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ ok: true });
  });

  it('GET/PUT /api/proxmox/config round-trips clamped thresholds', async () => {
    const before = await request(app).get('/api/proxmox/config');
    expect(before.status).toBe(200);
    expect(before.body).toEqual({
      storageWarnPct: 85, storageCritPct: 95, backupStaleDays: 3, certWarnDays: 30, snapshotAgeDays: 30,
    });

    const saved = await request(app).put('/api/proxmox/config').send({
      storageWarnPct: 80, storageCritPct: 90, backupStaleDays: 5, certWarnDays: 45, snapshotAgeDays: 60,
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({
      storageWarnPct: 80, storageCritPct: 90, backupStaleDays: 5, certWarnDays: 45, snapshotAgeDays: 60,
    });

    const invalid = await request(app).put('/api/proxmox/config').send({
      storageWarnPct: 0, storageCritPct: 90, backupStaleDays: 5, certWarnDays: 45, snapshotAgeDays: 60,
    });
    expect(invalid.status).toBe(400);

    // restore defaults
    await request(app).put('/api/proxmox/config').send({
      storageWarnPct: 85, storageCritPct: 95, backupStaleDays: 3, certWarnDays: 30, snapshotAgeDays: 30,
    });
  });

  it('GET /api/proxmox/overview returns the fleet rollup shape', async () => {
    const res = await request(app).get('/api/proxmox/overview');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.servers)).toBe(true);
    expect(res.body.totals).toEqual(expect.objectContaining({
      nodes: expect.any(Number), nodesOnline: expect.any(Number),
      guests: expect.any(Number), guestsRunning: expect.any(Number),
      vms: expect.any(Number), containers: expect.any(Number), templates: expect.any(Number),
      storagePools: expect.any(Number), storageUsedBytes: expect.any(Number), storageTotalBytes: expect.any(Number),
      openIssues: expect.any(Number), criticalIssues: expect.any(Number),
    }));
  });

  it('GET /api/proxmox/issues returns a bare computed-issue array', async () => {
    const res = await request(app).get('/api/proxmox/issues');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/proxmox/issue-history returns a BARE array', async () => {
    const res = await request(app).get('/api/proxmox/issue-history');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const row of res.body) {
      expect(row).toHaveProperty('issueKey');
      expect(row).toHaveProperty('source');
      expect(row).toHaveProperty('firstSeen');
      expect(row).toHaveProperty('lastSeen');
    }
  });

  it('GET /api/proxmox/nodes|guests|storage|backups|tasks|metrics-history all 200 with camelCase shapes', async () => {
    const checks = [
      ['nodes', (b) => Array.isArray(b)],
      ['guests', (b) => Array.isArray(b)],
      ['storage', (b) => Array.isArray(b)],
      ['backups', (b) => Array.isArray(b.jobs) && Array.isArray(b.recentTasks)],
      ['tasks', (b) => Array.isArray(b)],
      ['metrics-history', (b) => Array.isArray(b)],
    ];
    for (const [path, shapeOk] of checks) {
      const res = await request(app).get(`/api/proxmox/${path}`);
      expect(res.status, `GET /api/proxmox/${path}`).toBe(200);
      expect(shapeOk(res.body), `GET /api/proxmox/${path} body shape`).toBe(true);
    }
  });

  it('GET /api/proxmox/network|disks|storage-content|events|snapshots all 200 bare arrays', async () => {
    const serverId = insertServer({ name: 'pve-v2-data' });
    db.prepare(`INSERT INTO proxmox_nodes (server_id, name, status) VALUES (?, 'n1', 'online')`).run(serverId);
    db.prepare(`
      INSERT INTO proxmox_node_networks (server_id, node, iface, iface_type, method, active, autostart)
      VALUES (?, 'n1', 'vmbr0', 'bridge', 'static', 1, 1)
    `).run(serverId);
    db.prepare(`
      INSERT INTO proxmox_disks (server_id, node, devpath, model, health)
      VALUES (?, 'n1', '/dev/sda', 'HP Smart Array', 'UNKNOWN')
    `).run(serverId);
    db.prepare(`
      INSERT INTO proxmox_storage_content (server_id, node, storage, volid, content, size_bytes)
      VALUES (?, 'n1', 'local', 'local:backup/vzdump-qemu-100.vma.zst', 'backup', 12345)
    `).run(serverId);
    db.prepare(`
      INSERT INTO proxmox_events (server_id, event_key, node, event_time, user, tag, pri, message)
      VALUES (?, 'evt1:1', 'n1', datetime('now'), 'root@pam', 'vzdump', 6, 'backup finished')
    `).run(serverId);
    db.prepare(`
      INSERT INTO proxmox_guests (server_id, vmid, name, type, node, status, is_template)
      VALUES (?, 300, 'snap-list-guest', 'qemu', 'n1', 'running', 0)
    `).run(serverId);
    db.prepare(`
      INSERT INTO proxmox_snapshots (server_id, vmid, guest_name, name, snap_time)
      VALUES (?, 300, 'snap-list-guest', 'snap-a', datetime('now', '-1 day'))
    `).run(serverId);

    const checks = ['network', 'disks', 'storage-content', 'events', 'snapshots'];
    for (const path of checks) {
      const res = await request(app).get(`/api/proxmox/${path}`);
      expect(res.status, `GET /api/proxmox/${path}`).toBe(200);
      expect(Array.isArray(res.body), `GET /api/proxmox/${path} body`).toBe(true);
    }

    const network = (await request(app).get('/api/proxmox/network')).body;
    expect(network.some((r) => r.iface === 'vmbr0' && r.ifaceType === 'bridge')).toBe(true);

    const disks = (await request(app).get('/api/proxmox/disks')).body;
    expect(disks.some((r) => r.devpath === '/dev/sda' && r.health === 'UNKNOWN')).toBe(true);

    const content = (await request(app).get('/api/proxmox/storage-content?content=backup')).body;
    expect(content.every((r) => r.content === 'backup')).toBe(true);

    const events = (await request(app).get('/api/proxmox/events?limit=5')).body;
    expect(events.some((r) => r.tag === 'vzdump')).toBe(true);

    const snapshots = (await request(app).get('/api/proxmox/snapshots')).body;
    expect(snapshots.some((r) => r.name === 'snap-a' && r.guestName === 'snap-list-guest')).toBe(true);
  });

  it('GET /api/proxmox/guests/:id/detail parses config device/net keys and returns snapshots', async () => {
    const serverId = insertServer({ name: 'pve-detail' });
    const config = {
      name: 'detail-vm', cores: 2, sockets: 1, memory: '4096', agent: 1,
      scsi0: 'local-lvm:vm-100-disk-0,size=32G',
      net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,tag=10',
    };
    const info = db.prepare(`
      INSERT INTO proxmox_guests (server_id, vmid, name, type, node, status, is_template,
        cpu_sockets, config_json, os_name, ip_addresses, agent_running, snapshot_count, oldest_snapshot_at)
      VALUES (?, 400, 'detail-vm', 'qemu', 'n1', 'running', 0, 1, ?, 'Linux', ?, 1, 1, datetime('now', '-1 day'))
    `).run(serverId, JSON.stringify(config), JSON.stringify(['10.0.0.5']));
    const guestId = info.lastInsertRowid;
    db.prepare(`
      INSERT INTO proxmox_snapshots (server_id, vmid, guest_name, name, snap_time)
      VALUES (?, 400, 'detail-vm', 'before-upgrade', datetime('now', '-1 day'))
    `).run(serverId);
    db.prepare(`
      INSERT INTO proxmox_snapshots (server_id, vmid, guest_name, name, snap_time)
      VALUES (?, 400, 'detail-vm', 'current', datetime('now'))
    `).run(serverId);

    const res = await request(app).get(`/api/proxmox/guests/${guestId}/detail`);
    expect(res.status).toBe(200);
    expect(res.body.guest.osName).toBe('Linux');
    expect(res.body.guest.ipAddresses).toEqual(['10.0.0.5']);
    expect(res.body.guest.agentRunning).toBe(true);
    expect(res.body.config.name).toBe('detail-vm');
    expect(res.body.disks).toEqual([{ key: 'scsi0', storage: 'local-lvm:vm-100-disk-0', size: '32G', raw: config.scsi0 }]);
    expect(res.body.nics).toEqual([{ key: 'net0', model: 'virtio', mac: 'AA:BB:CC:DD:EE:FF', bridge: 'vmbr0', tag: '10', raw: config.net0 }]);
    expect(res.body.snapshots).toHaveLength(1);
    expect(res.body.snapshots[0].name).toBe('before-upgrade');

    const missing = await request(app).get('/api/proxmox/guests/999999/detail');
    expect(missing.status).toBe(404);
  });

  it('GET /api/proxmox/storage/:id/guests correlates guests via config_json volume prefixes', async () => {
    const serverId = insertServer({ name: 'pve-stcorr', host: 'stcorr.local' });
    const stInfo = db.prepare(`
      INSERT INTO proxmox_storage (server_id, node, storage, type, content, active, shared, used_bytes, total_bytes)
      VALUES (?, 'n1', 'ds920', 'nfs', 'images,iso', 1, 0, 100, 1000)
    `).run(serverId);
    const stId = stInfo.lastInsertRowid;
    db.prepare(`
      INSERT INTO proxmox_guests (server_id, vmid, name, type, node, status, is_template, config_json)
      VALUES (?, 600, 'on-ds920', 'qemu', 'n1', 'running', 0, ?)
    `).run(serverId, JSON.stringify({ scsi0: 'ds920:600/vm-600-disk-0.qcow2,size=50G', ide2: 'ds920:iso/x.iso,media=cdrom,size=1G', net0: 'virtio=AA:AA:AA:AA:AA:AA,bridge=vmbr0' }));
    db.prepare(`
      INSERT INTO proxmox_guests (server_id, vmid, name, type, node, status, is_template, config_json)
      VALUES (?, 601, 'lxc-on-ds920', 'lxc', 'n1', 'running', 0, ?)
    `).run(serverId, JSON.stringify({ rootfs: 'ds920:601/vm-601-disk-0.raw,size=8G' }));
    db.prepare(`
      INSERT INTO proxmox_guests (server_id, vmid, name, type, node, status, is_template, config_json)
      VALUES (?, 602, 'elsewhere', 'qemu', 'n1', 'running', 0, ?)
    `).run(serverId, JSON.stringify({ scsi0: 'local-lvm:vm-602-disk-0,size=10G' }));

    const res = await request(app).get(`/api/proxmox/storage/${stId}/guests`);
    expect(res.status).toBe(200);
    expect(res.body.map((g) => g.vmid)).toEqual([600, 601]);
    const vm = res.body.find((g) => g.vmid === 600);
    expect(vm.devices).toEqual([
      { key: 'scsi0', volume: 'ds920:600/vm-600-disk-0.qcow2', size: '50G', cdrom: false },
      { key: 'ide2', volume: 'ds920:iso/x.iso', size: '1G', cdrom: true },
    ]);
    expect(res.body.find((g) => g.vmid === 601).devices[0].key).toBe('rootfs');

    const missing = await request(app).get('/api/proxmox/storage/999999/guests');
    expect(missing.status).toBe(404);
  });

  it('GET /api/proxmox/guests/:id/rrd and /nodes/:id/rrd 502 on upstream failure, 404 for unknown id', async () => {
    const serverId = insertServer({ name: 'pve-rrd', host: '127.0.0.1', port: 1 });
    const guestInfo = db.prepare(`
      INSERT INTO proxmox_guests (server_id, vmid, name, type, node, status, is_template)
      VALUES (?, 500, 'rrd-guest', 'qemu', 'n1', 'running', 0)
    `).run(serverId);
    const nodeInfo = db.prepare(`INSERT INTO proxmox_nodes (server_id, name, status) VALUES (?, 'n1', 'online')`).run(serverId);

    const guestRrd = await request(app).get(`/api/proxmox/guests/${guestInfo.lastInsertRowid}/rrd?timeframe=bogus`);
    expect(guestRrd.status).toBe(502);
    expect(typeof guestRrd.body.error).toBe('string');

    const nodeRrd = await request(app).get(`/api/proxmox/nodes/${nodeInfo.lastInsertRowid}/rrd`);
    expect(nodeRrd.status).toBe(502);
    expect(typeof nodeRrd.body.error).toBe('string');

    const missingGuest = await request(app).get('/api/proxmox/guests/999999/rrd');
    expect(missingGuest.status).toBe(404);
    const missingNode = await request(app).get('/api/proxmox/nodes/999999/rrd');
    expect(missingNode.status).toBe(404);
  }, 20000);

  it('GET /api/proxmox/nodes/:id/detail returns services, disks, networks for the node', async () => {
    const serverId = insertServer({ name: 'pve-node-detail' });
    const nodeInfo = db.prepare(`INSERT INTO proxmox_nodes (server_id, name, status) VALUES (?, 'nd1', 'online')`).run(serverId);
    db.prepare(`
      INSERT INTO proxmox_services (server_id, node, name, state, active_state, unit_state)
      VALUES (?, 'nd1', 'sshd', 'running', 'active', 'enabled')
    `).run(serverId);
    db.prepare(`
      INSERT INTO proxmox_disks (server_id, node, devpath, health) VALUES (?, 'nd1', '/dev/sdb', 'PASSED')
    `).run(serverId);
    db.prepare(`
      INSERT INTO proxmox_node_networks (server_id, node, iface, iface_type) VALUES (?, 'nd1', 'eth0', 'eth')
    `).run(serverId);

    const res = await request(app).get(`/api/proxmox/nodes/${nodeInfo.lastInsertRowid}/detail`);
    expect(res.status).toBe(200);
    expect(res.body.services.some((s) => s.name === 'sshd')).toBe(true);
    expect(res.body.disks.some((d) => d.devpath === '/dev/sdb')).toBe(true);
    expect(res.body.networks.some((n) => n.iface === 'eth0')).toBe(true);

    const missing = await request(app).get('/api/proxmox/nodes/999999/detail');
    expect(missing.status).toBe(404);
  });

  it('GET /api/proxmox/guests includes v2 fields (osName, ipAddresses, agentRunning, snapshotCount, oldestSnapshotAt)', async () => {
    const serverId = insertServer({ name: 'pve-guests-v2' });
    db.prepare(`
      INSERT INTO proxmox_guests (server_id, vmid, name, type, node, status, is_template,
        os_name, ip_addresses, agent_running, snapshot_count, oldest_snapshot_at)
      VALUES (?, 600, 'v2-guest', 'qemu', 'n1', 'running', 0, 'Windows 10 Pro', ?, 1, 2, datetime('now', '-5 days'))
    `).run(serverId, JSON.stringify(['192.168.1.50']));

    const res = await request(app).get('/api/proxmox/guests?serverId=' + serverId);
    expect(res.status).toBe(200);
    const guest = res.body.find((g) => g.vmid === 600);
    expect(guest.osName).toBe('Windows 10 Pro');
    expect(guest.ipAddresses).toEqual(['192.168.1.50']);
    expect(guest.agentRunning).toBe(true);
    expect(guest.snapshotCount).toBe(2);
    expect(guest.oldestSnapshotAt).not.toBeNull();
  });

  it('POST /api/proxmox/servers/test never throws with bogus credentials', async () => {
    const res = await request(app).post('/api/proxmox/servers/test').send({
      host: '127.0.0.1', port: 1, tokenId: 'root@pam!fake', tokenSecret: 'not-a-real-secret',
    });
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.error).toBe('string');
  }, 20000);

  it('POST /api/proxmox/servers/:id/refresh 404s for an unknown id', async () => {
    const res = await request(app).post('/api/proxmox/servers/999999/refresh');
    expect(res.status).toBe(404);
  });
});

describe('proxmox platform plugin dispatcher (registered via registry, like awsPlugin.test.js)', () => {
  const registry = require('../core/registry');
  const proxmoxManifest = require('../platforms/proxmox');
  const { createApp } = require('../app');

  const API_KEY = 'test-api-key';
  let app;

  beforeEach(() => {
    registry._reset();
    registry.init();
    registry.registerPlugin(proxmoxManifest);
    app = createApp({ licenseGate: (req, res, next) => next() });
  });

  it('GET /api/proxmox/servers -> 200 [] through the dispatcher when registered+enabled', async () => {
    const res = await request(app).get('/api/proxmox/servers').set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('disabling proxmox returns 404 platform_disabled; re-enabling restores 200', async () => {
    const get = () => request(app).get('/api/proxmox/servers').set('x-api-key', API_KEY);

    registry.setEnabled('proxmox', false);
    const disabledRes = await get();
    expect(disabledRes.status).toBe(404);
    expect(disabledRes.body).toEqual({ error: 'platform_disabled' });

    registry.setEnabled('proxmox', true);
    const enabledRes = await get();
    expect(enabledRes.status).toBe(200);
  });
});
