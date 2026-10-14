// Tiny inline SVG sparkline. Nulls break the line; an all-null series draws nothing.
export default function Sparkline({ values, color = '#F87171', width = 80, height = 28, fill = true, stretch = false }) {
  const vals = Array.isArray(values) ? values.map((v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v))) : [];
  const real = vals.filter((v) => v != null);
  if (vals.length < 2 || real.length === 0) return null;
  let mx = Math.max(...real);
  const mn = Math.min(...real);
  if (mx === mn) mx += 1;
  const x = (i) => 2 + (i * (width - 4)) / (vals.length - 1);
  const y = (v) => height - 3 - ((v - mn) / (mx - mn)) * (height - 6);

  const segments = [];
  let cur = [];
  vals.forEach((v, i) => {
    if (v == null) { if (cur.length) segments.push(cur); cur = []; } else cur.push([x(i), y(v)]);
  });
  if (cur.length) segments.push(cur);

  const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  let lastPt = null;
  segments.forEach((s) => { lastPt = s[s.length - 1]; });

  return (
    <svg width={stretch ? '100%' : width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio={stretch ? 'none' : undefined} className="block flex-none" aria-hidden="true">
      {segments.map((s, i) => (
        <g key={i}>
          {fill && s.length > 1 && (
            <path d={`${path(s)} L${s[s.length - 1][0].toFixed(1)} ${height} L${s[0][0].toFixed(1)} ${height} Z`} fill={color} opacity="0.14" />
          )}
          <path d={path(s)} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
        </g>
      ))}
      {lastPt && !stretch && <circle cx={lastPt[0]} cy={lastPt[1]} r="2.6" fill={color} />}
    </svg>
  );
}
