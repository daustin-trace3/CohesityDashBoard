import { Activity } from '../icons.jsx';
import {
  apiFetch, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager,
  BRAND, fmtWhen, statusTone,
} from '../ui.jsx';

export default function AriaActivityPage() {
  const [rows, setRows] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => apiFetch('/aria/requests')
    .then((json) => { setRows(json); setLastRefreshed(new Date()); })
    .catch(() => setRows([])), []);

  React.useEffect(() => { load(); }, [load]);

  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'instance_name', 'requested_by', 'deployment_id'],
    defaultSortKey: 'updated_at_src', defaultSortDir: 'desc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Activity} title="Activity" description="Recent deployment requests across all registered Aria instances, newest first">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by name, requester or deployment…"
          filters={[{ k: 'instance_name', label: 'Instances' }, { k: 'status', label: 'Statuses' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading activity…" height={140} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No request activity found — register an Aria instance under Settings.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No requests match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="instance_name" label="Instance" ctl={ctl} />
                <SortTh k="name" label="Name" ctl={ctl} />
                <SortTh k="status" label="Status" ctl={ctl} />
                <SortTh k="requested_by" label="Requested By" ctl={ctl} />
                <SortTh k="updated_at_src" label="Updated" ctl={ctl} />
                <th className="py-2 pr-3">Detail</th>
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((r) => {
                  const tone = statusTone(r.status);
                  return (
                    <tr key={`${r.instance_name}|${r.request_id}`} className={`border-b border-cohesity-border/50 ${tone === 'crit' ? 'bg-status-crit/5' : ''}`}>
                      <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{r.instance_name}</td>
                      <td className="py-2 pr-3 text-ink">{r.name || '—'}</td>
                      <td className="py-2 pr-3"><Badge tone={tone}>{r.status || '—'}</Badge></td>
                      <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{r.requested_by || '—'}</td>
                      <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">{fmtWhen(r.updated_at_src)}</td>
                      <td className={`py-2 pr-3 text-[11px] max-w-[320px] truncate ${tone === 'crit' ? 'text-status-crit' : 'text-ink-faint'}`} title={r.detail || ''}>{r.detail || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>
    </div>
  );
}
