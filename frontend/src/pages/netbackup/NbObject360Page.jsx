import { useEffect, useRef, useState, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Crosshair, Search, HardDrive, Activity, ClipboardList, Bell, Loader2 } from 'lucide-react';
import client from '../../api/client';
import { PageHeader, Panel, Badge } from '../../components/ui/primitives';
import { fmtBytes } from './helpers';

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
const fmtDate = (v) => {
  const ms = toMs(v);
  return ms == null ? '—' : new Date(ms).toLocaleDateString();
};
const fmtTime = (v) => {
  const ms = toMs(v);
  return ms == null ? '—' : new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
};
const fmtDurationS = (s) => {
  if (s == null) return '—';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
};
const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const isFailedRun = (r) => r.state === 'FAILED' || (['EXITED', 'DONE'].includes(r.state) && Number(r.statusCode || 0) > 0);
const runTone = (r) => (isFailedRun(r) ? 'crit' : ['EXITED', 'DONE'].includes(r.state) ? 'ok' : 'warn');
const runLabel = (r) => (isFailedRun(r) ? 'Failed' : ['EXITED', 'DONE'].includes(r.state) ? 'Success' : (r.state || '—'));
const TONE_RANK = { crit: 3, warn: 2, ok: 1 };

function Fact({ label, children }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
      <div className="text-sm text-ink truncate">{children ?? '—'}</div>
    </div>
  );
}

/** NetBackup-scoped "everything we know about one client" view, same UX as Server 360 / Cohesity Object 360. */
export default function NbObject360Page() {
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
    client.get('/netbackup/object-360', { params: { name } })
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
      client.get('/netbackup/object-360/suggest', { params: { q } })
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
    <div className="animate-fade-in flex flex-col gap-4">
      <PageHeader icon={Crosshair} title="Object 360"
        description="Everything NetBackup knows about one client — protection posture, backup runs, policies, and issues" />

      <div className="panel p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="relative max-w-lg flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              placeholder="Client name…"
              className="w-full bg-surface border border-cohesity-border text-sm text-ink rounded-lg pl-9 pr-9 py-2 placeholder-ink-faint focus:border-brand/60 transition-colors"
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
              className="text-[11px] text-brand hover:text-brand-bright flex-shrink-0 mt-2.5">
              Estate-wide Server 360 →
            </Link>
          )}
        </div>
        {c && (
          <p className="text-[11px] text-ink-faint mt-2 tnum">
            Pivoting on {c.clientName}
          </p>
        )}
      </div>

      {!loading && nothingFound && (
        <div className="panel p-6 text-sm text-ink-muted text-center">
          No data for “{data.query}”. Check the spelling, or the client may not be inventoried yet.
        </div>
      )}

      {!loading && c && (
        <>
          <Panel title="Client" icon={HardDrive}>
            <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
              <Fact label="Client">{c.clientName} <span className="text-ink-faint text-[11px]">({c.sourceName || '—'})</span></Fact>
              <Fact label="Policies">{(c.policies || []).join(', ') || '—'}</Fact>
              <Fact label="Jobs (7d)">{c.jobs7d}</Fact>
              <Fact label="Failures (7d)"><Badge tone={c.failed7d > 0 ? 'crit' : 'ok'}>{c.failed7d}</Badge></Fact>
              <Fact label="Last Success">
                {c.lastSuccessAt ? (
                  <span className={`text-[11px] tnum ${Date.now() - toMs(c.lastSuccessAt) > 7 * 86400000 ? 'text-amber-400' : 'text-ink-faint'}`}>
                    {fmtDate(c.lastSuccessAt)} · {fmtAgo(c.lastSuccessAt)}
                  </span>
                ) : '—'}
              </Fact>
              <Fact label="FETB">{fmtBytes(c.logicalBytes)}</Fact>
            </div>
          </Panel>

          <Panel title="Backup Runs" icon={Activity}>
            <div className="flex gap-[3px] mb-3.5">
              {strip14.map((col) => (
                <span key={col.key}
                  title={col.run ? `${col.key}: ${runLabel(col.run)}` : `${col.key}: no run`}
                  className={`inline-block h-3.5 w-3.5 rounded-full ${col.run ? {
                    crit: 'bg-status-crit', warn: 'bg-status-warn', ok: 'bg-status-ok',
                  }[runTone(col.run)] : 'bg-surface-overlay opacity-50'}`}
                />
              ))}
            </div>
            {(data.runs14d || []).length === 0 ? (
              <p className="text-xs text-ink-faint">No runs in the last 14 days.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="text-left text-[11px] text-ink-muted border-b border-cohesity-border">
                      <th className="py-1.5 pr-3">Status</th>
                      <th className="py-1.5 pr-3">Policy</th>
                      <th className="py-1.5 pr-3">Type</th>
                      <th className="py-1.5 pr-3">Started</th>
                      <th className="py-1.5 pr-3">Elapsed</th>
                      <th className="py-1.5 pr-3">Size</th>
                      <th className="py-1.5">Status Code</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.runs14d || []).slice(0, 20).map((r) => (
                      <tr key={r.id} className="border-b border-cohesity-border/50">
                        <td className="py-1.5 pr-3"><Badge tone={runTone(r)}>{runLabel(r)}</Badge></td>
                        <td className="py-1.5 pr-3 text-ink-muted">{r.policyName || '—'}</td>
                        <td className="py-1.5 pr-3 text-ink-muted">{r.jobType || '—'}</td>
                        <td className="py-1.5 pr-3 tnum text-ink">{fmtTime(r.startedAt)}</td>
                        <td className="py-1.5 pr-3 tnum text-ink">{fmtDurationS(r.elapsedSeconds)}</td>
                        <td className="py-1.5 pr-3 tnum text-ink">{fmtBytes(r.kilobytes != null ? r.kilobytes * 1024 : null)}</td>
                        <td className={`py-1.5 tnum ${r.statusCode > 0 ? 'text-status-crit' : 'text-ink-faint'}`}>{r.statusCode > 0 ? r.statusCode : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {(data.policies || []).length > 0 && (
            <Panel title="Policies" icon={ClipboardList}>
              <div className="flex flex-col gap-2">
                {data.policies.map((p, i) => (
                  <div key={i} className="grid grid-cols-2 md:grid-cols-5 gap-3 border-b border-cohesity-border/40 last:border-0 pb-2 last:pb-0">
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
            <Panel title="Issues" icon={Bell}>
              <div className="flex flex-col gap-2">
                {data.issues.map((iss, i) => (
                  <div key={i} className="flex items-center gap-2.5 text-xs flex-wrap">
                    <Badge tone={iss.severity === 'critical' ? 'crit' : iss.severity === 'warning' ? 'warn' : 'info'}>{iss.severity || '—'}</Badge>
                    <span className="text-ink">{iss.type || '—'}</span>
                    <span className="text-ink-muted flex-1 min-w-[120px]">{iss.message || '—'}</span>
                    <span className="text-ink-faint tnum">{fmtAgo(iss.createdAt) || '—'}</span>
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
