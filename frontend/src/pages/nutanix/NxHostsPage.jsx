import { useEffect, useState, useCallback, Fragment } from 'react';
import { Server, ChevronDown, ChevronUp, HardDrive } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum, fmtBytes, ppmPct, parseJsonArr } from './helpers';

const stateTone = (h) => (h.is_degraded ? 'crit' : h.maintenance_mode ? 'warn' : (h.state && h.state !== 'NORMAL' && h.state !== 'ACTIVE') ? 'warn' : 'ok');
const stateLabel = (h) => (h.is_degraded ? 'DEGRADED' : h.maintenance_mode ? 'MAINTENANCE' : (h.state || 'NORMAL'));

function DiskDrawer({ host }) {
  const disks = parseJsonArr(host.disks_json);
  if (disks.length === 0) return <p className="text-xs text-ink-muted py-2 px-1">No disk data collected.</p>;
  return (
    <table className="w-full text-sm">
      <thead><tr className="text-left text-[10px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
        <th className="py-1.5 pr-3">Serial</th>
        <th className="py-1.5 pr-3">Model</th>
        <th className="py-1.5 pr-3">Tier</th>
        <th className="py-1.5 pr-3 text-right">Size</th>
        <th className="py-1.5 pr-3">Status</th>
      </tr></thead>
      <tbody>
        {disks.map((d, i) => (
          <tr key={d.serial || d.disk_uuid || i} className="border-b border-cohesity-border/40">
            <td className="py-1.5 pr-3 text-ink-muted tnum text-[11px]">{d.serial || d.disk_serial || '—'}</td>
            <td className="py-1.5 pr-3 text-ink-muted text-[11px]">{d.model || d.disk_hardware_config?.model || '—'}</td>
            <td className="py-1.5 pr-3 text-ink-muted text-[11px]">{d.tier || d.storage_tier || '—'}</td>
            <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{fmtBytes(d.size_bytes ?? d.disk_size)}</td>
            <td className="py-1.5 pr-3">
              <Badge tone={d.bad || d.status === 'bad' ? 'crit' : d.online === false ? 'warn' : 'ok'}>
                {d.bad || d.status === 'bad' ? 'BAD' : d.online === false ? 'OFFLINE' : (d.status || 'ONLINE')}
              </Badge>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function NxHostsPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [open, setOpen] = useState(() => new Set());

  const load = useCallback(() => client.get('/nutanix/hosts')
    .then(({ data }) => { setRows(data.hosts || []); setLastRefreshed(new Date()); })
    .catch(() => { setRows([]); toast({ type: 'error', title: 'Failed to load hosts' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const toggle = (id) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const list = (rows || []).map(h => ({
    ...h,
    state_label: stateLabel(h),
    cpu_pct: ppmPct(h.cpu_usage_ppm),
    mem_pct: ppmPct(h.memory_usage_ppm),
  }));
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'serial', 'block_model', 'cluster_name', 'source_name', 'ipmi_ip'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Server} title="Hosts" description="Node hardware inventory across all Nutanix clusters">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by host, serial, block, cluster or IPMI IP…"
          filters={[{ k: 'cluster_name', label: 'Clusters' }, { k: 'source_name', label: 'Sources' }, { k: 'hypervisor_type', label: 'Hypervisors' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading hosts…" height={160} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No hosts found.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No hosts match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Host" ctl={ctl} />
                <SortTh k="state_label" label="State" ctl={ctl} />
                <SortTh k="cluster_name" label="Cluster" ctl={ctl} />
                <SortTh k="serial" label="Serial" ctl={ctl} />
                <SortTh k="block_model" label="Block / Position" ctl={ctl} />
                <SortTh k="cpu_pct" label="CPU" ctl={ctl} align="right" />
                <SortTh k="mem_pct" label="Mem" ctl={ctl} align="right" />
                <SortTh k="bios_version" label="BIOS / BMC" ctl={ctl} />
                <SortTh k="hypervisor_type" label="Hypervisor" ctl={ctl} />
                <SortTh k="ipmi_ip" label="IPMI" ctl={ctl} />
                <SortTh k="num_vms" label="VMs" ctl={ctl} align="right" />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((h) => (
                  <Fragment key={h.id}>
                    <tr className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3">
                        <button onClick={() => toggle(h.id)} className="text-brand hover:underline cursor-pointer text-left inline-flex items-center gap-1">
                          {open.has(h.id) ? <ChevronUp size={12} /> : <ChevronDown size={12} />} {h.name || h.uuid}
                        </button>
                      </td>
                      <td className="py-2 pr-3"><Badge tone={stateTone(h)}>{h.state_label}</Badge></td>
                      <td className="py-2 pr-3 text-ink-muted">{h.cluster_name || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{h.serial || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[11px]">{[h.block_model, h.position].filter(Boolean).join(' · ') || '—'}</td>
                      <td className={`py-2 pr-3 text-right tnum ${h.cpu_pct > 80 ? 'text-status-warn font-semibold' : 'text-ink-muted'}`}>{h.cpu_pct != null ? `${h.cpu_pct.toFixed(0)}%` : '—'}</td>
                      <td className={`py-2 pr-3 text-right tnum ${h.mem_pct > 80 ? 'text-status-warn font-semibold' : 'text-ink-muted'}`}>{h.mem_pct != null ? `${h.mem_pct.toFixed(0)}%` : '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[11px]">{h.bios_version || '—'}{h.bmc_version ? ` / ${h.bmc_version}` : ''}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[11px]">{h.hypervisor_type || '—'}{h.hypervisor_version ? ` ${h.hypervisor_version}` : ''}</td>
                      <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{h.ipmi_ip || '—'}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(h.num_vms)}</td>
                    </tr>
                    {open.has(h.id) && (
                      <tr className="border-b border-cohesity-border/50">
                        <td colSpan={11} className="bg-surface-overlay px-3 py-2">
                          <p className="text-[11px] text-ink-faint mb-1.5 flex items-center gap-1.5"><HardDrive size={12} /> Disks</p>
                          <DiskDrawer host={h} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
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
