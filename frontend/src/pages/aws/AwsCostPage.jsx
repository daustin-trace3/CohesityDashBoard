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

const chartOpts = {
  responsive: true, maintainAspectRatio: false, animation: false,
  plugins: { legend: { labels: { color: '#E5E5E5', boxWidth: 12, font: { size: 11 } } } },
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

  useEffect(() => {
    client.get('/aws/accounts').then(({ data }) => setAccounts(Array.isArray(data) ? data : data?.accounts || [])).catch(() => setAccounts([]));
  }, []);

  const load = useCallback(() => {
    const params = accountId ? { days, accountId } : { days };
    const usageParams = selectedDay ? { ...params, day: selectedDay } : params;
    return Promise.all([
      client.get('/aws/costs', { params }).then(({ data }) => setData(data)),
      client.get('/aws/costs/usage-types', { params: usageParams }).then(({ data }) => setUsageTypes(data?.rows || [])).catch(() => setUsageTypes([])),
      client.get('/aws/costs/instance-types', { params }).then(({ data }) => setInstanceTypes(data?.rows || [])).catch(() => setInstanceTypes([])),
    ]).then(() => setLastRefreshed(new Date()))
      .catch(() => { setData({ days: [], byService: [] }); toast({ type: 'error', title: 'Failed to load AWS costs' }); });
  }, [toast, days, accountId, selectedDay]);

  useEffect(() => { load(); }, [load]);

  const byDay = data?.days || [];
  const byService = data?.byService || [];

  // Day filter: service totals for one selected day, computed from the daily series.
  const serviceRows = useMemo(() => {
    if (!selectedDay) return byService.map((s) => ({ service: s.service, usd: s.mtdUsd }));
    const day = byDay.find((d) => d.day === selectedDay);
    return (day?.services || [])
      .map((s) => ({ service: s.service, usd: s.amountUsd || 0 }))
      .sort((a, b) => b.usd - a.usd);
  }, [selectedDay, byService, byDay]);
  const fmtDayLabel = (d) => `${Number(String(d).slice(5, 7))}/${Number(String(d).slice(8, 10))}`;

  const dailyBar = useMemo(() => {
    const topServices = byService.slice(0, 6).map((s) => s.service);
    const labels = byDay.map((d) => String(d.day).slice(5));
    const datasets = topServices.map((service, i) => ({
      label: service,
      data: byDay.map((d) => (d.services || []).find((s) => s.service === service)?.amountUsd || 0),
      backgroundColor: COST_COLORS[i % COST_COLORS.length],
      borderRadius: 2,
    }));
    const otherData = byDay.map((d) => {
      const total = (d.services || []).reduce((sum, s) => sum + (s.amountUsd || 0), 0);
      const known = (d.services || []).filter((s) => topServices.includes(s.service)).reduce((sum, s) => sum + (s.amountUsd || 0), 0);
      return Math.max(0, total - known);
    });
    if (otherData.some((v) => v > 0.005)) {
      datasets.push({ label: 'Other', data: otherData, backgroundColor: '#3A4450', borderRadius: 2 });
    }
    return { labels, datasets };
  }, [byDay, byService]);

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
          value={selectedDay}
          onChange={(e) => setSelectedDay(e.target.value)}
          className="bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-1.5 text-xs text-ink focus:border-brand/60 outline-none cursor-pointer"
        >
          <option value="">All days</option>
          {[...byDay].reverse().map((d) => <option key={d.day} value={d.day}>{fmtDayLabel(d.day)}</option>)}
        </select>
        <div className="flex items-center gap-1 mr-2">
          {[7, 30, 90].map((d) => (
            <button key={d} onClick={() => setDays(d)}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors cursor-pointer ${days === d ? 'bg-brand text-cohesity-black' : 'text-ink-muted hover:text-ink border border-cohesity-border'}`}>
              {d}d
            </button>
          ))}
        </div>
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <StatCard icon={DollarSign} label="MTD Spend" value={fmtUsd(data?.mtdUsd)} sub="month to date" tone="brand" />
        <StatCard icon={DollarSign} label="Day-over-Day" value={data?.deltaPct != null ? `${data.deltaPct > 0 ? '+' : ''}${data.deltaPct.toFixed(1)}%` : '—'}
          sub="vs previous day" trend={data?.deltaPct} tone={data?.deltaPct > 0 ? 'warn' : 'default'} />
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
          <p className="text-sm font-semibold text-ink">By Service {selectedDay ? `(${fmtDayLabel(selectedDay)})` : '(MTD)'}</p>
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
        <p className="text-[11px] text-ink-muted mb-3">Estimates divide the type's total cost evenly across currently running instances of that type</p>
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
