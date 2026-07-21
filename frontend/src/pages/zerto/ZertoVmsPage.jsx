import { useEffect, useState, useCallback } from 'react';
import { MonitorSmartphone } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtMb, parseJsonList } from './helpers';

export default function ZertoVmsPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/zerto/vms')
    .then(({ data }) => { setRows(data); setLastRefreshed(new Date()); })
    .catch(() => { setRows([]); toast({ type: 'error', title: 'Failed to load protected VMs' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'vpg_names', 'protected_site', 'recovery_site', 'zorg_name'],
    defaultSortKey: 'used_storage_mb', defaultSortDir: 'desc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={MonitorSmartphone} title="Zerto Protected VMs" description="Virtual machines replicated by Zerto across all sites">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by VM, VPG, site or ZORG…"
          filters={[{ k: 'protected_site', label: 'Protected sites' }, { k: 'recovery_site', label: 'Recovery sites' }, { k: 'zorg_name', label: 'ZORGs' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading VMs…" height={140} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No protected VMs found — check the Zerto credentials under Settings.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No VMs match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="VM" ctl={ctl} />
                <SortTh k="vpg_names" label="VPGs" ctl={ctl} />
                <SortTh k="protected_site" label="Protected Site" ctl={ctl} />
                <SortTh k="recovery_site" label="Recovery Site" ctl={ctl} />
                <SortTh k="provisioned_storage_mb" label="Provisioned" ctl={ctl} align="right" />
                <SortTh k="used_storage_mb" label="Used" ctl={ctl} align="right" />
                <SortTh k="zorg_name" label="ZORG" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((vm) => (
                  <tr key={vm.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{vm.name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px] max-w-[220px] truncate">{parseJsonList(vm.vpg_names).join(', ') || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{vm.protected_site || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{vm.recovery_site || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtMb(vm.provisioned_storage_mb)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink">{fmtMb(vm.used_storage_mb)}</td>
                    <td className="py-2 pr-3 text-ink-muted">{vm.zorg_name || '—'}</td>
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
