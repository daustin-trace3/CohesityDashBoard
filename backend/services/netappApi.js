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
  fetchSnapmirror,
  fetchLifs,
  fetchQuotas,
  fetchNfsClients,
  fetchExportPolicies,
  fetchCifsSessions,
  fetchCifsShares,
  testConnection,
  invalidate,
};
