export const BRAND = '#00A2C7'; // Aria Automation teal

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

export function severityTone(sev) {
  return sev === 'error' ? 'crit' : sev === 'warning' ? 'warn' : 'info';
}

// Generic status-string classifier — vRA status vocab is unverified upstream,
// so this matches on substrings rather than an exact enum.
export function statusTone(status) {
  const s = String(status || '').toLowerCase();
  if (/fail|error|reject|unhealthy|down|crit/.test(s)) return 'crit';
  if (/success|complete|active|healthy|approve|ok|up/.test(s)) return 'ok';
  if (/pending|progress|warn|wait/.test(s)) return 'warn';
  return 'neutral';
}

// Days between now and an ISO date (negative = already past). Returns null if unparseable.
export function daysUntil(iso) {
  if (!iso) return null;
  const d = asDate(iso) || new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((d.getTime() - Date.now()) / 86400000);
}

export function leaseTone(daysLeft) {
  if (daysLeft == null) return 'neutral';
  if (daysLeft < 0) return 'crit';
  if (daysLeft <= 7) return 'warn';
  return 'ok';
}

export function certTone(certValidTo, warnDays = 30) {
  const days = daysUntil(certValidTo);
  if (days == null) return 'neutral';
  if (days < 0) return 'crit';
  if (days <= warnDays) return 'warn';
  return 'ok';
}
