// Small shared pieces for the F5 analytics pages: severity tones, forecast cells that always show their
// basis, and the "feed not available" note every page shows instead of an error.
import { Badge } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, TablePager } from '../../components/ui/tableTools';
import { headRow } from '../logicmonitor/ui';
import { DASH, fmtNum } from '../logicmonitor/helpers';
import { BRAND } from './f5Shared';

export const sevTone = (s) => (s === 'critical' ? 'crit' : s === 'warning' ? 'warn' : s === 'info' ? 'info' : s === 'ok' ? 'ok' : 'neutral');
export const sevWord = (s) => (s === 'critical' ? 'Critical' : s === 'warning' ? 'Warning' : s === 'info' ? 'Info' : s === 'ok' ? 'OK' : DASH);

export const n1 = (v) => (v == null || !Number.isFinite(Number(v)) ? DASH : (Math.round(Number(v) * 10) / 10).toLocaleString('en-US'));
export const pct1 = (v) => (v == null || !Number.isFinite(Number(v)) ? DASH : `${n1(v)}%`);

/** Days until a threshold, with the basis of the fit; "insufficient data" when days is null. */
export function ForecastCell({ f, warnDays = 30 }) {
  if (!f || f.days == null) {
    return <span className="text-ink-faint text-[12px]" title={f?.basis || 'insufficient data'}>insufficient data</span>;
  }
  const tone = f.days <= 7 ? 'crit' : f.days <= warnDays ? 'warn' : 'neutral';
  return (
    <span title={f.basis || ''} className="inline-flex items-center gap-1.5">
      <Badge tone={tone}>{f.days <= 0 ? 'now' : `${fmtNum(Math.round(f.days))} d`}</Badge>
      {f.basis ? <span className="text-[11px] text-ink-faint hidden xl:inline">{f.basis}</span> : null}
    </span>
  );
}

export function FeedNote({ what }) {
  return (
    <div className="panel p-6 text-sm text-ink-muted text-center" style={{ borderTop: `3px solid ${BRAND}` }}>
      {what} is not available yet. It fills in after the LogicMonitor poller has collected and computed the daily history
      (the trend job runs hourly). Nothing is wrong with the F5 devices when this shows.
    </div>
  );
}

export function PageError({ error, loading, data }) {
  if (error) return <p className="text-sm text-status-crit mb-3">{error}</p>;
  if (!loading && data && typeof data !== 'object') return <p className="text-sm text-status-warn mb-3">The service answered with a shape this page does not read.</p>;
  return null;
}

/** Sortable, searchable, paged table. columns: [{ k, label, align?, render?(row), sortValue?(row) }]. */
export function CtlTable({ rows, columns, searchKeys = [], defaultSortKey = null, defaultSortDir = 'asc', empty = 'Nothing to show.', pageSize = 10, search = true, rowKey }) {
  const sortValues = {};
  for (const c of columns) if (c.sortValue) sortValues[c.k] = c.sortValue;
  const ctl = useTableControls(rows, { searchKeys, defaultSortKey, defaultSortDir, sortValues, paginate: true, defaultPageSize: pageSize, deepLink: false });
  if (!rows || rows.length === 0) return <p className="text-[12px] text-ink-muted py-4 text-center">{empty}</p>;
  return (
    <>
      {search && searchKeys.length > 0 && (
        <div className="flex items-center gap-2 mb-2">
          <TableSearch ctl={ctl} placeholder="Search..." />
          <span className="text-[11px] text-ink-faint ml-auto tnum">{fmtNum(ctl.rows.length)} row(s)</span>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className={headRow}>
            {columns.map((c) => <SortTh key={c.k} k={c.k} label={c.label} ctl={ctl} align={c.align || 'left'} />)}
          </tr></thead>
          <tbody>
            {ctl.pageRows.map((r, i) => (
              <tr key={rowKey ? rowKey(r) : i} className="border-b border-cohesity-border/50">
                {columns.map((c) => (
                  <td key={c.k} className={`py-2 pr-3 text-[12px] ${c.align === 'right' ? 'text-right tnum' : ''} text-ink-muted`}>
                    {c.render ? c.render(r) : (r[c.k] == null || r[c.k] === '' ? DASH : String(r[c.k]))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TablePager ctl={ctl} />
    </>
  );
}

/** [{day:'YYYY-MM-DD', value}] -> [{epoch (seconds), value}] for TrendLine. */
export const dayPoints = (series) => (Array.isArray(series) ? series : [])
  .map((p) => ({ epoch: Date.parse(`${String(p.day || '').slice(0, 10)}T00:00:00Z`) / 1000, value: p.value }))
  .filter((p) => Number.isFinite(p.epoch));
