// Nutanix plugin chart kit — renders via the host's Chart.js instance
// (window.Chart, injected by esbuild define; see plugin-sdk/build.mjs).
// Mirrors plugin-sdk/rubrik/frontend/src/charts.jsx's useChartJs mount
// pattern. Only LineChart is needed for the Nutanix Overview 30-day
// storage / IOPS-latency trend charts (the latter needs a secondary
// right-hand axis, which this adds via `axis: 'y1'` on a series entry).

const GRID = '#1F2B37';
const TICK = '#64748B';
const TOOLTIP_BG = '#1E2A36';
const TOOLTIP_BORDER = '#2A3845';
const INK = '#E8EDF2';
const INK_MUTED = '#94A3B3';
const BRAND = '#7855FA';
const WARN = '#D4A24E';
const CRIT = '#F87171';

function useChartJs(type, data, options) {
  const canvasRef = React.useRef(null);
  const chartRef = React.useRef(null);

  React.useEffect(() => {
    if (!window.Chart || !canvasRef.current) return undefined;
    chartRef.current = new window.Chart(canvasRef.current, { type, data, options });
    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  React.useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.data = data;
    chart.options = options;
    chart.update('none');
  }, [data, options]);

  return canvasRef;
}

/* ── LineChart ───────────────────────────────────────────────────────── */
// series: [{label, color, points:[{x,y}], dashed?, axis?: 'y'|'y1', fill?}]
// dualAxis: enable a secondary right-hand scale for series with axis:'y1'.
export function LineChart({ series = [], width = 640, height = 220, yUnit, y1Unit, dualAxis = false, tooltip = true }) {
  const maxN = Math.max(1, ...series.map((s) => (s.points || []).length));
  const labels = React.useMemo(() => Array.from({ length: maxN }, (_, i) => i), [maxN]);

  const data = React.useMemo(() => ({
    labels,
    datasets: series.map((s) => ({
      label: s.label,
      data: (s.points || []).map((p) => (p == null || p.y == null ? null : p.y)),
      borderColor: s.color || BRAND,
      backgroundColor: s.fill ? (s.color || BRAND) + '2e' : (s.color || BRAND),
      borderDash: s.dashed ? [5, 4] : undefined,
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 3,
      fill: !!s.fill,
      tension: 0.25,
      yAxisID: s.axis === 'y1' ? 'y1' : 'y',
    })),
  }), [series, labels]);

  const options = React.useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: series.length > 1
        ? { labels: { color: TICK, boxWidth: 10, boxHeight: 10, font: { size: 11 }, usePointStyle: true } }
        : { display: false },
      tooltip: tooltip ? {
        backgroundColor: TOOLTIP_BG, borderColor: TOOLTIP_BORDER, borderWidth: 1,
        titleColor: INK, bodyColor: INK_MUTED, padding: 10,
        callbacks: {
          label: (item) => {
            const unit = item.dataset.yAxisID === 'y1' ? y1Unit : yUnit;
            return `${item.dataset.label}: ${unit ? unit(item.parsed.y) : item.parsed.y}`;
          },
        },
      } : { enabled: false },
    },
    scales: {
      x: { display: false, grid: { display: false } },
      y: {
        position: 'left',
        ticks: { color: TICK, font: { size: 9 }, callback: (v) => (yUnit ? yUnit(v) : v) },
        grid: { color: GRID },
      },
      ...(dualAxis ? {
        y1: {
          position: 'right',
          ticks: { color: TICK, font: { size: 9 }, callback: (v) => (y1Unit ? y1Unit(v) : v) },
          grid: { drawOnChartArea: false },
        },
      } : {}),
    },
  }), [series.length, tooltip, yUnit, y1Unit, dualAxis]);

  const canvasRef = useChartJs('line', data, options);
  return (
    <div style={{ width: '100%', height, minWidth: 0 }}>
      <canvas ref={canvasRef} />
    </div>
  );
}
