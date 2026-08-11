import { useEffect, useState, useCallback } from 'react';
import { Server } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum, fmtRatio, ftTone, ftLabel } from './helpers';

export default function NxClustersPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/nutanix/clusters')
    .then(({ data }) => { setRows(data.clusters || []); setLastRefreshed(new Date()); })
    .catch(() => { setRows([]); toast({ type: 'error', title: 'Failed to load clusters' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const list = (rows || []).map(c => ({
    ...c,
    usage_pct: c.usage_pct ?? (c.storage_capacity_bytes > 0 ? (c.storage_usage_bytes / c.storage_capacity_bytes) * 100 : null),
    is_ce: !!(c.is_ce ?? c.source_is_ce),
  }));
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'aos_version', 'source_name', 'uuid'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Server} title="Clusters" description="Nutanix clusters across all registered Prism sources">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by cluster, AOS version or source…"
          filters={[{ k: 'source_name', label: 'Sources' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading clusters…" height={160} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No clusters found — register a Prism source under Settings.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No clusters match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Cluster" ctl={ctl} />
                <SortTh k="source_name" label="Source" ctl={ctl} />
                <SortTh k="aos_version" label="AOS" ctl={ctl} />
                <SortTh k="num_nodes" label="Nodes" ctl={ctl} align="right" />
                <SortTh k="redundancy_factor" label="RF" ctl={ctl} align="right" />
                <th className="py-2 pr-3 text-left text-[11px] uppercase tracking-wide">FT Tolerable</th>
                <SortTh k="usage_pct" label="Storage Used" ctl={ctl} align="right" />
                <SortTh k="overall_reduction_ratio_ppm" label="Reduction" ctl={ctl} align="right" />
                <SortTh k="runway_days" label="Runway" ctl={ctl} align="right" />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((c) => (
                  <tr key={c.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">
                      {c.name || c.uuid}
                      {c.is_ce && <Badge tone="info" className="ml-1.5">CE</Badge>}
                    </td>
                    <td className="py-2 pr-3 text-ink-muted">{c.source_name}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{c.aos_version || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(c.num_nodes)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{c.redundancy_factor ?? '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={ftTone(c)}>{ftLabel(c)}</Badge></td>
                    <td className={`py-2 pr-3 text-right tnum ${c.usage_pct > 80 ? 'text-status-warn font-semibold' : 'text-ink-muted'}`}>{c.usage_pct != null ? `${c.usage_pct.toFixed(0)}%` : '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtRatio(c.overall_reduction_ratio_ppm ?? c.reduction_ratio_ppm)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{c.runway_days != null ? `${c.runway_days}d` : '—'}</td>
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
