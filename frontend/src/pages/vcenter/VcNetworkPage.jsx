import { useEffect, useState, useCallback } from 'react';
import { Network, Cable, Share2, EthernetPort, Waypoints } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum } from './helpers';
import { VmListModal, VmDetailModal } from './VmModals';

const fmtSpeed = (mbps) => mbps == null ? '—' : mbps >= 1000 ? `${mbps / 1000} Gbps` : `${mbps} Mbps`;

/* Each section owns its own table-controls instance. */

function PnicSection({ rows }) {
  const ctl = useTableControls(rows, {
    searchKeys: ['name', 'host_name', 'vcenter_name', 'mac'],
    defaultSortKey: 'host_name', defaultSortDir: 'asc',
    paginate: true, defaultPageSize: 10,
  });
  return (
    <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><EthernetPort size={15} className="text-brand" /> Physical NICs</p>
      <p className="text-[11px] text-ink-faint mb-3">Physical uplink adapters per ESXi host, with link speed and driver.</p>
      <TableControls ctl={ctl} rows={rows} searchPlaceholder="Filter by device, host or MAC…"
        filters={[{ k: 'vcenter_name', label: 'vCenters' }, { k: 'host_name', label: 'Hosts' }]} />
      {ctl.rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">{rows.length === 0 ? 'No physical NIC data yet.' : 'No NICs match your filters.'}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
              <SortTh k="name" label="Device" ctl={ctl} />
              <SortTh k="host_name" label="Host" ctl={ctl} />
              <SortTh k="vcenter_name" label="vCenter" ctl={ctl} />
              <SortTh k="speed_mbps" label="Speed" ctl={ctl} align="right" />
              <SortTh k="mac" label="MAC" ctl={ctl} />
              <th className="py-2 pr-3">Driver</th>
              <th className="py-2 pr-3">Link</th>
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((r) => (
                <tr key={r.id} className="border-b border-cohesity-border/50">
                  <td className="py-2 pr-3 text-ink tnum">{r.name || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{r.host_name || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted">{r.vcenter_name}</td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtSpeed(r.speed_mbps)}</td>
                  <td className="py-2 pr-3 text-ink-faint tnum text-[11px]">{r.mac || '—'}</td>
                  <td className="py-2 pr-3 text-ink-faint text-[11px]">{r.extra?.driver || '—'}</td>
                  <td className="py-2 pr-3"><Badge tone={r.extra?.linkUp ? 'ok' : 'crit'}>{r.extra?.linkUp ? 'UP' : 'DOWN'}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <TablePager ctl={ctl} sizes={[10, 25, 50, 'all']} />
    </div>
  );
}

function SwitchSection({ vswitches, dvswitches }) {
  const rows = [
    ...dvswitches.map(s => ({ ...s, scope: 'Distributed' })),
    ...vswitches.map(s => ({ ...s, scope: 'Standard' })),
  ];
  const ctl = useTableControls(rows, {
    searchKeys: ['name', 'host_name', 'vcenter_name'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true, defaultPageSize: 10,
  });
  return (
    <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><Share2 size={15} className="text-brand" /> Virtual Switches</p>
      <p className="text-[11px] text-ink-faint mb-3">Distributed switches (vCenter-wide) and standard vSwitches (per host) with their uplinks.</p>
      <TableControls ctl={ctl} rows={rows} searchPlaceholder="Filter by switch, host or vCenter…"
        filters={[{ k: 'vcenter_name', label: 'vCenters' }, { k: 'scope', label: 'Types' }]} />
      {ctl.rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">{rows.length === 0 ? 'No switch data yet.' : 'No switches match your filters.'}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
              <SortTh k="name" label="Switch" ctl={ctl} />
              <SortTh k="scope" label="Type" ctl={ctl} />
              <SortTh k="host_name" label="Host" ctl={ctl} />
              <SortTh k="vcenter_name" label="vCenter" ctl={ctl} />
              <SortTh k="port_count" label="Ports" ctl={ctl} align="right" />
              <SortTh k="mtu" label="MTU" ctl={ctl} align="right" />
              <th className="py-2 pr-3">Uplinks</th>
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((r) => (
                <tr key={r.id} className="border-b border-cohesity-border/50">
                  <td className="py-2 pr-3 text-ink">{r.name || '—'}</td>
                  <td className="py-2 pr-3"><Badge tone={r.scope === 'Distributed' ? 'info' : 'neutral'}>{r.scope}</Badge></td>
                  <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{r.host_name || 'vCenter-wide'}</td>
                  <td className="py-2 pr-3 text-ink-muted">{r.vcenter_name}</td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(r.port_count)}</td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted">{r.mtu ?? '—'}</td>
                  <td className="py-2 pr-3 text-ink-faint tnum text-[11px]">{(r.uplinks || []).join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <TablePager ctl={ctl} sizes={[10, 25, 50, 'all']} />
    </div>
  );
}

function PortgroupSection({ portgroups, dvportgroups, onShowVms }) {
  const rows = [
    ...dvportgroups.map(g => ({ ...g, scope: 'Distributed' })),
    ...portgroups.map(g => ({ ...g, scope: 'Standard' })),
  ];
  const ctl = useTableControls(rows, {
    searchKeys: ['name', 'switch_name', 'host_name', 'vcenter_name'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true, defaultPageSize: 10,
  });
  return (
    <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><Waypoints size={15} className="text-brand" /> Port Groups</p>
      <p className="text-[11px] text-ink-faint mb-3">Configured port groups with VLAN IDs — distributed groups span the DVS; standard groups are per host.</p>
      <TableControls ctl={ctl} rows={rows} searchPlaceholder="Filter by port group, switch or host…"
        filters={[{ k: 'vcenter_name', label: 'vCenters' }, { k: 'scope', label: 'Types' }, { k: 'switch_name', label: 'Switches' }]} />
      {ctl.rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">{rows.length === 0 ? 'No port group data yet.' : 'No port groups match your filters.'}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
              <SortTh k="name" label="Port Group" ctl={ctl} />
              <SortTh k="scope" label="Type" ctl={ctl} />
              <SortTh k="vlan_id" label="VLAN" ctl={ctl} align="right" />
              <SortTh k="vm_count" label="VMs" ctl={ctl} align="right" />
              <SortTh k="switch_name" label="Switch" ctl={ctl} />
              <SortTh k="host_name" label="Host" ctl={ctl} />
              <SortTh k="vcenter_name" label="vCenter" ctl={ctl} />
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((r) => (
                <tr key={r.id} className="border-b border-cohesity-border/50">
                  <td className="py-2 pr-3">
                    <button onClick={() => onShowVms(r)} className="text-brand hover:underline cursor-pointer text-left">{r.name || '—'}</button>
                  </td>
                  <td className="py-2 pr-3"><Badge tone={r.scope === 'Distributed' ? 'info' : 'neutral'}>{r.scope}</Badge></td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted">{r.vlan_id ?? '—'}</td>
                  <td className="py-2 pr-3 text-right tnum text-ink">{fmtNum(r.vm_count)}</td>
                  <td className="py-2 pr-3 text-ink-muted">{r.switch_name || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{r.host_name || 'vCenter-wide'}</td>
                  <td className="py-2 pr-3 text-ink-muted">{r.vcenter_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <TablePager ctl={ctl} sizes={[10, 25, 50, 'all']} />
    </div>
  );
}

function VmkernelSection({ rows }) {
  const ctl = useTableControls(rows, {
    searchKeys: ['name', 'host_name', 'vcenter_name', 'ip_address', 'switch_name'],
    defaultSortKey: 'host_name', defaultSortDir: 'asc',
    paginate: true, defaultPageSize: 10,
  });
  return (
    <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><Cable size={15} className="text-brand" /> VMkernel Interfaces</p>
      <p className="text-[11px] text-ink-faint mb-3">Host management/vMotion/storage interfaces with their IP configuration.</p>
      <TableControls ctl={ctl} rows={rows} searchPlaceholder="Filter by device, host, IP or port group…"
        filters={[{ k: 'vcenter_name', label: 'vCenters' }, { k: 'host_name', label: 'Hosts' }]} />
      {ctl.rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">{rows.length === 0 ? 'No VMkernel data yet.' : 'No interfaces match your filters.'}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
              <SortTh k="name" label="Device" ctl={ctl} />
              <SortTh k="host_name" label="Host" ctl={ctl} />
              <SortTh k="vcenter_name" label="vCenter" ctl={ctl} />
              <SortTh k="ip_address" label="IP Address" ctl={ctl} />
              <SortTh k="netmask" label="Netmask" ctl={ctl} />
              <SortTh k="switch_name" label="Port Group" ctl={ctl} />
              <SortTh k="mtu" label="MTU" ctl={ctl} align="right" />
              <th className="py-2 pr-3">Addressing</th>
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((r) => (
                <tr key={r.id} className="border-b border-cohesity-border/50">
                  <td className="py-2 pr-3 text-ink tnum">{r.name || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{r.host_name || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted">{r.vcenter_name}</td>
                  <td className="py-2 pr-3 text-ink tnum">{r.ip_address || '—'}</td>
                  <td className="py-2 pr-3 text-ink-faint tnum text-[11px]">{r.netmask || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted">{r.switch_name || '—'}</td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted">{r.mtu ?? '—'}</td>
                  <td className="py-2 pr-3"><Badge tone="neutral">{r.extra?.dhcp ? 'DHCP' : 'Static'}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <TablePager ctl={ctl} sizes={[10, 25, 50, 'all']} />
    </div>
  );
}

export default function VcNetworkPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [vmModal, setVmModal] = useState(null);   // { title, subtitle, filter }
  const [detailVmId, setDetailVmId] = useState(null);

  const load = useCallback(() => client.get('/vcenter/network')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ pnics: [], vswitches: [], portgroups: [], vmkernels: [], dvswitches: [], dvportgroups: [] }); toast({ type: 'error', title: 'Failed to load network inventory' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const empty = data && ['pnics', 'vswitches', 'portgroups', 'vmkernels', 'dvswitches', 'dvportgroups'].every(k => (data[k] || []).length === 0);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Network} title="Network" description="Physical and logical network configuration across all vCenters — NICs, switches, port groups and VMkernel interfaces">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {data == null ? (
        <LoadingPanel label="Loading network inventory…" height={200} />
      ) : empty ? (
        <div className="panel p-6 text-sm text-ink-muted text-center">
          No network configuration collected yet — this data comes from the SOAP enrichment sweep and appears after the next poll of a registered vCenter.
        </div>
      ) : (
        <>
          <PnicSection rows={data.pnics || []} />
          <SwitchSection vswitches={data.vswitches || []} dvswitches={data.dvswitches || []} />
          <PortgroupSection portgroups={data.portgroups || []} dvportgroups={data.dvportgroups || []}
            onShowVms={(pg) => setVmModal({
              title: `VMs on ${pg.name}`,
              subtitle: `${pg.scope} port group${pg.vlan_id != null ? ` · VLAN ${pg.vlan_id}` : ''} · ${pg.vcenter_name}`,
              filter: { network: pg.name, vcenterId: pg.vcenter_id },
            })} />
          <VmkernelSection rows={data.vmkernels || []} />
        </>
      )}

      {vmModal && (
        <VmListModal {...vmModal} onClose={() => setVmModal(null)}
          onSelectVm={(v) => setDetailVmId(v.id)} />
      )}
      {detailVmId != null && <VmDetailModal vmId={detailVmId} onClose={() => setDetailVmId(null)} />}
    </div>
  );
}
