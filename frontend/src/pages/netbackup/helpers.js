export const BRAND = '#B1181E'; // Veritas red

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

export function severityTone(sev) {
  return sev === 'critical' ? 'crit' : sev === 'warning' ? 'warn' : 'info';
}

const SUCCESS_STATES = ['DONE', 'SUCCESSFUL', 'SUCCESS'];
const RUNNING_STATES = ['ACTIVE', 'RUNNING', 'QUEUED', 'SUSPENDED', 'INITIATED'];
const FAILED_STATES = ['FAILED', 'INCOMPLETE'];

export function jobStateTone(job) {
  const state = String(job?.state || '').toUpperCase();
  const statusCode = job?.statusCode ?? job?.status_code;
  if (FAILED_STATES.includes(state)) return 'crit';
  if (RUNNING_STATES.includes(state)) return 'info';
  if (state === 'EXITED' || SUCCESS_STATES.includes(state)) {
    if (statusCode == null) return 'ok';
    return Number(statusCode) === 0 ? 'ok' : Number(statusCode) < 10 ? 'warn' : 'crit';
  }
  return 'neutral';
}

export function fmtDuration(seconds) {
  if (seconds == null) return '—';
  const s = Math.max(0, Math.round(Number(seconds)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).includes('T') ? iso : `${iso}Z`.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

export const TB = 1e12;
export function fmtTb(b) {
  if (b == null) return '—';
  const t = b / TB;
  return `${t.toLocaleString(undefined, { maximumFractionDigits: t >= 100 ? 0 : 1 })} TB`;
}

const RUN_STATUS_TONE = { kSuccess: 'ok', kFailure: 'crit', kWarning: 'warn', kRunning: 'info' };
export function runStatusTone(status) {
  return RUN_STATUS_TONE[status] || 'neutral';
}
export function runStatusLabel(status) {
  return status ? String(status).replace(/^k/, '') : '—';
}
