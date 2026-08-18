// NetApp plugin chart kit — renders via the host's Chart.js instance
// (window.Chart, injected by esbuild define; see plugin-sdk/build.mjs).
// Ported verbatim from plugin-sdk/unifi/frontend/src/charts.jsx — pages
// build the same chart.js `data`/`options` shapes the built-in NetApp pages
// already build for react-chartjs-2. Dark theme defaults are deep-merged
// underneath whatever options a page supplies. DoughnutChart added for
// NetAppOverviewPage's device-health donut.

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

// Doughnut/pie charts have no cartesian scales — merging DEFAULT_OPTIONS'
// `scales` block onto them would be inert but harmless; omit it anyway.
const NO_SCALE_OPTIONS = {
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

export function DoughnutChart({ data, options, height = 200 }) {
  const opts = React.useMemo(() => deepMerge(NO_SCALE_OPTIONS, options), [options]);
  const canvasRef = useChartJs('doughnut', data, opts);
  return (
    <div style={{ width: '100%', height, minWidth: 0 }}>
      <canvas ref={canvasRef} />
    </div>
  );
}
