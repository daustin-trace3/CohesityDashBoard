const axios = require('axios');

const HELIOS_BASE = 'https://helios.cohesity.com';

/**
 * Build an authenticated Helios axios client.
 */
function buildHeliosClient(apiKey) {
  return axios.create({
    baseURL: HELIOS_BASE,
    timeout: 30000,
    headers: { apiKey }
  });
}

/**
 * Get all clusters connected to Helios.
 * Returns array of { clusterId, name, softwareVersion, connectedToCluster, ... }
 */
async function heliosClusters(apiKey) {
  const client = buildHeliosClient(apiKey);
  const { data } = await client.get('/mcm/clusters/connectionStatus');
  const clusters = Array.isArray(data) ? data : [];
  return clusters.filter(c => c.connectedToCluster === true);
}

/**
 * Get all clusters from Helios (connected or not) for discovery.
 */
async function heliosAllClusters(apiKey) {
  const client = buildHeliosClient(apiKey);
  const { data } = await client.get('/mcm/clusters/connectionStatus');
  return Array.isArray(data) ? data : [];
}

/**
 * Get detailed cluster list from Helios v2.
 */
async function heliosClustersV2(apiKey) {
  const client = buildHeliosClient(apiKey);
  const { data } = await client.get('/v2/mcm/clusters');
  return data;
}

module.exports = { heliosClusters, heliosAllClusters, heliosClustersV2, buildHeliosClient };
