import { useEffect, useState, useCallback, useMemo } from 'react';
import { Database, RefreshCw, HardDrive, Gauge } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, LoadingPanel } from '../../components/ui/primitives';
import TrendChart from '../../components/TrendChart';
import { BRAND, fmtBytes, fmtRatio } from './helpers';
import { usePure1Arrays, ArraySelect } from './usePure1Arrays';

const USED_PARTS = ['array_volume_space', 'array_shared_space', 'array_snapshot_space', 'array_system_space', 'array_replication_space'];

export default function PureCapacityPage() {
  const { toast } = useToast();
  const { arrays, arrayId, setArrayId } = usePure1Arrays();
  const [days, setDays] = useState(30);
  const [hist, setHist] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!arrayId) return undefined;
    setLoading(true);
    return client.get(`/pure1/capacity/history?arrayId=${arrayId}&days=${days}`)
      .then(({ data }) => setHist(data))
      .catch(() => { setHist({ series: {} }); toast({ type: 'error', title: 'Failed to load capacity history' }); })
      .finally(() => setLoading(false));
  }, [arrayId, days, toast]);

  useEffect(() => { load(); }, [load]);

  // Merge the daily metric series into aligned rows keyed by timestamp.
  const rows = useMemo(() => {
    const series = (hist && hist.series) || {};
    const totals = series.array_total_capacity || [];
    const byTs = (name) => {
      const m = new Map();
      for (const [ts, v] of (series[name] || [])) m.set(ts, v);
      return m;
    };
    const maps = Object.fromEntries([...USED_PARTS, 'array_data_reduction'].map((n) => [n, byTs(n)]));
    return totals.map(([ts, total]) => {
      const used = USED_PARTS.reduce((s, n) => s + (maps[n].get(ts) || 0), 0);
      return { ts, total, used, dr: maps.array_data_reduction.get(ts) || null };
    });
  }, [hist]);

  const latest = rows[rows.length - 1] || null;
  const labels = useMemo(() => rows.map((r) => new Date(r.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })), [rows]);

  const composition = useMemo(() => {
    const series = (hist && hist.series) || {};
    const lastOf = (n) => { const arr = series[n] || []; return arr.length ? arr[arr.length - 1][1] : 0; };
    return [
      { label: 'Volumes', value: lastOf('array_volume_space'), color: BRAND },
      { label: 'Shared / dedup', value: lastOf('array_shared_space'), color: '#0EA5E9' },
      { label: 'Snapshots', value: lastOf('array_snapshot_space'), color: '#8B5CF6' },
      { label: 'System', value: lastOf('array_system_space'), color: '#64748B' },
      { label: 'Replication', value: lastOf('array_replication_space'), color: '#22C55E' },
    ].filter((c) => c.value > 0);
  }, [hist]);

  const compTotal = composition.reduce((s, c) => s + c.value, 0) || 1;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Database} title="Pure Capacity" description="Capacity, data reduction and growth from Pure Storage">
        <div className="flex items-center gap-2">
          <ArraySelect arrays={arrays} value={arrayId} onChange={setArrayId} />
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}
            className="bg-surface border border-cohesity-border text-[13px] text-ink rounded-lg px-3 py-1.5 focus:border-brand/60">
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
          <button onClick={load} disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50">
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Database} label="Total Capacity" value={fmtBytes(latest?.total)} tone="brand" />
        <StatCard icon={HardDrive} label="Used" value={fmtBytes(latest?.used)}
          sub={latest && latest.total ? `${((latest.used / latest.total) * 100).toFixed(1)}% full` : undefined} />
        <StatCard icon={HardDrive} label="Free" value={fmtBytes(latest ? Math.max(0, latest.total - latest.used) : null)} />
        <StatCard icon={Gauge} label="Data Reduction" value={fmtRatio(latest?.dr)} />
      </div>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Capacity Trend ({days} days)</p>
        {hist == null || loading ? (
          <LoadingPanel label="Loading capacity history…" height={240} />
        ) : rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-10 text-center">No capacity history for this array.</div>
        ) : (
          <TrendChart
            labels={labels}
            unit=""
            height={260}
            format={(v) => fmtBytes(v)}
            datasets={[
              { label: 'Total', data: rows.map((r) => r.total), color: '#64748B' },
              { label: 'Used', data: rows.map((r) => r.used), color: BRAND, fill: true },
            ]}
          />
        )}
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Capacity Composition</p>
        {composition.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No composition data.</div>
        ) : (
          <>
            <div className="flex h-3 rounded-full overflow-hidden mb-3">
              {composition.map((c) => (
                <div key={c.label} style={{ width: `${(c.value / compTotal) * 100}%`, background: c.color }} title={`${c.label}: ${fmtBytes(c.value)}`} />
              ))}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {composition.map((c) => (
                <div key={c.label} className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: c.color }} />
                  <div className="min-w-0">
                    <p className="text-[11px] text-ink-faint truncate">{c.label}</p>
                    <p className="text-sm text-ink tnum">{fmtBytes(c.value)}</p>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
