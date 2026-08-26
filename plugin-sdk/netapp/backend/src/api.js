// NetApp ONTAP REST client. Ported from backend/services/netappApi.js.
//
// DEVIATION FROM THE BUILT-IN: the original uses axios, which is not
// available to a bundled plugin (esbuild has no axios to bundle from
// plugin-sdk's dependency tree). Re-implemented on Node's built-in `https`
// module (dell/unifi backend/src/api.js's rawRequest pattern) with basic-auth
// GET support. Every function now threads `coreApi` through for
// decrypt/settings/logging instead of requiring host modules directly.
// Behavior preserved verbatim: AIQUM gateway proxying
// (<aiqum>/api/gateways/{cluster_uuid}/<ontap-path>), direct-cluster basic
// auth, multi-gateway config resolution, extended-volume-fields fallback,
// and every best-effort fetcher's try/catch-to-[] shape.
const https = require('https');
const { URLSearchParams } = require('url');

/** Normalize a host into an https origin with no trailing slash. */
function normalizeHost(host) {
  let h = String(host || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(h)) h = `https://${h}`;
  return h;
}

/** Raw HTTPS GET against a basic-auth JSON API. Resolves with parsed JSON.
 *  Rejects with an Error carrying `.response = { status, data }`. */
function rawGet(baseUrl, path, { params, username, password, rejectUnauthorized, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(path, baseUrl);
    } catch (err) {
      reject(err);
      return;
    }
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    for (const [k, v] of qs.entries()) url.searchParams.set(k, v);

    const headers = { accept: 'application/json' };
    if (username != null) {
      headers.authorization = `Basic ${Buffer.from(`${username}:${password || ''}`).toString('base64')}`;
    }

    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        timeout,
        rejectUnauthorized: !!rejectUnauthorized,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const status = res.statusCode;
          const str = raw.toString('utf8');
          let payload;
          try { payload = str ? JSON.parse(str) : null; } catch { payload = str || null; }
          if (status >= 200 && status < 300) {
            resolve(payload);
            return;
          }
          const e = new Error(`HTTP ${status}`);
          e.response = { status, data: payload };
          reject(e);
        });
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', (err) => reject(err));
    req.end();
  });
}

function getPassword(array, coreApi) {
  const creds = JSON.parse(coreApi.encryption.decrypt(array.encrypted_credentials));
  if (!creds.password) {
    const err = new Error('No password stored for this NetApp cluster');
    err.code = 'NETAPP_NO_PASSWORD';
    throw err;
  }
  return creds.password;
}

/** All configured AIQUM gateway rows (multi-gateway since netapp v5). */
function aiqumInstances(coreApi) {
  try {
    return coreApi.db.prepare('SELECT * FROM netapp_aiqum_instances ORDER BY id').all();
  } catch { return []; }
}

/** Decrypted connection config for one gateway row. */
function instanceConfig(row, coreApi) {
  let password = '';
  try { password = coreApi.encryption.decrypt(row.encrypted_credentials); } catch { password = ''; }
  return { host: normalizeHost(row.host), username: row.username, password };
}

/**
 * Legacy singleton config (app_settings / .env) — kept as the fallback when no
 * gateway rows exist so pre-v5 deployments keep working; v5 migrates settings
 * into a row automatically, env-only setups are seeded at poller init.
 */
function getAiqumConfig(coreApi) {
  const rows = aiqumInstances(coreApi);
  if (rows.length) return instanceConfig(rows[0], coreApi);
  const host = coreApi.settings.getSetting('netapp_aiqum_host') || process.env.NETAPP_AIQUM_HOST || '';
  const username = coreApi.settings.getSetting('netapp_aiqum_user') || process.env.NETAPP_AIQUM_USER || '';
  let password = '';
  const stored = coreApi.settings.getSetting('netapp_aiqum_pass');
  if (stored) { try { password = coreApi.encryption.decrypt(stored); } catch { password = ''; } }
  if (!password) password = process.env.NETAPP_AIQUM_PW || '';
  return { host: host ? normalizeHost(host) : '', username, password };
}

function aiqumConfigured(coreApi) {
  if (aiqumInstances(coreApi).length) return true;
  const c = getAiqumConfig(coreApi);
  return !!(c.host && c.username && c.password);
}

/** Gateway config for a discovered array — its own instance, else the first. */
function configForArray(array, coreApi) {
  const rows = aiqumInstances(coreApi);
  if (array?.aiqum_instance_id != null) {
    const own = rows.find((r) => r.id === array.aiqum_instance_id);
    if (own) return instanceConfig(own, coreApi);
  }
  if (rows.length) return instanceConfig(rows[0], coreApi);
  return getAiqumConfig(coreApi);
}

function aiqumGet(cfgOverride, coreApi, path, params) {
  const c = cfgOverride && cfgOverride.host
    ? { host: normalizeHost(cfgOverride.host), username: cfgOverride.username, password: cfgOverride.password }
    : getAiqumConfig(coreApi);
  if (!c.host || !c.username || !c.password) {
    const err = new Error('AIQUM is not configured (host/user/password)');
    err.code = 'AIQUM_NOT_CONFIGURED';
    throw err;
  }
  return rawGet(c.host, path, {
    params, username: c.username, password: c.password, rejectUnauthorized: false, timeout: 60000,
  });
}

/**
 * Authenticated GET against a cluster's ONTAP REST API. AIQUM-managed clusters
 * (source='aiqum' or carrying a cluster_uuid) go through the AIQUM gateway;
 * everything else is a direct cluster connection (basic auth, per-array creds).
 */
async function apiGet(array, coreApi, path, params, passwordOverride) {
  if (array && (array.source === 'aiqum' || array.cluster_uuid)) {
    if (!array.cluster_uuid) {
      const err = new Error('Cluster has no AIQUM uuid'); err.code = 'NETAPP_NO_UUID'; throw err;
    }
    const cfg = configForArray(array, coreApi);
    const ontapPath = String(path).replace(/^\/api/, '');
    return aiqumGet(cfg, coreApi, `/api/gateways/${array.cluster_uuid}${ontapPath}`, params);
  }
  const password = passwordOverride != null ? passwordOverride : getPassword(array, coreApi);
  return rawGet(normalizeHost(array.mgmt_host), path, {
    params, username: array.username, password, rejectUnauthorized: !!array.ssl_verify, timeout: 30000,
  });
}

const records = (data) => (data && data.records) || [];

/**
 * Collection GET that follows ONTAP pagination. ONTAP stops collecting after
 * return_timeout (default 15s) and returns a partial page + _links.next with
 * HTTP 200, so a single apiGet silently drops records on large clusters.
 */
async function apiGetAll(array, coreApi, path, params) {
  const out = [];
  let data = await apiGet(array, coreApi, path, { return_timeout: 25, ...params });
  out.push(...records(data));
  let next = data && data._links && data._links.next && data._links.next.href;
  let pages = 1;
  while (next && pages < 200) {
    pages += 1;
    data = next.startsWith("/api/gateways/")
      ? await aiqumGet(configForArray(array, coreApi), coreApi, next)
      : await apiGet(array, coreApi, next);
    out.push(...records(data));
    next = data && data._links && data._links.next && data._links.next.href;
  }
  return out;
}

/** Clusters managed by AIQUM (discovery). */
async function fetchManagedClusters(cfgOverride, coreApi) {
  const data = await aiqumGet(cfgOverride, coreApi, '/api/datacenter/cluster/clusters', { max_records: 1000 });
  return (data.records || []).map((c) => ({
    uuid: c.uuid,
    name: c.name,
    version: (c.version && c.version.full) || null,
    management_ip: c.management_ip || null,
  }));
}

/** Validate AIQUM connectivity + credentials (used by the Settings test button). */
async function testAiqum(cfgOverride, coreApi) {
  const clusters = await fetchManagedClusters(cfgOverride, coreApi);
  return { ok: true, clusterCount: clusters.length, clusters: clusters.map((c) => c.name) };
}

// ── High-level fetchers ──────────────────────────────────────────────────────

async function fetchCluster(array, coreApi) {
  return apiGet(array, coreApi, '/api/cluster', { fields: 'name,version,management_interfaces' });
}

async function fetchNodes(array, coreApi) {
  return await apiGetAll(array, coreApi, '/api/cluster/nodes', { fields: 'name,model,serial_number,state,version', max_records: 1000 });
}

async function fetchAggregates(array, coreApi) {
  return await apiGetAll(array, coreApi, '/api/storage/aggregates', {
    fields: 'name,node,state,space', max_records: 1000,
  });
}

// Extended detail first; older ONTAP versions can 400 on unknown field names
// (e.g. anti_ransomware pre-9.10), so fall back to the basic list on error.
const VOLUME_FIELDS_FULL = [
  'name', 'svm', 'state', 'aggregates', 'space',
  'type', 'style', 'comment', 'create_time', 'is_svm_root',
  'nas.path', 'nas.security_style', 'nas.export_policy.name',
  'snapshot_policy.name', 'guarantee.type', 'autosize.mode', 'autosize.maximum',
  'files', 'snaplock.type', 'encryption.enabled', 'anti_ransomware.state',
  'qos.policy.name', 'tiering.policy', 'quota.state', 'error_state.is_inconsistent',
  'metric',
].join(',');

async function fetchVolumes(array, coreApi) {
  try {
    return await apiGetAll(array, coreApi, '/api/storage/volumes', {
      fields: VOLUME_FIELDS_FULL, max_records: 5000,
    });
  } catch (err) {
    coreApi.logger.warn(`[NetAppApi] extended volume fields rejected (${err.message}) — retrying with basic set`);
    return await apiGetAll(array, coreApi, '/api/storage/volumes', {
      fields: 'name,svm,state,aggregates,space', max_records: 5000,
    });
  }
}

async function fetchSvms(array, coreApi) {
  return await apiGetAll(array, coreApi, '/api/svm/svms', { fields: 'name,state', max_records: 1000 });
}

async function fetchDisks(array, coreApi) {
  return await apiGetAll(array, coreApi, '/api/storage/disks', {
    fields: 'name,model,vendor,state,type,usable_size', max_records: 5000,
  });
}

/** Cluster-wide performance (latest sample). */
async function fetchClusterMetrics(array, coreApi) {
  const data = await apiGet(array, coreApi, '/api/cluster/metrics', {
    fields: 'throughput,iops,latency,timestamp,status', max_records: 1, order_by: 'timestamp desc',
  });
  return records(data)[0] || null;
}

/** Health-subsystem alerts (the closest ONTAP equivalent to "open alerts"). */
async function fetchHealthAlerts(array, coreApi) {
  try {
    const data = await apiGet(array, coreApi, '/api/private/cli/system/health/alert', { max_records: 1000 });
    return records(data);
  } catch {
    return [];
  }
}

/** EMS error/alert/emergency events (recent), as a secondary alert source. */
async function fetchEmsAlerts(array, coreApi) {
  try {
    const data = await apiGet(array, coreApi, '/api/support/ems/events', {
      'message.severity': 'error|alert|emergency',
      fields: 'message,time,node,index',
      max_records: 200,
      order_by: 'index desc',
    });
    return records(data);
  } catch {
    return [];
  }
}

/** SnapMirror relationships (DR replication). */
async function fetchSnapmirror(array, coreApi) {
  try {
    return await apiGetAll(array, coreApi, '/api/snapmirror/relationships', {
      fields: 'source,destination,state,healthy,lag_time,transfer',
      max_records: 2000,
    });
  } catch {
    return [];
  }
}

/** Logical interfaces (LIFs). */
async function fetchLifs(array, coreApi) {
  try {
    return await apiGetAll(array, coreApi, '/api/network/ip/interfaces', {
      fields: 'name,svm,ip,enabled,state,services,location',
      max_records: 2000,
    });
  } catch {
    return [];
  }
}

/** Quota reports (capacity governance). */
async function fetchQuotas(array, coreApi) {
  try {
    return await apiGetAll(array, coreApi, '/api/storage/quota/reports', {
      fields: 'svm,volume,qtree,type,space,files',
      max_records: 5000,
    });
  } catch {
    return [];
  }
}

/** Live NFS connected clients (client-to-volume map). */
async function fetchNfsClients(array, coreApi) {
  try {
    return await apiGetAll(array, coreApi, '/api/protocols/nfs/connected-clients', {
      fields: 'client_ip,server_ip,node,svm,volume,protocol',
      max_records: 5000,
    });
  } catch {
    return [];
  }
}

/** NFS export policies (with rules describing permitted clients). */
async function fetchExportPolicies(array, coreApi) {
  try {
    return await apiGetAll(array, coreApi, '/api/protocols/nfs/export-policies', {
      fields: 'name,svm,rules',
      max_records: 2000,
    });
  } catch {
    return [];
  }
}

/** Active CIFS/SMB sessions (live client-to-volume map). */
async function fetchCifsSessions(array, coreApi) {
  try {
    return await apiGetAll(array, coreApi, '/api/protocols/cifs/sessions', {
      fields: 'client_ip,server_ip,node,svm,volumes,user,mapped_unix_user,protocol,authentication,smb_encryption,smb_signing,open_shares,open_files,connected_duration,idle_duration',
      max_records: 5000,
    });
  } catch {
    return [];
  }
}

/** CIFS/SMB shares (share -> volume mapping). */
async function fetchCifsShares(array, coreApi) {
  try {
    return await apiGetAll(array, coreApi, '/api/protocols/cifs/shares', {
      fields: 'name,path,svm,volume',
      max_records: 2000,
    });
  } catch {
    return [];
  }
}

/**
 * Validate direct-cluster connectivity + credentials. Accepts a transient
 * object carrying a raw `password` (pre-save test flow) OR a stored array row
 * (encrypted_credentials, password omitted) whose password is decrypted here.
 */
async function testDirectConnection(array, coreApi) {
  const password = array.password != null ? array.password : getPassword(array, coreApi);
  const data = await rawGet(normalizeHost(array.mgmt_host), '/api/cluster', {
    params: { fields: 'name,version' },
    username: array.username, password, rejectUnauthorized: !!array.ssl_verify, timeout: 30000,
  });
  return {
    ok: true,
    name: data.name || null,
    version: (data.version && data.version.full) || null,
  };
}

function invalidate() { /* no session cache for basic auth */ }

module.exports = {
  normalizeHost,
  getPassword,
  getAiqumConfig,
  aiqumConfigured,
  aiqumInstances,
  instanceConfig,
  fetchManagedClusters,
  testAiqum,
  apiGet,
  fetchCluster,
  fetchNodes,
  fetchAggregates,
  fetchVolumes,
  fetchSvms,
  fetchDisks,
  fetchClusterMetrics,
  fetchHealthAlerts,
  fetchEmsAlerts,
  fetchSnapmirror,
  fetchLifs,
  fetchQuotas,
  fetchNfsClients,
  fetchExportPolicies,
  fetchCifsSessions,
  fetchCifsShares,
  testDirectConnection,
  invalidate,
};
