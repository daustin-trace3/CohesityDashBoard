// Ported from frontend/src/pages/pure/Pure1FleetPage.jsx (the platform's
// main `/pure` route, labelled "Overview" in the nav). apiFetch replaces
// axios `client`; useToast dropped per the no-host-toast rule (read
// failures just degrade to an empty list, same as every other plugin
// conversion). TrendChart import swapped for the local Chart.js kit.
import { Cloud, Server, Database, HardDrive, AlertTriangle, Search, ExternalLink, X } from '../icons.jsx';
import { TrendChart } from '../charts.jsx';
import {
  apiFetch, PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated,
  BRAND, fmtBytes, fmtNum, fmtRatio, timeAgo, severityTone,
} from '../ui.jsx';

const USED_PARTS = ['array_volume_space', 'array_shared_space', 'array_snapshot_space', 'array_system_space', 'array_replication_space'];
const fmtIops = (v) => (v == null ? '—' : `${Math.round(v).toLocaleString()}`);

function pctBarColor(pct, warn = 75, crit = 90) {
  if (pct == null) return '#334155';
  if (pct >= crit) return '#EF4444';
  if (pct >= warn) return '#F59E0B';
  return BRAND;
}

function Mini({ label, value, sub }) {
  return (
    <div className="rounded-lg border border-cohesity-border bg-surface p-2.5">
      <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="text-sm text-ink tnum">{value}</p>
      {sub && <p className="text-[10px] text-ink-faint">{sub}</p>}
    </div>
  );
}

function cmpVer(a, b) {
  const pa = String(a || '').split('.').map(Number);
  const pb = String(b || '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

const healthColor = (h) => (h === 'crit' ? '#EF4444' : h === 'warn' ? '#F59E0B' : '#22C55E');

export default function PureOverviewPage() {
  const [rows, setRows] = React.useState(null);
  const [alerts, setAlerts] = React.useState([]);
  const [status, setStatus] = React.useState(null);
  const [enrichment, setEnrichment] = React.useState({});
  const [q, setQ] = React.useState('');
  const [tagFilter, setTagFilter] = React.useState('');
  const [sort, setSort] = React.useState({ key: 'pctUsed', dir: -1 });
  const [pageSize, setPageSize] = React.useState(10);
  const [page, setPage] = React.useState(0);
  const [refreshing, setRefreshing] = React.useState(false);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [selected, setSelected] = React.useState(null);
  const [cap, setCap] = React.useState(null);
  const [perf, setPerf] = React.useState(null);
  const [detailLoading, setDetailLoading] = React.useState(false);

  const load = React.useCallback((force = false) => {
    const suffix = force ? '?refresh=1' : '';
    return Promise.allSettled([
      apiFetch(`/pure/pure1/overview${suffix}`),
      apiFetch(`/pure/pure1/alerts${suffix}`),
      apiFetch('/pure/pure1/status'),
      apiFetch(`/pure/pure1/enrichment${suffix}`),
    ]).then(([o, a, s, e]) => {
      setRows(o.status === 'fulfilled' ? o.value : []);
      setAlerts(a.status === 'fulfilled' ? (a.value || []) : []);
      setStatus(s.status === 'fulfilled' ? s.value : null);
      setEnrichment(e.status === 'fulfilled' ? (e.value || {}) : {});
    });
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const hardRefresh = async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
    setLastRefreshed(new Date());
  };

  const totals = React.useMemo(() => {
    const list = rows || [];
    const total = list.reduce((s, r) => s + (r.total || 0), 0);
    const used = list.reduce((s, r) => s + (r.used || 0), 0);
    const drs = list.map((r) => r.dataReduction).filter((v) => v > 0);
    const avgDr = drs.length ? drs.reduce((s, v) => s + v, 0) / drs.length : null;
    return { count: list.length, total, used, avgDr, pct: total > 0 ? (used / total) * 100 : null };
  }, [rows]);

  const filtered = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = (rows || []).filter((r) => {
      const hay = [r.name, r.model, r.version, r.fqdn, ...(r.tags || []).map((t) => `${t.key} ${t.value}`)];
      const matchesText = !needle || hay.some((v) => String(v || '').toLowerCase().includes(needle));
      const matchesTag = !tagFilter || (r.tags || []).some((t) => `${t.key}=${t.value}` === tagFilter);
      return matchesText && matchesTag;
    });
    const { key, dir } = sort;
    list = [...list].sort((a, b) => {
      const valOf = (r) => (key === 'provisioned' ? (enrichment[r.id] && enrichment[r.id].provisioned) || 0 : r[key]);
      const va = valOf(a), vb = valOf(b);
      if (typeof va === 'string' || typeof vb === 'string') return String(va || '').localeCompare(String(vb || '')) * dir;
      return ((va || 0) - (vb || 0)) * dir;
    });
    return list;
  }, [rows, q, sort, tagFilter, enrichment]);

  React.useEffect(() => { setPage(0); }, [q, sort, pageSize, tagFilter]);
  const pageCount = pageSize === 'all' ? 1 : Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const pageItems = pageSize === 'all' ? filtered : filtered.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const rangeStart = filtered.length === 0 ? 0 : (pageSize === 'all' ? 1 : safePage * pageSize + 1);
  const rangeEnd = pageSize === 'all' ? filtered.length : Math.min((safePage + 1) * pageSize, filtered.length);

  const openAlerts = React.useMemo(
    () => alerts.filter((a) => (status && status.showHiddenAlerts) || String(a.severity || '').toLowerCase() !== 'hidden'),
    [alerts, status]);

  const allTags = React.useMemo(() => {
    const s = new Set();
    for (const r of (rows || [])) for (const t of (r.tags || [])) s.add(`${t.key}=${t.value}`);
    return [...s].sort();
  }, [rows]);
  const sevRank = (s) => ({ critical: 3, warning: 2 }[String(s || '').toLowerCase()] || 1);
  const alertsByArray = React.useMemo(() => {
    const m = new Map();
    for (const a of openAlerts) {
      if (!a.arrayName) continue;
      const cur = m.get(a.arrayName) || { count: 0, worst: 'info' };
      cur.count += 1;
      if (sevRank(a.severity) > sevRank(cur.worst)) cur.worst = a.severity;
      m.set(a.arrayName, cur);
    }
    return m;
  }, [openAlerts]);

  const newestVersion = React.useMemo(() => {
    const vs = (rows || []).map((r) => r.version).filter(Boolean);
    return vs.length ? [...vs].sort(cmpVer).pop() : null;
  }, [rows]);
  const attention = React.useMemo(() => {
    let behind = 0, unhealthy = 0;
    for (const r of (rows || [])) {
      if (newestVersion && cmpVer(r.version, newestVersion) < 0) behind += 1;
      const en = enrichment[r.id];
      if (en && en.health && en.health !== 'ok') unhealthy += 1;
    }
    return { behind, unhealthy };
  }, [rows, enrichment, newestVersion]);

  React.useEffect(() => {
    if (!selected) { setCap(null); setPerf(null); return undefined; }
    let cancelled = false;
    setDetailLoading(true);
    Promise.allSettled([
      apiFetch(`/pure/pure1/capacity/history?arrayId=${selected.id}&days=30`),
      apiFetch(`/pure/pure1/performance/history?arrayId=${selected.id}&days=1`),
    ]).then(([c, p]) => {
      if (cancelled) return;
      setCap(c.status === 'fulfilled' ? c.value : { series: {} });
      setPerf(p.status === 'fulfilled' ? p.value : { series: {} });
    }).finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selected]);

  const capRows = React.useMemo(() => {
    const series = (cap && cap.series) || {};
    const totals2 = series.array_total_capacity || [];
    const byTs = (name) => { const m = new Map(); for (const [ts, v] of (series[name] || [])) m.set(ts, v); return m; };
    const maps = Object.fromEntries(USED_PARTS.map((n) => [n, byTs(n)]));
    return totals2.map(([ts, total]) => ({ ts, total, used: USED_PARTS.reduce((s, n) => s + (maps[n].get(ts) || 0), 0) }));
  }, [cap]);
  const capLabels = React.useMemo(() => capRows.map((r) => new Date(r.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })), [capRows]);

  const forecast = React.useMemo(() => {
    if (capRows.length < 3) return null;
    const t0 = capRows[0].ts;
    const xs = capRows.map((r) => (r.ts - t0) / 86400000);
    const ys = capRows.map((r) => r.used);
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    const slope = den ? num / den : 0;
    const last = capRows[capRows.length - 1];
    const daysToFull = slope > 0 && last.total > last.used ? (last.total - last.used) / slope : null;
    return { slope, daysToFull };
  }, [capRows]);

  const ps = (perf && perf.series) || {};
  const perfLabels = React.useMemo(() => (ps.array_read_iops || []).map(([ts]) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })), [perf]);
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
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={hardRefresh} refreshing={refreshing} />
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <StatCard icon={Server} label="Arrays" value={fmtNum(totals.count)} tone="brand" />
        <StatCard icon={Database} label="Total Capacity" value={fmtBytes(totals.total)} />
        <StatCard icon={HardDrive} label="Total Used" value={fmtBytes(totals.used)} sub={totals.pct != null ? `${totals.pct.toFixed(1)}% used` : undefined} />
        <StatCard icon={Database} label="Avg Data Reduction" value={fmtRatio(totals.avgDr)} />
        <StatCard icon={AlertTriangle} label="Open Alerts" value={fmtNum(openAlerts.length)} tone={openAlerts.length > 0 ? 'warn' : 'ok'} />
      </div>

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

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <p className="text-sm font-semibold text-ink">Arrays {rows ? `(${filtered.length})` : ''}</p>
            {attention.behind > 0 && <span className="text-[11px] text-status-warn">▲ {attention.behind} behind newest Purity{newestVersion ? ` (${newestVersion})` : ''}</span>}
            {attention.unhealthy > 0 && <span className="text-[11px] text-status-crit">● {attention.unhealthy} with hardware faults</span>}
          </div>
          <div className="flex items-center gap-2">
            {allTags.length > 0 && (
              <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} className="pu-input" style={{ width: 'auto', maxWidth: 200 }}>
                <option value="">All tags</option>
                {allTags.map((t) => <option key={t} value={t}>{t.replace('=', ': ')}</option>)}
              </select>
            )}
            <div className="relative w-64 max-w-full">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name, model, tag…"
                className="pu-input" style={{ paddingLeft: 32 }} />
            </div>
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
                <Th k="dataReduction" right>Reduction</Th><Th k="provisioned" right>Provisioned</Th><th className="py-2 pr-3 text-right">Alerts</th><th className="py-2 pr-3 text-left">FQDN</th>
              </tr></thead>
              <tbody>
                {pageItems.map((r) => (
                  <tr key={r.id} onClick={() => setSelected((cur) => (cur && cur.id === r.id ? null : r))}
                    className={`border-b border-cohesity-border/50 cursor-pointer transition-colors ${selected && selected.id === r.id ? 'bg-brand/10' : 'hover:bg-surface-overlay/40'}`}>
                    <td className="py-2 pr-3">
                      <div className="text-ink font-medium flex items-center gap-1.5">
                        {enrichment[r.id] && (
                          <span title={enrichment[r.id].unhealthy > 0 ? `${enrichment[r.id].unhealthy} component(s) not healthy` : 'All components healthy'}
                            className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ background: healthColor(enrichment[r.id].health) }} />
                        )}
                        {r.name}
                      </div>
                      {r.tags && r.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {r.tags.slice(0, 3).map((t, i) => (
                            <span key={i} className="inline-block px-1.5 py-px rounded text-[10px] bg-surface-overlay border border-cohesity-border text-ink-faint">{t.key}: {t.value}</span>
                          ))}
                          {r.tags.length > 3 && <span className="text-[10px] text-ink-faint self-center">+{r.tags.length - 3}</span>}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-ink-muted">{r.model || '—'}</td>
                    <td className="py-2 pr-3 tnum">
                      <span className={newestVersion && cmpVer(r.version, newestVersion) < 0 ? 'text-status-warn' : 'text-ink-muted'}>{r.version || '—'}</span>
                      {newestVersion && cmpVer(r.version, newestVersion) < 0 && <span title={`Behind newest (${newestVersion})`} className="ml-1 text-[10px] text-status-warn">▲</span>}
                    </td>
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
                    <td className="py-2 pr-3 text-right">{(() => { const en = enrichment[r.id]; if (!en || !en.provisioned) return <span className="text-ink-faint">—</span>; const ratio = r.total ? en.provisioned / r.total : null; return <span className="tnum text-ink-muted" title={ratio ? `${ratio.toFixed(1)}× of usable capacity provisioned` : ''}>{fmtBytes(en.provisioned)}{ratio ? <span className="text-ink-faint"> ({ratio.toFixed(1)}×)</span> : ''}</span>; })()}</td>
                    <td className="py-2 pr-3 text-right">{(() => { const al = alertsByArray.get(r.name); return al ? <Badge tone={severityTone(al.worst)}>{al.count}</Badge> : <span className="text-ink-faint">—</span>; })()}</td>
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
              <select value={pageSize} onChange={(e) => setPageSize(e.target.value === 'all' ? 'all' : Number(e.target.value))} className="pu-input" style={{ width: 'auto' }}>
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
                  <button onClick={() => setPage(0)} disabled={safePage === 0} aria-label="First page" className="pu-btn-ghost">«</button>
                  <button onClick={() => setPage(safePage - 1)} disabled={safePage === 0} aria-label="Previous page" className="pu-btn-ghost">‹</button>
                  <span className="text-xs text-ink-faint px-1 tnum">{safePage + 1} / {pageCount}</span>
                  <button onClick={() => setPage(safePage + 1)} disabled={safePage >= pageCount - 1} aria-label="Next page" className="pu-btn-ghost">›</button>
                  <button onClick={() => setPage(pageCount - 1)} disabled={safePage >= pageCount - 1} aria-label="Last page" className="pu-btn-ghost">»</button>
                </div>
              )}
            </div>
          </div>
        )}
        {status && status.lastRefresh && status.lastRefresh.overview && (
          <p className="text-[11px] text-ink-faint mt-2">Data as of {timeAgo(status.lastRefresh.overview)} · Pure capacity metrics update daily. Select a row for charts.</p>
        )}
      </div>

      {selected && (
        <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <div className="flex items-start justify-between gap-3 mb-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink truncate">{selected.name}</p>
              <p className="text-[11px] text-ink-faint">{selected.model || '—'} · Purity {selected.version || '—'} · {fmtBytes(selected.used)} of {fmtBytes(selected.total)} used{selected.pctUsed != null ? ` (${selected.pctUsed.toFixed(0)}%)` : ''}</p>
              {selected.tags && selected.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {selected.tags.map((t, i) => (
                    <span key={i} className="inline-block px-1.5 py-px rounded text-[10px] bg-surface-overlay border border-cohesity-border text-ink-faint">{t.key}: {t.value}</span>
                  ))}
                </div>
              )}
            </div>
            <button onClick={() => setSelected(null)} aria-label="Close" className="text-ink-faint hover:text-ink flex-shrink-0"><X size={16} /></button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <Mini label="Effective (logical)" value={fmtBytes(selected.effectiveUsed)} sub={selected.dataReduction ? `${selected.dataReduction.toFixed(1)}:1 reduction` : undefined} />
            <Mini label="Snapshots" value={fmtBytes(selected.snapshotSpace)} sub={selected.used ? `${((selected.snapshotSpace / selected.used) * 100).toFixed(0)}% of used` : undefined} />
            <Mini label="Growth / day" value={forecast && forecast.slope > 0 ? `${fmtBytes(forecast.slope)}/day` : (forecast ? 'flat / shrinking' : '—')} />
            <Mini label="Projected full" value={forecast && forecast.daysToFull != null ? `${Math.round(forecast.daysToFull)} days` : '—'} sub={forecast && forecast.daysToFull != null ? new Date(Date.now() + forecast.daysToFull * 86400000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : undefined} />
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
