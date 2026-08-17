// Aria Automation plugin style kit. No Tailwind build step is available
// inside a plugin bundle, so this installs a hand-rolled utility stylesheet
// that mirrors the class *names* the built-in frontend/src/pages/aria/*
// pages already use (panel, text-ink, text-ink-muted, tnum, grid-cols-2,
// ...). That lets pages/* here port from the built-in JSX with mostly an
// import swap instead of a full inline-style rewrite. Mirrors
// plugin-sdk/dell/frontend/src/ui.jsx exactly, renamed dl- -> ar-, rebranded
// to Aria Automation teal (#00A2C7), plus useVisibleColumns/ColumnPicker/
// CsvExportButton (ported from frontend/src/components/ui/tableTools.jsx —
// needed by AriaInfrastructurePage's Fabric Images table) using
// portalOrInline instead of the host's raw createPortal.
//
// React/ReactDOM/ReactRouterDOM/Chart come from window globals injected by
// esbuild `define` at build time (see plugin-sdk/build.mjs) — no imports.

export const BRAND = '#00A2C7';

const STYLE_ID = 'ar-plugin-styles';

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
  --ar-surface-base: #0B1015;
  --ar-surface: #131B23;
  --ar-surface-raised: #18222C;
  --ar-surface-overlay: #1E2A36;
  --ar-border: #1F2B37;
  --ar-gray: #131B23;
  --ar-ink: #E8EDF2;
  --ar-ink-muted: #94A3B3;
  --ar-ink-faint: #5F7081;
  --ar-brand: ${BRAND};
  --ar-brand-dark: #00789B;
  --ar-ok: #34D399;
  --ar-warn: #FBBF24;
  --ar-crit: #F87171;
  --ar-info: #60A5FA;
}

.ar-root { font-family: inherit; color: var(--ar-ink); }

/* component classes used by ported page bodies */
.panel { background: var(--ar-surface); border: 1px solid var(--ar-border); border-radius: 12px; box-shadow: 0 1px 2px rgba(0,0,0,.4), inset 0 0 0 1px rgba(255,255,255,.02); }
.tnum { font-variant-numeric: tabular-nums; }
.animate-fade-in { animation: ar-fade-in 220ms ease-out both; }
.animate-spin { animation: ar-spin 0.8s linear infinite; }
@keyframes ar-fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes ar-spin { to { transform: rotate(360deg); } }

/* colors */
.text-ink { color: var(--ar-ink); }
.text-ink-muted { color: var(--ar-ink-muted); }
.text-ink-faint { color: var(--ar-ink-faint); }
.text-brand { color: var(--ar-brand); }
.text-status-ok { color: var(--ar-ok); }
.text-status-warn { color: var(--ar-warn); }
.text-status-crit { color: var(--ar-crit); }
.text-status-bad { color: var(--ar-crit); }
.text-status-info { color: var(--ar-info); }
.text-white { color: #fff; }
.text-white\\/80 { color: rgba(255,255,255,.8); }
.bg-black\\/40 { background: rgba(0,0,0,.4); }
.bg-black\\/50 { background: rgba(0,0,0,.5); }
.bg-black\\/60 { background: rgba(0,0,0,.6); }
.bg-brand { background: var(--ar-brand); }
.text-cohesity-black { color: #1A1A1A; }
.bg-brand\\/10 { background: rgba(0,162,199,.1); }
.bg-brand\\/20 { background: rgba(0,162,199,.2); }
.bg-status-ok { background: var(--ar-ok); }
.bg-status-crit { background: var(--ar-crit); }
.bg-status-ok\\/10 { background: rgba(52,211,153,.1); }
.bg-status-warn\\/10 { background: rgba(251,191,36,.1); }
.bg-status-warn\\/5 { background: rgba(251,191,36,.05); }
.bg-status-crit\\/5 { background: rgba(248,113,113,.05); }
.bg-status-crit\\/10 { background: rgba(248,113,113,.1); }
.bg-cohesity-gray { background: var(--ar-gray); }
.bg-surface-overlay { background: var(--ar-surface-overlay); }
.bg-surface { background: var(--ar-surface); }
.bg-white { background: #fff; }

/* borders */
.border { border: 1px solid var(--ar-border); }
.border-b { border-bottom: 1px solid var(--ar-border); }
.border-t { border-top: 1px solid var(--ar-border); }
.border-l { border-left: 1px solid var(--ar-border); }
.border-transparent { border-color: transparent; }
.border-cohesity-border { border-color: var(--ar-border); }
.border-cohesity-border\\/40 { border-color: rgba(31,43,55,.4); }
.border-cohesity-border\\/50 { border-color: rgba(31,43,55,.5); }
.border-brand\\/20 { border-color: rgba(0,162,199,.2); }
.border-brand\\/30 { border-color: rgba(0,162,199,.3); }
.border-brand\\/40 { border-color: rgba(0,162,199,.4); }
.border-brand\\/50 { border-color: rgba(0,162,199,.5); }
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
.min-w-\\[220px\\] { min-width: 220px; }
.w-fit { width: fit-content; }
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
  .lg\\:grid-cols-1 { grid-template-columns: repeat(1,minmax(0,1fr)); }
  .lg\\:grid-cols-2 { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .lg\\:grid-cols-3 { grid-template-columns: repeat(3,minmax(0,1fr)); }
  .lg\\:grid-cols-4 { grid-template-columns: repeat(4,minmax(0,1fr)); }
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
.max-w-2xl { max-width: 42rem; }
.max-w-3xl { max-width: 48rem; }
.max-w-4xl { max-width: 56rem; }
.max-w-5xl { max-width: 64rem; }
.max-w-lg { max-width: 32rem; }
.max-w-md { max-width: 28rem; }
.max-w-\\[180px\\] { max-width: 180px; }
.max-w-\\[200px\\] { max-width: 200px; }
.max-w-\\[220px\\] { max-width: 220px; }
.max-w-\\[240px\\] { max-width: 240px; }
.max-w-\\[260px\\] { max-width: 260px; }
.max-w-\\[280px\\] { max-width: 280px; }
.max-w-\\[300px\\] { max-width: 300px; }
.max-w-\\[320px\\] { max-width: 320px; }
.max-w-\\[380px\\] { max-width: 380px; }
.max-w-\\[420px\\] { max-width: 420px; }
.max-w-\\[460px\\] { max-width: 460px; }

/* text */
.text-xs { font-size: .75rem; line-height: 1rem; }
.text-sm { font-size: .875rem; line-height: 1.25rem; }
.text-base { font-size: 1rem; line-height: 1.5rem; }
.text-lg { font-size: 1.125rem; line-height: 1.75rem; }
.text-xl { font-size: 1.25rem; line-height: 1.75rem; }
.text-2xl { font-size: 1.5rem; line-height: 2rem; }
.text-\\[10px\\] { font-size: 10px; }
.text-\\[11px\\] { font-size: 11px; }
.text-\\[12px\\] { font-size: 12px; }
.text-\\[13px\\] { font-size: 13px; }
.font-bold { font-weight: 700; }
.font-semibold { font-weight: 600; }
.font-medium { font-weight: 500; }
.font-normal { font-weight: 400; }
.text-left { text-align: left; }
.text-center { text-align: center; }
.text-right { text-align: right; }
.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.whitespace-nowrap { white-space: nowrap; }
.whitespace-pre-wrap { white-space: pre-wrap; }
.underline { text-decoration: underline; }
.decoration-dotted { text-decoration-style: dotted; }
.underline-offset-2 { text-underline-offset: 2px; }
.break-words { overflow-wrap: break-word; }
.break-all { word-break: break-all; }
.uppercase { text-transform: uppercase; }
.capitalize { text-transform: capitalize; }
.tracking-wide { letter-spacing: .025em; }
.tracking-wider { letter-spacing: .05em; }
.leading-relaxed { line-height: 1.625; }
.leading-snug { line-height: 1.375; }

/* misc */
.cursor-pointer { cursor: pointer; }
.cursor-not-allowed { cursor: not-allowed; }
.select-none { user-select: none; }
.pointer-events-none { pointer-events: none; }
.outline-none { outline: none; }
.shadow-xl { box-shadow: 0 20px 25px -5px rgba(0,0,0,.4), 0 8px 10px -6px rgba(0,0,0,.4); }
.shadow-panel { box-shadow: 0 1px 2px rgba(0,0,0,.4), inset 0 0 0 1px rgba(255,255,255,.02); }
.overflow-hidden { overflow: hidden; }
.overflow-x-auto { overflow-x: auto; }
.overflow-y-auto { overflow-y: auto; }
.transition-all { transition: all 150ms ease; }
.transition-colors { transition: color 150ms ease, background-color 150ms ease, border-color 150ms ease; }
.transition-opacity { transition: opacity 150ms ease; }
.duration-150 { transition-duration: 150ms; }
.accent-brand { accent-color: var(--ar-brand); }
.accent-current { accent-color: currentColor; }
.opacity-50 { opacity: .5; }
.ring-1 { box-shadow: 0 0 0 1px var(--ar-ring, transparent); }
.ring-2 { box-shadow: 0 0 0 2px var(--ar-ring, transparent); }
.ring-brand\\/30 { --ar-ring: rgba(0,162,199,.3); }
.ring-brand\\/70 { --ar-ring: rgba(0,162,199,.7); }

/* hover / focus / disabled */
.hover\\:bg-surface-overlay:hover { background: var(--ar-surface-overlay); }
.hover\\:bg-surface-overlay\\/70:hover { background: rgba(30,42,54,.7); }
.hover\\:bg-brand\\/10:hover { background: rgba(0,162,199,.1); }
.hover\\:bg-brand\\/20:hover { background: rgba(0,162,199,.2); }
.hover\\:border-brand\\/40:hover { border-color: rgba(0,162,199,.4); }
.hover\\:border-brand\\/50:hover { border-color: rgba(0,162,199,.5); }
.hover\\:border-status-crit\\/50:hover { border-color: rgba(248,113,113,.5); }
.hover\\:text-ink:hover { color: var(--ar-ink); }
.hover\\:text-white:hover { color: #fff; }
.hover\\:text-brand:hover { color: var(--ar-brand); }
.hover\\:text-status-crit:hover { color: var(--ar-crit); }
.hover\\:underline:hover { text-decoration: underline; }
.hover\\:ring-1:hover { box-shadow: 0 0 0 1px var(--ar-ring, transparent); }
.hover\\:ring-brand\\/30:hover { --ar-ring: rgba(0,162,199,.3); }
.hover\\:-translate-y-0\\.5:hover { transform: translateY(-2px); }
.focus\\:border-brand\\/60:focus { border-color: rgba(0,162,199,.6); }
.disabled\\:opacity-50:disabled { opacity: .5; }
.disabled\\:cursor-default:disabled { cursor: default; }

.ar-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.ar-scroll::-webkit-scrollbar-track { background: transparent; }
.ar-scroll::-webkit-scrollbar-thumb { background: #2A3845; border-radius: 4px; border: 2px solid var(--ar-surface-base); }
.ar-scroll::-webkit-scrollbar-thumb:hover { background: #3B4D5E; }

.ar-input {
  width: 100%;
  background: var(--ar-surface-overlay);
  border: 1px solid var(--ar-border);
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 13px;
  color: var(--ar-ink);
  outline: none;
  box-sizing: border-box;
}
.ar-input:focus { border-color: rgba(0,162,199,0.6); }

.ar-btn-ghost {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  border: 1px solid var(--ar-border);
  background: transparent;
  color: var(--ar-ink-muted);
  cursor: pointer;
  transition: color 150ms, border-color 150ms;
}
.ar-btn-ghost:hover { color: var(--ar-ink); border-color: rgba(0,162,199,0.4); }
.ar-btn-ghost:disabled { opacity: 0.5; cursor: default; }

.ar-chip {
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
  .ar-root *, .ar-root *::before, .ar-root *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
  .animate-fade-in, .animate-spin { animation: none !important; }
}
` + spacingCss();

/* Responsive variants re-declared LAST so they beat base utilities of equal
 * specificity (Tailwind's own emit order). Without this, `.w-full` (declared
 * after the earlier media blocks) overrode `md:w-48` and collapsed every
 * side-menu + content layout — the "empty settings page" bug (unifi 1.0.2). */
const RESPONSIVE_LAST = `
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
  .lg\\:grid-cols-1 { grid-template-columns: repeat(1,minmax(0,1fr)); }
  .lg\\:grid-cols-2 { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .lg\\:grid-cols-3 { grid-template-columns: repeat(3,minmax(0,1fr)); }
  .lg\\:grid-cols-4 { grid-template-columns: repeat(4,minmax(0,1fr)); }
  .lg\\:grid-cols-5 { grid-template-columns: repeat(5,minmax(0,1fr)); }
  .lg\\:col-span-2 { grid-column: span 2 / span 2; }
}
`;

/* Scope every rule under .ar-root so the utility vocabulary (w-full, flex,
 * panel, ...) cannot leak into HOST pages. Unscoped, this stylesheet loads
 * after the host's Tailwind CSS and its `.w-full` beat the host's own
 * responsive menu widths — which blanked the host Global Settings pages
 * (the unifi 1.0.2 bug). :root var declarations stay global (ar- prefixed,
 * collision-free); @keyframes bodies must not be prefixed. */
function scopeCss(css) {
  const parts = css.split(/(@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\})/g);
  return parts.map((part, i) => {
    if (i % 2 === 1) return part; // @keyframes block — untouched
    return part.replace(/(^|\{|\})(\s*)([^@{}]+?)(\s*\{)/g, (m, brace, ws, sel, open) => {
      const scoped = sel.split(',').map((s) => {
        const t = s.trim();
        if (!t || t === ':root' || t.startsWith('.ar-root')) return t;
        return `.ar-root ${t}`;
      }).join(', ');
      return `${brace}${ws}${scoped}${open}`;
    });
  }).join('');
}

export function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = scopeCss(CSS + RESPONSIVE_LAST);
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

export async function apiFetchBlob(path, opts = {}) {
  const res = await fetch(`/api${path}`, { credentials: 'include', ...opts });
  if (!res.ok) {
    const err = new Error(`Request failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.blob();
}

/* ────────────────────────────────────────────────────────────────────────
 * Formatting helpers — ported from frontend/src/pages/aria/helpers.js,
 * merged here so ui.jsx is the single source (matches the dell pattern).
 * ────────────────────────────────────────────────────────────────────── */
export function fmtNum(n) {
  return n == null ? '—' : Number(n).toLocaleString();
}

export function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).includes('T') ? iso : `${iso}Z`.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

// last_poll_at / captured_at are SQLite datetime('now') — UTC without a zone marker.
export const asDate = (v) => (v ? new Date(String(v).includes('T') ? v : `${String(v).replace(' ', 'T')}Z`) : null);

export function severityTone(sev) {
  return sev === 'error' ? 'crit' : sev === 'warning' ? 'warn' : 'info';
}

// Generic status-string classifier — vRA status vocab is unverified upstream,
// so this matches on substrings rather than an exact enum.
export function statusTone(status) {
  const s = String(status || '').toLowerCase();
  if (/fail|error|reject|unhealthy|down|crit/.test(s)) return 'crit';
  if (/success|complete|active|healthy|approve|ok|up/.test(s)) return 'ok';
  if (/pending|progress|warn|wait/.test(s)) return 'warn';
  return 'neutral';
}

// Days between now and an ISO date (negative = already past). Returns null if unparseable.
export function daysUntil(iso) {
  if (!iso) return null;
  const d = asDate(iso) || new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((d.getTime() - Date.now()) / 86400000);
}

export function leaseTone(daysLeft) {
  if (daysLeft == null) return 'neutral';
  if (daysLeft < 0) return 'crit';
  if (daysLeft <= 7) return 'warn';
  return 'ok';
}

export function certTone(certValidTo, warnDays = 30) {
  const days = daysUntil(certValidTo);
  if (days == null) return 'neutral';
  if (days < 0) return 'crit';
  if (days <= warnDays) return 'warn';
  return 'ok';
}

export function timeAgo(date) {
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

/* ────────────────────────────────────────────────────────────────────────
 * Inline-SVG icon primitives owned locally (icons.jsx owns the named set)
 * ────────────────────────────────────────────────────────────────────── */
function LoaderGlyph(p) {
  return (
    <svg width={p.size || 16} height={p.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={p.style} className={p.className}>
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </svg>
  );
}

function SearchGlyph(p) {
  return (
    <svg width={p.size || 14} height={p.size || 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={p.style}>
      <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
    </svg>
  );
}

function SlidersGlyph(p) {
  return (
    <svg width={p.size || 12} height={p.size || 12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
    </svg>
  );
}

function DownloadGlyph(p) {
  return (
    <svg width={p.size || 12} height={p.size || 12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M4 19h16" />
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
          <div style={{ marginTop: 2, display: 'flex', height: 36, width: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'rgba(0,162,199,0.1)', border: '1px solid rgba(0,162,199,0.2)', flexShrink: 0 }}>
            <IconComp size={18} style={{ color: 'var(--ar-brand)' }} />
          </div>
        )}
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: 18, fontWeight: 700, color: 'var(--ar-ink)', lineHeight: 1.2, margin: 0 }}>{title}</h1>
          {description && <p style={{ fontSize: 12, color: 'var(--ar-ink-muted)', margin: '2px 0 0' }}>{description}</p>}
        </div>
      </div>
      {children && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{children}</div>}
    </div>
  );
}

const TONE = {
  default: { icon: 'var(--ar-ink-muted)', iconBg: 'var(--ar-surface-overlay)', iconBorder: 'var(--ar-border)' },
  neutral: { icon: 'var(--ar-ink-muted)', iconBg: 'var(--ar-surface-overlay)', iconBorder: 'var(--ar-border)' },
  brand: { icon: 'var(--ar-brand)', iconBg: 'rgba(0,162,199,0.1)', iconBorder: 'rgba(0,162,199,0.2)' },
  ok: { icon: 'var(--ar-ok)', iconBg: 'rgba(52,211,153,0.1)', iconBorder: 'rgba(52,211,153,0.2)' },
  warn: { icon: 'var(--ar-warn)', iconBg: 'rgba(251,191,36,0.1)', iconBorder: 'rgba(251,191,36,0.2)' },
  crit: { icon: 'var(--ar-crit)', iconBg: 'rgba(248,113,113,0.1)', iconBorder: 'rgba(248,113,113,0.2)' },
  info: { icon: 'var(--ar-info)', iconBg: 'rgba(96,165,250,0.1)', iconBorder: 'rgba(96,165,250,0.2)' },
};

export function StatCard({ icon: IconComp, label, value, sub, tone = 'default', onClick, loading }) {
  const t = TONE[tone] || TONE.default;
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      onClick={onClick}
      className="panel"
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
        <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ar-ink-faint)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</p>
        {loading ? (
          <div style={{ height: 24, width: 80, marginTop: 4, borderRadius: 6, background: 'var(--ar-surface-overlay)' }} />
        ) : (
          <p className="tnum" style={{ fontSize: 20, fontWeight: 700, color: 'var(--ar-ink)', lineHeight: 1.2, margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</p>
        )}
        {sub && !loading && (
          <p style={{ fontSize: 11, color: 'var(--ar-ink-muted)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</p>
        )}
      </div>
    </Tag>
  );
}

const BADGE_TONES = {
  ok: { bg: 'rgba(52,211,153,0.1)', color: 'var(--ar-ok)', border: 'rgba(52,211,153,0.25)' },
  warn: { bg: 'rgba(251,191,36,0.1)', color: 'var(--ar-warn)', border: 'rgba(251,191,36,0.25)' },
  crit: { bg: 'rgba(248,113,113,0.1)', color: 'var(--ar-crit)', border: 'rgba(248,113,113,0.25)' },
  info: { bg: 'rgba(96,165,250,0.1)', color: 'var(--ar-info)', border: 'rgba(96,165,250,0.25)' },
  brand: { bg: 'rgba(0,162,199,0.1)', color: 'var(--ar-brand)', border: 'rgba(0,162,199,0.25)' },
  neutral: { bg: 'var(--ar-surface-overlay)', color: 'var(--ar-ink-muted)', border: 'var(--ar-border)' },
};

export function Badge({ tone = 'neutral', children, style, className }) {
  const t = BADGE_TONES[tone] || BADGE_TONES.neutral;
  return (
    <span className={cls('ar-chip', className)} style={{ background: t.bg, color: t.color, borderColor: t.border, ...style }}>
      {children}
    </span>
  );
}

export function Spinner({ size = 16, style }) {
  return <LoaderGlyph size={size} style={{ color: 'var(--ar-brand)', animation: 'ar-spin 0.8s linear infinite', ...style }} />;
}

export function LoadingPanel({ label = 'Loading data…', height = 200 }) {
  return (
    <div role="status" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, height }}>
      <Spinner size={22} />
      <p style={{ fontSize: 12, color: 'var(--ar-ink-muted)', margin: 0 }}>{label}</p>
    </div>
  );
}

export function RefreshButton({ onClick, refreshing, label = 'Refresh' }) {
  return (
    <button onClick={onClick} disabled={refreshing} className="ar-btn-ghost">
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={refreshing ? { animation: 'ar-spin 0.8s linear infinite' } : undefined}>
        <path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" />
      </svg>
      {refreshing ? 'Refreshing…' : label}
    </button>
  );
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
    <span className="tnum" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--ar-ink-faint)' }}>
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
      <p style={{ margin: 0, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--ar-ink-faint)' }}>{label}</p>
      <p className="tnum" style={{ margin: 0, fontSize: 13, color: 'var(--ar-ink)' }}>{value ?? '—'}</p>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Modal — portaled to document.body WHEN the host exposes createPortal.
 * The host's window.ReactDOM is react-dom/client (createRoot only), which
 * has NO createPortal — calling it unguarded crashes the page. The inline
 * fixed overlay fallback renders identically except on transformed
 * ancestors.
 * ────────────────────────────────────────────────────────────────────── */
export function portalOrInline(node) {
  // Portaled content lands outside the .ar-root wrapper, so re-wrap it —
  // otherwise the scoped stylesheet (see scopeCss) no longer applies.
  const wrapped = <div className="ar-root">{node}</div>;
  const rd = typeof window !== 'undefined' ? window.ReactDOM : null;
  if (rd && typeof rd.createPortal === 'function') return rd.createPortal(wrapped, document.body);
  return wrapped;
}

export function Modal({ title, subtitle, icon: IconComp, onClose, children, maxWidth = 'min(720px,92vw)' }) {
  return portalOrInline(
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} role="dialog" aria-modal="true">
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.65)', backdropFilter: 'blur(4px)' }} onClick={onClose} />
      <div className="panel" style={{ position: 'relative', width: maxWidth, maxHeight: '85vh', display: 'flex', flexDirection: 'column', borderTop: `3px solid ${BRAND}` }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, padding: '16px 16px 12px', borderBottom: '1px solid var(--ar-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            {IconComp && <IconComp size={17} style={{ color: 'var(--ar-brand)', flexShrink: 0 }} />}
            <div style={{ minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--ar-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</p>
              {subtitle && <p style={{ margin: 0, fontSize: 11, color: 'var(--ar-ink-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{subtitle}</p>}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 28, width: 28, borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--ar-ink-faint)', cursor: 'pointer', flexShrink: 0 }}>
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="ar-scroll" style={{ padding: 16, overflowY: 'auto' }}>{children}</div>
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
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: 'none', background: 'transparent', color: active ? 'var(--ar-ink)' : 'var(--ar-ink-muted)', padding: 0 }}
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
      <SearchGlyph style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ar-ink-faint)', pointerEvents: 'none' }} />
      <input value={ctl.q} onChange={(e) => ctl.setQ(e.target.value)} placeholder={placeholder} className="ar-input" style={{ paddingLeft: 32 }} />
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
    <select value={ctl.filters[k] || ''} onChange={(e) => ctl.setFilter(k, e.target.value)} className="ar-input" style={{ width: 'auto', cursor: 'pointer' }}>
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
      <span className="tnum" style={{ fontSize: 11, color: 'var(--ar-ink-faint)', marginLeft: 'auto' }}>
        {ctl.rows.length === total ? `${total} rows` : `${ctl.rows.length} of ${total} rows`}
      </span>
    </div>
  );
}

const PAGE_SIZES = [25, 50, 100, 'all'];
const pagerBtnStyle = { fontSize: 11, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--ar-border)', background: 'transparent', color: 'var(--ar-ink-muted)', cursor: 'pointer' };

export function TablePager({ ctl, sizes = PAGE_SIZES }) {
  const total = ctl.rows.length;
  if (!ctl.paginate || total <= sizes[0]) return null;
  const all = ctl.pageSize === 'all';
  const start = all ? 1 : ctl.page * ctl.pageSize + 1;
  const end = all ? total : Math.min((ctl.page + 1) * ctl.pageSize, total);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingTop: 12, marginTop: 4, borderTop: '1px solid var(--ar-border)' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--ar-ink-faint)' }}>
        Rows per page
        <select value={String(ctl.pageSize)} onChange={(e) => ctl.setPageSize(e.target.value === 'all' ? 'all' : Number(e.target.value))} className="ar-input" style={{ width: 'auto', padding: '4px 8px', cursor: 'pointer' }}>
          {sizes.map((s) => <option key={s} value={String(s)}>{s === 'all' ? 'All' : s}</option>)}
        </select>
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="tnum" style={{ fontSize: 11, color: 'var(--ar-ink-faint)' }}>{start}–{end} of {total}</span>
        {!all && ctl.pageCount > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button onClick={() => ctl.setPage(0)} disabled={ctl.page === 0} style={pagerBtnStyle}>«</button>
            <button onClick={() => ctl.setPage(ctl.page - 1)} disabled={ctl.page === 0} style={pagerBtnStyle}>‹</button>
            <span className="tnum" style={{ fontSize: 11, color: 'var(--ar-ink-faint)', padding: '0 4px' }}>{ctl.page + 1} / {ctl.pageCount}</span>
            <button onClick={() => ctl.setPage(ctl.page + 1)} disabled={ctl.page >= ctl.pageCount - 1} style={pagerBtnStyle}>›</button>
            <button onClick={() => ctl.setPage(ctl.pageCount - 1)} disabled={ctl.page >= ctl.pageCount - 1} style={pagerBtnStyle}>»</button>
          </div>
        )}
      </div>
    </div>
  );
}

// Per-table CSV download of the FULL dataset (ignores search/filter/paging).
// `columns` = [{ label, get }] where `get` is a field name or (row) => value.
export function CsvExportButton({ filename, columns, rows }) {
  const esc = (v) => {
    const t = v == null ? '' : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const onClick = () => {
    const lines = [columns.map((c) => esc(c.label)).join(',')];
    for (const r of rows || []) {
      lines.push(columns.map((c) => esc(typeof c.get === 'function' ? c.get(r) : r[c.get])).join(','));
    }
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };
  return (
    <button onClick={onClick} disabled={!rows?.length} className="ar-btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}>
      <DownloadGlyph /> Export
    </button>
  );
}

// Column show/hide preference, persisted per table in localStorage.
export function useVisibleColumns(storageKey, defaultHidden = []) {
  const [hidden, setHidden] = React.useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      return new Set(Array.isArray(saved) ? saved : defaultHidden);
    } catch { return new Set(defaultHidden); }
  });
  const toggle = (k) => setHidden((h) => {
    const next = new Set(h);
    if (next.has(k)) next.delete(k); else next.add(k);
    try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* private mode */ }
    return next;
  });
  return { hidden, toggle, show: (k) => !hidden.has(k) };
}

// Dropdown of checkboxes toggling column visibility. `columns` = [{ k, label, always? }].
// portalOrInline (not raw createPortal — window.ReactDOM has none) keeps the
// menu above sticky table headers.
export function ColumnPicker({ columns, prefs }) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState(null);
  const btnRef = React.useRef(null);
  const menuRef = React.useRef(null);

  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
    }
    setOpen((o) => !o);
  };

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (btnRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onScroll = (e) => {
      if (e && menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      if (!btnRef.current) return;
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  return (
    <>
      <button ref={btnRef} onClick={toggle} className="ar-btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}>
        <SlidersGlyph /> Columns
      </button>
      {open && pos && portalOrInline(
        <div ref={menuRef} style={{ position: 'fixed', top: pos.top, right: pos.right, zIndex: 50, background: 'var(--ar-gray)', border: '1px solid var(--ar-border)', borderRadius: 8, boxShadow: '0 20px 25px -5px rgba(0,0,0,.4)', padding: 8, width: 240, maxHeight: 320, overflowY: 'auto' }}>
          {columns.map((c) => (
            <label key={c.k}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', fontSize: 12, borderRadius: 4, cursor: c.always ? 'default' : 'pointer', color: c.always ? 'var(--ar-ink-faint)' : 'var(--ar-ink)' }}>
              <input type="checkbox" checked={c.always || prefs.show(c.k)} disabled={c.always}
                onChange={() => prefs.toggle(c.k)} className="accent-current" />
              {c.label}
            </label>
          ))}
        </div>
      )}
    </>
  );
}
