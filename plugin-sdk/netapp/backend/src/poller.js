// NetApp ONTAP poller. Ported from backend/services/netappPoller.js. Two
// framework poller tasks share this module: `directPoller` (one schedule per
// directly-registered cluster) and `aiqumPoller` (one schedule per AIQUM
// gateway row — each poll reconciles that gateway's managed clusters into
// netapp_arrays, then polls each). db/logger/settings/createPoller now come
// from coreApi rather than direct host requires.
//
// Module-scoped singleton: createRouter() and manifest.createPoller() are
// both called by the host registry against the same coreApi, but createRouter
// runs first and needs to reach the same poller instances for
// schedule/cancel/trigger on cluster CRUD. getPollers() lazily builds them if
// not yet created (dell/unifi poller.js pattern).
const api = require('./api');

let pollers = null; // { directPoller, aiqumPoller }

function pollIntervalMin(coreApi) {
  return Math.min(1440, Math.max(5, Number(coreApi.settings.getSetting('netapp_poll_interval_min')) || 15));
}

/** Parse an ISO-8601 duration (e.g. "PT11H43M59S") into seconds. */
function isoDurationToSeconds(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  const [, d, h, min, sec] = m.map((x) => (x ? Number(x) : 0));
  return (d * 86400) + (h * 3600) + (min * 60) + sec;
}

function num(v) {
  return v === undefined || v === null ? null : Number(v);
}

function safeErrorMessage(err) {
  if (err?.response) return `HTTP ${err.response.status} from cluster`;
  if (err?.code) return `Network error: ${err.code}`;
  return err?.message || 'Unknown error';
}

function upsertMetrics(db, array, totals, metrics, counts, version) {
  db.prepare(`
    INSERT INTO netapp_metrics_history
      (array_id, captured_at, total_bytes, used_bytes, available_bytes, physical_used_bytes,
       logical_used_bytes, efficiency_ratio, volume_count, aggregate_count,
       read_iops, write_iops, read_throughput_bytes, write_throughput_bytes,
       read_latency_us, write_latency_us, ontap_version)
    VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    array.id,
    num(totals.total), num(totals.used), num(totals.available), num(totals.physicalUsed),
    num(totals.logicalUsed), num(totals.ratio), num(counts.volumes), num(counts.aggregates),
    num(metrics?.iops?.read), num(metrics?.iops?.write),
    num(metrics?.throughput?.read), num(metrics?.throughput?.write),
    num(metrics?.latency?.read), num(metrics?.latency?.write),
    version || null
  );
}

function buildReplacers(db) {
  const replaceAggregates = db.transaction((arrayId, items) => {
    db.prepare('DELETE FROM netapp_aggregates WHERE array_id = ?').run(arrayId);
    const stmt = db.prepare(`
      INSERT INTO netapp_aggregates
        (array_id, uuid, name, node_name, state, size_bytes, used_bytes, available_bytes,
         used_percent, physical_used_bytes, efficiency_ratio)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const a of items) {
      const bs = (a.space && a.space.block_storage) || {};
      const eff = (a.space && a.space.efficiency) || {};
      stmt.run(arrayId, a.uuid || null, a.name || null, a.node?.name || null, a.state || null,
        num(bs.size), num(bs.used), num(bs.available), num(bs.used_percent), num(bs.physical_used), num(eff.ratio));
    }
  });

  const replaceVolumes = db.transaction((arrayId, items) => {
    db.prepare('DELETE FROM netapp_volumes WHERE array_id = ?').run(arrayId);
    const stmt = db.prepare(`
      INSERT INTO netapp_volumes
        (array_id, uuid, name, svm_name, aggregate_name, state, size_bytes, used_bytes,
         available_bytes, used_percent, physical_used_bytes,
         type, style, comment, create_time, is_svm_root, junction_path, security_style,
         export_policy, snapshot_policy, guarantee_type, autosize_mode, autosize_max_bytes,
         files_used, files_maximum, snapshot_used_bytes, snapshot_reserve_percent,
         logical_used_bytes, snaplock_type, encryption_enabled, anti_ransomware_state,
         qos_policy, tiering_policy, quota_state, is_inconsistent,
         metric_iops, metric_throughput_bps, metric_latency_us)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const flag = (v) => v == null ? null : (v ? 1 : 0);
    for (const v of items) {
      const s = v.space || {};
      const m = v.metric || {};
      stmt.run(arrayId, v.uuid || null, v.name || null, v.svm?.name || null,
        v.aggregates?.[0]?.name || null, v.state || null,
        num(s.size), num(s.used), num(s.available), num(s.percent_used), num(s.physical_used),
        v.type || null, v.style || null, v.comment || null, v.create_time || null,
        flag(v.is_svm_root), v.nas?.path || null, v.nas?.security_style || null,
        v.nas?.export_policy?.name || null, v.snapshot_policy?.name || null,
        v.guarantee?.type || null, v.autosize?.mode || null, num(v.autosize?.maximum),
        num(v.files?.used), num(v.files?.maximum),
        num(s.snapshot?.used), num(s.snapshot?.reserve_percent),
        num(s.logical_space?.used), v.snaplock?.type || null,
        flag(v.encryption?.enabled), v.anti_ransomware?.state || null,
        v.qos?.policy?.name || null, v.tiering?.policy || null, v.quota?.state || null,
        flag(v.error_state?.is_inconsistent),
        num(m.iops?.total), num(m.throughput?.total), num(m.latency?.total));
    }
  });

  const replaceSvms = db.transaction((arrayId, items) => {
    db.prepare('DELETE FROM netapp_svms WHERE array_id = ?').run(arrayId);
    const stmt = db.prepare('INSERT INTO netapp_svms (array_id, uuid, name, state) VALUES (?, ?, ?, ?)');
    for (const s of items) stmt.run(arrayId, s.uuid || null, s.name || null, s.state || null);
  });

  const replaceNodes = db.transaction((arrayId, items) => {
    db.prepare('DELETE FROM netapp_nodes WHERE array_id = ?').run(arrayId);
    const stmt = db.prepare(`
      INSERT INTO netapp_nodes (array_id, uuid, name, model, serial_number, state, version)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const n of items) {
      stmt.run(arrayId, n.uuid || null, n.name || null, n.model || null, n.serial_number || null,
        n.state || null, (n.version && n.version.full) || null);
    }
  });

  const replaceDisks = db.transaction((arrayId, items) => {
    db.prepare('DELETE FROM netapp_disks WHERE array_id = ?').run(arrayId);
    const stmt = db.prepare(`
      INSERT INTO netapp_disks (array_id, name, model, vendor, type, state, size_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const d of items) {
      stmt.run(arrayId, d.name || null, d.model || null, d.vendor || null, d.type || null,
        d.state || null, num(d.usable_size));
    }
  });

  const replaceAlerts = db.transaction((arrayId, healthAlerts, emsAlerts) => {
    db.prepare('DELETE FROM netapp_alerts WHERE array_id = ?').run(arrayId);
    const stmt = db.prepare(`
      INSERT INTO netapp_alerts (array_id, alert_key, severity, node_name, source, message)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const h of healthAlerts) {
      stmt.run(arrayId, String(h.alert_id ?? h.index ?? ''), (h.severity || 'unknown'),
        h.node || null, 'health', h.probable_cause || h.alerting_resource || h.monitor || null);
    }
    for (const e of emsAlerts) {
      stmt.run(arrayId, String(e.index ?? ''), (e.message?.severity || 'error'),
        e.node?.name || null, 'ems', e.message?.name || null);
    }
  });

  const replaceSnapmirror = db.transaction((arrayId, items) => {
    db.prepare('DELETE FROM netapp_snapmirror WHERE array_id = ?').run(arrayId);
    const stmt = db.prepare(`
      INSERT INTO netapp_snapmirror
        (array_id, uuid, source_path, source_cluster, destination_path, destination_cluster,
         state, healthy, lag_seconds, transfer_state, last_transfer_bytes, last_transfer_end)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of items) {
      const t = r.transfer || {};
      stmt.run(
        arrayId, r.uuid || null,
        r.source?.path || null, r.source?.cluster?.name || null,
        r.destination?.path || null, r.destination?.cluster?.name || null,
        r.state || null, r.healthy ? 1 : 0, isoDurationToSeconds(r.lag_time),
        t.state || null, num(t.bytes_transferred), t.end_time || null
      );
    }
  });

  const replaceLifs = db.transaction((arrayId, items) => {
    db.prepare('DELETE FROM netapp_lifs WHERE array_id = ?').run(arrayId);
    const stmt = db.prepare(`
      INSERT INTO netapp_lifs
        (array_id, uuid, name, svm_name, address, netmask, enabled, state, services, node_name, port_name, is_home, failover)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const l of items) {
      const loc = l.location || {};
      stmt.run(
        arrayId, l.uuid || null, l.name || null, l.svm?.name || null,
        l.ip?.address || null, l.ip?.netmask != null ? String(l.ip.netmask) : null,
        l.enabled ? 1 : 0, l.state || null,
        Array.isArray(l.services) ? l.services.join(', ') : null,
        loc.node?.name || null, loc.port?.name || null, loc.is_home ? 1 : 0, loc.failover || null
      );
    }
  });

  const replaceQuotas = db.transaction((arrayId, items) => {
    db.prepare('DELETE FROM netapp_quotas WHERE array_id = ?').run(arrayId);
    const stmt = db.prepare(`
      INSERT INTO netapp_quotas
        (array_id, svm_name, volume_name, qtree_name, type, space_used_bytes, space_hard_limit_bytes, files_used)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const q of items) {
      const space = q.space || {};
      stmt.run(
        arrayId, q.svm?.name || null, q.volume?.name || null, q.qtree?.name || null, q.type || null,
        num(space.used?.total), num(space.hard_limit), num(q.files?.used?.total)
      );
    }
  });

  const replaceNfsClients = db.transaction((arrayId, items) => {
    db.prepare('DELETE FROM netapp_nfs_clients WHERE array_id = ?').run(arrayId);
    const stmt = db.prepare(`
      INSERT INTO netapp_nfs_clients (array_id, client_ip, server_ip, svm_name, node_name, volume_name, protocol)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const c of items) {
      stmt.run(arrayId, c.client_ip || null, c.server_ip || null, c.svm?.name || null,
        c.node?.name || null, c.volume?.name || null, c.protocol || null);
    }
  });

  const replaceExportRules = db.transaction((arrayId, policies) => {
    db.prepare('DELETE FROM netapp_export_rules WHERE array_id = ?').run(arrayId);
    const stmt = db.prepare(`
      INSERT INTO netapp_export_rules
        (array_id, policy_name, svm_name, rule_index, clients, protocols, ro_rule, rw_rule, superuser)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const p of policies) {
      for (const r of p.rules || []) {
        stmt.run(
          arrayId, p.name || null, p.svm?.name || null, num(r.index),
          Array.isArray(r.clients) ? r.clients.map((c) => c.match).filter(Boolean).join(', ') : null,
          Array.isArray(r.protocols) ? r.protocols.join(', ') : null,
          Array.isArray(r.ro_rule) ? r.ro_rule.join(', ') : null,
          Array.isArray(r.rw_rule) ? r.rw_rule.join(', ') : null,
          Array.isArray(r.superuser) ? r.superuser.join(', ') : null
        );
      }
    }
  });

  const replaceCifsSessions = db.transaction((arrayId, items) => {
    db.prepare('DELETE FROM netapp_cifs_sessions WHERE array_id = ?').run(arrayId);
    const stmt = db.prepare(`
      INSERT INTO netapp_cifs_sessions
        (array_id, client_ip, server_ip, svm_name, node_name, volume_name, smb_user, mapped_unix_user,
         protocol, authentication, smb_encryption, smb_signing, open_shares, open_files,
         connected_duration, idle_duration)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const s of items) {
      // A session can access several volumes — store one row per volume so the
      // client-to-volume drill-down mirrors the NFS view. Sessions with no open
      // volume still get a single row (volume null).
      const vols = Array.isArray(s.volumes) && s.volumes.length ? s.volumes : [null];
      for (const v of vols) {
        stmt.run(
          arrayId, s.client_ip || null, s.server_ip || null, s.svm?.name || null, s.node?.name || null,
          (v && v.name) || null, s.user || null, s.mapped_unix_user || null,
          s.protocol || null, s.authentication || null, s.smb_encryption || null,
          s.smb_signing ? 1 : 0, num(s.open_shares), num(s.open_files),
          s.connected_duration || null, s.idle_duration || null
        );
      }
    }
  });

  const replaceCifsShares = db.transaction((arrayId, items) => {
    db.prepare('DELETE FROM netapp_cifs_shares WHERE array_id = ?').run(arrayId);
    const stmt = db.prepare(`
      INSERT INTO netapp_cifs_shares (array_id, share_name, path, svm_name, volume_name)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const s of items) {
      stmt.run(arrayId, s.name || null, s.path || null, s.svm?.name || null, s.volume?.name || null);
    }
  });

  return {
    replaceAggregates, replaceVolumes, replaceSvms, replaceNodes, replaceDisks, replaceAlerts,
    replaceSnapmirror, replaceLifs, replaceQuotas, replaceNfsClients, replaceExportRules,
    replaceCifsSessions, replaceCifsShares,
  };
}

/** Poll a single NetApp cluster: capacity, performance, inventory, alerts. */
async function doPollArray(array, coreApi) {
  const db = coreApi.db;
  const R = buildReplacers(db);
  const [
    clusterR, nodesR, aggR, volR, svmR, diskR, metricsR, healthR, emsR,
    smR, lifR, quotaR, nfsR, exportR, cifsR, cifsShareR,
  ] = await Promise.allSettled([
    api.fetchCluster(array, coreApi), api.fetchNodes(array, coreApi), api.fetchAggregates(array, coreApi), api.fetchVolumes(array, coreApi),
    api.fetchSvms(array, coreApi), api.fetchDisks(array, coreApi), api.fetchClusterMetrics(array, coreApi),
    api.fetchHealthAlerts(array, coreApi), api.fetchEmsAlerts(array, coreApi),
    api.fetchSnapmirror(array, coreApi), api.fetchLifs(array, coreApi), api.fetchQuotas(array, coreApi),
    api.fetchNfsClients(array, coreApi), api.fetchExportPolicies(array, coreApi),
    api.fetchCifsSessions(array, coreApi), api.fetchCifsShares(array, coreApi),
  ]);

  const aggregates = aggR.status === 'fulfilled' ? aggR.value : [];
  const volumes = volR.status === 'fulfilled' ? volR.value : [];

  const totals = { total: 0, used: 0, available: 0, physicalUsed: 0, logicalUsed: 0, ratio: null };
  for (const a of aggregates) {
    const bs = (a.space && a.space.block_storage) || {};
    const eff = (a.space && a.space.efficiency) || {};
    totals.total += bs.size || 0;
    totals.used += bs.used || 0;
    totals.available += bs.available || 0;
    totals.physicalUsed += bs.physical_used || 0;
    totals.logicalUsed += eff.logical_used || 0;
  }
  if (totals.physicalUsed > 0 && totals.logicalUsed > 0) {
    totals.ratio = totals.logicalUsed / totals.physicalUsed;
  }

  const version = clusterR.status === 'fulfilled'
    ? (clusterR.value.version && clusterR.value.version.full)
    : null;
  const metrics = metricsR.status === 'fulfilled' ? metricsR.value : null;

  try {
    upsertMetrics(db, array, totals, metrics, { volumes: volumes.length, aggregates: aggregates.length }, version);
  } catch (err) {
    coreApi.logger.error(`[NetAppPoller] Metrics insert failed for array ${array.id}:`, err.message);
  }

  const stores = [
    [aggR, () => R.replaceAggregates(array.id, aggregates), 'aggregates'],
    [volR, () => R.replaceVolumes(array.id, volumes), 'volumes'],
    [svmR, () => R.replaceSvms(array.id, svmR.value || []), 'svms'],
    [nodesR, () => R.replaceNodes(array.id, nodesR.value || []), 'nodes'],
    [diskR, () => R.replaceDisks(array.id, diskR.value || []), 'disks'],
    [smR, () => R.replaceSnapmirror(array.id, smR.value || []), 'snapmirror'],
    [lifR, () => R.replaceLifs(array.id, lifR.value || []), 'lifs'],
    [quotaR, () => R.replaceQuotas(array.id, quotaR.value || []), 'quotas'],
    [nfsR, () => R.replaceNfsClients(array.id, nfsR.value || []), 'nfs-clients'],
    [exportR, () => R.replaceExportRules(array.id, exportR.value || []), 'export-policies'],
    [cifsR, () => R.replaceCifsSessions(array.id, cifsR.value || []), 'cifs-sessions'],
    [cifsShareR, () => R.replaceCifsShares(array.id, cifsShareR.value || []), 'cifs-shares'],
  ];
  for (const [result, store, label] of stores) {
    if (result.status === 'fulfilled') {
      try { store(); } catch (err) { coreApi.logger.error(`[NetAppPoller] ${label} store failed for array ${array.id}:`, err.message); }
    } else {
      coreApi.logger.error(`[NetAppPoller] ${label} fetch failed for array ${array.id}:`, safeErrorMessage(result.reason));
    }
  }

  try {
    R.replaceAlerts(array.id,
      healthR.status === 'fulfilled' ? healthR.value : [],
      emsR.status === 'fulfilled' ? emsR.value : []);
  } catch (err) {
    coreApi.logger.error(`[NetAppPoller] Alerts store failed for array ${array.id}:`, err.message);
  }
}

/**
 * Discover the clusters AIQUM manages and reconcile them into netapp_arrays.
 * Existing rows are matched by cluster_uuid, then by name (adopts prior direct
 * registrations in place so their history survives). Rows no longer managed by
 * AIQUM are removed (cascade clears their telemetry).
 */
async function syncClusters(instance, coreApi) {
  const db = coreApi.db;
  const clusters = await api.fetchManagedClusters(api.instanceConfig(instance, coreApi), coreApi);
  const reconcile = db.transaction((list) => {
    const keep = new Set();
    for (const c of list) {
      if (!c.uuid) continue;
      keep.add(c.uuid);
      const host = api.normalizeHost(c.management_ip || c.name);
      const row = db.prepare('SELECT id FROM netapp_arrays WHERE cluster_uuid = ?').get(c.uuid)
        || db.prepare('SELECT id FROM netapp_arrays WHERE name = ?').get(c.name);
      if (row) {
        db.prepare(`UPDATE netapp_arrays SET name = ?, mgmt_host = ?, cluster_uuid = ?, management_ip = ?,
          version = ?, source = 'aiqum', aiqum_instance_id = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(c.name, host, c.uuid, c.management_ip, c.version, instance.id, row.id);
      } else {
        db.prepare(`INSERT INTO netapp_arrays
            (name, mgmt_host, username, encrypted_credentials, cluster_uuid, management_ip, version, source, polling_interval_minutes, aiqum_instance_id)
          VALUES (?, ?, 'aiqum-gateway', '', ?, ?, ?, 'aiqum', ?, ?)`)
          .run(c.name, host, c.uuid, c.management_ip, c.version, instance.poll_interval_minutes || pollIntervalMin(coreApi), instance.id);
      }
    }
    // Drop only THIS gateway's clusters that it no longer reports (legacy rows
    // with no gateway id are claimed/cleaned here too). Direct rows and other
    // gateways' rows are never touched.
    for (const r of db.prepare("SELECT id, cluster_uuid, aiqum_instance_id FROM netapp_arrays WHERE source = 'aiqum'").all()) {
      if ((r.aiqum_instance_id === instance.id || r.aiqum_instance_id == null) && !keep.has(r.cluster_uuid)) {
        db.prepare('DELETE FROM netapp_arrays WHERE id = ?').run(r.id);
      }
    }
  });
  reconcile(clusters);
  return db.prepare("SELECT * FROM netapp_arrays WHERE source = 'aiqum' AND aiqum_instance_id = ? ORDER BY name").all(instance.id);
}

function loadAiqumInstances(coreApi) {
  try { return coreApi.db.prepare('SELECT * FROM netapp_aiqum_instances ORDER BY id').all(); } catch { return []; }
}

/** Env-only setups (NETAPP_AIQUM_* with nothing in the DB): seed a gateway
 *  row once so the multi-gateway model is the single source of truth. */
function seedInstanceFromEnv(coreApi) {
  try {
    if (loadAiqumInstances(coreApi).length) return;
    const host = process.env.NETAPP_AIQUM_HOST;
    const user = process.env.NETAPP_AIQUM_USER;
    const pass = process.env.NETAPP_AIQUM_PW;
    if (!host || !user || !pass) return;
    coreApi.db.prepare(`
      INSERT INTO netapp_aiqum_instances (name, host, username, encrypted_credentials, poll_interval_minutes)
      VALUES ('AIQUM', ?, ?, ?, ?)
    `).run(host, user, coreApi.encryption.encrypt(pass), pollIntervalMin(coreApi));
    coreApi.logger.info('[NetAppPoller] Seeded AIQUM gateway row from environment variables');
  } catch (err) {
    coreApi.logger.warn('[NetAppPoller] Env AIQUM seed skipped:', err.message);
  }
}

function buildPollers(coreApi) {
  const directPoller = coreApi.createPoller({
    id: 'netapp',
    loadSources: () => coreApi.db.prepare("SELECT * FROM netapp_arrays WHERE source = 'direct'").all(),
    intervalMinutes: (array) => array.polling_interval_minutes,
    poll: (array) => doPollArray(array, coreApi),
  });

  /** Poll a single NetApp cluster (AIQUM-managed or direct). */
  async function pollArray(array) {
    await directPoller.trigger(array);
  }

  /** Reconcile one gateway's clusters from AIQUM, then poll each through it. */
  async function syncAndPollInstance(instance) {
    let clusters = [];
    try {
      clusters = await syncClusters(instance, coreApi);
    } catch (err) {
      coreApi.logger.error(`[NetAppPoller] AIQUM sync failed for ${instance.name || instance.host}:`, safeErrorMessage(err));
      clusters = coreApi.db.prepare(
        "SELECT * FROM netapp_arrays WHERE source = 'aiqum' AND (aiqum_instance_id = ? OR aiqum_instance_id IS NULL)"
      ).all(instance.id);
    }
    for (const c of clusters) {
      try { await pollArray(c); } catch (err) { coreApi.logger.error(`[NetAppPoller] poll failed for ${c.name}:`, safeErrorMessage(err)); }
    }
  }

  const aiqumPoller = coreApi.createPoller({
    id: 'netapp-aiqum',
    loadSources: () => loadAiqumInstances(coreApi),
    intervalMinutes: (inst) => inst.poll_interval_minutes || pollIntervalMin(coreApi),
    poll: syncAndPollInstance,
  });

  /** Sync + poll every configured gateway (Settings "Discover + poll now"). */
  async function syncAndPollAll() {
    for (const inst of loadAiqumInstances(coreApi)) {
      await syncAndPollInstance(inst);
    }
  }

  function reschedule() {
    aiqumPoller.reconcile();
  }

  function cancelArray(arrayId) {
    directPoller.cancel(arrayId);
  }

  function scheduleArray(array) {
    directPoller.schedule(array);
  }

  async function triggerPoll(arrayId) {
    const array = coreApi.db.prepare('SELECT * FROM netapp_arrays WHERE id = ?').get(arrayId);
    if (!array) throw new Error(`NetApp cluster ${arrayId} not found`);
    await pollArray(array);
  }

  function init() {
    seedInstanceFromEnv(coreApi);
    const instances = aiqumPoller.init();
    if (instances.length) {
      setTimeout(() => { syncAndPollAll().catch((e) => coreApi.logger.error('[NetAppPoller] initial poll failed:', safeErrorMessage(e))); }, 4000);
    }
    const aiqumClusterCount = coreApi.db.prepare("SELECT COUNT(*) AS n FROM netapp_arrays WHERE source = 'aiqum'").get().n;
    const directArrays = directPoller.init();
    coreApi.logger.info(`[NetAppPoller] Initialized ${instances.length} AIQUM gateway(s) (${aiqumClusterCount} cluster(s)), ${directArrays.length} direct cluster(s)`);
    return directArrays;
  }

  function stopAll() {
    directPoller.stopAll();
    aiqumPoller.stopAll();
  }

  return {
    directPoller, aiqumPoller,
    init, reschedule, syncClusters: (instance) => syncClusters(instance, coreApi),
    syncAndPollAll, syncAndPollInstance, pollArray, triggerPoll,
    scheduleArray, cancelArray, stopAll,
  };
}

/** Shared singleton (schedule/cancel/trigger/init/stopAll for both direct and
 *  AIQUM pollers), built lazily on first access regardless of whether
 *  createRouter or manifest.createPoller reaches it first. */
function getPollers(coreApi) {
  if (!pollers) pollers = buildPollers(coreApi);
  return pollers;
}

/** Manifest createPoller(coreApi) entry point. On a demo instance ONLY, this
 *  regenerates the fixture estate first (demoSeed.js) and never polls real
 *  hosts. Real instances behave exactly like the built-in's initNetAppPoller. */
function createNetappPoller(coreApi) {
  if (process.env.DASHBOARD_DEMO === '1') {
    const seedDemo = () => {
      try {
        const { seedNetappDemo } = require('./demoSeed');
        const r = seedNetappDemo(coreApi);
        coreApi.logger.info(`[NetAppPoller] demo estate seeded: ${r.arrays} array(s), ${r.metrics} metric row(s), ${r.snapmirror} snapmirror relationship(s)`);
        return r;
      } catch (err) {
        coreApi.logger.warn(`[NetAppPoller] demo seed failed: ${err.message}`);
        return null;
      }
    };
    seedDemo();
    // Demo instances seed fixtures but NEVER poll them: the seeded cluster
    // hosts are fictitious internal names — polling them for real would still
    // hammer DNS/connect failures every cycle and eventually flip the pristine
    // demo estate to error state. trigger() re-seeds instead, matching the
    // demo Refresh button semantics.
    return {
      init: () => { coreApi.logger.info('[NetAppPoller] demo mode — polling disabled, fixtures only'); return []; },
      schedule: () => {},
      cancel: () => {},
      trigger: () => { seedDemo(); return Promise.resolve(); },
      stopAll: () => {},
      taskCount: () => 0,
    };
  }

  const p = getPollers(coreApi);
  return {
    init: () => p.init(),
    schedule: (source) => p.directPoller.schedule(source),
    cancel: (sourceId) => p.directPoller.cancel(sourceId),
    trigger: (source) => p.directPoller.trigger(source),
    stopAll: p.stopAll,
    taskCount: () => p.directPoller.taskCount(),
  };
}

module.exports = { createNetappPoller, getPollers, doPollArray };
