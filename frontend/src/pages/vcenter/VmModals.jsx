import { useEffect, useState } from 'react';
import { X, MonitorSmartphone, Network, Database, Tag, ScrollText, Cpu, MemoryStick, HardDrive, Clock } from 'lucide-react';
import client from '../../api/client';
import { Badge, LoadingPanel, Spinner } from '../../components/ui/primitives';
import { fmtNum, fmtBytes, fmtWhen, severityTone } from './helpers';

const powerTone = (p) => p === 'POWERED_ON' ? 'ok' : p === 'POWERED_OFF' ? 'neutral' : 'warn';
const powerLabel = (p) => String(p || '—').replace(/^POWERED_/, '');
const fmtMem = (mb) => mb == null ? '—' : mb >= 1024 ? `${(mb / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB` : `${mb} MB`;

export function fmtUptime(secs) {
  if (secs == null) return '—';
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  if (days >= 1) return `${days}d ${hours}h`;
  const mins = Math.floor((secs % 3600) / 60);
  return hours >= 1 ? `${hours}h ${mins}m` : `${mins}m`;
}

function ModalShell({ title, subtitle, icon: Icon, onClose, children, wide = false }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`panel w-full ${wide ? 'max-w-3xl' : 'max-w-2xl'} p-5 max-h-[85vh] flex flex-col`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-ink truncate flex items-center gap-2">
              <Icon size={15} className="text-brand" /> {title}
            </h2>
            {subtitle && <p className="text-[11px] text-ink-muted mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} aria-label="Close" className="text-ink-faint hover:text-ink flex-shrink-0 cursor-pointer"><X size={16} /></button>
        </div>
        <div className="overflow-y-auto pr-1 min-h-0">{children}</div>
      </div>
    </div>
  );
}

/**
 * VMs attached to a portgroup/network or datastore. `filter` is passed as
 * /vcenter/vms query params: { network | datastore, vcenterId? }.
 * onSelectVm (optional) makes rows clickable to open the VM detail modal.
 */
export function VmListModal({ title, subtitle, icon = Network, filter, onClose, onSelectVm }) {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(Object.entries(filter).filter(([, v]) => v != null));
    client.get(`/vcenter/vms?${params}`)
      .then(({ data }) => setRows(data))
      .catch(() => setRows([]));
  }, [filter]);

  return (
    <ModalShell title={title} icon={icon} onClose={onClose}
      subtitle={rows == null ? subtitle : `${subtitle ? `${subtitle} · ` : ''}${fmtNum(rows.length)} VM${rows.length === 1 ? '' : 's'} attached`}>
      {rows == null ? (
        <LoadingPanel label="Loading VMs…" height={120} />
      ) : rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No VMs attached.</div>
      ) : (
        <table className="w-full text-sm">
          <thead><tr className="text-left text-[10px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
            <th className="py-1.5 pr-3">VM</th>
            <th className="py-1.5 pr-3">Power</th>
            <th className="py-1.5 pr-3">Host</th>
            <th className="py-1.5 pr-3">Cluster</th>
            <th className="py-1.5 pr-3">IP</th>
          </tr></thead>
          <tbody>
            {rows.map((v) => (
              <tr key={v.id} onClick={onSelectVm ? () => onSelectVm(v) : undefined}
                className={`border-b border-cohesity-border/40 ${onSelectVm ? 'cursor-pointer hover:bg-surface-overlay/60' : ''}`}>
                <td className={`py-1.5 pr-3 ${onSelectVm ? 'text-brand' : 'text-ink'}`}>{v.name || '—'}</td>
                <td className="py-1.5 pr-3"><Badge tone={powerTone(v.power_state)}>{powerLabel(v.power_state)}</Badge></td>
                <td className="py-1.5 pr-3 text-ink-muted text-[11px] whitespace-nowrap">{v.host_name || '—'}</td>
                <td className="py-1.5 pr-3 text-ink-muted text-[11px]">{v.cluster_name || '—'}</td>
                <td className="py-1.5 pr-3 text-ink-faint tnum text-[11px]">{v.ip_address || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ModalShell>
  );
}

function Fact({ label, value, warn = false }) {
  return (
    <div className="bg-surface-overlay rounded-lg px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
      <p className={`text-sm font-semibold tnum truncate ${warn ? 'text-status-warn' : 'text-ink'}`} title={typeof value === 'string' ? value : undefined}>{value ?? '—'}</p>
    </div>
  );
}

/** Full detail for one VM: identity, resources, tools, tags, NICs, datastores, recent events. */
export function VmDetailModal({ vmId, onClose }) {
  const [vm, setVm] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setVm(null);
    client.get(`/vcenter/vms/${vmId}`)
      .then(({ data }) => setVm(data))
      .catch(() => setError(true));
  }, [vmId]);

  const toolsOutdated = vm && ['guestToolsNeedUpgrade', 'guestToolsTooOld', 'guestToolsBlacklisted', 'guestToolsSupportedOld'].includes(vm.tools_version_status);

  return (
    <ModalShell wide icon={MonitorSmartphone} onClose={onClose}
      title={vm ? vm.name : 'VM Detail'}
      subtitle={vm ? `${vm.host_name || '—'} · ${vm.cluster_name || '—'} · ${vm.vcenter_name}` : undefined}>
      {error ? (
        <div className="text-sm text-status-crit py-6 text-center">Failed to load VM detail.</div>
      ) : vm == null ? (
        <div className="py-10 flex justify-center"><Spinner size={20} /></div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={powerTone(vm.power_state)}>{powerLabel(vm.power_state)}</Badge>
            <Badge tone={vm.tools_status === 'guestToolsRunning' ? 'ok' : 'warn'}>
              Tools {String(vm.tools_status || 'unknown').replace(/^guestTools/, '')}
            </Badge>
            {vm.hw_version && <Badge tone="neutral">{String(vm.hw_version).replace('vmx-', 'HW v')}</Badge>}
            {(vm.tags || []).map((t) => (
              <Badge key={t} tone="info"><Tag size={10} className="inline mr-1" />{t}</Badge>
            ))}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Fact label="vCPU" value={<span className="inline-flex items-center gap-1.5"><Cpu size={13} className="text-brand" />{fmtNum(vm.cpu_count)}</span>} />
            <Fact label="Memory" value={<span className="inline-flex items-center gap-1.5"><MemoryStick size={13} className="text-brand" />{fmtMem(vm.memory_mb)}</span>} />
            <Fact label="Storage Used" value={<span className="inline-flex items-center gap-1.5"><HardDrive size={13} className="text-brand" />{vm.storage_committed_bytes != null ? fmtBytes(vm.storage_committed_bytes) : '—'}</span>} />
            <Fact label="Uptime" value={<span className="inline-flex items-center gap-1.5"><Clock size={13} className="text-brand" />{fmtUptime(vm.uptime_seconds)}</span>} />
            <Fact label="Guest OS" value={vm.guest_os} />
            <Fact label="Primary IP" value={vm.ip_address} />
            <Fact label="Tools Version" value={vm.tools_version} warn={toolsOutdated} />
            <Fact label="Tools State" value={vm.tools_version_status ? String(vm.tools_version_status).replace(/^guestTools/, '') : '—'} warn={toolsOutdated} />
          </div>

          {vm.annotation && (
            <p className="text-xs text-ink-muted bg-surface-overlay rounded-lg px-3 py-2 whitespace-pre-wrap">{vm.annotation}</p>
          )}

          <div>
            <p className="text-xs font-semibold text-ink mb-1.5 flex items-center gap-1.5"><Network size={13} className="text-brand" /> Network</p>
            {(vm.guest_nics || []).length === 0 && (vm.networks || []).length === 0 ? (
              <p className="text-xs text-ink-faint">No network data collected.</p>
            ) : (vm.guest_nics || []).length > 0 ? (
              <table className="w-full text-xs">
                <thead><tr className="text-left text-[10px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <th className="py-1 pr-3">Port Group</th><th className="py-1 pr-3">IP Addresses</th>
                  <th className="py-1 pr-3">MAC</th><th className="py-1 pr-3">Link</th>
                </tr></thead>
                <tbody>
                  {vm.guest_nics.map((n, i) => (
                    <tr key={i} className="border-b border-cohesity-border/40">
                      <td className="py-1.5 pr-3 text-ink">{n.network || '—'}</td>
                      <td className="py-1.5 pr-3 text-ink-muted tnum">{(n.ips || []).join(', ') || '—'}</td>
                      <td className="py-1.5 pr-3 text-ink-faint tnum">{n.mac || '—'}</td>
                      <td className="py-1.5 pr-3"><Badge tone={n.connected ? 'ok' : 'crit'}>{n.connected ? 'UP' : 'DOWN'}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {vm.networks.map((n) => <Badge key={n} tone="neutral">{n}</Badge>)}
              </div>
            )}
          </div>

          <div>
            <p className="text-xs font-semibold text-ink mb-1.5 flex items-center gap-1.5"><Database size={13} className="text-brand" /> Datastores</p>
            {(vm.datastores || []).length === 0 ? (
              <p className="text-xs text-ink-faint">No datastore data collected.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {vm.datastores.map((d) => <Badge key={d} tone="neutral">{d}</Badge>)}
              </div>
            )}
          </div>

          <div>
            <p className="text-xs font-semibold text-ink mb-1.5 flex items-center gap-1.5"><ScrollText size={13} className="text-brand" /> Recent Events</p>
            {(vm.events || []).length === 0 ? (
              <p className="text-xs text-ink-faint">No events recorded for this VM in the last 30 days.</p>
            ) : (
              <div className="flex flex-col gap-1 max-h-48 overflow-y-auto pr-1">
                {vm.events.map((e) => (
                  <div key={e.id} className="flex items-start gap-2 bg-surface-overlay rounded-lg px-2.5 py-1.5">
                    <Badge tone={e.severity === 'error' ? 'crit' : e.severity === 'warning' ? 'warn' : 'info'}>{e.severity}</Badge>
                    <div className="min-w-0">
                      <p className="text-[11px] text-ink leading-snug">{e.message}</p>
                      <p className="text-[10px] text-ink-faint tnum">{fmtWhen(e.created_at)}{e.username ? ` · ${e.username}` : ''}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </ModalShell>
  );
}
