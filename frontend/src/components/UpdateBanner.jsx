import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import client from '../api/client';

const POLL_MS = 60000;

/**
 * Watches /api/app-version (a stat of dist/index.html, so it flips the moment
 * a new build is deployed — no backend restart needed) and offers a one-click
 * reload instead of making users discover stale bundles via hard refresh.
 */
export default function UpdateBanner() {
  const [updateReady, setUpdateReady] = useState(false);
  const baselineRef = useRef(null);

  useEffect(() => {
    let stopped = false;
    const check = () => client.get('/app-version')
      .then(({ data }) => {
        if (stopped || !data?.version) return;
        if (baselineRef.current == null) baselineRef.current = data.version;
        else if (data.version !== baselineRef.current) setUpdateReady(true);
      })
      .catch(() => { /* logged out or offline — try again later */ });
    check();
    const t = setInterval(check, POLL_MS);
    const onFocus = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    return () => {
      stopped = true;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  if (!updateReady) return null;
  return (
    <div className="sticky top-0 z-40 flex items-center justify-center gap-3 bg-brand/15 border-b border-brand/40 px-4 py-1.5 text-[12px] text-ink">
      <span>A new version of the dashboard is available.</span>
      <button
        onClick={() => window.location.reload()}
        className="flex items-center gap-1 rounded-md border border-brand/50 bg-brand/20 px-2 py-0.5 font-semibold text-ink hover:bg-brand/30 transition-colors cursor-pointer">
        <RefreshCw size={11} /> Reload
      </button>
    </div>
  );
}
