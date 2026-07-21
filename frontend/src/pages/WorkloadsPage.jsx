import { useEffect, useState, useMemo, useCallback } from 'react';
import { Layers, Boxes, Database, HardDrive, Server } from 'lucide-react';
import { Line, Bar } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement,
  BarElement, Tooltip, Legend,
} from 'chart.js';
import client from '../api/client';
import { useToast } from '../components/ui/Toaster';
import { PageHeader, StatCard, LoadingPanel, RefreshButton, LastUpdated } from '../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../components/ui/tableTools';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend);

const TB = 1e12;
const fmtTB = (b) => b == null ? '—' : `${(b / TB).toLocaleString(undefined, { maximumFractionDigits: 1 })} TB`;
const fmtNum = (n) => n == null ? '—' : Number(n).toLocaleString();

const ENV_COLORS = ['#6CB33F', '#4E9BD4', '#D4A24E', '#C75D5D', '#9B6CD4', '#4ED4B8', '#D46CB3', '#8FA3B0'];
const envColor = (envs, e) => ENV_COLORS[envs.indexOf(e) % ENV_COLORS.length];

const METRICS = [
  { k: 'protected_bytes', label: 'Protected TB', bytes: true },
  { k: 'protected_count', label: 'Protected Objects', bytes: false },
  { k: 'logical_bytes', label: 'Logical Usage', bytes: true },
  { k: 'physical_bytes', label: 'Physical Consumed', bytes: true },
];

const selectCls = 'bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-1.5 text-sm text-ink focus:border-brand/60 outline-none cursor-pointer';

export default function WorkloadsPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  // Trend controls
  const [trendCluster, setTrendCluster] = useState('');   // '' = estate
  const [trendEnv, setTrendEnv] = useState('');           // '' = all workloads
  const [trendMetric, setTrendMetric] = useState('protected_bytes');
  const [trendDays, setTrendDays] = useState(90);
  const [trend, setTrend] = useState(null);

  const load = useCallback(() => client.get('/cohesity/workloads')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ rows: [], estate: [] }); toast({ type: 'error', title: 'Failed to load workload data' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const params = new URLSearchParams({ days: String(trendDays) });
    if (trendCluster) params.set('clusterId', trendCluster);
    if (trendEnv) params.set('environment', trendEnv);
    client.get(`/cohesity/workloads/trends?${params}`)
      .then(({ data }) => setTrend(data))
      .catch(() => setTrend([]));
  }, [trendCluster, trendEnv, trendDays]);

  const forceRefresh = async () => {
    setRefreshing(true);
    try {
      const { data } = await client.post('/cohesity/workloads/refresh', {}, { timeout: 600000 });
      setData({ rows: data.rows, estate: data.estate });
      setLastRefreshed(new Date());
      const failed = (data.results || []).filter(r => !r.ok);
      if (failed.length) toast({ type: 'error', title: `${failed.length} cluster(s) failed to refresh` });
      else toast({ type: 'success', title: 'Workload data refreshed' });
    } catch {
      toast({ type: 'error', title: 'Workload refresh failed' });
    } finally {
      setRefreshing(false);
    }
  };

  const rows = data?.rows || [];
  const estate = data?.estate || [];
  const clusters = useMemo(() =>
    [...new Map(rows.map(r => [r.cluster_id, r.cluster_name])).entries()]
      .sort((a, b) => a[1].localeCompare(b[1])), [rows]);
  const envs = useMemo(() => estate.map(e => e.environment), [estate]);

  const totals = useMemo(() => estate.reduce((t, e) => ({
    objects: t.objects + (e.protected_count || 0),
    protected: t.protected + (e.protected_bytes || 0),
    logical: t.logical + (e.logical_bytes || 0),
    physical: t.physical + (e.physical_bytes || 0),
  }), { objects: 0, protected: 0, logical: 0, physical: 0 }), [estate]);

  const estateCtl = useTableControls(estate, {
    defaultSortKey: 'protected_bytes', defaultSortDir: 'desc',
    sortValues: { reduction: (e) => (e.logical_bytes > 0 && e.physical_bytes > 0) ? e.logical_bytes / e.physical_bytes : null },
  });
  const clusterCtl = useTableControls(rows, {
    searchKeys: ['cluster_name', 'environment'],
    defaultSortKey: 'protected_bytes', defaultSortDir: 'desc',
    paginate: true,
  });

  // Trend chart: one dataset per environment (or a single line when filtered).
  const metricDef = METRICS.find(m => m.k === trendMetric);
  const trendChart = useMemo(() => {
    if (!trend) return null;
    const days = [...new Set(trend.map(t => t.day))].sort();
    const byEnv = new Map();
    for (const t of trend) {
      if (!byEnv.has(t.environment)) byEnv.set(t.environment, new Map());
      byEnv.get(t.environment).set(t.day, t[trendMetric] || 0);
    }
    const allEnvs = [...byEnv.keys()].sort();
    return {
      labels: days,
      datasets: allEnvs.map(e => ({
        label: e,
        data: days.map(d => {
          const v = byEnv.get(e).get(d);
          if (v == null) return null;
          return metricDef.bytes ? v / TB : v;
        }),
        borderColor: envColor(allEnvs, e),
        backgroundColor: envColor(allEnvs, e),
        pointRadius: days.length > 45 ? 0 : 2,
        borderWidth: 2,
        spanGaps: true,
        tension: 0.25,
      })),
    };
  }, [trend, trendMetric, metricDef]);

  // Horizontal bar: one row per workload, largest first — readable however
  // many workload types the estate has (a doughnut wasn't, past a handful).
  const shareBar = useMemo(() => {
    const sorted = [...estate].sort((a, b) => (b.protected_bytes || 0) - (a.protected_bytes || 0));
    return {
      labels: sorted.map(e => e.environment),
      datasets: [{
        data: sorted.map(e => (e.protected_bytes || 0) / TB),
        backgroundColor: sorted.map(e => envColor(envs, e.environment)),
        borderRadius: 3,
        barThickness: 14,
      }],
    };
  }, [estate, envs]);

  const chartOpts = {
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: {
      legend: { labels: { color: '#E5E5E5', boxWidth: 12, font: { size: 11 } } },
      tooltip: { callbacks: metricDef?.bytes ? {
        label: (c) => `${c.dataset.label}: ${Number(c.parsed.y).toLocaleString(undefined, { maximumFractionDigits: 1 })} TB`,
      } : {} },
    },
    scales: {
      x: { ticks: { color: '#E5E5E5', maxTicksLimit: 12, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
      y: { ticks: { color: '#E5E5E5', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' },
        title: { display: true, text: metricDef?.bytes ? 'TB (decimal)' : 'Objects', color: '#E5E5E5', font: { size: 11 } } },
    },
  };

  const ratio = (l, p) => (l > 0 && p > 0) ? `${(l / p).toFixed(1)}x` : '—';

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Layers} title="Protected Workloads" description="Protected capacity and object counts by workload type, per cluster and estate-wide">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={forceRefresh} refreshing={refreshing} />
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Boxes} label="Protected Objects" value={fmtNum(totals.objects)} tone="brand" />
        <StatCard icon={Database} label="Protected (Front-end)" value={fmtTB(totals.protected)} />
        <StatCard icon={Layers} label="Logical Usage" value={fmtTB(totals.logical)} />
        <StatCard icon={HardDrive} label="Physical Consumed" value={fmtTB(totals.physical)} tone="info" />
      </div>

      {/* Estate rollup by workload type */}
      <div className="grid lg:grid-cols-3 gap-4 mb-4">
        <div className="panel p-4 lg:col-span-2">
          <p className="text-sm font-semibold text-ink mb-1">Estate by Workload Type</p>
          <p className="text-[11px] text-ink-faint mb-3">All clusters combined. Protected = front-end size of protected objects; Logical / Physical = backup storage usage before and after data reduction. Decimal TB.</p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={140} />
          ) : estate.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">No workload data yet — it appears after the next poll cycle.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <SortTh k="environment" label="Workload" ctl={estateCtl} />
                  <SortTh k="clusters" label="Clusters" ctl={estateCtl} align="right" />
                  <SortTh k="protected_count" label="Objects" ctl={estateCtl} align="right" />
                  <SortTh k="unprotected_count" label="Unprotected" ctl={estateCtl} align="right" />
                  <SortTh k="protected_bytes" label="Protected" ctl={estateCtl} align="right" />
                  <SortTh k="logical_bytes" label="Logical" ctl={estateCtl} align="right" />
                  <SortTh k="physical_bytes" label="Physical" ctl={estateCtl} align="right" />
                  <SortTh k="reduction" label="Reduction" ctl={estateCtl} align="right" />
                </tr></thead>
                <tbody>
                  {estateCtl.rows.map((e) => (
                    <tr key={e.environment} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3 text-ink">
                        <span className="inline-block w-2 h-2 rounded-full mr-2" style={{ backgroundColor: envColor(envs, e.environment) }} />
                        {e.environment}
                      </td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{e.clusters}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink">{fmtNum(e.protected_count)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-faint">{fmtNum(e.unprotected_count)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink">{fmtTB(e.protected_bytes)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtTB(e.logical_bytes)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtTB(e.physical_bytes)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-faint">{ratio(e.logical_bytes, e.physical_bytes)}</td>
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

      {/* Trend over time */}
      <div className="panel p-4 mb-4">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <p className="text-sm font-semibold text-ink mr-auto">Trend Over Time</p>
          <select value={trendCluster} onChange={(e) => setTrendCluster(e.target.value)} className={selectCls}>
            <option value="">Entire estate</option>
            {clusters.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <select value={trendEnv} onChange={(e) => setTrendEnv(e.target.value)} className={selectCls}>
            <option value="">All workloads</option>
            {envs.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
          <select value={trendMetric} onChange={(e) => setTrendMetric(e.target.value)} className={selectCls}>
            {METRICS.map((m) => <option key={m.k} value={m.k}>{m.label}</option>)}
          </select>
          <select value={trendDays} onChange={(e) => setTrendDays(Number(e.target.value))} className={selectCls}>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={180}>180 days</option>
            <option value={365}>1 year</option>
            <option value={730}>2 years</option>
          </select>
        </div>
        {trend == null ? (
          <LoadingPanel label="Loading trend…" height={220} />
        ) : trendChart.labels.length === 0 ? (
          <div className="text-sm text-ink-muted py-8 text-center">No trend data yet — snapshots accumulate daily as the poller runs.</div>
        ) : (
          <div className="h-72"><Line data={trendChart} options={chartOpts} /></div>
        )}
      </div>

      {/* Per-cluster breakdown */}
      <div className="panel p-4">
        <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Server size={15} className="text-brand" /> Breakdown by Cluster</p>
        <TableControls ctl={clusterCtl} rows={rows} searchPlaceholder="Filter by cluster or workload…"
          filters={[{ k: 'cluster_name', label: 'Clusters' }, { k: 'environment', label: 'Workloads' }]} />
        {data == null ? (
          <LoadingPanel label="Loading…" height={140} />
        ) : rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No workload data yet — it appears after the next poll cycle.</div>
        ) : clusterCtl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No rows match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="cluster_name" label="Cluster" ctl={clusterCtl} />
                <SortTh k="environment" label="Workload" ctl={clusterCtl} />
                <SortTh k="protected_count" label="Objects" ctl={clusterCtl} align="right" />
                <SortTh k="unprotected_count" label="Unprotected" ctl={clusterCtl} align="right" />
                <SortTh k="job_count" label="Jobs" ctl={clusterCtl} align="right" />
                <SortTh k="protected_bytes" label="Protected" ctl={clusterCtl} align="right" />
                <SortTh k="logical_bytes" label="Logical" ctl={clusterCtl} align="right" />
                <SortTh k="physical_bytes" label="Physical" ctl={clusterCtl} align="right" />
              </tr></thead>
              <tbody>
                {clusterCtl.pageRows.map((r) => (
                  <tr key={`${r.cluster_id}|${r.environment}`} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{r.cluster_name}</td>
                    <td className="py-2 pr-3 text-ink-muted">
                      <span className="inline-block w-2 h-2 rounded-full mr-2" style={{ backgroundColor: envColor(envs, r.environment) }} />
                      {r.environment}
                    </td>
                    <td className="py-2 pr-3 text-right tnum text-ink">{fmtNum(r.protected_count)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-faint">{fmtNum(r.unprotected_count)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(r.job_count)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink">{fmtTB(r.protected_bytes)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtTB(r.logical_bytes)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtTB(r.physical_bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={clusterCtl} />
      </div>
    </div>
  );
}
