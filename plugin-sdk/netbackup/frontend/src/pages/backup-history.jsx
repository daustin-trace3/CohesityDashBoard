// NetBackup Backup History — ports host frontend/src/pages/netbackup/NbBackupHistoryPage.jsx.
import { injectStyles, PageHeader, Badge, LoadingPanel, CalendarIcon, SearchIcon, XIcon } from '../ui.jsx';
import { fmtBytes, runStatusTone, runStatusLabel, nbuStatusText, apiGet } from './helpers.js';

injectStyles();

const fmtTime = (ms) => (ms ? new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—');
const fmtDuration = (a, b) => {
  if (!a || !b || b < a) return '—';
  const s = Math.round((b - a) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
};
const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// window.ReactDOM is react-dom/client on current hosts — it has NO
// createPortal, so an unguarded call crashes the page (campaign trap #1).
// Fall back to inline rendering: the overlay is position:fixed, so it
// still covers the viewport without a portal.
function __portalOrInline(node) {
  const rd = typeof window !== 'undefined' ? window.ReactDOM : null;
  if (rd && typeof rd.createPortal === 'function') return rd.createPortal(node, document.body);
  return node;
}

function dayRollup(runs) {
  if (!runs || runs.length === 0) return null;
  if (runs.some((r) => r.status === 'kFailure')) return 'crit';
  if (runs.some((r) => r.status === 'kWarning')) return 'warn';
  if (runs.some((r) => r.status === 'kSuccess')) return 'ok';
  return 'info';
}
const BUBBLE = { ok: 'var(--nb-ok)', warn: 'var(--nb-warn)', crit: 'var(--nb-crit)', info: 'var(--nb-info)' };

export default function NbBackupHistoryPage() {
  const [sp, setSp] = ReactRouterDOM.useSearchParams();
  const [input, setInput] = React.useState(sp.get('q') || '');
  const [q, setQ] = React.useState(sp.get('q') || '');
  const [days, setDays] = React.useState(30);
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [modal, setModal] = React.useState(null);

  const search = React.useCallback((term, nDays) => {
    const query = String(term || '').trim();
    setLoading(true);
    apiGet('/backup-history', { q: query, days: nDays })
      .then((d) => { if (d && Array.isArray(d.servers)) setData(d); else setData({ query, servers: [] }); })
      .catch(() => setData({ query, servers: [] }))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => { search(q, days); }, [q, days, search]);

  const submit = (e) => {
    e?.preventDefault();
    const term = input.trim();
    setQ(term);
    setSp(term ? { q: term } : {}, { replace: true });
  };

  const dayCols = React.useMemo(() => {
    const cols = [];
    const now = new Date();
    for (let i = 0; i < days; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      cols.push({ key: dayKey(d.getTime()), label: d.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' }) });
    }
    return cols;
  }, [days]);

  const servers = React.useMemo(() => (data?.servers || []).map((s) => {
    const byDay = new Map();
    for (const r of s.runs || []) {
      if (!r.startMs) continue;
      const k = dayKey(r.startMs);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(r);
    }
    return { ...s, byDay };
  }), [data]);

  return (
    <div className="nb-root nb-fade-in">
      <PageHeader icon={CalendarIcon} title="Backup History" description="Day-by-day protection history for a client — search by name, click a day for run details">
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="nb-input" style={{ width: 'auto', cursor: 'pointer' }}>
          <option value={7}>7 days</option>
          <option value={14}>14 days</option>
          <option value={30}>30 days</option>
        </select>
      </PageHeader>

      <form onSubmit={submit} className="nb-panel" style={{ padding: 12, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 240 }}>
          <SearchIcon size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--nb-ink-faint)', pointerEvents: 'none' }} />
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Client name (min 2 characters)…" className="nb-input" style={{ paddingLeft: 32 }} />
        </div>
        <button type="submit" disabled={input.trim().length > 0 && input.trim().length < 2} className="nb-btn-accent">Search</button>
      </form>

      {loading ? (
        <LoadingPanel label="Loading backup history…" />
      ) : !data ? null : servers.length === 0 ? (
        <div className="nb-panel" style={{ padding: 40, textAlign: 'center', fontSize: 13, color: 'var(--nb-ink-muted)' }}>
          {data.browse ? 'No protected clients in the inventory yet — data appears after the next poll of each source.' : `No clients match "${data.query}".`}
        </div>
      ) : (
        <div className="nb-panel" style={{ padding: 16 }}>
          <p className="nb-tnum" style={{ fontSize: 11, color: 'var(--nb-ink-faint)', marginBottom: 12 }}>
            {data.browse ? `First ${servers.length} protected clients A–Z — search to find a specific client`
              : `${servers.length === 50 ? 'First 50 matches' : `${servers.length} match${servers.length === 1 ? '' : 'es'}`} for "${data.query}"`} · green = success, amber = warning, red = failure · bubble marks the day the run started
          </p>
          <div className="nb-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'separate', borderSpacing: 0 }}>
              <thead>
                <tr style={{ textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>
                  <th style={{ padding: '8px 12px 8px 0', position: 'sticky', left: 0, background: 'var(--nb-surface)', zIndex: 1, minWidth: 240, borderBottom: '1px solid var(--nb-border)' }}>Client / Policy / Source</th>
                  {dayCols.map((c) => (
                    <th key={c.key} className="nb-tnum" style={{ padding: '8px 4px', textAlign: 'center', fontWeight: 600, borderBottom: '1px solid var(--nb-border)' }}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {servers.map((s, idx) => (
                  <tr key={`${s.name}|${idx}`}>
                    <td style={{ padding: '8px 12px 8px 0', position: 'sticky', left: 0, background: 'var(--nb-surface)', zIndex: 1, borderBottom: '1px solid var(--nb-border)' }}>
                      <ReactRouterDOM.Link to={`/ops/server360?name=${encodeURIComponent(s.name)}`} title="Open Server 360"
                        style={{ color: 'var(--nb-ink)', fontWeight: 500, textDecoration: 'none', display: 'block', lineHeight: 1.3, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</ReactRouterDOM.Link>
                      <span style={{ fontSize: 11, color: 'var(--nb-ink-faint)', display: 'block', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={`${(s.policies || []).join(', ')} · ${(s.sourceNames || []).join(', ')}`}>
                        {(s.policies || []).join(', ') || 'unprotected'} · {(s.sourceNames || []).join(', ')}
                      </span>
                    </td>
                    {dayCols.map((c) => {
                      const runs = s.byDay.get(c.key);
                      const tone = dayRollup(runs);
                      const bytes = (runs || []).reduce((t, r) => t + (r.logicalBytes || 0), 0);
                      return (
                        <td key={c.key} style={{ padding: '8px 4px', textAlign: 'center', borderBottom: '1px solid var(--nb-border)' }}>
                          {tone ? (
                            <button onClick={() => setModal({ server: s, date: c.key, runs })}
                              title={`${runs.length} run${runs.length === 1 ? '' : 's'} · ${fmtBytes(bytes)} logical`}
                              style={{ display: 'inline-block', height: 14, width: 14, borderRadius: '50%', background: BUBBLE[tone], border: 'none', cursor: 'pointer', animation: tone === 'info' ? 'nb-orb-pulse 2.5s ease-in-out infinite' : undefined }} />
                          ) : <span style={{ color: 'var(--nb-ink-faint)', opacity: 0.4 }}>·</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {modal && __portalOrInline(
        <div onClick={() => setModal(null)} style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', padding: 16 }}>
          <div className="nb-panel" onClick={(e) => e.stopPropagation()} style={{ width: 'auto', minWidth: 560, maxWidth: '92vw', padding: 20, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
              <div style={{ minWidth: 0 }}>
                <h2 style={{ fontSize: 14, fontWeight: 700, color: 'var(--nb-ink)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {modal.server.name} — {new Date(`${modal.date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                </h2>
                <p style={{ fontSize: 11, color: 'var(--nb-ink-muted)', margin: 0 }}>{(modal.server.sourceNames || []).join(', ')} · {modal.runs.length} run{modal.runs.length === 1 ? '' : 's'}</p>
              </div>
              <button onClick={() => setModal(null)} aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--nb-ink-faint)', cursor: 'pointer', flexShrink: 0 }}><XIcon size={16} /></button>
            </div>
            <div className="nb-scroll" style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
              {modal.runs.map((r) => (
                <div key={r.id} style={{ background: 'var(--nb-surface-overlay)', borderRadius: 8, padding: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                    <Badge tone={runStatusTone(r.status)}>{runStatusLabel(r.status)}</Badge>
                    <span style={{ fontSize: 13, color: 'var(--nb-ink)', fontWeight: 500 }}>{r.group}</span>
                    {r.runType && <span style={{ fontSize: 11, color: 'var(--nb-ink-faint)' }}>{String(r.runType).replace(/^k/, '')}</span>}
                    {r.clusterName && <span style={{ fontSize: 11, color: 'var(--nb-ink-faint)', marginLeft: 'auto' }}>{r.clusterName}</span>}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 24px', fontSize: 12 }}>
                    <div style={{ whiteSpace: 'nowrap' }}><span style={{ color: 'var(--nb-ink-faint)' }}>Start</span> <span className="nb-tnum" style={{ color: 'var(--nb-ink)' }}>{fmtTime(r.startMs)}</span></div>
                    <div style={{ whiteSpace: 'nowrap' }}><span style={{ color: 'var(--nb-ink-faint)' }}>Duration</span> <span className="nb-tnum" style={{ color: 'var(--nb-ink)' }}>{fmtDuration(r.startMs, r.endMs)}</span></div>
                    <div style={{ whiteSpace: 'nowrap' }}><span style={{ color: 'var(--nb-ink-faint)' }}>Logical</span> <span className="nb-tnum" style={{ color: 'var(--nb-ink)' }}>{fmtBytes(r.logicalBytes)}</span></div>
                  </div>
                  {r.errorCode != null && (
                    <p style={{ fontSize: 12, color: 'var(--nb-crit)', marginTop: 8, wordBreak: 'break-word' }}>{nbuStatusText(r.errorCode)}{r.errorMessage ? `: ${r.errorMessage}` : ''}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>)}
    </div>
  );
}
