// Rubrik Security Cloud API client.
//
// Auth is OAuth2 client-credentials: POST {client_id, client_secret} to
// <rsc-url>/api/client_token, which returns {client_id, access_token,
// expires_in} — a JWT, 12h on Doug's tenant. Everything else is a single
// GraphQL endpoint at <rsc-url>/api/graphql.
//
// Shapes below were confirmed against a live tenant (trace3.my.rubrik.com,
// 2026-08-05) rather than guessed from docs. No npm deps — the plugin sandbox
// cannot resolve the host's node_modules, so this uses global fetch (node 18+).

const tokenCache = new Map(); // connectionId -> { token, expiresAt }

function baseUrl(connection) {
  return String(connection.endpoint || '').replace(/\/+$/, '');
}

function credentials(coreApi, connection) {
  if (!connection.encrypted_credentials) {
    const e = new Error('No client secret stored for this connection.');
    e.code = 'RSC_NO_CREDENTIALS';
    throw e;
  }
  const parsed = JSON.parse(coreApi.encryption.decrypt(connection.encrypted_credentials));
  return { clientId: connection.identity, clientSecret: parsed.secret || parsed.tokenSecret };
}

/** Cached access token for a connection. Refreshed a minute before expiry. */
async function getToken(coreApi, connection) {
  const cached = tokenCache.get(connection.id);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const { clientId, clientSecret } = credentials(coreApi, connection);
  const res = await fetch(`${baseUrl(connection)}/api/client_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
  });
  const text = await res.text();
  if (!res.ok) {
    const e = new Error(`Token request failed: ${res.status} ${text.slice(0, 200)}`);
    e.code = res.status === 401 || res.status === 403 ? 'RSC_AUTH_FAILED' : 'RSC_TOKEN_FAILED';
    throw e;
  }
  let body;
  try { body = JSON.parse(text); } catch {
    const e = new Error('Token endpoint returned a non-JSON body.');
    e.code = 'RSC_TOKEN_FAILED';
    throw e;
  }
  const token = body.access_token || body.accessToken;
  if (!token) {
    const e = new Error('Token response contained no access_token.');
    e.code = 'RSC_TOKEN_FAILED';
    throw e;
  }
  const expiresIn = Number(body.expires_in || body.expiresIn || 3600);
  tokenCache.set(connection.id, { token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

function forgetToken(connectionId) {
  tokenCache.delete(connectionId);
}

/** One GraphQL round trip. Throws on transport errors AND on GraphQL errors. */
async function gql(coreApi, connection, query, variables) {
  const token = await getToken(coreApi, connection);
  const res = await fetch(`${baseUrl(connection)}/api/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  const text = await res.text();
  if (res.status === 401) {
    // Token rejected — drop it so the next call re-authenticates.
    forgetToken(connection.id);
    const e = new Error('RSC rejected the access token (401).');
    e.code = 'RSC_AUTH_FAILED';
    throw e;
  }
  let body;
  try { body = JSON.parse(text); } catch {
    const e = new Error(`GraphQL returned a non-JSON body (${res.status}).`);
    e.code = 'RSC_REQUEST_FAILED';
    throw e;
  }
  if (body.errors && body.errors.length) {
    const e = new Error(body.errors.map((x) => x.message).join('; ').slice(0, 300));
    e.code = 'RSC_QUERY_FAILED';
    throw e;
  }
  return body.data;
}

// ── Queries ──────────────────────────────────────────────────────────────
// `metric` is null for disconnected clusters, so every consumer must treat
// capacity as optional rather than assuming a number.
const CLUSTERS_QUERY = `{
  clusterConnection(first: 100) {
    nodes {
      id name status version type estimatedRunway snapshotCount lastConnectionTime
      clusterNodeConnection { count }
      metric { totalCapacity usedCapacity availableCapacity snapshotCapacity }
      state { connectedState }
    }
  }
}`;

const SLA_QUERY = `{
  slaDomains(first: 200) {
    nodes { id name ... on GlobalSlaReply { objectTypes protectedObjectCount } }
  }
}`;

const VMS_QUERY = `query Vms($after: String) {
  vSphereVmNewConnection(first: 200, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name objectType isRelic slaAssignment
      effectiveSlaDomain { name }
      cluster { id name }
      snapshotConnection(first: 1) { count }
      newestSnapshot { date }
    }
  }
}`;

const ACTIVITY_QUERY = `query Activity($after: String) {
  activitySeriesConnection(first: 200, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id objectName objectType clusterUuid
      lastActivityType lastActivityStatus severity lastUpdated startTime progress
    }
  }
}`;

async function fetchClusters(coreApi, connection) {
  const d = await gql(coreApi, connection, CLUSTERS_QUERY);
  return d?.clusterConnection?.nodes || [];
}

async function fetchSlaDomains(coreApi, connection) {
  const d = await gql(coreApi, connection, SLA_QUERY);
  return d?.slaDomains?.nodes || [];
}

/** Paginates so a big estate is not silently truncated at the first page. */
async function fetchAllPages(coreApi, connection, query, root, maxPages = 25) {
  const out = [];
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const d = await gql(coreApi, connection, query, { after });
    const conn = d?.[root];
    if (!conn) break;
    out.push(...(conn.nodes || []));
    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
    if (!after) break;
  }
  return out;
}

const fetchVms = (coreApi, connection) => fetchAllPages(coreApi, connection, VMS_QUERY, 'vSphereVmNewConnection');
const fetchActivity = (coreApi, connection) => fetchAllPages(coreApi, connection, ACTIVITY_QUERY, 'activitySeriesConnection', 5);

/** Credential check used by the Settings "Test" action. */
async function verifyCredentials(coreApi, connection) {
  try {
    const clusters = await fetchClusters(coreApi, connection);
    return {
      ok: true,
      clusters: clusters.length,
      connected: clusters.filter((c) => c.state?.connectedState === 'Connected').length,
    };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code || 'RSC_REQUEST_FAILED' };
  }
}

module.exports = {
  getToken, forgetToken, gql,
  fetchClusters, fetchSlaDomains, fetchVms, fetchActivity,
  verifyCredentials,
};
