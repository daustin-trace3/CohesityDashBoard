import { useEffect, useState, useCallback } from 'react';
import { Gauge, Server, ShieldAlert, Boxes, AlertTriangle, HardDrive, Cpu, MemoryStick, Zap, BadgeCheck, Thermometer, Unplug } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Bar, Doughnut, Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, BarElement, ArcElement, PointElement, LineElement, Tooltip, Legend,
} from 'chart.js';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated, timeAgo } from '../../components/ui/primitives';
import { BRAND, fmtNum, fmtBytes, severityTone, asDate } from './helpers';

ChartJS.register(CategoryScale, LinearScale, BarElement, ArcElement, PointElement, LineElement, Tooltip, Legend);

const tickStyle = { color: '#9CA3AF', font: { size: 10 } };
const gridStyle = { color: 'rgba(255,255,255,0.06)' };

export default function DellOverviewPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  // Busiest Servers legend toggles — ranking follows whichever metrics are shown.
  const [utilShow, setUtilShow] = useState({ cpu: true, mem: true });

  const load = useCallback(() => client.get('/dell/overview')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ instances: [], devices: {}, issues: [] }); toast({ type: 'error', title: 'Failed to load OME overview' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const instances = data?.instances || [];
  const dev = data?.devices || {};
  const cap = data?.capacity || {};
  const issues = data?.issues || [];
  const models = data?.modelBreakdown || [];
  const types = data?.typeBreakdown || [];
  const diskMedia = data?.diskMedia || [];
  const util = data?.utilization;
  // Feature-gate by what the estate actually reports: base OME provides
  // per-device power/thermal (console Device > Server snapshot); CPU/memory
  // utilization additionally needs the Power Manager plugin. Hide what no
  // instance provides instead of showing "needs plugin" placeholders.
  const hasPower = (cap.power_w || 0) > 0 || (data?.powerTrend?.length || 0) > 0;
  const hasTemp = util?.temp_max != null;
  const hasUtil = util?.cpu_avg != null || (data?.topUtil || []).length > 0;
  const monCols = { 1: 'lg:grid-cols-1', 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3', 4: 'lg:grid-cols-4' }[(hasUtil ? 2 : 0) + (hasPower ? 1 : 0) + (hasTemp ? 1 : 0)] || '';
  const chartCols = { 1: '', 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3' }[1 + (hasPower ? 1 : 0) + (hasUtil ? 1 : 0)];

  const healthDonut = {
    labels: ['OK', 'Warning', 'Critical', 'Unknown'],
    datasets: [{
      data: [dev.ok || 0, dev.warning || 0, dev.critical || 0, dev.unknown || 0],
      backgroundColor: ['#6CB33F', '#D4A24E', '#C75D5D', '#5A6572'],
      borderWidth: 0,
    }],
  };

  const modelBar = {
    labels: models.map((m) => m.model),
    datasets: [{ data: models.map((m) => m.count), backgroundColor: BRAND, borderRadius: 3 }],
  };

  // Ops charts: 14d alert volume (stacked by severity), 30d power trend per
  // instance, and the ten busiest metered servers.
  const alertDays = data?.alertsByDay || [];
  const alertsBar = {
    labels: alertDays.map((d) => String(d.day).slice(5)),
    datasets: [
      { label: 'Critical', data: alertDays.map((d) => d.critical), backgroundColor: '#C75D5D', stack: 's', borderRadius: 2 },
      { label: 'Warning', data: alertDays.map((d) => d.warning), backgroundColor: '#D4A24E', stack: 's', borderRadius: 2 },
      { label: 'Info', data: alertDays.map((d) => d.info), backgroundColor: '#5A6572', stack: 's', borderRadius: 2 },
    ],
  };
  const trendRows = data?.powerTrend || [];
  const trendDays = [...new Set(trendRows.map((r) => r.day))].sort();
  const PW_COLORS = ['#007DB8', '#6CB33F', '#D4A24E', '#9B6CD4', '#4ED4B8'];
  const powerLine = {
    labels: trendDays.map((d) => String(d).slice(5)),
    datasets: [...new Set(trendRows.map((r) => r.ome_name))].map((name, i) => ({
      label: name,
      data: trendDays.map((day) => trendRows.find((r) => r.ome_name === name && r.day === day)?.power_w ?? null),
      borderColor: PW_COLORS[i % PW_COLORS.length], backgroundColor: PW_COLORS[i % PW_COLORS.length],
      borderWidth: 2, pointRadius: 0, tension: 0.3, spanGaps: true,
    })),
  };
  // Rank by the visible metric; with both shown, by the most constrained
  // resource (max of the two) so a memory-bound box isn't buried by its idle CPU.
  const utilRank = (d) => (utilShow.cpu && utilShow.mem
    ? Math.max(d.cpu_util_pct ?? 0, d.mem_util_pct ?? 0)
    : utilShow.cpu ? (d.cpu_util_pct ?? 0) : (d.mem_util_pct ?? 0));
  const topUtil = [...(data?.topUtil || [])].sort((a, b) => utilRank(b) - utilRank(a)).slice(0, 10);
  const utilBar = {
    labels: topUtil.map((d) => String(d.name || '').split('.')[0]),
    datasets: [
      { label: 'CPU %', data: topUtil.map((d) => d.cpu_util_pct), backgroundColor: '#007DB8', borderRadius: 2, hidden: !utilShow.cpu },
      { label: 'Memory %', data: topUtil.map((d) => d.mem_util_pct), backgroundColor: '#4ED4B8', borderRadius: 2, hidden: !utilShow.mem },
    ],
  };

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Gauge} title="Dell Overview" description="PowerEdge fleet health, capacity and lifecycle across all registered OpenManage Enterprise instances">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {data != null && instances.length === 0 && (
        <div className="panel p-4 mb-4 text-sm text-ink-muted">
          No OME instances registered yet. Add one under{' '}
          <Link to="/dell/settings" className="text-brand hover:underline">Settings</Link>.
        </div>
      )}

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Boxes} label="OME Instances" value={instances.length ? `${instances.filter(o => o.lastPollStatus !== 'error').length} / ${instances.length}` : '—'}
          sub="reachable" tone={instances.some(o => o.lastPollStatus === 'error') ? 'crit' : 'brand'} />
        <StatCard icon={Server} label="Devices" value={fmtNum(dev.total)}
          sub={`${fmtNum(dev.powered_on)} powered on`} tone="default" />
        <StatCard icon={AlertTriangle} label="Failing Components" value={fmtNum(data?.failingComponents)}
          sub={`across ${fmtNum((dev.warning || 0) + (dev.critical || 0))} unhealthy device(s)`}
          tone={(dev.critical || 0) > 0 ? 'crit' : (data?.failingComponents || 0) > 0 ? 'warn' : 'ok'} />
        <StatCard icon={BadgeCheck} label="Warranty" value={fmtNum(data?.warranty?.expiring)}
          sub={`expiring ≤${data?.warranty?.warnDays ?? 90}d · ${fmtNum(data?.warranty?.expired)} expired`}
          tone={(data?.warranty?.expired || 0) > 0 ? 'crit' : (data?.warranty?.expiring || 0) > 0 ? 'warn' : 'ok'} />
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
        <StatCard icon={Cpu} label="CPU Capacity" value={fmtNum(cap.cores)}
          sub={`cores · ${fmtNum(cap.sockets)} sockets`} tone="default" />
        <StatCard icon={MemoryStick} label="Total Memory" value={fmtBytes(cap.memory_bytes)}
          sub="installed DIMMs" tone="default" />
        <StatCard icon={HardDrive} label="Raw Disk" value={fmtBytes(cap.disk_bytes)}
          sub={diskMedia.length ? diskMedia.map((m) => `${m.media} ${m.count}`).join(' · ') : 'per-drive inventory'} tone="default" />
      </div>

      {(hasUtil || hasPower || hasTemp) && (
        <div className={`grid sm:grid-cols-2 ${monCols} gap-3 mb-4`}>
          {hasUtil && (
            <StatCard icon={Cpu} label="CPU Utilization" value={util?.cpu_avg != null ? `${util.cpu_avg.toFixed(0)}%` : '—'}
              sub={util?.source === 'vcenter'
                ? `fleet average via vCenter · ${fmtNum(util?.metered)} matched ESXi host(s)`
                : `fleet average · ${fmtNum(util?.metered)} metered server(s)`}
              tone={util?.cpu_avg != null && util.cpu_avg > 75 ? 'warn' : 'default'} />
          )}
          {hasUtil && (
            <StatCard icon={MemoryStick} label="Memory Utilization" value={util?.mem_avg != null ? `${util.mem_avg.toFixed(0)}%` : '—'}
              sub={util?.source === 'vcenter' ? 'fleet average via vCenter' : 'fleet average, Power Manager'}
              tone={util?.mem_avg != null && util.mem_avg > 85 ? 'warn' : 'default'} />
          )}
          {hasPower && (
            <StatCard icon={Zap} label="Power Draw" value={cap.power_w != null && cap.power_w > 0 ? `${fmtNum(Math.round(cap.power_w))} W` : '—'}
              sub="instant fleet draw" tone="default" />
          )}
          {hasTemp && (
            <StatCard icon={Thermometer} label="Thermal" value={util?.temp_max != null ? `${util.temp_max.toFixed(1)} °C` : '—'}
              sub={`hottest inlet · ${util?.temp_avg != null ? `${util.temp_avg.toFixed(1)} °C avg` : '—'}`}
              tone={util?.temp_max != null && util.temp_max > 27 ? 'warn' : 'default'} />
          )}
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-3 mb-4">
        <StatCard icon={AlertTriangle} label="Critical Alerts (7d)" value={fmtNum(data?.alerts7d?.critical)}
          sub={`${(data?.alerts7d?.critical || 0) > (data?.alerts7d?.critical_prev || 0) ? '▲' : (data?.alerts7d?.critical || 0) < (data?.alerts7d?.critical_prev || 0) ? '▼' : '—'} vs ${fmtNum(data?.alerts7d?.critical_prev)} prior week · ${fmtNum(data?.alerts7d?.warning)} warnings`}
          tone={(data?.alerts7d?.critical || 0) > 0 ? 'crit' : 'ok'} />

        <StatCard icon={Unplug} label="Disconnected" value={fmtNum(dev.disconnected)}
          sub="devices unreachable from OME" tone={(dev.disconnected || 0) > 0 ? 'crit' : 'ok'} />
      </div>

      <div className="grid lg:grid-cols-3 gap-4 mb-4">
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-3">Device Health</p>
          {data == null ? <LoadingPanel label="Loading…" height={180} /> : (
            <div className="h-[200px] flex items-center justify-center">
              <Doughnut data={healthDonut} options={{
                maintainAspectRatio: false, animation: false, cutout: '62%',
                plugins: { legend: { position: 'right', labels: { color: '#E5E5E5', boxWidth: 10, font: { size: 11 } } } },
              }} />
            </div>
          )}
        </div>

        <div className="panel p-4 lg:col-span-2" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-1">Fleet by Model</p>
          <p className="text-[11px] text-ink-faint mb-3">
            {types.map((t) => `${t.device_type}: ${t.count}`).join(' · ') || 'Device type mix appears after the first poll'}
          </p>
          {data == null ? <LoadingPanel label="Loading…" height={180} /> : models.length === 0 ? (
            <div className="text-sm text-ink-muted py-8 text-center">No devices yet.</div>
          ) : (
            <div className="h-[200px]">
              <Bar data={modelBar} options={{
                maintainAspectRatio: false, animation: false,
                plugins: { legend: { display: false } },
                scales: { x: { ticks: { ...tickStyle, maxRotation: 40, minRotation: 20 }, grid: { display: false } }, y: { ticks: tickStyle, grid: gridStyle, beginAtZero: true } },
              }} />
            </div>
          )}
        </div>
      </div>

      <div className={`grid ${chartCols} gap-4 mb-4`}>
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-1">Alert Volume (14d)</p>
          <p className="text-[11px] text-ink-faint mb-3">Daily alerts by severity — a rising red band means the estate is getting noisier.</p>
          {data == null ? <LoadingPanel label="Loading…" height={170} /> : alertDays.length === 0 ? (
            <div className="text-sm text-ink-muted py-8 text-center">No alerts in the last 14 days.</div>
          ) : (
            <div className="h-[190px]">
              <Bar data={alertsBar} options={{
                maintainAspectRatio: false, animation: false,
                plugins: { legend: { position: 'bottom', labels: { color: '#E5E5E5', boxWidth: 10, font: { size: 10 } } } },
                scales: { x: { stacked: true, ticks: tickStyle, grid: { display: false } }, y: { stacked: true, ticks: tickStyle, grid: gridStyle, beginAtZero: true } },
              }} />
            </div>
          )}
        </div>

        {hasPower && (
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-1">Power Draw Trend (30d)</p>
          <p className="text-[11px] text-ink-faint mb-3">Fleet watts per OME instance — creep here is new load or failing cooling.</p>
          {data == null ? <LoadingPanel label="Loading…" height={170} /> : powerLine.datasets.length === 0 ? (
            <div className="text-sm text-ink-muted py-8 text-center">No power history — needs the Power Manager plugin.</div>
          ) : (
            <div className="h-[190px]">
              <Line data={powerLine} options={{
                maintainAspectRatio: false, animation: false,
                plugins: { legend: { position: 'bottom', labels: { color: '#E5E5E5', boxWidth: 10, font: { size: 10 } } } },
                scales: { x: { ticks: tickStyle, grid: { display: false } }, y: { ticks: { ...tickStyle, callback: (v) => `${v} W` }, grid: gridStyle } },
              }} />
            </div>
          )}
        </div>
        )}

        {hasUtil && (
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-1">Busiest Servers</p>
          <p className="text-[11px] text-ink-faint mb-3">Top 10 by most-constrained resource — toggle a legend metric to re-rank. Rebalance or right-size candidates.</p>
          {data == null ? <LoadingPanel label="Loading…" height={170} /> : topUtil.length === 0 ? (
            <div className="text-sm text-ink-muted py-8 text-center">No utilization data — needs Power Manager or vCenter-matched ESXi hosts.</div>
          ) : (
            <div className="h-[190px]">
              <Bar data={utilBar} options={{
                indexAxis: 'y', maintainAspectRatio: false, animation: false,
                plugins: { legend: { position: 'bottom', labels: { color: '#E5E5E5', boxWidth: 10, font: { size: 10 } },
                  onClick: (e, item) => {
                    const key = item.text.startsWith('CPU') ? 'cpu' : 'mem';
                    setUtilShow((prev) => {
                      const next = { ...prev, [key]: !prev[key] };
                      return next.cpu || next.mem ? next : prev; // never hide both
                    });
                  } } },
                scales: { x: { ticks: { ...tickStyle, callback: (v) => `${v}%` }, grid: gridStyle, max: 100, beginAtZero: true }, y: { ticks: { ...tickStyle, font: { size: 9 } }, grid: { display: false } } },
              }} />
            </div>
          )}
        </div>
        )}
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mb-4">
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Boxes size={15} className="text-brand" /> OME Instances</p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={100} />
          ) : instances.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">None registered.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {instances.map(o => (
                <div key={o.id} className="flex items-center justify-between bg-surface-overlay rounded-lg px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink truncate">{o.name}</p>
                    <p className="text-[11px] text-ink-faint truncate">{o.host}{o.version ? ` · v${o.version}` : ''}</p>
                  </div>
                  <div className="flex flex-col items-end gap-0.5 shrink-0">
                    <Badge tone={o.lastPollStatus === 'error' ? 'crit' : o.lastPollStatus === 'success' ? 'ok' : 'neutral'}>
                      {o.lastPollStatus === 'error' ? 'Unreachable' : o.lastPollStatus === 'success' ? 'Up' : 'Pending'}
                    </Badge>
                    {o.lastPollAt && (
                      <span className="text-[10px] text-ink-faint whitespace-nowrap" title={asDate(o.lastPollAt).toLocaleString()}>
                        contacted {timeAgo(asDate(o.lastPollAt))}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><ShieldAlert size={15} className="text-brand" /> Issues</p>
          <p className="text-[11px] text-ink-faint mb-3">
            Unreachable instances, unhealthy devices, failing components, warranties within {data?.warranty?.warnDays ?? 90} days of expiry.
          </p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={100} />
          ) : issues.length === 0 ? (
            <div className="text-sm text-status-ok py-6 text-center">No issues detected.</div>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-[300px] overflow-y-auto pr-1">
              {issues.slice(0, 60).map((i, idx) => (
                <button key={idx} onClick={() => navigate('/dell/hardware')}
                  className="flex items-start gap-2 text-left bg-surface-overlay rounded-lg px-3 py-2 hover:bg-surface-overlay/70 cursor-pointer">
                  <Badge tone={severityTone(i.severity)}>{i.severity}</Badge>
                  <span className="text-xs text-ink-muted leading-relaxed min-w-0">{i.message}<span className="text-ink-faint"> · {i.ome}</span></span>
                </button>
              ))}
              {issues.length > 60 && <p className="text-[11px] text-ink-faint text-center">…and {issues.length - 60} more</p>}
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
