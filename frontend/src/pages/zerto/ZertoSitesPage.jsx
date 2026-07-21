import { useEffect, useState, useCallback } from 'react';
import { Globe2 } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls } from '../../components/ui/tableTools';
import { BRAND, connTone, fmtWhen, parseJsonList } from './helpers';

export default function ZertoSitesPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/zerto/sites')
    .then(({ data }) => { setRows(data); setLastRefreshed(new Date()); })
    .catch(() => { setRows([]); toast({ type: 'error', title: 'Failed to load sites' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'site_type', 'zvm_ip', 'version'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Globe2} title="Zerto Sites" description="ZVM sites reporting to Zerto Analytics">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by site, type or ZVM IP…"
          filters={[{ k: 'site_type', label: 'Types' }, { k: 'connection_status', label: 'Statuses' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading sites…" height={140} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No sites found — check the Zerto credentials under Settings.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No sites match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Site" ctl={ctl} />
                <SortTh k="site_type" label="Type" ctl={ctl} />
                <SortTh k="version" label="ZVM Version" ctl={ctl} />
                <SortTh k="zvm_ip" label="ZVM IP" ctl={ctl} />
                <SortTh k="connection_status" label="Analytics Link" ctl={ctl} />
                <SortTh k="last_connection_time" label="Last Seen" ctl={ctl} />
                <th className="py-2 pr-3 text-left text-[11px] uppercase tracking-wide">ZORGs</th>
              </tr></thead>
              <tbody>
                {ctl.rows.map((s) => (
                  <tr key={s.site_identifier} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{s.name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{s.site_type || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum">{s.version || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum">{s.zvm_ip || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={connTone(s.connection_status)}>{s.connection_status || '—'}</Badge></td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px] tnum">{fmtWhen(s.last_connection_time)}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px] max-w-[200px] truncate">{parseJsonList(s.zorgs).join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
