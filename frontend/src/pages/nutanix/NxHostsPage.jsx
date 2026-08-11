import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Server, X, Cpu, MemoryStick, HardDrive, Network, MonitorSmartphone } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum, fmtBytes, ppmPct, parseJsonArr } from './helpers';

const stateTone = (h) => (h.is_degraded ? 'crit' : h.maintenance_mode ? 'warn' : (h.state && h.state !== 'NORMAL' && h.state !== 'ACTIVE') ? 'warn' : 'ok');
const stateLabel = (h) => (h.is_degraded ? 'DEGRADED' : h.maintenance_mode ? 'MAINTENANCE' : (h.state || 'NORMAL'));

function ModalShell({ title, subtitle, icon: Icon, onClose, children }) {
  // Portal to <body>: the page wrapper's fade-in animation leaves a transform
  // applied (fill-mode: both), which would re-anchor position:fixed to the
  // page div and push the modal's top off-screen on scrolled/short pages.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative panel w-full max-w-3xl max-h-[85vh] flex flex-col" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-start justify-between p-4 pb-3 border-b border-cohesity-border">
          <div className="flex items-center gap-2 min-w-0">
            {Icon && <Icon size={17} className="text-brand shrink-0" />}
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink truncate">{title}</p>
              {subtitle && <p className="text-[11px] text-ink-faint truncate">{subtitle}</p>}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="flex items-center justify-center h-7 w-7 rounded-md text-ink-muted hover:text-ink hover:bg-surface-overlay transition-colors cursor-pointer shrink-0">
            <X size={15} />
          </button>
        </div>
        <div className="p-4 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body
  );
}

const Fact = ({ label, value }) => (
  <div>
    <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
    <p className="text-sm text-ink tnum">{value ?? '—'}</p>
  </div>
);

function Section({ icon: Icon, label, count, children }) {
  return (
    <div className="mb-4">
      <p className="text-xs font-semibold text-ink mb-2 flex items-center gap-1.5">
        <Icon size={13} className="text-brand" /> {label}{count != null ? ` (${count})` : ''}
      </p>
      {children}
    </div>
  );
}

function DiskTable({ disks }) {
  if (disks.length === 0) return <p className="text-xs text-ink-muted py-1">No disk data collected.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead><tr className="text-left text-[10px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
          <th className="py-1.5 pr-3">Bay</th>
          <th className="py-1.5 pr-3">Serial</th>
          <th className="py-1.5 pr-3">Model</th>
          <th className="py-1.5 pr-3">Tier</th>
          <th className="py-1.5 pr-3">Firmware</th>
          <th className="py-1.5 pr-3 text-right">Size</th>
          <th className="py-1.5 pr-3">Status</th>
        </tr></thead>
        <tbody>
          {disks.map((d, i) => (
            <tr key={d.serial || d.disk_uuid || i} className="border-b border-cohesity-border/40">
              <td className="py-1.5 pr-3 text-ink-muted tnum">{d.bay ?? d.location ?? i + 1}</td>
              <td className="py-1.5 pr-3 text-ink-muted tnum">{d.serial || d.disk_serial || '—'}</td>
              <td className="py-1.5 pr-3 text-ink-muted">{d.model || d.disk_hardware_config?.model || '—'}</td>
              <td className="py-1.5 pr-3 text-ink-muted">{d.tier || d.storage_tier || '—'}</td>
              <td className="py-1.5 pr-3 text-ink-faint tnum">{d.firmware || d.current_firmware_version || '—'}</td>
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
    </div>
  );
}

function HostDetailModal({ host, onClose }) {
  const disks = parseJsonArr(host.disks_json);
  const cpuPct = ppmPct(host.cpu_usage_ppm);
  const memPct = ppmPct(host.memory_usage_ppm);
  return (
    <ModalShell
      title={host.name || host.uuid}
      subtitle={[host.block_model, host.serial, host.cluster_name].filter(Boolean).join(' · ')}
      icon={Server} onClose={onClose}>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Badge tone={stateTone(host)}>{stateLabel(host)}</Badge>
        {host.hypervisor_type && <Badge tone="info">{host.hypervisor_type}</Badge>}
        {host.is_degraded ? <Badge tone="crit">DEGRADED</Badge> : null}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Fact label="Cluster" value={host.cluster_name} />
        <Fact label="Source" value={host.source_name} />
        <Fact label="Serial" value={host.serial} />
        <Fact label="Block / Position" value={[host.block_model, host.position].filter(Boolean).join(' · ') || null} />
        <Fact label="Block Serial" value={host.block_serial} />
        <Fact label="VMs" value={fmtNum(host.num_vms)} />
        <Fact label="CPU / Mem Util" value={cpuPct != null ? `${cpuPct.toFixed(0)}% / ${memPct != null ? memPct.toFixed(0) : '—'}%` : null} />
        <Fact label="Boot Time" value={host.boot_time_usecs ? new Date(host.boot_time_usecs / 1000).toLocaleString() : null} />
      </div>

      <Section icon={Cpu} label="Processor">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="col-span-2"><Fact label="Model" value={host.cpu_model} /></div>
          <Fact label="Sockets / Cores" value={host.num_cpu_sockets != null ? `${fmtNum(host.num_cpu_sockets)} / ${fmtNum(host.num_cpu_cores)}` : null} />
          <Fact label="Capacity" value={host.cpu_capacity_hz ? `${(host.cpu_capacity_hz / 1e9).toFixed(1)} GHz total` : null} />
        </div>
      </Section>

      <Section icon={MemoryStick} label="Memory">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Fact label="Capacity" value={host.memory_capacity_bytes ? fmtBytes(host.memory_capacity_bytes) : null} />
          <Fact label="In Use" value={memPct != null ? `${memPct.toFixed(1)}%` : null} />
        </div>
      </Section>

      <Section icon={MonitorSmartphone} label="Firmware & Hypervisor">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Fact label="BIOS" value={host.bios_version} />
          <Fact label="BMC" value={host.bmc_version} />
          <Fact label="Hypervisor" value={[host.hypervisor_type, host.hypervisor_version].filter(Boolean).join(' ') || null} />
          <Fact label="Metadata Store" value={host.metadata_store_status} />
        </div>
      </Section>

      <Section icon={Network} label="Addresses">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Fact label="Hypervisor IP" value={host.hypervisor_ip} />
          <Fact label="CVM IP" value={host.cvm_ip} />
          <Fact label="IPMI IP" value={host.ipmi_ip} />
        </div>
      </Section>

      <Section icon={HardDrive} label="Physical Disks" count={disks.length}>
        <DiskTable disks={disks} />
      </Section>
    </ModalShell>
  );
}

export default function NxHostsPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [detail, setDetail] = useState(null);

  const load = useCallback(() => client.get('/nutanix/hosts')
    .then(({ data }) => { setRows(data.hosts || []); setLastRefreshed(new Date()); })
    .catch(() => { setRows([]); toast({ type: 'error', title: 'Failed to load hosts' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

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
      <PageHeader icon={Server} title="Hosts" description="Node hardware inventory across all Nutanix clusters — click a host for full component detail">
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
                  <tr key={h.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3">
                      <button onClick={() => setDetail(h)} className="text-brand hover:underline cursor-pointer text-left">{h.name || h.uuid}</button>
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
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>

      {detail != null && <HostDetailModal host={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
