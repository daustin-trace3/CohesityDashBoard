import { useEffect, useState, useCallback, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Handshake } from 'lucide-react';
import { Line } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip, Legend } from 'chart.js';
import { useToast } from '../../../components/ui/Toaster';
import { PageHeader, Panel, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../../components/ui/primitives';
import { useDateRange, DateRangeControl } from '../../../components/ui/DateRangeControl';
import { fmtUsd } from '../helpers';
import { getCommitments, errMsg } from './finopsApi';
import { CapabilityNotice } from './CapabilityStrip';
import { pct1, deniedCaps, chartOptions, thCls } from './shared';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip, Legend);

const pctOpts = () => {
  const o = chartOptions({ money: false, unit: '%' });
  o.scales.y.suggestedMin = 0;
  o.scales.y.suggestedMax = 100;
  return o;
};

function lineData(rows, key, label, color) {
  return {
    labels: rows.map((r) => String(r.day).slice(5)),
    datasets: [{ label, data: rows.map((r) => (r[key] == null ? null : Number(r[key]))), borderColor: color, backgroundColor: `${color}22`, fill: true, tension: 0.25, pointRadius: 0, pointHoverRadius: 3, borderWidth: 2 }],
  };
}

export default function FinopsCommitmentsPage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const dr = useDateRange(searchParams, setSearchParams, { defaultDays: 30 });
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => getCommitments(dr.params, dr.timeout)
    .then((d) => { setData(d || {}); setLastRefreshed(new Date()); })
    .catch((err) => { setData({}); toast({ type: 'error', title: 'Failed to load commitments', message: errMsg(err, '') }); }),
  [dr.params, dr.timeout, toast]);
  useEffect(() => { load(); }, [load]);
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const sp = data?.savingsPlans || {};
  const ri = data?.reservations || {};
  const util = sp.utilization || [];
  const cov = sp.coverage || [];
  const plans = sp.plans || [];
  const recs = sp.recommendations || [];
  const summary = sp.summary || {};
  const riUtil = ri.utilization || [];
  const riCov = ri.coverage || [];
  const notice = deniedCaps(data?.capabilities, ['sp_', 'ri_']);
  const spDenied = notice.some((c) => c.capability.startsWith('sp_'));

  const utilData = useMemo(() => lineData(util, 'utilizationPct', 'Utilization', '#6CB33F'), [util]);
  const covData = useMemo(() => lineData(cov, 'coveragePct', 'Coverage', '#0091DA'), [cov]);
  const riUtilData = useMemo(() => lineData(riUtil, 'utilizationPct', 'RI utilization', '#6CB33F'), [riUtil]);
  const riCovData = useMemo(() => lineData(riCov, 'coveragePct', 'RI coverage', '#0091DA'), [riCov]);
  const opts = useMemo(pctOpts, []);

  const loading = data == null;
  const covered = cov.reduce((s, r) => s + (Number(r.coveredUsd) || 0), 0);
  const onDemand = cov.reduce((s, r) => s + (Number(r.onDemandUsd) || 0), 0);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Handshake} title="Commitments" description="Savings Plan and Reserved Instance utilization, coverage, inventory and purchase recommendations">
        <DateRangeControl value={dr.range} onChange={dr.apply} />
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={onRefresh} refreshing={refreshing} />
      </PageHeader>

      <CapabilityNotice caps={notice} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Handshake} label="Avg utilization" value={loading ? '-' : pct1(summary.avgUtilizationPct)} sub={dr.label}
          tone={summary.avgUtilizationPct != null && summary.avgUtilizationPct < 80 ? 'warn' : 'brand'} loading={loading} />
        <StatCard label="Avg coverage" value={loading ? '-' : pct1(summary.avgCoveragePct)} sub="of eligible spend" loading={loading} />
        <StatCard label="Unused commitment" value={loading ? '-' : fmtUsd(summary.unusedUsd)} sub="paid for, not used"
          tone={summary.unusedUsd > 0 ? 'warn' : 'default'} loading={loading} />
        <StatCard label="Net savings" value={loading ? '-' : fmtUsd(summary.netSavingsUsd)} sub="vs on-demand" tone="ok" loading={loading} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
        <Panel title="Savings Plan utilization">
          {loading ? <LoadingPanel height={180} /> : util.length === 0
            ? <div className="text-sm text-ink-muted py-8 text-center">{spDenied ? 'Savings Plan utilization is not available yet.' : 'No Savings Plan utilization in this window.'}</div>
            : <div className="h-52"><Line data={utilData} options={opts} /></div>}
        </Panel>
        <Panel title="Savings Plan coverage">
          {loading ? <LoadingPanel height={180} /> : cov.length === 0
            ? <div className="text-sm text-ink-muted py-8 text-center">{spDenied ? 'Savings Plan coverage is not available yet.' : 'No Savings Plan coverage in this window.'}</div>
            : <div className="h-52"><Line data={covData} options={opts} /></div>}
          {cov.length > 0 && (
            <p className="text-[11px] text-ink-muted mt-2 tnum">Covered {fmtUsd(covered)} and on-demand {fmtUsd(onDemand)} over the window.</p>
          )}
        </Panel>
      </div>

      <Panel title="Savings Plans" className="mb-4">
        {loading ? <LoadingPanel height={100} /> : plans.length === 0
          ? <div className="text-sm text-ink-muted py-6 text-center">No active Savings Plans found.</div>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className={thCls}>
                  <th className="py-2 pr-3">Plan</th><th className="py-2 pr-3">State</th><th className="py-2 pr-3">Type</th><th className="py-2 pr-3">Term</th>
                  <th className="py-2 pr-3">Payment</th><th className="py-2 pr-3">Product types</th><th className="py-2 pr-3 text-right">Commitment / h</th>
                  <th className="py-2 pr-3">Region / family</th><th className="py-2 pr-3">Ends</th>
                  <th className="py-2 pr-3 text-right">Utilization</th><th className="py-2 pr-3 text-right">Net savings</th>
                  <th className="py-2 pr-3">Source</th>
                </tr></thead>
                <tbody>
                  {plans.map((p) => (
                    <tr key={p.arn || p.arnTail} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3 text-ink" title={p.arn}>{p.arnTail || p.arn}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {p.state
                          ? <Badge tone={String(p.state).toLowerCase() === 'active' ? 'ok' : String(p.state).toLowerCase() === 'queued' ? 'info' : 'neutral'}>
                            {String(p.state).toLowerCase() === 'queued' ? 'Scheduled renewal' : String(p.state)}</Badge>
                          : <span className="text-ink-faint">-</span>}
                      </td>
                      <td className="py-2 pr-3 text-ink-muted">{p.type || '-'}</td>
                      <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{p.term || '-'}</td>
                      <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">
                        {p.paymentOption || '-'}
                        {(p.upfrontUsd != null || p.recurringUsd != null) && (
                          <span className="block text-[11px] text-ink-faint tnum">{p.upfrontUsd != null ? `${fmtUsd(p.upfrontUsd)} upfront` : ''}{p.upfrontUsd != null && p.recurringUsd != null ? ', ' : ''}{p.recurringUsd != null ? `${fmtUsd(p.recurringUsd)} recurring` : ''}</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-ink-muted text-[11px]">{Array.isArray(p.productTypes) && p.productTypes.length ? p.productTypes.join(', ') : '-'}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{p.hourlyCommitmentUsd != null ? `$${Number(p.hourlyCommitmentUsd).toFixed(3)}` : '-'}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[11px]">{[p.region, p.instanceFamily].filter(Boolean).join(' / ') || '-'}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        <span className="text-ink-muted text-[12px]">{p.endAt ? String(p.endAt).slice(0, 10) : '-'}</span>{' '}
                        {p.daysToExpiry != null && (
                          <Badge tone={p.daysToExpiry < 30 ? 'crit' : p.daysToExpiry < 90 ? 'warn' : 'neutral'}>
                            {p.daysToExpiry < 0 ? 'expired' : `${p.daysToExpiry}d left`}
                          </Badge>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{p.utilizationPct != null ? pct1(p.utilizationPct) : '-'}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtUsd(p.netSavingsUsd)}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[11px] whitespace-nowrap">{p.source === 'api' ? 'AWS API' : p.source ? 'derived' : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Panel>

      <Panel title="Purchase recommendation" className="mb-4"
        actions={<Link to="/aws/optimizer" className="text-[11px] text-brand hover:underline">Open Optimizer</Link>}>
        {loading ? <LoadingPanel height={80} /> : recs.length === 0
          ? <div className="text-sm text-ink-muted py-4 text-center">{spDenied ? 'Purchase recommendations are not available yet.' : 'AWS has no Savings Plan purchase recommendation right now.'}</div>
          : (
            <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {recs.map((r) => (
                <div key={r.key || r.resourceId} className="rounded-lg border border-cohesity-border p-3">
                  <p className="text-sm text-ink font-semibold">{r.resourceName || r.resourceId}</p>
                  <p className="text-[11px] text-ink-muted mt-1">{r.currentConfig || '-'}</p>
                  <p className="text-[11px] text-ink-muted">Commit {r.recommendedConfig || '-'}</p>
                  <p className="text-lg font-bold text-status-ok tnum mt-1">{fmtUsd(r.estMonthlySavingsUsd)}<span className="text-[11px] text-ink-faint font-normal"> per month</span></p>
                  {r.state?.status && r.state.status !== 'open' && <Badge tone="neutral" className="mt-1">{r.state.status}</Badge>}
                </div>
              ))}
            </div>
          )}
      </Panel>

      <Panel title="Reserved Instances">
        {loading ? <LoadingPanel height={80} /> : (riUtil.length === 0 && riCov.length === 0)
          ? <div className="text-sm text-ink-muted py-4 text-center">No reservations in this window.</div>
          : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <div>
                <p className="text-[11px] text-ink-faint uppercase tracking-wide mb-1">Utilization</p>
                <div className="h-44"><Line data={riUtilData} options={opts} /></div>
              </div>
              <div>
                <p className="text-[11px] text-ink-faint uppercase tracking-wide mb-1">Coverage</p>
                <div className="h-44"><Line data={riCovData} options={opts} /></div>
              </div>
            </div>
          )}
      </Panel>
    </div>
  );
}
