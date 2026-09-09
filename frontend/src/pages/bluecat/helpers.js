export const BRAND = '#0057B8'; // BlueCat navy

export function fmtNum(n) {
  return n == null ? '—' : Number(n).toLocaleString();
}

export function fmtPct(p) {
  return p == null ? 'not enumerated' : `${Number(p).toFixed(1)}%`;
}

export function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).includes('T') ? iso : `${iso}Z`.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
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

export function severityTone(sev) {
  const s = String(sev || '').toLowerCase();
  return s === 'critical' ? 'crit' : s === 'warning' ? 'warn' : 'info';
}

export const GATEWAY_SOURCE_LABEL = {
  override: 'Override',
  bam: 'BAM',
  address: 'Address',
};

export function gatewaySourceLabel(src) {
  return GATEWAY_SOURCE_LABEL[src] || 'Unknown';
}

export function gatewaySourceTone(src) {
  if (src === 'override') return 'info';
  if (src === 'bam') return 'ok';
  if (src === 'address') return 'neutral';
  return 'neutral';
}

export function freePctTone(pct) {
  if (pct == null) return 'neutral';
  if (pct <= 0) return 'crit';
  if (pct < 10) return 'warn';
  return 'ok';
}

export function freeStaticTone(free) {
  if (free == null) return 'neutral';
  if (free <= 0) return 'crit';
  if (free < 20) return 'warn';
  return 'ok';
}

export function connectedTone(connected) {
  if (connected === true) return 'ok';
  if (connected === false) return 'crit';
  return 'neutral';
}

export function connectedLabel(connected) {
  if (connected === true) return 'Connected';
  if (connected === false) return 'Disconnected';
  return 'Unknown';
}

export function deployStatusTone(status) {
  if (!status) return 'neutral';
  return /FAIL|INVALID/i.test(status) ? 'crit' : 'ok';
}
