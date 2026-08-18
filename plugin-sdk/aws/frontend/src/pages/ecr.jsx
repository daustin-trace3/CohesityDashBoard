// Ported from frontend/src/pages/aws/AwsEcrPage.jsx.
import { Package } from '../icons.jsx';
import {
  apiFetch, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager, BRAND, fmtNum, fmtBytes, fmtWhen,
} from '../ui.jsx';

export default function AwsEcrPage() {
  const [repos, setRepos] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [error, setError] = React.useState(null);

  const load = React.useCallback(() => apiFetch('/aws/ecr')
    .then((json) => { setRepos(json?.repos || []); setLastRefreshed(new Date()); setError(null); })
    .catch(() => { setRepos([]); setError('Failed to load ECR data'); }), []);

  React.useEffect(() => { load(); }, [load]);

  const list = repos || [];
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'account'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Package} title="ECR" description="Elastic Container Registry repositories across all registered AWS accounts">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {error && <div className="panel p-3 mb-4 border border-status-crit/50"><p className="text-sm text-status-crit">{error}</p></div>}

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Repositories</p>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by repository or account…"
          filters={[{ k: 'account', label: 'Accounts' }]} />
        {repos == null ? (
          <LoadingPanel label="Loading repositories…" height={140} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No ECR repositories found.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No repositories match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Repository" ctl={ctl} />
                <SortTh k="imageCount" label="Images" ctl={ctl} align="right" />
                <SortTh k="sizeBytes" label="Size" ctl={ctl} align="right" />
                <SortTh k="scanOnPush" label="Scan on Push" ctl={ctl} />
                <SortTh k="latestPushAt" label="Latest Push" ctl={ctl} />
                <SortTh k="account" label="Account" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((r) => (
                  <tr key={`${r.account}|${r.name}`} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{r.name}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(r.imageCount)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(r.sizeBytes)}</td>
                    <td className="py-2 pr-3">{r.scanOnPush ? <Badge tone="ok">Enabled</Badge> : <Badge tone="neutral">Disabled</Badge>}</td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{fmtWhen(r.latestPushAt)}</td>
                    <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{r.account}</td>
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
