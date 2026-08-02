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
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/aws/costs', { params: { days } })
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ days: [], byService: [] }); toast({ type: 'error', title: 'Failed to load AWS costs' }); }), [toast, days]);

  useEffect(() => { load(); }, [load]);

  const byDay = data?.days || [];
  const byService = data?.byService || [];

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
          <div className="h-64"><Bar data={dailyBar} options={chartOpts} /></div>
        )}
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">By Service (MTD)</p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={140} />
        ) : byService.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No cost data yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Service</th>
                <th className="py-2 pr-3 text-right">MTD Spend</th>
              </tr></thead>
              <tbody>
                {byService.map((s) => (
                  <tr key={s.service} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{s.service}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtUsd(s.mtdUsd)}</td>
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
