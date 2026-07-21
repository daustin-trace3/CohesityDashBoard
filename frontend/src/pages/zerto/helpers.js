export const BRAND = '#EE3124'; // Zerto red

export function fmtNum(n) {
  return n == null ? '—' : Number(n).toLocaleString();
}

/** Zerto Analytics reports VM storage in MB. */
export function fmtMb(mb) {
  if (mb == null) return '—';
  const gb = mb / 1024;
  if (gb >= 1024) return `${(gb / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} TB`;
  return `${gb.toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
}

/** RPO seconds → compact human string. */
export function fmtRpo(sec) {
  if (sec == null || sec < 0) return '—';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ${sec % 60 ? `${sec % 60}s` : ''}`.trim();
  return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`;
}

export function healthTone(health) {
  if (health === 'Healthy') return 'ok';
  if (health === 'Warning') return 'warn';
  if (health === 'Error') return 'crit';
  return 'neutral';
}

export function severityTone(severity) {
  return severity === 'Error' ? 'crit' : severity === 'Warning' ? 'warn' : 'neutral';
}

export function connTone(status) {
  if (status === 'Connected') return 'ok';
  if (status === 'TemporaryDisconnected') return 'warn';
  if (status === 'PermanentDisconnected') return 'crit';
  return 'neutral';
}

export function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function parseJsonList(text) {
  try {
    const v = JSON.parse(text || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
