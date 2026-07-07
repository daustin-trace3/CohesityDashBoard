// Shared formatting + presentation helpers for the NetApp pages.
export const BRAND = '#0067C5';

export function fmtBytes(b) {
  if (b == null || isNaN(b)) return '—';
  if (b === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(Math.abs(b)) / Math.log(1024)));
  return `${(b / Math.pow(1024, i)).toFixed(i >= 3 ? 2 : 0)} ${units[i]}`;
}

export function fmtNum(n, digits = 0) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function fmtIops(v) {
  if (v == null || isNaN(v)) return '—';
  return Math.round(v).toLocaleString();
}

export function fmtLatency(usec) {
  if (usec == null || isNaN(usec)) return '—';
  if (usec < 1000) return `${Math.round(usec)} µs`;
  return `${(usec / 1000).toFixed(2)} ms`;
}

export function fmtRatio(r) {
  if (r == null || isNaN(r) || r <= 0) return '—';
  return `${Number(r).toFixed(1)} : 1`;
}

export function timeAgo(iso) {
  if (!iso) return '—';
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export function severityTone(sev) {
  const s = String(sev || '').toLowerCase();
  if (s === 'emergency' || s === 'alert' || s === 'critical') return 'crit';
  if (s === 'error') return 'crit';
  if (s === 'warning') return 'warn';
  if (s === 'notice' || s === 'informational' || s === 'info' || s === 'debug') return 'info';
  return 'neutral';
}

export function statusTone(status) {
  const s = String(status || '').toLowerCase();
  if (['online', 'up', 'running', 'normal', 'present'].includes(s)) return 'ok';
  if (['degraded', 'partial', 'reconstructing'].includes(s)) return 'warn';
  if (['offline', 'down', 'failed', 'broken', 'error', 'unreachable'].includes(s)) return 'crit';
  return 'neutral';
}

export function usedPct(latest) {
  if (!latest || !latest.total_bytes) return 0;
  return Math.min(100, Math.round((latest.used_bytes / latest.total_bytes) * 100));
}
