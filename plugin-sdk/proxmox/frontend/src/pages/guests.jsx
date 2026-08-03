// Proxmox Guests — ports host frontend/src/pages/proxmox/PxGuestsPage.jsx.
import {
  injectStyles, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager,
  MonitorIcon, fmtWhen, humanizeSeconds, parseIpAddresses, fmtBytes,
} from '../ui.jsx';

injectStyles();

const BRAND = '#E57000';

function apiGet(path) {
  return fetch(`/api/proxmox${path}`, { credentials: 'include' }).then((res) => {
    if (!res.ok) throw new Error(`request failed: ${res.status}`);
    return res.json();
  });
}

const pct = (used, total) => (total > 0 && used != null ? (used / total) * 100 : null);
const guestTypeLabel = (t) => (t === 'qemu' ? 'VM' : t === 'lxc' ? 'LXC' : t || '—');
const backupStatusTone = (status) => (!status ? 'neutral' : status === 'OK' ? 'ok' : 'crit');

export default function PxGuestsPage() {
  const navigate = ReactRouterDOM.useNavigate();
  const [rows, setRows] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(() => {
    setLoading(true);
    return apiGet('/guests')
      .then((d) => { setRows(d); setLastRefreshed(new Date()); })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const list = (rows || []).map((g) => ({
    ...g,
    typeLabel: guestTypeLabel(g.type),
    mem_pct: pct(g.memUsed, g.memTotal),
    disk_pct: pct(g.diskUsed, g.diskTotal),
    ipList: parseIpAddresses(g.ipAddresses).join(', '),
  }));
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'vmid', 'node', 'serverName', 'status', 'typeLabel', 'pool', 'tags', 'osName', 'ipList'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });

  return (
    <div className="px-root px-fade-in">
      <PageHeader icon={MonitorIcon} title="Guests" description="Virtual machines and LXC containers across all registered Proxmox servers">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} refreshing={loading} />
      </PageHeader>

      <div className="px-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--px-ink)', marginBottom: 12 }}>All Guests</p>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by name, vmid, node or tag…"
          filters={[
            { k: 'typeLabel', label: 'Types' },
            { k: 'status', label: 'Status' },
            { k: 'serverName', label: 'Servers' },
            { k: 'node', label: 'Nodes' },
          ]} />
        {rows == null ? (
          <LoadingPanel label="Loading guests…" height={140} />
        ) : list.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--px-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No guests found — register a Proxmox server under Settings.</div>
        ) : ctl.rows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--px-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No guests match your filters.</div>
        ) : (
          <div className="px-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--px-border)' }}>
                  <SortTh k="name" label="Name" ctl={ctl} />
                  <SortTh k="vmid" label="VMID" ctl={ctl} />
                  <SortTh k="typeLabel" label="Type" ctl={ctl} />
                  <SortTh k="status" label="Status" ctl={ctl} />
                  <SortTh k="node" label="Node" ctl={ctl} />
                  <SortTh k="serverName" label="Server" ctl={ctl} />
                  <SortTh k="osName" label="OS" ctl={ctl} />
                  <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--px-ink-muted)' }}>IP Address</th>
                  <SortTh k="cpuUsage" label="CPU" ctl={ctl} align="right" />
                  <SortTh k="mem_pct" label="Memory" ctl={ctl} align="right" />
                  <SortTh k="uptimeSeconds" label="Uptime" ctl={ctl} align="right" />
                  <SortTh k="lastBackupAt" label="Last Backup" ctl={ctl} />
                </tr>
              </thead>
              <tbody>
                {ctl.pageRows.map((g) => (
                  <tr key={`${g.serverId}|${g.vmid}|${g.type}`} className="px-row" style={{ borderBottom: '1px solid var(--px-border)' }}>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink)' }}>
                      <a
                        onClick={(e) => { e.preventDefault(); navigate(`/proxmox/guests/${g.id}`); }}
                        href={`/proxmox/guests/${g.id}`}
                        style={{ color: 'var(--px-brand)', cursor: 'pointer' }}
                      >
                        {g.name || '—'}
                      </a>
                      {g.isTemplate ? <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--px-ink-faint)' }}>(template)</span> : ''}
                    </td>
                    <td className="px-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)' }}>{g.vmid}</td>
                    <td style={{ padding: '8px 12px 8px 0' }}><Badge tone={g.type === 'qemu' ? 'brand' : 'info'}>{g.typeLabel}</Badge></td>
                    <td style={{ padding: '8px 12px 8px 0' }}><Badge tone={g.status === 'running' ? 'ok' : 'neutral'}>{g.status || '—'}</Badge></td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)' }}>{g.node}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)' }}>{g.serverName}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)', fontSize: 11, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={g.osName}>{g.osName || '—'}</td>
                    <td className="px-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)', fontSize: 11, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={g.ipList}>{g.ipList || '—'}</td>
                    <td className="px-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--px-ink-muted)' }}>{g.cpuUsage != null ? `${(g.cpuUsage * 100).toFixed(0)}%` : '—'}</td>
                    <td className="px-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--px-ink-muted)' }}>
                      {g.mem_pct != null ? `${g.mem_pct.toFixed(0)}% (${fmtBytes(g.memUsed)})` : '—'}
                    </td>
                    <td className="px-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--px-ink-muted)' }}>{g.status === 'running' ? humanizeSeconds(g.uptimeSeconds) : '—'}</td>
                    <td style={{ padding: '8px 12px 8px 0', fontSize: 11 }}>
                      {g.lastBackupAt ? (
                        <span style={{ color: g.lastBackupStatus === 'OK' ? 'var(--px-ok)' : 'var(--px-crit)' }}>{fmtWhen(g.lastBackupAt)}</span>
                      ) : (
                        <Badge tone={backupStatusTone(g.lastBackupStatus)}>never</Badge>
                      )}
                    </td>
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
