import { useEffect, useState, useCallback, useMemo } from 'react';
import client from '../api/client';
import { Bar } from 'react-chartjs-2';

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

function statusBadgeColor(status) {
  if (status === 'kSuccess') return 'bg-green-500/20 text-green-400';
  if (status === 'kWarning') return 'bg-yellow-500/20 text-yellow-400';
  if (status === 'kRunning') return 'bg-blue-500/20 text-blue-400';
  return 'bg-red-500/20 text-red-400';
}

function riskBadgeColor(riskScore) {
  if (riskScore >= 50) return 'bg-red-500/20 text-red-400';
  if (riskScore >= 25) return 'bg-yellow-500/20 text-yellow-400';
  return 'bg-green-500/20 text-green-400';
}

function slaBadgeColor(state) {
  if (state === 'compliant') return 'bg-green-500/20 text-green-400';
  if (state === 'nearing_breach') return 'bg-yellow-500/20 text-yellow-400';
  return 'bg-red-500/20 text-red-400';
}

function formatDuration(seconds) {
  if (!seconds || seconds === 0) return '0 s';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} m`;
  return `${(seconds / 3600).toFixed(1)} h`;
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

function StatCard({ label, value, valueClass = 'text-cohesity-text' }) {
  return (
    <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4">
      <p className="text-xs text-gray-400 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${valueClass}`}>{value}</p>
    </div>
  );
}

function SectionHeading({ children }) {
  return (
    <h2 className="text-sm font-semibold text-cohesity-text uppercase tracking-wider mb-3 mt-1">
      {children}
    </h2>
  );
}

export default function DataProtectionPage() {
  const [days, setDays] = useState(7);
  const [clusterId, setClusterId] = useState('');
  const [clusters, setClusters] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [riskFilter, setRiskFilter] = useState('all');
  const [jobSort, setJobSort] = useState('riskScore');
  const [jobSortDir, setJobSortDir] = useState('desc');

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = { days };
      if (clusterId) params.clusterId = clusterId;
      const res = await client.get('/analytics/protection-runs', { params });
      setData(res.data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [days, clusterId]);

  useEffect(() => {
    client.get('/analytics/clusters')
      .then(r => setClusters(r.data || []))
      .catch(() => {});
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const summary = data?.summary || {};
  const statusBreakdown = data?.statusBreakdown || {};
  const atRiskJobs = data?.atRiskJobs || [];

  // Risk filtering
  const filteredAtRiskJobs = useMemo(() => {
    return atRiskJobs.filter(job => {
      if (riskFilter === 'failed') return job.lastStatus && ['kFailure', 'kFailed', 'kError', 'kCanceled', 'kCancelled'].includes(job.lastStatus);
      if (riskFilter === 'atrisk') return job.consecutiveFailures >= 2 || job.failureRate >= 20;
      if (riskFilter === 'nosuccess') return job.hoursSinceLastSuccess && job.hoursSinceLastSuccess >= 24;
      return true;
    });
  }, [atRiskJobs, riskFilter]);

  // Sorting
  const sortedAtRiskJobs = useMemo(() => {
    const arr = [...filteredAtRiskJobs];
    const dir = jobSortDir === 'desc' ? -1 : 1;
    arr.sort((a, b) => {
      if (jobSort === 'name') return dir * (a.jobName || '').localeCompare(b.jobName || '');
      if (jobSort === 'cluster') return dir * (a.clusterName || '').localeCompare(b.clusterName || '');
      if (jobSort === 'lastStatus') return dir * (a.lastStatus || '').localeCompare(b.lastStatus || '');
      if (jobSort === 'consecutiveFailures') return dir * (a.consecutiveFailures - b.consecutiveFailures);
      if (jobSort === 'failureRate') return dir * (a.failureRate - b.failureRate);
      if (jobSort === 'hoursSinceLastSuccess') return dir * ((a.hoursSinceLastSuccess || 0) - (b.hoursSinceLastSuccess || 0));
      if (jobSort === 'lastRunTime') return dir * (new Date(a.lastRunTime || 0) - new Date(b.lastRunTime || 0));
      return dir * (a.riskScore - b.riskScore);
    });
    return arr;
  }, [filteredAtRiskJobs, jobSort, jobSortDir]);

  // Chart data: status breakdown
  const statusLabels = ['Success', 'Failure', 'Warning', 'Running', 'Other'];
  const statusValues = [statusBreakdown.kSuccess || 0, statusBreakdown.kFailure || 0, statusBreakdown.kWarning || 0, statusBreakdown.kRunning || 0, statusBreakdown.other || 0];
  const statusChartData = {
    labels: statusLabels,
    datasets: [{
      label: 'Count',
      data: statusValues,
      backgroundColor: ['#6CB33F', '#ef4444', '#f59e0b', '#3b82f6', '#8b5cf6'],
    }]
  };
  const statusChartOptions = {
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

  // Chart data: top failure reasons from backend topErrors
  const topErrors = data?.topErrors || [];
  const failureChartData = {
    labels: topErrors.map(e => (e.errorMessage || 'Unknown').slice(0, 40)),
    datasets: [{
      label: 'Count',
      data: topErrors.map(e => e.count),
      backgroundColor: '#ef4444',
    }]
  };
  const failureChartOptions = {
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

  const atRiskJobCount = atRiskJobs.filter(j => j.consecutiveFailures >= 2 || j.failureRate >= 20).length;
  const noSuccessCount = atRiskJobs.filter(j => j.hoursSinceLastSuccess && j.hoursSinceLastSuccess >= 24).length;

  return (
    <div className="p-4 space-y-6">
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
              className={`text-xs px-3 py-1.5 rounded font-medium transition-colors ${
                days === d
                  ? 'bg-cohesity-green text-white'
                  : 'bg-cohesity-gray text-cohesity-text hover:bg-cohesity-border'
              }`}
            >
              {d}d
            </button>
          ))}
        </div>

        <button
          onClick={fetchData}
          className="text-xs px-3 py-1.5 rounded bg-cohesity-green hover:bg-cohesity-green-dark text-white font-medium transition-colors"
        >
          Refresh
        </button>

        {loading && (
          <span className="text-xs text-cohesity-green animate-pulse ml-2">Loading...</span>
        )}
      </div>

      {/* Risk Filter Chips */}
      <div className="flex flex-wrap gap-2">
        {[
          { key: 'all', label: 'All' },
          { key: 'failed', label: 'Failed' },
          { key: 'atrisk', label: 'At Risk' },
          { key: 'nosuccess', label: 'No Success 24h' },
        ].map(chip => (
          <button
            key={chip.key}
            onClick={() => setRiskFilter(chip.key)}
            className={`text-xs px-3 py-1.5 rounded font-medium transition-colors ${
              riskFilter === chip.key
                ? 'bg-cohesity-green text-white'
                : 'bg-cohesity-gray text-cohesity-text hover:bg-cohesity-border'
            }`}
          >
            {chip.label}
          </button>
        ))}
      </div>

      <div>
        <SectionHeading>Protection Job Health</SectionHeading>

        {/* Summary stat cards */}
        <div className="grid grid-cols-2 xl:grid-cols-5 gap-3 mb-4">
          <StatCard label="Protection Runs" value={summary.total ?? '—'} />
          <StatCard
            label="Success Rate"
            value={summary.successRate != null ? `${summary.successRate}%` : '—'}
            valueClass={summary.successRate != null ? successColor(summary.successRate) : 'text-cohesity-text'}
          />
          <StatCard label="Failed Runs" value={summary.failure ?? '—'} valueClass="text-red-400" />
          <StatCard label="At-Risk Jobs" value={atRiskJobCount} valueClass={atRiskJobCount > 0 ? 'text-red-400' : 'text-green-400'} />
          <StatCard label="No Success 24h" value={noSuccessCount} valueClass={noSuccessCount > 0 ? 'text-yellow-400' : 'text-green-400'} />
        </div>

        {summary.total === 0 ? (
          <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-6 text-center text-xs text-gray-400">
            No protection run data available. Data will appear after the next poll cycle.
          </div>
        ) : (
          <>
            {/* Charts row */}
            <div className="grid xl:grid-cols-2 gap-3 mb-4">
              <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4">
                <p className="text-xs font-semibold text-cohesity-text mb-3">Top Failure Reasons</p>
                <div style={{ height: 220 }}>
                  {topErrors.length > 0 ? (
                    <Bar data={failureChartData} options={failureChartOptions} />
                  ) : (
                    <div className="flex items-center justify-center h-full text-gray-500 text-xs">No failures recorded</div>
                  )}
                </div>
              </div>
              <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4">
                <p className="text-xs font-semibold text-cohesity-text mb-3">Status Breakdown</p>
                <div style={{ height: 220 }}>
                  {statusValues.some(v => v > 0) ? (
                    <Bar data={statusChartData} options={statusChartOptions} />
                  ) : (
                    <div className="flex items-center justify-center h-full text-gray-500 text-xs">No data</div>
                  )}
                </div>
              </div>
            </div>

            {/* PHASE 2: SLA Compliance Section */}
            {data?.slaSummary && (
              <div className="space-y-3 mb-4">
                <SectionHeading>SLA Compliance</SectionHeading>
                <div className="grid grid-cols-2 xl:grid-cols-5 gap-3 mb-3">
                  <StatCard label="Compliant Jobs" value={data.slaSummary.compliantJobs ?? '—'} valueClass="text-green-400" />
                  <StatCard label="Nearing Breach" value={data.slaSummary.nearingBreachJobs ?? '—'} valueClass="text-yellow-400" />
                  <StatCard label="Breached Jobs" value={data.slaSummary.breachedJobs ?? '—'} valueClass="text-red-400" />
                  <StatCard label="Total Jobs" value={data.slaSummary.totalJobs ?? '—'} />
                  <StatCard label="Compliance Rate" value={data.slaSummary.complianceRate != null ? `${data.slaSummary.complianceRate}%` : '—'} valueClass="text-cohesity-green" />
                </div>
                {data.slaRiskJobs && data.slaRiskJobs.length > 0 && (
                  <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4">
                    <p className="text-xs font-semibold text-cohesity-text mb-3">At-Risk Jobs by SLA</p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-[11px] text-gray-400">
                        <thead className="sticky top-0 bg-cohesity-gray">
                          <tr className="border-b border-cohesity-border">
                            <th className="text-left px-2 py-2 font-medium">Cluster</th>
                            <th className="text-left px-2 py-2 font-medium">Job</th>
                            <th className="text-right px-2 py-2 font-medium">Expected Interval (h)</th>
                            <th className="text-right px-2 py-2 font-medium">Hours Since Last Run</th>
                            <th className="text-left px-2 py-2 font-medium">SLA State</th>
                            <th className="text-right px-2 py-2 font-medium">Last Run</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.slaRiskJobs.slice(0, 20).map((job, i) => (
                            <tr key={`${job.clusterId}-${job.jobId}`} className={i % 2 === 0 ? 'bg-cohesity-black/40' : ''}>
                              <td className="px-2 py-1.5 truncate max-w-[100px]">{job.clusterName}</td>
                              <td className="px-2 py-1.5 truncate max-w-[130px]">{job.jobName || 'Unnamed'}</td>
                              <td className="text-right px-2 py-1.5">{job.expectedIntervalHours}</td>
                              <td className="text-right px-2 py-1.5">{job.hoursSinceLastRun}</td>
                              <td className="px-2 py-1.5">
                                <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${slaBadgeColor(job.slaState)}`}>
                                  {job.slaState}
                                </span>
                              </td>
                              <td className="text-right px-2 py-1.5 text-gray-500 text-[10px]">
                                {job.lastRunTime ? new Date(job.lastRunTime).toLocaleDateString() : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* PHASE 2: Failure Streak Intelligence Section */}
            {data?.streakSummary && (
              <div className="space-y-3 mb-4">
                <SectionHeading>Failure Streak Intelligence</SectionHeading>
                <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
                  <StatCard label="Jobs with 2+ Failures" value={data.streakSummary.jobsWith2PlusFailures ?? '—'} valueClass="text-yellow-400" />
                  <StatCard label="Jobs with 3+ Failures" value={data.streakSummary.jobsWith3PlusFailures ?? '—'} valueClass="text-orange-400" />
                  <StatCard label="Jobs with 5+ Failures" value={data.streakSummary.jobsWith5PlusFailures ?? '—'} valueClass="text-red-400" />
                  <StatCard label="Max Consecutive Failures" value={data.streakSummary.maxConsecutiveFailures ?? '—'} valueClass="text-red-400" />
                </div>
              </div>
            )}

            {/* PHASE 3: Anomaly and Forecast Section */}
            {data?.failureForecast && (
              <div className="space-y-3 mb-4">
                <SectionHeading>Anomaly and Forecast</SectionHeading>
                <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-3">
                  <StatCard label="Forecast Trend" value={data.failureForecast.trend?.toUpperCase() ?? '—'} valueClass={data.failureForecast.trend === 'up' ? 'text-red-400' : data.failureForecast.trend === 'down' ? 'text-green-400' : 'text-gray-400'} />
                  <StatCard label="Slope/Day" value={data.failureForecast.slopePerDay ?? '—'} />
                  <StatCard label="Projected Next 7d" value={data.failureForecast.projectedFailuresNext7d ?? '—'} valueClass="text-yellow-400" />
                  <StatCard label="Avg Daily Failures" value={data.failureForecast.avgDailyFailures ?? '—'} />
                </div>
                {data.runtimeAnomalies && data.runtimeAnomalies.length > 0 && (
                  <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4">
                    <p className="text-xs font-semibold text-cohesity-text mb-3">Runtime Anomalies (Regression Detection)</p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-[11px] text-gray-400">
                        <thead className="sticky top-0 bg-cohesity-gray">
                          <tr className="border-b border-cohesity-border">
                            <th className="text-left px-2 py-2 font-medium">Cluster</th>
                            <th className="text-left px-2 py-2 font-medium">Job</th>
                            <th className="text-right px-2 py-2 font-medium">Last 24h Avg</th>
                            <th className="text-right px-2 py-2 font-medium">Baseline Avg</th>
                            <th className="text-right px-2 py-2 font-medium">Delta %</th>
                            <th className="text-right px-2 py-2 font-medium">Samples</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.runtimeAnomalies.slice(0, 15).map((job, i) => (
                            <tr key={`${job.clusterId}-${job.jobId}`} className={i % 2 === 0 ? 'bg-cohesity-black/40' : ''}>
                              <td className="px-2 py-1.5 truncate max-w-[100px]">{job.clusterName}</td>
                              <td className="px-2 py-1.5 truncate max-w-[130px]">{job.jobName || 'Unnamed'}</td>
                              <td className="text-right px-2 py-1.5">{formatDuration(job.avgRuntimeLast24hSec)}</td>
                              <td className="text-right px-2 py-1.5">{formatDuration(job.avgRuntimeBaselineSec)}</td>
                              <td className="text-right px-2 py-1.5">
                                <span className="text-orange-400 font-medium">+{job.deltaPct}%</span>
                              </td>
                              <td className="text-right px-2 py-1.5">{job.sampleCount}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* PHASE 3: Alert Correlation Section */}
            {data?.alertCorrelation && (
              <div className="space-y-3 mb-4">
                <SectionHeading>Alert Correlation</SectionHeading>
                <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-3">
                  <StatCard label="Correlated Failed Runs" value={data.alertCorrelation.correlatedFailedRuns ?? '—'} />
                  <StatCard label="Total Failed Runs" value={data.alertCorrelation.totalFailedRuns ?? '—'} />
                  <StatCard label="Correlation Rate" value={data.alertCorrelation.correlationRate != null ? `${data.alertCorrelation.correlationRate}%` : '—'} />
                  <StatCard label="Alert Types" value={data.alertCorrelation.topAlertTypes?.length ?? 0} />
                </div>
                {data.alertCorrelation.topAlertTypes && data.alertCorrelation.topAlertTypes.length > 0 && (
                  <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4">
                    <p className="text-xs font-semibold text-cohesity-text mb-3">Top Alert Types</p>
                    <div className="space-y-1">
                      {data.alertCorrelation.topAlertTypes.map((alert, i) => (
                        <div key={i} className="flex justify-between items-center py-1 text-[11px]">
                          <span className="text-gray-400">{alert.alertType}</span>
                          <span className="text-cohesity-green font-medium">{alert.count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* At-Risk Jobs table */}
            <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-4">
              <p className="text-xs font-semibold text-cohesity-text mb-3">At-Risk Jobs</p>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] text-gray-400">
                  <thead className="sticky top-0 bg-cohesity-gray">
                    <tr className="border-b border-cohesity-border">
                      {[
                        { key: 'cluster', label: 'Cluster', align: 'left' },
                        { key: 'name', label: 'Job', align: 'left' },
                        { key: 'lastStatus', label: 'Last Status', align: 'left' },
                        { key: 'consecutiveFailures', label: 'Cons. Failures', align: 'right' },
                        { key: 'failureRate', label: 'Failure Rate', align: 'right' },
                        { key: 'hoursSinceLastSuccess', label: 'Hours No Success', align: 'right' },
                        { key: 'riskScore', label: 'Risk Score', align: 'right' },
                        { key: 'lastRunTime', label: 'Last Run', align: 'right' },
                      ].map(col => (
                        <th
                          key={col.key}
                          className={`${col.align === 'left' ? 'text-left' : 'text-right'} px-2 py-2 font-medium cursor-pointer hover:text-cohesity-text ${jobSort === col.key ? 'text-cohesity-green' : ''}`}
                          onClick={() => {
                            if (jobSort === col.key) setJobSortDir(d => d === 'desc' ? 'asc' : 'desc');
                            else { setJobSort(col.key); setJobSortDir('desc'); }
                          }}
                        >
                          {col.label}{' '}
                          {jobSort === col.key
                            ? (jobSortDir === 'desc' ? '▼' : '▲')
                            : <span className="text-gray-600">⇅</span>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedAtRiskJobs.map((job, i) => (
                      <tr key={`${job.clusterId}-${job.jobId}`} className={i % 2 === 0 ? 'bg-cohesity-black/40' : ''}>
                        <td className="px-2 py-1.5 truncate max-w-[120px]">{job.clusterName}</td>
                        <td className="px-2 py-1.5 truncate max-w-[150px]">{job.jobName || 'Unnamed'}</td>
                        <td className="px-2 py-1.5">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${statusBadgeColor(job.lastStatus)}`}>
                            {job.lastStatus || '—'}
                          </span>
                        </td>
                        <td className="text-right px-2 py-1.5 text-red-400 font-medium">{job.consecutiveFailures}</td>
                        <td className="text-right px-2 py-1.5">{job.failureRate != null ? `${job.failureRate}%` : '—'}</td>
                        <td className="text-right px-2 py-1.5">{job.hoursSinceLastSuccess != null ? job.hoursSinceLastSuccess : '—'}</td>
                        <td className="text-right px-2 py-1.5">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${riskBadgeColor(job.riskScore)}`}>
                            {job.riskScore}
                          </span>
                        </td>
                        <td className="text-right px-2 py-1.5 text-gray-500 text-[10px]">
                          {job.lastRunTime ? new Date(job.lastRunTime).toLocaleDateString() : '—'}
                        </td>
                      </tr>
                    ))}
                    {sortedAtRiskJobs.length === 0 && (
                      <tr><td colSpan={8} className="text-center py-4 text-gray-500">No jobs match current filters</td></tr>
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
