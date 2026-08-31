import { useEffect, useState, useCallback } from 'react';
import { Cable } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum, statusTone } from './helpers';

export default function BrocadePortsPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/brocade/ports')
    .then(({ data }) => { setRows(data.ports || []); setLastRefreshed(new Date()); })
    .catch(() => { setRows([]); toast({ type: 'error', title: 'Failed to load ports' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const list = (rows || []).map((p) => ({
    ...p,
    flagged: p.fenced || p.blocked ? 'Fenced/Blocked' : '',
  }));
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'switchName', 'fabricName', 'remoteDevice', 'wwn', 'zoneAlias'],
    defaultSortKey: 'switchName', defaultSortDir: 'asc',
    paginate: true, defaultPageSize: 50,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Cable} title="Ports" description="Switch ports across all Brocade fabrics">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by port, switch, fabric, WWN or remote device…"
          filters={[
            { k: 'fabricName', label: 'Fabrics' },
            { k: 'switchName', label: 'Switches' },
            { k: 'state', label: 'States' },
            { k: 'health', label: 'Health' },
            { k: 'type', label: 'Types' },
          ]} />
        {rows == null ? (
          <LoadingPanel label="Loading ports…" height={200} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No ports found.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No ports match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="switchName" label="Switch" ctl={ctl} />
                <SortTh k="name" label="Port" ctl={ctl} />
                <SortTh k="fabricName" label="Fabric" ctl={ctl} />
                <SortTh k="type" label="Type" ctl={ctl} />
                <SortTh k="state" label="State" ctl={ctl} />
                <SortTh k="health" label="Health" ctl={ctl} />
                <SortTh k="speed" label="Speed" ctl={ctl} />
                <SortTh k="remoteDevice" label="Remote Device" ctl={ctl} />
                <SortTh k="zoneAlias" label="Zone/Alias" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((p) => (
                  <tr key={p.id} className={`border-b border-cohesity-border/50 ${(p.fenced || p.blocked) ? 'bg-status-crit/5' : ''}`}>
                    <td className="py-2 pr-3 text-ink">{p.switchName}</td>
                    <td className="py-2 pr-3 text-ink-muted">{p.name || p.portId}</td>
                    <td className="py-2 pr-3 text-ink-faint">{p.fabricName || '—'}</td>
                    <td className="py-2 pr-3 text-ink-faint">{p.type || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={statusTone(p.state)}>{p.state || 'Unknown'}</Badge></td>
                    <td className="py-2 pr-3">
                      <Badge tone={statusTone(p.health)}>{p.health || 'Unknown'}</Badge>
                      {(p.fenced || p.blocked) && <Badge tone="crit" className="ml-1">{p.fenced ? 'Fenced' : 'Blocked'}</Badge>}
                    </td>
                    <td className="py-2 pr-3 text-ink-muted tnum">{p.speed || '—'}</td>
                    <td className="py-2 pr-3 text-ink-faint max-w-[220px] truncate" title={p.remoteDevice || ''}>{p.remoteDevice || '—'}</td>
                    <td className="py-2 pr-3 text-ink-faint">{p.zoneAlias || '—'}{p.activeZoneCount ? ` (${fmtNum(p.activeZoneCount)})` : ''}</td>
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
