import { useEffect, useState, useCallback } from 'react';
import { Server } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum, fmtBytes, hostStateTone, hostStateLabel } from './helpers';

const pct = (used, cap) => (cap > 0 && used != null ? (used / cap) * 100 : null);

export default function VcHostsPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/vcenter/hosts')
    .then(({ data }) => { setRows(data); setLastRefreshed(new Date()); })
    .catch(() => { setRows([]); toast({ type: 'error', title: 'Failed to load hosts' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const list = (rows || []).map(h => ({
    ...h,
    state: hostStateLabel(h),
    cpu_pct: pct(h.cpu_mhz_used, h.cpu_mhz_capacity),
    mem_pct: pct(h.mem_bytes_used, h.mem_bytes_capacity),
  }));
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'cluster_name', 'vcenter_name', 'state'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Server} title="ESX Hosts" description="Host state, maintenance mode, VM counts and utilization across all vCenters">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by host, cluster or vCenter…"
          filters={[{ k: 'vcenter_name', label: 'vCenters' }, { k: 'cluster_name', label: 'Clusters' }, { k: 'state', label: 'States' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading hosts…" height={140} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No hosts found — register a vCenter under Settings.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No hosts match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Host" ctl={ctl} />
                <SortTh k="state" label="State" ctl={ctl} />
                <SortTh k="cluster_name" label="Cluster" ctl={ctl} />
                <SortTh k="vcenter_name" label="vCenter" ctl={ctl} />
                <SortTh k="vm_count" label="VMs" ctl={ctl} align="right" />
                <SortTh k="cpu_pct" label="CPU" ctl={ctl} align="right" />
                <SortTh k="mem_pct" label="Memory" ctl={ctl} align="right" />
                <SortTh k="mem_bytes_capacity" label="RAM" ctl={ctl} align="right" />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((h) => (
                  <tr key={`${h.vcenter_id}|${h.host_id}`} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{h.name || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={hostStateTone(h)}>{h.state}</Badge></td>
                    <td className="py-2 pr-3 text-ink-muted">{h.cluster_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{h.vcenter_name}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink">{fmtNum(h.vm_count)}</td>
                    <td className={`py-2 pr-3 text-right tnum ${h.cpu_pct > 80 ? 'text-status-warn font-semibold' : 'text-ink-muted'}`}>{h.cpu_pct != null ? `${h.cpu_pct.toFixed(0)}%` : '—'}</td>
                    <td className={`py-2 pr-3 text-right tnum ${h.mem_pct > 80 ? 'text-status-warn font-semibold' : 'text-ink-muted'}`}>{h.mem_pct != null ? `${h.mem_pct.toFixed(0)}%` : '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-faint">{fmtBytes(h.mem_bytes_capacity)}</td>
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
