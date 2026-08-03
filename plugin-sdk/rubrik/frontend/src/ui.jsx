// Rubrik v2.0.0 style kit ("rbk-" prefix) — cloned from the host dashboard's
// design system (frontend/src/index.css + tailwind.config.js +
// components/ui/primitives.jsx + components/ui/tableTools.jsx) with the
// brand color swapped to Rubrik green (#00B388). No Tailwind classnames are
// available inside a plugin bundle (the host's CSS purge only scans host
// source), so this kit installs real CSS via a single injected <style> tag
// and exposes className-based components that consume it.

const STYLE_ID = 'rbk-plugin-styles';

const CSS = `
:root {
  --rbk-surface-base: #0B1015;
  --rbk-surface: #131B23;
  --rbk-surface-raised: #18222C;
  --rbk-surface-overlay: #1E2A36;
  --rbk-border: #1F2B37;
  --rbk-ink: #E8EDF2;
  --rbk-ink-muted: #94A3B3;
  --rbk-ink-faint: #5F7081;
  --rbk-brand: #00B388;
  --rbk-brand-dark: #008F6D;
  --rbk-ok: #34D399;
  --rbk-warn: #FBBF24;
  --rbk-crit: #F87171;
  --rbk-info: #60A5FA;
}

.rbk-root { font-family: inherit; color: var(--rbk-ink); }

.rbk-panel {
  background: var(--rbk-surface);
  border: 1px solid var(--rbk-border);
  border-radius: 12px;
  box-shadow: 0 1px 2px rgba(0,0,0,.4), inset 0 0 0 1px rgba(255,255,255,.02);
}
.rbk-panel-hover {
  transition: border-color 200ms, box-shadow 200ms;
}
.rbk-panel-hover:hover {
  border-color: rgba(0,179,136,0.4);
  box-shadow: 0 4px 16px rgba(0,0,0,.45), 0 0 0 1px rgba(0,179,136,.18);
}
.rbk-panel-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--rbk-ink-muted);
}

.rbk-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 11px;
  font-weight: 500;
  border: 1px solid transparent;
}

.rbk-tnum { font-variant-numeric: tabular-nums; }

.rbk-skeleton {
  background: linear-gradient(90deg, #18222C 25%, #1E2A36 37%, #18222C 63%);
  background-size: 400px 100%;
  animation: rbk-shimmer 1.6s linear infinite;
  border-radius: 6px;
}
@keyframes rbk-shimmer {
  0% { background-position: -400px 0; }
  100% { background-position: 400px 0; }
}

.rbk-fade-in { animation: rbk-fade-in 220ms ease-out both; }
@keyframes rbk-fade-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
.rbk-stagger > * {
  animation: rbk-fade-in 220ms ease-out both;
  animation-delay: calc(var(--rbk-i, 0) * 20ms);
}

.rbk-orb {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--rbk-ok);
  animation: rbk-orb-pulse 2.5s ease-in-out infinite;
}
@keyframes rbk-orb-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.rbk-pulse-crit { animation: rbk-pulse-red 1.8s ease-in-out infinite; }
@keyframes rbk-pulse-red {
  0%, 100% { box-shadow: 0 0 0 0 rgba(248,113,113,0); border-color: #f87171; }
  50% { box-shadow: 0 0 0 6px rgba(248,113,113,0.28); border-color: rgba(248,113,113,0.6); }
}

.rbk-row:hover { background: rgba(30,42,54,0.5); }

.rbk-input {
  width: 100%;
  background: var(--rbk-surface-overlay);
  border: 1px solid var(--rbk-border);
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 13px;
  color: var(--rbk-ink);
  outline: none;
  box-sizing: border-box;
}
.rbk-input:focus { border-color: rgba(0,179,136,0.6); }

.rbk-btn-ghost {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  border: 1px solid var(--rbk-border);
  background: transparent;
  color: var(--rbk-ink-muted);
  cursor: pointer;
  transition: color 150ms, border-color 150ms;
}
.rbk-btn-ghost:hover { color: var(--rbk-ink); border-color: rgba(0,179,136,0.4); }
.rbk-btn-ghost:disabled { opacity: 0.5; cursor: default; }

.rbk-btn-accent {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  border: 1px solid rgba(0,179,136,0.3);
  background: rgba(0,179,136,0.1);
  color: var(--rbk-brand);
  cursor: pointer;
  transition: background 150ms;
}
.rbk-btn-accent:hover { background: rgba(0,179,136,0.2); }
.rbk-btn-accent:disabled { opacity: 0.5; cursor: default; }

.rbk-pill {
  display: inline-flex;
  align-items: center;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  border: 1px solid var(--rbk-border);
  background: var(--rbk-surface);
  color: var(--rbk-ink);
}
.rbk-pill-active {
  background: var(--rbk-brand);
  border-color: var(--rbk-brand);
  color: #0B1015;
  font-weight: 600;
}

.rbk-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.rbk-scroll::-webkit-scrollbar-track { background: transparent; }
.rbk-scroll::-webkit-scrollbar-thumb { background: #2A3845; border-radius: 4px; border: 2px solid var(--rbk-surface-base); }
.rbk-scroll::-webkit-scrollbar-thumb:hover { background: #3B4D5E; }

@media (prefers-reduced-motion: reduce) {
  .rbk-root *, .rbk-root *::before, .rbk-root *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
  .rbk-skeleton { animation: none !important; }
  .rbk-fade-in { animation: none !important; opacity: 1 !important; transform: none !important; }
  .rbk-stagger > * { animation: none !important; }
  .rbk-orb { animation: none !important; }
  .rbk-pulse-crit { animation: none !important; }
}
`;

export function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/* ────────────────────────────────────────────────────────────────────────
 * Inline-SVG icon set — 16px, stroke-width 1.75, lucide-look. No lucide
 * import (plugin sandbox forbids host package imports).
 * ────────────────────────────────────────────────────────────────────── */
function Icon({ children, size = 16, className = '', ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      {children}
    </svg>
  );
}

export const GearIcon = (p) => <Icon {...p}><circle cx="12" cy="12" r="3" /><path d="M4 12h3M17 12h3M12 4v3M12 17v3M6.5 6.5l2 2M15.5 15.5l2 2M17.5 6.5l-2 2M8.5 15.5l-2 2" /></Icon>;
export const BellIcon = (p) => <Icon {...p}><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></Icon>;
export const ShieldIcon = (p) => <Icon {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /></Icon>;
export const ServerIcon = (p) => <Icon {...p}><rect x="2" y="3" width="20" height="7" rx="1.5" /><rect x="2" y="14" width="20" height="7" rx="1.5" /><path d="M6 6.5h.01M6 17.5h.01" /></Icon>;
export const LayersIcon = (p) => <Icon {...p}><path d="M12 2 2 7l10 5 10-5-10-5Z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" /></Icon>;
export const DbIcon = (p) => <Icon {...p}><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" /><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" /></Icon>;
export const ChartIcon = (p) => <Icon {...p}><path d="M3 3v18h18" /><path d="M7 16l4-6 4 3 5-7" /></Icon>;
export const CalendarIcon = (p) => <Icon {...p}><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></Icon>;
export const BoxesIcon = (p) => <Icon {...p}><path d="M2.5 8 12 3l9.5 5-9.5 5-9.5-5Z" /><path d="M2.5 8v8l9.5 5 9.5-5V8" /><path d="M12 13v8" /></Icon>;
export const ActivityIcon = (p) => <Icon {...p}><path d="M22 12h-4l-3 9-6-18-3 9H2" /></Icon>;
export const FileIcon = (p) => <Icon {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z" /><path d="M14 2v6h6" /></Icon>;
export const ClipboardIcon = (p) => <Icon {...p}><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" /></Icon>;
export const ArrowsIcon = (p) => <Icon {...p}><path d="M17 3l4 4-4 4" /><path d="M21 7H9a4 4 0 0 0-4 4v1" /><path d="M7 21l-4-4 4-4" /><path d="M3 17h12a4 4 0 0 0 4-4v-1" /></Icon>;
export const ChevronsIcon = (p) => <Icon {...p}><path d="M7 8l5-5 5 5" /><path d="M7 16l5 5 5-5" /></Icon>;
export const SearchIcon = (p) => <Icon {...p}><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></Icon>;
export const XIcon = (p) => <Icon {...p}><path d="M18 6 6 18M6 6l12 12" /></Icon>;
export const LockIcon = (p) => <Icon {...p}><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></Icon>;
export const RefreshIcon = (p) => <Icon {...p}><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></Icon>;
export const ChevronUpIcon = (p) => <Icon {...p}><path d="M18 15l-6-6-6 6" /></Icon>;
export const ChevronDownIcon = (p) => <Icon {...p}><path d="M6 9l6 6 6-6" /></Icon>;
export const DownloadIcon = (p) => <Icon {...p}><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M5 21h14" /></Icon>;
export const TrendUpIcon = (p) => <Icon {...p}><path d="M23 6l-9.5 9.5-5-5L1 18" /><path d="M17 6h6v6" /></Icon>;
export const TrendDownIcon = (p) => <Icon {...p}><path d="M23 18l-9.5-9.5-5 5L1 6" /><path d="M17 18h6v-6" /></Icon>;
export const MinusIcon = (p) => <Icon {...p}><path d="M5 12h14" /></Icon>;
export const LoaderIcon = (p) => <Icon {...p}><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" /></Icon>;

/* ────────────────────────────────────────────────────────────────────────
 * Primitives — mirror host frontend/src/components/ui/primitives.jsx
 * ────────────────────────────────────────────────────────────────────── */

export function PageHeader({ icon: IconComp, title, description, children }) {
  return (
    <div className="rbk-fade-in" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, minWidth: 0 }}>
        {IconComp && (
          <div style={{ marginTop: 2, display: 'flex', height: 36, width: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'rgba(0,179,136,0.1)', border: '1px solid rgba(0,179,136,0.2)', flexShrink: 0 }}>
            <IconComp size={18} style={{ color: 'var(--rbk-brand)' }} />
          </div>
        )}
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: 18, fontWeight: 700, color: 'var(--rbk-ink)', lineHeight: 1.2, margin: 0 }}>{title}</h1>
          {description && <p style={{ fontSize: 12, color: 'var(--rbk-ink-muted)', margin: '2px 0 0' }}>{description}</p>}
        </div>
      </div>
      {children && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{children}</div>}
    </div>
  );
}

const TONE = {
  default: { icon: 'var(--rbk-ink-muted)', iconBg: 'var(--rbk-surface-overlay)', iconBorder: 'var(--rbk-border)' },
  brand: { icon: 'var(--rbk-brand)', iconBg: 'rgba(0,179,136,0.1)', iconBorder: 'rgba(0,179,136,0.2)' },
  ok: { icon: 'var(--rbk-ok)', iconBg: 'rgba(52,211,153,0.1)', iconBorder: 'rgba(52,211,153,0.2)' },
  warn: { icon: 'var(--rbk-warn)', iconBg: 'rgba(251,191,36,0.1)', iconBorder: 'rgba(251,191,36,0.2)' },
  crit: { icon: 'var(--rbk-crit)', iconBg: 'rgba(248,113,113,0.1)', iconBorder: 'rgba(248,113,113,0.2)' },
  info: { icon: 'var(--rbk-info)', iconBg: 'rgba(96,165,250,0.1)', iconBorder: 'rgba(96,165,250,0.2)' },
};

export function StatCard({ icon: IconComp, label, value, sub, tone = 'default', onClick, loading }) {
  const t = TONE[tone] || TONE.default;
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      onClick={onClick}
      className={`rbk-panel${onClick ? ' rbk-panel-hover' : ''}`}
      style={{
        padding: '14px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        textAlign: 'left',
        width: '100%',
        border: '1px solid var(--rbk-border)',
        cursor: onClick ? 'pointer' : 'default',
        font: 'inherit',
      }}
    >
      {IconComp && (
        <div style={{ display: 'flex', height: 40, width: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: `1px solid ${t.iconBorder}`, background: t.iconBg, flexShrink: 0 }}>
          <IconComp size={19} style={{ color: t.icon }} />
        </div>
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--rbk-ink-faint)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</p>
        {loading ? (
          <div className="rbk-skeleton" style={{ height: 24, width: 80, marginTop: 4 }} />
        ) : (
          <p className="rbk-tnum" style={{ fontSize: 20, fontWeight: 700, color: 'var(--rbk-ink)', lineHeight: 1.2, margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</p>
        )}
        {sub && !loading && (
          <p style={{ fontSize: 11, color: 'var(--rbk-ink-muted)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</p>
        )}
      </div>
    </Tag>
  );
}

const BADGE_TONES = {
  ok: { bg: 'rgba(52,211,153,0.1)', color: 'var(--rbk-ok)', border: 'rgba(52,211,153,0.25)' },
  warn: { bg: 'rgba(251,191,36,0.1)', color: 'var(--rbk-warn)', border: 'rgba(251,191,36,0.25)' },
  crit: { bg: 'rgba(248,113,113,0.1)', color: 'var(--rbk-crit)', border: 'rgba(248,113,113,0.25)' },
  info: { bg: 'rgba(96,165,250,0.1)', color: 'var(--rbk-info)', border: 'rgba(96,165,250,0.25)' },
  brand: { bg: 'rgba(0,179,136,0.1)', color: 'var(--rbk-brand)', border: 'rgba(0,179,136,0.25)' },
  neutral: { bg: 'var(--rbk-surface-overlay)', color: 'var(--rbk-ink-muted)', border: 'var(--rbk-border)' },
};

export function Badge({ tone = 'neutral', children, style }) {
  const t = BADGE_TONES[tone] || BADGE_TONES.neutral;
  return (
    <span className="rbk-chip" style={{ background: t.bg, color: t.color, borderColor: t.border, ...style }}>
      {children}
    </span>
  );
}

export function Spinner({ size = 16, style }) {
  return (
    <LoaderIcon
      size={size}
      style={{ color: 'var(--rbk-brand)', animation: 'rbk-spin 0.8s linear infinite', ...style }}
    />
  );
}

// keyframe for spinner (kept out of the main CSS block scope-wise, but
// injected once alongside it)
if (typeof document !== 'undefined' && !document.getElementById('rbk-spin-kf')) {
  const s = document.createElement('style');
  s.id = 'rbk-spin-kf';
  s.textContent = '@keyframes rbk-spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(s);
}

export function LoadingPanel({ label = 'Loading data…', height = 200 }) {
  return (
    <div role="status" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, height }}>
      <Spinner size={22} />
      <p style={{ fontSize: 12, color: 'var(--rbk-ink-muted)', margin: 0 }}>{label}</p>
    </div>
  );
}

export function SkeletonTable({ rows = 5, colWidths = ['30%', '20%', '20%', '15%', '15%'] }) {
  return (
    <div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: i < rows - 1 ? '1px solid var(--rbk-border)' : 'none' }}>
          {colWidths.map((w, j) => (
            <div key={j} className="rbk-skeleton" style={{ height: 14, width: w }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ icon: IconComp, title = 'No data', description, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '40px 16px', textAlign: 'center' }}>
      {IconComp && <IconComp size={28} style={{ color: 'var(--rbk-ink-faint)' }} />}
      <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--rbk-ink-muted)', margin: 0 }}>{title}</p>
      {description && <p style={{ fontSize: 12, color: 'var(--rbk-ink-faint)', margin: 0, maxWidth: 360 }}>{description}</p>}
      {children}
    </div>
  );
}

export function Panel({ title, icon: IconComp, actions, children, style, bodyStyle }) {
  return (
    <div className="rbk-panel" style={{ padding: 16, ...style }}>
      {(title || actions) && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            {IconComp && <IconComp size={14} style={{ color: 'var(--rbk-brand)', flexShrink: 0 }} />}
            <p className="rbk-panel-title" style={{ margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</p>
          </div>
          {actions && <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>{actions}</div>}
        </div>
      )}
      <div style={bodyStyle}>{children}</div>
    </div>
  );
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

export function fmtBytes(bytes) {
  if (bytes == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let n = Math.abs(bytes);
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  const sign = bytes < 0 ? '-' : '';
  return `${sign}${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fmtPct(v, digits = 0) {
  if (v == null || Number.isNaN(v)) return '—';
  return `${v.toFixed(digits)}%`;
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
    <span className="rbk-tnum" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--rbk-ink-faint)' }}>
      {prefix && <span>{prefix}</span>}
      <span>{label}</span>
    </span>
  );
}

export function RefreshButton({ onClick, refreshing, label = 'Refresh' }) {
  return (
    <button onClick={onClick} disabled={refreshing} className="rbk-btn-ghost">
      <RefreshIcon size={14} style={refreshing ? { animation: 'rbk-spin 0.8s linear infinite' } : undefined} />
      {refreshing ? 'Refreshing…' : label}
    </button>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * tableTools-lite — mirror host components/ui/tableTools.jsx API
 * ────────────────────────────────────────────────────────────────────── */

export function useTableControls(rows, { searchKeys = [], defaultSortKey = null, defaultSortDir = 'asc', sortValues = {}, paginate = false, defaultPageSize = 25 } = {}) {
  const [q, setQ] = React.useState(() => {
    try {
      return new URLSearchParams(window.location.search).get('q') || '';
    } catch {
      return '';
    }
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
    else {
      setSortKey(key);
      setSortDir('asc');
    }
  };
  const setFilter = (key, value) => setFilters((f) => ({ ...f, [key]: value }));

  React.useEffect(() => {
    setPage(0);
  }, [q, filters, sortKey, sortDir, pageSize]);

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
    <th style={{ padding: '8px 12px 8px 0', textAlign: align, ...style }}>
      <button
        onClick={() => ctl.toggleSort(k)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, textTransform: 'uppercase', letterSpacing: '0.03em', fontSize: 11, fontWeight: 600, cursor: 'pointer', border: 'none', background: 'transparent', color: active ? 'var(--rbk-ink)' : 'var(--rbk-ink-muted)', padding: 0 }}
      >
        {label}
        {active && (ctl.sortDir === 'asc' ? <ChevronUpIcon size={12} /> : <ChevronDownIcon size={12} />)}
      </button>
    </th>
  );
}

export function TableSearch({ ctl, placeholder = 'Search…', style }) {
  return (
    <div style={{ position: 'relative', width: '100%', maxWidth: 320, ...style }}>
      <SearchIcon size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--rbk-ink-faint)', pointerEvents: 'none' }} />
      <input
        value={ctl.q}
        onChange={(e) => ctl.setQ(e.target.value)}
        placeholder={placeholder}
        className="rbk-input"
        style={{ paddingLeft: 32 }}
      />
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
    <select
      value={ctl.filters[k] || ''}
      onChange={(e) => ctl.setFilter(k, e.target.value)}
      className="rbk-input"
      style={{ width: 'auto', cursor: 'pointer' }}
    >
      <option value="">All {label}</option>
      {options.map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </select>
  );
}

export function TableControls({ ctl, rows, searchPlaceholder, filters = [] }) {
  const total = (rows || []).length;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12 }}>
      <TableSearch ctl={ctl} placeholder={searchPlaceholder} />
      {filters.map((f) => (
        <FilterSelect key={f.k} ctl={ctl} k={f.k} rows={rows} label={f.label} />
      ))}
      <span className="rbk-tnum" style={{ fontSize: 11, color: 'var(--rbk-ink-faint)', marginLeft: 'auto' }}>
        {ctl.rows.length === total ? `${total} rows` : `${ctl.rows.length} of ${total} rows`}
      </span>
    </div>
  );
}

const PAGE_SIZES = [25, 50, 100, 'all'];
const pagerBtnStyle = {
  fontSize: 11,
  padding: '4px 8px',
  borderRadius: 6,
  border: '1px solid var(--rbk-border)',
  background: 'transparent',
  color: 'var(--rbk-ink-muted)',
  cursor: 'pointer',
};

export function TablePager({ ctl, sizes = PAGE_SIZES }) {
  const total = ctl.rows.length;
  if (!ctl.paginate || total <= sizes[0]) return null;
  const all = ctl.pageSize === 'all';
  const start = all ? 1 : ctl.page * ctl.pageSize + 1;
  const end = all ? total : Math.min((ctl.page + 1) * ctl.pageSize, total);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingTop: 12, marginTop: 4, borderTop: '1px solid var(--rbk-border)' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--rbk-ink-faint)' }}>
        Rows per page
        <select
          value={String(ctl.pageSize)}
          onChange={(e) => ctl.setPageSize(e.target.value === 'all' ? 'all' : Number(e.target.value))}
          className="rbk-input"
          style={{ width: 'auto', padding: '4px 8px', cursor: 'pointer' }}
        >
          {sizes.map((s) => (
            <option key={s} value={String(s)}>{s === 'all' ? 'All' : s}</option>
          ))}
        </select>
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="rbk-tnum" style={{ fontSize: 11, color: 'var(--rbk-ink-faint)' }}>{start}–{end} of {total}</span>
        {!all && ctl.pageCount > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button onClick={() => ctl.setPage(0)} disabled={ctl.page === 0} style={pagerBtnStyle}>«</button>
            <button onClick={() => ctl.setPage(ctl.page - 1)} disabled={ctl.page === 0} style={pagerBtnStyle}>‹</button>
            <span className="rbk-tnum" style={{ fontSize: 11, color: 'var(--rbk-ink-faint)', padding: '0 4px' }}>{ctl.page + 1} / {ctl.pageCount}</span>
            <button onClick={() => ctl.setPage(ctl.page + 1)} disabled={ctl.page >= ctl.pageCount - 1} style={pagerBtnStyle}>›</button>
            <button onClick={() => ctl.setPage(ctl.pageCount - 1)} disabled={ctl.page >= ctl.pageCount - 1} style={pagerBtnStyle}>»</button>
          </div>
        )}
      </div>
    </div>
  );
}

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
    <button onClick={onClick} disabled={!rows?.length} className="rbk-btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}>
      <DownloadIcon size={12} /> Export
    </button>
  );
}
