const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const db = require('../db/database');
const { encrypt } = require('../services/encryption');
const netappApi = require('../services/netappApi');
const { syncAndPollAll, syncAndPollInstance, triggerPoll, reschedule, scheduleArray, cancelArray } = require('../services/netappPoller');
const cacheControl = require('../middleware/cache');
const netappAdvisor = require('../services/advisors/netappAdvisor');

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
