import { useEffect, useState, useCallback, useMemo } from 'react';
import { ArrowLeftRight, RefreshCw, Search, Boxes, Layers } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel } from '../../components/ui/primitives';
import { BRAND, fmtNum } from './helpers';

function statusTone(s) {
  const v = String(s || '').toLowerCase();
  if (v === 'online') return 'ok';
  if (v === 'unknown' || v === 'unhealthy' || v === 'offline') return 'crit';
  return 'neutral';
}

export default function PureReplicationPage() {
  const { toast } = useToast();
  const [pods, setPods] = useState(null);
  const [q, setQ] = useState('');
  const [stretchedOnly, setStretchedOnly] = useState(true);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    return client.get('/pure1/pods')
      .then(({ data }) => setPods(data || []))
      .catch(() => { setPods([]); toast({ type: 'error', title: 'Failed to load pods' }); })
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const stretched = useMemo(() => (pods || []).filter((p) => p.arrays.length > 1), [pods]);
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    let list = stretchedOnly ? stretched : (pods || []);
    if (n) list = list.filter((p) => p.name.toLowerCase().includes(n) || p.arrays.some((a) => String(a.name).toLowerCase().includes(n)));
    return [...list].sort((a, b) => b.arrays.length - a.arrays.length || a.name.localeCompare(b.name));
  }, [pods, stretched, stretchedOnly, q]);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={ArrowLeftRight} title="Pure Replication" description="ActiveCluster pods and replication topology from Pure Storage">
        <button onClick={load} disabled={loading}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
        <StatCard icon={Boxes} label="Total Pods" value={fmtNum((pods || []).length)} tone="brand" />
        <StatCard icon={Layers} label="Stretched (multi-array)" value={fmtNum(stretched.length)} />
        <StatCard icon={ArrowLeftRight} label="Replicating Arrays" value={fmtNum(new Set(stretched.flatMap((p) => p.arrays.map((a) => a.id))).size)} />
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <p className="text-sm font-semibold text-ink">Pods {pods ? `(${filtered.length})` : ''}</p>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-[12px] text-ink-muted cursor-pointer select-none">
              <input type="checkbox" checked={stretchedOnly} onChange={(e) => setStretchedOnly(e.target.checked)} className="accent-brand" />
              Stretched only
            </label>
            <div className="relative w-56 max-w-full">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by pod or array…"
                className="w-full bg-surface border border-cohesity-border text-[13px] text-ink rounded-lg pl-9 pr-3 py-1.5 placeholder-ink-faint focus:border-brand/60" />
            </div>
          </div>
        </div>
        {pods == null ? (
          <LoadingPanel label="Loading pods…" height={160} />
        ) : filtered.length === 0 ? (
          <div className="text-sm text-ink-muted py-8 text-center">No pods match.</div>
        ) : (
          <div className="overflow-x-auto max-h-[62vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Pod</th><th className="py-2 pr-3">Mediator</th><th className="py-2 pr-3">Member Arrays</th>
              </tr></thead>
              <tbody>
                {filtered.map((p) => (
                  <tr key={p.id} className="border-b border-cohesity-border/50 align-top">
                    <td className="py-2 pr-3 text-ink font-medium">{p.name}</td>
                    <td className="py-2 pr-3 text-ink-muted">{p.mediator || '—'}</td>
                    <td className="py-2 pr-3">
                      <div className="flex flex-wrap gap-1.5">
                        {p.arrays.map((a) => (
                          <span key={a.id} className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-cohesity-border bg-surface text-[12px]">
                            <span className="text-ink">{a.name}</span>
                            {a.status && <Badge tone={statusTone(a.status)}>{a.status}</Badge>}
                          </span>
                        ))}
                      </div>
                    </td>
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
