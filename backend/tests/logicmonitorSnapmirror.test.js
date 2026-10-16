/**
 * LogicMonitor round 9, WP6: SnapMirror lag versus node ports
 * (logicmonitorCorrelation.snapmirrorVsPorts) and the Cohesity target side of
 * backupLoad. Rows are seeded by hand: a switch with two ports tied to NetApp
 * nodes through lm_topology_links (dst_platform netapp), port history inside
 * the lag window, and one lagging relationship.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../db/database');
const { runMigrations } = require('../core/migrations');
const lmMigrations = require('../db/migrations/logicmonitor');
const netappMigrations = require('../db/migrations/netapp');
const { encrypt } = require('../services/encryption');
const corr = require('../services/logicmonitorCorrelation');

const TABLES = ['lm_interface_baseline', 'lm_interface_history', 'lm_topology_links', 'lm_interfaces', 'lm_devices', 'lm_sources',
  'netapp_snapmirror', 'netapp_lifs', 'netapp_nodes', 'netapp_arrays'];

let sid;
const sqlTs = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);
const MIN = 60000;

beforeAll(() => {
  runMigrations(db, 'logicmonitor', lmMigrations);
  runMigrations(db, 'netapp', netappMigrations);
});

beforeEach(() => {
  for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
  sid = db.prepare('INSERT INTO lm_sources (name, company, auth_mode, encrypted_credentials) VALUES (?, ?, ?, ?)')
    .run('Acme', 'acme', 'lmv1', encrypt(JSON.stringify({ accessId: 'a', accessKey: 'b' }))).lastInsertRowid;
  db.prepare(`INSERT INTO lm_devices (source_id, lm_device_id, name, display_name, device_type, host_status, is_network, stale)
    VALUES (?, 1, 'sw1', 'sw1', 0, 'normal', 1, 0)`).run(sid);
});

function array(name, nodes) {
  const id = db.prepare("INSERT INTO netapp_arrays (name, mgmt_host, username, encrypted_credentials) VALUES (?, 'h', 'u', 'x')").run(name).lastInsertRowid;
  for (const n of nodes) db.prepare('INSERT INTO netapp_nodes (array_id, name) VALUES (?, ?)').run(id, n);
  return id;
}

/** A switch port tied to a NetApp node port, with `util` percent history every 10 minutes for 2 hours. */
function port(instanceId, nodeName, nic, util, { errors = 0, baseUtil = 20 } = {}) {
  db.prepare(`INSERT INTO lm_interfaces (source_id, lm_device_id, instance_id, display_name, status_text, in_util_pct, out_util_pct, stale)
    VALUES (?, 1, ?, ?, 'up', ?, ?, 0)`).run(sid, instanceId, `Eth1/${instanceId}`, util, util);
  db.prepare(`INSERT INTO lm_topology_links (source_id, src_device_id, src_instance_id, src_port, dst_name, dst_port, protocol, confidence, last_seen, dst_platform, dst_ref)
    VALUES (?, 1, ?, ?, ?, ?, 'description', 'high', datetime('now'), 'netapp', ?)`).run(sid, instanceId, `Eth1/${instanceId}`, nodeName, nic, nodeName);
  for (let m = 5; m <= 115; m += 10) {
    db.prepare(`INSERT INTO lm_interface_history (source_id, instance_id, captured_at, status, in_util_pct, out_util_pct, in_errors, out_errors)
      VALUES (?, ?, ?, 1, ?, ?, ?, 0)`).run(sid, instanceId, sqlTs(m * MIN), util, util / 2, errors);
  }
  for (let h = 0; h < 24; h += 1) {
    db.prepare('INSERT INTO lm_interface_baseline (source_id, instance_id, hour_of_day, samples, util_median, util_mad, err_median, err_mad) VALUES (?, ?, ?, 30, ?, 3, 0, 0)')
      .run(sid, instanceId, h, baseUtil);
  }
}

function mirror(arrayId, over = {}) {
  db.prepare(`INSERT INTO netapp_snapmirror (array_id, source_path, source_cluster, destination_path, destination_cluster, state, healthy,
      lag_seconds, last_transfer_end, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
    .run(arrayId, over.src || 'svm1:vol_a', over.srcCluster || 'srcclu', over.dst || 'svm2:vol_a_dr', over.dstCluster || 'dstclu',
      over.state || 'snapmirrored', over.healthy ?? 1, over.lag ?? 7200, sqlTs(2 * 60 * MIN));
}

describe('snapmirrorVsPorts', () => {
  it('returns nothing without a lagging relationship', () => {
    array('srcclu', ['srcclu-01']);
    const dst = array('dstclu', ['dstclu-01']);
    port(501, 'srcclu-01', 'e4a', 95);
    mirror(dst, { lag: 120 });
    expect(corr.snapmirrorVsPorts(db)).toEqual([]);
  });

  it('flags a saturated source port and calls a quiet destination port normal', () => {
    array('srcclu', ['srcclu-01']);
    const dst = array('dstclu', ['dstclu-01']);
    port(501, 'srcclu-01', 'e4a', 96);
    port(502, 'dstclu-01', 'e4a', 20);
    mirror(dst);
    const rows = corr.snapmirrorVsPorts(db);
    expect(rows).toHaveLength(2);
    const src = rows.find((r) => r.side === 'source');
    const dstRow = rows.find((r) => r.side === 'destination');
    expect(src).toMatchObject({ finding: 'saturates', node: 'srcclu-01', nodePort: 'e4a', deviceName: 'sw1', port: 'Eth1/501', lagSeconds: 7200, state: 'snapmirrored' });
    expect(src.meanUtilPct).toBeGreaterThan(90);
    expect(src.baselineUtilPct).toBe(20);
    expect(dstRow.finding).toBe('normal');
    expect(rows[0].side).toBe('source');
  });

  it('flags elevated errors on a port whose utilization is normal', () => {
    array('srcclu', ['srcclu-01']);
    const dst = array('dstclu', ['dstclu-01']);
    port(501, 'srcclu-01', 'e4a', 20, { errors: 9 });
    port(502, 'dstclu-01', 'e4a', 20);
    mirror(dst);
    const src = corr.snapmirrorVsPorts(db).find((r) => r.side === 'source');
    expect(src.finding).toBe('elevated');
    expect(src.meanErrors).toBe(9);
  });

  it('narrows to the intercluster LIF port when the node has one', () => {
    array('srcclu', ['srcclu-01']);
    const dst = array('dstclu', ['dstclu-01']);
    port(501, 'srcclu-01', 'e4a', 96);
    port(503, 'srcclu-01', 'e0c', 15);
    port(502, 'dstclu-01', 'e4a', 20);
    const srcArr = db.prepare("SELECT id FROM netapp_arrays WHERE name = 'srcclu'").get().id;
    db.prepare("INSERT INTO netapp_lifs (array_id, name, node_name, port_name, services) VALUES (?, 'ic1', 'srcclu-01', 'e0c', 'default-intercluster')").run(srcArr);
    mirror(dst);
    const src = corr.snapmirrorVsPorts(db).filter((r) => r.side === 'source');
    expect(src).toHaveLength(1);
    expect(src[0]).toMatchObject({ nodePort: 'e0c', portRule: 'intercluster-lif', finding: 'normal' });
  });

  it('reports a side with no resolvable port as unmapped and sorts it last', () => {
    array('srcclu', ['srcclu-01']);
    const dst = array('dstclu', ['dstclu-01']);
    port(501, 'srcclu-01', 'e4a', 96);
    mirror(dst);
    const rows = corr.snapmirrorVsPorts(db);
    expect(rows.map((r) => `${r.side}:${r.finding}`)).toEqual(['source:saturates', 'destination:unmapped']);
  });

  it('flags a broken-off state even when the lag is small', () => {
    array('srcclu', ['srcclu-01']);
    const dst = array('dstclu', ['dstclu-01']);
    port(501, 'srcclu-01', 'e4a', 20);
    mirror(dst, { state: 'broken-off', lag: 60, healthy: 0 });
    expect(corr.snapmirrorVsPorts(db).length).toBeGreaterThan(0);
  });

  it('rides in the correlation payload under snapmirror', () => {
    array('srcclu', ['srcclu-01']);
    const dst = array('dstclu', ['dstclu-01']);
    port(501, 'srcclu-01', 'e4a', 96);
    mirror(dst);
    const payload = corr.correlation(db);
    expect(Array.isArray(payload.snapmirror)).toBe(true);
    expect(payload.snapmirror.length).toBe(2);
    expect(payload.snapmirror[0].finding).toBe('saturates');
  });
});

describe('backupLoad target side (Cohesity node ports)', () => {
  const cohesityMigrations = require('../db/migrations/cohesity');
  const endpoints = require('../services/logicmonitorEndpoints');

  function seedBackup() {
    runMigrations(db, 'cohesity', cohesityMigrations);
    for (const t of ['cohesity_nodes', 'cohesity_objects', 'protection_runs', 'clusters']) db.prepare(`DELETE FROM ${t}`).run();
    const cid = db.prepare("INSERT INTO clusters (name, connection_type, vip, auth_type, encrypted_credentials) VALUES ('snx1', 'direct', '10.9.9.100', 'apikey', 'x')").run().lastInsertRowid;
    db.prepare("INSERT INTO cohesity_nodes (cluster_id, node_id, hostname, ip) VALUES (?, '1', 'snx1-node-1', '10.9.9.1')").run(cid);
    db.prepare("INSERT INTO cohesity_objects (cluster_id, object_id, name, protection_groups, is_protected) VALUES (?, 1, 'fs01', ?, 1)").run(cid, JSON.stringify(['nightly']));
    const startS = Math.floor((Date.now() - 90 * MIN) / 1000);
    db.prepare("INSERT INTO protection_runs (cluster_id, job_id, job_name, status, start_time, end_time, logical_bytes) VALUES (?, 1, 'nightly', 'Succeeded', ?, ?, 5000000000)")
      .run(cid, startS, startS + 3600);
    // client port: fs01 on instance 601; target port: snx1-node-1 on instance 602.
    const link = (inst, ref, platform) => {
      db.prepare(`INSERT INTO lm_interfaces (source_id, lm_device_id, instance_id, display_name, status_text, in_util_pct, out_util_pct, stale)
        VALUES (?, 1, ?, ?, 'up', 50, 50, 0)`).run(sid, inst, `Eth1/${inst}`);
      db.prepare(`INSERT INTO lm_topology_links (source_id, src_device_id, src_instance_id, src_port, dst_name, dst_port, protocol, confidence, last_seen, dst_platform, dst_ref)
        VALUES (?, 1, ?, ?, ?, 'e0a', 'description', 'high', datetime('now'), ?, ?)`).run(sid, inst, `Eth1/${inst}`, ref, platform, ref);
      for (let m = 5; m <= 85; m += 10) {
        db.prepare('INSERT INTO lm_interface_history (source_id, instance_id, captured_at, status, in_util_pct, out_util_pct) VALUES (?, ?, ?, 1, 91, 40)').run(sid, inst, sqlTs(m * MIN));
      }
    };
    link(601, 'fs01', 'dell');
    link(602, 'snx1-node-1', 'cohesity');
  }

  it('adds node-port rows with side target next to the client rows', () => {
    seedBackup();
    const rows = endpoints.backupLoad(db, { days: 7 });
    const client = rows.filter((r) => r.side === 'client');
    const target = rows.filter((r) => r.side === 'target');
    expect(client).toHaveLength(1);
    expect(client[0]).toMatchObject({ host: 'fs01', port: 'Eth1/601' });
    expect(target).toHaveLength(1);
    expect(target[0]).toMatchObject({ host: 'snx1-node-1', hostPlatform: 'cohesity', port: 'Eth1/602', uplinkRule: 'node-ports', cluster: 'snx1', finding: 'saturates' });
    expect(target[0].runs[0].jobName).toBe('nightly');
  });

  it('leaves the target side empty without cohesity_nodes rows', () => {
    seedBackup();
    db.prepare('DELETE FROM cohesity_nodes').run();
    const rows = endpoints.backupLoad(db, { days: 7 });
    expect(rows.every((r) => r.side === 'client')).toBe(true);
  });
});
