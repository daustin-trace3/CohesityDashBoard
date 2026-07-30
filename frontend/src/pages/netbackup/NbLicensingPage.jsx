import { useEffect, useState, useCallback } from 'react';
import { BadgeCheck, Cloud, Users, Globe } from 'lucide-react';
import { Chart as ChartJS, ArcElement, Tooltip as ChartTooltip, Legend } from 'chart.js';
import { Doughnut } from 'react-chartjs-2';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Panel, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, TB, fmtTb, fmtNum, fmtWhen } from './helpers';

ChartJS.register(ArcElement, ChartTooltip, Legend);

function Gauge({ pct }) {
  const clamped = Math.max(0, Math.min(pct ?? 0, 100));
  const color = pct >= 90 ? '#EF4444' : pct >= 75 ? '#F59E0B' : '#6CB33F';
  const data = {
    labels: ['Consumed', 'Remaining'],
    datasets: [{ data: [clamped, 100 - clamped], backgroundColor: [color, 'rgba(255,255,255,0.08)'], borderWidth: 0, circumference: 360 }],
  };
  const options = { responsive: true, maintainAspectRatio: false, cutout: '74%', animation: false, plugins: { legend: { display: false }, tooltip: { enabled: false } } };
  return (
    <div className="relative h-24 w-24 flex-shrink-0">
      <Doughnut data={data} options={options} />
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-lg font-bold tnum" style={{ color }}>{pct.toFixed(0)}%</span>
        <span className={`text-[9px] font-semibold uppercase tracking-wide ${pct > 100 ? 'text-status-crit' : 'text-ink-faint'}`}>{pct > 100 ? 'Over' : 'Used'}</span>
      </div>
    </div>
  );
}

function MeterCard({ title, icon: Icon, pct, consumedTb, entitledTb, sub, empty }) {
  return (
    <div className="panel p-4 flex flex-col gap-3">
      <div className="flex items-start gap-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 border border-brand/20 flex-shrink-0">
          <Icon size={18} className="text-brand" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-ink">{title}</p>
          {sub && <p className="text-[11px] text-ink-muted leading-snug">{sub}</p>}
        </div>
      </div>
      {empty ? (
        <div className="py-6 text-center text-sm text-ink-muted">{empty}</div>
      ) : (
        <div className="flex flex-wrap items-center gap-4">
          {pct != null ? (
            <Gauge pct={pct} />
          ) : (
            <div className="h-24 w-24 flex-shrink-0 flex flex-col items-center justify-center gap-1 rounded-full border border-dashed border-cohesity-border text-center px-3">
              <span className="text-[10px] text-ink-muted leading-tight">No entitlement set</span>
            </div>
          )}
          <div className="flex-1 flex flex-col gap-1.5 text-sm min-w-[160px]">
            <div className="flex items-center justify-between gap-2">
              <span className="text-ink-muted text-xs">Consumed</span>
              <span className="text-ink font-semibold tnum">{fmtTb(consumedTb * TB)}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-ink-muted text-xs">Entitled</span>
              <span className="text-ink font-semibold tnum">{entitledTb > 0 ? `${entitledTb.toLocaleString()} TB` : '— not set'}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function NbLicensingPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/netbackup/licensing')
    .then(({ data }) => {
      setData(data);
      setLastRefreshed(new Date());
    })
    .catch(() => { setData({ totals: {}, byWorkload: [], byDomain: [], entitledTb: 0, upstream: null }); toast({ type: 'error', title: 'Failed to load licensing data' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const totals = data?.totals || {};
  const byWorkload = data?.byWorkload || [];
  const byDomain = data?.byDomain || [];
  const entitledTb = data?.entitledTb || 0;
  const consumedTb = (totals.frontEndBytes || 0) / TB;
  const computedPct = entitledTb > 0 ? (consumedTb / entitledTb) * 100 : null;

  const upstream = data?.upstream || null;
  const upstreamPct = upstream && upstream.entitledTb > 0 ? (upstream.reportedTb / upstream.entitledTb) * 100 : null;

  const showDelta = upstream != null && entitledTb > 0;
  const delta = showDelta ? consumedTb - upstream.reportedTb : null;

  const domainCtl = useTableControls(byDomain, {
    searchKeys: ['sourceName', 'sourceType'],
    defaultSortKey: 'frontEndBytes', defaultSortDir: 'desc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={BadgeCheck} title="Licensing" description="Veritas's own licensing meter alongside ICC's computed FETB estimate">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {data == null ? (
        <LoadingPanel label="Loading licensing data…" height={280} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid md:grid-cols-2 gap-4">
            <MeterCard title="Veritas Licensing Meter" icon={Cloud}
              pct={upstreamPct}
              consumedTb={upstream?.reportedTb || 0}
              entitledTb={upstream?.entitledTb || 0}
              sub={upstream ? `${upstream.meter || 'Alta meter'}${upstream.asOf ? ` · as of ${fmtWhen(upstream.asOf)}` : ''}` : 'From Veritas Alta'}
              empty={!upstream ? 'Awaiting live Alta connection — Veritas’s own meter will appear here.' : null} />
            <MeterCard title="ICC Computed (FETB)" icon={BadgeCheck}
              pct={computedPct}
              consumedTb={consumedTb}
              entitledTb={entitledTb}
              sub="Largest successful job per client, last 30 days" />
          </div>

          {showDelta && (
            <div className="panel p-3 text-sm text-ink-muted">
              ICC computes <span className="text-ink font-semibold tnum">{fmtTb(consumedTb * TB)}</span> vs Veritas{' '}
              <span className="text-ink font-semibold tnum">{fmtTb((upstream.reportedTb || 0) * TB)}</span> · Δ{' '}
              <span className={`font-semibold tnum ${Math.abs(delta) > (upstream.reportedTb || 0) * 0.1 ? 'text-status-warn' : 'text-ink'}`}>
                {delta >= 0 ? '+' : ''}{fmtTb(delta * TB)}
              </span>
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard icon={BadgeCheck} label="Consumed (FETB)" value={fmtTb(totals.frontEndBytes)} />
            <StatCard icon={BadgeCheck} label="Entitled" value={entitledTb > 0 ? `${entitledTb.toLocaleString()} TB` : '—'} />
            <StatCard icon={Users} label="Clients" value={fmtNum(totals.clients)} />
            <StatCard icon={Globe} label="Domains" value={fmtNum(totals.sources)} />
          </div>

          <Panel title="Consumption by Workload">
            {byWorkload.length === 0 ? (
              <div className="text-sm text-ink-muted text-center py-4">No workload breakdown yet.</div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
                {byWorkload.map((w) => (
                  <StatCard key={w.workload} icon={BadgeCheck} label={w.workload} value={fmtTb(w.frontEndBytes)} sub={`${fmtNum(w.clients)} clients`} />
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Consumption by Domain">
            {byDomain.length === 0 ? (
              <div className="text-sm text-ink-muted py-6 text-center">No per-domain data yet.</div>
            ) : (
              <>
                <TableControls ctl={domainCtl} rows={byDomain} searchPlaceholder="Filter by domain…"
                  filters={[{ k: 'sourceType', label: 'Types' }]} />
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                      <SortTh k="sourceName" label="Domain" ctl={domainCtl} />
                      <SortTh k="sourceType" label="Type" ctl={domainCtl} />
                      <SortTh k="clients" label="Clients" ctl={domainCtl} align="right" />
                      <SortTh k="frontEndBytes" label="FETB" ctl={domainCtl} align="right" />
                      <SortTh k="usagePercent" label="% of Entitlement" ctl={domainCtl} align="right" />
                    </tr></thead>
                    <tbody>
                      {domainCtl.pageRows.map((d) => {
                        const tone = d.usagePercent == null ? 'neutral' : d.usagePercent >= 90 ? 'crit' : d.usagePercent >= 75 ? 'warn' : 'ok';
                        return (
                          <tr key={d.sourceId} className="border-b border-cohesity-border/50">
                            <td className="py-2 pr-3 text-ink">{d.sourceName}</td>
                            <td className="py-2 pr-3 text-ink-muted">{d.sourceType}</td>
                            <td className="py-2 pr-3 text-right tnum text-ink">{fmtNum(d.clients)}</td>
                            <td className="py-2 pr-3 text-right tnum text-ink">{fmtTb(d.frontEndBytes)}</td>
                            <td className="py-2 pr-3 text-right"><Badge tone={tone}>{d.usagePercent != null ? `${d.usagePercent.toFixed(1)}%` : '—'}</Badge></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <TablePager ctl={domainCtl} />
              </>
            )}
          </Panel>

          {data.capturedAt && (
            <p className="text-[11px] text-ink-faint">Captured {fmtWhen(data.capturedAt)} · basis: computed-fetb</p>
          )}
        </div>
      )}
    </div>
  );
}
