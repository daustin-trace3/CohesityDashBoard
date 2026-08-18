// Cohesity plugin — Views page. Ported from frontend/src/pages/ViewsPage.jsx.
// Backend routes /cohesity/views + /cohesity/views/refresh mirror the
// built-in backend/routes/views.js paths exactly (GET cached inventory,
// POST force refresh from Helios).
import {
  apiFetch, useToast,
  PageHeader, Panel, Badge, StatCard, LoadingPanel, LastUpdated, RefreshButton,
} from '../ui.jsx';
import { Server, ShieldCheck, Database, ChevronUp, ChevronDown, Lock } from '../icons.jsx';
import { DoughnutChart, BarChart } from '../charts.jsx';

/* ── page-local icons — not in the shared kit's icons.jsx ─────────────────
 * FolderOpen/ShieldOff/ArrowDownToLine/Search are only used on this page,
 * so they live here rather than growing the shared vocabulary. */
function FolderOpen(p) {
  const size = p.size || 16;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={p.style} className={p.className}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H5" /><path d="M3 7v11a2 2 0 0 0 2 2h13.2a2 2 0 0 0 1.94-1.5l1.66-6.5H5.1a2 2 0 0 0-1.94 1.5L3 15" />
    </svg>
  );
}
function ShieldOff(p) {
  const size = p.size || 16;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={p.style} className={p.className}>
      <path d="M19.7 14a7 7 0 0 0 .3-2V5l-8-3-3.2 1.2M4.7 4.7 4 5v7c0 6 8 10 8 10a13.5 13.5 0 0 0 5-3.5" /><path d="M1 1l22 22" />
    </svg>
  );
}
function ArrowDownToLine(p) {
  const size = p.size || 16;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={p.style} className={p.className}>
      <path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M4 21h16" />
    </svg>
  );
}
function Search(p) {
  const size = p.size || 16;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={p.style} className={p.className}>
      <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
    </svg>
  );
}

function fmtBytes(b) {
  if (b == null || b === 0) return '—';
  if (b >= 1e15) return (b / 1e15).toFixed(2) + ' PB';
  if (b >= 1e12) return (b / 1e12).toFixed(2) + ' TB';
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
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
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [search, setSearch] = React.useState('');
  const [clusterFilter, setClusterFilter] = React.useState('all');
  const [backupFilter, setBackupFilter] = React.useState('all');
  const [replFilter, setReplFilter] = React.useState('all');
  const [sortKey, setSortKey] = React.useState('name');
  const [sortDir, setSortDir] = React.useState('asc');
  const [page, setPage] = React.useState(0);
  const [pageSize, setPageSize] = React.useState(25);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/cohesity/views');
      setData(res);
      setLastRefreshed(new Date());
    } catch (err) {
      toast({ type: 'error', title: 'Views fetch failed', message: err?.payload?.error || err?.message || 'Could not load views' });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => { load(); }, [load]);
  React.useEffect(() => { setPage(0); }, [search, clusterFilter, backupFilter, replFilter, pageSize]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const res = await apiFetch('/cohesity/views/refresh', { method: 'POST' });
      setData(res);
      setLastRefreshed(new Date());
      toast({ type: 'success', title: 'Views refreshed', message: `${res.summary.total} views across ${res.summary.clusterCount} clusters.` });
    } catch (err) {
      toast({ type: 'error', title: 'Refresh failed', message: err?.payload?.error || err?.message });
    } finally {
      setRefreshing(false);
    }
  };

  const summary = data?.summary;
  const views = React.useMemo(() => data?.views || [], [data]);
  const clusters = React.useMemo(() => [...new Set(views.map((v) => v.systemName).filter(Boolean))].sort(), [views]);

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return views.filter((v) => {
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

  const sorted = React.useMemo(() => {
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
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'name' || key === 'systemName' ? 'asc' : 'desc'); }
  };

  const categoryChart = React.useMemo(() => {
    const counts = {};
    for (const v of views) counts[v.category || 'Unknown'] = (counts[v.category || 'Unknown'] || 0) + 1;
    const labels = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    return { labels, datasets: [{ data: labels.map((l) => counts[l]), backgroundColor: labels.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]), borderWidth: 0 }] };
  }, [views]);

  const protectionChart = React.useMemo(() => {
    if (!summary) return null;
    return {
      labels: ['Protected', 'Unprotected (writable)', 'Replica (read-only)'],
      datasets: [{ data: [summary.protected, summary.unprotectedWritable, summary.replicasIn], backgroundColor: ['#6CB33F', '#F59E0B', '#3B82F6'], borderWidth: 0 }],
    };
  }, [summary]);

  const clusterChart = React.useMemo(() => {
    const byCluster = {};
    for (const v of views) {
      const k = v.systemName || v.systemId;
      byCluster[k] = (byCluster[k] || 0) + (v.consumedBytes || 0);
    }
    const labels = Object.keys(byCluster).sort((a, b) => byCluster[b] - byCluster[a]).slice(0, 12);
    return { labels, datasets: [{ label: 'Consumed', data: labels.map((l) => byCluster[l] / 1e12), backgroundColor: '#6CB33F', borderRadius: 3 }] };
  }, [views]);

  const doughnutOpts = { plugins: { legend: { position: 'right' } } };
  const barOpts = {
    indexAxis: 'y',
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.x.toFixed(2)} TB consumed` } } },
    scales: {
      x: { ticks: { callback: (v) => Number(v).toFixed(1) + ' TB' } },
      y: { grid: { display: false } },
    },
  };

  if (loading && !data) return <LoadingPanel label="Loading views…" />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader icon={FolderOpen} title="Views" description="SmartFiles views and backup targets across all Helios-connected clusters.">
        <LastUpdated date={lastRefreshed} />
        <RefreshButton onClick={refresh} refreshing={refreshing} />
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5" style={{ gap: 12 }}>
        <StatCard icon={FolderOpen} label="Total Views" value={summary?.total ?? '—'} sub={`${summary?.clusterCount ?? 0} clusters`} tone="brand" />
        <StatCard
          icon={Database}
          label="Storage Consumed"
          value={fmtBytes(summary?.consumedBytes)}
          sub={summary?.consumedWritableBytes != null ? `${fmtBytes(summary.consumedWritableBytes)} SmartFiles · ${fmtBytes(summary.consumedReplicasBytes)} replicas` : 'physical, post-dedup'}
        />
        <StatCard icon={Server} label="Logical Data" value={fmtBytes(summary?.logicalBytes)} sub="pre-reduction" />
        <StatCard icon={ShieldCheck} label="Protected" value={summary?.protected ?? '—'} sub={summary?.total ? `${Math.round((summary.protected / summary.total) * 100)}% of views` : ''} tone="ok" />
        <StatCard icon={ShieldOff} label="Unprotected" value={summary?.unprotectedWritable ?? '—'} sub="writable, no backup" tone={summary?.unprotectedWritable > 0 ? 'warn' : 'default'} />
        <StatCard icon={ArrowDownToLine} label="Replicas In" value={summary?.replicasIn ?? '—'} sub="read-only, replicated in" tone="info" />
      </div>

      <p style={{ fontSize: 11, color: 'var(--co-ink-faint)', lineHeight: 1.5, margin: 0 }}>
        Consumed figures are physical on-disk (post-dedup) — the same basis as the{' '}
        <window.ReactRouterDOM.Link to="/cohesity/licensing" style={{ color: 'var(--co-brand)' }} className="hover:underline">Licensing page</window.ReactRouterDOM.Link>'s Consumption Breakdown:
        writable views here match its <span style={{ color: 'var(--co-ink-muted)' }}>Views (SmartFiles)</span> column and read-only
        replicas match <span style={{ color: 'var(--co-ink-muted)' }}>Replicated Views</span>. The SmartFiles license card itself uses
        Cohesity's billing meter, which typically reads a few percent higher than physical on-disk.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-3" style={{ gap: 12 }}>
        <Panel title="Protection Coverage" icon={ShieldCheck}>
          {protectionChart && <DoughnutChart data={protectionChart} options={doughnutOpts} height={210} />}
        </Panel>
        <Panel title="Views by Category" icon={FolderOpen}>
          <DoughnutChart data={categoryChart} options={doughnutOpts} height={210} />
        </Panel>
        <Panel title="Top Clusters by View Capacity" icon={Server}>
          <BarChart data={clusterChart} options={barOpts} height={210} />
        </Panel>
      </div>

      <Panel
        title={`View Inventory (${sorted.length}${sorted.length !== views.length ? ` of ${views.length}` : ''})`}
        icon={FolderOpen}
        actions={
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <div style={{ position: 'relative' }}>
              <Search size={13} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--co-ink-faint)' }} />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search views…" className="co-input" style={{ paddingLeft: 28, width: 176 }} />
            </div>
            <select value={clusterFilter} onChange={(e) => setClusterFilter(e.target.value)} className="co-input" style={{ width: 'auto' }}>
              <option value="all">All clusters</option>
              {clusters.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={backupFilter} onChange={(e) => setBackupFilter(e.target.value)} className="co-input" style={{ width: 'auto' }}>
              <option value="all">Backup: any</option>
              <option value="yes">Backup: yes</option>
              <option value="no">Backup: no</option>
            </select>
            <select value={replFilter} onChange={(e) => setReplFilter(e.target.value)} className="co-input" style={{ width: 'auto' }}>
              <option value="all">Replication: any</option>
              <option value="yes">Replicated out</option>
              <option value="replica">Replica (in)</option>
              <option value="no">Not replicated</option>
            </select>
          </div>
        }
      >
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--co-ink-muted)', borderBottom: '1px solid var(--co-border)' }}>
                {COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    onClick={() => toggleSort(col.key)}
                    className="hover:text-ink"
                    style={{ padding: '8px 16px 8px 0', fontWeight: 500, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', textAlign: col.numeric ? 'right' : 'left' }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {col.label}
                      {sortKey === col.key && (sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((v) => (
                <tr key={`${v.systemId}-${v.name}`} className="hover:bg-white/[0.03]" style={{ borderBottom: '1px solid rgba(31,43,55,.5)' }}>
                  <td style={{ padding: '8px 16px 8px 0' }}>
                    <span style={{ color: 'var(--co-ink)' }}>{v.name}</span>
                    {v.isReadOnly === 1 && <Badge tone="info" style={{ marginLeft: 8 }}>Replica</Badge>}
                  </td>
                  <td style={{ padding: '8px 16px 8px 0', color: 'var(--co-ink-muted)', whiteSpace: 'nowrap' }}>{v.systemName || v.systemId}</td>
                  <td style={{ padding: '8px 16px 8px 0', color: 'var(--co-ink-muted)' }}>{v.category || '—'}</td>
                  <td style={{ padding: '8px 16px 8px 0', color: 'var(--co-ink-muted)' }}>{v.protocols || '—'}</td>
                  <td style={{ padding: '8px 16px 8px 0' }}>
                    {v.protected ? (
                      <span title={(v.protectionGroups || []).join(', ') + (v.lastBackupStatus ? ` — last run ${v.lastBackupStatus}` : '')}>
                        <Badge tone={v.lastBackupStatus === 'Succeeded' ? 'ok' : v.lastBackupStatus ? 'warn' : 'ok'}>Yes</Badge>
                      </span>
                    ) : (
                      <Badge tone={v.isReadOnly ? 'neutral' : 'warn'}>No</Badge>
                    )}
                  </td>
                  <td style={{ padding: '8px 16px 8px 0' }}>
                    {v.replicatedOut ? <Badge tone="ok">Yes</Badge> : v.isReadOnly ? <Badge tone="info">Inbound</Badge> : <Badge tone="neutral">No</Badge>}
                  </td>
                  <td style={{ padding: '8px 16px 8px 0' }}>
                    {v.datalockMode ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--co-brand)' }} title={`DataLock ${v.datalockMode} mode${v.datalockRetentionMs ? ` — ${Math.round(v.datalockRetentionMs / 86400000)}d default retention` : ''}`}>
                        <Lock size={13} /><span>{v.datalockMode}</span>
                      </span>
                    ) : <span style={{ color: 'var(--co-ink-faint)' }}>—</span>}
                  </td>
                  <td className="tnum" style={{ padding: '8px 16px 8px 0', textAlign: 'right', color: 'var(--co-ink-muted)', whiteSpace: 'nowrap' }}>{fmtBytes(v.logicalBytes)}</td>
                  <td className="tnum" style={{ padding: '8px 16px 8px 0', textAlign: 'right', color: 'var(--co-ink-muted)', whiteSpace: 'nowrap' }}>{fmtBytes(v.consumedBytes)}</td>
                  <td className="tnum" style={{ padding: '8px 16px 8px 0', textAlign: 'right', color: 'var(--co-ink-faint)', whiteSpace: 'nowrap' }}>{fmtDate(v.createdMs)}</td>
                </tr>
              ))}
              {pageRows.length === 0 && (
                <tr><td colSpan={COLUMNS.length} style={{ padding: '32px 0', textAlign: 'center', color: 'var(--co-ink-faint)' }}>No views match the current filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, fontSize: 11, color: 'var(--co-ink-muted)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>Rows:</span>
            <select value={pageSize} onChange={(e) => setPageSize(e.target.value === 'all' ? 'all' : Number(e.target.value))} className="co-input" style={{ width: 'auto' }}>
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value="all">All</option>
            </select>
          </div>
          {pageSize !== 'all' && pageCount > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="co-btn-ghost">Prev</button>
              <span className="tnum">{page + 1} / {pageCount}</span>
              <button onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1} className="co-btn-ghost">Next</button>
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
