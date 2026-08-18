// NetApp Capacity — ported from frontend/src/pages/netapp/NetAppCapacityPage.jsx.
import { Database, HardDrive } from '../icons.jsx';
import { apiFetch, PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated, BRAND, fmtBytes, fmtRatio, statusTone, useTableControls, SortTh, TableControls } from '../ui.jsx';

const aggPct = (g) => (g.used_percent != null ? g.used_percent : (g.size_bytes ? (g.used_bytes / g.size_bytes) * 100 : 0));

export default function CapacityPage() {
  const [aggs, setAggs] = React.useState(null);
  const [quotas, setQuotas] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => {
    Promise.allSettled([apiFetch('/netapp/aggregates'), apiFetch('/netapp/quotas')]).then(([a, q]) => {
      if (a.status === 'fulfilled') { setAggs(a.value); setLastRefreshed(new Date()); } else setAggs([]);
      setQuotas(q.status === 'fulfilled' ? q.value : []);
    });
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const aggCtl = useTableControls(aggs, { searchKeys: ['name', 'array_name', 'node_name'], defaultSortKey: 'name', sortValues: { utilization: aggPct } });
  const quotaCtl = useTableControls(quotas, { searchKeys: ['svm_name', 'volume_name', 'qtree_name'], defaultSortKey: 'volume_name' });

  const totals = (aggs || []).reduce((a, g) => {
    a.size += g.size_bytes || 0; a.used += g.used_bytes || 0; a.physical += g.physical_used_bytes || 0; return a;
  }, { size: 0, used: 0, physical: 0 });
  const pct = totals.size ? Math.round((totals.used / totals.size) * 100) : 0;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Database} title="NetApp Capacity" description="Aggregate capacity and efficiency across all ONTAP clusters">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Database} label="Total Capacity" value={fmtBytes(totals.size)} tone="brand" />
        <StatCard icon={Database} label="Used" value={fmtBytes(totals.used)} sub={`${pct}% full`} />
        <StatCard icon={Database} label="Physical Used" value={fmtBytes(totals.physical)} />
        <StatCard icon={HardDrive} label="Aggregates" value={(aggs || []).length} />
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={aggCtl} rows={aggs} searchPlaceholder="Filter by aggregate, cluster or node…"
          filters={[{ k: 'array_name', label: 'Clusters' }, { k: 'node_name', label: 'Nodes' }, { k: 'state', label: 'States' }]} />
        {aggs == null ? (
          <LoadingPanel label="Loading aggregates…" />
        ) : aggs.length === 0 ? (
          <div className="text-sm text-ink-muted p-8 text-center">No aggregate data collected yet.</div>
        ) : aggCtl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted p-8 text-center">No aggregates match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b">
                  <SortTh k="name" label="Aggregate" ctl={aggCtl} />
                  <SortTh k="array_name" label="Cluster" ctl={aggCtl} />
                  <SortTh k="node_name" label="Node" ctl={aggCtl} />
                  <SortTh k="utilization" label="Utilization" ctl={aggCtl} />
                  <SortTh k="used_bytes" label="Used" ctl={aggCtl} align="right" />
                  <SortTh k="size_bytes" label="Size" ctl={aggCtl} align="right" />
                  <SortTh k="physical_used_bytes" label="Physical" ctl={aggCtl} align="right" />
                  <SortTh k="efficiency_ratio" label="Efficiency" ctl={aggCtl} align="right" />
                  <SortTh k="state" label="State" ctl={aggCtl} />
                </tr>
              </thead>
              <tbody>
                {aggCtl.rows.map((g) => {
                  const p = Math.round(aggPct(g));
                  const color = p >= 90 ? '#f87171' : p >= 75 ? '#fbbf24' : BRAND;
                  return (
                    <tr key={g.id} className="border-b">
                      <td className="py-2 pr-3 text-ink font-medium">{g.name}</td>
                      <td className="py-2 pr-3 text-ink-muted">{g.array_name}</td>
                      <td className="py-2 pr-3 text-ink-muted">{g.node_name || '—'}</td>
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-2">
                          <div style={{ height: 8, flex: 1, borderRadius: 999, background: 'var(--na-surface-overlay)', overflow: 'hidden' }}><div style={{ height: '100%', borderRadius: 999, width: `${p}%`, background: color }} /></div>
                          <span className="tnum text-ink-muted" style={{ fontSize: 11, width: 36, textAlign: 'right' }}>{p}%</span>
                        </div>
                      </td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(g.used_bytes)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(g.size_bytes)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(g.physical_used_bytes)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtRatio(g.efficiency_ratio)}</td>
                      <td className="py-2 pr-3"><Badge tone={statusTone(g.state)}>{g.state || 'unknown'}</Badge></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {quotas && quotas.length > 0 && (
        <div className="panel p-4 mt-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-3">Quota Reports ({quotas.length})</p>
          <TableControls ctl={quotaCtl} rows={quotas} searchPlaceholder="Filter by SVM, volume or qtree…"
            filters={[{ k: 'svm_name', label: 'SVMs' }, { k: 'type', label: 'Types' }]} />
          <div className="overflow-x-auto max-h-[50vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b">
                <SortTh k="svm_name" label="SVM" ctl={quotaCtl} />
                <SortTh k="volume_name" label="Volume" ctl={quotaCtl} />
                <SortTh k="qtree_name" label="Qtree" ctl={quotaCtl} />
                <SortTh k="type" label="Type" ctl={quotaCtl} />
                <SortTh k="space_used_bytes" label="Used" ctl={quotaCtl} align="right" />
                <SortTh k="space_hard_limit_bytes" label="Hard Limit" ctl={quotaCtl} align="right" />
              </tr></thead>
              <tbody>
                {quotaCtl.rows.map((q) => (
                  <tr key={q.id} className="border-b">
                    <td className="py-2 pr-3 text-ink-muted">{q.svm_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink">{q.volume_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{q.qtree_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{q.type || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(q.space_used_bytes)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(q.space_hard_limit_bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
