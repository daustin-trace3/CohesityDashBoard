import { useEffect, useState } from 'react';
import client from './client';

/**
 * Reverse-resolve a list of IPs to hostnames via the backend /dns/resolve
 * endpoint (which uses the DNS server configured in Settings). Returns a map
 * of { ip: hostname|null }. No-ops when no DNS server is configured.
 */
export default function useDnsResolve(ips) {
  const [map, setMap] = useState({});
  const list = [...new Set((ips || []).filter(Boolean).map(String))];
  const key = list.slice().sort().join(',');

  useEffect(() => {
    if (!list.length) { setMap({}); return undefined; }
    let cancelled = false;
    client.post('/dns/resolve', { ips: list })
      .then(({ data }) => { if (!cancelled) setMap(data.map || {}); })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return map;
}
