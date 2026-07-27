import { useEffect, useState, useCallback } from 'react';
import { Package } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum, fmtWhen, statusTone, leaseTone } from './helpers';

export default function AriaDeploymentsPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/aria/deployments')
    .then(({ data }) => { setRows(data); setLastRefreshed(new Date()); })
    .catch(() => { setRows([]); toast({ type: 'error', title: 'Failed to load deployments' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'instance_name', 'project_name', 'created_by'],
    defaultSortKey: 'created_at_src', defaultSortDir: 'desc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Package} title="Deployments" description="Aria Automation deployments across all registered instances">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by name, project or requester…"
          filters={[{ k: 'instance_name', label: 'Instances' }, { k: 'project_name', label: 'Projects' }, { k: 'status', label: 'Statuses' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading deployments…" height={140} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No deployments found — register an Aria instance under Settings.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No deployments match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="instance_name" label="Instance" ctl={ctl} />
                <SortTh k="name" label="Name" ctl={ctl} />
                <SortTh k="project_name" label="Project" ctl={ctl} />
                <SortTh k="status" label="Status" ctl={ctl} />
                <SortTh k="resource_count" label="Resources" ctl={ctl} align="right" />
                <SortTh k="lease_days_left" label="Lease" ctl={ctl} align="right" />
                <SortTh k="created_by" label="Created By" ctl={ctl} />
                <SortTh k="created_at_src" label="Created" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((d) => (
                  <tr key={`${d.instance_id}|${d.deployment_id}`} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{d.instance_name}</td>
                    <td className="py-2 pr-3 text-ink">{d.name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{d.project_name || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={statusTone(d.status)}>{d.status || '—'}</Badge></td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(d.resource_count)}</td>
                    <td className="py-2 pr-3 text-right">
                      {d.lease_days_left == null ? <span className="text-ink-faint">—</span> : (
                        <Badge tone={leaseTone(d.lease_days_left)}>
                          {d.lease_days_left < 0 ? `expired ${Math.abs(d.lease_days_left)}d` : `${d.lease_days_left}d left`}
                        </Badge>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{d.created_by || '—'}</td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">{fmtWhen(d.created_at_src)}</td>
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
