// NetBackup Workloads — ports host frontend/src/pages/netbackup/NbWorkloadsPage.jsx.
import {
  injectStyles, PageHeader, StatCard, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh,
  LayersIcon, BoxesIcon, DbIcon, ShieldAlertIcon, ServerIcon,
} from '../ui.jsx';
import { LineChart, BarChart } from '../charts.jsx';
import { TB, fmtTb, fmtNum, apiGet } from './helpers.js';

injectStyles();

const WL_COLORS = ['#B1181E', '#0091DA', '#6CB33F', '#D4A24E', '#9B6CD4', '#4ED4B8', '#D46CB3', '#8FA3B0'];
const wlColor = (list, w) => WL_COLORS[list.indexOf(w) % WL_COLORS.length];

const METRICS = [
  { k: 'protectedBytes', label: 'Protected TB', bytes: true },
  { k: 'jobCount', label: 'Job Count', bytes: false },
  { k: 'failedCount', label: 'Failed Jobs', bytes: false },
  { k: 'protectedClients', label: 'Protected Clients', bytes: false },
];

export default function NbWorkloadsPage() {
  const [data, setData] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const [trendDomain, setTrendDomain] = React.useState('');
  const [trendWorkload, setTrendWorkload] = React.useState('');
  const [trendMetric, setTrendMetric] = React.useState('protectedBytes');
  const [trendDays, setTrendDays] = React.useState(90);
  const [trend, setTrend] = React.useState(null);

  const load = React.useCallback(() => apiGet('/workloads')
    .then((d) => { setData(d); setLastRefreshed(new Date()); })
    .catch(() => setData({ rows: [], estate: [], domains: [] })), []);

  React.useEffect(() => { load(); }, [load]);

  React.useEffect(() => {
    const params = { days: trendDays };
    if (trendDomain) params.sourceId = trendDomain;
    if (trendWorkload) params.workload = trendWorkload;
    apiGet('/workloads/trends', params).then((d) => setTrend(d.trends || [])).catch(() => setTrend([]));
  }, [trendDomain, trendWorkload, trendDays]);

  const rows = data?.rows || [];
  const estate = data?.estate || [];
  const domains = data?.domains || [];
  const domainOpts = React.useMemo(() => [...new Map(rows.map((r) => [r.sourceId, r.sourceName])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [rows]);
  const workloadOpts = React.useMemo(() => estate.map((e) => e.workload), [estate]);

  const totals = React.useMemo(() => estate.reduce((t, e) => ({
    clients: t.clients + (e.protectedClients || 0), jobs: t.jobs + (e.jobCount || 0),
    failed: t.failed + (e.failedCount || 0), bytes: t.bytes + (e.protectedBytes || 0),
  }), { clients: 0, jobs: 0, failed: 0, bytes: 0 }), [estate]);

  const estateCtl = useTableControls(estate, { defaultSortKey: 'protectedBytes', defaultSortDir: 'desc' });

  const [pivotDomain, setPivotDomain] = React.useState('');
  const pivotWorkloads = React.useMemo(() => [...new Set(rows.map((r) => r.workload))].sort((a, b) => a.localeCompare(b)), [rows]);
  const pivotRows = React.useMemo(() => {
    const byDomain = new Map();
    for (const r of rows) {
      if (!byDomain.has(r.sourceId)) {
        const meta = domains.find((d) => d.sourceId === r.sourceId);
        byDomain.set(r.sourceId, { sourceId: r.sourceId, sourceName: r.sourceName, sourceType: meta?.sourceType || '—', totalClients: 0, totalBytes: 0, cells: {} });
      }
      const row = byDomain.get(r.sourceId);
      row.cells[r.workload] = { clients: r.protectedClients || 0, bytes: r.protectedBytes || 0 };
      row.totalClients += r.protectedClients || 0;
      row.totalBytes += r.protectedBytes || 0;
    }
    return [...byDomain.values()].sort((a, b) => b.totalBytes - a.totalBytes);
  }, [rows, domains]);
  const visiblePivotRows = pivotDomain ? pivotRows.filter((r) => String(r.sourceId) === pivotDomain) : pivotRows;

  const metricDef = METRICS.find((m) => m.k === trendMetric);
  const trendChart = React.useMemo(() => {
    if (!trend) return null;
    const days = [...new Set(trend.map((t) => t.day))].sort();
    const byWl = new Map();
    for (const t of trend) {
      if (!byWl.has(t.workload)) byWl.set(t.workload, new Map());
      byWl.get(t.workload).set(t.day, t[trendMetric] || 0);
    }
    const wls = [...byWl.keys()].sort();
    return {
      labels: days,
      series: wls.map((w) => ({
        label: w, color: wlColor(wls, w),
        points: days.map((d, idx) => {
          const v = byWl.get(w).get(d);
          return { x: idx, y: v == null ? null : (metricDef.bytes ? v / TB : v) };
        }),
      })),
    };
  }, [trend, trendMetric, metricDef]);

  const shareSorted = React.useMemo(() => [...estate].sort((a, b) => (b.protectedBytes || 0) - (a.protectedBytes || 0)), [estate]);

  return (
    <div className="nb-root nb-fade-in">
      <PageHeader icon={LayersIcon} title="Protected Workloads" description="Protected capacity and job counts by workload type, per NBU domain and estate-wide">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} refreshing={data == null} />
      </PageHeader>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 12, marginBottom: 16 }} className="nb-stat-grid">
        <style>{`@media (min-width: 900px) { .nb-stat-grid { grid-template-columns: repeat(4,1fr) !important; } }`}</style>
        <StatCard icon={BoxesIcon} label="Protected Clients" value={fmtNum(totals.clients)} tone="brand" />
        <StatCard icon={DbIcon} label="Protected TB" value={fmtTb(totals.bytes)} />
        <StatCard icon={LayersIcon} label="Jobs" value={fmtNum(totals.jobs)} />
        <StatCard icon={ShieldAlertIcon} label="Failed Jobs" value={fmtNum(totals.failed)} tone={totals.failed ? 'warn' : 'ok'} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16, marginBottom: 16 }} className="nb-wl-row">
        <style>{`@media (min-width: 1024px) { .nb-wl-row { grid-template-columns: 2fr 1fr !important; } }`}</style>
        <div className="nb-panel" style={{ padding: 16 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 2 }}>Estate by Workload Type</p>
          <p style={{ fontSize: 11, color: 'var(--nb-ink-faint)', marginBottom: 12 }}>All NBU domains combined.</p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={140} />
          ) : estate.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No workload data yet — it appears after the next poll cycle.</div>
          ) : (
            <div className="nb-scroll" style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr style={{ borderBottom: '1px solid var(--nb-border)' }}>
                  <SortTh k="workload" label="Workload" ctl={estateCtl} />
                  <SortTh k="sources" label="Domains" ctl={estateCtl} align="right" />
                  <SortTh k="protectedClients" label="Clients" ctl={estateCtl} align="right" />
                  <SortTh k="jobCount" label="Jobs" ctl={estateCtl} align="right" />
                  <SortTh k="failedCount" label="Failed" ctl={estateCtl} align="right" />
                  <SortTh k="protectedBytes" label="Protected" ctl={estateCtl} align="right" />
                </tr></thead>
                <tbody>
                  {estateCtl.rows.map((e) => (
                    <tr key={e.workload} className="nb-row" style={{ borderBottom: '1px solid var(--nb-border)' }}>
                      <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink)' }}>
                        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', marginRight: 8, background: wlColor(workloadOpts, e.workload) }} />
                        {e.workload}
                      </td>
                      <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink-muted)' }}>{e.sources}</td>
                      <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink)' }}>{fmtNum(e.protectedClients)}</td>
                      <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink-muted)' }}>{fmtNum(e.jobCount)}</td>
                      <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink-faint)' }}>{fmtNum(e.failedCount)}</td>
                      <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink)' }}>{fmtTb(e.protectedBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="nb-panel" style={{ padding: 16 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 12 }}>Protected TB by Workload</p>
          {estate.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>—</div>
          ) : (
            <BarChart horizontal labels={shareSorted.map((e) => e.workload)} values={shareSorted.map((e) => (e.protectedBytes || 0) / TB)}
              colors={shareSorted.map((e) => wlColor(workloadOpts, e.workload))} yFmt={(v) => `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 })} TB`}
              height={Math.max(180, estate.length * 26 + 60)} />
          )}
        </div>
      </div>

      <div className="nb-panel" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', margin: 0, marginRight: 'auto' }}>Trend Over Time</p>
          <select value={trendDomain} onChange={(e) => setTrendDomain(e.target.value)} className="nb-input" style={{ width: 'auto', cursor: 'pointer' }}>
            <option value="">Entire estate</option>
            {domainOpts.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <select value={trendWorkload} onChange={(e) => setTrendWorkload(e.target.value)} className="nb-input" style={{ width: 'auto', cursor: 'pointer' }}>
            <option value="">All workloads</option>
            {workloadOpts.map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
          <select value={trendMetric} onChange={(e) => setTrendMetric(e.target.value)} className="nb-input" style={{ width: 'auto', cursor: 'pointer' }}>
            {METRICS.map((m) => <option key={m.k} value={m.k}>{m.label}</option>)}
          </select>
          <select value={trendDays} onChange={(e) => setTrendDays(Number(e.target.value))} className="nb-input" style={{ width: 'auto', cursor: 'pointer' }}>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={180}>180 days</option>
            <option value={365}>1 year</option>
          </select>
        </div>
        {trend == null ? (
          <LoadingPanel label="Loading trend…" height={220} />
        ) : !trendChart || trendChart.labels.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '32px 0', textAlign: 'center' }}>No trend data yet — snapshots accumulate daily as the poller runs.</div>
        ) : (
          <LineChart series={trendChart.series} xLabels={trendChart.labels} height={280} yFmt={metricDef?.bytes ? (v) => `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })} TB` : undefined} />
        )}
      </div>

      <div className="nb-panel" style={{ padding: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <ServerIcon size={15} style={{ color: 'var(--nb-brand)' }} /> Breakdown by Domain
          </p>
          <select value={pivotDomain} onChange={(e) => setPivotDomain(e.target.value)} className="nb-input" style={{ width: 'auto', cursor: 'pointer' }}>
            <option value="">All Domains</option>
            {domainOpts.map(([id, name]) => <option key={id} value={String(id)}>{name}</option>)}
          </select>
        </div>
        <p style={{ fontSize: 11, color: 'var(--nb-ink-faint)', marginBottom: 12 }}>Protected clients per workload type, per NBU domain. Hover a cell for protected TB.</p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={140} />
        ) : pivotRows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No domain data yet — it appears after the next poll cycle.</div>
        ) : (
          <div className="nb-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr style={{ borderBottom: '1px solid var(--nb-border)' }}>
                <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>Domain</th>
                <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>Type</th>
                {pivotWorkloads.map((w) => <th key={w} style={{ padding: '8px 12px 8px 0', textAlign: 'right', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>{w}</th>)}
                <th style={{ padding: '8px 12px 8px 0', textAlign: 'right', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>Total Clients</th>
                <th style={{ padding: '8px 0', textAlign: 'right', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>Total Protected</th>
              </tr></thead>
              <tbody>
                {visiblePivotRows.map((d) => (
                  <tr key={d.sourceId} className="nb-row" style={{ borderBottom: '1px solid var(--nb-border)' }}>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink)', fontWeight: 500 }}>{d.sourceName}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)' }}>{d.sourceType}</td>
                    {pivotWorkloads.map((w) => {
                      const cell = d.cells[w];
                      return (
                        <td key={w} className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right' }} title={cell ? `${fmtTb(cell.bytes)} protected` : undefined}>
                          {cell ? <span style={{ color: 'var(--nb-ink)' }}>{fmtNum(cell.clients)}</span> : <span style={{ color: 'var(--nb-ink-faint)' }}>—</span>}
                        </td>
                      );
                    })}
                    <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink)', fontWeight: 600 }}>{fmtNum(d.totalClients)}</td>
                    <td className="nb-tnum" style={{ padding: '8px 0', textAlign: 'right', color: 'var(--nb-ink)', fontWeight: 600 }}>{fmtTb(d.totalBytes)}</td>
                  </tr>
                ))}
                {!pivotDomain && visiblePivotRows.length > 1 && (
                  <tr style={{ borderTop: '1px solid var(--nb-border)' }}>
                    <td colSpan={2} style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-faint)', fontSize: 11, textTransform: 'uppercase' }}>Estate total</td>
                    {pivotWorkloads.map((w) => (
                      <td key={w} className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink-muted)' }}>
                        {fmtNum(visiblePivotRows.reduce((s, d) => s + (d.cells[w]?.clients || 0), 0))}
                      </td>
                    ))}
                    <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--nb-ink-muted)' }}>{fmtNum(visiblePivotRows.reduce((s, d) => s + d.totalClients, 0))}</td>
                    <td className="nb-tnum" style={{ padding: '8px 0', textAlign: 'right', color: 'var(--nb-ink-muted)' }}>{fmtTb(visiblePivotRows.reduce((s, d) => s + d.totalBytes, 0))}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
