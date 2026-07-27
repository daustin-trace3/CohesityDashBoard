const axios = require('axios');
const https = require('https');
const { getSetting } = require('./settings');
const { decrypt } = require('./encryption');
const logger = require('../utils/logger');

// NetApp data is collected through Active IQ Unified Manager (AIQUM)'s API
// Gateway, which proxies ONTAP REST calls to each managed cluster using ONE
// AIQUM credential (no per-cluster registration).
//   Gateway URL: <aiqum>/api/gateways/{cluster_uuid}/<ontap-path>
// where <ontap-path> is the ONTAP REST path with the leading `/api` removed
// (so our fetcher path `/api/storage/volumes` -> `.../gateways/<uuid>/storage/volumes`).

/** Normalize a host into an https origin with no trailing slash. */
function normalizeHost(host) {
  let h = String(host || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(h)) h = `https://${h}`;
  return h;
}

function getPassword(array) {
  const creds = JSON.parse(decrypt(array.encrypted_credentials));
  if (!creds.password) {
    const err = new Error('No password stored for this NetApp cluster');
    err.code = 'NETAPP_NO_PASSWORD';
    throw err;
  }
  return creds.password;
}

/** Build an authenticated axios client for a direct-managed cluster. */
function clientFor(array, passwordOverride) {
  const password = passwordOverride != null ? passwordOverride : getPassword(array);
  return axios.create({
    baseURL: normalizeHost(array.mgmt_host),
    httpsAgent: new https.Agent({ rejectUnauthorized: !!array.ssl_verify }),
    timeout: 30000,
    auth: { username: array.username, password },
    headers: { accept: 'application/json' },
  });
}

/** AIQUM connection config: DB settings first, else .env fallback. */
function getAiqumConfig() {
  const host = getSetting('netapp_aiqum_host') || process.env.NETAPP_AIQUM_HOST || '';
  const username = getSetting('netapp_aiqum_user') || process.env.NETAPP_AIQUM_USER || '';
  let password = '';
  const stored = getSetting('netapp_aiqum_pass');
  if (stored) { try { password = decrypt(stored); } catch { password = ''; } }
  if (!password) password = process.env.NETAPP_AIQUM_PW || '';
  return { host: host ? normalizeHost(host) : '', username, password };
}

function aiqumConfigured() {
  const c = getAiqumConfig();
  return !!(c.host && c.username && c.password);
}

/** Axios client pointed at AIQUM (basic auth, self-signed cert tolerated). */
function aiqumClient(cfgOverride) {
  const c = cfgOverride && cfgOverride.host
    ? { host: normalizeHost(cfgOverride.host), username: cfgOverride.username, password: cfgOverride.password }
    : getAiqumConfig();
  if (!c.host || !c.username || !c.password) {
    const err = new Error('AIQUM is not configured (host/user/password)');
    err.code = 'AIQUM_NOT_CONFIGURED';
    throw err;
  }
  return axios.create({
    baseURL: c.host,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    timeout: 60000,
    auth: { username: c.username, password: c.password },
    headers: { accept: 'application/json' },
  });
}

/**
 * Authenticated GET against a cluster's ONTAP REST API. AIQUM-managed clusters
 * (source='aiqum' or carrying a cluster_uuid) go through the AIQUM gateway;
 * everything else is a direct cluster connection (basic auth, per-array creds).
 */
async function apiGet(array, path, params, passwordOverride) {
  if (array && (array.source === 'aiqum' || array.cluster_uuid)) {
    if (!array.cluster_uuid) {
      const err = new Error('Cluster has no AIQUM uuid'); err.code = 'NETAPP_NO_UUID'; throw err;
    }
    const client = aiqumClient();
    const ontapPath = String(path).replace(/^\/api/, '');
    const { data } = await client.get(`/api/gateways/${array.cluster_uuid}${ontapPath}`, { params });
    return data;
  }
  const client = clientFor(array, passwordOverride);
  const { data } = await client.get(path, { params });
  return data;
}

const records = (data) => (data && data.records) || [];

/** Clusters managed by AIQUM (discovery). */
async function fetchManagedClusters(cfgOverride) {
  const client = aiqumClient(cfgOverride);
  const { data } = await client.get('/api/datacenter/cluster/clusters', { params: { max_records: 1000 } });
  return (data.records || []).map((c) => ({
    uuid: c.uuid,
    name: c.name,
    version: (c.version && c.version.full) || null,
    management_ip: c.management_ip || null,
  }));
}

/** Validate AIQUM connectivity + credentials (used by the Settings test button). */
async function testAiqum(cfgOverride) {
  const clusters = await fetchManagedClusters(cfgOverride);
  return { ok: true, clusterCount: clusters.length, clusters: clusters.map((c) => c.name) };
}

// ── High-level fetchers ──────────────────────────────────────────────────────

async function fetchCluster(array) {
  return apiGet(array, '/api/cluster', { fields: 'name,version,management_interfaces' });
}

async function fetchNodes(array) {
  const data = await apiGet(array, '/api/cluster/nodes', { fields: 'name,model,serial_number,state,version', max_records: 1000 });
  return records(data);
}

async function fetchAggregates(array) {
  const data = await apiGet(array, '/api/storage/aggregates', {
    fields: 'name,node,state,space', max_records: 1000,
  });
  return records(data);
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

async function fetchVolumes(array) {
  try {
    const data = await apiGet(array, '/api/storage/volumes', {
      fields: VOLUME_FIELDS_FULL, max_records: 5000,
    });
    return records(data);
  } catch (err) {
    logger.warn(`[NetAppApi] extended volume fields rejected (${err.message}) — retrying with basic set`);
    const data = await apiGet(array, '/api/storage/volumes', {
      fields: 'name,svm,state,aggregates,space', max_records: 5000,
    });
    return records(data);
  }
}

async function fetchSvms(array) {
  const data = await apiGet(array, '/api/svm/svms', { fields: 'name,state', max_records: 1000 });
  return records(data);
}

async function fetchDisks(array) {
  const data = await apiGet(array, '/api/storage/disks', {
    fields: 'name,model,vendor,state,type,usable_size', max_records: 5000,
  });
  return records(data);
}

/** Cluster-wide performance (latest sample). */
async function fetchClusterMetrics(array) {
  const data = await apiGet(array, '/api/cluster/metrics', {
    fields: 'throughput,iops,latency,timestamp,status', max_records: 1, order_by: 'timestamp desc',
  });
  return records(data)[0] || null;
}

/** Health-subsystem alerts (the closest ONTAP equivalent to "open alerts"). */
async function fetchHealthAlerts(array) {
  try {
    const data = await apiGet(array, '/api/private/cli/system/health/alert', { max_records: 1000 });
    return records(data);
  } catch {
    return [];
  }
}

/** EMS error/alert/emergency events (recent), as a secondary alert source. */
async function fetchEmsAlerts(array) {
  try {
    const data = await apiGet(array, '/api/support/ems/events', {
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
async function fetchSnapmirror(array) {
  try {
    const data = await apiGet(array, '/api/snapmirror/relationships', {
      fields: 'source,destination,state,healthy,lag_time,transfer',
      max_records: 2000,
    });
    return records(data);
  } catch {
    return [];
  }
}

/** Logical interfaces (LIFs). */
async function fetchLifs(array) {
  try {
    const data = await apiGet(array, '/api/network/ip/interfaces', {
      fields: 'name,svm,ip,enabled,state,services,location',
      max_records: 2000,
    });
    return records(data);
  } catch {
    return [];
  }
}

/** Quota reports (capacity governance). */
async function fetchQuotas(array) {
  try {
    const data = await apiGet(array, '/api/storage/quota/reports', {
      fields: 'svm,volume,qtree,type,space,files',
      max_records: 5000,
    });
    return records(data);
  } catch {
    return [];
  }
}

/** Live NFS connected clients (client-to-volume map). */
async function fetchNfsClients(array) {
  try {
    const data = await apiGet(array, '/api/protocols/nfs/connected-clients', {
      fields: 'client_ip,server_ip,node,svm,volume,protocol',
      max_records: 5000,
    });
    return records(data);
  } catch {
    return [];
  }
}

/** NFS export policies (with rules describing permitted clients). */
async function fetchExportPolicies(array) {
  try {
    const data = await apiGet(array, '/api/protocols/nfs/export-policies', {
      fields: 'name,svm,rules',
      max_records: 2000,
    });
    return records(data);
  } catch {
    return [];
  }
}

/** Active CIFS/SMB sessions (live client-to-volume map). */
async function fetchCifsSessions(array) {
  try {
    const data = await apiGet(array, '/api/protocols/cifs/sessions', {
      fields: 'client_ip,server_ip,node,svm,volumes,user,mapped_unix_user,protocol,authentication,smb_encryption,smb_signing,open_shares,open_files,connected_duration,idle_duration',
      max_records: 5000,
    });
    return records(data);
  } catch {
    return [];
  }
}

/** CIFS/SMB shares (share -> volume mapping). */
async function fetchCifsShares(array) {
  try {
    const data = await apiGet(array, '/api/protocols/cifs/shares', {
      fields: 'name,path,svm,volume',
      max_records: 2000,
    });
    return records(data);
  } catch {
    return [];
  }
}

/**
 * Validate direct-cluster connectivity + credentials. Accepts a transient
 * object carrying a raw `password` (pre-save test flow) OR a stored array row
 * (encrypted_credentials, password omitted) whose password is decrypted here.
 */
async function testDirectConnection(array) {
  const password = array.password != null ? array.password : getPassword(array);
  const client = clientFor(array, password);
  const { data } = await client.get('/api/cluster', { params: { fields: 'name,version' } });
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
