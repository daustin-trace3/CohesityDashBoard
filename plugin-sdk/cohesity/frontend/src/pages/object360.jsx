// Cohesity plugin — Object 360 page. Ported from frontend/src/pages/CohesityObject360Page.jsx.
// Server 360-pattern detail page: search/autocomplete an object name, pivot
// the whole page on it via ?name= in the URL.
import { apiFetch, PageHeader, Panel, Badge, LoadingPanel, Fact } from '../ui.jsx';
import { ShieldCheck, ArrowLeftRight, Bell, Loader2 } from '../icons.jsx';

// Not in the shared icon kit — added locally (same 24x24 stroke style as icons.jsx).
function Crosshair(p) {
  const size = p.size || 16;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={p.style} className={p.className}>
      <circle cx="12" cy="12" r="10" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
    </svg>
  );
}
function SearchIcon(p) {
  const size = p.size || 16;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={p.style} className={p.className}>
      <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
    </svg>
  );
}
function Activity(p) {
  const size = p.size || 16;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={p.style} className={p.className}>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}
function Users(p) {
  const size = p.size || 16;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={p.style} className={p.className}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

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
const fmtAgo = (ms) => {
  if (!ms) return null;
  const d = Math.floor((Date.now() - ms) / 86400000);
  return d < 1 ? 'today' : d === 1 ? '1d ago' : `${d}d ago`;
};

const STATUS_TONE = { kSuccess: 'ok', kWarning: 'warn', kFailure: 'crit', kCanceled: 'neutral', kRunning: 'info', kAccepted: 'info' };
const STATUS_LABEL = { kSuccess: 'Success', kWarning: 'Warning', kFailure: 'Failed', kCanceled: 'Canceled', kRunning: 'Running', kAccepted: 'Queued' };
const statusLabel = (s) => (s ? (STATUS_LABEL[s] || String(s).replace(/^k/, '')) : null);

const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Cohesity-scoped "everything the estate knows about one protected object" view. */
export default function CohesityObject360Page() {
  const { useSearchParams, Link } = window.ReactRouterDOM;
  const [params, setParams] = useSearchParams();
  const [input, setInput] = React.useState(params.get('name') || '');
  const [suggestions, setSuggestions] = React.useState([]);
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const seqRef = React.useRef(0);

  const load = React.useCallback((name) => {
    if (!name) return;
    setLoading(true);
    setSuggestions([]);
    apiFetch(`/cohesity/object-360?name=${encodeURIComponent(name)}`)
      .then((d) => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    const name = params.get('name');
    if (name) { setInput(name); load(name); } else { setData(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get('name')]);

  React.useEffect(() => {
    const q = input.trim();
    if (q.length < 2 || q === params.get('name')) { setSuggestions([]); return undefined; }
    const id = ++seqRef.current;
    const t = setTimeout(() => {
      apiFetch(`/cohesity/object-360/suggest?q=${encodeURIComponent(q)}`)
        .then((d) => { if (seqRef.current === id) setSuggestions(d.names || []); })
        .catch(() => {});
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input]);

  const pick = (name) => {
    setInput(name);
    setParams({ name }, { replace: true });
  };
  const submit = () => {
    const name = suggestions[0] && input !== params.get('name') ? suggestions[0] : input.trim();
    if (name) setParams({ name }, { replace: true });
  };

  const nothingFound = data && data.found === false;

  const runsByDay = React.useMemo(() => {
    const m = new Map();
    for (const r of data?.runs14d || []) {
      if (!r.startMs) continue;
      m.set(dayKey(r.startMs), r);
    }
    return m;
  }, [data]);
  const strip14 = React.useMemo(() => {
    const cols = [];
    const now = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const k = dayKey(d.getTime());
      cols.push({ key: k, run: runsByDay.get(k) });
    }
    return cols;
  }, [runsByDay]);

  return (
    <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader icon={Crosshair} title="Object 360"
        description="Everything Cohesity knows about one object — protection, backup history, replication, agents, and alerts" />

      <div className="panel" style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ position: 'relative', maxWidth: 480, flex: 1 }}>
            <SearchIcon size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--co-ink-faint)', pointerEvents: 'none' }} />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              placeholder="Object name…"
              className="co-input"
              style={{ paddingLeft: 34 }}
            />
            {loading && <Loader2 size={14} className="animate-spin" style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--co-ink-faint)' }} />}
            {suggestions.length > 0 && (
              <div style={{ position: 'absolute', left: 0, right: 0, top: '100%', marginTop: 4, zIndex: 40, background: 'var(--co-gray)', border: '1px solid var(--co-border)', borderRadius: 8, boxShadow: '0 20px 25px -5px rgba(0,0,0,.4)', overflow: 'hidden' }}>
                {suggestions.map((n) => (
                  <button key={n} onClick={() => pick(n)}
                    style={{ width: '100%', textAlign: 'left', padding: '6px 12px', fontSize: 13, color: 'var(--co-ink)', background: 'transparent', border: 'none', cursor: 'pointer' }}>{n}</button>
                ))}
              </div>
            )}
          </div>
          {input.trim() && (
            <Link to={`/ops/server360?name=${encodeURIComponent(input.trim())}`}
              style={{ fontSize: 11, color: 'var(--co-brand)', flexShrink: 0, marginTop: 8, textDecoration: 'none' }}>
              Estate-wide Server 360 →
            </Link>
          )}
        </div>
        {data?.query && (
          <p className="tnum" style={{ fontSize: 11, color: 'var(--co-ink-faint)', marginTop: 8 }}>Pivoting on {data.query}</p>
        )}
      </div>

      {loading && <LoadingPanel label="Loading object 360…" />}

      {!loading && nothingFound && (
        <div className="panel" style={{ padding: 24, fontSize: 13, color: 'var(--co-ink-muted)', textAlign: 'center' }}>
          No data for "{data.query}". Check the spelling, or the object may not be inventoried yet.
        </div>
      )}

      {!loading && data?.found && (
        <>
          <Panel title="Protection" icon={ShieldCheck}>
            {data.objects.map((o, i) => (
              <div key={i} className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6" style={{ gap: 12, marginBottom: 8, borderBottom: i === data.objects.length - 1 ? 'none' : '1px solid rgba(31,43,55,.4)', paddingBottom: 8 }}>
                <Fact label="Object" value={<>{o.name} <span style={{ color: 'var(--co-ink-faint)', fontSize: 11 }}>({o.environment || '—'})</span></>} />
                <Fact label="Protected" value={<Badge tone={o.isProtected ? 'ok' : 'warn'}>{o.isProtected ? 'protected' : 'unprotected'}</Badge>} />
                <Fact label="Cluster" value={o.clusterName} />
                <Fact label="Protection Group(s)" value={(o.protectionGroups || []).join(', ') || '—'} />
                <Fact label="Policy" value={(o.policyNames || []).join(', ') || '—'} />
                <Fact label="Last Backup" value={
                  <>
                    {o.lastBackupStatus ? <Badge tone={STATUS_TONE[o.lastBackupStatus] || 'neutral'}>{statusLabel(o.lastBackupStatus)}</Badge> : '—'}
                    {o.lastBackupMs ? (
                      <span className="tnum" style={{ marginLeft: 6, fontSize: 11, color: Date.now() - o.lastBackupMs > 7 * 86400000 ? 'var(--co-warn)' : 'var(--co-ink-faint)' }}>
                        {new Date(o.lastBackupMs).toLocaleDateString()} · {fmtAgo(o.lastBackupMs)}
                      </span>
                    ) : null}
                  </>
                } />
                <Fact label="Logical" value={fmtBytes(o.logicalBytes)} />
                {o.slaViolated ? <Fact label="SLA" value={<Badge tone="crit">SLA violated</Badge>} /> : null}
              </div>
            ))}
          </Panel>

          <Panel title="Backup Runs" icon={Activity}>
            <div style={{ display: 'flex', gap: 3, marginBottom: 14 }}>
              {strip14.map((c) => {
                const tone = c.run ? (STATUS_TONE[c.run.status] || 'neutral') : null;
                const color = tone === 'ok' ? 'var(--co-ok)' : tone === 'warn' ? 'var(--co-warn)' : tone === 'crit' ? 'var(--co-crit)' : tone === 'info' ? 'var(--co-info)' : 'rgba(95,112,129,.3)';
                return (
                  <span key={c.key} title={c.run ? `${c.key}: ${statusLabel(c.run.status)}` : `${c.key}: no run`}
                    style={{ display: 'inline-block', height: 14, width: 14, borderRadius: '50%', background: color, animation: tone === 'info' ? 'co-orb-pulse 2.5s ease-in-out infinite' : 'none' }} />
                );
              })}
            </div>
            {(data.runs14d || []).length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--co-ink-faint)' }}>No runs in the last 14 days.</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--co-border)', fontSize: 11, color: 'var(--co-ink-muted)', textAlign: 'left' }}>
                      <th style={{ padding: '6px 12px 6px 0' }}>Status</th>
                      <th style={{ padding: '6px 12px 6px 0' }}>Group</th>
                      <th style={{ padding: '6px 12px 6px 0' }}>Type</th>
                      <th style={{ padding: '6px 12px 6px 0' }}>Start</th>
                      <th style={{ padding: '6px 12px 6px 0' }}>Duration</th>
                      <th style={{ padding: '6px 12px 6px 0' }}>Logical</th>
                      <th style={{ padding: '6px 0' }}>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.runs14d].sort((a, b) => (b.startMs || 0) - (a.startMs || 0)).slice(0, 20).map((r) => (
                      <tr key={r.id} style={{ borderBottom: '1px solid rgba(31,43,55,.5)' }}>
                        <td style={{ padding: '6px 12px 6px 0' }}><Badge tone={STATUS_TONE[r.status] || 'neutral'}>{statusLabel(r.status) || '—'}</Badge></td>
                        <td className="truncate" style={{ padding: '6px 12px 6px 0', color: 'var(--co-ink-muted)', maxWidth: 160 }}>{r.group}</td>
                        <td style={{ padding: '6px 12px 6px 0', color: 'var(--co-ink-faint)' }}>{r.runType ? String(r.runType).replace(/^k/, '') : '—'}</td>
                        <td className="tnum" style={{ padding: '6px 12px 6px 0', color: 'var(--co-ink)' }}>{fmtTime(r.startMs)}</td>
                        <td className="tnum" style={{ padding: '6px 12px 6px 0', color: 'var(--co-ink)' }}>{fmtDuration(r.startMs, r.endMs)}</td>
                        <td className="tnum" style={{ padding: '6px 12px 6px 0', color: 'var(--co-ink)' }}>{fmtBytes(r.logicalBytes)}</td>
                        <td className="truncate" style={{ padding: '6px 0', color: 'var(--co-crit)', maxWidth: 240 }} title={r.errorMessage || ''}>{r.errorMessage || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {(data.replication || []).length > 0 && (
            <Panel title="Replication" icon={ArrowLeftRight}>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--co-ink-faint)' }}>
                    <th style={{ textAlign: 'left', fontWeight: 600, paddingBottom: 8, borderBottom: '1px solid rgba(31,43,55,.6)' }}>Job</th>
                    <th style={{ textAlign: 'left', fontWeight: 600, paddingBottom: 8, borderBottom: '1px solid rgba(31,43,55,.6)' }}>Target Cluster</th>
                    <th style={{ textAlign: 'left', fontWeight: 600, paddingBottom: 8, borderBottom: '1px solid rgba(31,43,55,.6)' }}>Status</th>
                    <th style={{ textAlign: 'right', fontWeight: 600, paddingBottom: 8, borderBottom: '1px solid rgba(31,43,55,.6)' }}>Start</th>
                    <th style={{ textAlign: 'right', fontWeight: 600, paddingBottom: 8, borderBottom: '1px solid rgba(31,43,55,.6)' }}>Logical</th>
                    <th style={{ textAlign: 'right', fontWeight: 600, paddingBottom: 8, borderBottom: '1px solid rgba(31,43,55,.6)' }}>Lag</th>
                  </tr>
                </thead>
                <tbody>
                  {data.replication.map((leg, i) => (
                    <tr key={i} style={{ borderBottom: i === data.replication.length - 1 ? 'none' : '1px solid rgba(31,43,55,.4)' }}>
                      <td style={{ padding: '8px 8px 8px 0', color: 'var(--co-ink-muted)' }}>{leg.group || '—'}</td>
                      <td style={{ padding: '8px 8px 8px 0', color: 'var(--co-ink)', fontWeight: 500 }}>{leg.targetCluster || '—'}</td>
                      <td style={{ padding: '8px 8px 8px 0' }}><Badge tone={STATUS_TONE[leg.status] || 'neutral'}>{statusLabel(leg.status) || leg.status || '—'}</Badge></td>
                      <td className="tnum" style={{ padding: '8px 8px 8px 0', textAlign: 'right', color: 'var(--co-ink-faint)' }}>{leg.startMs ? new Date(leg.startMs).toLocaleDateString() : '—'}</td>
                      <td className="tnum" style={{ padding: '8px 8px 8px 0', textAlign: 'right', color: 'var(--co-ink-faint)' }}>{fmtBytes(leg.logicalBytes)}</td>
                      <td className="tnum" style={{ padding: '8px 0', textAlign: 'right', color: 'var(--co-ink-faint)' }}>
                        {leg.lagSeconds != null ? (leg.lagSeconds < 60 ? `${leg.lagSeconds}s` : `${Math.round(leg.lagSeconds / 60)}m`) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}

          {(data.alerts || []).length > 0 && (
            <Panel title="Cluster Alerts" icon={Bell}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {data.alerts.map((a) => (
                  <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, flexWrap: 'wrap' }}>
                    <Badge tone={a.severity === 'critical' ? 'crit' : a.severity === 'warning' ? 'warn' : 'info'}>{a.severity || '—'}</Badge>
                    <span style={{ color: 'var(--co-ink)' }}>{a.alertType || '—'}</span>
                    <span className="truncate" style={{ color: 'var(--co-ink-muted)', flex: 1, minWidth: 120 }}>{a.message || '—'}</span>
                    <span className="tnum" style={{ color: 'var(--co-ink-faint)' }}>{fmtAgo(new Date(a.firstSeen).getTime()) || '—'}</span>
                    <span style={{ color: 'var(--co-ink-faint)' }}>{a.clusterName}</span>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {(data.agents || []).length > 0 && (
            <Panel title="Agents" icon={Users}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {data.agents.map((a, i) => (
                  <p key={i} className="tnum" style={{ fontSize: 11, color: 'var(--co-ink-faint)', margin: 0 }}>
                    {String(a.agentVersion || 'unknown').split('_release')[0]} · {a.agentStatus || '—'} · {a.upgradability === 'Upgradable' ? 'upgrade available' : a.upgradability || '—'} · {a.clusterName}
                  </p>
                ))}
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
