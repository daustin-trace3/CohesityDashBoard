// Nutanix Move v2 API client. Standalone appliance, own local user DB — not
// part of Prism. JWT bearer auth via /move/v2/users/login (classic, works
// 3.x-6.x) with fallback to the newer form-encoded /move/v2/token endpoint.
// Token TTL ~15 min — re-auth transparently on 401 mid-poll.
//
// DEVIATION FROM THE BUILT-IN: the original (backend/services/nutanixMoveApi.js)
// uses axios; re-implemented on Node's built-in `https` module. Login/token
// refresh and 401-retry-once behavior is preserved exactly.
const https = require('https');
const { URLSearchParams } = require('url');

const tokens = new Map(); // conn.id -> { token, fetchedAt }
const TOKEN_TTL_MS = 13 * 60 * 1000; // refresh a bit before the 15-min expiry

function creds(conn, coreApi) {
  if (conn.password != null) return { username: conn.username, password: conn.password };
  if (!conn.encrypted_credentials) return { username: conn.username, password: null };
  try {
    const c = JSON.parse(coreApi.encryption.decrypt(conn.encrypted_credentials));
    return { username: conn.username, password: c.password };
  } catch {
    return { username: conn.username, password: null };
  }
}

function rawRequest(conn, { method = 'GET', path, data, headers = {}, contentType = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    const body = data !== undefined
      ? (contentType === 'application/json' ? JSON.stringify(data) : String(data))
      : undefined;
    const reqHeaders = { ...headers };
    if (body !== undefined) {
      reqHeaders['Content-Type'] = contentType;
      reqHeaders['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(
      {
        hostname: conn.host,
        port: 443,
        path,
        method,
        timeout: 60000,
        rejectUnauthorized: !!conn.ssl_verify,
        headers: reqHeaders,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = raw ? JSON.parse(raw) : null; } catch { json = raw || null; }
          const status = res.statusCode;
          if (status >= 200 && status < 300) {
            resolve(json);
            return;
          }
          const e = new Error(json?.message || `HTTP ${status}`);
          e.response = { status, data: json };
          reject(e);
        });
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', (err) => reject(err));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function login(conn, coreApi) {
  const { username, password } = creds(conn, coreApi);
  if (!username || !password) throw new Error('Move connection is missing credentials');

  // Classic login first (broadest version compatibility).
  try {
    const data = await rawRequest(conn, {
      method: 'POST', path: '/move/v2/users/login',
      data: { Spec: { UserName: username, Password: password } },
    });
    const token = data?.Status?.Token;
    if (token) return token;
  } catch (err) {
    coreApi.logger.debug(`[NutanixMoveApi] classic login failed for ${conn.name}, trying token endpoint: ${err.message}`);
  }

  // Fallback: form-encoded token endpoint (API 2.5.0+).
  const params = new URLSearchParams({ grantType: 'PASSWORD', username, password });
  const data = await rawRequest(conn, {
    method: 'POST', path: '/move/v2/token', data: params.toString(), contentType: 'application/x-www-form-urlencoded',
  });
  const token = data?.AccessToken;
  if (!token) throw new Error('Move login returned no token');
  return token;
}

async function getToken(conn, coreApi, force = false) {
  const cached = tokens.get(conn.id);
  if (!force && cached && Date.now() - cached.fetchedAt < TOKEN_TTL_MS) return cached.token;
  const token = await login(conn, coreApi);
  tokens.set(conn.id, { token, fetchedAt: Date.now() });
  return token;
}

function invalidateToken(connId) {
  tokens.delete(connId);
}

async function mReq(conn, coreApi, { method = 'GET', path, data } = {}) {
  let token = await getToken(conn, coreApi);
  const doCall = (t) => rawRequest(conn, { method, path, data, headers: { Authorization: `Bearer ${t}` } });
  try {
    return await doCall(token);
  } catch (err) {
    if (err.response?.status === 401) {
      token = await getToken(conn, coreApi, true);
      return await doCall(token);
    }
    throw err;
  }
}

const safeArr = (v) => (Array.isArray(v) ? v : []);
const strOrNull = (v) => (v == null ? null : String(v));
const numOrNull = (v) => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function fetchAppInfo(conn, coreApi) {
  const d = await mReq(conn, coreApi, { path: '/move/v2/appinfo' });
  return { version: strOrNull(d?.Status?.Version ?? d?.Version) };
}

// Community-documented workload state code -> label (state 5 = ready for cutover).
const STATE_LABELS = { 5: 'Ready for cutover' };
function stateLabel(code) {
  return STATE_LABELS[code] || (code != null ? `State ${code}` : null);
}

async function fetchPlans(conn, coreApi) {
  let d;
  try {
    d = await mReq(conn, coreApi, { method: 'POST', path: '/move/v2/plans/list', data: {} });
  } catch {
    d = await mReq(conn, coreApi, { path: '/move/v2/plans' });
  }
  return safeArr(d?.Entities ?? d?.entities).map((p) => {
    const spec = p.Spec || {};
    const status = spec.Status || p.Status || {};
    return {
      planUuid: strOrNull(p.MetaData?.UUID ?? p.UUID),
      name: strOrNull(spec.Name),
      state: strOrNull(status.State),
      migrationStatus: strOrNull(status.MigrationStatus),
      progress: numOrNull(status.Progress),
      sourceProvider: strOrNull(spec.SourceInfo?.Type ?? spec.SourceProviderUUID),
      targetProvider: strOrNull(spec.TargetInfo?.Type ?? spec.TargetProviderUUID),
      vmCount: safeArr(spec.VMs).length || null,
    };
  });
}

async function fetchWorkloads(conn, coreApi, plan) {
  try {
    const d = await mReq(conn, coreApi, { path: `/move/v2/plans/${plan.planUuid}/workloads/list` });
    return safeArr(d?.Entities ?? d?.entities).map((w) => {
      const spec = w.Spec || {};
      const status = spec.Status || w.Status || {};
      return {
        planUuid: plan.planUuid,
        planName: plan.name,
        vmUuid: strOrNull(spec.VMReference?.UUID ?? w.UUID),
        vmName: strOrNull(spec.VMReference?.Name ?? spec.Name),
        stateCode: numOrNull(status.State),
        stateLabel: stateLabel(numOrNull(status.State)),
        progress: numOrNull(status.Progress),
      };
    });
  } catch (err) {
    coreApi.logger.debug(`[NutanixMoveApi] workloads fetch failed for plan ${plan.name}: ${err.message}`);
    return [];
  }
}

async function fetchEvents(conn, coreApi) {
  const d = await mReq(conn, coreApi, { method: 'POST', path: '/move/v2/events', data: {} });
  return safeArr(d?.Events).map((e) => {
    const ev = e.Event || e;
    return {
      eventId: strOrNull(ev.EventId),
      eventName: strOrNull(ev.EventName),
      vmName: strOrNull(ev.VmName),
      planName: strOrNull(ev.MpName),
      status: strOrNull(ev.EventStatus),
      failureNotes: strOrNull(ev.FailureNotes) || null,
      createdUsecs: numOrNull(ev.CreatedTime),
    };
  });
}

async function testConnection(connLike, coreApi) {
  try {
    const info = await fetchAppInfo(connLike, coreApi);
    return { ok: true, applianceVersion: info.version };
  } catch (err) {
    const status = err.response?.status;
    return {
      ok: false,
      error: status === 401 ? 'Authentication failed — check the Move appliance username and password.'
        : (err.response?.data?.message || err.message),
    };
  } finally {
    invalidateToken(connLike.id);
  }
}

module.exports = {
  invalidateToken, testConnection, fetchAppInfo, fetchPlans, fetchWorkloads, fetchEvents,
};
