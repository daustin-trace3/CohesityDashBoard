/**
 * NetApp Governance: consolidated cross-cluster estate view (GET
 * /api/netapp/governance). Mirrors the direct-mount style used by
 * backend/tests/appServiceStatus.test.js. No dedicated netapp route test
 * file existed before this one (only the generic smoke test in
 * characterization.api.test.js).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const netappRouter = require('../routes/netapp');

let app;

function clearAll() {
  for (const t of [
    'netapp_alerts', 'netapp_snapmirror', 'netapp_svms', 'netapp_disks', 'netapp_volumes',
    'netapp_aggregates', 'netapp_nodes', 'netapp_arrays', 'netapp_aiqum_instances', 'poller_status',
  ]) db.exec(`DELETE FROM ${t}`);
}

function insertArray(overrides = {}) {
  const info = db.prepare(`
    INSERT INTO netapp_arrays (name, mgmt_host, username, encrypted_credentials, version, source, aiqum_instance_id, polling_interval_minutes)
    VALUES (?, ?, 'admin', 'enc', ?, ?, ?, ?)
  `).run(
    overrides.name, overrides.mgmt_host || `${overrides.name}.corp.local`, overrides.version || null,
    overrides.source || 'direct', overrides.aiqum_instance_id || null, overrides.polling_interval_minutes || 15
  );
  return info.lastInsertRowid;
}

function insertNode(arrayId, { name, model, serial, state = 'up', version, capturedAt }) {
  db.prepare(`
    INSERT INTO netapp_nodes (array_id, name, model, serial_number, state, version, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ${capturedAt ? '?' : "datetime('now')"})
  `).run(...(capturedAt ? [arrayId, name, model, serial, state, version, capturedAt] : [arrayId, name, model, serial, state, version]));
}

function insertAggregate(arrayId, sizeBytes, usedBytes) {
  db.prepare('INSERT INTO netapp_aggregates (array_id, name, size_bytes, used_bytes) VALUES (?, ?, ?, ?)')
    .run(arrayId, `${arrayId}-agg1`, sizeBytes, usedBytes);
}

function insertDisk(arrayId, state) {
  db.prepare('INSERT INTO netapp_disks (array_id, name, state) VALUES (?, ?, ?)').run(arrayId, `${arrayId}-disk-${Math.random()}`, state);
}

function insertAlert(arrayId, severity) {
  db.prepare('INSERT INTO netapp_alerts (array_id, severity, message) VALUES (?, ?, ?)').run(arrayId, severity, 'x');
}

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.auth = { grants: ['*:*:*'], user: { username: 'tester' } }; next(); });
  app.use('/api/netapp', netappRouter);
});

beforeEach(() => { clearAll(); });

describe('GET /api/netapp/governance - empty estate', () => {
  it('returns empty arrays and a zeroed summary, not an error', async () => {
    const res = await request(app).get('/api/netapp/governance');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      clusters: [], nodes: [], versions: [], models: [],
      newest_version: null, majority_version: null,
      summary: {
        cluster_count: 0, node_count: 0, distinct_versions: 0, distinct_models: 0,
        clusters_with_mixed_versions: 0, clusters_behind_newest: 0, clusters_with_poll_issue: 0,
      },
    });
  });
});

describe('GET /api/netapp/governance - populated estate', () => {
  let aId, bId, cId, dId;

  beforeEach(() => {
    // Cluster A (direct): 3 nodes, two ONTAP versions -> mixed, and the
    // majority version of the whole estate (2 of 6 nodes on 9.13.1).
    aId = insertArray({ name: 'cg-ontap-1', version: '9.13.1P8', source: 'direct', polling_interval_minutes: 15 });
    insertNode(aId, { name: 'a-node-1', model: 'FAS8300', serial: 'SN-A1', version: '9.13.1' });
    insertNode(aId, { name: 'a-node-2', model: 'FAS8300', serial: 'SN-A2', version: '9.13.1P8' });
    insertNode(aId, { name: 'a-node-3', model: 'FAS8300', serial: 'SN-A3', version: '9.13.1' });
    insertAggregate(aId, 1000, 400);
    db.prepare('INSERT INTO netapp_volumes (array_id, name) VALUES (?, ?), (?, ?)').run(aId, 'a-vol1', aId, 'a-vol2');
    insertDisk(aId, 'present'); insertDisk(aId, 'present'); insertDisk(aId, 'present'); insertDisk(aId, 'broken');
    db.prepare("INSERT INTO netapp_svms (array_id, name) VALUES (?, 'a-svm1')").run(aId);
    insertAlert(aId, 'critical'); insertAlert(aId, 'warning');
    db.prepare("INSERT INTO netapp_snapmirror (array_id, source_path) VALUES (?, 'a:vol1')").run(aId);
    db.prepare("INSERT INTO poller_status (type, entity_id, last_poll_end, last_poll_status, is_syncing) VALUES ('netapp', ?, datetime('now'), 'success', 0)").run(aId);

    // Cluster B (AIQUM-managed): single version, the newest in the estate,
    // and a failed last poll.
    const aiqum = db.prepare("INSERT INTO netapp_aiqum_instances (name, host, username, encrypted_credentials) VALUES ('AIQUM-1', 'aiqum.corp.local', 'api', 'enc')").run();
    bId = insertArray({ name: 'cg-ontap-2', version: '9.14.1', source: 'aiqum', aiqum_instance_id: aiqum.lastInsertRowid, polling_interval_minutes: 15 });
    insertNode(bId, { name: 'b-node-1', model: 'AFF-A400', serial: 'SN-B1', version: '9.14.1' });
    insertAggregate(bId, 2000, 1000);
    db.prepare("INSERT INTO netapp_volumes (array_id, name) VALUES (?, 'b-vol1')").run(bId);
    insertDisk(bId, 'present'); insertDisk(bId, 'present');
    db.prepare("INSERT INTO netapp_svms (array_id, name) VALUES (?, 'b-svm1')").run(bId);
    db.prepare("INSERT INTO poller_status (type, entity_id, last_poll_end, last_poll_status, is_syncing) VALUES ('netapp', ?, datetime('now'), 'error', 0)").run(bId);

    // Cluster C (direct): mixed at the old end of the estate, no poller_status
    // row at all, so it falls back to node captured_at, which is stale here.
    cId = insertArray({ name: 'cg-ontap-3', version: '9.9.1', source: 'direct', polling_interval_minutes: 15 });
    insertNode(cId, { name: 'c-node-1', model: 'FAS2750', serial: 'SN-C1', version: '9.9.1', capturedAt: '2020-01-01 00:00:00' });
    insertNode(cId, { name: 'c-node-2', model: 'FAS2750', serial: 'SN-C2', state: 'down', version: '9.10.1P3', capturedAt: '2020-01-01 00:00:00' });
    insertAlert(cId, 'critical');

    // Cluster D (direct): the array-level version is the AIQUM-style short
    // form, its node reports the direct-poller full "NetApp Release ...:
    // <date>" form of the SAME release, newer than anything above - the
    // exact format mismatch the version comparator bug covered. Raw strings
    // never match here ('9.15.1' vs 'NetApp Release 9.15.1: ...'), only the
    // canonical release does.
    dId = insertArray({ name: 'cg-ontap-4', version: '9.15.1', source: 'direct', polling_interval_minutes: 15 });
    insertNode(dId, { name: 'd-node-1', model: 'FAS9000', serial: 'SN-D1', version: 'NetApp Release 9.15.1: Thu Mar 14 12:00:00 UTC 2024' });
  });

  it('rolls up each cluster by hand-computed values', async () => {
    const res = await request(app).get('/api/netapp/governance');
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.clusters.map((c) => [c.name, c]));

    expect(byName['cg-ontap-1']).toMatchObject({
      source: 'direct', ontap_version: '9.13.1P8', ontap_release: '9.13.1P8', node_count: 3,
      models: ['FAS8300'], node_versions: ['9.13.1', '9.13.1P8'], mixed_versions: true, behind: true,
      capacity_total_bytes: 1000, capacity_used_bytes: 400, capacity_used_percent: 40,
      aggregate_count: 1, volume_count: 2, disk_count: 4, disk_failed_count: 1, svm_count: 1,
      open_alert_count: 2, open_alerts_by_severity: { critical: 1, warning: 1 },
      snapmirror_count: 1, poll_status: 'success', poll_error: false,
    });
    expect(byName['cg-ontap-1'].serials.sort()).toEqual(['SN-A1', 'SN-A2', 'SN-A3']);
    expect(byName['cg-ontap-1'].last_polled).toBeTruthy();

    // cg-ontap-2 was the estate's newest release until cg-ontap-4 (below)
    // joined with a genuinely newer one - it must now read behind: true.
    expect(byName['cg-ontap-2']).toMatchObject({
      source: 'AIQUM-1', ontap_version: '9.14.1', ontap_release: '9.14.1', node_count: 1,
      models: ['AFF-A400'], node_versions: ['9.14.1'], mixed_versions: false, behind: true,
      capacity_total_bytes: 2000, capacity_used_bytes: 1000, capacity_used_percent: 50,
      volume_count: 1, disk_count: 2, disk_failed_count: 0, svm_count: 1,
      open_alert_count: 0, open_alerts_by_severity: {},
      poll_status: 'error', poll_error: true,
    });

    expect(byName['cg-ontap-3']).toMatchObject({
      source: 'direct', ontap_version: '9.9.1', ontap_release: '9.9.1', node_count: 2,
      models: ['FAS2750'], node_versions: ['9.9.1', '9.10.1P3'], mixed_versions: true, behind: true,
      capacity_total_bytes: 0, capacity_used_bytes: 0, capacity_used_percent: null,
      volume_count: 0, disk_count: 0, svm_count: 0,
      open_alert_count: 1, open_alerts_by_severity: { critical: 1 },
      poll_status: null, poll_error: false,
    });
    expect(byName['cg-ontap-3'].last_polled).toBe('2020-01-01T00:00:00Z');

    // Array version is the short form, its one node is the long "NetApp
    // Release ...: <date>" form of the SAME release: both normalize to the
    // same canonical release, so this is not mixed and not behind.
    expect(byName['cg-ontap-4']).toMatchObject({
      source: 'direct', ontap_version: '9.15.1', ontap_release: '9.15.1', node_count: 1,
      models: ['FAS9000'], node_versions: ['9.15.1'], mixed_versions: false, behind: false,
    });
  });

  it('returns one row per node with the parent cluster name', async () => {
    const res = await request(app).get('/api/netapp/governance');
    expect(res.body.nodes).toHaveLength(7);
    const aNodes = res.body.nodes.filter((n) => n.array_name === 'cg-ontap-1');
    expect(aNodes).toHaveLength(3);
    expect(aNodes.map((n) => n.name)).toEqual(['a-node-1', 'a-node-2', 'a-node-3']);
    expect(aNodes[0]).toMatchObject({ array_id: aId, model: 'FAS8300', serial_number: 'SN-A1', state: 'up', version: '9.13.1', release: '9.13.1', behind: true });

    // The node's raw version is the long form; release normalizes it to the
    // same canonical label as the array's short-form ontap_release, and the
    // node itself is not behind since it carries the estate's newest release.
    const dNode = res.body.nodes.find((n) => n.array_name === 'cg-ontap-4');
    expect(dNode).toMatchObject({
      version: 'NetApp Release 9.15.1: Thu Mar 14 12:00:00 UTC 2024', release: '9.15.1', behind: false,
    });
  });

  it('orders the version distribution newest-first with the numeric-aware ONTAP comparator', async () => {
    // 9.9.1 < 9.10.1P3 < 9.13.1 < 9.13.1P8 < 9.14.1 < 9.15.1: a plain string
    // sort would put 9.10.1P3 and 9.9.1 the wrong way round and 9.13.1P8
    // before 9.13.1. Newest-first is the reverse of that ordering.
    const res = await request(app).get('/api/netapp/governance');
    expect(res.body.versions.map((v) => v.version)).toEqual(['9.15.1', '9.14.1', '9.13.1P8', '9.13.1', '9.10.1P3', '9.9.1']);
    expect(res.body.newest_version).toBe('9.15.1');
    expect(res.body.majority_version).toBe('9.13.1'); // 2 of 7 nodes, the most of any single version

    const v9131 = res.body.versions.find((v) => v.version === '9.13.1');
    expect(v9131).toMatchObject({ node_count: 2, cluster_count: 1, clusters: ['cg-ontap-1'] });
    const v914 = res.body.versions.find((v) => v.version === '9.14.1');
    expect(v914).toMatchObject({ node_count: 1, cluster_count: 1, clusters: ['cg-ontap-2'] });

    // cg-ontap-4's array uses the short form ("9.15.1") and its node uses
    // the long "NetApp Release ...: <date>" form of the same release - one
    // row, not two, and it carries the estate's newest release alone.
    expect(res.body.versions.filter((v) => v.version === '9.15.1')).toHaveLength(1);
    const v9151 = res.body.versions.find((v) => v.version === '9.15.1');
    expect(v9151).toMatchObject({ node_count: 1, cluster_count: 1, clusters: ['cg-ontap-4'] });
  });

  it('groups the model distribution by node count', async () => {
    const res = await request(app).get('/api/netapp/governance');
    expect(res.body.models).toEqual([
      { model: 'FAS8300', node_count: 3, cluster_count: 1, clusters: ['cg-ontap-1'] },
      { model: 'FAS2750', node_count: 2, cluster_count: 1, clusters: ['cg-ontap-3'] },
      { model: 'AFF-A400', node_count: 1, cluster_count: 1, clusters: ['cg-ontap-2'] },
      { model: 'FAS9000', node_count: 1, cluster_count: 1, clusters: ['cg-ontap-4'] },
    ]);
  });

  it('computes an estate summary: mixed, behind-newest and poll-issue counts', async () => {
    const res = await request(app).get('/api/netapp/governance');
    expect(res.body.summary).toMatchObject({
      cluster_count: 4, node_count: 7, distinct_versions: 6, distinct_models: 4,
      clusters_with_mixed_versions: 2, // cg-ontap-1 and cg-ontap-3
      // cg-ontap-1 (9.13.1P8), cg-ontap-2 (9.14.1, no longer newest once
      // cg-ontap-4 joins) and cg-ontap-3 (9.9.1) - only cg-ontap-4 (9.15.1) is not.
      clusters_behind_newest: 3,
      clusters_with_poll_issue: 2, // cg-ontap-2 (poll error) and cg-ontap-3 (stale, no poller_status row)
    });
    // clusters_behind_newest must equal the number of clusters actually
    // flagged behind, not a separately maintained count.
    expect(res.body.clusters.filter((c) => c.behind)).toHaveLength(res.body.summary.clusters_behind_newest);
  });
});
