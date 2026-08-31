export const BRAND = '#CC092F'; // Brocade red

export function fmtNum(n) {
  return n == null ? '—' : Number(n).toLocaleString();
}

export function fmtPct(p) {
  return p == null ? '—' : `${Number(p).toFixed(1)}%`;
}

export function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).includes('T') ? iso : `${iso}Z`.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

export function fmtMs(ms) {
  if (ms == null) return '—';
  const d = new Date(Number(ms));
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
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

// Status/health tone mapping — Doug's convention: healthy/online green,
// marginal/warning amber, critical/down red, unknown/unmonitored gray.
export function statusTone(status) {
  const s = String(status || '').toLowerCase();
  if (!s || s === 'unknown' || s === 'unmonitored') return 'neutral';
  if (s.includes('healthy') || s.includes('online') || s.includes('reachable') || s === 'ok' || s === 'up') return 'ok';
  if (s.includes('marginal') || s.includes('warning') || s.includes('degraded')) return 'warn';
  if (s.includes('critical') || s.includes('down') || s.includes('unreachable') || s.includes('offline')) return 'crit';
  return 'neutral';
}

export function severityTone(sev) {
  const s = String(sev || '').toLowerCase();
  if (s === 'critical' || s === 'alert' || s === 'error') return 'crit';
  if (s === 'warning' || s === 'major') return 'warn';
  if (s === 'info' || s === 'informational' || s === 'minor') return 'info';
  return 'neutral';
}

export function scoreTone(score) {
  if (score == null) return 'neutral';
  const n = Number(score);
  if (!Number.isFinite(n)) return 'neutral';
  if (n < 50) return 'crit';
  if (n < 70) return 'warn';
  return 'ok';
}

export function scoreColor(score) {
  const t = scoreTone(score);
  return t === 'ok' ? '#3FB950' : t === 'warn' ? '#D4A24E' : t === 'crit' ? '#C75D5D' : '#8A8A8A';
}
