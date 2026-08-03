import { useEffect, useState, useCallback } from 'react';
import { MonitorSmartphone } from 'lucide-react';
import { Link } from 'react-router-dom';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtBytes, fmtWhen, guestTypeLabel, backupStatusTone, humanizeSeconds, parseIpAddresses } from './helpers';

const pct = (used, total) => (total > 0 && used != null ? (used / total) * 100 : null);

export default function PxGuestsPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/proxmox/guests')
    .then(({ data }) => { setRows(data); setLastRefreshed(new Date()); })
    .catch(() => { setRows([]); toast({ type: 'error', title: 'Failed to load guests' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const list = (rows || []).map(g => ({
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
    <div className="animate-fade-in">
      <PageHeader icon={MonitorSmartphone} title="Guests" description="Virtual machines and LXC containers across all registered Proxmox servers">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">All Guests</p>
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
          <div className="text-sm text-ink-muted py-6 text-center">No guests found — register a Proxmox server under Settings.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No guests match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Name" ctl={ctl} />
                <SortTh k="vmid" label="VMID" ctl={ctl} />
                <SortTh k="typeLabel" label="Type" ctl={ctl} />
                <SortTh k="status" label="Status" ctl={ctl} />
                <SortTh k="node" label="Node" ctl={ctl} />
                <SortTh k="serverName" label="Server" ctl={ctl} />
                <SortTh k="osName" label="OS" ctl={ctl} />
                <th className="py-2 pr-3">IP Address</th>
                <SortTh k="cpuUsage" label="CPU" ctl={ctl} align="right" />
                <SortTh k="mem_pct" label="Memory" ctl={ctl} align="right" />
                <SortTh k="uptimeSeconds" label="Uptime" ctl={ctl} align="right" />
                <SortTh k="lastBackupAt" label="Last Backup" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((g) => (
                  <tr key={`${g.serverId}|${g.vmid}|${g.type}`} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">
                      <Link to={`/proxmox/guests/${g.id}`} className="text-brand hover:underline">
                        {g.name || '—'}
                      </Link>
                      {g.isTemplate ? <span className="ml-1.5 text-[10px] text-ink-faint">(template)</span> : ''}
                    </td>
                    <td className="py-2 pr-3 text-ink-muted tnum">{g.vmid}</td>
                    <td className="py-2 pr-3"><Badge tone={g.type === 'qemu' ? 'brand' : 'info'}>{g.typeLabel}</Badge></td>
                    <td className="py-2 pr-3"><Badge tone={g.status === 'running' ? 'ok' : 'neutral'}>{g.status || '—'}</Badge></td>
                    <td className="py-2 pr-3 text-ink-muted">{g.node}</td>
                    <td className="py-2 pr-3 text-ink-muted">{g.serverName}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px] max-w-[160px] truncate" title={g.osName}>{g.osName || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px] tnum max-w-[160px] truncate" title={g.ipList}>{g.ipList || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{g.cpuUsage != null ? `${(g.cpuUsage * 100).toFixed(0)}%` : '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">
                      {g.mem_pct != null ? `${g.mem_pct.toFixed(0)}% (${fmtBytes(g.memUsed)})` : '—'}
                    </td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{g.status === 'running' ? humanizeSeconds(g.uptimeSeconds) : '—'}</td>
                    <td className="py-2 pr-3 text-[11px]">
                      {g.lastBackupAt ? (
                        <span className={g.lastBackupStatus === 'OK' ? 'text-status-ok' : 'text-status-crit'}>
                          {fmtWhen(g.lastBackupAt)}
                        </span>
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
