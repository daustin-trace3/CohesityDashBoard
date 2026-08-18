// NetBackup AI Advisor — the host's shared PlatformAdvisorPage + Markdown
// components aren't importable from a plugin bundle, so this ports a
// minimal equivalent hitting the same GET/POST /api/netbackup/advisor/:slug
// routes (backend/routes/netbackup.js lines ~1275-1300) with an inline
// (safe, no dangerouslySetInnerHTML) markdown renderer cloned from
// frontend/src/components/Markdown.jsx. Deliberate simplification vs. the
// host's tile grid — flagged in the build report.
import { injectStyles, PageHeader, LoadingPanel, Spinner, SparklesIcon, ClockIcon, XIcon } from '../ui.jsx';
import { apiGet, apiSend } from './helpers.js';

injectStyles();


// window.ReactDOM is react-dom/client on current hosts — it has NO
// createPortal, so an unguarded call crashes the page (campaign trap #1).
// Fall back to inline rendering: the overlay is position:fixed, so it
// still covers the viewport without a portal.
function __portalOrInline(node) {
  const rd = typeof window !== 'undefined' ? window.ReactDOM : null;
  if (rd && typeof rd.createPortal === 'function') return rd.createPortal(node, document.body);
  return node;
}

const TABS = [
  { slug: 'backup-health', label: 'Backup Health', blurb: '7-day job stats by policy and state, failing policies, stale clients, and open issues.' },
  { slug: 'capacity-planning', label: 'Capacity Planning', blurb: 'Storage unit and disk pool usage, growth trend, and front-end capacity by workload.' },
  { slug: 'resilience-review', label: 'Resilience Review', blurb: 'SLP/replication outcomes, catalog backup age, media server/appliance health, and single-copy policies.' },
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

/* Minimal safe markdown: headings, bold-only lines, lists, paragraphs,
 * inline **bold** / `code`. Ported from frontend/src/components/Markdown.jsx. */
function renderInline(text, keyPrefix) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={`${keyPrefix}-${i}`} style={{ color: 'var(--nb-ink)', fontWeight: 600 }}>{p.slice(2, -2)}</strong>;
    if (p.startsWith('`') && p.endsWith('`')) return <code key={`${keyPrefix}-${i}`} style={{ color: 'var(--nb-brand)', background: 'rgba(255,255,255,0.06)', borderRadius: 4, padding: '1px 4px', fontSize: 11 }}>{p.slice(1, -1)}</code>;
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
    <Tag style={{ paddingLeft: 20, margin: '6px 0' }}>
      {nodes.map((n, idx) => (
        <li key={`${key}-${idx}`} style={{ marginBottom: 4, lineHeight: 1.6 }}>
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
    <div style={{ fontSize: 12, color: 'var(--nb-ink-muted)', lineHeight: 1.6 }}>
      {blocks.map((b, idx) => {
        if (b.type === 'h') return <p key={idx} style={{ fontSize: 13, fontWeight: 700, color: 'var(--nb-ink)', margin: idx === 0 ? '0 0 6px' : '16px 0 6px', paddingBottom: 4, borderBottom: '1px solid var(--nb-border)' }}>{renderInline(b.text, `h${idx}`)}</p>;
        if (b.type === 'list') return <div key={idx}>{renderNodes(b.tree, `l${idx}`)}</div>;
        return <p key={idx} style={{ margin: '8px 0' }}>{renderInline(b.text, `p${idx}`)}</p>;
      })}
    </div>
  );
}

function ReportModal({ tab, initialReport, enabled, autoRun, onClose, onUpdated }) {
  const [report, setReport] = React.useState(initialReport || null);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState(null);
  const didAuto = React.useRef(false);

  const run = React.useCallback(() => {
    setRunning(true);
    setError(null);
    apiSend(`/advisor/${tab.slug}`, 'POST')
      .then((data) => { setReport(data); onUpdated?.(data); })
      .catch((e) => setError(e.body?.error || 'Report generation failed. Try again.'))
      .finally(() => setRunning(false));
  }, [tab.slug, onUpdated]);

  React.useEffect(() => {
    if (autoRun && !didAuto.current) { didAuto.current = true; run(); }
  }, [autoRun, run]);

  return __portalOrInline(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)', padding: 16 }}>
      <div className="nb-panel" onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 720, maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '16px 20px', borderBottom: '1px solid var(--nb-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <div style={{ display: 'flex', height: 28, width: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'rgba(177,24,30,0.1)', border: '1px solid rgba(177,24,30,0.2)', flexShrink: 0 }}>
              <SparklesIcon size={14} style={{ color: 'var(--nb-brand)' }} />
            </div>
            <div style={{ minWidth: 0 }}>
              <h2 style={{ fontSize: 14, fontWeight: 700, color: 'var(--nb-ink)', margin: 0 }}>{tab.label}</h2>
              {report?.generatedAt && (
                <p style={{ fontSize: 11, color: 'var(--nb-ink-faint)', margin: '2px 0 0' }}>
                  {report.model ? `${report.model} · ` : ''}Generated {new Date(report.generatedAt).toLocaleString()}
                  {report.stale && <span style={{ marginLeft: 6, color: 'var(--nb-warn)', border: '1px solid rgba(251,191,36,0.4)', background: 'rgba(251,191,36,0.1)', borderRadius: 4, padding: '1px 5px', fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>Stale</span>}
                </p>
              )}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--nb-ink-faint)', cursor: 'pointer', flexShrink: 0 }}><XIcon size={16} /></button>
        </div>
        <div className="nb-scroll" style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
          {!enabled ? (
            <p style={{ fontSize: 12, color: 'var(--nb-ink-muted)', lineHeight: 1.6 }}>
              AI analysis is not configured on the server. Set <code style={{ color: 'var(--nb-brand)' }}>OPENAI_TOKEN</code> (or <code style={{ color: 'var(--nb-brand)' }}>GITHUB_MODELS_TOKEN</code>) and restart.
            </p>
          ) : running ? (
            <LoadingPanel label="Analyzing the estate…" height={180} />
          ) : report?.content ? (
            <>
              {error && <p style={{ color: 'var(--nb-crit)', fontSize: 11, marginBottom: 8 }}>{error}</p>}
              {report.stale && (
                <p style={{ marginBottom: 12, fontSize: 11, color: 'var(--nb-warn)', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 6, padding: '6px 10px' }}>
                  This report is over {report.ttlHours || 24}h old and may not reflect current data. Re-run for an up-to-date view.
                </p>
              )}
              <Markdown text={report.content} />
            </>
          ) : (
            <p style={{ fontSize: 12, color: error ? 'var(--nb-crit)' : 'var(--nb-ink-muted)', padding: '40px 0', textAlign: 'center' }}>
              {error || 'No report yet. Run one to analyze the estate.'}
            </p>
          )}
        </div>
        {enabled && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 20px', borderTop: '1px solid var(--nb-border)' }}>
            <button onClick={run} disabled={running} className="nb-btn-accent">
              {running && <Spinner size={13} />} {report?.content ? 'Re-run' : 'Generate report'}
            </button>
          </div>
        )}
      </div>
    </div>);
}

function ReportTile({ tab, state, onOpen, onRun }) {
  const report = state?.report;
  const enabled = state?.enabled !== false;
  const loaded = state !== undefined;
  return (
    <div className="nb-panel" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14, minHeight: 200 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ display: 'flex', height: 40, width: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 10, background: 'rgba(177,24,30,0.1)', border: '1px solid rgba(177,24,30,0.2)', flexShrink: 0 }}>
          <SparklesIcon size={19} style={{ color: 'var(--nb-brand)' }} />
        </div>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--nb-ink)', margin: 0 }}>{tab.label}</p>
          <p style={{ fontSize: 11, color: 'var(--nb-ink-muted)', margin: '2px 0 0', lineHeight: 1.5 }}>{tab.blurb}</p>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 11, marginTop: 'auto' }}>
        {!loaded ? (
          <span style={{ color: 'var(--nb-ink-faint)' }}>Loading…</span>
        ) : !enabled ? (
          <span style={{ color: 'var(--nb-warn)' }}>AI not configured</span>
        ) : report?.generatedAt ? (
          <>
            <ClockIcon size={12} style={{ color: 'var(--nb-ink-faint)' }} />
            <span style={{ color: 'var(--nb-ink-muted)' }}>Last run {timeAgoShort(report.generatedAt)}</span>
            {report.stale && <span style={{ color: 'var(--nb-warn)', border: '1px solid rgba(251,191,36,0.4)', background: 'rgba(251,191,36,0.1)', borderRadius: 4, padding: '1px 5px', fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>Stale</span>}
          </>
        ) : (
          <span style={{ color: 'var(--nb-ink-faint)' }}>Not run yet</span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={onOpen} disabled={!report?.generatedAt} className="nb-btn-ghost" style={{ opacity: report?.generatedAt ? 1 : 0.4 }}>Open last run</button>
        <button onClick={onRun} disabled={!enabled} className="nb-btn-accent">
          <SparklesIcon size={13} /> Run new
        </button>
      </div>
    </div>
  );
}

export default function NbAdvisorPage() {
  const [states, setStates] = React.useState({});
  const [open, setOpen] = React.useState(null);

  const loadOne = React.useCallback((slug) => {
    apiGet(`/advisor/${slug}`)
      .then((data) => setStates((s) => ({ ...s, [slug]: { enabled: data.enabled, report: data.report || null } })))
      .catch(() => setStates((s) => ({ ...s, [slug]: { enabled: true, report: null } })));
  }, []);

  React.useEffect(() => { TABS.forEach((t) => loadOne(t.slug)); }, [loadOne]);

  const openTab = open ? TABS.find((t) => t.slug === open.slug) : null;

  return (
    <div className="nb-root nb-fade-in">
      <PageHeader icon={SparklesIcon} title="AI Advisor" description="AI analyses for this platform. Reports run only when you ask — open the last run or generate a fresh one. Cached results are flagged stale after 24h." />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16 }} className="nb-advisor-grid">
        <style>{`@media (min-width: 640px) { .nb-advisor-grid { grid-template-columns: 1fr 1fr !important; } } @media (min-width: 1200px) { .nb-advisor-grid { grid-template-columns: 1fr 1fr 1fr !important; } }`}</style>
        {TABS.map((tab) => (
          <ReportTile key={tab.slug} tab={tab} state={states[tab.slug]}
            onOpen={() => setOpen({ slug: tab.slug, autoRun: false })}
            onRun={() => setOpen({ slug: tab.slug, autoRun: true })} />
        ))}
      </div>
      {openTab && (
        <ReportModal tab={openTab} basePath="/advisor" initialReport={states[openTab.slug]?.report || null}
          enabled={states[openTab.slug]?.enabled !== false} autoRun={open.autoRun}
          onClose={() => setOpen(null)}
          onUpdated={(data) => setStates((s) => ({ ...s, [openTab.slug]: { enabled: true, report: data } }))} />
      )}
    </div>
  );
}
