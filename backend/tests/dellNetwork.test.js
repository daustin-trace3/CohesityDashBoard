/**
 * LogicMonitor round 9 WP5: Dell server to switch port. Join precedence in
 * dellHostLinks (service tag beats hostname), and the two Dell network routes
 * against a seeded vCenter NIC hint on a switch LogicMonitor knows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { setSetting } = require('../services/settings');
const { encrypt } = require('../services/encryption');
const { dellHostLinks } = require('../services/dellVcenterUtil');
const dellRouter = require('../routes/dell');
const topologyRouter = require('../routes/topology');

function ins(table, row) {
  const cols = Object.keys(row);
  return db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => row[c])).lastInsertRowid;
}

let app;
let ids;

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.auth = { grants: ['*:*:*'] }; next(); });
  app.use('/api/dell', dellRouter);
  app.use('/api/topology', topologyRouter);
  setSetting('platform_dell_enabled', '1');
  setSetting('platform_logicmonitor_enabled', '1');

  const vc = ins('vcenter_vcenters', { name: 'vc-w5', host: 'vc.w5', username: 'u', encrypted_credentials: 'x' });
  // esx-a.lab shares the OS hostname of dell "srv-b" but its service tag belongs to srv-a.
  ins('vcenter_hosts', { vcenter_id: vc, host_id: 'h-a', name: 'esx-a.lab', connection_state: 'connected', service_tag: 'TAGAAAA', serial: 'TAGAAAA' });
  ins('vcenter_hosts', { vcenter_id: vc, host_id: 'h-b', name: 'esx-b.lab', connection_state: 'connected' });
  const ome = ins('dell_ome_instances', { name: 'ome-w5', host: 'ome.w5', username: 'u', encrypted_credentials: 'x' });
  const a = ins('dell_devices', { ome_id: ome, device_id: 1, service_tag: 'TAGAAAA', name: 'srv-a', device_type: 'Server', ip_address: '10.9.9.1', os_hostname: 'esx-b' });
  const b = ins('dell_devices', { ome_id: ome, device_id: 2, service_tag: 'TAGBBBB', name: 'srv-b', device_type: 'Server', ip_address: '10.9.9.2', os_hostname: 'esx-b.lab' });
  const c = ins('dell_devices', { ome_id: ome, device_id: 3, service_tag: 'TAGCCCC', name: 'srv-c', device_type: 'Server', ip_address: '10.9.9.3' });

  // LogicMonitor switch core-w5 with Gi1/0/7, and a hint from esx-a.lab on it.
  const sid = ins('lm_sources', {
    name: 'W5 Ops', company: 'w5', auth_mode: 'lmv1',
    encrypted_credentials: encrypt(JSON.stringify({ accessId: 'a', accessKey: 'b' })),
    features_json: '{}',
  });
  ins('lm_devices', { source_id: sid, lm_device_id: 501, name: '10.0.5.1', display_name: 'core-w5', device_type: 0, role: 'switch', is_network: 1, host_status: 'normal', stale: 0 });
  ins('lm_interfaces', { source_id: sid, lm_device_id: 501, instance_id: 71, display_name: 'Gi1/0/7', status: 1, status_text: 'up', speed_bps: 1000000000, stale: 0 });
  db.exec(`CREATE TABLE IF NOT EXISTS vcenter_host_nic_neighbors (
    id INTEGER PRIMARY KEY AUTOINCREMENT, vcenter_id INTEGER NOT NULL, host_name TEXT NOT NULL, nic TEXT NOT NULL, mac TEXT,
    protocol TEXT NOT NULL, switch_name TEXT, switch_port TEXT, switch_address TEXT, switch_platform TEXT, vlan INTEGER,
    raw_json TEXT, captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE (vcenter_id, host_name, nic, protocol))`);
  ins('vcenter_host_nic_neighbors', { vcenter_id: vc, host_name: 'esx-a.lab', nic: 'vmnic1', protocol: 'cdp', switch_name: 'core-w5', switch_port: 'GigabitEthernet1/0/7' });
  ids = { a, b, c, vc, sid };
});

afterAll(() => {
  db.prepare('DELETE FROM vcenter_host_nic_neighbors').run();
  db.prepare('DELETE FROM lm_interfaces WHERE source_id = ?').run(ids.sid);
  db.prepare('DELETE FROM lm_devices WHERE source_id = ?').run(ids.sid);
  db.prepare('DELETE FROM lm_sources WHERE id = ?').run(ids.sid);
  db.prepare('DELETE FROM vcenter_hosts WHERE vcenter_id = ?').run(ids.vc);
  db.prepare('DELETE FROM vcenter_vcenters WHERE id = ?').run(ids.vc);
  db.prepare("DELETE FROM dell_ome_instances WHERE name = 'ome-w5'").run();
});

describe('dellHostLinks', () => {
  it('joins on the service tag before the OS hostname, and keeps the reverse map', () => {
    const { byDevice, byHost } = dellHostLinks(db);
    // srv-a reports OS hostname esx-b but its tag is esx-a's: the tag wins.
    expect(byDevice.get(ids.a)).toBe('esx-a.lab');
    // srv-b then falls to the hostname join and gets the remaining host.
    expect(byDevice.get(ids.b)).toBe('esx-b.lab');
    expect(byDevice.has(ids.c)).toBe(false);
    expect(byHost.get('esx-a.lab')).toBe(ids.a);
    expect(byHost.get('esx-b.lab')).toBe(ids.b);
  });
});

describe('Dell network routes', () => {
  it('GET /devices/:id/network returns the switch port behind the paired ESX host', async () => {
    const res = await request(app).get(`/api/dell/devices/${ids.a}/network`);
    expect(res.status).toBe(200);
    expect(res.body.esxHost).toBe('esx-a.lab');
    expect(res.body.switchPorts).toHaveLength(1);
    expect(res.body.switchPorts[0]).toMatchObject({ deviceName: 'core-w5', port: 'Gi1/0/7', nic: 'vmnic1', statusText: 'up', source: 'vcenter-hint' });
    expect(res.body.sources).toEqual(['vcenter-hint']);
    expect(Array.isArray(res.body.uplinks)).toBe(true);
    expect(Array.isArray(res.body.checks)).toBe(true);
  });

  it('a device with no pairing has no ports; an unknown id is 404', async () => {
    const none = await request(app).get(`/api/dell/devices/${ids.c}/network`);
    expect(none.status).toBe(200);
    expect(none.body.switchPorts).toEqual([]);
    expect(none.body.esxHost).toBeNull();
    expect((await request(app).get('/api/dell/devices/999999/network')).status).toBe(404);
  });

  it('GET /devices/network-summary counts ports per device row id', async () => {
    const res = await request(app).get('/api/dell/devices/network-summary');
    expect(res.status).toBe(200);
    expect(res.body[ids.a]).toMatchObject({ ports: 1, switches: ['core-w5'], state: 'up' });
    expect(res.body[ids.c]).toBeUndefined();
  });

  it('answers 404 when LogicMonitor is switched off', async () => {
    setSetting('platform_logicmonitor_enabled', '0');
    try {
      expect((await request(app).get(`/api/dell/devices/${ids.a}/network`)).status).toBe(404);
    } finally {
      setSetting('platform_logicmonitor_enabled', '1');
    }
  });
});

describe('topology identity anchor', () => {
  it('anchors a Dell server as type server (the LogicMonitor hook adds uplinks when registered)', async () => {
    const res = await request(app).get('/api/topology').query({ name: 'srv-a' });
    expect(res.status).toBe(200);
    const anchor = res.body.nodes.find((n) => n.platform === 'dell');
    expect(anchor).toMatchObject({ type: 'server', tier: 'compute', label: 'srv-a', route: '/dell/devices?q=srv-a' });
    expect(res.body.identity.names).toEqual(expect.arrayContaining(['srv-a', 'esx-a.lab']));
  });
});
