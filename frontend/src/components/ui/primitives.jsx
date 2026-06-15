import { Loader2, TrendingUp, TrendingDown, Minus } from 'lucide-react';

/* ── PageHeader ──────────────────────────────────────────────────────────── */
export function PageHeader({ icon: Icon, title, description, children }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 mb-5 animate-fade-in">
      <div className="flex items-start gap-3 min-w-0">
        {Icon && (
          <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 border border-brand/20 flex-shrink-0">
            <Icon size={18} className="text-brand" />
          </div>
        )}
        <div className="min-w-0">
          <h1 className="text-lg font-bold text-ink leading-tight">{title}</h1>
          {description && <p className="text-xs text-ink-muted mt-0.5">{description}</p>}
        </div>
      </div>
      {children && <div className="flex items-center gap-2 flex-wrap">{children}</div>}
    </div>
  );
}

/* ── StatCard (KPI tile) ─────────────────────────────────────────────────── */
const TONE = {
  default: { icon: 'text-ink-muted', iconBg: 'bg-surface-overlay border-cohesity-border' },
  brand: { icon: 'text-brand', iconBg: 'bg-brand/10 border-brand/20' },
  ok: { icon: 'text-status-ok', iconBg: 'bg-status-ok/10 border-status-ok/20' },
  warn: { icon: 'text-status-warn', iconBg: 'bg-status-warn/10 border-status-warn/20' },
  crit: { icon: 'text-status-crit', iconBg: 'bg-status-crit/10 border-status-crit/20' },
  info: { icon: 'text-status-info', iconBg: 'bg-status-info/10 border-status-info/20' },
};

export function StatCard({ icon: Icon, label, value, sub, tone = 'default', trend, loading, onClick }) {
  const t = TONE[tone] || TONE.default;
  const TrendIcon = trend > 0 ? TrendingUp : trend < 0 ? TrendingDown : Minus;
  const trendColor = trend > 0 ? 'text-status-crit' : trend < 0 ? 'text-status-ok' : 'text-ink-faint';
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      onClick={onClick}
      className={`panel px-4 py-3.5 flex items-center gap-3.5 text-left w-full ${onClick ? 'panel-hover cursor-pointer' : ''}`}
    >
      {Icon && (
        <div className={`flex h-10 w-10 items-center justify-center rounded-lg border flex-shrink-0 ${t.iconBg}`}>
          <Icon size={19} className={t.icon} />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint truncate">{label}</p>
        {loading ? (
          <div className="skeleton h-6 w-20 mt-1" />
        ) : (
          <p className="text-xl font-bold text-ink leading-tight tnum truncate">{value}</p>
        )}
        {sub && !loading && (
          <p className="text-[11px] text-ink-muted truncate flex items-center gap-1">
            {trend !== undefined && <TrendIcon size={11} className={trendColor} />}
            {sub}
          </p>
        )}
      </div>
    </Tag>
  );
}

/* ── Badge ───────────────────────────────────────────────────────────────── */
const BADGE_TONES = {
  ok: 'bg-status-ok/10 text-status-ok border-status-ok/25',
  warn: 'bg-status-warn/10 text-status-warn border-status-warn/25',
  crit: 'bg-status-crit/10 text-status-crit border-status-crit/25',
  info: 'bg-status-info/10 text-status-info border-status-info/25',
  brand: 'bg-brand/10 text-brand border-brand/25',
  neutral: 'bg-surface-overlay text-ink-muted border-cohesity-border',
};

export function Badge({ tone = 'neutral', children, className = '' }) {
  return <span className={`chip ${BADGE_TONES[tone] || BADGE_TONES.neutral} ${className}`}>{children}</span>;
}

/* ── Spinner / loading helpers ───────────────────────────────────────────── */
export function Spinner({ size = 16, className = '' }) {
  return <Loader2 size={size} className={`animate-spin text-brand ${className}`} aria-hidden="true" />;
}

export function LoadingPanel({ label = 'Loading data…', height = 200 }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2.5" style={{ height }} role="status">
      <Spinner size={22} />
      <p className="text-xs text-ink-muted">{label}</p>
    </div>
  );
}

/* ── Panel shell with standard header ────────────────────────────────────── */
export function Panel({ title, icon: Icon, actions, children, className = '', bodyClassName = '' }) {
  return (
    <div className={`panel p-4 ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2 min-w-0">
            {Icon && <Icon size={14} className="text-brand flex-shrink-0" />}
            <p className="panel-title truncate">{title}</p>
          </div>
          {actions && <div className="flex items-center gap-1.5 flex-shrink-0">{actions}</div>}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
    </div>
  );
}
