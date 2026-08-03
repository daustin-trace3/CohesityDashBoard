// Rubrik Overview — true clone of the host Cohesity Dashboard.jsx (Report B),
// substituting Rubrik data + the rbk- style kit. No Tailwind, no 'react'
// import (React/ReactDOM/ReactRouterDOM are build-banner globals).

import {
  injectStyles, Panel, Badge, EmptyState, LoadingPanel, SkeletonTable, StatCard,
  timeAgo as kitTimeAgo, CsvExportButton,
  DbIcon, ServerIcon, BellIcon, ShieldIcon, ChartIcon, XIcon,
  ClipboardIcon, ArrowsIcon, LockIcon, ChevronUpIcon, ChevronDownIcon,
} from '../ui.jsx';
import { Donut, LineChart, HBar, SparkLine } from '../charts.jsx';

injectStyles();

/* ────────────────────────────────────────────────────────────────────────
 * Local icons not present in ui.jsx (kept file-local per WP2 edit scope —
 * ui.jsx is read-only)
 * ────────────────────────────────────────────────────────────────────── */
function LIcon({ children, size = 16, className, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>
      {children}
    </svg>
  );
}
const SparklesIcon = (p) => <LIcon {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2 2M16 16l2 2M18 6l-2 2M8 16l-2 2" /><path d="M12 8l1.5 3L17 12.5 13.5 14 12 17.5 10.5 14 7 12.5 10.5 11z" /></LIcon>;
const AlertOctagonIcon = (p) => <LIcon {...p}><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2" /><path d="M12 8v5M12 16v.01" /></LIcon>;
const AlertTriangleIcon = (p) => <LIcon {...p}><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" /><path d="M12 9v4M12 17h.01" /></LIcon>;
const InfoIcon = (p) => <LIcon {...p}><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></LIcon>;
const CheckCircleIcon = (p) => <LIcon {...p}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><path d="M22 4 12 14.01l-3-3" /></LIcon>;
const LightbulbIcon = (p) => <LIcon {...p}><path d="M9 18h6M10 22h4" /><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2.05V17h6v-.25c0-.85.4-1.55 1-2.05A7 7 0 0 0 12 2Z" /></LIcon>;
const ChevronRightIcon = (p) => <LIcon {...p}><path d="M9 18l6-6-6-6" /></LIcon>;
const WifiOffIcon = (p) => <LIcon {...p}><path d="M1 1l22 22M16.72 11.06A10.94 10.94 0 0 1 19 12.55M5 12.55a10.94 10.94 0 0 1 5.17-2.39M10.71 5.05A16 16 0 0 1 22.58 9M1.42 9a15.91 15.91 0 0 1 4.7-2.88M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01" /></LIcon>;
const GaugeIcon = (p) => <LIcon {...p}><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" /><path d="M12 3a9 9 0 0 0-9 9M12 3a9 9 0 0 1 9 9M12 12l4-3" /></LIcon>;
const GlobeIcon = (p) => <LIcon {...p}><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20Z" /></LIcon>;
const ListFilterIcon = (p) => <LIcon {...p}><path d="M3 6h18M6 12h12M10 18h4" /></LIcon>;
const LayoutGridIcon = (p) => <LIcon {...p}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></LIcon>;
const HardDriveIcon = (p) => <LIcon {...p}><line x1="22" y1="12" x2="2" y2="12" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z" /><line x1="6" y1="16" x2="6.01" y2="16" /><line x1="10" y1="16" x2="10.01" y2="16" /></LIcon>;
const RotateCcwIcon = (p) => <LIcon {...p}><path d="M1 4v6h6" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></LIcon>;

/* ────────────────────────────────────────────────────────────────────────
 * Helpers — mirror Dashboard.jsx conventions (Report B)
 * ────────────────────────────────────────────────────────────────────── */
function toTB(bytes) {
  if (!bytes) return 0;
  return parseFloat((bytes / 1e12).toFixed(2));
}

function fmtBytes(b) {
  if (b == null || b === 0) return '—';
  if (b >= 1e15) return (b / 1e15).toFixed(2) + ' PB';
  if (b >= 1e12) return (b / 1e12).toFixed(2) + ' TB';
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
  return (b / 1e6).toFixed(1) + ' MB';
}

function timeAgo(ts) {
  if (!ts) return 'Never';
  const label = kitTimeAgo(ts);
  return label || 'Never';
}

function pctColor(pct) {
  return pct >= 86 ? '#F87171' : pct >= 70 ? '#FBBF24' : '#00B388';
}

function clusterOnlineStatus(c) {
  return c.status === 'Connected' ? 'green' : 'red';
}

function ClusterStatusOrb({ status, size = 8, title }) {
  const colors = { green: '#34D399', yellow: '#FBBF24', red: '#F87171', gray: '#5F7081' };
  const color = colors[status] || colors.gray;
  return (
    <span title={title} style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
      <span
        style={{
          display: 'inline-block',
          width: size,
          height: size,
          borderRadius: '50%',
          backgroundColor: color,
          boxShadow: `0 0 ${size / 2}px ${color}99`,
          animation: status === 'green' ? 'rbk-orb-pulse 2.5s ease-in-out infinite' : 'none',
        }}
      />
    </span>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Data fetching
 * ────────────────────────────────────────────────────────────────────── */
function useRubrikFetch(path) {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(false);

  const load = React.useCallback(() => {
    setLoading(true);
    setError(false);
    return fetch(`/api/rubrik${path}`, { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`request failed: ${res.status}`);
        return res.json();
      })
      .then((json) => setData(json))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [path]);

  React.useEffect(() => { load(); }, [load]);

  return { data, loading, error, refetch: load };
}

/* ────────────────────────────────────────────────────────────────────────
 * ROW 1 — Intelligent Insights (clone of InsightsPanel.jsx)
 * ────────────────────────────────────────────────────────────────────── */
const SEVERITY = {
  critical: { icon: AlertOctagonIcon, color: 'var(--rbk-crit)', bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.3)' },
  warning: { icon: AlertTriangleIcon, color: 'var(--rbk-warn)', bg: 'rgba(251,191,36,0.1)', border: 'rgba(251,191,36,0.3)' },
  info: { icon: InfoIcon, color: 'var(--rbk-info)', bg: 'rgba(96,165,250,0.1)', border: 'rgba(96,165,250,0.3)' },
  ok: { icon: CheckCircleIcon, color: 'var(--rbk-ok)', bg: 'rgba(52,211,153,0.1)', border: 'rgba(52,211,153,0.3)' },
};

const CATEGORY_ICON = {
  capacity: DbIcon,
  availability: WifiOffIcon,
  alerts: BellIcon,
  protection: ShieldIcon,
  replication: ArrowsIcon,
  efficiency: GaugeIcon,
  governance: ClipboardIcon,
  health: CheckCircleIcon,
  security: LockIcon,
  licensing: ClipboardIcon,
};

function insightRoute(insight) {
  switch (insight.category) {
    case 'alerts': return '/rubrik/alerts';
    case 'protection': return '/rubrik/data-protection';
    case 'replication': return '/rubrik/replication';
    case 'governance': return '/rubrik/governance';
    case 'capacity':
    case 'availability':
    case 'efficiency':
      return '/rubrik/clusters';
    case 'security': return '/rubrik/security';
    case 'licensing': return '/rubrik/licensing';
    default: return null;
  }
}

function InsightRow({ insight }) {
  const sev = SEVERITY[insight.severity] || SEVERITY.info;
  const SevIcon = sev.icon;
  const CatIcon = CATEGORY_ICON[insight.category] || InfoIcon;
  const navigate = ReactRouterDOM.useNavigate();
  const route = insightRoute(insight);
  return (
    <div
      onClick={route ? () => navigate(route) : undefined}
      role={route ? 'button' : undefined}
      tabIndex={route ? 0 : undefined}
      className="rbk-fade-in"
      style={{
        borderRadius: 8, border: `1px solid ${sev.border}`, background: sev.bg,
        padding: '12px 14px', display: 'flex', gap: 12, cursor: route ? 'pointer' : 'default',
        transition: 'filter 150ms',
      }}
      onMouseEnter={(e) => { if (route) e.currentTarget.style.filter = 'brightness(1.2)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.filter = 'none'; }}
    >
      <SevIcon size={17} style={{ color: sev.color, flexShrink: 0, marginTop: 2 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--rbk-ink)' }}>{insight.title}</p>
          <Badge tone="neutral"><CatIcon size={10} />{insight.category}</Badge>
        </div>
        {insight.detail && <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--rbk-ink-muted)', lineHeight: 1.5 }}>{insight.detail}</p>}
        {insight.recommendation && (
          <p style={{ margin: '6px 0 0', fontSize: 12, display: 'flex', gap: 6, alignItems: 'flex-start', lineHeight: 1.5 }}>
            <LightbulbIcon size={13} style={{ color: 'var(--rbk-brand)', flexShrink: 0, marginTop: 1 }} />
            <span style={{ color: 'var(--rbk-ink)' }}><span style={{ fontWeight: 600, color: 'var(--rbk-brand)' }}>Recommended:</span> {insight.recommendation}</span>
          </p>
        )}
      </div>
      {route && <ChevronRightIcon size={16} style={{ color: 'var(--rbk-ink-faint)', alignSelf: 'center', flexShrink: 0 }} />}
    </div>
  );
}

const COLLAPSED_COUNT = 4;

function InsightsPanel() {
  const { data, loading, error, refetch } = useRubrikFetch('/insights');
  const [expanded, setExpanded] = React.useState(false);

  React.useEffect(() => {
    const interval = setInterval(refetch, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [refetch]);

  const insights = data?.insights || [];
  const visible = expanded ? insights : insights.slice(0, COLLAPSED_COUNT);
  const summary = data?.summary;

  return (
    <div className="rbk-panel" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'flex', height: 28, width: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'rgba(0,179,136,0.1)', border: '1px solid rgba(0,179,136,0.2)' }}>
            <SparklesIcon size={14} style={{ color: 'var(--rbk-brand)' }} />
          </div>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--rbk-ink)' }}>Intelligent Insights</p>
          {summary && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 4 }}>
              {summary.critical > 0 && <Badge tone="crit">{summary.critical} critical</Badge>}
              {summary.warning > 0 && <Badge tone="warn">{summary.warning} warning</Badge>}
              {summary.info > 0 && <Badge tone="info">{summary.info} info</Badge>}
              {summary.critical === 0 && summary.warning === 0 && summary.info === 0 && <Badge tone="ok">All clear</Badge>}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {data?.generatedAt && (
            <span style={{ fontSize: 10, color: 'var(--rbk-ink-faint)' }}>Updated {new Date(data.generatedAt).toLocaleTimeString()}</span>
          )}
          <button
            onClick={refetch}
            disabled={loading}
            aria-label="Refresh insights"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 28, width: 28, borderRadius: 8, border: '1px solid var(--rbk-border)', background: 'transparent', color: 'var(--rbk-ink-muted)', cursor: 'pointer' }}
          >
            <RotateCcwIcon size={13} style={loading ? { animation: 'rbk-spin 0.8s linear infinite' } : undefined} />
          </button>
        </div>
      </div>

      {loading && !data ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '24px 0', color: 'var(--rbk-ink-muted)', fontSize: 12 }}>
          <span className="rbk-skeleton" style={{ width: 16, height: 16, borderRadius: '50%' }} /> Analyzing estate for risks and recommendations…
        </div>
      ) : error ? (
        <p style={{ textAlign: 'center', padding: '16px 0', fontSize: 12, color: 'var(--rbk-ink-muted)' }}>
          Could not load insights. <button onClick={refetch} style={{ color: 'var(--rbk-brand)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Retry</button>
        </p>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {visible.map((ins, i) => <InsightRow key={`${ins.category}-${ins.clusterName ?? 'g'}-${i}`} insight={ins} />)}
          </div>
          {insights.length > COLLAPSED_COUNT && (
            <button
              onClick={() => setExpanded((e) => !e)}
              style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, color: 'var(--rbk-brand)', background: 'none', border: 'none', cursor: 'pointer' }}
            >
              {expanded ? <><ChevronUpIcon size={14} /> Show fewer</> : <><ChevronDownIcon size={14} /> Show all {insights.length} insights</>}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Cluster Health card (clone of ClusterCard.jsx)
 * ────────────────────────────────────────────────────────────────────── */
function HardwareModal({ cluster, onClose }) {
  if (!cluster) return null;
  const rows = [
    ['Model', cluster.model || '—'],
    ['Nodes', cluster.nodes ?? '—'],
    ['Software Version', cluster.version || '—'],
    ['Version Status', cluster.versionStatus || '—'],
    ['Connection Status', cluster.status || '—'],
    ['Runway (days)', cluster.runwayDays ?? '—'],
    ['Used', fmtBytes(cluster.usedBytes)],
    ['Capacity', fmtBytes(cluster.capacityBytes)],
  ];
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.7)', backdropFilter: 'blur(4px)' }} />
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" className="rbk-panel" style={{ position: 'relative', width: 'min(440px,90vw)', padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--rbk-ink)' }}>{cluster.name}</p>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--rbk-ink-faint)', cursor: 'pointer' }}><XIcon size={18} /></button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px', fontSize: 12 }}>
          {rows.map(([label, value]) => (
            <div key={label}>
              <p style={{ margin: 0, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--rbk-ink-faint)' }}>{label}</p>
              <p className="rbk-tnum" style={{ margin: 0, color: 'var(--rbk-ink)' }}>{value}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ClusterHealthCard({ cluster, selected, onSelect, onModelClick }) {
  const [hwOpen, setHwOpen] = React.useState(false);
  const pct = cluster.usedPct ?? 0;
  const color = pctColor(pct);
  const pulsing = pct >= 90;
  const status = clusterOnlineStatus(cluster);
  const alertLevel = cluster.alertLevel || 'none';
  const alertColor = alertLevel === 'critical' ? '#F87171' : alertLevel === 'warning' ? '#FBBF24' : '#6b7280';

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={() => onSelect(cluster.name)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(cluster.name); } }}
        className={pulsing ? 'rbk-pulse-crit' : undefined}
        style={{
          border: `1px solid ${selected ? 'var(--rbk-brand)' : pulsing ? '#F87171' : 'var(--rbk-border)'}`,
          background: selected ? 'rgba(0,179,136,0.1)' : 'var(--rbk-surface)',
          borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 6, cursor: 'pointer',
          transition: 'border-color 200ms',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <ClusterStatusOrb status={status} size={8} title={`${status === 'green' ? 'Online' : 'Offline'} · Status: ${cluster.status || 'Unknown'}`} />
              <p style={{ margin: 0, fontSize: 12, fontWeight: 600, color: 'var(--rbk-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cluster.name}</p>
            </div>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onModelClick && onModelClick(cluster.model); }}
              style={{ marginTop: 2, fontSize: 11, color: 'var(--rbk-brand)', background: 'rgba(0,179,136,0.05)', border: '1px solid rgba(0,179,136,0.2)', borderRadius: 999, padding: '1px 8px', cursor: 'pointer' }}
            >
              {cluster.model || '—'}
            </button>
          </div>
          {cluster.alertCount > 0 && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, fontSize: 12, fontWeight: 600, color: alertColor }}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 2L14 13H2L8 2Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><path d="M8 6v3M8 11v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              {cluster.alertCount}
            </span>
          )}
        </div>

        <div className="rbk-tnum" style={{ fontSize: 24, fontWeight: 700, color, lineHeight: 1 }}>{pct.toFixed(1)}%</div>
        <div style={{ height: 6, background: 'var(--rbk-surface-base)', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: color, transition: 'width 500ms' }} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 8px', fontSize: 11 }}>
          <div>
            <p style={{ margin: 0, color: 'var(--rbk-ink-faint)', textTransform: 'uppercase', fontSize: 10 }}>Used</p>
            <p style={{ margin: 0, color: 'var(--rbk-ink)' }}>{fmtBytes(cluster.usedBytes)}</p>
          </div>
          <div>
            <p style={{ margin: 0, color: 'var(--rbk-ink-faint)', textTransform: 'uppercase', fontSize: 10 }}>Capacity</p>
            <p style={{ margin: 0, color: 'var(--rbk-ink)' }}>{fmtBytes(cluster.capacityBytes)}</p>
          </div>
          <div>
            <p style={{ margin: 0, color: 'var(--rbk-ink-faint)', textTransform: 'uppercase', fontSize: 10 }}>Available</p>
            <p style={{ margin: 0, color: 'var(--rbk-ink)' }}>{fmtBytes(cluster.availableBytes > 0 ? cluster.availableBytes : null)}</p>
          </div>
          <div>
            <p style={{ margin: 0, color: 'var(--rbk-ink-faint)', textTransform: 'uppercase', fontSize: 10 }}>Savings</p>
            <p style={{ margin: 0, color: 'var(--rbk-ink)' }}>{cluster.savingsX != null && cluster.savingsX > 0 ? `${cluster.savingsX.toFixed(2)}x` : '—'}</p>
          </div>
        </div>

        {cluster.spark && cluster.spark.length >= 2 && (
          <div style={{ opacity: 0.6 }}>
            <SparkLine points={cluster.spark} color={color} width={100} height={24} />
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }}>
          {cluster.version ? <p style={{ margin: 0, fontSize: 11, color: 'var(--rbk-ink-faint)' }}>v{cluster.version}</p> : <span />}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setHwOpen(true); }}
            style={{ fontSize: 11, color: 'var(--rbk-ink-faint)', border: '1px solid var(--rbk-border)', borderRadius: 6, padding: '2px 6px', background: 'transparent', cursor: 'pointer' }}
          >
            HW Info
          </button>
        </div>
      </div>
      {hwOpen && <HardwareModal cluster={cluster} onClose={() => setHwOpen(false)} />}
    </>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Alert detail modal (width scales with message length, per Report B)
 * ────────────────────────────────────────────────────────────────────── */
function AlertDetailModal({ alert, onClose }) {
  if (!alert) return null;
  const severity = alert.severity || 'info';
  const tone = severity === 'critical' ? 'crit' : severity === 'warning' ? 'warn' : 'info';
  const fmtTime = (ts) => {
    if (!ts) return '—';
    try { return new Date(ts.replace(' ', 'T') + (ts.includes('T') ? '' : 'Z')).toLocaleString(); } catch { return ts; }
  };
  const msg = alert.description || '';
  const width = msg.length > 300 ? 'min(860px,90vw)' : msg.length > 120 ? 'min(680px,90vw)' : 'min(520px,90vw)';
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.7)', backdropFilter: 'blur(4px)' }} />
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" className="rbk-panel" style={{ position: 'relative', width, padding: 20, boxShadow: '0 24px 64px rgba(0,0,0,.6)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <AlertTriangleIcon size={18} style={{ color: tone === 'crit' ? 'var(--rbk-crit)' : tone === 'warn' ? 'var(--rbk-warn)' : 'var(--rbk-info)' }} />
            <div>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--rbk-ink)' }}>{alert.alertType || 'Alert'}</p>
              <Badge tone={tone} style={{ marginTop: 6, textTransform: 'uppercase' }}>{severity}</Badge>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--rbk-ink-faint)', cursor: 'pointer' }}><XIcon size={18} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
          <div style={{ display: 'flex', gap: 12 }}><span style={{ color: 'var(--rbk-ink-faint)', width: 80, flexShrink: 0 }}>Cluster</span><span style={{ color: 'var(--rbk-ink)' }}>{alert.cluster || '—'}</span></div>
          <div style={{ display: 'flex', gap: 12 }}><span style={{ color: 'var(--rbk-ink-faint)', width: 80, flexShrink: 0 }}>Triggered</span><span className="rbk-tnum" style={{ color: 'var(--rbk-ink)' }}>{fmtTime(alert.firstSeen)}</span></div>
          {alert.objectName && <div style={{ display: 'flex', gap: 12 }}><span style={{ color: 'var(--rbk-ink-faint)', width: 80, flexShrink: 0 }}>Object</span><span style={{ color: 'var(--rbk-ink)' }}>{alert.objectName}</span></div>}
          {msg && <div style={{ display: 'flex', gap: 12 }}><span style={{ color: 'var(--rbk-ink-faint)', width: 80, flexShrink: 0 }}>Message</span><span style={{ color: 'var(--rbk-ink)', lineHeight: 1.5 }}>{msg}</span></div>}
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Main page
 * ────────────────────────────────────────────────────────────────────── */
const CLUSTER_PAGE_SIZE = 6;
const TREND_COLORS = ['#00B388', '#3b82f6', '#f59e0b', '#a855f7', '#06b6d4', '#f97316', '#ec4899', '#10b981', '#6366f1', '#84cc16', '#14b8a6', '#f43f5e', '#8b5cf6', '#fbbf24', '#34d399'];

function linReg(pts) {
  const n = pts.length;
  if (n < 2) return null;
  const sumX = pts.reduce((s, p) => s + p.x, 0);
  const sumY = pts.reduce((s, p) => s + p.y, 0);
  const sumXY = pts.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = pts.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

export default function OverviewPage() {
  const { data: overviewData, loading: overviewLoading, refetch: refetchOverview } = useRubrikFetch('/overview');
  const { data: clustersData, loading: clustersLoading, refetch: refetchClusters } = useRubrikFetch('/clusters');
  const { data: capacityData, refetch: refetchCapacity } = useRubrikFetch('/capacity');

  const [modelFilter, setModelFilter] = React.useState('all');
  const [slaFilter, setSlaFilter] = React.useState('all');
  const [criticalOnly, setCriticalOnly] = React.useState(false);
  const [localSearch, setLocalSearch] = React.useState('');
  const [selectedNames, setSelectedNames] = React.useState(new Set());
  const [trendDays, setTrendDays] = React.useState(7);
  const [clusterPage, setClusterPage] = React.useState(0);
  const [selectedAlert, setSelectedAlert] = React.useState(null);
  const [polling, setPolling] = React.useState(false);
  const [pollMsg, setPollMsg] = React.useState(null);

  const [slaDomains, setSlaDomains] = React.useState([]);
  React.useEffect(() => {
    fetch('/api/rubrik/sla-domains', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => setSlaDomains(rows || []))
      .catch(() => {});
  }, []);

  const loading = overviewLoading || clustersLoading;
  const kpis = overviewData?.kpis || {};
  const protectionSummary = overviewData?.protectionSummary || null;
  const recentCriticalAlerts = overviewData?.recentCriticalAlerts || [];

  // Merge /clusters + /overview.clusterCards by name (Report C mapping)
  const clusters = React.useMemo(() => {
    const cardsByName = new Map((overviewData?.clusterCards || []).map((c) => [c.cluster, c]));
    return (clustersData || []).map((c) => {
      const card = cardsByName.get(c.name) || {};
      const usedBytes = card.usedBytes ?? c.usedBytes;
      const capacityBytes = card.capacityBytes ?? c.capacityBytes;
      return {
        id: c.id,
        name: c.name,
        model: c.model,
        nodes: c.nodes,
        version: c.version,
        versionStatus: c.versionStatus,
        status: c.status,
        runwayDays: c.runwayDays,
        usedBytes,
        capacityBytes,
        availableBytes: card.availableBytes ?? Math.max(0, capacityBytes - usedBytes),
        savingsX: card.savingsX,
        spark: card.spark || [],
        alertCount: card.alertCount ?? 0,
        alertLevel: card.alertLevel ?? 'none',
        usedPct: card.usedPct ?? (capacityBytes > 0 ? (usedBytes / capacityBytes) * 100 : 0),
      };
    });
  }, [clustersData, overviewData]);

  const allModels = [...new Set(clusters.map((c) => c.model).filter(Boolean))].sort();

  const filtered = clusters.filter((c) => {
    if (localSearch && !c.name.toLowerCase().includes(localSearch.toLowerCase())) return false;
    if (modelFilter !== 'all' && c.model !== modelFilter) return false;
    if (criticalOnly && c.alertLevel !== 'critical') return false;
    return true;
  });

  const sortedFiltered = [...filtered].sort((a, b) => (b.usedPct || 0) - (a.usedPct || 0));

  const activeSet = selectedNames.size > 0
    ? sortedFiltered.filter((c) => selectedNames.has(c.name))
    : sortedFiltered;

  const clusterTotalPages = Math.max(1, Math.ceil(sortedFiltered.length / CLUSTER_PAGE_SIZE));
  const clusterSafePage = Math.min(clusterPage, clusterTotalPages - 1);
  const clusterPageItems = sortedFiltered.slice(clusterSafePage * CLUSTER_PAGE_SIZE, (clusterSafePage + 1) * CLUSTER_PAGE_SIZE);

  const toggleSelect = (name) => {
    setSelectedNames((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  // KPI aggregates
  const kpiCap = kpis.totalCapacityBytes ?? 0;
  const kpiUsed = kpis.usedBytes ?? 0;
  const kpiFree = kpis.freeBytes ?? Math.max(0, kpiCap - kpiUsed);
  const kpiPct = kpis.usedPct ?? (kpiCap > 0 ? (kpiUsed / kpiCap) * 100 : 0);
  const onlineCount = kpis.clustersOnline ?? clusters.filter((c) => c.status === 'Connected').length;
  const clustersTotal = kpis.clustersTotal ?? clusters.length;
  const successRate = protectionSummary?.successRate ?? kpis.successRate7d;

  // Top clusters / storage distribution use activeSet
  const chartData = activeSet
    .filter((c) => c.capacityBytes > 0)
    .map((c) => ({ name: c.name, pct: c.usedPct || 0 }))
    .sort((a, b) => b.pct - a.pct);

  // Global storage utilization (scoped to activeSet, mirrors host semantics)
  const gsuUsed = activeSet.reduce((s, c) => s + (c.usedBytes || 0), 0);
  const gsuCap = activeSet.reduce((s, c) => s + (c.capacityBytes || 0), 0);
  const gsuPct = gsuCap > 0 ? (gsuUsed / gsuCap) * 100 : 0;
  const drValues = activeSet.map((c) => c.savingsX).filter((v) => v != null && v > 0);
  const avgDR = drValues.length > 0 ? drValues.reduce((s, v) => s + v, 0) / drValues.length : 0;

  // Capacity growth trend + forecast + growth table (Report B §3B math)
  const trend = React.useMemo(() => {
    const capClusters = capacityData?.clusters || [];
    const activeNames = new Set(activeSet.map((c) => c.name));
    const scoped = capClusters.filter((c) => activeNames.has(c.cluster));
    const cutoff = new Date(Date.now() - trendDays * 86400000).getTime();

    const series = [];
    const growthSummaries = [];
    let idx = 0;
    let maxHistLen = 0;

    const perCluster = scoped.map((c, i) => {
      const rows = (c.series || []).filter((r) => new Date(r.day).getTime() >= cutoff);
      maxHistLen = Math.max(maxHistLen, rows.length);
      return { c, rows, color: TREND_COLORS[i % TREND_COLORS.length] };
    });

    const maxUsed = Math.max(1, ...perCluster.flatMap((p) => p.rows.map((r) => r.usedBytes)), ...perCluster.map((p) => p.c.capacityBytes || 0));
    const unit = maxUsed >= 1e15 ? { div: 1e15, label: 'PB' } : maxUsed >= 1e12 ? { div: 1e12, label: 'TB' } : maxUsed >= 1e9 ? { div: 1e9, label: 'GB' } : { div: 1e6, label: 'MB' };

    const FORECAST_STEPS = 14;
    const refLines = [];

    perCluster.forEach(({ c, rows, color }) => {
      if (rows.length === 0) return;
      const histPts = rows.map((r) => ({ x: r.x, y: r.usedBytes / unit.div }));
      series.push({ label: c.cluster, color, points: histPts });

      const regPts = rows.map((r) => ({ x: new Date(r.day).getTime(), y: r.usedBytes }));
      const reg = linReg(regPts);
      const lastUsed = rows[rows.length - 1].usedBytes;
      const growthBytesPerDay = reg ? reg.slope * 86400000 : 0;

      let daysUntil85 = null;
      let daysUntil90 = null;
      if (reg && reg.slope > 0 && c.capacityBytes > 0) {
        const d85 = (c.capacityBytes * 0.85 - lastUsed) / growthBytesPerDay;
        const d90 = (c.capacityBytes * 0.90 - lastUsed) / growthBytesPerDay;
        daysUntil85 = d85 > 0 && d85 <= 999 ? d85 : null;
        daysUntil90 = d90 > 0 && d90 <= 999 ? d90 : null;
      }
      growthSummaries.push({ name: c.cluster, growthBytesPerDay, daysUntil85, daysUntil90 });

      if (reg && reg.slope > 0) {
        const bridge = { x: histPts[histPts.length - 1].x, y: histPts[histPts.length - 1].y };
        const projected = [bridge];
        for (let j = 1; j <= FORECAST_STEPS; j++) {
          const futureMs = regPts[regPts.length - 1].x + j * 86400000;
          const y = (reg.intercept + reg.slope * futureMs) / unit.div;
          projected.push({ x: bridge.x + j, y: y > 0 ? y : 0 });
        }
        series.push({ label: `${c.cluster} (proj.)`, color, dashed: true, points: projected });
      }

      if (perCluster.length <= 6 && c.capacityBytes > 0) {
        refLines.push({ y: c.capacityBytes / unit.div, color: color + '44', dash: '2 4' });
        refLines.push({ y: (c.capacityBytes * 0.85) / unit.div, color: '#f59e0b44', dash: '2 4' });
      }
    });

    return { series, refLines, unit, clusterCount: perCluster.length, growthSummaries, hasData: series.length > 0 };
  }, [capacityData, activeSet, trendDays]);

  const handlePollAll = () => {
    setPolling(true);
    setPollMsg(null);
    Promise.allSettled([refetchOverview(), refetchClusters(), refetchCapacity()]).then(() => {
      setPolling(false);
      setPollMsg(`All ${clusters.length} cluster(s) refreshed successfully.`);
      setTimeout(() => setPollMsg(null), 4000);
    });
  };

  return (
    <div className="rbk-root rbk-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {selectedAlert && <AlertDetailModal alert={selectedAlert} onClose={() => setSelectedAlert(null)} />}

      {/* ROW 0 — KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 12 }} className="rbk-kpi-grid">
        <style>{`
          @media (min-width: 768px) { .rbk-kpi-grid { grid-template-columns: repeat(3,1fr) !important; } }
          @media (min-width: 1280px) { .rbk-kpi-grid { grid-template-columns: repeat(5,1fr) !important; } }
        `}</style>
        <StatCard icon={DbIcon} label="Total Capacity" value={fmtBytes(kpiCap)} sub={`${fmtBytes(kpiFree)} free`} tone="brand" loading={loading} />
        <StatCard icon={HardDriveIcon} label="Storage Used" value={`${kpiPct.toFixed(1)}%`} sub={fmtBytes(kpiUsed)} tone={kpiPct >= 86 ? 'crit' : kpiPct >= 70 ? 'warn' : 'ok'} loading={loading} />
        <StatCard icon={ServerIcon} label="Clusters Online" value={`${onlineCount} / ${clustersTotal}`} sub={onlineCount === clustersTotal ? 'All reachable' : `${clustersTotal - onlineCount} need attention`} tone={onlineCount === clustersTotal ? 'ok' : 'warn'} loading={loading} />
        <StatCard icon={BellIcon} label="Active Alerts" value={kpis.activeAlerts ?? '—'} sub={(kpis.criticalAlerts ?? 0) > 0 ? `${kpis.criticalAlerts} critical` : 'No criticals'} tone={(kpis.criticalAlerts ?? 0) > 0 ? 'crit' : (kpis.activeAlerts ?? 0) > 0 ? 'warn' : 'ok'} loading={loading} />
        <StatCard icon={ShieldIcon} label="Backup Success (7d)" value={successRate != null ? `${successRate}%` : '—'} sub={protectionSummary ? `${protectionSummary.failure} failed of ${protectionSummary.total}` : 'Awaiting data'} tone={successRate == null ? 'default' : successRate >= 95 ? 'ok' : successRate >= 85 ? 'warn' : 'crit'} loading={loading} />
      </div>

      {/* ROW 1 — Intelligent insights */}
      <InsightsPanel />

      {/* ROW 2 — Filter bar */}
      <div className="rbk-panel" style={{ padding: '10px 14px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 12 }}>
        <ListFilterIcon size={14} style={{ color: 'var(--rbk-ink-faint)' }} />
        <input
          value={localSearch}
          onChange={(e) => setLocalSearch(e.target.value)}
          placeholder="Search clusters…"
          aria-label="Search clusters"
          className="rbk-input"
          style={{ width: 160 }}
        />
        <select value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} aria-label="Filter by model" className="rbk-input" style={{ width: 'auto', cursor: 'pointer' }}>
          <option value="all">All Models</option>
          {allModels.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={slaFilter} onChange={(e) => setSlaFilter(e.target.value)} aria-label="Filter by SLA domain" className="rbk-input" style={{ width: 'auto', cursor: 'pointer' }}>
          <option value="all">All SLAs</option>
          {slaDomains.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--rbk-ink-muted)', cursor: 'pointer' }}>
          <input type="checkbox" checked={criticalOnly} onChange={(e) => setCriticalOnly(e.target.checked)} style={{ accentColor: '#F87171', cursor: 'pointer' }} />
          Critical only
        </label>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {(localSearch || modelFilter !== 'all' || slaFilter !== 'all' || criticalOnly) && (
            <button onClick={() => { setLocalSearch(''); setModelFilter('all'); setSlaFilter('all'); setCriticalOnly(false); }} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--rbk-ink-faint)', background: 'none', border: 'none', cursor: 'pointer' }}>
              <XIcon size={12} /> Clear filters
            </button>
          )}
          {selectedNames.size > 0 && (
            <button onClick={() => setSelectedNames(new Set())} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--rbk-brand)', background: 'none', border: 'none', cursor: 'pointer' }}>
              <XIcon size={12} /> Clear selection ({selectedNames.size})
            </button>
          )}
          <span className="rbk-tnum" style={{ fontSize: 12, color: 'var(--rbk-ink-faint)' }}>{sortedFiltered.length} cluster(s)</span>
          {pollMsg && <span style={{ fontSize: 11, color: 'var(--rbk-brand)' }}>{pollMsg}</span>}
          <button onClick={handlePollAll} disabled={polling || clusters.length === 0} className="rbk-btn-accent">
            <RotateCcwIcon size={13} style={polling ? { animation: 'rbk-spin 0.8s linear infinite' } : undefined} />
            {polling ? 'Polling…' : 'Poll All'}
          </button>
        </div>
      </div>

      {/* ROW 3 — main grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16 }} className="rbk-main-grid">
        <style>{`@media (min-width: 1280px) { .rbk-main-grid { grid-template-columns: 2fr 3fr !important; } }`}</style>

        {/* LEFT */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Panel title="Global Storage Utilization" icon={GlobeIcon}>
            {loading ? <LoadingPanel height={110} /> : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                <Donut pct={gsuPct} size={110} thresholds={{ crit: 86, warn: 70 }} centerLabel={`${gsuPct.toFixed(1)}%`} centerSub="used" />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
                  <div>
                    <p className="rbk-tnum" style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--rbk-ink)' }}>{fmtBytes(gsuUsed)} <span style={{ color: 'var(--rbk-ink-faint)', fontWeight: 400 }}>of</span> {fmtBytes(gsuCap)}</p>
                    <p style={{ margin: 0, fontSize: 11, color: 'var(--rbk-ink-muted)' }}>{fmtBytes(Math.max(0, gsuCap - gsuUsed))} available</p>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <Badge tone="brand" className="rbk-tnum">{avgDR.toFixed(1)}x data reduction</Badge>
                    <Badge tone="neutral" className="rbk-tnum">{activeSet.length} reporting</Badge>
                  </div>
                </div>
              </div>
            )}
          </Panel>

          <div className="rbk-panel" style={{ padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <ChartIcon size={14} style={{ color: 'var(--rbk-brand)' }} />
              <p className="rbk-panel-title" style={{ margin: 0 }}>Capacity Growth Trend</p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, flexWrap: 'wrap', gap: 4 }}>
              <p style={{ margin: 0, fontSize: 10, color: 'var(--rbk-ink-faint)' }}>{trend.clusterCount} cluster(s)</p>
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <CsvExportButton filename="rubrik-capacity-trend" columns={[{ label: 'Cluster', get: 'name' }]} rows={activeSet} />
                {[1, 7, 14, 30].map((d) => (
                  <button key={d} onClick={() => setTrendDays(d)} className={`rbk-pill${trendDays === d ? ' rbk-pill-active' : ''}`} style={{ padding: '4px 10px', fontSize: 11 }}>{d}d</button>
                ))}
              </div>
            </div>
            {loading ? <LoadingPanel height={220} /> : !trend.hasData ? (
              <EmptyState title="No trend data available." description="Select clusters or wait for polling to collect history." />
            ) : (
              <>
                <LineChart series={trend.series} refLines={trend.refLines} width={560} height={220} yUnit={(v) => `${v.toFixed(1)} ${trend.unit.label}`} />
                {trend.growthSummaries.some((s) => s.growthBytesPerDay > 0) && (
                  <div style={{ marginTop: 10, border: '1px solid var(--rbk-border)', borderRadius: 8, overflow: 'hidden' }}>
                    <div className="rbk-scroll" style={{ maxHeight: 128, overflowY: 'auto' }}>
                      <table style={{ width: '100%', fontSize: 11, color: 'var(--rbk-ink-muted)', borderCollapse: 'collapse' }}>
                        <thead style={{ position: 'sticky', top: 0, background: 'var(--rbk-surface-base)' }}>
                          <tr style={{ color: 'var(--rbk-ink-faint)' }}>
                            <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 600 }}>Cluster</th>
                            <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 600 }}>Growth Rate</th>
                            <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 600 }}>~Days to 85%</th>
                            <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 600 }}>Date to 85%</th>
                            <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 600 }}>~Days to 90%</th>
                            <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 600 }}>Date to 90%</th>
                          </tr>
                        </thead>
                        <tbody>
                          {trend.growthSummaries.filter((s) => s.growthBytesPerDay > 0).map((s) => {
                            const rateStr = s.growthBytesPerDay < 100e9
                              ? `+${(s.growthBytesPerDay / 1e9).toFixed(1)} GB/day`
                              : `+${(s.growthBytesPerDay * 7 / 1e12).toFixed(1)} TB/week`;
                            const toDateStr = (days) => {
                              if (days == null) return '—';
                              const d = new Date();
                              d.setDate(d.getDate() + Math.round(days));
                              return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
                            };
                            return (
                              <tr key={s.name} className="rbk-row" style={{ borderTop: '1px solid var(--rbk-border)' }}>
                                <td style={{ padding: '6px 8px', color: 'var(--rbk-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 120 }}>{s.name}</td>
                                <td className="rbk-tnum" style={{ textAlign: 'right', padding: '6px 8px', color: 'var(--rbk-brand)' }}>{rateStr}</td>
                                <td className="rbk-tnum" style={{ textAlign: 'right', padding: '6px 8px' }}>{s.daysUntil85 != null ? Math.round(s.daysUntil85) : '—'}</td>
                                <td className="rbk-tnum" style={{ textAlign: 'right', padding: '6px 8px', color: 'var(--rbk-warn)' }}>{toDateStr(s.daysUntil85)}</td>
                                <td className="rbk-tnum" style={{ textAlign: 'right', padding: '6px 8px' }}>{s.daysUntil90 != null ? Math.round(s.daysUntil90) : '—'}</td>
                                <td className="rbk-tnum" style={{ textAlign: 'right', padding: '6px 8px', color: 'var(--rbk-warn)' }}>{toDateStr(s.daysUntil90)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* RIGHT */}
        <div className="rbk-panel" style={{ padding: 16, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <LayoutGridIcon size={14} style={{ color: 'var(--rbk-brand)' }} />
              <p className="rbk-panel-title" style={{ margin: 0 }}>Cluster Health &amp; Alerts</p>
            </div>
            <span style={{ fontSize: 10, color: 'var(--rbk-ink-faint)' }} className="rbk-tnum">{sortedFiltered.length} clusters</span>
          </div>
          {loading ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 8 }}>
              {Array.from({ length: CLUSTER_PAGE_SIZE }).map((_, i) => <div key={i} className="rbk-skeleton" style={{ height: 170, borderRadius: 12 }} />)}
            </div>
          ) : sortedFiltered.length === 0 ? (
            <EmptyState icon={ServerIcon} title="No clusters found" description={clusters.length === 0 ? 'No clusters configured.' : 'No clusters match the current filters.'} />
          ) : (
            <>
              <div className="rbk-stagger" style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 8 }}>
                {clusterPageItems.map((c, i) => (
                  <ClusterHealthCard
                    key={c.name}
                    cluster={c}
                    selected={selectedNames.has(c.name)}
                    onSelect={toggleSelect}
                    onModelClick={setModelFilter}
                  />
                ))}
              </div>
              {clusterTotalPages > 1 && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 12, fontSize: 11 }}>
                  <button onClick={() => setClusterPage((p) => Math.max(0, p - 1))} disabled={clusterSafePage === 0} className="rbk-btn-ghost" style={{ padding: '4px 8px' }}>‹</button>
                  <span className="rbk-tnum" style={{ color: 'var(--rbk-ink-faint)' }}>{clusterSafePage + 1} / {clusterTotalPages}</span>
                  <button onClick={() => setClusterPage((p) => Math.min(clusterTotalPages - 1, p + 1))} disabled={clusterSafePage >= clusterTotalPages - 1} className="rbk-btn-ghost" style={{ padding: '4px 8px' }}>›</button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ROW 4 — bottom panels */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16 }} className="rbk-bottom-grid">
        <style>{`
          @media (min-width: 1024px) { .rbk-bottom-grid { grid-template-columns: repeat(2,1fr) !important; } }
          @media (min-width: 1280px) { .rbk-bottom-grid { grid-template-columns: repeat(4,1fr) !important; } }
        `}</style>

        <Panel
          title="Cluster Status"
          icon={ServerIcon}
          actions={(() => {
            const online = clusters.filter((c) => c.status === 'Connected').length;
            const offline = clusters.length - online;
            return (
              <div style={{ display: 'flex', gap: 6, fontSize: 10 }} className="rbk-tnum">
                {online > 0 && <Badge tone="ok">{online} online</Badge>}
                {offline > 0 && <Badge tone="crit">{offline} offline</Badge>}
              </div>
            );
          })()}
        >
          <div className="rbk-scroll" style={{ maxHeight: 256, overflowY: 'auto' }}>
            {loading ? <SkeletonTable rows={5} colWidths={['20%', '55%', '25%']} /> : clusters.length === 0 ? <EmptyState title="No clusters" /> : (
              <table style={{ width: '100%', fontSize: 11, color: 'var(--rbk-ink-muted)', borderCollapse: 'collapse' }}>
                <tbody>
                  {[...clusters].sort((a, b) => (a.status === 'Connected' ? 0 : 1) - (b.status === 'Connected' ? 0 : 1)).map((c) => {
                    const online = c.status === 'Connected';
                    return (
                      <tr key={c.id} className="rbk-row" style={{ borderTop: '1px solid var(--rbk-border)' }}>
                        <td style={{ padding: '6px 6px', width: 20 }}>
                          <ClusterStatusOrb status={online ? 'green' : 'red'} size={8} title={online ? 'Online' : 'Offline'} />
                        </td>
                        <td style={{ padding: '6px 6px', color: 'var(--rbk-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 140 }}>{c.name}</td>
                        <td className="rbk-tnum" style={{ padding: '6px 6px', textAlign: 'right', color: online ? undefined : 'var(--rbk-crit)' }}>{online ? 'Online' : 'Offline'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </Panel>

        <Panel title="Top Clusters by Capacity" icon={ChartIcon}>
          {loading ? <LoadingPanel height={220} /> : chartData.length === 0 ? <EmptyState title="No data" /> : (
            <HBar rows={chartData.slice(0, 10).map((c) => ({ label: c.name, value: Math.round(c.pct), color: pctColor(c.pct) }))} max={100} unit="%" width={300} />
          )}
        </Panel>

        <Panel title="Storage Distribution" icon={DbIcon}>
          <div className="rbk-scroll" style={{ maxHeight: 256, overflowY: 'auto' }}>
            {loading ? <SkeletonTable rows={5} /> : sortedFiltered.filter((c) => c.usedBytes > 0).length === 0 ? <EmptyState title="No data" /> : (
              <table style={{ width: '100%', fontSize: 11, color: 'var(--rbk-ink-muted)', borderCollapse: 'collapse' }}>
                <thead style={{ position: 'sticky', top: 0, background: 'var(--rbk-surface)' }}>
                  <tr style={{ color: 'var(--rbk-ink-faint)' }}>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>Cluster</th>
                    <th style={{ textAlign: 'right', padding: '4px 6px' }}>Used TB</th>
                    <th style={{ textAlign: 'right', padding: '4px 6px' }}>Total TB</th>
                    <th style={{ textAlign: 'right', padding: '4px 6px' }}>% Used</th>
                  </tr>
                </thead>
                <tbody>
                  {[...sortedFiltered].filter((c) => c.usedBytes > 0).sort((a, b) => (b.usedPct || 0) - (a.usedPct || 0)).slice(0, 10).map((c) => {
                    const used = toTB(c.usedBytes);
                    const total = toTB(c.capacityBytes);
                    const pct = c.usedPct || 0;
                    return (
                      <tr key={c.name} className="rbk-row" style={{ borderTop: '1px solid var(--rbk-border)' }}>
                        <td style={{ padding: '6px 6px', color: 'var(--rbk-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 100 }}>{c.name}</td>
                        <td className="rbk-tnum" style={{ textAlign: 'right', padding: '6px 6px' }}>{used.toFixed(2)}</td>
                        <td className="rbk-tnum" style={{ textAlign: 'right', padding: '6px 6px' }}>{total.toFixed(2)}</td>
                        <td className="rbk-tnum" style={{ textAlign: 'right', padding: '6px 6px', fontWeight: 600, color: pctColor(pct) }}>{pct.toFixed(1)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </Panel>

        <Panel title="Recent Critical Alerts" icon={BellIcon}>
          <div className="rbk-scroll" style={{ maxHeight: 256, overflowY: 'auto' }}>
            {loading ? <SkeletonTable rows={4} /> : recentCriticalAlerts.length === 0 ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '24px 0', color: 'var(--rbk-ok)', fontSize: 12 }}>
                <ShieldIcon size={14} /> No active critical alerts
              </div>
            ) : (
              <table style={{ width: '100%', fontSize: 11, color: 'var(--rbk-ink-muted)', borderCollapse: 'collapse' }}>
                <thead style={{ position: 'sticky', top: 0, background: 'var(--rbk-surface)' }}>
                  <tr style={{ color: 'var(--rbk-ink-faint)' }}>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>Time</th>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>Cluster</th>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>Issue</th>
                  </tr>
                </thead>
                <tbody>
                  {recentCriticalAlerts.slice(0, 10).map((a) => (
                    <tr key={a.id} onClick={() => setSelectedAlert(a)} className="rbk-row" style={{ borderTop: '1px solid var(--rbk-border)', cursor: 'pointer' }}>
                      <td className="rbk-tnum" style={{ padding: '6px 6px', whiteSpace: 'nowrap' }}>{timeAgo(a.firstSeen)}</td>
                      <td style={{ padding: '6px 6px', color: 'var(--rbk-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 80 }}>{a.cluster}</td>
                      <td style={{ padding: '6px 6px', color: 'var(--rbk-warn)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 110 }}>{a.alertType || a.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
