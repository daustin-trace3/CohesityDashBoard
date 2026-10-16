/**
 * LogicMonitor round 9 WP4: cohesity_nodes. Merge of V1 and V2 node rows,
 * tolerant field mapping, reseed-safe upsert and the never-throws poll hook.
 * Field names are UNVERIFIED against a live cluster (see services/cohesityNodes.js).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { mergeNodes, nodeRow, upsertNodes, syncClusterNodes } = require('../services/cohesityNodes');

const V1 = [
  { id: 11, ip: '10.1.1.21', hostName: 'cl1-node-1', cohesityNodeSerial: 'NSN1', chassisInfo: { chassisSerial: 'CHS1' }, softwareVersion: '7.1.2', nodeStatus: 'kActive' },
  { id: 12, nodeIp: '10.1.1.22', hostname: 'cl1-node-2', softwareVersion: '7.1.2', status: 'kActive' },
];
const V2 = [
  { id: 11, serialNumber: 'V2SER1', productModel: 'C6055' },
  { id: 12, serialNumber: 'V2SER2', productModel: 'C6055' },
];

beforeEach(() => { db.prepare('DELETE FROM cohesity_nodes').run(); });

describe('cohesityNodes', () => {
  it('merges V2 serial and model by node id', () => {
    const m = mergeNodes(V1, V2);
    expect(m[0]._v2Serial).toBe('V2SER1');
    expect(m[1]._v2Model).toBe('C6055');
  });

  it('maps fields with the accepted hostname casings and ip fields', () => {
    const [a, b] = mergeNodes(V1, V2).map(nodeRow);
    expect(a).toMatchObject({ node_id: '11', hostname: 'cl1-node-1', ip: '10.1.1.21', serial: 'NSN1', chassis_serial: 'CHS1', model: 'C6055', status: 'kActive' });
    expect(b).toMatchObject({ hostname: 'cl1-node-2', ip: '10.1.1.22', serial: 'V2SER2', chassis_serial: null });
    expect(JSON.parse(b.ips_json)).toEqual(['10.1.1.22']);
    expect(nodeRow({ id: 1, nodeHostName: 'x' }).hostname).toBe('x');
  });

  it('upsert is reseed-safe and drops nodes the cluster no longer lists', () => {
    const merged = mergeNodes(V1, V2);
    expect(upsertNodes(db, 7, merged)).toBe(2);
    expect(upsertNodes(db, 7, merged)).toBe(2);
    expect(db.prepare('SELECT COUNT(*) c FROM cohesity_nodes WHERE cluster_id = 7').get().c).toBe(2);
    upsertNodes(db, 7, [merged[0]]);
    expect(db.prepare('SELECT node_id FROM cohesity_nodes WHERE cluster_id = 7').all()).toEqual([{ node_id: '11' }]);
    upsertNodes(db, 7, []);
    expect(db.prepare('SELECT COUNT(*) c FROM cohesity_nodes WHERE cluster_id = 7').get().c).toBe(1);
  });

  it('syncClusterNodes stores through an injected api and never throws', async () => {
    const api = { fetchNodes: async () => V1, fetchNodesV2: async () => V2 };
    expect(await syncClusterNodes({ id: 9 }, { api })).toBe(2);
    expect(db.prepare('SELECT serial FROM cohesity_nodes WHERE cluster_id = 9 AND node_id = ?').get('12').serial).toBe('V2SER2');
    const bad = { fetchNodes: async () => { throw new Error('502'); }, fetchNodesV2: async () => { throw new Error('502'); } };
    expect(await syncClusterNodes({ id: 9 }, { api: bad })).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM cohesity_nodes WHERE cluster_id = 9').get().c).toBe(2);
  });
});
