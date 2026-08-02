import { useEffect, useState, useCallback } from 'react';
import { Database, ShieldAlert } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtBytes, fmtNum, fmtWhen } from './helpers';

const isPublic = (b) => !b.publicAccessBlocked;

export default function AwsS3Page() {
  const { toast } = useToast();
  const [buckets, setBuckets] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/aws/s3')
    .then(({ data }) => { setBuckets(data?.buckets || []); setLastRefreshed(new Date()); })
    .catch(() => { setBuckets([]); toast({ type: 'error', title: 'Failed to load S3 data' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const list = buckets || [];
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'region', 'account'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });
  const publicCount = list.filter(isPublic).length;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Database} title="S3" description="S3 buckets across all registered AWS accounts">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center gap-2 mb-3">
          <p className="text-sm font-semibold text-ink">Buckets</p>
          {publicCount > 0 && <Badge tone="warn"><ShieldAlert size={11} className="inline mr-1" />{fmtNum(publicCount)} public</Badge>}
        </div>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by bucket, region or account…"
          filters={[{ k: 'region', label: 'Regions' }, { k: 'versioning', label: 'Versioning' }, { k: 'account', label: 'Accounts' }]} />
        {buckets == null ? (
          <LoadingPanel label="Loading…" height={140} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No S3 buckets found.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No buckets match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Bucket" ctl={ctl} />
                <SortTh k="region" label="Region" ctl={ctl} />
                <SortTh k="sizeBytes" label="Size" ctl={ctl} align="right" />
                <SortTh k="objectCount" label="Objects" ctl={ctl} align="right" />
                <SortTh k="publicAccessBlocked" label="Public Access" ctl={ctl} />
                <SortTh k="versioning" label="Versioning" ctl={ctl} />
                <SortTh k="lifecycleRules" label="Lifecycle Rules" ctl={ctl} align="right" />
                <SortTh k="createdAt" label="Created" ctl={ctl} />
                <SortTh k="account" label="Account" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((b) => (
                  <tr key={`${b.account}|${b.name}`} className={`border-b border-cohesity-border/50 ${isPublic(b) ? 'bg-status-warn/5' : ''}`}>
                    <td className="py-2 pr-3 text-ink">{b.name}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{b.region || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(b.sizeBytes)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(b.objectCount)}</td>
                    <td className="py-2 pr-3">
                      {isPublic(b) ? <Badge tone="warn">Public</Badge> : <Badge tone="ok">Blocked</Badge>}
                    </td>
                    <td className="py-2 pr-3 text-ink-muted">{b.versioning || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(b.lifecycleRules)}</td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{fmtWhen(b.createdAt)}</td>
                    <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{b.account}</td>
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
