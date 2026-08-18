// NetApp Overview — ported from frontend/src/pages/netapp/NetAppOverviewPage.jsx.
// TrendChart (react-chartjs-2 wrapper, not importable in a plugin) is
// replaced by charts.jsx's LineChart (window.Chart). Toasts become inline
// status text; mutating fetches use apiFetch (CSRF header attached
// automatically for non-GET).
import { Gauge, Database, Activity, Timer, AlertTriangle, TrendingUp, Layers } from '../icons.jsx';
import { apiFetch, PageHeader, StatCard, LoadingPanel, RefreshButton, LastUpdated, BRAND, fmtBytes, fmtNum, fmtLatency, fmtRatio } from '../ui.jsx';
import { LineChart } from '../charts.jsx';

const RANGES = [{ label: '7d', days: 7 }, { label: '30d', days: 30 }, { label: '90d', days: 90 }];
const READ_COLOR = '#0067C5';
const WRITE_COLOR = '#f59e0b';
const MS_PER_DAY = 86400000;
const toTB = (b) => (b != null ? +(b / 1e12).toFixed(3) : null);
const toMs = (us) => (us != null ? +(us / 1000).toFixed(2) : null);
const toMBs = (b) => (b != null ? +(b / 1e6).toFixed(1) : null);

function linearFit(points) {
  const n = points.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (const [x, y] of points) { sx += x; sy += y; sxy += x * y; sxx += x * x; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  return { slope: (n * sxy - sx * sy) / denom };
}
function daysUntil(fit, lastUsed, target) {
  if (!fit || fit.slope <= 0) return null;
  const perDay = fit.slope * MS_PER_DAY;
  if (perDay <= 0) return null;
  const days = (target - lastUsed) / perDay;
  return days > 0 ? Math.round(days) : 0;
}

function trendData(labels, datasets) {
  return {
    labels,
    datasets: datasets.map((d) => ({
      label: d.label,
      data: d.data,
      borderColor: d.color,
      backgroundColor: d.fill ? `${d.color}33` : d.color,
      fill: !!d.fill,
      tension: 0.3,
      pointRadius: 0,
      borderWidth: 2,
    })),
  };
}

function ChartCard({ title, children }) {
  return (
    <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-3">{title}</p>
      {children}
    </div>
  );
}

export default function OverviewPage() {
  const [arrays, setArrays] = React.useState(null);
  const [selectedId, setSelectedId] = React.useState(null);
  const [days, setDays] = React.useState(30);
  const [history, setHistory] = React.useState(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [status, setStatus] = React.useState(null);

  const flash = (type, msg) => { setStatus({ type, msg }); setTimeout(() => setStatus((s) => (s?.msg === msg ? null : s)), 5000); };

  const loadOverview = React.useCallback(() => {
    return apiFetch('/netapp/overview')
      .then((data) => {
        setArrays(data);
        setSelectedId((cur) => (cur && data.some((a) => a.id === cur) ? cur : (data.find((a) => a.latest) || data[0])?.id ?? null));
      })
      .catch(() => { setArrays([]); flash('error', 'Failed to load NetApp overview'); });
  }, []);

  const hardRefresh = async () => {
    setRefreshing(true);
    try {
      const list = arrays && arrays.length ? arrays : (await apiFetch('/netapp/overview')) || [];
      await Promise.allSettled(list.map((a) => apiFetch(`/netapp/arrays/${a.id}/poll`, { method: 'POST', body: {} })));
      const data = await apiFetch(`/netapp/overview?_=${Date.now()}`);
      setArrays(data);
      const sel = (selectedId && data.some((a) => a.id === selectedId)) ? selectedId : (data.find((a) => a.latest) || data[0])?.id ?? null;
      setSelectedId(sel);
      if (sel) setHistory(await apiFetch(`/netapp/arrays/${sel}/metrics/history?days=${days}&_=${Date.now()}`));
      setLastRefreshed(new Date());
      flash('success', 'Data refreshed');
    } catch {
      flash('error', 'Refresh failed — could not pull fresh data from the cluster(s).');
    } finally {
      setRefreshing(false);
    }
  };

  React.useEffect(() => { loadOverview(); }, [loadOverview]);

  React.useEffect(() => {
    if (!selectedId) { setHistory(null); return undefined; }
    let cancelled = false;
    setHistory(null);
    apiFetch(`/netapp/arrays/${selectedId}/metrics/history?days=${days}`)
      .then((data) => { if (!cancelled) setHistory(data); })
      .catch(() => { if (!cancelled) setHistory([]); });
    return () => { cancelled = true; };
  }, [selectedId, days]);

  const fleet = React.useMemo(() => {
    const withM = (arrays || []).filter((a) => a.latest);
    const acc = { total: 0, used: 0, iops: 0, effW: 0, effWt: 0, lat: 0, latN: 0, alerts: 0, volumes: 0 };
    for (const a of arrays || []) { acc.alerts += a.open_alerts || 0; acc.volumes += a.volume_count || 0; }
    for (const a of withM) {
      const l = a.latest;
      acc.total += l.total_bytes || 0;
      acc.used += l.used_bytes || 0;
      acc.iops += (l.read_iops || 0) + (l.write_iops || 0);
      if (l.used_bytes && l.efficiency_ratio) { acc.effW += l.efficiency_ratio * l.used_bytes; acc.effWt += l.used_bytes; }
      const lat = ((l.read_latency_us || 0) + (l.write_latency_us || 0)) / 2;
      if (lat > 0) { acc.lat += lat; acc.latN += 1; }
    }
    return {
      count: (arrays || []).length, withData: withM.length,
      total: acc.total, used: acc.used, pct: acc.total ? Math.round((acc.used / acc.total) * 100) : 0,
      iops: acc.iops, eff: acc.effWt ? acc.effW / acc.effWt : 0,
      latency: acc.latN ? acc.lat / acc.latN : null, alerts: acc.alerts, volumes: acc.volumes,
    };
  }, [arrays]);

  const series = React.useMemo(() => (history || []).map((r) => ({
    time: new Date(r.captured_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    usedTB: toTB(r.used_bytes), totalTB: toTB(r.total_bytes),
    eff: r.efficiency_ratio != null ? +r.efficiency_ratio.toFixed(1) : null,
    readIops: r.read_iops != null ? Math.round(r.read_iops) : null,
    writeIops: r.write_iops != null ? Math.round(r.write_iops) : null,
    readMs: toMs(r.read_latency_us), writeMs: toMs(r.write_latency_us),
    readMBs: toMBs(r.read_throughput_bytes), writeMBs: toMBs(r.write_throughput_bytes),
    physicalTB: toTB(r.physical_used_bytes), logicalTB: toTB(r.logical_used_bytes),
  })), [history]);

  const forecast = React.useMemo(() => {
    if (!history || history.length < 2) return { ready: false };
    const pts = history.filter((r) => r.used_bytes != null).map((r) => [new Date(r.captured_at).getTime(), r.used_bytes]);
    const fit = linearFit(pts);
    const last = history[history.length - 1];
    const cap = last?.total_bytes || 0;
    const used = last?.used_bytes || 0;
    if (!fit || fit.slope <= 0 || !cap) return { ready: true, growing: false };
    return {
      ready: true, growing: true, perDay: fit.slope * MS_PER_DAY,
      to80: daysUntil(fit, used, cap * 0.8), to90: daysUntil(fit, used, cap * 0.9), to100: daysUntil(fit, used, cap),
      points: pts.length, spanDays: pts.length ? (pts[pts.length - 1][0] - pts[0][0]) / MS_PER_DAY : 0,
    };
  }, [history]);

  const selected = (arrays || []).find((a) => a.id === selectedId);
  const enough = series.length >= 2;
  const labels = series.map((s) => s.time);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Gauge} title="NetApp Overview" description="Fleet capacity, efficiency, performance and forecasts across all ONTAP clusters">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={hardRefresh} refreshing={refreshing} />
      </PageHeader>

      {status && <p className="text-xs mb-3" style={{ color: status.type === 'error' ? 'var(--na-crit)' : 'var(--na-ok)' }}>{status.msg}</p>}

      {arrays == null ? (
        <LoadingPanel label="Loading NetApp overview…" />
      ) : arrays.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-ink-muted" style={{ borderTop: `3px solid ${BRAND}` }}>
          No NetApp clusters registered yet. Add one under Settings.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
            <StatCard icon={Database} label="Total Capacity" value={fmtBytes(fleet.total)} tone="brand" />
            <StatCard icon={Database} label="Used" value={fmtBytes(fleet.used)} sub={`${fleet.pct}% full`} />
            <StatCard icon={Layers} label="Efficiency" value={fmtRatio(fleet.eff)} />
            <StatCard icon={Activity} label="Total IOPS" value={fmtNum(fleet.iops)} />
            <StatCard icon={Timer} label="Avg Latency" value={fmtLatency(fleet.latency)} />
            <StatCard icon={AlertTriangle} label="Open Alerts" value={fleet.alerts} tone={fleet.alerts > 0 ? 'crit' : 'ok'} />
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, borderRadius: 8, background: 'var(--na-surface)', border: '1px solid var(--na-border)', padding: 4, overflowX: 'auto' }}>
              {arrays.map((a) => {
                const active = a.id === selectedId;
                return (
                  <button key={a.id} onClick={() => setSelectedId(a.id)}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap', border: 'none', cursor: 'pointer', background: active ? 'var(--na-surface-overlay)' : 'transparent', color: active ? 'var(--na-ink)' : 'var(--na-ink-muted)' }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: a.latest ? BRAND : '#6b7280' }} />{a.name}
                  </button>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {RANGES.map(({ label, days: d }) => (
                <button key={d} onClick={() => setDays(d)}
                  style={{ fontSize: 12, padding: '6px 10px', borderRadius: 6, border: `1px solid ${days === d ? 'transparent' : 'var(--na-border)'}`, cursor: 'pointer', color: days === d ? '#fff' : 'var(--na-ink-muted)', background: days === d ? BRAND : 'transparent' }}>{label}</button>
              ))}
            </div>
          </div>

          <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <TrendingUp size={16} style={{ color: BRAND }} /><p className="text-sm font-semibold text-ink">Capacity Forecast — {selected?.name || '—'}</p>
            </div>
            {history == null ? (
              <LoadingPanel label="Loading history…" height={80} />
            ) : !forecast.ready ? (
              <p className="text-sm text-ink-muted">Not enough history yet. Forecasts appear once at least two samples are collected (polls every 15 min).</p>
            ) : !forecast.growing ? (
              <p className="text-sm text-status-ok">No net capacity growth over the selected window — no fill date projected.</p>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <StatCard icon={TrendingUp} label="Growth / day" value={fmtBytes(forecast.perDay)} />
                  <StatCard icon={Database} label="Days to 80%" value={forecast.to80 != null ? `${fmtNum(forecast.to80)} d` : '—'} tone={forecast.to80 != null && forecast.to80 < 30 ? 'warn' : 'default'} />
                  <StatCard icon={Database} label="Days to 90%" value={forecast.to90 != null ? `${fmtNum(forecast.to90)} d` : '—'} tone={forecast.to90 != null && forecast.to90 < 30 ? 'warn' : 'default'} />
                  <StatCard icon={Database} label="Days to Full" value={forecast.to100 != null ? `${fmtNum(forecast.to100)} d` : '—'} tone={forecast.to100 != null && forecast.to100 < 60 ? 'crit' : 'default'} />
                </div>
                <p style={{ fontSize: 11, color: 'var(--na-ink-faint)', marginTop: 8 }}>Linear projection from {forecast.points} sample(s) over {forecast.spanDays.toFixed(1)} day(s).{forecast.spanDays < 3 && ' Low confidence — improves as more data is collected.'}</p>
              </>
            )}
          </div>

          {history == null ? (
            <LoadingPanel label="Loading trends…" />
          ) : !enough ? (
            <div className="panel p-8 text-center text-sm text-ink-muted" style={{ borderTop: `3px solid ${BRAND}` }}>
              Only {series.length} sample collected so far. Trend charts populate as polling continues (every 15 min).
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <ChartCard title="Capacity (TB)">
                <LineChart data={trendData(labels, [
                  { label: 'Total', data: series.map((s) => s.totalTB), color: '#6b7280' },
                  { label: 'Used', data: series.map((s) => s.usedTB), color: BRAND, fill: true },
                ])} />
              </ChartCard>
              <ChartCard title="Storage Efficiency (x : 1)">
                <LineChart data={trendData(labels, [{ label: 'Efficiency', data: series.map((s) => s.eff), color: BRAND }])} />
              </ChartCard>
              <ChartCard title="IOPS">
                <LineChart data={trendData(labels, [
                  { label: 'Read', data: series.map((s) => s.readIops), color: READ_COLOR },
                  { label: 'Write', data: series.map((s) => s.writeIops), color: WRITE_COLOR },
                ])} />
              </ChartCard>
              <ChartCard title="Latency (ms)">
                <LineChart data={trendData(labels, [
                  { label: 'Read', data: series.map((s) => s.readMs), color: READ_COLOR },
                  { label: 'Write', data: series.map((s) => s.writeMs), color: WRITE_COLOR },
                ])} />
              </ChartCard>
              <ChartCard title="Throughput (MB/s)">
                <LineChart data={trendData(labels, [
                  { label: 'Read', data: series.map((s) => s.readMBs), color: READ_COLOR },
                  { label: 'Write', data: series.map((s) => s.writeMBs), color: WRITE_COLOR },
                ])} />
              </ChartCard>
              <ChartCard title="Effective vs Physical (TB)">
                <LineChart data={trendData(labels, [
                  { label: 'Logical (effective)', data: series.map((s) => s.logicalTB), color: BRAND },
                  { label: 'Physical (on disk)', data: series.map((s) => s.physicalTB), color: '#6b7280' },
                ])} />
              </ChartCard>
            </div>
          )}
        </>
      )}
    </div>
  );
}
