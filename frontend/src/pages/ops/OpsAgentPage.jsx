import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Bot, X, Mail, RefreshCw, CheckCircle2, Play, Settings } from 'lucide-react';
import client from '../../api/client';
import { PageHeader, Panel, Badge, LoadingPanel, RefreshButton, LastUpdated, timeAgo } from '../../components/ui/primitives';
import { useToast } from '../../components/ui/Toaster';
import { useTableControls, SortTh, TablePager } from '../../components/ui/tableTools';

const REFRESH_MS = 60_000;
const STATE_META = {
  collecting: { label: 'Collecting', tone: 'info', hint: 'Holding for related alerts before triage' },
  triaged: { label: 'Triaged', tone: 'warn', hint: 'Analysis written, email pending or off' },
  notified: { label: 'Notified', tone: 'ok', hint: 'Analysis emailed' },
  resolved: { label: 'Resolved', tone: 'neutral', hint: 'Every alert cleared or closed by hand' },
};
const CLASS_TONE = { incident: 'crit', recurring: 'warn', 'one-off': 'info', noise: 'neutral', 'self-cleared': 'neutral' };
const sevTone = (s) => (s === 'critical' ? 'crit' : s === 'error' || s === 'warning' ? 'warn' : 'info');

function ModalShell({ title, subtitle, icon: Icon, onClose, children, footer }) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative panel w-full max-w-3xl max-h-[88vh] flex flex-col border-t-2 border-brand">
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
        {footer && <div className="p-4 pt-3 border-t border-cohesity-border flex items-center justify-end gap-2 flex-wrap">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

const Section = ({ title, children }) => (
  <div className="mb-4">
    <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-1">{title}</p>
    {children}
  </div>
);

function IncidentModal({ id, onClose, onChanged }) {
  const [inc, setInc] = useState(null);
  const [failed, setFailed] = useState(null);
  const [busy, setBusy] = useState(null);
  const { toast } = useToast();

  const load = useCallback(() => client.get(`/ops-agent/incidents/${id}`)
    .then(({ data }) => setInc(data))
    .catch((e) => setFailed(e?.response?.data?.error || 'Failed to load incident.')), [id]);
  useEffect(() => { load(); }, [load]);

  const act = async (verb, label) => {
    setBusy(verb);
    try {
      const { data } = await client.post(`/ops-agent/incidents/${id}/${verb}`);
      setInc(data);
      onChanged?.();
      toast({ type: 'success', title: label });
    } catch (e) {
      toast({ type: 'error', title: `${label} failed`, message: e?.response?.data?.error || 'Try again.' });
    } finally { setBusy(null); }
  };

  const a = inc?.analysis;
  const sm = inc ? (STATE_META[inc.state] || STATE_META.collecting) : null;
  return (
    <ModalShell
      title={inc ? `#${inc.id} ${inc.title || inc.host || ''}` : 'Incident'}
      subtitle={inc ? `${inc.platforms.join(', ')} · opened ${timeAgo(inc.openedAt)} · ${inc.eventCount} alert${inc.eventCount === 1 ? '' : 's'}` : null}
      icon={Bot} onClose={onClose}
      footer={inc && (
        <>
          {inc.state !== 'resolved' && (
            <button onClick={() => act('resolve', 'Incident resolved')} disabled={!!busy}
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink transition-colors disabled:opacity-50 cursor-pointer">
              <CheckCircle2 size={13} /> Resolve
            </button>
          )}
          <button onClick={() => act('retriage', 'Triage re-run')} disabled={!!busy}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink transition-colors disabled:opacity-50 cursor-pointer">
            <RefreshCw size={13} className={busy === 'retriage' ? 'animate-spin' : ''} /> Re-triage
          </button>
          <button onClick={() => act('resend', 'Email sent')} disabled={!!busy}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer">
            <Mail size={13} /> {inc.notifyCount ? 'Send again' : 'Send email'}
          </button>
        </>
      )}>
      {failed ? <p className="text-sm text-status-crit py-6 text-center">{failed}</p>
        : !inc ? <LoadingPanel label="Loading incident…" height={120} />
        : (
          <>
            <div className="flex items-center gap-2 mb-4 flex-wrap">
              <Badge tone={sm.tone}>{sm.label}</Badge>
              <Badge tone={sevTone(inc.severity)}>{String(inc.severity).toUpperCase()}</Badge>
              {inc.classification && <Badge tone={CLASS_TONE[inc.classification] || 'neutral'}>{inc.classification}{inc.confidence ? ` · ${inc.confidence} confidence` : ''}</Badge>}
              {a?.source === 'fallback' && <Badge tone="warn">rule-based digest</Badge>}
              {inc.baseline && <Badge tone="neutral">baseline</Badge>}
              {inc.model && a?.source === 'ai' && <span className="text-[11px] text-ink-faint">analysis by {inc.model}</span>}
            </div>
            {inc.triageError && <p className="text-[11px] text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded-md px-2.5 py-1.5 mb-3">{inc.triageError}</p>}
            {inc.emailError && <p className="text-[11px] text-red-400 bg-red-400/10 border border-red-400/30 rounded-md px-2.5 py-1.5 mb-3">Email failed: {inc.emailError}</p>}
            {inc.baseline && !inc.emailTo && <p className="text-[11px] text-ink-faint mb-3">Found on the agent's first pass: a backlog that existed before the agent started, triaged and listed but not emailed. Use Send email if it should go out.</p>}
            {inc.emailTo && <p className="text-[11px] text-ink-faint mb-3">Emailed {inc.notifyCount} time{inc.notifyCount === 1 ? '' : 's'} to {inc.emailTo}{inc.notifiedAt ? `, last ${timeAgo(inc.notifiedAt)}` : ''}.</p>}

            {inc.state === 'collecting' && !a && (
              <p className="text-sm text-ink-muted mb-4">Collecting related alerts until {new Date(inc.holdUntil).toLocaleTimeString()}; triage runs when the hold window ends.</p>
            )}
            {a && (
              <>
                <Section title="What happened"><p className="text-sm text-ink">{a.summary}</p></Section>
                {a.impact && <Section title="Impact"><p className="text-sm text-ink-muted">{a.impact}</p></Section>}
                {a.correlation && <Section title="Correlation"><p className="text-sm text-ink-muted">{a.correlation}</p></Section>}
                <Section title="What ICC reviewed">
                  <ul className="list-disc pl-5 text-sm text-ink-muted space-y-0.5">{(a.reviewed || []).map((r, i) => <li key={i}>{r}</li>)}</ul>
                </Section>
                {a.likely_cause && <Section title="Likely cause"><p className="text-sm text-ink">{a.likely_cause}</p></Section>}
                <Section title="Next steps for the next level">
                  <ol className="list-decimal pl-5 text-sm text-ink space-y-1">
                    {(a.next_steps || []).map((s, i) => <li key={i}><span className="text-brand font-semibold">{s.owner}</span>: {s.action}</li>)}
                  </ol>
                </Section>
                {a.escalate && <Section title="Escalation"><p className="text-sm text-ink-muted">{a.escalate}</p></Section>}
              </>
            )}
            {!a && inc.summary && <Section title="Summary"><p className="text-sm text-ink-muted">{inc.summary}</p></Section>}

            <Section title={`Alerts in this incident (${inc.alerts.length})`}>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="text-left text-[10px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                    <th className="py-1.5 pr-3">Platform</th><th className="py-1.5 pr-3">Severity</th><th className="py-1.5 pr-3">Host</th><th className="py-1.5 pr-3">Alert</th><th className="py-1.5 pr-3">Since</th><th className="py-1.5">State</th>
                  </tr></thead>
                  <tbody>
                    {inc.alerts.map((al, i) => (
                      <tr key={i} className="border-b border-cohesity-border/40">
                        <td className="py-1.5 pr-3 text-ink">{al.platformLabel}</td>
                        <td className="py-1.5 pr-3"><Badge tone={sevTone(al.severity)}>{al.severity}</Badge></td>
                        <td className="py-1.5 pr-3 text-ink-muted">{al.host || '—'}</td>
                        <td className="py-1.5 pr-3 text-ink-muted max-w-[320px]"><span className="line-clamp-2" title={al.message}>{al.message}</span></td>
                        <td className="py-1.5 pr-3 text-ink-faint tnum whitespace-nowrap">{al.firstSeen ? timeAgo(al.firstSeen) : '—'}</td>
                        <td className="py-1.5">{al.clearedAt ? <Badge tone="neutral">cleared</Badge> : <Badge tone="ok">open</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          </>
        )}
    </ModalShell>
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
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(() => Promise.allSettled([
    client.get('/ops-agent/status'),
    client.get('/ops-agent/incidents', { params: { state: scope, limit: 300 } }),
  ]).then(([s, i]) => {
    if (s.status === 'fulfilled') setStatus(s.value.data);
    if (i.status === 'fulfilled') setRows(i.value.data); else setRows([]);
    setLastRefreshed(new Date());
  }), [scope]);

  useEffect(() => { load(); const t = setInterval(load, REFRESH_MS); return () => clearInterval(t); }, [load]);

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

  const list = (rows || []).map((r) => ({ ...r, platformsLabel: r.platforms.join(', ') }));
  const ctl = useTableControls(list, { searchKeys: ['title', 'host', 'platformsLabel', 'classification', 'summary'], defaultSortKey: 'openedAt', defaultSortDir: 'desc', paginate: true });
  const s = status;
  const counts = s?.counts || {};

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Bot} title={s?.settings?.name || 'Operations Agent'} description="Folds open alerts into incidents, triages each one against the evidence ICC holds, and emails the analysis with next steps">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <button onClick={runNow} disabled={running}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50 cursor-pointer">
          <Play size={13} /> {running ? 'Running…' : 'Run now'}
        </button>
        <Link to="/admin/agent" className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors">
          <Settings size={13} /> Settings
        </Link>
        <RefreshButton onClick={load} />
      </PageHeader>

      {s && (
        <div className="flex items-center gap-2 mb-4 flex-wrap text-[11px]">
          <Badge tone={s.settings.enabled ? 'ok' : 'crit'}>{s.settings.enabled ? 'Agent on' : 'Agent off'}</Badge>
          <Badge tone={s.aiConfigured ? 'ok' : 'warn'}>{s.aiConfigured ? `AI: ${s.aiProvider}${s.aiModel ? ` / ${s.aiModel}` : ''}` : 'AI not configured: rule-based digests only'}</Badge>
          <Badge tone={s.smtpReady && s.settings.emailEnabled ? 'ok' : 'warn'}>{!s.settings.emailEnabled ? 'Email off' : s.smtpReady ? 'SMTP ready' : 'SMTP not configured'}</Badge>
          <span className="text-ink-faint">Hold {s.settings.holdMinutes} min · minimum {s.settings.minSeverity} · {s.settings.analysesPerHour}/h triage cap · recipients {s.settings.recipients || (s.defaultRecipients ? 'per platform, default ' + s.defaultRecipients : 'per platform')}</span>
          <span className="text-ink-faint">{s.lastRun ? `Last tick ${timeAgo(s.lastRun.at)}: ${s.lastRun.alertsSeen} alerts seen, ${s.lastRun.newAlerts} new${s.lastRun.error ? `, error: ${s.lastRun.error}` : ''}` : 'No tick yet'}</span>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <Stat label="Collecting" value={counts.collecting || 0} tone="text-status-info" />
        <Stat label="Triaged, not emailed" value={counts.triaged || 0} tone="text-status-warn" />
        <Stat label="Notified" value={counts.notified || 0} tone="text-status-ok" />
        <Stat label="Resolved (24h)" value={counts.resolved24h || 0} />
        <Stat label="Emails (24h)" value={counts.emails24h || 0} />
      </div>

      <Panel title="Incidents" icon={Bot}>
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          {['open', 'resolved', 'all'].map((k) => (
            <button key={k} onClick={() => setScope(k)}
              className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors cursor-pointer ${scope === k ? 'bg-brand/15 border-brand/40 text-brand' : 'border-cohesity-border text-ink-muted hover:text-ink'}`}>
              {k === 'open' ? 'Open' : k === 'resolved' ? 'Resolved' : 'All'}
            </button>
          ))}
          <input value={ctl.q} onChange={(e) => ctl.setQ(e.target.value)} placeholder="Filter by title, host, platform, classification…"
            className="ml-auto bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-1.5 text-xs text-ink focus:border-brand/60 outline-none w-72 max-w-full" />
        </div>
        {rows == null ? <LoadingPanel label="Loading incidents…" height={140} />
          : ctl.rows.length === 0 ? <p className="text-sm text-ink-muted py-6 text-center">{s?.settings?.enabled ? 'No incidents in this view.' : 'The agent is off. Turn it on under Settings, or press Run now for a one-off pass.'}</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <SortTh k="state" label="State" ctl={ctl} />
                  <SortTh k="severity" label="Severity" ctl={ctl} />
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
                        <td className="py-2 pr-3"><Badge tone={sm.tone}>{sm.label}</Badge></td>
                        <td className="py-2 pr-3"><Badge tone={sevTone(r.severity)}>{String(r.severity).toUpperCase()}</Badge></td>
                        <td className="py-2 pr-3 max-w-[360px]">
                          <button onClick={() => setOpenId(r.id)} className="text-brand hover:underline cursor-pointer text-left">#{r.id} {r.title || r.host || r.key}</button>
                          {r.summary && <p className="text-[11px] text-ink-faint line-clamp-1" title={r.summary}>{r.summary}</p>}
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

      {openId != null && <IncidentModal id={openId} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  );
}
