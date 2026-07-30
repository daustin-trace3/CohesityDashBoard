import { useEffect, useState, useCallback } from 'react';
import { Workflow, ArrowLeftRight } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum, fmtWhen } from './helpers';

export default function NbSlpPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/netbackup/slps')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ slps: [], replication: { jobs24h: 0, failed24h: 0, jobs7d: 0, failed7d: 0, byPolicy: [] } }); toast({ type: 'error', title: 'Failed to load SLP data' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const slps = data?.slps || [];
  const replication = data?.replication || { jobs24h: 0, failed24h: 0, jobs7d: 0, failed7d: 0, byPolicy: [] };

  const slpCtl = useTableControls(slps, {
    searchKeys: ['name', 'sourceName', 'dataClassification'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });
  const policyCtl = useTableControls(replication.byPolicy || [], {
    searchKeys: ['policyName', 'sourceName'],
    defaultSortKey: 'total7d', defaultSortDir: 'desc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Workflow} title="SLP / Replication" description="Storage Lifecycle Policies and replication/duplication job outcomes">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={ArrowLeftRight} label="Replication Jobs (24h)" value={fmtNum(replication.jobs24h)} />
        <StatCard icon={ArrowLeftRight} label="Failed (24h)" value={fmtNum(replication.failed24h)}
          tone={replication.failed24h ? 'crit' : 'ok'} />
        <StatCard icon={ArrowLeftRight} label="Replication Jobs (7d)" value={fmtNum(replication.jobs7d)} />
        <StatCard icon={ArrowLeftRight} label="Failed (7d)" value={fmtNum(replication.failed7d)}
          tone={replication.failed7d ? 'warn' : 'ok'} />
      </div>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Storage Lifecycle Policies</p>
        {data == null ? (
          <LoadingPanel label="Loading SLPs…" height={140} />
        ) : slps.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No SLPs found — the source may not expose an SLP API, or none are configured.</div>
        ) : (
          <>
            <TableControls ctl={slpCtl} rows={slps} searchPlaceholder="Filter by name, source or classification…"
              filters={[{ k: 'sourceName', label: 'Sources' }, { k: 'dataClassification', label: 'Classifications' }]} />
            {slpCtl.rows.length === 0 ? (
              <div className="text-sm text-ink-muted py-6 text-center">No SLPs match your filters.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                    <SortTh k="name" label="Name" ctl={slpCtl} />
                    <SortTh k="sourceName" label="Source" ctl={slpCtl} />
                    <SortTh k="dataClassification" label="Classification" ctl={slpCtl} />
                    <SortTh k="priority" label="Priority" ctl={slpCtl} align="right" />
                    <SortTh k="operationCount" label="Operations" ctl={slpCtl} align="right" />
                  </tr></thead>
                  <tbody>
                    {slpCtl.pageRows.map((s) => (
                      <tr key={s.id} className="border-b border-cohesity-border/50">
                        <td className="py-2 pr-3 text-ink font-medium">{s.name}</td>
                        <td className="py-2 pr-3 text-ink-muted">{s.sourceName}</td>
                        <td className="py-2 pr-3 text-ink-muted">{s.dataClassification || '—'}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{s.priority ?? '—'}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted cursor-default"
                          title={(s.operations || []).length ? JSON.stringify(s.operations, null, 2) : 'No operations'}>
                          {fmtNum(s.operationCount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <TablePager ctl={slpCtl} />
          </>
        )}
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><ArrowLeftRight size={15} className="text-brand" /> Replication by Policy</p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={140} />
        ) : (replication.byPolicy || []).length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No replication/duplication jobs in the last 7 days.</div>
        ) : (
          <>
            <TableControls ctl={policyCtl} rows={replication.byPolicy} searchPlaceholder="Filter by policy or source…"
              filters={[{ k: 'sourceName', label: 'Sources' }]} />
            {policyCtl.rows.length === 0 ? (
              <div className="text-sm text-ink-muted py-6 text-center">No rows match your filters.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                    <SortTh k="policyName" label="Policy" ctl={policyCtl} />
                    <SortTh k="sourceName" label="Source" ctl={policyCtl} />
                    <SortTh k="total7d" label="Jobs (7d)" ctl={policyCtl} align="right" />
                    <SortTh k="failed7d" label="Failed (7d)" ctl={policyCtl} align="right" />
                    <SortTh k="lastStatus" label="Last Status" ctl={policyCtl} />
                    <SortTh k="lastRunAt" label="Last Run" ctl={policyCtl} align="right" />
                  </tr></thead>
                  <tbody>
                    {policyCtl.pageRows.map((p, i) => (
                      <tr key={`${p.sourceId}|${p.policyName}|${i}`} className="border-b border-cohesity-border/50">
                        <td className="py-2 pr-3 text-ink font-medium">{p.policyName || '—'}</td>
                        <td className="py-2 pr-3 text-ink-muted">{p.sourceName}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink">{fmtNum(p.total7d)}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(p.failed7d)}</td>
                        <td className="py-2 pr-3"><Badge tone={p.failed7d ? 'crit' : 'ok'}>{p.lastStatus || '—'}</Badge></td>
                        <td className="py-2 pr-3 text-right tnum text-ink-faint text-[11px]">{fmtWhen(p.lastRunAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <TablePager ctl={policyCtl} />
          </>
        )}
      </div>
    </div>
  );
}
