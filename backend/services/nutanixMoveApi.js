// Nutanix Move v2 API client. Standalone appliance, own local user DB — not
// part of Prism. JWT bearer auth via /move/v2/users/login (classic, works
// 3.x-6.x) with fallback to the newer form-encoded /move/v2/token endpoint.
// Token TTL ~15 min — re-auth transparently on 401 mid-poll (contract #4).
const axios = require('axios');
const https = require('https');
const { decrypt } = require('./encryption');
const logger = require('../utils/logger');

const tokens = new Map(); // conn.id -> { token, fetchedAt }
const TOKEN_TTL_MS = 13 * 60 * 1000; // refresh a bit before the 15-min expiry

function creds(conn) {
  if (conn.password != null) return { username: conn.username, password: conn.password };
  if (!conn.encrypted_credentials) return { username: conn.username, password: null };
  try {
    const c = JSON.parse(decrypt(conn.encrypted_credentials));
    return { username: conn.username, password: c.password };
  } catch {
    return { username: conn.username, password: null };
  }
}

function baseClient(conn, headers = {}) {
  return axios.create({
    baseURL: `https://${conn.host}`,
    timeout: 60000,
    headers,
    httpsAgent: new https.Agent({ rejectUnauthorized: !!conn.ssl_verify }),
  });
}

async function login(conn) {
  const { username, password } = creds(conn);
  if (!username || !password) throw new Error('Move connection is missing credentials');

  // Classic login first (broadest version compatibility per move-mine.md).
  try {
    const { data } = await baseClient(conn).post('/move/v2/users/login', {
      Spec: { UserName: username, Password: password },
    });
    const token = data?.Status?.Token;
    if (token) return token;
  } catch (err) {
    logger.debug(`[NutanixMoveApi] classic login failed for ${conn.name}, trying token endpoint: ${err.message}`);
  }

  // Fallback: form-encoded token endpoint (API 2.5.0+).
  const params = new URLSearchParams({ grantType: 'PASSWORD', username, password });
  const { data } = await baseClient(conn, { 'Content-Type': 'application/x-www-form-urlencoded' })
    .post('/move/v2/token', params.toString());
  const token = data?.AccessToken;
  if (!token) throw new Error('Move login returned no token');
  return token;
}

async function getToken(conn, force = false) {
  const cached = tokens.get(conn.id);
  if (!force && cached && Date.now() - cached.fetchedAt < TOKEN_TTL_MS) return cached.token;
  const token = await login(conn);
  tokens.set(conn.id, { token, fetchedAt: Date.now() });
  return token;
}

function invalidateToken(connId) {
  tokens.delete(connId);
}

async function mReq(conn, { method = 'GET', path, data } = {}) {
  let token = await getToken(conn);
  const doCall = (t) => baseClient(conn, { Authorization: `Bearer ${t}` }).request({ method, url: path, data });
  try {
    const res = await doCall(token);
    return res.data;
  } catch (err) {
    if (err.response?.status === 401) {
      token = await getToken(conn, true);
      const res = await doCall(token);
      return res.data;
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

async function fetchAppInfo(conn) {
  const d = await mReq(conn, { path: '/move/v2/appinfo' });
  return { version: strOrNull(d?.Status?.Version ?? d?.Version) };
}

// Community-documented workload state code -> label (state 5 = ready for cutover).
const STATE_LABELS = { 5: 'Ready for cutover' };
function stateLabel(code) {
  return STATE_LABELS[code] || (code != null ? `State ${code}` : null);
}

async function fetchPlans(conn) {
  let d;
  try {
    d = await mReq(conn, { method: 'POST', path: '/move/v2/plans/list', data: {} });
  } catch {
    d = await mReq(conn, { path: '/move/v2/plans' });
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

async function fetchWorkloads(conn, plan) {
  try {
    const d = await mReq(conn, { path: `/move/v2/plans/${plan.planUuid}/workloads/list` });
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
    logger.debug(`[NutanixMoveApi] workloads fetch failed for plan ${plan.name}: ${err.message}`);
    return [];
  }
}

async function fetchEvents(conn) {
  const d = await mReq(conn, { method: 'POST', path: '/move/v2/events', data: {} });
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

async function testConnection(connLike) {
  try {
    const info = await fetchAppInfo(connLike);
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
