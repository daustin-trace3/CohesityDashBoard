// Pure plugin chart kit — renders via the host's Chart.js instance
// (window.Chart, injected by esbuild define; see plugin-sdk/build.mjs).
// TrendChart mirrors frontend/src/components/TrendChart.jsx's API exactly
// (labels, datasets:[{label,data,color,fill?}], unit, height, format,
// stacked) since every built-in Pure page composes charts through it.

const GRID = '#1F2B37';
const TICK = '#64748B';
const TOOLTIP_BG = '#1E2A36';
const TOOLTIP_BORDER = '#2A3845';
const TITLE_COLOR = '#E8EDF2';
const BODY_COLOR = '#94A3B3';

const roundTick = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return `${v}`;
  return `${parseFloat(n.toFixed(Math.abs(n) < 1 ? 2 : 1))}`;
};

export function TrendChart({ labels, datasets, unit = '', height = 200, format, stacked = false }) {
  const fmt = format || roundTick;
  const canvasRef = React.useRef(null);
  const chartRef = React.useRef(null);

  const data = React.useMemo(() => ({
    labels,
    datasets: (datasets || []).map((d) => ({
      label: d.label,
      data: d.data,
      borderColor: d.color,
      backgroundColor: d.fill ? `${d.color}22` : d.color,
      fill: !!d.fill,
      tension: 0.25,
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 3,
    })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [labels, datasets]);

  const options = React.useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: TICK, boxWidth: 10, boxHeight: 10, font: { size: 11 }, usePointStyle: true } },
      tooltip: {
        backgroundColor: TOOLTIP_BG, borderColor: TOOLTIP_BORDER, borderWidth: 1,
        titleColor: TITLE_COLOR, bodyColor: BODY_COLOR, padding: 10,
        callbacks: { label: (item) => `${item.dataset.label}: ${fmt(item.parsed.y)}${unit}` },
      },
    },
    scales: {
      x: { stacked, ticks: { color: TICK, font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 }, grid: { color: GRID } },
      y: { stacked, ticks: { color: TICK, font: { size: 10 }, callback: (v) => fmt(v) }, grid: { color: GRID }, beginAtZero: false },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [unit, fmt, stacked]);

  React.useEffect(() => {
    if (!window.Chart || !canvasRef.current) return undefined;
    chartRef.current = new window.Chart(canvasRef.current, { type: 'line', data, options });
    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.data = data;
    chart.options = options;
    chart.update('none');
  }, [data, options]);

  return (
    <div style={{ height }}>
      <canvas ref={canvasRef} />
    </div>
  );
}
