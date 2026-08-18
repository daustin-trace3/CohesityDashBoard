// Cohesity DATA-PLANE route table (bare-router, compile.js format —
// createRouter must return a BARE (req, res, next) function, unifi/dell
// pattern; no host express/express-validator available to a bundled
// plugin). Ports, with IDENTICAL paths/status codes/JSON shapes:
//   backend/routes/clusters.js, metrics.js, alerts.js (minus AI review —
//   see below), hardware.js, helios.js, import.js, analytics.js,
//   replication.js, dashboard.js, and the poller trigger endpoints from
//   backend/routes/pollerTrigger.js.
//
// express-validator's `{ errors: [...] }` 400 shape is reproduced by hand
// (field-level `{ msg, path }` entries) rather than dell/unifi's `{ error,
// details }` shape, because the BUILT-IN cohesity routes actually return
// `{ errors: errors.array() }` — matching that key name matters more here
// than matching the other packs' convention.
//
// AI review (alerts.js's GET /alerts/ai/status, GET/POST /alerts/:id/review)
// depends on backend/services/aiInsights.js — WP-B territory, not ported.
// Same optional-require composition pattern as poller.js's workloads hook
// and snapshot.js's insights hook: this file does
//   `try { aiInsights = require('./aiInsights'); } catch { aiInsights = null; }`
// If WP-B later drops an aiInsights.js into this same backend/src/
// directory exporting `isAiEnabled(coreApi)`, `getCachedReview(alertId,
// coreApi)`, `reviewAlert(alertId, opts, coreApi)`, these three routes work
// automatically. Until then: ai/status -> {enabled:false}, GET review ->
// null, POST review -> 503.
const api = require('./api');
const poller = require('./poller');
const { compile } = require('./compile');
const {
  parseIntStrict, isNonEmptyString, isBooleanish, toBool, parseQueryInt,
} = require('./validate');

let aiInsights = null;
try {
  // eslint-disable-next-line global-require
  aiInsights = require('./aiInsights');
} catch {
  aiInsights = null;
}

function badReq(res, items) {
  res.status(400).json({ errors: items });
}
function vfail(path, msg = 'Invalid value') {
  return { msg, path };
}
function reqIntParam(req, res, name = 'id') {
  const v = parseIntStrict(req.params[name]);
  if (!Number.isInteger(v) || v < 1) {
    badReq(res, [vfail(name)]);
    return null;
  }
  return v;
}
function cache(res, seconds) {
  res.set('Cache-Control', `private, max-age=${seconds}, must-revalidate`);
}

// ── clusters ─────────────────────────────────────────────────────────────

function isBlockedVip(vip) {
  const blocked = [
    /^127\./,
    /^0\.0\.0\.0/,
    /^169\.254\./,
    /^::1$/,
    /^localhost$/i,
    /^metadata\.google\.internal$/i,
    /^169\.254\.169\.254$/
  ];
  return blocked.some((pattern) => pattern.test(vip));
}

function validateClusterBody(b, { partial = false } = {}) {
  const errors = [];
  if (!partial || b.name !== undefined) {
    if (!isNonEmptyString(b.name, 253)) errors.push(vfail('name', 'name is required'));
  }
  if (!partial || b.connection_type !== undefined) {
    if (!['helios', 'direct'].includes(b.connection_type)) errors.push(vfail('connection_type', 'connection_type must be helios or direct'));
  }
  if (!partial || b.auth_type !== undefined) {
    if (!['userpass', 'apikey'].includes(b.auth_type)) errors.push(vfail('auth_type', 'auth_type must be userpass or apikey'));
  }
  if (!partial || b.credentials !== undefined) {
    if (typeof b.credentials !== 'object' || b.credentials === null || Array.isArray(b.credentials)) {
      errors.push(vfail('credentials', 'credentials must be an object'));
    } else {
      const creds = b.credentials;
      const authType = b.auth_type;
      const connType = b.connection_type;
      if (connType === 'helios') {
        if (creds.apiKey !== undefined && creds.apiKey !== '' &&
            (typeof creds.apiKey !== 'string' || creds.apiKey.length > 512)) {
          errors.push(vfail('credentials', 'credentials.apiKey must be a string (max 512 chars)'));
        }
      } else if (authType === 'apikey') {
        if (!creds.apiKey || typeof creds.apiKey !== 'string' || creds.apiKey.length > 512) {
          errors.push(vfail('credentials', 'credentials.apiKey is required (max 512 chars)'));
        }
      } else if (authType === 'userpass') {
        if (!creds.username || typeof creds.username !== 'string' || creds.username.length > 256) {
          errors.push(vfail('credentials', 'credentials.username must be a string (max 256 chars)'));
        }
        if (!creds.password || typeof creds.password !== 'string' || creds.password.length > 1024) {
          errors.push(vfail('credentials', 'credentials.password must be a string (max 1024 chars)'));
        }
        const allowedKeys = new Set(['username', 'password', 'domain']);
        for (const key of Object.keys(creds)) {
          if (!allowedKeys.has(key)) errors.push(vfail('credentials', `credentials: unexpected key '${key}'`));
        }
      }
    }
  }
  if (b.connection_type === 'direct') {
    const vip = typeof b.vip === 'string' ? b.vip.trim() : b.vip;
    if (!vip) errors.push(vfail('vip', 'VIP/hostname is required for direct connections'));
    else if (!/^[a-zA-Z0-9._-]+$/.test(vip)) errors.push(vfail('vip', 'VIP contains invalid characters'));
    else if (vip.length > 253) errors.push(vfail('vip', 'VIP too long'));
    else if (isBlockedVip(vip)) errors.push(vfail('vip', 'VIP address not allowed'));
  } else if (b.connection_type === 'helios') {
    const vip = typeof b.vip === 'string' ? b.vip.trim() : b.vip;
    if (!vip) errors.push(vfail('vip', 'Helios cluster ID is required'));
    else if (!/^\d+$/.test(vip)) errors.push(vfail('vip', 'Helios cluster ID must be numeric'));
    else if (vip.length > 20) errors.push(vfail('vip', 'Helios cluster ID too long'));
  }
  if (b.polling_interval_minutes !== undefined) {
    const n = parseIntStrict(b.polling_interval_minutes);
    if (!Number.isInteger(n) || n < 5) errors.push(vfail('polling_interval_minutes', 'polling_interval_minutes must be >= 5'));
  }
  if (b.ssl_verify !== undefined && !isBooleanish(b.ssl_verify) && typeof b.ssl_verify !== 'boolean') {
    errors.push(vfail('ssl_verify'));
  }
  if (b.tags !== undefined) {
    if (typeof b.tags !== 'string' || b.tags.length > 500) {
      errors.push(vfail('tags', 'tags too long'));
    } else {
      const tags = b.tags.split(',').map((t) => t.trim()).filter(Boolean);
      for (const tag of tags) {
        if (!/^[a-zA-Z0-9 _-]{1,50}$/.test(tag)) {
          errors.push(vfail('tags', `Invalid tag: "${tag}". Tags may contain letters, numbers, spaces, hyphens, underscores (max 50 chars each).`));
        }
      }
    }
  }
  return errors;
}

function handleGetClusters(req, res, coreApi) {
  cache(res, 30);
  res.json(coreApi.db.prepare(`
    SELECT id, name, connection_type, vip, auth_type,
           polling_interval_minutes, ssl_verify, tags, created_at, updated_at
    FROM clusters
    ORDER BY name ASC
  `).all());
}

function handlePostClusters(req, res, coreApi) {
  const b = req.body || {};
  const errors = validateClusterBody(b);
  if (errors.length) return badReq(res, errors);

  const {
    name, connection_type, vip, auth_type, credentials,
    polling_interval_minutes = 15, ssl_verify = false, tags = ''
  } = b;

  if (connection_type === 'direct' && !vip) {
    return res.status(400).json({ error: 'vip is required for direct connections' });
  }
  if (connection_type === 'direct' && vip && isBlockedVip(vip)) {
    return res.status(400).json({ error: 'Invalid VIP address.' });
  }

  const db = coreApi.db;
  try {
    const encryptedCreds = coreApi.encryption.encrypt(JSON.stringify(credentials));
    const result = db.prepare(`
      INSERT INTO clusters
        (name, connection_type, vip, auth_type, encrypted_credentials,
         polling_interval_minutes, ssl_verify, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name.trim(), connection_type, vip || null, auth_type, encryptedCreds,
      Number(polling_interval_minutes), ssl_verify ? 1 : 0, tags || ''
    );
    const cluster = db.prepare('SELECT * FROM clusters WHERE id = ?').get(result.lastInsertRowid);
    poller.getCohesityPoller(coreApi).schedule(cluster);
    const { encrypted_credentials: _, ...safeCluster } = cluster;
    res.status(201).json(safeCluster);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'A cluster with that name already exists' });
    }
    throw err;
  }
}

async function handlePostClustersTest(req, res, coreApi) {
  const b = req.body || {};
  const errors = validateClusterBody(b);
  if (b.ssl_verify !== undefined && !isBooleanish(b.ssl_verify) && typeof b.ssl_verify !== 'boolean') errors.push(vfail('ssl_verify'));
  if (errors.length) return badReq(res, errors);

  const { connection_type, vip, auth_type, credentials, ssl_verify = false } = b;
  if (connection_type === 'direct' && vip && isBlockedVip(vip)) {
    return res.status(400).json({ error: 'Invalid VIP address.' });
  }

  try {
    const result = await api.testClusterConnection({ connection_type, vip, auth_type, credentials, ssl_verify }, coreApi);
    return res.json(result);
  } catch (err) {
    const status = err.response?.status;
    let message = 'Connection failed.';
    if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
      message = 'Connection timed out.';
    } else if (status === 401 || status === 403) {
      message = 'Authentication failed. Check credentials.';
    } else if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'EHOSTUNREACH') {
      message = 'Cluster unreachable. Check the VIP/hostname.';
    } else if (status) {
      message = `Cluster returned an error (HTTP ${status}).`;
    }
    return res.json({ ok: false, error: message });
  }
}

function handlePutCluster(req, res, coreApi) {
  const id = reqIntParam(req, res);
  if (id === null) return;
  const b = req.body || {};
  const errors = validateClusterBody(b, { partial: true });
  if (errors.length) return badReq(res, errors);

  const db = coreApi.db;
  const existing = db.prepare('SELECT * FROM clusters WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Cluster not found' });

  const {
    name, connection_type, vip, auth_type, credentials,
    polling_interval_minutes, ssl_verify, tags
  } = b;

  const updatedType = connection_type !== undefined ? connection_type : existing.connection_type;
  const updatedVip = vip !== undefined ? vip : existing.vip;

  if (updatedType === 'direct' && updatedVip && isBlockedVip(updatedVip)) {
    return res.status(400).json({ error: 'Invalid VIP address.' });
  }

  const updatedName = name !== undefined ? name.trim() : existing.name;
  const updatedAuthType = auth_type !== undefined ? auth_type : existing.auth_type;
  const updatedInterval = polling_interval_minutes !== undefined ? Number(polling_interval_minutes) : existing.polling_interval_minutes;
  const updatedSslVerify = ssl_verify !== undefined ? (toBool(ssl_verify) ? 1 : 0) : existing.ssl_verify;
  const updatedCreds = credentials !== undefined ? coreApi.encryption.encrypt(JSON.stringify(credentials)) : existing.encrypted_credentials;
  const updatedTags = tags !== undefined ? tags : existing.tags;

  try {
    db.prepare(`
      UPDATE clusters SET
        name = ?, connection_type = ?, vip = ?, auth_type = ?,
        encrypted_credentials = ?, polling_interval_minutes = ?,
        ssl_verify = ?, tags = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(updatedName, updatedType, updatedVip, updatedAuthType, updatedCreds, updatedInterval, updatedSslVerify, updatedTags, id);

    if (credentials !== undefined) api.invalidateSession(Number(id));

    const updated = db.prepare('SELECT * FROM clusters WHERE id = ?').get(id);
    poller.getCohesityPoller(coreApi).schedule(updated);
    const { encrypted_credentials: _, ...safeCluster } = updated;
    res.json(safeCluster);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'A cluster with that name already exists' });
    }
    throw err;
  }
}

function handleDeleteCluster(req, res, coreApi) {
  const id = reqIntParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const existing = db.prepare('SELECT id FROM clusters WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Cluster not found' });

  db.prepare('DELETE FROM clusters WHERE id = ?').run(id);
  poller.getCohesityPoller(coreApi).cancel(Number(id));
  api.invalidateSession(Number(id));
  res.json({ success: true });
}

async function handleGetClusterStatus(req, res, coreApi) {
  const id = reqIntParam(req, res);
  if (id === null) return;
  const cluster = coreApi.db.prepare('SELECT * FROM clusters WHERE id = ?').get(id);
  if (!cluster) return res.status(404).json({ error: 'Cluster not found' });
  const data = await api.fetchClusterStatus(cluster, coreApi);
  res.json(data);
}

async function handleGetClusterHardware(req, res, coreApi) {
  const id = reqIntParam(req, res);
  if (id === null) return;
  const cluster = coreApi.db.prepare('SELECT * FROM clusters WHERE id = ?').get(id);
  if (!cluster) return res.status(404).json({ error: 'Cluster not found' });
  const data = await api.fetchNodes(cluster, coreApi);
  res.json(data);
}

// ── metrics ──────────────────────────────────────────────────────────────

function handleGetMetricsHistoryBatch(req, res, coreApi) {
  cache(res, 30);
  const daysQ = parseQueryInt(req.query.days, 1, 365);
  if (!daysQ.ok) return badReq(res, [vfail('days')]);
  const days = daysQ.value === undefined ? 7 : daysQ.value;

  const rows = coreApi.db.prepare(`
    SELECT id, cluster_id,
           strftime('%Y-%m-%dT%H:%M:%SZ', captured_at) as captured_at,
           total_capacity_bytes, used_bytes,
           logical_bytes, data_reduction_ratio, software_version, node_count
    FROM metrics_history
    WHERE captured_at >= datetime('now', ? || ' days')
    ORDER BY cluster_id ASC, captured_at ASC
  `).all(`-${days}`);

  const byCluster = {};
  for (const r of rows) {
    (byCluster[r.cluster_id] ||= []).push(r);
  }
  res.json(byCluster);
}

function handleGetMetricsHistory(req, res, coreApi) {
  cache(res, 30);
  const clusterId = reqIntParam(req, res, 'clusterId');
  if (clusterId === null) return;
  const daysQ = parseQueryInt(req.query.days, 1, 365);
  if (!daysQ.ok) return badReq(res, [vfail('days')]);
  const days = daysQ.value === undefined ? 7 : daysQ.value;

  const cluster = coreApi.db.prepare('SELECT id FROM clusters WHERE id = ?').get(clusterId);
  if (!cluster) return res.status(404).json({ error: 'Cluster not found' });

  const rows = coreApi.db.prepare(`
    SELECT id, cluster_id,
           strftime('%Y-%m-%dT%H:%M:%SZ', captured_at) as captured_at,
           total_capacity_bytes, used_bytes,
           logical_bytes, data_reduction_ratio, software_version, node_count
    FROM metrics_history
    WHERE cluster_id = ?
      AND captured_at >= datetime('now', ? || ' days')
    ORDER BY captured_at ASC
  `).all(clusterId, `-${days}`);
  res.json(rows);
}

async function handleGetMetricsDebugStats(req, res, coreApi) {
  const clusterId = reqIntParam(req, res, 'clusterId');
  if (clusterId === null) return;
  const cluster = coreApi.db.prepare('SELECT * FROM clusters WHERE id = ?').get(clusterId);
  if (!cluster) return res.status(404).json({ error: 'Cluster not found' });
  const info = await api.fetchClusterInfo(cluster, coreApi);
  res.json({
    clusterSoftwareVersion: info.clusterSoftwareVersion || info.softwareVersion,
    nodeCount: info.nodeCount,
    statsKeys: Object.keys(info.stats || {}),
    usagePerfStats: (info.stats || {}).usagePerfStats || null,
    topLevelKeys: Object.keys(info),
  });
}

// ── alerts ───────────────────────────────────────────────────────────────

function handleGetAlerts(req, res, coreApi) {
  cache(res, 20);
  const { clusterId, severity, resolved, dismissed } = req.query;
  const errors = [];
  if (clusterId !== undefined && !(Number.isInteger(parseIntStrict(clusterId)) && parseIntStrict(clusterId) >= 1)) errors.push(vfail('clusterId'));
  if (severity !== undefined && !['critical', 'warning', 'info', ''].includes(severity)) errors.push(vfail('severity'));
  if (resolved !== undefined && !['0', '1', 'true', 'false', ''].includes(resolved)) errors.push(vfail('resolved'));
  if (dismissed !== undefined && !['0', '1', 'true', 'false', ''].includes(dismissed)) errors.push(vfail('dismissed'));
  if (errors.length) return badReq(res, errors);

  let sql = `
    SELECT a.*, c.name AS cluster_name
    FROM alerts a
    JOIN clusters c ON a.cluster_id = c.id
    WHERE 1=1
  `;
  const params = [];
  if (clusterId) { sql += ' AND a.cluster_id = ?'; params.push(Number(clusterId)); }
  if (severity) { sql += ' AND a.severity = ?'; params.push(severity.toLowerCase()); }
  if (resolved !== undefined && resolved !== '') {
    sql += ' AND a.resolved = ?';
    params.push(resolved === '1' || resolved === 'true' ? 1 : 0);
  }
  if (dismissed !== undefined && dismissed !== '') {
    sql += ' AND a.dismissed = ?';
    params.push(dismissed === '1' || dismissed === 'true' ? 1 : 0);
  } else {
    sql += ' AND a.dismissed = 0';
  }
  sql += ' ORDER BY a.last_updated DESC LIMIT 500';

  res.json(coreApi.db.prepare(sql).all(...params));
}

function handlePostAlertDismiss(req, res, coreApi) {
  const id = reqIntParam(req, res);
  if (id === null) return;
  const db = coreApi.db;
  const alert = db.prepare('SELECT id FROM alerts WHERE id = ?').get(id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  db.prepare('UPDATE alerts SET dismissed = 1, last_updated = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  res.json({ success: true });
}

function resolveErrorResponse(res, err) {
  const status = err?.response?.status;
  if (status === 401 || status === 403) {
    return res.status(403).json({ error: 'The cluster account lacks permission to resolve alerts.' });
  }
  const detail = err?.response?.data?.message || err?.message || 'Failed to resolve alert on the cluster.';
  return res.status(502).json({ error: detail });
}

async function handlePostAlertResolve(req, res, coreApi) {
  const id = reqIntParam(req, res);
  if (id === null) return;
  const b = req.body || {};
  if (b.details !== undefined && !(typeof b.details === 'string' && b.details.length <= 500)) return badReq(res, [vfail('details')]);

  const db = coreApi.db;
  const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  if (alert.resolved) return res.json({ success: true, alreadyResolved: true });

  const cluster = db.prepare('SELECT * FROM clusters WHERE id = ?').get(alert.cluster_id);
  if (!cluster) return res.status(404).json({ error: 'Cluster not found' });

  const details = b.details || 'Resolved from ICC';
  try {
    await api.resolveAlerts(cluster, coreApi, [alert.cohesity_alert_id], details);
  } catch (err) {
    return resolveErrorResponse(res, err);
  }

  db.prepare("UPDATE alerts SET resolved = 1, last_updated = datetime('now') WHERE id = ?").run(id);
  res.json({ success: true });
}

async function handlePostAlertsResolveBulk(req, res, coreApi) {
  const b = req.body || {};
  if (!Array.isArray(b.ids) || b.ids.length === 0) return badReq(res, [vfail('ids')]);
  if (b.details !== undefined && !(typeof b.details === 'string' && b.details.length <= 500)) return badReq(res, [vfail('details')]);

  const db = coreApi.db;
  const ids = b.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return res.status(400).json({ error: 'ids must be a non-empty array of alert ids' });
  const details = b.details || 'Resolved from ICC';

  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM alerts WHERE id IN (${placeholders})`).all(...ids);

  const byCluster = new Map();
  for (const a of rows) {
    if (a.resolved) continue;
    if (!byCluster.has(a.cluster_id)) byCluster.set(a.cluster_id, []);
    byCluster.get(a.cluster_id).push(a);
  }

  const resolved = [];
  const failed = [];
  const markResolved = db.prepare("UPDATE alerts SET resolved = 1, last_updated = datetime('now') WHERE id = ?");
  for (const [clusterId, alerts] of byCluster) {
    const cluster = db.prepare('SELECT * FROM clusters WHERE id = ?').get(clusterId);
    if (!cluster) { alerts.forEach((a) => failed.push(a.id)); continue; }
    try {
      await api.resolveAlerts(cluster, coreApi, alerts.map((a) => a.cohesity_alert_id), details);
      for (const a of alerts) { markResolved.run(a.id); resolved.push(a.id); }
    } catch {
      alerts.forEach((a) => failed.push(a.id));
    }
  }
  res.json({ success: failed.length === 0, resolved, failed });
}

function handleGetAlertsAiStatus(req, res, coreApi) {
  res.json({ enabled: aiInsights ? !!aiInsights.isAiEnabled(coreApi) : false });
}

function handleGetAlertReview(req, res, coreApi) {
  const id = reqIntParam(req, res);
  if (id === null) return;
  res.json(aiInsights ? aiInsights.getCachedReview(id, coreApi) : null);
}

async function handlePostAlertReview(req, res, coreApi) {
  const id = reqIntParam(req, res);
  if (id === null) return;
  if (!aiInsights) {
    return res.status(503).json({ error: 'AI review is not available in this pack version.' });
  }
  const force = req.query.force === '1' || req.query.force === 'true';
  try {
    const review = await aiInsights.reviewAlert(id, { force }, coreApi);
    if (review === null) return res.status(404).json({ error: 'Alert not found' });
    res.json(review);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
}

// ── hardware ─────────────────────────────────────────────────────────────

async function handleGetHardware(req, res, coreApi) {
  const clusterId = reqIntParam(req, res, 'clusterId');
  if (clusterId === null) return;
  const cluster = coreApi.db.prepare('SELECT * FROM clusters WHERE id = ?').get(clusterId);
  if (!cluster) return res.status(404).json({ error: 'Cluster not found' });

  if (process.env.DASHBOARD_DEMO === '1') {
    const demoHardware = require('./hardwareFixtures');
    return res.json(demoHardware.getHardwareForCluster(cluster.id, cluster.name));
  }

  const [nodesResult, chassisResult, nodesV2Result] = await Promise.allSettled([
    api.fetchNodes(cluster, coreApi),
    api.fetchChassis(cluster, coreApi),
    api.fetchNodesV2(cluster, coreApi)
  ]);

  const nodes = nodesResult.status === 'fulfilled' ? nodesResult.value : [];
  const chassis = chassisResult.status === 'fulfilled' ? chassisResult.value : [];
  const nodesV2 = nodesV2Result.status === 'fulfilled' ? nodesV2Result.value : [];

  const v2ById = {};
  for (const n of nodesV2) {
    const nid = n.id ?? n.nodeId;
    if (nid != null) v2ById[String(nid)] = n;
  }
  const mergedNodes = nodes.map((node) => {
    const nid = String(node.id ?? node.nodeId ?? '');
    const v2 = v2ById[nid];
    if (!v2) return node;
    return {
      ...node,
      _v2Serial: v2.serialNumber || v2.serial || null,
      _v2Model: v2.hardwareModel || v2.model || null,
    };
  });

  res.json({ nodes: mergedNodes, chassis });
}

async function handlePostHardwareTrigger(req, res, coreApi) {
  const clusterId = reqIntParam(req, res, 'clusterId');
  if (clusterId === null) return;
  await poller.triggerPoll(clusterId, coreApi);
  res.json({ success: true, message: 'Poll triggered successfully' });
}

// ── helios ───────────────────────────────────────────────────────────────

async function handleGetHeliosClusters(req, res, coreApi) {
  const apiKey = coreApi.settings.getHeliosApiKey();
  if (!apiKey || apiKey === 'your_helios_api_key_here' || apiKey.length < 20) {
    return res.status(400).json({ error: 'Helios API key is not configured (Settings → Credentials, or HELIOS_API_KEY in .env).' });
  }
  const clusters = await api.heliosAllClusters(apiKey);
  const safe = clusters.map((c) => ({
    clusterId: c.clusterId,
    name: c.name,
    softwareVersion: c.softwareVersion,
    connectedToCluster: c.connectedToCluster
  }));
  res.json(safe);
}

// ── import ───────────────────────────────────────────────────────────────

/** Read the raw request body as text. A bundled plugin has no express.text()
 *  middleware of its own — the host's express.json() only consumes
 *  application/json bodies, so the raw stream is still readable here for
 *  text/csv. Capped at 10mb like the built-in's express.text({limit:'10mb'}). */
function readRawBody(req, limitBytes = 10 * 1024 * 1024) {
  if (typeof req.body === 'string') return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handlePostImportHistory(req, res, coreApi) {
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.includes('text/csv')) {
    return res.status(415).json({ error: 'Content-Type must be text/csv' });
  }

  let raw;
  try {
    raw = await readRawBody(req);
  } catch (err) {
    return res.status(err.status || 400).json({ error: 'Failed to read request body' });
  }

  const db = coreApi.db;
  const lines = (raw || '').split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '');

  if (lines.length < 2) {
    return res.status(400).json({ error: 'CSV must contain a header row and at least one data row' });
  }

  const headerLine = lines[0];
  const normalize = (s) => s.trim().toLowerCase().replace(/[\s_\-()]/g, '');
  const headers = headerLine.split(',').map(normalize);
  const fi = (fn) => headers.findIndex(fn);

  const idx = {
    timestamp: fi((h) => h === 'timestamp'),
    cluster: fi((h) => h === 'cluster'),
    physicalusedtb: fi((h) => h.startsWith('physicalused') || h === 'physicalusedtb'),
    clusterusagetb: fi((h) => h.startsWith('clusterusage') || h === 'clusterusagetb'),
    totalcapacitytb: fi((h) => h.startsWith('totalcapacity') || h === 'totalcapacitytb'),
    deduperatio: fi((h) => h.startsWith('dedup')),
    nodecount: fi((h) => h.startsWith('nodecount') || h === 'nodecount'),
  };

  const missing = Object.entries(idx).filter(([, v]) => v === -1).map(([k]) => k);
  if (missing.length > 0) {
    return res.status(400).json({ error: `Missing required columns: ${missing.join(', ')}` });
  }

  const overwrite = req.query.overwrite === 'true';

  const stmtCluster = db.prepare('SELECT id FROM clusters WHERE LOWER(name) = LOWER(?)');
  const stmtDupCheck = db.prepare('SELECT COUNT(*) as c FROM metrics_history WHERE cluster_id = ? AND captured_at = ?');
  const stmtDelete = db.prepare('DELETE FROM metrics_history WHERE cluster_id = ? AND captured_at = ?');
  const stmtInsert = db.prepare(`
    INSERT INTO metrics_history
      (cluster_id, captured_at, used_bytes, total_capacity_bytes, logical_bytes, data_reduction_ratio, node_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let imported = 0;
  let overwritten = 0;
  let skipped = 0;
  const unmatched = new Set();

  try {
    db.transaction(() => {
      for (let i = 1; i < lines.length; i++) {
        const fields = lines[i].split(',');

        const rawTs = fields[idx.timestamp]?.trim();
        const clusterName = fields[idx.cluster]?.trim();
        const physicalUsedTb = parseFloat(fields[idx.physicalusedtb]);
        const clusterUsageTb = parseFloat(fields[idx.clusterusagetb]);
        const totalCapacityTb = parseFloat(fields[idx.totalcapacitytb]);
        const dedupeRatio = parseFloat(fields[idx.deduperatio]);
        const nodeCount = parseInt(fields[idx.nodecount], 10);

        if (!rawTs || !clusterName) { skipped++; continue; }

        const d = new Date(rawTs);
        if (isNaN(d.getTime())) { skipped++; continue; }

        const pad = (n) => String(n).padStart(2, '0');
        const capturedAt = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

        const clusterRow = stmtCluster.get(clusterName);
        if (!clusterRow) {
          unmatched.add(clusterName);
          skipped++;
          continue;
        }

        const dup = stmtDupCheck.get(clusterRow.id, capturedAt);
        if (dup.c > 0) {
          if (!overwrite) { skipped++; continue; }
          stmtDelete.run(clusterRow.id, capturedAt);
          overwritten++;
        }

        stmtInsert.run(
          clusterRow.id,
          capturedAt,
          isNaN(clusterUsageTb) ? null : Math.round(clusterUsageTb * 1e12),
          isNaN(totalCapacityTb) ? null : Math.round(totalCapacityTb * 1e12),
          isNaN(physicalUsedTb) ? null : Math.round(physicalUsedTb * 1e12),
          isNaN(dedupeRatio) ? null : dedupeRatio,
          isNaN(nodeCount) ? null : nodeCount
        );
        imported++;
      }
    })();

    coreApi.logger.info(`CSV import: imported=${imported} overwritten=${overwritten} skipped=${skipped} unmatched=${[...unmatched].join(',')}`);
    return res.json({ imported, overwritten, skipped, unmatched: [...unmatched] });
  } catch (err) {
    coreApi.logger.error('CSV import error:', err);
    return res.status(500).json({ error: 'Import failed', detail: err.message });
  }
}

function handleGetImportDebug(req, res, coreApi) {
  const db = coreApi.db;
  const clusterRow = db.prepare('SELECT id, name FROM clusters WHERE LOWER(name) = LOWER(?)').get(req.params.clusterName);
  if (!clusterRow) return res.status(404).json({ error: 'Cluster not found' });

  const rows = db.prepare(`
    SELECT captured_at,
           ROUND(used_bytes / 1e12, 4) AS used_tb,
           ROUND(total_capacity_bytes / 1e12, 4) AS total_tb,
           ROUND(logical_bytes / 1e12, 4) AS logical_tb,
           ROUND(CAST(used_bytes AS REAL) / NULLIF(total_capacity_bytes, 0) * 100, 2) AS pct_used,
           data_reduction_ratio,
           node_count
    FROM metrics_history
    WHERE cluster_id = ?
    ORDER BY captured_at DESC
    LIMIT 10
  `).all(clusterRow.id);

  res.json({ cluster: clusterRow.name, rows });
}

// ── analytics ────────────────────────────────────────────────────────────

function handleGetAnalyticsClusters(req, res, coreApi) {
  res.json(coreApi.db.prepare('SELECT id, name FROM clusters ORDER BY name').all());
}

function handleGetAnalyticsProtectionRuns(req, res, coreApi) {
  cache(res, 30);
  const db = coreApi.db;
  const clusterId = req.query.clusterId ? parseInt(req.query.clusterId, 10) : null;
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);

  const clusterFilter = clusterId ? ' AND pr.cluster_id = ?' : '';
  const baseParams = clusterId ? [days, clusterId] : [days];

  const summaryRows = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN pr.status = 'kSuccess' THEN 1 ELSE 0 END) AS success,
      SUM(CASE WHEN pr.status IN ('kFailure', 'kFailed', 'kError', 'kCanceled', 'kCancelled') THEN 1 ELSE 0 END) AS failure,
      SUM(CASE WHEN pr.status = 'kWarning' THEN 1 ELSE 0 END) AS warning
    FROM protection_runs pr
    WHERE pr.start_time >= datetime('now', '-' || ? || ' days')
      ${clusterFilter}
  `).get(...baseParams);

  const total = summaryRows.total || 0;
  const success = summaryRows.success || 0;
  const failure = summaryRows.failure || 0;
  const warning = summaryRows.warning || 0;
  const successRate = total > 0 ? Math.round(((total - failure) / total) * 1000) / 10 : 0;

  const byDay = db.prepare(`
    SELECT
      date(pr.start_time) AS date,
      SUM(CASE WHEN pr.status = 'kSuccess' THEN 1 ELSE 0 END) AS success,
      SUM(CASE WHEN pr.status IN ('kFailure', 'kFailed', 'kError', 'kCanceled', 'kCancelled') THEN 1 ELSE 0 END) AS failure,
      SUM(CASE WHEN pr.status = 'kWarning' THEN 1 ELSE 0 END) AS warning
    FROM protection_runs pr
    WHERE pr.start_time >= datetime('now', '-' || ? || ' days')
      ${clusterFilter}
    GROUP BY date(pr.start_time)
    ORDER BY date(pr.start_time) ASC
  `).all(...baseParams);

  const topErrors = db.prepare(`
    SELECT
      pr.error_code AS errorCode,
      COALESCE(
        NULLIF(TRIM(pr.error_message), ''),
        NULLIF(TRIM(pr.error_code), ''),
        pr.status,
        'Unknown failure'
      ) AS errorMessage,
      COUNT(*) AS count,
      MAX(pr.start_time) AS lastSeen,
      c.name AS clusterName
    FROM protection_runs pr
    JOIN clusters c ON pr.cluster_id = c.id
    WHERE pr.start_time >= datetime('now', '-' || ? || ' days')
      AND pr.status IN ('kFailure', 'kFailed', 'kError', 'kCanceled', 'kCancelled')
      ${clusterFilter}
    GROUP BY errorMessage
    ORDER BY count DESC
    LIMIT 20
  `).all(...baseParams);

  const byCluster = db.prepare(`
    SELECT
      pr.cluster_id AS clusterId,
      c.name AS clusterName,
      COUNT(*) AS total,
      SUM(CASE WHEN pr.status IN ('kFailure', 'kFailed', 'kError', 'kCanceled', 'kCancelled') THEN 1 ELSE 0 END) AS failure,
      SUM(CASE WHEN pr.status = 'kSuccess' THEN 1 ELSE 0 END) AS successCount
    FROM protection_runs pr
    JOIN clusters c ON pr.cluster_id = c.id
    WHERE pr.start_time >= datetime('now', '-' || ? || ' days')
      ${clusterFilter}
    GROUP BY pr.cluster_id
    ORDER BY c.name ASC
  `).all(...baseParams).map((row) => ({
    clusterId: row.clusterId,
    clusterName: row.clusterName,
    total: row.total,
    failure: row.failure,
    successRate: row.total > 0 ? Math.round(((row.total - row.failure) / row.total) * 1000) / 10 : 0
  }));

  const runs = db.prepare(`
    SELECT
      pr.id,
      pr.job_name AS jobName,
      pr.status,
      pr.start_time AS startTime,
      pr.end_time AS endTime,
      pr.error_code AS errorCode,
      pr.error_message AS errorMessage,
      c.name AS clusterName
    FROM protection_runs pr
    JOIN clusters c ON pr.cluster_id = c.id
    WHERE pr.start_time >= datetime('now', '-' || ? || ' days')
      ${clusterFilter}
    ORDER BY pr.start_time DESC
    LIMIT 200
  `).all(...baseParams);

  const statusBreakdownRows = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN pr.status = 'kSuccess' THEN 1 ELSE 0 END) AS kSuccess,
      SUM(CASE WHEN pr.status IN ('kFailure', 'kFailed', 'kError', 'kCanceled', 'kCancelled') THEN 1 ELSE 0 END) AS kFailure,
      SUM(CASE WHEN pr.status = 'kWarning' THEN 1 ELSE 0 END) AS kWarning,
      SUM(CASE WHEN pr.status = 'kRunning' THEN 1 ELSE 0 END) AS kRunning,
      SUM(CASE WHEN pr.status NOT IN ('kSuccess', 'kFailure', 'kFailed', 'kError', 'kCanceled', 'kCancelled', 'kWarning', 'kRunning') THEN 1 ELSE 0 END) AS other
    FROM protection_runs pr
    WHERE pr.start_time >= datetime('now', '-' || ? || ' days')
      ${clusterFilter}
  `).get(...baseParams);

  const statusBreakdown = {
    kSuccess: statusBreakdownRows.kSuccess || 0,
    kFailure: statusBreakdownRows.kFailure || 0,
    kWarning: statusBreakdownRows.kWarning || 0,
    kRunning: statusBreakdownRows.kRunning || 0,
    other: statusBreakdownRows.other || 0
  };

  const jobAggRows = db.prepare(`
    SELECT
      pr.cluster_id AS clusterId,
      c.name AS clusterName,
      pr.job_id AS jobId,
      pr.job_name AS jobName,
      COUNT(*) AS totalRuns,
      SUM(CASE WHEN pr.status IN ('kFailure', 'kFailed', 'kError', 'kCanceled', 'kCancelled') THEN 1 ELSE 0 END) AS failedRuns,
      MAX(pr.start_time) AS lastRunTime,
      MAX(CASE WHEN pr.status = 'kSuccess' THEN pr.start_time ELSE NULL END) AS lastSuccessTime
    FROM protection_runs pr
    JOIN clusters c ON pr.cluster_id = c.id
    WHERE pr.start_time >= datetime('now', '-' || ? || ' days')
      ${clusterFilter}
    GROUP BY pr.cluster_id, pr.job_id
  `).all(...baseParams);

  const atRiskJobs = jobAggRows.map((job) => {
    const failureRate = job.totalRuns > 0 ? Math.round((job.failedRuns / job.totalRuns) * 1000) / 10 : 0;
    const hoursSinceLastSuccess = job.lastSuccessTime
      ? Math.max(0, Math.round((new Date() - new Date(job.lastSuccessTime)) / (1000 * 3600)))
      : null;

    const recentRuns = db.prepare(`
      SELECT pr.status
      FROM protection_runs pr
      WHERE pr.cluster_id = ? AND pr.job_id = ?
        AND pr.start_time >= datetime('now', '-' || ? || ' days')
      ORDER BY pr.start_time DESC
      LIMIT 100
    `).all(job.clusterId, job.jobId, days);

    let consecutiveFailures = 0;
    const failureStatuses = ['kFailure', 'kFailed', 'kError', 'kCanceled', 'kCancelled'];
    for (const run of recentRuns) {
      if (failureStatuses.includes(run.status)) consecutiveFailures++;
      else break;
    }

    const lastRunRow = db.prepare(`
      SELECT pr.status
      FROM protection_runs pr
      WHERE pr.cluster_id = ? AND pr.job_id = ?
        AND pr.start_time >= datetime('now', '-' || ? || ' days')
      ORDER BY pr.start_time DESC
      LIMIT 1
    `).get(job.clusterId, job.jobId, days);

    const lastStatus = lastRunRow ? lastRunRow.status : null;
    const riskScore = job.failedRuns * 2 + consecutiveFailures * 10 + (hoursSinceLastSuccess && hoursSinceLastSuccess >= 24 ? 20 : 0);

    return {
      clusterId: job.clusterId,
      clusterName: job.clusterName,
      jobId: job.jobId,
      jobName: job.jobName,
      totalRuns: job.totalRuns,
      failedRuns: job.failedRuns,
      failureRate,
      consecutiveFailures,
      lastStatus,
      lastRunTime: job.lastRunTime,
      lastSuccessTime: job.lastSuccessTime,
      hoursSinceLastSuccess,
      riskScore
    };
  }).sort((a, b) => b.riskScore - a.riskScore).slice(0, 50);

  const slaSummaryData = { totalJobs: 0, compliantJobs: 0, breachedJobs: 0, nearingBreachJobs: 0, complianceRate: 0 };
  const slaRiskJobsRaw = [];

  const allJobsForSLA = db.prepare(`
    SELECT DISTINCT
      pr.cluster_id AS clusterId,
      c.name AS clusterName,
      pr.job_id AS jobId,
      pr.job_name AS jobName
    FROM protection_runs pr
    JOIN clusters c ON pr.cluster_id = c.id
    WHERE pr.start_time >= datetime('now', '-' || ? || ' days')
      ${clusterFilter}
  `).all(...baseParams);

  for (const job of allJobsForSLA) {
    const jobRuns = db.prepare(`
      SELECT pr.start_time
      FROM protection_runs pr
      WHERE pr.cluster_id = ? AND pr.job_id = ?
        AND pr.start_time >= datetime('now', '-' || ? || ' days')
      ORDER BY pr.start_time DESC
      LIMIT 100
    `).all(job.clusterId, job.jobId, days);

    if (jobRuns.length === 0) continue;

    let expectedIntervalHours = 24;
    if (jobRuns.length >= 2) {
      const gaps = [];
      for (let i = 0; i < Math.min(jobRuns.length - 1, 10); i++) {
        const prev = new Date(jobRuns[i].start_time).getTime();
        const next = new Date(jobRuns[i + 1].start_time).getTime();
        const gapHours = (prev - next) / (1000 * 3600);
        if (gapHours > 0) gaps.push(gapHours);
      }
      if (gaps.length > 0) {
        expectedIntervalHours = Math.max(1, Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length * 10) / 10);
      }
    }

    const lastRunTime = new Date(jobRuns[0].start_time).getTime();
    const hoursSinceLastRun = Math.max(0, Math.round((new Date().getTime() - lastRunTime) / (1000 * 3600)));

    let slaState = 'compliant';
    if (hoursSinceLastRun > expectedIntervalHours * 1.5) slaState = 'breached';
    else if (hoursSinceLastRun > expectedIntervalHours * 1.2) slaState = 'nearing_breach';

    slaSummaryData.totalJobs++;
    if (slaState === 'compliant') slaSummaryData.compliantJobs++;
    else if (slaState === 'breached') slaSummaryData.breachedJobs++;
    else slaSummaryData.nearingBreachJobs++;

    slaRiskJobsRaw.push({
      clusterId: job.clusterId,
      clusterName: job.clusterName,
      jobId: job.jobId,
      jobName: job.jobName,
      lastRunTime: jobRuns[0].start_time,
      expectedIntervalHours,
      hoursSinceLastRun,
      slaState
    });
  }

  slaSummaryData.complianceRate = slaSummaryData.totalJobs > 0
    ? Math.round((slaSummaryData.compliantJobs / slaSummaryData.totalJobs) * 1000) / 10
    : 0;

  const slaRiskJobs = slaRiskJobsRaw.sort((a, b) => {
    const stateOrder = { breached: 3, nearing_breach: 2, compliant: 1 };
    if (stateOrder[a.slaState] !== stateOrder[b.slaState]) return stateOrder[b.slaState] - stateOrder[a.slaState];
    return b.hoursSinceLastRun - a.hoursSinceLastRun;
  }).slice(0, 50);

  const streakSummaryData = {
    jobsWith2PlusFailures: 0,
    jobsWith3PlusFailures: 0,
    jobsWith5PlusFailures: 0,
    maxConsecutiveFailures: 0
  };
  for (const job of atRiskJobs) {
    if (job.consecutiveFailures >= 2) streakSummaryData.jobsWith2PlusFailures++;
    if (job.consecutiveFailures >= 3) streakSummaryData.jobsWith3PlusFailures++;
    if (job.consecutiveFailures >= 5) streakSummaryData.jobsWith5PlusFailures++;
    streakSummaryData.maxConsecutiveFailures = Math.max(streakSummaryData.maxConsecutiveFailures, job.consecutiveFailures);
  }

  const runtimeAnomaliesRaw = [];
  const jobsWithRuntimeData = db.prepare(`
    SELECT
      pr.cluster_id AS clusterId,
      c.name AS clusterName,
      pr.job_id AS jobId,
      pr.job_name AS jobName,
      pr.start_time,
      pr.end_time
    FROM protection_runs pr
    JOIN clusters c ON pr.cluster_id = c.id
    WHERE pr.start_time >= datetime('now', '-' || ? || ' days')
      AND pr.end_time IS NOT NULL
      AND pr.start_time IS NOT NULL
      ${clusterFilter}
  `).all(...baseParams);

  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 3600 * 1000);
  const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 3600 * 1000);

  const jobRuntimes = {};
  for (const run of jobsWithRuntimeData) {
    const key = `${run.clusterId}|${run.jobId}`;
    if (!jobRuntimes[key]) {
      jobRuntimes[key] = { clusterId: run.clusterId, clusterName: run.clusterName, jobId: run.jobId, jobName: run.jobName, last24h: [], baseline: [] };
    }
    const startTime = new Date(run.start_time).getTime();
    const endTime = new Date(run.end_time).getTime();
    const runtimeSec = Math.max(0, (endTime - startTime) / 1000);
    if (startTime >= oneDayAgo.getTime()) jobRuntimes[key].last24h.push(runtimeSec);
    else if (startTime >= eightDaysAgo.getTime()) jobRuntimes[key].baseline.push(runtimeSec);
  }

  for (const [, data] of Object.entries(jobRuntimes)) {
    if (data.last24h.length > 0 && data.baseline.length > 0) {
      const avgLast24h = data.last24h.reduce((a, b) => a + b, 0) / data.last24h.length;
      const avgBaseline = data.baseline.reduce((a, b) => a + b, 0) / data.baseline.length;
      if (avgBaseline > 0) {
        const deltaPct = Math.round(((avgLast24h - avgBaseline) / avgBaseline) * 1000) / 10;
        if (deltaPct >= 50) {
          runtimeAnomaliesRaw.push({
            clusterId: data.clusterId,
            clusterName: data.clusterName,
            jobId: data.jobId,
            jobName: data.jobName,
            avgRuntimeLast24hSec: Math.round(avgLast24h),
            avgRuntimeBaselineSec: Math.round(avgBaseline),
            deltaPct,
            sampleCount: data.last24h.length
          });
        }
      }
    }
  }
  const runtimeAnomalies = runtimeAnomaliesRaw.sort((a, b) => b.deltaPct - a.deltaPct).slice(0, 30);

  const failureForecastData = { trend: 'flat', slopePerDay: 0, projectedFailuresNext7d: 0, avgDailyFailures: 0 };
  if (byDay.length >= 2) {
    const dataPoints = byDay.map((d, idx) => ({ x: idx, y: d.failure || 0 }));
    const n = dataPoints.length;
    const sumX = dataPoints.reduce((s, p) => s + p.x, 0);
    const sumY = dataPoints.reduce((s, p) => s + p.y, 0);
    const sumXY = dataPoints.reduce((s, p) => s + p.x * p.y, 0);
    const sumX2 = dataPoints.reduce((s, p) => s + p.x * p.x, 0);
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;

    failureForecastData.slopePerDay = Math.round(slope * 10) / 10;
    failureForecastData.avgDailyFailures = Math.round(sumY / n);
    if (Math.abs(slope) < 0.5) failureForecastData.trend = 'flat';
    else if (slope > 0) failureForecastData.trend = 'up';
    else failureForecastData.trend = 'down';

    let projectedTotal = 0;
    for (let i = 1; i <= 7; i++) projectedTotal += Math.max(0, slope * (n - 1 + i) + intercept);
    failureForecastData.projectedFailuresNext7d = Math.round(projectedTotal);
  }

  const alertCorrelationData = { correlatedFailedRuns: 0, totalFailedRuns: 0, correlationRate: 0, topAlertTypes: [] };
  const failedRunsRows = db.prepare(`
    SELECT pr.cluster_id AS clusterId, pr.start_time
    FROM protection_runs pr
    WHERE pr.start_time >= datetime('now', '-' || ? || ' days')
      AND pr.status IN ('kFailure', 'kFailed', 'kError', 'kCanceled', 'kCancelled')
      ${clusterFilter}
  `).all(...baseParams);

  const utcMs = (s) => Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');

  const alertsByCluster = new Map();
  for (const a of db.prepare('SELECT cluster_id AS clusterId, alert_type AS alertType, last_updated FROM alerts').all()) {
    const t = utcMs(a.last_updated);
    if (Number.isNaN(t)) continue;
    if (!alertsByCluster.has(a.clusterId)) alertsByCluster.set(a.clusterId, []);
    alertsByCluster.get(a.clusterId).push({ t, alertType: a.alertType });
  }
  for (const list of alertsByCluster.values()) list.sort((x, y) => x.t - y.t);

  const TWO_HOURS = 2 * 3600 * 1000;
  const failedRunsSet = new Set();
  const correlatedSet = new Set();
  const alertTypeMap = {};

  for (const row of failedRunsRows) {
    const runKey = `${row.clusterId}|${row.start_time}`;
    failedRunsSet.add(runKey);
    const list = alertsByCluster.get(row.clusterId);
    if (!list) continue;
    const t = utcMs(row.start_time);
    if (Number.isNaN(t)) continue;
    const loBound = Math.floor((t - TWO_HOURS) / 1000) * 1000;
    const hiBound = Math.floor((t + TWO_HOURS) / 1000) * 1000;
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].t < loBound) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < list.length && list[i].t <= hiBound; i++) {
      correlatedSet.add(runKey);
      alertTypeMap[list[i].alertType] = (alertTypeMap[list[i].alertType] || 0) + 1;
    }
  }

  alertCorrelationData.totalFailedRuns = failedRunsSet.size;
  alertCorrelationData.correlatedFailedRuns = correlatedSet.size;
  alertCorrelationData.correlationRate = alertCorrelationData.totalFailedRuns > 0
    ? Math.round((alertCorrelationData.correlatedFailedRuns / alertCorrelationData.totalFailedRuns) * 1000) / 10
    : 0;
  alertCorrelationData.topAlertTypes = Object.entries(alertTypeMap)
    .map(([alertType, count]) => ({ alertType, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  res.json({
    summary: { total, success, failure, warning, successRate },
    byDay, topErrors, byCluster, statusBreakdown, atRiskJobs, runs,
    slaSummary: slaSummaryData, slaRiskJobs, streakSummary: streakSummaryData,
    runtimeAnomalies, failureForecast: failureForecastData, alertCorrelation: alertCorrelationData
  });
}

function handleGetAnalyticsReplication(req, res, coreApi) {
  const db = coreApi.db;
  const clusterId = req.query.clusterId ? parseInt(req.query.clusterId, 10) : null;
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);

  const clusterFilter = clusterId ? ' AND rr.cluster_id = ?' : '';
  const baseParams = clusterId ? [days, clusterId] : [days];

  const summaryRow = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN rr.status IN ('kSuccess', 'kAccepted', 'kRunning') THEN 1 ELSE 0 END) AS success,
      SUM(CASE WHEN rr.status IN ('kFailed', 'kFailure', 'kCanceled', 'kCancelled', 'kError') THEN 1 ELSE 0 END) AS failure,
      SUM(COALESCE(rr.logical_bytes, 0)) AS totalBytesTransferred
    FROM replication_runs rr
    WHERE rr.start_time >= datetime('now', '-' || ? || ' days')
      ${clusterFilter}
  `).get(...baseParams);

  const total = summaryRow.total || 0;
  const success = summaryRow.success || 0;
  const failure = summaryRow.failure || 0;
  const successRate = total > 0 ? Math.round(((total - failure) / total) * 1000) / 10 : 0;
  const totalBytesTransferred = summaryRow.totalBytesTransferred || 0;

  const flows = db.prepare(`
    SELECT
      rr.cluster_id AS sourceClusterId,
      c.name AS sourceClusterName,
      rr.target_cluster_name AS targetClusterName,
      rr.target_cluster_id AS targetClusterId,
      COUNT(*) AS runCount,
      SUM(CASE WHEN rr.status IN ('kSuccess', 'kAccepted', 'kRunning') THEN 1 ELSE 0 END) AS successCount,
      SUM(CASE WHEN rr.status IN ('kFailed', 'kFailure', 'kCanceled', 'kCancelled', 'kError') THEN 1 ELSE 0 END) AS failureCount,
      SUM(COALESCE(rr.logical_bytes, 0)) AS totalBytesTransferred,
      AVG(rr.lag_seconds) AS avgLagSeconds,
      MAX(rr.start_time) AS lastSeen,
      SUM(CASE WHEN rr.status IN ('kAccepted','kRunning') AND rr.start_time <= datetime('now', '-2 hours') THEN 1 ELSE 0 END) AS longRunningCount,
      MAX(CASE WHEN rr.status IN ('kAccepted','kRunning') AND rr.start_time <= datetime('now', '-2 hours') THEN CAST((julianday('now') - julianday(rr.start_time)) * 86400 AS INTEGER) ELSE NULL END) AS oldestLongRunningSeconds
    FROM replication_runs rr
    JOIN clusters c ON rr.cluster_id = c.id
    WHERE rr.start_time >= datetime('now', '-' || ? || ' days')
      ${clusterFilter}
    GROUP BY rr.cluster_id, rr.target_cluster_id, rr.target_cluster_name
    ORDER BY totalBytesTransferred DESC
  `).all(...baseParams).map((row) => ({
    sourceClusterId: row.sourceClusterId,
    sourceClusterName: row.sourceClusterName,
    targetClusterName: row.targetClusterName,
    targetClusterId: row.targetClusterId,
    runCount: row.runCount,
    successCount: row.successCount,
    failureCount: row.failureCount,
    totalBytesTransferred: row.totalBytesTransferred,
    avgLagSeconds: row.avgLagSeconds != null ? Math.round(row.avgLagSeconds) : null,
    lastSeen: row.lastSeen,
    longRunningCount: row.longRunningCount || 0,
    oldestLongRunningSeconds: row.oldestLongRunningSeconds != null ? Math.round(row.oldestLongRunningSeconds) : null
  }));

  const byCluster = db.prepare(`
    SELECT
      rr.cluster_id AS clusterId,
      c.name AS clusterName,
      COUNT(DISTINCT rr.target_cluster_id) AS outboundFlows,
      SUM(COALESCE(rr.logical_bytes, 0)) AS totalBytes
    FROM replication_runs rr
    JOIN clusters c ON rr.cluster_id = c.id
    WHERE rr.start_time >= datetime('now', '-' || ? || ' days')
      ${clusterFilter}
    GROUP BY rr.cluster_id
    ORDER BY c.name ASC
  `).all(...baseParams);

  res.json({ summary: { total, success, failure, successRate, totalBytesTransferred }, flows, byCluster });
}

// ── replication status (live scan + cache) ──────────────────────────────

const replicationCache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000;

function readCacheFromDb(db, cacheKey) {
  try {
    const row = db.prepare(
      'SELECT cache_key, cluster_name, status_filter, days, num_runs_per_group, payload_json, scanning, error, updated_at FROM replication_status_cache WHERE cache_key = ?'
    ).get(cacheKey);
    if (!row) return null;
    return {
      cacheKey: row.cache_key,
      clusterName: row.cluster_name,
      statusFilter: row.status_filter,
      days: row.days,
      numRunsPerGroup: row.num_runs_per_group,
      payload: JSON.parse(row.payload_json),
      scanning: row.scanning === 1,
      error: row.error,
      updatedAt: new Date(row.updated_at).getTime()
    };
  } catch {
    return null;
  }
}

function upsertCacheToDb(db, cacheKey, clusterName, statusFilter, days, numRunsPerGroup, payload, scanning, error) {
  try {
    const payloadJson = JSON.stringify(payload);
    db.prepare(
      `INSERT INTO replication_status_cache
       (cache_key, cluster_name, status_filter, days, num_runs_per_group, payload_json, scanning, error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(cache_key) DO UPDATE SET
         payload_json = excluded.payload_json,
         scanning = excluded.scanning,
         error = excluded.error,
         updated_at = CURRENT_TIMESTAMP`
    ).run(cacheKey, clusterName, statusFilter, days, numRunsPerGroup, payloadJson, scanning ? 1 : 0, error || null);
  } catch { /* best-effort cache write */ }
}

async function runBackgroundScan(cluster, coreApi, cacheKey, statusFilter, days, numRunsPerGroup) {
  const db = coreApi.db;
  try {
    let protectionGroups = [];
    try {
      protectionGroups = await api.listProtectionGroupsV2(cluster, coreApi);
    } catch (err) {
      replicationCache.set(cacheKey, { ...replicationCache.get(cacheKey), scanning: false, error: err.message });
      const existing = readCacheFromDb(db, cacheKey);
      const existingPayload = existing?.payload || {};
      upsertCacheToDb(db, cacheKey, cluster.name, statusFilter, days, numRunsPerGroup, existingPayload, false, err.message);
      return;
    }

    const now = Date.now() * 1000;
    const startTimeUsecs = now - days * 86400 * 1e6;
    const endTimeUsecs = now;
    const BATCH_SIZE = 20;
    const replications = [];
    const totalGroupsScanned = protectionGroups.length;

    for (let i = 0; i < protectionGroups.length; i += BATCH_SIZE) {
      const batch = protectionGroups.slice(i, i + BATCH_SIZE);
      const promises = batch.map((group) =>
        api.getProtectionGroupRunsV2(cluster, coreApi, group.id, {
          startTimeUsecs, endTimeUsecs, numRuns: numRunsPerGroup
        }).catch(() => [])
      );
      const results = await Promise.allSettled(promises);
      results.forEach((result, idx) => {
        if (result.status === 'rejected') return;
        const runs = result.value || [];
        const group = batch[idx];
        runs.forEach((run) => {
          if (!run.replicationInfo || !run.replicationInfo.replicationTargetResults) return;
          run.replicationInfo.replicationTargetResults.forEach((target) => {
            if (statusFilter === 'active' && target.status !== 'Running') return;
            if (statusFilter === 'failed' && target.status !== 'Failed') return;
            let percentComplete = null;
            if (target.status === 'Succeeded') {
              percentComplete = 100;
            } else if (target.stats && target.stats.logicalSizeBytes && target.stats.logicalSizeBytes > 0) {
              const transferred = target.stats.logicalBytesTransferred || 0;
              percentComplete = Math.round((transferred / target.stats.logicalSizeBytes) * 10000) / 100;
            }
            replications.push({
              jobName: group.name,
              protectionGroupId: group.id,
              runId: run.id,
              runStartTimeUsecs: run.localBackupInfo?.startTimeUsecs,
              localBackupStatus: run.localBackupInfo?.status,
              targetCluster: target.clusterName,
              status: target.status,
              replicationStartTimeUsecs: target.startTimeUsecs,
              logicalSizeBytes: target.stats?.logicalSizeBytes,
              logicalBytesTransferred: target.stats?.logicalBytesTransferred,
              physicalBytesTransferred: target.stats?.physicalBytesTransferred,
              percentComplete
            });
          });
        });
      });
    }

    const groupsWithActiveReplication = new Set(replications.map((r) => r.protectionGroupId)).size;
    replications.sort((a, b) => {
      const aPercent = a.percentComplete ?? -1;
      const bPercent = b.percentComplete ?? -1;
      if (aPercent !== bPercent) return bPercent - aPercent;
      return (b.replicationStartTimeUsecs || 0) - (a.replicationStartTimeUsecs || 0);
    });

    const scanResult = {
      sourceCluster: cluster.name,
      generatedAt: new Date().toISOString(),
      totalGroupsScanned,
      groupsWithActiveReplication,
      replications
    };

    replicationCache.set(cacheKey, { data: scanResult, timestamp: Date.now(), scanning: false, error: null });
    upsertCacheToDb(db, cacheKey, cluster.name, statusFilter, days, numRunsPerGroup, scanResult, false, null);
  } catch (err) {
    const current = replicationCache.get(cacheKey);
    replicationCache.set(cacheKey, { ...current, scanning: false, error: err.message });
    const existing = readCacheFromDb(db, cacheKey);
    const existingPayload = existing?.payload || {};
    upsertCacheToDb(db, cacheKey, cluster.name, statusFilter, days, numRunsPerGroup, existingPayload, false, err.message);
  }
}

async function handleGetReplicationStatus(req, res, coreApi) {
  const db = coreApi.db;
  const clusterName = typeof req.query.clusterName === 'string' ? req.query.clusterName.trim() : '';
  const errors = [];
  if (!clusterName) errors.push(vfail('clusterName', 'clusterName is required'));
  if (req.query.statusFilter && !['active', 'failed', 'all'].includes(req.query.statusFilter)) errors.push(vfail('statusFilter', 'statusFilter must be active, failed, or all'));
  if (req.query.days) {
    const d = parseIntStrict(req.query.days);
    if (!Number.isInteger(d) || d < 1 || d > 90) errors.push(vfail('days', 'days must be 1-90'));
  }
  if (req.query.numRunsPerGroup) {
    const n = parseIntStrict(req.query.numRunsPerGroup);
    if (!Number.isInteger(n) || n < 1 || n > 200) errors.push(vfail('numRunsPerGroup', 'numRunsPerGroup must be 1-200'));
  }
  if (errors.length) return badReq(res, errors);

  const statusFilter = req.query.statusFilter || 'all';
  const days = parseInt(req.query.days) || 7;
  const numRunsPerGroup = parseInt(req.query.numRunsPerGroup) || 20;

  const cluster = db.prepare('SELECT * FROM clusters WHERE LOWER(name) = LOWER(?)').get(clusterName);
  if (!cluster) return res.status(404).json({ error: 'Cluster not found', clusterName });

  const cacheKey = `${clusterName}:${statusFilter}:${days}:${numRunsPerGroup}`;
  const now = Date.now();
  const dbCached = readCacheFromDb(db, cacheKey);

  if (process.env.DASHBOARD_DEMO === '1') {
    if (dbCached && dbCached.payload && dbCached.payload.replications) {
      const age = Math.round((now - dbCached.updatedAt) / 1000);
      return res.json({ ...dbCached.payload, scanning: false, cacheAgeSeconds: age });
    }
    return res.json({
      sourceCluster: clusterName, generatedAt: new Date().toISOString(),
      totalGroupsScanned: 0, groupsWithActiveReplication: 0, replications: [],
      scanning: false, cacheAgeSeconds: null
    });
  }

  const dbCacheExpired = !dbCached || (now - dbCached.updatedAt > CACHE_TTL_MS);
  if (dbCacheExpired) {
    const memCached = replicationCache.get(cacheKey);
    replicationCache.set(cacheKey, { ...(memCached || {}), scanning: true });
    const existingPayload = dbCached?.payload || {};
    upsertCacheToDb(db, cacheKey, clusterName, statusFilter, days, numRunsPerGroup, existingPayload, true, null);
    runBackgroundScan(cluster, coreApi, cacheKey, statusFilter, days, numRunsPerGroup);
  }

  const memCached = replicationCache.get(cacheKey);
  if (dbCached && dbCached.payload && dbCached.payload.replications) {
    const age = Math.round((now - dbCached.updatedAt) / 1000);
    return res.json({
      ...dbCached.payload,
      scanning: dbCached.scanning || (memCached && memCached.scanning) || false,
      cacheAgeSeconds: age
    });
  }

  return res.json({
    sourceCluster: clusterName, generatedAt: new Date().toISOString(),
    totalGroupsScanned: 0, groupsWithActiveReplication: 0, replications: [],
    scanning: true, cacheAgeSeconds: null
  });
}

// ── dashboard ────────────────────────────────────────────────────────────

function handleGetDashboardSnapshot(req, res, coreApi) {
  const { getDashboardSnapshot } = require('./snapshot');
  const snapshot = getDashboardSnapshot(coreApi);
  if (!snapshot) return res.status(503).json({ error: 'Snapshot unavailable.' });
  res.json(snapshot);
}

// ── poller trigger (backend/routes/pollerTrigger.js port) ──────────────

function handlePostPollerTrigger(req, res, coreApi) {
  const clusters = coreApi.db.prepare('SELECT * FROM clusters').all();
  (async () => {
    for (const c of clusters) {
      try { await poller.pollCluster(c, coreApi); } catch { /* pollCluster logs its own failures */ }
    }
  })();
  res.json({ started: clusters.length });
}

function handlePostPollerTriggerCluster(req, res, coreApi) {
  const clusterId = reqIntParam(req, res, 'clusterId');
  if (clusterId === null) return;
  const cluster = coreApi.db.prepare('SELECT * FROM clusters WHERE id = ?').get(clusterId);
  if (!cluster) return res.status(404).json({ error: 'Cluster not found.' });
  poller.pollCluster(cluster, coreApi).catch(() => {});
  res.json({ message: 'Poll triggered.' });
}

async function handleGetPollerProtectionGroupRunsTest(req, res, coreApi) {
  const {
    clusterName, jobId, entityName, numRuns = '50', scanMode, jobName,
    sourceClusterName, targetClusterName, startDate, endDate, debugRaw
  } = req.query;

  if (!clusterName) {
    return res.status(400).json({ error: 'clusterName query parameter is required.' });
  }

  const numRunsInt = Math.min(Math.max(parseInt(numRuns, 10) || 50, 1), 500);
  const isScanMode = scanMode === 'true';

  const cluster = coreApi.db.prepare('SELECT * FROM clusters WHERE LOWER(name) = LOWER(?)').get(clusterName);
  if (!cluster) {
    return res.status(404).json({ error: `Cluster '${clusterName}' not found.` });
  }

  const extractReplicationTargets = (run) => {
    if (run.replicationInfo && Array.isArray(run.replicationInfo.replicationTargetResults)) {
      return run.replicationInfo.replicationTargetResults;
    }
    if (Array.isArray(run.replicationRuns)) return run.replicationRuns;
    return [];
  };

  const extractReplicationStatuses = (run) => {
    const targets = extractReplicationTargets(run);
    if (targets.length > 0) return targets.map((t) => t.status).filter(Boolean);
    if (run.isReplicationRun && run.status) return [run.status];
    return [];
  };

  const hasReplicationSignals = (run) => {
    if (run.replicationInfo && Array.isArray(run.replicationInfo.replicationTargetResults) && run.replicationInfo.replicationTargetResults.length > 0) return true;
    if (Array.isArray(run.replicationRuns) && run.replicationRuns.length > 0) return true;
    if (run.isReplicationRun) return true;
    return false;
  };

  const matchesTargetCluster = (run, targetCluster) => {
    const targetLower = targetCluster.toLowerCase();
    const targets = extractReplicationTargets(run);
    if (targets.some((t) => (t.clusterName || '').toLowerCase().includes(targetLower))) return true;
    if (run.replicationInfo) {
      if (JSON.stringify(run.replicationInfo).toLowerCase().includes(targetLower)) return true;
    }
    return false;
  };

  const dateToUsecs = (dateStr) => {
    if (!dateStr) return null;
    const d = new Date(dateStr + 'T00:00:00Z');
    if (isNaN(d.getTime())) return null;
    return d.getTime() * 1000;
  };

  const matchesJobId = (fieldValue, jid) => {
    if (!jid || fieldValue == null) return false;
    const jobIdStr = String(jid);
    const fieldStr = String(fieldValue);
    if (fieldStr === jobIdStr) return true;
    const jobIdNum = parseInt(jid, 10);
    if (!isNaN(jobIdNum) && Number(fieldValue) === jobIdNum) return true;
    if (fieldStr.endsWith(':' + jobIdStr)) return true;
    return false;
  };

  if (isScanMode) {
    let protectionGroups = [];
    try {
      protectionGroups = await api.listProtectionGroupsV2(cluster, coreApi);
    } catch (err) {
      coreApi.logger.error('Failed to list protection groups:', err.message);
      return res.status(502).json({ error: 'Failed to fetch protection groups from cluster.' });
    }

    if (protectionGroups.length === 0) {
      return res.status(404).json({ error: 'No protection groups found on cluster.' });
    }

    const notes = [];
    const startUsecs = dateToUsecs(startDate);
    const endUsecs = dateToUsecs(endDate);

    const candidates = protectionGroups.filter((g) => {
      let matches = true;
      if (jobId) {
        const idMatch = matchesJobId(g.id, jobId) || matchesJobId(g.protectionGroupId, jobId) ||
          matchesJobId(g.legacyId, jobId) || matchesJobId(g.oldId, jobId);
        matches = matches && idMatch;
      }
      if (jobName) {
        const jobNameLower = jobName.toLowerCase();
        const nameMatch = (g.name && g.name.toLowerCase().includes(jobNameLower)) ||
          (g.protectionGroupName && g.protectionGroupName.toLowerCase().includes(jobNameLower)) ||
          JSON.stringify(g).toLowerCase().includes(jobNameLower);
        matches = matches && nameMatch;
      }
      return matches;
    });

    const matchedGroups = [];
    const groupReplicationStats = {};
    let totalGroupsWithRuns = 0;
    let totalGroupsWithReplication = 0;
    let totalGroupsMatchingTarget = 0;

    for (const group of candidates) {
      try {
        const runOptions = { numRuns: numRunsInt, includeObjectDetails: true };
        if (startUsecs) runOptions.startTimeUsecs = startUsecs;
        if (endUsecs) runOptions.endTimeUsecs = endUsecs;

        const runs = await api.getProtectionGroupRunsV2(cluster, coreApi, group.id, runOptions);
        const runsArray = Array.isArray(runs) ? runs : [];
        if (runsArray.length === 0) continue;

        totalGroupsWithRuns++;
        const hasReplicationInGroup = runsArray.some((run) => hasReplicationSignals(run));
        if (hasReplicationInGroup) totalGroupsWithReplication++;

        let matchesTarget = false;
        const replicationStatusSummary = {};
        if (targetClusterName) {
          matchesTarget = runsArray.some((run) => matchesTargetCluster(run, targetClusterName));
          if (matchesTarget) totalGroupsMatchingTarget++;
        }

        runsArray.forEach((run) => {
          const statuses = extractReplicationStatuses(run);
          statuses.forEach((status) => {
            const key = status || 'Unknown';
            replicationStatusSummary[key] = (replicationStatusSummary[key] || 0) + 1;
          });
        });

        if (matchedGroups.length < 20) {
          const entry = {
            id: group.id,
            name: group.name,
            runCount: runsArray.length,
            replicationStatusSummary,
            matchedTarget: matchesTarget ? targetClusterName : null,
            replicationTargetDetails: runsArray.flatMap((run) => extractReplicationTargets(run).map((t) => ({
              runId: run.id,
              clusterName: t.clusterName,
              status: t.status,
              startTimeUsecs: t.startTimeUsecs,
              logicalBytesTransferred: t.stats && t.stats.logicalBytesTransferred,
              physicalBytesTransferred: t.stats && t.stats.physicalBytesTransferred,
              logicalSizeBytes: t.stats && t.stats.logicalSizeBytes,
              percentComplete: (t.stats && t.stats.logicalSizeBytes > 0)
                ? parseFloat(((t.stats.logicalBytesTransferred / t.stats.logicalSizeBytes) * 100).toFixed(2))
                : null
            })))
          };
          if (debugRaw === 'true') {
            entry.rawRunSlices = runsArray.slice(0, 5).map((run) => ({
              id: run.id, status: run.status, isReplicationRun: run.isReplicationRun,
              localBackupInfo: run.localBackupInfo, replicationInfo: run.replicationInfo,
              replicationRuns: run.replicationRuns, archivalInfo: run.archivalInfo,
              cloudSpinInfo: run.cloudSpinInfo, originClusterIdentifier: run.originClusterIdentifier,
              allKeys: Object.keys(run)
            }));
          }
          matchedGroups.push(entry);
        }

        Object.entries(replicationStatusSummary).forEach(([status, count]) => {
          groupReplicationStats[status] = (groupReplicationStats[status] || 0) + count;
        });
      } catch (err) {
        coreApi.logger.error(`Failed to fetch runs for group ${group.id}:`, err.message);
        notes.push(`Partial data: Could not fetch runs for group ${group.id}`);
      }
    }

    res.json({
      scanMode: true,
      totalGroupsScanned: candidates.length,
      groupsWithRuns: totalGroupsWithRuns,
      groupsWithReplicationSignals: totalGroupsWithReplication,
      groupsMatchingTarget: targetClusterName ? totalGroupsMatchingTarget : null,
      matchedGroups,
      globalReplicationSummary: groupReplicationStats,
      filtersApplied: {
        clusterName, jobId: jobId || null, jobName: jobName || null,
        sourceClusterName: sourceClusterName || null, targetClusterName: targetClusterName || null,
        startDate: startDate || null, endDate: endDate || null,
        startDateUsecs: startUsecs, endDateUsecs: endUsecs, numRuns: numRunsInt
      },
      notes
    });
    return;
  }

  let protectionGroups = [];
  try {
    protectionGroups = await api.listProtectionGroupsV2(cluster, coreApi);
  } catch (err) {
    coreApi.logger.error('Failed to list protection groups:', err.message);
    return res.status(502).json({ error: 'Failed to fetch protection groups from cluster.' });
  }

  if (protectionGroups.length === 0) {
    return res.status(404).json({ error: 'No protection groups found on cluster.' });
  }

  let selectedGroup = null;
  let selectionMethod = 'fallback';

  if (jobId) {
    selectedGroup = protectionGroups.find((g) =>
      matchesJobId(g.id, jobId) || matchesJobId(g.protectionGroupId, jobId) ||
      matchesJobId(g.legacyId, jobId) || matchesJobId(g.oldId, jobId));
    if (selectedGroup) selectionMethod = 'jobId';
  }

  if (!selectedGroup && entityName) {
    const entityLower = entityName.toLowerCase();
    selectedGroup = protectionGroups.find((g) => {
      if (g.name && g.name.toLowerCase().includes(entityLower)) return true;
      if (g.protectionGroupName && g.protectionGroupName.toLowerCase().includes(entityLower)) return true;
      const groupJson = JSON.stringify(g).toLowerCase();
      if (groupJson.includes(entityLower)) return true;
      return false;
    });
    if (selectedGroup) selectionMethod = 'entityName';
  }

  if (!selectedGroup) {
    selectedGroup = protectionGroups[0];
    selectionMethod = 'fallback';
  }

  if (!selectedGroup.id) {
    return res.status(502).json({ error: 'Selected protection group has no valid ID.' });
  }

  let runs = [];
  try {
    runs = await api.getProtectionGroupRunsV2(cluster, coreApi, selectedGroup.id, {
      numRuns: numRunsInt, includeObjectDetails: true
    });
  } catch (err) {
    coreApi.logger.error('Failed to fetch protection group runs:', err.message);
    return res.status(502).json({ error: 'Failed to fetch protection group runs from cluster.' });
  }

  const totalRunsReturned = Array.isArray(runs) ? runs.length : 0;

  const replicationSummary = {};
  if (Array.isArray(runs)) {
    runs.forEach((run) => {
      const statuses = extractReplicationStatuses(run);
      statuses.forEach((status) => {
        const key = status || 'Unknown';
        replicationSummary[key] = (replicationSummary[key] || 0) + 1;
      });
    });
  }

  const sampleRuns = (Array.isArray(runs) ? runs.slice(0, 10) : []).map((run) => {
    const replicationStatuses = extractReplicationStatuses(run);
    const replicationTargets = extractReplicationTargets(run).map((t) => ({
      clusterName: t.clusterName, status: t.status, startTimeUsecs: t.startTimeUsecs, stats: t.stats
    }));
    return {
      id: run.id, protectionGroupId: run.protectionGroupId, protectionGroupName: run.protectionGroupName,
      isReplicationRun: run.isReplicationRun, startTimeUsecs: run.startTimeUsecs, endTimeUsecs: run.endTimeUsecs,
      status: run.status, replicationStatuses, replicationTargets
    };
  });

  const rawFieldHints = [];
  if (totalRunsReturned > 0) {
    const firstRun = Array.isArray(runs) ? runs[0] : null;
    if (firstRun) rawFieldHints.push(...Object.keys(firstRun).filter((k) => !k.startsWith('_')).slice(0, 15));
  }

  const candidateGroupsSample = selectionMethod === 'fallback'
    ? protectionGroups.slice(0, 10).map((g) => ({ id: g.id, name: g.name }))
    : undefined;

  res.json({
    selectedGroup: {
      id: selectedGroup.id, name: selectedGroup.name,
      legacyId: selectedGroup.legacyId || undefined, oldId: selectedGroup.oldId || undefined
    },
    selectionMethod,
    fallbackUsed: selectionMethod === 'fallback',
    totalRunsReturned,
    replicationSummary,
    sampleRuns,
    rawFieldHints,
    candidateGroupsSample,
    filtersApplied: { clusterName, jobId: jobId || null, entityName: entityName || null, numRuns: numRunsInt }
  });
}

// ── route table ──────────────────────────────────────────────────────────

const ROUTES = [
  // clusters
  { method: 'GET', ...compile('/clusters'), handler: handleGetClusters },
  { method: 'POST', ...compile('/clusters'), handler: handlePostClusters },
  { method: 'POST', ...compile('/clusters/test'), handler: handlePostClustersTest },
  { method: 'PUT', ...compile('/clusters/:id'), handler: handlePutCluster },
  { method: 'DELETE', ...compile('/clusters/:id'), handler: handleDeleteCluster },
  { method: 'GET', ...compile('/clusters/:id/status'), handler: handleGetClusterStatus },
  { method: 'GET', ...compile('/clusters/:id/hardware'), handler: handleGetClusterHardware },
  // metrics
  { method: 'GET', ...compile('/metrics/history-batch'), handler: handleGetMetricsHistoryBatch },
  { method: 'GET', ...compile('/metrics/:clusterId/history'), handler: handleGetMetricsHistory },
  { method: 'GET', ...compile('/metrics/:clusterId/debug-stats'), handler: handleGetMetricsDebugStats },
  // alerts
  { method: 'GET', ...compile('/alerts'), handler: handleGetAlerts },
  { method: 'POST', ...compile('/alerts/:id/dismiss'), handler: handlePostAlertDismiss },
  { method: 'POST', ...compile('/alerts/:id/resolve'), handler: handlePostAlertResolve },
  { method: 'POST', ...compile('/alerts/resolve'), handler: handlePostAlertsResolveBulk },
  { method: 'GET', ...compile('/alerts/ai/status'), handler: handleGetAlertsAiStatus },
  { method: 'GET', ...compile('/alerts/:id/review'), handler: handleGetAlertReview },
  { method: 'POST', ...compile('/alerts/:id/review'), handler: handlePostAlertReview },
  // hardware
  { method: 'GET', ...compile('/hardware/:clusterId'), handler: handleGetHardware },
  { method: 'POST', ...compile('/hardware/trigger/:clusterId'), handler: handlePostHardwareTrigger },
  // helios
  { method: 'GET', ...compile('/helios/clusters'), handler: handleGetHeliosClusters },
  // import
  { method: 'POST', ...compile('/import/history'), handler: handlePostImportHistory },
  { method: 'GET', ...compile('/import/debug/:clusterName'), handler: handleGetImportDebug },
  // analytics
  { method: 'GET', ...compile('/analytics/clusters'), handler: handleGetAnalyticsClusters },
  { method: 'GET', ...compile('/analytics/protection-runs'), handler: handleGetAnalyticsProtectionRuns },
  { method: 'GET', ...compile('/analytics/replication'), handler: handleGetAnalyticsReplication },
  // replication
  { method: 'GET', ...compile('/replication/status'), handler: handleGetReplicationStatus },
  // dashboard
  { method: 'GET', ...compile('/dashboard/snapshot'), handler: handleGetDashboardSnapshot },
  // poller triggers (WP0 alias shim rewrites legacy /api/poller/* to
  // '/poller' + req.url before dispatching, and the generic /api/:pluginId
  // dispatcher strips /api/cohesity leaving the same '/poller/...' shape)
  { method: 'POST', ...compile('/poller/trigger'), handler: handlePostPollerTrigger },
  { method: 'POST', ...compile('/poller/trigger/:clusterId'), handler: handlePostPollerTriggerCluster },
  { method: 'GET', ...compile('/poller/v2/protection-group-runs-test'), handler: handleGetPollerProtectionGroupRunsTest },
];

function createDataRouter(coreApi) {
  return function cohesityDataRouter(req, res, next) {
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

module.exports = { createDataRouter, ROUTES };
