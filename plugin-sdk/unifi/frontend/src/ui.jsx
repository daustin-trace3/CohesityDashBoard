// UniFi plugin style kit. No Tailwind build step is available inside a
// plugin bundle, so this installs a hand-rolled utility stylesheet that
// mirrors the class *names* the built-in frontend/src/pages/unifi/* pages
// already use (panel, text-ink, text-ink-muted, tnum, grid-cols-2, ...).
// That lets pages/* here (and WP-P3's pages) port from the built-in JSX
// with mostly an import swap instead of a full inline-style rewrite.
//
// Primitives (Badge/Panel/PageHeader/StatCard/...) follow the
// plugin-sdk/nutanix/frontend/src/ui.jsx pattern (inline styles, no
// className dependency) since they don't need the page-level vocabulary.
//
// React/ReactDOM/ReactRouterDOM/Chart come from window globals injected by
// esbuild `define` at build time (see plugin-sdk/build.mjs) — no imports.

export const BRAND = '#006FFF';

const STYLE_ID = 'uf-plugin-styles';

/* ── Spacing/sizing scale (Tailwind-equivalent, 1 unit = 0.25rem) ──────── */
const SPACE = {
  '0': '0', '0.5': '0.125rem', '1': '0.25rem', '1.5': '0.375rem', '2': '0.5rem', '2.5': '0.625rem',
  '3': '0.75rem', '3.5': '0.875rem', '4': '1rem', '5': '1.25rem', '6': '1.5rem', '7': '1.75rem',
  '8': '2rem', '9': '2.25rem', '10': '2.5rem', '11': '2.75rem', '12': '3rem', '14': '3.5rem',
  '16': '4rem', '20': '5rem', '24': '6rem', '28': '7rem', '32': '8rem', '36': '9rem', '40': '10rem',
  '44': '11rem', '48': '12rem', '56': '14rem', '64': '16rem', '72': '18rem', '80': '20rem', '96': '24rem',
};

function esc(k) { return k.replace('.', '\\.'); }

function spacingCss() {
  let out = '';
  for (const [k, v] of Object.entries(SPACE)) {
    const e = esc(k);
    out += `.p-${e}{padding:${v}}.px-${e}{padding-left:${v};padding-right:${v}}.py-${e}{padding-top:${v};padding-bottom:${v}}`;
    out += `.pt-${e}{padding-top:${v}}.pb-${e}{padding-bottom:${v}}.pl-${e}{padding-left:${v}}.pr-${e}{padding-right:${v}}`;
    out += `.m-${e}{margin:${v}}.mx-${e}{margin-left:${v};margin-right:${v}}.my-${e}{margin-top:${v};margin-bottom:${v}}`;
    out += `.mt-${e}{margin-top:${v}}.mb-${e}{margin-bottom:${v}}.ml-${e}{margin-left:${v}}.mr-${e}{margin-right:${v}}`;
    out += `.gap-${e}{gap:${v}}.gap-x-${e}{column-gap:${v}}.gap-y-${e}{row-gap:${v}}`;
    out += `.w-${e}{width:${v}}.h-${e}{height:${v}}`;
    out += `.top-${e}{top:${v}}.left-${e}{left:${v}}.right-${e}{right:${v}}.bottom-${e}{bottom:${v}}`;
  }
  return out;
}

const CSS = `
:root {
  --uf-surface-base: #0B1015;
  --uf-surface: #131B23;
  --uf-surface-raised: #18222C;
  --uf-surface-overlay: #1E2A36;
  --uf-border: #1F2B37;
  --uf-gray: #131B23;
  --uf-ink: #E8EDF2;
  --uf-ink-muted: #94A3B3;
  --uf-ink-faint: #5F7081;
  --uf-brand: ${BRAND};
  --uf-brand-dark: #0057CC;
  --uf-ok: #34D399;
  --uf-warn: #FBBF24;
  --uf-crit: #F87171;
  --uf-info: #60A5FA;
}

.uf-root { font-family: inherit; color: var(--uf-ink); }

/* component classes used by ported page bodies */
.panel { background: var(--uf-surface); border: 1px solid var(--uf-border); border-radius: 12px; box-shadow: 0 1px 2px rgba(0,0,0,.4), inset 0 0 0 1px rgba(255,255,255,.02); }
.tnum { font-variant-numeric: tabular-nums; }
.animate-fade-in { animation: uf-fade-in 220ms ease-out both; }
.animate-spin { animation: uf-spin 0.8s linear infinite; }
@keyframes uf-fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes uf-spin { to { transform: rotate(360deg); } }

/* colors */
.text-ink { color: var(--uf-ink); }
.text-ink-muted { color: var(--uf-ink-muted); }
.text-ink-faint { color: var(--uf-ink-faint); }
.text-brand { color: var(--uf-brand); }
.text-status-ok { color: var(--uf-ok); }
.text-status-warn { color: var(--uf-warn); }
.text-status-crit { color: var(--uf-crit); }
.text-status-bad { color: var(--uf-crit); }
.text-status-info { color: var(--uf-info); }
.text-white { color: #fff; }
.text-white\\/80 { color: rgba(255,255,255,.8); }
.bg-black\\/40 { background: rgba(0,0,0,.4); }
.bg-black\\/50 { background: rgba(0,0,0,.5); }
.bg-black\\/60 { background: rgba(0,0,0,.6); }
.bg-brand\\/10 { background: rgba(0,111,255,.1); }
.bg-brand\\/20 { background: rgba(0,111,255,.2); }
.bg-status-ok\\/10 { background: rgba(52,211,153,.1); }
.bg-status-warn\\/10 { background: rgba(251,191,36,.1); }
.bg-status-crit\\/5 { background: rgba(248,113,113,.05); }
.bg-status-crit\\/10 { background: rgba(248,113,113,.1); }
.bg-cohesity-gray { background: var(--uf-gray); }
.bg-surface-overlay { background: var(--uf-surface-overlay); }
.bg-white { background: #fff; }

/* borders */
.border { border: 1px solid var(--uf-border); }
.border-b { border-bottom: 1px solid var(--uf-border); }
.border-t { border-top: 1px solid var(--uf-border); }
.border-l { border-left: 1px solid var(--uf-border); }
.border-transparent { border-color: transparent; }
.border-cohesity-border { border-color: var(--uf-border); }
.border-cohesity-border\\/40 { border-color: rgba(31,43,55,.4); }
.border-cohesity-border\\/50 { border-color: rgba(31,43,55,.5); }
.border-brand\\/30 { border-color: rgba(0,111,255,.3); }
.border-brand\\/40 { border-color: rgba(0,111,255,.4); }
.border-brand\\/50 { border-color: rgba(0,111,255,.5); }
.border-status-warn\\/40 { border-color: rgba(251,191,36,.4); }
.border-status-crit\\/50 { border-color: rgba(248,113,113,.5); }
.rounded-full { border-radius: 9999px; }
.rounded-lg { border-radius: .5rem; }
.rounded-md { border-radius: .375rem; }
.rounded-xl { border-radius: .75rem; }

/* layout */
.block { display: block; }
.inline { display: inline; }
.inline-block { display: inline-block; }
.inline-flex { display: inline-flex; }
.flex { display: flex; }
.flex-col { flex-direction: column; }
.flex-row { flex-direction: row; }
.flex-wrap { flex-wrap: wrap; }
.items-center { align-items: center; }
.items-start { align-items: flex-start; }
.items-end { align-items: flex-end; }
.justify-between { justify-content: space-between; }
.justify-center { justify-content: center; }
.justify-end { justify-content: flex-end; }
.flex-1 { flex: 1 1 0%; }
.shrink-0 { flex-shrink: 0; }
.min-w-0 { min-width: 0; }
.min-w-\\[10rem\\] { min-width: 10rem; }
.grid { display: grid; }
.grid-cols-2 { grid-template-columns: repeat(2,minmax(0,1fr)); }
.grid-cols-3 { grid-template-columns: repeat(3,minmax(0,1fr)); }
.grid-cols-4 { grid-template-columns: repeat(4,minmax(0,1fr)); }
.col-span-2 { grid-column: span 2 / span 2; }
@media (min-width: 640px) {
  .sm\\:grid-cols-2 { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .sm\\:grid-cols-3 { grid-template-columns: repeat(3,minmax(0,1fr)); }
  .sm\\:grid-cols-4 { grid-template-columns: repeat(4,minmax(0,1fr)); }
}
@media (min-width: 768px) {
  .md\\:grid-cols-2 { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .md\\:grid-cols-4 { grid-template-columns: repeat(4,minmax(0,1fr)); }
  .md\\:grid-cols-5 { grid-template-columns: repeat(5,minmax(0,1fr)); }
  .md\\:col-span-2 { grid-column: span 2 / span 2; }
  .md\\:flex-col { flex-direction: column; }
  .md\\:flex-row { flex-direction: row; }
  .md\\:w-48 { width: 12rem; }
}
@media (min-width: 1024px) {
  .lg\\:grid-cols-2 { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .lg\\:grid-cols-3 { grid-template-columns: repeat(3,minmax(0,1fr)); }
  .lg\\:grid-cols-5 { grid-template-columns: repeat(5,minmax(0,1fr)); }
  .lg\\:col-span-2 { grid-column: span 2 / span 2; }
}

/* position */
.absolute { position: absolute; }
.relative { position: relative; }
.fixed { position: fixed; }
.inset-0 { top: 0; right: 0; bottom: 0; left: 0; }
.top-1\\/2 { top: 50%; }
.left-1\\/2 { left: 50%; }
.-translate-y-1\\/2 { transform: translateY(-50%); }
.left-\\[22px\\] { left: 22px; }
.z-50 { z-index: 50; }
.z-\\[60\\] { z-index: 60; }

/* sizing */
.w-full { width: 100%; }
.h-full { height: 100%; }
.aspect-video { aspect-ratio: 16 / 9; }
.object-cover { object-fit: cover; }
.max-h-\\[80vh\\] { max-height: 80vh; }
.max-h-\\[85vh\\] { max-height: 85vh; }
.max-w-3xl { max-width: 48rem; }
.max-w-4xl { max-width: 56rem; }
.max-w-md { max-width: 28rem; }
.max-w-\\[220px\\] { max-width: 220px; }
.max-w-\\[420px\\] { max-width: 420px; }

/* text */
.text-xs { font-size: .75rem; line-height: 1rem; }
.text-sm { font-size: .875rem; line-height: 1.25rem; }
.text-lg { font-size: 1.125rem; line-height: 1.75rem; }
.text-xl { font-size: 1.25rem; line-height: 1.75rem; }
.text-2xl { font-size: 1.5rem; line-height: 2rem; }
.text-\\[10px\\] { font-size: 10px; }
.text-\\[11px\\] { font-size: 11px; }
.text-\\[12px\\] { font-size: 12px; }
.font-bold { font-weight: 700; }
.font-semibold { font-weight: 600; }
.font-medium { font-weight: 500; }
.font-normal { font-weight: 400; }
.text-left { text-align: left; }
.text-center { text-align: center; }
.text-right { text-align: right; }
.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.whitespace-nowrap { white-space: nowrap; }
.underline { text-decoration: underline; }
.uppercase { text-transform: uppercase; }
.capitalize { text-transform: capitalize; }
.tracking-wide { letter-spacing: .025em; }
.tracking-wider { letter-spacing: .05em; }
.leading-relaxed { line-height: 1.625; }

/* misc */
.cursor-pointer { cursor: pointer; }
.select-none { user-select: none; }
.pointer-events-none { pointer-events: none; }
.outline-none { outline: none; }
.shadow-xl { box-shadow: 0 20px 25px -5px rgba(0,0,0,.4), 0 8px 10px -6px rgba(0,0,0,.4); }
.overflow-hidden { overflow: hidden; }
.overflow-x-auto { overflow-x: auto; }
.overflow-y-auto { overflow-y: auto; }
.transition-all { transition: all 150ms ease; }
.transition-colors { transition: color 150ms ease, background-color 150ms ease, border-color 150ms ease; }
.accent-brand { accent-color: var(--uf-brand); }
.opacity-50 { opacity: .5; }
.ring-1 { box-shadow: 0 0 0 1px var(--uf-ring, transparent); }
.ring-2 { box-shadow: 0 0 0 2px var(--uf-ring, transparent); }
.ring-brand\\/30 { --uf-ring: rgba(0,111,255,.3); }
.ring-brand\\/70 { --uf-ring: rgba(0,111,255,.7); }

/* hover / focus / disabled */
.hover\\:bg-surface-overlay:hover { background: var(--uf-surface-overlay); }
.hover\\:bg-brand\\/10:hover { background: rgba(0,111,255,.1); }
.hover\\:bg-brand\\/20:hover { background: rgba(0,111,255,.2); }
.hover\\:border-brand\\/40:hover { border-color: rgba(0,111,255,.4); }
.hover\\:border-brand\\/50:hover { border-color: rgba(0,111,255,.5); }
.hover\\:border-status-crit\\/50:hover { border-color: rgba(248,113,113,.5); }
.hover\\:text-ink:hover { color: var(--uf-ink); }
.hover\\:text-white:hover { color: #fff; }
.hover\\:text-status-crit:hover { color: var(--uf-crit); }
.hover\\:underline:hover { text-decoration: underline; }
.hover\\:ring-1:hover { box-shadow: 0 0 0 1px var(--uf-ring, transparent); }
.hover\\:ring-brand\\/30:hover { --uf-ring: rgba(0,111,255,.3); }
.focus\\:border-brand\\/60:focus { border-color: rgba(0,111,255,.6); }
.disabled\\:opacity-50:disabled { opacity: .5; }
.disabled\\:cursor-default:disabled { cursor: default; }

.uf-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.uf-scroll::-webkit-scrollbar-track { background: transparent; }
.uf-scroll::-webkit-scrollbar-thumb { background: #2A3845; border-radius: 4px; border: 2px solid var(--uf-surface-base); }
.uf-scroll::-webkit-scrollbar-thumb:hover { background: #3B4D5E; }

.uf-input {
  width: 100%;
  background: var(--uf-surface-overlay);
  border: 1px solid var(--uf-border);
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 13px;
  color: var(--uf-ink);
  outline: none;
  box-sizing: border-box;
}
.uf-input:focus { border-color: rgba(0,111,255,0.6); }

.uf-btn-ghost {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  border: 1px solid var(--uf-border);
  background: transparent;
  color: var(--uf-ink-muted);
  cursor: pointer;
  transition: color 150ms, border-color 150ms;
}
.uf-btn-ghost:hover { color: var(--uf-ink); border-color: rgba(0,111,255,0.4); }
.uf-btn-ghost:disabled { opacity: 0.5; cursor: default; }

.uf-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 11px;
  font-weight: 500;
  border: 1px solid transparent;
}

@media (prefers-reduced-motion: reduce) {
  .uf-root *, .uf-root *::before, .uf-root *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
  .animate-fade-in, .animate-spin { animation: none !important; }
}
` + spacingCss();

export function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/* ────────────────────────────────────────────────────────────────────────
 * classnames joiner
 * ────────────────────────────────────────────────────────────────────── */
export function cls(...args) {
  return args.filter(Boolean).join(' ');
}

/* ────────────────────────────────────────────────────────────────────────
 * apiFetch / apiFetchBlob — base '/api', auto CSRF on non-GET.
 * ────────────────────────────────────────────────────────────────────── */
function csrfToken() {
  return typeof window !== 'undefined' ? window.__ICC_CSRF_TOKEN__ : null;
}

export async function apiFetch(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const headers = { ...(opts.headers || {}) };
  let body = opts.body;
  if (body !== undefined && typeof body !== 'string' && !(typeof FormData !== 'undefined' && body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  if (method !== 'GET' && csrfToken()) headers['x-csrf-token'] = csrfToken();
  const res = await fetch(`/api${path}`, { credentials: 'include', ...opts, method, headers, body });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    const err = new Error(payload.error || `Request failed: ${res.status}`);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

export async function apiFetchBlob(path) {
  const res = await fetch(`/api${path}`, { credentials: 'include' });
  if (!res.ok) {
    const err = new Error(`Request failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.blob();
}

/* ────────────────────────────────────────────────────────────────────────
 * Formatting helpers (pinned + a handful of extras useful across pages)
 * ────────────────────────────────────────────────────────────────────── */
export function fmtNum(n) {
  return n == null ? '—' : Number(n).toLocaleString();
}

export function fmtBytes(b) {
  if (b == null) return '—';
  const n = Number(b);
  if (!Number.isFinite(n)) return '—';
  const gb = n / 1e9;
  if (gb >= 1000) return `${(n / 1e12).toLocaleString(undefined, { maximumFractionDigits: 1 })} TB`;
  if (gb >= 1) return `${gb.toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  return `${(n / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
}

export function fmtPct(p) {
  return p == null ? '—' : `${Number(p).toFixed(1)}%`;
}

export function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).includes('T') ? iso : `${iso}Z`.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

export function secsToHuman(s) {
  if (s == null) return '—';
  const n = Number(s);
  if (!Number.isFinite(n)) return '—';
  if (n < 60) return `${Math.round(n)}s`;
  if (n < 3600) return `${Math.round(n / 60)}m`;
  if (n < 86400) return `${Math.round(n / 3600)}h`;
  return `${Math.round(n / 86400)}d`;
}

export function severityTone(sev) {
  const s = String(sev || '').toLowerCase();
  return s === 'critical' ? 'crit' : s === 'warning' ? 'warn' : 'info';
}

export function usageTone(pct) {
  if (pct == null) return 'neutral';
  if (pct > 90) return 'crit';
  if (pct > 80) return 'warn';
  return 'ok';
}

export function parseJsonArr(s) {
  if (!s) return [];
  if (Array.isArray(s)) return s;
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

export function parseJsonObj(s) {
  if (!s) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return null; }
}

// Device state: numeric, 1 = connected.
export function stateTone(device) {
  if (device.state !== 1) return 'crit';
  if (device.overheating) return 'warn';
  return 'ok';
}

export function stateLabel(device) {
  if (device.state !== 1) return 'OFFLINE';
  if (device.overheating) return 'OVERHEATING';
  return 'ONLINE';
}

export const TYPE_LABEL = { udm: 'Gateway', usw: 'Switch', uap: 'Access Point' };

export function typeLabel(type) {
  return TYPE_LABEL[type] || (type || '—').toUpperCase();
}

export function typeTone(type) {
  if (type === 'udm') return 'info';
  if (type === 'usw') return 'neutral';
  if (type === 'uap') return 'ok';
  return 'neutral';
}

export function signalTone(rssiOrSignal) {
  if (rssiOrSignal == null) return 'neutral';
  const s = Number(rssiOrSignal);
  if (s >= -60) return 'ok';
  if (s >= -70) return 'warn';
  return 'crit';
}

export function signalBucket(signal) {
  if (signal == null) return 'poor';
  const s = Number(signal);
  if (s >= -50) return 'excellent';
  if (s >= -60) return 'good';
  if (s >= -70) return 'fair';
  return 'poor';
}

export function poeWatts(port) {
  const w = parseFloat(port?.poe_power);
  return Number.isFinite(w) ? w : null;
}

export function counterDelta(prev, cur, key) {
  if (prev == null || cur == null) return null;
  const a = Number(prev[key]);
  const b = Number(cur[key]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const d = b - a;
  return d < 0 ? null : d;
}

/* ────────────────────────────────────────────────────────────────────────
 * Inline-SVG icon primitive (icons.jsx owns the named icon set)
 * ────────────────────────────────────────────────────────────────────── */
function LoaderGlyph(p) {
  return (
    <svg width={p.size || 16} height={p.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={p.style} className={p.className}>
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </svg>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Primitives
 * ────────────────────────────────────────────────────────────────────── */

export function PageHeader({ icon: IconComp, title, description, children }) {
  return (
    <div className="animate-fade-in" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, minWidth: 0 }}>
        {IconComp && (
          <div style={{ marginTop: 2, display: 'flex', height: 36, width: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'rgba(0,111,255,0.1)', border: '1px solid rgba(0,111,255,0.2)', flexShrink: 0 }}>
            <IconComp size={18} style={{ color: 'var(--uf-brand)' }} />
          </div>
        )}
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: 18, fontWeight: 700, color: 'var(--uf-ink)', lineHeight: 1.2, margin: 0 }}>{title}</h1>
          {description && <p style={{ fontSize: 12, color: 'var(--uf-ink-muted)', margin: '2px 0 0' }}>{description}</p>}
        </div>
      </div>
      {children && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{children}</div>}
    </div>
  );
}

const TONE = {
  default: { icon: 'var(--uf-ink-muted)', iconBg: 'var(--uf-surface-overlay)', iconBorder: 'var(--uf-border)' },
  neutral: { icon: 'var(--uf-ink-muted)', iconBg: 'var(--uf-surface-overlay)', iconBorder: 'var(--uf-border)' },
  brand: { icon: 'var(--uf-brand)', iconBg: 'rgba(0,111,255,0.1)', iconBorder: 'rgba(0,111,255,0.2)' },
  ok: { icon: 'var(--uf-ok)', iconBg: 'rgba(52,211,153,0.1)', iconBorder: 'rgba(52,211,153,0.2)' },
  warn: { icon: 'var(--uf-warn)', iconBg: 'rgba(251,191,36,0.1)', iconBorder: 'rgba(251,191,36,0.2)' },
  crit: { icon: 'var(--uf-crit)', iconBg: 'rgba(248,113,113,0.1)', iconBorder: 'rgba(248,113,113,0.2)' },
  info: { icon: 'var(--uf-info)', iconBg: 'rgba(96,165,250,0.1)', iconBorder: 'rgba(96,165,250,0.2)' },
};

export function StatCard({ icon: IconComp, label, value, sub, tone = 'default', onClick, loading }) {
  const t = TONE[tone] || TONE.default;
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      onClick={onClick}
      className={onClick ? 'panel' : 'panel'}
      style={{
        padding: '14px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        textAlign: 'left',
        width: '100%',
        cursor: onClick ? 'pointer' : 'default',
        font: 'inherit',
        border: 'none',
      }}
    >
      {IconComp && (
        <div style={{ display: 'flex', height: 40, width: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: `1px solid ${t.iconBorder}`, background: t.iconBg, flexShrink: 0 }}>
          <IconComp size={19} style={{ color: t.icon }} />
        </div>
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--uf-ink-faint)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</p>
        {loading ? (
          <div style={{ height: 24, width: 80, marginTop: 4, borderRadius: 6, background: 'var(--uf-surface-overlay)' }} />
        ) : (
          <p className="tnum" style={{ fontSize: 20, fontWeight: 700, color: 'var(--uf-ink)', lineHeight: 1.2, margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</p>
        )}
        {sub && !loading && (
          <p style={{ fontSize: 11, color: 'var(--uf-ink-muted)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</p>
        )}
      </div>
    </Tag>
  );
}

const BADGE_TONES = {
  ok: { bg: 'rgba(52,211,153,0.1)', color: 'var(--uf-ok)', border: 'rgba(52,211,153,0.25)' },
  warn: { bg: 'rgba(251,191,36,0.1)', color: 'var(--uf-warn)', border: 'rgba(251,191,36,0.25)' },
  crit: { bg: 'rgba(248,113,113,0.1)', color: 'var(--uf-crit)', border: 'rgba(248,113,113,0.25)' },
  info: { bg: 'rgba(96,165,250,0.1)', color: 'var(--uf-info)', border: 'rgba(96,165,250,0.25)' },
  brand: { bg: 'rgba(0,111,255,0.1)', color: 'var(--uf-brand)', border: 'rgba(0,111,255,0.25)' },
  neutral: { bg: 'var(--uf-surface-overlay)', color: 'var(--uf-ink-muted)', border: 'var(--uf-border)' },
};

export function Badge({ tone = 'neutral', children, style, className }) {
  const t = BADGE_TONES[tone] || BADGE_TONES.neutral;
  return (
    <span className={cls('uf-chip', className)} style={{ background: t.bg, color: t.color, borderColor: t.border, ...style }}>
      {children}
    </span>
  );
}

export function Spinner({ size = 16, style }) {
  return <LoaderGlyph size={size} style={{ color: 'var(--uf-brand)', animation: 'uf-spin 0.8s linear infinite', ...style }} />;
}

export function LoadingPanel({ label = 'Loading data…', height = 200 }) {
  return (
    <div role="status" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, height }}>
      <Spinner size={22} />
      <p style={{ fontSize: 12, color: 'var(--uf-ink-muted)', margin: 0 }}>{label}</p>
    </div>
  );
}

export function RefreshButton({ onClick, refreshing, label = 'Refresh' }) {
  return (
    <button onClick={onClick} disabled={refreshing} className="uf-btn-ghost">
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={refreshing ? { animation: 'uf-spin 0.8s linear infinite' } : undefined}>
        <path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" />
      </svg>
      {refreshing ? 'Refreshing…' : label}
    </button>
  );
}

function timeAgo(date) {
  if (!date) return null;
  const raw = typeof date === 'string' && !date.includes('T') ? date.replace(' ', 'T') + 'Z' : date;
  const ms = new Date(raw).getTime();
  if (Number.isNaN(ms)) return null;
  const secs = Math.round((Date.now() - ms) / 1000);
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function LastUpdated({ date, prefix = 'Updated' }) {
  const [, tick] = React.useState(0);
  React.useEffect(() => {
    if (!date) return;
    const t = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, [date]);
  if (!date) return null;
  const label = timeAgo(date);
  if (!label) return null;
  return (
    <span className="tnum" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--uf-ink-faint)' }}>
      {prefix && <span>{prefix}</span>}
      <span>{label}</span>
    </span>
  );
}

export function Panel({ accent = null, children, className = '', style }) {
  return (
    <div className={cls('panel', className)} style={{ ...(accent ? { borderTop: `3px solid ${accent}` } : {}), ...style }}>
      {children}
    </div>
  );
}

export function Fact({ label, value }) {
  return (
    <div>
      <p style={{ margin: 0, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--uf-ink-faint)' }}>{label}</p>
      <p className="tnum" style={{ margin: 0, fontSize: 13, color: 'var(--uf-ink)' }}>{value ?? '—'}</p>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Modal — portaled to document.body WHEN the host exposes createPortal.
 * The host's window.ReactDOM is react-dom/client (createRoot only), which
 * has NO createPortal — calling it unguarded crashes the page ("not a
 * function", hit live on the demo install 2026-08-12). The inline fixed
 * overlay fallback renders identically except on transformed ancestors.
 * ────────────────────────────────────────────────────────────────────── */
export function portalOrInline(node) {
  const rd = typeof window !== 'undefined' ? window.ReactDOM : null;
  if (rd && typeof rd.createPortal === 'function') return rd.createPortal(node, document.body);
  return node;
}

export function Modal({ title, subtitle, icon: IconComp, onClose, children, maxWidth = 'min(720px,92vw)' }) {
  return portalOrInline(
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} role="dialog" aria-modal="true">
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.65)', backdropFilter: 'blur(4px)' }} onClick={onClose} />
      <div className="panel" style={{ position: 'relative', width: maxWidth, maxHeight: '85vh', display: 'flex', flexDirection: 'column', borderTop: `3px solid ${BRAND}` }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, padding: '16px 16px 12px', borderBottom: '1px solid var(--uf-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            {IconComp && <IconComp size={17} style={{ color: 'var(--uf-brand)', flexShrink: 0 }} />}
            <div style={{ minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--uf-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</p>
              {subtitle && <p style={{ margin: 0, fontSize: 11, color: 'var(--uf-ink-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{subtitle}</p>}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 28, width: 28, borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--uf-ink-faint)', cursor: 'pointer', flexShrink: 0 }}>
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="uf-scroll" style={{ padding: 16, overflowY: 'auto' }}>{children}</div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * tableTools — mirror host frontend/src/components/ui/tableTools.jsx API.
 * ────────────────────────────────────────────────────────────────────── */

export function useTableControls(rows, { searchKeys = [], defaultSortKey = null, defaultSortDir = 'asc', sortValues = {}, paginate = false, defaultPageSize = 25 } = {}) {
  const [q, setQ] = React.useState(() => {
    try { return new URLSearchParams(window.location.search).get('q') || ''; } catch { return ''; }
  });
  const [filters, setFilters] = React.useState({});
  const [sortKey, setSortKey] = React.useState(defaultSortKey);
  const [sortDir, setSortDir] = React.useState(defaultSortDir);
  const [page, setPage] = React.useState(0);
  const [pageSize, setPageSize] = React.useState(defaultPageSize);

  const out = React.useMemo(() => {
    let list = rows || [];
    for (const [k, v] of Object.entries(filters)) {
      if (v !== '' && v != null) list = list.filter((r) => String(r[k] ?? '') === v);
    }
    const term = q.trim().toLowerCase();
    if (term && searchKeys.length) {
      list = list.filter((r) => searchKeys.some((k) => String(r[k] ?? '').toLowerCase().includes(term)));
    }
    if (sortKey) {
      const dir = sortDir === 'asc' ? 1 : -1;
      const get = sortValues[sortKey] || ((r) => r[sortKey]);
      list = [...list].sort((a, b) => {
        const av = get(a);
        const bv = get(b);
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
        return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }) * dir;
      });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, q, filters, sortKey, sortDir]);

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };
  const setFilter = (key, value) => setFilters((f) => ({ ...f, [key]: value }));

  React.useEffect(() => { setPage(0); }, [q, filters, sortKey, sortDir, pageSize]);

  const pageCount = paginate && pageSize !== 'all' ? Math.max(1, Math.ceil(out.length / pageSize)) : 1;
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = React.useMemo(
    () => (!paginate || pageSize === 'all' ? out : out.slice(safePage * pageSize, (safePage + 1) * pageSize)),
    [out, paginate, pageSize, safePage]
  );

  return { rows: out, q, setQ, filters, setFilter, sortKey, sortDir, toggleSort, paginate, pageRows, page: safePage, setPage, pageSize, setPageSize, pageCount };
}

export function SortTh({ k, label, ctl, align = 'left', style }) {
  const active = ctl.sortKey === k;
  return (
    <th className={cls('py-2 pr-3', align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left')} style={style}>
      <button
        onClick={() => ctl.toggleSort(k)}
        className="uppercase tracking-wide"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: 'none', background: 'transparent', color: active ? 'var(--uf-ink)' : 'var(--uf-ink-muted)', padding: 0 }}
      >
        {label}
        {active && (
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {ctl.sortDir === 'asc' ? <path d="M18 15l-6-6-6 6" /> : <path d="M6 9l6 6 6-6" />}
          </svg>
        )}
      </button>
    </th>
  );
}

export function TableSearch({ ctl, placeholder = 'Search…', className }) {
  return (
    <div className={className || 'w-full max-w-md'} style={{ position: 'relative' }}>
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--uf-ink-faint)', pointerEvents: 'none' }}>
        <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
      </svg>
      <input value={ctl.q} onChange={(e) => ctl.setQ(e.target.value)} placeholder={placeholder} className="uf-input" style={{ paddingLeft: 32 }} />
    </div>
  );
}

export function FilterSelect({ ctl, k, rows, label }) {
  const options = React.useMemo(
    () => [...new Set((rows || []).map((r) => r[k]).filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    [rows, k]
  );
  if (options.length < 2) return null;
  return (
    <select value={ctl.filters[k] || ''} onChange={(e) => ctl.setFilter(k, e.target.value)} className="uf-input" style={{ width: 'auto', cursor: 'pointer' }}>
      <option value="">All {label}</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

export function TableControls({ ctl, rows, searchPlaceholder, filters = [] }) {
  const total = (rows || []).length;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12 }}>
      <TableSearch ctl={ctl} placeholder={searchPlaceholder} />
      {filters.map((f) => <FilterSelect key={f.k} ctl={ctl} k={f.k} rows={rows} label={f.label} />)}
      <span className="tnum" style={{ fontSize: 11, color: 'var(--uf-ink-faint)', marginLeft: 'auto' }}>
        {ctl.rows.length === total ? `${total} rows` : `${ctl.rows.length} of ${total} rows`}
      </span>
    </div>
  );
}

const PAGE_SIZES = [25, 50, 100, 'all'];
const pagerBtnStyle = { fontSize: 11, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--uf-border)', background: 'transparent', color: 'var(--uf-ink-muted)', cursor: 'pointer' };

export function TablePager({ ctl, sizes = PAGE_SIZES }) {
  const total = ctl.rows.length;
  if (!ctl.paginate || total <= sizes[0]) return null;
  const all = ctl.pageSize === 'all';
  const start = all ? 1 : ctl.page * ctl.pageSize + 1;
  const end = all ? total : Math.min((ctl.page + 1) * ctl.pageSize, total);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingTop: 12, marginTop: 4, borderTop: '1px solid var(--uf-border)' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--uf-ink-faint)' }}>
        Rows per page
        <select value={String(ctl.pageSize)} onChange={(e) => ctl.setPageSize(e.target.value === 'all' ? 'all' : Number(e.target.value))} className="uf-input" style={{ width: 'auto', padding: '4px 8px', cursor: 'pointer' }}>
          {sizes.map((s) => <option key={s} value={String(s)}>{s === 'all' ? 'All' : s}</option>)}
        </select>
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="tnum" style={{ fontSize: 11, color: 'var(--uf-ink-faint)' }}>{start}–{end} of {total}</span>
        {!all && ctl.pageCount > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button onClick={() => ctl.setPage(0)} disabled={ctl.page === 0} style={pagerBtnStyle}>«</button>
            <button onClick={() => ctl.setPage(ctl.page - 1)} disabled={ctl.page === 0} style={pagerBtnStyle}>‹</button>
            <span className="tnum" style={{ fontSize: 11, color: 'var(--uf-ink-faint)', padding: '0 4px' }}>{ctl.page + 1} / {ctl.pageCount}</span>
            <button onClick={() => ctl.setPage(ctl.page + 1)} disabled={ctl.page >= ctl.pageCount - 1} style={pagerBtnStyle}>›</button>
            <button onClick={() => ctl.setPage(ctl.pageCount - 1)} disabled={ctl.page >= ctl.pageCount - 1} style={pagerBtnStyle}>»</button>
          </div>
        )}
      </div>
    </div>
  );
}
