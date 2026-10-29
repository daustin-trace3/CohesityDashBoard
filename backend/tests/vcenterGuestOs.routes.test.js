/** GET /api/vcenter/guest-os: classified VMs, rollups and the vCenter filter. */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const vcenterRouter = require('../routes/vcenter');

let app;
let vc1;
let vc2;

const WIN19 = "buildNumber='17763' familyName='Windows' prettyName='Windows Server 2019 Standard, 64-bit (Build 17763)'";
const RHEL94 = "bitness='64' distroName='Red Hat Enterprise Linux' distroVersion='9.4' familyName='Linux' prettyName='Red Hat Enterprise Linux 9.4 (Plow)'";

function addVc(name, pollAt) {
  return db.prepare(`
    INSERT INTO vcenter_vcenters (name, host, username, encrypted_credentials, last_poll_at, last_poll_status)
    VALUES (?, ?, 'admin', 'enc', ?, 'success')
  `).run(name, `${name}.corp.local`, pollAt).lastInsertRowid;
}

beforeAll(() => {
  app = express();
  app.use((req, res, next) => { req.auth = { grants: ['*:*:*'] }; next(); });
  app.use('/api/vcenter', vcenterRouter);

  db.exec('DELETE FROM vcenter_vms');
  db.exec('DELETE FROM vcenter_vcenters');
  vc1 = addVc('go-a', '2026-10-01T10:00:00Z');
  vc2 = addVc('go-b', '2026-10-02T10:00:00Z');
  const ins = db.prepare(`
    INSERT INTO vcenter_vms (vcenter_id, vm_id, name, host_name, cluster_name, power_state, guest_os,
      guest_id, guest_os_running, guest_family, guest_detailed, tools_version_status, cpu_count, memory_mb)
    VALUES (?, ?, ?, 'esx1', 'cl1', ?, ?, ?, ?, ?, ?, ?, 2, 4096)
  `);
  // vc1: 2 RHEL 9 (one detailed 9.4 on, one configured off), 1 Windows 2019 detailed on
  ins.run(vc1, 'v1', 'a-rhel-1', 'POWERED_ON', 'Red Hat Enterprise Linux 9 (64-bit)', 'rhel9_64Guest', 'Red Hat Enterprise Linux 9 (64-bit)', 'linuxGuest', RHEL94, 'guestToolsCurrent');
  ins.run(vc1, 'v2', 'a-rhel-2', 'POWERED_OFF', 'Red Hat Enterprise Linux 9 (64-bit)', null, null, null, null, 'guestToolsNeedUpgrade');
  ins.run(vc1, 'v3', 'a-win-1', 'POWERED_ON', 'Microsoft Windows Server 2019 (64-bit)', 'windows2019srv_64Guest', null, null, WIN19, 'guestToolsCurrent');
  // vc2: 1 Windows 2019 configured only on, 1 Other Linux on
  ins.run(vc2, 'v4', 'b-win-1', 'POWERED_ON', 'Microsoft Windows Server 2019 (64-bit)', null, null, null, null, 'guestToolsCurrent');
  ins.run(vc2, 'v5', 'b-oth-1', 'POWERED_ON', 'Other Linux (64-bit)', null, null, null, null, 'guestToolsCurrent');
});

describe('GET /api/vcenter/guest-os', () => {
  it('rolls up the whole estate', async () => {
    const res = await request(app).get('/api/vcenter/guest-os');
    expect(res.status).toBe(200);
    expect(res.body.lastPolled).toBe('2026-10-02T10:00:00Z');
    expect(res.body.vms).toHaveLength(5);
    expect(res.body.summary).toEqual({
      vms: 5, poweredOn: 4, poweredOff: 1, windows: 2, linux: 3, other: 0, unknown: 0,
      detailed: 2, toolsReported: 0, configuredOnly: 3, toolsOutdated: 1,
    });
    const byLabel = Object.fromEntries(res.body.releases.map((r) => [r.label, r]));
    expect(byLabel['RHEL 9']).toMatchObject({ vms: 2, poweredOn: 1, family: 'linux' });
    expect(byLabel['RHEL 9'].versions).toEqual(expect.arrayContaining([{ version: '9.4', vms: 1 }, { version: '9', vms: 1 }]));
    expect(byLabel['Windows Server 2019']).toMatchObject({ vms: 2, poweredOn: 2 });
    expect(byLabel['Windows Server 2019'].byVcenter).toEqual(expect.arrayContaining([
      { id: vc1, name: 'go-a', vms: 1 }, { id: vc2, name: 'go-b', vms: 1 },
    ]));
    expect(byLabel['Other Linux'].vms).toBe(1);
    const ver = Object.fromEntries(res.body.versions.map((v) => [v.versionLabel, v]));
    expect(ver['RHEL 9.4']).toMatchObject({ vms: 1, source: { detailed: 1, tools: 0, configured: 0 } });
    expect(ver['Windows Server 2019 Standard (build 17763)'].source).toEqual({ detailed: 1, tools: 0, configured: 0 });
    expect(ver['Windows Server 2019'].source).toEqual({ detailed: 0, tools: 0, configured: 1 });
    expect(res.body.families.map((f) => [f.family, f.vms])).toEqual([['windows', 2], ['linux', 3]]);
    const vcs = Object.fromEntries(res.body.vcenters.map((v) => [v.name, v]));
    expect(vcs['go-a']).toMatchObject({ vms: 3, detailCoverage: 2 / 3, lastPollStatus: 'success' });
    expect(vcs['go-b']).toMatchObject({ vms: 2, detailCoverage: 0 });
  });

  it('?vcenterId narrows vms and rollups but still lists both vCenters', async () => {
    const res = await request(app).get('/api/vcenter/guest-os').query({ vcenterId: String(vc2) });
    expect(res.body.vms.map((v) => v.name).sort()).toEqual(['b-oth-1', 'b-win-1']);
    expect(res.body.summary).toMatchObject({ vms: 2, windows: 1, linux: 1, detailed: 0 });
    expect(res.body.lastPolled).toBe('2026-10-02T10:00:00Z');
    expect(res.body.vcenters).toHaveLength(2);
    expect(res.body.releases.find((r) => r.label === 'Windows Server 2019').byVcenter).toEqual([{ id: vc2, name: 'go-b', vms: 1 }]);
    const both = await request(app).get(`/api/vcenter/guest-os?vcenterId=${vc1},${vc2}`);
    expect(both.body.summary.vms).toBe(5);
    const first = await request(app).get(`/api/vcenter/guest-os?vcenterId=${vc1}`);
    expect(first.body.lastPolled).toBe('2026-10-01T10:00:00Z');
  });

  it('an empty estate returns zeros and empty arrays', async () => {
    db.exec('DELETE FROM vcenter_vms');
    db.exec('DELETE FROM vcenter_vcenters');
    const res = await request(app).get('/api/vcenter/guest-os');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ lastPolled: null, vcenters: [], vms: [], releases: [], versions: [], families: [] });
    expect(res.body.summary).toEqual({
      vms: 0, poweredOn: 0, poweredOff: 0, windows: 0, linux: 0, other: 0, unknown: 0,
      detailed: 0, toolsReported: 0, configuredOnly: 0, toolsOutdated: 0,
    });
  });
});
