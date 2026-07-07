import { useEffect, useState, useCallback, useMemo } from 'react';
import { Gauge, RefreshCw, Database, Activity, Timer, AlertTriangle, TrendingUp, Layers } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, LoadingPanel } from '../../components/ui/primitives';
import TrendChart from '../../components/TrendChart';
import { BRAND, fmtBytes, fmtNum, fmtLatency, fmtRatio } from './helpers';

const RANGES = [{ label: '7d', days: 7 }, { label: '30d', days: 30 }, { label: '90d', days: 90 }];
const READ_COLOR = '#0067C5';
const WRITE_COLOR = '#f59e0b';
const MS_PER_DAY = 86400000;
const toTB = (b) => (b != null ? +(b / 1e12).toFixed(3) : null);
const toMs = (us) => (us != null ? +(us / 1000).toFixed(2) : null);

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
function chartCard(title, children) {
  return (
    <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-3">{title}</p>
      {children}
    </div>
  );
}

export default function NetAppOverviewPage() {
  const { toast } = useToast();
  const [arrays, setArrays] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [days, setDays] = useState(30);
  const [history, setHistory] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadOverview = useCallback(() => {
    return client.get('/netapp/overview')
      .then(({ data }) => {
        setArrays(data);
        setSelectedId((cur) => (cur && data.some((a) => a.id === cur) ? cur : (data.find((a) => a.latest) || data[0])?.id ?? null));
      })
      .catch(() => { setArrays([]); toast({ type: 'error', title: 'Failed to load NetApp overview' }); });
  }, [toast]);

  // Live refresh: poll every cluster now, then reload fresh (cache-busted) data.
  const hardRefresh = async () => {
    setRefreshing(true);
    try {
      const list = arrays && arrays.length ? arrays : ((await client.get('/netapp/overview')).data || []);
      await Promise.allSettled(list.map((a) => client.post(`/netapp/arrays/${a.id}/poll`)));
      const bust = `_=${Date.now()}`;
      const { data } = await client.get(`/netapp/overview?${bust}`);
      setArrays(data);
      const sel = (selectedId && data.some((a) => a.id === selectedId)) ? selectedId : (data.find((a) => a.latest) || data[0])?.id ?? null;
      setSelectedId(sel);
      if (sel) {
        const h = await client.get(`/netapp/arrays/${sel}/metrics/history?days=${days}&${bust}`);
        setHistory(h.data);
      }
      toast({ type: 'success', title: 'Data refreshed', message: 'Pulled fresh telemetry from all clusters.' });
    } catch {
      toast({ type: 'error', title: 'Refresh failed', message: 'Could not pull fresh data from the cluster(s).' });
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => { loadOverview(); }, [loadOverview]);

  useEffect(() => {
    if (!selectedId) { setHistory(null); return; }
    let cancelled = false;
    setHistory(null);
    client.get(`/netapp/arrays/${selectedId}/metrics/history?days=${days}`)
      .then(({ data }) => { if (!cancelled) setHistory(data); })
      .catch(() => { if (!cancelled) setHistory([]); });
    return () => { cancelled = true; };
  }, [selectedId, days]);

  const fleet = useMemo(() => {
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

  const series = useMemo(() => (history || []).map((r) => ({
    time: new Date(r.captured_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    usedTB: toTB(r.used_bytes), totalTB: toTB(r.total_bytes),
    eff: r.efficiency_ratio != null ? +r.efficiency_ratio.toFixed(1) : null,
    readIops: r.read_iops != null ? Math.round(r.read_iops) : null,
    writeIops: r.write_iops != null ? Math.round(r.write_iops) : null,
    readMs: toMs(r.read_latency_us), writeMs: toMs(r.write_latency_us),
  })), [history]);

  const forecast = useMemo(() => {
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

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Gauge} title="NetApp Overview" description="Fleet capacity, efficiency, performance and forecasts across all ONTAP clusters">
        <button onClick={hardRefresh} disabled={refreshing} className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50">
          <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} /> {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </PageHeader>

      {arrays == null ? (
        <LoadingPanel label="Loading NetApp overview…" />
      ) : arrays.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-ink-muted" style={{ borderTop: `3px solid ${BRAND}` }}>
          No NetApp clusters registered yet. Add one under Settings.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-4">
            <StatCard icon={Database} label="Total Capacity" value={fmtBytes(fleet.total)} tone="brand" />
            <StatCard icon={Database} label="Used" value={fmtBytes(fleet.used)} sub={`${fleet.pct}% full`} />
            <StatCard icon={Layers} label="Efficiency" value={fmtRatio(fleet.eff)} />
            <StatCard icon={Activity} label="Total IOPS" value={fmtNum(fleet.iops)} />
            <StatCard icon={Timer} label="Avg Latency" value={fmtLatency(fleet.latency)} />
            <StatCard icon={AlertTriangle} label="Open Alerts" value={fleet.alerts} tone={fleet.alerts > 0 ? 'crit' : 'ok'} />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-1 rounded-lg bg-surface border border-cohesity-border p-1 overflow-x-auto">
              {arrays.map((a) => {
                const active = a.id === selectedId;
                return (
                  <button key={a.id} onClick={() => setSelectedId(a.id)}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-[12px] font-medium whitespace-nowrap transition-colors ${active ? 'bg-surface-overlay text-ink shadow-panel' : 'text-ink-muted hover:text-ink'}`}>
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: a.latest ? BRAND : '#6b7280' }} />{a.name}
                  </button>
                );
              })}
            </div>
            <div className="flex gap-1">
              {RANGES.map(({ label, days: d }) => (
                <button key={d} onClick={() => setDays(d)}
                  className={`text-xs px-2.5 py-1.5 rounded border transition-colors ${days === d ? 'text-white border-transparent' : 'border-cohesity-border text-ink-muted hover:text-ink'}`}
                  style={days === d ? { backgroundColor: BRAND } : undefined}>{label}</button>
              ))}
            </div>
          </div>

          <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
            <div className="flex items-center gap-2 mb-3"><TrendingUp size={16} style={{ color: BRAND }} /><p className="text-sm font-semibold text-ink">Capacity Forecast — {selected?.name || '—'}</p></div>
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
                <p className="text-[11px] text-ink-faint mt-2">Linear projection from {forecast.points} sample(s) over {forecast.spanDays.toFixed(1)} day(s).{forecast.spanDays < 3 && ' Low confidence — improves as more data is collected.'}</p>
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
              {chartCard('Capacity (TB)', (
                <TrendChart
                  labels={series.map((s) => s.time)}
                  datasets={[
                    { label: 'Total', data: series.map((s) => s.totalTB), color: '#6b7280' },
                    { label: 'Used', data: series.map((s) => s.usedTB), color: BRAND, fill: true },
                  ]}
                  unit=" TB"
                />
              ))}
              {chartCard('Storage Efficiency (x : 1)', (
                <TrendChart
                  labels={series.map((s) => s.time)}
                  datasets={[{ label: 'Efficiency', data: series.map((s) => s.eff), color: BRAND }]}
                  unit=" : 1"
                />
              ))}
              {chartCard('IOPS', (
                <TrendChart
                  labels={series.map((s) => s.time)}
                  datasets={[
                    { label: 'Read', data: series.map((s) => s.readIops), color: READ_COLOR },
                    { label: 'Write', data: series.map((s) => s.writeIops), color: WRITE_COLOR },
                  ]}
                  format={(v) => fmtNum(v)}
                  unit=" IOPS"
                />
              ))}
              {chartCard('Latency (ms)', (
                <TrendChart
                  labels={series.map((s) => s.time)}
                  datasets={[
                    { label: 'Read', data: series.map((s) => s.readMs), color: READ_COLOR },
                    { label: 'Write', data: series.map((s) => s.writeMs), color: WRITE_COLOR },
                  ]}
                  unit=" ms"
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
