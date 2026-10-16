// Rubrik v2.0.0 Events page — restyled onto the rbk- kit (./ui). Same data,
// same fetch (/events?days=7[&severity=]), same client-side type filter.

import {
  PageHeader, Badge, SkeletonTable, EmptyState, TablePager, TableSearch,
  useTableControls, SortTh, RefreshButton,
  BellIcon,
} from '../ui';

const API_BASE = '/api/rubrik';

function apiFetch(path) {
  return fetch(`${API_BASE}${path}`, { credentials: 'include' }).then((res) => {
    if (!res.ok) throw new Error(`request failed: ${res.status}`);
    return res.json();
  });
}

const EVENT_TYPES = ['All', 'Backup', 'Replication', 'Archival', 'Security', 'System', 'Maintenance'];
const SEVERITIES = ['All', 'Critical', 'Warning', 'Info'];

function SeverityBadge({ severity }) {
  const s = String(severity || '').toLowerCase();
  const tone = s === 'critical' ? 'crit' : s === 'warning' ? 'warn' : 'info';
  return <Badge tone={tone}>{severity || '—'}</Badge>;
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

export default function EventsPage() {
  const [severity, setSeverity] = React.useState('All');
  const [type, setType] = React.useState('All');
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);

  const loadEvents = React.useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch(`/events?days=7${severity !== 'All' ? `&severity=${severity}` : ''}`)
      .then((rows) => setData(rows || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [severity]);

  React.useEffect(() => { loadEvents(); }, [loadEvents]);

  const rows = React.useMemo(
    () => (data || []).filter((e) => type === 'All' || e.eventType === type),
    [data, type]
  );

  const ctl = useTableControls(rows, {
    searchKeys: ['message', 'objectName', 'cluster'],
    defaultSortKey: 'at',
    defaultSortDir: 'desc',
    paginate: true,
    defaultPageSize: 25,
  });

  return (
    <div className="rbk-root rbk-fade-in">
      <PageHeader icon={BellIcon} title="Events" description="Backup, replication, archival, and system events across every monitored cluster">
        <RefreshButton onClick={loadEvents} refreshing={loading} />
      </PageHeader>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {SEVERITIES.map((s) => (
            <button
              key={s}
              onClick={() => setSeverity(s)}
              className={`rbk-pill${severity === s ? ' rbk-pill-active' : ''}`}
            >
              {s}
            </button>
          ))}
        </div>
        <select value={type} onChange={(e) => setType(e.target.value)} className="rbk-input" style={{ width: 'auto', cursor: 'pointer' }}>
          {EVENT_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <TableSearch ctl={ctl} placeholder="Search events…" />
        <span className="rbk-tnum" style={{ fontSize: 11, color: 'var(--rbk-ink-faint)', marginLeft: 'auto' }}>
          {loading ? '…' : `${ctl.rows.length} event(s)`}
        </span>
      </div>

      {error && (
        <div role="alert" style={{ background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', color: 'var(--rbk-crit)', borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 13 }}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="rbk-panel" style={{ padding: 16 }}>
          <SkeletonTable rows={8} colWidths={['10%', '12%', '14%', '16%', '32%', '12%']} />
        </div>
      ) : ctl.rows.length === 0 ? (
        <div className="rbk-panel" style={{ padding: 16 }}>
          <EmptyState icon={BellIcon} title="No events found" description="Try adjusting your filters to see more results." />
        </div>
      ) : (
        <div className="rbk-panel" style={{ padding: 16 }}>
          <div className="rbk-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--rbk-border)' }}>
                  <SortTh k="severity" label="Severity" ctl={ctl} />
                  <SortTh k="eventType" label="Type" ctl={ctl} />
                  <SortTh k="cluster" label="Cluster" ctl={ctl} />
                  <SortTh k="objectName" label="Object" ctl={ctl} />
                  <SortTh k="message" label="Message" ctl={ctl} />
                  <SortTh k="at" label="When" ctl={ctl} />
                </tr>
              </thead>
              <tbody>
                {ctl.pageRows.map((e) => (
                  <tr key={e.id} className="rbk-row" style={{ borderBottom: '1px solid var(--rbk-border)' }}>
                    <td style={{ padding: '8px 12px 8px 0' }}><SeverityBadge severity={e.severity} /></td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink)' }}>{e.eventType}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-muted)' }}>{e.cluster || '—'}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-muted)' }}>{e.objectName || '—'}</td>
                    <td style={{ padding: '8px 12px 8px 0', maxWidth: 360 }}>
                      <span title={e.message} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--rbk-ink-muted)' }}>
                        {e.message}
                      </span>
                    </td>
                    <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-faint)', fontSize: 11, whiteSpace: 'nowrap' }}>{formatWhen(e.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePager ctl={ctl} />
        </div>
      )}
    </div>
  );
}
