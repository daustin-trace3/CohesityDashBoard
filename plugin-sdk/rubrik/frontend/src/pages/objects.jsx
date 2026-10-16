// Rubrik v2.1.0 Protected Objects page — restyled from the v1-era _shared.jsx
// look onto the ui.jsx kit (PageHeader/Panel/table-controls/Badge). Keeps the
// existing type/SLA/cluster filters; the Name cell now links to the new
// Object 360 drill-in page (see RUBRIK_V21_CONTRACT WP3).
import {
  PageHeader, Panel, Badge, SkeletonTable, EmptyState, TablePager,
  useTableControls, SortTh, FilterSelect,
  BoxesIcon,
} from '../ui';

const OBJECT_TYPES = ['All', 'VM', 'MSSQL DB', 'NAS Share', 'EC2 Instance'];

function fmtBytes(b) {
  if (b == null) return '—';
  if (b >= 1e12) return `${(b / 1e12).toLocaleString(undefined, { maximumFractionDigits: 2 })} TB`;
  if (b >= 1e9) return `${(b / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  if (b >= 1e6) return `${(b / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
  return `${Number(b).toLocaleString()} B`;
}
function fmtWhen(iso) {
  if (!iso) return '—';
  const raw = typeof iso === 'string' && !iso.includes('T') ? `${iso.replace(' ', 'T')}Z` : iso;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return String(iso);
  const diffH = (d.getTime() - Date.now()) / 3600000;
  if (diffH > 0 && diffH < 48) return `in ${Math.round(diffH)}h`;
  if (diffH <= 0 && diffH > -48) return `${Math.round(-diffH)}h ago`;
  return d.toLocaleDateString();
}

export default function ObjectsPage() {
  const [objects, setObjects] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [type, setType] = React.useState('');

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch('/api/rubrik/objects', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`request failed: ${res.status}`))))
      .then((json) => { if (!cancelled) setObjects(Array.isArray(json) ? json : []); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const typeFiltered = React.useMemo(
    () => (type ? objects.filter((o) => o.type === type) : objects),
    [objects, type]
  );

  const ctl = useTableControls(typeFiltered, {
    searchKeys: ['name'],
    defaultSortKey: 'name',
    defaultSortDir: 'asc',
    sortValues: {
      nextSnapshotAt: (o) => (o.nextSnapshotAt ? new Date(o.nextSnapshotAt.replace(' ', 'T') + 'Z').getTime() : 0),
      compliant: (o) => (o.compliant ? 1 : 0),
    },
    paginate: true,
    defaultPageSize: 50,
  });
  const pageRows = ctl.pageRows;

  const clearFilters = () => { setType(''); ctl.setQ(''); ctl.setFilter('slaDomain', ''); ctl.setFilter('clusterName', ''); };

  return (
    <div className="rbk-root rbk-fade-in">
      <PageHeader icon={BoxesIcon} title="Protected Objects" description="Every workload Rubrik is aware of, and its current compliance posture" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {OBJECT_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => setType(t === 'All' ? '' : t)}
              className={(t === 'All' ? type === '' : type === t) ? 'rbk-pill rbk-pill-active' : 'rbk-pill'}
            >
              {t}
            </button>
          ))}
        </div>
        <FilterSelect ctl={ctl} k="slaDomain" rows={typeFiltered} label="SLAs" />
        <FilterSelect ctl={ctl} k="clusterName" rows={typeFiltered} label="Clusters" />
        <div style={{ position: 'relative', width: '100%', maxWidth: 280 }}>
          <input
            value={ctl.q}
            onChange={(e) => ctl.setQ(e.target.value)}
            placeholder="Search objects…"
            className="rbk-input"
          />
        </div>
        <span className="rbk-tnum" style={{ fontSize: 11, color: 'var(--rbk-ink-faint)', marginLeft: 'auto' }}>
          {ctl.rows.length === objects.length ? `${objects.length} objects` : `${ctl.rows.length} of ${objects.length} objects`}
        </span>
      </div>

      {error && (
        <div role="alert" style={{ background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', color: 'var(--rbk-crit)', borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 13 }}>
          {error}
        </div>
      )}

      {loading ? (
        <Panel><SkeletonTable rows={8} colWidths={['22%', '12%', '14%', '14%', '12%', '10%', '16%', '14%']} /></Panel>
      ) : ctl.rows.length === 0 ? (
        <Panel>
          <EmptyState icon={BoxesIcon} title="No objects found" description="Try adjusting your filters to see more results.">
            <button onClick={clearFilters} className="rbk-btn-ghost" style={{ marginTop: 4 }}>Clear filters</button>
          </EmptyState>
        </Panel>
      ) : (
        <Panel>
          <div className="rbk-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--rbk-border)' }}>
                  <SortTh k="name" label="Name" ctl={ctl} />
                  <SortTh k="type" label="Type" ctl={ctl} />
                  <SortTh k="clusterName" label="Cluster" ctl={ctl} />
                  <SortTh k="slaDomain" label="SLA Domain" ctl={ctl} />
                  <SortTh k="nextSnapshotAt" label="Next Snapshot" ctl={ctl} />
                  <SortTh k="snapshotCount" label="Snapshots" ctl={ctl} align="right" />
                  <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--rbk-ink-muted)' }}>Local / Archived</th>
                  <SortTh k="compliant" label="Compliance" ctl={ctl} />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((o) => (
                  <tr key={o.id} className="rbk-row" style={{ borderBottom: '1px solid var(--rbk-border)', background: o.compliant ? 'transparent' : 'rgba(248,113,113,0.06)' }}>
                    <td style={{ padding: '8px 12px 8px 0' }}>
                      <ReactRouterDOM.Link
                        to={`/ops/server360?name=${encodeURIComponent(o.name)}`}
                        title="Open Server 360"
                        style={{ color: 'var(--rbk-ink)', fontWeight: 500, textDecoration: 'none' }}
                        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--rbk-brand)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--rbk-ink)'; }}
                      >
                        {o.name}
                      </ReactRouterDOM.Link>
                    </td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-muted)' }}>{o.type}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-muted)' }}>{o.clusterName}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-muted)' }}>{o.slaDomain}</td>
                    <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-faint)' }}>{fmtWhen(o.nextSnapshotAt)}</td>
                    <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--rbk-ink-muted)' }}>{o.snapshotCount}</td>
                    <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-faint)' }}>
                      {fmtBytes(o.localStorageBytes)} / {fmtBytes(o.archivedBytes)}
                    </td>
                    <td style={{ padding: '8px 12px 8px 0' }}>
                      <Badge tone={o.compliant ? 'ok' : 'crit'}>{o.compliant ? 'Compliant' : 'Out of Compliance'}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePager ctl={ctl} />
        </Panel>
      )}
    </div>
  );
}
