// Proxmox Events — ports host frontend/src/pages/proxmox/PxEventsPage.jsx.
import {
  injectStyles, PageHeader, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager,
  HistoryIcon, fmtWhen,
} from '../ui.jsx';

injectStyles();

const BRAND = '#E57000';

function apiGet(path, params) {
  const qs = params ? `?${new URLSearchParams(params)}` : '';
  return fetch(`/api/proxmox${path}${qs}`, { credentials: 'include' }).then((res) => {
    if (!res.ok) throw new Error(`request failed: ${res.status}`);
    return res.json();
  });
}

export default function PxEventsPage() {
  const [rows, setRows] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(() => {
    setLoading(true);
    return apiGet('/events', { limit: 200 })
      .then((d) => { setRows(d); setLastRefreshed(new Date()); })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const ctl = useTableControls(rows || [], {
    searchKeys: ['message', 'tag', 'user', 'node', 'serverName'],
    defaultSortKey: 'eventTime', defaultSortDir: 'desc',
    paginate: true,
  });

  return (
    <div className="px-root px-fade-in">
      <PageHeader icon={HistoryIcon} title="Events" description="Cluster log entries across all registered Proxmox servers">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} refreshing={loading} />
      </PageHeader>

      <div className="px-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--px-ink)', marginBottom: 12 }}>Cluster Log</p>
        <TableControls ctl={ctl} rows={rows || []} searchPlaceholder="Filter by message, tag, user or node…"
          filters={[{ k: 'serverName', label: 'Servers' }, { k: 'node', label: 'Nodes' }, { k: 'tag', label: 'Tags' }, { k: 'user', label: 'Users' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading events…" height={140} />
        ) : rows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--px-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No events recorded yet.</div>
        ) : ctl.rows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--px-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No events match your filters.</div>
        ) : (
          <div className="px-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--px-border)' }}>
                  <SortTh k="eventTime" label="Time" ctl={ctl} />
                  <SortTh k="node" label="Node" ctl={ctl} />
                  <SortTh k="serverName" label="Server" ctl={ctl} />
                  <SortTh k="tag" label="Tag" ctl={ctl} />
                  <SortTh k="user" label="User" ctl={ctl} />
                  <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-muted)' }}>Message</th>
                </tr>
              </thead>
              <tbody>
                {ctl.pageRows.map((e) => (
                  <tr key={e.id} className="px-row" style={{ borderBottom: '1px solid var(--px-border)' }}>
                    <td className="px-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-faint)', fontSize: 11, whiteSpace: 'nowrap' }}>{fmtWhen(e.eventTime)}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)' }}>{e.node}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)' }}>{e.serverName}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)', fontSize: 11 }}>{e.tag || '—'}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-faint)', fontSize: 11 }}>{e.user || '—'}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink)', fontSize: 12, lineHeight: 1.5, maxWidth: 420 }}>{e.message || '—'}</td>
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
