// Rubrik demo platform frontend module (ICC contract C9.4). Bundled as an
// IIFE with no ESM imports at runtime — React comes from `window.React`
// (injected by the build banner, see plugin-sdk/build.mjs). No Tailwind, no
// Chart.js: the host's CSS purge only scans host source files, and the SDK
// sandbox forbids host imports, so plugin markup uses inline styles and
// hand-rolled inline-SVG charts exclusively.

const ACCENT = '#00B388';
const PANEL_BG = '#232323';
const BORDER = '#333333';
const TEXT = '#E5E5E5';
const MUTED = '#9aa0a6';
const RED = '#C75D5D';
const AMBER = '#D4A24E';

function formatBytes(bytes) {
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

function formatDuration(seconds) {
  if (seconds == null) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

function formatWhen(iso) {
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

function formatLag(seconds) {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return `${h}h`;
}

function panelStyle(extra) {
  return {
    background: PANEL_BG,
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    padding: 16,
    ...extra,
  };
}

const thStyle = {
  textAlign: 'left',
  padding: '8px 10px',
  fontSize: 12,
  color: MUTED,
  borderBottom: `1px solid ${BORDER}`,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.03em',
};

const tdStyle = {
  padding: '8px 10px',
  fontSize: 13,
  color: TEXT,
  borderBottom: `1px solid ${BORDER}`,
};

function UsageBar({ used, capacity }) {
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

function StatusPill({ status, tone }) {
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

function PulsingDot({ color }) {
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

function Donut({ pct, size = 72, stroke = 9, color = ACCENT, label }) {
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

function Bars({ data, width = 320, height = 120, horizontal }) {
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
function LineArea({ history, forecast, capacity, width = 640, height = 220, yFormat }) {
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

const DAY_COLORS = { ok: ACCENT, missed: RED, none: '#3a3a3a' };

function MiniBubbleGrid({ rows, cellSize = 16, gap = 3 }) {
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

function useFetch(path) {
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

function PageShell({ title, error, children }) {
  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif', color: TEXT, background: 'transparent' }}>
      <style>{`@keyframes rubrik-pulse { 0% { box-shadow: 0 0 0 0 rgba(0,179,136,0.6); } 70% { box-shadow: 0 0 0 6px rgba(0,179,136,0); } 100% { box-shadow: 0 0 0 0 rgba(0,179,136,0); } }`}</style>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16, color: TEXT }}>{title}</h1>
      {error && <p style={{ color: RED }}>{error}</p>}
      {children}
    </div>
  );
}

function SecurityBanner({ overview }) {
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

function OverviewPage() {
  const { data, error } = useFetch('/overview');
  const { data: jobs } = useFetch('/jobs');
  const { data: slaDomains } = useFetch('/sla-domains');
  const failedJobs = (jobs || []).filter((j) => j.status === 'Failed').slice(0, 5);

  return (
    <PageShell title="Rubrik Overview" error={error}>
      {data && (
        <>
          <SecurityBanner overview={data} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 20 }}>
            <div style={panelStyle()}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Clusters</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: ACCENT }}>{data.clusters}</div>
              {data.capacity && data.capacity.runwayDays != null && (
                <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>min runway {data.capacity.runwayDays}d</div>
              )}
            </div>
            <div style={panelStyle()}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Protected Objects</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: TEXT }}>{data.objects}</div>
              <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>{data.slaCompliancePct}% SLA compliant</div>
            </div>
            <div style={panelStyle()}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Jobs (24h)</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: TEXT }}>{data.jobs24h}</div>
              {data.failed24h > 0 && <div style={{ fontSize: 12, color: RED, marginTop: 4 }}>{data.failed24h} failed</div>}
            </div>
            <div style={panelStyle()}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Capacity Used</div>
              <UsageBar used={data.usedBytes} capacity={data.capacityBytes} />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
            <div style={panelStyle()}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, color: TEXT }}>SLA Compliance</div>
              {slaDomains && (
                <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                  <Donut pct={data.slaCompliancePct} />
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <tbody>
                      {slaDomains
                        .filter((s) => s.objectCount > 0)
                        .map((s) => (
                          <tr key={s.id}>
                            <td style={{ ...tdStyle, padding: '4px 6px' }}>{s.name}</td>
                            <td style={{ ...tdStyle, padding: '4px 6px', color: MUTED }}>{s.objectCount} obj</td>
                            <td style={{ ...tdStyle, padding: '4px 6px', color: s.compliancePct >= 95 ? ACCENT : AMBER }}>
                              {s.compliancePct}%
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div style={panelStyle()}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, color: TEXT }}>Recent Failed Jobs</div>
              {failedJobs.length === 0 && <div style={{ fontSize: 13, color: MUTED }}>No failed jobs in the last 24h.</div>}
              {failedJobs.length > 0 && (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={thStyle}>Object</th>
                      <th style={thStyle}>Cluster</th>
                      <th style={thStyle}>Started</th>
                    </tr>
                  </thead>
                  <tbody>
                    {failedJobs.map((j) => (
                      <tr key={j.id}>
                        <td style={tdStyle}>{j.objectName}</td>
                        <td style={tdStyle}>{j.clusterName}</td>
                        <td style={tdStyle}>{formatWhen(j.startedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </PageShell>
  );
}

const EVENT_TYPES = ['All', 'Backup', 'Replication', 'Archival', 'Security', 'System', 'Maintenance'];
const SEVERITIES = ['All', 'Critical', 'Warning', 'Info'];

function EventsPage() {
  const [severity, setSeverity] = React.useState('All');
  const [type, setType] = React.useState('All');
  const { data, error } = useFetch(`/events?days=7${severity !== 'All' ? `&severity=${severity}` : ''}`);
  const rows = (data || []).filter((e) => type === 'All' || e.eventType === type);

  return (
    <PageShell title="Rubrik Events" error={error}>
      <div style={{ marginBottom: 12, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          {SEVERITIES.map((s) => (
            <button
              key={s}
              onClick={() => setSeverity(s)}
              style={{
                padding: '6px 12px',
                fontSize: 12,
                borderRadius: 6,
                cursor: 'pointer',
                border: `1px solid ${severity === s ? ACCENT : BORDER}`,
                background: severity === s ? `${ACCENT}26` : PANEL_BG,
                color: severity === s ? ACCENT : TEXT,
              }}
            >
              {s}
            </button>
          ))}
        </div>
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          style={{ background: PANEL_BG, color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 6, padding: '6px 10px', fontSize: 12 }}
        >
          {EVENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      {data && (
        <div style={panelStyle({ padding: 0, overflow: 'hidden' })}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Severity</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Cluster</th>
                <th style={thStyle}>Object</th>
                <th style={thStyle}>Message</th>
                <th style={thStyle}>When</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td style={tdStyle}>
                    <StatusPill status={e.severity} />
                  </td>
                  <td style={tdStyle}>{e.eventType}</td>
                  <td style={tdStyle}>{e.cluster || '—'}</td>
                  <td style={tdStyle}>{e.objectName || '—'}</td>
                  <td style={{ ...tdStyle, color: MUTED }}>{e.message}</td>
                  <td style={tdStyle}>{formatWhen(e.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}

function ClustersPage() {
  const { data, error } = useFetch('/clusters');
  return (
    <PageShell title="Rubrik Clusters" error={error}>
      {data && (
        <div style={panelStyle({ padding: 0, overflow: 'hidden' })}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Model</th>
                <th style={thStyle}>Nodes</th>
                <th style={thStyle}>Version</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Runway</th>
                <th style={thStyle}>Usage</th>
              </tr>
            </thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.id}>
                  <td style={tdStyle}>{c.name}</td>
                  <td style={tdStyle}>{c.model}</td>
                  <td style={tdStyle}>{c.nodes}</td>
                  <td style={tdStyle}>
                    {c.version}{' '}
                    {c.versionStatus === 'Update Available' && (
                      <span style={{ color: AMBER, fontSize: 11 }}>(update available)</span>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <StatusPill status={c.status === 'Connected' ? 'Succeeded' : c.status} />
                  </td>
                  <td style={{ ...tdStyle, color: c.runwayDays <= 60 ? RED : c.runwayDays <= 180 ? AMBER : TEXT }}>
                    {c.runwayDays != null ? `${c.runwayDays}d` : '—'}
                  </td>
                  <td style={{ ...tdStyle, width: 220 }}>
                    <UsageBar used={c.usedBytes} capacity={c.capacityBytes} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}

const OBJECT_TYPES = ['All', 'VM', 'MSSQL DB', 'NAS Share', 'EC2 Instance'];

function ObjectsPage() {
  const { data, error } = useFetch('/objects');
  const [filter, setFilter] = React.useState('All');
  const [slaFilter, setSlaFilter] = React.useState('All');
  const [clusterFilter, setClusterFilter] = React.useState('All');
  const slaOptions = ['All', ...new Set((data || []).map((o) => o.slaDomain))];
  const clusterOptions = ['All', ...new Set((data || []).map((o) => o.clusterName))];
  const rows = (data || []).filter(
    (o) =>
      (filter === 'All' || o.type === filter) &&
      (slaFilter === 'All' || o.slaDomain === slaFilter) &&
      (clusterFilter === 'All' || o.clusterName === clusterFilter)
  );

  return (
    <PageShell title="Rubrik Protected Objects" error={error}>
      <div style={{ marginBottom: 12, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          {OBJECT_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => setFilter(t)}
              style={{
                padding: '6px 12px',
                fontSize: 12,
                borderRadius: 6,
                cursor: 'pointer',
                border: `1px solid ${filter === t ? ACCENT : BORDER}`,
                background: filter === t ? `${ACCENT}26` : PANEL_BG,
                color: filter === t ? ACCENT : TEXT,
              }}
            >
              {t}
            </button>
          ))}
        </div>
        <select
          value={slaFilter}
          onChange={(e) => setSlaFilter(e.target.value)}
          style={{ background: PANEL_BG, color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 6, padding: '6px 10px', fontSize: 12 }}
        >
          {slaOptions.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={clusterFilter}
          onChange={(e) => setClusterFilter(e.target.value)}
          style={{ background: PANEL_BG, color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 6, padding: '6px 10px', fontSize: 12 }}
        >
          {clusterOptions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      {data && (
        <div style={panelStyle({ padding: 0, overflow: 'hidden' })}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Cluster</th>
                <th style={thStyle}>SLA Domain</th>
                <th style={thStyle}>Next Snapshot</th>
                <th style={thStyle}>Snapshots</th>
                <th style={thStyle}>Local / Archived</th>
                <th style={thStyle}>Compliance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id} style={{ background: o.compliant ? 'transparent' : `${RED}14` }}>
                  <td style={tdStyle}>{o.name}</td>
                  <td style={tdStyle}>{o.type}</td>
                  <td style={tdStyle}>{o.clusterName}</td>
                  <td style={tdStyle}>{o.slaDomain}</td>
                  <td style={tdStyle}>{formatWhen(o.nextSnapshotAt)}</td>
                  <td style={tdStyle}>{o.snapshotCount}</td>
                  <td style={{ ...tdStyle, color: MUTED }}>
                    {formatBytes(o.localStorageBytes)} / {formatBytes(o.archivedBytes)}
                  </td>
                  <td style={{ ...tdStyle, color: o.compliant ? ACCENT : RED, fontWeight: 600 }}>
                    {o.compliant ? 'Compliant' : 'Out of Compliance'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}

function SlaDomainsPage() {
  const { data, error } = useFetch('/sla-domains');
  return (
    <PageShell title="Rubrik SLA Domains" error={error}>
      {data && (
        <div style={panelStyle({ padding: 0, overflow: 'hidden' })}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Frequency</th>
                <th style={thStyle}>Retention</th>
                <th style={thStyle}>Objects</th>
                <th style={thStyle}>Compliance</th>
                <th style={thStyle}>Archival</th>
                <th style={thStyle}>Replication</th>
              </tr>
            </thead>
            <tbody>
              {data.map((s) => (
                <tr key={s.id}>
                  <td style={tdStyle}>{s.name}</td>
                  <td style={tdStyle}>{s.snapshotFrequency}</td>
                  <td style={tdStyle}>{s.retention}</td>
                  <td style={tdStyle}>{s.objectCount}</td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Donut pct={s.compliancePct} size={32} stroke={5} color={s.compliancePct >= 95 ? ACCENT : AMBER} label=" " />
                      <span>{s.compliancePct}%</span>
                    </div>
                  </td>
                  <td style={{ ...tdStyle, color: MUTED }}>{s.archivalLocation || '—'}</td>
                  <td style={{ ...tdStyle, color: MUTED }}>{s.replicationTarget || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}

function CompliancePage() {
  const { data, error } = useFetch('/compliance');
  const [filter, setFilter] = React.useState('All');
  const names = ['All', ...(data || []).map((o) => o.name)];
  const rows = (data || []).filter((o) => filter === 'All' || o.name === filter);

  return (
    <PageShell title="Rubrik Compliance — 14 Day History" error={error}>
      <div style={{ marginBottom: 12, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ background: PANEL_BG, color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 6, padding: '6px 10px', fontSize: 12 }}
        >
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <div style={{ display: 'flex', gap: 14, fontSize: 12, color: MUTED }}>
          <span>
            <span style={{ display: 'inline-block', width: 10, height: 10, background: DAY_COLORS.ok, borderRadius: 2, marginRight: 4 }} />
            OK
          </span>
          <span>
            <span style={{ display: 'inline-block', width: 10, height: 10, background: DAY_COLORS.missed, borderRadius: 2, marginRight: 4 }} />
            Missed
          </span>
          <span>
            <span style={{ display: 'inline-block', width: 10, height: 10, background: DAY_COLORS.none, borderRadius: 2, marginRight: 4 }} />
            No snapshot expected
          </span>
        </div>
      </div>
      {data && (
        <div style={panelStyle({ overflowX: 'auto' })}>
          <MiniBubbleGrid rows={rows} />
        </div>
      )}
    </PageShell>
  );
}

const JOB_TYPES = ['All', 'Backup', 'Replication', 'Archival'];

function JobsPage() {
  const { data, error } = useFetch('/jobs');
  const [filter, setFilter] = React.useState('All');
  const rows = (data || []).filter((j) => filter === 'All' || j.jobType === filter);

  return (
    <PageShell title="Rubrik Jobs" error={error}>
      <div style={{ marginBottom: 12, display: 'flex', gap: 8 }}>
        {JOB_TYPES.map((t) => (
          <button
            key={t}
            onClick={() => setFilter(t)}
            style={{
              padding: '6px 12px',
              fontSize: 12,
              borderRadius: 6,
              cursor: 'pointer',
              border: `1px solid ${filter === t ? ACCENT : BORDER}`,
              background: filter === t ? `${ACCENT}26` : PANEL_BG,
              color: filter === t ? ACCENT : TEXT,
            }}
          >
            {t}
          </button>
        ))}
      </div>
      {data && (
        <div style={panelStyle({ padding: 0, overflow: 'hidden' })}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Object</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Cluster</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Started</th>
                <th style={thStyle}>Duration</th>
                <th style={thStyle}>Data</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((j) => (
                <tr key={j.id} style={{ background: j.status === 'Failed' ? `${RED}14` : 'transparent' }}>
                  <td style={tdStyle}>{j.objectName}</td>
                  <td style={tdStyle}>{j.jobType}</td>
                  <td style={tdStyle}>{j.clusterName}</td>
                  <td style={tdStyle}>
                    <StatusPill status={j.status} />
                  </td>
                  <td style={tdStyle}>{formatWhen(j.startedAt)}</td>
                  <td style={tdStyle}>{formatDuration(j.durationSeconds)}</td>
                  <td style={tdStyle}>{formatBytes(j.dataTransferredBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.some((j) => j.status === 'Failed') && (
            <div style={{ padding: 10, borderTop: `1px solid ${BORDER}` }}>
              {rows
                .filter((j) => j.status === 'Failed')
                .map((j) => (
                  <div key={j.id} style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>
                    <span style={{ color: RED, fontWeight: 600 }}>{j.objectName}:</span> {j.errorMessage}
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </PageShell>
  );
}

function SecurityPage() {
  const { data, error } = useFetch('/security');
  return (
    <PageShell title="Rubrik Threat Monitoring" error={error}>
      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 20 }}>
            <div style={panelStyle()}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Open Anomalies</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: data.summary.openAnomalies > 0 ? RED : ACCENT }}>
                {data.summary.openAnomalies}
              </div>
            </div>
            <div style={panelStyle()}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Quarantined Snapshots</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: data.summary.quarantinedSnapshots > 0 ? AMBER : TEXT }}>
                {data.summary.quarantinedSnapshots}
              </div>
            </div>
            <div style={panelStyle()}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Running Hunts</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: TEXT }}>{data.summary.runningHunts}</div>
            </div>
            <div style={panelStyle()}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>IOC Matches</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: data.summary.matches > 0 ? RED : TEXT }}>{data.summary.matches}</div>
            </div>
          </div>

          <div style={{ ...panelStyle(), marginBottom: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, color: TEXT }}>Radar Anomalies</div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}>Object</th>
                  <th style={thStyle}>Cluster</th>
                  <th style={thStyle}>Probability</th>
                  <th style={thStyle}>Encryption</th>
                  <th style={thStyle}>Quarantined</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Detected</th>
                </tr>
              </thead>
              <tbody>
                {data.anomalies.map((a) => (
                  <tr key={a.id} style={{ background: a.status === 'Open' ? `${RED}14` : 'transparent' }}>
                    <td style={tdStyle}>
                      {a.objectName} <span style={{ color: MUTED }}>({a.objectType})</span>
                    </td>
                    <td style={tdStyle}>{a.cluster}</td>
                    <td style={{ ...tdStyle, width: 160 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ flex: 1, height: 6, background: '#141414', borderRadius: 4, border: `1px solid ${BORDER}` }}>
                          <div
                            style={{
                              height: '100%',
                              width: `${Math.round(a.anomalyProbability * 100)}%`,
                              background: a.anomalyProbability >= 0.7 ? RED : a.anomalyProbability >= 0.4 ? AMBER : ACCENT,
                              borderRadius: 4,
                            }}
                          />
                        </div>
                        <span style={{ fontSize: 11, color: MUTED }}>{Math.round(a.anomalyProbability * 100)}%</span>
                      </div>
                    </td>
                    <td style={tdStyle}>
                      {a.encryptionDetected ? <StatusPill status="Detected" tone="bad" /> : <span style={{ color: MUTED }}>—</span>}
                    </td>
                    <td style={tdStyle}>{a.snapshotQuarantined ? <StatusPill status="Quarantined" tone="warn" /> : '—'}</td>
                    <td style={tdStyle}>
                      <StatusPill status={a.status} />
                    </td>
                    <td style={tdStyle}>{formatWhen(a.detectedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={panelStyle()}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, color: TEXT }}>Threat Hunts</div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>IOC Type</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Scanned (clusters/snaps/objects)</th>
                  <th style={thStyle}>Matches</th>
                  <th style={thStyle}>Started</th>
                </tr>
              </thead>
              <tbody>
                {data.hunts.map((h) => (
                  <tr key={h.id} style={{ background: h.matchesFound > 0 ? `${RED}14` : 'transparent' }}>
                    <td style={tdStyle}>{h.name}</td>
                    <td style={tdStyle}>{h.iocType}</td>
                    <td style={tdStyle}>
                      {h.status === 'Running' && <PulsingDot color={ACCENT} />}
                      <StatusPill status={h.status} />
                    </td>
                    <td style={{ ...tdStyle, color: MUTED }}>
                      {h.clustersScanned} / {h.snapshotsScanned} / {h.objectsScanned}
                    </td>
                    <td style={{ ...tdStyle, color: h.matchesFound > 0 ? RED : MUTED, fontWeight: h.matchesFound > 0 ? 700 : 400 }}>
                      {h.matchesFound}
                    </td>
                    <td style={tdStyle}>{formatWhen(h.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </PageShell>
  );
}

function ReplicationPage() {
  const { data, error } = useFetch('/replication');
  return (
    <PageShell title="Rubrik Replication & Archival" error={error}>
      {data && (
        <>
          <div style={{ ...panelStyle(), marginBottom: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, color: TEXT }}>Replication Pairs</div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}>Source</th>
                  <th style={thStyle}>Target</th>
                  <th style={thStyle}>Objects</th>
                  <th style={thStyle}>Lag</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Last Sync</th>
                </tr>
              </thead>
              <tbody>
                {data.pairs.map((p) => (
                  <tr key={p.id} style={{ background: p.status === 'Lagging' ? `${AMBER}14` : 'transparent' }}>
                    <td style={tdStyle}>{p.sourceCluster}</td>
                    <td style={tdStyle}>{p.targetCluster}</td>
                    <td style={tdStyle}>{p.objects}</td>
                    <td style={{ ...tdStyle, color: p.status === 'Lagging' ? AMBER : TEXT }}>{formatLag(p.lagSeconds)}</td>
                    <td style={tdStyle}>
                      <StatusPill status={p.status} />
                    </td>
                    <td style={tdStyle}>{formatWhen(p.lastSyncAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ marginTop: 10, fontSize: 12, color: MUTED }}>
              {data.pairs.map((p) => `${p.sourceCluster} → ${p.targetCluster}`).join('   •   ')}
            </div>
          </div>

          <div style={panelStyle()}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, color: TEXT }}>Archival Locations</div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Type</th>
                  <th style={thStyle}>Archived</th>
                  <th style={thStyle}>Objects</th>
                  <th style={thStyle}>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.archival.map((a) => (
                  <tr key={a.id}>
                    <td style={tdStyle}>{a.name}</td>
                    <td style={tdStyle}>
                      <span
                        style={{
                          padding: '2px 8px',
                          borderRadius: 4,
                          fontSize: 11,
                          background: a.type === 'S3' ? `${AMBER}26` : '#3b82f626',
                          color: a.type === 'S3' ? AMBER : '#60a5fa',
                          border: `1px solid ${a.type === 'S3' ? AMBER : '#3b82f6'}`,
                        }}
                      >
                        {a.type}
                      </span>
                    </td>
                    <td style={tdStyle}>{formatBytes(a.archivedBytes)}</td>
                    <td style={tdStyle}>{a.objectCount}</td>
                    <td style={tdStyle}>
                      <StatusPill status={a.status === 'Active' ? 'Succeeded' : a.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </PageShell>
  );
}

function ForecastPage() {
  const { data, error } = useFetch('/capacity');
  const clusters = (data && data.clusters) || [];
  const [selected, setSelected] = React.useState(null);
  const active = clusters.find((c) => c.cluster === selected) || clusters[0];

  return (
    <PageShell title="Rubrik Capacity Forecast" error={error}>
      {clusters.length > 0 && (
        <>
          <div style={{ marginBottom: 12, display: 'flex', gap: 8 }}>
            {clusters.map((c) => (
              <button
                key={c.cluster}
                onClick={() => setSelected(c.cluster)}
                style={{
                  padding: '6px 12px',
                  fontSize: 12,
                  borderRadius: 6,
                  cursor: 'pointer',
                  border: `1px solid ${(active && active.cluster) === c.cluster ? ACCENT : BORDER}`,
                  background: (active && active.cluster) === c.cluster ? `${ACCENT}26` : PANEL_BG,
                  color: (active && active.cluster) === c.cluster ? ACCENT : TEXT,
                }}
              >
                {c.cluster}
              </button>
            ))}
          </div>
          {active && (
            <div style={panelStyle()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: TEXT }}>{active.cluster}</div>
                <div style={{ fontSize: 13, color: active.runwayDays <= 60 ? RED : AMBER }}>
                  reaches capacity in ~{active.runwayDays} days
                </div>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <LineArea
                  history={active.series.map((s) => ({ x: s.day, value: s.usedBytes }))}
                  forecast={active.forecast.map((f) => ({ x: f.day, value: f.usedBytes }))}
                  capacity={active.capacityBytes}
                  width={720}
                  height={240}
                  yFormat={(v) => formatBytes(v)}
                />
              </div>
              <div style={{ display: 'flex', gap: 24, marginTop: 12, fontSize: 12, color: MUTED }}>
                <span>
                  <span style={{ display: 'inline-block', width: 18, height: 2, background: ACCENT, marginRight: 6, verticalAlign: 'middle' }} />
                  90d history
                </span>
                <span>
                  <span style={{ display: 'inline-block', width: 18, height: 2, background: AMBER, marginRight: 6, verticalAlign: 'middle', borderTop: `2px dashed ${AMBER}` }} />
                  90d forecast
                </span>
                <span>growth ≈ {formatBytes(active.growthPerDayBytes * 30)}/month</span>
              </div>
            </div>
          )}
        </>
      )}
    </PageShell>
  );
}

window.__ICC_REGISTER_PLUGIN__({
  id: 'rubrik',
  label: 'Rubrik',
  color: ACCENT,
  switcherRoute: '/rubrik',
  basePath: '/rubrik',
  isActive: (p) => p.startsWith('/rubrik'),
  navGroups: [
    {
      label: 'Monitor',
      items: [
        { label: 'Overview', route: '/rubrik', isActive: (p) => p === '/rubrik' },
        { label: 'Events', route: '/rubrik/events', isActive: (p) => p === '/rubrik/events' },
      ],
    },
    {
      label: 'Protection',
      items: [
        { label: 'Protected Objects', route: '/rubrik/objects', isActive: (p) => p === '/rubrik/objects' },
        { label: 'SLA Domains', route: '/rubrik/sla', isActive: (p) => p === '/rubrik/sla' },
        { label: 'Compliance', route: '/rubrik/compliance', isActive: (p) => p === '/rubrik/compliance' },
        { label: 'Jobs', route: '/rubrik/jobs', isActive: (p) => p === '/rubrik/jobs' },
      ],
    },
    {
      label: 'Security',
      items: [{ label: 'Threat Monitoring', route: '/rubrik/security', isActive: (p) => p === '/rubrik/security' }],
    },
    {
      label: 'Data Movement',
      items: [{ label: 'Replication & Archival', route: '/rubrik/replication', isActive: (p) => p === '/rubrik/replication' }],
    },
    {
      label: 'Capacity',
      items: [
        { label: 'Clusters', route: '/rubrik/clusters', isActive: (p) => p === '/rubrik/clusters' },
        { label: 'Forecast', route: '/rubrik/forecast', isActive: (p) => p === '/rubrik/forecast' },
      ],
    },
  ],
  routes: [
    { path: 'rubrik', Component: OverviewPage },
    { path: 'rubrik/events', Component: EventsPage },
    { path: 'rubrik/clusters', Component: ClustersPage },
    { path: 'rubrik/objects', Component: ObjectsPage },
    { path: 'rubrik/sla', Component: SlaDomainsPage },
    { path: 'rubrik/compliance', Component: CompliancePage },
    { path: 'rubrik/jobs', Component: JobsPage },
    { path: 'rubrik/security', Component: SecurityPage },
    { path: 'rubrik/replication', Component: ReplicationPage },
    { path: 'rubrik/forecast', Component: ForecastPage },
  ],
});
