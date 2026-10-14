// Shared AI Advisor page: a compact report rail on the left (one row per
// preset with its last-run age) and the selected report rendered inline in
// a full-width reading pane. Replaced the tile-grid + modal layout
// 2026-10-05 (Doug: tiles were huge, reports cramped). The selected report
// rides in the URL (?report=) so links land on the right one.
import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { Sparkles, Clock, Mail, X } from 'lucide-react';
import client from '../api/client';
import Markdown from './Markdown';
import { PageHeader, LoadingPanel } from './ui/primitives';

function timeAgo(ts) {
  if (!ts) return null;
  const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function fmtTime(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

const StaleChip = () => (
  <span className="text-amber-400 border border-amber-400/40 bg-amber-400/10 rounded px-1 py-px text-[10px] font-semibold uppercase tracking-wide">Stale</span>
);

/** Ad-hoc send of the current report via the configured alert SMTP server
 *  (user-clicked only, never scheduled). Portaled to body per the overlay
 *  contract. */
function EmailModal({ basePath, slug, label, onClose }) {
  const [recipients, setRecipients] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null); // { ok, text }
  const send = async () => {
    setSending(true);
    setResult(null);
    try {
      const { data } = await client.post(`${basePath}/${slug}/email`, recipients.trim() ? { recipients: recipients.trim() } : {});
      setResult({ ok: true, text: `Sent to ${data.to}.` });
    } catch (e) {
      setResult({ ok: false, text: e.response?.data?.error || 'Send failed.' });
    } finally {
      setSending(false);
    }
  };
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="panel p-4 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-2 mb-2">
          <div>
            <p className="text-sm font-semibold text-ink">Email this report</p>
            <p className="text-[11px] text-ink-faint">{label} - sends the current generated text via the alert SMTP server</p>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer">
            <X size={14} />
          </button>
        </div>
        <label className="block text-[11px] text-ink-muted mb-1">Recipients (comma separated)</label>
        <input value={recipients} onChange={(e) => setRecipients(e.target.value)} spellCheck={false}
          placeholder="Blank sends to the default alert recipients"
          className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none mb-3" />
        {result && (
          <p className={`text-xs mb-3 ${result.ok ? 'text-status-ok' : 'text-red-400'}`}>{result.text}</p>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="text-xs px-3 py-2 rounded-lg border border-cohesity-border text-ink-muted hover:text-ink cursor-pointer">
            {result?.ok ? 'Close' : 'Cancel'}
          </button>
          <button onClick={send} disabled={sending}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer">
            <Mail size={13} /> {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default function PlatformAdvisorPage({ platform, brand, title = 'AI Advisor', tabs }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [states, setStates] = useState({}); // slug -> { enabled, report }
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [emailOpen, setEmailOpen] = useState(false);

  const basePath = `/${platform}/advisor`;
  const rawSlug = searchParams.get('report') || tabs[0]?.slug;
  const active = tabs.find((t) => t.slug === rawSlug) || tabs[0];

  const selectReport = (slug) => {
    setError(null);
    const next = new URLSearchParams(searchParams);
    next.set('report', slug);
    setSearchParams(next, { replace: true });
  };

  const loadOne = useCallback(async (slug) => {
    try {
      const { data } = await client.get(`${basePath}/${slug}`);
      setStates((s) => ({ ...s, [slug]: { enabled: data.enabled, report: data.report || null } }));
    } catch {
      setStates((s) => ({ ...s, [slug]: { enabled: true, report: null } }));
    }
  }, [basePath]);

  useEffect(() => { tabs.forEach((t) => loadOne(t.slug)); }, [loadOne, tabs]);

  const run = useCallback(async () => {
    if (!active) return;
    setRunning(true);
    setError(null);
    try {
      const { data } = await client.post(`${basePath}/${active.slug}`);
      setStates((s) => ({ ...s, [active.slug]: { enabled: true, report: data } }));
    } catch (e) {
      const status = e.response?.status;
      setError(e.response?.data?.error || (status === 503
        ? 'AI analysis is not configured.'
        : 'Report generation failed. Try again.'));
    } finally {
      setRunning(false);
    }
  }, [active, basePath]);

  const state = active ? states[active.slug] : undefined;
  const report = state?.report;
  const enabled = state?.enabled !== false;
  const ActiveIcon = active?.icon;
  const accentStyle = brand ? { color: brand } : undefined;
  const topBorder = brand ? { borderTop: `3px solid ${brand}` } : undefined;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        icon={Sparkles}
        title={title}
        description="AI analyses for this platform. Reports run only when you ask; cached results are flagged stale after 24h."
      />

      <div className="flex gap-4 items-start">
        <div className="panel p-2 w-64 shrink-0" style={topBorder}>
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const st = states[tab.slug];
            const rep = st?.report;
            const isActive = active?.slug === tab.slug;
            return (
              <button
                key={tab.slug}
                type="button"
                onClick={() => selectReport(tab.slug)}
                className={`flex items-start gap-2.5 w-full text-left rounded-lg px-2.5 py-2.5 transition-colors cursor-pointer ${
                  isActive ? 'bg-surface-overlay' : 'hover:bg-surface-overlay/60'
                }`}
              >
                <Icon size={15} className={`mt-0.5 shrink-0 ${isActive ? 'text-brand' : 'text-ink-faint'}`} style={isActive ? accentStyle : undefined} />
                <span className="min-w-0">
                  <span className={`block text-xs truncate ${isActive ? 'text-ink font-semibold' : 'text-ink-muted'}`}>{tab.label}</span>
                  <span className="flex items-center gap-1.5 text-[10px] text-ink-faint mt-0.5">
                    {st === undefined ? 'Loading…'
                      : rep?.generatedAt ? <>Run {timeAgo(rep.generatedAt)}{rep.stale && <StaleChip />}</>
                        : 'Not run yet'}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        {active && (
          <div className="panel p-5 flex-1 min-w-0" style={topBorder}>
            <div className="flex items-start justify-between gap-3 mb-1">
              <div className="flex items-start gap-3 min-w-0">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand/10 border border-brand/20 shrink-0"
                  style={brand ? { backgroundColor: `${brand}1a`, borderColor: `${brand}33` } : undefined}>
                  <ActiveIcon size={18} className="text-brand" style={accentStyle} />
                </div>
                <div className="min-w-0">
                  <p className="text-base font-bold text-ink">{active.label}</p>
                  <p className="text-xs text-ink-muted leading-relaxed">{active.blurb}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {report?.content && (
                  <button
                    onClick={() => setEmailOpen(true)}
                    title="Email this report via the alert SMTP server"
                    className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer"
                  >
                    <Mail size={13} /> Email
                  </button>
                )}
                <button
                  onClick={run}
                  disabled={!enabled || running}
                  className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer"
                >
                  <Sparkles size={13} /> {report?.content ? 'Re-run' : 'Generate report'}
                </button>
              </div>
            </div>

            {report?.generatedAt && (
              <p className="text-[11px] text-ink-faint flex items-center gap-1.5 flex-wrap mb-3">
                <Clock size={11} />
                <span>{report.model ? `${report.model} · ` : ''}Generated {fmtTime(report.generatedAt)}</span>
                {report.stale && <StaleChip />}
              </p>
            )}

            <div className="border-t border-cohesity-border/60 pt-4">
              {!enabled ? (
                <p className="text-xs text-ink-muted leading-relaxed">
                  AI analysis is not configured. Pick a provider under Global Settings, AI.
                </p>
              ) : running ? (
                <LoadingPanel label={active.subject ? `Analyzing ${active.subject}…` : 'Analyzing the estate…'} height={200} />
              ) : report?.content ? (
                <>
                  {error && <p className="text-red-400 text-xs mb-2">{error}</p>}
                  {report.stale && (
                    <p className="mb-3 text-[11px] text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded-md px-2.5 py-1.5">
                      This report is over {report.ttlHours || 24}h old and may not reflect current data. Re-run for an up-to-date view.
                    </p>
                  )}
                  <Markdown text={report.content} />
                </>
              ) : (
                <p className="text-ink-muted text-xs py-12 text-center">
                  {error ? <span className="text-red-400">{error}</span>
                    : state === undefined ? 'Loading…'
                      : 'No report yet. Generate one to analyze the current data.'}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
      {emailOpen && active && (
        <EmailModal basePath={basePath} slug={active.slug} label={active.label} onClose={() => setEmailOpen(false)} />
      )}
    </div>
  );
}
