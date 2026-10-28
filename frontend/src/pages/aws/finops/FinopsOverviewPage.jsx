import { useEffect, useState, useCallback, useMemo, Fragment } from 'react';
import { Link } from 'react-router-dom';
import { Coins, ChevronRight, ChevronDown } from 'lucide-react';
import { Bar, Doughnut } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement, Filler, Tooltip, Legend,
} from 'chart.js';
import client from '../../../api/client';
import { useToast } from '../../../components/ui/Toaster';
import { PageHeader, Panel, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../../components/ui/primitives';
import { fmtUsd } from '../helpers';
import FinopsTabs from './FinopsTabs';
import { getOverview, getComparison, errMsg } from './finopsApi';
import KpiBand from './KpiBand';
import MetricToggle from './MetricToggle';
import BudgetBar from './BudgetBar';
import {
  useUrlParam, usdShort, pct1, signedPct, monthLabel, chartOptions, PALETTE, CHART_TEXT, selectCls, thCls,
} from './shared';

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement, Filler, Tooltip, Legend);

const DONUT_OPTS = {
  responsive: true, maintainAspectRatio: false, animation: false, cutout: '62%',
  plugins: {
    legend: { position: 'right', labels: { color: CHART_TEXT, boxWidth: 10, font: { size: 11 } } },
    tooltip: { callbacks: { label: (it) => `${it.label}: $${Number(it.parsed || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}` } },
  },
};

export default function FinopsOverviewPage() {
  const { toast } = useToast();
  const [metricParam, setMetricParam] = useUrlParam('metric', '');
  const [accountId, setAccountId] = useUrlParam('accountId', '');
  const [accounts, setAccounts] = useState([]);
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [comparison, setComparison] = useState(null);
  const [openMover, setOpenMover] = useState(null);

  useEffect(() => {
    client.get('/aws/accounts').then(({ data: d }) => setAccounts(Array.isArray(d) ? d : d?.accounts || [])).catch(() => setAccounts([]));
  }, []);

  const load = useCallback(() => {
    const params = {};
    if (metricParam) params.metric = metricParam;
    if (accountId) params.accountId = accountId;
    return getOverview(params)
      .then((d) => { setData(d || {}); setLastRefreshed(new Date()); })
      .catch((err) => { setData({}); toast({ type: 'error', title: 'Failed to load FinOps overview', message: errMsg(err, '') }); });
  }, [metricParam, accountId, toast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { getComparison().then(setComparison).catch(() => setComparison(null)); }, []);

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const metric = data?.metric || metricParam || 'amortized';
  const kpis = data?.kpis || {};
  const mix = data?.mix || [];
  const trend = data?.trend || [];
  const movers = data?.topMovers || [];
  const budgets = data?.budgets || [];
  const anomalies = data?.anomalies || [];
  const cmpRows = comparison?.rows || [];
  const cmpCaption = `AWS driver analysis, ${comparison?.comparisonMonth || '-'} vs ${comparison?.baselineMonth || '-'}`;

  const tiles = useMemo(() => {
    const spark = trend.map((t) => t.usd).filter((v) => v != null).slice(-8);
    return [
      { label: `MTD (${metric})`, value: fmtUsd(kpis.mtdUsd), tone: 'neutral',
        sub: kpis.momPct != null ? `${signedPct(kpis.momPct)} vs last month to date` : (data?.month || undefined) },
      { label: 'Forecast, end of month', value: kpis.forecastUsd != null ? fmtUsd(kpis.forecastUsd) : '-',
        sub: kpis.forecastUsd != null
          ? `${usdShort(kpis.forecastLowUsd)} to ${usdShort(kpis.forecastHighUsd)} (${kpis.forecastSource === 'ce' ? 'Cost Explorer' : 'linear run rate'})`
          : 'no forecast yet',
        title: kpis.forecastGeneratedOn ? `Generated ${kpis.forecastGeneratedOn}` : undefined },
      { label: 'Last month', value: fmtUsd(kpis.lastMonthUsd), spark },
      { label: 'Run rate per day', value: fmtUsd(kpis.runRatePerDayUsd), sub: 'last 7 complete days' },
      { label: 'Commitment coverage', value: kpis.commitmentCoveragePct != null ? pct1(kpis.commitmentCoveragePct) : '-',
        sub: 'Savings Plan spend covered', to: '/aws/finops/commitments' },
      { label: 'Commitment utilization', value: kpis.commitmentUtilizationPct != null ? pct1(kpis.commitmentUtilizationPct) : '-',
        tone: kpis.commitmentUtilizationPct != null && kpis.commitmentUtilizationPct < 80 ? 'warn' : 'neutral',
        sub: 'Savings Plan used', to: '/aws/finops/commitments' },
      { label: 'Open anomalies', value: String(kpis.openAnomalies ?? 0), tone: kpis.openAnomalies ? 'warn' : 'ok',
        sub: kpis.openAnomalies ? 'needs a look' : 'none open', to: '/aws/finops/anomalies' },
      { label: 'Potential savings', value: fmtUsd(kpis.potentialSavingsUsd), sub: 'per month, open + accepted', to: '/aws/optimizer' },
      { label: 'Realized savings (90d)', value: fmtUsd(kpis.realizedSavings90dUsd), tone: kpis.realizedSavings90dUsd > 0 ? 'ok' : 'neutral', sub: 'recommendations resolved', to: '/aws/optimizer?status=done' },
      { label: 'Unallocated', value: kpis.unallocatedPct != null ? pct1(kpis.unallocatedPct) : '-',
        sub: kpis.unallocatedTagKey ? `by tag ${kpis.unallocatedTagKey}` : 'no tag key configured',
        tone: kpis.unallocatedPct != null && kpis.unallocatedPct > 25 ? 'warn' : 'neutral', to: '/aws/finops/allocation' },
    ];
  }, [kpis, trend, metric, data?.month]);

  const mixData = useMemo(() => ({
    labels: mix.map((m) => m.service),
    datasets: [{ data: mix.map((m) => m.usd), backgroundColor: mix.map((_, i) => (i === mix.length - 1 && mix[i].service === 'Other' ? '#3A4450' : PALETTE[i % PALETTE.length])), borderWidth: 0 }],
  }), [mix]);

  const trendData = useMemo(() => {
    const labels = trend.map((t) => monthLabel(t.month));
    const idx = trend.length - 1;
    const only = (key) => trend.map((t, i) => (i === idx && t[key] != null ? t[key] : null));
    return {
      labels,
      datasets: [
        { type: 'bar', label: 'Forecast', data: only('forecastUsd'), backgroundColor: 'rgba(255,153,0,0.12)', borderColor: '#FF9900', borderWidth: 1.5, borderDash: [5, 4], grouped: false, order: 2 },
        { type: 'bar', label: 'Spend', data: trend.map((t) => t.usd), backgroundColor: '#FF9900', borderRadius: 2, grouped: false, order: 1 },
        { type: 'line', label: 'Forecast low', data: only('forecastLowUsd'), borderColor: '#0091DA', backgroundColor: 'rgba(0,145,218,0.15)', pointRadius: 4, borderWidth: 1.5, spanGaps: true, order: 0 },
        { type: 'line', label: 'Forecast high', data: only('forecastHighUsd'), borderColor: '#0091DA', backgroundColor: 'rgba(0,145,218,0.15)', pointRadius: 4, borderWidth: 1.5, fill: '-1', spanGaps: true, order: 0 },
      ],
    };
  }, [trend]);

  const trendOpts = useMemo(() => chartOptions({ legend: true }), []);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Coins} title="FinOps" description="Spend, forecast, commitments, anomalies, budgets and savings across the registered AWS accounts">
        {accounts.length > 1 && (
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={selectCls} aria-label="Account">
            <option value="">All accounts</option>
            {accounts.map((a) => <option key={a.id} value={String(a.id)}>{a.name}</option>)}
          </select>
        )}
        <MetricToggle value={metric} onChange={(v) => setMetricParam(v)} />
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={onRefresh} refreshing={refreshing} />
      </PageHeader>
      <FinopsTabs />

      {data && data.amortizedFrom == null && metric === 'amortized' && (
        <p className="text-[11px] text-status-warn mb-3">No amortized cost has been captured yet; figures fall back to unblended until the next daily capture.</p>
      )}
      {data && data.amortizedFrom && metric === 'amortized' && (
        <p className="text-[11px] text-ink-faint mb-3">Amortized figures start {data.amortizedFrom}; earlier days read unblended.</p>
      )}

      <KpiBand tiles={tiles} loading={data == null} />

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-4">
        <Panel title="Cost mix, month to date" className="xl:col-span-1">
          {data == null ? <LoadingPanel height={220} /> : mix.length === 0
            ? <div className="text-sm text-ink-muted py-8 text-center">No cost data yet.</div>
            : <div className="h-60"><Doughnut data={mixData} options={DONUT_OPTS} /></div>}
        </Panel>
        <Panel title="13-month trend" className="xl:col-span-2">
          {data == null ? <LoadingPanel height={220} /> : trend.length === 0
            ? <div className="text-sm text-ink-muted py-8 text-center">No monthly history yet. The first FinOps capture backfills 13 months.</div>
            : <div className="h-60"><Bar data={trendData} options={trendOpts} /></div>}
        </Panel>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
        <Panel title="Top movers (this month vs last)">
          {data == null ? <LoadingPanel height={160} /> : movers.length === 0
            ? <div className="text-sm text-ink-muted py-6 text-center">No month-over-month movement to show.</div>
            : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className={thCls}>
                    <th className="py-2 pr-1 w-5" /><th className="py-2 pr-3">Service</th><th className="py-2 pr-3 text-right">This month</th>
                    <th className="py-2 pr-3 text-right">Last month</th><th className="py-2 pr-3 text-right">Change</th>
                  </tr></thead>
                  <tbody>
                    {movers.map((m) => {
                      const cmp = cmpRows.find((c) => c.service === m.service);
                      const isOpen = openMover === m.service;
                      return (
                      <Fragment key={m.service}>
                      <tr className="border-b border-cohesity-border/50">
                        <td className="py-2 pr-1">
                          {cmpRows.length > 0 && (
                            <button type="button" onClick={() => setOpenMover(isOpen ? null : m.service)} aria-expanded={isOpen}
                              aria-label={isOpen ? `Hide why ${m.service} moved` : `Why ${m.service} moved`} title="Why it moved"
                              className="text-ink-faint hover:text-ink cursor-pointer">
                              {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </button>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-ink">{m.service}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtUsd(m.thisMonthUsd)}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtUsd(m.lastMonthUsd)}</td>
                        <td className={`py-2 pr-3 text-right tnum ${m.deltaUsd > 0 ? 'text-status-warn' : m.deltaUsd < 0 ? 'text-status-ok' : 'text-ink-muted'}`}>
                          {m.deltaUsd > 0 ? '+' : ''}{fmtUsd(m.deltaUsd)} <span className="text-ink-faint text-[11px]">({signedPct(m.deltaPct)})</span>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="border-b border-cohesity-border/30 bg-surface-overlay/40">
                          <td />
                          <td colSpan={4} className="py-2 pr-3 text-[12px]">
                            {!cmp || !(cmp.drivers || []).length ? (
                              <span className="text-ink-faint">No driver analysis yet</span>
                            ) : (
                              <>
                                <ul className="space-y-1">
                                  {cmp.drivers.map((d, i) => (
                                    <li key={`${d.type}|${d.name}|${d.usageType}|${i}`} className="flex flex-wrap items-baseline gap-x-2">
                                      <span className="text-ink-faint text-[11px]">{d.type || 'driver'}</span>
                                      <span className="text-ink-muted min-w-0 break-all">{d.name || d.usageType || '-'}</span>
                                      <span className={`ml-auto tnum ${d.deltaUsd > 0 ? 'text-status-warn' : d.deltaUsd < 0 ? 'text-status-ok' : 'text-ink-muted'}`}>
                                        {d.deltaUsd > 0 ? '+' : ''}{fmtUsd(d.deltaUsd)}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                                <p className="text-[10px] text-ink-faint mt-1.5">{cmpCaption}</p>
                              </>
                            )}
                          </td>
                        </tr>
                      )}
                      </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </Panel>

        <Panel title="Budgets" actions={<Link to="/aws/finops/budgets" className="text-[11px] text-brand hover:underline">Manage</Link>}>
          {data == null ? <LoadingPanel height={160} /> : budgets.length === 0
            ? (
              <div className="text-sm text-ink-muted py-6 text-center">
                No budgets yet. <Link to="/aws/finops/budgets" className="text-brand underline">Add one</Link> to track spend against a limit.
              </div>
            )
            : <div className="flex flex-col gap-3">{budgets.map((b) => <BudgetBar key={b.id} budget={b} />)}</div>}
        </Panel>
      </div>

      <Panel title="Open anomalies" actions={<Link to="/aws/finops/anomalies" className="text-[11px] text-brand hover:underline">All anomalies</Link>}>
        {data == null ? <LoadingPanel height={100} /> : anomalies.length === 0
          ? <div className="text-sm text-ink-muted py-4 text-center">No open cost anomalies.</div>
          : (
            <ul className="divide-y divide-cohesity-border/50">
              {anomalies.map((a) => (
                <li key={a.id} className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <Badge tone={a.source === 'aws' ? 'brand' : 'neutral'}>{a.source === 'aws' ? 'AWS' : 'ICC'}</Badge>
                  <span className="text-ink min-w-0 truncate">{a.scopeKey}</span>
                  <span className="text-ink-faint text-[11px]">since {a.startDay}</span>
                  <span className="ml-auto tnum text-status-warn">{fmtUsd(a.impactUsd)} <span className="text-[11px]">({signedPct(a.impactPct)})</span></span>
                </li>
              ))}
            </ul>
          )}
      </Panel>

      {data && (data.lastCaptureAt || data.lastCaptureRequests != null) && (
        <p className="text-[11px] text-ink-faint mt-3">
          Last FinOps capture: {data.lastCaptureAt ? new Date(data.lastCaptureAt).toLocaleString() : 'never'}
          {data.lastCaptureRequests != null ? `, ${data.lastCaptureRequests} Cost Explorer request(s)` : ''}.
        </p>
      )}
    </div>
  );
}
