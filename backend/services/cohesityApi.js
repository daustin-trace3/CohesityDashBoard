const axios = require('axios');
const https = require('https');
const { decrypt } = require('./encryption');

// In-memory session cache for userpass auth: clusterId -> { token, tokenType, expiresAt }
const sessionCache = new Map();
const SESSION_TTL_MS = 20 * 60 * 1000; // 20 minutes
const MAX_SESSION_CACHE = 200;

function buildAxiosInstance(baseURL, sslVerify = false) {
  const agent = new https.Agent({ rejectUnauthorized: !!sslVerify });
  return axios.create({
    baseURL,
    httpsAgent: agent,
    timeout: 30000
  });
}

/**
 * Get or create an authenticated axios instance for a cluster.
 * cluster object: { id, connection_type, vip, auth_type, encrypted_credentials }
 */
async function getAuthenticatedClient(cluster) {
  const credentials = JSON.parse(decrypt(cluster.encrypted_credentials));

  if (cluster.connection_type === 'helios') {
    const apiKey = credentials.apiKey || process.env.HELIOS_API_KEY;
    const client = buildAxiosInstance('https://helios.cohesity.com', true); // Helios uses a valid CA cert
    client.defaults.headers.common['apiKey'] = apiKey;
    // cluster.vip stores the Helios numeric cluster ID for this cluster
    if (cluster.vip) {
      client.defaults.headers.common['accessClusterId'] = String(cluster.vip);
    }
    return client;
  }

  // Direct connection
  const baseURL = `https://${cluster.vip}`;

  if (cluster.auth_type === 'apikey') {
    const client = buildAxiosInstance(baseURL, cluster.ssl_verify);
    client.defaults.headers.common['apiKey'] = credentials.apiKey;
    return client;
  }

  // userpass auth — check session cache
  const cached = sessionCache.get(cluster.id);
  if (cached && Date.now() < cached.expiresAt) {
    const client = buildAxiosInstance(baseURL, cluster.ssl_verify);
    client.defaults.headers.common['Authorization'] =
      `${cached.tokenType} ${cached.token}`;
    return client;
  }

  // Authenticate and cache
  const loginAgent = new https.Agent({ rejectUnauthorized: !!cluster.ssl_verify });
  const loginResp = await axios.post(
    `${baseURL}/login`,
    {
      domain: credentials.domain || 'local',
      username: credentials.username,
      password: credentials.password
    },
    { httpsAgent: loginAgent, timeout: 30000 }
  );

  const { accessToken, tokenType } = loginResp.data;
  if (sessionCache.size >= MAX_SESSION_CACHE) {
    const firstKey = sessionCache.keys().next().value;
    sessionCache.delete(firstKey);
  }
  sessionCache.set(cluster.id, {
    token: accessToken,
    tokenType,
    expiresAt: Date.now() + SESSION_TTL_MS
  });

  const client = buildAxiosInstance(baseURL, cluster.ssl_verify);
  client.defaults.headers.common['Authorization'] = `${tokenType} ${accessToken}`;
  return client;
}

/**
 * Invalidate session cache for a cluster (e.g., on credential update).
 */
function invalidateSession(clusterId) {
  sessionCache.delete(clusterId);
}

/**
 * Fetch cluster info (v1 public/cluster endpoint).
 */
async function fetchClusterInfo(cluster) {
  const client = await getAuthenticatedClient(cluster);
  const { data } = await client.get('/irisservices/api/v1/public/cluster?fetchStats=true');
  return data;
}

/**
 * Fetch nodes / hardware info.
 */
async function fetchNodes(cluster) {
  const client = await getAuthenticatedClient(cluster);
  const { data } = await client.get('/irisservices/api/v1/public/nodes');
  return data;
}

/**
 * Fetch active alerts.
 */
async function fetchAlerts(cluster) {
  const client = await getAuthenticatedClient(cluster);
  const { data } = await client.get(
    '/irisservices/api/v1/public/alerts?maxAlerts=100&alertStateList=kOpen'
  );
  return data;
}

async function fetchChassis(cluster) {
  const client = await getAuthenticatedClient(cluster);
  try {
    const { data } = await client.get('/v2/chassis');
    return Array.isArray(data) ? data : (data.chassis || []);
  } catch {
    return [];
  }
}

/**
 * Fetch nodes via V2 API (has serialNumber, hardwareModel at top level).
 */
async function fetchNodesV2(cluster) {
  const client = await getAuthenticatedClient(cluster);
  try {
    const { data } = await client.get('/v2/nodes');
    return Array.isArray(data) ? data : (data.nodes || []);
  } catch {
    return [];
  }
}

/**
 * Fetch cluster status.
 */
async function fetchClusterStatus(cluster) {
  return fetchClusterInfo(cluster);
}

/**
 * Fetch protection runs (v1 public/protectionRuns endpoint).
 */
async function fetchProtectionRuns(cluster, numRuns = 100, startTimeUsecs = null, endTimeUsecs = null, jobId = null) {
  const client = await getAuthenticatedClient(cluster);
  const params = new URLSearchParams({ numRuns });
  if (startTimeUsecs) params.append('startTimeUsecs', startTimeUsecs);
  if (endTimeUsecs) params.append('endTimeUsecs', endTimeUsecs);
  if (jobId !== null) params.append('jobId', jobId);
  const { data } = await client.get(`/irisservices/api/v1/public/protectionRuns?${params}`, { timeout: 120000 });
  return data || [];
}

async function fetchProtectionJobs(cluster) {
  const client = await getAuthenticatedClient(cluster);
  const { data } = await client.get('/irisservices/api/v1/public/protectionJobs', { timeout: 120000 });
  return Array.isArray(data) ? data : [];
}

/**
 * List protection groups via v2 API.
 * Options: { startIndex, pageSize, filter }
 */
async function listProtectionGroupsV2(cluster, options = {}) {
  const client = await getAuthenticatedClient(cluster);
  const params = new URLSearchParams();
  if (options.startIndex !== undefined) params.append('startIndex', options.startIndex);
  if (options.pageSize !== undefined) params.append('pageSize', options.pageSize);
  if (options.filter) params.append('filter', options.filter);
  const queryString = params.toString();
  const url = `/v2/data-protect/protection-groups${queryString ? '?' + queryString : ''}`;
  const { data } = await client.get(url, { timeout: 120000 });
  return Array.isArray(data) ? data : (data.protectionGroups || []);
}

/**
 * Fetch protection group runs via v2 API.
 * Options: { startTimeUsecs, endTimeUsecs, numRuns, includeObjectDetails, filterByEndTime, useCachedData }
 */
async function getProtectionGroupRunsV2(cluster, protectionGroupId, options = {}) {
  const client = await getAuthenticatedClient(cluster);
  const params = new URLSearchParams();
  if (options.startTimeUsecs !== undefined) params.append('startTimeUsecs', options.startTimeUsecs);
  if (options.endTimeUsecs !== undefined) params.append('endTimeUsecs', options.endTimeUsecs);
  if (options.numRuns !== undefined) params.append('numRuns', options.numRuns);
  if (options.includeObjectDetails !== undefined) params.append('includeObjectDetails', options.includeObjectDetails);
  if (options.filterByEndTime !== undefined) params.append('filterByEndTime', options.filterByEndTime);
  if (options.useCachedData !== undefined) params.append('useCachedData', options.useCachedData);
  const queryString = params.toString();
  const url = `/v2/data-protect/protection-groups/${protectionGroupId}/runs${queryString ? '?' + queryString : ''}`;
  const { data } = await client.get(url, { timeout: 120000 });
  return Array.isArray(data) ? data : (data.runs || []);
}

module.exports = {
  getAuthenticatedClient,
  invalidateSession,
  fetchClusterInfo,
  fetchNodes,
  fetchNodesV2,
  fetchAlerts,
  fetchClusterStatus,
  fetchChassis,
  fetchProtectionRuns,
  fetchProtectionJobs,
  listProtectionGroupsV2,
  getProtectionGroupRunsV2
};
