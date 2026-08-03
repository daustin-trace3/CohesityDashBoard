export const BRAND = '#E57000'; // Proxmox orange

export function fmtNum(n) {
  return n == null ? '—' : Number(n).toLocaleString();
}

export function fmtBytes(b) {
  if (b == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = Number(b);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toLocaleString(undefined, { maximumFractionDigits: v >= 100 ? 0 : 1 })} ${units[i]}`;
}

export function fmtPct(p) {
  return p == null ? '—' : `${Number(p).toFixed(1)}%`;
}

export function severityTone(sev) {
  return sev === 'critical' ? 'crit' : sev === 'warning' ? 'warn' : 'info';
}

export function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).includes('T') ? iso : `${iso}Z`.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

export function timeAgo(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).includes('T') ? iso : `${iso}Z`.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return String(iso);
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function guestTypeLabel(t) {
  return t === 'qemu' ? 'VM' : t === 'lxc' ? 'LXC' : t || '—';
}

export function storageTone(pct, warnPct = 85, critPct = 95) {
  if (pct == null) return 'neutral';
  if (pct >= critPct) return 'crit';
  if (pct >= warnPct) return 'warn';
  return 'ok';
}

export function backupStatusTone(status) {
  if (!status) return 'neutral';
  return status === 'OK' ? 'ok' : 'crit';
}

export function fmtEpoch(sec) {
  if (sec == null) return '—';
  const d = new Date(Number(sec) * 1000);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export function parseIpAddresses(ipAddresses) {
  if (!ipAddresses) return [];
  if (Array.isArray(ipAddresses)) return ipAddresses;
  try {
    const parsed = JSON.parse(ipAddresses);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function daysAgo(iso) {
  if (!iso) return null;
  const d = new Date(String(iso).includes('T') ? iso : `${iso}Z`.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

export function snapshotAgeTone(iso, thresholdDays = 30) {
  const age = daysAgo(iso);
  if (age == null) return 'neutral';
  return age >= thresholdDays ? 'warn' : 'ok';
}

export function humanizeSeconds(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return '—';
  const s = Number(sec);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((s % 3600) / 60);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
