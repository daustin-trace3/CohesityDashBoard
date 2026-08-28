// Shared helpers for the three site-capacity pages. Visual vocabulary mirrors
// overview.jsx / datastores.jsx (accent panels, StatCards, UsageBar rows).
const { Link } = ReactRouterDOM;
const { Badge } = require('../ui.jsx');

export function fmtMhz(mhz) {
  if (mhz == null) return '—';
  const ghz = mhz / 1000;
  if (ghz >= 1) return `${ghz.toLocaleString(undefined, { maximumFractionDigits: 1 })} GHz`;
  return `${Math.round(mhz).toLocaleString()} MHz`;
}

export function fmtPctInt(p) {
  return p == null ? '—' : `${Math.round(p)}%`;
}

/** Same thresholds as datastores.jsx UsageBar: >90 crit, >80 warn. */
export function pctColor(pct) {
  if (pct == null) return '#6CB33F';
  return pct > 90 ? '#C75D5D' : pct > 80 ? '#D4A24E' : '#6CB33F';
}

export function pctTone(pct) {
  if (pct == null) return 'neutral';
  return pct > 100 ? 'crit' : pct > 80 ? 'warn' : 'ok';
}

/** Thin usage bar + percentage, right-aligned (datastores.jsx style). */
export function UsageBar({ pct, width = 'w-24' }) {
  if (pct == null) return <span className="text-ink-faint">—</span>;
  const color = pctColor(pct);
  return (
    <div className="flex items-center gap-2 justify-end">
      <div className={`${width} h-1.5 rounded-full bg-surface-overlay overflow-hidden`}>
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, pct)}%`, backgroundColor: color }} />
      </div>
      <span className="tnum text-xs" style={{ color: pct > 80 ? color : undefined }}>{pct.toFixed(0)}%</span>
    </div>
  );
}

/** Coloured dot + site name — the site identity used in headers, badges and tables. */
export function SiteDot({ site, size = 10 }) {
  return <span style={{ display: 'inline-block', width: size, height: size, borderRadius: '50%', background: site?.color || 'var(--vc-ink-faint)', flexShrink: 0 }} />;
}

export function SiteBadge({ site }) {
  if (!site) return <Badge tone="neutral">unmapped</Badge>;
  return (
    <span className="vc-chip" style={{ background: 'var(--vc-surface-overlay)', color: 'var(--vc-ink)', borderColor: 'var(--vc-border)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <SiteDot site={site} size={8} />{site.name}
    </span>
  );
}

/** Failover verdict for one target site from the matrix row. */
export function fitVerdict(f) {
  if (!f || f.memUsedPct == null || f.cpuUsedPct == null) return { label: 'No data', tone: 'neutral' };
  const worst = Math.max(f.memUsedPct, f.cpuUsedPct);
  if (!f.fits) return { label: 'Does not fit', tone: 'crit' };
  if (worst > 80) return { label: 'Fits — tight', tone: 'warn' };
  return { label: 'Fits', tone: 'ok' };
}

/** Big-number triple inside a panel (overview.jsx "CPU Capacity" pattern). */
export function BigStat({ value, label, color }) {
  return (
    <div>
      <p className="text-xl font-bold tnum" style={{ color: color || 'var(--vc-ink)' }}>{value}</p>
      <p className="text-[11px] text-ink-faint">{label}</p>
    </div>
  );
}

export function PanelTitle({ icon: IconComp, children, meta }) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-3">
      <p className="text-sm font-semibold text-ink mr-auto" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {IconComp && <IconComp size={15} className="text-brand" />}{children}
      </p>
      {meta && <span className="text-[11px] text-ink-faint tnum">{meta}</span>}
    </div>
  );
}

export function NoSitesState({ what = 'site capacity' }) {
  return (
    <div className="panel p-6 text-center" style={{ borderTop: '3px solid var(--vc-brand)' }}>
      <p className="text-sm font-semibold text-ink mb-1">No sites defined yet</p>
      <p className="text-xs text-ink-muted mb-3">
        Create your sites and assign each cluster to one under{' '}
        <Link to="/vcenter/settings#sites" className="text-brand hover:underline">vCenter → Settings → Sites</Link>. {what[0].toUpperCase() + what.slice(1)} appears as soon as the first cluster is mapped.
      </p>
    </div>
  );
}
