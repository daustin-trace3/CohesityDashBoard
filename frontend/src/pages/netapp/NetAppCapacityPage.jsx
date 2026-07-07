import { useEffect, useState, useCallback } from 'react';
import { Database, RefreshCw, HardDrive } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel } from '../../components/ui/primitives';
import { BRAND, fmtBytes, fmtRatio, statusTone } from './helpers';

export default function NetAppCapacityPage() {
  const { toast } = useToast();
  const [aggs, setAggs] = useState(null);

  const load = useCallback(() => client.get('/netapp/aggregates')
    .then(({ data }) => setAggs(data))
    .catch(() => { setAggs([]); toast({ type: 'error', title: 'Failed to load aggregates' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const totals = (aggs || []).reduce((a, g) => {
    a.size += g.size_bytes || 0; a.used += g.used_bytes || 0; a.physical += g.physical_used_bytes || 0; return a;
  }, { size: 0, used: 0, physical: 0 });
  const pct = totals.size ? Math.round((totals.used / totals.size) * 100) : 0;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Database} title="NetApp Capacity" description="Aggregate capacity and efficiency across all ONTAP clusters">
        <button onClick={load} className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors">
          <RefreshCw size={15} /> Refresh
        </button>
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Database} label="Total Capacity" value={fmtBytes(totals.size)} tone="brand" />
        <StatCard icon={Database} label="Used" value={fmtBytes(totals.used)} sub={`${pct}% full`} />
        <StatCard icon={Database} label="Physical Used" value={fmtBytes(totals.physical)} />
        <StatCard icon={HardDrive} label="Aggregates" value={(aggs || []).length} />
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        {aggs == null ? (
          <LoadingPanel label="Loading aggregates…" />
        ) : aggs.length === 0 ? (
          <div className="text-sm text-ink-muted py-8 text-center">No aggregate data collected yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <th className="py-2 pr-3">Aggregate</th><th className="py-2 pr-3">Cluster</th><th className="py-2 pr-3">Node</th>
                  <th className="py-2 pr-3 w-[200px]">Utilization</th>
                  <th className="py-2 pr-3 text-right">Used</th><th className="py-2 pr-3 text-right">Size</th>
                  <th className="py-2 pr-3 text-right">Physical</th><th className="py-2 pr-3 text-right">Efficiency</th><th className="py-2 pr-3">State</th>
                </tr>
              </thead>
              <tbody>
                {aggs.map((g) => {
                  const p = g.used_percent != null ? Math.round(g.used_percent) : (g.size_bytes ? Math.round((g.used_bytes / g.size_bytes) * 100) : 0);
                  const color = p >= 90 ? '#f87171' : p >= 75 ? '#fbbf24' : BRAND;
                  return (
                    <tr key={g.id} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3 text-ink font-medium">{g.name}</td>
                      <td className="py-2 pr-3 text-ink-muted">{g.array_name}</td>
                      <td className="py-2 pr-3 text-ink-muted">{g.node_name || '—'}</td>
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-2">
                          <div className="h-2 flex-1 rounded-full bg-surface-overlay overflow-hidden"><div className="h-full rounded-full" style={{ width: `${p}%`, backgroundColor: color }} /></div>
                          <span className="text-[11px] tnum text-ink-muted w-9 text-right">{p}%</span>
                        </div>
                      </td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(g.used_bytes)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(g.size_bytes)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(g.physical_used_bytes)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtRatio(g.efficiency_ratio)}</td>
                      <td className="py-2 pr-3"><Badge tone={statusTone(g.state)}>{g.state || 'unknown'}</Badge></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
