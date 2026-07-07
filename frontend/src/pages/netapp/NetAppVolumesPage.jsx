import { useEffect, useState, useMemo, useCallback } from 'react';
import { Layers, RefreshCw, Search } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel } from '../../components/ui/primitives';
import { BRAND, fmtBytes, fmtNum, statusTone } from './helpers';

export default function NetAppVolumesPage() {
  const { toast } = useToast();
  const [volumes, setVolumes] = useState(null);
  const [q, setQ] = useState('');

  const load = useCallback(() => client.get('/netapp/volumes')
    .then(({ data }) => setVolumes(data))
    .catch(() => { setVolumes([]); toast({ type: 'error', title: 'Failed to load volumes' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const list = volumes || [];
    const term = q.trim().toLowerCase();
    if (!term) return list;
    return list.filter((v) => v.name?.toLowerCase().includes(term) || v.svm_name?.toLowerCase().includes(term) || v.array_name?.toLowerCase().includes(term));
  }, [volumes, q]);

  const totals = (volumes || []).reduce((a, v) => { a.size += v.size_bytes || 0; a.used += v.used_bytes || 0; return a; }, { size: 0, used: 0 });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Layers} title="NetApp Volumes" description="FlexVols across all ONTAP clusters">
        <button onClick={load} className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors">
          <RefreshCw size={15} /> Refresh
        </button>
      </PageHeader>

      <div className="grid grid-cols-3 gap-3 mb-4">
        <StatCard icon={Layers} label="Volumes" value={fmtNum((volumes || []).length)} tone="brand" />
        <StatCard icon={Layers} label="Provisioned" value={fmtBytes(totals.size)} />
        <StatCard icon={Layers} label="Used" value={fmtBytes(totals.used)} />
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="relative mb-3 max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by volume, SVM or cluster…"
            className="w-full bg-surface-overlay border border-cohesity-border rounded-lg pl-9 pr-3 py-2 text-sm text-ink focus:border-brand/60 outline-none" />
        </div>
        {volumes == null ? (
          <LoadingPanel label="Loading volumes…" height={160} />
        ) : filtered.length === 0 ? (
          <div className="text-sm text-ink-muted py-8 text-center">{(volumes || []).length === 0 ? 'No volume data collected yet.' : 'No volumes match your filter.'}</div>
        ) : (
          <div className="overflow-x-auto max-h-[62vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface">
                <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <th className="py-2 pr-3">Volume</th><th className="py-2 pr-3">SVM</th><th className="py-2 pr-3">Cluster</th><th className="py-2 pr-3">Aggregate</th>
                  <th className="py-2 pr-3 text-right">Used</th><th className="py-2 pr-3 text-right">Size</th><th className="py-2 pr-3 text-right">Used %</th><th className="py-2 pr-3">State</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((v) => (
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
