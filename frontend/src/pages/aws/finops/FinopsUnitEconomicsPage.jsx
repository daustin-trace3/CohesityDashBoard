import { useEffect, useState, useCallback, useMemo, Fragment } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Scale, ChevronRight, ChevronDown } from 'lucide-react';
import { useToast } from '../../../components/ui/Toaster';
import { PageHeader, Panel, StatCard, LoadingPanel, RefreshButton, LastUpdated } from '../../../components/ui/primitives';
import { useDateRange, DateRangeControl } from '../../../components/ui/DateRangeControl';
import TrendChart from '../../../components/TrendChart';
import { fmtUsd } from '../helpers';
import { getUnitEconomics, errMsg } from './finopsApi';
import MetricToggle from './MetricToggle';
import { useUrlParam, num2, thCls } from './shared';

// Response keys read here (contract: GET /finops/unit-economics):
//   bedrock[]: { service, modelId, usd, mTokens, usdPerMTok, invocations, kinds[{kind,usd,mTokens,usdPerMTok}], series[{day,usd,mTokens,usdPerMTok}] }
//   ec2[]: { instanceType, usd, runningCount, usdPerInstanceMonth }
//   s3: { usd, tb, usdPerTbMonth, series? }   lightsail: { usd, count, usdPerInstanceMonth, series? }
// Aliases (tokens, byKind, tokenKinds) are tolerated so a renamed key degrades to a dash, not a crash.
const KIND_LABEL = { input: 'Input', output: 'Output', cacheRead: 'Cache read', cacheWrite: 'Cache write' };
const usdPerM = (v) => (v == null ? '-' : `$${Number(v).toFixed(v < 1 ? 4 : 2)}`);
const mTok = (r) => r.mTokens ?? r.tokens;
const kindsOf = (r) => r.kinds || r.byKind || r.tokenKinds || [];

function Series({ series, valueKey, label, unit }) {
  const rows = Array.isArray(series) ? series : [];
  if (rows.length < 2) return null;
  const labels = rows.map((r) => String(r.day).slice(5));
  const datasets = [{ label, data: rows.map((r) => Number(r[valueKey] ?? r.usd) || 0), color: '#FF9900', fill: true }];
  return <TrendChart labels={labels} datasets={datasets} height={150} unit={unit} format={(v) => `$${Number(v).toFixed(2)}`} />;
}

export default function FinopsUnitEconomicsPage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const dr = useDateRange(searchParams, setSearchParams, { defaultDays: 30 });
  const [metricParam, setMetricParam] = useUrlParam('metric', '');
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState(() => new Set());
  const [picked, setPicked] = useState('');

  const load = useCallback(() => {
    const params = { ...dr.params };
    if (metricParam) params.metric = metricParam;
    return getUnitEconomics(params, dr.timeout)
      .then((d) => { setData(d || {}); setLastRefreshed(new Date()); })
      .catch((err) => { setData({}); toast({ type: 'error', title: 'Failed to load unit economics', message: errMsg(err, '') }); });
  }, [dr.params, dr.timeout, metricParam, toast]);
  useEffect(() => { load(); }, [load]);
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const metric = data?.metric || metricParam || 'amortized';
  const bedrock = useMemo(() => data?.bedrock || [], [data]);
  const ec2 = data?.ec2 || [];
  const s3 = data?.s3 || null;
  const lightsail = data?.lightsail || null;
  const loading = data == null;
  const current = bedrock.find((b) => b.service === picked) || bedrock[0] || null;
  const toggle = (k) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Scale} title="Unit Economics" description="Cost per million Bedrock tokens, per EC2 instance-month, per S3 terabyte-month and per Lightsail instance-month">
        <MetricToggle value={metric} onChange={(v) => setMetricParam(v)} />
        <DateRangeControl value={dr.range} onChange={dr.apply} />
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={onRefresh} refreshing={refreshing} />
      </PageHeader>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
        <StatCard label="S3 per TB-month" loading={loading} value={s3?.usdPerTbMonth != null ? fmtUsd(s3.usdPerTbMonth) : '-'}
          sub={s3 ? `${fmtUsd(s3.usd)} over ${num2(s3.tb)} TB stored` : 'no S3 data'} tone="brand" />
        <StatCard label="Lightsail per instance-month" loading={loading} value={lightsail?.usdPerInstanceMonth != null ? fmtUsd(lightsail.usdPerInstanceMonth) : '-'}
          sub={lightsail ? `${fmtUsd(lightsail.usd)} across ${lightsail.count ?? 0} instance(s)` : 'no Lightsail data'} tone="brand" />
      </div>

      {(s3?.series?.length > 1 || lightsail?.series?.length > 1) && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
          {s3?.series?.length > 1 && <Panel title="S3 daily spend"><Series series={s3.series} valueKey="usd" label="S3" /></Panel>}
          {lightsail?.series?.length > 1 && <Panel title="Lightsail daily spend"><Series series={lightsail.series} valueKey="usd" label="Lightsail" /></Panel>}
        </div>
      )}

      <Panel title="Bedrock models" className="mb-4">
        {loading ? <LoadingPanel height={140} /> : bedrock.length === 0
          ? <div className="text-sm text-ink-muted py-6 text-center">No Bedrock model spend in this window.</div>
          : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className={thCls}>
                    <th className="py-2 pr-2 w-6" /><th className="py-2 pr-3">Model</th>
                    <th className="py-2 pr-3 text-right">Spend</th><th className="py-2 pr-3 text-right">M tokens</th>
                    <th className="py-2 pr-3 text-right">$ per M tokens</th><th className="py-2 pr-3 text-right">Invocations</th>
                  </tr></thead>
                  <tbody>
                    {bedrock.map((b) => {
                      const kinds = kindsOf(b);
                      const isOpen = open.has(b.service);
                      const active = current && current.service === b.service;
                      return (
                        <Fragment key={b.service}>
                          <tr className={`border-b border-cohesity-border/50 cursor-pointer ${active ? 'bg-brand/5' : ''}`} onClick={() => setPicked(b.service)}>
                            <td className="py-2 pr-2">
                              {kinds.length > 0 && (
                                <button onClick={(e) => { e.stopPropagation(); toggle(b.service); }} aria-expanded={isOpen}
                                  aria-label={isOpen ? 'Hide token kinds' : 'Show token kinds'} className="text-ink-faint hover:text-ink cursor-pointer">
                                  {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                </button>
                              )}
                            </td>
                            <td className="py-2 pr-3 text-ink">{b.service}{b.modelId && <span className="block text-[11px] text-ink-faint">{b.modelId}</span>}</td>
                            <td className="py-2 pr-3 text-right tnum text-ink">{fmtUsd(b.usd)}</td>
                            <td className="py-2 pr-3 text-right tnum text-ink-muted">{num2(mTok(b))}</td>
                            <td className="py-2 pr-3 text-right tnum text-ink">{usdPerM(b.usdPerMTok)}</td>
                            <td className="py-2 pr-3 text-right tnum text-ink-muted">{b.invocations != null ? Number(b.invocations).toLocaleString() : '-'}</td>
                          </tr>
                          {isOpen && kinds.map((k) => (
                            <tr key={`${b.service}|${k.kind}`} className="border-b border-cohesity-border/30 bg-surface-overlay/40">
                              <td />
                              <td className="py-1.5 pr-3 pl-4 text-ink-muted text-[12px]">{KIND_LABEL[k.kind] || k.kind}</td>
                              <td className="py-1.5 pr-3 text-right tnum text-ink-muted text-[12px]">{fmtUsd(k.usd)}</td>
                              <td className="py-1.5 pr-3 text-right tnum text-ink-muted text-[12px]">{num2(mTok(k))}</td>
                              <td className="py-1.5 pr-3 text-right tnum text-ink-muted text-[12px]">{usdPerM(k.usdPerMTok)}</td>
                              <td />
                            </tr>
                          ))}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {current && Array.isArray(current.series) && current.series.length > 1 && (
                <div className="mt-4">
                  <p className="text-[11px] uppercase tracking-wide text-ink-faint mb-1">$ per million tokens by day, {current.service}</p>
                  <TrendChart labels={current.series.map((r) => String(r.day).slice(5))}
                    datasets={[{ label: '$ per M tokens', data: current.series.map((r) => (r.usdPerMTok == null ? null : Number(r.usdPerMTok))), color: '#0091DA', fill: true }]}
                    height={170} format={(v) => `$${Number(v).toFixed(2)}`} />
                </div>
              )}
            </>
          )}
      </Panel>

      <Panel title="EC2 by instance type">
        {loading ? <LoadingPanel height={120} /> : ec2.length === 0
          ? <div className="text-sm text-ink-muted py-6 text-center">No EC2 instance type cost in this window.</div>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className={thCls}>
                  <th className="py-2 pr-3">Instance type</th><th className="py-2 pr-3 text-right">Spend</th>
                  <th className="py-2 pr-3 text-right">Running</th><th className="py-2 pr-3 text-right">Per instance-month</th>
                </tr></thead>
                <tbody>
                  {ec2.map((r) => (
                    <tr key={r.instanceType} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3 text-ink">{r.instanceType}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtUsd(r.usd)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{r.runningCount ?? '-'}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink">{r.usdPerInstanceMonth != null ? fmtUsd(r.usdPerInstanceMonth) : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        <p className="text-[11px] text-ink-faint mt-2">Spend is divided evenly across the instances running now and normalised to a 30.4 day month.</p>
      </Panel>
    </div>
  );
}
