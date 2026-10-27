import { useState } from 'react';
import { useToast } from '../../../components/ui/Toaster';
import { setRecState, errMsg } from './finopsApi';

const btn = 'px-2 py-0.5 rounded-md text-[11px] font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50';

const ACTIONS = {
  open: [['accepted', 'Accept'], ['dismissed', 'Dismiss'], ['done', 'Mark done']],
  accepted: [['done', 'Mark done'], ['dismissed', 'Dismiss'], ['open', 'Reopen']],
  dismissed: [['open', 'Reopen']],
  done: [['open', 'Reopen']],
};

/**
 * Lifecycle actions for one recommendation row. rec = { key, state: { status, note } }.
 * A click opens a small inline form with an optional note (max 500), then POST /optimizer/state.
 * onChanged() runs after a successful save so the page can reload.
 */
export default function RecStateMenu({ rec, onChanged }) {
  const { toast } = useToast();
  const status = rec?.state?.status || 'open';
  const [pending, setPending] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const start = (next) => { setPending(next); setNote(rec?.state?.note || ''); };
  const cancel = () => { setPending(null); setNote(''); };
  const submit = async () => {
    setBusy(true);
    try {
      await setRecState({ key: rec.key, status: pending, ...(note.trim() ? { note: note.trim().slice(0, 500) } : {}) });
      toast({ type: 'success', title: `Marked ${pending}` });
      cancel();
      onChanged?.();
    } catch (err) {
      toast({ type: 'error', title: 'Could not update the recommendation', message: errMsg(err, '') });
    } finally {
      setBusy(false);
    }
  };

  if (!rec?.key) return <span className="text-ink-faint text-[11px]">-</span>;
  if (pending) {
    return (
      <div className="flex flex-col gap-1.5 min-w-[200px]">
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder={`Note for ${pending} (optional)`}
          aria-label="Note" autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') cancel(); }}
          className="w-full bg-surface-overlay border border-cohesity-border rounded-md px-2 py-1 text-[11px] text-ink focus:border-brand/60 outline-none" />
        <div className="flex gap-1.5">
          <button onClick={submit} disabled={busy} className={`${btn} !text-brand !border-brand/40`}>{busy ? 'Saving...' : 'Save'}</button>
          <button onClick={cancel} disabled={busy} className={btn}>Cancel</button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {(ACTIONS[status] || ACTIONS.open).map(([next, text]) => (
        <button key={next} onClick={() => start(next)} className={btn}>{text}</button>
      ))}
    </div>
  );
}
