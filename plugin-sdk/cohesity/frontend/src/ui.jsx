// Cohesity plugin style kit. No Tailwind build step is available inside a
// plugin bundle, so this installs a hand-rolled utility stylesheet that
// mirrors the class *names* the built-in frontend/src pages already use
// (panel, text-ink, text-ink-muted, bg-cohesity-black, border-cohesity-border,
// tnum, grid-cols-2, ...). That lets pages/* here port from the built-in JSX
// with mostly an import swap instead of a full inline-style rewrite. Mirrors
// plugin-sdk/dell/frontend/src/ui.jsx's structure and Modal/tableTools
// contract, renamed dl- -> co- and rebranded to Cohesity green (#6CB33F —
// already the built-in's own brand token, so BRAND == host's brand color).
//
// React/ReactDOM/ReactRouterDOM/Chart come from window globals injected by
// esbuild `define` at build time (see plugin-sdk/build.mjs) — no imports.

export const BRAND = '#6CB33F';

const STYLE_ID = 'co-plugin-styles';

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
  --co-surface-base: #0B1015;
  --co-surface: #131B23;
  --co-surface-raised: #18222C;
  --co-surface-overlay: #1E2A36;
  --co-border: #1F2B37;
  --co-black: #0B1015;
  --co-gray: #131B23;
  --co-ink: #E8EDF2;
  --co-ink-muted: #94A3B3;
  --co-ink-faint: #5F7081;
  --co-brand: ${BRAND};
  --co-brand-bright: #82C957;
  --co-brand-dark: #54932D;
  --co-ok: #34D399;
  --co-warn: #FBBF24;
  --co-crit: #F87171;
  --co-info: #60A5FA;
}

.co-root { font-family: inherit; color: var(--co-ink); }

/* component classes used by ported page bodies */
.panel { background: var(--co-surface); border: 1px solid var(--co-border); border-radius: 12px; box-shadow: 0 1px 2px rgba(0,0,0,.4), inset 0 0 0 1px rgba(255,255,255,.02); }
.panel-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--co-ink-muted); }
.chip { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 2px 10px; font-size: 11px; font-weight: 500; border: 1px solid transparent; }
.tnum { font-variant-numeric: tabular-nums; }
.animate-fade-in { animation: co-fade-in 220ms ease-out both; }
.animate-slide-in-right { animation: co-slide-in-right 240ms ease-out both; }
.animate-spin { animation: co-spin 0.8s linear infinite; }
.skeleton { background: linear-gradient(90deg, #18222C 25%, #1E2A36 37%, #18222C 63%); background-size: 400px 100%; animation: co-shimmer 1.6s linear infinite; border-radius: 6px; }
@keyframes co-fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes co-slide-in-right { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: none; } }
@keyframes co-spin { to { transform: rotate(360deg); } }
@keyframes co-shimmer { 0% { background-position: -400px 0; } 100% { background-position: 400px 0; } }
@keyframes co-orb-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
@keyframes co-pulse-red { 0%, 100% { box-shadow: 0 0 0 0 rgba(248,113,113,0); border-color: #f87171; } 50% { box-shadow: 0 0 0 6px rgba(248,113,113,.28); border-color: rgba(248,113,113,.6); } }
@keyframes pulse-critical { 0%, 100% { box-shadow: 0 0 0 0 rgba(248,113,113,0); border-color: #f87171; } 50% { box-shadow: 0 0 0 6px rgba(248,113,113,.28); border-color: rgba(248,113,113,.6); } }
@keyframes orb-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }

/* colors — Cohesity legacy tokens */
.bg-cohesity-black { background: var(--co-black); }
.bg-cohesity-gray { background: var(--co-gray); }
.text-cohesity-text { color: var(--co-ink); }
.text-cohesity-green { color: var(--co-brand); }
.bg-cohesity-green { background: var(--co-brand); }
.bg-cohesity-green-dark { background: var(--co-brand-dark); }
.border-cohesity-green { border-color: var(--co-brand); }
.border-cohesity-border { border-color: var(--co-border); }
.divide-cohesity-border > * + * { border-color: var(--co-border); }

/* colors — design-system tokens */
.text-ink { color: var(--co-ink); }
.text-ink-muted { color: var(--co-ink-muted); }
.text-ink-faint { color: var(--co-ink-faint); }
.text-brand { color: var(--co-brand); }
.text-brand-bright { color: var(--co-brand-bright); }
.text-status-ok { color: var(--co-ok); }
.text-status-warn { color: var(--co-warn); }
.text-status-crit { color: var(--co-crit); }
.text-status-info { color: var(--co-info); }
.text-white { color: #fff; }
.text-white\\/80 { color: rgba(255,255,255,.8); }
.bg-surface { background: var(--co-surface); }
.bg-surface-base { background: var(--co-surface-base); }
.bg-surface-raised { background: var(--co-surface-raised); }
.bg-surface-overlay { background: var(--co-surface-overlay); }
.bg-black { background: #000; }
.bg-black\\/40 { background: rgba(0,0,0,.4); }
.bg-black\\/50 { background: rgba(0,0,0,.5); }
.bg-black\\/60 { background: rgba(0,0,0,.6); }
.bg-black\\/70 { background: rgba(0,0,0,.7); }
.bg-opacity-70 { }
.bg-opacity-60 { }
.bg-brand\\/5 { background: rgba(108,179,63,.05); }
.bg-brand\\/10 { background: rgba(108,179,63,.1); }
.bg-brand\\/20 { background: rgba(108,179,63,.2); }
.bg-status-ok\\/10 { background: rgba(52,211,153,.1); }
.bg-status-warn\\/10 { background: rgba(251,191,36,.1); }
.bg-status-crit\\/5 { background: rgba(248,113,113,.05); }
.bg-status-crit\\/10 { background: rgba(248,113,113,.1); }
.bg-white { background: #fff; }
.bg-white\\/\\[0\\.03\\] { background: rgba(255,255,255,.03); }
.hover\\:bg-white\\/\\[0\\.03\\]:hover { background: rgba(255,255,255,.03); }
.hover\\:bg-white\\/\\[0\\.02\\]:hover { background: rgba(255,255,255,.02); }
.bg-amber-400 { background: #fbbf24; }
.bg-amber-400\\/10 { background: rgba(251,191,36,.1); }
.bg-purple-900 { background: #581c87; }
.bg-cyan-900 { background: #164e63; }
.bg-gray-600 { background: #4b5563; }
.bg-red-500 { background: #ef4444; }
.bg-red-700 { background: #b91c1c; }
.bg-red-800 { background: #991b1b; }
.bg-red-900 { background: #7f1d1d; }
.hover\\:bg-red-800:hover { background: #991b1b; }
.text-amber-400 { color: #fbbf24; }
.text-cyan-300 { color: #67e8f9; }
.text-purple-300 { color: #d8b4fe; }
.text-gray-300 { color: #d1d5db; }
.text-gray-400 { color: #9ca3af; }
.text-gray-500 { color: #6b7280; }
.text-red-200 { color: #fecaca; }
.text-red-300 { color: #fca5a5; }
.text-red-400 { color: #f87171; }
.text-red-500 { color: #ef4444; }
.hover\\:text-red-400:hover { color: #f87171; }
.border-amber-400\\/30 { border-color: rgba(251,191,36,.3); }
.border-amber-400\\/40 { border-color: rgba(251,191,36,.4); }
.border-cyan-700 { border-color: #0e7490; }
.border-purple-700 { border-color: #7e22ce; }
.border-red-500 { border-color: #ef4444; }
.border-red-600 { border-color: #dc2626; }
.border-red-700 { border-color: #b91c1c; }
.border-red-800 { border-color: #991b1b; }
.hover\\:border-red-500:hover { border-color: #ef4444; }
.hover\\:border-red-600:hover { border-color: #dc2626; }
.hover\\:text-cohesity-green:hover { color: var(--co-brand); }
.hover\\:border-cohesity-green:hover { border-color: var(--co-brand); }
.focus\\:border-cohesity-green:focus { border-color: var(--co-brand); }
.placeholder-gray-500::placeholder { color: #6b7280; }

/* borders */
.border { border: 1px solid var(--co-border); }
.border-b { border-bottom: 1px solid var(--co-border); }
.border-t { border-top: 1px solid var(--co-border); }
.border-l { border-left: 1px solid var(--co-border); }
.border-transparent { border-color: transparent; }
.border-brand\\/20 { border-color: rgba(108,179,63,.2); }
.border-brand\\/30 { border-color: rgba(108,179,63,.3); }
.border-brand\\/40 { border-color: rgba(108,179,63,.4); }
.border-brand\\/50 { border-color: rgba(108,179,63,.5); }
.border-status-warn\\/40 { border-color: rgba(251,191,36,.4); }
.border-status-crit\\/30 { border-color: rgba(248,113,113,.3); }
.border-status-crit\\/50 { border-color: rgba(248,113,113,.5); }
.border-status-ok\\/30 { border-color: rgba(52,211,153,.3); }
.rounded-full { border-radius: 9999px; }
.rounded { border-radius: .25rem; }
.rounded-lg { border-radius: .5rem; }
.rounded-md { border-radius: .375rem; }
.rounded-xl { border-radius: .75rem; }

/* layout */
.block { display: block; }
.inline { display: inline; }
.inline-block { display: inline-block; }
.inline-flex { display: inline-flex; }
.flex { display: flex; }
.grid { display: grid; }
.hidden { display: none; }
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
.flex-shrink-0, .shrink-0 { flex-shrink: 0; }
.min-w-0 { min-width: 0; }
.min-w-\\[220px\\] { min-width: 220px; }
.min-h-\\[24px\\] { min-height: 24px; }
.grid-cols-1 { grid-template-columns: repeat(1,minmax(0,1fr)); }
.grid-cols-2 { grid-template-columns: repeat(2,minmax(0,1fr)); }
.grid-cols-3 { grid-template-columns: repeat(3,minmax(0,1fr)); }
.grid-cols-4 { grid-template-columns: repeat(4,minmax(0,1fr)); }
.col-span-2 { grid-column: span 2 / span 2; }
@media (min-width: 640px) {
  .sm\\:grid-cols-2 { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .sm\\:grid-cols-3 { grid-template-columns: repeat(3,minmax(0,1fr)); }
  .sm\\:col-span-2 { grid-column: span 2 / span 2; }
}
@media (min-width: 768px) {
  .md\\:grid-cols-2 { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .md\\:grid-cols-3 { grid-template-columns: repeat(3,minmax(0,1fr)); }
  .md\\:grid-cols-4 { grid-template-columns: repeat(4,minmax(0,1fr)); }
  .md\\:grid-cols-5 { grid-template-columns: repeat(5,minmax(0,1fr)); }
  .md\\:col-span-2 { grid-column: span 2 / span 2; }
  .md\\:block { display: block; }
  .md\\:flex-col { flex-direction: column; }
  .md\\:flex-row { flex-direction: row; }
}
@media (min-width: 1024px) {
  .lg\\:grid-cols-2 { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .lg\\:grid-cols-3 { grid-template-columns: repeat(3,minmax(0,1fr)); }
  .lg\\:grid-cols-4 { grid-template-columns: repeat(4,minmax(0,1fr)); }
  .lg\\:col-span-2 { grid-column: span 2 / span 2; }
  .lg\\:block { display: block; }
}
@media (min-width: 1280px) {
  .xl\\:grid-cols-2 { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .xl\\:grid-cols-3 { grid-template-columns: repeat(3,minmax(0,1fr)); }
  .xl\\:grid-cols-4 { grid-template-columns: repeat(4,minmax(0,1fr)); }
  .xl\\:grid-cols-5 { grid-template-columns: repeat(5,minmax(0,1fr)); }
  .xl\\:col-span-2, .xl\\:col-span-3 { grid-column: span 2 / span 2; }
  .xl\\:block { display: block; }
}
@media (min-width: 1536px) {
  .\\32xl\\:grid-cols-3 { grid-template-columns: repeat(3,minmax(0,1fr)); }
}

/* position */
.absolute { position: absolute; }
.relative { position: relative; }
.fixed { position: fixed; }
.sticky { position: sticky; }
.inset-0 { top: 0; right: 0; bottom: 0; left: 0; }
.top-0 { top: 0; }
.top-full { top: 100%; }
.bottom-0 { bottom: 0; }
.left-0 { left: 0; }
.right-0 { right: 0; }
.z-40 { z-index: 40; }
.z-50 { z-index: 50; }
.z-\\[90\\] { z-index: 90; }

/* sizing */
.w-full { width: 100%; }
.h-full { height: 100%; }
.max-h-64 { max-height: 16rem; }
.max-h-\\[80vh\\] { max-height: 80vh; }
.max-h-\\[85vh\\] { max-height: 85vh; }
.max-w-xs { max-width: 20rem; }
.max-w-sm { max-width: 24rem; }
.max-w-md { max-width: 28rem; }
.max-w-2xl { max-width: 42rem; }
.max-w-3xl { max-width: 48rem; }
.max-w-\\[calc\\(100vw-2rem\\)\\] { max-width: calc(100vw - 2rem); }
.w-\\[340px\\] { width: 340px; }

/* text */
.text-xs { font-size: .75rem; line-height: 1rem; }
.text-sm { font-size: .875rem; line-height: 1.25rem; }
.text-base { font-size: 1rem; line-height: 1.5rem; }
.text-lg { font-size: 1.125rem; line-height: 1.75rem; }
.text-xl { font-size: 1.25rem; line-height: 1.75rem; }
.text-2xl { font-size: 1.5rem; line-height: 2rem; }
.text-\\[9px\\] { font-size: 9px; }
.text-\\[10px\\] { font-size: 10px; }
.text-\\[11px\\] { font-size: 11px; }
.text-\\[12px\\] { font-size: 12px; }
.text-\\[13px\\] { font-size: 13px; }
.font-bold { font-weight: 700; }
.font-semibold { font-weight: 600; }
.font-medium { font-weight: 500; }
.font-normal { font-weight: 400; }
.font-mono { font-family: 'JetBrains Mono', SFMono-Regular, Consolas, Menlo, monospace; }
.text-left { text-align: left; }
.text-center { text-align: center; }
.text-right { text-align: right; }
.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.whitespace-nowrap { white-space: nowrap; }
.whitespace-pre-wrap { white-space: pre-wrap; }
.break-words { overflow-wrap: break-word; }
.break-all { word-break: break-all; }
.uppercase { text-transform: uppercase; }
.capitalize { text-transform: capitalize; }
.tracking-wide { letter-spacing: .025em; }
.tracking-wider { letter-spacing: .05em; }
.leading-none { line-height: 1; }
.leading-tight { line-height: 1.25; }
.leading-snug { line-height: 1.375; }
.leading-relaxed { line-height: 1.625; }
.italic { font-style: italic; }
.list-none { list-style: none; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0; }

/* misc */
.cursor-pointer { cursor: pointer; }
.cursor-not-allowed, .disabled\\:cursor-not-allowed:disabled { cursor: not-allowed; }
.select-none { user-select: none; }
.pointer-events-none { pointer-events: none; }
.outline-none, .focus\\:outline-none:focus { outline: none; }
.shadow-xl { box-shadow: 0 20px 25px -5px rgba(0,0,0,.4), 0 8px 10px -6px rgba(0,0,0,.4); }
.shadow-panel { box-shadow: 0 1px 2px rgba(0,0,0,.4), 0 0 0 1px rgba(255,255,255,.02) inset; }
.shadow-panel-hover { box-shadow: 0 4px 16px rgba(0,0,0,.45), 0 0 0 1px rgba(108,179,63,.18); }
.shadow-modal { box-shadow: 0 24px 64px rgba(0,0,0,.6); }
.overflow-hidden { overflow: hidden; }
.overflow-auto { overflow: auto; }
.overflow-x-auto { overflow-x: auto; }
.overflow-y-auto { overflow-y: auto; }
.transition-all { transition: all 150ms ease; }
.transition-colors { transition: color 150ms ease, background-color 150ms ease, border-color 150ms ease; }
.transition-opacity { transition: opacity 150ms ease; }
.duration-150 { transition-duration: 150ms; }
.duration-200 { transition-duration: 200ms; }
.duration-500 { transition-duration: 500ms; }
.accent-brand { accent-color: var(--co-brand); }
.accent-cohesity-green { accent-color: var(--co-brand); }
.accent-red-500 { accent-color: #ef4444; }
.opacity-50 { opacity: .5; }
.opacity-60 { opacity: .6; }
.backdrop-blur, .backdrop-blur-sm { backdrop-filter: blur(6px); }
.rotate-90 { transform: rotate(90deg); }

/* hover / focus / disabled */
.hover\\:bg-surface-overlay:hover { background: var(--co-surface-overlay); }
.hover\\:bg-brand\\/10:hover { background: rgba(108,179,63,.1); }
.hover\\:bg-brand\\/20:hover { background: rgba(108,179,63,.2); }
.hover\\:bg-cohesity-green\\/20:hover { background: rgba(108,179,63,.2); }
.hover\\:bg-cohesity-green-dark:hover { background: var(--co-brand-dark); }
.hover\\:border-brand\\/40:hover { border-color: rgba(108,179,63,.4); }
.hover\\:border-brand\\/50:hover { border-color: rgba(108,179,63,.5); }
.hover\\:border-brand\\/60:hover, .focus\\:border-brand\\/60:focus { border-color: rgba(108,179,63,.6); }
.hover\\:border-status-crit\\/40:hover { border-color: rgba(248,113,113,.4); }
.hover\\:border-status-crit\\/50:hover { border-color: rgba(248,113,113,.5); }
.hover\\:text-ink:hover { color: var(--co-ink); }
.hover\\:text-white:hover { color: #fff; }
.hover\\:text-brand:hover { color: var(--co-brand); }
.hover\\:text-status-crit:hover { color: var(--co-crit); }
.hover\\:underline:hover { text-decoration: underline; }
.underline { text-decoration: underline; }
.underline-offset-2 { text-underline-offset: 2px; }
.decoration-dotted { text-decoration-style: dotted; }
.disabled\\:opacity-50:disabled { opacity: .5; }
.disabled\\:opacity-40:disabled { opacity: .4; }
.disabled\\:opacity-30:disabled { opacity: .3; }

.co-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.co-scroll::-webkit-scrollbar-track { background: transparent; }
.co-scroll::-webkit-scrollbar-thumb { background: #2A3845; border-radius: 4px; border: 2px solid var(--co-surface-base); }
.co-scroll::-webkit-scrollbar-thumb:hover { background: #3B4D5E; }

.co-input {
  width: 100%;
  background: var(--co-surface-overlay);
  border: 1px solid var(--co-border);
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 13px;
  color: var(--co-ink);
  outline: none;
  box-sizing: border-box;
}
.co-input:focus { border-color: rgba(108,179,63,0.6); }

.co-btn-ghost {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  border: 1px solid var(--co-border);
  background: transparent;
  color: var(--co-ink-muted);
  cursor: pointer;
  transition: color 150ms, border-color 150ms;
}
.co-btn-ghost:hover { color: var(--co-ink); border-color: rgba(108,179,63,0.4); }
.co-btn-ghost:disabled { opacity: 0.5; cursor: default; }

@media (prefers-reduced-motion: reduce) {
  .co-root *, .co-root *::before, .co-root *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
  .animate-fade-in, .animate-spin, .skeleton, .animate-slide-in-right { animation: none !important; }
}
` + spacingCss();

/* Responsive variants re-declared LAST so they beat base utilities of equal
 * specificity (Tailwind's own emit order) — the unifi 1.0.2 "empty settings
 * page" trap. */
const RESPONSIVE_LAST = `
@media (min-width: 640px) {
  .sm\\:grid-cols-2 { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .sm\\:grid-cols-3 { grid-template-columns: repeat(3,minmax(0,1fr)); }
  .sm\\:col-span-2 { grid-column: span 2 / span 2; }
}
@media (min-width: 768px) {
  .md\\:grid-cols-2 { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .md\\:grid-cols-3 { grid-template-columns: repeat(3,minmax(0,1fr)); }
  .md\\:grid-cols-4 { grid-template-columns: repeat(4,minmax(0,1fr)); }
  .md\\:grid-cols-5 { grid-template-columns: repeat(5,minmax(0,1fr)); }
  .md\\:col-span-2 { grid-column: span 2 / span 2; }
  .md\\:block { display: block; }
  .md\\:flex-col { flex-direction: column; }
  .md\\:flex-row { flex-direction: row; }
}
@media (min-width: 1024px) {
  .lg\\:grid-cols-2 { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .lg\\:grid-cols-3 { grid-template-columns: repeat(3,minmax(0,1fr)); }
  .lg\\:grid-cols-4 { grid-template-columns: repeat(4,minmax(0,1fr)); }
  .lg\\:col-span-2 { grid-column: span 2 / span 2; }
  .lg\\:block { display: block; }
}
@media (min-width: 1280px) {
  .xl\\:grid-cols-2 { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .xl\\:grid-cols-3 { grid-template-columns: repeat(3,minmax(0,1fr)); }
  .xl\\:grid-cols-4 { grid-template-columns: repeat(4,minmax(0,1fr)); }
  .xl\\:grid-cols-5 { grid-template-columns: repeat(5,minmax(0,1fr)); }
  .xl\\:col-span-2, .xl\\:col-span-3 { grid-column: span 2 / span 2; }
  .xl\\:block { display: block; }
}
@media (min-width: 1536px) {
  .\\32xl\\:grid-cols-3 { grid-template-columns: repeat(3,minmax(0,1fr)); }
}
`;

/* Scope every rule under .co-root so the utility vocabulary cannot leak into
 * HOST pages. Unscoped, this stylesheet loads after the host's Tailwind CSS
 * and its `.w-full` etc would beat the host's own responsive widths. :root
 * var declarations stay global (co- prefixed, collision-free); @keyframes
 * bodies must not be prefixed. */
function scopeCss(css) {
  const parts = css.split(/(@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\})/g);
  return parts.map((part, i) => {
    if (i % 2 === 1) return part; // @keyframes block — untouched
    return part.replace(/(^|\{|\})(\s*)([^@{}]+?)(\s*\{)/g, (m, brace, ws, sel, open) => {
      const scoped = sel.split(',').map((s) => {
        const t = s.trim();
        if (!t || t === ':root' || t.startsWith('.co-root')) return t;
        return `.co-root ${t}`;
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
 * apiFetch / apiFetchBlob — base '/api', auto CSRF on non-GET. The plugin
 * bundle has no host axios client (import client from '../api/client' is
 * unreachable), so every page here calls these instead. Mutating calls
 * spread window.__ICC_CSRF_TOKEN__ per the sandbox contract.
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
    const err = new Error(payload.error || payload.errors?.[0]?.msg || `Request failed: ${res.status}`);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

export async function apiFetchBlob(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const headers = { ...(opts.headers || {}) };
  if (method !== 'GET' && csrfToken()) headers['x-csrf-token'] = csrfToken();
  const res = await fetch(`/api${path}`, { credentials: 'include', ...opts, method, headers });
  if (!res.ok) {
    const err = new Error(`Request failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.blob();
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ────────────────────────────────────────────────────────────────────────
 * Formatting helpers
 * ────────────────────────────────────────────────────────────────────── */
export function fmtNum(n) {
  return n == null ? '—' : Number(n).toLocaleString();
}

export function fmtBytes(b) {
  if (b == null || b === 0) return '—';
  if (b >= 1e15) return (b / 1e15).toFixed(2) + ' PB';
  if (b >= 1e12) return (b / 1e12).toFixed(2) + ' TB';
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
  return (b / 1e6).toFixed(1) + ' MB';
}

export function fmtPct(p) {
  return p == null ? '—' : `${Number(p).toFixed(1)}%`;
}

export function healthTone(h) {
  return h === 'ok' ? 'ok' : h === 'warning' ? 'warn' : h === 'critical' ? 'crit' : 'neutral';
}

export function severityTone(sev) {
  return sev === 'critical' ? 'crit' : sev === 'warning' ? 'warn' : 'info';
}

export function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).includes('T') ? iso : `${iso}Z`.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

// captured_at / last_poll_at are SQLite datetime('now') — UTC without a zone marker.
export const asDate = (v) => (v ? new Date(String(v).includes('T') ? v : `${String(v).replace(' ', 'T')}Z`) : null);

export function parseUtcMs(ts) {
  if (!ts) return 0;
  const s = String(ts).replace(' ', 'T').replace(/Z*$/, 'Z');
  return new Date(s).getTime();
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

export function humanizeMinutes(min) {
  if (min == null) return '—';
  if (min < 60) return `${min}m`;
  if (min % 60 === 0) return `${min / 60}h`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
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
          <div style={{ marginTop: 2, display: 'flex', height: 36, width: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'rgba(108,179,63,0.1)', border: '1px solid rgba(108,179,63,0.2)', flexShrink: 0 }}>
            <IconComp size={18} style={{ color: 'var(--co-brand)' }} />
          </div>
        )}
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: 18, fontWeight: 700, color: 'var(--co-ink)', lineHeight: 1.2, margin: 0 }}>{title}</h1>
          {description && <p style={{ fontSize: 12, color: 'var(--co-ink-muted)', margin: '2px 0 0' }}>{description}</p>}
        </div>
      </div>
      {children && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{children}</div>}
    </div>
  );
}

const TONE = {
  default: { icon: 'var(--co-ink-muted)', iconBg: 'var(--co-surface-overlay)', iconBorder: 'var(--co-border)' },
  neutral: { icon: 'var(--co-ink-muted)', iconBg: 'var(--co-surface-overlay)', iconBorder: 'var(--co-border)' },
  brand: { icon: 'var(--co-brand)', iconBg: 'rgba(108,179,63,0.1)', iconBorder: 'rgba(108,179,63,0.2)' },
  ok: { icon: 'var(--co-ok)', iconBg: 'rgba(52,211,153,0.1)', iconBorder: 'rgba(52,211,153,0.2)' },
  warn: { icon: 'var(--co-warn)', iconBg: 'rgba(251,191,36,0.1)', iconBorder: 'rgba(251,191,36,0.2)' },
  crit: { icon: 'var(--co-crit)', iconBg: 'rgba(248,113,113,0.1)', iconBorder: 'rgba(248,113,113,0.2)' },
  info: { icon: 'var(--co-info)', iconBg: 'rgba(96,165,250,0.1)', iconBorder: 'rgba(96,165,250,0.2)' },
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
        <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--co-ink-faint)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</p>
        {loading ? (
          <div style={{ height: 24, width: 80, marginTop: 4, borderRadius: 6, background: 'var(--co-surface-overlay)' }} />
        ) : (
          <p className="tnum" style={{ fontSize: 20, fontWeight: 700, color: 'var(--co-ink)', lineHeight: 1.2, margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</p>
        )}
        {sub && !loading && (
          <p style={{ fontSize: 11, color: 'var(--co-ink-muted)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</p>
        )}
      </div>
    </Tag>
  );
}

const BADGE_TONES = {
  ok: { bg: 'rgba(52,211,153,0.1)', color: 'var(--co-ok)', border: 'rgba(52,211,153,0.25)' },
  warn: { bg: 'rgba(251,191,36,0.1)', color: 'var(--co-warn)', border: 'rgba(251,191,36,0.25)' },
  crit: { bg: 'rgba(248,113,113,0.1)', color: 'var(--co-crit)', border: 'rgba(248,113,113,0.25)' },
  info: { bg: 'rgba(96,165,250,0.1)', color: 'var(--co-info)', border: 'rgba(96,165,250,0.25)' },
  brand: { bg: 'rgba(108,179,63,0.1)', color: 'var(--co-brand)', border: 'rgba(108,179,63,0.25)' },
  neutral: { bg: 'var(--co-surface-overlay)', color: 'var(--co-ink-muted)', border: 'var(--co-border)' },
};

export function Badge({ tone = 'neutral', children, style, className }) {
  const t = BADGE_TONES[tone] || BADGE_TONES.neutral;
  return (
    <span className={cls('chip', className)} style={{ background: t.bg, color: t.color, borderColor: t.border, ...style }}>
      {children}
    </span>
  );
}

export function Spinner({ size = 16, style }) {
  return <LoaderGlyph size={size} style={{ color: 'var(--co-brand)', animation: 'co-spin 0.8s linear infinite', ...style }} />;
}

export function LoadingPanel({ label = 'Loading data…', height = 200 }) {
  return (
    <div role="status" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, height }}>
      <Spinner size={22} />
      <p style={{ fontSize: 12, color: 'var(--co-ink-muted)', margin: 0 }}>{label}</p>
    </div>
  );
}

export function RefreshButton({ onClick, refreshing, label = 'Refresh' }) {
  return (
    <button onClick={onClick} disabled={refreshing} className="co-btn-ghost">
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={refreshing ? { animation: 'co-spin 0.8s linear infinite' } : undefined}>
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
    <span className="tnum" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--co-ink-faint)' }}>
      {prefix && <span>{prefix}</span>}
      <span>{label}</span>
    </span>
  );
}

const SYNC_TONE = {
  syncing: { bg: 'rgba(108,179,63,0.1)', color: 'var(--co-brand)', border: 'rgba(108,179,63,0.25)' },
  live: { bg: 'rgba(52,211,153,0.1)', color: 'var(--co-ok)', border: 'rgba(52,211,153,0.25)' },
  stale: { bg: 'rgba(251,191,36,0.1)', color: 'var(--co-warn)', border: 'rgba(251,191,36,0.25)' },
  error: { bg: 'rgba(248,113,113,0.1)', color: 'var(--co-crit)', border: 'rgba(248,113,113,0.25)' },
};

export function SyncStatusChip({ state = 'live', label }) {
  const t = SYNC_TONE[state] || SYNC_TONE.live;
  const text = label ?? { syncing: 'Syncing', live: 'Live', stale: 'Stale', error: 'Error' }[state] ?? state;
  return (
    <span className="chip" style={{ background: t.bg, color: t.color, borderColor: t.border }}>
      {state === 'syncing' && <Spinner size={10} />}
      {state === 'live' && <span style={{ display: 'inline-block', height: 6, width: 6, borderRadius: '50%', background: 'var(--co-ok)', animation: 'co-orb-pulse 2.5s ease-in-out infinite' }} />}
      {text}
    </span>
  );
}

export function Panel({ title, icon: IconComp, actions, accent = null, children, className = '', bodyClassName = '', style }) {
  return (
    <div className={cls('panel', className)} style={{ padding: 16, ...(accent ? { borderTop: `3px solid ${accent}` } : {}), ...style }}>
      {(title || actions) && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          {title && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {IconComp && <IconComp size={14} style={{ color: 'var(--co-brand)' }} />}
              <p className="panel-title" style={{ margin: 0 }}>{title}</p>
            </div>
          )}
          {actions && <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{actions}</div>}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
    </div>
  );
}

export function Fact({ label, value }) {
  return (
    <div>
      <p style={{ margin: 0, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--co-ink-faint)' }}>{label}</p>
      <p className="tnum" style={{ margin: 0, fontSize: 13, color: 'var(--co-ink)' }}>{value ?? '—'}</p>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Modal — portaled to document.body WHEN the host exposes createPortal.
 * The host's window.ReactDOM is react-dom/client (createRoot only), which
 * has NO createPortal — calling it unguarded crashes the page.
 * ────────────────────────────────────────────────────────────────────── */
export function portalOrInline(node) {
  // Portaled content lands outside the .co-root wrapper, so re-wrap it —
  // otherwise the scoped stylesheet (see scopeCss) no longer applies.
  const wrapped = <div className="co-root">{node}</div>;
  const rd = typeof window !== 'undefined' ? window.ReactDOM : null;
  if (rd && typeof rd.createPortal === 'function') return rd.createPortal(wrapped, document.body);
  return wrapped;
}

export function Modal({ title, subtitle, icon: IconComp, onClose, children, maxWidth = 'min(720px,92vw)', footer }) {
  return portalOrInline(
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} role="dialog" aria-modal="true">
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.7)', backdropFilter: 'blur(4px)' }} onClick={onClose} />
      <div className="panel" style={{ position: 'relative', width: maxWidth, maxHeight: '85vh', display: 'flex', flexDirection: 'column', borderTop: `3px solid ${BRAND}` }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, padding: '16px 16px 12px', borderBottom: '1px solid var(--co-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            {IconComp && <IconComp size={17} style={{ color: 'var(--co-brand)', flexShrink: 0 }} />}
            <div style={{ minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--co-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</p>
              {subtitle && <p style={{ margin: 0, fontSize: 11, color: 'var(--co-ink-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{subtitle}</p>}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 28, width: 28, borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--co-ink-faint)', cursor: 'pointer', flexShrink: 0 }}>
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="co-scroll" style={{ padding: 16, overflowY: 'auto' }}>{children}</div>
        {footer && <div style={{ padding: '12px 16px', borderTop: '1px solid var(--co-border)' }}>{footer}</div>}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * EmptyState + icons — ported from components/EmptyState.jsx
 * ────────────────────────────────────────────────────────────────────── */
export function EmptyState({ icon, title, message, action }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center" role="status">
      {icon && <div style={{ marginBottom: 16, color: 'var(--co-ink-faint)', opacity: 0.6 }} aria-hidden="true">{icon}</div>}
      <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--co-ink)', margin: '0 0 4px' }}>{title}</h3>
      {message && <p style={{ fontSize: 12, color: 'var(--co-ink-muted)', maxWidth: 320, lineHeight: 1.6, margin: '0 0 20px' }}>{message}</p>}
      {action && (
        <button type="button" onClick={action.onClick} className="co-btn-ghost" style={{ background: 'rgba(108,179,63,0.1)', borderColor: 'rgba(108,179,63,0.3)', color: 'var(--co-brand)' }}>
          {action.label}
        </button>
      )}
    </div>
  );
}

export function ClusterEmptyIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="6" y="14" width="36" height="8" rx="2" /><rect x="6" y="26" width="36" height="8" rx="2" />
      <circle cx="12" cy="18" r="1.5" fill="currentColor" /><circle cx="12" cy="30" r="1.5" fill="currentColor" />
    </svg>
  );
}

export function AlertEmptyIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M24 8L40 36H8L24 8Z" strokeLinejoin="round" /><path d="M24 20v8M24 32v2" strokeLinecap="round" />
    </svg>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Skeleton placeholders — ported from SkeletonTable.jsx / SkeletonCard.jsx
 * ────────────────────────────────────────────────────────────────────── */
export function SkeletonTable({ rows = 6, cols = 6 }) {
  return (
    <div aria-hidden="true">
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, padding: '8px 8px', borderBottom: '1px solid var(--co-border)' }}>
        {[...Array(cols)].map((_, i) => <div key={i} className="skeleton" style={{ height: 10, width: 60 + (i % 3) * 20 }} />)}
      </div>
      {[...Array(rows)].map((_, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 20, padding: '10px 8px', borderBottom: '1px solid rgba(31,43,55,.6)' }}>
          {[...Array(cols)].map((_, j) => <div key={j} className="skeleton" style={{ height: 12, width: 50 + ((i + j) % 4) * 22 }} />)}
        </div>
      ))}
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div className="panel" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }} aria-hidden="true">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div className="skeleton" style={{ height: 12, width: '60%' }} />
        <div className="skeleton" style={{ height: 12, width: 24 }} />
      </div>
      <div className="skeleton" style={{ height: 10, width: '40%' }} />
      <div className="skeleton" style={{ height: 28, width: '25%', marginTop: 4 }} />
      <div className="skeleton" style={{ height: 6, width: '100%' }} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 4 }}>
        {[...Array(4)].map((_, i) => (
          <div key={i}>
            <div className="skeleton" style={{ height: 8, width: '40%', marginBottom: 4 }} />
            <div className="skeleton" style={{ height: 12, width: '60%' }} />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * AlertBadge — ported from components/AlertBadge.jsx
 * ────────────────────────────────────────────────────────────────────── */
export function AlertBadge({ severity }) {
  const s = (severity || 'info').toLowerCase();
  const tone = s === 'critical' ? 'crit' : s === 'warning' ? 'warn' : 'info';
  return (
    <Badge tone={tone} style={s === 'critical' ? { animation: 'pulse-critical 1.8s ease-in-out infinite' } : undefined}>
      {s.charAt(0).toUpperCase() + s.slice(1)}
    </Badge>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Pagination — ported from components/Pagination.jsx (full + compact modes)
 * ────────────────────────────────────────────────────────────────────── */
const PAGE_SIZE_OPTIONS = [25, 50, 100];
const pagerBtnCls = 'co-btn-ghost';

export function Pagination({ page, totalPages, pageSize, onPage, onPageSize, totalItems, compact = false }) {
  if (totalItems === 0) return null;

  if (compact) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, paddingTop: 8 }}>
        <button onClick={() => onPage(page - 1)} disabled={page === 0} aria-label="Previous page" className={pagerBtnCls}>‹</button>
        <span className="tnum" style={{ fontSize: 11, color: 'var(--co-ink-faint)' }}>{page + 1}/{totalPages}</span>
        <button onClick={() => onPage(page + 1)} disabled={page >= totalPages - 1} aria-label="Next page" className={pagerBtnCls}>›</button>
      </div>
    );
  }

  const start = page * pageSize + 1;
  const end = Math.min((page + 1) * pageSize, totalItems);

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingTop: 12, marginTop: 8, borderTop: '1px solid var(--co-border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: 'var(--co-ink-faint)' }}>Rows per page:</span>
        {PAGE_SIZE_OPTIONS.map((s) => (
          <button key={s} onClick={() => onPageSize(s)}
            className="tnum"
            style={{ fontSize: 11, padding: '4px 8px', borderRadius: 6, border: `1px solid ${pageSize === s ? 'var(--co-brand)' : 'var(--co-border)'}`, background: pageSize === s ? 'var(--co-brand)' : 'transparent', color: pageSize === s ? '#0B1015' : 'var(--co-ink-muted)', fontWeight: pageSize === s ? 600 : 400, cursor: 'pointer' }}>
            {s}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="tnum" style={{ fontSize: 11, color: 'var(--co-ink-faint)' }}>{start}–{end} of {totalItems}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button onClick={() => onPage(0)} disabled={page === 0} aria-label="First page" className={pagerBtnCls}>«</button>
          <button onClick={() => onPage(page - 1)} disabled={page === 0} aria-label="Previous page" className={pagerBtnCls}>‹</button>
          <span className="tnum" style={{ fontSize: 11, color: 'var(--co-ink-faint)', padding: '0 4px' }}>{page + 1} / {totalPages}</span>
          <button onClick={() => onPage(page + 1)} disabled={page >= totalPages - 1} aria-label="Next page" className={pagerBtnCls}>›</button>
          <button onClick={() => onPage(totalPages - 1)} disabled={page >= totalPages - 1} aria-label="Last page" className={pagerBtnCls}>»</button>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * tableTools — mirror host frontend/src/components/ui/tableTools.jsx API
 * (used by pages/gflags.jsx and any WP-D table page).
 * ────────────────────────────────────────────────────────────────────── */
export function useTableControls(rows, { searchKeys = [], defaultSortKey = null, defaultSortDir = 'asc', sortValues = {}, paginate = false, defaultPageSize = 25 } = {}) {
  const [q, setQ] = React.useState('');
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
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: 'none', background: 'transparent', color: active ? 'var(--co-ink)' : 'var(--co-ink-muted)', padding: 0 }}
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
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--co-ink-faint)', pointerEvents: 'none' }}>
        <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
      </svg>
      <input value={ctl.q} onChange={(e) => ctl.setQ(e.target.value)} placeholder={placeholder} className="co-input" style={{ paddingLeft: 32 }} />
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
    <select value={ctl.filters[k] || ''} onChange={(e) => ctl.setFilter(k, e.target.value)} className="co-input" style={{ width: 'auto', cursor: 'pointer' }}>
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
      <span className="tnum" style={{ fontSize: 11, color: 'var(--co-ink-faint)', marginLeft: 'auto' }}>
        {ctl.rows.length === total ? `${total} rows` : `${ctl.rows.length} of ${total} rows`}
      </span>
    </div>
  );
}

const TABLE_PAGE_SIZES = [25, 50, 100, 'all'];

export function TablePager({ ctl, sizes = TABLE_PAGE_SIZES }) {
  const total = ctl.rows.length;
  if (!ctl.paginate || total <= sizes[0]) return null;
  const all = ctl.pageSize === 'all';
  const start = all ? 1 : ctl.page * ctl.pageSize + 1;
  const end = all ? total : Math.min((ctl.page + 1) * ctl.pageSize, total);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingTop: 12, marginTop: 4, borderTop: '1px solid var(--co-border)' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--co-ink-faint)' }}>
        Rows per page
        <select value={String(ctl.pageSize)} onChange={(e) => ctl.setPageSize(e.target.value === 'all' ? 'all' : Number(e.target.value))} className="co-input" style={{ width: 'auto', padding: '4px 8px', cursor: 'pointer' }}>
          {sizes.map((s) => <option key={s} value={String(s)}>{s === 'all' ? 'All' : s}</option>)}
        </select>
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="tnum" style={{ fontSize: 11, color: 'var(--co-ink-faint)' }}>{start}–{end} of {total}</span>
        {!all && ctl.pageCount > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button onClick={() => ctl.setPage(0)} disabled={ctl.page === 0} className={pagerBtnCls}>«</button>
            <button onClick={() => ctl.setPage(ctl.page - 1)} disabled={ctl.page === 0} className={pagerBtnCls}>‹</button>
            <span className="tnum" style={{ fontSize: 11, color: 'var(--co-ink-faint)', padding: '0 4px' }}>{ctl.page + 1} / {ctl.pageCount}</span>
            <button onClick={() => ctl.setPage(ctl.page + 1)} disabled={ctl.page >= ctl.pageCount - 1} className={pagerBtnCls}>›</button>
            <button onClick={() => ctl.setPage(ctl.pageCount - 1)} disabled={ctl.page >= ctl.pageCount - 1} className={pagerBtnCls}>»</button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * useToast — no host toast system inside the plugin sandbox, so this is a
 * self-contained module-level store (not React context — no provider
 * needed). <ToastHost/> is mounted once per routed page by index.jsx's
 * rooted() wrapper. API mirrors host components/ui/Toaster.jsx:
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
            <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--co-ink)', margin: 0, lineHeight: 1.35 }}>{t.title}</p>
            {t.message && <p style={{ fontSize: 11, color: 'var(--co-ink-muted)', margin: '2px 0 0', lineHeight: 1.5 }}>{t.message}</p>}
          </div>
          <button onClick={() => toastDismiss(t.id)} aria-label="Dismiss notification" style={{ flexShrink: 0, border: 'none', background: 'transparent', color: 'var(--co-ink-faint)', cursor: 'pointer', padding: 0 }}>
            <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
      ))}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Markdown — minimal renderer for AI Advisor / review output (no raw HTML).
 * Ported pattern from plugin-sdk/dell/frontend/src/pages/advisor.jsx.
 * ────────────────────────────────────────────────────────────────────── */
function renderInline(text, keyPrefix) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) {
      return <strong key={`${keyPrefix}-${i}`} style={{ color: 'var(--co-ink)', fontWeight: 600 }}>{p.slice(2, -2)}</strong>;
    }
    if (p.startsWith('`') && p.endsWith('`')) {
      return <code key={`${keyPrefix}-${i}`} style={{ color: 'var(--co-brand)', background: 'rgba(30,42,54,0.6)', borderRadius: 4, padding: '1px 4px', fontSize: 11 }}>{p.slice(1, -1)}</code>;
    }
    return <span key={`${keyPrefix}-${i}`}>{p}</span>;
  });
}

function parseBlocks(text) {
  const lines = (text || '').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].replace(/\s+$/, '');
    if (line.trim() === '') { i++; continue; }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const boldOnly = line.match(/^\*\*(.+?)\*\*:?\s*$/);
    if (heading) { blocks.push({ type: 'h', text: heading[2] }); i++; continue; }
    if (boldOnly) { blocks.push({ type: 'h', text: boldOnly[1] }); i++; continue; }
    const listRe = /^(\s*)([-*]|\d+[.)])\s+(.*)$/;
    if (listRe.test(line)) {
      const items = [];
      while (i < lines.length) {
        const l = lines[i].replace(/\s+$/, '');
        const m = l.match(listRe);
        if (!m) break;
        items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] });
        i++;
      }
      blocks.push({ type: 'list', tree: buildTree(items) });
      continue;
    }
    blocks.push({ type: 'p', text: line });
    i++;
  }
  return blocks;
}

function buildTree(items) {
  const root = [];
  const stack = [{ indent: -1, children: root }];
  for (const it of items) {
    while (stack.length > 1 && it.indent <= stack[stack.length - 1].indent) stack.pop();
    const node = { ordered: it.ordered, text: it.text, children: [] };
    stack[stack.length - 1].children.push(node);
    stack.push({ indent: it.indent, children: node.children });
  }
  return root;
}

function renderNodes(nodes, key) {
  if (!nodes || nodes.length === 0) return null;
  const ordered = nodes[0].ordered;
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag style={{ paddingLeft: 20, margin: '6px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {nodes.map((n, idx) => (
        <li key={`${key}-${idx}`} style={{ lineHeight: 1.6 }}>
          {renderInline(n.text, `${key}-${idx}`)}
          {n.children.length > 0 && renderNodes(n.children, `${key}-${idx}c`)}
        </li>
      ))}
    </Tag>
  );
}

export function Markdown({ text }) {
  const blocks = parseBlocks(text);
  return (
    <div style={{ fontSize: 13, color: 'var(--co-ink-muted)', lineHeight: 1.6 }}>
      {blocks.map((b, idx) => {
        if (b.type === 'h') {
          return (
            <p key={idx} style={{ fontSize: 14, fontWeight: 700, color: 'var(--co-ink)', marginTop: idx === 0 ? 0 : 16, marginBottom: 6, paddingBottom: 4, borderBottom: '1px solid rgba(31,43,55,0.5)' }}>
              {renderInline(b.text, `h${idx}`)}
            </p>
          );
        }
        if (b.type === 'list') return <div key={idx}>{renderNodes(b.tree, `l${idx}`)}</div>;
        return <p key={idx} style={{ margin: '8px 0' }}>{renderInline(b.text, `p${idx}`)}</p>;
      })}
    </div>
  );
}
