import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import { Bot, X, Mail, RefreshCw, CheckCircle2, Play, Settings, Bell, BellOff, Clock } from 'lucide-react';
import client from '../../api/client';
import { PageHeader, Panel, Badge, LoadingPanel, LastUpdated, timeAgo } from '../../components/ui/primitives';
import WorkerChip from '../../components/WorkerChip';
import { useToast } from '../../components/ui/Toaster';
import { useTableControls, SortTh, TablePager } from '../../components/ui/tableTools';
import Sparkline from '../../components/ops/Sparkline';
import ResolveNoteDialog from '../../components/ops/ResolveNoteDialog';
import ObservationModal, { OBS_STATE_TONE, fmtObs, fmtMinutes, obsDetailLine } from '../../components/ops/ObservationModal';
import WatchListModal from '../../components/ops/WatchListModal';

const REFRESH_MS = 60_000;   // floor: a full reload even when nothing changed
const PULSE_MS = 5_000;      // change probe, so a tick shows up within seconds
const STATE_META = {
  collecting: { label: 'Collecting', tone: 'info', hint: 'Holding for related alerts before triage' },
  triaged: { label: 'Triaged', tone: 'warn', hint: 'Analysis written, email pending or off' },
  notified: { label: 'Notified', tone: 'ok', hint: 'Analysis emailed' },
  clearing: { label: 'Clearing', tone: 'info', hint: 'Alerts cleared; closing once they stay quiet' },
  resolved: { label: 'Resolved', tone: 'neutral', hint: 'Every alert cleared or closed by hand' },
};
const CLASS_TONE = { incident: 'crit', recurring: 'warn', 'one-off': 'info', noise: 'neutral', 'self-cleared': 'neutral', 'self-healed': 'ok' };
const KIND_LABEL = { 'app-service': 'App service', 'platform-wide': 'Platform-wide', source: 'Source', host: 'Host', site: 'Site', location: 'Probe location', 'network-burst': 'Link-down burst', pattern: 'Pattern', 'shared-component': 'Shared component' };
const SNOOZE_DAYS = [1, 3, 7, 14, 30];
const fmtDays = (n) => `${n} day${n === 1 ? '' : 's'}`;
const fmtLasted = (m) => (m == null ? '-' : m >= 60 ? `${(m / 60).toFixed(1)} h` : `${m} min`);
/** The run row is written when a tick ends, so a tick that hangs leaves
 *  "last tick" frozen while its work still shows up. This says one is in
 *  flight, and turns red when it has been in flight too long to be normal. */
function LastTickChip({ lastRun }) {
  if (!lastRun) {
    return (
      <span title="No tick has ever finished on this instance. The agent's work is done in the poller process and recorded when a tick ends, so this means no tick has completed since the database was created.">
        <Badge tone="crit">No tick recorded</Badge>
      </span>
    );
  }
  const mins = Math.round((Date.now() - Date.parse(lastRun.at)) / 60000);
  if (mins < 5 && !lastRun.error) return null;                 // ticking every minute: nothing to say
  const why = lastRun.error
    ? `Last tick reported: ${lastRun.error}`
    : 'A tick should finish every minute. This one has not, so the poller process is down, stuck or idle.';
  return <span title={why}><Badge tone={mins >= 15 || lastRun.error ? 'crit' : 'warn'}>Last tick {timeAgo(lastRun.at)}</Badge></span>;
}

function TickChip({ startedAt }) {
  if (!startedAt) return null;
  const mins = Math.round((Date.now() - Date.parse(startedAt)) / 60000);
  const tone = mins >= 10 ? 'crit' : 'info';
  const why = mins >= 10
    ? 'A tick normally finishes in seconds. This one is stuck on something it is waiting for; the agent starts a fresh tick after 30 minutes and the poller log says so.'
    : 'A tick is running now. The last tick line only moves when a tick finishes.';
  return <span title={why}><Badge tone={tone}>Tick running {mins < 1 ? 'now' : `${mins}m`}</Badge></span>;
}

const OBS_SPARK = { watching: '#38BDF8', degrading: '#F59E0B', critical: '#F87171', closed: '#94A3B8' };
const obsValues = (series) => (Array.isArray(series) ? series.map((p) => (p ? p.v : null)) : []);
const isObservationAlert = (al) => String(al?.kind || '').startsWith('observation')
  || String(al?.sourceKey || al?.source_key || '').startsWith('obs')
  || /-(hot|pattern)$/.test(String(al?.type || ''));

const sevTone = (s) => (s === 'critical' ? 'crit' : s === 'error' || s === 'warning' ? 'warn' : 'info');

function ModalShell({ title, subtitle, badges, icon: Icon, onClose, children, footer, size = 'md' }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const xl = size === 'xl';
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className={`relative panel flex flex-col border-t-2 border-brand ${xl ? '' : 'w-full max-w-3xl max-h-[88vh]'}`}
        style={xl ? { width: 'min(92vw, 1320px)', maxHeight: '92vh' } : undefined}>
        <div className="p-4 pb-3 border-b border-cohesity-border">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-2 min-w-0">
              {Icon && <Icon size={17} className="text-brand shrink-0" />}
              <div className="min-w-0">
                <p className="text-[15px] font-semibold text-ink truncate">{title}</p>
                {subtitle && <p className="text-[11px] text-ink-faint truncate">{subtitle}</p>}
              </div>
            </div>
            <button onClick={onClose} aria-label="Close"
              className="flex items-center justify-center h-7 w-7 rounded-md text-ink-muted hover:text-ink hover:bg-surface-overlay transition-colors cursor-pointer shrink-0">
              <X size={15} />
            </button>
          </div>
          {badges && <div className="flex items-center gap-2 mt-2.5 flex-wrap">{badges}</div>}
        </div>
        <div className={`overflow-y-auto ${xl ? 'p-5 text-[13px] leading-normal' : 'p-4'}`}>{children}</div>
        {footer && <div className="p-4 pt-3 border-t border-cohesity-border flex items-center justify-end gap-2 flex-wrap">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

const SEV_BORDER = { crit: 'border-status-crit/50', warn: 'border-status-warn/50', info: 'border-status-info/50' };

const Section = ({ title, children, className = '', borderClass = 'border-cohesity-border' }) => (
  <div className={`rounded-lg border ${borderClass} p-4 mb-4 ${className}`}>
    <p className="text-[11px] uppercase tracking-wide text-ink-faint pb-1.5 mb-2.5 border-b border-cohesity-border">{title}</p>
    {children}
  </div>
);

// The triage summary is one issue per line; old incidents hold a single paragraph.
const SummaryLines = ({ text, className = 'text-ink' }) => {
  const lines = String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (lines.length > 1) return <ul className={`list-disc pl-5 text-[13px] space-y-1 ${className}`}>{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>;
  return <p className={`text-[13px] ${className}`}>{lines[0] || '-'}</p>;
};

/** Renders a bulleted or numbered list, collapsing past `limit` items behind a Show all link. */
function CollapsibleList({ items, render, limit = 6, ordered = false, className = '' }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, limit);
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <>
      <Tag className={`${ordered ? 'list-decimal' : 'list-disc'} pl-5 text-[13px] space-y-1 ${className}`}>{shown.map((it, i) => <li key={i}>{render(it, i)}</li>)}</Tag>
      {items.length > limit && (
        <button onClick={() => setAll((v) => !v)} className="mt-2 text-[11px] text-brand hover:underline cursor-pointer">
          {all ? 'Show fewer' : `Show all (${items.length})`}
        </button>
      )}
    </>
  );
}

function Fact({ label, children }) {
  return (<><dt className="text-ink-faint">{label}</dt><dd className="text-ink min-w-0 break-words">{children}</dd></>);
}

function AlertMessage({ text }) {
  const [open, setOpen] = useState(false);
  const long = String(text || '').length > 240;
  return (
    <div>
      <span className={!open && long ? 'line-clamp-3' : ''}>{text}</span>
      {long && <button onClick={() => setOpen((v) => !v)} className="block text-[11px] text-brand hover:underline cursor-pointer">{open ? 'Show less' : 'Show more'}</button>}
    </div>
  );
}

const footBtn = 'flex items-center gap-1.5 text-[13px] font-medium px-3 py-1.5 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink transition-colors disabled:opacity-50 cursor-pointer';

function IncidentModal({ id, onClose, onChanged, pulse, agentName = 'ICC', onOpenObservation, reminderHours = 0 }) {
  const [inc, setInc] = useState(null);
  const [failed, setFailed] = useState(null);
  const [busy, setBusy] = useState(null);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const { toast } = useToast();

  const load = useCallback(() => client.get(`/ops-agent/incidents/${id}`)
    .then(({ data }) => setInc(data))
    .catch((e) => setFailed(e?.response?.data?.error || 'Failed to load incident.')), [id]);
  useEffect(() => { load(); }, [load, pulse]);

  const act = async (verb, label, body) => {
    setBusy(verb);
    try {
      const { data } = await client.post(`/ops-agent/incidents/${id}/${verb}`, body);
      setInc(data);
      onChanged?.();
      toast({ type: 'success', title: label });
      return true;
    } catch (e) {
      toast({ type: 'error', title: `${label} failed`, message: e?.response?.data?.error || 'Try again.' });
      return false;
    } finally { setBusy(null); }
  };
  const doSnooze = (days) => { setSnoozeOpen(false); act('snooze', days ? `Snoozed for ${fmtDays(days)}` : 'Snooze cleared', { days }); };
  const doResolve = async (note) => {
    const ok = await act('resolve', 'Incident resolved', note ? { note } : {});
    if (ok) setResolving(false);
  };

  const a = inc?.analysis;
  const sm = inc ? (STATE_META[inc.state] || STATE_META.collecting) : null;
  const sev = inc ? sevTone(inc.severity) : 'info';
  const networkBlocks = Array.isArray(inc?.evidence?.network) ? inc.evidence.network.filter((n) => n && Array.isArray(n.lines) && n.lines.length > 0) : [];
  const live = inc?.evidence?.liveChecks;
  const evidenceEpisodes = Array.isArray(inc?.evidence?.observations?.episodes) ? inc.evidence.observations.episodes : [];
  // The alert row keeps what the episode looked like when it opened this incident
  // (peak, when, the first crossing), so it survives the episode closing. Show
  // each episode through that detail, and any alert whose episode left the evidence.
  const alertDetails = new Map((inc?.alerts || []).filter((x) => x.detail && x.detail.episodeId != null).map((x) => [x.detail.episodeId, x]));
  const observedEpisodes = [
    ...evidenceEpisodes.map((ep) => ({ ...ep, detail: (alertDetails.get(ep.id) || {}).detail || null })),
    ...[...alertDetails.entries()].filter(([id]) => !evidenceEpisodes.some((ep) => ep.id === id))
      .map(([id, x]) => ({ id, label: x.type || 'Observation', subject: x.host || '', state: x.detail.state, unit: x.detail.unit, series: [], detail: x.detail })),
  ];
  const observedHistory = Array.isArray(inc?.evidence?.observations?.history) ? inc.evidence.observations.history : [];
  const openAlerts = inc ? inc.alerts.filter((x) => !x.clearedAt).length : 0;
  const isOpen = !!inc && inc.state !== 'resolved';
  const snoozed = !!(inc && (inc.snoozed || (inc.snoozedUntil && Date.parse(inc.snoozedUntil) > Date.now())));
  const awaiting = !!(inc && inc.awaitingHuman);
  const patternBursts = Array.isArray(inc?.evidence?.pattern?.bursts) ? inc.evidence.pattern.bursts : [];
  const notes = Array.isArray(inc?.notes) ? inc.notes : [];

  const badges = inc && (
    <>
      <Badge tone={sm.tone}>{sm.label}</Badge>
      <Badge tone={sev}>{String(inc.severity).toUpperCase()}</Badge>
      {inc.classification && <Badge tone={CLASS_TONE[inc.classification] || 'neutral'}>{inc.classification}{inc.confidence ? ` · ${inc.confidence} confidence` : ''}</Badge>}
      {a?.source === 'fallback' && <Badge tone="warn">rule-based digest</Badge>}
      {inc.baseline && <Badge tone="neutral">baseline</Badge>}
      {awaiting && <Badge tone="crit">awaiting investigation</Badge>}
      {inc.acknowledgedAt && <span title={new Date(inc.acknowledgedAt).toLocaleString()}><Badge tone="warn">acknowledged by {inc.acknowledgedBy || 'a user'}</Badge></span>}
      {snoozed && inc.snoozedUntil && <span title={new Date(inc.snoozedUntil).toLocaleString()}><Badge tone="neutral">snoozed until {new Date(inc.snoozedUntil).toLocaleDateString()}</Badge></span>}
      {inc.reminderCount > 0 && <span title={inc.reminderAt ? new Date(inc.reminderAt).toLocaleString() : ''}><Badge tone="info">reminder {inc.reminderCount} sent{inc.reminderAt ? ` ${timeAgo(inc.reminderAt)}` : ''}</Badge></span>}
      {inc.humanRequired === true && <Badge tone="crit">human required</Badge>}
      {inc.humanRequired === false && <Badge tone="ok">no human needed</Badge>}
      {inc.healAttempted && <Badge tone="info">re-poll attempted</Badge>}
      {inc.teamsNotifiedAt && <span title={`Last posted ${timeAgo(inc.teamsNotifiedAt)}`}><Badge tone="ok">posted to Teams</Badge></span>}
      {inc.model && a?.source === 'ai' && <span className="text-[11px] text-ink-faint">analysis by {inc.model}</span>}
    </>
  );

  return (
    <ModalShell
      size="xl"
      title={inc ? (inc.title || inc.host || '') : 'Incident'}
      subtitle={inc ? `${KIND_LABEL[inc.kind] || 'Host'} · ${inc.platforms.join(', ')} · opened ${timeAgo(inc.openedAt)} · ${inc.eventCount} alert${inc.eventCount === 1 ? '' : 's'} · id ${inc.id}` : null}
      badges={badges}
      icon={Bot} onClose={onClose}
      footer={inc && (
        <>
          {isOpen && inc.requiresHuman && (
            inc.acknowledgedAt
              ? (
                <button onClick={() => act('unack', 'Acknowledgement removed')} disabled={!!busy} className={footBtn}>
                  <BellOff size={13} /> Unacknowledge
                </button>
              ) : (
                <button onClick={() => act('ack', 'Incident acknowledged')} disabled={!!busy} className={footBtn}>
                  <Bell size={13} /> Acknowledge
                </button>
              )
          )}
          {isOpen && inc.requiresHuman && (
            <div className="relative">
              <button onClick={() => setSnoozeOpen((v) => !v)} disabled={!!busy} className={footBtn} aria-haspopup="menu" aria-expanded={snoozeOpen}>
                <Clock size={13} /> Snooze
              </button>
              {snoozeOpen && (
                <div role="menu" className="absolute bottom-full right-0 mb-1 w-40 rounded-lg border border-cohesity-border bg-surface-raised shadow-lg py-1 z-10">
                  {SNOOZE_DAYS.map((d) => (
                    <button key={d} role="menuitem" onClick={() => doSnooze(d)} className="block w-full text-left px-3 py-1.5 text-[13px] text-ink-muted hover:text-ink hover:bg-surface-overlay cursor-pointer">{fmtDays(d)}</button>
                  ))}
                  {snoozed && <button role="menuitem" onClick={() => doSnooze(0)} className="block w-full text-left px-3 py-1.5 text-[13px] text-brand hover:bg-surface-overlay cursor-pointer border-t border-cohesity-border">Clear snooze</button>}
                </div>
              )}
            </div>
          )}
          {isOpen && (
            <button onClick={() => setResolving(true)} disabled={!!busy} className={footBtn}>
              <CheckCircle2 size={13} /> Resolve
            </button>
          )}
          <button onClick={() => act('retriage', 'Triage re-run')} disabled={!!busy} className={footBtn}>
            <RefreshCw size={13} className={busy === 'retriage' ? 'animate-spin' : ''} /> Re-triage
          </button>
          <button onClick={() => act('resend', 'Email sent')} disabled={!!busy}
            className="flex items-center gap-1.5 text-[13px] font-medium px-3 py-1.5 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer">
            <Mail size={13} /> {inc.notifyCount ? 'Send again' : 'Send email'}
          </button>
        </>
      )}>
      {failed ? <p className="text-sm text-status-crit py-6 text-center">{failed}</p>
        : !inc ? <LoadingPanel label="Loading incident…" height={120} />
        : (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
              <div className="lg:col-span-3 min-w-0">
                {inc.triageError && <p className="text-xs text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded-md px-3 py-2 mb-3">{inc.triageError}</p>}
                {inc.teamsError && <p className="text-xs text-red-400 bg-red-400/10 border border-red-400/30 rounded-md px-3 py-2 mb-3">Teams post failed: {inc.teamsError}</p>}
                {inc.emailError && <p className="text-xs text-red-400 bg-red-400/10 border border-red-400/30 rounded-md px-3 py-2 mb-3">Email failed: {inc.emailError}</p>}
                {inc.baseline && !inc.emailTo && <p className="text-xs text-ink-faint mb-3">Found on the agent's first pass: a backlog that existed before the agent started, triaged and listed but not emailed. Use Send email if it should go out.</p>}
                {inc.resolution && (
                  <div className="mb-4 rounded-md border border-status-ok/30 bg-status-ok/10 px-3 py-2.5">
                    <p className="text-[11px] uppercase tracking-wide text-ink-faint mb-0.5">Resolution{inc.resolvedBy ? ` (${inc.resolvedBy})` : ''}</p>
                    <p className="text-[13px] text-ink">{inc.resolution}</p>
                  </div>
                )}
                {inc.state === 'clearing' && inc.clearedSince && <p className="text-xs text-ink-faint mb-3">Alerts cleared {timeAgo(inc.clearedSince)}; the incident closes itself if nothing fires again inside the quiet window.</p>}
                {inc.emailTo && <p className="text-xs text-ink-faint mb-3">Emailed {inc.notifyCount} time{inc.notifyCount === 1 ? '' : 's'} to {inc.emailTo}{inc.notifiedAt ? `, last ${timeAgo(inc.notifiedAt)}` : ''}.</p>}
                {inc.state === 'collecting' && !a && (
                  <p className="text-[13px] text-ink-muted mb-4">Collecting related alerts until {new Date(inc.holdUntil).toLocaleTimeString()}; triage runs when the hold window ends.</p>
                )}
                {a && (
                  <>
                    <Section title="What happened"><SummaryLines text={a.summary} className="text-ink" /></Section>
                    {a.impact && <Section title="Impact"><p className="text-[13px] text-ink-muted">{a.impact}</p></Section>}
                    {a.correlation && <Section title="Correlation"><p className="text-[13px] text-ink-muted">{a.correlation}</p></Section>}
                    {a.likely_cause && <Section title="Likely cause" borderClass={SEV_BORDER[sev] || 'border-cohesity-border'}><p className="text-[13px] text-ink">{a.likely_cause}</p></Section>}
                    {(a.next_steps || []).length > 0 && (
                      <Section title="Next steps for the next level">
                        <div className="space-y-2.5">
                          {a.next_steps.map((s, i) => (
                            <div key={i} className="rounded-md border border-cohesity-border bg-surface-overlay px-3 py-2.5">
                              <p className="mb-1"><span className="text-[11px] text-ink-faint mr-2">Step {i + 1}</span><span className="inline-block text-[11px] font-semibold text-brand bg-brand/10 border border-brand/30 rounded-full px-2 py-0.5">{s.owner}</span></p>
                              <p className="text-[13px] text-ink">{s.action}</p>
                            </div>
                          ))}
                        </div>
                      </Section>
                    )}
                    {a.escalate && <Section title="Escalation"><p className="text-[13px] text-ink-muted">{a.escalate}</p></Section>}
                    {a.human_reason && <Section title={a.human_required ? 'Why a human is required' : 'Why no human is needed'}><p className="text-[13px] text-ink-muted">{a.human_reason}</p></Section>}
                  </>
                )}
                {!a && inc.summary && <Section title="Summary"><SummaryLines text={inc.summary} className="text-ink-muted" /></Section>}
              </div>

              <div className="lg:col-span-2 min-w-0">
                <Section title="Facts">
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
                    <Fact label="State">{sm.label}</Fact>
                    <Fact label="Severity">{String(inc.severity).toUpperCase()}</Fact>
                    <Fact label="Kind">{KIND_LABEL[inc.kind] || 'Host'}</Fact>
                    <Fact label="Platforms">{inc.platforms.join(', ')}</Fact>
                    <Fact label="Host">{inc.host || '-'}</Fact>
                    <Fact label="Opened">{new Date(inc.openedAt).toLocaleString()}</Fact>
                    {inc.state === 'collecting' && <Fact label="Hold until">{new Date(inc.holdUntil).toLocaleString()}</Fact>}
                    <Fact label="Alerts">{inc.alerts.length} ({openAlerts} open, {inc.alerts.length - openAlerts} cleared)</Fact>
                    {inc.consequenceCount > 0 && <Fact label="Consequences">{inc.consequenceCount}</Fact>}
                    <Fact label="Emailed">{inc.notifyCount ? `${inc.notifyCount} time${inc.notifyCount === 1 ? '' : 's'}${inc.emailTo ? ` to ${inc.emailTo}` : ''}${inc.notifiedAt ? `, last ${new Date(inc.notifiedAt).toLocaleString()}` : ''}` : 'not yet'}</Fact>
                    <Fact label="Teams">{inc.teamsNotifiedAt ? `posted ${new Date(inc.teamsNotifiedAt).toLocaleString()}` : 'not posted'}</Fact>
                    <Fact label="Model">{inc.model || '-'}</Fact>
                    <Fact label="Incident id">{inc.id}</Fact>
                  </dl>
                </Section>

                {inc.requiresHuman && (
                  <div className="mb-4 rounded-lg border border-status-crit/40 bg-status-crit/10 p-4">
                    <p className="text-xs font-bold text-status-crit mb-1">Why this stays open</p>
                    <p className="text-[11px] text-ink-muted mb-2">
                      {agentName} does not close this incident, even when its alerts clear. It stays open until a person resolves it with a note.
                      {reminderHours > 0
                        ? ` Reminders go out every ${reminderHours} hour${reminderHours === 1 ? '' : 's'} until it is acknowledged or resolved.`
                        : ' Reminders are off.'}
                    </p>
                    {patternBursts.length > 0 ? (
                      <div className="overflow-x-auto">
                        <table className="w-full text-[11px]">
                          <thead><tr className="text-left text-ink-faint border-b border-cohesity-border"><th className="py-1 pr-3 font-semibold">Started</th><th className="py-1 pr-3 font-semibold">Lasted</th><th className="py-1 font-semibold">Peak</th></tr></thead>
                          <tbody>
                            {patternBursts.map((b, i) => (
                              <tr key={i} className="border-b border-cohesity-border/40 last:border-0">
                                <td className="py-1 pr-3 text-ink-muted whitespace-nowrap">{b.openedAt ? new Date(b.openedAt).toLocaleString() : '-'}</td>
                                <td className="py-1 pr-3 text-ink-muted tnum whitespace-nowrap">{fmtLasted(b.minutes)}</td>
                                <td className="py-1 text-ink-muted tnum">{b.peak != null ? `${fmtObs(b.peak, '')}${inc.evidence.pattern.unit || ''}` : '-'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : Array.isArray(inc.recurrence?.occurrences) && inc.recurrence.occurrences.length > 0 ? (
                      <div className="overflow-x-auto">
                        <table className="w-full text-[11px]">
                          <thead><tr className="text-left text-ink-faint border-b border-cohesity-border"><th className="py-1 pr-3 font-semibold">Opened</th><th className="py-1 pr-3 font-semibold">Lasted</th><th className="py-1 font-semibold">Closed by</th></tr></thead>
                          <tbody>
                            {inc.recurrence.occurrences.map((o) => (
                              <tr key={o.id} className="border-b border-cohesity-border/40 last:border-0">
                                <td className="py-1 pr-3 text-ink-muted whitespace-nowrap">{new Date(o.openedAt).toLocaleString()}</td>
                                <td className="py-1 pr-3 text-ink-muted tnum whitespace-nowrap">{fmtLasted(o.minutesOpen)}</td>
                                <td className="py-1 text-ink-muted">{o.closedBy}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                    {notes.length > 0 && (
                      <div className="mt-3">
                        <p className="text-[11px] uppercase tracking-wide text-ink-faint mb-1">Notes</p>
                        <ul className="space-y-1 text-[12px]">
                          {notes.map((n, i) => (
                            <li key={i} className="text-ink-muted">
                              <span className="text-ink-faint">{n.at ? new Date(n.at).toLocaleString() : ''} {n.by || ''} {n.kind || ''}:</span> {n.text}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {inc.recurrence?.isPattern && (
                  <div className="mb-4 rounded-lg border border-status-warn/40 bg-status-warn/10 p-4">
                    <p className="text-xs font-bold text-status-warn mb-1">This has happened {inc.recurrence.count} times in {inc.recurrence.windowDays} days</p>
                    <p className="text-[11px] text-ink-muted mb-2">
                      {inc.recurrence.typicalGapMinutes != null && (inc.recurrence.typicalGapMinutes >= 1440
                        ? `Roughly every ${(inc.recurrence.typicalGapMinutes / 1440).toFixed(1)} days. `
                        : inc.recurrence.typicalGapMinutes >= 60
                          ? `Roughly every ${(inc.recurrence.typicalGapMinutes / 60).toFixed(1)} hours. `
                          : `Roughly every ${inc.recurrence.typicalGapMinutes} minutes. `)}
                      {inc.recurrence.closedByAgent > 0 && `${inc.recurrence.closedByAgent} of the earlier ones closed on their own, so nobody was asked to look.`}
                    </p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-[11px]">
                        <thead><tr className="text-left text-ink-faint border-b border-cohesity-border"><th className="py-1 pr-3 font-semibold">Opened</th><th className="py-1 pr-3 font-semibold">Lasted</th><th className="py-1 pr-3 font-semibold">Closed by</th><th className="py-1 font-semibold">Resolution</th></tr></thead>
                        <tbody>
                          {inc.recurrence.occurrences.map((o) => (
                            <tr key={o.id} className="border-b border-cohesity-border/40 last:border-0">
                              <td className="py-1 pr-3 text-ink-muted whitespace-nowrap">{new Date(o.openedAt).toLocaleString()}</td>
                              <td className="py-1 pr-3 text-ink-muted tnum whitespace-nowrap">{o.minutesOpen == null ? 'still open' : o.minutesOpen >= 60 ? `${(o.minutesOpen / 60).toFixed(1)} h` : `${o.minutesOpen} min`}</td>
                              <td className="py-1 pr-3 text-ink-muted">{o.closedBy}</td>
                              <td className="py-1 text-ink-muted">{o.resolution || '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {inc.healActions?.length > 0 && (
                  <Section title={`What ${agentName} did`}>
                    <CollapsibleList className="text-ink-muted" items={inc.healActions}
                      render={(h) => `${new Date(h.at).toLocaleTimeString()}: ${h.action} ${h.target}: ${h.result}`} />
                  </Section>
                )}
                {a && (a.reviewed || []).length > 0 && (
                  <Section title={`What ${agentName} reviewed`}>
                    <CollapsibleList className="text-ink-muted" items={a.reviewed} render={(r) => r} />
                  </Section>
                )}
                {live?.results?.length > 0 && (
                  <Section title={`What ${agentName} checked live (from the ICC server)${live.results.some((c) => c.requestedBy === 'model') ? ' (asked for by the agent)' : ''}`}>
                    <CollapsibleList items={live.results} className="text-ink-muted"
                      render={(c) => (
                        <>
                          <span className={c.ok ? 'text-status-ok font-semibold' : 'text-status-crit font-semibold'}>{c.ok ? 'OK' : 'FAILED'}</span>{' '}
                          {c.label || c.capability} on {c.target?.name}{c.target?.address && c.target.address !== c.target.name ? <span className="text-ink-faint"> ({c.target.address})</span> : null}: {c.summary}
                          {c.requestedBy === 'model' && c.reason ? <span className="block text-[11px] text-ink-faint">Asked for by the agent: {c.reason}</span> : null}
                        </>
                      )} />
                    {live.unresolved?.length > 0 && <p className="text-[11px] text-ink-faint mt-2">Not checked, no stored address: {live.unresolved.join('; ')}.</p>}
                  </Section>
                )}
                {observedEpisodes.length > 0 && (
                  <Section title={`What ${agentName} observed`}>
                    <div className="space-y-2">
                      {observedEpisodes.map((ep, i) => (
                        <div key={ep.id ?? i} role="button" tabIndex={0} title="Open the observation"
                          onClick={() => ep.id != null && onOpenObservation?.(ep.id)}
                          onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && ep.id != null) { e.preventDefault(); onOpenObservation?.(ep.id); } }}
                          className="flex items-center gap-3 rounded-md border border-cohesity-border bg-surface-overlay px-3 py-2 cursor-pointer hover:ring-1 hover:ring-brand/50 focus:ring-1 focus:ring-brand/50 outline-none">
                          <div className="min-w-0 flex-1">
                            <p className="text-[13px] text-ink truncate">{ep.label} <span className="text-ink-muted">{ep.subject}</span></p>
                            <p className="text-[11px] text-ink-faint">{ep.detail ? obsDetailLine(ep.detail) : `${obsDetailLine(ep)}, elevated ${fmtMinutes(ep.minutes)}`}</p>
                          </div>
                          <Badge tone={OBS_STATE_TONE[ep.state] || 'neutral'}>{ep.state}</Badge>
                          <Sparkline values={obsValues(ep.series)} color={OBS_SPARK[ep.state] || OBS_SPARK.watching} width={90} height={22} fill={false} />
                        </div>
                      ))}
                    </div>
                    {observedHistory.length > 0 && (
                      <CollapsibleList className="text-ink-muted mt-2" items={observedHistory} limit={4}
                        render={(h) => `${h.subject}: ${h.label || h.observerId} ${h.outcome || 'closed'}${h.minutes != null ? ` after ${fmtMinutes(h.minutes)}` : ''}${h.peak != null ? `, peak ${fmtObs(h.peak, '')}` : ''}${h.closedAt ? `, closed ${timeAgo(h.closedAt)}` : ''}`} />
                    )}
                  </Section>
                )}
                {Array.isArray(inc.evidence?.relations) && inc.evidence.relations.length > 0 && (
                  <Section title="How these systems connect">
                    <CollapsibleList className="text-ink-muted" items={inc.evidence.relations.map(String)} render={(l) => l} />
                  </Section>
                )}
                {Array.isArray(inc.evidence?.timeline) && inc.evidence.timeline.length > 0 && (
                  <Section title="Timeline">
                    <CollapsibleList className="text-ink-muted" items={inc.evidence.timeline} limit={8}
                      render={(t) => (
                        <>
                          <span className="text-ink-faint">{new Date(t.at).toLocaleString()}</span>{' '}
                          <span className="inline-block px-1.5 rounded border border-cohesity-border text-[11px] text-ink-faint align-middle">{t.platform}</span>{' '}
                          {t.text}
                        </>
                      )} />
                  </Section>
                )}
                {networkBlocks.map((n, ni) => (
                  <Section key={`net-${ni}`} title={n.title || 'Network'}>
                    <CollapsibleList className="text-ink-muted" items={n.lines.map(String)} render={(l) => l} />
                  </Section>
                ))}
                {live && !live.ran && live.skipped && !/switched on/.test(live.skipped) && (
                  <p className="text-xs text-ink-faint mb-4">Live checks did not run: {live.skipped}.</p>
                )}
              </div>
            </div>

            <Section title={`Alerts in this incident (${inc.alerts.length})`}>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="text-left text-[10px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                    <th className="py-1.5 pr-3">Platform</th><th className="py-1.5 pr-3">Severity</th><th className="py-1.5 pr-3">Host</th><th className="py-1.5 pr-3">Alert</th><th className="py-1.5 pr-3">Since</th><th className="py-1.5">State</th>
                  </tr></thead>
                  <tbody>
                    <AlertRows alerts={inc.alerts} />
                  </tbody>
                </table>
              </div>
            </Section>
          </>
        )}
      {resolving && inc && (
        <ResolveNoteDialog required={!!inc.requiresHuman} busy={busy === 'resolve'} onSubmit={doResolve} onCancel={() => setResolving(false)} />
      )}
    </ModalShell>
  );
}

function relationHeading(al) {
  if (al.relation === 'shared') {
    const [kind, ...rest] = String(al.relationOf || '').split(':');
    return `Shared on ${kind} ${rest.join(':')}`.trim();
  }
  return null;
}

function AlertRows({ alerts }) {
  const renderRow = (al, i) => (
    <tr key={`${al.relationOf || 'direct'}-${i}`} className="border-b border-cohesity-border/40 align-top">
      <td className="py-1.5 pr-3 text-ink">{al.platformLabel}</td>
      <td className="py-1.5 pr-3"><Badge tone={sevTone(al.severity)}>{al.severity}</Badge></td>
      <td className="py-1.5 pr-3 text-ink-muted whitespace-nowrap">{al.host || '-'}</td>
      <td className="py-1.5 pr-3 text-ink-muted">{al.relation && <span className="mr-1.5 inline-block px-1.5 rounded border border-status-warn/40 text-[10px] text-status-warn align-middle">{al.relation}</span>}{isObservationAlert(al) && <span className="mr-1.5 inline-block px-1.5 rounded border border-status-info/40 text-[10px] text-status-info align-middle">observation</span>}<AlertMessage text={al.message} /></td>
      <td className="py-1.5 pr-3 text-ink-faint tnum whitespace-nowrap">{al.firstSeen ? <span title={timeAgo(al.firstSeen)}>{new Date(al.firstSeen).toLocaleString()}</span> : '-'}</td>
      <td className="py-1.5">{al.clearedAt ? <Badge tone="neutral">cleared</Badge> : <Badge tone="ok">open</Badge>}</td>
    </tr>
  );
  const direct = alerts.map((al, i) => [al, i]).filter(([al]) => !al.relation);
  const groups = new Map();
  alerts.forEach((al, i) => {
    if (!al.relation) return;
    const key = `${al.relation}|${al.relationOf || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push([al, i]);
  });
  return (
    <>
      {direct.map(([al, i]) => renderRow(al, i))}
      {[...groups.entries()].map(([key, list]) => {
        const first = list[0][0];
        const title = first.relation === 'shared'
          ? `${relationHeading(first)} (${list.length})`
          : `Consequences (${list.length}) of ${first.relationOf || 'the parent'}`;
        return (
          <Fragment key={key}>
            <tr className="bg-cohesity-border/20"><td colSpan={6} className="py-1.5 px-2 text-[11px] font-semibold text-ink-muted">{title}</td></tr>
            {list.map(([al, i]) => renderRow(al, i))}
          </Fragment>
        );
      })}
    </>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div className="panel px-4 py-3">
      <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
      <p className={`text-xl font-semibold tnum ${tone || 'text-ink'}`}>{value}</p>
    </div>
  );
}

export default function OpsAgentPage() {
  const { toast } = useToast();
  const [status, setStatus] = useState(null);
  const [rows, setRows] = useState(null);
  const [scope, setScope] = useState('open');
  const [obsOpenId, setObsOpenId] = useState(null);
  const [watchOpen, setWatchOpen] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  // ?incident=<id> (the Open in ICC link on a Teams card) opens that incident.
  const [params] = useSearchParams();
  const [openId, setOpenId] = useState(() => { const n = Number(params.get('incident')); return Number.isInteger(n) && n > 0 ? n : null; });
  const [running, setRunning] = useState(false);
  const [pulse, setPulse] = useState('');
  const pulseRef = useRef(null);
  const [live, setLive] = useState(true);

  const load = useCallback(() => Promise.allSettled([
    client.get('/ops-agent/status'),
    client.get('/ops-agent/incidents', { params: scope === 'needs' ? { state: 'open', needsHuman: 1, limit: 300 } : { state: scope, limit: 300 } }),
  ]).then(([s, i]) => {
    if (s.status === 'fulfilled') setStatus(s.value.data);
    if (i.status === 'fulfilled') setRows(i.value.data); else setRows([]);
    setLastRefreshed(new Date());
  }), [scope]);

  // A hidden tab does no work at all; coming back refreshes immediately.
  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [load]);

  // Live updates without a socket: poll a tiny token and only refetch when the
  // agent has actually changed something (a tick, a triage, an email, a close).
  useEffect(() => {
    let alive = true;
    const probe = async () => {
      if (document.hidden) return;
      try {
        const { data } = await client.get('/ops-agent/pulse');
        if (!alive) return;
        setLive(true);
        if (pulseRef.current === null) { pulseRef.current = data.token; return; }
        if (data.token !== pulseRef.current) {
          pulseRef.current = data.token;
          setPulse(data.token);
          load();
        }
      } catch {
        if (alive) setLive(false);
      }
    };
    const t = setInterval(probe, PULSE_MS);
    return () => { alive = false; clearInterval(t); };
  }, [load]);

  const runNow = async () => {
    setRunning(true);
    try {
      const { data } = await client.post('/ops-agent/run');
      const st = data.stats;
      toast({ type: 'success', title: 'Agent tick ran', message: st ? `${st.alertsSeen} alerts seen, ${st.newAlerts} new, ${st.incidentsOpened} incident${st.incidentsOpened === 1 ? '' : 's'} opened, ${st.triaged} triaged, ${st.emailsSent} email${st.emailsSent === 1 ? '' : 's'} sent.` : 'Another tick was already running.' });
      load();
    } catch (e) {
      toast({ type: 'error', title: 'Run failed', message: e?.response?.data?.error || 'Try again.' });
    } finally { setRunning(false); }
  };

  const list = useMemo(() => (rows || []).map((r) => ({ ...r, platformsLabel: r.platforms.join(', '), idLabel: '#' + r.id, stateKey: r.state })), [rows]);
  const ctl = useTableControls(list, { searchKeys: ['idLabel', 'title', 'host', 'platformsLabel', 'classification', 'summary', 'stateKey'], defaultSortKey: 'openedAt', defaultSortDir: 'desc', paginate: true });
  const s = status;
  const counts = s?.counts || {};

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Bot} title={s?.settings?.name || 'Operations Agent'} description="Folds open alerts, app service state and unreachable sources into incidents, re-polls what it can, triages each against the evidence ICC holds and emails the analysis. It also watches polled metrics: a VM or host over its line is watched quietly and becomes an incident only if the condition holds or keeps coming back.">
        <span className={`inline-flex items-center gap-1.5 text-[11px] ${live ? 'text-status-ok' : 'text-status-warn'}`} title={live ? `Watching for changes every ${PULSE_MS / 1000}s` : 'Lost contact with ICC; retrying'}>
          <span className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-status-ok animate-pulse' : 'bg-status-warn'}`} />
          {live ? 'Live' : 'Reconnecting'}
        </span>
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <button onClick={runNow} disabled={running}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50 cursor-pointer">
          <Play size={13} /> {running ? 'Running…' : 'Run now'}
        </button>
        <Link to="/admin/agent" className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors">
          <Settings size={13} /> Settings
        </Link>
        <button onClick={load} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer">
          <RefreshCw size={13} /> Refresh
        </button>
      </PageHeader>

      {s && (
        <div className="flex items-center gap-2 mb-4 flex-wrap text-[11px]">
          <WorkerChip worker={s.worker} />
          <Badge tone={s.settings.enabled ? 'ok' : 'crit'}>{s.settings.enabled ? 'Agent on' : 'Agent off'}</Badge>
          <Badge tone={s.aiConfigured ? 'ok' : 'crit'}>{s.aiConfigured ? `AI: ${s.aiProvider}${s.aiModel ? ` / ${s.aiModel}` : ''}` : 'AI not configured: the agent is idle'}</Badge>
          <Badge tone={s.smtpReady && s.settings.emailEnabled ? 'ok' : 'warn'}>{!s.settings.emailEnabled ? 'Email off' : s.smtpReady ? 'SMTP ready' : 'SMTP not configured'}</Badge>
          <TickChip startedAt={s.tickStartedAt} />
          <LastTickChip lastRun={s.lastRun} />
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-7 gap-3 mb-4">
        <Stat label="Collecting" value={counts.collecting || 0} tone="text-status-info" />
        <button type="button" onClick={() => setWatchOpen(true)} className="block text-left cursor-pointer rounded-lg hover:ring-1 hover:ring-brand/50 focus:ring-1 focus:ring-brand/50 outline-none" title="Episodes over their line that are not incidents yet. Click to see them."><Stat label="Watching" value={counts.watching || 0} tone="text-status-info" /></button>
        <span className="block" title="Incidents that stay open until a person looks: not acknowledged and not snoozed"><Stat label="Awaiting investigation" value={counts.awaitingHuman || 0} tone={counts.awaitingHuman > 0 ? 'text-status-crit' : undefined} /></span>
        <Stat label="Triaged, not emailed" value={counts.triaged || 0} tone="text-status-warn" />
        <Stat label="Notified" value={counts.notified || 0} tone="text-status-ok" />
        <Stat label="Resolved (24h)" value={counts.resolved24h || 0} />
        <Stat label="Emails (24h)" value={counts.emails24h || 0} />
      </div>

      <Panel title="Incidents" icon={Bot}>
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          {['open', 'needs', 'resolved', 'all'].map((k) => (
            <button key={k} onClick={() => setScope(k)}
              className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors cursor-pointer ${scope === k ? 'bg-brand/15 border-brand/40 text-brand' : 'border-cohesity-border text-ink-muted hover:text-ink'}`}>
              {k === 'open' ? 'Open' : k === 'needs' ? 'Needs a person' : k === 'resolved' ? 'Resolved' : 'All'}
            </button>
          ))}
          <input value={ctl.q} onChange={(e) => ctl.setQ(e.target.value)} placeholder="Filter by id, title, host, platform, classification..."
            className="ml-auto bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-1.5 text-xs text-ink focus:border-brand/60 outline-none w-72 max-w-full" />
        </div>
        {rows == null ? <LoadingPanel label="Loading incidents…" height={140} />
          : ctl.rows.length === 0 ? <p className="text-sm text-ink-muted py-6 text-center">{s?.settings?.enabled ? 'No incidents in this view.' : 'The agent is off. Turn it on under Settings, or press Run now for a one-off pass.'}</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <SortTh k="id" label="ID" ctl={ctl} />
                  <SortTh k="stateKey" label="State" ctl={ctl} />
                  <SortTh k="impactScore" label="Severity" ctl={ctl} />
                  <SortTh k="title" label="Incident" ctl={ctl} />
                  <SortTh k="platformsLabel" label="Platforms" ctl={ctl} />
                  <SortTh k="eventCount" label="Alerts" ctl={ctl} align="right" />
                  <SortTh k="classification" label="Classification" ctl={ctl} />
                  <SortTh k="openedAt" label="Opened" ctl={ctl} />
                  <SortTh k="notifiedAt" label="Emailed" ctl={ctl} />
                </tr></thead>
                <tbody>
                  {ctl.pageRows.map((r) => {
                    const sm = STATE_META[r.state] || STATE_META.collecting;
                    return (
                      <tr key={r.id} className="border-b border-cohesity-border/50">
                        <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">#{r.id}</td>
                        <td className="py-2 pr-3"><Badge tone={sm.tone}>{sm.label}</Badge></td>
                        <td className="py-2 pr-3"><Badge tone={sevTone(r.severity)}>{String(r.severity).toUpperCase()}</Badge></td>
                        <td className="py-2 pr-3 max-w-[360px]">
                          <button onClick={() => setOpenId(r.id)} className="text-brand hover:underline cursor-pointer text-left">{r.title || r.host || r.key}</button>
                          {r.kind === 'pattern' && r.occurrences > 1 && <span className="ml-1.5 text-[10px] font-semibold text-status-warn tnum" title={`${r.occurrences} bursts so far`}>x{r.occurrences}</span>}
                          {r.awaitingHuman && <span className="ml-1.5"><Badge tone="crit">awaiting investigation</Badge></span>}
                          {r.acknowledgedAt && <span className="ml-1.5" title={new Date(r.acknowledgedAt).toLocaleString()}><Badge tone="warn">acknowledged by {r.acknowledgedBy || 'a user'}</Badge></span>}
                          {r.snoozed && r.snoozedUntil && <span className="ml-1.5" title={new Date(r.snoozedUntil).toLocaleString()}><Badge tone="neutral">snoozed until {new Date(r.snoozedUntil).toLocaleDateString()}</Badge></span>}
                          <span className="ml-1.5 text-[10px] text-ink-faint">{KIND_LABEL[r.kind] || ''}{r.humanRequired ? ' · human required' : ''}</span>
                          {r.isPattern && <span className="ml-1.5 text-[10px] font-semibold text-status-warn" title={`The same incident has opened ${r.repeatCount} times inside the repeat window. The repetition is the thing to investigate.`}>repeat {r.repeatCount}x</span>}
                          {r.summary && <p className="text-[11px] text-ink-faint line-clamp-1" title={r.summary}>{r.summary.split('\n').filter(Boolean).join('; ')}</p>}
                        </td>
                        <td className="py-2 pr-3 text-ink-muted text-[11px]">{r.platformsLabel}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{r.eventCount}</td>
                        <td className="py-2 pr-3">{r.classification ? <Badge tone={CLASS_TONE[r.classification] || 'neutral'}>{r.classification}</Badge> : <span className="text-ink-faint text-xs">—</span>}{r.baseline && <span className="ml-1 text-[10px] text-ink-faint">baseline</span>}</td>
                        <td className="py-2 pr-3 text-ink-muted tnum text-[11px] whitespace-nowrap">{timeAgo(r.openedAt)}</td>
                        <td className="py-2 pr-3 text-ink-muted tnum text-[11px] whitespace-nowrap">{r.notifyCount > 0 && r.notifiedAt ? `${timeAgo(r.notifiedAt)}${r.notifyCount > 1 ? ` (x${r.notifyCount})` : ''}` : r.emailError ? <span className="text-status-crit">failed</span> : r.baseline ? 'not sent (baseline)' : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        <TablePager ctl={ctl} />
      </Panel>

      {watchOpen && <WatchListModal Shell={ModalShell} pulse={pulse} onClose={() => setWatchOpen(false)} onOpenObservation={setObsOpenId} />}
      {obsOpenId != null && <ObservationModal id={obsOpenId} Shell={ModalShell} onClose={() => setObsOpenId(null)} />}
      {openId != null && <IncidentModal id={openId} onClose={() => setOpenId(null)} onChanged={load} pulse={pulse} agentName={s?.settings?.name || 'ICC'} onOpenObservation={setObsOpenId} reminderHours={Number(s?.settings?.reminderHours) || 0} />}
    </div>
  );
}
