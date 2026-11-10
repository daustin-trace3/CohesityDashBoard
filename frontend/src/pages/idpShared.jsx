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
