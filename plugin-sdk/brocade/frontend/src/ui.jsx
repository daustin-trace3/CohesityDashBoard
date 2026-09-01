// Brocade SAN plugin style kit. No Tailwind build step is available inside a
// plugin bundle, so this installs a hand-rolled utility stylesheet that
// mirrors the class *names* the built-in frontend/src/pages/brocade/* pages
// already use (panel, text-ink, text-ink-muted, tnum, grid-cols-2, chip,
// ...). That lets pages/* here port from the built-in JSX with mostly an
// import-path swap instead of a full inline-style rewrite. Mirrors
// plugin-sdk/dell/frontend/src/ui.jsx exactly, renamed dl- -> bc-, rebranded
// to Brocade red (#CC092F). ToastHost/useToast is ported from
// plugin-sdk/cohesity/frontend/src/ui.jsx (dell has no toast system; the
// built-in Brocade pages call useToast() throughout).
//
// React/ReactDOM/ReactRouterDOM/Chart come from window globals injected by
// esbuild `define` at build time (see plugin-sdk/build.mjs) — no imports.

export const BRAND = '#CC092F';

const STYLE_ID = 'bc-plugin-styles';

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
    out += `.space-y-${e}>*+*{margin-top:${v}}.space-x-${e}>*+*{margin-left:${v}}`;
  }
  return out;
}

const STATUS_COLORS = { ok: '#3FB950', warn: '#D4A24E', crit: '#C75D5D', info: '#4C9BE8' };
const OPACITIES = [5, 10, 15, 20, 25, 30, 40, 50];

function statusColorCss() {
  let out = '';
  for (const [name, hex] of Object.entries(STATUS_COLORS)) {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    for (const op of OPACITIES) {
      const a = op / 100;
      out += `.bg-status-${name}\\/${op}{background:rgba(${r},${g},${b},${a})}`;
      out += `.border-status-${name}\\/${op}{border-color:rgba(${r},${g},${b},${a})}`;
      out += `.hover\\:bg-status-${name}\\/${op}:hover{background:rgba(${r},${g},${b},${a})}`;
      out += `.hover\\:border-status-${name}\\/${op}:hover{border-color:rgba(${r},${g},${b},${a})}`;
    }
  }
  return out;
}

const CSS = `
:root {
  --bc-surface-base: #0B1015;
  --bc-surface: #131B23;
  --bc-surface-raised: #18222C;
  --bc-surface-overlay: #1E2A36;
  --bc-border: #1F2B37;
  --bc-gray: #131B23;
  --bc-ink: #E8EDF2;
  --bc-ink-muted: #94A3B3;
  --bc-ink-faint: #5F7081;
  --bc-brand: ${BRAND};
  --bc-brand-dark: #970722;
  --bc-ok: #34D399;
  --bc-warn: #FBBF24;
  --bc-crit: #F87171;
  --bc-info: #60A5FA;
}

.bc-root { font-family: inherit; color: var(--bc-ink); }

/* component classes used by ported page bodies */
.panel { background: var(--bc-surface); border: 1px solid var(--bc-border); border-radius: 12px; box-shadow: 0 1px 2px rgba(0,0,0,.4), inset 0 0 0 1px rgba(255,255,255,.02); }
.chip { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 2px 10px; font-size: 11px; font-weight: 500; border: 1px solid transparent; }
.tnum { font-variant-numeric: tabular-nums; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
.animate-fade-in { animation: bc-fade-in 220ms ease-out both; }
.animate-spin { animation: bc-spin 0.8s linear infinite; }
.animate-pulse { animation: bc-pulse 1.4s ease-in-out infinite; }
@keyframes bc-fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes bc-spin { to { transform: rotate(360deg); } }
@keyframes bc-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }

/* colors */
.text-ink { color: var(--bc-ink); }
.text-ink-muted { color: var(--bc-ink-muted); }
.text-ink-faint { color: var(--bc-ink-faint); }
.text-brand { color: var(--bc-brand); }
.text-status-ok { color: var(--bc-ok); }
.text-status-warn { color: var(--bc-warn); }
.text-status-crit { color: var(--bc-crit); }
.text-status-bad { color: var(--bc-crit); }
.text-status-info { color: var(--bc-info); }
.text-white { color: #fff; }
.text-cohesity-black { color: #1A1A1A; }
.text-white\\/80 { color: rgba(255,255,255,.8); }
.bg-black\\/40 { background: rgba(0,0,0,.4); }
.bg-black\\/50 { background: rgba(0,0,0,.5); }
.bg-black\\/60 { background: rgba(0,0,0,.6); }
.bg-brand { background: var(--bc-brand); }
.bg-brand\\/10 { background: rgba(204,9,47,.1); }
.bg-brand\\/15 { background: rgba(204,9,47,.15); }
.bg-brand\\/20 { background: rgba(204,9,47,.2); }
.bg-cohesity-gray { background: var(--bc-gray); }
.bg-surface-overlay { background: var(--bc-surface-overlay); }
.bg-surface { background: var(--bc-surface); }
.bg-white { background: #fff; }
${statusColorCss()}

/* borders */
.border { border: 1px solid var(--bc-border); }
.border-b { border-bottom: 1px solid var(--bc-border); }
.border-t { border-top: 1px solid var(--bc-border); }
.border-l { border-left: 1px solid var(--bc-border); }
.border-transparent { border-color: transparent; }
.border-cohesity-border { border-color: var(--bc-border); }
.border-cohesity-border\\/40 { border-color: rgba(31,43,55,.4); }
.border-cohesity-border\\/50 { border-color: rgba(31,43,55,.5); }
.border-brand\\/20 { border-color: rgba(204,9,47,.2); }
.border-brand\\/25 { border-color: rgba(204,9,47,.25); }
.border-brand\\/30 { border-color: rgba(204,9,47,.3); }
.border-brand\\/40 { border-color: rgba(204,9,47,.4); }
.border-brand\\/50 { border-color: rgba(204,9,47,.5); }
.border-brand\\/60 { border-color: rgba(204,9,47,.6); }
.rounded { border-radius: .25rem; }
.rounded-full { border-radius: 9999px; }
.rounded-sm { border-radius: .125rem; }
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
.flex-shrink-0 { flex-shrink: 0; }
.min-w-0 { min-width: 0; }
.min-h-0 { min-height: 0; }
.min-w-\\[10rem\\] { min-width: 10rem; }
.min-w-\\[220px\\] { min-width: 220px; }
.grid { display: grid; }
.grid-cols-2 { grid-template-columns: repeat(2,minmax(0,1fr)); }
.grid-cols-3 { grid-template-columns: repeat(3,minmax(0,1fr)); }
.grid-cols-4 { grid-template-columns: repeat(4,minmax(0,1fr)); }
.col-span-2 { grid-column: span 2 / span 2; }
.mx-auto { margin-left: auto; margin-right: auto; }
.ml-auto { margin-left: auto; }
@media (min-width: 640px) {
  .sm\\:grid-cols-2 { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .sm\\:grid-cols-3 { grid-template-columns: repeat(3,minmax(0,1fr)); }
  .sm\\:grid-cols-4 { grid-template-columns: repeat(4,minmax(0,1fr)); }
}
@media (min-width: 768px) {
  .md\\:grid-cols-2 { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .md\\:grid-cols-4 { grid-template-columns: repeat(4,minmax(0,1fr)); }
  .md\\:grid-cols-5 { grid-template-columns: repeat(5,minmax(0,1fr)); }
  .md\\:grid-cols-6 { grid-template-columns: repeat(6,minmax(0,1fr)); }
  .md\\:col-span-2 { grid-column: span 2 / span 2; }
  .md\\:flex-col { flex-direction: column; }
  .md\\:flex-row { flex-direction: row; }
  .md\\:w-48 { width: 12rem; }
}
@media (min-width: 1024px) {
  .lg\\:grid-cols-2 { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .lg\\:grid-cols-3 { grid-template-columns: repeat(3,minmax(0,1fr)); }
  .lg\\:grid-cols-4 { grid-template-columns: repeat(4,minmax(0,1fr)); }
  .lg\\:grid-cols-5 { grid-template-columns: repeat(5,minmax(0,1fr)); }
  .lg\\:col-span-2 { grid-column: span 2 / span 2; }
}
@media (min-width: 1280px) {
  .xl\\:grid-cols-2 { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .xl\\:grid-cols-3 { grid-template-columns: repeat(3,minmax(0,1fr)); }
}

/* position */
.absolute { position: absolute; }
.relative { position: relative; }
.fixed { position: fixed; }
.sticky { position: sticky; }
.inset-0 { top: 0; right: 0; bottom: 0; left: 0; }
.top-0 { top: 0; }
.top-1\\/2 { top: 50%; }
.left-1\\/2 { left: 50%; }
.-translate-y-1\\/2 { transform: translateY(-50%); }
.left-\\[22px\\] { left: 22px; }
.z-40 { z-index: 40; }
.z-50 { z-index: 50; }
.z-\\[60\\] { z-index: 60; }

/* sizing */
.w-full { width: 100%; }
.h-full { height: 100%; }
.aspect-video { aspect-ratio: 16 / 9; }
.object-cover { object-fit: cover; }
.max-h-32 { max-height: 8rem; }
.max-h-64 { max-height: 16rem; }
.max-h-72 { max-height: 18rem; }
.max-h-96 { max-height: 24rem; }
.max-h-\\[28rem\\] { max-height: 28rem; }
.max-h-\\[80vh\\] { max-height: 80vh; }
.max-h-\\[85vh\\] { max-height: 85vh; }
.max-w-2xl { max-width: 42rem; }
.max-w-3xl { max-width: 48rem; }
.max-w-4xl { max-width: 56rem; }
.max-w-5xl { max-width: 64rem; }
.max-w-lg { max-width: 32rem; }
.max-w-md { max-width: 28rem; }
.max-w-sm { max-width: 24rem; }
.max-w-xs { max-width: 20rem; }
.max-w-\\[160px\\] { max-width: 160px; }
.max-w-\\[180px\\] { max-width: 180px; }
.max-w-\\[200px\\] { max-width: 200px; }
.max-w-\\[220px\\] { max-width: 220px; }
.max-w-\\[240px\\] { max-width: 240px; }
.max-w-\\[260px\\] { max-width: 260px; }
.max-w-\\[280px\\] { max-width: 280px; }
.max-w-\\[360px\\] { max-width: 360px; }
.max-w-\\[420px\\] { max-width: 420px; }

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
.shadow-lg { box-shadow: 0 10px 15px -3px rgba(0,0,0,.4), 0 4px 6px -4px rgba(0,0,0,.4); }
.overflow-hidden { overflow: hidden; }
.overflow-x-auto { overflow-x: auto; }
.overflow-y-auto { overflow-y: auto; }
.backdrop-blur-sm { backdrop-filter: blur(4px); }
.transition-all { transition: all 150ms ease; }
.transition-colors { transition: color 150ms ease, background-color 150ms ease, border-color 150ms ease; }
.transition-opacity { transition: opacity 150ms ease; }
.accent-brand { accent-color: var(--bc-brand); }
.accent-status-crit { accent-color: var(--bc-crit); }
.opacity-50 { opacity: .5; }
.ring-1 { box-shadow: 0 0 0 1px var(--bc-ring, transparent); }
.ring-2 { box-shadow: 0 0 0 2px var(--bc-ring, transparent); }
.ring-brand\\/30 { --bc-ring: rgba(204,9,47,.3); }
.ring-brand\\/60 { --bc-ring: rgba(204,9,47,.6); }
.ring-brand\\/70 { --bc-ring: rgba(204,9,47,.7); }
.ring-cohesity-border { --bc-ring: var(--bc-border); }

/* hover / focus / disabled */
.hover\\:bg-surface-overlay:hover { background: var(--bc-surface-overlay); }
.hover\\:bg-brand\\/10:hover { background: rgba(204,9,47,.1); }
.hover\\:bg-brand\\/20:hover { background: rgba(204,9,47,.2); }
.hover\\:border-brand\\/40:hover { border-color: rgba(204,9,47,.4); }
.hover\\:border-brand\\/50:hover { border-color: rgba(204,9,47,.5); }
.hover\\:text-ink:hover { color: var(--bc-ink); }
.hover\\:text-white:hover { color: #fff; }
.hover\\:text-brand:hover { color: var(--bc-brand); }
.hover\\:text-status-crit:hover { color: var(--bc-crit); }
.hover\\:text-status-ok:hover { color: var(--bc-ok); }
.hover\\:underline:hover { text-decoration: underline; }
.hover\\:opacity-90:hover { opacity: .9; }
.hover\\:ring-1:hover { box-shadow: 0 0 0 1px var(--bc-ring, transparent); }
.hover\\:ring-brand\\/30:hover { --bc-ring: rgba(204,9,47,.3); }
.hover\\:-translate-y-0\\.5:hover { transform: translateY(-2px); }
.focus\\:border-brand\\/60:focus { border-color: rgba(204,9,47,.6); }
.disabled\\:opacity-50:disabled { opacity: .5; }
.disabled\\:opacity-40:disabled { opacity: .4; }
.disabled\\:cursor-default:disabled { cursor: default; }
.disabled\\:cursor-not-allowed:disabled { cursor: not-allowed; }

.bc-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.bc-scroll::-webkit-scrollbar-track { background: transparent; }
.bc-scroll::-webkit-scrollbar-thumb { background: #2A3845; border-radius: 4px; border: 2px solid var(--bc-surface-base); }
.bc-scroll::-webkit-scrollbar-thumb:hover { background: #3B4D5E; }

.bc-input {
  width: 100%;
  background: var(--bc-surface-overlay);
  border: 1px solid var(--bc-border);
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 13px;
  color: var(--bc-ink);
  outline: none;
  box-sizing: border-box;
}
.bc-input:focus { border-color: rgba(204,9,47,0.6); }

.bc-btn-ghost {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  border: 1px solid var(--bc-border);
  background: transparent;
  color: var(--bc-ink-muted);
  cursor: pointer;
  transition: color 150ms, border-color 150ms;
}
.bc-btn-ghost:hover { color: var(--bc-ink); border-color: rgba(204,9,47,0.4); }
.bc-btn-ghost:disabled { opacity: 0.5; cursor: default; }

.bc-chip {
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
  .bc-root *, .bc-root *::before, .bc-root *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
  .animate-fade-in, .animate-spin, .animate-pulse { animation: none !important; }
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
  .md\\:grid-cols-6 { grid-template-columns: repeat(6,minmax(0,1fr)); }
  .md\\:col-span-2 { grid-column: span 2 / span 2; }
  .md\\:flex-col { flex-direction: column; }
  .md\\:flex-row { flex-direction: row; }
  .md\\:w-48 { width: 12rem; }
}
@media (min-width: 1024px) {
  .lg\\:grid-cols-2 { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .lg\\:grid-cols-3 { grid-template-columns: repeat(3,minmax(0,1fr)); }
  .lg\\:grid-cols-4 { grid-template-columns: repeat(4,minmax(0,1fr)); }
  .lg\\:grid-cols-5 { grid-template-columns: repeat(5,minmax(0,1fr)); }
  .lg\\:col-span-2 { grid-column: span 2 / span 2; }
}
@media (min-width: 1280px) {
  .xl\\:grid-cols-2 { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .xl\\:grid-cols-3 { grid-template-columns: repeat(3,minmax(0,1fr)); }
}
`;

/* Scope every rule under .bc-root so the utility vocabulary (w-full, flex,
 * panel, ...) cannot leak into HOST pages. Unscoped, this stylesheet loads
 * after the host's Tailwind CSS and its `.w-full` beat the host's own
 * responsive menu widths — which blanked the host Global Settings pages
 * (the unifi 1.0.2 bug). :root var declarations stay global (bc- prefixed,
 * collision-free); @keyframes bodies must not be prefixed. */
function scopeCss(css) {
  const parts = css.split(/(@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\})/g);
  return parts.map((part, i) => {
    if (i % 2 === 1) return part; // @keyframes block — untouched
    return part.replace(/(^|\{|\})(\s*)([^@{}]+?)(\s*\{)/g, (m, brace, ws, sel, open) => {
      const scoped = sel.split(',').map((s) => {
        const t = s.trim();
        if (!t || t === ':root' || t.startsWith('.bc-root')) return t;
        return `.bc-root ${t}`;
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
 * apiFetch / apiFetchBlob — base '/api', auto CSRF on non-GET. Prefer the
 * axios-shaped client in ./api.js for ported pages (it matches the host's
 * `client.get(path, { params })` / `err.response.data.error` idioms); this
 * apiFetch is kept for callers that want a plain fetch-shaped helper.
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
  const res = await fetch(`/api${path}`, { credentials: 'same-origin', ...opts, method, headers, body });
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
  const res = await fetch(`/api${path}`, { credentials: 'same-origin', ...opts });
  if (!res.ok) {
    const err = new Error(`Request failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.blob();
}

/* ────────────────────────────────────────────────────────────────────────
 * Formatting helpers — ported from frontend/src/pages/brocade/helpers.js,
 * merged here so ui.jsx is the single source (matches the dell/unifi
 * pattern of folding helpers.js into ui.jsx).
 * ────────────────────────────────────────────────────────────────────── */
export function fmtNum(n) {
  return n == null ? '—' : Number(n).toLocaleString();
}

export function fmtPct(p) {
  return p == null ? '—' : `${Number(p).toFixed(1)}%`;
}

export function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).includes('T') ? iso : `${iso}Z`.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

export function fmtMs(ms) {
  if (ms == null) return '—';
  const d = new Date(Number(ms));
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
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

// Status/health tone mapping — Doug's convention: healthy/online green,
// marginal/warning amber, critical/down red, unknown/unmonitored gray.
export function statusTone(status) {
  const s = String(status || '').toLowerCase();
  if (!s || s === 'unknown' || s === 'unmonitored') return 'neutral';
  if (s.includes('healthy') || s.includes('online') || s.includes('reachable') || s === 'ok' || s === 'up') return 'ok';
  if (s.includes('marginal') || s.includes('warning') || s.includes('degraded')) return 'warn';
  if (s.includes('critical') || s.includes('down') || s.includes('unreachable') || s.includes('offline')) return 'crit';
  return 'neutral';
}

export function severityTone(sev) {
  const s = String(sev || '').toLowerCase();
  if (s === 'critical' || s === 'alert' || s === 'error') return 'crit';
  if (s === 'warning' || s === 'major') return 'warn';
  if (s === 'info' || s === 'informational' || s === 'minor') return 'info';
  return 'neutral';
}

export function scoreTone(score) {
  if (score == null) return 'neutral';
  const n = Number(score);
  if (!Number.isFinite(n)) return 'neutral';
  if (n < 50) return 'crit';
  if (n < 70) return 'warn';
  return 'ok';
}

export function scoreColor(score) {
  const t = scoreTone(score);
  return t === 'ok' ? '#3FB950' : t === 'warn' ? '#D4A24E' : t === 'crit' ? '#C75D5D' : '#8A8A8A';
}

/* last_poll_at is SQLite datetime('now') — UTC without a zone marker. */
export const asDate = (v) => (v ? new Date(String(v).includes('T') ? v : `${String(v).replace(' ', 'T')}Z`) : null);

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
          <div style={{ marginTop: 2, display: 'flex', height: 36, width: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'rgba(204,9,47,0.1)', border: '1px solid rgba(204,9,47,0.2)', flexShrink: 0 }}>
            <IconComp size={18} style={{ color: 'var(--bc-brand)' }} />
          </div>
        )}
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: 18, fontWeight: 700, color: 'var(--bc-ink)', lineHeight: 1.2, margin: 0 }}>{title}</h1>
          {description && <p style={{ fontSize: 12, color: 'var(--bc-ink-muted)', margin: '2px 0 0' }}>{description}</p>}
        </div>
      </div>
      {children && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{children}</div>}
    </div>
  );
}

const TONE = {
  default: { icon: 'var(--bc-ink-muted)', iconBg: 'var(--bc-surface-overlay)', iconBorder: 'var(--bc-border)' },
  neutral: { icon: 'var(--bc-ink-muted)', iconBg: 'var(--bc-surface-overlay)', iconBorder: 'var(--bc-border)' },
  brand: { icon: 'var(--bc-brand)', iconBg: 'rgba(204,9,47,0.1)', iconBorder: 'rgba(204,9,47,0.2)' },
  ok: { icon: 'var(--bc-ok)', iconBg: 'rgba(52,211,153,0.1)', iconBorder: 'rgba(52,211,153,0.2)' },
  warn: { icon: 'var(--bc-warn)', iconBg: 'rgba(251,191,36,0.1)', iconBorder: 'rgba(251,191,36,0.2)' },
  crit: { icon: 'var(--bc-crit)', iconBg: 'rgba(248,113,113,0.1)', iconBorder: 'rgba(248,113,113,0.2)' },
  info: { icon: 'var(--bc-info)', iconBg: 'rgba(96,165,250,0.1)', iconBorder: 'rgba(96,165,250,0.2)' },
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
        <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--bc-ink-faint)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</p>
        {loading ? (
          <div style={{ height: 24, width: 80, marginTop: 4, borderRadius: 6, background: 'var(--bc-surface-overlay)' }} />
        ) : (
          <p className="tnum" style={{ fontSize: 20, fontWeight: 700, color: 'var(--bc-ink)', lineHeight: 1.2, margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</p>
        )}
        {sub && !loading && (
          <p style={{ fontSize: 11, color: 'var(--bc-ink-muted)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</p>
        )}
      </div>
    </Tag>
  );
}

const BADGE_TONES = {
  ok: { bg: 'rgba(52,211,153,0.1)', color: 'var(--bc-ok)', border: 'rgba(52,211,153,0.25)' },
  warn: { bg: 'rgba(251,191,36,0.1)', color: 'var(--bc-warn)', border: 'rgba(251,191,36,0.25)' },
  crit: { bg: 'rgba(248,113,113,0.1)', color: 'var(--bc-crit)', border: 'rgba(248,113,113,0.25)' },
  info: { bg: 'rgba(96,165,250,0.1)', color: 'var(--bc-info)', border: 'rgba(96,165,250,0.25)' },
  brand: { bg: 'rgba(204,9,47,0.1)', color: 'var(--bc-brand)', border: 'rgba(204,9,47,0.25)' },
  neutral: { bg: 'var(--bc-surface-overlay)', color: 'var(--bc-ink-muted)', border: 'var(--bc-border)' },
};

export function Badge({ tone = 'neutral', children, style, className }) {
  const t = BADGE_TONES[tone] || BADGE_TONES.neutral;
  return (
    <span className={cls('bc-chip', className)} style={{ background: t.bg, color: t.color, borderColor: t.border, ...style }}>
      {children}
    </span>
  );
}

export function Spinner({ size = 16, style }) {
  return <LoaderGlyph size={size} style={{ color: 'var(--bc-brand)', animation: 'bc-spin 0.8s linear infinite', ...style }} />;
}

export function LoadingPanel({ label = 'Loading data…', height = 200 }) {
  return (
    <div role="status" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, height }}>
      <Spinner size={22} />
      <p style={{ fontSize: 12, color: 'var(--bc-ink-muted)', margin: 0 }}>{label}</p>
    </div>
  );
}

export function RefreshButton({ onClick, refreshing, label = 'Refresh' }) {
  return (
    <button onClick={onClick} disabled={refreshing} className="bc-btn-ghost">
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={refreshing ? { animation: 'bc-spin 0.8s linear infinite' } : undefined}>
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
    <span className="tnum" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--bc-ink-faint)' }}>
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
      <p style={{ margin: 0, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--bc-ink-faint)' }}>{label}</p>
      <p className="tnum" style={{ margin: 0, fontSize: 13, color: 'var(--bc-ink)' }}>{value ?? '—'}</p>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * portalOrInline / Modal — portaled to document.body WHEN the host exposes
 * createPortal. The host's window.ReactDOM is react-dom/client (createRoot
 * only), which has NO createPortal — calling it unguarded crashes the
 * page. The inline fixed overlay fallback renders identically except on
 * transformed ancestors.
 * ────────────────────────────────────────────────────────────────────── */
export function portalOrInline(node) {
  // Portaled content lands outside the .bc-root wrapper, so re-wrap it —
  // otherwise the scoped stylesheet (see scopeCss) no longer applies.
  const wrapped = <div className="bc-root">{node}</div>;
  const rd = typeof window !== 'undefined' ? window.ReactDOM : null;
  if (rd && typeof rd.createPortal === 'function') return rd.createPortal(wrapped, document.body);
  return wrapped;
}

export function Modal({ title, subtitle, icon: IconComp, onClose, children, headerExtra, maxWidth = 'min(720px,92vw)' }) {
  return portalOrInline(
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} role="dialog" aria-modal="true">
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.65)', backdropFilter: 'blur(4px)' }} onClick={onClose} />
      <div className="panel" style={{ position: 'relative', width: maxWidth, maxHeight: '85vh', display: 'flex', flexDirection: 'column', borderTop: `3px solid ${BRAND}` }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, padding: '16px 16px 12px', borderBottom: '1px solid var(--bc-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            {IconComp && <IconComp size={17} style={{ color: 'var(--bc-brand)', flexShrink: 0 }} />}
            <div style={{ minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--bc-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</p>
              {subtitle && <p style={{ margin: 0, fontSize: 11, color: 'var(--bc-ink-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{subtitle}</p>}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            {headerExtra}
            <button onClick={onClose} aria-label="Close" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 28, width: 28, borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--bc-ink-faint)', cursor: 'pointer' }}>
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </div>
        </div>
        <div className="bc-scroll" style={{ padding: 16, overflowY: 'auto' }}>{children}</div>
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
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: 'none', background: 'transparent', color: active ? 'var(--bc-ink)' : 'var(--bc-ink-muted)', padding: 0 }}
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
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--bc-ink-faint)', pointerEvents: 'none' }}>
        <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
      </svg>
      <input value={ctl.q} onChange={(e) => ctl.setQ(e.target.value)} placeholder={placeholder} className="bc-input" style={{ paddingLeft: 32 }} />
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
    <select value={ctl.filters[k] || ''} onChange={(e) => ctl.setFilter(k, e.target.value)} className="bc-input" style={{ width: 'auto', cursor: 'pointer' }}>
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
      <span className="tnum" style={{ fontSize: 11, color: 'var(--bc-ink-faint)', marginLeft: 'auto' }}>
        {ctl.rows.length === total ? `${total} rows` : `${ctl.rows.length} of ${total} rows`}
      </span>
    </div>
  );
}

const PAGE_SIZES = [25, 50, 100, 'all'];
const pagerBtnStyle = { fontSize: 11, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--bc-border)', background: 'transparent', color: 'var(--bc-ink-muted)', cursor: 'pointer' };

export function TablePager({ ctl, sizes = PAGE_SIZES }) {
  const total = ctl.rows.length;
  if (!ctl.paginate || total <= sizes[0]) return null;
  const all = ctl.pageSize === 'all';
  const start = all ? 1 : ctl.page * ctl.pageSize + 1;
  const end = all ? total : Math.min((ctl.page + 1) * ctl.pageSize, total);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingTop: 12, marginTop: 4, borderTop: '1px solid var(--bc-border)' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--bc-ink-faint)' }}>
        Rows per page
        <select value={String(ctl.pageSize)} onChange={(e) => ctl.setPageSize(e.target.value === 'all' ? 'all' : Number(e.target.value))} className="bc-input" style={{ width: 'auto', padding: '4px 8px', cursor: 'pointer' }}>
          {sizes.map((s) => <option key={s} value={String(s)}>{s === 'all' ? 'All' : s}</option>)}
        </select>
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="tnum" style={{ fontSize: 11, color: 'var(--bc-ink-faint)' }}>{start}–{end} of {total}</span>
        {!all && ctl.pageCount > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button onClick={() => ctl.setPage(0)} disabled={ctl.page === 0} style={pagerBtnStyle}>«</button>
            <button onClick={() => ctl.setPage(ctl.page - 1)} disabled={ctl.page === 0} style={pagerBtnStyle}>‹</button>
            <span className="tnum" style={{ fontSize: 11, color: 'var(--bc-ink-faint)', padding: '0 4px' }}>{ctl.page + 1} / {ctl.pageCount}</span>
            <button onClick={() => ctl.setPage(ctl.page + 1)} disabled={ctl.page >= ctl.pageCount - 1} style={pagerBtnStyle}>›</button>
            <button onClick={() => ctl.setPage(ctl.pageCount - 1)} disabled={ctl.page >= ctl.pageCount - 1} style={pagerBtnStyle}>»</button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * useToast — no host toast system inside the plugin sandbox, so this is a
 * self-contained module-level store (not React context — no provider
 * needed). Ported from plugin-sdk/cohesity/frontend/src/ui.jsx (dell has
 * no toast system; the built-in Brocade pages call useToast() throughout).
 * <ToastHost/> is mounted once per routed page by index.jsx's rooted()
 * wrapper. API mirrors host components/ui/Toaster.jsx:
 *   const { toast } = useToast();
 *   const id = toast({ type, title, message });      // create
 *   toast({ id, type, title, message });              // update in place
 * ────────────────────────────────────────────────────────────────────── */
let toastNextId = 1;
const toastState = { items: [] };
const toastListeners = new Set();
const toastTimers = {};

function toastNotify() {
  for (const l of toastListeners) l(toastState.items);
}

function toastDismiss(id) {
  toastState.items = toastState.items.filter((t) => t.id !== id);
  if (toastTimers[id]) { clearTimeout(toastTimers[id]); delete toastTimers[id]; }
  toastNotify();
}

function toastPush(opts) {
  const id = opts.id ?? toastNextId++;
  const entry = { type: 'info', duration: 4500, ...opts, id };
  const existing = toastState.items.findIndex((t) => t.id === id);
  if (existing >= 0) {
    const copy = [...toastState.items];
    copy[existing] = entry;
    toastState.items = copy;
  } else {
    toastState.items = [...toastState.items.slice(-4), entry];
  }
  toastNotify();
  if (toastTimers[id]) clearTimeout(toastTimers[id]);
  if (entry.type !== 'loading' && entry.duration > 0) {
    toastTimers[id] = setTimeout(() => toastDismiss(id), entry.duration);
  }
  return id;
}

export function useToast() {
  return React.useMemo(() => ({ toast: toastPush, dismiss: toastDismiss }), []);
}

const TOAST_ICON_TONE = { success: 'ok', error: 'crit', warning: 'warn', info: 'info', loading: 'brand' };

export function ToastHost() {
  const [items, setItems] = React.useState(toastState.items);
  React.useEffect(() => {
    toastListeners.add(setItems);
    return () => toastListeners.delete(setItems);
  }, []);
  if (items.length === 0) return null;
  return portalOrInline(
    <div aria-live="polite" style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 90, display: 'flex', flexDirection: 'column', gap: 8, width: 340, maxWidth: 'calc(100vw - 2rem)' }}>
      {items.map((t) => (
        <div key={t.id} role="status" className="panel animate-fade-in" style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', background: 'rgba(30,42,54,0.95)', backdropFilter: 'blur(6px)' }}>
          <span style={{ marginTop: 2, flexShrink: 0 }}>
            {t.type === 'loading' ? <Spinner size={16} /> : (
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: (BADGE_TONES[TOAST_ICON_TONE[t.type]] || BADGE_TONES.info).color }} />
            )}
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--bc-ink)', margin: 0, lineHeight: 1.35 }}>{t.title}</p>
            {t.message && <p style={{ fontSize: 11, color: 'var(--bc-ink-muted)', margin: '2px 0 0', lineHeight: 1.5 }}>{t.message}</p>}
          </div>
          <button onClick={() => toastDismiss(t.id)} aria-label="Dismiss notification" style={{ flexShrink: 0, border: 'none', background: 'transparent', color: 'var(--bc-ink-faint)', cursor: 'pointer', padding: 0 }}>
            <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
      ))}
    </div>
  );
}
