// Cohesity plugin — Protected Workloads page. Ported from
// frontend/src/pages/WorkloadsPage.jsx. react-chartjs-2 Line/Bar -> kit
// LineChart/BarChart (chart.js registration is handled by the host's global
// Chart instance already, so ChartJS.register(...) is dropped — nothing here
// needs it). axios client -> apiFetch.
import {
  apiFetch, useToast, fmtNum,
  PageHeader, StatCard, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager,
} from '../ui.jsx';
import { Server, Database, HardDrive } from '../icons.jsx';
import { LineChart, BarChart } from '../charts.jsx';

// icons.jsx has no "Layers" or "Boxes" glyph (dell/unifi set doesn't carry
// them) — approximated locally with Database/HardDrive-family strokes so the
// page doesn't need a shared-kit icon addition for two one-off uses.
function Layers(p) {
  const size = p.size || 16;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={p.style} className={p.className}>
      <path d="m12 2 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 17 9 5 9-5" />
    </svg>
  );
}
function Boxes(p) {
  const size = p.size || 16;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={p.style} className={p.className}>
      <path d="M2.5 8.5 12 4l9.5 4.5-9.5 4.5-9.5-4.5Z" /><path d="M2.5 8.5v7L12 20l9.5-4.5v-7" /><path d="M12 13v7" />
    </svg>
  );
}

const TB = 1e12;
const fmtTB = (b) => b == null ? '—' : `${(b / TB).toLocaleString(undefined, { maximumFractionDigits: 1 })} TB`;

const ENV_COLORS = ['#6CB33F', '#4E9BD4', '#D4A24E', '#C75D5D', '#9B6CD4', '#4ED4B8', '#D46CB3', '#8FA3B0'];
const envColor = (envs, e) => ENV_COLORS[envs.indexOf(e) % ENV_COLORS.length];

const METRICS = [
  { k: 'protected_bytes', label: 'Protected TB', bytes: true },
  { k: 'protected_count', label: 'Protected Objects', bytes: false },
  { k: 'logical_bytes', label: 'Logical Usage', bytes: true },
  { k: 'physical_bytes', label: 'Physical Consumed', bytes: true },
];

const panelStyle = { background: 'var(--co-surface)', border: '1px solid var(--co-border)', borderRadius: 8, padding: 16 };
const thStyle = { padding: '8px 12px 8px 0', textAlign: 'left' };
const thRightStyle = { ...thStyle, textAlign: 'right' };
const tdStyle = { padding: '8px 12px 8px 0' };
const tdRightStyle = { ...tdStyle, textAlign: 'right' };

export default function WorkloadsPage() {
  const { toast } = useToast();
  const [data, setData] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [refreshing, setRefreshing] = React.useState(false);

  // Trend controls
  const [trendCluster, setTrendCluster] = React.useState('');   // '' = estate
  const [trendEnv, setTrendEnv] = React.useState('');           // '' = all workloads
  const [trendMetric, setTrendMetric] = React.useState('protected_bytes');
  const [trendDays, setTrendDays] = React.useState(90);
  const [trend, setTrend] = React.useState(null);

  const load = React.useCallback(() => apiFetch('/cohesity/workloads')
    .then((d) => { setData(d); setLastRefreshed(new Date()); })
    .catch(() => { setData({ rows: [], estate: [] }); toast({ type: 'error', title: 'Failed to load workload data' }); }), [toast]);

  React.useEffect(() => { load(); }, [load]);

  React.useEffect(() => {
    const params = new URLSearchParams({ days: String(trendDays) });
    if (trendCluster) params.set('clusterId', trendCluster);
    if (trendEnv) params.set('environment', trendEnv);
    apiFetch(`/cohesity/workloads/trends?${params}`)
      .then((d) => setTrend(d))
      .catch(() => setTrend([]));
  }, [trendCluster, trendEnv, trendDays]);

  const forceRefresh = async () => {
    setRefreshing(true);
    try {
      const d = await apiFetch('/cohesity/workloads/refresh', { method: 'POST' });
      setData({ rows: d.rows, estate: d.estate });
      setLastRefreshed(new Date());
      const failed = (d.results || []).filter((r) => !r.ok);
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
  const clusters = React.useMemo(() =>
    [...new Map(rows.map((r) => [r.cluster_id, r.cluster_name])).entries()]
      .sort((a, b) => a[1].localeCompare(b[1])), [rows]);
  const envs = React.useMemo(() => estate.map((e) => e.environment), [estate]);

  const totals = React.useMemo(() => estate.reduce((t, e) => ({
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
  const metricDef = METRICS.find((m) => m.k === trendMetric);
  const trendChart = React.useMemo(() => {
    if (!trend) return null;
    const days = [...new Set(trend.map((t) => t.day))].sort();
    const byEnv = new Map();
    for (const t of trend) {
      if (!byEnv.has(t.environment)) byEnv.set(t.environment, new Map());
      byEnv.get(t.environment).set(t.day, t[trendMetric] || 0);
    }
    const allEnvs = [...byEnv.keys()].sort();
    return {
      labels: days,
      datasets: allEnvs.map((e) => ({
        label: e,
        data: days.map((d) => {
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

  // Horizontal bar: one row per workload, largest first.
  const shareBar = React.useMemo(() => {
    const sorted = [...estate].sort((a, b) => (b.protected_bytes || 0) - (a.protected_bytes || 0));
    return {
      labels: sorted.map((e) => e.environment),
      datasets: [{
        data: sorted.map((e) => (e.protected_bytes || 0) / TB),
        backgroundColor: sorted.map((e) => envColor(envs, e.environment)),
        borderRadius: 3,
        barThickness: 14,
      }],
    };
  }, [estate, envs]);

  const trendChartOpts = {
    plugins: {
      tooltip: metricDef?.bytes ? {
        callbacks: { label: (c) => `${c.dataset.label}: ${Number(c.parsed.y).toLocaleString(undefined, { maximumFractionDigits: 1 })} TB` },
      } : {},
    },
    scales: {
      x: { ticks: { maxTicksLimit: 12 } },
      y: { title: { display: true, text: metricDef?.bytes ? 'TB (decimal)' : 'Objects', color: '#94A3B3', font: { size: 11 } } },
    },
  };

  const shareBarOpts = {
    indexAxis: 'y',
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (c) => `${Number(c.parsed.x).toLocaleString(undefined, { maximumFractionDigits: 1 })} TB` } },
    },
    scales: {
      x: { title: { display: true, text: 'Protected TB', color: '#94A3B3', font: { size: 10 } } },
      y: { grid: { display: false } },
    },
  };

  const ratio = (l, p) => (l > 0 && p > 0) ? `${(l / p).toFixed(1)}x` : '—';

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Layers} title="Protected Workloads" description="Protected capacity and object counts by workload type, per cluster and estate-wide">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={forceRefresh} refreshing={refreshing} />
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-4" style={{ gap: 12, marginBottom: 16 }}>
        <StatCard icon={Boxes} label="Protected Objects" value={fmtNum(totals.objects)} tone="brand" />
        <StatCard icon={Database} label="Protected (Front-end)" value={fmtTB(totals.protected)} />
        <StatCard icon={Layers} label="Logical Usage" value={fmtTB(totals.logical)} />
        <StatCard icon={HardDrive} label="Physical Consumed" value={fmtTB(totals.physical)} tone="info" />
      </div>

      {/* Estate rollup by workload type */}
      <div className="grid lg:grid-cols-3" style={{ gap: 16, marginBottom: 16 }}>
        <div className="lg:col-span-2" style={panelStyle}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--co-ink)', margin: '0 0 4px' }}>Estate by Workload Type</p>
          <p style={{ fontSize: 11, color: 'var(--co-ink-faint)', margin: '0 0 12px' }}>All clusters combined. Protected = front-end size of protected objects; Logical / Physical = backup storage usage before and after data reduction. Decimal TB.</p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={140} />
          ) : estate.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--co-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No workload data yet — it appears after the next poll cycle.</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: 13 }}>
                <thead><tr style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.03em', color: 'var(--co-ink-faint)', borderBottom: '1px solid var(--co-border)' }}>
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
                    <tr key={e.environment} style={{ borderBottom: '1px solid rgba(31,43,55,.5)' }}>
                      <td style={{ ...tdStyle, color: 'var(--co-ink)' }}>
                        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', marginRight: 8, background: envColor(envs, e.environment) }} />
                        {e.environment}
                      </td>
                      <td className="tnum" style={{ ...tdRightStyle, color: 'var(--co-ink-muted)' }}>{e.clusters}</td>
                      <td className="tnum" style={{ ...tdRightStyle, color: 'var(--co-ink)' }}>{fmtNum(e.protected_count)}</td>
                      <td className="tnum" style={{ ...tdRightStyle, color: 'var(--co-ink-faint)' }}>{fmtNum(e.unprotected_count)}</td>
                      <td className="tnum" style={{ ...tdRightStyle, color: 'var(--co-ink)' }}>{fmtTB(e.protected_bytes)}</td>
                      <td className="tnum" style={{ ...tdRightStyle, color: 'var(--co-ink-muted)' }}>{fmtTB(e.logical_bytes)}</td>
                      <td className="tnum" style={{ ...tdRightStyle, color: 'var(--co-ink-muted)' }}>{fmtTB(e.physical_bytes)}</td>
                      <td className="tnum" style={{ ...tdRightStyle, color: 'var(--co-ink-faint)' }}>{ratio(e.logical_bytes, e.physical_bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div style={panelStyle}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--co-ink)', margin: '0 0 12px' }}>Protected TB by Workload</p>
          {estate.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--co-ink-muted)', padding: '24px 0', textAlign: 'center' }}>—</div>
          ) : (
            <BarChart data={shareBar} options={shareBarOpts} height={Math.max(180, estate.length * 26 + 60)} />
          )}
        </div>
      </div>

      {/* Trend over time */}
      <div style={{ ...panelStyle, marginBottom: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--co-ink)', marginRight: 'auto' }}>Trend Over Time</p>
          <select value={trendCluster} onChange={(e) => setTrendCluster(e.target.value)} className="co-input" style={{ width: 'auto' }}>
            <option value="">Entire estate</option>
            {clusters.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <select value={trendEnv} onChange={(e) => setTrendEnv(e.target.value)} className="co-input" style={{ width: 'auto' }}>
            <option value="">All workloads</option>
            {envs.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
          <select value={trendMetric} onChange={(e) => setTrendMetric(e.target.value)} className="co-input" style={{ width: 'auto' }}>
            {METRICS.map((m) => <option key={m.k} value={m.k}>{m.label}</option>)}
          </select>
          <select value={trendDays} onChange={(e) => setTrendDays(Number(e.target.value))} className="co-input" style={{ width: 'auto' }}>
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
          <div style={{ fontSize: 13, color: 'var(--co-ink-muted)', padding: '32px 0', textAlign: 'center' }}>No trend data yet — snapshots accumulate daily as the poller runs.</div>
        ) : (
          <LineChart data={trendChart} options={trendChartOpts} height={288} />
        )}
      </div>

      {/* Per-cluster breakdown */}
      <div style={panelStyle}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--co-ink)', margin: '0 0 12px', display: 'flex', alignItems: 'center', gap: 8 }}><Server size={15} style={{ color: 'var(--co-brand)' }} /> Breakdown by Cluster</p>
        <TableControls ctl={clusterCtl} rows={rows} searchPlaceholder="Filter by cluster or workload…"
          filters={[{ k: 'cluster_name', label: 'Clusters' }, { k: 'environment', label: 'Workloads' }]} />
        {data == null ? (
          <LoadingPanel label="Loading…" height={140} />
        ) : rows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--co-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No workload data yet — it appears after the next poll cycle.</div>
        ) : clusterCtl.rows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--co-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No rows match your filters.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13 }}>
              <thead><tr style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.03em', color: 'var(--co-ink-faint)', borderBottom: '1px solid var(--co-border)' }}>
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
                  <tr key={`${r.cluster_id}|${r.environment}`} style={{ borderBottom: '1px solid rgba(31,43,55,.5)' }}>
                    <td style={{ ...tdStyle, color: 'var(--co-ink)' }}>{r.cluster_name}</td>
                    <td style={{ ...tdStyle, color: 'var(--co-ink-muted)' }}>
                      <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', marginRight: 8, background: envColor(envs, r.environment) }} />
                      {r.environment}
                    </td>
                    <td className="tnum" style={{ ...tdRightStyle, color: 'var(--co-ink)' }}>{fmtNum(r.protected_count)}</td>
                    <td className="tnum" style={{ ...tdRightStyle, color: 'var(--co-ink-faint)' }}>{fmtNum(r.unprotected_count)}</td>
                    <td className="tnum" style={{ ...tdRightStyle, color: 'var(--co-ink-muted)' }}>{fmtNum(r.job_count)}</td>
                    <td className="tnum" style={{ ...tdRightStyle, color: 'var(--co-ink)' }}>{fmtTB(r.protected_bytes)}</td>
                    <td className="tnum" style={{ ...tdRightStyle, color: 'var(--co-ink-muted)' }}>{fmtTB(r.logical_bytes)}</td>
                    <td className="tnum" style={{ ...tdRightStyle, color: 'var(--co-ink-muted)' }}>{fmtTB(r.physical_bytes)}</td>
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
