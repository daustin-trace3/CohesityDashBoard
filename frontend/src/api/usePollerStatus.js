import { useEffect, useRef, useState } from 'react';
import client from './client';

const POLL_INTERVAL_MS = 30_000;

/**
 * Roll up freshness for ONE platform ('cohesity' | 'pure' | 'netapp'), so the
 * header chip reflects the platform being viewed. Licensing (a Helios/Cohesity
 * concern) only participates in the cohesity rollup. `hasEntities` lets the
 * chip hide entirely on a platform with nothing registered yet.
 */
function rollup(status, platform = 'cohesity') {
  if (!status) return { anySyncing: false, anyStale: false, anyError: false, hasEntities: false, newestCapture: null };

  let anySyncing = false;
  let anyStale = false;
  let anyError = false;
  let hasEntities = false;
  let newestCapture = null;

  // 'all' rolls every enabled platform section together (Ops Monitor header),
  // so the Live pill reflects the whole estate rather than one platform.
  if (platform === 'all') {
    const parts = Object.entries(status)
      .filter(([k, v]) => k !== 'licensing' && v && typeof v === 'object' && v.enabled)
      .map(([k]) => rollup(status, k));
    return {
      anySyncing: parts.some((r) => r.anySyncing),
      anyStale: parts.some((r) => r.anyStale),
      anyError: parts.some((r) => r.anyError),
      hasEntities: parts.some((r) => r.hasEntities),
      newestCapture: parts.reduce((m, r) => (r.newestCapture && (!m || r.newestCapture > m) ? r.newestCapture : m), null),
    };
  }

  const p = status[platform];
  if (p && p.enabled && p.entities) {
    for (const e of p.entities) {
      hasEntities = true;
      if (e.isSyncing) anySyncing = true;
      if (e.isStale) anyStale = true;
      if (e.lastPollStatus === 'error') anyError = true;
      if (e.lastDataCapture) {
        const t = new Date(e.lastDataCapture).getTime();
        if (!newestCapture || t > newestCapture) newestCapture = t;
      }
    }
  } else if (p && p.enabled) {
    // Account-global sections (e.g. zerto) have no per-entity structure.
    hasEntities = !!p.lastDataCapture;
    if (p.isSyncing) anySyncing = true;
    if (p.isStale) anyStale = true;
    if (p.failedSources?.length) anyError = true;
    if (p.lastDataCapture) {
      const t = new Date(p.lastDataCapture).getTime();
      if (!newestCapture || t > newestCapture) newestCapture = t;
    }
  }

  const lic = status.licensing;
  if (platform === 'cohesity' && lic && lic.enabled) {
    if (lic.isSyncing) anySyncing = true;
    if (lic.isStale) anyStale = true;
    if (lic.failedSources?.length) anyError = true;
    if (lic.lastDataCapture) {
      const t = new Date(lic.lastDataCapture).getTime();
      if (!newestCapture || t > newestCapture) newestCapture = t;
    }
  }

  return { anySyncing, anyStale, anyError, hasEntities, newestCapture: newestCapture ? new Date(newestCapture) : null };
}

export function usePollerStatus(platform = 'cohesity') {
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

  return { status, ...rollup(status, platform) };
}
