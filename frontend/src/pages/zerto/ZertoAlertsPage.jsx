import { useEffect, useState, useCallback } from 'react';
import { Bell } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, severityTone, fmtWhen } from './helpers';

export default function ZertoAlertsPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/zerto/alerts')
    .then(({ data }) => { setRows(data); setLastRefreshed(new Date()); })
    .catch(() => { setRows([]); toast({ type: 'error', title: 'Failed to load alerts' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['description', 'alert_type', 'site_name', 'entity_type'],
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Bell} title="Zerto Alerts" description="Active alerts across all Zerto sites">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by description, code, site or entity…"
          filters={[{ k: 'severity', label: 'Severities' }, { k: 'site_name', label: 'Sites' }, { k: 'entity_type', label: 'Entities' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading alerts…" height={140} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No active alerts.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No alerts match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="severity" label="Severity" ctl={ctl} />
                <SortTh k="alert_type" label="Code" ctl={ctl} />
                <SortTh k="description" label="Description" ctl={ctl} />
                <SortTh k="site_name" label="Site" ctl={ctl} />
                <SortTh k="entity_type" label="Entity" ctl={ctl} />
                <SortTh k="collection_time" label="Raised" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((a) => (
                  <tr key={a.alert_identifier} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3"><Badge tone={severityTone(a.severity)}>{a.severity || '—'}</Badge></td>
                    <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{a.alert_type || '—'}</td>
                    <td className="py-2 pr-3 text-ink max-w-[420px]">{a.description || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{a.site_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{a.entity_type || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px] tnum">{fmtWhen(a.collection_time)}</td>
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
