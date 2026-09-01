// Direct Fabric OS REST client (addendum 2) — talks to a switch's OWN
// /rest API instead of proxying through SANnav. Needed on SanNav < 2.4
// where the FOS proxy (zoning/port-IO) is dead. BLIND BUILD against FOS REST
// (no local docs) — every parser is tolerant, reusing brocadeApi.js's
// existing FOS-response parsers since the response BODIES are the same
// hyphenated FOS-native shapes whether relayed by SANnav or returned
// straight from the switch.
//
// Auth: POST /rest/login with `Authorization: Basic base64(user:pass)` ->
// 200 with the session key in the RESPONSE header `Authorization:
// Custom_Basic <key>` (axios lower-cases response header names). Every
// subsequent call sends that header verbatim; POST /rest/logout ends it.
// FOS caps concurrent REST sessions in the single digits and a stuck
// session blocks new logins — logout ALWAYS runs in a finally block, never
// cache a FOS session across poll cycles.
const axios = require('axios');
const https = require('https');
const { decrypt } = require('./encryption');
const {
  parseEffectiveConfigResponse, parseDefinedConfigResponse, parseFcStatsResponse,
} = require('./brocadeApi');

// ── Credentials / client plumbing ───────────────────────────────────────────

function fosCreds(target) {
  // Unsaved candidates (fos-test with inline creds) may carry a plaintext
  // password; resolved targets carry password_enc.
  if (target.password != null) return { username: target.username, password: target.password };
  if (!target.password_enc) return { username: target.username, password: null };
  try {
    return { username: target.username, password: decrypt(target.password_enc) };
  } catch {
    return { username: target.username, password: null };
  }
}

function fosBaseUrl(target) {
  // Opt-in HTTP (fos_allow_http): FOS REST ships HTTP-only until the switch
  // has an HTTPS cert. When allowed, a still-default 443 port flips to 80 —
  // HTTP-on-443 is never right.
  const scheme = target.allow_http ? 'http' : 'https';
  let port = target.port || (target.allow_http ? 80 : 443);
  if (target.allow_http && port === 443) port = 80;
  return `${scheme}://${target.ip}:${port}`;
}

function fosClient(target, timeout) {
  return axios.create({
    baseURL: fosBaseUrl(target),
    timeout,
    httpsAgent: new https.Agent({ rejectUnauthorized: !!target.verify_ssl }),
    validateStatus: () => true,
    headers: { Accept: 'application/yang-data+json', 'Content-Type': 'application/yang-data+json' },
  });
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

// ── Login / logout ───────────────────────────────────────────────────────

async function fosLogin(target, timeout = 30000) {
  const { username, password } = fosCreds(target);
  const client = fosClient(target, timeout);
  const basic = Buffer.from(`${username || ''}:${password || ''}`).toString('base64');
  const res = await client.post('/rest/login', {}, { headers: { Authorization: `Basic ${basic}` } });
  const authHeader = res.headers?.authorization || res.headers?.Authorization;
  if (res.status !== 200 || !authHeader) {
    const err = new Error(`FOS login failed: HTTP ${res.status}`);
    err.response = res;
    throw err;
  }
  return { client, authHeader };
}

async function fosLogout(client, authHeader, timeout = 10000) {
  if (!client || !authHeader) return;
  try {
    await client.post('/rest/logout', {}, { headers: { Authorization: authHeader }, timeout });
  } catch {
    // Best-effort: a failed logout call just means the session eventually
    // times out server-side. Never let a logout failure surface as a poll
    // error — but never skip the ATTEMPT either (see withFosSession).
  }
}

/**
 * Runs `fn(client, authHeader)` inside a login/logout bracket. Logout ALWAYS
 * runs (finally), even if `fn` throws or login partially succeeded — FOS's
 * single-digit session cap means a leaked session blocks the next login.
 */
async function withFosSession(target, fn, timeout = 30000) {
  let client;
  let authHeader;
  try {
    ({ client, authHeader } = await fosLogin(target, timeout));
    return await fn(client, authHeader);
  } finally {
    await fosLogout(client, authHeader);
  }
}

// ── GET with vf-id retry-once-without ───────────────────────────────────────

async function fosGet(client, authHeader, path, vfId, timeout) {
  const doGet = (params) => client.get(path, { params, headers: { Authorization: authHeader }, timeout });
  const withVf = vfId != null && vfId > 0;
  let res = await doGet(withVf ? { 'vf-id': vfId } : undefined);
  if (withVf && (res.status === 400 || res.status === 404)) {
    // Non-VF-enabled switches reject the vf-id param — retry once without it.
    res = await doGet(undefined);
  }
  if (res.status < 200 || res.status >= 300) {
    const err = new Error(`HTTP ${res.status}`);
    err.response = res;
    throw err;
  }
  return res.data;
}

function unwrapResponse(data) {
  return (data && (data.Response || data.response)) || {};
}

// ── Zoning ───────────────────────────────────────────────────────────────

async function fetchZoneConfigs(target, vfId, timeout = 30000) {
  return withFosSession(target, async (client, authHeader) => {
    const effData = await fosGet(client, authHeader, '/rest/running/brocade-zone/effective-configuration', vfId, timeout);
    const effective = parseEffectiveConfigResponse(unwrapResponse(effData));
    let defined = { configs: [], zones: [], aliases: [] };
    try {
      const defData = await fosGet(client, authHeader, '/rest/running/brocade-zone/defined-configuration', vfId, timeout);
      defined = parseDefinedConfigResponse(unwrapResponse(defData));
    } catch {
      // Best-effort, mirrors brocadeApi.js's SanNav-proxy zoning: the
      // effective config is the governance-critical fetch; defined-only
      // configs/aliases are nice-to-have and must not fail the fabric.
    }
    return { effective, defined };
  }, timeout);
}

// ── Port IO statistics ───────────────────────────────────────────────────

async function fetchPortStats(target, vfId, timeout = 30000) {
  return withFosSession(target, async (client, authHeader) => {
    const data = await fosGet(client, authHeader, '/rest/running/brocade-interface/fibrechannel-statistics', vfId, timeout);
    return parseFcStatsResponse(unwrapResponse(data));
  }, timeout);
}

// ── Connectivity test (login + logout only) ─────────────────────────────

async function testFos(target, timeout = 15000) {
  try {
    await withFosSession(target, async () => {}, timeout);
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
