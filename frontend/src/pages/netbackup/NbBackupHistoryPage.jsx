import { useEffect, useMemo, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams, Link } from 'react-router-dom';
import { CalendarCheck, Search, X } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel } from '../../components/ui/primitives';
import { fmtBytes, runStatusTone, runStatusLabel, nbuStatusText } from './helpers';

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

function dayRollup(runs) {
  if (!runs || runs.length === 0) return null;
  if (runs.some((r) => r.status === 'kFailure')) return 'crit';
  if (runs.some((r) => r.status === 'kWarning')) return 'warn';
  if (runs.some((r) => r.status === 'kSuccess')) return 'ok';
  return 'info';
}

const BUBBLE = {
  ok: 'bg-status-ok',
  warn: 'bg-status-warn',
  crit: 'bg-status-crit',
  info: 'bg-status-info animate-pulse',
};

export default function NbBackupHistoryPage() {
  const { toast } = useToast();
  const [sp, setSp] = useSearchParams();
  const [input, setInput] = useState(sp.get('q') || '');
  const [q, setQ] = useState(sp.get('q') || '');
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState(null);

  const search = useCallback((term, nDays) => {
    const query = String(term || '').trim();
    setLoading(true);
    client.get(`/netbackup/backup-history?q=${encodeURIComponent(query)}&days=${nDays}`)
      .then(({ data }) => {
        if (data && Array.isArray(data.servers)) setData(data);
        else {
          setData({ query, servers: [] });
          toast({ type: 'error', title: 'Unexpected response', message: 'The backend may not have been restarted since this feature was deployed.' });
        }
      })
      .catch(() => { setData({ query, servers: [] }); toast({ type: 'error', title: 'Failed to load backup history' }); })
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => { search(q, days); }, [q, days, search]);

  const submit = (e) => {
    e?.preventDefault();
    const term = input.trim();
    setQ(term);
    setSp(term ? { q: term } : {}, { replace: true });
  };

  const dayCols = useMemo(() => {
    const cols = [];
    const now = new Date();
    for (let i = 0; i < days; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      cols.push({ key: dayKey(d.getTime()), label: d.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' }) });
    }
    return cols;
  }, [days]);

  const servers = useMemo(() => (data?.servers || []).map((s) => {
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
      <PageHeader icon={CalendarCheck} title="Backup History"
        description="Day-by-day protection history for a client — search by name, click a day for run details">
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}
          className="bg-surface border border-cohesity-border text-[13px] text-ink rounded-lg px-3 py-1.5 focus:border-brand/60">
          <option value={7}>7 days</option>
          <option value={14}>14 days</option>
          <option value={30}>30 days</option>
        </select>
      </PageHeader>

      <form onSubmit={submit} className="panel p-3 mb-4 flex items-center gap-2">
        <div className="relative flex-1 min-w-[240px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Client name (min 2 characters)…"
            className="w-full bg-surface border border-cohesity-border text-[13px] text-ink rounded-lg pl-9 pr-3 py-2 placeholder-ink-faint focus:border-brand/60" />
        </div>
        <button type="submit" disabled={input.trim().length > 0 && input.trim().length < 2}
          className="px-4 py-2 rounded-lg text-sm font-semibold bg-brand/15 border border-brand/40 text-brand hover:bg-brand/25 transition-colors disabled:opacity-40 cursor-pointer">
          Search
        </button>
      </form>

      {loading ? (
        <LoadingPanel label="Loading backup history…" />
      ) : !data ? null : servers.length === 0 ? (
        <div className="panel p-10 text-center text-sm text-ink-muted">
          {data.browse
            ? 'No protected clients in the inventory yet — data appears after the next poll of each source.'
            : <>No clients match “{data.query}”.</>}
        </div>
      ) : (
        <div className="panel p-4">
          <p className="text-[11px] text-ink-faint mb-3 tnum">
            {data.browse
              ? `First ${servers.length} protected clients A–Z — search to find a specific client`
              : `${servers.length === 50 ? 'First 50 matches' : `${servers.length} match${servers.length === 1 ? '' : 'es'}`} for “${data.query}”`} ·
            green = success, amber = warning, red = failure · bubble marks the day the run started
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-separate border-spacing-0">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint">
                  <th className="py-2 pr-3 sticky left-0 bg-surface z-10 min-w-[240px] border-b border-cohesity-border">Client / Policy / Source</th>
                  {dayCols.map((c) => (
                    <th key={c.key} className="py-2 px-1 text-center tnum font-semibold border-b border-cohesity-border">{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {servers.map((s, idx) => (
                  <tr key={`${s.name}|${idx}`}>
                    <td className="py-2 pr-3 sticky left-0 bg-surface z-10 border-b border-cohesity-border/50">
                      <Link to={`/ops/server360?name=${encodeURIComponent(s.name)}`} title="Open Server 360"
                        className="text-ink font-medium hover:text-brand block leading-tight truncate max-w-[280px]">{s.name}</Link>
                      <span className="text-[11px] text-ink-faint block truncate max-w-[280px]"
                        title={`${(s.policies || []).join(', ')} · ${(s.sourceNames || []).join(', ')}`}>
                        {(s.policies || []).join(', ') || 'unprotected'} · {(s.sourceNames || []).join(', ')}
                      </span>
                    </td>
                    {dayCols.map((c) => {
                      const runs = s.byDay.get(c.key);
                      const tone = dayRollup(runs);
                      const bytes = (runs || []).reduce((t, r) => t + (r.logicalBytes || 0), 0);
                      return (
                        <td key={c.key} className="py-2 px-1 text-center border-b border-cohesity-border/50">
                          {tone ? (
                            <button
                              onClick={() => setModal({ server: s, date: c.key, runs })}
                              title={`${runs.length} run${runs.length === 1 ? '' : 's'} · ${fmtBytes(bytes)} logical`}
                              className={`inline-block h-3.5 w-3.5 rounded-full ${BUBBLE[tone]} hover:ring-2 hover:ring-brand/50 transition-shadow cursor-pointer`}
                              aria-label={`Backups on ${c.key}`}
                            />
                          ) : (
                            <span className="text-ink-faint/40 select-none">·</span>
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

      {modal && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setModal(null)}>
          <div className="panel w-auto min-w-[560px] max-w-[92vw] p-5 max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 mb-3">
              <div className="min-w-0">
                <h2 className="text-sm font-bold text-ink truncate">{modal.server.name} — {new Date(modal.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</h2>
                <p className="text-[11px] text-ink-muted">
                  {(modal.server.sourceNames || []).join(', ')} · {modal.runs.length} run{modal.runs.length === 1 ? '' : 's'}
                </p>
              </div>
              <button onClick={() => setModal(null)} aria-label="Close" className="text-ink-faint hover:text-ink flex-shrink-0"><X size={16} /></button>
            </div>
            <div className="overflow-y-auto flex flex-col gap-3">
              {modal.runs.map((r) => (
                <div key={r.id} className="bg-surface-overlay rounded-lg p-3">
                  <div className="flex items-center gap-2 flex-wrap mb-2">
                    <Badge tone={runStatusTone(r.status)}>{runStatusLabel(r.status)}</Badge>
                    <span className="text-sm text-ink font-medium truncate">{r.group}</span>
                    {r.runType && <span className="text-[11px] text-ink-faint">{String(r.runType).replace(/^k/, '')}</span>}
                    {r.clusterName && <span className="text-[11px] text-ink-faint ml-auto">{r.clusterName}</span>}
                  </div>
                  <div className="flex flex-wrap gap-x-6 gap-y-1 text-[12px]">
                    <div className="whitespace-nowrap"><span className="text-ink-faint">Start</span> <span className="text-ink tnum">{fmtTime(r.startMs)}</span></div>
                    <div className="whitespace-nowrap"><span className="text-ink-faint">Duration</span> <span className="text-ink tnum">{fmtDuration(r.startMs, r.endMs)}</span></div>
                    <div className="whitespace-nowrap"><span className="text-ink-faint">Logical</span> <span className="text-ink tnum">{fmtBytes(r.logicalBytes)}</span></div>
                  </div>
                  {r.errorCode != null && (
                    <p className="text-[12px] text-status-crit mt-2 break-words">{nbuStatusText(r.errorCode)}{r.errorMessage ? `: ${r.errorMessage}` : ''}</p>
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
