import { useEffect, useState } from 'react';
import client from './client';

// Whether an AI provider token is configured (GET /insights/ai/config).
// Cached module-wide so the many AI-gated surfaces (nav item, Ask AI buttons,
// cluster AI analysis) cost one request per session; Admin Settings fires
// 'ai-status-changed' after saving tokens to re-check live.
let cached = null;
let inflight = null;
const listeners = new Set();

function fetchStatus() {
  if (inflight) return inflight;
  inflight = client.get('/insights/ai/config')
    .then((r) => { cached = !!r.data?.enabled; })
    .catch(() => { cached = false; })
    .finally(() => {
      inflight = null;
      for (const l of listeners) l(cached);
    });
  return inflight;
}

export function useAiEnabled() {
  const [enabled, setEnabled] = useState(cached === true);
  useEffect(() => {
    const listener = (v) => setEnabled(v === true);
    listeners.add(listener);
    if (cached === null) fetchStatus();
    else setEnabled(cached);
    const onChange = () => { cached = null; fetchStatus(); };
    window.addEventListener('ai-status-changed', onChange);
    return () => {
      listeners.delete(listener);
      window.removeEventListener('ai-status-changed', onChange);
    };
  }, []);
  return enabled;
}
