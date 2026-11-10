import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

// Shared pieces of the Users & Access > Identity providers tab, used by the
// Active Directory and Okta sections so both present the same way.

export const btnPrimary = 'flex items-center justify-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-40 cursor-pointer';
export const btnPlain = 'flex items-center justify-center gap-1.5 text-xs font-medium px-3.5 py-2 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:bg-surface-overlay transition-colors disabled:opacity-40 cursor-pointer';

/* Modal shell, wide */
export function Drawer({ title, onClose, children }) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div className="relative bg-cohesity-gray border border-cohesity-border rounded-lg w-full max-w-3xl max-h-[92vh] flex flex-col shadow-xl animate-fade-in">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-cohesity-border flex-shrink-0">
          <p className="text-sm font-bold text-ink">{title}</p>
          <button onClick={onClose} aria-label="Close" className="text-ink-faint hover:text-ink cursor-pointer"><X size={16} /></button>
        </div>
        <div className="px-5 py-4 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** Switch used on provider cards: a pill that reads Enabled / Disabled beside it. */
export function EnabledSwitch({ checked, disabled, onChange, title, label }) {
  return (
    <span className={`inline-flex items-center gap-2 select-none ${disabled ? 'opacity-60' : ''}`} title={title || ''}>
      <button type="button" onClick={onChange} disabled={disabled} role="switch" aria-checked={!!checked} aria-label={label}
        className={`relative shrink-0 w-9 h-5 rounded-full transition-colors ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'} ${checked ? 'bg-brand' : 'bg-cohesity-border'}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
      </button>
      <span className="text-xs text-ink-muted">{checked ? 'Enabled' : 'Disabled'}</span>
    </span>
  );
}
