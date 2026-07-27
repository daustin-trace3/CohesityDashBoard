import { useEffect, useState, useCallback } from 'react';
import { Boxes } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtWhen, healthTone, fmtPct } from './helpers';

export default function AriaOpsResourcesPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/ariaops/resources')
    .then(({ data }) => { setRows(data); setLastRefreshed(new Date()); })
    .catch(() => { setRows([]); toast({ type: 'error', title: 'Failed to load resources' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'instance_name', 'kind'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Boxes} title="Resources" description="VMs, hosts and datastores across all registered Aria Operations instances">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by name, kind or instance…"
          filters={[{ k: 'instance_name', label: 'Instances' }, { k: 'kind', label: 'Kinds' }, { k: 'health', label: 'Health' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading resources…" height={140} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No resources found — register an Aria Operations instance under Settings.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No resources match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="instance_name" label="Instance" ctl={ctl} />
                <SortTh k="name" label="Name" ctl={ctl} />
                <SortTh k="kind" label="Kind" ctl={ctl} />
                <SortTh k="health" label="Health" ctl={ctl} />
                <SortTh k="cpu_pct" label="CPU" ctl={ctl} align="right" />
                <SortTh k="mem_pct" label="Mem" ctl={ctl} align="right" />
                <SortTh k="captured_at" label="Captured" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((r) => (
                  <tr key={`${r.instance_id}|${r.resource_id}`} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{r.instance_name}</td>
                    <td className="py-2 pr-3 text-ink">{r.name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{r.kind || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={healthTone(r.health)}>{r.health || '—'}</Badge></td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtPct(r.cpu_pct)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtPct(r.mem_pct)}</td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">{fmtWhen(r.captured_at)}</td>
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
