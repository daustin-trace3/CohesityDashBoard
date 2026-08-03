// Rubrik v2.0.0 Analytics page — mirrors host frontend/src/pages/AnalyticsPage.jsx
// (job analytics + replication mesh) using the rbk- style/chart kit.
import {
  PageHeader, StatCard, Panel, Spinner, LastUpdated, RefreshButton, Badge,
  EmptyState, fmtBytes, ActivityIcon, ChartIcon, ArrowsIcon, XIcon,
} from '../ui';
import { StackedVBar, MeshDiagram } from '../charts';

const OK = '#34D399';
const WARN = '#FBBF24';
const CRIT = '#F87171';
const BRAND = '#00B388';

function successColor(rate) {
  if (rate == null) return 'var(--rbk-ink-muted)';
  if (rate >= 90) return OK;
  if (rate >= 70) return WARN;
  return CRIT;
}

function formatLag(seconds) {
  if (!seconds) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

// charts.jsx's HBar hardcodes a 14-char label truncation (built for short
// cluster/job names) — the contract calls for 40-char truncation on failure
// reason strings, so this page renders its own compact bar list rather than
// stretching HBar's fixed label column. Kept visually consistent (crit red,
// same row height/typography as the rest of the kit).
function TopFailuresBar({ rows, width = 480 }) {
  const barH = 14;
  const gap = 14;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <svg width={width} height={rows.length * (barH + gap)}>
      {rows.map((r, i) => {
        const y = i * (barH + gap);
        const w = Math.max(2, (r.value / max) * (width - 40));
        return (
          <g key={i}>
            <text x={0} y={y - 2} fontSize={10} fill="var(--rbk-ink-muted)">
              {r.label.length > 40 ? `${r.label.slice(0, 39)}…` : r.label}
            </text>
            <rect x={0} y={y + 2} width={w} height={barH - 4} rx={3} fill={CRIT} />
            <text x={w + 6} y={y + 2 + (barH - 4) / 2 + 4} fontSize={10} fill="var(--rbk-ink)">
              {r.value}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function MeshPanel({ title, note, flows }) {
  const [filterSource, setFilterSource] = React.useState('');
  const [filterTarget, setFilterTarget] = React.useState('');
  const [filterStatus, setFilterStatus] = React.useState('all');

  const allSources = React.useMemo(() => [...new Set(flows.map((f) => f.source))].sort(), [flows]);
  const allTargets = React.useMemo(() => [...new Set(flows.map((f) => f.target))].sort(), [flows]);

  const filteredFlows = React.useMemo(
    () =>
      flows.filter((f) => {
        if (filterSource && f.source !== filterSource) return false;
        if (filterTarget && f.target !== filterTarget) return false;
        const failPct = f.runCount > 0 ? f.failureCount / f.runCount : 0;
        if (filterStatus === 'healthy' && f.failureCount > 0) return false;
        if (filterStatus === 'degraded' && (f.failureCount === 0 || failPct >= 0.2)) return false;
        if (filterStatus === 'failed' && failPct < 0.2) return false;
        return true;
      }),
    [flows, filterSource, filterTarget, filterStatus]
  );

  const hasFilters = filterSource || filterTarget || filterStatus !== 'all';
  const selectStyle = { width: 'auto', fontSize: 11, padding: '4px 8px' };

  return (
    <Panel title={title} icon={ArrowsIcon}>
      {note && <p style={{ fontSize: 10, color: 'var(--rbk-ink-faint)', margin: '-6px 0 10px' }}>{note}</p>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <select className="rbk-input" style={selectStyle} value={filterSource} onChange={(e) => setFilterSource(e.target.value)}>
          <option value="">All Sources</option>
          {allSources.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="rbk-input" style={selectStyle} value={filterTarget} onChange={(e) => setFilterTarget(e.target.value)}>
          <option value="">All Targets</option>
          {allTargets.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="rbk-input" style={selectStyle} value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <option value="all">All Status</option>
          <option value="healthy">Healthy only</option>
          <option value="degraded">Degraded (&lt;20% fail)</option>
          <option value="failed">Failed (≥20% fail)</option>
        </select>
        {hasFilters && (
          <button
            className="rbk-btn-ghost"
            style={{ fontSize: 11, padding: '4px 8px' }}
            onClick={() => { setFilterSource(''); setFilterTarget(''); setFilterStatus('all'); }}
          >
            <XIcon size={11} /> Clear
          </button>
        )}
      </div>
      {filteredFlows.length === 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 400, fontSize: 12, color: 'var(--rbk-ink-faint)' }}>
          No flows match the current filters
        </div>
      ) : (
        <MeshDiagram
          flows={filteredFlows}
          onNodeClick={(name) => setFilterSource((cur) => (cur === name ? '' : name || ''))}
        />
      )}
    </Panel>
  );
}

function useRubrikFetch(path, deps) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [lastUpdated, setLastUpdated] = React.useState(null);

  const fetchNow = React.useCallback(() => {
    setLoading(true);
    return fetch(`/api/rubrik${path}`, { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`request failed: ${res.status}`);
        return res.json();
      })
      .then((json) => {
        setData(json);
        setError(null);
        setLastUpdated(new Date());
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  React.useEffect(() => {
    fetchNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, lastUpdated, refetch: fetchNow };
}

const SITE_CODE = (name) => (!name || name.trim().length < 4 ? 'UNKN' : name.trim().slice(0, 4).toUpperCase());

export default function AnalyticsPage() {
  const [days, setDays] = React.useState(7);
  const [clusterId, setClusterId] = React.useState('');
  const [clusters, setClusters] = React.useState([]);

  React.useEffect(() => {
    fetch('/api/rubrik/clusters', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => setClusters(rows || []))
      .catch(() => {});
  }, []);

  const qs = clusterId ? `?days=${days}&clusterId=${encodeURIComponent(clusterId)}` : `?days=${days}`;
  const protection = useRubrikFetch(`/protection${qs}`, [days, clusterId]);
  const replication = useRubrikFetch(`/analytics/replication?days=${days}`, [days]);

  const loading = protection.loading || replication.loading;
  const lastUpdated = protection.lastUpdated && replication.lastUpdated
    ? (protection.lastUpdated > replication.lastUpdated ? protection.lastUpdated : replication.lastUpdated)
    : (protection.lastUpdated || replication.lastUpdated);
  const refresh = () => { protection.refetch(); replication.refetch(); };

  const backup = protection.data || {};
  const backupSummary = backup.summary || {};
  const byDay = backup.byDay || [];
  const topErrors = (backup.topErrors || []).slice(0, 10);
  const byCluster = backup.byCluster || [];

  const replData = replication.data || {};
  const replSummary = replData.summary || {};
  const rawFlows = replData.flows || [];

  const flows = React.useMemo(
    () => rawFlows.map((f) => ({ ...f, source: f.sourceCluster, target: f.targetCluster })),
    [rawFlows]
  );

  const siteFlows = React.useMemo(() => {
    const agg = new Map();
    for (const f of rawFlows) {
      const source = SITE_CODE(f.sourceCluster);
      const target = SITE_CODE(f.targetCluster);
      const key = `${source}|${target}`;
      if (!agg.has(key)) {
        agg.set(key, {
          source, target, runCount: 0, successCount: 0, failureCount: 0,
          totalBytesTransferred: 0, longRunningCount: 0, lagSum: 0, lagCount: 0, lastSeen: null,
        });
      }
      const a = agg.get(key);
      a.runCount += f.runCount || 0;
      a.successCount += f.successCount || 0;
      a.failureCount += f.failureCount || 0;
      a.totalBytesTransferred += f.totalBytesTransferred || 0;
      a.longRunningCount += f.longRunningCount || 0;
      if (f.avgLagSeconds != null) { a.lagSum += f.avgLagSeconds * (f.runCount || 1); a.lagCount += f.runCount || 1; }
      if (f.lastSeen && (!a.lastSeen || f.lastSeen > a.lastSeen)) a.lastSeen = f.lastSeen;
    }
    return [...agg.values()].map((a) => ({ ...a, avgLagSeconds: a.lagCount > 0 ? a.lagSum / a.lagCount : 0 }));
  }, [rawFlows]);

  const [flowSort, setFlowSort] = React.useState('totalBytesTransferred');
  const [flowSortDir, setFlowSortDir] = React.useState('desc');
  const sortedFlows = React.useMemo(() => {
    const dir = flowSortDir === 'desc' ? -1 : 1;
    return [...rawFlows].sort((a, b) => {
      if (flowSort === 'source') return dir * a.sourceCluster.localeCompare(b.sourceCluster);
      if (flowSort === 'target') return dir * a.targetCluster.localeCompare(b.targetCluster);
      if (flowSort === 'runCount') return dir * (a.runCount - b.runCount);
      if (flowSort === 'successCount') return dir * (a.successCount - b.successCount);
      if (flowSort === 'failureCount') return dir * (a.failureCount - b.failureCount);
      if (flowSort === 'successRate') {
        const ar = a.runCount > 0 ? a.successCount / a.runCount : 0;
        const br = b.runCount > 0 ? b.successCount / b.runCount : 0;
        return dir * (ar - br);
      }
      if (flowSort === 'avgLagSeconds') return dir * ((a.avgLagSeconds || 0) - (b.avgLagSeconds || 0));
      return dir * ((a.totalBytesTransferred || 0) - (b.totalBytesTransferred || 0));
    });
  }, [rawFlows, flowSort, flowSortDir]);

  const [clSort, setClSort] = React.useState('total');
  const [clSortDir, setClSortDir] = React.useState('desc');
  const sortedByCluster = React.useMemo(() => {
    const dir = clSortDir === 'desc' ? -1 : 1;
    return [...byCluster].sort((a, b) => {
      if (clSort === 'name') return dir * String(a.cluster).localeCompare(String(b.cluster));
      if (clSort === 'failure') return dir * ((a.failed ?? a.failure ?? 0) - (b.failed ?? b.failure ?? 0));
      if (clSort === 'successRate') return dir * ((a.successRate || 0) - (b.successRate || 0));
      return dir * ((a.total || 0) - (b.total || 0));
    });
  }, [byCluster, clSort, clSortDir]);

  const flowThClick = (key) => {
    if (flowSort === key) setFlowSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setFlowSort(key); setFlowSortDir('desc'); }
  };
  const clThClick = (key) => {
    if (clSort === key) setClSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setClSort(key); setClSortDir('desc'); }
  };
  const thStyle = (key, curSort, align = 'right') => ({
    textAlign: align,
    padding: '8px 10px',
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.03em',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    color: curSort === key ? 'var(--rbk-brand)' : 'var(--rbk-ink-muted)',
  });
  const tdStyle = { padding: '8px 10px', fontSize: 12, color: 'var(--rbk-ink)', borderTop: '1px solid var(--rbk-border)' };

  const trendDays = byDay.map((d) => {
    const dt = new Date(d.date);
    return { day: `${dt.getMonth() + 1}/${dt.getDate()}`, values: { success: d.success, failure: d.failure, warning: d.warning } };
  });
  const trendSeries = [
    { key: 'success', color: OK, label: 'Success' },
    { key: 'failure', color: CRIT, label: 'Failure' },
    { key: 'warning', color: WARN, label: 'Warning' },
  ];

  const failureRows = topErrors.map((e) => ({ label: e.errorMessage || '(unknown error)', value: e.count }));

  return (
    <div className="rbk-root rbk-fade-in">
      <PageHeader
        icon={ActivityIcon}
        title="Analytics"
        description="Backup job performance, SLA compliance, anomalies, and replication trends"
      />

      <div
        className="rbk-scroll"
        style={{
          position: 'sticky', top: 0, zIndex: 10, background: 'var(--rbk-surface-base)',
          display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center',
          padding: '8px 0', marginBottom: 16, borderBottom: '1px solid var(--rbk-border)',
        }}
      >
        <select className="rbk-input" style={{ width: 'auto' }} value={clusterId} onChange={(e) => setClusterId(e.target.value)}>
          <option value="">All Clusters</option>
          {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <div style={{ display: 'flex', gap: 4 }}>
          {[
            { d: 1, label: '24h' }, { d: 7, label: '7d' }, { d: 14, label: '14d' }, { d: 30, label: '30d' }, { d: 90, label: '90d' },
          ].map((opt) => (
            <button
              key={opt.d}
              onClick={() => setDays(opt.d)}
              className={`rbk-pill${days === opt.d ? ' rbk-pill-active' : ''}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <RefreshButton onClick={refresh} refreshing={loading} />
        <LastUpdated date={lastUpdated} prefix="Last refreshed" />
        {loading && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--rbk-ink-muted)' }}>
            <Spinner size={13} /> Loading analytics…
          </span>
        )}
      </div>

      <p className="rbk-panel-title" style={{ margin: '0 0 12px' }}>Backup Job Analytics</p>
      <div className="rbk-stagger" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
        <div style={{ ['--rbk-i']: 0 }}><StatCard label="Total Runs" value={backupSummary.total ?? '—'} loading={protection.loading && backupSummary.total == null} icon={ChartIcon} /></div>
        <div style={{ ['--rbk-i']: 1 }}><StatCard label="Success Rate" value={backupSummary.successRate != null ? `${backupSummary.successRate}%` : '—'}
          tone={backupSummary.successRate == null ? 'default' : backupSummary.successRate >= 90 ? 'ok' : backupSummary.successRate >= 70 ? 'warn' : 'crit'} /></div>
        <div style={{ ['--rbk-i']: 2 }}><StatCard label="Failed" value={backupSummary.failure ?? '—'} tone={(backupSummary.failure ?? 0) > 0 ? 'crit' : 'ok'} /></div>
        <div style={{ ['--rbk-i']: 3 }}><StatCard label="Warning" value={backupSummary.warning ?? '—'} tone={(backupSummary.warning ?? 0) > 0 ? 'warn' : 'default'} /></div>
      </div>

      {backupSummary.total === 0 || backup.summary == null ? (
        <div style={{ marginBottom: 24 }}>
          <Panel><EmptyState icon={ChartIcon} title="No backup run data" description="Data will appear after the next poll cycle." /></Panel>
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
            <Panel title="Job Performance Trend" icon={ChartIcon}>
              {trendDays.length > 0 ? (
                <StackedVBar days={trendDays} series={trendSeries} width={460} height={200} />
              ) : (
                <EmptyState title="No data" />
              )}
            </Panel>
            <Panel title="Top Failure Reasons" icon={ChartIcon}>
              {failureRows.length > 0 ? (
                <TopFailuresBar rows={failureRows} width={440} />
              ) : (
                <EmptyState title="No errors recorded" />
              )}
            </Panel>
          </div>

          <Panel title="Protection Run Failures by Cluster" style={{ marginBottom: 24 }}>
            <div className="rbk-scroll" style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={thStyle('name', clSort, 'left')} onClick={() => clThClick('name')}>Cluster</th>
                    <th style={thStyle('total', clSort)} onClick={() => clThClick('total')}>Total</th>
                    <th style={thStyle('failure', clSort)} onClick={() => clThClick('failure')}>Failed</th>
                    <th style={thStyle('successRate', clSort)} onClick={() => clThClick('successRate')}>Success Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedByCluster.map((row, i) => (
                    <tr key={row.cluster || i} className="rbk-row">
                      <td style={{ ...tdStyle, textAlign: 'left' }}>{row.cluster}</td>
                      <td className="rbk-tnum" style={{ ...tdStyle, textAlign: 'right' }}>{row.total}</td>
                      <td className="rbk-tnum" style={{ ...tdStyle, textAlign: 'right', color: CRIT }}>{row.failed ?? row.failure ?? 0}</td>
                      <td className="rbk-tnum" style={{ ...tdStyle, textAlign: 'right', fontWeight: 600, color: successColor(row.successRate) }}>
                        {row.successRate != null ? `${row.successRate}%` : '—'}
                      </td>
                    </tr>
                  ))}
                  {sortedByCluster.length === 0 && (
                    <tr><td colSpan={4} style={{ ...tdStyle, textAlign: 'center', color: 'var(--rbk-ink-faint)' }}>No data</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}

      <p className="rbk-panel-title" style={{ margin: '0 0 12px' }}>Replication Data Flow</p>
      <div className="rbk-stagger" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
        <div style={{ ['--rbk-i']: 0 }}><StatCard label="Runs" value={replSummary.total ?? '—'} icon={ArrowsIcon} /></div>
        <div style={{ ['--rbk-i']: 1 }}><StatCard label="Success Rate" value={replSummary.successRate != null ? `${replSummary.successRate}%` : '—'}
          tone={replSummary.successRate == null ? 'default' : replSummary.successRate >= 90 ? 'ok' : replSummary.successRate >= 70 ? 'warn' : 'crit'} /></div>
        <div style={{ ['--rbk-i']: 2 }}><StatCard label="Data Transferred" value={fmtBytes(replSummary.totalBytesTransferred)} tone="brand" /></div>
      </div>

      {replSummary.total === 0 || replData.summary == null ? (
        <div style={{ marginBottom: 24 }}>
          <Panel><EmptyState icon={ArrowsIcon} title="No replication data" description="No replication data available for this period." /></Panel>
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
            <MeshPanel title="Cluster Replication Mesh" flows={flows} />
            <MeshPanel title="Site-Level Replication Mesh" note="Site derived from first 4 characters of cluster names" flows={siteFlows} />
          </div>

          <Panel title="Replication Flows Detail">
            <div className="rbk-scroll" style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={thStyle('source', flowSort, 'left')} onClick={() => flowThClick('source')}>Source</th>
                    <th style={thStyle('target', flowSort, 'left')} onClick={() => flowThClick('target')}>Target</th>
                    <th style={thStyle('runCount', flowSort)} onClick={() => flowThClick('runCount')}>Runs</th>
                    <th style={thStyle('successCount', flowSort)} onClick={() => flowThClick('successCount')}>Success</th>
                    <th style={thStyle('failureCount', flowSort)} onClick={() => flowThClick('failureCount')}>Failures</th>
                    <th style={thStyle('successRate', flowSort)} onClick={() => flowThClick('successRate')}>Success Rate</th>
                    <th style={thStyle('totalBytesTransferred', flowSort)} onClick={() => flowThClick('totalBytesTransferred')}>Bytes</th>
                    <th style={thStyle('avgLagSeconds', flowSort)} onClick={() => flowThClick('avgLagSeconds')}>Avg Lag</th>
                    <th style={{ ...thStyle('lastSeen', flowSort), cursor: 'default' }}>Last Seen</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedFlows.map((f, i) => {
                    const rate = f.runCount > 0 ? Math.round((f.successCount / f.runCount) * 100) : 0;
                    return (
                      <tr key={i} className="rbk-row">
                        <td style={{ ...tdStyle, textAlign: 'left' }}>{f.sourceCluster}</td>
                        <td style={{ ...tdStyle, textAlign: 'left' }}>{f.targetCluster}</td>
                        <td className="rbk-tnum" style={{ ...tdStyle, textAlign: 'right' }}>{f.runCount}</td>
                        <td className="rbk-tnum" style={{ ...tdStyle, textAlign: 'right', color: OK }}>{f.successCount}</td>
                        <td className="rbk-tnum" style={{ ...tdStyle, textAlign: 'right', color: CRIT }}>{f.failureCount}</td>
                        <td className="rbk-tnum" style={{ ...tdStyle, textAlign: 'right', fontWeight: 600, color: successColor(rate) }}>{rate}%</td>
                        <td className="rbk-tnum" style={{ ...tdStyle, textAlign: 'right' }}>{fmtBytes(f.totalBytesTransferred)}</td>
                        <td className="rbk-tnum" style={{ ...tdStyle, textAlign: 'right' }}>{formatLag(f.avgLagSeconds)}</td>
                        <td className="rbk-tnum" style={{ ...tdStyle, textAlign: 'right' }}>{f.lastSeen ? new Date(f.lastSeen).toLocaleDateString() : '—'}</td>
                      </tr>
                    );
                  })}
                  {sortedFlows.length === 0 && (
                    <tr><td colSpan={9} style={{ ...tdStyle, textAlign: 'center', color: 'var(--rbk-ink-faint)' }}>No data</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
