// Proxmox VE API client. Uses the API2 JSON REST interface with a PVE API
// token header (no session/CSRF). Self-signed certs are common — honor the
// per-server ssl_verify flag via https.Agent rejectUnauthorized. Every
// endpoint is individually failure-tolerant: under-privileged tokens 403 or
// return empty arrays, and parsers must treat both as "no data yet" rather
// than throwing (poll still succeeds with whatever it got).
const axios = require('axios');
const https = require('https');
const { decrypt } = require('./encryption');

function creds(server) {
  // Unsaved candidates (test connection) carry a plaintext tokenSecret;
  // registered rows carry the encrypted blob.
  if (server.tokenSecret) return { tokenSecret: server.tokenSecret };
  if (!server.encrypted_credentials) return { tokenSecret: null };
  const c = JSON.parse(decrypt(server.encrypted_credentials));
  return { tokenSecret: c.tokenSecret };
}

function client(server) {
  const { tokenSecret } = creds(server);
  const tokenId = server.tokenId || server.token_id;
  const sslVerify = server.sslVerify !== undefined ? server.sslVerify : server.ssl_verify;
  return axios.create({
    baseURL: `https://${server.host}:${server.port || 8006}/api2/json`,
    timeout: 30000,
    headers: tokenId && tokenSecret ? { Authorization: `PVEAPIToken=${tokenId}=${tokenSecret}` } : {},
    httpsAgent: new https.Agent({ rejectUnauthorized: !!sslVerify }),
  });
}

/** GET a Proxmox API path, returning the `.data` payload. 403s propagate to
 *  the caller (marked with `.pveForbidden = true`) so callers can distinguish
 *  "no permission" from other errors while still tolerating it. */
async function pveGet(server, path, params = {}) {
  try {
    const { data } = await client(server).get(path, { params });
    return data?.data;
  } catch (err) {
    if (err.response?.status === 403) {
      const e = new Error(err.response?.data?.message || 'Permission check failed');
      e.pveForbidden = true;
      throw e;
    }
    throw err;
  }
}

/** Best-effort GET: 403/any error -> fallback value (default null), never throws. */
async function pveGetSafe(server, path, params = {}, fallback = null) {
  try {
    const data = await pveGet(server, path, params);
    return data == null ? fallback : data;
  } catch {
    return fallback;
  }
}

const fetchVersion = (server) => pveGet(server, '/version');
const fetchNodes = (server) => pveGetSafe(server, '/nodes', {}, []);
const fetchNodeStatus = (server, node) => pveGetSafe(server, `/nodes/${node}/status`, {}, null);
const fetchQemu = (server, node) => pveGetSafe(server, `/nodes/${node}/qemu`, {}, []);
const fetchLxc = (server, node) => pveGetSafe(server, `/nodes/${node}/lxc`, {}, []);
const fetchNodeStorage = (server, node) => pveGetSafe(server, `/nodes/${node}/storage`, {}, []);
const fetchTasks = (server, node, limit = 200) => pveGetSafe(server, `/nodes/${node}/tasks`, { limit }, []);
const fetchClusterBackup = (server) => pveGetSafe(server, '/cluster/backup', {}, []);
const fetchCertificates = (server, node) => pveGetSafe(server, `/nodes/${node}/certificates/info`, {}, []);
const fetchSubscription = (server, node) => pveGetSafe(server, `/nodes/${node}/subscription`, {}, null);
const fetchAptUpdates = (server, node) => pveGetSafe(server, `/nodes/${node}/apt/update`, {}, []);
const fetchClusterResources = (server) => pveGetSafe(server, '/cluster/resources', {}, []);
const fetchClusterStatus = (server) => pveGetSafe(server, '/cluster/status', {}, []);

const fetchGuestConfig = (server, node, type, vmid) => pveGetSafe(server, `/nodes/${node}/${type}/${vmid}/config`, {}, null);
const fetchGuestSnapshots = (server, node, type, vmid) => pveGetSafe(server, `/nodes/${node}/${type}/${vmid}/snapshot`, {}, []);
const fetchAgentOsInfo = (server, node, vmid) => pveGetSafe(server, `/nodes/${node}/qemu/${vmid}/agent/get-osinfo`, {}, null);
const fetchAgentInterfaces = (server, node, vmid) => pveGetSafe(server, `/nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`, {}, null);
const fetchNodeServices = (server, node) => pveGetSafe(server, `/nodes/${node}/services`, {}, []);
const fetchNodeNetwork = (server, node) => pveGetSafe(server, `/nodes/${node}/network`, {}, []);
const fetchDisksList = (server, node) => pveGetSafe(server, `/nodes/${node}/disks/list`, {}, []);
const fetchStorageContent = (server, node, storage, content) => pveGetSafe(server, `/nodes/${node}/storage/${storage}/content`, { content }, []);
const fetchClusterLog = (server, max = 200) => pveGetSafe(server, '/cluster/log', { max }, []);
const fetchNodeRrdData = (server, node, timeframe = 'hour', cf = 'AVERAGE') => pveGetSafe(server, `/nodes/${node}/rrddata`, { timeframe, cf }, []);
const fetchGuestRrdData = (server, node, type, vmid, timeframe = 'hour', cf = 'AVERAGE') => pveGetSafe(server, `/nodes/${node}/${type}/${vmid}/rrddata`, { timeframe, cf }, []);

/** Validate a Proxmox server (saved row or unsaved candidate). Never throws. */
async function testConnection(serverLike) {
  try {
    const data = await fetchVersion(serverLike);
    return { ok: true, version: data?.version || null, release: data?.release || null };
  } catch (err) {
    const status = err.response?.status;
    return {
      ok: false,
      error: status === 401 || status === 403
        ? 'Authentication failed — check the token ID and secret.'
        : (err.response?.data?.message || err.message),
    };
  }
}

module.exports = {
  client, pveGet, pveGetSafe,
  fetchVersion, fetchNodes, fetchNodeStatus, fetchQemu, fetchLxc, fetchNodeStorage,
  fetchTasks, fetchClusterBackup, fetchCertificates, fetchSubscription, fetchAptUpdates,
  fetchClusterResources, fetchClusterStatus, testConnection,
  fetchGuestConfig, fetchGuestSnapshots, fetchAgentOsInfo, fetchAgentInterfaces,
  fetchNodeServices, fetchNodeNetwork, fetchDisksList, fetchStorageContent,
  fetchClusterLog, fetchNodeRrdData, fetchGuestRrdData,
};
