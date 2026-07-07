import { useMemo } from 'react';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement,
  Filler, Tooltip as ChartTooltip, Legend,
} from 'chart.js';
import { Line } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, ChartTooltip, Legend);

// Matches the chart.js theming used on the Cohesity pages.
const CHART = {
  grid: '#1F2B37',
  tick: '#64748B',
  tooltipBg: '#1E2A36',
  tooltipBorder: '#2A3845',
  titleColor: '#E8EDF2',
  bodyColor: '#94A3B3',
};

/**
 * Themed multi-series line chart (chart.js) shared by the storage overview
 * pages so charts are uniform with the Cohesity dashboard.
 *
 * @param {string[]} labels  x-axis labels
 * @param {{label,data,color,fill?}[]} datasets
 * @param {string} unit      suffix shown in the tooltip (e.g. ' TB', ' ms')
 * @param {(v:number)=>string} format  optional value formatter (axis + tooltip)
 */
export default function TrendChart({ labels, datasets, unit = '', height = 200, format }) {
  const fmt = format || ((v) => `${v}`);

  const data = useMemo(() => ({
    labels,
    datasets: datasets.map((d) => ({
      label: d.label,
      data: d.data,
      borderColor: d.color,
      backgroundColor: d.fill ? `${d.color}22` : d.color,
      fill: !!d.fill,
      tension: 0.25,
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 3,
    })),
  }), [labels, datasets]);

  const options = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: CHART.tick, boxWidth: 10, boxHeight: 10, font: { size: 11 }, usePointStyle: true } },
      tooltip: {
        backgroundColor: CHART.tooltipBg, borderColor: CHART.tooltipBorder, borderWidth: 1,
        titleColor: CHART.titleColor, bodyColor: CHART.bodyColor, padding: 10,
        callbacks: { label: (item) => `${item.dataset.label}: ${fmt(item.parsed.y)}${unit}` },
      },
    },
    scales: {
      x: { ticks: { color: CHART.tick, font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 }, grid: { color: CHART.grid } },
      y: { ticks: { color: CHART.tick, font: { size: 10 }, callback: (v) => fmt(v) }, grid: { color: CHART.grid }, beginAtZero: false },
    },
  }), [unit, fmt]);

  return <div style={{ height }}><Line data={data} options={options} /></div>;
}
