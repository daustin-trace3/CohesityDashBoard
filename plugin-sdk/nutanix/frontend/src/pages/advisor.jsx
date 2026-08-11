// Nutanix AI Advisor — self-contained port of the host's PlatformAdvisorPage
// + AdvisorReportModal (frontend/src/components/PlatformAdvisorPage.jsx +
// AdvisorReportModal.jsx), which are NOT importable from a plugin bundle.
// 4 preset reports (capacity, replication, hotspots, resiliency), markdown
// rendering via ./markdown.jsx, and explicit 503/429/502 error copy.
import {
  injectStyles, PageHeader, LoadingPanel, ModalShell,
  SparklesIcon, DbIcon, ArrowRightLeftIcon, FlameIcon, ShieldIcon, ClockIcon, FileIcon,
} from '../ui.jsx';
import Markdown from '../markdown.jsx';

injectStyles();

const TABS = [
  { slug: 'capacity', label: 'Capacity', icon: DbIcon,
    blurb: 'Cluster and container storage pressure, growth trends, and runway forecasts.' },
  { slug: 'replication', label: 'Replication', icon: ArrowRightLeftIcon,
    blurb: 'Protection domain replication health, stalled transfers, and RPO compliance.' },
  { slug: 'hotspots', label: 'Hotspots', icon: FlameIcon,
    blurb: 'CPU/memory hotspots and node imbalance across hosts and VMs.' },
  { slug: 'resiliency', label: 'Resiliency', icon: ShieldIcon,
    blurb: 'Fault-tolerance posture, degraded hosts, and cluster health-check results.' },
];

const iccCsrf = () => (typeof window !== 'undefined' ? window.__ICC_CSRF_TOKEN__ : null);

function timeAgo(ts) {
  if (!ts) return null;
  const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function fmtTime(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

function errorCopy(status, serverMsg) {
  if (serverMsg) return serverMsg;
  if (status === 503) return 'AI analysis is not configured on the server.';
  if (status === 429) return 'Rate limited — too many analysis requests. Try again shortly.';
  if (status === 502) return 'The AI provider is unreachable right now. Try again shortly.';
  return 'Report generation failed. Try again.';
}

function ReportModal({ tab, initialReport, autoRun, onClose, onUpdated }) {
  const [report, setReport] = React.useState(initialReport || null);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState(null);
  const Icon = tab.icon;

  const run = React.useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/nutanix/advisor/${tab.slug}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(iccCsrf() ? { 'x-csrf-token': iccCsrf() } : {}) },
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        setError(errorCopy(res.status, payload.error));
        return;
      }
      const data = await res.json();
      setReport(data);
      onUpdated?.(data);
    } catch {
      setError('Report generation failed. Try again.');
    } finally {
      setRunning(false);
    }
  }, [tab.slug, onUpdated]);

  const didAuto = React.useRef(false);
  React.useEffect(() => {
    if (autoRun && !didAuto.current) { didAuto.current = true; run(); }
  }, [autoRun, run]);

  return (
    <ModalShell
      title={tab.label}
      subtitle={report?.generatedAt ? `${report.model ? `${report.model} · ` : ''}Generated ${fmtTime(report.generatedAt)}` : undefined}
      icon={Icon}
      onClose={onClose}
      width="min(760px,92vw)"
    >
      {running ? (
        <LoadingPanel label="Analyzing the estate…" height={180} />
      ) : report?.content ? (
        <>
          {error && <p style={{ color: 'var(--nx-crit)', fontSize: 12, marginBottom: 8 }}>{error}</p>}
          {report.stale && (
            <p style={{ margin: '0 0 12px', fontSize: 11, color: 'var(--nx-warn)', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 8, padding: '6px 10px' }}>
              This report is over {report.ttlHours || 24}h old and may not reflect current data. Re-run for an up-to-date view.
            </p>
          )}
          <Markdown text={report.content} />
        </>
      ) : (
        <p style={{ fontSize: 12, color: error ? 'var(--nx-crit)' : 'var(--nx-ink-muted)', padding: '40px 0', textAlign: 'center' }}>
          {error || 'No report yet. Run one to analyze the estate.'}
        </p>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--nx-border)' }}>
        <button onClick={run} disabled={running} className="nx-btn-accent">
          <SparklesIcon size={13} /> {report?.content ? 'Re-run' : 'Generate report'}
        </button>
      </div>
    </ModalShell>
  );
}

function ReportTile({ tab, state, onOpen, onRun }) {
  const Icon = tab.icon;
  const report = state?.report;
  const enabled = state?.enabled !== false;
  const loaded = state !== undefined;

  return (
    <div className="nx-panel" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, minHeight: 200 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ display: 'flex', height: 40, width: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 12, background: 'rgba(120,85,250,0.1)', border: '1px solid rgba(120,85,250,0.2)', flexShrink: 0 }}>
          <Icon size={20} style={{ color: 'var(--nx-brand)' }} />
        </div>
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--nx-ink)' }}>{tab.label}</p>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--nx-ink-muted)', lineHeight: 1.5 }}>{tab.blurb}</p>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11, marginTop: 'auto' }}>
        {!loaded ? (
          <span style={{ color: 'var(--nx-ink-faint)' }}>Loading…</span>
        ) : !enabled ? (
          <span style={{ color: 'var(--nx-warn)' }}>AI not configured</span>
        ) : report?.generatedAt ? (
          <>
            <ClockIcon size={12} style={{ color: 'var(--nx-ink-faint)' }} />
            <span style={{ color: 'var(--nx-ink-muted)' }}>Last run {timeAgo(report.generatedAt)}</span>
            {report.stale && (
              <span style={{ color: 'var(--nx-warn)', border: '1px solid rgba(251,191,36,0.4)', background: 'rgba(251,191,36,0.1)', borderRadius: 4, padding: '1px 5px', fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>Stale</span>
            )}
            {report.model && <span style={{ color: 'var(--nx-ink-faint)' }}>· {report.model}</span>}
          </>
        ) : (
          <span style={{ color: 'var(--nx-ink-faint)' }}>Not run yet</span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={onOpen} disabled={!report?.generatedAt} className="nx-btn-ghost" style={{ opacity: !report?.generatedAt ? 0.4 : 1, cursor: !report?.generatedAt ? 'default' : 'pointer' }}>
          <FileIcon size={13} /> Open last run
        </button>
        <button onClick={onRun} disabled={!enabled} className="nx-btn-accent">
          <SparklesIcon size={13} /> Run new
        </button>
      </div>
    </div>
  );
}

export default function AdvisorPage() {
  const [states, setStates] = React.useState({});
  const [open, setOpen] = React.useState(null);

  const loadOne = React.useCallback(async (slug) => {
    try {
      const res = await fetch(`/api/nutanix/advisor/${slug}`, { credentials: 'include' });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setStates((s) => ({ ...s, [slug]: { enabled: data.enabled, report: data.report || null } }));
    } catch {
      setStates((s) => ({ ...s, [slug]: { enabled: true, report: null } }));
    }
  }, []);

  React.useEffect(() => { TABS.forEach((t) => loadOne(t.slug)); }, [loadOne]);

  const openTab = open ? TABS.find((t) => t.slug === open.slug) : null;

  return (
    <div className="nx-root nx-fade-in">
      <PageHeader
        icon={SparklesIcon}
        title="AI Advisor"
        description="AI analyses for the Nutanix estate. Reports run only when you ask — open the last run or generate a fresh one. Cached results are flagged stale after 24h."
      />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16 }} className="nx-advisor-grid">
        <style>{`
          @media (min-width: 640px) { .nx-advisor-grid { grid-template-columns: repeat(2,1fr) !important; } }
          @media (min-width: 1280px) { .nx-advisor-grid { grid-template-columns: repeat(3,1fr) !important; } }
        `}</style>
        {TABS.map((tab) => (
          <ReportTile
            key={tab.slug}
            tab={tab}
            state={states[tab.slug]}
            onOpen={() => setOpen({ slug: tab.slug, autoRun: false })}
            onRun={() => setOpen({ slug: tab.slug, autoRun: true })}
          />
        ))}
      </div>

      {openTab && (
        <ReportModal
          tab={openTab}
          initialReport={states[openTab.slug]?.report || null}
          autoRun={open.autoRun}
          onClose={() => setOpen(null)}
          onUpdated={(data) => setStates((s) => ({ ...s, [openTab.slug]: { enabled: true, report: data } }))}
        />
      )}
    </div>
  );
}
