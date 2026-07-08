import { useEffect, useState, useCallback, useMemo } from 'react';
import { Cloud, RefreshCw, Server, Database, HardDrive, AlertTriangle, Search, ExternalLink, X } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel } from '../../components/ui/primitives';
import TrendChart from '../../components/TrendChart';
import { BRAND, fmtBytes, fmtNum, fmtRatio, timeAgo, severityTone } from './helpers';

const USED_PARTS = ['array_volume_space', 'array_shared_space', 'array_snapshot_space', 'array_system_space', 'array_replication_space'];
const fmtIops = (v) => (v == null ? '—' : `${Math.round(v).toLocaleString()}`);

function pctBarColor(pct, warn = 75, crit = 90) {
  if (pct == null) return '#334155';
  if (pct >= crit) return '#EF4444';
  if (pct >= warn) return '#F59E0B';
  return BRAND;
}

export default function Pure1FleetPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [status, setStatus] = useState(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState({ key: 'pctUsed', dir: -1 });
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState(null);
  const [cap, setCap] = useState(null);
  const [perf, setPerf] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback((force = false) => {
    const suffix = force ? '?refresh=1' : '';
    return Promise.allSettled([
      client.get(`/pure1/overview${suffix}`),
      client.get(`/pure1/alerts${suffix}`),
      client.get('/pure1/status'),
    ]).then(([o, a, s]) => {
      if (o.status === 'fulfilled') setRows(o.value.data); else { setRows([]); toast({ type: 'error', title: 'Failed to load Pure data' }); }
      if (a.status === 'fulfilled') setAlerts(a.value.data || []);
      if (s.status === 'fulfilled') setStatus(s.value.data);
    });
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const hardRefresh = async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
    toast({ type: 'success', title: 'Pure data refreshed' });
  };

  const totals = useMemo(() => {
    const list = rows || [];
    const total = list.reduce((s, r) => s + (r.total || 0), 0);
    const used = list.reduce((s, r) => s + (r.used || 0), 0);
    const drs = list.map((r) => r.dataReduction).filter((v) => v > 0);
    const avgDr = drs.length ? drs.reduce((s, v) => s + v, 0) / drs.length : null;
    return { count: list.length, total, used, avgDr, pct: total > 0 ? (used / total) * 100 : null };
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = (rows || []).filter((r) =>
      !needle || [r.name, r.model, r.version, r.fqdn].some((v) => String(v || '').toLowerCase().includes(needle)));
    const { key, dir } = sort;
    list = [...list].sort((a, b) => {
      const va = a[key], vb = b[key];
      if (typeof va === 'string' || typeof vb === 'string') return String(va || '').localeCompare(String(vb || '')) * dir;
      return ((va || 0) - (vb || 0)) * dir;
    });
    return list;
  }, [rows, q, sort]);

  // Client-side pagination (5 / 10 / 20 / All, default 10).
  useEffect(() => { setPage(0); }, [q, sort, pageSize]);
  const pageCount = pageSize === 'all' ? 1 : Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const pageItems = pageSize === 'all' ? filtered : filtered.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const rangeStart = filtered.length === 0 ? 0 : (pageSize === 'all' ? 1 : safePage * pageSize + 1);
  const rangeEnd = pageSize === 'all' ? filtered.length : Math.min((safePage + 1) * pageSize, filtered.length);

  const openAlerts = useMemo(
    () => alerts.filter((a) => (status && status.showHiddenAlerts) || String(a.severity || '').toLowerCase() !== 'hidden'),
    [alerts, status]);

  // Load capacity + performance history for the selected array's chart panel.
  useEffect(() => {
    if (!selected) { setCap(null); setPerf(null); return undefined; }
    let cancelled = false;
    setDetailLoading(true);
    Promise.allSettled([
      client.get(`/pure1/capacity/history?arrayId=${selected.id}&days=30`),
      client.get(`/pure1/performance/history?arrayId=${selected.id}&days=1`),
    ]).then(([c, p]) => {
      if (cancelled) return;
      setCap(c.status === 'fulfilled' ? c.value.data : { series: {} });
      setPerf(p.status === 'fulfilled' ? p.value.data : { series: {} });
    }).finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selected]);

  const capRows = useMemo(() => {
    const series = (cap && cap.series) || {};
    const totals = series.array_total_capacity || [];
    const byTs = (name) => { const m = new Map(); for (const [ts, v] of (series[name] || [])) m.set(ts, v); return m; };
    const maps = Object.fromEntries(USED_PARTS.map((n) => [n, byTs(n)]));
    return totals.map(([ts, total]) => ({ ts, total, used: USED_PARTS.reduce((s, n) => s + (maps[n].get(ts) || 0), 0) }));
  }, [cap]);
  const capLabels = useMemo(() => capRows.map((r) => new Date(r.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })), [capRows]);

  const ps = (perf && perf.series) || {};
  const perfLabels = useMemo(() => (ps.array_read_iops || []).map(([ts]) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })), [perf]);
  const pcol = (name) => (ps[name] || []).map(([, v]) => v);

  const setSortKey = (key) => setSort((s) => ({ key, dir: s.key === key ? -s.dir : 1 }));
  const Th = ({ k, children, right }) => (
    <th className={`py-2 pr-3 ${right ? 'text-right' : 'text-left'} cursor-pointer select-none hover:text-ink`} onClick={() => setSortKey(k)}>
      {children}{sort.key === k ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
    </th>
  );

  if (status && status.configured === false) {
    return (
      <div className="animate-fade-in">
        <PageHeader icon={Cloud} title="Pure Overview" description="Live view of every Pure array" />
        <div className="panel p-8 text-center text-ink-muted">
          <Cloud size={28} className="mx-auto mb-3 text-ink-faint" />
          <p className="text-sm">Pure is not configured.</p>
          <p className="text-[12px] text-ink-faint mt-1">Set <code>PURE1_APIKEY</code> in the environment and provide the registered private key.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Cloud} title="Pure Overview" description="Live view of every Pure array">
        <button onClick={hardRefresh} disabled={refreshing}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50">
          <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} /> {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <StatCard icon={Server} label="Arrays" value={fmtNum(totals.count)} tone="brand" />
        <StatCard icon={Database} label="Total Capacity" value={fmtBytes(totals.total)} />
        <StatCard icon={HardDrive} label="Total Used" value={fmtBytes(totals.used)} sub={totals.pct != null ? `${totals.pct.toFixed(1)}% used` : undefined} />
        <StatCard icon={Database} label="Avg Data Reduction" value={fmtRatio(totals.avgDr)} />
        <StatCard icon={AlertTriangle} label="Open Alerts" value={fmtNum(openAlerts.length)} tone={openAlerts.length > 0 ? 'warn' : 'ok'} />
      </div>

      {/* Open alerts — front and center for ops */}
      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Open Alerts {rows ? `(${openAlerts.length})` : ''}</p>
        {rows == null ? (
          <LoadingPanel label="Loading alerts…" height={120} />
        ) : openAlerts.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No open alerts across your Pure arrays.</div>
        ) : (
          <div className="overflow-x-auto max-h-[45vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Severity</th><th className="py-2 pr-3">Array</th><th className="py-2 pr-3">Summary</th><th className="py-2 pr-3">Component</th><th className="py-2 pr-3">Updated</th><th className="py-2 pr-3">KB</th>
              </tr></thead>
              <tbody>
                {openAlerts.map((a) => (
                  <tr key={a.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3"><Badge tone={severityTone(a.severity)}>{a.severity || '—'}</Badge></td>
                    <td className="py-2 pr-3 text-ink-muted">{a.arrayName || '—'}</td>
                    <td className="py-2 pr-3 text-ink">{a.summary || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{a.component || '—'}{a.componentType ? ` (${a.componentType})` : ''}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px] tnum">{a.updated ? timeAgo(a.updated) : '—'}</td>
                    <td className="py-2 pr-3">
                      {a.knowledgeBaseUrl
                        ? <a href={a.knowledgeBaseUrl} target="_blank" rel="noreferrer" className="text-brand hover:underline inline-flex items-center gap-1 text-[11px]">KB <ExternalLink size={11} /></a>
                        : <span className="text-ink-faint">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Fleet table */}
      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <p className="text-sm font-semibold text-ink">Arrays {rows ? `(${filtered.length})` : ''}</p>
          <div className="relative w-64 max-w-full">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name, model, version…"
              className="w-full bg-surface border border-cohesity-border text-[13px] text-ink rounded-lg pl-9 pr-3 py-1.5 placeholder-ink-faint focus:border-brand/60 transition-colors" />
          </div>
        </div>
        {rows == null ? (
          <LoadingPanel label="Loading arrays…" height={160} />
        ) : filtered.length === 0 ? (
          <div className="text-sm text-ink-muted py-8 text-center">No arrays match.</div>
        ) : (
          <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <Th k="name">Array</Th><Th k="model">Model</Th><Th k="version">Purity</Th>
                <Th k="total" right>Capacity</Th><Th k="used" right>Used</Th><Th k="pctUsed" right>% Full</Th>
                <Th k="dataReduction" right>Reduction</Th><th className="py-2 pr-3 text-left">FQDN</th>
              </tr></thead>
              <tbody>
                {pageItems.map((r) => (
                  <tr key={r.id} onClick={() => setSelected((cur) => (cur && cur.id === r.id ? null : r))}
                    className={`border-b border-cohesity-border/50 cursor-pointer transition-colors ${selected && selected.id === r.id ? 'bg-brand/10' : 'hover:bg-surface-overlay/40'}`}>
                    <td className="py-2 pr-3 text-ink font-medium">{r.name}</td>
                    <td className="py-2 pr-3 text-ink-muted">{r.model || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum">{r.version || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(r.total)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(r.used)}</td>
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2 justify-end">
                        <div className="w-16 h-1.5 rounded-full bg-cohesity-border/50 overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${Math.min(100, r.pctUsed || 0)}%`, background: pctBarColor(r.pctUsed, status?.warnPct, status?.critPct) }} />
                        </div>
                        <span className="tnum text-ink-muted w-10 text-right">{r.pctUsed != null ? `${r.pctUsed.toFixed(0)}%` : '—'}</span>
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtRatio(r.dataReduction)}</td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px]">{r.fqdn || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows && filtered.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 pt-3 mt-2 border-t border-cohesity-border">
            <div className="flex items-center gap-2">
              <span className="text-xs text-ink-faint">Rows per page:</span>
              <select value={pageSize} onChange={(e) => setPageSize(e.target.value === 'all' ? 'all' : Number(e.target.value))}
                className="bg-surface border border-cohesity-border text-[13px] text-ink rounded-lg px-2 py-1 focus:border-brand/60">
                <option value={5}>5</option>
                <option value={10}>10</option>
                <option value={20}>20</option>
                <option value="all">All</option>
              </select>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-ink-faint tnum">{rangeStart}–{rangeEnd} of {filtered.length}</span>
              {pageSize !== 'all' && (
                <div className="flex items-center gap-1">
                  <button onClick={() => setPage(0)} disabled={safePage === 0} aria-label="First page" className="text-xs px-2 py-1 rounded-md border border-cohesity-border text-ink-muted hover:border-brand/50 hover:text-brand disabled:opacity-30 transition-colors cursor-pointer">«</button>
                  <button onClick={() => setPage(safePage - 1)} disabled={safePage === 0} aria-label="Previous page" className="text-xs px-2 py-1 rounded-md border border-cohesity-border text-ink-muted hover:border-brand/50 hover:text-brand disabled:opacity-30 transition-colors cursor-pointer">‹</button>
                  <span className="text-xs text-ink-faint px-1 tnum">{safePage + 1} / {pageCount}</span>
                  <button onClick={() => setPage(safePage + 1)} disabled={safePage >= pageCount - 1} aria-label="Next page" className="text-xs px-2 py-1 rounded-md border border-cohesity-border text-ink-muted hover:border-brand/50 hover:text-brand disabled:opacity-30 transition-colors cursor-pointer">›</button>
                  <button onClick={() => setPage(pageCount - 1)} disabled={safePage >= pageCount - 1} aria-label="Last page" className="text-xs px-2 py-1 rounded-md border border-cohesity-border text-ink-muted hover:border-brand/50 hover:text-brand disabled:opacity-30 transition-colors cursor-pointer">»</button>
                </div>
              )}
            </div>
          </div>
        )}
        {status && status.lastRefresh && status.lastRefresh.overview && (
          <p className="text-[11px] text-ink-faint mt-2">Data as of {timeAgo(status.lastRefresh.overview)} · Pure capacity metrics update daily. Select a row for charts.</p>
        )}
      </div>

      {/* Selected-array charts */}
      {selected && (
        <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <div className="flex items-start justify-between gap-3 mb-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink truncate">{selected.name}</p>
              <p className="text-[11px] text-ink-faint">{selected.model || '—'} · Purity {selected.version || '—'} · {fmtBytes(selected.used)} of {fmtBytes(selected.total)} used{selected.pctUsed != null ? ` (${selected.pctUsed.toFixed(0)}%)` : ''}</p>
            </div>
            <button onClick={() => setSelected(null)} aria-label="Close" className="text-ink-faint hover:text-ink flex-shrink-0"><X size={16} /></button>
          </div>
          {detailLoading ? (
            <LoadingPanel label="Loading charts…" height={220} />
          ) : (
            <>
              <div className="mb-4">
                <p className="text-[12px] font-semibold text-ink-muted mb-2">Capacity (30 days)</p>
                {capRows.length === 0 ? (
                  <div className="text-sm text-ink-muted py-8 text-center">No capacity history.</div>
                ) : (
                  <TrendChart labels={capLabels} height={220} format={(v) => fmtBytes(v)}
                    datasets={[
                      { label: 'Total', data: capRows.map((r) => r.total), color: '#64748B' },
                      { label: 'Used', data: capRows.map((r) => r.used), color: BRAND, fill: true },
                    ]} />
                )}
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div>
                  <p className="text-[12px] font-semibold text-ink-muted mb-2">IOPS (24h)</p>
                  <TrendChart labels={perfLabels} height={180} format={fmtIops}
                    datasets={[
                      { label: 'Read', data: pcol('array_read_iops'), color: BRAND },
                      { label: 'Write', data: pcol('array_write_iops'), color: '#0EA5E9' },
                    ]} />
                </div>
                <div>
                  <p className="text-[12px] font-semibold text-ink-muted mb-2">Latency (24h)</p>
                  <TrendChart labels={perfLabels} height={180} format={(v) => `${(v / 1000).toFixed(2)} ms`}
                    datasets={[
                      { label: 'Read', data: pcol('array_read_latency_us'), color: '#8B5CF6' },
                      { label: 'Write', data: pcol('array_write_latency_us'), color: '#F59E0B' },
                    ]} />
                </div>
                <div>
                  <p className="text-[12px] font-semibold text-ink-muted mb-2">Bandwidth (24h)</p>
                  <TrendChart labels={perfLabels} height={180} format={(v) => `${fmtBytes(v)}/s`}
                    datasets={[
                      { label: 'Read', data: pcol('array_read_bandwidth'), color: '#22C55E' },
                      { label: 'Write', data: pcol('array_write_bandwidth'), color: '#EF4444' },
                    ]} />
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
