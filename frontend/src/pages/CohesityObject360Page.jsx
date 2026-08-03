import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Crosshair, Search, ShieldCheck, Activity, ArrowLeftRight, Bell, Users, Loader2 } from 'lucide-react';
import client from '../api/client';
import { PageHeader, Panel, Badge, LoadingPanel } from '../components/ui/primitives';

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

function dayRollup(runs) {
  if (!runs || runs.length === 0) return null;
  if (runs.some((r) => r.status === 'kFailure')) return 'crit';
  if (runs.some((r) => r.status === 'kWarning' || r.status === 'kCanceled')) return 'warn';
  if (runs.some((r) => r.status === 'kSuccess')) return 'ok';
  return 'info';
}

function Fact({ label, children }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
      <div className="text-sm text-ink truncate">{children ?? '—'}</div>
    </div>
  );
}

/** Cohesity-scoped "everything the estate knows about one protected object" view. */
export default function CohesityObject360Page() {
  const [params, setParams] = useSearchParams();
  const [input, setInput] = useState(params.get('name') || '');
  const [suggestions, setSuggestions] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const seqRef = useRef(0);

  const load = useCallback((name) => {
    if (!name) return;
    setLoading(true);
    setSuggestions([]);
    client.get('/cohesity/object-360', { params: { name } })
      .then(({ data }) => setData(data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const name = params.get('name');
    if (name) { setInput(name); load(name); } else { setData(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get('name')]);

  useEffect(() => {
    const q = input.trim();
    if (q.length < 2 || q === params.get('name')) { setSuggestions([]); return undefined; }
    const id = ++seqRef.current;
    const t = setTimeout(() => {
      client.get('/cohesity/object-360/suggest', { params: { q } })
        .then(({ data }) => { if (seqRef.current === id) setSuggestions(data.names || []); })
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

  const runsByDay = useMemo(() => {
    const m = new Map();
    for (const r of data?.runs14d || []) {
      if (!r.startMs) continue;
      m.set(dayKey(r.startMs), r);
    }
    return m;
  }, [data]);
  const strip14 = useMemo(() => {
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
    <div className="animate-fade-in flex flex-col gap-4">
      <PageHeader icon={Crosshair} title="Object 360"
        description="Everything Cohesity knows about one object — protection, backup history, replication, agents, and alerts" />

      <div className="panel p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="relative max-w-lg flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              placeholder="Object name…"
              className="w-full bg-surface border border-cohesity-border text-sm text-ink rounded-lg pl-9 pr-3 py-2 placeholder-ink-faint focus:border-brand/60 transition-colors"
            />
            {loading && <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint animate-spin" />}
            {suggestions.length > 0 && (
              <div className="absolute left-0 right-0 top-full mt-1 z-40 bg-cohesity-gray border border-cohesity-border rounded-lg shadow-xl overflow-hidden">
                {suggestions.map((n) => (
                  <button key={n} onClick={() => pick(n)}
                    className="w-full text-left px-3 py-1.5 text-sm text-ink hover:bg-brand/10 transition-colors cursor-pointer">{n}</button>
                ))}
              </div>
            )}
          </div>
          {input.trim() && (
            <Link to={`/ops/server360?name=${encodeURIComponent(input.trim())}`}
              className="text-[11px] text-brand hover:text-brand-bright flex-shrink-0 mt-2">
              Estate-wide Server 360 →
            </Link>
          )}
        </div>
        {data?.query && (
          <p className="text-[11px] text-ink-faint mt-2 tnum">Pivoting on {data.query}</p>
        )}
      </div>

      {loading && <LoadingPanel label="Loading object 360…" />}

      {!loading && nothingFound && (
        <div className="panel p-6 text-sm text-ink-muted text-center">
          No data for “{data.query}”. Check the spelling, or the object may not be inventoried yet.
        </div>
      )}

      {!loading && data?.found && (
        <>
          <Panel title="Protection" icon={ShieldCheck}>
            {data.objects.map((o, i) => (
              <div key={i} className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3 mb-2 border-b border-cohesity-border/40 last:border-0 pb-2 last:pb-0">
                <Fact label="Object">{o.name} <span className="text-ink-faint text-[11px]">({o.environment || '—'})</span></Fact>
                <Fact label="Protected"><Badge tone={o.isProtected ? 'ok' : 'warn'}>{o.isProtected ? 'protected' : 'unprotected'}</Badge></Fact>
                <Fact label="Cluster">{o.clusterName}</Fact>
                <Fact label="Protection Group(s)">{(o.protectionGroups || []).join(', ') || '—'}</Fact>
                <Fact label="Policy">{(o.policyNames || []).join(', ') || '—'}</Fact>
                <Fact label="Last Backup">
                  {o.lastBackupStatus ? <Badge tone={STATUS_TONE[o.lastBackupStatus] || 'neutral'}>{statusLabel(o.lastBackupStatus)}</Badge> : '—'}
                  {o.lastBackupMs ? (
                    <span className={`ml-1.5 text-[11px] tnum ${Date.now() - o.lastBackupMs > 7 * 86400000 ? 'text-amber-400' : 'text-ink-faint'}`}>
                      {new Date(o.lastBackupMs).toLocaleDateString()} · {fmtAgo(o.lastBackupMs)}
                    </span>
                  ) : null}
                </Fact>
                <Fact label="Logical">{fmtBytes(o.logicalBytes)}</Fact>
                {o.slaViolated ? <Fact label="SLA"><Badge tone="crit">SLA violated</Badge></Fact> : null}
              </div>
            ))}
          </Panel>

          <Panel title="Backup Runs" icon={Activity}>
            <div className="flex gap-[3px] mb-3.5">
              {strip14.map((c) => {
                const tone = c.run ? (STATUS_TONE[c.run.status] || 'neutral') : null;
                const dotClass = tone === 'ok' ? 'bg-status-ok' : tone === 'warn' ? 'bg-status-warn' : tone === 'crit' ? 'bg-status-crit' : tone === 'info' ? 'bg-status-info animate-pulse' : 'bg-ink-faint/30';
                return (
                  <span key={c.key} title={c.run ? `${c.key}: ${statusLabel(c.run.status)}` : `${c.key}: no run`}
                    className={`inline-block h-3.5 w-3.5 rounded-full ${dotClass}`} />
                );
              })}
            </div>
            {(data.runs14d || []).length === 0 ? (
              <p className="text-xs text-ink-faint">No runs in the last 14 days.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-cohesity-border text-[11px] text-ink-muted text-left">
                      <th className="py-1.5 pr-3">Status</th>
                      <th className="py-1.5 pr-3">Group</th>
                      <th className="py-1.5 pr-3">Type</th>
                      <th className="py-1.5 pr-3">Start</th>
                      <th className="py-1.5 pr-3">Duration</th>
                      <th className="py-1.5 pr-3">Logical</th>
                      <th className="py-1.5">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.runs14d].sort((a, b) => (b.startMs || 0) - (a.startMs || 0)).slice(0, 20).map((r) => (
                      <tr key={r.id} className="border-b border-cohesity-border/50">
                        <td className="py-1.5 pr-3"><Badge tone={STATUS_TONE[r.status] || 'neutral'}>{statusLabel(r.status) || '—'}</Badge></td>
                        <td className="py-1.5 pr-3 text-ink-muted truncate max-w-[160px]">{r.group}</td>
                        <td className="py-1.5 pr-3 text-ink-faint">{r.runType ? String(r.runType).replace(/^k/, '') : '—'}</td>
                        <td className="py-1.5 pr-3 tnum text-ink">{fmtTime(r.startMs)}</td>
                        <td className="py-1.5 pr-3 tnum text-ink">{fmtDuration(r.startMs, r.endMs)}</td>
                        <td className="py-1.5 pr-3 tnum text-ink">{fmtBytes(r.logicalBytes)}</td>
                        <td className="py-1.5 text-status-crit truncate max-w-[240px]" title={r.errorMessage || ''}>{r.errorMessage || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {(data.replication || []).length > 0 && (
            <Panel title="Replication" icon={ArrowLeftRight}>
              <div className="flex flex-col gap-2">
                {data.replication.map((leg, i) => (
                  <div key={i} className="flex items-center gap-2.5 text-xs flex-wrap">
                    <span className="text-ink font-medium">{leg.targetCluster || '—'}</span>
                    <Badge tone={STATUS_TONE[leg.status] || 'neutral'}>{statusLabel(leg.status) || leg.status || '—'}</Badge>
                    <span className="text-ink-faint tnum ml-auto">{fmtBytes(leg.logicalBytes)}</span>
                    {leg.lagSeconds != null && (
                      <span className="text-ink-faint tnum">{leg.lagSeconds < 60 ? `${leg.lagSeconds}s` : `${Math.round(leg.lagSeconds / 60)}m`} lag</span>
                    )}
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {(data.alerts || []).length > 0 && (
            <Panel title="Cluster Alerts" icon={Bell}>
              <div className="flex flex-col gap-2">
                {data.alerts.map((a) => (
                  <div key={a.id} className="flex items-center gap-2.5 text-xs flex-wrap">
                    <Badge tone={a.severity === 'critical' ? 'crit' : a.severity === 'warning' ? 'warn' : 'info'}>{a.severity || '—'}</Badge>
                    <span className="text-ink">{a.alertType || '—'}</span>
                    <span className="text-ink-muted flex-1 min-w-[120px] truncate">{a.message || '—'}</span>
                    <span className="text-ink-faint tnum">{fmtAgo(new Date(a.firstSeen).getTime()) || '—'}</span>
                    <span className="text-ink-faint">{a.clusterName}</span>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {(data.agents || []).length > 0 && (
            <Panel title="Agents" icon={Users}>
              <div className="flex flex-col gap-1">
                {data.agents.map((a, i) => (
                  <p key={i} className="text-[11px] text-ink-faint tnum">
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
