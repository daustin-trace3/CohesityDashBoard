import { useMemo } from 'react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler,
} from 'chart.js';
import { chartOpts, toDate } from '../helpers';
import { COLORS } from './layout';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

const TICK = '#94A3B3';
const GRID = 'rgba(255,255,255,0.06)';
const N = 24;

const series = (v) => {
  const a = Array.isArray(v) ? v.slice(-N) : [];
  return Array.from({ length: N }, (_, i) => {
    const x = a[i - (N - a.length)];
    return x == null || !Number.isFinite(Number(x)) ? null : Number(x);
  });
};

const LABELS = Array.from({ length: N }, (_, i) => (i === N - 1 ? 'now' : `-${N - 1 - i}h`));

function hourTitle(hours, idx) {
  const h = Array.isArray(hours) ? hours.slice(-N) : [];
  const d = toDate(h[idx - (N - h.length)]);
  return d ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}

function opts(hours, stacked) {
  return {
    ...chartOpts,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          title: (items) => (items[0] ? hourTitle(hours, items[0].dataIndex) : ''),
          label: (c) => `${c.dataset.label}: ${c.parsed.y == null ? '-' : c.parsed.y}`,
        },
      },
    },
    scales: {
      x: { ticks: { color: TICK, font: { size: 9 }, maxRotation: 0, autoSkip: false, callback: (v, i) => ([0, 6, 12, 18, 23].includes(i) ? (i === 23 ? 'now' : `-${23 - i}h`) : '') }, grid: { display: false } },
      y: { stacked, beginAtZero: true, ticks: { color: TICK, font: { size: 9 }, maxTicksLimit: 4, precision: 0 }, grid: { color: GRID } },
    },
  };
}

function Legend2({ items }) {
  return (
    <div className="flex gap-3 text-[11px] text-ink-muted">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center"><i className="inline-block w-2 h-2 rounded-sm mr-1.5" style={{ background: it.color }} />{it.label}</span>
      ))}
    </div>
  );
}

export default function TrendPanels({ trends }) {
  const t = trends && typeof trends === 'object' ? trends : {};
  const hours = t.hours;
  const sev = t.alertsBySeverity || {};
  const deg = t.degradation || {};

  const alerts = useMemo(() => ({
    labels: LABELS,
    datasets: [
      { label: 'Critical', data: series(sev.critical), borderColor: COLORS.crit, backgroundColor: 'rgba(248,113,113,0.55)', fill: 'origin' },
      { label: 'Warning', data: series(sev.warning), borderColor: COLORS.warn, backgroundColor: 'rgba(251,191,36,0.55)', fill: '-1' },
      { label: 'Info', data: series(sev.info), borderColor: COLORS.info, backgroundColor: 'rgba(96,165,250,0.55)', fill: '-1' },
    ].map((d) => ({ ...d, pointRadius: 0, pointHoverRadius: 3, borderWidth: 1.8, tension: 0.2 })),
  }), [hours, sev.critical, sev.warning, sev.info]);

  const links = useMemo(() => ({
    labels: LABELS,
    datasets: [
      { label: 'Links degraded', data: series(deg.linksDegraded), borderColor: COLORS.warn },
      { label: 'Ports down', data: series(deg.portsDown), borderColor: COLORS.crit },
    ].map((d) => ({ ...d, pointRadius: 0, pointHoverRadius: 3, borderWidth: 1.8, tension: 0.2, spanGaps: true })),
  }), [deg.linksDegraded, deg.portsDown]);

  const alertOpts = useMemo(() => opts(hours, true), [hours]);
  const linkOpts = useMemo(() => opts(hours, false), [hours]);

  return (
    <div>
      <div className="flex items-baseline justify-between mx-1 mb-2.5">
        <b className="text-[13px] font-bold text-ink">Steady</b>
        <span className="text-[11px] text-ink-muted">last 24 hours, hourly</span>
      </div>
      <div className="grid lg:grid-cols-2 gap-3.5">
        <div className="panel px-[18px] pt-3.5 pb-2.5">
          <div className="flex items-baseline justify-between mb-1.5">
            <b className="text-[13px] font-bold text-ink">Alerts by severity</b>
            <Legend2 items={[{ label: 'Critical', color: COLORS.crit }, { label: 'Warning', color: COLORS.warn }, { label: 'Info', color: COLORS.info }]} />
          </div>
          <div className="h-[140px]"><Line data={alerts} options={alertOpts} /></div>
        </div>
        <div className="panel px-[18px] pt-3.5 pb-2.5">
          <div className="flex items-baseline justify-between mb-1.5">
            <b className="text-[13px] font-bold text-ink">Links degraded and ports down</b>
            <Legend2 items={[{ label: 'Links degraded', color: COLORS.warn }, { label: 'Ports down', color: COLORS.crit }]} />
          </div>
          <div className="h-[140px]"><Line data={links} options={linkOpts} /></div>
        </div>
      </div>
    </div>
  );
}
