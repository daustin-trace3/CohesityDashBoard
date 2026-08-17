// vCenter VM Inventory — ported from frontend/src/pages/vcenter/VcInventoryPage.jsx.
import { MonitorSmartphone } from '../icons.jsx';
import {
  apiFetch, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager,
  BRAND, fmtNum,
} from '../ui.jsx';
import { VmDetailModal } from '../vmModals.jsx';

const powerTone = (p) => p === 'POWERED_ON' || p === 'poweredOn' ? 'ok'
  : p === 'POWERED_OFF' || p === 'poweredOff' ? 'neutral' : 'warn';
const powerLabel = (p) => String(p || '—').replace(/^POWERED_|^powered/i, '').replace(/^_/, '').toUpperCase() || '—';
const toolsTone = (t) => t === 'guestToolsRunning' ? 'ok' : t === 'guestToolsNotRunning' ? 'warn' : 'neutral';
const toolsLabel = (t) => t ? String(t).replace(/^guestTools/, '') : '—';
const OUTDATED_TOOLS = new Set(['guestToolsNeedUpgrade', 'guestToolsTooOld', 'guestToolsBlacklisted', 'guestToolsSupportedOld']);
const toolsVerLabel = (s) => s ? String(s).replace(/^guestTools/, '') : null;
const fmtMem = (mb) => mb == null ? '—' : mb >= 1024 ? `${(mb / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB` : `${mb} MB`;
const statusTone = (s) => s === 'green' ? 'ok' : s === 'yellow' ? 'warn' : s === 'red' ? 'crit' : 'neutral';
const fmtPct = (p) => p == null ? '—' : `${p.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
const pctClass = (p) => p == null ? 'text-ink-faint' : p >= 90 ? 'text-status-crit font-semibold' : p >= 75 ? 'text-status-warn' : 'text-ink-muted';

export default function VcInventoryPage() {
  const [rows, setRows] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [detailVmId, setDetailVmId] = React.useState(null);

  const load = React.useCallback(() => apiFetch('/vcenter/vms')
    .then((json) => { setRows(Array.isArray(json) ? json : []); setLastRefreshed(new Date()); })
    .catch(() => setRows([])), []);

  React.useEffect(() => { load(); }, [load]);

  const list = (rows || []).map(v => ({
    ...v,
    power: powerLabel(v.power_state),
    tools_state: v.tools_version_status == null ? 'Unknown'
      : OUTDATED_TOOLS.has(v.tools_version_status) ? 'Outdated'
        : v.tools_version_status === 'guestToolsCurrent' ? 'Current'
          : toolsVerLabel(v.tools_version_status),
  }));
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'guest_os', 'host_name', 'cluster_name', 'vcenter_name', 'ip_address', 'tools_version'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={MonitorSmartphone} title="VM Inventory" description="Every VM guest across all registered vCenters">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by VM, OS, host, cluster, vCenter or IP…"
          filters={[
            { k: 'vcenter_name', label: 'vCenters' },
            { k: 'cluster_name', label: 'Clusters' },
            { k: 'power', label: 'Power states' },
            { k: 'guest_os', label: 'Guest OS' },
            { k: 'tools_state', label: 'Tools states' },
          ]} />
        {rows == null ? (
          <LoadingPanel label="Loading VM inventory…" height={160} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No VMs found — data appears after the next poll of a registered vCenter.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No VMs match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="VM" ctl={ctl} />
                <SortTh k="power" label="Power" ctl={ctl} />
                <SortTh k="overall_status" label="Health" ctl={ctl} />
                <SortTh k="cpu_pct" label="CPU %" ctl={ctl} align="right" />
                <SortTh k="mem_pct" label="Mem %" ctl={ctl} align="right" />
                <SortTh k="guest_os" label="Guest OS" ctl={ctl} />
                <SortTh k="host_name" label="Host" ctl={ctl} />
                <SortTh k="cluster_name" label="Cluster" ctl={ctl} />
                <SortTh k="vcenter_name" label="vCenter" ctl={ctl} />
                <SortTh k="cpu_count" label="vCPU" ctl={ctl} align="right" />
                <SortTh k="memory_mb" label="Memory" ctl={ctl} align="right" />
                <SortTh k="ip_address" label="IP" ctl={ctl} />
                <SortTh k="tools_status" label="Tools" ctl={ctl} />
                <SortTh k="tools_version" label="Tools Ver" ctl={ctl} />
                <SortTh k="hw_version" label="HW" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((v) => (
                  <tr key={`${v.vcenter_id}|${v.vm_id || v.id}`} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3">
                      <button onClick={() => setDetailVmId(v.id)} className="text-brand hover:underline cursor-pointer text-left">{v.name || '—'}</button>
                    </td>
                    <td className="py-2 pr-3"><Badge tone={powerTone(v.power_state)}>{v.power}</Badge></td>
                    <td className="py-2 pr-3"><Badge tone={statusTone(v.overall_status)}>{v.overall_status || 'unknown'}</Badge></td>
                    <td className={`py-2 pr-3 text-right tnum ${pctClass(v.cpu_pct)}`}>{fmtPct(v.cpu_pct)}</td>
                    <td className={`py-2 pr-3 text-right tnum ${pctClass(v.mem_pct)}`}>{fmtPct(v.mem_pct)}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px] max-w-[200px] truncate" title={v.guest_os || ''}>{v.guest_os || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{v.host_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{v.cluster_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{v.vcenter_name}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(v.cpu_count)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtMem(v.memory_mb)}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{v.ip_address || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={toolsTone(v.tools_status)}>{toolsLabel(v.tools_status)}</Badge></td>
                    <td className="py-2 pr-3 text-[11px] tnum whitespace-nowrap">
                      <span className={v.tools_state === 'Outdated' ? 'text-status-warn font-semibold' : 'text-ink-muted'}>
                        {v.tools_version || '—'}{v.tools_state === 'Outdated' ? ' ⚠' : ''}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">{v.hw_version ? String(v.hw_version).replace('vmx-', 'v') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>

      {detailVmId != null && <VmDetailModal vmId={detailVmId} onClose={() => setDetailVmId(null)} />}
    </div>
  );
}
