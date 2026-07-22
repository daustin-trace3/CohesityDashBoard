import { useEffect, useState, useCallback } from 'react';
import { Gauge, Server, ShieldAlert, Boxes, AlertTriangle, HardDrive, Cpu, MemoryStick, Zap, BadgeCheck } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Bar, Doughnut } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, BarElement, ArcElement, Tooltip, Legend,
} from 'chart.js';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated, timeAgo } from '../../components/ui/primitives';
import { BRAND, fmtNum, fmtBytes, severityTone, asDate } from './helpers';

ChartJS.register(CategoryScale, LinearScale, BarElement, ArcElement, Tooltip, Legend);

const tickStyle = { color: '#9CA3AF', font: { size: 10 } };
const gridStyle = { color: 'rgba(255,255,255,0.06)' };

export default function DellOverviewPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

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

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Gauge} title="Dell OME Overview" description="PowerEdge fleet health, capacity and lifecycle across all registered OpenManage Enterprise instances">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {data != null && instances.length === 0 && (
        <div className="panel p-4 mb-4 text-sm text-ink-muted">
          No OME instances registered yet. Add one under{' '}
          <Link to="/ome/settings" className="text-brand hover:underline">Settings</Link>.
        </div>
      )}

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Boxes} label="OME Instances" value={instances.length ? `${instances.filter(o => o.lastPollStatus !== 'error').length} / ${instances.length}` : '—'}
          sub="reachable" tone={instances.some(o => o.lastPollStatus === 'error') ? 'crit' : 'brand'} />
        <StatCard icon={Server} label="Devices" value={fmtNum(dev.total)}
          sub={`${fmtNum(dev.powered_on)} powered on`} tone="default" />
        <StatCard icon={AlertTriangle} label="Health Alerts" value={fmtNum((dev.warning || 0) + (dev.critical || 0))}
          sub={`${fmtNum(dev.critical)} critical devices`} tone={(dev.critical || 0) > 0 ? 'crit' : (dev.warning || 0) > 0 ? 'warn' : 'ok'} />
        <StatCard icon={BadgeCheck} label="Warranty" value={fmtNum(data?.warranty?.expiring)}
          sub={`expiring ≤${data?.warranty?.warnDays ?? 90}d · ${fmtNum(data?.warranty?.expired)} expired`}
          tone={(data?.warranty?.expired || 0) > 0 ? 'crit' : (data?.warranty?.expiring || 0) > 0 ? 'warn' : 'ok'} />
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Cpu} label="CPU Capacity" value={fmtNum(cap.cores)}
          sub={`cores · ${fmtNum(cap.sockets)} sockets`} tone="default" />
        <StatCard icon={MemoryStick} label="Total Memory" value={fmtBytes(cap.memory_bytes)}
          sub="installed DIMMs" tone="default" />
        <StatCard icon={HardDrive} label="Raw Disk" value={fmtBytes(cap.disk_bytes)}
          sub={diskMedia.length ? diskMedia.map((m) => `${m.media} ${m.count}`).join(' · ') : 'per-drive inventory'} tone="default" />
        <StatCard icon={Zap} label="Power Draw" value={cap.power_w != null && cap.power_w > 0 ? `${fmtNum(Math.round(cap.power_w))} W` : '—'}
          sub={cap.power_w != null && cap.power_w > 0 ? 'instant, Power Manager' : 'needs Power Manager plugin'} tone="default" />
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
          <div className="mt-2 text-[11px] text-ink-faint">
            {fmtNum(dev.disconnected)} device(s) disconnected from OME
          </div>
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

      <div className="grid sm:grid-cols-3 gap-3">
        <StatCard icon={AlertTriangle} label="Critical Alerts (7d)" value={fmtNum(data?.alerts7d?.critical)}
          sub={`${fmtNum(data?.alerts7d?.warning)} warnings`} tone={(data?.alerts7d?.critical || 0) > 0 ? 'crit' : 'ok'} />
        <StatCard icon={HardDrive} label="Failing Components" value={fmtNum(data?.failingComponents)}
          sub="disks, DIMMs, PSUs, NICs not OK" tone={(data?.failingComponents || 0) > 0 ? 'warn' : 'ok'} />
        <StatCard icon={BadgeCheck} label="Firmware Drift" value={fmtNum(data?.firmware?.noncompliant)}
          sub={data?.firmware?.total ? `of ${fmtNum(data.firmware.total)} baseline checks` : 'no baselines defined'}
          tone={(data?.firmware?.noncompliant || 0) > 0 ? 'warn' : 'ok'} />
      </div>
    </div>
  );
}
