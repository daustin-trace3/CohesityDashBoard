import { useEffect, useState, useCallback } from 'react';
import { Layers, Download } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
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
    paginate: true,
  });

  const totals = (volumes || []).reduce((a, v) => { a.size += v.size_bytes || 0; a.used += v.used_bytes || 0; return a; }, { size: 0, used: 0 });

  // CSV of the ENTIRE volume list (all rows, not just the current page/filter).
  const exportCsv = () => {
    const esc = (v) => {
      const t = v == null ? '' : String(v);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const header = ['Volume', 'SVM', 'Cluster', 'Aggregate', 'Used Bytes', 'Size Bytes', 'Used %', 'State'];
    const lines = [header.join(',')];
    for (const v of volumes || []) {
      lines.push([v.name, v.svm_name, v.array_name, v.aggregate_name,
        v.used_bytes ?? '', v.size_bytes ?? '',
        v.used_percent != null ? Math.round(v.used_percent) : '', v.state].map(esc).join(','));
    }
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `netapp-volumes-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Layers} title="NetApp Volumes" description="FlexVols across all ONTAP clusters">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <button onClick={exportCsv} disabled={!(volumes || []).length}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50">
          <Download size={13} /> Export
        </button>
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
          <div className="overflow-x-auto">
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
                {ctl.pageRows.map((v) => (
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
        <TablePager ctl={ctl} />
      </div>
    </div>
  );
}
