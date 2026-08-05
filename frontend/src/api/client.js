import axios from 'axios';

const client = axios.create({
  baseURL: '/api',
  timeout: 30000,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json'
  }
});

// ── CSRF token ────────────────────────────────────────────────────────────
// Set once after login/session fetch; attached to every mutating request.
let csrfToken = null;

export function setCsrfToken(token) {
  csrfToken = token;
  // Plugin bundles call fetch() directly and cannot import this module, so
  // without this they send session mutations with no x-csrf-token header and
  // middleware/csrf.js rejects them with a bare 403 (surfaced in the UI as
  // "Save failed (403)"). Published alongside window.React/Chart.
  if (typeof window !== 'undefined') window.__ICC_CSRF_TOKEN__ = token;
}

// Auth-exempt endpoints: a 401 from these must not trigger the redirect below
// (they're how the login page itself authenticates / checks status).
const AUTH_EXEMPT_PATHS = ['/auth/login', '/auth/setup', '/auth/session'];

function isAuthExempt(url) {
  if (!url) return false;
  const path = url.split('?')[0];
  return AUTH_EXEMPT_PATHS.some(p => path === p || path.endsWith(p));
}

// ── Global network activity tracking ─────────────────────────────────────────
// Components (GlobalLoadingBar) subscribe to the in-flight request count so the
// UI can always tell the user when data is being fetched in the background.
let inFlight = 0;
const listeners = new Set();

function notify() {
  for (const fn of listeners) fn(inFlight);
}

export function subscribeNetworkActivity(fn) {
  listeners.add(fn);
  fn(inFlight);
  return () => listeners.delete(fn);
}

client.interceptors.request.use((config) => {
  inFlight += 1;
  notify();
  const method = (config.method || 'get').toLowerCase();
  if (csrfToken && method !== 'get') {
    config.headers = config.headers || {};
    config.headers['x-csrf-token'] = csrfToken;
  }
  return config;
});

client.interceptors.response.use(
  (response) => {
    inFlight = Math.max(0, inFlight - 1);
    notify();
    return response;
  },
  (error) => {
    inFlight = Math.max(0, inFlight - 1);
    notify();
    if (error?.response?.status === 401 && !isAuthExempt(error?.config?.url)) {
      const onLoginPage = typeof window !== 'undefined' && window.location.pathname === '/login';
      if (!onLoginPage && typeof window !== 'undefined') {
        const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.assign(`/login?returnTo=${returnTo}`);
      }
    }
    return Promise.reject(error);
  }
);

export default client;
