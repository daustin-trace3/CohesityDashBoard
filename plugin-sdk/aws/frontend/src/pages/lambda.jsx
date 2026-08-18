// Ported from frontend/src/pages/aws/AwsLambdaPage.jsx.
import { Zap } from '../icons.jsx';
import {
  apiFetch, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager, BRAND, fmtNum, fmtBytes, fmtWhen,
} from '../ui.jsx';

const hasErrors = (f) => Number(f.errors24h) > 0;

export default function AwsLambdaPage() {
  const [functions, setFunctions] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [error, setError] = React.useState(null);

  const load = React.useCallback(() => apiFetch('/aws/lambda')
    .then((json) => { setFunctions(json?.functions || []); setLastRefreshed(new Date()); setError(null); })
    .catch(() => { setFunctions([]); setError('Failed to load Lambda data'); }), []);

  React.useEffect(() => { load(); }, [load]);

  const list = functions || [];
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'runtime', 'account'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });
  const errorCount = list.filter(hasErrors).length;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Zap} title="Lambda" description="Lambda functions across all registered AWS accounts">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {error && <div className="panel p-3 mb-4 border border-status-crit/50"><p className="text-sm text-status-crit">{error}</p></div>}

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center gap-2 mb-3">
          <p className="text-sm font-semibold text-ink">Functions</p>
          {errorCount > 0 && <Badge tone="crit">{fmtNum(errorCount)} with errors (24h)</Badge>}
        </div>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by name, runtime or account…"
          filters={[{ k: 'runtime', label: 'Runtimes' }, { k: 'account', label: 'Accounts' }]} />
        {functions == null ? (
          <LoadingPanel label="Loading functions…" height={140} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No Lambda functions found.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No functions match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Function" ctl={ctl} />
                <SortTh k="runtime" label="Runtime" ctl={ctl} />
                <SortTh k="memoryMb" label="Memory" ctl={ctl} align="right" />
                <SortTh k="timeoutS" label="Timeout" ctl={ctl} align="right" />
                <SortTh k="codeSizeBytes" label="Code Size" ctl={ctl} align="right" />
                <SortTh k="invocations24h" label="Invocations (24h)" ctl={ctl} align="right" />
                <SortTh k="errors24h" label="Errors (24h)" ctl={ctl} align="right" />
                <SortTh k="avgDurationMs" label="Avg Duration" ctl={ctl} align="right" />
                <SortTh k="lastModified" label="Last Modified" ctl={ctl} />
                <SortTh k="account" label="Account" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((f) => {
                  const err = hasErrors(f);
                  return (
                    <tr key={`${f.account}|${f.name}`} className={`border-b border-cohesity-border/50 ${err ? 'bg-status-crit/10' : ''}`}>
                      <td className="py-2 pr-3 text-ink">{f.name}</td>
                      <td className="py-2 pr-3 text-ink-muted">{f.runtime || '—'}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{f.memoryMb != null ? `${fmtNum(f.memoryMb)} MB` : '—'}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{f.timeoutS != null ? `${fmtNum(f.timeoutS)}s` : '—'}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(f.codeSizeBytes)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(f.invocations24h)}</td>
                      <td className={`py-2 pr-3 text-right tnum ${err ? 'text-status-crit font-semibold' : 'text-ink-muted'}`}>{fmtNum(f.errors24h)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{f.avgDurationMs != null ? `${Number(f.avgDurationMs).toFixed(0)} ms` : '—'}</td>
                      <td className="py-2 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{fmtWhen(f.lastModified)}</td>
                      <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{f.account}</td>
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
