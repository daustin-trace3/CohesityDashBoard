// Rubrik v2.0.0 — Protected Workloads page. Mirrors the host
// WorkloadsPage.jsx (estate rollup + share bar + trend + per-cluster table)
// using the rbk- kit exclusively.

import {
  injectStyles, PageHeader, Panel, StatCard, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager,
  LayersIcon, BoxesIcon, DbIcon, ServerIcon,
} from '../ui';
import { HBar, LineChart } from '../charts';

injectStyles();

const TB = 1e12;
const fmtTb = (b) => b == null ? '—' : `${(b / TB).toLocaleString(undefined, { maximumFractionDigits: 1 })} TB`;
const fmtNum = (n) => n == null ? '—' : Number(n).toLocaleString();
const ratio = (l, p) => (l > 0 && p > 0) ? `${(l / p).toFixed(1)}x` : '—';

const PALETTE = ['#00B388', '#4E9BD4', '#D4A24E', '#C75D5D', '#9B6CD4'];
const workloadColor = (list, w) => PALETTE[Math.max(0, list.indexOf(w)) % PALETTE.length];

const METRICS = [
  { k: 'protectedBytes', label: 'Protected TB', bytes: true },
  { k: 'protectedCount', label: 'Objects', bytes: false },
  { k: 'logicalBytes', label: 'Logical', bytes: true },
  { k: 'physicalBytes', label: 'Physical', bytes: true },
];

function useRbkFetch(path) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [nonce, setNonce] = React.useState(0);
  const reload = React.useCallback(() => setNonce((n) => n + 1), []);
  React.useEffect(() => {
    let cancelled = false;
    setError(null);
    fetch(`/api/rubrik${path}`, { credentials: 'include' })
      .then((res) => { if (!res.ok) throw new Error(`request failed: ${res.status}`); return res.json(); })
      .then((json) => { if (!cancelled) setData(json); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [path, nonce]);
  return { data, error, reload };
}

const ESTATE_SORT = {
  workload: (e) => e.workload || '',
  clusters: (e) => e.clusters || 0,
  objects: (e) => e.objects || 0,
  unprotected: (e) => e.unprotected || 0,
  logical: (e) => e.logical || 0,
  physical: (e) => e.physical || 0,
  protected: (e) => e.protected || 0,
  reduction: (e) => (e.logical > 0 && e.physical > 0) ? e.logical / e.physical : -1,
};

const CLUSTER_SORT = {
  cluster: (r) => r.cluster || '',
  workload: (r) => r.workload || '',
  objects: (r) => r.objects || 0,
  unprotected: (r) => r.unprotected || 0,
  protected: (r) => r.protected || 0,
  logical: (r) => r.logical || 0,
  physical: (r) => r.physical || 0,
};

export default function WorkloadsPage() {
  const { data, error, reload } = useRbkFetch('/workloads');
  const [refreshing, setRefreshing] = React.useState(false);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const [trendCluster, setTrendCluster] = React.useState('');
  const [trendWorkload, setTrendWorkload] = React.useState('');
  const [trendMetric, setTrendMetric] = React.useState('protectedBytes');
  const [trendDays, setTrendDays] = React.useState(90);
  const [trend, setTrend] = React.useState(null);

  React.useEffect(() => { if (data) setLastRefreshed(new Date()); }, [data]);

  React.useEffect(() => {
    const params = new URLSearchParams({ days: String(trendDays) });
    if (trendCluster) params.set('cluster', trendCluster);
    if (trendWorkload) params.set('workload', trendWorkload);
    let cancelled = false;
    fetch(`/api/rubrik/workloads/trends?${params}`, { credentials: 'include' })
      .then((r) => r.json())
      .then((json) => { if (!cancelled) setTrend(Array.isArray(json) ? json : json.rows || []); })
      .catch(() => { if (!cancelled) setTrend([]); });
    return () => { cancelled = true; };
  }, [trendCluster, trendWorkload, trendDays]);

  const refresh = () => {
    setRefreshing(true);
    reload();
    setTimeout(() => setRefreshing(false), 500);
  };

  const rows = (data?.rows || []).map((r) => ({
    cluster: r.cluster,
    workload: r.workload,
    objects: r.protectedCount,
    unprotected: r.unprotectedCount,
    jobCount: r.jobCount,
    protected: r.protectedBytes,
    logical: r.logicalBytes,
    physical: r.physicalBytes,
  }));
  const estate = (data?.estate || []).map((e) => ({
    workload: e.workload,
    clusters: e.clusters,
    objects: e.protectedCount,
    unprotected: e.unprotectedCount,
    protected: e.protectedBytes,
    logical: e.logicalBytes,
    physical: e.physicalBytes,
  }));

  const clusters = [...new Set(rows.map((r) => r.cluster))].filter(Boolean).sort();
  const workloads = [...new Set([...rows.map((r) => r.workload), ...estate.map((e) => e.workload)])].filter(Boolean).sort();

  const totals = estate.reduce((t, e) => ({
    objects: t.objects + (e.objects || 0),
    protected: t.protected + (e.protected || 0),
    logical: t.logical + (e.logical || 0),
    physical: t.physical + (e.physical || 0),
  }), { objects: 0, protected: 0, logical: 0, physical: 0 });

  const estateCtl = useTableControls(estate, { defaultSortKey: 'protected', defaultSortDir: 'desc', sortValues: ESTATE_SORT });
  const clusterCtl = useTableControls(rows, {
    searchKeys: ['cluster', 'workload'],
    defaultSortKey: 'protected', defaultSortDir: 'desc',
    sortValues: CLUSTER_SORT,
    paginate: true,
  });

  const shareBarRows = [...estate].sort((a, b) => (b.protected || 0) - (a.protected || 0)).map((e) => ({
    label: e.workload,
    value: +(e.protected / TB).toFixed(1),
    color: workloadColor(workloads, e.workload),
  }));

  const metricDef = METRICS.find((m) => m.k === trendMetric);
  const trendChart = React.useMemo(() => {
    if (!trend) return null;
    const days = [...new Set(trend.map((t) => t.day))].sort();
    const byWorkload = new Map();
    for (const t of trend) {
      if (!byWorkload.has(t.workload)) byWorkload.set(t.workload, new Map());
      byWorkload.get(t.workload).set(t.day, t[trendMetric] || 0);
    }
    const allWorkloads = [...byWorkload.keys()].sort();
    return allWorkloads.map((w) => ({
      label: w,
      color: workloadColor(allWorkloads, w),
      points: days.map((d) => {
        const v = byWorkload.get(w).get(d);
        return { x: d, y: v == null ? 0 : (metricDef.bytes ? v / TB : v) };
      }),
    }));
  }, [trend, trendMetric, metricDef]);

  const loading = !data && !error;

  return (
    <div className="rbk-root rbk-fade-in">
      <PageHeader icon={LayersIcon} title="Protected Workloads" description="Protected capacity and object counts by workload type, per cluster and estate-wide">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={refresh} refreshing={refreshing} />
      </PageHeader>

      {loading ? (
        <div className="rbk-panel"><LoadingPanel label="Loading workload data…" height={280} /></div>
      ) : error ? (
        <div className="rbk-panel" style={{ padding: 24, textAlign: 'center', color: 'var(--rbk-ink-muted)', fontSize: 13 }}>
          Could not load workload data. <button onClick={reload} className="rbk-btn-ghost" style={{ display: 'inline-flex', marginLeft: 6 }}>Retry</button>
        </div>
      ) : (
        <>
          <div className="rbk-stagger" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 16 }}>
            <div style={{ '--rbk-i': 0 }}><StatCard icon={BoxesIcon} label="Protected Objects" value={fmtNum(totals.objects)} tone="brand" /></div>
            <div style={{ '--rbk-i': 1 }}><StatCard icon={DbIcon} label="Protected Front-end" value={fmtTb(totals.protected)} /></div>
            <div style={{ '--rbk-i': 2 }}><StatCard icon={LayersIcon} label="Logical Usage" value={fmtTb(totals.logical)} /></div>
            <div style={{ '--rbk-i': 3 }}><StatCard icon={ServerIcon} label="Physical Consumed" value={fmtTb(totals.physical)} tone="info" /></div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16, marginBottom: 16 }}>
            <Panel title="Estate by Workload Type">
              {estate.length === 0 ? (
                <p style={{ fontSize: 13, color: 'var(--rbk-ink-muted)', textAlign: 'center', padding: '24px 0' }}>No workload data yet.</p>
              ) : (
                <div className="rbk-scroll" style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <SortTh k="workload" label="Workload" ctl={estateCtl} align="left" />
                        <SortTh k="clusters" label="Clusters" ctl={estateCtl} />
                        <SortTh k="objects" label="Objects" ctl={estateCtl} />
                        <SortTh k="unprotected" label="Unprotected" ctl={estateCtl} />
                        <SortTh k="protected" label="Protected" ctl={estateCtl} />
                        <SortTh k="logical" label="Logical" ctl={estateCtl} />
                        <SortTh k="physical" label="Physical" ctl={estateCtl} />
                        <SortTh k="reduction" label="Reduction" ctl={estateCtl} />
                      </tr>
                    </thead>
                    <tbody>
                      {estateCtl.rows.map((e) => (
                        <tr key={e.workload} className="rbk-row" style={{ borderBottom: '1px solid var(--rbk-border)' }}>
                          <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink)' }}>
                            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', marginRight: 8, background: workloadColor(workloads, e.workload) }} />
                            {e.workload}
                          </td>
                          <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--rbk-ink-muted)' }}>{e.clusters}</td>
                          <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--rbk-ink)' }}>{fmtNum(e.objects)}</td>
                          <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--rbk-ink-faint)' }}>{fmtNum(e.unprotected)}</td>
                          <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--rbk-ink)' }}>{fmtTb(e.protected)}</td>
                          <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--rbk-ink-muted)' }}>{fmtTb(e.logical)}</td>
                          <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--rbk-ink-muted)' }}>{fmtTb(e.physical)}</td>
                          <td className="rbk-tnum" style={{ padding: '8px 0', textAlign: 'right', color: 'var(--rbk-ink-faint)' }}>{ratio(e.logical, e.physical)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
            <Panel title="Protected TB by Workload">
              {shareBarRows.length === 0 ? (
                <p style={{ fontSize: 13, color: 'var(--rbk-ink-muted)', textAlign: 'center', padding: '24px 0' }}>—</p>
              ) : (
                <HBar rows={shareBarRows} width={300} unit=" TB" />
              )}
            </Panel>
          </div>

          <Panel title="Trend Over Time" style={{ marginBottom: 16 }}
            actions={
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <select value={trendCluster} onChange={(e) => setTrendCluster(e.target.value)} className="rbk-input" style={{ width: 'auto' }}>
                  <option value="">Entire estate</option>
                  {clusters.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <select value={trendWorkload} onChange={(e) => setTrendWorkload(e.target.value)} className="rbk-input" style={{ width: 'auto' }}>
                  <option value="">All workloads</option>
                  {workloads.map((w) => <option key={w} value={w}>{w}</option>)}
                </select>
                <select value={trendMetric} onChange={(e) => setTrendMetric(e.target.value)} className="rbk-input" style={{ width: 'auto' }}>
                  {METRICS.map((m) => <option key={m.k} value={m.k}>{m.label}</option>)}
                </select>
                <select value={trendDays} onChange={(e) => setTrendDays(Number(e.target.value))} className="rbk-input" style={{ width: 'auto' }}>
                  <option value={30}>30 days</option>
                  <option value={90}>90 days</option>
                  <option value={180}>180 days</option>
                </select>
              </div>
            }
          >
            {trend == null ? (
              <LoadingPanel label="Loading trend…" height={220} />
            ) : !trendChart || trendChart.every((s) => s.points.length === 0) ? (
              <p style={{ fontSize: 13, color: 'var(--rbk-ink-muted)', textAlign: 'center', padding: '32px 0' }}>No trend data yet.</p>
            ) : (
              <LineChart series={trendChart} width={900} height={260} yUnit={metricDef.bytes ? (v) => `${v.toFixed(0)} TB` : undefined} />
            )}
          </Panel>

          <Panel title="Breakdown by Cluster" icon={ServerIcon}>
            <TableControls ctl={clusterCtl} rows={rows} searchPlaceholder="Filter by cluster or workload…"
              filters={[{ k: 'cluster', label: 'Clusters' }, { k: 'workload', label: 'Workloads' }]} />
            {rows.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--rbk-ink-muted)', textAlign: 'center', padding: '24px 0' }}>No workload data yet.</p>
            ) : clusterCtl.rows.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--rbk-ink-muted)', textAlign: 'center', padding: '24px 0' }}>No rows match your filters.</p>
            ) : (
              <div className="rbk-scroll" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <SortTh k="cluster" label="Cluster" ctl={clusterCtl} align="left" />
                      <SortTh k="workload" label="Workload" ctl={clusterCtl} align="left" />
                      <SortTh k="objects" label="Objects" ctl={clusterCtl} />
                      <SortTh k="unprotected" label="Unprotected" ctl={clusterCtl} />
                      <SortTh k="protected" label="Protected" ctl={clusterCtl} />
                      <SortTh k="logical" label="Logical" ctl={clusterCtl} />
                      <SortTh k="physical" label="Physical" ctl={clusterCtl} />
                    </tr>
                  </thead>
                  <tbody>
                    {clusterCtl.pageRows.map((r, i) => (
                      <tr key={`${r.cluster}|${r.workload}|${i}`} className="rbk-row" style={{ borderBottom: '1px solid var(--rbk-border)' }}>
                        <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink)' }}>{r.cluster}</td>
                        <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-muted)' }}>
                          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', marginRight: 8, background: workloadColor(workloads, r.workload) }} />
                          {r.workload}
                        </td>
                        <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--rbk-ink)' }}>{fmtNum(r.objects)}</td>
                        <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--rbk-ink-faint)' }}>{fmtNum(r.unprotected)}</td>
                        <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--rbk-ink)' }}>{fmtTb(r.protected)}</td>
                        <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--rbk-ink-muted)' }}>{fmtTb(r.logical)}</td>
                        <td className="rbk-tnum" style={{ padding: '8px 0', textAlign: 'right', color: 'var(--rbk-ink-muted)' }}>{fmtTb(r.physical)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <TablePager ctl={clusterCtl} />
          </Panel>
        </>
      )}
    </div>
  );
}
