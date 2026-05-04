import { useState, useRef, useEffect } from 'react';
import AlertBadge from './AlertBadge';

export default function NotificationBell({ count = 0, alerts = [] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

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
        className="relative p-2 rounded hover:bg-cohesity-border transition-colors"
        aria-label="Notifications"
      >
        <svg
          className="w-5 h-5 text-cohesity-text"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
          />
        </svg>
        {count > 0 && (
          <span className="absolute top-0.5 right-0.5 min-w-[16px] h-4 bg-red-500 text-white text-xs rounded-full flex items-center justify-center px-0.5 font-bold">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-10 w-80 bg-cohesity-gray border border-cohesity-border rounded-lg shadow-xl z-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-cohesity-border flex items-center justify-between">
            <span className="text-sm font-semibold text-cohesity-text">Recent Alerts</span>
            <span className="text-xs text-gray-400">{count} unresolved</span>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {alerts.length === 0 ? (
              <p className="text-center text-gray-400 text-sm py-6">No active alerts</p>
            ) : (
              alerts.map((alert) => (
                <div
                  key={alert.id}
                  className="px-4 py-3 border-b border-cohesity-border hover:bg-cohesity-border transition-colors"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-gray-300 truncate max-w-[160px]">
                      {alert.cluster_name}
                    </span>
                    <AlertBadge severity={alert.severity} />
                  </div>
                  <p className="text-xs text-gray-400 truncate">
                    {alert.description || alert.alert_type || 'Alert'}
                  </p>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
