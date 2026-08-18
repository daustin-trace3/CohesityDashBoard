// Cohesity plugin — Replication page. Ported from frontend/src/pages/ReplicationPage.jsx.
// Backend route GET /cohesity/replication/status is already wired in routerData.js
// (compile('/replication/status') -> handleGetReplicationStatus); path kept exact.
import {
  apiFetch, useToast, humanizeMinutes,
  PageHeader, StatCard, Spinner, LastUpdated, RefreshButton, Badge,
} from '../ui.jsx';
import { ArrowLeftRight } from '../icons.jsx';

function fmtBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function fmtDateTime(usecs) {
  if (!usecs) return '—';
  return new Date(usecs / 1000).toLocaleString();
}

const STATUS_TONE = { Running: 'info', Succeeded: 'ok', Failed: 'crit', Canceled: 'crit' };

function progressColor(percent) {
  if (percent > 90) return '#6CB33F';
  if (percent > 50) return '#FBBF24';
  return '#EF4444';
}

const COLS = [
  { key: 'jobName', label: 'Job Name', align: 'left' },
  { key: 'targetCluster', label: 'Target Cluster', align: 'left' },
  { key: 'status', label: 'Status', align: 'left' },
  { key: 'startTime', label: 'Start Time', align: 'left' },
  { key: 'dataToSend', label: 'Data to Send', align: 'right' },
  { key: 'dataSent', label: 'Data Sent', align: 'right' },
  { key: 'progress', label: 'Progress', align: 'center' },
  { key: 'percentComplete', label: 'Logical Transfer Ratio', align: 'right', tooltip: 'Computed as logicalBytesTransferred / logicalSizeBytes. May differ from Cohesity UI percent.' },
];
const UNSORTABLE = new Set(['progress', 'dataToSend', 'dataSent']);

export default function ReplicationPage() {
  const { toast } = useToast();
  const [clusters, setClusters] = React.useState([]);
  const [selectedCluster, setSelectedCluster] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState('all');
  const [daysFilter, setDaysFilter] = React.useState(7);
  const [autoRefresh, setAutoRefresh] = React.useState(false);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [sortBy, setSortBy] = React.useState('percentComplete');
  const [sortDir, setSortDir] = React.useState('desc');

  React.useEffect(() => {
    apiFetch('/cohesity/clusters')
      .then((list) => {
        setClusters(list || []);
        if (list && list.length > 0) setSelectedCluster(list[0].name);
      })
      .catch(() => {});
  }, []);

  const fetchReplicationData = React.useCallback(async () => {
    if (!selectedCluster) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        clusterName: selectedCluster,
        statusFilter,
        days: String(daysFilter),
        numRunsPerGroup: '20',
      });
      const res = await apiFetch(`/cohesity/replication/status?${params}`);
      setData(res);
      setLastRefreshed(new Date());
    } catch (err) {
      const msg = err.payload?.error || err.message || 'Request failed';
      setError(msg);
      toast({ type: 'error', title: 'Replication fetch failed', message: msg });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCluster, statusFilter, daysFilter]);

  React.useEffect(() => { fetchReplicationData(); }, [fetchReplicationData]);

  React.useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchReplicationData, 30000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchReplicationData]);

  React.useEffect(() => {
    if (!data?.scanning) return;
    const interval = setInterval(fetchReplicationData, 15000);
    return () => clearInterval(interval);
  }, [data?.scanning, fetchReplicationData]);

  const replications = data?.replications || [];
  const totalCount = replications.length;
  const activeCount = replications.filter((r) => r.status === 'Running').length;
  const completedCount = replications.filter((r) => r.status === 'Succeeded').length;
  const failedCount = replications.filter((r) => r.status === 'Failed' || r.status === 'Canceled').length;
  const groupsScanned = data?.totalGroupsScanned || 0;

  const sortedReplications = React.useMemo(() => {
    const sorted = [...replications];
    const dir = sortDir === 'desc' ? -1 : 1;
    sorted.sort((a, b) => {
      if (sortBy === 'jobName') return dir * (a.jobName || '').toLowerCase().localeCompare((b.jobName || '').toLowerCase());
      if (sortBy === 'targetCluster') return dir * (a.targetCluster || '').toLowerCase().localeCompare((b.targetCluster || '').toLowerCase());
      if (sortBy === 'status') return dir * (a.status || '').localeCompare(b.status || '');
      if (sortBy === 'startTime') return dir * ((a.replicationStartTimeUsecs || 0) - (b.replicationStartTimeUsecs || 0));
      if (sortBy === 'percentComplete') return dir * ((a.percentComplete || 0) - (b.percentComplete || 0));
      return 0;
    });
    return sorted;
  }, [replications, sortBy, sortDir]);

  const handleSort = (col) => {
    if (sortBy === col) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortBy(col); setSortDir('desc'); }
  };

  const pillBtn = (active) => ({
    fontSize: 11, padding: '6px 12px', borderRadius: 6, fontWeight: 500, cursor: 'pointer',
    border: 'none', background: active ? 'var(--co-brand)' : 'var(--co-surface-overlay)',
    color: active ? '#fff' : 'var(--co-ink)', textTransform: 'capitalize',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader icon={ArrowLeftRight} title="Replication" description="Live replication task status, lag, and throughput per cluster" />

      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--co-black)', padding: '8px 0', borderBottom: '1px solid var(--co-border)' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 11, color: 'var(--co-ink-faint)' }}>Cluster:</label>
            <select className="co-input" style={{ width: 'auto' }} value={selectedCluster} onChange={(e) => setSelectedCluster(e.target.value)}>
              <option value="">Select cluster...</option>
              {clusters.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
          </div>

          <div style={{ display: 'flex', gap: 4 }}>
            {['all', 'active', 'failed'].map((status) => (
              <button key={status} onClick={() => setStatusFilter(status)} style={pillBtn(statusFilter === status)}>
                {status === 'all' ? 'All' : status === 'active' ? 'Active' : 'Failed'}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 4 }}>
            {[7, 14, 30].map((d) => (
              <button key={d} onClick={() => setDaysFilter(d)} style={pillBtn(daysFilter === d)}>{d}d</button>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={() => setAutoRefresh((v) => !v)}
              title={autoRefresh ? 'Auto-refresh on (30s)' : 'Auto-refresh off'}
              style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', background: autoRefresh ? 'var(--co-brand)' : 'var(--co-surface-overlay)', color: autoRefresh ? '#fff' : 'var(--co-ink-faint)' }}
            >
              <span className={autoRefresh ? 'animate-spin' : ''}>↻</span>
            </button>
            {autoRefresh && <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--co-brand)', animation: 'co-orb-pulse 2.5s ease-in-out infinite' }} />}
          </div>

          <RefreshButton onClick={fetchReplicationData} refreshing={loading} label="Refresh" />
          <LastUpdated date={lastRefreshed} prefix="Last refreshed" />
        </div>

        {loading && (
          <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--co-ink-muted)', marginTop: 8 }}>
            <Spinner size={13} /> Loading replication data&hellip;
          </div>
        )}
      </div>

      {error && (
        <div style={{ background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', color: 'var(--co-crit)', borderRadius: 8, padding: '10px 14px', fontSize: 13 }}>
          Error loading replication data: {error}
        </div>
      )}

      {!error && data?.scanning && (
        <div style={{ background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.3)', color: 'var(--co-info)', borderRadius: 8, padding: '10px 14px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Spinner size={15} />
          Scanning all protection groups for replication data. This may take a few minutes on first load.
          {data?.cacheAgeSeconds != null && ` Data is ${humanizeMinutes(Math.round(data.cacheAgeSeconds / 60))} old.`}
        </div>
      )}

      <div className="grid grid-cols-2 xl:grid-cols-5" style={{ gap: 12 }}>
        <StatCard label="Total Replications" value={totalCount} />
        <StatCard label="Active" value={activeCount} tone="info" />
        <StatCard label="Completed" value={completedCount} tone="ok" />
        <StatCard label="Failed" value={failedCount} tone={failedCount > 0 ? 'crit' : 'default'} />
        <StatCard label="Groups Scanned" value={groupsScanned} />
      </div>

      <div className="panel" style={{ padding: 16 }}>
        <p className="panel-title" style={{ marginBottom: 12 }}>Replication Status</p>

        {loading && !data ? (
          <div style={{ padding: '24px 0', textAlign: 'center' }}><Spinner size={20} /></div>
        ) : totalCount === 0 ? (
          <div style={{ textAlign: 'center', padding: '32px 0', fontSize: 12, color: 'var(--co-ink-muted)' }}>
            {data?.scanning ? 'Scan in progress — data will appear shortly. Use the refresh button to check.' : 'No replication data found for the selected filters.'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 11, color: 'var(--co-ink-muted)' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--co-border)' }}>
                  {COLS.map((col) => (
                    <th
                      key={col.key}
                      onClick={() => { if (!UNSORTABLE.has(col.key)) handleSort(col.key); }}
                      title={col.tooltip}
                      style={{
                        textAlign: col.align, padding: '8px', fontWeight: 500, whiteSpace: 'nowrap',
                        cursor: UNSORTABLE.has(col.key) ? 'default' : 'pointer',
                        color: sortBy === col.key ? 'var(--co-brand)' : 'var(--co-ink-muted)',
                      }}
                    >
                      {col.label}{' '}
                      {sortBy === col.key ? (sortDir === 'desc' ? '▼' : '▲') : <span style={{ color: 'var(--co-ink-faint)' }}>⇅</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedReplications.map((rep, i) => (
                  <tr key={rep.runId ?? i} style={{ background: i % 2 === 0 ? 'rgba(11,16,21,0.4)' : 'transparent' }}>
                    <td className="truncate" style={{ padding: '6px 8px', maxWidth: 150 }}>{rep.jobName || '—'}</td>
                    <td className="truncate" style={{ padding: '6px 8px', maxWidth: 120 }}>{rep.targetCluster || '—'}</td>
                    <td style={{ padding: '6px 8px' }}><Badge tone={STATUS_TONE[rep.status] || 'neutral'}>{rep.status}</Badge></td>
                    <td style={{ padding: '6px 8px', color: 'var(--co-ink-faint)', fontSize: 10, whiteSpace: 'nowrap' }}>{fmtDateTime(rep.replicationStartTimeUsecs)}</td>
                    <td className="tnum" style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtBytes(rep.logicalSizeBytes)}</td>
                    <td className="tnum" style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtBytes(rep.logicalBytesTransferred)}</td>
                    <td style={{ padding: '6px 8px' }}>
                      <div style={{ height: 6, background: 'rgba(11,16,21,0.6)', borderRadius: 999, overflow: 'hidden' }}>
                        <div style={{ height: '100%', borderRadius: 999, width: `${Math.min(rep.percentComplete || 0, 100)}%`, background: progressColor(rep.percentComplete || 0) }} />
                      </div>
                    </td>
                    <td className="tnum" style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--co-brand)', fontWeight: 500 }} title="logicalBytesTransferred / logicalSizeBytes">
                      {rep.percentComplete ? `${rep.percentComplete.toFixed(2)}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
