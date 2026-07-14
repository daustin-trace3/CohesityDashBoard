import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  FolderOpen, Server, ShieldCheck, ShieldOff, ArrowLeftRight, Database, ArrowDownToLine,
  ChevronUp, ChevronDown, Search, Lock,
} from 'lucide-react';
import { Doughnut, Bar } from 'react-chartjs-2';
import {
  Chart as ChartJS, ArcElement, CategoryScale, LinearScale, BarElement, Tooltip, Legend,
} from 'chart.js';
import client from '../api/client';
import { PageHeader, Panel, Badge, StatCard, LoadingPanel, LastUpdated, RefreshButton } from '../components/ui/primitives';
import { useToast } from '../components/ui/Toaster';

ChartJS.register(ArcElement, CategoryScale, LinearScale, BarElement, Tooltip, Legend);

function fmtBytes(b) {
  if (b == null || b === 0) return '—';
  if (b >= 1e15) return (b / 1e15).toFixed(2) + ' PB';
  if (b >= 1e12) return (b / 1e12).toFixed(2) + ' TB';
  if (b >= 1e9)  return (b / 1e9).toFixed(2) + ' GB';
  return (b / 1e6).toFixed(1) + ' MB';
}

function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString();
}

const CHART_COLORS = ['#6CB33F', '#3B82F6', '#F59E0B', '#8B5CF6', '#EC4899', '#14B8A6', '#EF4444', '#A3A3A3'];

const COLUMNS = [
  { key: 'name', label: 'View Name' },
  { key: 'systemName', label: 'Cluster' },
  { key: 'category', label: 'Category' },
  { key: 'protocols', label: 'Protocols' },
  { key: 'protected', label: 'Backup' },
  { key: 'replicatedOut', label: 'Replication' },
  { key: 'datalockMode', label: 'DataLock' },
  { key: 'logicalBytes', label: 'Logical', numeric: true },
  { key: 'consumedBytes', label: 'Consumed', numeric: true },
  { key: 'createdMs', label: 'Created', numeric: true },
];

export default function ViewsPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [search, setSearch] = useState('');
  const [clusterFilter, setClusterFilter] = useState('all');
  const [backupFilter, setBackupFilter] = useState('all');   // all | yes | no
  const [replFilter, setReplFilter] = useState('all');       // all | yes | no | replica
  const [sortKey, setSortKey] = useState('name');
  const [sortDir, setSortDir] = useState('asc');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25); // number | 'all'

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await client.get('/views');
      setData(data);
      setLastRefreshed(new Date());
    } catch (err) {
      toast({ type: 'error', title: 'Views fetch failed', message: err?.message || 'Could not load views' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(0); }, [search, clusterFilter, backupFilter, replFilter, pageSize]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const { data } = await client.post('/views/refresh', {}, { timeout: 300000 });
      setData(data);
      setLastRefreshed(new Date());
      toast({ type: 'success', title: 'Views refreshed', message: `${data.summary.total} views across ${data.summary.clusterCount} clusters.` });
    } catch (err) {
      toast({ type: 'error', title: 'Refresh failed', message: err?.response?.data?.error || err?.message });
    } finally {
      setRefreshing(false);
    }
  };

  const summary = data?.summary;
  const views = useMemo(() => data?.views || [], [data]);
  const clusters = useMemo(() => [...new Set(views.map(v => v.systemName).filter(Boolean))].sort(), [views]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return views.filter(v => {
      if (q && !v.name.toLowerCase().includes(q) && !(v.systemName || '').toLowerCase().includes(q)) return false;
      if (clusterFilter !== 'all' && v.systemName !== clusterFilter) return false;
      if (backupFilter === 'yes' && !v.protected) return false;
      if (backupFilter === 'no' && v.protected) return false;
      if (replFilter === 'yes' && !v.replicatedOut) return false;
      if (replFilter === 'no' && (v.replicatedOut || v.isReadOnly)) return false;
      if (replFilter === 'replica' && !v.isReadOnly) return false;
      return true;
    });
  }, [views, search, clusterFilter, backupFilter, replFilter]);

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string') return av.localeCompare(bv) * dir;
      return (av - bv) * dir;
    });
  }, [filtered, sortKey, sortDir]);

  const pageRows = pageSize === 'all' ? sorted : sorted.slice(page * pageSize, (page + 1) * pageSize);
  const pageCount = pageSize === 'all' ? 1 : Math.max(1, Math.ceil(sorted.length / pageSize));

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'name' || key === 'systemName' ? 'asc' : 'desc'); }
  };

  // ── Chart data ──────────────────────────────────────────────────────────
  const categoryChart = useMemo(() => {
    const counts = {};
    for (const v of views) counts[v.category || 'Unknown'] = (counts[v.category || 'Unknown'] || 0) + 1;
    const labels = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    return {
      labels,
      datasets: [{ data: labels.map(l => counts[l]), backgroundColor: labels.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]), borderWidth: 0 }],
    };
  }, [views]);

  const protectionChart = useMemo(() => {
    if (!summary) return null;
    return {
      labels: ['Protected', 'Unprotected (writable)', 'Replica (read-only)'],
      datasets: [{
        data: [summary.protected, summary.unprotectedWritable, summary.replicasIn],
        backgroundColor: ['#6CB33F', '#F59E0B', '#3B82F6'],
        borderWidth: 0,
      }],
    };
  }, [summary]);

  const clusterChart = useMemo(() => {
    const byCluster = {};
    for (const v of views) {
      const k = v.systemName || v.systemId;
      byCluster[k] = (byCluster[k] || 0) + (v.consumedBytes || 0);
    }
    const labels = Object.keys(byCluster).sort((a, b) => byCluster[b] - byCluster[a]).slice(0, 12);
    return {
      labels,
      datasets: [{ label: 'Consumed', data: labels.map(l => byCluster[l] / 1e12), backgroundColor: '#6CB33F', borderRadius: 3 }],
    };
  }, [views]);

  const doughnutOpts = {
    maintainAspectRatio: false, animation: false,
    plugins: { legend: { position: 'right', labels: { color: '#E5E5E5', font: { size: 11 }, boxWidth: 12 } } },
  };
  const barOpts = {
    maintainAspectRatio: false, animation: false, indexAxis: 'y',
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.x.toFixed(2)} TB consumed` } },
    },
    scales: {
      x: { ticks: { color: '#E5E5E5', font: { size: 10 }, callback: (v) => Number(v).toFixed(1) + ' TB' }, grid: { color: 'rgba(255,255,255,0.1)' } },
      y: { ticks: { color: '#E5E5E5', font: { size: 10 } }, grid: { display: false } },
    },
  };

  if (loading && !data) return <LoadingPanel label="Loading views…" />;

  const selectCls = 'bg-cohesity-black border border-white/10 rounded-md px-2 py-1.5 text-xs text-ink focus:outline-none focus:border-brand/60';

  return (
    <div className="space-y-4">
      <PageHeader
        icon={FolderOpen}
        title="Views"
        description="SmartFiles views and backup targets across all Helios-connected clusters."
      >
        <LastUpdated date={lastRefreshed} />
        <RefreshButton onClick={refresh} refreshing={refreshing} />
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <StatCard icon={FolderOpen} label="Total Views" value={summary?.total ?? '—'} sub={`${summary?.clusterCount ?? 0} clusters`} tone="brand" />
        <StatCard
          icon={Database}
          label="Storage Consumed"
          value={fmtBytes(summary?.consumedBytes)}
          sub={summary?.consumedWritableBytes != null
            ? `${fmtBytes(summary.consumedWritableBytes)} SmartFiles · ${fmtBytes(summary.consumedReplicasBytes)} replicas`
            : 'physical, post-dedup'}
        />
        <StatCard icon={Server} label="Logical Data" value={fmtBytes(summary?.logicalBytes)} sub="pre-reduction" />
        <StatCard icon={ShieldCheck} label="Protected" value={summary?.protected ?? '—'} sub={summary?.total ? `${Math.round((summary.protected / summary.total) * 100)}% of views` : ''} tone="ok" />
        <StatCard icon={ShieldOff} label="Unprotected" value={summary?.unprotectedWritable ?? '—'} sub="writable, no backup" tone={summary?.unprotectedWritable > 0 ? 'warn' : 'default'} />
        <StatCard icon={ArrowDownToLine} label="Replicas In" value={summary?.replicasIn ?? '—'} sub="read-only, replicated in" tone="info" />
      </div>

      <p className="text-[11px] text-ink-faint leading-snug">
        Consumed figures are physical on-disk (post-dedup) — the same basis as the{' '}
        <Link to="/licensing" className="text-brand hover:underline">Licensing page</Link>'s Consumption Breakdown:
        writable views here match its <span className="text-ink-muted">Views (SmartFiles)</span> column and read-only
        replicas match <span className="text-ink-muted">Replicated Views</span>. The SmartFiles license card itself uses
        Cohesity's billing meter, which typically reads a few percent higher than physical on-disk.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Panel title="Protection Coverage" icon={ShieldCheck}>
          <div style={{ height: 210 }}>{protectionChart && <Doughnut data={protectionChart} options={doughnutOpts} />}</div>
        </Panel>
        <Panel title="Views by Category" icon={FolderOpen}>
          <div style={{ height: 210 }}><Doughnut data={categoryChart} options={doughnutOpts} /></div>
        </Panel>
        <Panel title="Top Clusters by View Capacity" icon={Server}>
          <div style={{ height: 210 }}><Bar data={clusterChart} options={barOpts} /></div>
        </Panel>
      </div>

      <Panel
        title={`View Inventory (${sorted.length}${sorted.length !== views.length ? ` of ${views.length}` : ''})`}
        icon={FolderOpen}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search views…"
                className="bg-cohesity-black border border-white/10 rounded-md pl-7 pr-2 py-1.5 text-xs text-ink w-44 focus:outline-none focus:border-brand/60"
              />
            </div>
            <select value={clusterFilter} onChange={(e) => setClusterFilter(e.target.value)} className={selectCls}>
              <option value="all">All clusters</option>
              {clusters.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={backupFilter} onChange={(e) => setBackupFilter(e.target.value)} className={selectCls}>
              <option value="all">Backup: any</option>
              <option value="yes">Backup: yes</option>
              <option value="no">Backup: no</option>
            </select>
            <select value={replFilter} onChange={(e) => setReplFilter(e.target.value)} className={selectCls}>
              <option value="all">Replication: any</option>
              <option value="yes">Replicated out</option>
              <option value="replica">Replica (in)</option>
              <option value="no">Not replicated</option>
            </select>
          </div>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-ink-muted border-b border-white/10">
                {COLUMNS.map(col => (
                  <th
                    key={col.key}
                    onClick={() => toggleSort(col.key)}
                    className={`py-2 pr-4 font-medium cursor-pointer select-none hover:text-ink whitespace-nowrap ${col.numeric ? 'text-right' : ''}`}
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.label}
                      {sortKey === col.key && (sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRows.map(v => (
                <tr key={`${v.systemId}-${v.name}`} className="border-b border-white/5 hover:bg-white/[0.03]">
                  <td className="py-2 pr-4">
                    <span className="text-ink">{v.name}</span>
                    {v.isReadOnly === 1 && <Badge tone="info" className="ml-2">Replica</Badge>}
                  </td>
                  <td className="py-2 pr-4 text-ink-muted whitespace-nowrap">{v.systemName || v.systemId}</td>
                  <td className="py-2 pr-4 text-ink-muted">{v.category || '—'}</td>
                  <td className="py-2 pr-4 text-ink-muted">{v.protocols || '—'}</td>
                  <td className="py-2 pr-4">
                    {v.protected ? (
                      <span title={(v.protectionGroups || []).join(', ') + (v.lastBackupStatus ? ` — last run ${v.lastBackupStatus}` : '')}>
                        <Badge tone={v.lastBackupStatus === 'Succeeded' ? 'ok' : v.lastBackupStatus ? 'warn' : 'ok'}>Yes</Badge>
                      </span>
                    ) : (
                      <Badge tone={v.isReadOnly ? 'neutral' : 'warn'}>No</Badge>
                    )}
                  </td>
                  <td className="py-2 pr-4">
                    {v.replicatedOut
                      ? <Badge tone="ok">Yes</Badge>
                      : v.isReadOnly
                        ? <Badge tone="info">Inbound</Badge>
                        : <Badge tone="neutral">No</Badge>}
                  </td>
                  <td className="py-2 pr-4">
                    {v.datalockMode ? (
                      <span
                        className="inline-flex items-center gap-1 text-brand"
                        title={`DataLock ${v.datalockMode} mode${v.datalockRetentionMs ? ` — ${Math.round(v.datalockRetentionMs / 86400000)}d default retention` : ''}`}
                      >
                        <Lock size={13} />
                        <span className="text-xs">{v.datalockMode}</span>
                      </span>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-right text-ink-muted tnum whitespace-nowrap">{fmtBytes(v.logicalBytes)}</td>
                  <td className="py-2 pr-4 text-right text-ink-muted tnum whitespace-nowrap">{fmtBytes(v.consumedBytes)}</td>
                  <td className="py-2 pr-4 text-right text-ink-faint tnum whitespace-nowrap">{fmtDate(v.createdMs)}</td>
                </tr>
              ))}
              {pageRows.length === 0 && (
                <tr><td colSpan={COLUMNS.length} className="py-8 text-center text-ink-faint">No views match the current filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between mt-3 text-xs text-ink-muted">
          <div className="flex items-center gap-2">
            <span>Rows:</span>
            <select
              value={pageSize}
              onChange={(e) => setPageSize(e.target.value === 'all' ? 'all' : Number(e.target.value))}
              className={selectCls}
            >
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value="all">All</option>
            </select>
          </div>
          {pageSize !== 'all' && pageCount > 1 && (
            <div className="flex items-center gap-2">
              <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} className="px-2 py-1 rounded border border-white/10 disabled:opacity-40 hover:bg-white/5">Prev</button>
              <span className="tnum">{page + 1} / {pageCount}</span>
              <button onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1} className="px-2 py-1 rounded border border-white/10 disabled:opacity-40 hover:bg-white/5">Next</button>
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
