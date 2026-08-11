import { useEffect, useState, useCallback, useMemo } from 'react';
import { Gauge, Server, MonitorSmartphone, Database, ShieldAlert, Activity, Cpu, MemoryStick } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler,
} from 'chart.js';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtNum, fmtBytes, fmtRatio, ppmPct, usageTone, severityTone, ftTone, ftLabel } from './helpers';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

const TONES = { ok: '#6CB33F', warn: '#D4A24E', crit: '#C75D5D' };

// Compact stat tile with an inline SVG sparkline — lighter than a Chart.js
// instance per tile, matches the ops-page spark aesthetic.
function SparkTile({ icon: Icon, label, value, sub, tone = 'ok', spark }) {
  const color = TONES[tone] || TONES.ok;
  const pts = (spark || []).filter((v) => v != null);
  const w = 96; const h = 26;
  const max = Math.max(...pts, 1); const min = Math.min(...pts, 0);
  const range = max - min || 1;
  const path = pts.map((v, i) => `${(i / Math.max(pts.length - 1, 1)) * w},${h - ((v - min) / range) * (h - 2) - 1}`).join(' ');
  return (
    <div className="panel p-4 flex items-start justify-between gap-2" style={{ borderTop: `3px solid ${BRAND}` }}>
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wide text-ink-faint flex items-center gap-1.5 mb-1">
          <Icon size={12} className="text-brand" /> {label}
        </p>
        <p className="text-2xl font-bold tnum leading-none" style={{ color: tone === 'ok' ? undefined : color }}>{value}</p>
        {sub && <p className="text-[11px] text-ink-faint mt-1.5 truncate">{sub}</p>}
      </div>
      {pts.length > 1 && (
        <svg width={w} height={h} aria-hidden="true" className="flex-shrink-0 mt-1">
          <polyline points={path} fill="none" stroke={color} strokeWidth="1.5" opacity="0.85" />
        </svg>
      )}
    </div>
  );
}

export default function NxOverviewPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/nutanix/overview')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ totals: {}, clusters: [], issues: [] }); toast({ type: 'error', title: 'Failed to load Nutanix overview' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const totals = data?.totals || {};
  const clusters = data?.clusters || [];
  const issues = data?.issues || [];
  const trend = data?.trend || [];
  const prov = data?.provisioning || {};
  const storagePct = totals.storageCapacityBytes > 0 ? (totals.storageUsageBytes / totals.storageCapacityBytes) * 100 : null;
  const critCount = totals.criticalAlerts || 0;
  const warnCount = totals.warningAlerts || 0;

  const cpuPct = ppmPct(data?.utilization?.cpuPpm);
  const memPct = ppmPct(data?.utilization?.memPpm);
  const cpuRatio = prov.physicalCores > 0 ? prov.vcpus / prov.physicalCores : null;
  const memRatio = prov.physicalMemBytes > 0 ? (prov.vmemMb * 1024 * 1024) / prov.physicalMemBytes : null;
  const utilTone = (p) => (p == null ? 'ok' : p > 90 ? 'crit' : p > 80 ? 'warn' : 'ok');

  const days = trend.map((t) => t.day.slice(5));
  const chartOpts = {
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: { legend: { labels: { color: '#E5E5E5', boxWidth: 12, font: { size: 11 } } } },
    scales: {
      x: { ticks: { color: '#E5E5E5', maxTicksLimit: 10, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
      y: { ticks: { color: '#E5E5E5', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
    },
  };

  const storageTrend = useMemo(() => ({
    labels: days,
    datasets: [
      {
        label: 'Capacity', data: trend.map((t) => t.storage_capacity_bytes / 1e12),
        borderColor: '#8FA3B0', backgroundColor: 'rgba(143,163,176,0.08)',
        pointRadius: 0, borderWidth: 1.5, tension: 0.25, fill: true,
      },
      {
        label: 'Used', data: trend.map((t) => t.storage_usage_bytes / 1e12),
        borderColor: BRAND, backgroundColor: 'rgba(120,85,250,0.18)',
        pointRadius: 0, borderWidth: 2, tension: 0.25, fill: true,
      },
    ],
  }), [trend]); // eslint-disable-line react-hooks/exhaustive-deps

  const perfTrend = useMemo(() => ({
    labels: days,
    datasets: [
      {
        label: 'IOPS', data: trend.map((t) => t.controller_iops),
        borderColor: BRAND, backgroundColor: BRAND, yAxisID: 'y',
        pointRadius: 0, borderWidth: 2, tension: 0.25,
      },
      {
        label: 'Latency (ms)', data: trend.map((t) => (t.controller_latency_usecs != null ? t.controller_latency_usecs / 1000 : null)),
        borderColor: '#D4A24E', backgroundColor: '#D4A24E', yAxisID: 'y1',
        pointRadius: 0, borderWidth: 2, tension: 0.25,
      },
    ],
  }), [trend]); // eslint-disable-line react-hooks/exhaustive-deps

  const perfOpts = {
    ...chartOpts,
    scales: {
      x: chartOpts.scales.x,
      y: { ...chartOpts.scales.y, position: 'left' },
      y1: { ...chartOpts.scales.y, position: 'right', grid: { drawOnChartArea: false } },
    },
  };

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Gauge} title="Nutanix Overview" description="Prism Central and Prism Element clusters registered across the estate">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {data && totals.sources === 0 && (
        <div className="panel p-4 mb-4 border border-status-warn/40">
          <p className="text-sm text-ink">
            No Nutanix sources registered yet. Add one under{' '}
            <Link to="/nutanix/settings" className="text-brand underline">Nutanix → Settings</Link> to start polling.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
        <StatCard icon={Server} label="Sources" value={fmtNum(totals.sources)} onClick={() => navigate('/nutanix/settings')} />
        <StatCard icon={Server} label="Clusters" value={fmtNum(totals.clusters)} onClick={() => navigate('/nutanix/clusters')} />
        <StatCard icon={Server} label="Hosts" value={fmtNum(totals.hosts)} onClick={() => navigate('/nutanix/hosts')} />
        <StatCard icon={MonitorSmartphone} label="VMs" value={fmtNum(totals.vms)} onClick={() => navigate('/nutanix/vms')} />
        <StatCard icon={Database} label="Storage Used" value={storagePct != null ? `${storagePct.toFixed(1)}%` : '—'}
          sub={totals.storageCapacityBytes ? `${fmtBytes(totals.storageUsageBytes)} of ${fmtBytes(totals.storageCapacityBytes)}` : undefined}
          tone={usageTone(storagePct)} onClick={() => navigate('/nutanix/storage')} />
        <StatCard icon={ShieldAlert} label="Alerts" value={fmtNum(critCount + warnCount)}
          sub={critCount ? `${critCount} critical` : warnCount ? `${warnCount} warning` : 'all clear'}
          tone={critCount ? 'crit' : warnCount ? 'warn' : 'ok'}
          onClick={() => navigate('/nutanix/alerts')} />
      </div>

      {/* Estate utilization + provisioning band */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <SparkTile icon={Cpu} label="CPU Utilization" tone={utilTone(cpuPct)}
          value={cpuPct != null ? `${cpuPct.toFixed(1)}%` : '—'} sub="estate weighted · 30d trend"
          spark={trend.map((t) => ppmPct(t.cpu_usage_ppm))} />
        <SparkTile icon={MemoryStick} label="Memory Utilization" tone={utilTone(memPct)}
          value={memPct != null ? `${memPct.toFixed(1)}%` : '—'} sub="estate weighted · 30d trend"
          spark={trend.map((t) => ppmPct(t.memory_usage_ppm))} />
        <SparkTile icon={Cpu} label="vCPU : Core" tone={cpuRatio > 4 ? 'warn' : 'ok'}
          value={cpuRatio != null ? `${cpuRatio.toFixed(2)}:1` : '—'}
          sub={prov.physicalCores ? `${fmtNum(prov.vcpus)} vCPU on ${fmtNum(prov.physicalCores)} cores` : undefined} />
        <SparkTile icon={MemoryStick} label="vMem : Physical" tone={memRatio > 1 ? 'warn' : 'ok'}
          value={memRatio != null ? `${memRatio.toFixed(2)}:1` : '—'}
          sub={prov.physicalMemBytes ? `${fmtBytes(prov.vmemMb * 1024 * 1024)} of ${fmtBytes(prov.physicalMemBytes)}` : undefined} />
      </div>

      {/* Trend charts */}
      {trend.length > 1 && (
        <div className="grid lg:grid-cols-3 gap-4 mb-4">
          <div className="panel p-4 lg:col-span-2" style={{ borderTop: `3px solid ${BRAND}` }}>
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-semibold text-ink flex items-center gap-2"><Database size={15} className="text-brand" /> Storage — 30 Days (TB)</p>
              {data?.worstRunway && (
                <Badge tone={data.worstRunway.runway_days < 90 ? 'warn' : 'neutral'}>
                  shortest runway: {data.worstRunway.name} · {data.worstRunway.runway_days}d
                </Badge>
              )}
            </div>
            <div className="h-48"><Line data={storageTrend} options={chartOpts} /></div>
          </div>
          <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
            <p className="text-sm font-semibold text-ink mb-2 flex items-center gap-2"><Activity size={15} className="text-brand" /> IOPS / Latency — 30 Days</p>
            <div className="h-48"><Line data={perfTrend} options={perfOpts} /></div>
          </div>
        </div>
      )}

      {totals.unprotectedVms > 0 && (
        <div className="panel p-3 mb-4 border border-status-warn/40 flex items-center gap-2">
          <ShieldAlert size={14} className="text-status-warn flex-shrink-0" />
          <p className="text-sm text-ink">{fmtNum(totals.unprotectedVms)} VM(s) have no protection domain.</p>
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-4 mb-4">
        <div className="lg:col-span-2">
          <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Server size={15} className="text-brand" /> Clusters</p>
          {data == null ? (
            <LoadingPanel label="Loading clusters…" height={160} />
          ) : clusters.length === 0 ? (
            <div className="panel p-6 text-sm text-ink-muted text-center">No clusters found.</div>
          ) : (
            <div className="grid sm:grid-cols-2 gap-3">
              {clusters.map((c) => {
                const usedPct = c.storage_capacity_bytes > 0 ? (c.storage_usage_bytes / c.storage_capacity_bytes) * 100 : null;
                const barColor = usedPct > 90 ? '#C75D5D' : usedPct > 80 ? '#D4A24E' : BRAND;
                return (
                  <div key={c.id} className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-ink truncate">{c.name || c.uuid}</p>
                        <p className="text-[11px] text-ink-faint truncate">{c.source_name}{c.aos_version ? ` · AOS ${c.aos_version}` : ''}</p>
                      </div>
                      <Badge tone={ftTone(c)}>{ftLabel(c)}</Badge>
                    </div>
                    <div className="flex items-center gap-2 mb-1">
                      <div className="w-full h-1.5 rounded-full bg-surface-overlay overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${Math.min(100, usedPct || 0)}%`, backgroundColor: barColor }} />
                      </div>
                      <span className="text-xs tnum text-ink-muted whitespace-nowrap">{usedPct != null ? `${usedPct.toFixed(0)}%` : '—'}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-faint mt-2">
                      <span>{fmtNum(c.num_nodes)} node{c.num_nodes === 1 ? '' : 's'}</span>
                      <span>Reduction {fmtRatio(c.overall_reduction_ratio_ppm ?? c.reduction_ratio_ppm)}</span>
                      {c.runway_days != null && (
                        <Badge tone={c.runway_days < 90 ? 'warn' : 'neutral'}>{c.runway_days}d runway</Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><Activity size={15} className="text-brand" /> Top Issues</p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={100} />
          ) : issues.length === 0 ? (
            <div className="text-sm text-status-ok py-6 text-center">No issues detected.</div>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-[50vh] overflow-y-auto pr-1">
              {issues.map((i, idx) => (
                <div key={idx} className="flex items-start gap-2.5 bg-surface-overlay rounded-lg px-3 py-2">
                  <Badge tone={severityTone(i.severity)}>{i.severity}</Badge>
                  <div className="min-w-0">
                    <p className="text-xs text-ink leading-relaxed">{i.message}</p>
                    <p className="text-[10px] text-ink-faint">{i.source}{i.target ? ` · ${i.target}` : ''}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
