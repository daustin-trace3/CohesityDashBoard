import { MonitorSmartphone } from '../icons.jsx';
import {
  apiFetch, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager, BRAND,
} from '../ui.jsx';

const statusTone = (s) => s === 'green' ? 'ok' : s === 'yellow' ? 'warn' : s === 'red' ? 'crit' : 'neutral';
const fmtPct = (p) => p == null ? '—' : `${p.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
const pctClass = (p) => p == null ? 'text-ink-faint' : p >= 90 ? 'text-status-crit font-semibold' : p >= 75 ? 'text-status-warn' : 'text-ink-muted';
const fmtMem = (mb) => mb == null ? '—' : mb >= 1024 ? `${(mb / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB` : `${mb} MB`;
const fmtUptime = (s) => s == null ? '—' : `${(s / 86400).toLocaleString(undefined, { maximumFractionDigits: 1 })} d`;

function VmTable({ rows }) {
  const ctl = useTableControls(rows, {
    searchKeys: ['vm_name', 'guest_os', 'host_name', 'vcenter_name', 'ip_address'],
    defaultSortKey: 'vm_name', defaultSortDir: 'asc',
    paginate: true,
  });
  return (
    <>
      <TableControls ctl={ctl} rows={rows} searchPlaceholder="Filter by VM, OS, host, vCenter or IP…"
        filters={[{ k: 'vcenter_name', label: 'vCenters' }]} />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
            <SortTh k="vm_name" label="VM" ctl={ctl} />
            <SortTh k="overall_status" label="Health" ctl={ctl} />
            <SortTh k="cpu_pct" label="CPU %" ctl={ctl} align="right" />
            <SortTh k="mem_pct" label="Mem %" ctl={ctl} align="right" />
            <SortTh k="cpu_count" label="vCPU" ctl={ctl} align="right" />
            <SortTh k="memory_mb" label="Memory" ctl={ctl} align="right" />
            <SortTh k="uptime_seconds" label="Uptime" ctl={ctl} align="right" />
            <SortTh k="ip_address" label="IP" ctl={ctl} />
            <SortTh k="host_name" label="Host" ctl={ctl} />
            <SortTh k="vcenter_name" label="vCenter" ctl={ctl} />
          </tr></thead>
          <tbody>
            {ctl.pageRows.map((v) => (
              <tr key={v.vm_row_id} className="border-b border-cohesity-border/50">
                <td className="py-2 pr-3 text-ink">{v.vm_name || '—'}</td>
                <td className="py-2 pr-3"><Badge tone={statusTone(v.overall_status)}>{v.overall_status || 'unknown'}</Badge></td>
                <td className={`py-2 pr-3 text-right tnum ${pctClass(v.cpu_pct)}`}>{fmtPct(v.cpu_pct)}</td>
                <td className={`py-2 pr-3 text-right tnum ${pctClass(v.mem_pct)}`}>{fmtPct(v.mem_pct)}</td>
                <td className="py-2 pr-3 text-right tnum text-ink-muted">{v.cpu_count ?? '—'}</td>
                <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtMem(v.memory_mb)}</td>
                <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtUptime(v.uptime_seconds)}</td>
                <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{v.ip_address || '—'}</td>
                <td className="py-2 pr-3 text-ink-muted text-[11px]">{v.host_name || '—'}</td>
                <td className="py-2 pr-3 text-ink-muted">{v.vcenter_name || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TablePager ctl={ctl} />
    </>
  );
}

/**
 * Appliance VM performance/health, joined from the vCenter platform's
 * inventory. Registered vRA instances matched to their VM, plus other
 * Aria-suite appliances found by VM name pattern.
 */
export default function AriaAppliancesPage() {
  const [data, setData] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => apiFetch('/aria/appliances')
    .then((json) => { setData(json); setLastRefreshed(new Date()); })
    .catch(() => setData({ instances: [], suiteVms: [], vcenterConfigured: false })), []);

  React.useEffect(() => { load(); }, [load]);

  const matchedVms = (data?.instances || []).filter((i) => i.vm).map((i) => ({ ...i.vm, vm_name: `${i.vm.vm_name} (${i.name})` }));
  const unmatched = (data?.instances || []).filter((i) => !i.vm);

  return (
    <div className="animate-fade-in flex flex-col gap-4">
      <PageHeader icon={MonitorSmartphone} title="Appliances"
        description="Performance and health of the Aria appliance VMs, sourced from the vCenter platform's inventory">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {data == null ? (
        <LoadingPanel label="Loading appliance data…" height={160} />
      ) : !data.vcenterConfigured ? (
        <div className="panel p-6 text-sm text-ink-muted text-center">
          No vCenters are registered. Appliance performance comes from vCenter VM data — add the vCenter hosting your
          Aria appliances on the vCenter platform's Settings page.
        </div>
      ) : (
        <>
          <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
            <p className="text-xs font-bold text-ink mb-2">Registered vRA instances</p>
            {matchedVms.length === 0 ? (
              <p className="text-sm text-ink-muted py-3 text-center">
                No registered instance matched a vCenter VM (matching is by guest hostname, VM name, or IP against the
                instance's host). Stats appear after the next vCenter poll once the hosting vCenter is registered.
              </p>
            ) : (
              <VmTable rows={matchedVms} />
            )}
            {unmatched.length > 0 && matchedVms.length > 0 && (
              <p className="text-[11px] text-ink-faint mt-2">
                Not matched to a VM: {unmatched.map((i) => `${i.name} (${i.host})`).join(', ')}
              </p>
            )}
          </div>

          <div className="panel p-4">
            <p className="text-xs font-bold text-ink mb-0.5">Other Aria suite appliances</p>
            <p className="text-[11px] text-ink-faint mb-2">
              vCenter VMs whose name matches Aria/vRealize appliance patterns (vra, vrops, vrli, vrlcm, vrni…).
            </p>
            {data.suiteVms.length === 0 ? (
              <p className="text-sm text-ink-muted py-3 text-center">No suite appliance VMs found by name pattern.</p>
            ) : (
              <VmTable rows={data.suiteVms} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
