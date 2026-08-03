// Rubrik v2.0.0 Capacity Forecast page — full rebuild onto the rbk- kit
// (./ui, ./charts), mirroring the host Overview trend conventions. Same
// data, same fetch (/capacity), same per-cluster history/forecast/capacity
// series — just re-plotted with charts.jsx LineChart instead of the legacy
// LineArea primitive.

import { PageHeader, StatCard, RefreshButton, LastUpdated, EmptyState, fmtBytes, TrendUpIcon } from '../ui';
import { LineChart } from '../charts';

const API_BASE = '/api/rubrik';

function apiFetch(path) {
  return fetch(`${API_BASE}${path}`, { credentials: 'include' }).then((res) => {
    if (!res.ok) throw new Error(`request failed: ${res.status}`);
    return res.json();
  });
}

function formatDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString();
}

export default function ForecastPage() {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [selected, setSelected] = React.useState(null);

  const loadCapacity = React.useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch('/capacity')
      .then((res) => { setData(res); setLastRefreshed(new Date()); })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => { loadCapacity(); }, [loadCapacity]);

  const clusters = (data && data.clusters) || [];
  const active = clusters.find((c) => c.cluster === selected) || clusters[0];

  const chart = React.useMemo(() => {
    if (!active) return null;
    const history = (active.series || []).map((s) => ({ y: s.usedBytes }));
    const forecast = (active.forecast || []).map((f) => ({ y: f.usedBytes }));
    // Forecast series is padded with nulls (LineChart skips them) so its
    // indices share history's x-domain; the last history point anchors the
    // dashed continuation so it starts exactly at the junction.
    const forecastPoints = history.slice(0, -1).map(() => null).concat([history[history.length - 1]], forecast);
    return {
      series: [
        { label: 'History', color: '#00B388', points: history },
        { label: 'Forecast', color: '#FBBF24', points: forecastPoints, dashed: true },
      ],
      refLines: [
        { y: active.capacityBytes, color: '#F87171', dash: '2 4', label: 'capacity' },
        { y: active.capacityBytes * 0.85, color: '#F59E0B', dash: '2 4', label: '85%' },
      ],
    };
  }, [active]);

  return (
    <div className="rbk-root rbk-fade-in">
      <PageHeader icon={TrendUpIcon} title="Capacity Forecast" description="Projected storage growth and time-to-capacity per cluster">
        <RefreshButton onClick={loadCapacity} refreshing={loading} />
        <LastUpdated date={lastRefreshed} prefix="Last refreshed" />
      </PageHeader>

      {error && (
        <div role="alert" style={{ background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', color: 'var(--rbk-crit)', borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 13 }}>
          {error}
        </div>
      )}

      {!loading && clusters.length === 0 ? (
        <div className="rbk-panel" style={{ padding: 16 }}>
          <EmptyState icon={TrendUpIcon} title="No capacity data found" />
        </div>
      ) : (
        <>
          <div style={{ marginBottom: 16, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {clusters.map((c) => (
              <button
                key={c.cluster}
                onClick={() => setSelected(c.cluster)}
                className={`rbk-pill${(active && active.cluster) === c.cluster ? ' rbk-pill-active' : ''}`}
              >
                {c.cluster}
              </button>
            ))}
          </div>

          {active && chart && (
            <div className="rbk-panel" style={{ padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
                <p className="rbk-panel-title" style={{ margin: 0 }}>{active.cluster}</p>
                <span style={{ fontSize: 13, fontWeight: 600, color: active.runwayDays <= 60 ? 'var(--rbk-crit)' : 'var(--rbk-warn)' }}>
                  reaches capacity in ~{active.runwayDays} days
                </span>
              </div>

              <div className="rbk-scroll" style={{ overflowX: 'auto' }}>
                <LineChart series={chart.series} refLines={chart.refLines} width={720} height={240} yUnit={fmtBytes} />
              </div>

              <div style={{ display: 'flex', gap: 24, marginTop: 12, fontSize: 12, color: 'var(--rbk-ink-muted)', flexWrap: 'wrap' }}>
                <span>
                  <span style={{ display: 'inline-block', width: 18, height: 2, background: '#00B388', marginRight: 6, verticalAlign: 'middle' }} />
                  History
                </span>
                <span>
                  <span style={{ display: 'inline-block', width: 18, height: 0, borderTop: '2px dashed #FBBF24', marginRight: 6, verticalAlign: 'middle' }} />
                  Forecast
                </span>
                <span>growth ≈ {fmtBytes(active.growthPerDayBytes * 30)}/month</span>
              </div>

              <div className="rbk-stagger" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginTop: 16 }}>
                <StatCard label="Capacity" value={fmtBytes(active.capacityBytes)} />
                <StatCard label="Used" value={fmtBytes((active.series || [])[(active.series || []).length - 1]?.usedBytes)} />
                <StatCard label="Growth / Day" value={fmtBytes(active.growthPerDayBytes)} />
                <StatCard
                  label="Days to 85%"
                  value={active.daysTo85 ?? '—'}
                  sub={active.dateTo85 ? formatDate(active.dateTo85) : undefined}
                  tone={active.daysTo85 != null && active.daysTo85 <= 60 ? 'crit' : 'warn'}
                />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
