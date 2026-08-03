// Rubrik v2.1.0 Object 360 — NEW page cloning host frontend/src/pages/ops/
// ServerStatusPage.jsx UX (picker + debounced typeahead + stacked conditional
// panels, no tabs), scoped to Rubrik-only data per RUBRIK_V21_CONTRACT SCOUT
// REPORT A §2 "RUBRIK MAPPING". Route: rubrik/object-360?name=.
import {
  PageHeader, Panel, Badge, LoadingPanel, EmptyState,
  SearchIcon, ServerIcon, ShieldIcon, BellIcon, ActivityIcon, LoaderIcon,
} from '../ui';

function CrosshairIcon({ size = 18, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={style}>
      <circle cx="12" cy="12" r="10" /><path d="M22 12h-4M6 12H2M12 6V2M12 22v-4" /><circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function ArrowLeftRightIcon({ size = 14, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={style}>
      <path d="M17 3l4 4-4 4" /><path d="M21 7H9a4 4 0 0 0-4 4v1" />
      <path d="M7 21l-4-4 4-4" /><path d="M3 17h12a4 4 0 0 0 4-4v-1" />
    </svg>
  );
}
function RadarIcon({ size = 14, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={style}>
      <path d="M19.07 4.93A10 10 0 1 0 22 12" /><path d="M12 12 6.34 6.34" /><circle cx="12" cy="12" r="1" />
      <path d="M12 12V2" />
    </svg>
  );
}

function fmtBytes(b) {
  if (b == null) return '—';
  if (b >= 1e12) return `${(b / 1e12).toLocaleString(undefined, { maximumFractionDigits: 2 })} TB`;
  if (b >= 1e9) return `${(b / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  if (b >= 1e6) return `${(b / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
  return `${Number(b).toLocaleString()} B`;
}
function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const raw = typeof v === 'string' && !v.includes('T') ? `${v.replace(' ', 'T')}Z` : v;
  const ms = new Date(raw).getTime();
  return Number.isNaN(ms) ? null : ms;
}
function fmtAgo(v) {
  const ms = toMs(v);
  if (ms == null) return null;
  const d = Math.floor((Date.now() - ms) / 86400000);
  return d < 1 ? 'today' : d === 1 ? '1d ago' : `${d}d ago`;
}
function fmtDate(v) {
  const ms = toMs(v);
  return ms == null ? '—' : new Date(ms).toLocaleDateString();
}
function fmtTime(v) {
  const ms = toMs(v);
  return ms == null ? '—' : new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
function fmtDurationS(s) {
  if (s == null) return '—';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}
const STATUS_TONE = { Succeeded: 'ok', Warning: 'warn', Failed: 'crit', Canceled: 'neutral', Running: 'info' };
const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function Fact({ label, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      <p style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--rbk-ink-faint)', margin: 0 }}>{label}</p>
      <div style={{ fontSize: 14, color: 'var(--rbk-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{children ?? '—'}</div>
    </div>
  );
}

const factGrid = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 12 };
const factGridWide = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px,1fr))', gap: 12 };

/** Rubrik-scoped "everything the estate knows about one protected object" view. */
export default function Object360Page() {
  const [params, setParams] = ReactRouterDOM.useSearchParams();
  const [input, setInput] = React.useState(params.get('name') || '');
  const [suggestions, setSuggestions] = React.useState([]);
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const seqRef = React.useRef(0);

  const load = React.useCallback((name) => {
    if (!name) return;
    setLoading(true);
    setSuggestions([]);
    fetch(`/api/rubrik/object-360?name=${encodeURIComponent(name)}`, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((json) => setData(json))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  // React to ?name= changes from any source (link click, back/forward,
  // typeahead pick) instead of only reading it on mount — the host page has
  // exactly this gotcha (documented in the contract); this port avoids it.
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
      fetch(`/api/rubrik/object-360/suggest?q=${encodeURIComponent(q)}`, { credentials: 'include' })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
        .then((json) => { if (seqRef.current === id) setSuggestions(json.names || []); })
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

  const obj = data?.object;
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
    <div className="rbk-root rbk-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader icon={CrosshairIcon} title="Object 360"
        description="Everything Rubrik knows about one object — protection, backup history, alerts, replication, and threats" />

      <div className="rbk-panel" style={{ padding: 16 }}>
        <div style={{ position: 'relative', maxWidth: 480 }}>
          <SearchIcon size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--rbk-ink-faint)', pointerEvents: 'none' }} />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            placeholder="Object name or path…"
            className="rbk-input"
            style={{ paddingLeft: 32, paddingRight: loading ? 32 : undefined }}
          />
          {loading && <LoaderIcon size={14} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--rbk-ink-faint)', animation: 'rbk-spin 0.8s linear infinite' }} />}
          {suggestions.length > 0 && (
            <div className="rbk-panel rbk-scroll" style={{ position: 'absolute', left: 0, right: 0, top: '100%', marginTop: 4, zIndex: 40, overflow: 'hidden', maxHeight: 260 }}>
              {suggestions.map((n) => (
                <button key={n} onClick={() => pick(n)}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 12px', fontSize: 13, color: 'var(--rbk-ink)', background: 'none', border: 'none', cursor: 'pointer' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0,179,136,0.1)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
                >{n}</button>
              ))}
            </div>
          )}
        </div>
        {obj && (
          <p className="rbk-tnum" style={{ fontSize: 11, color: 'var(--rbk-ink-faint)', marginTop: 8 }}>
            Pivoting on {obj.name}
          </p>
        )}
      </div>

      {loading && <LoadingPanel label="Loading object 360…" />}

      {!loading && nothingFound && (
        <div className="rbk-panel" style={{ padding: 24 }}>
          <EmptyState icon={CrosshairIcon} title="Not found"
            description={`No data for "${data.query}". Check the spelling, or the object may not be inventoried yet.`} />
        </div>
      )}

      {!loading && obj && (
        <React.Fragment>
          {/* Protection */}
          <Panel title="Protection" icon={ShieldIcon}>
            <div style={factGridWide}>
              <Fact label="Object">{obj.name}</Fact>
              <Fact label="Type">{obj.type || '—'}</Fact>
              <Fact label="SLA Domain">{obj.slaDomain || '—'}</Fact>
              <Fact label="Cluster">{obj.cluster || obj.clusterName || '—'}</Fact>
              <Fact label="Compliance">
                <Badge tone={obj.compliant ? 'ok' : 'crit'}>{obj.compliant ? 'Compliant' : 'Out of Compliance'}</Badge>
              </Fact>
              <Fact label="Last Backup">
                {obj.lastBackupAt ? (
                  <React.Fragment>
                    <Badge tone={STATUS_TONE.Succeeded}>Succeeded</Badge>{' '}
                    <span className="rbk-tnum" style={{ fontSize: 11, color: (Date.now() - (toMs(obj.lastBackupAt) || 0)) > 7 * 86400000 ? 'var(--rbk-warn)' : 'var(--rbk-ink-faint)' }}>
                      {fmtDate(obj.lastBackupAt)} · {fmtAgo(obj.lastBackupAt)}
                    </span>
                  </React.Fragment>
                ) : '—'}
              </Fact>
              <Fact label="Snapshots">{obj.snapshotCount ?? '—'}</Fact>
              <Fact label="Local">{fmtBytes(obj.localStorageBytes)}</Fact>
              <Fact label="Archived">{fmtBytes(obj.archivedBytes)}</Fact>
              <Fact label="Location">{obj.location || '—'}</Fact>
              <Fact label="Next Snapshot">{obj.nextSnapshotAt ? fmtDate(obj.nextSnapshotAt) : '—'}</Fact>
            </div>
          </Panel>

          {/* Backup Runs */}
          <Panel title="Backup Runs" icon={ActivityIcon}>
            <div style={{ display: 'flex', gap: 3, marginBottom: 14 }}>
              {strip14.map((c) => {
                const tone = c.run ? (STATUS_TONE[c.run.status] || 'neutral') : null;
                return (
                  <span
                    key={c.key}
                    title={c.run ? `${c.key}: ${c.run.status}` : `${c.key}: no run`}
                    style={{
                      width: 14, height: 14, borderRadius: '50%',
                      background: tone ? `var(--rbk-${tone === 'neutral' ? 'ink-faint' : tone})` : 'var(--rbk-surface-overlay)',
                      opacity: tone ? 1 : 0.5,
                    }}
                  />
                );
              })}
            </div>
            {(data.runs14d || []).length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--rbk-ink-faint)' }}>No runs in the last 14 days.</p>
            ) : (
              <div className="rbk-scroll" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--rbk-border)' }}>
                      <th style={{ padding: '6px 10px 6px 0', textAlign: 'left', fontSize: 11, color: 'var(--rbk-ink-muted)' }}>Status</th>
                      <th style={{ padding: '6px 10px 6px 0', textAlign: 'left', fontSize: 11, color: 'var(--rbk-ink-muted)' }}>Type</th>
                      <th style={{ padding: '6px 10px 6px 0', textAlign: 'left', fontSize: 11, color: 'var(--rbk-ink-muted)' }}>Day</th>
                      <th style={{ padding: '6px 10px 6px 0', textAlign: 'left', fontSize: 11, color: 'var(--rbk-ink-muted)' }}>Start</th>
                      <th style={{ padding: '6px 10px 6px 0', textAlign: 'left', fontSize: 11, color: 'var(--rbk-ink-muted)' }}>Duration</th>
                      <th style={{ padding: '6px 10px 6px 0', textAlign: 'left', fontSize: 11, color: 'var(--rbk-ink-muted)' }}>Logical</th>
                      <th style={{ padding: '6px 0', textAlign: 'left', fontSize: 11, color: 'var(--rbk-ink-muted)' }}>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...(data.runs14d || [])].sort((a, b) => (b.startMs || 0) - (a.startMs || 0)).slice(0, 20).map((r, i) => (
                      <tr key={i} className="rbk-row" style={{ borderBottom: '1px solid var(--rbk-border)' }}>
                        <td style={{ padding: '6px 10px 6px 0' }}><Badge tone={STATUS_TONE[r.status] || 'neutral'}>{r.status || '—'}</Badge></td>
                        <td style={{ padding: '6px 10px 6px 0', color: 'var(--rbk-ink-muted)' }}>{r.runType || '—'}</td>
                        <td className="rbk-tnum" style={{ padding: '6px 10px 6px 0', color: 'var(--rbk-ink-faint)' }}>{r.day || dayKey(r.startMs)}</td>
                        <td className="rbk-tnum" style={{ padding: '6px 10px 6px 0', color: 'var(--rbk-ink)' }}>{fmtTime(r.startMs)}</td>
                        <td className="rbk-tnum" style={{ padding: '6px 10px 6px 0', color: 'var(--rbk-ink)' }}>{fmtDurationS(r.durationS)}</td>
                        <td className="rbk-tnum" style={{ padding: '6px 10px 6px 0', color: 'var(--rbk-ink)' }}>{fmtBytes(r.logicalBytes)}</td>
                        <td style={{ padding: '6px 0', color: 'var(--rbk-crit)', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.errorMessage || ''}>{r.errorMessage || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {/* Alerts */}
          {(data.alerts || []).length > 0 && (
            <Panel title="Alerts" icon={BellIcon}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {data.alerts.map((a, i) => (
                  <div key={a.id ?? i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, flexWrap: 'wrap' }}>
                    <Badge tone={a.severity === 'critical' ? 'crit' : a.severity === 'warning' ? 'warn' : 'info'}>{a.severity || '—'}</Badge>
                    <span style={{ color: 'var(--rbk-ink)' }}>{a.alertType || a.type || '—'}</span>
                    <span style={{ color: 'var(--rbk-ink-muted)', flex: 1, minWidth: 120 }}>{a.description || '—'}</span>
                    <span className="rbk-tnum" style={{ color: 'var(--rbk-ink-faint)' }}>{fmtAgo(a.firstSeen) || '—'}</span>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {/* Replication */}
          {(data.replication?.legs || []).length > 0 && (
            <Panel title="Replication" icon={ArrowLeftRightIcon}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {data.replication.legs.map((leg, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, flexWrap: 'wrap' }}>
                    <span style={{ color: 'var(--rbk-ink)', fontWeight: 500 }}>{leg.targetCluster || '—'}</span>
                    <Badge tone={STATUS_TONE[leg.status] || 'neutral'}>{leg.status || '—'}</Badge>
                    <span className="rbk-tnum" style={{ color: 'var(--rbk-ink-faint)', marginLeft: 'auto' }}>
                      {leg.lagSeconds != null ? `${leg.lagSeconds < 60 ? `${leg.lagSeconds}s` : `${Math.round(leg.lagSeconds / 60)}m`} lag` : '—'}
                    </span>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {/* Threats — anomalies + object events; Rubrik has richer security data than the host, keep it. */}
          {((data.anomalies || []).length > 0 || (data.events || []).length > 0) && (
            <Panel title="Threats" icon={RadarIcon}>
              {(data.anomalies || []).length > 0 && (
                <div style={{ marginBottom: (data.events || []).length > 0 ? 12 : 0 }}>
                  <p className="rbk-panel-title" style={{ marginBottom: 8 }}>Anomalies</p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {data.anomalies.map((an, i) => (
                      <div key={an.id ?? i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, flexWrap: 'wrap' }}>
                        <Badge tone={an.status === 'open' || an.status === 'Open' ? 'crit' : 'neutral'}>{an.status || '—'}</Badge>
                        <span style={{ color: 'var(--rbk-ink)' }}>{an.encryptionDetected ? 'Radar anomaly — encryption detected' : 'Radar anomaly'}</span>
                        {an.anomalyProbability != null && <span className="rbk-tnum" style={{ color: 'var(--rbk-crit)' }}>p={Number(an.anomalyProbability).toFixed(2)}</span>}
                        {an.snapshotQuarantined ? <Badge tone="warn">quarantined</Badge> : null}
                        <span className="rbk-tnum" style={{ color: 'var(--rbk-ink-faint)', marginLeft: 'auto' }}>{fmtAgo(an.detectedAt) || '—'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {(data.events || []).length > 0 && (
                <div>
                  <p className="rbk-panel-title" style={{ marginBottom: 8 }}>Recent Events</p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {data.events.slice(0, 20).map((ev, i) => (
                      <div key={ev.id ?? i} style={{ fontSize: 12, color: 'var(--rbk-ink-muted)', display: 'flex', gap: 8 }}>
                        <span className="rbk-tnum" style={{ color: 'var(--rbk-ink-faint)', flexShrink: 0 }}>{fmtAgo(ev.at) || '—'}</span>
                        <span>{ev.eventType || '—'}</span>
                        <span style={{ color: 'var(--rbk-ink-faint)' }}>{ev.message || ''}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Panel>
          )}
        </React.Fragment>
      )}
    </div>
  );
}
