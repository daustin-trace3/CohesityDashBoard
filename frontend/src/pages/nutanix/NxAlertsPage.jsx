import { useEffect, useState, useCallback } from 'react';
import { Bell } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, severityTone, fmtWhen } from './helpers';

export default function NxAlertsPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/nutanix/alerts')
    .then(({ data }) => { setRows(data.alerts || []); setLastRefreshed(new Date()); })
    .catch(() => { setRows([]); toast({ type: 'error', title: 'Failed to load alerts' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const list = (rows || []).map(a => ({
    ...a,
    state: a.resolved ? 'Resolved' : a.acknowledged ? 'Acknowledged' : 'Open',
  }));
  const ctl = useTableControls(list, {
    searchKeys: ['title', 'message', 'entity_name', 'cluster_name'],
    defaultSortKey: 'created_at', defaultSortDir: 'desc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Bell} title="Alerts" description="Prism alerts across all registered Nutanix clusters">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by title, message, entity or cluster…"
          filters={[
            { k: 'severity', label: 'Severities' },
            { k: 'cluster_name', label: 'Clusters' },
            { k: 'state', label: 'States' },
          ]} />
        {rows == null ? (
          <LoadingPanel label="Loading alerts…" height={160} />
        ) : list.length === 0 ? (
          <div className="text-sm text-status-ok py-6 text-center">No alerts.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No alerts match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="severity" label="Severity" ctl={ctl} />
                <SortTh k="title" label="Title" ctl={ctl} />
                <SortTh k="entity_name" label="Entity" ctl={ctl} />
                <SortTh k="cluster_name" label="Cluster" ctl={ctl} />
                <SortTh k="state" label="State" ctl={ctl} />
                <SortTh k="created_at" label="Created" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((a) => (
                  <tr key={a.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3"><Badge tone={severityTone(a.severity)}>{a.severity}</Badge></td>
                    <td className="py-2 pr-3 text-ink max-w-[320px] truncate" title={a.message || a.title}>{a.title || a.message || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{a.entity_type ? `${a.entity_type}: ` : ''}{a.entity_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{a.cluster_name || '—'}</td>
                    <td className="py-2 pr-3">
                      <Badge tone={a.resolved ? 'ok' : a.acknowledged ? 'info' : 'warn'}>{a.state}</Badge>
                    </td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">{fmtWhen(a.created_at)}</td>
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
