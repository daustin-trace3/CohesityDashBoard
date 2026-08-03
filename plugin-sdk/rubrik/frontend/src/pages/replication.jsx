// Rubrik v2.0.0 Replication page — mirrors host
// frontend/src/pages/ReplicationPage.jsx using ONLY the rbk- kit
// (./ui, ./charts), with the v1.2.1 pairs/archival tables kept below as a
// second "Topology & Archival" section. Default export name is unchanged so
// index.jsx keeps resolving it.

import { PageHeader, StatCard, SkeletonTable, RefreshButton, LastUpdated, ArrowsIcon } from '../ui';
import { AMBER, TEXT, MUTED, panelStyle, thStyle, tdStyle, StatusPill as LegacyStatusPill, useFetch, formatWhen, formatLag, formatBytes as legacyFormatBytes } from './_shared';

const API_BASE = '/api/rubrik';

function apiFetch(path) {
  return fetch(`${API_BASE}${path}`, { credentials: 'include' }).then((res) => {
    if (!res.ok) throw new Error(`request failed: ${res.status}`);
    return res.json();
  });
}

function formatBytes(bytes) {
  if (bytes == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDateTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

const STATUS_TONE = {
  Active: { bg: 'rgba(96,165,250,0.1)', color: '#60A5FA', border: 'rgba(96,165,250,0.25)' },
  Completed: { bg: 'rgba(52,211,153,0.1)', color: '#34D399', border: 'rgba(52,211,153,0.25)' },
  Failed: { bg: 'rgba(248,113,113,0.1)', color: '#F87171', border: 'rgba(248,113,113,0.25)' },
};

function RunStatusPill({ status }) {
  const t = STATUS_TONE[status] || { bg: 'var(--rbk-surface-overlay)', color: 'var(--rbk-ink-muted)', border: 'var(--rbk-border)' };
  return <span className="rbk-chip" style={{ background: t.bg, color: t.color, borderColor: t.border }}>{status || '—'}</span>;
}

function progressColor(pct) {
  if (pct > 90) return 'var(--rbk-brand)';
  if (pct > 50) return '#FBBF24';
  return '#F87171';
}

function SectionHeading({ children }) {
  return <h2 style={{ fontSize: 12, fontWeight: 600, color: 'var(--rbk-ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '4px 0 12px' }}>{children}</h2>;
}

const RUN_COLS = [
  { key: 'jobName', label: 'Job Name', align: 'left' },
  { key: 'targetCluster', label: 'Target Cluster', align: 'left' },
  { key: 'status', label: 'Status', align: 'left' },
  { key: 'startMs', label: 'Start Time', align: 'left' },
  { key: 'logicalBytes', label: 'Data to Send', align: 'right' },
  { key: 'transferredBytes', label: 'Data Sent', align: 'right' },
  { key: 'progress', label: 'Progress', align: 'left' },
  { key: 'percentComplete', label: 'Transfer Ratio', align: 'right' },
];

export default function ReplicationPage() {
  const [clusters, setClusters] = React.useState([]);
  const [clusterId, setClusterId] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState('all');
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [sortBy, setSortBy] = React.useState('percentComplete');
  const [sortDir, setSortDir] = React.useState('desc');

  React.useEffect(() => {
    apiFetch('/clusters').then((rows) => setClusters(rows || [])).catch(() => {});
  }, []);

  const fetchData = React.useCallback(() => {
    setLoading(true);
    apiFetch('/replication/runs')
      .then((res) => { setData(res); setLastRefreshed(new Date()); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => { fetchData(); }, [fetchData]);

  const runs = data?.runs || [];
  const summary = data?.summary || {};

  // NOTE (contract gap): /replication/runs has no clusterId filter param
  // per the v2 route contract, so the cluster select filters client-side
  // against the source cluster of each run.
  const clusterFilteredRuns = React.useMemo(
    () => (clusterId ? runs.filter((r) => r.sourceCluster === clusterId) : runs),
    [runs, clusterId]
  );
  const statusFilteredRuns = React.useMemo(() => {
    if (statusFilter === 'active') return clusterFilteredRuns.filter((r) => r.status === 'Active');
    if (statusFilter === 'failed') return clusterFilteredRuns.filter((r) => r.status === 'Failed');
    return clusterFilteredRuns;
  }, [clusterFilteredRuns, statusFilter]);

  const sortedRuns = React.useMemo(() => {
    const arr = [...statusFilteredRuns];
    const dir = sortDir === 'desc' ? -1 : 1;
    arr.sort((a, b) => {
      if (sortBy === 'jobName') return dir * String(a.jobName || '').localeCompare(String(b.jobName || ''));
      if (sortBy === 'targetCluster') return dir * String(a.targetCluster || '').localeCompare(String(b.targetCluster || ''));
      if (sortBy === 'status') return dir * String(a.status || '').localeCompare(String(b.status || ''));
      if (sortBy === 'startMs') return dir * ((a.startMs || 0) - (b.startMs || 0));
      if (sortBy === 'logicalBytes') return dir * ((a.logicalBytes || 0) - (b.logicalBytes || 0));
      if (sortBy === 'transferredBytes') return dir * ((a.transferredBytes || 0) - (b.transferredBytes || 0));
      return dir * ((a.percentComplete || 0) - (b.percentComplete || 0));
    });
    return arr;
  }, [statusFilteredRuns, sortBy, sortDir]);

  const handleSort = (col) => {
    if (col === 'progress') return;
    if (sortBy === col) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortBy(col); setSortDir('desc'); }
  };

  const { data: topo, error: topoError } = useFetch('/replication');

  return (
    <div className="rbk-root rbk-fade-in">
      <PageHeader icon={ArrowsIcon} title="Replication" description="Live replication task status, lag, and throughput per cluster" />

      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--rbk-surface-base)', borderBottom: '1px solid var(--rbk-border)', padding: '8px 0', marginBottom: 16, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <select value={clusterId} onChange={(e) => setClusterId(e.target.value)} className="rbk-input" style={{ width: 'auto', cursor: 'pointer' }}>
          <option value="">All Clusters</option>
          {clusters.map((c) => <option key={c.id ?? c.name} value={c.name}>{c.name}</option>)}
        </select>

        <div style={{ display: 'flex', gap: 4 }}>
          {[
            { key: 'all', label: 'All' },
            { key: 'active', label: 'Active' },
            { key: 'failed', label: 'Failed' },
          ].map((s) => (
            <button key={s.key} onClick={() => setStatusFilter(s.key)} className={`rbk-pill${statusFilter === s.key ? ' rbk-pill-active' : ''}`}>
              {s.label}
            </button>
          ))}
        </div>

        <RefreshButton onClick={fetchData} refreshing={loading} />
        <LastUpdated date={lastRefreshed} prefix="Last refreshed" />
      </div>

      <div className="rbk-stagger" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
        <StatCard label="Total Replications" value={summary.total ?? clusterFilteredRuns.length} loading={loading && !data} />
        <StatCard label="Active" value={summary.active ?? '—'} tone="info" loading={loading && !data} />
        <StatCard label="Completed" value={summary.completed ?? '—'} tone="ok" loading={loading && !data} />
        <StatCard label="Failed" value={summary.failed ?? '—'} tone={(summary.failed ?? 0) > 0 ? 'crit' : 'default'} loading={loading && !data} />
      </div>

      <div className="rbk-panel" style={{ padding: 16, marginBottom: 24 }}>
        <p className="rbk-panel-title" style={{ marginBottom: 12 }}>Replication Runs</p>
        {loading && !data ? (
          <SkeletonTable rows={6} colWidths={['18%', '14%', '10%', '14%', '10%', '10%', '14%', '10%']} />
        ) : sortedRuns.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--rbk-ink-faint)', fontSize: 12 }}>
            No replication runs found for the selected filters.
          </div>
        ) : (
          <div className="rbk-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--rbk-border)' }}>
                  {RUN_COLS.map((col) => (
                    <th
                      key={col.key}
                      onClick={() => handleSort(col.key)}
                      style={{
                        textAlign: col.align,
                        padding: '8px 12px 8px 0',
                        fontSize: 11,
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.03em',
                        color: sortBy === col.key ? 'var(--rbk-ink)' : 'var(--rbk-ink-muted)',
                        cursor: col.key === 'progress' ? 'default' : 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedRuns.map((r, i) => {
                  const pct = Math.max(0, Math.min(100, r.percentComplete || 0));
                  return (
                    <tr key={`${r.jobName}-${r.startMs}-${i}`} style={{ background: i % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent' }}>
                      <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.jobName}>{r.jobName || '—'}</td>
                      <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-muted)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.targetCluster || '—'}</td>
                      <td style={{ padding: '8px 12px 8px 0' }}><RunStatusPill status={r.status} /></td>
                      <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-faint)', fontSize: 11, whiteSpace: 'nowrap' }}>{formatDateTime(r.startMs)}</td>
                      <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--rbk-ink-muted)' }}>{formatBytes(r.logicalBytes)}</td>
                      <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--rbk-ink-muted)' }}>{formatBytes(r.transferredBytes)}</td>
                      <td style={{ padding: '8px 12px 8px 0' }}>
                        <div style={{ height: 3, borderRadius: 999, background: 'var(--rbk-surface-overlay)', overflow: 'hidden', minWidth: 80 }}>
                          <div style={{ height: '100%', width: `${pct}%`, background: progressColor(pct), borderRadius: 999, transition: 'width 300ms ease' }} />
                        </div>
                      </td>
                      <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--rbk-brand)', fontWeight: 600 }}>{r.percentComplete != null ? `${r.percentComplete.toFixed(2)}%` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <SectionHeading>Topology &amp; Archival</SectionHeading>
        {topoError && (
          <div style={{ background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', color: 'var(--rbk-crit)', borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 13 }}>
            {topoError}
          </div>
        )}
        {topo && (
          <>
            <div style={{ ...panelStyle(), marginBottom: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, color: TEXT }}>Replication Pairs</div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Source</th>
                    <th style={thStyle}>Target</th>
                    <th style={thStyle}>Objects</th>
                    <th style={thStyle}>Lag</th>
                    <th style={thStyle}>Status</th>
                    <th style={thStyle}>Last Sync</th>
                  </tr>
                </thead>
                <tbody>
                  {topo.pairs.map((p) => (
                    <tr key={p.id} style={{ background: p.status === 'Lagging' ? `${AMBER}14` : 'transparent' }}>
                      <td style={tdStyle}>{p.sourceCluster}</td>
                      <td style={tdStyle}>{p.targetCluster}</td>
                      <td style={tdStyle}>{p.objects}</td>
                      <td style={{ ...tdStyle, color: p.status === 'Lagging' ? AMBER : TEXT }}>{formatLag(p.lagSeconds)}</td>
                      <td style={tdStyle}><LegacyStatusPill status={p.status} /></td>
                      <td style={tdStyle}>{formatWhen(p.lastSyncAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ marginTop: 10, fontSize: 12, color: MUTED }}>
                {topo.pairs.map((p) => `${p.sourceCluster} → ${p.targetCluster}`).join('   •   ')}
              </div>
            </div>

            <div style={panelStyle()}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, color: TEXT }}>Archival Locations</div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Name</th>
                    <th style={thStyle}>Type</th>
                    <th style={thStyle}>Archived</th>
                    <th style={thStyle}>Objects</th>
                    <th style={thStyle}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {topo.archival.map((a) => (
                    <tr key={a.id}>
                      <td style={tdStyle}>{a.name}</td>
                      <td style={tdStyle}>
                        <span
                          style={{
                            padding: '2px 8px',
                            borderRadius: 4,
                            fontSize: 11,
                            background: a.type === 'S3' ? `${AMBER}26` : '#3b82f626',
                            color: a.type === 'S3' ? AMBER : '#60a5fa',
                            border: `1px solid ${a.type === 'S3' ? AMBER : '#3b82f6'}`,
                          }}
                        >
                          {a.type}
                        </span>
                      </td>
                      <td style={tdStyle}>{legacyFormatBytes(a.archivedBytes)}</td>
                      <td style={tdStyle}>{a.objectCount}</td>
                      <td style={tdStyle}><LegacyStatusPill status={a.status === 'Active' ? 'Succeeded' : a.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
