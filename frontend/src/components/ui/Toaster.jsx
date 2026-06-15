import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { CheckCircle2, AlertTriangle, Info, Loader2, XCircle, X } from 'lucide-react';

const ToastContext = createContext(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Allow components to call useToast outside the provider (tests) without crashing.
    return { toast: () => {}, dismiss: () => {} };
  }
  return ctx;
}

const ICONS = {
  success: <CheckCircle2 size={16} className="text-status-ok flex-shrink-0" />,
  error: <XCircle size={16} className="text-status-crit flex-shrink-0" />,
  warning: <AlertTriangle size={16} className="text-status-warn flex-shrink-0" />,
  info: <Info size={16} className="text-status-info flex-shrink-0" />,
  loading: <Loader2 size={16} className="text-brand animate-spin flex-shrink-0" />,
};

let nextId = 1;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef({});

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    if (timers.current[id]) {
      clearTimeout(timers.current[id]);
      delete timers.current[id];
    }
  }, []);

  // toast({ type, title, message, duration }) -> id
  // Update an existing toast (e.g. loading -> success) by passing { id }.
  const toast = useCallback((opts) => {
    const id = opts.id ?? nextId++;
    const entry = { type: 'info', duration: 4500, ...opts, id };
    setToasts((prev) => {
      const existing = prev.findIndex((t) => t.id === id);
      if (existing >= 0) {
        const copy = [...prev];
        copy[existing] = entry;
        return copy;
      }
      return [...prev.slice(-4), entry];
    });
    if (timers.current[id]) clearTimeout(timers.current[id]);
    if (entry.type !== 'loading' && entry.duration > 0) {
      timers.current[id] = setTimeout(() => dismiss(id), entry.duration);
    }
    return id;
  }, [dismiss]);

  return (
    <ToastContext.Provider value={{ toast, dismiss }}>
      {children}
      <div
        aria-live="polite"
        className="fixed bottom-5 right-5 z-[90] flex flex-col gap-2 w-[340px] max-w-[calc(100vw-2rem)]"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className="panel animate-slide-in-right flex items-start gap-3 px-4 py-3 bg-surface-overlay/95 backdrop-blur border-cohesity-border shadow-modal"
          >
            <span className="mt-0.5">{ICONS[t.type] || ICONS.info}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-ink leading-snug">{t.title}</p>
              {t.message && <p className="text-xs text-ink-muted mt-0.5 leading-relaxed">{t.message}</p>}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
              className="text-ink-faint hover:text-ink transition-colors cursor-pointer flex-shrink-0"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
