// Proxmox VE plugin chart kit — hand-rolled inline SVG (no Chart.js: the
// plugin sandbox forbids host package imports). Cloned from the Rubrik demo
// plugin's charts.jsx, brand color swapped to Proxmox orange.

const GRID = '#1F2B37';
const TICK = '#64748B';
const TOOLTIP_BG = '#1E2A36';
const TOOLTIP_BORDER = '#2A3845';
const INK = '#E8EDF2';
const INK_MUTED = '#94A3B3';
const BRAND = '#E57000';
const WARN = '#FBBF24';
const CRIT = '#F87171';

/* ── responsive width ────────────────────────────────────────────────── */
function useMeasuredWidth(fallback) {
  const ref = React.useRef(null);
  const [w, setW] = React.useState(0);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      const cw = Math.floor(entries[0].contentRect.width);
      if (cw > 0) setW(cw);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w || fallback];
}

/* ── axis helpers ────────────────────────────────────────────────────── */
function niceStep(rough) {
  if (!(rough > 0)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const frac = rough / pow;
  return (frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10) * pow;
}
function niceTicks(max, count = 4) {
  const step = niceStep(max / count);
  const top = Math.ceil((max + step * 0.001) / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step * 0.001; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return { ticks, top };
}

/* ── LineChart ───────────────────────────────────────────────────────── */
// series: [{label,color,points:[{x,y}],dashed?}]; refLines:[{y,color,dash}]
export function LineChart({ series = [], refLines = [], width = 640, height = 220, yFmt, tooltip = true }) {
  const [wrapRef, w] = useMeasuredWidth(width);
  const [hover, setHover] = React.useState(null);
  const padL = 44;
  const padB = 20;
  const padT = 10;
  const padR = 8;
  const innerW = w - padL - padR;
  const innerH = height - padB - padT;

  const allPoints = series.flatMap((s) => s.points || []);
  const allY = [...allPoints.map((p) => (p ? p.y : null)), ...refLines.map((r) => r.y)].filter((v) => v != null);
  const maxY = Math.max(1, ...allY) * 1.05;
  const maxN = Math.max(1, ...series.map((s) => (s.points || []).length));

  const xAt = (i) => padL + (maxN > 1 ? (i / (maxN - 1)) * innerW : 0);
  const yAt = (v) => padT + innerH - (v / maxY) * innerH;

  const { ticks: yTicks } = niceTicks(maxY, 4);

  const onMove = (e) => {
    if (!tooltip) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * innerW + padL;
    const idx = Math.max(0, Math.min(maxN - 1, Math.round(((px - padL) / innerW) * (maxN - 1))));
    setHover(idx);
  };

  return (
    <div ref={wrapRef} style={{ width: '100%' }}>
      <svg width={w} height={height} onMouseLeave={() => setHover(null)}>
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={w - padR} y1={yAt(t)} y2={yAt(t)} stroke={GRID} strokeWidth={1} />
            <text x={padL - 6} y={yAt(t) + 3} fontSize={9} fill={TICK} textAnchor="end">
              {yFmt ? yFmt(t) : t}
            </text>
          </g>
        ))}
        {refLines.map((r, i) => (
          <g key={i}>
            <line x1={padL} x2={w - padR} y1={yAt(r.y)} y2={yAt(r.y)} stroke={r.color || CRIT} strokeWidth={1.5} strokeDasharray={r.dash || '2 3'} />
          </g>
        ))}
        {series.map((s) => {
          let path = '';
          let pen = false;
          (s.points || []).forEach((p, i) => {
            if (p == null || p.y == null) { pen = false; return; }
            path += `${pen ? 'L' : 'M'}${xAt(i)},${yAt(p.y)} `;
            pen = true;
          });
          return (
            <path key={s.label} d={path.trim()} fill="none" stroke={s.color || BRAND} strokeWidth={2} strokeDasharray={s.dashed ? '5 4' : undefined} />
          );
        })}
        {tooltip && (
          <rect x={padL} y={padT} width={Math.max(0, innerW)} height={Math.max(0, innerH)} fill="transparent" onMouseMove={onMove} style={{ cursor: 'crosshair' }} />
        )}
        {tooltip && hover != null && (
          <g>
            <line x1={xAt(hover)} x2={xAt(hover)} y1={padT} y2={height - padB} stroke={TOOLTIP_BORDER} strokeWidth={1} />
            {(() => {
              const tw = 170;
              const h = 20 + series.length * 14;
              const tx = Math.min(w - padR - tw, Math.max(padL, xAt(hover) + 8));
              const ty = padT + 4;
              return (
                <g style={{ pointerEvents: 'none' }}>
                  <rect x={tx} y={ty} width={tw} height={h} rx={6} fill={TOOLTIP_BG} stroke={TOOLTIP_BORDER} />
                  {series.map((s, i) => {
                    const p = (s.points || [])[hover];
                    return (
                      <text key={s.label} x={tx + 8} y={ty + 16 + i * 14} fontSize={10} fill={INK}>
                        {s.label}: {p ? (yFmt ? yFmt(p.y) : p.y) : '—'}
                      </text>
                    );
                  })}
                </g>
              );
            })()}
          </g>
        )}
      </svg>
    </div>
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

/* ── Donut ───────────────────────────────────────────────────────────── */
export function Donut({ pct, size = 74, stroke = 9, thresholds, centerLabel, centerSub }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const cx = size / 2;
  const cy = size / 2;
  const clamped = Math.max(0, Math.min(100, pct || 0));
  const dash = (clamped / 100) * c;
  let color = BRAND;
  if (thresholds) {
    if ((pct || 0) >= (thresholds.crit ?? 95)) color = CRIT;
    else if ((pct || 0) >= (thresholds.warn ?? 85)) color = WARN;
  }
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={GRID} strokeWidth={stroke} />
        <circle
          cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeDasharray={`${dash} ${c - dash}`} strokeLinecap="round"
          transform={`rotate(-90 ${cx} ${cy})`}
        />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontSize: size < 50 ? 10 : 14, fontWeight: 700, color: INK }}>{centerLabel != null ? centerLabel : `${Math.round(pct || 0)}%`}</div>
        {centerSub && <div style={{ fontSize: 9, color: INK_MUTED }}>{centerSub}</div>}
      </div>
    </div>
  );
}

/* ── HBar ────────────────────────────────────────────────────────────── */
export function HBar({ rows = [], max, unit, width = 460, height, labelWidth = 90, truncate = 14 }) {
  const [wrapRef, w] = useMeasuredWidth(width);
  const dataMax = max != null ? max : Math.max(1, ...rows.map((r) => r.value));
  const barH = 14;
  const gap = 12;
  const padR = 12;
  const axisH = 20;
  const plotX = labelWidth + 10;
  const plotW = Math.max(40, w - plotX - padR);
  const { ticks, top } = niceTicks(dataMax, Math.max(4, Math.min(10, Math.floor(plotW / 80))));
  const plotH = rows.length * (barH + gap);
  const h = height || plotH + axisH;
  const xFor = (v) => plotX + (v / top) * plotW;
  return (
    <div ref={wrapRef} style={{ width: '100%' }}>
      <svg width={w} height={h} style={{ display: 'block' }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={xFor(t)} y1={0} x2={xFor(t)} y2={plotH} stroke={GRID} strokeWidth={1} />
            <text x={xFor(t)} y={plotH + 14} fontSize={10} fill={TICK} textAnchor="middle">
              {unit ? `${t}${unit}` : t}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const bw = Math.max(2, (r.value / top) * plotW);
          const y = i * (barH + gap);
          const valText = unit ? `${r.value}${unit}` : String(r.value);
          const fitsOutside = bw + 6 + valText.length * 6.5 < plotW;
          return (
            <g key={`${r.label}-${i}`}>
              <title>{`${r.label}: ${valText}`}</title>
              {i > 0 && <line x1={plotX} y1={y - gap / 2} x2={plotX + plotW} y2={y - gap / 2} stroke={GRID} strokeWidth={0.5} opacity={0.6} />}
              <text x={labelWidth} y={y + barH / 2 + 4} fontSize={11} fill={INK_MUTED} textAnchor="end">
                {r.label.length > truncate ? `${r.label.slice(0, truncate - 1)}…` : r.label}
              </text>
              <rect x={plotX} y={y} width={bw} height={barH} rx={3} fill={r.color || BRAND} />
              {fitsOutside ? (
                <text x={plotX + bw + 6} y={y + barH / 2 + 4} fontSize={11} fill={INK}>{valText}</text>
              ) : (
                <text x={plotX + bw - 5} y={y + barH / 2 + 4} fontSize={10} fontWeight={600} fill="#0B1015" textAnchor="end">{valText}</text>
              )}
            </g>
          );
        })}
        <line x1={plotX} y1={plotH} x2={plotX + plotW} y2={plotH} stroke={TICK} strokeWidth={1} opacity={0.5} />
      </svg>
    </div>
  );
}
