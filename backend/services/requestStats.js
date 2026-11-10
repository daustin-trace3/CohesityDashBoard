// In-memory request statistics for the System Health page: per route count,
// errors, total and max time, and a reservoir of the last 200 durations for
// p50/p95. Web process only, nothing persisted, so the page says "since the web
// process started". Fed by middleware/requestTiming.js.
const MAX_ROUTES = 400;
const RESERVOIR = 200;
const OTHER = 'other';

let since = new Date().toISOString();
let total = 0;
const routes = new Map();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idLike(seg) {
  return /^\d+$/.test(seg) || UUID_RE.test(seg) || seg.length > 24;
}

/** The tenant prefix is one route, not one per tenant. */
function collapseTenant(p) {
  return p.replace(/\/t\/[^/]+/, '/t/:tenant');
}

/** `${method} ${template}` for a finished request. */
function routeKey(req) {
  let template;
  if (req.route && typeof req.route.path === 'string') {
    template = (req.baseUrl || '') + req.route.path;
  } else {
    const pathname = String(req.originalUrl || req.url || '').split('?')[0];
    template = pathname.split('/').map((seg) => (seg && idLike(seg) ? ':id' : seg)).join('/');
  }
  const collapsed = collapseTenant(template);
  return `${req.method} ${collapsed.length > 1 && collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed}`;
}

function record(key, ms, status) {
  total += 1;
  let r = routes.get(key);
  if (!r) {
    if (routes.size >= MAX_ROUTES) {
      key = OTHER;
      r = routes.get(OTHER);
    }
    if (!r) {
      r = { count: 0, errors4xx: 0, errors5xx: 0, totalMs: 0, maxMs: 0, lastAt: null, ring: [], pos: 0 };
      routes.set(key, r);
    }
  }
  r.count += 1;
  if (status >= 500) r.errors5xx += 1; else if (status >= 400) r.errors4xx += 1;
  r.totalMs += ms;
  if (ms > r.maxMs) r.maxMs = ms;
  r.lastAt = new Date().toISOString();
  if (r.ring.length < RESERVOIR) r.ring.push(ms);
  else { r.ring[r.pos] = ms; r.pos = (r.pos + 1) % RESERVOIR; }
}

function percentile(values, p) {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

const r1 = (n) => Math.round(n * 10) / 10;

function snapshot() {
  const list = [];
  for (const [route, r] of routes) {
    list.push({
      route, count: r.count, errors4xx: r.errors4xx, errors5xx: r.errors5xx,
      avgMs: r1(r.totalMs / r.count), totalMs: r1(r.totalMs), maxMs: r1(r.maxMs),
      p50: r1(percentile(r.ring, 50)), p95: r1(percentile(r.ring, 95)), lastAt: r.lastAt,
    });
  }
  return { since, total, routes: list };
}

function reset() { routes.clear(); total = 0; since = new Date().toISOString(); }

module.exports = { record, routeKey, snapshot, reset, percentile, MAX_ROUTES };
