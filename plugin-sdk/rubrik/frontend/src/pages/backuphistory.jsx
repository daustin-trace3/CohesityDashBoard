// Rubrik v2.1.0 Backup History page — true clone of host frontend/src/pages/
// BackupHistoryPage.jsx (per-server day-by-day bubble matrix + run-detail
// modal), substituting Rubrik data/status vocabulary. See RUBRIK_V21_CONTRACT
// SCOUT REPORT A §1 for the byte-for-byte behavior this mirrors.
//
// The kit's charts.jsx BubbleMatrix renders the whole grid as one <svg>,
// which cannot do a real sticky first column, per-cell hover rings, or
// circular <button> affordances (all called for by the fidelity spec). This
// page reimplements the matrix as an HTML table instead, reusing the kit's
// color tokens/status vocabulary — flagged here as a deliberate kit gap
// rather than an oversight.
import {
  PageHeader, Badge, LoadingPanel, CalendarIcon, SearchIcon, XIcon, EmptyState,
} from '../ui';

function ArrowLeftRightIcon({ size = 16, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={style}>
      <path d="M17 3l4 4-4 4" /><path d="M21 7H9a4 4 0 0 0-4 4v1" />
      <path d="M7 21l-4-4 4-4" /><path d="M3 17h12a4 4 0 0 0 4-4v-1" />
    </svg>
  );
}

const STATUS_TONE = { Succeeded: 'ok', Warning: 'warn', Failed: 'crit', Canceled: 'neutral', Running: 'info' };
const STATUS_LABEL = { Succeeded: 'Success', Warning: 'Warning', Failed: 'Failed', Canceled: 'Canceled', Running: 'Running' };
const statusLabel = (s) => (s ? (STATUS_LABEL[s] || String(s)) : null);

function fmtBytes(b) {
  if (b == null) return '—';
  if (b >= 1e12) return `${(b / 1e12).toLocaleString(undefined, { maximumFractionDigits: 2 })} TB`;
  if (b >= 1e9) return `${(b / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  if (b >= 1e6) return `${(b / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
  return `${Number(b).toLocaleString()} B`;
}
function fmtTime(ms) {
  return ms ? new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—';
}
function fmtDuration(a, b) {
  if (!a || !b || b < a) return '—';
  const s = Math.round((b - a) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function dayRollup(runs) {
  if (!runs || runs.length === 0) return null;
  if (runs.some((r) => r.status === 'Failed')) return 'crit';
  if (runs.some((r) => r.status === 'Warning' || r.status === 'Canceled')) return 'warn';
  if (runs.some((r) => r.status === 'Succeeded')) return 'ok';
  return 'info';
}

const BUBBLE_COLOR = { ok: 'var(--rbk-ok)', warn: 'var(--rbk-warn)', crit: 'var(--rbk-crit)', info: 'var(--rbk-info)' };

export default function BackupHistoryPage() {
  const initialQ = React.useMemo(() => {
    try { return new URLSearchParams(window.location.search).get('q') || ''; } catch { return ''; }
  }, []);
  const [input, setInput] = React.useState(initialQ);
  const [q, setQ] = React.useState(initialQ);
  const [days, setDays] = React.useState(30);
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [modal, setModal] = React.useState(null); // { server, date, runs }
  const [details, setDetails] = React.useState({}); // runId -> { loading | data }

  const loadDetail = (runId, serverName) => {
    setDetails((d) => ({ ...d, [runId]: { loading: true } }));
    fetch(`/api/rubrik/backup-history/run/${runId}/detail?server=${encodeURIComponent(serverName)}`, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((json) => setDetails((d) => ({ ...d, [runId]: { data: json } })))
      .catch(() => setDetails((d) => ({ ...d, [runId]: { data: { failed: true } } })));
  };

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/rubrik/backup-history?q=${encodeURIComponent(q)}&days=${days}`, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((json) => { if (!cancelled) setData(json && Array.isArray(json.servers) ? json : { query: q, servers: [] }); })
      .catch(() => { if (!cancelled) setData({ query: q, servers: [] }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [q, days]);

  const submit = (e) => {
    e?.preventDefault();
    const term = input.trim();
    setQ(term);
    try {
      const url = new URL(window.location.href);
      if (term) url.searchParams.set('q', term); else url.searchParams.delete('q');
      window.history.replaceState({}, '', url);
    } catch { /* ignore */ }
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

  const servers = React.useMemo(
    () => (data?.servers || []).map((s) => {
      const byDay = new Map();
      for (const r of s.runs || []) {
        if (!r.startMs) continue;
        const k = dayKey(r.startMs);
        if (!byDay.has(k)) byDay.set(k, []);
        byDay.get(k).push(r);
      }
      return { ...s, byDay };
    }),
    [data]
  );

  return (
    <div className="rbk-root rbk-fade-in">
      <PageHeader icon={CalendarIcon} title="Backup History"
        description="Day-by-day protection history for a server — search by name, click a day for run details">
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="rbk-input" style={{ width: 'auto' }}>
          <option value={7}>7 days</option>
          <option value={14}>14 days</option>
          <option value={30}>30 days</option>
        </select>
      </PageHeader>

      <form onSubmit={submit} className="rbk-panel" style={{ padding: 12, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 240 }}>
          <SearchIcon size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--rbk-ink-faint)', pointerEvents: 'none' }} />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Server or object name (min 2 characters)…"
            className="rbk-input"
            style={{ paddingLeft: 32 }}
          />
        </div>
        <button type="submit" disabled={input.trim().length > 0 && input.trim().length < 2} className="rbk-btn-accent">
          Search
        </button>
      </form>

      {loading ? (
        <LoadingPanel label="Loading backup history…" />
      ) : !data ? null : servers.length === 0 ? (
        <div className="rbk-panel" style={{ padding: 40 }}>
          <EmptyState
            icon={CalendarIcon}
            title="No matching servers"
            description={data.browse
              ? 'No protected servers in the inventory yet — data appears after the next poll of each cluster.'
              : `No objects match "${data.query}". Names come from the Sources inventory — try a shorter fragment.`}
          />
        </div>
      ) : (
        <div className="rbk-panel" style={{ padding: 16 }}>
          <p className="rbk-tnum" style={{ fontSize: 11, color: 'var(--rbk-ink-faint)', marginBottom: 10 }}>
            {data.browse
              ? `First ${servers.length} protected servers A–Z — search to find a specific server`
              : `${servers.length === 50 ? 'First 50 matches' : `${servers.length} match${servers.length === 1 ? '' : 'es'}`} for "${data.query}"`}
            {' · green = success, amber = warning/canceled, red = failure · bubble marks the day the run started'}
          </p>
          <div className="rbk-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ position: 'sticky', left: 0, background: 'var(--rbk-surface)', zIndex: 1, textAlign: 'left', padding: '6px 12px 6px 0', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--rbk-ink-faint)', borderBottom: '1px solid var(--rbk-border)', minWidth: 240 }}>
                    Server / Group / Cluster
                  </th>
                  {dayCols.map((c) => (
                    <th key={c.key} className="rbk-tnum" style={{ padding: '6px 4px', textAlign: 'center', fontSize: 11, fontWeight: 600, color: 'var(--rbk-ink-faint)', borderBottom: '1px solid var(--rbk-border)' }}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {servers.map((s, idx) => (
                  <tr key={`${s.name}|${idx}`}>
                    <td style={{ position: 'sticky', left: 0, background: 'var(--rbk-surface)', zIndex: 1, padding: '8px 12px 8px 0', borderBottom: '1px solid var(--rbk-border)' }}>
                      <ReactRouterDOM.Link
                        to={`/rubrik/object-360?name=${encodeURIComponent(s.name)}`}
                        title="Open Object 360"
                        style={{ color: 'var(--rbk-ink)', fontWeight: 500, display: 'block', lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 280, textDecoration: 'none' }}
                        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--rbk-brand)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--rbk-ink)'; }}
                      >
                        {s.name}
                      </ReactRouterDOM.Link>
                      <div
                        title={`${(s.groups || []).join(', ')} · ${(s.clusters || []).join(', ')}`}
                        style={{ fontSize: 11, color: 'var(--rbk-ink-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 280 }}
                      >
                        {(s.groups || []).join(', ') || 'unprotected'} · {(s.clusters || []).join(', ')}
                      </div>
                    </td>
                    {dayCols.map((c) => {
                      const runs = s.byDay.get(c.key);
                      const tone = dayRollup(runs);
                      const bytes = (runs || []).reduce((t, r) => t + (r.logicalBytes || 0), 0);
                      return (
                        <td key={c.key} style={{ padding: '8px 4px', textAlign: 'center', borderBottom: '1px solid var(--rbk-border)' }}>
                          {tone ? (
                            <button
                              onClick={() => setModal({ server: s, date: c.key, runs })}
                              title={`${runs.length} run${runs.length === 1 ? '' : 's'} · ${fmtBytes(bytes)} logical`}
                              aria-label={`Backups on ${c.key}`}
                              style={{
                                width: 14, height: 14, borderRadius: '50%', border: 'none', padding: 0, cursor: 'pointer',
                                background: BUBBLE_COLOR[tone],
                                animation: tone === 'info' ? 'rbk-orb-pulse 2s ease-in-out infinite' : undefined,
                                boxShadow: 'none',
                                transition: 'box-shadow 150ms',
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 0 0 3px rgba(0,179,136,0.35)'; }}
                              onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'none'; }}
                            />
                          ) : (
                            <span style={{ color: 'var(--rbk-ink-faint)', opacity: 0.4 }}>·</span>
                          )}
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

      {modal && ReactDOM.createPortal(
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(4px)', padding: 16 }}
          onClick={() => setModal(null)}
        >
          <div
            className="rbk-panel rbk-scroll"
            style={{ width: 'auto', minWidth: 560, maxWidth: '92vw', maxHeight: '85vh', padding: 20, display: 'flex', flexDirection: 'column', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,.6)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
              <div style={{ minWidth: 0 }}>
                <h2 style={{ fontSize: 15, fontWeight: 700, color: 'var(--rbk-ink)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {modal.server.name} — {new Date(`${modal.date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                </h2>
                <p style={{ fontSize: 11, color: 'var(--rbk-ink-muted)', margin: '2px 0 0' }}>
                  {(modal.server.clusters || []).join(', ')} · {modal.server.environment || '—'}{modal.server.osType ? ` · ${modal.server.osType}` : ''} · {modal.runs.length} run{modal.runs.length === 1 ? '' : 's'}
                </p>
              </div>
              <button onClick={() => setModal(null)} aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--rbk-ink-faint)', cursor: 'pointer', flexShrink: 0 }}>
                <XIcon size={16} />
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {modal.runs.map((r) => (
                <div key={r.id} style={{ background: 'var(--rbk-surface-overlay)', borderRadius: 8, padding: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                    <Badge tone={STATUS_TONE[r.status] || 'neutral'}>{statusLabel(r.status)}</Badge>
                    <span style={{ fontSize: 13, color: 'var(--rbk-ink)', fontWeight: 500 }}>{r.group}</span>
                    {r.runType && <span style={{ fontSize: 11, color: 'var(--rbk-ink-faint)' }}>{r.runType}</span>}
                    {r.clusterName && <span style={{ fontSize: 11, color: 'var(--rbk-ink-faint)', marginLeft: 'auto' }}>{r.clusterName}</span>}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 24px', fontSize: 12 }}>
                    <div style={{ whiteSpace: 'nowrap' }}><span style={{ color: 'var(--rbk-ink-faint)' }}>Start</span> <span className="rbk-tnum" style={{ color: 'var(--rbk-ink)' }}>{fmtTime(r.startMs)}</span></div>
                    <div style={{ whiteSpace: 'nowrap' }}><span style={{ color: 'var(--rbk-ink-faint)' }}>Duration</span> <span className="rbk-tnum" style={{ color: 'var(--rbk-ink)' }}>{fmtDuration(r.startMs, r.endMs)}</span></div>
                    <div style={{ whiteSpace: 'nowrap' }}><span style={{ color: 'var(--rbk-ink-faint)' }}>Logical</span> <span className="rbk-tnum" style={{ color: 'var(--rbk-ink)' }}>{fmtBytes(r.logicalBytes)}</span></div>
                    <div style={{ whiteSpace: 'nowrap' }}><span style={{ color: 'var(--rbk-ink-faint)' }}>Policy</span> <span style={{ color: 'var(--rbk-ink)' }}>{(modal.server.policies || [])[0] || '—'}</span></div>
                  </div>
                  {r.errorMessage && (
                    <p style={{ fontSize: 12, color: 'var(--rbk-crit)', marginTop: 8, wordBreak: 'break-word' }}>{r.errorCode ? `${r.errorCode}: ` : ''}{r.errorMessage}</p>
                  )}
                  {!details[r.id] ? (
                    <button
                      onClick={() => loadDetail(r.id, modal.server.name)}
                      style={{ marginTop: 8, fontSize: 11, fontWeight: 600, color: 'var(--rbk-brand)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                    >
                      Details from cluster…
                    </button>
                  ) : details[r.id].loading ? (
                    <p style={{ fontSize: 11, color: 'var(--rbk-ink-faint)', marginTop: 8 }}>Fetching run detail from {r.clusterName || 'cluster'}…</p>
                  ) : (() => {
                    const d = details[r.id].data || {};
                    if (d.failed) return <p style={{ fontSize: 11, color: 'var(--rbk-warn)', marginTop: 8 }}>Could not fetch live detail (cluster unreachable?).</p>;
                    if (d.demo) return <p style={{ fontSize: 11, color: 'var(--rbk-ink-faint)', marginTop: 8 }}>Live run detail is unavailable in demo mode.</p>;
                    if (d.notFound) return <p style={{ fontSize: 11, color: 'var(--rbk-ink-faint)', marginTop: 8 }}>Run no longer available on the cluster (aged out).</p>;
                    return (
                      <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--rbk-border)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {d.thisServer && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, flexWrap: 'wrap' }}>
                            <span style={{ color: 'var(--rbk-ink-faint)' }}>This server:</span>
                            <Badge tone={STATUS_TONE[d.thisServer.status] || 'neutral'}>{statusLabel(d.thisServer.status) || '—'}</Badge>
                            {d.thisServer.bytesRead != null && <span className="rbk-tnum" style={{ color: 'var(--rbk-ink-faint)' }}>{fmtBytes(d.thisServer.bytesRead)} read</span>}
                            {d.thisServer.numRestarts > 0 && <span className="rbk-tnum" style={{ color: 'var(--rbk-warn)' }}>{d.thisServer.numRestarts} restart{d.thisServer.numRestarts === 1 ? '' : 's'}</span>}
                            {d.thisServer.error && <span style={{ color: 'var(--rbk-crit)', wordBreak: 'break-word' }}>{d.thisServer.error}</span>}
                          </div>
                        )}
                        {d.thisServer?.warnings?.length > 0 && d.thisServer.warnings.map((w, i) => (
                          <p key={i} style={{ fontSize: 11, color: 'var(--rbk-warn)', margin: 0, wordBreak: 'break-word' }}>{w}</p>
                        ))}
                        {d.objectSummary && (
                          <p className="rbk-tnum" style={{ fontSize: 11, color: 'var(--rbk-ink-faint)', margin: 0 }}>
                            Group: {Object.entries(d.objectSummary).map(([status, n]) => `${n} ${statusLabel(status) || status}`).join(' · ')} ({d.objectCount} object{d.objectCount === 1 ? '' : 's'})
                          </p>
                        )}
                        {d.error && <p style={{ fontSize: 11, color: 'var(--rbk-crit)', margin: 0, wordBreak: 'break-word' }}>{d.error}</p>}
                        {(d.warnings || []).map((w, i) => (
                          <p key={i} style={{ fontSize: 11, color: 'var(--rbk-ink-muted)', margin: 0, wordBreak: 'break-word' }}>⚠ {w}</p>
                        ))}
                      </div>
                    );
                  })()}
                  {r.replication && r.replication.length > 0 && (
                    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--rbk-border)' }}>
                      <p style={{ fontSize: 11, color: 'var(--rbk-ink-faint)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                        <ArrowLeftRightIcon size={11} /> Replication
                      </p>
                      {r.replication.map((rep, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '2px 0' }}>
                          <Badge tone={STATUS_TONE[rep.status] || 'neutral'}>{statusLabel(rep.status) || '—'}</Badge>
                          <span style={{ color: 'var(--rbk-ink)' }}>{rep.targetCluster || '—'}</span>
                          <span className="rbk-tnum" style={{ color: 'var(--rbk-ink-faint)', marginLeft: 'auto' }}>{fmtBytes(rep.logicalBytes)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
