// Shared pieces for the LogicMonitor Wireless pages.
import { useMemo } from 'react';
import { Bar } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Tooltip, Legend } from 'chart.js';
import { Badge } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, FilterSelect, TablePager } from '../../components/ui/tableTools';
import { BRAND, DASH, PALETTE, arr, chartOpts, fmtNum, fmtMbps, titleCase } from './helpers';
import { UtilBar, headRow } from './ui';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

export const WL_EMPTY = 'No wireless metrics collected yet. The metrics tier runs every 30 minutes by default; check Settings > Scope > Metric families (Wireless).';

const AP_TONE = { up: 'ok', downloading: 'info', disabled: 'neutral', down: 'crit', silent: 'warn', missing: 'crit' };
const AP_LABEL = { up: 'Up', downloading: 'Downloading', disabled: 'Disabled', down: 'Disassociating', silent: 'Not reporting', missing: 'Missing' };
export const apStatusRank = (s) => ({ missing: 5, down: 4, silent: 3, downloading: 2, up: 1, disabled: 0 }[s] ?? 0);
export function ApStatusBadge({ status }) {
  return <Badge tone={AP_TONE[status] || 'neutral'}>{AP_LABEL[status] || titleCase(status)}</Badge>;
}

const RADIO_TONE = { up: 'ok', down: 'crit', disabled: 'neutral' };
export function RadioStateBadge({ state }) {
  return <Badge tone={RADIO_TONE[state] || 'neutral'}>{titleCase(state || 'unknown')}</Badge>;
}

export function ProfileBadge({ v }) {
  if (v == null) return <span className="text-ink-faint">{DASH}</span>;
  return <Badge tone={v === 'pass' ? 'ok' : v === 'fail' ? 'warn' : 'neutral'}>{titleCase(v)}</Badge>;
}

export const BAND_COLOR = { '2.4 GHz': '#D4A24E', '5 GHz': BRAND, '5/6 GHz': '#8A63D2' };

/** Horizontal share bars, no chart library: [{ label, value, sub? }]. */
export function ShareBars({ rows, empty = 'Nothing collected yet.', unit = '', color = BRAND, max: fixedMax }) {
  const list = arr(rows).filter((r) => r.value != null);
  const max = fixedMax || Math.max(1, ...list.map((r) => Number(r.value) || 0));
  if (!list.length) return <p className="text-[12px] text-ink-muted py-3 text-center">{empty}</p>;
  return (
    <div className="flex flex-col gap-1.5">
      {list.map((r, i) => (
        <div key={`${r.label}-${i}`} className="flex items-center gap-2 text-[12px]" title={r.title}>
          <span className="w-40 truncate text-ink" title={r.label}>{r.label}</span>
          <div className="flex-1 h-2 rounded-full bg-surface-overlay overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${Math.max(1, (Number(r.value) / max) * 100)}%`, background: r.color || color }} />
          </div>
          <span className="w-20 text-right tnum text-ink-muted">{fmtNum(r.value)}{unit}</span>
          {r.sub != null && <span className="w-24 text-right text-[11px] text-ink-faint truncate">{r.sub}</span>}
        </div>
      ))}
    </div>
  );
}

/** Grouped bar chart: labels on x, one dataset per series. */
export function BarChart({ labels, series, height = 180, stacked = false, empty = 'Nothing collected yet.' }) {
  const data = useMemo(() => ({
    labels,
    datasets: arr(series).map((s, i) => ({ label: s.label, data: s.data, backgroundColor: s.color || PALETTE[i % PALETTE.length], borderRadius: 3 })),
  }), [labels, series]);
  const opts = useMemo(() => ({
    ...chartOpts,
    scales: { x: { ...chartOpts.scales.x, stacked }, y: { ...chartOpts.scales.y, stacked, beginAtZero: true } },
  }), [stacked]);
  if (!arr(labels).length || !arr(series).some((s) => arr(s.data).some((v) => v))) return <p className="text-[12px] text-ink-muted py-4 text-center">{empty}</p>;
  return <div style={{ height }}><Bar data={data} options={opts} /></div>;
}

const mbps = (bps) => (bps == null ? DASH : fmtMbps(Number(bps) / 1e6));

/** AP rows from /wireless/aps (or a controller's aps). showController adds the controller and site columns. */
export function ApTable({ rows, onOpen, showController = true, deepLink = false, toolbar = null, empty = 'No access points collected.' }) {
  const list = useMemo(() => arr(rows).map((a) => ({ ...a, statusRank: apStatusRank(a.status), siteLabel: a.siteName || a.siteKey || '' })), [rows]);
  const ctl = useTableControls(list, {
    searchKeys: ['ap', 'controller', 'siteLabel', 'operText'], defaultSortKey: 'statusRank', defaultSortDir: 'desc', paginate: true, defaultPageSize: 25, deepLink,
  });
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <TableSearch ctl={ctl} placeholder="Search AP, controller or site..." />
        {showController && <FilterSelect ctl={ctl} k="controller" rows={list} label="controllers" />}
        {showController && <FilterSelect ctl={ctl} k="siteLabel" rows={list} label="sites" />}
        <span className="text-[11px] text-ink-faint tnum">{fmtNum(ctl.rows.length)} AP(s)</span>
        {toolbar}
      </div>
      {list.length === 0 ? <p className="text-sm text-ink-muted py-6 text-center">{empty}</p> : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className={headRow}>
                <SortTh k="ap" label="Access point" ctl={ctl} />
                {showController && <SortTh k="controller" label="Controller" ctl={ctl} />}
                {showController && <SortTh k="siteLabel" label="Site" ctl={ctl} />}
                <SortTh k="statusRank" label="Status" ctl={ctl} />
                <SortTh k="radiosUp" label="Radios" ctl={ctl} align="right" />
                <SortTh k="clients" label="Clients" ctl={ctl} align="right" />
                <SortTh k="util24" label="2.4 GHz util" ctl={ctl} />
                <SortTh k="util5" label="5 GHz util" ctl={ctl} />
                <SortTh k="uplinkRxBps" label="Uplink rx / tx" ctl={ctl} align="right" />
                <SortTh k="uplinkErrors" label="Errors/s" ctl={ctl} align="right" />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((a) => (
                  <tr key={`${a.sourceId}-${a.controllerId}-${a.apKey}`} className={`border-b border-cohesity-border/50 text-[12px] ${onOpen ? 'cursor-pointer hover:bg-surface-overlay' : ''}`} onClick={onOpen ? () => onOpen(a) : undefined}>
                    <td className="py-2 pr-3 text-ink">{a.ap}</td>
                    {showController && <td className="py-2 pr-3 text-ink-muted">{a.controller}</td>}
                    {showController && <td className="py-2 pr-3 text-ink-muted">{a.siteLabel || DASH}</td>}
                    <td className="py-2 pr-3"><ApStatusBadge status={a.status} /></td>
                    <td className={`py-2 pr-3 text-right tnum ${a.radiosDown ? 'text-status-warn' : 'text-ink-muted'}`}>{a.radiosTotal ? `${a.radiosUp} / ${a.radiosTotal}` : DASH}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(a.clients)}</td>
                    <td className="py-2 pr-3 min-w-[110px]"><UtilBar pct={a.util24} /></td>
                    <td className="py-2 pr-3 min-w-[110px]"><UtilBar pct={a.util5} /></td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted whitespace-nowrap">{a.uplinkRxBps == null ? DASH : `${mbps(a.uplinkRxBps)} / ${mbps(a.uplinkTxBps)}`}</td>
                    <td className={`py-2 pr-3 text-right tnum ${Number(a.uplinkErrors) > 1 ? 'text-status-warn' : 'text-ink-muted'}`}>{fmtNum(a.uplinkErrors)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePager ctl={ctl} sizes={[25, 50, 100, 'all']} />
        </>
      )}
    </>
  );
}
