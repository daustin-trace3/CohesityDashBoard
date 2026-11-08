// Okta Management API client (2026-11-06, IDP-CONTRACT section 2 and 6).
// Read-only: users, groups and group membership, authenticated with an SSWS
// API token. All HTTP goes through one injectable function so tests serve a
// fake Okta. Paging follows the Link header rel="next" URL exactly as given.

const axios = require('axios');

let httpImpl = (opts) => axios({
  method: opts.method || 'GET',
  url: opts.url,
  headers: opts.headers,
  timeout: opts.timeout || 10000,
  validateStatus: () => true,
  maxRedirects: 0,
  responseType: 'json',
});

function setHttp(fn) { httpImpl = fn || httpImpl; }

function apiError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function headerOf(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name);
  const k = Object.keys(headers).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? headers[k] : undefined;
}

function nextLink(headers) {
  const raw = headerOf(headers, 'link');
  if (!raw) return null;
  const text = Array.isArray(raw) ? raw.join(', ') : String(raw);
  for (const part of text.split(/,\s*(?=<)/)) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part);
    if (m) return m[1];
  }
  return null;
}

function toIdentity(u) {
  const p = (u && u.profile) || {};
  return {
    subject: u.id,
    email: p.email || null,
    username: p.login || null,
    displayName: `${p.firstName || ''} ${p.lastName || ''}`.trim() || p.login || null,
    groups: [],
    groupIds: [],
    active: u.status === 'ACTIVE',
    status: u.status,
  };
}

function createClient({ baseUrl, token, http } = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const call = http || ((o) => httpImpl(o));
  const headers = { Authorization: `SSWS ${token}`, Accept: 'application/json' };

  async function request(url, attempt = 0) {
    let res;
    try {
      res = await call({ method: 'GET', url, headers, timeout: 10000 });
    } catch (e) {
      throw apiError(0, `Okta is unreachable: ${e.message}`);
    }
    if (res.status === 429 && attempt === 0) {
      const reset = Number(headerOf(res.headers, 'x-rate-limit-reset'));
      const wait = Number.isFinite(reset) && reset > 0 ? Math.min(30000, Math.max(0, reset * 1000 - Date.now())) : 1000;
      await new Promise((r) => setTimeout(r, wait));
      return request(url, 1);
    }
    if (res.status === 429) throw apiError(429, 'Okta rate limit reached (429) after one retry.');
    if (res.status === 401) throw apiError(401, 'Okta rejected the API token (401). The token may be expired or revoked.');
    if (res.status === 403) throw apiError(403, 'The Okta API token lacks permission for this call (403).');
    if (res.status < 200 || res.status >= 300) {
      const d = res.data && (res.data.errorSummary || res.data.error_description);
      throw apiError(res.status, `Okta answered HTTP ${res.status}${d ? `: ${d}` : ''}`);
    }
    return res;
  }

  async function getAll(path) {
    const out = [];
    let url = `${base}${path}`;
    let pages = 0;
    while (url && pages < 500) {
      const res = await request(url);
      if (Array.isArray(res.data)) out.push(...res.data);
      url = nextLink(res.headers);
      pages += 1;
    }
    return out;
  }

  const q = encodeURIComponent;
  return {
    async test() {
      const res = await request(`${base}/api/v1/users/me`);
      const p = (res.data && res.data.profile) || {};
      return { ok: true, login: p.login || null, org: base, status: res.data && res.data.status };
    },
    async searchGroups(query, limit = 50) {
      const res = await request(`${base}/api/v1/groups?q=${q(query || '')}&limit=${Math.min(200, Number(limit) || 50)}`);
      return (Array.isArray(res.data) ? res.data : []).map((g) => ({ id: g.id, type: g.type, name: g.profile && g.profile.name, description: (g.profile && g.profile.description) || '' }));
    },
    async getGroupByName(name) {
      const want = String(name || '').toLowerCase();
      const res = await request(`${base}/api/v1/groups?q=${q(name)}&limit=200`);
      const hit = (Array.isArray(res.data) ? res.data : []).find((g) => String((g.profile && g.profile.name) || '').toLowerCase() === want);
      return hit ? { id: hit.id, type: hit.type, name: hit.profile.name, description: hit.profile.description || '' } : null;
    },
    async searchUsers(query, limit = 25) {
      const res = await request(`${base}/api/v1/users?q=${q(query || '')}&limit=${Math.min(200, Number(limit) || 25)}`);
      return (Array.isArray(res.data) ? res.data : []).map(toIdentity);
    },
    async getUser(idOrLogin) {
      try {
        const res = await request(`${base}/api/v1/users/${q(idOrLogin)}`);
        return toIdentity(res.data);
      } catch (e) {
        if (e.status === 404) return null;
        throw e;
      }
    },
    async groupMembers(groupId) {
      return (await getAll(`/api/v1/groups/${q(groupId)}/users?limit=200`)).map(toIdentity);
    },
    async userGroups(userId) {
      return (await getAll(`/api/v1/users/${q(userId)}/groups`)).map((g) => ({ id: g.id, name: g.profile && g.profile.name }));
    },
  };
}

module.exports = { createClient, setHttp, nextLink };
