import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, BellOff, ArrowRight } from 'lucide-react';
import AlertBadge from './AlertBadge';

export default function NotificationBell({ count = 0, alerts = [] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-cohesity-border text-ink-muted hover:text-ink hover:bg-surface-overlay transition-colors cursor-pointer"
        aria-label={`Notifications${count > 0 ? `, ${count} unresolved` : ''}`}
        aria-expanded={open}
      >
        <Bell size={17} />
        {count > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[17px] h-[17px] bg-status-crit text-white text-[10px] rounded-full flex items-center justify-center px-1 font-bold tnum shadow">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-11 w-[340px] panel bg-surface-raised shadow-modal z-50 overflow-hidden animate-fade-in">
          <div className="px-4 py-3 border-b border-cohesity-border flex items-center justify-between">
            <span className="text-sm font-bold text-ink">Recent Alerts</span>
            <span className="text-[11px] text-ink-faint tnum">{count} unresolved</span>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {alerts.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-ink-faint">
                <BellOff size={22} />
                <p className="text-xs">No active alerts</p>
              </div>
            ) : (
              alerts.map((alert) => (
                <div
                  key={alert.id}
                  className="px-4 py-3 border-b border-cohesity-border/60 hover:bg-surface-overlay/60 transition-colors"
                >
                  <div className="flex items-center justify-between mb-1 gap-2">
                    <span className="text-xs font-semibold text-ink truncate">
                      {alert.cluster_name}
                    </span>
                    <AlertBadge severity={alert.severity} />
                  </div>
                  <p className="text-xs text-ink-muted truncate">
                    {alert.description || alert.alert_type || 'Alert'}
                  </p>
                </div>
              ))
            )}
          </div>
          <button
            onClick={() => { setOpen(false); navigate('/alerts'); }}
            className="w-full flex items-center justify-center gap-1.5 px-4 py-2.5 text-xs font-semibold text-brand hover:bg-brand/10 transition-colors cursor-pointer"
          >
            View all alerts <ArrowRight size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
