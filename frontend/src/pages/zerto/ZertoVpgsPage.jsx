import { useEffect, useState, useCallback } from 'react';
import { ShieldCheck } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum, fmtRpo, healthTone } from './helpers';

export default function ZertoVpgsPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/zerto/vpgs')
    .then(({ data }) => { setRows(data); setLastRefreshed(new Date()); })
    .catch(() => { setRows([]); toast({ type: 'error', title: 'Failed to load VPGs' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'protected_site', 'recovery_site', 'zorg_name', 'status'],
    defaultSortKey: 'actual_rpo', defaultSortDir: 'desc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={ShieldCheck} title="Zerto VPGs" description="Virtual Protection Groups with RPO, health and journal state">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by VPG, site, ZORG or status…"
          filters={[{ k: 'protected_site', label: 'Protected sites' }, { k: 'recovery_site', label: 'Recovery sites' }, { k: 'health', label: 'Health' }, { k: 'status', label: 'Statuses' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading VPGs…" height={140} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No VPGs found — check the Zerto credentials under Settings.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No VPGs match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="VPG" ctl={ctl} />
                <SortTh k="protected_site" label="Protected Site" ctl={ctl} />
                <SortTh k="recovery_site" label="Recovery Site" ctl={ctl} />
                <SortTh k="vms_count" label="VMs" ctl={ctl} align="right" />
                <SortTh k="health" label="Health" ctl={ctl} />
                <SortTh k="status" label="Status" ctl={ctl} />
                <SortTh k="actual_rpo" label="Actual RPO" ctl={ctl} align="right" />
                <SortTh k="configured_rpo" label="SLA RPO" ctl={ctl} align="right" />
                <SortTh k="actual_journal_history" label="Journal" ctl={ctl} align="right" />
                <SortTh k="zorg_name" label="ZORG" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((v) => (
                  <tr key={v.vpg_identifier} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{v.name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{v.protected_site || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{v.recovery_site || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(v.vms_count)}</td>
                    <td className="py-2 pr-3"><Badge tone={healthTone(v.health)}>{v.health || '—'}</Badge></td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{v.status || '—'}{v.sub_status && v.sub_status !== 'None' ? ` · ${v.sub_status}` : ''}</td>
                    <td className={`py-2 pr-3 text-right tnum ${v.configured_rpo && v.actual_rpo > v.configured_rpo ? 'text-status-crit font-semibold' : 'text-ink'}`}>{fmtRpo(v.actual_rpo)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-faint">{fmtRpo(v.configured_rpo)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{v.actual_journal_history != null ? `${v.actual_journal_history}h` : '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{v.zorg_name || '—'}</td>
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
