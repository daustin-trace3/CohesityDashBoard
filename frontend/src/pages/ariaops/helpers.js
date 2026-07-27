export const BRAND = '#78BE20'; // Aria Operations green

export function fmtNum(n) {
  return n == null ? '—' : Number(n).toLocaleString();
}

export function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).includes('T') ? iso : `${iso}Z`.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

// last_poll_at / captured_at are SQLite datetime('now') — UTC without a zone marker.
export const asDate = (v) => (v ? new Date(String(v).includes('T') ? v : `${String(v).replace(' ', 'T')}Z`) : null);

export function healthTone(health) {
  switch (String(health || '').toUpperCase()) {
    case 'RED': return 'crit';
    case 'ORANGE': return 'crit';
    case 'YELLOW': return 'warn';
    case 'GREEN': return 'ok';
    default: return 'neutral';
  }
}

export function alertLevelTone(level) {
  switch (String(level || '').toUpperCase()) {
    case 'CRITICAL':
    case 'IMMEDIATE':
      return 'crit';
    case 'WARNING':
      return 'warn';
    default:
      return 'neutral';
  }
}

export function fmtPct(n) {
  return n == null ? '—' : `${Number(n).toFixed(1)}%`;
}
