import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import {
  Database, RefreshCw, Gauge, Activity, Timer, AlertTriangle, TrendingUp, Layers,
} from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, LoadingPanel } from '../../components/ui/primitives';
import { BRAND, fmtBytes, fmtNum, fmtLatency, fmtRatio, usedPct } from './helpers';

const RANGES = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
];

const READ_COLOR = '#FF6B00';
const WRITE_COLOR = '#60a5fa';
const AXIS = '#9ca3af';
const GRID = '#3D3D3D';
const TOOLTIP_STYLE = { background: '#2C2C2C', border: '1px solid #3D3D3D', color: '#E5E5E5', fontSize: 12 };

const MS_PER_DAY = 86400000;
const toTB = (b) => (b != null ? +(b / 1e12).toFixed(2) : null);
const toMBs = (b) => (b != null ? +(b / 1e6).toFixed(1) : null);
const toMs = (us) => (us != null ? +(us / 1000).toFixed(2) : null);

/** Least-squares linear regression over [x(ms), y(bytes)] points. */
function linearFit(points) {
  const n = points.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (const [x, y] of points) { sx += x; sy += y; sxy += x * y; sxx += x * x; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom; // bytes per ms
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}

/** Project days until `used` reaches `target` bytes at the observed growth rate. */
function daysUntil(fit, lastUsed, target) {
  if (!fit || fit.slope <= 0) return null;
  const perDay = fit.slope * MS_PER_DAY;
  if (perDay <= 0) return null;
  const days = (target - lastUsed) / perDay;
  return days > 0 ? Math.round(days) : 0;
}

function chartCard(title, children) {
  return (
    <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-3">{title}</p>
      {children}
    </div>
  );
}

export default function PureOverviewPage() {
  const { toast } = useToast();
  const [arrays, setArrays] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [days, setDays] = useState(30);
  const [history, setHistory] = useState(null);
  const [growers, setGrowers] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadOverview = useCallback(() => {
    return client
      .get('/pure/overview')
      .then(({ data }) => {
        setArrays(data);
        setSelectedId((cur) => {
          if (cur && data.some((a) => a.id === cur)) return cur;
          const withData = data.find((a) => a.latest);
          return (withData || data[0])?.id ?? null;
        });
      })
      .catch(() => {
        setArrays([]);
        toast({ type: 'error', title: 'Failed to load Pure overview' });
      });
  }, [toast]);

  useEffect(() => { loadOverview(); }, [loadOverview]);

  // Live refresh: poll every array now, then reload fresh (cache-busted) data.
  const hardRefresh = async () => {
    setRefreshing(true);
    try {
      const list = arrays && arrays.length ? arrays : ((await client.get('/pure/overview')).data || []);
      await Promise.allSettled(list.map((a) => client.post(`/pure/arrays/${a.id}/poll`)));
      const bust = `_=${Date.now()}`;
      const { data } = await client.get(`/pure/overview?${bust}`);
      setArrays(data);
      const sel = (selectedId && data.some((a) => a.id === selectedId)) ? selectedId : (data.find((a) => a.latest) || data[0])?.id ?? null;
      setSelectedId(sel);
      if (sel) {
        const [h, g] = await Promise.allSettled([
          client.get(`/pure/arrays/${sel}/metrics/history?days=${days}&${bust}`),
          client.get(`/pure/arrays/${sel}/volumes/growth?days=${days}&${bust}`),
        ]);
        if (h.status === 'fulfilled') setHistory(h.value.data);
        if (g.status === 'fulfilled') setGrowers(g.value.data);
      }
      toast({ type: 'success', title: 'Data refreshed', message: 'Pulled fresh telemetry from all arrays.' });
    } catch {
      toast({ type: 'error', title: 'Refresh failed', message: 'Could not pull fresh data from the array(s).' });
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!selectedId) { setHistory(null); return; }
    let cancelled = false;
    setHistory(null);
    setGrowers(null);
    client
      .get(`/pure/arrays/${selectedId}/metrics/history?days=${days}`)
      .then(({ data }) => { if (!cancelled) setHistory(data); })
      .catch(() => { if (!cancelled) setHistory([]); });
    client
      .get(`/pure/arrays/${selectedId}/volumes/growth?days=${days}`)
      .then(({ data }) => { if (!cancelled) setGrowers(data); })
      .catch(() => { if (!cancelled) setGrowers([]); });
    return () => { cancelled = true; };
  }, [selectedId, days]);

  // ── Fleet KPIs (from latest sample of each array) ──────────────────────────
  const fleet = useMemo(() => {
    const withMetrics = (arrays || []).filter((a) => a.latest);
    const acc = { capacity: 0, used: 0, iops: 0, drrWeighted: 0, latWeighted: 0, latWeight: 0, alerts: 0, volumes: 0 };
    for (const a of arrays || []) acc.alerts += a.open_alerts || 0;
    for (const a of arrays || []) acc.volumes += a.volume_count || 0;
    for (const a of withMetrics) {
      const l = a.latest;
      acc.capacity += l.capacity_bytes || 0;
      acc.used += l.used_bytes || 0;
      acc.iops += (l.read_iops || 0) + (l.write_iops || 0);
      if (l.used_bytes && l.data_reduction) acc.drrWeighted += l.data_reduction * l.used_bytes;
      const lat = ((l.read_latency_us || 0) + (l.write_latency_us || 0)) / 2;
      if (lat > 0) { acc.latWeighted += lat; acc.latWeight += 1; }
    }
    return {
      count: (arrays || []).length,
      withData: withMetrics.length,
      capacity: acc.capacity,
      used: acc.used,
      pct: acc.capacity ? Math.round((acc.used / acc.capacity) * 100) : 0,
      iops: acc.iops,
      drr: acc.used ? acc.drrWeighted / acc.used : 0,
      latency: acc.latWeight ? acc.latWeighted / acc.latWeight : null,
      alerts: acc.alerts,
      volumes: acc.volumes,
    };
  }, [arrays]);

  // ── Selected-array trend series + forecast ─────────────────────────────────
  const series = useMemo(() => {
    if (!history) return [];
    return history.map((r) => ({
      t: new Date(r.captured_at).getTime(),
      time: new Date(r.captured_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      usedTB: toTB(r.used_bytes),
      capacityTB: toTB(r.capacity_bytes),
      drr: r.data_reduction != null ? +r.data_reduction.toFixed(1) : null,
      totalRatio: r.total_reduction != null ? +r.total_reduction.toFixed(1) : null,
      readIops: r.read_iops != null ? Math.round(r.read_iops) : null,
      writeIops: r.write_iops != null ? Math.round(r.write_iops) : null,
      readMs: toMs(r.read_latency_us),
      writeMs: toMs(r.write_latency_us),
      readMBs: toMBs(r.read_bw_bytes),
      writeMBs: toMBs(r.write_bw_bytes),
    }));
  }, [history]);

  const forecast = useMemo(() => {
    if (!history || history.length < 2) return { ready: false };
    const pts = history.filter((r) => r.used_bytes != null).map((r) => [new Date(r.captured_at).getTime(), r.used_bytes]);
    const fit = linearFit(pts);
    const last = history[history.length - 1];
    const cap = last?.capacity_bytes || 0;
    const used = last?.used_bytes || 0;
    if (!fit || fit.slope <= 0 || !cap) {
      return { ready: true, growing: false, perDay: fit ? fit.slope * MS_PER_DAY : 0 };
    }
    return {
      ready: true,
      growing: true,
      perDay: fit.slope * MS_PER_DAY,
      to80: daysUntil(fit, used, cap * 0.8),
      to90: daysUntil(fit, used, cap * 0.9),
      to100: daysUntil(fit, used, cap),
      points: pts.length,
      spanDays: pts.length ? (pts[pts.length - 1][0] - pts[0][0]) / MS_PER_DAY : 0,
    };
  }, [history]);

  const selected = (arrays || []).find((a) => a.id === selectedId);
  const enoughPoints = series.length >= 2;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Gauge} title="Pure Overview" description="Fleet health, capacity trends, and forecasts across all FlashArrays">
        <button
          onClick={hardRefresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} /> {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </PageHeader>

      {arrays == null ? (
        <LoadingPanel label="Loading Pure overview…" />
      ) : arrays.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-ink-muted" style={{ borderTop: `3px solid ${BRAND}` }}>
          No Pure arrays registered yet.
        </div>
      ) : (
        <>
          {/* Fleet KPI cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-4">
            <StatCard icon={Database} label="Total Capacity" value={fmtBytes(fleet.capacity)} tone="brand" />
            <StatCard icon={Database} label="Used" value={fmtBytes(fleet.used)} sub={`${fleet.pct}% full`} />
            <StatCard icon={Layers} label="Data Reduction" value={fmtRatio(fleet.drr)} />
            <StatCard icon={Activity} label="Total IOPS" value={fmtNum(fleet.iops)} />
            <StatCard icon={Timer} label="Avg Latency" value={fmtLatency(fleet.latency)} />
            <StatCard icon={AlertTriangle} label="Open Alerts" value={fleet.alerts} tone={fleet.alerts > 0 ? 'crit' : 'ok'} />
          </div>

          {/* Array selector + range */}
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-1 rounded-lg bg-surface border border-cohesity-border p-1 overflow-x-auto">
              {arrays.map((a) => {
                const active = a.id === selectedId;
                return (
                  <button
                    key={a.id}
                    onClick={() => setSelectedId(a.id)}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-[12px] font-medium whitespace-nowrap transition-colors ${
                      active ? 'bg-surface-overlay text-ink shadow-panel' : 'text-ink-muted hover:text-ink'
                    }`}
                  >
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: a.latest ? BRAND : '#6b7280' }} />
                    {a.name}
                  </button>
                );
              })}
            </div>
            <div className="flex gap-1">
              {RANGES.map(({ label, days: d }) => (
                <button
                  key={d}
                  onClick={() => setDays(d)}
                  className={`text-xs px-2.5 py-1.5 rounded border transition-colors ${
                    days === d ? 'text-white border-transparent' : 'border-cohesity-border text-ink-muted hover:text-ink'
                  }`}
                  style={days === d ? { backgroundColor: BRAND } : undefined}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Capacity forecast */}
          <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
            <div className="flex items-center gap-2 mb-3">
              <TrendingUp size={16} className="text-brand" />
              <p className="text-sm font-semibold text-ink">Capacity Forecast — {selected?.name || '—'}</p>
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
                <p className="text-[11px] text-ink-faint mt-2">
                  Linear projection from {forecast.points} sample{forecast.points === 1 ? '' : 's'} over {forecast.spanDays.toFixed(1)} day{forecast.spanDays === 1 ? '' : 's'}.
                  {forecast.spanDays < 3 && ' Low confidence — accuracy improves as more data is collected.'}
                </p>
              </>
            )}
          </div>

          {/* Top growing volumes */}
          <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
            <p className="text-sm font-semibold text-ink mb-3">Top Growing Volumes — {selected?.name || '—'} ({days}d)</p>
            {growers == null ? (
              <LoadingPanel label="Loading growth…" height={80} />
            ) : growers.filter((g) => (g.growth_bytes || 0) > 0).length === 0 ? (
              <p className="text-sm text-ink-muted">No measurable volume growth in this window yet.</p>
            ) : (
              <div className="overflow-x-auto max-h-[40vh] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-surface">
                    <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                      <th className="py-2 pr-3">Volume</th>
                      <th className="py-2 pr-3 text-right">Growth</th>
                      <th className="py-2 pr-3 text-right">Current Used</th>
                      <th className="py-2 pr-3 text-right">Provisioned</th>
                    </tr>
                  </thead>
                  <tbody>
                    {growers.filter((g) => (g.growth_bytes || 0) > 0).slice(0, 15).map((g) => (
                      <tr key={g.volume_name} className="border-b border-cohesity-border/50">
                        <td className="py-2 pr-3 text-ink truncate max-w-[260px]">{g.volume_name}</td>
                        <td className="py-2 pr-3 text-right tnum" style={{ color: BRAND }}>+{fmtBytes(g.growth_bytes)}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(g.last_used)}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtBytes(g.provisioned_bytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Trend charts */}
          {history == null ? (
            <LoadingPanel label="Loading trends…" />
          ) : !enoughPoints ? (
            <div className="panel p-8 text-center text-sm text-ink-muted" style={{ borderTop: `3px solid ${BRAND}` }}>
              Only {series.length} sample collected for this array so far. Trend charts will populate as polling continues (every 15 min).
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {chartCard('Capacity (TB)', (
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={series} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
                    <XAxis dataKey="time" tick={{ fill: AXIS, fontSize: 10 }} />
                    <YAxis tick={{ fill: AXIS, fontSize: 10 }} tickFormatter={(v) => `${v}`} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v, n) => [`${v} TB`, n]} />
                    <Legend wrapperStyle={{ fontSize: 11, color: AXIS }} />
                    <Area type="monotone" dataKey="capacityTB" name="Capacity" stroke="#6b7280" fill="#6b728022" strokeWidth={2} />
                    <Area type="monotone" dataKey="usedTB" name="Used" stroke={BRAND} fill={`${BRAND}22`} strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              ))}
              {chartCard('Data Reduction (x : 1)', (
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={series} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
                    <XAxis dataKey="time" tick={{ fill: AXIS, fontSize: 10 }} />
                    <YAxis tick={{ fill: AXIS, fontSize: 10 }} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v, n) => [`${v} : 1`, n]} />
                    <Legend wrapperStyle={{ fontSize: 11, color: AXIS }} />
                    <Line type="monotone" dataKey="drr" name="Data Reduction" stroke={BRAND} strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="totalRatio" name="Total Reduction" stroke={WRITE_COLOR} strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              ))}
              {chartCard('IOPS', (
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={series} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
                    <XAxis dataKey="time" tick={{ fill: AXIS, fontSize: 10 }} />
                    <YAxis tick={{ fill: AXIS, fontSize: 10 }} tickFormatter={(v) => fmtNum(v)} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v, n) => [`${fmtNum(v)} IOPS`, n]} />
                    <Legend wrapperStyle={{ fontSize: 11, color: AXIS }} />
                    <Line type="monotone" dataKey="readIops" name="Read" stroke={READ_COLOR} strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="writeIops" name="Write" stroke={WRITE_COLOR} strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              ))}
              {chartCard('Latency (ms)', (
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={series} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
                    <XAxis dataKey="time" tick={{ fill: AXIS, fontSize: 10 }} />
                    <YAxis tick={{ fill: AXIS, fontSize: 10 }} tickFormatter={(v) => `${v}`} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v, n) => [`${v} ms`, n]} />
                    <Legend wrapperStyle={{ fontSize: 11, color: AXIS }} />
                    <Line type="monotone" dataKey="readMs" name="Read" stroke={READ_COLOR} strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="writeMs" name="Write" stroke={WRITE_COLOR} strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
