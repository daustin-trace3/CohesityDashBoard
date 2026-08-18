// Cohesity plugin — Backup History page. Ported from
// frontend/src/pages/BackupHistoryPage.jsx. client (axios) -> apiFetch;
// useSearchParams/Link -> window.ReactRouterDOM; react-dom createPortal ->
// ui.jsx's Modal (which itself guards createPortal via portalOrInline — the
// host's window.ReactDOM has no createPortal, only createRoot). The
// per-server day-by-day bubble matrix is hand-drawn markup in the source
// (not a chart.js chart), so it stays page-local markup here too.
import { apiFetch, useToast, PageHeader, Badge, LoadingPanel, Modal } from '../ui.jsx';
import { ArrowLeftRight } from '../icons.jsx';

/* ── Icons not in the shared set — page-local per the plugin-kit-gap
 * convention (see governance.jsx for the same pattern). ── */
function LocalIcon({ children, size = 16, className = '', ...rest }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...rest}>
      {children}
    </svg>
  );
}
const CalendarCheck = (p) => <LocalIcon {...p}><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /><path d="m9 16 2 2 4-4" /></LocalIcon>;
const Search = (p) => <LocalIcon {...p}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></LocalIcon>;

const fmtBytes = (b) => {
  if (b == null) return '—';
  if (b >= 1e12) return `${(b / 1e12).toLocaleString(undefined, { maximumFractionDigits: 2 })} TB`;
  if (b >= 1e9) return `${(b / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  if (b >= 1e6) return `${(b / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
  return `${Number(b).toLocaleString()} B`;
};
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—');
const fmtDuration = (a, b) => {
  if (!a || !b || b < a) return '—';
  const s = Math.round((b - a) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
};

const STATUS_TONE = { kSuccess: 'ok', kWarning: 'warn', kFailure: 'crit', kCanceled: 'neutral', kRunning: 'info', kAccepted: 'info' };
const STATUS_LABEL = { kSuccess: 'Success', kWarning: 'Warning', kFailure: 'Failed', kCanceled: 'Canceled', kRunning: 'Running', kAccepted: 'Queued' };
// Unknown statuses (kSkipped, k6Abort…) render without the Cohesity 'k' prefix.
const statusLabel = (s) => (s ? (STATUS_LABEL[s] || String(s).replace(/^k/, '')) : null);

/** Local YYYY-MM-DD key for a timestamp. */
const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Worst-of-day rollup for the bubble color. */
function dayRollup(runs) {
  if (!runs || runs.length === 0) return null;
  if (runs.some((r) => r.status === 'kFailure')) return 'crit';
  if (runs.some((r) => r.status === 'kWarning' || r.status === 'kCanceled')) return 'warn';
  if (runs.some((r) => r.status === 'kSuccess')) return 'ok';
  return 'info'; // only running/queued
}

const BUBBLE_COLOR = { ok: 'var(--co-ok)', warn: 'var(--co-warn)', crit: 'var(--co-crit)', info: 'var(--co-info)' };

export default function BackupHistoryPage() {
  const { toast } = useToast();
  const [sp, setSp] = window.ReactRouterDOM.useSearchParams();
  const [input, setInput] = React.useState(sp.get('q') || '');
  const [q, setQ] = React.useState(sp.get('q') || '');
  const [days, setDays] = React.useState(30);
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [modal, setModal] = React.useState(null); // { server, date, runs }
  const [details, setDetails] = React.useState({}); // runId -> { loading | data }

  const loadDetail = (runId, serverName) => {
    setDetails((d) => ({ ...d, [runId]: { loading: true } }));
    apiFetch(`/cohesity/backup-history/run/${runId}/detail?server=${encodeURIComponent(serverName)}`)
      .then((data) => setDetails((d) => ({ ...d, [runId]: { data } })))
      .catch(() => setDetails((d) => ({ ...d, [runId]: { data: { failed: true } } })));
  };

  const search = React.useCallback((term, nDays) => {
    const query = String(term || '').trim();
    setLoading(true);
    apiFetch(`/cohesity/backup-history?q=${encodeURIComponent(query)}&days=${nDays}`)
      .then((data) => {
        if (data && Array.isArray(data.servers)) setData(data);
        else {
          setData({ query, servers: [] });
          toast({ type: 'error', title: 'Unexpected response', message: 'The backend may not have been restarted since this feature was deployed.' });
        }
      })
      .catch(() => { setData({ query, servers: [] }); toast({ type: 'error', title: 'Failed to load backup history' }); })
      .finally(() => setLoading(false));
  }, [toast]);

  React.useEffect(() => { search(q, days); }, [q, days, search]);

  const submit = (e) => {
    e?.preventDefault();
    const term = input.trim();
    setQ(term);
    setSp(term ? { q: term } : {}, { replace: true });
  };

  // Day columns, newest first (like the classic backup-matrix view).
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
    <div className="animate-fade-in">
      <PageHeader icon={CalendarCheck} title="Backup History" description="Day-by-day protection history for a server — search by name, click a day for run details">
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="co-input" style={{ width: 'auto' }}>
          <option value={7}>7 days</option>
          <option value={14}>14 days</option>
          <option value={30}>30 days</option>
        </select>
      </PageHeader>

      <form onSubmit={submit} className="panel" style={{ padding: 12, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 240 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--co-ink-faint)', pointerEvents: 'none' }} />
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Server or object name (min 2 characters)…" className="co-input" style={{ paddingLeft: 32 }} />
        </div>
        <button type="submit" disabled={input.trim().length > 0 && input.trim().length < 2} className="co-btn-ghost" style={{ background: 'rgba(108,179,63,0.1)', borderColor: 'rgba(108,179,63,0.3)', color: 'var(--co-brand)' }}>
          Search
        </button>
      </form>

      {loading ? (
        <LoadingPanel label="Loading backup history…" />
      ) : !data ? null : servers.length === 0 ? (
        <div className="panel" style={{ padding: 40, textAlign: 'center', fontSize: 13, color: 'var(--co-ink-muted)' }}>
          {data.browse
            ? 'No protected servers in the inventory yet — data appears after the next poll of each cluster.'
            : <>No objects match &ldquo;{data.query}&rdquo;. Names come from the Sources inventory — try a shorter fragment.</>}
        </div>
      ) : (
        <div className="panel" style={{ padding: 16 }}>
          <p className="tnum" style={{ fontSize: 11, color: 'var(--co-ink-faint)', margin: '0 0 12px' }}>
            {data.browse
              ? `First ${servers.length} protected servers A–Z — search to find a specific server`
              : `${servers.length === 50 ? 'First 50 matches' : `${servers.length} match${servers.length === 1 ? '' : 'es'}`} for “${data.query}”`} ·
            {' '}green = success, amber = warning/canceled, red = failure · bubble marks the day the run started
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderSpacing: 0, borderCollapse: 'separate' }}>
              <thead>
                <tr style={{ textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.03em', color: 'var(--co-ink-faint)' }}>
                  <th style={{ padding: '8px 12px 8px 0', position: 'sticky', left: 0, background: 'var(--co-surface)', zIndex: 1, minWidth: 240, borderBottom: '1px solid var(--co-border)' }}>Server / Group / Cluster</th>
                  {dayCols.map((c) => (
                    <th key={c.key} className="tnum" style={{ padding: '8px 4px', textAlign: 'center', fontWeight: 600, borderBottom: '1px solid var(--co-border)' }}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {servers.map((s, idx) => (
                  <tr key={`${s.name}|${s.clusterName}|${idx}`}>
                    <td style={{ padding: '8px 12px 8px 0', position: 'sticky', left: 0, background: 'var(--co-surface)', zIndex: 1, borderBottom: '1px solid rgba(31,43,55,.5)' }}>
                      <window.ReactRouterDOM.Link to={`/ops/server360?name=${encodeURIComponent(s.name)}`} title="Open Server 360"
                        className="truncate" style={{ display: 'block', color: 'var(--co-ink)', fontWeight: 500, lineHeight: 1.3, maxWidth: 280, textDecoration: 'none' }}>{s.name}</window.ReactRouterDOM.Link>
                      <span className="truncate" style={{ display: 'block', fontSize: 11, color: 'var(--co-ink-faint)', maxWidth: 280 }}
                        title={`${(s.groups || []).join(', ')} · ${(s.clusters || []).join(', ')}`}>
                        {(s.groups || []).join(', ') || 'unprotected'} · {(s.clusters || []).join(', ')}
                      </span>
                    </td>
                    {dayCols.map((c) => {
                      const runs = s.byDay.get(c.key);
                      const tone = dayRollup(runs);
                      const bytes = (runs || []).reduce((t, r) => t + (r.logicalBytes || 0), 0);
                      return (
                        <td key={c.key} style={{ padding: '8px 4px', textAlign: 'center', borderBottom: '1px solid rgba(31,43,55,.5)' }}>
                          {tone ? (
                            <button
                              onClick={() => setModal({ server: s, date: c.key, runs })}
                              title={`${runs.length} run${runs.length === 1 ? '' : 's'} · ${fmtBytes(bytes)} logical`}
                              aria-label={`Backups on ${c.key}`}
                              style={{ display: 'inline-block', height: 14, width: 14, borderRadius: '50%', background: BUBBLE_COLOR[tone], border: 'none', cursor: 'pointer', animation: tone === 'info' ? 'co-orb-pulse 2.5s ease-in-out infinite' : 'none' }}
                            />
                          ) : (
                            <span style={{ color: 'var(--co-ink-faint)', opacity: 0.4, userSelect: 'none' }}>·</span>
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

      {modal && (
        <Modal
          title={`${modal.server.name} — ${new Date(modal.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}`}
          subtitle={`${(modal.server.clusters || []).join(', ')} · ${modal.server.environment || '—'}${modal.server.osType ? ` · ${modal.server.osType}` : ''} · ${modal.runs.length} run${modal.runs.length === 1 ? '' : 's'}`}
          onClose={() => setModal(null)}
          maxWidth="min(720px,92vw)"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {modal.runs.map((r) => (
              <div key={r.id} style={{ background: 'var(--co-surface-overlay)', borderRadius: 8, padding: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                  <Badge tone={STATUS_TONE[r.status] || 'neutral'}>{statusLabel(r.status)}</Badge>
                  <span className="truncate" style={{ fontSize: 13, color: 'var(--co-ink)', fontWeight: 500 }}>{r.group}</span>
                  {r.runType && <span style={{ fontSize: 11, color: 'var(--co-ink-faint)' }}>{String(r.runType).replace(/^k/, '')}</span>}
                  {r.clusterName && <span style={{ fontSize: 11, color: 'var(--co-ink-faint)', marginLeft: 'auto' }}>{r.clusterName}</span>}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 24, rowGap: 4, fontSize: 12 }}>
                  <div style={{ whiteSpace: 'nowrap' }}><span style={{ color: 'var(--co-ink-faint)' }}>Start</span> <span className="tnum" style={{ color: 'var(--co-ink)' }}>{fmtTime(r.startMs)}</span></div>
                  <div style={{ whiteSpace: 'nowrap' }}><span style={{ color: 'var(--co-ink-faint)' }}>Duration</span> <span className="tnum" style={{ color: 'var(--co-ink)' }}>{fmtDuration(r.startMs, r.endMs)}</span></div>
                  <div style={{ whiteSpace: 'nowrap' }}><span style={{ color: 'var(--co-ink-faint)' }}>Logical</span> <span className="tnum" style={{ color: 'var(--co-ink)' }}>{fmtBytes(r.logicalBytes)}</span></div>
                  <div style={{ whiteSpace: 'nowrap' }}><span style={{ color: 'var(--co-ink-faint)' }}>Policy</span> <span style={{ color: 'var(--co-ink)' }}>{(modal.server.policies || [])[0] || '—'}</span></div>
                </div>
                {r.errorMessage && (
                  <p className="break-words" style={{ fontSize: 12, color: 'var(--co-crit)', marginTop: 8 }}>{r.errorCode ? `${r.errorCode}: ` : ''}{r.errorMessage}</p>
                )}
                {!details[r.id] ? (
                  <button onClick={() => loadDetail(r.id, modal.server.name)} style={{ marginTop: 8, fontSize: 11, fontWeight: 600, color: 'var(--co-brand)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}>
                    Details from cluster…
                  </button>
                ) : details[r.id].loading ? (
                  <p style={{ fontSize: 11, color: 'var(--co-ink-faint)', marginTop: 8 }}>Fetching run detail from {r.clusterName || 'cluster'}…</p>
                ) : (() => {
                  const d = details[r.id].data || {};
                  if (d.failed) return <p style={{ fontSize: 11, color: 'var(--co-warn)', marginTop: 8 }}>Could not fetch live detail (cluster unreachable?).</p>;
                  if (d.demo) return <p style={{ fontSize: 11, color: 'var(--co-ink-faint)', marginTop: 8 }}>Live run detail is unavailable in demo mode.</p>;
                  if (d.notFound) return <p style={{ fontSize: 11, color: 'var(--co-ink-faint)', marginTop: 8 }}>Run no longer available on the cluster (aged out).</p>;
                  return (
                    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(31,43,55,.5)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {d.thisServer && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, flexWrap: 'wrap' }}>
                          <span style={{ color: 'var(--co-ink-faint)' }}>This server:</span>
                          <Badge tone={STATUS_TONE[d.thisServer.status] || 'neutral'}>{statusLabel(d.thisServer.status) || '—'}</Badge>
                          {d.thisServer.bytesRead != null && <span className="tnum" style={{ color: 'var(--co-ink-faint)' }}>{fmtBytes(d.thisServer.bytesRead)} read</span>}
                          {d.thisServer.numRestarts > 0 && <span className="tnum" style={{ color: 'var(--co-warn)' }}>{d.thisServer.numRestarts} restart{d.thisServer.numRestarts === 1 ? '' : 's'}</span>}
                          {d.thisServer.error && <span className="break-words" style={{ color: 'var(--co-crit)' }}>{d.thisServer.error}</span>}
                        </div>
                      )}
                      {d.thisServer?.warnings?.length > 0 && d.thisServer.warnings.map((w, i) => (
                        <p key={i} className="break-words" style={{ fontSize: 11, color: 'var(--co-warn)' }}>{w}</p>
                      ))}
                      {d.objectSummary && (
                        <p className="tnum" style={{ fontSize: 11, color: 'var(--co-ink-faint)' }}>
                          Group: {Object.entries(d.objectSummary).map(([s, n]) => `${n} ${statusLabel(s) || s}`).join(' · ')} ({d.objectCount} object{d.objectCount === 1 ? '' : 's'})
                        </p>
                      )}
                      {d.error && <p className="break-words" style={{ fontSize: 11, color: 'var(--co-crit)' }}>{d.error}</p>}
                      {(d.warnings || []).map((w, i) => (
                        <p key={i} className="break-words" style={{ fontSize: 11, color: 'var(--co-ink-muted)' }}>⚠ {w}</p>
                      ))}
                    </div>
                  );
                })()}
                {r.replication && r.replication.length > 0 && (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(31,43,55,.5)' }}>
                    <p style={{ fontSize: 11, color: 'var(--co-ink-faint)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}><ArrowLeftRight size={11} /> Replication</p>
                    {r.replication.map((rep, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '2px 0' }}>
                        <Badge tone={STATUS_TONE[rep.status] || 'neutral'}>{statusLabel(rep.status) || '—'}</Badge>
                        <span style={{ color: 'var(--co-ink)' }}>{rep.targetCluster || '—'}</span>
                        <span className="tnum" style={{ color: 'var(--co-ink-faint)', marginLeft: 'auto' }}>{fmtBytes(rep.logicalBytes)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
