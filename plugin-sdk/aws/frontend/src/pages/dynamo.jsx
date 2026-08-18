// Ported from frontend/src/pages/aws/AwsDynamoPage.jsx.
import { Table2 } from '../icons.jsx';
import {
  apiFetch, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager, BRAND, fmtNum, fmtBytes,
} from '../ui.jsx';

const statusTone = (s) => {
  const v = String(s || '').toLowerCase();
  if (v === 'active') return 'ok';
  if (v.includes('creating') || v.includes('updating')) return 'warn';
  return 'neutral';
};

export default function AwsDynamoPage() {
  const [tables, setTables] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [error, setError] = React.useState(null);

  const load = React.useCallback(() => apiFetch('/aws/dynamo')
    .then((json) => { setTables(json?.tables || []); setLastRefreshed(new Date()); setError(null); })
    .catch(() => { setTables([]); setError('Failed to load DynamoDB data'); }), []);

  React.useEffect(() => { load(); }, [load]);

  const list = tables || [];
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'billingMode', 'account'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Table2} title="DynamoDB" description="DynamoDB tables across all registered AWS accounts">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {error && <div className="panel p-3 mb-4 border border-status-crit/50"><p className="text-sm text-status-crit">{error}</p></div>}

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Tables</p>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by name, billing mode or account…"
          filters={[{ k: 'billingMode', label: 'Billing Modes' }, { k: 'status', label: 'Statuses' }, { k: 'account', label: 'Accounts' }]} />
        {tables == null ? (
          <LoadingPanel label="Loading tables…" height={140} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No DynamoDB tables found.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No tables match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Table" ctl={ctl} />
                <SortTh k="status" label="Status" ctl={ctl} />
                <SortTh k="billingMode" label="Billing Mode" ctl={ctl} />
                <SortTh k="itemCount" label="Items" ctl={ctl} align="right" />
                <SortTh k="sizeBytes" label="Size" ctl={ctl} align="right" />
                <SortTh k="readCapacity" label="Read Capacity" ctl={ctl} align="right" />
                <SortTh k="writeCapacity" label="Write Capacity" ctl={ctl} align="right" />
                <SortTh k="account" label="Account" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((t) => (
                  <tr key={`${t.account}|${t.name}`} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{t.name}</td>
                    <td className="py-2 pr-3"><Badge tone={statusTone(t.status)}>{t.status || '—'}</Badge></td>
                    <td className="py-2 pr-3 text-ink-muted">{t.billingMode || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(t.itemCount)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(t.sizeBytes)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{t.readCapacity != null ? fmtNum(t.readCapacity) : '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{t.writeCapacity != null ? fmtNum(t.writeCapacity) : '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{t.account}</td>
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
