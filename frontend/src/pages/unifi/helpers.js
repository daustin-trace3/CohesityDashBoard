export const BRAND = '#006FFF'; // UniFi blue

export function fmtNum(n) {
  return n == null ? '—' : Number(n).toLocaleString();
}

export function fmtBytes(b) {
  if (b == null) return '—';
  const n = Number(b);
  if (!Number.isFinite(n)) return '—';
  const gb = n / 1e9;
  if (gb >= 1000) return `${(n / 1e12).toLocaleString(undefined, { maximumFractionDigits: 1 })} TB`;
  if (gb >= 1) return `${gb.toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  return `${(n / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
}

export function fmtPct(p) {
  return p == null ? '—' : `${Number(p).toFixed(1)}%`;
}

export function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).includes('T') ? iso : `${iso}Z`.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

export function secsToHuman(s) {
  if (s == null) return '—';
  const n = Number(s);
  if (!Number.isFinite(n)) return '—';
  if (n < 60) return `${Math.round(n)}s`;
  if (n < 3600) return `${Math.round(n / 60)}m`;
  if (n < 86400) return `${Math.round(n / 3600)}h`;
  return `${Math.round(n / 86400)}d`;
}

export function severityTone(sev) {
  const s = String(sev || '').toLowerCase();
  return s === 'critical' ? 'crit' : s === 'warning' ? 'warn' : 'info';
}

export function usageTone(pct) {
  if (pct == null) return 'neutral';
  if (pct > 90) return 'crit';
  if (pct > 80) return 'warn';
  return 'ok';
}

export function parseJsonArr(s) {
  if (!s) return [];
  if (Array.isArray(s)) return s;
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

export function parseJsonObj(s) {
  if (!s) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return null; }
}

// Device state: numeric, 1 = connected (contract §Upstream API).
export function stateTone(device) {
  if (device.state !== 1) return 'crit';
  if (device.overheating) return 'warn';
  return 'ok';
}

export function stateLabel(device) {
  if (device.state !== 1) return 'OFFLINE';
  if (device.overheating) return 'OVERHEATING';
  return 'ONLINE';
}

export const TYPE_LABEL = { udm: 'Gateway', usw: 'Switch', uap: 'Access Point' };

export function typeLabel(type) {
  return TYPE_LABEL[type] || (type || '—').toUpperCase();
}

export function typeTone(type) {
  if (type === 'udm') return 'info';
  if (type === 'usw') return 'neutral';
  if (type === 'uap') return 'ok';
  return 'neutral';
}

export function signalTone(rssiOrSignal) {
  if (rssiOrSignal == null) return 'neutral';
  const s = Number(rssiOrSignal);
  if (s >= -50) return 'ok';
  if (s >= -60) return 'ok';
  if (s >= -70) return 'warn';
  return 'crit';
}

export function signalBucket(signal) {
  if (signal == null) return 'poor';
  const s = Number(signal);
  if (s >= -50) return 'excellent';
  if (s >= -60) return 'good';
  if (s >= -70) return 'fair';
  return 'poor';
}

export function poeWatts(port) {
  const w = parseFloat(port?.poe_power);
  return Number.isFinite(w) ? w : null;
}

// Cumulative counter delta between two consecutive port-history rows.
export function counterDelta(prev, cur, key) {
  if (prev == null || cur == null) return null;
  const a = Number(prev[key]);
  const b = Number(cur[key]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const d = b - a;
  return d < 0 ? null : d; // counter reset — treat as unknown rather than negative
}
