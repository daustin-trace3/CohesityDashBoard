import { useEffect, useRef, useState } from 'react';
import client from './client';

const POLL_INTERVAL_MS = 30_000;

function rollup(status) {
  if (!status) return { anySyncing: false, anyStale: false, anyError: false, newestCapture: null };

  let anySyncing = false;
  let anyStale = false;
  let anyError = false;
  let newestCapture = null;

  for (const key of ['cohesity', 'pure', 'netapp']) {
    const p = status[key];
    if (!p || !p.enabled) continue;
    if (p.entities) {
      for (const e of p.entities) {
        if (e.isSyncing) anySyncing = true;
        if (e.isStale) anyStale = true;
        if (e.lastPollStatus === 'error') anyError = true;
        if (e.lastDataCapture) {
          const t = new Date(e.lastDataCapture).getTime();
          if (!newestCapture || t > newestCapture) newestCapture = t;
        }
      }
    }
  }

  const lic = status.licensing;
  if (lic && lic.enabled) {
    if (lic.isSyncing) anySyncing = true;
    if (lic.isStale) anyStale = true;
    if (lic.failedSources?.length) anyError = true;
    if (lic.lastDataCapture) {
      const t = new Date(lic.lastDataCapture).getTime();
      if (!newestCapture || t > newestCapture) newestCapture = t;
    }
  }

  return { anySyncing, anyStale, anyError, newestCapture: newestCapture ? new Date(newestCapture) : null };
}

export function usePollerStatus() {
  const [status, setStatus] = useState(null);
  const timerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function fetch() {
      if (document.hidden) return;
      try {
        const res = await client.get('/poller/status');
        if (!cancelled) setStatus(res.data);
      } catch {
        // fail soft — 404 or network error leaves status as-is
      }
    }

    fetch();
    timerRef.current = setInterval(fetch, POLL_INTERVAL_MS);

    function onVisibility() {
      if (!document.hidden) fetch();
    }
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      clearInterval(timerRef.current);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return { status, ...rollup(status) };
}
