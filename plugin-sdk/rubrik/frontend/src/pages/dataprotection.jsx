// Rubrik v2.0.0 Data Protection page — mirrors host
// frontend/src/pages/DataProtectionPage.jsx using ONLY the rbk- kit
// (./ui, ./charts). No Tailwind, no Chart.js, no host imports.

import {
  PageHeader, StatCard, SkeletonTable, RefreshButton, LastUpdated, Spinner,
  ShieldIcon,
} from '../ui';
import { HBar } from '../charts';

const API_BASE = '/api/rubrik';

function apiFetch(path) {
  return fetch(`${API_BASE}${path}`, { credentials: 'include' }).then((res) => {
    if (!res.ok) throw new Error(`request failed: ${res.status}`);
    return res.json();
  });
}

const STATUS_COLORS = { Succeeded: '#34D399', Failed: '#F87171', Warning: '#FBBF24', Running: '#60A5FA', Canceled: '#94A3B3' };

function riskTone(score) {
  if (score >= 50) return { bg: 'rgba(248,113,113,0.1)', color: '#F87171', border: 'rgba(248,113,113,0.25)' };
  if (score >= 25) return { bg: 'rgba(251,191,36,0.1)', color: '#FBBF24', border: 'rgba(251,191,36,0.25)' };
  return { bg: 'rgba(52,211,153,0.1)', color: '#34D399', border: 'rgba(52,211,153,0.25)' };
}

function statusTone(status) {
  const color = STATUS_COLORS[status] || '#94A3B3';
  return { bg: `${color}1a`, color, border: `${color}40` };
}

function StatusPill({ status }) {
  const t = statusTone(status);
  return <span className="rbk-chip" style={{ background: t.bg, color: t.color, borderColor: t.border }}>{status || '—'}</span>;
}

function RiskPill({ score }) {
  const t = riskTone(score);
  return <span className="rbk-chip" style={{ background: t.bg, color: t.color, borderColor: t.border }}>{score}</span>;
}

function SectionHeading({ children }) {
  return <h2 style={{ fontSize: 12, fontWeight: 600, color: 'var(--rbk-ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '4px 0 12px' }}>{children}</h2>;
}

function formatDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString();
}

// FLAG (kit gap): charts.jsx's HBar hardcodes a 14-char label truncation,
// but this page's spec calls for 40-char truncation on failure-reason
// labels (they're full error strings). Implemented locally, same visual
// language (rect/text layout, colors) as HBar, just with a wider label
// column and truncation cutoff, plus a native <title> tooltip for the rest.
function FailureHBar({ rows = [], width = 320 }) {
  const barMax = Math.max(1, ...rows.map((r) => r.value));
  const barH = 14;
  const gap = 8;
  const labelW = 220;
  const h = rows.length * (barH + gap);
  return (
    <svg width={width} height={h || 20}>
      {rows.map((r, i) => {
        const w = Math.max(2, (r.value / barMax) * (width - labelW - 40));
        const y = i * (barH + gap);
        const label = r.label.length > 40 ? `${r.label.slice(0, 39)}…` : r.label;
        return (
          <g key={`${r.label}-${i}`}>
            <title>{r.label}</title>
            <text x={0} y={y + barH / 2 + 4} fontSize={11} fill="#94A3B3">{label}</text>
            <rect x={labelW} y={y} width={w} height={barH} rx={3} fill={r.color || '#ef4444'} />
            <text x={labelW + w + 6} y={y + barH / 2 + 4} fontSize={11} fill="#E8EDF2">{r.value}</text>
          </g>
        );
      })}
    </svg>
  );
}

export default function DataProtectionPage() {
  const [days, setDays] = React.useState(7);
  const [clusterId, setClusterId] = React.useState('');
  const [clusters, setClusters] = React.useState([]);
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [riskFilter, setRiskFilter] = React.useState('all');
  const [jobSort, setJobSort] = React.useState('riskScore');
  const [jobSortDir, setJobSortDir] = React.useState('desc');

  const fetchData = React.useCallback(() => {
    setLoading(true);
    apiFetch(`/protection?days=${days}`)
      .then((res) => { setData(res); setLastRefreshed(new Date()); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [days]);

  React.useEffect(() => {
    apiFetch('/clusters').then((rows) => setClusters(rows || [])).catch(() => {});
  }, []);

  React.useEffect(() => { fetchData(); }, [fetchData]);

  const summary = data?.summary || {};
  const statusBreakdown = data?.statusBreakdown || {};
  const topErrors = data?.topErrors || [];
  const slaSummary = data?.slaSummary || null;
  const allAtRiskJobs = data?.atRiskJobs || [];

  // NOTE (contract gap): /protection?days=N has no clusterId filter param
  // per the v2 route contract, so the cluster select filters the at-risk
  // jobs table client-side; the top KPI/chart rows stay estate-wide.
  const atRiskJobs = React.useMemo(
    () => (clusterId ? allAtRiskJobs.filter((j) => j.cluster === clusterId) : allAtRiskJobs),
    [allAtRiskJobs, clusterId]
  );

  const filteredAtRiskJobs = React.useMemo(() => atRiskJobs.filter((job) => {
    if (riskFilter === 'failed') return job.lastStatus === 'Failed';
    if (riskFilter === 'atrisk') return job.consecutiveFailures >= 2 || job.failureRate >= 20;
    if (riskFilter === 'nosuccess') return job.hoursSinceLastSuccess != null && job.hoursSinceLastSuccess >= 24;
    return true;
  }), [atRiskJobs, riskFilter]);

  const sortedAtRiskJobs = React.useMemo(() => {
    const arr = [...filteredAtRiskJobs];
    const dir = jobSortDir === 'desc' ? -1 : 1;
    arr.sort((a, b) => {
      if (jobSort === 'cluster') return dir * String(a.cluster || '').localeCompare(String(b.cluster || ''));
      if (jobSort === 'jobName') return dir * String(a.jobName || '').localeCompare(String(b.jobName || ''));
      if (jobSort === 'lastStatus') return dir * String(a.lastStatus || '').localeCompare(String(b.lastStatus || ''));
      if (jobSort === 'consecutiveFailures') return dir * ((a.consecutiveFailures || 0) - (b.consecutiveFailures || 0));
      if (jobSort === 'failureRate') return dir * ((a.failureRate || 0) - (b.failureRate || 0));
      if (jobSort === 'hoursSinceLastSuccess') return dir * ((a.hoursSinceLastSuccess || 0) - (b.hoursSinceLastSuccess || 0));
      if (jobSort === 'lastRunTime') return dir * (new Date(a.lastRunTime || 0) - new Date(b.lastRunTime || 0));
      return dir * ((a.riskScore || 0) - (b.riskScore || 0));
    });
    return arr;
  }, [filteredAtRiskJobs, jobSort, jobSortDir]);

  const atRiskJobCount = atRiskJobs.filter((j) => j.consecutiveFailures >= 2 || j.failureRate >= 20).length;
  const noSuccessCount = atRiskJobs.filter((j) => j.hoursSinceLastSuccess != null && j.hoursSinceLastSuccess >= 24).length;

  const failureRows = topErrors.map((e) => ({ label: e.errorMessage || 'Unknown', value: e.count, color: '#ef4444' }));
  const statusRows = Object.entries(statusBreakdown)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => ({ label: k, value: v, color: STATUS_COLORS[k] || '#94A3B3' }));

  const jobCols = [
    { key: 'cluster', label: 'Cluster', align: 'left' },
    { key: 'jobName', label: 'Job', align: 'left' },
    { key: 'lastStatus', label: 'Last Status', align: 'left' },
    { key: 'consecutiveFailures', label: 'Cons. Failures', align: 'right' },
    { key: 'failureRate', label: 'Failure Rate', align: 'right' },
    { key: 'hoursSinceLastSuccess', label: 'Hours No Success', align: 'right' },
    { key: 'riskScore', label: 'Risk Score', align: 'right' },
    { key: 'lastRunTime', label: 'Last Run', align: 'right' },
  ];

  const thStyle = (col) => ({
    textAlign: col.align,
    padding: '8px 12px 8px 0',
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.03em',
    color: jobSort === col.key ? 'var(--rbk-ink)' : 'var(--rbk-ink-muted)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  });

  const onSortClick = (key) => {
    if (jobSort === key) setJobSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setJobSort(key); setJobSortDir('desc'); }
  };

  return (
    <div className="rbk-root rbk-fade-in">
      <PageHeader icon={ShieldIcon} title="Data Protection" description="Protection job health, at-risk workloads, and failure analysis" />

      <div className="page-bg" style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--rbk-surface-base)', borderBottom: '1px solid var(--rbk-border)', padding: '8px 0', marginBottom: 16, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <select value={clusterId} onChange={(e) => setClusterId(e.target.value)} className="rbk-input" style={{ width: 'auto', cursor: 'pointer' }}>
          <option value="">All Clusters</option>
          {clusters.map((c) => <option key={c.id ?? c.name} value={c.name}>{c.name}</option>)}
        </select>

        <div style={{ display: 'flex', gap: 4 }}>
          {[1, 7, 14, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`rbk-pill${days === d ? ' rbk-pill-active' : ''}`}
              style={{ padding: '6px 12px' }}
            >
              {d === 1 ? '24h' : `${d}d`}
            </button>
          ))}
        </div>

        <RefreshButton onClick={fetchData} refreshing={loading} />
        <LastUpdated date={lastRefreshed} prefix="Last refreshed" />
        {loading && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--rbk-ink-muted)' }}>
            <Spinner size={13} /> Loading protection data&hellip;
          </span>
        )}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
        {[
          { key: 'all', label: 'All' },
          { key: 'failed', label: 'Failed' },
          { key: 'atrisk', label: 'At Risk' },
          { key: 'nosuccess', label: 'No Success 24h' },
        ].map((chip) => (
          <button key={chip.key} onClick={() => setRiskFilter(chip.key)} className={`rbk-pill${riskFilter === chip.key ? ' rbk-pill-active' : ''}`}>
            {chip.label}
          </button>
        ))}
      </div>

      <div style={{ marginBottom: 24 }}>
        <SectionHeading>Protection Job Health</SectionHeading>
        <div className="rbk-stagger" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 16 }}>
          <StatCard label="Runs" value={summary.total ?? '—'} loading={loading && !data} />
          <StatCard
            label="Success Rate"
            value={summary.successRate != null ? `${summary.successRate}%` : '—'}
            tone={summary.successRate == null ? 'default' : summary.successRate >= 90 ? 'ok' : summary.successRate >= 70 ? 'warn' : 'crit'}
            loading={loading && !data}
          />
          <StatCard label="Failed" value={summary.failure ?? '—'} tone={(summary.failure ?? 0) > 0 ? 'crit' : 'ok'} loading={loading && !data} />
          <StatCard label="At-Risk Jobs" value={atRiskJobCount} tone={atRiskJobCount > 0 ? 'crit' : 'ok'} loading={loading && !data} />
          <StatCard label="No Success 24h" value={noSuccessCount} tone={noSuccessCount > 0 ? 'warn' : 'ok'} loading={loading && !data} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 24 }}>
          <div className="rbk-panel" style={{ padding: 16 }}>
            <p className="rbk-panel-title" style={{ marginBottom: 12 }}>Top Failure Reasons</p>
            {failureRows.length > 0 ? <FailureHBar rows={failureRows} /> : <div style={{ color: 'var(--rbk-ink-faint)', fontSize: 12, padding: '20px 0', textAlign: 'center' }}>No failures recorded</div>}
          </div>
          <div className="rbk-panel" style={{ padding: 16 }}>
            <p className="rbk-panel-title" style={{ marginBottom: 12 }}>Status Breakdown</p>
            {statusRows.length > 0 ? <HBar rows={statusRows} /> : <div style={{ color: 'var(--rbk-ink-faint)', fontSize: 12, padding: '20px 0', textAlign: 'center' }}>No data</div>}
          </div>
        </div>

        {slaSummary && (
          <div style={{ marginBottom: 24 }}>
            <SectionHeading>SLA Compliance</SectionHeading>
            <div className="rbk-stagger" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
              <StatCard label="Compliant" value={slaSummary.compliantJobs ?? '—'} tone="ok" />
              <StatCard label="Nearing Breach" value={slaSummary.nearingBreachJobs ?? '—'} tone="warn" />
              <StatCard label="Breached" value={slaSummary.breachedJobs ?? '—'} tone="crit" />
              <StatCard label="Total" value={slaSummary.totalJobs ?? '—'} />
              <StatCard label="Compliance Rate" value={slaSummary.complianceRate != null ? `${slaSummary.complianceRate}%` : '—'} tone="brand" />
            </div>
          </div>
        )}

        <div>
          <SectionHeading>At-Risk Jobs</SectionHeading>
          <div className="rbk-panel" style={{ padding: 16 }}>
            {loading && !data ? (
              <SkeletonTable rows={6} colWidths={['14%', '20%', '14%', '10%', '10%', '12%', '10%', '10%']} />
            ) : (
              <div className="rbk-scroll" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--rbk-border)' }}>
                      {jobCols.map((col) => (
                        <th key={col.key} style={thStyle(col)} onClick={() => onSortClick(col.key)}>
                          {col.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedAtRiskJobs.map((job, i) => (
                      <tr key={`${job.cluster}-${job.jobName}-${i}`} style={{ background: i % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent' }}>
                        <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink)', whiteSpace: 'nowrap' }}>{job.cluster}</td>
                        <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={job.jobName}>{job.jobName || 'Unnamed'}</td>
                        <td style={{ padding: '8px 12px 8px 0' }}><StatusPill status={job.lastStatus} /></td>
                        <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--rbk-crit)', fontWeight: 600 }}>{job.consecutiveFailures}</td>
                        <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--rbk-ink-muted)' }}>{job.failureRate != null ? `${job.failureRate}%` : '—'}</td>
                        <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--rbk-ink-muted)' }}>{job.hoursSinceLastSuccess != null ? job.hoursSinceLastSuccess : '—'}</td>
                        <td style={{ padding: '8px 12px 8px 0', textAlign: 'right' }}><RiskPill score={job.riskScore} /></td>
                        <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--rbk-ink-faint)', fontSize: 11 }}>{formatDate(job.lastRunTime)}</td>
                      </tr>
                    ))}
                    {sortedAtRiskJobs.length === 0 && (
                      <tr><td colSpan={jobCols.length} style={{ textAlign: 'center', padding: 24, color: 'var(--rbk-ink-faint)' }}>No jobs match current filters</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
