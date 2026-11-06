import { useCallback, useEffect, useState } from 'react';
import client from './client';
import { useVisibleInterval } from '../pages/logicmonitor/helpers';

// LogicMonitor groups picked as services (GET /logicmonitor/services), for the
// header services row. Loads while `enabled`, refreshes every 60 s while the tab
// is visible and on 'platforms-changed'. Errors keep the last good list, and the
// list is not cleared when `enabled` turns false.
export function useLmServices(enabled) {
  const [services, setServices] = useState([]);

  const load = useCallback(() => client.get('/logicmonitor/services')
    .then(({ data }) => {
      const rows = Array.isArray(data?.services) ? data.services : (Array.isArray(data) ? data : []);
      setServices(rows.filter((s) => s && s.serviceId));
    })
    .catch(() => {}), []);

  useEffect(() => {
    if (!enabled) return undefined;
    load();
    window.addEventListener('platforms-changed', load);
    return () => window.removeEventListener('platforms-changed', load);
  }, [enabled, load]);

  useVisibleInterval(load, enabled ? 60000 : 0);

  return services;
}
