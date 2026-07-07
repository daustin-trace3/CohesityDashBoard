import { useEffect, useState, useMemo, useCallback } from 'react';
import { Layers, RefreshCw, Search } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, LoadingPanel } from '../../components/ui/primitives';
import { BRAND, fmtBytes, fmtNum, fmtRatio } from './helpers';

export default function PureVolumesPage() {
  const { toast } = useToast();
  const [volumes, setVolumes] = useState(null);
  const [q, setQ] = useState('');

  const load = useCallback(() => {
    return client
      .get('/pure/volumes')
      .then(({ data }) => setVolumes(data))
      .catch(() => {
        setVolumes([]);
        toast({ type: 'error', title: 'Failed to load volumes' });
      });
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (!volumes) return [];
    const term = q.trim().toLowerCase();
    if (!term) return volumes;
    return volumes.filter(
      (v) => v.name?.toLowerCase().includes(term) || v.array_name?.toLowerCase().includes(term)
    );
  }, [volumes, q]);

  const totals = (volumes || []).reduce(
    (acc, v) => {
      acc.provisioned += v.provisioned_bytes || 0;
      acc.used += v.used_bytes || 0;
      return acc;
    },
    { provisioned: 0, used: 0 }
  );

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Layers} title="Pure Volumes" description="Volumes across all FlashArrays">
        <button
          onClick={load}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors"
        >
          <RefreshCw size={15} /> Refresh
        </button>
      </PageHeader>

      <div className="grid grid-cols-3 gap-3 mb-4">
        <StatCard icon={Layers} label="Volumes" value={fmtNum((volumes || []).length)} tone="brand" />
        <StatCard icon={Layers} label="Provisioned" value={fmtBytes(totals.provisioned)} />
        <StatCard icon={Layers} label="Used" value={fmtBytes(totals.used)} />
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="relative mb-3 max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by volume or array…"
            className="w-full bg-cohesity-black border border-cohesity-border rounded pl-9 pr-3 py-2 text-sm text-cohesity-text focus:outline-none focus:border-cohesity-green"
          />
        </div>

        {volumes == null ? (
          <LoadingPanel label="Loading volumes…" height={160} />
        ) : filtered.length === 0 ? (
          <div className="text-sm text-ink-muted py-8 text-center">
            {volumes.length === 0 ? 'No volumes collected yet.' : 'No volumes match your filter.'}
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface">
                <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <th className="py-2 pr-3">Volume</th>
                  <th className="py-2 pr-3">Array</th>
                  <th className="py-2 pr-3 text-right">Provisioned</th>
                  <th className="py-2 pr-3 text-right">Used</th>
                  <th className="py-2 pr-3 text-right">Snapshots</th>
                  <th className="py-2 pr-3 text-right">DRR</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((v) => (
                  <tr key={v.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink truncate max-w-[260px]">{v.name}</td>
                    <td className="py-2 pr-3 text-ink-muted">{v.array_name}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(v.provisioned_bytes)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(v.used_bytes)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(v.snapshots_bytes)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtRatio(v.data_reduction)}</td>
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
