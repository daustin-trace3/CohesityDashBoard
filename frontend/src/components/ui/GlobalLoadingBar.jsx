import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { subscribeNetworkActivity } from '../../api/client';

/**
 * Always-visible feedback for background data fetching:
 *  - a slim animated bar across the very top of the viewport
 *  - a "Syncing data" pill if requests run longer than 400ms
 */
export default function GlobalLoadingBar() {
  const [active, setActive] = useState(false);
  const [showPill, setShowPill] = useState(false);
  const pillTimer = useRef(null);

  useEffect(() => {
    const unsubscribe = subscribeNetworkActivity((count) => {
      const busy = count > 0;
      setActive(busy);
      if (busy) {
        if (!pillTimer.current) {
          pillTimer.current = setTimeout(() => setShowPill(true), 400);
        }
      } else {
        if (pillTimer.current) {
          clearTimeout(pillTimer.current);
          pillTimer.current = null;
        }
        setShowPill(false);
      }
    });
    return () => {
      unsubscribe();
      if (pillTimer.current) clearTimeout(pillTimer.current);
    };
  }, []);

  return (
    <>
      <div className="fixed top-0 left-0 right-0 h-[2px] z-[100] pointer-events-none" aria-hidden={!active}>
        {active && (
          <div className="relative h-full overflow-hidden">
            <div className="absolute h-full bg-gradient-to-r from-transparent via-brand to-transparent animate-loading-bar" />
          </div>
        )}
      </div>
      {showPill && (
        <div
          role="status"
          className="fixed top-3 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-2 rounded-full bg-surface-overlay/95 border border-cohesity-border px-3.5 py-1.5 shadow-modal backdrop-blur animate-fade-in"
        >
          <Loader2 size={13} className="text-brand animate-spin" />
          <span className="text-xs font-medium text-ink-muted">Syncing data&hellip;</span>
        </div>
      )}
    </>
  );
}
