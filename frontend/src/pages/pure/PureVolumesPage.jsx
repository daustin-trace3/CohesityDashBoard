import { useEffect, useState, useCallback, useMemo } from 'react';
import { Layers, Activity, Timer, Gauge } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import TrendChart from '../../components/TrendChart';
import { BRAND, fmtBytes, fmtNum, fmtDateMs } from './helpers';
import { usePure1Arrays, ArraySelect } from './usePure1Arrays';

const fmtIops = (v) => (v == null ? '—' : `${Math.round(v).toLocaleString()}`);
const fmtMs = (us) => (us == null ? '—' : `${(us / 1000).toFixed(2)} ms`);

export default function PureVolumesPage() {
  const { toast } = useToast();
  const { arrays, arrayId, setArrayId } = usePure1Arrays();
  const [days, setDays] = useState(1);
  const [vols, setVols] = useState(null);
  const [perf, setPerf] = useState(null);
  const [loading, setLoading] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => {
    if (!arrayId) return undefined;
    setLoading(true);
    return Promise.allSettled([
      client.get(`/pure1/volumes?arrayId=${arrayId}`),
      client.get(`/pure1/performance/history?arrayId=${arrayId}&days=${days}`),
    ]).then(([v, p]) => {
      setVols(v.status === 'fulfilled' ? v.value.data : []);
      setPerf(p.status === 'fulfilled' ? p.value.data : { series: {} });
      if (v.status === 'rejected') toast({ type: 'error', title: 'Failed to load volumes' });
      else setLastRefreshed(new Date());
    }).finally(() => setLoading(false));
  }, [arrayId, days, toast]);

  useEffect(() => { load(); }, [load]);

  const totalProvisioned = useMemo(() => (vols || []).reduce((s, v) => s + (v.provisioned || 0), 0), [vols]);
  const list = vols || [];
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'pod', 'source'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });

  const s = (perf && perf.series) || {};
  const labels = useMemo(() => (s.array_read_iops || []).map(([ts]) =>
    days <= 1 ? new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })), [s, days]);
  const col = (name) => (s[name] || []).map(([, v]) => v);

  const perfLast = (name) => { const a = s[name] || []; return a.length ? a[a.length - 1][1] : null; };

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Layers} title="Pure Volumes" description="Volumes and live array performance from Pure Storage">
        <div className="flex items-center gap-2">
          <ArraySelect arrays={arrays} value={arrayId} onChange={setArrayId} />
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}
            className="bg-surface border border-cohesity-border text-[13px] text-ink rounded-lg px-3 py-1.5 focus:border-brand/60">
            <option value={1}>24 hours</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
          </select>
          <LastUpdated date={lastRefreshed} prefix="Updated" />
          <RefreshButton onClick={load} refreshing={loading} />
        </div>
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Layers} label="Volumes" value={fmtNum((vols || []).length)} tone="brand" />
        <StatCard icon={Gauge} label="Provisioned" value={fmtBytes(totalProvisioned)} />
        <StatCard icon={Activity} label="IOPS (r/w)" value={`${fmtIops(perfLast('array_read_iops'))} / ${fmtIops(perfLast('array_write_iops'))}`} />
        <StatCard icon={Timer} label="Latency (r/w)" value={`${fmtMs(perfLast('array_read_latency_us'))} / ${fmtMs(perfLast('array_write_latency_us'))}`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-4">
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-3">IOPS</p>
          {perf == null || loading ? <LoadingPanel label="Loading…" height={180} /> : (
            <TrendChart labels={labels} height={180} format={fmtIops}
              datasets={[
                { label: 'Read', data: col('array_read_iops'), color: BRAND },
                { label: 'Write', data: col('array_write_iops'), color: '#0EA5E9' },
              ]} />
          )}
        </div>
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-3">Latency</p>
          {perf == null || loading ? <LoadingPanel label="Loading…" height={180} /> : (
            <TrendChart labels={labels} height={180} format={(v) => `${(v / 1000).toFixed(2)} ms`}
              datasets={[
                { label: 'Read', data: col('array_read_latency_us'), color: '#8B5CF6' },
                { label: 'Write', data: col('array_write_latency_us'), color: '#F59E0B' },
              ]} />
          )}
        </div>
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-3">Bandwidth</p>
          {perf == null || loading ? <LoadingPanel label="Loading…" height={180} /> : (
            <TrendChart labels={labels} height={180} format={(v) => `${fmtBytes(v)}/s`}
              datasets={[
                { label: 'Read', data: col('array_read_bandwidth'), color: '#22C55E' },
                { label: 'Write', data: col('array_write_bandwidth'), color: '#EF4444' },
              ]} />
          )}
        </div>
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Volumes</p>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by name, pod or source…"
          filters={[{ k: 'pod', label: 'Pods' }]} />
        {vols == null ? (
          <LoadingPanel label="Loading volumes…" height={160} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-8 text-center">No volumes on this array.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-8 text-center">No volumes match your filters.</div>
        ) : (
          <div className="overflow-x-auto max-h-[55vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Volume" ctl={ctl} />
                <SortTh k="provisioned" label="Provisioned" ctl={ctl} align="right" />
                <SortTh k="pod" label="Pod" ctl={ctl} />
                <SortTh k="source" label="Source" ctl={ctl} />
                <SortTh k="created" label="Created" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((v) => (
                  <tr key={v.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink font-medium">{v.name}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(v.provisioned)}</td>
                    <td className="py-2 pr-3">{v.pod ? <Badge tone="info">{v.pod}</Badge> : <span className="text-ink-faint">—</span>}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[12px]">{v.source || '—'}</td>
                    <td className="py-2 pr-3 text-ink-faint text-[12px]">{fmtDateMs(v.created)}</td>
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
