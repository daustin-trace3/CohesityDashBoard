import { useEffect, useState, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Boxes, Download } from 'lucide-react';
import { Line } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip, Legend } from 'chart.js';
import { useToast } from '../../../components/ui/Toaster';
import { PageHeader, Panel, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../../components/ui/primitives';
import { useDateRange, DateRangeControl } from '../../../components/ui/DateRangeControl';
import { ModalShell } from '../../../components/hyperv/HvUi';
import { downloadCsv } from '../../../api/download';
import { fmtUsd } from '../helpers';
import { getResources, getResourceSeries, RESOURCES_CSV, errMsg } from './finopsApi';
import MetricToggle from './MetricToggle';
import ResourceEstimateTable, { ESTIMATE_NOTE, kindLabel } from './ResourceEstimateTable';
import { useUrlParam, pct1, chartOptions, thCls } from './shared';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip, Legend);

const KIND_CHIPS = [['', 'All'], ['ec2', 'EC2'], ['ebs', 'EBS'], ['s3', 'S3'], ['rds', 'RDS'], ['lightsail', 'Lightsail'], ['lambda', 'Lambda'], ['dynamo', 'DynamoDB'], ['bedrock', 'Bedrock']];

function SeriesDrawer({ row, metric, onClose }) {
  const [series, setSeries] = useState(null);
  useEffect(() => {
    let live = true;
    getResourceSeries({ kind: row.resourceKind, resourceId: row.resourceId, days: 30, metric }, 60000)
      .then((d) => { if (live) setSeries(d?.rows || []); })
      .catch(() => { if (live) setSeries([]); });
    return () => { live = false; };
  }, [row, metric]);
  const chart = useMemo(() => ({
    labels: (series || []).map((r) => String(r.day).slice(5)),
    datasets: [{
      label: 'Estimated cost', data: (series || []).map((r) => Number(r.usd) || 0), borderColor: '#FF9900', backgroundColor: 'rgba(255,153,0,0.15)',
      fill: true, tension: 0.25, pointRadius: 0, pointHoverRadius: 3, borderWidth: 2,
    }],
  }), [series]);
  const opts = useMemo(() => chartOptions({ legend: false }), []);
  const usageTypes = useMemo(() => {
    const m = new Map();
    (series || []).forEach((d) => (d.usageTypes || []).forEach((u) => m.set(u.usageType, (m.get(u.usageType) || 0) + (Number(u.usd) || 0))));
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [series]);
  return (
    <ModalShell title={row.label || row.resourceId} subtitle={`${kindLabel(row.resourceKind)}, ${row.resourceId}`} icon={Boxes} size="md" onClose={onClose}
      badges={<Badge tone="warn">Estimated</Badge>}>
      <p className="text-[11px] text-ink-muted mb-2">
        Last 30 days, {metric}. {fmtUsd(row.usd)} in the selected window, about {row.estMonthlyUsd != null ? fmtUsd(row.estMonthlyUsd) : '-'} per month.
      </p>
      {series == null ? <LoadingPanel height={200} /> : series.length === 0
        ? <div className="text-sm text-ink-muted py-8 text-center">No daily estimate rows for this resource.</div>
        : <div className="h-56"><Line data={chart} options={opts} /></div>}
      {usageTypes.length > 0 && (
        <table className="w-full text-sm mt-3">
          <thead><tr className={thCls}><th className="py-2 pr-3">Usage type</th><th className="py-2 pr-3 text-right">30 day cost</th></tr></thead>
          <tbody>
            {usageTypes.map(([u, usd]) => (
              <tr key={u} className="border-b border-cohesity-border/50">
                <td className="py-1.5 pr-3 text-ink-muted text-[12px] break-all">{u}</td>
                <td className="py-1.5 pr-3 text-right tnum text-ink">{fmtUsd(usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-[11px] text-ink-faint mt-3">{ESTIMATE_NOTE}</p>
    </ModalShell>
  );
}

export default function FinopsResourcesPage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const dr = useDateRange(searchParams, setSearchParams, { defaultDays: 30 });
  const [kind, setKind] = useUrlParam('kind', '');
  const [metricParam, setMetricParam] = useUrlParam('metric', '');
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [drawer, setDrawer] = useState(null);

  const load = useCallback(() => {
    const params = { ...dr.params, limit: 500 };
    if (kind) params.kind = kind;
    if (metricParam) params.metric = metricParam;
    return getResources(params, dr.timeout)
      .then((d) => { setData(d || {}); setLastRefreshed(new Date()); })
      .catch((err) => { setData({}); toast({ type: 'error', title: 'Failed to load resource costs', message: errMsg(err, '') }); });
  }, [kind, metricParam, dr.params, dr.timeout, toast]);
  useEffect(() => { load(); }, [load]);
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const metric = data?.metric || metricParam || 'amortized';
  const totals = data?.totals || {};
  const rows = data?.rows || [];
  const unattributed = data?.unattributed || [];
  const byKind = data?.byKind || [];
  const kindCount = (k) => byKind
    .filter((b) => k === '' || b.kind === k || (k === 'bedrock' && b.kind === 'bedrock-model') || (k === 'lightsail' && String(b.kind).startsWith('lightsail')))
    .reduce((s, b) => s + (b.count || 0), 0);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const params = { ...dr.params };
      if (kind) params.kind = kind;
      if (metricParam) params.metric = metricParam;
      const first = dr.dayKeys[dr.dayKeys.length - 1];
      const last = dr.dayKeys[0];
      await downloadCsv(RESOURCES_CSV, params, `aws-resource-costs-${first}_${last}.csv`, dr.timeout);
    } catch (err) {
      toast({ type: 'error', title: 'Export failed', message: err.message });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Boxes} title="Resources" description="Estimated cost per resource, from billed usage types split across the inventory they name">
        <MetricToggle value={metric} onChange={(v) => setMetricParam(v)} />
        <DateRangeControl value={dr.range} onChange={dr.apply} />
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={onRefresh} refreshing={refreshing} />
      </PageHeader>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        <StatCard label="Attributed" value={fmtUsd(totals.attributedUsd)} sub={totals.attributedPct != null ? `${pct1(totals.attributedPct)} of spend` : dr.label} tone="brand" />
        <StatCard label="Unattributed" value={fmtUsd(totals.unattributedUsd)} sub="no inventory object to share it with"
          tone={totals.attributedPct != null && totals.attributedPct < 60 ? 'warn' : 'default'} />
        <StatCard label="Resources" value={String(rows.length)} sub={kind ? kindLabel(kind) : 'all kinds'} />
        <StatCard label="Window" value={dr.label} sub={metric} />
      </div>

      <p className="text-[11px] text-ink-muted mb-3">{ESTIMATE_NOTE}</p>

      <Panel title="Resources" className="mb-4" actions={(
        <button onClick={exportCsv} disabled={exporting}
          className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50">
          <Download size={12} /> {exporting ? 'Exporting...' : 'Export CSV'}
        </button>
      )}>
        <div className="flex flex-wrap items-center gap-1.5 mb-3" role="group" aria-label="Kind">
          {KIND_CHIPS.map(([v, text]) => (
            <button key={v || 'all'} type="button" aria-pressed={kind === v} onClick={() => setKind(v)}
              className={`px-2.5 py-1 rounded-lg text-xs border cursor-pointer ${kind === v ? 'bg-surface-overlay text-ink font-semibold border-brand/50' : 'text-ink-muted border-cohesity-border hover:text-ink'}`}>
              {text} {data && <span className="text-ink-faint tnum">{kindCount(v)}</span>}
            </button>
          ))}
        </div>
        {data == null ? <LoadingPanel height={220} /> : (
          <ResourceEstimateTable rows={rows} onRowClick={setDrawer}
            emptyText="No estimated resource cost in this window. The estimate is computed at the next daily FinOps capture." />
        )}
      </Panel>

      <Panel title="Unattributed by service">
        {data == null ? <LoadingPanel height={100} /> : unattributed.length === 0
          ? <div className="text-sm text-ink-muted py-4 text-center">Every billed usage type matched inventory.</div>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className={thCls}>
                  <th className="py-2 pr-3">Service</th><th className="py-2 pr-3 text-right">Usage types</th><th className="py-2 pr-3 text-right">Cost</th>
                </tr></thead>
                <tbody>
                  {unattributed.map((u) => (
                    <tr key={u.service} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3 text-ink">{u.service}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{u.usageTypes ?? '-'}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink">{fmtUsd(u.usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Panel>

      {drawer && <SeriesDrawer row={drawer} metric={metric} onClose={() => setDrawer(null)} />}
    </div>
  );
}
