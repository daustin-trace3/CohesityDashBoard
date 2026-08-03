import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Sparkles } from 'lucide-react';
import { Badge } from './ui/primitives';

const SECTION_TONES = {
  Added: 'ok',
  Fixed: 'warn',
  Changed: 'neutral',
  Removed: 'neutral',
  Security: 'neutral',
};

function fmtDate(date) {
  if (!date) return '';
  try { return new Date(date).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }); } catch { return date; }
}

export default function ReleaseNotesModal({ latest, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (latest?.version) localStorage.setItem('icc:release-notes-seen', latest.version);
  }, [latest?.version]);

  const sections = latest?.sections || [];

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="panel w-full max-w-2xl p-5 max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-3 flex-shrink-0">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-ink flex items-center gap-2">
              <Sparkles size={15} className="text-brand" /> What's New
            </h2>
            {latest?.version && (
              <p className="text-[11px] text-ink-muted mt-0.5">
                Version {latest.version}{latest.date ? ` · ${fmtDate(latest.date)}` : ''}
              </p>
            )}
          </div>
          <button onClick={onClose} aria-label="Close" className="text-ink-faint hover:text-ink flex-shrink-0 cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {sections.length === 0 ? (
            <p className="text-ink-muted text-xs py-10 text-center">No release notes available.</p>
          ) : (
            <div className="space-y-4">
              {sections.map((section) => (
                <div key={section.title}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <Badge tone={SECTION_TONES[section.title] || 'neutral'}>{section.title}</Badge>
                  </div>
                  <ul className="list-disc list-inside space-y-1">
                    {section.items.map((item, i) => (
                      <li key={i} className="text-xs text-ink-muted leading-relaxed">{item}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
