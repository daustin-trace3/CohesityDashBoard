const axios = require('axios');
const https = require('https');
const { decrypt } = require('./encryption');
const { getHeliosApiKey } = require('./settings');

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
    const apiKey = credentials.apiKey || getHeliosApiKey();
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

const TEST_CONNECTION_TIMEOUT_MS = 15000;

/**
 * Test a cluster connection using plaintext credentials supplied directly
 * (no encrypt/decrypt round-trip, no session cache reads/writes). Used by
 * the "Test connection" flow before a cluster is saved.
 * config: { connection_type, vip, auth_type, credentials, ssl_verify }
 * Returns { ok: true, clusterName, softwareVersion } on success; throws on failure.
 */
async function testClusterConnection(config) {
  const { connection_type, vip, auth_type, credentials = {}, ssl_verify } = config;
  let client;

  if (connection_type === 'helios') {
    const apiKey = credentials.apiKey || getHeliosApiKey();
    const agent = new https.Agent({ rejectUnauthorized: true });
    client = axios.create({
      baseURL: 'https://helios.cohesity.com',
      httpsAgent: agent,
      timeout: TEST_CONNECTION_TIMEOUT_MS
    });
    client.defaults.headers.common['apiKey'] = apiKey;
    if (vip) {
      client.defaults.headers.common['accessClusterId'] = String(vip);
    }
  } else {
    const baseURL = `https://${vip}`;
    const agent = new https.Agent({ rejectUnauthorized: !!ssl_verify });

    if (auth_type === 'apikey') {
      client = axios.create({ baseURL, httpsAgent: agent, timeout: TEST_CONNECTION_TIMEOUT_MS });
      client.defaults.headers.common['apiKey'] = credentials.apiKey;
    } else {
      const loginResp = await axios.post(
        `${baseURL}/login`,
        {
          domain: credentials.domain || 'local',
          username: credentials.username,
          password: credentials.password
        },
        { httpsAgent: agent, timeout: TEST_CONNECTION_TIMEOUT_MS }
      );
      const { accessToken, tokenType } = loginResp.data;
      client = axios.create({ baseURL, httpsAgent: agent, timeout: TEST_CONNECTION_TIMEOUT_MS });
      client.defaults.headers.common['Authorization'] = `${tokenType} ${accessToken}`;
    }
  }

  const { data } = await client.get('/irisservices/api/v1/public/cluster?fetchStats=true');
  return {
    ok: true,
    clusterName: data.name || null,
    softwareVersion: data.clusterSoftwareVersion || data.softwareVersion || null
  };
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

const RETENTION_UNIT_DAYS = { Days: 1, Weeks: 7, Months: 30, Years: 365 };

/**
 * Fetch protection policies normalized to:
 *   { policyId, name, retentionDays, replicationTargets[], archivalTargets[], dataLock }
 * Tries the v2 API first, falls back to v1 for older clusters.
 */
async function fetchProtectionPolicies(cluster) {
  const client = await getAuthenticatedClient(cluster);
  try {
    const { data } = await client.get('/v2/data-protect/policies', { timeout: 60000 });
    const policies = Array.isArray(data) ? data : (data.policies || []);
    return policies.map(p => {
      const retention = p.backupPolicy?.regular?.retention || p.retention || {};
      const retentionDays = retention.duration != null
        ? retention.duration * (RETENTION_UNIT_DAYS[retention.unit] || 1)
        : null;
      const replicationTargets = (p.remoteTargetPolicy?.replicationTargets || [])
        .map(t => t.remoteTargetConfig?.clusterName || t.targetType || 'remote')
        .filter(Boolean);
      const archivalTargets = (p.remoteTargetPolicy?.archivalTargets || [])
        .map(t => t.targetName || t.targetType || 'archive')
        .filter(Boolean);
      return {
        policyId: String(p.id ?? ''),
        name: p.name || null,
        retentionDays,
        replicationTargets,
        archivalTargets,
        dataLock: !!(p.dataLock || retention.dataLockConfig),
      };
    });
  } catch (v2Err) {
    const { data } = await client.get('/irisservices/api/v1/public/protectionPolicy', { timeout: 60000 });
    const policies = Array.isArray(data) ? data : [];
    return policies.map(p => ({
      policyId: String(p.id ?? ''),
      name: p.name || null,
      retentionDays: p.daysToKeep ?? null,
      replicationTargets: (p.snapshotReplicationCopyPolicies || [])
        .map(c => c.target?.clusterName)
        .filter(Boolean),
      archivalTargets: (p.snapshotArchivalCopyPolicies || [])
        .map(c => c.target?.vaultName)
        .filter(Boolean),
      dataLock: !!p.wormRetentionType,
    }));
  }
}

/**
 * Fetch registered protection sources with protected/unprotected object stats.
 * One cheap call per cluster — stats come from registrationInfo aggregates.
 */
async function fetchSourceRegistrations(cluster) {
  const client = await getAuthenticatedClient(cluster);
  const { data } = await client.get(
    '/irisservices/api/v1/public/protectionSources/registrationInfo?allUnderHierarchy=true',
    { timeout: 120000 }
  );
  const rootNodes = data?.rootNodes || [];
  return rootNodes.map(n => {
    const root = n.rootNode || {};
    const stats = n.stats || {};
    return {
      sourceId: root.id ?? null,
      sourceName: root.name || null,
      environment: (root.environment || '').replace(/^k/, ''),
      protectedCount: stats.protectedCount ?? null,
      unprotectedCount: stats.unprotectedCount ?? null,
      protectedBytes: stats.protectedSize ?? null,
      unprotectedBytes: stats.unprotectedSize ?? null,
    };
  });
}

/**
 * Resolve (close out) one or more alerts on a cluster. Uses the v1 public
 * alertResolutions endpoint, which moves the alerts to kResolved. Works for
 * both direct and Helios-connected clusters via the authenticated client.
 * @param {object} cluster  cluster row
 * @param {string[]} alertIdList  Cohesity alert ids (cohesity_alert_id)
 * @param {string} resolutionDetails  free-text note stored on the resolution
 */
async function resolveAlerts(cluster, alertIdList, resolutionText = 'Resolved from Cohesity Dashboard') {
  const client = await getAuthenticatedClient(cluster);
  const text = String(resolutionText || 'Resolved from Cohesity Dashboard').slice(0, 1000);
  // The v1 public API expects `resolutionDetails` as an OBJECT with a short
  // summary plus longer details — a bare string is rejected with
  // "Error while parsing request body: invalid input parameters".
  const { data } = await client.post('/irisservices/api/v1/public/alertResolutions', {
    resolutionDetails: {
      resolutionSummary: text.slice(0, 128),
      resolutionDetails: text,
    },
    alertIdList: alertIdList.map(String),
  });
  return data;
}

/**
 * Fetch configured gflags from a direct-connected cluster. Private v1 API —
 * not available via Helios; returns only flags explicitly set on the cluster
 * (deviations from default), grouped by service.
 */
async function fetchGflags(cluster) {
  const client = await getAuthenticatedClient(cluster);
  const { data } = await client.get('/irisservices/api/v1/clusters/gflag');
  return data;
}

module.exports = {
  getAuthenticatedClient,
  invalidateSession,
  testClusterConnection,
  fetchProtectionPolicies,
  fetchSourceRegistrations,
  fetchClusterInfo,
  fetchNodes,
  fetchNodesV2,
  fetchAlerts,
  resolveAlerts,
  fetchGflags,
  fetchClusterStatus,
  fetchChassis,
  fetchProtectionRuns,
  fetchProtectionJobs,
  listProtectionGroupsV2,
  getProtectionGroupRunsV2
};
