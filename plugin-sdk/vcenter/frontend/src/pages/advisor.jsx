// vCenter AI Advisor — ported from the built-in VcAdvisorPage.jsx, which
// delegated to the shared components/PlatformAdvisorPage.jsx +
// AdvisorReportModal.jsx + Markdown.jsx (none importable in a plugin
// sandbox). Reimplemented self-contained here: same tabs, same endpoints
// (GET/POST /api/vcenter/advisor/:slug), same cached-report/stale/run-new
// behavior, just apiFetch + inline styles instead of axios + Tailwind
// component imports. No anonymizer call is made from the frontend — the
// built-in page didn't make one either; anonymization (if any) is backend-side.
import { Sparkles, FileText, Clock, Database, ClipboardCheck, Gauge } from '../icons.jsx';
import { apiFetch, PageHeader, LoadingPanel, Modal } from '../ui.jsx';

const BRAND = '#0091DA';

const TABS = [
  { slug: 'capacity', label: 'Capacity & Pressure', icon: Database,
    blurb: 'Datastore and cluster capacity pressure, growth trends, and where headroom is tight.' },
  { slug: 'operations-review', label: 'Operations Review', icon: ClipboardCheck,
    blurb: 'Host and VM events — maintenance-mode churn, failures, and operational risk patterns.' },
  { slug: 'efficiency', label: 'Efficiency & Hygiene', icon: Gauge,
    blurb: 'Orphaned VMs, oversized allocations, and other reclaimable-resource hygiene issues.' },
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

/* ── minimal markdown renderer (no raw HTML) — ported from
 * components/Markdown.jsx, using inline styles instead of the host's
 * Tailwind vocabulary (marker:/first: variants aren't in the plugin's
 * hand-rolled utility sheet). ─────────────────────────────────────────── */
function renderInline(text, keyPrefix) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) {
      return <strong key={`${keyPrefix}-${i}`} style={{ color: 'var(--vc-ink)', fontWeight: 600 }}>{p.slice(2, -2)}</strong>;
    }
    if (p.startsWith('`') && p.endsWith('`')) {
      return <code key={`${keyPrefix}-${i}`} style={{ color: 'var(--vc-brand)', background: 'rgba(30,42,54,0.6)', borderRadius: 4, padding: '1px 4px', fontSize: 11 }}>{p.slice(1, -1)}</code>;
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
    <div style={{ fontSize: 12, color: 'var(--vc-ink-muted)', lineHeight: 1.6 }}>
      {blocks.map((b, idx) => {
        if (b.type === 'h') {
          return (
            <p key={idx} style={{ fontSize: 13, fontWeight: 700, color: 'var(--vc-ink)', marginTop: idx === 0 ? 0 : 16, marginBottom: 6, paddingBottom: 4, borderBottom: '1px solid rgba(31,43,55,0.5)' }}>
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

/* ── report tile ─────────────────────────────────────────────────────── */
function ReportTile({ tab, state, onOpen, onRun }) {
  const Icon = tab.icon;
  const report = state?.report;
  const enabled = state?.enabled !== false;
  const loaded = state !== undefined;

  return (
    <div className="panel" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, minHeight: 200 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ display: 'flex', height: 40, width: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 12, background: 'rgba(0,145,218,0.1)', border: '1px solid rgba(0,145,218,0.2)', flexShrink: 0 }}>
          <Icon size={20} style={{ color: BRAND }} />
        </div>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--vc-ink)', margin: 0 }}>{tab.label}</p>
          <p style={{ fontSize: 12, color: 'var(--vc-ink-muted)', lineHeight: 1.5, margin: '2px 0 0' }}>{tab.blurb}</p>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, flexWrap: 'wrap', marginTop: 'auto' }}>
        {!loaded ? (
          <span style={{ color: 'var(--vc-ink-faint)' }}>Loading…</span>
        ) : !enabled ? (
          <span style={{ color: 'var(--vc-warn)' }}>AI not configured</span>
        ) : report?.generatedAt ? (
          <>
            <Clock size={12} style={{ color: 'var(--vc-ink-faint)' }} />
            <span style={{ color: 'var(--vc-ink-muted)' }}>Last run {timeAgoShort(report.generatedAt)}</span>
            {report.stale && (
              <span style={{ color: 'var(--vc-warn)', border: '1px solid rgba(251,191,36,0.4)', background: 'rgba(251,191,36,0.1)', borderRadius: 4, padding: '1px 4px', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.03em' }}>Stale</span>
            )}
            {report.model && <span style={{ color: 'var(--vc-ink-faint)' }}>· {report.model}</span>}
          </>
        ) : (
          <span style={{ color: 'var(--vc-ink-faint)' }}>Not run yet</span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={onOpen} disabled={!report?.generatedAt} className="vc-btn-ghost" style={{ opacity: report?.generatedAt ? 1 : 0.4, cursor: report?.generatedAt ? 'pointer' : 'not-allowed' }}>
          <FileText size={13} /> Open last run
        </button>
        <button onClick={onRun} disabled={!enabled}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500, padding: '8px 12px', background: 'rgba(0,145,218,0.1)', border: '1px solid rgba(0,145,218,0.3)', color: BRAND, borderRadius: 8, cursor: enabled ? 'pointer' : 'default', opacity: enabled ? 1 : 0.5 }}>
          <Sparkles size={13} /> Run new
        </button>
      </div>
    </div>
  );
}

/* ── report modal ────────────────────────────────────────────────────── */
function AdvisorReportModal({ tab, initialReport, enabled, autoRun = false, onClose, onUpdated }) {
  const [report, setReport] = React.useState(initialReport || null);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState(null);
  const Icon = tab.icon;

  const run = React.useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const json = await apiFetch(`/vcenter/advisor/${tab.slug}`, { method: 'POST', body: {} });
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
        <p style={{ fontSize: 11, color: 'var(--vc-ink-faint)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: -8, marginBottom: 12 }}>
          <span>{report.model ? `${report.model} · ` : ''}Generated {fmtTime(report.generatedAt)}</span>
          {report.stale && (
            <span title={`Older than ${report.ttlHours || 24}h — re-run for current data`}
              style={{ color: 'var(--vc-warn)', border: '1px solid rgba(251,191,36,0.4)', background: 'rgba(251,191,36,0.1)', borderRadius: 4, padding: '1px 4px', fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>
              Stale
            </span>
          )}
        </p>
      )}

      {!enabled ? (
        <p style={{ fontSize: 12, color: 'var(--vc-ink-muted)', lineHeight: 1.6 }}>
          AI analysis is not configured on the server. Set <code style={{ color: BRAND }}>OPENAI_TOKEN</code> (or
          <code style={{ color: BRAND }}> GITHUB_MODELS_TOKEN</code>) and restart.
        </p>
      ) : running ? (
        <LoadingPanel label="Analyzing the estate…" height={180} />
      ) : report?.content ? (
        <>
          {error && <p style={{ color: 'var(--vc-crit)', fontSize: 12, marginBottom: 8 }}>{error}</p>}
          {report.stale && (
            <p style={{ marginBottom: 12, fontSize: 11, color: 'var(--vc-warn)', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 6, padding: '6px 10px' }}>
              This report is over {report.ttlHours || 24}h old and may not reflect current data. Re-run for an up-to-date view.
            </p>
          )}
          <Markdown text={report.content} />
        </>
      ) : (
        <p style={{ color: 'var(--vc-ink-muted)', fontSize: 12, padding: '40px 0', textAlign: 'center' }}>
          {error ? <span style={{ color: 'var(--vc-crit)' }}>{error}</span> : 'No report yet. Run one to analyze the estate.'}
        </p>
      )}

      {enabled && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--vc-border)' }}>
          <button onClick={run} disabled={running}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500, padding: '7px 12px', background: 'rgba(0,145,218,0.1)', border: '1px solid rgba(0,145,218,0.3)', color: BRAND, borderRadius: 8, cursor: running ? 'default' : 'pointer', opacity: running ? 0.5 : 1 }}>
            <Sparkles size={13} />
            {report?.content ? 'Re-run' : 'Generate report'}
          </button>
        </div>
      )}
    </Modal>
  );
}

export default function VcAdvisorPage() {
  const [states, setStates] = React.useState({}); // slug -> { enabled, report }
  const [open, setOpen] = React.useState(null);   // { slug, autoRun }

  const loadOne = React.useCallback(async (slug) => {
    try {
      const json = await apiFetch(`/vcenter/advisor/${slug}`);
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
        description="AI analyses for this platform. Reports run only when you ask — open the last run or generate a fresh one. Cached results are flagged stale after 24h." />

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
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
