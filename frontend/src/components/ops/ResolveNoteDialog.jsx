import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Small modal that asks for a resolution note. When `required` is true the
 * Resolve button stays disabled until the note has text. `onSubmit(note)` may
 * return a promise; the dialog shows Resolving... while it runs.
 */
export default function ResolveNoteDialog({ title = 'Resolve incident', required = false, busy = false, onSubmit, onCancel }) {
  const [note, setNote] = useState('');
  const trimmed = note.trim();
  const blocked = busy || (required && !trimmed);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCancel?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const submit = () => { if (!blocked) onSubmit?.(trimmed); };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} />
      <div className="relative panel w-full max-w-lg border-t-2 border-brand p-4">
        <p className="text-[15px] font-semibold text-ink mb-1">{title}</p>
        <p className="text-[12px] text-ink-muted mb-3">
          {required
            ? 'This incident was waiting on a person. Say what was found or done; the note is kept with the incident.'
            : 'Optionally say what was found or done; the note is kept with the incident.'}
        </p>
        <label htmlFor="resolve-note" className="text-[11px] uppercase tracking-wide text-ink-faint">
          Resolution note{required ? ' (required)' : ''}
        </label>
        <textarea id="resolve-note" value={note} onChange={(e) => setNote(e.target.value)} rows={5} autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } }}
          className="mt-1 w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-[13px] text-ink focus:border-brand/60 outline-none" />
        <div className="flex items-center justify-end gap-2 mt-3">
          <button type="button" onClick={onCancel} disabled={busy}
            className="text-[13px] font-medium px-3 py-1.5 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink transition-colors disabled:opacity-50 cursor-pointer">
            Cancel
          </button>
          <button type="button" onClick={submit} disabled={blocked}
            className="text-[13px] font-medium px-3 py-1.5 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer">
            {busy ? 'Resolving...' : 'Resolve'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
