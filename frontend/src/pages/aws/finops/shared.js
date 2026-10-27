// Small helpers shared by the FinOps pages: URL params, formatters, chart theme.
import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

export const CHART_TEXT = '#E5E5E5';
export const CHART_GRID = 'rgba(255,255,255,0.1)';
export const PALETTE = ['#FF9900', '#0091DA', '#6CB33F', '#D4A24E', '#C75D5D', '#9B6CD4', '#2FB5A8', '#E27BA6', '#5A6572'];

// One string URL param with replace-style updates; empty or default value removes the key.
export function useUrlParam(name, fallback = '') {
  const [sp, setSp] = useSearchParams();
  const value = sp.get(name) || fallback;
  const set = useCallback((v) => {
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      if (v == null || v === '' || v === fallback) next.delete(name); else next.set(name, v);
      return next;
    }, { replace: true });
  }, [setSp, name, fallback]);
  return [value, set];
}

// Compact money for chart ticks and tiles: $1.20k, $12.3k, $1.20M.
export function usdShort(n) {
  if (n == null || !Number.isFinite(Number(n))) return '-';
  const v = Number(n);
  const a = Math.abs(v);
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `$${(v / 1e3).toFixed(1)}k`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(2)}k`;
  return `$${v.toFixed(a < 10 ? 2 : 0)}`;
}

export const pct1 = (p) => (p == null || !Number.isFinite(Number(p)) ? '-' : `${Number(p).toFixed(1)}%`);
export const signedPct = (p) => (p == null || !Number.isFinite(Number(p)) ? '-' : `${p > 0 ? '+' : ''}${Number(p).toFixed(1)}%`);
export const num2 = (n) => (n == null || !Number.isFinite(Number(n)) ? '-' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));

export function monthLabel(m) {
  const [y, mo] = String(m || '').split('-');
  if (!y || !mo) return String(m || '');
  return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

export const BUDGET_TONE = { ok: 'ok', warn: 'warn', forecast_warn: 'info', crit: 'crit' };
export const BUDGET_LABEL = { ok: 'On track', warn: 'Warning', forecast_warn: 'Forecast over', crit: 'Exceeded' };
export const BUDGET_COLOR = { ok: '#6CB33F', warn: '#D4A24E', forecast_warn: '#0091DA', crit: '#C75D5D' };

export const CAP_LABELS = {
  cost_tags: 'Tag spend', tag_keys: 'Tag keys', linked_accounts: 'Linked accounts', forecast: 'Forecast',
  sp_utilization: 'SP utilization', sp_coverage: 'SP coverage', ri_utilization: 'RI utilization', ri_coverage: 'RI coverage',
  anomalies: 'Anomaly detection', rightsizing: 'Rightsizing', sp_recommendation: 'SP purchase rec', cost_resources: 'Resource-level cost',
};

export const selectCls = 'bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-1.5 text-xs text-ink focus:border-brand/60 outline-none cursor-pointer';
export const thCls = 'text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border';

export function chartOptions({ stacked = false, money = true, legend = true, unit = '' } = {}) {
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: legend ? { labels: { color: CHART_TEXT, boxWidth: 10, font: { size: 11 } } } : { display: false },
      tooltip: {
        callbacks: {
          label: (it) => `${it.dataset.label}: ${money ? `$${Number(it.parsed.y || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : `${Number(it.parsed.y || 0).toFixed(2)}${unit}`}`,
        },
      },
    },
    scales: {
      x: { stacked, ticks: { color: CHART_TEXT, maxTicksLimit: 12, font: { size: 10 } }, grid: { color: CHART_GRID } },
      y: { stacked, ticks: { color: CHART_TEXT, font: { size: 10 }, callback: (v) => (money ? usdShort(v) : `${v}${unit}`) }, grid: { color: CHART_GRID } },
    },
  };
}

// Capabilities behind a page that are denied or not enabled (ids start with one of the prefixes).
export function deniedCaps(caps, prefixes) {
  return (caps || []).filter((c) => prefixes.some((p) => String(c.capability).startsWith(p)) && c.status && c.status !== 'ok' && c.status !== 'unknown');
}
