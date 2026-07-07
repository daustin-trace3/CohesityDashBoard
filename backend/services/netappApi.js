const axios = require('axios');
const https = require('https');
const { decrypt } = require('./encryption');

// NetApp ONTAP REST client (basic auth over HTTPS to the cluster mgmt LIF).
// No token exchange is needed — credentials are sent per request.

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

/** Build an authenticated axios client for the cluster. */
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

/** Authenticated GET against the ONTAP REST API. */
async function apiGet(array, path, params, passwordOverride) {
  const client = clientFor(array, passwordOverride);
  const { data } = await client.get(path, { params });
  return data;
}

const records = (data) => (data && data.records) || [];

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

async function fetchVolumes(array) {
  const data = await apiGet(array, '/api/storage/volumes', {
    fields: 'name,svm,state,aggregates,space', max_records: 5000,
  });
  return records(data);
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

/**
 * Validate connectivity + credentials. Accepts a stored array row OR a transient
 * object carrying a raw `password` (pre-save test flow).
 */
async function testConnection(array) {
  const password = array.password != null ? array.password : undefined;
  const cluster = await apiGet(array, '/api/cluster', { fields: 'name,version' }, password);
  return {
    ok: true,
    clusterName: cluster.name || null,
    ontapVersion: (cluster.version && cluster.version.full) || null,
  };
}

function invalidate() { /* no session cache for basic auth */ }

module.exports = {
  normalizeHost,
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
  testConnection,
  invalidate,
};
