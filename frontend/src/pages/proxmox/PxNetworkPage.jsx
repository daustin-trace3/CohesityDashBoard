import { useEffect, useState, useCallback } from 'react';
import { Network, Wifi } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, parseIpAddresses } from './helpers';

function InterfacesSection({ rows }) {
  const ctl = useTableControls(rows, {
    searchKeys: ['iface', 'node', 'serverName', 'ifaceType', 'method', 'cidr'],
    defaultSortKey: 'node', defaultSortDir: 'asc',
    paginate: true,
  });
  return (
    <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><Network size={15} className="text-brand" /> Node Interfaces</p>
      <p className="text-[11px] text-ink-faint mb-3">Network interface configuration per node — bridges, VLANs and addressing.</p>
      <TableControls ctl={ctl} rows={rows} searchPlaceholder="Filter by interface, node or type…"
        filters={[{ k: 'serverName', label: 'Servers' }, { k: 'node', label: 'Nodes' }, { k: 'ifaceType', label: 'Types' }, { k: 'active', label: 'Active' }]} />
      {rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No node network data yet.</div>
      ) : ctl.rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No interfaces match your filters.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
              <SortTh k="iface" label="Interface" ctl={ctl} />
              <SortTh k="ifaceType" label="Type" ctl={ctl} />
              <SortTh k="node" label="Node" ctl={ctl} />
              <SortTh k="serverName" label="Server" ctl={ctl} />
              <SortTh k="method" label="Method" ctl={ctl} />
              <SortTh k="cidr" label="CIDR" ctl={ctl} />
              <SortTh k="vlanId" label="VLAN" ctl={ctl} align="right" />
              <SortTh k="active" label="Active" ctl={ctl} />
              <th className="py-2 pr-3">Comments</th>
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((r) => (
                <tr key={r.id} className="border-b border-cohesity-border/50">
                  <td className="py-2 pr-3 text-ink tnum">{r.iface}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[11px]">{r.ifaceType || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted">{r.node}</td>
                  <td className="py-2 pr-3 text-ink-muted">{r.serverName}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[11px]">{r.method || '—'}</td>
                  <td className="py-2 pr-3 text-ink tnum">{r.cidr || '—'}</td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted">{r.vlanId ?? '—'}</td>
                  <td className="py-2 pr-3"><Badge tone={r.active ? 'ok' : 'neutral'}>{r.active ? 'active' : 'inactive'}</Badge></td>
                  <td className="py-2 pr-3 text-ink-faint text-[11px] max-w-[220px] truncate" title={r.comments}>{r.comments || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <TablePager ctl={ctl} />
    </div>
  );
}

function GuestIpsSection({ rows }) {
  const ctl = useTableControls(rows, {
    searchKeys: ['name', 'node', 'serverName', 'ipList'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });
  return (
    <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><Wifi size={15} className="text-brand" /> Guest IPs</p>
      <p className="text-[11px] text-ink-faint mb-3">Guests with a running QEMU/LXC agent reporting IP addresses.</p>
      <TableControls ctl={ctl} rows={rows} searchPlaceholder="Filter by guest, node or IP…"
        filters={[{ k: 'serverName', label: 'Servers' }, { k: 'node', label: 'Nodes' }]} />
      {rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No guests with agent-reported IPs yet.</div>
      ) : ctl.rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No guests match your filters.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
              <SortTh k="name" label="Guest" ctl={ctl} />
              <SortTh k="vmid" label="VMID" ctl={ctl} />
              <SortTh k="node" label="Node" ctl={ctl} />
              <SortTh k="serverName" label="Server" ctl={ctl} />
              <th className="py-2 pr-3">IP Addresses</th>
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((g) => (
                <tr key={g.id} className="border-b border-cohesity-border/50">
                  <td className="py-2 pr-3 text-ink">{g.name}</td>
                  <td className="py-2 pr-3 text-ink-muted tnum">{g.vmid}</td>
                  <td className="py-2 pr-3 text-ink-muted">{g.node}</td>
                  <td className="py-2 pr-3 text-ink-muted">{g.serverName}</td>
                  <td className="py-2 pr-3 text-ink tnum">{g.ipList}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <TablePager ctl={ctl} />
    </div>
  );
}

export default function PxNetworkPage() {
  const { toast } = useToast();
  const [ifaces, setIfaces] = useState(null);
  const [guests, setGuests] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => Promise.all([
    client.get('/proxmox/network').then(({ data }) => setIfaces(data)),
    client.get('/proxmox/guests').then(({ data }) => setGuests(data)),
  ]).then(() => setLastRefreshed(new Date()))
    .catch(() => { setIfaces(i => i || []); setGuests(g => g || []); toast({ type: 'error', title: 'Failed to load network inventory' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const guestIpRows = (guests || [])
    .map(g => ({ ...g, ipList: parseIpAddresses(g.ipAddresses).join(', ') }))
    .filter(g => g.agentRunning && g.ipList);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Network} title="Network" description="Node network interfaces and guest agent-reported IP addresses across all registered Proxmox servers">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {ifaces == null || guests == null ? (
        <LoadingPanel label="Loading network inventory…" height={200} />
      ) : (
        <>
          <InterfacesSection rows={ifaces} />
          <GuestIpsSection rows={guestIpRows} />
        </>
      )}
    </div>
  );
}
