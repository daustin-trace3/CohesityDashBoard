import { useEffect, useState, useCallback } from 'react';
import { Wrench, DollarSign, ListChecks, BadgeCheck } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtUsd } from './helpers';

export default function AwsOptimizerPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/aws/optimizer')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ totals: { count: 0, estMonthlySavingsUsd: 0, coEnrollment: null, lastCapture: null }, recommendations: [] }); toast({ type: 'error', title: 'Failed to load Optimizer data' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await client.post('/aws/optimizer/refresh');
      toast({ type: 'success', title: 'Re-capture queued — refresh in a few minutes' });
    } catch {
      toast({ type: 'error', title: 'Failed to queue re-capture' });
    } finally {
      setRefreshing(false);
    }
  };

  const totals = data?.totals || {};
  const recs = data?.recommendations || [];
  const ctl = useTableControls(recs, {
    searchKeys: ['resourceId', 'resourceName', 'region', 'finding', 'account'],
    defaultSortKey: 'estMonthlySavingsUsd', defaultSortDir: 'desc',
    sortValues: { estMonthlySavingsUsd: (r) => (r.estMonthlySavingsUsd == null ? -Infinity : r.estMonthlySavingsUsd) },
    paginate: true,
  });

  const enrollment = totals.coEnrollment;
  const enrolled = enrollment === 'Active';

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Wrench} title="Optimizer" description="Cost and rightsizing recommendations from AWS Compute Optimizer plus our own heuristics">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={onRefresh} refreshing={refreshing} />
      </PageHeader>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <StatCard icon={DollarSign} label="Potential Monthly Savings" value={fmtUsd(totals.estMonthlySavingsUsd)} sub="summed across recommendations" tone="brand" />
        <StatCard icon={ListChecks} label="Recommendations" value={totals.count ?? 0} sub="open findings" />
        <StatCard icon={BadgeCheck} label="Compute Optimizer" value={enrollment || 'Unknown'}
          sub={enrolled ? 'enrolled' : 'AWS Compute Optimizer not enrolled or grant missing — heuristic findings only'}
          tone={enrolled ? 'ok' : 'warn'} />
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Recommendations</p>
        <TableControls ctl={ctl} rows={recs} searchPlaceholder="Filter by resource ID, name, region, finding or account…"
          filters={[{ k: 'source', label: 'Sources' }, { k: 'resourceType', label: 'Resource Types' }, { k: 'account', label: 'Accounts' }]} />
        {data == null ? (
          <LoadingPanel label="Loading recommendations…" height={180} />
        ) : recs.length === 0 ? (
          <div className="text-sm text-ink-muted py-8 text-center">No recommendations yet.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No recommendations match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="source" label="Source" ctl={ctl} />
                <SortTh k="resourceType" label="Type" ctl={ctl} />
                <SortTh k="resourceName" label="Resource" ctl={ctl} />
                <SortTh k="region" label="Region" ctl={ctl} />
                <SortTh k="finding" label="Finding" ctl={ctl} />
                <th className="py-2 pr-3">Current</th>
                <th className="py-2 pr-3">Recommended</th>
                <SortTh k="account" label="Account" ctl={ctl} />
                <SortTh k="estMonthlySavingsUsd" label="Est. Savings" ctl={ctl} align="right" />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((r) => (
                  <tr key={`${r.account}|${r.source}|${r.resourceType}|${r.resourceId}`} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3">
                      <Badge tone={r.source === 'compute-optimizer' ? 'brand' : 'neutral'}>
                        {r.source === 'compute-optimizer' ? 'CO' : 'Heuristic'}
                      </Badge>
                    </td>
                    <td className="py-2 pr-3 text-ink-muted uppercase text-[11px]">{r.resourceType}</td>
                    <td className="py-2 pr-3 text-ink">
                      {r.resourceName || r.resourceId}
                      {r.resourceName && r.resourceName !== r.resourceId && (
                        <span className="block text-[11px] text-ink-faint">{r.resourceId}</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{r.region || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{r.finding || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{r.currentConfig || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{r.recommendedConfig || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{r.account}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink">{fmtUsd(r.estMonthlySavingsUsd)}</td>
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
