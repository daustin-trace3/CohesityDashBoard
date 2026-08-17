import { CheckSquare } from '../icons.jsx';
import {
  apiFetch, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated, timeAgo,
  useTableControls, SortTh, TableControls, TablePager,
  BRAND, fmtWhen, asDate, statusTone,
} from '../ui.jsx';

export default function AriaApprovalsPage() {
  const [rows, setRows] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => apiFetch('/aria/approvals')
    .then((json) => { setRows(json); setLastRefreshed(new Date()); })
    .catch(() => setRows([])), []);

  React.useEffect(() => { load(); }, [load]);

  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['subject', 'instance_name', 'requested_by'],
    defaultSortKey: 'created_at_src', defaultSortDir: 'asc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={CheckSquare} title="Approvals" description="Pending and resolved approval requests across all registered Aria instances">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by subject or requester…"
          filters={[{ k: 'instance_name', label: 'Instances' }, { k: 'status', label: 'Statuses' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading approvals…" height={140} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No approval requests found — register an Aria instance under Settings.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No approvals match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="instance_name" label="Instance" ctl={ctl} />
                <SortTh k="subject" label="Subject" ctl={ctl} />
                <SortTh k="requested_by" label="Requested By" ctl={ctl} />
                <SortTh k="status" label="Status" ctl={ctl} />
                <SortTh k="created_at_src" label="Created" ctl={ctl} />
                <th className="py-2 pr-3 text-right">Pending For</th>
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((a, i) => {
                  const pending = /pending/i.test(a.status || '');
                  return (
                    <tr key={`${a.instance_name}|${a.approval_id}|${i}`} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{a.instance_name}</td>
                      <td className="py-2 pr-3 text-ink">{a.subject || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{a.requested_by || '—'}</td>
                      <td className="py-2 pr-3"><Badge tone={statusTone(a.status)}>{a.status || '—'}</Badge></td>
                      <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">{fmtWhen(a.created_at_src)}</td>
                      <td className={`py-2 pr-3 text-right text-[11px] tnum ${pending ? 'text-status-warn font-semibold' : 'text-ink-faint'}`}>
                        {timeAgo(asDate(a.created_at_src)) || '—'}
                      </td>
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
