import { useEffect, useState, useCallback, useMemo } from 'react';
import { Wrench, DollarSign, ListChecks, BadgeCheck, PiggyBank, RotateCcw, Power } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtUsd } from './helpers';
import { getOptimizer } from './finops/finopsApi';
import RecStateMenu from './finops/RecStateMenu';
import { useUrlParam } from './finops/shared';

const STATUS_CHIPS = [['all', 'All'], ['open', 'Open'], ['accepted', 'Accepted'], ['dismissed', 'Dismissed'], ['done', 'Done']];
const STATUS_TONE = { open: 'neutral', accepted: 'brand', dismissed: 'neutral', done: 'ok' };
const SOURCE_BADGE = {
  'compute-optimizer': { tone: 'brand', text: 'CO', title: 'AWS Compute Optimizer' },
  'ce-rightsizing': { tone: 'info', text: 'CE', title: 'Cost Explorer rightsizing' },
  'ce-savings-plan': { tone: 'ok', text: 'SP', title: 'Cost Explorer Savings Plan purchase recommendation' },
  'cost-optimization-hub': { tone: 'ok', text: 'Hub', title: 'AWS Cost Optimization Hub (savings after your discounts)' },
  heuristic: { tone: 'neutral', text: 'Heuristic', title: 'ICC heuristic' },
};
const ICC_RIGHTSIZE = { tone: 'info', text: 'ICC', title: 'ICC rightsizing heuristic: CPU only, no memory data' };
const EFFORT_TONE = { low: 'ok', medium: 'warn', high: 'crit' };
const effortLabel = (e) => { const t = String(e || '').toLowerCase(); return t === 'verylow' ? 'Low' : t ? t.charAt(0).toUpperCase() + t.slice(1) : ''; };
const statusOf = (r) => r?.state?.status || 'open';

export default function AwsOptimizerPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [status, setStatus] = useUrlParam('status', 'all');
  const [dupParam, setDupParam] = useUrlParam('includeShadowed', '');
  const includeShadowed = dupParam === '1';

  // Always loads every status; the chips filter the loaded rows so the tiles and counts stay whole.
  const load = useCallback(() => getOptimizer(includeShadowed ? { status: 'all', includeShadowed: 1 } : { status: 'all' })
    .then((d) => { setData(d); setLastRefreshed(new Date()); })
    .catch(() => { setData({ totals: { count: 0, estMonthlySavingsUsd: 0, coEnrollment: null, lastCapture: null }, recommendations: [] }); toast({ type: 'error', title: 'Failed to load Optimizer data' }); }), [toast, includeShadowed]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await client.post('/aws/optimizer/refresh');
      toast({ type: 'success', title: 'Re-capture queued - refresh in a few minutes' });
    } catch {
      toast({ type: 'error', title: 'Failed to queue re-capture' });
    } finally {
      setRefreshing(false);
    }
  };

  const totals = data?.totals || {};
  const all = useMemo(() => data?.recommendations || [], [data]);
  const counts = useMemo(() => {
    const c = { all: all.length, open: 0, accepted: 0, dismissed: 0, done: 0 };
    all.forEach((r) => { const s = statusOf(r); if (c[s] != null) c[s] += 1; });
    return c;
  }, [all]);
  const hubCount = useMemo(() => all.filter((r) => r.source === 'cost-optimization-hub' && !r.shadowedBy).length, [all]);
  const potentialUsd = useMemo(
    () => all.filter((r) => ['open', 'accepted'].includes(statusOf(r)) && !r.shadowedBy).reduce((s, r) => s + (Number(r.estMonthlySavingsUsd) || 0), 0),
    [all],
  );
  const recs = useMemo(() => (status === 'all' ? all : all.filter((r) => statusOf(r) === status)), [all, status]);

  const ctl = useTableControls(recs, {
    searchKeys: ['resourceId', 'resourceName', 'region', 'finding', 'account'],
    defaultSortKey: 'estMonthlySavingsUsd', defaultSortDir: 'desc',
    sortValues: { estMonthlySavingsUsd: (r) => (r.estMonthlySavingsUsd == null ? -Infinity : r.estMonthlySavingsUsd), status: statusOf },
    paginate: true,
  });

  const enrollment = totals.coEnrollment;
  const enrolled = enrollment === 'Active';

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Wrench} title="Optimizer" description="Cost and rightsizing recommendations from AWS Compute Optimizer, Cost Explorer and our own heuristics, with a lifecycle per recommendation">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={onRefresh} refreshing={refreshing} />
      </PageHeader>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 mb-4">
        <StatCard icon={DollarSign} label="Potential Monthly Savings" value={fmtUsd(data ? potentialUsd : null)} sub={hubCount > 0 ? 'open and accepted, Hub rows are after discounts' : 'open and accepted'} tone="brand" />
        <StatCard icon={PiggyBank} label="Realized (90 days)" value={fmtUsd(totals.realized90dUsd ?? 0)} sub="recommendations resolved" tone={totals.realized90dUsd > 0 ? 'ok' : 'default'} />
        <StatCard icon={ListChecks} label="Open Recommendations" value={counts.open + counts.accepted} sub={`${counts.open} open, ${counts.accepted} accepted`} />
        <StatCard icon={BadgeCheck} label="Compute Optimizer" value={enrollment || 'Unknown'}
          sub={enrolled ? 'enrolled' : 'not enrolled or grant missing - other sources only'}
          tone={enrolled ? 'ok' : 'warn'} />
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <p className="text-sm font-semibold text-ink">Recommendations</p>
          <label className="flex items-center gap-1.5 text-xs text-ink-muted cursor-pointer ml-auto"
            title="Show recommendations that another source already covers for the same resource">
            <input type="checkbox" checked={includeShadowed} onChange={(e) => setDupParam(e.target.checked ? '1' : '')} className="accent-brand cursor-pointer" />
            Show duplicates{totals.shadowed ? <span className="text-ink-faint tnum">{totals.shadowed}</span> : null}
          </label>
          <div className="flex rounded-lg border border-cohesity-border overflow-hidden" role="group" aria-label="Status">
            {STATUS_CHIPS.map(([v, text]) => (
              <button key={v} type="button" aria-pressed={status === v} onClick={() => setStatus(v)}
                className={`px-2.5 py-1.5 text-xs cursor-pointer ${status === v ? 'bg-surface-overlay text-ink font-semibold' : 'text-ink-muted hover:text-ink'}`}>
                {text} <span className="text-ink-faint tnum">{counts[v] ?? 0}</span>
              </button>
            ))}
          </div>
        </div>
        <TableControls ctl={ctl} rows={recs} searchPlaceholder="Filter by resource ID, name, region, finding or account..."
          filters={[{ k: 'source', label: 'Sources' }, { k: 'resourceType', label: 'Resource Types' }, { k: 'account', label: 'Accounts' }]} />
        {data == null ? (
          <LoadingPanel label="Loading recommendations..." height={180} />
        ) : all.length === 0 ? (
          <div className="text-sm text-ink-muted py-8 text-center">No recommendations yet.</div>
        ) : recs.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No {status} recommendations.</div>
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
                <SortTh k="effort" label="Effort" ctl={ctl} />
                <th className="py-2 pr-3">Flags</th>
                <SortTh k="estMonthlySavingsUsd" label="Est. Savings" ctl={ctl} align="right" />
                <SortTh k="status" label="Status" ctl={ctl} />
                <th className="py-2 pr-3">Action</th>
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((r) => {
                  const st = statusOf(r);
                  const src = r.source === 'heuristic' && r.finding === 'ec2-low-utilization'
                    ? ICC_RIGHTSIZE
                    : (SOURCE_BADGE[r.source] || { tone: 'neutral', text: r.source, title: r.source });
                  return (
                    <tr key={r.key || `${r.account}|${r.source}|${r.resourceType}|${r.resourceId}`} className={`border-b border-cohesity-border/50 ${st === 'dismissed' || r.shadowedBy ? 'opacity-60' : ''}`}>
                      <td className="py-2 pr-3"><span title={src.title}><Badge tone={src.tone}>{src.text}</Badge></span></td>
                      <td className="py-2 pr-3 text-ink-muted uppercase text-[11px]">{r.resourceType}</td>
                      <td className="py-2 pr-3 text-ink">
                        {r.resourceName || r.resourceId}
                        {r.resourceName && r.resourceName !== r.resourceId && (
                          <span className="block text-[11px] text-ink-faint">{r.resourceId}</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-ink-muted text-[11px]">{r.region || '-'}</td>
                      <td className="py-2 pr-3 text-ink-muted">
                        {r.finding || '-'}
                        {r.shadowedBy && <span className="block text-[11px] text-ink-faint">shadowed by {r.shadowedBy}</span>}
                      </td>
                      <td className="py-2 pr-3 text-ink-muted text-[11px]">{r.currentConfig || '-'}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[11px]">{r.recommendedConfig || '-'}</td>
                      <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{r.account}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {r.effort ? <Badge tone={EFFORT_TONE[String(r.effort).toLowerCase()] || 'neutral'}>{effortLabel(r.effort)}</Badge> : <span className="text-ink-faint">-</span>}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5 text-ink-muted">
                          {r.restartNeeded ? <span title="Needs a restart"><Power size={13} /></span> : null}
                          {r.rollbackPossible ? <span title="Can be rolled back"><RotateCcw size={13} /></span> : null}
                          {!r.restartNeeded && !r.rollbackPossible && <span className="text-ink-faint">-</span>}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-right tnum text-ink">
                        {fmtUsd(r.estMonthlySavingsUsd)}
                        {r.afterDiscounts ? <span className="block text-[11px] text-ink-faint">after discounts</span> : null}
                        {st === 'done' && r.state?.realizedUsd != null && (
                          <span className="block text-[11px] text-status-ok">realized {fmtUsd(r.state.realizedUsd)}</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 min-w-[110px]">
                        <Badge tone={STATUS_TONE[st] || 'neutral'}>{st}</Badge>
                        {r.state?.note && <span className="block text-[11px] text-ink-faint max-w-[200px] truncate" title={r.state.note}>{r.state.note}</span>}
                      </td>
                      <td className="py-2 pr-3"><RecStateMenu rec={r} onChanged={load} /></td>
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
