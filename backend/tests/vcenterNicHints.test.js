/**
 * vCenter physical NIC neighbour hints: the QueryNetworkHint parser (CDP,
 * LLDP with array and single-object parameter lists, a host with no hints),
 * the round-robin host cap, the poller store into vcenter_host_nic_neighbors
 * and GET /api/vcenter/hosts/:name/nic-neighbors.
 *
 * The fake responses below are hand-written from the vSphere API reference,
 * not captured from a live vCenter (UNVERIFIED nesting).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';
import { XMLParser } from 'fast-xml-parser';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { parseNetworkHints, pickHintHosts, NIC_HINT_HOST_CAP } = require('../services/vcenterApi');
const { store } = require('../services/vcenterPoller');
const vcenterRouter = require('../routes/vcenter');

// Same parser options as services/vcenterApi.js soapCall.
const xmlParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
const returnvalOf = (xml) => xmlParser.parse(`<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <soapenv:Body>
    <QueryNetworkHintResponse xmlns="urn:vim25">${xml}</QueryNetworkHintResponse>
  </soapenv:Body>
</soapenv:Envelope>`).Envelope.Body.QueryNetworkHintResponse.returnval;

const CDP_AND_LLDP = `
  <returnval>
    <device>vmnic0</device>
    <connectedSwitchPort>
      <cdpVersion>2</cdpVersion>
      <timeout>0</timeout>
      <ttl>155</ttl>
      <samples>100</samples>
      <devId>core-sw-01.corp.local(FOC1234X0AB)</devId>
      <address>10.0.0.2</address>
      <portId>Ethernet1/17</portId>
      <hardwarePlatform>N9K-C93180YC-EX</hardwarePlatform>
      <vlan>120</vlan>
      <systemName>core-sw-01</systemName>
      <mgmtAddr>10.0.0.250</mgmtAddr>
    </connectedSwitchPort>
  </returnval>
  <returnval>
    <device>vmnic1</device>
    <lldpInfo>
      <chassisId>00:11:22:33:44:55</chassisId>
      <portId>00:11:22:33:44:6a</portId>
      <timeToLive>120</timeToLive>
      <parameter><key>System Name</key><value xsi:type="xsd:string">tor-b-07</value></parameter>
      <parameter><key>System Description</key><value xsi:type="xsd:string">Arista DCS-7050SX</value></parameter>
      <parameter><key>Port Description</key><value xsi:type="xsd:string">Ethernet12</value></parameter>
      <parameter><key>Management Address</key><value xsi:type="xsd:string">10.0.1.7</value></parameter>
      <parameter><key>VLAN ID</key><value xsi:type="xsd:int">130</value></parameter>
    </lldpInfo>
  </returnval>`;

const LLDP_SINGLE_PARAM = `
  <returnval>
    <device>vmnic2</device>
    <lldpInfo>
      <chassisId>aa:bb:cc:dd:ee:ff</chassisId>
      <portId>ge-0/0/5</portId>
      <timeToLive>90</timeToLive>
      <parameter><key>System Name</key><value xsi:type="xsd:string">edge-sw-3</value></parameter>
    </lldpInfo>
  </returnval>`;

const NO_HINTS = `
  <returnval><device>vmnic0</device></returnval>
  <returnval><device>vmnic1</device><network><vlanId>0</vlanId><ipSubnet>10.9.0.0/24</ipSubnet></network></returnval>`;

describe('parseNetworkHints', () => {
  it('maps CDP to a cdp row (systemName wins over devId) and LLDP with array parameters to an lldp row', () => {
    const rows = parseNetworkHints('esx01', returnvalOf(CDP_AND_LLDP),
      new Map([['vmnic0', '00:50:56:aa:00:01'], ['vmnic1', '00:50:56:aa:00:02']]));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      hostName: 'esx01', nic: 'vmnic0', mac: '00:50:56:aa:00:01', protocol: 'cdp',
      switchName: 'core-sw-01', switchPort: 'Ethernet1/17', switchAddress: '10.0.0.2',
      switchPlatform: 'N9K-C93180YC-EX', vlan: 120,
    });
    expect(rows[0].raw.device).toBe('vmnic0');
    expect(rows[0].raw.connectedSwitchPort).toBeTruthy();
    // portId is a MAC, so the Port Description parameter is used.
    expect(rows[1]).toMatchObject({
      nic: 'vmnic1', mac: '00:50:56:aa:00:02', protocol: 'lldp',
      switchName: 'tor-b-07', switchPort: 'Ethernet12', switchAddress: '10.0.1.7',
      switchPlatform: 'Arista DCS-7050SX', vlan: 130,
    });
  });

  it('accepts a single-object LLDP parameter and keeps a readable portId', () => {
    const rows = parseNetworkHints('esx02', returnvalOf(LLDP_SINGLE_PARAM));
    expect(rows).toEqual([expect.objectContaining({
      nic: 'vmnic2', mac: null, protocol: 'lldp', switchName: 'edge-sw-3',
      switchPort: 'ge-0/0/5', switchAddress: null, switchPlatform: null, vlan: null,
    })]);
  });

  it('falls back to chassisId and to devId when the names are missing', () => {
    const rows = parseNetworkHints('esx03', [
      { device: 'vmnic4', lldpInfo: { chassisId: 'ch-1', portId: 7 } },
      { device: 'vmnic5', connectedSwitchPort: { devId: 'sw-dev-id', portId: 'Gi1/0/3' } },
    ]);
    expect(rows.map(r => [r.nic, r.protocol, r.switchName, r.switchPort]))
      .toEqual([['vmnic4', 'lldp', 'ch-1', '7'], ['vmnic5', 'cdp', 'sw-dev-id', 'Gi1/0/3']]);
  });

  it('returns no rows for a host with no CDP or LLDP hints, or an empty response', () => {
    expect(parseNetworkHints('esx04', returnvalOf(NO_HINTS))).toEqual([]);
    expect(parseNetworkHints('esx04', undefined)).toEqual([]);
    expect(parseNetworkHints('esx04', '')).toEqual([]);
  });

  it('tolerates a PhysicalNicHintInfo wrapper around the hint list', () => {
    const rows = parseNetworkHints('esx05', { PhysicalNicHintInfo: { device: 'vmnic0', connectedSwitchPort: { systemName: 'sw', portId: 'Eth1' } } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ nic: 'vmnic0', switchName: 'sw', switchPort: 'Eth1' });
  });
});

describe('pickHintHosts', () => {
  it('returns every host under the cap and walks round-robin above it', () => {
    const few = [{ name: 'a' }, { name: 'b' }];
    expect(pickHintHosts('rr-few', few)).toEqual({ picked: few, capped: false });
    const many = Array.from({ length: NIC_HINT_HOST_CAP + 50 }, (_, i) => ({ name: `h${i}` }));
    const first = pickHintHosts('rr-many', many);
    expect(first.capped).toBe(true);
    expect(first.picked).toHaveLength(NIC_HINT_HOST_CAP);
    expect(first.picked[0].name).toBe('h0');
    const second = pickHintHosts('rr-many', many);
    expect(second.picked[0].name).toBe(`h${NIC_HINT_HOST_CAP}`);
    expect(second.picked[50].name).toBe('h0');
  });
});

describe('store + GET /api/vcenter/hosts/:name/nic-neighbors', () => {
  let app;
  let vcId;
  const base = (over) => ({
    clusters: [], datastores: [], cert: null, vms: [], about: null, networks: null, orphans: null,
    hosts: [
      { host: 'host-1', name: 'esx-nb-01', connection_state: 'CONNECTED' },
      { host: 'host-2', name: 'esx-nb-02', connection_state: 'CONNECTED' },
    ],
    ...over,
  });
  const nb = (hostName, nic, protocol, switchName) => ({
    hostName, nic, protocol, mac: null, switchName, switchPort: 'Eth1', switchAddress: null,
    switchPlatform: null, vlan: 10, raw: { device: nic },
  });
  const rowsFor = (host) => db.prepare(
    'SELECT * FROM vcenter_host_nic_neighbors WHERE vcenter_id = ? AND host_name = ? ORDER BY nic, protocol',
  ).all(vcId, host);

  beforeAll(() => {
    app = express();
    app.use((req, res, next) => { req.auth = { grants: ['*:*:*'] }; next(); });
    app.use('/api/vcenter', vcenterRouter);
    vcId = db.prepare(`
      INSERT INTO vcenter_vcenters (name, host, username, encrypted_credentials)
      VALUES ('nb-vc', 'nb-vc.corp.local', 'admin', 'enc')
    `).run().lastInsertRowid;
  });

  it('inserts rows, keeps hosts the pass did not cover, and keeps everything when the pass did not run', () => {
    store(vcId, base({
      nicNeighbors: [nb('esx-nb-01', 'vmnic0', 'cdp', 'sw-a'), nb('esx-nb-01', 'vmnic0', 'lldp', 'sw-a'), nb('esx-nb-02', 'vmnic1', 'lldp', 'sw-b')],
      nicNeighborHosts: ['esx-nb-01', 'esx-nb-02'],
    }));
    expect(rowsFor('esx-nb-01')).toHaveLength(2);
    expect(JSON.parse(rowsFor('esx-nb-01')[0].raw_json)).toEqual({ device: 'vmnic0' });

    // Only esx-nb-01 covered this time, now with no hints: its rows go, esx-nb-02 keeps its row.
    store(vcId, base({ nicNeighbors: [], nicNeighborHosts: ['esx-nb-01'] }));
    expect(rowsFor('esx-nb-01')).toHaveLength(0);
    expect(rowsFor('esx-nb-02')).toHaveLength(1);

    // Hint pass unavailable (null): nothing changes.
    store(vcId, base({ nicNeighbors: null, nicNeighborHosts: null }));
    expect(rowsFor('esx-nb-02')).toHaveLength(1);
  });

  it('drops rows for a host that left the inventory', () => {
    store(vcId, base({
      hosts: [{ host: 'host-1', name: 'esx-nb-01', connection_state: 'CONNECTED' }],
      nicNeighbors: [], nicNeighborHosts: ['esx-nb-01'],
    }));
    expect(rowsFor('esx-nb-02')).toHaveLength(0);
  });

  it('serves camelCase rows, [] for a host with no hints, and 404 for an unknown host', async () => {
    store(vcId, base({
      nicNeighbors: [{ ...nb('esx-nb-01', 'vmnic0', 'cdp', 'sw-a'), mac: '00:50:56:aa:00:01', switchAddress: '10.0.0.2', switchPlatform: 'N9K' }],
      nicNeighborHosts: ['esx-nb-01', 'esx-nb-02'],
    }));
    const res = await request(app).get('/api/vcenter/hosts/ESX-NB-01/nic-neighbors');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      nic: 'vmnic0', mac: '00:50:56:aa:00:01', protocol: 'cdp', switchName: 'sw-a', switchPort: 'Eth1',
      switchAddress: '10.0.0.2', switchPlatform: 'N9K', vlan: 10, vcenterName: 'nb-vc',
    });
    expect(res.body[0].capturedAt).toMatch(/T.*Z$/);

    const empty = await request(app).get('/api/vcenter/hosts/esx-nb-02/nic-neighbors');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);

    const missing = await request(app).get('/api/vcenter/hosts/no-such-host/nic-neighbors');
    expect(missing.status).toBe(404);
  });
});
