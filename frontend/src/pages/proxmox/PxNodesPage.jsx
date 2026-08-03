import { Fragment, useEffect, useState, useCallback } from 'react';
import { Server, ChevronDown, ChevronUp, Cpu, MemoryStick, HardDrive, ShieldCheck, Package } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum, fmtBytes, fmtWhen, humanizeSeconds } from './helpers';

const pct = (used, total) => (total > 0 && used != null ? (used / total) * 100 : null);

function NodeDetail({ node }) {
  return (
    <tr className="border-b border-cohesity-border/50">
      <td colSpan={8} className="bg-surface-overlay px-4 py-3">
        <div className="grid md:grid-cols-4 gap-3 text-xs">
          <div>
            <p className="text-ink-faint uppercase tracking-wide text-[10px] mb-0.5">Load Average</p>
            <p className="text-ink tnum">{node.loadAvg || '—'}</p>
          </div>
          <div>
            <p className="text-ink-faint uppercase tracking-wide text-[10px] mb-0.5">Kernel</p>
            <p className="text-ink">{node.kernelVersion || '—'}</p>
          </div>
          <div>
            <p className="text-ink-faint uppercase tracking-wide text-[10px] mb-0.5 flex items-center gap-1"><ShieldCheck size={11} /> Cert Expires</p>
            <p className="text-ink">{node.certExpiresAt ? fmtWhen(node.certExpiresAt) : '—'}</p>
          </div>
          <div>
            <p className="text-ink-faint uppercase tracking-wide text-[10px] mb-0.5 flex items-center gap-1"><Package size={11} /> Updates Available</p>
            <p className="text-ink tnum">{node.updatesAvailable != null ? fmtNum(node.updatesAvailable) : '—'}</p>
          </div>
          <div>
            <p className="text-ink-faint uppercase tracking-wide text-[10px] mb-0.5">Subscription</p>
            <p className="text-ink">{node.subscriptionStatus || '—'}</p>
          </div>
          <div>
            <p className="text-ink-faint uppercase tracking-wide text-[10px] mb-0.5">Uptime</p>
            <p className="text-ink tnum">{humanizeSeconds(node.uptimeSeconds)}</p>
          </div>
        </div>
      </td>
    </tr>
  );
}

export default function PxNodesPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [open, setOpen] = useState(() => new Set());

  const load = useCallback(() => client.get('/proxmox/nodes')
    .then(({ data }) => { setRows(data); setLastRefreshed(new Date()); })
    .catch(() => { setRows([]); toast({ type: 'error', title: 'Failed to load nodes' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const toggle = (id) => setOpen(s => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const list = (rows || []).map(n => ({
    ...n,
    cpu_pct: pct(n.cpuUsage != null ? n.cpuUsage * (n.cpuTotal || 1) : null, n.cpuTotal),
    mem_pct: pct(n.memUsed, n.memTotal),
    disk_pct: pct(n.diskUsed, n.diskTotal),
  }));
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'serverName', 'status'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Server} title="Nodes" description="Proxmox node state, utilization and per-node details across all registered servers">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">All Nodes</p>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by node, server or status…"
          filters={[{ k: 'serverName', label: 'Servers' }, { k: 'status', label: 'Status' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading nodes…" height={140} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No nodes found — register a Proxmox server under Settings.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No nodes match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3 w-6" />
                <SortTh k="name" label="Node" ctl={ctl} />
                <SortTh k="serverName" label="Server" ctl={ctl} />
                <SortTh k="status" label="Status" ctl={ctl} />
                <SortTh k="cpu_pct" label="CPU" ctl={ctl} align="right" />
                <SortTh k="mem_pct" label="Memory" ctl={ctl} align="right" />
                <SortTh k="disk_pct" label="Disk" ctl={ctl} align="right" />
                <SortTh k="pveVersion" label="PVE Ver" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((n) => {
                  const key = `${n.serverId}|${n.name}`;
                  const isOpen = open.has(key);
                  return (
                    <Fragment key={key}>
                      <tr className="border-b border-cohesity-border/50 cursor-pointer hover:bg-surface-overlay/60" onClick={() => toggle(key)}>
                        <td className="py-2 pr-3 text-ink-faint">{isOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</td>
                        <td className="py-2 pr-3 text-ink">{n.name || '—'}</td>
                        <td className="py-2 pr-3 text-ink-muted">{n.serverName}</td>
                        <td className="py-2 pr-3"><Badge tone={n.status === 'online' ? 'ok' : 'crit'}>{n.status || 'unknown'}</Badge></td>
                        <td className={`py-2 pr-3 text-right tnum ${n.cpu_pct > 80 ? 'text-status-warn font-semibold' : 'text-ink-muted'}`}>
                          <span className="inline-flex items-center gap-1 justify-end"><Cpu size={11} className="text-ink-faint" />{n.cpu_pct != null ? `${n.cpu_pct.toFixed(0)}%` : '—'}</span>
                        </td>
                        <td className={`py-2 pr-3 text-right tnum ${n.mem_pct > 80 ? 'text-status-warn font-semibold' : 'text-ink-muted'}`}>
                          <span className="inline-flex items-center gap-1 justify-end"><MemoryStick size={11} className="text-ink-faint" />{n.mem_pct != null ? `${n.mem_pct.toFixed(0)}%` : '—'}</span>
                        </td>
                        <td className={`py-2 pr-3 text-right tnum ${n.disk_pct > 80 ? 'text-status-warn font-semibold' : 'text-ink-muted'}`}>
                          <span className="inline-flex items-center gap-1 justify-end"><HardDrive size={11} className="text-ink-faint" />{n.disk_pct != null ? `${n.disk_pct.toFixed(0)}%` : '—'}</span>
                        </td>
                        <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{n.pveVersion || '—'}</td>
                      </tr>
                      {isOpen && <NodeDetail node={n} />}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>
    </div>
  );
}
