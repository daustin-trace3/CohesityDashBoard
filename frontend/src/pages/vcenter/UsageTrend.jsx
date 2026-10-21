import { useEffect, useMemo, useState } from 'react';
import { Line } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip, Legend } from 'chart.js';
import client from '../../api/client';
import { fmtBytes } from './helpers';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip, Legend);

// Range picker choices: [days, label]. 24 hours and 7 days read raw samples,
// the longer ranges read the per-day rollups (average line, min to max band).
export const TREND_RANGES = [[1, '24 hours'], [7, '7 days'], [30, '30 days'], [90, '90 days'], [365, '365 days']];

const GHZ = 1000;
const BAND = 'rgba(0,145,218,0.14)';
const selectCls = 'bg-surface-overlay border border-cohesity-border rounded-lg px-2 py-1 text-xs text-ink focus:border-brand/60 outline-none';

const num = (v, digits = 1) => (v == null || !Number.isFinite(Number(v)) ? '-' : Number(v).toLocaleString(undefined, { maximumFractionDigits: digits }));

function labelFor(t, granularity) {
  const s = String(t);
  return granularity === 'day' ? s.slice(0, 10) : s.slice(5, 16).replace('T', ' ');
}

/** Datasets for one metric: a hidden min and max pair draws the band, the avg line sits on top. */
function metricData(points, granularity, name, color, pick) {
  const labels = points.map((p) => labelFor(p.t, granularity));
  const avg = points.map((p) => pick.avg(p));
  const base = { borderWidth: 2, tension: 0.25, pointRadius: 0, spanGaps: true };
  const datasets = [];
  if (granularity === 'day') {
    datasets.push({ label: 'Min', data: points.map((p) => pick.min(p)), borderColor: 'transparent', backgroundColor: 'transparent', pointRadius: 0, fill: false, order: 3 });
    datasets.push({ label: 'Max', data: points.map((p) => pick.max(p)), borderColor: 'transparent', backgroundColor: BAND, pointRadius: 0, fill: '-1', order: 3 });
  }
  datasets.push({ ...base, label: name, data: avg, borderColor: color, backgroundColor: color, fill: false, order: 1 });
  return { labels, datasets };
}

function optionsFor(unit, { pctAxis = false } = {}) {
  return {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    scales: {
      y: {
        beginAtZero: true, ...(pctAxis ? { suggestedMax: 100 } : {}),
        ticks: { callback: (v) => `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 })}${unit}` },
      },
      x: { ticks: { maxTicksLimit: 8 } },
    },
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${Number(c.parsed.y).toLocaleString(undefined, { maximumFractionDigits: 1 })}${unit}` } },
    },
  };
}

function ChartBox({ title, data, options, height }) {
  return (
    <div>
      <p className="text-[11px] text-ink-faint mb-1">{title}</p>
      <div style={{ height }}><Line data={data} options={options} /></div>
    </div>
  );
}

const pctOf = (n, d) => (n == null || !(d > 0) ? null : (n * 100) / d);

/**
 * Usage trend for one VM, host or datastore with a range picker. Fetches
 * /vcenter/capacity/{vm,host,datastore}-trends and draws the average with a
 * min to max band on daily ranges.
 */
export default function UsageTrend({ kind, vcenterId, name, ranges = TREND_RANGES, defaultDays = 30, chartHeight = 170 }) {
  const [days, setDays] = useState(defaultDays);
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!vcenterId || !name) { setData(null); return undefined; }
    let live = true;
    setData(null);
    setError(false);
    const key = kind === 'vm' ? 'vm' : kind === 'host' ? 'host' : 'datastore';
    const url = `/vcenter/capacity/${key}-trends?vcenterId=${vcenterId}&${key}=${encodeURIComponent(name)}&days=${days}`;
    client.get(url).then(({ data: j }) => { if (live) setData(j); }).catch(() => { if (live) { setData({ points: [] }); setError(true); } });
    return () => { live = false; };
  }, [kind, vcenterId, name, days]);

  const points = data?.points || [];
  const granularity = data?.granularity || 'hour';

  const charts = useMemo(() => {
    if (!points.length) return null;
    if (kind === 'vm') {
      return [
        ['Memory used (GB)', metricData(points, granularity, 'Memory used (GB)', '#0091DA', {
          avg: (p) => (p.memUsageMb == null ? null : p.memUsageMb / 1024), min: (p) => (p.memMinMb == null ? null : p.memMinMb / 1024), max: (p) => (p.memMaxMb == null ? null : p.memMaxMb / 1024),
        }), optionsFor(' GB')],
        ['CPU used (GHz)', metricData(points, granularity, 'CPU used (GHz)', '#6CB33F', {
          avg: (p) => (p.cpuUsageMhz == null ? null : p.cpuUsageMhz / GHZ), min: (p) => (p.cpuMinMhz == null ? null : p.cpuMinMhz / GHZ), max: (p) => (p.cpuMaxMhz == null ? null : p.cpuMaxMhz / GHZ),
        }), optionsFor(' GHz')],
      ];
    }
    if (kind === 'host') {
      return [
        ['Memory used (% of capacity)', metricData(points, granularity, 'Memory used (%)', '#0091DA', {
          avg: (p) => pctOf(p.memUsedBytes, p.memCapacityBytes), min: (p) => pctOf(p.memMinBytes, p.memCapacityBytes), max: (p) => pctOf(p.memMaxBytes, p.memCapacityBytes),
        }), optionsFor('%', { pctAxis: true })],
        ['CPU used (% of capacity)', metricData(points, granularity, 'CPU used (%)', '#6CB33F', {
          avg: (p) => pctOf(p.cpuUsedMhz, p.cpuCapacityMhz), min: (p) => pctOf(p.cpuMinMhz, p.cpuCapacityMhz), max: (p) => pctOf(p.cpuMaxMhz, p.cpuCapacityMhz),
        }), optionsFor('%', { pctAxis: true })],
      ];
    }
    return [
      ['Used space (%)', metricData(points, granularity, 'Used (%)', '#0091DA', {
        avg: (p) => p.usedPct, min: (p) => p.usedPct, max: (p) => p.usedPct,
      }), optionsFor('%', { pctAxis: true })],
    ];
  }, [kind, points, granularity]);

  const s = data?.summary;
  let summary = null;
  if (kind === 'vm' && s) {
    summary = `CPU avg ${num(s.cpuAvgMhz == null ? null : s.cpuAvgMhz / GHZ, 2)} GHz, max ${num(s.cpuMaxMhz == null ? null : s.cpuMaxMhz / GHZ, 2)} GHz. Memory avg ${num(s.memAvgMb == null ? null : s.memAvgMb / 1024)} GB, max ${num(s.memMaxMb == null ? null : s.memMaxMb / 1024)} GB.`;
  } else if (kind === 'host' && s) {
    summary = `CPU avg ${num(s.cpuAvgPct)}%, max ${num(s.cpuMaxPct)}%. Memory avg ${num(s.memAvgPct)}%, max ${num(s.memMaxPct)}%. Disconnected ${num(s.disconnectedPct)}% of samples, maintenance ${num(s.maintenancePct)}%.`;
  } else if (kind === 'datastore' && data?.points) {
    const g = data.growth;
    if (!g) summary = 'Growth needs at least 3 days of history.';
    else if (g.usedBytesPerDay > 0) summary = `${fmtBytes(g.usedBytesPerDay)}/day${g.daysToFull != null ? `, full in ${num(g.daysToFull, 0)} days` : ''} (${g.basisDays} days of history).`;
    else summary = `No growth (${g.basisDays} days of history).`;
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[11px] text-ink-faint mr-auto">
          {granularity === 'day' ? 'Daily average with min to max band' : 'Raw samples'}
        </span>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={selectCls} style={{ width: 'auto', cursor: 'pointer' }} aria-label="Trend range">
          {ranges.map(([d, l]) => <option key={d} value={d}>{l}</option>)}
        </select>
      </div>
      {data == null ? (
        <div className="text-xs text-ink-faint py-6 text-center">Loading history...</div>
      ) : error ? (
        <div className="text-xs text-ink-muted py-6 text-center">Could not load history.</div>
      ) : !charts ? (
        <div className="text-xs text-ink-muted py-6 text-center">No history in this window yet. Samples are written hourly.</div>
      ) : (
        <>
          <div className={`grid gap-3 ${charts.length > 1 ? 'md:grid-cols-2' : ''}`}>
            {charts.map(([title, cd, opts]) => <ChartBox key={title} title={title} data={cd} options={opts} height={chartHeight} />)}
          </div>
          {summary && <p className="text-[11px] text-ink-muted mt-2 tnum">{summary}</p>}
        </>
      )}
    </div>
  );
}

