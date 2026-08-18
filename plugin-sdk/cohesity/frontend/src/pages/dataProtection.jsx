// Cohesity plugin — Data Protection page. Ported from
// frontend/src/pages/DataProtectionPage.jsx. Chart.js Bar -> kit BarChart,
// axios client -> apiFetch, Tailwind utility classes not in the kit's
// injected stylesheet (space-y-*, max-w-[Npx], bg-*-400/20, z-10, etc.)
// rewritten as inline styles per the gflags.jsx/settings.jsx convention.
import {
  apiFetch, useToast,
  PageHeader, Spinner, StatCard, LastUpdated, RefreshButton, Badge, SkeletonTable,
} from '../ui.jsx';
import { ShieldCheck } from '../icons.jsx';
import { BarChart } from '../charts.jsx';

function formatDuration(seconds) {
  if (!seconds || seconds === 0) return '0 s';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} m`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

function statusTone(status) {
  if (status === 'kSuccess') return 'ok';
  if (status === 'kWarning') return 'warn';
  if (status === 'kRunning') return 'info';
  return 'crit';
}

function riskTone(riskScore) {
  if (riskScore >= 50) return 'crit';
  if (riskScore >= 25) return 'warn';
  return 'ok';
}

function slaTone(state) {
  if (state === 'compliant') return 'ok';
  if (state === 'nearing_breach') return 'warn';
  return 'crit';
}

function SectionHeading({ children }) {
  return (
    <h2 style={{ fontSize: 13, fontWeight: 600, color: 'var(--co-ink)', textTransform: 'uppercase', letterSpacing: '.05em', margin: '4px 0 12px' }}>
      {children}
    </h2>
  );
}

const panelStyle = { background: 'var(--co-surface)', border: '1px solid var(--co-border)', borderRadius: 8, padding: 16 };
const thStyle = { textAlign: 'left', padding: '8px 8px', fontWeight: 500 };
const thRightStyle = { ...thStyle, textAlign: 'right' };
const tdStyle = { padding: '6px 8px' };
const tdRightStyle = { ...tdStyle, textAlign: 'right' };
const truncateStyle = (maxWidth) => ({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth });

export default function DataProtectionPage() {
  const { toast } = useToast();
  const [days, setDays] = React.useState(7);
  const [clusterId, setClusterId] = React.useState('');
  const [clusters, setClusters] = React.useState([]);
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [riskFilter, setRiskFilter] = React.useState('all');
  const [jobSort, setJobSort] = React.useState('riskScore');
  const [jobSortDir, setJobSortDir] = React.useState('desc');

  const fetchData = React.useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ days: String(days) });
      if (clusterId) params.set('clusterId', clusterId);
      const res = await apiFetch(`/cohesity/analytics/protection-runs?${params}`);
      setData(res);
      setLastRefreshed(new Date());
    } catch (err) {
      toast({ type: 'error', title: 'Data protection fetch failed', message: err.payload?.error || err.message });
    } finally {
      setLoading(false);
    }
  }, [days, clusterId, toast]);

  React.useEffect(() => {
    apiFetch('/cohesity/analytics/clusters').then((d) => setClusters(d || [])).catch(() => {});
  }, []);

  React.useEffect(() => { fetchData(); }, [fetchData]);

  const summary = data?.summary || {};
  const statusBreakdown = data?.statusBreakdown || {};
  const atRiskJobs = data?.atRiskJobs || [];

  const filteredAtRiskJobs = React.useMemo(() => {
    return atRiskJobs.filter((job) => {
      if (riskFilter === 'failed') return job.lastStatus && ['kFailure', 'kFailed', 'kError', 'kCanceled', 'kCancelled'].includes(job.lastStatus);
      if (riskFilter === 'atrisk') return job.consecutiveFailures >= 2 || job.failureRate >= 20;
      if (riskFilter === 'nosuccess') return job.hoursSinceLastSuccess && job.hoursSinceLastSuccess >= 24;
      return true;
    });
  }, [atRiskJobs, riskFilter]);

  const sortedAtRiskJobs = React.useMemo(() => {
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

  const statusLabels = ['Success', 'Failure', 'Warning', 'Running', 'Other'];
  const statusValues = [statusBreakdown.kSuccess || 0, statusBreakdown.kFailure || 0, statusBreakdown.kWarning || 0, statusBreakdown.kRunning || 0, statusBreakdown.other || 0];
  const statusChartData = {
    labels: statusLabels,
    datasets: [{ label: 'Count', data: statusValues, backgroundColor: ['#6CB33F', '#ef4444', '#f59e0b', '#3b82f6', '#8b5cf6'] }],
  };
  const statusChartOptions = {
    indexAxis: 'y',
    plugins: { legend: { display: false } },
    scales: { y: { ticks: { font: { size: 9 } } } },
  };

  const topErrors = data?.topErrors || [];
  const failureChartData = {
    labels: topErrors.map((e) => (e.errorMessage || 'Unknown').slice(0, 40)),
    datasets: [{ label: 'Count', data: topErrors.map((e) => e.count), backgroundColor: '#ef4444' }],
  };
  const failureChartOptions = {
    indexAxis: 'y',
    plugins: { legend: { display: false } },
    scales: { y: { ticks: { font: { size: 9 } } } },
  };

  const atRiskJobCount = atRiskJobs.filter((j) => j.consecutiveFailures >= 2 || j.failureRate >= 20).length;
  const noSuccessCount = atRiskJobs.filter((j) => j.hoursSinceLastSuccess && j.hoursSinceLastSuccess >= 24).length;

  const jobCols = [
    { key: 'cluster', label: 'Cluster', align: 'left' },
    { key: 'name', label: 'Job', align: 'left' },
    { key: 'lastStatus', label: 'Last Status', align: 'left' },
    { key: 'consecutiveFailures', label: 'Cons. Failures', align: 'right' },
    { key: 'failureRate', label: 'Failure Rate', align: 'right' },
    { key: 'hoursSinceLastSuccess', label: 'Hours No Success', align: 'right' },
    { key: 'riskScore', label: 'Risk Score', align: 'right' },
    { key: 'lastRunTime', label: 'Last Run', align: 'right' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <PageHeader icon={ShieldCheck} title="Data Protection" description="Protection job health, at-risk workloads, and failure analysis" />

      {/* Filter Bar */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--co-black)', padding: '8px 0', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', borderBottom: '1px solid var(--co-border)' }}>
        <select value={clusterId} onChange={(e) => setClusterId(e.target.value)} className="co-input" style={{ width: 'auto' }}>
          <option value="">All Clusters</option>
          {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>

        <div style={{ display: 'flex', gap: 4 }}>
          {[1, 7, 14, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              style={{ fontSize: 12, padding: '6px 12px', borderRadius: 6, fontWeight: 500, border: 'none', cursor: 'pointer', background: days === d ? 'var(--co-brand)' : 'var(--co-surface)', color: days === d ? '#fff' : 'var(--co-ink)' }}
            >
              {d === 1 ? '24h' : `${d}d`}
            </button>
          ))}
        </div>

        <RefreshButton onClick={fetchData} refreshing={loading} label="Refresh" />
        <LastUpdated date={lastRefreshed} prefix="Last refreshed" />
        {loading && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--co-ink-muted)', marginLeft: 8 }} role="status"><Spinner size={13} /> Loading protection data&hellip;</span>
        )}
      </div>

      {/* Risk Filter Chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {[
          { key: 'all', label: 'All' },
          { key: 'failed', label: 'Failed' },
          { key: 'atrisk', label: 'At Risk' },
          { key: 'nosuccess', label: 'No Success 24h' },
        ].map((chip) => (
          <button
            key={chip.key}
            onClick={() => setRiskFilter(chip.key)}
            style={{ fontSize: 12, padding: '6px 12px', borderRadius: 6, fontWeight: 500, border: 'none', cursor: 'pointer', background: riskFilter === chip.key ? 'var(--co-brand)' : 'var(--co-surface)', color: riskFilter === chip.key ? '#fff' : 'var(--co-ink)' }}
          >
            {chip.label}
          </button>
        ))}
      </div>

      <div>
        <SectionHeading>Protection Job Health</SectionHeading>

        {loading && !data ? (
          <div className="grid grid-cols-2 xl:grid-cols-5" style={{ gap: 12, marginBottom: 16 }}>
            {[...Array(5)].map((_, i) => <div key={i} className="panel" style={{ padding: '14px 16px' }}><div className="skeleton" style={{ height: 24, width: 80, marginTop: 4 }} /></div>)}
          </div>
        ) : (
          <div className="grid grid-cols-2 xl:grid-cols-5" style={{ gap: 12, marginBottom: 16 }}>
            <StatCard label="Protection Runs" value={summary.total ?? '—'} />
            <StatCard
              label="Success Rate"
              value={summary.successRate != null ? `${summary.successRate}%` : '—'}
              tone={summary.successRate == null ? 'default' : summary.successRate >= 90 ? 'ok' : summary.successRate >= 70 ? 'warn' : 'crit'}
            />
            <StatCard label="Failed Runs" value={summary.failure ?? '—'} tone={(summary.failure ?? 0) > 0 ? 'crit' : 'ok'} />
            <StatCard label="At-Risk Jobs" value={atRiskJobCount} tone={atRiskJobCount > 0 ? 'crit' : 'ok'} />
            <StatCard label="No Success 24h" value={noSuccessCount} tone={noSuccessCount > 0 ? 'warn' : 'ok'} />
          </div>
        )}

        {summary.total === 0 ? (
          <div style={{ ...panelStyle, textAlign: 'center', padding: 24, fontSize: 12, color: 'var(--co-ink-muted)' }}>
            No protection run data available. Data will appear after the next poll cycle.
          </div>
        ) : (
          <>
            {/* Charts row */}
            <div className="grid xl:grid-cols-2" style={{ display: 'grid', gap: 12, marginBottom: 16 }}>
              <div style={panelStyle}>
                <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--co-ink)', margin: '0 0 12px' }}>Top Failure Reasons</p>
                {topErrors.length > 0 ? (
                  <BarChart data={failureChartData} options={failureChartOptions} height={220} />
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 220, color: 'var(--co-ink-faint)', fontSize: 12 }}>No failures recorded</div>
                )}
              </div>
              <div style={panelStyle}>
                <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--co-ink)', margin: '0 0 12px' }}>Status Breakdown</p>
                {statusValues.some((v) => v > 0) ? (
                  <BarChart data={statusChartData} options={statusChartOptions} height={220} />
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 220, color: 'var(--co-ink-faint)', fontSize: 12 }}>No data</div>
                )}
              </div>
            </div>

            {/* SLA Compliance Section */}
            {data?.slaSummary && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
                <SectionHeading>SLA Compliance</SectionHeading>
                <div className="grid grid-cols-2 xl:grid-cols-5" style={{ gap: 12 }}>
                  <StatCard label="Compliant Jobs" value={data.slaSummary.compliantJobs ?? '—'} tone="ok" />
                  <StatCard label="Nearing Breach" value={data.slaSummary.nearingBreachJobs ?? '—'} tone="warn" />
                  <StatCard label="Breached Jobs" value={data.slaSummary.breachedJobs ?? '—'} tone="crit" />
                  <StatCard label="Total Jobs" value={data.slaSummary.totalJobs ?? '—'} />
                  <StatCard label="Compliance Rate" value={data.slaSummary.complianceRate != null ? `${data.slaSummary.complianceRate}%` : '—'} tone="brand" />
                </div>
                {data.slaRiskJobs && data.slaRiskJobs.length > 0 && (
                  <div style={panelStyle}>
                    <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--co-ink)', margin: '0 0 12px' }}>At-Risk Jobs by SLA</p>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', fontSize: 11, color: 'var(--co-ink-muted)' }}>
                        <thead><tr style={{ borderBottom: '1px solid var(--co-border)' }}>
                          <th style={thStyle}>Cluster</th>
                          <th style={thStyle}>Job</th>
                          <th style={thRightStyle}>Expected Interval (h)</th>
                          <th style={thRightStyle}>Hours Since Last Run</th>
                          <th style={thStyle}>SLA State</th>
                          <th style={thRightStyle}>Last Run</th>
                        </tr></thead>
                        <tbody>
                          {data.slaRiskJobs.slice(0, 20).map((job, i) => (
                            <tr key={`${job.clusterId}-${job.jobId}`} style={{ background: i % 2 === 0 ? 'rgba(11,16,21,0.4)' : 'transparent' }}>
                              <td style={{ ...tdStyle, ...truncateStyle(100) }}>{job.clusterName}</td>
                              <td style={{ ...tdStyle, ...truncateStyle(130) }}>{job.jobName || 'Unnamed'}</td>
                              <td style={tdRightStyle}>{job.expectedIntervalHours}</td>
                              <td style={tdRightStyle}>{job.hoursSinceLastRun}</td>
                              <td style={tdStyle}><Badge tone={slaTone(job.slaState)}>{job.slaState}</Badge></td>
                              <td style={{ ...tdRightStyle, color: 'var(--co-ink-faint)', fontSize: 10 }}>{job.lastRunTime ? new Date(job.lastRunTime).toLocaleDateString() : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Failure Streak Intelligence Section */}
            {data?.streakSummary && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
                <SectionHeading>Failure Streak Intelligence</SectionHeading>
                <div className="grid grid-cols-2 xl:grid-cols-4" style={{ gap: 12 }}>
                  <StatCard label="Jobs with 2+ Failures" value={data.streakSummary.jobsWith2PlusFailures ?? '—'} tone="warn" />
                  <StatCard label="Jobs with 3+ Failures" value={data.streakSummary.jobsWith3PlusFailures ?? '—'} tone="warn" />
                  <StatCard label="Jobs with 5+ Failures" value={data.streakSummary.jobsWith5PlusFailures ?? '—'} tone="crit" />
                  <StatCard label="Max Consecutive Failures" value={data.streakSummary.maxConsecutiveFailures ?? '—'} tone="crit" />
                </div>
              </div>
            )}

            {/* Anomaly and Forecast Section */}
            {data?.failureForecast && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
                <SectionHeading>Anomaly and Forecast</SectionHeading>
                <div className="grid grid-cols-2 xl:grid-cols-4" style={{ gap: 12 }}>
                  <StatCard label="Forecast Trend" value={data.failureForecast.trend?.toUpperCase() ?? '—'} tone={data.failureForecast.trend === 'up' ? 'crit' : data.failureForecast.trend === 'down' ? 'ok' : 'default'} />
                  <StatCard label="Slope/Day" value={data.failureForecast.slopePerDay ?? '—'} />
                  <StatCard label="Projected Next 7d" value={data.failureForecast.projectedFailuresNext7d ?? '—'} tone="warn" />
                  <StatCard label="Avg Daily Failures" value={data.failureForecast.avgDailyFailures ?? '—'} />
                </div>
                {data.runtimeAnomalies && data.runtimeAnomalies.length > 0 && (
                  <div style={panelStyle}>
                    <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--co-ink)', margin: '0 0 12px' }}>Runtime Anomalies (Regression Detection)</p>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', fontSize: 11, color: 'var(--co-ink-muted)' }}>
                        <thead><tr style={{ borderBottom: '1px solid var(--co-border)' }}>
                          <th style={thStyle}>Cluster</th>
                          <th style={thStyle}>Job</th>
                          <th style={thRightStyle}>Last 24h Avg</th>
                          <th style={thRightStyle}>Baseline Avg</th>
                          <th style={thRightStyle}>Delta %</th>
                          <th style={thRightStyle}>Samples</th>
                        </tr></thead>
                        <tbody>
                          {data.runtimeAnomalies.slice(0, 15).map((job, i) => (
                            <tr key={`${job.clusterId}-${job.jobId}`} style={{ background: i % 2 === 0 ? 'rgba(11,16,21,0.4)' : 'transparent' }}>
                              <td style={{ ...tdStyle, ...truncateStyle(100) }}>{job.clusterName}</td>
                              <td style={{ ...tdStyle, ...truncateStyle(130) }}>{job.jobName || 'Unnamed'}</td>
                              <td style={tdRightStyle}>{formatDuration(job.avgRuntimeLast24hSec)}</td>
                              <td style={tdRightStyle}>{formatDuration(job.avgRuntimeBaselineSec)}</td>
                              <td style={{ ...tdRightStyle, color: '#fb923c', fontWeight: 600 }}>+{job.deltaPct}%</td>
                              <td style={tdRightStyle}>{job.sampleCount}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Alert Correlation Section */}
            {data?.alertCorrelation && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
                <SectionHeading>Alert Correlation</SectionHeading>
                <div className="grid grid-cols-2 xl:grid-cols-4" style={{ gap: 12 }}>
                  <StatCard label="Correlated Failed Runs" value={data.alertCorrelation.correlatedFailedRuns ?? '—'} tone="warn" />
                  <StatCard label="Total Failed Runs" value={data.alertCorrelation.totalFailedRuns ?? '—'} />
                  <StatCard label="Correlation Rate" value={data.alertCorrelation.correlationRate != null ? `${data.alertCorrelation.correlationRate}%` : '—'} />
                  <StatCard label="Alert Types" value={data.alertCorrelation.topAlertTypes?.length ?? 0} tone="info" />
                </div>
                {data.alertCorrelation.topAlertTypes && data.alertCorrelation.topAlertTypes.length > 0 && (
                  <div style={panelStyle}>
                    <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--co-ink)', margin: '0 0 12px' }}>Top Alert Types</p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {data.alertCorrelation.topAlertTypes.map((alert, i) => (
                        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', fontSize: 11 }}>
                          <span style={{ color: 'var(--co-ink-muted)' }}>{alert.alertType}</span>
                          <span style={{ color: 'var(--co-brand)', fontWeight: 600 }}>{alert.count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* At-Risk Jobs table */}
            <div style={panelStyle}>
              <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--co-ink)', margin: '0 0 12px' }}>At-Risk Jobs</p>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', fontSize: 11, color: 'var(--co-ink-muted)' }}>
                  <thead><tr style={{ borderBottom: '1px solid var(--co-border)' }}>
                    {jobCols.map((col) => (
                      <th
                        key={col.key}
                        style={{ ...(col.align === 'left' ? thStyle : thRightStyle), cursor: 'pointer', color: jobSort === col.key ? 'var(--co-brand)' : 'var(--co-ink-faint)' }}
                        onClick={() => {
                          if (jobSort === col.key) setJobSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
                          else { setJobSort(col.key); setJobSortDir('desc'); }
                        }}
                      >
                        {col.label}{' '}
                        {jobSort === col.key ? (jobSortDir === 'desc' ? '▼' : '▲') : <span style={{ color: 'var(--co-ink-faint)' }}>⇅</span>}
                      </th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {sortedAtRiskJobs.map((job, i) => (
                      <tr key={`${job.clusterId}-${job.jobId}`} style={{ background: i % 2 === 0 ? 'rgba(11,16,21,0.4)' : 'transparent' }}>
                        <td style={{ ...tdStyle, ...truncateStyle(120) }}>{job.clusterName}</td>
                        <td style={{ ...tdStyle, ...truncateStyle(150) }}>{job.jobName || 'Unnamed'}</td>
                        <td style={tdStyle}><Badge tone={statusTone(job.lastStatus)}>{job.lastStatus || '—'}</Badge></td>
                        <td style={{ ...tdRightStyle, color: 'var(--co-crit)', fontWeight: 600 }}>{job.consecutiveFailures}</td>
                        <td style={tdRightStyle}>{job.failureRate != null ? `${job.failureRate}%` : '—'}</td>
                        <td style={tdRightStyle}>{job.hoursSinceLastSuccess != null ? job.hoursSinceLastSuccess : '—'}</td>
                        <td style={tdRightStyle}><Badge tone={riskTone(job.riskScore)}>{job.riskScore}</Badge></td>
                        <td style={{ ...tdRightStyle, color: 'var(--co-ink-faint)', fontSize: 10 }}>{job.lastRunTime ? new Date(job.lastRunTime).toLocaleDateString() : '—'}</td>
                      </tr>
                    ))}
                    {sortedAtRiskJobs.length === 0 && (
                      <tr><td colSpan={8} style={{ textAlign: 'center', padding: '16px 0', color: 'var(--co-ink-faint)' }}>No jobs match current filters</td></tr>
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
