import { useEffect, useState, useCallback, useMemo } from 'react';
import client from '../api/client';

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatDateTime(usecs) {
  if (!usecs) return '—';
  const ms = usecs / 1000;
  const date = new Date(ms);
  return date.toLocaleString();
}

function statusBadgeColor(status) {
  if (status === 'Running') return 'bg-blue-500/20 text-blue-400';
  if (status === 'Succeeded') return 'bg-green-500/20 text-green-400';
  if (status === 'Failed') return 'bg-red-500/20 text-red-400';
  if (status === 'Canceled') return 'bg-red-500/20 text-red-400';
  return 'bg-gray-500/20 text-gray-400';
}

function getProgressColor(percent) {
  if (percent > 90) return '#6CB33F';
  if (percent > 50) return '#FBBF24';
  return '#EF4444';
}

function getProgressClass(percent) {
  if (percent > 90) return 'bg-cohesity-green';
  if (percent > 50) return 'bg-yellow-400';
  return 'bg-red-400';
}

function StatCard({ label, value, valueClass = 'text-cohesity-text' }) {
  return (
    <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4">
      <p className="text-xs text-gray-400 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${valueClass}`}>{value}</p>
    </div>
  );
}

export default function ReplicationPage() {
  const [clusters, setClusters] = useState([]);
  const [selectedCluster, setSelectedCluster] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [daysFilter, setDaysFilter] = useState(7);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sortBy, setSortBy] = useState('percentComplete');
  const [sortDir, setSortDir] = useState('desc');

  // Fetch clusters on mount
  useEffect(() => {
    const fetchClusters = async () => {
      try {
        const res = await client.get('/clusters');
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

  // Fetch replication data
  const fetchReplicationData = useCallback(async () => {
    if (!selectedCluster) return;
    
    setLoading(true);
    setError(null);
    try {
      const params = {
        clusterName: selectedCluster,
        statusFilter,
        days: daysFilter,
        numRunsPerGroup: 20,
      };
      const res = await client.get('/replication/status', { params, timeout: 300000 });
      setData(res.data);
      setLastRefreshed(new Date());
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Request failed');
    } finally {
      setLoading(false);
    }
  }, [selectedCluster, statusFilter, daysFilter]);

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


  // Calculate summary metrics
  const replications = data?.replications || [];
  const totalCount = replications.length;
  const activeCount = replications.filter(r => r.status === 'Running').length;
  const completedCount = replications.filter(r => r.status === 'Succeeded').length;
  const failedCount = replications.filter(r => r.status === 'Failed' || r.status === 'Canceled').length;
  const groupsScanned = data?.totalGroupsScanned || 0;

  // Sort replications
  const sortedReplications = useMemo(() => {
    const sorted = [...replications];
    const dir = sortDir === 'desc' ? -1 : 1;
    sorted.sort((a, b) => {
      let aVal, bVal;
      if (sortBy === 'jobName') {
        aVal = (a.jobName || '').toLowerCase();
        bVal = (b.jobName || '').toLowerCase();
        return dir * aVal.localeCompare(bVal);
      }
      if (sortBy === 'targetCluster') {
        aVal = (a.targetCluster || '').toLowerCase();
        bVal = (b.targetCluster || '').toLowerCase();
        return dir * aVal.localeCompare(bVal);
      }
      if (sortBy === 'status') {
        aVal = a.status || '';
        bVal = b.status || '';
        return dir * aVal.localeCompare(bVal);
      }
      if (sortBy === 'startTime') {
        aVal = a.replicationStartTimeUsecs || 0;
        bVal = b.replicationStartTimeUsecs || 0;
        return dir * (aVal - bVal);
      }
      if (sortBy === 'percentComplete') {
        aVal = a.percentComplete || 0;
        bVal = b.percentComplete || 0;
        return dir * (aVal - bVal);
      }
      return 0;
    });
    return sorted;
  }, [replications, sortBy, sortDir]);

  const handleSort = (col) => {
    if (sortBy === col) {
      setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
    } else {
      setSortBy(col);
      setSortDir('desc');
    }
  };

  const formatRefreshedTime = () => {
    if (!lastRefreshed) return 'Never';
    const now = new Date();
    const diff = Math.floor((now - lastRefreshed) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  };

  return (
    <div className="p-4 space-y-6">
      {/* Controls Row */}
      <div className="sticky top-0 z-10 bg-cohesity-black py-2 border-b border-cohesity-border">
        <div className="flex flex-wrap gap-4 items-center mb-4">
          {/* Cluster Selector */}
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-400">Cluster:</label>
            <select
              className="bg-cohesity-gray border border-cohesity-border text-cohesity-text text-xs rounded px-2 py-1.5 focus:outline-none"
              value={selectedCluster}
              onChange={e => setSelectedCluster(e.target.value)}
            >
              <option value="">Select cluster...</option>
              {clusters.map(c => (
                <option key={c.id} value={c.name}>{c.name}</option>
              ))}
            </select>
          </div>

          {/* Status Filter */}
          <div className="flex gap-1">
            {['all', 'active', 'failed'].map(status => (
              <button
                key={status}
                onClick={() => setStatusFilter(status)}
                className={`text-xs px-3 py-1.5 rounded font-medium transition-colors capitalize ${
                  statusFilter === status
                    ? 'bg-cohesity-green text-white'
                    : 'bg-cohesity-gray text-cohesity-text hover:bg-cohesity-border'
                }`}
              >
                {status === 'all' ? 'All' : status === 'active' ? 'Active' : 'Failed'}
              </button>
            ))}
          </div>

          {/* Days Filter */}
          <div className="flex gap-1">
            {[7, 14, 30].map(d => (
              <button
                key={d}
                onClick={() => setDaysFilter(d)}
                className={`text-xs px-3 py-1.5 rounded font-medium transition-colors ${
                  daysFilter === d
                    ? 'bg-cohesity-green text-white'
                    : 'bg-cohesity-gray text-cohesity-text hover:bg-cohesity-border'
                }`}
              >
                {d}d
              </button>
            ))}
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
              <span className={autoRefresh ? 'animate-spin' : ''}>↻</span>
            </button>
            {autoRefresh && <span className="w-2 h-2 bg-cohesity-green rounded-full animate-pulse" />}
          </div>

          {/* Manual Refresh */}
          <button
            onClick={fetchReplicationData}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded bg-cohesity-green hover:bg-green-600 text-white font-medium transition-colors disabled:opacity-50"
          >
            Refresh
          </button>

          {/* Last Refreshed */}
          <div className="text-xs text-gray-400">
            Last refreshed: {formatRefreshedTime()}
          </div>
        </div>

        {loading && (
          <div className="text-xs text-cohesity-green animate-pulse">Loading replication data...</div>
        )}
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700 text-red-400 rounded-lg px-4 py-3 text-sm">
          Error loading replication data: {error}
        </div>
      )}

      {!error && data?.scanning && (
        <div className="bg-blue-900/30 border border-blue-700 text-blue-400 rounded-lg px-4 py-3 text-sm flex items-center gap-2">
          <svg className="animate-spin h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
          Scanning all protection groups for replication data. This may take a few minutes on first load.
          {data?.cacheAgeSeconds != null && ` Data is ${Math.round(data.cacheAgeSeconds / 60)} min old.`}
        </div>
      )}

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-2 xl:grid-cols-5 gap-3">
        <StatCard label="Total Replications" value={totalCount} />
        <StatCard label="Active" value={activeCount} valueClass="text-blue-400" />
        <StatCard label="Completed" value={completedCount} valueClass="text-green-400" />
        <StatCard label="Failed" value={failedCount} valueClass="text-red-400" />
        <StatCard label="Groups Scanned" value={groupsScanned} />
      </div>

      {/* Replication Table */}
      <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4">
        <p className="text-xs font-semibold text-cohesity-text mb-3">Replication Status</p>
        
        {totalCount === 0 ? (
          <div className="text-center py-8 text-xs text-gray-400">
            {data?.scanning ? 'Scan in progress — data will appear shortly. Use the refresh button to check.' : 'No replication data found for the selected filters.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] text-gray-400">
              <thead className="sticky top-0 bg-cohesity-gray">
                <tr className="border-b border-cohesity-border">
                  {[
                    { key: 'jobName', label: 'Job Name', align: 'left' },
                    { key: 'targetCluster', label: 'Target Cluster', align: 'left' },
                    { key: 'status', label: 'Status', align: 'left' },
                    { key: 'startTime', label: 'Start Time', align: 'left' },
                    { key: 'dataToSend', label: 'Data to Send', align: 'right' },
                    { key: 'dataSent', label: 'Data Sent', align: 'right' },
                    { key: 'progress', label: 'Progress', align: 'center' },
                    { key: 'percentComplete', label: '% Done', align: 'right' },
                  ].map(col => (
                    <th
                      key={col.key}
                      className={`${col.align === 'left' ? 'text-left' : col.align === 'right' ? 'text-right' : 'text-center'} px-2 py-2 font-medium cursor-pointer hover:text-cohesity-text ${
                        sortBy === col.key ? 'text-cohesity-green' : ''
                      }`}
                      onClick={() => {
                        if (col.key !== 'progress' && col.key !== 'dataToSend' && col.key !== 'dataSent') {
                          handleSort(col.key);
                        }
                      }}
                    >
                      {col.label}{' '}
                      {sortBy === col.key ? (sortDir === 'desc' ? '▼' : '▲') : <span className="text-gray-600">⇅</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedReplications.map((rep, i) => (
                  <tr key={`${rep.runId}`} className={i % 2 === 0 ? 'bg-cohesity-black/40' : ''}>
                    <td className="px-2 py-1.5 truncate max-w-[150px]">{rep.jobName || '—'}</td>
                    <td className="px-2 py-1.5 truncate max-w-[120px]">{rep.targetCluster || '—'}</td>
                    <td className="px-2 py-1.5">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${statusBadgeColor(rep.status)}`}>
                        {rep.status}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-gray-500 text-[10px]">
                      {formatDateTime(rep.replicationStartTimeUsecs)}
                    </td>
                    <td className="text-right px-2 py-1.5">{formatBytes(rep.logicalSizeBytes)}</td>
                    <td className="text-right px-2 py-1.5">{formatBytes(rep.logicalBytesTransferred)}</td>
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
                    <td className="text-right px-2 py-1.5 text-cohesity-green font-medium">
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
