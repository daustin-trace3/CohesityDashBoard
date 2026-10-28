import { useEffect, useState, useCallback, useMemo, Fragment } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PieChart, ChevronRight, ChevronDown, Download } from 'lucide-react';
import { Bar } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Tooltip, Legend } from 'chart.js';
import { useToast } from '../../../components/ui/Toaster';
import { PageHeader, Panel, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../../components/ui/tableTools';
import { useDateRange, DateRangeControl } from '../../../components/ui/DateRangeControl';
import { downloadCsv } from '../../../api/download';
import { fmtUsd } from '../helpers';
import { getAllocation, ALLOCATION_CSV, errMsg } from './finopsApi';
import MetricToggle from './MetricToggle';
import { SETTINGS_LINK } from './CapabilityStrip';
import { ESTIMATE_NOTE } from './ResourceEstimateTable';
import { useUrlParam, pct1, chartOptions, PALETTE, selectCls, thCls } from './shared';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

const DIMENSIONS = [
  { value: 'tag', label: 'Tag key' },
  { value: 'cost_category', label: 'Cost category' },
  { value: 'linked_account', label: 'Linked account' },
  { value: 'inventory_tag', label: 'Inventory tag (estimated)' },
];
const UNALLOCATED = '(unallocated)';
const valueName = (v) => (v === '' || v == null ? UNALLOCATED : v);

export default function FinopsAllocationPage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const dr = useDateRange(searchParams, setSearchParams, { defaultDays: 30 });
  const [dimension, setDimension] = useUrlParam('dimension', 'tag');
  const [key, setKey] = useUrlParam('key', '');
  const [metricParam, setMetricParam] = useUrlParam('metric', '');
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState(() => new Set());
  const [exporting, setExporting] = useState(false);

  const load = useCallback(() => {
    const params = { dimension, ...dr.params };
    if (key) params.key = key;
    if (metricParam) params.metric = metricParam;
    return getAllocation(params, dr.timeout)
      .then((d) => { setData(d || {}); setLastRefreshed(new Date()); })
      .catch((err) => { setData({}); toast({ type: 'error', title: 'Failed to load allocation', message: errMsg(err, '') }); });
  }, [dimension, key, metricParam, dr.params, dr.timeout, toast]);

  useEffect(() => { load(); }, [load]);

  // With no key in the URL, adopt the first available key for the dimension.
  const keys = data?.keysAvailable?.[dimension] || [];
  useEffect(() => {
    if (!key && keys.length > 0) setKey(keys[0]);
  }, [key, keys, setKey]);

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const metric = data?.metric || metricParam || 'amortized';
  const values = data?.values || [];
  const days = data?.days || [];
  const noKeys = data != null && keys.length === 0 && !key;

  const chartData = useMemo(() => {
    const top = values.filter((v) => v.value !== '').slice(0, 8).map((v) => v.value);
    const hasUn = values.some((v) => v.value === '');
    const labels = days.map((d) => String(d.day).slice(5));
    const datasets = top.map((name, i) => ({
      label: name, data: days.map((d) => Number((d.values || {})[name]) || 0), backgroundColor: PALETTE[i % PALETTE.length], borderRadius: 2,
    }));
    const other = days.map((d) => Object.entries(d.values || {})
      .filter(([k]) => k !== '' && !top.includes(k)).reduce((s, [, v]) => s + (Number(v) || 0), 0));
    if (other.some((v) => v > 0.005)) datasets.push({ label: 'Other', data: other, backgroundColor: '#5A6572', borderRadius: 2 });
    if (hasUn) datasets.push({ label: UNALLOCATED, data: days.map((d) => Number((d.values || {})['']) || 0), backgroundColor: '#C75D5D', borderRadius: 2 });
    return { labels, datasets };
  }, [values, days]);
  const opts = useMemo(() => chartOptions({ stacked: true }), []);

  const rows = useMemo(() => values.map((v) => ({ ...v, name: valueName(v.value) })), [values]);
  const ctl = useTableControls(rows, {
    searchKeys: ['name'], defaultSortKey: 'usd', defaultSortDir: 'desc', paginate: true,
    sortValues: { usd: (r) => r.usd ?? -Infinity },
  });

  const toggle = (name) => setOpen((s) => { const n = new Set(s); if (n.has(name)) n.delete(name); else n.add(name); return n; });

  const exportCsv = async () => {
    setExporting(true);
    try {
      const params = { dimension, key, ...dr.params };
      if (metricParam) params.metric = metricParam;
      const first = dr.dayKeys[dr.dayKeys.length - 1];
      const last = dr.dayKeys[0];
      await downloadCsv(ALLOCATION_CSV, params, `aws-allocation-${key || dimension}-${first}_${last}.csv`, dr.timeout);
    } catch (err) {
      toast({ type: 'error', title: 'Export failed', message: err.message });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="animate-fade-in">
      <PageHeader icon={PieChart} title="Allocation" description="Spend by cost allocation tag, cost category or linked account">
        <select value={dimension} onChange={(e) => { setDimension(e.target.value); setKey(''); }} className={selectCls} aria-label="Dimension">
          {DIMENSIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>
        <select value={key} onChange={(e) => setKey(e.target.value)} className={selectCls} aria-label="Key" disabled={keys.length === 0}>
          {keys.length === 0 && <option value="">No keys</option>}
          {key && !keys.includes(key) && <option value={key}>{key}</option>}
          {keys.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <MetricToggle value={metric} onChange={(v) => setMetricParam(v)} />
        <DateRangeControl value={dr.range} onChange={dr.apply} />
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={onRefresh} refreshing={refreshing} />
      </PageHeader>

      {data == null ? (
        <Panel><LoadingPanel height={260} /></Panel>
      ) : noKeys ? (
        <Panel title="Allocation is not set up yet">
          <div className="text-sm text-ink-muted leading-relaxed max-w-3xl">
            <p className="mb-2">ICC has no allocation data for this dimension. To split spend by tag:</p>
            <ol className="list-decimal pl-5 space-y-1">
              <li>In the AWS console open Billing and Cost Management, then Cost allocation tags, and activate the user-defined tags you want to report on (for example Environment or Team). AWS starts reporting a tag the day after it is activated.</li>
              <li>In ICC open <Link to={SETTINGS_LINK} className="text-brand underline">AWS Settings, FinOps</Link> and add those tag keys under Allocation.</li>
              <li>The next daily FinOps capture stores 35 days of spend per tag value. Use Re-capture now in Settings to run it at once.</li>
            </ol>
            <p className="mt-2 text-ink-faint">The ce:ListCostAllocationTags and ce:GetCostAndUsage permissions are required; the Data sources panel in Settings lists what is missing.</p>
          </div>
        </Panel>
      ) : (
        <>
          {data.estimated && (
            <p className="text-[11px] text-ink-muted mb-3">
              <Badge tone="warn" className="mr-2">Estimated</Badge>
              Spend by inventory tag. Tags come from the current inventory, not from billing, so they apply to all history. {ESTIMATE_NOTE}
            </p>
          )}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            <StatCard icon={PieChart} label="Total spend" value={fmtUsd(data.totalUsd)} sub={dr.label} tone="brand" />
            <StatCard label="Allocated" value={fmtUsd(data.allocatedUsd)} sub={`${values.filter((v) => v.value !== '').length} value(s)`} />
            <StatCard label="Unallocated" value={pct1(data.unallocatedPct)} sub={fmtUsd(data.unallocatedUsd)} tone={data.unallocatedPct > 25 ? 'warn' : 'default'} />
            <StatCard label="Coverage gap" value={pct1(data.coverageGapPct)} sub="vs total daily cost"
              tone={data.coverageGapFlag ? 'warn' : 'default'} />
          </div>

          {data.coverageGapFlag && (
            <div className="panel p-3 mb-4 border border-status-warn/40 text-xs text-ink-muted">
              {data.estimated
                ? <>Estimates cover {pct1(100 - (data.coverageGapPct || 0))} of total cost in the window. The rest is cost with no usage-type row to split, not unallocated.</>
                : <>This key accounts for {pct1(100 - (data.coverageGapPct || 0))} of total cost in the window. A tag reports only from the day it was activated, so earlier days are missing from this view, not unallocated.</>}
            </div>
          )}

          <Panel title={`Daily spend by ${key || dimension}`} className="mb-4">
            {days.length === 0
              ? <div className="text-sm text-ink-muted py-8 text-center">No allocation rows in this window.</div>
              : <div className="h-64"><Bar data={chartData} options={opts} /></div>}
          </Panel>

          <Panel title="Values" actions={(
            <button onClick={exportCsv} disabled={exporting || !key}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50">
              <Download size={12} /> {exporting ? 'Exporting...' : 'Export CSV'}
            </button>
          )}>
            <TableControls ctl={ctl} rows={rows} searchPlaceholder="Filter values..." />
            {rows.length === 0 ? (
              <div className="text-sm text-ink-muted py-6 text-center">No values in this window.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className={thCls}>
                    <th className="py-2 pr-2 w-6" />
                    <SortTh k="name" label="Value" ctl={ctl} />
                    <SortTh k="usd" label="Spend" ctl={ctl} align="right" />
                    <SortTh k="pct" label="Share" ctl={ctl} align="right" />
                  </tr></thead>
                  <tbody>
                    {ctl.pageRows.map((r) => {
                      const isOpen = open.has(r.name);
                      const services = r.services || [];
                      return (
                        <Fragment key={r.name}>
                          <tr className="border-b border-cohesity-border/50">
                            <td className="py-2 pr-2">
                              {services.length > 0 && (
                                <button onClick={() => toggle(r.name)} aria-label={isOpen ? 'Collapse services' : 'Expand services'} aria-expanded={isOpen}
                                  className="text-ink-faint hover:text-ink cursor-pointer">
                                  {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                </button>
                              )}
                            </td>
                            <td className="py-2 pr-3 text-ink">
                              {r.name}{r.value === '' && <Badge tone="warn" className="ml-2">untagged</Badge>}
                            </td>
                            <td className="py-2 pr-3 text-right tnum text-ink">{fmtUsd(r.usd)}</td>
                            <td className="py-2 pr-3 text-right tnum text-ink-muted">{pct1(r.pct)}</td>
                          </tr>
                          {isOpen && services.map((s) => (
                            <tr key={`${r.name}|${s.service}`} className="border-b border-cohesity-border/30 bg-surface-overlay/40">
                              <td />
                              <td className="py-1.5 pr-3 pl-4 text-ink-muted text-[12px]">{s.service}</td>
                              <td className="py-1.5 pr-3 text-right tnum text-ink-muted text-[12px]">{fmtUsd(s.usd)}</td>
                              <td className="py-1.5 pr-3 text-right tnum text-ink-faint text-[12px]">{r.usd ? pct1((s.usd / r.usd) * 100) : '-'}</td>
                            </tr>
                          ))}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <TablePager ctl={ctl} />
          </Panel>
        </>
      )}
    </div>
  );
}
