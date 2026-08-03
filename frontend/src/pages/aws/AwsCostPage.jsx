import { useEffect, useState, useCallback, useMemo } from 'react';
import { DollarSign } from 'lucide-react';
import { Bar } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, BarElement, Tooltip, Legend,
} from 'chart.js';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtUsd } from './helpers';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

const COST_COLORS = ['#FF9900', '#0091DA', '#6CB33F', '#D4A24E', '#C75D5D', '#9B6CD4', '#5A6572'];

// External HTML tooltip: two-column rows (service | right-aligned $) + total.
function renderCostTooltip(context) {
  const { chart, tooltip } = context;
  const parent = chart.canvas.parentNode;
  let el = parent.querySelector('.aws-cost-tt');
  if (!el) {
    el = document.createElement('div');
    el.className = 'aws-cost-tt';
    Object.assign(el.style, {
      position: 'absolute', pointerEvents: 'none', zIndex: 30,
      background: 'rgba(20, 22, 26, 0.97)', border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: '8px', padding: '10px 12px', minWidth: '240px',
      font: '12px ui-sans-serif, system-ui, sans-serif', color: '#E5E5E5',
      transition: 'opacity 0.08s ease', opacity: 0,
    });
    parent.style.position = 'relative';
    parent.appendChild(el);
  }
  if (tooltip.opacity === 0 || !tooltip.dataPoints?.length) {
    el.style.opacity = 0;
    return;
  }
  const rows = tooltip.dataPoints.map((p) => {
    const color = p.dataset.backgroundColor;
    return `<div style="display:flex;align-items:center;justify-content:space-between;gap:18px;padding:1.5px 0">
      <span style="display:inline-flex;align-items:center;gap:6px;min-width:0">
        <span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${color};flex-shrink:0"></span>
        <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:210px">${p.dataset.label}</span>
      </span>
      <span style="font-variant-numeric:tabular-nums;text-align:right;flex-shrink:0">$${(p.parsed?.y || 0).toFixed(2)}</span>
    </div>`;
  }).join('');
  const total = tooltip.dataPoints.reduce((s, p) => s + (p.parsed?.y || 0), 0);
  el.innerHTML = `
    <div style="font-weight:700;margin-bottom:6px">${tooltip.title?.[0] ?? ''}</div>
    ${rows}
    <div style="display:flex;justify-content:space-between;gap:18px;margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.14);font-weight:700">
      <span>Total</span>
      <span style="font-variant-numeric:tabular-nums">$${total.toFixed(2)}</span>
    </div>`;
  const maxLeft = parent.clientWidth - el.offsetWidth - 4;
  el.style.left = `${Math.max(4, Math.min(tooltip.caretX + 12, maxLeft))}px`;
  el.style.top = `${Math.max(4, Math.min(tooltip.caretY - el.offsetHeight / 2, parent.clientHeight - el.offsetHeight - 4))}px`;
  el.style.opacity = 1;
}

const chartOpts = {
  responsive: true, maintainAspectRatio: false, animation: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: { labels: { color: '#E5E5E5', boxWidth: 12, font: { size: 11 } } },
    // AWS Cost Explorer-style hover: every service for the day, sorted by
    // spend, zero lines hidden, day total under a divider. Rendered as an
    // external HTML tooltip because the canvas tooltip can't right-align a
    // dollar column.
    tooltip: {
      enabled: false,
      mode: 'index',
      intersect: false,
      itemSort: (a, b) => (b.parsed?.y || 0) - (a.parsed?.y || 0),
      filter: (item) => (item.parsed?.y || 0) >= 0.005,
      external: renderCostTooltip,
    },
  },
  scales: {
    x: { stacked: true, ticks: { color: '#E5E5E5', maxTicksLimit: 12, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
    y: { stacked: true, ticks: { color: '#E5E5E5', font: { size: 10 }, callback: (v) => `$${v}` }, grid: { color: 'rgba(255,255,255,0.1)' } },
  },
};

export default function AwsCostPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [days, setDays] = useState(30);
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [usageTypes, setUsageTypes] = useState(null);
  const [instanceTypes, setInstanceTypes] = useState(null);
  const [selectedDay, setSelectedDay] = useState('');
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [month, setMonth] = useState('');

  useEffect(() => {
    client.get('/aws/accounts').then(({ data }) => setAccounts(Array.isArray(data) ? data : data?.accounts || [])).catch(() => setAccounts([]));
  }, []);

  const load = useCallback(() => {
    const base = accountId ? { days, accountId } : { days };
    const params = month ? { ...base, month } : base;
    const usageParams = selectedDay ? { ...params, day: selectedDay } : params;
    return Promise.all([
      client.get('/aws/costs', { params }).then(({ data }) => setData(data)),
      client.get('/aws/costs/usage-types', { params: usageParams }).then(({ data }) => setUsageTypes(data?.rows || [])).catch(() => setUsageTypes([])),
      client.get('/aws/costs/instance-types', { params: base }).then(({ data }) => setInstanceTypes(data?.rows || [])).catch(() => setInstanceTypes([])),
    ]).then(() => setLastRefreshed(new Date()))
      .catch(() => { setData({ days: [], byService: [] }); toast({ type: 'error', title: 'Failed to load AWS costs' }); });
  }, [toast, days, accountId, selectedDay, month]);

  useEffect(() => { load(); }, [load]);

  const byDay = data?.days || [];
  const byService = data?.byService || [];
  const months = data?.months || [];

  const fmtMonthLabel = (m) => {
    const [y, mo] = String(m).split('-');
    return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  };

  // Day filter: service totals for one selected day, computed from the daily series.
  const serviceRows = useMemo(() => {
    if (!selectedDay) return byService.map((s) => ({ service: s.service, usd: s.mtdUsd }));
    const day = byDay.find((d) => d.day === selectedDay);
    return (day?.services || [])
      .map((s) => ({ service: s.service, usd: s.amountUsd || 0 }))
      .sort((a, b) => b.usd - a.usd);
  }, [selectedDay, byService, byDay]);
  const fmtDayLabel = (d) => `${Number(String(d).slice(5, 7))}/${Number(String(d).slice(8, 10))}`;

  const isMonthly = days === 365 && !month;

  // 12m mode: aggregate the daily series into months client-side (day granularity doesn't apply).
  const byMonth = useMemo(() => {
    if (!isMonthly) return [];
    const months = new Map();
    byDay.forEach((d) => {
      const month = String(d.day).slice(0, 7);
      if (!months.has(month)) months.set(month, new Map());
      const svcMap = months.get(month);
      (d.services || []).forEach((s) => {
        svcMap.set(s.service, (svcMap.get(s.service) || 0) + (s.amountUsd || 0));
      });
    });
    return [...months.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, svcMap]) => ({
        month,
        services: [...svcMap.entries()].map(([service, amountUsd]) => ({ service, amountUsd })),
      }));
  }, [isMonthly, byDay]);

  const dailyBar = useMemo(() => {
    const buckets = isMonthly ? byMonth : byDay;
    const bucketServices = isMonthly ? (b) => b.services : (b) => b.services || [];
    const topServices = byService.slice(0, 6).map((s) => s.service);
    const labels = isMonthly ? byMonth.map((m) => m.month) : byDay.map((d) => String(d.day).slice(5));
    const datasets = topServices.map((service, i) => ({
      label: service,
      data: buckets.map((b) => bucketServices(b).find((s) => s.service === service)?.amountUsd || 0),
      backgroundColor: COST_COLORS[i % COST_COLORS.length],
      borderRadius: 2,
    }));
    const otherData = buckets.map((b) => {
      const svcs = bucketServices(b);
      const total = svcs.reduce((sum, s) => sum + (s.amountUsd || 0), 0);
      const known = svcs.filter((s) => topServices.includes(s.service)).reduce((sum, s) => sum + (s.amountUsd || 0), 0);
      return Math.max(0, total - known);
    });
    if (otherData.some((v) => v > 0.005)) {
      datasets.push({ label: 'Other', data: otherData, backgroundColor: '#3A4450', borderRadius: 2 });
    }
    return { labels, datasets };
  }, [byDay, byService, isMonthly, byMonth]);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={DollarSign} title="AWS Cost" description="Daily spend by service across all registered AWS accounts">
        <select
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          className="bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-1.5 text-xs text-ink focus:border-brand/60 outline-none cursor-pointer"
        >
          <option value="">All accounts</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <select
          value={month}
          onChange={(e) => { setMonth(e.target.value); setSelectedDay(''); }}
          className="bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-1.5 text-xs text-ink focus:border-brand/60 outline-none cursor-pointer"
        >
          <option value="">Current period</option>
          {months.map((m) => <option key={m} value={m}>{fmtMonthLabel(m)}</option>)}
        </select>
        {!isMonthly && (
          <select
            value={selectedDay}
            onChange={(e) => setSelectedDay(e.target.value)}
            className="bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-1.5 text-xs text-ink focus:border-brand/60 outline-none cursor-pointer"
          >
            <option value="">All days</option>
            {[...byDay].reverse().map((d) => <option key={d.day} value={d.day}>{fmtDayLabel(d.day)}</option>)}
          </select>
        )}
        <div className="flex items-center gap-1 mr-2">
          {[7, 30, 90].map((d) => (
            <button key={d} disabled={!!month} onClick={() => setDays(d)}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${month ? 'opacity-40 cursor-not-allowed text-ink-muted border border-cohesity-border' : 'cursor-pointer'} ${!month && days === d ? 'bg-brand text-cohesity-black' : 'text-ink-muted hover:text-ink border border-cohesity-border'}`}>
              {d}d
            </button>
          ))}
          <button disabled={!!month} onClick={() => { setDays(365); setSelectedDay(''); }}
            className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${month ? 'opacity-40 cursor-not-allowed text-ink-muted border border-cohesity-border' : 'cursor-pointer'} ${!month && days === 365 ? 'bg-brand text-cohesity-black' : 'text-ink-muted hover:text-ink border border-cohesity-border'}`}>
            12m
          </button>
        </div>
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <StatCard icon={DollarSign} label={month ? `${fmtMonthLabel(month)} Spend` : 'MTD Spend'} value={fmtUsd(data?.mtdUsd)}
          sub={month ? 'month total' : 'month to date'} tone="brand" />
        <StatCard icon={DollarSign} label="Day-over-Day" value={month ? '—' : (data?.deltaPct != null ? `${data.deltaPct > 0 ? '+' : ''}${data.deltaPct.toFixed(1)}%` : '—')}
          sub="vs previous day" trend={month ? null : data?.deltaPct} tone={!month && data?.deltaPct > 0 ? 'warn' : 'default'} />
      </div>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Daily Spend by Service</p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={220} />
        ) : byDay.length === 0 ? (
          <div className="text-sm text-ink-muted py-8 text-center">No cost data yet.</div>
        ) : (
          <div className="h-64">
            <Bar data={dailyBar} options={{
              ...chartOpts,
              onClick: (evt, elements) => {
                if (isMonthly) return;
                if (elements?.length) {
                  const day = byDay[elements[0].index]?.day;
                  if (day) setSelectedDay((cur) => (cur === day ? '' : day));
                }
              },
            }} />
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold text-ink">By Service {selectedDay ? `(${fmtDayLabel(selectedDay)})` : month ? `(${fmtMonthLabel(month)})` : '(MTD)'}</p>
          {selectedDay && (
            <button onClick={() => setSelectedDay('')}
              className="text-[11px] text-brand hover:underline cursor-pointer">Clear day filter</button>
          )}
        </div>
        {data == null ? (
          <LoadingPanel label="Loading…" height={140} />
        ) : serviceRows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No cost data{selectedDay ? ' for this day' : ' yet'}.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Service</th>
                <th className="py-2 pr-3 text-right">{selectedDay ? 'Day Spend' : 'MTD Spend'}</th>
              </tr></thead>
              <tbody>
                {serviceRows.map((s) => (
                  <tr key={s.service} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{s.service}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtUsd(s.usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink">Usage Type Breakdown {selectedDay ? `(${fmtDayLabel(selectedDay)})` : ''}</p>
        <p className="text-[11px] text-ink-muted mb-3">Decomposes bundled service lines like "EC2 - Other" into billable usage types</p>
        {usageTypes == null ? (
          <LoadingPanel label="Loading…" height={140} />
        ) : usageTypes.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No usage type data yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Usage Type</th>
                <th className="py-2 pr-3 text-right">Total</th>
              </tr></thead>
              <tbody>
                {usageTypes.map((u) => (
                  <tr key={u.usageType} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{u.usageType}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtUsd(u.totalUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </div>

      <div className="panel p-4 mt-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink">Instance Type Costs</p>
        <p className="text-[11px] text-ink-muted mb-3">
          Estimates divide the type's total cost evenly across currently running instances of that type
          {month ? ' — rolling window, not affected by the month filter' : ''}
        </p>
        {instanceTypes == null ? (
          <LoadingPanel label="Loading…" height={140} />
        ) : instanceTypes.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No instance type cost data yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Instance Type</th>
                <th className="py-2 pr-3 text-right">Total</th>
                <th className="py-2 pr-3 text-right">Running</th>
                <th className="py-2 pr-3 text-right">Est. $/Instance</th>
              </tr></thead>
              <tbody>
                {instanceTypes.map((i) => (
                  <tr key={i.instanceType} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{i.instanceType}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtUsd(i.totalUsd)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{i.runningCount ?? '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{i.estPerInstanceUsd != null ? `est. ${fmtUsd(i.estPerInstanceUsd)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
