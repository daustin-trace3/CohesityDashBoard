import { useMemo } from 'react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler,
} from 'chart.js';
import { Badge } from '../../components/ui/primitives';
import { useTableControls, SortTh, TablePager } from '../../components/ui/tableTools';
import {
  BRAND, DASH, arr, fmtNum, fmtPct, fmtMbps, fmtShortTime, severityTone, chartOpts,
} from './helpers';
import { Fact, headRow } from './ui';

// Shared detail-view kit lifted out of LmFirewall360 so the F5 platform and the other
// vendor 360s can import it without reaching into the firewall modal.
ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

export const num = (v) => (v == null || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) ? null : Number(v));

const pctOpts = { ...chartOpts, scales: { x: chartOpts.scales.x, y: { ...chartOpts.scales.y, min: 0, suggestedMax: 100 } } };

// "inBps" -> "In bps", "member_avail" -> "Member avail".
export const humanKey = (k) => {
  const s = String(k || '').replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

// A history series can arrive as [{epoch, value}] or under a named key of an
// object; epoch is seconds (milliseconds tolerated).
export function pointsOf(h, names) {
  if (Array.isArray(h)) return h;
  if (h && typeof h === 'object') {
    for (const n of names) if (Array.isArray(h[n])) return h[n];
  }
  return [];
}
const labelOf = (p) => {
  const e = num(p?.epoch);
  if (e == null) return '';
  return fmtShortTime(new Date(e > 1e11 ? e : e * 1000).toISOString());
};

// 140 px line chart like the Overview trends. series: [{label, points, color, dash}]
export function TrendLine({ series, pct = false, empty = 'No history collected yet.' }) {
  const base = (series || []).find((s) => arr(s.points).length);
  const data = useMemo(() => ({
    labels: arr(base?.points).map(labelOf),
    datasets: (series || []).map((s, i) => ({
      label: s.label, data: arr(s.points).map((p) => num(p?.value)),
      borderColor: s.color || (i === 0 ? BRAND : '#3FB950'), borderDash: s.dash, pointRadius: 0, borderWidth: 2, tension: 0.2,
    })),
  }), [series, base]);
  if (!base) return <p className="text-[12px] text-ink-muted py-4 text-center">{empty}</p>;
  return <div className="h-[140px]"><Line data={data} options={pct ? pctOpts : chartOpts} /></div>;
}

// Renders rows of unknown shape (route sections whose columns the contract
// does not pin): scalar keys become columns, nested values are skipped.
export function AutoTable({ rows, empty = 'None collected.', preferred = [], pageSize = 10 }) {
  const list = useMemo(() => (Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : []), [rows]);
  const cols = useMemo(() => {
    const seen = [];
    for (const r of list.slice(0, 50)) {
      for (const [k, v] of Object.entries(r)) {
        if (k === 'sampledAt' || k === 'epoch') continue;
        if (v != null && typeof v === 'object' && !('value' in v)) continue;
        if (!seen.includes(k)) seen.push(k);
      }
    }
    const first = preferred.filter((k) => seen.includes(k));
    return [...first, ...seen.filter((k) => !first.includes(k))].slice(0, 9);
  }, [list, preferred]);
  const ctl = useTableControls(list, { searchKeys: cols, paginate: true, defaultPageSize: pageSize, deepLink: false });
  if (list.length === 0) return <p className="text-[12px] text-ink-muted py-3 text-center">{empty}</p>;
  const cell = (r, k) => {
    let v = r[k];
    if (v != null && typeof v === 'object') v = v.value;
    if (v == null || v === '') return DASH;
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (typeof v === 'number') return /pct|percent|util/i.test(k) ? fmtPct(v, 1) : /bps/i.test(k) ? fmtMbps(v / 1e6) : fmtNum(Math.round(v * 100) / 100);
    return String(v);
  };
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className={headRow}>{cols.map((k) => <SortTh key={k} k={k} label={humanKey(k)} ctl={ctl} />)}</tr></thead>
          <tbody>
            {ctl.pageRows.map((r, i) => (
              <tr key={i} className="border-b border-cohesity-border/40">
                {cols.map((k, ci) => <td key={k} className={`py-1.5 pr-3 text-[12px] ${ci === 0 ? 'text-ink' : 'text-ink-muted tnum'}`}>{cell(r, k)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TablePager ctl={ctl} sizes={[pageSize, 25, 50, 'all']} />
    </>
  );
}

// An object section (for example globalProtect) as a Fact grid.
export function FactGrid({ obj, empty = 'None collected.' }) {
  const entries = Object.entries(obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}).filter(([, v]) => v == null || typeof v !== 'object');
  if (!entries.length) return <p className="text-[12px] text-ink-muted py-3 text-center">{empty}</p>;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {entries.map(([k, v]) => <Fact key={k} label={humanKey(k)}>{typeof v === 'number' ? fmtNum(v) : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v}</Fact>)}
    </div>
  );
}

export function IssuesList({ issues }) {
  const list = arr(issues);
  if (!list.length) return <p className="text-sm text-status-ok py-3 text-center">No open issues on this device.</p>;
  return (
    <div className="flex flex-col gap-1.5">
      {list.map((i, n) => (
        <div key={i.id ?? n} className="flex items-start gap-2 text-[12px]">
          <Badge tone={severityTone(i.severity)}>{i.severity || 'info'}</Badge>
          <span className="text-ink-faint font-mono shrink-0">{i.type}</span>
          <span className="text-ink-muted">{i.message || i.target}</span>
        </div>
      ))}
    </div>
  );
}

// Config sync reads as boolean, 0/1 or text depending on the datapoint.
export function syncedOf(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).toLowerCase();
  if (['1', 'yes', 'true', 'synced', 'in sync', 'synchronized'].includes(s)) return true;
  if (['0', 'no', 'false', 'unsynced', 'out of sync', 'not synced'].includes(s)) return false;
  return null;
}
