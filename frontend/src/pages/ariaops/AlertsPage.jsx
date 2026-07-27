import { useEffect, useState, useCallback } from 'react';
import { AlertTriangle } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtWhen, alertLevelTone } from './helpers';

export default function AriaOpsAlertsPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/ariaops/alerts')
    .then(({ data }) => { setRows(data); setLastRefreshed(new Date()); })
    .catch(() => { setRows([]); toast({ type: 'error', title: 'Failed to load alerts' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['definition_name', 'resource_name', 'instance_name'],
    sortValues: { started_at_ms: (r) => r.started_at_ms ?? 0 },
    defaultSortKey: 'started_at_ms', defaultSortDir: 'desc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={AlertTriangle} title="Alerts" description="Active alerts across all registered Aria Operations instances">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by definition, resource or instance…"
          filters={[{ k: 'level', label: 'Levels' }, { k: 'instance_name', label: 'Instances' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading alerts…" height={140} />
        ) : list.length === 0 ? (
          <div className="text-sm text-status-ok py-6 text-center">No active alerts.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No alerts match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="level" label="Level" ctl={ctl} />
                <SortTh k="definition_name" label="Definition" ctl={ctl} />
                <SortTh k="resource_name" label="Resource" ctl={ctl} />
                <SortTh k="instance_name" label="Instance" ctl={ctl} />
                <SortTh k="impact" label="Impact" ctl={ctl} />
                <SortTh k="started_at_ms" label="Started" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((a) => (
                  <tr key={`${a.instance_id}|${a.alert_id}`} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3"><Badge tone={alertLevelTone(a.level)}>{a.level || '—'}</Badge></td>
                    <td className="py-2 pr-3 text-ink">{a.definition_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{a.resource_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{a.instance_name}</td>
                    <td className="py-2 pr-3 text-ink-muted">{a.impact || '—'}</td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">{a.started_at_ms ? fmtWhen(new Date(Number(a.started_at_ms)).toISOString()) : '—'}</td>
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
