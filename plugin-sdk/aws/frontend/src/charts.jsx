// AWS plugin chart kit — renders via the host's Chart.js instance
// (window.Chart, injected by esbuild define; see plugin-sdk/build.mjs).
// Ported verbatim from plugin-sdk/dell/frontend/src/charts.jsx — pages
// build the same chart.js `data`/`options` shapes the built-in AWS pages
// already build for react-chartjs-2. Dark theme defaults are deep-merged
// underneath whatever options a page supplies. TrendChart added as a
// direct port of frontend/src/components/TrendChart.jsx (used by
// AwsRdsPage/AwsS3Page's growth-history modals) since that host component
// isn't importable in a plugin sandbox.

const GRID = '#1F2B37';
const TICK = '#64748B';
const TOOLTIP_BG = '#1E2A36';
const TOOLTIP_BORDER = '#2A3845';
const INK = '#E8EDF2';
const INK_MUTED = '#94A3B3';

const DEFAULT_OPTIONS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  plugins: {
    legend: { labels: { color: INK_MUTED, boxWidth: 10, boxHeight: 10, font: { size: 11 } } },
    tooltip: {
      backgroundColor: TOOLTIP_BG, borderColor: TOOLTIP_BORDER, borderWidth: 1,
      titleColor: INK, bodyColor: INK_MUTED, padding: 10,
    },
  },
  scales: {
    x: { ticks: { color: TICK, maxTicksLimit: 10, font: { size: 10 } }, grid: { color: GRID } },
    y: { ticks: { color: TICK, font: { size: 10 } }, grid: { color: GRID } },
  },
};

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, over) {
  if (!over) return base;
  const out = { ...base };
  for (const k of Object.keys(over)) {
    if (isPlainObject(over[k]) && isPlainObject(base[k])) out[k] = deepMerge(base[k], over[k]);
    else out[k] = over[k];
  }
  return out;
}

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

export function LineChart({ data, options, height = 200 }) {
  const opts = React.useMemo(() => deepMerge(DEFAULT_OPTIONS, options), [options]);
  const canvasRef = useChartJs('line', data, opts);
  return (
    <div style={{ width: '100%', height, minWidth: 0 }}>
      <canvas ref={canvasRef} />
    </div>
  );
}

export function BarChart({ data, options, height = 200 }) {
  const opts = React.useMemo(() => deepMerge(DEFAULT_OPTIONS, options), [options]);
  const canvasRef = useChartJs('bar', data, opts);
  return (
    <div style={{ width: '100%', height, minWidth: 0 }}>
      <canvas ref={canvasRef} />
    </div>
  );
}

/* ── TrendChart — direct port of frontend/src/components/TrendChart.jsx.
 * Themed multi-series line chart used by RDS/S3 per-resource growth
 * history modals. `format` mirrors the host's optional value formatter
 * (axis + tooltip); `roundTick` mirrors its default. ─────────────────── */
const roundTick = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return `${v}`;
  return `${parseFloat(n.toFixed(Math.abs(n) < 1 ? 2 : 1))}`;
};

export function TrendChart({ labels, datasets, unit = '', height = 200, format, stacked = false }) {
  const fmt = format || roundTick;

  const data = React.useMemo(() => ({
    labels,
    datasets: datasets.map((d) => ({
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
        titleColor: INK, bodyColor: INK_MUTED, padding: 10,
        callbacks: { label: (item) => `${item.dataset.label}: ${fmt(item.parsed.y)}${unit}` },
      },
    },
    scales: {
      x: { stacked, ticks: { color: TICK, font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 }, grid: { color: GRID } },
      y: { stacked, ticks: { color: TICK, font: { size: 10 }, callback: (v) => fmt(v) }, grid: { color: GRID }, beginAtZero: false },
    },
  }), [unit, fmt, stacked]);

  const canvasRef = useChartJs('line', data, options);
  return (
    <div style={{ width: '100%', height, minWidth: 0 }}>
      <canvas ref={canvasRef} />
    </div>
  );
}
