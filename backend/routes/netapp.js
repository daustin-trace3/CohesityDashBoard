const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const db = require('../db/database');
const { encrypt } = require('../services/encryption');
const netappApi = require('../services/netappApi');
const { syncAndPollAll, syncAndPollInstance, triggerPoll, reschedule, scheduleArray, cancelArray } = require('../services/netappPoller');
const cacheControl = require('../middleware/cache');
const netappAdvisor = require('../services/advisors/netappAdvisor');
const pollerStatus = require('../services/pollerStatus');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

// SSRF guard on the management host.
function isBlockedHost(host) {
  const h = String(host || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').split(':')[0];
  const blocked = [
    /^127\./, /^0\.0\.0\.0$/, /^169\.254\./, /^::1$/,
    /^localhost$/i, /^metadata\.google\.internal$/i, /^169\.254\.169\.254$/,
  ];
  return blocked.some((p) => p.test(h));
}

// Read-only view of a cluster (AIQUM-managed or direct). Credential values —
// including usernames — are never returned; presence only.
function publicCluster(row) {
  return {
    id: row.id,
    name: row.name,
    mgmt_host: row.mgmt_host,
    has_username: !!row.username,
    version: row.version,
    management_ip: row.management_ip,
    cluster_uuid: row.cluster_uuid,
    source: row.source,
    aiqum_instance_id: row.aiqum_instance_id ?? null,
    ssl_verify: row.ssl_verify,
    polling_interval_minutes: row.polling_interval_minutes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const directArrayValidators = [
  body('name').trim().notEmpty().withMessage('name is required').isLength({ max: 253 }),
  body('mgmt_host').trim().notEmpty().withMessage('mgmt_host is required')
    .custom((v) => !isBlockedHost(v)).withMessage('mgmt_host is not allowed'),
  body('username').trim().notEmpty().withMessage('username is required'),
  body('polling_interval_minutes').optional().isInt({ min: 5, max: 1440 })
    .withMessage('polling_interval_minutes must be 5-1440'),
  body('ssl_verify').optional().isBoolean().withMessage('ssl_verify must be boolean'),
];

// PUT variant: username is write-only in the UI, so edits may omit it (blank
// keeps the stored value, same as password).
const directArrayUpdateValidators = [
  body('name').trim().notEmpty().withMessage('name is required').isLength({ max: 253 }),
  body('mgmt_host').trim().notEmpty().withMessage('mgmt_host is required')
    .custom((v) => !isBlockedHost(v)).withMessage('mgmt_host is not allowed'),
  body('username').optional({ nullable: true }).trim(),
  body('polling_interval_minutes').optional().isInt({ min: 5, max: 1440 })
    .withMessage('polling_interval_minutes must be 5-1440'),
  body('ssl_verify').optional().isBoolean().withMessage('ssl_verify must be boolean'),
];

function buildDirectCredentials(reqBody) {
  return encrypt(JSON.stringify({ password: String(reqBody.password) }));
}

function describeApiError(err) {
  if (err?.response) {
    const status = err.response.status;
    const detail = err.response.data?.error?.message || '';
    if (status === 401 || status === 403) return `Authentication failed (HTTP ${status})${detail ? `: ${detail}` : ''}`;
    return `Cluster returned HTTP ${status}${detail ? `: ${detail}` : ''}`;
  }
  if (err?.code === 'NETAPP_NO_PASSWORD') return 'No password provided';
  if (err?.code) return `Network error: ${err.code}`;
  return err?.message || 'Connection failed';
}

/* ── AIQUM connection + discovered clusters ──────────────────────────────── */

// Clusters currently managed by AIQUM (populated by the poller's discovery).
router.get('/arrays', cacheControl(15), (req, res, next) => {
  try {
    res.json(db.prepare('SELECT * FROM netapp_arrays ORDER BY name ASC').all().map(publicCluster));
  } catch (err) { next(err); }
});

// Read-only gateway row: credential values never returned, presence only.
function publicAiqumInstance(row) {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    hasUsername: !!row.username,
    hasPassword: !!row.encrypted_credentials,
    pollIntervalMin: row.poll_interval_minutes,
    clusterCount: db.prepare("SELECT COUNT(*) AS n FROM netapp_arrays WHERE source = 'aiqum' AND aiqum_instance_id = ?").get(row.id).n,
    created_at: row.created_at,
  };
}

// AIQUM gateways + overall status. (Multi-gateway since netapp v5; the old
// singleton settings config is migrated into the first row automatically.)
router.get('/aiqum', (req, res) => {
  const instances = db.prepare('SELECT * FROM netapp_aiqum_instances ORDER BY id').all();
  res.json({
    configured: instances.length > 0,
    instances: instances.map(publicAiqumInstance),
    clusterCount: db.prepare("SELECT COUNT(*) AS n FROM netapp_arrays WHERE source = 'aiqum'").get().n,
  });
});

const aiqumInstanceValidators = [
  body('name').optional().isString().trim().isLength({ max: 120 }),
  body('host').isString().trim().notEmpty().isLength({ max: 512 }),
  body('username').optional().isString().trim().isLength({ max: 256 }),
  body('password').optional().isString().isLength({ max: 1024 }),
  body('pollIntervalMin').optional().isInt({ min: 5, max: 1440 }).toInt(),
];

// Register a new AIQUM gateway.
router.post('/aiqum/instances', aiqumInstanceValidators, validate, (req, res, next) => {
  try {
    const { name, host, username, password, pollIntervalMin } = req.body;
    const h = String(host).trim();
    if (isBlockedHost(h)) return res.status(400).json({ error: 'host is not allowed' });
    if (!username || !password) return res.status(400).json({ error: 'username and password are required' });
    if (db.prepare('SELECT id FROM netapp_aiqum_instances WHERE LOWER(host) = LOWER(?)').get(h)) {
      return res.status(409).json({ error: 'A gateway with that host already exists' });
    }
    const r = db.prepare(`
      INSERT INTO netapp_aiqum_instances (name, host, username, encrypted_credentials, poll_interval_minutes)
      VALUES (?, ?, ?, ?, ?)
    `).run(name?.trim() || h, h, username.trim(), encrypt(password), pollIntervalMin || 15);
    reschedule();
    res.status(201).json(publicAiqumInstance(db.prepare('SELECT * FROM netapp_aiqum_instances WHERE id = ?').get(r.lastInsertRowid)));
  } catch (err) { next(err); }
});

// Update a gateway (username/password kept when blank).
router.put('/aiqum/instances/:id', [param('id').isInt().toInt(), ...aiqumInstanceValidators], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM netapp_aiqum_instances WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Gateway not found' });
    const { name, host, username, password, pollIntervalMin } = req.body;
    const h = String(host).trim();
    if (isBlockedHost(h)) return res.status(400).json({ error: 'host is not allowed' });
    const dup = db.prepare('SELECT id FROM netapp_aiqum_instances WHERE LOWER(host) = LOWER(?) AND id != ?').get(h, row.id);
    if (dup) return res.status(409).json({ error: 'A gateway with that host already exists' });
    db.prepare(`
      UPDATE netapp_aiqum_instances SET name = ?, host = ?, username = ?, encrypted_credentials = ?,
        poll_interval_minutes = ?, updated_at = datetime('now') WHERE id = ?
    `).run(
      name?.trim() || row.name, h,
      username?.trim() || row.username,
      password ? encrypt(password) : row.encrypted_credentials,
      pollIntervalMin || row.poll_interval_minutes, row.id
    );
    reschedule();
    res.json(publicAiqumInstance(db.prepare('SELECT * FROM netapp_aiqum_instances WHERE id = ?').get(row.id)));
  } catch (err) { next(err); }
});

// Remove a gateway and the clusters it discovered (cascade clears telemetry).
router.delete('/aiqum/instances/:id', [param('id').isInt().toInt()], validate, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM netapp_aiqum_instances WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Gateway not found' });
    db.transaction(() => {
      db.prepare("DELETE FROM netapp_arrays WHERE source = 'aiqum' AND aiqum_instance_id = ?").run(row.id);
      db.prepare('DELETE FROM netapp_aiqum_instances WHERE id = ?').run(row.id);
    })();
    reschedule();
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// Discover + poll one gateway now.
router.post('/aiqum/instances/:id/poll', [param('id').isInt().toInt()], validate, async (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM netapp_aiqum_instances WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Gateway not found' });
    await syncAndPollInstance(row);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Validate AIQUM connectivity. Accepts posted creds; `id` fills blanks from
// that stored gateway (edit-form testing without retyping the password).
router.post('/aiqum/test', async (req, res) => {
  try {
    const b = req.body || {};
    let stored = { host: '', username: '', password: '' };
    if (b.id) {
      const row = db.prepare('SELECT * FROM netapp_aiqum_instances WHERE id = ?').get(Number(b.id));
      if (row) stored = netappApi.instanceConfig(row);
    } else {
      stored = netappApi.getAiqumConfig();
    }
    const override = {
      host: b.host || stored.host,
      username: b.username || stored.username,
      password: b.password || stored.password,
    };
    res.json(await netappApi.testAiqum(override));
  } catch (err) {
    const status = err.response && err.response.status;
    res.status(200).json({ ok: false, error: status ? `HTTP ${status}` : (err.message || 'Connection failed') });
  }
});

/* ── Direct clusters CRUD (coexist with AIQUM-managed rows) ─────────────── */

// Validate connectivity for a direct cluster, without persisting. If `id` is
// given and password is blank, tests the stored credentials for that row.
router.post(
  '/arrays/test',
  [
    body('mgmt_host').trim().notEmpty().custom((v) => !isBlockedHost(v)).withMessage('mgmt_host is not allowed'),
    body('username').optional({ nullable: true }).trim(),
    body('password').optional({ nullable: true }),
    body('ssl_verify').optional().isBoolean(),
    body('id').optional().isInt(),
  ],
  validate,
  async (req, res) => {
    try {
      // Username/password are write-only in the UI, so an edit-mode test may
      // leave either blank — fall back to the stored row when an id is given.
      let stored = null;
      if (req.body.id) {
        stored = db.prepare("SELECT * FROM netapp_arrays WHERE id = ? AND source = 'direct'").get(req.body.id);
        if (!stored && (!req.body.password || !req.body.username)) {
          return res.status(200).json({ ok: false, error: 'Cluster not found' });
        }
      }
      const username = (req.body.username || '').trim() || stored?.username;
      if (!username) return res.status(200).json({ ok: false, error: 'No username provided' });
      if (!req.body.password && !stored) {
        return res.status(200).json({ ok: false, error: 'No password provided' });
      }
      const result = await netappApi.testDirectConnection({
        mgmt_host: req.body.mgmt_host,
        username,
        password: req.body.password || undefined,
        encrypted_credentials: req.body.password ? undefined : stored?.encrypted_credentials,
        ssl_verify: req.body.ssl_verify ? 1 : 0,
      });
      res.json(result);
    } catch (err) {
      res.status(200).json({ ok: false, error: describeApiError(err) });
    }
  }
);

// Register a new direct cluster.
router.post('/arrays', directArrayValidators, validate, (req, res, next) => {
  if (!req.body.password) return res.status(400).json({ error: 'password is required' });
  try {
    const info = db.prepare(`
      INSERT INTO netapp_arrays (name, mgmt_host, username, encrypted_credentials, polling_interval_minutes, ssl_verify, source)
      VALUES (?, ?, ?, ?, ?, ?, 'direct')
    `).run(
      req.body.name,
      netappApi.normalizeHost(req.body.mgmt_host),
      req.body.username,
      buildDirectCredentials(req.body),
      req.body.polling_interval_minutes || 15,
      req.body.ssl_verify ? 1 : 0
    );
    const row = db.prepare('SELECT * FROM netapp_arrays WHERE id = ?').get(info.lastInsertRowid);
    scheduleArray(row);
    // Kick off an immediate first poll so data appears without waiting.
    triggerPoll(row.id).catch(() => {});
    res.status(201).json(publicCluster(row));
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A cluster with that name already exists' });
    }
    next(err);
  }
});

// Update a direct cluster (password optional; kept if blank). AIQUM-managed
// rows are read-only here — they are updated automatically by discovery.
router.put('/arrays/:id', [param('id').isInt(), ...directArrayUpdateValidators], validate, (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM netapp_arrays WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Cluster not found' });
    if (existing.source === 'aiqum') {
      return res.status(403).json({ error: 'AIQUM-managed clusters are updated automatically' });
    }
    const encrypted = req.body.password ? buildDirectCredentials(req.body) : existing.encrypted_credentials;
    db.prepare(`
      UPDATE netapp_arrays SET name = ?, mgmt_host = ?, username = ?, encrypted_credentials = ?,
        polling_interval_minutes = ?, ssl_verify = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      req.body.name,
      netappApi.normalizeHost(req.body.mgmt_host),
      (req.body.username || '').trim() || existing.username,
      encrypted,
      req.body.polling_interval_minutes || existing.polling_interval_minutes,
      req.body.ssl_verify ? 1 : 0,
      req.params.id
    );
    const row = db.prepare('SELECT * FROM netapp_arrays WHERE id = ?').get(req.params.id);
    scheduleArray(row);
    res.json(publicCluster(row));
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A cluster with that name already exists' });
    }
    next(err);
  }
});

// Delete a direct cluster. AIQUM-managed rows are removed by discovery only.
router.delete('/arrays/:id', [param('id').isInt()], validate, (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM netapp_arrays WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Cluster not found' });
    if (existing.source === 'aiqum') {
      return res.status(403).json({ error: 'AIQUM-managed clusters cannot be deleted here' });
    }
    db.prepare('DELETE FROM netapp_arrays WHERE id = ?').run(req.params.id);
    cancelArray(Number(req.params.id));
    res.json({ success: true });
  } catch (err) { next(err); }
});

// Trigger a discovery + poll of all AIQUM-managed clusters now.
router.post('/poll', async (req, res, next) => {
  try { await syncAndPollAll(); res.json({ success: true }); } catch (err) { next(err); }
});

// Poll a single already-discovered cluster now.
router.post('/arrays/:id/poll', [param('id').isInt()], validate, async (req, res, next) => {
  try {
    const array = db.prepare('SELECT * FROM netapp_arrays WHERE id = ?').get(req.params.id);
    if (!array) return res.status(404).json({ error: 'Cluster not found' });
    await triggerPoll(array.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

/* ── Telemetry reads ─────────────────────────────────────────────────────── */

// Latest sample + counts for every cluster.
router.get('/overview', cacheControl(15), (req, res, next) => {
  try {
    const arrays = db.prepare('SELECT * FROM netapp_arrays ORDER BY name ASC').all();
    const latestStmt = db.prepare('SELECT * FROM netapp_metrics_history WHERE array_id = ? ORDER BY captured_at DESC LIMIT 1');
    const alertStmt = db.prepare('SELECT COUNT(*) AS n FROM netapp_alerts WHERE array_id = ?');
    const volStmt = db.prepare('SELECT COUNT(*) AS n FROM netapp_volumes WHERE array_id = ?');
    const aggStmt = db.prepare('SELECT COUNT(*) AS n FROM netapp_aggregates WHERE array_id = ?');
    res.json(arrays.map((a) => ({
      ...publicCluster(a),
      latest: latestStmt.get(a.id) || null,
      open_alerts: alertStmt.get(a.id).n,
      volume_count: volStmt.get(a.id).n,
      aggregate_count: aggStmt.get(a.id).n,
    })));
  } catch (err) { next(err); }
});

router.get('/arrays/:id/metrics/history', [param('id').isInt(), query('days').optional().isInt({ min: 1, max: 90 })], validate, cacheControl(30), (req, res, next) => {
  try {
    const days = Number(req.query.days) || 7;
    const rows = db.prepare(`
      SELECT * FROM netapp_metrics_history WHERE array_id = ? AND captured_at >= datetime('now', ?)
      ORDER BY captured_at ASC
    `).all(req.params.id, `-${days} days`);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/aggregates', cacheControl(30), (req, res, next) => {
  try {
    res.json(db.prepare(`
      SELECT g.*, a.name AS array_name FROM netapp_aggregates g
      JOIN netapp_arrays a ON a.id = g.array_id ORDER BY a.name, g.name
    `).all());
  } catch (err) { next(err); }
});

router.get('/volumes', cacheControl(30), (req, res, next) => {
  try {
    res.json(db.prepare(`
      SELECT v.*, a.name AS array_name FROM netapp_volumes v
      JOIN netapp_arrays a ON a.id = v.array_id ORDER BY v.used_bytes DESC
    `).all());
  } catch (err) { next(err); }
});

router.get('/alerts', cacheControl(15), (req, res, next) => {
  try {
    res.json(db.prepare(`
      SELECT al.*, a.name AS array_name FROM netapp_alerts al
      JOIN netapp_arrays a ON a.id = al.array_id
      ORDER BY CASE LOWER(al.severity)
        WHEN 'emergency' THEN 0 WHEN 'alert' THEN 1 WHEN 'critical' THEN 2
        WHEN 'error' THEN 3 WHEN 'warning' THEN 4 ELSE 5 END, al.captured_at DESC
    `).all());
  } catch (err) { next(err); }
});

router.get('/arrays/:id/hardware', [param('id').isInt()], validate, cacheControl(60), (req, res, next) => {
  try {
    const id = req.params.id;
    res.json({
      nodes: db.prepare('SELECT * FROM netapp_nodes WHERE array_id = ? ORDER BY name').all(id),
      disks: db.prepare('SELECT * FROM netapp_disks WHERE array_id = ? ORDER BY name').all(id),
      svms: db.prepare('SELECT * FROM netapp_svms WHERE array_id = ? ORDER BY name').all(id),
    });
  } catch (err) { next(err); }
});

// Numeric-aware compare on the dotted ONTAP version string ("9.13.1P8"
// style: dotted release plus an optional patch letter+number). Unparsable or
// missing versions sort lowest so junk data never throws.
function parseOntapVersion(v) {
  if (!v) return null;
  const m = String(v).replace(/^NetApp Release\s*/i, '').match(/(\d+(?:\.\d+){1,4})(?:P(\d+))?/);
  if (!m) return null;
  return { parts: m[1].split('.').map(Number), patch: m[2] != null ? Number(m[2]) : 0 };
}
function compareOntapVersion(a, b) {
  const pa = parseOntapVersion(a);
  const pb = parseOntapVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  const len = Math.max(pa.parts.length, pb.parts.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa.parts[i] || 0;
    const y = pb.parts[i] || 0;
    if (x !== y) return x - y;
  }
  return pa.patch - pb.patch;
}

// SQLite DATETIME columns come back as "YYYY-MM-DD HH:MM:SS" (no zone);
// poller_status.last_poll_end is already a full ISO string. Normalize both
// to ISO so the frontend and the staleness check below can just parse them.
function normalizeSqliteDate(val) {
  if (!val) return null;
  return /[TZ]/.test(val) ? val : `${val.replace(' ', 'T')}Z`;
}

// Canonical release label built from the parsed version, e.g. "9.13.1P8" for
// both the AIQUM short form ("9.13.1P8") and the direct/node full form
// ("NetApp Release 9.13.1P8: Thu Mar 14 12:00:00 UTC 2024") - so grouping,
// filtering and "behind newest" never depend on which format a given row
// happened to store. Falls back to the trimmed raw string when unparsable so
// nothing is silently dropped.
function canonicalOntapRelease(v) {
  const p = parseOntapVersion(v);
  if (p) return `${p.parts.join('.')}${p.patch > 0 ? `P${p.patch}` : ''}`;
  const trimmed = v == null ? '' : String(v).trim();
  return trimmed || null;
}

const FAILED_DISK_STATES = new Set(['failed', 'broken', 'offline', 'down', 'error', 'unreachable']);

// Consolidated view of the whole NetApp estate (every cluster ICC polls, not
// one array at a time): hardware, code levels, models and capacity rollup.
// Read-only, no poller changes, no new tables. Each section is wrapped so a
// degraded table drops that field instead of failing the endpoint.
router.get('/governance', cacheControl(30), (req, res, next) => {
  try {
    const clusters = db.prepare('SELECT * FROM netapp_arrays ORDER BY name ASC').all();
    const clusterById = new Map(clusters.map((c) => [c.id, c]));
    const aiqumNames = new Map(db.prepare('SELECT id, name FROM netapp_aiqum_instances').all().map((r) => [r.id, r.name]));

    let nodes = [];
    try { nodes = db.prepare('SELECT * FROM netapp_nodes ORDER BY array_id, name').all(); } catch { /* table degraded */ }
    const nodesByArray = new Map();
    for (const n of nodes) {
      if (!nodesByArray.has(n.array_id)) nodesByArray.set(n.array_id, []);
      nodesByArray.get(n.array_id).push(n);
    }

    const capByArray = new Map();
    try {
      for (const r of db.prepare(`
        SELECT array_id, SUM(size_bytes) AS size, SUM(used_bytes) AS used, COUNT(*) AS n
        FROM netapp_aggregates GROUP BY array_id
      `).all()) capByArray.set(r.array_id, r);
    } catch { /* table degraded */ }

    const volByArray = new Map();
    try {
      for (const r of db.prepare('SELECT array_id, COUNT(*) AS n FROM netapp_volumes GROUP BY array_id').all()) volByArray.set(r.array_id, r.n);
    } catch { /* table degraded */ }

    const diskByArray = new Map();
    try {
      for (const r of db.prepare('SELECT array_id, state, COUNT(*) AS n FROM netapp_disks GROUP BY array_id, state').all()) {
        const cur = diskByArray.get(r.array_id) || { total: 0, failed: 0 };
        cur.total += r.n;
        if (FAILED_DISK_STATES.has(String(r.state || '').toLowerCase())) cur.failed += r.n;
        diskByArray.set(r.array_id, cur);
      }
    } catch { /* table degraded */ }

    const svmByArray = new Map();
    try {
      for (const r of db.prepare('SELECT array_id, COUNT(*) AS n FROM netapp_svms GROUP BY array_id').all()) svmByArray.set(r.array_id, r.n);
    } catch { /* table degraded */ }

    const alertsByArray = new Map();
    try {
      for (const r of db.prepare('SELECT array_id, severity, COUNT(*) AS n FROM netapp_alerts GROUP BY array_id, severity').all()) {
        const cur = alertsByArray.get(r.array_id) || { total: 0, bySeverity: {} };
        cur.total += r.n;
        cur.bySeverity[String(r.severity || 'unknown').toLowerCase()] = r.n;
        alertsByArray.set(r.array_id, cur);
      }
    } catch { /* table degraded */ }

    const snapmirrorByArray = new Map();
    try {
      for (const r of db.prepare('SELECT array_id, COUNT(*) AS n FROM netapp_snapmirror GROUP BY array_id').all()) snapmirrorByArray.set(r.array_id, r.n);
    } catch { /* table degraded */ }

    // The poller framework writes poller_status keyed by ('netapp', array.id)
    // for both direct and AIQUM-managed clusters (services/netappPoller.js
    // routes both through the same directPoller). One read for all clusters.
    const pollByArray = new Map();
    try {
      for (const [key, state] of pollerStatus.getAll()) {
        if (!key.startsWith('netapp:')) continue;
        pollByArray.set(Number(key.slice('netapp:'.length)), state);
      }
    } catch { /* poller_status degraded */ }

    // Code-level + model distributions are node-granular (a cluster mid
    // upgrade can straddle two versions; mixed_versions below flags that).
    // Grouped by the CANONICAL release, not the raw stored string: direct
    // clusters/nodes store the full "NetApp Release 9.13.1P8: <date>" form,
    // AIQUM-sourced arrays and the demo generator store the short form, and
    // without normalizing first the same release could show as two rows.
    const versionMap = new Map();
    const modelMap = new Map();
    for (const n of nodes) {
      const cluster = clusterById.get(n.array_id);
      const release = canonicalOntapRelease(n.version);
      if (release) {
        let ve = versionMap.get(release);
        if (!ve) { ve = { version: release, nodeCount: 0, clusterIds: new Set(), clusterNames: new Set() }; versionMap.set(release, ve); }
        ve.nodeCount += 1;
        if (cluster) { ve.clusterIds.add(cluster.id); ve.clusterNames.add(cluster.name); }
      }
      if (n.model) {
        let me = modelMap.get(n.model);
        if (!me) { me = { model: n.model, nodeCount: 0, clusterIds: new Set(), clusterNames: new Set() }; modelMap.set(n.model, me); }
        me.nodeCount += 1;
        if (cluster) { me.clusterIds.add(cluster.id); me.clusterNames.add(cluster.name); }
      }
    }
    const versions = [...versionMap.values()]
      .map((v) => ({ version: v.version, cluster_count: v.clusterIds.size, node_count: v.nodeCount, clusters: [...v.clusterNames].sort() }))
      .sort((a, b) => compareOntapVersion(b.version, a.version));
    const models = [...modelMap.values()]
      .map((v) => ({ model: v.model, node_count: v.nodeCount, cluster_count: v.clusterIds.size, clusters: [...v.clusterNames].sort() }))
      .sort((a, b) => b.node_count - a.node_count || a.model.localeCompare(b.model));

    const newestVersion = versions.length ? versions[0].version : null;
    const majorityVersion = versions.length ? [...versions].sort((a, b) => b.node_count - a.node_count)[0].version : null;

    const clusterRows = clusters.map((c) => {
      const myNodes = nodesByArray.get(c.id) || [];
      const models = [...new Set(myNodes.map((n) => n.model).filter(Boolean))];
      const serials = myNodes.map((n) => n.serial_number).filter(Boolean);
      const nodeReleases = myNodes.map((n) => canonicalOntapRelease(n.version)).filter(Boolean);
      const nodeVersions = [...new Set(nodeReleases)];
      const ontapRelease = canonicalOntapRelease(c.version);
      const cap = capByArray.get(c.id);
      const totalBytes = cap?.size || 0;
      const usedBytes = cap?.used || 0;
      const disks = diskByArray.get(c.id) || { total: 0, failed: 0 };
      const alerts = alertsByArray.get(c.id) || { total: 0, bySeverity: {} };
      const poll = pollByArray.get(c.id);
      const nodeMaxCaptured = myNodes.reduce((max, n) => (n.captured_at && (!max || n.captured_at > max) ? n.captured_at : max), null);
      const lastPolled = normalizeSqliteDate(poll?.lastPollEnd || nodeMaxCaptured || null);
      return {
        id: c.id,
        name: c.name,
        mgmt_host: c.mgmt_host,
        source: c.source === 'aiqum' ? (aiqumNames.get(c.aiqum_instance_id) || 'AIQUM') : 'direct',
        ontap_version: c.version,
        ontap_release: ontapRelease,
        node_count: myNodes.length,
        models,
        serials,
        node_versions: nodeVersions,
        mixed_versions: nodeVersions.length > 1,
        behind: ontapRelease ? ontapRelease !== newestVersion : false,
        capacity_total_bytes: totalBytes,
        capacity_used_bytes: usedBytes,
        capacity_used_percent: totalBytes ? Math.round((usedBytes / totalBytes) * 1000) / 10 : null,
        aggregate_count: cap?.n || 0,
        volume_count: volByArray.get(c.id) || 0,
        disk_count: disks.total,
        disk_failed_count: disks.failed,
        svm_count: svmByArray.get(c.id) || 0,
        open_alert_count: alerts.total,
        open_alerts_by_severity: alerts.bySeverity,
        snapmirror_count: snapmirrorByArray.get(c.id) || 0,
        last_polled: lastPolled,
        poll_status: poll?.lastPollStatus || null,
        poll_error: poll?.lastPollStatus === 'error',
        polling_interval_minutes: c.polling_interval_minutes,
      };
    });

    const now = Date.now();
    const clustersWithPollIssue = clusterRows.filter((c) => {
      if (c.poll_error) return true;
      if (!c.last_polled) return true;
      const ageMin = (now - new Date(c.last_polled).getTime()) / 60000;
      if (isNaN(ageMin)) return false;
      return ageMin > (c.polling_interval_minutes || 15) * 2 + 5;
    }).length;

    res.json({
      clusters: clusterRows,
      nodes: nodes.map((n) => {
        const release = canonicalOntapRelease(n.version);
        return {
          array_id: n.array_id,
          array_name: clusterById.get(n.array_id)?.name || null,
          name: n.name,
          model: n.model,
          serial_number: n.serial_number,
          state: n.state,
          version: n.version,
          release,
          behind: release ? release !== newestVersion : false,
        };
      }),
      versions,
      models,
      newest_version: newestVersion,
      majority_version: majorityVersion,
      summary: {
        cluster_count: clusters.length,
        node_count: nodes.length,
        distinct_versions: versionMap.size,
        distinct_models: modelMap.size,
        clusters_with_mixed_versions: clusterRows.filter((c) => c.mixed_versions).length,
        clusters_behind_newest: clusterRows.filter((c) => c.behind).length,
        clusters_with_poll_issue: clustersWithPollIssue,
      },
    });
  } catch (err) { next(err); }
});

// SnapMirror relationships (DR replication) across all clusters.
router.get('/replication', cacheControl(30), (req, res, next) => {
  try {
    res.json(db.prepare(`
      SELECT s.*, a.name AS array_name FROM netapp_snapmirror s
      JOIN netapp_arrays a ON a.id = s.array_id
      ORDER BY s.healthy ASC, s.lag_seconds DESC
    `).all());
  } catch (err) { next(err); }
});

// Logical interfaces (LIFs) for one cluster.
router.get('/arrays/:id/network', [param('id').isInt()], validate, cacheControl(60), (req, res, next) => {
  try {
    res.json(db.prepare('SELECT * FROM netapp_lifs WHERE array_id = ? ORDER BY svm_name, name').all(req.params.id));
  } catch (err) { next(err); }
});

// Quota reports across all clusters.
router.get('/quotas', cacheControl(60), (req, res, next) => {
  try {
    res.json(db.prepare(`
      SELECT q.*, a.name AS array_name FROM netapp_quotas q
      JOIN netapp_arrays a ON a.id = q.array_id
      ORDER BY q.space_used_bytes DESC
    `).all());
  } catch (err) { next(err); }
});

// One row per live client↔volume mount (NFS clients + SMB sessions merged),
// joined with volume detail and resolved to a VM name where inventory knows
// the IP. Feeds the Mounts page.
router.get('/mounts', cacheControl(30), (req, res, next) => {
  try {
    const ipIndex = require('../services/ipIdentity').buildIpIndex();
    const rows = db.prepare(`
      SELECT m.mount_type, m.client_ip, m.protocols, m.smb_users,
             m.svm_name, m.volume_name, a.name AS array_name,
             v.aggregate_name, v.type, v.style, v.junction_path,
             v.size_bytes, v.used_bytes, v.used_percent, v.state
      FROM (
        SELECT array_id, 'NFS' AS mount_type, client_ip, svm_name, volume_name,
               GROUP_CONCAT(DISTINCT protocol) AS protocols, NULL AS smb_users
        FROM netapp_nfs_clients
        GROUP BY array_id, client_ip, svm_name, volume_name
        UNION ALL
        SELECT array_id, 'SMB', client_ip, svm_name, volume_name,
               GROUP_CONCAT(DISTINCT protocol), GROUP_CONCAT(DISTINCT smb_user)
        FROM netapp_cifs_sessions
        GROUP BY array_id, client_ip, svm_name, volume_name
      ) m
      JOIN netapp_arrays a ON a.id = m.array_id
      LEFT JOIN netapp_volumes v
        ON v.array_id = m.array_id AND v.svm_name = m.svm_name AND v.name = m.volume_name
      ORDER BY m.client_ip, m.volume_name
    `).all().map((r) => ({ ...r, client_name: ipIndex.get(r.client_ip)?.name ?? null }));
    res.json(rows);
  } catch (err) { next(err); }
});

// NFS connected clients + export-policy rules across all clusters.
router.get('/nfs', cacheControl(30), (req, res, next) => {
  try {
    const ipIndex = require('../services/ipIdentity').buildIpIndex();
    res.json({
      clients: db.prepare(`
        SELECT c.*, a.name AS array_name FROM netapp_nfs_clients c
        JOIN netapp_arrays a ON a.id = c.array_id
        ORDER BY c.client_ip
      `).all().map((c) => ({ ...c, client_name: ipIndex.get(c.client_ip)?.name ?? null })),
      exportRules: db.prepare(`
        SELECT r.*, a.name AS array_name FROM netapp_export_rules r
        JOIN netapp_arrays a ON a.id = r.array_id
        ORDER BY r.svm_name, r.policy_name, r.rule_index
      `).all(),
    });
  } catch (err) { next(err); }
});

router.get('/cifs', cacheControl(30), (req, res, next) => {
  try {
    const ipIndex = require('../services/ipIdentity').buildIpIndex();
    res.json({
      sessions: db.prepare(`
        SELECT s.*, a.name AS array_name FROM netapp_cifs_sessions s
        JOIN netapp_arrays a ON a.id = s.array_id
        ORDER BY s.client_ip
      `).all().map((s) => ({ ...s, client_name: ipIndex.get(s.client_ip)?.name ?? null })),
      shares: db.prepare(`
        SELECT sh.*, a.name AS array_name FROM netapp_cifs_shares sh
        JOIN netapp_arrays a ON a.id = sh.array_id
        ORDER BY sh.svm_name, sh.share_name
      `).all(),
    });
  } catch (err) { next(err); }
});

function advisorReportKey(slug) {
  return String(slug).replace(/-/g, '_');
}

/** GET /api/netapp/advisor/:report — cached NetApp AI Advisor report. */
router.get('/advisor/:report', [param('report').isString()], validate, (req, res, next) => {
  try {
    const key = advisorReportKey(req.params.report);
    if (!netappAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
    res.json({ enabled: netappAdvisor.isConfigured(), report: netappAdvisor.getCachedReport(key) });
  } catch (err) { next(err); }
});

/** POST /api/netapp/advisor/:report — (re)generate and cache a NetApp AI Advisor report. */
router.post('/advisor/:report', [param('report').isString()], validate, async (req, res, next) => {
  try {
    const key = advisorReportKey(req.params.report);
    if (!netappAdvisor.REPORTS.includes(key)) return res.status(404).json({ error: 'Unknown report.' });
    const result = await netappAdvisor.generateReport(key);
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
    next(err);
  }
});

module.exports = router;
