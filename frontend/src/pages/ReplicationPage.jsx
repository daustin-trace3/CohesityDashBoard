import { useEffect, useState, useCallback } from 'react';
import { ArrowLeftRight, ChevronDown, ChevronUp, ChevronsUpDown, RefreshCw, Search } from 'lucide-react';
import client from '../api/client';
import { PageHeader, Spinner, StatCard, Badge, LastUpdated, RefreshButton, humanizeMinutes } from '../components/ui/primitives';
import { useToast } from '../components/ui/Toaster';
import SkeletonTable from '../components/SkeletonTable';
import Pagination from '../components/Pagination';
import ReplicationFlows from '../components/cohesity/ReplicationFlows';

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatDateTime(usecs) {
  if (!usecs) return '-';
  return new Date(usecs / 1000).toLocaleString();
}

function formatDuration(secs) {
  if (secs == null) return '-';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h < 48) return `${h}h ${m}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function statusTone(status) {
  if (status === 'Running') return 'info';
  if (status === 'Succeeded') return 'ok';
  if (status === 'Failed') return 'crit';
  if (status === 'Canceled' || status === 'Skipped') return 'warn';
  return 'neutral';
}

function getProgressClass(percent) {
  if (percent > 90) return 'bg-cohesity-green';
  if (percent > 50) return 'bg-yellow-400';
  return 'bg-red-400';
}

const STATUS_CHIPS = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running', status: 'Running' },
  { key: 'failed', label: 'Failed', status: 'Failed' },
  { key: 'canceled', label: 'Canceled', status: 'Canceled' },
  { key: 'skipped', label: 'Skipped', status: 'Skipped' },
  { key: 'succeeded', label: 'Succeeded', status: 'Succeeded' },
];

const COLUMNS = [
  { key: 'jobName', label: 'Job Name', align: 'left' },
  { key: 'targetCluster', label: 'Target Cluster', align: 'left' },
  { key: 'status', label: 'Status', align: 'left', tooltip: 'Running, then failed, canceled, skipped, succeeded' },
  { key: 'startTime', label: 'Start Time', align: 'left' },
  { key: 'queued', label: 'Queued', align: 'right', tooltip: 'Time between the task being queued and starting to move data' },
  { key: 'duration', label: 'Duration', align: 'right', tooltip: 'Replication end minus start; elapsed so far for running tasks' },
  { key: 'dataToSend', label: 'Data to Send', align: 'right' },
  { key: 'dataSent', label: 'Data Sent', align: 'right' },
  { key: 'progress', label: 'Progress', align: 'center', sortable: false },
  { key: 'percentComplete', label: 'Logical Transfer Ratio', align: 'right', tooltip: 'Computed as logicalBytesTransferred / logicalSizeBytes. May differ from Cohesity UI percent.' },
];

const chipCls = (on) => `text-xs px-3 py-1.5 rounded font-medium transition-colors ${
  on ? 'bg-cohesity-green text-white' : 'bg-cohesity-gray text-cohesity-text hover:bg-cohesity-border'
}`;

export default function ReplicationPage() {
  const { toast } = useToast();
  const [clusters, setClusters] = useState([]);
  const [selectedCluster, setSelectedCluster] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [daysFilter, setDaysFilter] = useState(7);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sortBy, setSortBy] = useState('default');
  const [sortDir, setSortDir] = useState('desc');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  // Fetch clusters on mount
  useEffect(() => {
    const fetchClusters = async () => {
      try {
        const res = await client.get('/cohesity/clusters');
        const cohesityClusters = res.data || [];
        setClusters(cohesityClusters);
        if (cohesityClusters.length > 0) {
          setSelectedCluster(cohesityClusters[0].name);
        }
      } catch {
        // silently fail
      }
    };
    fetchClusters();
  }, []);

  // Debounce the search box into the query the server sees.
  useEffect(() => {
    const t = setTimeout(() => { setQ(search.trim()); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  // Fetch one page of replication data. Filtering, sorting and paging happen
  // on the server; the summary covers the whole window.
  const fetchReplicationData = useCallback(async () => {
    if (!selectedCluster) return;

    setLoading(true);
    setError(null);
    try {
      const params = {
        clusterName: selectedCluster,
        statusFilter,
        q: q || undefined,
        days: daysFilter,
        numRunsPerGroup: 20,
        sortBy,
        sortDir,
        page,
        pageSize,
      };
      const res = await client.get('/cohesity/replication/status', { params, timeout: 300000 });
      setData(res.data);
      setLastRefreshed(new Date());
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Request failed';
      setError(msg);
      toast({ type: 'error', title: 'Replication fetch failed', message: msg });
    } finally {
      setLoading(false);
    }
  }, [selectedCluster, statusFilter, q, daysFilter, sortBy, sortDir, page, pageSize]);

  // Initial fetch and auto-refresh
  useEffect(() => {
    fetchReplicationData();
  }, [fetchReplicationData]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchReplicationData, 30000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchReplicationData]);

  useEffect(() => {
    if (!data?.scanning) return;
    const interval = setInterval(fetchReplicationData, 15000);
    return () => clearInterval(interval);
  }, [data?.scanning, fetchReplicationData]);

  const summary = data?.summary || {};
  const byStatus = summary.byStatus || {};
  const pageInfo = data?.page || { page: 0, pageSize, total: 0, totalPages: 1 };
  const rows = data?.replications || [];
  const groupsScanned = data?.totalGroupsScanned || 0;
  const wireRatio = summary.physicalBytesTransferred > 0
    ? (summary.logicalBytesTransferred / summary.physicalBytesTransferred).toFixed(1)
    : null;

  const selectedClusterId = (clusters.find(c => c.name === selectedCluster) || {}).id || null;
  const byTarget = summary.byTarget || [];

  const changeCluster = (name) => { setSelectedCluster(name); setPage(0); };
  const changeStatus = (key) => { setStatusFilter(key); setPage(0); };
  const changeDays = (d) => { setDaysFilter(d); setPage(0); };
  const changePageSize = (s) => { setPageSize(s); setPage(0); };

  const handleSort = (col) => {
    if (col.sortable === false) return;
    if (sortBy === col.key) {
      setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
    } else {
      setSortBy(col.key);
      setSortDir(col.key === 'jobName' || col.key === 'targetCluster' || col.key === 'status' ? 'asc' : 'desc');
    }
    setPage(0);
  };

  const resetSort = () => { setSortBy('default'); setSortDir('desc'); setPage(0); };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={ArrowLeftRight}
        title="Replication"
        description="Live replication task status, lag, and throughput per cluster"
      />
      {/* Controls Row */}
      <div className="sticky top-0 z-10 bg-cohesity-black py-2 border-b border-cohesity-border">
        <div className="flex flex-wrap gap-4 items-center mb-4">
          {/* Cluster Selector */}
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-400">Cluster:</label>
            <select
              className="bg-cohesity-gray border border-cohesity-border text-cohesity-text text-xs rounded px-2 py-1.5 focus:outline-none"
              value={selectedCluster}
              onChange={e => changeCluster(e.target.value)}
            >
              <option value="">Select cluster...</option>
              {clusters.map(c => (
                <option key={c.id} value={c.name}>{c.name}</option>
              ))}
            </select>
          </div>

          {/* Status Filter */}
          <div className="flex gap-1 flex-wrap">
            {STATUS_CHIPS.map(chip => {
              const n = chip.status ? (byStatus[chip.status] || 0) : summary.total;
              return (
                <button key={chip.key} onClick={() => changeStatus(chip.key)} className={chipCls(statusFilter === chip.key)}>
                  {chip.label}{n != null && data ? <span className="ml-1 opacity-70 tnum">{n}</span> : null}
                </button>
              );
            })}
          </div>

          {/* Days Filter */}
          <div className="flex gap-1">
            {[7, 14, 30].map(d => (
              <button key={d} onClick={() => changeDays(d)} className={chipCls(daysFilter === d)}>
                {d}d
              </button>
            ))}
          </div>

          {/* Search */}
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Job or target..."
              className="bg-cohesity-gray border border-cohesity-border text-cohesity-text text-xs rounded pl-6 pr-2 py-1.5 w-48 focus:outline-none focus:border-cohesity-green"
            />
          </div>

          {/* Auto-Refresh Toggle */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={`w-8 h-8 rounded-full transition-colors flex items-center justify-center ${
                autoRefresh
                  ? 'bg-cohesity-green text-white'
                  : 'bg-cohesity-gray text-gray-400 hover:bg-cohesity-border'
              }`}
              title={autoRefresh ? 'Auto-refresh on (30s)' : 'Auto-refresh off'}
            >
              <RefreshCw size={14} className={autoRefresh ? 'animate-spin' : ''} />
            </button>
            {autoRefresh && <span className="w-2 h-2 bg-cohesity-green rounded-full animate-pulse" />}
          </div>

          {/* Manual Refresh */}
          <RefreshButton onClick={fetchReplicationData} refreshing={loading} label="Refresh" size="sm" />

          {/* Last Refreshed */}
          <LastUpdated date={lastRefreshed} prefix="Last refreshed" />
        </div>

        {loading && (
          <div className="flex items-center gap-1.5 text-xs text-ink-muted" role="status"><Spinner size={13} /> Loading replication data...</div>
        )}
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700 text-red-400 rounded-lg px-4 py-3 text-sm">
          Error loading replication data: {error}
        </div>
      )}

      {!error && data?.scanning && (
        <div className="bg-blue-900/30 border border-blue-700 text-blue-400 rounded-lg px-4 py-3 text-sm flex items-center gap-2">
          <Spinner size={14} className="text-blue-400" />
          Scanning all protection groups for replication data. This may take a few minutes on first load.
          {data?.cacheAgeSeconds != null && ` Data is ${humanizeMinutes(Math.round(data.cacheAgeSeconds / 60))} old.`}
        </div>
      )}

      {/* Summary KPI Cards: whole window, not just the page shown */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <StatCard label="Running" value={summary.running ?? '-'} tone="info" />
        <StatCard label="Failed" value={summary.failed ?? '-'} tone={summary.failed > 0 ? 'crit' : 'default'} />
        <StatCard label="Canceled" value={summary.canceled ?? '-'} tone={summary.canceled > 0 ? 'warn' : 'default'} />
        <StatCard label="Skipped" value={summary.skipped ?? '-'} tone={summary.skipped > 0 ? 'warn' : 'default'} />
        <StatCard label="Succeeded" value={summary.succeeded ?? '-'} tone="ok" />
        <StatCard label="Total Replications" value={summary.total ?? '-'} sub={`last ${daysFilter} days`} />
      </div>
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <StatCard
          label="Data Sent"
          value={formatBytes(summary.logicalBytesTransferred)}
          sub="logical bytes replicated"
          tone="brand"
        />
        <StatCard
          label="On the Wire"
          value={formatBytes(summary.physicalBytesTransferred)}
          sub={wireRatio ? `${wireRatio} : 1 logical to physical` : 'physical bytes sent'}
        />
        <StatCard
          label="Longest Running"
          value={summary.longestRunning ? formatDuration(summary.longestRunning.seconds) : '-'}
          sub={summary.longestRunning
            ? `${summary.longestRunning.jobName} to ${summary.longestRunning.targetCluster}${summary.longestRunning.percentComplete != null ? `, ${summary.longestRunning.percentComplete.toFixed(0)}%` : ''}`
            : 'nothing in flight'}
          tone={summary.longestRunning && summary.longestRunning.seconds > 86400 ? 'warn' : 'default'}
        />
        <StatCard
          label="Groups Replicating"
          value={summary.groupsWithReplication ?? '-'}
          sub={`of ${groupsScanned} protection groups scanned`}
        />
      </div>

      {/* Replication Table */}
      <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4">
        <div className="flex items-center justify-between gap-2 mb-3">
          <p className="text-xs font-semibold text-cohesity-text">Replication Status</p>
          {sortBy !== 'default' && (
            <button onClick={resetSort} className="text-[11px] text-ink-muted hover:text-brand">
              Reset to default order
            </button>
          )}
        </div>

        {loading && !data ? (
          <SkeletonTable rows={6} colWidths={['w-32', 'w-28', 'w-16', 'w-28', 'w-14', 'w-16', 'w-20', 'w-20', 'w-24', 'w-16']} />
        ) : pageInfo.total === 0 ? (
          <div className="text-center py-8 text-xs text-gray-400">
            {data?.scanning ? 'Scan in progress. Data will appear shortly; use the refresh button to check.' : 'No replication data found for the selected filters.'}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px] text-gray-400">
                <thead className="sticky top-0 bg-cohesity-gray">
                  <tr className="border-b border-cohesity-border">
                    {COLUMNS.map(col => {
                      const sortable = col.sortable !== false;
                      const active = sortBy === col.key;
                      return (
                        <th
                          key={col.key}
                          className={`${col.align === 'left' ? 'text-left' : col.align === 'right' ? 'text-right' : 'text-center'} px-2 py-2 font-medium ${
                            sortable ? 'cursor-pointer hover:text-cohesity-text' : ''
                          } ${active ? 'text-cohesity-green' : ''}`}
                          onClick={() => handleSort(col)}
                          title={col.tooltip}
                        >
                          <span className="inline-flex items-center gap-1">
                            {col.label}
                            {sortable && (active
                              ? (sortDir === 'desc' ? <ChevronDown size={11} /> : <ChevronUp size={11} />)
                              : <ChevronsUpDown size={11} className="text-gray-600" />)}
                          </span>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((rep, i) => (
                    <tr key={`${rep.runId}:${rep.targetCluster}`} className={i % 2 === 0 ? 'bg-cohesity-black/40' : ''}>
                      <td className="px-2 py-1.5 truncate max-w-[220px]" title={rep.jobName}>{rep.jobName || '-'}</td>
                      <td className="px-2 py-1.5 truncate max-w-[140px]">{rep.targetCluster || '-'}</td>
                      <td className="px-2 py-1.5">
                        <span title={rep.message || undefined} className={rep.message ? 'cursor-help' : ''}>
                          <Badge tone={statusTone(rep.status)}>{rep.status}</Badge>
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-gray-500 text-[10px] whitespace-nowrap">
                        {formatDateTime(rep.replicationStartTimeUsecs)}
                      </td>
                      <td className="text-right px-2 py-1.5 tnum whitespace-nowrap">{formatDuration(rep.queueSeconds)}</td>
                      <td className="text-right px-2 py-1.5 tnum whitespace-nowrap">{formatDuration(rep.durationSeconds)}</td>
                      <td className="text-right px-2 py-1.5 tnum">{formatBytes(rep.logicalSizeBytes)}</td>
                      <td className="text-right px-2 py-1.5 tnum">{formatBytes(rep.logicalBytesTransferred)}</td>
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-3 bg-cohesity-black/60 rounded-full overflow-hidden">
                            <div
                              className={`h-full ${getProgressClass(rep.percentComplete || 0)}`}
                              style={{ width: `${Math.min(rep.percentComplete || 0, 100)}%` }}
                            />
                          </div>
                        </div>
                      </td>
                      <td className="text-right px-2 py-1.5 text-cohesity-green font-medium tnum" title="logicalBytesTransferred / logicalSizeBytes">
                        {rep.percentComplete != null ? `${rep.percentComplete.toFixed(2)}%` : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={pageInfo.page}
              totalPages={pageInfo.totalPages}
              pageSize={pageInfo.pageSize}
              totalItems={pageInfo.total}
              onPage={setPage}
              onPageSize={changePageSize}
            />
          </>
        )}
      </div>

      {/* Per-target rollup for the selected cluster, whole window */}
      {byTarget.length > 0 && (
        <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4">
          <p className="text-xs font-semibold text-cohesity-text mb-3">By Target Cluster</p>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] text-gray-400">
              <thead>
                <tr className="border-b border-cohesity-border">
                  <th className="text-left px-2 py-2 font-medium">Target</th>
                  <th className="text-right px-2 py-2 font-medium">Replications</th>
                  <th className="text-right px-2 py-2 font-medium">Running</th>
                  <th className="text-right px-2 py-2 font-medium" title="Failed, canceled or skipped">Not Completed</th>
                  <th className="text-right px-2 py-2 font-medium">Succeeded</th>
                  <th className="text-right px-2 py-2 font-medium">Data Sent</th>
                  <th className="text-right px-2 py-2 font-medium">On the Wire</th>
                </tr>
              </thead>
              <tbody>
                {byTarget.map((t, i) => (
                  <tr key={t.targetCluster} className={i % 2 === 0 ? 'bg-cohesity-black/40' : ''}>
                    <td className="px-2 py-1.5">{t.targetCluster}</td>
                    <td className="text-right px-2 py-1.5 tnum">{t.total}</td>
                    <td className="text-right px-2 py-1.5 tnum text-blue-400">{t.running}</td>
                    <td className={`text-right px-2 py-1.5 tnum ${t.failed > 0 ? 'text-red-400' : ''}`}>{t.failed}</td>
                    <td className="text-right px-2 py-1.5 tnum text-green-400">{t.succeeded}</td>
                    <td className="text-right px-2 py-1.5 tnum">{formatBytes(t.logicalBytesTransferred)}</td>
                    <td className="text-right px-2 py-1.5 tnum">{formatBytes(t.physicalBytesTransferred)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Flows across the estate from polled run history (moved from Analytics) */}
      <ReplicationFlows clusterId={selectedClusterId} days={daysFilter} />
    </div>
  );
}
