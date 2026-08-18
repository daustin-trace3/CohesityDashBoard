// NetApp ONTAP scope demo data. Ported from backend/demo/generators/netapp.js.
// ALL inserts here run ONLY behind the DASHBOARD_DEMO==='1' gate — see
// seedNetappDemo() below, called from poller.js's manifest createPoller(coreApi)
// entry point on every boot in demo mode. Only the seeded-random helpers were
// copied from the host's demo/generators/core.js (./demoRng.js) — no
// seedCore/encryption requires. Credential encryption uses
// coreApi.encryption.encrypt (dell/nutanix/unifi plugin demoSeed.js precedent)
// instead of requiring the host's encryption service directly.
//
// DEVIATION FROM THE BUILT-IN's wipe strategy: netapp_arrays and
// netapp_aiqum_instances are NEVER wiped/deleted (they are the user-facing
// connection tables — an admin could register a real cluster/gateway on a
// demo instance and that must survive a reseed). Instead the fixture arrays
// and the fixture gateway are upserted by name so their id stays stable
// across boots, and only THEIR dependent rows (scoped by array_id) are wiped
// before reseeding, children before parents — any independently-registered
// real array's data is untouched.
const { randInt, randFloat, pick, chance, rngFor } = require('./demoRng');

const PRD_SITES = ['nyc', 'lon', 'fra', 'sgp'];
const DR_SITE = 'syd';
const DEV_SITE = 'chi';

const NODE_MODELS = ['AFF-A400', 'AFF-A250', 'FAS8300', 'AFF-C800'];
const ONTAP_VERSIONS = ['9.14.1', '9.13.1'];
const NETAPP_ALERT_SEVERITIES = ['error', 'warning', 'critical', 'warning', 'info'];
const NETAPP_ALERT_SOURCES = ['health', 'ems'];
const SVM_NAMES = ['svm_nfs_prod', 'svm_cifs_corp', 'svm_nfs_dev', 'svm_cifs_finance'];

// Children->parents, scoped by array_id — netapp_arrays/netapp_aiqum_instances
// are NEVER wiped (see module header).
const DEMO_CHILD_TABLES = [
  'netapp_cifs_shares', 'netapp_cifs_sessions', 'netapp_export_rules', 'netapp_nfs_clients',
  'netapp_quotas', 'netapp_lifs', 'netapp_snapmirror', 'netapp_alerts', 'netapp_disks',
  'netapp_nodes', 'netapp_svms', 'netapp_volumes', 'netapp_aggregates', 'netapp_metrics_history',
];

function buildArrayList() {
  const arrays = [];
  for (const site of PRD_SITES) arrays.push({ name: `${site}-ontap-prd-01`, site, env: 'prd', source: 'direct' });
  arrays.push({ name: `${DR_SITE}-ontap-dr-01`, site: DR_SITE, env: 'dr', source: 'aiqum' });
  arrays.push({ name: `${DEV_SITE}-ontap-dev-01`, site: DEV_SITE, env: 'dev', source: 'aiqum' });
  return arrays;
}

function seedNetapp(db, { now, encrypt }) {
  const arrayDefs = buildArrayList();
  const nowIso = new Date(now).toISOString();

  // Upsert the fixture gateway by host so its id stays stable across reseeds.
  // netapp_aiqum_instances has no UNIQUE(host) constraint, so this is a
  // manual look-up-then-update/insert rather than an ON CONFLICT upsert.
  let gwId = db.prepare('SELECT id FROM netapp_aiqum_instances WHERE host = ?').get('https://aiqum.icc.demo')?.id;
  if (!gwId) {
    const r = db.prepare(`
      INSERT INTO netapp_aiqum_instances (name, host, username, encrypted_credentials, poll_interval_minutes)
      VALUES ('AIQUM (demo)', 'https://aiqum.icc.demo', 'operator', ?, 15)
    `).run(encrypt('demo-not-real'));
    gwId = r.lastInsertRowid;
  } else {
    db.prepare("UPDATE netapp_aiqum_instances SET encrypted_credentials = ?, updated_at = datetime('now') WHERE id = ?")
      .run(encrypt('demo-not-real'), gwId);
  }

  // Upsert fixture arrays by name (stable ids across reseeds).
  const upsertArray = db.prepare(`
    INSERT INTO netapp_arrays (name, mgmt_host, username, encrypted_credentials, polling_interval_minutes, ssl_verify, cluster_uuid, management_ip, version, source, aiqum_instance_id, created_at, updated_at)
    VALUES (?, ?, 'demo', ?, 15, 0, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      mgmt_host = excluded.mgmt_host, encrypted_credentials = excluded.encrypted_credentials,
      cluster_uuid = excluded.cluster_uuid, management_ip = excluded.management_ip,
      version = excluded.version, source = excluded.source, aiqum_instance_id = excluded.aiqum_instance_id,
      updated_at = excluded.updated_at
  `);
  const getArrayId = db.prepare('SELECT id FROM netapp_arrays WHERE name = ?');

  const arrays = arrayDefs.map((def, idx) => {
    const rng = rngFor(def.name);
    const credentials = encrypt(JSON.stringify({ password: 'demo-not-real' }));
    const mgmtHost = `10.${50 + idx}.1.10`;
    const version = pick(rng, ONTAP_VERSIONS);
    upsertArray.run(def.name, mgmtHost, credentials, `uuid-${def.name}`, mgmtHost, version,
      def.source, def.source === 'aiqum' ? gwId : null, nowIso, nowIso);
    const id = getArrayId.get(def.name).id;
    return { ...def, id, rng, version, mgmtHost };
  });

  // Wipe THIS fixture's dependent rows only, children before parents — any
  // independently-registered real array's data is untouched.
  const fixtureIds = arrays.map((a) => a.id);
  const placeholders = fixtureIds.map(() => '?').join(',');
  for (const table of DEMO_CHILD_TABLES) {
    db.prepare(`DELETE FROM ${table} WHERE array_id IN (${placeholders})`).run(...fixtureIds);
  }

  const insertMetric = db.prepare(`
    INSERT INTO netapp_metrics_history (array_id, captured_at, total_bytes, used_bytes, available_bytes, physical_used_bytes, logical_used_bytes, efficiency_ratio, volume_count, aggregate_count, read_iops, write_iops, read_throughput_bytes, write_throughput_bytes, read_latency_us, write_latency_us, ontap_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAggregate = db.prepare(`
    INSERT INTO netapp_aggregates (array_id, uuid, name, node_name, state, size_bytes, used_bytes, available_bytes, used_percent, physical_used_bytes, efficiency_ratio, captured_at)
    VALUES (?, ?, ?, ?, 'online', ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertVolume = db.prepare(`
    INSERT INTO netapp_volumes (array_id, uuid, name, svm_name, aggregate_name, state, size_bytes, used_bytes, available_bytes, used_percent, physical_used_bytes, captured_at)
    VALUES (?, ?, ?, ?, ?, 'online', ?, ?, ?, ?, ?, ?)
  `);
  const insertSvm = db.prepare(`
    INSERT INTO netapp_svms (array_id, uuid, name, state, captured_at) VALUES (?, ?, ?, 'running', ?)
  `);
  const insertNode = db.prepare(`
    INSERT INTO netapp_nodes (array_id, uuid, name, model, serial_number, state, version, captured_at)
    VALUES (?, ?, ?, ?, ?, 'up', ?, ?)
  `);
  const insertDisk = db.prepare(`
    INSERT INTO netapp_disks (array_id, name, model, vendor, type, state, size_bytes, captured_at)
    VALUES (?, ?, 'X371_S1643960ATE', 'NETAPP', 'SSD', 'present', ?, ?)
  `);
  const insertAlert = db.prepare(`
    INSERT INTO netapp_alerts (array_id, alert_key, severity, node_name, source, message, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSnapmirror = db.prepare(`
    INSERT INTO netapp_snapmirror (array_id, uuid, source_path, source_cluster, destination_path, destination_cluster, state, healthy, lag_seconds, transfer_state, last_transfer_bytes, last_transfer_end, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?)
  `);
  const insertLif = db.prepare(`
    INSERT INTO netapp_lifs (array_id, uuid, name, svm_name, address, netmask, enabled, state, services, node_name, port_name, is_home, failover, captured_at)
    VALUES (?, ?, ?, ?, ?, '255.255.255.0', 1, 'up', 'data', ?, ?, 1, 'home_node_only', ?)
  `);
  const insertQuota = db.prepare(`
    INSERT INTO netapp_quotas (array_id, svm_name, volume_name, qtree_name, type, space_used_bytes, space_hard_limit_bytes, files_used, captured_at)
    VALUES (?, ?, ?, ?, 'tree', ?, ?, ?, ?)
  `);
  const insertNfsClient = db.prepare(`
    INSERT INTO netapp_nfs_clients (array_id, client_ip, server_ip, svm_name, node_name, volume_name, protocol, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, 'nfs3', ?)
  `);
  const insertExportRule = db.prepare(`
    INSERT INTO netapp_export_rules (array_id, policy_name, svm_name, rule_index, clients, protocols, ro_rule, rw_rule, superuser, captured_at)
    VALUES (?, ?, ?, ?, ?, 'nfs', 'any', 'sys', 'any', ?)
  `);
  const insertCifsSession = db.prepare(`
    INSERT INTO netapp_cifs_sessions (array_id, client_ip, server_ip, svm_name, node_name, volume_name, smb_user, mapped_unix_user, protocol, authentication, smb_encryption, smb_signing, open_shares, open_files, connected_duration, idle_duration, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'smb3', 'ntlm', 'unencrypted', 1, ?, ?, ?, ?, ?)
  `);
  const insertCifsShare = db.prepare(`
    INSERT INTO netapp_cifs_shares (array_id, share_name, path, svm_name, volume_name, captured_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  // ── Metrics: 30 days @ 2h cadence ──────────────────────────────────────
  let metricsCount = 0;
  for (const arr of arrays) {
    const rng = arr.rng;
    const totalBytes = Math.round(randFloat(rng, 200, 800, 2) * 1e12);
    const effRatio = randFloat(rng, 2.1, 3.4, 2);
    const volumeCount = randInt(rng, 15, 40);
    const aggregateCount = randInt(rng, 2, 4);

    for (let i = 0; i < 360; i++) {
      const capturedAt = new Date(now - i * 120 * 60000).toISOString();
      const usedPct = randFloat(rng, 50, 75, 1);
      const usedBytes = Math.round(totalBytes * (usedPct / 100));
      const availableBytes = totalBytes - usedBytes;
      const diurnal = 1 + 0.4 * Math.sin(((i % 12) / 12) * Math.PI * 2);
      const readIops = Math.round(randFloat(rng, 500, 8000, 0) * diurnal);
      const writeIops = Math.round(randFloat(rng, 300, 5000, 0) * diurnal);
      insertMetric.run(
        arr.id,
        capturedAt,
        totalBytes,
        usedBytes,
        availableBytes,
        Math.round(usedBytes * 0.9),
        Math.round(usedBytes * effRatio),
        effRatio,
        volumeCount,
        aggregateCount,
        readIops,
        writeIops,
        Math.round(readIops * randFloat(rng, 4000, 32000, 0)),
        Math.round(writeIops * randFloat(rng, 4000, 32000, 0)),
        randFloat(rng, 200, 1500, 1),
        randFloat(rng, 200, 1800, 1),
        arr.version
      );
      metricsCount++;
    }

    // ── Aggregates ─────────────────────────────────────────────────────
    for (let i = 0; i < aggregateCount; i++) {
      const sizeBytes = Math.round((totalBytes / aggregateCount) * randFloat(rng, 0.9, 1.1, 2));
      const usedPct = randFloat(rng, 50, 75, 1);
      const usedBytes = Math.round(sizeBytes * (usedPct / 100));
      insertAggregate.run(
        arr.id,
        `agg-uuid-${arr.id}-${i}`,
        `aggr_${arr.name.replace(/-/g, '_')}_${i}`,
        `${arr.name}-node-${(i % 2) + 1}`,
        sizeBytes,
        usedBytes,
        sizeBytes - usedBytes,
        usedPct,
        Math.round(usedBytes * 0.9),
        effRatio,
        nowIso
      );
    }

    // ── Volumes ────────────────────────────────────────────────────────
    const volDetail = db.prepare(`
      UPDATE netapp_volumes SET type = ?, style = ?, create_time = ?, is_svm_root = 0,
        junction_path = ?, security_style = ?, export_policy = ?, snapshot_policy = ?,
        guarantee_type = ?, autosize_mode = ?, autosize_max_bytes = ?,
        files_used = ?, files_maximum = ?, snapshot_used_bytes = ?, snapshot_reserve_percent = ?,
        logical_used_bytes = ?, snaplock_type = ?, encryption_enabled = ?, anti_ransomware_state = ?,
        qos_policy = ?, tiering_policy = ?, quota_state = 'off', is_inconsistent = 0,
        metric_iops = ?, metric_throughput_bps = ?, metric_latency_us = ?
      WHERE uuid = ?
    `);
    for (let i = 0; i < volumeCount; i++) {
      const sizeBytes = Math.round(randFloat(rng, 100, 5000, 2) * 1e9);
      const usedPct = randFloat(rng, 40, 85, 1);
      const usedBytes = Math.round(sizeBytes * (usedPct / 100));
      const uuid = `vol-uuid-${arr.id}-${i}`;
      const name = `vol_${arr.name.replace(/-/g, '_')}_${i}`;
      insertVolume.run(
        arr.id,
        uuid,
        name,
        pick(rng, SVM_NAMES),
        `aggr_${arr.name.replace(/-/g, '_')}_${i % aggregateCount}`,
        sizeBytes,
        usedBytes,
        sizeBytes - usedBytes,
        usedPct,
        Math.round(usedBytes * 0.9),
        nowIso
      );
      // ~12% mirror destinations, one WORM + one inode-pressure volume per cluster.
      const dp = chance(rng, 0.12);
      const filesMax = 21251126;
      const inodeHot = i === 2;
      volDetail.run(
        dp ? 'dp' : 'rw', chance(rng, 0.15) ? 'flexgroup' : 'flexvol',
        new Date(now - randInt(rng, 30, 900) * 86400000).toISOString(),
        dp ? null : `/${name}`, dp ? null : pick(rng, ['unix', 'unix', 'ntfs']),
        dp ? null : `ep_${name}`, dp ? 'none' : pick(rng, ['default', 'default', 'hourly-7d']),
        chance(rng, 0.8) ? 'none' : 'volume',
        chance(rng, 0.6) ? 'grow' : 'off', Math.round(sizeBytes * 1.2),
        inodeHot ? Math.round(filesMax * 0.93) : randInt(rng, 50000, 4000000), filesMax,
        Math.round(usedBytes * randFloat(rng, 0.02, 0.15, 3)), 5,
        Math.round(usedBytes * randFloat(rng, 1.4, 2.6, 2)),
        i === 4 ? 'enterprise' : 'non_snaplock', chance(rng, 0.5) ? 1 : 0,
        chance(rng, 0.3) ? 'enabled' : 'disabled',
        chance(rng, 0.2) ? 'gold-qos' : null, pick(rng, ['none', 'none', 'snapshot-only', 'auto']),
        randInt(rng, 50, 8000), randInt(rng, 5, 400) * 1e6, randInt(rng, 200, 4000),
        uuid
      );
    }

    // ── SVMs ───────────────────────────────────────────────────────────
    const svmCount = randInt(rng, 2, 4);
    for (let i = 0; i < svmCount; i++) {
      insertSvm.run(arr.id, `svm-uuid-${arr.id}-${i}`, SVM_NAMES[i % SVM_NAMES.length], nowIso);
    }

    // ── Nodes (HA pair) ────────────────────────────────────────────────
    const nodeCount = chance(rng, 0.5) ? 2 : 4;
    const model = pick(rng, NODE_MODELS);
    for (let i = 0; i < nodeCount; i++) {
      insertNode.run(arr.id, `node-uuid-${arr.id}-${i}`, `${arr.name}-node-${i + 1}`, model, `SN${arr.id}${i}${randInt(rng, 1000, 9999)}`, arr.version, nowIso);
    }

    // ── Disks ──────────────────────────────────────────────────────────
    const diskCount = randInt(rng, 24, 48);
    for (let i = 0; i < diskCount; i++) {
      insertDisk.run(arr.id, `${arr.name}-disk-${i}`, Math.round(randFloat(rng, 1, 4, 0) * 1e12), nowIso);
    }

    // ── Alerts ─────────────────────────────────────────────────────────
    const alertCount = randInt(rng, 2, 5);
    for (let i = 0; i < alertCount; i++) {
      insertAlert.run(
        arr.id,
        `demo-${arr.id}-${i}`,
        pick(rng, NETAPP_ALERT_SEVERITIES),
        `${arr.name}-node-1`,
        pick(rng, NETAPP_ALERT_SOURCES),
        `Sample ${arr.name} alert ${i}`,
        nowIso
      );
    }

    // ── LIFs ───────────────────────────────────────────────────────────
    const lifCount = randInt(rng, 4, 8);
    for (let i = 0; i < lifCount; i++) {
      insertLif.run(
        arr.id,
        `lif-uuid-${arr.id}-${i}`,
        `lif_${arr.name.replace(/-/g, '_')}_${i}`,
        pick(rng, SVM_NAMES),
        `10.${50 + arr.id}.2.${i + 10}`,
        `${arr.name}-node-${(i % 2) + 1}`,
        `e0${(i % 4) + 1}`,
        nowIso
      );
    }

    // ── Quotas ─────────────────────────────────────────────────────────
    for (let i = 0; i < 10; i++) {
      const limit = Math.round(randFloat(rng, 50, 500, 2) * 1e9);
      insertQuota.run(arr.id, pick(rng, SVM_NAMES), `vol_${arr.name.replace(/-/g, '_')}_${i % volumeCount}`, `qt${i}`, Math.round(limit * randFloat(rng, 0.2, 0.8, 2)), limit, randInt(rng, 100, 50000), nowIso);
    }

    // ── NFS clients + export rules ───────────────────────────────────────
    for (let i = 0; i < 10; i++) {
      insertNfsClient.run(arr.id, `10.${50 + arr.id}.5.${i + 20}`, arr.mgmtHost, pick(rng, SVM_NAMES), `${arr.name}-node-1`, `vol_${arr.name.replace(/-/g, '_')}_${i % volumeCount}`, nowIso);
    }
    // Server 360 demo coherence: sessions from nyc vCenter VM IPs
    // (10.100.11.11-13 = the first VMs on nyc-esx-0101) so the correlated
    // view finds live NFS+SMB mounts for those servers. First array only.
    if (arr.id === arrays[0].id) {
      const s360vol = `vol_${arr.name.replace(/-/g, '_')}_0`;
      for (const ip of ['10.100.11.11', '10.100.11.12', '10.100.11.13']) {
        insertNfsClient.run(arr.id, ip, arr.mgmtHost, SVM_NAMES[0], `${arr.name}-node-1`, s360vol, nowIso);
      }
      insertCifsSession.run(arr.id, '10.100.11.11', arr.mgmtHost, SVM_NAMES[0], `${arr.name}-node-1`,
        `vol_${arr.name.replace(/-/g, '_')}_1`, 'demo\\svc-app', 'svc_app', 2, 14, 'P2DT4H10M', 'PT8M', nowIso);
    }
    for (let i = 0; i < 8; i++) {
      insertExportRule.run(arr.id, `export-policy-${i}`, pick(rng, SVM_NAMES), i, '0.0.0.0/0', nowIso);
    }

    // ── CIFS sessions + shares ────────────────────────────────────────────
    for (let i = 0; i < 8; i++) {
      insertCifsSession.run(
        arr.id,
        `10.${50 + arr.id}.6.${i + 30}`,
        arr.mgmtHost,
        pick(rng, SVM_NAMES),
        `${arr.name}-node-1`,
        `vol_${arr.name.replace(/-/g, '_')}_${i % volumeCount}`,
        `demo\\user${i}`,
        `unix_user${i}`,
        randInt(rng, 1, 5),
        randInt(rng, 1, 20),
        `${randInt(rng, 1, 48)}h`,
        `${randInt(rng, 0, 60)}m`,
        nowIso
      );
    }
    for (let i = 0; i < 10; i++) {
      insertCifsShare.run(arr.id, `share_${i}`, `/vol_${arr.name.replace(/-/g, '_')}_${i % volumeCount}`, pick(rng, SVM_NAMES), `vol_${arr.name.replace(/-/g, '_')}_${i % volumeCount}`, nowIso);
    }
  }

  // ── Snapmirror: prd -> dr paths ─────────────────────────────────────────
  let snapmirrorCount = 0;
  const prdArrays = arrays.filter((a) => a.env === 'prd');
  const drArray = arrays.find((a) => a.env === 'dr');
  if (drArray) {
    const relationshipsPerArray = Math.ceil(randInt(prdArrays[0].rng, 6, 12) / prdArrays.length);
    for (const src of prdArrays) {
      const rng = src.rng;
      for (let i = 0; i < relationshipsPerArray; i++) {
        const svm = pick(rng, SVM_NAMES);
        const volName = `vol_name_${i}`;
        const broken = chance(rng, 0.15);
        const lagSeconds = broken ? randInt(rng, 90000, 200000) : randInt(rng, 30, 1800);
        insertSnapmirror.run(
          src.id,
          `sm-uuid-${src.id}-${i}`,
          `${src.name}://${svm}/${volName}`,
          src.name,
          `${drArray.name}://${svm}_dr/${volName}`,
          drArray.name,
          broken ? 'broken_off' : 'snapmirrored',
          broken ? 0 : 1,
          lagSeconds,
          Math.round(randFloat(rng, 1, 500, 2) * 1e9),
          new Date(now - randInt(rng, 60, 7200) * 1000).toISOString(),
          nowIso
        );
        snapmirrorCount++;
      }
    }
  }

  return {
    arrays: arrays.length,
    metrics: metricsCount,
    snapmirror: snapmirrorCount,
  };
}

/** Demo-only entry point. Upserts the fixture arrays + gateway (id stable
 *  across boots), wipes their dependent rows, and regenerates them with
 *  fresh relative timestamps, so a demo box refreshes on every boot instead
 *  of aging into a stale-looking estate. NEVER runs outside demo mode — see
 *  the DASHBOARD_DEMO gate in poller.js. */
function seedNetappDemo(coreApi) {
  const db = coreApi.db;
  return db.transaction(() => seedNetapp(db, { now: Date.now(), encrypt: coreApi.encryption.encrypt }))();
}

module.exports = { seedNetapp, seedNetappDemo, buildArrayList };
