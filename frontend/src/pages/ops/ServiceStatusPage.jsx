import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { HeartPulse, Sparkles, X } from 'lucide-react';
import client from '../../api/client';
import WorkerChip from '../../components/WorkerChip';
import { PageHeader, Panel, Badge, LoadingPanel, RefreshButton, LastUpdated, timeAgo } from '../../components/ui/primitives';
import { useAiEnabled } from '../../api/useAiEnabled';

const DAYS_KEY = 'service-status-days';
const DAY_OPTIONS = [30, 60, 90];
const REFRESH_MS = 60_000;

const STATE_META = {
  ok: { label: 'Operational', color: '#22C55E', hint: 'No open critical alerts' },
  degraded: { label: 'Degraded', color: '#F59E0B', hint: 'Open critical alerts, some sources unreachable, or a host judged offline, while ICC still reaches the platform' },
  offline: { label: 'Offline', color: '#EF4444', hint: 'ICC cannot reach any source of this platform' },
  unknown: { label: 'No data', color: '#94A3B3', hint: 'No sweep recorded for this day' },
};

function stateMeta(state) {
  return STATE_META[state] || STATE_META.unknown;
}

function StatePill({ state }) {
  const m = stateMeta(state);
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold border"
      style={{ color: m.color, borderColor: `${m.color}40`, backgroundColor: `${m.color}1A` }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: m.color }} />
      {m.label}
    </span>
  );
}

function Dot({ day, onOpen }) {
  const m = stateMeta(day.state);
  const isToday = day.isToday;
  const clickable = day.events > 0 || day.state === 'degraded' || day.state === 'offline';
  const style = day.state === 'unknown'
    ? { backgroundColor: 'transparent', border: `1px solid ${m.color}` }
    : { backgroundColor: m.color };
  return (
    <button
      type="button"
      aria-disabled={!clickable}
      onClick={() => clickable && onOpen(day)}
      title={`${day.date}: ${m.label}, ${day.events} critical alert${day.events === 1 ? '' : 's'}`}
      className={`w-3 h-3 rounded-full flex-shrink-0 transition-transform ${clickable ? 'cursor-pointer hover:scale-125' : 'cursor-default'} ${isToday ? 'ring-2 ring-offset-1 ring-offset-cohesity-gray' : ''}`}
      style={{ ...style, ...(isToday ? { '--tw-ring-color': m.color } : {}) }}
    />
  );
}

/* ---- Shared modal shell (copied from bluecat/NetworkDetailModal.jsx) ---- */
function ModalShell({ title, subtitle, icon: Icon, onClose, children, footer }) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative panel w-full max-w-2xl max-h-[85vh] flex flex-col border-t-2 border-brand">
        <div className="flex items-start justify-between p-4 pb-3 border-b border-cohesity-border">
          <div className="flex items-center gap-2 min-w-0">
            {Icon && <Icon size={17} className="text-brand shrink-0" />}
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink truncate">{title}</p>
              {subtitle && <p className="text-[11px] text-ink-faint truncate">{subtitle}</p>}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="flex items-center justify-center h-7 w-7 rounded-md text-ink-muted hover:text-ink hover:bg-surface-overlay transition-colors cursor-pointer shrink-0">
            <X size={15} />
          </button>
        </div>
        <div className="p-4 overflow-y-auto">{children}</div>
        {footer && <div className="p-4 pt-3 border-t border-cohesity-border flex items-center justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

/* ---- Day events modal ---- */
const ANALYSIS_TONE = {
  offline: { label: 'Offline', color: '#EF4444', outline: false },
  degraded: { label: 'Degraded', color: '#F59E0B', outline: false },
  pending: { label: 'Analysis pending', color: '#94A3B3', outline: false },
  running: { label: 'Analysis pending', color: '#94A3B3', outline: false },
  failed: { label: 'Analysis failed', color: '#EF4444', outline: true },
  disabled: { label: 'AI off', color: '#94A3B3', outline: false },
};

function verdictTone(event) {
  if (event.analysisStatus === 'pending' || event.analysisStatus === 'running') return ANALYSIS_TONE.pending;
  if (event.analysisStatus === 'failed') return ANALYSIS_TONE.failed;
  if (event.analysisStatus === 'disabled') return ANALYSIS_TONE.disabled;
  if (event.verdict === 'offline') return ANALYSIS_TONE.offline;
  if (event.verdict === 'degraded') return ANALYSIS_TONE.degraded;
  return ANALYSIS_TONE.disabled;
}

function DayEventsModal({ platform, date, onClose, onOpenAnalysis }) {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setError(null);
    client.get('/service-status/events', { params: { platform: platform.id, date } })
      .then((r) => setEvents(r.data?.events || []))
      .catch((e) => setError(e.response?.data?.error || 'Could not load events for this day.'));
  }, [platform.id, date]);

  useEffect(() => { setEvents(null); load(); }, [load]);

  return (
    <ModalShell title={platform.label} subtitle={`${date} (UTC)`} icon={HeartPulse} onClose={onClose}>
      {events === null && !error ? (
        <LoadingPanel label="Loading events" height={140} />
      ) : error ? (
        <div className="text-center py-6">
          <p className="text-xs text-status-crit mb-2">{error}</p>
          <button onClick={load} className="text-xs font-semibold text-brand hover:text-brand-bright cursor-pointer">Retry</button>
        </div>
      ) : events.length === 0 ? (
        <p className="text-xs text-ink-muted py-6 text-center">No critical alerts recorded on this day.</p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {events.map((ev) => {
            const tone = verdictTone(ev);
            return (
              <div key={ev.id} className="border border-cohesity-border rounded-lg p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <Badge tone="crit">{ev.severity}</Badge>
                      <span
                        className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold border"
                        style={tone.outline
                          ? { color: tone.color, borderColor: tone.color, backgroundColor: 'transparent' }
                          : { color: tone.color, borderColor: `${tone.color}40`, backgroundColor: `${tone.color}1A` }}
                      >
                        {tone.label}
                      </span>
                    </div>
                    <p className="text-sm font-medium text-ink truncate">{ev.host || platform.label}</p>
                    <p className="text-xs text-ink-muted break-words mt-0.5">{ev.message}</p>
                    <p className="text-[11px] text-ink-faint mt-1.5">
                      Detected {timeAgo(ev.detectedAt)}
                      {' - '}
                      {ev.clearedAt ? <span>Cleared {timeAgo(ev.clearedAt)}</span> : <span className="text-status-warn">Still open</span>}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                    <Link
                      to={ev.alertLink}
                      onClick={onClose}
                      className="text-[11px] font-semibold text-brand hover:text-brand-bright whitespace-nowrap"
                    >
                      Open alert
                    </Link>
                    <button
                      onClick={() => onOpenAnalysis(ev.id)}
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-ink-muted hover:text-ink cursor-pointer whitespace-nowrap"
                    >
                      <Sparkles size={11} /> AI analysis
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </ModalShell>
  );
}

/* ---- Analysis modal ---- */
function AnalysisModal({ eventId, onClose }) {
  const [event, setEvent] = useState(null);
  const [error, setError] = useState(null);
  const [rerunning, setRerunning] = useState(false);
  const [rerunError, setRerunError] = useState(null);
  const aiEnabled = useAiEnabled();
  const pollRef = useRef(null);

  const load = useCallback(() => {
    client.get(`/service-status/events/${eventId}`)
      .then((r) => setEvent(r.data))
      .catch((e) => setError(e.response?.data?.error || 'Could not load this analysis.'));
  }, [eventId]);

  useEffect(() => { setEvent(null); setError(null); load(); }, [load]);

  useEffect(() => {
    const pending = event && (event.analysisStatus === 'pending' || event.analysisStatus === 'running');
    if (!pending) return;
    pollRef.current = setInterval(load, 5000);
    return () => clearInterval(pollRef.current);
  }, [event, load]);

  const rerun = async () => {
    setRerunning(true);
    setRerunError(null);
    try {
      const { data } = await client.post(`/service-status/events/${eventId}/analyze`);
      setEvent(data);
    } catch (e) {
      const status = e.response?.status;
      setRerunError(e.response?.data?.error || (status === 429 ? 'Rate limited. Try again shortly.' : 'Analysis failed. Try again.'));
    } finally {
      setRerunning(false);
    }
  };

  if (error) {
    return (
      <ModalShell title="AI analysis" icon={Sparkles} onClose={onClose}>
        <div className="text-center py-6">
          <p className="text-xs text-status-crit mb-2">{error}</p>
          <button onClick={load} className="text-xs font-semibold text-brand hover:text-brand-bright cursor-pointer">Retry</button>
        </div>
      </ModalShell>
    );
  }

  if (!event || event.analysisStatus === 'pending' || event.analysisStatus === 'running') {
    return (
      <ModalShell title="AI analysis" icon={Sparkles} onClose={onClose}>
        <LoadingPanel label="Analysis queued, waiting for the AI worker" height={160} />
      </ModalShell>
    );
  }

  const a = event.analysis;
  const subtitle = (event.message || '').length > 140 ? `${event.message.slice(0, 140)}...` : event.message;

  return (
    <ModalShell
      title={event.host || event.platform}
      subtitle={subtitle}
      icon={Sparkles}
      onClose={onClose}
      footer={aiEnabled ? (
        <button
          onClick={rerun}
          disabled={rerunning}
          className="flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer"
        >
          <Sparkles size={13} /> {rerunning ? 'Running...' : 'Re-run analysis'}
        </button>
      ) : (
        <p className="text-[11px] text-ink-faint">AI analysis is not configured on the server.</p>
      )}
    >
      {!a ? (
        <p className="text-xs text-ink-muted">No analysis available for this event.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {rerunError && <p className="text-xs text-status-crit">{rerunError}</p>}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <StatePill state={a.verdict} />
              {a.confidence && <span className="text-[11px] text-ink-faint">confidence {a.confidence}</span>}
            </div>
            {a.aiVerdict && a.aiVerdict !== a.evidenceVerdict && (
              <p className="text-[11px] text-status-warn">
                ICC evidence says {a.evidenceVerdict}, the AI says {a.aiVerdict}: {a.verdictReason}
              </p>
            )}
            {!a.aiVerdict && (
              <p className="text-[11px] text-ink-faint">
                Verdict from ICC polling evidence only.{a.error ? ` ${a.error}` : ''}
              </p>
            )}
          </div>

          {a.why && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint mb-1">Why</p>
              <p className="text-xs text-ink-muted leading-relaxed">{a.why}</p>
            </div>
          )}
          {a.actions && a.actions.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint mb-1">What to do</p>
              <ol className="list-decimal list-inside text-xs text-ink-muted leading-relaxed flex flex-col gap-1">
                {a.actions.map((act, i) => <li key={i}>{act}</li>)}
              </ol>
            </div>
          )}
          {a.currentState && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint mb-1">Current state</p>
              <p className="text-xs text-ink-muted leading-relaxed">{a.currentState}</p>
            </div>
          )}

          <div className="pt-2 border-t border-cohesity-border flex items-center gap-2 flex-wrap text-[11px] text-ink-faint">
            {a.model && <span>{a.model}</span>}
            {a.createdAt && <span>Generated {timeAgo(a.createdAt)}</span>}
            {a.reusedFrom && <span>Reused from an identical alert analyzed earlier</span>}
          </div>
        </div>
      )}
    </ModalShell>
  );
}

/* ---- Platform row ---- */
function PlatformRow({ platform, onOpenDay }) {
  const cur = platform.current || { state: 'unknown' };
  const today = platform.days[platform.days.length - 1]?.date;
  return (
    <Panel className="!mb-0">
      <div className="flex flex-col lg:flex-row lg:items-center gap-3 lg:gap-6">
        <div className="flex items-center lg:w-56 flex-shrink-0">
          {/* No platform brand-colour dot here: next to red/yellow/green state it reads as a status. */}
          <div className="min-w-0">
            <Link to={platform.route} className="text-sm font-semibold text-ink hover:text-brand truncate block">
              {platform.label}
            </Link>
            <div className="flex items-center gap-2 flex-wrap mt-0.5">
              <StatePill state={cur.state} />
              {cur.since && <span className="text-[11px] text-ink-faint">since {timeAgo(cur.since)}</span>}
            </div>
            {(cur.openEvents > 0) && (
              <p className="text-[11px] text-ink-faint mt-0.5">
                {cur.openEvents} open critical alert{cur.openEvents === 1 ? '' : 's'}
                {cur.sourcesUnreachable > 0 && `, ${cur.sourcesUnreachable} of ${cur.sourcesPolled} source${cur.sourcesPolled === 1 ? '' : 's'} unreachable`}
                {cur.openOffline > 0 && `, ${cur.openOffline} host${cur.openOffline === 1 ? '' : 's'} offline`}
              </p>
            )}
          </div>
        </div>
        <div className="flex-1 flex items-center gap-1 flex-wrap min-w-0">
          {platform.days.map((day) => (
            <Dot key={day.date} day={{ ...day, isToday: day.date === today }} onOpen={(d) => onOpenDay(platform, d.date)} />
          ))}
        </div>
      </div>
    </Panel>
  );
}

/* ---- Legend ---- */
function Legend() {
  return (
    <div className="flex items-center gap-4 flex-wrap text-[11px] text-ink-muted">
      {['ok', 'degraded', 'offline', 'unknown'].map((s) => {
        const m = stateMeta(s);
        return (
          <span key={s} className="inline-flex items-center gap-1.5 cursor-help" title={m.hint}>
            <span
              className="h-2.5 w-2.5 rounded-full flex-shrink-0"
              style={s === 'unknown' ? { backgroundColor: 'transparent', border: `1px solid ${m.color}` } : { backgroundColor: m.color }}
            />
            {m.label}
          </span>
        );
      })}
    </div>
  );
}

/* ---- Main page ---- */
export default function ServiceStatusPage() {
  const [days, setDays] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(DAYS_KEY));
      return DAY_OPTIONS.includes(stored) ? stored : 30;
    } catch { return 30; }
  });
  const [board, setBoard] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [dayModal, setDayModal] = useState(null);   // { platform, date }
  const [analysisEventId, setAnalysisEventId] = useState(null);

  const load = useCallback((days, { silent } = {}) => {
    if (!silent) setRefreshing(true);
    setError(null);
    return client.get('/service-status/board', { params: { days } })
      .then((r) => setBoard(r.data))
      .catch((e) => setError(e.response?.data?.error || 'Could not load the service status board.'))
      .finally(() => setRefreshing(false));
  }, []);

  useEffect(() => { load(days); }, [days, load]);

  useEffect(() => {
    const t = setInterval(() => load(days, { silent: true }), REFRESH_MS);
    return () => clearInterval(t);
  }, [days, load]);

  const selectDays = (n) => {
    setDays(n);
    try { localStorage.setItem(DAYS_KEY, String(n)); } catch { /* ignore */ }
  };

  return (
    <div>
      <PageHeader
        icon={HeartPulse}
        title="Service status"
        description="Point-in-time platform state driven by critical alerts. One dot per day, today is live."
      >
        <div className="flex items-center gap-1 rounded-lg border border-cohesity-border p-0.5">
          {DAY_OPTIONS.map((n) => (
            <button
              key={n}
              onClick={() => selectDays(n)}
              className={`px-2.5 py-1 rounded text-xs font-semibold transition-colors cursor-pointer ${n === days ? 'bg-brand/10 text-brand' : 'text-ink-muted hover:text-ink'}`}
            >
              {n}d
            </button>
          ))}
        </div>
        {board && <WorkerChip worker={board.worker} />}
        <LastUpdated date={board?.generatedAt} />
        <RefreshButton onClick={() => load(days)} refreshing={refreshing} />
      </PageHeader>

      <div className="mb-4">
        <Legend />
      </div>

      {!board && !error ? (
        <LoadingPanel label="Loading service status" />
      ) : error ? (
        <Panel>
          <p className="text-xs text-status-crit mb-2">{error}</p>
          <button onClick={() => load(days)} className="text-xs font-semibold text-brand hover:text-brand-bright cursor-pointer">Retry</button>
        </Panel>
      ) : board.platforms.length === 0 ? (
        <Panel><p className="text-xs text-ink-muted">No enabled platforms report alerts yet.</p></Panel>
      ) : (
        <div className="flex flex-col gap-2.5">
          {board.platforms.map((p) => (
            <PlatformRow key={p.id} platform={p} onOpenDay={(platform, date) => setDayModal({ platform, date })} />
          ))}
        </div>
      )}

      {dayModal && (
        <DayEventsModal
          platform={dayModal.platform}
          date={dayModal.date}
          onClose={() => setDayModal(null)}
          onOpenAnalysis={(id) => setAnalysisEventId(id)}
        />
      )}
      {analysisEventId != null && (
        <AnalysisModal eventId={analysisEventId} onClose={() => setAnalysisEventId(null)} />
      )}
    </div>
  );
}

export { AnalysisModal };
