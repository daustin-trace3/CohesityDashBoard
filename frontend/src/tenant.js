// The tenant a browser tab is looking at comes from its URL: /t/<tenant>/...
// (docs/MULTI-TENANT-DESIGN.md, decision 2). Every API request from this tab
// names that tenant in the x-icc-tenant header, including the fetch() calls
// plugin bundles make on their own. No tenant in the URL means the install's
// only tenant; from the second tenant on the server refuses such requests.
const TENANT_PATH = /^\/t\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])(?=\/|$)/;

export function tenantFromPath(pathname) {
  const m = String(pathname || '').match(TENANT_PATH);
  return m ? m[1] : null;
}

export function currentTenant() {
  return typeof window === 'undefined' ? null : tenantFromPath(window.location.pathname);
}

/** Router basename for this tab: '/t/<tenant>' or '' when the URL names none. */
export function routerBasename() {
  const t = currentTenant();
  return t ? `/t/${t}` : '';
}

/** Absolute app path for a tenant, used by the switcher. */
export function tenantHome(tenantId) {
  return `/t/${tenantId}/`;
}

function isSameOriginApi(input) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (url.startsWith('/api/')) return true;
  if (typeof window === 'undefined') return false;
  return url.startsWith(`${window.location.origin}/api/`);
}

/** Wraps window.fetch once so plugin bundles' API calls carry the tenant. */
export function installTenantFetch() {
  if (typeof window === 'undefined' || window.__iccTenantFetch) return;
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const tenant = currentTenant();
    if (!tenant || !isSameOriginApi(input)) return original(input, init);
    const headers = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined));
    if (!headers.has('x-icc-tenant')) headers.set('x-icc-tenant', tenant);
    return original(input, { ...(init || {}), headers });
  };
  window.__iccTenantFetch = true;
}
