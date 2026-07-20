import { useEffect, useState, useCallback } from 'react';
import { Layers } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls } from '../../components/ui/tableTools';
import { BRAND, fmtBytes, fmtNum, statusTone } from './helpers';

export default function NetAppVolumesPage() {
  const { toast } = useToast();
  const [volumes, setVolumes] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/netapp/volumes')
    .then(({ data }) => { setVolumes(data); setLastRefreshed(new Date()); })
    .catch(() => { setVolumes([]); toast({ type: 'error', title: 'Failed to load volumes' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const ctl = useTableControls(volumes, {
    searchKeys: ['name', 'svm_name', 'array_name', 'aggregate_name'],
    defaultSortKey: 'name',
  });

  const totals = (volumes || []).reduce((a, v) => { a.size += v.size_bytes || 0; a.used += v.used_bytes || 0; return a; }, { size: 0, used: 0 });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Layers} title="NetApp Volumes" description="FlexVols across all ONTAP clusters">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid grid-cols-3 gap-3 mb-4">
        <StatCard icon={Layers} label="Volumes" value={fmtNum((volumes || []).length)} tone="brand" />
        <StatCard icon={Layers} label="Provisioned" value={fmtBytes(totals.size)} />
        <StatCard icon={Layers} label="Used" value={fmtBytes(totals.used)} />
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={volumes} searchPlaceholder="Filter by volume, SVM, cluster or aggregate…"
          filters={[{ k: 'array_name', label: 'Clusters' }, { k: 'svm_name', label: 'SVMs' }, { k: 'state', label: 'States' }]} />
        {volumes == null ? (
          <LoadingPanel label="Loading volumes…" height={160} />
        ) : volumes.length === 0 ? (
          <div className="text-sm text-ink-muted py-8 text-center">No volume data collected yet.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-8 text-center">No volumes match your filters.</div>
        ) : (
          <div className="overflow-x-auto max-h-[62vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface">
                <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <SortTh k="name" label="Volume" ctl={ctl} />
                  <SortTh k="svm_name" label="SVM" ctl={ctl} />
                  <SortTh k="array_name" label="Cluster" ctl={ctl} />
                  <SortTh k="aggregate_name" label="Aggregate" ctl={ctl} />
                  <SortTh k="used_bytes" label="Used" ctl={ctl} align="right" />
                  <SortTh k="size_bytes" label="Size" ctl={ctl} align="right" />
                  <SortTh k="used_percent" label="Used %" ctl={ctl} align="right" />
                  <SortTh k="state" label="State" ctl={ctl} />
                </tr>
              </thead>
              <tbody>
                {ctl.rows.map((v) => (
                  <tr key={v.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink truncate max-w-[220px]">{v.name}</td>
                    <td className="py-2 pr-3 text-ink-muted">{v.svm_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{v.array_name}</td>
                    <td className="py-2 pr-3 text-ink-muted">{v.aggregate_name || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(v.used_bytes)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(v.size_bytes)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{v.used_percent != null ? `${Math.round(v.used_percent)}%` : '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={statusTone(v.state)}>{v.state || 'unknown'}</Badge></td>
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
