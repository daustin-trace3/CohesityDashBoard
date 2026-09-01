// Direct Fabric OS REST client (addendum 2) — talks to a switch's OWN
// /rest API instead of proxying through SANnav. Needed on SanNav < 2.4
// where the FOS proxy (zoning/port-IO) is dead. BLIND BUILD against FOS REST
// (no local docs) — every parser is tolerant, reusing api.js's existing FOS-
// response parsers since the response BODIES are the same hyphenated
// FOS-native shapes whether relayed by SANnav or returned straight from the
// switch.
//
// Auth: POST /rest/login with `Authorization: Basic base64(user:pass)` ->
// 200 with the session key in the RESPONSE header `Authorization:
// Custom_Basic <key>`. Every subsequent call sends that header verbatim;
// POST /rest/logout ends it. FOS caps concurrent REST sessions in the
// single digits and a stuck session blocks new logins — logout ALWAYS runs
// in a finally block, never cache a FOS session across poll cycles.
//
// DEVIATION FROM THE BUILT-IN: the original (backend/services/brocadeFosApi.js)
// uses axios; re-implemented on Node's built-in `https`/`http` modules
// (http for allow_http opt-in), threading coreApi through for decrypt.
const https = require('https');
const http = require('http');
const { URLSearchParams } = require('url');
const {
  parseEffectiveConfigResponse, parseDefinedConfigResponse, parseFcStatsResponse,
} = require('./api');

// ── Credentials / client plumbing ───────────────────────────────────────────

function fosCreds(target, coreApi) {
  // Unsaved candidates (fos-test with inline creds) may carry a plaintext
  // password; resolved targets carry password_enc.
  if (target.password != null) return { username: target.username, password: target.password };
  if (!target.password_enc) return { username: target.username, password: null };
  try {
    return { username: target.username, password: coreApi.encryption.decrypt(target.password_enc) };
  } catch {
    return { username: target.username, password: null };
  }
}

function fosTarget(target) {
  // Opt-in HTTP (fos_allow_http): FOS REST ships HTTP-only until the switch
  // has an HTTPS cert. When allowed, a still-default 443 port flips to 80 —
  // HTTP-on-443 is never right.
  const allowHttp = !!target.allow_http;
  let port = target.port || (allowHttp ? 80 : 443);
  if (allowHttp && port === 443) port = 80;
  return { allowHttp, hostname: target.ip, port };
}

function errMsg(err) {
  if (err?.response) {
    const d = err.response.data;
    let msg = null;
    if (d && typeof d === 'object') {
      // Two documented FOS/SANnav error shapes: {errors:{error:[{...}]}}
      // and the bare FOS-native {error:[{...}]}.
      const nested = d.errors?.error || d.error;
      if (Array.isArray(nested) && nested[0]) {
        msg = nested[0]['error-message'] || nested[0].message || null;
      }
      if (!msg && d.message) msg = d.message;
    } else if (typeof d === 'string' && d.trim()) {
      // Plain HTML on an auth redirect, or a non-JSON error page.
      msg = d.replace(/<[^>]*>/g, ' ').trim().slice(0, 200);
    }
    return `HTTP ${err.response.status}${msg ? `: ${msg}` : ''}`;
  }
  return err?.message || String(err);
}

/** Raw HTTP(S) call against a switch's own FOS REST API. */
function rawRequest(target, coreApi, { method = 'GET', path, params, data, headers = {}, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const { allowHttp, hostname, port } = fosTarget(target);
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const query = qs.toString();
    const reqPath = `${path}${query ? `${path.includes('?') ? '&' : '?'}${query}` : ''}`;
    const body = data !== undefined ? JSON.stringify(data) : undefined;
    const reqHeaders = { Accept: 'application/yang-data+json', 'Content-Type': 'application/yang-data+json', ...headers };
    if (body !== undefined) reqHeaders['Content-Length'] = Buffer.byteLength(body);

    const transport = allowHttp ? http : https;
    const req = transport.request(
      {
        hostname, port, path: reqPath, method, timeout,
        rejectUnauthorized: !!target.verify_ssl,
        headers: reqHeaders,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const status = res.statusCode;
          const str = raw.toString('utf8');
          let payload;
          try { payload = str ? JSON.parse(str) : null; } catch { payload = str || null; }
          if (status >= 200 && status < 300) {
            resolve({ status, data: payload, headers: res.headers });
            return;
          }
          const e = new Error(`HTTP ${status}`);
          e.response = { status, data: payload, headers: res.headers };
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

// ── Login / logout ───────────────────────────────────────────────────────

async function fosLogin(target, coreApi, timeout = 30000) {
  const { username, password } = fosCreds(target, coreApi);
  const basic = Buffer.from(`${username || ''}:${password || ''}`).toString('base64');
  const res = await rawRequest(target, coreApi, {
    method: 'POST', path: '/rest/login', data: {},
    headers: { Authorization: `Basic ${basic}` }, timeout,
  });
  const authHeader = res.headers?.authorization || res.headers?.Authorization;
  if (res.status !== 200 || !authHeader) {
    const err = new Error(`FOS login failed: HTTP ${res.status}`);
    err.response = res;
    throw err;
  }
  return { authHeader };
}

async function fosLogout(target, coreApi, authHeader, timeout = 10000) {
  if (!authHeader) return;
  try {
    await rawRequest(target, coreApi, {
      method: 'POST', path: '/rest/logout', data: {},
      headers: { Authorization: authHeader }, timeout,
    });
  } catch {
    // Best-effort: a failed logout call just means the session eventually
    // times out server-side. Never let a logout failure surface as a poll
    // error — but never skip the ATTEMPT either (see withFosSession).
  }
}

/**
 * Runs `fn(authHeader)` inside a login/logout bracket. Logout ALWAYS
 * runs (finally), even if `fn` throws or login partially succeeded — FOS's
 * single-digit session cap means a leaked session blocks the next login.
 */
async function withFosSession(target, coreApi, fn, timeout = 30000) {
  let authHeader;
  try {
    ({ authHeader } = await fosLogin(target, coreApi, timeout));
    return await fn(authHeader);
  } finally {
    await fosLogout(target, coreApi, authHeader);
  }
}

// ── GET with vf-id retry-once-without ───────────────────────────────────────

async function fosGet(target, coreApi, authHeader, path, vfId, timeout) {
  const doGet = (params) => rawRequest(target, coreApi, {
    path, params, headers: { Authorization: authHeader }, timeout,
  });
  const withVf = vfId != null && vfId > 0;
  try {
    const res = await doGet(withVf ? { 'vf-id': vfId } : undefined);
    return res.data;
  } catch (err) {
    if (withVf && (err.response?.status === 400 || err.response?.status === 404)) {
      // Non-VF-enabled switches reject the vf-id param — retry once without it.
      const res = await doGet(undefined);
      return res.data;
    }
    throw err;
  }
}

function unwrapResponse(data) {
  return (data && (data.Response || data.response)) || {};
}

// ── Zoning ───────────────────────────────────────────────────────────────

async function fetchZoneConfigs(target, coreApi, vfId, timeout = 30000) {
  return withFosSession(target, coreApi, async (authHeader) => {
    const effData = await fosGet(target, coreApi, authHeader, '/rest/running/brocade-zone/effective-configuration', vfId, timeout);
    const effective = parseEffectiveConfigResponse(unwrapResponse(effData));
    let defined = { configs: [], zones: [], aliases: [] };
    try {
      const defData = await fosGet(target, coreApi, authHeader, '/rest/running/brocade-zone/defined-configuration', vfId, timeout);
      defined = parseDefinedConfigResponse(unwrapResponse(defData));
    } catch {
      // Best-effort, mirrors api.js's SanNav-proxy zoning: the effective
      // config is the governance-critical fetch; defined-only configs/
      // aliases are nice-to-have and must not fail the fabric.
    }
    return { effective, defined };
  }, timeout);
}

// ── Port IO statistics ───────────────────────────────────────────────────

async function fetchPortStats(target, coreApi, vfId, timeout = 30000) {
  return withFosSession(target, coreApi, async (authHeader) => {
    const data = await fosGet(target, coreApi, authHeader, '/rest/running/brocade-interface/fibrechannel-statistics', vfId, timeout);
    return parseFcStatsResponse(unwrapResponse(data));
  }, timeout);
}

// ── Connectivity test (login + logout only) ─────────────────────────────

async function testFos(target, coreApi, timeout = 15000) {
  try {
    await withFosSession(target, coreApi, async () => {}, timeout);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}

module.exports = {
  withFosSession,
  fetchZoneConfigs,
  fetchPortStats,
  testFos,
  errMsg,
};
