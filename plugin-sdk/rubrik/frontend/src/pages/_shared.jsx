// Internal helper module for the v1.2.1 page bodies moved into pages/*.jsx
// during the v2.0.0 file restructure. NOT part of the contract's named file
// list — added so the byte-identical v1 colors/helpers/small components
// aren't duplicated ~10x across page files (each page previously shared a
// single module scope). Every export here is copied verbatim from the old
// monolithic frontend/src/index.jsx; nothing was redesigned.

export const ACCENT = '#00B388';
export const PANEL_BG = '#232323';
export const BORDER = '#333333';
export const TEXT = '#E5E5E5';
export const MUTED = '#9aa0a6';
export const RED = '#C75D5D';
export const AMBER = '#D4A24E';

export function formatBytes(bytes) {
  if (bytes == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(seconds) {
  if (seconds == null) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

export function formatWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  const diffH = diffMs / (1000 * 60 * 60);
  if (diffH < -1) return `in ${Math.round(-diffH)}h`;
  if (diffH < 1) return `${Math.max(1, Math.round(diffH * 60))}m ago`;
  if (diffH < 48) return `${Math.round(diffH)}h ago`;
  return d.toLocaleString();
}

export function formatLag(seconds) {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return `${h}h`;
}

export function panelStyle(extra) {
  return {
    background: PANEL_BG,
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    padding: 16,
    ...extra,
  };
}

export const thStyle = {
  textAlign: 'left',
  padding: '8px 10px',
  fontSize: 12,
  color: MUTED,
  borderBottom: `1px solid ${BORDER}`,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.03em',
};

export const tdStyle = {
  padding: '8px 10px',
  fontSize: 13,
  color: TEXT,
  borderBottom: `1px solid ${BORDER}`,
};

export function UsageBar({ used, capacity }) {
  const pct = capacity > 0 ? Math.min(100, Math.round((used / capacity) * 100)) : 0;
  const color = pct >= 90 ? '#DC2626' : pct >= 75 ? '#D97706' : ACCENT;
  return (
    <div>
      <div style={{ height: 6, background: '#141414', borderRadius: 4, overflow: 'hidden', border: `1px solid ${BORDER}` }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color }} />
      </div>
      <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>
        {formatBytes(used)} / {formatBytes(capacity)} ({pct}%)
      </div>
    </div>
  );
}

export function StatusPill({ status, tone }) {
  const isBad = tone === 'bad' || status === 'Failed' || status === 'Lagging' || status === 'Critical' || status === 'Open';
  const isWarn = tone === 'warn' || status === 'Warning' || status === 'Investigating';
  const color = isBad ? RED : isWarn ? AMBER : ACCENT;
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        background: `${color}26`,
        color,
        border: `1px solid ${color}`,
      }}
    >
      {status}
    </span>
  );
}

export function PulsingDot({ color }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: color || ACCENT,
        marginRight: 6,
        boxShadow: `0 0 0 0 ${color || ACCENT}`,
        animation: 'rubrik-pulse 1.5s ease-in-out infinite',
      }}
    />
  );
}

// ---------------------------------------------------------------------
// Small inline-SVG chart primitives — no Chart.js, no host imports.
// ---------------------------------------------------------------------

export function Donut({ pct, size = 72, stroke = 9, color = ACCENT, label }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const dash = (clamped / 100) * c;
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#141414" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeDasharray={`${dash} ${c - dash}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: size < 50 ? 10 : 13,
          fontWeight: 700,
          color: TEXT,
        }}
      >
        {label != null ? label : `${Math.round(clamped)}%`}
      </div>
    </div>
  );
}

export function Bars({ data, width = 320, height = 120, horizontal }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const pad = 4;
  if (horizontal) {
    const barH = Math.max(10, Math.floor((height - data.length * pad) / data.length));
    return (
      <svg width={width} height={data.length * (barH + pad)}>
        {data.map((d, i) => {
          const w = (d.value / max) * (width - 80);
          const y = i * (barH + pad);
          return (
            <g key={d.label}>
              <text x={0} y={y + barH / 2 + 4} fontSize={11} fill={MUTED}>
                {d.label}
              </text>
              <rect x={72} y={y} width={Math.max(2, w)} height={barH} rx={3} fill={d.color || ACCENT} />
              <text x={72 + w + 6} y={y + barH / 2 + 4} fontSize={11} fill={TEXT}>
                {d.valueLabel != null ? d.valueLabel : d.value}
              </text>
            </g>
          );
        })}
      </svg>
    );
  }
  const barW = Math.max(8, Math.floor((width - data.length * pad) / data.length));
  return (
    <svg width={width} height={height}>
      {data.map((d, i) => {
        const h = (d.value / max) * (height - 20);
        const x = i * (barW + pad);
        return (
          <g key={d.label}>
            <rect x={x} y={height - 20 - h} width={barW} height={Math.max(1, h)} rx={2} fill={d.color || ACCENT} />
            <text x={x + barW / 2} y={height - 6} fontSize={10} fill={MUTED} textAnchor="middle">
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// Multi-series line + area chart with a solid history line, an optional
// dashed forecast continuation, and an optional dotted capacity rule.
export function LineArea({ history, forecast, capacity, width = 640, height = 220, yFormat }) {
  const allValues = [...history.map((p) => p.value), ...(forecast || []).map((p) => p.value), capacity || 0].filter(
    (v) => v != null
  );
  const maxY = Math.max(1, ...allValues) * 1.05;
  const totalPoints = history.length + (forecast ? forecast.length : 0);
  const padL = 44;
  const padB = 20;
  const padT = 10;
  const innerW = width - padL - 8;
  const innerH = height - padB - padT;
  const xAt = (i) => padL + (totalPoints > 1 ? (i / (totalPoints - 1)) * innerW : 0);
  const yAt = (v) => padT + innerH - (v / maxY) * innerH;

  const historyPts = history.map((p, i) => [xAt(i), yAt(p.value)]);
  const forecastPts = (forecast || []).map((p, i) => [xAt(history.length + i), yAt(p.value)]);

  const historyPath = historyPts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]},${p[1]}`).join(' ');
  const forecastPath =
    forecastPts.length > 0
      ? [historyPts[historyPts.length - 1], ...forecastPts].map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]},${p[1]}`).join(' ')
      : '';
  const areaPath =
    historyPts.length > 0
      ? `${historyPath} L${historyPts[historyPts.length - 1][0]},${yAt(0)} L${historyPts[0][0]},${yAt(0)} Z`
      : '';

  const capY = capacity != null ? yAt(capacity) : null;
  const gridLines = [0, 0.25, 0.5, 0.75, 1];

  return (
    <svg width={width} height={height}>
      {gridLines.map((g) => (
        <line
          key={g}
          x1={padL}
          x2={width - 8}
          y1={padT + innerH * g}
          y2={padT + innerH * g}
          stroke="#2a2a2a"
          strokeWidth={1}
        />
      ))}
      {gridLines.map((g) => (
        <text key={`t${g}`} x={padL - 6} y={padT + innerH * g + 3} fontSize={9} fill={MUTED} textAnchor="end">
          {yFormat ? yFormat(maxY * (1 - g)) : Math.round(maxY * (1 - g))}
        </text>
      ))}
      {capY != null && (
        <>
          <line x1={padL} x2={width - 8} y1={capY} y2={capY} stroke={RED} strokeWidth={1.5} strokeDasharray="2 3" />
          <text x={width - 8} y={capY - 4} fontSize={9} fill={RED} textAnchor="end">
            capacity
          </text>
        </>
      )}
      {areaPath && <path d={areaPath} fill={`${ACCENT}1f`} stroke="none" />}
      {historyPath && <path d={historyPath} fill="none" stroke={ACCENT} strokeWidth={2} />}
      {forecastPath && <path d={forecastPath} fill="none" stroke={AMBER} strokeWidth={2} strokeDasharray="5 4" />}
    </svg>
  );
}

export const DAY_COLORS = { ok: ACCENT, missed: RED, none: '#3a3a3a' };

export function MiniBubbleGrid({ rows, cellSize = 16, gap = 3 }) {
  const dayCount = rows.length > 0 ? rows[0].days.length : 0;
  const labelW = 180;
  const width = labelW + dayCount * (cellSize + gap);
  const height = rows.length * (cellSize + gap);
  return (
    <svg width={width} height={height}>
      {rows.map((r, ri) => (
        <g key={r.name} transform={`translate(0, ${ri * (cellSize + gap)})`}>
          <text x={0} y={cellSize - 4} fontSize={11} fill={TEXT}>
            {r.name.length > 26 ? `${r.name.slice(0, 24)}…` : r.name}
          </text>
          {r.days.map((d, di) => (
            <rect
              key={di}
              x={labelW + di * (cellSize + gap)}
              y={1}
              width={cellSize - 2}
              height={cellSize - 2}
              rx={3}
              fill={DAY_COLORS[d.status] || DAY_COLORS.none}
            >
              <title>{`${d.day}: ${d.status}`}</title>
            </rect>
          ))}
        </g>
      ))}
    </svg>
  );
}

export function useFetch(path) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch(`/api/rubrik${path}`, { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`request failed: ${res.status}`);
        return res.json();
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return { data, error };
}

export function PageShell({ title, error, children }) {
  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif', color: TEXT, background: 'transparent' }}>
      <style>{`@keyframes rubrik-pulse { 0% { box-shadow: 0 0 0 0 rgba(0,179,136,0.6); } 70% { box-shadow: 0 0 0 6px rgba(0,179,136,0); } 100% { box-shadow: 0 0 0 0 rgba(0,179,136,0); } }`}</style>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16, color: TEXT }}>{title}</h1>
      {error && <p style={{ color: RED }}>{error}</p>}
      {children}
    </div>
  );
}

export function SecurityBanner({ overview }) {
  if (!overview || !overview.anomalies || overview.anomalies.open === 0) return null;
  const pct = Math.round((overview.anomalies.maxProbability || 0) * 100);
  return (
    <a
      href="#/rubrik/security"
      onClick={(e) => {
        e.preventDefault();
        window.history.pushState({}, '', '/rubrik/security');
        window.dispatchEvent(new PopStateEvent('popstate'));
      }}
      style={{
        display: 'block',
        textDecoration: 'none',
        marginBottom: 16,
        padding: '12px 16px',
        borderRadius: 8,
        background: `${RED}1f`,
        border: `1px solid ${RED}`,
        color: RED,
        fontSize: 13,
        fontWeight: 600,
      }}
    >
      Encryption anomaly {pct}% — {overview.anomalies.open} open Radar alert{overview.anomalies.open > 1 ? 's' : ''} — snapshot
      quarantined. View Threat Monitoring →
    </a>
  );
}
