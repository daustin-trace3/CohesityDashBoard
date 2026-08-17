// vCenter VM list/detail modals — ported from frontend/src/pages/vcenter/VmModals.jsx.
// The built-in version portals directly via react-dom's createPortal; the
// plugin sandbox's window.ReactDOM is react-dom/client (createRoot only,
// NO createPortal), so this goes through ui.jsx's portalOrInline() guard
// instead of a raw ModalShell + createPortal.
import { X, MonitorSmartphone, Network, Database, Tag, ScrollText, Cpu, MemoryStick, HardDrive, Clock } from './icons.jsx';
import { apiFetch, Badge, LoadingPanel, Spinner, portalOrInline, fmtNum, fmtBytes, fmtWhen, fmtUptime } from './ui.jsx';

const powerTone = (p) => p === 'POWERED_ON' ? 'ok' : p === 'POWERED_OFF' ? 'neutral' : 'warn';
const powerLabel = (p) => String(p || '—').replace(/^POWERED_/, '');
const fmtMem = (mb) => mb == null ? '—' : mb >= 1024 ? `${(mb / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB` : `${mb} MB`;

function ModalShell({ title, subtitle, icon: Icon, onClose, children, wide = false }) {
  return portalOrInline(
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(4px)', padding: 16 }} onClick={onClose}>
      <div className="panel" style={{ width: '100%', maxWidth: wide ? '48rem' : '42rem', padding: 20, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: 14, fontWeight: 700, color: 'var(--vc-ink)', margin: 0, display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              <Icon size={15} style={{ color: 'var(--vc-brand)' }} /> {title}
            </h2>
            {subtitle && <p style={{ fontSize: 11, color: 'var(--vc-ink-muted)', margin: '2px 0 0' }}>{subtitle}</p>}
          </div>
          <button onClick={onClose} aria-label="Close" style={{ flexShrink: 0, background: 'none', border: 'none', color: 'var(--vc-ink-faint)', cursor: 'pointer' }}>
            <X size={16} />
          </button>
        </div>
        <div className="vc-scroll" style={{ overflowY: 'auto', minHeight: 0, paddingRight: 4 }}>{children}</div>
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
  const [rows, setRows] = React.useState(null);

  React.useEffect(() => {
    const params = new URLSearchParams(Object.entries(filter).filter(([, v]) => v != null));
    apiFetch(`/vcenter/vms?${params}`)
      .then((json) => setRows(Array.isArray(json) ? json : []))
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
                className={`border-b border-cohesity-border/40 ${onSelectVm ? 'cursor-pointer hover:bg-surface-overlay' : ''}`}>
                <td className="py-1.5 pr-3" style={{ color: onSelectVm ? 'var(--vc-brand)' : 'var(--vc-ink)' }}>{v.name || '—'}</td>
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
      <p className="text-sm font-semibold tnum truncate" style={{ color: warn ? 'var(--vc-warn)' : 'var(--vc-ink)' }} title={typeof value === 'string' ? value : undefined}>{value ?? '—'}</p>
    </div>
  );
}

/** Full detail for one VM: identity, resources, tools, tags, NICs, datastores, recent events. */
export function VmDetailModal({ vmId, onClose }) {
  const [vm, setVm] = React.useState(null);
  const [error, setError] = React.useState(false);

  React.useEffect(() => {
    setVm(null);
    apiFetch(`/vcenter/vms/${vmId}`)
      .then((json) => setVm(json))
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
              <Badge key={t} tone="info"><Tag size={10} style={{ display: 'inline', marginRight: 4 }} />{t}</Badge>
            ))}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Fact label="vCPU" value={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Cpu size={13} style={{ color: 'var(--vc-brand)' }} />{fmtNum(vm.cpu_count)}</span>} />
            <Fact label="Memory" value={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><MemoryStick size={13} style={{ color: 'var(--vc-brand)' }} />{fmtMem(vm.memory_mb)}</span>} />
            <Fact label="Storage Used" value={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><HardDrive size={13} style={{ color: 'var(--vc-brand)' }} />{vm.storage_committed_bytes != null ? fmtBytes(vm.storage_committed_bytes) : '—'}</span>} />
            <Fact label="Uptime" value={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Clock size={13} style={{ color: 'var(--vc-brand)' }} />{fmtUptime(vm.uptime_seconds)}</span>} />
            <Fact label="Guest OS" value={vm.guest_os} />
            <Fact label="Primary IP" value={vm.ip_address} />
            <Fact label="Tools Version" value={vm.tools_version} warn={toolsOutdated} />
            <Fact label="Tools State" value={vm.tools_version_status ? String(vm.tools_version_status).replace(/^guestTools/, '') : '—'} warn={toolsOutdated} />
          </div>

          {vm.annotation && (
            <p className="text-xs text-ink-muted bg-surface-overlay rounded-lg px-3 py-2 whitespace-pre-wrap">{vm.annotation}</p>
          )}

          <div>
            <p className="text-xs font-semibold text-ink mb-1.5" style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Network size={13} style={{ color: 'var(--vc-brand)' }} /> Network</p>
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
            <p className="text-xs font-semibold text-ink mb-1.5" style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Database size={13} style={{ color: 'var(--vc-brand)' }} /> Datastores</p>
            {(vm.datastores || []).length === 0 ? (
              <p className="text-xs text-ink-faint">No datastore data collected.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {vm.datastores.map((d) => <Badge key={d} tone="neutral">{d}</Badge>)}
              </div>
            )}
          </div>

          <div>
            <p className="text-xs font-semibold text-ink mb-1.5" style={{ display: 'flex', alignItems: 'center', gap: 6 }}><ScrollText size={13} style={{ color: 'var(--vc-brand)' }} /> Recent Events</p>
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
