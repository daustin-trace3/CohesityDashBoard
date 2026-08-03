// Proxmox Network — ports host frontend/src/pages/proxmox/PxNetworkPage.jsx.
import {
  injectStyles, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager,
  NetworkIcon, WifiIcon, parseIpAddresses,
} from '../ui.jsx';

injectStyles();

const BRAND = '#E57000';

function apiGet(path) {
  return fetch(`/api/proxmox${path}`, { credentials: 'include' }).then((res) => {
    if (!res.ok) throw new Error(`request failed: ${res.status}`);
    return res.json();
  });
}

function InterfacesSection({ rows }) {
  const ctl = useTableControls(rows, {
    searchKeys: ['iface', 'node', 'serverName', 'ifaceType', 'method', 'cidr'],
    defaultSortKey: 'node', defaultSortDir: 'asc',
    paginate: true,
  });
  return (
    <div className="px-panel" style={{ padding: 16, marginBottom: 16, borderTop: `3px solid ${BRAND}` }}>
      <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--px-ink)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
        <NetworkIcon size={15} style={{ color: 'var(--px-brand)' }} /> Node Interfaces
      </p>
      <p style={{ fontSize: 11, color: 'var(--px-ink-faint)', marginBottom: 12 }}>Network interface configuration per node — bridges, VLANs and addressing.</p>
      <TableControls ctl={ctl} rows={rows} searchPlaceholder="Filter by interface, node or type…"
        filters={[{ k: 'serverName', label: 'Servers' }, { k: 'node', label: 'Nodes' }, { k: 'ifaceType', label: 'Types' }, { k: 'active', label: 'Active' }]} />
      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--px-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No node network data yet.</div>
      ) : ctl.rows.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--px-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No interfaces match your filters.</div>
      ) : (
        <div className="px-scroll" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--px-border)' }}>
                <SortTh k="iface" label="Interface" ctl={ctl} />
                <SortTh k="ifaceType" label="Type" ctl={ctl} />
                <SortTh k="node" label="Node" ctl={ctl} />
                <SortTh k="serverName" label="Server" ctl={ctl} />
                <SortTh k="method" label="Method" ctl={ctl} />
                <SortTh k="cidr" label="CIDR" ctl={ctl} />
                <SortTh k="vlanId" label="VLAN" ctl={ctl} align="right" />
                <SortTh k="active" label="Active" ctl={ctl} />
                <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-muted)' }}>Comments</th>
              </tr>
            </thead>
            <tbody>
              {ctl.pageRows.map((r) => (
                <tr key={r.id} className="px-row" style={{ borderBottom: '1px solid var(--px-border)' }}>
                  <td className="px-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink)' }}>{r.iface}</td>
                  <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)', fontSize: 11 }}>{r.ifaceType || '—'}</td>
                  <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)' }}>{r.node}</td>
                  <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)' }}>{r.serverName}</td>
                  <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)', fontSize: 11 }}>{r.method || '—'}</td>
                  <td className="px-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink)' }}>{r.cidr || '—'}</td>
                  <td className="px-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--px-ink-muted)' }}>{r.vlanId ?? '—'}</td>
                  <td style={{ padding: '8px 12px 8px 0' }}><Badge tone={r.active ? 'ok' : 'neutral'}>{r.active ? 'active' : 'inactive'}</Badge></td>
                  <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-faint)', fontSize: 11, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.comments}>{r.comments || '—'}</td>
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
    <div className="px-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
      <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--px-ink)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
        <WifiIcon size={15} style={{ color: 'var(--px-brand)' }} /> Guest IPs
      </p>
      <p style={{ fontSize: 11, color: 'var(--px-ink-faint)', marginBottom: 12 }}>Guests with a running QEMU/LXC agent reporting IP addresses.</p>
      <TableControls ctl={ctl} rows={rows} searchPlaceholder="Filter by guest, node or IP…"
        filters={[{ k: 'serverName', label: 'Servers' }, { k: 'node', label: 'Nodes' }]} />
      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--px-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No guests with agent-reported IPs yet.</div>
      ) : ctl.rows.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--px-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No guests match your filters.</div>
      ) : (
        <div className="px-scroll" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--px-border)' }}>
                <SortTh k="name" label="Guest" ctl={ctl} />
                <SortTh k="vmid" label="VMID" ctl={ctl} />
                <SortTh k="node" label="Node" ctl={ctl} />
                <SortTh k="serverName" label="Server" ctl={ctl} />
                <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-muted)' }}>IP Addresses</th>
              </tr>
            </thead>
            <tbody>
              {ctl.pageRows.map((g) => (
                <tr key={g.id} className="px-row" style={{ borderBottom: '1px solid var(--px-border)' }}>
                  <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink)' }}>{g.name}</td>
                  <td className="px-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)' }}>{g.vmid}</td>
                  <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)' }}>{g.node}</td>
                  <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)' }}>{g.serverName}</td>
                  <td className="px-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink)' }}>{g.ipList}</td>
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
  const [ifaces, setIfaces] = React.useState(null);
  const [guests, setGuests] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(() => {
    setLoading(true);
    return Promise.all([
      apiGet('/network').then((d) => setIfaces(d)),
      apiGet('/guests').then((d) => setGuests(d)),
    ]).then(() => setLastRefreshed(new Date()))
      .catch(() => { setIfaces((i) => i || []); setGuests((g) => g || []); })
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const guestIpRows = (guests || [])
    .map((g) => ({ ...g, ipList: parseIpAddresses(g.ipAddresses).join(', ') }))
    .filter((g) => g.agentRunning && g.ipList);

  return (
    <div className="px-root px-fade-in">
      <PageHeader icon={NetworkIcon} title="Network" description="Node network interfaces and guest agent-reported IP addresses across all registered Proxmox servers">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} refreshing={loading} />
      </PageHeader>

      {ifaces == null || guests == null ? (
        <LoadingPanel label="Loading network inventory…" height={200} />
      ) : (
        <React.Fragment>
          <InterfacesSection rows={ifaces} />
          <GuestIpsSection rows={guestIpRows} />
        </React.Fragment>
      )}
    </div>
  );
}
