// vCenter ESX Hosts — ported from frontend/src/pages/vcenter/VcHostsPage.jsx.
import { Server, Boxes, ChevronDown, ChevronUp, Cpu } from '../icons.jsx';
import {
  apiFetch, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager,
  BRAND, fmtNum, fmtBytes, hostStateTone, hostStateLabel,
} from '../ui.jsx';

const pct = (used, cap) => (cap > 0 && used != null ? (used / cap) * 100 : null);

/**
 * Fleet rollup: each vCenter (with its product version/build) expandable to
 * its ESXi hosts with ESX version + BIOS + hardware identity.
 */
function FleetRollup({ vcs, hosts }) {
  const [open, setOpen] = React.useState(() => new Set());
  const toggle = (id) => setOpen(s => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return (
    <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-1" style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Boxes size={15} className="text-brand" /> Fleet Rollup</p>
      <p className="text-[11px] text-ink-faint mb-3">Each vCenter with its product version — expand for the ESXi hosts on it, with ESX build, BIOS and hardware.</p>
      <div className="flex flex-col gap-2">
        {vcs.map((vc) => {
          const vcHosts = hosts.filter(h => h.vcenter_id === vc.id);
          const isOpen = open.has(vc.id);
          return (
            <div key={vc.id} className="bg-surface-overlay rounded-lg">
              <button onClick={() => toggle(vc.id)} className="w-full flex items-center gap-3 px-3 py-2.5 cursor-pointer text-left">
                <Badge tone={vc.lastPollStatus === 'error' ? 'crit' : vc.lastPollStatus === 'success' ? 'ok' : 'neutral'}>
                  {vc.lastPollStatus === 'error' ? 'DOWN' : 'UP'}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink truncate">{vc.name}</p>
                  <p className="text-[11px] text-ink-faint truncate">
                    {vc.productName || 'vCenter'}{vc.version ? ` · v${vc.version}` : ''}{vc.build ? ` build ${vc.build}` : ''}
                  </p>
                </div>
                <span className="text-[11px] text-ink-faint tnum flex-shrink-0">{vcHosts.length} host{vcHosts.length === 1 ? '' : 's'}</span>
                <span className="text-ink-faint flex-shrink-0">{isOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
              </button>
              {isOpen && (
                <div className="px-3 pb-3 overflow-x-auto">
                  {vcHosts.length === 0 ? (
                    <p className="text-xs text-ink-muted py-2">No hosts collected yet.</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead><tr className="text-left text-[10px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                        <th className="py-1.5 pr-3">Host</th>
                        <th className="py-1.5 pr-3">State</th>
                        <th className="py-1.5 pr-3">ESX Version</th>
                        <th className="py-1.5 pr-3">BIOS</th>
                        <th className="py-1.5 pr-3">Hardware</th>
                        <th className="py-1.5 pr-3 text-right">VMs</th>
                      </tr></thead>
                      <tbody>
                        {vcHosts.map((h) => (
                          <tr key={h.id} className="border-b border-cohesity-border/40">
                            <td className="py-1.5 pr-3 text-ink">{h.name || '—'}</td>
                            <td className="py-1.5 pr-3"><Badge tone={hostStateTone(h)}>{hostStateLabel(h)}</Badge></td>
                            <td className="py-1.5 pr-3 text-ink-muted tnum text-[11px]">{h.esx_version ? `${h.esx_version}${h.esx_build ? ` (${h.esx_build})` : ''}` : '—'}</td>
                            <td className="py-1.5 pr-3 text-ink-muted tnum text-[11px]">
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Cpu size={11} className="text-ink-faint" />{h.bios_version || '—'}</span>
                              {h.bios_release_date && <span className="text-ink-faint ml-1">({String(h.bios_release_date).slice(0, 10)})</span>}
                            </td>
                            <td className="py-1.5 pr-3 text-ink-muted text-[11px] max-w-[220px] truncate" title={`${h.vendor || ''} ${h.model || ''}`}>{[h.vendor, h.model].filter(Boolean).join(' ') || '—'}</td>
                            <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{fmtNum(h.vm_count)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function VcHostsPage() {
  const [rows, setRows] = React.useState(null);
  const [vcs, setVcs] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => Promise.all([
    apiFetch('/vcenter/hosts').then((json) => setRows(Array.isArray(json) ? json : [])),
    apiFetch('/vcenter/vcenters').then((json) => setVcs(Array.isArray(json) ? json : [])).catch(() => setVcs([])),
  ]).then(() => setLastRefreshed(new Date()))
    .catch(() => setRows([])), []);

  React.useEffect(() => { load(); }, [load]);

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

      {(vcs || []).length > 0 && <FleetRollup vcs={vcs} hosts={rows || []} />}

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">All Hosts</p>
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
                <SortTh k="esx_version" label="ESX Ver" ctl={ctl} />
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
                    <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{h.esx_version || '—'}</td>
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
