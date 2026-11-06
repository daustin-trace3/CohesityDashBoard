// Shared bits for the F5 pages. F5 is a derived platform: every number comes from
// the LogicMonitor portal(s) that monitor the devices, served under /api/f5.
import { useCallback, useEffect, useState } from 'react';
import client from '../../api/client';
import { useVisibleInterval } from '../logicmonitor/helpers';

export const BRAND = '#E4002B';
export const REFRESH_MS = 60000;
export const SOURCE_NOTE = 'Fed by LogicMonitor';

// Failed request: show the status and the server text, never a bare "failed".
export function requestError(e, what) {
  const status = e?.response?.status;
  const d = e?.response?.data;
  const text = (d && typeof d === 'object' ? (d.error || d.message) : '') || e?.message || '';
  return `Failed to load ${what}${status ? ` (HTTP ${status})` : ''}${text ? `: ${text}` : ''}`;
}

export const OLDER_VERSION = 'The service answered with a shape this page does not read. The service may be on an older version.';

// Rows arrive as a plain array or as { items: [...] }.
export function rowsOf(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.devices)) return data.devices;
  return null;
}

// GET helper: { data, error, loading, reload, loadedAt }. Polls only while the tab is visible.
export function useF5Get(path, what, { params, interval = REFRESH_MS } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loadedAt, setLoadedAt] = useState(null);
  const key = JSON.stringify(params || {});
  const reload = useCallback(() => client.get(path, { params: params || {} })
    .then(({ data: d }) => { setError(null); setData(d ?? {}); setLoadedAt(new Date()); })
    .catch((e) => { setError(requestError(e, what)); setData((cur) => cur ?? {}); setLoadedAt(new Date()); }),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [path, what, key]);
  useEffect(() => { reload(); }, [reload]);
  useVisibleInterval(reload, interval);
  return { data, error, loading: data == null, reload, loadedAt };
}

// The F5 kinds a device row can carry.
export const KIND_LABEL = { bigip: 'BIG-IP', gtm: 'GTM', f5os: 'F5OS' };
export const kindLabel = (k) => KIND_LABEL[k] || (k ? String(k) : 'Unknown');
