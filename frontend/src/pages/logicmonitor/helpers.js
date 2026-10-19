import { useEffect, useRef } from 'react';
import client from '../../api/client';

// PLACEHOLDER brand colour until Doug supplies the LogicMonitor logo. Keep
// this the only frontend copy (the backend manifest holds the other).
export const BRAND = '#1A73E8';

export const DASH = '-';

export function fmtNum(n) {
  return n == null || n === '' ? DASH : Number(n).toLocaleString();
}

export function fmtPct(n, digits = 0) {
  if (n == null || !Number.isFinite(Number(n))) return DASH;
  return `${Number(n).toFixed(digits)}%`;
}

export function fmtMs(n) {
  if (n == null || !Number.isFinite(Number(n))) return DASH;
  const v = Number(n);
  return v >= 100 ? `${Math.round(v)} ms` : `${v.toFixed(1)} ms`;
}

export function fmtMbps(n) {
  if (n == null || !Number.isFinite(Number(n))) return DASH;
  const v = Number(n);
  if (v >= 1000) return `${(v / 1000).toFixed(2)} Gbps`;
  return `${v.toFixed(v >= 10 ? 0 : 2)} Mbps`;
}

export function fmtSpeed(bps) {
  if (bps == null || !Number.isFinite(Number(bps)) || Number(bps) <= 0) return DASH;
  const v = Number(bps);
  if (v >= 1e9) return `${+(v / 1e9).toFixed(1)}G`;
  if (v >= 1e6) return `${+(v / 1e6).toFixed(0)}M`;
  if (v >= 1e3) return `${+(v / 1e3).toFixed(0)}K`;
  return `${v}`;
}

// Route timestamps carry a zone; a zoneless SQLite string is treated as UTC.
export function toDate(iso) {
  if (!iso) return null;
  if (typeof iso === 'number') return new Date(iso > 1e11 ? iso : iso * 1000);
  const s = String(iso);
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) || !/\d\d:\d\d/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtWhen(iso) {
  const d = toDate(iso);
  return d ? d.toLocaleString() : (iso ? String(iso) : DASH);
}

export function fmtShortTime(iso) {
  const d = toDate(iso);
  if (!d) return '';
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtDuration(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return DASH;
  const s = Number(seconds);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

// sinceMs is read two ways because the contract does not pin it: a value
// above 1e11 is an epoch in ms (how long ago), smaller is a duration in ms.
export function fmtSince(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return DASH;
  const v = Number(ms);
  const dur = v > 1e11 ? Date.now() - v : v;
  return dur < 0 ? DASH : fmtDuration(dur / 1000);
}

export function hostStatusTone(s) {
  const v = String(s || '').toLowerCase();
  if (v === 'normal') return 'ok';
  if (v === 'dead') return 'crit';
  if (v === 'dead-collector') return 'warn';
  return 'neutral';
}

export function hostStatusLabel(s) {
  const v = String(s || '').toLowerCase();
  if (v === 'normal') return 'Normal';
  if (v === 'dead') return 'Dead';
  if (v === 'dead-collector') return 'Dead Collector';
  return s ? String(s) : 'Unknown';
}

export function severityTone(sev) {
  const s = String(sev || '').toLowerCase();
  if (s === 'critical') return 'crit';
  if (s === 'warning' || s === 'warn' || s === 'error') return 'warn';
  if (s === 'info') return 'info';
  return 'neutral';
}

export function statusTextTone(s) {
  const v = String(s || '').toLowerCase();
  if (v === 'up') return 'ok';
  if (v === 'down') return 'crit';
  if (v === 'other') return 'warn';
  return 'neutral';
}

export function anomalyTone(a, status) {
  if (a === 'down' || String(status).toLowerCase() === 'down') return 'crit';
  if (a === 'latency' || a === 'loss') return 'warn';
  if (String(status).toLowerCase() === 'up') return 'ok';
  return 'neutral';
}

export function pollStatusMeta(s) {
  if (s === 'error') return { tone: 'crit', label: 'Error' };
  if (s === 'partial') return { tone: 'warn', label: 'Partial' };
  if (s === 'success') return { tone: 'ok', label: 'Success' };
  return { tone: 'neutral', label: 'Pending' };
}

export function titleCase(v) {
  if (!v) return DASH;
  return String(v).split(/[-_\s]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export const TONE_COLOR = { ok: '#3FB950', warn: '#D4A24E', crit: '#C75D5D', info: '#4C9BE8', neutral: '#6B7280' };

export const chartOpts = {
  responsive: true, maintainAspectRatio: false, animation: false,
  plugins: { legend: { labels: { color: '#E5E5E5', boxWidth: 12, font: { size: 11 } } } },
  scales: {
    x: { ticks: { color: '#E5E5E5', maxTicksLimit: 8, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
    y: { ticks: { color: '#E5E5E5', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
  },
};

export const PALETTE = ['#1A73E8', '#3FB950', '#D4A24E', '#8A63D2', '#E8794C', '#5FC9C9', '#C75D5D', '#B5B5B5'];

// Re-runs fn every ms while the tab is visible; a hidden tab does no work and
// coming back refreshes at once (OpsAgentPage rule).
export function useVisibleInterval(fn, ms) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!ms) return undefined;
    const t = setInterval(() => { if (!document.hidden) ref.current(); }, ms);
    const onVis = () => { if (!document.hidden) ref.current(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [ms]);
}

export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const today = () => new Date().toISOString().slice(0, 10);

// CSV routes go through the API client (tenant header, session) as a blob.
export async function downloadCsv(path, params, name) {
  const { data } = await client.get(path, { params, responseType: 'blob' });
  saveBlob(data, `${name}-${today()}.csv`);
}

export async function postCsv(path, body, name) {
  const { data } = await client.post(path, body, { responseType: 'blob' });
  saveBlob(data, `${name}-${today()}.csv`);
}

export function parseList(v) {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
}

// ICC platform ids as they arrive on endpoint rows (endpointPlatform).
const PLATFORM_LABELS = {
  vcenter: 'vCenter', dell: 'Dell', unifi: 'UniFi', netapp: 'NetApp', pure: 'Pure', cohesity: 'Cohesity',
  logicmonitor: 'LogicMonitor', nutanix: 'Nutanix', proxmox: 'Proxmox', aws: 'AWS', brocade: 'Brocade', zerto: 'Zerto',
};
export function platformLabel(id) {
  if (!id) return DASH;
  return PLATFORM_LABELS[String(id).toLowerCase()] || titleCase(id);
}

export function confidenceTone(c) {
  if (c === 'high') return 'ok';
  if (c === 'medium') return 'info';
  return 'neutral';
}

// Site, circuit and path states arrive as ok | warning | critical (reachability
// rows may say degraded or down); one mapping serves every round 3 panel.
export function stateTone(s) {
  const v = String(s || '').toLowerCase();
  if (v === 'ok' || v === 'up' || v === 'normal') return 'ok';
  if (v === 'warning' || v === 'warn' || v === 'degraded' || v === 'latency' || v === 'loss') return 'warn';
  if (v === 'critical' || v === 'crit' || v === 'down' || v === 'dead') return 'crit';
  return 'neutral';
}

export function stateLabel(s) {
  const v = String(s || '').toLowerCase();
  if (v === 'ok') return 'OK';
  if (v === 'warning' || v === 'degraded') return 'Warning';
  if (v === 'critical') return 'Critical';
  return s ? titleCase(s) : 'Unknown';
}

const TONE_RANK = { crit: 3, warn: 2, ok: 1, neutral: 0 };
export const stateRank = (s) => TONE_RANK[stateTone(s)] ?? 0;
export function worstState(states) {
  let best = null;
  for (const s of states || []) {
    if (s == null) continue;
    if (best == null || stateRank(s) > stateRank(best)) best = s;
  }
  return best;
}

// "dal-dist-01 Te1/0/3: errors growing" from a blame object, or '' when none.
export function blameText(b) {
  if (!b || typeof b !== 'object') return '';
  const where = [b.deviceName, b.port].filter(Boolean).join(' ');
  if (!where) return '';
  return b.reason ? `${where}: ${b.reason}` : where;
}

export const arr = (v) => (Array.isArray(v) ? v : []);

// Readable names for the latency watch issue types (round 9).
export const ISSUE_TYPE_LABELS = {
  'latency-degrading': 'Latency degrading',
  'loss-degrading': 'Packet loss degrading',
  'latency-pattern': 'Repeating latency spikes',
  'latency-drift': 'Latency baseline drift',
  'cloud-circuit-down': 'Cloud circuit down',
  'cloud-circuit-saturated': 'Cloud circuit saturated',
  // Round 11 (voice, Zscaler, ISE).
  'voice-sbc-degraded': 'SBC degraded',
  'voice-sip-errors': 'SIP errors',
  'ise-cert-expiring': 'ISE certificate expiring',
  'ise-node-down': 'ISE node down',
  'zpa-connector-down': 'ZPA connector down',
  'zpa-port-exhaustion': 'ZPA port exhaustion',
  'asa-license-unauthorized': 'ASA license unauthorized',
  // Rounds 9 to 11 (Cohesity, servers, topology coverage, cloud).
  'cohesity-node-down': 'Cohesity node down',
  'cohesity-service-down': 'Cohesity service down',
  'cohesity-hardware-fault': 'Cohesity hardware fault',
  'cohesity-capacity-high': 'Cohesity capacity high',
  'server-filesystem-full': 'Filesystem full',
  'server-service-stopped': 'Service stopped',
  'server-nfs-mount-down': 'NFS mount down',
  'unmonitored-neighbor': 'Unmonitored neighbours',
  // Round 11 (applications and appliances).
  'app-service-down': 'Application service down',
  'app-capacity-high': 'Application capacity high',
  'app-queue-high': 'Application queue high',
  // Round 12 (raw rules and uncovered datapoints).
  'raw-threshold': 'Raw datapoint threshold',
  'device-ping-loss': 'Ping loss',
  'ntp-unsynced': 'NTP not synchronised',
  'stack-member-degraded': 'Stack member degraded',
  'device-rebooted': 'Device rebooted',
  'filesystem-inaccessible': 'Filesystem inaccessible',
};
export const issueTypeLabel = (t) => ISSUE_TYPE_LABELS[t] || t;

// Latency watch episode state and outcome, for chips and badges.
export const EPISODE_STATE_TONE = { watching: 'info', degrading: 'warn', critical: 'crit', closed: 'neutral' };
export const EPISODE_OUTCOME_LABEL = { 'one-off': 'One-off', sustained: 'Sustained', escalated: 'Escalated' };
