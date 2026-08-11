// Nutanix Hosts — port of NxHostsPage.jsx onto the nx- style kit, with the
// component-detail modal (disk table, processor/memory/firmware sections).
import {
  injectStyles, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager, ModalShell, Fact, Section,
  ServerIcon, CpuIcon, MemoryIcon, HardDriveIcon, NetworkIcon, MonitorIcon,
  fmtNum, fmtBytes, ppmPct, parseJsonArr,
} from '../ui.jsx';

injectStyles();

const BRAND = '#7855FA';

const stateTone = (h) => (h.is_degraded ? 'crit' : h.maintenance_mode ? 'warn' : (h.state && h.state !== 'NORMAL' && h.state !== 'ACTIVE') ? 'warn' : 'ok');
const stateLabel = (h) => (h.is_degraded ? 'DEGRADED' : h.maintenance_mode ? 'MAINTENANCE' : (h.state || 'NORMAL'));

const td = { padding: '8px 12px 8px 0', fontSize: 13, color: 'var(--nx-ink)', borderBottom: '1px solid var(--nx-border)' };
const tdMuted = { ...td, color: 'var(--nx-ink-muted)' };

function DiskTable({ disks }) {
  if (disks.length === 0) return <p style={{ fontSize: 12, color: 'var(--nx-ink-muted)', padding: '4px 0' }}>No disk data collected.</p>;
  const th = { textAlign: 'left', padding: '6px 12px 6px 0', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.03em', color: 'var(--nx-ink-faint)', borderBottom: '1px solid var(--nx-border)' };
  const cell = { padding: '6px 12px 6px 0', fontSize: 12, color: 'var(--nx-ink-muted)', borderBottom: '1px solid rgba(31,43,55,0.6)' };
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>
          <th style={th}>Bay</th><th style={th}>Serial</th><th style={th}>Model</th><th style={th}>Tier</th>
          <th style={th}>Firmware</th><th style={{ ...th, textAlign: 'right' }}>Size</th><th style={th}>Status</th>
        </tr></thead>
        <tbody>
          {disks.map((d, i) => (
            <tr key={d.serial || d.disk_uuid || i}>
              <td className="nx-tnum" style={cell}>{d.bay ?? d.location ?? i + 1}</td>
              <td className="nx-tnum" style={cell}>{d.serial || d.disk_serial || '—'}</td>
              <td style={cell}>{d.model || d.disk_hardware_config?.model || '—'}</td>
              <td style={cell}>{d.tier || d.storage_tier || '—'}</td>
              <td className="nx-tnum" style={{ ...cell, color: 'var(--nx-ink-faint)' }}>{d.firmware || d.current_firmware_version || '—'}</td>
              <td className="nx-tnum" style={{ ...cell, textAlign: 'right' }}>{fmtBytes(d.size_bytes ?? d.disk_size)}</td>
              <td style={cell}>
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
  const factGrid = { display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 12 };
  return (
    <ModalShell title={host.name || host.uuid} subtitle={[host.block_model, host.serial, host.cluster_name].filter(Boolean).join(' · ')} icon={ServerIcon} onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <Badge tone={stateTone(host)}>{stateLabel(host)}</Badge>
        {host.hypervisor_type && <Badge tone="info">{host.hypervisor_type}</Badge>}
        {host.is_degraded ? <Badge tone="crit">DEGRADED</Badge> : null}
      </div>

      <div style={{ ...factGrid, gridTemplateColumns: 'repeat(4,1fr)', marginBottom: 16 }} className="nx-fact-grid">
        <style>{`@media (max-width: 560px) { .nx-fact-grid { grid-template-columns: repeat(2,1fr) !important; } }`}</style>
        <Fact label="Cluster" value={host.cluster_name} />
        <Fact label="Source" value={host.source_name} />
        <Fact label="Serial" value={host.serial} />
        <Fact label="Block / Position" value={[host.block_model, host.position].filter(Boolean).join(' · ') || null} />
        <Fact label="Block Serial" value={host.block_serial} />
        <Fact label="VMs" value={fmtNum(host.num_vms)} />
        <Fact label="CPU / Mem Util" value={cpuPct != null ? `${cpuPct.toFixed(0)}% / ${memPct != null ? memPct.toFixed(0) : '—'}%` : null} />
        <Fact label="Boot Time" value={host.boot_time_usecs ? new Date(host.boot_time_usecs / 1000).toLocaleString() : null} />
      </div>

      <Section icon={CpuIcon} label="Processor">
        <div style={{ ...factGrid, gridTemplateColumns: 'repeat(4,1fr)' }} className="nx-fact-grid">
          <div style={{ gridColumn: 'span 2' }}><Fact label="Model" value={host.cpu_model} /></div>
          <Fact label="Sockets / Cores" value={host.num_cpu_sockets != null ? `${fmtNum(host.num_cpu_sockets)} / ${fmtNum(host.num_cpu_cores)}` : null} />
          <Fact label="Capacity" value={host.cpu_capacity_hz ? `${(host.cpu_capacity_hz / 1e9).toFixed(1)} GHz total` : null} />
        </div>
      </Section>

      <Section icon={MemoryIcon} label="Memory">
        <div style={{ ...factGrid, gridTemplateColumns: 'repeat(4,1fr)' }}>
          <Fact label="Capacity" value={host.memory_capacity_bytes ? fmtBytes(host.memory_capacity_bytes) : null} />
          <Fact label="In Use" value={memPct != null ? `${memPct.toFixed(1)}%` : null} />
        </div>
      </Section>

      <Section icon={MonitorIcon} label="Firmware &amp; Hypervisor">
        <div style={{ ...factGrid, gridTemplateColumns: 'repeat(4,1fr)' }}>
          <Fact label="BIOS" value={host.bios_version} />
          <Fact label="BMC" value={host.bmc_version} />
          <Fact label="Hypervisor" value={[host.hypervisor_type, host.hypervisor_version].filter(Boolean).join(' ') || null} />
          <Fact label="Metadata Store" value={host.metadata_store_status} />
        </div>
      </Section>

      <Section icon={NetworkIcon} label="Addresses">
        <div style={{ ...factGrid, gridTemplateColumns: 'repeat(4,1fr)' }}>
          <Fact label="Hypervisor IP" value={host.hypervisor_ip} />
          <Fact label="CVM IP" value={host.cvm_ip} />
          <Fact label="IPMI IP" value={host.ipmi_ip} />
        </div>
      </Section>

      <Section icon={HardDriveIcon} label="Physical Disks" count={disks.length}>
        <DiskTable disks={disks} />
      </Section>
    </ModalShell>
  );
}

export default function HostsPage() {
  const [rows, setRows] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [detail, setDetail] = React.useState(null);

  const load = React.useCallback(() => fetch('/api/nutanix/hosts', { credentials: 'include' })
    .then((res) => { if (!res.ok) throw new Error(String(res.status)); return res.json(); })
    .then((json) => { setRows(json.hosts || []); setLastRefreshed(new Date()); })
    .catch(() => setRows([])), []);

  React.useEffect(() => { load(); }, [load]);

  const list = (rows || []).map((h) => ({
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
    <div className="nx-root nx-fade-in">
      <PageHeader icon={ServerIcon} title="Hosts" description="Node hardware inventory across all Nutanix clusters — click a host for full component detail">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="nx-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by host, serial, block, cluster or IPMI IP…"
          filters={[{ k: 'cluster_name', label: 'Clusters' }, { k: 'source_name', label: 'Sources' }, { k: 'hypervisor_type', label: 'Hypervisors' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading hosts…" height={160} />
        ) : list.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nx-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No hosts found.</div>
        ) : ctl.rows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nx-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No hosts match your filters.</div>
        ) : (
          <div className="nx-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ borderBottom: '1px solid var(--nx-border)' }}>
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
                  <tr key={h.id} className="nx-row">
                    <td style={td}>
                      <button onClick={() => setDetail(h)} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--nx-brand)', cursor: 'pointer', textAlign: 'left', font: 'inherit' }}>{h.name || h.uuid}</button>
                    </td>
                    <td style={td}><Badge tone={stateTone(h)}>{h.state_label}</Badge></td>
                    <td style={tdMuted}>{h.cluster_name || '—'}</td>
                    <td className="nx-tnum" style={{ ...tdMuted, fontSize: 11 }}>{h.serial || '—'}</td>
                    <td style={{ ...tdMuted, fontSize: 11 }}>{[h.block_model, h.position].filter(Boolean).join(' · ') || '—'}</td>
                    <td className="nx-tnum" style={{ ...td, textAlign: 'right', color: h.cpu_pct > 80 ? 'var(--nx-warn)' : 'var(--nx-ink-muted)', fontWeight: h.cpu_pct > 80 ? 600 : 400 }}>{h.cpu_pct != null ? `${h.cpu_pct.toFixed(0)}%` : '—'}</td>
                    <td className="nx-tnum" style={{ ...td, textAlign: 'right', color: h.mem_pct > 80 ? 'var(--nx-warn)' : 'var(--nx-ink-muted)', fontWeight: h.mem_pct > 80 ? 600 : 400 }}>{h.mem_pct != null ? `${h.mem_pct.toFixed(0)}%` : '—'}</td>
                    <td style={{ ...tdMuted, fontSize: 11 }}>{h.bios_version || '—'}{h.bmc_version ? ` / ${h.bmc_version}` : ''}</td>
                    <td style={{ ...tdMuted, fontSize: 11 }}>{h.hypervisor_type || '—'}{h.hypervisor_version ? ` ${h.hypervisor_version}` : ''}</td>
                    <td className="nx-tnum" style={{ ...tdMuted, fontSize: 11 }}>{h.ipmi_ip || '—'}</td>
                    <td className="nx-tnum" style={{ ...tdMuted, textAlign: 'right' }}>{fmtNum(h.num_vms)}</td>
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
