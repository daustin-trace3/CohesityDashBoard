import { useId, useState } from 'react';
import { Info, Save } from 'lucide-react';

// Shared building blocks for settings tabs: an aligned row (fixed label
// column, control on the right), an info tip that carries the explanation,
// a small subheading for related rows, and the per-tab save bar.

export const inputCls = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none';
export const numberCls = `${inputCls} max-w-[10rem] tnum`;
export const selectCls = `${inputCls} cursor-pointer`;

/** Info icon that shows `children` on hover and on keyboard focus. */
export function InfoTip({ label, children }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="relative inline-flex"
      onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" aria-label={label ? `About ${label}` : 'More information'} aria-describedby={id}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
        className="text-ink-faint hover:text-brand focus:text-brand outline-none cursor-help rounded"
        style={{ border: 'none', background: 'none', padding: 0 }}>
        <Info size={13} />
      </button>
      {open && (
        <span id={id} role="tooltip"
          className="absolute left-0 top-full mt-1.5 z-50 w-80 max-w-[80vw] rounded-lg border border-cohesity-border bg-surface-raised shadow-panel px-3 py-2 text-[11px] font-normal leading-relaxed text-ink-muted normal-case tracking-normal">
          {children}
        </span>
      )}
    </span>
  );
}

/**
 * One setting: label column (same width everywhere) with an optional info
 * tip and "unsaved" tag, control on the right. `htmlFor` ties the label to the
 * control; leave it off for composite controls.
 */
export function SettingRow({ label, htmlFor, tip, dirty, children }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-[16rem_minmax(0,1fr)] gap-x-6 gap-y-1.5 items-start py-3 border-b border-cohesity-border/50 last:border-b-0">
      <div className="flex items-center gap-1.5 md:pt-2 min-w-0 flex-wrap">
        {htmlFor
          ? <label htmlFor={htmlFor} className="text-xs font-semibold text-ink">{label}</label>
          : <span className="text-xs font-semibold text-ink">{label}</span>}
        {tip && <InfoTip label={typeof label === 'string' ? label : undefined}>{tip}</InfoTip>}
        {dirty && <span className="text-[10px] text-amber-400">unsaved</span>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Checkbox control for a SettingRow (the row label names it). */
export function Toggle({ id, checked, onChange }) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer select-none md:pt-2">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-brand cursor-pointer" />
      <span className="text-xs text-ink-muted">{checked ? 'On' : 'Off'}</span>
    </label>
  );
}

/** Sentence-case subheading over a run of related rows. */
export function SettingGroup({ title, children }) {
  return (
    <div className="mt-4 first:mt-0">
      {title && <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint pb-1 border-b border-cohesity-border/60">{title}</p>}
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

/** Save button for one tab, with the unsaved marker beside it. */
export function TabSaveBar({ onSave, saving, dirty, label = 'Save', children }) {
  return (
    <div className="flex items-center gap-2 pt-4 mt-2 border-t border-cohesity-border/60 flex-wrap">
      <button onClick={onSave} disabled={saving || !dirty}
        className="flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer">
        <Save size={13} /> {saving ? 'Saving...' : label}
      </button>
      {dirty && <span className="text-[10px] text-amber-400">unsaved changes</span>}
      {children}
    </div>
  );
}
