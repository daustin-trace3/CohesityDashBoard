// Brocade plugin fetch wrapper — axios-shaped (`client.get(path, { params })`
// resolving to `{ data }`, errors carrying `err.response.data.error`) so the
// host frontend/src/pages/brocade/*.jsx pages (built against
// `frontend/src/api/client.js`, an axios instance) port with an import swap
// and no call-site rewrites. Per contract §WP2.4: fetch with
// `credentials:'same-origin'`, no x-api-key; every mutating call spreads the
// CSRF header from window.__ICC_CSRF_TOKEN__. Paths are host-relative
// ('/brocade/...') and get the '/api' prefix here, exactly like the host's
// axios instance baseURL.

function toQuery(params) {
  if (!params) return '';
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    usp.set(k, v);
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

async function request(path, { method = 'GET', body, params, headers, timeout, ...rest } = {}) {
  const h = { ...(headers || {}) };
  let payload = body;
  if (payload !== undefined && typeof payload !== 'string') {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(payload);
  }
  if (method !== 'GET' && typeof window !== 'undefined' && window.__ICC_CSRF_TOKEN__) {
    h['x-csrf-token'] = window.__ICC_CSRF_TOKEN__;
  }

  const controller = timeout ? new AbortController() : null;
  const timer = timeout ? setTimeout(() => controller.abort(), timeout) : null;

  let res;
  try {
    res = await fetch(`/api${path}${toQuery(params)}`, {
      credentials: 'same-origin',
      method,
      headers: h,
      body: payload,
      signal: controller ? controller.signal : undefined,
      ...rest,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!res.ok) {
    const errPayload = await res.json().catch(() => ({}));
    const err = new Error(errPayload.error || `Request failed: ${res.status}`);
    err.status = res.status;
    err.response = { data: errPayload, status: res.status };
    throw err;
  }
  if (res.status === 204) return { data: null };
  const data = await res.json().catch(() => null);
  return { data };
}

const client = {
  get: (path, opts) => request(path, { ...opts, method: 'GET' }),
  post: (path, body, opts) => request(path, { ...opts, method: 'POST', body }),
  put: (path, body, opts) => request(path, { ...opts, method: 'PUT', body }),
  delete: (path, opts) => request(path, { ...opts, method: 'DELETE' }),
};

export default client;
