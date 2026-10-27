import { useEffect, useState, useCallback, useMemo, Fragment } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Activity, ChevronRight, ChevronDown } from 'lucide-react';
import { useToast } from '../../../components/ui/Toaster';
import { PageHeader, Panel, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager, CsvExportButton } from '../../../components/ui/tableTools';
import { useDateRange, DateRangeControl } from '../../../components/ui/DateRangeControl';
import { fmtUsd } from '../helpers';
import { getAnomalies, errMsg } from './finopsApi';
import { CapabilityNotice } from './CapabilityStrip';
import { useUrlParam, signedPct, deniedCaps, thCls } from './shared';

const STATUSES = [['open', 'Open'], ['closed', 'Closed'], ['all', 'All']];
const SOURCES = [['all', 'All sources'], ['aws', 'AWS'], ['icc', 'ICC']];

function Chips({ options, value, onChange, label }) {
  return (
    <div className="flex rounded-lg border border-cohesity-border overflow-hidden" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}
          className={`px-2.5 py-1.5 text-xs cursor-pointer ${value === v ? 'bg-surface-overlay text-ink font-semibold' : 'text-ink-muted hover:text-ink'}`}>
          {text}
        </button>
      ))}
    </div>
  );
}

function causeText(c) {
  if (!c || typeof c !== 'object') return String(c);
  const bits = [];
  if (c.service) bits.push(c.service);
  if (c.usageType) bits.push(c.usageType);
  if (c.region) bits.push(c.region);
  if (c.linkedAccountName || c.linkedAccount) bits.push(`account ${c.linkedAccountName || c.linkedAccount}`);
  if (c.usd != null) bits.push(`${fmtUsd(c.usd)}${c.baselineUsd != null ? ` vs baseline ${fmtUsd(c.baselineUsd)}` : ''}`);
  return bits.join(' / ') || JSON.stringify(c);
}

export default function FinopsAnomaliesPage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const dr = useDateRange(searchParams, setSearchParams, { defaultDays: 30 });
  const [status, setStatus] = useUrlParam('status', 'open');
  const [source, setSource] = useUrlParam('source', 'all');
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState(() => new Set());

  const load = useCallback(() => getAnomalies({ status, source, ...dr.params }, dr.timeout)
    .then((d) => { setData(d || {}); setLastRefreshed(new Date()); })
    .catch((err) => { setData({}); toast({ type: 'error', title: 'Failed to load anomalies', message: errMsg(err, '') }); }),
  [status, source, dr.params, dr.timeout, toast]);
  useEffect(() => { load(); }, [load]);
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const rows = useMemo(() => data?.anomalies || [], [data]);
  const rule = data?.rule;
  const monitors = data?.monitors || [];
  const notice = deniedCaps(data?.capabilities, ['anomalies']);

  const ctl = useTableControls(rows, {
    searchKeys: ['scopeKey', 'monitorName', 'scope'], defaultSortKey: 'impactUsd', defaultSortDir: 'desc', paginate: true,
    sortValues: { impactUsd: (r) => r.impactUsd ?? -Infinity, endDay: (r) => r.endDay || '9999-99-99' },
  });
  const toggle = (id) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Activity} title="Anomalies" description="Unusual spend found by AWS Cost Anomaly Detection and by ICC's per-service baseline">
        <Chips options={STATUSES} value={status} onChange={setStatus} label="Status" />
        <Chips options={SOURCES} value={source} onChange={setSource} label="Source" />
        <DateRangeControl value={dr.range} onChange={dr.apply} />
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={onRefresh} refreshing={refreshing} />
      </PageHeader>

      <CapabilityNotice caps={notice} />

      {rule && (
        <p className="text-[11px] text-ink-muted mb-3">
          ICC rule: a service is flagged when yesterday's spend is more than {rule.pct}% (and at least {fmtUsd(rule.floorUsd)}) above its median of the prior {rule.baselineDays} days;
          it closes after {rule.clearDays} normal day(s). {monitors.length > 0 ? `${monitors.length} AWS monitor(s) feed the AWS rows.` : 'No AWS anomaly monitors were found.'}
        </p>
      )}

      <Panel title="Anomalies" actions={(
        <CsvExportButton filename="aws-anomalies" rows={rows} columns={[
          { label: 'Source', get: 'source' }, { label: 'Scope', get: 'scopeKey' }, { label: 'Monitor', get: 'monitorName' },
          { label: 'Start', get: 'startDay' }, { label: 'End', get: 'endDay' }, { label: 'Actual USD', get: 'actualUsd' },
          { label: 'Expected USD', get: 'expectedUsd' }, { label: 'Impact USD', get: 'impactUsd' }, { label: 'Impact %', get: 'impactPct' },
          { label: 'Status', get: 'status' }, { label: 'Superseded by', get: 'supersededBy' },
          { label: 'Root causes', get: (r) => (r.rootCauses || []).map(causeText).join('; ') },
        ]} />
      )}>
        <TableControls ctl={ctl} rows={rows} searchPlaceholder="Filter by scope or monitor..." />
        {data == null ? <LoadingPanel height={160} /> : rows.length === 0
          ? <div className="text-sm text-ink-muted py-8 text-center">No anomalies match this view.</div>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className={thCls}>
                  <th className="py-2 pr-2 w-6" />
                  <SortTh k="scopeKey" label="Scope" ctl={ctl} />
                  <SortTh k="source" label="Source" ctl={ctl} />
                  <SortTh k="startDay" label="Start" ctl={ctl} />
                  <SortTh k="endDay" label="End" ctl={ctl} />
                  <SortTh k="actualUsd" label="Actual" ctl={ctl} align="right" />
                  <SortTh k="expectedUsd" label="Expected" ctl={ctl} align="right" />
                  <SortTh k="impactUsd" label="Impact" ctl={ctl} align="right" />
                  <SortTh k="impactPct" label="Impact %" ctl={ctl} align="right" />
                  <SortTh k="status" label="Status" ctl={ctl} />
                </tr></thead>
                <tbody>
                  {ctl.pageRows.map((r) => {
                    const causes = r.rootCauses || [];
                    const isOpen = open.has(r.id);
                    return (
                      <Fragment key={r.id}>
                        <tr className="border-b border-cohesity-border/50">
                          <td className="py-2 pr-2">
                            {causes.length > 0 && (
                              <button onClick={() => toggle(r.id)} aria-expanded={isOpen} aria-label={isOpen ? 'Hide root causes' : 'Show root causes'}
                                className="text-ink-faint hover:text-ink cursor-pointer">
                                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                              </button>
                            )}
                          </td>
                          <td className="py-2 pr-3 text-ink">
                            {r.scopeKey}
                            {r.monitorName && <span className="block text-[11px] text-ink-faint">{r.monitorName}</span>}
                          </td>
                          <td className="py-2 pr-3"><Badge tone={r.source === 'aws' ? 'brand' : 'neutral'}>{r.source === 'aws' ? 'AWS' : 'ICC'}</Badge></td>
                          <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{r.startDay}</td>
                          <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{r.endDay || '-'}</td>
                          <td className="py-2 pr-3 text-right tnum text-ink">{fmtUsd(r.actualUsd)}</td>
                          <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtUsd(r.expectedUsd)}</td>
                          <td className="py-2 pr-3 text-right tnum text-status-warn">{fmtUsd(r.impactUsd)}</td>
                          <td className="py-2 pr-3 text-right tnum text-ink-muted">{signedPct(r.impactPct)}</td>
                          <td className="py-2 pr-3 whitespace-nowrap">
                            <Badge tone={r.status === 'open' ? 'warn' : 'neutral'}>{r.status}</Badge>
                            {r.supersededBy && <span className="ml-1.5" title={`Covered by AWS anomaly ${r.supersededBy}`}><Badge tone="info">superseded</Badge></span>}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="border-b border-cohesity-border/30 bg-surface-overlay/40">
                            <td />
                            <td colSpan={9} className="py-2 pr-3">
                              <p className="text-[11px] uppercase tracking-wide text-ink-faint mb-1">Root causes</p>
                              <ul className="list-disc pl-5 text-[12px] text-ink-muted space-y-0.5">
                                {causes.map((c, i) => <li key={i}>{causeText(c)}</li>)}
                              </ul>
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
        <TablePager ctl={ctl} />
      </Panel>
    </div>
  );
}
