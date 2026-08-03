// Proxmox VE API client. Uses the API2 JSON REST interface with a PVE API
// token header (no session/CSRF). Self-signed certs are common — honor the
// per-server ssl_verify flag via the request's rejectUnauthorized option.
// Every endpoint is individually failure-tolerant: under-privileged tokens
// 403 or return empty arrays, and parsers must treat both as "no data yet"
// rather than throwing (poll still succeeds with whatever it got).
//
// DEVIATION FROM THE BUILT-IN: the original (backend/services/proxmoxApi.js)
// uses axios, which is not available to a bundled plugin (esbuild has no
// axios to bundle from plugin-sdk's dependency tree). Re-implemented on
// Node's built-in `https` module with an equivalent GET-only JSON client.
// Behavior (return shapes, forbidden/error handling) is preserved exactly.
const https = require('https');
const { URLSearchParams } = require('url');

function creds(server, coreApi) {
  // Unsaved candidates (test connection) carry a plaintext tokenSecret;
  // registered rows carry the encrypted blob.
  if (server.tokenSecret) return { tokenSecret: server.tokenSecret };
  if (!server.encrypted_credentials) return { tokenSecret: null };
  const c = JSON.parse(coreApi.encryption.decrypt(server.encrypted_credentials));
  return { tokenSecret: c.tokenSecret };
}

/** Raw GET against a Proxmox server's API2 JSON endpoint. Resolves with the
 *  `.data` payload; rejects with an Error carrying `.response.status` (and
 *  `.pveForbidden = true` on 403) so callers can distinguish "no permission"
 *  from other errors while still tolerating it. */
function pveRawGet(server, coreApi, path, params = {}) {
  return new Promise((resolve, reject) => {
    const { tokenSecret } = creds(server, coreApi);
    const tokenId = server.tokenId || server.token_id;
    const sslVerify = server.sslVerify !== undefined ? server.sslVerify : server.ssl_verify;

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const query = qs.toString();
    const reqPath = `/api2/json${path}${query ? `?${query}` : ''}`;

    const req = https.request(
      {
        hostname: server.host,
        port: server.port || 8006,
        path: reqPath,
        method: 'GET',
        timeout: 30000,
        rejectUnauthorized: !!sslVerify,
        headers: tokenId && tokenSecret ? { Authorization: `PVEAPIToken=${tokenId}=${tokenSecret}` } : {},
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = raw ? JSON.parse(raw) : null; } catch { json = null; }
          const status = res.statusCode;
          if (status >= 200 && status < 300) {
            resolve(json?.data);
            return;
          }
          if (status === 403) {
            const e = new Error(json?.message || json?.data?.message || 'Permission check failed');
            e.pveForbidden = true;
            e.response = { status, data: json };
            reject(e);
            return;
          }
          const e = new Error(json?.message || json?.data?.message || `HTTP ${status}`);
          e.response = { status, data: json };
          reject(e);
        });
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', (err) => reject(err));
    req.end();
  });
}

/** GET a Proxmox API path, returning the `.data` payload. Errors propagate. */
async function pveGet(server, coreApi, path, params = {}) {
  return pveRawGet(server, coreApi, path, params);
}

/** Best-effort GET: 403/any error -> fallback value (default null), never throws. */
async function pveGetSafe(server, coreApi, path, params = {}, fallback = null) {
  try {
    const data = await pveGet(server, coreApi, path, params);
    return data == null ? fallback : data;
  } catch {
    return fallback;
  }
}

const fetchVersion = (server, coreApi) => pveGet(server, coreApi, '/version');
const fetchNodes = (server, coreApi) => pveGetSafe(server, coreApi, '/nodes', {}, []);
const fetchNodeStatus = (server, coreApi, node) => pveGetSafe(server, coreApi, `/nodes/${node}/status`, {}, null);
const fetchQemu = (server, coreApi, node) => pveGetSafe(server, coreApi, `/nodes/${node}/qemu`, {}, []);
const fetchLxc = (server, coreApi, node) => pveGetSafe(server, coreApi, `/nodes/${node}/lxc`, {}, []);
const fetchNodeStorage = (server, coreApi, node) => pveGetSafe(server, coreApi, `/nodes/${node}/storage`, {}, []);
const fetchTasks = (server, coreApi, node, limit = 200) => pveGetSafe(server, coreApi, `/nodes/${node}/tasks`, { limit }, []);
const fetchClusterBackup = (server, coreApi) => pveGetSafe(server, coreApi, '/cluster/backup', {}, []);
const fetchCertificates = (server, coreApi, node) => pveGetSafe(server, coreApi, `/nodes/${node}/certificates/info`, {}, []);
const fetchSubscription = (server, coreApi, node) => pveGetSafe(server, coreApi, `/nodes/${node}/subscription`, {}, null);
const fetchAptUpdates = (server, coreApi, node) => pveGetSafe(server, coreApi, `/nodes/${node}/apt/update`, {}, []);
const fetchClusterResources = (server, coreApi) => pveGetSafe(server, coreApi, '/cluster/resources', {}, []);
const fetchClusterStatus = (server, coreApi) => pveGetSafe(server, coreApi, '/cluster/status', {}, []);

const fetchGuestConfig = (server, coreApi, node, type, vmid) => pveGetSafe(server, coreApi, `/nodes/${node}/${type}/${vmid}/config`, {}, null);
const fetchGuestSnapshots = (server, coreApi, node, type, vmid) => pveGetSafe(server, coreApi, `/nodes/${node}/${type}/${vmid}/snapshot`, {}, []);
const fetchAgentOsInfo = (server, coreApi, node, vmid) => pveGetSafe(server, coreApi, `/nodes/${node}/qemu/${vmid}/agent/get-osinfo`, {}, null);
const fetchAgentInterfaces = (server, coreApi, node, vmid) => pveGetSafe(server, coreApi, `/nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`, {}, null);
const fetchNodeServices = (server, coreApi, node) => pveGetSafe(server, coreApi, `/nodes/${node}/services`, {}, []);
const fetchNodeNetwork = (server, coreApi, node) => pveGetSafe(server, coreApi, `/nodes/${node}/network`, {}, []);
const fetchDisksList = (server, coreApi, node) => pveGetSafe(server, coreApi, `/nodes/${node}/disks/list`, {}, []);
const fetchStorageContent = (server, coreApi, node, storage, content) => pveGetSafe(server, coreApi, `/nodes/${node}/storage/${storage}/content`, { content }, []);
const fetchClusterLog = (server, coreApi, max = 200) => pveGetSafe(server, coreApi, '/cluster/log', { max }, []);
const fetchNodeRrdData = (server, coreApi, node, timeframe = 'hour', cf = 'AVERAGE') => pveGetSafe(server, coreApi, `/nodes/${node}/rrddata`, { timeframe, cf }, []);
const fetchGuestRrdData = (server, coreApi, node, type, vmid, timeframe = 'hour', cf = 'AVERAGE') => pveGetSafe(server, coreApi, `/nodes/${node}/${type}/${vmid}/rrddata`, { timeframe, cf }, []);

/** Validate a Proxmox server (saved row or unsaved candidate). Never throws. */
async function testConnection(serverLike, coreApi) {
  try {
    const data = await fetchVersion(serverLike, coreApi);
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
  pveGet, pveGetSafe,
  fetchVersion, fetchNodes, fetchNodeStatus, fetchQemu, fetchLxc, fetchNodeStorage,
  fetchTasks, fetchClusterBackup, fetchCertificates, fetchSubscription, fetchAptUpdates,
  fetchClusterResources, fetchClusterStatus, testConnection,
  fetchGuestConfig, fetchGuestSnapshots, fetchAgentOsInfo, fetchAgentInterfaces,
  fetchNodeServices, fetchNodeNetwork, fetchDisksList, fetchStorageContent,
  fetchClusterLog, fetchNodeRrdData, fetchGuestRrdData,
};
