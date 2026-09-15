// Rubrik AI Advisor - self-contained page on the rbk- kit (./ui, ./icons).
// ui.jsx has no Modal or apiFetch (unlike the Dell pack's ui.jsx), so both
// are defined locally here, matching the local-apiFetch-per-page pattern
// already used across plugin-sdk/rubrik/frontend/src/pages/*.jsx (see
// alerts.jsx) plus its CSRF-header handling. No anonymizer call is made
// from the frontend - anonymization happens backend-side in advisor.js via
// coreApi.advisor.
import { PageHeader, LoadingPanel, Badge, ClipboardIcon, BellIcon, ArrowsIcon, ChartIcon } from '../ui';
import { Sparkles, FileText, Clock } from '../icons';

const BRAND = '#00B388';
const API_BASE = '/api/rubrik';

const TABS = [
  { slug: 'backup-compliance', label: 'Backup Compliance', icon: ClipboardIcon,
    blurb: 'SLA-domain and cluster compliance, the most overdue objects, and chronic 7-day backup failures.' },
  { slug: 'alert-triage', label: 'Alert Triage', icon: BellIcon,
    blurb: 'Open alerts and Radar anomaly events, ordered so the systemic issues surface first.' },
  { slug: 'replication-archival', label: 'Replication & Archival', icon: ArrowsIcon,
    blurb: 'Replication pair health, recent replication runs, archival locations, and DR coverage gaps.' },
  { slug: 'capacity-runway', label: 'Capacity Runway', icon: ChartIcon,
    blurb: 'Per-cluster capacity trend, projected days-to-full, and the objects driving growth.' },
];

function apiFetch(path, opts = {}) {
  const csrf = typeof window !== 'undefined' ? window.__ICC_CSRF_TOKEN__ : null;
  return fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(opts.headers || {}) },
  }).then(async (res) => {
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      const err = new Error(payload.error || `Request failed: ${res.status}`);
      err.status = res.status;
      err.payload = payload;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json().catch(() => null);
  });
}

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

/* -- minimal markdown renderer (no raw HTML) --------------------------- */
function renderInline(text, keyPrefix) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) {
      return <strong key={`${keyPrefix}-${i}`} style={{ color: 'var(--rbk-ink)', fontWeight: 600 }}>{p.slice(2, -2)}</strong>;
    }
    if (p.startsWith('`') && p.endsWith('`')) {
      return <code key={`${keyPrefix}-${i}`} style={{ color: BRAND, background: 'rgba(30,42,54,0.6)', borderRadius: 4, padding: '1px 4px', fontSize: 11 }}>{p.slice(1, -1)}</code>;
    }
    return <span key={`${keyPrefix}-${i}`}>{p}</span>;
  });
}

function parseBlocks(text) {
  const lines = (text || '').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].replace(/\s+$/, '');
    if (line.trim() === '') { i++; continue; }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const boldOnly = line.match(/^\*\*(.+?)\*\*:?\s*$/);
    if (heading) { blocks.push({ type: 'h', text: heading[2] }); i++; continue; }
    if (boldOnly) { blocks.push({ type: 'h', text: boldOnly[1] }); i++; continue; }
    const listRe = /^(\s*)([-*]|\d+[.)])\s+(.*)$/;
    if (listRe.test(line)) {
      const items = [];
      while (i < lines.length) {
        const l = lines[i].replace(/\s+$/, '');
        const m = l.match(listRe);
        if (!m) break;
        items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] });
        i++;
      }
      blocks.push({ type: 'list', tree: buildTree(items) });
      continue;
    }
    blocks.push({ type: 'p', text: line });
    i++;
  }
  return blocks;
}

function buildTree(items) {
  const root = [];
  const stack = [{ indent: -1, children: root }];
  for (const it of items) {
    while (stack.length > 1 && it.indent <= stack[stack.length - 1].indent) stack.pop();
    const node = { ordered: it.ordered, text: it.text, children: [] };
    stack[stack.length - 1].children.push(node);
    stack.push({ indent: it.indent, children: node.children });
  }
  return root;
}

function renderNodes(nodes, key) {
  if (!nodes || nodes.length === 0) return null;
  const ordered = nodes[0].ordered;
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag style={{ paddingLeft: 20, margin: '6px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {nodes.map((n, idx) => (
        <li key={`${key}-${idx}`} style={{ lineHeight: 1.6 }}>
          {renderInline(n.text, `${key}-${idx}`)}
          {n.children.length > 0 && renderNodes(n.children, `${key}-${idx}c`)}
        </li>
      ))}
    </Tag>
  );
}

function Markdown({ text }) {
  const blocks = parseBlocks(text);
  return (
    <div style={{ fontSize: 12, color: 'var(--rbk-ink-muted)', lineHeight: 1.6 }}>
      {blocks.map((b, idx) => {
        if (b.type === 'h') {
          return (
            <p key={idx} style={{ fontSize: 13, fontWeight: 700, color: 'var(--rbk-ink)', marginTop: idx === 0 ? 0 : 16, marginBottom: 6, paddingBottom: 4, borderBottom: '1px solid var(--rbk-border)' }}>
              {renderInline(b.text, `h${idx}`)}
            </p>
          );
        }
        if (b.type === 'list') return <div key={idx}>{renderNodes(b.tree, `l${idx}`)}</div>;
        return <p key={idx} style={{ margin: '8px 0' }}>{renderInline(b.text, `p${idx}`)}</p>;
      })}
    </div>
  );
}

/* -- report tile ------------------------------------------------------- */
function ReportTile({ tab, state, onOpen, onRun }) {
  const Icon = tab.icon;
  const report = state?.report;
  const enabled = state?.enabled !== false;
  const loaded = state !== undefined;

  return (
    <div className="rbk-panel" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, minHeight: 200 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ display: 'flex', height: 40, width: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 12, background: 'rgba(0,179,136,0.1)', border: '1px solid rgba(0,179,136,0.2)', flexShrink: 0 }}>
          <Icon size={20} style={{ color: BRAND }} />
        </div>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--rbk-ink)', margin: 0 }}>{tab.label}</p>
          <p style={{ fontSize: 12, color: 'var(--rbk-ink-muted)', lineHeight: 1.5, margin: '2px 0 0' }}>{tab.blurb}</p>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, flexWrap: 'wrap', marginTop: 'auto' }}>
        {!loaded ? (
          <span style={{ color: 'var(--rbk-ink-faint)' }}>Loading...</span>
        ) : !enabled ? (
          <span style={{ color: 'var(--rbk-warn)' }}>AI not configured</span>
        ) : report?.generatedAt ? (
          <>
            <Clock size={12} style={{ color: 'var(--rbk-ink-faint)' }} />
            <span style={{ color: 'var(--rbk-ink-muted)' }}>Last run {timeAgoShort(report.generatedAt)}</span>
            {report.stale && <Badge tone="warn" style={{ fontSize: 10, padding: '1px 6px' }}>Stale</Badge>}
            {report.model && <span style={{ color: 'var(--rbk-ink-faint)' }}>. {report.model}</span>}
          </>
        ) : (
          <span style={{ color: 'var(--rbk-ink-faint)' }}>Not run yet</span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={onOpen} disabled={!report?.generatedAt} className="rbk-btn-ghost" style={{ opacity: report?.generatedAt ? 1 : 0.4, cursor: report?.generatedAt ? 'pointer' : 'not-allowed' }}>
          <FileText size={13} /> Open last run
        </button>
        <button onClick={onRun} disabled={!enabled} className="rbk-btn-accent" style={{ opacity: enabled ? 1 : 0.5, cursor: enabled ? 'pointer' : 'default' }}>
          <Sparkles size={13} /> Run new
        </button>
      </div>
    </div>
  );
}

/* -- report modal (no Modal export in ui.jsx - built locally) --------- */
function AdvisorReportModal({ tab, initialReport, enabled, autoRun = false, onClose, onUpdated }) {
  const [report, setReport] = React.useState(initialReport || null);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState(null);
  const Icon = tab.icon;

  const run = React.useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const json = await apiFetch(`/advisor/${tab.slug}`, { method: 'POST', body: JSON.stringify({}) });
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
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} role="dialog" aria-modal="true">
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.65)', backdropFilter: 'blur(4px)' }} onClick={onClose} />
      <div className="rbk-panel rbk-scroll" style={{ position: 'relative', width: 'min(768px,92vw)', maxHeight: '85vh', display: 'flex', flexDirection: 'column', borderTop: `3px solid ${BRAND}`, padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, padding: '16px 16px 12px', borderBottom: '1px solid var(--rbk-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <Icon size={17} style={{ color: BRAND, flexShrink: 0 }} />
            <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--rbk-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tab.label}</p>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 28, width: 28, borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--rbk-ink-faint)', cursor: 'pointer', flexShrink: 0 }}>
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="rbk-scroll" style={{ padding: 16, overflowY: 'auto' }}>
          {report?.generatedAt && (
            <p style={{ fontSize: 11, color: 'var(--rbk-ink-faint)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 0, marginBottom: 12 }}>
              <span>{report.model ? `${report.model} - ` : ''}Generated {fmtTime(report.generatedAt)}</span>
              {report.stale && (
                <span title={`Older than ${report.ttlHours || 24}h - re-run for current data`}
                  style={{ color: 'var(--rbk-warn)', border: '1px solid rgba(251,191,36,0.4)', background: 'rgba(251,191,36,0.1)', borderRadius: 4, padding: '1px 4px', fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>
                  Stale
                </span>
              )}
            </p>
          )}

          {!enabled ? (
            <p style={{ fontSize: 12, color: 'var(--rbk-ink-muted)', lineHeight: 1.6 }}>
              AI analysis is not configured on the server. Set <code style={{ color: BRAND }}>OPENAI_TOKEN</code> (or
              <code style={{ color: BRAND }}> GITHUB_MODELS_TOKEN</code>) and restart.
            </p>
          ) : running ? (
            <LoadingPanel label="Analyzing the estate..." height={180} />
          ) : report?.content ? (
            <>
              {error && <p style={{ color: 'var(--rbk-crit)', fontSize: 12, marginBottom: 8 }}>{error}</p>}
              {report.stale && (
                <p style={{ marginBottom: 12, fontSize: 11, color: 'var(--rbk-warn)', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 6, padding: '6px 10px' }}>
                  This report is over {report.ttlHours || 24}h old and may not reflect current data. Re-run for an up-to-date view.
                </p>
              )}
              <Markdown text={report.content} />
            </>
          ) : (
            <p style={{ color: 'var(--rbk-ink-muted)', fontSize: 12, padding: '40px 0', textAlign: 'center' }}>
              {error ? <span style={{ color: 'var(--rbk-crit)' }}>{error}</span> : 'No report yet. Run one to analyze the estate.'}
            </p>
          )}

          {enabled && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--rbk-border)' }}>
              <button onClick={run} disabled={running} className="rbk-btn-accent" style={{ opacity: running ? 0.5 : 1, cursor: running ? 'default' : 'pointer' }}>
                <Sparkles size={13} />
                {report?.content ? 'Re-run' : 'Generate report'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function RubrikAdvisorPage() {
  const [states, setStates] = React.useState({}); // slug -> { enabled, report }
  const [open, setOpen] = React.useState(null);   // { slug, autoRun }

  const loadOne = React.useCallback(async (slug) => {
    try {
      const json = await apiFetch(`/advisor/${slug}`);
      setStates((s) => ({ ...s, [slug]: { enabled: json.enabled, report: json.report || null } }));
    } catch {
      setStates((s) => ({ ...s, [slug]: { enabled: true, report: null } }));
    }
  }, []);

  React.useEffect(() => { TABS.forEach((t) => loadOne(t.slug)); }, [loadOne]);

  const openTab = open ? TABS.find((t) => t.slug === open.slug) : null;

  return (
    <div className="rbk-root rbk-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader
        icon={Sparkles}
        title="AI Advisor"
        description="AI analyses for this platform. Reports run only when you ask - open the last run or generate a fresh one. Cached results are flagged stale after 24h." />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
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
