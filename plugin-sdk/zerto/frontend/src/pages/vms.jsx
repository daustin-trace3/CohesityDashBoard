// Zerto Protected VMs — ported from frontend/src/pages/zerto/ZertoVmsPage.jsx.
import { MonitorSmartphone } from '../icons.jsx';
import {
  apiFetch, PageHeader, LoadingPanel, RefreshButton, LastUpdated, BRAND,
  useTableControls, SortTh, TableControls, TablePager, fmtMb, parseJsonList,
} from '../ui.jsx';

export default function ZertoVmsPage() {
  const [rows, setRows] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => apiFetch('/zerto/vms')
    .then((json) => { setRows(json); setLastRefreshed(new Date()); })
    .catch(() => setRows([])), []);

  React.useEffect(() => { load(); }, [load]);

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
