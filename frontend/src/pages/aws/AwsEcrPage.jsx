import { useEffect, useState, useCallback } from 'react';
import { Package } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum, fmtBytes, fmtWhen } from './helpers';

export default function AwsEcrPage() {
  const { toast } = useToast();
  const [repos, setRepos] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/aws/ecr')
    .then(({ data }) => { setRepos(data?.repos || []); setLastRefreshed(new Date()); })
    .catch(() => { setRepos([]); toast({ type: 'error', title: 'Failed to load ECR data' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

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
