import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { HeartPulse, XCircle, AlertTriangle, CheckCircle2, Layers, X } from 'lucide-react';
import client from '../../api/client';
import { PageHeader, Panel, StatCard, LoadingPanel, RefreshButton, LastUpdated, timeAgo } from '../../components/ui/primitives';
import { useVisibleInterval } from '../logicmonitor/helpers';

const DAYS_KEY = 'service-groups-status-days';
const DAY_OPTIONS = [30, 60, 90];
const REFRESH_MS = 60_000;

const STATE_META = {
  ok: { label: 'Operational', color: '#22C55E', hint: 'No failed or degraded devices in this service' },
  degraded: { label: 'Degraded', color: '#F59E0B', hint: 'Some devices in this service have warnings or are degraded' },
  failed: { label: 'Failed', color: '#EF4444', hint: 'Enough devices in this service have failed to take it down' },
  unknown: { label: 'No devices', color: '#94A3B3', hint: 'No devices resolved for this service, or no state recorded for this day' },
};

function meta(state) { return STATE_META[state] || STATE_META.unknown; }

function StatePill({ state }) {
  const m = meta(state);
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
  const m = meta(day.state);
  const changes = day.changes || 0;
  const clickable = changes > 0 || day.state === 'degraded' || day.state === 'failed';
  const style = day.state === 'unknown'
    ? { backgroundColor: 'transparent', border: `1px solid ${m.color}` }
    : { backgroundColor: m.color };
  return (
    <button
      type="button"
      aria-disabled={!clickable}
      onClick={() => clickable && onOpen(day)}
      title={`${day.date}: ${m.label}, ${changes} state change${changes === 1 ? '' : 's'}`}
      className={`w-3 h-3 rounded-full flex-shrink-0 transition-transform ${clickable ? 'cursor-pointer hover:scale-125' : 'cursor-default'} ${day.isToday ? 'ring-2 ring-offset-1 ring-offset-cohesity-gray' : ''}`}
      style={{ ...style, ...(day.isToday ? { '--tw-ring-color': m.color } : {}) }}
    />
  );
}

function ModalShell({ title, subtitle, icon: Icon, onClose, children }) {
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
      </div>
    </div>,
    document.body
  );
}

function countsLine(c) {
  if (!c || !c.total) return 'No devices';
  return `${c.crit || 0} failed, ${c.warn || 0} degraded, ${c.ok || 0} ok of ${c.total} device${c.total === 1 ? '' : 's'}`;
}

function DayEventsModal({ service, date, onClose }) {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setError(null);
    client.get(`/service-status/services/${encodeURIComponent(service.serviceId)}/events`, { params: { date } })
      .then((r) => setEvents(r.data?.events || []))
      .catch((e) => setError(e.response?.data?.error || 'Could not load events for this day.'));
  }, [service.serviceId, date]);

  useEffect(() => { setEvents(null); load(); }, [load]);

  return (
    <ModalShell title={service.label} subtitle={`${date} (UTC)`} icon={HeartPulse} onClose={onClose}>
      {events === null && !error ? (
        <LoadingPanel label="Loading events" height={140} />
      ) : error ? (
        <div className="text-center py-6">
          <p className="text-xs text-status-crit mb-2">{error}</p>
          <button onClick={load} className="text-xs font-semibold text-brand hover:text-brand-bright cursor-pointer">Retry</button>
        </div>
      ) : events.length === 0 ? (
        <p className="text-xs text-ink-muted py-6 text-center">No state change recorded on this day</p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {events.map((ev) => (
            <div key={ev.id} className="border border-cohesity-border rounded-lg p-3">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <StatePill state={ev.state} />
                <span className="text-[11px] text-ink-faint">{ev.at ? `${String(ev.at).replace('T', ' ').slice(0, 19)} UTC` : ''}</span>
              </div>
              {ev.reason && <p className="text-xs text-ink-muted break-words mt-1">{ev.reason}</p>}
              {ev.counts && <p className="text-[11px] text-ink-faint mt-1">{countsLine(ev.counts)}</p>}
            </div>
          ))}
        </div>
      )}
    </ModalShell>
  );
}

function ServiceRow({ service, onOpenDay }) {
  const cur = service.current || { state: 'unknown' };
  const days = service.days || [];
  const today = days[days.length - 1]?.date;
  return (
    <Panel className="!mb-0">
      <div className="flex flex-col lg:flex-row lg:items-center gap-3 lg:gap-6">
        <div className="flex items-center lg:w-72 flex-shrink-0">
          <div className="min-w-0">
            <Link to={service.route} className="text-sm font-semibold text-ink hover:text-brand truncate block">
              {service.label}
            </Link>
            <div className="flex items-center gap-2 flex-wrap mt-0.5">
              <StatePill state={cur.state} />
              {cur.since && <span className="text-[11px] text-ink-faint">since {timeAgo(cur.since)}</span>}
            </div>
            <p className="text-[11px] text-ink-faint mt-0.5">{countsLine(cur.counts)}</p>
            {cur.reason && cur.state !== 'ok' && (
              <p className="text-[11px] text-ink-muted mt-0.5 break-words">{cur.reason}</p>
            )}
            <div className="flex items-center gap-3 mt-1">
              <Link to={service.route} className="text-[11px] font-semibold text-brand hover:text-brand-bright">Open service</Link>
              <Link to="/logicmonitor/groups" className="text-[11px] font-semibold text-brand hover:text-brand-bright">Groups</Link>
            </div>
          </div>
        </div>
        <div className="flex-1 flex items-center gap-1 flex-wrap min-w-0">
          {days.map((day) => (
            <Dot key={day.date} day={{ ...day, isToday: day.date === today }} onOpen={(d) => onOpenDay(service, d.date)} />
          ))}
        </div>
      </div>
    </Panel>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-4 flex-wrap text-[11px] text-ink-muted">
      {['ok', 'degraded', 'failed', 'unknown'].map((s) => {
        const m = meta(s);
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

export default function ServiceGroupsStatusPage() {
  const [days, setDays] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(DAYS_KEY));
      return DAY_OPTIONS.includes(stored) ? stored : 30;
    } catch { return 30; }
  });
  const [board, setBoard] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [dayModal, setDayModal] = useState(null);

  const load = useCallback((n, { silent } = {}) => {
    if (!silent) setRefreshing(true);
    setError(null);
    return client.get('/service-status/services', { params: { days: n } })
      .then((r) => setBoard(r.data))
      .catch((e) => setError(e.response?.data?.error || 'Could not load the service status board.'))
      .finally(() => setRefreshing(false));
  }, []);

  useEffect(() => { load(days); }, [days, load]);
  useVisibleInterval(() => load(days, { silent: true }), REFRESH_MS);

  const selectDays = (n) => {
    setDays(n);
    try { localStorage.setItem(DAYS_KEY, String(n)); } catch { /* ignore */ }
  };

  const shapeOk = board && Array.isArray(board.services);
  const services = shapeOk ? board.services : [];
  const countState = (s) => services.filter((x) => (x.current?.state || 'unknown') === s).length;

  return (
    <div>
      <PageHeader
        icon={HeartPulse}
        title="Service status"
        description="LogicMonitor service groups and their state day by day"
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
        <LastUpdated date={board?.generatedAt} />
        <RefreshButton onClick={() => load(days)} refreshing={refreshing} />
      </PageHeader>

      {shapeOk && services.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 mb-4">
          <StatCard icon={XCircle} label="Failed" value={countState('failed')} tone={countState('failed') > 0 ? 'crit' : 'default'} />
          <StatCard icon={AlertTriangle} label="Degraded" value={countState('degraded')} tone={countState('degraded') > 0 ? 'warn' : 'default'} />
          <StatCard icon={CheckCircle2} label="Operational" value={countState('ok')} tone="ok" />
          <StatCard icon={Layers} label="Services" value={board.picked ?? services.length} sub="picked in LogicMonitor" />
        </div>
      )}

      <div className="mb-4"><Legend /></div>

      {!board && !error ? (
        <LoadingPanel label="Loading service status" />
      ) : error ? (
        <Panel>
          <p className="text-xs text-status-crit mb-2">{error}</p>
          <button onClick={() => load(days)} className="text-xs font-semibold text-brand hover:text-brand-bright cursor-pointer">Retry</button>
        </Panel>
      ) : !shapeOk ? (
        <Panel><p className="text-xs text-status-warn">The service answered with a shape this page does not read. The backend may be older than this page; restart it after the pull.</p></Panel>
      ) : services.length === 0 ? (
        <Panel>
          {board.logicmonitorEnabled === false ? (
            <p className="text-xs text-ink-muted">LogicMonitor is off; service groups come from LogicMonitor.</p>
          ) : (
            <p className="text-xs text-ink-muted">
              No services picked yet.{' '}
              <Link to="/logicmonitor/settings?section=servicegroups" className="font-semibold text-brand hover:text-brand-bright">Pick service groups</Link>
            </p>
          )}
        </Panel>
      ) : (
        <div className="flex flex-col gap-2.5">
          {services.map((s) => (
            <ServiceRow key={s.serviceId} service={s} onOpenDay={(service, date) => setDayModal({ service, date })} />
          ))}
        </div>
      )}

      {dayModal && (
        <DayEventsModal service={dayModal.service} date={dayModal.date} onClose={() => setDayModal(null)} />
      )}
    </div>
  );
}
