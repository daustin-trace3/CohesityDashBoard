import { useEffect, useState, useCallback } from 'react';
import { Activity } from 'lucide-react';
import client from '../api/client';
import { Bar } from 'react-chartjs-2';
import { PageHeader, Spinner, StatCard, LastUpdated, RefreshButton } from '../components/ui/primitives';
import { useToast } from '../components/ui/Toaster';

// Helper functions
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function successColor(rate) {
  if (rate >= 90) return 'text-green-400';
  if (rate >= 70) return 'text-yellow-400';
  return 'text-red-400';
}

const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  plugins: {
    legend: {
      labels: { color: '#E5E5E5', font: { size: 11 } }
    },
    tooltip: {
      backgroundColor: '#2C2C2C',
      borderColor: '#3D3D3D',
      borderWidth: 1,
      titleColor: '#E5E5E5',
      bodyColor: '#9ca3af',
    }
  },
  scales: {
    x: {
      ticks: { color: '#E5E5E5', font: { size: 10 } },
      grid: { color: 'rgba(255,255,255,0.1)' }
    },
    y: {
      ticks: { color: '#E5E5E5', font: { size: 10 } },
      grid: { color: 'rgba(255,255,255,0.1)' }
    }
  }
};

function SectionHeading({ children }) {
  return (
    <h2 className="text-sm font-semibold text-cohesity-text uppercase tracking-wider mb-3 mt-1">
      {children}
    </h2>
  );
}

export default function AnalyticsPage() {
  const { toast } = useToast();
  const [days, setDays] = useState(1);
  const [clusterId, setClusterId] = useState('');
  const [clusters, setClusters] = useState([]);
  const [backup, setBackup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [clusterSort, setClusterSort] = useState('total');
  const [clusterSortDir, setClusterSortDir] = useState('desc');

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const params = { days };
      if (clusterId) params.clusterId = clusterId;
      const bRes = await client.get('/cohesity/analytics/protection-runs', { params });
      setBackup(bRes.data);
      setLastRefreshed(new Date());
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Request failed';
      toast({ type: 'error', title: 'Analytics fetch failed', message: msg });
    } finally {
      setLoading(false);
    }
  }, [days, clusterId, toast]);

  useEffect(() => {
    client.get('/cohesity/analytics/clusters')
      .then(r => setClusters(r.data || []))
      .catch(() => {});
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // --- Backup chart data ---
  const byDay = backup?.byDay || [];
  const jobTrendData = {
    labels: byDay.map(d => {
      const dt = new Date(d.date);
      return `${dt.getMonth() + 1}/${dt.getDate()}`;
    }),
    datasets: [
      { label: 'Success', data: byDay.map(d => d.success), backgroundColor: '#6CB33F', stack: 'a' },
      { label: 'Failure', data: byDay.map(d => d.failure), backgroundColor: '#ef4444', stack: 'a' },
      { label: 'Warning', data: byDay.map(d => d.warning), backgroundColor: '#f59e0b', stack: 'a' },
    ]
  };
  const jobTrendOptions = {
    ...CHART_DEFAULTS,
    scales: {
      ...CHART_DEFAULTS.scales,
      x: { ...CHART_DEFAULTS.scales.x, stacked: true },
      y: { ...CHART_DEFAULTS.scales.y, stacked: true }
    }
  };

  const topErrors = (backup?.topErrors || []).slice(0, 10);
  const topErrorData = {
    labels: topErrors.map(e => (e.errorMessage || e.errorCode || '').slice(0, 40)),
    datasets: [{
      label: 'Count',
      data: topErrors.map(e => e.count),
      backgroundColor: '#ef4444',
    }]
  };
  const topErrorOptions = {
    ...CHART_DEFAULTS,
    indexAxis: 'y',
    plugins: {
      ...CHART_DEFAULTS.plugins,
      legend: { display: false },
    },
    scales: {
      x: { ...CHART_DEFAULTS.scales.x },
      y: { ticks: { color: '#E5E5E5', font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.1)' } }
    }
  };

  const sortedByCluster = [...(backup?.byCluster || [])].sort((a, b) => {
    const dir = clusterSortDir === 'desc' ? -1 : 1;
    if (clusterSort === 'name') return dir * a.clusterName.localeCompare(b.clusterName);
    if (clusterSort === 'failure') return dir * (a.failure - b.failure);
    if (clusterSort === 'successRate') return dir * (a.successRate - b.successRate);
    return dir * (a.total - b.total);
  });

  const backupSummary = backup?.summary || {};

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Activity}
        title="Analytics"
        description="Backup job performance, SLA compliance and anomalies"
      />
      {/* Filter Bar */}
      <div className="sticky top-0 z-10 bg-cohesity-black py-2 flex flex-wrap gap-3 items-center border-b border-cohesity-border">
        <select
          className="bg-cohesity-gray border border-cohesity-border text-cohesity-text text-xs rounded px-2 py-1.5 focus:outline-none"
          value={clusterId}
          onChange={e => setClusterId(e.target.value)}
        >
          <option value="">All Clusters</option>
          {clusters.map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>

        <div className="flex gap-1">
          {[1, 7, 14, 30, 90].map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`text-xs px-3 py-1.5 rounded font-medium transition-colors cursor-pointer ${
                days === d
                  ? 'bg-cohesity-green text-white'
                  : 'bg-cohesity-gray text-cohesity-text hover:bg-cohesity-border'
              }`}
            >
              {d === 1 ? '24h' : `${d}d`}
            </button>
          ))}
        </div>

        <RefreshButton onClick={fetchAll} refreshing={loading} label="Refresh" size="sm" />
        <LastUpdated date={lastRefreshed} prefix="Last refreshed" />
        {loading && (
          <span className="flex items-center gap-1.5 text-xs text-ink-muted ml-2" role="status"><Spinner size={13} /> Loading analytics&hellip;</span>
        )}
      </div>

      {/* Section 2: Backup Job Analytics */}
      <div>
        <SectionHeading>Backup Job Analytics</SectionHeading>

        {/* Summary stat cards */}
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-4">
          <StatCard label="Total Runs" value={backupSummary.total ?? '—'} />
          <StatCard
            label="Success Rate"
            value={backupSummary.successRate != null ? `${backupSummary.successRate}%` : '—'}
            tone={backupSummary.successRate == null ? 'default' : backupSummary.successRate >= 90 ? 'ok' : backupSummary.successRate >= 70 ? 'warn' : 'crit'}
          />
          <StatCard label="Failed Runs" value={backupSummary.failure ?? '—'} tone={(backupSummary.failure ?? 0) > 0 ? 'crit' : 'ok'} />
          <StatCard label="Warning Runs" value={backupSummary.warning ?? '—'} tone={(backupSummary.warning ?? 0) > 0 ? 'warn' : 'default'} />
        </div>

        {backupSummary.total === 0 ? (
          <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-6 text-center text-xs text-gray-400">
            No backup run data available. Data will appear after the next poll cycle.
          </div>
        ) : (
          <>
            {/* Charts row */}
            <div className="grid xl:grid-cols-2 gap-3 mb-4">
              <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4">
                <p className="text-xs font-semibold text-cohesity-text mb-3">Job Performance Trend</p>
                <div style={{ height: 220 }}>
                  {byDay.length > 0 ? (
                    <Bar data={jobTrendData} options={jobTrendOptions} />
                  ) : (
                    <div className="flex items-center justify-center h-full text-gray-500 text-xs">No data</div>
                  )}
                </div>
              </div>
              <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4">
                <p className="text-xs font-semibold text-cohesity-text mb-3">Top Failure Reasons</p>
                <div style={{ height: 220 }}>
                  {topErrors.length > 0 ? (
                    <Bar data={topErrorData} options={topErrorOptions} />
                  ) : (
                    <div className="flex items-center justify-center h-full text-gray-500 text-xs">No errors recorded</div>
                  )}
                </div>
              </div>
            </div>

            {/* Protection Run Failures by Cluster table */}
            <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4">
              <p className="text-xs font-semibold text-cohesity-text mb-3">Protection Run Failures by Cluster</p>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] text-gray-400">
                  <thead className="sticky top-0 bg-cohesity-gray">
                    <tr className="border-b border-cohesity-border">
                      {[
                        { key: 'name', label: 'Cluster Name', align: 'left' },
                        { key: 'total', label: 'Total Runs', align: 'right' },
                        { key: 'failure', label: 'Failed', align: 'right' },
                        { key: 'successRate', label: 'Success Rate', align: 'right' },
                      ].map(col => (
                        <th
                          key={col.key}
                          className={`${col.align === 'left' ? 'text-left' : 'text-right'} px-2 py-2 font-medium cursor-pointer hover:text-cohesity-text ${clusterSort === col.key ? 'text-cohesity-green' : ''}`}
                          onClick={() => {
                            if (clusterSort === col.key) setClusterSortDir(d => d === 'desc' ? 'asc' : 'desc');
                            else { setClusterSort(col.key); setClusterSortDir('desc'); }
                          }}
                        >
                          {col.label}{' '}
                          {clusterSort === col.key
                            ? (clusterSortDir === 'desc' ? '▼' : '▲')
                            : <span className="text-gray-600">⇅</span>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedByCluster.map((row, i) => (
                      <tr key={row.clusterId || i} className={i % 2 === 0 ? 'bg-cohesity-black/40' : ''}>
                        <td className="px-2 py-1.5 truncate max-w-[180px]">{row.clusterName || row.clusterId}</td>
                        <td className="text-right px-2 py-1.5">{row.total}</td>
                        <td className="text-right px-2 py-1.5 text-red-400">{row.failure}</td>
                        <td className={`text-right px-2 py-1.5 font-medium ${successColor(row.successRate)}`}>
                          {row.successRate != null ? `${row.successRate}%` : '—'}
                        </td>
                      </tr>
                    ))}
                    {sortedByCluster.length === 0 && (
                      <tr><td colSpan={4} className="text-center py-4 text-gray-500">No data</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
