import { useEffect, useState, useCallback } from 'react';
import { Database, RefreshCw, HardDrive, Layers } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, LoadingPanel } from '../../components/ui/primitives';
import { BRAND, fmtBytes, fmtRatio, usedPct } from './helpers';

export default function PureCapacityPage() {
  const { toast } = useToast();
  const [arrays, setArrays] = useState(null);

  const load = useCallback(() => {
    return client
      .get('/pure/overview')
      .then(({ data }) => setArrays(data))
      .catch(() => {
        setArrays([]);
        toast({ type: 'error', title: 'Failed to load capacity data' });
      });
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const withMetrics = (arrays || []).filter((a) => a.latest);
  const totals = withMetrics.reduce(
    (acc, a) => {
      acc.capacity += a.latest.capacity_bytes || 0;
      acc.used += a.latest.used_bytes || 0;
      acc.snapshots += a.latest.snapshots_bytes || 0;
      return acc;
    },
    { capacity: 0, used: 0, snapshots: 0 }
  );
  const totalPct = totals.capacity ? Math.round((totals.used / totals.capacity) * 100) : 0;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Database} title="Pure Capacity" description="Capacity and data reduction across all FlashArrays">
        <button
          onClick={load}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors"
        >
          <RefreshCw size={15} /> Refresh
        </button>
      </PageHeader>

      {arrays == null ? (
        <LoadingPanel label="Loading capacity…" />
      ) : withMetrics.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-ink-muted" style={{ borderTop: `3px solid ${BRAND}` }}>
          No capacity data collected yet. Add an array on the Overview page and poll it.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <StatCard icon={Database} label="Total Capacity" value={fmtBytes(totals.capacity)} tone="brand" />
            <StatCard icon={Database} label="Total Used" value={fmtBytes(totals.used)} sub={`${totalPct}% full`} />
            <StatCard icon={Layers} label="Snapshots" value={fmtBytes(totals.snapshots)} />
            <StatCard icon={HardDrive} label="Arrays" value={withMetrics.length} />
          </div>

          <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                    <th className="py-2 pr-3">Array</th>
                    <th className="py-2 pr-3 w-[220px]">Utilization</th>
                    <th className="py-2 pr-3 text-right">Used</th>
                    <th className="py-2 pr-3 text-right">Capacity</th>
                    <th className="py-2 pr-3 text-right">Data Reduction</th>
                    <th className="py-2 pr-3 text-right">Snapshots</th>
                  </tr>
                </thead>
                <tbody>
                  {withMetrics.map((a) => {
                    const pct = usedPct(a.latest);
                    const barColor = pct >= 90 ? '#f87171' : pct >= 75 ? '#fbbf24' : BRAND;
                    return (
                      <tr key={a.id} className="border-b border-cohesity-border/50">
                        <td className="py-2 pr-3 text-ink font-medium">{a.name}</td>
                        <td className="py-2 pr-3">
                          <div className="flex items-center gap-2">
                            <div className="h-2 flex-1 rounded-full bg-surface-overlay overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: barColor }} />
                            </div>
                            <span className="text-[11px] tnum text-ink-muted w-9 text-right">{pct}%</span>
                          </div>
                        </td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(a.latest.used_bytes)}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(a.latest.capacity_bytes)}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtRatio(a.latest.data_reduction)}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(a.latest.snapshots_bytes)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
