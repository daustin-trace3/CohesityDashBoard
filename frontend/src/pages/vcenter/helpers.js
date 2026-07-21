export const BRAND = '#0091DA'; // vSphere blue

export function fmtNum(n) {
  return n == null ? '—' : Number(n).toLocaleString();
}

export function fmtBytes(b) {
  if (b == null) return '—';
  const tb = b / 1e12;
  if (tb >= 1) return `${tb.toLocaleString(undefined, { maximumFractionDigits: 1 })} TB`;
  return `${(b / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
}

export function fmtPct(p) {
  return p == null ? '—' : `${Number(p).toFixed(1)}%`;
}

export function hostStateTone(h) {
  if (h.connection_state !== 'CONNECTED') return 'crit';
  if (h.in_maintenance === 1) return 'warn';
  return 'ok';
}

export function hostStateLabel(h) {
  if (h.connection_state !== 'CONNECTED') return (h.connection_state || 'UNKNOWN').replace(/_/g, ' ');
  if (h.in_maintenance === 1) return 'MAINTENANCE';
  return 'UP';
}

export function usageTone(pct) {
  if (pct == null) return 'neutral';
  if (pct > 90) return 'crit';
  if (pct > 80) return 'warn';
  return 'ok';
}

export function severityTone(sev) {
  return sev === 'critical' ? 'crit' : sev === 'warning' ? 'warn' : 'info';
}

export function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).includes('T') ? iso : `${iso}Z`.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}
