import { useEffect, useState, useMemo, useCallback } from 'react';
import { Layers, RefreshCw, Search } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, LoadingPanel } from '../../components/ui/primitives';
import { BRAND, fmtBytes, fmtNum, fmtRatio, fmtIops, fmtLatency } from './helpers';

const SORTS = [
  { key: 'used', label: 'Used' },
  { key: 'iops', label: 'IOPS' },
  { key: 'provisioned', label: 'Provisioned' },
];

export default function PureVolumesPage() {
  const { toast } = useToast();
  const [volumes, setVolumes] = useState(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('used');

  const load = useCallback(() => {
    return client
      .get('/pure/volumes/performance')
      .then(({ data }) => setVolumes(data))
      .catch(() => {
        setVolumes([]);
        toast({ type: 'error', title: 'Failed to load volumes' });
      });
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    let list = volumes || [];
    const term = q.trim().toLowerCase();
    if (term) {
      list = list.filter(
        (v) => v.volume_name?.toLowerCase().includes(term) || v.array_name?.toLowerCase().includes(term)
      );
    }
    const iops = (v) => (v.read_iops || 0) + (v.write_iops || 0);
    const cmp = {
      used: (a, b) => (b.used_bytes || 0) - (a.used_bytes || 0),
      iops: (a, b) => iops(b) - iops(a),
      provisioned: (a, b) => (b.provisioned_bytes || 0) - (a.provisioned_bytes || 0),
    }[sort];
    return [...list].sort(cmp);
  }, [volumes, q, sort]);

  const totals = (volumes || []).reduce(
    (acc, v) => {
      acc.provisioned += v.provisioned_bytes || 0;
      acc.used += v.used_bytes || 0;
      acc.iops += (v.read_iops || 0) + (v.write_iops || 0);
      return acc;
    },
    { provisioned: 0, used: 0, iops: 0 }
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
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div className="relative max-w-xs w-full">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter by volume or array…"
              className="w-full bg-cohesity-black border border-cohesity-border rounded pl-9 pr-3 py-2 text-sm text-cohesity-text focus:outline-none focus:border-cohesity-green"
            />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[11px] text-ink-faint mr-1">Sort</span>
            {SORTS.map((s) => (
              <button
                key={s.key}
                onClick={() => setSort(s.key)}
                className={`text-xs px-2.5 py-1.5 rounded border transition-colors ${
                  sort === s.key ? 'text-white border-transparent' : 'border-cohesity-border text-ink-muted hover:text-ink'
                }`}
                style={sort === s.key ? { backgroundColor: BRAND } : undefined}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {volumes == null ? (
          <LoadingPanel label="Loading volumes…" height={160} />
        ) : filtered.length === 0 ? (
          <div className="text-sm text-ink-muted py-8 text-center">
            {(volumes || []).length === 0 ? 'No volume data collected yet.' : 'No volumes match your filter.'}
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
                  <th className="py-2 pr-3 text-right">DRR</th>
                  <th className="py-2 pr-3 text-right">Read IOPS</th>
                  <th className="py-2 pr-3 text-right">Write IOPS</th>
                  <th className="py-2 pr-3 text-right">R Lat</th>
                  <th className="py-2 pr-3 text-right">W Lat</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((v) => (
                  <tr key={`${v.array_id}-${v.volume_name}`} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink truncate max-w-[240px]">{v.volume_name}</td>
                    <td className="py-2 pr-3 text-ink-muted">{v.array_name}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(v.provisioned_bytes)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(v.used_bytes)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtRatio(v.data_reduction)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtIops(v.read_iops)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtIops(v.write_iops)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtLatency(v.read_latency_us)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtLatency(v.write_latency_us)}</td>
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
