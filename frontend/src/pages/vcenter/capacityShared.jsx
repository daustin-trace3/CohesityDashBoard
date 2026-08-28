import { Link } from 'react-router-dom';
import { Badge } from '../../components/ui/primitives';
import { usageTone, fmtBytes, fmtNum } from './helpers';

export function fmtMhz(mhz) {
  if (mhz == null) return '—';
  const ghz = mhz / 1000;
  if (ghz >= 1) return `${ghz.toLocaleString(undefined, { maximumFractionDigits: 1 })} GHz`;
  return `${Math.round(mhz).toLocaleString()} MHz`;
}

export function fmtPctInt(p) {
  return p == null ? '—' : `${Math.round(p)}%`;
}

export function pctColor(pct) {
  if (pct == null) return '#6CB33F';
  return pct > 90 ? '#C75D5D' : pct > 80 ? '#D4A24E' : '#6CB33F';
}

export function pctTone(pct) {
  if (pct == null) return 'neutral';
  return pct > 100 ? 'crit' : pct > 80 ? 'warn' : 'ok';
}

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

export function SiteDot({ site, size = 10 }) {
  return <span style={{ display: 'inline-block', width: size, height: size, borderRadius: '50%', background: site?.color || 'var(--ink-faint)', flexShrink: 0 }} />;
}

export function SiteBadge({ site }) {
  if (!site) return <Badge tone="neutral">unmapped</Badge>;
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-surface-overlay border border-cohesity-border text-ink text-xs">
      <SiteDot site={site} size={8} />{site.name}
    </span>
  );
}

export function fitVerdict(f) {
  if (!f || f.memUsedPct == null || f.cpuUsedPct == null) return { label: 'No data', tone: 'neutral' };
  const worst = Math.max(f.memUsedPct, f.cpuUsedPct);
  if (!f.fits) return { label: 'Does not fit', tone: 'crit' };
  if (worst > 80) return { label: 'Fits — tight', tone: 'warn' };
  return { label: 'Fits', tone: 'ok' };
}

export function BigStat({ value, label, color }) {
  return (
    <div>
      <p className="text-xl font-bold tnum" style={{ color: color || 'var(--ink)' }}>{value}</p>
      <p className="text-[11px] text-ink-faint">{label}</p>
    </div>
  );
}

export function PanelTitle({ icon: IconComp, children, meta }) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-3">
      <p className="text-sm font-semibold text-ink mr-auto flex items-center gap-2">
        {IconComp && <IconComp size={15} className="text-brand" />}{children}
      </p>
      {meta && <span className="text-[11px] text-ink-faint tnum">{meta}</span>}
    </div>
  );
}

export function AxisBars({ allocated = 0, used = 0, usable = 0, isMemory = false, isStorage = false }) {
  const total = Math.max(allocated, used, usable, 1);
  const allocPct = (allocated / total) * 100;
  const usedPct = (used / total) * 100;
  const usablePct = (usable / total) * 100;

  // Used % of usable (what matters for warnings)
  const usedOfUsablePct = usable > 0 ? (used / usable) * 100 : 0;
  const usedOfAllocPct = allocated > 0 ? (used / allocated) * 100 : 0;
  const allocOfAllocPct = allocated > 0 ? (allocated / allocated) * 100 : 0;

  const fmt = isMemory ? fmtBytes : isStorage ? fmtBytes : fmtMhz;

  return (
    <div className="space-y-3">
      {/* Allocated */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <p className="text-xs font-semibold text-ink-muted">Allocated</p>
          <p className="text-xs text-ink">{fmt(allocated)}</p>
        </div>
        <div className="h-1.5 rounded-full bg-surface-overlay overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${Math.min(100, allocPct)}%`, backgroundColor: '#4ED4B8' }} />
        </div>
      </div>

      {/* Used */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <p className="text-xs font-semibold text-ink-muted">Used</p>
          <p className="text-xs text-ink">{fmt(used)} ({usedOfAllocPct.toFixed(0)}%)</p>
        </div>
        <div className="h-1.5 rounded-full bg-surface-overlay overflow-hidden">
          <div className="h-full rounded-full" style={{
            width: `${Math.min(100, usedPct)}%`,
            backgroundColor: usedOfAllocPct > 90 ? '#C75D5D' : usedOfAllocPct > 80 ? '#D4A24E' : '#6CB33F',
          }} />
        </div>
      </div>

      {/* Usable (N+1) */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <p className="text-xs font-semibold text-ink-muted">N+1 Usable</p>
          <p className="text-xs text-ink">{fmt(usable)} ({usedOfUsablePct.toFixed(0)}%)</p>
        </div>
        <div className="h-1.5 rounded-full bg-surface-overlay overflow-hidden">
          <div className="h-full rounded-full" style={{
            width: `${Math.min(100, usablePct)}%`,
            backgroundColor: usedOfUsablePct > 90 ? '#C75D5D' : usedOfUsablePct > 80 ? '#D4A24E' : '#6CB33F',
          }} />
        </div>
      </div>
    </div>
  );
}

export function NoSitesState({ what = 'site capacity' }) {
  return (
    <div className="panel p-6 text-center" style={{ borderTop: '3px solid var(--brand)' }}>
      <p className="text-sm font-semibold text-ink mb-1">No sites defined yet</p>
      <p className="text-xs text-ink-muted mb-3">
        Create your sites and assign each cluster to one under{' '}
        <Link to="/vcenter/settings#sites" className="text-brand hover:underline">vCenter → Settings → Sites</Link>. {what[0].toUpperCase() + what.slice(1)} appears as soon as the first cluster is mapped.
      </p>
    </div>
  );
}
