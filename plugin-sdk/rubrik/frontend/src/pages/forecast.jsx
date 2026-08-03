import { ACCENT, AMBER, RED, PANEL_BG, BORDER, TEXT, MUTED, panelStyle, LineArea, useFetch, PageShell, formatBytes } from './_shared';

export default function ForecastPage() {
  const { data, error } = useFetch('/capacity');
  const clusters = (data && data.clusters) || [];
  const [selected, setSelected] = React.useState(null);
  const active = clusters.find((c) => c.cluster === selected) || clusters[0];

  return (
    <PageShell title="Rubrik Capacity Forecast" error={error}>
      {clusters.length > 0 && (
        <>
          <div style={{ marginBottom: 12, display: 'flex', gap: 8 }}>
            {clusters.map((c) => (
              <button
                key={c.cluster}
                onClick={() => setSelected(c.cluster)}
                style={{
                  padding: '6px 12px',
                  fontSize: 12,
                  borderRadius: 6,
                  cursor: 'pointer',
                  border: `1px solid ${(active && active.cluster) === c.cluster ? ACCENT : BORDER}`,
                  background: (active && active.cluster) === c.cluster ? `${ACCENT}26` : PANEL_BG,
                  color: (active && active.cluster) === c.cluster ? ACCENT : TEXT,
                }}
              >
                {c.cluster}
              </button>
            ))}
          </div>
          {active && (
            <div style={panelStyle()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: TEXT }}>{active.cluster}</div>
                <div style={{ fontSize: 13, color: active.runwayDays <= 60 ? RED : AMBER }}>
                  reaches capacity in ~{active.runwayDays} days
                </div>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <LineArea
                  history={active.series.map((s) => ({ x: s.day, value: s.usedBytes }))}
                  forecast={active.forecast.map((f) => ({ x: f.day, value: f.usedBytes }))}
                  capacity={active.capacityBytes}
                  width={720}
                  height={240}
                  yFormat={(v) => formatBytes(v)}
                />
              </div>
              <div style={{ display: 'flex', gap: 24, marginTop: 12, fontSize: 12, color: MUTED }}>
                <span>
                  <span style={{ display: 'inline-block', width: 18, height: 2, background: ACCENT, marginRight: 6, verticalAlign: 'middle' }} />
                  90d history
                </span>
                <span>
                  <span style={{ display: 'inline-block', width: 18, height: 2, background: AMBER, marginRight: 6, verticalAlign: 'middle', borderTop: `2px dashed ${AMBER}` }} />
                  90d forecast
                </span>
                <span>growth ≈ {formatBytes(active.growthPerDayBytes * 30)}/month</span>
              </div>
            </div>
          )}
        </>
      )}
    </PageShell>
  );
}
