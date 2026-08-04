// Rubrik plugin chart kit — renders via the host's Chart.js instance
// (window.Chart, registered + exposed by frontend/src/main.jsx; see
// plugin-sdk/README.md "Charts"). Same exported component names/props as
// the previous hand-rolled SVG kit so the page files need no changes.
//
// BubbleMatrix (a calendar-style status grid) and MeshDiagram (an animated
// node/flow topology graph) stay hand-rolled SVG below — they're diagrams,
// not chart types Chart.js models (no axes/series), so there's no faithful
// Chart.js equivalent for their per-cell status coloring / animated edges.

const GRID = '#1F2B37';
const TICK = '#64748B';
const TOOLTIP_BG = '#1E2A36';
const TOOLTIP_BORDER = '#2A3845';
const INK = '#E8EDF2';
const INK_MUTED = '#94A3B3';
const BRAND = '#00B388';
const WARN = '#FBBF24';
const CRIT = '#F87171';

const fmtTick = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(v % 1e6 ? 1 : 0)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(v % 1e3 ? 1 : 0)}k` : `${v}`);

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

/* ── Donut ───────────────────────────────────────────────────────────── */
// pct: single-value mode. segments: [{value,color,label}] multi-segment mode.
export function Donut({ pct, segments, size = 74, stroke = 9, colors, thresholds, centerLabel, centerSub, notSet }) {
  let sliceValues;
  let sliceColors;
  let resolvedCenterLabel;

  if (notSet) {
    sliceValues = [100];
    sliceColors = [GRID];
    resolvedCenterLabel = centerLabel != null ? centerLabel : 'n/a';
  } else if (segments && segments.length) {
    sliceValues = segments.map((s) => s.value);
    sliceColors = segments.map((s) => s.color);
    resolvedCenterLabel = centerLabel;
  } else {
    const clamped = Math.max(0, Math.min(100, pct || 0));
    const over = (pct || 0) > 100;
    let color = colors && colors.default ? colors.default : BRAND;
    if (thresholds) {
      if ((pct || 0) >= (thresholds.crit ?? 86)) color = CRIT;
      else if ((pct || 0) >= (thresholds.warn ?? 70)) color = WARN;
    }
    if (over) color = CRIT;
    sliceValues = [clamped, 100 - clamped];
    sliceColors = [color, GRID];
    resolvedCenterLabel = centerLabel != null ? centerLabel : pct != null ? `${pct > 100 ? 'Over' : Math.round(pct)}${pct > 100 ? '' : '%'}` : '';
  }

  const stateRef = React.useRef({});
  stateRef.current = { centerLabel: resolvedCenterLabel, centerSub, size };
  const centerTextPlugin = useCenterTextPlugin(stateRef);

  const data = React.useMemo(() => ({
    labels: sliceValues.map((_, i) => `s${i}`),
    datasets: [{ data: sliceValues, backgroundColor: sliceColors, borderWidth: 0 }],
  }), [sliceValues, sliceColors]);

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
      x: { min: 0, max, ticks: { color: TICK, font: { size: 10 }, callback: (v) => (unit ? `${fmtTick(v)}${unit}` : fmtTick(v)) }, grid: { color: GRID } },
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

/* ── StackedHBar ─────────────────────────────────────────────────────── */
// rows: [{label, values:{seriesKey: number}}]; series: [{key,color,label}]
export function StackedHBar({ rows = [], series = [], width = 460, labelWidth = 90, truncate = 14 }) {
  const labels = React.useMemo(
    () => rows.map((r) => (r.label.length > truncate ? `${r.label.slice(0, truncate - 1)}…` : r.label)),
    [rows, truncate],
  );

  const data = React.useMemo(() => ({
    labels,
    datasets: series.map((sr) => ({
      label: sr.label,
      data: rows.map((r) => r.values[sr.key] || 0),
      backgroundColor: sr.color,
      stack: 'stack1',
    })),
  }), [rows, labels, series]);

  const options = React.useMemo(() => ({
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: { labels: { color: TICK, boxWidth: 10, boxHeight: 10, font: { size: 10 }, usePointStyle: true } },
      tooltip: {
        backgroundColor: TOOLTIP_BG, borderColor: TOOLTIP_BORDER, borderWidth: 1,
        titleColor: INK, bodyColor: INK_MUTED, padding: 10,
        callbacks: { title: (items) => rows[items[0]?.dataIndex]?.label ?? '', label: (item) => `${item.dataset.label}: ${fmtTick(item.parsed.x)}` },
      },
    },
    scales: {
      x: { stacked: true, ticks: { color: TICK, font: { size: 10 }, callback: (v) => fmtTick(v) }, grid: { color: GRID } },
      y: { stacked: true, ticks: { color: INK_MUTED, font: { size: 11 } }, grid: { display: false } },
    },
  }), [rows, series]);

  const h = rows.length * 26 + 20;
  const canvasRef = useChartJs('bar', data, options);
  return (
    <div style={{ width: '100%', height: h }}>
      <canvas ref={canvasRef} />
    </div>
  );
}

/* ── StackedVBar ─────────────────────────────────────────────────────── */
// days: [{day, values:{seriesKey:number}}]; series: [{key,color,label}]
export function StackedVBar({ days = [], series = [], colors, width = 480, height = 160 }) {
  const labels = React.useMemo(() => days.map((d) => String(d.day).slice(5)), [days]);

  const data = React.useMemo(() => ({
    labels,
    datasets: series.map((sr) => ({
      label: sr.label,
      data: days.map((d) => d.values[sr.key] || 0),
      backgroundColor: (colors && colors[sr.key]) || sr.color,
      stack: 'stack1',
    })),
  }), [days, labels, series, colors]);

  const options = React.useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: { labels: { color: TICK, boxWidth: 10, boxHeight: 10, font: { size: 10 }, usePointStyle: true } },
      tooltip: {
        backgroundColor: TOOLTIP_BG, borderColor: TOOLTIP_BORDER, borderWidth: 1,
        titleColor: INK, bodyColor: INK_MUTED, padding: 10,
        callbacks: { title: (items) => days[items[0]?.dataIndex]?.day ?? '', label: (item) => `${item.dataset.label}: ${fmtTick(item.parsed.y)}` },
      },
    },
    scales: {
      x: { stacked: true, ticks: { color: TICK, font: { size: 9 }, maxRotation: 0, autoSkip: true }, grid: { display: false } },
      y: { stacked: true, ticks: { color: TICK, font: { size: 9 }, callback: (v) => fmtTick(v) }, grid: { color: GRID } },
    },
  }), [days, series]);

  const canvasRef = useChartJs('bar', data, options);
  return (
    <div style={{ width: '100%', height }}>
      <canvas ref={canvasRef} />
    </div>
  );
}

/* ── LineChart ───────────────────────────────────────────────────────── */
// series: [{label,color,points:[{x,y}],dashed?}]; refLines:[{y,color,dash}]
export function LineChart({ series = [], refLines = [], width = 640, height = 220, yUnit, tooltip = true }) {
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
        callbacks: { label: (item) => `${item.dataset.label}: ${yUnit ? yUnit(item.parsed.y) : item.parsed.y}` },
      } : { enabled: false },
    },
    scales: {
      x: { display: false, grid: { display: false } },
      y: {
        ticks: { color: TICK, font: { size: 9 }, callback: (v) => (yUnit ? yUnit(v) : v) },
        grid: { color: GRID },
        beginAtZero: false,
      },
    },
  }), [series.length, tooltip, yUnit]);

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

/* ── BubbleMatrix ────────────────────────────────────────────────────── */
// rows: [{name, days:[{day,status}]}]; status: ok|warn|crit|info-pulse|none
// Kept as hand-rolled SVG — a per-cell status grid with click targets and
// pulsing "in progress" cells isn't a Chart.js chart type.
const BUBBLE_COLORS = { ok: BRAND, warn: WARN, crit: CRIT, 'info-pulse': '#60A5FA', missed: CRIT, none: '#2A3845' };

export function BubbleMatrix({ rows = [], cellSize = 16, gap = 3, labelWidth = 180, onCellClick }) {
  const dayCount = rows.length > 0 ? rows[0].days.length : 0;
  const width = labelWidth + dayCount * (cellSize + gap);
  const height = rows.length * (cellSize + gap);
  return (
    <div className="rbk-scroll" style={{ overflowX: 'auto' }}>
      <svg width={width} height={height}>
        {rows.map((r, ri) => (
          <g key={r.name} transform={`translate(0, ${ri * (cellSize + gap)})`}>
            <text x={0} y={cellSize - 4} fontSize={11} fill={INK} style={{ position: 'sticky' }}>
              {r.name.length > 26 ? `${r.name.slice(0, 24)}…` : r.name}
            </text>
            {r.days.map((d, di) => (
              <rect
                key={di}
                x={labelWidth + di * (cellSize + gap)}
                y={1}
                width={cellSize - 2}
                height={cellSize - 2}
                rx={3}
                fill={BUBBLE_COLORS[d.status] || BUBBLE_COLORS.none}
                style={{ cursor: onCellClick ? 'pointer' : 'default', animation: d.status === 'info-pulse' ? 'rbk-orb-pulse 2s ease-in-out infinite' : undefined }}
                onClick={onCellClick ? () => onCellClick(r, d) : undefined}
              >
                <title>{`${d.day}: ${d.status}`}</title>
              </rect>
            ))}
          </g>
        ))}
      </svg>
    </div>
  );
}

/* ── MeshDiagram ─────────────────────────────────────────────────────── */
// nodes: [name,...] (derived from flows if omitted); flows: [{source,target,
// runCount,failureCount,totalBytesTransferred,avgLagSeconds,longRunningCount,lastSeen}]
// Kept as hand-rolled SVG — an animated node/flow topology graph with
// circular layout and moving particles isn't a Chart.js chart type.
export function MeshDiagram({ nodes: nodesProp, flows = [], onNodeClick, filters }) {
  const [hovered, setHovered] = React.useState(null);
  const [selected, setSelected] = React.useState(null);

  const { nodes, nodePos, maxBytes, animDurations } = React.useMemo(() => {
    const nameSet = new Set(nodesProp || []);
    flows.forEach((f) => {
      nameSet.add(f.source);
      nameSet.add(f.target);
    });
    const nodes = [...nameSet];
    const nodePos = {};
    nodes.forEach((name, i) => {
      const angle = (2 * Math.PI * i) / Math.max(1, nodes.length) - Math.PI / 2;
      nodePos[name] = { x: 250 + 215 * Math.cos(angle), y: 255 + 220 * Math.sin(angle) };
    });
    const maxBytes = Math.max(...flows.map((f) => f.totalBytesTransferred || 0), 1);
    const animDurations = flows.map(() => 2 + Math.random() * 2);
    return { nodes, nodePos, maxBytes, animDurations };
  }, [nodesProp, flows]);

  const isSourceNode = (name) => flows.some((f) => f.source === name);

  return (
    <svg width="100%" height="520" viewBox="0 0 500 520">
      {flows.map((f, i) => {
        const src = nodePos[f.source];
        const tgt = nodePos[f.target];
        if (!src || !tgt) return null;
        const isLongRunning = (f.longRunningCount || 0) > 0;
        const failPct = f.runCount > 0 ? f.failureCount / f.runCount : 0;
        const color = isLongRunning ? WARN : f.failureCount === 0 ? BRAND : failPct < 0.2 ? WARN : CRIT;
        const strokeWidth = Math.max(1, Math.min(5, ((f.totalBytesTransferred || 0) / maxBytes) * 5));
        const midX = (src.x + tgt.x) / 2;
        const midY = (src.y + tgt.y) / 2;
        const dur = animDurations[i];
        return (
          <g key={i}>
            <line x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y} stroke={color} strokeWidth={strokeWidth} strokeDasharray={isLongRunning ? '6 4' : undefined} opacity={0.5} />
            <line
              x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y}
              stroke={color}
              strokeWidth={Math.max(20, strokeWidth + 14)}
              strokeOpacity={0.01}
              strokeLinecap="round"
              pointerEvents="stroke"
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => setHovered(f)}
              onMouseLeave={() => setHovered(null)}
              onMouseMove={() => setHovered(f)}
            />
            <text x={midX} y={midY - 8} fontSize={8} fill={INK} textAnchor="middle" opacity={0.9} style={{ pointerEvents: 'none', fontWeight: 500 }}>
              {f.source}↔{f.target}
            </text>
            <circle r={3} fill={color} opacity={0.9} style={{ pointerEvents: 'none' }}>
              <animateMotion dur={`${dur}s`} repeatCount="indefinite" path={`M ${src.x} ${src.y} L ${tgt.x} ${tgt.y}`} />
            </circle>
            <circle r={3} fill={color} opacity={0.9} style={{ pointerEvents: 'none' }}>
              <animateMotion dur={`${dur}s`} repeatCount="indefinite" begin={`${dur / 2}s`} path={`M ${tgt.x} ${tgt.y} L ${src.x} ${src.y}`} />
            </circle>
          </g>
        );
      })}
      {nodes.map((name) => {
        const pos = nodePos[name];
        const isSource = isSourceNode(name);
        const isSelected = selected === name;
        return (
          <g
            key={name}
            style={{ cursor: 'pointer' }}
            onClick={() => {
              const next = isSelected ? null : name;
              setSelected(next);
              if (onNodeClick) onNodeClick(next);
            }}
          >
            <circle cx={pos.x} cy={pos.y} r={18} fill="#2C2C2C" stroke={isSelected ? '#E5E5E5' : isSource ? BRAND : '#3b82f6'} strokeWidth={isSelected ? 2.5 : 1.5} />
            <text x={pos.x} y={pos.y + 4} fontSize={9} fill={INK} textAnchor="middle" dominantBaseline="middle">
              {isSource ? '▶' : '●'}
            </text>
            <text x={pos.x} y={pos.y + 28} fontSize={9} fill={INK_MUTED} textAnchor="middle">
              {name.length > 12 ? name.slice(0, 12) : name}
            </text>
          </g>
        );
      })}
      {hovered && (
        <g>
          <rect x={150} y={120} width={200} height={85} rx={6} fill="#1A1A1A" stroke={TOOLTIP_BORDER} />
          <text x={160} y={138} fontSize={10} fill={INK}>{hovered.source} → {hovered.target}</text>
          <text x={160} y={152} fontSize={10} fill={INK_MUTED}>Runs: {hovered.runCount} | Bytes: {fmtBytesLocal(hovered.totalBytesTransferred)}</text>
          <text x={160} y={166} fontSize={10} fill={INK_MUTED}>Avg Lag: {fmtLagLocal(hovered.avgLagSeconds)}</text>
          {hovered.longRunningCount > 0 && (
            <text x={160} y={180} fontSize={10} fill={WARN}>Long-running: {hovered.longRunningCount}</text>
          )}
        </g>
      )}
    </svg>
  );
}

function fmtBytesLocal(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function fmtLagLocal(seconds) {
  if (!seconds) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}
