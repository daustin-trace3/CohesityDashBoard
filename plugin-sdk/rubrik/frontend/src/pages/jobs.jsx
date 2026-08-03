// Rubrik v2.0.0 Jobs page — restyled onto the rbk- kit (./ui). Same data,
// same fetch (/jobs), same client-side jobType filter and failed-job list.

import {
  PageHeader, Badge, SkeletonTable, EmptyState, TablePager, TableSearch,
  useTableControls, SortTh, RefreshButton, fmtBytes,
  ActivityIcon,
} from '../ui';

const API_BASE = '/api/rubrik';

function apiFetch(path) {
  return fetch(`${API_BASE}${path}`, { credentials: 'include' }).then((res) => {
    if (!res.ok) throw new Error(`request failed: ${res.status}`);
    return res.json();
  });
}

const JOB_TYPES = ['All', 'Backup', 'Replication', 'Archival'];

function StatusBadge({ status }) {
  const tone = status === 'Succeeded' ? 'ok' : status === 'Failed' ? 'crit' : status === 'Running' ? 'info' : 'warn';
  return <Badge tone={tone}>{status || '—'}</Badge>;
}

function formatWhen(iso) {
  if (!iso) return '—';
  const d = new Date(typeof iso === 'string' && !iso.includes('T') ? iso.replace(' ', 'T') + 'Z' : iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffH = (Date.now() - d.getTime()) / (1000 * 60 * 60);
  if (diffH < -1) return `in ${Math.round(-diffH)}h`;
  if (diffH < 1) return `${Math.max(1, Math.round(diffH * 60))}m ago`;
  if (diffH < 48) return `${Math.round(diffH)}h ago`;
  return d.toLocaleString();
}

function formatDuration(seconds) {
  if (seconds == null) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

export default function JobsPage() {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [filter, setFilter] = React.useState('All');

  const loadJobs = React.useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch('/jobs')
      .then((rows) => setData(rows || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => { loadJobs(); }, [loadJobs]);

  const rows = React.useMemo(
    () => (data || []).filter((j) => filter === 'All' || j.jobType === filter),
    [data, filter]
  );

  const ctl = useTableControls(rows, {
    searchKeys: ['objectName', 'clusterName'],
    defaultSortKey: 'startedAt',
    defaultSortDir: 'desc',
    paginate: true,
    defaultPageSize: 25,
  });

  const failedJobs = rows.filter((j) => j.status === 'Failed');

  return (
    <div className="rbk-root rbk-fade-in">
      <PageHeader icon={ActivityIcon} title="Jobs" description="Backup, replication, and archival job runs across every monitored cluster">
        <RefreshButton onClick={loadJobs} refreshing={loading} />
      </PageHeader>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {JOB_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => setFilter(t)}
              className={`rbk-pill${filter === t ? ' rbk-pill-active' : ''}`}
            >
              {t}
            </button>
          ))}
        </div>
        <TableSearch ctl={ctl} placeholder="Search jobs…" />
        <span className="rbk-tnum" style={{ fontSize: 11, color: 'var(--rbk-ink-faint)', marginLeft: 'auto' }}>
          {loading ? '…' : `${ctl.rows.length} job(s)`}
        </span>
      </div>

      {error && (
        <div role="alert" style={{ background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', color: 'var(--rbk-crit)', borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 13 }}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="rbk-panel" style={{ padding: 16 }}>
          <SkeletonTable rows={8} colWidths={['20%', '12%', '14%', '12%', '16%', '12%', '14%']} />
        </div>
      ) : ctl.rows.length === 0 ? (
        <div className="rbk-panel" style={{ padding: 16 }}>
          <EmptyState icon={ActivityIcon} title="No jobs found" description="Try adjusting your filters to see more results." />
        </div>
      ) : (
        <div className="rbk-panel" style={{ padding: 16 }}>
          <div className="rbk-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--rbk-border)' }}>
                  <SortTh k="objectName" label="Object" ctl={ctl} />
                  <SortTh k="jobType" label="Type" ctl={ctl} />
                  <SortTh k="clusterName" label="Cluster" ctl={ctl} />
                  <SortTh k="status" label="Status" ctl={ctl} />
                  <SortTh k="startedAt" label="Started" ctl={ctl} />
                  <SortTh k="durationSeconds" label="Duration" ctl={ctl} align="right" />
                  <SortTh k="dataTransferredBytes" label="Data" ctl={ctl} align="right" />
                </tr>
              </thead>
              <tbody>
                {ctl.pageRows.map((j) => (
                  <tr key={j.id} className="rbk-row" style={{ borderBottom: '1px solid var(--rbk-border)', background: j.status === 'Failed' ? 'rgba(248,113,113,0.08)' : 'transparent' }}>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink)' }}>{j.objectName}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-muted)' }}>{j.jobType}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-muted)' }}>{j.clusterName}</td>
                    <td style={{ padding: '8px 12px 8px 0' }}><StatusBadge status={j.status} /></td>
                    <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-faint)', fontSize: 11, whiteSpace: 'nowrap' }}>{formatWhen(j.startedAt)}</td>
                    <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--rbk-ink-muted)' }}>{formatDuration(j.durationSeconds)}</td>
                    <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--rbk-ink-muted)' }}>{fmtBytes(j.dataTransferredBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePager ctl={ctl} />

          {failedJobs.length > 0 && (
            <div style={{ paddingTop: 12, marginTop: 4, borderTop: '1px solid var(--rbk-border)' }}>
              {failedJobs.map((j) => (
                <div key={j.id} style={{ fontSize: 12, color: 'var(--rbk-ink-muted)', marginBottom: 4 }}>
                  <span style={{ color: 'var(--rbk-crit)', fontWeight: 600 }}>{j.objectName}:</span> {j.errorMessage}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
