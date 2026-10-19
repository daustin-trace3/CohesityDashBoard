import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Loader2, RefreshCw } from 'lucide-react';
import client from '../api/client';
import { SyncStatusChip } from './ui/primitives';
import { buildSourceRows, fmtAge, pollPermission, settingsRoute } from './pollerPanelRows';

const hhmm = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
const when = (iso) => {
  if (!iso) return 'Never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'Never' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

/**
 * The header sync chip as a button that opens a panel naming every polled
 * source for the platform being viewed (all platforms, grouped, on Ops pages),
 * why it is in its state, and a Poll now button per source.
 *
 * scope: a platform id or 'all'. labelFor(id) returns the platform's display
 * name. refetch re-reads /poller/status.
 */
export default function PollerStatusPanel({ chipState, title, status, scope, labelFor, hasPermission, refetch }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [actions, setActions] = useState({});
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  const timers = useRef([]);

  const rows = useMemo(() => buildSourceRows(status, scope), [status, scope, open]);
  const groups = useMemo(() => {
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.platform)) map.set(r.platform, []);
      map.get(r.platform).push(r);
    }
    return [...map.entries()];
  }, [rows]);
  const canPollAny = rows.some((r) => r.pollable && hasPermission(pollPermission(r.platform)));

  const close = useCallback((refocus) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  }, []);

  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const width = Math.min(980, window.innerWidth - 24);
      setPos({ top: r.bottom + 8, left: Math.max(12, Math.min(r.left, window.innerWidth - width - 12)) });
    }
    setOpen((o) => !o);
  };

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') close(true); };
    const onDown = (e) => {
      if (panelRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      close(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, close]);

  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);

  const setAction = (key, value) => setActions((a) => {
    const next = { ...a };
    if (value) next[key] = value; else delete next[key];
    return next;
  });

  const pollNow = async (row) => {
    setAction(row.key, { phase: 'busy' });
    try {
      const { data } = await client.post(`/poller/sources/${row.platform}/${row.id}/poll`);
      // The demo poll guard answers 200 { demo: true, triggered: false } before the route runs.
      if (data?.demo || data?.triggered === false) {
        setAction(row.key, { phase: 'error', msg: 'The demo refuses changes' });
        timers.current.push(setTimeout(() => setAction(row.key, null), 8000));
        return;
      }
      setAction(row.key, { phase: 'queued' });
      timers.current.push(setTimeout(() => refetch && refetch(), 5000));
      timers.current.push(setTimeout(() => setAction(row.key, null), 10000));
    } catch (err) {
      const s = err.response?.status;
      let msg = err.response?.data?.error || 'Could not start the poll.';
      if (s === 403 && err.response?.data?.demo) msg = 'The demo refuses changes';
      else if (s === 403) msg = 'You need manage access for this platform.';
      else if (s === 409) msg = 'Already polling';
      setAction(row.key, { phase: 'error', msg });
      timers.current.push(setTimeout(() => setAction(row.key, null), 8000));
    }
  };

  const showPlatformHeaders = scope === 'all';

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={title ? `${title}\n\nClick for details` : 'Click for details'}
        className="inline-flex rounded-full cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
      >
        <SyncStatusChip state={chipState} />
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Polling status"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: Math.min(980, window.innerWidth - 24), maxHeight: 'calc(100vh - 6rem)' }}
          className="z-50 overflow-auto rounded-lg border border-cohesity-border bg-cohesity-gray shadow-xl text-xs"
        >
          <div className="px-4 py-3 border-b border-cohesity-border text-ink-muted leading-relaxed">
            Live means every source reported inside its polling window. Syncing means a poll is running now.
            Delayed means the poller is backing off after repeated failures and retries at the time shown.
            Error means the last poll failed. Stale means no data inside twice the polling interval plus 5 minutes.
          </div>
          {rows.length === 0 ? (
            <p className="px-4 py-6 text-ink-muted">No polled sources for this view.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-ink-muted">
                    <th className="px-4 py-2 font-semibold">Source</th>
                    <th className="px-2 py-2 font-semibold">State</th>
                    <th className="px-2 py-2 font-semibold">Last data</th>
                    <th className="px-2 py-2 font-semibold">Last poll</th>
                    <th className="px-2 py-2 font-semibold">Error</th>
                    {canPollAny && <th className="px-4 py-2 font-semibold text-right">Action</th>}
                  </tr>
                </thead>
                {groups.map(([platform, list]) => (
                  <tbody key={platform}>
                    {showPlatformHeaders && (
                      <tr className="bg-cohesity-border/20">
                        <td colSpan={canPollAny ? 6 : 5} className="px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider text-ink">
                          {labelFor(platform)}
                        </td>
                      </tr>
                    )}
                    {list.map((r) => {
                      const act = actions[r.key];
                      const allowed = r.pollable && hasPermission(pollPermission(r.platform));
                      const stateLabel = r.state === 'delayed' && r.backoffUntil ? `Delayed until ${hhmm(r.backoffUntil)}` : undefined;
                      return (
                        <tr key={r.key} className="border-t border-cohesity-border/60 align-top">
                          <td className="px-4 py-2 font-semibold text-ink whitespace-nowrap">{r.name}</td>
                          <td className="px-2 py-2 whitespace-nowrap"><SyncStatusChip state={r.state} label={stateLabel} /></td>
                          <td className="px-2 py-2 text-ink-muted whitespace-nowrap" title={r.staleAfterMinutes ? `Stale after ${r.staleAfterMinutes} min` : undefined}>
                            {fmtAge(r.ageMinutes)}
                          </td>
                          <td className="px-2 py-2 text-ink-muted whitespace-nowrap">
                            {when(r.lastPollEnd)}{r.lastPollStatus ? ` (${r.lastPollStatus})` : ''}
                          </td>
                          <td className="px-2 py-2 text-ink-muted">
                            {r.error
                              ? <span className="block max-w-[14rem] truncate text-status-crit" title={r.error}>{r.error}</span>
                              : '-'}
                          </td>
                          {canPollAny && (
                            <td className="px-4 py-2 text-right whitespace-nowrap">
                              {!allowed ? null : act?.phase === 'busy' ? (
                                <span className="inline-flex items-center gap-1 text-ink-muted"><Loader2 size={12} className="animate-spin" /> Starting</span>
                              ) : act?.phase === 'queued' ? (
                                <span className="text-status-ok font-semibold">Queued</span>
                              ) : act?.phase === 'error' ? (
                                <span className="text-status-warn font-semibold">{act.msg}</span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => pollNow(r)}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 font-semibold"
                                >
                                  <RefreshCw size={11} /> Poll now
                                </button>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                ))}
              </table>
            </div>
          )}
          <div className="flex items-center gap-4 px-4 py-2.5 border-t border-cohesity-border">
            {scope !== 'all' && (
              <Link to={settingsRoute(scope)} onClick={() => close(false)} className="text-brand hover:underline font-semibold">
                Open {labelFor(scope)} settings
              </Link>
            )}
            <Link to="/ops/status" onClick={() => close(false)} className="text-brand hover:underline font-semibold">Service Status</Link>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
