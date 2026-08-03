import { useEffect, useState, useCallback } from 'react';
import { History } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtWhen } from './helpers';

export default function PxEventsPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/proxmox/events', { params: { limit: 200 } })
    .then(({ data }) => { setRows(data); setLastRefreshed(new Date()); })
    .catch(() => { setRows([]); toast({ type: 'error', title: 'Failed to load events' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const ctl = useTableControls(rows || [], {
    searchKeys: ['message', 'tag', 'user', 'node', 'serverName'],
    defaultSortKey: 'eventTime', defaultSortDir: 'desc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={History} title="Events" description="Cluster log entries across all registered Proxmox servers">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Cluster Log</p>
        <TableControls ctl={ctl} rows={rows || []} searchPlaceholder="Filter by message, tag, user or node…"
          filters={[{ k: 'serverName', label: 'Servers' }, { k: 'node', label: 'Nodes' }, { k: 'tag', label: 'Tags' }, { k: 'user', label: 'Users' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading events…" height={140} />
        ) : rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No events recorded yet.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No events match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="eventTime" label="Time" ctl={ctl} />
                <SortTh k="node" label="Node" ctl={ctl} />
                <SortTh k="serverName" label="Server" ctl={ctl} />
                <SortTh k="tag" label="Tag" ctl={ctl} />
                <SortTh k="user" label="User" ctl={ctl} />
                <th className="py-2 pr-3">Message</th>
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((e) => (
                  <tr key={e.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{fmtWhen(e.eventTime)}</td>
                    <td className="py-2 pr-3 text-ink-muted">{e.node}</td>
                    <td className="py-2 pr-3 text-ink-muted">{e.serverName}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{e.tag || '—'}</td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px]">{e.user || '—'}</td>
                    <td className="py-2 pr-3 text-ink text-xs leading-relaxed max-w-[420px]">{e.message || '—'}</td>
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
