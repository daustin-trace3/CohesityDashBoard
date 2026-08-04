// Proxmox VE plugin chart kit — renders via the host's Chart.js instance
// (window.Chart, registered + exposed by frontend/src/main.jsx; see
// plugin-sdk/README.md "Charts"). Same exported component names/props as
// the previous hand-rolled SVG kit so the page files need no changes.

const GRID = '#1F2B37';
const TICK = '#64748B';
const TOOLTIP_BG = '#1E2A36';
const TOOLTIP_BORDER = '#2A3845';
const INK = '#E8EDF2';
const INK_MUTED = '#94A3B3';
const BRAND = '#E57000';
const WARN = '#FBBF24';
const CRIT = '#F87171';

/* ── shared Chart.js mount/update hook ──────────────────────────────────
 * Creates a chart instance once (per `type`) against a canvas ref, then
 * pushes data/options updates into the live instance rather than
 * recreating it. Degrades to a no-op (never throws) if window.Chart is
 * unavailable — the canvas just renders empty. `pluginsList` (optional) is
 * only read at creation time; components that need dynamic content inside
 * a plugin (e.g. Donut's center label) read from a ref so it stays live
 * without needing to recreate the chart. */
function useChartJs(type, data, options, pluginsList) {
  const canvasRef = React.useRef(null);
  const chartRef = React.useRef(null);

  React.useEffect(() => {
    if (!window.Chart || !canvasRef.current) return undefined;
    chartRef.current = new window.Chart(canvasRef.current, {
      type,
      data,
      options,
      plugins: pluginsList,
    });
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

function useCenterTextPlugin(stateRef) {
  return React.useMemo(() => ({
    id: 'centerText',
    afterDraw(chart) {
      const { ctx, chartArea } = chart;
      if (!chartArea) return;
      const { centerLabel, centerSub, size } = stateRef.current;
      const cx = (chartArea.left + chartArea.right) / 2;
      const cy = (chartArea.top + chartArea.bottom) / 2;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (centerLabel != null && centerLabel !== '') {
        ctx.fillStyle = INK;
        ctx.font = `700 ${size < 50 ? 10 : 14}px sans-serif`;
        ctx.fillText(String(centerLabel), cx, centerSub ? cy - 7 : cy);
      }
      if (centerSub) {
        ctx.fillStyle = INK_MUTED;
        ctx.font = '400 9px sans-serif';
        ctx.fillText(String(centerSub), cx, cy + 9);
      }
      ctx.restore();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);
}

/* ── LineChart ───────────────────────────────────────────────────────── */
// series: [{label,color,points:[{x,y}],dashed?}]; refLines:[{y,color,dash}]
export function LineChart({ series = [], refLines = [], width = 640, height = 220, yFmt, tooltip = true }) {
  const maxN = Math.max(1, ...series.map((s) => (s.points || []).length));
  const labels = React.useMemo(() => Array.from({ length: maxN }, (_, i) => i), [maxN]);

  const data = React.useMemo(() => ({
    labels,
    datasets: [
      ...series.map((s) => ({
        label: s.label,
        data: (s.points || []).map((p) => (p == null || p.y == null ? null : p.y)),
        borderColor: s.color || BRAND,
        backgroundColor: s.color || BRAND,
        borderDash: s.dashed ? [5, 4] : undefined,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 3,
        spanGaps: false,
        tension: 0.15,
      })),
      ...refLines.map((r, i) => ({
        label: `__refline_${i}`,
        data: labels.map(() => r.y),
        borderColor: r.color || CRIT,
        borderDash: (r.dash || '2 3').split(' ').map(Number),
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 0,
        fill: false,
      })),
    ],
  }), [series, refLines, labels]);

  const options = React.useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: series.length > 1
        ? { labels: { color: TICK, boxWidth: 10, boxHeight: 10, font: { size: 11 }, usePointStyle: true, filter: (item) => !item.text.startsWith('__refline_') } }
        : { display: false },
      tooltip: tooltip ? {
        backgroundColor: TOOLTIP_BG, borderColor: TOOLTIP_BORDER, borderWidth: 1,
        titleColor: INK, bodyColor: INK_MUTED, padding: 10,
        filter: (item) => !(item.dataset.label || '').startsWith('__refline_'),
        callbacks: { label: (item) => `${item.dataset.label}: ${yFmt ? yFmt(item.parsed.y) : item.parsed.y}` },
      } : { enabled: false },
    },
    scales: {
      x: { display: false, grid: { display: false } },
      y: {
        ticks: { color: TICK, font: { size: 9 }, callback: (v) => (yFmt ? yFmt(v) : v) },
        grid: { color: GRID },
        beginAtZero: false,
      },
    },
  }), [series.length, tooltip, yFmt]);

  const canvasRef = useChartJs('line', data, options);
  return (
    <div style={{ width: '100%', height, minWidth: 0 }}>
      <canvas ref={canvasRef} />
    </div>
  );
}

/* ── SparkLine ───────────────────────────────────────────────────────── */
export function SparkLine({ points = [], color = BRAND, width = 100, height = 24 }) {
  const data = React.useMemo(() => ({
    labels: points.map((_, i) => i),
    datasets: [{ data: points, borderColor: color, borderWidth: 1.5, pointRadius: 0, tension: 0.3, fill: false }],
  }), [points, color]);

  const options = React.useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: { x: { display: false }, y: { display: false } },
  }), []);

  const canvasRef = useChartJs('line', data, options);
  return (
    <div style={{ width, height }}>
      <canvas ref={canvasRef} />
    </div>
  );
}

/* ── Donut ───────────────────────────────────────────────────────────── */
export function Donut({ pct, size = 74, stroke = 9, thresholds, centerLabel, centerSub }) {
  const clamped = Math.max(0, Math.min(100, pct || 0));
  let color = BRAND;
  if (thresholds) {
    if ((pct || 0) >= (thresholds.crit ?? 95)) color = CRIT;
    else if ((pct || 0) >= (thresholds.warn ?? 85)) color = WARN;
  }
  const resolvedCenterLabel = centerLabel != null ? centerLabel : `${Math.round(pct || 0)}%`;

  const stateRef = React.useRef({});
  stateRef.current = { centerLabel: resolvedCenterLabel, centerSub, size };
  const centerTextPlugin = useCenterTextPlugin(stateRef);

  const data = React.useMemo(() => ({
    labels: ['value', 'rest'],
    datasets: [{ data: [clamped, 100 - clamped], backgroundColor: [color, GRID], borderWidth: 0 }],
  }), [clamped, color]);

  const options = React.useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    cutout: `${Math.max(0, Math.round(((size - stroke * 2) / size) * 100))}%`,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
  }), [size, stroke]);

  const canvasRef = useChartJs('doughnut', data, options, [centerTextPlugin]);
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <canvas ref={canvasRef} />
    </div>
  );
}

/* ── HBar ────────────────────────────────────────────────────────────── */
export function HBar({ rows = [], max, unit, width = 460, height, labelWidth = 90, truncate = 14 }) {
  const labels = React.useMemo(
    () => rows.map((r) => (r.label.length > truncate ? `${r.label.slice(0, truncate - 1)}…` : r.label)),
    [rows, truncate],
  );

  const data = React.useMemo(() => ({
    labels,
    datasets: [{
      data: rows.map((r) => r.value),
      backgroundColor: rows.map((r) => r.color || BRAND),
      borderRadius: 3,
      barThickness: 14,
    }],
  }), [rows, labels]);

  const options = React.useMemo(() => ({
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: TOOLTIP_BG, borderColor: TOOLTIP_BORDER, borderWidth: 1,
        titleColor: INK, bodyColor: INK_MUTED, padding: 10,
        callbacks: {
          title: (items) => rows[items[0]?.dataIndex]?.label ?? '',
          label: (item) => (unit ? `${item.parsed.x}${unit}` : `${item.parsed.x}`),
        },
      },
    },
    scales: {
      x: { min: 0, max, ticks: { color: TICK, font: { size: 10 }, callback: (v) => (unit ? `${v}${unit}` : v) }, grid: { color: GRID } },
      y: { ticks: { color: INK_MUTED, font: { size: 11 } }, grid: { display: false } },
    },
  }), [rows, unit, max]);

  const h = height || rows.length * 26 + 20;
  const canvasRef = useChartJs('bar', data, options);
  return (
    <div style={{ width: '100%', height: h }}>
      <canvas ref={canvasRef} />
    </div>
  );
}
