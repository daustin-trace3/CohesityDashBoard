import { useEffect, useState, useCallback } from 'react';
import { ShieldCheck } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager, CsvExportButton } from '../../components/ui/tableTools';
import { BRAND, fmtNum } from './helpers';

export default function NbPoliciesPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/netbackup/policies')
    .then(({ data }) => { setRows(data.policies || []); setLastRefreshed(new Date()); })
    .catch(() => { setRows([]); toast({ type: 'error', title: 'Failed to load policies' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'sourceName'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={ShieldCheck} title="Policies" description="Backup policies across all registered NetBackup sources">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center justify-between gap-2 mb-3">
          <p className="text-sm font-semibold text-ink">Policies</p>
          <CsvExportButton filename="netbackup-policies" rows={ctl.rows} columns={[
            { label: 'Name', get: 'name' },
            { label: 'Source', get: 'sourceName' },
            { label: 'Type', get: 'policyType' },
            { label: 'Active', get: (r) => (r.active ? 'Yes' : 'No') },
            { label: 'Clients', get: 'clientCount' },
            { label: 'Schedules', get: 'scheduleCount' },
            { label: 'Selections', get: 'selectionCount' },
            { label: 'Failed (24h)', get: 'failed24h' },
          ]} />
        </div>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by policy or source…"
          filters={[{ k: 'policyType', label: 'Types' }, { k: 'sourceName', label: 'Sources' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading policies…" height={140} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No policies found — register a NetBackup source under Settings.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No policies match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Name" ctl={ctl} />
                <SortTh k="policyType" label="Type" ctl={ctl} />
                <SortTh k="active" label="Active" ctl={ctl} />
                <SortTh k="sourceName" label="Source" ctl={ctl} />
                <SortTh k="clientCount" label="Clients" ctl={ctl} align="right" />
                <SortTh k="scheduleCount" label="Schedules" ctl={ctl} align="right" />
                <SortTh k="selectionCount" label="Selections" ctl={ctl} align="right" />
                <SortTh k="failed24h" label="Failed (24h)" ctl={ctl} align="right" />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((p) => (
                  <tr key={p.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{p.name}</td>
                    <td className="py-2 pr-3 text-ink-muted">{p.policyType || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={p.active ? 'ok' : 'neutral'}>{p.active ? 'Active' : 'Inactive'}</Badge></td>
                    <td className="py-2 pr-3 text-ink-muted">{p.sourceName}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(p.clientCount)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(p.scheduleCount)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(p.selectionCount)}</td>
                    <td className="py-2 pr-3 text-right">
                      {p.failed24h ? <Badge tone="crit">{p.failed24h}</Badge> : <span className="text-ink-faint tnum">0</span>}
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
