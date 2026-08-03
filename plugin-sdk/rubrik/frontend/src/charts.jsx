// Rubrik v2.0.0 chart kit — hand-rolled inline SVG (no Chart.js: the plugin
// sandbox forbids host package imports). Styled to match the host's chart
// theming: grid #1F2B37, tick #64748B, tooltip bg #1E2A36 border #2A3845.
// Existing v1.1 chart components (Donut, Bars, LineArea, MiniBubbleGrid) and
// the AnalyticsPage ReplicationMesh are generalized here.

const GRID = '#1F2B37';
const TICK = '#64748B';
const TOOLTIP_BG = '#1E2A36';
const TOOLTIP_BORDER = '#2A3845';
const INK = '#E8EDF2';
const INK_MUTED = '#94A3B3';
const BRAND = '#00B388';
const OK = '#34D399';
const WARN = '#FBBF24';
const CRIT = '#F87171';

/* ── Donut ───────────────────────────────────────────────────────────── */
// pct: single-value mode. segments: [{value,color,label}] multi-segment mode.
export function Donut({ pct, segments, size = 74, stroke = 9, colors, thresholds, centerLabel, centerSub, notSet }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const cx = size / 2;
  const cy = size / 2;

  if (notSet) {
    return (
      <div style={{ position: 'relative', width: size, height: size }}>
        <svg width={size} height={size}>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke={GRID} strokeWidth={stroke} strokeDasharray="4 4" />
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: INK_MUTED }}>
          {centerLabel != null ? centerLabel : 'n/a'}
        </div>
      </div>
    );
  }

  let arcs = [];
  if (segments && segments.length) {
    const total = segments.reduce((s, x) => s + x.value, 0) || 1;
    let acc = 0;
    arcs = segments.map((s) => {
      const dash = (s.value / total) * c;
      const el = { dash, offset: acc, color: s.color };
      acc += dash;
      return el;
    });
  } else {
    const clamped = Math.max(0, Math.min(100, pct || 0));
    const over = (pct || 0) > 100;
    const dash = (Math.min(clamped, 100) / 100) * c;
    let color = colors && colors.default ? colors.default : BRAND;
    if (thresholds) {
      if ((pct || 0) >= (thresholds.crit ?? 86)) color = CRIT;
      else if ((pct || 0) >= (thresholds.warn ?? 70)) color = WARN;
    }
    if (over) color = CRIT;
    arcs = [{ dash, offset: 0, color }];
  }

  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={GRID} strokeWidth={stroke} />
        {arcs.map((a, i) => (
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={a.color}
            strokeWidth={stroke}
            strokeDasharray={`${a.dash} ${c - a.dash}`}
            strokeDashoffset={-a.offset}
            strokeLinecap="round"
            transform={`rotate(-90 ${cx} ${cy})`}
          />
        ))}
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontSize: size < 50 ? 10 : 14, fontWeight: 700, color: INK }}>
          {centerLabel != null ? centerLabel : pct != null ? `${(pct > 100 ? 'Over' : Math.round(pct))}${pct > 100 ? '' : '%'}` : ''}
        </div>
        {centerSub && <div style={{ fontSize: 9, color: INK_MUTED }}>{centerSub}</div>}
      </div>
    </div>
  );
}

/* ── axis helpers ────────────────────────────────────────────────────── */
// "Nice" tick step so gridlines land on round numbers (1/2/5 × 10^n).
function niceStep(rough) {
  if (!(rough > 0)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const frac = rough / pow;
  return (frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10) * pow;
}
function niceTicks(max, count = 4) {
  const step = niceStep(max / count);
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return { ticks, top: ticks[ticks.length - 1] };
}
const fmtTick = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(v % 1e6 ? 1 : 0)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(v % 1e3 ? 1 : 0)}k` : `${v}`);

/* ── HBar ────────────────────────────────────────────────────────────── */
// Chart.js-style horizontal bar: label column, x gridlines on nice ticks,
// tick labels along the bottom axis, value labels clamped inside the plot
// (never clipped), native tooltips carrying the untruncated label.
export function HBar({ rows = [], max, unit, width = 460, height, labelWidth = 90, truncate = 14 }) {
  const dataMax = max != null ? max : Math.max(1, ...rows.map((r) => r.value));
  const { ticks, top } = max != null ? { ticks: niceTicks(max, 4).ticks, top: max } : niceTicks(dataMax, 4);
  const barH = 13;
  const gap = 9;
  const padR = 10;
  const axisH = 18;
  const plotX = labelWidth + 8;
  const plotW = Math.max(40, width - plotX - padR);
  const plotH = rows.length * (barH + gap);
  const h = height || plotH + axisH;
  const xFor = (v) => plotX + (v / top) * plotW;
  return (
    <svg width={width} height={h} style={{ display: 'block' }}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={xFor(t)} y1={0} x2={xFor(t)} y2={plotH} stroke={GRID} strokeWidth={1} />
          <text x={xFor(t)} y={plotH + 13} fontSize={10} fill={TICK} textAnchor="middle">
            {unit ? `${fmtTick(t)}${unit}` : fmtTick(t)}
          </text>
        </g>
      ))}
      {rows.map((r, i) => {
        const w = Math.max(2, (r.value / top) * plotW);
        const y = i * (barH + gap);
        const valText = unit ? `${r.value}${unit}` : String(r.value);
        const fitsOutside = w + 6 + valText.length * 6.5 < plotW;
        return (
          <g key={`${r.label}-${i}`}>
            <title>{`${r.label}: ${valText}`}</title>
            <text x={labelWidth} y={y + barH / 2 + 4} fontSize={11} fill={INK_MUTED} textAnchor="end">
              {r.label.length > truncate ? `${r.label.slice(0, truncate - 1)}…` : r.label}
            </text>
            <rect x={plotX} y={y} width={w} height={barH} rx={3} fill={r.color || BRAND} />
            {fitsOutside ? (
              <text x={plotX + w + 6} y={y + barH / 2 + 4} fontSize={11} fill={INK}>{valText}</text>
            ) : (
              <text x={plotX + w - 5} y={y + barH / 2 + 4} fontSize={10} fontWeight={600} fill="#0B1015" textAnchor="end">{valText}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/* ── StackedHBar ─────────────────────────────────────────────────────── */
// rows: [{label, values:{seriesKey: number}}]; series: [{key,color,label}]
export function StackedHBar({ rows = [], series = [], width = 460, labelWidth = 90, truncate = 14 }) {
  const barH = 13;
  const gap = 10;
  const padR = 10;
  const axisH = 18;
  const totals = rows.map((r) => series.reduce((s, sr) => s + (r.values[sr.key] || 0), 0));
  const { ticks, top } = niceTicks(Math.max(1, ...totals), 4);
  const plotX = labelWidth + 8;
  const plotW = Math.max(40, width - plotX - padR);
  const plotH = rows.length * (barH + gap);
  const xFor = (v) => plotX + (v / top) * plotW;
  return (
    <svg width={width} height={plotH + axisH} style={{ display: 'block' }}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={xFor(t)} y1={0} x2={xFor(t)} y2={plotH} stroke={GRID} strokeWidth={1} />
          <text x={xFor(t)} y={plotH + 13} fontSize={10} fill={TICK} textAnchor="middle">{fmtTick(t)}</text>
        </g>
      ))}
      {rows.map((r, i) => {
        const y = i * (barH + gap);
        let x = plotX;
        return (
          <g key={`${r.label}-${i}`}>
            <text x={labelWidth} y={y + barH / 2 + 4} fontSize={11} fill={INK_MUTED} textAnchor="end">
              {r.label.length > truncate ? `${r.label.slice(0, truncate - 1)}…` : r.label}
            </text>
            {series.map((sr) => {
              const v = r.values[sr.key] || 0;
              const w = (v / top) * plotW;
              const seg = (
                <rect key={sr.key} x={x} y={y} width={Math.max(0, w)} height={barH} fill={sr.color}>
                  <title>{`${r.label} — ${sr.label}: ${v}`}</title>
                </rect>
              );
              x += w;
              return seg;
            })}
          </g>
        );
      })}
    </svg>
  );
}

/* ── StackedVBar ─────────────────────────────────────────────────────── */
// days: [{day, values:{seriesKey:number}}]; series: [{key,color,label}]
export function StackedVBar({ days = [], series = [], colors, width = 480, height = 160 }) {
  const padB = 20;
  const padT = 6;
  const padL = 34;
  const innerH = height - padB - padT;
  const totals = days.map((d) => series.reduce((s, sr) => s + (d.values[sr.key] || 0), 0));
  const { ticks, top } = niceTicks(Math.max(1, ...totals), 3);
  const innerW = width - padL - 4;
  const barW = Math.max(4, Math.floor((innerW - days.length * 4) / Math.max(1, days.length)));
  const labelEvery = Math.max(1, Math.ceil(days.length / 6));
  const yFor = (v) => padT + innerH - (v / top) * innerH;
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={padL} y1={yFor(t)} x2={width - 4} y2={yFor(t)} stroke={GRID} strokeWidth={1} />
          <text x={padL - 5} y={yFor(t) + 3} fontSize={9} fill={TICK} textAnchor="end">{fmtTick(t)}</text>
        </g>
      ))}
      {days.map((d, i) => {
        const x = padL + i * (barW + 4);
        let y = padT + innerH;
        return (
          <g key={d.day}>
            {series.map((sr) => {
              const v = d.values[sr.key] || 0;
              const h = (v / top) * innerH;
              y -= h;
              return (
                <rect key={sr.key} x={x} y={y} width={barW} height={Math.max(0, h)} fill={(colors && colors[sr.key]) || sr.color}>
                  <title>{`${d.day} ${sr.label}: ${v}`}</title>
                </rect>
              );
            })}
            {i % labelEvery === 0 && (
              <text x={x + barW / 2} y={height - 6} fontSize={9} fill={TICK} textAnchor="middle">
                {String(d.day).slice(5)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/* ── LineChart ───────────────────────────────────────────────────────── */
// series: [{label,color,points:[{x,y}],dashed?}]; refLines:[{y,color,dash}]
export function LineChart({ series = [], refLines = [], width = 640, height = 220, yUnit, tooltip = true }) {
  const [hover, setHover] = React.useState(null);
  const padL = 44;
  const padB = 20;
  const padT = 10;
  const padR = 8;
  const innerW = width - padL - padR;
  const innerH = height - padB - padT;

  const allPoints = series.flatMap((s) => s.points || []);
  const allY = [...allPoints.map((p) => p.y), ...refLines.map((r) => r.y)].filter((v) => v != null);
  const maxY = Math.max(1, ...allY) * 1.05;
  const maxN = Math.max(1, ...series.map((s) => (s.points || []).length));

  const xAt = (i) => padL + (maxN > 1 ? (i / (maxN - 1)) * innerW : 0);
  const yAt = (v) => padT + innerH - (v / maxY) * innerH;

  const gridLines = [0, 0.25, 0.5, 0.75, 1];

  const onMove = (e) => {
    if (!tooltip) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const idx = Math.max(0, Math.min(maxN - 1, Math.round(((px - padL) / innerW) * (maxN - 1))));
    setHover(idx);
  };

  return (
    <svg width={width} height={height} onMouseLeave={() => setHover(null)}>
      {gridLines.map((g) => (
        <line key={g} x1={padL} x2={width - padR} y1={padT + innerH * g} y2={padT + innerH * g} stroke={GRID} strokeWidth={1} />
      ))}
      {gridLines.map((g) => (
        <text key={`t${g}`} x={padL - 6} y={padT + innerH * g + 3} fontSize={9} fill={TICK} textAnchor="end">
          {yUnit ? yUnit(maxY * (1 - g)) : Math.round(maxY * (1 - g))}
        </text>
      ))}
      {refLines.map((r, i) => (
        <g key={i}>
          <line x1={padL} x2={width - padR} y1={yAt(r.y)} y2={yAt(r.y)} stroke={r.color || CRIT} strokeWidth={1.5} strokeDasharray={r.dash || '2 3'} />
        </g>
      ))}
      {series.map((s) => {
        const pts = (s.points || []).map((p, i) => [xAt(i), yAt(p.y)]);
        const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]},${p[1]}`).join(' ');
        return (
          <path key={s.label} d={path} fill="none" stroke={s.color || BRAND} strokeWidth={2} strokeDasharray={s.dashed ? '5 4' : undefined} />
        );
      })}
      {tooltip && (
        <rect x={padL} y={padT} width={innerW} height={innerH} fill="transparent" onMouseMove={onMove} style={{ cursor: 'crosshair' }} />
      )}
      {tooltip && hover != null && (
        <g>
          <line x1={xAt(hover)} x2={xAt(hover)} y1={padT} y2={height - padB} stroke={TOOLTIP_BORDER} strokeWidth={1} />
          {(() => {
            const w = 150;
            const h = 20 + series.length * 14;
            const tx = Math.min(width - padR - w, Math.max(padL, xAt(hover) + 8));
            const ty = padT + 4;
            return (
              <g style={{ pointerEvents: 'none' }}>
                <rect x={tx} y={ty} width={w} height={h} rx={6} fill={TOOLTIP_BG} stroke={TOOLTIP_BORDER} />
                {series.map((s, i) => {
                  const p = (s.points || [])[hover];
                  return (
                    <text key={s.label} x={tx + 8} y={ty + 16 + i * 14} fontSize={10} fill={INK}>
                      {s.label}: {p ? (yUnit ? yUnit(p.y) : p.y) : '—'}
                    </text>
                  );
                })}
              </g>
            );
          })()}
        </g>
      )}
    </svg>
  );
}

/* ── SparkLine ───────────────────────────────────────────────────────── */
export function SparkLine({ points = [], color = BRAND, width = 100, height = 24 }) {
  if (!points.length) return <svg width={width} height={height} />;
  const max = Math.max(1, ...points);
  const min = Math.min(0, ...points);
  const range = max - min || 1;
  const step = points.length > 1 ? width / (points.length - 1) : 0;
  const pts = points.map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`).join(' ');
  return (
    <svg width={width} height={height}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}

/* ── BubbleMatrix ────────────────────────────────────────────────────── */
// rows: [{name, days:[{day,status}]}]; status: ok|warn|crit|info-pulse|none
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
