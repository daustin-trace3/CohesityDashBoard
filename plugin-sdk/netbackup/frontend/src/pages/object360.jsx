// NetBackup Object 360 — ports host frontend/src/pages/netbackup/NbObject360Page.jsx.
import { injectStyles, PageHeader, Panel, Badge, CrosshairIcon, SearchIcon, HardDriveIcon, ActivityIcon, ClipboardIcon, BellIcon, LoaderIcon } from '../ui.jsx';
import { fmtBytes, apiGet } from './helpers.js';

injectStyles();

const fmtAgo = (v) => {
  if (!v) return null;
  const ms = new Date(String(v).includes('T') ? v : `${v}Z`.replace(' ', 'T')).getTime();
  if (Number.isNaN(ms)) return null;
  const d = Math.floor((Date.now() - ms) / 86400000);
  return d < 1 ? 'today' : d === 1 ? '1d ago' : `${d}d ago`;
};
const toMs = (v) => {
  if (!v) return null;
  const ms = new Date(String(v).includes('T') ? v : `${v}Z`.replace(' ', 'T')).getTime();
  return Number.isNaN(ms) ? null : ms;
};
const fmtDate = (v) => { const ms = toMs(v); return ms == null ? '—' : new Date(ms).toLocaleDateString(); };
const fmtTime = (v) => { const ms = toMs(v); return ms == null ? '—' : new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
const fmtDurationS = (s) => { if (s == null) return '—'; if (s < 60) return `${s}s`; if (s < 3600) return `${Math.round(s / 60)}m`; return `${(s / 3600).toFixed(1)}h`; };
const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const isFailedRun = (r) => r.state === 'FAILED' || (['EXITED', 'DONE'].includes(r.state) && Number(r.statusCode || 0) > 0);
const runTone = (r) => (isFailedRun(r) ? 'crit' : ['EXITED', 'DONE'].includes(r.state) ? 'ok' : 'warn');
const runLabel = (r) => (isFailedRun(r) ? 'Failed' : ['EXITED', 'DONE'].includes(r.state) ? 'Success' : (r.state || '—'));
const TONE_RANK = { crit: 3, warn: 2, ok: 1 };
const DOT_COLOR = { crit: 'var(--nb-crit)', warn: 'var(--nb-warn)', ok: 'var(--nb-ok)' };

function Fact({ label, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      <p style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--nb-ink-faint)', margin: 0 }}>{label}</p>
      <div style={{ fontSize: 13, color: 'var(--nb-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{children ?? '—'}</div>
    </div>
  );
}

export default function NbObject360Page() {
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
    apiGet('/object-360', { name }).then((d) => setData(d)).catch(() => setData(null)).finally(() => setLoading(false));
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
      apiGet('/object-360/suggest', { q }).then((d) => { if (seqRef.current === id) setSuggestions(d.names || []); }).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input]);

  const pick = (name) => { setInput(name); setParams({ name }, { replace: true }); };
  const submit = () => {
    const name = suggestions[0] && input !== params.get('name') ? suggestions[0] : input.trim();
    if (name) setParams({ name }, { replace: true });
  };

  const c = data?.client;
  const nothingFound = data && data.found === false;

  const runsByDay = new Map();
  for (const r of data?.runs14d || []) {
    if (!r.startedAt) continue;
    const ms = toMs(r.startedAt);
    if (ms == null) continue;
    const k = dayKey(ms);
    const existing = runsByDay.get(k);
    if (!existing || TONE_RANK[runTone(r)] > TONE_RANK[runTone(existing)]) runsByDay.set(k, r);
  }
  const strip14 = [];
  {
    const now = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const k = dayKey(d.getTime());
      strip14.push({ key: k, run: runsByDay.get(k) });
    }
  }

  return (
    <div className="nb-root nb-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader icon={CrosshairIcon} title="Object 360" description="Everything NetBackup knows about one client — protection posture, backup runs, policies, and issues" />

      <div className="nb-panel" style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ position: 'relative', maxWidth: 480, flex: 1 }}>
            <SearchIcon size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--nb-ink-faint)', pointerEvents: 'none' }} />
            <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              placeholder="Client name…" className="nb-input" style={{ paddingLeft: 32, paddingRight: 32 }} />
            {loading && <LoaderIcon size={14} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--nb-ink-faint)', animation: 'nb-spin 0.8s linear infinite' }} />}
            {suggestions.length > 0 && (
              <div className="nb-panel" style={{ position: 'absolute', left: 0, right: 0, top: '100%', marginTop: 4, zIndex: 40, overflow: 'hidden' }}>
                {suggestions.map((n) => (
                  <button key={n} onClick={() => pick(n)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 12px', fontSize: 13, background: 'none', border: 'none', color: 'var(--nb-ink)', cursor: 'pointer' }}>{n}</button>
                ))}
              </div>
            )}
          </div>
          {input.trim() && (
            <ReactRouterDOM.Link to={`/ops/server360?name=${encodeURIComponent(input.trim())}`} style={{ fontSize: 11, color: 'var(--nb-brand)', flexShrink: 0, marginTop: 10, textDecoration: 'none' }}>
              Estate-wide Server 360 →
            </ReactRouterDOM.Link>
          )}
        </div>
        {c && <p className="nb-tnum" style={{ fontSize: 11, color: 'var(--nb-ink-faint)', marginTop: 8 }}>Pivoting on {c.clientName}</p>}
      </div>

      {!loading && nothingFound && (
        <div className="nb-panel" style={{ padding: 24, textAlign: 'center', fontSize: 13, color: 'var(--nb-ink-muted)' }}>
          No data for "{data.query}". Check the spelling, or the client may not be inventoried yet.
        </div>
      )}

      {!loading && c && (
        <>
          <Panel title="Client" icon={HardDriveIcon}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 12 }} className="nb-obj-grid">
              <style>{`@media (min-width: 700px) { .nb-obj-grid { grid-template-columns: repeat(4,1fr) !important; } } @media (min-width: 1100px) { .nb-obj-grid { grid-template-columns: repeat(6,1fr) !important; } }`}</style>
              <Fact label="Client">{c.clientName} <span style={{ color: 'var(--nb-ink-faint)', fontSize: 11 }}>({c.sourceName || '—'})</span></Fact>
              <Fact label="Policies">{(c.policies || []).join(', ') || '—'}</Fact>
              <Fact label="Jobs (7d)">{c.jobs7d}</Fact>
              <Fact label="Failures (7d)"><Badge tone={c.failed7d > 0 ? 'crit' : 'ok'}>{c.failed7d}</Badge></Fact>
              <Fact label="Last Success">
                {c.lastSuccessAt ? (
                  <span className="nb-tnum" style={{ fontSize: 11, color: Date.now() - toMs(c.lastSuccessAt) > 7 * 86400000 ? 'var(--nb-warn)' : 'var(--nb-ink-faint)' }}>{fmtDate(c.lastSuccessAt)} · {fmtAgo(c.lastSuccessAt)}</span>
                ) : '—'}
              </Fact>
              <Fact label="FETB">{fmtBytes(c.logicalBytes)}</Fact>
            </div>
          </Panel>

          <Panel title="Backup Runs" icon={ActivityIcon}>
            <div style={{ display: 'flex', gap: 3, marginBottom: 14 }}>
              {strip14.map((col) => (
                <span key={col.key} title={col.run ? `${col.key}: ${runLabel(col.run)}` : `${col.key}: no run`}
                  style={{ display: 'inline-block', height: 14, width: 14, borderRadius: '50%', background: col.run ? DOT_COLOR[runTone(col.run)] : 'var(--nb-surface-overlay)', opacity: col.run ? 1 : 0.5 }} />
              ))}
            </div>
            {(data.runs14d || []).length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--nb-ink-faint)' }}>No runs in the last 14 days.</p>
            ) : (
              <div className="nb-scroll" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                  <thead><tr style={{ textAlign: 'left', fontSize: 11, color: 'var(--nb-ink-muted)', borderBottom: '1px solid var(--nb-border)' }}>
                    <th style={{ padding: '6px 12px 6px 0' }}>Status</th><th style={{ padding: '6px 12px 6px 0' }}>Policy</th><th style={{ padding: '6px 12px 6px 0' }}>Type</th>
                    <th style={{ padding: '6px 12px 6px 0' }}>Started</th><th style={{ padding: '6px 12px 6px 0' }}>Elapsed</th><th style={{ padding: '6px 12px 6px 0' }}>Size</th><th style={{ padding: '6px 0' }}>Status Code</th>
                  </tr></thead>
                  <tbody>
                    {(data.runs14d || []).slice(0, 20).map((r) => (
                      <tr key={r.id} style={{ borderBottom: '1px solid var(--nb-border)' }}>
                        <td style={{ padding: '6px 12px 6px 0' }}><Badge tone={runTone(r)}>{runLabel(r)}</Badge></td>
                        <td style={{ padding: '6px 12px 6px 0', color: 'var(--nb-ink-muted)' }}>{r.policyName || '—'}</td>
                        <td style={{ padding: '6px 12px 6px 0', color: 'var(--nb-ink-muted)' }}>{r.jobType || '—'}</td>
                        <td className="nb-tnum" style={{ padding: '6px 12px 6px 0', color: 'var(--nb-ink)' }}>{fmtTime(r.startedAt)}</td>
                        <td className="nb-tnum" style={{ padding: '6px 12px 6px 0', color: 'var(--nb-ink)' }}>{fmtDurationS(r.elapsedSeconds)}</td>
                        <td className="nb-tnum" style={{ padding: '6px 12px 6px 0', color: 'var(--nb-ink)' }}>{fmtBytes(r.kilobytes != null ? r.kilobytes * 1024 : null)}</td>
                        <td className="nb-tnum" style={{ padding: '6px 0', color: r.statusCode > 0 ? 'var(--nb-crit)' : 'var(--nb-ink-faint)' }}>{r.statusCode > 0 ? r.statusCode : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {(data.replication || []).length > 0 && (
            <Panel title="Replication" icon={ClipboardIcon}>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead><tr style={{ fontSize: 10, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>
                  <th style={{ textAlign: 'left', paddingBottom: 8, borderBottom: '1px solid var(--nb-border)' }}>SLP / Policy</th>
                  <th style={{ textAlign: 'left', paddingBottom: 8, borderBottom: '1px solid var(--nb-border)' }}>Type</th>
                  <th style={{ textAlign: 'left', paddingBottom: 8, borderBottom: '1px solid var(--nb-border)' }}>Status</th>
                  <th style={{ textAlign: 'right', paddingBottom: 8, borderBottom: '1px solid var(--nb-border)' }}>Start</th>
                  <th style={{ textAlign: 'left', paddingLeft: 12, paddingBottom: 8, borderBottom: '1px solid var(--nb-border)' }}>Storage Unit</th>
                  <th style={{ textAlign: 'right', paddingBottom: 8, borderBottom: '1px solid var(--nb-border)' }}>Size</th>
                </tr></thead>
                <tbody>
                  {data.replication.map((r, i) => {
                    const failed = r.state === 'FAILED' || (['EXITED', 'DONE'].includes(r.state) && Number(r.statusCode || 0) > 0);
                    const done = !failed && ['EXITED', 'DONE'].includes(r.state);
                    return (
                      <tr key={i} style={{ borderBottom: '1px solid var(--nb-border)' }}>
                        <td style={{ padding: '8px 8px 8px 0', color: 'var(--nb-ink)', fontWeight: 500 }}>{r.slpOrPolicy || '—'}</td>
                        <td style={{ padding: '8px 8px 8px 0', color: 'var(--nb-ink-muted)' }}>{r.jobType || '—'}</td>
                        <td style={{ padding: '8px 8px 8px 0' }}><Badge tone={failed ? 'crit' : done ? 'ok' : 'info'}>{failed ? 'failed' : done ? 'success' : (r.state || '—')}</Badge></td>
                        <td className="nb-tnum" style={{ padding: '8px 8px 8px 0', textAlign: 'right', color: 'var(--nb-ink-faint)' }}>{fmtDate(r.startedAt)}</td>
                        <td style={{ padding: '8px 8px 8px 12px', color: 'var(--nb-ink-muted)' }}>{r.storageUnit || '—'}</td>
                        <td className="nb-tnum" style={{ padding: '8px 0', textAlign: 'right', color: 'var(--nb-ink-faint)' }}>{r.kilobytes != null ? fmtBytes(r.kilobytes * 1024) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Panel>
          )}

          {(data.policies || []).length > 0 && (
            <Panel title="Policies" icon={ClipboardIcon}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {data.policies.map((p, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 12, borderBottom: i < data.policies.length - 1 ? '1px solid var(--nb-border)' : 'none', paddingBottom: 8 }} className="nb-pol-grid">
                    <style>{`@media (min-width: 700px) { .nb-pol-grid { grid-template-columns: repeat(5,1fr) !important; } }`}</style>
                    <Fact label="Policy">{p.policyName}</Fact>
                    <Fact label="Jobs (30d)">{p.jobCount30d}</Fact>
                    <Fact label="Failures (30d)"><Badge tone={p.failed30d > 0 ? 'crit' : 'ok'}>{p.failed30d}</Badge></Fact>
                    <Fact label="Last Run">{fmtDate(p.lastRunAt)} · {fmtAgo(p.lastRunAt) || '—'}</Fact>
                    <Fact label="Last Status"><Badge tone={p.lastStatus === 'failed' ? 'crit' : p.lastStatus === 'success' ? 'ok' : 'neutral'}>{p.lastStatus || '—'}</Badge></Fact>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {(data.issues || []).length > 0 && (
            <Panel title="Issues" icon={BellIcon}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {data.issues.map((iss, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, flexWrap: 'wrap' }}>
                    <Badge tone={iss.severity === 'critical' ? 'crit' : iss.severity === 'warning' ? 'warn' : 'info'}>{iss.severity || '—'}</Badge>
                    <span style={{ color: 'var(--nb-ink)' }}>{iss.type || '—'}</span>
                    <span style={{ color: 'var(--nb-ink-muted)', flex: 1, minWidth: 120 }}>{iss.message || '—'}</span>
                    <span className="nb-tnum" style={{ color: 'var(--nb-ink-faint)' }}>{fmtAgo(iss.createdAt) || '—'}</span>
                  </div>
                ))}
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
