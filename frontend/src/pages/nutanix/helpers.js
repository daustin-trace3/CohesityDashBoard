export const BRAND = '#7855FA'; // Nutanix purple

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

// ppm = parts-per-million. Percentage fields: divide by 10,000 (1,000,000ppm = 100%).
export function ppmPct(ppm) {
  if (ppm == null) return null;
  const n = Number(ppm);
  return Number.isFinite(n) && n >= 0 ? n / 10000 : null;
}

// Ratio fields (e.g. data-reduction): 1,000,000ppm = 1.0x.
export function ppmRatio(ppm) {
  if (ppm == null) return null;
  const n = Number(ppm);
  return Number.isFinite(n) && n >= 0 ? n / 1e6 : null;
}

export function fmtRatio(ppm) {
  const r = ppmRatio(ppm);
  return r == null ? '—' : `${r.toFixed(2)}:1`;
}

export function usageTone(pct) {
  if (pct == null) return 'neutral';
  if (pct > 90) return 'crit';
  if (pct > 80) return 'warn';
  return 'ok';
}

export function severityTone(sev) {
  const s = String(sev || '').toLowerCase();
  return s === 'critical' ? 'crit' : s === 'warning' ? 'warn' : 'info';
}

export function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).includes('T') ? iso : `${iso}Z`.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

export function fmtUsecs(usecs) {
  if (usecs == null) return '—';
  const n = Number(usecs);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return new Date(n / 1000).toLocaleString();
}

export function powerTone(p) {
  const s = String(p || '').toUpperCase();
  if (s === 'ON' || s === 'POWERED_ON') return 'ok';
  if (s === 'OFF' || s === 'POWERED_OFF') return 'neutral';
  return 'warn';
}

export function powerLabel(p) {
  const s = String(p || '—').toUpperCase();
  return s.replace(/^POWERED_/, '');
}

// Resiliency: CE / single-node clusters skip the fault-tolerance rule entirely.
export function ftTone(cluster) {
  if (cluster.num_nodes != null && cluster.num_nodes <= 1) return 'neutral';
  if (cluster.ft_failures_tolerable == null) return 'neutral';
  return cluster.ft_failures_tolerable === 0 ? 'crit' : 'ok';
}

export function ftLabel(cluster) {
  if (cluster.num_nodes != null && cluster.num_nodes <= 1) return 'N/A (single-node)';
  if (cluster.ft_failures_tolerable == null) return '—';
  return `${cluster.ft_failures_tolerable} failure${cluster.ft_failures_tolerable === 1 ? '' : 's'} tolerable`;
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

export function secsToHuman(s) {
  if (s == null) return '—';
  const n = Number(s);
  if (!Number.isFinite(n)) return '—';
  if (n < 60) return `${Math.round(n)}s`;
  if (n < 3600) return `${Math.round(n / 60)}m`;
  if (n < 86400) return `${Math.round(n / 3600)}h`;
  return `${Math.round(n / 86400)}d`;
}
