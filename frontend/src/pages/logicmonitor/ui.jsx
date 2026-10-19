// Small shared pieces for the LogicMonitor pages (modal shell, server-side
// pager and sort header, section panel). Modals portal to body because the
// page fade-in creates a containing block (cohesity-dashboard-ui-gotchas).
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight, ChevronUp, ChevronDown } from 'lucide-react';
import { BRAND, fmtNum, fmtPct } from './helpers';
import { InfoTip } from '../../components/settings/SettingRow';

export const inp = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none';
export const sel = 'bg-surface-overlay border border-cohesity-border rounded-lg px-2 py-2 text-xs text-ink outline-none cursor-pointer';
export const iconBtn = 'flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-40';
export const btnPrimary = 'px-4 py-2 rounded-lg text-sm font-semibold bg-brand text-cohesity-black hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer';
export const btnGhost = 'px-4 py-2 rounded-lg text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50';
export const headRow = 'text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border';
export const chipBtn = (on) => `px-2.5 py-1 rounded-lg text-xs font-semibold cursor-pointer transition-colors border ${on ? 'bg-brand/10 text-brand border-brand/30' : 'text-ink-muted border-cohesity-border hover:text-ink'}`;

export function Modal({ title, subtitle, icon: Icon, onClose, width = 'max-w-4xl', children }) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className={`relative panel w-full ${width} max-h-[88vh] flex flex-col`} style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-start justify-between gap-2 p-4 pb-3 border-b border-cohesity-border">
          <div className="flex items-center gap-2 min-w-0">
            {Icon && <Icon size={17} className="text-brand shrink-0" />}
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink truncate">{title}</p>
              {subtitle && <p className="text-[11px] text-ink-faint truncate">{subtitle}</p>}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className={iconBtn}><X size={14} /></button>
        </div>
        <div className="p-4 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body
  );
}

export function SectionPanel({ icon: Icon, title, blurb, right, children, className = '' }) {
  return (
    <div className={`panel p-4 ${className}`} style={{ borderTop: `3px solid ${BRAND}` }}>
      {(title || right) && (
        <div className="flex items-center justify-between gap-2 mb-1">
          <p className="text-sm font-semibold text-ink flex items-center gap-2">{Icon && <Icon size={15} className="text-brand" />} {title}</p>
          {right}
        </div>
      )}
      {blurb && <p className="text-[11px] text-ink-muted mb-3 leading-relaxed">{blurb}</p>}
      {!blurb && title && <div className="mb-2" />}
      {children}
    </div>
  );
}

// Header cell for a server-sorted table.
export function ServerSortTh({ k, label, sort, dir, onSort, align = 'left' }) {
  const active = sort === k;
  return (
    <th className={`py-2 pr-3 ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <button onClick={() => onSort(k)} className={`inline-flex items-center gap-1 uppercase tracking-wide cursor-pointer hover:text-ink ${active ? 'text-ink' : ''}`}>
        {label}{active && (dir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
      </button>
    </th>
  );
}

// Footer for server-paged tables (EonResourcesPage pattern). 'all' maps to
// the API's 500-row cap and the footer says so when it bites.
export function ServerPager({ shown, total, page, setPage, pageSize, setPageSize, noun = 'row(s)' }) {
  const limit = pageSize === 'all' ? 500 : pageSize;
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="flex items-center justify-between mt-3 flex-wrap gap-2">
      <p className="text-[11px] text-ink-faint">
        Showing {fmtNum(shown)} of {fmtNum(total)} {noun}
        {pageSize === 'all' && total > 500 ? ' (All is capped at 500 per page)' : ''}
      </p>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-ink-faint">Per page</span>
          {[25, 50, 100, 'all'].map((n) => (
            <button key={n} onClick={() => { setPageSize(n); setPage(1); }}
              className={`px-2 py-1 rounded-md text-[11px] cursor-pointer border ${pageSize === n ? 'border-brand text-ink bg-surface-overlay' : 'border-cohesity-border text-ink-muted hover:text-ink'}`}>
              {n === 'all' ? 'All' : n}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className={iconBtn} aria-label="Previous page"><ChevronLeft size={14} /></button>
          <span className="text-xs text-ink-muted tnum">{page} / {pages}</span>
          <button onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages} className={iconBtn} aria-label="Next page"><ChevronRight size={14} /></button>
        </div>
      </div>
    </div>
  );
}

export function Tabs({ tabs, active, onSelect }) {
  return (
    <div className="flex items-center gap-1 border-b border-cohesity-border mb-3 flex-wrap">
      {tabs.map((t) => (
        <button key={t.key} onClick={() => onSelect(t.key)}
          className={`px-3 py-2 text-xs font-semibold cursor-pointer border-b-2 -mb-px transition-colors ${active === t.key ? 'border-brand text-ink' : 'border-transparent text-ink-muted hover:text-ink'}`}>
          {t.label}{t.count != null ? <span className="ml-1 text-ink-faint tnum">({t.count})</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Fact({ label, children }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="text-xs text-ink truncate">{children ?? '-'}</p>
    </div>
  );
}

// A percent cell: a value outside 0..100 is not a percent (a wrong catalog pick), so show a dash with the reason.
export const pctInRange = (v) => v != null && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100;
export function PctValue({ v, digits = 0 }) {
  if (v == null || !Number.isFinite(Number(v))) return <>{fmtPct(v, digits)}</>;
  if (!pctInRange(v)) return <span title="not a percent, check the catalog pick">-</span>;
  return <>{fmtPct(v, digits)}</>;
}

export function UtilBar({ pct }) {
  if (pct == null || !Number.isFinite(Number(pct))) return <span className="text-ink-faint text-[11px]">-</span>;
  const v = Math.max(0, Math.min(100, Number(pct)));
  const tone = v >= 80 ? 'bg-status-crit' : v >= 60 ? 'bg-status-warn' : 'bg-status-ok';
  return (
    <div className="flex items-center gap-1.5 min-w-[80px]">
      <div className="h-1.5 flex-1 rounded-full bg-surface-overlay overflow-hidden"><div className={`h-full ${tone}`} style={{ width: `${v}%` }} /></div>
      <span className="text-[11px] tnum text-ink w-9 text-right">{Math.round(v)}%</span>
    </div>
  );
}

// SortTh from the table kit plus an info tip beside the label (a tip cannot
// live inside the sort button, buttons do not nest).
export function SortThTip({ k, label, ctl, tip, align = 'left' }) {
  const active = ctl.sortKey === k;
  return (
    <th className={`py-2 pr-3 ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <span className="inline-flex items-center gap-1">
        <button onClick={() => ctl.toggleSort(k)}
          className={`inline-flex items-center gap-1 uppercase tracking-wide cursor-pointer transition-colors hover:text-ink ${active ? 'text-ink' : ''}`}>
          {label}{active && (ctl.sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
        </button>
        <InfoTip label={typeof label === 'string' ? label : undefined}>{tip}</InfoTip>
      </span>
    </th>
  );
}
