/**
 * Cross-platform Topology Map backend test. Self-contained express app
 * wired directly to routes/topology.js against the shared per-file test DB
 * (mirrors tests/cohesityObject360.test.js). A test-only middleware injects
 * req.auth with a wildcard grant so every gated section is exercised.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);

const db = require('../db/database');
const { setSetting } = require('../services/settings');
const topologyRouter = require('../routes/topology');

let app;
let clusterId;
let vcenterId;

beforeAll(() => {
  app = express();
  app.use((req, res, next) => { req.auth = { grants: ['*:*:*'] }; next(); });
  app.use('/api/topology', topologyRouter);

  setSetting('platform_vcenter_enabled', '1');
  setSetting('platform_brocade_enabled', '1');

  // vCenter anchor VM
  const vc = db.prepare(`
    INSERT INTO vcenter_vcenters (name, host, username, encrypted_credentials)
    VALUES ('vc1', 'vc1.corp.local', 'admin', 'enc')
  `).run();
  vcenterId = vc.lastInsertRowid;

  db.prepare(`
    INSERT INTO vcenter_vms (vcenter_id, vm_id, name, host_name, cluster_name, power_state,
      cpu_count, memory_mb, ip_address, datastores, guest_nics, guest_hostname)
    VALUES (?, 'vm-100', 'topo-web01', 'esx1.corp.local', 'Cluster1', 'poweredOn', 8, 32768,
      '10.1.2.3', ?, ?, 'topo-web01.corp.local')
  `).run(vcenterId, JSON.stringify(['ds1']), JSON.stringify([{ ips: ['10.1.2.3'] }]));

  // Brocade device ports: one initiator (host) + one target sharing a zone
  const src = db.prepare(`
    INSERT INTO brocade_sources (name, host, port, username, password_enc, verify_ssl, enabled,
      polling_interval_minutes, event_poll_minutes, fos_proxy_enabled, sannav_version)
    VALUES ('Topo SanNav', '10.0.0.60', 443, 'admin', 'not-really-encrypted', 0, 1, 60, 5, 1, '3.0.0')
  `).run();
  const brocadeSourceId = src.lastInsertRowid;

  db.prepare(`
    INSERT INTO brocade_device_ports (source_id, wwn, port_role, fabric_name, switch_wwn,
      switch_name, slot_number, port_number, enclosure_name, fdmi_host_name, active_zones,
      active_zone_count, is_missing, stale)
    VALUES (?, '10:00:00:00:aa:bb:cc:01', 'Initiator', 'Fabric1', 'sw-wwn-1', 'switch1', 1, 5,
      NULL, 'topo-web01', ?, 1, 0, 0)
  `).run(brocadeSourceId, JSON.stringify(['zone_alpha']));

  db.prepare(`
    INSERT INTO brocade_device_ports (source_id, wwn, port_role, fabric_name, switch_wwn,
      switch_name, slot_number, port_number, enclosure_name, fdmi_host_name, active_zones,
      active_zone_count, is_missing, stale)
    VALUES (?, '20:00:00:00:aa:bb:cc:02', 'Target', 'Fabric1', 'sw-wwn-1', 'switch1', 2, 9,
      'array-1', NULL, ?, 1, 0, 0)
  `).run(brocadeSourceId, JSON.stringify(['zone_alpha']));

  // Cohesity object
  const cl = db.prepare(`
    INSERT INTO clusters (name, vip, connection_type, auth_type, encrypted_credentials)
    VALUES ('cluster1', '10.0.0.1', 'direct', 'apikey', 'enc')
  `).run();
  clusterId = cl.lastInsertRowid;

  db.prepare(`
    INSERT INTO cohesity_objects (cluster_id, name, environment, object_type, os_type,
      source_name, is_protected, protection_groups, policy_names, last_backup_status,
      sla_violated, logical_bytes)
    VALUES (?, 'topo-web01', 'kVMware', 'kVirtualMachine', 'Linux', 'vc1', 1, ?, ?, 'kSuccess', 0, 12345)
  `).run(clusterId, JSON.stringify(['topo-group']), JSON.stringify(['policy-a']));
});

describe('GET /api/topology', () => {
  it('400 without name', async () => {
    const res = await request(app).get('/api/topology');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'name required' });
  });

  it('200 with empty nodes/edges for an unknown device', async () => {
    const res = await request(app).get('/api/topology?name=does-not-exist');
    expect(res.status).toBe(200);
    expect(res.body.query).toBe('does-not-exist');
    // No vm match -> generic device anchor node only, no edges.
    expect(res.body.nodes).toHaveLength(1);
    expect(res.body.nodes[0]).toMatchObject({ id: 'device:does-not-exist', type: 'host', tier: 'compute' });
    expect(res.body.edges).toEqual([]);
  });

  it('200 with the full anchored graph for a known device', async () => {
    const res = await request(app).get('/api/topology?name=topo-web01');
    expect(res.status).toBe(200);
    expect(res.body.identity.names).toEqual(expect.arrayContaining(['topo-web01']));
    expect(res.body.identity.ips).toEqual(expect.arrayContaining(['10.1.2.3']));

    const byId = Object.fromEntries(res.body.nodes.map((n) => [n.id, n]));

    // Compute tier
    expect(byId['vm:topo-web01']).toMatchObject({ type: 'vm', tier: 'compute', platform: 'vcenter', status: 'ok' });
    expect(byId['host:esx1.corp.local']).toMatchObject({ type: 'host', tier: 'compute', platform: 'vcenter' });
    expect(byId['vcenter:vc1']).toMatchObject({ type: 'vcenter', tier: 'compute', platform: 'vcenter' });
    expect(byId['datastore:ds1']).toMatchObject({ type: 'datastore', tier: 'storage', platform: 'vcenter' });

    // SAN tier
    expect(byId['hba:10:00:00:00:aa:bb:cc:01']).toMatchObject({ type: 'hba', tier: 'san', platform: 'brocade' });
    expect(byId['switch:sw-wwn-1']).toMatchObject({ type: 'switch', tier: 'san', platform: 'brocade' });
    expect(byId['fabric:Fabric1']).toMatchObject({ type: 'fabric', tier: 'san', platform: 'brocade' });
    expect(byId['targetPort:20:00:00:00:aa:bb:cc:02']).toMatchObject({ type: 'targetPort', tier: 'san', platform: 'brocade' });
    expect(byId['array:array-1']).toMatchObject({ type: 'array', tier: 'storage', platform: 'brocade' });

    // Backup tier
    expect(byId['protection:topo-group']).toMatchObject({ type: 'protection', tier: 'backup', platform: 'cohesity', status: 'ok' });
    expect(byId['cluster:cluster1']).toMatchObject({ type: 'cluster', tier: 'backup', platform: 'cohesity' });

    // Edges, hand-computed
    const edgeSet = res.body.edges.map((e) => `${e.from}->${e.to}:${e.kind}`);
    expect(edgeSet).toEqual(expect.arrayContaining([
      'vm:topo-web01->host:esx1.corp.local:runs-on',
      'host:esx1.corp.local->vcenter:vc1:managed-by',
      'vm:topo-web01->datastore:ds1:stores-on',
      'vm:topo-web01->hba:10:00:00:00:aa:bb:cc:01:attached-to',
      'hba:10:00:00:00:aa:bb:cc:01->switch:sw-wwn-1:connected',
      'switch:sw-wwn-1->fabric:Fabric1:member-of',
      'hba:10:00:00:00:aa:bb:cc:01->targetPort:20:00:00:00:aa:bb:cc:02:zoned',
      'targetPort:20:00:00:00:aa:bb:cc:02->array:array-1:belongs-to',
      'vm:topo-web01->protection:topo-group:protected-by',
      'protection:topo-group->cluster:cluster1:on-cluster',
    ]));

    // No dangling edges: every edge endpoint must be a known node id.
    const ids = new Set(res.body.nodes.map((n) => n.id));
    for (const e of res.body.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });
});
