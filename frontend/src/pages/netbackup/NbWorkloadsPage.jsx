import { useEffect, useState, useMemo, useCallback } from 'react';
import { Layers, Boxes, Database, ShieldAlert, Server } from 'lucide-react';
import { Line, Bar } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement,
  BarElement, Tooltip, Legend,
} from 'chart.js';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, TB, fmtTb, fmtNum } from './helpers';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend);

const WL_COLORS = ['#B1181E', '#0091DA', '#6CB33F', '#D4A24E', '#9B6CD4', '#4ED4B8', '#D46CB3', '#8FA3B0'];
const wlColor = (list, w) => WL_COLORS[list.indexOf(w) % WL_COLORS.length];

const METRICS = [
  { k: 'protectedBytes', label: 'Protected TB', bytes: true },
  { k: 'jobCount', label: 'Job Count', bytes: false },
  { k: 'failedCount', label: 'Failed Jobs', bytes: false },
  { k: 'protectedClients', label: 'Protected Clients', bytes: false },
];

const selectCls = 'bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-1.5 text-sm text-ink focus:border-brand/60 outline-none cursor-pointer';

export default function NbWorkloadsPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const [trendDomain, setTrendDomain] = useState('');
  const [trendWorkload, setTrendWorkload] = useState('');
  const [trendMetric, setTrendMetric] = useState('protectedBytes');
  const [trendDays, setTrendDays] = useState(90);
  const [trend, setTrend] = useState(null);

  const load = useCallback(() => client.get('/netbackup/workloads')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ rows: [], estate: [], domains: [] }); toast({ type: 'error', title: 'Failed to load workload data' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const params = new URLSearchParams({ days: String(trendDays) });
    if (trendDomain) params.set('sourceId', trendDomain);
    if (trendWorkload) params.set('workload', trendWorkload);
    client.get(`/netbackup/workloads/trends?${params}`)
      .then(({ data }) => setTrend(data.trends || []))
      .catch(() => setTrend([]));
  }, [trendDomain, trendWorkload, trendDays]);

  const rows = data?.rows || [];
  const estate = data?.estate || [];
  const domains = data?.domains || [];
  const domainOpts = useMemo(() =>
    [...new Map(rows.map(r => [r.sourceId, r.sourceName])).entries()]
      .sort((a, b) => a[1].localeCompare(b[1])), [rows]);
  const workloadOpts = useMemo(() => estate.map(e => e.workload), [estate]);

  const totals = useMemo(() => estate.reduce((t, e) => ({
    clients: t.clients + (e.protectedClients || 0),
    jobs: t.jobs + (e.jobCount || 0),
    failed: t.failed + (e.failedCount || 0),
    bytes: t.bytes + (e.protectedBytes || 0),
  }), { clients: 0, jobs: 0, failed: 0, bytes: 0 }), [estate]);

  const estateCtl = useTableControls(estate, { defaultSortKey: 'protectedBytes', defaultSortDir: 'desc' });
  const domainCtl = useTableControls(domains, {
    searchKeys: ['sourceName', 'sourceType'],
    defaultSortKey: 'protectedBytes', defaultSortDir: 'desc',
    sortValues: { protectedBytes: (d) => Object.values(d.workloads || {}).reduce((a, b) => a + b, 0) },
    paginate: true,
  });

  const metricDef = METRICS.find(m => m.k === trendMetric);
  const trendChart = useMemo(() => {
    if (!trend) return null;
    const days = [...new Set(trend.map(t => t.day))].sort();
    const byWl = new Map();
    for (const t of trend) {
      if (!byWl.has(t.workload)) byWl.set(t.workload, new Map());
      byWl.get(t.workload).set(t.day, t[trendMetric] || 0);
    }
    const wls = [...byWl.keys()].sort();
    return {
      labels: days,
      datasets: wls.map(w => ({
        label: w,
        data: days.map(d => {
          const v = byWl.get(w).get(d);
          if (v == null) return null;
          return metricDef.bytes ? v / TB : v;
        }),
        borderColor: wlColor(wls, w),
        backgroundColor: wlColor(wls, w),
        pointRadius: days.length > 45 ? 0 : 2,
        borderWidth: 2, spanGaps: true, tension: 0.25,
      })),
    };
  }, [trend, trendMetric, metricDef]);

  const shareBar = useMemo(() => {
    const sorted = [...estate].sort((a, b) => (b.protectedBytes || 0) - (a.protectedBytes || 0));
    return {
      labels: sorted.map(e => e.workload),
      datasets: [{
        data: sorted.map(e => (e.protectedBytes || 0) / TB),
        backgroundColor: sorted.map(e => wlColor(workloadOpts, e.workload)),
        borderRadius: 3, barThickness: 14,
      }],
    };
  }, [estate, workloadOpts]);

  const chartOpts = {
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: {
      legend: { labels: { color: '#E5E5E5', boxWidth: 12, font: { size: 11 } } },
      tooltip: metricDef?.bytes ? { callbacks: { label: (c) => `${c.dataset.label}: ${Number(c.parsed.y).toLocaleString(undefined, { maximumFractionDigits: 1 })} TB` } } : {},
    },
    scales: {
      x: { ticks: { color: '#E5E5E5', maxTicksLimit: 12, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
      y: { ticks: { color: '#E5E5E5', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' },
        title: { display: true, text: metricDef?.bytes ? 'TB (decimal)' : metricDef?.label, color: '#E5E5E5', font: { size: 11 } } },
    },
  };

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Layers} title="Protected Workloads" description="Protected capacity and job counts by workload type, per NBU domain and estate-wide">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Boxes} label="Protected Clients" value={fmtNum(totals.clients)} tone="brand" />
        <StatCard icon={Database} label="Protected TB" value={fmtTb(totals.bytes)} />
        <StatCard icon={Layers} label="Jobs" value={fmtNum(totals.jobs)} />
        <StatCard icon={ShieldAlert} label="Failed Jobs" value={fmtNum(totals.failed)} tone={totals.failed ? 'warn' : 'ok'} />
      </div>

      <div className="grid lg:grid-cols-3 gap-4 mb-4">
        <div className="panel p-4 lg:col-span-2">
          <p className="text-sm font-semibold text-ink mb-1">Estate by Workload Type</p>
          <p className="text-[11px] text-ink-faint mb-3">All NBU domains combined.</p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={140} />
          ) : estate.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">No workload data yet — it appears after the next poll cycle.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <SortTh k="workload" label="Workload" ctl={estateCtl} />
                  <SortTh k="sources" label="Domains" ctl={estateCtl} align="right" />
                  <SortTh k="protectedClients" label="Clients" ctl={estateCtl} align="right" />
                  <SortTh k="jobCount" label="Jobs" ctl={estateCtl} align="right" />
                  <SortTh k="failedCount" label="Failed" ctl={estateCtl} align="right" />
                  <SortTh k="protectedBytes" label="Protected" ctl={estateCtl} align="right" />
                </tr></thead>
                <tbody>
                  {estateCtl.rows.map((e) => (
                    <tr key={e.workload} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3 text-ink">
                        <span className="inline-block w-2 h-2 rounded-full mr-2" style={{ backgroundColor: wlColor(workloadOpts, e.workload) }} />
                        {e.workload}
                      </td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{e.sources}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink">{fmtNum(e.protectedClients)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(e.jobCount)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-faint">{fmtNum(e.failedCount)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink">{fmtTb(e.protectedBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="panel p-4">
          <p className="text-sm font-semibold text-ink mb-3">Protected TB by Workload</p>
          {estate.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">—</div>
          ) : (
            <div style={{ height: Math.max(180, estate.length * 26 + 60) }}><Bar data={shareBar} options={{
              indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: false,
              plugins: { legend: { display: false },
                tooltip: { callbacks: { label: (c) => `${Number(c.parsed.x).toLocaleString(undefined, { maximumFractionDigits: 1 })} TB` } } },
              scales: {
                x: { ticks: { color: '#E5E5E5', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' },
                  title: { display: true, text: 'Protected TB', color: '#E5E5E5', font: { size: 10 } } },
                y: { ticks: { color: '#E5E5E5', font: { size: 11 } }, grid: { display: false } },
              },
            }} /></div>
          )}
        </div>
      </div>

      <div className="panel p-4 mb-4">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <p className="text-sm font-semibold text-ink mr-auto">Trend Over Time</p>
          <select value={trendDomain} onChange={(e) => setTrendDomain(e.target.value)} className={selectCls}>
            <option value="">Entire estate</option>
            {domainOpts.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <select value={trendWorkload} onChange={(e) => setTrendWorkload(e.target.value)} className={selectCls}>
            <option value="">All workloads</option>
            {workloadOpts.map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
          <select value={trendMetric} onChange={(e) => setTrendMetric(e.target.value)} className={selectCls}>
            {METRICS.map((m) => <option key={m.k} value={m.k}>{m.label}</option>)}
          </select>
          <select value={trendDays} onChange={(e) => setTrendDays(Number(e.target.value))} className={selectCls}>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={180}>180 days</option>
            <option value={365}>1 year</option>
          </select>
        </div>
        {trend == null ? (
          <LoadingPanel label="Loading trend…" height={220} />
        ) : !trendChart || trendChart.labels.length === 0 ? (
          <div className="text-sm text-ink-muted py-8 text-center">No trend data yet — snapshots accumulate daily as the poller runs.</div>
        ) : (
          <div className="h-72"><Line data={trendChart} options={chartOpts} /></div>
        )}
      </div>

      <div className="panel p-4">
        <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Server size={15} className="text-brand" /> Breakdown by Domain</p>
        <TableControls ctl={domainCtl} rows={domains} searchPlaceholder="Filter by domain…"
          filters={[{ k: 'sourceType', label: 'Types' }]} />
        {data == null ? (
          <LoadingPanel label="Loading…" height={140} />
        ) : domains.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No domain data yet — it appears after the next poll cycle.</div>
        ) : domainCtl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No rows match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="sourceName" label="Domain" ctl={domainCtl} />
                <SortTh k="sourceType" label="Type" ctl={domainCtl} />
                <SortTh k="protectedClients" label="Clients" ctl={domainCtl} align="right" />
                <SortTh k="jobCount" label="Jobs" ctl={domainCtl} align="right" />
                <SortTh k="failedCount" label="Failed" ctl={domainCtl} align="right" />
                <SortTh k="protectedBytes" label="Protected" ctl={domainCtl} align="right" />
                <th className="py-2 pr-3 text-left text-[11px] uppercase tracking-wide text-ink-faint">Top Workloads</th>
              </tr></thead>
              <tbody>
                {domainCtl.pageRows.map((d) => {
                  const wls = Object.entries(d.workloads || {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
                  return (
                    <tr key={d.sourceId} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3 text-ink">{d.sourceName}</td>
                      <td className="py-2 pr-3 text-ink-muted">{d.sourceType}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink">{fmtNum(d.protectedClients)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(d.jobCount)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-faint">{fmtNum(d.failedCount)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink">{fmtTb(d.protectedBytes)}</td>
                      <td className="py-2 pr-3 text-ink-faint text-[11px]">
                        {wls.length ? wls.map(([w, b]) => `${w} (${fmtTb(b)})`).join(', ') : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={domainCtl} />
      </div>
    </div>
  );
}
