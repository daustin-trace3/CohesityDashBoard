// vCenter routes, ported from backend/routes/vcenter.js. Mounted by the host
// dispatcher at /api/vcenter — paths below are relative.
//
// DEVIATION FROM THE BUILT-IN: bundled plugins cannot require the host's
// express/express-validator — createRouter must return a BARE (req, res,
// next) function (plugin-sdk/dell/unifi router.js pattern). This file
// hand-matches req.method/req.path against a route table (compile.js) and
// re-implements the validation express-validator did inline (validate.js),
// preserving the same status codes (400 invalid params, 404 missing, 409
// duplicate, 502 upstream/test-connection failure, 503/429 advisor errors)
// and JSON response shapes exactly.
const api = require('./api');
const { getPoller } = require('./poller');
const { DS_USED_WARN_PCT, CLUSTER_FREE_WARN_PCT, certWarnDays, computeIssues } = require('./issues');
const { createVcenterAdvisor } = require('./advisor');
const { compile } = require('./compile');
const {
  n1Usable, rollupSite, failoverMatrix, siteMap, clusterStats, writeCapacitySample, bucketHistory, growthOf, autoCreateSites, pairSummary,
} = require('./capacity');
const {
  badRequest, fail, parseIntStrict, isNonEmptyString, isBooleanish, toBool,
  requireIdParam, parseQueryInt,
} = require('./validate');

const publicVc = (row) => ({
  id: row.id, name: row.name, host: row.host, username: row.username,
  sslVerify: !!row.ssl_verify, pollingIntervalMinutes: row.polling_interval_minutes,
  lastPollStatus: row.last_poll_status, lastPollError: row.last_poll_error, lastPollAt: row.last_poll_at,
  version: row.version, build: row.build, productName: row.product_name,
});

// ── vCenter registration CRUD ────────────────────────────────────────────────

/** GET /vcenters — registered vCenters (never the credentials). */
function handleGetVcenters(req, res, coreApi) {
  res.json(coreApi.db.prepare('SELECT * FROM vcenter_vcenters ORDER BY name').all().map(publicVc));
}

/** POST /vcenters — register a vCenter. */
function handlePostVcenters(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  if (!isNonEmptyString(b.name, 120)) errors.push(fail('name'));
  if (!isNonEmptyString(b.host, 253)) errors.push(fail('host'));
  if (!isNonEmptyString(b.username, 256)) errors.push(fail('username'));
  if (!isNonEmptyString(b.password, 512)) errors.push(fail('password'));
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (b.pollingIntervalMinutes !== undefined) {
    const n = parseIntStrict(b.pollingIntervalMinutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) errors.push(fail('pollingIntervalMinutes'));
  }
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  const name = b.name.trim();
  const host = b.host.trim();
  const dup = db.prepare('SELECT id FROM vcenter_vcenters WHERE name = ? OR host = ?').get(name, host);
  if (dup) return res.status(409).json({ error: 'A vCenter with that name or host is already registered.' });
  const info = db.prepare(`
    INSERT INTO vcenter_vcenters (name, host, username, encrypted_credentials, ssl_verify, polling_interval_minutes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, host, b.username.trim(),
    coreApi.encryption.encrypt(JSON.stringify({ password: b.password })),
    toBool(b.sslVerify) ? 1 : 0, b.pollingIntervalMinutes ? parseIntStrict(b.pollingIntervalMinutes) : 15);
  const row = db.prepare('SELECT * FROM vcenter_vcenters WHERE id = ?').get(info.lastInsertRowid);
  const poller = getPoller(coreApi);
  poller.schedule(row);
  poller.trigger(row).catch(() => {});
  res.status(201).json(publicVc(row));
}

/** PUT /vcenters/:id — update (password optional; blank keeps stored). */
function handlePutVcenter(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const b = req.body || {};
  const errors = [];
  if (b.name !== undefined && !isNonEmptyString(b.name, 120)) errors.push(fail('name'));
  if (b.host !== undefined && !isNonEmptyString(b.host, 253)) errors.push(fail('host'));
  if (b.username !== undefined && !isNonEmptyString(b.username, 256)) errors.push(fail('username'));
  if (b.password !== undefined && b.password !== '' && !(typeof b.password === 'string' && b.password.length <= 512)) errors.push(fail('password'));
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (b.pollingIntervalMinutes !== undefined) {
    const n = parseIntStrict(b.pollingIntervalMinutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) errors.push(fail('pollingIntervalMinutes'));
  }
  if (errors.length) return badRequest(res, errors);

  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM vcenter_vcenters WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'vCenter not found.' });
  db.prepare(`
    UPDATE vcenter_vcenters SET
      name = ?, host = ?, username = ?, encrypted_credentials = ?,
      ssl_verify = ?, polling_interval_minutes = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    b.name?.trim() || row.name, b.host?.trim() || row.host, b.username?.trim() || row.username,
    b.password ? coreApi.encryption.encrypt(JSON.stringify({ password: b.password })) : row.encrypted_credentials,
    b.sslVerify !== undefined ? (toBool(b.sslVerify) ? 1 : 0) : row.ssl_verify,
    b.pollingIntervalMinutes ? parseIntStrict(b.pollingIntervalMinutes) : row.polling_interval_minutes,
    row.id
  );
  api.invalidateSession(row.id);
  const updated = db.prepare('SELECT * FROM vcenter_vcenters WHERE id = ?').get(row.id);
  getPoller(coreApi).schedule(updated);
  res.json(publicVc(updated));
}

/** DELETE /vcenters/:id — unregister (CASCADE clears inventory). */
function handleDeleteVcenter(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM vcenter_vcenters WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'vCenter not found.' });
  getPoller(coreApi).cancel(row.id);
  api.invalidateSession(row.id);
  db.prepare('DELETE FROM vcenter_vcenters WHERE id = ?').run(row.id);
  res.json({ deleted: true });
}

/** POST /vcenters/test — validate saved or candidate credentials. */
async function handlePostVcentersTest(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  if (!isNonEmptyString(b.host)) errors.push(fail('host'));
  if (!isNonEmptyString(b.username)) errors.push(fail('username'));
  if (b.password !== undefined && typeof b.password !== 'string') errors.push(fail('password'));
  if (b.id !== undefined && !Number.isInteger(parseIntStrict(b.id))) errors.push(fail('id'));
  if (b.sslVerify !== undefined && !isBooleanish(b.sslVerify)) errors.push(fail('sslVerify'));
  if (errors.length) return badRequest(res, errors);

  const { id, host, username, password, sslVerify } = b;
  let candidate = { host: host.trim(), username: username.trim(), password, ssl_verify: toBool(sslVerify) ? 1 : 0 };
  if (!password && id) {
    const row = coreApi.db.prepare('SELECT * FROM vcenter_vcenters WHERE id = ?').get(parseIntStrict(id));
    if (row) candidate = { ...row, host: candidate.host, username: candidate.username, ssl_verify: candidate.ssl_verify };
  }
  const result = await api.testConnection(candidate, coreApi);
  res.status(result.ok ? 200 : 502).json(result);
}

/** POST /vcenters/:id/refresh — poll this vCenter now. */
async function handlePostVcenterRefresh(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM vcenter_vcenters WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'vCenter not found.' });
  await getPoller(coreApi).trigger(row);
  res.json(publicVc(db.prepare('SELECT * FROM vcenter_vcenters WHERE id = ?').get(row.id)));
}

// ── Data endpoints ───────────────────────────────────────────────────────────

const dsUsedPct = (d) => (d.capacity_bytes > 0 ? (1 - d.free_bytes / d.capacity_bytes) * 100 : null);

// VMware Tools upgrade-needed statuses (guest.toolsVersionStatus2 values).
const TOOLS_OUTDATED = ['guestToolsNeedUpgrade', 'guestToolsTooOld', 'guestToolsBlacklisted', 'guestToolsSupportedOld'];
const toolsOutdatedIn = `tools_version_status IN (${TOOLS_OUTDATED.map(() => '?').join(', ')})`;

/** GET /issues — computed issues alone (Alerts page). */
function handleGetIssues(req, res, coreApi) {
  res.json(computeIssues(coreApi));
}

/** GET /overview — fleet rollup + computed issues. */
function handleGetOverview(req, res, coreApi) {
  const db = coreApi.db;
  const vcs = db.prepare('SELECT * FROM vcenter_vcenters ORDER BY name').all();
  const hostAgg = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN connection_state = 'CONNECTED' THEN 1 ELSE 0 END) AS connected,
      SUM(CASE WHEN in_maintenance = 1 THEN 1 ELSE 0 END) AS maintenance,
      SUM(COALESCE(vm_count, 0)) AS vms,
      SUM(cpu_cores) AS cpu_cores,
      SUM(mem_bytes_capacity) AS mem_bytes_total
    FROM vcenter_hosts
  `).get();
  const dsAgg = db.prepare(`
    SELECT COUNT(*) AS total, SUM(capacity_bytes) AS capacity, SUM(free_bytes) AS free
    FROM vcenter_datastores
  `).get();
  // Overcommit convention: allocations count powered-on VMs only.
  const vmAgg = db.prepare(`
    SELECT
      SUM(CASE WHEN power_state = 'POWERED_ON' THEN 1 ELSE 0 END) AS powered_on,
      SUM(CASE WHEN power_state = 'POWERED_OFF' THEN 1 ELSE 0 END) AS powered_off,
      SUM(CASE WHEN power_state = 'SUSPENDED' THEN 1 ELSE 0 END) AS suspended,
      SUM(CASE WHEN power_state = 'POWERED_ON' THEN COALESCE(cpu_count, 0) ELSE 0 END) AS vcpus_on,
      SUM(CASE WHEN power_state = 'POWERED_ON' THEN COALESCE(memory_mb, 0) ELSE 0 END) AS mem_mb_on
    FROM vcenter_vms
  `).get();
  const orphanAgg = db.prepare(
    'SELECT COUNT(*) AS count, SUM(size_bytes) AS bytes FROM vcenter_orphaned_vmdks'
  ).get();
  const toolsOutdated = db.prepare(
    `SELECT COUNT(*) AS n FROM vcenter_vms WHERE ${toolsOutdatedIn}`
  ).get(...TOOLS_OUTDATED).n;
  res.json({
    vcenters: vcs.map(publicVc),
    hosts: hostAgg,
    datastores: dsAgg,
    clusterCount: db.prepare('SELECT COUNT(*) AS n FROM vcenter_clusters').get().n,
    vmCount: db.prepare('SELECT COUNT(*) AS n FROM vcenter_vms').get().n,
    vmStats: { ...vmAgg, tools_outdated: toolsOutdated },
    capacity: {
      cpu_cores: hostAgg.cpu_cores,
      vcpus_allocated: vmAgg.vcpus_on,
      cpu_overcommit: hostAgg.cpu_cores > 0 ? vmAgg.vcpus_on / hostAgg.cpu_cores : null,
      mem_bytes_total: hostAgg.mem_bytes_total,
      vm_mem_bytes_allocated: (vmAgg.mem_mb_on || 0) * 1024 * 1024,
      mem_overcommit: hostAgg.mem_bytes_total > 0
        ? ((vmAgg.mem_mb_on || 0) * 1024 * 1024) / hostAgg.mem_bytes_total : null,
    },
    orphans: orphanAgg,
    density: db.prepare(`
      SELECT h.name, h.cluster_name, h.vm_count, v.name AS vcenter_name
      FROM vcenter_hosts h JOIN vcenter_vcenters v ON v.id = h.vcenter_id
      WHERE h.vm_count IS NOT NULL ORDER BY h.vm_count DESC
    `).all(),
    osBreakdown: db.prepare(`
      SELECT COALESCE(guest_os, 'Unknown') AS guest_os, COUNT(*) AS count
      FROM vcenter_vms GROUP BY COALESCE(guest_os, 'Unknown') ORDER BY count DESC
    `).all(),
    issues: computeIssues(coreApi),
    thresholds: { dsUsedWarnPct: DS_USED_WARN_PCT, clusterFreeWarnPct: CLUSTER_FREE_WARN_PCT, certWarnDays: certWarnDays(coreApi) },
  });
}

/** GET /events?days= — native vSphere events (poll-collected). */
function handleGetEvents(req, res, coreApi) {
  const daysQ = parseQueryInt(req.query.days, 1, 30);
  if (!daysQ.ok) return badRequest(res, [fail('days')]);
  const days = daysQ.value === undefined ? 7 : daysQ.value;
  res.json(coreApi.db.prepare(`
    SELECT e.*, v.name AS vcenter_name FROM vcenter_events e
    JOIN vcenter_vcenters v ON v.id = e.vcenter_id
    WHERE e.created_at >= datetime('now', ?)
    ORDER BY e.created_at DESC LIMIT 5000
  `).all(`-${days} days`));
}

/** GET /issue-history?days= — detected-issue lifecycle (open first). */
function handleGetIssueHistory(req, res, coreApi) {
  const daysQ = parseQueryInt(req.query.days, 1, 90);
  if (!daysQ.ok) return badRequest(res, [fail('days')]);
  const days = daysQ.value === undefined ? 30 : daysQ.value;
  res.json(coreApi.db.prepare(`
    SELECT * FROM vcenter_issue_history
    WHERE status = 'open' OR last_seen >= datetime('now', ?)
    ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, last_seen DESC
  `).all(`-${days} days`));
}

/** GET /config — platform-level settings (alert thresholds). */
function handleGetConfig(req, res, coreApi) {
  res.json({ certWarnDays: certWarnDays(coreApi) });
}

/** PUT /config — save alert thresholds. */
function handlePutConfig(req, res, coreApi) {
  const b = req.body || {};
  const n = parseIntStrict(b.certWarnDays);
  if (!Number.isInteger(n) || n < 1 || n > 365) return badRequest(res, [fail('certWarnDays')]);
  coreApi.settings.setSetting('vcenter_cert_warn_days', String(n));
  res.json({ saved: true, certWarnDays: certWarnDays(coreApi) });
}

/** GET /network — physical + logical networking inventory. */
function handleGetNetwork(req, res, coreApi) {
  const db = coreApi.db;
  const rows = db.prepare(`
    SELECT n.*, v.name AS vcenter_name FROM vcenter_networks n
    JOIN vcenter_vcenters v ON v.id = n.vcenter_id ORDER BY v.name, n.host_name, n.name
  `).all().map((r) => ({
    ...r,
    uplinks: r.uplinks ? JSON.parse(r.uplinks) : null,
    extra: r.extra ? JSON.parse(r.extra) : null,
  }));
  // VMs attached per network name (per vCenter), from the VM json arrays.
  const vmCounts = new Map();
  for (const r of db.prepare(`
    SELECT m.vcenter_id, je.value AS name, COUNT(*) AS n
    FROM vcenter_vms m, json_each(COALESCE(m.networks, '[]')) je
    GROUP BY m.vcenter_id, je.value
  `).all()) vmCounts.set(`${r.vcenter_id}|${r.name}`, r.n);
  const withVmCount = (r) => ({ ...r, vm_count: vmCounts.get(`${r.vcenter_id}|${r.name}`) ?? 0 });
  const byKind = (kind) => rows.filter((r) => r.kind === kind);
  res.json({
    pnics: byKind('pnic'),
    vswitches: byKind('vswitch'),
    portgroups: byKind('portgroup').map(withVmCount),
    vmkernels: byKind('vmkernel'),
    dvswitches: byKind('dvswitch'),
    dvportgroups: byKind('dvportgroup').map(withVmCount),
  });
}

// Host config fields compared for drift; NTP/DNS lists compare order-insensitively.
const DRIFT_FIELDS = [
  { key: 'esx_build', label: 'ESX build', value: (h) => (h.esx_build != null ? `${h.esx_version || ''} (${h.esx_build})` : null) },
  { key: 'bios_version', label: 'BIOS version', value: (h) => h.bios_version },
  { key: 'ntp_servers', label: 'NTP servers', value: (h) => sortedList(h.ntp_servers) },
  { key: 'dns_servers', label: 'DNS servers', value: (h) => sortedList(h.dns_servers) },
  { key: 'ssh_enabled', label: 'SSH service', value: (h) => (h.ssh_enabled == null ? null : (h.ssh_enabled ? 'enabled' : 'disabled')) },
];

function sortedList(json) {
  if (!json) return null;
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) && arr.length ? [...arr].sort().join(', ') : null;
  } catch { return null; }
}

/**
 * Configuration drift: within each cluster (2+ hosts), the majority value per
 * field is the baseline; hosts that deviate are drift items. Fields without
 * SOAP data (all NULL) are skipped rather than reported.
 */
function computeDrift(coreApi) {
  const hosts = coreApi.db.prepare(`
    SELECT h.*, v.name AS vcenter_name FROM vcenter_hosts h
    JOIN vcenter_vcenters v ON v.id = h.vcenter_id
    WHERE h.cluster_name IS NOT NULL
  `).all();
  const byCluster = new Map();
  for (const h of hosts) {
    const key = `${h.vcenter_id}|${h.cluster_name}`;
    if (!byCluster.has(key)) byCluster.set(key, []);
    byCluster.get(key).push(h);
  }
  const drift = [];
  for (const members of byCluster.values()) {
    if (members.length < 2) continue;
    for (const field of DRIFT_FIELDS) {
      const values = members.map((h) => ({ host: h, value: field.value(h) })).filter((x) => x.value != null);
      if (values.length < 2) continue;
      const counts = new Map();
      for (const x of values) counts.set(x.value, (counts.get(x.value) || 0) + 1);
      if (counts.size < 2) continue;
      const [expected, expectedCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      for (const x of values) {
        if (x.value === expected) continue;
        drift.push({
          vcenter: x.host.vcenter_name, cluster: x.host.cluster_name, host: x.host.name,
          field: field.label, value: x.value, expected,
          baseline_hosts: expectedCount, cluster_hosts: members.length,
        });
      }
    }
  }
  return drift;
}

/** GET /governance — config drift, outdated VMware Tools, orphaned VMDKs. */
function handleGetGovernance(req, res, coreApi) {
  const db = coreApi.db;
  const outdatedTools = db.prepare(`
    SELECT m.name, m.host_name, m.cluster_name, m.power_state, m.guest_os,
           m.tools_version, m.tools_version_status, v.name AS vcenter_name
    FROM vcenter_vms m JOIN vcenter_vcenters v ON v.id = m.vcenter_id
    WHERE ${toolsOutdatedIn} ORDER BY v.name, m.name
  `).all(...TOOLS_OUTDATED);
  const orphans = db.prepare(`
    SELECT o.*, v.name AS vcenter_name FROM vcenter_orphaned_vmdks o
    JOIN vcenter_vcenters v ON v.id = o.vcenter_id ORDER BY o.size_bytes DESC
  `).all();
  res.json({
    drift: computeDrift(coreApi),
    outdatedTools,
    orphans,
    orphanBytes: orphans.reduce((n, o) => n + (o.size_bytes || 0), 0),
    // SOAP-sourced fields all NULL means the data isn't available (yet).
    driftDataAvailable: db.prepare(
      'SELECT COUNT(*) AS n FROM vcenter_hosts WHERE ntp_servers IS NOT NULL OR esx_build IS NOT NULL'
    ).get().n > 0,
  });
}

// CPU % = quickstats MHz over the VM's share of host cores; memory % is
// guest usage over configured size. Null when SOAP quickstats are absent.
function withVmPerfPct(r) {
  const perCore = r.host_cpu_mhz_capacity && r.host_cpu_cores ? r.host_cpu_mhz_capacity / r.host_cpu_cores : null;
  const cpuCapacity = perCore && r.cpu_count ? perCore * r.cpu_count : null;
  return {
    ...r,
    cpu_pct: r.cpu_usage_mhz != null && cpuCapacity ? Math.round((r.cpu_usage_mhz / cpuCapacity) * 1000) / 10 : null,
    mem_pct: r.mem_usage_mb != null && r.memory_mb ? Math.round((r.mem_usage_mb / r.memory_mb) * 1000) / 10 : null,
  };
}

const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

/**
 * GET /vms — VM guest inventory across all vCenters.
 * Optional ?network= / ?datastore= (+ ?vcenterId=) filter by membership in the
 * JSON name arrays — used by the portgroup/datastore drill-down modals.
 */
function handleGetVms(req, res, coreApi) {
  const clauses = [];
  const params = [];
  if (req.query.network) {
    clauses.push("EXISTS (SELECT 1 FROM json_each(COALESCE(m.networks, '[]')) je WHERE je.value = ?)");
    params.push(String(req.query.network));
  }
  if (req.query.datastore) {
    clauses.push("EXISTS (SELECT 1 FROM json_each(COALESCE(m.datastores, '[]')) jd WHERE jd.value = ?)");
    params.push(String(req.query.datastore));
  }
  if (req.query.vcenterId) {
    const vcenterIdQ = parseQueryInt(req.query.vcenterId);
    if (!vcenterIdQ.ok) return badRequest(res, [fail('vcenterId')]);
    clauses.push('m.vcenter_id = ?');
    params.push(vcenterIdQ.value);
  }
  const rows = coreApi.db.prepare(`
    SELECT m.*, v.name AS vcenter_name,
           h.cpu_mhz_capacity AS host_cpu_mhz_capacity, h.cpu_cores AS host_cpu_cores
    FROM vcenter_vms m
    JOIN vcenter_vcenters v ON v.id = m.vcenter_id
    LEFT JOIN vcenter_hosts h ON h.vcenter_id = m.vcenter_id AND h.name = m.host_name
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY v.name, m.name
  `).all(...params);
  res.json(rows.map(withVmPerfPct));
}

/** GET /vms/:id — full detail for one VM + its recent events. */
function handleGetVmById(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const vm = db.prepare(`
    SELECT m.*, v.name AS vcenter_name FROM vcenter_vms m
    JOIN vcenter_vcenters v ON v.id = m.vcenter_id WHERE m.id = ?
  `).get(id);
  if (!vm) return res.status(404).json({ error: 'VM not found.' });
  res.json({
    ...vm,
    networks: parseJson(vm.networks) || [],
    datastores: parseJson(vm.datastores) || [],
    tags: parseJson(vm.tags) || [],
    guest_nics: parseJson(vm.guest_nics) || [],
    events: db.prepare(`
      SELECT * FROM vcenter_events
      WHERE vcenter_id = ? AND entity_name = ?
      ORDER BY created_at DESC LIMIT 50
    `).all(vm.vcenter_id, vm.name),
  });
}

/** GET /hosts — ESX hosts across all vCenters. */
function handleGetHosts(req, res, coreApi) {
  res.json(coreApi.db.prepare(`
    SELECT h.*, v.name AS vcenter_name FROM vcenter_hosts h
    JOIN vcenter_vcenters v ON v.id = h.vcenter_id ORDER BY v.name, h.name
  `).all());
}

/** GET /clusters — clusters with capacity rollups. */
function handleGetClusters(req, res, coreApi) {
  res.json(coreApi.db.prepare(`
    SELECT c.*, v.name AS vcenter_name FROM vcenter_clusters c
    JOIN vcenter_vcenters v ON v.id = c.vcenter_id ORDER BY v.name, c.name
  `).all());
}

/** GET /datastores — datastores with usage + attached-VM counts. */
function handleGetDatastores(req, res, coreApi) {
  const db = coreApi.db;
  const vmCounts = new Map();
  for (const r of db.prepare(`
    SELECT m.vcenter_id, jd.value AS name, COUNT(*) AS n
    FROM vcenter_vms m, json_each(COALESCE(m.datastores, '[]')) jd
    GROUP BY m.vcenter_id, jd.value
  `).all()) vmCounts.set(`${r.vcenter_id}|${r.name}`, r.n);
  res.json(db.prepare(`
    SELECT d.*, v.name AS vcenter_name FROM vcenter_datastores d
    JOIN vcenter_vcenters v ON v.id = d.vcenter_id ORDER BY v.name, d.name
  `).all().map((d) => ({
    ...d, used_pct: dsUsedPct(d),
    vm_count: vmCounts.get(`${d.vcenter_id}|${d.name}`) ?? 0,
  })));
}

/** GET /certs — collected certificates. */
function handleGetCerts(req, res, coreApi) {
  res.json(coreApi.db.prepare(`
    SELECT c.*, v.name AS vcenter_name FROM vcenter_certs c
    JOIN vcenter_vcenters v ON v.id = c.vcenter_id ORDER BY v.name
  `).all());
}

/** GET /trends — per-vCenter snapshot series (30d default). */
function handleGetTrends(req, res, coreApi) {
  const daysQ = parseQueryInt(req.query.days, 1, 365);
  if (!daysQ.ok) return badRequest(res, [fail('days')]);
  const days = daysQ.value === undefined ? 30 : daysQ.value;
  res.json(coreApi.db.prepare(`
    SELECT m.*, v.name AS vcenter_name FROM vcenter_metrics_history m
    JOIN vcenter_vcenters v ON v.id = m.vcenter_id
    WHERE m.captured_at >= datetime('now', ?)
    ORDER BY m.captured_at
  `).all(`-${days} days`));
}

// ── AI Advisor ───────────────────────────────────────────────────────────────

let advisorInstance = null;
function getAdvisor(coreApi) {
  if (!advisorInstance) advisorInstance = createVcenterAdvisor(coreApi);
  return advisorInstance;
}

function advisorReportKey(slug) {
  return String(slug).replace(/-/g, '_');
}

/** GET /advisor/:report — cached vCenter AI Advisor report. */
function handleGetAdvisorReport(req, res, coreApi) {
  if (!isNonEmptyString(req.params.report)) return badRequest(res, [fail('report')]);
  const advisor = getAdvisor(coreApi);
  const key = advisorReportKey(req.params.report);
  if (!advisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
  res.json({ enabled: advisor.isConfigured(), report: advisor.getCachedReport(key) });
}

/** POST /advisor/:report — (re)generate and cache a vCenter AI Advisor report. */
async function handlePostAdvisorReport(req, res, coreApi) {
  if (!isNonEmptyString(req.params.report)) return badRequest(res, [fail('report')]);
  const advisor = getAdvisor(coreApi);
  const key = advisorReportKey(req.params.report);
  if (!advisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
  try {
    const result = await advisor.generateReport(key);
    res.json(result);
  } catch (err) {
    if (err.code === 'LLM_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'AI analysis is not configured. Add an OpenAI or GitHub Models token under Settings → Credentials.' });
    }
    if (err.code === 'LLM_RATE_LIMITED') {
      if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
      return res.status(429).json({ error: err.message, retryAfter: err.retryAfter });
    }
    if (err.code === 'LLM_REQUEST_FAILED' || err.code === 'LLM_EMPTY') {
      return res.status(502).json({ error: err.message });
    }
    throw err;
  }
}

// ── site capacity (ported from backend/routes/vcenter.js /capacity/*) ───────

const siteRow = (db, id) => db.prepare('SELECT id, name, color, sort_order AS sortOrder FROM vcenter_sites WHERE id = ?').get(id);

function apiCluster(c) {
  const u = n1Usable(c);
  return {
    vcenterId: c.vcenterId, vcenterName: c.vcenterName, name: c.name,
    hostCount: c.hostCount, hostsConnected: c.hostsConnected, vmCount: c.vmCount, vmsOn: c.vmsOn,
    cpu: { cores: c.cpuCores, mhzCapacity: c.cpuMhzCapacity, mhzUsed: c.cpuMhzUsed, vcpuAllocated: c.vcpuAllocated, usableMhz: u.cpuMhz, usableCores: u.cpuCores },
    mem: { bytesCapacity: c.memBytesCapacity, bytesUsed: c.memBytesUsed, mbAllocated: c.vmemMbAllocated, usableBytes: u.memBytes },
    largestHost: { cpuMhz: c.largestHostCpuMhz, memBytes: c.largestHostMemBytes, cpuCores: c.largestHostCpuCores },
  };
}

function apiTotals(r) {
  const pctOf = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
  return {
    hostCount: r.hostCount, hostsConnected: r.hostsConnected, vmCount: r.vmCount, vmsOn: r.vmsOn,
    cpu: {
      cores: r.cpuCores, mhzCapacity: r.cpuMhzCapacity, mhzUsed: r.cpuMhzUsed, vcpuAllocated: r.vcpuAllocated,
      usableMhz: r.usableCpuMhz, usableCores: r.usableCpuCores,
      usedPct: pctOf(r.cpuMhzUsed, r.usableCpuMhz), allocPct: pctOf(r.vcpuAllocated, r.usableCpuCores),
    },
    mem: {
      bytesCapacity: r.memBytesCapacity, bytesUsed: r.memBytesUsed, mbAllocated: r.vmemMbAllocated, usableBytes: r.usableMemBytes,
      usedPct: pctOf(r.memBytesUsed, r.usableMemBytes), allocPct: pctOf(r.vmemMbAllocated * 1024 * 1024, r.usableMemBytes),
    },
  };
}


/** GET /capacity/sites — sites, members, unmapped clusters only. */
function handleGetCapacitySites(req, res, coreApi) {
  const db = coreApi.db;
  const sites = db.prepare('SELECT id, name, color, sort_order AS sortOrder FROM vcenter_sites ORDER BY sort_order, name').all();
  const members = db.prepare(`
    SELECT m.id, m.site_id AS siteId, m.vcenter_id AS vcenterId, v.name AS vcenterName,
      m.member_type AS memberType, m.member_name AS memberName
    FROM vcenter_site_members m JOIN vcenter_vcenters v ON v.id = m.vcenter_id
    ORDER BY v.name, m.member_name
  `).all();
  const mapped = new Set(members.map((m) => `${m.memberType}|${m.vcenterId}|${m.memberName}`));
  const siteOf = new Map(members.filter((m) => m.memberType === 'cluster').map((m) => [`${m.vcenterId}|${m.memberName}`, m.siteId]));
  // Every cluster with its current site (null = unmapped) — what the Settings assignment table renders.
  const clusters = db.prepare(`
    SELECT c.vcenter_id AS vcenterId, v.name AS vcenterName, c.name, c.host_count AS hostCount, c.vm_count AS vmCount
    FROM vcenter_clusters c JOIN vcenter_vcenters v ON v.id = c.vcenter_id ORDER BY v.name, c.name
  `).all().map((c) => ({ ...c, siteId: siteOf.get(`${c.vcenterId}|${c.name}`) ?? null }));
  const unmapped = {
    clusters: db.prepare(`
      SELECT c.vcenter_id AS vcenterId, v.name AS vcenterName, c.name, c.host_count AS hostCount, c.vm_count AS vmCount
      FROM vcenter_clusters c JOIN vcenter_vcenters v ON v.id = c.vcenter_id ORDER BY v.name, c.name
    `).all().filter((c) => !mapped.has(`cluster|${c.vcenterId}|${c.name}`)),
  };
  res.json({ sites, members, clusters, unmapped });
}

/** POST /capacity/sites — create site (409 on duplicate name). */
function handlePostCapacitySite(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  if (!isNonEmptyString(b.name, 120)) errors.push(fail('name'));
  if (b.color !== undefined && !(typeof b.color === 'string' && b.color.length <= 20)) errors.push(fail('color'));
  if (errors.length) return badRequest(res, errors);
  const db = coreApi.db;
  const name = b.name.trim();
  if (db.prepare('SELECT id FROM vcenter_sites WHERE name = ?').get(name)) {
    return res.status(409).json({ error: 'A site with that name already exists.' });
  }
  const info = db.prepare('INSERT INTO vcenter_sites (name, color) VALUES (?, ?)').run(name, b.color?.trim() || null);
  res.status(201).json(siteRow(db, info.lastInsertRowid));
}

/** POST /capacity/sites/auto — one site per unmapped cluster, named after the cluster. */
function handlePostCapacitySitesAuto(req, res, coreApi) {
  res.json(autoCreateSites(coreApi.db));
}

/** PUT /capacity/sites/members — upsert a cluster membership; siteId null removes it. */
function handlePutCapacityMember(req, res, coreApi) {
  const b = req.body || {};
  const errors = [];
  const vcenterId = parseIntStrict(b.vcenterId);
  if (!Number.isInteger(vcenterId)) errors.push(fail('vcenterId'));
  if (b.memberType !== 'cluster') return badRequest(res, [fail('memberType')]);
  if (!isNonEmptyString(b.memberName)) errors.push(fail('memberName'));
  const siteId = b.siteId === null ? null : parseIntStrict(b.siteId);
  if (siteId !== null && !Number.isInteger(siteId)) errors.push(fail('siteId'));
  if (errors.length) return badRequest(res, errors);
  const db = coreApi.db;
  const memberName = b.memberName.trim();
  if (siteId === null) {
    db.prepare('DELETE FROM vcenter_site_members WHERE vcenter_id = ? AND member_type = ? AND member_name = ?').run(vcenterId, 'cluster', memberName);
    return res.json({ removed: true });
  }
  if (!db.prepare('SELECT id FROM vcenter_sites WHERE id = ?').get(siteId)) return res.status(404).json({ error: 'Site not found.' });
  db.prepare(`
    INSERT OR REPLACE INTO vcenter_site_members (site_id, vcenter_id, member_type, member_name, replicated)
    VALUES (?, ?, ?, ?, ?)
  `).run(siteId, vcenterId, 'cluster', memberName, 0);
  res.json(db.prepare(`
    SELECT id, site_id AS siteId, vcenter_id AS vcenterId, member_type AS memberType, member_name AS memberName
    FROM vcenter_site_members WHERE vcenter_id = ? AND member_type = ? AND member_name = ?
  `).get(vcenterId, 'cluster', memberName));
}

/** PUT /capacity/sites/:id — rename / recolour / reorder. */
function handlePutCapacitySite(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const b = req.body || {};
  const errors = [];
  if (b.name !== undefined && !isNonEmptyString(b.name, 120)) errors.push(fail('name'));
  if (b.color !== undefined && !(typeof b.color === 'string' && b.color.length <= 20)) errors.push(fail('color'));
  if (b.sortOrder !== undefined && !Number.isInteger(parseIntStrict(b.sortOrder))) errors.push(fail('sortOrder'));
  if (errors.length) return badRequest(res, errors);
  const db = coreApi.db;
  const row = db.prepare('SELECT * FROM vcenter_sites WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Site not found.' });
  const newName = b.name?.trim() || row.name;
  if (newName !== row.name && db.prepare('SELECT id FROM vcenter_sites WHERE name = ?').get(newName)) {
    return res.status(409).json({ error: 'A site with that name already exists.' });
  }
  db.prepare('UPDATE vcenter_sites SET name = ?, color = ?, sort_order = ? WHERE id = ?')
    .run(newName, b.color !== undefined ? b.color.trim() : row.color, b.sortOrder !== undefined ? parseIntStrict(b.sortOrder) : row.sort_order, id);
  res.json(siteRow(db, id));
}

/** DELETE /capacity/sites/:id — members cascade. */
function handleDeleteCapacitySite(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  if (!db.prepare('SELECT id FROM vcenter_sites WHERE id = ?').get(id)) return res.status(404).json({ error: 'Site not found.' });
  db.prepare('DELETE FROM vcenter_sites WHERE id = ?').run(id);
  res.json({ deleted: true });
}

/** GET /capacity/pairs — configured failover pairs. */
function handleGetCapacityPairs(req, res, coreApi) {
  res.json(coreApi.db.prepare(`
    SELECT p.id, p.site_a_id AS siteAId, a.name AS siteAName, p.site_b_id AS siteBId, b.name AS siteBName
    FROM vcenter_site_pairs p JOIN vcenter_sites a ON a.id = p.site_a_id JOIN vcenter_sites b ON b.id = p.site_b_id
    ORDER BY a.name, b.name
  `).all());
}

/** POST /capacity/pairs { siteAId, siteBId } — 409 if already paired (either order). */
function handlePostCapacityPair(req, res, coreApi) {
  const b = req.body || {};
  const siteAId = parseIntStrict(b.siteAId);
  const siteBId = parseIntStrict(b.siteBId);
  const errors = [];
  if (!Number.isInteger(siteAId)) errors.push(fail('siteAId'));
  if (!Number.isInteger(siteBId)) errors.push(fail('siteBId'));
  if (errors.length) return badRequest(res, errors);
  if (siteAId === siteBId) return res.status(400).json({ error: 'Pick two different sites.' });
  const db = coreApi.db;
  if (db.prepare('SELECT COUNT(*) AS n FROM vcenter_sites WHERE id IN (?, ?)').get(siteAId, siteBId).n !== 2) return res.status(404).json({ error: 'Site not found.' });
  const dup = db.prepare('SELECT id FROM vcenter_site_pairs WHERE (site_a_id = ? AND site_b_id = ?) OR (site_a_id = ? AND site_b_id = ?)').get(siteAId, siteBId, siteBId, siteAId);
  if (dup) return res.status(409).json({ error: 'Those sites are already paired.' });
  const info = db.prepare('INSERT INTO vcenter_site_pairs (site_a_id, site_b_id) VALUES (?, ?)').run(siteAId, siteBId);
  res.status(201).json({ id: info.lastInsertRowid, siteAId, siteBId });
}

/** DELETE /capacity/pairs/:id */
function handleDeleteCapacityPair(req, res, coreApi) {
  const id = requireIdParam(req, res);
  if (id === null) return;
  const info = coreApi.db.prepare('DELETE FROM vcenter_site_pairs WHERE id = ?').run(id);
  if (!info.changes) return res.status(404).json({ error: 'Pair not found.' });
  res.json({ deleted: true });
}

/** GET /capacity/overview — current per-site capacity + failover matrix (snapshot tables). */
function handleGetCapacityOverview(req, res, coreApi) {
  const db = coreApi.db;
  const sites = db.prepare('SELECT id, name, color FROM vcenter_sites ORDER BY sort_order, name').all();
  const { clusters: clusterMap } = siteMap(db);
  const all = clusterStats(db);
  const rollups = [];
  const out = sites.map((site) => {
    const mine = all.filter((c) => clusterMap.get(`${c.vcenterId}|${c.name}`) === site.id);
    const r = rollupSite(mine);
    rollups.push({ ...r, id: site.id, name: site.name, color: site.color });
    return { id: site.id, name: site.name, color: site.color, clusters: mine.map(apiCluster), totals: apiTotals(r) };
  });
  res.json({
    sites: out,
    failover: failoverMatrix(rollups),
    pairs: db.prepare('SELECT id, site_a_id AS a, site_b_id AS b FROM vcenter_site_pairs').all().map((p) => {
      const a = rollups.find((r) => r.id === p.a);
      const b = rollups.find((r) => r.id === p.b);
      if (!a || !b) return null;
      return { id: p.id, a: { id: a.id, name: a.name, color: a.color }, b: { id: b.id, name: b.name, color: b.color }, ...pairSummary(a, b) };
    }).filter(Boolean),
    unmappedClusterCount: all.filter((c) => !clusterMap.has(`${c.vcenterId}|${c.name}`)).length,
    lastSampleAt: db.prepare('SELECT MAX(captured_at) AS t FROM vcenter_capacity_history').get().t,
    sampleCount: db.prepare('SELECT COUNT(DISTINCT substr(captured_at, 1, 13)) AS n FROM vcenter_capacity_history').get().n,
  });
}

/** GET /capacity/trends?days&siteId|cluster=vcId|name — bucketed history + growth. */
function handleGetCapacityTrends(req, res, coreApi) {
  const q = req.query || {};
  const days = parseQueryInt(q.days, 1, 365);
  const siteId = parseQueryInt(q.siteId);
  if (!days.ok) return badRequest(res, [fail('days')]);
  if (!siteId.ok) return badRequest(res, [fail('siteId')]);
  const win = days.value || 30;
  let where = '';
  const args = [`-${win} days`];
  if (q.cluster) {
    const [vcId, ...rest] = String(q.cluster).split('|');
    where = 'AND vcenter_id = ? AND cluster_name = ?';
    args.push(Number(vcId), rest.join('|'));
  } else if (siteId.value !== undefined) {
    where = `AND EXISTS (SELECT 1 FROM vcenter_site_members m WHERE m.site_id = ? AND m.member_type = 'cluster'
      AND m.vcenter_id = vcenter_capacity_history.vcenter_id AND m.member_name = vcenter_capacity_history.cluster_name)`;
    args.push(siteId.value);
  }
  const rows = coreApi.db.prepare(`
    SELECT * FROM vcenter_capacity_history WHERE captured_at >= datetime('now', ?) ${where} ORDER BY captured_at
  `).all(...args);
  const points = bucketHistory(rows, win <= 7);
  const mem = growthOf(points, 'memBytesUsedAvg', 'usableMemBytes');
  const cpu = growthOf(points, 'cpuMhzUsedAvg', 'usableCpuMhz');
  res.json({ points, growth: { memBytesPerDay: mem.perDay, cpuMhzPerDay: cpu.perDay, monthsUntilMemFull: mem.months, monthsUntilCpuFull: cpu.months } });
}

/** GET /capacity/vm-trends?vcenterId&vm&days — raw hourly history for one VM. */
function handleGetCapacityVmTrends(req, res, coreApi) {
  const q = req.query || {};
  const vcenterId = parseIntStrict(q.vcenterId);
  const days = parseQueryInt(q.days, 1, 365);
  const errors = [];
  if (!Number.isInteger(vcenterId)) errors.push(fail('vcenterId'));
  if (!isNonEmptyString(q.vm)) errors.push(fail('vm'));
  if (!days.ok) errors.push(fail('days'));
  if (errors.length) return badRequest(res, errors);
  const points = coreApi.db.prepare(`
    SELECT captured_at AS t, cpu_usage_mhz AS cpuUsageMhz, mem_usage_mb AS memUsageMb,
      storage_committed_bytes AS storageCommittedBytes, power_state AS powerState
    FROM vcenter_vm_capacity_history
    WHERE vcenter_id = ? AND vm_name = ? AND captured_at >= datetime('now', ?)
    ORDER BY captured_at LIMIT 2200
  `).all(vcenterId, q.vm.trim(), `-${days.value || 30} days`);
  res.json({ points });
}

/** GET /capacity/explorer — per-site usable/used + every VM with its demand. */
function handleGetCapacityExplorer(req, res, coreApi) {
  const db = coreApi.db;
  const { clusters: clusterMap } = siteMap(db);
  const all = clusterStats(db);
  const sites = db.prepare('SELECT id, name, color FROM vcenter_sites ORDER BY sort_order, name').all().map((site) => {
    const r = rollupSite(all.filter((c) => clusterMap.get(`${c.vcenterId}|${c.name}`) === site.id));
    return {
      id: site.id, name: site.name, color: site.color,
      cpu: { usableMhz: r.usableCpuMhz, usableCores: r.usableCpuCores, mhzUsed: r.cpuMhzUsed, vcpuAllocated: r.vcpuAllocated },
      mem: { usableBytes: r.usableMemBytes, bytesUsed: r.memBytesUsed, mbAllocated: r.vmemMbAllocated },
    };
  });
  const vms = db.prepare(`
    SELECT v.id, v.vcenter_id AS vcenterId, vc.name AS vcenterName, v.name, v.cluster_name AS cluster,
      v.power_state AS powerState, v.cpu_count AS cpuCount, v.memory_mb AS memoryMb,
      v.cpu_usage_mhz AS cpuUsageMhz, v.mem_usage_mb AS memUsageMb, v.storage_committed_bytes AS storageCommittedBytes,
      v.datastores, v.tags
    FROM vcenter_vms v JOIN vcenter_vcenters vc ON vc.id = v.vcenter_id
    ORDER BY vc.name, v.name
  `).all().map((v) => {
    let tags = [];
    try { tags = JSON.parse(v.tags || '[]'); } catch { /* keep [] */ }
    const { datastores: _d, ...rest } = v;
    return { ...rest, siteId: clusterMap.get(`${v.vcenterId}|${v.cluster}`) ?? null, tags };
  });
  res.json({ sites, vms });
}

/** POST /capacity/sample { refresh } — force an hourly sample now (optionally re-poll first; never on a demo). */
async function handlePostCapacitySample(req, res, coreApi) {
  const b = req.body || {};
  if (b.refresh !== undefined && !isBooleanish(b.refresh)) return badRequest(res, [fail('refresh')]);
  const db = coreApi.db;
  const vcs = db.prepare('SELECT * FROM vcenter_vcenters').all();
  if (toBool(b.refresh) && process.env.DASHBOARD_DEMO !== '1') {
    const poller = getPoller(coreApi);
    for (const vc of vcs) {
      try { await poller.trigger(vc); } catch { /* tolerate unreachable vCenters */ }
    }
  }
  let sampled = 0;
  for (const vc of vcs) if (writeCapacitySample(db, vc.id, { force: true }).sampled) sampled += 1;
  res.json({ vcenters: vcs.length, sampled });
}

// ── route table ──────────────────────────────────────────────────────────────

const ROUTES = [
  { method: 'GET', ...compile('/vcenters'), handler: handleGetVcenters },
  { method: 'POST', ...compile('/vcenters'), handler: handlePostVcenters },
  { method: 'PUT', ...compile('/vcenters/:id'), handler: handlePutVcenter },
  { method: 'DELETE', ...compile('/vcenters/:id'), handler: handleDeleteVcenter },
  { method: 'POST', ...compile('/vcenters/test'), handler: handlePostVcentersTest },
  { method: 'POST', ...compile('/vcenters/:id/refresh'), handler: handlePostVcenterRefresh },
  { method: 'GET', ...compile('/issues'), handler: handleGetIssues },
  { method: 'GET', ...compile('/overview'), handler: handleGetOverview },
  { method: 'GET', ...compile('/events'), handler: handleGetEvents },
  { method: 'GET', ...compile('/issue-history'), handler: handleGetIssueHistory },
  { method: 'GET', ...compile('/config'), handler: handleGetConfig },
  { method: 'PUT', ...compile('/config'), handler: handlePutConfig },
  { method: 'GET', ...compile('/network'), handler: handleGetNetwork },
  { method: 'GET', ...compile('/governance'), handler: handleGetGovernance },
  { method: 'GET', ...compile('/vms'), handler: handleGetVms },
  { method: 'GET', ...compile('/vms/:id'), handler: handleGetVmById },
  { method: 'GET', ...compile('/hosts'), handler: handleGetHosts },
  { method: 'GET', ...compile('/clusters'), handler: handleGetClusters },
  { method: 'GET', ...compile('/datastores'), handler: handleGetDatastores },
  { method: 'GET', ...compile('/certs'), handler: handleGetCerts },
  { method: 'GET', ...compile('/trends'), handler: handleGetTrends },
  { method: 'GET', ...compile('/capacity/sites'), handler: handleGetCapacitySites },
  { method: 'POST', ...compile('/capacity/sites'), handler: handlePostCapacitySite },
  // literal path MUST precede the :id sibling — the table is first-match.
  { method: 'POST', ...compile('/capacity/sites/auto'), handler: handlePostCapacitySitesAuto },
  { method: 'PUT', ...compile('/capacity/sites/members'), handler: handlePutCapacityMember },
  { method: 'PUT', ...compile('/capacity/sites/:id'), handler: handlePutCapacitySite },
  { method: 'DELETE', ...compile('/capacity/sites/:id'), handler: handleDeleteCapacitySite },
  { method: 'GET', ...compile('/capacity/pairs'), handler: handleGetCapacityPairs },
  { method: 'POST', ...compile('/capacity/pairs'), handler: handlePostCapacityPair },
  { method: 'DELETE', ...compile('/capacity/pairs/:id'), handler: handleDeleteCapacityPair },
  { method: 'GET', ...compile('/capacity/overview'), handler: handleGetCapacityOverview },
  { method: 'GET', ...compile('/capacity/trends'), handler: handleGetCapacityTrends },
  { method: 'GET', ...compile('/capacity/vm-trends'), handler: handleGetCapacityVmTrends },
  { method: 'GET', ...compile('/capacity/explorer'), handler: handleGetCapacityExplorer },
  { method: 'POST', ...compile('/capacity/sample'), handler: handlePostCapacitySample },
  { method: 'GET', ...compile('/advisor/:report'), handler: handleGetAdvisorReport },
  { method: 'POST', ...compile('/advisor/:report'), handler: handlePostAdvisorReport },
];

// createRouter must return a BARE (req, res, next) function — installed
// plugins are loaded via require() on their own dist/backend/index.cjs and
// cannot require the host's copy of express, so express Router instances are
// off the table. Matches req.method + req.path by hand against the table
// above; req.query/req.body are still parsed by the host's express pipeline
// before this middleware runs.
function createRouter(coreApi) {
  return function vcenterRouter(req, res, next) {
    const path = req.path.length > 1 && req.path.endsWith('/') ? req.path.slice(0, -1) : req.path;
    for (const route of ROUTES) {
      if (route.method !== req.method) continue;
      const m = route.regex.exec(path);
      if (!m) continue;
      const params = {};
      route.names.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
      req.params = params;
      Promise.resolve(route.handler(req, res, coreApi)).catch(next);
      return;
    }
    next();
  };
}

module.exports = { createRouter };
