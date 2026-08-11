// Nutanix Alerts — port of NxAlertsPage.jsx onto the nx- style kit (Prism
// alerts, not the computed issues page).
import {
  injectStyles, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager,
  BellIcon, severityTone, fmtWhen,
} from '../ui.jsx';

injectStyles();

const BRAND = '#7855FA';

const td = { padding: '8px 12px 8px 0', fontSize: 13, color: 'var(--nx-ink)', borderBottom: '1px solid var(--nx-border)' };
const tdMuted = { ...td, color: 'var(--nx-ink-muted)' };

export default function AlertsPage() {
  const [rows, setRows] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => fetch('/api/nutanix/alerts', { credentials: 'include' })
    .then((res) => { if (!res.ok) throw new Error(String(res.status)); return res.json(); })
    .then((json) => { setRows(json.alerts || []); setLastRefreshed(new Date()); })
    .catch(() => setRows([])), []);

  React.useEffect(() => { load(); }, [load]);

  const list = (rows || []).map((a) => ({
    ...a,
    state: a.resolved ? 'Resolved' : a.acknowledged ? 'Acknowledged' : 'Open',
  }));
  const ctl = useTableControls(list, {
    searchKeys: ['title', 'message', 'entity_name', 'cluster_name'],
    defaultSortKey: 'created_at', defaultSortDir: 'desc',
    paginate: true,
  });

  return (
    <div className="nx-root nx-fade-in">
      <PageHeader icon={BellIcon} title="Alerts" description="Prism alerts across all registered Nutanix clusters">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="nx-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by title, message, entity or cluster…"
          filters={[
            { k: 'severity', label: 'Severities' },
            { k: 'cluster_name', label: 'Clusters' },
            { k: 'state', label: 'States' },
          ]} />
        {rows == null ? (
          <LoadingPanel label="Loading alerts…" height={160} />
        ) : list.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nx-ok)', padding: '24px 0', textAlign: 'center' }}>No alerts.</div>
        ) : ctl.rows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nx-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No alerts match your filters.</div>
        ) : (
          <div className="nx-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ borderBottom: '1px solid var(--nx-border)' }}>
                <SortTh k="severity" label="Severity" ctl={ctl} />
                <SortTh k="title" label="Title" ctl={ctl} />
                <SortTh k="entity_name" label="Entity" ctl={ctl} />
                <SortTh k="cluster_name" label="Cluster" ctl={ctl} />
                <SortTh k="state" label="State" ctl={ctl} />
                <SortTh k="created_at" label="Created" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((a) => (
                  <tr key={a.id} className="nx-row">
                    <td style={td}><Badge tone={severityTone(a.severity)}>{a.severity}</Badge></td>
                    <td style={{ ...td, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.message || a.title}>{a.title || a.message || '—'}</td>
                    <td style={{ ...tdMuted, fontSize: 11 }}>{a.entity_type ? `${a.entity_type}: ` : ''}{a.entity_name || '—'}</td>
                    <td style={tdMuted}>{a.cluster_name || '—'}</td>
                    <td style={td}><Badge tone={a.resolved ? 'ok' : a.acknowledged ? 'info' : 'warn'}>{a.state}</Badge></td>
                    <td className="nx-tnum" style={{ ...td, fontSize: 11, color: 'var(--nx-ink-faint)' }}>{fmtWhen(a.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>
    </div>
  );
}
