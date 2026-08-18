// Cohesity plugin — AI Advisor page. Ported from frontend/src/pages/AIAdvisorPage.jsx,
// which delegated to shared components/AdvisorReportModal.jsx (not importable
// in a plugin sandbox). Reimplemented self-contained, mirroring the Dell wave's
// plugin-sdk/dell/frontend/src/pages/advisor.jsx: same tabs, same endpoints
// (GET/POST /api/cohesity/advisor/:slug), same cached-report/stale/run-new
// behavior, using the kit's apiFetch + Markdown instead of axios + a bespoke
// markdown renderer.
import { apiFetch, PageHeader, LoadingPanel, Modal, Markdown } from '../ui.jsx';
import {
  Sparkles, Database, ArrowLeftRight, ShieldAlert, Gauge, ShieldCheck,
} from '../icons.jsx';

// Not in the shared icon kit — added locally (same 24x24 stroke style as icons.jsx).
function Clock(p) {
  const size = p.size || 16;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={p.style} className={p.className}>
      <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
    </svg>
  );
}
function FileText(p) {
  const size = p.size || 16;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={p.style} className={p.className}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /><path d="M9 13h6M9 17h6M9 9h1" />
    </svg>
  );
}
function Newspaper(p) {
  const size = p.size || 16;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={p.style} className={p.className}>
      <path d="M4 4h13a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H4V4Z" /><path d="M4 4v16a2 2 0 0 0 2 2h13" /><path d="M8 8h8M8 12h8M8 16h5" />
    </svg>
  );
}
function BellRing(p) {
  const size = p.size || 16;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={p.style} className={p.className}>
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /><path d="M4 2C3 3 2 4 2 6M22 6c0-2-1-3-2-4" />
    </svg>
  );
}
function GitCompareArrows(p) {
  const size = p.size || 16;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={p.style} className={p.className}>
      <circle cx="5" cy="6" r="3" /><circle cx="19" cy="18" r="3" /><path d="M5 9v6a4 4 0 0 0 4 4h2M19 15V9a4 4 0 0 0-4-4h-2" /><path d="m9 18-2-2 2-2M15 6l2 2-2 2" />
    </svg>
  );
}
function ArrowUpCircle(p) {
  const size = p.size || 16;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={p.style} className={p.className}>
      <circle cx="12" cy="12" r="10" /><path d="m16 12-4-4-4 4M12 16V8" />
    </svg>
  );
}

const TABS = [
  { slug: 'executive-digest', label: 'Executive Digest', icon: Newspaper,
    blurb: 'A leadership brief across capacity, alerts, backup, and DR — top risks and where to focus this week.' },
  { slug: 'capacity', label: 'Capacity Planning', icon: Database,
    blurb: 'Fleet-wide capacity runway, growth trends, and a procurement timeline from 30 days of metrics history.' },
  { slug: 'dr-readiness', label: 'DR Readiness', icon: ArrowLeftRight,
    blurb: 'Replication health, off-site policy coverage, and disaster-recovery gaps across the estate.' },
  { slug: 'backup-failures', label: 'Backup Failure Analysis', icon: ShieldAlert,
    blurb: 'Fleet backup success rate plus root-cause clustering of recurring protection-job failures (7 days).' },
  { slug: 'storage-efficiency', label: 'Storage Efficiency', icon: Gauge,
    blurb: 'Data-reduction across the fleet — low-dedup outliers, likely causes, and where to reclaim space.' },
  { slug: 'alert-triage', label: 'Alert Triage', icon: BellRing,
    blurb: 'Cross-cluster alert patterns — systemic issues vs noise, and a prioritized triage order.' },
  { slug: 'ransomware-resilience', label: 'Ransomware Resilience', icon: ShieldCheck,
    blurb: 'Immutability (DataLock) and off-site coverage, unprotected data, and recovery readiness vs an attack.' },
  { slug: 'what-changed', label: 'What Changed', icon: GitCompareArrows,
    blurb: 'Week-over-week digest: alert spikes, backup regressions, and the biggest capacity movers.' },
  { slug: 'upgrade-advisory', label: 'Upgrade Advisory', icon: ArrowUpCircle,
    blurb: 'Software-version drift across the fleet and an ordered convergence/upgrade plan.' },
];

function timeAgoShort(ts) {
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

function ReportTile({ tab, state, onOpen, onRun }) {
  const Icon = tab.icon;
  const report = state?.report;
  const enabled = state?.enabled !== false;
  const loaded = state !== undefined;

  return (
    <div className="panel" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, minHeight: 200 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ display: 'flex', height: 40, width: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 12, background: 'rgba(108,179,63,0.1)', border: '1px solid rgba(108,179,63,0.2)', flexShrink: 0 }}>
          <Icon size={20} style={{ color: 'var(--co-brand)' }} />
        </div>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--co-ink)', margin: 0 }}>{tab.label}</p>
          <p style={{ fontSize: 12, color: 'var(--co-ink-muted)', lineHeight: 1.5, margin: '2px 0 0' }}>{tab.blurb}</p>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, flexWrap: 'wrap', marginTop: 'auto' }}>
        {!loaded ? (
          <span style={{ color: 'var(--co-ink-faint)' }}>Loading…</span>
        ) : !enabled ? (
          <span style={{ color: 'var(--co-warn)' }}>AI not configured</span>
        ) : report?.generatedAt ? (
          <>
            <Clock size={12} style={{ color: 'var(--co-ink-faint)' }} />
            <span style={{ color: 'var(--co-ink-muted)' }}>Last run {timeAgoShort(report.generatedAt)}</span>
            {report.stale && (
              <span style={{ color: 'var(--co-warn)', border: '1px solid rgba(251,191,36,0.4)', background: 'rgba(251,191,36,0.1)', borderRadius: 4, padding: '1px 4px', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.03em' }}>Stale</span>
            )}
            {report.model && <span style={{ color: 'var(--co-ink-faint)' }}>· {report.model}</span>}
          </>
        ) : (
          <span style={{ color: 'var(--co-ink-faint)' }}>Not run yet</span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={onOpen} disabled={!report?.generatedAt} className="co-btn-ghost" style={{ opacity: report?.generatedAt ? 1 : 0.4, cursor: report?.generatedAt ? 'pointer' : 'not-allowed' }}>
          <FileText size={13} /> Open last run
        </button>
        <button onClick={onRun} disabled={!enabled}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500, padding: '8px 12px', background: 'rgba(108,179,63,0.1)', border: '1px solid rgba(108,179,63,0.3)', color: 'var(--co-brand)', borderRadius: 8, cursor: enabled ? 'pointer' : 'default', opacity: enabled ? 1 : 0.5 }}>
          <Sparkles size={13} /> Run new
        </button>
      </div>
    </div>
  );
}

function AdvisorReportModal({ tab, initialReport, enabled, autoRun = false, onClose, onUpdated }) {
  const [report, setReport] = React.useState(initialReport || null);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState(null);
  const Icon = tab.icon;

  const run = React.useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const json = await apiFetch(`/cohesity/advisor/${tab.slug}`, { method: 'POST', body: {} });
      setReport(json);
      onUpdated?.(json);
    } catch (e) {
      setError(e?.payload?.error || (e?.status === 503
        ? 'AI analysis is not configured.'
        : 'Report generation failed. Try again.'));
    } finally {
      setRunning(false);
    }
  }, [tab.slug, onUpdated]);

  const didAuto = React.useRef(false);
  React.useEffect(() => {
    if (autoRun && !didAuto.current) { didAuto.current = true; run(); }
  }, [autoRun, run]);

  return (
    <Modal title={tab.label} icon={Icon} onClose={onClose} maxWidth="min(768px,92vw)">
      {report?.generatedAt && (
        <p style={{ fontSize: 11, color: 'var(--co-ink-faint)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: -8, marginBottom: 12 }}>
          <span>{report.model ? `${report.model} · ` : ''}Generated {fmtTime(report.generatedAt)}</span>
          {report.stale && (
            <span title={`Older than ${report.ttlHours || 24}h — re-run for current data`}
              style={{ color: 'var(--co-warn)', border: '1px solid rgba(251,191,36,0.4)', background: 'rgba(251,191,36,0.1)', borderRadius: 4, padding: '1px 4px', fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>
              Stale
            </span>
          )}
        </p>
      )}

      {!enabled ? (
        <p style={{ fontSize: 12, color: 'var(--co-ink-muted)', lineHeight: 1.6 }}>
          AI analysis is not configured on the server. Set <code style={{ color: 'var(--co-brand)' }}>OPENAI_TOKEN</code> (or
          <code style={{ color: 'var(--co-brand)' }}> GITHUB_MODELS_TOKEN</code>) and restart.
        </p>
      ) : running ? (
        <LoadingPanel label="Analyzing the estate…" height={180} />
      ) : report?.content ? (
        <>
          {error && <p style={{ color: 'var(--co-crit)', fontSize: 12, marginBottom: 8 }}>{error}</p>}
          {report.stale && (
            <p style={{ marginBottom: 12, fontSize: 11, color: 'var(--co-warn)', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 6, padding: '6px 10px' }}>
              This report is over {report.ttlHours || 24}h old and may not reflect current data. Re-run for an up-to-date view.
            </p>
          )}
          <Markdown text={report.content} />
        </>
      ) : (
        <p style={{ color: 'var(--co-ink-muted)', fontSize: 12, padding: '40px 0', textAlign: 'center' }}>
          {error ? <span style={{ color: 'var(--co-crit)' }}>{error}</span> : 'No report yet. Run one to analyze the estate.'}
        </p>
      )}

      {enabled && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--co-border)' }}>
          <button onClick={run} disabled={running}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500, padding: '7px 12px', background: 'rgba(108,179,63,0.1)', border: '1px solid rgba(108,179,63,0.3)', color: 'var(--co-brand)', borderRadius: 8, cursor: running ? 'default' : 'pointer', opacity: running ? 0.5 : 1 }}>
            <Sparkles size={13} />
            {report?.content ? 'Re-run' : 'Generate report'}
          </button>
        </div>
      )}
    </Modal>
  );
}

export default function AIAdvisorPage() {
  const [states, setStates] = React.useState({}); // slug -> { enabled, report }
  const [open, setOpen] = React.useState(null);   // { slug, autoRun }

  const loadOne = React.useCallback(async (slug) => {
    try {
      const json = await apiFetch(`/cohesity/advisor/${slug}`);
      setStates((s) => ({ ...s, [slug]: { enabled: json.enabled, report: json.report || null } }));
    } catch {
      setStates((s) => ({ ...s, [slug]: { enabled: true, report: null } }));
    }
  }, []);

  React.useEffect(() => { TABS.forEach((t) => loadOne(t.slug)); }, [loadOne]);

  const openTab = open ? TABS.find((t) => t.slug === open.slug) : null;

  return (
    <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader
        icon={Sparkles}
        title="AI Advisor"
        description="Estate-wide AI analyses. Reports run only when you ask — open the last run or generate a fresh one. Cached results are flagged stale after 24h." />

      <div className="grid sm:grid-cols-2 xl:grid-cols-3" style={{ gap: 16 }}>
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
        <AdvisorReportModal
          tab={openTab}
          initialReport={states[openTab.slug]?.report || null}
          enabled={states[openTab.slug]?.enabled !== false}
          autoRun={open.autoRun}
          onClose={() => setOpen(null)}
          onUpdated={(json) => setStates((s) => ({ ...s, [openTab.slug]: { enabled: true, report: json } }))}
        />
      )}
    </div>
  );
}
